import { z } from 'zod'
import type { Side } from '@fmmi/model'
import { aggregateKey } from './aggregate.ts'
import type { compareQuery } from './overview.ts'
import { metricsBlock } from './queries.ts'
import { GATES, METRIC_DICTIONARY_VERSION } from './registry.ts'
import type { AcrossSide, PlayerComparison, PlayerTrendsCore, SeasonTrendsCore } from './trends.ts'
import { acrossConfounders, acrossDeltas } from './trends.ts'

export const HISTORY_SCHEMA_VERSION = '1.0'

/** Where the pooled per-revision aggregates came from: the catalog cache, this process memory, or built from the retained snapshot just now. */
export interface HistorySource { aggregateKey: string; aggregates: number; servedFromCatalog: number; servedFromMemory: number; builtThisCall: number; persistedThisCall: number }
export function historySource(origins: ReadonlyArray<'catalog' | 'memo' | 'built_and_stored' | 'built_in_memory'>): HistorySource {
  const n = (o: string) => origins.filter((x) => x === o).length
  return { aggregateKey: aggregateKey(), aggregates: origins.length, servedFromCatalog: n('catalog'), servedFromMemory: n('memo'), builtThisCall: n('built_and_stored') + n('built_in_memory'), persistedThisCall: n('built_and_stored') }
}

type Coverage = 'complete_for_window' | 'partial_for_window' | 'unavailable'

const NOT_RECORDED = { reason: 'not_recorded' as const }
export const GROUND_SERVICE_UNAVAILABLE = {
  metric: 'ground_service_receptions', value: null, nullReason: NOT_RECORDED.reason,
  note: 'No ground or air classification exists in the event schema, so ground service is unavailable and is never inferred (absence of an aerial duel is not ground service). The all-pass receptions metrics (passes_received_per_90, passes_received_pct_of_team_completed; counter scope) are reported instead and are not ground service.',
} as const

const TEAM_UNAVAILABLE = [
  { metric: 'non_penalty_xg', reason: 'unverified_semantics', note: 'Penalty classification of shot events is not reliable, so recorded xG is reported and never relabelled non-penalty.' },
] as const

const mapDefs = (rows: ReadonlyArray<{ metric: string }>) => metricsBlock([...new Set(rows.map((r) => r.metric))])

// ------------------------------------------------------------------ season trends

export interface SeasonTrendsArgs {
  saveId: string
  team: { teamId: string; name: string; aliases: string[]; managedBy: 'explicit' | 'assisted' | null }
  filters: { lastN: number[]; homeAway: Side | null; season: string | null; metrics: string[]; includePartial: boolean }
  core: SeasonTrendsCore
  source: HistorySource
  warnings: string[]
}

export function seasonTrendsResult(a: SeasonTrendsArgs) {
  const w = [...a.warnings]
  const matchesUsed = a.core.matches
  const coverage: Coverage = matchesUsed.length === 0 ? 'unavailable' : matchesUsed.some((m) => m.class === 'early_ending') ? 'partial_for_window' : 'complete_for_window'
  if (a.core.eligibleMatches === 0) w.push('no_eligible_matches: confirm completed matches with `fmmi match confirm`; see excluded for the reason per match')
  for (const x of a.core.windows) if (x.matchIds.length < x.lastN && a.core.eligibleMatches > 0) w.push(`window_${x.lastN}_has_only_${x.matchIds.length}_eligible_matches`)
  if (a.core.windows.some((x) => x.disclosures.earlyEnding.length > 0)) w.push('early_ending_matches_in_rates: rates use measured minutes; totals exclude their unseen time')
  if (a.core.windows.some((x) => x.disclosures.manualConfirmation.length > 0)) w.push('manual_confirmation_matches: completion was confirmed by the user, not signalled by the recording')
  if (a.core.windows.some((x) => x.rates.some((r) => r.metric === 'possession_pct'))) w.push('possession_time_unit_unverified: ratio of counter deltas; the unit of possessionTime is unverified')
  if (a.core.windows.some((x) => x.rates.some((r) => r.metric === 'xg_per_90' || r.metric === 'xg_against_per_90' || r.metric === 'xg_difference_per_90'))) w.push('non_penalty_xg_unavailable: xG rows are recorded aggregate xG')
  const rows = a.core.windows.flatMap((x) => x.rates)
  const wingIds = a.core.windows.some((x) => x.wing) ? ['chance_creation_by_wing_trend', 'attack_lane', 'opposition_xg_by_lane'] : []
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION, query: 'season_trends' as const, saveId: a.saveId,
    metricDictionaryVersion: METRIC_DICTIONARY_VERSION, source: a.source, coverage,
    team: a.team, filters: a.filters, ...a.core,
    unavailable: TEAM_UNAVAILABLE, metrics: metricsBlock([...new Set([...rows.map((r) => r.metric), ...wingIds])]),
    statements: [
      'Pooled rates divide summed numerators by summed denominators over the listed matches; match percentages and rates are never averaged. A match missing a field is excluded from that metric and listed under excluded with the reason.',
      'Windows are the last N eligible matches by in-game date. The record uses the manual final score where the user confirmed the match (labelled manual); observed totals cover full-match captures only.',
      'Chance creation by wing pools shots, xG, crosses, completed crosses, final-third entries and danger-area entries per attack lane, for and against the team, as [count, per-90 rate] pairs: summed counts with a rate over the measured minutes of the contributing matches. Lanes are thirds of pitch width from the attacking team perspective: "for" is where the team attacked, "against" is where the opposition attacked (its left lane runs down the team right flank). No lane is ranked or scored.',
      'Descriptive only: rolling rates do not test or explain any change.',
    ],
    warnings: [...new Set(w)],
  }
}

