// Slice 3b on synthetic recordings: lanes, mirroring, away-team case, defender involvement, goals as context, ratings without model data.
// Built as synthetic .fmlens archives decoded by the real adapter. No real player or club data.
import { describe, expect, it } from 'vitest'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { baseCompletion, deriveResult } from '@fmmi/model'
import type { Side } from '@fmmi/model'
import {
  DANGER_AREA, LANES, METRIC_REGISTRY, UNAVAILABLE_THREAT, defendingFlank, getDefinition, inDangerArea, laneOf, mirroredLane, playerQuery, renderPlayer, renderThreat, threatQuery,
} from '@fmmi/analytics'
import type { AnalysisInput } from '@fmmi/analytics'
import { buildSyntheticArchive, defaultPlayers } from '../support/syntheticArchive.ts'
import type { PlayerStatKey, SynthEvent, SynthOptions } from '../support/syntheticArchive.ts'

const BANNED = /\b(because|caused|causes|due to|therefore|hypothes\w*|recommend\w*|should|suggest\w*|consider|try|expect\w* to|explains?|led to|result of|responsible|fault|blame\w*|exploit\w*|failed to)\b/i

const P1 = { from: 3, to: 11041 }, P2 = { from: 11124, to: 21700 }
const H = 34.3125, L = 50.325
// Absolute coordinates. Home attacks -y in period 1 (flag 0x100 unset) and +y in period 2; away is the reverse.
const flagFor = (team: Side, period: 1 | 2) => 1 | ((team === 'home') === (period === 2) ? 0x100 : 0)
let seq = 0
function ev(e: Omit<SynthEvent, 'sequenceIndex' | 'flags'> & { period: 1 | 2; flags?: number }): SynthEvent {
  const { period, ...rest } = e
  return { sequenceIndex: seq++, ...rest, flags: (e.flags ?? 0) | flagFor(e.team, period), completionTick: e.completionTick ?? e.tick + 2 }
}

interface Built { input: AnalysisInput; xgOf: Map<number, number> }
async function build(events: SynthEvent[], opts: { xg?: Array<[number, number]>; goals?: SynthOptions['goals']; subs?: SynthOptions['subs']; roleChanges?: SynthOptions['roleChanges'] } = {}): Promise<Built> {
  events.sort((a, b) => a.tick - b.tick || a.sequenceIndex - b.sequenceIndex).forEach((e, i) => { e.sequenceIndex = i })
  const xgOf = new Map<number, number>(opts.xg ?? [])
  const stats = (tick: number, pid: number): Partial<Record<PlayerStatKey, number>> => {
    const mine = events.filter((e) => e.playerId === pid && (e.completionTick ?? e.tick) + 1 <= tick)
    const flags = (e: SynthEvent) => e.flags ?? 0
    return {
      passes: mine.filter((e) => e.type >= 6 && e.type <= 11 && (flags(e) & 0x8) === 0).length,
      passesCompleted: mine.filter((e) => e.type === 7 && (flags(e) & 0x8) === 0).length,
      crosses: mine.filter((e) => e.type >= 12 && e.type <= 17).length, crossesCompleted: mine.filter((e) => e.type === 12).length,
      shots: mine.filter((e) => e.type >= 1 && e.type <= 5).length,
      xg: Math.fround(mine.filter((e) => e.type >= 1 && e.type <= 5).reduce((a, e) => a + (xgOf.get(e.sequenceIndex) ?? 0), 0)),
    }
  }
  const synth: SynthOptions = {
    upstreamMatchId: 'match-threat', humanSide: 'home', homeName: 'Synth Home', awayName: 'Synth Away', players: defaultPlayers(),
    periods: [{ period: 1, fromTick: P1.from, toTick: P1.to, step: 60, displayOffset: 1 }, { period: 2, fromTick: P2.from, toTick: P2.to, step: 60, displayOffset: 323 }],
    events, stats, goals: opts.goals, subs: opts.subs, roleChanges: opts.roleChanges,
  }
  const decoded = await new FmlensV28Decoder().decode(buildSyntheticArchive(synth).bytes)
  const completion = baseCompletion()
  return {
    xgOf,
    input: {
      decoded,
      ids: { matchId: 'm_t', saveId: 's_t', recordingRevisionId: 'r_t', teamIds: { home: 't_home', away: 't_away' }, playerIds: new Map(decoded.recording.roster.map((p) => [p.upstreamPlayerId, `p_${p.upstreamPlayerId}`] as const)) },
      completion, result: deriveResult(decoded.recording.observedScore, completion),
    },
  }
}

