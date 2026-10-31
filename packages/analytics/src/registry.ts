import type { NullReason } from '@fmmi/model'

/**
 * Versioned metric definition registry (spec 7.7). Single source for the CLI, the future MCP adapter and docs/metrics.md
 * (`npm run docs:metrics` regenerates the document; a test fails when the file is stale). A formula or threshold change
 * must bump the affected definition's version.
 */
export const METRIC_DICTIONARY_VERSION = '1.3'

/**
 * Dictionary version history (rendered into docs/metrics.md). A dictionary version changes whenever a definition is added, removed
 * or re-versioned; cached aggregates are keyed by it (and by each definition version they use), so a bump rebuilds them.
 */
export const METRIC_DICTIONARY_HISTORY: ReadonlyArray<{ version: string; date: string; summary: string; added: readonly string[]; changed: readonly string[] }> = [
  {
    version: '1.0', date: '2026-10-30',
    summary: 'Slice 2 dictionary: observed counters, derived ratios and per-90 rates, passes received, the passing network link, reception location, ground service (unavailable) and the finding rules.',
    added: ['counters (goals ... red_cards)', 'aerial_win_pct', 'shot_quality', 'possession_pct', 'pass_completion_pct', 'per_90_rate', 'passes_received', 'passes_received_per_90', 'passes_received_pct_of_team_completed', 'progressive_passes_per_90', 'xg_per_90', 'final_third_entry_passes', 'forward_pass_distance', 'passing_network_link', 'reception_location', 'ground_service_receptions'],
    changed: [],
  },
  {
    version: '1.1', date: '2026-10-30',
    summary: 'Adds the Slice 3b definitions that shipped under 1.0 without a bump (opposition threat by lane, rating estimates, unavailable defender items) and the Slice 4 season and trend definitions (pooled team and player rates, the season eligibility policy, unavailable non-penalty xG and wing aggregation). No existing definition changed its formula or threshold.',
    added: ['attack_lane', 'opposition_shots_by_lane', 'opposition_xg_by_lane', 'opposition_crosses_by_lane', 'opposition_passes_completed_by_lane', 'opposition_final_third_entries_by_lane', 'danger_area_entries_by_lane', 'defender_involvement_by_lane', 'conceded_goal_context', 'native_rating', 'estimated_rating_contribution', 'rating_reconstruction_residual', 'defender_clearances', 'defender_distance_covered', 'defender_sprints', 'defender_condition', 'goals_per_90', 'goals_against_per_90', 'xg_against_per_90', 'xg_difference_per_90', 'shots_per_90', 'key_passes_per_90', 'final_third_entry_passes_per_90', 'corners_per_90', 'non_penalty_xg', 'chance_creation_by_wing_trend'],
    changed: [],
  },
  {
    version: '1.2', date: '2026-10-30',
    summary: 'Slice 4 follow-up: chance creation by wing across matches (pooled counts and per-90 rates per attack lane, for and against the managed team) replaces the unavailable placeholder, and the stored season aggregate carries per-side lane counts (aggregate schema 2), so cached aggregates rebuild once.',
    added: [],
    changed: ['chance_creation_by_wing_trend (v1 unavailable -> v2 derived)'],
  },
  {
    version: '1.3', date: '2026-10-31',
    summary: 'Season eligibility policy version 2: a nonconflicting full-match capture counts in rates, totals and the record without a confirmation step (disclosed as full_capture_unconfirmed; completion stays unknown, the score is labelled observed and is not final). Partial and early-ending recordings still need a confirmation. A manual confirmation still takes precedence. Cached aggregates rebuild once.',
    added: [],
    changed: ['season_eligibility (policy v1 -> v2)'],
  },
]

/** Product quality gates and thresholds. Initial descriptive heuristics, not significance tests or calibrated norms. */
export const GATES = {
  /** Spec 7.2: configurable product gate, not statistical confidence. */
  recipientCoverageMin: 0.95,
  /** low_aerial_success_v1: attempts >= 5 and win ratio <= 25%. */
  lowAerial: { minAttempts: 5, maxWinRatio: 0.25 },
  /** Comparative findings, required in EACH window. Exposure only: never the player's own count. */
  comparative: { minPlayerMinutes: 15, minTeamCompletedPasses: 30 },
  /** Derived final-third entry: normalised attacking length. */
  finalThird: 2 / 3,
  /** Comparison context: labelled HEURISTICS, not calibrated norms. */
  context: { scoreStateShareDifference: 0.25, minutesRatioMin: 0.5, homeAwayShareDifference: 0.25 },
  /** Integer source counters reconcile exactly. */
  integerCounterTolerance: 0,
  /** xG is float32 at source (about 7 significant digits). */
  xgTolerance: 1e-6,
  /** Counters can trail the pass event by up to this many ticks (docs/data-coverage.md section 8). */
  counterLagTicks: 4,
  /**
   * Season eligibility (spec 6.3, 7.6). HEURISTIC, not a calibrated norm: a confirmed match whose capture ends early may enter season
   * RATES (never totals) when its trustworthy-baseline recording holds at least this many captured game minutes. Rate denominators
   * are the measured minutes, so a shorter recording still gives a correct rate; the floor only limits how little of a match is
   * allowed to stand for it.
   */
  season: { earlyEndingMinCapturedMinutes: 80, label: 'heuristic' },
  /** Tactical-change comparison (spec 7.1, 7.6). HEURISTICS, labelled as such. */
  tactical: { minWindowMinutes: 15, defaultMatchesEachSide: 3, maxMatchesEachSide: 10, label: 'heuristic' },
} as const

/**
 * Attack lanes (spec 7.4). A lane is a third of the pitch WIDTH, measured in metres from the metadata half-width, from the
 * ATTACKING team's perspective, so it means the same in both halves and for both teams. The recording rotates every event to
 * its own team's attack direction (flag 0x100 set = attacks toward +longitudinal), so `lateralUnit` already increases to the
 * attacking team's right (verified: DL/AML/WBL positions average 0.10-0.19, DR/AMR/MR 0.79-0.88 on the audited recording).
 */
export const LANES = {
  ids: ['left', 'centre', 'right'] as const,
  /** left: lateralUnit < leftBelow; centre: leftBelow <= lateralUnit < rightFrom; right: lateralUnit >= rightFrom. Unclamped: beyond a touchline stays in the outer lane. */
  leftBelow: 1 / 3,
  rightFrom: 2 / 3,
  mirrorRule: 'An event is placed in the lane of the team that ATTACKS. For the attacking team own events use the event lateralUnit as recorded (attack-rotated). For a defending team event (tackle, interception, aerial duel) the opposition attack direction is the reverse, so the point is mirrored with lateralUnit -> 1 - lateralUnit; the opposition left lane is the defending team right flank and the reverse. Lanes are identical in both halves and for both teams by construction.',
} as const

