// Slice 5 live reader (spec 2.1, 9.2, section 12 Live row). EVERY test in this file rests on the MODELLED fake plugin
// (tests/support/fakePlugin.ts): its routes and JSON shapes come from the vendored v0.7.0 frontend source, not from a running plugin.
// The frame content is a SYNTHETIC archive (invented teams and players); tests/live/real.replay.test.ts replays a real recording.
// What these tests do prove: our reader, builder reuse, ordering rules, rate cap and degradation behave as designed against that model.
// What they cannot prove: that the real plugin behaves like the model. That needs `fmmi live capture` during a real match.
import { afterAll, describe, expect, it } from 'vitest'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import { LiveReader, LocalPluginClient, MatchTrack, RequestGovernor, PLUGIN_RATE_CAP, liveMatch, livePlayer, liveTacticalEvents } from '@fmmi/live'
import { cleanupAll } from '../support/helpers.ts'
import { FakePlugin } from '../support/fakePlugin.ts'
import { ScriptedSocket, rig, syntheticReplay } from '../support/live.ts'
import { readFileSync } from 'node:fs'

afterAll(cleanupAll)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('[S1][MODELLED] synchronisation: metadata, historical frames and the offline equivalence', () => {
  it('a live snapshot of every revealed frame equals the offline decode of the same archive (totals, score, roster minutes, substitutions, events)', async () => {
    const { replay, file } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advanceTo(replay.frames.length)
    const view = await r.reader.refresh()
    expect(view.state).toBe('fresh')
    expect(view.snapshot).toMatchObject({ frames: replay.frames.length, lagTicks: 0 })
    const live = r.reader.tracked!.decoded()!.recording
    const offline = (await new FmlensV28Decoder().decode(readFileSync(file))).recording
    expect(live.teamTotals).toEqual(offline.teamTotals)
    expect(live.observedScore).toEqual(offline.observedScore)
    expect(live.substitutionBatches).toEqual(offline.substitutionBatches)
    expect(live.eventSummary).toEqual(offline.eventSummary)
    expect(live.roster.map((p) => [p.upstreamPlayerId, p.participation.elapsedTicks, p.participation.status])).toEqual(offline.roster.map((p) => [p.upstreamPlayerId, p.participation.elapsedTicks, p.participation.status]))
    // An in-progress capture is never complete: the live recording is partial and says where it came from.
    expect(live.source.kind).toBe('fmlens_live_api')
    expect(live.coverage.status).toBe('partial')
    expect(live.coverage.reasons).toContain('not_cleanly_closed')
    await r.close()
  })

  it('incremental sync: the second refresh reads only the frames after the last accepted tick, none twice', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advance(100)
    await r.reader.refresh()
    const first = r.reader.view().counters.framesAccepted
    r.plugin.advance(60)
    const v = await r.reader.refresh()
    expect(first).toBe(100)
    expect(v.counters).toMatchObject({ framesAccepted: 160, duplicateFrames: 0, outOfOrderFrames: 0 })
    const last = r.plugin.hits.filter((h) => h.path.startsWith('/api/match/frames')).at(-1)!.path
    expect(last).toContain(`fromTick=${replay.frames[99]!.tick + 1}`)
    await r.close()
  })

  it('reordered pages and overlapping pages are normalised: no duplicate, no regression, the same analysis as a clean sync', async () => {
    const { replay } = await syntheticReplay()
    const clean = await rig(replay)
    clean.plugin.advanceTo(replay.frames.length)
    await clean.reader.refresh()
    const want = clean.reader.tracked!.decoded()!.recording.teamTotals
    await clean.close()

    const r = await rig(replay, { pageSize: 40 })
    r.plugin.faults = { reversePages: true, overlapPages: 5 }
    r.plugin.advanceTo(replay.frames.length)
    for (let i = 0; i < 12; i++) await r.reader.refresh()
    const v = r.reader.view()
    expect(v.counters.framesAccepted).toBe(replay.frames.length)
    expect(v.counters.duplicateFrames).toBeGreaterThan(0)
    expect(r.reader.tracked!.decoded()!.recording.teamTotals).toEqual(want)
    await r.close()
  })
})

