# Phase 2 Migration Plan

Move all MCP functionality out of `mikser-io` core into `mikser-io-mcp`, the package this document lives in. Today the plugin is an empty scaffold; this plan is how we get from there to a working spec-compliant extraction.

> **Status:** Plan, not yet executed. The plan needs sign-off before any file moves. After execution this document either stays as a record or gets removed.

## Scope

**Migrating into this plugin:**
- The MCP substrate (`createMcpSubstrate`), HTTP transport (`mountMcpOnExpress`), built-in `mikser://` introspection resources, `mikser_ping`, pino-to-MCP log bridge (`wireLoggerToMcp`) — currently `mikser-io/src/mcp.js`
- The MCP-UI surface: shell resource (`ui://mikser/preview-ui-shell`), `mikser_preview_ui`, `mikser_ui_action`, `forwardToHandler`, the modes discovery resource (`mikser://mcp-ui/modes`), `mikser_preview_render` — currently the MCP half of `mikser-io/src/plugins/preview.js`
- Their unit tests
- `documentation/mcp.md` and ADR-0008 (per user decision: code/docs co-location)

**Staying in mikser-io core:**
- The preview cache infrastructure (`runtime.options.preview.{store,get,stats}`, `GET /preview/:filename` route, the in-memory Map). Not MCP-specific.
- Other plugins' `mcp.simpleTool(...)` registration calls in `api.js`, `layouts.js`, `refs.js`. They compose through `runtime.options.mcp`; provider just changes from engine to plugin.
- CORS handling stays engine concern, but the hand-rolled middleware is **replaced by the [`cors` npm package](https://www.npmjs.com/package/cors)** so OPTIONS preflight, credentials, max-age, and other edge cases are battle-tested. Plugin contributions ride on `runtime.options.corsAllowHeaders` / `corsExposeHeaders` arrays which `cors()` reads via its dynamic options form. See "CORS extension point" below.
- The `@modelcontextprotocol/sdk` peer-side usage is gone; the dep itself moves to `mikser-io-mcp`'s `dependencies`.

**Removed entirely:**
- The `--mcp [path]` CLI flag in `engine.js`. **Activation moves to plugin presence in the user's `mikser.config.js` plugins array.** This is a breaking change documented in the release notes.

## Activation contract (decision: plugin presence === MCP on)

`mikser.config.js`:

```js
export default {
    plugins: [
        'mcp',                       // ← presence activates MCP; MUST be first
        'documents',
        'layouts',
        // ... other plugins
    ],
    mcp: {
        path: '/mcp',                // default /mcp
        endpoints: {                 // optional, same shape as today
            public: { tools: [...] },
            admin:  { token: process.env.MIKSER_MCP_ADMIN_TOKEN, tools: ['mikser_*'] },
        },
    },
}
```

The plugin's factory function reads `runtime.config.mcp` to discover path + endpoints. No CLI flag, no environment variable.

**`mcp` must be FIRST in the plugins array** because mikser's plugin loader runs factories in list order. Plugins like `api.js`/`layouts.js`/`refs.js` register their MCP tools at their own `onLoaded` hook with `if (!runtime.options.mcp) return; mcp.simpleTool(...)`. For that gate to pass, `runtime.options.mcp = createMcpSubstrate()` must already have happened — which the mcp plugin's factory does synchronously. If `'mcp'` is listed AFTER another plugin in the array, that earlier plugin's `onLoaded` sees `runtime.options.mcp` as undefined and skips its registration.

The plugin's factory will log a warning if it detects `runtime.options.mcp` was somehow set by something else before it ran, surfacing the misconfiguration.

## File-by-file map

```
mikser-io/src/mcp.js                              →  mikser-io-mcp/index.js (merged with plugin entry)
mikser-io/src/plugins/preview.js (MCP-UI half)    →  mikser-io-mcp/preview.js
mikser-io/test/unit/mcp.test.js                   →  mikser-io-mcp/test/unit/index.test.js
mikser-io/test/unit/plugins/preview-handler.test.js →  mikser-io-mcp/test/unit/preview.test.js (merged)
mikser-io/test/unit/plugins/preview.test.js (MCP-UI portion) → mikser-io-mcp/test/unit/preview.test.js
mikser-io/documentation/mcp.md                    →  mikser-io-mcp/documentation/mcp.md
mikser-io/documentation/decisions/0008-mcp-ui-action-delivery.md → mikser-io-mcp/documentation/decisions/0008-mcp-ui-action-delivery.md
```

## Detailed code changes

### `mikser-io-mcp/index.js` (~620 lines after merge)

Composed of:
- The full content of current `mikser-io/src/mcp.js` (substrate, transport, built-in resources, ping, logger bridge) — all named exports preserved for any embedder still using them
- A `export default (core) => { ... }` plugin factory at the bottom that:
  - Reads `runtime.config.mcp` (object or undefined). If undefined, plugin runs but no substrate is created (effectively a no-op load).
  - Reads `runtime.config.mcp.path` (default `'/mcp'`). Stored at `runtime.options.mcpPath`.
  - Calls `runtime.options.mcp = createMcpSubstrate()` synchronously at factory time.
  - Composes `./preview.js`'s registration function (which registers all MCP-UI surface against the just-created substrate).
  - Registers an `onLoaded` hook to wire the engine's pino logger to the substrate's broadcast (`wireLoggerToMcp`).
  - Registers an `onLoaded` hook to mount the HTTP transport against `runtime.options.app` (if present) at the configured path (`mountMcpOnExpress`).
  - Returns `{ name: 'mcp' }`.

### `mikser-io-mcp/preview.js` (~530 lines)

A function `(core) => { ... }` that registers everything MCP-UI:
- `forwardToHandler` exported for tests
- `PREVIEW_UI_SHELL_HTML` module-scope constant
- The `ui://mikser/preview-ui-shell` resource
- The `mikser://mcp-ui/modes` discovery resource
- The `mikser_preview_ui` tool (with `_meta.ui.resourceUri`)
- The `mikser_ui_action` tool (with `_meta.ui.visibility = ['app']`)
- The `mikser_preview_render` tool, reaching into `runtime.options.preview.{store,get,stats}` for the cache

`preview.js` only acts if `runtime.options.mcp` is set (already a substrate by the time `preview.js` is called from `index.js`'s factory).

### `mikser-io/src/engine.js` (changes)

Remove:
- `.option('--mcp [path]', ...)` line in commander setup
- The entire `if (runtime.options.mcp) { ... createMcpSubstrate / wireLoggerToMcp ... }` block (~25 lines)
- The `if (runtime.options.mcp && runtime.options.mcpPath) { mountMcpOnExpress(...) }` block (~5 lines)
- Imports of `./mcp.js`
- The hardcoded MCP-specific header names (`mcp-session-id`, `mcp-protocol-version`, `last-event-id`) inside the CORS middleware

Replace the CORS header literals with reads from extensible arrays — see next section.

### CORS extension point (engine adopts `cors` package + extensible arrays)

Two changes layered together:

1. **Replace the hand-rolled middleware with the `cors` package.** Handles OPTIONS preflight, credentials, max-age, and proper status codes that the custom impl doesn't quite cover.
2. **Expose two composable header arrays on `runtime.options`.** Plugins push values into them at factory time. The `cors()` middleware uses its dynamic options form to read from the arrays per-request, so contributions made before any request lands are picked up correctly.

```js
// engine.js, before the cors() middleware registration:
runtime.options.corsAllowHeaders  = ['Content-Type', 'Authorization']
runtime.options.corsExposeHeaders = []

// Replace the hand-rolled middleware with cors(). The dynamic options
// form lets cors() re-read the arrays each request, so plugins that
// pushed at factory time get their headers honoured. corsOrigin
// comes from runtime.config.server.cors / --cors / default '*'
// exactly as today.
import cors from 'cors'

runtime.options.app.use(cors((req, callback) => {
    callback(null, {
        origin:         corsOrigin,
        methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: runtime.options.corsAllowHeaders,
        exposedHeaders: runtime.options.corsExposeHeaders,
    })
}))
```

Then `mikser-io-mcp/index.js`'s factory contributes:

```js
const add = (arr, items) => items.forEach(h => arr.includes(h) || arr.push(h))
add(runtime.options.corsAllowHeaders,  ['mcp-session-id', 'mcp-protocol-version', 'last-event-id'])
add(runtime.options.corsExposeHeaders, ['mcp-session-id', 'mcp-protocol-version'])
```

Why this shape:
- **`cors` package handles the protocol correctly.** No more custom OPTIONS short-circuit logic to maintain; the package owns it.
- **Idempotent contribution:** the `includes` guard prevents double-add on re-loads / hot reloads.
- **Composable:** any future plugin that needs custom request/response headers uses the same arrays. (`mikser-io-graphql` adds `apollo-require-preflight`, `mikser-io-shopify` adds `x-shopify-hmac-sha256`, etc.)
- **Load-order safe:** factory time runs before any request hits the middleware. cors()'s dynamic options reads per-request, so even late-pushed values would work.
- **Engine doesn't know which plugin contributed what** — it just hands the arrays to cors.

This is the only meaningful new public surface in `runtime.options` from this migration. Worth documenting in mikser-io's "Plugin authors" section once it lands.

### `mikser-io/package.json` — add `cors`

```json
"dependencies": {
    "cors": "^2.8.5",
    ...
}
```

Net dep count after migration: **+1** (`cors`), **−1** (`@modelcontextprotocol/sdk` moves to mcp plugin) → zero net change in mikser-io's dep count, with churn favouring better-tested deps.

### `mikser-io/src/plugins/preview.js` (changes)

Strip down to ~140 lines:
- Module header + cache-only `import path` and `import { randomUUID } from 'node:crypto'`
- `previews` Map + `bytesInUse` counter
- `config()` helper
- `store` / `get` / `stats` primitives
- `runtime.options.preview = { store, get, stats }` exposure
- `onLoaded` for the `GET /preview/:filename` Express route

Remove:
- `forwardToHandler` and its imports (`createHmac`)
- `PREVIEW_UI_SHELL_HTML` constant
- `mikser_preview_render` tool registration (moves to mcp-plugin/preview.js)
- The second `onLoaded` block that registers shell resource + modes + preview_ui + ui_action

### `mikser-io/src/plugins/api.js`, `layouts.js`, `refs.js` (no changes)

These keep doing `if (!runtime.options.mcp) return; mcp.simpleTool(...)`. The substrate they reference will be provided by the mcp plugin (when loaded) instead of by engine. Zero source changes.

### `mikser-io/index.js` (changes)

Remove the line: `export * from './src/mcp.js'`

`useRenderer`, `useCollection`, `runtime`, lifecycle hooks, etc. all stay as-is. Embedders who want MCP now `import { createMcpSubstrate } from 'mikser-io-mcp'` instead of `from 'mikser-io'`.

### `mikser-io/package.json` (changes)

- Remove `@modelcontextprotocol/sdk` from `dependencies`
- Add `cors: ^2.8.5` to `dependencies`
- Bump version to **`8.2.0`** (minor)

Strict semver would call this a major because the embedder-facing surface lost direct access to `createMcpSubstrate` etc., and the `--mcp` CLI flag goes away. We're shipping as minor with clear release notes documenting both breakages — the changes affect a narrow audience (CLI flag users + embedders who imported MCP primitives) and the migration path is simple (`install mikser-io-mcp; add 'mcp' to your plugins array`). Project's discipline call, not semver's.

Release notes must call out:
1. `mikser --mcp` no longer activates MCP. Move to `mikser.config.js` with `plugins: ['mcp', ...]`.
2. Embedders that did `import { createMcpSubstrate, ... } from 'mikser-io'` now `import ... from 'mikser-io-mcp'`.
3. New plugin-composable surface: `runtime.options.cors{Allow,Expose}Headers`.

### `mikser-io-mcp/package.json` (changes)

Bump `0.1.0` → `0.2.0` (scaffold → real). Add to `dependencies`:
- `@modelcontextprotocol/sdk: ^1.29.0`
- `minimatch: ^10.0.3` (used by `matchesAny` in substrate)
- `express` peer? probably leave as peer since mikser provides it
- `zod: ^4.0.0` (used by tool input schemas)

Possibly add `dependencies` for `front-matter` and others if they get pulled in by the MCP-UI side. Need to audit.

## Test strategy

Migrate tests alongside code; keep coverage at parity. Three test buckets:

1. **`mikser-io-mcp/test/unit/index.test.js`** — full content of current `mikser-io/test/unit/mcp.test.js` (substrate, broadcast, replay, endpoint filters). ~340 lines.

2. **`mikser-io-mcp/test/unit/preview.test.js`** — merge of:
   - Current `mikser-io/test/unit/plugins/preview-handler.test.js` (forwardToHandler) — ~180 lines
   - MCP-UI test blocks from current `mikser-io/test/unit/plugins/preview.test.js` (`mikser_preview_ui` dispatch + `mikser_ui_action` allow-list + shell resource registration) — ~200 lines
   - The `mikser_preview_render` test block (if there is one explicitly; it's tested implicitly via the smoke test today)

3. **mikser-io/test/unit/plugins/preview.test.js stays in core** — but stripped down to just cache + GET route tests. ~50-80 lines.

Add a test harness shim in mikser-io-mcp that provides the same `createHarness({ options, entities })` shape as core's plugin-harness, OR copy/extract the harness if it's not already in a usable shape. Both options are fine; pick whichever has less duplication.

**Pre-existing test counts** (for parity check):
- `mikser-io` total: 350 tests
- After extraction: ~270 in `mikser-io`, ~80 in `mikser-io-mcp`. Sum stays 350; nothing dropped.

## Documentation moves

```
mikser-io/documentation/mcp.md  →  mikser-io-mcp/documentation/mcp.md
mikser-io/documentation/decisions/0008-...md  →  mikser-io-mcp/documentation/decisions/0008-...md
```

`mikser-io/README.md` gets a short pointer in the "Built for AI-assisted development" section: "Install [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp) to add MCP server capabilities."

`mikser-io/documentation/decisions/README.md`: ADR-0008's row stays in the table but the link points cross-repo to `mikser-io-mcp/documentation/decisions/0008-…md`. ADRs that reference 0008 (currently none, but I'll grep) keep working with the cross-repo link.

`mikser-io-mcp/README.md` evolves from scaffold-flavored to "this is the actual MCP plugin": install, config-driven activation (no `--mcp` flag), endpoint config, ADR pointer.

## Order of operations

The big risk is breaking the test+smoke suite mid-way. Order minimizes the window of broken state:

1. **Copy MCP files to mcp plugin** (don't delete originals yet). The plugin becomes self-contained and runnable in isolation.
2. **Wire the plugin as a working entry** — its tests pass standalone (`cd mikser-io-mcp && npm test`).
3. **Patch mikser-io core to consume the plugin** — file: dependency on `../mikser-io-mcp`. Plugin loaded. Engine's old MCP code still runs in parallel — if both run, second one wins. Tests should still pass.
4. **Remove duplicated code from core** — delete `src/mcp.js`, strip preview.js, remove engine.js MCP plumbing, remove `--mcp` flag. Tests for stripped-out features still pass (they moved to mcp plugin).
5. **Move docs** — `git mv` to preserve history where possible.
6. **Final test suite both repos** — 350 total tests still pass.
7. **Commit per repo** — mikser-io commit explains the extraction; mikser-io-mcp commit is "Phase 2: substrate + MCP-UI migration".
8. **Publish ordering**: `mikser-io-mcp@0.2.0` first (so consumers can install it), then `mikser-io@8.2.0` (which removes the in-core MCP). Until both are published, `--legacy-peer-deps` covers the gap.

## Rollback

If anything blows up mid-execution:
- Step 1-2 — purely additive; just delete `mikser-io-mcp` contents and reset to scaffold
- Step 3 — revert mikser-io's `file:` reference + plugins array config
- Step 4-5 — `git reset --hard` per repo; the deletions and moves are reversible
- Step 6-7 — only locally; nothing pushed yet
- Step 8 — npm `deprecate` if a bad publish escaped

The risk window where it'd be hard to undo is "between mikser-io-mcp 0.2.0 publish and mikser-io 9.0.0 publish if external users had already installed both." That window is fine because we publish in order — by the time 9.0.0 is out, anyone installing the pair gets a coherent set.

## Open / soft questions (not blockers)

- **Should `mikser-io-mcp` ship the worked examples in its docs?** Current `mcp.md` has 7 worked layouts. Maybe extract them into `mikser-io-mcp/examples/` instead of leaving them inline.
- **`mikser-io-mcp` testing dependency on mikser-io core types.** The plugin needs `core: { runtime, onLoaded, useLogger, findEntities, findEntity, ... }`. Some of these have shapes that come from mikser-io. Easiest: import the helper types from mikser-io. Real fix would be: mikser-io publishes a small plugin-types package. Out of scope for Phase 2.
- **The `mikser-io-render-hbs` ghost reference** in SDK examples (from the earlier rename pass) — unrelated, but flagging it lives nearby in the workspace cleanup list.

## Estimated work

Concrete time, given each step is mechanical:

| Step | Estimate |
|---|---|
| 1 — copy files into mcp plugin | 30 min |
| 2 — wire plugin + standalone tests | 45 min |
| 3 — patch core to consume plugin | 20 min |
| 4 — strip mikser-io core | 30 min |
| 5 — docs moves | 15 min |
| 6 — full test pass both repos | 20 min |
| 7 — commits per repo | 15 min |
| 8 — publish (waits on user approval) | — |

**~2.5 hours of focused work.** Doable in one session.

## Confirmed decisions

- Activation: `'mcp'` first in `plugins: [...]` array; no `--mcp` CLI flag
- CORS: engine adopts `cors` npm package; plugin contributes via `runtime.options.cors{Allow,Expose}Headers`
- Docs: move to `mikser-io-mcp/documentation/`
- Version bumps: `mikser-io-mcp@0.2.0` (scaffold → real), `mikser-io@8.2.0` (minor with release notes documenting the `--mcp` removal and the embedder-import path change)

## What I need from you to start executing

One thing: a final go-ahead. The plan covers the architectural decisions; I'll execute steps 1-7 in one focused session, leaving step 8 (publish) for you to gate.
