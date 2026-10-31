import {
  GAP_TOLERANCE_TICKS, SCHEMA_VERSION, SampledCounters, TICKS_PER_MINUTE, boundName, deriveCoverage, round,
} from '@fmmi/model'
import type {
  AttackNormalised, Boundary, DecodedRecording, FileIntegrity, NormalizedEvent, Participant, PeriodSpan, PlaySegment,
  RoleAssignment, RoleTimelineEntry, Side, SubstitutionBatch, TeamInfo, TeamTotals,
} from '@fmmi/model'
import type { RealtimeFrame, RealtimeMatchMetadata, RealtimeMomentumEvent } from './upstream/realtimeTypes.ts'
import type { ParsedLocalArchive } from './upstream/localArchive.ts'
import type { PlayerTacticalAssignment } from './upstream/match.ts'
import { estimateRatings } from './ratings.ts'
import { FLAG_ATTACK_POSITIVE, FLAG_KEY_PASS, FLAG_THROW_IN, eventKind, isPassOrCross } from './eventKinds.ts'

export const PARSER_NAME = '@fmmi/fmlens-adapter'
export const PARSER_VERSION = '1.0.0'
export const UPSTREAM_REF = 'osnsyc/FMMatchLens v0.7.0 archiveParser.ts (MIT)'

const TEAM_KEYS = [
  'goals', 'xg', 'possessionTime', 'shots', 'shotsOnTarget', 'shotsOffTarget', 'blockedShots', 'clearCutChances', 'passes',
  'passesCompleted', 'crosses', 'crossesCompleted', 'aerials', 'aerialsWon', 'progressivePasses', 'finalThirdPasses',
  'tacklesAttempted', 'tacklesWon', 'fouls', 'corners', 'offsides', 'yellowCards', 'redCards', 'firstHalfShots', 'secondHalfShots',
] as const

const PLAYER_COUNTER_KEYS = [
  'goals', 'assists', 'penalties', 'ownGoals', 'xg', 'xa', 'shots', 'shotsOnTarget', 'blockedShots', 'clearCutChances', 'hitWoodwork',
  'dribbles', 'fouls', 'fouled', 'crosses', 'crossesCompleted', 'passes', 'passesCompleted', 'progressivePasses', 'keyPasses',
  'tacklesAttempted', 'tacklesWon', 'keyTackles', 'aerials', 'aerialsWon', 'interceptions', 'throwIns', 'corners',
  'defensiveFreeKicks', 'attackingFreeKicks', 'clearances', 'shotsFaced', 'savesHeld', 'savesParried', 'savesTipped',
] as const

interface PState {
  side: Side
  prevOn: boolean | null
  open: { fromTick: number; fromReason: PlaySegment['fromReason'] } | null
  segments: PlaySegment[]
  lastPeriod: number | null
}
interface Flip { side: Side; period: number; tick: number; playerId: number; on: boolean }
interface EventEntry { obj: RealtimeMomentumEvent; versions: number; firstSeenSeq: number }

const eventKey = (e: RealtimeMomentumEvent) =>
  JSON.stringify([e.tick, e.lateralPosition, e.longitudinalPosition, e.team, e.playerSlot, e.playerId, e.receiverPlayerSlot,
    e.receiverPlayerId, e.eventType, e.flags, e.sequenceIndex, e.completionTick, e.trajectoryPoints])

/** Consumes frames one at a time (bounded memory) and produces the normalized recording. */
export class RecordingBuilder {
  readonly sampled = new SampledCounters()
  private periods = new Map<number, PeriodSpan>()
  private pstate = new Map<number, PState>()
  private flips: Flip[] = []
  private events = new Map<number, EventEntry>()
  private prevTick: number | null = null
  private prevPeriod: number | null = null
  private overTol = 0
  private largestGap = 0
  private samplingGaps = 0
  private missingTicks = 0
  private first: RealtimeFrame | null = null
  private last: RealtimeFrame | null = null
  private baselineZero = false
  private frameCount = 0

