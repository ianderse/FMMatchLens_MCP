// Slice 4 acceptance: save-scoped player identity. Synthetic recordings only (labelled), isolated catalogs.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { persistentPlayerId } from '@fmmi/store'
import { cleanupAll, service } from '../support/helpers.ts'
import { ingestOne, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

const m = (key: string, date: string, side: 'home' | 'away', over: Partial<SeasonMatch> = {}): SeasonMatch => ({ key, date, side, opponent: `Opp ${key.toUpperCase()}`, passesPerSide: 40, ...over })

type Entry = { playerId: string; name: string; identityStatus: string; matches: number; reason?: string; supportingMatchIds?: string[]; basis?: string; uid: number | null }
const find = (q: MatchQueries, saveId: string, name: string) => (q.listPlayers({ saveId, nameQuery: name, limit: 50 }).players as Entry[]).filter((p) => p.name.toLowerCase() === name.toLowerCase())

describe('Slice 4: automatic persistent identity needs a verified uid, a second match and an agreeing name', () => {
  it('AC a uid seen in one match stays match_local until a second match with the same uid and name exists; then it is persistent with the supporting match ids', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const q = new MatchQueries(svc)
    const one = await ingestOne(svc, saveId, m('s1', '2026-08-01', 'home'))
    const first = find(q, saveId, 'George Alexander')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ identityStatus: 'match_local', reason: 'single_match_uid', matches: 1, uid: 5009 })
    expect(first[0]!.playerId).toMatch(/^p_/)
    expect(q.listPlayers({ saveId, limit: 50 }).summary.persistent).toBe(0)

    const two = await ingestOne(svc, saveId, m('s2', '2026-08-08', 'away'))
    const now = find(q, saveId, 'George Alexander')
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ identityStatus: 'persistent', matches: 2, basis: 'verified_upstream_uid', uid: 5009 })
    expect(now[0]!.playerId).toBe(persistentPlayerId(saveId, 5009))
    expect(now[0]!.playerId).toMatch(/^pe_/)
    expect(now[0]!.supportingMatchIds!.slice().sort()).toEqual([one.matchId, two.matchId].sort())
    // the match-local ids still work for the match tools and are not rewritten
    const roster = svc.showMatch(one.matchId).roster
    expect(roster.find((p) => p.name === 'George Alexander')!.playerId).toMatch(/^p_/)
    svc.close()
  }, 120_000)

  it('AC the same uid with different names is flagged identity_conflict and not merged; the same name with different uids, a missing uid and a zero uid never merge', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const q = new MatchQueries(svc)
    const specs: SeasonMatch[] = [
      m('c1', '2026-08-01', 'home', { uidOverride: { 4: 8001, 5: 8101, 6: null, 7: 0 }, nameOverride: { 4: 'Pat Collision', 5: 'Same Name', 6: 'No Uid', 7: 'Zero Uid' } }),
      m('c2', '2026-08-08', 'away', { uidOverride: { 4: 8001, 5: 8102, 6: null, 7: 0 }, nameOverride: { 4: 'Pat Different', 5: 'Same Name', 6: 'No Uid', 7: 'Zero Uid' } }),
    ]
    await ingestSeason(svc, saveId, specs)
    const conflictA = find(q, saveId, 'Pat Collision'), conflictB = find(q, saveId, 'Pat Different')
    expect(conflictA[0]).toMatchObject({ identityStatus: 'match_local', reason: 'identity_conflict' })
    expect(conflictB[0]).toMatchObject({ identityStatus: 'match_local', reason: 'identity_conflict' })
    expect(svc.store.listFlags(saveId).map((f) => [f.uid, f.flag])).toEqual([[8001, 'identity_conflict']])
    expect(svc.store.listFlags(saveId)[0]!.details).toMatchObject({ reason: 'same_uid_different_names_not_merged' })
    const same = find(q, saveId, 'Same Name')
    expect(same).toHaveLength(2) // never merged on name alone
    expect(same.every((p) => p.identityStatus === 'match_local' && p.reason === 'single_match_uid')).toBe(true)
    expect(find(q, saveId, 'No Uid').map((p) => [p.identityStatus, p.reason])).toEqual([['match_local', 'uid_missing'], ['match_local', 'uid_missing']])
    expect(find(q, saveId, 'Zero Uid').map((p) => p.reason)).toEqual(['uid_not_positive', 'uid_not_positive'])
    expect(q.listPlayers({ saveId, limit: 50 }).warnings.some((w) => w.startsWith('identity_conflict'))).toBe(true)
    svc.close()
  }, 120_000)

  it('AC a negative uid stays match-local (store-level: the archive format stores uid unsigned, so a negative value is written into the observation table directly)', async () => {
    const home = service()
    const saveId = home.createSave('S').saveId
    const ids = await ingestSeason(home, saveId, [m('n1', '2026-08-01', 'home'), m('n2', '2026-08-08', 'home'), m('n3', '2026-08-15', 'home')])
    const db = new Database(join(home.config.home, 'catalog.sqlite'))
    try {
      db.prepare(`UPDATE player_observation SET uid = -7 WHERE recording_revision_id IN (?, ?) AND name = 'Synth Player 12'`).run(ids.n1!.revisionId, ids.n2!.revisionId)
    } finally { db.close() }
    home.rebuildIdentities(saveId)
    const q = new MatchQueries(home)
    const rows = find(q, saveId, 'Synth Player 12')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.identityStatus, r.reason, r.uid]).sort()).toEqual([['match_local', 'single_match_uid', 5012], ['match_local', 'uid_not_positive', -7], ['match_local', 'uid_not_positive', -7]])
    home.close()
  }, 120_000)
})

