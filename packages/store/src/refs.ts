import { DomainError, boundName, safeText } from '@fmmi/model'
import { nameKey } from './ids.ts'
import type { CatalogService } from './service.ts'

/**
 * Human references. Every resolver accepts what it always accepted (an exact id) and additionally something a person would type. A reference
 * that matches more than one thing is `ambiguous_selection` listing the candidates; nothing is ever guessed.
 */

const SETUP_HINT = 'Run: fmmi setup'

export interface SaveCandidate { saveId: string; name: string }

/** `ref` is a save id or a save name (exact, then a unique fragment, case-insensitive). Without `ref`: the configured default save, else the only save. */
export function resolveSaveRef(svc: CatalogService, ref?: string): SaveCandidate {
  const saves = svc.listSaves().map((s) => ({ saveId: s.saveId, name: s.displayName }))
  const list = saves.map((s) => `${safeText(s.name)} (${s.saveId})`).join(', ')
  if (ref !== undefined && ref.trim() !== '') {
    const r = ref.trim()
    const byId = saves.find((s) => s.saveId === r)
    if (byId) return byId
    const key = nameKey(r)
    const exact = saves.filter((s) => nameKey(s.name) === key)
    const hits = exact.length > 0 ? exact : saves.filter((s) => nameKey(s.name).includes(key))
    if (hits.length === 1) return hits[0]!
    if (hits.length > 1) throw new DomainError('ambiguous_selection', `More than one save matches ${JSON.stringify(boundName(r, 60))}: ${hits.map((s) => `${safeText(s.name)} (${s.saveId})`).join(', ')}. Use the save id.`, { reason: 'save_ambiguous', candidates: hits })
    throw new DomainError('not_found', saves.length ? `No save matches ${JSON.stringify(boundName(r, 60))}. Saves: ${list}` : `No save exists yet. ${SETUP_HINT}`, { reason: saves.length ? 'save_ref' : 'no_saves', candidates: saves })
  }
  if (saves.length === 0) throw new DomainError('not_found', `No save exists yet. ${SETUP_HINT}`, { reason: 'no_saves' })
  const def = svc.config.defaultSaveId
  if (def !== undefined) {
    const d = saves.find((s) => s.saveId === def)
    if (d) return d
  }
  if (saves.length === 1) return saves[0]!
  throw new DomainError('ambiguous_selection', `More than one save exists and no default is set. Pass --save with one of: ${list}. Or run: fmmi setup`, { reason: 'save_required', candidates: saves })
}

export interface MatchCandidate { matchId: string; saveId: string; date: string | null; home: string; away: string; score: string }

const describe = (c: MatchCandidate) => `${c.matchId}  ${c.date ?? 'no date'}  ${safeText(c.home)} ${c.score} ${safeText(c.away)}`

/**
 * `latest`, an exact match id, or a unique case-insensitive team-name fragment (home or away). `saveRef` limits the search to one save; without
 * it the default or only save is used, and with several saves and no default every save is searched.
 */
export function resolveMatchRef(svc: CatalogService, ref: string, saveRef?: string): string {
  const r = ref.trim()
  if (svc.store.getMatch(r)) return r
  // Something shaped like an id that matches nothing keeps the error it always had.
  if (/^m_[A-Za-z0-9]+$/.test(r)) throw new DomainError('not_found', 'Match not found', { matchId: r })
  let saveIds: string[]
  try { saveIds = [resolveSaveRef(svc, saveRef).saveId] } catch (e) {
    if (saveRef !== undefined || !(e instanceof DomainError) || e.code !== 'ambiguous_selection') throw e
    saveIds = svc.listSaves().map((s) => s.saveId)
  }
  const all: MatchCandidate[] = saveIds.flatMap((saveId) => svc.listMatches(saveId).matches.map((m) => ({
    matchId: m.matchId, saveId, date: m.matchDate, home: m.home.name, away: m.away.name, score: `${m.result.observed.home}-${m.result.observed.away}`,
  })))
  if (all.length === 0) throw new DomainError('not_found', 'No matches imported yet. Run: fmmi sync', { reason: 'no_matches' })
  const byNewest = (a: MatchCandidate, b: MatchCandidate) => (a.date === b.date ? (a.matchId < b.matchId ? 1 : -1) : (a.date ?? '') < (b.date ?? '') ? 1 : -1)
  if (r.toLowerCase() === 'latest') return [...all].sort(byNewest)[0]!.matchId
  const key = nameKey(r)
  const hits = all.filter((c) => nameKey(c.home).includes(key) || nameKey(c.away).includes(key)).sort(byNewest)
  if (hits.length === 1) return hits[0]!.matchId
  if (hits.length > 1) {
    throw new DomainError('ambiguous_selection', `${hits.length} matches involve ${JSON.stringify(boundName(r, 60))}; use one of these ids (or "latest"):\n${hits.slice(0, 10).map((c) => `  ${describe(c)}`).join('\n')}`,
      { reason: 'match_ambiguous', candidates: hits.slice(0, 10) })
  }
  throw new DomainError('not_found', `No match id, "latest" or team name matches ${JSON.stringify(boundName(r, 60))}`, { reason: 'match_ref' })
}

/**
 * A player of one match: a `p_` id, a `pe_` id (the player's persistent id, resolved to that player's `p_` id in this match) or, when `names` is
 * set, a unique case-insensitive name fragment. A `pe_` player who did not play in the match is `not_found`.
 */
export function resolvePlayerRef(svc: CatalogService, matchId: string, ref: string, opts: { revisionId?: string; names?: boolean } = {}): string {
  const r = ref.trim()
  const names = opts.names ?? false
  if (!r.startsWith('pe_') && !r.startsWith('p_') && !names) return ref
  const roster = svc.showMatch(matchId, { revisionId: opts.revisionId }).roster
  const exact = roster.find((p) => p.playerId === r)
  if (exact) return exact.playerId
  if (r.startsWith('pe_')) {
    const hit = roster.filter((p) => p.persistentPlayerId === r)
    if (hit.length === 1) return hit[0]!.playerId
    throw new DomainError('not_found', 'That player (pe_ id) did not appear in this match', { reason: 'not_in_match', persistentPlayerId: r })
  }
  if (r.startsWith('p_') || !names) return ref
  const key = nameKey(r)
  const exactName = roster.filter((p) => nameKey(p.name) === key)
  const hits = exactName.length > 0 ? exactName : roster.filter((p) => nameKey(p.name).includes(key))
  if (hits.length === 1) return hits[0]!.playerId
  if (hits.length > 1) {
    throw new DomainError('ambiguous_selection', `${hits.length} players match ${JSON.stringify(boundName(r, 60))}; use one of these ids:\n${hits.map((p) => `  ${p.playerId}  ${safeText(p.name)}  (${p.side}${p.position ? `, ${safeText(p.position)}` : ''})`).join('\n')}`,
      { reason: 'player_ambiguous', candidates: hits.map((p) => ({ playerId: p.playerId, name: p.name, side: p.side, position: p.position })) })
  }
  throw new DomainError('not_found', `No player of this match is named like ${JSON.stringify(boundName(r, 60))}`, { reason: 'player_ref' })
}
