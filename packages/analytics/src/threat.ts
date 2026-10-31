import type { NormalizedEvent, Participant, Side } from '@fmmi/model'
import { DANGER_AREA, GATES, LANES, UNAVAILABLE_THREAT, getDefinition } from './registry.ts'
import {
  clipSegments, displayMinuteAt, eventInWindow, inSegments, internalPlayerId, makeCtx, segmentTicks, sideOfTeam, teamDelta, ticksToMin,
} from './context.ts'
import type { Ctx, WindowSpec } from './context.ts'
import { completed, isFinalThirdEntry, passGeometry, scopedPasses } from './passes.ts'
import type { Point } from './passes.ts'
import { envelope, teamRef } from './queries.ts'
import { ThreatResultSchema, validated } from './schemas.ts'

export type Lane = (typeof LANES.ids)[number]
const LANE_KEYS = LANES.ids

/** Lane of a lateralUnit (attack-rotated, from the attacking team's perspective). Lower bound inclusive, unclamped. */
export function laneOf(lateralUnit: number | null | undefined): Lane | null {
  if (lateralUnit === null || lateralUnit === undefined || !Number.isFinite(lateralUnit)) return null
  return lateralUnit < LANES.leftBelow ? 'left' : lateralUnit < LANES.rightFrom ? 'centre' : 'right'
}
/** A point recorded in the defending team's own attack frame, seen from the opposition attackers (lateralUnit -> 1 - lateralUnit). */
export const mirroredLane = (ownLateralUnit: number | null | undefined): Lane | null =>
  ownLateralUnit === null || ownLateralUnit === undefined || !Number.isFinite(ownLateralUnit) ? null : laneOf(1 - ownLateralUnit)
/** The defending team flank that an opposition attack lane runs down: the attackers' left is the defenders' right. */
export const defendingFlank = (lane: Lane): Lane => (lane === 'left' ? 'right' : lane === 'right' ? 'left' : 'centre')

/** Standard penalty-area rectangle in attack-rotated metres. */
export function inDangerArea(halfWidthM: number, halfLengthM: number, p: Point): boolean {
  const forwardM = (p.forwardUnit - 0.5) * 2 * halfLengthM
  const lateralM = (p.lateralUnit - 0.5) * 2 * halfWidthM
  return forwardM >= halfLengthM - DANGER_AREA.depthFromGoalLineM && Math.abs(lateralM) <= DANGER_AREA.halfWidthM
}

/** Bound on the player rows returned, so the default output stays small whatever the squad. */
export const MAX_PLAYERS = 14
const SHOT_KINDS = new Set(['goal', 'shot_on_target', 'shot_off_target', 'shot_blocked', 'shot_woodwork'])
const CROSS_KINDS = new Set(['cross_completed', 'cross_incomplete'])
const DEFENSIVE_KINDS = ['tackle_won', 'tackle_lost', 'interception', 'aerial_won', 'aerial_lost'] as const
type DefensiveKind = (typeof DEFENSIVE_KINDS)[number]

type LaneCounts = Record<Lane, number>
const zero = (): LaneCounts => ({ left: 0, centre: 0, right: 0 })

interface Tally { byLane: LaneCounts; withoutLocation: number; events: number }
const tally = (): Tally => ({ byLane: zero(), withoutLocation: 0, events: 0 })
function add(t: Tally, lane: Lane | null) {
  t.events++
  if (lane === null) t.withoutLocation++
  else t.byLane[lane]++
}
const sum = (c: LaneCounts) => c.left + c.centre + c.right

/**
 * Per-shot xG from counter steps (registry `opposition_xg_by_lane`). A shot event is matched to the same-numbered increment
 * of its shooter's cumulative shots counter; only an increment of exactly one shot with a positive step in the shooter's
 * cumulative xG at the same frame is attributed. Everything else is left unattributed (null), never split or guessed.
 */
