import { DomainError, applyConfirmation, baseCompletion, participationAt, resolveDisplayMinute } from '@fmmi/model'
import type { Boundary, Side } from '@fmmi/model'
import {
  DEFAULT_PLAYER_METRICS, DEFAULT_TEAM_METRICS, GATES, HISTORY_SCHEMA_VERSION, ListPlayersResultSchema, PLAYER_TREND_SPECS, PlayerTrendsResultSchema, SEASON_POLICY,
  SeasonTrendsResultSchema, TEAM_TREND_SPECS, TacticalChangeResultSchema, TacticalNotesResultSchema, acrossSide, byGameOrder, compactWithin, comparePlayerWindows, compareQuery,
  eligibilityOf, historySource, playerTrends, playerTrendsResult, seasonTrends, seasonTrendsResult, tacticalChangeResult, validateMetrics, validated,
} from '@fmmi/analytics'
import type { MatchAggregate, PlayerMatchInput, TrendMatchInput, WithinMatch } from '@fmmi/analytics'
import { nameKey } from '@fmmi/store'
import type { CatalogService, MatchRow, TacticalNoteRow } from '@fmmi/store'
import type { MatchQueries } from './queries.ts'

type Origin = 'catalog' | 'memo' | 'built_and_stored' | 'built_in_memory'

export const NOTE_LABEL = 'User-entered tactical note. FMMatchLens did not record this change; it is not an observed formation change.'
export const PLAYERS_MAX_LIMIT = 50
export const PLAYERS_DEFAULT_LIMIT = 20
export const NOTES_MAX_LIMIT = 50
export const NOTES_DEFAULT_LIMIT = 20
const MAX_WINDOW = 50
const MAX_PLAYER_IDS = 4

export interface TrendOptions { saveId: string; lastN?: number; homeAway?: Side; metrics?: string[]; season?: string }
export interface SeasonTrendOptions extends TrendOptions { teamId: string; includePartial?: boolean }
export interface PlayerTrendOptions extends TrendOptions { playerIds: string[] }

const encodeCursor = (c: unknown) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
function decodeCursor<T>(text: string, filter: string): T & { f: string } {
  const bad = () => new DomainError('invalid_input', 'The cursor is not valid for this query; start again without a cursor', { reason: 'cursor' })
  let c: (T & { f: string }) | null
  try { c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as T & { f: string } } catch { throw bad() }
  if (!c || c.f !== filter) throw bad()
  return c
}
function pageLimit(limit: number | undefined, def: number, max: number): number {
  const l = limit ?? def
  if (!Number.isInteger(l) || l < 1 || l > max) throw new DomainError('invalid_input', `limit must be an integer from 1 to ${max}`, { reason: 'limit' })
  return l
}
function windowsOf(lastN: number | undefined): number[] {
  if (lastN === undefined) return [...SEASON_POLICY.windows]
  if (!Number.isInteger(lastN) || lastN < 1 || lastN > MAX_WINDOW) throw new DomainError('invalid_input', `lastN must be an integer from 1 to ${MAX_WINDOW}`, { reason: 'last_n' })
  return [lastN]
}

/**
 * Season history queries (Slice 4): player catalog, rolling team and player trends, tactical notes and the before/after comparison.
 * They read the per-revision aggregates that ingest stored (one catalog read per match, no decoding); only a missing or stale
 * aggregate is rebuilt from the retained snapshot. Eligibility is decided by the one shared `eligibilityOf` function.
 */
export class HistoryQueries {
  private readonly svc: CatalogService
  private readonly mq: MatchQueries
  constructor(svc: CatalogService, mq: MatchQueries) { this.svc = svc; this.mq = mq }

  private requireSave(saveId: string) {
    const s = this.svc.store.getSave(saveId)
    if (!s) throw new DomainError('not_found', 'Save profile not found', { saveId })
    return s
  }
  private requireTeam(saveId: string, teamId: string) {
    const t = this.svc.store.getTeam(teamId)
    if (!t) throw new DomainError('not_found', 'Team not found', { teamId })
    if (t.saveId !== saveId) throw new DomainError('not_found', 'Team does not belong to this save', { reason: 'not_in_save' })
    return t
  }

