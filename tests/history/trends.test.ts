// Slice 4 acceptance, query layer: pooled season history over LABELLED SYNTHETIC multi-match fixtures (we hold one real recording,
// so multi-match behaviour cannot be proven on real data; tests/history/real.test.ts covers that recording). Isolated catalogs only.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import type { DecodeOptions } from '@fmmi/fmlens-adapter'
import type { DecodedRecording } from '@fmmi/model'
import { aggregateKey, getDefinition } from '@fmmi/analytics'
import { MatchQueries } from '@fmmi/query'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { FIVE, buildSeasonMatch, confirmObserved, ingestSeason, periodsOf, writeSynth } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

class CountingDecoder extends FmlensV28Decoder {
  count = 0
  override async decode(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodedRecording> { this.count++; return super.decode(bytes, options) }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
async function fresh(specs: SeasonMatch[], confirm: string[] | 'all' = 'all') {
  const svc = service()
  const saveId = svc.createSave('Synthetic Town').saveId
  const ids = await ingestSeason(svc, saveId, specs)
  for (const k of confirm === 'all' ? Object.keys(ids) : confirm) confirmObserved(svc, ids[k]!.matchId)
  const q = new MatchQueries(svc)
  const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
  return { svc, saveId, ids, q, teamId }
}

describe('Slice 4: five-match review, contributing matches and reconciliation', () => {
  let t: Awaited<ReturnType<typeof fresh>>
  beforeAll(async () => { t = await fresh(FIVE) }, 120_000)

  it('AC1 the five-match review lists the exact contributing matches and recording revisions, oldest first', async () => {
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    expect(r.windows).toHaveLength(1)
    expect(r.windows[0]!.matchIds).toEqual(FIVE.map((m) => t.ids[m.key]!.matchId))
    expect(r.matches.map((m) => [m.matchId, m.recordingRevisionId])).toEqual(FIVE.map((m) => [t.ids[m.key]!.matchId, t.ids[m.key]!.revisionId]))
    expect(r.matches.map((m) => m.date)).toEqual(FIVE.map((m) => m.date))
    expect(r.matches.map((m) => m.opponent.name)).toEqual(FIVE.map((m) => m.opponent))
    expect(r.excluded).toEqual([])
    expect(r.eligibleMatches).toBe(5)
  })

  it('AC1 per-90 rates and totals reconcile: the rate numerator is the total, the denominator the total minutes, and both equal the sum of the per-match records', async () => {
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    const w = r.windows[0]!
    const shows = FIVE.map((m) => ({ m, s: t.svc.showMatch(t.ids[m.key]!.matchId) }))
    const own = (k: string) => sum(shows.map((x) => x.s.teamTotals[x.m.side][k] ?? 0))
    const oppo = (k: string) => sum(shows.map((x) => x.s.teamTotals[x.m.side === 'home' ? 'away' : 'home'][k] ?? 0))
    expect(w.totals.goalsFor).toBe(own('goals'))
    expect(w.totals.goalsAgainst).toBe(oppo('goals'))
    expect(w.totals.xgFor).toBeCloseTo(own('xg'), 5)
    expect(w.totals.shotsFor).toBe(own('shots'))
    const minutes = sum(shows.map((x) => (x.s.status.coverage.periods.reduce((a, p) => a + (p.lastTick - p.firstTick), 0)) / 240))
    expect(w.totals.minutes).toBeCloseTo(minutes, 6)
    const row = (id: string) => w.rates.find((x) => x.metric === id)!
    for (const [id, total] of [['goals_per_90', w.totals.goalsFor], ['goals_against_per_90', w.totals.goalsAgainst], ['xg_per_90', w.totals.xgFor]] as const) {
      expect(row(id).numerator, id).toBeCloseTo(total as number, 5)
      expect(row(id).denominator, id).toBeCloseTo(w.totals.minutes, 6)
      expect(row(id).value, id).toBeCloseTo((90 * (total as number)) / w.totals.minutes, 6)
      expect(row(id).contributing.matches).toBe(5)
      expect(row(id).contributing.minutes).toBeCloseTo(w.totals.minutes, 1)
      expect(row(id).contributing.matchIds).toBeUndefined() // every match in the window contributed
    }
    expect(w.record).toMatchObject({ matches: 5, won: 3, drawn: 2, lost: 0, manualScores: 5 })
    expect(w.matchIds).toHaveLength(5)
  })

  it('AC1 the last 10 over five eligible matches is the same five matches and says so instead of repeating the figures', async () => {
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId })
    expect(r.windows.map((w) => w.lastN)).toEqual([5, 10])
    expect(r.windows[1]).toMatchObject({ sameMatchesAsWindow: 5, rates: [] })
    expect(r.windows[1]!.matchIds).toEqual(r.windows[0]!.matchIds)
    expect(r.warnings).toContain('window_10_has_only_5_eligible_matches')
  })

  it('AC2 ratios pool numerators and denominators: the pooled aerial win percentage is not the mean of the match percentages', async () => {
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, metrics: ['aerial_win_pct', 'pass_completion_pct', 'shot_quality'] })
    const row = r.windows[0]!.rates.find((x) => x.metric === 'aerial_win_pct')!
    const per = FIVE.map((m) => { const s = t.svc.showMatch(t.ids[m.key]!.matchId).teamTotals[m.side]; return { won: s.aerialsWon!, att: s.aerials! } })
    const pooled = (100 * sum(per.map((p) => p.won))) / sum(per.map((p) => p.att))
    const mean = sum(per.map((p) => (100 * p.won) / p.att)) / per.length
    expect(Math.abs(pooled - mean)).toBeGreaterThan(1) // the two answers genuinely differ on this data
    expect(row.value).toBeCloseTo(pooled, 9)
    expect(row.numerator).toBe(sum(per.map((p) => p.won)))
    expect(row.denominator).toBe(sum(per.map((p) => p.att)))
    expect(row.value).not.toBeCloseTo(mean, 3)
    const sq = r.windows[0]!.rates.find((x) => x.metric === 'shot_quality')!
    const xg = sum(FIVE.map((m) => t.svc.showMatch(t.ids[m.key]!.matchId).teamTotals[m.side].xg!)), shots = sum(FIVE.map((m) => t.svc.showMatch(t.ids[m.key]!.matchId).teamTotals[m.side].shots!))
    expect(sq.value).toBeCloseTo(xg / shots, 6)
  })

  it('AC2 home and away splits are pooled within the window and equal the same query restricted to home or away; an unknown metric id is refused with the allowed list', async () => {
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, metrics: ['goals_per_90', 'aerial_win_pct'] })
    const sp = r.windows[0]!.splits!
    expect([sp.home.matches, sp.away.matches]).toEqual([3, 2])
    for (const side of ['home', 'away'] as const) {
      const only = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, homeAway: side, metrics: ['goals_per_90', 'aerial_win_pct'] })
      expect(only.windows[0]!.matchIds).toHaveLength(sp[side].matches)
      expect(only.windows[0]!.splits).toBeUndefined()
      expect(sp[side].rates.map((x) => [x.metric, x.value])).toEqual(only.windows[0]!.rates.map((x) => [x.metric, x.value]))
    }
    // the two splits pool back to the whole window: sums of numerators and denominators, not averages of rates
    const [h, a] = await Promise.all((['home', 'away'] as const).map((side) => t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, homeAway: side, metrics: ['goals_per_90'] })))
    const total = r.windows[0]!.rates[0]!
    expect(h!.windows[0]!.rates[0]!.numerator! + a!.windows[0]!.rates[0]!.numerator!).toBeCloseTo(total.numerator!, 9)
    expect(h!.windows[0]!.rates[0]!.denominator! + a!.windows[0]!.rates[0]!.denominator!).toBeCloseTo(total.denominator!, 9)
    await expect(t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, metrics: ['not_a_metric'] })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'unknown_metric' } })
  })
})

