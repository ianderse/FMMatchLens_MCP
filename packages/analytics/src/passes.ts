import type { NormalizedEvent, NullReason, Side } from '@fmmi/model'
import { GATES, RECEIVER_SEMANTICS } from './registry.ts'
import { eventInWindow, internalPlayerId, teamDelta } from './context.ts'
import type { Ctx } from './context.ts'

export type PassScope = 'counter_scope' | 'open_play' | 'all_passes'

/** Flag bits (docs/data-coverage.md section 8). 0x8 is verified by exact reconciliation; 0x10/0x20/0x40 are not. */
export const FLAG_THROW_IN = 0x8
export const FLAG_FREE_KICK_ATTACK = 0x10
export const FLAG_FREE_KICK_DEFENCE = 0x20
export const FLAG_CORNER = 0x40

export interface ScopeInfo {
  scope: PassScope
  includesThrowIns: boolean
  includesFreeKickPasses: boolean | 'unknown'
  includesCorners: boolean | 'unknown'
  crossesIncluded: false
  counterEquivalent: boolean
  semantics: 'verified' | 'unverified_semantics'
  warnings: string[]
}

export function scopeInfo(scope: PassScope): ScopeInfo {
  switch (scope) {
    case 'counter_scope':
      return { scope, includesThrowIns: false, includesFreeKickPasses: true, includesCorners: true, crossesIncluded: false, counterEquivalent: true, semantics: 'verified', warnings: [] }
    case 'all_passes':
      return { scope, includesThrowIns: true, includesFreeKickPasses: true, includesCorners: true, crossesIncluded: false, counterEquivalent: false, semantics: 'verified',
        warnings: ['all_passes_includes_throw_ins: no equivalent cumulative counter exists, so event totals cannot be reconciled'] }
    case 'open_play':
      return { scope, includesThrowIns: false, includesFreeKickPasses: 'unknown', includesCorners: 'unknown', crossesIncluded: false, counterEquivalent: false, semantics: 'unverified_semantics',
        warnings: ['unverified_semantics: open_play depends on flags 0x10/0x20 whose meaning is unverified; never compare it with counter totals'] }
  }
}

const isPassKind = (e: NormalizedEvent) => e.kind === 'pass_completed' || e.kind === 'pass_incomplete' || e.kind === 'pass_unverified'

export function inScope(e: NormalizedEvent, scope: PassScope): boolean {
  if (!isPassKind(e)) return false
  switch (scope) {
    case 'all_passes': return true
    case 'counter_scope': return (e.flags & FLAG_THROW_IN) === 0
    case 'open_play': return (e.flags & (FLAG_THROW_IN | FLAG_FREE_KICK_ATTACK | FLAG_FREE_KICK_DEFENCE | FLAG_CORNER)) === 0
  }
}

/** Pass events of a side, in scope, with start tick in [from,to). Attempts include completions. */
export function scopedPasses(ctx: Ctx, side: Side, scope: PassScope): NormalizedEvent[] {
  return ctx.events.filter((e) => e.side === side && inScope(e, scope) && eventInWindow(ctx, e))
}
export const completed = (es: readonly NormalizedEvent[]) => es.filter((e) => e.kind === 'pass_completed')

/** A receiver is verified when it is in the roster, on the passer's team and not the passer (all structural checks). */
export function validReceiver(ctx: Ctx, e: NormalizedEvent): number | null {
  if (e.receiverPlayerId === null) return null
  const r = ctx.roster.get(e.receiverPlayerId)
  const p = ctx.roster.get(e.playerId)
  if (!r || !p || r.side !== e.side || p.side !== e.side || r.upstreamPlayerId === e.playerId) return null
  return e.receiverPlayerId
}

// ------------------------------------------------------------------ geometry (derived)

export interface Point { lateralUnit: number; forwardUnit: number }
export interface PassGeometry { start: Point | null; end: Point | null; forwardDistanceM: number | null }

