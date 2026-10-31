// Slice 5: recording continuations (spec 6.2, 6.3). A second recording of a known source identity extends the match ONLY when the selected
// revision is a verified, unchanged prefix of it; a conflicting payload is never merged automatically; every earlier revision stays
// inspectable and pinnable. Synthetic archives (invented teams and players) plus, when present, a TRUNCATED COPY of the real recording
// (a true prefix of real frames). FMMI_HOME-isolated temporary catalogs; the game folder is never read.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { MIGRATIONS, CatalogService, loadConfig } from '@fmmi/store'
import { MatchQueries } from '@fmmi/query'
import { HAS_REAL, REAL_FIXTURE, cleanupAll, service, tmp } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { buildSyntheticArchive } from '../support/syntheticArchive.ts'
import type { SynthOptions } from '../support/syntheticArchive.ts'
import { FULL_PERIODS } from '../support/helpers.ts'

afterAll(cleanupAll)

async function pair() {
  const sc = await buildScenario({ passesPerSide: 60, pureCompleted: true, periods: FULL_PERIODS, goals: [{ tick: 603, side: 'home' }] })
  const full: SynthOptions = { ...sc.synth, upstreamMatchId: 'match-cont-1' }
  // The same match cut at tick 15 024 (a frame of the full recording's own grid): every frame it has is a frame of the full recording; it ends without a clean close.
  const prefix: SynthOptions = { ...full, cleanClose: false, periods: [FULL_PERIODS[0]!, { ...FULL_PERIODS[1]!, toTick: 15024 }] }
  const write = (name: string, o: SynthOptions) => { const f = join(tmp('fmmi-cont-'), name); writeFileSync(f, buildSyntheticArchive(o).bytes); return f }
  return { full, prefix, write }
}

