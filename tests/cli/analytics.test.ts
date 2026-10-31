import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { ErrorEnvelopeSchema, okEnvelope } from '@fmmi/model'
import { NetworkResultSchema, PlayerResultSchema, ReportResultSchema, ServiceResultSchema } from '@fmmi/analytics'
import { z } from 'zod'
import { HAS_REAL, REAL_FIXTURE, cleanupAll, tmp } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { buildSyntheticArchive } from '../support/syntheticArchive.ts'

afterAll(cleanupAll)

function runner(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main(args, io)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
}
const parse = <T extends z.ZodType>(s: T, text: string) => s.parse(JSON.parse(text)) as z.infer<T>

describe('fmmi report / player / network / service (synthetic fixture)', () => {
  async function setup() {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away', homeName: 'Opponent', awayName: 'Farnham' })
    const home = tmp(), dir = tmp(), fmmi = runner(home)
    const file = join(dir, 'a.fmlens')
    writeFileSync(file, buildSyntheticArchive(sc.synth).bytes)
    const saveId = JSON.parse((await fmmi('save', 'create', 'S', '--json')).out).data.saveId as string
    await fmmi('ingest', file, '--save', saveId, '--json')
    const list = JSON.parse((await fmmi('list', '--save', saveId, '--json')).out).data.matches[0]
    const show = JSON.parse((await fmmi('show', list.matchId, '--json')).out).data
    const pidOf = (name: string) => show.roster.find((p: { name: string }) => p.name === name).playerId as string
    return { fmmi, matchId: list.matchId as string, revisionId: list.selectedRecordingRevisionId as string, awayTeam: list.away.teamId as string, homeTeam: list.home.teamId as string, pidOf }
  }

  it('AC1 all four commands produce JSON that validates against the result schema, with the section 6.4 envelope', async () => {
    const t = await setup()
    const rep = parse(okEnvelope(ReportResultSchema), (await t.fmmi('report', t.matchId, '--json')).out).data
    expect(rep).toMatchObject({ matchId: t.matchId, recordingRevisionId: t.revisionId, metricDictionaryVersion: '1.3', query: 'report' })
    expect(rep.metrics.aerial_win_pct).toMatchObject({ version: 1, unit: 'percent' })
    expect(rep.teams.away).toMatchObject({ name: 'Farnham', managed: true, teamId: t.awayTeam })
    const striker = t.pidOf('Away Player 9'), sub = t.pidOf('Away Player 11')
    const pl = parse(okEnvelope(PlayerResultSchema), (await t.fmmi('player', t.matchId, striker, '--json')).out).data
    expect(pl.player.name).toBe('Away Player 9')
    const net = parse(okEnvelope(NetworkResultSchema), (await t.fmmi('network', t.matchId, '--team', t.awayTeam, '--limit', '5', '--json')).out).data
    expect(net.network.edges).toHaveLength(5)
    expect(net.network.totals.truncated).toBe(true)
    const svc = parse(okEnvelope(ServiceResultSchema), (await t.fmmi('service', t.matchId, striker, '--compare', sub, '--json')).out).data
    expect(svc.service.comparison?.status).toBe('qualified')
    expect(svc.recordingRevisionId).toBe(t.revisionId)
  })

  it('AC1 report --format markdown has facts, findings and evidence quality and no hypotheses or recommendations', async () => {
    const t = await setup()
    const r = await t.fmmi('report', t.matchId, '--format', 'markdown')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^# Match report: Opponent v Farnham/)
    for (const h of ['## Facts', '## Deterministic findings', '## Evidence quality']) expect(r.out).toContain(h)
    expect(r.out).toContain('low_aerial_success_v1')
    expect(r.out).not.toMatch(/hypothes|recommend|should|because|caused/i)
  })

  it('AC1 revision pinning, windows and scopes are honoured and bad input gives the defined errors', async () => {
    const t = await setup()
    const pinned = parse(okEnvelope(ReportResultSchema), (await t.fmmi('report', t.matchId, '--recording-revision', t.revisionId, '--json')).out).data
    expect(pinned.recordingRevisionId).toBe(t.revisionId)
    const bad = await t.fmmi('report', t.matchId, '--recording-revision', 'r_missing', '--json')
    expect(bad.code).toBe(1)
    expect(parse(ErrorEnvelopeSchema, bad.out).error.code).toBe('revision_unavailable')
    const win = parse(okEnvelope(ReportResultSchema), (await t.fmmi('report', t.matchId, '--from', '2:14004', '--to', '2:20000', '--json')).out).data
    expect(win.window.from).toMatchObject({ period: 2, tick: 14004 })
    expect(win.coverage).toBe('partial_for_window')
    const amb = await t.fmmi('report', t.matchId, '--from-minute', '45.5', '--json')
    expect(parse(ErrorEnvelopeSchema, amb.out).error.code).toBe('ambiguous_selection')
    const rev = await t.fmmi('report', t.matchId, '--from', '2:20000', '--to', '2:14004', '--json')
    expect(parse(ErrorEnvelopeSchema, rev.out).error.code).toBe('invalid_input')
    const team = await t.fmmi('network', t.matchId, '--team', 't_nope', '--json')
    expect(parse(ErrorEnvelopeSchema, team.out).error).toMatchObject({ code: 'not_found', details: { reason: 'not_in_match' } })
    const player = await t.fmmi('player', t.matchId, 'p_nope', '--json')
    expect(parse(ErrorEnvelopeSchema, player.out).error.code).toBe('not_found')
    const scope = await t.fmmi('network', t.matchId, '--team', t.homeTeam, '--scope', 'open_play', '--json')
    expect(JSON.parse(scope.out).data.warnings.some((w: string) => w.startsWith('unverified_semantics'))).toBe(true)
    const badScope = await t.fmmi('network', t.matchId, '--team', t.homeTeam, '--scope', 'nope', '--json')
    expect(badScope.code).toBe(2)
    const usage = await t.fmmi('service', t.matchId)
    expect(usage.code).toBe(2)
    const noTeam = await t.fmmi('network', t.matchId)
    expect(noTeam.code).toBe(2)
  })

  it('AC1 text output for player, network and service names the gate status and keeps ground service null', async () => {
    const t = await setup()
    const sub = t.pidOf('Away Player 11'), striker = t.pidOf('Away Player 9')
    const p = await t.fmmi('player', t.matchId, sub)
    expect(p.out).toContain('Ground service: n/a (not_recorded)')
    const n = await t.fmmi('network', t.matchId, '--team', t.awayTeam)
    expect(n.out).toContain('Recipient gate: PASS')
    const s = await t.fmmi('service', t.matchId, striker, '--compare', sub)
    expect(s.out).toContain('Diagnosis: descriptive_only')
    expect(s.out).toContain('reception_rate_comparison_v1')
  })
})

