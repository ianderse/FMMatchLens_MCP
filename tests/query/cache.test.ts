// The bounded decoded-recording cache (Slice 3 performance requirement): repeated tool calls must not re-decode the
// snapshot, memory is bounded, and nothing that can change in the catalog is served from the cache.
import { rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DecodedRecording } from '@fmmi/model'
import { FmlensV28Decoder } from '@fmmi/fmlens-adapter'
import type { ArchiveDecoder } from '@fmmi/fmlens-adapter'
import { DecodedRecordingCache, MatchQueries } from '@fmmi/query'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll } from '../support/helpers.ts'
import { buildScenario } from '../support/scenario.ts'
import { openWriter, seedSynthetic } from '../support/mcp.ts'

afterAll(cleanupAll)

const fake = (n: number) => ({ id: n }) as unknown as DecodedRecording

class CountingDecoder implements ArchiveDecoder {
  readonly id = 'counting'
  readonly supportedFormats = ['2.8']
  decodes = 0
  private inner = new FmlensV28Decoder()
  decode: ArchiveDecoder['decode'] = (bytes, opts) => { this.decodes++; return this.inner.decode(bytes, opts) }
}
const reader = (home: string, decoder: ArchiveDecoder, cache?: DecodedRecordingCache) => {
  const svc = new CatalogService({ ...loadConfig(home, {}), readOnly: true }, decoder)
  return { svc, q: new MatchQueries(svc, cache) }
}