describe('Slice 4: fmmi player link resolves the rest, with an audit record and an unlink path', () => {
  const specs = [
    m('l1', '2026-08-01', 'home', { uidOverride: { 7: 7001 }, nameOverride: { 7: 'Pat One' } }),
    m('l2', '2026-08-08', 'away', { uidOverride: { 7: 7002 }, nameOverride: { 7: 'P. One' } }),
    m('l3', '2026-08-15', 'home', { uidOverride: { 7: 7003 }, nameOverride: { 7: 'Pat One' } }),
  ]

  it('AC link joins match-local identities by user decision only, records an audit entry, feeds get_player_trends, and unlink undoes it', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const ids = await ingestSeason(svc, saveId, specs)
    for (const k of Object.keys(ids)) svc.confirmMatch(ids[k]!.matchId, `${svc.showMatch(ids[k]!.matchId).result.observed.home}-${svc.showMatch(ids[k]!.matchId).result.observed.away}`)
    const q = new MatchQueries(svc)
    // same name, different uids: not merged automatically
    const before = (q.listPlayers({ saveId, nameQuery: 'one', limit: 50 }).players as Entry[])
    expect(before.map((p) => p.identityStatus)).toEqual(['match_local', 'match_local', 'match_local'])
    const local = (key: string) => svc.showMatch(ids[key]!.matchId).roster.find((p) => p.upstream.uid === { l1: 7001, l2: 7002, l3: 7003 }[key])!.playerId
    const [a, b, c] = [local('l1'), local('l2'), local('l3')] as [string, string, string]

    // trends refuse a match-local id and list it
    const excluded = await q.playerTrends({ saveId, playerIds: [a] })
    expect(excluded.players).toEqual([])
    expect(excluded.excludedIdentities).toEqual([{ playerId: a, identity: 'match_local', reason: 'match_local_identity', identityNote: 'single_match_uid', persistentPlayerId: null }])
    expect(excluded.warnings).toContain('no_persistent_player_among_the_ids: nothing was pooled')

    const link = svc.linkPlayers(saveId, [a, b], { name: 'Pat One' })
    expect(link).toMatchObject({ status: 'linked', created: true, localPlayerIds: [a, b] })
    expect(link.playerId).toMatch(/^pe_/)
    expect(link.warnings.some((w) => w.startsWith('display_names_differ'))).toBe(true)
    const audit = svc.store.listAudit().filter((x) => x.action === 'player.link')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ subjectId: link.playerId, saveId, details: { localPlayerIds: [a, b], basis: 'user_decision_not_name_merge', created: true } })

    const linked = (q.listPlayers({ saveId, nameQuery: 'one', limit: 50 }).players as Entry[]).find((p) => p.playerId === link.playerId)!
    expect(linked).toMatchObject({ identityStatus: 'linked', matches: 2, basis: 'manual_link' })
    const t = await q.playerTrends({ saveId, playerIds: [link.playerId, c], lastN: 5 })
    expect(t.players.map((p) => [p.playerId, p.kind])).toEqual([[link.playerId, 'linked']])
    expect(t.matches).toHaveLength(2)
    expect(t.players[0]!.windows[0]!.matchMinutes.every((x) => x > 0)).toBe(true)
    expect(t.excludedIdentities).toEqual([{ playerId: c, identity: 'match_local', reason: 'match_local_identity', identityNote: 'single_match_uid', persistentPlayerId: null }])
    const via = await q.playerTrends({ saveId, playerIds: [link.playerId, b] })
    expect(via.excludedIdentities[0]).toMatchObject({ playerId: b, identityNote: 'member_of_a_player', persistentPlayerId: link.playerId }) // a linked match-local id points at its player

    // extend the linked player with a third identity; refuse bad links
    expect(svc.linkPlayers(saveId, [link.playerId, c])).toMatchObject({ created: false, playerId: link.playerId })
    expect(() => svc.linkPlayers(saveId, [a, c])).toThrowError(/already belongs to a player/)
    const named = (n: string) => svc.showMatch(ids.l1!.matchId).roster.find((p) => p.name === n)!.playerId
    const other = named('Opp L1 Player 1')
    expect(() => svc.linkPlayers(saveId, [other, named('Opp L1 Player 2')])).toThrowError(/same match cannot be one player/)
    expect(() => svc.linkPlayers(saveId, [a])).toThrowError(/at least two ids/)
    expect(() => svc.linkPlayers(saveId, ['x_1', 'x_2'])).toThrowError(/start with p_/)
    expect(() => svc.linkPlayers(saveId, [other, 'p_000000000000'])).toThrowError(/not found/)

    // unlink: the identity returns to match_local; with fewer than two members the player is removed
    const u1 = svc.unlinkPlayer(saveId, c)
    expect(u1).toMatchObject({ localPlayerId: c, fromPlayerId: link.playerId, previousSource: 'manual', entityRemoved: false })
    expect(svc.store.getEntity(link.playerId)!.members).toHaveLength(2)
    const u2 = svc.unlinkPlayer(saveId, b)
    expect(u2.entityRemoved).toBe(true)
    expect(svc.store.getEntity(link.playerId)).toBeNull()
    expect((q.listPlayers({ saveId, nameQuery: 'one', limit: 50 }).players as Entry[]).map((p) => p.identityStatus)).toEqual(['match_local', 'match_local', 'match_local'])
    expect(svc.store.listAudit().filter((x) => x.action === 'player.unlink')).toHaveLength(2)
    expect(() => svc.unlinkPlayer(saveId, b)).toThrowError(/not part of a player/)
    svc.close()
  }, 180_000)

  it('AC unlinking an automatically verified identity keeps it apart across later rebuilds; a link cannot cross saves', async () => {
    const svc = service()
    const saveId = svc.createSave('A').saveId, other = svc.createSave('B').saveId
    const ids = await ingestSeason(svc, saveId, [m('u1', '2026-08-01', 'home'), m('u2', '2026-08-08', 'away'), m('u3', '2026-08-15', 'home')])
    const q = new MatchQueries(svc)
    const alex = find(q, saveId, 'George Alexander')[0]!
    expect(alex).toMatchObject({ identityStatus: 'persistent', matches: 3 })
    const localOf = (k: string) => svc.showMatch(ids[k]!.matchId).roster.find((p) => p.name === 'George Alexander')!.playerId
    const r = svc.unlinkPlayer(saveId, localOf('u2'))
    expect(r).toMatchObject({ previousSource: 'uid', entityRemoved: false })
    svc.rebuildIdentities(saveId)
    const rows = find(q, saveId, 'George Alexander')
    expect(rows.map((p) => [p.identityStatus, p.reason ?? p.basis]).sort()).toEqual([['match_local', 'unlinked_by_user'], ['persistent', 'verified_upstream_uid']])
    expect(rows.find((p) => p.identityStatus === 'persistent')!.matches).toBe(2)
    // a later ingest rebuilds identities; the exclusion survives
    await ingestOne(svc, saveId, m('u4', '2026-08-22', 'away'))
    expect(find(q, saveId, 'George Alexander').filter((p) => p.reason === 'unlinked_by_user')).toHaveLength(1)
    expect(() => svc.linkPlayers(other, [localOf('u1'), localOf('u3')])).toThrowError(/not found/)
    svc.close()
  }, 180_000)

  it('AC moving a match to another save rebuilds both saves: identities never cross', async () => {
    const svc = service()
    const a = svc.createSave('A').saveId, b = svc.createSave('B').saveId
    const ids = await ingestSeason(svc, a, [m('v1', '2026-08-01', 'home'), m('v2', '2026-08-08', 'away'), m('v3', '2026-08-15', 'home')])
    const q = new MatchQueries(svc)
    expect(find(q, a, 'George Alexander')[0]).toMatchObject({ identityStatus: 'persistent', matches: 3 })
    svc.moveMatch(ids.v3!.matchId, b)
    expect(find(q, a, 'George Alexander')[0]).toMatchObject({ identityStatus: 'persistent', matches: 2 })
    expect(find(q, b, 'George Alexander')[0]).toMatchObject({ identityStatus: 'match_local', matches: 1 })
    svc.moveMatch(ids.v2!.matchId, b)
    expect(find(q, a, 'George Alexander')[0]).toMatchObject({ identityStatus: 'match_local', matches: 1 })
    expect(find(q, b, 'George Alexander')[0]).toMatchObject({ identityStatus: 'persistent', matches: 2 })
    expect(find(q, b, 'George Alexander')[0]!.playerId).toBe(persistentPlayerId(b, 5009))
    svc.close()
  }, 180_000)
})
