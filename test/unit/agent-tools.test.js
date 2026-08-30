import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime } from 'mikser-io'
import { createHarness } from './plugin-harness.js'
import { mcp, authContextForTests } from '../../index.js'

// The tools an agent drives when it edits content are the ones that have to
// answer honestly about disk: what a file currently holds, what is deployed
// for it, and who else writes to the same place. Stubbing the filesystem
// would take exactly that away, so these run against a real working folder
// and a catalog stub whose entities point into it.

let wd
let tools
let inbound = []
let snapshots = []
let affected = []

// Boot the plugin the way the engine does — factory, then the onLoaded
// hooks — with a recorder attached to the substrate before the hooks run,
// so every simpleTool call live-replays onto it and we get the REAL
// handlers rather than reimplementations of them.
function bootPlugin() {
    const harness = createHarness({ options: { workingFolder: wd } })
    runtime.options.workingFolder   = wd
    runtime.options.documentsFolder = path.join(wd, 'documents')
    runtime.options.stylesFolder    = path.join(wd, 'styles')
    runtime.options.layoutsFolder   = path.join(wd, 'layouts')
    runtime.options.outputFolder    = path.join(wd, 'out')
    runtime.engine = { logger: harness.logger }
    runtime.refs = {
        inboundFor:  () => inbound,
        outboundFor: () => [],
        allRefs:     () => [],
        size:        () => ({}),
    }
    runtime.manifest = {
        snapshotsAt: (destination) => snapshots.filter(s => s.destination === destination),
        snapshotsFor: (id) => snapshots.filter(s => s.id === id),
        affectedBy: () => affected,
        collisions: () => [],
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

    // A styles collection assembled into one bundle by a catalog query — the
    // shape mikser_which exists for, where the built file names no source and
    // the source names no destination.
    await mkdir(path.join(wd, 'styles/tokens'), { recursive: true })
    await mkdir(path.join(wd, 'styles/sections'), { recursive: true })
    // Header comment first, then the rule. The comment mentions the selector,
    // which is what the definition/mention split has to get right.
    await writeFile(path.join(wd, 'styles/tokens/buttons.css'),
        '/* Buttons\n   Spec source: uploads/spec.pdf — match exactly.\n'
        + '   Variants: .btn--primary and .btn--secondary */\n'
        + '.btn--primary {\n  background: black;\n}\n'
        + '.btn--secondary {\n  background: white;\n}\n')
    // A second file that scopes the same selector rather than defining it —
    // a real second answer, which must be reported and ranked below.
    await writeFile(path.join(wd, 'styles/sections/panel.css'),
        '.panel .btn--secondary {\n  margin: 0;\n}\n')

    // Built pages carrying the class at different weights: one component-heavy
    // page and one that merely links. A list of equal-looking filenames hides
    // exactly that difference.
    await writeFile(path.join(wd, 'out/bg/heavy.html'),
        '<a class="lmed-btn--secondary">a</a><a class="lmed-btn--secondary">b</a><a class="lmed-btn--secondary">c</a>')
    await writeFile(path.join(wd, 'out/bg/light.html'), '<a class="lmed-btn--secondary">only one</a>')

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
        { id: '/styles/tokens/buttons.css', collection: 'styles',
          uri: path.join(wd, 'styles/tokens/buttons.css'), meta: {} },
        { id: '/styles/sections/panel.css', collection: 'styles',
          uri: path.join(wd, 'styles/sections/panel.css'), meta: {} },
        { id: '/layouts/styles.css.liquid', collection: 'layouts',
          uri: path.join(wd, 'layouts/styles.css.liquid'), meta: {} },
        { id: '/documents/bg/styles.yml', collection: 'documents',
          uri: path.join(wd, 'documents/bg/styles.yml'), meta: { layout: 'styles' } },
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

describe('mikser_which — output back to source', () => {
    it('says so plainly when no render claims the destination', async () => {
        snapshots = []
        const res = payload(await call('mikser_which', { destination: '/nothing/here.css' }))
        assert.deepEqual(res.sources, [])
        // A bare empty list reads as "nothing produced this", when the usual
        // cause is a file COPIED there without a render snapshot.
        assert.match(res.hint, /COPIED/)
    })

    it('resolves a recorded catalog query to the parts that went into the bundle', async () => {
        snapshots = [{
            id: '/documents/bg/styles.yml', destination: '/bg/styles/site.css',
            refClosure: [
                { kind: 'layout', target: '/layouts/styles.css.liquid', targetId: '/layouts/styles.css.liquid' },
                { kind: 'query', filter: { collection: 'styles' } },
            ],
        }]
        const res = payload(await call('mikser_which', { destination: '/bg/styles/site.css', selector: '.btn--secondary' }))
        const buttons = res.sources.find(r => r.id === '/styles/tokens/buttons.css')
        assert.ok(buttons, 'expected the query members to be resolved into sources')
        assert.deepEqual(buttons.via, ['query {"collection":"styles"}'])
    })

    it('separates a line the string BEGINS from one where it is mentioned', async () => {
        snapshots = [{ id: '/documents/bg/styles.yml', destination: '/bg/styles/site.css',
                       refClosure: [{ kind: 'query', filter: { collection: 'styles' } }] }]
        const res = payload(await call('mikser_which', { destination: '/bg/styles/site.css', text: '.btn--secondary' }))
        const buttons = res.sources.find(r => r.id === '/styles/tokens/buttons.css')
        // The fixture names the thing in its header comment and then declares
        // it. Position on the line tells them apart with no knowledge of the
        // format: the declaration starts its line, the prose mention does not.
        assert.equal(buttons.occurrences, 2)
        assert.equal(buttons.leading, 1)
        const declaration = buttons.sites.find(site => site.leading)
        assert.ok(declaration.line > 2, 'the header comment must not be the declaration')
        // The line is returned as evidence, so a caller can see the heuristic's
        // input rather than only its verdict.
        assert.match(declaration.text, /^\.btn--secondary/)
    })

    it('ranks the file that declares the string above one that only uses it', async () => {
        snapshots = [{ id: '/documents/bg/styles.yml', destination: '/bg/styles/site.css',
                       refClosure: [{ kind: 'query', filter: { collection: 'styles' } }] }]
        const res = payload(await call('mikser_which', { destination: '/bg/styles/site.css', text: '.btn--secondary' }))
        assert.equal(res.sources[0].id, '/styles/tokens/buttons.css')
        assert.ok(res.sources[0].leading > 0)

        const panel = res.sources.find(r => r.id === '/styles/sections/panel.css')
        // Still reported — a file that only scopes the thing is a real second
        // answer, and hiding it is how a fix lands in the wrong file.
        assert.ok(panel)
        assert.equal(panel.leading, 0, 'the string does not begin its line there')
        assert.equal(panel.occurrences, 1)
    })

    it('lists what produced a destination when given no needle', async () => {
        snapshots = [{ id: '/documents/bg/styles.yml', destination: '/bg/styles/site.css',
                       refClosure: [{ kind: 'layout', target: '/layouts/styles.css.liquid', targetId: '/layouts/styles.css.liquid' }] }]
        const res = payload(await call('mikser_which', { destination: '/bg/styles/site.css' }))
        assert.equal(res.looking, null)
        const ids = res.sources.map(r => r.id).sort()
        assert.deepEqual(ids, ['/documents/bg/styles.yml', '/layouts/styles.css.liquid'])
    })

    it('flags a contested destination rather than silently unioning two renders', async () => {
        snapshots = [
            { id: '/documents/bg/a.yml', destination: '/bg/x.css', refClosure: [] },
            { id: '/documents/bg/b.yml', destination: '/bg/x.css', refClosure: [] },
        ]
        const res = payload(await call('mikser_which', { destination: '/bg/x.css' }))
        assert.equal(res.claimants.length, 2)
        assert.match(res.contested, /More than one entity/)
    })
})

describe('mikser_search in: ["output"]', () => {
    it('counts occurrences per built file and ranks the heaviest first', async () => {
        const res = payload(await call('mikser_search', { query: 'lmed-btn--secondary', in: ['output'] }))
        assert.deepEqual(
            res.hits.map(h => [h.destination, h.occurrences]),
            [['/bg/heavy.html', 3], ['/bg/light.html', 1]])
        assert.equal(res.hits[0].where, 'output')
    })

    it('does not search the catalog when only the output scope is asked for', async () => {
        // The two answer different questions: a string can be in the output
        // because a layout writes it, with no source entity containing it.
        const res = payload(await call('mikser_search', { query: 'lmed-btn--secondary', in: ['output'] }))
        assert.equal(res.searched, 0)
        assert.ok(res.hits.every(h => h.where === 'output'))
    })

    it('is never implied by the default scopes', async () => {
        const res = payload(await call('mikser_search', { query: 'lmed-btn--secondary' }))
        assert.equal(res.hits.filter(h => h.where === 'output').length, 0)
    })

    it('skips binary output rather than decoding it', async () => {
        const res = payload(await call('mikser_search', { query: 'PNG', in: ['output'] }))
        assert.equal(res.hits.filter(h => h.destination.endsWith('.png')).length, 0)
    })
})

describe('advisories — a marker that works without reading the file', () => {
    it('reads a spec lock out of the header and names where it said so', async () => {
        const res = payload(await call('mikser_read_entity', { id: '/styles/tokens/buttons.css', include: ['content'] }))
        assert.deepEqual(res.advisories, [{
            kind: 'spec-locked',
            detail: 'uploads/spec.pdf — match exactly.',
            via: 'header',
            line: 2,
        }])
        assert.match(res.warning, /SPEC-LOCKED/)
    })

    it('echoes the lock on the way OUT, for a caller that never read the file', async () => {
        const before = payload(await call('mikser_read_entity', { id: '/styles/tokens/buttons.css', include: ['content'] }))
        const res = payload(await call('mikser_update_entity', {
            id: '/styles/tokens/buttons.css', content: before.content, ifChecksum: before.checksum,
        }))
        assert.equal(res.ok, true)
        assert.equal(res.advisories[0].kind, 'spec-locked')
    })

    it('says nothing about a file that carries no marker', async () => {
        const res = payload(await call('mikser_read_entity', { id: '/styles/sections/panel.css', include: ['content'] }))
        assert.equal(res.advisories, undefined)
        assert.equal(res.warning, undefined)
    })
})

describe('mikser_update_entity addressed by id', () => {
    it('derives the collection and path from the entity, not from the id string', async () => {
        // The id prefix is `idPrefix ?? "/" + collection` and the extension may
        // have been stripped, so splitting on the first segment is a guess.
        const res = payload(await call('mikser_update_entity', { id: '/styles/tokens/buttons.css', dryRun: true }))
        assert.equal(res.collection, 'styles')
        assert.equal(res.relativePath, 'tokens/buttons.css')
    })

    it('refuses an id the catalog does not know rather than guessing a path', async () => {
        const res = await call('mikser_update_entity', { id: '/styles/not-a-file.css', content: 'x' })
        assert.equal(res.isError, true)
        assert.match(res.content[0].text, /No entity with id/)
    })

    it('refuses a collection that disagrees with the id', async () => {
        const res = await call('mikser_update_entity', {
            id: '/styles/tokens/buttons.css', collection: 'documents', content: 'x',
        })
        assert.equal(res.isError, true)
        assert.match(res.content[0].text, /not documents/)
    })

    it('still accepts the collection + relativePath pair', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/pair-still-works.yml', content: 'a: 1\n',
        }))
        assert.equal(res.ok, true)
    })
})

