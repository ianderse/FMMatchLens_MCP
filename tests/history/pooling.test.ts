// Slice 4: missing fields, recipient-gate exclusions, unused substitutes, replayed fixtures and ordering. Labelled synthetic fixtures.
import { afterAll, describe, expect, it } from 'vitest'
import { seasonTrends, playerTrends, eligibilityOf, DEFAULT_TEAM_METRICS } from '@fmmi/analytics'
import type { MatchAggregate, PlayerMatchInput, TrendMatchInput } from '@fmmi/analytics'
import { MatchQueries } from '@fmmi/query'
import { cleanupAll, service } from '../support/helpers.ts'
import { buildSeasonMatch, confirmObserved, ingestSeason, writeSynth } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

const m = (key: string, date: string, side: 'home' | 'away', over: Partial<SeasonMatch> = {}): SeasonMatch => ({ key, date, side, opponent: `Opp ${key.toUpperCase()}`, passesPerSide: 60, ...over })

async function fresh(specs: SeasonMatch[]) {
  const svc = service()
  const saveId = svc.createSave('Synthetic Town').saveId
  const ids = await ingestSeason(svc, saveId, specs)
  for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
  const q = new MatchQueries(svc)
  const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
  return { svc, saveId, ids, q, teamId }
}

describe('Slice 4: pooling with missing fields (pure functions over stored aggregates)', () => {
  it('AC a match with a missing counter contributes to neither numerator nor denominator of that metric, and is listed with the reason; other metrics are untouched', async () => {
    const t = await fresh([
      m('p1', '2026-08-01', 'home', { teamShots: { shots: 4, xg: 0.8 }, goals: [{ tick: 5000, side: 'home' }] }),
      m('p2', '2026-08-08', 'away', { teamShots: { shots: 2, xg: 0.5 } }),
      m('p3', '2026-08-15', 'home', { teamShots: { shots: 6, xg: 1.5 }, goals: [{ tick: 6000, side: 'home' }, { tick: 9000, side: 'home' }] }),
    ])
    const inputs: TrendMatchInput[] = []
    for (const k of ['p1', 'p2', 'p3']) {
      const rev = t.svc.store.getRevision(t.ids[k]!.revisionId)!
      const mm = t.svc.store.getMatch(rev.matchId)!
      const agg: MatchAggregate = structuredClone((await t.svc.ensureAggregate(rev.recordingRevisionId)).aggregate)
      const side = mm.homeTeamId === t.teamId ? 'home' : 'away'
      inputs.push({
        matchId: mm.matchId, recordingRevisionId: rev.recordingRevisionId, date: mm.matchDate, season: mm.season, importedAt: mm.createdAt, side, teamId: t.teamId,
        opponent: { teamId: side === 'home' ? mm.awayTeamId : mm.homeTeamId, name: 'x' }, identityStatus: 'ok', completion: 'completed_manual',
        manualFinalScore: { home: 0, away: 0, differsFromObserved: false }, conflictingRevisionIds: [], aggregate: agg,
      })
    }
    const opts = { lastN: [5], metrics: ['xg_per_90', 'shot_quality', 'goals_per_90', 'pass_completion_pct'], includePartial: false, withSplits: false }
    const full = seasonTrends(inputs, opts).windows[0]!.rates
    // second match loses its xG counter (as if the field were not recorded)
    const broken = structuredClone(inputs)
    const side2 = broken[1]!.side
    broken[1]!.aggregate.sides[side2].counters.xg = null
    broken[1]!.aggregate.sides[side2].nullReasons.xg = 'missing_baseline'
    const cut = seasonTrends(broken, opts).windows[0]!.rates
    const row = (rs: typeof full, id: string) => rs.find((r) => r.metric === id)!
    // xg: numerator and denominator both drop the match; the rate is over the other two matches' minutes
    const mins = (i: number) => inputs[i]!.aggregate.facts.capturedTicks / 240
    expect(row(cut, 'xg_per_90').excluded).toEqual([{ matchId: inputs[1]!.matchId, reason: 'missing_baseline' }])
    expect(row(cut, 'xg_per_90').contributing).toMatchObject({ matches: 2, matchIds: [inputs[0]!.matchId, inputs[2]!.matchId] })
    expect(row(cut, 'xg_per_90').denominator).toBeCloseTo(mins(0) + mins(2), 9)
    const xgOf = (i: number) => inputs[i]!.aggregate.sides[inputs[i]!.side].counters.xg!
    expect(row(cut, 'xg_per_90').numerator).toBeCloseTo(xgOf(0) + xgOf(2), 9)
    expect(row(cut, 'xg_per_90').value).toBeCloseTo((90 * (xgOf(0) + xgOf(2))) / (mins(0) + mins(2)), 9)
    // shot quality (xg / shots) also needs xg: the match drops out of its numerator AND its shots denominator
    const shotsOf = (i: number) => inputs[i]!.aggregate.sides[inputs[i]!.side].counters.shots!
    expect(row(cut, 'shot_quality').numerator).toBeCloseTo(xgOf(0) + xgOf(2), 9)
    expect(row(cut, 'shot_quality').denominator).toBe(shotsOf(0) + shotsOf(2))
    expect(row(full, 'shot_quality').denominator).toBe(shotsOf(0) + shotsOf(1) + shotsOf(2))
    // metrics that do not use the missing field are unchanged
    expect(row(cut, 'goals_per_90')).toEqual(row(full, 'goals_per_90'))
    expect(row(cut, 'pass_completion_pct')).toEqual(row(full, 'pass_completion_pct'))
    // a metric whose every match is missing is null with a reason, never zero
    for (const b of broken) { const sd = b.side; b.aggregate.sides[sd].counters.xg = null; b.aggregate.sides[sd].nullReasons.xg = 'not_recorded' }
    const none = row(seasonTrends(broken, opts).windows[0]!.rates, 'xg_per_90')
    expect(none).toMatchObject({ value: null, nullReason: 'missing_baseline', numerator: null, denominator: null })
    expect(none.contributing.matches).toBe(0)
    expect(DEFAULT_TEAM_METRICS).toContain('xg_per_90')
    expect(eligibilityOf(inputs[0]!).rates).toBe(true)
    t.svc.close()
  }, 120_000)
})

