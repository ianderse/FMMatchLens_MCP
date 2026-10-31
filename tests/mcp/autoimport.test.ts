// Automatic import in the stdio MCP server (a deliberate deviation from the read-only spec: see the server instructions).
// Everything runs in temporary directories with labelled synthetic recordings: never the real catalog, game folder or Claude config.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { main as cliMain } from '@fmmi/cli'
import { INSTRUCTIONS, INSTRUCTIONS_MAX_CHARS, LIVE_INSTRUCTIONS, TOOLS, main as mcpMain } from '@fmmi/mcp'
import { AutoImporter, CatalogService, loadConfig, updateConfigFile } from '@fmmi/store'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { buildSyntheticArchive } from '../support/syntheticArchive.ts'
import { FIVE, buildSeasonMatch } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'
import { connect, openWriter } from '../support/mcp.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const BIN = join(import.meta.dirname, '..', '..', 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs')

async function addFile(archive: string, name: string, spec: SeasonMatch): Promise<string> {
  const p = join(archive, name)
  writeFileSync(p, buildSyntheticArchive(await buildSeasonMatch(spec)).bytes)
  return p
}

/** A configured home (config.json: archive folder and default save) whose catalog already holds the first match. */
async function rig(opts: { configure?: boolean } = {}) {
  const home = tmp('fmmi-ai-home-'), archive = tmp('fmmi-ai-archive-')
  const w = openWriter(home)
  const save = w.createSave('Auto FC')
  const first = await addFile(archive, '2026-08-08-Synthetic Town-vs-Horsham Rovers-1-0.fmlens', FIVE[0]!)
  const r = await w.ingestFile(first, save.saveId)
  w.close()
  if (opts.configure !== false) updateConfigFile(home, { archiveDir: archive, defaultSaveId: save.saveId })
  let now = 1_000_000
  const log: Array<[string, unknown]> = []
  const importer = new AutoImporter({ home, env: {}, now: () => now, busyTimeoutMs: 60, log: (e, f) => log.push([e, f]) })
  return { home, archive, saveId: save.saveId, firstMatchId: r.matchId!, importer, log, advance: (ms: number) => { now += ms } }
}

const matchesOf = (home: string, saveId: string) => { const s = new CatalogService({ ...loadConfig(home, {}), readOnly: true }); try { return s.listMatches(saveId).matches } finally { s.close() } }

