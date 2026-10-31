// TEST-ONLY fake FMMatchLens plugin. MODELLED, NOT OBSERVED.
//
// This server stands in for the plugin on loopback so the live reader can be tested with the game closed. Its routes, JSON shapes and
// WebSocket envelopes are MODELLED from the vendored v0.7.0 source (vendor/fmmatchlens-v0.7.0/frontend/src/api/realtimeMatch.ts): the
// request paths and query parameters the upstream dashboard uses, the response types it casts to, and the `realtime_tick` and
// `formation_changed` envelopes it handles. Only /api/health, /api/archives and /api/match/status have ever been seen from a real plugin
// (docs/data-coverage.md section 10), and even those are reproduced here only for their field names. The frame CONTENT is real where a
// real recording is replayed (decoded by the vendored archive parser from tests/fixtures/local) and synthetic otherwise.
// Nothing in this file proves the real plugin behaves this way. LocalApiServer.cs and WebSocketHub.cs were not vendored and were not read.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { parseArchiveFile } from '../../packages/fmlens-adapter/src/upstream/archiveParser.ts'
import type { RealtimeFrame, RealtimeMatchMetadata } from '../../packages/fmlens-adapter/src/upstream/realtimeTypes.ts'

export interface Replay {
  matchId: string
  frames: RealtimeFrame[]
  /** The final merged metadata: the full roster, including players added after the opening revision. */
  metadata: RealtimeMatchMetadata
  /** Every metadata revision in order; revision i+1 becomes formation entry i. */
  revisions: RealtimeMatchMetadata[]
  /** Metadata revisions after the first, turned into formation entries. */
  formation: Array<{ index: number; tick: number; displayTick: number; players: unknown[] }>
  source: 'real_recording' | 'synthetic_archive'
  /** First tick at which each player was on the pitch. A player not yet on it (a substitute) is served with NULL assignments, as the real plugin does (2026-10-31). */
  firstOnTick: Map<number, number>
}

export async function loadReplay(file: string, source: Replay['source']): Promise<Replay> {
  const bytes = readFileSync(file)
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = await parseArchiveFile(ab, 'replay.fmlens', {})
  const timeline = parsed.metadataTimeline
  const firstOnTick = new Map<number, number>()
  for (const f of parsed.frames) for (const p of f.players) if (p.isOnPitch && !firstOnTick.has(p.playerId)) firstOnTick.set(p.playerId, f.tick)
  const formation = timeline.slice(1).map((m, i) => ({
    index: i, tick: m.capturedTick, displayTick: m.capturedTick,
    players: m.players.map((p) => ({
      slot: p.slot, playerId: p.playerId, team: p.team, isSubstitute: false, isOnPitch: true,
      ...assignmentsAt(firstOnTick, m.capturedTick, p),
    })),
  }))
  return { matchId: parsed.archive.matchId, frames: parsed.frames, metadata: parsed.metadata ?? timeline[0]!, revisions: timeline, formation, source, firstOnTick }
}

/** The real plugin sends null in and out of possession assignments for a player who has not been on the pitch yet. */
function assignmentsAt(firstOn: ReadonlyMap<number, number>, tick: number, p: { playerId: number; inPossession?: unknown; outOfPossession?: unknown }) {
  const on = (firstOn.get(p.playerId) ?? Infinity) <= tick
  return { inPossession: on ? p.inPossession : null, outOfPossession: on ? p.outOfPossession : null }
}

/** Wire form of a frame: the archive-only rating payload (BigInt, Uint8Array) is not part of the live JSON. */
function wire(f: RealtimeFrame, capturedMs: number): unknown {
  const players = f.players.map((p) => {
    const { archiveRatingInputs: _a, ratingContribution: _c, ...rest } = p as unknown as Record<string, unknown>
    return rest
  })
  return { ...f, players, capturedUnixMilliseconds: capturedMs }
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function textFrame(s: string): Buffer {
  const body = Buffer.from(s, 'utf8')
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(body.length), 2); return b })()
  return Buffer.concat([head, body])
}

