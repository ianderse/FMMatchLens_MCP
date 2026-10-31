// Domain-level tests for the Slice 3 queries that live in analytics: summaryQuery, compareQuery and evidenceStatusQuery.
import { beforeAll, describe, expect, it } from 'vitest'
import { DomainError } from '@fmmi/model'
import { compareQuery, evidenceStatusQuery, scoreStateQuery, summaryQuery } from '@fmmi/analytics'
import type { WindowSpec } from '@fmmi/analytics'
import { buildScenario } from '../support/scenario.ts'
import type { Scenario } from '../support/scenario.ts'

const at = (period: number, tick: number) => ({ period, tick, sequence: 0 })
let sc: Scenario
beforeAll(async () => { sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', goals: [{ tick: 4000, side: 'away' }, { tick: 16000, side: 'home' }] }) })

const rate = (r: ReturnType<typeof compareQuery>, metric: string) => r.comparison.teamRates.find((x) => x.metric === metric)!

describe('summaryQuery', () => {
  it('AC1 lists the complete recorded roster with internal ids, including the substituted-off striker and unused substitutes', () => {
    const s = summaryQuery(sc.input)
    const players = s.summary.roster.players
    expect(players).toHaveLength(28)
    const byName = (n: string) => players.find((p) => p.name === n)!
    expect(byName('Away Player 9')).toMatchObject({ playerId: sc.pid(sc.striker), status: 'played', enteredAs: 'starter', side: 'away' })
    expect(byName('Away Player 9').offAt).not.toBeNull()
    expect(byName('Away Player 11')).toMatchObject({ status: 'played', enteredAs: 'substitute', offAt: null })
    for (const n of ['Away Player 12', 'Away Player 13', 'Home Player 11', 'Home Player 12', 'Home Player 13']) expect(byName(n)).toMatchObject({ status: 'unused_substitute', minutes: 0, onAt: null, offAt: null })
    expect(s.summary.roster).toMatchObject({ played: 23, unusedSubstitutes: 5 }) // 22 starters and the one substitute who came on
    expect(s.summary.substitutions).toHaveLength(1)
  })

  it('AC1 the roster can be filtered to a team that belongs to the match; a foreign team is not_found', () => {
    expect(summaryQuery(sc.input, { teamId: 't_away' }).summary.roster).toMatchObject({ returned: 14, filteredToTeamId: 't_away' })
    expect(() => summaryQuery(sc.input, { teamId: 't_other' })).toThrowError(DomainError)
    try { summaryQuery(sc.input, { teamId: 't_other' }) } catch (e) { expect((e as DomainError).code).toBe('not_found') }
  })

  it('AC1 shows both sides side by side with null reasons instead of zeros, and the finding for the striker who lost every aerial duel', () => {
    const s = summaryQuery(sc.input)
    const xg = s.summary.comparison.find((c) => c.metric === 'xg')!
    expect(xg.home.value).not.toBeNull()
    expect(s.summary.findings.some((f) => f.ruleId === 'low_aerial_success_v1' && f.subject.playerId === sc.pid(sc.striker))).toBe(true)
    expect(s.summary.findings.some((f) => f.subject.playerId === sc.pid(sc.sub))).toBe(false) // the substitute won 3/4: no finding
    for (const c of s.summary.comparison) for (const side of [c.home, c.away]) expect((side.value === null) === (side.nullReason !== undefined)).toBe(true)
  })
})

describe('compareQuery', () => {
  const full: WindowSpec = {}
  const p2 = (to?: number): WindowSpec => ({ from: at(2, 11124), to: to === undefined ? undefined : at(2, to) })

  it('AC3 adjacent windows reconcile to the total: counts in [a,b) plus [b,c) equal the count in [a,c)', () => {
    const split = compareQuery(sc.input, 't_away', { windowA: p2(14005), windowB: { from: at(2, 14005) } })
    const whole = compareQuery(sc.input, 't_away', { windowA: p2(), windowB: p2() })
    expect(split.windows.a.effective.exact).toBe(true)
    expect(split.windows.b.effective.exact).toBe(true)
    for (const m of ['shots', 'passes_completed', 'progressive_passes', 'xg', 'goals']) {
      const a = rate(split, m).a.value, b = rate(split, m).b.value, total = rate(whole, m).a.value
      expect(a, m).not.toBeNull()
      expect((a as number) + (b as number), m).toBeCloseTo(total as number, 6)
    }
    expect(split.windows.a.teamMinutes + split.windows.b.teamMinutes).toBeCloseTo(whole.windows.a.teamMinutes, 9)
    expect(split.windows.a.to).toEqual(split.windows.b.from) // the boundary tick belongs to window B only
  })

  it('AC3 count metrics are per-90 rates over verified team minutes and deltas are B minus A', () => {
    const r = compareQuery(sc.input, 't_away', { windowA: p2(14005), windowB: { from: at(2, 14005) } })
    const shots = rate(r, 'shots')
    expect(shots.comparedAs).toBe('per_90')
    expect(shots.a.perNinety).toBeCloseTo(((shots.a.value as number) * 90) / r.windows.a.teamMinutes, 9)
    expect(shots.delta).toBeCloseTo((shots.b.perNinety as number) - (shots.a.perNinety as number), 9)
    const pct = rate(r, 'pass_completion_pct')
    expect(pct.comparedAs).toBe('value')
    expect(pct.delta).toBeCloseTo((pct.b.value as number) - (pct.a.value as number), 9)
  })

  it('AC3 reuses the shared score-state minutes and the comparison confounders', () => {
    const w = { windowA: p2(14005), windowB: { from: at(2, 14005) } }
    const r = compareQuery(sc.input, 't_away', w)
    const ref = scoreStateQuery(sc.input, 't_away', { window: w.windowA })
    expect(r.comparison.context.scoreState.a.value?.minutes).toEqual(ref.scoreState.value?.minutes)
    expect(r.comparison.context.confounders).toEqual(expect.arrayContaining(['substitutions_in_window']))
    const overlap = compareQuery(sc.input, 't_away', { windowA: full, windowB: p2() })
    expect(overlap.comparison.context.confounders).toContain('windows_overlap')
    expect(overlap.comparison.context.confounders).toContain('different_minutes_on_pitch')
  })

  it('AC3 player rates carry the exposure gates of each window: qualified only when both meet them, otherwise suppressed with reasons and no deltas', () => {
    const q = compareQuery(sc.input, 't_away', { windowA: { to: at(1, 11041) }, windowB: p2(20000), playerIds: [sc.pid(sc.base.away + 3), sc.pid(sc.striker)] })
    const [mid, striker] = q.comparison.players
    expect(mid!.status).toBe('qualified')
    expect(mid!.deltas).not.toBeNull()
    expect(mid!.a.exposureGate.passes).toBe(true)
    expect(striker!.status).toBe('suppressed') // off after 14003: window B holds fewer than 15 of his minutes
    expect(striker!.deltas).toBeNull()
    expect(striker!.reasons.join()).toMatch(/window_b:fewer_than_15_verified_playing_minutes/)
    // rows state only what differs: the player id sits on the entry, not on every row
    expect(mid!.a.rows.every((r) => !('playerId' in r))).toBe(true)
  })

  it('AC3 recipient evidence below the gate keeps rate deltas but withholds the reception delta', async () => {
    const weak = await buildScenario({ humanSide: 'away', strikerSide: 'away', dropReceiver: (_s, k) => k % 2 === 0 })
    const q = compareQuery(weak.input, 't_away', { windowA: { to: at(1, 11041) }, windowB: p2(20000), playerIds: [weak.pid(weak.base.away + 3)] })
    const p = q.comparison.players[0]!
    expect(p.status).toBe('qualified')
    expect(p.deltas).toMatchObject({ passesReceivedPer90: null, passesReceivedPer90NullReason: 'recipient_gate_failed' })
    expect(p.deltas!.progressivePassesPer90).not.toBeUndefined()
  })

  it('AC3 rejects too many, duplicate, foreign-team and unknown players; windows are validated, never clipped', () => {
    const ids = [3, 4, 5, 6, 7].map((i) => sc.pid(sc.base.away + i))
    const call = (o: Partial<Parameters<typeof compareQuery>[2]>, team = 't_away') => () => compareQuery(sc.input, team, { windowA: full, windowB: p2(), ...o })
    expect(call({ playerIds: ids })).toThrowError(/At most 4/)
    expect(call({ playerIds: [ids[0]!, ids[0]!] })).toThrowError(/duplicate/)
    expect(call({ playerIds: [sc.pid(sc.base.home + 3)] })).toThrowError(/not on the requested team/)
    expect(call({ playerIds: ['p_unknown'] })).toThrowError(/does not belong to this match/)
    expect(call({}, 't_nope')).toThrowError(/Team does not belong/)
    expect(call({ windowB: { from: at(2, 20000), to: at(2, 14004) } })).toThrowError(/empty or reversed/)
    expect(call({ windowA: { from: at(1, 3), to: at(2, 9_999_999) } })).toThrowError(/outside the recording/)
  })

  it('AC3 inexact window boundaries make the counter rows partial and say so per window', () => {
    const r = compareQuery(sc.input, 't_away', { windowA: { from: at(2, 14010), to: at(2, 14965) }, windowB: { from: at(2, 14965), to: at(2, 15985) } })
    expect(r.windows.a.effective).toMatchObject({ exact: false, coverage: 'partial_for_window' })
    expect(r.windows.b.effective).toMatchObject({ exact: true, coverage: 'complete_for_window' })
    expect(r.coverage).toBe('partial_for_window')
    expect(rate(r, 'shots').a.coverage).toBeUndefined() // a cell states coverage only when it differs from its own window's coverage
    expect(r.warnings.join('\n')).toMatch(/boundary_sampled_not_exact/)
  })
})

describe('evidenceStatusQuery', () => {
  it('AC6 gives the observed intervals and the recipient gate per side, and lists the metrics that cannot be produced', () => {
    const s = evidenceStatusQuery(sc.input)
    expect(s.observedIntervals.map((i) => i.period)).toEqual([1, 2])
    expect(s.recipientDiagnostic.home.status).toBe('pass')
    expect(s.unavailable.map((u) => u.metric)).toEqual(expect.arrayContaining(['ground_service_receptions', 'receiver_specific_attempt_rate']))
  })
})