  onFrame = (f: RealtimeFrame, i: number): void => {
    const sc = this.sampled
    sc.frames.push(f.period, f.tick, f.sequence, f.displayTick)
    this.frameCount++
    if (i === 0) {
      this.first = f
      const teamsZero = (['home', 'away'] as const).every((s) => TEAM_KEYS.every((k) => (f[s][k] ?? 0) === 0))
      const playersZero = f.players.every((p) => PLAYER_COUNTER_KEYS.every((k) => (p[k] ?? 0) === 0))
      this.baselineZero = teamsZero && playersZero && f.period === 1 && f.tick <= GAP_TOLERANCE_TICKS
      sc.initialBaseline = this.baselineZero ? 'zero_verified' : 'unverified'
    }
    this.last = f

    let span = this.periods.get(f.period)
    if (!span) {
      span = { period: f.period, frames: 0, firstTick: f.tick, lastTick: f.tick, firstDisplayTick: f.displayTick, lastDisplayTick: f.displayTick }
      this.periods.set(f.period, span)
    }
    span.frames++; span.lastTick = f.tick; span.lastDisplayTick = f.displayTick

    if (this.prevTick !== null && this.prevPeriod === f.period) {
      const d = f.tick - this.prevTick
      if (d > 1) { this.samplingGaps++; this.missingTicks += d - 1 }
      if (d > this.largestGap) this.largestGap = d
      if (d > GAP_TOLERANCE_TICKS) this.overTol++
    }

    for (const side of ['home', 'away'] as const) {
      const t = f[side]
      for (const k of TEAM_KEYS) sc.observe(`team.${side}.${k}`, i, t[k])
    }

    for (const p of f.players) {
      const base = `player.${p.playerId}`
      for (const k of PLAYER_COUNTER_KEYS) {
        const v = p[k]
        if (typeof v === 'number') sc.observe(`${base}.${k}`, i, v)
      }
      sc.observe(`${base}.onPitch`, i, p.isOnPitch ? 1 : 0)
      let st = this.pstate.get(p.playerId)
      if (!st) { st = { side: p.team, prevOn: null, open: null, segments: [], lastPeriod: null }; this.pstate.set(p.playerId, st) }
      if (st.open && st.lastPeriod !== null && st.lastPeriod !== f.period) {
        st.segments.push({ period: st.lastPeriod, fromTick: st.open.fromTick, toTick: this.prevTick!, fromReason: st.open.fromReason, toReason: 'period_end' })
        st.open = null
      }
      if (p.isOnPitch) {
        if (!st.open) {
          const reason: PlaySegment['fromReason'] = i === 0 ? 'start_of_capture' : st.prevOn ? 'period_start' : 'on_pitch'
          st.open = { fromTick: f.tick, fromReason: reason }
        }
      } else if (st.open) {
        st.segments.push({ period: f.period, fromTick: st.open.fromTick, toTick: f.tick, fromReason: st.open.fromReason, toReason: 'off_pitch' })
        st.open = null
      }
      if (i > 0 && st.prevOn !== null && st.prevOn !== p.isOnPitch) {
        this.flips.push({ side: p.team, period: f.period, tick: f.tick, playerId: p.playerId, on: p.isOnPitch })
      }
      st.prevOn = p.isOnPitch
      st.lastPeriod = f.period
    }

    for (const e of f.momentumEvents) {
      const cur = this.events.get(e.sequenceIndex)
      if (!cur) this.events.set(e.sequenceIndex, { obj: e, versions: 1, firstSeenSeq: f.sequence })
      else if (cur.obj !== e) {
        if (eventKey(cur.obj) !== eventKey(e)) cur.versions++
        cur.obj = e
      }
    }
    this.prevTick = f.tick
    this.prevPeriod = f.period
  }

