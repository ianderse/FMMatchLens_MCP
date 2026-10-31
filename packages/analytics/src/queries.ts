import { DomainError, TICKS_PER_MINUTE, counterDelta, inWindow, participationAt } from '@fmmi/model'
import type { Participant, Side } from '@fmmi/model'
import { UNAVAILABLE_COMPONENTS, getDefinition, METRIC_DICTIONARY_VERSION, GATES } from './registry.ts'
import {
  clipSegments, teamSegments, counterRow, displayMinuteAt, internalPlayerId, makeCtx, makeRow, playerDelta, requireParticipant, segmentTicks, sideOfTeam,
  teamDelta, ticksToMin, upstreamIdOf, inSegments, envelopeCoverage,
} from './context.ts'
import type { AnalysisInput, Coverage, Ctx, MetricRow, WindowSpec } from './context.ts'
import { per90, percent, ratio } from './ratios.ts'
import { buildNetwork, completed, finalThirdEntries, receptionPoints, recipientGate, scopeInfo, scopedPasses, validReceiver } from './passes.ts'
import type { PassScope, RecipientGate } from './passes.ts'
import {
  direction, exposureGate, lowAerialSuccessGate, ruleVersionOf, suppressedChanceQuality, describeFinding,
} from './findings.ts'
import type { Finding, SuppressedFinding } from './findings.ts'
import { comparisonConfounders, scoreStateMinutes } from './scoreState.ts'
import { ratingBlock } from './ratings.ts'
import { NetworkResultSchema, PlayerResultSchema, ReportResultSchema, ServiceResultSchema, validated } from './schemas.ts'

export const ANALYTICS_SCHEMA_VERSION = '1.0'

export type QueryOptions = { window?: WindowSpec }
export type PassScopeOption = { scope?: PassScope }

// ------------------------------------------------------------------ shared pieces

export function worst(...c: Coverage[]): Coverage {
  if (c.includes('unavailable')) return 'unavailable'
  if (c.includes('partial_for_window')) return 'partial_for_window'
  return 'complete_for_window'
}

export function playerRef(ctx: Ctx, p: Participant) {
  return {
    playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name, side: p.side, teamId: ctx.input.ids.teamIds[p.side], position: p.position,
    upstream: { playerId: p.upstreamPlayerId, uid: p.uid, slot: p.slot }, identity: 'match_local' as const,
  }
}
export function teamRef(ctx: Ctx, side: Side) {
  return { teamId: ctx.input.ids.teamIds[side], name: ctx.rec.teams[side].name, side, managed: ctx.rec.humanControlledSide === side }
}

export function windowBlock(ctx: Ctx) {
  const res = (r: Ctx['resolution']['from']) => ({ source: r.source, sampledFrameTick: r.sampledFrame?.tick ?? null, unobservedTicks: r.unobservedTicks, exact: r.exact })
  return {
    from: ctx.window.from, to: ctx.window.to, bounds: ctx.window.bounds,
    display: { fromMinute: displayMinuteAt(ctx, ctx.window.from), toMinute: displayMinuteAt(ctx, ctx.window.to) },
    resolution: { from: res(ctx.resolution.from), to: res(ctx.resolution.to) },
    // Spec 8.2: the requested window (above, validated and never clipped) and what could actually be measured inside it.
    effective: {
      coverage: envelopeCoverage(ctx), exact: ctx.windowExact,
      unobservedTicks: { from: ctx.resolution.from.unobservedTicks, to: ctx.resolution.to.unobservedTicks },
      captureCoverage: ctx.rec.coverage.status,
    },
  }
}

function captureBlock(ctx: Ctx) {
  const rec = ctx.rec, cov = rec.coverage
  const fi = ctx.sampled.frames
  const last = fi.length - 1
  const endMinute = Math.round((fi.displayTicks[last]! / TICKS_PER_MINUTE) * 100) / 100
  const partial = cov.status !== 'full_match'
  const m = ctx.input.completion.manualFinalScore
  return {
    integrity: rec.integrity.status, cleanClose: rec.integrity.cleanClose, coverage: cov.status, completion: ctx.input.completion.status,
    partial,
    firstBoundary: rec.firstBoundary, endBoundary: rec.lastBoundary, endDisplayMinute: endMinute, endCaptureEndsAt: cov.endCaptureEndsAt,
    statement: partial
      ? `Capture is ${cov.status}: totals cover the captured interval only (period ${rec.firstBoundary.period} tick ${rec.firstBoundary.tick} to period ${rec.lastBoundary.period} tick ${rec.lastBoundary.tick}, game minute ${endMinute}), not the full match.`
      : null,
    manualFinalScore: m ? { home: m.home, away: m.away, label: 'manual' as const, differsFromObserved: m.differsFromObserved } : null,
  }
}

export function metricsBlock(ids: Iterable<string>) {
  const out: Record<string, { version: number; unit: string; unitVerified: boolean; derivation: string; confidence: string }> = {}
  for (const id of ids) {
    const d = getDefinition(id)
    out[id] = { version: d.version, unit: d.unit, unitVerified: d.unitVerified, derivation: d.derivation, confidence: d.confidence }
  }
  return out
}

