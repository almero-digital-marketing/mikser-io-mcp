import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { runtime } from 'mikser-io'
import { mountMcpOnExpress } from '../../index.js'

// A fake Express app that just records what got mounted, so the auth
// decision can be driven directly without a real server or transport.
function fakeApp() {
    const routes = { get: new Map(), post: new Map(), delete: new Map() }
    return {
        routes,
        get:    (p, h) => routes.get.set(p, h),
        post:   (p, h) => routes.post.set(p, h),
        delete: (p, h) => routes.delete.set(p, h),
    }
}

// Auth runs before anything MCP-specific, so a substrate that explodes on
// createServer() gives us a sentinel: "threw REACHED" means the request got
// past the gate, which is exactly what we want to assert without dragging a
// real transport into a unit test.
const REACHED = 'REACHED'
const substrate = { createServer() { throw new Error(REACHED) }, attach() {}, detach() {} }

function fakeRes() {
    const res = { headers: {}, statusCode: null, body: null }
    res.set    = (k, v) => { res.headers[k] = v; return res }
    res.status = (s) => { res.statusCode = s; return res }
    res.json   = (b) => { res.body = b; return res }
    res.get    = (k) => (k.toLowerCase() === 'host' ? 'mikser.test' : undefined)
    return res
}

function fakeReq({ token, ip = '203.0.113.9' } = {}) {
    return {
        method:   'POST',
        ip,
        protocol: 'https',
        headers:  token ? { authorization: `Bearer ${token}` } : {},
        get:      (k) => (k.toLowerCase() === 'host' ? 'mikser.test' : undefined),
        body:     {},
    }
}

// Drive one POST through the mounted endpoint. Returns 'allowed' when the
// request cleared auth, or the denial response.
async function call(app, path, req) {
    const res = fakeRes()
    try {
        await app.routes.post.get(path)(req, res)
    } catch (err) {
        if (err.message === REACHED) return { allowed: true, res }
        throw err
    }
    return { allowed: false, res }
}

async function mount(endpoints) {
    const app = fakeApp()
    runtime.config = { ...runtime.config, mcp: { base: '/mcp', endpoints } }
    await mountMcpOnExpress(app, substrate)
    return app
}

beforeEach(() => { runtime.config = {} })

describe('MCP endpoint auth — no credential configured', () => {
    it('accepts loopback', async () => {
        const app = await mount({ open: {} })
        const { allowed } = await call(app, '/mcp/open', fakeReq({ ip: '127.0.0.1' }))
        assert.equal(allowed, true)
    })

    it('403s a remote caller, in JSON-RPC shape, with no challenge', async () => {
        const app = await mount({ open: {} })
        const { allowed, res } = await call(app, '/mcp/open', fakeReq())
        assert.equal(allowed, false)
        assert.equal(res.statusCode, 403)
        assert.equal(res.body.jsonrpc, '2.0')
        assert.equal(res.body.error.code, -32001)
        // 403 means the ORIGIN was wrong, not the credential — offering a
        // challenge would invite a client to retry with a token that can't help.
        assert.equal(res.headers['WWW-Authenticate'], undefined)
    })

    it('allowRemote opens it to anyone', async () => {
        const app = await mount({ open: { allowRemote: true } })
        const { allowed } = await call(app, '/mcp/open', fakeReq())
        assert.equal(allowed, true)
    })
})

describe('MCP endpoint auth — static token', () => {
    it('accepts the token from anywhere', async () => {
        const app = await mount({ admin: { token: 's3cret' } })
        const { allowed } = await call(app, '/mcp/admin', fakeReq({ token: 's3cret' }))
        assert.equal(allowed, true)
    })

    it('401s a wrong token and challenges', async () => {
        const app = await mount({ admin: { token: 's3cret' } })
        const { allowed, res } = await call(app, '/mcp/admin', fakeReq({ token: 'nope' }))
        assert.equal(allowed, false)
        assert.equal(res.statusCode, 401)
        assert.equal(res.headers['WWW-Authenticate'], 'Bearer')
    })

    it('401s a wrong token even from loopback', async () => {
        const app = await mount({ admin: { token: 's3cret' } })
        const { res } = await call(app, '/mcp/admin', fakeReq({ token: 'nope', ip: '127.0.0.1' }))
        assert.equal(res.statusCode, 401)
    })

    it('keeps the trusted-local-host model: loopback reaches it without the token', async () => {
        const app = await mount({ admin: { token: 's3cret' } })
        const { allowed } = await call(app, '/mcp/admin', fakeReq({ ip: '127.0.0.1' }))
        assert.equal(allowed, true)
    })
})