  /** One match as a trend input for a side, with its aggregate (catalog read, or rebuilt when missing or stale). */
  private async inputFor(m: MatchRow, side: Side, origins: Origin[]): Promise<TrendMatchInput> {
    const store = this.svc.store
    const rev = store.getRevision(m.selectedRevisionId)!
    const { aggregate, origin } = await this.svc.ensureAggregate(rev.recordingRevisionId, { cache: this.mq.cache })
    origins.push(origin)
    const c = store.getConfirmation(rev.recordingRevisionId)
    const completion = applyConfirmation(baseCompletion(), c ? { home: c.home, away: c.away, confirmedAt: c.confirmedAt } : null, { ...aggregate.facts.observedScore, at: { period: 0, tick: 0, displayMinute: 0 } })
    const oppId = side === 'home' ? m.awayTeamId : m.homeTeamId
    const opp = store.getTeam(oppId)
    return {
      matchId: m.matchId, recordingRevisionId: rev.recordingRevisionId, date: m.matchDate, season: m.season, importedAt: m.createdAt, side,
      teamId: side === 'home' ? m.homeTeamId : m.awayTeamId, opponent: { teamId: oppId, name: opp?.name ?? '' },
      identityStatus: rev.identityStatus, completion: completion.status, manualFinalScore: completion.manualFinalScore ? { home: completion.manualFinalScore.home, away: completion.manualFinalScore.away, differsFromObserved: completion.manualFinalScore.differsFromObserved } : null,
      conflictingRevisionIds: store.listRevisions(m.matchId).filter((r) => r.identityStatus === 'identity_conflict').map((r) => r.recordingRevisionId),
      aggregate,
    }
  }

  private async teamMatches(saveId: string, teamId: string, season: string | undefined, origins: Origin[]): Promise<TrendMatchInput[]> {
    const out: TrendMatchInput[] = []
    for (const m of this.svc.store.listMatches(saveId)) {
      if (m.homeTeamId !== teamId && m.awayTeamId !== teamId) continue
      if (season !== undefined && m.season !== season) continue
      out.push(await this.inputFor(m, m.homeTeamId === teamId ? 'home' : 'away', origins))
    }
    return out
  }

  // ---------------------------------------------------------------- list_players

  listPlayers(o: { saveId: string; teamId?: string; nameQuery?: string; limit?: number; cursor?: string }) {
    const limit = pageLimit(o.limit, PLAYERS_DEFAULT_LIMIT, PLAYERS_MAX_LIMIT)
    this.requireSave(o.saveId)
    if (o.teamId !== undefined) this.requireTeam(o.saveId, o.teamId)
    const q = o.nameQuery === undefined ? null : nameKey(o.nameQuery)
    if (q !== null && (q.length < 1 || q.length > 80)) throw new DomainError('invalid_input', 'nameQuery must be 1-80 characters', { reason: 'name_query' })
    const filter = JSON.stringify([o.saveId, o.teamId ?? null, q])
    const key = (e: { name: string; playerId: string }) => `${nameKey(e.name)}\u0000${e.playerId}`
    const all = this.svc.listPlayerCatalog(o.saveId)
      .filter((e) => (o.teamId === undefined || e.teamIds.includes(o.teamId)) && (q === null || nameKey(e.name).includes(q)))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
    const after = o.cursor !== undefined ? decodeCursor<{ k: string }>(o.cursor, filter).k : null
    const rest = after === null ? all : all.filter((e) => key(e) > after)
    const page = rest.slice(0, limit)
    const next = rest.length > page.length ? encodeCursor({ k: key(page[page.length - 1]!), f: filter }) : null
    const count = (s: string) => all.filter((e) => e.identityStatus === s).length
    const warnings: string[] = []
    const conflicts = all.filter((e) => e.flags.includes('identity_conflict')).length
    if (conflicts > 0) warnings.push(`identity_conflict: ${conflicts} match-local identit${conflicts === 1 ? 'y shares' : 'ies share'} a uid with a different name and was not merged`)
    if (count('match_local') > 0) warnings.push('match_local_identities_are_excluded_from_trends: link them with `fmmi player link`')
    return validated(ListPlayersResultSchema, {
      schemaVersion: HISTORY_SCHEMA_VERSION, query: 'list_players' as const, saveId: o.saveId,
      filters: { teamId: o.teamId ?? null, nameQuery: o.nameQuery ?? null },
      page: { limit, returned: page.length, totalMatching: all.length, nextCursor: next, truncated: next !== null },
      summary: { persistent: count('persistent'), linked: count('linked'), matchLocal: count('match_local') },
      players: page.map((e) => ({
        playerId: e.playerId, name: e.name, identityStatus: e.identityStatus, matches: e.matches, uid: e.uid, teamIds: e.teamIds, lastSeen: e.lastSeen,
        ...(e.identityStatus === 'match_local'
          ? { matchId: e.matchIds[0]!, reason: e.reason }
          : {
              basis: (e.evidence as { basis?: string } | null)?.basis ?? null, supportingMatchIds: e.matchIds.slice(0, 12), supportingMatchesTotal: e.matchIds.length,
              matchLocalIds: e.members.length,
            }),
      })),
      warnings,
    })
  }

