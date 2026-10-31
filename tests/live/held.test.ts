// The `held` state and the bounded catch-up (docs/data-coverage.md section 10, observed at a real half-time on 2026-10-31): the plugin keeps
// answering with the same last frame while the game is paused, so frames stop and `capturedUnixMilliseconds` ages. All tests rest on the
// MODELLED fake plugin; the real plugin was seen to behave this way once. Also: null role assignments for substitutes (seen on the real plugin).
import { afterAll, describe, expect, it } from 'vitest'
import { liveMatch, livePlayer, liveTacticalEvents } from '@fmmi/live'
import { cleanupAll } from '../support/helpers.ts'
import { rig, syntheticReplay } from '../support/live.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Index (exclusive) of the last frame of period 1: the replay is then at a halftime-like snapshot. */
const endOfFirstHalf = (frames: Array<{ period: number }>) => frames.findIndex((f) => f.period === 2)

describe('[MODELLED] held: the game is paused, nothing newer exists', () => {
  it('a halftime-like pause is held (not stale) and every live tool serves the snapshot with the held label; resume returns to fresh with no duplicate or regression', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advanceTo(endOfFirstHalf(replay.frames))
    expect((await r.reader.refresh()).state).toBe('fresh')
    r.time.now += 20_000 // no new frame for 20 s; inMatch stays true; ticks are frozen
    const v = await r.reader.refresh()
    expect(v.state).toBe('held')
    expect(v.reason).toBe('no_new_frames_game_not_advancing')
    expect(v.snapshot).toMatchObject({ period: 1, lagTicks: 0 })
    expect(v.held).toMatchObject({ gameAdvancing: false, pluginLastTick: v.snapshot!.tick, likelyBreak: { guess: 'half_time', isGuess: true } })
    expect(v.held!.noNewFramesForMs).toBeGreaterThanOrEqual(20_000)
    expect(v.held!.statement).toMatch(/paused, a break, or finished\); the source does not say which/)

    const match = await liveMatch(r.reader)
    expect(match.available).toBe(true)
    expect(match.live.state).toBe('held')
    expect(match.live.snapshot!.label).toMatch(/^live as of game minute [\d.]+ \/ period 1 \/ tick \d+$/)
    expect(match.warnings.some((w) => w.startsWith('live_held:'))).toBe(true)
    const any = (match.summary as Json).summary.roster.players.find((p: Json) => p.status === 'played')
    const player = (await livePlayer(r.reader, { playerId: any.playerId })) as Json
    expect(player.live.state).toBe('held')
    expect(player.player.player.name).toBe(any.name)
    expect((await liveTacticalEvents(r.reader, {})).live.state).toBe('held')

    const before = r.reader.view().counters.framesAccepted
    r.plugin.advance(40) // play resumes
    const resumed = await r.reader.refresh()
    expect(resumed.state).toBe('fresh')
    expect(resumed.held).toBeNull()
    expect(resumed.counters).toMatchObject({ framesAccepted: before + 40, duplicateFrames: 0, outOfOrderFrames: 0, periodRegressions: 0 })
    await r.close()
  }, 60_000)

  it('the verdict does not depend on the socket: closed, and open while it keeps repeating the same frame', async () => {
    const { replay } = await syntheticReplay()
    // socket never opened
    const closed = await rig(replay)
    closed.plugin.advanceTo(endOfFirstHalf(replay.frames))
    await closed.reader.refresh()
    closed.time.now += 20_000
    const a = await closed.reader.refresh()
    expect(a.connection.socket).toBe('never')
    expect(a.state).toBe('held')
    await closed.close()

    // socket open, the plugin repeats the last frame (receive time keeps advancing, capture time does not)
    const open = await rig(replay, { useWebSocket: true, wsMinParseIntervalMs: 0 })
    open.plugin.advanceTo(endOfFirstHalf(replay.frames))
    await open.reader.refresh()
    for (let i = 0; i < 40 && open.reader.view().connection.socket !== 'open'; i++) await wait(25)
    expect(open.reader.view().connection.socket).toBe('open')
    open.time.now += 20_000
    open.plugin.pushTick()
    await wait(60)
    open.plugin.pushTick()
    await wait(60)
    const b = await open.reader.refresh()
    expect(b.connection.socket).toBe('open')
    expect(b.state).toBe('held')
    await open.close()
  }, 60_000)

  it('held becomes not_connected when the plugin goes away, and stale (not held) while the reader is behind the plugin', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advanceTo(endOfFirstHalf(replay.frames))
    await r.reader.refresh()
    r.time.now += 20_000
    expect((await r.reader.refresh()).state).toBe('held')
    await r.plugin.stop()
    r.time.now += 5_000
    const gone = await r.reader.refresh()
    expect(gone.state).toBe('not_connected')
    expect(gone.held).toBeNull()
    r.reader.close()

    // lag above zero: the plugin has frames the reader could not read (the frames route fails), the clock is stopped
    const lag = await rig(replay)
    lag.plugin.advance(100)
    await lag.reader.refresh()
    lag.plugin.advance(50)
    lag.plugin.faults = { status: { '/api/match/frames': 500 } }
    lag.time.now += 20_000
    const v = await lag.reader.refresh()
    expect(v.snapshot!.lagTicks).toBeGreaterThan(0)
    expect(v.state).toBe('stale')
    expect(v.reason).toBe('behind_plugin')
    expect(v.held).toBeNull()
    await expect(livePlayer(lag.reader, { playerId: 'p_000000000000' })).rejects.toMatchObject({ code: 'stale_snapshot' })
    await lag.close()
  }, 60_000)

  it('a second-half or later pause past 90:00 says end of period or full time is possible, as a guess, and never marks the match complete', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advanceTo(replay.frames.length)
    await r.reader.refresh()
    r.time.now += 30_000
    const v = await r.reader.refresh()
    expect(v.state).toBe('held')
    const m = await liveMatch(r.reader)
    expect(JSON.stringify(m)).not.toMatch(/"status":"completed"/)
    expect(m.live.held!.likelyBreak.isGuess).toBe(true)
    if (v.snapshot!.displayMinute >= 90) expect(m.live.held!.likelyBreak.guess).toBe('end_of_period_or_full_time')
    expect((m.summary as Json).capture.completion).not.toBe('completed')
    await r.close()
  }, 60_000)
})