/** Danger area (spec 7.4): explicit rectangle in attack-rotated metres. Standard penalty-area dimensions (Laws of the Game), not read from the archive. */
export const DANGER_AREA = { depthFromGoalLineM: 16.5, halfWidthM: 20.16 } as const

/** Upstream rating reconstruction (spec 7.5). Estimates only. */
export const RATING_MODEL = {
  id: 'fmmatchlens_rating_reconstruction',
  version: 'fmmatchlens-v0.7.0-ratingCalculator',
  source: 'FMMatchLens v0.7.0 frontend/src/lib/ratingCalculator.ts (MIT), run unmodified over the last captured frame',
  unitNote: 'Internal rating units: native rating * 1000 (inferred from the 6700 baseline matching the 6.70 every player starts on).',
} as const

export type Unit = 'count' | 'percent' | 'xg' | 'xg_per_shot' | 'per_90' | 'metres' | 'normalised_pitch' | 'ticks' | 'rating' | 'rating_internal'
export type Confidence = 'recorded' | 'deterministic' | 'estimated' | 'manual'
export type MetricKind = 'observed_counter' | 'observed_value' | 'derived' | 'estimate' | 'unavailable'

export interface MetricDefinition {
  id: string
  version: number
  title: string
  kind: MetricKind
  unit: Unit
  unitVerified: boolean
  confidence: Confidence
  derivation: string
  sourceFields: string[]
  formula: string
  scope: string
  eligibility: string
  nullReasons: NullReason[]
  sampleGate: string | null
  rounding: string
  tolerance: string
  thresholds: Record<string, number | string> | null
  semantics: string
}

const ROUND_INT = 'integer'
const ROUND_1 = '1 decimal (presentation only)'
const ROUND_XG = '2 decimals (presentation only)'

interface CounterSpec { id: string; title: string; key: string; unit: Unit; team: boolean; player: boolean; semantics: string; scope: string }
const COUNTERS: CounterSpec[] = [
  { id: 'goals', title: 'Goals', key: 'goals', unit: 'count', team: true, player: true, semantics: 'Verified against the score record.', scope: 'All goals in the window (shootouts excluded).' },
  { id: 'xg', title: 'Expected goals (recorded)', key: 'xg', unit: 'xg', team: true, player: true, semantics: 'Recorded aggregate; float32 at source. Per-shot values are not substituted.', scope: 'Shots in the window.' },
  { id: 'shots', title: 'Shots', key: 'shots', unit: 'count', team: true, player: true, semantics: 'Includes woodwork; verified against shot events.', scope: 'All shots.' },
  { id: 'shots_on_target', title: 'Shots on target', key: 'shotsOnTarget', unit: 'count', team: true, player: true, semantics: 'Counter includes goals (inferred from arithmetic, docs/data-coverage.md section 5).', scope: 'All shots.' },
  { id: 'passes', title: 'Passes attempted (counter scope)', key: 'passes', unit: 'count', team: true, player: true, semantics: 'Counter scope: all passes except throw-ins; crosses are a separate counter. Verified exactly against pass events.', scope: 'counter_scope' },
  { id: 'passes_completed', title: 'Passes completed (counter scope)', key: 'passesCompleted', unit: 'count', team: true, player: true, semantics: 'Counter scope as for passes. Verified exactly against pass events.', scope: 'counter_scope' },
  { id: 'crosses', title: 'Crosses attempted', key: 'crosses', unit: 'count', team: true, player: true, semantics: 'Separate from passes. Verified against cross events.', scope: 'Crosses.' },
  { id: 'crosses_completed', title: 'Crosses completed', key: 'crossesCompleted', unit: 'count', team: true, player: true, semantics: 'Verified against cross events.', scope: 'Crosses.' },
  { id: 'aerials', title: 'Aerial duels attempted', key: 'aerials', unit: 'count', team: true, player: true, semantics: 'Verified: events (types 28/29) agree with player counters on the audited recording.', scope: 'All aerial duels.' },
  { id: 'aerials_won', title: 'Aerial duels won', key: 'aerialsWon', unit: 'count', team: true, player: true, semantics: 'Verified as for aerials.', scope: 'All aerial duels.' },
  { id: 'progressive_passes', title: 'Progressive passes (upstream counter)', key: 'progressivePasses', unit: 'count', team: true, player: true, semantics: 'Upstream cumulative counter. Its football definition is unverified and no per-event rule exists; no distance rule is substituted under this ID.', scope: 'Upstream definition.' },
  { id: 'final_third_passes', title: 'Final-third passes (upstream counter)', key: 'finalThirdPasses', unit: 'count', team: true, player: false, semantics: 'Upstream cumulative counter with unverified semantics. Distinct from the derived final_third_entry_passes.', scope: 'Upstream definition.' },
  { id: 'key_passes', title: 'Key passes', key: 'keyPasses', unit: 'count', team: false, player: true, semantics: 'Verified: flag 0x2 agrees with the player counter for all players.', scope: 'All key passes.' },
  { id: 'corners', title: 'Corners', key: 'corners', unit: 'count', team: true, player: true, semantics: 'Verified against flag 0x40 on crosses.', scope: 'Corners taken.' },
  { id: 'fouls', title: 'Fouls', key: 'fouls', unit: 'count', team: true, player: true, semantics: 'Counter used; foul events do not fully reconcile for the home side (docs/data-coverage.md section 8).', scope: 'Fouls committed.' },
  { id: 'yellow_cards', title: 'Yellow cards', key: 'yellowCards', unit: 'count', team: true, player: false, semantics: 'Team counter.', scope: 'Cards shown.' },
  { id: 'red_cards', title: 'Red cards', key: 'redCards', unit: 'count', team: true, player: false, semantics: 'Team counter.', scope: 'Cards shown.' },
]

/** Maps registry metric IDs to the source counter key suffix used in the sampled series (`team.<side>.<key>` / `player.<id>.<key>`). */
export const COUNTER_KEYS: Record<string, { key: string; team: boolean; player: boolean }> =
  Object.fromEntries(COUNTERS.map((c) => [c.id, { key: c.key, team: c.team, player: c.player }]))

