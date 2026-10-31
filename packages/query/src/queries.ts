import { DomainError, SCHEMA_VERSION } from '@fmmi/model'
import {
  METRIC_DICTIONARY_VERSION, parseBoundary, resolveWindowOptions, compareQuery, evidenceStatusQuery, networkQuery, playerQuery, reportQuery, scoreStateQuery, serviceQuery, summaryQuery, threatQuery,
} from '@fmmi/analytics'
import type { AnalysisInput, PassScope, WindowOptions, WindowSpec } from '@fmmi/analytics'
export { parseBoundary }
export type { WindowOptions }
import type { CatalogService } from '@fmmi/store'
import { DecodedRecordingCache } from './cache.ts'
import { HistoryQueries } from './history.ts'
import type { PlayerTrendOptions, SeasonTrendOptions } from './history.ts'

/**
 * Domain query layer: the one entry point the CLI and the MCP adapter both call. It resolves the match and
 * revision through the catalog, then hands normalised in-memory data to the pure analytics functions. Results are
 * schema-validated JSON with the section 6.4 envelope.
 */
export interface CommonOptions { recordingRevisionId?: string; window?: WindowOptions; scope?: PassScope }

const resolveSpec = resolveWindowOptions

export function parseScope(text: string | undefined): PassScope | undefined {
  if (text === undefined) return undefined
  if (text === 'counter_scope' || text === 'open_play' || text === 'all_passes') return text
  throw new DomainError('invalid_input', '--scope must be counter_scope, open_play or all_passes', { reason: 'usage', option: 'scope' })
}

// ------------------------------------------------------------------ listing

export const LIST_MAX_LIMIT = 50
export const LIST_DEFAULT_LIMIT = 20
export interface ListOptions { saveId?: string; teamId?: string; season?: string; limit?: number; cursor?: string }

interface CursorPayload { d: string | null; id: string; f: string }
const filterKey = (o: ListOptions) => JSON.stringify([o.saveId ?? null, o.teamId ?? null, o.season ?? null])
const encodeCursor = (c: CursorPayload) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
function decodeCursor(text: string, o: ListOptions): CursorPayload {
  const bad = () => new DomainError('invalid_input', 'The cursor is not valid for this query; start again without a cursor', { reason: 'cursor' })
  let c: CursorPayload
  try { c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as CursorPayload } catch { throw bad() }
  if (typeof c?.id !== 'string' || (c.d !== null && typeof c.d !== 'string') || c.f !== filterKey(o)) throw bad()
  return c
}
/** Newest first, undated matches last, ties by match id: a total order, so a keyset cursor is stable across imports. */
function afterCursor(m: { matchDate: string | null; matchId: string }, c: CursorPayload): boolean {
  if (m.matchDate !== c.d) {
    if (m.matchDate === null) return true
    if (c.d === null) return false
    return m.matchDate < c.d
  }
  return m.matchId > c.id
}
const byListOrder = (a: { matchDate: string | null; matchId: string }, b: { matchDate: string | null; matchId: string }) =>
  a.matchDate === b.matchDate ? (a.matchId < b.matchId ? -1 : 1) : a.matchDate === null ? 1 : b.matchDate === null ? -1 : a.matchDate < b.matchDate ? 1 : -1

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => { a[x] = (a[x] ?? 0) + 1; return a }, {})
const ATTENTION_LIMIT = 20

export class MatchQueries {
  private readonly svc: CatalogService
  readonly cache: DecodedRecordingCache
  /** Slice 4 season history (player catalog, trends, tactical notes). Shares this instance's bounded decode cache. */
  readonly history: HistoryQueries
  constructor(svc: CatalogService, cache: DecodedRecordingCache = new DecodedRecordingCache()) {
    this.svc = svc
    this.cache = cache
    this.history = new HistoryQueries(svc, this)
  }

  async load(matchId: string, o: CommonOptions): Promise<{ input: AnalysisInput; spec: WindowSpec }> {
    const l = await this.svc.loadForAnalysis(matchId, { revisionId: o.recordingRevisionId, cache: this.cache })
    const input: AnalysisInput = { decoded: l.decoded, ids: l.ids, completion: l.completion, result: l.result, warnings: l.warnings }
    return { input, spec: resolveSpec(input, o.window) }
  }

  // ---------------------------------------------------------------- catalog-level

