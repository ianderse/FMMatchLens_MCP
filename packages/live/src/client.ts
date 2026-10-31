import type { z } from 'zod'
import { LIVE_HOST, LIVE_PORT, assertPluginPath, httpBase, wsUrl } from './endpoint.ts'
import { RequestGovernor } from './governor.ts'

export type FetchFailure =
  | 'unreachable'      // connection refused / reset: the plugin (or the game) is not there
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'bad_json'
  | 'schema_mismatch'  // the response is not what the schema expects: the endpoint changed or is not what we modelled
  | 'refused'          // the request was not sent (path not allowed)

export type Fetched<T> = { ok: true; data: T; bytes: number } | { ok: false; kind: FetchFailure; status?: number; detail: string }

export interface ClientOptions {
  /** TEST ONLY: the loopback port of the fake plugin. The host is fixed; no entry point of this repository passes a port. */
  port?: number
  governor?: RequestGovernor
  timeoutMs?: number
  /** Response body cap. A response over it is `too_large`, never buffered whole. */
  maxBytes?: number
  fetchImpl?: typeof fetch
}

export const DEFAULT_TIMEOUT_MS = 5000
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/**
 * Loopback-only HTTP reader. Every request goes through the rate governor, to `127.0.0.1` only, with redirects refused, a timeout, a body
 * size cap and schema validation. It never throws for an upstream problem: it returns a typed failure so callers can degrade.
 */
export class LocalPluginClient {
  readonly governor: RequestGovernor
  private readonly port: number
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly fetchImpl: typeof fetch
  private requestCount = 0

  constructor(o: ClientOptions = {}) {
    const port = o.port ?? LIVE_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port')
    this.port = port
    this.governor = o.governor ?? new RequestGovernor()
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES
    this.fetchImpl = o.fetchImpl ?? fetch
  }

  get host(): string { return LIVE_HOST }
  get requestsSent(): number { return this.requestCount }
  get webSocketUrl(): string { return wsUrl(this.port) }

  async getJson<S extends z.ZodType>(path: string, schema: S): Promise<Fetched<z.infer<S>>> {
    const raw = await this.getRaw(path)
    if (!raw.ok) return raw
    const parsed = schema.safeParse(raw.data)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return { ok: false, kind: 'schema_mismatch', detail: `${first ? first.path.join('.') || '(root)' : '(root)'}: ${first?.message ?? 'invalid'}`.slice(0, 200) }
    }
    return { ok: true, data: parsed.data, bytes: raw.bytes }
  }

  /** The JSON body without schema validation (used only by `fmmi live capture`, which sanitises it itself). */
  async getRaw(path: string): Promise<Fetched<unknown>> {
    try { assertPluginPath(path) } catch { return { ok: false, kind: 'refused', detail: 'path_not_allowed' } }
    const url = new URL(path, httpBase(this.port))
    // Defence in depth: whatever the path was, the request goes to the loopback host and nowhere else.
    if (url.hostname !== LIVE_HOST || url.protocol !== 'http:') return { ok: false, kind: 'refused', detail: 'host_not_allowed' }
    // A pooled keep-alive connection can be dead after the game restarts: a connection error is retried ONCE on a fresh connection. Both
    // attempts pass the governor, so a plugin that really is down costs two capped requests, not a burst.
    for (let attempt = 0; ; attempt++) {
      await this.governor.acquire()
      this.requestCount++
      try {
        return await this.once(url)
      } catch (e) {
        const name = e instanceof Error ? e.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, kind: 'timeout', detail: 'timeout' }
        if (attempt >= 1) return { ok: false, kind: 'unreachable', detail: 'connection_failed' }
      }
    }
  }

  private async once(url: URL): Promise<Fetched<unknown>> {
    const res = await this.fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { ok: false, kind: 'http_status', status: res.status, detail: `http ${res.status}` } }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maxBytes) { await res.body?.cancel().catch(() => undefined); return { ok: false, kind: 'too_large', detail: 'declared_length' } }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, kind: 'bad_json', detail: 'no_body' }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > this.maxBytes) { await reader.cancel().catch(() => undefined); return { ok: false, kind: 'too_large', detail: 'body_length' } }
      chunks.push(value)
    }
    let data: unknown
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return { ok: false, kind: 'bad_json', detail: 'not_json' } }
    return { ok: true, data, bytes: total }
  }
}