const counterDef = (c: CounterSpec): MetricDefinition => ({
  id: c.id, version: 1, title: c.title, kind: 'observed_counter', unit: c.unit, unitVerified: true, confidence: 'recorded',
  derivation: c.team && c.player ? 'observed_cumulative_counter_delta_v1' : c.team ? 'observed_team_cumulative_delta_v1' : 'observed_player_cumulative_delta_v1',
  sourceFields: [c.team ? `team.<side>.${c.key}` : '', c.player ? `player.<playerId>.${c.key}` : ''].filter(Boolean),
  formula: 'counter(before window.to) - counter(before window.from); never a sum of snapshots',
  scope: c.scope,
  eligibility: 'Counter series present. A window starting before the first frame needs a verified zero baseline.',
  nullReasons: ['not_recorded', 'missing_baseline', 'unresolved_boundary', 'unverified_semantics'],
  sampleGate: null,
  rounding: c.unit === 'xg' ? ROUND_XG : ROUND_INT,
  tolerance: c.unit === 'xg' ? `${GATES.xgTolerance} (float32)` : `${GATES.integerCounterTolerance} (integer counter)`,
  thresholds: null,
  semantics: c.semantics,
})


/** Slice 4 pooled per-90 definitions. Per match: count * 90 / measured team (or player) minutes; across matches: 90 * sum(counts) / sum(minutes). */
const pooledPer90 = (id: string, title: string, source: string, rounding: string, semantics: string, scope = 'Team or player over the whole recording; pooled across eligible matches (season policy).'): MetricDefinition => ({
  id, version: 1, title, kind: 'derived', unit: 'per_90', unitVerified: true, confidence: 'deterministic',
  derivation: 'count_times_90_over_verified_minutes_v1', sourceFields: [source, 'team playing periods or participation segments'],
  formula: `${source} * 90 / verified playing minutes; across matches 90 * sum(${source}) / sum(minutes), numerators and denominators pooled, never an average of match rates`,
  scope, eligibility: 'Count resolved and minutes > 0 in the contributing match; a match with a missing count contributes to neither numerator nor denominator.',
  nullReasons: ['zero_denominator', 'missing_baseline'], sampleGate: 'Raw counts and minutes are always reported; comparative findings keep the exposure gates.', rounding,
  tolerance: 'exact', thresholds: null, semantics,
})

