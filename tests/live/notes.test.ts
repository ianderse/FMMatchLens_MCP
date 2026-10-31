// Live tactical annotation (Slice 5): `fmmi note add --live` pins a change to an explicit live snapshot boundary read from the plugin, the
// note is immutable and manual, it is adopted as a regular tactical note when the finished recording is imported, and its windows are
// compared. Writes are CLI-only. The plugin is the MODELLED fake (tests/support/fakePlugin.ts); recordings are SYNTHETIC.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { MatchQueries } from '@fmmi/query'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { rig, syntheticReplay } from '../support/live.ts'
import { connect } from '../support/mcp.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

function cli(home: string, livePort?: number) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home }, livePort }
    const code = await main([...args, '--json'], io)
    return { code, body: out.length ? (JSON.parse(out.join('\n')) as Json) : null, err: err.join('\n'), text: out.join('\n') }
  }
}

async function setup(frames = 160) {
  const made = await syntheticReplay()
  const r = await rig(made.replay)
  r.plugin.advance(frames)
  const home = tmp('fmmi-ln-')
  const run = cli(home, r.plugin.boundPort)
  const saveId = (await run('save', 'create', 'Live save')).body!.data.saveId as string
  return { ...made, r, home, run, saveId }
}
const NOTE = ['--setting', 'Mentality', '--prior-value', 'Balanced', '--new-value', 'Positive']