export type QueryKind = 'report' | 'player' | 'network' | 'service' | 'summary' | 'compare' | 'status' | 'threat'

export function envelope(ctx: Ctx, query: QueryKind, rowSets: ReadonlyArray<ReadonlyArray<MetricRow>>, extraIds: string[], warnings: string[]) {
  const ids = new Set<string>(extraIds)
  for (const rs of rowSets) for (const r of rs) ids.add(r.metric)
  const w: string[] = [...(ctx.input.warnings ?? []), ...ctx.rec.warnings]
  if (!ctx.windowExact) w.push('boundary_sampled_not_exact: counters are sampled, so counter-based rows are partial_for_window; event-based rows are exact')
  if (ctx.rec.coverage.status !== 'full_match') w.push(`capture_${ctx.rec.coverage.status}: totals cover the captured interval only`)
  if (ctx.rec.integrity.status !== 'valid') w.push(`file_integrity_${ctx.rec.integrity.status}`)
  w.push(...warnings)
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION, query,
    matchId: ctx.input.ids.matchId, saveId: ctx.input.ids.saveId, recordingRevisionId: ctx.input.ids.recordingRevisionId,
    source: { kind: 'fmlens_archive' as const, format: ctx.rec.source.format, startTick: ctx.rec.firstBoundary.tick, endTick: ctx.rec.lastBoundary.tick },
    metricDictionaryVersion: METRIC_DICTIONARY_VERSION,
    window: windowBlock(ctx),
    coverage: envelopeCoverage(ctx),
    capture: captureBlock(ctx),
    result: ctx.input.result,
    teams: { home: teamRef(ctx, 'home'), away: teamRef(ctx, 'away') },
    metrics: metricsBlock(ids),
    warnings: [...new Set(w)],
  }
}

// ------------------------------------------------------------------ per-player pieces

export function playerWindowSegments(ctx: Ctx, p: Participant) { return clipSegments(p.participation.segments, ctx.window) }

export function aerialRow(ctx: Ctx, p: Participant): { row: MetricRow; attempts: number | null; won: number | null } {
  const a = playerDelta(ctx, p.upstreamPlayerId, 'aerials'), w = playerDelta(ctx, p.upstreamPlayerId, 'aerials_won')
  const r = percent(w.value, a.value)
  const cov = a.value === null || w.value === null ? 'unavailable' as const : worst(a.coverage, w.coverage)
  const row = makeRow(ctx, 'aerial_win_pct', r.value, {
    coverage: cov, nullReason: a.nullReason ?? w.nullReason ?? r.nullReason, playerId: internalPlayerId(ctx, p.upstreamPlayerId),
    counts: a.value !== null && w.value !== null ? { numerator: w.value, denominator: a.value } : undefined,
  })
  return { row, attempts: a.value, won: w.value }
}

function shotQualityRow(ctx: Ctx, key: { side: Side } | { p: Participant }) {
  const pid = 'p' in key ? internalPlayerId(ctx, key.p.upstreamPlayerId) : undefined
  const tid = 'side' in key ? ctx.input.ids.teamIds[key.side] : undefined
  const x = 'p' in key ? playerDelta(ctx, key.p.upstreamPlayerId, 'xg') : teamDelta(ctx, key.side, 'xg')
  const s = 'p' in key ? playerDelta(ctx, key.p.upstreamPlayerId, 'shots') : teamDelta(ctx, key.side, 'shots')
  const r = ratio(x.value, s.value)
  const warnings = s.value === 1 ? ['single_shot_window: do not draw firm conclusions'] : []
  return makeRow(ctx, 'shot_quality', r.value, {
    coverage: x.value === null || s.value === null ? 'unavailable' : worst(x.coverage, s.coverage), nullReason: x.nullReason ?? s.nullReason ?? r.nullReason,
    playerId: pid, teamId: tid, warnings,
  })
}

function per90Row(ctx: Ctx, metric: 'xg_per_90' | 'progressive_passes_per_90', p: Participant, ticks: number) {
  const base = metric === 'xg_per_90' ? 'xg' : 'progressive_passes'
  const d = playerDelta(ctx, p.upstreamPlayerId, base)
  const r = per90(d.value, ticks)
  return makeRow(ctx, metric, r.value, { coverage: d.coverage, nullReason: d.nullReason ?? r.nullReason, playerId: internalPlayerId(ctx, p.upstreamPlayerId), counts: d.value === null ? undefined : { numerator: d.value, denominator: ticksToMin(ticks) } })
}

const PLAYER_COUNTER_METRICS = ['passes', 'passes_completed', 'progressive_passes', 'key_passes', 'crosses', 'crosses_completed', 'aerials', 'aerials_won', 'shots', 'shots_on_target', 'xg', 'goals'] as const
const PLAYER_REPORT_METRICS = ['passes', 'passes_completed', 'progressive_passes', 'aerials', 'aerials_won', 'shots', 'xg', 'goals'] as const

