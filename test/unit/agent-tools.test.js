import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime } from 'mikser-io'
import { createHarness } from './plugin-harness.js'
import { mcp } from '../../index.js'

// The tools an agent drives when it edits content are the ones that have to
// answer honestly about disk: what a file currently holds, what is deployed
// for it, and who else writes to the same place. Stubbing the filesystem
// would take exactly that away, so these run against a real working folder
// and a catalog stub whose entities point into it.

let wd
let tools
let inbound = []

// Boot the plugin the way the engine does — factory, then the onLoaded
// hooks — with a recorder attached to the substrate before the hooks run,
// so every simpleTool call live-replays onto it and we get the REAL
// handlers rather than reimplementations of them.
function bootPlugin() {
    const harness = createHarness({ options: { workingFolder: wd } })
    runtime.options.workingFolder   = wd
    runtime.options.documentsFolder = path.join(wd, 'documents')
    runtime.options.outputFolder    = path.join(wd, 'out')
    runtime.engine = { logger: harness.logger }
    runtime.refs = {
        inboundFor:  () => inbound,
        outboundFor: () => [],
        allRefs:     () => [],
        size:        () => ({}),
    }

    mcp({})(harness.core)

    const recorder = {
        byName: new Map(),
        registerTool(name, def, handler) { this.byName.set(name, { def, handler }) },
        registerResource() {},
        registerPrompt() {},
        async sendLoggingMessage() {},
    }
    runtime.options.mcp.attach(recorder)
    return { harness, recorder }
}

// Handlers return the MCP content envelope; every one of these tools puts a
// single JSON text block in it.
function payload(result) {
    assert.ok(result?.content?.[0]?.text, 'expected a text content block')
    return JSON.parse(result.content[0].text)
}

const call = (name, args = {}) => tools.get(name).handler(args)