describe('[AC2][S1][MODELLED] reconnect, duplicates and stale data never regress the match state', () => {
  it('a socket drop and reconnect re-reads metadata and history from the last accepted tick: no duplicate frames, no regression, frames revealed meanwhile are caught up', async () => {
    const { replay } = await syntheticReplay()
    const sockets: ScriptedSocket[] = []
    const r = await rig(replay, { useWebSocket: true, openSocket: () => { const s = new ScriptedSocket(); sockets.push(s); return s }, reconnect: { minMs: 5, maxMs: 20 } })
    r.plugin.advance(120)
    await r.reader.refresh()
    sockets[0]!.open()
    expect(r.reader.view().connection.socket).toBe('open')
    const before = r.reader.view()
    // the connection drops; the plugin keeps going while we are disconnected
    sockets[0]!.drop()
    r.plugin.advance(80)
    expect(r.reader.view().connection.socket).toBe('closed')
    await wait(60)
    expect(sockets.length).toBeGreaterThanOrEqual(2) // the reader reconnected on its own
    sockets[1]!.open()
    const after = await r.reader.refresh()
    expect(after.counters.framesAccepted).toBe(200)
    expect(after.counters.duplicateFrames).toBe(0)
    expect(after.snapshot!.tick).toBeGreaterThan(before.snapshot!.tick)
    expect(after.connection.reconnects).toBeGreaterThanOrEqual(1)
    // the reconnect forced a metadata re-read (authoritative), not a trust in socket deltas
    expect(r.plugin.hitsFor('/api/match/meta')).toBeGreaterThanOrEqual(2)
    await r.close()
  })

  it('over a REAL WebSocket to the modelled server: it connects on demand, a pushed tick advances "latest", a server-side drop reconnects by itself and the stream resumes without duplicates', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay, { useWebSocket: true, reconnect: { minMs: 20, maxMs: 40 }, wsMinParseIntervalMs: 0, openSocket: undefined })
    r.plugin.advance(90)
    await r.reader.refresh()
    for (let i = 0; i < 100 && r.plugin.sockets.size === 0; i++) await wait(10)
    expect(r.plugin.sockets.size).toBe(1)
    expect(r.reader.view().connection.socket).toBe('open')
    r.plugin.advance(5)
    r.plugin.pushTick()
    for (let i = 0; i < 100 && r.reader.view().latest!.tick !== replay.frames[94]!.tick; i++) await wait(10)
    expect(r.reader.view().latest!.tick).toBe(replay.frames[94]!.tick)
    expect(r.reader.view().snapshot!.tick).toBe(replay.frames[89]!.tick) // the socket did not write the analysis
    r.plugin.dropSockets() // the server side goes away
    r.plugin.advance(30)
    for (let i = 0; i < 200 && r.plugin.sockets.size === 0; i++) await wait(10)
    expect(r.plugin.sockets.size).toBe(1) // reconnected on its own
    expect(r.reader.view().connection.reconnects).toBeGreaterThanOrEqual(1)
    const v = await r.reader.refresh({ force: true })
    expect(v.counters).toMatchObject({ framesAccepted: 125, duplicateFrames: 0 })
    expect(v.state).toBe('fresh')
    await r.close()
  }, 20_000)

  it('socket frames are delta-like: they advance "latest" only, an older tick is ignored, a repeated tick is a duplicate, and the analysis comes from history', async () => {
    const { replay } = await syntheticReplay()
    const sock = new ScriptedSocket()
    const r = await rig(replay, { useWebSocket: true, openSocket: () => sock, wsMinParseIntervalMs: 0 })
    r.plugin.advance(100)
    await r.reader.refresh()
    sock.open()
    const frame = (i: number) => JSON.stringify({ type: 'realtime_tick', payload: { ...replay.frames[i]!, players: replay.frames[i]!.players.map((p) => { const { archiveRatingInputs: _a, ratingContribution: _c, ...rest } = p as unknown as Record<string, unknown>; return rest }), capturedUnixMilliseconds: r.time.now } })
    r.plugin.advance(30)
    sock.send(frame(125)) // newer than history: latest moves, snapshot does not
    let v = r.reader.view()
    expect(v.latest!.tick).toBe(replay.frames[125]!.tick)
    expect(v.snapshot!.tick).toBe(replay.frames[99]!.tick)
    expect(v.snapshot!.lagTicks).toBeGreaterThan(0)
    sock.send(frame(110)) // older than latest: dropped
    sock.send(frame(125)) // same tick again
    v = r.reader.view()
    expect(v.latest!.tick).toBe(replay.frames[125]!.tick)
    expect(v.counters.socketStale).toBe(1)
    expect(v.counters.framesAccepted).toBe(100) // the socket never wrote the analysis
    v = await r.reader.refresh()
    expect(v.snapshot).toMatchObject({ tick: replay.frames[129]!.tick, lagTicks: 0 })
    expect(v.counters.framesAccepted).toBe(130)
    await r.close()
  })

  it('frames of another match are ignored on the socket and in history; a new match starts a new track', async () => {
    const { replay } = await syntheticReplay()
    const sock = new ScriptedSocket()
    const r = await rig(replay, { useWebSocket: true, openSocket: () => sock, wsMinParseIntervalMs: 0 })
    r.plugin.advance(50)
    await r.reader.refresh()
    sock.open()
    const other = { type: 'realtime_tick', payload: { ...replay.frames[10]!, matchId: 'match-other', players: [], tick: 99999 } }
    sock.send(JSON.stringify(other)) // players: [] is a valid frame shape; the match id is what rejects it
    expect(r.reader.view().counters.socketOtherMatch).toBe(1)
    expect(r.reader.view().latest!.tick).toBeLessThan(99999)
    // history answered for another match: nothing is taken
    r.plugin.faults = { framesBody: { matchId: 'match-other', status: 'live', totalFrameCount: 5, frames: [] } }
    const v = await r.reader.refresh({ force: true })
    expect(v.counters.framesAccepted).toBe(50)
    expect(v.counters.otherMatchFrames).toBe(0)
    await r.close()
  })

  it('MatchTrack rules in isolation: duplicate tick, older tick, other match, period regression, stale metadata, formation index gap and duplicate', async () => {
    const { replay } = await syntheticReplay()
    const t = new MatchTrack(replay.metadata)
    const f = replay.frames
    expect(t.acceptHistory([f[0]!, f[1]!, f[2]!], 1)).toBe(3)
    expect(t.acceptHistory([f[2]!, f[1]!, f[3]!], 2)).toBe(1) // 2 duplicate, 1 older
    expect(t.counters).toMatchObject({ duplicateFrames: 1, outOfOrderFrames: 1, framesAccepted: 4 })
    expect(t.acceptHistory([{ ...f[4]!, matchId: 'other' }], 3)).toBe(0)
    expect(t.counters.otherMatchFrames).toBe(1)
    const p2 = f.findIndex((x) => x.period === 2)
    t.acceptHistory([f[p2]!], 4)
    expect(t.acceptHistory([{ ...f[p2 + 1]!, tick: f[p2]!.tick + 60, period: 1 }], 5)).toBe(0)
    expect(t.counters.periodRegressions).toBe(1)
    // metadata older than what is held is ignored
    expect(t.acceptMetadata({ ...replay.metadata, capturedTick: replay.metadata.capturedTick - 1 })).toBe(false)
    expect(t.counters.staleMetadata).toBe(1)
    const entry = (index: number) => ({ index, tick: 100 + index, players: [] as never[] })
    expect(t.acceptFormation([entry(1)])).toEqual({ changed: false, gap: true }) // 0 is missing
    expect(t.acceptFormation([entry(0), entry(1)])).toEqual({ changed: true, gap: false })
    expect(t.acceptFormation([entry(1)])).toEqual({ changed: false, gap: false })
    expect(t.counters.duplicateFormationEntries).toBe(1)
    expect(t.formationNext).toBe(2)
  })

  it('formation_changed over the socket is applied by index, a gap triggers an HTTP re-read, and the role timeline keeps every change once', async () => {
    const { replay } = await syntheticReplay({
      roleChanges: [
        { capturedTick: 4000, playerId: 1003, position: 'AMC', role: 'Advanced Playmaker', duty: 'Support' },
        { capturedTick: 9000, playerId: 1003, position: 'AMC', role: 'Shadow Striker', duty: 'Attack' },
      ],
    })
    expect(replay.formation).toHaveLength(2)
    const sock = new ScriptedSocket()
    const r = await rig(replay, { useWebSocket: true, openSocket: () => sock, wsMinParseIntervalMs: 0 })
    r.plugin.advanceTo(replay.frames.length)
    await r.reader.refresh()
    sock.open()
    // entry 1 arrives before entry 0 (reordered): a gap, so the reader re-reads formation history over HTTP
    r.plugin.revealFormation(2)
    const entries = replay.formation
    sock.send(JSON.stringify({ type: 'formation_changed', payload: { matchId: replay.matchId, status: 'live', totalEntryCount: 2, entries: [entries[1]] } }))
    expect(r.reader.view().counters.formationEntries).toBe(0)
    await r.reader.refresh({ force: true })
    expect(r.reader.view().counters).toMatchObject({ formationEntries: 2, duplicateFormationEntries: 0 })
    // the same message delivered again is a duplicate, not a second change
    sock.send(JSON.stringify({ type: 'formation_changed', payload: { matchId: replay.matchId, status: 'live', totalEntryCount: 2, entries } }))
    expect(r.reader.view().counters).toMatchObject({ formationEntries: 2, duplicateFormationEntries: 2 })
    await r.reader.refresh({ force: true })
    const events = await liveTacticalEvents(r.reader, {})
    const changes = events.observed.roleChanges.items.filter((c) => c.name.includes('Player 3'))
    expect(changes.map((c) => c.to)).toEqual(expect.arrayContaining([expect.stringContaining('Shadow Striker')]))
    expect(new Set(changes.map((c) => c.tick)).size).toBe(changes.length) // no change listed twice
    await r.close()
  })
})

