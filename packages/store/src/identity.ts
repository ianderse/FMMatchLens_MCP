import { randomBytes } from 'node:crypto'
import { DomainError } from '@fmmi/model'
import { persistentPlayerId } from './ids.ts'
import type { CatalogStore, PlayerEntityRow, SelectedObservation } from './types.ts'

/**
 * Save-scoped player identity (spec 6.1, 6.2). A match-local id (`p_...`) is derived from the recording revision and never
 * changes. A persistent player (`pe_...`) is a save-scoped entity created in exactly two ways:
 *   1. automatically, when the same POSITIVE upstream uid appears in two or more matches of the save AND the display name agrees
 *      (the verification evidence, stored with the supporting match ids); or
 *   2. by `fmmi player link`, an audited user decision.
 * A name alone never merges. A uid seen once, a missing uid or a non-positive uid stays match-local. The same uid with different
 * names is flagged `identity_conflict` and not merged.
 */
export const AUTO_RULE = 'same positive upstream uid in two or more matches of the save, and the display name agrees'

export type LocalReason = 'single_match_uid' | 'uid_missing' | 'uid_not_positive' | 'identity_conflict' | 'duplicate_uid_in_match' | 'unlinked_by_user'

export interface PlayerCatalogEntry {
  playerId: string
  name: string
  identityStatus: 'persistent' | 'linked' | 'match_local'
  uid: number | null
  matches: number
  teamIds: string[]
  matchIds: string[]
  lastSeen: string | null
  /** Why a match-local identity is not (yet) persistent. */
  reason: LocalReason | null
  /** For persistent and linked players. */
  evidence: Record<string, unknown> | null
  /** Match-local ids that make up a persistent or linked player. */
  members: string[]
  flags: string[]
}

const sortKey = (o: SelectedObservation) => `${o.matchDate ?? ''}|${o.matchId}`

export function rebuildPlayerIdentities(store: CatalogStore, saveId: string, at: string): void {
  store.transaction(() => {
    store.deleteAutoIdentities(saveId)
    const obs = store.listSelectedObservations(saveId)
    const present = new Set(obs.map((o) => o.localPlayerId))
    // A manual member whose revision is no longer a selected, nonconflicting one of this save is dropped.
    for (const e of store.listEntities(saveId)) {
      for (const m of e.members) if (m.source === 'manual' && !present.has(m.localPlayerId)) store.deleteMember(m.localPlayerId)
    }
    const manual = new Set(store.listEntities(saveId).flatMap((e) => e.members.map((m) => m.localPlayerId)))
    const excluded = new Set(store.listLinkRecords(saveId, 'exclude').map((l) => l.localPlayerId))

    const byUid = new Map<number, SelectedObservation[]>()
    for (const o of obs) {
      if (o.uid === null || o.uid <= 0 || manual.has(o.localPlayerId) || excluded.has(o.localPlayerId)) continue
      const l = byUid.get(o.uid) ?? []
      l.push(o); byUid.set(o.uid, l)
    }
    const flags: Array<{ saveId: string; uid: number; flag: string; details: Record<string, unknown> }> = []
    for (const [uid, list] of byUid) {
      const matchIds = [...new Set(list.map((o) => o.matchId))]
      if (matchIds.length < 2) continue // a uid seen in one match stays match-local
      if (matchIds.length !== list.length) {
        flags.push({ saveId, uid, flag: 'duplicate_uid_in_match', details: { matchIds } })
        continue
      }
      const names = [...new Set(list.map((o) => o.nameKey))]
      if (names.length > 1) {
        flags.push({ saveId, uid, flag: 'identity_conflict', details: { names: [...new Set(list.map((o) => o.name))].slice(0, 6), matchIds, reason: 'same_uid_different_names_not_merged' } })
        continue
      }
      const ordered = [...list].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
      const entity: PlayerEntityRow = {
        playerId: persistentPlayerId(saveId, uid), saveId, displayName: ordered[ordered.length - 1]!.name, status: 'persistent', uid,
        evidence: { basis: 'verified_upstream_uid', rule: AUTO_RULE, uid, matchIds: ordered.map((o) => o.matchId), matches: ordered.length },
        createdAt: at,
      }
      store.insertEntity(entity)
      for (const o of ordered) store.insertMember({ localPlayerId: o.localPlayerId, playerId: entity.playerId, saveId, source: 'uid' })
    }
    store.setFlags(saveId, flags)
    for (const e of store.listEntities(saveId)) if (e.members.length < 2) store.deleteEntity(e.playerId)
  })
}