describe('DecodedRecordingCache', () => {
  it('AC3 is a bounded LRU: entry count and the estimated byte budget both evict the least recently used, and an oversized entry is served but not kept', async () => {
    const c = new DecodedRecordingCache({ maxEntries: 2, maxBytes: 1000, bytesPerArchiveByte: 10 })
    const load = (n: number) => () => Promise.resolve(fake(n))
    await c.getOrLoad('a', 10, load(1)); await c.getOrLoad('b', 10, load(2))
    await c.getOrLoad('a', 10, load(99)) // touch a: b is now the oldest
    await c.getOrLoad('c', 10, load(3))
    expect(c.stats()).toMatchObject({ entries: 2, evictions: 1 })
    expect(await c.getOrLoad('a', 10, load(98))).toEqual(fake(1)) // a survived
    expect(await c.getOrLoad('b', 10, load(4))).toEqual(fake(4)) // b was evicted and reloaded
    // byte budget: 3 x 400 = 1200 > 1000 even though only 2 entries are allowed per count
    const bytes = new DecodedRecordingCache({ maxEntries: 10, maxBytes: 1000, bytesPerArchiveByte: 10 })
    for (const k of ['x', 'y', 'z']) await bytes.getOrLoad(k, 40, load(1))
    expect(bytes.stats().estimatedBytes).toBeLessThanOrEqual(1000)
    expect(bytes.stats().entries).toBe(2)
    // an entry bigger than the whole budget is returned but never retained
    const big = await bytes.getOrLoad('huge', 500, load(7))
    expect(big).toEqual(fake(7))
    expect(bytes.stats().entries).toBe(2)
    expect(new DecodedRecordingCache({ maxEntries: 0 }).stats().entries).toBe(0)
  })

  it('AC3 concurrent requests for one key share a single decode, and a failed decode is not cached', async () => {
    const c = new DecodedRecordingCache()
    let runs = 0
    const slow = () => new Promise<DecodedRecording>((r) => { runs++; setTimeout(() => r(fake(1)), 20) })
    const [a, b, d] = await Promise.all([c.getOrLoad('k', 1, slow), c.getOrLoad('k', 1, slow), c.getOrLoad('k', 1, slow)])
    expect(runs).toBe(1)
    expect(a).toBe(b); expect(b).toBe(d)
    await expect(c.getOrLoad('bad', 1, () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')
    expect(c.stats()).toMatchObject({ entries: 1, inFlight: 0 })
    expect(await c.getOrLoad('bad', 1, () => Promise.resolve(fake(2)))).toEqual(fake(2)) // retried, not poisoned
    c.drop('bad'); expect(c.stats().entries).toBe(1)
    c.clear(); expect(c.stats().entries).toBe(0)
  })

  it('AC3 repeated queries decode the snapshot once; mutable catalog state is re-read each call, so a confirmation shows immediately without a re-decode', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    const seed = await seedSynthetic(sc.synth)
    const dec = new CountingDecoder()
    const { svc, q } = reader(seed.home, dec)
    const first = await q.summary(seed.matchId)
    expect(dec.decodes).toBe(1)
    const striker = first.summary.roster.players.find((p) => p.name === 'Away Player 9')!.playerId
    await q.player(seed.matchId, striker); await q.network(seed.matchId, seed.awayTeamId); await q.service(seed.matchId, striker)
    await q.compare(seed.matchId, seed.awayTeamId, { windowA: {}, windowB: { fromMinute: 50, period: 2 } }); await q.recordingStatus(seed.matchId)
    expect(dec.decodes).toBe(1)
    expect(q.cache.stats()).toMatchObject({ misses: 1, entries: 1 })
    expect(q.cache.stats().hits).toBeGreaterThanOrEqual(5)
    expect(first.result.label).toBe('observed_not_final')

    // A correction made by the CLI process (a separate writer) is visible on the next call; the decode is not repeated.
    const w = openWriter(seed.home)
    w.confirmMatch(seed.matchId, `${first.result.observed.home}-${first.result.observed.away}`)
    w.close()
    const after = await q.summary(seed.matchId)
    expect(after.result.label).toBe('final_manual')
    expect(after.capture.completion).toBe('completed_manual')
    expect(dec.decodes).toBe(1)
    // the cached recording is not mutated by analysis: the same inputs give the same output
    expect(await q.player(seed.matchId, striker)).toEqual(await q.player(seed.matchId, striker))
    svc.close()
  })

  it('AC3 a cache that is too small to keep anything still answers correctly, decoding each time', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    const seed = await seedSynthetic(sc.synth)
    const dec = new CountingDecoder()
    const { svc, q } = reader(seed.home, dec, new DecodedRecordingCache({ maxEntries: 0 }))
    const a = await q.summary(seed.matchId), b = await q.summary(seed.matchId)
    expect(b).toEqual(a)
    expect(dec.decodes).toBe(2)
    svc.close()
  })

  it('AC3 the cache is keyed by revision: two revisions of one match are cached separately and never mixed', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    const seed = await seedSynthetic(sc.synth)
    const { importMore } = await import('../support/mcp.ts')
    const conflict = await importMore(seed.home, seed.saveId, { ...sc.synth, goals: [{ tick: 5000, side: 'home' }] }, 'c.fmlens')
    const dec = new CountingDecoder()
    const { svc, q } = reader(seed.home, dec)
    const a1 = await q.summary(seed.matchId, { recordingRevisionId: seed.revisionId })
    const b1 = await q.summary(seed.matchId, { recordingRevisionId: conflict.recordingRevisionId })
    const a2 = await q.summary(seed.matchId, { recordingRevisionId: seed.revisionId })
    expect(dec.decodes).toBe(2)
    expect(a2).toEqual(a1)
    expect(b1.recordingRevisionId).toBe(conflict.recordingRevisionId)
    expect(b1.result.observed).not.toEqual(a1.result.observed)
    expect(q.cache.stats().entries).toBe(2)
    svc.close()
  })

  it('AC3 a cached recording is not served once its retained snapshot is gone', async () => {
    const sc = await buildScenario({ humanSide: 'away', strikerSide: 'away' })
    const seed = await seedSynthetic(sc.synth)
    const { svc, q } = reader(seed.home, new CountingDecoder())
    await q.summary(seed.matchId)
    const dir = join(seed.home, 'snapshots')
    const sub = readdirSync(dir)[0]!
    for (const f of readdirSync(join(dir, sub))) rmSync(join(dir, sub, f), { force: true })
    await expect(q.summary(seed.matchId)).rejects.toMatchObject({ code: 'revision_unavailable' })
    expect(q.cache.stats().entries).toBe(0)
    svc.close()
  })
})
