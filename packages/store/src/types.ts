import type { NormalizedRecording } from '@fmmi/model'

export type IdentityStatus = 'ok' | 'identity_conflict' | 'separate_occurrence' | 'ignored'
/** How a revision relates to the revision it was recorded after (Slice 5). `continuation` extends a verified prefix, `prefix` is an earlier verified prefix kept as evidence, `alternate` is a user choice. */
export type RevisionRelation = 'continuation' | 'prefix' | 'alternate'

export interface SaveRow { saveId: string; displayName: string; seasonStart: string; createdAt: string }
export interface TeamRow { teamId: string; saveId: string; uid: number | null; clubUid: number | null; name: string }
export interface MatchRow {
  matchId: string; saveId: string; upstreamMatchId: string; selectedRevisionId: string
  homeTeamId: string; awayTeamId: string; matchDate: string | null; season: string | null; competition: string | null; createdAt: string
}
export interface RevisionRow {
  recordingRevisionId: string; matchId: string; saveId: string; parentRevisionId: string | null
  archiveSha256: string; sizeBytes: number; snapshotPath: string; sourceMatchId: string; format: string
  parserName: string; parserVersion: string; processedAt: string; integrityStatus: string; identityStatus: IdentityStatus; relation: RevisionRelation | null
}
export interface ConfirmationRow { recordingRevisionId: string; home: number; away: number; confirmedAt: string; differsFromObserved: boolean }
export interface AuditRow { auditId: number; at: string; action: string; subjectType: string; subjectId: string; saveId: string | null; details: Record<string, unknown> }

export interface TeamInput { uid: number | null; clubUid: number | null; name: string }

export interface MatchFields { teams: { home: TeamInput; away: TeamInput }; matchDate: string | null; season: string | null; competition: string | null }

export interface PlayerObservationRow {
  recordingRevisionId: string
  upstreamPlayerId: number
  localPlayerId: string
  uid: number | null
  name: string
  nameKey: string
  side: 'home' | 'away'
  status: 'played' | 'unused_substitute'
  minutes: number
}
/** Observation of a player in the SELECTED, nonconflicting revision of a match of the save. */
export interface SelectedObservation extends PlayerObservationRow { matchId: string; saveId: string; teamId: string; matchDate: string | null }

export interface IngestExtras { aggregate: { key: string; json: string } | null; observations: PlayerObservationRow[] }

export type PlayerEntityStatus = 'persistent' | 'linked'
export interface PlayerEntityRow { playerId: string; saveId: string; displayName: string; status: PlayerEntityStatus; uid: number | null; evidence: Record<string, unknown>; createdAt: string }
export interface PlayerMemberRow { localPlayerId: string; playerId: string; saveId: string; source: 'uid' | 'manual' }
export interface PlayerLinkRecord { linkId: number; saveId: string; kind: 'link' | 'exclude'; localPlayerId: string; playerId: string | null; at: string; active: boolean }
export interface PlayerFlagRow { saveId: string; uid: number; flag: string; details: Record<string, unknown> }

export interface TacticalNoteRow {
  noteId: string; matchId: string; recordingRevisionId: string; side: 'home' | 'away'; period: number | null; minute: number
  setting: string; priorValue: string; newValue: string; comment: string | null; confidence: 'manual'; supersedesNoteId: string | null; createdAt: string
}
export interface AliasRow { saveId: string; teamId: string; alias: string; aliasKey: string; createdAt: string }
export type ManagedSource = 'explicit' | 'assisted'
export interface ManagedTeamRow { saveId: string; teamId: string; source: ManagedSource }

export interface IngestInsert {
  saveId: string
  revision: Omit<RevisionRow, 'matchId' | 'saveId' | 'identityStatus' | 'relation'> & { identityStatus: IdentityStatus }
  recording: NormalizedRecording
  locator: string
  matchDate: string | null
  season: string | null
  competition: string | null
  teams: { home: TeamInput; away: TeamInput }
  projectionVersion: string
  /** Called inside the insert transaction once the ids exist: derived rows are committed atomically with the revision. */
  /** A verified-prefix relation to the match's currently selected revision. Without it, a second recording of a known source identity is retained as `identity_conflict`. */
  continuation?: { parentRevisionId: string; relation: 'continuation' | 'prefix'; evidence: Record<string, unknown> }
  derive?: (ids: { matchId: string; recordingRevisionId: string; teamIds: { home: string; away: string } }) => IngestExtras
}
export interface IngestInsertResult { matchId: string; recordingRevisionId: string; identityStatus: IdentityStatus; newMatch: boolean; relation: RevisionRelation | null }