describe('mikser_update_entity dryRun', () => {
    it('writes nothing', async () => {
        affected = []
        const before = payload(await call('mikser_read_entity', { id: '/styles/tokens/buttons.css', include: ['content'] }))
        await call('mikser_update_entity', { id: '/styles/tokens/buttons.css', content: 'wiped', dryRun: true })
        const after = payload(await call('mikser_read_entity', { id: '/styles/tokens/buttons.css', include: ['content'] }))
        assert.equal(after.content, before.content)
    })

    it('carries the same reason vocabulary the build report uses', async () => {
        affected = [
            { id: '/documents/bg/styles.yml', destination: '/bg/styles/site.css', reason: 'query-matched',
              matched: { filter: { collection: 'styles' }, by: '/styles/tokens/buttons.css' } },
            { id: '/documents/en/styles.yml', destination: '/en/styles/site.css', reason: 'query-matched',
              matched: { filter: { collection: 'styles' }, by: '/styles/tokens/buttons.css' } },
        ]
        const res = payload(await call('mikser_update_entity', { id: '/styles/tokens/buttons.css', dryRun: true }))
        assert.equal(res.wouldAffectCount, 2)
        assert.deepEqual(res.wouldAffect.map(a => a.destination), ['/bg/styles/site.css', '/en/styles/site.css'])
        // Provenance, not just a count — "which query, set off by what" is the
        // half that makes the answer checkable.
        assert.equal(res.wouldAffect[0].matched.by, '/styles/tokens/buttons.css')
    })

    it('reports the advisory before the bytes move, which is the point', async () => {
        const res = payload(await call('mikser_update_entity', { id: '/styles/tokens/buttons.css', dryRun: true }))
        assert.equal(res.advisories[0].kind, 'spec-locked')
    })

    it('says there is no blast radius for a file the catalog has never seen', async () => {
        const res = payload(await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/brand-new-file.yml', dryRun: true,
        }))
        assert.equal(res.exists, false)
        assert.deepEqual(res.wouldAffect, [])
        assert.match(res.note, /not in the catalog yet/)
    })
})

