// Regression for the real-data failure `fmmi player-trends --players pe_a,pe_b` -> internal_error. Root cause: a comparison whose two
// metrics are both qualified carries NO `reasons` field (the field is optional in the result), and the CLI text renderer read
// `c.reasons.length` unconditionally. Every earlier synthetic comparison had at least one suppressed side (too little exposure, or a
// metrics filter), so `reasons` was always present and the renderer path with it absent was never executed. The same renderer runs
// before --json output is emitted, so --json failed as well; the MCP tool returns the JSON and never touched the renderer.
// Labelled synthetic recordings only; isolated FMMI_HOME catalogs.
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { MatchQueries } from '@fmmi/query'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { confirmObserved, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'
import { connect } from '../support/mcp.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const m = (key: string, date: string, side: 'home' | 'away'): SeasonMatch => ({ key, date, side, opponent: `Opp ${key.toUpperCase()}`, passesPerSide: 60 })

describe('player-trends with two or more persistent players whose comparisons are fully qualified', () => {
  it('renders text and --json through the CLI and returns the same comparison through a real MCP client; reasons is absent on a qualified comparison', async () => {
    const home = tmp('fmmi-ptr-')
    const svc = service(home)
    const saveId = svc.createSave('Synthetic Town').saveId
    const ids = await ingestSeason(svc, saveId, [m('y1', '2026-08-01', 'home'), m('y2', '2026-08-08', 'away')])
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const q = new MatchQueries(svc)
    const pid = (name: string) => (q.listPlayers({ saveId, nameQuery: name }).players[0] as { playerId: string }).playerId
    const [alex, bing, spong] = [pid('Alexander'), pid('Bingham'), pid('Spong')]
    // the precondition that made the bug reachable: no reasons on the comparison
    const core = await q.playerTrends({ saveId, playerIds: [alex, bing] })
    expect(core.comparisons[0]).toMatchObject({ status: 'qualified' })
    expect('reasons' in core.comparisons[0]!).toBe(false)
    svc.close()

    const run = async (...args: string[]) => {
      const out: string[] = [], err: string[] = []
      const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
      const code = await main(args, io)
      return { code, out: out.join('\n'), err: err.join('\n') }
    }
    for (const players of [`${alex},${bing}`, `${alex},${bing},${spong}`]) {
      const text = await run('player-trends', '--save', saveId, '--players', players)
      expect(text.code, text.err).toBe(0)
      expect(text.out).toMatch(/Comparison last 5 .* vs .*: qualified/)
      const js = await run('player-trends', '--save', saveId, '--players', players, '--json')
      expect(js.code, js.err).toBe(0)
      const body = JSON.parse(js.out) as Json
      expect(body.data.comparisons.length).toBeGreaterThan(0)

      const c = await connect(home)
      try {
        const r = await c.call('get_player_trends', { saveId, playerIds: players.split(',') })
        expect(r.isError, r.text.slice(0, 300)).toBe(false)
        expect(r.data).toEqual(body.data)
      } finally { await c.close() }
    }
  }, 180_000)
})
