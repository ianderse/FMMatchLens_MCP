import { DomainError, TICKS_PER_MINUTE } from '@fmmi/model'
import type { CompletionStatus, NullReason, Side } from '@fmmi/model'
import { seasonEligibility } from './eligibility.ts'
import type { Eligibility } from './eligibility.ts'
import { WING_COUNTS } from './aggregate.ts'
import type { MatchAggregate, PlayerAggregate, SideLanes, WingCount } from './aggregate.ts'
import { direction, exposureGate } from './findings.ts'
import { pooledRatio } from './ratios.ts'
import { GATES, LANES, SEASON_POLICY, getDefinition } from './registry.ts'
import type { Lane } from './threat.ts'

/**
 * Pure season, player and tactical-change pooling over stored per-revision aggregates (spec 7.6). Ratios pool numerators and
 * denominators with `pooledRatio`; no match ratio is ever averaged. A match with a missing field contributes to neither part
 * of that metric and is listed as excluded for it, with the reason.
 */

// ------------------------------------------------------------------ inputs

export interface TrendMatchInput {
  matchId: string
  recordingRevisionId: string
  date: string | null
  season: string | null
  /** Import time: ties between matches played on the same in-game date. */
  importedAt: string
  /** The side the subject team (or the subject player's team) played on. */
  side: Side
  teamId: string
  opponent: { teamId: string; name: string }
  /** Identity status of the match's selected revision. */
  identityStatus: string
  completion: CompletionStatus
  manualFinalScore: { home: number; away: number; differsFromObserved: boolean } | null
  conflictingRevisionIds: string[]
  aggregate: MatchAggregate
}

export const capturedMinutesOf = (a: MatchAggregate): number => a.facts.capturedTicks / TICKS_PER_MINUTE

/** The single call every season-style query makes to decide eligibility. */
export function eligibilityOf(m: TrendMatchInput): Eligibility {
  const a = m.aggregate
  return seasonEligibility({
    identityStatus: m.identityStatus, completion: m.completion, manualFinalScore: m.manualFinalScore,
    coverage: a.facts.coverage, capturedMinutes: capturedMinutesOf(a), matchDate: m.date,
  })
}

/** In-game date ascending; ties by import time, then match id. Pure and total, so a window is reproducible. */
export function byGameOrder(a: TrendMatchInput, b: TrendMatchInput): number {
  const da = a.date ?? '', db = b.date ?? ''
  return da < db ? -1 : da > db ? 1 : a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0
}

// ------------------------------------------------------------------ pooled rows

export interface TrendRow {
  metric: string
  value: number | null
  nullReason?: NullReason
  numerator: number | null
  denominator: number | null
  /** `matchIds` is present only when some window matches did NOT contribute; absent means every match in the window contributed. */
  contributing: { matches: number; minutes: number; matchIds?: string[] }
  /** Matches left out of this metric, with the reason; absent when none. */
  excluded?: Array<{ matchId: string; reason: string }>
}

interface Part { numerator: number | null; denominator: number | null; minutes: number; reason?: string }
interface Spec<C> { id: string; unit: 'per_90' | 'percent' | 'xg_per_shot'; scale: number; part: (c: C) => Part }

interface Counter { value: number | null; reason?: string }
const opp = (s: Side): Side => (s === 'home' ? 'away' : 'home')

/** Count over measured minutes: numerator = count, denominator = minutes. */
const perNinety = (count: Counter, minutes: number): Part => (count.value === null
  ? { numerator: null, denominator: null, minutes, reason: count.reason ?? 'not_recorded' }
  : { numerator: count.value, denominator: minutes, minutes })
const ratioPart = (n: Counter, d: Counter, minutes: number): Part => (n.value === null || d.value === null
  ? { numerator: null, denominator: null, minutes, reason: n.reason ?? d.reason ?? 'not_recorded' }
  : { numerator: n.value, denominator: d.value, minutes })

interface TeamCtx { a: MatchAggregate; side: Side }
const mins = (c: TeamCtx) => capturedMinutesOf(c.a)
const counterOf = (c: TeamCtx, side: Side, k: string): Counter => {
  const v = c.a.sides[side].counters[k]
  return v === null || v === undefined ? { value: null, reason: c.a.sides[side].nullReasons[k] ?? 'not_recorded' } : { value: v }
}
const own = (k: string) => (c: TeamCtx) => counterOf(c, c.side, k)
const against = (k: string) => (c: TeamCtx) => counterOf(c, opp(c.side), k)
const perMetric = (id: string, get: (c: TeamCtx) => Counter): Spec<TeamCtx> => ({ id, unit: 'per_90', scale: 90, part: (c) => perNinety(get(c), mins(c)) })

