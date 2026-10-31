// Slice 4 follow-up, spec 7.6: chance creation by wing across matches. Pooled per-lane counts for the managed team, for and against, built from
// the per-match lane logic (the threat query) and cached in the season aggregate. LABELLED SYNTHETIC recordings; isolated catalogs.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { AGGREGATE_SCHEMA, WING_COUNTS, aggregateKey, getDefinition } from '@fmmi/analytics'
import { MatchQueries } from '@fmmi/query'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll, service, tmp } from '../support/helpers.ts'
import { FIVE, confirmObserved, ingestSeason } from '../support/season.ts'

afterAll(cleanupAll)

const LANES = ['left', 'centre', 'right'] as const
const OLD_KEY = 'agg1.dict1.1.46adf91e'
const STRIP_LANES = `json_remove(json_set(json, '$.aggregateSchema', 1, '$.key', '${OLD_KEY}'), '$.sides.home.lanes', '$.sides.away.lanes')`

describe('chance_creation_by_wing_trend', () => {
  it('AC pooled lane counts equal the sum of the per-match threat reports (for = lanes of the opponent query, against = lanes of the team query), and per-90 is pooled count over pooled minutes', async () => {
    const svc = service()
    const saveId = svc.createSave('Synthetic Town').saveId
    const ids = await ingestSeason(svc, saveId, FIVE)
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const r = await q.seasonTrends({ saveId, teamId, lastN: 5 })
    const wing = r.windows[0]!.wing!
    expect(wing.metric).toBe('chance_creation_by_wing_trend')
    expect(wing.contributing).toMatchObject({ matches: 5 })
    expect(wing.excluded).toBeUndefined()

    const sums = { for: {} as Record<string, number>, against: {} as Record<string, number> }
    let minutes = 0, nonZero = 0
    for (const s of FIVE) {
      const matchId = ids[s.key]!.matchId
      const show = svc.showMatch(matchId)
      minutes += show.status.coverage.periods.reduce((a, p) => a + (p.lastTick - p.firstTick), 0) / 240
      const m = svc.store.getMatch(matchId)!
      const oppId = m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId
      for (const [dir, tid] of [['for', oppId], ['against', teamId]] as const) {
        const t = (await q.threat(matchId, tid)).threat
        for (const row of t.byLane) {
          const cells = { shots: row.shots, xg: row.xg.value, crosses: row.crosses, crossesCompleted: row.crossesCompleted, finalThirdEntries: row.finalThirdEntries, dangerAreaEntries: row.dangerAreaEntries }
          for (const k of WING_COUNTS) sums[dir][`${row.lane}.${k}`] = (sums[dir][`${row.lane}.${k}`] ?? 0) + cells[k]
        }
      }
    }
    for (const dir of ['for', 'against'] as const) {
      for (const lane of LANES) {
        for (const k of WING_COUNTS) {
          const [count, per90] = wing[dir].byLane[lane][k]
          expect(count, `${dir}.${lane}.${k}`).toBeCloseTo(sums[dir][`${lane}.${k}`]!, 4)
          expect(per90).toBeCloseTo((90 * sums[dir][`${lane}.${k}`]!) / minutes, 3) // pooled count over pooled minutes, not a mean of match rates
          if (count > 0) nonZero++
        }
      }
    }
    expect(nonZero).toBeGreaterThan(0) // the fixtures do carry lane data
    expect(wing.contributing.minutes).toBeCloseTo(minutes, 1)
    expect(r.unavailable.map((u) => u.metric)).not.toContain('chance_creation_by_wing_trend')
    expect(r.metrics.chance_creation_by_wing_trend).toMatchObject({ version: 2 })
    // a home/away filter pools only that side's matches
    const home = await q.seasonTrends({ saveId, teamId, lastN: 5, homeAway: 'home' })
    expect(home.windows[0]!.wing!.contributing.matches).toBe(FIVE.filter((s) => s.side === 'home').length)
    svc.close()
  }, 180_000)

  it('AC cached aggregates from before this change (aggregate schema 1, no lanes, an old key) are never served: they rebuild cleanly and carry lanes; a bumped definition rebuilds them again', async () => {
    const home = tmp()
    const svc = new CatalogService(loadConfig(home, {}))
    const saveId = svc.createSave('Synthetic Town').saveId
    const ids = await ingestSeason(svc, saveId, FIVE.slice(0, 3))
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    const q = new MatchQueries(svc)
    const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
    const raw = new Database(join(home, 'catalog.sqlite'))
    try {
      expect(AGGREGATE_SCHEMA).toBe(3) // 3: Slice 5 adds per-player score-state ticks to the aggregate
      const first = await q.seasonTrends({ saveId, teamId, lastN: 5 })
      expect(first.source).toMatchObject({ servedFromCatalog: 3, builtThisCall: 0 })
      const expected = first.windows[0]!.wing

      // Rewrite every stored row the way the previous release stored it: schema 1, dictionary 1.1 key, no lanes.
      raw.prepare(`UPDATE match_aggregate SET aggregate_key = ?, json = ${STRIP_LANES}`).run(OLD_KEY)
      const stale = raw.prepare('SELECT json FROM match_aggregate').all() as Array<{ json: string }>
      expect(stale).toHaveLength(3)
      for (const s of stale) expect(JSON.parse(s.json).sides.home.lanes).toBeUndefined()

      const rebuilt = await q.seasonTrends({ saveId, teamId, lastN: 5 })
      expect(rebuilt.source).toMatchObject({ aggregateKey: aggregateKey(), servedFromCatalog: 0, builtThisCall: 3, persistedThisCall: 3 })
      expect(rebuilt.windows[0]!.wing).toEqual(expected)
      const rows = raw.prepare('SELECT aggregate_key AS k, COUNT(*) AS n, MIN(json) AS json FROM match_aggregate GROUP BY aggregate_key').all() as Array<{ k: string; n: number; json: string }>
      expect(rows.map((x) => [x.k, x.n])).toEqual([[aggregateKey(), 3]]) // the old rows were replaced, not kept
      expect(JSON.parse(rows[0]!.json).sides.home.lanes).toBeTruthy()
      expect((await svc.rebuildAggregates(saveId))).toMatchObject({ revisions: 3, rebuilt: 0, alreadyCurrent: 3 })

      // The wing definition is part of the cache key: changing its version rebuilds again.
      const def = getDefinition('chance_creation_by_wing_trend')
      const old = def.version
      def.version = old + 1
      try {
        expect(aggregateKey()).not.toBe(rows[0]!.k)
        expect((await q.seasonTrends({ saveId, teamId, lastN: 5 })).source).toMatchObject({ builtThisCall: 3 })
      } finally { def.version = old }
    } finally { raw.close(); svc.close() }
  }, 180_000)

  it('AC a read-only reader rebuilds a pre-change aggregate in memory and does not write', async () => {
    const home = tmp()
    const w = new CatalogService(loadConfig(home, {}))
    const saveId = w.createSave('S').saveId
    const ids = await ingestSeason(w, saveId, FIVE.slice(0, 2))
    for (const k of Object.keys(ids)) confirmObserved(w, ids[k]!.matchId)
    w.close()
    const raw = new Database(join(home, 'catalog.sqlite'))
    raw.prepare(`UPDATE match_aggregate SET aggregate_key = ?, json = ${STRIP_LANES}`).run(OLD_KEY)
    const before = JSON.stringify(raw.prepare('SELECT * FROM match_aggregate ORDER BY 1').all())
    raw.close()
    const ro = new CatalogService({ ...loadConfig(home, {}), readOnly: true })
    try {
      const q = new MatchQueries(ro)
      const teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
      const r = await q.seasonTrends({ saveId, teamId, lastN: 5 })
      expect(r.source).toMatchObject({ builtThisCall: 2, persistedThisCall: 0 })
      expect(r.windows[0]!.wing!.contributing.matches).toBe(2)
    } finally { ro.close() }
    const raw2 = new Database(join(home, 'catalog.sqlite'), { readonly: true })
    expect(JSON.stringify(raw2.prepare('SELECT * FROM match_aggregate ORDER BY 1').all())).toBe(before)
    raw2.close()
  }, 180_000)
})