/** Persistence boundary. The only implementation is SQLite (better-sqlite3). */
export interface CatalogStore {
  readonly driver: string
  schemaVersion(): number
  close(): void
  createSave(name: string, createdAt: string): SaveRow
  getSave(saveId: string): SaveRow | null
  listSaves(): SaveRow[]
  findRevisionByHash(saveId: string, sha256: string): RevisionRow | null
  addLocator(revisionId: string, locator: string, at: string): void
  listLocators(revisionId: string): string[]
  findMatchByUpstreamId(saveId: string, upstreamMatchId: string): MatchRow | null
  insertIngest(input: IngestInsert): IngestInsertResult
  getMatch(matchId: string): MatchRow | null
  listMatches(saveId: string): MatchRow[]
  listRevisions(matchId: string): RevisionRow[]
  getRevision(revisionId: string): RevisionRow | null
  getTeam(teamId: string): TeamRow | null
  getProjection(revisionId: string, version: string): NormalizedRecording | null
  getConfirmation(revisionId: string): ConfirmationRow | null
  snapshotBytesTotal(): number
  hasSnapshotHash(sha256: string): boolean
  confirmRevision(c: ConfirmationRow, audit: { details: Record<string, unknown> }): { previous: ConfirmationRow | null }
  moveMatch(matchId: string, toSaveId: string, at: string): { fromSaveId: string; revisions: number }
  resolveRevision(revisionId: string, as: 'separate_occurrence' | 'ignored', at: string, fields: MatchFields): { matchId: string; previousMatchId: string }
  /** Slice 5: the user's choice of a conflicting recording as the match's continuation (verified by the caller) or alternate recording. Retains every prior revision. */
  chooseRevision(revisionId: string, as: 'continuation' | 'alternate', at: string, evidence: Record<string, unknown>): { matchId: string; previousSelectedRevisionId: string; parentRevisionId: string | null }
  listAudit(): AuditRow[]

  // ---- Slice 4: transactions and audit
  transaction<T>(fn: () => T): T
  recordAudit(action: string, subjectType: string, subjectId: string, saveId: string | null, at: string, details: Record<string, unknown>): void

  // ---- Slice 4: cached versioned aggregates (derived, rebuildable; retained revisions stay authoritative)
  getAggregate(revisionId: string, key: string): string | null
  putAggregate(revisionId: string, key: string, json: string, at: string): void
  countAggregates(key: string): number

  // ---- Slice 4: player identity
  listSelectedObservations(saveId: string): SelectedObservation[]
  listEntities(saveId: string): Array<PlayerEntityRow & { members: PlayerMemberRow[] }>
  getEntity(playerId: string): (PlayerEntityRow & { members: PlayerMemberRow[] }) | null
  getMember(localPlayerId: string): PlayerMemberRow | null
  deleteAutoIdentities(saveId: string): void
  insertEntity(row: PlayerEntityRow): void
  insertMember(row: PlayerMemberRow): void
  deleteMember(localPlayerId: string): void
  deleteEntity(playerId: string): void
  setFlags(saveId: string, flags: PlayerFlagRow[]): void
  listFlags(saveId: string): PlayerFlagRow[]
  addLinkRecord(r: Omit<PlayerLinkRecord, 'linkId' | 'active'>): void
  listLinkRecords(saveId: string, kind?: 'link' | 'exclude'): PlayerLinkRecord[]
  deactivateLinkRecords(saveId: string, localPlayerId: string, kind: 'link' | 'exclude'): void
  observationsForLocal(localPlayerId: string): Array<PlayerObservationRow & { matchId: string; saveId: string }>

  // ---- Slice 4: tactical notes (immutable)
  insertNote(row: TacticalNoteRow): void
  getNote(noteId: string): TacticalNoteRow | null
  listNotes(saveId: string, matchId?: string): Array<TacticalNoteRow & { saveId: string; supersededByNoteId: string | null }>
  supersedingNoteOf(noteId: string): string | null

  // ---- Slice 5: live notes
  insertLiveNote(row: LiveNoteRow): void
  getLiveNote(noteId: string): (LiveNoteRow & { adoption: LiveNoteAdoption | null }) | null
  listLiveNotes(filter: { saveId?: string; upstreamMatchId?: string }): Array<LiveNoteRow & { adoption: LiveNoteAdoption | null; supersededByNoteId: string | null }>
  adoptLiveNote(a: LiveNoteAdoption): void

  // ---- Slice 4: club aliases and the managed team
  addAlias(row: AliasRow): void
  removeAlias(saveId: string, aliasKey: string): boolean
  listAliases(saveId: string, teamId?: string): AliasRow[]
  listTeams(saveId: string): TeamRow[]
  setManagedTeam(saveId: string, teamId: string | null, source: ManagedSource | null): void
  getManagedTeam(saveId: string): ManagedTeamRow | null
}

// ---- Slice 5: live tactical notes (immutable; written by the local CLI only)
export interface LiveNoteRow {
  noteId: string; saveId: string; upstreamMatchId: string; side: 'home' | 'away'
  /** Explicit live snapshot boundary the note refers to: period, tick and the display minute of that frame. */
  period: number; tick: number; displayMinute: number
  setting: string; priorValue: string; newValue: string; comment: string | null; confidence: 'manual'
  /** Where the boundary came from: the end of the live snapshot, or an explicit earlier boundary the user named. */
  boundarySource: 'live_snapshot_end' | 'explicit'
  snapshotTick: number
  supersedesNoteId: string | null; createdAt: string
}
export interface LiveNoteAdoption { noteId: string; tacticalNoteId: string; matchId: string; recordingRevisionId: string; at: string }