// ------------------------------------------------------------------ player trends

export interface PlayerTrendsArgs {
  saveId: string
  filters: { lastN: number[]; homeAway: Side | null; metrics: string[] }
  players: Array<{ playerId: string; kind: 'persistent' | 'linked'; name: string; teamIds: string[]; memberMatches: number; core: PlayerTrendsCore }>
  comparisons: PlayerComparison[]
  excludedIdentities: Array<{ playerId: string; identity: 'match_local'; reason: string; identityNote: string; persistentPlayerId: string | null }>
  source: HistorySource
  warnings: string[]
}

export function playerTrendsResult(a: PlayerTrendsArgs) {
  const w = [...a.warnings]
  const used = a.players.flatMap((p) => p.core.matches)
  const table = new Map(used.map((m) => [m.matchId, m]))
  const coverage: Coverage = used.length === 0 ? 'unavailable' : used.some((m) => m.class === 'early_ending') ? 'partial_for_window' : 'complete_for_window'
  if (a.excludedIdentities.length > 0) w.push('match_local_identities_excluded: link them with `fmmi player link` to include them')
  if (a.players.some((p) => p.core.windows.some((x) => x.rates.some((r) => (r.excluded ?? []).some((e) => e.reason === 'recipient_gate_failed'))))) w.push('recipient_gate_failed_recordings_excluded_from_reception_metrics')
  w.push('ground_service_unavailable: all-pass receptions are reported instead')
  const rows = a.players.flatMap((p) => p.core.windows.flatMap((x) => x.rates))
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION, query: 'player_trends' as const, saveId: a.saveId,
    metricDictionaryVersion: METRIC_DICTIONARY_VERSION, source: a.source, coverage, filters: a.filters,
    players: a.players.map((p) => ({ playerId: p.playerId, kind: p.kind, name: p.name, teamIds: p.teamIds, memberMatches: p.memberMatches, windows: p.core.windows, excluded: p.core.excluded })),
    matches: [...table.values()].sort((x, y) => ((x.date ?? '') < (y.date ?? '') ? -1 : (x.date ?? '') > (y.date ?? '') ? 1 : x.matchId < y.matchId ? -1 : 1)),
    comparisons: a.comparisons, excludedIdentities: a.excludedIdentities,
    groundService: GROUND_SERVICE_UNAVAILABLE,
    metrics: mapDefs(rows),
    statements: [
      'Per-player rates pool numerators and denominators over the listed matches; minutes are verified on-pitch game minutes. A match in which a player did not play, or whose recording fails the section 7.2 recipient gate for a reception metric, contributes to neither part of that metric and is listed under excluded with the reason.',
      'Comparisons are descriptive: they report the direction and size of a difference when the exposure gates pass in each window. They do not establish a cause and carry no absolute service label.',
    ],
    warnings: [...new Set(w)],
  }
}