// Positions come out of the `mikser_provenance` table, and this harness runs
// against a catalog stub with no database — deliberately, because giving it a
// real one makes core's findEntities query sqlite instead of the stub and every
// fixture here disappears. So what is tested here is the WIRING and the
// degradation; that the positions themselves are correct is tested against real
// parsers in mikser-io's own test/unit/provenance.test.js.
describe('mikser_read_entity include: ["positions"]', () => {
    it('is opt-in — a plain read does not pay the parse', async () => {
        const res = payload(await call('mikser_read_entity', { id: '/documents/bg/system/navigation.yml' }))
        assert.equal(res.positions, undefined)
    })

    it('attaches positions when asked, and never throws when it cannot', async () => {
        // With no provenance table reachable this degrades to {} plus a note.
        // The degradation is the point: a read must not fail because a
        // diagnostic could not be computed.
        const res = payload(await call('mikser_read_entity', {
            id: '/documents/bg/system/navigation.yml', include: ['positions'],
        }))
        assert.ok(res.positions, 'positions must be present when requested')
        assert.equal(typeof res.positions, 'object')
    })

    it('says so when nothing can be placed, rather than returning silence', async () => {
        // An empty object reads as "this file has no fields"; the note says
        // which of the two it actually is, and that the paths still hold.
        const res = payload(await call('mikser_read_entity', {
            id: '/files/img/logo.png', include: ['positions'],
        }))
        assert.deepEqual(res.positions, {})
        assert.match(res.positionsNote, /field paths in `meta` are still exact/)
    })
})

