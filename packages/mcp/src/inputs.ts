import * as z from 'zod/v4'

/**
 * Tool input schemas (spec 8.1). Every object is strict: an unknown key such as `path` or `url` is rejected, so no
 * file, network or shell input can reach the adapter. Identifiers are opaque internal ids with a restricted alphabet
 * (no separators, dots or spaces), so an id can never be read as a path.
 */
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'must be an internal id returned by an earlier tool call')
const boundary = z.string().regex(/^\d{1,2}:\d{1,7}(:\d{1,4})?$/, 'canonical boundary <period>:<tick>, for example 2:13700')
const minute = z.number().min(0).max(240)
/** Optional: omitted means the configured default save (or the only save). A client never needs to supply it. */
/** Optional: omitted means the managed team (of the match, or of the save). With none known the call fails and asks for a teamId. */
const teamOpt = id.optional().describe('A team id from list_matches. Omit it to use the managed team (the managed side of this match, or of the save).')
const saveIdOpt = id.optional().describe('Save profile id. Omit it to use the default save (the only save, or the one chosen by fmmi setup).')

export const WindowInput = z.strictObject({
  from: boundary.optional().describe('Window start as a canonical boundary <period>:<tick>. Windows are half-open [from,to).'),
  to: boundary.optional().describe('Window end (exclusive) as a canonical boundary <period>:<tick>.'),
  fromMinute: minute.optional().describe('Period-aware minute shortcut for the start. A minute that exists in more than one period needs `period`, else ambiguous_selection.'),
  toMinute: minute.optional().describe('Period-aware minute shortcut for the end.'),
  period: z.int().min(1).max(6).optional().describe('Period (1 = first half, 2 = second half) that the minute shortcuts refer to.'),
}).describe('Optional time window. Omit it for the whole recording. Out-of-range or reversed windows are rejected, never clipped.')

const revision = id.optional().describe('Pin the evidence to this immutable recordingRevisionId (from an earlier result). If it cannot be served you get revision_unavailable, never another revision.')

export const ListMatchesInput = z.strictObject({
  saveId: id.optional().describe('Restrict to one save profile.'),
  teamId: id.optional().describe('Restrict to matches of this team (an id from an earlier list_matches result).'),
  season: z.string().min(1).max(16).regex(/^[0-9]{4}(-[0-9]{2})?$/, 'season label such as 2026-27').optional(),
  limit: z.int().min(1).max(50).optional().describe('Page size, 1 to 50 (default 20).'),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional().describe('page.nextCursor from the previous page.'),
})
export const MatchSummaryInput = z.strictObject({
  matchId: id, teamId: id.optional().describe('Filter the roster to one team of this match. The team comparison always shows both sides.'), recordingRevisionId: revision,
})
export const PlayerMatchInput = z.strictObject({ matchId: id, playerId: id.describe('A match-local playerId (p_...) from get_match_summary, or the persistent playerId (pe_...) of a player who played in this match.'), window: WindowInput.optional(), recordingRevisionId: revision })
export const PassingNetworkInput = z.strictObject({
  matchId: id, teamId: teamOpt, window: WindowInput.optional(),
  minPasses: z.int().min(1).max(500).optional().describe('Only links with at least this many completed passes.'),
  limit: z.int().min(1).max(100).optional().describe('Most links returned (default 10). page.truncated-style information is in network.totals.'),
  recordingRevisionId: revision,
})
export const StrikerServiceInput = z.strictObject({
  matchId: id, playerId: id.describe('A match-local playerId (p_...) or the persistent playerId (pe_...) of a player who played in this match.'), window: WindowInput.optional(), comparePlayerId: id.optional().describe('A different player of the same match to compare with (p_... or pe_...).'), recordingRevisionId: revision,
})
export const ComparePeriodsInput = z.strictObject({
  matchId: id, teamId: teamOpt,
  windowA: WindowInput.describe('First window (the baseline). Deltas are B minus A.'),
  windowB: WindowInput.describe('Second window.'),
  playerIds: z.array(id).min(1).max(4).optional().describe('Up to 4 players of this team to compare as well.'),
  recordingRevisionId: revision,
})
export const RecordingStatusInput = z.strictObject({
  matchId: id.optional().describe('Omit for bounded catalog-wide ingestion health.'), recordingRevisionId: revision,
})
export const OppositionThreatInput = z.strictObject({
  matchId: id, teamId: id.optional().describe('The team being defended. The report covers its opponent. Omit it to defend the managed team of this match.'), window: WindowInput.optional(), recordingRevisionId: revision,
})

// ------------------------------------------------------------------ Slice 4: season history (spec 8.1)
const metricIds = z.array(z.string().regex(/^[a-z0-9_]{1,64}$/, 'a metric id from the registry')).min(1).max(15)
  .describe('Metric ids to report; omit for the default set. An unknown id is rejected with the allowed list.')
const lastN = z.int().min(1).max(50).optional().describe('Window size: the last N eligible matches. Omit for the last 5 and the last 10.')
const homeAway = z.enum(['home', 'away']).optional().describe('Only matches in which the team (or player team) played at home or away.')

export const ListPlayersInput = z.strictObject({
  saveId: saveIdOpt, teamId: id.optional().describe('Only players seen in this team of the save.'),
  nameQuery: z.string().min(1).max(80).optional().describe('Case-insensitive substring of the display name. Names are presentation only; the returned playerId is the key.'),
  limit: z.int().min(1).max(50).optional().describe('Page size, 1 to 50 (default 20).'),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional().describe('page.nextCursor from the previous page.'),
})
export const SeasonTrendsInput = z.strictObject({
  saveId: saveIdOpt, teamId: teamOpt, lastN, homeAway, metrics: metricIds.optional(),
  season: z.string().regex(/^[0-9]{4}(-[0-9]{2})?$/, 'season label such as 2026-27').optional().describe('Only matches of this season label.'),
  includePartial: z.boolean().optional().describe('Also show partial recordings in a separate block. They are never mixed into the main comparison.'),
})
export const PlayerTrendsInput = z.strictObject({
  saveId: saveIdOpt, playerIds: z.array(id).min(1).max(4).describe('Persistent playerIds (pe_...) from list_players. Match-local ids (p_...) are excluded and listed.'),
  metrics: metricIds.optional(), lastN, homeAway,
})
export const TacticalNotesInput = z.strictObject({
  saveId: saveIdOpt, matchId: id.optional().describe('Only notes of this match; also returns the role changes the plugin observed in that match, kept separate.'),
  limit: z.int().min(1).max(50).optional().describe('Page size, 1 to 50 (default 20).'),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional().describe('page.nextCursor from the previous page.'),
})
export const CompareTacticalChangeInput = z.strictObject({
  saveId: saveIdOpt, teamId: teamOpt, noteId: id.describe('A noteId from get_tactical_notes.'),
  matchesBefore: z.int().min(0).max(10).optional().describe('Eligible matches before the change to pool (default 3; 0 for none).'),
  matchesAfter: z.int().min(0).max(10).optional().describe('Eligible matches after the change to pool (default 3; 0 for none).'),
})