describe('[S1][AC1][MODELLED] states: fresh, stale, not_connected, not_in_match, bad metadata, changed endpoints', () => {
  it('stale: a latest frame older than the freshness limit is stale and is not analysed; a newer frame makes it fresh again', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay, { staleAfterMs: 10_000 })
    r.plugin.advance(100)
    expect((await r.reader.refresh()).state).toBe('fresh')
    r.time.now += 60_000 // a minute of wall time with no new frame (paused game or a stalled plugin)
    r.reader.view()
    const stale = await r.reader.refresh({ force: true })
    expect(stale.state).toBe('stale')
    expect(stale.reason).toBe('latest_frame_too_old')
    expect(stale.latest!.captureAgeMs).toBeGreaterThan(10_000)
    expect((await liveMatch(r.reader)).available).toBe(false)
    await expect(livePlayer(r.reader, { playerId: 'p_x' })).rejects.toMatchObject({ code: 'stale_snapshot', retryable: true, details: { state: 'stale' } })
    r.plugin.advance(10)
    expect((await r.reader.refresh({ force: true })).state).toBe('fresh')
    await r.close()
  })

  it('process exit: the plugin disappearing is not_connected (not an error), the last known minute is kept for the message, and the stream resumes without duplicates', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advance(100)
    await r.reader.refresh()
    await r.plugin.stop() // FM exits
    const gone = await r.reader.refresh({ force: true })
    expect(gone.state).toBe('not_connected')
    expect(gone.reason).toBe('plugin_unreachable_after_connect')
    expect(gone.connection).toMatchObject({ http: 'failed', lastFailure: 'unreachable', everConnected: true })
    expect(gone.snapshot!.frames).toBe(100) // last known snapshot survives for the error message
    await expect(livePlayer(r.reader, { playerId: 'p_x' })).rejects.toMatchObject({ code: 'stale_snapshot', details: { state: 'not_connected', lastKnown: expect.stringContaining('live as of game minute') } })
    await r.plugin.restart()
    r.plugin.advance(40)
    const back = await r.reader.refresh({ force: true })
    expect(back.state).toBe('fresh')
    expect(back.counters).toMatchObject({ framesAccepted: 140, duplicateFrames: 0 })
    await r.close()
  })

  it('a new match on the same plugin replaces the track; nothing of the old match leaks into the new snapshot', async () => {
    const a = await syntheticReplay()
    const b = await syntheticReplay({ upstreamMatchId: 'match-synth-2', homeName: 'Other Home', awayName: 'Other Away' })
    const r = await rig(a.replay)
    r.plugin.advance(100)
    await r.reader.refresh()
    const port = r.plugin.boundPort
    await r.plugin.stop()
    const second = new FakePlugin(b.replay)
    second.clock = () => r.time.now
    await second.start(port)
    second.advance(30)
    const v = await r.reader.refresh({ force: true })
    expect(v.upstreamMatchId).toBe('match-synth-2')
    expect(v.counters.framesAccepted).toBe(30)
    expect(r.reader.tracked!.decoded()!.recording.teams.home.name).toBe('Other Home')
    await second.stop()
    r.reader.close()
  })

  it('not_in_match: the plugin is reachable and no match is running; analysis tools say so and are retryable', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.inMatch = false
    const v = await r.reader.refresh()
    expect(v.state).toBe('not_in_match')
    expect(v.reason).toBe('no_match_in_progress')
    expect(v.connection.http).toBe('ok')
    await expect(livePlayer(r.reader, { playerId: 'p_x' })).rejects.toMatchObject({ code: 'not_found', retryable: true })
    await r.close()
  })

  it('bad metadata: an invalid /api/match/meta never produces a snapshot; a valid one earlier is kept and flagged invalid, not replaced', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.faults = { metaBody: { matchId: 5, players: 'many' } }
    r.plugin.advance(80)
    const bad = await r.reader.refresh()
    expect(bad.metadata).toBe('missing')
    expect(bad.state).toBe('stale')
    expect(bad.reason).toBe('metadata_invalid')
    expect(r.reader.tracked).toBeNull()
    // valid now
    r.plugin.faults = {}
    expect((await r.reader.refresh({ force: true })).state).toBe('fresh')
    // metadata goes bad again after a successful start (a re-read is forced by a formation change): the held track is kept but flagged
    r.plugin.faults = { metaBody: [] }
    r.plugin.advance(20)
    ;(r.reader as unknown as { needMeta: boolean }).needMeta = true
    const flagged = await r.reader.refresh({ force: true })
    expect(flagged.metadata).toBe('invalid')
    expect(flagged.state).toBe('stale')
    expect(r.reader.tracked!.frameCount).toBeGreaterThan(0)
    await expect(livePlayer(r.reader, { playerId: 'p_x' })).rejects.toMatchObject({ code: 'stale_snapshot' })
    await r.close()
  })

  it('changed endpoints degrade gracefully with a named reason and never throw: health, frames and meta each fail their schema', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advance(50)
    r.plugin.faults = { framesBody: { frames: 'not-an-array' } }
    const frames = await r.reader.refresh()
    expect(frames.state).toBe('stale')
    expect(frames.reason).toBe('incompatible_endpoint:frames')
    expect(frames.snapshot).toBeNull()
    await r.close()

    const h = await rig(replay)
    const originalFetch = globalThis.fetch
    const client = new LocalPluginClient({ port: h.plugin.boundPort, governor: h.governor, fetchImpl: async (u, i) => (String(u).endsWith('/api/health') ? new Response(JSON.stringify({ unexpected: true }), { headers: { 'content-type': 'application/json' } }) : originalFetch(u, i)) })
    const reader = new LiveReader({ client, now: () => h.time.now, useWebSocket: false, minSyncIntervalMs: 0 })
    const v = await reader.refresh()
    expect(v.state).toBe('not_connected')
    expect(v.reason).toBe('incompatible_endpoint:health')
    expect(client.requestsSent).toBe(1) // it stopped at the first incompatible answer
    await h.close()

    const m = await rig(replay)
    m.plugin.faults = { status: { '/api/match/meta': 500 } }
    expect((await m.reader.refresh()).reason).toBe('metadata_unavailable')
    await m.close()
  })
})