describe('zodShapeFrom — binding the engine\'s own tools into a session', () => {
    // The engine registers its diagnostics without zod, because the registry is
    // transport agnostic and should not depend on one transport's schema
    // library. Converting here is the cost of that, and the vocabulary is
    // deliberately small: anything richer would be a schema language, which the
    // engine has no business owning.
    it('marks a required field required and everything else optional', async () => {
        const { zodShapeFrom } = await import('../../index.js')
        const shape = zodShapeFrom({
            reference: { type: 'string', required: true },
            cycles:    { type: 'number' },
        })
        assert.equal(shape.reference.isOptional(), false)
        assert.equal(shape.cycles.isOptional(), true)
    })

    it('carries the description through, which is what a client shows', async () => {
        const { zodShapeFrom } = await import('../../index.js')
        const shape = zodShapeFrom({
            reference: { type: 'string', required: true, description: 'Entity id.' },
            // The one that regressed: optional() wraps, so a description
            // applied before it lands on the inner type and the wrapper — what
            // the client actually reads — reports none.
            cycles:    { type: 'number', description: 'How many cycles.' },
        })
        assert.equal(shape.reference.description, 'Entity id.')
        assert.equal(shape.cycles.description, 'How many cycles.')
        assert.equal(shape.cycles.isOptional(), true)
    })

    it('maps the whole vocabulary, and defaults an unknown type to string', async () => {
        const { zodShapeFrom } = await import('../../index.js')
        const shape = zodShapeFrom({
            s: { type: 'string', required: true }, n: { type: 'number', required: true },
            b: { type: 'boolean', required: true }, a: { type: 'array', required: true },
            weird: { type: 'nonsense', required: true },
        })
        assert.equal(shape.s.safeParse('x').success, true)
        assert.equal(shape.n.safeParse(3).success, true)
        assert.equal(shape.b.safeParse(true).success, true)
        assert.equal(shape.a.safeParse(['x']).success, true)
        // Defaulting rather than throwing: a tool with an odd type should still
        // be callable, not vanish from the session surface.
        assert.equal(shape.weird.safeParse('x').success, true)
    })

    it('handles an empty schema, which mikser_verify has', async () => {
        const { zodShapeFrom } = await import('../../index.js')
        assert.deepEqual(zodShapeFrom({}), {})
        assert.deepEqual(zodShapeFrom(), {})
    })
})

