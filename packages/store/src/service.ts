import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import {
  DomainError, PROJECTION_VERSION, SUPPORTED_FORMAT, applyConfirmation, baseCompletion, boundName, deriveResult, parseScore, resolveDisplayMinute, toErrorBody,
} from '@fmmi/model'
import type { DecodedRecording, ErrorBody, MatchCompletion, NormalizedRecording, Participant, ResultView, Side } from '@fmmi/model'
import { FmlensV28Decoder, PARSER_NAME, PARSER_VERSION, compareFramePrefix } from '@fmmi/fmlens-adapter'
import type { PrefixComparison } from '@fmmi/fmlens-adapter'
import type { ArchiveDecoder } from '@fmmi/fmlens-adapter'
import { aggregateKey, buildMatchAggregate } from '@fmmi/analytics'
import type { AnalysisInput, MatchAggregate } from '@fmmi/analytics'
import { nameKey, playerIdFor } from './ids.ts'
import { linkPlayers, playerCatalog, rebuildPlayerIdentities, unlinkPlayer } from './identity.ts'
import { SnapshotDir } from './snapshots.ts'
import { SqliteCatalogStore, newId, observationsOf } from './sqliteStore.ts'
import type { CatalogStore, IngestInsert, LiveNoteRow, MatchFields, MatchRow, RevisionRow, TacticalNoteRow } from './types.ts'

export interface ServiceConfig {
  home: string
  archiveDir?: string
  maxFileBytes: number
  storageLimitBytes: number
  /** Open the catalog read-only: nothing is created, migrated or written (the MCP server). */
  readOnly?: boolean
}

/**
 * Optional cache for decoded recordings, supplied by the query layer. The key must identify immutable content
 * (revision id plus archive hash and parser version); the loader runs only on a miss.
 */
export interface DecodedCache {
  getOrLoad(key: string, sizeHint: number, loader: () => Promise<DecodedRecording>): Promise<DecodedRecording>
  drop(key: string): void
}
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
export const DEFAULT_STORAGE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024

export interface IngestResult {
  file: string
  status: 'ingested' | 'already_ingested' | 'identity_conflict' | 'continuation' | 'rejected'
  sha256?: string
  matchId?: string
  recordingRevisionId?: string
  integrity?: string
  coverage?: string
  completion?: string
  warnings: string[]
  error?: ErrorBody
}

export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  let file: Partial<ServiceConfig> = {}
  const p = join(home, 'config.json')
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')) as Partial<ServiceConfig> } catch { throw new DomainError('invalid_input', 'config.json is not valid JSON', { reason: 'config' }) }
  }
  return {
    home,
    archiveDir: overrides.archiveDir ?? env.FMMI_ARCHIVE_DIR ?? file.archiveDir,
    maxFileBytes: overrides.maxFileBytes ?? file.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    storageLimitBytes: overrides.storageLimitBytes ?? file.storageLimitBytes ?? DEFAULT_STORAGE_LIMIT_BYTES,
  }
}

