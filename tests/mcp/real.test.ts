// Slice 3 on the real recording (Farnham 0-3 Torquay, captured to 87.6 min). Reads tests/fixtures/local/ (gitignored)
// and reports a skip when the file is absent. Catalogs are FMMI_HOME-isolated temporary directories.
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkReview } from '@fmmi/mcp'
import { HAS_REAL, REAL_FIXTURE, cleanupAll } from '../support/helpers.ts'
import { connect, openWriter, seedFile, KB } from '../support/mcp.ts'
import type { Connected, Json, Seed } from '../support/mcp.ts'

afterAll(cleanupAll)

const BIN = join(import.meta.dirname, '..', '..', 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs')
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
type P = { playerId: string; name: string; side: string; position: string | null; status: string; enteredAs: string | null; onAt: string | null; offAt: string | null; minutes: number }

describe.skipIf(!HAS_REAL)('Slice 3 on the real recording', () => {
  let seed: Seed
  let c: Connected
  let roster: P[]
  let sizes: Record<string, number>
  beforeAll(async () => {
    seed = await seedFile(REAL_FIXTURE)
    c = await connect(seed.home)
    sizes = {}
  }, 120_000)
  afterAll(async () => { console.log('REAL OUTPUT SIZES (bytes of the JSON text, default arguments):', JSON.stringify(sizes)); await c.close() })

  const measure = async (label: string, tool: string, args: Record<string, unknown>) => {
    const r = await c.call(tool, args)
    expect(r.isError, `${label}: ${r.text.slice(0, 300)}`).toBe(false)
    sizes[label] = bytes(r.text)
    expect(sizes[label], label).toBeLessThan(20 * KB)
    return r
  }

  it('AC3 default output of every tool is under 20 KB on the complete real recording, including the full 36-player roster', async () => {
    await measure('list_matches', 'list_matches', {})
    const sum = await measure('get_match_summary', 'get_match_summary', { matchId: seed.matchId })
    roster = sum.data.summary.roster.players
    // the roster is the complete recorded participant list: it equals the catalog's own roster for this revision
    const w = openWriter(seed.home)
    const catalogRoster = w.showMatch(seed.matchId).roster
    w.close()
    expect(roster).toHaveLength(catalogRoster.length)
    expect(roster.map((p) => p.playerId).sort()).toEqual(catalogRoster.map((p) => p.playerId).sort())
    expect(sum.data.summary.roster).toMatchObject({ total: catalogRoster.length, returned: catalogRoster.length })
    expect(roster.length).toBe(36)
    const played = roster.filter((p) => p.status === 'played')
    const subbedOff = roster.filter((p) => p.status === 'played' && p.offAt !== null)
    const unused = roster.filter((p) => p.status === 'unused_substitute')
    expect(subbedOff.length).toBeGreaterThan(0)
    expect(unused.length).toBeGreaterThan(0)
    expect(played.length + unused.length).toBe(roster.length)
    const home = roster.filter((p) => p.side === 'home' && p.status === 'played')
    const striker = home.find((p) => /ST/.test(p.position ?? '')) ?? home[9]!
    const other = home.find((p) => p.playerId !== striker.playerId && /ST|AM/.test(p.position ?? '')) ?? home[10]!
    await measure('get_player_match', 'get_player_match', { matchId: seed.matchId, playerId: striker.playerId })
    await measure('get_passing_network', 'get_passing_network', { matchId: seed.matchId, teamId: seed.homeTeamId })
    await measure('get_passing_network(away)', 'get_passing_network', { matchId: seed.matchId, teamId: seed.awayTeamId })
    await measure('get_striker_service', 'get_striker_service', { matchId: seed.matchId, playerId: striker.playerId })
    await measure('get_striker_service+compare', 'get_striker_service', { matchId: seed.matchId, playerId: striker.playerId, comparePlayerId: other.playerId })
    await measure('compare_match_periods', 'compare_match_periods', { matchId: seed.matchId, teamId: seed.homeTeamId, windowA: { fromMinute: 1, toMinute: 45, period: 1 }, windowB: { fromMinute: 46, toMinute: 87, period: 2 } })
    const four = home.slice(0, 4).map((p) => p.playerId)
    await measure('compare_match_periods(4 players)', 'compare_match_periods', { matchId: seed.matchId, teamId: seed.homeTeamId, playerIds: four, windowA: { fromMinute: 1, toMinute: 45, period: 1 }, windowB: { fromMinute: 46, toMinute: 87, period: 2 } })
    await measure('get_recording_status(match)', 'get_recording_status', { matchId: seed.matchId })
    await measure('get_recording_status(catalog)', 'get_recording_status', {})
    await measure('get_match_summary(team)', 'get_match_summary', { matchId: seed.matchId, teamId: seed.awayTeamId })
  })

  it('AC3 the real recording is decoded once for all of those calls', () => {
    expect(c.holder.cacheStats()).toMatchObject({ misses: 1, entries: 1, inFlight: 0, evictions: 0 })
    expect(c.holder.cacheStats().hits).toBeGreaterThanOrEqual(9)
  })

  it('AC1 every tool works on the real recording and reports its true status: observed score, partial capture, unknown completion', async () => {
    const list = await c.call('list_matches')
    expect(list.data.matches[0]).toMatchObject({
      matchId: seed.matchId, home: { name: 'Farnham' }, away: { name: 'Torquay' }, managedSide: 'home', format: '2.8',
      result: { label: 'observed_not_final', observed: { home: 0, away: 3 } }, status: { integrity: 'valid', coverage: 'partial', completion: 'unknown' },
    })
    const st = await c.call('get_recording_status', { matchId: seed.matchId })
    expect(st.data.status.coverage.status).toBe('partial')
    expect(st.data.status.coverage.endCaptureEndsAt).toMatchObject({ period: 2 })
    expect(st.data.recipientDiagnostic.home.status).toBeDefined()
    expect(st.data.missingMetrics.map((m: { metric: string }) => m.metric)).toContain('ground_service_receptions')
    expect(JSON.stringify(st.data)).not.toMatch(/[A-Za-z]:\\|\/Users\//)
  })

  it('AC6 a roster id from the real recording is rejected on a different match and a tool call with it works on its own match', async () => {
    const p = roster.find((x) => x.status === 'played')!
    expect((await c.call('get_player_match', { matchId: seed.matchId, playerId: p.playerId })).isError).toBe(false)
    expect((await c.call('get_player_match', { matchId: 'm_0000000000000000', playerId: p.playerId })).data.code).toBe('not_found')
    expect((await c.call('get_player_match', { matchId: seed.matchId, playerId: 'p_000000000000' })).data.code).toBe('not_found')
  })

  it('AC4 end to end over stdio on the real recording: the striker-service question is answered from returned ids, and a synthetic response citing them passes the checker', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--home', seed.home], env: process.env as Record<string, string>, stderr: 'pipe' })
    const client = new Client({ name: 'fmmi-real-stdio', version: '0.0.0' })
    await client.connect(transport)
    const records: unknown[] = []
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r: Json = await client.callTool({ name: tool, arguments: args })
      records.push({ tool, arguments: args, result: r })
      expect(r.isError).not.toBe(true)
      return JSON.parse(r.content[0].text)
    }
    const list = await call('list_matches', {})
    const matchId = list.matches[0].matchId as string
    const sum = await call('get_match_summary', { matchId })
    const players = sum.summary.roster.players as P[]
    const home = players.filter((p) => p.side === 'home' && p.status === 'played')
    const striker = home.find((p) => /ST/.test(p.position ?? '')) ?? home[9]!
    const svc = await call('get_striker_service', { matchId, playerId: striker.playerId, recordingRevisionId: sum.recordingRevisionId })
    await client.close()
    expect(svc.service.subject.aerial).toBeDefined()
    expect(svc.service.recipientGate.status).toMatch(/pass|fail/)
    const w = svc.window
    const gate = svc.service.recipientGate.status
    // SYNTHETIC SAMPLE: hand-written, not a language-model transcript.
    const response = [
      '<!-- SYNTHETIC SAMPLE: hand-written for the review checker, not a language-model transcript -->',
      '## 1. Facts',
      `- Match ${matchId}, revision ${sum.recordingRevisionId}: ${striker.name} (${striker.playerId}) had ${svc.service.subject.aerial.attempts} aerial attempts (\`aerial_win_pct\`) over window ${w.from.period}:${w.from.tick} to ${w.to.period}:${w.to.tick}.`,
      '## 2. Interpretation',
      `The recipient gate status is ${gate}. Hypothesis only: service cannot be judged beyond the counts returned.`,
      '## 3. Alternative explanations',
      'Opposition set-up, score state and the partial capture could each explain the counts.',
      '## 4. Action',
      'No action is recommended: the capture is partial and this is one observational match.',
      '## 5. Confidence and what to watch next',
      'Low confidence. Record the next full match.',
    ].join('\n')
    const report = checkReview(response, records)
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
  })
})