/** Normalises a source-metre point to the event team's attack direction (flag 0x100), unclamped. */
function normalisePoint(ctx: Ctx, e: NormalizedEvent, latM: number, lonM: number): Point | null {
  const pitch = ctx.rec.pitch
  if (!pitch) return null
  const positive = e.normalised.attackDirection === 'toward_positive_longitudinal'
  const lat = positive ? latM : -latM, fwd = positive ? lonM : -lonM
  return { lateralUnit: (lat + pitch.halfWidthM) / (2 * pitch.halfWidthM), forwardUnit: (fwd + pitch.halfLengthM) / (2 * pitch.halfLengthM) }
}

export function passGeometry(ctx: Ctx, e: NormalizedEvent): PassGeometry {
  const pitch = ctx.rec.pitch
  const last = e.trajectory.length > 0 ? e.trajectory[e.trajectory.length - 1]! : null
  const start = normalisePoint(ctx, e, e.source.lateralM, e.source.longitudinalM)
  const end = last ? normalisePoint(ctx, e, last.lateralM, last.longitudinalM) : null
  const forwardDistanceM = pitch && start && end ? (end.forwardUnit - start.forwardUnit) * 2 * pitch.halfLengthM : null
  return { start, end, forwardDistanceM }
}

/** Distinct from the upstream finalThirdPasses counter (spec 7.7). */
export function isFinalThirdEntry(g: PassGeometry): boolean | null {
  if (!g.start || !g.end) return null
  return g.start.forwardUnit < GATES.finalThird && g.end.forwardUnit >= GATES.finalThird
}

export function finalThirdEntries(ctx: Ctx, side: Side): { value: number | null; nullReason?: NullReason; measured: number; unmeasurable: number } {
  if (!ctx.rec.pitch) return { value: null, nullReason: 'not_recorded', measured: 0, unmeasurable: 0 }
  let n = 0, measured = 0, unmeasurable = 0
  for (const e of completed(scopedPasses(ctx, side, 'counter_scope'))) {
    const r = isFinalThirdEntry(passGeometry(ctx, e))
    if (r === null) { unmeasurable++; continue }
    measured++
    if (r) n++
  }
  return { value: n, measured, unmeasurable }
}

// ------------------------------------------------------------------ reconciliation

export interface Reconciliation {
  status: 'exact' | 'within_boundary_tolerance' | 'mismatch' | 'unavailable'
  scope: PassScope
  nullReason?: NullReason
  reason?: string
  events: { attempts: number; completed: number }
  counters: { attempts: number | null; completed: number | null }
  residual: { attempts: number | null; completed: number | null }
  tolerance: { attempts: number; completed: number }
}

/**
 * Pass events that may legitimately be counted differently by the event placement (start tick) and the sampled
 * counter (completion tick, up to 4 ticks later, read at the last frame before the boundary).
 */
function boundaryUncertain(ctx: Ctx, side: Side, scope: PassScope, onlyCompleted: boolean): number {
  const lag = GATES.counterLagTicks
  let n = 0
  for (const b of [ctx.window.from, ctx.window.to]) {
    const r = b === ctx.window.from ? ctx.resolution.from : ctx.resolution.to
    const s = r.sampledFrame
    for (const e of ctx.events) {
      if (e.side !== side || !inScope(e, scope) || (onlyCompleted && e.kind !== 'pass_completed') || e.period === null) continue
      const startsBefore = e.period < b.period || (e.period === b.period && e.tick < b.tick)
      if (!startsBefore) continue
      const completesAfterSample = s === null ? false : e.period > s.period || (e.period === s.period && e.completionTick > s.tick - lag)
      if (completesAfterSample) n++
    }
  }
  return n
}

