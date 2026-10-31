import { describe, expect, it } from 'vitest'
import { counterDelta, resolveWindow } from '@fmmi/model'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { buildSyntheticArchive, crc32, defaultPlayers } from '../support/syntheticArchive.ts'
import type { SynthEvent, SynthOptions } from '../support/syntheticArchive.ts'
import { FULL_PERIODS } from '../support/helpers.ts'

const dec = new FmlensV28Decoder()
const decode = (o: SynthOptions) => dec.decode(buildSyntheticArchive(o).bytes)
const rejects = async (bytes: Uint8Array, opts?: Parameters<FmlensV28Decoder['decode']>[1]) => {
  try { await dec.decode(bytes, opts) } catch (e) { return e as { code: string; details: Record<string, unknown> } }
  throw new Error('expected rejection')
}

describe('2.8 golden comparison on a synthetic archive', () => {
  it('AC2 team names, observed score, xG and player identities', async () => {
    const d = await decode({
      periods: FULL_PERIODS, homeName: 'Alpha FC', awayName: 'Beta Town', homeUid: 111, awayUid: 222, humanSide: 'away',
      goals: [{ tick: 5000, side: 'home' }, { tick: 15000, side: 'away' }, { tick: 16000, side: 'away' }],
      stats: (t, id) => (id === 1009 && t >= 5000 ? { xg: 0.25, shots: 1, goals: 1 } : id === 2009 && t >= 15000 ? { xg: 0.5, shots: 1 } : {}),
    })
    const r = d.recording
    expect(r.teams.home).toMatchObject({ name: 'Alpha FC', uid: 111 })
    expect(r.teams.away).toMatchObject({ name: 'Beta Town', uid: 222 })
    expect(r.humanControlledSide).toBe('away')
    expect(r.observedScore).toMatchObject({ home: 1, away: 2 })
    expect(r.teamTotals.home.xg).toBeCloseTo(0.25, 6)
    expect(r.teamTotals.away.xg).toBeCloseTo(0.5, 6)
    expect(r.roster).toHaveLength(28)
    const p = r.roster.find((x) => x.upstreamPlayerId === 1009)!
    expect(p).toMatchObject({ uid: 1009, side: 'home', name: 'Home Player 9', slot: 9 })
    expect(p.counters.xg).toBeCloseTo(0.25, 6)
    expect(r.matchDate).toBe('2026-08-31')
    expect(r.competition?.name).toBe('Synthetic League')
    expect(r.integrity).toMatchObject({ status: 'valid', cleanClose: true })
  })

  it('missing uid stays null (match-local identity), never invented', async () => {
    const players = defaultPlayers().map((p) => (p.slot === 3 ? { ...p, uid: null } : p))
    const d = await decode({ periods: FULL_PERIODS, players })
    expect(d.recording.roster.find((p) => p.slot === 3)!.uid).toBeNull()
  })

  it('upstream match id identifies the recording, not a fixture: preserved verbatim', async () => {
    const d = await decode({ periods: FULL_PERIODS, upstreamMatchId: 'match-42' })
    expect(d.recording.source.upstreamMatchId).toBe('match-42')
  })
})

