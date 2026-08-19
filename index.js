// MCP substrate for mikser-io. The mcp plugin exposes
// `runtime.options.mcp` (a substrate object) at factory time so other
// plugins can register tools / resources / prompts against it at their
// onLoaded hook with the same shape as the SDK's McpServer.
//
// Operating model:
//   - One shared mikser engine, many observing clients.
//   - Per-session McpServer + per-session transport (required by the
//     SDK: a single Server instance can't be initialized twice).
//     The substrate maintains a registry of tool/resource/prompt
//     declarations and replays them onto every new session's server,
//     so plugins register ONCE.
//   - Broadcast logging: every connected client gets every log line.
//     Client-side filtering is honored via the SDK's per-session
//     `logging/setLevel` state.
//
// MCP ships as a plugin (not in core) so its release cadence can move
// at the pace of the MCP spec / SDKs / host clients without dragging
// engine releases. See mikser-io's ADR-0006 for the rule (test #5,
// release-cadence) that put it here.
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { minimatch } from 'minimatch'
import { z } from 'zod'
import {
    runtime,
    refExists,
    mimeForEntity,
    readEntityContent,
    useRenderer,
    useCollection,
    queryEntities,
    readEntity,
    registerRoute,
    resolveAuth,
    authorize,
    reachabilityOf,
} from 'mikser-io'
import packageInfo from 'mikser-io/package.json' with { type: 'json' }
import previewPlugin from './preview.js'

// Pattern matcher for endpoint tools/resources filters. Accepts
// '*', an array of patterns, or undefined (= allow all). Glob
// patterns like 'mikser_refs_*' or 'mikser_*_entity' work through
// minimatch — same library mikser uses for content matching, so
// the syntax is consistent across the codebase.
function matchesAny(name, patterns) {
    if (patterns == null) return true
    if (patterns === '*') return true
    if (!Array.isArray(patterns)) return false
    for (const p of patterns) {
        if (p === '*') return true
        if (minimatch(name, p)) return true
    }
    return false
}

let pinoLevelToMcp = (pinoLevel) => {
    if (pinoLevel >= 50) return 'error'
    if (pinoLevel >= 40) return 'warning'
    if (pinoLevel >= 30) return 'info'
    if (pinoLevel >= 20) return 'debug'
    return 'debug'
}

/**
 * Build the MCP substrate. The returned object exposes the same
 * registerTool / registerResource / registerPrompt shape as
 * @modelcontextprotocol/sdk's McpServer, so plugins use it as a
 * drop-in. Internally it records each registration and replays them
 * on every new per-session Server.
 */
