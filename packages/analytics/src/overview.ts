import { DomainError, compareBoundary, inWindow } from '@fmmi/model'
import type { Side } from '@fmmi/model'
import { UNAVAILABLE_COMPONENTS } from './registry.ts'
import {
  clipSegments, envelopeCoverage, internalPlayerId, makeCtx, requireParticipant, segmentTicks, sideOfTeam, teamSegments, ticksToMin, upstreamIdOf,
} from './context.ts'
import type { AnalysisInput, Coverage, Ctx, MetricRow, WindowSpec } from './context.ts'
import { exposureGate } from './findings.ts'
import { per90 } from './ratios.ts'
import { recipientGate } from './passes.ts'
import type { PassScope } from './passes.ts'
import { comparisonConfounders, scoreStateMinutes } from './scoreState.ts'
import {
  envelope, exposureOf, playedIn, playerFindings, playerRef, playerRows, playerWindowSegments, receptionRows, teamRef, teamRows, windowBlock, worst,
} from './queries.ts'
import { CompareResultSchema, StatusResultSchema, SummaryResultSchema, validated } from './schemas.ts'
import { describeFinding } from './findings.ts'

/**
 * Slice 3 domain queries that have no CLI-era counterpart: the compact match summary (with the complete roster), the
 * two-window comparison and the per-recording evidence status. The MCP adapter and the CLI both call these through
 * MatchQueries; nothing here knows about MCP.
 */

// ------------------------------------------------------------------ summary

/** Metrics shown side by side. A subset of the report rows: the summary must stay compact for a complete match. */
const SUMMARY_METRICS = [
  'goals', 'xg', 'shots', 'shots_on_target', 'shot_quality', 'passes', 'passes_completed', 'pass_completion_pct', 'progressive_passes',
  'final_third_entry_passes', 'aerials', 'aerials_won', 'aerial_win_pct', 'possession_pct', 'corners', 'fouls', 'yellow_cards', 'red_cards',
] as const

type Cell = Omit<MetricRow, 'metric' | 'teamId' | 'playerId'>
const cellOf = (r: MetricRow): Cell => { const { metric: _m, teamId: _t, playerId: _p, ...rest } = r; return rest }

const boundaryText = (b: { period: number; tick: number } | null): string | null => (b ? `${b.period}:${b.tick}` : null)

function rosterRows(ctx: Ctx, side: Side | null) {
  return ctx.rec.roster.filter((p) => side === null || p.side === side).map((p) => ({
    playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name, side: p.side, position: p.position, shirtNumber: p.shirtNumber,
    status: p.participation.status, enteredAs: p.participation.enteredAs,
    minutes: Math.round(p.participation.elapsedMinutes * 100) / 100,
    // Canonical boundaries as "<period>:<tick>", the same text the window inputs accept. offAt null with status played
    // means the player was still on the pitch when the recording ended.
    onAt: boundaryText(p.participation.firstOn), offAt: boundaryText(p.participation.lastOff),
  }))
}

function gateSummary(ctx: Ctx, side: Side) {
  const g = recipientGate(ctx, side, 'counter_scope')
  return {
    status: g.status, scope: g.scope, coverageRatio: g.coverageRatio, eligibleCompletedPasses: g.eligibleCompletedPasses, withVerifiedReceiver: g.withVerifiedReceiver,
    reconciliation: g.reconciliation.status, reasons: g.reasons, verifiedAgainstUi: g.verifiedAgainstUi,
  }
}