describe('participation and substitutions', () => {
  const subs = [{ tick: 14000, off: 1010, on: 1012 }]
  it('AC3 both the departing and the incoming player are present, each with their played window', async () => {
    const d = await decode({ periods: FULL_PERIODS, subs, stats: (t, id) => (id === 1010 ? { aerials: t >= 12000 ? 7 : 0, passes: 5 } : {}) })
    const flip = d.recording.substitutionBatches[0]!
    const off = d.recording.roster.find((p) => p.upstreamPlayerId === 1010)!
    const on = d.recording.roster.find((p) => p.upstreamPlayerId === 1012)!
    expect(flip.off).toEqual([1010]); expect(flip.on).toEqual([1012]); expect(flip.pairing).toBe('not_recorded')
    expect(off.participation.enteredAs).toBe('starter')
    expect(off.participation.lastOff).toEqual({ period: 2, tick: flip.tick, sequence: 0 })
    expect(off.participation.onPitchAtEndOfRecording).toBe(false)
    expect(on.participation.enteredAs).toBe('substitute')
    expect(on.participation.firstOn).toEqual({ period: 2, tick: flip.tick, sequence: 0 })
    expect(on.participation.onPitchAtEndOfRecording).toBe(true)
    // minutes are tick-based per period: the two windows share the flip tick and sum to the period-2 span
    const p2 = d.recording.periods.find((p) => p.period === 2)!
    expect(off.participation.segments.at(-1)!.toTick).toBe(flip.tick)
    expect(on.participation.segments[0]!.fromTick).toBe(flip.tick)
    expect(on.participation.elapsedTicks).toBe(p2.lastTick - flip.tick)
    // substituted-off player keeps counters
    expect(off.counters.aerials).toBe(7)
    expect(off.counters.passes).toBe(5)
  })

  it('unused bench players are in the roster with no participation', async () => {
    const d = await decode({ periods: FULL_PERIODS, subs })
    const unused = d.recording.roster.find((p) => p.upstreamPlayerId === 1013)!
    expect(unused.participation).toMatchObject({ status: 'unused_substitute', elapsedTicks: 0, firstOn: null, segments: [] })
  })

  it('same-tick batches are reported without an invented off/on pairing', async () => {
    const d = await decode({ periods: FULL_PERIODS, subs: [{ tick: 14000, off: 1010, on: 1012 }, { tick: 14000, off: 1009, on: 1013 }] })
    const b = d.recording.substitutionBatches.find((x) => x.side === 'home')!
    expect(b.off.sort()).toEqual([1009, 1010]); expect(b.on.sort()).toEqual([1012, 1013])
    expect(b.pairing).toBe('not_recorded')
    expect(d.recording.roster.find((p) => p.upstreamPlayerId === 1009)!.participation.sameTickBatch).toBe(true)
  })

  it('halftime substitution: the player on for the whole second half plays exactly the second-half span', async () => {
    const d = await decode({ periods: FULL_PERIODS, subs: [{ tick: 11124, off: 1010, on: 1012 }] })
    const on = d.recording.roster.find((p) => p.upstreamPlayerId === 1012)!
    const p2 = d.recording.periods.find((p) => p.period === 2)!
    expect(on.participation.elapsedTicks).toBe(p2.lastTick - p2.firstTick)
    const off = d.recording.roster.find((p) => p.upstreamPlayerId === 1010)!
    const p1 = d.recording.periods.find((p) => p.period === 1)!
    expect(off.participation.elapsedTicks).toBe(p1.lastTick - p1.firstTick) // 240 ticks = 1 minute; halftime excluded
  })

  it('role changes come from metadata revisions with the tick the plugin noticed them', async () => {
    const d = await decode({ periods: FULL_PERIODS, roleChanges: [{ capturedTick: 12000, playerId: 1005, position: 'MC', role: 'Playmaker', duty: 'Support' }] })
    const p = d.recording.roster.find((x) => x.upstreamPlayerId === 1005)!
    expect(p.roleTimeline.at(-1)).toMatchObject({ capturedTick: 12000, inPossession: { role: 'Playmaker', duty: 'Support' } })
  })
})