  finish(parsed: ParsedLocalArchive, meta: RealtimeMatchMetadata, sizeBytes: number): DecodedRecording {
    const f = this.last!
    const warnings: string[] = []
    // Non-destructive: a live reader calls finish() repeatedly on a builder that keeps receiving frames, so the still-open
    // segments are closed on copies and the running state is left as it was.
    const closedSegments = new Map<number, PlaySegment[]>()
    for (const [id, st] of this.pstate) {
      const segs = [...st.segments]
      if (st.open) segs.push({ period: st.lastPeriod!, fromTick: st.open.fromTick, toTick: f.tick, fromReason: st.open.fromReason, toReason: 'recording_end' })
      closedSegments.set(id, segs)
    }
    const periods = [...this.periods.values()].sort((a, b) => a.period - b.period)
    const ig = parsed.integrity
    const integrity: FileIntegrity = {
      status: ig.blockError || ig.truncatedTail ? 'recovered_prefix' : 'valid',
      cleanClose: ig.cleanClose,
      lastValidatedBoundary: { period: ig.lastValidatedPeriod, tick: ig.lastValidatedTick },
      error: ig.blockError ? ig.blockError : ig.truncatedTail ? 'truncated_tail' : null,
      framesDecoded: ig.framesDecoded,
      blocksDecoded: ig.blocksDecoded,
    }
    if (!parsed.archive.ended) { /* clean-close marker absent: reported via integrity.cleanClose */ }
    if (ig.cleanClose && (parsed.archive.homeGoals !== f.home.goals || parsed.archive.awayGoals !== f.away.goals)) {
      warnings.push('final_index_score_differs_from_last_frame')
    }

    // Substitution batches: grouped by side and tick. Pairing is never inferred.
    const groups = new Map<string, SubstitutionBatch>()
    for (const fl of this.flips) {
      const k = `${fl.side}|${fl.period}|${fl.tick}`
      let g = groups.get(k)
      if (!g) { g = { side: fl.side, period: fl.period, tick: fl.tick, off: [], on: [], pairing: 'not_recorded' }; groups.set(k, g) }
      ;(fl.on ? g.on : g.off).push(fl.playerId)
    }
    const substitutionBatches = [...groups.values()].sort((a, b) => a.period - b.period || a.tick - b.tick)
    const inBatch = new Set<number>()
    for (const g of substitutionBatches) if (g.on.length + g.off.length > 2) for (const id of [...g.on, ...g.off]) inBatch.add(id)

    const lastPlayers = new Map(f.players.map((p) => [p.playerId, p]))
    const awayBase = Math.min(...meta.players.filter((p) => p.team === 'away').map((p) => p.slot))
    const roster: Participant[] = [...meta.players].sort((a, b) => a.slot - b.slot).map((mp) => {
      const segments = closedSegments.get(mp.playerId) ?? []
      const ticks = segments.reduce((a, s) => a + (s.toTick - s.fromTick), 0)
      const played = segments.length > 0
      const lp = lastPlayers.get(mp.playerId)
      const offFlips = this.flips.filter((x) => x.playerId === mp.playerId && !x.on)
      const lastOffFlip = offFlips[offFlips.length - 1]
      const onAtEnd = !!lp?.isOnPitch
      const counters: Record<string, number> = {}
      if (lp) for (const k of [...PLAYER_COUNTER_KEYS, 'distanceM'] as const) { const v = lp[k]; if (typeof v === 'number') counters[k] = v }
      const firstSeg = segments[0]
      return {
        upstreamPlayerId: mp.playerId,
        uid: mp.uid ?? null,
        slot: mp.slot,
        side: mp.team,
        name: boundName(mp.displayName),
        shirtNumber: mp.shirtNumber ?? null,
        position: mp.position ?? null,
        participation: {
          status: played ? 'played' : 'unused_substitute',
          enteredAs: !firstSeg ? null : firstSeg.fromReason === 'start_of_capture' ? 'starter' : 'substitute',
          segments,
          elapsedTicks: ticks,
          elapsedMinutes: round(ticks / TICKS_PER_MINUTE, 4),
          firstOn: firstSeg ? { period: firstSeg.period, tick: firstSeg.fromTick, sequence: 0 } : null,
          lastOff: !onAtEnd && lastOffFlip ? { period: lastOffFlip.period, tick: lastOffFlip.tick, sequence: 0 } : null,
          onPitchAtEndOfRecording: onAtEnd,
          sameTickBatch: inBatch.has(mp.playerId),
        },
        roleTimeline: [],
        nativeRating: lp ? lp.rating : null,
        counters,
        hasPositionSamples: played,
      } satisfies Participant
    })
    const byId = new Map(roster.map((p) => [p.upstreamPlayerId, p]))
    // role timeline from metadata revisions (change points only)
    for (const rev of parsed.metadataTimeline) {
      for (const mp of rev.players) {
        const p = byId.get(mp.playerId)
        if (!p) continue
        const entry: RoleTimelineEntry = {
          capturedTick: rev.capturedTick, position: mp.position ?? null,
          inPossession: assignment(mp.inPossession), outOfPossession: assignment(mp.outOfPossession),
        }
        const prev = p.roleTimeline[p.roleTimeline.length - 1]
        if (!prev || JSON.stringify({ ...prev, capturedTick: 0 }) !== JSON.stringify({ ...entry, capturedTick: 0 })) p.roleTimeline.push(entry)
      }
    }

    const halfW = f.halfPitchWidth, halfL = f.halfPitchLength
    let slotMismatch = 0, unknownActor = 0, unknownReceiver = 0
    const events: NormalizedEvent[] = [...this.events.entries()].sort((a, b) => a[0] - b[0]).map(([id, en]) => {
      const e = en.obj
      const k = eventKind(e.eventType)
      const actor = byId.get(e.playerId)
      if (!actor) unknownActor++
      else if (actor.side !== e.team || actor.slot - (e.team === 'away' ? awayBase : 0) !== e.playerSlot) slotMismatch++
      let receiverPlayerId: number | null = null
      let receiverNullReason: NormalizedEvent['receiverNullReason'] = null
      if (!isPassOrCross(e.eventType)) receiverNullReason = 'not_applicable'
      else if (e.receiverPlayerId === 0 || e.receiverPlayerSlot === 255) receiverNullReason = 'not_recorded'
      else if (!byId.has(e.receiverPlayerId)) { receiverNullReason = 'unverified_semantics'; unknownReceiver++ }
      else receiverPlayerId = e.receiverPlayerId
      let period: number | null = null
      let periodNullReason: NormalizedEvent['periodNullReason'] = 'outside_capture'
      for (let i = 0; i < periods.length; i++) {
        const p = periods[i]!
        if (e.tick >= p.firstTick && e.tick <= p.lastTick) { period = p.period; periodNullReason = null; break }
        const nx = periods[i + 1]
        if (nx && e.tick > p.lastTick && e.tick < nx.firstTick) { periodNullReason = 'in_period_gap'; break }
      }
      const positive = (e.flags & FLAG_ATTACK_POSITIVE) !== 0
      const norm = (lat: number, lon: number): AttackNormalised => {
        const lateralM = positive ? lat : -lat
        const forwardM = positive ? lon : -lon
        return {
          attackDirection: positive ? 'toward_positive_longitudinal' : 'toward_negative_longitudinal',
          lateralM, forwardM,
          lateralUnit: halfW > 0 ? (lateralM + halfW) / (2 * halfW) : null,
          forwardUnit: halfL > 0 ? (forwardM + halfL) / (2 * halfL) : null,
        }
      }
      return {
        eventId: id, type: e.eventType, kind: k.kind, semantics: k.semantics, side: e.team,
        playerId: e.playerId, receiverPlayerId, receiverNullReason,
        tick: e.tick, completionTick: e.completionTick, period, periodNullReason,
        flags: e.flags, keyPass: (e.flags & FLAG_KEY_PASS) !== 0 && isPassOrCross(e.eventType), throwIn: (e.flags & FLAG_THROW_IN) !== 0 && isPassOrCross(e.eventType),
        source: { lateralM: e.lateralPosition, longitudinalM: e.longitudinalPosition },
        normalised: norm(e.lateralPosition, e.longitudinalPosition),
        trajectory: (e.trajectoryPoints ?? []).map((t) => ({ lateralM: t.lateralPosition, longitudinalM: t.longitudinalPosition })),
        versions: en.versions,
        firstSeenFrameSequence: en.firstSeenSeq,
      }
    })
    if (slotMismatch) warnings.push(`event_actor_slot_mismatch:${slotMismatch}`)
    if (unknownActor) warnings.push(`event_actor_not_in_roster:${unknownActor}`)
    if (unknownReceiver) warnings.push(`event_receiver_not_in_roster:${unknownReceiver}`)

    const byKind: Record<string, number> = {}
    for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1

    const coverage = deriveCoverage({
      integrity, periods,
      gaps: { overToleranceCount: this.overTol, largestGapTicks: this.largestGap, samplingGapCount: this.samplingGaps, missingTicks: this.missingTicks },
      initialBaseline: this.sampled.initialBaseline,
    })

    const humans = (['home', 'away'] as const).filter((s) => meta[s].manager?.isHumanControlled === true)
    const team = (s: Side): TeamInfo => ({
      uid: meta[s].uid ?? null, clubUid: meta[s].clubUid ?? null, name: boundName(meta[s].name),
      managerIsHuman: meta[s].manager ? meta[s].manager!.isHumanControlled : null,
    })
    const totals = (s: Side): TeamTotals => Object.fromEntries(TEAM_KEYS.map((k) => [k, f[s][k]]))
    const first = this.first!
    const recording = {
      schemaVersion: SCHEMA_VERSION,
      source: {
        kind: 'fmlens_archive' as const, format: '2.8', upstreamMatchId: parsed.archive.matchId,
        startedUnixMs: parsed.archive.startedUnixMilliseconds, endedUnixMs: parsed.archive.endedUnixMilliseconds ?? null, sizeBytes,
      },
      parser: { name: PARSER_NAME, version: PARSER_VERSION, upstream: UPSTREAM_REF },
      integrity,
      matchDate: parsed.archive.matchDate ?? null,
      competition: meta.competition?.name ? { uid: meta.competition.uid ?? null, name: boundName(meta.competition.name) } : null,
      pitch: halfW > 0 && halfL > 0 ? { halfWidthM: halfW, halfLengthM: halfL } : null,
      teams: { home: team('home'), away: team('away') },
      humanControlledSide: humans.length === 1 ? humans[0]! : null,
      periods,
      frameCount: this.frameCount,
      firstBoundary: { period: first.period, tick: first.tick, sequence: first.sequence } as Boundary,
      lastBoundary: { period: f.period, tick: f.tick, sequence: f.sequence } as Boundary,
      observedScore: { home: f.home.goals, away: f.away.goals, at: { period: f.period, tick: f.tick, displayMinute: round(f.displayTick / TICKS_PER_MINUTE, 2) } },
      teamTotals: { home: totals('home'), away: totals('away') },
      roster,
      substitutionBatches,
      metadataRevisions: parsed.metadataTimeline.length,
      eventSummary: { distinct: events.length, withRevisions: events.filter((e) => e.versions > 1).length, byKind },
      coverage,
      warnings,
    }
    return { recording, events, sampled: this.sampled, ratings: estimateRatings(f) }
  }
}

function assignment(a: PlayerTacticalAssignment | undefined): RoleAssignment | null {
  return a ? { position: boundName(a.position, 40), role: boundName(a.role, 80), duty: a.duty ? boundName(a.duty, 40) : null } : null
}
