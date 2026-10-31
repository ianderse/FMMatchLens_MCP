// Match-scoped results state the TRUE identity of a player: persistent, linked or match_local, with the save-scoped persistent id (pe_...) when
// one exists. Synthetic recordings only (labelled), isolated catalogs. The analytics stay pure; the query layer supplies the identity, read from
// the catalog on every call (never from the decoded-recording cache), so a link, an unlink or a second match changes the next answer.
import { afterAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { persistentPlayerId } from '@fmmi/store'
import { cleanupAll, service } from '../support/helpers.ts'
import { ingestOne } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

const m = (key: string, date: string, side: 'home' | 'away', over: Partial<SeasonMatch> = {}): SeasonMatch => ({ key, date, side, opponent: `Opp ${key.toUpperCase()}`, passesPerSide: 40, ...over })
const rosterOf = async (q: MatchQueries, matchId: string) => (await q.summary(matchId)).summary.roster.players as Json[]
const byName = (players: Json[], name: string) => players.find((p) => p.name === name)!

describe('identity in match-scoped results', () => {
  it('a persistent player is reported as persistent with his pe_ id in the roster, get_player_match and get_striker_service (subject and comparison); a single-match player stays match_local with null', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const q = new MatchQueries(svc)
    const one = await ingestOne(svc, saveId, m('p1', '2026-08-01', 'home', { nameOverride: { 13: 'Only Once' }, uidOverride: { 13: 7013 } }))

    // before the second match he is match-local
    const early = byName(await rosterOf(q, one.matchId), 'George Alexander')
    expect(early).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    expect(((await q.player(one.matchId, early.playerId)) as Json).player).toMatchObject({ identity: 'match_local', persistentPlayerId: null })

    // the same MatchQueries (same decoded-recording cache) sees the new identity after the second match: nothing stale is served
    await ingestOne(svc, saveId, m('p2', '2026-08-08', 'away'))
    const pe = persistentPlayerId(saveId, 5009)
    const roster = await rosterOf(q, one.matchId)
    const alexander = byName(roster, 'George Alexander')
    expect(alexander).toMatchObject({ identity: 'persistent', persistentPlayerId: pe })
    expect(alexander.playerId).toMatch(/^p_/) // the p_ id keeps working everywhere
    const bingham = byName(roster, 'Rakish Bingham')
    expect(bingham).toMatchObject({ identity: 'persistent' })

    const pm = (await q.player(one.matchId, alexander.playerId)) as Json
    expect(pm.player).toMatchObject({ playerId: alexander.playerId, identity: 'persistent', persistentPlayerId: pe })
    const svcOut = (await q.service(one.matchId, alexander.playerId, { comparePlayerId: bingham.playerId })) as Json
    expect(svcOut.service.subject.player).toMatchObject({ identity: 'persistent', persistentPlayerId: pe })
    expect(svcOut.service.comparator.player).toMatchObject({ identity: 'persistent', persistentPlayerId: persistentPlayerId(saveId, 5011) })

    // a truly match-local player (one match, a uid nobody else has) is match_local with null, in every presentation
    const once = byName(roster, 'Only Once')
    expect(once).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    expect(((await q.player(one.matchId, once.playerId)) as Json).player).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    const mixed = (await q.service(one.matchId, once.playerId, { comparePlayerId: alexander.playerId })) as Json
    expect(mixed.service.subject.player).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    expect(mixed.service.comparator.player).toMatchObject({ identity: 'persistent', persistentPlayerId: pe })

    // the persistent id from list_players is the same one the match result states
    const listed = q.listPlayers({ saveId, nameQuery: 'George Alexander', limit: 5 }).players as Json[]
    expect(listed[0]).toMatchObject({ playerId: pe, identityStatus: 'persistent' })

    // fmmi show (catalog view) says the same
    const shown = svc.showMatch(one.matchId).roster.find((p) => p.name === 'George Alexander')!
    expect(shown).toMatchObject({ identity: 'persistent', persistentPlayerId: pe })
    expect(svc.showMatch(one.matchId).roster.find((p) => p.name === 'Only Once')).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    svc.close()
  }, 120_000)

  it('a player joined by `player link` is reported as linked with the pe_ id, and unlinking him is reflected on the next call', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const q = new MatchQueries(svc)
    // two different uids and names: the automatic rule cannot join them; only the user's decision can
    const a = await ingestOne(svc, saveId, m('l1', '2026-08-01', 'home', { nameOverride: { 12: 'Pat Linkford' }, uidOverride: { 12: 9101 } }))
    const b = await ingestOne(svc, saveId, m('l2', '2026-08-08', 'away', { nameOverride: { 12: 'Patrick Linkford' }, uidOverride: { 12: 9102 } }))
    const pa = byName(await rosterOf(q, a.matchId), 'Pat Linkford'), pb = byName(await rosterOf(q, b.matchId), 'Patrick Linkford')
    expect(pa).toMatchObject({ identity: 'match_local', persistentPlayerId: null })

    const link = svc.linkPlayers(saveId, [pa.playerId, pb.playerId], { name: 'Pat Linkford' })
    expect(link.status).toBe('linked')
    const after = byName(await rosterOf(q, a.matchId), 'Pat Linkford')
    expect(after).toMatchObject({ identity: 'linked', persistentPlayerId: link.playerId })
    expect(byName(await rosterOf(q, b.matchId), 'Patrick Linkford')).toMatchObject({ identity: 'linked', persistentPlayerId: link.playerId })
    expect(((await q.player(a.matchId, pa.playerId)) as Json).player).toMatchObject({ identity: 'linked', persistentPlayerId: link.playerId })
    expect(((await q.service(b.matchId, pb.playerId)) as Json).service.subject.player).toMatchObject({ identity: 'linked', persistentPlayerId: link.playerId })
    expect(svc.showMatch(a.matchId).roster.find((p) => p.name === 'Pat Linkford')).toMatchObject({ identity: 'linked', persistentPlayerId: link.playerId })

    svc.unlinkPlayer(saveId, pa.playerId)
    expect(byName(await rosterOf(q, a.matchId), 'Pat Linkford')).toMatchObject({ identity: 'match_local', persistentPlayerId: null })
    svc.close()
  }, 120_000)

  it('identity is read from the catalog on every call and the MCP server stays read-only: no write happens when a player is presented', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    const q = new MatchQueries(svc)
    const a = await ingestOne(svc, saveId, m('r1', '2026-08-01', 'home'))
    await ingestOne(svc, saveId, m('r2', '2026-08-08', 'home'))
    const before = JSON.stringify(svc.listPlayerCatalog(saveId))
    await rosterOf(q, a.matchId)
    expect(JSON.stringify(svc.listPlayerCatalog(saveId))).toBe(before)
    svc.close()
  }, 120_000)
})