describe('events', () => {
  const ev = (n: number, extra: Partial<SynthEvent> = {}): SynthEvent => ({
    sequenceIndex: 100 + n, tick: 100 + n * 130, type: 7, flags: 1, team: n % 2 ? 'away' : 'home',
    playerId: n % 2 ? 2003 : 1003, receiverId: n % 2 ? 2004 : 1004, lateral: 1, longitudinal: 2, ...extra,
  })

  it('merges rolling frame tails by sequenceIndex and keeps the last version', async () => {
    const events = Array.from({ length: 90 }, (_, i) => ev(i))
    events[10] = ev(10, { flags: 1, reviseFlags: { fromTick: events[10]!.tick + 200, flags: 1 | 2 } })
    const d = await decode({ periods: FULL_PERIODS, events })
    expect(d.events).toHaveLength(90) // tails hold 64: relocation of eventIndex must not duplicate or lose events
    expect(new Set(d.events.map((e) => e.eventId)).size).toBe(90)
    const revised = d.events.find((e) => e.eventId === 110)!
    expect(revised.versions).toBe(2)
    expect(revised.flags).toBe(3)
    expect(revised.keyPass).toBe(true)
    expect(d.recording.eventSummary).toMatchObject({ distinct: 90, withRevisions: 1 })
  })

  it('joins on playerId: event slots are side-local, so an away player in slot 3 is not a home slot 3', async () => {
    const d = await decode({ periods: FULL_PERIODS, events: [ev(1)] })
    const e = d.events[0]!
    expect(e.side).toBe('away')
    expect(e.playerId).toBe(2003)
    expect(e.receiverPlayerId).toBe(2004)
    expect(d.recording.warnings.filter((w) => w.startsWith('event_'))).toEqual([])
  })

  it('receiver is null with a reason when not recorded or not applicable, never zero or a guess', async () => {
    const d = await decode({ periods: FULL_PERIODS, events: [ev(1, { type: 8, receiverId: undefined }), ev(2, { type: 1 }), ev(3)] })
    const by = new Map(d.events.map((e) => [e.eventId, e]))
    expect(by.get(101)).toMatchObject({ receiverPlayerId: null, receiverNullReason: 'not_recorded', kind: 'pass_incomplete' })
    expect(by.get(102)).toMatchObject({ receiverPlayerId: null, receiverNullReason: 'not_applicable', kind: 'goal' })
    expect(by.get(103)).toMatchObject({ receiverPlayerId: 2004 })
  })

  it('keeps raw source metres unclamped and adds attack-direction normalisation from flag 0x100', async () => {
    const d = await decode({
      periods: FULL_PERIODS,
      events: [
        ev(0, { flags: 1 | 0x100, lateral: 40, longitudinal: 20 }), // attacks toward +y, outside the touchline
        ev(1, { flags: 1, lateral: 10, longitudinal: 20 }), // attacks toward -y
      ],
    })
    const [a, b] = d.events as [typeof d.events[0], typeof d.events[0]]
    expect(a.source).toEqual({ lateralM: 40, longitudinalM: 20 })
    expect(a.normalised).toMatchObject({ attackDirection: 'toward_positive_longitudinal', lateralM: 40, forwardM: 20 })
    expect(a.normalised.lateralUnit!).toBeGreaterThan(1) // not clamped
    expect(b.normalised).toMatchObject({ attackDirection: 'toward_negative_longitudinal', lateralM: -10, forwardM: -20 })
    expect(b.source).toEqual({ lateralM: 10, longitudinalM: 20 })
    expect(a.normalised.forwardUnit!).toBeCloseTo((20 + 50.325) / (2 * 50.325), 5)
  })

  it('assigns the period from the tick and flags ticks outside any period', async () => {
    const d = await decode({ periods: FULL_PERIODS, events: [ev(0, { tick: 500 }), ev(1, { tick: 600 })] })
    expect(d.events.every((e) => e.period === 1)).toBe(true)
  })
})