describe('[S4][MODELLED] fmmi note add --live', () => {
  it('pins the change to the live snapshot boundary the CLI read from the plugin: period, tick and game minute are not typed by the user', async () => {
    const t = await setup(160)
    const res = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--text', 'went 4-4-2 at the break')
    expect(res.code, res.err || res.text).toBe(0)
    const last = t.replay.frames[159]!
    const d = res.body!.data
    expect(d).toMatchObject({ saveId: t.saveId, upstreamMatchId: t.replay.matchId, period: last.period, tick: last.tick, boundarySource: 'live_snapshot_end', snapshotTick: last.tick, confidence: 'manual', label: 'manual' })
    expect(d.displayMinute).toBe(Math.round((last.displayTick / 240) * 100) / 100)
    expect(d.snapshotLabel).toBe(`live as of game minute ${d.displayMinute} / period ${last.period} / tick ${last.tick}`)
    expect(d.side).toBe('home') // from the human-controlled flag in the live metadata, not typed
    expect(d.noteId).toMatch(/^ln_[0-9a-f]{16}$/)
    const text: string[] = []
    await main(['note', 'add', '--live', '--save', t.saveId, ...NOTE], { out: (s) => text.push(s), err: () => undefined, env: { FMMI_HOME: t.home }, livePort: t.r.plugin.boundPort })
    expect(text.join()).toMatch(/FMMatchLens did not record this change/)
    expect(text.join()).toMatch(/boundary is the snapshot end/)
    // audited, and a CLI write only: the audit names it
    const w = service(t.home)
    expect(w.store.listAudit().find((a) => a.action === 'note.add_live')!.details).toMatchObject({ upstreamMatchId: t.replay.matchId, boundarySource: 'live_snapshot_end', confidence: 'manual' })
    w.close()
    await t.r.close()
  }, 60_000)

  it('an explicit earlier boundary inside the snapshot is accepted; a later one, one before the first frame and a malformed one are refused', async () => {
    const t = await setup(160)
    const mid = t.replay.frames[100]!
    const ok = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--boundary', `${mid.period}:${mid.tick}`)
    expect(ok.code, ok.err || ok.text).toBe(0)
    expect(ok.body!.data).toMatchObject({ tick: mid.tick, boundarySource: 'explicit', snapshotTick: t.replay.frames[159]!.tick })
    expect(ok.body!.data.displayMinute).toBe(Math.round((mid.displayTick / 240) * 100) / 100)
    const later = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--boundary', '2:99999')
    expect(later.code).toBe(1)
    expect(later.body!.error).toMatchObject({ code: 'invalid_input', details: { reason: 'boundary_outside_snapshot' } })
    expect((await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--boundary', '1:0')).body!.error.details.reason).toBe('boundary_outside_snapshot')
    expect((await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--boundary', 'soon')).body!.error.details.reason).toBe('boundary_format')
    await t.r.close()
  }, 60_000)

  it('needs a fresh live snapshot: no plugin, no match and a stale snapshot all refuse, and nothing is written', async () => {
    const t = await setup(100)
    const countNotes = () => { const w = service(t.home); try { return w.listLiveNotes().length } finally { w.close() } }
    t.r.plugin.inMatch = false
    const none = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)
    expect(none.code).toBe(1)
    expect(none.body!.error).toMatchObject({ code: 'not_found', details: { state: 'not_in_match' } })
    t.r.plugin.inMatch = true
    await t.r.plugin.stop()
    const down = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)
    expect(down.body!.error).toMatchObject({ code: 'stale_snapshot', retryable: true, details: { state: 'not_connected' } })
    expect(countNotes()).toBe(0)
    t.r.reader.close()
  }, 60_000)

  it('a live note is immutable and manual: the database refuses an update or a delete', async () => {
    const t = await setup(80)
    const id = (await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)).body!.data.noteId as string
    const raw = new Database(join(t.home, 'catalog.sqlite'))
    try {
      expect(() => raw.prepare("UPDATE live_note SET new_value='x' WHERE note_id=?").run(id)).toThrow(/immutable/)
      expect(() => raw.prepare('DELETE FROM live_note WHERE note_id=?').run(id)).toThrow(/immutable/)
      expect(() => raw.prepare("UPDATE live_note SET confidence='observed' WHERE note_id=?").run(id)).toThrow()
    } finally { raw.close() }
    await t.r.close()
  }, 60_000)
})

describe('[S4][MODELLED] adoption: the finished recording turns a live note into a regular tactical note, once', () => {
  it('importing the finished archive into the same save adopts the note (manual, audited, labelled as recorded live); a second import and another save do not duplicate it', async () => {
    const t = await setup(160)
    const id = (await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE, '--text', 'live change')).body!.data.noteId as string
    const other = (await t.run('save', 'create', 'Other')).body!.data.saveId as string
    expect((await t.run('note', 'list', '--save', t.saveId)).body!.data.notes).toHaveLength(0) // no match in the catalog yet

    const ing = await t.run('ingest', t.file, '--save', t.saveId)
    expect(ing.code).toBe(0)
    const matchId = ing.body!.data.results[0].matchId as string
    const list = (await t.run('note', 'list', '--save', t.saveId, '--match', matchId)).body!.data
    expect(list.notes).toHaveLength(1)
    expect(list.notes[0]).toMatchObject({ matchId, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Positive', confidence: 'manual', period: t.replay.frames[159]!.period })
    expect(list.notes[0].comment).toBe('recorded live: live change')
    expect(list.notes[0].minute).toBe(Math.round((t.replay.frames[159]!.displayTick / 240) * 100) / 100)
    const w = service(t.home)
    try {
      const adoption = w.getLiveNote(id)!.adoption!
      expect(adoption).toMatchObject({ matchId, tacticalNoteId: list.notes[0].noteId })
      expect(w.store.listAudit().filter((a) => a.action === 'note.adopt_live')).toHaveLength(1)
    } finally { w.close() }
    // idempotent, and not leaked into another save
    await t.run('ingest', t.file, '--save', t.saveId)
    expect((await t.run('note', 'list', '--save', t.saveId, '--match', matchId)).body!.data.notes).toHaveLength(1)
    await t.run('ingest', t.file, '--save', other)
    expect((await t.run('note', 'list', '--save', other)).body!.data.notes).toHaveLength(0)

    // the existing read-only MCP tool shows it, labelled manual
    const mcp = await connect(t.home)
    const notes = await mcp.call('get_tactical_notes', { saveId: t.saveId, matchId })
    expect(notes.data.notes[0]).toMatchObject({ confidence: 'manual' })
    await mcp.close()
    await t.r.close()
  }, 120_000)

  it('a live note made after the match is already in the catalog attaches at once', async () => {
    const t = await setup(160)
    await t.run('ingest', t.file, '--save', t.saveId)
    const add = await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)
    expect(add.code, add.err || add.text).toBe(0)
    const w = service(t.home)
    try {
      const q = new MatchQueries(w)
      const matchId = q.listMatches({ saveId: t.saveId }).matches[0]!.matchId
      expect(q.tacticalNotes({ saveId: t.saveId, matchId }).notes).toHaveLength(1)
    } finally { w.close() }
    await t.r.close()
  }, 120_000)

  it('mid-match archive incompleteness: the in-progress file is a partial prefix, its score is not final, and the finished file extends it and keeps the note', async () => {
    const t = await setup(160)
    const { writeFileSync } = await import('node:fs')
    const { buildSyntheticArchive } = await import('../support/syntheticArchive.ts')
    // what the plugin's own archive of this match holds while the match is still running: the same frames up to now, no clean close
    const last = t.replay.frames[159]!
    const periods = t.synth.periods!.map((p) => (p.period === last.period ? { ...p, toTick: last.tick } : p)).filter((p) => p.period <= last.period)
    const partialFile = join(tmp('fmmi-ln-'), 'in-progress.fmlens')
    writeFileSync(partialFile, buildSyntheticArchive({ ...t.synth, cleanClose: false, periods }).bytes)
    const note = (await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)).body!.data.noteId as string
    const a = await t.run('ingest', partialFile, '--save', t.saveId)
    const first = a.body!.data.results[0]
    expect(first).toMatchObject({ status: 'ingested', coverage: 'partial', completion: 'unknown' })
    const show = (await t.run('show', first.matchId)).body!.data
    expect(show.result.label).toBe('observed_not_final')
    expect(show.status.coverage.status).toBe('partial')
    // the live view of the same moment agrees: in progress, partial, not final
    const live = await t.r.reader.refresh()
    expect(live.state).toBe('fresh')
    expect(t.r.reader.tracked!.decoded()!.recording.coverage.status).toBe('partial')
    // the match finishes; the finished archive extends the prefix; the live note is on the match
    t.r.plugin.advanceTo(t.replay.frames.length)
    const fin = await t.run('ingest', t.file, '--save', t.saveId)
    expect(fin.body!.data.results[0].status).toBe('continuation')
    expect(fin.body!.data.results[0].matchId).toBe(first.matchId)
    const notes = (await t.run('note', 'list', '--save', t.saveId, '--match', first.matchId)).body!.data.notes as Json[]
    expect(notes).toHaveLength(1)
    const w = service(t.home)
    try { expect(w.getLiveNote(note)!.adoption!.matchId).toBe(first.matchId) } finally { w.close() }
    await t.r.close()
  }, 120_000)
})

