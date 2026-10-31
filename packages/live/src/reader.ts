import { LocalPluginClient } from './client.ts'
import type { FetchFailure } from './client.ts'
import { ArchivesSchema, CurrentSchema, EnvelopeSchema, FormationSliceSchema, FramesSliceSchema, FrameSchema, HealthSchema, MetaSchema, asFrame, asMetadata } from './schemas.ts'
import { MatchTrack } from './track.ts'

export type LiveStateName = 'fresh' | 'stale' | 'not_connected' | 'not_in_match'

/** The minimal WebSocket surface the reader uses (the global `WebSocket` satisfies it; tests pass their own). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}

export interface LiveReaderOptions {
  client: LocalPluginClient
  /** Wall clock in ms. Compared with the plugin's `capturedUnixMilliseconds` (same machine). */
  now?: () => number
  /** A latest frame captured longer ago than this is `stale`. Game speed varies, so this is real time, never game time. */
  staleAfterMs?: number
  /** Minimum gap between two syncs: tool calls inside it are served from the cache. */
  minSyncIntervalMs?: number
  /** The socket is opened on demand and closed after this long without a live tool call. */
  idleCloseMs?: number
  /** At most one socket frame is parsed per this interval; the rest are dropped (coalesced). Formation messages are never dropped. */
  wsMinParseIntervalMs?: number
  pageSize?: number
  maxPagesPerSync?: number
  reconnect?: { minMs: number; maxMs: number }
  openSocket?: (url: string) => SocketLike
  useWebSocket?: boolean
  log?: (event: string, fields?: Record<string, string | number | boolean | null>) => void
}

export interface LiveView {
  state: LiveStateName
  /** Stable token for why the state is not `fresh`. */
  reason: string | null
  upstreamMatchId: string | null
  /** The newest frame seen from any route. */
  latest: { tick: number; period: number; displayMinute: number; captureAgeMs: number; receivedAgeMs: number } | null
  /** The frame the analysis is built from (always a history frame, never the socket). */
  snapshot: { tick: number; period: number; displayMinute: number; frames: number; lagTicks: number } | null
  connection: {
    http: 'ok' | 'failed' | 'never'
    lastFailure: FetchFailure | null
    socket: 'open' | 'closed' | 'never'
    reconnects: number
    everConnected: boolean
  }
  metadata: 'valid' | 'invalid' | 'missing'
  plugin: { status: string; version: string; game: string | null; gameVersion: string | null } | null
  counters: {
    framesAccepted: number; duplicateFrames: number; outOfOrderFrames: number; otherMatchFrames: number; periodRegressions: number
    staleMetadata: number; formationEntries: number; duplicateFormationEntries: number
    socketMessages: number; socketParsed: number; socketCoalesced: number; socketBad: number; socketStale: number; socketOtherMatch: number
    syncs: number; httpRequests: number
  }
  catchingUp: boolean
}

/**
 * On-demand local live reader (spec 2.1, 9.2). Nothing runs until a live tool asks: then it connects, synchronises, and answers from
 * a cache. There is no polling loop: a sync happens at most once per `minSyncIntervalMs`, only when a caller asks, and every HTTP request
 * passes the rate governor. The WebSocket is opened on demand, treated as delta-like (it only advances "latest" and flags that formation
 * changed; history frames from `/api/match/frames` are the only input to the analysis), and closed when idle.
 *
 * On connect and on every reconnect the reader re-reads authoritative metadata and the historical frames from the last accepted tick, so
 * a gap, a duplicate or a reordering on the socket cannot change the analysis. Frames of another match are ignored.
 */
export class LiveReader {
  private readonly client: LocalPluginClient
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly minSyncIntervalMs: number
  private readonly idleCloseMs: number
  private readonly wsMinParseIntervalMs: number
  private readonly maxPagesPerSync: number
  private readonly reconnectCfg: { minMs: number; maxMs: number }
  private readonly openSocket: (url: string) => SocketLike
  private readonly useWebSocket: boolean
  private readonly log: NonNullable<LiveReaderOptions['log']>
  private pageSize: number

