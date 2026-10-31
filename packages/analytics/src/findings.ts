import { TICKS_PER_MINUTE } from '@fmmi/model'
import { FINDING_RULES, GATES, SUPPRESSED_RULE_CHANCE_QUALITY, findingRule } from './registry.ts'

export interface Finding {
  ruleId: string
  ruleVersion: number
  subject: { playerId: string; name: string }
  /** Counts and values the sentence is built from; the renderer escapes names itself. */
  facts: Record<string, number | string | null>
  label: 'descriptive_heuristic' | 'descriptive_comparison'
  comparator?: { playerId: string; name: string }
  warnings: string[]
}
export interface SuppressedFinding { ruleId: string; subject?: { playerId: string; name: string }; reasons: string[] }

// ------------------------------------------------------------------ low_aerial_success_v1

export interface AerialGate { eligible: boolean; fires: boolean; reasons: string[] }

/** >= 5 verified attempts and won/attempted <= 25%. Integer arithmetic so the equality case is exact. */
export function lowAerialSuccessGate(attempts: number | null, won: number | null): AerialGate {
  if (attempts === null || won === null) return { eligible: false, fires: false, reasons: ['aerial_counters_unresolved'] }
  if (attempts < GATES.lowAerial.minAttempts) return { eligible: false, fires: false, reasons: [`fewer_than_${GATES.lowAerial.minAttempts}_attempts`] }
  if (won > attempts || won < 0) return { eligible: false, fires: false, reasons: ['aerial_counters_inconsistent'] }
  // won/attempts <= 1/4  <=>  4*won <= attempts. maxWinRatio is 0.25.
  const fires = won * (1 / GATES.lowAerial.maxWinRatio) <= attempts
  return { eligible: true, fires, reasons: fires ? [] : ['win_ratio_above_threshold'] }
}

// ------------------------------------------------------------------ comparative gates

export interface Exposure { playerTicks: number; teamCompletedPasses: number }
export interface ExposureGate { passes: boolean; playerMinutes: number; teamCompletedPasses: number; reasons: string[] }

/** Exposure only: the gate never looks at the player's own reception or progression count. */
export function exposureGate(e: Exposure): ExposureGate {
  const reasons: string[] = []
  if (e.playerTicks < GATES.comparative.minPlayerMinutes * TICKS_PER_MINUTE) reasons.push(`fewer_than_${GATES.comparative.minPlayerMinutes}_verified_playing_minutes`)
  if (e.teamCompletedPasses < GATES.comparative.minTeamCompletedPasses) reasons.push(`fewer_than_${GATES.comparative.minTeamCompletedPasses}_team_completed_passes`)
  return { passes: reasons.length === 0, playerMinutes: e.playerTicks / TICKS_PER_MINUTE, teamCompletedPasses: e.teamCompletedPasses, reasons }
}

export type Direction = 'higher' | 'lower' | 'equal'
export const direction = (a: number, b: number): Direction => (a > b ? 'higher' : a < b ? 'lower' : 'equal')

// ------------------------------------------------------------------ chance quality

/** Firm chance-quality findings need more than one shot. Returns the suppression reasons (empty = not suppressed). */
export function chanceQualitySuppression(shots: number | null): string[] {
  if (shots === null) return ['shots_unresolved']
  if (shots === 0) return ['zero_shots']
  if (shots === 1) return ['single_shot_window']
  return []
}

export function suppressedChanceQuality(subject: SuppressedFinding['subject'], shots: number | null): SuppressedFinding | null {
  const reasons = chanceQualitySuppression(shots)
  return reasons.length > 0 && shots === 1 ? { ruleId: SUPPRESSED_RULE_CHANCE_QUALITY.id, subject, reasons } : null
}

// ------------------------------------------------------------------ wording

const pct1 = (n: unknown) => (typeof n === 'number' ? n.toFixed(1) : 'n/a')
const num1 = (n: unknown) => (typeof n === 'number' ? n.toFixed(1) : 'n/a')

/**
 * Deterministic wording. Counts, rates and thresholds only: no recommendation, no hypothesis and no causal language.
 * `esc` escapes untrusted names for the target format.
 */
export function describeFinding(f: Finding, esc: (s: string) => string = (s) => s): string {
  const name = esc(f.subject.name)
  const fa = f.facts
  switch (f.ruleId) {
    case 'low_aerial_success_v1':
      return `${name} won ${fa.won} of ${fa.attempts} aerial duels (${pct1(fa.winPct)}%). Rule low_aerial_success_v1 applies at ${fa.minAttempts} or more attempts and a win ratio of ${pct1(Number(fa.maxWinRatio) * 100)}% or lower; this is a descriptive heuristic on counts and does not establish a cause.`
    case 'reception_rate_comparison_v1': {
      const other = esc(f.comparator?.name ?? '')
      return `${name} received ${fa.receptions} completed passes in ${num1(fa.minutes)} minutes (${num1(fa.perNinety)} per 90; ${pct1(fa.pctOfTeam)}% of ${fa.teamCompletedPasses} team completed passes in those minutes). ${other} received ${fa.otherReceptions} in ${num1(fa.otherMinutes)} minutes (${num1(fa.otherPerNinety)} per 90; ${pct1(fa.otherPctOfTeam)}% of ${fa.otherTeamCompletedPasses}). Difference in receptions per 90: ${fa.deltaPerNinety === null ? 'n/a' : num1(fa.deltaPerNinety)} (${name}: ${fa.direction}). Observational comparison of rates only.${contextSentence(fa)}`
    }
    case 'progression_rate_comparison_v1': {
      const other = esc(f.comparator?.name ?? '')
      return `${name} recorded ${fa.progressive} upstream progressive passes in ${num1(fa.minutes)} minutes (${num1(fa.perNinety)} per 90). ${other} recorded ${fa.otherProgressive} in ${num1(fa.otherMinutes)} minutes (${num1(fa.otherPerNinety)} per 90). Difference per 90: ${fa.deltaPerNinety === null ? 'n/a' : num1(fa.deltaPerNinety)} (${name}: ${fa.direction}). Observational comparison of the upstream counter only.${contextSentence(fa)}`
    }
    default:
      return `${name}: ${f.ruleId}`
  }
}

function contextSentence(fa: Record<string, number | string | null>): string {
  if (fa.confounders === undefined) return ''
  const m = (k: string) => (typeof fa[k] === 'number' ? (fa[k] as number).toFixed(1) : 'n/a')
  return ` Score state while on pitch (minutes leading/drawing/trailing): subject ${m('ssLead')}/${m('ssDraw')}/${m('ssTrail')}, comparator ${m('osLead')}/${m('osDraw')}/${m('osTrail')}. Context flags: ${fa.confounders || 'none'}. The comparison is not adjusted for these.`
}

export function ruleVersionOf(ruleId: string): number { return findingRule(ruleId).version }
export const REGISTERED_RULE_IDS: readonly string[] = FINDING_RULES.map((r) => r.id)