describe('[S4][MODELLED] comparing the windows of a live note', () => {
  it('fmmi note compare ln_... compares [start, boundary) with [boundary, now) on the live snapshot, labelled manual and observational', async () => {
    const t = await setup(100)
    const mid = t.replay.frames[99]!
    const id = (await t.run('note', 'add', '--live', '--save', t.saveId, ...NOTE)).body!.data.noteId as string
    t.r.plugin.advanceTo(t.replay.frames.length)
    t.r.time.now += 1000
    const res = await t.run('note', 'compare', id)
    expect(res.code, res.err || res.text).toBe(0)
    const d = res.body!.data
    expect(d.query).toBe('live_note_compare')
    expect(d.note).toMatchObject({ noteId: id, label: 'manual', tick: mid.tick })
    expect(d.comparison.windows.a.to).toMatchObject({ tick: mid.tick })
    expect(d.comparison.windows.b.from).toMatchObject({ tick: mid.tick })
    expect(d.comparison.comparison.pairing).toBe('b_minus_a')
    expect(d.comparison.comparison.context.note).toMatch(/Observational comparison/)
    const text: string[] = []
    await main(['note', 'compare', id], { out: (s) => text.push(s), err: () => undefined, env: { FMMI_HOME: t.home }, livePort: t.r.plugin.boundPort })
    expect(text.join('\n')).toMatch(/Live note ln_[0-9a-f]+ \(manual\)/)
    expect(text.join('\n')).toMatch(/live as of game minute/)
    // a note from another match is not compared against this live match
    const w = service(t.home)
    const foreign = w.addLiveNote(t.saveId, { upstreamMatchId: 'match-other', side: 'home', period: 1, tick: 100, displayMinute: 1, snapshotTick: 100, boundarySource: 'explicit', setting: 'a', priorValue: 'b', newValue: 'c' })
    w.close()
    expect((await t.run('note', 'compare', foreign.noteId)).body!.error).toMatchObject({ code: 'not_found', details: { reason: 'different_live_match' } })
    expect((await t.run('note', 'compare', 'ln_0000000000000000')).body!.error).toMatchObject({ code: 'not_found' })
    await t.r.close()
  }, 60_000)
})