  private track: MatchTrack | null = null
  private health: { status: string; version: string; game: string | null; gameVersion: string | null; inMatch: boolean } | null = null
  private http: 'ok' | 'failed' | 'never' = 'never'
  private lastFailure: FetchFailure | null = null
  private everConnected = false
  private metadata: 'valid' | 'invalid' | 'missing' = 'missing'
  private lastSyncAt = -Infinity
  private syncing: Promise<void> | null = null
  private needMeta = true
  private needFormation = true
  private generation = 0
  private reason: string | null = 'never_connected'
  private notInMatch = false
  private syncs = 0

  private socket: SocketLike | null = null
  private socketState: 'open' | 'closed' | 'never' = 'never'
  private reconnects = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private lastParseAt = -Infinity
  private ws = { messages: 0, parsed: 0, coalesced: 0, bad: 0, stale: 0, otherMatch: 0 }
  private catchingUp = false

  constructor(o: LiveReaderOptions) {
    this.client = o.client
    this.now = o.now ?? (() => Date.now())
    this.staleAfterMs = o.staleAfterMs ?? 10_000
    this.minSyncIntervalMs = o.minSyncIntervalMs ?? 1500
    this.idleCloseMs = o.idleCloseMs ?? 120_000
    this.wsMinParseIntervalMs = o.wsMinParseIntervalMs ?? 500
    this.pageSize = o.pageSize ?? 400
    this.maxPagesPerSync = o.maxPagesPerSync ?? 12
    this.reconnectCfg = o.reconnect ?? { minMs: 2000, maxMs: 30_000 }
    this.reconnectDelay = this.reconnectCfg.minMs
    this.openSocket = o.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    this.useWebSocket = o.useWebSocket ?? true
    this.log = o.log ?? (() => undefined)
  }

  // ------------------------------------------------------------------ lifecycle

  /** Called by every live tool call: marks the reader active (opens the socket if needed), then synchronises unless the cache is fresh enough. */
  async refresh(opts: { force?: boolean } = {}): Promise<LiveView> {
    this.touch()
    if (this.syncing) await this.syncing
    else if (opts.force || this.now() - this.lastSyncAt >= this.minSyncIntervalMs || !this.track) {
      this.syncing = this.sync().finally(() => { this.syncing = null })
      await this.syncing
    }
    return this.view()
  }

  /** Cached answer, no network. */
  view(): LiveView { return this.buildView() }

  close(): void {
    this.active = false
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.idleTimer = this.reconnectTimer = null
    this.dropSocket()
  }