export function createMcpSubstrate() {
    // Recorded registrations, replayed on each new session server so
    // late-arriving clients see the same tool surface as early ones.
    const registrations = { tools: [], resources: [], prompts: [] }
    // Per-session McpServer instances currently connected to a
    // transport. Used to fan log notifications and list-changed
    // events out to every active client.
    const activeServers = new Set()
    // Rolling buffer of recent log lines, surfaced via the
    // mikser://logs/recent resource. Sized to cover one or two
    // typical lifecycle cycles — large enough to debug a render
    // failure that scrolled off the live stream, small enough that
    // keeping it in memory isn't a concern. Tail-truncated; oldest
    // line drops when the cap is exceeded.
    const LOG_BUFFER_CAP = 500
    const logBuffer = []

    function bind(server, filters = {}) {
        const { allowedTools, allowedResources, allowedPrompts } = filters
        const bound = { tools: 0, resources: 0, prompts: 0 }
        for (const args of registrations.tools) {
            if (!matchesAny(args[0], allowedTools)) continue
            server.registerTool(...args)
            bound.tools++
        }
        for (const args of registrations.resources) {
            // Resource registrations are (name, uri, config, handler).
            // Filter on the URI since that's the addressable identifier
            // (`mikser://lifecycle` reads more naturally as the filter
            // target than the short `mikser-lifecycle` name).
            const uri = typeof args[1] === 'string' ? args[1] : args[0]
            if (!matchesAny(uri, allowedResources)) continue
            server.registerResource(...args)
            bound.resources++
        }
        for (const args of registrations.prompts) {
            if (!matchesAny(args[0], allowedPrompts)) continue
            server.registerPrompt(...args)
            bound.prompts++
        }
        return bound
    }

    const substrate = {
        // The SDK's register* methods take different argument counts
        // (3 for tools, 4 for resources, 3 for prompts). We spread the
        // recorded args verbatim — substrate doesn't peek at the
        // shape, it just records and replays.
        registerTool(...args) {
            registrations.tools.push(args)
            const name = args[0]
            let replayed = 0
            const replayErrors = []
            for (const s of activeServers) {
                try { s.registerTool(...args); replayed++ }
                catch (err) { replayErrors.push(err.message) }
            }
            const log = runtime.engine?.logger
            if (log) {
                log.debug('MCP substrate: registered tool %s (total=%d, live-replayed=%d/%d)',
                    name, registrations.tools.length, replayed, activeServers.size)
                for (const msg of replayErrors) {
                    log.debug('MCP substrate: live-replay of tool %s failed on a session server: %s', name, msg)
                }
            }
            return substrate
        },
        registerResource(...args) {
            registrations.resources.push(args)
            const uri = typeof args[1] === 'string' ? args[1] : args[0]
            let replayed = 0
            const replayErrors = []
            for (const s of activeServers) {
                try { s.registerResource(...args); replayed++ }
                catch (err) { replayErrors.push(err.message) }
            }
            const log = runtime.engine?.logger
            if (log) {
                log.debug('MCP substrate: registered resource %s (total=%d, live-replayed=%d/%d)',
                    uri, registrations.resources.length, replayed, activeServers.size)
                for (const msg of replayErrors) {
                    log.debug('MCP substrate: live-replay of resource %s failed on a session server: %s', uri, msg)
                }
            }
            return substrate
        },
        registerPrompt(...args) {
            registrations.prompts.push(args)
            const name = args[0]
            let replayed = 0
            const replayErrors = []
            for (const s of activeServers) {
                try { s.registerPrompt(...args); replayed++ }
                catch (err) { replayErrors.push(err.message) }
            }
            const log = runtime.engine?.logger
            if (log) {
                log.debug('MCP substrate: registered prompt %s (total=%d, live-replayed=%d/%d)',
                    name, registrations.prompts.length, replayed, activeServers.size)
                for (const msg of replayErrors) {
                    log.debug('MCP substrate: live-replay of prompt %s failed on a session server: %s', name, msg)
                }
            }
            return substrate
        },

        // Convenience helper for the common case: 3-arg tool with
        // description and input schema.
        simpleTool(name, description, inputSchema, handler) {
            return substrate.registerTool(name, { description, inputSchema }, handler)
        },

        // Create a fresh McpServer pre-loaded with every recorded
        // registration that passes the endpoint's filters. Called by
        // the transport mount per new session.
        //
        // Filters take patterns (exact name or glob via minimatch):
        //   allowedTools:     ['mikser_refs_*', 'mikser_ping']
        //   allowedResources: ['mikser://lifecycle', 'mikser://logs/*']
        // Omit a filter (or pass '*') to allow everything in that
        // category — that's the backward-compat default.
        createServer({ allowedTools, allowedResources, allowedPrompts } = {}) {
            const server = new McpServer(
                { name: 'mikser-io', version: packageInfo.version },
                { capabilities: { tools: {}, resources: {}, logging: {} } },
            )
            const bound = bind(server, { allowedTools, allowedResources, allowedPrompts })
            runtime.engine?.logger?.debug(
                'MCP session server created (tools=%d/%d, resources=%d/%d, prompts=%d/%d)',
                bound.tools, registrations.tools.length,
                bound.resources, registrations.resources.length,
                bound.prompts, registrations.prompts.length,
            )
            return server
        },
        attach(server) {
            activeServers.add(server)
            runtime.engine?.logger?.debug(
                'MCP session attached — active clients: %d', activeServers.size)
        },
        detach(server) {
            activeServers.delete(server)
            runtime.engine?.logger?.debug(
                'MCP session detached — active clients: %d', activeServers.size)
        },
        activeServerCount() { return activeServers.size },

        // Send a logging-message notification to every connected
        // client. The SDK's per-session level filtering applies.
        broadcastLog(params) {
            for (const s of activeServers) {
                try {
                    // sendLoggingMessage is async; fire-and-forget so
                    // one slow client can't stall the rest. Errors
                    // are swallowed — log loss on a side channel is
                    // less important than not killing engine logs.
                    s.sendLoggingMessage(params).catch(() => {})
                } catch { /* swallow */ }
            }
        },

        // Called by wireLoggerToMcp on every log call. Records a
        // monotonic seq number so clients can poll "give me lines
        // since seq=N" against mikser://logs/recent.
        recordLogLine(line) {
            logBuffer.push({
                seq: (logBuffer.length === 0 ? 1 : logBuffer[logBuffer.length - 1].seq + 1),
                t: runtime.engine?.now ? runtime.engine.now() : null,
                ...line,
            })
            // Tail-truncate so memory stays bounded.
            if (logBuffer.length > LOG_BUFFER_CAP) {
                logBuffer.splice(0, logBuffer.length - LOG_BUFFER_CAP)
            }
        },
        recentLogLines(limit = LOG_BUFFER_CAP) {
            const n = Math.min(LOG_BUFFER_CAP, Math.max(1, limit))
            return logBuffer.slice(-n)
        },
    }

    // Built-in introspection resources. Read-only views into the
    // running engine — let an AI ask "what's the current phase?",
    // "what config is loaded?", "what just happened?" without
    // needing a custom tool.
    //
    // The SDK's registerResource signature is:
    //   registerResource(name, uriOrTemplate, metadata, handler)
    // Static resources pass a URI string; the handler returns
    // { contents: [{ uri, mimeType, text }] }.

    substrate.registerResource(
        'mikser-lifecycle',
        'mikser://lifecycle',
        {
            title: 'Current lifecycle phase',
            description: 'The phase the engine is currently executing. Null when between phases.',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    phase: runtime.phase ?? null,
                    started: runtime.started === true,
                    stamp: runtime.stamp,
                    processTime: runtime.processTime ?? null,
                }, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-runtime',
        'mikser://runtime',
        {
            title: 'Engine runtime options',
            description: 'Resolved runtime.options — working folder, output folder, server port, plugin list, etc. Excludes the live engine handles (logger, queue, workers).',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    options: runtime.options,
                    started: runtime.started === true,
                    phase: runtime.phase ?? null,
                }, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-config',
        'mikser://config',
        {
            title: 'Effective mikser config',
            description: 'The merged config object as plugins see it (runtime.config). Includes per-plugin keys.',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(runtime.config, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-logs-recent',
        'mikser://logs/recent',
        {
            title: 'Recent engine log lines',
            description: `Rolling buffer of the most recent log lines (up to ${LOG_BUFFER_CAP}). Useful for debugging a render or postprocess failure that scrolled past the live notifications stream.`,
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ lines: substrate.recentLogLines() }, null, 2),
            }],
        }),
    )

    // mikser://server — single-shot answer to "where do I put output
    // so the user can see it?" Combines server state (running? on what
    // URL?) and the path conventions agents should write to for
    // preview-style outputs.
    substrate.registerResource(
        'mikser-server',
        'mikser://server',
        {
            title: 'HTTP server location and preview conventions',
            description: 'Where the running engine is reachable (URL, MCP path, preview path prefix) and what folder it serves. The single resource an agent needs to answer "where can the user see this output?"',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(serverInfo(), null, 2),
            }],
        }),
    )

    // Built-in liveness/identity tool. Also ensures tools/list works
    // before any plugin has registered (McpServer only advertises
    // tools/list capability after at least one registration).
    substrate.registerTool(
        'mikser_ping',
        {
            description: 'Return mikser engine identity, current lifecycle phase, and (if --server is on) where the HTTP server is reachable. Use to confirm the connection is live before issuing other tool calls and to learn the base URL for preview outputs.',
            inputSchema: {},
        },
        async () => ({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    name: 'mikser-io',
                    version: packageInfo.version,
                    started: runtime.started === true,
                    phase: runtime.phase ?? null,
                    workingFolder: runtime.options.workingFolder,
                    outputFolder: runtime.options.outputFolder,
                    activeClients: substrate.activeServerCount(),
                    server: serverInfo(),
                }, null, 2),
            }],
        }),
    )

    return substrate
}

