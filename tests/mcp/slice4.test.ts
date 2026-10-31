// Slice 4 acceptance through a real SDK v2 client against the real server (in-memory transport): the spec section 14 definition of
// done, the five new read-only tools, CLI/MCP parity, output size and the read-only guarantee. Every recording is a LABELLED
// SYNTHETIC archive (invented club, players and opponents) built by the test-only archive writer; isolated FMMI_HOME catalogs.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { checkReview } from '@fmmi/mcp'
import { MatchQueries } from '@fmmi/query'
import { ListPlayersResultSchema, PlayerTrendsResultSchema, SeasonTrendsResultSchema, TacticalChangeResultSchema, TacticalNotesResultSchema } from '@fmmi/analytics'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { FIVE, confirmObserved, ingestSeason, periodsOf } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'
import { KB, connect } from '../support/mcp.ts'
import type { Connected, Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

// Five earlier matches, the spec five, one never confirmed and one that ends at 65 minutes: the last five ELIGIBLE are the spec five.
const EARLIER: SeasonMatch[] = [
  { key: 'e1', date: '2026-07-04', side: 'home', opponent: 'Alpha Town', goals: [{ tick: 5000, side: 'home' }], strikerAerials: { attempts: 8, won: 1 }, teamShots: { shots: 3, xg: 0.6 }, spongProgressive: 2 },
  { key: 'e2', date: '2026-07-11', side: 'away', opponent: 'Bravo City', goals: [{ tick: 7000, side: 'home' }], strikerAerials: { attempts: 6, won: 0 }, teamShots: { shots: 2, xg: 0.4 }, spongProgressive: 3 },
  { key: 'e3', date: '2026-07-18', side: 'home', opponent: 'Charlie Utd', goals: [], strikerAerials: { attempts: 7, won: 2 }, teamShots: { shots: 4, xg: 0.7 }, spongProgressive: 4 },
  { key: 'e4', date: '2026-07-25', side: 'away', opponent: 'Delta Rovers', goals: [{ tick: 9000, side: 'away' }], strikerAerials: { attempts: 5, won: 1 }, teamShots: { shots: 5, xg: 1.0 }, spongProgressive: 3 },
  { key: 'e5', date: '2026-08-01', side: 'home', opponent: 'Echo Albion', goals: [{ tick: 6000, side: 'home' }, { tick: 13000, side: 'away' }], strikerAerials: { attempts: 9, won: 2 }, teamShots: { shots: 3, xg: 0.5 }, spongProgressive: 2 },
]
const LATE: SeasonMatch[] = [
  { key: 'u1', date: '2026-09-12', side: 'away', opponent: 'Foxtrot FC', goals: [{ tick: 8000, side: 'away' }], strikerAerials: { attempts: 4, won: 2 }, teamShots: { shots: 2, xg: 0.3 }, spongProgressive: 1, periods: periodsOf(15600) }, // never confirmed, and the recording stops at 65 minutes (a partial recording waits for a confirmation)
  { key: 'p1', date: '2026-09-19', side: 'home', opponent: 'Golf Wanderers', periods: periodsOf(15600) }, // confirmed, but the recording stops at 65 minutes
]

interface Cat { home: string; saveId: string; ids: Awaited<ReturnType<typeof ingestSeason>>; teamId: string }

async function build(specs: SeasonMatch[], unconfirmed: string[]): Promise<Cat> {
  const home = tmp('fmmi-s4-')
  const svc = service(home)
  const saveId = svc.createSave('Synthetic Town').saveId
  const ids = await ingestSeason(svc, saveId, specs)
  for (const k of Object.keys(ids)) if (!unconfirmed.includes(k)) confirmObserved(svc, ids[k]!.matchId)
  const teamId = new MatchQueries(svc).listMatches({ saveId }).matches[0]!.managedTeamId!
  svc.close()
  return { home, saveId, ids, teamId }
}

function cli(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main([...args, '--json'], io)
    return { code, body: JSON.parse(out.join('\n')) as Json, err: err.join('\n') }
  }
}

