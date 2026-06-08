# mikser-io-mcp

MCP (Model Context Protocol) substrate and tools for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Ships as a plugin (not in core) so MCP can iterate on its own release cadence without forcing a mikser-io version bump on every change.

## What it ships

- **The MCP substrate** — `createMcpSubstrate`, per-session McpServer + transport via `mountMcpOnExpress`, the pino-to-MCP log bridge `wireLoggerToMcp`. Other plugins compose against `runtime.options.mcp` to register their own tools and resources.
- **Built-in resources** — `mikser://config`, `mikser://lifecycle`, `mikser://logs`, `mikser://server`. Read-only introspection any MCP client can use.
- **Built-in tools** — `mikser_ping` (liveness + identity), `mikser_query_entities` / `mikser_read_entity` / `mikser_update_entity` / `mikser_delete_entity` / `mikser_render` (catalog CRUD + render over the engine's public catalog API), `mikser_refs_inbound` / `mikser_refs_outbound` / `mikser_refs_broken` / `mikser_refs_rename` (reverse-reference graph from `runtime.refs`), `mikser_layouts_inspect` (template + variables + sample entities for a layout).
- **The MCP-UI surface** — `ui://mikser/preview-ui-shell` resource (MCP Apps spec shell), `mikser_preview_ui` (render an entity's `mcpUi` layout to the spec), `mikser_ui_action` (action delivery + optional HMAC-signed webhook forwarding), `mcp-ui/modes` resource for layout discovery, plus `mikser_preview_render` for rendering an entity through the pipeline and returning a clickable preview URL.

## Install

```bash
npm install mikser-io-mcp
```

Peer dependencies: `mikser-io ^8.2.0`, `zod ^4.0.0`.

## Activate

Add `'mcp'` to your mikser project's plugins array. **List it FIRST** — the plugin factory creates `runtime.options.mcp` synchronously so any plugins that register tools (api, layouts, refs, vector, etc.) can gate on it at their own `onLoaded` hook:

```js
// mikser.config.js
export default {
    plugins: ['mcp', /* … your other plugins */],
    mcp: {
        path: '/mcp',          // optional; default '/mcp' (also serves as the base for `endpoints` below)
        endpoints: { /* … */ } // optional; same shape as the in-core era
    },
}
```

If `runtime.config.mcp` is absent the plugin runs as a no-op (loads but creates no substrate, mounts no transport). That lets you list `'mcp'` in plugins without forcing config.

Run mikser with `--server`; the MCP transport mounts at the configured path on the same Express server the api / preview / data plugins use.

## Documentation

- [Full MCP tour, twelve worked scenarios, every tool and resource](./documentation/mcp.md)
- [ADR-0008 — MCP-UI rendering and action delivery](./documentation/decisions/0008-mcp-ui-action-delivery.md)

## License

MIT. See [LICENSE](./LICENSE).
