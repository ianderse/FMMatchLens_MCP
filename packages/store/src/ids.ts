import { createHash } from 'node:crypto'

/** Internal match-local player id: scoped to the recording revision (spec 6.2). Never a persistent identity. */
export function playerIdFor(revisionId: string, upstreamPlayerId: number): string {
  return `p_${createHash('sha256').update(`${revisionId}:${upstreamPlayerId}`).digest('hex').slice(0, 12)}`
}

/**
 * Save-scoped persistent player id for an automatically verified upstream uid. Deterministic, so a rebuild keeps the same id;
 * scoped by the save, so two saves never share one. Opaque to callers.
 */
export function persistentPlayerId(saveId: string, uid: number): string {
  return `pe_${createHash('sha256').update(`${saveId}:uid:${uid}`).digest('hex').slice(0, 12)}`
}

/** Name comparison key: Unicode-normalised, case-folded, whitespace-collapsed. Used only to check that names AGREE; never to merge. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}