export interface LinkResult { playerId: string; status: 'linked' | 'persistent'; created: boolean; localPlayerIds: string[]; matchIds: string[]; warnings: string[] }

export function linkPlayers(store: CatalogStore, saveId: string, ids: string[], at: string, opts: { name?: string } = {}): LinkResult {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new DomainError('invalid_input', 'A player id was given twice', { reason: 'duplicate_player' })
  if (unique.length < 2) throw new DomainError('invalid_input', 'Linking needs at least two ids: match-local ids (p_...) and optionally one persistent id (pe_...)', { reason: 'usage' })
  return store.transaction(() => {
    const obs = store.listSelectedObservations(saveId)
    const byLocal = new Map(obs.map((o) => [o.localPlayerId, o]))
    let entity: (PlayerEntityRow & { members: Array<{ localPlayerId: string }> }) | null = null
    const locals: SelectedObservation[] = []
    for (const id of unique) {
      if (id.startsWith('pe_')) {
        const e = store.getEntity(id)
        if (!e || e.saveId !== saveId) throw new DomainError('not_found', 'Persistent player not found in this save', { playerId: id })
        if (entity) throw new DomainError('invalid_input', 'Link at most one persistent player at a time', { reason: 'two_persistent_players' })
        entity = e
      } else if (id.startsWith('p_')) {
        const o = byLocal.get(id)
        if (!o) throw new DomainError('not_found', 'Match-local player not found among the selected recordings of this save', { playerId: id })
        const member = store.getMember(id)
        if (member) throw new DomainError('identity_conflict', 'This match-local identity already belongs to a player; unlink it first', { reason: 'already_linked', playerId: id, memberOf: member.playerId })
        locals.push(o)
      } else throw new DomainError('invalid_input', 'Player ids start with p_ (match-local) or pe_ (persistent)', { reason: 'usage' })
    }
    if (locals.length === 0) throw new DomainError('invalid_input', 'Give at least one match-local id (p_...) to link', { reason: 'usage' })
    const covered = new Set<string>()
    if (entity) for (const m of entity.members) { const o = byLocal.get(m.localPlayerId); if (o) covered.add(o.matchId) }
    for (const o of locals) {
      if (covered.has(o.matchId)) throw new DomainError('invalid_input', 'Two identities from the same match cannot be one player', { reason: 'same_match', matchId: o.matchId })
      covered.add(o.matchId)
    }
    const warnings: string[] = []
    const names = new Set([...locals.map((o) => o.nameKey), ...(entity ? [entity.displayName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()] : [])])
    if (names.size > 1) warnings.push('display_names_differ: linked by user decision, not by name')
    const uids = new Set(locals.map((o) => o.uid))
    if (uids.size > 1 || (entity && entity.uid !== null && locals.some((o) => o.uid !== entity!.uid))) warnings.push('uids_differ: linked by user decision')
    const created = entity === null
    if (!entity) {
      const first = locals[locals.length - 1]!
      const row: PlayerEntityRow = {
        playerId: `pe_${randomBytes(6).toString('hex')}`, saveId, displayName: opts.name?.trim() || first.name, status: 'linked', uid: null,
        evidence: { basis: 'manual_link', linkedAt: at, localPlayerIds: locals.map((o) => o.localPlayerId), matchIds: locals.map((o) => o.matchId) }, createdAt: at,
      }
      store.insertEntity(row)
      entity = { ...row, members: [] }
    }
    for (const o of locals) {
      store.insertMember({ localPlayerId: o.localPlayerId, playerId: entity.playerId, saveId, source: 'manual' })
      store.addLinkRecord({ saveId, kind: 'link', localPlayerId: o.localPlayerId, playerId: entity.playerId, at })
      store.deactivateLinkRecords(saveId, o.localPlayerId, 'exclude')
    }
    store.recordAudit('player.link', 'player', entity.playerId, saveId, at, {
      localPlayerIds: locals.map((o) => o.localPlayerId), matchIds: locals.map((o) => o.matchId), names: locals.map((o) => o.name), created, warnings, basis: 'user_decision_not_name_merge',
    })
    return { playerId: entity.playerId, status: entity.status, created, localPlayerIds: locals.map((o) => o.localPlayerId), matchIds: locals.map((o) => o.matchId), warnings }
  })
}