describe('[MODELLED] bounded catch-up', () => {
  it('a call after a long gap waits (through the governor) until caught up, within the budget; when the budget is too small it answers stale with catchingUp, and the next call finishes', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay, { pageSize: 50, maxPagesPerSync: 3 })
    r.plugin.advanceTo(replay.frames.length)
    const t0 = r.time.now
    const v = await r.reader.refresh()
    expect(v.state).toBe('fresh')
    expect(v.catchingUp).toBe(false)
    expect(v.snapshot!.lagTicks).toBe(0)
    expect(v.counters.framesAccepted).toBe(replay.frames.length)
    expect(r.time.now - t0).toBeLessThan(8000)
    await r.close()

    const tight = await rig(replay, { pageSize: 25, maxPagesPerSync: 2, catchUpBudgetMs: 1000 })
    tight.plugin.advanceTo(replay.frames.length)
    const a = await tight.reader.refresh()
    expect(a.state).toBe('stale')
    expect(a.reason).toBe('catching_up')
    expect(a.catchingUp).toBe(true)
    let n = 0
    let b = a
    while (b.catchingUp && n++ < 20) b = await tight.reader.refresh()
    expect(b.state).toBe('fresh')
    expect(b.counters).toMatchObject({ framesAccepted: replay.frames.length, duplicateFrames: 0, outOfOrderFrames: 0 })
    await tight.close()
  }, 120_000)

  it('MEASURE: catching up from zero on a full-match frame count, with the 4 requests/s governor (virtual time, so the number is the governor wait, not machine speed)', async () => {
    const { replay } = await syntheticReplay({}, { periods: [
      { period: 1, fromTick: 3, toTick: 11282, step: 1, displayOffset: 1 },
      { period: 2, fromTick: 11365, toTick: 23130, step: 1, displayOffset: 564 },
    ] })
    expect(replay.frames.length).toBeGreaterThan(16_000)
    const r = await rig(replay)
    r.plugin.advanceTo(replay.frames.length)
    const t0 = r.time.now
    const reqs0 = r.client.requestsSent
    const first = await r.reader.refresh()
    const firstMs = r.time.now - t0
    let calls = 1
    let v = first
    let totalMs = firstMs
    while (v.state !== 'fresh' && calls < 5) { const t1 = r.time.now; v = await r.reader.refresh(); totalMs += r.time.now - t1; calls++ }
    const requests = r.client.requestsSent - reqs0
    console.log(`MEASURE catch-up from zero: ${replay.frames.length} frames, ${requests} requests, first call ${Math.round(firstMs)} ms -> ${first.state}${first.catchingUp ? ' (catchingUp)' : ''}, ${calls} call(s), ${Math.round(totalMs)} ms total governor-bound`)
    expect(v.state).toBe('fresh')
    expect(v.counters.framesAccepted).toBe(replay.frames.length)
    // The budget is the contract: a call never waits much past it (one in-flight sync may finish after the deadline).
    expect(firstMs).toBeLessThan(8000 + 5000)
    await r.close()
  }, 300_000)
})