  listMatches(o: ListOptions = {}) {
    const limit = o.limit ?? LIST_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) throw new DomainError('invalid_input', `limit must be an integer from 1 to ${LIST_MAX_LIMIT}`, { reason: 'limit' })
    const store = this.svc.store
    let saveName: string | null = null
    if (o.saveId !== undefined) {
      const s = store.getSave(o.saveId)
      if (!s) throw new DomainError('not_found', 'Save profile not found', { saveId: o.saveId })
      saveName = s.displayName
    }
    if (o.teamId !== undefined) {
      const t = store.getTeam(o.teamId)
      if (!t) throw new DomainError('not_found', 'Team not found', { teamId: o.teamId })
      if (o.saveId !== undefined && t.saveId !== o.saveId) throw new DomainError('not_found', 'Team does not belong to this save', { reason: 'not_in_save' })
    }
    const cursor = o.cursor !== undefined ? decodeCursor(o.cursor, o) : null
    const saves = o.saveId !== undefined ? [o.saveId] : store.listSaves().map((s) => s.saveId)
    const all = saves.flatMap((id) => this.svc.listMatches(id).matches)
      .filter((m) => (o.teamId === undefined || m.home.teamId === o.teamId || m.away.teamId === o.teamId) && (o.season === undefined || m.season === o.season))
      .sort(byListOrder)
    const rest = cursor ? all.filter((m) => afterCursor(m, cursor)) : all
    const page = rest.slice(0, limit)
    const last = page[page.length - 1]
    const next = rest.length > page.length && last ? encodeCursor({ d: last.matchDate, id: last.matchId, f: filterKey(o) }) : null
    return {
      schemaVersion: SCHEMA_VERSION, query: 'list' as const,
      saveId: o.saveId ?? null, saveName,
      filters: { saveId: o.saveId ?? null, teamId: o.teamId ?? null, season: o.season ?? null },
      page: { limit, returned: page.length, totalMatching: all.length, nextCursor: next, truncated: next !== null },
      matches: page.map((m) => {
        const managed = m.managedSide === null ? null : m[m.managedSide]
        const opp = m.managedSide === null ? null : m[m.managedSide === 'home' ? 'away' : 'home']
        return { ...m, managedTeamId: managed?.teamId ?? null, opponent: opp ? { teamId: opp.teamId, name: opp.name } : null }
      }),
    }
  }

  /** Bounded ingestion health for the whole catalog (no matchId), or the evidence status of one recording. */
  async recordingStatus(matchId?: string, o: Pick<CommonOptions, 'recordingRevisionId'> = {}) {
    if (matchId === undefined) {
      if (o.recordingRevisionId !== undefined) throw new DomainError('invalid_input', 'recordingRevisionId needs a matchId', { reason: 'revision_without_match' })
      return this.catalogHealth()
    }
    const show = this.svc.showMatch(matchId, { revisionId: o.recordingRevisionId })
    const { input } = await this.load(matchId, { recordingRevisionId: o.recordingRevisionId })
    const ev = evidenceStatusQuery(input)
    const missing = new Map<string, { metric: string; reason: string; note: string }>()
    for (const u of [...show.unavailable, ...ev.unavailable]) if (!missing.has(u.metric)) missing.set(u.metric, { metric: u.metric, reason: u.reason, note: u.note })
    const { sourceLocators, parser, frames, firstBoundary, lastBoundary } = show.recording
    return {
      schemaVersion: SCHEMA_VERSION, query: 'status' as const, scope: 'recording' as const,
      matchId, saveId: show.saveId, recordingRevisionId: show.recording.recordingRevisionId,
      selected: show.recording.selected,
      source: { kind: 'fmlens_archive' as const, format: show.recording.format, startTick: firstBoundary.tick, endTick: lastBoundary.tick, frames, parser, sizeBytes: show.recording.sizeBytes, archiveSha256: show.recording.archiveSha256, sourceLocators },
      metricDictionaryVersion: METRIC_DICTIONARY_VERSION,
      identity: {
        status: show.recording.identityStatus,
        conflictingRevisions: show.revisions.filter((r) => r.identityStatus === 'identity_conflict').map((r) => ({ recordingRevisionId: r.recordingRevisionId, archiveSha256: r.archiveSha256, processedAt: r.processedAt })),
      },
      status: show.status, result: show.result,
      observedIntervals: ev.observedIntervals,
      recipientDiagnostic: ev.recipientDiagnostic,
      missingMetrics: [...missing.values()],
      revisions: show.revisions,
      warnings: [...new Set([...show.warnings, ...input.warnings ?? []])],
    }
  }

  private catalogHealth() {
    const store = this.svc.store
    const attention: Array<{ matchId: string; saveId: string; reasons: string[] }> = []
    let matches = 0, conflicts = 0
    const saves = store.listSaves().map((s) => {
      const ms = this.svc.listMatches(s.saveId).matches
      matches += ms.length
      const c = ms.reduce((a, m) => a + m.conflictingRevisions, 0)
      conflicts += c
      for (const m of ms) {
        const reasons: string[] = []
        if (m.status.completion === 'unknown' || m.status.completion === 'in_progress') reasons.push(`completion_${m.status.completion}`)
        if (m.status.coverage !== 'full_match') reasons.push(`capture_${m.status.coverage}`)
        if (m.status.integrity !== 'valid') reasons.push(`integrity_${m.status.integrity}`)
        if (m.conflictingRevisions > 0) reasons.push('identity_conflict')
        if (reasons.length) attention.push({ matchId: m.matchId, saveId: s.saveId, reasons })
      }
      return {
        saveId: s.saveId, displayName: s.displayName, matches: ms.length, conflictingRevisions: c,
        completion: tally(ms.map((m) => m.status.completion)), captureCoverage: tally(ms.map((m) => m.status.coverage)), integrity: tally(ms.map((m) => m.status.integrity)),
      }
    })
    return {
      schemaVersion: SCHEMA_VERSION, query: 'status' as const, scope: 'catalog' as const,
      metricDictionaryVersion: METRIC_DICTIONARY_VERSION,
      totals: { saves: saves.length, matches, conflictingRevisions: conflicts },
      saves,
      attention: attention.slice(0, ATTENTION_LIMIT),
      attentionTotal: attention.length, attentionTruncated: attention.length > ATTENTION_LIMIT,
      storage: { snapshotBytes: store.snapshotBytesTotal(), limitBytes: this.svc.config.storageLimitBytes },
      warnings: matches === 0 ? ['no_matches_imported: import recordings with the fmmi CLI'] : [],
    }
  }

  // ---------------------------------------------------------------- match-scoped

  async summary(matchId: string, o: Pick<CommonOptions, 'recordingRevisionId'> & { teamId?: string } = {}) {
    const { input } = await this.load(matchId, o)
    return summaryQuery(input, { teamId: o.teamId })
  }
  async report(matchId: string, o: CommonOptions = {}) {
    const { input, spec } = await this.load(matchId, o)
    return reportQuery(input, { window: spec })
  }
  async player(matchId: string, playerId: string, o: CommonOptions = {}) {
    const { input, spec } = await this.load(matchId, o)
    return playerQuery(input, playerId, { window: spec, scope: o.scope })
  }
  async network(matchId: string, teamId: string, o: CommonOptions & { minPasses?: number; limit?: number } = {}) {
    const { input, spec } = await this.load(matchId, o)
    return networkQuery(input, teamId, { window: spec, scope: o.scope, minPasses: o.minPasses, limit: o.limit })
  }
  async threat(matchId: string, teamId: string, o: Pick<CommonOptions, 'recordingRevisionId' | 'window'> = {}) {
    const { input, spec } = await this.load(matchId, o)
    return threatQuery(input, teamId, { window: spec })
  }
  async scoreState(matchId: string, teamId: string, o: CommonOptions = {}) {
    const { input, spec } = await this.load(matchId, o)
    return scoreStateQuery(input, teamId, { window: spec })
  }
  async service(matchId: string, playerId: string, o: CommonOptions & { comparePlayerId?: string } = {}) {
    const { input, spec } = await this.load(matchId, o)
    return serviceQuery(input, playerId, { window: spec, scope: o.scope, comparePlayerId: o.comparePlayerId })
  }
  async compare(matchId: string, teamId: string, o: Pick<CommonOptions, 'recordingRevisionId' | 'scope'> & { windowA: WindowOptions; windowB: WindowOptions; playerIds?: string[] }) {
    const { input } = await this.load(matchId, o)
    return compareQuery(input, teamId, { windowA: resolveSpec(input, o.windowA), windowB: resolveSpec(input, o.windowB), playerIds: o.playerIds, scope: o.scope })
  }

  // ---------------------------------------------------------------- Slice 4 history (thin delegates; the CLI and MCP both call these)
  listPlayers(o: Parameters<HistoryQueries['listPlayers']>[0]) { return this.history.listPlayers(o) }
  seasonTrends(o: SeasonTrendOptions) { return this.history.seasonTrends(o) }
  playerTrends(o: PlayerTrendOptions) { return this.history.playerTrends(o) }
  tacticalNotes(o: Parameters<HistoryQueries['tacticalNotes']>[0]) { return this.history.tacticalNotes(o) }
  compareTacticalChange(o: Parameters<HistoryQueries['compareTacticalChange']>[0]) { return this.history.compareTacticalChange(o) }
}