export function playerRows(ctx: Ctx, p: Participant, metrics: readonly string[], ticks: number): MetricRow[] {
  const pid = internalPlayerId(ctx, p.upstreamPlayerId)
  const rows = metrics.map((m) => counterRow(ctx, m, playerDelta(ctx, p.upstreamPlayerId, m), { playerId: pid }))
  rows.push(aerialRow(ctx, p).row)
  rows.push(shotQualityRow(ctx, { p }))
  rows.push(per90Row(ctx, 'xg_per_90', p, ticks), per90Row(ctx, 'progressive_passes_per_90', p, ticks))
  return rows
}

// ------------------------------------------------------------------ findings

function lowAerialFinding(ctx: Ctx, p: Participant): { finding?: Finding; reasons: string[] } {
  const { attempts, won } = aerialRow(ctx, p)
  const g = lowAerialSuccessGate(attempts, won)
  if (!g.fires) return { reasons: g.reasons }
  const warnings = ctx.windowExact ? [] : ['partial_for_window: counters sampled at a window boundary']
  return {
    finding: {
      ruleId: 'low_aerial_success_v1', ruleVersion: ruleVersionOf('low_aerial_success_v1'), subject: { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name },
      facts: { attempts: attempts!, won: won!, winPct: (100 * won!) / attempts!, minAttempts: GATES.lowAerial.minAttempts, maxWinRatio: GATES.lowAerial.maxWinRatio },
      label: 'descriptive_heuristic', warnings,
    },
    reasons: [],
  }
}

export function playerFindings(ctx: Ctx, ps: readonly Participant[]) {
  const findings: Finding[] = [], suppressed: SuppressedFinding[] = []
  for (const p of ps) {
    const r = lowAerialFinding(ctx, p)
    if (r.finding) findings.push(r.finding)
    const subject = { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name }
    const shots = playerDelta(ctx, p.upstreamPlayerId, 'shots').value
    const s = suppressedChanceQuality(subject, shots)
    if (s) suppressed.push(s)
  }
  return { findings, suppressed }
}

export const playedIn = (ctx: Ctx, p: Participant) => segmentTicks(playerWindowSegments(ctx, p)) > 0

// ------------------------------------------------------------------ report

function aerialAgreement(ctx: Ctx, side: Side) {
  const evs = ctx.events.filter((e) => e.side === side && (e.kind === 'aerial_won' || e.kind === 'aerial_lost') && inWindow(e, ctx.window))
  const won = evs.filter((e) => e.kind === 'aerial_won').length
  const a = teamDelta(ctx, side, 'aerials'), w = teamDelta(ctx, side, 'aerials_won')
  return {
    side, events: { attempts: evs.length, won },
    counters: a.value === null || w.value === null ? null : { attempts: a.value, won: w.value },
    residual: a.value === null || w.value === null ? null : { attempts: evs.length - a.value, won: won - w.value },
  }
}
export function teamRows(ctx: Ctx, side: Side): MetricRow[] {
  const tid = ctx.input.ids.teamIds[side]
  const opp: Side = side === 'home' ? 'away' : 'home'
  const row = (m: string) => counterRow(ctx, m, teamDelta(ctx, side, m), { teamId: tid })
  const rows: MetricRow[] = ['goals', 'xg', 'shots', 'shots_on_target'].map(row)
  rows.push(shotQualityRow(ctx, { side }))
  rows.push(row('passes'), row('passes_completed'))
  const pa = teamDelta(ctx, side, 'passes'), pc = teamDelta(ctx, side, 'passes_completed')
  const pr = percent(pc.value, pa.value)
  rows.push(makeRow(ctx, 'pass_completion_pct', pr.value, {
    coverage: pa.value === null || pc.value === null ? 'unavailable' : worst(pa.coverage, pc.coverage), nullReason: pa.nullReason ?? pc.nullReason ?? pr.nullReason, teamId: tid,
    counts: pa.value === null || pc.value === null ? undefined : { numerator: pc.value, denominator: pa.value },
  }))
  rows.push(row('progressive_passes'), row('final_third_passes'))
  const ft = finalThirdEntries(ctx, side)
  rows.push(makeRow(ctx, 'final_third_entry_passes', ft.value, {
    coverage: 'complete_for_window', nullReason: ft.nullReason, teamId: tid,
    warnings: ft.unmeasurable > 0 ? [`${ft.unmeasurable}_completed_passes_lack_an_endpoint`] : undefined,
  }))
  for (const m of ['crosses', 'crosses_completed', 'aerials', 'aerials_won']) rows.push(row(m))
  const aw = teamDelta(ctx, side, 'aerials_won'), aa = teamDelta(ctx, side, 'aerials')
  const ar = percent(aw.value, aa.value)
  rows.push(makeRow(ctx, 'aerial_win_pct', ar.value, {
    coverage: aw.value === null || aa.value === null ? 'unavailable' : worst(aw.coverage, aa.coverage), nullReason: aw.nullReason ?? aa.nullReason ?? ar.nullReason, teamId: tid,
    counts: aw.value === null || aa.value === null ? undefined : { numerator: aw.value, denominator: aa.value },
  }))
  const posOwn = possessionDelta(ctx, side), posOpp = possessionDelta(ctx, opp)
  const pp = posOwn.value !== null && posOpp.value !== null ? percent(posOwn.value, posOwn.value + posOpp.value) : { value: null, nullReason: posOwn.nullReason ?? posOpp.nullReason }
  rows.push(makeRow(ctx, 'possession_pct', pp.value, {
    coverage: pp.value !== null ? worst(posOwn.coverage, posOpp.coverage) : 'unavailable', nullReason: pp.nullReason, teamId: tid,
    warnings: ['possession_time_unit_unverified: ratio of counter deltas; the unit of possessionTime is unverified'],
  }))
  for (const m of ['corners', 'fouls', 'yellow_cards', 'red_cards']) rows.push(row(m))
  return rows
}