describe('[S2][MODELLED] on demand, low impact: no polling, bounded work, backpressure, an explicit request-rate cap', () => {
  it('nothing happens until a tool asks: a constructed reader makes no request and opens no socket; a second ask inside the cache interval makes none either', async () => {
    const { replay } = await syntheticReplay()
    const sockets: ScriptedSocket[] = []
    const r = await rig(replay, { useWebSocket: true, minSyncIntervalMs: 5000, openSocket: () => { const s = new ScriptedSocket(); sockets.push(s); return s } })
    r.plugin.advance(50)
    await wait(30)
    expect(r.plugin.hits).toHaveLength(0)
    expect(sockets).toHaveLength(0)
    await r.reader.refresh()
    const n = r.plugin.hits.length
    expect(n).toBeGreaterThan(0)
    expect(sockets).toHaveLength(1) // opened because a tool asked
    await r.reader.refresh() // inside minSyncIntervalMs (virtual clock did not move enough): served from the cache
    expect(r.plugin.hits.length).toBe(n)
    await r.close()
  })

  it('the socket is closed after the idle period and nothing reconnects it until the next ask', async () => {
    const { replay } = await syntheticReplay()
    const sockets: ScriptedSocket[] = []
    const r = await rig(replay, { useWebSocket: true, idleCloseMs: 25, reconnect: { minMs: 5, maxMs: 10 }, openSocket: () => { const s = new ScriptedSocket(); sockets.push(s); return s } })
    r.plugin.advance(20)
    await r.reader.refresh()
    sockets[0]!.open()
    await wait(120)
    expect(sockets[0]!.closed).toBe(true)
    expect(sockets).toHaveLength(1) // no reconnect while idle
    await r.reader.refresh({ force: true })
    expect(sockets).toHaveLength(2)
    await r.close()
  })

  it('burst of socket ticks is coalesced: at most one parse per interval; the rest are dropped, formation messages are never dropped', async () => {
    const { replay } = await syntheticReplay()
    const sock = new ScriptedSocket()
    const r = await rig(replay, { useWebSocket: true, openSocket: () => sock, wsMinParseIntervalMs: 500 })
    r.plugin.advance(80)
    await r.reader.refresh()
    sock.open()
    const raw = JSON.stringify({ type: 'realtime_tick', payload: { ...replay.frames[79]!, players: [], capturedUnixMilliseconds: r.time.now } })
    for (let i = 0; i < 200; i++) sock.send(raw)
    expect(r.reader.view().counters).toMatchObject({ socketMessages: 200, socketParsed: 1, socketCoalesced: 199 })
    r.time.now += 600
    sock.send(raw)
    expect(r.reader.view().counters.socketParsed).toBe(2)
    await r.close()
  })

  it('a long catch-up is bounded per call (pages) and reports catchingUp; later calls finish it; an oversized page halves itself', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay, { pageSize: 25, maxPagesPerSync: 2 })
    r.plugin.advanceTo(replay.frames.length)
    const first = await r.reader.refresh()
    expect(first.counters.framesAccepted).toBe(50)
    expect(first.catchingUp).toBe(true)
    let v = first
    for (let i = 0; i < 20 && v.counters.framesAccepted < replay.frames.length; i++) v = await r.reader.refresh({ force: true })
    expect(v.counters.framesAccepted).toBe(replay.frames.length)
    expect(v.catchingUp).toBe(false)
    await r.close()

    // pages bigger than the response cap are retried smaller
    const big = await rig(replay, { pageSize: 200 })
    big.plugin.advance(100)
    // the largest single frame so far: frames grow with the event list, so size the cap on the last one
    const lastTick = replay.frames[99]!.tick
    const one = await new LocalPluginClient({ port: big.plugin.boundPort, governor: big.governor }).getRaw(`/api/match/frames?fromTick=${lastTick}&stride=1&limit=1`)
    if (!one.ok) throw new Error('fixture')
    const small = new LocalPluginClient({ port: big.plugin.boundPort, governor: big.governor, maxBytes: one.bytes * 30 + 2000 })
    const rd = new LiveReader({ client: small, now: () => big.time.now, useWebSocket: false, minSyncIntervalMs: 0, pageSize: 200 })
    const vv = await rd.refresh()
    expect(vv.counters.framesAccepted).toBe(100)
    expect(big.plugin.hits.filter((h) => h.path.includes('/frames')).some((h) => /limit=(100|50|25)\b/.test(h.path))).toBe(true)
    await big.close()
  })

  it('the frames are not retained: memory is the counters and events, whatever the number of frames', async () => {
    const { replay } = await syntheticReplay()
    const t = new MatchTrack(replay.metadata)
    t.acceptHistory(replay.frames, 1)
    const walk = (o: unknown, depth = 0): number => {
      if (depth > 3 || o === null || typeof o !== 'object') return 0
      let n = 0
      for (const v of Object.values(o as Record<string, unknown>)) { if (Array.isArray(v) && v.length >= replay.frames.length && typeof v[0] === 'object' && v[0] !== null && 'players' in (v[0] as object)) n++; n += walk(v, depth + 1) }
      return n
    }
    expect(walk(t)).toBe(0) // no array of frames hangs off the track
    expect(t.frameCount).toBe(replay.frames.length)
  })

  it('request-rate cap: the governor never grants more than the ceiling in any window, clamps a faster request, and waits instead of failing', async () => {
    expect(PLUGIN_RATE_CAP).toEqual({ requests: 4, perMs: 1000 })
    let now = 0
    const grants: number[] = []
    const g = new RequestGovernor({ now: () => now, sleep: async (ms) => { now += ms } })
    await Promise.all(Array.from({ length: 60 }, async () => { await g.acquire(); grants.push(now) }))
    expect(grants).toHaveLength(60)
    for (let i = 0; i < grants.length; i++) expect(grants.filter((t) => t > grants[i]! - 1000 && t <= grants[i]!).length).toBeLessThanOrEqual(4)
    expect(grants.at(-1)!).toBeGreaterThanOrEqual(14_000) // 60 requests at 4/s cannot finish sooner
    // a caller cannot ask for more
    const greedy = new RequestGovernor({ requests: 1000, perMs: 1 })
    expect(greedy.requests).toBe(4)
    expect(greedy.requests / greedy.perMs).toBeLessThanOrEqual(4 / 1000)
    const slow = new RequestGovernor({ requests: 2, perMs: 10_000 })
    expect(slow.stats().cap).toEqual({ requests: 2, perMs: 10_000 })
  })

  it('request-rate cap on the wire: a real governor spaces real requests; the plugin never sees more than 4 inside any 950 ms window', async () => {
    const { replay } = await syntheticReplay()
    const plugin = new FakePlugin(replay)
    await plugin.start()
    const client = new LocalPluginClient({ port: plugin.boundPort }) // default governor: the real cap on the real clock
    plugin.advance(10)
    await Promise.all(Array.from({ length: 9 }, () => client.getRaw('/api/health')))
    const t = plugin.hits.map((h) => h.t)
    expect(t).toHaveLength(9)
    for (const x of t) expect(t.filter((y) => y > x - 950 && y <= x).length).toBeLessThanOrEqual(4)
    expect(Math.max(...t) - Math.min(...t)).toBeGreaterThanOrEqual(1700) // 9 requests at 4 per second
    await plugin.stop()
  }, 20_000)

  it('a long first sync of many pages stays under the cap on the shared clock (virtual time)', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay, { pageSize: 10, maxPagesPerSync: 30 })
    r.plugin.advanceTo(replay.frames.length)
    const t0 = r.time.now
    await r.reader.refresh()
    const requests = r.client.requestsSent
    expect(requests).toBeGreaterThan(10)
    // `requests` requests at 4 per second cannot take less virtual time than this
    expect(r.time.now - t0).toBeGreaterThanOrEqual(Math.floor((requests - 4) / 4) * 1000)
    await r.close()
  })
})

