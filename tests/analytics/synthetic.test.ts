import { describe, expect, it } from 'vitest'
import { applyConfirmation, deriveResult } from '@fmmi/model'
import type { Boundary } from '@fmmi/model'
import {
  buildNetwork, comparisonConfounders, completed, scoreStateMinutes, scoreStateQuery, makeCtx, networkQuery, playerQuery, renderReport, renderService, reportQuery, scopedPasses, serviceQuery,
} from '@fmmi/analytics'
import type { MetricRow, ScoreStateResult } from '@fmmi/analytics'
import { SampledCounters } from '@fmmi/model'
import { buildScenario } from '../support/scenario.ts'

const row = (rows: readonly MetricRow[], metric: string): MetricRow => {
  const r = rows.find((x) => x.metric === metric)
  if (!r) throw new Error(`no row ${metric}`)
  return r
}
const at = (period: number, tick: number): Boundary => ({ period, tick, sequence: 0 })

describe('Slice 2 acceptance: striker aerials without double counting', () => {
  it('AC1 a striker who won 0 of 7 and a substitute who won 3 of 4 are read from the cumulative counters, and only the first meets low_aerial_success_v1', async () => {
    const sc = await buildScenario()
    const rep = reportQuery(sc.input)
    const striker = rep.report.players.find((p) => p.playerId === sc.pid(sc.striker))!
    const sub = rep.report.players.find((p) => p.playerId === sc.pid(sc.sub))!
    expect(row(striker.metrics, 'aerials').value).toBe(7) // counter delta, not a sum of the snapshots
    expect(row(striker.metrics, 'aerials_won').value).toBe(0)
    expect(row(striker.metrics, 'aerial_win_pct')).toMatchObject({ value: 0, counts: { numerator: 0, denominator: 7 } })
    expect(row(sub.metrics, 'aerials').value).toBe(4)
    expect(row(sub.metrics, 'aerials_won').value).toBe(3)
    expect(row(sub.metrics, 'aerial_win_pct')).toMatchObject({ value: 75, counts: { numerator: 3, denominator: 4 } })
    const low = rep.report.findings.filter((f) => f.ruleId === 'low_aerial_success_v1')
    expect(low).toHaveLength(1)
    expect(low[0]!.subject.playerId).toBe(sc.pid(sc.striker))
    expect(low[0]!.facts).toMatchObject({ attempts: 7, won: 0 })
    expect(low[0]!.label).toBe('descriptive_heuristic')
    // events and counters agree: nothing was double counted
    expect(rep.report.evidenceQuality.aerialEventCounterAgreement.home.residual).toEqual({ attempts: 0, won: 0 })
    expect(rep.report.evidenceQuality.aerialEventCounterAgreement.home.counters).toEqual({ attempts: 11, won: 3 })
  })
})

describe('Slice 2 acceptance: attribution when the human-managed side is away', () => {
  it('AC2 events and players are attributed to the away team; the home team is not contaminated', async () => {
    const sc = await buildScenario({ humanSide: 'away', homeName: 'Opponent', awayName: 'Farnham', names: { 2009: 'Away Striker', 2011: 'Away Sub' } })
    expect(sc.input.decoded.recording.humanControlledSide).toBe('away')
    const rep = reportQuery(sc.input)
    expect(rep.teams.away).toMatchObject({ name: 'Farnham', managed: true, teamId: 't_away' })
    expect(rep.teams.home.managed).toBe(false)
    const low = rep.report.findings.find((f) => f.ruleId === 'low_aerial_success_v1')!
    expect(low.subject).toMatchObject({ playerId: 'p_2009', name: 'Away Striker' })
    expect(row(rep.report.teams.away.metrics, 'aerial_win_pct').counts).toEqual({ numerator: 3, denominator: 11 })
    expect(row(rep.report.teams.home.metrics, 'aerial_win_pct')).toMatchObject({ value: null, nullReason: 'zero_denominator' })
    const net = networkQuery(sc.input, 't_away', { limit: 100 })
    const awayIds = new Set(sc.input.decoded.recording.roster.filter((p) => p.side === 'away').map((p) => sc.pid(p.upstreamPlayerId)))
    expect(net.network.edges.length).toBeGreaterThan(0)
    expect(net.network.edges.every((e) => awayIds.has(e.from) && awayIds.has(e.to))).toBe(true)
    expect(net.network.totals.completed).toBe(sc.input.decoded.recording.teamTotals.away.passesCompleted)
    const homeNet = networkQuery(sc.input, 't_home', { limit: 100 })
    expect(homeNet.network.edges.every((e) => !awayIds.has(e.from) && !awayIds.has(e.to))).toBe(true)
    const svc = serviceQuery(sc.input, 'p_2009', { comparePlayerId: 'p_2011' })
    expect(svc.service.subject.player).toMatchObject({ teamId: 't_away', side: 'away' })
    expect(svc.service.recipientGate.side).toBe('away')
    expect(svc.service.comparison?.status).toBe('qualified')
    expect(() => playerQuery(sc.input, 'p_2009', {})).not.toThrow()
  })

  it('AC2 side-local event slots do not leak: away passer 2001 has the same counter total as its events', async () => {
    const sc = await buildScenario({ humanSide: 'away' })
    const ctx = makeCtx(sc.input)
    const mine = completed(scopedPasses(ctx, 'away', 'counter_scope')).filter((e) => e.playerId === 2001).length
    const p = playerQuery(sc.input, 'p_2001')
    expect(row(p.player.metrics, 'passes_completed').value).toBe(mine)
  })
})

