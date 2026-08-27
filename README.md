# mikser-io-mcp

MCP (Model Context Protocol) substrate and tools for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Ships as a plugin (not in core) so MCP can iterate on its own release cadence without forcing a mikser-io version bump on every change.

## What it ships

- **The MCP substrate** — `createMcpSubstrate`, per-session McpServer + transport via `mountMcpOnExpress`, the pino-to-MCP log bridge `wireLoggerToMcp`. Other plugins compose against `runtime.options.mcp` to register their own tools and resources.
- **Built-in resources** — `mikser://config`, `mikser://lifecycle`, `mikser://logs`, `mikser://server`. Read-only introspection any MCP client can use.
- **Built-in tools**
  - *Catalog* — `mikser_query_entities`, `mikser_read_entity`, `mikser_update_entity`, `mikser_delete_entity`, `mikser_render`, over the engine's public catalog API.
  - *Finding things* — `mikser_search` locates a string across entity meta and source files in one call, which is how you find content you can only describe by what it says.
  - *References* — `mikser_refs_inbound` / `mikser_refs_outbound` / `mikser_refs_broken` / `mikser_refs_rename`, from `runtime.refs`.
  - *Diagnostics* — `mikser_explain` (why an entity did or did not re-render), `mikser_build_report` (what a cycle did, with history), `mikser_verify` (output folder vs. recorded snapshots), `mikser_read_output` (the bytes currently on disk for a destination).
  - *Layouts* — `mikser_layouts_inspect` (template + variables + sample entities), registered by `mikser-io-layouts` itself.
  - *Liveness* — `mikser_ping`, which also reports how the caller is authenticated and when that credential expires.
- **The MCP-UI surface** — `ui://mikser/preview-ui-shell` resource (MCP Apps spec shell), `mikser_preview_ui` (render an entity's `mcpUi` layout to the spec), `mikser_ui_action` (action delivery + optional HMAC-signed webhook forwarding), `mcp-ui/modes` resource for layout discovery, plus `mikser_preview_render` for rendering an entity through the pipeline and returning a clickable preview URL.

## Editing content

`mikser_update_entity` writes the WHOLE file — there is no partial-edit or
patch mode. Three fields make that safe to do without a shell on the box:

```js
const page = await mikser_read_entity({ id: '/documents/bg/system/navigation.yml', include: ['content'] })
// page.contentComplete tells you whether `content` is the whole file or a
// truncated copy. Never write back from a truncated read.

await mikser_update_entity({
    collection: 'documents',
    relativePath: 'bg/system/navigation.yml',
    content: edited,
    ifChecksum: page.checksum,   // refuse the write if the file moved since the read
    await: true,                 // block until the cycle picks it up, return its report
})
```

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