describe('[S1][MODELLED] loopback only: no host is accepted and nothing configures one', () => {
  it('every request goes to 127.0.0.1; absolute URLs, other hosts and unlisted paths are refused before a socket opens', async () => {
    const urls: string[] = []
    const client = new LocalPluginClient({ fetchImpl: async (u) => { urls.push(String(u)); return new Response('{}') } })
    expect((await client.getRaw('/api/health')).ok).toBe(true)
    for (const bad of ['http://example.com/api/health', '//example.com/api/health', '/api/../etc/passwd', '/api/health@evil.example', '/admin', '/api/match/frames?x=%0d%0a', 'api/health']) {
      expect(await client.getRaw(bad), bad).toMatchObject({ ok: false, kind: 'refused' })
    }
    expect(urls).toEqual(['http://127.0.0.1:16726/api/health'])
    expect(client.host).toBe('127.0.0.1')
    expect(client.webSocketUrl).toBe('ws://127.0.0.1:16726/ws')
  })

  it('no environment variable, option or config key changes the host: the client reads none, and its options have no host field', async () => {
    const before = { ...process.env }
    process.env.FMMI_LIVE_HOST = 'evil.example'; process.env.FMMI_HOST = 'evil.example'; process.env.HTTP_PROXY = 'http://evil.example:3128'
    try {
      const urls: string[] = []
      const client = new LocalPluginClient({ fetchImpl: async (u) => { urls.push(String(u)); return new Response('{}') } })
      await client.getRaw('/api/health')
      expect(urls).toEqual(['http://127.0.0.1:16726/api/health'])
      // @ts-expect-error a host option does not exist; passing one has no effect
      const withHost = new LocalPluginClient({ host: 'evil.example', fetchImpl: async (u) => { urls.push(String(u)); return new Response('{}') } })
      await withHost.getRaw('/api/health')
      expect(urls[1]).toBe('http://127.0.0.1:16726/api/health')
    } finally { for (const k of ['FMMI_LIVE_HOST', 'FMMI_HOST', 'HTTP_PROXY']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] } }
    const src = readFileSync(new URL('../../packages/live/src/client.ts', import.meta.url), 'utf8') + readFileSync(new URL('../../packages/live/src/reader.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/process\.env/)
    expect(() => new LocalPluginClient({ port: 0 })).toThrow()
  })

  it('a redirect to another host is refused, an oversized body is cut off, and a non-JSON body is a typed failure', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.faults = { redirect: true }
    expect(await r.client.getRaw('/api/health')).toMatchObject({ ok: false, kind: 'unreachable' })
    r.plugin.faults = {}
    const tiny = new LocalPluginClient({ port: r.plugin.boundPort, governor: r.governor, maxBytes: 20 })
    expect(await tiny.getRaw('/api/health')).toMatchObject({ ok: false, kind: 'too_large' })
    const notJson = new LocalPluginClient({ port: r.plugin.boundPort, governor: r.governor, fetchImpl: async () => new Response('<html>', { status: 200 }) })
    expect(await notJson.getRaw('/api/health')).toMatchObject({ ok: false, kind: 'bad_json' })
    await r.close()
  })
})
