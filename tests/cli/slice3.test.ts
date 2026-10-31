// CLI commands added in Slice 3 so the MCP tools have a CLI equivalent: list filters, summary, compare, status.
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { ErrorEnvelopeSchema, ListDataSchema, okEnvelope } from '@fmmi/model'
import { CompareResultSchema, SummaryResultSchema } from '@fmmi/analytics'
import { cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { importMore, seedSynthetic } from '../support/mcp.ts'

afterAll(cleanupAll)

function runner(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main(args, io)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
}

describe('fmmi list / summary / compare / status', () => {
  it('AC5 JSON output validates against the schemas, and the text forms render the roster, deltas and status', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham', names: { 2009: 'Evil \u001b[31mName' } })
    const seed = await seedSynthetic(sc.synth)
    await importMore(seed.home, seed.saveId, { ...sc.synth, upstreamMatchId: 'match-synth-2', matchDate: '2026-09-07' }, 'm2.fmlens')
    const fmmi = runner(seed.home)
    const list = okEnvelope(ListDataSchema).parse(JSON.parse((await fmmi('list', '--save', seed.saveId, '--limit', '1', '--json')).out))
    expect(list.data.page).toMatchObject({ returned: 1, totalMatching: 2, truncated: true })
    expect(list.data.matches[0]!.opponent).not.toBeNull()
    const next = okEnvelope(ListDataSchema).parse(JSON.parse((await fmmi('list', '--save', seed.saveId, '--limit', '1', '--cursor', list.data.page.nextCursor!, '--json')).out))
    expect(next.data.matches[0]!.matchId).not.toBe(list.data.matches[0]!.matchId)
    expect((await fmmi('list')).code).toBe(2) // --save or --all-saves is required
    expect(okEnvelope(ListDataSchema).parse(JSON.parse((await fmmi('list', '--all-saves', '--json')).out)).data.saveId).toBeNull()

    const sum = okEnvelope(SummaryResultSchema).parse(JSON.parse((await fmmi('summary', seed.matchId, '--json')).out))
    expect(sum.data.summary.roster.players).toHaveLength(28)
    const text = await fmmi('summary', seed.matchId)
    expect(text.code).toBe(0)
    expect(text.out).toContain('Roster: 28 of 28 recorded')
    expect(text.out).toContain('Evil \\u{1b}[31mName') // control characters are escaped in text mode
    expect(text.out).not.toContain('\u001b')
    const cmp = okEnvelope(CompareResultSchema).parse(JSON.parse((await fmmi('compare', seed.matchId, '--team', seed.awayTeamId, '--b-from-minute', '50', '--b-period', '2', '--json')).out))
    expect(cmp.data.comparison.teamRates.length).toBeGreaterThan(5)
    const ctext = await fmmi('compare', seed.matchId, '--team', seed.awayTeamId, '--b-from-minute', '50', '--b-period', '2')
    expect(ctext.out).toContain('Window A:')
    expect(ctext.out).toContain('delta')
    expect((await fmmi('status', seed.matchId)).out).toContain('recipient diagnostic home: pass')
    expect((await fmmi('status')).out).toContain('Catalog: 1 save(s), 2 match(es)')
    const bad = await fmmi('compare', seed.matchId, '--json')
    expect(bad.code).toBe(2)
    expect(ErrorEnvelopeSchema.parse(JSON.parse(bad.out)).error.code).toBe('invalid_input')
  })
})
