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
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    findEntities,
    readEntity,
    registerRoute,
    resolveAuth,
    authorize,
    reachabilityOf,
    explain,
    buildReport,
    requestReport,
    nextCycleId,
    whenCycleCompletes,
    cycleHistory,
    checksum as fileChecksumOf,
    resolveOutputPath,
    isTextEntity,
    useProvenance,
    sourcesBehind,
    sourcesOf,
    registerTool as coreRegisterTool,
    toolNames as coreToolNames,
    toolSchema as coreToolSchema,
    invokeTool as coreInvokeTool,
} from 'mikser-io'
import { readFile as readFileAsync, stat as statAsync, readdir as readdirAsync } from 'node:fs/promises'
import packageInfo from 'mikser-io/package.json' with { type: 'json' }
import previewPlugin from './preview.js'

// The mikser mark, offered two ways.
//
// MCP's Implementation carries `icons`, and a client with none falls back to
// a letter avatar cut from whatever the user happened to name the connector.
//
// `icons` is a LIST, and the two entries are not redundant. Some clients
// refuse `data:` URIs for images outright — a content-security policy that
// permits remote images and blocks inline ones is ordinary — and those need
// an https URL. Others run somewhere the public internet is not reachable,
// and for them the inline copy is the only one that renders. Listing the URL
// first states the preference; the data URI means the answer is never
// nothing.
//
// The URL points at the canonical artwork in the mikser-io repo rather than
// at this deployment: an icon `src` has to resolve for the CLIENT, which is
// generally nowhere near the server, and serving it locally would need
// runtime.options.url — optional, and unset on most private installs.
const ICON_SVG = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'icon.svg'), 'utf8')
const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`
const ICON_URL = 'https://raw.githubusercontent.com/almero-digital-marketing/mikser-io/main/mikser-mark.svg'

// What this server calls itself in the initialize response. Exported so it
// can be asserted on without reaching into the SDK's private state — the
// values are ours; that they survive the SDK is what the live check covers.
export function serverImplementation() {
    return {
        name:    'mikser-io',
        // `name` is the programmatic identifier; `title` is what a UI shows.
        // Without it a client displays 'mikser-io'.
        title:   'Mikser',
        version: packageInfo.version,
        icons: [
            { src: ICON_URL,      mimeType: 'image/svg+xml', sizes: ['any'] },
            { src: ICON_DATA_URI, mimeType: 'image/svg+xml', sizes: ['any'] },
        ],
        websiteUrl: 'https://github.com/almero-digital-marketing/mikser-io',
    }
}

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
// The prefix boundary. `mikser_` is MCP's namespacing, not the engine's, so it
// is stripped when a registration crosses into the engine and re-added when a
// tool crosses out into a session.
const bareName = (name) => String(name).replace(/^mikser_/, '')
const mcpName  = (name) => (String(name).startsWith('mikser_') ? String(name) : `mikser_${name}`)

// Convert the engine's neutral schema vocabulary to zod.
//
// The engine registers its own diagnostics (mikser_explain, mikser_verify,
// mikser_build_report) so they exist without this plugin. It declares their
// inputs as `{ name: { type, required?, description? } }` rather than as zod,
// because the registry is transport agnostic and the engine should not take a
// dependency on one transport's schema library.
//
// Converting here is the cost of that, and it is small on purpose: the
// vocabulary covers string / number / boolean / array and nothing else. A tool
// wanting more expressive validation registers through this substrate with real
// zod, which is what every tool in this file does.
export function zodShapeFrom(inputSchema = {}) {
    const shape = {}
    for (const [name, spec] of Object.entries(inputSchema)) {
        const type = spec?.type ?? 'string'
        let field = type === 'number' ? z.number()
            : type === 'boolean' ? z.boolean()
            : type === 'array' ? z.array(z.string())
            : z.string()
        // optional() WRAPS, so a description applied before it sits on the
        // inner type and the wrapper reports none — which is how every
        // optional parameter would have reached a client undocumented.
        if (!spec?.required) field = field.optional()
        if (spec?.description) field = field.describe(spec.description)
        shape[name] = field
    }
    return shape
}

// Accept the engine's neutral schema vocabulary here too.
//
// A plugin registering an MCP-ONLY tool — one that means nothing on a CLI,
// where the caller already has the filesystem — should not have to take a
// dependency on zod to describe a single optional string. So a schema that
// looks neutral is converted, and a real zod shape passes through untouched.
//
// Detected by behaviour rather than by a flag: a zod type has safeParse, a
// neutral spec is a plain object carrying `type`.
function normalizeInputSchema(inputSchema) {
    if (!inputSchema || typeof inputSchema !== 'object') return inputSchema
    const values = Object.values(inputSchema)
    if (!values.length) return inputSchema
    const neutral = values.every(v =>
        v && typeof v === 'object' && typeof v.safeParse !== 'function' && typeof v.type === 'string')
    return neutral ? zodShapeFrom(inputSchema) : inputSchema
}

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
        const ownNames = new Set(registrations.tools.map(([name]) => name))
        for (const args of registrations.tools) {
            if (!matchesAny(args[0], allowedTools)) continue
            server.registerTool(...args)
            bound.tools++
        }
        // Tools registered directly against the ENGINE — its own diagnostics,
        // and anything a plugin registers without going through here. Without
        // this the mirroring is one-way: everything registered here reaches the
        // CLI, but nothing registered there reaches a session, so the engine's
        // own diagnostics would be missing from the surface built for agents.
        const ownBare = new Set([...ownNames].map(bareName))
        for (const name of coreToolNames()) {
            if (ownBare.has(bareName(name))) continue
            // Prefixed on the way out, because THIS is the namespace that is
            // flat and shared. The engine stores `explain`; a session sees
            // `mikser_explain`, indistinguishable from a tool registered here.
            const exposed = mcpName(name)
            if (!matchesAny(exposed, allowedTools)) continue
            const schema = coreToolSchema(name)
            if (!schema) continue
            try {
                server.registerTool(
                    exposed,
                    { description: schema.description, inputSchema: zodShapeFrom(schema.inputSchema) },
                    (args) => coreInvokeTool(name, args),
                )
                bound.tools++
            } catch (err) {
                runtime.engine?.logger?.debug(
                    'Engine tool %s not bound to this session: %s', name, err.message)
            }
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
            // `mcpOnly` keeps a tool OFF the engine's registry, and therefore
            // off the CLI. Some tools only mean something to a remote client:
            // a WebDAV mount config is noise to a caller that is already on
            // the machine with the folders in front of it. Stripped before
            // replay so it never reaches the SDK as an unknown definition key.
            const mcpOnly = args[1]?.mcpOnly === true
            if (args[1] && (mcpOnly || args[1].inputSchema)) {
                const { mcpOnly: _drop, ...def } = args[1]
                args = [args[0], { ...def, inputSchema: normalizeInputSchema(def.inputSchema) }, args[2]]
            }
            registrations.tools.push(args)
            const name = args[0]
            // Also into the ENGINE's registry, which is what the CLI reads —
            // under the BARE name. The `mikser_` prefix is this protocol's:
            // MCP tool names share one flat namespace across every connected
            // server, so an unprefixed `search` would collide with anyone
            // else's. The engine has no such problem, and on the CLI the
            // prefix is stutter. Stripped here, re-added at bind().
            //
            // One store would be tidier, but the substrate replays raw
            // registration argument arrays onto each new session server and
            // that shape is MCP's, not the engine's. Mirroring the three
            // fields the engine cares about keeps both surfaces exact without
            // pushing MCP's vocabulary into core.
            try {
                if (!mcpOnly) coreRegisterTool(bareName(name), args[1] ?? {}, args[2])
            } catch (err) {
                runtime.engine?.logger?.debug('Tool %s not mirrored to the engine registry: %s', name, err.message)
            }
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
            return substrate.registerTool(name, { description, inputSchema: normalizeInputSchema(inputSchema) }, handler)
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
                serverImplementation(),
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

        // Who is calling, for a tool registered by another plugin.
        //
        // Tool handlers run inside the request's auth context, but that store
        // is private to this module and a plugin must not import another
        // plugin's source. So the substrate — the composition seam plugins
        // already use to register tools — hands out the principal.
        //
        // The PRINCIPAL, deliberately, not the credential. Identity and
        // capabilities are what a tool needs to tailor an answer; handing out
        // the raw bearer would make every registered tool a place the token
        // can leak from, to save a caller substituting a string it already
        // holds.
        principal() {
            const principal = authContext.getStore()?.principal
            if (!principal) return null
            return {
                subject: principal.subject ?? null,
                capabilities: principal.capabilities ?? null,
                expiresAt: principal.claims?.exp ? new Date(principal.claims.exp * 1000).toISOString() : null,
                secondsRemaining: principal.claims?.exp
                    ? Math.max(0, Math.round(principal.claims.exp - Date.now() / 1000))
                    : null,
            }
        },

        // The registered tools, and a way to call one without a transport.
        //
        // There are two agent workflows against mikser, not one: an agent
        // speaking MCP over HTTP, and an agent running the CLI and reading its
        // output. The second had no access to any of this — every tool built
        // here was reachable only through a session — which meant the two
        // workflows saw different engines.
        //
        // Exposing the registry rather than hand-rolling a CLI flag per tool
        // is what makes the parity hold: a tool registered by any plugin, now
        // or later, is reachable from both surfaces the moment it exists, and
        // there is no second list to keep in step.
        toolNames() { return coreToolNames() },
        toolSchema(name) { return coreToolSchema(name) },
        async invokeTool(name, args = {}) { return coreInvokeTool(name, args) },

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
                    // Whether this connection is authenticated and for how
                    // much longer, so a long task can be sequenced rather
                    // than discovering the answer mid-write.
                    auth: authStatus(),
                }, null, 2),
            }],
        }),
    )

    return substrate
}





// The authenticated principal, reachable from inside a tool handler.
//
// The MCP SDK calls a handler with the tool's ARGUMENTS — there is no
// request object — so a per-request fact like "who is calling and until
// when" has no other way through. Wrapping the request in an ALS keeps it
// available without threading it into every tool signature, and without
// stashing it on a session map that would then have to be reaped.
const authContext = new AsyncLocalStorage()

// The principal store, for tests that need to drive a call as a credential
// about to expire. Exported rather than reached through a mock because the
// guard reads the REAL store, and a mock would test the mock.
export function authContextForTests() { return authContext }

// What mikser_ping can say about the caller's credential.
//
// A JWT carries `exp`; a static bearer token has no expiry to report and
// says so rather than implying an unlimited one. Getting this wrong in
// either direction is expensive: a long task sequenced against a token that
// dies mid-write, or a caller pausing to re-auth when it never had to.
function authStatus() {
    const principal = authContext.getStore()?.principal
    if (!principal) {
        return { authenticated: false, note: 'No credential on this request — loopback or an unauthenticated endpoint.' }
    }
    const exp = principal.claims?.exp
    if (!exp) {
        return {
            authenticated: true,
            subject: principal.subject ?? null,
            capabilities: principal.capabilities ?? null,
            expiresAt: null,
            note: 'This credential carries no expiry (a static token). It stays valid until it is revoked or the config changes.',
        }
    }
    const expiresAt = exp * 1000
    const secondsRemaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
    const capabilities = principal.capabilities ?? null
    return {
        authenticated: true,
        subject: principal.subject ?? null,
        capabilities,
        expiresAt: new Date(expiresAt).toISOString(),
        secondsRemaining,
        // What the caller should DO, which depends on whether unattended
        // renewal is actually available to it.
        //
        // `renewable` is reported rather than assumed: the authorization server
        // grants offline_access alongside every refresh token, but only a
        // client that kept one can act on it, and this side cannot see that. A
        // client holding a refresh token renews and never reaches the cliff; a
        // client that did not keep one still needs a human, and telling it
        // otherwise would be worse than the old warning.
        renewable: capabilities?.includes?.('offline_access') ?? null,
        note: secondsRemaining < 300
            ? 'Expires in under five minutes. If you hold a refresh token, exchange it now — the '
              + 'server grants offline_access with every one it issues. Otherwise finish or '
              + 're-authenticate before starting anything long.'
            : 'Renew by exchanging your refresh token at any point; the window does not slide on '
              + 'its own, so a long task should renew rather than race the deadline.',
    }
}

// Refuse a mutating call that would land on the wrong side of expiry.
//
// The failure this prevents is specific and was reported from a real session:
// a token that died between a finished decision and the write that would have
// applied it. A 401 at the gate is fine — nothing happened. A 401 PART WAY
// THROUGH is not, because the caller cannot tell what landed.
//
// So a write checks the remaining window against how long it might take before
// touching anything. `await: true` blocks for a whole build cycle, which is why
// it asks for a larger margin than a bare write does.
//
// Returns an error envelope to return, or null to proceed.
function refuseIfExpiringWithin(seconds, what) {
    const status = authStatus()
    // No expiry to run out (a static token or a loopback call) — nothing to
    // guard against, and refusing would break every unauthenticated setup.
    if (!status.authenticated || status.secondsRemaining === undefined) return null
    if (status.secondsRemaining > seconds) return null
    return {
        isError: true,
        content: [{
            type: 'text',
            text: JSON.stringify({
                ok: false,
                refused: 'credential-expiring',
                secondsRemaining: status.secondsRemaining,
                expiresAt: status.expiresAt,
                needed: seconds,
                what,
                hint: 'Refused BEFORE writing anything, so nothing is half-applied. Renew the '
                    + 'credential and retry — the authorization server grants offline_access with '
                    + 'every refresh token, so a client holding one can renew without a human.',
            }, null, 2),
        }],
    }
}

// Output extensions worth returning as text. Deliberately a small allowlist
// rather than a binary sniff: guessing wrong on a font or an image and
// returning a utf8 read of it produces convincing garbage.
const TEXT_OUTPUT_EXTENSIONS = new Set([
    'html', 'htm', 'xml', 'json', 'txt', 'css', 'js', 'mjs', 'svg', 'md',
    'csv', 'yml', 'yaml', 'rss', 'atom', 'webmanifest', 'map',
])

// Every leaf value under meta as [dottedPath, value], arrays included.
// Same shape refs_inbound reports, so a hit here and a referrer there name
// the same field.
function* flattenMeta(node, prefix = '') {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) yield* flattenMeta(node[i], `${prefix}[${i}]`)
        return
    }
    if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            yield* flattenMeta(value, prefix ? `${prefix}.${key}` : key)
        }
        return
    }
    yield [prefix, node]
}

// How many times the needle appears. A count, not a boolean, because "this
// class is on nine pages" and "this class is on nine pages and seven times on
// one of them" are different facts and the second one names the component.
function countMatches(text, query, regex, ignoreCase) {
    if (regex) {
        const re = new RegExp(query, ignoreCase ? 'gi' : 'g')
        let n = 0
        // Guard the zero-width case: /a*/g on a non-matching position returns
        // an empty match forever and never advances.
        for (let m = re.exec(text); m; m = re.exec(text)) {
            n++
            if (m.index === re.lastIndex) re.lastIndex++
        }
        return n
    }
    const haystack = ignoreCase ? text.toLowerCase() : text
    const needle = ignoreCase ? query.toLowerCase() : query
    if (!needle) return 0
    let n = 0
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++
    return n
}

// 1-based line of the first match, so a hit is somewhere to go rather than
// something to grep for again.
function lineOfFirstMatch(text, query, regex, ignoreCase) {
    let at = -1
    if (regex) {
        const m = new RegExp(query, ignoreCase ? 'i' : '').exec(text)
        at = m ? m.index : -1
    } else {
        const haystack = ignoreCase ? text.toLowerCase() : text
        at = haystack.indexOf(ignoreCase ? query.toLowerCase() : query)
    }
    if (at < 0) return null
    let line = 1
    for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++
    return line
}

// Every occurrence of a needle in a text, with the one signal that separates
// "this file DECLARES it" from "this file uses it" without knowing the language.
//
// This used to scan for a `{` after the match and skip /* */ comment ranges —
// one stylesheet syntax, hard-coded, in an engine that also renders PDFs,
// emails and whatever a renderer plugin produces. It was ungated too: a
// markdown file, a template full of {{ }}, or a YAML value containing a brace
// all went through that same reasoning and could be reported as a declaration.
//
// `leading` is the general form, and it needs no grammar: a declaration begins
// its line in nearly every text format, while a use sits mid-line. Measured
// against the case the old version was built for, it reproduces that ranking
// exactly — the file declaring the thing had 14 leading occurrences, the file
// merely scoping it had 0 leading and 1 mid-line.
//
// The LINE is returned rather than a computed verdict about it. A caller can
// tell a declaration from something that merely starts with the same token by
// reading it, which needs no grammar here at all — and where the heuristic is
// wrong, the evidence for that is right there in the response.
function findOccurrences(text, needle, { limit = 200 } = {}) {
    const sites = []
    if (!needle || typeof text !== 'string') return sites
    let line = 1
    let lineStart = 0
    let scanned = 0
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        while (scanned < at) {
            if (text.charCodeAt(scanned) === 10) { line++; lineStart = scanned + 1 }
            scanned++
        }
        const lineEnd = text.indexOf('\n', at)
        sites.push({
            line,
            col: at - lineStart,
            leading: text.slice(lineStart, at).trim() === '',
            text: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim().slice(0, 160),
        })
        if (sites.length >= limit) break
    }
    return sites
}

// Fields of an entity's own meta whose value carries the needle, each with the
// line and column it was WRITTEN at where the format allows.
//
// This is the recorded half. The field path comes from the parsed meta the
// engine is already holding — no scan, no guess, and no cost. The line and
// column come from `runtime.provenance`, which parses the raw source once and
// caches the result against the entity's checksum, so a build pays nothing and
// the first question about a file pays one parse.
//
// It reaches what a string scan of the page cannot: a nav label printed on
// every page of a site by a shared partial appears in no page's own document,
// and finding it previously meant paging the whole catalog and guessing at a
// filename.
async function metaHits(entity, needle) {
    if (!entity?.meta) return []
    const matches = []
    for (const [field, value] of flattenMeta(entity.meta)) {
        if (!String(value).includes(needle)) continue
        matches.push({ field, value: String(value) })
    }
    if (!matches.length) return []
    // Positions are an enhancement, never a precondition: a format whose
    // parser gives no ranges, or a file that has moved since import, still
    // yields the field path — which is the half that matters most.
    let positions = {}
    try {
        positions = await useProvenance().positionsFor(entity)
    } catch { /* no database, or nothing parseable — the path still stands */ }
    return matches.map(match => ({
        ...match,
        ...(positions[match.field] ?? {}),
        exact: match.value === needle,
    }))
}

// Which source emitted a string into a built file.
//
// Reads the render's recorded closure and asks each consumed entity whether
// the value is one of its own fields — the same lookup mikser_which does, so
// the two cannot give different answers to the same question. Returns an empty
// list rather than guessing when the render composed the value itself.
async function attributeOutput(destination, needle) {
    const out = []
    // sourcesOf is the engine's own union across every entity claiming the
    // destination, so a contested one attributes through both rather than
    // through whichever snapshot came back first.
    for (const source of await sourcesOf(destination)) {
        const entity = await readEntity({ id: source.id })
        const fields = await metaHits(entity, needle)
        if (fields.length) out.push({ id: source.id, via: source.via, fields })
    }
    return out
}

// Every file under the output folder, depth-first. A generator so a search
// that hits its limit stops walking rather than materializing the tree.
async function* walkOutputFiles(folder) {
    let entries
    try {
        entries = await readdirAsync(folder, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) yield* walkOutputFiles(full)
        else if (entry.isFile()) yield full
    }
}

// Enough text around the match to recognise it without returning the file.
function snippetAround(text, query, regex, ignoreCase) {
    const haystack = ignoreCase ? text.toLowerCase() : text
    let at = -1
    if (regex) {
        const m = new RegExp(query, ignoreCase ? 'i' : '').exec(text)
        at = m ? m.index : -1
    } else {
        at = haystack.indexOf(ignoreCase ? query.toLowerCase() : query)
    }
    if (at < 0) return text.slice(0, 120)
    const start = Math.max(0, at - 60)
    const end = Math.min(text.length, at + query.length + 60)
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
}

// Drop what a caller almost never reads, and never touch `content`.
//
// Two things bloat a read: the same layout template inlined twice — once at
// `layout.content` and again at `layouts[0].content`, byte for byte — and
// the template body itself, which is what mikser_layouts_inspect is for.
// The duplicate goes at every verbosity because a second identical copy is
// not information; the body goes only at "compact".
//
// `content` is exempt at both settings. It is the source of a whole-file
// rewrite, so trimming it would hand the caller a copy that looks writable
// and silently deletes whatever was cut.
function trimEntity(entity, verbosity) {
    if (!entity || typeof entity !== 'object') return entity
    const out = { ...entity }
    if (Array.isArray(out.layouts) && out.layout) {
        out.layouts = out.layouts.map(l => {
            if (l && l.content !== undefined && l.content === out.layout.content) {
                const { content, ...rest } = l
                return { ...rest, contentSameAs: 'layout.content' }
            }
            return l
        })
    }
    if (verbosity === 'compact') {
        if (out.layout?.content !== undefined) {
            out.layout = { ...out.layout, content: undefined, contentOmitted: 'verbosity=compact; use mikser_layouts_inspect' }
        }
        if (Array.isArray(out.layouts)) {
            out.layouts = out.layouts.map(l => (l?.content === undefined ? l
                : { ...l, content: undefined, contentOmitted: 'verbosity=compact' }))
        }
    }
    return out
}

// The file's checksum, or null when it is not there yet. `checksum` throws
// on a missing file; a caller asking "has this changed since I read it"
// needs "it does not exist" as an answer rather than an exception.
async function fileChecksum(uri) {
    try {
        return await fileChecksumOf(uri)
    } catch {
        return null
    }
}

// Files beside this one that differ only by extension.
//
// The motivating case: an empty `index.md` sitting next to the real
// `index.yml`, both rendering to /bg/index.html, one silently overwriting
// the other. The destination is not known until the cycle renders, but the
// COLLIDING SHAPE is visible at write time — same path, different suffix —
// and saying so at the moment of the write is the only point where it is
// cheap to fix.
//
// A heuristic, and named as one in the response: two files with the same
// stem do not always collide (different layouts can send them elsewhere),
// and a collision can also arise between unrelated paths. The build report
// and mikser_verify carry the authoritative answer once a cycle has run.
async function siblingsSharingDestination(folder, relativePath) {
    const dir = path.dirname(path.join(folder, relativePath))
    const base = path.basename(relativePath, path.extname(relativePath))
    try {
        const entries = await readdirAsync(dir, { withFileTypes: true })
        return entries
            .filter(e => e.isFile()
                && path.basename(e.name, path.extname(e.name)) === base
                && e.name !== path.basename(relativePath))
            .map(e => ({
                path: path.join(path.dirname(relativePath), e.name),
                note: 'same name, different extension — may render to the same destination',
            }))
    } catch {
        return []
    }
}

// Files a caller must not edit blind, read from the bytes themselves.
//
// The motivating line is real: styles/tokens/buttons.css opens with
// "Spec source: uploads/l-med-buttons2 for claude.pdf — match exactly." That
// sentence is the difference between fixing a shared token and violating a
// signed-off design, and it was discoverable only by reading far enough down
// a comment nobody was asked to read. A marker that only works if you already
// read the file is not a marker.
//
// Two kinds, kept apart because the instruction differs. `spec-locked` means
// the bytes answer to a document outside the repo — change it and the site
// stops matching something a human signed. `generated` means editing this file
// at all is pointless, because the next build overwrites it.
//
// Declared either way:
//   - `meta.specLocked` / `meta.generated`, for any format with frontmatter
//     or YAML, which is the explicit form and wins.
//   - a header line in the first HEADER_SCAN_LINES, for formats with no meta
//     at all — .css, .js, plain .txt. That is most of the files this is for.
const HEADER_SCAN_LINES = 40
const HEADER_PATTERNS = [
    { kind: 'spec-locked', re: /^\W*spec source:\s*(.+?)\s*$/i },
    { kind: 'generated',   re: /^\W*(?:generated by|do not edit)\b:?\s*(.*?)\s*$/i },
]

// The catalog entity written from this file, when there is one. Used by the
// write path, which is handed a folder-relative path rather than an id.
async function findEntityAtUri(uri) {
    if (!uri) return null
    const matches = await findEntities({ uri })
    return matches?.[0] ?? null
}

// The file's text, or null. Not an error path: a caller writing a .png has no
// header to read and nothing has gone wrong.
async function readIfText(uri) {
    if (!isTextEntity({ uri })) return null
    try {
        return await readFileAsync(uri, 'utf8')
    } catch {
        return null
    }
}

export function contentAdvisories(entity, content) {
    const found = []
    const push = (kind, detail, via, line) => {
        if (found.some(a => a.kind === kind)) return
        found.push({ kind, detail: detail || null, via, ...(line ? { line } : {}) })
    }
    // Explicit meta wins: someone wrote it down as data, on purpose.
    if (entity?.meta?.specLocked) {
        push('spec-locked', typeof entity.meta.specLocked === 'string' ? entity.meta.specLocked : null, 'meta.specLocked')
    }
    if (entity?.meta?.generated) {
        push('generated', typeof entity.meta.generated === 'string' ? entity.meta.generated : null, 'meta.generated')
    }
    if (typeof content === 'string') {
        const lines = content.split('\n', HEADER_SCAN_LINES)
        for (let i = 0; i < lines.length; i++) {
            for (const { kind, re } of HEADER_PATTERNS) {
                const m = re.exec(lines[i])
                if (m) push(kind, m[1], 'header', i + 1)
            }
        }
    }
    return found
}

// One line of prose for a response that has to be read, not parsed.
export function advisoryWarning(advisories) {
    if (!advisories?.length) return null
    return advisories.map(a => a.kind === 'spec-locked'
        ? `SPEC-LOCKED: ${a.detail ?? 'this file answers to an external specification'}`
            + ' — changing it may break a signed-off design. Confirm against the spec before writing.'
        : `GENERATED: ${a.detail ?? 'this file is produced by the build'}`
            + ' — edit its source instead; the next build overwrites this.').join(' ')
}

// Resolve a catalog id to the (collection, relativePath) pair the write path
// needs.
//
// Every other tool speaks ids. update_entity alone asked the caller to split
// one into its parts, which a caller that just read or searched an entity
// cannot reliably do: the id prefix is `idPrefix ?? '/' + collection` and the
// extension may have been stripped, so splitting on the first segment is a
// guess that is usually right and silently wrong for any source configured
// either way.
//
// Taken from the entity instead — its `collection` and its `uri` relative to
// that collection's folder, which is exactly how the id was built.
async function locateById(id) {
    const entity = await readEntity({ id })
    if (!entity) {
        return { error: `No entity with id ${id}. Ids come from mikser_query_entities / mikser_search; `
            + 'to CREATE a file, pass collection + relativePath instead.' }
    }
    if (!entity.collection) return { error: `Entity ${id} has no collection, so its file location cannot be derived.` }
    let folder
    try {
        folder = useCollection(runtime, entity.collection).folder
    } catch (err) {
        return { error: `Entity ${id} is in collection ${entity.collection}, which has no folder: ${err.message}` }
    }
    if (!entity.uri) {
        return { error: `Entity ${id} has no uri — it is synthetic (emitted by a plugin, not read from a file) and has no file to rewrite.` }
    }
    const relativePath = path.relative(folder, entity.uri)
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { error: `Entity ${id} lives at ${entity.uri}, outside its collection folder ${folder}.` }
    }
    return { collection: entity.collection, relativePath }
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
// RFC 6750 §3.1 error parameters, appended to whatever challenge the
// surface builds.
//
// `error` is what a client's refresh logic reads. Without it an expired
// access token and a request that never carried one produce byte-identical
// responses, so a client cannot tell "exchange your refresh token" from
// "send the human to a browser" — and does the second, mid-task. Omitted
// entirely when nothing was presented, because that omission is itself the
// signal for the sign-in case.
function errorParams(outcome) {
    if (!outcome?.code) return ''
    let out = `, error="${outcome.code}"`
    if (outcome.description) out += `, error_description="${outcome.description}"`
    if (outcome.scope) out += `, scope="${outcome.scope}"`
    return out
}

function challenge(req, res, verifier, path, outcome) {
    if (verifier?.authorizationServers?.length) {
        const origin = `${req.protocol}://${req.get('host')}`
        res.set('WWW-Authenticate',
            `Bearer resource_metadata="${origin}${metadataPath(path)}"${errorParams(outcome)}`)
        return
    }
    if (verifier?.challenge) return verifier.challenge(req, res, outcome)
    if (verifier) res.set('WWW-Authenticate', `Bearer${errorParams(outcome)}`.replace(/^Bearer, /, 'Bearer '))
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
            //
            // 403 gets one too: insufficient_scope lives there, and a client
            // reading the header only on 401 is the client that cannot tell
            // "your token expired" from "your token is not allowed to do
            // this" — the first is silently fixable, the second never is.
            if (outcome.status === 401 || outcome.status === 403) {
                challenge(req, res, verifier, path, outcome)
            }
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
            // Inside the ALS so a tool handler can see who is calling — see
            // authContext. The whole request runs in it, including the
            // handler the SDK dispatches to.
            return authContext.run({ principal: req.principal }, () =>
                transports.get(sessionId).handleRequest(req, res, body))
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
        return authContext.run({ principal: req.principal }, () =>
            transport.handleRequest(req, res, body))
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
    // mikser_build_report needs the cycle recorded, and recording is off
    // unless a reader asks for it — see report.js requestReport.
    requestReport()
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
            'mikser_search',
            'Find a string across the catalog in ONE call — "where does this appear?". Searches entity meta values and, when asked, the source files themselves, returning { id, collection, path, field, snippet } per hit.\n\n'
            + 'This is the tool for locating content you can only describe by what it says: a menu label, a phone number, a sentence you were asked to change. Paging mikser_query_entities to find it means reading the whole catalog — most of which is fonts and image derivatives — and finding a SECOND copy of the same label somewhere else is then a matter of luck.\n\n'
            + 'in: ["meta"] searches structured values (fast, indexed JSON walk). in: ["content"] reads source files from disk (slower, text formats only, binaries skipped). Default is both. `regex: true` treats `query` as a JavaScript regular expression.\n\n'
            + 'in: ["output"] searches the BUILT files instead of the catalog, and reports `occurrences` per destination. That is the blast-radius question — "which shipped pages carry this class, and how heavily" — which is what you want before editing anything shared. The two scopes answer different questions and neither implies the other: a string can be in the output because a layout writes it, with no source entity containing it anywhere.',
            {
                query:      z.string().describe('Text to find. A plain substring unless `regex` is true. Case-sensitive by default.'),
                collection: z.string().optional().describe('Restrict to one collection (e.g. "documents"). Omit to search all.'),
                in:         z.array(z.enum(['meta', 'content', 'output'])).optional().describe('Where to look: "meta" (entity fields), "content" (source file text), "output" (the BUILT files in the output folder). Default is meta + content; "output" is never implied because it answers a different question.'),
                regex:      z.boolean().optional().describe('Treat `query` as a JavaScript regular expression rather than a literal substring.'),
                ignoreCase: z.boolean().optional().describe('Case-insensitive matching. Default false.'),
                limit:      z.number().int().positive().max(200).optional().describe('Maximum hits to return (default 50, max 200). The response says when it stopped early.'),
                attribute:  z.boolean().optional().describe('Output scope only: for each built file, also name the SOURCE that emitted the match, with field path and line/col where recorded. Costs a provenance lookup per hit, so it is off by default; turn it on once the blast radius is small enough to act on.'),
            },
            async ({ query, collection, in: where, regex, ignoreCase, limit = 50, attribute }) => {
                try {
                    if (!query) return fail('query is required')
                    const scopes = where?.length ? where : ['meta', 'content']
                    let matcher
                    try {
                        matcher = regex
                            ? new RegExp(query, ignoreCase ? 'i' : '')
                            : { test: (v) => (ignoreCase ? String(v).toLowerCase().includes(query.toLowerCase()) : String(v).includes(query)) }
                    } catch (err) {
                        return fail(`invalid regex: ${err.message}`)
                    }

                    const hits = []
                    let truncated = false

                    // The output scope walks the deployed folder, not the
                    // catalog, so it runs on its own and skips the entity loop
                    // entirely. Counting is the point here rather than
                    // first-match: seven occurrences on one page and one on
                    // nine others is the shape of a shared component, and a
                    // list of nine equal-looking filenames hides it.
                    if (scopes.includes('output')) {
                        const outputFolder = runtime.options?.outputFolder
                        if (!outputFolder) return fail('No output folder configured, so there is no built output to search.')
                        for await (const file of walkOutputFiles(outputFolder)) {
                            if (hits.length >= limit) { truncated = true; break }
                            const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
                            if (!TEXT_OUTPUT_EXTENSIONS.has(ext)) continue
                            let text
                            try { text = await readFileAsync(file, 'utf8') } catch { continue }
                            const occurrences = countMatches(text, query, regex, ignoreCase)
                            if (!occurrences) continue
                            const destination = '/' + path.relative(outputFolder, file).split(path.sep).join('/')
                            const hit = {
                                destination,
                                where: 'output',
                                occurrences,
                                snippet: snippetAround(text, query, regex, ignoreCase),
                            }
                            // Which source put it there. The same recorded
                            // closure mikser_which reads, so a shared nav label
                            // resolves to the nav document and its field rather
                            // than to the page it happens to appear on.
                            if (attribute && !regex) {
                                hit.emittedBy = await attributeOutput(destination, query)
                            }
                            hits.push(hit)
                        }
                        hits.sort((a, b) => b.occurrences - a.occurrences || a.destination.localeCompare(b.destination))
                    }

                    const searchesCatalog = scopes.some(scope => scope !== 'output')
                    const entities = searchesCatalog
                        ? await findEntities(collection ? { collection } : undefined)
                        : []

                    for (const entity of entities) {
                        if (hits.length >= limit) { truncated = true; break }
                        if (scopes.includes('meta') && entity.meta) {
                            for (const [field, value] of flattenMeta(entity.meta)) {
                                if (!matcher.test(value)) continue
                                hits.push({ id: entity.id, collection: entity.collection ?? null, path: entity.uri ?? null,
                                            where: 'meta', field, snippet: snippetAround(String(value), query, regex, ignoreCase) })
                                break
                            }
                        }
                        if (hits.length >= limit) { truncated = true; break }
                        if (scopes.includes('content')) {
                            // Text formats only. readEntityContent already owns
                            // the text/binary decision, so a png is skipped here
                            // for the same reason it is skipped everywhere else.
                            if (!isTextEntity(entity)) continue
                            const { content } = await readEntityContent(entity)
                            if (typeof content !== 'string' || !matcher.test(content)) continue
                            hits.push({ id: entity.id, collection: entity.collection ?? null, path: entity.uri ?? null,
                                        where: 'content', field: null,
                                        occurrences: countMatches(content, query, regex, ignoreCase),
                                        line: lineOfFirstMatch(content, query, regex, ignoreCase),
                                        snippet: snippetAround(content, query, regex, ignoreCase) })
                        }
                    }
                    return ok({ query, scopes, count: hits.length, truncated, searched: entities.length, hits })
                } catch (err) {
                    logger.error('MCP mikser_search error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_which',
            'Reverse lookup, output back to source: "which source file produced this, and where in it?". Give it a built destination and, optionally, a string to locate inside the sources that fed it.\n\n'
            + 'This is the question an agent editing an existing site asks first and could not previously ask at all. Finding which file paints a button meant opening the live site in a browser, reading the element\'s class out of the DOM, and guessing at filenames — none of which needs to leave the toolset.\n\n'
            + 'The answer comes from the engine\'s own refClosure — the record of what each render consumed — so a bundle assembled from a catalog query resolves to the actual parts that went into it, each tagged with HOW it got there.\n\n'
            + 'Where the value is a parsed FIELD of an entity (a nav label, a title), the field path and its line and column are RECORDED, not searched for. Where it lives in file content, each occurrence reports its line and whether the string BEGINS that line — which is what separates the file declaring it from the files merely using it, in any text format, with no per-language grammar involved.\n\n'
            + 'Omit `text` to just list what produced the destination. For a bare engine with no mcp plugin, the `sources` tool answers that half.',
            {
                destination: z.string().describe('Output-relative destination, as reported by mikser_search({ in: ["output"] }), mikser_explain or the build report (e.g. "/bg/styles/site.css").'),
                text:        z.string().optional().describe('A string to locate inside those sources — a label, a class, an identifier. Matched literally, case-sensitive. Each hit reports its line and whether the string BEGINS it: a declaration usually does, a use usually does not.'),
                limit:       z.number().int().positive().max(200).optional().describe('Maximum source files to report (default 50).'),
            },
            async ({ destination, text, limit = 50 }) => {
                try {
                    if (!destination) return fail('destination is required')
                    if (!runtime.manifest?.snapshotsAt) {
                        return fail('No manifest available — nothing has been rendered yet.')
                    }
                    const snapshots = runtime.manifest.snapshotsAt(destination)
                    if (!snapshots.length) {
                        return ok({
                            destination, sources: [],
                            hint: 'No render claims this destination. It may be a file COPIED there (the files/shares/data plugins write '
                                + 'without a render snapshot), or the path may be wrong — mikser_search({ in: ["output"] }) lists what is '
                                + 'actually on disk, and mikser_read_output confirms one path.',
                        })
                    }

                    const needle = text
                    const results = []
                    let searched = 0
                    for (const snapshot of snapshots) {
                        for (const source of await sourcesBehind(snapshot)) {
                            if (results.length >= limit) break
                            const entity = await readEntity({ id: source.id })
                            const row = {
                                id: source.id,
                                path: entity?.uri ?? null,
                                via: source.via,
                                claimedBy: snapshots.length > 1 ? snapshot.id : undefined,
                            }
                            if (!needle) { results.push(row); continue }
                            if (!entity) continue
                            searched++

                            // First: the value as PARSED. The engine knows this
                            // entity was consumed by this render (refClosure) and
                            // knows which field holds this value (its own meta),
                            // so the answer is looked up rather than inferred —
                            // and it reaches values that never appear in the
                            // page's own source, which is most of a shared nav.
                            const fields = await metaHits(entity, needle)
                            if (fields.length) {
                                results.push({ ...row, basis: 'meta-field', recorded: true, fields })
                                continue
                            }

                            if (!isTextEntity(entity)) continue
                            const { content } = await readEntityContent(entity)
                            if (typeof content !== 'string') continue
                            const sites = findOccurrences(content, needle)
                            if (!sites.length) continue
                            results.push({
                                ...row,
                                // Located in the bytes of a source the refClosure
                                // names, at an exact offset — not a guess about
                                // which file might hold it.
                                basis: 'source-content',
                                recorded: true,
                                occurrences: sites.length,
                                leading: sites.filter(site => site.leading).length,
                                sites: sites.slice(0, 10),
                            })
                        }
                    }
                    // Nothing the recorded closure consumed carries this. It may
                    // have been composed at render time — assembled from parts
                    // by a layout or a helper — in which case
                    // no record of it exists and a scan of the whole catalog is
                    // the only thing left. That answer is real but weaker, and it
                    // is labelled so, because a caller acts differently on "the
                    // engine recorded this" than on "a string turned up here".
                    if (needle && !results.length) {
                        for (const entity of await findEntities(undefined)) {
                            if (results.length >= limit) break
                            const fields = await metaHits(entity, needle)
                            if (fields.length) {
                                results.push({ id: entity.id, path: entity.uri ?? null,
                                               via: ['not in this render\'s recorded closure'],
                                               basis: 'scan', recorded: false, fields })
                                continue
                            }
                            if (!isTextEntity(entity)) continue
                            const { content } = await readEntityContent(entity)
                            if (typeof content !== 'string') continue
                            const sites = findOccurrences(content, needle)
                            if (!sites.length) continue
                            results.push({ id: entity.id, path: entity.uri ?? null,
                                           via: ['not in this render\'s recorded closure'],
                                           basis: 'scan', recorded: false,
                                           occurrences: sites.length,
                                           leading: sites.filter(site => site.leading).length,
                                           sites: sites.slice(0, 10) })
                        }
                    }

                    // A file where the string BEGINS a line declares it; one
                    // where it sits mid-line uses it. Ranked rather than
                    // filtered, because an override that only scopes the thing
                    // is a real second answer and hiding it is how a fix lands
                    // in the wrong file.
                    //
                    // A recorded answer outranks a scanned one before any of
                    // that: they are different kinds of claim, not two grades of
                    // one, and ordering them together would invite reading the
                    // weaker as the stronger.
                    const leadingOf = (r) => r.leading ?? (r.fields?.length ? 1 : 0)
                    results.sort((a, b) =>
                        (b.recorded === true) - (a.recorded === true)
                        || (b.fields?.some(f => f.exact) === true) - (a.fields?.some(f => f.exact) === true)
                        || (leadingOf(b) > 0) - (leadingOf(a) > 0)
                        || leadingOf(b) - leadingOf(a)
                        || (b.occurrences ?? 0) - (a.occurrences ?? 0))

                    return ok({
                        destination,
                        claimants: snapshots.map(snap => snap.id),
                        ...(snapshots.length > 1
                            ? { contested: 'More than one entity renders to this destination — see mikser_explain. The sources below are the union of what all of them consumed.' }
                            : {}),
                        looking: text ? { text } : null,
                        searched,
                        count: results.length,
                        recorded: results.filter(r => r.recorded).length,
                        sources: results,
                        // What kind of claim each answer is. A recorded one and a
                        // scanned one warrant different trust, and a response
                        // that presents them identically invites the caller to
                        // treat the weaker as the stronger.
                        bases: needle ? {
                            'meta-field': 'RECORDED. The engine consumed this entity for this render (refClosure) and this field of its '
                                + 'parsed meta holds the value. `line`/`col` come from parsing the raw source once, cached against its '
                                + 'checksum. Reaches values that appear nowhere in the page\'s own document — a shared nav or footer label.',
                            'source-content': 'RECORDED. Located at an exact offset in the bytes of a source the refClosure names. '
                                + '`leading` counts the occurrences that BEGIN their line, which is what separates a declaration from '
                                + 'a use in any text format — and it is a heuristic, so each hit carries the line itself as evidence.',
                            scan: 'NOT RECORDED. Nothing the render consumed carries this, so the whole catalog was searched instead. '
                                + 'The value may be composed at render time, or this may be an unrelated file that happens to contain '
                                + 'the same string. Verify before acting.',
                        } : undefined,
                        coverage: needle
                            ? 'Values assembled at render time — built from parts by a layout or a helper — are '
                              + 'recorded nowhere and fall through to the scan.'
                            : 'Every source the engine recorded for this render, including its layout, partials, $-refs and the members of any recorded catalog query.',
                    })
                } catch (err) {
                    logger.error('MCP mikser_which error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_read_output',
            'Read the bytes currently ON DISK in the output folder for a destination — what is actually deployed, as opposed to what the catalog or the manifest says should be. Use it to confirm an edit shipped without leaving the toolset.\n\n'
            + 'mikser_render does NOT answer this: it renders a transient entity through the pipeline and returns fresh bytes, which is a different question from "what is in the file right now".\n\n'
            + 'Text output is returned inline. Binary output is not decoded — the response reports its size and media type instead, since a utf8 read of a png is garbage.',
            {
                destination: z.string().describe('Output-relative destination, as reported by mikser_explain or the build report (e.g. "/bg/index.html"). An absolute path recorded by a plugin writing outside the output folder also works.'),
            },
            async ({ destination }) => {
                try {
                    if (!destination) return fail('destination is required')
                    const filePath = resolveOutputPath(destination)
                    let info
                    try {
                        info = await statAsync(filePath)
                    } catch {
                        return ok({ destination, exists: false, path: filePath,
                                    hint: 'Nothing is deployed at this destination. mikser_explain will say whether anything renders to it.' })
                    }
                    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
                    const text = TEXT_OUTPUT_EXTENSIONS.has(ext)
                    if (!text) {
                        return ok({ destination, exists: true, path: filePath, bytes: info.size, binary: true,
                                    contentSkipped: `binary output (.${ext}) is not decoded; ${info.size} bytes on disk` })
                    }
                    const content = await readFileAsync(filePath, 'utf8')
                    return ok({ destination, exists: true, path: filePath, bytes: info.size, binary: false, content })
                } catch (err) {
                    logger.error('MCP mikser_read_output error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_refs_inbound',
            'List entities that reference the given href — "what breaks if I delete this?". Returns every (entity id, field path) pair pointing at the target, each tagged with `kind`: "ref" for a $-keyed reference field (the ones the engine invalidates on) or "href" for a plain string value anywhere under an entity\'s meta, including inside arrays such as a nav or footer item list. Exact match on the value as written in source.\n\n'
            + 'The response always carries a `coverage` block naming what this does NOT see — body-text links and links a layout builds at render time — because a bare count: 0 otherwise reads as "nothing references this" when it means "nothing of the kind I look at". For body text, use mikser_search({ in: ["content"] }).',
            {
                ref: z.string().describe('Reference value to look up. Match is exact on the source-file form (e.g. "/authors/dick"). Hrefs, not catalog ids.'),
            },
            async ({ ref }) => {
                try {
                    if (!ref) return fail('ref is required')
                    const entries = runtime.refs.inboundFor(ref)
                    return ok({
                        ref,
                        count: entries.length,
                        entries,
                        // What this answer does and does not cover, stated
                        // every time. This tool answers "what breaks if I
                        // delete this", and a bare count: 0 reads as "nothing"
                        // when it may mean "nothing of the kind I look at" —
                        // which is how two live pages linking to /about were
                        // reported as zero referrers.
                        coverage: {
                            ref: '$-keyed reference fields, from the invalidation index',
                            href: 'plain string values anywhere under an entity\'s meta, including inside arrays (nav/footer item lists)',
                            notCovered: [
                                'links written inside document BODY text (markdown/HTML), which are not entity meta — search for them with mikser_search({ in: ["content"] })',
                                'links built at render time by a layout or sidecar rather than stored in meta',
                            ],
                        },
                    })
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

        // ── Diagnostics ────────────────────────────────────────────
        //
        // The three questions --explain, --json and --verify answer, over
        // the transport an agent actually has. Everything built to make the
        // engine legible landed on the CLI first, which meant it required a
        // shell on the box: an agent could author a page and walk the ref
        // graph, but could not ask why the engine did what it did — the
        // question the whole area exists for.
        //
        // Read-only, all three. They return the same structured objects the
        // CLI formats, so there is one implementation of each answer rather
        // than a second one that drifts.




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
                    // This rewrites every referring file in turn. Stopping half
                    // way leaves the catalog pointing at two names at once.
                    const refusal = refuseIfExpiringWithin(60, 'a rename across every referring file')
                    if (refusal) return refusal
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
            'Read a single entity by its catalog id (e.g. "/documents/about.md"). Returns the full entity record or null when not found. Pass include: ["positions"] to also get where each meta field was written — { "items[2].label": { line, col } } — which is how you cite a value or find it again without scanning. Pass include: ["content"] to also fetch the source file content from disk — useful for reading a layout template, document frontmatter+body, or any text-format source without dropping out to the filesystem. Binary formats (png/pdf/mp4/etc.) get a `contentSkipped` hint pointing at mikser_render instead of decoded bytes. Pass `expand` to inline referenced entities in the response (per ADR-0007): paths like "author", "author.organization", or "sections.*.image" replace the ref string with the resolved entity in one trip.',
            {
                id: z.string().describe('Catalog id of the entity to read.'),
                include: z.array(z.enum(['content', 'positions'])).optional().describe('Extra fields to populate. "content" reads the file at entity.uri as utf8 and attaches it as .content (binary formats get `contentSkipped` instead of garbage utf8). "positions" attaches `positions`: where each meta field was WRITTEN, as { "items[2].label": { line, col } } — so a value can be cited or found without scanning for it.'),
                expand: z.array(z.string()).optional().describe('Inline-expand referenced entities. Each entry is a dotted path through $-keyed reference fields. Use `*` for array iteration. Examples: ["author"], ["author.organization"], ["sections.*.image"]. Same caps as mikser_query_entities.'),
                verbosity: z.enum(['full', 'compact']).optional().describe('"compact" drops the resolved layout template body, which is the bulk of a typical response and is rarely read — mikser_layouts_inspect returns it on purpose. `content` is NEVER trimmed at either setting. Default "full".'),
            },
            async ({ id, include, expand, verbosity = 'full' }) => {
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
                        // `content` is the whole file, always. A caller's only
                        // write mode is a whole-file rewrite, so a truncated or
                        // transformed copy would be a silent data-loss machine:
                        // it would look writable and delete whatever was cut.
                        // Stated in the response, not just the description,
                        // because that is what a caller can actually check.
                        if (typeof entity.content === 'string') {
                            entity.contentBytes = Buffer.byteLength(entity.content)
                            entity.contentComplete = true
                        }
                    }
                    // Structured, not left in a comment for a reader to
                    // happen upon. A file governed by an external spec, or
                    // generated by the build, is one a caller must not edit
                    // blind — and a marker that only works if you already read
                    // far enough down the file is not a marker.
                    //
                    // Reported whether or not `content` was requested: the meta
                    // form needs no bytes, and the header form reads them here
                    // rather than making the caller ask twice.
                    // Where each meta field was written. Opt-in for the same
                    // reason content is: the field paths are free but the line
                    // and column cost one parse of the source, cached after.
                    //
                    // This is the agent-shaped answer to "which line holds
                    // this value" — the question the old guide plugin answered
                    // with a tooltip in a browser. An editing agent never
                    // looks at rendered bytes, so it wants the position as
                    // data on the read it was already doing.
                    if (entity && include?.includes('positions')) {
                        try {
                            entity.positions = await useProvenance().positionsFor(entity)
                        } catch {
                            entity.positions = {}
                        }
                        if (!Object.keys(entity.positions).length) {
                            entity.positionsNote = 'No positions available for this entity — a synthetic '
                                + 'entity with no source, a format whose parser reports none and that has '
                                + 'registered no probe, or a file that failed to parse. The field paths in '
                                + '`meta` are still exact.'
                        }
                    }
                    const advisories = entity ? contentAdvisories(
                        entity,
                        typeof entity.content === 'string' ? entity.content : await readIfText(entity.uri)) : []
                    if (advisories.length) {
                        entity.advisories = advisories
                        entity.warning = advisoryWarning(advisories)
                    }
                    return ok(trimEntity(entity, verbosity))
                } catch (err) {
                    logger.error('MCP mikser_read_entity error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        mcp.simpleTool(
            'mikser_update_entity',
            'Create or update a content file inside a mikser collection. Writes the WHOLE file — there is no partial-edit or patch mode, so send the complete intended contents. The file lands on disk and the next lifecycle cycle picks it up.\n\n'
            + 'Pass `ifChecksum` with the checksum you got from mikser_read_entity to make the write conditional: if the file has changed since you read it the write is REFUSED and the response carries `currentChecksum`, so a blind whole-file rewrite cannot silently discard someone else\'s edit. Without it the write is unconditional.\n\n'
            + 'The response returns the resulting `checksum` (pass it as the next `ifChecksum`), the `cycleId` your write will be picked up by, and `siblingDestinations` when another file could render to the same place (e.g. index.md beside index.yml — whichever renders last wins and the other output is discarded).\n\n'
            + 'Pass `await: true` to block until that cycle finishes and get its build report back, so one call tells you what your edit invalidated instead of writing and guessing.',
            {
                id:           z.string().optional().describe('Catalog id of an EXISTING entity (e.g. "/styles/tokens/buttons.css"), as returned by every other tool. Alternative to collection + relativePath; the file location is derived from the entity. To create a new file, pass the pair instead.'),
                collection:   z.string().optional().describe('Collection name (e.g. "documents", "layouts"). Required unless `id` is given.'),
                relativePath: z.string().optional().describe('Path relative to the collection folder (e.g. "blog/2026-06-02-launch.md"). Required unless `id` is given.'),
                content:      z.string().optional().describe('COMPLETE file content. This replaces the file; anything omitted is deleted. Frontmatter is parsed by the corresponding plugin.'),
                ifChecksum:   z.string().optional().describe('Precondition: only write if the file\'s current checksum equals this. Use the `checksum` from mikser_read_entity. On mismatch the write is refused and `currentChecksum` is returned — re-read, re-apply your change, retry. Omit to write unconditionally.'),
                await:        z.boolean().optional().describe('Block until the cycle that picks up this write completes, and return its build report as `report`. Slower, but answers "what did my edit change" in the same call.'),
                dryRun:       z.boolean().optional().describe('Write NOTHING. Returns `wouldAffect` — every destination that would re-render, each with the same reason vocabulary the build report uses — plus any advisory on the file and any destination collision already standing at those outputs. Use before touching anything shared.'),
            },
            async ({ id, collection, relativePath, content = '', ifChecksum, await: awaitCycle, dryRun }) => {
                try {
                    if (id) {
                        const located = await locateById(id)
                        if (located.error) return fail(located.error)
                        // An explicit pair still wins if a caller passes both,
                        // but disagreeing with the id is a mistake worth
                        // refusing rather than silently resolving one way.
                        if (collection && collection !== located.collection) {
                            return fail(`id ${id} is in collection ${located.collection}, not ${collection}. Pass one or the other.`)
                        }
                        collection ??= located.collection
                        relativePath ??= located.relativePath
                    }
                    if (!collection || !relativePath) {
                        return fail('Pass either `id` (for an existing entity) or both `collection` and `relativePath`.')
                    }
                    // Before the bytes move, not after. A dry run changes
                    // nothing, so it is never refused.
                    if (!dryRun) {
                        const refusal = refuseIfExpiringWithin(
                            awaitCycle ? 120 : 15,
                            awaitCycle ? 'a write that then waits for a build cycle' : 'a write')
                        if (refusal) return refusal
                    }

                    const handle = useCollection(runtime, collection)
                    const uri = path.join(handle.folder, relativePath)

                    // Everything a caller should know BEFORE the bytes move.
                    // Computed for the dry run and for the real write alike, so
                    // the preview and the thing it previews cannot disagree.
                    const existing = id ? await readEntity({ id }) : await findEntityAtUri(uri)
                    const advisories = contentAdvisories(existing, await readIfText(uri))

                    if (dryRun) {
                        const wouldAffect = existing?.id
                            ? (runtime.manifest?.affectedBy?.(existing) ?? [])
                            : []
                        const touched = new Set(wouldAffect.map(a => a.destination))
                        return ok({
                            ok: true, dryRun: true, collection, relativePath,
                            id: existing?.id ?? null,
                            exists: existing != null,
                            currentChecksum: await fileChecksum(uri),
                            advisories,
                            warning: advisoryWarning(advisories),
                            wouldAffect,
                            wouldAffectCount: wouldAffect.length,
                            siblingDestinations: await siblingsSharingDestination(handle.folder, relativePath),
                            // Collisions ALREADY standing at the outputs this
                            // write would touch. A write cannot be blamed for
                            // them, but re-rendering into one is how the wrong
                            // half of a contested destination wins.
                            collisionsAtAffected: (runtime.manifest?.collisions?.() ?? [])
                                .filter(c => touched.has(c.destination)),
                            note: existing?.id
                                ? 'Destinations are computed with the engine\'s own skip rule, so they match what a real cycle would do — EXCEPT for changes to the entity\'s own frontmatter, which is parsed during import and can move its destination.'
                                : 'This file is not in the catalog yet, so nothing depends on it and there is no blast radius to report.',
                        })
                    }

                    // Precondition, checked immediately before the write. This
                    // is not a lock — a writer that lands between the check and
                    // the write still wins — but it closes the window that
                    // matters in practice: read, think, write back a whole file
                    // built from a copy that is now stale.
                    const before = await fileChecksum(uri)
                    if (ifChecksum !== undefined && ifChecksum !== before) {
                        return ok({
                            ok: false,
                            refused: 'checksum-mismatch',
                            collection, relativePath,
                            expectedChecksum: ifChecksum,
                            currentChecksum: before,
                            hint: before === null
                                ? 'The file does not exist. Omit ifChecksum to create it.'
                                : 'The file changed since you read it. Re-read it, re-apply your change to the new content, and retry with the checksum from that read.',
                        })
                    }

                    const cycleId = nextCycleId()
                    await handle.write(relativePath, content)
                    const after = await fileChecksum(uri)

                    const response = {
                        ok: true, collection, relativePath,
                        checksum: after,
                        bytes: Buffer.byteLength(content),
                        cycleId,
                        siblingDestinations: await siblingsSharingDestination(handle.folder, relativePath),
                    }
                    // Echoed on the way out, not only on read. A caller that
                    // never read the file — or read past the header — is
                    // exactly the one that needs telling, and telling it after
                    // the write still names what to check before the deploy.
                    if (advisories.length) {
                        response.advisories = advisories
                        response.warning = advisoryWarning(advisories)
                    }
                    if (awaitCycle) {
                        response.report = await whenCycleCompletes(cycleId)
                    }
                    return ok(response)
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
                    const refusal = refuseIfExpiringWithin(15, 'a delete')
                    if (refusal) return refusal
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