describe('automatic import in the stdio server', () => {
  it('imports a finished new recording before a tool call, reports it as newlyImported once, and only into the configured default save', async () => {
    const t = await rig()
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    const before = await c.call('list_matches')
    expect(before.data.matches).toHaveLength(1)
    expect(before.data.newlyImported).toBeUndefined()
    t.advance(31_000)
    await addFile(t.archive, '2026-08-15-Torquay Athletic-vs-Synthetic Town-1-1.fmlens', FIVE[1]!)
    const after = await c.call('list_matches')
    expect(after.isError).toBe(false)
    expect(after.data.matches).toHaveLength(2)
    expect(after.data.newlyImported).toHaveLength(1)
    expect(after.data.newlyImported[0]).toMatchObject({ file: '2026-08-15-Torquay Athletic-vs-Synthetic Town-1-1.fmlens', status: 'ingested' })
    expect(after.data.warnings.join(' ')).toMatch(/auto_imported: 1 new recording/)
    const again = await c.call('list_matches')
    expect(again.data.newlyImported).toBeUndefined()
    expect(matchesOf(t.home, t.saveId)).toHaveLength(2)
    await c.close()
  })

  it('reports an import on a non-list tool as a warning line, and the catalog stays readable throughout', async () => {
    const t = await rig()
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    await c.call('list_matches')
    t.advance(31_000)
    await addFile(t.archive, 'b.fmlens', FIVE[1]!)
    const status = await c.call('get_recording_status')
    expect(status.data.scope).toBe('catalog')
    expect(status.data.newlyImported).toHaveLength(1) // get_recording_status carries the structured list too
    const summary = await c.call('get_match_summary', { matchId: t.firstMatchId })
    expect(summary.isError).toBe(false)
    expect(summary.data.warnings.join(' ')).not.toMatch(/auto_imported/)
    await c.close()
  })

  it('is throttled to once per 30 seconds and does no catalog work when the folder is unchanged', async () => {
    const t = await rig()
    const ingest = vi.spyOn(CatalogService.prototype, 'ingestFile')
    try {
      const c = await connect(t.home, undefined, { autoImport: t.importer })
      await c.call('list_matches') // first round: the file is already in the catalog by name, so nothing is read or hashed
      expect(ingest).not.toHaveBeenCalled()
      await addFile(t.archive, 'c.fmlens', FIVE[1]!)
      t.advance(5_000)
      expect((await c.call('list_matches')).data.matches).toHaveLength(1) // inside the interval: no scan
      expect(ingest).not.toHaveBeenCalled()
      t.advance(26_000)
      expect((await c.call('list_matches')).data.matches).toHaveLength(2)
      expect(ingest).toHaveBeenCalledTimes(1)
      t.advance(31_000)
      await c.call('list_matches') // unchanged listing: the importer remembers name, size and mtime
      expect(ingest).toHaveBeenCalledTimes(1)
      await c.close()
    } finally { ingest.mockRestore() }
  })

  it('does nothing without a configured folder and default save, and never creates a catalog that does not exist', async () => {
    const unconfigured = await rig({ configure: false })
    await addFile(unconfigured.archive, 'd.fmlens', FIVE[1]!)
    const c = await connect(unconfigured.home, undefined, { autoImport: unconfigured.importer })
    expect((await c.call('list_matches')).data.matches).toHaveLength(1)
    await c.close()
    // folder but no default save
    updateConfigFile(unconfigured.home, { archiveDir: unconfigured.archive })
    unconfigured.advance(60_000)
    const c2 = await connect(unconfigured.home, undefined, { autoImport: unconfigured.importer })
    expect((await c2.call('list_matches')).data.matches).toHaveLength(1)
    await c2.close()

    // a server started before the first import: configured, but no catalog yet
    const home = tmp('fmmi-ai-empty-'), archive = tmp('fmmi-ai-archive-')
    await addFile(archive, 'e.fmlens', FIVE[1]!)
    updateConfigFile(home, { archiveDir: archive, defaultSaveId: 's_0000000000000000' })
    const c3 = await connect(home, undefined, { autoImport: new AutoImporter({ home, env: {} }) })
    const r = await c3.call('list_matches')
    expect(r.isError).toBe(true)
    expect(r.data).toMatchObject({ code: 'not_found', details: { reason: 'catalog_missing' } })
    expect(existsSync(join(home, 'catalog.sqlite'))).toBe(false)
    await c3.close()
  })

  it('skips an in-progress match-<digits>.fmlens, as sync does', async () => {
    const t = await rig()
    await addFile(t.archive, 'match-1767225600000.fmlens', FIVE[1]!)
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    const r = await c.call('list_matches')
    expect(r.data.matches).toHaveLength(1)
    expect(r.data.newlyImported).toBeUndefined()
    await c.close()
  })

  it('a failure never fails the call: a missing folder and an unreadable file become warnings, logged by category without paths', async () => {
    const t = await rig()
    writeFileSync(join(t.archive, 'broken.fmlens'), Buffer.from('not an archive'))
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    const r = await c.call('list_matches')
    expect(r.isError).toBe(false)
    expect(r.data.matches).toHaveLength(1)
    expect(r.data.warnings.join(' ')).toMatch(/auto_import_rejected/)
    expect(r.data.warnings.join(' ')).toMatch(/fmmi sync/)
    t.advance(31_000)
    updateConfigFile(t.home, { archiveDir: join(t.archive, 'gone') })
    const r2 = await c.call('list_matches')
    expect(r2.isError).toBe(false)
    expect(r2.data.warnings.join(' ')).toMatch(/auto_import_folder_missing/)
    expect(JSON.stringify(t.log)).not.toContain(t.archive)
    expect(t.log.map((l) => l[0])).toContain('auto_import_failed')
    await c.close()
  })

  it('a client cannot influence the folder, a path or the save: strict inputs, no path-like property, and the import goes to the default save', async () => {
    const t = await rig()
    const other = openWriter(t.home)
    const second = other.createSave('Other save')
    other.close()
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    await c.call('list_matches')
    t.advance(31_000)
    await addFile(t.archive, 'f.fmlens', FIVE[1]!)
    const bad = await c.call('list_matches', { path: 'C:\\somewhere', archiveDir: 'C:\\elsewhere' })
    expect(bad.isError).toBe(true)
    expect(bad.data).toMatchObject({ code: 'invalid_input', details: { reason: 'schema' } })
    t.advance(31_000)
    await c.call('list_matches', { saveId: second.saveId }) // naming another save changes what is listed, not where the import goes
    expect(matchesOf(t.home, t.saveId)).toHaveLength(2)
    expect(matchesOf(t.home, second.saveId)).toHaveLength(0)
    const props = (await c.client.listTools()).tools.flatMap((x) => Object.keys((x.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}))
    expect(props.filter((n) => /path|dir|folder|file|url|archive/i.test(n))).toEqual([])
    await c.close()
  })

  it('a pinned recordingRevisionId keeps returning the same evidence after an automatic import', async () => {
    const t = await rig()
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    const first = (await c.call('list_matches')).data.matches[0]
    const pinned = { matchId: first.matchId, recordingRevisionId: first.selectedRecordingRevisionId }
    // Identity labels may enrich when a second match joins the save (a persistent pe_ id appears); the evidence itself must not move.
    const evidence = (text: string) => JSON.stringify(JSON.parse(text), (k, v) => (['identity', 'persistentPlayerId', 'identityNote'].includes(k) ? undefined : v))
    const before = evidence((await c.call('get_match_summary', pinned)).text)
    t.advance(31_000)
    await addFile(t.archive, 'g.fmlens', FIVE[1]!)
    await c.call('list_matches')
    expect(matchesOf(t.home, t.saveId)).toHaveLength(2)
    expect(evidence((await c.call('get_match_summary', pinned)).text)).toBe(before)
    await c.close()
  })

  it('a busy catalog skips the round without failing the call and the next round retries; a CLI import running at the same time corrupts nothing', async () => {
    const t = await rig()
    const c = await connect(t.home, undefined, { autoImport: t.importer })
    await c.call('list_matches')
    t.advance(31_000)
    await addFile(t.archive, 'h.fmlens', FIVE[1]!)
    const lock = new Database(join(t.home, 'catalog.sqlite'))
    lock.exec('BEGIN IMMEDIATE') // another writer holds the database
    const busy = await c.call('list_matches')
    lock.exec('ROLLBACK'); lock.close()
    expect(busy.isError).toBe(false)
    expect(busy.data.matches).toHaveLength(1)
    expect(busy.data.warnings.join(' ')).toMatch(/auto_import_busy/)
    t.advance(31_000)
    const retried = await c.call('list_matches')
    expect(retried.data.matches).toHaveLength(2)

    // A CLI import of another recording at the same moment as an automatic one.
    t.advance(31_000)
    const cliFile = await addFile(t.archive, 'i.fmlens', FIVE[2]!)
    await addFile(t.archive, 'j.fmlens', FIVE[3]!)
    const out: string[] = []
    const [cli, tool] = await Promise.all([
      cliMain(['ingest', cliFile, '--save', t.saveId, '--json'], { out: (s) => out.push(s), err: () => {}, env: { FMMI_HOME: t.home } }),
      c.call('list_matches'),
    ])
    expect(tool.isError).toBe(false)
    expect([0, 1]).toContain(cli)
    t.advance(31_000)
    await c.call('list_matches')
    const ms = matchesOf(t.home, t.saveId)
    expect(ms).toHaveLength(4) // each recording exactly once
    expect(new Set(ms.map((m) => m.upstreamMatchId)).size).toBe(4)
    await c.close()
  })
})

