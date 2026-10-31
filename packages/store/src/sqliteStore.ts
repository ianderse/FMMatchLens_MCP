import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DomainError } from '@fmmi/model'
import type { NormalizedRecording } from '@fmmi/model'
import { nameKey, playerIdFor } from './ids.ts'
import type {
  AliasRow, AuditRow, CatalogStore, ConfirmationRow, IdentityStatus, IngestInsert, IngestInsertResult, ManagedSource, ManagedTeamRow, MatchFields, MatchRow,
  PlayerEntityRow, PlayerFlagRow, LiveNoteAdoption, LiveNoteRow, RevisionRelation, PlayerLinkRecord, PlayerMemberRow, PlayerObservationRow, RevisionRow, SaveRow, SelectedObservation, TacticalNoteRow, TeamInput, TeamRow,
} from './types.ts'

type Db = Database.Database

export const MIGRATIONS: string[] = [
  // v1: Slice 1 catalog
  `
  CREATE TABLE save_profile (
    save_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, season_start TEXT NOT NULL DEFAULT '07-01', created_at TEXT NOT NULL);
  CREATE TABLE team_identity (
    team_id TEXT PRIMARY KEY, save_id TEXT NOT NULL REFERENCES save_profile(save_id),
    upstream_team_uid INTEGER, club_uid INTEGER, name TEXT NOT NULL);
  CREATE INDEX team_identity_save ON team_identity(save_id, upstream_team_uid);
  CREATE TABLE match (
    match_id TEXT PRIMARY KEY, save_id TEXT NOT NULL REFERENCES save_profile(save_id), upstream_match_id TEXT NOT NULL,
    selected_revision_id TEXT NOT NULL, home_team_id TEXT NOT NULL REFERENCES team_identity(team_id),
    away_team_id TEXT NOT NULL REFERENCES team_identity(team_id), match_date TEXT, season TEXT, competition TEXT, created_at TEXT NOT NULL);
  CREATE INDEX match_save ON match(save_id, created_at);
  CREATE INDEX match_upstream ON match(save_id, upstream_match_id);
  CREATE TABLE recording_revision (
    recording_revision_id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES match(match_id),
    save_id TEXT NOT NULL REFERENCES save_profile(save_id), parent_revision_id TEXT, archive_sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, snapshot_path TEXT NOT NULL, source_match_id TEXT NOT NULL, format TEXT NOT NULL,
    parser_name TEXT NOT NULL, parser_version TEXT NOT NULL, processed_at TEXT NOT NULL, integrity_status TEXT NOT NULL,
    identity_status TEXT NOT NULL CHECK (identity_status IN ('ok','identity_conflict','separate_occurrence','ignored')),
    UNIQUE (save_id, archive_sha256));
  CREATE INDEX revision_match ON recording_revision(match_id);
  CREATE TABLE source_locator (
    recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id), locator TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, PRIMARY KEY (recording_revision_id, locator));
  CREATE TABLE projection (
    recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id), projection_version TEXT NOT NULL,
    json TEXT NOT NULL, PRIMARY KEY (recording_revision_id, projection_version));
  CREATE TABLE confirmation (
    recording_revision_id TEXT PRIMARY KEY REFERENCES recording_revision(recording_revision_id), home INTEGER NOT NULL,
    away INTEGER NOT NULL, confirmed_at TEXT NOT NULL, differs_from_observed INTEGER NOT NULL);
  CREATE TABLE audit_log (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL, save_id TEXT, details TEXT NOT NULL);
  `,
  // v2: Slice 4 season history. Season query indexes, cached versioned aggregates, save-scoped player identity, immutable tactical
  // notes, club aliases and the managed team. Raw recording revisions stay authoritative; everything here is derived or an audited
  // user decision.
  `
  CREATE INDEX match_season ON match(save_id, season, match_date);
  CREATE INDEX match_home_team ON match(home_team_id, match_date);
  CREATE INDEX match_away_team ON match(away_team_id, match_date);
  ALTER TABLE save_profile ADD COLUMN managed_team_id TEXT;
  ALTER TABLE save_profile ADD COLUMN managed_source TEXT CHECK (managed_source IN ('explicit','assisted'));
  CREATE TABLE club_alias (
    save_id TEXT NOT NULL REFERENCES save_profile(save_id), team_id TEXT NOT NULL REFERENCES team_identity(team_id), alias TEXT NOT NULL,
    alias_key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (save_id, alias_key));
  CREATE TABLE match_aggregate (
    recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id), aggregate_key TEXT NOT NULL, json TEXT NOT NULL,
    built_at TEXT NOT NULL, PRIMARY KEY (recording_revision_id, aggregate_key));
  CREATE TABLE player_observation (
    recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id), upstream_player_id INTEGER NOT NULL,
    local_player_id TEXT NOT NULL, uid INTEGER, name TEXT NOT NULL, name_key TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('home','away')),
    status TEXT NOT NULL CHECK (status IN ('played','unused_substitute')), minutes REAL NOT NULL,
    PRIMARY KEY (recording_revision_id, upstream_player_id));
  CREATE INDEX player_observation_local ON player_observation(local_player_id);
  CREATE INDEX player_observation_uid ON player_observation(uid);
  CREATE TABLE player_entity (
    player_id TEXT PRIMARY KEY, save_id TEXT NOT NULL REFERENCES save_profile(save_id), display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('persistent','linked')), uid INTEGER, evidence TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX player_entity_save ON player_entity(save_id);
  CREATE TABLE player_member (
    local_player_id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player_entity(player_id) ON DELETE CASCADE,
    save_id TEXT NOT NULL REFERENCES save_profile(save_id), source TEXT NOT NULL CHECK (source IN ('uid','manual')));
  CREATE INDEX player_member_entity ON player_member(player_id);
  CREATE TABLE player_identity_flag (
    save_id TEXT NOT NULL REFERENCES save_profile(save_id), uid INTEGER NOT NULL, flag TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY (save_id, uid, flag));
  CREATE TABLE player_link (
    link_id INTEGER PRIMARY KEY AUTOINCREMENT, save_id TEXT NOT NULL REFERENCES save_profile(save_id), kind TEXT NOT NULL CHECK (kind IN ('link','exclude')),
    local_player_id TEXT NOT NULL, player_id TEXT, at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE INDEX player_link_save ON player_link(save_id, kind, active);
  CREATE TABLE tactical_note (
    note_id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES match(match_id), recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id),
    side TEXT NOT NULL CHECK (side IN ('home','away')), period INTEGER, minute REAL NOT NULL CHECK (minute >= 0), setting TEXT NOT NULL, prior_value TEXT NOT NULL,
    new_value TEXT NOT NULL, comment TEXT, confidence TEXT NOT NULL CHECK (confidence = 'manual'),
    supersedes_note_id TEXT REFERENCES tactical_note(note_id), created_at TEXT NOT NULL);
  CREATE INDEX tactical_note_match ON tactical_note(match_id, created_at);
  CREATE UNIQUE INDEX tactical_note_supersedes ON tactical_note(supersedes_note_id) WHERE supersedes_note_id IS NOT NULL;
  CREATE TRIGGER tactical_note_no_update BEFORE UPDATE ON tactical_note BEGIN SELECT RAISE(ABORT, 'tactical notes are immutable; supersede the note instead'); END;
  CREATE TRIGGER tactical_note_no_delete BEFORE DELETE ON tactical_note BEGIN SELECT RAISE(ABORT, 'tactical notes are immutable; supersede the note instead'); END;
  `,
  // v3: Slice 5. How a revision relates to the one before it (verified-prefix continuation, earlier prefix, user-chosen alternate), and
  // immutable live tactical notes keyed by the SOURCE match id with an explicit live snapshot boundary. A live note is adopted into a
  // regular tactical note when the finished recording is imported; the adoption is a separate, audited row so the note itself never changes.
  `
  ALTER TABLE recording_revision ADD COLUMN relation TEXT CHECK (relation IS NULL OR relation IN ('continuation','prefix','alternate'));
  CREATE TABLE live_note (
    note_id TEXT PRIMARY KEY, save_id TEXT NOT NULL REFERENCES save_profile(save_id), upstream_match_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('home','away')), period INTEGER NOT NULL, tick INTEGER NOT NULL CHECK (tick >= 0), display_minute REAL NOT NULL CHECK (display_minute >= 0),
    setting TEXT NOT NULL, prior_value TEXT NOT NULL, new_value TEXT NOT NULL, comment TEXT, confidence TEXT NOT NULL CHECK (confidence = 'manual'),
    boundary_source TEXT NOT NULL CHECK (boundary_source IN ('live_snapshot_end','explicit')), snapshot_tick INTEGER NOT NULL,
    supersedes_note_id TEXT REFERENCES live_note(note_id), created_at TEXT NOT NULL);
  CREATE INDEX live_note_match ON live_note(save_id, upstream_match_id, created_at);
  CREATE UNIQUE INDEX live_note_supersedes ON live_note(supersedes_note_id) WHERE supersedes_note_id IS NOT NULL;
  CREATE TRIGGER live_note_no_update BEFORE UPDATE ON live_note BEGIN SELECT RAISE(ABORT, 'live notes are immutable; supersede the note instead'); END;
  CREATE TRIGGER live_note_no_delete BEFORE DELETE ON live_note BEGIN SELECT RAISE(ABORT, 'live notes are immutable; supersede the note instead'); END;
  CREATE TABLE live_note_adoption (
    note_id TEXT PRIMARY KEY REFERENCES live_note(note_id), tactical_note_id TEXT NOT NULL REFERENCES tactical_note(note_id),
    match_id TEXT NOT NULL REFERENCES match(match_id), recording_revision_id TEXT NOT NULL REFERENCES recording_revision(recording_revision_id), at TEXT NOT NULL);
  `,
]