export function seasonLabel(matchDate: string | null, seasonStart: string): string | null {
  if (!matchDate) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(matchDate)
  const s = /^(\d{2})-(\d{2})$/.exec(seasonStart)
  if (!m || !s) return null
  const y = Number(m[1])
  const afterStart = Number(m[2]) * 100 + Number(m[3]) >= Number(s[1]) * 100 + Number(s[2])
  const startYear = afterStart ? y : y - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export class CatalogService {
  readonly store: CatalogStore
  private snapshots: SnapshotDir
  readonly config: ServiceConfig
  private decoder: ArchiveDecoder
  constructor(config: ServiceConfig, decoder: ArchiveDecoder = new FmlensV28Decoder(), store?: CatalogStore) {
    this.config = config
    this.decoder = decoder
    if (!config.readOnly) mkdirSync(config.home, { recursive: true })
    this.store = store ?? new SqliteCatalogStore(join(config.home, 'catalog.sqlite'), { readOnly: config.readOnly })
    this.snapshots = new SnapshotDir(config.home)
  }
  close() { this.store.close() }

  // ------------------------------------------------------------------ saves
  createSave(name: string) {
    const n = name.trim()
    if (!n || n.length > 120) throw new DomainError('invalid_input', 'Save name must be 1-120 characters', { reason: 'name' })
    return this.store.createSave(n, new Date().toISOString())
  }
  listSaves() { return this.store.listSaves() }
  private requireSave(saveId: string) {
    const s = this.store.getSave(saveId)
    if (!s) throw new DomainError('not_found', 'Save profile not found', { saveId })
    return s
  }

  // ------------------------------------------------------------------ ingest
  async ingestPath(path: string, saveId: string): Promise<IngestResult[]> {
    this.requireSave(saveId)
    let st
    try { st = lstatSync(path) } catch { throw new DomainError('not_found', 'Path does not exist', { path: basename(path) }) }
    if (st.isSymbolicLink()) throw new DomainError('invalid_input', 'Symbolic links are not followed', { reason: 'symlink' })
    if (st.isDirectory()) return this.ingestDir(path, saveId)
    return [await this.ingestFile(path, saveId)]
  }

  private listArchiveFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && extname(d.name).toLowerCase() === '.fmlens')
      .map((d) => join(dir, d.name))
      .sort()
  }

  private async ingestDir(dir: string, saveId: string): Promise<IngestResult[]> {
    const out: IngestResult[] = []
    for (const f of this.listArchiveFiles(dir)) out.push(await this.ingestFile(f, saveId))
    return out
  }

  /** `ingest --new`: the configured archive directory, reporting only files not already in this save. */
  async ingestNew(saveId: string): Promise<{ results: IngestResult[]; skippedAlreadyIngested: number }> {
    this.requireSave(saveId)
    const dir = this.config.archiveDir
    if (!dir) throw new DomainError('not_found', 'No archive directory configured (set FMMI_ARCHIVE_DIR, --archive-dir or config.json archiveDir)', { reason: 'archive_dir_unset' })
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new DomainError('not_found', 'Configured archive directory does not exist', { reason: 'archive_dir_missing' })
    const all = await this.ingestDir(dir, saveId)
    return { results: all.filter((r) => r.status !== 'already_ingested'), skippedAlreadyIngested: all.filter((r) => r.status === 'already_ingested').length }
  }

  async ingestFile(path: string, saveId: string): Promise<IngestResult> {
    const file = basename(path)
    try {
      return await this.ingestFileInner(path, saveId, file)
    } catch (e) {
      return { file, status: 'rejected', warnings: [], error: toErrorBody(e) }
    }
  }

  private async ingestFileInner(path: string, saveId: string, file: string): Promise<IngestResult> {
    const save = this.requireSave(saveId)
    let st
    try { st = lstatSync(path) } catch { throw new DomainError('not_found', 'File does not exist', { file }) }
    if (st.isSymbolicLink()) throw new DomainError('invalid_input', 'Symbolic links are not followed', { reason: 'symlink', file })
    if (!st.isFile()) throw new DomainError('invalid_input', 'Not a regular file', { file })
    if (extname(path).toLowerCase() !== '.fmlens') throw new DomainError('invalid_input', 'Only .fmlens files are accepted', { reason: 'extension', file })
    if (st.size > this.config.maxFileBytes) throw new DomainError('invalid_input', 'File exceeds the size limit', { kind: 'file_too_large', limit: this.config.maxFileBytes, file })
    const real = realpathSync(path)
    const bytes = readFileSync(real)
    const after = statSync(real)
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || bytes.byteLength !== st.size) {
      throw new DomainError('stale_snapshot', 'File changed while it was being read; retry when the game has finished writing it', { file }, true)
    }
    const sha = sha256Hex(bytes)
    const now = new Date().toISOString()

    const existing = this.store.findRevisionByHash(saveId, sha)
    if (existing) {
      this.store.addLocator(existing.recordingRevisionId, file, now)
      // Re-ingesting is idempotent for the catalog, and also repairs a missing or stale derived aggregate (formula or dictionary change).
      await this.ensureAggregate(existing.recordingRevisionId)
      return { file, status: 'already_ingested', sha256: sha, matchId: existing.matchId, recordingRevisionId: existing.recordingRevisionId, warnings: [] }
    }

    const decoded = await this.decoder.decode(bytes, { fileName: file, limits: { maxFileBytes: this.config.maxFileBytes } })
    const rec = decoded.recording

    if (!this.store.hasSnapshotHash(sha) && this.store.snapshotBytesTotal() + bytes.byteLength > this.config.storageLimitBytes) {
      throw new DomainError('storage_limit_exceeded', 'Storage limit would be exceeded; nothing was ingested', {
        limit: this.config.storageLimitBytes, used: this.store.snapshotBytesTotal(), needed: bytes.byteLength,
      })
    }
    const known = this.store.findMatchByUpstreamId(saveId, rec.source.upstreamMatchId)
    const continuation = known ? await this.evaluateContinuation(known, bytes, rec) : undefined
    const rel = this.snapshots.put(this.config.home, sha, bytes)
    const fields = this.matchFields(rec, save.seasonStart)
    const res = this.store.insertIngest({
      saveId,
      revision: {
        recordingRevisionId: '', parentRevisionId: null, archiveSha256: sha, sizeBytes: bytes.byteLength, snapshotPath: rel,
        sourceMatchId: rec.source.upstreamMatchId, format: rec.source.format, parserName: PARSER_NAME, parserVersion: PARSER_VERSION,
        processedAt: now, integrityStatus: rec.integrity.status, identityStatus: 'ok',
      },
      recording: rec, locator: file, matchDate: fields.matchDate, season: fields.season, competition: fields.competition,
      teams: fields.teams, projectionVersion: PROJECTION_VERSION,
      continuation: continuation?.insert,
      // Derived rows are committed atomically with the revision: the season aggregate and the player observations.
      derive: (ids) => ({
        aggregate: { key: aggregateKey(), json: JSON.stringify(buildMatchAggregate(this.analysisInput(decoded, { ...ids, saveId }))) },
        observations: observationsOf(ids.recordingRevisionId, rec),
      }),
    })
    rebuildPlayerIdentities(this.store, saveId, now)
    if (res.newMatch) this.adoptLiveNotes(saveId, rec.source.upstreamMatchId, res.matchId, res.recordingRevisionId, rec)
    return {
      file, status: res.identityStatus === 'identity_conflict' ? 'identity_conflict' : res.relation === 'continuation' ? 'continuation' : 'ingested', sha256: sha,
      matchId: res.matchId, recordingRevisionId: res.recordingRevisionId,
      integrity: rec.integrity.status, coverage: rec.coverage.status, completion: 'unknown',
      warnings: [
        ...rec.warnings,
        ...(rec.integrity.status !== 'valid' ? ['recovered_prefix: statistics cover the decoded prefix only'] : []),
        ...(res.identityStatus === 'identity_conflict' ? [`identity_conflict: same source match id as an existing recording, different bytes${continuation?.conflictReason ? ` (${continuation.conflictReason})` : ''}; excluded from default analysis until \`fmmi recording resolve\``] : []),
        ...(continuation?.warnings ?? []),
      ],
    }
  }

  /**
   * Slice 5, spec 6.2: a second recording of a known source identity extends the match only when the earlier SELECTED revision is a verified
   * prefix of it (same source match id, start time, initial metadata, metadata revisions and every earlier frame unchanged). A payload that
   * differs anywhere in the earlier prefix is a conflict and is never merged automatically; `fmmi recording resolve` makes the choice.
   */
  private async evaluateContinuation(known: MatchRow, bytes: Uint8Array, rec: NormalizedRecording): Promise<{ insert?: IngestInsert['continuation']; warnings: string[]; conflictReason?: string } | undefined> {
    const selected = this.store.getRevision(known.selectedRevisionId)
    if (!selected || selected.identityStatus === 'identity_conflict') return undefined
    let cmp: PrefixComparison
    try {
      cmp = await compareFramePrefix(this.snapshots.read(this.config.home, selected.snapshotPath), bytes, { maxFileBytes: this.config.maxFileBytes })
    } catch { return { warnings: [], conflictReason: 'prefix_comparison_failed' } }
    const evidence = { relation: cmp.relation, firstFrames: cmp.firstFrames, secondFrames: cmp.secondFrames, agreedFrames: cmp.agreedFrames }
    if (cmp.relation === 'conflict') return { warnings: [], conflictReason: cmp.reason ?? 'conflict' }
    if (cmp.relation === 'extends') {
      return { insert: { parentRevisionId: selected.recordingRevisionId, relation: 'continuation', evidence }, warnings: [`continuation: extends revision ${selected.recordingRevisionId} (${cmp.firstFrames} to ${cmp.secondFrames} frames, every earlier frame unchanged); it is now the selected revision, the earlier one stays inspectable and pinnable. Match confirmation belongs to a revision: confirm again if needed`] }
    }
    if (cmp.relation === 'prefix_of') {
      return { insert: { parentRevisionId: selected.recordingRevisionId, relation: 'prefix', evidence }, warnings: [`earlier_prefix: this recording is a verified prefix of the selected revision ${selected.recordingRevisionId} (${cmp.secondFrames} of ${cmp.firstFrames} frames); kept as evidence, not selected`] }
    }
    // Identical frames: prefer the better-closed container, otherwise keep it as non-selected evidence.
    const old = this.store.getProjection(selected.recordingRevisionId, PROJECTION_VERSION)
    const better = !!old && (old.integrity.status !== 'valid' || !old.integrity.cleanClose) && rec.integrity.status === 'valid' && rec.integrity.cleanClose
    return {
      insert: { parentRevisionId: selected.recordingRevisionId, relation: better ? 'continuation' : 'prefix', evidence },
      warnings: [better ? `continuation: same frames as revision ${selected.recordingRevisionId} but cleanly closed; it is now the selected revision` : `same_frames: identical frames to revision ${selected.recordingRevisionId}; kept as evidence, not selected`],
    }
  }

  /** A live note names its match by the source match id. When that match is imported into the same save it becomes a regular tactical note, once, audited. */
  private adoptLiveNotes(saveId: string, upstreamMatchId: string, matchId: string, revisionId: string, rec: NormalizedRecording) {
    const pending = this.store.listLiveNotes({ saveId, upstreamMatchId }).filter((n) => !n.adoption)
    for (const n of pending) {
      const at = new Date().toISOString()
      const row: TacticalNoteRow = {
        noteId: newId('n'), matchId, recordingRevisionId: revisionId, side: n.side, period: n.period, minute: n.displayMinute, setting: n.setting, priorValue: n.priorValue,
        newValue: n.newValue, comment: n.comment === null ? 'recorded live' : `recorded live: ${n.comment}`.slice(0, 500), confidence: 'manual', supersedesNoteId: null, createdAt: at,
      }
      this.store.transaction(() => {
        this.store.insertNote(row)
        this.store.adoptLiveNote({ noteId: n.noteId, tacticalNoteId: row.noteId, matchId, recordingRevisionId: revisionId, at })
        this.store.recordAudit('note.adopt_live', 'tactical_note', row.noteId, saveId, at, { liveNoteId: n.noteId, matchId, recordingRevisionId: revisionId, period: n.period, tick: n.tick, source: 'live_snapshot', recordedFrames: rec.frameCount })
      })
    }
  }

  private matchFields(rec: NormalizedRecording, seasonStart: string): MatchFields {
    return {
      teams: {
        home: { uid: rec.teams.home.uid, clubUid: rec.teams.home.clubUid, name: rec.teams.home.name },
        away: { uid: rec.teams.away.uid, clubUid: rec.teams.away.clubUid, name: rec.teams.away.name },
      },
      matchDate: rec.matchDate, season: seasonLabel(rec.matchDate, seasonStart), competition: rec.competition?.name ?? null,
    }
  }

  // ------------------------------------------------------------------ queries
  private requireMatch(matchId: string): MatchRow {
    const m = this.store.getMatch(matchId)
    if (!m) throw new DomainError('not_found', 'Match not found', { matchId })
    return m
  }

  private recordingOf(rev: RevisionRow): NormalizedRecording {
    const p = this.store.getProjection(rev.recordingRevisionId, PROJECTION_VERSION)
    if (!p) throw new DomainError('revision_unavailable', 'No projection for this revision at the current version', { recordingRevisionId: rev.recordingRevisionId })
    return p
  }

  private statusOf(rev: RevisionRow, rec: NormalizedRecording): { completion: MatchCompletion; result: ResultView } {
    const c = this.store.getConfirmation(rev.recordingRevisionId)
    const completion = applyConfirmation(baseCompletion(), c ? { home: c.home, away: c.away, confirmedAt: c.confirmedAt } : null, rec.observedScore)
    return { completion, result: deriveResult(rec.observedScore, completion) }
  }

  listMatches(saveId: string) {
    const save = this.requireSave(saveId)
    const rows = this.store.listMatches(saveId).map((m) => {
      const rev = this.store.getRevision(m.selectedRevisionId)!
      const rec = this.recordingOf(rev)
      const { completion, result } = this.statusOf(rev, rec)
      const revs = this.store.listRevisions(m.matchId)
      return {
        matchId: m.matchId, saveId, upstreamMatchId: m.upstreamMatchId, matchDate: m.matchDate, season: m.season, competition: m.competition,
        home: { teamId: m.homeTeamId, name: rec.teams.home.name }, away: { teamId: m.awayTeamId, name: rec.teams.away.name },
        managedSide: rec.humanControlledSide,
        result, selectedRecordingRevisionId: rev.recordingRevisionId,
        status: { integrity: rec.integrity.status, coverage: rec.coverage.status, completion: completion.status },
        format: rev.format,
        conflictingRevisions: revs.filter((r) => r.identityStatus === 'identity_conflict').length,
      }
    })
    return { saveId, saveName: save.displayName, matches: rows }
  }

  showMatch(matchId: string, opts: { revisionId?: string } = {}) {
    const m = this.requireMatch(matchId)
    const save = this.requireSave(m.saveId)
    const revs = this.store.listRevisions(matchId)
    const rev = opts.revisionId ? revs.find((r) => r.recordingRevisionId === opts.revisionId) : this.store.getRevision(m.selectedRevisionId)
    if (!rev) throw new DomainError('revision_unavailable', 'Requested revision does not belong to this match', { recordingRevisionId: opts.revisionId })
    const rec = this.recordingOf(rev)
    const { completion, result } = this.statusOf(rev, rec)
    const total = rec.teamTotals
    const possessionSum = (total.home.possessionTime ?? 0) + (total.away.possessionTime ?? 0)
    const warnings = [...rec.warnings]
    if (completion.manualFinalScore?.differsFromObserved) warnings.push('manual_final_score_differs_from_observed: observed counters are unchanged')
    if (rev.identityStatus === 'identity_conflict') warnings.push('identity_conflict: this revision is excluded from default analysis')
    return {
      schemaVersion: rec.schemaVersion,
      matchId, saveId: m.saveId, saveName: save.displayName, upstreamMatchId: m.upstreamMatchId, season: m.season, matchDate: m.matchDate,
      competition: m.competition,
      home: { teamId: m.homeTeamId, name: rec.teams.home.name, uid: rec.teams.home.uid },
      away: { teamId: m.awayTeamId, name: rec.teams.away.name, uid: rec.teams.away.uid },
      managedSide: rec.humanControlledSide,
      result,
      recording: {
        recordingRevisionId: rev.recordingRevisionId, selected: rev.recordingRevisionId === m.selectedRevisionId, identityStatus: rev.identityStatus,
        archiveSha256: rev.archiveSha256, sizeBytes: rev.sizeBytes, format: rev.format, sourceMatchId: rev.sourceMatchId,
        sourceLocators: this.store.listLocators(rev.recordingRevisionId), processedAt: rev.processedAt,
        parser: { name: rev.parserName, version: rev.parserVersion },
        frames: rec.frameCount, firstBoundary: rec.firstBoundary, lastBoundary: rec.lastBoundary,
      },
      status: { integrity: rec.integrity, coverage: rec.coverage, completion },
      teamTotals: rec.teamTotals,
      derived: {
        possessionPct: possessionSum > 0
          ? { home: (100 * total.home.possessionTime!) / possessionSum, away: (100 * total.away.possessionTime!) / possessionSum,
              derivation: 'ratio_of_possession_time_counters', unitVerified: false }
          : { home: null, away: null, reason: 'zero_denominator' },
      },
      roster: rec.roster.map((p) => this.participantView(rev.recordingRevisionId, p)),
      substitutions: rec.substitutionBatches.map((b) => ({
        side: b.side, period: b.period, tick: b.tick,
        off: b.off.map((id) => this.pid(rev.recordingRevisionId, id)), on: b.on.map((id) => this.pid(rev.recordingRevisionId, id)), pairing: b.pairing,
      })),
      events: rec.eventSummary,
      revisions: revs.map((r) => ({ recordingRevisionId: r.recordingRevisionId, identityStatus: r.identityStatus, archiveSha256: r.archiveSha256, selected: r.recordingRevisionId === m.selectedRevisionId, processedAt: r.processedAt })),
      unavailable: UNAVAILABLE,
      warnings,
    }
  }

  private pid(revId: string, upstreamId: number): string { return playerIdFor(revId, upstreamId) }
  private participantView(revId: string, p: Participant) {
    return {
      playerId: this.pid(revId, p.upstreamPlayerId),
      identity: 'match_local' as const,
      upstream: { playerId: p.upstreamPlayerId, uid: p.uid, slot: p.slot },
      side: p.side, name: p.name, shirtNumber: p.shirtNumber, position: p.position,
      participation: p.participation, roleTimeline: p.roleTimeline, nativeRating: p.nativeRating, counters: p.counters,
    }
  }

  /**
   * Loads one revision for analysis: the retained snapshot is decoded again (events and counter series are not stored
   * in SQLite). Follows the same revision rules as `showMatch`; never substitutes another revision.
   */
  async loadForAnalysis(matchId: string, opts: { revisionId?: string; cache?: DecodedCache } = {}) {
    const m = this.requireMatch(matchId)
    const revs = this.store.listRevisions(matchId)
    const rev = opts.revisionId ? revs.find((r) => r.recordingRevisionId === opts.revisionId) : this.store.getRevision(m.selectedRevisionId)
    if (!rev) throw new DomainError('revision_unavailable', 'Requested revision does not belong to this match', { recordingRevisionId: opts.revisionId })
    const unavailable = (message: string) => new DomainError('revision_unavailable', message, { recordingRevisionId: rev.recordingRevisionId })
    const decodeSnapshot = async (): Promise<DecodedRecording> => {
      let bytes: Buffer
      try { bytes = this.snapshots.read(this.config.home, rev.snapshotPath) } catch { throw unavailable('The retained snapshot for this revision cannot be read') }
      if (sha256Hex(bytes) !== rev.archiveSha256) throw unavailable('The retained snapshot does not match its recorded hash')
      return this.decoder.decode(bytes, { fileName: 'snapshot.fmlens', limits: { maxFileBytes: this.config.maxFileBytes } })
    }
    let decoded: DecodedRecording
    if (opts.cache) {
      // Decoded content is immutable per (revision, archive hash, parser version); catalog state that can change
      // (confirmation, identity status, save assignment) is re-read below on every call and never cached.
      const key = `${rev.recordingRevisionId}:${rev.archiveSha256}:${PARSER_VERSION}`
      // A hit must still be servable: the retained snapshot has to exist at the recorded size.
      if (!this.snapshots.hasSize(this.config.home, rev.snapshotPath, rev.sizeBytes)) { opts.cache.drop(key); throw unavailable('The retained snapshot for this revision cannot be read') }
      decoded = await opts.cache.getOrLoad(key, rev.sizeBytes, decodeSnapshot)
    } else decoded = await decodeSnapshot()
    const { completion, result } = this.statusOf(rev, decoded.recording)
    const warnings: string[] = []
    if (completion.manualFinalScore?.differsFromObserved) warnings.push('manual_final_score_differs_from_observed: observed counters are unchanged')
    if (rev.identityStatus === 'identity_conflict') warnings.push('identity_conflict: this revision is excluded from default analysis')
    return {
      decoded, completion, result, warnings,
      ids: {
        matchId, saveId: m.saveId, recordingRevisionId: rev.recordingRevisionId, teamIds: { home: m.homeTeamId, away: m.awayTeamId } as { home: string; away: string },
        playerIds: new Map(decoded.recording.roster.map((p) => [p.upstreamPlayerId, playerIdFor(rev.recordingRevisionId, p.upstreamPlayerId)] as const)),
      },
    }
  }

  // ------------------------------------------------------------------ corrections
  confirmMatch(matchId: string, scoreText: string, opts: { allowScoreChange?: boolean } = {}) {
    const m = this.requireMatch(matchId)
    const rev = this.store.getRevision(m.selectedRevisionId)!
    const score = parseScore(scoreText)
    if (!score) throw new DomainError('invalid_input', 'Score must look like <home>-<away>, for example 0-3', { reason: 'score_format' })
    const rec = this.recordingOf(rev)
    const obs = rec.observedScore
    const differs = score.home !== obs.home || score.away !== obs.away
    if (differs && !opts.allowScoreChange) {
      throw new DomainError('invalid_input', 'Score differs from the last observed score; pass --allow-score-change to store it as a manual final score', {
        reason: 'score_mismatch', observed: { home: obs.home, away: obs.away }, given: score,
      })
    }
    const at = new Date().toISOString()
    this.store.confirmRevision(
      { recordingRevisionId: rev.recordingRevisionId, home: score.home, away: score.away, confirmedAt: at, differsFromObserved: differs },
      { details: { score, observed: { home: obs.home, away: obs.away }, differsFromObserved: differs, allowScoreChange: !!opts.allowScoreChange, coverageAtConfirmation: rec.coverage.status } },
    )
    const { completion, result } = this.statusOf(rev, rec)
    return {
      matchId, recordingRevisionId: rev.recordingRevisionId, completion, result,
      coverage: rec.coverage,
      warnings: differs ? ['manual_final_score_differs_from_observed: goals after the last observed frame are unseen; observed counters are unchanged'] : [],
    }
  }

  moveMatch(matchId: string, toSaveId: string) {
    const at = new Date().toISOString()
    const r = this.store.moveMatch(matchId, toSaveId, at)
    // Save-scoped player identities of both saves are rebuilt; a manual link that depended on the moved recording is dropped.
    rebuildPlayerIdentities(this.store, r.fromSaveId, at)
    rebuildPlayerIdentities(this.store, toSaveId, at)
    return { matchId, fromSaveId: r.fromSaveId, toSaveId, revisionsMoved: r.revisions }
  }

  resolveRecording(revisionId: string, as: 'separate-occurrence' | 'ignored') {
    const rev = this.store.getRevision(revisionId)
    if (!rev) throw new DomainError('not_found', 'Recording revision not found', { recordingRevisionId: revisionId })
    const save = this.requireSave(rev.saveId)
    const rec = this.recordingOf(rev)
    const at = new Date().toISOString()
    const kind = as === 'ignored' ? 'ignored' : 'separate_occurrence'
    const r = this.store.resolveRevision(revisionId, kind, at, this.matchFields(rec, save.seasonStart))
    rebuildPlayerIdentities(this.store, rev.saveId, at)
    return { recordingRevisionId: revisionId, resolution: kind, matchId: r.matchId, previousMatchId: r.previousMatchId, previousSelectedRevisionId: null as string | null, parentRevisionId: null as string | null, warnings: [] as string[] }
  }

  /** Slice 5: the continuation and alternate-recording choices of `fmmi recording resolve`. A continuation is verified from the frames; an alternate is the user's call. */
  async chooseRecording(revisionId: string, as: 'continuation' | 'alternate') {
    const rev = this.store.getRevision(revisionId)
    if (!rev) throw new DomainError('not_found', 'Recording revision not found', { recordingRevisionId: revisionId })
    this.requireSave(rev.saveId)
    const at = new Date().toISOString()
    if (rev.identityStatus !== 'identity_conflict') throw new DomainError('invalid_input', 'Only a recording marked identity_conflict can be resolved', { identityStatus: rev.identityStatus })
    const m = this.requireMatch(rev.matchId)
    const selected = this.store.getRevision(m.selectedRevisionId)!
    let evidence: Record<string, unknown> = { choice: as }
    if (as === 'continuation') {
      // A continuation is verified, never taken on trust: the earlier selected revision must be an unchanged prefix of this recording.
      const cmp = await compareFramePrefix(this.snapshots.read(this.config.home, selected.snapshotPath), this.snapshots.read(this.config.home, rev.snapshotPath), { maxFileBytes: this.config.maxFileBytes })
      if (cmp.relation !== 'extends' && cmp.relation !== 'same_frames') {
        throw new DomainError('identity_conflict', 'This recording is not a verified continuation of the selected revision; use --as alternate to choose it, or separate-occurrence / ignored', {
          reason: 'not_a_verified_prefix', relation: cmp.relation, conflict: cmp.reason, agreedFrames: cmp.agreedFrames, selectedFrames: cmp.firstFrames, thisFrames: cmp.secondFrames, firstDivergence: cmp.firstDivergence,
        })
      }
      evidence = { ...evidence, relation: cmp.relation, firstFrames: cmp.firstFrames, secondFrames: cmp.secondFrames, agreedFrames: cmp.agreedFrames }
    }
    const r = this.store.chooseRevision(revisionId, as, at, evidence)
    rebuildPlayerIdentities(this.store, rev.saveId, at)
    await this.ensureAggregate(revisionId)
    return {
      recordingRevisionId: revisionId, resolution: as, matchId: r.matchId, previousMatchId: r.matchId, previousSelectedRevisionId: r.previousSelectedRevisionId, parentRevisionId: r.parentRevisionId,
      warnings: [`${as}: revision ${revisionId} is now the selected revision of match ${r.matchId}; ${r.previousSelectedRevisionId} stays inspectable and can still be pinned. Match confirmation and tactical notes belong to the revision they were made on: check them again`],
    }
  }

  // ------------------------------------------------------------------ Slice 4: cached versioned aggregates
  private readonly aggregateMemo = new Map<string, MatchAggregate>()

  private analysisInput(decoded: DecodedRecording, ids: { matchId: string; saveId: string; recordingRevisionId: string; teamIds: { home: string; away: string } }): AnalysisInput {
    const completion = baseCompletion()
    return {
      decoded, completion, result: deriveResult(decoded.recording.observedScore, completion),
      ids: { ...ids, playerIds: new Map(decoded.recording.roster.map((p) => [p.upstreamPlayerId, playerIdFor(ids.recordingRevisionId, p.upstreamPlayerId)] as const)) },
    }
  }

  /**
   * The season aggregate of one revision for the CURRENT definition key. Served from the catalog when a row exists under that key
   * (a row under any other key is stale and never read). Otherwise it is rebuilt from the retained snapshot: stored when the catalog
   * is writable, kept in this process only when it is read-only (the MCP server never writes).
   */
  async ensureAggregate(revisionId: string, opts: { cache?: DecodedCache } = {}): Promise<{ aggregate: MatchAggregate; origin: 'catalog' | 'memo' | 'built_and_stored' | 'built_in_memory' }> {
    const key = aggregateKey()
    const stored = this.store.getAggregate(revisionId, key)
    if (stored) return { aggregate: JSON.parse(stored) as MatchAggregate, origin: 'catalog' }
    const memoKey = `${revisionId}|${key}`
    const hit = this.aggregateMemo.get(memoKey)
    if (hit) return { aggregate: hit, origin: 'memo' }
    const rev = this.store.getRevision(revisionId)
    if (!rev) throw new DomainError('not_found', 'Recording revision not found', { recordingRevisionId: revisionId })
    const l = await this.loadForAnalysis(rev.matchId, { revisionId, cache: opts.cache })
    const aggregate = buildMatchAggregate(this.analysisInput(l.decoded, l.ids))
    if (this.config.readOnly) { this.aggregateMemo.set(memoKey, aggregate); return { aggregate, origin: 'built_in_memory' } }
    this.store.putAggregate(revisionId, key, JSON.stringify(aggregate), new Date().toISOString())
    return { aggregate, origin: 'built_and_stored' }
  }

  /** Rebuilds every missing or stale aggregate of the selected revisions (one save, or all). Idempotent. */
  async rebuildAggregates(saveId?: string): Promise<{ key: string; revisions: number; rebuilt: number; alreadyCurrent: number }> {
    if (saveId !== undefined) this.requireSave(saveId)
    if (this.config.readOnly) throw new DomainError('invalid_input', 'The catalog is read-only', { reason: 'read_only' })
    const key = aggregateKey()
    let rebuilt = 0, current = 0, total = 0
    for (const s of saveId ? [this.requireSave(saveId)] : this.store.listSaves()) {
      for (const m of this.store.listMatches(s.saveId)) {
        total++
        if (this.store.getAggregate(m.selectedRevisionId, key)) { current++; continue }
        await this.ensureAggregate(m.selectedRevisionId)
        rebuilt++
      }
    }
    return { key, revisions: total, rebuilt, alreadyCurrent: current }
  }

  // ------------------------------------------------------------------ Slice 4: save-scoped player identity
  listPlayerCatalog(saveId: string) { this.requireSave(saveId); return playerCatalog(this.store, saveId) }
  linkPlayers(saveId: string, ids: string[], opts: { name?: string } = {}) { this.requireSave(saveId); return linkPlayers(this.store, saveId, ids, new Date().toISOString(), opts) }
  unlinkPlayer(saveId: string, localPlayerId: string) { this.requireSave(saveId); return unlinkPlayer(this.store, saveId, localPlayerId, new Date().toISOString()) }
  rebuildIdentities(saveId: string) { this.requireSave(saveId); rebuildPlayerIdentities(this.store, saveId, new Date().toISOString()) }

  // ------------------------------------------------------------------ Slice 4: tactical notes (immutable, local CLI only)
  private noteText(v: string, what: string, max: number): string {
    const t = boundName(v, max + 1).trim()
    if (!t) throw new DomainError('invalid_input', `${what} must not be empty`, { reason: 'note_field', field: what })
    if (t.length > max) throw new DomainError('invalid_input', `${what} must be at most ${max} characters`, { reason: 'note_field', field: what })
    return t
  }

  async addNote(matchId: string, input: { minute: number; period?: number; side?: Side; setting: string; priorValue: string; newValue: string; comment?: string }) {
    const m = this.requireMatch(matchId)
    const rev = this.store.getRevision(m.selectedRevisionId)!
    const row = await this.noteRow(matchId, rev, input, null)
    this.store.transaction(() => {
      this.store.insertNote(row)
      this.store.recordAudit('note.add', 'tactical_note', row.noteId, m.saveId, row.createdAt, { matchId, recordingRevisionId: rev.recordingRevisionId, side: row.side, minute: row.minute, period: row.period, setting: row.setting, confidence: 'manual' })
    })
    return row
  }

  private async noteRow(matchId: string, rev: RevisionRow, input: { minute: number; period?: number; side?: Side; setting: string; priorValue: string; newValue: string; comment?: string }, supersedes: string | null): Promise<TacticalNoteRow> {
    if (!(Number.isFinite(input.minute) && input.minute >= 0)) throw new DomainError('invalid_input', 'Minute must be a non-negative number', { reason: 'negative' })
    const l = await this.loadForAnalysis(matchId, { revisionId: rev.recordingRevisionId })
    const side = input.side ?? l.decoded.recording.humanControlledSide
    if (!side) throw new DomainError('ambiguous_selection', 'The recording does not say which side is human-managed; pass --side home|away or --team', { reason: 'side_required' })
    // The minute is validated against the recording: an ambiguous stoppage-time label needs a period, an out-of-range one is refused.
    const b = resolveDisplayMinute(l.decoded.sampled.frames, input.minute, input.period)
    return {
      noteId: newId('n'), matchId, recordingRevisionId: rev.recordingRevisionId, side, period: b.period, minute: input.minute,
      setting: this.noteText(input.setting, 'setting', 120), priorValue: this.noteText(input.priorValue, 'prior value', 120), newValue: this.noteText(input.newValue, 'new value', 120),
      comment: input.comment === undefined ? null : this.noteText(input.comment, 'comment', 500), confidence: 'manual', supersedesNoteId: supersedes, createdAt: new Date().toISOString(),
    }
  }

  /** Notes are never edited. A correction is a new note that supersedes the old one; both stay in the audit trail. */
  async supersedeNote(noteId: string, changes: { minute?: number; period?: number; side?: Side; setting?: string; priorValue?: string; newValue?: string; comment?: string }) {
    const prev = this.store.getNote(noteId)
    if (!prev) throw new DomainError('not_found', 'Tactical note not found', { noteId })
    const by = this.store.supersedingNoteOf(noteId)
    if (by) throw new DomainError('invalid_input', 'This note is already superseded; supersede its latest version', { reason: 'already_superseded', supersededBy: by })
    const changed = Object.entries(changes).filter(([, v]) => v !== undefined).map(([k]) => k)
    if (changed.length === 0) throw new DomainError('invalid_input', 'Give at least one field to correct', { reason: 'usage' })
    const m = this.requireMatch(prev.matchId)
    const rev = this.store.getRevision(m.selectedRevisionId)!
    const row = await this.noteRow(prev.matchId, rev, {
      minute: changes.minute ?? prev.minute, period: changes.period ?? (changes.minute !== undefined ? undefined : (prev.period ?? undefined)), side: changes.side ?? prev.side,
      setting: changes.setting ?? prev.setting, priorValue: changes.priorValue ?? prev.priorValue, newValue: changes.newValue ?? prev.newValue,
      comment: changes.comment ?? prev.comment ?? undefined,
    }, noteId)
    this.store.transaction(() => {
      this.store.insertNote(row)
      this.store.recordAudit('note.supersede', 'tactical_note', row.noteId, m.saveId, row.createdAt, { supersedes: noteId, changedFields: changed, matchId: prev.matchId })
    })
    return row
  }

  // ------------------------------------------------------------------ Slice 5: live tactical notes (immutable, local CLI only)
  /**
   * A tactical change made during a live match, pinned to an explicit live snapshot boundary the caller read from the plugin (period, tick and
   * the display minute of that frame). The match is named by its source id because it is not in the catalog yet; when the finished recording
   * is imported into the same save the note is adopted as a regular tactical note. Like every note it is manual and immutable.
   */
  addLiveNote(saveId: string, input: { upstreamMatchId: string; side: Side; period: number; tick: number; displayMinute: number; snapshotTick: number; boundarySource: 'live_snapshot_end' | 'explicit'; setting: string; priorValue: string; newValue: string; comment?: string }): LiveNoteRow {
    this.requireSave(saveId)
    if (!(Number.isFinite(input.displayMinute) && input.displayMinute >= 0) || !Number.isInteger(input.tick) || input.tick < 0 || !Number.isInteger(input.period) || input.period < 1) {
      throw new DomainError('invalid_input', 'The live snapshot boundary is not valid', { reason: 'live_boundary' })
    }
    const row: LiveNoteRow = {
      noteId: newId('ln'), saveId, upstreamMatchId: boundName(input.upstreamMatchId, 120), side: input.side, period: input.period, tick: input.tick, displayMinute: input.displayMinute,
      setting: this.noteText(input.setting, 'setting', 120), priorValue: this.noteText(input.priorValue, 'prior value', 120), newValue: this.noteText(input.newValue, 'new value', 120),
      comment: input.comment === undefined ? null : this.noteText(input.comment, 'comment', 500), confidence: 'manual', boundarySource: input.boundarySource, snapshotTick: input.snapshotTick,
      supersedesNoteId: null, createdAt: new Date().toISOString(),
    }
    this.store.transaction(() => {
      this.store.insertLiveNote(row)
      this.store.recordAudit('note.add_live', 'live_note', row.noteId, saveId, row.createdAt, { upstreamMatchId: row.upstreamMatchId, side: row.side, period: row.period, tick: row.tick, displayMinute: row.displayMinute, boundarySource: row.boundarySource, snapshotTick: row.snapshotTick, confidence: 'manual' })
    })
    // The match may already be in the catalog (for example a continuation was imported first): attach at once.
    const known = this.store.findMatchByUpstreamId(saveId, row.upstreamMatchId)
    if (known) {
      const rev = this.store.getRevision(known.selectedRevisionId)!
      const rec = this.recordingOf(rev)
      this.adoptLiveNotes(saveId, row.upstreamMatchId, known.matchId, rev.recordingRevisionId, rec)
    }
    return row
  }
  getLiveNote(noteId: string) { return this.store.getLiveNote(noteId) }
  listLiveNotes(filter: { saveId?: string; upstreamMatchId?: string } = {}) { return this.store.listLiveNotes(filter) }

  // ------------------------------------------------------------------ Slice 4: club aliases and the managed team
  /** Resolves a team id, a club alias or an exact team name inside one save. A name shared by two teams is `ambiguous_selection`. */
  resolveTeamRef(saveId: string, ref: string) {
    this.requireSave(saveId)
    const teams = this.store.listTeams(saveId)
    const byId = teams.find((t) => t.teamId === ref)
    if (byId) return byId
    const key = nameKey(ref)
    const alias = this.store.listAliases(saveId).find((a) => a.aliasKey === key)
    if (alias) return teams.find((t) => t.teamId === alias.teamId)!
    const named = teams.filter((t) => nameKey(t.name) === key)
    if (named.length === 1) return named[0]!
    if (named.length > 1) throw new DomainError('ambiguous_selection', 'More than one team has this name in the save; use a team id', { reason: 'team_name_ambiguous', teamIds: named.map((t) => t.teamId) })
    throw new DomainError('not_found', 'No team, alias or team name matches in this save', { reason: 'team_ref', ref: boundName(ref, 80) })
  }

  addClubAlias(saveId: string, teamRef: string, alias: string) {
    const team = this.resolveTeamRef(saveId, teamRef)
    const text = boundName(alias, 81).trim()
    if (!text || text.length > 80) throw new DomainError('invalid_input', 'An alias must be 1-80 characters', { reason: 'alias' })
    const key = nameKey(text)
    const clash = this.store.listTeams(saveId).find((t) => nameKey(t.name) === key && t.teamId !== team.teamId)
    if (clash) throw new DomainError('identity_conflict', 'The alias is the name of another team in this save', { reason: 'alias_is_other_team', teamId: clash.teamId })
    const existing = this.store.listAliases(saveId).find((a) => a.aliasKey === key)
    if (existing && existing.teamId !== team.teamId) throw new DomainError('identity_conflict', 'The alias already points at another team', { reason: 'alias_taken', teamId: existing.teamId })
    if (existing) return { saveId, teamId: team.teamId, alias: existing.alias, created: false }
    const at = new Date().toISOString()
    this.store.transaction(() => {
      this.store.addAlias({ saveId, teamId: team.teamId, alias: text, aliasKey: key, createdAt: at })
      this.store.recordAudit('club.alias.add', 'team', team.teamId, saveId, at, { alias: text })
    })
    return { saveId, teamId: team.teamId, alias: text, created: true }
  }
  removeClubAlias(saveId: string, alias: string) {
    this.requireSave(saveId)
    const key = nameKey(alias)
    const existing = this.store.listAliases(saveId).find((a) => a.aliasKey === key)
    if (!existing) throw new DomainError('not_found', 'No such alias in this save', { reason: 'alias' })
    this.store.transaction(() => {
      this.store.removeAlias(saveId, key)
      this.store.recordAudit('club.alias.remove', 'team', existing.teamId, saveId, new Date().toISOString(), { alias: existing.alias })
    })
    return { saveId, teamId: existing.teamId, alias: existing.alias, removed: true }
  }
  listClubAliases(saveId: string) {
    this.requireSave(saveId)
    const names = new Map(this.store.listTeams(saveId).map((t) => [t.teamId, t.name]))
    return this.store.listAliases(saveId).map((a) => ({ teamId: a.teamId, teamName: names.get(a.teamId) ?? '', alias: a.alias }))
  }

  /**
   * Assisted detection of the human-managed team. It only SUGGESTS: the recording's human-manager flag is tallied per team across
   * the save. Which save a match belongs to is never inferred; that stays the explicit `--save` assignment. Applying a suggestion
   * is a separate, audited step and never replaces an explicit assignment.
   */
  detectManagedTeam(saveId: string) {
    this.requireSave(saveId)
    const matches = this.listMatches(saveId).matches
    const tally = new Map<string, { teamId: string; name: string; matches: number; humanControlledMatches: number }>()
    for (const m of matches) {
      for (const side of ['home', 'away'] as const) {
        const t = m[side]
        const e = tally.get(t.teamId) ?? { teamId: t.teamId, name: t.name, matches: 0, humanControlledMatches: 0 }
        e.matches++
        if (m.managedSide === side) e.humanControlledMatches++
        tally.set(t.teamId, e)
      }
    }
    const candidates = [...tally.values()].filter((c) => c.humanControlledMatches > 0).sort((a, b) => b.humanControlledMatches - a.humanControlledMatches)
    const current = this.store.getManagedTeam(saveId)
    let suggestion: { teamId: string; name: string; evidence: string } | null = null
    let reason: string | null = null
    if (candidates.length === 1) {
      const c = candidates[0]!
      suggestion = { teamId: c.teamId, name: c.name, evidence: `human_manager_flag_in_${c.humanControlledMatches}_of_${c.matches}_appearances` }
    } else reason = candidates.length === 0 ? 'no_human_manager_flag_recorded' : 'more_than_one_team_was_human_managed'
    return { saveId, matches: matches.length, candidates, suggestion, reason, current: current ? { teamId: current.teamId, source: current.source } : null }
  }

  getManagedTeam(saveId: string) {
    this.requireSave(saveId)
    const r = this.store.getManagedTeam(saveId)
    return r ? { teamId: r.teamId, source: r.source } : null
  }

  setManagedTeam(saveId: string, teamRef: string) {
    const team = this.resolveTeamRef(saveId, teamRef)
    const previous = this.store.getManagedTeam(saveId)
    this.store.transaction(() => {
      this.store.setManagedTeam(saveId, team.teamId, 'explicit')
      this.store.recordAudit('save.managed_team.set', 'save', saveId, saveId, new Date().toISOString(), { teamId: team.teamId, source: 'explicit', previous })
    })
    return { saveId, teamId: team.teamId, name: team.name, source: 'explicit' as const }
  }

  applyDetectedManagedTeam(saveId: string) {
    const d = this.detectManagedTeam(saveId)
    if (d.current?.source === 'explicit') throw new DomainError('invalid_input', 'An explicit managed team is already set; clear it before applying a detected one', { reason: 'explicit_assignment_exists', teamId: d.current.teamId })
    if (!d.suggestion) throw new DomainError('insufficient_coverage', 'Nothing to apply: detection found no single human-managed team', { reason: d.reason ?? 'no_suggestion' })
    this.store.transaction(() => {
      this.store.setManagedTeam(saveId, d.suggestion!.teamId, 'assisted')
      this.store.recordAudit('save.managed_team.assisted', 'save', saveId, saveId, new Date().toISOString(), { teamId: d.suggestion!.teamId, evidence: d.suggestion!.evidence, previous: d.current })
    })
    return { saveId, teamId: d.suggestion.teamId, name: d.suggestion.name, source: 'assisted' as const, evidence: d.suggestion.evidence }
  }

  clearManagedTeam(saveId: string) {
    this.requireSave(saveId)
    const previous = this.store.getManagedTeam(saveId)
    this.store.transaction(() => {
      this.store.setManagedTeam(saveId, null, null)
      this.store.recordAudit('save.managed_team.clear', 'save', saveId, saveId, new Date().toISOString(), { previous })
    })
    return { saveId, cleared: previous !== null }
  }

  // ------------------------------------------------------------------ doctor
  async doctor() {
    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = []
    const add = (name: string, status: 'ok' | 'warn' | 'fail', detail: string) => checks.push({ name, status, detail })
    const major = Number(process.versions.node.split('.')[0])
    const minor = Number(process.versions.node.split('.')[1])
    add('node', major > 22 || (major === 22 && minor >= 18) ? 'ok' : 'fail', `Node ${process.versions.node} (need >= 22.18)`)
    add('decompression', typeof DecompressionStream === 'function' ? 'ok' : 'fail', 'DecompressionStream("deflate") ' + (typeof DecompressionStream === 'function' ? 'available' : 'missing'))
    add('sqlite_driver', 'ok', `${this.store.driver}, schema v${this.store.schemaVersion()}`)
    try {
      const probe = join(this.config.home, `.doctor-${process.pid}.tmp`)
      writeFileSync(probe, 'x'); rmSync(probe)
      accessSync(this.config.home, constants.W_OK)
      add('store_home', 'ok', 'writable')
    } catch { add('store_home', 'fail', 'store home is not writable') }
    const dir = this.config.archiveDir
    if (!dir) add('archive_dir', 'warn', 'not configured (needed only for `ingest --new`)')
    else if (!existsSync(dir)) add('archive_dir', 'warn', 'configured directory does not exist')
    else add('archive_dir', 'ok', `${this.listArchiveFiles(dir).length} .fmlens file(s)`)
    const used = this.store.snapshotBytesTotal()
    add('storage', used <= this.config.storageLimitBytes ? 'ok' : 'warn', `${used} of ${this.config.storageLimitBytes} bytes used`)
    add('format', 'ok', `archive format ${SUPPORTED_FORMAT} only`)
    return { ok: checks.every((c) => c.status !== 'fail'), version: '0.1.0', checks }
  }

  snapshotPath(rev: RevisionRow): string { return resolve(this.config.home, ...rev.snapshotPath.split('/')) }
}

const UNAVAILABLE = [
  { metric: 'final_score', reason: 'unverified_semantics', note: 'No source full-time signal; observed score only until `fmmi match confirm`.' },
  { metric: 'incomplete_pass_receiver', reason: 'not_recorded', note: 'Audited recording: 0 of 145 incomplete passes carry a receiver.' },
  { metric: 'ground_pass_classification', reason: 'not_recorded', note: 'No ground/air field in the event schema.' },
  { metric: 'progressive_pass_event_classification', reason: 'unverified_semantics', note: 'Only cumulative counters exist; no per-event rule.' },
  { metric: 'persistent_player_identity', reason: 'unverified_semantics', note: 'Ids are match-local. A save-scoped persistent player (pe_...) exists only where the same positive uid and name appear in two or more matches of the save, or after `fmmi player link`; a name alone never merges.' },
] as const