export const TEAM_TREND_SPECS: readonly Spec<TeamCtx>[] = [
  perMetric('xg_per_90', own('xg')),
  perMetric('xg_against_per_90', against('xg')),
  perMetric('xg_difference_per_90', (c) => {
    const a = counterOf(c, c.side, 'xg'), b = counterOf(c, opp(c.side), 'xg')
    return a.value === null || b.value === null ? { value: null, reason: a.reason ?? b.reason } : { value: a.value - b.value }
  }),
  perMetric('goals_per_90', own('goals')),
  perMetric('goals_against_per_90', against('goals')),
  perMetric('shots_per_90', own('shots')),
  { id: 'shot_quality', unit: 'xg_per_shot', scale: 1, part: (c) => ratioPart(own('xg')(c), own('shots')(c), mins(c)) },
  { id: 'pass_completion_pct', unit: 'percent', scale: 100, part: (c) => ratioPart(own('passes_completed')(c), own('passes')(c), mins(c)) },
  perMetric('progressive_passes_per_90', own('progressive_passes')),
  perMetric('final_third_entry_passes_per_90', (c) => { const v = c.a.sides[c.side].finalThirdEntries; return v === null ? { value: null, reason: 'not_recorded' } : { value: v } }),
  { id: 'aerial_win_pct', unit: 'percent', scale: 100, part: (c) => ratioPart(own('aerials_won')(c), own('aerials')(c), mins(c)) },
  {
    id: 'possession_pct', unit: 'percent', scale: 100, part: (c) => {
      const a = c.a.sides[c.side].possessionTicks, b = c.a.sides[opp(c.side)].possessionTicks
      return a === null || b === null ? { numerator: null, denominator: null, minutes: mins(c), reason: 'missing_baseline' } : { numerator: a, denominator: a + b, minutes: mins(c) }
    },
  },
  perMetric('corners_per_90', own('corners')),
]

/** Default team metrics: the spec 7.6 list that fits a bounded response. */
export const DEFAULT_TEAM_METRICS = ['xg_per_90', 'xg_against_per_90', 'xg_difference_per_90', 'goals_per_90', 'goals_against_per_90', 'shot_quality', 'pass_completion_pct', 'progressive_passes_per_90', 'final_third_entry_passes_per_90', 'aerial_win_pct'] as const

interface PlayerCtx { a: MatchAggregate; p: PlayerAggregate }
const playerCounter = (c: PlayerCtx, k: string): Counter => {
  const v = c.p.counters[k]
  return v === null || v === undefined ? { value: null, reason: 'not_recorded' } : { value: v }
}
const playerMinutes = (c: PlayerCtx) => c.p.ticks / TICKS_PER_MINUTE
const DID_NOT_PLAY: Part = { numerator: null, denominator: null, minutes: 0, reason: 'did_not_play' }
const playedOnly = (f: (c: PlayerCtx) => Part) => (c: PlayerCtx): Part => (c.p.ticks > 0 ? f(c) : DID_NOT_PLAY)
const playerPer = (id: string, key: string): Spec<PlayerCtx> => ({ id, unit: 'per_90', scale: 90, part: playedOnly((c) => perNinety(playerCounter(c, key), playerMinutes(c))) })
const gated = (f: (c: PlayerCtx) => Part) => playedOnly((c) => (c.a.sides[c.p.side].recipientGate.status === 'pass' ? f(c) : { numerator: null, denominator: null, minutes: playerMinutes(c), reason: 'recipient_gate_failed' }))

export const PLAYER_TREND_SPECS: readonly Spec<PlayerCtx>[] = [
  { id: 'aerial_win_pct', unit: 'percent', scale: 100, part: playedOnly((c) => ratioPart(playerCounter(c, 'aerials_won'), playerCounter(c, 'aerials'), playerMinutes(c))) },
  playerPer('xg_per_90', 'xg'),
  playerPer('shots_per_90', 'shots'),
  { id: 'shot_quality', unit: 'xg_per_shot', scale: 1, part: playedOnly((c) => ratioPart(playerCounter(c, 'xg'), playerCounter(c, 'shots'), playerMinutes(c))) },
  playerPer('progressive_passes_per_90', 'progressive_passes'),
  playerPer('key_passes_per_90', 'key_passes'),
  { id: 'pass_completion_pct', unit: 'percent', scale: 100, part: playedOnly((c) => ratioPart(playerCounter(c, 'passes_completed'), playerCounter(c, 'passes'), playerMinutes(c))) },
  // Receiver-based: only recordings whose side passes the per-recording section 7.2 gate contribute.
  { id: 'passes_received_per_90', unit: 'per_90', scale: 90, part: gated((c) => ({ numerator: c.p.receptions, denominator: playerMinutes(c), minutes: playerMinutes(c) })) },
  { id: 'passes_received_pct_of_team_completed', unit: 'percent', scale: 100, part: gated((c) => ({ numerator: c.p.receptions, denominator: c.p.teamCompletedWhileOn, minutes: playerMinutes(c) })) },
]
export const DEFAULT_PLAYER_METRICS = ['aerial_win_pct', 'passes_received_per_90', 'passes_received_pct_of_team_completed', 'progressive_passes_per_90', 'xg_per_90', 'pass_completion_pct'] as const

export function validateMetrics<C>(requested: readonly string[] | undefined, specs: readonly Spec<C>[], defaults: readonly string[]): string[] {
  const allowed = specs.map((s) => s.id)
  const ids = requested && requested.length > 0 ? [...new Set(requested)] : [...defaults]
  const bad = ids.filter((m) => !allowed.includes(m))
  if (bad.length > 0) throw new DomainError('invalid_input', 'Unknown metric id', { reason: 'unknown_metric', unknown: bad.slice(0, 5), allowed })
  return ids
}