describe('MCP endpoint auth — a real verifier (ADR-0012)', () => {
    const oauthish = (extra = {}) => ({
        name: 'oauth',
        async verify(req) {
            const h = req.headers.authorization
            if (!h) return null
            return h === 'Bearer good' ? { subject: 'alice', capabilities: ['mcp:use'] } : false
        },
        ...extra,
    })

    it('accepts a valid token and attaches the principal', async () => {
        const app = await mount({ secure: { auth: oauthish() } })
        const req = fakeReq({ token: 'good' })
        const { allowed } = await call(app, '/mcp/secure', req)
        assert.equal(allowed, true)
        assert.equal(req.principal.subject, 'alice')
    })

    it('does NOT give loopback a bypass — the whole point of wiring OAuth', async () => {
        const app = await mount({ secure: { auth: oauthish() } })
        const { allowed, res } = await call(app, '/mcp/secure', fakeReq({ ip: '127.0.0.1' }))
        assert.equal(allowed, false)
        assert.equal(res.statusCode, 401)
    })

    it('500s rather than failing open when the verifier throws', async () => {
        const boom = { name: 'boom', async verify() { throw new Error('jwks unreachable') } }
        const app = await mount({ secure: { auth: boom } })
        const { allowed, res } = await call(app, '/mcp/secure', fakeReq({ token: 'x' }))
        assert.equal(allowed, false)
        assert.equal(res.statusCode, 500)
    })
})

describe('MCP OAuth discovery (RFC 9728)', () => {
    const withAs = (resource) => ({
        name: 'oauth',
        async verify() { return null },
        authorizationServers: ['https://id.example.com'],
        scopesSupported: ['mcp:use'],
        ...(resource ? { resource } : {}),
    })

    it('mounts metadata at the path-suffixed well-known URL, and at the bare one', async () => {
        const app = await mount({ secure: { auth: withAs() } })
        assert.ok(app.routes.get.has('/.well-known/oauth-protected-resource/mcp/secure'))
        assert.ok(app.routes.get.has('/.well-known/oauth-protected-resource'))
    })

    it('is not mounted for a static token — there is nothing to discover', async () => {
        const app = await mount({ admin: { token: 's3cret' } })
        // The endpoint's own GET is mounted; no well-known route is.
        const wellKnown = [...app.routes.get.keys()].filter(p => p.includes('.well-known'))
        assert.deepEqual(wellKnown, [])
    })

    it('advertises the endpoint as the resource, plus the AS and scopes', async () => {
        const app = await mount({ secure: { auth: withAs() } })
        const res = fakeRes()
        app.routes.get.get('/.well-known/oauth-protected-resource/mcp/secure')(fakeReq(), res)
        assert.deepEqual(res.body, {
            resource:                 'https://mikser.test/mcp/secure',
            authorization_servers:    ['https://id.example.com'],
            bearer_methods_supported: ['header'],
            scopes_supported:         ['mcp:use'],
        })
    })

    it('honours an explicit resource that matches the endpoint path', async () => {
        const app = await mount({ secure: { auth: withAs('https://public.example.com/mcp/secure') } })
        const res = fakeRes()
        app.routes.get.get('/.well-known/oauth-protected-resource/mcp/secure')(fakeReq(), res)
        assert.equal(res.body.resource, 'https://public.example.com/mcp/secure')
    })

    it('ignores a resource pointing elsewhere — the audience-vs-resource trap', async () => {
        // Passing the token AUDIENCE here is the natural mistake, and it
        // produces an endpoint no compliant client can authenticate against.
        const app = await mount({ secure: { auth: withAs('https://mikser/api') } })
        const res = fakeRes()
        app.routes.get.get('/.well-known/oauth-protected-resource/mcp/secure')(fakeReq(), res)
        assert.equal(res.body.resource, 'https://mikser.test/mcp/secure')
    })

    it('401s with a resource_metadata challenge so a client can find the issuer', async () => {
        const app = await mount({ secure: { auth: withAs() } })
        const { res } = await call(app, '/mcp/secure', fakeReq())
        assert.equal(res.statusCode, 401)
        assert.equal(
            res.headers['WWW-Authenticate'],
            'Bearer resource_metadata="https://mikser.test/.well-known/oauth-protected-resource/mcp/secure"',
        )
    })
})