export interface Faults {
  /** Replace the /api/match/meta body (for example garbage). */
  metaBody?: unknown
  /** Answer these paths with an HTTP status. */
  status?: Record<string, number>
  /** Reverse the frames inside every page. */
  reversePages?: boolean
  /** Repeat the last frame of every page at the start of the next one (overlapping pages). */
  overlapPages?: number
  /** Replace the /api/match/frames body (for example a changed shape). */
  framesBody?: unknown
  /** Delay (ms) before answering every route. */
  delayMs?: number
  /** Answer every route with a 302 to another host (the client must refuse to follow it). */
  redirect?: boolean
}

export class FakePlugin {
  readonly replay: Replay
  /** The capture clock: frames get this as `capturedUnixMilliseconds` when they are revealed. */
  clock: () => number = () => Date.now()
  faults: Faults = {}
  inMatch = true
  /** Number of replay frames revealed so far (the "live" position). */
  revealed = 0
  formationRevealed = 0
  readonly hits: Array<{ path: string; t: number }> = []
  readonly sockets = new Set<Duplex>()
  private server: Server | null = null
  private captured: number[] = []
  private port = 0
  private listening = false

  constructor(replay: Replay) { this.replay = replay }

  get url(): string { return `http://127.0.0.1:${this.port}` }
  get boundPort(): number { return this.port }
  get totalFrames(): number { return this.replay.frames.length }

  /** Reveal `n` more frames and stamp them with the capture clock. */
  advance(n: number): void {
    const to = Math.min(this.totalFrames, this.revealed + n)
    for (let i = this.revealed; i < to; i++) this.captured[i] = this.clock()
    this.revealed = to
  }
  advanceTo(frameIndexExclusive: number): void { this.advance(frameIndexExclusive - this.revealed) }
  revealFormation(n = 1): void { this.formationRevealed = Math.min(this.replay.formation.length, this.formationRevealed + n) }

  latest(): RealtimeFrame | null { return this.revealed > 0 ? this.replay.frames[this.revealed - 1]! : null }
  latestWire(): unknown { const f = this.latest(); return f ? wire(f, this.captured[this.revealed - 1]!) : null }

  /** Push the newest revealed frame to every connected socket as a `realtime_tick` envelope. */
  pushTick(frameIndex = this.revealed - 1): void {
    if (frameIndex < 0) return
    const f = this.replay.frames[frameIndex]!
    this.broadcast(JSON.stringify({ type: 'realtime_tick', payload: wire(f, this.captured[frameIndex] ?? this.clock()) }))
  }
  pushFormation(fromIndex = this.formationRevealed - 1): void {
    const entries = this.replay.formation.slice(Math.max(0, fromIndex), this.formationRevealed)
    this.broadcast(JSON.stringify({ type: 'formation_changed', payload: { matchId: this.replay.matchId, status: 'live', totalEntryCount: this.formationRevealed, entries } }))
  }
  broadcast(text: string): void { const f = textFrame(text); for (const s of this.sockets) { try { s.write(f) } catch { /* closed */ } } }
  dropSockets(): void { for (const s of [...this.sockets]) s.destroy(); this.sockets.clear() }

