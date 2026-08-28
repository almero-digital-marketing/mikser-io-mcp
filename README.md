# mikser-io-mcp

MCP (Model Context Protocol) substrate and tools for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Ships as a plugin (not in core) so MCP can iterate on its own release cadence without forcing a mikser-io version bump on every change.

## What it ships

- **The MCP substrate** — `createMcpSubstrate`, per-session McpServer + transport via `mountMcpOnExpress`, the pino-to-MCP log bridge `wireLoggerToMcp`. Other plugins compose against `runtime.options.mcp` to register their own tools and resources.
- **Built-in resources** — `mikser://config`, `mikser://lifecycle`, `mikser://logs`, `mikser://server`. Read-only introspection any MCP client can use.
- **Built-in tools**
  - *Catalog* — `mikser_query_entities`, `mikser_read_entity`, `mikser_update_entity`, `mikser_delete_entity`, `mikser_render`, over the engine's public catalog API.
  - *Finding things* — `mikser_search` locates a string across entity meta, source files, and (with `in: ["output"]`) the BUILT files, reporting occurrences per page — and with `attribute: true`, which source emitted each hit. That is how you find content you can only describe by what it says, and how you size a change to anything shared before making it.
  - *Working backwards* — `mikser_which` takes a built destination and returns the source that produced it: the field path and line/column a value was written at, or the line a CSS selector is declared on. Each answer is labelled by how it was reached — `meta-field` and `source-content` are RECORDED (the engine's own `refClosure` says this render consumed that entity, and the position comes from parsing its source), `scan` is not. It reaches values that appear nowhere in a page's own document, which is most of a shared nav or footer.
  - *References* — `mikser_refs_inbound` / `mikser_refs_outbound` / `mikser_refs_broken` / `mikser_refs_rename`, from `runtime.refs`.
  - *Diagnostics* — `mikser_explain` (why an entity did or did not re-render), `mikser_build_report` (what a cycle did, with history), `mikser_verify` (output folder vs. recorded snapshots), `mikser_read_output` (the bytes currently on disk for a destination).
  - *Layouts* — `mikser_layouts_inspect` (template + variables + sample entities), registered by `mikser-io-layouts` itself.
  - *Liveness* — `mikser_ping`, which also reports how the caller is authenticated and when that credential expires.
- **The MCP-UI surface** — `ui://mikser/preview-ui-shell` resource (MCP Apps spec shell), `mikser_preview_ui` (render an entity's `mcpUi` layout to the spec), `mikser_ui_action` (action delivery + optional HMAC-signed webhook forwarding), `mcp-ui/modes` resource for layout discovery, plus `mikser_preview_render` for rendering an entity through the pipeline and returning a clickable preview URL.

## Also reachable from the CLI

Every tool here is registered into the **engine's** registry
(`mikser-io`'s `registerTool`), not only into this plugin's session
surface. So an agent that runs the CLI and reads its output asks the same
questions as one speaking MCP:

```bash
npx mikser --tool mikser_which --tool-args '{"destination":"/bg/index.html","text":"Контакти"}'
```

`npx mikser --tools` lists them. stdout carries only the tool's result, so
piping into `jq` works; exit status is 0 / 1 (the tool reported an error) /
3 (no such tool, or bad `--tool-args`). See mikser-io's
`docs/diagnostics.md` under "The two agent workflows".

## Editing content

`mikser_update_entity` writes the WHOLE file — there is no partial-edit or
patch mode. Three fields make that safe to do without a shell on the box:

```js
const page = await mikser_read_entity({ id: '/styles/tokens/buttons.css', include: ['content', 'positions'] })
// page.positions says where each meta field was written —
//   { 'items[2].label': { line: 7, col: 13 } } — so a value can be cited or
//   found again without scanning the file for it.
// page.contentComplete tells you whether `content` is the whole file or a
// truncated copy. Never write back from a truncated read.
// page.advisories names a file you must not edit blind — see below.

// What would this edit reach? Writes nothing.
await mikser_update_entity({ id: '/styles/tokens/buttons.css', dryRun: true })
// → wouldAffect: [{ destination: '/bg/styles/site.css', reason: 'query-matched',
//                   matched: { filter: {collection:'styles'}, by: '/styles/tokens/buttons.css' } }, …]

await mikser_update_entity({
    id: '/styles/tokens/buttons.css',   // or collection + relativePath
    content: edited,
    ifChecksum: page.checksum,   // refuse the write if the file moved since the read
    await: true,                 // block until the cycle picks it up, return its report
})
```

Every tool takes and returns ids, and `update_entity` accepts one too — the
`collection` + `relativePath` pair still works, but a caller that just read or
searched an entity holds the id, and splitting it back into parts is a guess
(the prefix is configurable and the extension may have been stripped). Given an
`id`, the file location comes from the entity itself.

- **`ifChecksum`** makes the write conditional. On mismatch the write is
  refused and `currentChecksum` comes back, so a whole-file rewrite built
  from a stale copy cannot silently discard someone else's edit.
- **`await: true`** returns the build report for the cycle that picked the
  write up, so one call answers "what did my edit change" instead of
  writing and guessing. The response always carries `cycleId`, whether or
  not you wait; `mikser_build_report({ cycles: n })` reads back the last
  `n` finished cycles.
- **`siblingDestinations`** names files beside this one that differ only by
  extension — the `index.md` sitting next to `index.yml`, both rendering to
  `/bg/index.html`, one silently discarding the other. It is a heuristic
  and says so; `mikser_explain` and `mikser_verify` carry the authoritative
  answer once a cycle has run.
- **`dryRun: true`** writes nothing and returns `wouldAffect`: every
  destination the edit would re-render, each carrying the same `reason` the
  build report uses, so "why this one" is answered alongside "how many".
  Computed by running the engine's own skip rule, which is what stops the
  preview from disagreeing with the cycle. It cannot model a change to the
  file's own frontmatter, which is parsed at import and can move the
  destination itself.
- **`advisories`** surface a file you must not edit blind, as data rather
  than a comment you had to read far enough to find. Two kinds:
  `spec-locked` (the bytes answer to a document outside the repo) and
  `generated` (the next build overwrites this; edit its source). Declared
  either through `meta.specLocked` / `meta.generated`, or by a header line
  in the first 40 lines — `Spec source: …`, `Generated by …`, `Do not edit`
  — which is the only form available to a `.css` or `.js` file with no meta
  at all. Reported on read AND echoed on write, because the caller who most
  needs telling is the one who never read the file.

## Install

```bash
npm install mikser-io-mcp
```

Peer dependencies: `mikser-io ^9.0.0`, `zod ^4.0.0`.

## Activate

Import the `mcp` factory and call it **first** in your mikser project's plugins array — the closure runs synchronously and creates `runtime.options.mcp` so any plugins that register tools (api, layouts, refs, vector, etc.) can gate on it at their own `onLoaded` hook:

```js
// mikser.config.js
import { mcp } from 'mikser-io-mcp'

export default {
    plugins: [
        mcp({
            path: '/mcp',          // optional; default '/mcp' (also serves as the base for `endpoints` below)
            endpoints: { /* … */ } // optional; same shape as the in-core era
        }),
        /* … your other plugins */
    ],
}
```

Calling `mcp()` with no options is a no-op activation — the factory runs but creates no substrate and mounts no transport. To skip MCP entirely, leave the factory call out of `plugins`.

Run mikser with `--server`; the MCP transport mounts at the configured path on the same Express server the api / preview / data plugins use.

## Register with a client

Once the plugin is installed in your mikser project, the package ships a CLI you can invoke via `npx` to connect MCP-speaking clients. Connector name + description are read automatically from the project's `package.json`.

### Claude Desktop

```bash
npx mikser-io-mcp register claude                                  # default URL http://localhost:3001/mcp
npx mikser-io-mcp register claude --url http://localhost:4000/mcp  # custom port
npx mikser-io-mcp register claude --dry-run                        # show what would change
npx mikser-io-mcp register claude --force                          # overwrite a different existing entry
npx mikser-io-mcp register claude --unregister                     # remove the entry
```

Writes a `mcpServers` entry into Claude Desktop's per-OS config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

The entry launches `supergateway` (npx-installed on demand) as a stdio→streamable-HTTP bridge to your running mikser server. Fully quit + reopen Claude Desktop after registering.

### ChatGPT

```bash
npx mikser-io-mcp register chatgpt --url https://YOUR-TUNNEL.example/mcp
```

ChatGPT's MCP integration is server-side — OpenAI's servers connect to your MCP endpoint directly. `localhost` is unreachable; you must expose mikser via a public tunnel (`ngrok http 3001`, Cloudflare Tunnel, etc.) before running this.

The script doesn't write a file (ChatGPT has no local config). It prints the three fields (Name, Description, MCP Server URL) you paste into ChatGPT's UI: Settings → Connectors → Advanced → Developer mode → Create.

Notes:
- ChatGPT Developer mode + custom MCP connectors are **beta** and require a Plus / Pro / Business / Enterprise / Edu account.
- Connectors don't auto-enable per chat — toggle on each new conversation.

## Documentation

- [Full MCP tour, twelve worked scenarios, every tool and resource](./documentation/mcp.md)
- [ADR-0008 — MCP-UI rendering and action delivery](./documentation/decisions/0008-mcp-ui-action-delivery.md)

## License

MIT. See [LICENSE](./LICENSE).
