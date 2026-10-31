import type { CompletionStatus, CoverageStatus } from '@fmmi/model'
import { GATES } from './registry.ts'

/**
 * The one season-eligibility function (spec 6.3, 7.6). Every season, player and tactical-change query decides which recordings
 * count by calling this and nothing else, so the policy cannot drift between tools. Pure: it sees only the facts below.
 */
export interface EligibilityFacts {
  /** Identity status of the match's SELECTED revision: only `ok` and `separate_occurrence` are nonconflicting. */
  identityStatus: string
  completion: CompletionStatus
  /** Present when the user confirmed full time with a score. */
  manualFinalScore: { home: number; away: number; differsFromObserved: boolean } | null
  coverage: { status: CoverageStatus; reasons: readonly string[]; initialBaseline: 'zero_verified' | 'unverified'; endCaptureEndsAt: unknown | null }
  /** Captured game minutes: the summed span of the recorded periods. */
  capturedMinutes: number
  matchDate: string | null
}

export type MatchClass = 'full_match' | 'early_ending' | 'partial_recording' | 'not_applicable'
export type RecordBasis = 'manual' | 'observed_final'

export interface Eligibility {
  /** Counts toward season RATES (measured-minute denominators). */
  rates: boolean
  /** Counts toward season TOTALS: observed counters over a full-match capture only. */
  totals: boolean
  /** Win/draw/loss source: the manual final score (labelled manual) or a verified final score; null when no final score is known. */
  record: RecordBasis | null
  matchClass: MatchClass
  /** Why the match is out of the default (rates) set. Empty when `rates` is true. */
  reasons: string[]
  /** Things a reader must be told about an included match. */
  disclosures: string[]
  /** True when only the partial-capture rule excluded it, so the explicit partial opt-in may show it in a separate block. */
  partialOptIn: boolean
  /** Why an included match is left out of totals (empty when `totals` is true or the match is excluded entirely). */
  totalsExcludedBecause: string[]
}

/** Coverage reasons that mean "the recording stopped early", as opposed to a gap, a missing period or an untrusted baseline. */
const EARLY_ENDING_REASONS: readonly string[] = ['recording_ends_before_regulation_end', 'recovered_prefix', 'not_cleanly_closed']

export function seasonEligibility(f: EligibilityFacts): Eligibility {
  const out: Eligibility = { rates: false, totals: false, record: null, matchClass: 'not_applicable', reasons: [], disclosures: [], partialOptIn: false, totalsExcludedBecause: [] }
  if (f.identityStatus !== 'ok' && f.identityStatus !== 'separate_occurrence') out.reasons.push('identity_conflict_unresolved')
  if (f.completion === 'unknown' || f.completion === 'in_progress') out.reasons.push(f.completion === 'unknown' ? 'completion_unknown' : 'completion_in_progress')
  if (f.matchDate === null) out.reasons.push('match_date_unavailable')

  const completed = f.completion === 'completed' || f.completion === 'completed_manual'
  const full = f.coverage.status === 'full_match'
  if (!full) {
    const reasons = f.coverage.reasons
    const earlyOnly = reasons.length > 0 && reasons.every((r) => EARLY_ENDING_REASONS.includes(r)) && f.coverage.endCaptureEndsAt !== null && f.coverage.initialBaseline === 'zero_verified'
    if (earlyOnly && f.capturedMinutes >= GATES.season.earlyEndingMinCapturedMinutes) {
      out.matchClass = 'early_ending'
    } else {
      out.matchClass = 'partial_recording'
      if (earlyOnly) out.reasons.push(`early_ending_below_${GATES.season.earlyEndingMinCapturedMinutes}_captured_minutes`)
      else out.reasons.push('partial_capture', ...reasons.map((r) => `capture:${r}`))
    }
  } else out.matchClass = 'full_match'

  if (out.reasons.length > 0) {
    // The explicit opt-in is for partial recordings only: nothing excluded for identity or an unusable date is resurrected.
    out.partialOptIn = !full && !out.reasons.includes('identity_conflict_unresolved') && !out.reasons.includes('match_date_unavailable')
    return out
  }

  out.rates = true
  out.record = completed ? (f.completion === 'completed_manual' ? 'manual' : 'observed_final') : null
  if (f.completion === 'completed_manual') out.disclosures.push('manual_confirmation')
  if (f.manualFinalScore?.differsFromObserved) out.disclosures.push('manual_final_score_differs_from_observed')
  if (out.matchClass === 'early_ending') {
    out.disclosures.push('early_ending')
    out.totalsExcludedBecause.push('early_ending_unseen_time')
  } else out.totals = true
  return out
}