  async start(port = 0): Promise<void> {
    if (this.listening) return
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.on('upgrade', (req, socket) => {
      if (req.url !== '/ws') { socket.destroy(); return }
      const key = String(req.headers['sec-websocket-key'] ?? '')
      const accept = createHash('sha1').update(key + GUID).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => this.sockets.delete(socket))
      socket.on('data', (d: Buffer) => { if ((d[0]! & 0x0f) === 8) { try { socket.write(Buffer.from([0x88, 0])); socket.end() } catch { /* closed */ } } })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
    this.listening = true
  }

  /** Simulate the game process exiting: the port stops answering and every socket drops. */
  async stop(): Promise<void> {
    if (!this.listening) return
    this.dropSockets()
    const s = this.server!
    this.listening = false
    await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections?.() })
    this.server = null
  }
  async restart(): Promise<void> { await this.start(this.port) }

  hitsFor(prefix: string): number { return this.hits.filter((h) => h.path.startsWith(prefix)).length }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    this.hits.push({ path: path + url.search, t: performance.now() })
    if (this.faults.delayMs) await new Promise((r) => setTimeout(r, this.faults.delayMs))
    const send = (code: number, body: unknown) => { const t = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
    if (this.faults.redirect) { res.writeHead(302, { location: 'http://example.invalid/api/health' }); res.end(); return }
    const forced = this.faults.status?.[path]
    if (forced) { send(forced, { error: 'forced' }); return }
    const r = this.replay
    const f = this.latest()
    if (path === '/api/health') {
      send(200, { status: this.inMatch ? 'recording' : 'ended', pluginVersion: '0.7.0', game: 'Football Manager', gameVersion: '27.0', inMatch: this.inMatch, tick: f?.tick ?? 0, frameCount: this.revealed, webSocketConnections: this.sockets.size })
    } else if (path === '/api/archives') {
      send(200, { page: 1, pageSize: 20, totalCount: 1, items: [{ matchId: r.matchId, ended: !this.inMatch, frameCount: this.revealed, firstTick: r.frames[0]?.tick ?? 0, lastTick: f?.tick ?? 0 }] })
    } else if (path === '/api/match/status') {
      send(200, { status: this.inMatch ? 'recording' : 'ended', matchId: r.matchId, period: f?.period ?? 1, lastTick: f?.tick ?? 0, missingTickCount: 0, duplicateTickCount: 0, outOfOrderTickCount: 0 })
    } else if (path === '/api/match/meta') {
      send(200, this.faults.metaBody !== undefined ? this.faults.metaBody : this.inMatch || this.revealed > 0 ? this.metaNow() : null)
    } else if (path === '/api/match/current') {
      send(200, this.latestWire())
    } else if (path === '/api/match/frames') {
      if (this.faults.framesBody !== undefined) { send(200, this.faults.framesBody); return }
      const from = Number(url.searchParams.get('fromTick') ?? 0), to = url.searchParams.get('toTick')
      const limit = Math.min(5000, Number(url.searchParams.get('limit') ?? 500))
      let idx: number[] = []
      for (let i = 0; i < this.revealed && idx.length < limit; i++) {
        const t = r.frames[i]!.tick
        if (t >= from && (to === null || t <= Number(to))) idx.push(i)
      }
      if (this.faults.overlapPages && idx.length > 0) {
        const first = idx[0]!
        const extra: number[] = []
        for (let k = Math.max(0, first - this.faults.overlapPages); k < first; k++) extra.push(k)
        idx = [...extra, ...idx]
      }
      if (this.faults.reversePages) idx.reverse()
      send(200, { matchId: r.matchId, status: this.inMatch ? 'live' : 'ended', totalFrameCount: this.revealed, frames: idx.map((i) => wire(r.frames[i]!, this.captured[i]!)) })
    } else if (path === '/api/match/formation/history') {
      const from = Number(url.searchParams.get('fromIndex') ?? 0), limit = Number(url.searchParams.get('limit') ?? 256)
      send(200, { matchId: r.matchId, status: this.inMatch ? 'live' : 'ended', totalEntryCount: this.formationRevealed, entries: r.formation.slice(0, this.formationRevealed).filter((e) => e.index >= from).slice(0, limit) })
    } else if (path === '/api/match/momentum/events' || path === '/api/match/momentum/updates') {
      send(200, path.endsWith('events') ? { events: [] } : { updates: [], next: 0 })
    } else send(404, { error: 'not_found' })
  }

  /** Metadata as the plugin would serve it now: the full roster with the role assignments of the latest formation revision revealed so far. */
  private metaNow(): unknown {
    const final = this.replay.metadata
    const rev = this.replay.revisions[Math.min(this.formationRevealed, this.replay.revisions.length - 1)]!
    const byId = new Map(rev.players.map((p) => [p.playerId, p]))
    return {
      ...final, capturedTick: rev.capturedTick,
      players: final.players.map((p) => { const r = byId.get(p.playerId); return { ...p, position: r?.position ?? p.position, ...assignmentsAt(this.replay.firstOnTick, this.latest()?.tick ?? -1, { playerId: p.playerId, inPossession: r?.inPossession, outOfPossession: r?.outOfPossession }) } }),
    }
  }
}