describe('Slice 2 acceptance: windows around a substitution', () => {
  it('AC3 window totals before and after the substitution reconcile and sampled boundaries are disclosed', async () => {
    const sc = await buildScenario()
    const cut = at(2, sc.subTick + 1)
    const before = { to: cut }, after = { from: cut }
    const P = (id: number, w: { from?: Boundary; to?: Boundary }) => playerQuery(sc.input, sc.pid(id), { window: w })
    const sB = P(sc.striker, before), sA = P(sc.striker, after), sT = P(sc.striker, {})
    const uB = P(sc.sub, before), uA = P(sc.sub, after), uT = P(sc.sub, {})
    // minutes: the striker plays only before, the substitute only after
    expect(sB.player.participation.minutesInWindow).toBeGreaterThan(50)
    expect(sA.player.participation.minutesInWindow).toBe(0)
    expect(uB.player.participation.minutesInWindow).toBe(0)
    expect(uA.player.participation.minutesInWindow).toBeGreaterThan(30)
    expect(sB.player.participation.minutesInWindow + sA.player.participation.minutesInWindow).toBeCloseTo(sT.player.participation.minutesInWindow, 9)
    // counters
    expect(row(sB.player.metrics, 'aerials').value! + row(sA.player.metrics, 'aerials').value!).toBe(row(sT.player.metrics, 'aerials').value)
    expect(row(uB.player.metrics, 'aerials').value! + row(uA.player.metrics, 'aerials').value!).toBe(row(uT.player.metrics, 'aerials').value)
    expect(row(sB.player.metrics, 'aerials').value).toBe(7)
    expect(row(uA.player.metrics, 'aerials_won').value).toBe(3)
    // zero minutes: no per-90 value, a reason instead of zero
    expect(row(sA.player.metrics, 'xg_per_90')).toMatchObject({ value: null, nullReason: 'zero_denominator' })
    // events reconcile exactly
    expect(row(uB.player.passing.received, 'passes_received').value! + row(uA.player.passing.received, 'passes_received').value!).toBe(row(uT.player.passing.received, 'passes_received').value)
    // the frames are sampled every 60 ticks, so the mid-match boundary is disclosed rather than hidden
    expect(sB.coverage).toBe('partial_for_window')
    expect(sB.window.resolution.to.exact).toBe(false)
    expect(sB.window.resolution.to.unobservedTicks).toBeGreaterThan(0)
    expect(sB.warnings.some((w) => w.startsWith('boundary_sampled_not_exact'))).toBe(true)
    expect(sT.coverage).toBe('complete_for_window')
  })

  it('AC3 incomplete pass recipient events show uncertainty: partial links, a failed gate and no service diagnosis', async () => {
    const sc = await buildScenario({ dropReceiver: (_s, k) => k % 5 === 1 })
    const svc = serviceQuery(sc.input, sc.pid(sc.sub))
    expect(svc.service.recipientGate.status).toBe('fail')
    expect(svc.service.recipientGate.reasons).toContain('recipient_coverage_below_threshold')
    expect(svc.service.diagnosis.status).toBe('withheld')
    const recv = row(svc.service.subject.reception, 'passes_received')
    expect(recv.coverage).toBe('partial_for_window')
    expect(recv.warnings?.join(' ')).toContain('no claim about little or no service')
    expect(svc.warnings.join(' ')).toContain('service diagnosis withheld')
  })
})