describe('[S5] verified-prefix continuation', () => {
  it('a longer recording of the same match whose earlier frames are unchanged becomes the selected revision; the prefix stays inspectable and pinnable', async () => {
    const { full, prefix, write } = await pair()
    const svc = service()
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('prefix.fmlens', prefix), save.saveId)
    expect(a).toMatchObject({ status: 'ingested', integrity: 'valid', coverage: 'partial' })
    const b = await svc.ingestFile(write('full.fmlens', full), save.saveId)
    expect(b.status).toBe('continuation')
    expect(b.matchId).toBe(a.matchId)
    expect(b.warnings.join()).toMatch(/continuation: extends revision/)

    const m = svc.listMatches(save.saveId).matches
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ selectedRecordingRevisionId: b.recordingRevisionId, conflictingRevisions: 0 })
    const show = svc.showMatch(a.matchId!)
    expect(show.revisions.map((r) => [r.recordingRevisionId, r.identityStatus, r.selected])).toEqual([[a.recordingRevisionId, 'ok', false], [b.recordingRevisionId, 'ok', true]])
    // lineage is stored: the new revision's parent is the prefix
    expect(svc.store.getRevision(b.recordingRevisionId!)).toMatchObject({ parentRevisionId: a.recordingRevisionId, relation: 'continuation', identityStatus: 'ok' })
    // prior evidence stays inspectable, and a pinned analysis of it still resolves to the PREFIX, not the continuation
    const old = svc.showMatch(a.matchId!, { revisionId: a.recordingRevisionId })
    expect(old.status.coverage.status).toBe('partial')
    expect(old.recording.selected).toBe(false)
    const q = new MatchQueries(svc)
    const pinned = await q.summary(a.matchId!, { recordingRevisionId: a.recordingRevisionId })
    const current = await q.summary(a.matchId!)
    expect(pinned.recordingRevisionId).toBe(a.recordingRevisionId)
    expect(current.recordingRevisionId).toBe(b.recordingRevisionId)
    expect(current.capture.coverage).toBe('full_match')
    // the audit trail names the automatic decision and its evidence
    const audit = svc.store.listAudit().filter((x) => x.action === 'recording.continuation')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toMatchObject({ automatic: true, parentRevisionId: a.recordingRevisionId, selected: true, evidence: { relation: 'extends' } })
    // idempotent: the same bytes again are 'already_ingested', not another revision
    expect((await svc.ingestFile(write('full-again.fmlens', full), save.saveId)).status).toBe('already_ingested')
    expect(svc.store.listRevisions(a.matchId!)).toHaveLength(2)
    svc.close()
  }, 120_000)

  it('a confirmation belongs to the revision it was made on: the continuation starts unconfirmed and says so', async () => {
    const { full, prefix, write } = await pair()
    const svc = service()
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('prefix.fmlens', prefix), save.saveId)
    svc.confirmMatch(a.matchId!, '1-0')
    const b = await svc.ingestFile(write('full.fmlens', full), save.saveId)
    expect(b.status).toBe('continuation')
    expect(b.warnings.join()).toMatch(/confirm again/)
    expect(svc.showMatch(a.matchId!).status.completion.status).toBe('unknown')
    expect(svc.showMatch(a.matchId!, { revisionId: a.recordingRevisionId }).status.completion.status).toBe('completed_manual')
    svc.close()
  }, 120_000)

  it('an earlier prefix imported after the longer recording is kept as evidence, not selected, and is not a conflict', async () => {
    const { full, prefix, write } = await pair()
    const svc = service()
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('full.fmlens', full), save.saveId)
    const b = await svc.ingestFile(write('prefix.fmlens', prefix), save.saveId)
    expect(b.status).toBe('ingested')
    expect(b.warnings.join()).toMatch(/earlier_prefix/)
    expect(svc.listMatches(save.saveId).matches[0]).toMatchObject({ selectedRecordingRevisionId: a.recordingRevisionId, conflictingRevisions: 0 })
    expect(svc.store.getRevision(b.recordingRevisionId!)).toMatchObject({ relation: 'prefix', identityStatus: 'ok', parentRevisionId: a.recordingRevisionId })
    svc.close()
  }, 120_000)

  it('a conflicting payload is never automatic: a changed frame inside the prefix, a changed roster, a different start time and a different score all stay identity_conflict with the reason', async () => {
    const { full, prefix, write } = await pair()
    const svc = service()
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('prefix.fmlens', prefix), save.saveId)
    const base = svc.listMatches(save.saveId).matches[0]!.selectedRecordingRevisionId
    const cases: Array<[string, SynthOptions, RegExp]> = [
      // same length as the real continuation, but one counter differs in the middle of the earlier prefix
      ['frame', { ...full, stats: (tick, pid) => ({ ...(full.stats?.(tick, pid) ?? {}), ...(pid === 1001 && tick >= 5000 && tick < 5200 ? { passes: 999 } : {}) }) }, /frame_content_differs/],
      ['roster', { ...full, players: full.players!.map((p) => (p.playerId === 1001 ? { ...p, name: 'Somebody Else' } : p)) }, /initial_metadata_differs/],
      ['start', { ...full, startedUnixMs: (full.startedUnixMs ?? 1_790_000_000_000) + 1 }, /start_time_differs/],
      ['score', { ...full, goals: [{ tick: 603, side: 'away' }] }, /frame_content_differs/],
    ]
    for (const [name, o, why] of cases) {
      const r = await svc.ingestFile(write(`${name}.fmlens`, o), save.saveId)
      expect(r.status, name).toBe('identity_conflict')
      expect(r.warnings.join(), name).toMatch(why)
      // the selected revision never moved
      expect(svc.listMatches(save.saveId).matches[0]!.selectedRecordingRevisionId, name).toBe(base)
    }
    expect(svc.listMatches(save.saveId).matches[0]!.conflictingRevisions).toBe(cases.length)
    expect(svc.store.getRevision(a.recordingRevisionId!)!.relation).toBeNull()
    svc.close()
  }, 180_000)

  it('recording resolve --as continuation verifies a legacy conflict from the frames, and refuses one that is not a verified prefix', async () => {
    const { full, prefix, write } = await pair()
    const home = tmp('fmmi-cont-home-')
    const svc = service(home)
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('prefix.fmlens', prefix), save.saveId)
    const b = await svc.ingestFile(write('full.fmlens', full), save.saveId)
    const c = await svc.ingestFile(write('other.fmlens', { ...full, goals: [{ tick: 603, side: 'away' }] }), save.saveId)
    expect(c.status).toBe('identity_conflict')
    // Rebuild what a Slice 1-4 catalog held: the longer recording of the same match stored as a plain conflict, the prefix selected.
    const raw = new Database(join(home, 'catalog.sqlite'))
    raw.prepare("UPDATE recording_revision SET identity_status='identity_conflict', relation=NULL, parent_revision_id=NULL WHERE recording_revision_id=?").run(b.recordingRevisionId)
    raw.prepare('UPDATE match SET selected_revision_id=? WHERE match_id=?').run(a.recordingRevisionId, a.matchId)
    raw.close()
    expect(svc.listMatches(save.saveId).matches[0]).toMatchObject({ selectedRecordingRevisionId: a.recordingRevisionId, conflictingRevisions: 2 })

    // not a verified prefix: refused with the evidence, nothing changes
    await expect(svc.chooseRecording(c.recordingRevisionId!, 'continuation')).rejects.toMatchObject({ code: 'identity_conflict', details: { reason: 'not_a_verified_prefix', conflict: 'frame_content_differs' } })
    expect(svc.listMatches(save.saveId).matches[0]!.selectedRecordingRevisionId).toBe(a.recordingRevisionId)

    const r = await svc.chooseRecording(b.recordingRevisionId!, 'continuation')
    expect(r).toMatchObject({ resolution: 'continuation', previousSelectedRevisionId: a.recordingRevisionId, parentRevisionId: a.recordingRevisionId })
    expect(svc.store.getRevision(b.recordingRevisionId!)).toMatchObject({ identityStatus: 'ok', relation: 'continuation', parentRevisionId: a.recordingRevisionId })
    expect(svc.listMatches(save.saveId).matches[0]).toMatchObject({ selectedRecordingRevisionId: b.recordingRevisionId, conflictingRevisions: 1 })
    // already resolved: not resolvable twice
    await expect(svc.chooseRecording(b.recordingRevisionId!, 'continuation')).rejects.toMatchObject({ code: 'invalid_input' })
    const audit = svc.store.listAudit().filter((x) => x.action === 'recording.resolve')
    expect(audit.at(-1)!.details).toMatchObject({ as: 'continuation', previousSelectedRevisionId: a.recordingRevisionId, evidence: { relation: 'extends' } })
    svc.close()
  }, 180_000)

  it('recording resolve --as alternate is the user\'s explicit choice of a conflicting recording: it becomes selected, the other stays pinnable, nothing is merged', async () => {
    const { full, write } = await pair()
    const svc = service()
    const save = svc.createSave('S')
    const a = await svc.ingestFile(write('full.fmlens', full), save.saveId)
    const c = await svc.ingestFile(write('other.fmlens', { ...full, goals: [{ tick: 603, side: 'away' }] }), save.saveId)
    expect(c.status).toBe('identity_conflict')
    const r = await svc.chooseRecording(c.recordingRevisionId!, 'alternate')
    expect(r).toMatchObject({ resolution: 'alternate', previousSelectedRevisionId: a.recordingRevisionId, parentRevisionId: null })
    expect(r.warnings.join()).toMatch(/stays inspectable/)
    expect(svc.store.getRevision(c.recordingRevisionId!)).toMatchObject({ identityStatus: 'ok', relation: 'alternate', parentRevisionId: null })
    const show = svc.showMatch(a.matchId!)
    expect(show.result.observed).toMatchObject({ home: 0, away: 1 }) // the alternate recording's own score
    expect(svc.showMatch(a.matchId!, { revisionId: a.recordingRevisionId }).result.observed).toMatchObject({ home: 1, away: 0 }) // the earlier one, unchanged
    expect(show.revisions).toHaveLength(2)
    svc.close()
  }, 120_000)

  it('CLI: fmmi recording resolve accepts continuation and alternate, names the earlier revision, and rejects an unknown choice with a usage error', async () => {
    const { full, prefix, write } = await pair()
    const home = tmp('fmmi-cont-cli-')
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const run = async (...a: string[]) => { out.length = 0; err.length = 0; const code = await main([...a, '--json'], io); return { code, body: out.length ? JSON.parse(out.join('\n')) : null } }
    const saveId = (await run('save', 'create', 'S')).body.data.saveId as string
    const ing = async (f: string) => (await run('ingest', f, '--save', saveId)).body.data.results[0]
    const a = await ing(write('prefix.fmlens', prefix))
    const conflict = await ing(write('other.fmlens', { ...full, goals: [{ tick: 603, side: 'away' }] }))
    expect(conflict.status).toBe('identity_conflict')
    expect((await run('recording', 'resolve', conflict.recordingRevisionId, '--as', 'nonsense')).code).toBe(2)
    const refused = await run('recording', 'resolve', conflict.recordingRevisionId, '--as', 'continuation')
    expect(refused.code).toBe(1)
    expect(refused.body.error).toMatchObject({ code: 'identity_conflict', details: { reason: 'not_a_verified_prefix' } })
    const ok = await run('recording', 'resolve', conflict.recordingRevisionId, '--as', 'alternate')
    expect(ok.code).toBe(0)
    expect(ok.body.data).toMatchObject({ resolution: 'alternate', previousSelectedRevisionId: a.recordingRevisionId })
    const text: string[] = []
    const code = await main(['status'], { ...io, out: (s) => text.push(s) })
    expect(code).toBe(0)
  }, 120_000)
})