export function summaryQuery(input: AnalysisInput, opts: { teamId?: string } = {}) {
  const ctx = makeCtx(input)
  const focus: Side | null = opts.teamId !== undefined ? sideOfTeam(ctx, opts.teamId) : null
  const rows = { home: teamRows(ctx, 'home'), away: teamRows(ctx, 'away') }
  const pick = (side: Side, m: string): MetricRow => rows[side].find((r) => r.metric === m)!
  const comparison = SUMMARY_METRICS.map((m) => ({ metric: m, home: cellOf(pick('home', m)), away: cellOf(pick('away', m)) }))
  const played = ctx.rec.roster.filter((p) => playedIn(ctx, p) && (focus === null || p.side === focus))
  const { findings, suppressed } = playerFindings(ctx, played)
  const gates = { home: gateSummary(ctx, 'home'), away: gateSummary(ctx, 'away') }
  const warnings: string[] = []
  for (const s of ['home', 'away'] as const) if (gates[s].status === 'fail') warnings.push(`recipient_gate_failed_${s}: ${gates[s].reasons.join(', ')}`)
  const roster = rosterRows(ctx, focus)
  const rowSets = [rows.home.filter((r) => (SUMMARY_METRICS as readonly string[]).includes(r.metric)), rows.away.filter((r) => (SUMMARY_METRICS as readonly string[]).includes(r.metric))]
  return validated(SummaryResultSchema, {
    ...envelope(ctx, 'summary', rowSets, [], warnings),
    summary: {
      managedSide: ctx.rec.humanControlledSide,
      focusTeamId: opts.teamId ?? null,
      comparison,
      roster: {
        total: ctx.rec.roster.length, returned: roster.length, filteredToTeamId: opts.teamId ?? null,
        played: roster.filter((r) => r.status === 'played').length, unusedSubstitutes: roster.filter((r) => r.status === 'unused_substitute').length,
        players: roster,
      },
      substitutions: ctx.rec.substitutionBatches.map((b) => ({
        side: b.side, at: `${b.period}:${b.tick}`, off: b.off.map((id) => internalPlayerId(ctx, id)), on: b.on.map((id) => internalPlayerId(ctx, id)), pairing: b.pairing,
      })),
      events: ctx.rec.eventSummary,
      findings: findings.map((f) => ({ ...f, summary: describeFinding(f) })),
      suppressedFindings: suppressed,
      evidenceQuality: { recipientGate: gates, unavailable: UNAVAILABLE_COMPONENTS.map((u) => u.id) },
    },
  })
}

// ------------------------------------------------------------------ period comparison

/** Count metrics are compared as per-90 rates over verified team minutes; ratios and percentages as plain values. */
const COMPARE_RATE_METRICS = ['goals', 'xg', 'shots', 'shots_on_target', 'passes_completed', 'progressive_passes', 'final_third_entry_passes', 'corners'] as const
const COMPARE_VALUE_METRICS = ['shot_quality', 'pass_completion_pct', 'possession_pct', 'aerial_win_pct'] as const
const MAX_COMPARE_PLAYERS = 4

type WindowCell = Cell & { perNinety?: number | null }

function teamCompareRows(ctxA: Ctx, ctxB: Ctx, side: Side, ticksA: number, ticksB: number) {
  const ra = teamRows(ctxA, side), rb = teamRows(ctxB, side)
  const cell = (rows: MetricRow[], m: string, ticks: number, rate: boolean): WindowCell => {
    const c = cellOf(rows.find((r) => r.metric === m)!) as WindowCell
    if (rate) c.perNinety = c.value === null ? null : per90(c.value, ticks).value
    return c
  }
  const delta = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? null : y - x)
  const out = [
    ...COMPARE_RATE_METRICS.map((m) => {
      const a = cell(ra, m, ticksA, true), b = cell(rb, m, ticksB, true)
      return { metric: m, comparedAs: 'per_90' as const, a, b, delta: delta(a.perNinety, b.perNinety) }
    }),
    ...COMPARE_VALUE_METRICS.map((m) => {
      const a = cell(ra, m, ticksA, false), b = cell(rb, m, ticksB, false)
      return { metric: m, comparedAs: 'value' as const, a, b, delta: delta(a.value, b.value) }
    }),
  ]
  return { out, ra, rb }
}