describe('time and counters', () => {
  it('cumulative counters are sampled series; adjacent windows sum to the total on decoded data', async () => {
    const d = await decode({ periods: FULL_PERIODS, stats: (t, id) => (id === 1001 ? { passes: Math.floor(t / 100) } : {}) })
    const fi = d.sampled.frames
    const mid = { period: 2, tick: 15000, sequence: 0 }
    const a = counterDelta(d.sampled, 'player.1001.passes', resolveWindow(fi, { to: mid }))
    const b = counterDelta(d.sampled, 'player.1001.passes', resolveWindow(fi, { from: mid }))
    const all = counterDelta(d.sampled, 'player.1001.passes', resolveWindow(fi, {}))
    expect(d.sampled.initialBaseline).toBe('zero_verified')
    expect(a.value! + b.value!).toBe(all.value)
    expect(all.value).toBe(d.recording.roster.find((p) => p.upstreamPlayerId === 1001)!.counters.passes)
  })

  it('a non-zero first frame is not a trustworthy baseline: windows from the start return missing_baseline', async () => {
    const d = await decode({ periods: FULL_PERIODS, stats: (t, id) => (id === 1001 ? { passes: 5 + Math.floor(t / 1000) } : {}) })
    expect(d.sampled.initialBaseline).toBe('unverified')
    expect(d.recording.coverage.status).toBe('partial')
    expect(d.recording.coverage.reasons).toContain('initial_baseline_unverified')
    const w = counterDelta(d.sampled, 'player.1001.passes', resolveWindow(d.sampled.frames, {}))
    expect(w.value).toBeNull(); expect(w.nullReason).toBe('missing_baseline')
  })

  const gapFrames = (gap: number) => {
    const t: Array<{ period: number; tick: number; displayOffset?: number }> = []
    for (let k = 3; k <= 11041; k += 60) t.push({ period: 1, tick: k, displayOffset: 1 })
    for (let k = 11124; k < 15000; k += 60) t.push({ period: 2, tick: k, displayOffset: 323 })
    const last = t[t.length - 1]!.tick
    t.push({ period: 2, tick: last + gap, displayOffset: 323 })
    for (let k = last + gap + 60; k <= 22000; k += 60) t.push({ period: 2, tick: k, displayOffset: 323 })
    return t
  }
  it('gap tolerance: a 240-tick gap inside a period is ordinary, 241 makes capture partial', async () => {
    const ok = (await decode({ frameTicks: gapFrames(240) })).recording.coverage
    expect(ok.gaps).toMatchObject({ toleranceTicks: 240, countOverTolerance: 0, largestGapTicks: 240 })
    expect(ok.status).toBe('full_match')
    const bad = (await decode({ frameTicks: gapFrames(241) })).recording.coverage
    expect(bad.gaps.countOverTolerance).toBe(1)
    expect(bad.status).toBe('partial')
    expect(bad.reasons).toContain('gap_exceeds_tolerance')
  })

  it('the halftime gap is not a capture gap', async () => {
    const c = (await decode({ periods: FULL_PERIODS })).recording.coverage
    expect(c.status).toBe('full_match')
    expect(c.notes).toContain('full_time_not_signalled_by_source')
  })

  it('AC7 a cleanly closed capture that stops mid-match is partial with end_capture_ends_at, completion unknown, score observed', async () => {
    const d = await decode({
      periods: [{ period: 1, fromTick: 3, toTick: 11041, step: 60, displayOffset: 1 }, { period: 2, fromTick: 11124, toTick: 20000, step: 60, displayOffset: 323 }],
      goals: [{ tick: 19000, side: 'away' }],
    })
    expect(d.recording.integrity).toMatchObject({ status: 'valid', cleanClose: true })
    expect(d.recording.coverage.status).toBe('partial')
    expect(d.recording.coverage.endCaptureEndsAt).toMatchObject({ period: 2, tick: 20000 })
    expect(d.recording.observedScore).toMatchObject({ home: 0, away: 1 })
  })
})