  // ---------------------------------------------------------------- get_season_trends

  async seasonTrends(o: SeasonTrendOptions) {
    const save = this.requireSave(o.saveId)
    void save
    const team = this.requireTeam(o.saveId, o.teamId)
    const lastN = windowsOf(o.lastN)
    const metrics = validateMetrics(o.metrics, TEAM_TREND_SPECS, DEFAULT_TEAM_METRICS)
    const origins: Origin[] = []
    const matches = await this.teamMatches(o.saveId, o.teamId, o.season, origins)
    const core = seasonTrends(matches, { lastN, homeAway: o.homeAway, metrics, includePartial: o.includePartial === true, withSplits: o.homeAway === undefined })
    const managed = this.svc.store.getManagedTeam(o.saveId)
    const warnings: string[] = []
    if (managed && managed.teamId !== team.teamId) warnings.push('team_is_not_the_managed_team_of_this_save')
    if (!managed) warnings.push('no_managed_team_set: `fmmi save team detect` suggests one; the teamId you passed is used as given')
    return validated(SeasonTrendsResultSchema, seasonTrendsResult({
      saveId: o.saveId,
      team: { teamId: team.teamId, name: team.name, aliases: this.svc.store.listAliases(o.saveId, team.teamId).map((a) => a.alias), managedBy: managed?.teamId === team.teamId ? managed.source : null },
      filters: { lastN, homeAway: o.homeAway ?? null, season: o.season ?? null, metrics, includePartial: o.includePartial === true },
      core, source: historySource(origins), warnings,
    }))
  }

  // ---------------------------------------------------------------- get_player_trends