function playerCompare(ctxA: Ctx, ctxB: Ctx, upstreamId: number, scope: PassScope) {
  const pa = requireParticipant(ctxA, upstreamId), pb = requireParticipant(ctxB, upstreamId)
  const one = (ctx: Ctx, p: typeof pa) => {
    const ticks = segmentTicks(playerWindowSegments(ctx, p))
    const x = exposureOf(ctx, p, scope)
    const gate = exposureGate({ playerTicks: x.ticks, teamCompletedPasses: x.teamCompletedPasses })
    const rg = recipientGate(ctx, p.side, scope)
    // Per-90 and percentage rows carry their raw counts (numerator/denominator), so the plain counters are not repeated.
    const base = playerRows(ctx, p, ['shots'], ticks)
      .filter((r) => ['shots', 'xg_per_90', 'progressive_passes_per_90', 'aerial_win_pct'].includes(r.metric))
    const reception = receptionRows(ctx, p, x, rg)
    // The player id sits once on the entry, so rows drop their own playerId to keep the output compact.
    const rows = [...base, ...reception].map(({ playerId: _p, ...r }) => r)
    const { teamCompletedPasses: _n, ...gateRest } = gate
    return { minutes: ticksToMin(ticks), teamCompletedPasses: x.teamCompletedPasses, exposureGate: gateRest, recipientGate: { status: rg.status, reasons: rg.reasons }, rows }
  }
  const a = one(ctxA, pa), b = one(ctxB, pb)
  const reasons: string[] = []
  if (!a.exposureGate.passes) reasons.push(...a.exposureGate.reasons.map((r) => `window_a:${r}`))
  if (!b.exposureGate.passes) reasons.push(...b.exposureGate.reasons.map((r) => `window_b:${r}`))
  const qualified = reasons.length === 0
  const valueOf = (cell: { rows: Array<Omit<MetricRow, 'playerId'>> }, m: string) => cell.rows.find((r) => r.metric === m)?.value ?? null
  const d = (m: string) => { const x = valueOf(a, m), y = valueOf(b, m); return x === null || y === null ? null : y - x }
  const receptionOk = a.recipientGate.status === 'pass' && b.recipientGate.status === 'pass'
  return {
    player: playerRef(ctxA, pa), a, b,
    status: qualified ? ('qualified' as const) : ('suppressed' as const),
    reasons,
    // Rate differences are reported only when the exposure gates pass in EACH window (spec 7.7).
    deltas: qualified ? {
      progressivePassesPer90: d('progressive_passes_per_90'), xgPer90: d('xg_per_90'),
      passesReceivedPer90: receptionOk ? d('passes_received_per_90') : null,
      passesReceivedPer90NullReason: receptionOk ? null : 'recipient_gate_failed',
    } : null,
  }
}

