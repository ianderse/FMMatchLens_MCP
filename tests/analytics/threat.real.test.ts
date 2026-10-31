// Slice 3b goldens on the real recording (Farnham 0-3 Torquay, captured to 87.6 min). Reads tests/fixtures/local/ (gitignored)
// and reports a skip when the file is absent.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { baseCompletion, deriveResult } from '@fmmi/model'
import type { DecodedRecording } from '@fmmi/model'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { parseArchiveFile } from '../../packages/fmlens-adapter/src/upstream/archiveParser.ts'
import type { RealtimeFrame } from '../../packages/fmlens-adapter/src/upstream/realtimeTypes.ts'
import { playerQuery, renderPlayer, renderThreat, threatQuery } from '@fmmi/analytics'
import type { AnalysisInput } from '@fmmi/analytics'
import { HAS_REAL, REAL_FIXTURE } from '../support/helpers.ts'

const BANNED = /\b(because|caused|causes|due to|therefore|hypothes\w*|recommend\w*|should|suggest\w*|consider|try|expect\w* to|explains?|led to|result of|responsible|fault|blame\w*|exploit\w*|failed to)\b/i

describe.skipIf(!HAS_REAL)('Slice 3b on the real recording', () => {
  let d: DecodedRecording
  let input: AnalysisInput
  let last: RealtimeFrame
  const pid = (up: number) => `p_${up}`
  beforeAll(async () => {
    const bytes = readFileSync(REAL_FIXTURE)
    d = await new FmlensV28Decoder().decode(bytes)
    await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'a.fmlens', { onFrame: (f) => { last = f } })
    const completion = baseCompletion()
    input = {
      decoded: d,
      ids: { matchId: 'm_real', saveId: 's_real', recordingRevisionId: 'r_real', teamIds: { home: 't_home', away: 't_away' }, playerIds: new Map(d.recording.roster.map((p) => [p.upstreamPlayerId, pid(p.upstreamPlayerId)] as const)) },
      completion, result: deriveResult(d.recording.observedScore, completion),
    }
  }, 120_000)

  it('AC lane shot totals sum to the team shots with locations (both teams), with no shot left out', () => {
    for (const [team, opp, shots] of [['t_home', 'away', 12], ['t_away', 'home', 6]] as const) {
      const t = threatQuery(input, team).threat
      expect(t.opposition.side).toBe(opp)
      const rs = t.reconciliation.shots
      expect(rs.byLane).toBe(shots)
      expect(rs.withoutLocation).toBe(0)
      expect(rs.counter.value).toBe(shots)
      expect(t.byLane.reduce((a, l) => a + l.shots, 0)).toBe(shots)
      expect(rs.reconciles).toBe(true)
    }
  })

  it('AC lane cross totals sum to the team crosses, and completed passes reconcile to the counter scope', () => {
    const away = threatQuery(input, 't_home').threat
    expect(away.byLane.reduce((a, l) => a + l.crosses, 0)).toBe(44)
    expect(away.byLane.reduce((a, l) => a + l.crossesCompleted, 0)).toBe(8)
    expect(away.byLane.reduce((a, l) => a + l.passesCompleted, 0)).toBe(471)
    const home = threatQuery(input, 't_away').threat
    expect(home.byLane.reduce((a, l) => a + l.crosses, 0)).toBe(25)
    expect(home.byLane.reduce((a, l) => a + l.crossesCompleted, 0)).toBe(2)
    expect(home.byLane.reduce((a, l) => a + l.passesCompleted, 0)).toBe(523)
    expect(away.reconciliation.crosses.reconciles).toBe(true)
    expect(away.reconciliation.passesCompleted.reconciles).toBe(true)
  })

  it('AC lane mirroring across halves: an independent recomputation from absolute coordinates and the direction flag gives the same lane counts, and both halves contribute', () => {
    const half = d.recording.pitch!.halfWidthM
    for (const [team, side] of [['t_home', 'away'], ['t_away', 'home']] as const) {
      const t = threatQuery(input, team).threat
      const counts: Record<string, number> = { left: 0, centre: 0, right: 0 }
      const perPeriod: Record<number, number> = { 1: 0, 2: 0 }
      for (const e of d.events.filter((x) => x.side === side && (x.kind === 'cross_completed' || x.kind === 'cross_incomplete'))) {
        // flag 0x100 set = the team attacks toward +y; from that attacker's view lateral = x when set, -x when unset
        const attackerLateral = (e.flags & 0x100) !== 0 ? e.source.lateralM : -e.source.lateralM
        const u = (attackerLateral + half) / (2 * half)
        counts[u < 1 / 3 ? 'left' : u < 2 / 3 ? 'centre' : 'right']!++
        perPeriod[e.period!]!++
      }
      expect(t.byLane.map((l) => l.crosses)).toEqual([counts.left, counts.centre, counts.right])
      expect(perPeriod[1]).toBeGreaterThan(0)
      expect(perPeriod[2]).toBeGreaterThan(0)
    }
    // the same physical flank is attacked from opposite directions in the two halves: period-by-period windows keep the lane meaning
    const p1 = threatQuery(input, 't_home', { window: { to: { period: 1, tick: 11042, sequence: 0 } } }).threat
    const p2 = threatQuery(input, 't_home', { window: { from: { period: 2, tick: 11124, sequence: 0 } } }).threat
    const all = threatQuery(input, 't_home').threat
    for (let i = 0; i < 3; i++) {
      expect(p1.byLane[i]!.crosses + p2.byLane[i]!.crosses).toBe(all.byLane[i]!.crosses)
      expect(p1.byLane[i]!.passesCompleted + p2.byLane[i]!.passesCompleted).toBe(all.byLane[i]!.passesCompleted)
    }
  })

  it('AC handedness is verified from the data, not assumed: left-sided positions sit in the low lanes from the attacking view, right-sided in the high lanes', () => {
    const mean = (pos: RegExp) => {
      const ids = new Set(d.recording.roster.filter((p) => pos.test(p.position ?? '')).map((p) => p.upstreamPlayerId))
      const us = d.events.filter((e) => ids.has(e.playerId) && (e.kind === 'pass_completed' || e.kind === 'pass_incomplete')).map((e) => e.normalised.lateralUnit!)
      return us.reduce((a, b) => a + b, 0) / us.length
    }
    expect(mean(/^(DL|WBL|AML|ML)$/)).toBeLessThan(0.25)
    expect(mean(/^(DR|WBR|AMR|MR)$/)).toBeGreaterThan(0.6)
  })

  it('AC the three Torquay goals are listed with lane, tick and the event players, as context only, with no attribution to a Farnham player', () => {
    const t = threatQuery(input, 't_home').threat
    expect(t.goals.label).toBe('context_only')
    expect(t.goals.items.map((g) => g.tick)).toEqual([10031, 19059, 20520])
    for (const g of t.goals.items as unknown as Array<{ lane: string | null; defendingTeamFlank: string | null; involvedInEvent: Array<{ playerId: string; side: string }>; displayMinute: number }>) {
      expect(g.lane).not.toBeNull()
      expect(g.involvedInEvent.length).toBeGreaterThan(0)
      expect(g.involvedInEvent.every((p) => p.side === 'away')).toBe(true) // only the scorer named in the event, never a home player
    }
    expect((t.goals.items as unknown as Array<{ displayMinute: number }>).map((g) => Math.round(g.displayMinute))).toEqual([42, 78, 84])
    const homeIds = d.recording.roster.filter((p) => p.side === 'home').map((p) => pid(p.upstreamPlayerId))
    const text = JSON.stringify(t.goals)
    for (const id of homeIds) expect(text).not.toContain(id)
    expect(t.goals.statement).toMatch(/no goal is attributed to any player/)
    expect(t.reconciliation.goals).toMatchObject({ events: 3, counter: { value: 3 } })
    // and the other direction: Farnham scored none
    expect(threatQuery(input, 't_away').threat.goals.items).toHaveLength(0)
  })

  it('AC per-shot xG attributes every Torquay shot here, and the lane sum equals the recorded team xG', () => {
    const x = threatQuery(input, 't_home').threat.reconciliation.xg
    expect(x.attributedShots).toBe(12)
    expect(x.unattributedShots).toBe(0)
    expect(x.attributedToLanes).toBeCloseTo(2.217, 3)
    expect(x.teamCounter.value!).toBeCloseTo(x.attributedToLanes, 5)
    expect(Math.abs(x.notAttributedToLanes!)).toBeLessThan(1e-5)
  })

  it('AC defender involvement counts only verified event types, only while the player is on the pitch, and agrees with the events and participation', () => {
    const t = threatQuery(input, 't_home').threat
    const inv = t.defensiveInvolvement
    const home = d.events.filter((e) => e.side === 'home' && ['tackle_won', 'tackle_lost', 'interception', 'aerial_won', 'aerial_lost'].includes(e.kind))
    const onPitch = home.filter((e) => d.recording.roster.find((p) => p.upstreamPlayerId === e.playerId)!.participation.segments.some((s) => s.period === e.period && e.tick >= s.fromTick && e.tick < s.toTick))
    expect(inv.team.total).toBe(onPitch.length)
    expect(inv.team.total + inv.eventsOutsideParticipation + inv.eventsWithoutRosterActor).toBe(home.length)
    expect(inv.team.lanes.left + inv.team.lanes.centre + inv.team.lanes.right + inv.team.lanes.unknown).toBe(inv.team.total)
    for (const k of ['tackle_won', 'tackle_lost', 'interception', 'aerial_won', 'aerial_lost'] as const) expect(inv.team.kinds[k], k).toBe(onPitch.filter((e) => e.kind === k).length)
    // a substituted-off player only appears with his own minutes
    const mason = inv.players.find((p) => p.name === 'Brandon Mason')!
    expect(mason.minutesInWindow).toBeCloseTo(62.4, 1)
    const own = onPitch.filter((e) => e.playerId === d.recording.roster.find((p) => p.name === 'Brandon Mason')!.upstreamPlayerId).length
    expect(mason.involvement.total).toBe(own)
    expect(JSON.stringify(inv)).not.toContain('clearance')
    expect(t.unavailable.find((u) => u.id === 'defender_clearances')).toMatchObject({ reason: 'unverified_semantics' })
    expect(t.unavailable.map((u) => u.id)).toEqual(expect.arrayContaining(['defender_distance_covered', 'defender_sprints', 'defender_condition']))
    // in and out of possession roles are separate fields
    expect(mason.roles.inPossession).not.toBeNull()
    expect(mason.roles.outOfPossession).not.toBeNull()
    expect(mason.roles.inPossession).not.toEqual(mason.roles.outOfPossession)
  })

  it('AC real answer: which flank Torquay attacked, from counts only, with the Farnham flank named and no score', () => {
    const t = threatQuery(input, 't_home').threat
    const by = Object.fromEntries(t.byLane.map((l) => [l.lane, l]))
    // Torquay left lane = Farnham right flank; the left lane has the most crosses, passes, final-third and danger-area entries here
    expect(by.left!.defendingTeamFlank).toBe('right')
    expect(by.left!.crosses).toBeGreaterThan(by.right!.crosses)
    expect(by.left!.finalThirdEntries).toBeGreaterThan(by.right!.finalThirdEntries)
    expect(by.left!.dangerAreaEntries).toBeGreaterThan(by.right!.dangerAreaEntries)
    expect(t.leadingLane).toMatchObject({ label: 'descriptive_counts_only', crosses: 'left', finalThirdEntries: 'tie' })
    console.log('REAL SAMPLE Torquay by lane (attackers view / Farnham flank):', JSON.stringify(t.byLane.map((l) => ({ lane: l.lane, flank: l.defendingTeamFlank, shots: l.shots, crosses: l.crosses, passes: l.passesCompleted, entries: l.finalThirdEntries, box: l.dangerAreaEntries }))))
  })

  it('AC native ratings equal the last-frame values for all 36 players, observed and separate from the estimate', () => {
    expect(last.players).toHaveLength(36)
    for (const p of last.players) {
      const r = playerQuery(input, pid(p.playerId)).player.rating
      expect(r.native.value).toBe(p.rating) // exact: same float
      expect(r.native.label).toBe('observed')
      expect(r.sampledAt).toMatchObject({ period: last.period, tick: last.tick })
      expect(r.statement).toMatch(/rating at the end of capture, not the final match rating/)
      expect(r.statement).toContain(`tick ${last.tick}`)
    }
  })

  it('AC the estimated breakdown is labelled estimated, keeps the residual and model version separate, and equals the upstream calculator output', () => {
    const spong = d.recording.roster.find((p) => p.name === 'Jack Spong')!
    const r = playerQuery(input, pid(spong.upstreamPlayerId)).player.rating
    const e = r.estimate as unknown as { label: string; contributions: Array<{ category: string; postFactor: number }>; predictedInternalScore: number; recordedInternalScore: number; baseline: number; reconstructionResidual: { internalUnits: number; ratingPoints: number } }
    expect(e.label).toBe('estimated')
    expect(e.contributions.map((c) => c.category)).toEqual(['shooting', 'creativity', 'passing', 'defending', 'goalkeeping', 'context'])
    expect(e.baseline).toBe(6700)
    expect(e.reconstructionResidual.internalUnits).toBe(e.recordedInternalScore - e.predictedInternalScore)
    expect(e.reconstructionResidual.ratingPoints).toBeCloseTo(e.reconstructionResidual.internalUnits / 1000, 9)
    // golden values from the upstream calculator on the last frame
    expect(e.recordedInternalScore).toBe(6402)
    expect(e.predictedInternalScore).toBe(6353)
    expect(e.reconstructionResidual.internalUnits).toBe(49)
    expect(Object.fromEntries(e.contributions.map((c) => [c.category, Math.round(c.postFactor)]))).toEqual({ shooting: 0, creativity: 110, passing: 293, defending: -140, goalkeeping: 0, context: -610 })
    expect(r.model).toMatchObject({ id: 'fmmatchlens_rating_reconstruction', version: 'fmmatchlens-v0.7.0-ratingCalculator' })
    expect(r.nullReason).toBeNull()
    expect(r.qualityFlags).toContain('w04_w05_context_formula_unresolved')
    expect(r.limitations.join(' ')).toMatch(/unverified, and no result here states that it does/)
  })

  it('AC a role missing from the upstream weight table, and a player with no playing time, return null with a reason instead of a precise-looking breakdown', () => {
    let unmapped = 0, none = 0, estimated = 0
    for (const p of d.recording.roster) {
      const r = playerQuery(input, pid(p.upstreamPlayerId)).player.rating
      if (r.estimate) { estimated++; expect(r.reason).toBeNull(); continue }
      expect(r.native.value).not.toBeNull() // the observed value stays
      if (r.reason === 'role_or_weight_not_in_upstream_table') { unmapped++; expect(r.nullReason).toBe('unverified_semantics') }
      else if (r.reason === 'no_eligible_playing_time') { none++; expect(r.nullReason).toBe('not_applicable') }
      else throw new Error(`unexpected reason ${r.reason}`)
    }
    expect(estimated + unmapped + none).toBe(36)
    expect(unmapped).toBe(5)
    expect(none).toBe(5)
  })

  it('AC rating and threat text contain facts and labels only: no causal language, no blame, no recommendation', () => {
    const jack = d.recording.roster.find((p) => p.name === 'Jack Spong')!
    const text = [renderPlayer(playerQuery(input, pid(jack.upstreamPlayerId))), renderThreat(threatQuery(input, 't_home')), renderThreat(threatQuery(input, 't_away'), { markdown: true })].join('\n')
    expect(text.match(BANNED)?.[0] ?? null).toBeNull()
  })
})
