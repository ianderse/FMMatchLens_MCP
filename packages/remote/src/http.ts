import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
/** Same shape as the mcp package logger; kept local so this package depends on nothing but the SDK. */
export type RemoteLogger = (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => void
const silentLogger: RemoteLogger = () => {}

/**
 * Optional remote transport: MCP over Streamable HTTP (spec 8, 9.3, 10, Slice 5). OFF by default; started only by `fmmi-mcp --http`.
 *
 * Posture:
 *  - It serves the SAME read-only tools as stdio and nothing else. It never proxies to the plugin's loopback port and cannot be
 *    pointed anywhere: the live tools answer from the local reader's analysis, they do not forward requests.
 *  - Binds 127.0.0.1 by default. A non-loopback bind needs an explicit opt-in, a token, an explicit Host allowlist and a stated
 *    private-transport assumption; wildcard addresses are refused. The server speaks plain HTTP: beyond loopback it must sit behind
 *    Tailscale (WireGuard) or a TLS-terminating proxy, which this process cannot verify and the operator therefore has to state.
 *  - A bearer token is ALWAYS required (also on loopback), compared in constant time, never logged, never echoed in a result.
 *  - Strict Host allowlist (DNS-rebinding guard), strict Origin allowlist (a browser request with an unlisted Origin is refused),
 *    per-client rate limit, request-size limits, a request timeout, one route (POST /mcp). Nothing else is served.
 */
export const MIN_TOKEN_LENGTH = 24
export const DEFAULT_PORT = 8787
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_RATE_PER_MINUTE = 120
export const PRIVATE_TRANSPORTS = ['tailscale', 'wireguard', 'tls-proxy', 'ssh-tunnel'] as const
export type PrivateTransport = (typeof PRIVATE_TRANSPORTS)[number]

export interface RemoteConfig {
  host: string
  port: number
  token: string
  /** Explicit opt-in for a non-loopback bind. */
  allowNonLoopback: boolean
  /** The operator's stated assumption about how the traffic is protected beyond loopback. */
  privateTransport: PrivateTransport | null
  /** Host header values accepted in addition to the loopback names (each `name` or `name:port`). Required for a non-loopback bind. */
  allowedHosts: string[]
  /** Origin header values accepted. Empty means any request that carries an Origin header is refused (MCP clients send none). */
  allowedOrigins: string[]
  ratePerMinute: number
  maxBodyBytes: number
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
/**
 * True for any literal IP that normalises to the unspecified address (all interfaces): 0.0.0.0, ::, ::0, the long IPv6 form,
 * ::ffff:0.0.0.0 and any other spelling. Normalised through the URL parser rather than matched as a string.
 */
export function isUnspecifiedAddress(h: string): boolean {
  const bare = h.replace(/^\[|\]$/g, '').split('%')[0]!
  if (isIP(bare) === 0) return false
  try {
    const n = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}`).hostname
    return n === '0.0.0.0' || n === '[::]' || n === '[::ffff:0:0]'
  } catch { return true }
}

export const isLoopbackHost = (h: string): boolean => LOOPBACK.has(h.toLowerCase())

/** Validates the configuration; throws an Error whose message is safe to print (never contains the token). */
export function validateRemoteConfig(c: RemoteConfig): void {
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  if (typeof c.token !== 'string' || c.token.length < MIN_TOKEN_LENGTH || /\s/.test(c.token)) {
    throw new Error(`a bearer token of at least ${MIN_TOKEN_LENGTH} characters without whitespace is required (set it in the environment variable named by --token-env; \`fmmi-mcp --print-new-token\` makes one)`)
  }
  if (isUnspecifiedAddress(c.host) || /^[0.:\[\]x]*$/i.test(c.host)) throw new Error('refusing to bind a wildcard address; bind the specific private interface (for example the Tailscale address)')
  if (!isLoopbackHost(c.host)) {
    if (isIP(c.host.replace(/^\[|\]$/g, '').split('%')[0]!) === 0) throw new Error('a non-loopback bind must be a literal IP address of the private interface (for example the Tailscale address), not a host name')
    if (!c.allowNonLoopback) throw new Error('refusing a non-loopback bind: it needs --allow-non-loopback, a token, --allow-host and --private-transport')
    if (c.privateTransport === null) throw new Error(`refusing a non-loopback bind without a stated private-transport assumption: pass --private-transport ${PRIVATE_TRANSPORTS.join('|')}. This server speaks plain HTTP; beyond loopback it must be reached over that protected transport only`)
    if (c.allowedHosts.length === 0) throw new Error('a non-loopback bind needs at least one --allow-host (the Host header clients will use)')
  }
  if (c.allowedHosts.some((h) => h.includes('*') || h.trim() === '')) throw new Error('--allow-host entries must be exact host names, no wildcards')
  if (c.allowedOrigins.some((o) => o.includes('*') || !/^https?:\/\/[^/\s]+$/.test(o))) throw new Error('--allow-origin entries must be exact origins such as https://example.net, no wildcards')
  if (!Number.isInteger(c.ratePerMinute) || c.ratePerMinute < 1) throw new Error('--rate-limit must be a positive integer (requests per minute per client)')
  if (!Number.isInteger(c.maxBodyBytes) || c.maxBodyBytes < 1024 || c.maxBodyBytes > 1024 * 1024) throw new Error('--max-body must be between 1024 and 1048576 bytes')
}

export function newToken(): string { return randomBytes(32).toString('base64url') }

/** Constant-time comparison of two secrets of any length: both are hashed first, so length does not leak. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest(), b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Sliding-window limiter keyed by client. Old keys are dropped so memory stays bounded. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly perMinute: number
  private readonly now: () => number
  private readonly maxKeys: number
  constructor(perMinute: number, now: () => number = () => Date.now(), maxKeys = 1024) { this.perMinute = perMinute; this.now = now; this.maxKeys = maxKeys }
  /** Returns 0 when allowed, otherwise the seconds to wait. */
  check(key: string): number {
    const t = this.now()
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000)
    if (list.length >= this.perMinute) { this.hits.set(key, list); return Math.max(1, Math.ceil((60_000 - (t - list[0]!)) / 1000)) }
    list.push(t)
    this.hits.set(key, list)
    if (this.hits.size > this.maxKeys) { for (const [k, v] of this.hits) { if (v.every((x) => t - x >= 60_000)) this.hits.delete(k); if (this.hits.size <= this.maxKeys) break } }
    return 0
  }
}

