import { createHash } from 'node:crypto'
import { RecordingBuilder } from '@fmmi/fmlens-adapter'
import type { ParsedLocalArchive, RealtimeFrame, RealtimeMatchMetadata } from '@fmmi/fmlens-adapter'
import { TICKS_PER_MINUTE, round } from '@fmmi/model'
import type { DecodedRecording } from '@fmmi/model'
import type { FormationEntry } from './schemas.ts'

/**
 * The state of ONE tracked live match, as a pure accumulator: no I/O, no clock. The reader feeds it validated data and the rules that
 * keep state monotonic live here, so they can be tested without a socket:
 *   - a frame is accepted only if it belongs to this match, is newer than the last accepted frame (strictly greater tick) and does not move
 *     the period backwards; anything else is counted and dropped, so a reconnect or a reordered page cannot duplicate or regress state;
 *   - formation entries are accepted by consecutive index; a gap is reported, never papered over;
 *   - metadata older than the metadata already held is ignored.
 * Frames go through the same `RecordingBuilder` as an archive, one at a time, and are not retained: memory is bounded by the counters
 * and events, not by the number of frames.
 */
export interface TrackCounters {
  framesAccepted: number
  duplicateFrames: number
  outOfOrderFrames: number
  otherMatchFrames: number
  periodRegressions: number
  staleMetadata: number
  formationEntries: number
  duplicateFormationEntries: number
}

export interface FrameStamp { tick: number; period: number; displayTick: number; capturedMs: number; receivedMs: number }

export const liveHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

export class MatchTrack {
  readonly matchId: string
  meta: RealtimeMatchMetadata
  readonly timeline: RealtimeMatchMetadata[]
  private builder = new RecordingBuilder()
  private firstFrame: RealtimeFrame | null = null
  private lastFrame: RealtimeFrame | null = null
  private n = 0
  formationNext = 0
  /** Newest frame seen from ANY route (history, current, socket). Used for freshness; never fed to the builder unless it came from history. */
  latest: FrameStamp | null = null
  readonly counters: TrackCounters = {
    framesAccepted: 0, duplicateFrames: 0, outOfOrderFrames: 0, otherMatchFrames: 0, periodRegressions: 0, staleMetadata: 0, formationEntries: 0, duplicateFormationEntries: 0,
  }

  constructor(meta: RealtimeMatchMetadata) {
    this.matchId = meta.matchId
    this.meta = meta
    // The first timeline revision carries NO role assignments. Metadata read mid-match already holds the CURRENT roles, so using it as the
    // opening revision would put today's roles at the start of the match; the formation history (entries in index order) is what says
    // when each assignment was noticed.
    this.timeline = [{ ...meta, players: meta.players.map((p) => ({ ...p, inPossession: undefined, outOfPossession: undefined })) }]
  }

  get frameCount(): number { return this.n }
  get lastTick(): number { return this.lastFrame ? this.lastFrame.tick : -1 }
  get snapshotStamp(): { tick: number; period: number; displayMinute: number } | null {
    const f = this.lastFrame
    return f ? { tick: f.tick, period: f.period, displayMinute: round(f.displayTick / TICKS_PER_MINUTE, 2) } : null
  }
  get firstTick(): number | null { return this.firstFrame ? this.firstFrame.tick : null }

  /** Newest-frame bookkeeping for freshness. Returns false when the frame is older than what we already know (stale), true when it advanced or repeated the newest. */
  noteLatest(f: { tick: number; period: number; displayTick: number; capturedUnixMilliseconds: number }, receivedMs: number): 'advanced' | 'duplicate' | 'stale' {
    const cur = this.latest
    if (cur && (f.tick < cur.tick || f.period < cur.period)) return 'stale'
    const dup = !!cur && f.tick === cur.tick && f.period === cur.period
    if (!dup) this.latest = { tick: f.tick, period: f.period, displayTick: f.displayTick, capturedMs: f.capturedUnixMilliseconds > 0 ? f.capturedUnixMilliseconds : receivedMs, receivedMs }
    else if (cur) cur.receivedMs = receivedMs
    return dup ? 'duplicate' : 'advanced'
  }

