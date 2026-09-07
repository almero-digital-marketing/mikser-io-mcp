// The preview-render tool for mikser-io-mcp: render an entity through the
// pipeline and hand back a URL that serves the FINAL output — PDF for a
// `*.html-pdf.*` layout, MJML-derived HTML for `*.html-mjml.*`, whatever the
// chain produced.
//
// The cache itself lives in mikser-io's preview plugin (the `preview`
// service: {store, get, stats, config}). This module reaches it through that
// surface — no cross-plugin imports.
//
// The MCP Apps surface used to live here too, under the mcp-ui vocabulary
// (`mcpUi` frontmatter, mikser_preview_ui, mikser_ui_action, a ui:// shell).
// It moved to mikser-io-mcp-app, which serves it on its own route: an app
// host wants an endpoint whose tool list is the app surface, and the action
// tool is app-callable by spec and must not appear on the agent's endpoint.
// This package keeps the substrate those registrations mount on — see
// `substrate.mountEndpoint` and `endpoints:` scoping in index.js.
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { useRenderer, mimeForEntity, useService } from 'mikser-io'

// Plugin function — invoked by mikser-io-mcp/index.js's factory after the
// substrate is set up. Registers the preview-render tool, which asks core for
// the preview service.
//
// Not a default export plugin in the mikser sense — this is internal
// composition. The mcp plugin's index.js is what mikser loads; this
// file is just an organization unit.
export default ({
    runtime,
    onLoaded,
    useLogger,
}) => {
    onLoaded(() => {
        // Asked for from a hook, so every factory has run — including this
        // package's own, which provides it.
        const mcp = useService('mcp')
        if (!mcp) return
        const { render: previewRender } = useRenderer(runtime, {
            defaultTimeout: runtime.config.preview?.renderTimeout ?? 30_000,
        })

        // mikser_preview_render — render an entity through the pipeline,
        // stash the bytes in the in-memory preview cache (provided by
        // mikser-io core's preview plugin, offered as the `preview` service),
        // and return a clickable URL. Requires --server (or any
        // engine-supplied Express app) so the URL is reachable.
        mcp.simpleTool(
            'mikser_preview_render',
            'Render an entity through the engine pipeline AND surface the FINAL output as a clickable URL served by the running --server. Use this instead of mikser_render when the user needs to see the result in a browser. The URL serves the pipeline\'s final output — PDF for a `*.html-pdf.*` layout, MJML-derived HTML for `*.html-mjml.*`, etc. Requires --server. Previews live in memory (not on disk, never under outputFolder) and auto-expire — default 10 minutes, clamped 30..3600 seconds.',
            {
                entity:  z.record(z.any()).describe('Entity shape with at least { id, collection } and any meta/content the renderer needs. Same shape as mikser_render.'),
                options: z.record(z.any()).optional().describe('Renderer options. Same as mikser_render, plus { expiresInSeconds: number = 600 } controlling preview TTL.'),
            },
            async ({ entity = {}, options = {} }) => {
                const logger = useLogger()
                const preview = useService('preview')
                const ok = (data) => ({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
                })
                const fail = (msg) => ({
                    isError: true,
                    content: [{ type: 'text', text: msg }],
                })

                try {
                    // Origin: prefer the engine's public URL (--url /
                    // config.url) — that's what an external MCP client
                    // (Claude Desktop, Inspector, anyone not on this
                    // box) can actually reach. Fall back to localhost
                    // when only a port is known (dev / loopback agent).
                    const origin = runtime.options.url
                        ?? (runtime.options.port ? `http://localhost:${runtime.options.port}` : null)
                    if (!origin) {
                        return fail('mikser_preview_render requires either --url <public-url> or --server to be set so the preview URL is reachable. Use mikser_render to get raw bytes inline instead.')
                    }
                    if (!preview) {
                        return fail('mikser_preview_render requires the preview cache. Ensure the preview plugin from mikser-io core is in your plugins array.')
                    }

                    const cfg = preview.config()
                    const { expiresInSeconds = cfg.defaultTtl, ...renderOptions } = options ?? {}
                    const { output, entity: rendered } = await previewRender(entity, {
                        ...renderOptions,
                        save: false,
                        catalog: false,
                    })
                    const result = output?.result
                    if (result == null) {
                        return fail('Render produced no output. Check that the entity has a resolvable layout and the layout matched a registered renderer.')
                    }

                    const destExt = path.extname(rendered.destination || '').slice(1)
                    const ext = destExt || 'html'
                    const filename = `${randomUUID()}.${ext}`
                    const mime = mimeForEntity(rendered) ?? 'application/octet-stream'
                    const ttlSec = Math.max(cfg.ttlMin, Math.min(cfg.ttlMax, expiresInSeconds))

                    preview.store({ filename, bytes: result, mime, ttlMs: ttlSec * 1000 })

                    const url = `${origin}${cfg.path}/${filename}`
                    const bytes = Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result)

                    logger.debug('MCP mikser_preview_render cached %s (%d bytes, ttl %ds): %s', filename, bytes, ttlSec, url)

                    return ok({
                        previewUrl: url,
                        mimeType: mime,
                        bytes,
                        expiresInSeconds: ttlSec,
                        instructions: 'Open previewUrl in a browser to view. The preview lives in mikser memory and auto-expires after expiresInSeconds — re-run mikser_preview_render to refresh.',
                    })
                } catch (err) {
                    logger.error('MCP mikser_preview_render error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        const logger = useLogger()
        logger.debug('MCP tools registered: mikser_preview_render (mcp plugin)')
    })
}
