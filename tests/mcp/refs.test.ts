// MCP: saveId is optional (default save, else the only save) and persistent pe_ ids work wherever a match-local p_ id does.
import { afterAll, describe, expect, it } from 'vitest'
import { TOOLS } from '@fmmi/mcp'
import { updateConfigFile } from '@fmmi/store'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { connect, openWriter } from '../support/mcp.ts'
import { FIVE, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

// Alexander (shirt index 9) and Bingham (11) play in the first two matches; in the third Alexander is a different, unrelated player.
const SPECS: SeasonMatch[] = [
  FIVE[0]!, FIVE[1]!,
  { ...FIVE[2]!, key: 'x3', uidOverride: { 9: 5999 }, nameOverride: { 9: 'Someone Unrelated' } },
]

async function build() {
  const home = tmp('fmmi-mcp-refs-')
  const w = openWriter(home)
  const save = w.createSave('Refs FC')
  const ids = await ingestSeason(w, save.saveId, SPECS)
  w.close()
  return { home, saveId: save.saveId, ids }
}

describe('MCP: pe_ ids', () => {
  it('get_player_match and get_striker_service (and its comparison) accept a persistent pe_ id and report the canonical p_ ids', async () => {
    const t = await build()
    const c = await connect(t.home)
    const players = (await c.call('list_players', { saveId: t.saveId, nameQuery: 'Alexander' })).data.players as Array<{ playerId: string; name: string }>
    const alexander = players.find((p) => p.playerId.startsWith('pe_'))!
    const bingham = ((await c.call('list_players', { saveId: t.saveId, nameQuery: 'Bingham' })).data.players as Array<{ playerId: string }>).find((p) => p.playerId.startsWith('pe_'))!
    expect(alexander).toBeDefined()
    const m1 = t.ids.f1!.matchId
    const roster = (await c.call('get_match_summary', { matchId: m1 })).data.summary.roster.players as Array<{ name: string; playerId: string }>
    const pAlexander = roster.find((p) => p.name === 'George Alexander')!.playerId
    const pBingham = roster.find((p) => p.name === 'Rakish Bingham')!.playerId

    const viaPe = await c.call('get_player_match', { matchId: m1, playerId: alexander.playerId })
    const viaP = await c.call('get_player_match', { matchId: m1, playerId: pAlexander })
    expect(viaPe.isError).toBe(false)
    expect(viaPe.data).toEqual(viaP.data)
    expect(viaPe.data.player.playerId).toBe(pAlexander)
    expect(JSON.stringify(viaPe.data)).toContain(alexander.playerId) // persistentPlayerId is still reported beside the canonical id

    const svc = await c.call('get_striker_service', { matchId: m1, playerId: alexander.playerId, comparePlayerId: bingham.playerId })
    const svcP = await c.call('get_striker_service', { matchId: m1, playerId: pAlexander, comparePlayerId: pBingham })
    expect(svc.isError).toBe(false)
    expect(svc.data).toEqual(svcP.data)
    await c.close()
  })

  it('a pe_ id of a player who did not appear in that match is a clear not_found, for the player and for the comparison', async () => {
    const t = await build()
    const c = await connect(t.home)
    const alexander = ((await c.call('list_players', { saveId: t.saveId, nameQuery: 'Alexander' })).data.players as Array<{ playerId: string }>).find((p) => p.playerId.startsWith('pe_'))!
    const m3 = t.ids.x3!.matchId
    const r = await c.call('get_player_match', { matchId: m3, playerId: alexander.playerId })
    expect(r.isError).toBe(true)
    expect(r.data).toMatchObject({ code: 'not_found', details: { reason: 'not_in_match' } })
    expect(r.data.message).toMatch(/did not appear in this match/)
    const striker = ((await c.call('get_match_summary', { matchId: m3 })).data.summary.roster.players as Array<{ name: string; playerId: string }>)[0]!
    const cmp = await c.call('get_striker_service', { matchId: m3, playerId: striker.playerId, comparePlayerId: alexander.playerId })
    expect(cmp.data).toMatchObject({ code: 'not_found', details: { reason: 'not_in_match' } })
    const unknown = await c.call('get_player_match', { matchId: t.ids.f1!.matchId, playerId: 'pe_000000000000' })
    expect(unknown.data).toMatchObject({ code: 'not_found', details: { reason: 'not_in_match' } })
    await c.close()
  })
})

describe('MCP: optional saveId', () => {
  it('the five save-scoped tools no longer require saveId; an explicit id still works', async () => {
    const t = await build()
    const required = TOOLS.filter((x) => (x.input as unknown as { shape: Record<string, { isOptional(): boolean }> }).shape.saveId?.isOptional() === false)
    expect(required.map((x) => x.name)).toEqual([])
    const c = await connect(t.home)
    const withId = await c.call('list_players', { saveId: t.saveId })
    const without = await c.call('list_players', {})
    expect(without.isError).toBe(false)
    expect(without.data).toEqual(withId.data)
    const teamId = (await c.call('list_matches')).data.matches[0].managedTeamId
    const trends = await c.call('get_season_trends', { teamId })
    expect(trends.isError).toBe(false)
    expect(trends.data.saveId).toBe(t.saveId)
    expect((await c.call('get_tactical_notes', {})).isError).toBe(false)
    const schema = (await c.client.listTools()).tools.find((x) => x.name === 'get_season_trends')!.inputSchema as { required?: string[] }
    expect(schema.required ?? []).toEqual([]) // teamId defaults to the managed team
    await c.close()
  })

  it('with several saves the default save from config.json is used; without one the error lists the saves', async () => {
    const t = await build()
    const w = openWriter(t.home)
    const other = w.createSave('Second FC')
    w.close()
    const c = await connect(t.home)
    const err = await c.call('list_players', {})
    expect(err.isError).toBe(true)
    expect(err.data).toMatchObject({ code: 'ambiguous_selection', details: { reason: 'save_required' } })
    expect(err.data.message).toContain('Refs FC')
    expect(err.data.message).toContain('Second FC')
    await c.close()

    updateConfigFile(t.home, { defaultSaveId: other.saveId })
    const c2 = await connect(t.home)
    expect((await c2.call('list_players', {})).data.saveId).toBe(other.saveId)
    expect((await c2.call('list_players', { saveId: t.saveId })).data.saveId).toBe(t.saveId) // explicit ids keep working
    await c2.close()
  })
})

describe('MCP: optional teamId defaults to the managed team', () => {
  it('season, network, compare, threat and tactical-change tools work without teamId and equal the explicit call; threat still defends the managed team', async () => {
    const t = await build()
    const w = openWriter(t.home)
    w.applyDetectedManagedTeam(t.saveId)
    w.close()
    const c = await connect(t.home)
    const managed = (await c.call('list_matches')).data.matches[0].managedTeamId as string
    const m1 = t.ids.f1!.matchId
    for (const [tool, args] of [
      ['get_season_trends', { lastN: 5 }], ['get_passing_network', { matchId: m1 }], ['get_opposition_threat', { matchId: m1 }],
      ['compare_match_periods', { matchId: m1, windowA: {}, windowB: { from: '2:14004' } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const bare = await c.call(tool, args)
      const explicit = await c.call(tool, { ...args, teamId: managed })
      expect(bare.isError, tool).toBe(false)
      expect(bare.data, tool).toEqual(explicit.data)
    }
    const schema = (await c.client.listTools()).tools.find((x) => x.name === 'get_opposition_threat')!.inputSchema as { required?: string[] }
    expect(schema.required).toEqual(['matchId'])
    await c.close()
  })

  it('without a known managed team the save-scoped tools ask for teamId; a match-scoped tool still uses the managed side recorded in the match', async () => {
    const t = await build()
    const c = await connect(t.home)
    const r = await c.call('get_season_trends', {})
    expect(r.isError).toBe(true)
    expect(r.data).toMatchObject({ code: 'invalid_input', details: { reason: 'team_required' } })
    expect(r.data.message).toMatch(/pass teamId/)
    expect((await c.call('get_passing_network', { matchId: t.ids.f1!.matchId })).isError).toBe(false)
    await c.close()

    const h = tmp('fmmi-mcp-noteam-')
    const w = openWriter(h)
    const s = w.createSave('No Human')
    const file = await ingestSeason(w, s.saveId, [{ ...FIVE[0]!, key: 'n1', synth: { humanSide: undefined } }])
    w.close()
    const c2 = await connect(h)
    const e = await c2.call('get_opposition_threat', { matchId: file.n1!.matchId })
    expect(e.data).toMatchObject({ code: 'invalid_input', details: { reason: 'team_required' } })
    await c2.close()
  })
})
