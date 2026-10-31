import type { DecodedRecording } from '@fmmi/model'
import type { DecodedCache } from '@fmmi/store'

export interface DecodedCacheOptions {
  /** Most recordings kept at once. */
  maxEntries?: number
  /** Memory budget for retained recordings, in estimated decoded bytes. */
  maxBytes?: number
  /** Estimated decoded bytes per archive byte; the estimate bounds memory, it is not a measurement of any one recording. */
  bytesPerArchiveByte?: number
}
export interface DecodedCacheStats { entries: number; estimatedBytes: number; hits: number; misses: number; evictions: number; inFlight: number }

export const DEFAULT_CACHE_ENTRIES = 3
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024
/**
 * Estimated decoded heap per archive byte. Measured once on the audited recording: a 1,831,146-byte archive decodes to
 * about 1.8 MB of retained heap (ratio 1.0, docs/setup-windows.md). The default is 8x that, so a larger or denser
 * recording still stays inside the budget; it is a bound, not a measurement of any one recording.
 */
export const DEFAULT_BYTES_PER_ARCHIVE_BYTE = 8

interface Entry { value: DecodedRecording; bytes: number }

/**
 * Small bounded in-process LRU of decoded recordings. A decoded recording is immutable for a given key (revision id,
 * archive hash and parser version), so entries never go stale; anything that can change (confirmation, identity
 * status, save assignment) is read from the catalog again on every call by the caller and is not part of the entry.
 * Concurrent requests for one key share a single decode. A failed decode is not cached. A recording larger than the
 * whole budget is served but not retained.
 */
export class DecodedRecordingCache implements DecodedCache {
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly factor: number
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<DecodedRecording>>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(o: DecodedCacheOptions = {}) {
    this.maxEntries = Math.max(0, Math.floor(o.maxEntries ?? DEFAULT_CACHE_ENTRIES))
    this.maxBytes = Math.max(0, o.maxBytes ?? DEFAULT_CACHE_BYTES)
    this.factor = o.bytesPerArchiveByte ?? DEFAULT_BYTES_PER_ARCHIVE_BYTE
  }

  async getOrLoad(key: string, sizeHint: number, loader: () => Promise<DecodedRecording>): Promise<DecodedRecording> {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key); this.entries.set(key, hit) // most recently used goes last
      this.hits++
      return hit.value
    }
    const inflight = this.pending.get(key)
    if (inflight) { this.hits++; return inflight }
    this.misses++
    const p = loader().then((value) => { this.retain(key, value, sizeHint * this.factor); return value })
    this.pending.set(key, p)
    try { return await p } finally { this.pending.delete(key) }
  }

  private retain(key: string, value: DecodedRecording, bytes: number) {
    if (this.maxEntries === 0 || bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    while (this.entries.size > this.maxEntries || this.totalBytes() > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
      this.evictions++
    }
  }
  private totalBytes(): number { let n = 0; for (const e of this.entries.values()) n += e.bytes; return n }

  drop(key: string): void { this.entries.delete(key) }
  clear(): void { this.entries.clear() }
  stats(): DecodedCacheStats {
    return { entries: this.entries.size, estimatedBytes: this.totalBytes(), hits: this.hits, misses: this.misses, evictions: this.evictions, inFlight: this.pending.size }
  }
}
