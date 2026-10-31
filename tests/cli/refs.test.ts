// Human references in the CLI: latest / team-name fragments for matches, p_ / pe_ / name fragments for players, optional --save and the
// managed-team default for --team. Ambiguity lists the candidates and never guesses; existing ids keep their meaning.
import { afterAll, describe, expect, it } from 'vitest'
import { CatalogService, loadConfig, updateConfigFile } from '@fmmi/store'
import { cleanupAll } from '../support/helpers.ts'
import { FIVE, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'
import { rig, world } from '../support/world.ts'

afterAll(cleanupAll)

const SPECS: SeasonMatch[] = [
  { ...FIVE[0]!, key: 'm1', date: '2026-08-08', opponent: 'Horsham Rovers' },
  { ...FIVE[1]!, key: 'm2', date: '2026-08-15', opponent: 'Torquay Athletic' },
  { ...FIVE[2]!, key: 'm3', date: '2026-08-22', opponent: 'Horsham Albion', uidOverride: { 9: 5999 }, nameOverride: { 9: 'Someone Unrelated' } },
]

async function build() {
  const w = world({ game: false })
  const svc = new CatalogService(loadConfig(w.home, {}))
  const save = svc.createSave('Refs FC')
  const ids = await ingestSeason(svc, save.saveId, SPECS)
  svc.close()
  const r = rig(w)
  const j = async (...args: string[]) => { const x = await r.run(...args, '--json'); return { ...x, body: x.out ? JSON.parse(x.out) : null } }
  return { w, r, j, saveId: save.saveId, ids }
}

describe('match references', () => {
  it('latest, an exact id, and a unique team-name fragment resolve; an existing id keeps its meaning', async () => {
    const t = await build()
    const byId = await t.j('show', t.ids.m2!.matchId)
    expect(byId.body.data.matchId).toBe(t.ids.m2!.matchId)
    expect((await t.j('show', 'latest')).body.data.matchId).toBe(t.ids.m3!.matchId)
    expect((await t.j('show', 'LATEST')).body.data.matchId).toBe(t.ids.m3!.matchId)
    expect((await t.j('show', 'torquay')).body.data.matchId).toBe(t.ids.m2!.matchId)
    expect((await t.j('show', 'rovers')).body.data.matchId).toBe(t.ids.m1!.matchId)
    expect((await t.j('show', 'ATHLETIC')).body.data.matchId).toBe(t.ids.m2!.matchId)
    const report = await t.j('report') // no reference at all: the latest match
    expect(report.body.data.matchId).toBe(t.ids.m3!.matchId)
    expect((await t.j('status', 'torquay')).body.data.matchId).toBe(t.ids.m2!.matchId)
    const bogus = await t.j('show', 'm_nope')
    expect(bogus.body.error).toMatchObject({ code: 'not_found', message: 'Match not found', details: { matchId: 'm_nope' } })
  })

  it('an ambiguous fragment is an error listing the candidates with date, teams and score; it never guesses', async () => {
    const t = await build()
    const r = await t.j('show', 'horsham')
    expect(r.code).toBe(1)
    expect(r.body.error.code).toBe('ambiguous_selection')
    expect(r.body.error.details.reason).toBe('match_ambiguous')
    expect((r.body.error.details.candidates as Array<{ matchId: string }>).map((c) => c.matchId).sort()).toEqual([t.ids.m1!.matchId, t.ids.m3!.matchId].sort())
    const text = await t.r.run('show', 'horsham')
    expect(text.err).toContain(t.ids.m1!.matchId)
    expect(text.err).toContain(t.ids.m3!.matchId)
    expect(text.err).toMatch(/2026-08-08 {2}Synthetic Town \d-\d Horsham Rovers/)
    const all = await t.j('show', 'synthetic') // the managed club is in every match
    expect(all.body.error.code).toBe('ambiguous_selection')
    expect((await t.j('show', 'zzz')).body.error.code).toBe('not_found')
    // nothing was changed by a failed reference
    expect((await t.j('match', 'confirm', 'horsham', '--score', '1-0')).body.error.code).toBe('ambiguous_selection')
  })

  it('match confirm takes a reference too, and a unique fragment confirms that match', async () => {
    const t = await build()
    const c = await t.j('match', 'confirm', 'torquay', '--score', '1-1')
    expect(c.code, c.err).toBe(0)
    expect(c.body.data.matchId).toBe(t.ids.m2!.matchId)
  })
})

describe('player references', () => {
  it('a p_ id, a pe_ id and a unique name fragment resolve to the same player; an ambiguous fragment lists ids, sides and positions', async () => {
    const t = await build()
    const m1 = t.ids.m1!.matchId
    const roster = (await t.j('summary', m1)).body.data.summary.roster.players as Array<{ playerId: string; name: string }>
    const p = roster.find((x) => x.name === 'George Alexander')!.playerId
    const pe = ((await t.j('players', '--name', 'Alexander')).body.data.players as Array<{ playerId: string }>).find((x) => x.playerId.startsWith('pe_'))!.playerId
    const byP = await t.j('player', m1, p)
    const byPe = await t.j('player', m1, pe)
    const byName = await t.j('player', 'rovers', 'alexander')
    expect(byP.code, byP.err).toBe(0)
    expect(byPe.body.data).toEqual(byP.body.data)
    expect(byName.body.data).toEqual(byP.body.data)
    const svc = await t.j('service', 'rovers', 'alexander', '--compare', 'bingham')
    expect(svc.code, svc.err).toBe(0)

    const amb = await t.j('player', m1, 'synth player')
    expect(amb.body.error).toMatchObject({ code: 'ambiguous_selection', details: { reason: 'player_ambiguous' } })
    const cands = amb.body.error.details.candidates as Array<{ playerId: string; name: string; side: string }>
    expect(cands.length).toBeGreaterThan(5)
    expect(cands.every((c) => c.playerId.startsWith('p_') && c.name.toLowerCase().includes('synth player') && ['home', 'away'].includes(c.side))).toBe(true)
    const text = await t.r.run('player', m1, 'synth player')
    expect(text.err).toMatch(/p_[0-9a-f]+ {2}Synth Player \d+ {2}\((home|away)/)
    expect((await t.j('player', m1, 'nobody called this')).body.error.code).toBe('not_found')
  })

  it('a pe_ id of a player who did not play in that match is a clear error', async () => {
    const t = await build()
    const pe = ((await t.j('players', '--name', 'Alexander')).body.data.players as Array<{ playerId: string }>).find((x) => x.playerId.startsWith('pe_'))!.playerId
    const r = await t.j('player', t.ids.m3!.matchId, pe)
    expect(r.body.error).toMatchObject({ code: 'not_found', details: { reason: 'not_in_match' } })
    expect(r.body.error.message).toMatch(/did not appear in this match/)
  })
})

describe('--team defaults to the managed team', () => {
  it('network, threat and compare need --team until the club is known, then use it; a team name works as --team', async () => {
    const t = await build()
    const before = await t.r.run('network', 'torquay')
    expect(before.code).toBe(2)
    expect(before.err).toMatch(/fmmi save team detect --apply/)
    expect((await t.j('save', 'team', 'detect', '--apply')).code).toBe(0)
    const m2 = t.ids.m2!.matchId
    const byDefault = await t.j('network', 'torquay')
    const byName = await t.j('network', m2, '--team', 'synthetic town')
    expect(byDefault.code, byDefault.err).toBe(0)
    expect(byName.body.data).toEqual(byDefault.body.data)
    expect((await t.j('threat', 'torquay')).code).toBe(0)
    const cmp = await t.j('compare', 'torquay', '--b-from', '2:14004')
    expect(cmp.code, cmp.out).toBe(0)
    const opponent = await t.j('network', m2, '--team', 'Torquay Athletic')
    expect(opponent.code, opponent.err).toBe(0)
    expect(opponent.body.data.team?.name ?? opponent.body.data.teams?.home?.name).toBeDefined()
  })
})

describe('--save is optional', () => {
  it('the only save is the default; a save name works; several saves without a default list their names; a configured default wins', async () => {
    const t = await build()
    const one = await t.j('list')
    expect(one.body.data.saveName).toBe('Refs FC')
    expect((await t.j('list', '--save', 'refs fc')).body.data.saveId).toBe(t.saveId)
    expect((await t.j('list', '--save', t.saveId)).body.data.saveId).toBe(t.saveId)
    const svc = new CatalogService(loadConfig(t.w.home, {}))
    const second = svc.createSave('Second Club')
    svc.close()
    const many = await t.j('list')
    expect(many.code).toBe(1)
    expect(many.body.error).toMatchObject({ code: 'ambiguous_selection', details: { reason: 'save_required' } })
    expect(many.body.error.message).toContain('Refs FC')
    expect(many.body.error.message).toContain('Second Club')
    const text = await t.r.run('players')
    expect(text.err).toMatch(/Refs FC.*Second Club|Second Club.*Refs FC/)
    expect((await t.j('list', '--save', 'second')).body.data.saveId).toBe(second.saveId)
    expect((await t.j('list', '--save', 'nonsense')).body.error).toMatchObject({ code: 'not_found', details: { reason: 'save_ref' } })
    updateConfigFile(t.w.home, { defaultSaveId: second.saveId })
    expect((await t.j('list')).body.data.saveId).toBe(second.saveId)
    expect((await t.j('list', '--save', t.saveId)).body.data.saveId).toBe(t.saveId) // an explicit id still wins
    expect((await t.j('list', '--all-saves')).body.data.saveId).toBeNull()
    // the environment sits between the flag and the file
    const env = rig(t.w, { env: { FMMI_HOME: t.w.home, FMMI_DEFAULT_SAVE: t.saveId } })
    expect(JSON.parse((await env.run('list', '--json')).out).data.saveId).toBe(t.saveId)
  })

  it('match move still needs an explicit destination save', async () => {
    const t = await build()
    const r = await t.r.run('match', 'move', 'torquay')
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--save/)
  })
})
