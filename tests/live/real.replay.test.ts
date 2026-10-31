// REAL FRAMES, MODELLED TRANSPORT. The frames served here come from a real recording (tests/fixtures/local, gitignored, decoded by the
// vendored archive parser); the HTTP routes and JSON envelopes around them are MODELLED from the vendored v0.7.0 source (see
// tests/support/fakePlugin.ts). Skipped when the recording is absent. This proves our reader reproduces the offline analysis from frames
// of a real match; it does NOT prove the real plugin serves frames this way.
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { baseCompletion, deriveResult } from '@fmmi/model'
import { liveInput, liveMatch, livePlayer, LIVE_MAX_BYTES } from '@fmmi/live'
import { playerQuery, summaryQuery } from '@fmmi/analytics'
import { HAS_REAL, REAL_FIXTURE, cleanupAll } from '../support/helpers.ts'
import { loadReplay } from '../support/fakePlugin.ts'
import { rig } from '../support/live.ts'

afterAll(cleanupAll)

const ID = /\b(?:m|r|p|t|lv|lr|lt)_[0-9a-f]{12,16}\b/g
const norm = (x: unknown) => JSON.parse(JSON.stringify(x).replace(ID, 'ID'))

describe.skipIf(!HAS_REAL)('[S1][AC1][MODELLED transport, REAL frames] a real recording replayed through the live reader', () => {
  it('after the whole match is replayed, the live snapshot reproduces the offline decode: totals, score, minutes, substitutions, events, player metrics', async () => {
    const replay = await loadReplay(REAL_FIXTURE, 'real_recording')
    expect(replay.frames.length).toBeGreaterThan(15_000)
    const r = await rig(replay, { pageSize: 500, maxPagesPerSync: 40 })
    r.plugin.advanceTo(replay.frames.length)
    let v = await r.reader.refresh()
    for (let i = 0; i < 6 && v.counters.framesAccepted < replay.frames.length; i++) v = await r.reader.refresh({ force: true })
    expect(v.state).toBe('fresh')
    expect(v.counters.framesAccepted).toBe(replay.frames.length)
    expect(v.counters.duplicateFrames).toBe(0)

    const offline = await new FmlensV28Decoder().decode(readFileSync(REAL_FIXTURE))
    const track = r.reader.tracked!
    const live = track.decoded()!
    expect(live.recording.teamTotals).toEqual(offline.recording.teamTotals)
    expect(live.recording.observedScore).toEqual(offline.recording.observedScore)
    expect(live.recording.substitutionBatches).toEqual(offline.recording.substitutionBatches)
    expect(live.recording.eventSummary).toEqual(offline.recording.eventSummary)
    expect(live.recording.roster.map((p) => [p.upstreamPlayerId, p.participation.elapsedTicks])).toEqual(offline.recording.roster.map((p) => [p.upstreamPlayerId, p.participation.elapsedTicks]))
    expect(live.events.length).toBe(offline.events.length)

    // The analytics run unchanged on the live snapshot: the same player rows as the offline analysis of the same frames (ids aside).
    const input = liveInput(track)!
    const completion = baseCompletion()
    const offInput = {
      decoded: offline, completion, result: deriveResult(offline.recording.observedScore, completion),
      ids: { ...input.ids, playerIds: input.ids.playerIds },
    }
    const subject = [...input.ids.playerIds.values()][3]!
    const a = norm(playerQuery(input, subject).player), b = norm(playerQuery(offInput, subject).player)
    expect(a.metrics ?? a).toEqual(b.metrics ?? b)
    expect(norm(summaryQuery(input).summary.comparison)).toEqual(norm(summaryQuery(offInput).summary.comparison))

    // The tool results fit the output limit with a full real roster, and the player tool answers with the explicit snapshot.
    const lm = await liveMatch(r.reader)
    expect(lm.available).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(lm), 'utf8')).toBeLessThan(LIVE_MAX_BYTES)
    const lp = await livePlayer(r.reader, { playerId: subject })
    expect(Buffer.byteLength(JSON.stringify(lp), 'utf8')).toBeLessThan(LIVE_MAX_BYTES)
    expect(lp.live.snapshot!.label).toMatch(/^live as of game minute \d+(\.\d+)? \/ period \d \/ tick \d+$/)
    await r.close()
  }, 240_000)

  it('halfway through the real match the snapshot is an honest prefix: the live minute is explicit, the coverage is partial and the score is not final', async () => {
    const replay = await loadReplay(REAL_FIXTURE, 'real_recording')
    const half = replay.frames.findIndex((f) => f.period === 2) + 400
    const r = await rig(replay, { pageSize: 500, maxPagesPerSync: 40 })
    r.plugin.advanceTo(half)
    let v = await r.reader.refresh()
    for (let i = 0; i < 3 && v.counters.framesAccepted < half; i++) v = await r.reader.refresh({ force: true })
    const lm = await liveMatch(r.reader)
    expect(lm.live.snapshot).toMatchObject({ period: 2, frames: half })
    expect(lm.live.snapshot!.label).toContain('period 2')
    const s = (lm.summary as ReturnType<typeof summaryQuery>)
    expect(s.result.label).toBe('observed_not_final')
    expect(s.capture.coverage).toBe('partial')
    expect(s.capture.completion).toBe('in_progress')
    await r.close()
  }, 240_000)
})
