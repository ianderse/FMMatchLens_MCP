import { counterDelta } from '@fmmi/model'
import type { NullReason, Side } from '@fmmi/model'
import { clipSegments, makeCtx, playerDelta, segmentTicks, teamDelta, teamSegments } from './context.ts'
import type { AnalysisInput } from './context.ts'
import { finalThirdEntries, recipientGate } from './passes.ts'
import { exposureOf } from './queries.ts'
import { METRIC_DICTIONARY_VERSION, getDefinition } from './registry.ts'
import { scoreStateMinutes } from './scoreState.ts'
import { threatQuery } from './threat.ts'
import type { Lane } from './threat.ts'

/**
 * Per-revision season aggregate (spec 6.3 step 6, Slice 4): the whole-recording numerators and denominators every season,
 * player and tactical-change query pools from, so a query over many matches never decodes them again. Immutable per
 * (recording revision, aggregate key). It carries only SIDES and match-local player ids: team ids and the catalog's current
 * save assignment are read from the catalog at query time, so moving a match never invalidates it.
 */
export const AGGREGATE_SCHEMA = 3

/** Definitions whose versions go into the cache key: a version change in any of them rebuilds every aggregate. */
const KEY_METRICS = [
  'goals', 'xg', 'shots', 'shots_on_target', 'passes', 'passes_completed', 'progressive_passes', 'aerials', 'aerials_won', 'corners', 'key_passes',
  'final_third_entry_passes', 'passes_received', 'passes_received_per_90', 'passes_received_pct_of_team_completed', 'possession_pct', 'per_90_rate',
  'attack_lane', 'opposition_shots_by_lane', 'opposition_xg_by_lane', 'opposition_crosses_by_lane', 'opposition_final_third_entries_by_lane', 'danger_area_entries_by_lane', 'chance_creation_by_wing_trend',
] as const

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** Derived from the registry on every call, so changing a definition version (or the dictionary version) yields a different key. */
export function aggregateKey(): string {
  const versions = KEY_METRICS.map((id) => `${id}@${getDefinition(id).version}`).join(',')
  return `agg${AGGREGATE_SCHEMA}.dict${METRIC_DICTIONARY_VERSION}.${fnv1a(versions)}`
}

export const SIDE_COUNTERS = ['goals', 'xg', 'shots', 'shots_on_target', 'passes', 'passes_completed', 'progressive_passes', 'aerials', 'aerials_won', 'corners'] as const
export const PLAYER_COUNTERS = ['aerials', 'aerials_won', 'passes', 'passes_completed', 'progressive_passes', 'key_passes', 'shots', 'xg', 'goals'] as const

/** Whole-recording chance creation by attack lane for the side that ATTACKS (the per-match lane logic of the threat query, run once per side). */
export const WING_COUNTS = ['shots', 'xg', 'crosses', 'crossesCompleted', 'finalThirdEntries', 'dangerAreaEntries'] as const
export type WingCount = (typeof WING_COUNTS)[number]
export interface SideLanes {
  byLane: Record<Lane, Record<WingCount, number>>
  /** Events of the family with no usable location, never assigned to a lane. */
  withoutLocation: Record<Exclude<WingCount, 'xg'>, number>
  /** Shots whose own xG could not be attributed from counter steps (their xG is in no lane). */
  xgUnattributedShots: number
}

export interface SideAggregate {
  /** Whole-recording counter deltas; null when not recorded or the baseline is unverified (see nullReasons). */
  counters: Record<string, number | null>
  nullReasons: Record<string, NullReason>
  finalThirdEntries: number | null
  possessionTicks: number | null
  scoreStateTicks: { leading: number; drawing: number; trailing: number } | null
  recipientGate: { status: 'pass' | 'fail'; reasons: string[] }
  /** Lanes in which this side attacked; null when the pitch dimensions are not recorded. */
  lanes: SideLanes | null
}

export interface PlayerAggregate {
  localPlayerId: string
  upstreamPlayerId: number
  uid: number | null
  name: string
  side: Side
  status: 'played' | 'unused_substitute'
  ticks: number
  counters: Record<string, number | null>
  receptions: number
  /** Team completed passes (counter scope) while this player was on the pitch. */
  teamCompletedWhileOn: number
  /** Ticks this player spent leading, drawing and trailing (own side's view) over the player's own on-pitch segments; null when the goal counters or the minutes are not available. */
  scoreStateTicks: { leading: number; drawing: number; trailing: number } | null
}

