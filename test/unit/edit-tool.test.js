// The edit tool at the surface a model actually sees.
//
// The engine test pins the behaviour; these pin the three things only this
// transport decides, and each of them was a way to lose the point of the tool:
//
//   - the refusals must come back as RESULTS, not errors. A refusal carries
//     what the next attempt needs — the occurrence count, the parser's
//     complaint, the checksum on disk. A caller handed a red failure retries
//     the same call or gives up and rewrites the whole file, which is the
//     outcome this tool exists to prevent.
//   - it must be `mutates: true`, or its writes carry no change set and are
//     not undoable.
//   - the whole-file tool must stop telling callers it is the only way to
//     change a file, because that sentence is what sends them there.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime, useService } from 'mikser-io'
import { createHarness } from './plugin-harness.js'
import { mcp } from '../../index.js'

let wd, tools
const payload = (result) => JSON.parse(result.content[0].text)
const call = (name, args = {}) => tools.get(name).handler(args)
const documents = () => path.join(wd, 'documents')
const read = (name) => readFile(path.join(documents(), name), 'utf8')

before(async () => {
    wd = await mkdtemp(path.join(tmpdir(), 'mikser-mcp-edit-'))
    await mkdir(documents(), { recursive: true })
    await writeFile(path.join(documents(), 'page.md'),
        '---\ntitle: Launch\nweight: 3\n---\n\nBody that must survive.\n')
    await writeFile(path.join(documents(), 'nav.yml'),
        'items:\n  - label: About\n  - label: About\n')

    const harness = createHarness({ options: { workingFolder: wd } })
    runtime.options.workingFolder   = wd
    runtime.options.documentsFolder = documents()
    runtime.options.outputFolder    = path.join(wd, 'out')
    runtime.engine = { logger: harness.logger }
    runtime.refs = { inboundFor: () => [], outboundFor: () => [], allRefs: () => [], size: () => ({}) }
    runtime.manifest = {
        snapshotsAt: () => [], snapshotsFor: () => [], affectedBy: () => [], collisions: () => [],
    }
    mcp({})(harness.core)

    const recorder = {
        byName: new Map(),
        registerTool(name, def, handler) { this.byName.set(name, { def, handler }) },
        registerResource() {}, registerPrompt() {}, async sendLoggingMessage() {},
    }
    useService('mcp').attach(recorder)

    // The tools are registered from the loaded hook, the way the engine runs
    // them — not from the factory.
    for (const cb of harness.hooks.loaded) await cb()
    tools = recorder.byName
})
after(async () => { await rm(wd, { recursive: true, force: true }) })

describe('mikser_edit_entity', () => {
    it('is registered, and undoable', () => {
        const tool = tools.get('mikser_edit_entity')
        assert.ok(tool, 'the tool must exist')
        assert.ok('changeSet' in tool.def.inputSchema,
            'mutates: true is what puts changeSet here; without it an edit cannot be taken back')
    })

    it('changes the named text and leaves the rest', async () => {
        const result = payload(await call('mikser_edit_entity', {
            collection: 'documents', relativePath: 'page.md',
            find: 'title: Launch', replace: 'title: Relaunch',
        }))
        assert.equal(result.ok, true)
        assert.equal(await read('page.md'),
            '---\ntitle: Relaunch\nweight: 3\n---\n\nBody that must survive.\n')
    })

    it('returns an ambiguous anchor as a result carrying the count, not an error', async () => {
        const raw = await call('mikser_edit_entity', {
            collection: 'documents', relativePath: 'nav.yml',
            find: '  - label: About', replace: '  - label: Us',
        })
        assert.notEqual(raw.isError, true, 'a caller must be able to act on this, not just see it failed')
        const result = payload(raw)
        assert.equal(result.refused, 'anchor-ambiguous')
        assert.equal(result.occurrences, 2, 'the count is the whole reason this is recoverable')
        assert.match(result.hint, /all: true/)
    })

    it('returns a missing anchor the same way', async () => {
        const raw = await call('mikser_edit_entity', {
            collection: 'documents', relativePath: 'page.md', find: 'not in the file', replace: 'x',
        })
        assert.notEqual(raw.isError, true)
        assert.equal(payload(raw).refused, 'anchor-not-found')
    })

    it('returns the parser\'s complaint rather than writing a broken file', async () => {
        const raw = await call('mikser_edit_entity', {
            collection: 'documents', relativePath: 'nav.yml',
            find: 'items:', replace: 'items: [unterminated',
        })
        assert.notEqual(raw.isError, true)
        const result = payload(raw)
        assert.equal(result.refused, 'would-not-parse')
        assert.ok(result.error.length > 'would-not-parse'.length, 'and says what the parser objected to')
        assert.equal(await read('nav.yml'), 'items:\n  - label: About\n  - label: About\n')
    })

    it('still fails a request that is simply wrong', async () => {
        // Not every refusal is recoverable. A path outside the collection is a
        // bad request and must read as one.
        const raw = await call('mikser_edit_entity', {
            collection: 'documents', relativePath: '../../etc/passwd', find: 'root', replace: 'x',
        })
        assert.equal(raw.isError, true)
    })

    it('replaces every occurrence when asked', async () => {
        const result = payload(await call('mikser_edit_entity', {
            collection: 'documents', relativePath: 'nav.yml',
            find: 'label: About', replace: 'label: Us', all: true,
        }))
        assert.equal(result.replacements, 2)
        assert.equal(await read('nav.yml'), 'items:\n  - label: Us\n  - label: Us\n')
    })
})

describe('the whole-file tool points at it', () => {
    it('no longer claims there is no partial-edit mode', async () => {
        const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
        const at = source.indexOf("'mikser_update_entity',")
        const description = source.slice(at, at + 1600)
        assert.doesNotMatch(description, /there is no partial-edit or patch mode/,
            'that sentence is what sends a caller to rewrite a whole file')
        assert.match(description, /mikser_edit_entity/,
            'and a caller reading it must be told where to go instead')
    })
})