describe.skipIf(!HAS_REAL)('[S5] continuation on a REAL recording: a truncated copy is a true prefix of the real frames', () => {
  it('importing the truncated copy and then the whole file extends it; the real score and roster are unchanged from a direct import', async () => {
    const bytes = readFileSync(REAL_FIXTURE)
    const dir = tmp('fmmi-real-cont-')
    const cut = join(dir, 'real-cut.fmlens')
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)))
    const svc = service()
    const save = svc.createSave('Real')
    const a = await svc.ingestFile(cut, save.saveId)
    expect(a.status).toBe('ingested')
    expect(a.integrity).toBe('recovered_prefix')
    const b = await svc.ingestFile(REAL_FIXTURE, save.saveId)
    expect(b.status).toBe('continuation')
    const direct = service()
    const ds = direct.createSave('Direct')
    const d = await direct.ingestFile(REAL_FIXTURE, ds.saveId)
    const x = svc.showMatch(a.matchId!), y = direct.showMatch(d.matchId!)
    expect(x.result.observed).toEqual(y.result.observed)
    expect(x.teamTotals).toEqual(y.teamTotals)
    expect(x.roster.map((p) => [p.name, p.participation.elapsedTicks])).toEqual(y.roster.map((p) => [p.name, p.participation.elapsedTicks]))
    expect(svc.showMatch(a.matchId!, { revisionId: a.recordingRevisionId }).status.integrity.status).toBe('recovered_prefix')
    svc.close(); direct.close()
  }, 240_000)
})

describe('[S5] catalog schema v3', () => {
  it('a v2 catalog upgrades in place to v3: revisions keep their data and gain a null relation; a read-only reader refuses v2 until the CLI migrates it', async () => {
    expect(MIGRATIONS).toHaveLength(3)
    const home = tmp('fmmi-v2-')
    const db = new Database(join(home, 'catalog.sqlite'))
    db.exec(MIGRATIONS[0]!); db.exec(MIGRATIONS[1]!)
    db.pragma('user_version = 2')
    db.prepare("INSERT INTO save_profile (save_id, display_name, season_start, created_at) VALUES ('s_old','Old','07-01','2026-01-01')").run()
    db.close()
    expect(() => new CatalogService({ ...loadConfig(home, {}), readOnly: true })).toThrowError(/does not match this build/)
    const svc = new CatalogService(loadConfig(home, {}))
    expect(svc.store.schemaVersion()).toBe(3)
    expect(svc.listSaves().map((s) => s.saveId)).toEqual(['s_old'])
    expect(svc.listLiveNotes()).toEqual([])
    svc.close()
    new CatalogService({ ...loadConfig(home, {}), readOnly: true }).close()
  })
})