export function compareQuery(
  input: AnalysisInput, teamId: string,
  opts: { windowA: WindowSpec; windowB: WindowSpec; playerIds?: string[]; scope?: PassScope },
) {
  const ctxA = makeCtx(input, opts.windowA), ctxB = makeCtx(input, opts.windowB)
  const side = sideOfTeam(ctxA, teamId)
  const scope = opts.scope ?? 'counter_scope'
  const ids = opts.playerIds ?? []
  if (ids.length > MAX_COMPARE_PLAYERS) throw new DomainError('invalid_input', `At most ${MAX_COMPARE_PLAYERS} players per comparison`, { reason: 'too_many_players', max: MAX_COMPARE_PLAYERS })
  if (new Set(ids).size !== ids.length) throw new DomainError('invalid_input', 'playerIds contains a duplicate', { reason: 'duplicate_player' })
  const upstream = ids.map((id) => {
    const up = upstreamIdOf(ctxA, id)
    if (requireParticipant(ctxA, up).side !== side) throw new DomainError('invalid_input', 'Player is not on the requested team', { reason: 'player_not_on_team' })
    return up
  })

  const segsA = clipSegments(teamSegments(ctxA.rec), ctxA.window), segsB = clipSegments(teamSegments(ctxB.rec), ctxB.window)
  const ticksA = segmentTicks(segsA), ticksB = segmentTicks(segsB)
  const { out: teamRates, ra, rb } = teamCompareRows(ctxA, ctxB, side, ticksA, ticksB)
  const players = upstream.map((up) => playerCompare(ctxA, ctxB, up, scope))

  const ssA = scoreStateMinutes(ctxA.sampled, segsA, side), ssB = scoreStateMinutes(ctxB.sampled, segsB, side)
  const flips = (ctx: Ctx) => ctx.rec.substitutionBatches.filter((b) => inWindow({ period: b.period, tick: b.tick }, ctx.window))
  const flipsA = flips(ctxA), flipsB = flips(ctxB)
  const confounders = comparisonConfounders(ssA, ssB, ticksToMin(ticksA), ticksToMin(ticksB), flipsA.length + flipsB.length)
  if (compareBoundary(ctxA.window.from, ctxB.window.to) < 0 && compareBoundary(ctxB.window.from, ctxA.window.to) < 0) confounders.push('windows_overlap')
  const subs = (fl: typeof flipsA) => fl.map((b) => ({ side: b.side, at: `${b.period}:${b.tick}`, off: b.off.length, on: b.on.length, pairing: b.pairing }))

  const gate = recipientGate(ctxA, side, scope)
  const warnings: string[] = []
  if (!ctxB.windowExact) warnings.push('window_b_boundary_sampled_not_exact: counters are sampled, so counter-based rows for window B are partial_for_window')
  if (ticksA === 0 || ticksB === 0) warnings.push('window_without_verified_playing_time: rates are null')
  const coverage: Coverage = worst(envelopeCoverage(ctxA), envelopeCoverage(ctxB))
  const env = envelope(ctxA, 'compare', [ra, rb, ...players.flatMap((p) => [p.a.rows as MetricRow[], p.b.rows as MetricRow[]])], [], warnings)
  const { window: _w, ...envRest } = env
  return validated(CompareResultSchema, {
    ...envRest,
    coverage,
    windows: {
      a: { ...windowBlock(ctxA), teamMinutes: ticksToMin(ticksA), coverage: envelopeCoverage(ctxA) },
      b: { ...windowBlock(ctxB), teamMinutes: ticksToMin(ticksB), coverage: envelopeCoverage(ctxB) },
    },
    comparison: {
      team: teamRef(ctxA, side),
      pairing: 'b_minus_a',
      rateNote: 'Count metrics are compared as per-90 rates over verified team playing minutes in each window (registry rule per_90_rate); ratio and percentage metrics as plain values. delta = window B minus window A. A cell states coverage only when it differs from the coverage of its own window (windows.a / windows.b).',
      teamRates,
      players,
      substitutions: { a: subs(flipsA), b: subs(flipsB) },
      context: {
        scoreState: { a: ssA.value === null ? ssA : { value: { ...ssA.value, note: undefined } }, b: ssB.value === null ? ssB : { value: { ...ssB.value, note: undefined } } }, confounders,
        recipientGate: { status: gate.status, scope: gate.scope, reasons: gate.reasons },
        note: 'Observational comparison. Context is reported beside the rates and is not adjusted for; it does not establish what caused a difference.',
      },
    },
  })
}

// ------------------------------------------------------------------ status

/** Evidence-quality part of the recording status: observed intervals and the recipient-diagnostic gate per side. */
export function evidenceStatusQuery(input: AnalysisInput) {
  const ctx = makeCtx(input)
  const rec = ctx.rec
  return validated(StatusResultSchema, {
    observedIntervals: rec.periods.map((p) => ({ period: p.period, fromTick: p.firstTick, toTick: p.lastTick, frames: p.frames, firstDisplayTick: p.firstDisplayTick, lastDisplayTick: p.lastDisplayTick })),
    recipientDiagnostic: { home: gateSummary(ctx, 'home'), away: gateSummary(ctx, 'away') },
    unavailable: UNAVAILABLE_COMPONENTS.map((u) => ({ metric: u.id, reason: u.reason, note: u.note })),
  })
}