  private touch(): void {
    this.active = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.log('live_idle_close'); this.active = false; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.dropSocket() }, this.idleCloseMs)
    this.idleTimer.unref?.()
    if (this.useWebSocket && !this.socket && !this.reconnectTimer) this.connectSocket()
  }

  // ------------------------------------------------------------------ socket

  private connectSocket(): void {
    let s: SocketLike
    try { s = this.openSocket(this.client.webSocketUrl) } catch { this.scheduleReconnect(); return }
    this.socket = s
    s.onopen = () => {
      if (this.socket !== s) return
      this.socketState = 'open'
      this.reconnectDelay = this.reconnectCfg.minMs
      // Reconnect = reconcile: the socket is delta-like, so metadata, formation and history are re-read from the HTTP API.
      this.needMeta = true; this.needFormation = true
      this.generation++
      this.lastSyncAt = -Infinity
      this.log('live_socket_open')
    }
    s.onmessage = (ev) => { if (this.socket === s) this.onMessage(ev.data) }
    s.onerror = () => { /* the close handler follows */ }
    s.onclose = () => {
      if (this.socket !== s) return
      this.socket = null
      this.socketState = 'closed'
      this.generation++
      this.log('live_socket_closed')
      if (this.active) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectCfg.maxMs, this.reconnectDelay * 2)
    this.reconnects++
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.active && !this.socket) this.connectSocket() }, delay)
    this.reconnectTimer.unref?.()
  }

  private dropSocket(): void {
    const s = this.socket
    this.socket = null
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close() } catch { /* already closed */ } }
    if (this.socketState === 'open') this.socketState = 'closed'
  }

  /** Socket messages never write the analysis. They advance "latest", flag a formation change, and signal a different match. */
  private onMessage(data: unknown): void {
    this.ws.messages++
    if (typeof data !== 'string' || data.length > 8 * 1024 * 1024) { this.ws.bad++; return }
    const t = this.now()
    // Cheap pre-check for the common message so a tick burst costs one substring test, not a full parse.
    const isTick = data.length > 0 && data.includes('"realtime_tick"')
    if (isTick && t - this.lastParseAt < this.wsMinParseIntervalMs) { this.ws.coalesced++; return }
    let env: unknown
    try { env = JSON.parse(data) } catch { this.ws.bad++; return }
    const e = EnvelopeSchema.safeParse(env)
    if (!e.success) { this.ws.bad++; return }
    if (e.data.type === 'realtime_tick') {
      this.lastParseAt = t
      const f = FrameSchema.safeParse(e.data.payload)
      if (!f.success) { this.ws.bad++; return }
      this.ws.parsed++
      this.onSocketFrame(f.data, t)
    } else if (e.data.type === 'formation_changed') {
      const s = FormationSliceSchema.safeParse(e.data.payload)
      if (!s.success) { this.ws.bad++; return }
      if (s.data.matchId && this.track && s.data.matchId !== this.track.matchId) { this.ws.otherMatch++; return }
      if (!this.track) { this.needFormation = true; return }
      const r = this.track.acceptFormation(s.data.entries)
      if (r.gap) this.needFormation = true
      if (r.changed) this.needMeta = true // the plugin's metadata is authoritative for roles: refresh it on the next sync
    }
    // Any other message type is ignored: the envelope list is not a versioned contract.
  }

  private onSocketFrame(f: ReturnType<typeof FrameSchema.parse>, receivedMs: number): void {
    if (!this.track) { this.needMeta = true; return }
    if (f.matchId !== this.track.matchId) {
      // A different match is on the socket: do not mix it in; the next sync re-reads metadata and starts a new track if the plugin moved on.
      this.ws.otherMatch++
      this.needMeta = true
      this.lastSyncAt = -Infinity
      return
    }
    const r = this.track.noteLatest(f, receivedMs)
    if (r === 'stale') this.ws.stale++
  }

  // ------------------------------------------------------------------ synchronisation

  /** Only a transport failure means the plugin is not there. A schema, JSON, size or status problem means it answered something we cannot use. */
  private fail(kind: FetchFailure): void {
    if (kind === 'unreachable' || kind === 'timeout') this.http = 'failed'
    this.lastFailure = kind
  }

  private async sync(retried = false): Promise<void> {
    this.syncs++
    this.lastSyncAt = this.now()
    const sockedRecent = this.socketState === 'open' && this.track?.latest !== undefined && this.track?.latest !== null && this.now() - this.track.latest.receivedMs < 2000

    // 1. Is the plugin there, and is a match running? (Skipped while the socket delivered a frame in the last 2 s.)
    if (!sockedRecent || !this.health) {
      const h = await this.client.getJson('/api/health', HealthSchema)
      if (!h.ok) {
        this.fail(h.kind)
        this.reason = h.kind === 'schema_mismatch' ? 'incompatible_endpoint:health' : h.kind === 'unreachable' || h.kind === 'timeout' ? (this.everConnected ? 'plugin_unreachable_after_connect' : 'plugin_unreachable') : `health_${h.kind}`
        this.health = null
        return
      }
      this.http = 'ok'; this.lastFailure = null; this.everConnected = true; this.reason = null
      this.health = { status: h.data.status, version: h.data.pluginVersion, game: h.data.game ?? null, gameVersion: h.data.gameVersion ?? null, inMatch: h.data.inMatch }
    }
    if (!this.health!.inMatch) { this.notInMatch = true; this.reason = 'no_match_in_progress'; return }
    this.notInMatch = false

    // 2. Authoritative metadata (first sync, reconnect, new match or formation change).
    if (this.needMeta || !this.track) {
      const m = await this.client.getJson('/api/match/meta', MetaSchema)
      if (!m.ok) {
        this.fail(m.kind)
        if (m.kind === 'schema_mismatch' || m.kind === 'bad_json') { this.metadata = this.track ? 'invalid' : 'missing'; this.reason = 'metadata_invalid' } else this.reason = 'metadata_unavailable'
        if (!this.track) return
      } else if (m.data === null) {
        this.notInMatch = true; this.reason = 'no_match_in_progress'; return
      } else {
        const meta = asMetadata(m.data)
        if (!this.track || this.track.matchId !== meta.matchId) {
          this.track = new MatchTrack(meta)
          this.generation++
          this.needFormation = true
          this.log('live_track_started')
        } else this.track.acceptMetadata(meta)
        this.metadata = 'valid'
        this.needMeta = false
      }
    }
    const track = this.track
    if (!track) return

    // 3. The newest frame (cheap) so freshness is judged from the plugin, not from the socket alone.
    const cur = await this.client.getJson('/api/match/current', CurrentSchema)
    if (cur.ok && cur.data) {
      if (cur.data.matchId !== track.matchId) { this.needMeta = true; this.reason = 'match_changed'; this.lastSyncAt = -Infinity; return retried ? undefined : this.sync(true) }
      track.noteLatest(cur.data, this.now())
    } else if (!cur.ok) { this.fail(cur.kind); this.reason = cur.kind === 'schema_mismatch' ? 'incompatible_endpoint:current' : 'current_unavailable' }

    // 4. Historical frames after the last accepted tick: the only input to the analysis.
    this.catchingUp = false
    for (let page = 0; page < this.maxPagesPerSync; page++) {
      const r = await this.client.getJson(`/api/match/frames?fromTick=${track.lastTick + 1}&stride=1&limit=${this.pageSize}`, FramesSliceSchema)
      if (!r.ok) {
        if (r.kind === 'too_large' && this.pageSize > 25) { this.pageSize = Math.max(25, Math.floor(this.pageSize / 2)); page--; continue }
        this.fail(r.kind); this.reason = r.kind === 'schema_mismatch' ? 'incompatible_endpoint:frames' : 'frames_unavailable'
        break
      }
      if (this.track !== track) return
      if (r.data.matchId && r.data.matchId !== track.matchId) { this.needMeta = true; this.reason = 'match_changed'; this.lastSyncAt = -Infinity; return retried ? undefined : this.sync(true) }
      if (r.data.totalFrameCount > 0 && r.data.totalFrameCount < track.frameCount) {
        // The plugin holds fewer frames than we do: its buffer was reset. Rebuild from the plugin rather than mix two histories.
        this.track = null; this.needMeta = true; this.reason = 'plugin_history_reset'; this.lastSyncAt = -Infinity
        return retried ? undefined : this.sync(true)
      }
      const added = track.acceptHistory(r.data.frames.map(asFrame), this.now())
      if (r.data.frames.length < this.pageSize || added === 0) break
      if (page === this.maxPagesPerSync - 1) this.catchingUp = true
    }

    // 5. Formation history (first sync, reconnect, or when the socket reported a change or a gap).
    if (this.needFormation) {
      let ok = true
      for (let page = 0; page < 8 && ok; page++) {
        const r = await this.client.getJson(`/api/match/formation/history?fromIndex=${track.formationNext}&limit=256`, FormationSliceSchema)
        if (!r.ok) { this.fail(r.kind); this.reason = r.kind === 'schema_mismatch' ? 'incompatible_endpoint:formation' : 'formation_unavailable'; ok = false; break }
        if (r.data.matchId && r.data.matchId !== track.matchId) { ok = false; break }
        const a = track.acceptFormation(r.data.entries)
        if (a.gap) { ok = false; break }
        if (!a.changed || track.formationNext >= r.data.totalEntryCount) break
      }
      if (ok) this.needFormation = false
    }
  }

  // ------------------------------------------------------------------ view

  /** The match being tracked, for the analysis builders. */
  get tracked(): MatchTrack | null { return this.track }

  /** One-shot archive cross-check (info only): is the plugin's own archive of this match still open? */
  async archiveListing(upstreamMatchId: string): Promise<{ listed: boolean; ended: boolean | null; frameCount: number | null } | null> {
    const r = await this.client.getJson('/api/archives?page=1&pageSize=20', ArchivesSchema)
    if (!r.ok) return null
    const hit = r.data.items.find((i) => i.matchId === upstreamMatchId)
    return hit ? { listed: true, ended: hit.ended ?? null, frameCount: hit.frameCount ?? null } : { listed: false, ended: null, frameCount: null }
  }

  private buildView(): LiveView {
    const t = this.track
    const now = this.now()
    const latest = t?.latest ?? null
    const snap = t?.snapshotStamp ?? null
    let state: LiveStateName
    let reason = this.reason
    if (this.http === 'failed' || this.http === 'never') { state = 'not_connected'; reason = reason ?? 'never_connected' }
    else if (this.notInMatch) { state = 'not_in_match'; reason = reason ?? 'no_match_in_progress' }
    // The plugin is reachable and says a match is running, but nothing usable has been read (bad metadata, a changed endpoint, no frame yet).
    else if (!t || !latest || !snap) { state = 'stale'; reason = reason ?? 'no_frame_yet' }
    else if (this.metadata !== 'valid') { state = 'stale'; reason = reason ?? 'metadata_invalid' }
    else if (now - latest.capturedMs > this.staleAfterMs) { state = 'stale'; reason = 'latest_frame_too_old' }
    else { state = 'fresh'; reason = null }
    const c = t?.counters
    return {
      state, reason, upstreamMatchId: t?.matchId ?? null,
      latest: latest && t ? { tick: latest.tick, period: latest.period, displayMinute: Math.round((latest.displayTick / 240) * 100) / 100, captureAgeMs: Math.max(0, now - latest.capturedMs), receivedAgeMs: Math.max(0, now - latest.receivedMs) } : null,
      snapshot: snap && latest ? { ...snap, frames: t!.frameCount, lagTicks: Math.max(0, latest.tick - snap.tick) } : null,
      connection: { http: this.http, lastFailure: this.lastFailure, socket: this.socketState, reconnects: this.reconnects, everConnected: this.everConnected },
      metadata: this.metadata,
      plugin: this.health ? { status: this.health.status, version: this.health.version, game: this.health.game, gameVersion: this.health.gameVersion } : null,
      counters: {
        framesAccepted: c?.framesAccepted ?? 0, duplicateFrames: c?.duplicateFrames ?? 0, outOfOrderFrames: c?.outOfOrderFrames ?? 0, otherMatchFrames: c?.otherMatchFrames ?? 0,
        periodRegressions: c?.periodRegressions ?? 0, staleMetadata: c?.staleMetadata ?? 0, formationEntries: c?.formationEntries ?? 0, duplicateFormationEntries: c?.duplicateFormationEntries ?? 0,
        socketMessages: this.ws.messages, socketParsed: this.ws.parsed, socketCoalesced: this.ws.coalesced, socketBad: this.ws.bad, socketStale: this.ws.stale, socketOtherMatch: this.ws.otherMatch,
        syncs: this.syncs, httpRequests: this.client.requestsSent,
      },
      catchingUp: this.catchingUp,
    }
  }
}

