import { GAP_TOLERANCE_TICKS, REGULATION_END_DISPLAY_TICKS, TICKS_PER_MINUTE } from './constants.ts'
import type { CaptureCoverage, FileIntegrity, MatchCompletion, ObservedScore, PeriodSpan, ResultView } from './types.ts'

export interface CoverageInput {
  integrity: FileIntegrity
  periods: PeriodSpan[]
  gaps: { overToleranceCount: number; largestGapTicks: number; samplingGapCount: number; missingTicks: number }
  initialBaseline: 'zero_verified' | 'unverified'
}

export function round(n: number, d: number): number { const f = 10 ** d; return Math.round(n * f) / f }

/**
 * Capture coverage from the recording alone (spec 6.3). Match confirmation never enters here.
 * full_match needs: trustworthy baseline, valid file, contiguous periods, no in-period gap over GAP_TOLERANCE_TICKS,
 * and a recording that reaches full time. The format has no full-time marker, so "reaches full time" is inferred as:
 * last frame at or after regulation end (period 2 display tick >= 90:00, or a later period). A recording that ends
 * earlier is partial with endCaptureEndsAt set, whatever the user later confirms.
 */
export function deriveCoverage(i: CoverageInput): CaptureCoverage {
  const reasons: string[] = []
  const notes: string[] = []
  const last = i.periods[i.periods.length - 1]
  if (i.integrity.status !== 'valid') reasons.push('recovered_prefix')
  else if (!i.integrity.cleanClose) reasons.push('not_cleanly_closed')
  if (i.initialBaseline !== 'zero_verified') reasons.push('initial_baseline_unverified')
  if (i.gaps.overToleranceCount > 0) reasons.push('gap_exceeds_tolerance')
  const present = new Set(i.periods.map((p) => p.period))
  for (let p = 1; last && p <= last.period; p++) {
    if (!present.has(p)) { reasons.push('missing_period'); break }
  }
  const reachedRegulationEnd = !!last && (last.period >= 3 || (last.period === 2 && last.lastDisplayTick >= REGULATION_END_DISPLAY_TICKS))
  if (last && !reachedRegulationEnd) reasons.push('recording_ends_before_regulation_end')
  let endCaptureEndsAt: CaptureCoverage['endCaptureEndsAt'] = null
  if (last && (!reachedRegulationEnd || i.integrity.status !== 'valid' || !i.integrity.cleanClose)) {
    endCaptureEndsAt = { period: last.period, tick: last.lastTick, displayMinute: round(last.lastDisplayTick / TICKS_PER_MINUTE, 2) }
  }
  if (reasons.length === 0) notes.push('full_time_not_signalled_by_source')
  return {
    status: reasons.length === 0 ? 'full_match' : 'partial',
    reasons, notes, initialBaseline: i.initialBaseline, periods: i.periods,
    gaps: {
      toleranceTicks: GAP_TOLERANCE_TICKS, countOverTolerance: i.gaps.overToleranceCount, largestGapTicks: i.gaps.largestGapTicks,
      samplingGapCount: i.gaps.samplingGapCount, missingTicks: i.gaps.missingTicks,
    },
    endCaptureEndsAt,
  }
}

export function baseCompletion(): MatchCompletion {
  return { status: 'unknown', evidence: 'no_source_full_time_signal; clean close is file integrity only', manualFinalScore: null }
}

export function applyConfirmation(base: MatchCompletion, c: { home: number; away: number; confirmedAt: string } | null, observed: ObservedScore): MatchCompletion {
  if (!c) return base
  return {
    status: 'completed_manual',
    evidence: 'user_confirmation_audited',
    manualFinalScore: { ...c, differsFromObserved: c.home !== observed.home || c.away !== observed.away },
  }
}

export function deriveResult(observed: ObservedScore, completion: MatchCompletion): ResultView {
  const m = completion.manualFinalScore
  if (completion.status === 'completed_manual' && m) {
    return { observed, final: { home: m.home, away: m.away, basis: 'manual' }, label: 'final_manual' }
  }
  return { observed, final: null, label: 'observed_not_final' }
}

export function parseScore(s: string): { home: number; away: number } | null {
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(s.trim())
  return m ? { home: Number(m[1]), away: Number(m[2]) } : null
}
