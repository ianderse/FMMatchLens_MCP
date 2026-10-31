// Slice 5 optional remote MCP: Streamable HTTP via the SDK v2 packages. OFF unless `fmmi-mcp --http`. Tests cover the security decisions
// (token always required, constant-time comparison, strict Host and Origin allowlists, rate limit, size limits, loopback by default,
// refusal of a non-loopback bind without the stated opt-ins) and run a REAL SDK client end to end over both transports (a spawned stdio
// process and Streamable HTTP). NOTHING here has been run against a real network, Tailscale or a Mac: it is loopback only.
// Catalogs are FMMI_HOME-isolated and synthetic; the live reader, where used, talks to the MODELLED fake plugin.
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, describe, expect, it } from 'vitest'
import { CatalogHolder, createMcpServer, main as mcpMain, TOOL_NAMES } from '@fmmi/mcp'
import { isUnspecifiedAddress, RateLimiter, newToken, startRemoteServer, tokensMatch, validateRemoteConfig, MIN_TOKEN_LENGTH, PRIVATE_TRANSPORTS } from '@fmmi/remote'
import type { RemoteConfig, RemoteServer } from '@fmmi/remote'
import { cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { seedSynthetic } from '../support/mcp.ts'
import type { Json, Seed } from '../support/mcp.ts'
import { rig, syntheticReplay } from '../support/live.ts'

afterAll(cleanupAll)

const BIN = join(import.meta.dirname, '..', '..', 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs')
const TOKEN = newToken()
const baseConfig = (over: Partial<RemoteConfig> = {}): RemoteConfig => ({
  host: '127.0.0.1', port: 0, token: TOKEN, allowNonLoopback: false, privateTransport: null, allowedHosts: [], allowedOrigins: [], ratePerMinute: 120, maxBodyBytes: 64 * 1024, ...over,
})

async function remote(seed: Seed, over: Partial<RemoteConfig> = {}, o: { live?: Awaited<ReturnType<typeof rig>> | null; now?: () => number } = {}) {
  const logs: string[] = []
  const holder = new CatalogHolder(seed.home, {})
  const live = o.live ? { reader: o.live.reader, notes: holder.liveNotes, note: holder.liveNote } : undefined
  const srv = await startRemoteServer(baseConfig(over), () => createMcpServer(holder.get, () => undefined, {}, () => undefined, { live }), (e, f) => logs.push(JSON.stringify({ e, ...f })), o.now)
  return { srv, logs, holder, close: async () => { await srv.close(); holder.close() } }
}

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(srv: RemoteServer, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, method: o.method ?? 'POST', path: o.path ?? '/mcp', headers: { ...(o.host !== undefined ? { host: o.host } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}
const RPC = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
const good = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...extra })

async function seeded(): Promise<Seed> {
  const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
  return seedSynthetic(sc.synth)
}

describe('[AC4][S6] the remote transport rejects unauthenticated clients', () => {
  it('no Authorization header, a wrong scheme, an empty bearer, a wrong token and a near-miss token are all 401; no tool runs and the token is never echoed', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    const attempts: Array<[string, Record<string, string>]> = [
      ['none', { 'content-type': 'application/json' }],
      ['basic', { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }],
      ['empty', { 'content-type': 'application/json', authorization: 'Bearer ' }],
      ['wrong', { 'content-type': 'application/json', authorization: 'Bearer ' + 'x'.repeat(TOKEN.length) }],
      ['near', { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}x` }],
      ['short', { 'content-type': 'application/json', authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
      ['lower', { 'content-type': 'application/json', authorization: `bearer ${TOKEN.toLowerCase()}` }],
    ]
    for (const [name, headers] of attempts) {
      const res = await raw(r.srv, { headers, body: RPC })
      expect(res.status, name).toBe(401)
      expect(res.headers['www-authenticate'], name).toBe('Bearer')
      expect(res.body, name).toBe('{"error":{"code":"unauthorized"}}')
      expect(res.body).not.toContain(TOKEN)
    }
    expect(r.logs.some((l) => l.includes('tool_ok'))).toBe(false)
    expect(r.logs.filter((l) => l.includes('"unauthorized"'))).toHaveLength(attempts.length)
    // the correct token works
    const ok = await raw(r.srv, { headers: good(), body: RPC })
    expect(ok.status).toBe(200)
    await r.close()
  }, 60_000)

  it('the token never appears in a log line, a response header or body, or a tool result, whatever the request', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    const responses: Raw[] = []
    responses.push(await raw(r.srv, { headers: good(), body: RPC }))
    responses.push(await raw(r.srv, { headers: good(), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_matches', arguments: {} } }) }))
    responses.push(await raw(r.srv, { headers: good(), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_match_summary', arguments: { matchId: 'nope' } } }) }))
    responses.push(await raw(r.srv, { headers: { ...good(), authorization: `Bearer ${TOKEN}nope` }, body: RPC }))
    responses.push(await raw(r.srv, { headers: good(), body: '{ not json' }))
    responses.push(await raw(r.srv, { headers: good(), path: '/mcp?token=' + TOKEN, body: RPC }))
    for (const x of responses) { expect(x.body).not.toContain(TOKEN); expect(JSON.stringify(x.headers)).not.toContain(TOKEN) }
    for (const l of r.logs) expect(l).not.toContain(TOKEN)
    expect(r.logs.length).toBeGreaterThan(3)
    await r.close()
  }, 60_000)

  it('the token comparison is constant-time by construction: it hashes both sides, so length and prefix do not change the work, and equal tokens match only when equal', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(TOKEN, TOKEN + 'a')).toBe(false)
    expect(tokensMatch('a', TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
    const src = require_text('packages/remote/src/http.ts')
    expect(src).toMatch(/timingSafeEqual/)
    expect(src).not.toMatch(/token\s*===|===\s*config\.token|===\s*expected|presented\s*===/)
    expect(newToken()).not.toBe(newToken())
    expect(newToken().length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
  })
})

describe('[AC4][S6] strict Host and Origin allowlists, rate limit, size limits, one route', () => {
  it('a disallowed Host is refused even with the right token (DNS rebinding); the loopback names with the bound port are accepted; a missing port or another name is not', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    const p = r.srv.port
    for (const host of ['evil.example', `evil.example:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:${p + 1}`, `[::1]:${p + 1}`, `127.0.0.1.evil.example:${p}`]) {
      const res = await raw(r.srv, { headers: good(), body: RPC, host })
      expect(res.status, `host ${JSON.stringify(host)}`).toBe(403)
      expect(res.body).toBe('{"error":{"code":"host_not_allowed"}}')
    }
    for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `LOCALHOST:${p}`]) expect((await raw(r.srv, { headers: good(), body: RPC, host })).status, host).toBe(200)
    await r.close()
  }, 60_000)

  it('an extra allowed Host is exact (no wildcard, no suffix match)', async () => {
    const seed = await seeded()
    const r = await remote(seed, { allowedHosts: ['mac-studio.tailnet.example:8787'] })
    expect((await raw(r.srv, { headers: good(), body: RPC, host: 'mac-studio.tailnet.example:8787' })).status).toBe(200)
    expect((await raw(r.srv, { headers: good(), body: RPC, host: 'x.mac-studio.tailnet.example:8787' })).status).toBe(403)
    expect((await raw(r.srv, { headers: good(), body: RPC, host: 'mac-studio.tailnet.example' })).status).toBe(403)
    await r.close()
  }, 60_000)

  it('a request that carries an Origin is refused unless that exact origin is allowed; requests without Origin (MCP clients) pass', async () => {
    const seed = await seeded()
    const closed = await remote(seed)
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1', `http://127.0.0.1:${closed.srv.port}`, 'https://evil.example']) {
      const res = await raw(closed.srv, { headers: good({ origin }), body: RPC })
      expect(res.status, origin).toBe(403)
      expect(res.body).toBe('{"error":{"code":"origin_not_allowed"}}')
    }
    expect((await raw(closed.srv, { headers: good(), body: RPC })).status).toBe(200)
    await closed.close()
    const open = await remote(seed, { allowedOrigins: ['https://app.example.net'] })
    expect((await raw(open.srv, { headers: good({ origin: 'https://app.example.net' }), body: RPC })).status).toBe(200)
    expect((await raw(open.srv, { headers: good({ origin: 'https://app.example.net.evil.example' }), body: RPC })).status).toBe(403)
    expect((await raw(open.srv, { headers: good({ origin: 'https://other.example.net' }), body: RPC })).status).toBe(403)
    await open.close()
  }, 60_000)

  it('rate limit: the Nth+1 request inside a minute is 429 with Retry-After, bad-token attempts count (no free brute force), and the window slides', async () => {
    const seed = await seeded()
    let now = 1_000_000
    const r = await remote(seed, { ratePerMinute: 5 }, { now: () => now })
    for (let i = 0; i < 3; i++) expect((await raw(r.srv, { headers: { ...good(), authorization: 'Bearer ' + 'y'.repeat(40) }, body: RPC })).status).toBe(401)
    for (let i = 0; i < 2; i++) expect((await raw(r.srv, { headers: good(), body: RPC })).status).toBe(200)
    const limited = await raw(r.srv, { headers: good(), body: RPC })
    expect(limited.status).toBe(429)
    expect(limited.body).toBe('{"error":{"code":"rate_limited"}}')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    now += 61_000
    expect((await raw(r.srv, { headers: good(), body: RPC })).status).toBe(200)
    await r.close()
    // the limiter alone: per client, bounded memory
    const lim = new RateLimiter(2, () => now, 3)
    expect([lim.check('a'), lim.check('a')]).toEqual([0, 0])
    expect(lim.check('a')).toBeGreaterThan(0)
    expect(lim.check('b')).toBe(0)
    for (let i = 0; i < 20; i++) lim.check(`k${i}`)
    expect((lim as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(25)
  }, 60_000)

  it('request size limits: a declared length over the limit and a streamed body over the limit are 413 before the SDK sees them; a wrong content type is 415; only POST /mcp exists', async () => {
    const seed = await seeded()
    const r = await remote(seed, { maxBodyBytes: 2048 })
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_matches', arguments: { cursor: 'a'.repeat(5000) } } })
    const declared = await raw(r.srv, { headers: { ...good(), 'content-length': String(Buffer.byteLength(big)) }, body: big })
    expect(declared.status).toBe(413)
    expect(declared.body).toBe('{"error":{"code":"request_too_large"}}')
    // no Content-Length (chunked): the stream is cut at the limit
    const chunked = await new Promise<Raw>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: r.srv.port, method: 'POST', path: '/mcp', headers: { ...good(), 'transfer-encoding': 'chunked' } }, (res) => {
        const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString() }))
      })
      req.on('error', (e) => (['ECONNRESET', 'EPIPE'].includes((e as NodeJS.ErrnoException).code ?? '') ? resolve({ status: 413, headers: {}, body: 'reset' }) : reject(e)))
      for (let i = 0; i < 10; i++) req.write('z'.repeat(1000))
      req.end()
    })
    expect(chunked.status).toBe(413)
    expect((await raw(r.srv, { headers: good({ 'content-type': 'text/plain' }), body: RPC })).status).toBe(415)
    expect((await raw(r.srv, { method: 'GET', headers: good() })).status).toBe(405)
    expect((await raw(r.srv, { method: 'DELETE', headers: good() })).status).toBe(405)
    for (const path of ['/', '/api/health', '/api/match/current', '/mcp/', '/mcp/../api/health', '/health']) expect((await raw(r.srv, { path, headers: good(), body: RPC })).status, path).toBe(404)
    // the server is still healthy after those
    expect((await raw(r.srv, { headers: good(), body: RPC })).status).toBe(200)
    await r.close()
  }, 60_000)
})