export function reconcilePasses(ctx: Ctx, side: Side, scope: PassScope): Reconciliation {
  const all = scopedPasses(ctx, side, scope)
  const ev = { attempts: all.length, completed: completed(all).length }
  const empty = { attempts: null, completed: null }
  if (!scopeInfo(scope).counterEquivalent) {
    return {
      status: 'unavailable', scope, nullReason: scope === 'open_play' ? 'unverified_semantics' : 'not_applicable',
      reason: scope === 'open_play' ? 'open_play_has_no_verified_equivalent_counter' : 'all_passes_has_no_equivalent_counter',
      events: ev, counters: empty, residual: empty, tolerance: { attempts: 0, completed: 0 },
    }
  }
  const a = teamDelta(ctx, side, 'passes'), c = teamDelta(ctx, side, 'passes_completed')
  if (a.value === null || c.value === null) {
    return { status: 'unavailable', scope, nullReason: a.nullReason ?? c.nullReason, reason: 'counter_unresolved_for_window', events: ev, counters: empty, residual: empty, tolerance: { attempts: 0, completed: 0 } }
  }
  const residual = { attempts: ev.attempts - a.value, completed: ev.completed - c.value }
  const tolerance = { attempts: boundaryUncertain(ctx, side, scope, false), completed: boundaryUncertain(ctx, side, scope, true) }
  const exact = residual.attempts === 0 && residual.completed === 0
  const within = Math.abs(residual.attempts) <= tolerance.attempts + GATES.integerCounterTolerance && Math.abs(residual.completed) <= tolerance.completed + GATES.integerCounterTolerance
  return { status: exact ? 'exact' : within ? 'within_boundary_tolerance' : 'mismatch', scope, events: ev, counters: { attempts: a.value, completed: c.value }, residual, tolerance }
}

// ------------------------------------------------------------------ section 7.2 recipient gate

export interface RecipientGate {
  status: 'pass' | 'fail'
  side: Side
  scope: PassScope
  semanticsBasis: typeof RECEIVER_SEMANTICS.semanticsBasis
  receiverSemantics: typeof RECEIVER_SEMANTICS.status
  verifiedAgainstUi: boolean
  eligibleCompletedPasses: number
  withVerifiedReceiver: number
  coverageRatio: number | null
  coverageMin: number
  reconciliation: Reconciliation
  reasons: string[]
  provisional: true
  note: string
}

/**
 * Computed per side and window from the data; nothing is hard-coded to a pass or a recording. The gate fails when the
 * coverage is under 95%, when the event totals do not reconcile to the equivalent counters, or when either is unknown.
 */
export function recipientGate(ctx: Ctx, side: Side, scope: PassScope): RecipientGate {
  const comp = completed(scopedPasses(ctx, side, scope))
  const verified = comp.filter((e) => validReceiver(ctx, e) !== null).length
  const recon = reconcilePasses(ctx, side, scope)
  const reasons: string[] = []
  if (RECEIVER_SEMANTICS.status !== 'verified') reasons.push('receiver_semantics_unverified')
  if (comp.length === 0) reasons.push('no_eligible_completed_passes')
  else if (verified * 100 < Math.round(GATES.recipientCoverageMin * 100) * comp.length) reasons.push('recipient_coverage_below_threshold')
  if (recon.status === 'unavailable') reasons.push(`reconciliation_unavailable:${recon.reason ?? 'unknown'}`)
  else if (recon.status === 'mismatch') reasons.push('reconciliation_mismatch')
  return {
    status: reasons.length === 0 ? 'pass' : 'fail', side, scope,
    semanticsBasis: RECEIVER_SEMANTICS.semanticsBasis, receiverSemantics: RECEIVER_SEMANTICS.status, verifiedAgainstUi: RECEIVER_SEMANTICS.verifiedAgainstUi,
    eligibleCompletedPasses: comp.length, withVerifiedReceiver: verified, coverageRatio: comp.length > 0 ? verified / comp.length : null,
    coverageMin: GATES.recipientCoverageMin, reconciliation: recon, reasons, provisional: true,
    note: 'Receiver semantics are corroborated internally only (not against the FM27 UI) and the evidence comes from a single audited recording.',
  }
}

// ------------------------------------------------------------------ network

export interface Edge {
  from: string
  to: string
  completions: number
  forwardDistanceM: { sum: number; measured: number } | null
}

export interface Located { n: number; meanLateralUnit: number; meanForwardUnit: number }
export interface NetworkNode {
  playerId: string
  name: string
  position: string | null
  minutesInWindow: number
  passesCompletedOut: number
  passesReceived: number
  /** Pass-origin samples (all in-scope passes made, attempted or completed). */
  origin: Located | null
  /** Derived from trajectory ends of received completed passes; not an independent measurement. */
  reception: (Located & { derivation: 'derived_from_trajectory_end'; independent: false }) | null
  /** Null when the player has no location sample of either kind. The node and its links remain. */
  location: null | 'origin_and_or_reception'
}