describe('the entry point', () => {
  async function launch(home: string, args: string[]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--home', home, ...args], env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('FMMI_'))) as Record<string, string>, stderr: 'pipe' })
    const client = new Client({ name: 'fmmi-ai-test', version: '0.0.0' })
    await client.connect(transport)
    const call = async (name: string): Promise<Json> => JSON.parse(((await client.callTool({ name, arguments: {} })) as Json).content[0].text)
    return { call, close: () => client.close() }
  }

  it('the real stdio server imports at startup and before a call, and --no-auto-import turns it off', async () => {
    const on = await rig(), off = await rig()
    await addFile(on.archive, 'k.fmlens', FIVE[1]!)
    await addFile(off.archive, 'k.fmlens', FIVE[1]!)
    const s1 = await launch(on.home, [])
    const r1 = await s1.call('list_matches')
    expect(r1.matches).toHaveLength(2)
    await s1.close()
    const s2 = await launch(off.home, ['--no-auto-import'])
    expect((await s2.call('list_matches')).matches).toHaveLength(1)
    await s2.close()
  }, 120_000)

  it('--http never imports: the importer is not even created', async () => {
    const t = await rig()
    await addFile(t.archive, 'l.fmlens', FIVE[1]!)
    const spy = { run: vi.fn(() => Promise.resolve()), beforeCall: vi.fn(() => Promise.resolve(null)) }
    const ac = new AbortController()
    let url = ''
    const done = mcpMain(['--http', '--home', t.home, '--port', '0'], { env: { FMMI_MCP_TOKEN: 'x'.repeat(32) }, err: () => {}, abort: ac.signal, onListening: (u) => { url = u }, autoImport: spy })
    for (let i = 0; i < 100 && !url; i++) await new Promise((r) => setTimeout(r, 20))
    expect(url).not.toBe('')
    ac.abort()
    expect(await done).toBe(0)
    expect(spy.run).not.toHaveBeenCalled()
    expect(spy.beforeCall).not.toHaveBeenCalled()
    expect(matchesOf(t.home, t.saveId)).toHaveLength(1)
  })

  it('the server instructions state exactly this one exception and stay under the limit; there is still no tool that writes', () => {
    expect(INSTRUCTIONS).toMatch(/cannot read files, fetch URLs, run commands or change anything/)
    expect(INSTRUCTIONS).toMatch(/One exception: before a call the server may import new finished recordings from the configured folder into the default save \(never a client path\)/)
    expect((INSTRUCTIONS + LIVE_INSTRUCTIONS).length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    expect(TOOLS.every((x) => !/^(import|write|set|add|delete|confirm)/.test(x.name))).toBe(true)
  })

  it('the MCP sources still import no file API (the importer is injected from the entry point)', () => {
    for (const f of ['server.ts', 'main.ts', 'catalog.ts', 'tools.ts']) {
      const src = readFileSync(join(import.meta.dirname, '..', '..', 'packages', 'mcp', 'src', f), 'utf8')
      expect(src, f).not.toMatch(/node:fs|writeFile|appendFile|unlink|rmSync|mkdirSync|node:child_process/)
    }
  })
})