  /** Feeds history frames (any order, may repeat). Returns how many were new. */
  acceptHistory(frames: readonly RealtimeFrame[], receivedMs: number): number {
    const sorted = [...frames].sort((a, b) => a.tick - b.tick || a.sequence - b.sequence)
    let added = 0
    for (const f of sorted) {
      if (f.matchId !== this.matchId) { this.counters.otherMatchFrames++; continue }
      if (this.lastFrame && f.tick === this.lastFrame.tick) { this.counters.duplicateFrames++; continue }
      if (this.lastFrame && f.tick < this.lastFrame.tick) { this.counters.outOfOrderFrames++; continue }
      if (this.lastFrame && f.period < this.lastFrame.period) { this.counters.periodRegressions++; continue }
      this.builder.onFrame(f, this.n)
      if (this.n === 0) this.firstFrame = f
      this.lastFrame = f
      this.n++
      added++
      this.counters.framesAccepted++
      this.noteLatest(f, receivedMs)
    }
    return added
  }

  /** Metadata from `/api/match/meta`: authoritative for the roster, ignored if older than what is held. Returns whether it was taken. */
  acceptMetadata(meta: RealtimeMatchMetadata): boolean {
    if (meta.matchId !== this.matchId) return false
    if (meta.capturedTick < this.meta.capturedTick) { this.counters.staleMetadata++; return false }
    // The authoritative roster (identities, late additions). Role CHANGES come from the formation history only, in index order, so the
    // timeline stays chronological and a metadata re-read cannot reorder or duplicate it.
    this.meta = meta
    return true
  }

  /** Formation entries by consecutive index (upstream rule). Returns `gap: true` when an index is missing, so the caller re-syncs. */
  acceptFormation(entries: readonly FormationEntry[]): { changed: boolean; gap: boolean } {
    let changed = false, gap = false
    for (const e of [...entries].sort((a, b) => a.index - b.index)) {
      if (e.index < this.formationNext) { this.counters.duplicateFormationEntries++; continue }
      if (e.index > this.formationNext) { gap = true; break }
      const bySlot = new Map(e.players.map((p) => [p.slot, p]))
      const base = this.timeline[this.timeline.length - 1]!
      // The revision is stamped with the entry tick: that is when the plugin noticed the change, not necessarily when the manager made it.
      this.timeline.push({
        ...base, capturedTick: e.tick,
        players: base.players.map((p) => { const a = bySlot.get(p.slot); return a ? { ...p, inPossession: a.inPossession as typeof p.inPossession, outOfPossession: a.outOfPossession as typeof p.outOfPossession } : p }),
      })
      this.formationNext = e.index + 1
      this.counters.formationEntries++
      changed = true
    }
    return { changed, gap }
  }

  /** The analysis snapshot: the same normalised recording an archive of the frames so far would give. Safe to call repeatedly. */
  decoded(): DecodedRecording | null {
    const f = this.lastFrame
    if (!f) return null
    const parsed: ParsedLocalArchive = {
      archive: {
        matchId: this.matchId, fileName: 'live', startedUnixMilliseconds: this.meta.startedUnixMilliseconds, endedUnixMilliseconds: undefined, ended: false, frameCount: this.n,
        firstTick: this.firstFrame!.tick, lastTick: f.tick, matchDate: this.meta.matchDate, homeGoals: f.home.goals, awayGoals: f.away.goals, fileSizeBytes: 0,
      },
      metadata: this.meta, metadataTimeline: this.timeline, frames: [],
      ratingConfiguration: undefined as unknown as ParsedLocalArchive['ratingConfiguration'],
      // A live capture has no file and no clean close; it is a prefix of the match by construction.
      integrity: { cleanClose: false, truncatedTail: false, blockError: undefined, blocksDecoded: 0, framesDecoded: this.n, lastValidatedTick: f.tick, lastValidatedPeriod: f.period },
    }
    const d = this.builder.finish(parsed, this.meta, 0)
    d.recording.source = { ...d.recording.source, kind: 'fmlens_live_api', format: 'live_api' }
    d.recording.warnings = [...d.recording.warnings, 'live_snapshot: built from the plugin API, not an archive; the match is in progress']
    return d
  }
}