// Derive a stable snapshot of "where outputs are visible to the user."
// Three cases:
//   1. --server is on  → engine owns Express, knows port → full URL
//   2. external app    → caller supplied runtime.options.app; URL not
//                        visible to engine (port unknown), but the
//                        outputFolder and path conventions are still
//                        useful for preview-writing tools
//   3. no server       → only the static folder layout applies; an
//                        agent should not try to advertise a URL
//
// Kept as a function rather than a const so each call re-reads
// runtime.options — covers the case where --server flips on after
// the substrate was created (rare but possible programmatically).
function serverInfo() {
    const opts = runtime.options
    const hasInternalServer = opts.server != null && opts.port != null
    const hasExternalApp = opts.app && !hasInternalServer

    // Prefer runtime.options.url (the engine-resolved public URL — CLI
    // --url or config.url) so the URL surfaced to MCP clients is
    // externally reachable. Falls back to localhost:port for dev /
    // private setups where no public URL was configured.
    const base = opts.url
        ?? (hasInternalServer ? `http://localhost:${opts.port}` : null)

    return {
        running: hasInternalServer ? 'internal' : (hasExternalApp ? 'external' : 'none'),
        port: opts.port ?? null,
        url: base,
        serves: opts.outputFolder ?? null,
        mcpPath: opts.mcpPath ?? null,
        mcpUrl: base && opts.mcpPath ? `${base}${opts.mcpPath}` : null,
        // Preview URLs are returned directly by mikser_preview_render
        // (preview plugin), so we don't advertise a path convention here —
        // doing so would be a lie when the preview plugin isn't loaded.
    }
}

/**
 * Mount the MCP substrate on an Express app. Two modes:
 *
 *   1. Single endpoint (backward compat): no `runtime.config.mcp.endpoints`
 *      → mounts one open endpoint at `defaultPath` (default `/mcp`) with
 *      all tools, all resources, no token. Matches the v7.0-7.6 shape.
 *
 *   2. Multiple endpoints: with `runtime.config.mcp.endpoints` set →
 *      each endpoint mounts at `<mcp.base>/<name>` (default base `/mcp`)
 *      with its own filters (`tools`, `resources`) and optional
 *      `token` for Bearer auth.
 *
 * Each endpoint is its own session map — sessions don't cross endpoints.
 * Same noun and shape as the api plugin's `endpoints` config.
 */
export async function mountMcpOnExpress(app, substrate, defaultPath = '/mcp') {
    const endpoints = runtime.config.mcp?.endpoints
    const base = runtime.config.mcp?.base ?? defaultPath

    runtime.engine?.logger?.debug(
        'MCP mounting on Express (base=%s, endpoints=%d)',
        base, endpoints ? Object.keys(endpoints).length : 1)

    if (endpoints && Object.keys(endpoints).length > 0) {
        for (const [name, ep] of Object.entries(endpoints)) {
            mountEndpoint(app, substrate, `${base}/${name}`, ep, name)
        }
    } else {
        // Backward-compat single endpoint. With no `mcp.endpoints`
        // configured, mount one open + loopback-only endpoint — same
        // safe default as a per-endpoint config with no token. The
        // boot log line itself (from mountEndpoint) shows the state;
        // no extra warning needed because the default IS the safe one.
        mountEndpoint(app, substrate, defaultPath, {}, null)
    }
}

const PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource'

// RFC 9728 §3 forms a resource's metadata URL by INSERTING the well-known
// segment between host and path — https://h/mcp/admin becomes
// https://h/.well-known/oauth-protected-resource/mcp/admin. That matters
// here in a way it doesn't for a single-endpoint server: mikser mounts one
// MCP endpoint per `mcp.endpoints` entry, and they can carry different
// verifiers, so they cannot all answer at one bare well-known path.
function metadataPath(path) {
    return PROTECTED_RESOURCE + (path === '/' ? '' : path)
}