function poolRow<C>(spec: Spec<C>, items: ReadonlyArray<{ matchId: string; ctx: C }>): TrendRow {
  const parts = items.map((i) => ({ i, p: spec.part(i.ctx) }))
  const pooled = pooledRatio(parts.map((x) => ({ numerator: x.p.numerator, denominator: x.p.denominator })), spec.scale)
  const used = parts.filter((x) => x.p.numerator !== null && x.p.denominator !== null)
  getDefinition(spec.id) // every pooled metric has a registry definition
  const out = parts.filter((x) => x.p.numerator === null || x.p.denominator === null)
  return {
    metric: spec.id,
    value: pooled.value, ...(pooled.nullReason ? { nullReason: pooled.nullReason } : {}),
    numerator: used.length > 0 ? pooled.numerator : null, denominator: used.length > 0 ? pooled.denominator : null,
    contributing: {
      matches: used.length, minutes: Math.round(used.reduce((a, x) => a + x.p.minutes, 0) * 100) / 100,
      ...(used.length === parts.length ? {} : { matchIds: used.map((x) => x.i.matchId) }),
    },
    ...(out.length > 0 ? { excluded: out.map((x) => ({ matchId: x.i.matchId, reason: x.p.reason ?? 'not_recorded' })) } : {}),
  }
}

export const pooledTeamRows = (matches: readonly TrendMatchInput[], metrics: readonly string[]): TrendRow[] =>
  metrics.map((id) => poolRow(TEAM_TREND_SPECS.find((s) => s.id === id)!, matches.map((m) => ({ matchId: m.matchId, ctx: { a: m.aggregate, side: m.side } }))))

// ------------------------------------------------------------------ chance creation by wing (spec 7.6)