  async playerTrends(o: PlayerTrendOptions) {
    this.requireSave(o.saveId)
    if (o.playerIds.length < 1 || o.playerIds.length > MAX_PLAYER_IDS) throw new DomainError('invalid_input', `playerIds needs 1 to ${MAX_PLAYER_IDS} ids`, { reason: 'player_ids' })
    if (new Set(o.playerIds).size !== o.playerIds.length) throw new DomainError('invalid_input', 'playerIds contains a duplicate', { reason: 'duplicate_player' })
    const lastN = windowsOf(o.lastN)
    const metrics = validateMetrics(o.metrics, PLAYER_TREND_SPECS, DEFAULT_PLAYER_METRICS)
    const store = this.svc.store
    const catalog = this.svc.listPlayerCatalog(o.saveId)
    const byId = new Map(catalog.map((e) => [e.playerId, e]))
    const obs = store.listSelectedObservations(o.saveId)
    const obsByLocal = new Map(obs.map((x) => [x.localPlayerId, x]))
    const origins: Origin[] = []
    const matchRows = new Map(store.listMatches(o.saveId).map((m) => [m.matchId, m]))
    const inputCache = new Map<string, TrendMatchInput>()
    const players: Parameters<typeof playerTrendsResult>[0]['players'] = []
    const excludedIdentities: Parameters<typeof playerTrendsResult>[0]['excludedIdentities'] = []
    for (const id of o.playerIds) {
      const e = byId.get(id)
      if (!e) {
        const member = id.startsWith('p_') ? store.getMember(id) : null
        if (member && member.saveId === o.saveId) {
          // A match-local id that belongs to a persistent or linked player: still match-local, excluded, with a pointer to the player.
          excludedIdentities.push({ playerId: id, identity: 'match_local', reason: 'match_local_identity', identityNote: 'member_of_a_player', persistentPlayerId: member.playerId })
          continue
        }
        if (id.startsWith('p_') || id.startsWith('pe_')) throw new DomainError('not_found', 'Player not found in this save', { playerId: id })
        throw new DomainError('not_found', 'Player not found in this save; ids come from list_players', { reason: 'player_id' })
      }
      if (e.identityStatus === 'match_local') {
        // Excluded and listed (spec 8.1): a match-local identity cannot be pooled across matches until it is linked.
        const member = store.getMember(id)
        excludedIdentities.push({ playerId: id, identity: 'match_local', reason: 'match_local_identity', identityNote: e.reason ?? 'match_local', persistentPlayerId: member?.playerId ?? null })
        continue
      }
      const items: PlayerMatchInput[] = []
      for (const local of e.members) {
        const ob = obsByLocal.get(local)
        const m = ob ? matchRows.get(ob.matchId) : undefined
        if (!ob || !m) continue
        const key = `${m.matchId}|${ob.side}`
        let base = inputCache.get(key)
        if (!base) { base = await this.inputFor(m, ob.side, origins); inputCache.set(key, base) }
        const p = base.aggregate.players.find((x) => x.localPlayerId === local)
        if (!p) continue
        items.push({ ...base, player: p })
      }
      const core = playerTrends(items, { lastN, homeAway: o.homeAway, metrics })
      players.push({ playerId: id, kind: e.identityStatus === 'linked' ? 'linked' : 'persistent', name: e.name, teamIds: e.teamIds, memberMatches: e.matches, core })
    }
    const comparisons = players.length >= 2
      ? players.slice(1).flatMap((p) => comparePlayerWindows({ id: players[0]!.playerId, windows: players[0]!.core.windows }, { id: p.playerId, windows: p.core.windows }))
      : []
    return validated(PlayerTrendsResultSchema, playerTrendsResult({
      saveId: o.saveId, filters: { lastN, homeAway: o.homeAway ?? null, metrics }, players, comparisons, excludedIdentities, source: historySource(origins),
      warnings: players.length === 0 ? ['no_persistent_player_among_the_ids: nothing was pooled'] : [],
    }))
  }

  // ---------------------------------------------------------------- notes

  private noteView(n: TacticalNoteRow & { saveId?: string; supersededByNoteId?: string | null }) {
    const m = this.svc.store.getMatch(n.matchId)!
    return {
      noteId: n.noteId, saveId: m.saveId, matchId: n.matchId, recordingRevisionId: n.recordingRevisionId,
      teamId: n.side === 'home' ? m.homeTeamId : m.awayTeamId, side: n.side, period: n.period, minute: n.minute,
      setting: n.setting, priorValue: n.priorValue, newValue: n.newValue, comment: n.comment,
      confidence: 'manual' as const, source: 'user_entered' as const,
      label: NOTE_LABEL,
      supersedes: n.supersedesNoteId, supersededBy: n.supersededByNoteId ?? this.svc.store.supersedingNoteOf(n.noteId), createdAt: n.createdAt,
    }
  }
  /** View of one note (used by the CLI after a write, and by get_tactical_notes). */
  viewNote(n: TacticalNoteRow) { return this.noteView(n) }

  tacticalNotes(o: { saveId: string; matchId?: string; limit?: number; cursor?: string }) {
    const limit = pageLimit(o.limit, NOTES_DEFAULT_LIMIT, NOTES_MAX_LIMIT)
    this.requireSave(o.saveId)
    if (o.matchId !== undefined) {
      const m = this.svc.store.getMatch(o.matchId)
      if (!m || m.saveId !== o.saveId) throw new DomainError('not_found', 'Match not found in this save', { reason: 'not_in_save' })
    }
    const filter = JSON.stringify([o.saveId, o.matchId ?? null])
    const all = this.svc.store.listNotes(o.saveId, o.matchId)
    const after = o.cursor !== undefined ? decodeCursor<{ k: string }>(o.cursor, filter).k : null
    const key = (n: { createdAt: string; noteId: string }) => `${n.createdAt}\u0000${n.noteId}`
    const rest = after === null ? all : all.filter((n) => key(n) > after)
    const page = rest.slice(0, limit)
    const next = rest.length > page.length ? encodeCursor({ k: key(page[page.length - 1]!), f: filter }) : null
    return validated(TacticalNotesResultSchema, {
      schemaVersion: HISTORY_SCHEMA_VERSION, query: 'tactical_notes' as const, saveId: o.saveId, filters: { matchId: o.matchId ?? null },
      page: { limit, returned: page.length, totalMatching: all.length, nextCursor: next, truncated: next !== null },
      label: NOTE_LABEL,
      notes: page.map((n) => { const { label: _label, ...v } = this.noteView(n); return { ...v, status: n.supersededByNoteId ? 'superseded' as const : 'current' as const } }),
      observedFormationChanges: o.matchId === undefined ? null : this.observedChanges(o.matchId),
      statements: ['Notes are user-entered (confidence manual) and immutable; a correction is a new note that supersedes the old one. They are kept apart from observed formation and role changes, which come from the recording.'],
      warnings: all.length === 0 ? ['no_notes: add one with `fmmi note add`'] : [],
    })
  }