// Endpoints that have already claimed the bare well-known path, so a second
// OAuth-gated endpoint doesn't silently overwrite the first one's metadata.
const claimedRoot = new Set()

// Guard the one RFC 9728 field a client refuses to accept when it's wrong.
//
// `resource` identifies THIS endpoint. The client fetches the metadata and
// checks it really describes the server it connected to — otherwise any
// resource could hand clients an authorization server of its choosing — so
// a mismatch aborts the login before the user ever sees a page.
//
// The trap: a token AUDIENCE looks like the same kind of value and is not.
// `resource` names this endpoint; an audience names who a token is for.
// Passing the audience here produces an MCP endpoint no compliant client
// can authenticate against, with nothing wrong in mikser's own logs.
//
// The origin isn't knowable at mount time (it's per-request) but the PATH
// is, and that's enough to catch the confusion. Warn and fall back rather
// than throw: MCP is one surface, and the fallback is the correct value.
function checkResource(declared, path) {
    if (!declared) return null
    const norm = (s) => s.replace(/\/+$/, '') || '/'
    let pathname
    try {
        pathname = new URL(declared).pathname
    } catch {
        runtime.engine?.logger?.warn(
            'MCP: ignoring auth.resource %j — not an absolute URL. Advertising the request origin + %s instead.',
            declared, path)
        return null
    }
    if (norm(pathname) === norm(path)) return declared
    runtime.engine?.logger?.warn(
        'MCP: ignoring auth.resource %j — it points at %j, not this endpoint (%j). RFC 9728 ' +
        '`resource` must identify the MCP endpoint itself; a client compares it with the URL it ' +
        'connected to and aborts authentication when they differ. Advertising the request origin ' +
        '+ %s instead. If you meant the token audience, that is a different value — pass it to ' +
        'the verifier, not here.',
        declared, pathname, path, path)
    return null
}

// OAuth 2.0 Protected Resource Metadata. Mounted only when the verifier
// advertises an authorization server — a static token has nothing to
// discover. Deliberately ungated: a client reads this BEFORE it has a
// credential, so requiring one would be a locked door with the key inside.
function mountProtectedResourceMetadata(app, path, verifier) {
    if (!verifier?.authorizationServers?.length) return

    // Checked once at mount, not per request: a bad value makes the endpoint
    // unauthenticatable, so it belongs in the boot log rather than in some
    // client's error message hours later.
    const declaredResource = checkResource(verifier.resource, path)

    const document = (req, res) => {
        const origin = `${req.protocol}://${req.get('host')}`
        res.json({
            resource:                 declaredResource || `${origin}${path}`,
            authorization_servers:    verifier.authorizationServers,
            bearer_methods_supported: ['header'],
            scopes_supported:         verifier.scopesSupported || [],
        })
    }

    app.get(metadataPath(path), document)
    // Also answer at the bare path for clients that probe it directly
    // instead of following the challenge — first OAuth endpoint wins.
    if (!claimedRoot.has(app)) {
        claimedRoot.add(app)
        app.get(PROTECTED_RESOURCE, document)
    }

    runtime.engine?.logger?.info(
        'MCP OAuth discovery at %s (AS: %s)',
        metadataPath(path), verifier.authorizationServers.join(', '))
}

// The 401 body tells a client it was refused; this header tells it what to
// do about it. Without resource_metadata an OAuth-gated endpoint gives a
// client no way to find the issuer.
function challenge(req, res, verifier, path) {
    if (verifier?.authorizationServers?.length) {
        const origin = `${req.protocol}://${req.get('host')}`
        res.set('WWW-Authenticate',
            `Bearer resource_metadata="${origin}${metadataPath(path)}"`)
        return
    }
    if (verifier?.challenge) return verifier.challenge(req, res)
    if (verifier) res.set('WWW-Authenticate', 'Bearer')
}