export function perShotXg(ctx: Ctx, shots: readonly NormalizedEvent[]): Map<number, number | null> {
  const out = new Map<number, number | null>()
  const byShooter = new Map<number, NormalizedEvent[]>()
  for (const e of shots) { const l = byShooter.get(e.playerId) ?? []; l.push(e); byShooter.set(e.playerId, l) }
  const sc = ctx.sampled
  for (const [pid, list] of byShooter) {
    list.sort((a, b) => a.tick - b.tick || a.eventId - b.eventId)
    for (const e of list) out.set(e.eventId, null)
    const s = sc.series.get(`player.${pid}.shots`), x = sc.series.get(`player.${pid}.xg`)
    if (!s || !x || sc.initialBaseline !== 'zero_verified') continue
    const total = s.val[s.val.length - 1] ?? 0
    if (total !== list.length) continue
    let prev = 0, k = 0
    for (let j = 0; j < s.idx.length; j++) {
      const n = s.val[j]! - prev
      prev = s.val[j]!
      if (n === 1) {
        const i = s.idx[j]!
        const now = sc.valueAtFrame(`player.${pid}.xg`, i) ?? 0
        const before = i === 0 ? 0 : sc.valueAtFrame(`player.${pid}.xg`, i - 1) ?? 0
        if (now - before > 0) out.set(list[k]!.eventId, now - before)
      }
      k += n
    }
  }
  return out
}

interface Involvement { kinds: Record<DefensiveKind, number>; lanes: Record<Lane | 'unknown', number>; total: number }
const emptyInvolvement = (): Involvement => ({
  kinds: { tackle_won: 0, tackle_lost: 0, interception: 0, aerial_won: 0, aerial_lost: 0 }, lanes: { left: 0, centre: 0, right: 0, unknown: 0 }, total: 0,
})

function rolesAt(ctx: Ctx, p: Participant) {
  const to = ctx.window.to.tick, from = ctx.window.from.tick
  const entries = p.roleTimeline.filter((r) => r.capturedTick < to)
  const cur = entries[entries.length - 1]
  const inWin = entries.filter((r) => r.capturedTick >= from).length
  return {
    inPossession: cur?.inPossession ?? null, outOfPossession: cur?.outOfPossession ?? null, asOfCapturedTick: cur?.capturedTick ?? null,
    revisionsInWindow: inWin,
  }
}

const leading = (c: LaneCounts): Lane | 'tie' | null => {
  const max = Math.max(c.left, c.centre, c.right)
  if (max === 0) return null
  const top = LANE_KEYS.filter((l) => c[l] === max)
  return top.length === 1 ? top[0]! : 'tie'
}

