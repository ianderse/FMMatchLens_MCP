// TEST-ONLY synthetic match scenarios for Slice 2 analytics. Built as synthetic .fmlens archives, decoded by the real
// adapter, so the analytics see exactly what they would see for a real recording. No real player or club data.
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { baseCompletion, deriveResult } from '@fmmi/model'
import type { Side } from '@fmmi/model'
import type { AnalysisInput } from '@fmmi/analytics'
import { buildSyntheticArchive, defaultPlayers } from './syntheticArchive.ts'
import type { PlayerStatKey, SynthEvent, SynthOptions, SynthPeriod, SynthPlayer } from './syntheticArchive.ts'

export const P1_END = 11041
export const DEFAULT_PERIODS: SynthPeriod[] = [
  { period: 1, fromTick: 3, toTick: P1_END, step: 60, displayOffset: 1 },
  { period: 2, fromTick: 11124, toTick: 21700, step: 60, displayOffset: 323 },
]

export interface ScenarioOpts {
  humanSide?: Side
  /** Team of the striker pair under test (default: the human side, or home). */
  strikerSide?: Side
  /** Tick (period 2) at which the substitute replaces the striker. */
  subTick?: number
  passesPerSide?: number
  /** All passes completed, no throw-ins: for exact coverage arithmetic. */
  pureCompleted?: boolean
  /** Receiver omitted (receiver id 0) for the passes where this returns true; the pass stays completed. */
  dropReceiver?: (side: Side, k: number) => boolean
  /** Counters trail the events by this many completed passes for the first passer of the home side (mismatch case). */
  counterDeficit?: number
  trajectory?: boolean
  periods?: SynthPeriod[]
  halfLength?: number
  homeName?: string
  awayName?: string
  names?: Record<number, string>
  /** Upstream uid per player id (default: the player id). `null` records a missing uid. */
  uids?: Record<number, number | null>
  /** Cumulative stats already non-zero at the first frame (unverified baseline). */
  nonZeroStart?: boolean
  extraEvents?: SynthEvent[]
  goals?: Array<{ tick: number; side: Side }>
  /** Extra stats merged over the generated ones. */
  extraStats?: (tick: number, playerId: number) => Partial<Record<PlayerStatKey, number>>
}

export interface Scenario {
  synth: SynthOptions
  input: AnalysisInput
  base: Record<Side, number>
  /** Striker (loses all aerials), substitute (wins 3/4) and the other outfield ids of the striker side. */
  striker: number
  sub: number
  subTick: number
  strikerSide: Side
  pid: (upstream: number) => string
}

const baseId = (s: Side) => (s === 'home' ? 1000 : 2000)