function possessionDelta(ctx: Ctx, side: Side) { return counterDelta(ctx.sampled, `team.${side}.possessionTime`, ctx.window) }

export function reportQuery(input: AnalysisInput, opts: QueryOptions = {}) {
  const ctx = makeCtx(input, opts.window)
  const teams = { home: { ...teamRef(ctx, 'home'), metrics: teamRows(ctx, 'home') }, away: { ...teamRef(ctx, 'away'), metrics: teamRows(ctx, 'away') } }
  const played = ctx.rec.roster.filter((p) => playedIn(ctx, p))
  const players = played.map((p) => {
    const segs = playerWindowSegments(ctx, p)
    const ticks = segmentTicks(segs)
    return {
      ...playerRef(ctx, p), minutesInWindow: ticksToMin(ticks), enteredAs: p.participation.enteredAs, onPitchAtEndOfRecording: p.participation.onPitchAtEndOfRecording,
      metrics: playerRows(ctx, p, PLAYER_REPORT_METRICS, ticks).filter((r) => !['xg_per_90', 'progressive_passes_per_90', 'shot_quality'].includes(r.metric) || r.value !== null),
    }
  })
  const { findings, suppressed } = playerFindings(ctx, played)
  const gates = { home: recipientGate(ctx, 'home', 'counter_scope'), away: recipientGate(ctx, 'away', 'counter_scope') }
  const unused = ctx.rec.roster.filter((p) => !playedIn(ctx, p)).map((p) => ({ ...playerRef(ctx, p), status: p.participation.status }))
  const warnings: string[] = []
  for (const s of ['home', 'away'] as const) if (gates[s].status === 'fail') warnings.push(`recipient_gate_failed_${s}: ${gates[s].reasons.join(', ')}`)
  const rowSets = [...Object.values(teams).map((t) => t.metrics), ...players.map((p) => p.metrics)]
  return validated(ReportResultSchema, {
    ...envelope(ctx, 'report', rowSets, [], warnings),
    report: {
      teams,
      players,
      notInWindow: unused,
      substitutions: ctx.rec.substitutionBatches.map((b) => ({
        side: b.side, period: b.period, tick: b.tick, off: b.off.map((id) => internalPlayerId(ctx, id)), on: b.on.map((id) => internalPlayerId(ctx, id)), pairing: b.pairing,
      })),
      findings: findings.map((f) => ({ ...f, summary: describeFinding(f) })),
      suppressedFindings: suppressed,
      evidenceQuality: {
        recipientGate: gates,
        reconciliation: { home: gates.home.reconciliation, away: gates.away.reconciliation },
        aerialEventCounterAgreement: { home: aerialAgreement(ctx, 'home'), away: aerialAgreement(ctx, 'away') },
        unavailable: UNAVAILABLE_COMPONENTS,
      },
    },
  })
}

// ------------------------------------------------------------------ player

export interface PlayerExposure {
  segments: ReturnType<typeof clipSegments>
  ticks: number
  teamCompletedPasses: number
  receptions: ReturnType<typeof completed>
  ambiguousBoundaryReceptions: number
}

export function exposureOf(ctx: Ctx, p: Participant, scope: PassScope): PlayerExposure {
  const segments = playerWindowSegments(ctx, p)
  const teamCompleted = completed(scopedPasses(ctx, p.side, scope))
  const receptions = teamCompleted.filter((e) => validReceiver(ctx, e) === p.upstreamPlayerId && inSegments(e, segments))
  const ambiguous = teamCompleted.filter((e) => validReceiver(ctx, e) === p.upstreamPlayerId && e.period !== null && participationAt(p.participation.segments, { period: e.period, tick: e.tick }) === 'ambiguous').length
  return { segments, ticks: segmentTicks(segments), teamCompletedPasses: teamCompleted.filter((e) => inSegments(e, segments)).length, receptions, ambiguousBoundaryReceptions: ambiguous }
}