export interface UnlinkResult { localPlayerId: string; fromPlayerId: string; previousSource: 'uid' | 'manual'; entityRemoved: boolean }

export function unlinkPlayer(store: CatalogStore, saveId: string, localPlayerId: string, at: string): UnlinkResult {
  return store.transaction(() => {
    const m = store.getMember(localPlayerId)
    if (!m || m.saveId !== saveId) throw new DomainError('not_found', 'This match-local identity is not part of a player in this save', { playerId: localPlayerId })
    store.deleteMember(localPlayerId)
    if (m.source === 'manual') store.deactivateLinkRecords(saveId, localPlayerId, 'link')
    // An automatically verified identity is kept apart from now on: the exclusion survives later rebuilds.
    else store.addLinkRecord({ saveId, kind: 'exclude', localPlayerId, playerId: m.playerId, at })
    const e = store.getEntity(m.playerId)
    let removed = false
    if (e && e.members.length < 2) { store.deleteEntity(e.playerId); removed = true }
    store.recordAudit('player.unlink', 'player', m.playerId, saveId, at, { localPlayerId, previousSource: m.source, entityRemoved: removed })
    rebuildPlayerIdentities(store, saveId, at)
    return { localPlayerId, fromPlayerId: m.playerId, previousSource: m.source, entityRemoved: removed }
  })
}

/** Everything list_players needs, unsorted: one entry per persistent or linked player and one per unmerged match-local identity. */
export function playerCatalog(store: CatalogStore, saveId: string): PlayerCatalogEntry[] {
  const obs = store.listSelectedObservations(saveId)
  const byLocal = new Map(obs.map((o) => [o.localPlayerId, o]))
  const entities = store.listEntities(saveId)
  const memberOf = new Set(entities.flatMap((e) => e.members.map((m) => m.localPlayerId)))
  const flags = store.listFlags(saveId)
  const flagsByUid = new Map<number, string[]>()
  for (const f of flags) flagsByUid.set(f.uid, [...(flagsByUid.get(f.uid) ?? []), f.flag])
  const excluded = new Set(store.listLinkRecords(saveId, 'exclude').map((l) => l.localPlayerId))
  const out: PlayerCatalogEntry[] = []
  for (const e of entities) {
    const members = e.members.map((m) => byLocal.get(m.localPlayerId)).filter((o): o is SelectedObservation => !!o)
    const dates = members.map((o) => o.matchDate).filter((d): d is string => d !== null).sort()
    out.push({
      playerId: e.playerId, name: e.displayName, identityStatus: e.status, uid: e.uid, matches: new Set(members.map((o) => o.matchId)).size,
      teamIds: [...new Set(members.map((o) => o.teamId))], matchIds: members.map((o) => o.matchId), lastSeen: dates[dates.length - 1] ?? null, reason: null,
      evidence: e.evidence, members: e.members.map((m) => m.localPlayerId), flags: [],
    })
  }
  for (const o of obs) {
    if (memberOf.has(o.localPlayerId)) continue
    const fl = o.uid !== null ? (flagsByUid.get(o.uid) ?? []) : []
    const reason: LocalReason = excluded.has(o.localPlayerId) ? 'unlinked_by_user'
      : o.uid === null ? 'uid_missing' : o.uid <= 0 ? 'uid_not_positive'
        : fl.includes('identity_conflict') ? 'identity_conflict' : fl.includes('duplicate_uid_in_match') ? 'duplicate_uid_in_match' : 'single_match_uid'
    out.push({
      playerId: o.localPlayerId, name: o.name, identityStatus: 'match_local', uid: o.uid, matches: 1, teamIds: [o.teamId], matchIds: [o.matchId], lastSeen: o.matchDate,
      reason, evidence: null, members: [], flags: fl,
    })
  }
  return out
}
