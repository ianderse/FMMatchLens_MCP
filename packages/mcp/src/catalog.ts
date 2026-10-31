import { CatalogService, loadConfig } from '@fmmi/store'
import { DecodedRecordingCache, MatchQueries } from '@fmmi/query'
import type { DecodedCacheOptions } from '@fmmi/query'
import type { LiveEventNote, LiveNoteRef } from '@fmmi/live'

/**
 * Opens the catalog read-only, on first use. A catalog that does not exist yet is a per-call domain error rather than a
 * failed start, so the server can be configured before the first import and picks the catalog up once it exists.
 * The server holds one connection and one bounded decode cache for its lifetime; both only ever read.
 */
export class CatalogHolder {
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly cache: DecodedRecordingCache
  private svc: CatalogService | null = null
  private queries: MatchQueries | null = null

  constructor(home: string, env: NodeJS.ProcessEnv = {}, cache: DecodedCacheOptions = {}) {
    this.home = home
    this.env = env
    this.cache = new DecodedRecordingCache(cache)
  }

  /** Throws the domain error from the store when the catalog is missing or has an unexpected schema. */
  get = (): MatchQueries => {
    if (this.queries) return this.queries
    const svc = new CatalogService({ ...loadConfig(this.home, this.env), readOnly: true })
    this.svc = svc
    this.queries = new MatchQueries(svc, this.cache)
    return this.queries
  }

  cacheStats() { return this.cache.stats() }

  /** Live notes (written only by the local CLI) for a source match id, newest last. No catalog yet means no notes, never an error. */
  liveNotes = (upstreamMatchId: string): LiveEventNote[] => {
    try { this.get() } catch { return [] }
    return this.svc!.listLiveNotes({ upstreamMatchId }).map((n) => ({
      noteId: n.noteId, side: n.side, period: n.period, tick: n.tick, displayMinute: n.displayMinute, setting: n.setting, priorValue: n.priorValue, newValue: n.newValue,
      comment: n.comment, createdAt: n.createdAt, supersededBy: n.supersededByNoteId,
    }))
  }

  liveNote = (noteId: string): (LiveNoteRef & { upstreamMatchId: string }) | null => {
    try { this.get() } catch { return null }
    const n = this.svc!.getLiveNote(noteId)
    return n ? { noteId: n.noteId, side: n.side, period: n.period, tick: n.tick, displayMinute: n.displayMinute, upstreamMatchId: n.upstreamMatchId } : null
  }

  close(): void {
    this.cache.clear()
    this.svc?.close()
    this.svc = null
    this.queries = null
  }
}