export function newId(prefix: string): string { return `${prefix}_${randomBytes(8).toString('hex')}` }

/** Per-revision player observations: the identity evidence (uid, display name) as recorded, plus participation status and minutes. */
export function observationsOf(revisionId: string, rec: NormalizedRecording): PlayerObservationRow[] {
  return rec.roster.map((p) => ({
    recordingRevisionId: revisionId, upstreamPlayerId: p.upstreamPlayerId, localPlayerId: playerIdFor(revisionId, p.upstreamPlayerId), uid: p.uid,
    name: p.name, nameKey: nameKey(p.name), side: p.side, status: p.participation.status, minutes: p.participation.elapsedMinutes,
  }))
}

export class SqliteCatalogStore implements CatalogStore {
  readonly driver = 'better-sqlite3'
  private db: Db

  /**
   * `readOnly` opens an existing catalog without creating, migrating or writing anything (the MCP server). A catalog
   * whose schema is not the one this build expects is refused, never upgraded.
   */
  constructor(path: string, opts: { readOnly?: boolean; busyTimeoutMs?: number } = {}) {
    if (opts.readOnly) {
      if (!existsSync(path)) throw new DomainError('not_found', 'No catalog exists at the configured home; import a recording with the fmmi CLI first', { reason: 'catalog_missing' })
      this.db = new Database(path, { readonly: true, fileMustExist: true })
      this.db.pragma('busy_timeout = 3000')
      this.db.pragma('query_only = ON')
      const v = this.db.pragma('user_version', { simple: true }) as number
      if (v !== MIGRATIONS.length) {
        this.db.close()
        throw new DomainError('unsupported_version', 'The catalog schema does not match this build; run the fmmi CLI once to migrate it', { found: v, expected: MIGRATIONS.length })
      }
      return
    }
    this.db = opts.busyTimeoutMs !== undefined ? new Database(path, { timeout: opts.busyTimeoutMs }) : new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate() {
    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let v = current; v < MIGRATIONS.length; v++) {
      const apply = this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!)
        if (v === 1) this.backfillObservations()
        this.db.pragma(`user_version = ${v + 1}`)
      })
      apply()
    }
  }

  /** Migration v2 on an existing catalog: derive the player observations from the stored projections (no archive is decoded). */
  private backfillObservations() {
    const rows = this.db.prepare('SELECT recording_revision_id AS id, json FROM projection').all() as Array<{ id: string; json: string }>
    for (const r of rows) for (const o of observationsOf(r.id, JSON.parse(r.json) as NormalizedRecording)) this.insertObservation(o)
  }
  private insertObservation(o: PlayerObservationRow) {
    this.db.prepare(`INSERT OR REPLACE INTO player_observation (recording_revision_id, upstream_player_id, local_player_id, uid, name, name_key, side, status, minutes)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(o.recordingRevisionId, o.upstreamPlayerId, o.localPlayerId, o.uid, o.name, o.nameKey, o.side, o.status, o.minutes)
  }

  schemaVersion(): number { return this.db.pragma('user_version', { simple: true }) as number }
  close(): void { this.db.close() }

  createSave(name: string, createdAt: string): SaveRow {
    const row: SaveRow = { saveId: newId('s'), displayName: name, seasonStart: '07-01', createdAt }
    this.db.prepare('INSERT INTO save_profile (save_id, display_name, season_start, created_at) VALUES (?,?,?,?)')
      .run(row.saveId, row.displayName, row.seasonStart, row.createdAt)
    return row
  }
  private saveFrom(r: Record<string, unknown>): SaveRow {
    return { saveId: r.save_id as string, displayName: r.display_name as string, seasonStart: r.season_start as string, createdAt: r.created_at as string }
  }
  getSave(saveId: string): SaveRow | null {
    const r = this.db.prepare('SELECT * FROM save_profile WHERE save_id=?').get(saveId) as Record<string, unknown> | undefined
    return r ? this.saveFrom(r) : null
  }
  listSaves(): SaveRow[] {
    return (this.db.prepare('SELECT * FROM save_profile ORDER BY created_at, save_id').all() as Record<string, unknown>[]).map((r) => this.saveFrom(r))
  }

  private revFrom(r: Record<string, unknown>): RevisionRow {
    return {
      recordingRevisionId: r.recording_revision_id as string, matchId: r.match_id as string, saveId: r.save_id as string,
      parentRevisionId: (r.parent_revision_id as string | null) ?? null, archiveSha256: r.archive_sha256 as string,
      sizeBytes: r.size_bytes as number, snapshotPath: r.snapshot_path as string, sourceMatchId: r.source_match_id as string,
      format: r.format as string, parserName: r.parser_name as string, parserVersion: r.parser_version as string,
      processedAt: r.processed_at as string, integrityStatus: r.integrity_status as string, identityStatus: r.identity_status as IdentityStatus,
      relation: ((r.relation as string | null) ?? null) as RevisionRelation | null,
    }
  }
  private matchFrom(r: Record<string, unknown>): MatchRow {
    return {
      matchId: r.match_id as string, saveId: r.save_id as string, upstreamMatchId: r.upstream_match_id as string,
      selectedRevisionId: r.selected_revision_id as string, homeTeamId: r.home_team_id as string, awayTeamId: r.away_team_id as string,
      matchDate: (r.match_date as string | null) ?? null, season: (r.season as string | null) ?? null,
      competition: (r.competition as string | null) ?? null, createdAt: r.created_at as string,
    }
  }

  findRevisionByHash(saveId: string, sha256: string): RevisionRow | null {
    const r = this.db.prepare('SELECT * FROM recording_revision WHERE save_id=? AND archive_sha256=?').get(saveId, sha256) as Record<string, unknown> | undefined
    return r ? this.revFrom(r) : null
  }
  addLocator(revisionId: string, locator: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO source_locator (recording_revision_id, locator, first_seen_at) VALUES (?,?,?)').run(revisionId, locator, at)
  }
  listLocators(revisionId: string): string[] {
    return (this.db.prepare('SELECT locator FROM source_locator WHERE recording_revision_id=? ORDER BY first_seen_at, locator').all(revisionId) as { locator: string }[]).map((r) => r.locator)
  }
  findMatchByUpstreamId(saveId: string, upstreamMatchId: string): MatchRow | null {
    const r = this.db.prepare('SELECT * FROM match WHERE save_id=? AND upstream_match_id=? ORDER BY created_at, match_id LIMIT 1').get(saveId, upstreamMatchId) as Record<string, unknown> | undefined
    return r ? this.matchFrom(r) : null
  }

  private ensureTeam(saveId: string, t: TeamInput): string {
    const found = (t.uid !== null
      ? this.db.prepare('SELECT team_id FROM team_identity WHERE save_id=? AND upstream_team_uid=?').get(saveId, t.uid)
      : this.db.prepare('SELECT team_id FROM team_identity WHERE save_id=? AND upstream_team_uid IS NULL AND name=?').get(saveId, t.name)) as { team_id: string } | undefined
    if (found) return found.team_id
    const id = newId('t')
    this.db.prepare('INSERT INTO team_identity (team_id, save_id, upstream_team_uid, club_uid, name) VALUES (?,?,?,?,?)').run(id, saveId, t.uid, t.clubUid, t.name)
    return id
  }

  insertIngest(input: IngestInsert): IngestInsertResult {
    const tx = this.db.transaction((): IngestInsertResult => {
      if (!this.getSave(input.saveId)) throw new DomainError('not_found', 'Save profile not found', { saveId: input.saveId })
      const revId = newId('r')
      const existing = this.findMatchByUpstreamId(input.saveId, input.revision.sourceMatchId)
      let matchId: string
      let identity: IdentityStatus = input.revision.identityStatus
      let relation: RevisionRelation | null = null
      let newMatch = false
      if (existing) {
        matchId = existing.matchId
        if (input.continuation) {
          // A verified prefix relation to the selected revision (checked by the caller from the decoded frames): it is not a conflict.
          identity = 'ok'
          relation = input.continuation.relation
        } else {
          // Same source identity, different bytes (same bytes were already handled as idempotent): retain, do not overwrite.
          identity = 'identity_conflict'
        }
      } else {
        matchId = newId('m')
        newMatch = true
        const home = this.ensureTeam(input.saveId, input.teams.home)
        const away = this.ensureTeam(input.saveId, input.teams.away)
        this.db.prepare(`INSERT INTO match (match_id, save_id, upstream_match_id, selected_revision_id, home_team_id, away_team_id, match_date, season, competition, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(matchId, input.saveId, input.revision.sourceMatchId, revId, home, away, input.matchDate, input.season, input.competition, input.revision.processedAt)
      }
      const r = input.revision
      this.db.prepare(`INSERT INTO recording_revision (recording_revision_id, match_id, save_id, parent_revision_id, archive_sha256, size_bytes, snapshot_path,
        source_match_id, format, parser_name, parser_version, processed_at, integrity_status, identity_status, relation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(revId, matchId, input.saveId, input.continuation ? input.continuation.parentRevisionId : r.parentRevisionId, r.archiveSha256, r.sizeBytes, r.snapshotPath, r.sourceMatchId, r.format, r.parserName, r.parserVersion, r.processedAt, r.integrityStatus, identity, relation)
      if (input.continuation) {
        if (input.continuation.relation === 'continuation') this.db.prepare('UPDATE match SET selected_revision_id=? WHERE match_id=?').run(revId, matchId)
        this.audit(`recording.${input.continuation.relation}`, 'recording_revision', revId, input.saveId, r.processedAt, {
          matchId, parentRevisionId: input.continuation.parentRevisionId, selected: input.continuation.relation === 'continuation', automatic: true, evidence: input.continuation.evidence,
        })
      }
      this.db.prepare('INSERT INTO projection (recording_revision_id, projection_version, json) VALUES (?,?,?)').run(revId, input.projectionVersion, JSON.stringify(input.recording))
      this.addLocator(revId, input.locator, r.processedAt)
      if (input.derive) {
        const m = this.getMatch(matchId)!
        const extras = input.derive({ matchId, recordingRevisionId: revId, teamIds: { home: m.homeTeamId, away: m.awayTeamId } })
        if (extras.aggregate) this.db.prepare('INSERT INTO match_aggregate (recording_revision_id, aggregate_key, json, built_at) VALUES (?,?,?,?)').run(revId, extras.aggregate.key, extras.aggregate.json, r.processedAt)
        for (const o of extras.observations) this.insertObservation(o)
      }
      return { matchId, recordingRevisionId: revId, identityStatus: identity, newMatch, relation }
    })
    return tx()
  }

  getMatch(matchId: string): MatchRow | null {
    const r = this.db.prepare('SELECT * FROM match WHERE match_id=?').get(matchId) as Record<string, unknown> | undefined
    return r ? this.matchFrom(r) : null
  }
  listMatches(saveId: string): MatchRow[] {
    return (this.db.prepare('SELECT * FROM match WHERE save_id=? ORDER BY match_date, created_at, match_id').all(saveId) as Record<string, unknown>[]).map((r) => this.matchFrom(r))
  }
  listRevisions(matchId: string): RevisionRow[] {
    return (this.db.prepare('SELECT * FROM recording_revision WHERE match_id=? ORDER BY processed_at, recording_revision_id').all(matchId) as Record<string, unknown>[]).map((r) => this.revFrom(r))
  }
  getRevision(revisionId: string): RevisionRow | null {
    const r = this.db.prepare('SELECT * FROM recording_revision WHERE recording_revision_id=?').get(revisionId) as Record<string, unknown> | undefined
    return r ? this.revFrom(r) : null
  }
  getTeam(teamId: string): TeamRow | null {
    const r = this.db.prepare('SELECT * FROM team_identity WHERE team_id=?').get(teamId) as Record<string, unknown> | undefined
    return r ? { teamId: r.team_id as string, saveId: r.save_id as string, uid: (r.upstream_team_uid as number | null) ?? null, clubUid: (r.club_uid as number | null) ?? null, name: r.name as string } : null
  }
  getProjection(revisionId: string, version: string): NormalizedRecording | null {
    const r = this.db.prepare('SELECT json FROM projection WHERE recording_revision_id=? AND projection_version=?').get(revisionId, version) as { json: string } | undefined
    return r ? (JSON.parse(r.json) as NormalizedRecording) : null
  }
  getConfirmation(revisionId: string): ConfirmationRow | null {
    const r = this.db.prepare('SELECT * FROM confirmation WHERE recording_revision_id=?').get(revisionId) as Record<string, unknown> | undefined
    return r ? { recordingRevisionId: revisionId, home: r.home as number, away: r.away as number, confirmedAt: r.confirmed_at as string, differsFromObserved: r.differs_from_observed === 1 } : null
  }
  snapshotBytesTotal(): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(sz),0) AS n FROM (SELECT DISTINCT archive_sha256, size_bytes AS sz FROM recording_revision)').get() as { n: number }
    return r.n
  }
  hasSnapshotHash(sha256: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM recording_revision WHERE archive_sha256=? LIMIT 1').get(sha256)
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn)() }
  recordAudit(action: string, subjectType: string, subjectId: string, saveId: string | null, at: string, details: Record<string, unknown>): void {
    this.audit(action, subjectType, subjectId, saveId, at, details)
  }

  private audit(action: string, subjectType: string, subjectId: string, saveId: string | null, at: string, details: Record<string, unknown>) {
    this.db.prepare('INSERT INTO audit_log (at, action, subject_type, subject_id, save_id, details) VALUES (?,?,?,?,?,?)').run(at, action, subjectType, subjectId, saveId, JSON.stringify(details))
  }

  confirmRevision(c: ConfirmationRow, audit: { details: Record<string, unknown> }): { previous: ConfirmationRow | null } {
    const tx = this.db.transaction(() => {
      const rev = this.getRevision(c.recordingRevisionId)
      if (!rev) throw new DomainError('not_found', 'Recording revision not found')
      const previous = this.getConfirmation(c.recordingRevisionId)
      this.db.prepare(`INSERT INTO confirmation (recording_revision_id, home, away, confirmed_at, differs_from_observed) VALUES (?,?,?,?,?)
        ON CONFLICT(recording_revision_id) DO UPDATE SET home=excluded.home, away=excluded.away, confirmed_at=excluded.confirmed_at, differs_from_observed=excluded.differs_from_observed`)
        .run(c.recordingRevisionId, c.home, c.away, c.confirmedAt, c.differsFromObserved ? 1 : 0)
      this.audit('match.confirm', 'recording_revision', c.recordingRevisionId, rev.saveId, c.confirmedAt, { ...audit.details, previous })
      return { previous }
    })
    return tx()
  }

  moveMatch(matchId: string, toSaveId: string, at: string): { fromSaveId: string; revisions: number } {
    const tx = this.db.transaction(() => {
      const m = this.getMatch(matchId)
      if (!m) throw new DomainError('not_found', 'Match not found', { matchId })
      if (!this.getSave(toSaveId)) throw new DomainError('not_found', 'Target save profile not found', { saveId: toSaveId })
      if (m.saveId === toSaveId) throw new DomainError('invalid_input', 'Match is already in that save', { saveId: toSaveId })
      const revs = this.listRevisions(matchId)
      for (const r of revs) {
        if (this.findRevisionByHash(toSaveId, r.archiveSha256)) {
          throw new DomainError('identity_conflict', 'Target save already contains this archive', { reason: 'duplicate_archive', saveId: toSaveId })
        }
      }
      if (this.findMatchByUpstreamId(toSaveId, m.upstreamMatchId)) {
        throw new DomainError('identity_conflict', 'Target save already has a recording with the same source match identity', { reason: 'source_identity', saveId: toSaveId })
      }
      // Rebuild save-scoped team identities in the target save.
      const home = this.getTeam(m.homeTeamId)!, away = this.getTeam(m.awayTeamId)!
      const newHome = this.ensureTeam(toSaveId, { uid: home.uid, clubUid: home.clubUid, name: home.name })
      const newAway = this.ensureTeam(toSaveId, { uid: away.uid, clubUid: away.clubUid, name: away.name })
      this.db.prepare('UPDATE match SET save_id=?, home_team_id=?, away_team_id=? WHERE match_id=?').run(toSaveId, newHome, newAway, matchId)
      this.db.prepare('UPDATE recording_revision SET save_id=? WHERE match_id=?').run(toSaveId, matchId)
      // Drop source-save team identities that no match references any more.
      const orphan = `save_id=? AND team_id NOT IN (SELECT home_team_id FROM match UNION SELECT away_team_id FROM match)`
      this.db.prepare(`DELETE FROM club_alias WHERE ${orphan}`).run(m.saveId)
      this.db.prepare(`UPDATE save_profile SET managed_team_id=NULL, managed_source=NULL WHERE save_id=? AND managed_team_id IS NOT NULL AND managed_team_id NOT IN (SELECT home_team_id FROM match UNION SELECT away_team_id FROM match)`).run(m.saveId)
      this.db.prepare(`DELETE FROM team_identity WHERE ${orphan}`).run(m.saveId)
      this.audit('match.move', 'match', matchId, toSaveId, at, { fromSaveId: m.saveId, toSaveId, revisions: revs.map((r) => r.recordingRevisionId) })
      return { fromSaveId: m.saveId, revisions: revs.length }
    })
    return tx()
  }

  resolveRevision(revisionId: string, as: 'separate_occurrence' | 'ignored', at: string, fields: MatchFields): { matchId: string; previousMatchId: string } {
    const tx = this.db.transaction(() => {
      const rev = this.getRevision(revisionId)
      if (!rev) throw new DomainError('not_found', 'Recording revision not found', { recordingRevisionId: revisionId })
      if (rev.identityStatus !== 'identity_conflict') {
        throw new DomainError('invalid_input', 'Only a recording marked identity_conflict can be resolved', { identityStatus: rev.identityStatus })
      }
      const previousMatchId = rev.matchId
      let matchId = previousMatchId
      if (as === 'separate_occurrence') {
        matchId = newId('m')
        const home = this.ensureTeam(rev.saveId, fields.teams.home)
        const away = this.ensureTeam(rev.saveId, fields.teams.away)
        this.db.prepare(`INSERT INTO match (match_id, save_id, upstream_match_id, selected_revision_id, home_team_id, away_team_id, match_date, season, competition, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(matchId, rev.saveId, rev.sourceMatchId, rev.recordingRevisionId, home, away, fields.matchDate, fields.season, fields.competition, at)
        this.db.prepare('UPDATE recording_revision SET match_id=?, identity_status=? WHERE recording_revision_id=?').run(matchId, 'separate_occurrence', revisionId)
      } else {
        this.db.prepare('UPDATE recording_revision SET identity_status=? WHERE recording_revision_id=?').run('ignored', revisionId)
      }
      this.audit('recording.resolve', 'recording_revision', revisionId, rev.saveId, at, { as, previousMatchId, matchId })
      return { matchId, previousMatchId }
    })
    return tx()
  }

  chooseRevision(revisionId: string, as: 'continuation' | 'alternate', at: string, evidence: Record<string, unknown>): { matchId: string; previousSelectedRevisionId: string; parentRevisionId: string | null } {
    const tx = this.db.transaction(() => {
      const rev = this.getRevision(revisionId)
      if (!rev) throw new DomainError('not_found', 'Recording revision not found', { recordingRevisionId: revisionId })
      if (rev.identityStatus !== 'identity_conflict') throw new DomainError('invalid_input', 'Only a recording marked identity_conflict can be resolved', { identityStatus: rev.identityStatus })
      const m = this.getMatch(rev.matchId)!
      const previous = m.selectedRevisionId
      // A continuation records the revision it extends; an alternate is the user's choice of a different recording and records no parent.
      const parent = as === 'continuation' ? previous : null
      this.db.prepare('UPDATE recording_revision SET identity_status=?, relation=?, parent_revision_id=? WHERE recording_revision_id=?').run('ok', as, parent, revisionId)
      this.db.prepare('UPDATE match SET selected_revision_id=? WHERE match_id=?').run(revisionId, m.matchId)
      this.audit('recording.resolve', 'recording_revision', revisionId, rev.saveId, at, { as, matchId: m.matchId, previousSelectedRevisionId: previous, parentRevisionId: parent, evidence })
      return { matchId: m.matchId, previousSelectedRevisionId: previous, parentRevisionId: parent }
    })
    return tx()
  }

  listAudit(): AuditRow[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY audit_id').all() as Record<string, unknown>[]).map((r) => ({
      auditId: r.audit_id as number, at: r.at as string, action: r.action as string, subjectType: r.subject_type as string,
      subjectId: r.subject_id as string, saveId: (r.save_id as string | null) ?? null, details: JSON.parse(r.details as string) as Record<string, unknown>,
    }))
  }

  // ------------------------------------------------------------------ Slice 4: aggregates
  getAggregate(revisionId: string, key: string): string | null {
    const r = this.db.prepare('SELECT json FROM match_aggregate WHERE recording_revision_id=? AND aggregate_key=?').get(revisionId, key) as { json: string } | undefined
    return r ? r.json : null
  }
  /** Stores the aggregate for this key and drops the revision's aggregates under any other key (a stale version is never kept). */
  putAggregate(revisionId: string, key: string, json: string, at: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM match_aggregate WHERE recording_revision_id=? AND aggregate_key<>?').run(revisionId, key)
      this.db.prepare(`INSERT INTO match_aggregate (recording_revision_id, aggregate_key, json, built_at) VALUES (?,?,?,?)
        ON CONFLICT(recording_revision_id, aggregate_key) DO UPDATE SET json=excluded.json, built_at=excluded.built_at`).run(revisionId, key, json, at)
    })
    tx()
  }
  countAggregates(key: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM match_aggregate WHERE aggregate_key=?').get(key) as { n: number }).n
  }

  // ------------------------------------------------------------------ Slice 4: player identity
  listSelectedObservations(saveId: string): SelectedObservation[] {
    const rows = this.db.prepare(`SELECT o.*, m.match_id, m.save_id, m.match_date, CASE o.side WHEN 'home' THEN m.home_team_id ELSE m.away_team_id END AS team_id
      FROM player_observation o JOIN recording_revision r ON r.recording_revision_id = o.recording_revision_id
      JOIN match m ON m.match_id = r.match_id AND m.selected_revision_id = r.recording_revision_id
      WHERE m.save_id = ? AND r.identity_status IN ('ok','separate_occurrence')
      ORDER BY m.match_date, m.created_at, m.match_id, o.upstream_player_id`).all(saveId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      recordingRevisionId: r.recording_revision_id as string, upstreamPlayerId: r.upstream_player_id as number, localPlayerId: r.local_player_id as string,
      uid: (r.uid as number | null) ?? null, name: r.name as string, nameKey: r.name_key as string, side: r.side as 'home' | 'away',
      status: r.status as 'played' | 'unused_substitute', minutes: r.minutes as number,
      matchId: r.match_id as string, saveId: r.save_id as string, teamId: r.team_id as string, matchDate: (r.match_date as string | null) ?? null,
    }))
  }
  observationsForLocal(localPlayerId: string): Array<PlayerObservationRow & { matchId: string; saveId: string }> {
    const rows = this.db.prepare('SELECT o.*, r.match_id, r.save_id FROM player_observation o JOIN recording_revision r ON r.recording_revision_id = o.recording_revision_id WHERE o.local_player_id=?')
      .all(localPlayerId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      recordingRevisionId: r.recording_revision_id as string, upstreamPlayerId: r.upstream_player_id as number, localPlayerId: r.local_player_id as string,
      uid: (r.uid as number | null) ?? null, name: r.name as string, nameKey: r.name_key as string, side: r.side as 'home' | 'away',
      status: r.status as 'played' | 'unused_substitute', minutes: r.minutes as number, matchId: r.match_id as string, saveId: r.save_id as string,
    }))
  }
  private entityFrom(r: Record<string, unknown>): PlayerEntityRow {
    return {
      playerId: r.player_id as string, saveId: r.save_id as string, displayName: r.display_name as string, status: r.status as 'persistent' | 'linked',
      uid: (r.uid as number | null) ?? null, evidence: JSON.parse(r.evidence as string) as Record<string, unknown>, createdAt: r.created_at as string,
    }
  }
  private memberFrom(m: Record<string, unknown>): PlayerMemberRow {
    return { localPlayerId: m.local_player_id as string, playerId: m.player_id as string, saveId: m.save_id as string, source: m.source as 'uid' | 'manual' }
  }
  private membersOf(playerId: string): PlayerMemberRow[] {
    return (this.db.prepare('SELECT * FROM player_member WHERE player_id=? ORDER BY local_player_id').all(playerId) as Array<Record<string, unknown>>).map((m) => this.memberFrom(m))
  }
  listEntities(saveId: string) {
    return (this.db.prepare('SELECT * FROM player_entity WHERE save_id=? ORDER BY display_name, player_id').all(saveId) as Array<Record<string, unknown>>)
      .map((r) => ({ ...this.entityFrom(r), members: this.membersOf(r.player_id as string) }))
  }
  getEntity(playerId: string) {
    const r = this.db.prepare('SELECT * FROM player_entity WHERE player_id=?').get(playerId) as Record<string, unknown> | undefined
    return r ? { ...this.entityFrom(r), members: this.membersOf(playerId) } : null
  }
  getMember(localPlayerId: string): PlayerMemberRow | null {
    const m = this.db.prepare('SELECT * FROM player_member WHERE local_player_id=?').get(localPlayerId) as Record<string, unknown> | undefined
    return m ? this.memberFrom(m) : null
  }
  /** Removes the automatically derived identities of a save (uid-verified members, entities left empty, flags); manual members stay. */
  deleteAutoIdentities(saveId: string): void {
    this.db.prepare(`DELETE FROM player_member WHERE save_id=? AND source='uid'`).run(saveId)
    this.db.prepare(`DELETE FROM player_entity WHERE save_id=? AND status='persistent' AND player_id NOT IN (SELECT player_id FROM player_member)`).run(saveId)
    this.db.prepare('DELETE FROM player_identity_flag WHERE save_id=?').run(saveId)
  }
  insertEntity(e: PlayerEntityRow): void {
    this.db.prepare(`INSERT INTO player_entity (player_id, save_id, display_name, status, uid, evidence, created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(player_id) DO UPDATE SET display_name=excluded.display_name, evidence=excluded.evidence`).run(e.playerId, e.saveId, e.displayName, e.status, e.uid, JSON.stringify(e.evidence), e.createdAt)
  }
  insertMember(m: PlayerMemberRow): void {
    this.db.prepare('INSERT OR REPLACE INTO player_member (local_player_id, player_id, save_id, source) VALUES (?,?,?,?)').run(m.localPlayerId, m.playerId, m.saveId, m.source)
  }
  deleteMember(localPlayerId: string): void { this.db.prepare('DELETE FROM player_member WHERE local_player_id=?').run(localPlayerId) }
  deleteEntity(playerId: string): void {
    this.db.prepare('DELETE FROM player_member WHERE player_id=?').run(playerId)
    this.db.prepare('DELETE FROM player_entity WHERE player_id=?').run(playerId)
  }
  setFlags(saveId: string, flags: PlayerFlagRow[]): void {
    this.db.prepare('DELETE FROM player_identity_flag WHERE save_id=?').run(saveId)
    for (const f of flags) this.db.prepare('INSERT OR REPLACE INTO player_identity_flag (save_id, uid, flag, details) VALUES (?,?,?,?)').run(saveId, f.uid, f.flag, JSON.stringify(f.details))
  }
  listFlags(saveId: string): PlayerFlagRow[] {
    return (this.db.prepare('SELECT * FROM player_identity_flag WHERE save_id=? ORDER BY uid, flag').all(saveId) as Array<Record<string, unknown>>)
      .map((r) => ({ saveId: r.save_id as string, uid: r.uid as number, flag: r.flag as string, details: JSON.parse(r.details as string) as Record<string, unknown> }))
  }
  addLinkRecord(r: Omit<PlayerLinkRecord, 'linkId' | 'active'>): void {
    this.db.prepare('INSERT INTO player_link (save_id, kind, local_player_id, player_id, at, active) VALUES (?,?,?,?,?,1)').run(r.saveId, r.kind, r.localPlayerId, r.playerId, r.at)
  }
  listLinkRecords(saveId: string, kind?: 'link' | 'exclude'): PlayerLinkRecord[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM player_link WHERE save_id=? AND kind=? AND active=1 ORDER BY link_id').all(saveId, kind)
      : this.db.prepare('SELECT * FROM player_link WHERE save_id=? AND active=1 ORDER BY link_id').all(saveId)) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      linkId: r.link_id as number, saveId: r.save_id as string, kind: r.kind as 'link' | 'exclude', localPlayerId: r.local_player_id as string,
      playerId: (r.player_id as string | null) ?? null, at: r.at as string, active: r.active === 1,
    }))
  }
  deactivateLinkRecords(saveId: string, localPlayerId: string, kind: 'link' | 'exclude'): void {
    this.db.prepare('UPDATE player_link SET active=0 WHERE save_id=? AND local_player_id=? AND kind=?').run(saveId, localPlayerId, kind)
  }

  // ------------------------------------------------------------------ Slice 4: tactical notes
  private noteFrom(r: Record<string, unknown>): TacticalNoteRow {
    return {
      noteId: r.note_id as string, matchId: r.match_id as string, recordingRevisionId: r.recording_revision_id as string, side: r.side as 'home' | 'away',
      period: (r.period as number | null) ?? null, minute: r.minute as number, setting: r.setting as string, priorValue: r.prior_value as string, newValue: r.new_value as string,
      comment: (r.comment as string | null) ?? null, confidence: 'manual', supersedesNoteId: (r.supersedes_note_id as string | null) ?? null, createdAt: r.created_at as string,
    }
  }
  insertNote(n: TacticalNoteRow): void {
    this.db.prepare(`INSERT INTO tactical_note (note_id, match_id, recording_revision_id, side, period, minute, setting, prior_value, new_value, comment, confidence, supersedes_note_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.noteId, n.matchId, n.recordingRevisionId, n.side, n.period, n.minute, n.setting, n.priorValue, n.newValue, n.comment, n.confidence, n.supersedesNoteId, n.createdAt)
  }
  getNote(noteId: string): TacticalNoteRow | null {
    const r = this.db.prepare('SELECT * FROM tactical_note WHERE note_id=?').get(noteId) as Record<string, unknown> | undefined
    return r ? this.noteFrom(r) : null
  }
  supersedingNoteOf(noteId: string): string | null {
    const r = this.db.prepare('SELECT note_id FROM tactical_note WHERE supersedes_note_id=?').get(noteId) as { note_id: string } | undefined
    return r?.note_id ?? null
  }
  listNotes(saveId: string, matchId?: string) {
    const sql = `SELECT n.*, m.save_id, (SELECT s.note_id FROM tactical_note s WHERE s.supersedes_note_id = n.note_id) AS superseded_by
      FROM tactical_note n JOIN match m ON m.match_id = n.match_id WHERE m.save_id=?${matchId ? ' AND n.match_id=?' : ''} ORDER BY n.created_at, n.note_id`
    const rows = (matchId ? this.db.prepare(sql).all(saveId, matchId) : this.db.prepare(sql).all(saveId)) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...this.noteFrom(r), saveId: r.save_id as string, supersededByNoteId: (r.superseded_by as string | null) ?? null }))
  }

  // ------------------------------------------------------------------ Slice 4: aliases and the managed team
  // ------------------------------------------------------------------ Slice 5: live notes
  private liveNoteFrom(r: Record<string, unknown>): LiveNoteRow {
    return {
      noteId: r.note_id as string, saveId: r.save_id as string, upstreamMatchId: r.upstream_match_id as string, side: r.side as 'home' | 'away',
      period: r.period as number, tick: r.tick as number, displayMinute: r.display_minute as number, setting: r.setting as string, priorValue: r.prior_value as string,
      newValue: r.new_value as string, comment: (r.comment as string | null) ?? null, confidence: 'manual', boundarySource: r.boundary_source as 'live_snapshot_end' | 'explicit',
      snapshotTick: r.snapshot_tick as number, supersedesNoteId: (r.supersedes_note_id as string | null) ?? null, createdAt: r.created_at as string,
    }
  }
  private adoptionOf(noteId: string): LiveNoteAdoption | null {
    const a = this.db.prepare('SELECT * FROM live_note_adoption WHERE note_id=?').get(noteId) as Record<string, unknown> | undefined
    return a ? { noteId, tacticalNoteId: a.tactical_note_id as string, matchId: a.match_id as string, recordingRevisionId: a.recording_revision_id as string, at: a.at as string } : null
  }
  insertLiveNote(n: LiveNoteRow): void {
    this.db.prepare(`INSERT INTO live_note (note_id, save_id, upstream_match_id, side, period, tick, display_minute, setting, prior_value, new_value, comment, confidence, boundary_source, snapshot_tick, supersedes_note_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.noteId, n.saveId, n.upstreamMatchId, n.side, n.period, n.tick, n.displayMinute, n.setting, n.priorValue, n.newValue, n.comment, n.confidence, n.boundarySource, n.snapshotTick, n.supersedesNoteId, n.createdAt)
  }
  getLiveNote(noteId: string) {
    const r = this.db.prepare('SELECT * FROM live_note WHERE note_id=?').get(noteId) as Record<string, unknown> | undefined
    return r ? { ...this.liveNoteFrom(r), adoption: this.adoptionOf(noteId) } : null
  }
  listLiveNotes(filter: { saveId?: string; upstreamMatchId?: string }) {
    const rows = this.db.prepare(`SELECT * FROM live_note WHERE (? IS NULL OR save_id=?) AND (? IS NULL OR upstream_match_id=?) ORDER BY created_at, note_id`)
      .all(filter.saveId ?? null, filter.saveId ?? null, filter.upstreamMatchId ?? null, filter.upstreamMatchId ?? null) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const n = this.liveNoteFrom(r)
      const by = this.db.prepare('SELECT note_id FROM live_note WHERE supersedes_note_id=?').get(n.noteId) as { note_id: string } | undefined
      return { ...n, adoption: this.adoptionOf(n.noteId), supersededByNoteId: by?.note_id ?? null }
    })
  }
  adoptLiveNote(a: LiveNoteAdoption): void {
    this.db.prepare('INSERT INTO live_note_adoption (note_id, tactical_note_id, match_id, recording_revision_id, at) VALUES (?,?,?,?,?)').run(a.noteId, a.tacticalNoteId, a.matchId, a.recordingRevisionId, a.at)
  }

  addAlias(a: AliasRow): void {
    this.db.prepare('INSERT INTO club_alias (save_id, team_id, alias, alias_key, created_at) VALUES (?,?,?,?,?)').run(a.saveId, a.teamId, a.alias, a.aliasKey, a.createdAt)
  }
  removeAlias(saveId: string, aliasKey: string): boolean {
    return this.db.prepare('DELETE FROM club_alias WHERE save_id=? AND alias_key=?').run(saveId, aliasKey).changes > 0
  }
  listAliases(saveId: string, teamId?: string): AliasRow[] {
    const rows = (teamId
      ? this.db.prepare('SELECT * FROM club_alias WHERE save_id=? AND team_id=? ORDER BY alias_key').all(saveId, teamId)
      : this.db.prepare('SELECT * FROM club_alias WHERE save_id=? ORDER BY alias_key').all(saveId)) as Array<Record<string, unknown>>
    return rows.map((r) => ({ saveId: r.save_id as string, teamId: r.team_id as string, alias: r.alias as string, aliasKey: r.alias_key as string, createdAt: r.created_at as string }))
  }
  listTeams(saveId: string): TeamRow[] {
    return (this.db.prepare('SELECT * FROM team_identity WHERE save_id=? ORDER BY name, team_id').all(saveId) as Array<Record<string, unknown>>)
      .map((r) => ({ teamId: r.team_id as string, saveId: r.save_id as string, uid: (r.upstream_team_uid as number | null) ?? null, clubUid: (r.club_uid as number | null) ?? null, name: r.name as string }))
  }
  setManagedTeam(saveId: string, teamId: string | null, source: ManagedSource | null): void {
    this.db.prepare('UPDATE save_profile SET managed_team_id=?, managed_source=? WHERE save_id=?').run(teamId, source, saveId)
  }
  getManagedTeam(saveId: string): ManagedTeamRow | null {
    const r = this.db.prepare('SELECT managed_team_id, managed_source FROM save_profile WHERE save_id=?').get(saveId) as { managed_team_id: string | null; managed_source: ManagedSource | null } | undefined
    return r?.managed_team_id && r.managed_source ? { saveId, teamId: r.managed_team_id, source: r.managed_source } : null
  }
}