describe('Slice 4: default eligibility, disclosure and exclusion', () => {
  it('AC2 default trends disclose completed_manual and unconfirmed full-capture matches and exclude partial and conflicting recordings with reasons', async () => {
    const specs: SeasonMatch[] = [
      { key: 'a1', date: '2026-08-01', side: 'home', opponent: 'Alpha FC', goals: [{ tick: 5000, side: 'home' }] },
      { key: 'a2', date: '2026-08-08', side: 'away', opponent: 'Bravo FC' }, // never confirmed, but a full-match capture: it counts, disclosed as unconfirmed
      { key: 'a3', date: '2026-08-15', side: 'home', opponent: 'Charlie FC', periods: periodsOf(15600) }, // ends at 65 minutes
      { key: 'a5', date: '2026-08-22', side: 'away', opponent: 'Delta FC', goals: [{ tick: 9000, side: 'away' }] },
      { key: 'a6', date: '2026-08-29', side: 'home', opponent: 'Echo FC', periods: periodsOf(19938) }, // ends at 83.08 minutes
    ]
    const t = await fresh(specs, ['a1', 'a3', 'a5', 'a6'])
    // A changed archive with the same source identity as a1 is retained as an identity_conflict and is not the selected result.
    const conflict = await t.svc.ingestFile(writeSynth(await buildSeasonMatch({ ...specs[0]!, goals: [{ tick: 5000, side: 'home' }, { tick: 8000, side: 'home' }] }), 'conflict.fmlens'), t.saveId)
    expect(conflict.status).toBe('identity_conflict')

    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    expect(r.windows[0]!.matchIds).toEqual(['a1', 'a2', 'a5', 'a6'].map((k) => t.ids[k]!.matchId))
    const why = (k: string) => r.excluded.find((e) => e.matchId === t.ids[k]!.matchId)!.reasons
    expect(r.excluded.some((e) => e.matchId === t.ids.a2!.matchId)).toBe(false)
    expect(why('a3')).toEqual(['early_ending_below_80_captured_minutes'])
    expect(r.excludedRecordings).toEqual([{ matchId: t.ids.a1!.matchId, recordingRevisionId: conflict.recordingRevisionId, reason: 'identity_conflict' }])
    expect(r.windows[0]!.disclosures).toMatchObject({ manualConfirmation: ['a1', 'a5', 'a6'].map((k) => t.ids[k]!.matchId), earlyEnding: [t.ids.a6!.matchId], fullCaptureUnconfirmed: [t.ids.a2!.matchId] })
    expect(r.windows[0]!.record).toMatchObject({ observedScores: 1, manualScores: 3 })
    expect(r.matches.find((m) => m.matchId === t.ids.a2!.matchId)!.score).toMatchObject({ basis: 'observed' })
    expect(r.warnings).toEqual(expect.arrayContaining(['manual_confirmation_matches: completion was confirmed by the user, not signalled by the recording', expect.stringContaining('early_ending_matches_in_rates')]))
    expect(r.coverage).toBe('partial_for_window')
    // the selected recording of a1 is untouched by the conflicting one
    expect(r.matches.find((m) => m.matchId === t.ids.a1!.matchId)!.recordingRevisionId).toBe(t.ids.a1!.revisionId)

    // explicit partial opt-in: a separate block, never mixed into the main comparison
    const withPartial = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, includePartial: true })
    expect(withPartial.windows).toEqual(r.windows)
    expect(withPartial.partial!.matches.map((m) => m.matchId)).toEqual([t.ids.a3!.matchId])
    expect(withPartial.partial!.matches[0]!.capturedMinutes).toBeCloseTo(65, 1)
    expect(withPartial.partial!.rates.find((x) => x.metric === 'xg_per_90')!.contributing.matches).toBe(1)
    expect((r as { partial?: unknown }).partial).toBeNull()
    t.svc.close()
  }, 120_000)

  it('AC2 a confirmed early-ending match is in the rates but not in the totals, and its goals appear only in the rate numerator', async () => {
    const specs: SeasonMatch[] = [
      { key: 'e1', date: '2026-08-01', side: 'home', opponent: 'Alpha FC', goals: [{ tick: 5000, side: 'home' }] },
      { key: 'e2', date: '2026-08-08', side: 'away', opponent: 'Bravo FC', goals: [{ tick: 6000, side: 'away' }] },
      { key: 'e3', date: '2026-08-15', side: 'home', opponent: 'Charlie FC', goals: [{ tick: 7000, side: 'home' }] },
      { key: 'e4', date: '2026-08-22', side: 'away', opponent: 'Delta FC', goals: [{ tick: 9000, side: 'away' }] },
      { key: 'e5', date: '2026-08-29', side: 'home', opponent: 'Echo FC', periods: periodsOf(19938), goals: [{ tick: 15000, side: 'home' }] },
    ]
    const t = await fresh(specs)
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, metrics: ['goals_per_90'] })
    const w = r.windows[0]!
    expect(w.matchIds).toHaveLength(5)
    const early = r.matches.find((m) => m.matchId === t.ids.e5!.matchId)!
    expect(early).toMatchObject({ class: 'early_ending', disclosures: ['manual_confirmation', 'early_ending'] })
    expect(early.capturedMinutes).toBeCloseTo(83.075, 2)
    expect(w.disclosures.earlyEnding).toEqual([t.ids.e5!.matchId])
    expect(w.totals.matches).toBe(4)
    expect(w.totals.excludedFromTotals).toEqual([{ matchId: t.ids.e5!.matchId, reason: 'early_ending_unseen_time' }])
    expect(w.totals.goalsFor).toBe(4) // the four full-match captures only
    const g = w.rates[0]!
    expect(g.numerator).toBe(5) // the rate includes the early-ending match goal
    expect(g.denominator).toBeCloseTo(w.totals.minutes + early.capturedMinutes, 1) // measured minutes, not a nominal 90
    expect(g.value).toBeCloseTo((90 * 5) / g.denominator!, 9)
    // a manual final score still decides the record of the early-ending match, labelled manual
    expect(early.score).toMatchObject({ for: 1, against: 0, basis: 'manual', outcome: 'win' })
    expect(r.coverage).toBe('partial_for_window')
    t.svc.close()
  }, 120_000)

  it('AC2 the 80-minute early-ending floor is inclusive: exactly 80.00 and 80.00+ are in the rates, 79.996 is excluded', async () => {
    const specs: SeasonMatch[] = [
      { key: 'b1', date: '2026-08-01', side: 'home', opponent: 'Alpha FC', periods: periodsOf(19199) }, // 79.996 min
      { key: 'b2', date: '2026-08-08', side: 'away', opponent: 'Bravo FC', periods: periodsOf(19200) }, // 80.000 min
      { key: 'b3', date: '2026-08-15', side: 'home', opponent: 'Charlie FC', periods: periodsOf(19201) }, // 80.004 min
    ]
    const t = await fresh(specs)
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, metrics: ['goals_per_90'] })
    expect(r.windows[0]!.matchIds).toEqual([t.ids.b2!.matchId, t.ids.b3!.matchId])
    expect(r.matches.find((m) => m.matchId === t.ids.b2!.matchId)!.capturedMinutes).toBe(80)
    expect(r.excluded).toEqual([{ matchId: t.ids.b1!.matchId, date: '2026-08-01', reasons: ['early_ending_below_80_captured_minutes'] }])
    expect(r.windows[0]!.totals.matches).toBe(0)
    t.svc.close()
  }, 120_000)

  it('AC2 a manual final score is labelled manual, drives the record, and never alters the observed counters or totals', async () => {
    const t = await fresh([
      { key: 'm1', date: '2026-08-01', side: 'home', opponent: 'Alpha FC', goals: [{ tick: 5000, side: 'home' }] },
      { key: 'm2', date: '2026-08-08', side: 'home', opponent: 'Bravo FC', goals: [] },
    ], ['m1'])
    t.svc.confirmMatch(t.ids.m2!.matchId, '2-0', { allowScoreChange: true }) // observed 0-0; goals after the last frame are unseen
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5, metrics: ['goals_per_90'] })
    const m2 = r.matches.find((m) => m.matchId === t.ids.m2!.matchId)!
    expect(m2.score).toEqual({ for: 2, against: 0, basis: 'manual', outcome: 'win' })
    expect(m2.disclosures).toContain('manual_final_score_differs_from_observed')
    expect(r.windows[0]!.disclosures.manualFinalScoreDiffersFromObserved).toEqual([t.ids.m2!.matchId])
    expect(r.windows[0]!.record).toMatchObject({ won: 2, manualScores: 2, goalsForPerScore: 3 })
    expect(r.windows[0]!.totals.goalsFor).toBe(1) // observed counters: 1 + 0, not the manual 2
    expect(r.windows[0]!.rates[0]!.numerator).toBe(1)
    t.svc.close()
  }, 120_000)
})