const shot = (team: Side, period: 1 | 2, tick: number, playerId: number, lateral: number, longitudinal: number, type = 4) => ev({ period, tick, type, team, playerId, lateral, longitudinal })

describe('Slice 3b lanes (spec 7.4) - registry and mirroring rule', () => {
  it('AC lane thirds: the boundaries are lower-inclusive, unclamped, and equal the registry thresholds', () => {
    expect(LANES.leftBelow).toBe(1 / 3)
    expect(LANES.rightFrom).toBe(2 / 3)
    expect(laneOf(0)).toBe('left')
    expect(laneOf(1 / 3 - 1e-9)).toBe('left')
    expect(laneOf(1 / 3)).toBe('centre') // equality goes to the centre
    expect(laneOf(2 / 3 - 1e-9)).toBe('centre')
    expect(laneOf(2 / 3)).toBe('right') // equality goes to the right
    expect(laneOf(-0.2)).toBe('left') // beyond the touchline stays in the outer lane, never clamped away
    expect(laneOf(1.2)).toBe('right')
    expect(laneOf(null)).toBeNull()
    expect(laneOf(Number.NaN)).toBeNull()
    expect(getDefinition('attack_lane').thresholds).toEqual({ leftBelow: 1 / 3, rightFrom: 2 / 3 })
  })

  it('AC mirroring rule is recorded in the registry and implemented: a defender event is mirrored into the attackers frame', () => {
    expect(getDefinition('attack_lane').semantics).toContain('mirrored with lateralUnit -> 1 - lateralUnit')
    expect(LANES.mirrorRule).toMatch(/identical in both halves and for both teams by construction/)
    expect(mirroredLane(0.1)).toBe('right') // own-left defender event is the opposition right lane
    expect(mirroredLane(0.9)).toBe('left')
    expect(mirroredLane(0.5)).toBe('centre')
    expect(defendingFlank('left')).toBe('right')
    expect(defendingFlank('right')).toBe('left')
    expect(defendingFlank('centre')).toBe('centre')
  })

  it('AC danger area is defined with explicit geometry in the registry and tested at its edges', () => {
    const d = getDefinition('danger_area_entries_by_lane')
    expect(d.thresholds).toEqual({ depthFromGoalLineM: 16.5, halfWidthM: 20.16 })
    expect(DANGER_AREA).toEqual({ depthFromGoalLineM: 16.5, halfWidthM: 20.16 })
    const unit = (latM: number, fwdM: number) => ({ lateralUnit: (latM + H) / (2 * H), forwardUnit: (fwdM + L) / (2 * L) })
    expect(inDangerArea(H, L, unit(0, L - 16.5))).toBe(true) // edge of the depth is inside
    expect(inDangerArea(H, L, unit(0, L - 16.6))).toBe(false)
    expect(inDangerArea(H, L, unit(20.16, L - 5))).toBe(true)
    expect(inDangerArea(H, L, unit(-20.17, L - 5))).toBe(false)
  })

  it('AC every Slice 3b metric has a registry entry with a version, formula and null reasons, and the unavailable items are registered as unavailable', () => {
    const ids = ['attack_lane', 'opposition_shots_by_lane', 'opposition_xg_by_lane', 'opposition_crosses_by_lane', 'opposition_passes_completed_by_lane', 'opposition_final_third_entries_by_lane',
      'danger_area_entries_by_lane', 'defender_involvement_by_lane', 'conceded_goal_context', 'native_rating', 'estimated_rating_contribution', 'rating_reconstruction_residual']
    for (const id of ids) { const d = getDefinition(id); expect(d.version).toBeGreaterThanOrEqual(1); expect(d.formula.length).toBeGreaterThan(20); expect(d.nullReasons.length).toBeGreaterThan(0) }
    expect(getDefinition('estimated_rating_contribution').confidence).toBe('estimated')
    expect(getDefinition('native_rating').confidence).toBe('recorded')
    for (const u of UNAVAILABLE_THREAT) expect(getDefinition(u.id).kind).toBe('unavailable')
    expect(UNAVAILABLE_THREAT.find((u) => u.id === 'defender_clearances')?.reason).toBe('unverified_semantics')
    expect(METRIC_REGISTRY.filter((d) => d.kind === 'estimate').every((d) => d.confidence === 'estimated')).toBe(true)
  })
})