describe('Slice 4: player metrics respect the per-recording recipient gate and playing time', () => {
  it('AC a recording that fails the recipient gate is excluded from the reception metrics with a reason, and still counts for the others; a substitute who did not play contributes nothing', async () => {
    const t = await fresh([
      m('r1', '2026-08-01', 'home'),
      m('r2', '2026-08-08', 'home', { dropReceiver: (side) => side === 'home' }), // every club pass loses its receiver: coverage 0% < 95%
      m('r3', '2026-08-15', 'home', { subTick: 99_999, strikerAerials: { attempts: 5, won: 1 } }), // the substitute never enters
    ])
    const alex = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Alexander' }).players[0] as { playerId: string }).playerId
    const bing = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Bingham' }).players[0] as { playerId: string }).playerId
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [alex, bing], lastN: 5, metrics: ['passes_received_per_90', 'passes_received_pct_of_team_completed', 'aerial_win_pct', 'progressive_passes_per_90'] })
    const [a, b] = r.players
    const row = (p: typeof a, metric: string) => p!.windows[0]!.rates.find((x) => x.metric === metric)!
    const id = (k: string) => t.ids[k]!.matchId
    // Alexander: the gate failure removes r2 from both reception metrics only
    expect(row(a, 'passes_received_per_90').excluded).toEqual([{ matchId: id('r2'), reason: 'recipient_gate_failed' }])
    expect(row(a, 'passes_received_per_90').contributing.matchIds).toEqual([id('r1'), id('r3')])
    expect(row(a, 'passes_received_pct_of_team_completed').excluded).toEqual([{ matchId: id('r2'), reason: 'recipient_gate_failed' }])
    expect(row(a, 'aerial_win_pct').excluded).toBeUndefined()
    expect(row(a, 'progressive_passes_per_90').excluded).toBeUndefined()
    expect(row(a, 'aerial_win_pct').contributing.matches).toBe(3)
    // the exposure behind a reception comparison counts only the recordings that passed the gate
    expect(a!.windows[0]!.exposure.receptions.matches).toBe(2)
    expect(a!.windows[0]!.exposure.progression.matches).toBe(3)
    // Bingham: r2 fails the gate; in r3 he did not play. Neither contributes to his reception metrics.
    expect(row(b, 'passes_received_per_90').excluded).toEqual(expect.arrayContaining([{ matchId: id('r2'), reason: 'recipient_gate_failed' }, { matchId: id('r3'), reason: 'did_not_play' }]))
    expect(row(b, 'passes_received_per_90').contributing).toMatchObject({ matches: 1, matchIds: [id('r1')] })
    expect(row(b, 'aerial_win_pct').excluded).toEqual([{ matchId: id('r3'), reason: 'did_not_play' }])
    expect(b!.windows[0]!.matchMinutes).toEqual([expect.any(Number), expect.any(Number), 0]) // the unused substitute has zero minutes in r3
    expect(r.warnings).toContain('recipient_gate_failed_recordings_excluded_from_reception_metrics')
    // the per-recording gate is what decides: the stored aggregate says so
    const rev2 = (await t.svc.ensureAggregate(t.ids.r2!.revisionId)).aggregate
    expect(rev2.sides.home.recipientGate.status).toBe('fail')
    expect(rev2.sides.home.recipientGate.reasons).toContain('recipient_coverage_below_threshold')
    // Bingham's reception exposure is one recording of about 34 minutes and about 22 team passes: under the 30-pass gate, so that comparison is
    // suppressed with the reason, while the progression comparison (two recordings) is qualified
    const c = r.comparisons.find((x) => x.comparator === bing)!
    expect(c.passesReceivedPer90).toBeNull()
    expect(c.reasons).toEqual(expect.arrayContaining(['comparator:fewer_than_30_team_completed_passes']))
    expect(c.progressivePassesPer90).not.toBeNull()
    expect(c.status).toBe('qualified')
    t.svc.close()
  }, 120_000)

  it('AC a reception rate comparison is suppressed when the exposure gates fail in a window (under 15 minutes or under 30 team passes)', async () => {
    const t = await fresh([m('x1', '2026-08-01', 'home', { passesPerSide: 20 }), m('x2', '2026-08-08', 'away', { passesPerSide: 20 })])
    const alex = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Alexander' }).players[0] as { playerId: string }).playerId
    const bing = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Bingham' }).players[0] as { playerId: string }).playerId
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [alex, bing], lastN: 5, metrics: ['passes_received_per_90', 'progressive_passes_per_90'] })
    const c = r.comparisons[0]!
    expect(c.status).toBe('suppressed')
    expect(c.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/team_completed_passes/)]))
    expect(c.passesReceivedPer90).toBeNull()
    t.svc.close()
  }, 120_000)

  it('AC a player with no receptions at all is still comparable when the exposure gates pass in each window (low service is reportable)', async () => {
    const t = await fresh([m('y1', '2026-08-01', 'home'), m('y2', '2026-08-08', 'away')])
    const alex = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Alexander' }).players[0] as { playerId: string }).playerId
    const bing = (t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Bingham' }).players[0] as { playerId: string }).playerId
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [alex, bing], lastN: 5, metrics: ['passes_received_per_90'] })
    expect(r.players[0]!.windows[0]!.rates[0]).toMatchObject({ numerator: 0, contributing: { matches: 2 } })
    expect(r.comparisons[0]).toMatchObject({ status: 'qualified', passesReceivedPer90: { subject: 0, direction: 'lower' } })
    t.svc.close()
  }, 120_000)

  it('AC playerTrends is pure over its inputs: the same aggregates give the same windows in any input order', async () => {
    const t = await fresh([m('z1', '2026-08-01', 'home'), m('z2', '2026-08-08', 'away'), m('z3', '2026-08-15', 'home')])
    const alex = t.q.listPlayers({ saveId: t.saveId, nameQuery: 'Alexander' }).players[0] as { playerId: string }
    const entity = t.svc.store.getEntity(alex.playerId)!
    const obs = t.svc.store.listSelectedObservations(t.saveId)
    const items: PlayerMatchInput[] = []
    for (const mem of entity.members) {
      const o = obs.find((x) => x.localPlayerId === mem.localPlayerId)!
      const mm = t.svc.store.getMatch(o.matchId)!
      const rev = t.svc.store.getRevision(mm.selectedRevisionId)!
      const agg = (await t.svc.ensureAggregate(rev.recordingRevisionId)).aggregate
      items.push({
        matchId: mm.matchId, recordingRevisionId: rev.recordingRevisionId, date: mm.matchDate, season: mm.season, importedAt: mm.createdAt, side: o.side, teamId: o.teamId,
        opponent: { teamId: 'x', name: 'x' }, identityStatus: 'ok', completion: 'completed_manual', manualFinalScore: { home: 0, away: 0, differsFromObserved: false },
        conflictingRevisionIds: [], aggregate: agg, player: agg.players.find((p) => p.localPlayerId === mem.localPlayerId)!,
      })
    }
    const o = { lastN: [2, 5], metrics: ['aerial_win_pct', 'passes_received_per_90'] }
    const a = playerTrends(items, o), b = playerTrends([...items].reverse(), o)
    expect(b).toEqual(a)
    const byDate = [...items].sort((x, y) => (x.date! < y.date! ? -1 : 1)).map((i) => i.matchId)
    expect(a.windows[0]!.matchIds).toEqual(byDate.slice(-2))
    t.svc.close()
  }, 120_000)
})

