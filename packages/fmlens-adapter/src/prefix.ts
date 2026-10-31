import { createHash } from 'node:crypto'
import { DomainError, SUPPORTED_FORMAT } from '@fmmi/model'
import { parseArchiveFile } from './upstream/archiveParser.ts'
import type { ArchiveLimits } from './upstream/archiveParser.ts'

/**
 * Verified-prefix comparison of two archives of the SAME source match (spec 6.2, Slice 5). A recording that is still being written, or was
 * cut short, can later be seen again with more frames. It only EXTENDS the earlier one when every previously validated record is
 * unchanged: same format, same source match id and start time, the same metadata revisions up to the earlier last tick, and a per-frame
 * digest of the full decoded frame (period, tick, sequence, every counter, every player, every event) equal for every earlier frame.
 * Anything else is a conflict. Nothing here decides what to do with the result; the store does, and a conflicting payload is never
 * resolved automatically.
 */
export type PrefixRelation =
  | 'extends'      // the second archive holds every frame of the first, unchanged, and more
  | 'prefix_of'    // the second archive is a strict prefix of the first (an earlier capture of the same recording)
  | 'same_frames'  // identical frames; only the container differs (for example a clean-close marker)
  | 'conflict'

export interface PrefixComparison {
  relation: PrefixRelation
  /** Why a conflict is a conflict; a stable token, never a path. */
  reason: string | null
  firstFrames: number
  secondFrames: number
  /** Frames compared (the shorter count) that agreed before the first divergence. */
  agreedFrames: number
  firstDivergence: { index: number; tick: number } | null
}

interface Fingerprint {
  matchId: string
  format: string
  startedUnixMilliseconds: number
  frames: Array<{ tick: number; digest: string }>
  metadata: Array<{ capturedTick: number; digest: string }>
  firstMetadataDigest: string | null
}

const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)
const digestOf = (x: unknown): string => createHash('sha256').update(JSON.stringify(x, replacer)).digest('hex').slice(0, 24)

async function fingerprint(bytes: Uint8Array, limits?: Partial<ArchiveLimits>): Promise<Fingerprint> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const frames: Fingerprint['frames'] = []
  const parsed = await parseArchiveFile(ab, 'prefix.fmlens', { limits, onFrame: (f) => { frames.push({ tick: f.tick, digest: digestOf(f) }) } })
  if (!parsed.metadata) throw new DomainError('invalid_input', 'Archive has no match metadata', { kind: 'no_metadata' })
  return {
    matchId: parsed.archive.matchId, format: SUPPORTED_FORMAT, startedUnixMilliseconds: parsed.archive.startedUnixMilliseconds, frames,
    metadata: parsed.metadataTimeline.map((m) => ({ capturedTick: m.capturedTick, digest: digestOf(m) })),
    firstMetadataDigest: parsed.metadataTimeline[0] ? digestOf({ home: parsed.metadataTimeline[0].home.name, away: parsed.metadataTimeline[0].away.name, players: parsed.metadataTimeline[0].players.map((p) => [p.playerId, p.uid, p.team, p.displayName]) }) : null,
  }
}

export async function compareFramePrefix(first: Uint8Array, second: Uint8Array, limits?: Partial<ArchiveLimits>): Promise<PrefixComparison> {
  const [a, b] = [await fingerprint(first, limits), await fingerprint(second, limits)]
  const base = { firstFrames: a.frames.length, secondFrames: b.frames.length }
  const conflict = (reason: string, agreed = 0, div: PrefixComparison['firstDivergence'] = null): PrefixComparison => ({ relation: 'conflict', reason, ...base, agreedFrames: agreed, firstDivergence: div })
  if (a.matchId !== b.matchId) return conflict('source_match_id_differs')
  if (a.startedUnixMilliseconds !== b.startedUnixMilliseconds) return conflict('start_time_differs')
  if (a.firstMetadataDigest !== b.firstMetadataDigest) return conflict('initial_metadata_differs')
  const n = Math.min(a.frames.length, b.frames.length)
  if (n === 0) return conflict('no_frames')
  let agreed = 0
  while (agreed < n && a.frames[agreed]!.digest === b.frames[agreed]!.digest) agreed++
  if (agreed < n) return conflict('frame_content_differs', agreed, { index: agreed, tick: a.frames[agreed]!.tick })
  // Metadata revisions that existed at or before the shorter archive's last tick must be the same in both.
  const lastTick = a.frames.length <= b.frames.length ? a.frames[a.frames.length - 1]!.tick : b.frames[b.frames.length - 1]!.tick
  const upTo = (f: Fingerprint) => f.metadata.filter((m) => m.capturedTick <= lastTick)
  const ma = upTo(a), mb = upTo(b)
  if (ma.length !== mb.length || ma.some((m, i) => m.capturedTick !== mb[i]!.capturedTick || m.digest !== mb[i]!.digest)) return conflict('metadata_differs', agreed)
  const relation: PrefixRelation = a.frames.length < b.frames.length ? 'extends' : a.frames.length > b.frames.length ? 'prefix_of' : 'same_frames'
  return { relation, reason: null, ...base, agreedFrames: agreed, firstDivergence: null }
}