export function receptionRows(ctx: Ctx, p: Participant, x: PlayerExposure, gate: RecipientGate): MetricRow[] {
  const pid = internalPlayerId(ctx, p.upstreamPlayerId)
  const warnings: string[] = []
  if (gate.status === 'fail') warnings.push('recipient_gate_failed: partial observed links; no claim about little or no service')
  if (x.ambiguousBoundaryReceptions > 0) warnings.push(`substitution_boundary_ambiguous: ${x.ambiguousBoundaryReceptions} reception(s) at a substitution tick; event-versus-flip order is not recorded`)
  const coverage: Coverage = gate.status === 'pass' ? 'complete_for_window' : 'partial_for_window'
  const n = x.receptions.length
  const r90 = per90(n, x.ticks)
  const share = percent(n, x.teamCompletedPasses)
  return [
    makeRow(ctx, 'passes_received', n, { coverage, playerId: pid, warnings }),
    makeRow(ctx, 'passes_received_per_90', r90.value, { coverage, nullReason: r90.nullReason, playerId: pid, counts: { numerator: n, denominator: ticksToMin(x.ticks) }, warnings }),
    makeRow(ctx, 'passes_received_pct_of_team_completed', share.value, { coverage, nullReason: share.nullReason, playerId: pid, counts: { numerator: n, denominator: x.teamCompletedPasses }, warnings }),
  ]
}

function receptionLocations(ctx: Ctx, x: PlayerExposure) {
  const pts = receptionPoints(ctx, x.receptions)
  const withoutSample = x.receptions.length - pts.length
  if (pts.length === 0) return { samples: 0, withoutSample, mean: null, thirds: null, derivation: 'derived_from_trajectory_end', independent: false as const }
  const third = (u: number) => (u < 1 / 3 ? 'defensive' : u < GATES.finalThird ? 'middle' : 'final')
  const thirds = { defensive: 0, middle: 0, final: 0 }
  for (const p of pts) thirds[third(p.forwardUnit)]++
  return {
    samples: pts.length, withoutSample,
    mean: { lateralUnit: pts.reduce((a, p) => a + p.lateralUnit, 0) / pts.length, forwardUnit: pts.reduce((a, p) => a + p.forwardUnit, 0) / pts.length },
    thirds, derivation: 'derived_from_trajectory_end', independent: false as const,
  }
}

function byPeriod(x: PlayerExposure) {
  const m = new Map<number, number>()
  for (const e of x.receptions) m.set(e.period!, (m.get(e.period!) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([period, receptions]) => ({ period, receptions }))
}

export function participationBlock(ctx: Ctx, p: Participant) {
  const segs = playerWindowSegments(ctx, p)
  return {
    status: p.participation.status, enteredAs: p.participation.enteredAs, minutesInWindow: ticksToMin(segmentTicks(segs)), ticksInWindow: segmentTicks(segs),
    minutesInRecording: p.participation.elapsedMinutes,
    segments: segs.map((s) => ({ period: s.period, fromTick: s.fromTick, toTick: s.toTick })),
    firstOn: p.participation.firstOn, lastOff: p.participation.lastOff, onPitchAtEndOfRecording: p.participation.onPitchAtEndOfRecording,
    sameTickBatch: p.participation.sameTickBatch,
    note: 'Playing minutes are verified elapsed game-clock ticks / 240 inside the window, halftime excluded.',
  }
}

function fallbackBlock(gate: RecipientGate) {
  return gate.status === 'pass' ? null : {
    reason: 'recipient_gate_failed', gateReasons: gate.reasons,
    observedLinks: 'partial' as const,
    claims: 'No claim about little or no service is made; a service diagnosis is withheld.',
    available: ['cumulative_passing', 'aerial', 'shooting'],
  }
}

export function playerQuery(input: AnalysisInput, playerId: string, opts: QueryOptions & PassScopeOption = {}) {
  const ctx = makeCtx(input, opts.window)
  const p = requireParticipant(ctx, upstreamIdOf(ctx, playerId))
  const scope = opts.scope ?? 'counter_scope'
  const info = scopeInfo(scope)
  const ticks = segmentTicks(playerWindowSegments(ctx, p))
  const x = exposureOf(ctx, p, scope)
  const gate = recipientGate(ctx, p.side, scope)
  const counters = playerRows(ctx, p, PLAYER_COUNTER_METRICS, ticks)
  const reception = receptionRows(ctx, p, x, gate)
  const { findings, suppressed } = playerFindings(ctx, [p])
  return validated(PlayerResultSchema, {
    ...envelope(ctx, 'player', [counters, reception], ['ground_service_receptions', 'native_rating', 'estimated_rating_contribution', 'rating_reconstruction_residual'], [...info.warnings]),
    player: {
      ...playerRef(ctx, p),
      participation: participationBlock(ctx, p),
      roleTimeline: p.roleTimeline,
      nativeRating: { value: p.nativeRating, basis: 'observed_value_at_last_frame' as const },
      rating: ratingBlock(ctx, p),
      metrics: counters,
      passing: {
        scope: info, recipientGate: gate, fallback: fallbackBlock(gate),
        exposure: { playerTicks: x.ticks, playerMinutes: ticksToMin(x.ticks), teamCompletedPasses: x.teamCompletedPasses },
        received: reception, receptionLocations: receptionLocations(ctx, x), receptionsByPeriod: byPeriod(x),
        groundService: { value: null, nullReason: 'not_recorded' as const, note: 'No ground/air classification exists; all-pass receptions are not ground service.' },
      },
      findings: findings.map((f) => ({ ...f, summary: describeFinding(f) })),
      suppressedFindings: suppressed,
      unavailable: UNAVAILABLE_COMPONENTS,
    },
  })
}

// ------------------------------------------------------------------ network

export function networkQuery(input: AnalysisInput, teamId: string, opts: QueryOptions & PassScopeOption & { minPasses?: number; limit?: number } = {}) {
  const ctx = makeCtx(input, opts.window)
  const side = sideOfTeam(ctx, teamId)
  const scope = opts.scope ?? 'counter_scope'
  if (opts.minPasses !== undefined && (!Number.isInteger(opts.minPasses) || opts.minPasses < 1)) throw new DomainError('invalid_input', 'minPasses must be a positive integer', { reason: 'min_passes' })
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) throw new DomainError('invalid_input', 'limit must be between 1 and 100', { reason: 'limit' })
  const gate = recipientGate(ctx, side, scope)
  const net = buildNetwork(ctx, side, scope, opts, (up) => ticksToMin(segmentTicks(playerWindowSegments(ctx, ctx.roster.get(up)!))))
  const warnings = [...net.scope.warnings]
  if (gate.status === 'fail') warnings.push(`recipient_gate_failed: ${gate.reasons.join(', ')}; links are partial observed evidence`)
  const ftRows = [makeRow(ctx, 'passing_network_link', net.totals.edgeCompletions, { coverage: gate.status === 'pass' ? 'complete_for_window' : 'partial_for_window', teamId })]
  return validated(NetworkResultSchema, {
    ...envelope(ctx, 'network', [ftRows], ['forward_pass_distance', 'reception_location'], warnings),
    network: {
      team: teamRef(ctx, side),
      scope: net.scope,
      recipientGate: gate,
      fallback: fallbackBlock(gate),
      summary: ftRows,
      totals: net.totals,
      edges: net.edges,
      nodes: net.nodes,
      nodesWithoutLocation: net.nodesWithoutLocation,
      derivationNote: 'Links are built from completed pass events only; incomplete passes carry no receiver. Players substituted off keep their links. Reception locations are derived from trajectory ends.',
    },
  })
}

