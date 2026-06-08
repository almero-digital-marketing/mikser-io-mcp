// mikser-io-mcp
//
// MCP (Model Context Protocol) substrate and tools for mikser-io,
// extracted from core so MCP can iterate on its own release cadence
// without bumping mikser-io's major version every time the MCP Apps
// spec or any of mikser's MCP tools change.
//
// Scaffold / empty plugin: this loads cleanly when included in a
// mikser project's plugin list but exposes nothing. Functionality
// will migrate here from `mikser-io/src/mcp.js` and
// `mikser-io/src/plugins/preview.js` (the MCP-UI half) over time.
//
// Roadmap (rough; see README.md):
//   - Phase 1: scaffold (this commit) — empty plugin, loads cleanly.
//   - Phase 2: migrate the MCP substrate (createMcpSubstrate,
//     mountMcpOnExpress, wireLoggerToMcp, the built-in mikser://
//     introspection resources, mikser_ping) from mikser-io core.
//   - Phase 3: migrate the MCP-UI half (preview-ui-shell resource,
//     mikser_preview_ui, mikser_ui_action, forwardToHandler) from
//     mikser-io's preview plugin.
//   - Phase 4: drop the MCP code from mikser-io core; bump core to
//     declare it works with both the in-core and the plugin versions
//     during the transition (or pick a hard cut).
//
// Until the migration starts, mikser's MCP still lives in core and
// is fully functional from there. This package exists so the new
// home is reserved and importable.

export default ({
    runtime,
    onLoaded,
    useLogger,
}) => {
    onLoaded(() => {
        const logger = useLogger?.()
        logger?.debug('mikser-io-mcp loaded (scaffold; no functionality yet — see README)')
    })

    return { name: 'mcp' }
}
