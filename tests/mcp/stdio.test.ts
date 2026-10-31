// End-to-end over stdio: launches the actual fmmi-mcp entry point as a child process and talks to it with the official
// SDK v2 client. No Football Manager process; catalog isolated under a temporary FMMI_HOME.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { seedSynthetic } from '../support/mcp.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const BIN = join(import.meta.dirname, '..', '..', 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs')

async function launch(args: string[], env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], env: { ...process.env as Record<string, string>, ...env }, stderr: 'pipe' })
  const stderr: string[] = []
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')))
  const client = new Client({ name: 'fmmi-stdio-test', version: '0.0.0' })
  await client.connect(transport)
  return { client, stderr, close: () => client.close() }
}

describe('fmmi-mcp over stdio (the real entry point)', () => {
  it('AC1 the launched server lists the thirteen read-only tools and answers the striker-service question end to end, with a clean stderr log', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
    const seed = await seedSynthetic(sc.synth)
    const s = await launch(['--home', seed.home])
    const { tools } = await s.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_match_periods', 'compare_tactical_change', 'get_match_summary', 'get_opposition_threat', 'get_passing_network', 'get_player_match', 'get_player_trends', 'get_recording_status',
      'get_season_trends', 'get_striker_service', 'get_tactical_notes', 'list_matches', 'list_players',
    ])
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: Json = await s.client.callTool({ name, arguments: args })
      return { isError: r.isError === true, data: JSON.parse(r.content[0].text) }
    }
    const list = await call('list_matches', {})
    expect(list.isError).toBe(false)
    const matchId = list.data.matches[0].matchId as string
    expect(matchId).toBe(seed.matchId)
    const sum = await call('get_match_summary', { matchId })
    const roster = sum.data.summary.roster.players as Array<{ name: string; playerId: string; offAt: string | null }>
    const striker = roster.find((p) => p.name === 'Away Player 9')!
    expect(striker.offAt).not.toBeNull() // substituted off, still listed
    const svc = await call('get_striker_service', { matchId, playerId: striker.playerId, recordingRevisionId: sum.data.recordingRevisionId })
    expect(svc.isError).toBe(false)
    expect(svc.data.service.subject.aerial.attempts).toBe(7)
    expect(svc.data.recordingRevisionId).toBe(seed.revisionId)
    const bad = await call('get_player_match', { matchId, playerId: 'p_0000000000' })
    expect(bad).toMatchObject({ isError: true, data: { code: 'not_found' } })
    const prompt = await s.client.getPrompt({ name: 'match_review', arguments: { matchId } })
    expect(prompt.messages).toHaveLength(1)
    await s.close()
    // Logs are JSON lines on stderr, carry ids/sizes/durations, and no absolute path, name or raw frame.
    const log = s.stderr.join('')
    const lines = log.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) { const j = JSON.parse(l); expect(j.event).toEqual(expect.any(String)) }
    expect(log).toContain('tool_ok')
    expect(log).toContain('"code":"not_found"')
    expect(log).not.toContain(seed.home)
    expect(log).not.toMatch(/[A-Za-z]:\\\\|[A-Za-z]:\\|\/Users\/|Away Player|catalog\.sqlite/)
  })

  it('AC2 stdout carries only protocol messages: every line the raw process writes is a JSON-RPC message, and it exits when stdin closes', async () => {
    const seed = await seedSynthetic((await buildScenario({ humanSide: 'away', strikerSide: 'away' })).synth)
    const child = spawn(process.execPath, [BIN, '--home', seed.home], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: string[] = []
    let buf = ''
    child.stdout.on('data', (d: Buffer) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1) } })
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_matches', arguments: { path: 'C:\\Windows\\win.ini' } } })
    const start = Date.now()
    while (out.length < 3 && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 50))
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const l of out) { const j = JSON.parse(l); expect(j.jsonrpc).toBe('2.0') }
    const byId = new Map(out.map((l) => JSON.parse(l)).filter((j) => j.id !== undefined).map((j) => [j.id, j]))
    expect(byId.get(2).result.tools).toHaveLength(13)
    expect(byId.get(3).result.isError).toBe(true)
    expect(JSON.parse(byId.get(3).result.content[0].text).code).toBe('invalid_input')
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.stdin.end()
    expect(await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 15000))])).toBe(0)
  })

  it('AC2 a server started before the first import answers with a domain error, creates nothing, and picks the catalog up once it exists', async () => {
    const home = tmp('fmmi-late-')
    const s = await launch(['--home', home])
    const r: Json = await s.client.callTool({ name: 'list_matches', arguments: {} })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0].text)).toMatchObject({ code: 'not_found', details: { reason: 'catalog_missing' } })
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(home)).toEqual([])
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    await seedSynthetic(sc.synth, home)
    const again: Json = await s.client.callTool({ name: 'list_matches', arguments: {} })
    expect(again.isError).not.toBe(true)
    expect(JSON.parse(again.content[0].text).matches).toHaveLength(1)
    await s.close()
  })

  it('AC2 unknown arguments are refused with exit code 2 and nothing on stdout', async () => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [BIN, '--archive', 'C:\\x\\a.fmlens'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/unknown argument/)
  })
})