describe('Slice 2 acceptance: recipient gate, fallback and edges', () => {
  const gateOf = async (drop: number) => {
    const sc = await buildScenario({ passesPerSide: 100, pureCompleted: true, dropReceiver: (s, k) => s === 'home' && k < drop })
    return { sc, net: networkQuery(sc.input, 't_home', { limit: 100 }) }
  }

  it('AC4 receiver coverage of exactly 95% passes and just below 95% fails (equality and just-below cases)', async () => {
    const eq = await gateOf(5)
    expect(eq.net.network.recipientGate).toMatchObject({ eligibleCompletedPasses: 100, withVerifiedReceiver: 95, status: 'pass' })
    expect(eq.net.network.recipientGate.reconciliation.status).toBe('exact')
    const below = await gateOf(6)
    expect(below.net.network.recipientGate).toMatchObject({ eligibleCompletedPasses: 100, withVerifiedReceiver: 94, status: 'fail' })
    expect(below.net.network.recipientGate.reasons).toEqual(['recipient_coverage_below_threshold'])
    // the away side is judged on its own data
    expect(networkQuery(below.sc.input, 't_away').network.recipientGate.status).toBe('pass')
  })

  it('AC4 a failed gate returns the partial observed links and the fallback, and withholds a service claim', async () => {
    const { sc, net } = await gateOf(6)
    expect(net.network.edges.length).toBeGreaterThan(0)
    expect(net.network.totals.edgeCompletions).toBe(94)
    expect(net.network.totals.completedWithoutVerifiedReceiver).toBe(6)
    expect(net.network.fallback).toMatchObject({ reason: 'recipient_gate_failed', observedLinks: 'partial' })
    expect(net.network.fallback!.claims).toMatch(/No claim about little or no service/)
    const svc = serviceQuery(sc.input, sc.pid(sc.striker), { comparePlayerId: sc.pid(sc.sub) })
    expect(svc.service.diagnosis.status).toBe('withheld')
    expect(svc.service.fallback!.available).toEqual(['cumulative_passing', 'aerial', 'shooting'])
    expect(svc.service.comparison?.status).toBe('suppressed')
    expect(svc.service.comparison?.reasons.some((r) => r.startsWith('recipient_gate:'))).toBe(true)
    expect(svc.service.suppressedFindings.some((f) => f.ruleId === 'reception_rate_comparison_v1')).toBe(true)
    // cumulative aerial and shooting data stay available
    expect(row([svc.service.subject.aerial.row], 'aerial_win_pct').value).toBe(0)
  })

  it('AC4 an event total that does not reconcile to the counters fails the gate even at 100% coverage', async () => {
    const sc = await buildScenario({ passesPerSide: 100, pureCompleted: true, counterDeficit: 3 })
    const g = networkQuery(sc.input, 't_home').network.recipientGate
    expect(g.withVerifiedReceiver).toBe(g.eligibleCompletedPasses)
    expect(g.reconciliation).toMatchObject({ status: 'mismatch', residual: { completed: 3 } })
    expect(g.status).toBe('fail')
    expect(g.reasons).toContain('reconciliation_mismatch')
  })

  it('AC4 open_play carries an unverified_semantics warning and is never compared with counter totals; all_passes is labelled', async () => {
    const sc = await buildScenario()
    const open = networkQuery(sc.input, 't_home', { scope: 'open_play' })
    expect(open.warnings.some((w) => w.startsWith('unverified_semantics'))).toBe(true)
    expect(open.network.scope).toMatchObject({ scope: 'open_play', semantics: 'unverified_semantics', counterEquivalent: false })
    expect(open.network.recipientGate.reconciliation).toMatchObject({ status: 'unavailable', counters: { attempts: null, completed: null } })
    expect(open.network.recipientGate.status).toBe('fail')
    const all = networkQuery(sc.input, 't_home', { scope: 'all_passes' })
    const def = networkQuery(sc.input, 't_home')
    expect(all.network.scope).toMatchObject({ scope: 'all_passes', includesThrowIns: true })
    expect(def.network.scope).toMatchObject({ scope: 'counter_scope', includesThrowIns: false, crossesIncluded: false })
    expect(all.network.totals.completed).toBeGreaterThan(def.network.totals.completed)
    expect(def.network.totals.completed).toBe(sc.input.decoded.recording.teamTotals.home.passesCompleted)
    expect(all.network.recipientGate.reconciliation.status).toBe('unavailable')
  })

  it('AC4 a node with no location sample keeps its node and every link; reception coordinates are not replaced by averages', async () => {
    const sc = await buildScenario()
    const ctx = makeCtx(sc.input)
    const net = buildNetwork(ctx, 'home', 'counter_scope', { limit: 10_000 }, () => 0)
    const subNode = net.nodes.find((n) => n.playerId === sc.pid(sc.sub))!
    expect(subNode.location).toBeNull()
    expect(subNode.origin).toBeNull()
    expect(subNode.reception).toBeNull() // no trajectory in this fixture: nothing is invented
    expect(subNode.passesReceived).toBeGreaterThan(0)
    expect(net.edges.filter((e) => e.to === sc.pid(sc.sub)).reduce((a, e) => a + e.completions, 0)).toBe(subNode.passesReceived)
    expect(net.edges.reduce((a, e) => a + e.completions, 0)).toBe(net.totals.completed)
  })

  it('AC4 players substituted off keep their links and nodes (no on-pitch filter)', async () => {
    // three completed passes by the striker before he is substituted off
    const own = [4000, 4100, 4200].map((tick, i) => ({ sequenceIndex: 8001 + i, tick, type: 7, team: 'home' as const, playerId: 1009, receiverId: 1002, flags: 1, completionTick: tick + 1 }))
    const sc = await buildScenario({ trajectory: true, extraEvents: own })
    const ctx = makeCtx(sc.input)
    const out = sc.input.decoded.recording.roster.find((p) => p.upstreamPlayerId === sc.striker)!
    expect(out.participation.onPitchAtEndOfRecording).toBe(false)
    const net = buildNetwork(ctx, 'home', 'counter_scope', { limit: 10_000 }, () => 0)
    expect(net.nodes.some((n) => n.playerId === sc.pid(sc.striker))).toBe(true)
    expect(net.edges.find((e) => e.from === sc.pid(sc.striker) && e.to === sc.pid(1002))?.completions).toBe(3)
  })

  it('AC4 unknown ground-pass type never becomes ground service', async () => {
    const sc = await buildScenario({ trajectory: true })
    const p = playerQuery(sc.input, sc.pid(sc.sub))
    expect(p.player.passing.groundService).toMatchObject({ value: null, nullReason: 'not_recorded' })
    const svc = serviceQuery(sc.input, sc.pid(sc.sub))
    expect(svc.service.components.find((c) => c.id === 'ground_service')).toMatchObject({ availability: 'unavailable', reason: 'not_recorded' })
    expect(JSON.stringify(svc)).not.toMatch(/"metric":"ground_service/)
    expect(p.player.passing.receptionLocations.derivation).toBe('derived_from_trajectory_end')
    expect(p.player.passing.receptionLocations.independent).toBe(false)
  })

  it('AC4 receiver-specific attempt and success rates stay unavailable with a reason', async () => {
    const sc = await buildScenario()
    const u = serviceQuery(sc.input, sc.pid(sc.sub)).service.unavailable
    expect(u.find((x) => x.id === 'receiver_specific_attempt_rate')).toMatchObject({ reason: 'not_recorded' })
    expect(u.find((x) => x.id === 'receiver_specific_success_rate')).toMatchObject({ reason: 'not_recorded' })
    expect(u.find((x) => x.id === 'final_third_touches')).toBeDefined()
    expect(u.find((x) => x.id === 'support_proximity')).toBeDefined()
  })
})

describe('Slice 2 acceptance: windows, baselines and boundaries', () => {
  it('AC5 adjacent windows reconcile to the total for counters and events', async () => {
    const sc = await buildScenario()
    const cuts = [at(2, 11124), at(2, 14004), at(2, 18000)]
    const windows = [{ to: cuts[0] }, { from: cuts[0], to: cuts[1] }, { from: cuts[1], to: cuts[2] }, { from: cuts[2] }]
    const total = reportQuery(sc.input)
    const parts = windows.map((w) => reportQuery(sc.input, { window: w }))
    for (const side of ['home', 'away'] as const) {
      for (const m of ['passes', 'passes_completed', 'aerials', 'aerials_won', 'shots', 'xg', 'final_third_entry_passes']) {
        const t = row(total.report.teams[side].metrics, m).value!
        const s = parts.reduce((a, r) => a + (row(r.report.teams[side].metrics, m).value ?? 0), 0)
        expect(s, `${side} ${m}`).toBeCloseTo(t, 5)
      }
    }
    const ctx = (w: { from?: Boundary; to?: Boundary }) => makeCtx(sc.input, w)
    const n = (w: { from?: Boundary; to?: Boundary }) => completed(scopedPasses(ctx(w), 'home', 'counter_scope')).length
    expect(windows.reduce((a, w) => a + n(w), 0)).toBe(n({}))
    // a boundary event is counted once: the event at a boundary tick belongs to the later window only
    const b = scopedPasses(ctx({}), 'home', 'counter_scope').find((e) => e.period === 2)!
    const w1 = { to: at(2, b.tick) }, w2 = { from: at(2, b.tick) }
    expect(scopedPasses(ctx(w1), 'home', 'counter_scope').includes(b)).toBe(false)
    expect(scopedPasses(ctx(w2), 'home', 'counter_scope').includes(b)).toBe(true)
  })

  it('AC5 an unverified baseline gives null with missing_baseline, never a zero, and a later window still resolves', async () => {
    const sc = await buildScenario({ nonZeroStart: true })
    expect(sc.input.decoded.sampled.initialBaseline).toBe('unverified')
    const whole = playerQuery(sc.input, sc.pid(sc.striker))
    expect(row(whole.player.metrics, 'aerials')).toMatchObject({ value: null, nullReason: 'missing_baseline', coverage: 'unavailable' })
    expect(row(whole.player.metrics, 'aerial_win_pct').value).toBeNull()
    expect(whole.player.findings).toHaveLength(0)
    const later = playerQuery(sc.input, sc.pid(sc.striker), { window: { from: at(2, 11124) } })
    expect(row(later.player.metrics, 'aerials').value).not.toBeNull()
  })

  it('AC5 a window outside the recording is rejected, never clipped', async () => {
    const sc = await buildScenario()
    expect(() => reportQuery(sc.input, { window: { to: at(3, 100) } })).toThrowError(/outside the recording/)
    expect(() => reportQuery(sc.input, { window: { from: at(2, 14000), to: at(2, 13000) } })).toThrowError(/reversed/)
  })
})

describe('Slice 2 acceptance: comparison exposure gates', () => {
  it('AC6 a striker with zero receptions but adequate minutes and team passes in both windows still yields a qualified comparison', async () => {
    const sc = await buildScenario()
    const svc = serviceQuery(sc.input, sc.pid(sc.striker), { comparePlayerId: sc.pid(sc.sub) })
    const s = svc.service
    expect(row(s.subject.reception, 'passes_received').value).toBe(0)
    expect(row(s.subject.reception, 'passes_received_per_90').value).toBe(0)
    expect(s.recipientGate.status).toBe('pass')
    expect(s.comparison?.status).toBe('qualified')
    expect(s.comparison!.gates.subject.passes).toBe(true)
    expect(s.comparison!.gates.comparator.passes).toBe(true)
    const f = s.findings.find((x) => x.ruleId === 'reception_rate_comparison_v1')!
    expect(f.facts).toMatchObject({ receptions: 0, direction: 'lower' })
    expect(f.label).toBe('descriptive_comparison')
    expect(s.findings.find((x) => x.ruleId === 'progression_rate_comparison_v1')).toBeDefined()
    expect(s.diagnosis.status).toBe('descriptive_only')
  })

  it('AC6 inadequate minutes or team passes in either window suppress the comparison with the reason', async () => {
    const late = await buildScenario({ subTick: 21000 })
    const a = serviceQuery(late.input, late.pid(late.striker), { comparePlayerId: late.pid(late.sub) }).service
    expect(a.comparison?.status).toBe('suppressed')
    expect(a.comparison?.reasons).toContain('comparator:fewer_than_15_verified_playing_minutes')
    expect(a.findings.find((x) => x.ruleId === 'reception_rate_comparison_v1')).toBeUndefined()
    const thin = await buildScenario({ passesPerSide: 20 })
    const b = serviceQuery(thin.input, thin.pid(thin.striker), { comparePlayerId: thin.pid(thin.sub) }).service
    expect(b.comparison?.status).toBe('suppressed')
    expect(b.comparison?.reasons.some((r) => r.includes('team_completed_passes'))).toBe(true)
    // no absolute label is ever produced
    expect(JSON.stringify(a) + JSON.stringify(b)).not.toMatch(/low service|weak progression|isolated/i)
  })

  it('AC6 a comparator from the other team and a self-comparison are handled', async () => {
    const sc = await buildScenario()
    expect(() => serviceQuery(sc.input, sc.pid(sc.striker), { comparePlayerId: sc.pid(sc.striker) })).toThrowError(/different player/)
    const x = serviceQuery(sc.input, sc.pid(sc.striker), { comparePlayerId: sc.pid(2005) })
    expect(x.service.comparison?.status).toBe('suppressed')
    expect(x.service.comparison?.reasons).toContain('comparator_in_other_team')
  })

  it('AC1 a single-shot window suppresses firm chance-quality findings and flags the shot quality row', async () => {
    const sc = await buildScenario()
    const cut = at(2, sc.subTick + 1500) // the substitute has one shot by then
    const p = playerQuery(sc.input, sc.pid(sc.sub), { window: { to: cut } })
    expect(row(p.player.metrics, 'shots').value).toBe(1)
    expect(row(p.player.metrics, 'shot_quality').warnings?.[0]).toMatch(/single_shot_window/)
    expect(p.player.suppressedFindings).toEqual([expect.objectContaining({ ruleId: 'chance_quality', reasons: ['single_shot_window'] })])
    const full = playerQuery(sc.input, sc.pid(sc.sub))
    expect(row(full.player.metrics, 'shots').value).toBe(3)
    expect(full.player.suppressedFindings).toHaveLength(0)
    expect(row(full.player.metrics, 'shot_quality').value).toBeCloseTo(0.11, 5)
    const striker = playerQuery(sc.input, sc.pid(sc.striker))
    expect(row(striker.player.metrics, 'shot_quality')).toMatchObject({ value: null, nullReason: 'zero_denominator' })
  })
})

describe('Slice 2: derived final-third entry and attack direction', () => {
  it('direction flips between periods: the same physical pass is an entry in one period and a backward pass in the other; equality at 2/3 is exact', async () => {
    const pass = (seq: number, tick: number, p2: boolean, lonStart: number, lonEnd: number) => ({
      sequenceIndex: seq, tick, type: 7, team: 'home' as const, playerId: 1001, receiverId: 1002, flags: 1 | (p2 ? 0x100 : 0), lateral: 0, longitudinal: lonStart,
      completionTick: tick + 1, trajectory: [{ lateral: 0, longitudinal: lonStart }, { lateral: 0, longitudinal: lonEnd }],
    })
    // half length 60 m: the 2/3 line is exactly 20 m ahead of the centre in the attack direction (float32 exact)
    const sc = await buildScenario({
      passesPerSide: 0, halfLength: 60,
      extraEvents: [
        pass(7001, 5000, false, -10, -20), // period 1, home attacks toward -y: forward 10 -> 20, enters
        pass(7002, 5100, false, 10, 20), // period 1, toward +y is backward: not an entry
        pass(7003, 15000, true, 10, 20), // period 2, flag 0x100 set: attacks +y, enters
        pass(7004, 15100, true, -10, -20), // period 2: backward
        pass(7005, 15200, true, 10, 20), // start below the line, end exactly on it: enters
        pass(7006, 15300, true, 20, 30), // start exactly on the line: not below it, so not an entry
        pass(7007, 15400, true, 19.5, 19.9), // never reaches the line
      ],
    })
    const ft = (w: { from?: Boundary; to?: Boundary }) => row(reportQuery(sc.input, { window: w }).report.teams.home.metrics, 'final_third_entry_passes').value
    expect(ft({ to: at(2, 11124) })).toBe(1)
    expect(ft({ from: at(2, 11124) })).toBe(2)
    expect(ft({})).toBe(3)
    const events = sc.input.decoded.events.filter((e) => e.eventId >= 7001)
    expect(events[0]!.normalised.attackDirection).toBe('toward_negative_longitudinal')
    expect(events[2]!.normalised.attackDirection).toBe('toward_positive_longitudinal')
    // distinct from the upstream counter, which is a different ID
    const rows = reportQuery(sc.input).report.teams.home.metrics
    expect(row(rows, 'final_third_passes').value).toBe(0)
    expect(row(rows, 'final_third_entry_passes').value).toBe(3)
  })

  it('without pitch dimensions the derived entry is null with a reason, not zero', async () => {
    const sc = await buildScenario({ passesPerSide: 0 })
    const input = { ...sc.input, decoded: { ...sc.input.decoded, recording: { ...sc.input.decoded.recording, pitch: null } } }
    expect(row(reportQuery(input).report.teams.home.metrics, 'final_third_entry_passes')).toMatchObject({ value: null, nullReason: 'not_recorded' })
  })
})

describe('Slice 2: partial recordings, manual scores and untrusted names', () => {
  it('a partial recording says so, shows the end boundary and never presents totals as full-match', async () => {
    const sc = await buildScenario()
    const rep = reportQuery(sc.input)
    expect(rep.capture.partial).toBe(true)
    expect(rep.capture.statement).toMatch(/not the full match/)
    expect(rep.capture.endBoundary.tick).toBe(21700)
    const md = renderReport(rep, { markdown: true })
    expect(md).toContain('Partial recording')
    expect(md).toContain('OBSERVED')
    expect(md).not.toMatch(/full-match total/i)
  })

  it('a manual final score is labelled manual and observed counters are untouched', async () => {
    const sc = await buildScenario()
    const rec = sc.input.decoded.recording
    const completion = applyConfirmation(sc.input.completion, { home: 1, away: 0, confirmedAt: '2026-01-01T00:00:00Z' }, rec.observedScore)
    const input = { ...sc.input, completion, result: deriveResult(rec.observedScore, completion) }
    const rep = reportQuery(input)
    expect(rep.result.label).toBe('final_manual')
    expect(rep.capture.manualFinalScore).toMatchObject({ home: 1, away: 0, label: 'manual' })
    const md = renderReport(rep, { markdown: true })
    expect(md).toMatch(/final score is MANUAL/)
    expect(md).toMatch(/observed at the end of capture: 0-0/)
    expect(rep.capture.partial).toBe(true) // confirmation never changes capture coverage
  })

  it('names are escaped in Markdown: no raw links, HTML, headings or table breaks survive', async () => {
    const evil = 'Evil](http://x.test)\n# Heading <img src=x onerror=1> *b* | a ‮'
    const sc = await buildScenario({ names: { 1009: evil, 1011: '[link](javascript:1)' }, homeName: 'Home <b>FC</b>' })
    const md = renderReport(reportQuery(sc.input), { markdown: true })
    expect(md).not.toContain('](http://x.test)')
    expect(md).not.toMatch(/(?<!\\)<img/)
    expect(md).not.toMatch(/(?<!\\)<b>/)
    expect(md).not.toContain('‮')
    expect(md).toContain('\\\\u\\{a\\}') // the newline in the name is escaped, so it cannot start a heading
    for (const line of md.split('\n')) if (line.startsWith('#')) expect(line).toMatch(/^#{1,3} (Match report|Facts|Teams|Players|Substitution|Deterministic|Evidence)/)
    const svc = renderService(serviceQuery(sc.input, sc.pid(1009), { comparePlayerId: sc.pid(1011) }), { markdown: true })
    expect(svc).not.toContain('](javascript:1)')
    expect(svc).not.toContain('‮')
  })

  it('reports contain facts, deterministic findings and evidence quality only: no hypotheses, recommendations or causal language', async () => {
    const sc = await buildScenario()
    const texts = [
      renderReport(reportQuery(sc.input), { markdown: true }), renderReport(reportQuery(sc.input), { markdown: false }),
      renderService(serviceQuery(sc.input, sc.pid(sc.striker), { comparePlayerId: sc.pid(sc.sub) }), {}),
    ]
    const banned = /\b(because|caused|causes|due to|therefore|hypothes\w*|recommend\w*|should|suggest\w*|consider|try|expect\w* to|explains?|led to|result of)\b/i
    for (const t of texts) expect(t).not.toMatch(banned)
    const md = texts[0]!
    expect(md).toContain('## Facts')
    expect(md).toContain('## Deterministic findings')
    expect(md).toContain('## Evidence quality')
  })
})

const ss = (shares: [number, number, number], dominant: 'leading' | 'drawing' | 'trailing'): ScoreStateResult => ({
  value: { side: 'home', ticks: { leading: 0, drawing: 0, trailing: 0 }, minutes: { leading: 0, drawing: 0, trailing: 0 }, totalMinutes: 1, shares: { leading: shares[0], drawing: shares[1], trailing: shares[2] }, dominant, note: '' },
})

describe('Slice 2: score-state context for comparisons (spec 7.1)', () => {
  it('the away team has the leading and trailing perspective flipped, and the minutes add up to the team playing time', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', goals: [{ tick: 5000, side: 'home' }] })
    const home = scoreStateQuery(sc.input, 't_home').scoreState.value!
    const away = scoreStateQuery(sc.input, 't_away').scoreState.value!
    expect(home.ticks.trailing).toBe(0)
    expect(away.ticks.leading).toBe(0)
    expect(home.ticks.leading).toBe(away.ticks.trailing)
    expect(home.ticks.drawing).toBe(away.ticks.drawing)
    expect(away.dominant).toBe('trailing')
    expect(home.dominant).toBe('leading')
    expect(away.totalMinutes).toBeCloseTo(sc.input.decoded.recording.roster.find((p) => p.upstreamPlayerId === 2001)!.participation.elapsedMinutes, 3)
    const svc = serviceQuery(sc.input, 'p_2009', { comparePlayerId: 'p_2011' })
    const cx = svc.service.comparison!.context as { subject: { scoreState: ScoreStateResult }; confounders: string[]; substitutionFlips: unknown[] }
    expect(cx.subject.scoreState.value!.dominant).toBe('trailing')
    expect(cx.substitutionFlips).toHaveLength(1)
    expect(cx.confounders).toContain('substitutions_in_window')
    const f = svc.service.findings.find((x) => x.ruleId === 'reception_rate_comparison_v1')!
    expect(f.summary).toContain('Score state while on pitch')
    expect(f.summary).toContain('not adjusted')
  })

  it('goals that are not recorded give null with a reason, and a window with no playing time is a zero denominator', async () => {
    const empty = new SampledCounters()
    expect(scoreStateMinutes(empty, [], 'home')).toEqual({ value: null, nullReason: 'not_recorded' })
    const sc = await buildScenario()
    expect(scoreStateMinutes(sc.input.decoded.sampled, [], 'home')).toEqual({ value: null, nullReason: 'zero_denominator' })
    expect(comparisonConfounders({ value: null, nullReason: 'not_recorded' }, ss([1, 0, 0], 'leading'), 10, 10, 0)).toEqual(['score_state_unavailable'])
  })

  it('different_score_state fires when the dominant state differs or a share differs by MORE than 0.25: equality does not fire', () => {
    const c = (a: ScoreStateResult, b: ScoreStateResult) => comparisonConfounders(a, b, 30, 30, 0)
    expect(c(ss([0, 0.75, 0.25], 'drawing'), ss([0, 0.5, 0.5], 'drawing'))).toEqual([]) // gap exactly 0.25
    expect(c(ss([0, 0.75, 0.25], 'drawing'), ss([0, 0.76, 0.24], 'drawing'))).toEqual([]) // just below
    expect(c(ss([0, 0.75, 0.25], 'drawing'), ss([0, 0.49, 0.51], 'drawing'))).toEqual(['different_score_state']) // 0.26
    expect(c(ss([0, 0.5, 0.5], 'drawing'), ss([0, 0.45, 0.55], 'trailing'))).toEqual(['different_score_state']) // dominant differs
    expect(comparisonConfounders(ss([0, 1, 0], 'drawing'), ss([0, 1, 0], 'drawing'), 20, 10, 0)).toEqual([]) // minutes ratio exactly 0.5
    expect(comparisonConfounders(ss([0, 1, 0], 'drawing'), ss([0, 1, 0], 'drawing'), 20, 9.9, 0)).toEqual(['different_minutes_on_pitch'])
  })
})