export interface MatchAggregate {
  aggregateSchema: typeof AGGREGATE_SCHEMA
  key: string
  facts: {
    matchDate: string | null
    integrity: string
    coverage: { status: 'full_match' | 'partial' | 'unknown'; reasons: string[]; initialBaseline: 'zero_verified' | 'unverified'; endCaptureEndsAt: { period: number; tick: number; displayMinute: number } | null }
    capturedTicks: number
    observedScore: { home: number; away: number }
    humanControlledSide: Side | null
  }
  sides: Record<Side, SideAggregate>
  players: PlayerAggregate[]
}

/** Lanes where `attacker` attacks: the threat query of the OTHER team, which describes how its opposition (this side) created chances. */
function lanesOf(input: AnalysisInput, attacker: Side): SideLanes | null {
  const defender: Side = attacker === 'home' ? 'away' : 'home'
  const t = threatQuery(input, input.ids.teamIds[defender]).threat
  if (t.lanes.pitchHalfWidthM === null) return null
  const byLane = {} as SideLanes['byLane']
  for (const r of t.byLane) {
    byLane[r.lane] = { shots: r.shots, xg: r.xg.value, crosses: r.crosses, crossesCompleted: r.crossesCompleted, finalThirdEntries: r.finalThirdEntries, dangerAreaEntries: r.dangerAreaEntries }
  }
  const rc = t.reconciliation
  return {
    byLane,
    withoutLocation: { shots: rc.shots.withoutLocation, crosses: rc.crosses.withoutLocation, crossesCompleted: rc.crossesCompleted.withoutLocation, finalThirdEntries: rc.finalThirdEntries.withoutLocation, dangerAreaEntries: rc.dangerAreaEntries.withoutLocation },
    xgUnattributedShots: rc.xg.unattributedShots,
  }
}

export function buildMatchAggregate(input: AnalysisInput): MatchAggregate {
  const ctx = makeCtx(input)
  const rec = ctx.rec
  const teamSegs = clipSegments(teamSegments(rec), ctx.window)
  const side = (s: Side): SideAggregate => {
    const counters: Record<string, number | null> = {}
    const nullReasons: Record<string, NullReason> = {}
    for (const m of SIDE_COUNTERS) {
      const d = teamDelta(ctx, s, m)
      counters[m] = d.value
      if (d.value === null && d.nullReason) nullReasons[m] = d.nullReason
    }
    const poss = counterDelta(ctx.sampled, `team.${s}.possessionTime`, ctx.window)
    const ft = finalThirdEntries(ctx, s)
    const ss = scoreStateMinutes(ctx.sampled, teamSegs, s)
    const gate = recipientGate(ctx, s, 'counter_scope')
    return {
      lanes: lanesOf(input, s),
      counters, nullReasons, finalThirdEntries: ft.value, possessionTicks: poss.value,
      scoreStateTicks: ss.value === null ? null : { ...ss.value.ticks },
      recipientGate: { status: gate.status, reasons: gate.reasons },
    }
  }
  const players: PlayerAggregate[] = rec.roster.map((p) => {
    const ticks = segmentTicks(clipSegments(p.participation.segments, ctx.window))
    const counters: Record<string, number | null> = {}
    let receptions = 0, teamCompleted = 0
    let playerScoreState: PlayerAggregate['scoreStateTicks'] = null
    if (ticks > 0) {
      const pss = scoreStateMinutes(ctx.sampled, clipSegments(p.participation.segments, ctx.window), p.side)
      playerScoreState = pss.value === null ? null : { ...pss.value.ticks }
      for (const m of PLAYER_COUNTERS) counters[m] = playerDelta(ctx, p.upstreamPlayerId, m).value
      const x = exposureOf(ctx, p, 'counter_scope')
      receptions = x.receptions.length
      teamCompleted = x.teamCompletedPasses
    }
    return {
      localPlayerId: input.ids.playerIds.get(p.upstreamPlayerId) ?? `unmapped_${p.upstreamPlayerId}`, upstreamPlayerId: p.upstreamPlayerId, uid: p.uid, name: p.name, side: p.side,
      status: p.participation.status, ticks, counters, receptions, teamCompletedWhileOn: teamCompleted, scoreStateTicks: playerScoreState,
    }
  })
  return {
    aggregateSchema: AGGREGATE_SCHEMA, key: aggregateKey(),
    facts: {
      matchDate: rec.matchDate, integrity: rec.integrity.status,
      coverage: { status: rec.coverage.status, reasons: [...rec.coverage.reasons], initialBaseline: rec.coverage.initialBaseline, endCaptureEndsAt: rec.coverage.endCaptureEndsAt },
      capturedTicks: segmentTicks(teamSegs), observedScore: { home: rec.observedScore.home, away: rec.observedScore.away }, humanControlledSide: rec.humanControlledSide,
    },
    sides: { home: side('home'), away: side('away') },
    players,
  }
}
