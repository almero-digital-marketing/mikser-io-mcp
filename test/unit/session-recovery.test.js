import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { runtime } from 'mikser-io'
import { mountMcpOnExpress } from '../../index.js'

// Sessions live in the endpoint's own Map, so a restart empties it while every
// connected client keeps the id it was handed. What the server does with that
// unknown id decides whether the client reconnects by itself or is stranded:
// 404 tells it to re-initialize with the token it still holds, anything else
// reads as a broken server.
//
// Same fakes as endpoint-auth.test.js — a substrate whose createServer()
// throws is a sentinel for "the request reached the new-session branch",
// which here is the thing that must NOT happen for a stale id.
function fakeApp() {
    const routes = { get: new Map(), post: new Map(), delete: new Map() }
    return {
        routes,
        get:    (p, h) => routes.get.set(p, h),
        post:   (p, h) => routes.post.set(p, h),
        delete: (p, h) => routes.delete.set(p, h),
    }
}

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

function fakeReq({ sessionId, body = {}, method = 'POST' } = {}) {
    return {
        method,
        ip: '127.0.0.1',          // loopback, so an open endpoint needs no token
        protocol: 'https',
        headers: sessionId ? { 'mcp-session-id': sessionId } : {},
        get: (k) => (k.toLowerCase() === 'host' ? 'mikser.test' : undefined),
        body,
    }
}

async function call(app, path, req, verb = 'post') {
    const res = fakeRes()
    try {
        await app.routes[verb].get(path)(req, res)
    } catch (err) {
        if (err.message === REACHED) return { openedSession: true, res }
        throw err
    }
    return { openedSession: false, res }
}

async function mount() {
    const app = fakeApp()
    runtime.config = { ...runtime.config, mcp: { base: '/mcp', endpoints: { open: {} } } }
    await mountMcpOnExpress(app, substrate)
    return app
}

beforeEach(() => { runtime.config = {} })

describe('MCP session recovery after a restart', () => {
    it('404s a session id the process does not hold', async () => {
        const app = await mount()
        const { openedSession, res } = await call(app, '/mcp/open',
            fakeReq({ sessionId: 'from-before-the-restart', body: { method: 'tools/list' } }))

        // Not 200-with-a-confusing-error, and above all not a silent new
        // session: the client has to be able to tell that THIS id is dead.
        assert.equal(openedSession, false)
        assert.equal(res.statusCode, 404)
        assert.equal(res.body.jsonrpc, '2.0')
        assert.equal(res.body.error.code, -32001)
    })

    it('lets an initialize through even when it carries a stale id', async () => {
        const app = await mount()
        const { openedSession } = await call(app, '/mcp/open',
            fakeReq({ sessionId: 'from-before-the-restart', body: { method: 'initialize' } }))

        // initialize opens a session whatever id came with it. Refusing it
        // would strand a client that resends its stored id out of habit — it
        // would 404 forever and never get to make a new session.
        assert.equal(openedSession, true)
    })

    it('treats a batch containing initialize as an initialize', async () => {
        const app = await mount()
        const { openedSession } = await call(app, '/mcp/open',
            fakeReq({ sessionId: 'stale', body: [{ method: 'notifications/x' }, { method: 'initialize' }] }))
        assert.equal(openedSession, true)
    })

    it('still opens a session when no id is sent at all', async () => {
        const app = await mount()
        const { openedSession } = await call(app, '/mcp/open',
            fakeReq({ body: { method: 'initialize' } }))

        // The case the 404 must not swallow: no id means first contact, which
        // is the opposite of an unknown id, and the two were once conflated.
        assert.equal(openedSession, true)
    })

    it('404s a stale GET, which is how an SSE stream reattaches', async () => {
        const app = await mount()
        const { openedSession, res } = await call(app, '/mcp/open',
            fakeReq({ sessionId: 'stale', method: 'GET', body: undefined }), 'get')
        assert.equal(openedSession, false)
        assert.equal(res.statusCode, 404)
    })

    it('404s a stale DELETE rather than opening a session to close', async () => {
        const app = await mount()
        const { openedSession, res } = await call(app, '/mcp/open',
            fakeReq({ sessionId: 'stale', method: 'DELETE', body: undefined }), 'delete')
        assert.equal(openedSession, false)
        assert.equal(res.statusCode, 404)
    })
})