  /** Role and position changes the plugin observed (never user notes). Bounded; names are untrusted data. */
  private observedChanges(matchId: string) {
    const show = this.svc.showMatch(matchId)
    const role = (a: { role: string; duty: string | null } | null) => (a ? `${a.role}${a.duty ? ` (${a.duty})` : ''}` : null)
    const withChanges = show.roster.filter((p) => p.roleTimeline.length > 1)
    const shown = withChanges.slice(0, 20)
    return {
      source: 'observed_by_plugin' as const, recordingRevisionId: show.recording.recordingRevisionId,
      note: 'Role and position assignments the plugin noticed (captured tick = when it noticed, not when the manager acted), and substitution flips. Not user notes; the manager instruction settings are not recorded.',
      substitutionFlips: show.substitutions.length,
      players: shown.map((p) => ({
        playerId: p.playerId, name: p.name, side: p.side,
        changes: p.roleTimeline.slice(0, 8).map((t) => ({ capturedTick: t.capturedTick, gameMinute: t.gameMinute, gameLabel: t.gameLabel, position: t.position, inPossession: role(t.inPossession), outOfPossession: role(t.outOfPossession) })),
      })),
      playersWithChanges: withChanges.length, truncated: withChanges.length > shown.length,
    }
  }

  // ---------------------------------------------------------------- compare_tactical_change