function mountEndpoint(app, substrate, path, ep, endpointName) {
    const transports = new Map()

    // ADR-0012: `auth` is a verifier (mikser-io-auth's oauth()/jwt(), or any
    // { verify } object); `token` is the static-secret shorthand. Both land
    // on the same seam, so everything below is credential-agnostic.
    //
    // They differ in ONE respect, deliberately: a plain `token` keeps
    // mikser's documented "trusted local host" model — localhost reaches a
    // token-gated endpoint without the token, because the token is there to
    // keep the internet out, not the developer running the build. A real
    // verifier does not get that bypass: if you went to the trouble of
    // wiring OAuth onto an MCP endpoint, an unauthenticated loopback caller
    // (another process on a shared box, an SSRF hop) is exactly the thing
    // you were buying protection from. Same posture as WhiteBox.
    const verifier      = resolveAuth(ep.auth ?? ep.token)
    const trustLoopback = !ep.auth && !!ep.token

    mountProtectedResourceMetadata(app, path, verifier)

    async function handle(req, res, body) {
        // The uniform rule now lives in the engine (mikser-io/src/auth.js).
        // Only the DENIAL SHAPE is ours: MCP speaks JSON-RPC, so a bare
        // { error } body would be unreadable to a client that is mid-
        // handshake. That is the whole reason authorize() is exposed as a
        // primitive alongside requireAuth()'s Express middleware.
        let outcome
        try {
            outcome = await authorize(req, verifier, { allowRemote: ep.allowRemote, trustLoopback })
        } catch (err) {
            runtime.engine?.logger?.error(
                'MCP auth verifier threw at %s: %s', path, err.message)
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Authentication failed' },
                id: null,
            })
            return
        }

        if (!outcome.ok) {
            runtime.engine?.logger?.debug(
                'MCP auth denied at %s: %s (ip=%s)', path, outcome.reason, req.ip)
            // RFC 9728 §5.1: a 401 from a protected resource points the
            // client at its metadata, which is how an MCP client discovers
            // WHERE to log in. Without this an OAuth-gated endpoint is just
            // a closed door — the client has no way to find the issuer.
            if (outcome.status === 401) challenge(req, res, verifier, path)
            res.status(outcome.status).json({
                jsonrpc: '2.0',
                error: { code: -32001, message: outcome.error },
                id: null,
            })
            return
        }
        req.principal = outcome.principal

        const sessionId = req.headers['mcp-session-id']
        if (sessionId && transports.has(sessionId)) {
            return transports.get(sessionId).handleRequest(req, res, body)
        }

        // New session — server filtered for this endpoint's surface.
        runtime.engine?.logger?.debug(
            'MCP new session at %s (ip=%s, method=%s)', path, req.ip, req.method)
        const server = substrate.createServer({
            allowedTools:     ep.tools,
            allowedResources: ep.resources,
            allowedPrompts:   ep.prompts,
        })
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                transports.set(id, transport)
                substrate.attach(server)
            },
        })
        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
            substrate.detach(server)
        }
        await server.connect(transport)
        return transport.handleRequest(req, res, body)
    }

    app.post(path, (req, res) => handle(req, res, req.body))
    app.get(path,  (req, res) => handle(req, res))
    app.delete(path, (req, res) => handle(req, res))

    const toolsLabel = ep.tools == null || ep.tools === '*'
        ? '*'
        : Array.isArray(ep.tools) ? ep.tools.join(',') : String(ep.tools)
    // Reachability → registry enum + the louder bracket. 'public' means
    // a deliberate unauthenticated exposure (allowRemote), so keep the
    // REMOTE OPEN warning in the log. streaming:true — the MCP
    // Streamable HTTP transport sends SSE frames server→client, so a
    // facade must not buffer this route.
    const reachability = reachabilityOf(ep)
    const authLabel = ep.auth
        ? (verifier?.name ?? 'auth')
        : ep.token
            ? 'token'
            : (ep.allowRemote ? 'public, REMOTE OPEN' : 'loopback-only')
    registerRoute({
        path,
        plugin:       'mcp',
        reachability,
        streaming:    true,
        label:        endpointName ? 'MCP endpoint' : 'MCP',
        detail:       endpointName ? `(tools=[${toolsLabel}])` : undefined,
        authLabel,
    })
}

/**
 * Wrap a pino logger so every call also broadcasts a
 * `notifications/message` to MCP clients AND appends to the
 * substrate's rolling buffer (read via mikser://logs/recent).
 * Wraps in place: returns the same logger reference, with
 * `fatal/error/warn/info/debug/trace` replaced by versions that
 * call the original AND fan out via the substrate.
 *
 * Wrapping (vs. swapping in a pino multistream) lets us keep the
 * existing logger reference that the rest of the engine, plugins,
 * and render workers already hold — no second logger to thread
 * through, no race during initialization.
 */
export function wireLoggerToMcp(logger, substrate) {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']
    for (const level of levels) {
        const original = logger[level]?.bind(logger)
        if (!original) continue
        logger[level] = (...args) => {
            original(...args)
            try {
                const data = extractData(args)
                const mcpLevel = pinoLevelToMcp(pinoLevelNumber(level))
                substrate.recordLogLine?.({ level: mcpLevel, data })
                substrate.broadcastLog({
                    level: mcpLevel,
                    logger: 'mikser',
                    data,
                })
            } catch { /* swallow — keep stdout pipeline working */ }
        }
    }
    // No wire-up confirmation here — the wrapper has a load-bearing
    // 1-broadcast-per-log-call invariant and a "skip missing methods"
    // invariant. Operators still see the substrate's debug coverage
    // (registrations, session lifecycle, auth deny) once the engine
    // logger flows through. The "MCP mounted: …" info line at boot
    // is the user-visible "ready" signal.
    return logger
}

// Reduce pino-style call args to a single { msg, ...fields } payload
// for the MCP notification's `data` field. Mirrors pino's own argument
// handling: leading object = fields, trailing string = msg template,
// remaining args = printf params.
function extractData(args) {
    if (args.length === 0) return { msg: '' }
    const [first, ...rest] = args
    if (typeof first === 'object' && first !== null) {
        const template = typeof rest[0] === 'string' ? rest[0] : ''
        const params = rest.slice(1)
        const msg = template ? format(template, params) : (rest[0] !== undefined ? String(rest[0]) : '')
        return { ...first, msg }
    }
    return { msg: format(String(first), rest) }
}

// %s / %d / %j formatting, matching pino's printf-style behavior.
function format(template, args) {
    if (typeof template !== 'string') return String(template)
    let i = 0
    return template.replace(/%[sdjoO]/g, (token) => {
        if (i >= args.length) return token
        const a = args[i++]
        if (token === '%s') return String(a)
        if (token === '%d') return Number(a).toString()
        return typeof a === 'object' ? JSON.stringify(a) : String(a)
    })
}

