// Readable game minutes beside the canonical <period>:<tick> fields. The minute is read from the recorded frame display ticks, NEVER from
// tick / 240: the tick to display-tick offset differs per period and per recording (323 and 564 in period 2 of the two real recordings) and
// display ticks restart at 45:00 in period 2. Synthetic unit tests first, then a real-data test on the Hemel recording (skips without fixtures).
import { afterAll, describe, expect, it } from 'vitest'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { FrameIndex, gameClockAt, gameClockFromPeriods, minuteLabel } from '@fmmi/model'
import { MatchQueries } from '@fmmi/query'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { readFileSync } from 'node:fs'
import { HAS_REAL_PAIR, REAL_FIXTURE_HEMEL, cleanupAll, service } from '../support/helpers.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

/** Period 1 from tick 3 (display = tick - 1) to 11282; period 2 from 11365 with display ticks restarting at 45:00 (offset `p2`). */
function frames(p2: number, step = 7): FrameIndex {
  const fi = new FrameIndex()
  let seq = 0
  for (let t = 3; t <= 11282; t += step) fi.push(1, t, seq++, t - 1)
  for (let t = 11365; t <= 23130; t += step) fi.push(2, t, seq++, t - p2)
  return fi
}

describe('game clock (synthetic frames)', () => {
  it('reads the minute from the display ticks of the period: the same tick has different minutes under offsets 323 and 564, and neither is tick / 240', () => {
    const a = gameClockAt(frames(564), 14136), b = gameClockAt(frames(323), 14136)
    expect(a.minute).toBeCloseTo((14136 - 564) / 240, 1) // 56.55
    expect(b.minute).toBeCloseTo((14136 - 323) / 240, 1) // 57.55
    expect(a.minute).not.toBeCloseTo(14136 / 240, 0) // 58.9: the trap
    expect(a.period).toBe(2)
    expect(gameClockAt(frames(564), 9776).minute).toBeCloseTo(40.73, 1) // period 1: offset 1
  })
  it('start of match for tick -1, half-time in the gap between periods, nothing after the end of capture, and a period given explicitly is honoured', () => {
    const fi = frames(564)
    expect(gameClockAt(fi, -1)).toEqual({ minute: 0, label: 'start of match', period: 1 })
    expect(gameClockAt(fi, 11320)).toMatchObject({ minute: null, label: 'half-time', period: null })
    expect(gameClockAt(fi, 99999)).toMatchObject({ minute: null, label: 'after the end of capture' })
    expect(gameClockAt(fi, 11374, 2).minute).toBeCloseTo(45.04, 1)
    expect(gameClockAt(fi, 11374).label).toBe("45'")
  })
  it("labels are whole elapsed minutes with stoppage as 45+n' and 90+n'", () => {
    expect(minuteLabel(40.73, 1)).toBe("40'")
    expect(minuteLabel(45.4, 1)).toBe("45'")
    expect(minuteLabel(47.0, 1)).toBe("45+2'")
    expect(minuteLabel(45.04, 2)).toBe("45'")
    expect(minuteLabel(90.9, 2)).toBe("90'")
    expect(minuteLabel(93.2, 2)).toBe("90+3'")
    expect(minuteLabel(0.01, 1)).toBe("0'")
  })
  it('the period-based clock (used where there are no frames) agrees with the frame clock when the offset is constant, and is unknown rather than guessed when it is not', () => {
    const periods = [
      { period: 1, frames: 1, firstTick: 3, lastTick: 11282, firstDisplayTick: 2, lastDisplayTick: 11281 },
      { period: 2, frames: 1, firstTick: 11365, lastTick: 23130, firstDisplayTick: 10801, lastDisplayTick: 22566 },
    ]
    for (const t of [9776, 11374, 14136, 18404]) expect(gameClockFromPeriods(periods, t).minute).toBeCloseTo(gameClockAt(frames(564), t).minute!, 1)
    expect(gameClockFromPeriods(periods, -1).label).toBe('start of match')
    const drifting = [periods[0]!, { ...periods[1]!, lastDisplayTick: 22000 }]
    expect(gameClockFromPeriods(drifting, 14136)).toMatchObject({ minute: null, label: 'unknown' })
  })
})