describe('Slice 3b opposition threat on a synthetic recording', () => {
  // Away attacks +y in period 1 (flag set), -y in period 2. Attack-rotated lateral = +x when flag set, else -x.
  const awayShooter = 2009, awayPasser = 2003, awayWinger = 2005
  const events = () => {
    seq = 0
    return [
      // The same attacking-perspective LEFT lane in both halves: p1 x=-20 (flag set, normalised -20); p2 x=+20 (flag unset, normalised -20).
      shot('away', 1, 1000, awayShooter, -20, 40), shot('away', 2, 13000, awayShooter, 20, -40),
      // centre in p2, right in p1 (x=+20 flag set) and right in p2 (x=-20 flag unset)
      shot('away', 2, 15000, awayShooter, 0, -40, 5), shot('away', 1, 5000, awayShooter, 20, 40, 2), shot('away', 2, 18000, awayShooter, -20, -40, 4),
      // crosses: completed left (p1), incomplete right (p2)
      ev({ period: 1, tick: 2000, type: 12, team: 'away', playerId: awayWinger, lateral: -25, longitudinal: 30, trajectory: [{ lateral: -25, longitudinal: 30 }, { lateral: -5, longitudinal: 42 }] }),
      ev({ period: 2, tick: 14000, type: 14, team: 'away', playerId: awayWinger, lateral: -25, longitudinal: -30 }),
      // completed pass entering the final third on the right (p1, x=+15 flag set -> right) and one inside the danger area from outside (centre)
      ev({ period: 1, tick: 3000, type: 7, team: 'away', playerId: awayPasser, receiverId: 2004, lateral: 15, longitudinal: 10, trajectory: [{ lateral: 15, longitudinal: 10 }, { lateral: 15, longitudinal: 25 }] }),
      ev({ period: 1, tick: 4000, type: 7, team: 'away', playerId: awayPasser, receiverId: 2004, lateral: 0, longitudinal: 20, trajectory: [{ lateral: 0, longitudinal: 20 }, { lateral: -3, longitudinal: 40 }] }),
      // a pass wholly inside the box and a throw-in are not entries
      ev({ period: 1, tick: 4500, type: 7, team: 'away', playerId: awayPasser, receiverId: 2004, lateral: 0, longitudinal: 38, trajectory: [{ lateral: 0, longitudinal: 38 }, { lateral: 2, longitudinal: 44 }] }),
      ev({ period: 1, tick: 4600, type: 7, team: 'away', playerId: awayPasser, receiverId: 2004, flags: 0x8, lateral: 0, longitudinal: 20, trajectory: [{ lateral: 0, longitudinal: 20 }, { lateral: 0, longitudinal: 40 }] }),
      // home (the selected team) defensive events, own frame: p1 home attacks -y
      ev({ period: 1, tick: 6000, type: 31, team: 'home', playerId: 1002, lateral: 20, longitudinal: 20 }), // absolute x=+20; away p1 attacks +y so this is their RIGHT lane
      ev({ period: 2, tick: 16000, type: 31, team: 'home', playerId: 1002, lateral: -20, longitudinal: -20 }), // p2 home attacks +y; x=-20 is the away (attacking -y) normalised +20 = right
      ev({ period: 1, tick: 7000, type: 26, team: 'home', playerId: 1003, lateral: -20, longitudinal: 20 }),
      ev({ period: 1, tick: 7500, type: 27, team: 'home', playerId: 1003, lateral: 0, longitudinal: 20 }),
      ev({ period: 1, tick: 8000, type: 28, team: 'home', playerId: 1004, lateral: 0, longitudinal: 20 }),
      ev({ period: 1, tick: 8500, type: 29, team: 'home', playerId: 1004, lateral: 0, longitudinal: 20 }),
      // clearances are not verified: present in the recording, absent from the involvement
      ev({ period: 1, tick: 9000, type: 24, team: 'home', playerId: 1002, lateral: 0, longitudinal: 20 }),
      // a substituted-off player (1010) acts before and after his own substitution; the bench player (1011) the reverse
      ev({ period: 1, tick: 9500, type: 31, team: 'home', playerId: 1010, lateral: 0, longitudinal: 20 }),
      ev({ period: 2, tick: 17000, type: 31, team: 'home', playerId: 1010, lateral: 0, longitudinal: -20 }),
      ev({ period: 2, tick: 17500, type: 31, team: 'home', playerId: 1011, lateral: 0, longitudinal: -20 }),
      ev({ period: 1, tick: 9600, type: 31, team: 'home', playerId: 1011, lateral: 0, longitudinal: 20 }),
      // goals
      ev({ period: 1, tick: 10000, type: 1, team: 'away', playerId: awayShooter, lateral: -5, longitudinal: 45 }),
    ]
  }
  const make = () => build(events(), { goals: [{ tick: 10000, side: 'away' }], subs: [{ tick: 14000, off: 1010, on: 1011 }], roleChanges: [{ capturedTick: 12000, playerId: 1002, position: 'DC', role: 'Central Defender', duty: 'Defend' }] })

  it('AC lane shot totals sum to the team shots with locations; crosses sum to team crosses; lanes agree across halves', async () => {
    const { input } = await make()
    const r = threatQuery(input, 't_home')
    const t = r.threat
    const lane = (l: string) => t.byLane.find((x) => x.lane === l)!
    // shots: left = p1 (-20 flag set) + p2 (+20 flag unset) + p2 (-20 flag unset is RIGHT); goal at p1 x=-5 is centre
    expect(lane('left').shots).toBe(2)
    expect(lane('centre').shots).toBe(2) // blocked p2 x=0 and the goal x=-5 (normalised -5/68.6+.5 = 0.43)
    expect(lane('right').shots).toBe(2) // p1 x=+20 flag set; p2 x=-20 flag unset
    const rs = t.reconciliation.shots
    expect(rs.byLane + rs.withoutLocation).toBe(rs.events)
    expect(rs.byLane).toBe(6)
    expect(rs.counter.value).toBe(6)
    expect(rs.reconciles).toBe(true)
    expect(lane('left').crosses + lane('centre').crosses + lane('right').crosses).toBe(t.reconciliation.crosses.counter.value)
    expect(lane('left').crosses).toBe(1)
    expect(lane('left').crossesCompleted).toBe(1)
    expect(lane('right').crosses).toBe(1) // the p2 cross at x=-25 with flag unset is normalised +25
    expect(lane('right').crossesCompleted).toBe(0)
    // the opponent of the selected team is the attacker
    expect(t.opposition.side).toBe('away')
    expect(t.team.side).toBe('home')
    expect(t.lanes.perspective).toBe('attacking_team')
  })

  it('AC final-third entries use the END point lane; danger-area entries need a start outside and an end inside; throw-ins are excluded', async () => {
    const { input } = await make()
    const t = threatQuery(input, 't_home').threat
    const lane = (l: string) => t.byLane.find((x) => x.lane === l)!
    expect(lane('right').finalThirdEntries).toBe(1) // x=+15 flag set, 10 -> 25
    expect(lane('right').dangerAreaEntries).toBe(0)
    // the pass 20 -> 40 (end lateral -3) and the completed cross 30 -> 42 (end lateral -5) both end in the centre lane; the pass 38 -> 44 started inside
    expect(lane('centre').dangerAreaEntries).toBe(2)
    expect(lane('left').dangerAreaEntries).toBe(0)
    expect(t.reconciliation.passesCompleted.byLane).toBe(3) // throw-in excluded (counter scope)
  })

  it('AC away-team case: the same events seen from the other team make the home side the attacker, with the same lane meaning in both halves', async () => {
    seq = 0
    const e = [
      shot('home', 1, 1000, 1009, 20, -40), // home attacks -y in p1 (flag unset); normalised lateral = -x = -20 -> left
      shot('home', 2, 13000, 1009, -20, 40), // home attacks +y in p2 (flag set); normalised lateral = x = -20 -> left
      shot('home', 2, 15000, 1009, 20, 40), // normalised +20 -> right
      ev({ period: 1, tick: 6000, type: 31, team: 'away', playerId: 2002, lateral: 20, longitudinal: -20 }), // away defender, absolute x=+20: home p1 normalised -20 = left lane
    ]
    const { input } = await build(e)
    const t = threatQuery(input, 't_away').threat
    expect(t.opposition.side).toBe('home')
    expect(t.byLane.map((l) => l.shots)).toEqual([2, 0, 1])
    expect(t.byLane.map((l) => l.defendingTeamFlank)).toEqual(['right', 'centre', 'left'])
    expect(t.defensiveInvolvement.team.lanes).toEqual({ left: 1, centre: 0, right: 0, unknown: 0 })
    // and an unknown team id is a domain error, not an empty result
    expect(() => threatQuery(input, 't_nope')).toThrowError(/Team does not belong/)
  })

  it('AC per-shot xG is attributed only when one shot accounts for a counter step, and lane xG plus the remainder reconcile to the team xG', async () => {
    seq = 0
    const e = [
      shot('away', 1, 1000, 2009, -20, 40), // 0.10 left
      shot('away', 1, 3000, 2009, 20, 40), // 0.25 right
      shot('away', 1, 5000, 2008, 0, 40), shot('away', 1, 5010, 2008, 0, 42), // two shots between two frames: not attributable
    ]
    const ids = e.map((x) => x.sequenceIndex)
    const { input } = await build(e, { xg: [[ids[0]!, 0.1], [ids[1]!, 0.25], [ids[2]!, 0.05], [ids[3]!, 0.07]] })
    const t = threatQuery(input, 't_home').threat
    const xg = t.reconciliation.xg
    expect(xg.attributedShots).toBe(2)
    expect(xg.unattributedShots).toBe(2)
    expect(t.byLane[0]!.xg).toMatchObject({ attributedShots: 1, unattributedShots: 0 })
    expect(t.byLane[0]!.xg.value).toBeCloseTo(0.1, 6)
    expect(t.byLane[2]!.xg.value).toBeCloseTo(0.25, 6)
    expect(t.byLane[1]!.xg).toMatchObject({ attributedShots: 0, unattributedShots: 2 })
    expect(xg.teamCounter.value).toBeCloseTo(0.47, 5)
    expect(xg.notAttributedToLanes!).toBeCloseTo(0.12, 5) // remainder = team xG minus the attributed sum, never allocated
    expect(xg.attributedToLanes + xg.notAttributedToLanes!).toBeCloseTo(xg.teamCounter.value!, 6)
  })

  it('AC defender involvement uses only verified event types, mirrored lanes, and counts a substituted-off player only while on the pitch', async () => {
    const { input } = await make()
    const t = threatQuery(input, 't_home').threat
    const inv = t.defensiveInvolvement
    const byId = new Map(inv.players.map((p) => [p.playerId, p]))
    // 1002: interception at p1 x=+20 -> mirrored right; interception at p2 x=-20 -> right; clearance ignored
    const p1002 = byId.get('p_1002')!
    expect(p1002.involvement.kinds.interception).toBe(2)
    expect(p1002.involvement.lanes).toEqual({ left: 0, centre: 0, right: 2, unknown: 0 })
    expect(p1002.involvement.total).toBe(2)
    expect(Object.keys(p1002.involvement.kinds).sort()).toEqual(['aerial_lost', 'aerial_won', 'interception', 'tackle_lost', 'tackle_won'])
    const p1003 = byId.get('p_1003')!
    expect(p1003.involvement.kinds).toMatchObject({ tackle_won: 1, tackle_lost: 1 })
    // won at x=-20 in period 1: home attacks -y, own normalised lateral +20, mirrored to the attackers frame = left; lost at x=0 = centre
    expect(p1003.involvement.lanes).toEqual({ left: 1, centre: 1, right: 0, unknown: 0 })
    // substitution at tick 14000: 1010 counts only the p1 event, 1011 only the p2 event; the others are reported, not attributed
    expect(byId.get('p_1010')!.involvement.total).toBe(1)
    expect(byId.get('p_1011')!.involvement.total).toBe(1)
    expect(inv.eventsOutsideParticipation).toBe(2)
    expect(t.unavailable.map((u) => u.id)).toContain('defender_clearances')
    expect(t.unavailable.find((u) => u.id === 'defender_clearances')).toMatchObject({ reason: 'unverified_semantics' })
    expect(JSON.stringify(inv)).not.toContain('clearance')
    // the roles are distinct fields and the unrecorded half is null
    expect(p1002.roles.inPossession).toMatchObject({ role: 'Central Defender', duty: 'Defend' })
    expect(Object.keys(p1002.roles)).toEqual(expect.arrayContaining(['inPossession', 'outOfPossession']))
  })

  it('AC the opposition goal is listed with lane, tick and the event players, labelled context only, with no attribution to a defender', async () => {
    const { input } = await make()
    const t = threatQuery(input, 't_home').threat
    expect(t.goals.label).toBe('context_only')
    expect(t.goals.items).toHaveLength(1)
    const g = t.goals.items[0]!
    expect(g).toMatchObject({ tick: 10000, lane: 'centre' })
    expect(g.involvedInEvent.map((p) => p.playerId)).toEqual(['p_2009'])
    expect(g.involvedInEvent.every((p) => p.roleInEvent === 'event_actor' || p.roleInEvent === 'event_receiver')).toBe(true)
    const text = JSON.stringify(t.goals)
    for (let i = 1000; i < 1014; i++) expect(text).not.toContain(`p_${i}`)
    expect(t.goals.statement).toMatch(/no goal is attributed to any player/)
    expect(t.reconciliation.goals).toMatchObject({ events: 1, counter: { value: 1 } })
  })

  it('AC a window restricts every count; the recording is never clipped and a reversed window is rejected', async () => {
    const { input } = await make()
    const p1 = threatQuery(input, 't_home', { window: { to: { period: 1, tick: 11042, sequence: 0 } } }).threat
    const p2 = threatQuery(input, 't_home', { window: { from: { period: 2, tick: 11124, sequence: 0 } } }).threat
    const all = threatQuery(input, 't_home').threat
    expect(p1.reconciliation.shots.events + p2.reconciliation.shots.events).toBe(all.reconciliation.shots.events)
    for (const l of [0, 1, 2]) expect(p1.byLane[l]!.shots + p2.byLane[l]!.shots).toBe(all.byLane[l]!.shots)
    expect(() => threatQuery(input, 't_home', { window: { from: { period: 2, tick: 99999, sequence: 0 } } })).toThrowError(/outside the recording/)
  })

  it('AC generated text contains counts and labels only: no causal language, no blame, no recommendation', async () => {
    const { input } = await make()
    const r = threatQuery(input, 't_home')
    const text = [...r.threat.statements, r.threat.goals.statement, r.threat.defensiveInvolvement.note, ...r.threat.unavailable.map((u) => u.note), renderThreat(r), renderThreat(r, { markdown: true })].join('\n')
    expect(text.match(BANNED)?.[0] ?? null).toBeNull()
    expect(JSON.stringify(r.threat.lanes)).not.toMatch(/\b(because|caused|due to|led to)\b/i)
  })

  it('AC no aggregate threat score is invented: the result has per-lane counts and no score field', async () => {
    const { input } = await make()
    const r = threatQuery(input, 't_home')
    expect(JSON.stringify(r)).not.toMatch(/threatScore|threat_score|dangerScore|"score"/i)
    expect(Object.keys(r.threat.byLane[0]!).sort()).toEqual(['crosses', 'crossesCompleted', 'dangerAreaEntries', 'defendingTeamFlank', 'defensiveEventsMirrored', 'finalThirdEntries', 'lane', 'passesCompleted', 'shots', 'xg'])
  })
})

describe('Slice 3b ratings without model data', () => {
  it('AC missing rating model data returns a null estimate with a reason; the native rating stays and nothing precise-looking is shown', async () => {
    seq = 0
    const { input } = await build([])
    const p = playerQuery(input, 'p_1003')
    const r = p.player.rating
    expect(r.native).toMatchObject({ label: 'observed' })
    expect(r.native.value).toBeCloseTo(6.7, 5)
    expect(r.estimate).toBeNull()
    expect(r.nullReason).toBe('not_recorded')
    expect(r.reason).toBe('rating_model_missing')
    expect(r.statement).toMatch(/not the final match rating/)
    expect(r.model).toMatchObject({ id: 'fmmatchlens_rating_reconstruction', version: 'fmmatchlens-v0.7.0-ratingCalculator' })
    expect(r.limitations.join(' ')).toMatch(/not official Sports Interactive data/)
    const text = renderPlayer(p)
    expect(text).toContain('Estimated breakdown: n/a (not_recorded: rating_model_missing)')
    expect(text).not.toMatch(BANNED)
    // never states that the game uses a weight
    expect(r.limitations.join(' ')).toMatch(/no result here states that it does/)
  })
})