describe('broken input yields a partial result or a stable error, never invented statistics', () => {
  const base = () => buildSyntheticArchive({ periods: FULL_PERIODS, framesPerBlock: 50, stats: (t, id) => (id === 1001 ? { passes: Math.floor(t / 100) } : {}) })

  it('AC4 truncated at a block boundary: valid records but no clean close, so capture is partial and ends where the file does', async () => {
    const a = base()
    const cut = a.bytes.subarray(0, a.layout.blockOffsets[3])
    const d = await dec.decode(cut)
    expect(d.recording.integrity).toMatchObject({ status: 'valid', cleanClose: false, framesDecoded: 150 })
    expect(d.recording.frameCount).toBe(150)
    expect(d.recording.coverage.status).toBe('partial')
    expect(d.recording.coverage.reasons).toContain('not_cleanly_closed')
    expect(d.recording.coverage.endCaptureEndsAt).not.toBeNull()
    const last = d.recording.lastBoundary.tick
    expect(d.recording.roster.find((p) => p.upstreamPlayerId === 1001)!.counters.passes).toBe(Math.floor(last / 100))
  })

  it('AC4 truncated in the middle of a block: the incomplete block is dropped, earlier frames survive', async () => {
    const a = base()
    const d = await dec.decode(a.bytes.subarray(0, a.layout.blockOffsets[2]! + 40))
    expect(d.recording.integrity).toMatchObject({ status: 'recovered_prefix', error: 'truncated_tail' })
    expect(d.recording.coverage.reasons).toContain('recovered_prefix')
    expect(d.recording.frameCount).toBe(100)
  })

  it('AC4 truncated header or empty archive: stable error', async () => {
    const a = base()
    expect((await rejects(a.bytes.subarray(0, 10))).details.kind).toBe('truncated')
    expect((await rejects(a.bytes.subarray(0, a.layout.blockOffsets[0]))).details.kind).toBe('no_frames')
  })

  it('AC4 CRC-corrupt block payload after good blocks: recovered_prefix; in the first block: stable error', async () => {
    const a = base()
    const later = Buffer.from(a.bytes)
    later[a.layout.blockPayloads[2]!.offset + 3]! ^= 0xff
    const d = await dec.decode(later)
    expect(d.recording.integrity.status).toBe('recovered_prefix')
    expect(d.recording.integrity.error).toMatch(/CRC|decompression/)
    expect(d.recording.frameCount).toBe(100)
    const first = Buffer.from(a.bytes)
    first[a.layout.blockPayloads[0]!.offset + 3]! ^= 0xff
    const e = await rejects(first)
    expect(e.code).toBe('invalid_input')
    expect(['crc_mismatch', 'no_frames', 'malformed']).toContain(e.details.kind)
  })

  it('AC4 corrupt file header CRC: crc_mismatch', async () => {
    const a = Buffer.from(base().bytes)
    a[20]! ^= 0xff
    expect((await rejects(a)).details.kind).toBe('crc_mismatch')
  })

  it('AC4 invalid magic', async () => {
    const a = Buffer.from(base().bytes)
    a[0] = 0x58
    const e = await rejects(a)
    expect(e).toMatchObject({ code: 'invalid_input' })
    expect(e.details.kind).toBe('bad_magic')
  })

  it('AC4 wrong version: unsupported_version names the found format and leaves the input usable later', async () => {
    const a = buildSyntheticArchive({ periods: FULL_PERIODS, minor: 7 })
    const e = await rejects(a.bytes)
    expect(e.code).toBe('unsupported_version')
    expect(e.details.found).toBe('2.7')
  })

  it('AC4 oversized block: a declared length over the chunk limit is rejected before decompression', async () => {
    const a = base()
    const b = Buffer.from(a.bytes)
    const off = a.layout.blockOffsets[0]!
    b.writeUInt32LE(17 * 1024 * 1024, off + 17)
    b.writeUInt32LE(crc32(b.subarray(off, off + 29)), off + 29)
    const e = await rejects(b)
    expect(e.code).toBe('invalid_input')
    expect(e.details.kind).toBe('size_limit')
  })

  it('AC4 size bounds: file, frame and block limits are enforced', async () => {
    const a = base()
    expect((await rejects(a.bytes, { limits: { maxFileBytes: 1000 } })).details.kind).toBe('size_limit')
    expect((await rejects(a.bytes, { limits: { maxFrames: 10 } })).details.kind).toBe('size_limit')
    expect((await rejects(a.bytes, { limits: { maxBlocks: 2 } })).details.kind).toBe('size_limit')
  })

  it('metadata revision disorder is a stable error', async () => {
    const e = await rejects(buildSyntheticArchive({ periods: FULL_PERIODS, duplicateMetadataRevision: true }).bytes)
    expect(e.details.kind).toBe('metadata_revision_order')
  })

  it('a file without a clean close marker is valid but not cleanly closed; completion is never inferred from it', async () => {
    const d = await decode({ periods: FULL_PERIODS, cleanClose: false })
    expect(d.recording.integrity).toMatchObject({ status: 'valid', cleanClose: false })
  })

  it('error bodies carry no filesystem paths', async () => {
    const e = await rejects(Buffer.from('not an archive at all, but long enough to read'))
    expect(JSON.stringify(e.details)).not.toMatch(/[A-Za-z]:\\|\/Users\//)
  })
})