const fingerprint = (home: string) => {
  const h = createHash('sha256')
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!/-(wal|shm)$/.test(e.name)) { h.update(e.name); h.update(readFileSync(p)) } } }
  walk(home)
  return h.digest('hex')
}

describe('Slice 4 MCP: the section 14 definition of done, end to end', () => {
  let cat: Cat
  let c: Connected
  const sizes: Record<string, number> = {}
  beforeAll(async () => {
    cat = await build([...EARLIER, ...FIVE, ...LATE], ['u1'])
    c = await connect(cat.home)
  }, 300_000)
  afterAll(async () => { console.log('SLICE 4 OUTPUT SIZES (bytes, synthetic, default arguments unless noted):', JSON.stringify(sizes)); await c.close() })

  const call = async (label: string, tool: string, args: Record<string, unknown>) => {
    const r = await c.call(tool, args)
    expect(r.isError, `${label}: ${r.text.slice(0, 300)}`).toBe(false)
    sizes[label] = bytes(r.text)
    expect(sizes[label], label).toBeLessThan(20 * KB)
    return r
  }

  it('DoD "In the last five matches, has Alexander been receiving better ground service? Compare him to Bingham, explain Spong\'s role in possession": recorded match ids and revisions, pooled evidence, an explicit ground-service unavailable, exclusions disclosed', async () => {
    // 1. discover save, team and match ids
    const list = await call('list_matches', 'list_matches', { saveId: cat.saveId, limit: 50 })
    expect(list.data.page.totalMatching).toBe(12)
    const teamId = list.data.matches[0].managedTeamId as string
    expect(teamId).toBe(cat.teamId)
    // 2. discover player ids through list_players
    const pid = async (name: string) => {
      const r = await call(`list_players ${name}`, 'list_players', { saveId: cat.saveId, nameQuery: name })
      expect(r.data.players).toHaveLength(1)
      expect(r.data.players[0]).toMatchObject({ identityStatus: 'persistent', basis: 'verified_upstream_uid', supportingMatchesTotal: 12 })
      expect(r.data.players[0].supportingMatchIds.length).toBeGreaterThan(0)
      return r.data.players[0].playerId as string
    }
    const [alexander, bingham, spong] = [await pid('Alexander'), await pid('Bingham'), await pid('Spong')]
    for (const id of [alexander, bingham, spong]) expect(id).toMatch(/^pe_/)

    // 3. the last five eligible matches, with included and excluded matches disclosed
    const season = await call('get_season_trends', 'get_season_trends', { saveId: cat.saveId, teamId, lastN: 5 })
    const five = FIVE.map((s) => cat.ids[s.key]!)
    expect(season.data.windows[0].matchIds).toEqual(five.map((x) => x.matchId))
    expect(season.data.matches.map((m: Json) => m.recordingRevisionId)).toEqual(five.map((x) => x.revisionId))
    expect(season.data.excluded).toEqual(expect.arrayContaining([
      { matchId: cat.ids.u1!.matchId, date: '2026-09-12', reasons: ['completion_unknown', 'early_ending_below_80_captured_minutes'], nextStep: 'fmmi sync' },
      { matchId: cat.ids.p1!.matchId, date: '2026-09-19', reasons: ['early_ending_below_80_captured_minutes'] },
    ]))
    expect(season.data.eligibleMatches).toBe(10)
    expect(season.data.windows[0].disclosures.manualConfirmation).toHaveLength(5)

    // 4. Alexander compared with Bingham (and Spong's passing) over the same five matches
    const pt = await call('get_player_trends', 'get_player_trends', { saveId: cat.saveId, playerIds: [alexander, bingham, spong], lastN: 5 })
    expect(pt.data.players.map((p: Json) => p.name)).toEqual(['George Alexander', 'Rakish Bingham', 'Jack Spong'])
    const row = (p: Json, metric: string) => p.windows[0].rates.find((r: Json) => r.metric === metric)
    const [a, b, s] = pt.data.players
    expect(a.windows[0].matchIds).toEqual(five.map((x) => x.matchId))
    expect(pt.data.matches.map((m: Json) => [m.matchId, m.recordingRevisionId])).toEqual(five.map((x) => [x.matchId, x.revisionId]))
    for (const p of pt.data.players) expect(p.windows[0].matchIds).toEqual(five.map((x) => x.matchId))
    expect(a.windows[0].matchMinutes.every((m: number) => m > 50)).toBe(true) // Alexander starts and is replaced
    expect(b.windows[0].matchMinutes.every((m: number) => m > 20 && m < 50)).toBe(true) // Bingham comes on
    expect(row(a, 'passes_received_per_90').numerator).toBe(0) // Alexander received nothing: still reportable, because exposure (minutes and team passes) is what the gate measures
    expect(row(a, 'passes_received_per_90').denominator).toBeCloseTo(a.windows[0].minutes, 1)
    expect(row(b, 'passes_received_per_90').numerator).toBeGreaterThan(0)
    expect(row(a, 'aerial_win_pct')).toMatchObject({ numerator: 7, denominator: 27 }) // Alexander 0+1+1+2+3 won of 7+6+5+4+5 attempts
    expect(row(b, 'aerial_win_pct')).toMatchObject({ numerator: 15, denominator: 20 }) // Bingham 3 of 4 in each of the five matches
    expect(row(s, 'progressive_passes_per_90').numerator).toBe(26) // Spong 3+5+4+8+6 on the progressive-pass upstream counter
    expect(row(s, 'pass_completion_pct').value).toBe(100)
    const cmp = pt.data.comparisons.find((x: Json) => x.comparator === bingham)
    expect(cmp).toMatchObject({ lastN: 5, subject: alexander, status: 'qualified' })
    expect(cmp.passesReceivedPer90).toMatchObject({ direction: 'lower' })
    expect(cmp.passesReceivedPer90.delta).toBeLessThan(0)
    // ground service: explicit unavailable, never inferred
    expect(pt.data.groundService).toMatchObject({ metric: 'ground_service_receptions', value: null, nullReason: 'not_recorded' })
    expect(pt.data.groundService.note).toMatch(/not ground service/)
    expect(pt.data.warnings).toContain('ground_service_unavailable: all-pass receptions are reported instead')
    expect(Object.keys(pt.data.metrics)).toEqual(expect.arrayContaining(['passes_received_per_90', 'aerial_win_pct']))

    // 5. qualified pass-network evidence for the latest of the five (Spong's role in possession)
    const latest = five[4]!
    const net = await call('get_passing_network', 'get_passing_network', { matchId: latest.matchId, teamId, recordingRevisionId: latest.revisionId, limit: 10 })
    expect(net.data.network.recipientGate.status).toBe('pass')
    expect(net.data.network.nodes.map((n: Json) => n.name)).toContain('Jack Spong')

    // 6. a saved assistant response (SYNTHETIC SAMPLE, hand-written) passes the review checker against these very tool results
    const review = [
      '<!-- SYNTHETIC SAMPLE: hand-written for this test, not a language-model transcript -->',
      '## 1. Facts',
      `- Matches ${five.map((x) => x.matchId).join(', ')} (revisions ${five.map((x) => x.revisionId).join(', ')}), last 5 eligible; ${cat.ids.u1!.matchId} and ${cat.ids.p1!.matchId} are excluded (completion_unknown, early_ending_below_80_captured_minutes).`,
      `- George Alexander (${alexander}) received 0 completed passes in ${row(a, 'passes_received_per_90').denominator.toFixed(1)} minutes (metric \`passes_received_per_90\`); Rakish Bingham (${bingham}) is the comparator. Ground service is unavailable (not_recorded), so these are all-pass receptions.`,
      `- Alexander won 7 of 27 aerial duels (metric \`aerial_win_pct\`); Bingham won 15 of 20. Jack Spong (${spong}) recorded 26 upstream progressive passes (\`progressive_passes_per_90\`).`,
      '## 2. Interpretation', 'Hypothesis: the striker gets little supply when Bingham is not on. The data describe rates and do not establish a cause.',
      '## 3. Alternative explanations', 'Minutes, score state and opponents differ between the two players; five matches is a small sample.',
      '## 4. Action', 'Try one change: ask the playmaker to look for the striker earlier in the move. Signal to watch: passes_received_per_90 for Alexander. Downside: fewer safe recycles.',
      '## 5. Confidence and what to watch next', 'Confidence is low to moderate: observational, five matches, ground service not recorded. Watch passes_received_per_90 next match.',
    ].join('\n')
    const report = checkReview(review, [season.raw, pt.raw, net.raw])
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)

    // DoD sample, printed for the slice report (synthetic)
    console.log('DOD SAMPLE (SYNTHETIC):', JSON.stringify({
      window: { lastN: 5, matchIds: season.data.windows[0].matchIds.length, excluded: season.data.excluded.map((e: Json) => e.reasons[0]) },
      alexander: { receptionsPer90: row(a, 'passes_received_per_90').value, aerial: `${row(a, 'aerial_win_pct').numerator}/${row(a, 'aerial_win_pct').denominator}` },
      bingham: { receptionsPer90: row(b, 'passes_received_per_90').value, aerial: `${row(b, 'aerial_win_pct').numerator}/${row(b, 'aerial_win_pct').denominator}` },
      spong: { progressivePer90: row(s, 'progressive_passes_per_90').value, passCompletionPct: row(s, 'pass_completion_pct').value },
      comparison: { status: cmp.status, direction: cmp.passesReceivedPer90.direction, delta: cmp.passesReceivedPer90.delta },
      groundService: pt.data.groundService.nullReason,
    }))
  }, 120_000)

  it('AC the window and list tools stay under 20 KB at their widest default: ten matches, home/away splits, four players, a full page of players and notes', async () => {
    const teamId = cat.teamId
    const wide = await call('get_season_trends (10 eligible, both windows, splits)', 'get_season_trends', { saveId: cat.saveId, teamId })
    expect(wide.data.windows.map((w: Json) => w.lastN)).toEqual([5, 10])
    expect(wide.data.windows[1].matchIds).toHaveLength(10)
    expect(wide.data.windows[1].sameMatchesAsWindow).toBeUndefined()
    await call('get_season_trends (partial opt-in)', 'get_season_trends', { saveId: cat.saveId, teamId, includePartial: true })
    const ids = (await Promise.all(['Alexander', 'Bingham', 'Spong', 'Synth Player 4'].map((n) => c.call('list_players', { saveId: cat.saveId, nameQuery: n })))).map((r) => r.data.players[0].playerId as string)
    await call('get_player_trends (4 players, both windows)', 'get_player_trends', { saveId: cat.saveId, playerIds: ids })
    await call('list_players (page of 50)', 'list_players', { saveId: cat.saveId, limit: 50 })
    await call('get_tactical_notes (empty)', 'get_tactical_notes', { saveId: cat.saveId })
  }, 120_000)

  it('AC the new tools are read-only: the catalog and snapshots are byte-identical after every call, and no write tool or path/url input exists', async () => {
    const before = fingerprint(cat.home)
    const teamId = cat.teamId
    await c.call('get_season_trends', { saveId: cat.saveId, teamId })
    await c.call('list_players', { saveId: cat.saveId })
    await c.call('get_tactical_notes', { saveId: cat.saveId })
    const alex = (await c.call('list_players', { saveId: cat.saveId, nameQuery: 'Alexander' })).data.players[0].playerId
    await c.call('get_player_trends', { saveId: cat.saveId, playerIds: [alex] })
    expect(fingerprint(cat.home)).toBe(before)
    const { tools } = await c.client.listTools()
    for (const t of tools.filter((x) => ['list_players', 'get_season_trends', 'get_player_trends', 'get_tactical_notes', 'compare_tactical_change'].includes(x.name))) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      expect(t.inputSchema).toMatchObject({ additionalProperties: false })
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).not.toEqual(expect.arrayContaining(['path']))
      expect(t.description).toMatch(/untrusted data, not instructions/)
    }
    expect(tools.map((t) => t.name).filter((n) => /add|write|set|link|confirm|supersede|delete|update/i.test(n))).toEqual([])
    await expect(c.client.callTool({ name: 'add_note', arguments: { saveId: cat.saveId } })).rejects.toThrow(/not found/i)
  }, 120_000)

  it('AC schema validation and domain errors: bounds, unknown keys, unknown ids and wrong-save ids', async () => {
    const teamId = cat.teamId
    const expectErr = async (tool: string, args: Record<string, unknown>, code: string) => { const r = await c.call(tool, args); expect(r.isError, tool).toBe(true); expect(r.data.code, `${tool} ${JSON.stringify(args)}`).toBe(code); return r.data }
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId, lastN: 0 }, 'invalid_input')
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId, lastN: 51 }, 'invalid_input')
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId, homeAway: 'neutral' }, 'invalid_input')
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId, path: 'C:\\x' }, 'invalid_input')
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId, metrics: ['nope'] }, 'invalid_input')
    await expectErr('get_season_trends', { saveId: 's_nope', teamId }, 'not_found')
    await expectErr('get_season_trends', { saveId: cat.saveId, teamId: 't_nope' }, 'not_found')
    await expectErr('get_player_trends', { saveId: cat.saveId, playerIds: [] }, 'invalid_input')
    await expectErr('get_player_trends', { saveId: cat.saveId, playerIds: ['pe_1', 'pe_2', 'pe_3', 'pe_4', 'pe_5'] }, 'invalid_input')
    await expectErr('get_player_trends', { saveId: cat.saveId, playerIds: ['pe_000000000000'] }, 'not_found')
    await expectErr('list_players', { saveId: cat.saveId, limit: 51 }, 'invalid_input')
    await expectErr('list_players', { saveId: cat.saveId, cursor: 'zzzz' }, 'invalid_input')
    await expectErr('get_tactical_notes', { saveId: cat.saveId, matchId: 'm_nope' }, 'not_found')
    await expectErr('compare_tactical_change', { saveId: cat.saveId, teamId, noteId: 'n_nope' }, 'not_found')
    await expectErr('compare_tactical_change', { saveId: cat.saveId, teamId, noteId: 'n_x', matchesBefore: 11 }, 'invalid_input')
    const page = await c.call('list_players', { saveId: cat.saveId, limit: 5 })
    expect(page.data.page).toMatchObject({ returned: 5, truncated: true })
    const next = await c.call('list_players', { saveId: cat.saveId, limit: 5, cursor: page.data.page.nextCursor })
    expect(next.data.players.map((p: Json) => p.playerId)).not.toEqual(expect.arrayContaining(page.data.players.map((p: Json) => p.playerId)))
    const different = await c.call('list_players', { saveId: cat.saveId, limit: 5, nameQuery: 'a', cursor: page.data.page.nextCursor })
    expect(different.data.code).toBe('invalid_input') // a cursor is bound to its filters
  }, 120_000)
})