/** [pooled count, per-90 rate over the pooled measured minutes]; a tuple keeps the response bounded. */
export type WingCell = readonly [count: number, per90: number | null]
export interface WingDirection {
  byLane: Record<Lane, Record<WingCount, WingCell>>
  /** Pooled events with no usable location (never in a lane). */
  withoutLocation: Record<Exclude<WingCount, 'xg'>, number>
  /** Pooled shots whose own xG could not be attributed; their xG is in no lane. */
  xgUnattributedShots: number
}
export interface WingTrend {
  metric: 'chance_creation_by_wing_trend'
  contributing: { matches: number; minutes: number; matchIds?: string[] }
  excluded?: Array<{ matchId: string; reason: string }>
  for: WingDirection
  against: WingDirection
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp

/**
 * Pooled lane counts for the subject team, for and against, over the matches of one window. Counts are summed per lane; the per-90
 * rate is 90 * summed count / summed measured captured minutes of the contributing matches (never a mean of match rates).
 */
export function wingTrend(matches: readonly TrendMatchInput[]): WingTrend {
  const parts = matches.map((m) => ({ m, f: m.aggregate.sides[m.side].lanes, a: m.aggregate.sides[opp(m.side)].lanes }))
  const used = parts.filter((x): x is typeof x & { f: SideLanes; a: SideLanes } => x.f !== null && x.a !== null)
  const minutes = used.reduce((t, x) => t + capturedMinutesOf(x.m.aggregate), 0)
  const pool = (pick: (x: (typeof used)[number]) => SideLanes): WingDirection => {
    const byLane = {} as WingDirection['byLane']
    for (const lane of LANES.ids) {
      const row = {} as Record<WingCount, WingCell>
      for (const k of WING_COUNTS) {
        const sum = used.reduce((t, x) => t + pick(x).byLane[lane][k], 0)
        row[k] = [k === 'xg' ? round(sum, 4) : sum, minutes > 0 ? round((90 * sum) / minutes, 3) : null]
      }
      byLane[lane] = row
    }
    const wl = { shots: 0, crosses: 0, crossesCompleted: 0, finalThirdEntries: 0, dangerAreaEntries: 0 }
    let unattributed = 0
    for (const x of used) {
      for (const k of Object.keys(wl) as Array<keyof typeof wl>) wl[k] += pick(x).withoutLocation[k]
      unattributed += pick(x).xgUnattributedShots
    }
    return { byLane, withoutLocation: wl, xgUnattributedShots: unattributed }
  }
  const out = parts.filter((x) => x.f === null || x.a === null)
  return {
    metric: 'chance_creation_by_wing_trend',
    contributing: { matches: used.length, minutes: Math.round(minutes * 100) / 100, ...(used.length === parts.length ? {} : { matchIds: used.map((x) => x.m.matchId) }) },
    ...(out.length > 0 ? { excluded: out.map((x) => ({ matchId: x.m.matchId, reason: 'pitch_dimensions_not_recorded' })) } : {}),
    for: pool((x) => x.f), against: pool((x) => x.a),
  }
}

// ------------------------------------------------------------------ match summaries, record, totals

export interface TrendMatchSummary {
  matchId: string
  recordingRevisionId: string
  date: string | null
  side: Side
  opponent: { name: string }
  /** Present only for an early-ending capture; absent means a full-match capture. */
  class?: 'early_ending'
  capturedMinutes: number
  score: { for: number; against: number; basis: 'manual' | 'observed_final' | 'observed'; outcome: 'win' | 'draw' | 'loss' } | null
  disclosures: string[]
}

function scoreOf(m: TrendMatchInput, e: Eligibility): TrendMatchSummary['score'] {
  if (e.record === null) return null
  const s = e.record === 'manual' ? m.manualFinalScore! : m.aggregate.facts.observedScore
  const f = m.side === 'home' ? s.home : s.away, a = m.side === 'home' ? s.away : s.home
  return { for: f, against: a, basis: e.record, outcome: f > a ? 'win' : f < a ? 'loss' : 'draw' }
}

export function summarise(m: TrendMatchInput, e: Eligibility): TrendMatchSummary {
  return {
    matchId: m.matchId, recordingRevisionId: m.recordingRevisionId, date: m.date, side: m.side, opponent: { name: m.opponent.name },
    ...(e.matchClass === 'early_ending' ? { class: 'early_ending' as const } : {}), capturedMinutes: Math.round(capturedMinutesOf(m.aggregate) * 100) / 100, score: scoreOf(m, e), disclosures: e.disclosures,
  }
}

function recordOf(entries: ReadonlyArray<{ s: TrendMatchSummary }>) {
  const scored = entries.filter((x) => x.s.score !== null)
  const sum = (f: (s: NonNullable<TrendMatchSummary['score']>) => number) => scored.reduce((a, x) => a + f(x.s.score!), 0)
  return {
    basis: 'manual final score (labelled manual), verified final score, or the observed score of an unconfirmed full-match capture (labelled observed, not final); observed counters are never replaced by it',
    matches: scored.length, won: scored.filter((x) => x.s.score!.outcome === 'win').length, drawn: scored.filter((x) => x.s.score!.outcome === 'draw').length,
    lost: scored.filter((x) => x.s.score!.outcome === 'loss').length,
    manualScores: scored.filter((x) => x.s.score!.basis === 'manual').length, observedScores: scored.filter((x) => x.s.score!.basis === 'observed').length, goalsForPerScore: sum((s) => s.for), goalsAgainstPerScore: sum((s) => s.against),
    withoutFinalScore: entries.length - scored.length,
  }
}

export interface SeasonTotals {
  basis: string
  matches: number
  minutes: number
  goalsFor: number | null
  goalsAgainst: number | null
  xgFor: number | null
  xgAgainst: number | null
  shotsFor: number | null
  shotsAgainst: number | null
  excludedFromTotals: Array<{ matchId: string; reason: string }>
  missing?: Array<{ counter: string; matchIds: string[] }>
}

function totalsOf(items: ReadonlyArray<{ m: TrendMatchInput; e: Eligibility }>): SeasonTotals {
  const full = items.filter((x) => x.e.totals)
  const keys: Array<[string, (a: MatchAggregate, s: Side) => number | null]> = [
    ['goalsFor', (a, s) => a.sides[s].counters.goals ?? null], ['goalsAgainst', (a, s) => a.sides[opp(s)].counters.goals ?? null],
    ['xgFor', (a, s) => a.sides[s].counters.xg ?? null], ['xgAgainst', (a, s) => a.sides[opp(s)].counters.xg ?? null],
    ['shotsFor', (a, s) => a.sides[s].counters.shots ?? null], ['shotsAgainst', (a, s) => a.sides[opp(s)].counters.shots ?? null],
  ]
  const out: Record<string, number | null> = {}
  const missing: Array<{ counter: string; matchIds: string[] }> = []
  for (const [k, get] of keys) {
    let sum = 0, any = false
    const miss: string[] = []
    for (const x of full) { const v = get(x.m.aggregate, x.m.side); if (v === null) miss.push(x.m.matchId); else { sum += v; any = true } }
    out[k] = any ? sum : null
    if (miss.length > 0) missing.push({ counter: k, matchIds: miss })
  }
  return {
    basis: 'observed counters over full-match captures only; unseen time is never included',
    matches: full.length, minutes: full.reduce((a, x) => a + capturedMinutesOf(x.m.aggregate), 0),
    goalsFor: out.goalsFor!, goalsAgainst: out.goalsAgainst!, xgFor: out.xgFor!, xgAgainst: out.xgAgainst!, shotsFor: out.shotsFor!, shotsAgainst: out.shotsAgainst!,
    excludedFromTotals: items.filter((x) => !x.e.totals).map((x) => ({ matchId: x.m.matchId, reason: x.e.totalsExcludedBecause[0] ?? 'not_full_match_capture' })),
    ...(missing.length ? { missing } : {}),
  }
}

// ------------------------------------------------------------------ season windows

/** Split rows keep only the pooled value; the numerator, denominator and exclusions are on the window row (or a homeAway query). */
export interface CompactRow { metric: string; value: number | null; nullReason?: NullReason }
const compact = (r: TrendRow): CompactRow => ({ metric: r.metric, value: r.value, ...(r.nullReason ? { nullReason: r.nullReason } : {}) })

/** `nextStep` is set when the match waits for a confirmation: `fmmi sync` shows it and records the user's final score. */
export interface ExcludedMatch { matchId: string; date: string | null; reasons: string[]; nextStep?: string }
export const CONFIRM_NEXT_STEP = 'fmmi sync'

export interface SeasonTrendsCore {
  policy: { id: string; version: number; earlyEndingMinCapturedMinutes: number; earlyEndingLabel: string; documented: string }
  eligibleMatches: number
  /** Every match used by any window, oldest first, with its recording revision. Windows refer to these by matchId. */
  matches: TrendMatchSummary[]
  excluded: ExcludedMatch[]
  excludedRecordings: Array<{ matchId: string; recordingRevisionId: string; reason: 'identity_conflict' }>
  windows: Array<{
    lastN: number
    /** Set when this window holds exactly the matches of a smaller window (fewer eligible matches exist): nothing else is repeated. */
    sameMatchesAsWindow?: number
    matchIds: string[]
    disclosures: { manualConfirmation: string[]; earlyEnding: string[]; manualFinalScoreDiffersFromObserved: string[]; fullCaptureUnconfirmed: string[] }
    record: ReturnType<typeof recordOf>
    totals: SeasonTotals
    rates: TrendRow[]
    wing?: WingTrend
    splits?: { home: { matches: number; rates: CompactRow[] }; away: { matches: number; rates: CompactRow[] } }
  }>
  partial: null | { note: string; matches: Array<{ matchId: string; date: string | null; side: Side; capturedMinutes: number; completion: CompletionStatus; reasons: string[] }>; rates: TrendRow[] }
}

export interface SeasonTrendOptions { lastN: readonly number[]; homeAway?: Side; metrics: readonly string[]; includePartial: boolean; withSplits: boolean }

export function seasonTrends(all: readonly TrendMatchInput[], o: SeasonTrendOptions): SeasonTrendsCore {
  const evaluated = all.map((m) => ({ m, e: eligibilityOf(m) }))
  const included = evaluated.filter((x) => x.e.rates && (o.homeAway === undefined || x.m.side === o.homeAway)).sort((a, b) => byGameOrder(a.m, b.m))
  const excluded: ExcludedMatch[] = evaluated.filter((x) => !x.e.rates).sort((a, b) => byGameOrder(a.m, b.m)).map((x) => ({ matchId: x.m.matchId, date: x.m.date, reasons: x.e.reasons, ...(x.e.reasons.includes('completion_unknown') ? { nextStep: CONFIRM_NEXT_STEP } : {}) }))
  const excludedRecordings = all.flatMap((m) => m.conflictingRevisionIds.map((r) => ({ matchId: m.matchId, recordingRevisionId: r, reason: 'identity_conflict' as const })))
  const used = new Map<string, TrendMatchSummary>()
  const windows: SeasonTrendsCore['windows'] = []
  for (const n of o.lastN) {
    const win = included.slice(-n)
    const summaries = win.map((x) => ({ x, s: summarise(x.m, x.e) }))
    for (const x of summaries) used.set(x.x.m.matchId, x.s)
    const matchIds = win.map((x) => x.m.matchId)
    const same = windows.find((w) => w.matchIds.length === matchIds.length && w.matchIds.every((id, i) => id === matchIds[i]))
    if (same) { windows.push({ lastN: n, sameMatchesAsWindow: same.lastN, matchIds, disclosures: same.disclosures, record: same.record, totals: same.totals, rates: [] }); continue }
    const ids = (d: string) => win.filter((x) => x.e.disclosures.includes(d)).map((x) => x.m.matchId)
    const w: SeasonTrendsCore['windows'][number] = {
      lastN: n, matchIds,
      disclosures: { manualConfirmation: ids('manual_confirmation'), earlyEnding: ids('early_ending'), manualFinalScoreDiffersFromObserved: ids('manual_final_score_differs_from_observed'), fullCaptureUnconfirmed: ids('full_capture_unconfirmed') },
      record: recordOf(summaries.map((x) => ({ s: x.s }))), totals: totalsOf(win.map((x) => ({ m: x.m, e: x.e }))), rates: pooledTeamRows(win.map((x) => x.m), o.metrics),
      wing: wingTrend(win.map((x) => x.m)),
    }
    if (o.withSplits) {
      const split = (side: Side) => { const sub = win.filter((x) => x.m.side === side).map((x) => x.m); return { matches: sub.length, rates: pooledTeamRows(sub, o.metrics).map(compact) } }
      w.splits = { home: split('home'), away: split('away') }
    }
    windows.push(w)
  }
  const matches = [...used.values()].sort((a, b) => (a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : a.matchId < b.matchId ? -1 : 1)
  let partial: SeasonTrendsCore['partial'] = null
  if (o.includePartial) {
    const parts = evaluated.filter((x) => !x.e.rates && x.e.partialOptIn && (o.homeAway === undefined || x.m.side === o.homeAway)).sort((a, b) => byGameOrder(a.m, b.m))
    partial = {
      note: 'Partial recordings, shown separately. They are never pooled with the full-match comparison above; totals over them cover the captured interval only.',
      matches: parts.map((x) => ({ matchId: x.m.matchId, date: x.m.date, side: x.m.side, capturedMinutes: capturedMinutesOf(x.m.aggregate), completion: x.m.completion, reasons: x.e.reasons })),
      rates: pooledTeamRows(parts.map((x) => x.m), o.metrics),
    }
  }
  return {
    policy: {
      id: SEASON_POLICY.id, version: SEASON_POLICY.version, earlyEndingMinCapturedMinutes: SEASON_POLICY.earlyEndingMinCapturedMinutes, earlyEndingLabel: SEASON_POLICY.earlyEndingLabel,
      documented: 'docs/metrics.md, section "Season eligibility and trends"',
    },
    eligibleMatches: included.length, matches, excluded, excludedRecordings, windows, partial,
  }
}

// ------------------------------------------------------------------ player windows

export interface PlayerMatchInput extends TrendMatchInput { player: PlayerAggregate }

export interface PlayerMatchSummary {
  matchId: string
  recordingRevisionId: string
  date: string | null
  /** Present only for an early-ending capture. */
  class?: 'early_ending'
}

/** A player's pooled score-state minutes: own-side view over the player's own on-pitch minutes in the contributing matches. */
export interface PooledScoreState {
  /** Exact summed ticks (240 per game minute); every share and the confounders derive from these, so nothing is rounded before it is compared. */
  ticks: Record<'leading' | 'drawing' | 'trailing', number>
  minutes: Record<'leading' | 'drawing' | 'trailing', number>
  dominant: 'leading' | 'drawing' | 'trailing'
}
export type PooledScoreStateResult = { value: PooledScoreState; nullReason?: undefined } | { value: null; nullReason: NullReason }

export interface PlayerWindow {
  lastN: number
  /** Set when this window holds exactly the matches of a smaller window: nothing else is repeated. */
  sameMatchesAsWindow?: number
  matchIds: string[]
  /** Verified on-pitch minutes of the player in each match of `matchIds`, same order; 0 means the player did not play. */
  matchMinutes: number[]
  minutes: number
  rates: TrendRow[]
  exposure: { receptions: { minutes: number; teamCompletedPasses: number; matches: number }; progression: { minutes: number; teamCompletedPasses: number; matches: number } }
  /** Matches in which the player played (verified minutes above zero). `matchIds` is present only when some window matches did not contribute. Absent with `sameMatchesAsWindow`. */
  contributing?: { matches: number; matchIds?: string[] }
  /** Opposition faced, one team name per contributing match in game order. Absent with `sameMatchesAsWindow`. */
  opposition?: string[]
  /** Pooled score-state minutes of the player (spec 7.1); null with a reason when a contributing match lacks it. Absent with `sameMatchesAsWindow`. */
  scoreState?: PooledScoreStateResult
}

const r2s = (n: number) => Math.round(n * 100) / 100

/** Sums the players' own score-state ticks over the contributing matches. One unavailable match makes the pooled value unavailable: nothing is guessed. */
export function pooledPlayerScoreState(players: ReadonlyArray<PlayerAggregate>): PooledScoreStateResult {
  const played = players.filter((p) => p.ticks > 0)
  if (played.length === 0) return { value: null, nullReason: 'zero_denominator' }
  const t = { leading: 0, drawing: 0, trailing: 0 }
  for (const p of played) {
    if (p.scoreStateTicks === undefined) return { value: null, nullReason: 'missing_baseline' }
    if (p.scoreStateTicks === null) return { value: null, nullReason: 'not_recorded' }
    t.leading += p.scoreStateTicks.leading; t.drawing += p.scoreStateTicks.drawing; t.trailing += p.scoreStateTicks.trailing
  }
  const total = t.leading + t.drawing + t.trailing
  if (total === 0) return { value: null, nullReason: 'zero_denominator' }
  const order = ['leading', 'drawing', 'trailing'] as const
  const dominant = order.reduce((a, b) => (t[b] > t[a] ? b : a))
  return {
    value: { ticks: t, minutes: { leading: r2s(t.leading / TICKS_PER_MINUTE), drawing: r2s(t.drawing / TICKS_PER_MINUTE), trailing: r2s(t.trailing / TICKS_PER_MINUTE) }, dominant },
  }
}

export interface PlayerTrendsCore {
  /** Every match used by any window, oldest first. */
  matches: PlayerMatchSummary[]
  excluded: Array<{ matchId: string; date: string | null; reasons: string[] }>
  windows: PlayerWindow[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function playerTrends(all: readonly PlayerMatchInput[], o: { lastN: readonly number[]; homeAway?: Side; metrics: readonly string[] }): PlayerTrendsCore {
  const evaluated = all.map((m) => ({ m, e: eligibilityOf(m) }))
  const included = evaluated.filter((x) => x.e.rates && (o.homeAway === undefined || x.m.side === o.homeAway)).sort((a, b) => byGameOrder(a.m, b.m))
  const excluded = evaluated.filter((x) => !x.e.rates).sort((a, b) => byGameOrder(a.m, b.m)).map((x) => ({ matchId: x.m.matchId, date: x.m.date, reasons: x.e.reasons, ...(x.e.reasons.includes('completion_unknown') ? { nextStep: CONFIRM_NEXT_STEP } : {}) }))
  const used = new Map<string, PlayerMatchSummary>()
  const windows: PlayerWindow[] = []
  for (const n of o.lastN) {
    const win = included.slice(-n)
    for (const x of win) {
      used.set(x.m.matchId, { matchId: x.m.matchId, recordingRevisionId: x.m.recordingRevisionId, date: x.m.date, ...(x.e.matchClass === 'early_ending' ? { class: 'early_ending' as const } : {}) })
    }
    const matchIds = win.map((x) => x.m.matchId)
    const exp = (needGate: boolean) => {
      const u = win.filter((x) => x.m.player.ticks > 0 && (!needGate || x.m.aggregate.sides[x.m.player.side].recipientGate.status === 'pass'))
      return { minutes: r2(u.reduce((a, x) => a + x.m.player.ticks / TICKS_PER_MINUTE, 0)), teamCompletedPasses: u.reduce((a, x) => a + x.m.player.teamCompletedWhileOn, 0), matches: u.length }
    }
    const minutes = r2(win.reduce((a, x) => a + x.m.player.ticks / TICKS_PER_MINUTE, 0))
    const same = windows.find((w) => w.matchIds.length === matchIds.length && w.matchIds.every((id, i) => id === matchIds[i]))
    const matchMinutes = win.map((x) => r2(x.m.player.ticks / TICKS_PER_MINUTE))
    const playedIn = win.filter((x) => x.m.player.ticks > 0)
    const context = {
      contributing: { matches: playedIn.length, ...(playedIn.length < win.length ? { matchIds: playedIn.map((x) => x.m.matchId) } : {}) },
      opposition: playedIn.map((x) => x.m.opponent.name),
      scoreState: pooledPlayerScoreState(win.map((x) => x.m.player)),
    }
    if (same) { windows.push({ lastN: n, sameMatchesAsWindow: same.lastN, matchIds, matchMinutes, minutes, rates: [], exposure: same.exposure }); continue }
    const rows = o.metrics.map((id) => poolRow(PLAYER_TREND_SPECS.find((s) => s.id === id)!, win.map((x) => ({ matchId: x.m.matchId, ctx: { a: x.m.aggregate, p: x.m.player } }))))
    windows.push({ lastN: n, matchIds, matchMinutes, minutes, rates: rows, exposure: { receptions: exp(true), progression: exp(false) }, ...context })
  }
  const matches = [...used.values()].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : a.matchId < b.matchId ? -1 : 1))
  return { matches, excluded, windows }
}

export interface PlayerComparison {
  lastN: number
  subject: string
  comparator: string
  status: 'qualified' | 'suppressed'
  /** Why a side of the comparison is suppressed; absent when nothing is. */
  reasons?: string[]
  passesReceivedPer90: { subject: number; comparator: number; delta: number; direction: 'higher' | 'lower' | 'equal' } | null
  progressivePassesPer90: { subject: number; comparator: number; delta: number; direction: 'higher' | 'lower' | 'equal' } | null
  /** Reasons the two sides are not like for like, under the registry thresholds (GATES.context), judged on each side's pooled score-state minutes and minutes on the player windows. Never used to suppress a finding; nothing is adjusted for. */
  confounders: string[]
}
export interface PlayerComparisonSide {
  playerId: string
  minutes: number
  /** Number of matches in which the player played; the ids and the opposition are on the player window. */
  contributingMatches: number
  scoreState: PooledScoreStateResult
}
/** The same rule and thresholds as `comparisonConfounders` (single match) and `acrossConfounders` (tactical change), applied to two pooled sides. */
export function playerComparisonConfounders(a: PlayerComparisonSide, b: PlayerComparisonSide): string[] {
  const out: string[] = []
  if (a.scoreState.value === null || b.scoreState.value === null) out.push('score_state_unavailable')
  else {
    const st = ['leading', 'drawing', 'trailing'] as const
    const ta = a.scoreState.value.ticks, tb = b.scoreState.value.ticks
    const sa = ta.leading + ta.drawing + ta.trailing, sb = tb.leading + tb.drawing + tb.trailing
    const gap = Math.max(...st.map((k) => Math.abs(ta[k] / sa - tb[k] / sb)))
    if (a.scoreState.value.dominant !== b.scoreState.value.dominant || gap > GATES.context.scoreStateShareDifference) out.push('different_score_state')
  }
  const lo = Math.min(a.minutes, b.minutes), hi = Math.max(a.minutes, b.minutes)
  if (hi > 0 && lo / hi < GATES.context.minutesRatioMin) out.push('different_minutes_on_pitch')
  out.push('opposition_strength_unavailable')
  return out
}

/**
 * Spec 7.7 comparative gate on pooled exposure: in EACH window at least 15 verified playing minutes and 30 team completed
 * passes during those minutes. The player's own reception count never enters the gate, so a player with no receptions still
 * qualifies. Reception rates additionally need the per-recording recipient gate (already applied while pooling).
 */
export function comparePlayerWindows(subject: { id: string; windows: PlayerWindow[] }, comparator: { id: string; windows: PlayerWindow[] }): PlayerComparison[] {
  const out: PlayerComparison[] = []
  const resolve = (ws: PlayerWindow[], w: PlayerWindow) => (w.sameMatchesAsWindow ? ws.find((x) => x.lastN === w.sameMatchesAsWindow)! : w)
  for (const sw0 of subject.windows) {
    const cw0 = comparator.windows.find((w) => w.lastN === sw0.lastN)
    if (!cw0) continue
    const sw = resolve(subject.windows, sw0), cw = resolve(comparator.windows, cw0)
    const row = (w: PlayerWindow, id: string) => w.rates.find((r) => r.metric === id)?.value ?? null
    const reasons: string[] = []
    const gate = (w: PlayerWindow, which: 'receptions' | 'progression', label: string) => {
      const g = exposureGate({ playerTicks: w.exposure[which].minutes * TICKS_PER_MINUTE, teamCompletedPasses: w.exposure[which].teamCompletedPasses })
      return g.passes ? [] : g.reasons.map((r) => `${label}:${r}`)
    }
    const rr = [...gate(sw, 'receptions', 'subject'), ...gate(cw, 'receptions', 'comparator')]
    const pr = [...gate(sw, 'progression', 'subject'), ...gate(cw, 'progression', 'comparator')]
    const sRecv = row(sw, 'passes_received_per_90'), cRecv = row(cw, 'passes_received_per_90')
    const sProg = row(sw, 'progressive_passes_per_90'), cProg = row(cw, 'progressive_passes_per_90')
    const diff = (a: number | null, b: number | null, blocked: string[]) => (blocked.length > 0 || a === null || b === null ? null : { subject: a, comparator: b, delta: a - b, direction: direction(a, b) })
    const recv = diff(sRecv, cRecv, rr), prog = diff(sProg, cProg, pr)
    if (recv === null) reasons.push(...(rr.length ? rr : ['reception_rate_unavailable']))
    if (prog === null) reasons.push(...(pr.length ? pr.map((r) => `progression:${r}`) : ['progression_rate_unavailable']))
    const side = (id: string, w: PlayerWindow): PlayerComparisonSide => ({
      playerId: id, minutes: w.minutes, contributingMatches: w.contributing?.matches ?? 0,
      scoreState: w.scoreState ?? { value: null, nullReason: 'missing_baseline' },
    })
    const context = { subject: side(subject.id, sw), comparator: side(comparator.id, cw) }
    out.push({
      lastN: sw0.lastN, subject: subject.id, comparator: comparator.id, status: recv !== null || prog !== null ? 'qualified' : 'suppressed', ...(reasons.length ? { reasons } : {}),
      passesReceivedPer90: recv, progressivePassesPer90: prog, confounders: playerComparisonConfounders(context.subject, context.comparator),
    })
  }
  return out
}

// ------------------------------------------------------------------ tactical change: across matches

export interface AcrossSide {
  matches: TrendMatchSummary[]
  rates: TrendRow[]
  homeMatches: number
  awayMatches: number
  minutes: number
  scoreStateShare: { leading: number; drawing: number; trailing: number } | null
  record: ReturnType<typeof recordOf>
  opponents: string[]
}

function scoreShare(ms: readonly TrendMatchInput[]) {
  let l = 0, d = 0, t = 0
  for (const m of ms) {
    const s = m.aggregate.sides[m.side].scoreStateTicks
    if (s === null) return null
    l += s.leading; d += s.drawing; t += s.trailing
  }
  const tot = l + d + t
  return tot === 0 ? null : { leading: l / tot, drawing: d / tot, trailing: t / tot }
}

export function acrossSide(items: ReadonlyArray<{ m: TrendMatchInput; e: Eligibility }>, metrics: readonly string[]): AcrossSide {
  const summaries = items.map((x) => ({ s: summarise(x.m, x.e) }))
  return {
    matches: summaries.map((x) => x.s), rates: pooledTeamRows(items.map((x) => x.m), metrics),
    homeMatches: items.filter((x) => x.m.side === 'home').length, awayMatches: items.filter((x) => x.m.side === 'away').length,
    minutes: items.reduce((a, x) => a + capturedMinutesOf(x.m.aggregate), 0), scoreStateShare: scoreShare(items.map((x) => x.m)),
    record: recordOf(summaries), opponents: [...new Set(items.map((x) => x.m.opponent.name))],
  }
}

/**
 * Confounders between the before and after match sets. Thresholds are labelled heuristics (GATES.context). A confounder is a
 * reason the two sets are not like for like; nothing is adjusted for.
 */
export function acrossConfounders(before: AcrossSide, after: AcrossSide): string[] {
  const out: string[] = []
  if (before.scoreStateShare === null || after.scoreStateShare === null) out.push('score_state_unavailable')
  else {
    const st = ['leading', 'drawing', 'trailing'] as const
    const dom = (s: NonNullable<AcrossSide['scoreStateShare']>) => st.reduce((a, b) => (s[b] > s[a] ? b : a))
    const gap = Math.max(...st.map((k) => Math.abs(before.scoreStateShare![k] - after.scoreStateShare![k])))
    if (dom(before.scoreStateShare) !== dom(after.scoreStateShare) || gap > GATES.context.scoreStateShareDifference) out.push('different_score_state')
  }
  const lo = Math.min(before.minutes, after.minutes), hi = Math.max(before.minutes, after.minutes)
  if (hi > 0 && lo / hi < GATES.context.minutesRatioMin) out.push('different_minutes_on_pitch')
  const homeShare = (s: AcrossSide) => s.homeMatches / Math.max(1, s.homeMatches + s.awayMatches)
  if (Math.abs(homeShare(before) - homeShare(after)) > GATES.context.homeAwayShareDifference) out.push('different_home_away_mix')
  if (before.matches.length === 1 || after.matches.length === 1) out.push('single_match_on_one_side')
  out.push('opposition_strength_unavailable')
  return out
}

export function acrossDeltas(before: AcrossSide, after: AcrossSide) {
  return before.rates.map((b, i) => {
    const a = after.rates[i]!
    return { metric: b.metric, before: b.value, after: a.value, delta: b.value === null || a.value === null ? null : a.value - b.value }
  })
}