describe('renewability is never reported as a flat no', () => {
    // A real token from mikser-io-auth NEVER carries offline_access: it is a
    // property of the GRANT, not a capability, and a resource server checking
    // capabilities must not see it or it becomes a permission nobody granted.
    // Deriving `renewable` from the capability list could therefore only ever
    // answer false — to every caller, including every one holding a perfectly
    // good refresh token.
    //
    // false is the one answer that costs something. An agent reading it stops
    // and asks for a human, which is exactly what the refresh token exists to
    // avoid; the reported symptom was a one-hour window that never renewed.
    // null says "I cannot see that from here", which is true.

    it('reports null, not false, when the capability is absent', async () => {
        const { renewabilityOf } = await import('../../index.js')
        assert.equal(renewabilityOf(['api:update', 'drive:documents']), null)
    })

    it('still reports true when a token really does carry it', async () => {
        // A static token whose operator listed it. Present means present —
        // only ABSENT is unknowable, and absence is the normal case.
        const { renewabilityOf } = await import('../../index.js')
        assert.equal(renewabilityOf(['api:update', 'offline_access']), true)
    })

    it('reports null for a credential with no capability list at all', async () => {
        const { renewabilityOf } = await import('../../index.js')
        assert.equal(renewabilityOf(null), null)
        assert.equal(renewabilityOf(undefined), null)
        assert.equal(renewabilityOf([]), null)
    })
})

describe('a write refuses BEFORE it lands on the wrong side of expiry', () => {
    // The reported failure: a token that died between a finished decision and
    // the write that would have applied it. A 401 at the gate is fine, nothing
    // happened. A 401 PART WAY THROUGH is not, because the caller cannot tell
    // what landed.
    const withCredential = (secondsRemaining, fn) =>
        authContextForTests().run({
            principal: {
                subject: 'alice',
                capabilities: ['api:update', 'offline_access'],
                claims: { exp: Math.floor(Date.now() / 1000) + secondsRemaining },
            },
        }, fn)

    it('refuses a write when the window is about to close, and writes nothing', async () => {
        const before = payload(await call('mikser_read_entity', {
            id: '/documents/bg/system/navigation.yml', include: ['content'] }))
        const res = await withCredential(5, () => call('mikser_update_entity', {
            id: '/documents/bg/system/navigation.yml', content: 'items: []\n' }))
        assert.equal(res.isError, true)
        const body = JSON.parse(res.content[0].text)
        assert.equal(body.refused, 'credential-expiring')
        assert.match(body.hint, /BEFORE writing anything/)

        const after = payload(await call('mikser_read_entity', {
            id: '/documents/bg/system/navigation.yml', include: ['content'] }))
        assert.equal(after.content, before.content, 'the file must be untouched')
    })

    it('asks for a bigger margin when the call will wait for a build cycle', async () => {
        // `await: true` blocks for a whole cycle, so 60 seconds left is fine
        // for a bare write and not fine for that.
        const bare = await withCredential(60, () => call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/margin-probe.yml', content: 'a: 1\n' }))
        assert.equal(bare.isError, undefined, 'a bare write has room in 60s')

        const awaited = await withCredential(60, () => call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/margin-probe.yml', content: 'a: 2\n', await: true }))
        assert.equal(awaited.isError, true)
        assert.equal(JSON.parse(awaited.content[0].text).needed, 120)
    })

    it('never refuses a dryRun, which changes nothing', async () => {
        const res = await withCredential(1, () => call('mikser_update_entity', {
            id: '/documents/bg/system/navigation.yml', dryRun: true }))
        assert.equal(res.isError, undefined)
    })

    it('does not refuse when there is no expiry to run out', async () => {
        // A static token or a loopback call has no deadline. Refusing those
        // would break every unauthenticated setup.
        const res = await call('mikser_update_entity', {
            collection: 'documents', relativePath: 'bg/no-expiry.yml', content: 'a: 1\n' })
        assert.equal(res.isError, undefined)
    })
})