// ------------------------------------------------------------------ striker service

export function serviceQuery(input: AnalysisInput, playerId: string, opts: QueryOptions & PassScopeOption & { comparePlayerId?: string } = {}) {
  const ctx = makeCtx(input, opts.window)
  const p = requireParticipant(ctx, upstreamIdOf(ctx, playerId))
  const q = opts.comparePlayerId !== undefined ? requireParticipant(ctx, upstreamIdOf(ctx, opts.comparePlayerId)) : null
  if (q && q.upstreamPlayerId === p.upstreamPlayerId) throw new DomainError('invalid_input', 'The comparator must be a different player', { reason: 'compare_same_player' })
  const scope = opts.scope ?? 'counter_scope'
  const info = scopeInfo(scope)
  const gate = recipientGate(ctx, p.side, scope)
  const x = exposureOf(ctx, p, scope)

  const block = (pl: Participant, ex: PlayerExposure) => {
    const g = pl.side === p.side ? gate : recipientGate(ctx, pl.side, scope)
    const a = aerialRow(ctx, pl)
    return {
      player: playerRef(ctx, pl),
      exposure: { playerTicks: ex.ticks, playerMinutes: ticksToMin(ex.ticks), teamCompletedPasses: ex.teamCompletedPasses },
      reception: receptionRows(ctx, pl, ex, g),
      receptionLocations: receptionLocations(ctx, ex),
      receptionsByPeriod: byPeriod(ex),
      aerial: a,
      shooting: [counterRow(ctx, 'shots', playerDelta(ctx, pl.upstreamPlayerId, 'shots'), { playerId: internalPlayerId(ctx, pl.upstreamPlayerId) }),
        counterRow(ctx, 'xg', playerDelta(ctx, pl.upstreamPlayerId, 'xg'), { playerId: internalPlayerId(ctx, pl.upstreamPlayerId) }),
        shotQualityRow(ctx, { p: pl }), per90Row(ctx, 'xg_per_90', pl, ex.ticks)],
      passing: [counterRow(ctx, 'passes', playerDelta(ctx, pl.upstreamPlayerId, 'passes'), { playerId: internalPlayerId(ctx, pl.upstreamPlayerId) }),
        counterRow(ctx, 'passes_completed', playerDelta(ctx, pl.upstreamPlayerId, 'passes_completed'), { playerId: internalPlayerId(ctx, pl.upstreamPlayerId) }),
        counterRow(ctx, 'progressive_passes', playerDelta(ctx, pl.upstreamPlayerId, 'progressive_passes'), { playerId: internalPlayerId(ctx, pl.upstreamPlayerId) }),
        per90Row(ctx, 'progressive_passes_per_90', pl, ex.ticks)],
      participation: participationBlock(ctx, pl),
      gate: g,
    }
  }
  const main = block(p, x)
  const other = q ? block(q, exposureOf(ctx, q, scope)) : null

  const findings: Finding[] = [], suppressed: SuppressedFinding[] = []
  for (const pl of q ? [p, q] : [p]) {
    const r = lowAerialFinding(ctx, pl)
    if (r.finding) findings.push(r.finding)
    const s = suppressedChanceQuality({ playerId: internalPlayerId(ctx, pl.upstreamPlayerId), name: pl.name }, playerDelta(ctx, pl.upstreamPlayerId, 'shots').value)
    if (s) suppressed.push(s)
  }

  let context: null | Record<string, unknown> = null
  let comparison: null | {
    context: Record<string, unknown> | null
    comparator: ReturnType<typeof playerRef>; status: 'qualified' | 'suppressed'; reasons: string[]
    gates: { subject: ReturnType<typeof exposureGate>; comparator: ReturnType<typeof exposureGate> }
    differences: null | { receptionsPer90: number | null; pctOfTeamCompleted: number | null; progressivePer90: number | null; direction: ReturnType<typeof direction> | null }
  } = null
  if (q && other) {
    const ga = exposureGate({ playerTicks: x.ticks, teamCompletedPasses: x.teamCompletedPasses })
    const gb = exposureGate({ playerTicks: other.exposure.playerTicks, teamCompletedPasses: other.exposure.teamCompletedPasses })
    const reasons: string[] = []
    if (!ga.passes) reasons.push(...ga.reasons.map((r) => `subject:${r}`))
    if (!gb.passes) reasons.push(...gb.reasons.map((r) => `comparator:${r}`))
    if (q.side !== p.side) reasons.push('comparator_in_other_team')
    if (info.semantics !== 'verified') reasons.push('pass_scope_semantics_unverified')
    if (gate.status === 'fail') reasons.push(...gate.reasons.map((r) => `recipient_gate:${r}`))
    const exB = exposureOf(ctx, q, scope)
    const recepA = per90(x.receptions.length, x.ticks), recepB = per90(exB.receptions.length, exB.ticks)
    const shareA = percent(x.receptions.length, x.teamCompletedPasses)
    const ssA = scoreStateMinutes(ctx.sampled, x.segments, p.side), ssB = scoreStateMinutes(ctx.sampled, exB.segments, q.side)
    const flips = ctx.rec.substitutionBatches.filter((b) => inWindow({ period: b.period, tick: b.tick }, ctx.window))
    const confounders = comparisonConfounders(ssA, ssB, ticksToMin(x.ticks), ticksToMin(exB.ticks), flips.length)
    context = {
      subject: { player: playerRef(ctx, p), scoreState: ssA },
      comparator: { player: playerRef(ctx, q), scoreState: ssB },
      substitutionFlips: flips.map((b) => ({ side: b.side, period: b.period, tick: b.tick, off: b.off.length, on: b.on.length, pairing: b.pairing })),
      confounders,
      note: 'Context is reported beside the comparison and is not adjusted for. Thresholds are labelled heuristics (docs/metrics.md).',
    }
    const ctxFacts = {
      ssLead: ssA.value?.minutes.leading ?? null, ssDraw: ssA.value?.minutes.drawing ?? null, ssTrail: ssA.value?.minutes.trailing ?? null,
      osLead: ssB.value?.minutes.leading ?? null, osDraw: ssB.value?.minutes.drawing ?? null, osTrail: ssB.value?.minutes.trailing ?? null,
      confounders: confounders.join(', '),
    }
    const shareB = percent(exB.receptions.length, exB.teamCompletedPasses)
    const pa = playerDelta(ctx, p.upstreamPlayerId, 'progressive_passes'), pb = playerDelta(ctx, q.upstreamPlayerId, 'progressive_passes')
    const progA = per90(pa.value, x.ticks), progB = per90(pb.value, exB.ticks)
    const qualified = reasons.length === 0 && recepA.value !== null && recepB.value !== null
    if (qualified) {
      const f: Finding = {
        ruleId: 'reception_rate_comparison_v1', ruleVersion: ruleVersionOf('reception_rate_comparison_v1'),
        subject: { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name }, comparator: { playerId: internalPlayerId(ctx, q.upstreamPlayerId), name: q.name },
        facts: {
          receptions: x.receptions.length, minutes: ticksToMin(x.ticks), perNinety: recepA.value, pctOfTeam: shareA.value, teamCompletedPasses: x.teamCompletedPasses,
          otherReceptions: exB.receptions.length, otherMinutes: ticksToMin(exB.ticks), otherPerNinety: recepB.value, otherPctOfTeam: shareB.value, otherTeamCompletedPasses: exB.teamCompletedPasses,
          deltaPerNinety: recepA.value! - recepB.value!, direction: direction(recepA.value!, recepB.value!), scope, ...ctxFacts,
        },
        label: 'descriptive_comparison', warnings: ctx.windowExact ? [] : ['window_boundary_sampled'],
      }
      findings.push(f)
    } else {
      suppressed.push({ ruleId: 'reception_rate_comparison_v1', subject: { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name }, reasons: reasons.length ? reasons : ['rate_unavailable'] })
    }
    const progReasons = reasons.filter((r) => !r.startsWith('recipient_gate:') && r !== 'pass_scope_semantics_unverified')
    if (progReasons.length === 0 && progA.value !== null && progB.value !== null) {
      findings.push({
        ruleId: 'progression_rate_comparison_v1', ruleVersion: ruleVersionOf('progression_rate_comparison_v1'),
        subject: { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name }, comparator: { playerId: internalPlayerId(ctx, q.upstreamPlayerId), name: q.name },
        facts: {
          progressive: pa.value, minutes: ticksToMin(x.ticks), perNinety: progA.value, otherProgressive: pb.value, otherMinutes: ticksToMin(exB.ticks), otherPerNinety: progB.value,
          deltaPerNinety: progA.value - progB.value, direction: direction(progA.value, progB.value), ...ctxFacts,
        },
        label: 'descriptive_comparison', warnings: pa.coverage === 'complete_for_window' && pb.coverage === 'complete_for_window' ? [] : ['partial_for_window: counters sampled at a window boundary'],
      })
    } else {
      suppressed.push({ ruleId: 'progression_rate_comparison_v1', subject: { playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name }, reasons: progReasons.length ? progReasons : ['rate_unavailable'] })
    }
    comparison = {
      context,
      comparator: playerRef(ctx, q), status: qualified ? 'qualified' : 'suppressed', reasons,
      gates: { subject: ga, comparator: gb },
      differences: qualified ? {
        receptionsPer90: recepA.value! - recepB.value!, pctOfTeamCompleted: shareA.value !== null && shareB.value !== null ? shareA.value - shareB.value : null,
        progressivePer90: progA.value !== null && progB.value !== null ? progA.value - progB.value : null, direction: direction(recepA.value!, recepB.value!),
      } : null,
    }
  }

  const rowSets = [main.reception, main.shooting, main.passing, [main.aerial.row], ...(other ? [other.reception, other.shooting, other.passing, [other.aerial.row]] : [])]
  const warnings = [...info.warnings]
  if (gate.status === 'fail') warnings.push(`recipient_gate_failed: ${gate.reasons.join(', ')}; service diagnosis withheld`)
  return validated(ServiceResultSchema, {
    ...envelope(ctx, 'service', rowSets, ['ground_service_receptions', 'reception_location'], warnings),
    service: {
      subject: main,
      comparator: other,
      scope: info,
      recipientGate: gate,
      fallback: fallbackBlock(gate),
      diagnosis: gate.status === 'pass'
        ? { status: 'descriptive_only' as const, note: 'Components are reported with exposure; no absolute low-service label and no isolation score exist.' }
        : { status: 'withheld' as const, note: 'Recipient evidence failed the section 7.2 gate: the available passing, aerial and shooting data are reported, with no claim about little or no service.' },
      components: [
        { id: 'passes_received', availability: gate.status === 'pass' ? 'available' : 'partial_observed', reason: gate.status === 'pass' ? null : 'recipient_gate_failed' },
        { id: 'reception_locations', availability: 'derived', reason: 'derived_from_trajectory_end_not_independent' },
        { id: 'aerial_duels', availability: 'available', reason: null },
        { id: 'shooting_and_xg', availability: 'available', reason: null },
        { id: 'ground_service', availability: 'unavailable', reason: 'not_recorded' },
        ...UNAVAILABLE_COMPONENTS.filter((u) => ['final_third_touches', 'support_proximity', 'opponent_centre_back_matchup'].includes(u.id)).map((u) => ({ id: u.id, availability: 'unavailable', reason: u.reason })),
      ],
      comparison,
      findings: findings.map((f) => ({ ...f, summary: describeFinding(f) })),
      suppressedFindings: suppressed,
      unavailable: UNAVAILABLE_COMPONENTS,
    },
  })
}

export type ReportResult = ReturnType<typeof reportQuery>
export type PlayerResult = ReturnType<typeof playerQuery>
export type NetworkResult = ReturnType<typeof networkQuery>
export type ServiceResult = ReturnType<typeof serviceQuery>

/** Score-state minutes for a team over a window (team playing time). Shared with the Slice 3 period comparison. */
export function scoreStateQuery(input: AnalysisInput, teamId: string, opts: QueryOptions = {}) {
  const ctx = makeCtx(input, opts.window)
  const side = sideOfTeam(ctx, teamId)
  const r = scoreStateMinutes(ctx.sampled, clipSegments(teamSegments(ctx.rec), ctx.window), side)
  return { matchId: ctx.input.ids.matchId, recordingRevisionId: ctx.input.ids.recordingRevisionId, teamId, window: windowBlock(ctx), scoreState: r }
}