// ------------------------------------------------------------------ tactical change

export interface WithinMatch {
  status: 'available' | 'unavailable'
  reason?: string
  boundary: string | null
  minute: number | null
  windows: null | {
    before: { minutes: number; display: { fromMinute: number; toMinute: number }; coverage: Coverage; exact: boolean }
    after: { minutes: number; display: { fromMinute: number; toMinute: number }; coverage: Coverage; exact: boolean }
  }
  rates: Array<{ metric: string; comparedAs: 'per_90' | 'value'; before: number | null; after: number | null; delta: number | null }>
  scoreState: { before: unknown; after: unknown } | null
  substitutions: { before: unknown[]; after: unknown[] } | null
  confounders: string[]
  playersOnPitch: Array<{ playerId: string; persistentPlayerId: string | null; name: string; position: string | null }>
  coverage: Coverage
}

type CompareOut = ReturnType<typeof compareQuery>

/** Compact view of the two-window comparison: per-90 team rates before and after the change. */
export function compactWithin(r: CompareOut, boundary: string, minute: number, onPitch: WithinMatch['playersOnPitch']): WithinMatch {
  const cell = (c: { value: number | null; perNinety?: number | null }, per: 'per_90' | 'value') => (per === 'per_90' ? (c.perNinety ?? null) : c.value)
  const win = (k: 'a' | 'b') => { const x = r.windows[k]; return { minutes: x.teamMinutes, display: x.display, coverage: x.coverage as Coverage, exact: x.effective.exact } }
  const ss = r.comparison.context.scoreState as { a: unknown; b: unknown }
  const subs = r.comparison.substitutions as { a: unknown[]; b: unknown[] }
  return {
    status: 'available', boundary, minute,
    windows: { before: win('a'), after: win('b') },
    rates: r.comparison.teamRates.map((t) => ({ metric: t.metric, comparedAs: t.comparedAs, before: cell(t.a as never, t.comparedAs), after: cell(t.b as never, t.comparedAs), delta: t.delta })),
    scoreState: { before: ss.a, after: ss.b }, substitutions: { before: subs.a, after: subs.b },
    confounders: [...r.comparison.context.confounders], playersOnPitch: onPitch, coverage: r.coverage as Coverage,
  }
}

export interface TacticalChangeArgs {
  saveId: string
  team: { teamId: string; name: string }
  note: Record<string, unknown>
  within: WithinMatch
  across: { matchesBefore: number; matchesAfter: number; before: AcrossSide; after: AcrossSide } | { matchesBefore: number; matchesAfter: number; before: null; after: null; reason: string }
  playersOnPitchPresence: null | { linkedPlayers: number; matchLocalPlayers: number; before: Array<{ matchId: string; linkedPresent: number }>; after: Array<{ matchId: string; linkedPresent: number }> }
  source: HistorySource
  warnings: string[]
  metrics: string[]
}

export function tacticalChangeResult(a: TacticalChangeArgs) {
  const w = [...a.warnings]
  const acrossAvail = a.across.before !== null
  const single = !acrossAvail
  const confounders: string[] = [...a.within.confounders.map((c) => `within_match:${c}`)]
  let across
  if (a.across.before !== null && a.across.after !== null) {
    const x = acrossConfounders(a.across.before, a.across.after)
    confounders.push(...x.map((c) => `across_matches:${c}`))
    across = {
      status: 'available' as const, matchesBefore: a.across.matchesBefore, matchesAfter: a.across.matchesAfter, before: a.across.before, after: a.across.after,
      deltas: acrossDeltas(a.across.before, a.across.after), confounders: x, label: 'descriptive_comparison' as const,
    }
  } else {
    across = { status: 'unavailable' as const, matchesBefore: a.across.matchesBefore, matchesAfter: a.across.matchesAfter, reason: (a.across as { reason: string }).reason }
  }
  if (single) w.push('single_match_comparison: only the match containing the change could be compared; there are no eligible matches on at least one side')
  if (a.within.windows) {
    if (a.within.windows.before.minutes < GATES.tactical.minWindowMinutes) w.push(`short_window_before: under ${GATES.tactical.minWindowMinutes} verified minutes before the change (heuristic)`)
    if (a.within.windows.after.minutes < GATES.tactical.minWindowMinutes) w.push(`short_window_after: under ${GATES.tactical.minWindowMinutes} verified minutes after the change (heuristic)`)
  }
  const sq = a.within.rates.find((r) => r.metric === 'shot_quality')
  if (sq && (sq.before === null || sq.after === null)) w.push('shot_quality_unavailable_in_a_window')
  w.push('observational_comparison: not a controlled test; context and confounders are reported beside the rates and are not adjusted for')
  const rows = [...a.within.rates.map((r) => ({ metric: r.metric })), ...(acrossAvail ? a.across.before!.rates : [])]
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION, query: 'tactical_change' as const, saveId: a.saveId, metricDictionaryVersion: METRIC_DICTIONARY_VERSION,
    source: a.source, coverage: a.within.coverage, team: a.team, note: a.note,
    singleMatchComparison: single, within: a.within, across, playersOnPitchPresence: a.playersOnPitchPresence,
    confounders, metrics: mapDefs(rows),
    statements: [
      'The note is a user-entered record (confidence manual). The recording does not show that the setting changed; observed formation and role changes are listed separately by get_tactical_notes.',
      'Rates are normalised per 90 minutes of verified team time in each window. Differences are reported as higher or lower; they do not establish what produced them.',
      single ? 'This is a single-match comparison: it says nothing about how the change performs across matches.' : 'Across-match sets exclude the match that contains the change; each set is pooled from numerators and denominators.',
    ],
    warnings: [...new Set(w)],
  }
}