export async function buildScenario(o: ScenarioOpts = {}): Promise<Scenario> {
  const human = o.humanSide ?? 'home'
  const strikerSide = o.strikerSide ?? human
  const subTick = o.subTick ?? 14003
  const periods = o.periods ?? DEFAULT_PERIODS
  const n = o.passesPerSide ?? 240
  const last = periods[periods.length - 1]!.toTick
  const p2Start = periods[1]!.fromTick
  const striker = baseId(strikerSide) + 9, sub = baseId(strikerSide) + 11

  const players: SynthPlayer[] = defaultPlayers().map((p) => ({ ...p, name: o.names?.[p.playerId] ?? p.name, uid: o.uids && p.playerId in o.uids ? o.uids[p.playerId] : p.uid }))
  const events: SynthEvent[] = []
  let seq = 0
  for (const side of ['home', 'away'] as const) {
    const b = baseId(side)
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => b + i)
    for (let k = 0; k < n; k++) {
      let tick = 10 + Math.floor((k * (last - 20)) / n)
      if (tick > periods[0]!.toTick && tick < p2Start) tick = p2Start + (tick - periods[0]!.toTick)
      const inP2 = tick >= p2Start
      const subOn = side === strikerSide && tick >= subTick
      const incomplete = !o.pureCompleted && k % 7 === 6
      const throwIn = !o.pureCompleted && k % 29 === 28
      const from = ids[k % 8]!
      let to = ids[(k + 3) % 8]!
      if (subOn && k % 10 === 0) to = sub
      if (o.dropReceiver?.(side, k)) to = 0
      const attackPositive = (side === 'home') === inP2
      const sign = attackPositive ? 1 : -1
      const lon = sign * (5 + (k % 20))
      events.push({
        sequenceIndex: seq++, tick, type: incomplete ? 8 : 7, team: side, playerId: from, receiverId: incomplete || to === 0 ? undefined : to,
        flags: 1 | (attackPositive ? 0x100 : 0) | (throwIn ? 0x8 : 0), lateral: (k % 9) - 4, longitudinal: lon, completionTick: tick + 2,
        trajectory: o.trajectory && !incomplete ? [{ lateral: (k % 9) - 4, longitudinal: lon }, { lateral: 0, longitudinal: lon + sign * 5 }, { lateral: 0, longitudinal: lon + sign * 10 }] : undefined,
      })
    }
  }
  // Aerial duels: the striker loses 7 (all before the substitution); the substitute wins 3 of 4 afterwards.
  const strikerAerials = Array.from({ length: 7 }, (_, i) => 3000 + i * 1700)
  const subAerials = [subTick + 800, subTick + 2000, subTick + 3200, subTick + 4400]
  strikerAerials.forEach((t) => events.push({ sequenceIndex: seq++, tick: t, type: 29, team: strikerSide, playerId: striker, flags: 1 }))
  subAerials.forEach((t, i) => events.push({ sequenceIndex: seq++, tick: t, type: i < 3 ? 28 : 29, team: strikerSide, playerId: sub, flags: 1 }))
  // The archive writer exposes the last 64 events by sequence index, so sequence must follow tick order.
  events.sort((a, b) => a.tick - b.tick || a.sequenceIndex - b.sequenceIndex).forEach((e, i) => { e.sequenceIndex = i })
  events.push(...(o.extraEvents ?? []))
  const subShots = [subTick + 1000, subTick + 2500, subTick + 4000]

  const passers = new Map<number, SynthEvent[]>()
  for (const e of events) if (e.type === 7 || e.type === 8) { const l = passers.get(e.playerId) ?? []; l.push(e); passers.set(e.playerId, l) }

  const stats = (tick: number, pid: number): Partial<Record<PlayerStatKey, number>> => {
    const mine = (passers.get(pid) ?? []).filter((e) => (e.completionTick ?? e.tick) <= tick && ((e.flags ?? 0) & 0x8) === 0)
    const deficit = pid === baseId('home') + 1 ? (o.counterDeficit ?? 0) : 0
    const out: Partial<Record<PlayerStatKey, number>> = {
      passes: mine.length, passesCompleted: Math.max(0, mine.filter((e) => e.type === 7).length - deficit),
    }
    if (pid === striker) out.aerials = strikerAerials.filter((t) => t <= tick).length
    if (pid === sub) {
      out.aerials = subAerials.filter((t) => t <= tick).length
      out.aerialsWon = Math.min(3, out.aerials)
      const s = subShots.filter((t) => t <= tick).length
      out.shots = s
      out.xg = Math.fround([0.11, 0.11, 0.11].slice(0, s).reduce((a, b) => a + b, 0))
    }
    if (o.nonZeroStart && pid === striker) out.aerials = (out.aerials ?? 0) + 2
    return { ...out, ...(o.extraStats?.(tick, pid) ?? {}) }
  }

  const synth: SynthOptions = {
    upstreamMatchId: 'match-synth-1', humanSide: human, homeName: o.homeName ?? 'Synth Home', awayName: o.awayName ?? 'Synth Away',
    players, periods, subs: [{ tick: subTick, off: striker, on: sub }], events, stats, halfLength: o.halfLength, goals: o.goals,
  }
  const decoded = await new FmlensV28Decoder().decode(buildSyntheticArchive(synth).bytes)
  const completion = baseCompletion()
  const input: AnalysisInput = {
    decoded,
    ids: {
      matchId: 'm_synth', saveId: 's_synth', recordingRevisionId: 'r_synth', teamIds: { home: 't_home', away: 't_away' },
      playerIds: new Map(decoded.recording.roster.map((p) => [p.upstreamPlayerId, `p_${p.upstreamPlayerId}`] as const)),
    },
    completion, result: deriveResult(decoded.recording.observedScore, completion),
  }
  return { synth, input, base: { home: baseId('home'), away: baseId('away') }, striker, sub, subTick, strikerSide, pid: (u) => `p_${u}` }
}