export interface RemoteServer { server: Server; url: string; port: number; close: () => Promise<void> }

const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}
const reject = (res: ServerResponse, log: RemoteLogger, status: number, reason: string, headers: Record<string, string> = {}) => {
  // Reasons are fixed tokens. Nothing from the request (header values, token, body) is echoed or logged.
  log('http_reject', { status, reason })
  send(res, status, JSON.stringify({ error: { code: reason } }), headers)
}

export async function startRemoteServer(config: RemoteConfig, factory: () => McpServer | Promise<McpServer>, log: RemoteLogger = silentLogger, now: () => number = () => Date.now()): Promise<RemoteServer> {
  validateRemoteConfig(config)
  const handler = createMcpHandler(() => factory(), { responseMode: 'json', maxRequestBodySize: config.maxBodyBytes, onerror: (e) => log('mcp_transport_error', { errorName: e.name }) })
  const limiter = new RateLimiter(config.ratePerMinute, now)
  let boundPort = config.port
  const hostAllowed = (h: string | undefined): boolean => {
    if (!h) return false
    const v = h.toLowerCase()
    const names = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]
    return names.includes(v) || config.allowedHosts.some((x) => x.toLowerCase() === v)
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const started = performance.now()
      try {
        // 1. Rate limit first: it is the cheapest check and bounds the work an unauthenticated peer can cause.
        const wait = limiter.check(req.socket.remoteAddress ?? 'unknown')
        if (wait > 0) return reject(res, log, 429, 'rate_limited', { 'retry-after': String(wait) })
        // 2. One route, one method.
        const path = (req.url ?? '').split('?')[0]
        if (path !== '/mcp') return reject(res, log, 404, 'not_found')
        if (req.method !== 'POST') return reject(res, log, 405, 'method_not_allowed', { allow: 'POST' })
        // 3. Host (DNS rebinding) and Origin (browser) allowlists.
        if (!hostAllowed(req.headers.host)) return reject(res, log, 403, 'host_not_allowed')
        const origin = req.headers.origin
        if (origin !== undefined && !config.allowedOrigins.includes(origin)) return reject(res, log, 403, 'origin_not_allowed')
        // 4. Authentication, before any body is read.
        const auth = req.headers.authorization
        const m = typeof auth === 'string' ? /^Bearer ([^\s]+)$/.exec(auth) : null
        if (!m || !tokensMatch(m[1]!, config.token)) return reject(res, log, 401, 'unauthorized', { 'www-authenticate': 'Bearer' })
        // 5. Content type and size.
        if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reject(res, log, 415, 'unsupported_media_type')
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > config.maxBodyBytes) { res.once('finish', () => req.destroy()); return reject(res, log, 413, 'request_too_large', { connection: 'close' }) }
        const chunks: Buffer[] = []
        let total = 0
        for await (const c of req) {
          total += (c as Buffer).length
          if (total > config.maxBodyBytes) { res.once('finish', () => req.destroy()); return reject(res, log, 413, 'request_too_large', { connection: 'close' }) }
          chunks.push(c as Buffer)
        }
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'authorization' && k !== 'host') headers.set(k, v)
        const request = new Request(`http://127.0.0.1:${boundPort}/mcp`, { method: 'POST', headers, body: Buffer.concat(chunks) })
        // 6. The SDK handler. The credential is checked above; the SDK is told only that the caller was authenticated.
        const response = await handler.fetch(request, { authInfo: { token: 'redacted', clientId: 'bearer', scopes: [] } })
        const out: Record<string, string> = {}
        response.headers.forEach((v, k) => { out[k] = v })
        out['cache-control'] = 'no-store'
        res.writeHead(response.status, out)
        res.end(Buffer.from(await response.arrayBuffer()))
        log('http_ok', { status: response.status, ms: Math.round(performance.now() - started) })
      } catch (e) {
        log('http_error', { errorName: e instanceof Error ? e.name : 'unknown' })
        if (!res.headersSent) send(res, 500, JSON.stringify({ error: { code: 'internal_error' } }))
        else res.destroy()
      }
    })()
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 64
  await new Promise<void>((resolve, reject2) => { server.once('error', reject2); server.listen(config.port, config.host, resolve) })
  const addr = server.address() as AddressInfo
  // Fail closed: whatever spelling got through, a socket that listens on all interfaces is closed and refused.
  if (isUnspecifiedAddress(addr.address)) {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() })
    await handler.close()
    throw new Error('refusing to serve on a wildcard address')
  }
  boundPort = addr.port
  return {
    server, port: boundPort, url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${boundPort}/mcp`,
    close: async () => { await handler.close(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) },
  }
}