const cli = (home: string) => async (...args: string[]) => {
  const out: string[] = [], err: string[] = []
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
  const code = await main(args, io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe.skipIf(!HAS_REAL_PAIR)('game minutes on the real Hemel recording (golden: George Alexander)', () => {
  it('role changes at captured ticks 9776, 11374 and 14136 are about 40.7, just after half-time and about 56.6; he goes off at tick 18404, about 74.3; computed from the frames, shown beside the canonical fields in every presentation', async () => {
    // The independent route: the display tick of the frame at the tick, read straight from the decoded frames.
    const d = await new FmlensV28Decoder().decode(readFileSync(REAL_FIXTURE_HEMEL))
    const fi = d.sampled.frames
    const displayAt = (tick: number) => { for (let i = 0; i < fi.length; i++) if (fi.ticks[i]! >= tick) return fi.displayTicks[i]! / 240; throw new Error('past the end') }
    expect(Math.abs(displayAt(9776) - 40.7)).toBeLessThan(0.1)
    expect(displayAt(11374)).toBeGreaterThan(45); expect(displayAt(11374)).toBeLessThan(45.2)
    expect(Math.abs(displayAt(14136) - 56.6)).toBeLessThan(0.1)
    expect(Math.abs(displayAt(18404) - 74.3)).toBeLessThan(0.1)

    const svc = service()
    const saveId = svc.createSave('S').saveId
    const imp = await svc.ingestFile(REAL_FIXTURE_HEMEL, saveId)
    const q = new MatchQueries(svc)
    const roster = (await q.summary(imp.matchId!)).summary.roster.players as Json[]
    const alexander = roster.find((p) => p.name === 'George Alexander')!
    expect(alexander).toMatchObject({ onAt: '1:3', offAt: '2:18404' }) // canonical fields are kept
    expect(alexander.offAtMinute).toBeCloseTo(74.33, 1)
    expect(alexander.onAtMinute).toBeLessThan(0.1)

    const pm = ((await q.player(imp.matchId!, alexander.playerId)) as Json).player
    const rt = pm.roleTimeline as Json[]
    expect(rt.map((r) => r.capturedTick)).toEqual([-1, 9776, 11374, 14136, 18408])
    expect(rt[0]).toMatchObject({ gameMinute: 0, gameLabel: 'start of match' }) // not "tick -1"
    expect(rt[1].gameMinute).toBeCloseTo(40.73, 1)
    expect(rt[2].gameMinute).toBeGreaterThan(45); expect(rt[2].gameMinute).toBeLessThan(45.2)
    expect(rt[3].gameMinute).toBeCloseTo(56.55, 1)
    expect(rt[3].gameMinute).not.toBeCloseTo(14136 / 240, 0) // never tick / 240
    expect(rt[1].gameLabel).toBe("40'")
    expect(rt[3].gameLabel).toBe("56'")
    for (const r of rt.slice(1)) expect(r.gameMinute).toBeCloseTo(displayAt(r.capturedTick), 1)
    expect(pm.participation.lastOff).toMatchObject({ period: 2, tick: 18404 })
    expect(pm.participation.lastOffGame.minute).toBeCloseTo(74.33, 1)
    expect(pm.participation.lastOffGame.label).toBe("74'")
    expect(pm.participation.segments[1]).toMatchObject({ period: 2, fromTick: 11365, toTick: 18404 })
    expect(pm.participation.segments[1].toMinute).toBeCloseTo(74.33, 1)

    // the catalog view (no frames) agrees, because the period offset is constant in this recording
    const shown = svc.showMatch(imp.matchId!).roster.find((p) => p.name === 'George Alexander')!
    expect(shown.roleTimeline.map((r) => r.gameMinute)).toEqual(rt.map((r) => r.gameMinute))
    expect(shown.participation.lastOffGame!.minute).toBeCloseTo(74.33, 1)
    svc.close()

    // CLI text shows the readable minute beside the canonical boundary
    const home = svc.config.home
    const run = cli(home)
    const player = await run('player', imp.matchId!, alexander.playerId)
    expect(player.code, player.err).toBe(0)
    expect(player.out).toMatch(/start of match \(captured tick -1\)/)
    expect(player.out).toMatch(/56' \(captured tick 14136\)/)
    expect(player.out).toMatch(/p2 11365-18404 \(45(\.0\d)? to 74\.3\d min\)/)
    const summary = await run('summary', imp.matchId!)
    expect(summary.out).toMatch(/off 74\.33' \(2:18404\)/)
    const show = await run('show', imp.matchId!)
    expect(show.out).toMatch(/off 74' \(p2 t18404\)/)
  }, 240_000)
})
