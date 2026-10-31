// Slice 3b over MCP: get_opposition_threat, the rating block of get_player_match, the minute-0 window regression, and sizes on
// the real recording. Catalogs are FMMI_HOME-isolated temporary directories.
import { afterAll, describe, expect, it } from 'vitest'
import { HAS_REAL, REAL_FIXTURE, cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { connect, seedFile, seedSynthetic, KB } from '../support/mcp.ts'

afterAll(cleanupAll)

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

describe('get_opposition_threat over MCP (synthetic)', () => {
  it('AC the tool is read-only, takes only matchId, teamId, window and recordingRevisionId, and returns the section 6.4 envelope', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham', trajectory: true })
    const seed = await seedSynthetic(sc.synth)
    const c = await connect(seed.home)
    const { tools } = await c.client.listTools()
    const t = tools.find((x) => x.name === 'get_opposition_threat')!
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    const schema = t.inputSchema as { additionalProperties?: unknown; properties: Record<string, unknown>; required?: string[] }
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(['matchId', 'recordingRevisionId', 'teamId', 'window'])
    expect(schema.required?.sort()).toEqual(['matchId']) // teamId defaults to the managed team
    const r = await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: seed.awayTeamId, recordingRevisionId: seed.revisionId })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ schemaVersion: '1.0', query: 'threat', matchId: seed.matchId, saveId: seed.saveId, recordingRevisionId: seed.revisionId, metricDictionaryVersion: '1.3' })
    expect(r.data.source).toMatchObject({ kind: 'fmlens_archive', format: '2.8' })
    expect(r.data.metrics.attack_lane).toMatchObject({ version: 1 })
    expect(r.data.metrics.defender_clearances).toMatchObject({ version: 1 })
    expect(r.data.threat.opposition.teamId).toBe(seed.homeTeamId)
    // unknown keys, a path-shaped id and a wrong-match team are rejected with the domain error body
    expect((await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: seed.awayTeamId, path: 'C:\\x' })).data.code).toBe('invalid_input')
    expect((await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: '../x' })).data.code).toBe('invalid_input')
    expect((await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: 't_nope' })).data).toMatchObject({ code: 'not_found' })
    expect((await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: seed.awayTeamId, recordingRevisionId: 'r_nope' })).data.code).toBe('revision_unavailable')
    await c.close()
  })

  it('AC get_player_match carries the rating block; a recording without rating-model data returns a null estimate with a reason', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
    const seed = await seedSynthetic(sc.synth)
    const c = await connect(seed.home)
    const roster = (await c.call('get_match_summary', { matchId: seed.matchId })).data.summary.roster.players as Array<{ name: string; playerId: string }>
    const r = await c.call('get_player_match', { matchId: seed.matchId, playerId: roster.find((p) => p.name === 'Away Player 3')!.playerId })
    const rating = r.data.player.rating
    expect(rating.native.label).toBe('observed')
    expect(rating.estimate).toBeNull()
    expect(rating).toMatchObject({ nullReason: 'not_recorded', reason: 'rating_model_missing' })
    expect(rating.model).toMatchObject({ id: 'fmmatchlens_rating_reconstruction' })
    expect(r.data.metrics.native_rating).toBeDefined()
    await c.close()
  })
})

describe('regression: minute 0 resolves to the recording start (helper + MCP)', () => {
  it('AC fromMinute 0 is the start boundary in period 1; a minute outside the recording is still rejected, never clipped', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
    const seed = await seedSynthetic(sc.synth)
    const c = await connect(seed.home)
    const roster = (await c.call('get_match_summary', { matchId: seed.matchId })).data.summary.roster.players as Array<{ name: string; playerId: string }>
    const playerId = roster.find((p) => p.name === 'Away Player 3')!.playerId
    const viaMinute = await c.call('get_player_match', { matchId: seed.matchId, playerId, window: { fromMinute: 0, toMinute: 30 } })
    const viaBoundary = await c.call('get_player_match', { matchId: seed.matchId, playerId, window: { from: '1:0', toMinute: 30 } })
    expect(viaMinute.isError, viaMinute.text.slice(0, 200)).toBe(false)
    expect(viaMinute.data.window.from).toEqual({ period: 1, tick: 0, sequence: 0 })
    expect(viaMinute.data).toEqual(viaBoundary.data)
    const whole = await c.call('get_player_match', { matchId: seed.matchId, playerId, window: { fromMinute: 0 } })
    expect(whole.isError).toBe(false)
    expect(whole.data.window.from).toEqual({ period: 1, tick: 0, sequence: 0 })
    // other ranges keep their checks
    for (const window of [{ fromMinute: 0, period: 2 }, { fromMinute: 200 }, { toMinute: 200 }, { fromMinute: -1 }]) {
      const r = await c.call('get_player_match', { matchId: seed.matchId, playerId, window })
      expect(r.isError, JSON.stringify(window)).toBe(true)
      expect(r.data.code).toBe('invalid_input')
    }
    expect((await c.call('get_player_match', { matchId: seed.matchId, playerId, window: { fromMinute: 200 } })).data.details.reason).toBe('out_of_range')
    // minute 0 as an END is an empty window, still rejected
    const empty = await c.call('get_player_match', { matchId: seed.matchId, playerId, window: { toMinute: 0 } })
    expect(empty.isError).toBe(true)
    await c.close()
  })
})

describe.skipIf(!HAS_REAL)('Slice 3b over MCP on the real recording', () => {
  it('AC default get_opposition_threat and get_player_match outputs are under 20 KB on the real recording; fromMinute 0 works there', async () => {
    const seed = await seedFile(REAL_FIXTURE)
    const c = await connect(seed.home)
    const sizes: Record<string, number> = {}
    const sum = await c.call('get_match_summary', { matchId: seed.matchId })
    const roster = sum.data.summary.roster.players as Array<{ playerId: string; name: string; status: string }>
    for (const [label, team] of [['threat(home)', seed.homeTeamId], ['threat(away)', seed.awayTeamId]] as const) {
      const r = await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: team })
      expect(r.isError, r.text.slice(0, 300)).toBe(false)
      sizes[label] = bytes(r.text)
      expect(sizes[label], label).toBeLessThan(20 * KB)
    }
    let worst = 0
    for (const p of roster) {
      const r = await c.call('get_player_match', { matchId: seed.matchId, playerId: p.playerId })
      expect(r.isError, `${p.name}: ${r.text.slice(0, 200)}`).toBe(false)
      worst = Math.max(worst, bytes(r.text))
      expect(r.data.player.rating.native.label).toBe('observed')
    }
    sizes['get_player_match(worst of 36)'] = worst
    expect(worst).toBeLessThan(20 * KB)
    const zero = await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: seed.homeTeamId, window: { fromMinute: 0, toMinute: 45, period: 1 } })
    expect(zero.isError, zero.text.slice(0, 300)).toBe(false)
    expect(zero.data.window.from).toEqual({ period: 1, tick: 0, sequence: 0 })
    const whole = await c.call('get_opposition_threat', { matchId: seed.matchId, teamId: seed.homeTeamId })
    expect(zero.data.threat.reconciliation.shots.events).toBeLessThan(whole.data.threat.reconciliation.shots.events + 1)
    // Torquay by lane, over MCP: the three goals are listed as context
    expect(whole.data.threat.goals.items).toHaveLength(3)
    expect(whole.data.capture.partial).toBe(true)
    console.log('SLICE 3b REAL OUTPUT SIZES (bytes, compact JSON):', JSON.stringify(sizes))
    await c.close()
  }, 120_000)
})