// ------------------------------------------------------------------ schemas

const Cov = z.enum(['complete_for_window', 'partial_for_window', 'unavailable'])
const NullReason = z.enum(['not_recorded', 'unsupported_version', 'partial', 'unverified_semantics', 'missing_baseline', 'unresolved_boundary', 'zero_denominator', 'not_applicable'])
const SourceShape = z.strictObject({ aggregateKey: z.string(), aggregates: z.number().int(), servedFromCatalog: z.number().int(), servedFromMemory: z.number().int(), builtThisCall: z.number().int(), persistedThisCall: z.number().int() })
const Row = z.strictObject({
  metric: z.string(), value: z.number().nullable(), nullReason: NullReason.optional(), numerator: z.number().nullable(), denominator: z.number().nullable(),
  contributing: z.strictObject({ matches: z.number().int(), minutes: z.number(), matchIds: z.array(z.string()).optional() }),
  excluded: z.array(z.strictObject({ matchId: z.string(), reason: z.string() })).optional(),
})
const Summary = z.looseObject({ matchId: z.string(), recordingRevisionId: z.string(), date: z.string().nullable(), class: z.literal('early_ending').optional(), capturedMinutes: z.number() })
const Envelope = { schemaVersion: z.string(), saveId: z.string(), metricDictionaryVersion: z.string(), source: SourceShape, coverage: Cov, statements: z.array(z.string()), warnings: z.array(z.string()), metrics: z.record(z.string(), z.looseObject({ version: z.number().int() })) }

const WingCellSchema = z.tuple([z.number(), z.number().nullable()])
const WingLaneSchema = z.strictObject({ shots: WingCellSchema, xg: WingCellSchema, crosses: WingCellSchema, crossesCompleted: WingCellSchema, finalThirdEntries: WingCellSchema, dangerAreaEntries: WingCellSchema })
const WingDirectionSchema = z.strictObject({
  byLane: z.strictObject({ left: WingLaneSchema, centre: WingLaneSchema, right: WingLaneSchema }),
  withoutLocation: z.strictObject({ shots: z.number(), crosses: z.number(), crossesCompleted: z.number(), finalThirdEntries: z.number(), dangerAreaEntries: z.number() }),
  xgUnattributedShots: z.number(),
})
const WingSchema = z.strictObject({
  metric: z.literal('chance_creation_by_wing_trend'),
  contributing: z.strictObject({ matches: z.number().int(), minutes: z.number(), matchIds: z.array(z.string()).optional() }),
  excluded: z.array(z.strictObject({ matchId: z.string(), reason: z.string() })).optional(),
  for: WingDirectionSchema, against: WingDirectionSchema,
})