export function threatQuery(input: import('./context.ts').AnalysisInput, teamId: string, opts: { window?: WindowSpec } = {}) {
  const ctx = makeCtx(input, opts.window)
  const side = sideOfTeam(ctx, teamId)
  const opp: Side = side === 'home' ? 'away' : 'home'
  const pitch = ctx.rec.pitch
  const laneOfPoint = (p: Point | null): Lane | null => (pitch && p ? laneOf(p.lateralUnit) : null)
  const originLane = (e: NormalizedEvent): Lane | null => (pitch ? laneOf(e.normalised.lateralUnit) : null)

  // ------------------------------------------------------------ opposition chance creation
  const oppEvents = ctx.events.filter((e) => e.side === opp && eventInWindow(ctx, e))
  const shotEvents = oppEvents.filter((e) => SHOT_KINDS.has(e.kind))
  const shots = tally()
  for (const e of shotEvents) add(shots, originLane(e))

  const xgMap = perShotXg(ctx, ctx.events.filter((e) => e.side === opp && SHOT_KINDS.has(e.kind)))
  const xgByLane = zero() as LaneCounts
  const xgShots = zero(), xgUnattributed = zero()
  let attributedTotal = 0, attributedShots = 0, unattributedShots = 0
  for (const e of shotEvents) {
    const lane = originLane(e)
    const v = xgMap.get(e.eventId) ?? null
    if (lane === null) { if (v === null) unattributedShots++; continue }
    if (v === null) { xgUnattributed[lane]++; unattributedShots++ } else { xgByLane[lane] += v; xgShots[lane]++; attributedTotal += v; attributedShots++ }
  }

  const crosses = tally(), crossesCompleted = tally()
  for (const e of oppEvents.filter((x) => CROSS_KINDS.has(x.kind))) {
    const lane = originLane(e)
    add(crosses, lane)
    if (e.kind === 'cross_completed') add(crossesCompleted, lane)
  }

  const passes = scopedPasses(ctx, opp, 'counter_scope')
  const passesCompleted = tally(), entries = tally(), danger = tally()
  let entriesUnmeasurable = 0
  const geometryOk = pitch !== null
  for (const e of completed(passes)) {
    const g = passGeometry(ctx, e)
    add(passesCompleted, laneOfPoint(g.start))
    const entry = isFinalThirdEntry(g)
    if (entry === null) entriesUnmeasurable++
    else if (entry) { entries.events++; const l = laneOfPoint(g.end); if (l === null) entries.withoutLocation++; else entries.byLane[l]++ }
    if (pitch && g.start && g.end && !inDangerArea(pitch.halfWidthM, pitch.halfLengthM, g.start) && inDangerArea(pitch.halfWidthM, pitch.halfLengthM, g.end)) {
      danger.events++; const l = laneOfPoint(g.end); if (l === null) danger.withoutLocation++; else danger.byLane[l]++
    }
  }
  for (const e of oppEvents.filter((x) => x.kind === 'cross_completed')) {
    const g = passGeometry(ctx, e)
    if (pitch && g.start && g.end && !inDangerArea(pitch.halfWidthM, pitch.halfLengthM, g.start) && inDangerArea(pitch.halfWidthM, pitch.halfLengthM, g.end)) {
      danger.events++; const l = laneOfPoint(g.end); if (l === null) danger.withoutLocation++; else danger.byLane[l]++
    }
  }

  const ctr = (m: string) => { const d = teamDelta(ctx, opp, m); return { value: d.value, coverage: d.coverage, nullReason: d.nullReason ?? null } }
  const counters = { shots: ctr('shots'), crosses: ctr('crosses'), crossesCompleted: ctr('crosses_completed'), passesCompleted: ctr('passes_completed'), goals: ctr('goals'), xg: ctr('xg') }
  const recon = (t: Tally, counter: { value: number | null; coverage: string; nullReason: string | null }) => ({
    byLane: sum(t.byLane), withoutLocation: t.withoutLocation, events: t.events, counter,
    reconciles: t.events === sum(t.byLane) + t.withoutLocation && (counter.value === null ? null : counter.value === t.events),
  })

  // ------------------------------------------------------------ goals (context only)
  const goals = oppEvents.filter((e) => e.kind === 'goal').map((e) => {
    const involved: Array<{ playerId: string; name: string; side: Side; roleInEvent: 'event_actor' | 'event_receiver' }> = []
    const a = ctx.roster.get(e.playerId)
    if (a) involved.push({ playerId: internalPlayerId(ctx, a.upstreamPlayerId), name: a.name, side: a.side, roleInEvent: 'event_actor' })
    const r = e.receiverPlayerId !== null ? ctx.roster.get(e.receiverPlayerId) : undefined
    if (r) involved.push({ playerId: internalPlayerId(ctx, r.upstreamPlayerId), name: r.name, side: r.side, roleInEvent: 'event_receiver' })
    return {
      eventId: e.eventId, period: e.period, tick: e.tick, displayMinute: e.period === null ? null : displayMinuteAt(ctx, { period: e.period, tick: e.tick, sequence: 0 }),
      lane: originLane(e), defendingTeamFlank: originLane(e) === null ? null : defendingFlank(originLane(e)!),
      xg: xgMap.get(e.eventId) ?? null, involvedInEvent: involved,
    }
  })

  // ------------------------------------------------------------ defensive involvement of the selected team
  const verifiedKinds = new Set<string>(DEFENSIVE_KINDS)
  const own = ctx.events.filter((e) => e.side === side && verifiedKinds.has(e.kind) && eventInWindow(ctx, e))
  const team: Involvement = emptyInvolvement()
  const perPlayer = new Map<number, Involvement>()
  let outsideParticipation = 0, withoutActor = 0
  for (const e of own) {
    const p = ctx.roster.get(e.playerId)
    if (!p || p.side !== side) { withoutActor++; continue }
    if (!inSegments(e, clipSegments(p.participation.segments, ctx.window))) { outsideParticipation++; continue }
    const lane = pitch ? mirroredLane(e.normalised.lateralUnit) : null
    for (const t of [team, perPlayer.get(p.upstreamPlayerId) ?? (perPlayer.set(p.upstreamPlayerId, emptyInvolvement()), perPlayer.get(p.upstreamPlayerId)!)]) {
      t.kinds[e.kind as DefensiveKind]++
      t.lanes[lane ?? 'unknown']++
      t.total++
    }
  }
  const roster = ctx.rec.roster.filter((p) => p.side === side)
  const players = roster
    .filter((p) => (perPlayer.get(p.upstreamPlayerId)?.total ?? 0) > 0)
    .map((p) => {
      const segs = clipSegments(p.participation.segments, ctx.window)
      const inv = perPlayer.get(p.upstreamPlayerId)!
      return {
        playerId: internalPlayerId(ctx, p.upstreamPlayerId), name: p.name, position: p.position, minutesInWindow: ticksToMin(segmentTicks(segs)),
        onPitchAtEndOfRecording: p.participation.onPitchAtEndOfRecording, roles: rolesAt(ctx, p), involvement: inv,
      }
    })
    .sort((a, b) => b.involvement.total - a.involvement.total || a.playerId.localeCompare(b.playerId))
  const playersShown = players.slice(0, MAX_PLAYERS)

  const laneRows = LANE_KEYS.map((lane) => ({
    lane, defendingTeamFlank: defendingFlank(lane),
    shots: shots.byLane[lane],
    xg: { value: xgByLane[lane], attributedShots: xgShots[lane], unattributedShots: xgUnattributed[lane] },
    crosses: crosses.byLane[lane], crossesCompleted: crossesCompleted.byLane[lane],
    passesCompleted: passesCompleted.byLane[lane], finalThirdEntries: entries.byLane[lane], dangerAreaEntries: danger.byLane[lane],
    defensiveEventsMirrored: team.lanes[lane],
  }))

  const teamXg = counters.xg.value
  const xgExact = teamXg !== null && counters.xg.coverage === 'complete_for_window'
  const leadingLane = {
    shots: leading(shots.byLane), completedPasses: leading(passesCompleted.byLane), crosses: leading(crosses.byLane),
    finalThirdEntries: leading(entries.byLane), dangerAreaEntries: leading(danger.byLane),
  }
  const statements: string[] = []
  if (!geometryOk) statements.push('Pitch dimensions are not recorded, so no lane can be assigned; counts are reported without lanes.')
  else {
    const fmt = (c: LaneCounts) => `left ${c.left}, centre ${c.centre}, right ${c.right}`
    statements.push(`Opposition shots by attack lane (attacking team perspective): ${fmt(shots.byLane)}; ${shots.withoutLocation} without a recorded location.`)
    statements.push(`Opposition crosses by lane: ${fmt(crosses.byLane)} (completed: ${fmt(crossesCompleted.byLane)}).`)
    statements.push(`Opposition completed passes by lane of origin: ${fmt(passesCompleted.byLane)}; final-third entries by lane of entry: ${fmt(entries.byLane)}; danger-area entries: ${fmt(danger.byLane)}.`)
    statements.push('The opposition left lane runs down the selected team right flank and the reverse. Counts describe where recorded events happened and do not rank lanes or score a threat.')
  }

  const warnings: string[] = []
  if (!geometryOk) warnings.push('pitch_dimensions_not_recorded: lanes unavailable')
  if (outsideParticipation > 0) warnings.push(`defensive_events_outside_participation:${outsideParticipation}: not attributed to a player`)
  if (unattributedShots > 0) warnings.push(`xg_not_attributed_for_${unattributedShots}_shots: per-shot xG needs one shot between two sampled frames`)
  if (entriesUnmeasurable > 0) warnings.push(`${entriesUnmeasurable}_completed_passes_lack_an_endpoint`)

  const ids = [
    'attack_lane', 'opposition_shots_by_lane', 'opposition_xg_by_lane', 'opposition_crosses_by_lane', 'opposition_passes_completed_by_lane',
    'opposition_final_third_entries_by_lane', 'danger_area_entries_by_lane', 'defender_involvement_by_lane', 'conceded_goal_context',
    ...UNAVAILABLE_THREAT.map((u) => u.id),
  ]
  for (const id of ids) getDefinition(id)
  return validated(ThreatResultSchema, {
    ...envelope(ctx, 'threat', [], ids, warnings),
    threat: {
      team: teamRef(ctx, side), opposition: teamRef(ctx, opp),
      lanes: {
        perspective: 'attacking_team', unit: 'thirds_of_pitch_width', ids: [...LANE_KEYS], leftBelow: LANES.leftBelow, rightFrom: LANES.rightFrom,
        mirrorRule: LANES.mirrorRule, pitchHalfWidthM: pitch?.halfWidthM ?? null,
        dangerArea: { depthFromGoalLineM: DANGER_AREA.depthFromGoalLineM, halfWidthM: DANGER_AREA.halfWidthM },
      },
      byLane: laneRows,
      leadingLane: { label: 'descriptive_counts_only', ...leadingLane },
      reconciliation: {
        shots: recon(shots, counters.shots), crosses: recon(crosses, counters.crosses), crossesCompleted: recon(crossesCompleted, counters.crossesCompleted),
        passesCompleted: recon(passesCompleted, counters.passesCompleted),
        finalThirdEntries: { byLane: sum(entries.byLane), withoutLocation: entries.withoutLocation, events: entries.events, unmeasurable: entriesUnmeasurable },
        dangerAreaEntries: { byLane: sum(danger.byLane), withoutLocation: danger.withoutLocation, events: danger.events },
        goals: { events: goals.length, counter: counters.goals },
        xg: {
          attributedToLanes: attributedTotal, attributedShots, unattributedShots, teamCounter: counters.xg,
          notAttributedToLanes: xgExact ? teamXg - attributedTotal : null,
          basis: 'player_xg_counter_step_per_shot_v1',
        },
      },
      goals: {
        label: 'context_only',
        statement: 'Goals are listed with the lane, tick and the players named in the recorded event. The recording carries no defender attribution for a goal, and no goal is attributed to any player.',
        items: goals,
      },
      defensiveInvolvement: {
        label: 'recorded_events_not_performance',
        eventTypes: { tackles: [26, 27], interceptions: [31], aerialDuels: [28, 29] },
        perspective: 'opposition_attack_lanes_mirrored',
        team: team,
        players: playersShown, playersTotal: players.length, playersTruncated: players.length > playersShown.length,
        rolesNote: 'Roles come from metadata revisions stamped with the tick the plugin noticed them; in and out of possession are separate assignments, shown as of the end of the window. Substitutes carry none before their revision.',
        playersWithoutInvolvement: roster.filter((p) => p.participation.status === 'played' && (perPlayer.get(p.upstreamPlayerId)?.total ?? 0) === 0).length,
        eventsOutsideParticipation: outsideParticipation, eventsWithoutRosterActor: withoutActor,
        note: 'Counts only events of the verified types, for a player only while on the pitch. They show where defensive events were recorded and do not attribute any chance or goal to a player.',
      },
      unavailable: UNAVAILABLE_THREAT,
      statements,
      thresholds: { finalThirdFraction: GATES.finalThird },
    },
  })
}

export type ThreatResult = ReturnType<typeof threatQuery>
