// Slice 4 CLI: season history, player identity, tactical notes, club aliases and aggregates, run in process against an
// FMMI_HOME-isolated catalog. Labelled synthetic recordings only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { ListPlayersResultSchema, SeasonTrendsResultSchema, TacticalChangeResultSchema } from '@fmmi/analytics'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { FIVE, writeSynth, buildSeasonMatch } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

function runner(home: string) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main(args, io)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
}

describe('Slice 4 CLI', () => {
  const home = tmp('fmmi-cli4-')
  const run = runner(home)
  const j = async (...args: string[]) => { const r = await run(...args, '--json'); return { ...r, body: (r.out ? JSON.parse(r.out) : null) as Json } }
  let saveId = '', teamId = ''
  const ids: Record<string, { matchId: string; revisionId: string }> = {}
  const specs: SeasonMatch[] = FIVE.slice(0, 4)

  beforeAll(async () => {
    saveId = (await j('save', 'create', 'Synthetic Town')).body.data.saveId
    for (const s of specs) {
      const file = writeSynth(await buildSeasonMatch(s), `${s.key}.fmlens`)
      const r = await j('ingest', file, '--save', saveId)
      expect(r.code, r.out).toBe(0)
      ids[s.key] = { matchId: r.body.data.results[0].matchId, revisionId: r.body.data.results[0].recordingRevisionId }
    }
    teamId = (await j('list', '--save', saveId)).body.data.matches[0].managedTeamId
  }, 180_000)

  it('AC trends need a team: a missing --team with no managed team is a usage error (exit 2) that points at detection', async () => {
    const r = await run('trends', '--save', saveId)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/no managed team/)
    const unconfirmed = await j('trends', '--save', saveId, '--team', teamId)
    expect(unconfirmed.code).toBe(0)
    expect(unconfirmed.body.data.eligibleMatches).toBe(0)
    expect(unconfirmed.body.data.excluded.map((e: Json) => e.reasons)).toEqual(specs.map(() => ['completion_unknown']))
    expect(unconfirmed.body.data.warnings.some((w: string) => w.startsWith('no_eligible_matches'))).toBe(true)
  })

  it('AC assisted managed-team detection, an explicit set, and club aliases drive --team; the output validates against the published schema', async () => {
    const d = await j('save', 'team', 'detect', '--save', saveId)
    expect(d.body.data.suggestion).toMatchObject({ name: 'Synthetic Town' })
    expect(d.body.data.current).toBeNull()
    const text = await run('save', 'team', 'detect', '--save', saveId)
    expect(text.out).toMatch(/Suggestion: Synthetic Town/)
    const applied = await j('save', 'team', 'detect', '--apply', '--save', saveId)
    expect(applied.body.data).toMatchObject({ source: 'assisted' })
    expect((await j('club', 'alias', 'add', '--save', saveId, '--team', 'Synthetic Town', '--alias', 'STFC')).body.data).toMatchObject({ created: true })
    expect((await j('club', 'alias', 'list', '--save', saveId)).body.data.aliases).toEqual([{ teamId, teamName: 'Synthetic Town', alias: 'STFC' }])
    for (const k of Object.keys(ids)) {
      const m = (await j('show', ids[k]!.matchId)).body.data.result.observed
      expect((await j('match', 'confirm', ids[k]!.matchId, '--score', `${m.home}-${m.away}`)).code).toBe(0)
    }
    // no --team: the managed team; --team stfc: the alias; --team <id>: the id. All three agree.
    const byDefault = await j('trends', '--save', saveId, '--last', '5')
    const byAlias = await j('trends', '--save', saveId, '--team', 'stfc', '--last', '5')
    const byId = await j('trends', '--save', saveId, '--team', teamId, '--last', '5')
    expect(byAlias.body.data).toEqual(byDefault.body.data)
    expect(byId.body.data).toEqual(byDefault.body.data)
    expect(byDefault.body.data.windows[0].matchIds).toEqual(specs.map((s) => ids[s.key]!.matchId))
    expect(SeasonTrendsResultSchema.safeParse(byDefault.body.data).success).toBe(true)
    // an explicit set wins and detection cannot replace it
    const opp = (await j('list', '--save', saveId)).body.data.matches[0].opponent.teamId
    expect((await j('save', 'team', 'set', '--save', saveId, '--team', opp)).body.data.source).toBe('explicit')
    const refuse = await j('save', 'team', 'detect', '--apply', '--save', saveId)
    expect(refuse.code).toBe(1)
    expect(refuse.body.error).toMatchObject({ code: 'invalid_input', details: { reason: 'explicit_assignment_exists' } })
    expect((await j('save', 'team', 'clear', '--save', saveId)).body.data.cleared).toBe(true)
    expect((await j('save', 'team', 'detect', '--apply', '--save', saveId)).body.data.source).toBe('assisted')
    const refused = await j('club', 'alias', 'add', '--save', saveId, '--team', 'Synthetic Town', '--alias', byDefault.body.data.matches[0].opponent.name)
    expect(refused.body.error.code).toBe('identity_conflict')
  }, 120_000)

  it('AC the five-match review prints the exact contributing matches and revisions, the manual labels and the unavailable list; text output is escaped', async () => {
    const r = await run('review', '--last', '5', '--save', saveId)
    expect(r.code).toBe(0)
    for (const k of Object.keys(ids)) { expect(r.out).toContain(ids[k]!.matchId); expect(r.out).toContain(ids[k]!.revisionId) }
    expect(r.out).toMatch(/Rolling review: Synthetic Town/)
    expect(r.out).toMatch(/\(manual\)/)
    expect(r.out).toMatch(/Pooled rates \(numerator \/ denominator\)/)
    expect(r.out).toMatch(/unavailable non_penalty_xg/)
    const t = await run('trends', '--save', saveId, '--include-partial', '--home-away', 'home')
    expect(t.code).toBe(0)
    expect(t.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
    expect((await run('trends', '--save', saveId, '--home-away', 'sideways')).code).toBe(2)
    expect((await run('trends', '--save', saveId, '--last', 'many')).code).toBe(2)
  })

  it('AC players, link and unlink, with an audit trail; the usage errors exit with 2', async () => {
    const pl = await j('players', '--save', saveId, '--name', 'Alexander')
    expect(ListPlayersResultSchema.safeParse(pl.body.data).success).toBe(true)
    const alex = pl.body.data.players[0]
    expect(alex).toMatchObject({ identityStatus: 'persistent', supportingMatchesTotal: 4 })
    expect((await run('players', '--save', saveId, '--name', 'Alexander')).out).toMatch(/persistent/)
    const pt = await j('player-trends', '--save', saveId, '--players', alex.playerId, '--last', '5')
    expect(pt.code).toBe(0)
    expect(pt.body.data.players[0].windows[0].matchIds).toEqual(specs.map((s) => ids[s.key]!.matchId))
    expect(pt.body.data.groundService.nullReason).toBe('not_recorded')
    expect((await run('player-trends', '--save', saveId, '--players', alex.playerId)).out).toMatch(/Ground service: unavailable/)
    expect((await run('player-trends', '--save', saveId)).code).toBe(2)
    // link two unrelated opposition identities (user decision) and undo it
    const roster = (await j('show', ids.f1!.matchId)).body.data.roster as Json[]
    const roster2 = (await j('show', ids.f2!.matchId)).body.data.roster as Json[]
    const a = roster.find((p) => p.name === 'Horsham Rovers Player 5').playerId, b = roster2.find((p) => p.name === 'Torquay Athletic Player 5').playerId
    const linked = await j('player', 'link', a, b, '--save', saveId, '--name', 'Pat Linked')
    expect(linked.code).toBe(0)
    expect(linked.body.data).toMatchObject({ status: 'linked', created: true, localPlayerIds: [a, b] })
    expect((await run('player', 'link', a, b, '--save', saveId)).code).toBe(1) // already linked
    expect((await j('players', '--save', saveId, '--name', 'Pat Linked')).body.data.players[0]).toMatchObject({ identityStatus: 'linked', matches: 2 })
    const un = await j('player', 'unlink', a, '--save', saveId)
    expect(un.body.data).toMatchObject({ localPlayerId: a, entityRemoved: true })
    expect((await run('player', 'link', a, '--save', saveId)).code).toBe(2) // one id is a usage error
    // the single-match players of the old `player <matchId> <playerId>` command are unaffected
    expect((await run('player', ids.f1!.matchId, a)).code).toBe(0)
  }, 120_000)

  it('AC notes: add, list, supersede and compare locally; usage errors exit with 2; notes are labelled manual', async () => {
    expect((await run('note', 'add', ids.f2!.matchId, '--setting', 'Mentality', '--prior-value', 'a', '--new-value', 'b')).code).toBe(2) // no --minute
    expect((await run('note', 'add', ids.f2!.matchId, '--minute', 'soon', '--setting', 'Mentality', '--prior-value', 'a', '--new-value', 'b')).code).toBe(2)
    expect((await run('note', 'bogus')).code).toBe(2)
    const add = await j('note', 'add', ids.f2!.matchId, '--minute', '60', '--setting', 'Mentality‮', '--prior-value', 'Balanced', '--new-value', 'Positive', '--team', 'STFC')
    expect(add.code, add.out).toBe(0)
    expect(add.body.data).toMatchObject({ confidence: 'manual', source: 'user_entered', side: 'away', minute: 60 })
    const text = await run('note', 'add', ids.f3!.matchId, '--minute', '70', '--setting', 'Mentality‮', '--prior-value', 'Positive', '--new-value', 'Cautious', '--side', 'home')
    expect(text.out).toMatch(/\(manual, user-entered\)/)
    expect(text.out).toContain('\\u{202e}') // bidi control characters are escaped, not printed
    expect(text.out).toMatch(/FMMatchLens did not record this change/)
    const bad = await j('note', 'add', ids.f2!.matchId, '--minute', '60', '--setting', 'x', '--prior-value', 'a', '--new-value', 'b', '--team', 'Opp f3')
    expect(bad.body.error).toMatchObject({ code: 'not_found' })
    const list = await j('note', 'list', '--save', saveId)
    expect(list.body.data.notes).toHaveLength(2)
    expect((await run('note', 'list', '--save', saveId)).out).toMatch(/\[current\]/)
    const noteId = add.body.data.noteId as string
    const sup = await j('note', 'supersede', noteId, '--new-value', 'Very positive')
    expect(sup.body.data).toMatchObject({ supersedes: noteId, newValue: 'Very positive', priorValue: 'Balanced' })
    expect((await j('note', 'supersede', noteId, '--minute', '65')).body.error.details).toMatchObject({ reason: 'already_superseded' })
    expect((await run('note', 'supersede', sup.body.data.noteId)).code).toBe(2) // nothing to correct
    const statuses = (await j('note', 'list', '--save', saveId)).body.data.notes.map((n: Json) => n.status)
    expect(statuses).toEqual(expect.arrayContaining(['superseded', 'current']))
    const cmp = await j('note', 'compare', sup.body.data.noteId, '--before', '1', '--after', '1')
    expect(cmp.code, cmp.out).toBe(0)
    expect(TacticalChangeResultSchema.safeParse(cmp.body.data).success).toBe(true)
    expect(cmp.body.data.across.before.matches).toHaveLength(1)
    const txt = await run('note', 'compare', sup.body.data.noteId, '--save', saveId, '--team', 'stfc')
    expect(txt.out).toMatch(/Tactical change comparison for Synthetic Town/)
    expect(txt.out).toMatch(/Confounders:/)
    expect(txt.out).not.toMatch(/\bcaused\b|\bbecause\b/i)
  }, 120_000)

  it('AC aggregates rebuild is idempotent and reports what it did', async () => {
    const r = await j('aggregates', 'rebuild', '--save', saveId)
    expect(r.code).toBe(0)
    expect(r.body.data).toMatchObject({ revisions: 4, rebuilt: 0, alreadyCurrent: 4 })
    expect((await run('aggregates', 'nope')).code).toBe(2)
    expect((await run('aggregates', 'rebuild', '--save', 's_nope')).code).toBe(1)
  })

  it('AC the help lists every new command', async () => {
    const h = await run('help')
    for (const c of ['fmmi trends', 'fmmi review', 'fmmi players', 'fmmi player-trends', 'fmmi player link', 'fmmi player unlink', 'fmmi note add', 'fmmi note list', 'fmmi note supersede', 'fmmi note compare', 'fmmi save team', 'fmmi club alias', 'fmmi aggregates rebuild']) expect(h.out, c).toContain(c)
  })
})
