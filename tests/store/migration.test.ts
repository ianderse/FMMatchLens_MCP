// Migration v1 -> v2 (Slice 4; the v3 columns added by Slice 5 are left out when the v1 rows are rebuilt, because v1 did not have them): an existing Slice 1-3 catalog keeps all its data, gains the season tables, backfills player observations from
// the stored projections without decoding any archive, and builds its aggregates on demand. A read-only reader refuses the old schema.
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { CatalogService, MIGRATIONS, loadConfig } from '@fmmi/store'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { confirmObserved, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

const specs: SeasonMatch[] = [
  { key: 'g1', date: '2026-08-01', side: 'home', opponent: 'Alpha FC', passesPerSide: 40, goals: [{ tick: 5000, side: 'home' }] },
  { key: 'g2', date: '2026-08-08', side: 'away', opponent: 'Bravo FC', passesPerSide: 40 },
]

describe('catalog migration v1 -> v2', () => {
  it('AC an existing catalog is upgraded in place: data kept, observations backfilled, aggregates built on demand, a read-only reader refuses the old schema', async () => {
    // Build a real v2 catalog, then reconstruct what a Slice 3b (schema v1) catalog held: the v1 tables with the same rows and user_version 1.
    const src = service()
    const saveId = src.createSave('Synthetic Town').saveId
    const ids = await ingestSeason(src, saveId, specs)
    for (const k of Object.keys(ids)) confirmObserved(src, ids[k]!.matchId)
    src.close()

    const home = tmp('fmmi-v1-')
    mkdirSync(home, { recursive: true })
    cpSync(join(src.config.home, 'snapshots'), join(home, 'snapshots'), { recursive: true })
    const db = new Database(join(home, 'catalog.sqlite'))
    db.exec(MIGRATIONS[0]!)
    db.exec(`ATTACH DATABASE '${join(src.config.home, 'catalog.sqlite').replace(/'/g, "''")}' AS old`)
    for (const [table, cols] of [
      ['save_profile', 'save_id, display_name, season_start, created_at'], ['team_identity', '*'], ['match', '*'], ['recording_revision', 'recording_revision_id, match_id, save_id, parent_revision_id, archive_sha256, size_bytes, snapshot_path, source_match_id, format, parser_name, parser_version, processed_at, integrity_status, identity_status'], ['source_locator', '*'],
      ['projection', '*'], ['confirmation', '*'], ['audit_log', '*'],
    ] as const) db.exec(`INSERT INTO main.${table} SELECT ${cols} FROM old.${table}`)
    db.pragma('user_version = 1')
    db.exec('DETACH DATABASE old')
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    db.close()

    // A read-only reader (the MCP server) does not upgrade and does not guess: it asks for a CLI run.
    expect(() => new CatalogService({ ...loadConfig(home, {}), readOnly: true })).toThrowError(/does not match this build/)

    // The writer upgrades it.
    const svc = new CatalogService(loadConfig(home, {}))
    expect(svc.store.schemaVersion()).toBe(MIGRATIONS.length)
    expect(svc.listMatches(saveId).matches.map((m) => m.matchId).sort()).toEqual([ids.g1!.matchId, ids.g2!.matchId].sort())
    const raw = new Database(join(home, 'catalog.sqlite'), { readonly: true })
    try {
      expect((raw.prepare('SELECT COUNT(*) AS n FROM player_observation').get() as { n: number }).n).toBe(56) // 2 matches x 28 participants, from the projections
      expect((raw.prepare('SELECT COUNT(*) AS n FROM match_aggregate').get() as { n: number }).n).toBe(0) // not decoded during the migration
    } finally { raw.close() }

    // Identities and aggregates follow without re-importing anything.
    svc.rebuildIdentities(saveId)
    const q = new MatchQueries(svc)
    const alex = q.listPlayers({ saveId, nameQuery: 'Alexander' }).players
    expect(alex).toHaveLength(1)
    expect(alex[0]).toMatchObject({ identityStatus: 'persistent', matches: 2 })
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const first = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
    expect(first.source).toMatchObject({ aggregates: 2, servedFromCatalog: 0, builtThisCall: 2, persistedThisCall: 2 })
    expect(first.windows[0]!.rates[0]!.numerator).toBe(1)
    const second = await q.seasonTrends({ saveId, teamId, lastN: 5, metrics: ['goals_per_90'] })
    expect(second.source).toMatchObject({ servedFromCatalog: 2, builtThisCall: 0 })
    expect((await svc.rebuildAggregates(saveId))).toMatchObject({ revisions: 2, rebuilt: 0, alreadyCurrent: 2 })
    svc.close()

    // After the upgrade the read-only reader accepts the catalog.
    const ro = new CatalogService({ ...loadConfig(home, {}), readOnly: true })
    expect(new MatchQueries(ro).listPlayers({ saveId, nameQuery: 'Alexander' }).players).toHaveLength(1)
    ro.close()
  }, 180_000)
})