describe('Slice 4: ordering by in-game date and replayed fixtures', () => {
  it('AC matches are ordered by in-game date, not import order; a replayed fixture is a separate occurrence and keeps its place', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    // imported out of order, and the same fixture recorded twice (a replay: another source match id, same date and opponent)
    const ids = await ingestSeason(svc, saveId, [
      m('o3', '2026-08-22', 'home'), m('o1', '2026-08-01', 'away'), m('o2', '2026-08-08', 'home', { opponent: 'Replay FC' }),
      m('o2b', '2026-08-08', 'home', { opponent: 'Replay FC', goals: [{ tick: 4000, side: 'home' }] }),
    ])
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const r = await q.seasonTrends({ saveId, teamId, lastN: 10, metrics: ['goals_per_90'] })
    expect(r.windows[0]!.matchIds).toEqual([ids.o1!.matchId, ids.o2!.matchId, ids.o2b!.matchId, ids.o3!.matchId]) // date order; same-day replay by import time
    expect(new Set(r.windows[0]!.matchIds).size).toBe(4)
    const last2 = await q.seasonTrends({ saveId, teamId, lastN: 2, metrics: ['goals_per_90'] })
    expect(last2.windows[0]!.matchIds).toEqual([ids.o2b!.matchId, ids.o3!.matchId])
    svc.close()
  }, 120_000)

  it('AC a conflicting recording resolved as a separate occurrence becomes its own match in the trends once confirmed; an ignored one stays out', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const spec = m('q1', '2026-08-01', 'home', { goals: [{ tick: 5000, side: 'home' }] })
    const ids = await ingestSeason(svc, saveId, [spec, m('q2', '2026-08-08', 'away')])
    const again = await svc.ingestFile(writeSynth(await buildSeasonMatch({ ...spec, goals: [{ tick: 5000, side: 'home' }, { tick: 9000, side: 'home' }] }), 'again.fmlens'), saveId)
    expect(again.status).toBe('identity_conflict')
    const ignored = await svc.ingestFile(writeSynth(await buildSeasonMatch({ ...spec, goals: [] }), 'ignored.fmlens'), saveId)
    expect(ignored.status).toBe('identity_conflict')
    confirmObserved(svc, ids.q1!.matchId); confirmObserved(svc, ids.q2!.matchId)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const before = await q.seasonTrends({ saveId, teamId, lastN: 10 })
    expect(before.windows[0]!.matchIds).toEqual([ids.q1!.matchId, ids.q2!.matchId])
    expect(before.excludedRecordings.map((e) => e.recordingRevisionId).sort()).toEqual([again.recordingRevisionId!, ignored.recordingRevisionId!].sort())
    const res = svc.resolveRecording(again.recordingRevisionId!, 'separate-occurrence')
    svc.resolveRecording(ignored.recordingRevisionId!, 'ignored')
    confirmObserved(svc, res.matchId)
    const after = await q.seasonTrends({ saveId, teamId, lastN: 10 })
    // the resolved occurrence has q1's date and a later import time, so it follows q1 and precedes q2
    expect(after.windows[0]!.matchIds).toEqual([ids.q1!.matchId, res.matchId, ids.q2!.matchId])
    expect(after.matches.find((x) => x.matchId === res.matchId)!.recordingRevisionId).toBe(again.recordingRevisionId)
    expect(after.excludedRecordings).toEqual([]) // both conflicts are resolved: one is its own match, the other ignored
    svc.close()
  }, 120_000)
})