describe('[MODELLED] substitutes carry null assignments on the real plugin', () => {
  it('the reader reaches fresh with null in/out of possession for substitutes, and a substitute who comes on mid-match gets his assignment from the formation history', async () => {
    const { replay, synth } = await syntheticReplay({}, {})
    // the replay serves null assignments for every player who has not been on the pitch yet (tests/support/fakePlugin.ts)
    const sub = 1011
    const r0 = await rig(replay)
    r0.plugin.advance(20)
    const meta = (await (await fetch(`${r0.plugin.url}/api/match/meta`)).json()) as Json
    const nulls = meta.players.filter((p: Json) => p.inPossession === null && p.outOfPossession === null)
    expect(nulls.length).toBeGreaterThan(0)
    expect(meta.players.some((p: Json) => p.playerId === sub && p.inPossession === null)).toBe(true)
    const v0 = await r0.reader.refresh()
    expect(v0.metadata).toBe('valid')
    expect(v0.state).toBe('fresh')
    await r0.close()

    // a role change for the substitute AFTER he comes on (subTick 14003)
    const { replay: replay2 } = await syntheticReplay({ roleChanges: [{ capturedTick: 15000, playerId: sub, position: 'ST', role: 'Poacher', duty: 'Attack' }] })
    expect(synth.subs?.[0]?.on ?? sub).toBe(sub)
    const r = await rig(replay2)
    r.plugin.advanceTo(replay2.frames.length)
    r.plugin.revealFormation(replay2.formation.length)
    const v = await r.reader.refresh()
    expect(v.state).toBe('fresh')
    const rec = r.reader.tracked!.decoded()!.recording
    const p = rec.roster.find((x) => x.upstreamPlayerId === sub)!
    expect(p.participation.status).toBe('played')
    const last = p.roleTimeline[p.roleTimeline.length - 1]!
    expect(last.inPossession?.role).toBe('Poacher')
    // before he came on every entry has no assignment (null from the plugin), never a crash
    expect(p.roleTimeline.slice(0, -1).every((e) => e.inPossession === null && e.outOfPossession === null)).toBe(true)
    const tac = await liveTacticalEvents(r.reader, {})
    expect(tac.live.state).toBe('fresh')
    await r.close()
  }, 120_000)
})
