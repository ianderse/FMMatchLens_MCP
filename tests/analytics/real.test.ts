// Real-recording goldens. They read tests/fixtures/local/ (gitignored) and report a skip when the file is absent.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { baseCompletion, deriveResult } from '@fmmi/model'
import type { Boundary, DecodedRecording } from '@fmmi/model'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { scoreStateMinutes, buildNetwork, completed, makeCtx, networkQuery, playerQuery, renderReport, reportQuery, scopedPasses, serviceQuery } from '@fmmi/analytics'
import type { AnalysisInput, MetricRow } from '@fmmi/analytics'
import { HAS_REAL, REAL_FIXTURE } from '../support/helpers.ts'

const golden = JSON.parse(readFileSync(new URL('../fixtures/farnham-torquay-0-3.summary.json', import.meta.url), 'utf8')) as {
  teamFinal: Record<'home' | 'away', Record<string, number>>
  perSlotCounters: Array<{ slot: number; team: string; counter: Record<string, number> }>
}

const row = (rows: readonly MetricRow[], metric: string): MetricRow => {
  const r = rows.find((x) => x.metric === metric)
  if (!r) throw new Error(`no row ${metric}`)
  return r
}
const at = (period: number, tick: number): Boundary => ({ period, tick, sequence: 0 })

