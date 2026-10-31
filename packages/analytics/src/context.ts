import { DomainError, TICKS_PER_MINUTE, compareBoundary, counterDelta, inWindow, resolveCounterAt, resolveWindow } from '@fmmi/model'
import type {
  Boundary, BoundaryResolution, CounterDelta, DecodedRecording, MatchCompletion, NormalizedEvent, NormalizedRecording, NullReason,
  Participant, PlaySegment, ResultView, SampledCounters, Side, Window,
} from '@fmmi/model'
import { COUNTER_KEYS, getDefinition } from './registry.ts'

/**
 * Everything the analytics functions need, already normalised and in memory. Built by the query layer from the store;
 * tests build it from decoded synthetic archives. Nothing here knows about SQLite, the game API or MCP.
 */
export interface AnalysisInput {
  decoded: DecodedRecording
  ids: {
    matchId: string
    saveId: string
    recordingRevisionId: string
    teamIds: Record<Side, string>
    /** Upstream player id -> internal player id. */
    playerIds: ReadonlyMap<number, string>
  }
  completion: MatchCompletion
  result: ResultView
  /** Warnings the caller wants carried on the envelope (identity conflicts, manual score differences). */
  warnings?: string[]
}

export type Coverage = 'complete_for_window' | 'partial_for_window' | 'unavailable'
export type WindowSpec = { from?: Boundary; to?: Boundary }

export interface Ctx {
  input: AnalysisInput
  rec: NormalizedRecording
  events: NormalizedEvent[]
  sampled: SampledCounters
  window: Window
  resolution: { from: BoundaryResolution; to: BoundaryResolution }
  /** Both window boundaries coincide with sampled frames (or a verified zero baseline). */
  windowExact: boolean
  roster: Map<number, Participant>
}

export function makeCtx(input: AnalysisInput, spec: WindowSpec = {}): Ctx {
  const { recording, events, sampled } = input.decoded
  const window = resolveWindow(sampled.frames, spec)
  // Any always-present counter works for boundary resolution; it does not depend on the key.
  const probe = 'team.home.goals'
  const from = resolveCounterAt(sampled, probe, window.from).res
  const to = resolveCounterAt(sampled, probe, window.to).res
  return {
    input, rec: recording, events, sampled, window, resolution: { from, to }, windowExact: from.exact && to.exact,
    roster: new Map(recording.roster.map((p) => [p.upstreamPlayerId, p])),
  }
}

export const envelopeCoverage = (ctx: Ctx): Coverage => (ctx.windowExact ? 'complete_for_window' : 'partial_for_window')

export function teamKey(side: Side, metric: string): string {
  const c = COUNTER_KEYS[metric]
  if (!c || !c.team) throw new Error(`No team counter for ${metric}`)
  return `team.${side}.${c.key}`
}
export function playerKey(upstreamId: number, metric: string): string {
  const c = COUNTER_KEYS[metric]
  if (!c || !c.player) throw new Error(`No player counter for ${metric}`)
  return `player.${upstreamId}.${c.key}`
}

export const teamDelta = (ctx: Ctx, side: Side, metric: string, w: Window = ctx.window): CounterDelta => counterDelta(ctx.sampled, teamKey(side, metric), w)
export const playerDelta = (ctx: Ctx, upstreamId: number, metric: string, w: Window = ctx.window): CounterDelta => counterDelta(ctx.sampled, playerKey(upstreamId, metric), w)

export interface MetricRow {
  metric: string
  value: number | null
  /** Only when it differs from the envelope coverage. */
  coverage?: Coverage
  nullReason?: NullReason
  counts?: { numerator: number; denominator: number }
  teamId?: string
  playerId?: string
  warnings?: string[]
}

export interface RowOpts {
  coverage?: Coverage
  nullReason?: NullReason
  counts?: { numerator: number; denominator: number }
  teamId?: string
  playerId?: string
  warnings?: string[]
}