before(async () => {
    wd = await mkdtemp(path.join(tmpdir(), 'mikser-mcp-tools-'))
    await mkdir(path.join(wd, 'documents/bg/system'), { recursive: true })
    await mkdir(path.join(wd, 'out/bg'), { recursive: true })
    await mkdir(path.join(wd, 'out/img'), { recursive: true })

    // Two files with the same stem, the shape that silently overwrites.
    await writeFile(path.join(wd, 'documents/bg/index.md'), '')
    await writeFile(path.join(wd, 'documents/bg/index.yml'), 'href: /bg/index\ntitle: Начало\n')
    // The same label in two places — the case where finding only the first
    // one leaves a live page still saying the old thing.
    await writeFile(path.join(wd, 'documents/bg/system/navigation.yml'),
        'items:\n  - label: За нас\n    href: /about\n')
    await writeFile(path.join(wd, 'documents/bg/system/footer.yml'),
        'columns:\n  - links:\n      - label: За нас\n        href: /about\n')
    await writeFile(path.join(wd, 'out/bg/index.html'), '<html><body>Начало</body></html>')
    await writeFile(path.join(wd, 'out/img/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))

    const { harness, recorder } = bootPlugin()
    // The catalog stub the search tool walks. `uri` points at the real
    // files, which is what makes the content scope readable.
    const entities = [
        { id: '/documents/bg/index.yml', collection: 'documents',
          uri: path.join(wd, 'documents/bg/index.yml'),
          meta: { href: '/bg/index', title: 'Начало' } },
        { id: '/documents/bg/system/navigation.yml', collection: 'documents',
          uri: path.join(wd, 'documents/bg/system/navigation.yml'),
          meta: { items: [{ label: 'За нас', href: '/about' }] } },
        { id: '/documents/bg/system/footer.yml', collection: 'documents',
          uri: path.join(wd, 'documents/bg/system/footer.yml'),
          meta: { columns: [{ links: [{ label: 'За нас', href: '/about' }] }] } },
        // A binary the content scope must skip rather than utf8-decode.
        { id: '/files/img/logo.png', collection: 'files',
          uri: path.join(wd, 'out/img/logo.png'),
          meta: { url: '/img/logo.png' } },
    ]
    runtime.catalog.byId = new Map(entities.map(e => [e.id, e]))
    runtime.catalog.entities = entities
    runtime.catalog.findEntities = async (query) =>
        (query?.collection ? entities.filter(e => e.collection === query.collection) : entities)

    for (const cb of harness.hooks.loaded) await cb()
    tools = recorder.byName
})

after(async () => {
    if (wd) await rm(wd, { recursive: true, force: true })
})

describe('mikser_search', () => {
    it('finds every entity carrying the string, not just the first', async () => {
        const res = payload(await call('mikser_search', { query: 'За нас' }))
        const ids = [...new Set(res.hits.map(h => h.id))].sort()
        assert.deepEqual(ids, ['/documents/bg/system/footer.yml', '/documents/bg/system/navigation.yml'])
    })

    it('names the meta field path, so a hit is directly addressable', async () => {
        const res = payload(await call('mikser_search', { query: 'За нас', in: ['meta'] }))
        const fields = res.hits.map(h => h.field).sort()
        assert.deepEqual(fields, ['columns[0].links[0].label', 'items[0].label'])
    })

    it('reads source files when asked for the content scope', async () => {
        // `items:` is in navigation.yml's bytes and in no other file's.
        const res = payload(await call('mikser_search', { query: 'items:', in: ['content'] }))
        assert.equal(res.count, 1)
        assert.equal(res.hits[0].where, 'content')
        assert.equal(res.hits[0].id, '/documents/bg/system/navigation.yml')

        // The same query restricted to meta finds nothing — `items` is a
        // KEY there, not a value, and the meta scope walks leaf values.
        assert.equal(payload(await call('mikser_search', { query: 'items:', in: ['meta'] })).count, 0)
    })

    it('skips binaries rather than utf8-decoding them', async () => {
        // \x89PNG is in logo.png's bytes; a decode-everything search would
        // report it. The hit list must not name a .png.
        const res = payload(await call('mikser_search', { query: 'PNG', in: ['content'] }))
        assert.equal(res.hits.filter(h => h.id.endsWith('.png')).length, 0)
    })

    it('is case-sensitive by default and case-insensitive on request', async () => {
        assert.equal(payload(await call('mikser_search', { query: 'НАЧАЛО' })).count, 0)
        assert.ok(payload(await call('mikser_search', { query: 'НАЧАЛО', ignoreCase: true })).count > 0)
    })

    it('treats query as a regular expression under regex: true', async () => {
        const res = payload(await call('mikser_search', { query: '^/about$', regex: true, in: ['meta'] }))
        assert.equal(res.count, 2)
    })

    it('reports an invalid regex instead of throwing', async () => {
        const res = await call('mikser_search', { query: '([', regex: true })
        assert.equal(res.isError, true)
        assert.match(res.content[0].text, /invalid regex/)
    })

    it('says when it stopped early rather than implying the list is complete', async () => {
        const res = payload(await call('mikser_search', { query: 'За нас', limit: 1 }))
        assert.equal(res.count, 1)
        assert.equal(res.truncated, true)
    })

    it('returns a snippet with context around the match, not the whole file', async () => {
        const res = payload(await call('mikser_search', { query: 'За нас', in: ['content'] }))
        for (const hit of res.hits) {
            assert.ok(hit.snippet.includes('За нас'))
            assert.ok(hit.snippet.length < 200)
        }
    })
})

describe('mikser_read_output', () => {
    it('returns the bytes on disk for a destination', async () => {
        const res = payload(await call('mikser_read_output', { destination: '/bg/index.html' }))
        assert.equal(res.exists, true)
        assert.equal(res.binary, false)
        assert.equal(res.content, '<html><body>Начало</body></html>')
        assert.equal(res.bytes, Buffer.byteLength('<html><body>Начало</body></html>'))
    })

    it('reports a binary output rather than decoding it', async () => {
        const res = payload(await call('mikser_read_output', { destination: '/img/logo.png' }))
        assert.equal(res.exists, true)
        assert.equal(res.binary, true)
        assert.equal(res.content, undefined)
        assert.match(res.contentSkipped, /binary output/)
    })

    it('answers "nothing is deployed" instead of erroring on a missing file', async () => {
        const res = payload(await call('mikser_read_output', { destination: '/bg/missing.html' }))
        assert.equal(res.exists, false)
        assert.ok(res.hint)
    })
})

describe('mikser_update_entity', () => {
    it('refuses a stale ifChecksum and hands back the current one', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/system/navigation.yml',
            content: 'items: []\n', ifChecksum: 'stale-checksum-that-is-not-the-file',
        }))
        assert.equal(res.ok, false)
        assert.equal(res.refused, 'checksum-mismatch')
        assert.ok(res.currentChecksum, 'expected the current checksum in the refusal')
        assert.notEqual(res.currentChecksum, 'stale-checksum-that-is-not-the-file')
        assert.match(res.hint, /Re-read it/)
    })

    it('applies the write when ifChecksum matches, and returns the new checksum', async () => {
        const first = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/conditional.yml', content: 'a: 1\n',
        }))
        assert.equal(first.ok, true)

        const second = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/conditional.yml',
            content: 'a: 2\n', ifChecksum: first.checksum,
        }))
        assert.equal(second.ok, true)
        assert.notEqual(second.checksum, first.checksum)

        // The refused checksum from the first write is now stale — the same
        // value that just succeeded must not succeed twice.
        const third = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/conditional.yml',
            content: 'a: 3\n', ifChecksum: first.checksum,
        }))
        assert.equal(third.ok, false)
        assert.equal(third.currentChecksum, second.checksum)
    })

    it('says the file does not exist when ifChecksum is given for a new file', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/brand-new.yml',
            content: 'x: 1\n', ifChecksum: 'anything',
        }))
        assert.equal(res.ok, false)
        assert.equal(res.currentChecksum, null)
        assert.match(res.hint, /does not exist/)
    })

    it('warns about a sibling that may render to the same destination', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/index.yml',
            content: 'href: /bg/index\ntitle: Начало\n',
        }))
        assert.equal(res.ok, true)
        assert.deepEqual(res.siblingDestinations.map(s => s.path), ['bg/index.md'])
        assert.match(res.siblingDestinations[0].note, /same name, different extension/)
    })

    it('reports no siblings for a file whose stem is unique', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/system/navigation.yml',
            content: 'items:\n  - label: За нас\n    href: /about\n',
        }))
        assert.deepEqual(res.siblingDestinations, [])
    })

    it('returns the cycle the write will be picked up by', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/cycle-probe.yml', content: 'p: 1\n',
        }))
        assert.equal(typeof res.cycleId, 'number')
        assert.ok(res.cycleId > 0)
        assert.equal(res.bytes, Buffer.byteLength('p: 1\n'))
    })
})

describe('mikser_refs_inbound', () => {
    it('tags each entry with the kind of reference it found', async () => {
        inbound = [
            { id: '/documents/bg/system/navigation.yml', field: 'items[0].href', kind: 'href' },
            { id: '/documents/bg/system/footer.yml', field: 'columns[0].links[0].href', kind: 'href' },
        ]
        const res = payload(await call('mikser_refs_inbound', { ref: '/about' }))
        assert.equal(res.count, 2)
        assert.deepEqual(res.entries.map(e => e.kind), ['href', 'href'])
    })

    it('states what it does not see, so count: 0 cannot be read as "nothing"', async () => {
        inbound = []
        const res = payload(await call('mikser_refs_inbound', { ref: '/nowhere' }))
        assert.equal(res.count, 0)
        assert.ok(res.coverage, 'expected a coverage block on every response')
        assert.ok(res.coverage.notCovered.some(s => /BODY text/.test(s)))
        assert.ok(res.coverage.notCovered.some(s => /render time/.test(s)))
    })
})
