# mikser-io-mcp

MCP (Model Context Protocol) substrate and tools for [mikser-io](https://github.com/almero-digital-marketing/mikser-io), extracted from core into its own package so MCP can iterate on its own release cadence without forcing a mikser-io version bump on every change.

## Status

**Scaffold.** The plugin loads cleanly but exposes nothing yet. Functionality is being migrated here from `mikser-io/src/mcp.js` (the substrate, the HTTP transport, the built-in `mikser://` resources, `mikser_ping`) and from `mikser-io/src/plugins/preview.js` (the MCP-UI half: the `ui://mikser/preview-ui-shell` resource, `mikser_preview_ui`, `mikser_ui_action`, `forwardToHandler`).

While that migration is in progress, mikser's MCP still lives in core and works there. This package exists so the new home is reserved and importable.

## Why a separate package?

Three reasons, in order of weight:

1. **Release cadence.** MCP — and especially the MCP Apps spec — is iterating faster than mikser's core engine. A spec bump or a tool reshape shouldn't force a mikser-io patch / minor / major release. With MCP as a plugin, the engine stays stable while MCP moves.
2. **Optional.** Not every mikser project needs MCP. Keeping it in core meant every install paid for the [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) dependency and its transitive deps; as a plugin it's opt-in.
3. **Scoped review.** When something changes in MCP-land (a new spec extension, a host bug), the diff lives in one place and reviewers know the surface area.

## When it's done

```js
// mikser.config.js
export default {
  plugins: [
    'documents',
    'files',
    'layouts',
    // ... your renderers
    'mcp',          // ← the plugin (this package)
  ],
  mcp: {
    base: '/mcp',
    endpoints: {
      // same shape as mikser's current mcp.endpoints config
    },
  },
}
```

CLI flags (`--mcp`, `--mcp <path>`) and the `runtime.options.mcp` substrate API will be preserved.

## Roadmap

- **Phase 1** — scaffold (this commit). Empty plugin, loads cleanly.
- **Phase 2** — migrate the substrate (`createMcpSubstrate`, `mountMcpOnExpress`, `wireLoggerToMcp`, built-in `mikser://` resources, `mikser_ping`) from mikser-io core.
- **Phase 3** — migrate the MCP-UI surface (`ui://mikser/preview-ui-shell`, `mikser_preview_ui`, `mikser_ui_action`, `forwardToHandler`) from `mikser-io`'s preview plugin.
- **Phase 4** — drop the MCP code from mikser-io core. Pick a hard cut (`mikser-io 9.0.0`) or a transition window where both work.

## License

MIT. See [LICENSE](./LICENSE).
