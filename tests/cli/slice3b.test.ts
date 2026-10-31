// CLI for Slice 3b: fmmi threat, the rating lines of fmmi player, and the --from-minute 0 regression.
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { ErrorEnvelopeSchema, okEnvelope } from '@fmmi/model'
import { PlayerResultSchema, ThreatResultSchema } from '@fmmi/analytics'
import { HAS_REAL, REAL_FIXTURE, cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { connect, seedFile, seedSynthetic } from '../support/mcp.ts'

afterAll(cleanupAll)

function runner(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main(args, io)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
}

describe('fmmi threat / fmmi player rating (synthetic)', () => {
  it('AC threat --json validates against the schema and the text form shows lanes, goals as context and the unavailable items; --team is required', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham', goals: [{ tick: 4000, side: 'home' }] })
    const seed = await seedSynthetic(sc.synth)
    const fmmi = runner(seed.home)
    const j = okEnvelope(ThreatResultSchema).parse(JSON.parse((await fmmi('threat', seed.matchId, '--team', seed.awayTeamId, '--json')).out))
    expect(j.data.threat.opposition.teamId).toBe(seed.homeTeamId)
    expect(j.data.threat.byLane.map((l) => l.lane)).toEqual(['left', 'centre', 'right'])
    const text = await fmmi('threat', seed.matchId, '--team', seed.awayTeamId)
    expect(text.code).toBe(0)
    expect(text.out).toContain('Opposition threat: Opponent attacking Farnham')
    expect(text.out).toContain('context_only')
    expect(text.out).toContain('Unavailable defender_clearances: unverified_semantics')
    const md = await fmmi('threat', seed.matchId, '--team', seed.awayTeamId, '--format', 'markdown')
    expect(md.out).toContain('| Lane (attackers) |')
    const noTeam = await fmmi('threat', seed.matchId, '--json')
    expect(noTeam.code).toBe(2)
    expect(ErrorEnvelopeSchema.parse(JSON.parse(noTeam.out)).error.code).toBe('invalid_input')
    expect((await fmmi('threat', seed.matchId, '--team', 't_nope', '--json')).code).toBe(1)
  })

  it('AC player --json carries the rating block (schema-validated) and the text prints native, estimate state and limitations; --from-minute 0 works', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
    const seed = await seedSynthetic(sc.synth)
    const fmmi = runner(seed.home)
    const c = await connect(seed.home)
    const mid = ((await c.call('get_match_summary', { matchId: seed.matchId })).data.summary.roster.players as Array<{ name: string; playerId: string }>).find((p) => p.name === 'Away Player 3')!.playerId
    await c.close()
    const j = okEnvelope(PlayerResultSchema).parse(JSON.parse((await fmmi('player', seed.matchId, mid, '--json')).out))
    expect(j.data.player.rating.estimate).toBeNull()
    const text = await fmmi('player', seed.matchId, mid)
    expect(text.out).toContain('Estimated breakdown: n/a (not_recorded: rating_model_missing)')
    expect(text.out).toContain('not the final match rating')
    const zero = await fmmi('player', seed.matchId, mid, '--from-minute', '0', '--to-minute', '30', '--json')
    expect(zero.code, zero.out.slice(0, 300)).toBe(0)
    expect(JSON.parse(zero.out).data.window.from).toEqual({ period: 1, tick: 0, sequence: 0 })
    const bad = await fmmi('player', seed.matchId, mid, '--from-minute', '200', '--json')
    expect(bad.code).toBe(1)
    expect(JSON.parse(bad.out).error.details.reason).toBe('out_of_range')
  })
})

describe.skipIf(!HAS_REAL)('fmmi threat / player on the real recording', () => {
  it('AC the CLI answers which flank Torquay attacked, prints the three goals as context, and shows a labelled estimate for a player with mapped roles', async () => {
    const seed = await seedFile(REAL_FIXTURE)
    const fmmi = runner(seed.home)
    const t = await fmmi('threat', seed.matchId, '--team', seed.homeTeamId)
    expect(t.code).toBe(0)
    expect(t.out).toContain('Opposition threat: Torquay attacking Farnham')
    expect(t.out).toMatch(/Partial recording/)
    expect(t.out).toMatch(/left\s+right\s+1\s/) // Torquay left lane = Farnham right flank
    expect(t.out.match(/^  period \d tick \d+ \(game minute/gm)).toHaveLength(3)
    const json = okEnvelope(ThreatResultSchema).parse(JSON.parse((await fmmi('threat', seed.matchId, '--team', seed.homeTeamId, '--json')).out))
    expect(json.data.coverage).toBe('complete_for_window')
    const sum = JSON.parse((await fmmi('summary', seed.matchId, '--json')).out).data.summary.roster.players as Array<{ name: string; playerId: string }>
    const spong = sum.find((p) => p.name === 'Jack Spong')!
    const p = await fmmi('player', seed.matchId, spong.playerId)
    expect(p.out).toContain('ESTIMATED contributions')
    expect(p.out).toContain('residual +49')
    expect(p.out).toContain('rating at the end of capture, not the final match rating')
    const fromZero = await fmmi('threat', seed.matchId, '--team', seed.homeTeamId, '--from-minute', '0', '--to-minute', '45', '--period', '1', '--json')
    expect(fromZero.code, fromZero.out.slice(0, 300)).toBe(0)
  }, 120_000)
})