function meanOf(points: Point[]): Located | null {
  if (points.length === 0) return null
  return {
    n: points.length,
    meanLateralUnit: points.reduce((a, p) => a + p.lateralUnit, 0) / points.length,
    meanForwardUnit: points.reduce((a, p) => a + p.forwardUnit, 0) / points.length,
  }
}

export function receptionPoints(ctx: Ctx, es: readonly NormalizedEvent[]): Point[] {
  return es.map((e) => passGeometry(ctx, e).end).filter((p): p is Point => p !== null)
}

export function buildNetwork(ctx: Ctx, side: Side, scope: PassScope, opts: { minPasses?: number; limit?: number } = {}, minutesOf: (upstreamId: number) => number) {
  const all = scopedPasses(ctx, side, scope)
  const comp = completed(all)
  const edgeMap = new Map<string, { from: number; to: number; n: number; fd: number; fdN: number }>()
  const received = new Map<number, NormalizedEvent[]>()
  let withoutReceiver = 0
  for (const e of comp) {
    const r = validReceiver(ctx, e)
    if (r === null) { withoutReceiver++; continue }
    const k = `${e.playerId}>${r}`
    let x = edgeMap.get(k)
    if (!x) { x = { from: e.playerId, to: r, n: 0, fd: 0, fdN: 0 }; edgeMap.set(k, x) }
    x.n++
    const g = passGeometry(ctx, e)
    if (g.forwardDistanceM !== null) { x.fd += g.forwardDistanceM; x.fdN++ }
    const list = received.get(r) ?? []
    list.push(e); received.set(r, list)
  }
  const originsBy = new Map<number, Point[]>()
  for (const e of all) {
    const g = passGeometry(ctx, e)
    if (!g.start) continue
    const l = originsBy.get(e.playerId) ?? []
    l.push(g.start); originsBy.set(e.playerId, l)
  }
  const outBy = new Map<number, number>()
  for (const e of comp) outBy.set(e.playerId, (outBy.get(e.playerId) ?? 0) + 1)

  const involved = new Set<number>()
  for (const x of edgeMap.values()) { involved.add(x.from); involved.add(x.to) }
  const nodes: NetworkNode[] = ctx.rec.roster
    .filter((p) => p.side === side && (involved.has(p.upstreamPlayerId) || p.participation.status === 'played'))
    .map((p) => {
      const origin = meanOf(originsBy.get(p.upstreamPlayerId) ?? [])
      const rp = meanOf(receptionPoints(ctx, received.get(p.upstreamPlayerId) ?? []))
      return {
        playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name, position: p.position, minutesInWindow: minutesOf(p.upstreamPlayerId),
        passesCompletedOut: outBy.get(p.upstreamPlayerId) ?? 0, passesReceived: (received.get(p.upstreamPlayerId) ?? []).length,
        origin, reception: rp ? { ...rp, derivation: 'derived_from_trajectory_end' as const, independent: false as const } : null,
        location: origin || rp ? ('origin_and_or_reception' as const) : null,
      }
    })

  const minPasses = opts.minPasses ?? 1
  const allEdges: Edge[] = [...edgeMap.values()]
    .sort((a, b) => b.n - a.n || a.from - b.from || a.to - b.to)
    .map((x) => ({ from: internalPlayerId(ctx, x.from), to: internalPlayerId(ctx, x.to), completions: x.n, forwardDistanceM: x.fdN > 0 ? { sum: x.fd, measured: x.fdN } : null }))
  const kept = allEdges.filter((x) => x.completions >= minPasses)
  const limit = opts.limit ?? 10
  const edges = kept.slice(0, limit)
  const edgeCompletions = allEdges.reduce((a, x) => a + x.completions, 0)
  return {
    scope: scopeInfo(scope),
    totals: {
      attempts: all.length, completed: comp.length, edgeCompletions, completedWithoutVerifiedReceiver: withoutReceiver,
      edgesTotal: allEdges.length, edgesMeetingMinPasses: kept.length, edgesReturned: edges.length, truncated: kept.length > edges.length, minPasses, limit,
    },
    edges,
    nodes,
    nodesWithoutLocation: nodes.filter((n) => n.location === null).length,
  }
}