const DERIVED: MetricDefinition[] = [
  {
    id: 'aerial_win_pct', version: 1, title: 'Aerial win percentage', kind: 'derived', unit: 'percent', unitVerified: true, confidence: 'deterministic',
    derivation: 'ratio_of_counter_deltas_v1', sourceFields: ['aerialsWon', 'aerials'], formula: '100 * aerials_won / aerials',
    scope: 'All aerial duels in the window.', eligibility: 'Both counters resolved for the window.', nullReasons: ['zero_denominator', 'missing_baseline', 'not_recorded'],
    sampleGate: 'Raw counts are always reported; the low_aerial_success_v1 finding needs >= 5 attempts.', rounding: ROUND_1,
    tolerance: 'exact (integer counters)', thresholds: null, semantics: 'Won and attempted share one meaning (verified against events).',
  },
  {
    id: 'shot_quality', version: 1, title: 'Shot quality (xG per shot)', kind: 'derived', unit: 'xg_per_shot', unitVerified: true, confidence: 'deterministic',
    derivation: 'ratio_of_counter_deltas_v1', sourceFields: ['xg', 'shots'], formula: 'xg / shots, same scope and window',
    scope: 'Team or player shots in the window.', eligibility: 'xg and shots resolved.', nullReasons: ['zero_denominator', 'missing_baseline'],
    sampleGate: 'A single-shot window carries single_shot_window and suppresses firm chance-quality findings.', rounding: ROUND_XG,
    tolerance: `${GATES.xgTolerance}`, thresholds: null, semantics: 'Aggregate recorded xG divided by shot count; not a per-shot model.',
  },
  {
    id: 'possession_pct', version: 1, title: 'Possession share (derived)', kind: 'derived', unit: 'percent', unitVerified: false, confidence: 'deterministic',
    derivation: 'ratio_of_possession_time_deltas_v1', sourceFields: ['team.<side>.possessionTime'],
    formula: '100 * own possessionTime delta / (own + opponent possessionTime deltas); deltas first, never subtract two percentages',
    scope: 'Team, window.', eligibility: 'Both counters resolved.', nullReasons: ['zero_denominator', 'missing_baseline'], sampleGate: null, rounding: ROUND_1,
    tolerance: 'exact (integer counters)', thresholds: null,
    semantics: 'The unit of possessionTime is unverified (the two sides sum to 0.60 of elapsed ticks on the audited recording); the ratio is labelled unit-unverified.',
  },
  {
    id: 'pass_completion_pct', version: 1, title: 'Pass completion percentage (counter scope)', kind: 'derived', unit: 'percent', unitVerified: true, confidence: 'deterministic',
    derivation: 'ratio_of_counter_deltas_v1', sourceFields: ['passesCompleted', 'passes'], formula: '100 * passes_completed / passes',
    scope: 'counter_scope', eligibility: 'Both counters resolved.', nullReasons: ['zero_denominator', 'missing_baseline'], sampleGate: null, rounding: ROUND_1,
    tolerance: 'exact (integer counters)', thresholds: null, semantics: 'Does not rate progression: a high rate can come from sideways passes.',
  },
  {
    id: 'per_90_rate', version: 1, title: 'Per-90 rate (generic rule)', kind: 'derived', unit: 'per_90', unitVerified: true, confidence: 'deterministic',
    derivation: 'count_times_90_over_verified_minutes_v1', sourceFields: ['<count metric>', 'participation segments'],
    formula: 'count * 90 / verified elapsed playing minutes (players) or verified match playing minutes (teams), restricted to the covered intervals; minutes = ticks / 240 per period, halftime excluded',
    scope: 'Window clipped to the participant minutes on pitch.', eligibility: 'Count resolved and duration > 0.', nullReasons: ['zero_denominator', 'missing_baseline'],
    sampleGate: 'Comparative findings need >= 15 verified playing minutes and >= 30 team completed passes in each window.', rounding: ROUND_1,
    tolerance: 'exact', thresholds: { ticksPerMinute: 240 }, semantics: 'Wall time and nominal 90 minutes are never used.',
  },
  {
    id: 'passes_received', version: 1, title: 'Passes received (completed pass events)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'completed_pass_events_with_receiver_v1', sourceFields: ['event.kind=pass_completed', 'event.receiverPlayerId', 'participation segments'],
    formula: 'completed pass events in the selected pass scope whose receiver is the player, placed by event tick in [from,to) and inside the player minutes on pitch',
    scope: 'Selected pass scope; default counter_scope. All-pass receptions are not ground service.',
    eligibility: 'Receiver semantics verified (internal corroboration) and the section 7.2 gate for any claim about service.',
    nullReasons: ['not_recorded', 'unverified_semantics'],
    sampleGate: 'Counts are always reportable; claims about little or no service need the recipient gate and the exposure gates.', rounding: ROUND_INT,
    tolerance: 'exact', thresholds: null,
    semantics: 'Receiver is recorded for completed passes only (0 of 145 incomplete passes carry one). Boundary events at a substitution tick are flagged ambiguous.',
  },
  {
    id: 'passes_received_per_90', version: 1, title: 'Passes received per 90', kind: 'derived', unit: 'per_90', unitVerified: true, confidence: 'deterministic',
    derivation: 'count_times_90_over_verified_minutes_v1', sourceFields: ['passes_received', 'participation segments'], formula: 'passes_received * 90 / verified playing minutes in the window',
    scope: 'As passes_received.', eligibility: 'Minutes > 0.', nullReasons: ['zero_denominator'], sampleGate: 'Comparison needs the exposure gates in each window.', rounding: ROUND_1,
    tolerance: 'exact', thresholds: null, semantics: 'Exposure-normalised; no absolute low-service label exists.',
  },
  {
    id: 'passes_received_pct_of_team_completed', version: 1, title: 'Passes received as percent of team completed passes while on pitch', kind: 'derived', unit: 'percent', unitVerified: true,
    confidence: 'deterministic', derivation: 'ratio_of_event_counts_v1', sourceFields: ['passes_received', 'team completed pass events in the player minutes'],
    formula: '100 * passes_received / team completed passes (same scope) during the player minutes on pitch', scope: 'As passes_received.',
    eligibility: 'Team completed passes > 0.', nullReasons: ['zero_denominator'], sampleGate: 'Exposure gates in each window.', rounding: ROUND_1, tolerance: 'exact', thresholds: null,
    semantics: 'Team passes are counted by event tick; the denominator does not depend on the player own count.',
  },
  {
    id: 'progressive_passes_per_90', version: 1, title: 'Progressive passes per 90 (upstream counter)', kind: 'derived', unit: 'per_90', unitVerified: true, confidence: 'deterministic',
    derivation: 'count_times_90_over_verified_minutes_v1', sourceFields: ['progressive_passes', 'participation segments'], formula: 'progressive_passes delta * 90 / verified playing minutes',
    scope: 'Upstream counter; counter deltas only.', eligibility: 'Counter resolved; partial_for_window when a boundary is sampled.', nullReasons: ['zero_denominator', 'missing_baseline'],
    sampleGate: 'Exposure gates in each window.', rounding: ROUND_1, tolerance: 'exact', thresholds: null,
    semantics: 'No per-event progressive rule exists, so no event-level window split is possible.',
  },
  {
    id: 'xg_per_90', version: 1, title: 'xG per 90', kind: 'derived', unit: 'per_90', unitVerified: true, confidence: 'deterministic',
    derivation: 'count_times_90_over_verified_minutes_v1', sourceFields: ['xg', 'participation segments'], formula: 'xg delta * 90 / verified playing minutes',
    scope: 'As xg.', eligibility: 'Counter resolved and minutes > 0.', nullReasons: ['zero_denominator', 'missing_baseline'], sampleGate: null, rounding: ROUND_XG,
    tolerance: `${GATES.xgTolerance}`, thresholds: null, semantics: 'Small windows give unstable rates; read with the shot count.',
  },
  {
    id: 'final_third_entry_passes', version: 1, title: 'Final-third entries (derived)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'derived_from_completed_pass_endpoints_v1', sourceFields: ['event.source', 'event.trajectory[last]', 'event.flags&0x100', 'pitch half dimensions'],
    formula: 'completed pass (counter scope) whose start is below normalised attacking length 2/3 and whose end is at or above 2/3 on a [0,1] pitch; direction from flag 0x100 per event, so it flips between periods',
    scope: 'counter_scope completed passes.', eligibility: 'Both endpoints present, pitch dimensions known, direction known.', nullReasons: ['not_recorded'],
    sampleGate: null, rounding: ROUND_INT, tolerance: 'exact', thresholds: { finalThirdFraction: GATES.finalThird },
    semantics: 'Distinct from upstream finalThirdPasses (final_third_passes), whose semantics are unverified. Reception end is derived from the trajectory end.',
  },
  {
    id: 'forward_pass_distance', version: 1, title: 'Forward pass distance', kind: 'derived', unit: 'metres', unitVerified: true, confidence: 'deterministic',
    derivation: 'normalised_attack_axis_difference_v1', sourceFields: ['event.source', 'event.trajectory[last]', 'event.flags&0x100', 'pitch half dimensions'],
    formula: 'end minus start along the normalised attack direction, in metres; negative values are backward passes', scope: 'Completed passes of the selected scope.',
    eligibility: 'Both endpoints present and valid pitch dimensions.', nullReasons: ['not_recorded'], sampleGate: null, rounding: '1 decimal (presentation only)',
    tolerance: 'float32 coordinates', thresholds: null, semantics: 'Not the upstream progressive-pass classification; the two are never conflated.',
  },
  {
    id: 'passing_network_link', version: 1, title: 'Passing network link (completed passes)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'completed_pass_events_with_receiver_v1', sourceFields: ['event.kind=pass_completed', 'event.playerId', 'event.receiverPlayerId'],
    formula: 'directed edge passer -> receiver counts verified completed pass events in [from,to) for the selected scope. Attempts and completions are separate; incomplete passes never create an edge (no intended receiver is recorded).',
    scope: 'counter_scope (default, reconciles exactly), all_passes, or open_play (unverified: depends on flags 0x10/0x20, never compared with counter totals). Throw-ins are excluded from counter_scope and included in all_passes; crosses are never included.',
    eligibility: 'Receiver in the roster, same side as the passer, not the passer. Substituted-off players are kept; there is no on-pitch filter.',
    nullReasons: ['not_recorded', 'unverified_semantics'],
    sampleGate: 'Section 7.2 recipient gate: receiver coverage >= 95% of eligible completed passes and event totals reconciled to the equivalent counters.',
    rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance} for the full recording; sub-windows allow the pass events that straddle a sampled boundary`, thresholds: { recipientCoverageMin: GATES.recipientCoverageMin },
    semantics: 'Receiver semantics for completed passes are verified by internal corroboration only (receiver position equals trajectory end, median 0.004 m); not checked against the FM UI.',
  },
  {
    id: 'reception_location', version: 1, title: 'Reception location (derived)', kind: 'derived', unit: 'normalised_pitch', unitVerified: true, confidence: 'deterministic',
    derivation: 'derived_from_trajectory_end_v1', sourceFields: ['event.trajectory[last]', 'pitch half dimensions'],
    formula: 'trajectory end of the received completed pass, normalised to the receiving team attack direction on a [0,1] pitch',
    scope: 'Completed passes received by the player.', eligibility: 'Trajectory end present and pitch dimensions known.', nullReasons: ['not_recorded'], sampleGate: null,
    rounding: '2 decimals (presentation only)', tolerance: 'float32 coordinates', thresholds: null,
    semantics: 'Derived, not an independent measurement: the receiver position equals the trajectory end. A missing sample is never replaced by an average position.',
  },
  {
    id: 'ground_service_receptions', version: 1, title: 'Ground service', kind: 'unavailable', unit: 'count', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: [], formula: 'Verified completed receptions explicitly classified as ground passes by a validated source type or documented trajectory rule.',
    scope: 'None: no ground/air field exists in the event schema.', eligibility: 'Not met.', nullReasons: ['not_recorded', 'unverified_semantics'], sampleGate: null, rounding: ROUND_INT,
    tolerance: 'n/a', thresholds: null, semantics: 'Absence of an aerial duel does not establish ground service. Always null. All-pass receptions are the separate passes_received metric.',
  },

  // ---------------------------------------------------------------- Slice 3b: opposition threat (spec 7.4)
  {
    id: 'attack_lane', version: 1, title: 'Attack lane (left, centre, right thirds of pitch width)', kind: 'derived', unit: 'normalised_pitch', unitVerified: true, confidence: 'deterministic',
    derivation: 'width_thirds_attack_perspective_v1', sourceFields: ['event.source', 'event.flags&0x100', 'pitch half width (metadata, metres)'],
    formula: `lateralUnit = (attack-rotated lateral metres + halfWidth) / (2 * halfWidth); left if lateralUnit < ${LANES.leftBelow.toFixed(4)}, right if lateralUnit >= ${LANES.rightFrom.toFixed(4)}, otherwise centre; not clamped`,
    scope: 'Any event with a source point, or a pass trajectory end where stated.', eligibility: 'Pitch dimensions known and the event point present.', nullReasons: ['not_recorded'], sampleGate: null, rounding: ROUND_INT,
    tolerance: 'float32 coordinates', thresholds: { leftBelow: LANES.leftBelow, rightFrom: LANES.rightFrom },
    semantics: `Mirroring rule: ${LANES.mirrorRule} Handedness is verified by player position labels (left-sided positions average low lateralUnit), not assumed.`,
  },
  {
    id: 'opposition_shots_by_lane', version: 1, title: 'Opposition shots by attack lane', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'shot_events_by_origin_lane_v1', sourceFields: ['event.kind in goal|shot_on_target|shot_off_target|shot_blocked|shot_woodwork', 'event.source', 'event.flags&0x100'],
    formula: 'opposition shot events (types 1-5, all verified against shot counters) in [from,to), placed in the attack lane of the shot origin', scope: 'Shots including goals and woodwork, as the shots counter.',
    eligibility: 'Shot origin present and pitch dimensions known. Shots without a location are counted separately, never assigned to a lane.', nullReasons: ['not_recorded'],
    sampleGate: 'Raw counts are always reportable. No threat score or ranking of lanes is produced.', rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance}: lane totals plus shots without a location equal the shot events; the shots counter reconciles over a whole recording`,
    thresholds: null, semantics: 'Descriptive counts of where recorded shots started. They do not establish why a lane was used.',
  },
  {
    id: 'opposition_xg_by_lane', version: 1, title: 'Opposition xG by attack lane (per-shot, from counter steps)', kind: 'derived', unit: 'xg', unitVerified: true, confidence: 'deterministic',
    derivation: 'player_xg_counter_step_per_shot_v1', sourceFields: ['player.<playerId>.shots', 'player.<playerId>.xg', 'event.kind (shot)'],
    formula: 'For one shooter, the k-th shot event is matched to the k-th increment of that player shots counter. When a single shot accounts for the increment, its xG is the increase of that player cumulative xG counter at the same frame. Several shots between two frames, a missing or non-positive step, or event and counter totals that disagree leave the shot unattributed (never split or guessed).',
    scope: 'Shot events with a lane.', eligibility: 'Verified zero initial baseline, shots and xg series present, shooter event count equal to the final shots counter.', nullReasons: ['not_recorded', 'missing_baseline', 'unverified_semantics'],
    sampleGate: 'Reported with the number of attributed and unattributed shots; the recorded team xG is the aggregate of record and is never replaced.', rounding: ROUND_XG, tolerance: `${GATES.xgTolerance} (float32)`, thresholds: null,
    semantics: 'The event schema has no per-shot xG. This is arithmetic on recorded cumulative counters, not a shot model.',
  },
  {
    id: 'opposition_crosses_by_lane', version: 1, title: 'Opposition crosses by attack lane', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'cross_events_by_origin_lane_v1', sourceFields: ['event.kind in cross_completed|cross_incomplete', 'event.source', 'event.flags&0x100'],
    formula: 'opposition cross events (types 12-17, verified against the crosses counters) in [from,to), placed in the lane of the cross origin; the completed subset is reported beside it', scope: 'All crosses including corners (flag 0x40).',
    eligibility: 'Origin present and pitch dimensions known.', nullReasons: ['not_recorded'], sampleGate: 'Raw counts only.', rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance}`, thresholds: null,
    semantics: 'Corners are crosses in the event schema (flag 0x40) and sit in the lane of the corner origin.',
  },
  {
    id: 'opposition_passes_completed_by_lane', version: 1, title: 'Opposition completed passes by attack lane (counter scope)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'completed_pass_events_by_origin_lane_v1', sourceFields: ['event.kind=pass_completed', 'event.source', 'event.flags&0x100'],
    formula: 'opposition completed pass events in the counter scope (all passes except throw-ins) in [from,to), placed in the lane of the pass origin', scope: 'counter_scope.',
    eligibility: 'Origin present and pitch dimensions known.', nullReasons: ['not_recorded'], sampleGate: 'Raw counts only.', rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance} for the full recording; sub-windows allow boundary events`, thresholds: null,
    semantics: 'Where passes started, not where possession was won.',
  },
  {
    id: 'opposition_final_third_entries_by_lane', version: 1, title: 'Opposition final-third entries by attack lane (derived)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'derived_from_completed_pass_endpoints_v1', sourceFields: ['event.source', 'event.trajectory[last]', 'event.flags&0x100', 'pitch half dimensions'],
    formula: 'the final_third_entry_passes rule (start below 2/3 of attacking length, end at or above 2/3) applied to opposition completed counter-scope passes, placed in the lane of the pass END point', scope: 'counter_scope completed passes.',
    eligibility: 'Both endpoints present and pitch dimensions known.', nullReasons: ['not_recorded'], sampleGate: 'Raw counts only.', rounding: ROUND_INT, tolerance: 'exact', thresholds: { finalThirdFraction: GATES.finalThird },
    semantics: 'Distinct from the upstream finalThirdPasses counter. The lane is where the ball crossed into the final third.',
  },
  {
    id: 'danger_area_entries_by_lane', version: 1, title: 'Opposition danger-area entries by attack lane (derived)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'danger_area_rectangle_entry_v1', sourceFields: ['event.source', 'event.trajectory[last]', 'event.flags&0x100', 'pitch half dimensions'],
    formula: `danger area = attack-rotated points with forward distance to the goal line <= ${DANGER_AREA.depthFromGoalLineM} m and |lateral| <= ${DANGER_AREA.halfWidthM} m. An entry is an opposition completed pass (counter scope) or completed cross whose start is outside and end inside the area; lane of the END point.`,
    scope: 'Completed counter-scope passes and completed crosses.', eligibility: 'Both endpoints present and pitch dimensions known.', nullReasons: ['not_recorded'], sampleGate: 'Raw counts only.', rounding: ROUND_INT, tolerance: 'float32 coordinates',
    thresholds: { depthFromGoalLineM: DANGER_AREA.depthFromGoalLineM, halfWidthM: DANGER_AREA.halfWidthM },
    semantics: 'Geometry is the standard penalty-area rectangle (16.5 m by 40.32 m), defined here rather than read from the archive. Incomplete deliveries and carries into the area are not counted.',
  },
  {
    id: 'defender_involvement_by_lane', version: 1, title: 'Defensive involvement by lane and player (recorded events)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'verified_defensive_events_by_mirrored_lane_v1', sourceFields: ['event.kind in tackle_won|tackle_lost|interception|aerial_won|aerial_lost', 'event.playerId', 'event.source', 'participation segments'],
    formula: 'Events of the selected team of types 26/27 (tackles), 31 (interceptions) and 28/29 (aerial duels) in [from,to), counted for the actor only when the event tick lies inside that player on-pitch segments; placed in the opposition-perspective lane by mirroring (lateralUnit -> 1 - lateralUnit).',
    scope: 'Only event types reconciled against player counters (docs/data-coverage.md section 8). Clearances (24) did not reconcile and are excluded.', eligibility: 'Event point present, pitch dimensions known, actor on pitch at the event tick.',
    nullReasons: ['not_recorded'], sampleGate: 'Raw counts only. A count of involvement is not a performance measure.', rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance}`, thresholds: null,
    semantics: 'Shows where recorded defensive events happened. A tackle won is not a defensive rating; no chance or goal is attributed to a player.',
  },
  {
    id: 'conceded_goal_context', version: 1, title: 'Goals scored by the opposition (context only)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'goal_events_listed_v1', sourceFields: ['event.kind=goal', 'event.source', 'event.playerId', 'event.receiverPlayerId', 'event.tick'],
    formula: 'goal events of the opposition in [from,to) with lane of the shot origin, tick, game minute and the players recorded in the event itself (actor, and receiver when recorded)', scope: 'Goals as the goals counter.',
    eligibility: 'Goal event present.', nullReasons: ['not_recorded'], sampleGate: 'None.', rounding: ROUND_INT, tolerance: `${GATES.integerCounterTolerance}`, thresholds: null,
    semantics: 'Context only. The archive records no defender attribution for a goal; no conceded goal is attributed to any player here.',
  },
  // ---------------------------------------------------------------- Slice 3b: ratings (spec 7.5)
  {
    id: 'native_rating', version: 1, title: 'Native in-game rating (observed)', kind: 'observed_value', unit: 'rating', unitVerified: true, confidence: 'recorded',
    derivation: 'observed_player_rating_at_sampled_frame_v1', sourceFields: ['frame.players[].rating'], formula: 'rating value of the last decoded frame; not windowed',
    scope: 'Last captured frame of the recording.', eligibility: 'Frame present.', nullReasons: ['not_recorded'], sampleGate: null, rounding: ROUND_XG, tolerance: 'float32',
    thresholds: null, semantics: 'For a partial or unconfirmed recording this is the rating at the end of capture, not the final match rating. A player substituted off keeps the value from the last frame.',
  },
  {
    id: 'estimated_rating_contribution', version: 1, title: 'Estimated rating contribution by category', kind: 'estimate', unit: 'rating_internal', unitVerified: false, confidence: 'estimated',
    derivation: 'upstream_rating_reconstruction_v0_7_0', sourceFields: ['frame.players[].archiveRatingInputs', 'frame.ratingModel'],
    formula: `FMMatchLens ${RATING_MODEL.version} calculateRatingContribution over the last frame, summed into context, shooting, creativity, passing, defending and goalkeeping; reported before and after the global factor`,
    scope: 'One player, last captured frame.', eligibility: 'Rating model and inputs present, eligible playing time above zero, and every role and weight used found in the upstream table. Otherwise null with a reason.',
    nullReasons: ['not_recorded', 'not_applicable', 'unverified_semantics', 'partial'], sampleGate: 'None; always labelled estimated and shown with the residual.', rounding: ROUND_INT, tolerance: 'not reconciled to the game; see rating_reconstruction_residual',
    thresholds: null, semantics: `${RATING_MODEL.unitNote} Upstream estimate of rating mechanics from a frontend interpretation of observed weights, not official Sports Interactive causation; the game is never stated to use a weight.`,
  },
  {
    id: 'rating_reconstruction_residual', version: 1, title: 'Rating reconstruction residual', kind: 'estimate', unit: 'rating_internal', unitVerified: false, confidence: 'estimated',
    derivation: 'native_internal_score_minus_predicted_v1', sourceFields: ['frame.players[].archiveRatingInputs.internalScore', 'upstream predictedInternalScore'],
    formula: 'internalScore (as recorded) minus predictedInternalScore (baseline + scaled sum of contributions)', scope: 'One player, last captured frame.', eligibility: 'As estimated_rating_contribution.',
    nullReasons: ['not_recorded', 'not_applicable', 'unverified_semantics', 'partial'], sampleGate: null, rounding: ROUND_INT, tolerance: 'n/a',
    thresholds: null, semantics: 'Model reconciliation error, not a football contribution. Upstream notes two weights (W04, W05) remain unresolved and the sample may follow the native calculation by a few ticks.',
  },
  // ---------------------------------------------------------------- Slice 4: pooled season and trend rates
  pooledPer90('goals_per_90', 'Goals for per 90', 'goals', ROUND_1, 'Observed goal counter; the manual final score never replaces it.'),
  pooledPer90('goals_against_per_90', 'Goals against per 90', 'opponent goals', ROUND_1, 'Observed opposition goal counter over the captured interval.'),
  pooledPer90('xg_against_per_90', 'xG against per 90', 'opponent xg', ROUND_XG, 'Recorded opposition aggregate xG; per-shot values are not substituted.'),
  pooledPer90('xg_difference_per_90', 'xG difference per 90', 'xg minus opponent xg', ROUND_XG, 'Own xG minus opposition xG. A match with either side missing contributes to neither part. Non-penalty xG is unavailable (non_penalty_xg).'),
  pooledPer90('shots_per_90', 'Shots per 90', 'shots', ROUND_1, 'Shot counter, woodwork included.'),
  pooledPer90('key_passes_per_90', 'Key passes per 90', 'key_passes', ROUND_1, 'Player key-pass counter (verified against flag 0x2).', 'Player over the whole recording; pooled across eligible matches (season policy).'),
  pooledPer90('final_third_entry_passes_per_90', 'Final-third entries per 90 (derived)', 'final_third_entry_passes', ROUND_1, 'Derived entry rule (distinct from the upstream finalThirdPasses counter); needs both pass endpoints.', 'Team over the whole recording; pooled across eligible matches (season policy).'),
  pooledPer90('corners_per_90', 'Corners per 90', 'corners', ROUND_1, 'Corners taken. A proxy for set-piece volume only: set-piece xG is not recorded.', 'Team over the whole recording; pooled across eligible matches (season policy).'),
  {
    id: 'non_penalty_xg', version: 1, title: 'Non-penalty xG', kind: 'unavailable', unit: 'xg', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: [], formula: 'Not computed: penalty classification of shot events is not reliable (spec 7.1), so no penalty xG is removed from the recorded aggregate.',
    scope: 'None.', eligibility: 'Not met.', nullReasons: ['unverified_semantics'], sampleGate: null, rounding: ROUND_XG, tolerance: 'n/a', thresholds: null,
    semantics: 'Always null with unverified_semantics. Recorded xG (xg) is reported instead and is never relabelled non-penalty.',
  },
  {
    id: 'chance_creation_by_wing_trend', version: 2, title: 'Chance creation by wing across matches (pooled)', kind: 'derived', unit: 'count', unitVerified: true, confidence: 'deterministic',
    derivation: 'pooled_lane_counts_per_90_v1', sourceFields: ['opposition_shots_by_lane', 'opposition_xg_by_lane', 'opposition_crosses_by_lane', 'opposition_final_third_entries_by_lane', 'danger_area_entries_by_lane', 'attack_lane'],
    formula: 'Per match and side, the per-match lane counts of the threat query (run once with each side as the attacker): shots, per-shot xG, crosses, completed crosses, final-third entries, danger-area entries. Over the matches of a window each count is summed per lane; per90 = 90 * summed count / summed measured captured minutes of the contributing matches. Never an average of match rates.',
    scope: 'The selected team (for: lanes where it attacked; against: lanes where the opposition attacked, from the opposition perspective, so the opposition left lane runs down the selected team right flank), pooled over the eligible matches of each window (season policy).',
    eligibility: 'Pitch dimensions recorded for the match. A match without them is listed as excluded (pitch_dimensions_not_recorded) and contributes to no lane. Events without a location are counted apart (withoutLocation), never assigned to a lane. Per-shot xG that cannot be attributed is counted in xgUnattributedShots and is in no lane.',
    nullReasons: ['not_recorded'], sampleGate: 'Raw pooled counts are always reportable. No lane is ranked and no threat score is produced; per-90 rates over very few minutes are shown with their minutes.',
    rounding: 'counts are integers; summed xG is rounded to 4 decimals and per-90 rates to 3 decimals in the result (keeps the response bounded); sums and ratios are formed before rounding', tolerance: `${GATES.integerCounterTolerance} for counts (they equal the sum of the per-match lane counts); xG is a sum of float32 values`,
    thresholds: { leftBelow: LANES.leftBelow, rightFrom: LANES.rightFrom },
    semantics: 'Descriptive pooled counts per lane and direction. Early-ending recordings contribute their measured minutes to the denominator, so the counts are over the captured interval only and no unseen time is included. A difference between lanes is not a cause.',
  },
  // ---------------------------------------------------------------- unavailable (never computed)
  {
    id: 'defender_clearances', version: 1, title: 'Defender clearances', kind: 'unavailable', unit: 'count', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: ['event type 24'], formula: 'Not computed: event type 24 did not reconcile with the clearance counters (home 29 events vs counter 14; away 18 vs 11).', scope: 'None.', eligibility: 'Not met.',
    nullReasons: ['unverified_semantics'], sampleGate: null, rounding: ROUND_INT, tolerance: 'n/a', thresholds: null, semantics: 'Always null with unverified_semantics until the event meaning is established.',
  },
  {
    id: 'defender_distance_covered', version: 1, title: 'Defender distance covered', kind: 'unavailable', unit: 'metres', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: ['frame.players[].distanceM'], formula: 'Not computed: the distance counter exists but its unit, scope and reset behaviour were not verified in the audit.', scope: 'None.', eligibility: 'Not met.',
    nullReasons: ['unverified_semantics'], sampleGate: null, rounding: 'n/a', tolerance: 'n/a', thresholds: null, semantics: 'Distance by itself is not evidence of fatigue; it is not reported until a counter is verified.',
  },
  {
    id: 'defender_sprints', version: 1, title: 'Defender sprints', kind: 'unavailable', unit: 'count', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: [], formula: 'Not computed: no sprint counter was found in the archive.', scope: 'None.', eligibility: 'Not met.',
    nullReasons: ['not_recorded'], sampleGate: null, rounding: ROUND_INT, tolerance: 'n/a', thresholds: null, semantics: 'Always null with not_recorded.',
  },
  {
    id: 'defender_condition', version: 1, title: 'Defender condition or stamina', kind: 'unavailable', unit: 'percent', unitVerified: false, confidence: 'recorded',
    derivation: 'unavailable', sourceFields: [], formula: 'Not computed: condition is not in the archive; a declining rating or distance is not a condition measure.', scope: 'None.', eligibility: 'Not met.',
    nullReasons: ['not_recorded'], sampleGate: null, rounding: 'n/a', tolerance: 'n/a', thresholds: null, semantics: 'Always null with not_recorded.',
  },
]

export const METRIC_REGISTRY: readonly MetricDefinition[] = [...COUNTERS.map(counterDef), ...DERIVED]
const BY_ID = new Map(METRIC_REGISTRY.map((d) => [d.id, d]))

export function getDefinition(id: string): MetricDefinition {
  const d = BY_ID.get(id)
  if (!d) throw new Error(`Metric ${id} has no registry definition`)
  return d
}
export function hasDefinition(id: string): boolean { return BY_ID.has(id) }

/** Items without a registry definition, reported as unavailable with the reason (spec 7.3). */
export const UNAVAILABLE_COMPONENTS: ReadonlyArray<{ id: string; reason: NullReason; note: string }> = [
  { id: 'final_third_touches', reason: 'unverified_semantics', note: 'No section 7.7 registry definition yet; touch event fidelity is not audited.' },
  { id: 'support_proximity', reason: 'unverified_semantics', note: 'No section 7.7 registry definition yet; needs tracking samples and validated orientation.' },
  { id: 'opponent_centre_back_matchup', reason: 'not_applicable', note: 'Context only; not computed.' },
  { id: 'receiver_specific_attempt_rate', reason: 'not_recorded', note: 'Incomplete passes carry no receiver (0 of 145 on the audited recording).' },
  { id: 'receiver_specific_success_rate', reason: 'not_recorded', note: 'Intended recipient is not recorded.' },
  { id: 'ground_service_receptions', reason: 'not_recorded', note: 'No ground/air classification exists in the event schema.' },
  { id: 'progressive_passes_per_event', reason: 'unverified_semantics', note: 'Only cumulative counters exist; windows use counter deltas.' },
]

/** Threat items that are never computed (spec 7.4), reported with the reason. They also have kind 'unavailable' registry entries. */
export const UNAVAILABLE_THREAT: ReadonlyArray<{ id: string; reason: NullReason; note: string }> = [
  { id: 'defender_clearances', reason: 'unverified_semantics', note: 'Event type 24 did not reconcile with the clearance counters on the audited recording (home 29 events vs counter 14; away 18 vs 11).' },
  { id: 'defender_distance_covered', reason: 'unverified_semantics', note: 'A distance counter exists in the frames but its unit and scope were not verified; distance is never presented as fatigue.' },
  { id: 'defender_sprints', reason: 'not_recorded', note: 'No sprint counter exists in the archive.' },
  { id: 'defender_condition', reason: 'not_recorded', note: 'Condition or stamina is not in the archive; a declining rating or distance is not a measure of it.' },
]

/**
 * Receiver semantics for completed passes. Evidence: docs/data-coverage.md section 8. Counted as verified on internal
 * corroboration; not confirmed against the FM27 UI.
 */
export const RECEIVER_SEMANTICS = {
  status: 'verified',
  semanticsBasis: 'internal_corroboration',
  evidence: 'Receiver position equals trajectory end (median 0.004 m); receiver in roster and on the passer team for every completed pass on the audited recording.',
  verifiedAgainstUi: false,
  incompletePassReceivers: 'not_recorded',
} as const


/**
 * Season eligibility and pooling policy (spec 6.3, 7.6), implemented once in eligibility.ts and used by every season, player
 * and tactical-change query. Rendered into docs/metrics.md from this object.
 */
export const SEASON_POLICY = {
  id: 'season_eligibility', version: 2,
  rates: 'Nonconflicting matches with full_match capture, whether completed, completed_manual or still unconfirmed (an unconfirmed full capture is disclosed as full_capture_unconfirmed; its completion stays unknown and its score is observed, not final); plus confirmed matches whose capture ends early with a trustworthy baseline, no gap or missing period, and at least the early-ending minimum of captured game minutes (disclosed as early_ending).',
  totals: 'Only full_match captures. Observed totals never include unseen time, so an early-ending match is left out of totals with a reason. Win/draw/loss use the manual final score (labelled manual, and it takes precedence), a verified final score, or the observed score of an unconfirmed full-match capture (labelled observed, kept distinct from manual).',
  excluded: 'in_progress completion, unknown completion on a capture that is not full-match (a partial recording waits for a confirmation: fmmi sync), unresolved identity conflicts, partial captures that are not early-ending or fall below the minimum, and undated matches (no in-game date, so no rolling order).',
  partialOptIn: 'includePartial shows recordings excluded only for partial capture in a separate block with its own pooled rates; they are never mixed into the main comparison.',
  ordering: 'In-game match date ascending, ties by import time then match id. A replayed fixture is a separate occurrence.',
  windows: [5, 10] as const,
  earlyEndingMinCapturedMinutes: GATES.season.earlyEndingMinCapturedMinutes,
  earlyEndingLabel: GATES.season.label,
} as const

export interface FindingRuleDef { id: string; version: number; title: string; gate: string; language: string; thresholds: Record<string, number | string> }
export const FINDING_RULES: readonly FindingRuleDef[] = [
  {
    id: 'low_aerial_success_v1', version: 1, title: 'Low aerial success',
    gate: 'at least 5 verified aerial attempts in the window and aerials_won / aerials <= 25%',
    language: 'Counts only. Labelled a descriptive heuristic; it does not establish that distribution or player selection caused the outcome.',
    thresholds: { minAttempts: GATES.lowAerial.minAttempts, maxWinRatio: GATES.lowAerial.maxWinRatio },
  },
  {
    id: 'reception_rate_comparison_v1', version: 1, title: 'Reception rate comparison',
    gate: 'in EACH window: >= 15 verified playing minutes and >= 30 verified team completed passes during those minutes; equivalent pass scope; adequate coverage; a named comparator; the section 7.2 recipient gate passes',
    language: 'Reports the direction and size of the difference. No absolute low-service label.',
    thresholds: { minPlayerMinutes: GATES.comparative.minPlayerMinutes, minTeamCompletedPasses: GATES.comparative.minTeamCompletedPasses, recipientCoverageMin: GATES.recipientCoverageMin },
  },
  {
    id: 'progression_rate_comparison_v1', version: 1, title: 'Progressive-pass rate comparison',
    gate: 'in EACH window: >= 15 verified playing minutes and >= 30 verified team completed passes during those minutes; both counters resolved; a named comparator',
    language: 'Compares the upstream progressive-pass counter per 90. No absolute weak-progression label.',
    thresholds: { minPlayerMinutes: GATES.comparative.minPlayerMinutes, minTeamCompletedPasses: GATES.comparative.minTeamCompletedPasses },
  },
]

export function findingRule(id: string): FindingRuleDef {
  const r = FINDING_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`Finding rule ${id} is not registered`)
  return r
}

export const SUPPRESSED_RULE_CHANCE_QUALITY = { id: 'chance_quality', gate: 'More than one shot in the window; a single-shot window never supports a firm chance-quality finding.' } as const
