// CLI and MCP parity (Slice 3 acceptance): the same inputs give the same canonical calculations, because both call
// MatchQueries. The CLI is run in process with an FMMI_HOME-isolated catalog; the MCP side is a real SDK v2 client.
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { connect, importMore, seedSynthetic } from '../support/mcp.ts'

afterAll(cleanupAll)

function cli(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main([...args, '--json'], io)
    const body = JSON.parse(out.join('\n'))
    return { code, body }
  }
}

describe('CLI and MCP parity', () => {
  it('AC5 CLI output and MCP output agree for the same inputs on every tool', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham', goals: [{ tick: 4000, side: 'away' }] })
    const seed = await seedSynthetic(sc.synth)
    await importMore(seed.home, seed.saveId, { ...sc.synth, upstreamMatchId: 'match-synth-2', homeName: 'Second FC', matchDate: '2026-09-07' }, 'm2.fmlens')
    const run = cli(seed.home)
    const c = await connect(seed.home)
    const roster = (await c.call('get_match_summary', { matchId: seed.matchId })).data.summary.roster.players as Array<{ name: string; playerId: string }>
    const striker = roster.find((p) => p.name === 'Away Player 9')!.playerId, sub = roster.find((p) => p.name === 'Away Player 11')!.playerId
    const mid = roster.find((p) => p.name === 'Away Player 3')!.playerId
    const rev = ['--recording-revision', seed.revisionId]

    const cases: Array<{ name: string; tool: string; args: Record<string, unknown>; cli: string[] }> = [
      { name: 'list', tool: 'list_matches', args: { saveId: seed.saveId, limit: 1 }, cli: ['list', '--save', seed.saveId, '--limit', '1'] },
      { name: 'list team+season', tool: 'list_matches', args: { saveId: seed.saveId, teamId: seed.awayTeamId, season: '2026-27' }, cli: ['list', '--save', seed.saveId, '--team', seed.awayTeamId, '--season', '2026-27'] },
      { name: 'list all saves', tool: 'list_matches', args: {}, cli: ['list', '--all-saves'] },
      { name: 'summary', tool: 'get_match_summary', args: { matchId: seed.matchId }, cli: ['summary', seed.matchId] },
      { name: 'summary team pinned', tool: 'get_match_summary', args: { matchId: seed.matchId, teamId: seed.awayTeamId, recordingRevisionId: seed.revisionId }, cli: ['summary', seed.matchId, '--team', seed.awayTeamId, ...rev] },
      { name: 'player', tool: 'get_player_match', args: { matchId: seed.matchId, playerId: striker }, cli: ['player', seed.matchId, striker] },
      { name: 'player window', tool: 'get_player_match', args: { matchId: seed.matchId, playerId: mid, window: { from: '2:14004', to: '2:20000' } }, cli: ['player', seed.matchId, mid, '--from', '2:14004', '--to', '2:20000'] },
      { name: 'player minutes', tool: 'get_player_match', args: { matchId: seed.matchId, playerId: mid, window: { fromMinute: 50, toMinute: 70, period: 2 }, recordingRevisionId: seed.revisionId }, cli: ['player', seed.matchId, mid, '--from-minute', '50', '--to-minute', '70', '--period', '2', ...rev] },
      { name: 'network', tool: 'get_passing_network', args: { matchId: seed.matchId, teamId: seed.awayTeamId, minPasses: 2, limit: 4 }, cli: ['network', seed.matchId, '--team', seed.awayTeamId, '--min-passes', '2', '--limit', '4'] },
      { name: 'service', tool: 'get_striker_service', args: { matchId: seed.matchId, playerId: striker, comparePlayerId: sub }, cli: ['service', seed.matchId, striker, '--compare', sub] },
      { name: 'service window', tool: 'get_striker_service', args: { matchId: seed.matchId, playerId: sub, window: { from: '2:14004', to: '2:21000' } }, cli: ['service', seed.matchId, sub, '--from', '2:14004', '--to', '2:21000'] },
      { name: 'compare', tool: 'compare_match_periods', args: { matchId: seed.matchId, teamId: seed.awayTeamId, playerIds: [mid, striker], windowA: { from: '1:3', to: '1:11041' }, windowB: { fromMinute: 50, toMinute: 70, period: 2 } }, cli: ['compare', seed.matchId, '--team', seed.awayTeamId, '--players', `${mid},${striker}`, '--a-from', '1:3', '--a-to', '1:11041', '--b-from-minute', '50', '--b-to-minute', '70', '--b-period', '2'] },
      { name: 'compare whole match vs half', tool: 'compare_match_periods', args: { matchId: seed.matchId, teamId: seed.homeTeamId, windowA: {}, windowB: { fromMinute: 50, period: 2 } }, cli: ['compare', seed.matchId, '--team', seed.homeTeamId, '--b-from-minute', '50', '--b-period', '2'] },
      { name: 'threat', tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: seed.awayTeamId }, cli: ['threat', seed.matchId, '--team', seed.awayTeamId] },
      { name: 'threat other team, window, pinned', tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: seed.homeTeamId, window: { fromMinute: 0, toMinute: 40, period: 1 }, recordingRevisionId: seed.revisionId }, cli: ['threat', seed.matchId, '--team', seed.homeTeamId, '--from-minute', '0', '--to-minute', '40', '--period', '1', ...rev] },
      { name: 'player from minute 0', tool: 'get_player_match', args: { matchId: seed.matchId, playerId: mid, window: { fromMinute: 0, toMinute: 30 } }, cli: ['player', seed.matchId, mid, '--from-minute', '0', '--to-minute', '30'] },
      { name: 'status match', tool: 'get_recording_status', args: { matchId: seed.matchId }, cli: ['status', seed.matchId] },
      { name: 'status pinned', tool: 'get_recording_status', args: { matchId: seed.matchId, recordingRevisionId: seed.revisionId }, cli: ['status', seed.matchId, ...rev] },
      { name: 'status catalog', tool: 'get_recording_status', args: {}, cli: ['status'] },
    ]
    for (const t of cases) {
      const viaCli = await run(...t.cli)
      const viaMcp = await c.call(t.tool, t.args)
      expect(viaCli.code, t.name).toBe(0)
      expect(viaMcp.isError, `${t.name}: ${viaMcp.text.slice(0, 200)}`).toBe(false)
      expect(viaMcp.data, t.name).toEqual(viaCli.body.data)
    }
    await c.close()
  })

  it('AC5 the same bad input gives the same domain error body in the CLI and over MCP', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    const seed = await seedSynthetic(sc.synth)
    const run = cli(seed.home)
    const c = await connect(seed.home)
    const mid = ((await c.call('get_match_summary', { matchId: seed.matchId })).data.summary.roster.players as Array<{ name: string; playerId: string }>).find((p) => p.name === 'Away Player 3')!.playerId
    const cases: Array<{ tool: string; args: Record<string, unknown>; cli: string[]; code: string }> = [
      { tool: 'get_player_match', args: { matchId: seed.matchId, playerId: 'p_0000000000' }, cli: ['player', seed.matchId, 'p_0000000000'], code: 'not_found' },
      { tool: 'get_match_summary', args: { matchId: 'm_nope' }, cli: ['summary', 'm_nope'], code: 'not_found' },
      { tool: 'get_match_summary', args: { matchId: seed.matchId, recordingRevisionId: 'r_nope' }, cli: ['summary', seed.matchId, '--recording-revision', 'r_nope'], code: 'revision_unavailable' },
      { tool: 'get_player_match', args: { matchId: seed.matchId, playerId: mid, window: { fromMinute: 45.5 } }, cli: ['player', seed.matchId, mid, '--from-minute', '45.5'], code: 'ambiguous_selection' },
      { tool: 'get_player_match', args: { matchId: seed.matchId, playerId: mid, window: { from: '2:20000', to: '2:14004' } }, cli: ['player', seed.matchId, mid, '--from', '2:20000', '--to', '2:14004'], code: 'invalid_input' },
      { tool: 'get_passing_network', args: { matchId: seed.matchId, teamId: 't_nope' }, cli: ['network', seed.matchId, '--team', 't_nope'], code: 'not_found' },
      { tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: 't_nope' }, cli: ['threat', seed.matchId, '--team', 't_nope'], code: 'not_found' },
      { tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: seed.awayTeamId, window: { from: '2:20000', to: '2:14004' } }, cli: ['threat', seed.matchId, '--team', seed.awayTeamId, '--from', '2:20000', '--to', '2:14004'], code: 'invalid_input' },
      { tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: seed.awayTeamId, window: { fromMinute: 0, period: 2 } }, cli: ['threat', seed.matchId, '--team', seed.awayTeamId, '--from-minute', '0', '--period', '2'], code: 'invalid_input' },
      { tool: 'get_opposition_threat', args: { matchId: seed.matchId, teamId: seed.awayTeamId, window: { fromMinute: 200 } }, cli: ['threat', seed.matchId, '--team', seed.awayTeamId, '--from-minute', '200'], code: 'invalid_input' },
      { tool: 'compare_match_periods', args: { matchId: seed.matchId, teamId: seed.awayTeamId, windowA: {}, windowB: { fromMinute: 45.5 } }, cli: ['compare', seed.matchId, '--team', seed.awayTeamId, '--b-from-minute', '45.5'], code: 'ambiguous_selection' },
    ]
    for (const t of cases) {
      const viaCli = await run(...t.cli)
      const viaMcp = await c.call(t.tool, t.args)
      expect(viaCli.code).toBe(1)
      expect(viaCli.body.ok).toBe(false)
      expect(viaMcp.isError).toBe(true)
      expect(viaMcp.data.code).toBe(t.code)
      expect(viaMcp.data).toEqual(viaCli.body.error)
    }
    await c.close()
  })
})