  async compareTacticalChange(o: { saveId: string; teamId: string; noteId: string; matchesBefore?: number; matchesAfter?: number }) {
    const store = this.svc.store
    this.requireSave(o.saveId)
    const team = this.requireTeam(o.saveId, o.teamId)
    const gm = GATES.tactical
    const each = (v: number | undefined, what: string) => {
      const n = v ?? gm.defaultMatchesEachSide
      if (!Number.isInteger(n) || n < 0 || n > gm.maxMatchesEachSide) throw new DomainError('invalid_input', `${what} must be an integer from 0 to ${gm.maxMatchesEachSide}`, { reason: 'matches_each_side' })
      return n
    }
    const nBefore = each(o.matchesBefore, 'matchesBefore'), nAfter = each(o.matchesAfter, 'matchesAfter')
    const note = store.getNote(o.noteId)
    const noteMatch = note ? store.getMatch(note.matchId) : null
    if (!note || !noteMatch || noteMatch.saveId !== o.saveId) throw new DomainError('not_found', 'Tactical note not found in this save', { noteId: o.noteId })
    const noteTeamId = note.side === 'home' ? noteMatch.homeTeamId : noteMatch.awayTeamId
    if (noteTeamId !== team.teamId) throw new DomainError('invalid_input', 'The note is about the other team of its match', { reason: 'note_team_mismatch', noteTeamId })
    const warnings: string[] = []
    const supersededBy = store.supersedingNoteOf(note.noteId)
    if (supersededBy) warnings.push(`note_superseded_by:${supersededBy}`)

    // ---- within the match that contains the change (decodes one retained recording through the bounded cache)
    const { input } = await this.mq.load(note.matchId, { recordingRevisionId: note.recordingRevisionId })
    const frames = input.decoded.sampled.frames
    const b: Boundary = resolveDisplayMinute(frames, note.minute, note.period ?? undefined)
    const boundaryText = `${b.period}:${b.tick}`
    const side: Side = note.side
    const onPitch = input.decoded.recording.roster
      .filter((p) => p.side === side && participationAt(p.participation.segments, { period: b.period, tick: b.tick }) === 'on')
      .map((p) => ({ playerId: input.ids.playerIds.get(p.upstreamPlayerId)!, persistentPlayerId: store.getMember(input.ids.playerIds.get(p.upstreamPlayerId)!)?.playerId ?? null, name: p.name, position: p.position }))
    let within: WithinMatch
    try {
      const cmp = compareQuery(input, team.teamId, { windowA: { to: b }, windowB: { from: b } })
      within = compactWithin(cmp, boundaryText, note.minute, onPitch)
    } catch (e) {
      if (!(e instanceof DomainError) || e.code !== 'invalid_input') throw e
      within = { status: 'unavailable', reason: 'change_at_the_edge_of_the_recording', boundary: boundaryText, minute: note.minute, windows: null, rates: [], scoreState: null, substitutions: null, confounders: [], playersOnPitch: onPitch, coverage: 'unavailable' }
      warnings.push('within_match_unavailable: the change is at the start or end of the recorded interval, so one window is empty')
    }

    // ---- across matches (stored aggregates; the match that contains the change belongs to neither set)
    const origins: Origin[] = []
    const all = await this.teamMatches(o.saveId, team.teamId, undefined, origins)
    const self = all.find((m) => m.matchId === note.matchId)!
    let across: Parameters<typeof tacticalChangeResult>[0]['across']
    let presence: Parameters<typeof tacticalChangeResult>[0]['playersOnPitchPresence'] = null
    const metrics = [...DEFAULT_TEAM_METRICS]
    if (self.date === null) {
      across = { matchesBefore: nBefore, matchesAfter: nAfter, before: null, after: null, reason: 'the_match_with_the_note_has_no_in_game_date_so_it_cannot_be_ordered' }
    } else {
      const elig = all.filter((m) => m.matchId !== note.matchId).map((m) => ({ m, e: eligibilityOf(m) })).filter((x) => x.e.rates).sort((a, b) => byGameOrder(a.m, b.m))
      const before = nBefore === 0 ? [] : elig.filter((x) => byGameOrder(x.m, self) < 0).slice(-nBefore)
      const after = nAfter === 0 ? [] : elig.filter((x) => byGameOrder(x.m, self) > 0).slice(0, nAfter)
      if (before.length === 0 || after.length === 0) {
        const why = [before.length === 0 ? (nBefore === 0 ? 'matches_before_not_requested' : 'no_eligible_match_before_the_change') : null, after.length === 0 ? (nAfter === 0 ? 'matches_after_not_requested' : 'no_eligible_match_after_the_change') : null].filter(Boolean).join(',')
        across = { matchesBefore: nBefore, matchesAfter: nAfter, before: null, after: null, reason: why }
      } else {
        across = { matchesBefore: nBefore, matchesAfter: nAfter, before: acrossSide(before, metrics), after: acrossSide(after, metrics) }
        // Players on the pitch at the change: only those with a persistent or linked identity can be followed across matches.
        const linked = onPitch.filter((p) => p.persistentPlayerId !== null)
        const sel = store.listSelectedObservations(o.saveId)
        const present = (matchId: string) => linked.filter((p) => {
          const members = new Set(store.getEntity(p.persistentPlayerId!)?.members.map((m) => m.localPlayerId) ?? [])
          return sel.some((x) => x.matchId === matchId && members.has(x.localPlayerId) && x.minutes > 0)
        }).length
        presence = {
          linkedPlayers: linked.length, matchLocalPlayers: onPitch.length - linked.length,
          before: before.map((x) => ({ matchId: x.m.matchId, linkedPresent: present(x.m.matchId) })), after: after.map((x) => ({ matchId: x.m.matchId, linkedPresent: present(x.m.matchId) })),
        }
        if (presence.matchLocalPlayers > 0) warnings.push(`players_on_pitch_not_fully_followable: ${presence.matchLocalPlayers} of ${onPitch.length} players have only a match-local identity`)
      }
    }
    return validated(TacticalChangeResultSchema, tacticalChangeResult({
      saveId: o.saveId, team: { teamId: team.teamId, name: team.name }, note: this.noteView(note), within, across, playersOnPitchPresence: presence, source: historySource(origins), warnings, metrics,
    }))
  }
}

export type { MatchAggregate }