describe('Slice 4: cached versioned aggregates', () => {
  it('AC4 five matches are served from the cached aggregates without decoding any archive again', async () => {
    const dec = new CountingDecoder()
    const home = tmp()
    const svc = new CatalogService(loadConfig(home, {}), dec)
    const saveId = svc.createSave('S').saveId
    const ids = await ingestSeason(svc, saveId, FIVE)
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const decodedAtIngest = dec.count
    expect(decodedAtIngest).toBe(5)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const a = await q.seasonTrends({ saveId, teamId, lastN: 5 })
    const b = await q.seasonTrends({ saveId, teamId, lastN: 5 })
    expect(dec.count).toBe(decodedAtIngest)
    expect(q.cache.stats().misses).toBe(0)
    expect(a.source).toMatchObject({ aggregateKey: aggregateKey(), aggregates: 5, servedFromCatalog: 5, servedFromMemory: 0, builtThisCall: 0, persistedThisCall: 0 })
    expect(b.windows).toEqual(a.windows)
    svc.close()
  }, 120_000)

  it('AC4 re-ingesting an archive repairs a missing aggregate; changing a metric formula version rebuilds them and a stale value is never served', async () => {
    const dec = new CountingDecoder()
    const home = tmp()
    const svc = new CatalogService(loadConfig(home, {}), dec)
    const saveId = svc.createSave('S').saveId
    const ids = await ingestSeason(svc, saveId, FIVE)
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const raw = new Database(join(home, 'catalog.sqlite'))
    try {
      const base = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
      const goals = base.windows[0]!.rates[0]!.numerator!
      expect(goals).toBe(5)
      const key1 = aggregateKey()

      // 1. The aggregate row is what a query reads: a tampered row is served, with no decode.
      const before = dec.count
      raw.prepare(`UPDATE match_aggregate SET json = json_set(json, '$.sides.home.counters.goals', 99, '$.sides.away.counters.goals', 99) WHERE recording_revision_id = ?`).run(ids.f1!.revisionId)
      const tampered = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
      expect(tampered.windows[0]!.rates[0]!.numerator).toBeGreaterThan(90)
      expect(dec.count).toBe(before)

      // 2. A changed formula (definition version) changes the key: every aggregate is rebuilt from the snapshots and the sentinel is gone.
      const def = getDefinition('goals')
      const old = def.version
      def.version = old + 1
      try {
        expect(aggregateKey()).not.toBe(key1)
        const rebuilt = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
        expect(rebuilt.windows[0]!.rates[0]!.numerator).toBe(5)
        expect(rebuilt.source).toMatchObject({ aggregateKey: aggregateKey(), servedFromCatalog: 0, builtThisCall: 5, persistedThisCall: 5 })
        expect(dec.count).toBe(before + 5)
        const keys = raw.prepare('SELECT aggregate_key AS k, COUNT(*) AS n FROM match_aggregate GROUP BY aggregate_key').all() as Array<{ k: string; n: number }>
        expect(keys).toEqual([{ k: aggregateKey(), n: 5 }]) // the stale rows were replaced, not kept
        const again = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
        expect(again.source).toMatchObject({ servedFromCatalog: 5, builtThisCall: 0 })
        expect(dec.count).toBe(before + 5)
      } finally { def.version = old }

      // 3. Back on the old formula the rows stored for the other version are stale again and are rebuilt, never served.
      const back = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
      expect(aggregateKey()).toBe(key1)
      expect(back.source).toMatchObject({ servedFromCatalog: 0, builtThisCall: 5 })
      expect(back.windows[0]!.rates[0]!.numerator).toBe(5)

      // 4. Re-ingesting the same file is idempotent and restores a deleted aggregate.
      const stored = raw.prepare('SELECT json FROM match_aggregate WHERE recording_revision_id = ?').get(ids.f2!.revisionId) as { json: string }
      raw.prepare('DELETE FROM match_aggregate WHERE recording_revision_id = ?').run(ids.f2!.revisionId)
      const re = await svc.ingestFile(ids.f2!.file, saveId)
      expect(re.status).toBe('already_ingested')
      expect((raw.prepare('SELECT json FROM match_aggregate WHERE recording_revision_id = ?').get(ids.f2!.revisionId) as { json: string }).json).toBe(stored.json)
      expect(svc.listMatches(saveId).matches).toHaveLength(5)
    } finally { raw.close(); svc.close() }
  }, 180_000)

  it('AC4 a read-only reader (the MCP server) rebuilds a stale aggregate in memory without writing, then serves it from memory with no further decoding', async () => {
    const home = tmp()
    const w = new CatalogService(loadConfig(home, {}))
    const saveId = w.createSave('S').saveId
    const ids = await ingestSeason(w, saveId, FIVE)
    for (const k of Object.keys(ids)) confirmObserved(w, ids[k]!.matchId)
    w.close()
    const dec = new CountingDecoder()
    const ro = new CatalogService({ ...loadConfig(home, {}), readOnly: true }, dec)
    const q = new MatchQueries(ro)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const raw = new Database(join(home, 'catalog.sqlite'), { readonly: true })
    const snapshot = () => JSON.stringify(raw.prepare('SELECT recording_revision_id, aggregate_key, json FROM match_aggregate ORDER BY 1').all())
    const def = getDefinition('goals')
    const old = def.version
    def.version = old + 1
    try {
      const rows0 = snapshot()
      const first = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
      expect(first.source).toMatchObject({ builtThisCall: 5, persistedThisCall: 0, servedFromCatalog: 0 })
      expect(first.windows[0]!.rates[0]!.numerator).toBe(5)
      expect(dec.count).toBe(5)
      const second = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
      expect(second.source).toMatchObject({ servedFromMemory: 5, builtThisCall: 0 })
      expect(dec.count).toBe(5)
      expect(snapshot()).toBe(rows0) // the read-only catalog was not written
    } finally { def.version = old; raw.close(); ro.close() }
  }, 180_000)
})