describe('[AC4][S6] safe localhost-only behaviour is the default; a non-loopback bind is refused without the opt-ins', () => {
  it('the default bind is 127.0.0.1: the listening socket is loopback and a connection to another local address is refused', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    const addr = r.srv.server.address()
    expect(addr).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
    expect(r.srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    if (external) {
      const refused = await new Promise<string>((resolve) => {
        const req = request({ host: external.address, port: r.srv.port, method: 'POST', path: '/mcp', headers: good(), timeout: 3000 }, () => resolve('connected'))
        req.on('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? 'error'))
        req.on('timeout', () => { req.destroy(); resolve('timeout') })
        req.end(RPC)
      })
      expect(['ECONNREFUSED', 'timeout']).toContain(refused)
    }
    await r.close()
  }, 60_000)

  it('validateRemoteConfig and startRemoteServer refuse: no token, a short token, a non-loopback host without opt-in, without a stated private transport, without an allowed Host, a wildcard address, a wildcard allowlist entry', async () => {
    const refuses = (over: Partial<RemoteConfig>, re: RegExp) => expect(() => validateRemoteConfig(baseConfig(over)), JSON.stringify(over)).toThrow(re)
    refuses({ token: '' }, /bearer token/)
    refuses({ token: 'short' }, /bearer token/)
    refuses({ token: 'a'.repeat(30) + ' b' }, /bearer token/)
    refuses({ host: '100.64.0.7' }, /non-loopback bind: it needs --allow-non-loopback/)
    refuses({ host: '100.64.0.7', allowNonLoopback: true }, /private-transport/)
    refuses({ host: '100.64.0.7', allowNonLoopback: true, privateTransport: 'tailscale' }, /--allow-host/)
    refuses({ host: '0.0.0.0', allowNonLoopback: true, privateTransport: 'tailscale', allowedHosts: ['x'] }, /wildcard address/)
    refuses({ host: '::', allowNonLoopback: true, privateTransport: 'tailscale', allowedHosts: ['x'] }, /wildcard address/)
    refuses({ allowedHosts: ['*.example.net'] }, /no wildcards/)
    refuses({ allowedOrigins: ['*'] }, /no wildcards|exact origins/)
    refuses({ allowedOrigins: ['https://x.example/path'] }, /exact origins/)
    refuses({ maxBodyBytes: 10 * 1024 * 1024 }, /--max-body/)
    refuses({ ratePerMinute: 0 }, /--rate-limit/)
    // wildcard in every spelling, and host names, are refused when all other opt-ins are given
    const full = { allowNonLoopback: true, privateTransport: 'tailscale' as const, allowedHosts: ['a.example'] }
    for (const h of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '0000:0000:0000:0000:0000:0000:0000:0000', '::ffff:0.0.0.0', '::ffff:0:0', '[::]', '[::0]', '0', '0.0', '00.0.0.0', '0x0', '::%eth0']) {
      refuses({ host: h, ...full }, /wildcard address/)
    }
    refuses({ host: 'mac-studio.tailnet.example', ...full }, /literal IP/)
    refuses({ host: 'localhost.evil.example', ...full }, /literal IP/)
    expect(() => validateRemoteConfig(baseConfig({ host: '100.64.0.1', ...full }))).not.toThrow()
    expect(() => validateRemoteConfig(baseConfig({ host: 'fd7a:115c:a1e0::1', ...full }))).not.toThrow()
    expect(isUnspecifiedAddress('100.64.0.1')).toBe(false)
    // all the opt-ins together are accepted by validation (nothing is bound here: the address is not on this machine)
    for (const t of PRIVATE_TRANSPORTS) expect(() => validateRemoteConfig(baseConfig({ host: '100.64.0.7', allowNonLoopback: true, privateTransport: t, allowedHosts: ['mac-studio.tailnet.example:8787'] }))).not.toThrow()
    // and the server itself refuses before it listens
    await expect(startRemoteServer(baseConfig({ host: '192.0.2.10' }), () => { throw new Error('never built') })).rejects.toThrow(/non-loopback/)
  })

  it('fmmi-mcp --http: a missing token variable, a non-loopback host without opt-in and an unknown transport exit 2 with a message that never contains the token; --print-new-token prints a fresh one', async () => {
    const errs: string[] = []
    const run = (argv: string[], env: Record<string, string>) => { errs.length = 0; return mcpMain(argv, { env, err: (s) => errs.push(s) }) }
    expect(await run(['--http'], {})).toBe(2)
    expect(errs.join()).toMatch(/FMMI_MCP_TOKEN is not set/)
    expect(await run(['--http', '--host', '192.0.2.5'], { FMMI_MCP_TOKEN: TOKEN })).toBe(2)
    expect(errs.join()).toMatch(/refusing a non-loopback bind/)
    expect(errs.join()).not.toContain(TOKEN)
    expect(await run(['--http', '--host', '192.0.2.5', '--allow-non-loopback', '--private-transport', 'carrier-pigeon', '--allow-host', 'x:1'], { FMMI_MCP_TOKEN: TOKEN })).toBe(2)
    expect(errs.join()).toMatch(/--private-transport must be one of/)
    expect(await run(['--http', '--token-env', 'MY_TOKEN'], { MY_TOKEN: 'short' })).toBe(2)
    expect(errs.join()).not.toContain('short\n')
    expect(await run(['--http', '--port', 'abc'], { FMMI_MCP_TOKEN: TOKEN })).toBe(2)
    expect(await run(['--nonsense'], {})).toBe(2)
    const printed: string[] = []
    expect(await mcpMain(['--print-new-token'], { env: {}, err: () => undefined, out: (s) => printed.push(s) })).toBe(0)
    expect(printed[0]!.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    expect(printed[0]).not.toBe(TOKEN)
  })

  it('fmmi-mcp --http starts on loopback by default, reads the token from the named variable, and stops cleanly on abort', async () => {
    const seed = await seeded()
    const ac = new AbortController()
    let url = ''
    const done = mcpMain(['--http', '--home', seed.home, '--port', '0', '--token-env', 'FMMI_TEST_TOKEN'], { env: { FMMI_TEST_TOKEN: TOKEN }, err: () => undefined, abort: ac.signal, onListening: (u) => { url = u } })
    for (let i = 0; i < 100 && !url; i++) await new Promise((r) => setTimeout(r, 20))
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const client = new Client({ name: 'main-http-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(TOOL_NAMES)
    await client.close()
    ac.abort()
    expect(await done).toBe(0)
  }, 60_000)
})

describe('[S6] a REAL SDK v2 client end to end over both transports, same read-only tool set, no proxying', () => {
  it('stdio (a spawned fmmi-mcp process) and Streamable HTTP list the same thirteen tools and return the same results', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    const http = new Client({ name: 'http-test-client', version: '0.0.0' })
    await http.connect(new StreamableHTTPClientTransport(new URL(r.srv.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
    const stdioT = new StdioClientTransport({ command: process.execPath, args: [BIN, '--home', seed.home], env: process.env as Record<string, string>, stderr: 'pipe' })
    const stdio = new Client({ name: 'stdio-test-client', version: '0.0.0' })
    await stdio.connect(stdioT)

    const listH = (await http.listTools()).tools, listS = (await stdio.listTools()).tools
    expect(listH.map((t) => t.name)).toEqual(TOOL_NAMES)
    expect(listH).toEqual(listS) // identical names, schemas and read-only annotations
    expect(listH.every((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false)).toBe(true)

    const call = async (c: Client, name: string, args: Record<string, unknown>) => { const x: Json = await c.callTool({ name, arguments: args }); return { isError: x.isError === true, text: x.content[0].text as string } }
    const list = await call(http, 'list_matches', {})
    expect(list.isError).toBe(false)
    const matchId = JSON.parse(list.text).matches[0].matchId as string
    expect(matchId).toBe(seed.matchId)
    const sum = await call(http, 'get_match_summary', { matchId })
    const striker = (JSON.parse(sum.text).summary.roster.players as Array<{ name: string; playerId: string }>).find((p) => p.name === 'Away Player 9')!
    for (const [name, args] of [
      ['list_matches', {}], ['get_match_summary', { matchId }], ['get_recording_status', { matchId }],
      ['get_striker_service', { matchId, playerId: striker.playerId, recordingRevisionId: seed.revisionId }],
      ['get_player_match', { matchId, playerId: 'p_000000000000' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const a = await call(http, name, args), b = await call(stdio, name, args)
      expect(a.isError, name).toBe(b.isError)
      expect(a.text, `${name}: HTTP equals stdio`).toBe(b.text)
    }
    expect((await call(http, 'get_player_match', { matchId, playerId: 'p_000000000000' })).isError).toBe(true) // the domain error body survives the transport
    await http.close(); await stdio.close(); await r.close()
  }, 120_000)

  it('a client with a wrong or missing token cannot connect; the failure carries no token', async () => {
    const seed = await seeded()
    const r = await remote(seed)
    for (const headers of [{}, { Authorization: 'Bearer ' + 'q'.repeat(43) }]) {
      const c = new Client({ name: 'bad-client', version: '0.0.0' })
      const err = await c.connect(new StreamableHTTPClientTransport(new URL(r.srv.url), { requestInit: { headers: headers as Record<string, string> } })).then(() => null, (e: unknown) => e)
      expect(err).not.toBeNull()
      expect(String(err)).not.toContain(TOKEN)
      await c.close().catch(() => undefined)
    }
    await r.close()
  }, 60_000)

  it('with --live the remote tool set is the thirteen plus three live tools; the plugin sees only the reader\'s own allowed GETs and nothing a client sent; the offline results do not change', async () => {
    const seed = await seeded()
    const { replay } = await syntheticReplay()
    const rg = await rig(replay)
    rg.plugin.advance(120)
    const off = await remote(seed)
    const on = await remote(seed, {}, { live: rg })
    const open = async (srv: RemoteServer) => { const c = new Client({ name: 'live-http', version: '0.0.0' }); await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } })); return c }
    const cOff = await open(off.srv), cOn = await open(on.srv)
    expect((await cOff.listTools()).tools).toHaveLength(13)
    expect((await cOn.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES, 'get_live_match', 'get_live_player_analysis', 'get_recent_tactical_events'])
    const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => { const x: Json = await c.callTool({ name, arguments: args }); return { isError: x.isError === true, text: x.content[0].text as string } }
    await expect(call(cOff, 'get_live_match')).rejects.toThrow(/Tool get_live_match not found/) // not registered without --live
    const lm = await call(cOn, 'get_live_match')
    expect(lm.isError).toBe(false)
    expect(JSON.parse(lm.text).live.state).toBe('fresh')
    expect((await call(cOn, 'list_matches')).text).toBe((await call(cOff, 'list_matches')).text)
    // a hostile tool argument cannot make the server fetch anything: the schema is strict, and the plugin only saw the reader's routes
    expect((await call(cOn, 'get_live_match', { url: 'http://127.0.0.1:16726/api/health' })).isError).toBe(true)
    const allowed = new Set(['/api/health', '/api/archives', '/api/match/status', '/api/match/meta', '/api/match/current', '/api/match/frames', '/api/match/formation/history', '/api/match/momentum/events', '/api/match/momentum/updates'])
    expect(rg.plugin.hits.length).toBeGreaterThan(0)
    for (const h of rg.plugin.hits) expect(allowed.has(h.path.split('?')[0]!), h.path).toBe(true)
    await cOff.close(); await cOn.close(); await off.close(); await on.close(); await rg.close()
  }, 120_000)

  it('the transport package imports no child process, file write, plugin client or raw port, and never names the plugin port', () => {
    const src = ['packages/remote/src/http.ts', 'packages/remote/src/index.ts'].map(require_text).join('\n')
    expect(src).not.toMatch(/node:child_process|node:fs|\bwriteFile|@fmmi\/live|@fmmi\/store|16726|node:dgram|node:tls|process\.env/)
    expect(src).not.toMatch(/(?<![.\w])fetch\(/) // no outbound request (`handler.fetch` is the SDK entry point, not an outbound call): no proxying
  })
})

import { readFileSync } from 'node:fs'
function require_text(rel: string): string { return readFileSync(join(import.meta.dirname, '..', '..', rel), 'utf8') }