describe.skipIf(!HAS_REAL)('fmmi on the real recording', () => {
  it('report, service and player run end to end from an imported archive and agree with the audit', async () => {
    const home = tmp(), fmmi = runner(home)
    const saveId = JSON.parse((await fmmi('save', 'create', 'Farnham Town', '--json')).out).data.saveId as string
    const ing = await fmmi('ingest', REAL_FIXTURE, '--save', saveId, '--json')
    expect(JSON.parse(ing.out).data.results[0].status).toBe('ingested')
    const list = JSON.parse((await fmmi('list', '--save', saveId, '--json')).out).data.matches[0]
    const show = JSON.parse((await fmmi('show', list.matchId, '--json')).out).data
    const pidOf = (n: string) => show.roster.find((p: { name: string }) => p.name === n).playerId as string
    const rep = parse(okEnvelope(ReportResultSchema), (await fmmi('report', list.matchId, '--json')).out).data
    expect(rep.capture).toMatchObject({ partial: true, endDisplayMinute: 87.62 })
    expect(rep.report.teams.home.metrics.find((r) => r.metric === 'passes')?.value).toBe(594)
    const svc = parse(okEnvelope(ServiceResultSchema), (await fmmi('service', list.matchId, pidOf('George Alexander'), '--compare', pidOf('Rakish Bingham'), '--json')).out).data
    expect(svc.service.recipientGate.status).toBe('pass')
    expect(svc.service.comparison?.status).toBe('qualified')
    const md = await fmmi('report', list.matchId, '--format', 'markdown')
    expect(md.out).toContain('Partial recording')
    const net = parse(okEnvelope(NetworkResultSchema), (await fmmi('network', list.matchId, '--team', list.home.teamId, '--json')).out).data
    expect(net.network.totals.edgeCompletions).toBe(523)
  })
})