export const SeasonTrendsResultSchema = z.looseObject({
  ...Envelope, query: z.literal('season_trends'),
  team: z.looseObject({ teamId: z.string(), name: z.string(), aliases: z.array(z.string()) }),
  eligibleMatches: z.number().int(),
  matches: z.array(Summary),
  excluded: z.array(z.strictObject({ matchId: z.string(), date: z.string().nullable(), reasons: z.array(z.string()), nextStep: z.string().optional() })),
  windows: z.array(z.looseObject({
    lastN: z.number().int(), matchIds: z.array(z.string()), rates: z.array(Row), wing: WingSchema.optional(),
    record: z.looseObject({ matches: z.number().int(), won: z.number().int(), drawn: z.number().int(), lost: z.number().int() }),
    totals: z.looseObject({ matches: z.number().int(), minutes: z.number(), excludedFromTotals: z.array(z.looseObject({ matchId: z.string(), reason: z.string() })) }),
  })),
  unavailable: z.array(z.looseObject({ metric: z.string(), reason: z.string() })),
})

const PooledScoreStateSchema = z.union([
  z.object({ value: z.looseObject({ ticks: z.record(z.string(), z.number()), minutes: z.record(z.string(), z.number()), dominant: z.enum(['leading', 'drawing', 'trailing']) }) }),
  z.object({ value: z.null(), nullReason: z.string() }),
])
const PlayerWindowSchema = z.looseObject({
  lastN: z.number().int(), minutes: z.number(), matchIds: z.array(z.string()), matchMinutes: z.array(z.number()), rates: z.array(Row),
  contributing: z.looseObject({ matches: z.number().int(), matchIds: z.array(z.string()).optional() }).optional(),
  opposition: z.array(z.string()).optional(), scoreState: PooledScoreStateSchema.optional(),
})
export const PlayerTrendsResultSchema = z.looseObject({
  ...Envelope, query: z.literal('player_trends'),
  matches: z.array(z.looseObject({ matchId: z.string(), recordingRevisionId: z.string(), date: z.string().nullable() })),
  players: z.array(z.looseObject({ playerId: z.string().startsWith('pe_'), kind: z.enum(['persistent', 'linked']), name: z.string(), windows: z.array(PlayerWindowSchema) })),
  comparisons: z.array(z.looseObject({
    status: z.enum(['qualified', 'suppressed']), reasons: z.array(z.string()).optional(), confounders: z.array(z.string()),
  })),
  excludedIdentities: z.array(z.looseObject({ playerId: z.string(), identity: z.literal('match_local'), reason: z.string() })),
  groundService: z.strictObject({ metric: z.literal('ground_service_receptions'), value: z.null(), nullReason: z.literal('not_recorded'), note: z.string() }),
})

export const TacticalChangeResultSchema = z.looseObject({
  ...Envelope, query: z.literal('tactical_change'),
  team: z.looseObject({ teamId: z.string(), name: z.string() }),
  note: z.looseObject({ noteId: z.string(), confidence: z.literal('manual') }),
  singleMatchComparison: z.boolean(),
  within: z.looseObject({ status: z.enum(['available', 'unavailable']), confounders: z.array(z.string()) }),
  across: z.looseObject({ status: z.enum(['available', 'unavailable']) }),
  confounders: z.array(z.string()),
})

export const PlayerCatalogEntrySchema = z.looseObject({
  playerId: z.string(), name: z.string(), identityStatus: z.enum(['persistent', 'linked', 'match_local']), matches: z.number().int(),
})
export const ListPlayersResultSchema = z.looseObject({
  schemaVersion: z.string(), query: z.literal('list_players'), saveId: z.string(),
  page: z.looseObject({ limit: z.number().int(), returned: z.number().int(), totalMatching: z.number().int(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
  players: z.array(PlayerCatalogEntrySchema), summary: z.looseObject({ persistent: z.number().int(), linked: z.number().int(), matchLocal: z.number().int() }), warnings: z.array(z.string()),
})
export const TacticalNotesResultSchema = z.looseObject({
  schemaVersion: z.string(), query: z.literal('tactical_notes'), saveId: z.string(),
  page: z.looseObject({ limit: z.number().int(), returned: z.number().int(), totalMatching: z.number().int(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
  label: z.string(),
  notes: z.array(z.looseObject({ noteId: z.string(), confidence: z.literal('manual'), source: z.literal('user_entered') })),
  observedFormationChanges: z.looseObject({ source: z.literal('observed_by_plugin') }).nullable(),
  warnings: z.array(z.string()),
})