describe.skipIf(!HAS_REAL)('Slice 2 on the real recording (Farnham 0-3 Torquay, captured to 87.6 min)', () => {
  let d: DecodedRecording
  let input: AnalysisInput
  const pid = (up: number) => `p_${up}`
  const named = (n: string) => d.recording.roster.find((p) => p.name === n)!
  beforeAll(async () => {
    d = await new FmlensV28Decoder().decode(readFileSync(REAL_FIXTURE))
    const completion = baseCompletion()
    input = {
      decoded: d,
      ids: {
        matchId: 'm_real', saveId: 's_real', recordingRevisionId: 'r_real', teamIds: { home: 't_home', away: 't_away' },
        playerIds: new Map(d.recording.roster.map((p) => [p.upstreamPlayerId, pid(p.upstreamPlayerId)] as const)),
      },
      completion, result: deriveResult(d.recording.observedScore, completion),
    }
  }, 120_000)

  it('golden: every team pass total in the report equals the audited summary', () => {
    const rep = reportQuery(input)
    expect(rep.coverage).toBe('complete_for_window')
    for (const side of ['home', 'away'] as const) {
      const rows = rep.report.teams[side].metrics
      const g = golden.teamFinal[side]
      expect(row(rows, 'passes').value).toBe(g.passes)
      expect(row(rows, 'passes_completed').value).toBe(g.passesCompleted)
      expect(row(rows, 'crosses').value).toBe(g.crosses)
      expect(row(rows, 'aerials_won').value).toBe(g.aerialsWon)
      expect(row(rows, 'progressive_passes').value).toBe(g.progressivePasses)
      expect(row(rows, 'final_third_passes').value).toBe(g.finalThirdPasses)
      expect(row(rows, 'xg').value).toBeCloseTo(g.xg!, 6)
    }
    expect(rep.report.teams.home.metrics.find((r) => r.metric === 'passes')).toMatchObject({ value: 594 })
  })

  it('golden: every player pass total in the report equals the audited summary', () => {
    const rep = reportQuery(input)
    let checked = 0
    for (const g of golden.perSlotCounters) {
      const p = d.recording.roster.find((x) => x.slot === g.slot)!
      const rp = rep.report.players.find((x) => x.playerId === pid(p.upstreamPlayerId))
      if (!rp) { expect(g.counter.passes ?? 0, `slot ${g.slot} did not play`).toBe(0); continue }
      expect(row(rp.metrics, 'passes').value, `slot ${g.slot} passes`).toBe(g.counter.passes)
      expect(row(rp.metrics, 'passes_completed').value, `slot ${g.slot} completed`).toBe(g.counter.passesCompleted)
      expect(row(rp.metrics, 'aerials_won').value, `slot ${g.slot} aerials won`).toBe(g.counter.aerialsWon)
      checked++
    }
    expect(checked).toBe(31)
  })

  it('golden: edge completions sum to completed passes per side under counter_scope, with reconciliation exact and the gate passing', () => {
    const ctx = makeCtx(input)
    for (const side of ['home', 'away'] as const) {
      const net = buildNetwork(ctx, side, 'counter_scope', { limit: 100_000 }, () => 0)
      const sum = net.edges.reduce((a, e) => a + e.completions, 0)
      expect(sum).toBe(d.recording.teamTotals[side].passesCompleted)
      expect(net.totals.completedWithoutVerifiedReceiver).toBe(0)
      const q = networkQuery(input, side === 'home' ? 't_home' : 't_away')
      expect(q.network.recipientGate).toMatchObject({
        status: 'pass', semanticsBasis: 'internal_corroboration', coverageRatio: 1, eligibleCompletedPasses: d.recording.teamTotals[side].passesCompleted,
      })
      expect(q.network.recipientGate.reconciliation).toMatchObject({ status: 'exact', residual: { attempts: 0, completed: 0 } })
      expect(q.network.totals.edgeCompletions).toBe(sum)
    }
  })

  it('golden: adjacent windows reconcile to the totals for counters and events', () => {
    const cuts = [at(2, 11124), at(2, 13700), at(2, 15062)]
    const wins = [{ to: cuts[0] }, { from: cuts[0], to: cuts[1] }, { from: cuts[1], to: cuts[2] }, { from: cuts[2] }]
    const total = reportQuery(input)
    const parts = wins.map((w) => reportQuery(input, { window: w }))
    for (const side of ['home', 'away'] as const) {
      for (const m of ['passes', 'passes_completed', 'progressive_passes', 'aerials', 'shots', 'xg', 'final_third_entry_passes', 'corners']) {
        const t = row(total.report.teams[side].metrics, m).value!
        const s = parts.reduce((a, r) => a + (row(r.report.teams[side].metrics, m).value ?? 0), 0)
        expect(s, `${side} ${m}`).toBeCloseTo(t, 5)
      }
      const ev = wins.map((w) => completed(scopedPasses(makeCtx(input, w), side, 'counter_scope')).length)
      expect(ev.reduce((a, b) => a + b, 0)).toBe(d.recording.teamTotals[side].passesCompleted)
    }
    // the halftime split is exact; the whole recording is exact
    expect(parts[0]!.coverage).toBe('complete_for_window')
    expect(parts[1]!.window.resolution.from.exact).toBe(true)
    // sub-windows reconcile events to counters, either exactly or within the stated boundary tolerance
    for (const r of parts) for (const side of ['home', 'away'] as const) {
      expect(['exact', 'within_boundary_tolerance']).toContain(r.report.evidenceQuality.reconciliation[side].status)
    }
    // the final-third entry is derived from events and is exact in every window
    expect(row(total.report.teams.home.metrics, 'final_third_entry_passes').value).toBeGreaterThan(0)
  })

  it('Bingham and Alexander windows around the tick 13700 substitution', () => {
    const bingham = named('Rakish Bingham'), alexander = named('George Alexander')
    expect(bingham.participation.lastOff).toMatchObject({ period: 2, tick: 13700 })
    expect(alexander.participation.firstOn).toMatchObject({ period: 2, tick: 13700 })
    const cut = at(2, 13700)
    const q = (p: typeof bingham, w: { from?: Boundary; to?: Boundary }) => playerQuery(input, pid(p.upstreamPlayerId), { window: w })
    const bB = q(bingham, { to: cut }), bA = q(bingham, { from: cut }), bT = q(bingham, {})
    const aB = q(alexander, { to: cut }), aA = q(alexander, { from: cut }), aT = q(alexander, {})
    expect(bB.player.participation.minutesInWindow).toBeCloseTo(56.73, 2)
    expect(bA.player.participation.minutesInWindow).toBe(0)
    expect(aB.player.participation.minutesInWindow).toBe(0)
    expect(aA.player.participation.minutesInWindow).toBeCloseTo(31.88, 2)
    for (const [b, a, t] of [[bB, bA, bT], [aB, aA, aT]] as const) {
      for (const m of ['aerials', 'aerials_won', 'passes', 'passes_completed', 'shots', 'progressive_passes']) {
        expect(row(b.player.metrics, m).value! + row(a.player.metrics, m).value!, m).toBe(row(t.player.metrics, m).value)
      }
      expect(row(b.player.passing.received, 'passes_received').value! + row(a.player.passing.received, 'passes_received').value!).toBe(row(t.player.passing.received, 'passes_received').value)
    }
    // Bingham (off at 13700): everything before; Alexander (on at 13700): everything after
    expect(row(bB.player.metrics, 'aerials')).toMatchObject({ value: 9 })
    expect(row(bB.player.metrics, 'aerials_won')).toMatchObject({ value: 3 })
    expect(row(bA.player.metrics, 'aerials').value).toBe(0)
    expect(row(aA.player.metrics, 'aerials').value).toBe(2)
    expect(row(aA.player.metrics, 'aerials_won').value).toBe(0)
    expect(row(aB.player.metrics, 'aerials').value).toBe(0)
    // zero minutes in a window: no per-90 value
    expect(row(bA.player.metrics, 'xg_per_90')).toMatchObject({ value: null, nullReason: 'zero_denominator' })
  })

  it('a substituted-off player keeps the links he made and received', () => {
    const bingham = named('Rakish Bingham')
    expect(bingham.participation.onPitchAtEndOfRecording).toBe(false)
    const ctx = makeCtx(input)
    const net = buildNetwork(ctx, 'home', 'counter_scope', { limit: 100_000 }, () => 0)
    const id = pid(bingham.upstreamPlayerId)
    expect(net.edges.filter((e) => e.from === id).reduce((a, e) => a + e.completions, 0)).toBe(bingham.counters.passesCompleted)
    expect(net.edges.filter((e) => e.to === id).reduce((a, e) => a + e.completions, 0)).toBe(10)
    expect(net.nodes.find((n) => n.playerId === id)).toBeDefined()
    // the upstream dashboard filter (on pitch at the end) would have dropped them
    const offAtEnd = new Set(d.recording.roster.filter((p) => !p.participation.onPitchAtEndOfRecording).map((p) => pid(p.upstreamPlayerId)))
    expect(net.edges.filter((e) => offAtEnd.has(e.from) || offAtEnd.has(e.to)).length).toBeGreaterThan(20)
  })

  it('the Alexander versus Bingham service comparison is qualified with the actual exposure and counts', () => {
    const alexander = named('George Alexander'), bingham = named('Rakish Bingham')
    const r = serviceQuery(input, pid(alexander.upstreamPlayerId), { comparePlayerId: pid(bingham.upstreamPlayerId) })
    const s = r.service
    expect(s.recipientGate).toMatchObject({ status: 'pass', side: 'home' })
    expect(s.comparison?.status).toBe('qualified')
    expect(row(s.subject.reception, 'passes_received').value).toBe(7)
    expect(row(s.comparator!.reception, 'passes_received').value).toBe(10)
    expect(row([s.subject.aerial.row], 'aerial_win_pct').counts).toEqual({ numerator: 0, denominator: 2 })
    expect(row([s.comparator!.aerial.row], 'aerial_win_pct').counts).toEqual({ numerator: 3, denominator: 9 })
    expect(s.subject.exposure.teamCompletedPasses).toBeGreaterThan(30)
    expect(s.diagnosis.status).toBe('descriptive_only')
    expect(JSON.stringify(r)).not.toMatch(/low service|weak progression/i)
  })

  it('direction flips between periods: home attacks toward -y then +y, away the reverse, and derived entries use it', () => {
    const dir = (side: 'home' | 'away', period: number) => new Set(d.events.filter((e) => e.side === side && e.period === period && e.kind === 'pass_completed').map((e) => e.normalised.attackDirection))
    expect([...dir('home', 1)]).toEqual(['toward_negative_longitudinal'])
    expect([...dir('home', 2)]).toEqual(['toward_positive_longitudinal'])
    expect([...dir('away', 1)]).toEqual(['toward_positive_longitudinal'])
    expect([...dir('away', 2)]).toEqual(['toward_negative_longitudinal'])
    const ft = (side: 'home' | 'away', w: { from?: Boundary; to?: Boundary }) => row(reportQuery(input, { window: w }).report.teams[side].metrics, 'final_third_entry_passes').value!
    const h1 = ft('home', { to: at(2, 11124) }), h2 = ft('home', { from: at(2, 11124) })
    expect(h1).toBeGreaterThan(0)
    expect(h2).toBeGreaterThan(0)
    expect(h1 + h2).toBe(ft('home', {}))
  })

  it('a partial recording says so, shows the end boundary and never presents totals as full-match totals', () => {
    const rep = reportQuery(input)
    expect(rep.capture).toMatchObject({ partial: true, coverage: 'partial', completion: 'unknown', endDisplayMinute: 87.62 })
    expect(rep.capture.endBoundary.tick).toBe(21351)
    expect(rep.result.label).toBe('observed_not_final')
    const md = renderReport(rep, { markdown: true })
    expect(md).toContain('Partial recording')
    expect(md).toContain('tick 21351')
    expect(md).toContain('OBSERVED')
    expect(md).toContain('not a verified final score')
    expect(md).not.toMatch(/full-match total/i)
    expect(md).toContain('## Evidence quality')
  })

  it('open_play stays unverified and is never compared with the counters', () => {
    const q = networkQuery(input, 't_home', { scope: 'open_play' })
    expect(q.network.recipientGate.status).toBe('fail')
    expect(q.network.recipientGate.reconciliation.status).toBe('unavailable')
    expect(q.warnings.some((w) => w.startsWith('unverified_semantics'))).toBe(true)
  })

  it('score state: Alexander was only ever trailing, Bingham was mostly drawing; the comparison carries the context', () => {
    const alexander = named('George Alexander'), bingham = named('Rakish Bingham')
    const a = scoreStateMinutes(d.sampled, alexander.participation.segments, 'home').value!
    const b = scoreStateMinutes(d.sampled, bingham.participation.segments, 'home').value!
    expect(a.ticks.drawing).toBe(0)
    expect(a.ticks.leading).toBe(0)
    expect(a.shares.trailing).toBe(1)
    expect(a.totalMinutes).toBeCloseTo(31.88, 2)
    expect(b.dominant).toBe('drawing')
    expect(b.shares.drawing).toBeGreaterThan(0.7)
    expect(b.shares.drawing).toBeLessThan(0.8)
    expect(b.shares.trailing).toBeGreaterThan(0.2)
    expect(b.ticks.leading).toBe(0)
    const r = serviceQuery(input, pid(alexander.upstreamPlayerId), { comparePlayerId: pid(bingham.upstreamPlayerId) })
    const cx = r.service.comparison!.context as { confounders: string[] }
    expect(cx.confounders).toContain('different_score_state')
    expect(r.service.comparison!.status).toBe('qualified') // not suppressed
    expect(r.service.findings.find((f) => f.ruleId === 'reception_rate_comparison_v1')!.summary).toContain('different_score_state')
  })
})