function pinoLevelNumber(name) {
    return { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[name] ?? 30
}

// Plugin entry. Loaded by mikser when 'mcp' appears in mikser.config.js
// plugins array. Activation is by presence — no CLI flag.
//
// The factory creates the substrate SYNCHRONOUSLY so other plugins
// listed AFTER 'mcp' in the array can register tools/resources at
// their own onLoaded hook with `if (!runtime.options.mcp) return`
// gating already in place from the in-core era. The plugin MUST be
// FIRST in the user's plugins array — that's a documented invariant
// in this repo's README.
//
// Configuration via mikser.config.js:
//   plugins: ['mcp', ...],
//   mcp: {
//     path: '/mcp',                  // default; mount path for the transport
//     endpoints: { ... }             // same shape as the previous mcp.endpoints
//   }
//
// Presence in the plugins array IS the activation signal. The `mcp`
// config block is for tuning (path, endpoints, renderTimeout). When
// absent, defaults apply. For conditional activation, toggle the
// plugins array — `...(process.env.MCP ? ['mcp'] : [])` — same shape
// other plugins use.
export function mcp(options = {}) {
    return (core) => {
    // Use the runtime singleton imported above for substrate-internal
    // code paths (createMcpSubstrate etc. reference it directly via
    // closure). The factory arg `core.runtime` is the same object;
    // they're both mikser-io's exported runtime singleton.
    const { onLoaded, useLogger } = core

    // Mirror plugin options into runtime.config.mcp so non-plugin
    // helpers (mountMcpOnExpress and friends, called by embedders that
    // wire MCP up directly without `plugins:`) keep finding their
    // config there. Plugin-side reads use `options.X` and never touch
    // runtime.config.mcp.
    runtime.config.mcp = options

    // Contribute MCP transport headers to engine's CORS arrays so
    // browser-side MCP clients (basic-host, mcp-ui, etc.) can read
    // mcp-session-id from initialize responses and send it back on
    // follow-up requests. Idempotent — guards against double-load.
    if (runtime.options.corsAllowHeaders) {
        const add = (arr, items) => items.forEach(h => arr.includes(h) || arr.push(h))
        add(runtime.options.corsAllowHeaders, ['mcp-session-id', 'mcp-protocol-version', 'last-event-id'])
        add(runtime.options.corsExposeHeaders, ['mcp-session-id', 'mcp-protocol-version'])
    }

    // Create substrate synchronously. Other plugins' factories /
    // onLoaded hooks check `if (!runtime.options.mcp) return` before
    // calling `mcp.simpleTool(...)` — so the substrate has to be on
    // runtime.options.mcp by the time those run. The mcp plugin MUST
    // be FIRST in the user's plugins array for that contract to hold.
    runtime.options.mcp = createMcpSubstrate()
    runtime.options.mcpPath = options.path ?? '/mcp'

    // Compose the MCP-UI surface in the same package — shell
    // resource, mikser_preview_ui, mikser_ui_action, mikser_preview_render,
    // forwardToHandler, the mcp-ui/modes discovery resource.
    // Pass the full core args through so previewPlugin gets
    // findEntity / findEntities too.
    previewPlugin(core)

    onLoaded(async () => {
        const logger = useLogger()

        // Wire the engine's pino logger to broadcast MCP notifications
        // for every log call. Wraps in-place so the existing logger
        // reference (held by plugins, render workers, useLogger
        // consumers) gains the side-channel automatically.
        if (runtime.engine?.logger) {
            wireLoggerToMcp(runtime.engine.logger, runtime.options.mcp)
            logger.debug('MCP logger wiring active')
        }

        // Mount HTTP transport when an Express app is available.
        // Without --server (no app) the substrate still works for
        // embedders calling registerTool / broadcastLog directly.
        if (runtime.options.app && runtime.options.mcpPath) {
            await mountMcpOnExpress(
                runtime.options.app,
                runtime.options.mcp,
                runtime.options.mcpPath,
            )
        }
    })

    // mikser_refs_* tool surface. Pure transport over runtime.refs — the
    // engine owns the inverse-reference index (mikser-io/src/refs.js);
    // this just wraps four queries and one resource in the MCP shape.
    // runtime.refs is created in refs.js's onInitialized hook (runs
    // before any onLoaded), so the surface is guaranteed present here.
    // Guarded anyway: if the engine boots without refs the registrations
    // are silently skipped.
    onLoaded(() => {
        const logger = useLogger()
        const mcp = runtime.options.mcp
        if (!runtime.refs) {
            logger.debug('mikser_refs_* tools skipped: runtime.refs not initialized')
            return
        }

        const ok = (data) => ({
            content: [{
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            }],
        })
        const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] })

        mcp.simpleTool(
            'mikser_refs_inbound',
            'List entities that reference the given href. Returns every (entity id, field path) pair pointing at this target. Use for "what would break if I delete this?" or "show me everything that mentions /authors/dick." The query is exact-match against the canonical ref value as written in source $-keys.',
            {
                ref: z.string().describe('Reference value to look up. Match is exact on the source-file form (e.g. "/authors/dick"). Hrefs, not catalog ids.'),
            },
            async ({ ref }) => {
                try {
                    if (!ref) return fail('ref is required')
                    const entries = runtime.refs.inboundFor(ref)
                    return ok({ ref, count: entries.length, entries })
                } catch (err) {
                    logger.error('MCP mikser_refs_inbound error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_refs_outbound',
            'List the references emitted by the given entity. Returns every $-keyed field on the entity and the ref string it carries. Use for "what does this entity link to?" or "show me the relationship graph rooted at /blog/launch.md."',
            {
                id: z.string().describe('Catalog id of the source entity (e.g. "/documents/blog/launch.md").'),
            },
            async ({ id }) => {
                try {
                    if (!id) return fail('id is required')
                    const entries = runtime.refs.outboundFor(id)
                    return ok({ id, count: entries.length, entries })
                } catch (err) {
                    logger.error('MCP mikser_refs_outbound error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_refs_broken',
            'List all references that do not currently resolve to an entity. Walks every ref in the inverse index and tests each via the catalog. Use for build-time health checks, editor "broken links" panels, or CI gates.',
            {},
            async () => {
                try {
                    const broken = []
                    for (const ref of runtime.refs.allRefs()) {
                        const exists = await refExists(ref)
                        if (!exists) {
                            broken.push({ ref, sources: runtime.refs.inboundFor(ref) })
                        }
                    }
                    return ok({ count: broken.length, broken })
                } catch (err) {
                    logger.error('MCP mikser_refs_broken error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_refs_rename',
            'Rewrite every reference to `from` so it points at `to`. Walks the inverse index for `from`, opens each referencing source file, and rewrites the `$`-keyed value via writeEntity. The watcher picks up each rewrite and the catalog re-syncs on the next cycle. Returns the list of (entity id, fields) pairs that were updated. Idempotent — calling twice with the same args is a no-op on the second call because the first call drained the inbound list.',
            {
                from: z.string().describe('Old reference value as written in source files (e.g. "/authors/dick").'),
                to:   z.string().describe('New reference value to write in its place (e.g. "/authors/dick-marinov").'),
            },
            async ({ from, to }) => {
                try {
                    const result = await runtime.refs.rename({ from, to })
                    return ok(result)
                } catch (err) {
                    logger.error('MCP mikser_refs_rename error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        try {
            mcp.registerResource(
                'mikser-refs-index',
                'mikser://refs/index',
                {
                    title: 'Reverse-reference index',
                    description: 'Read-only snapshot of the engine\'s inverse-reference index. Lists every reference in the catalog and the entities that emit it.',
                    mimeType: 'application/json',
                },
                async (uri) => ({
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            stats: runtime.refs.size(),
                            refs: runtime.refs.allRefs().map(ref => ({
                                ref,
                                sources: runtime.refs.inboundFor(ref),
                            })),
                        }, null, 2),
                    }],
                }),
            )
        } catch (err) {
            logger.debug('mikser://refs/index registration skipped: %s', err.message)
        }

        logger.debug('MCP tools registered: mikser_refs_{inbound,outbound,broken,rename} (mcp plugin)')
    })

    // mikser_layouts_inspect moved out — registered by mikser-io-layouts
    // directly against `runtime.options.mcp`, same pattern vector and
    // schemas use. Domain-owned tools live with the domain plugin; mcp
    // is registry + transport, not a tool catalog.

    // Catalog + render tool surface. Five tools wrapping the engine's
    // catalog operations (queryEntities / readEntity from
    // mikser-io/src/catalog.js, useCollection.write/.remove for the
    // mutating pair) and a render tool backed by an mcp-owned renderer
    // instance.
    //
    // Catalog ops are direct mikser-io imports — no plugin-surface
    // dependency, no presence check. The catalog is created during
    // onInitialized (lifecycle phase before any onLoaded), so by the
    // time this hook fires it's always ready.
    //
    // Render gets its own renderer here with `runtime.config.mcp.renderTimeout`
    // (or 30s default) — independent of `runtime.config.api.renderTimeout`
    // which governs HTTP endpoint behavior. MCP request lifecycles and
    // HTTP request lifecycles can want different timeouts.
    //
    onLoaded(() => {
        const logger = useLogger()
        const mcp = runtime.options.mcp

        const { render: mcpRender } = useRenderer(runtime, {
            defaultTimeout: options.renderTimeout ?? 30_000,
        })

        const ok = (data) => ({
            content: [{
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            }],
        })
        const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] })

        mcp.simpleTool(
            'mikser_query_entities',
            'Query entities from mikser\'s catalog with optional filter / sort / projection. Use this for "show me all documents about X" or "what entities are in collection Y." Returns paginated results. Pass `expand` to inline referenced entities (per ADR-0007): paths like "author", "author.organization", or "sections.*.image" walk through $-keyed reference fields and replace the ref string with the resolved entity in one round-trip.',
            {
                filter: z.record(z.any()).optional().describe('Mongo-style filter (sift-compatible). Defaults to no filter — every entity.'),
                sort:   z.record(z.number()).optional().describe('Sort spec, e.g. { "meta.date": -1, "name": 1 }.'),
                fields: z.array(z.string()).optional().describe('Dotted-path projection. Omit to return whole entities.'),
                skip:   z.number().int().min(0).optional().describe('Skip N items.'),
                limit:  z.number().int().min(1).max(100).optional().describe('Page size, defaults to 25, capped at 100.'),
                expand: z.array(z.string()).optional().describe('Inline-expand referenced entities. Each entry is a dotted path that walks through $-keyed reference fields, replacing the ref string with the resolved entity. Use `*` for array iteration. Examples: ["author"], ["author.organization"], ["sections.*.image"]. Default caps: maxDepth 5, maxPaths 20, maxResolved 100 per request.'),
            },
            async ({ filter, sort, fields, skip, limit, expand }) => {
                try {
                    return ok(await queryEntities({ filter, sort, fields, skip, limit, expand }))
                } catch (err) {
                    logger.error('MCP mikser_query_entities error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_read_entity',
            'Read a single entity by its catalog id (e.g. "/documents/about.md"). Returns the full entity record or null when not found. Pass include: ["content"] to also fetch the source file content from disk — useful for reading a layout template, document frontmatter+body, or any text-format source without dropping out to the filesystem. Binary formats (png/pdf/mp4/etc.) get a `contentSkipped` hint pointing at mikser_render instead of decoded bytes. Pass `expand` to inline referenced entities in the response (per ADR-0007): paths like "author", "author.organization", or "sections.*.image" replace the ref string with the resolved entity in one trip.',
            {
                id: z.string().describe('Catalog id of the entity to read.'),
                include: z.array(z.enum(['content'])).optional().describe('Optional list of extra fields to populate. Currently only "content" is supported: reads the file at entity.uri as utf8 and attaches it as .content. Binary formats get `contentSkipped` instead of garbage utf8.'),
                expand: z.array(z.string()).optional().describe('Inline-expand referenced entities. Each entry is a dotted path through $-keyed reference fields. Use `*` for array iteration. Examples: ["author"], ["author.organization"], ["sections.*.image"]. Same caps as mikser_query_entities.'),
            },
            async ({ id, include, expand }) => {
                try {
                    const entity = await readEntity({ id, expand })
                    if (entity && include?.includes('content')) {
                        // readEntityContent gates on text-extension and
                        // attaches one of { content, contentError,
                        // contentSkipped } — single source of truth on
                        // what "load this entity's content" means,
                        // shared across any consumer that wants the
                        // text/binary gate.
                        Object.assign(entity, await readEntityContent(entity))
                    }
                    return ok(entity)
                } catch (err) {
                    logger.error('MCP mikser_read_entity error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_update_entity',
            'Create or update a content file inside a mikser collection. The file is written to disk and the next lifecycle cycle picks it up. Use this to author new documents, layouts, or other content from AI.',
            {
                collection:   z.string().describe('Collection name (e.g. "documents", "layouts").'),
                relativePath: z.string().describe('Path relative to the collection folder (e.g. "blog/2026-06-02-launch.md").'),
                content:      z.string().optional().describe('File content to write. Frontmatter is parsed by the corresponding plugin.'),
            },
            async ({ collection, relativePath, content = '' }) => {
                try {
                    await useCollection(runtime, collection).write(relativePath, content)
                    return ok({ ok: true, collection, relativePath })
                } catch (err) {
                    logger.error('MCP mikser_update_entity error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_delete_entity',
            'Remove a content file from a mikser collection. Deletes the source file; the next lifecycle cycle prunes its rendered outputs from the manifest.',
            {
                collection:   z.string().describe('Collection name.'),
                relativePath: z.string().describe('Path relative to the collection folder.'),
            },
            async ({ collection, relativePath }) => {
                try {
                    await useCollection(runtime, collection).remove(relativePath)
                    return ok({ ok: true, collection, relativePath })
                } catch (err) {
                    logger.error('MCP mikser_delete_entity error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_render',
            'Render a transient entity through the engine pipeline (parse → layouts → resources → render → postprocess) and return the FINAL produced bytes. Use this for "preview this layout against this data" without writing the entity to disk. The returned bytes are the pipeline\'s final output — PDF for a `*.html-pdf.*` layout, MJML-derived HTML for `*.html-mjml.*`, etc. Set options.save=false to skip the disk write; options.catalog=false to prune the catalog row after rendering. For a clickable preview URL instead of raw bytes, use mikser_preview_render (preview plugin).',
            {
                entity:  z.record(z.any()).describe('Entity shape with at least { id, collection } and any meta/content the renderer needs.'),
                options: z.record(z.any()).optional().describe('Renderer options: { save: false, catalog: false, renderer: "...", postprocessor: "..." }.'),
            },
            async ({ entity = {}, options = {} }) => {
                try {
                    const { output, entity: rendered } = await mcpRender(entity, options)
                    const result = output?.result
                    if (result == null) {
                        return ok({ ok: true, entity: rendered, output: null })
                    }
                    const mime = mimeForEntity(rendered) ?? 'application/octet-stream'
                    if (Buffer.isBuffer(result)) {
                        return {
                            content: [{
                                type: 'resource',
                                resource: {
                                    uri: `mikser://render/${rendered.id ?? 'inline'}`,
                                    mimeType: mime,
                                    blob: result.toString('base64'),
                                },
                            }],
                        }
                    }
                    // String result — most renderers (HTML, MJML, etc.).
                    return {
                        content: [{
                            type: 'resource',
                            resource: {
                                uri: `mikser://render/${rendered.id ?? 'inline'}`,
                                mimeType: mime,
                                text: String(result),
                            },
                        }],
                    }
                } catch (err) {
                    logger.error('MCP mikser_render error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        logger.debug('MCP tools registered: mikser_{query_entities,read_entity,update_entity,delete_entity,render} (mcp plugin)')
    })

    return { name: 'mcp' }
    }
}