/** Rows state only what differs from the envelope: unit, derivation and confidence come from the registry entry. */
export function makeRow(ctx: Ctx, metric: string, value: number | null, o: RowOpts = {}): MetricRow {
  getDefinition(metric) // fails loudly if a row has no registry definition
  const r: MetricRow = { metric, value }
  const cov: Coverage = value === null ? 'unavailable' : (o.coverage ?? envelopeCoverage(ctx))
  if (cov !== envelopeCoverage(ctx)) r.coverage = cov
  if (value === null) r.nullReason = o.nullReason ?? 'not_recorded'
  if (o.counts) r.counts = o.counts
  if (o.teamId) r.teamId = o.teamId
  if (o.playerId) r.playerId = o.playerId
  if (o.warnings?.length) r.warnings = o.warnings
  return r
}

export function counterRow(ctx: Ctx, metric: string, d: CounterDelta, o: Pick<RowOpts, 'teamId' | 'playerId' | 'warnings'> = {}): MetricRow {
  return makeRow(ctx, metric, d.value, { ...o, coverage: d.coverage, nullReason: d.nullReason })
}

// ------------------------------------------------------------------ time

/** Team playing time: the recorded span of each period. */
export function teamSegments(rec: NormalizedRecording): PlaySegment[] {
  return rec.periods.map((p) => ({ period: p.period, fromTick: p.firstTick, toTick: p.lastTick, fromReason: 'period_start' as const, toReason: 'period_end' as const }))
}

const cmp = (a: { period: number; tick: number }, b: { period: number; tick: number }) => a.period - b.period || a.tick - b.tick

/** Intersection of play segments with a half-open window; halftime stays excluded because segments are per period. */
export function clipSegments(segments: readonly PlaySegment[], w: Window): PlaySegment[] {
  const out: PlaySegment[] = []
  for (const s of segments) {
    const start = { period: s.period, tick: s.fromTick }, end = { period: s.period, tick: s.toTick }
    const from = { period: w.from.period, tick: w.from.tick }, to = { period: w.to.period, tick: w.to.tick }
    const lo = cmp(start, from) >= 0 ? start : from
    const hi = cmp(end, to) <= 0 ? end : to
    if (lo.period === s.period && hi.period === s.period && lo.tick < hi.tick) out.push({ ...s, fromTick: lo.tick, toTick: hi.tick })
  }
  return out
}
export const segmentTicks = (segments: readonly PlaySegment[]): number => segments.reduce((a, s) => a + (s.toTick - s.fromTick), 0)
export const ticksToMin = (ticks: number): number => ticks / TICKS_PER_MINUTE

export function inSegments(e: { period: number | null; tick: number }, segments: readonly PlaySegment[]): boolean {
  if (e.period === null) return false
  return segments.some((s) => s.period === e.period && e.tick >= s.fromTick && e.tick < s.toTick)
}

export function eventInWindow(ctx: Ctx, e: NormalizedEvent): boolean { return inWindow(e, ctx.window) }

/** Display minute of the first frame at or after the boundary (clamped to the recording). */
export function displayMinuteAt(ctx: Ctx, b: Boundary): number {
  const fi = ctx.sampled.frames
  const i = Math.min(fi.length - 1, fi.indexBefore(b) + 1)
  return Math.round((fi.displayTicks[Math.max(0, i)]! / TICKS_PER_MINUTE) * 100) / 100
}

export function requireParticipant(ctx: Ctx, upstreamId: number): Participant {
  const p = ctx.roster.get(upstreamId)
  if (!p) throw new DomainError('not_found', 'Player not found in this match', { reason: 'not_in_match' })
  return p
}

export function internalPlayerId(ctx: Ctx, upstreamId: number): string {
  return ctx.input.ids.playerIds.get(upstreamId) ?? `unmapped_${upstreamId}`
}

export function sideOfTeam(ctx: Ctx, teamId: string): Side {
  const t = ctx.input.ids.teamIds
  if (t.home === teamId) return 'home'
  if (t.away === teamId) return 'away'
  throw new DomainError('not_found', 'Team does not belong to this match', { reason: 'not_in_match' })
}

export function upstreamIdOf(ctx: Ctx, playerId: string): number {
  for (const [up, id] of ctx.input.ids.playerIds) if (id === playerId) return up
  throw new DomainError('not_found', 'Player does not belong to this match', { reason: 'not_in_match' })
}

export { compareBoundary }