describe('Slice 4 MCP: notes written by the local CLI, read and compared over MCP, with CLI/MCP parity', () => {
  let cat: Cat
  let c: Connected
  beforeAll(async () => {
    cat = await build(FIVE, [])
    c = await connect(cat.home)
  }, 300_000)
  afterAll(async () => { await c.close() })

  it('AC a client can read a tactical note and compare before/after across matches through MCP, with observational warnings; the CLI output is identical', async () => {
    const run = cli(cat.home)
    const f3 = cat.ids.f3!.matchId
    // the only writer is the local CLI
    const added = await run('note', 'add', f3, '--minute', '60', '--setting', 'Mentality', '--prior-value', 'Balanced', '--new-value', 'Positive', '--text', 'after the break', '--team', cat.teamId)
    expect(added.code).toBe(0)
    expect(added.body.data).toMatchObject({ matchId: f3, confidence: 'manual', source: 'user_entered', setting: 'Mentality', side: 'home' })
    const noteId = added.body.data.noteId as string

    const mcpNotes = await c.call('get_tactical_notes', { saveId: cat.saveId, matchId: f3 })
    expect(mcpNotes.isError).toBe(false)
    expect(mcpNotes.data.notes.map((n: Json) => n.noteId)).toEqual([noteId])
    expect(TacticalNotesResultSchema.safeParse(mcpNotes.data).success).toBe(true)
    const cliNotes = await run('note', 'list', '--save', cat.saveId, '--match', f3)
    expect(cliNotes.body.data).toEqual(mcpNotes.data)

    const mcpCmp = await c.call('compare_tactical_change', { saveId: cat.saveId, teamId: cat.teamId, noteId, matchesBefore: 2, matchesAfter: 2 })
    expect(mcpCmp.isError, mcpCmp.text.slice(0, 300)).toBe(false)
    expect(mcpCmp.data.across.status).toBe('available')
    expect(mcpCmp.data.across.before.matches).toHaveLength(2)
    expect(mcpCmp.data.across.after.matches).toHaveLength(2)
    expect(mcpCmp.data.warnings).toContain('observational_comparison: not a controlled test; context and confounders are reported beside the rates and are not adjusted for')
    expect(TacticalChangeResultSchema.safeParse(mcpCmp.data).success).toBe(true)
    expect(bytes(mcpCmp.text)).toBeLessThan(20 * KB)
    const cliCmp = await run('note', 'compare', noteId, '--save', cat.saveId, '--team', cat.teamId, '--before', '2', '--after', '2')
    expect(cliCmp.body.data).toEqual(mcpCmp.data)

    // a correction is a new note; the MCP result shows both, flagged
    const fixed = await run('note', 'supersede', noteId, '--minute', '62', '--new-value', 'Very positive')
    expect(fixed.code).toBe(0)
    expect(fixed.body.data.supersedes).toBe(noteId)
    const both = await c.call('get_tactical_notes', { saveId: cat.saveId })
    expect(both.data.notes.map((n: Json) => [n.noteId, n.status])).toEqual([[noteId, 'superseded'], [fixed.body.data.noteId, 'current']])
  }, 180_000)

  it('AC CLI and MCP agree on every Slice 4 query, including the five-match review, and on the same bad input', async () => {
    const run = cli(cat.home)
    const players = await c.call('list_players', { saveId: cat.saveId, limit: 10 })
    const cliPlayers = await run('players', '--save', cat.saveId, '--limit', '10')
    expect(cliPlayers.body.data).toEqual(players.data)
    expect(ListPlayersResultSchema.safeParse(players.data).success).toBe(true)

    const mcpSeason = await c.call('get_season_trends', { saveId: cat.saveId, teamId: cat.teamId })
    expect((await run('trends', '--save', cat.saveId, '--team', cat.teamId)).body.data).toEqual(mcpSeason.data)
    expect(SeasonTrendsResultSchema.safeParse(mcpSeason.data).success).toBe(true)
    const five = await c.call('get_season_trends', { saveId: cat.saveId, teamId: cat.teamId, lastN: 5 })
    expect((await run('review', '--last', '5', '--save', cat.saveId, '--team', cat.teamId)).body.data).toEqual(five.data)
    const narrow = await c.call('get_season_trends', { saveId: cat.saveId, teamId: cat.teamId, lastN: 3, homeAway: 'home', metrics: ['xg_per_90', 'aerial_win_pct'], season: '2026-27' })
    expect((await run('trends', '--save', cat.saveId, '--team', cat.teamId, '--last', '3', '--home-away', 'home', '--metrics', 'xg_per_90,aerial_win_pct', '--season', '2026-27')).body.data).toEqual(narrow.data)

    const alex = (await c.call('list_players', { saveId: cat.saveId, nameQuery: 'Alexander' })).data.players[0].playerId as string
    const bing = (await c.call('list_players', { saveId: cat.saveId, nameQuery: 'Bingham' })).data.players[0].playerId as string
    const pt = await c.call('get_player_trends', { saveId: cat.saveId, playerIds: [alex, bing], lastN: 5, metrics: ['passes_received_per_90', 'aerial_win_pct'] })
    expect((await run('player-trends', '--save', cat.saveId, '--players', `${alex},${bing}`, '--last', '5', '--metrics', 'passes_received_per_90,aerial_win_pct')).body.data).toEqual(pt.data)
    expect(PlayerTrendsResultSchema.safeParse(pt.data).success).toBe(true)

    for (const [tool, args, cliArgs, code] of [
      ['get_season_trends', { saveId: cat.saveId, teamId: cat.teamId, metrics: ['nope'] }, ['trends', '--save', cat.saveId, '--team', cat.teamId, '--metrics', 'nope'], 'invalid_input'],
      ['get_player_trends', { saveId: cat.saveId, playerIds: ['pe_000000000000'] }, ['player-trends', '--save', cat.saveId, '--players', 'pe_000000000000'], 'not_found'],
      ['get_tactical_notes', { saveId: cat.saveId, matchId: 'm_nope' }, ['note', 'list', '--save', cat.saveId, '--match', 'm_nope'], 'not_found'],
    ] as Array<[string, Record<string, unknown>, string[], string]>) {
      const viaCli = await run(...(cliArgs as [string, ...string[]]))
      const viaMcp = await c.call(tool, args)
      expect(viaCli.code).toBe(1)
      expect(viaMcp.isError).toBe(true)
      expect(viaMcp.data.code).toBe(code)
      expect(viaMcp.data).toEqual(viaCli.body.error)
    }
    expect(statSync(join(cat.home, 'catalog.sqlite')).size).toBeGreaterThan(0)
  }, 180_000)

  it('AC a default page of 20 notes and the widest before/after comparison (10 matches each side requested) stay under 20 KB', async () => {
    const run = cli(cat.home)
    const matchId = cat.ids.f2!.matchId
    for (let i = 0; i < 20; i++) {
      const r = await run('note', 'add', matchId, '--minute', String(10 + i), '--period', '1', '--setting', `Setting number ${i}`, '--prior-value', 'Standard', '--new-value', 'Different', '--text', 'a user comment of moderate length for the size check', '--side', 'away')
      expect(r.code, r.err).toBe(0)
    }
    const notes = await c.call('get_tactical_notes', { saveId: cat.saveId, matchId })
    expect(notes.isError).toBe(false)
    expect(notes.data.page).toMatchObject({ limit: 20, returned: 20, totalMatching: 20 })
    expect(bytes(notes.text)).toBeLessThan(20 * KB)
    const last = notes.data.notes[19].noteId as string
    const wide = await c.call('compare_tactical_change', { saveId: cat.saveId, teamId: cat.teamId, noteId: last, matchesBefore: 10, matchesAfter: 10 })
    expect(wide.isError, wide.text.slice(0, 300)).toBe(false)
    expect(bytes(wide.text)).toBeLessThan(20 * KB)
    console.log('SLICE 4 SIZES (notes page of 20, compare with 10 requested each side):', bytes(notes.text), bytes(wide.text))
  }, 180_000)
})
