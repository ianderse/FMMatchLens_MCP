// Real-recording tests. They read tests/fixtures/local/ (gitignored) and report a skip when the file is absent.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { counterDelta, resolveDisplayMinute, resolveWindow } from '@fmmi/model'
import type { DecodedRecording } from '@fmmi/model'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { HAS_REAL, REAL_FIXTURE } from '../support/helpers.ts'

const golden = JSON.parse(readFileSync(new URL('../fixtures/farnham-torquay-0-3.summary.json', import.meta.url), 'utf8')) as {
  teamFinal: Record<'home' | 'away', Record<string, number>>
  perSlotCounters: Array<{ slot: number; team: string; counter: Record<string, number> }>
  time: { periods: Array<{ period: number; frames: number; firstTick: number; lastTick: number }> }
  events: { uniqueSequenceIndexes: number; typeHist: Record<string, number> }
  substitutions: Array<{ team: string; on: boolean; tick: number }>
}

describe.skipIf(!HAS_REAL)('real FM27 recording (Farnham 0-3 Torquay, 87.6 min)', () => {
  let d: DecodedRecording
  beforeAll(async () => {
    d = await new FmlensV28Decoder().decode(readFileSync(REAL_FIXTURE))
  }, 120_000)
  const player = (name: string) => d.recording.roster.find((p) => p.name === name)!

  it('AC2 golden: names, observed score 0-3, xG 0.416 / 2.217 within source precision', () => {
    const r = d.recording
    expect(r.teams.home.name).toBe('Farnham'); expect(r.teams.away.name).toBe('Torquay')
    expect(r.humanControlledSide).toBe('home')
    expect(r.observedScore).toMatchObject({ home: 0, away: 3 })
    expect(r.observedScore.at.displayMinute).toBeCloseTo(87.62, 2)
    // xG is float32 at source (about 7 significant digits); the displayed 3-decimal values must agree
    expect(r.teamTotals.home.xg).toBeCloseTo(0.416, 3)
    expect(r.teamTotals.away.xg).toBeCloseTo(2.217, 3)
    expect(r.teamTotals.home.xg).toBeCloseTo(golden.teamFinal.home.xg!, 6)
    expect(r.teamTotals.away.xg).toBeCloseTo(golden.teamFinal.away.xg!, 6)
  })

  it('AC2 golden: every team counter at the end of the recording equals the audited summary', () => {
    for (const side of ['home', 'away'] as const) {
      for (const [k, v] of Object.entries(golden.teamFinal[side])) {
        expect(d.recording.teamTotals[side][k], `${side}.${k}`).toBeCloseTo(v, 6)
      }
    }
  })

  it('AC2 golden: 36 players, 31 participants, 5 unused substitutes, identities (uid == playerId in this file)', () => {
    const r = d.recording
    expect(r.roster).toHaveLength(36)
    expect(r.roster.filter((p) => p.participation.status === 'played')).toHaveLength(31)
    expect(r.roster.filter((p) => p.participation.status === 'unused_substitute')).toHaveLength(5)
    expect(r.roster.every((p) => p.uid === p.upstreamPlayerId)).toBe(true)
    expect(new Set(r.roster.map((p) => p.upstreamPlayerId)).size).toBe(36)
  })

  it('AC2 golden: player counters at the end equal the audited per-slot counters for all 36 players, including substituted-off players', () => {
    for (const g of golden.perSlotCounters) {
      const p = d.recording.roster.find((x) => x.slot === g.slot)!
      for (const [k, v] of Object.entries(g.counter)) {
        expect(p.counters[k] ?? 0, `slot ${g.slot} ${k}`).toBeCloseTo(v, 6)
      }
    }
    expect(player('Rakish Bingham').counters).toMatchObject({ aerials: 9, aerialsWon: 3, passes: 12 })
    expect(player('George Alexander').counters).toMatchObject({ aerials: 2, aerialsWon: 0, passes: 7, passesCompleted: 7, shots: 2 })
  })

  it('AC3 Bingham (departing) and Alexander (incoming) are in their correct played windows', () => {
    const subTick = golden.substitutions.find((s) => s.team === 'home' && !s.on && s.tick === 13700)!.tick
    const b = player('Rakish Bingham'), a = player('George Alexander')
    expect(b.participation.enteredAs).toBe('starter')
    expect(b.participation.lastOff).toEqual({ period: 2, tick: subTick, sequence: 0 })
    expect(b.participation.segments.map((s) => [s.period, s.fromTick, s.toTick])).toEqual([[1, 3, 11041], [2, 11124, subTick]])
    expect(b.participation.elapsedMinutes).toBeCloseTo(56.73, 2)
    expect(a.participation.enteredAs).toBe('substitute')
    expect(a.participation.firstOn).toEqual({ period: 2, tick: subTick, sequence: 0 })
    expect(a.participation.onPitchAtEndOfRecording).toBe(true)
    expect(a.participation.elapsedMinutes).toBeCloseTo(31.88, 2)
    // the two windows meet at the flip tick; neither overlaps the other
    expect(b.participation.segments.at(-1)!.toTick).toBe(a.participation.segments[0]!.fromTick)
    expect(player('Mat Mackenzie').participation.elapsedMinutes).toBeCloseTo(42.61, 2)
    expect(player('Tyler Hill').participation.elapsedMinutes).toBeCloseTo(2.01, 2)
    expect(player('Jake Dennis').participation.elapsedMinutes).toBeCloseTo(88.6, 2) // halftime excluded
  })

  it('same-tick batches are reported without off/on pairing', () => {
    const home = d.recording.substitutionBatches.find((b) => b.side === 'home' && b.tick === 15062)!
    expect(home.off).toHaveLength(2); expect(home.on).toHaveLength(2); expect(home.pairing).toBe('not_recorded')
    const away = d.recording.substitutionBatches.find((b) => b.side === 'away' && b.tick === 15800)!
    expect(away.off).toHaveLength(2); expect(away.on).toHaveLength(2)
  })

  it('time: periods as audited, 240 ticks = 1 game minute, ticks have gaps but none over the tolerance', () => {
    const c = d.recording.coverage
    for (const gp of golden.time.periods) {
      expect(c.periods.find((p) => p.period === gp.period)).toMatchObject({ frames: gp.frames, firstTick: gp.firstTick, lastTick: gp.lastTick })
    }
    expect(c.gaps.largestGapTicks).toBe(127)
    expect(c.gaps.countOverTolerance).toBe(0)
    expect(c.gaps.samplingGapCount).toBeGreaterThan(700)
    expect(d.recording.frameCount).toBe(15768)
    expect(d.recording.metadataRevisions).toBe(12)
  })

  it('AC7 clean close is file integrity only: valid and closed, yet capture is partial (ends at 87.6) with completion left to confirmation', () => {
    const r = d.recording
    expect(r.integrity).toMatchObject({ status: 'valid', cleanClose: true })
    expect(r.coverage.status).toBe('partial')
    expect(r.coverage.reasons).toEqual(['recording_ends_before_regulation_end'])
    expect(r.coverage.initialBaseline).toBe('zero_verified')
    expect(r.coverage.endCaptureEndsAt).toMatchObject({ period: 2, tick: 21351 })
    expect(r.coverage.endCaptureEndsAt!.displayMinute).toBeCloseTo(87.62, 2)
  })

  it('events: 1892 distinct merged by sequenceIndex, 9 revised, last version kept', () => {
    expect(d.events).toHaveLength(golden.events.uniqueSequenceIndexes)
    expect(d.recording.eventSummary.withRevisions).toBe(9)
    expect(d.recording.eventSummary.byKind.pass_completed).toBe(golden.events.typeHist['7'])
    expect(d.recording.eventSummary.byKind.goal).toBe(3)
  })

  it('passes: every completed pass has a receiver, incomplete passes have none (null with reason), no on-pitch filtering', () => {
    const completed = d.events.filter((e) => e.kind === 'pass_completed')
    const incomplete = d.events.filter((e) => e.kind === 'pass_incomplete')
    expect(completed).toHaveLength(1013)
    expect(completed.every((e) => e.receiverPlayerId !== null)).toBe(true)
    expect(incomplete).toHaveLength(145)
    expect(incomplete.every((e) => e.receiverPlayerId === null && e.receiverNullReason === 'not_recorded')).toBe(true)
    // counter scope = all passes except throw-ins (exact reconciliation measured in Slice 0)
    for (const side of ['home', 'away'] as const) {
      const passes = d.events.filter((e) => e.side === side && (e.kind === 'pass_completed' || e.kind === 'pass_incomplete') && !e.throwIn)
      expect(passes.length).toBe(d.recording.teamTotals[side].passes)
      expect(passes.filter((e) => e.kind === 'pass_completed').length).toBe(d.recording.teamTotals[side].passesCompleted)
    }
    // links involving players who are no longer on the pitch at the end of the recording are kept
    const offAtEnd = new Set(d.recording.roster.filter((p) => !p.participation.onPitchAtEndOfRecording).map((p) => p.upstreamPlayerId))
    expect(completed.filter((e) => offAtEnd.has(e.playerId) || offAtEnd.has(e.receiverPlayerId!)).length).toBeGreaterThan(100)
  })

  it('coordinates: raw metres retained (out-of-pitch values not clamped), attack normalisation uses flag 0x100', () => {
    const lateral = d.events.map((e) => e.source.lateralM)
    expect(Math.max(...lateral)).toBeGreaterThan(34.3125) // beyond the touchline, kept as recorded
    for (const e of d.events.filter((x) => x.kind === 'pass_completed')) {
      expect(e.normalised.forwardM).toBe((e.flags & 0x100) !== 0 ? e.source.longitudinalM : -e.source.longitudinalM)
    }
  })

  it('windows on the decoded series: halftime split reconciles to the total with exact boundaries', () => {
    const sc = d.sampled
    const half = { period: 2, tick: 11124, sequence: 0 }
    const k = 'team.home.passes'
    const a = counterDelta(sc, k, resolveWindow(sc.frames, { to: half }))
    const b = counterDelta(sc, k, resolveWindow(sc.frames, { from: half }))
    const t = counterDelta(sc, k, resolveWindow(sc.frames, {}))
    expect(a.value).toBe(285) // measured at the end of period 1 (docs/data-coverage.md section 8)
    expect(a.value! + b.value!).toBe(594)
    expect(t.value).toBe(594)
    expect(t.coverage).toBe('complete_for_window')
    expect(t.from.source).toBe('verified_zero_baseline')
    expect(() => resolveDisplayMinute(sc.frames, 45.5)).toThrowError(/more than one period/)
    expect(resolveDisplayMinute(sc.frames, 60).period).toBe(2)
    // minute 0 is the kick-off even though the first frame's display tick is 2: it resolves to the recording start in period 1
    expect(resolveDisplayMinute(sc.frames, 0)).toEqual({ period: 1, tick: 0, sequence: 0 })
    expect(() => resolveDisplayMinute(sc.frames, 0, 2)).toThrowError(/outside the period/)
    expect(() => resolveDisplayMinute(sc.frames, 120)).toThrowError(/outside the recording/)
  })
})