describe('Slice 4: save isolation', () => {
  it('AC5 two saves of the same club do not merge matches, teams or persistent players', async () => {
    const svc = service()
    const a = svc.createSave('Farnham save A').saveId, b = svc.createSave('Farnham save B').saveId
    const ia = await ingestSeason(svc, a, FIVE)
    const ib = await ingestSeason(svc, b, FIVE.slice(0, 3))
    for (const k of Object.keys(ia)) confirmObserved(svc, ia[k]!.matchId)
    for (const k of Object.keys(ib)) confirmObserved(svc, ib[k]!.matchId)
    const q = new MatchQueries(svc)
    const teamA = q.listMatches({ saveId: a }).matches[0]!.managedTeamId!, teamB = q.listMatches({ saveId: b }).matches[0]!.managedTeamId!
    expect(teamA).not.toBe(teamB)
    const ra = await q.seasonTrends({ saveId: a, teamId: teamA, lastN: 10 })
    const rb = await q.seasonTrends({ saveId: b, teamId: teamB, lastN: 10 })
    expect(ra.windows[0]!.matchIds).toHaveLength(5)
    expect(rb.windows[0]!.matchIds).toHaveLength(3)
    expect(new Set([...ra.windows[0]!.matchIds, ...rb.windows[0]!.matchIds]).size).toBe(8)
    await expect(q.seasonTrends({ saveId: a, teamId: teamB })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'not_in_save' } })
    const pa = q.listPlayers({ saveId: a, nameQuery: 'Alexander' }).players[0] as { playerId: string; supportingMatchIds: string[] }
    const pb = q.listPlayers({ saveId: b, nameQuery: 'Alexander' }).players[0] as { playerId: string; supportingMatchIds: string[] }
    expect(pa.playerId).not.toBe(pb.playerId) // save-scoped: the same uid in two saves is two players
    expect(pa.supportingMatchIds).toHaveLength(5)
    expect(pb.supportingMatchIds).toHaveLength(3)
    await expect(q.playerTrends({ saveId: b, playerIds: [pa.playerId] })).rejects.toMatchObject({ code: 'not_found' })
    // the same archive in both saves is two revisions (isolated by save), each in its own aggregate row
    expect(ia.f1!.revisionId).not.toBe(ib.f1!.revisionId)
    svc.close()
  }, 180_000)
})
