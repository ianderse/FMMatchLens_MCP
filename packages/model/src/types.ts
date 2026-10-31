export type Side = 'home' | 'away'

/** Canonical boundary (spec 7.1). `sequence` is a tie-breaker only between records of the same kind. */
export interface Boundary { period: number; tick: number; sequence: number }

export type NullReason =
  | 'not_recorded' | 'unsupported_version' | 'partial' | 'unverified_semantics'
  | 'missing_baseline' | 'unresolved_boundary' | 'zero_denominator' | 'not_applicable'

export type Measured<T> = { value: T; reason?: undefined } | { value: null; reason: NullReason }

export type FileIntegrityStatus = 'valid' | 'recovered_prefix' | 'invalid'
export interface FileIntegrity {
  status: FileIntegrityStatus
  cleanClose: boolean
  lastValidatedBoundary: { period: number; tick: number } | null
  error: string | null
  framesDecoded: number
  blocksDecoded: number
}

export interface PeriodSpan {
  period: number
  frames: number
  firstTick: number
  lastTick: number
  firstDisplayTick: number
  lastDisplayTick: number
}

export type CoverageStatus = 'full_match' | 'partial' | 'unknown'
export interface CaptureCoverage {
  status: CoverageStatus
  reasons: string[]
  notes: string[]
  initialBaseline: 'zero_verified' | 'unverified'
  periods: PeriodSpan[]
  gaps: {
    toleranceTicks: number
    countOverTolerance: number
    largestGapTicks: number
    samplingGapCount: number
    missingTicks: number
  }
  /** Set when capture stops before regulation end or the file is a recovered prefix. */
  endCaptureEndsAt: { period: number; tick: number; displayMinute: number } | null
}

export type CompletionStatus = 'completed' | 'completed_manual' | 'in_progress' | 'unknown'
export interface MatchCompletion {
  status: CompletionStatus
  evidence: string
  manualFinalScore: { home: number; away: number; confirmedAt: string; differsFromObserved: boolean } | null
}

export interface ObservedScore { home: number; away: number; at: { period: number; tick: number; displayMinute: number } }
export interface ResultView {
  observed: ObservedScore
  final: { home: number; away: number; basis: 'manual' } | null
  label: 'observed_not_final' | 'final_manual' | 'final'
}

export interface PlaySegment {
  period: number
  fromTick: number
  /** Exclusive end tick. */
  toTick: number
  fromReason: 'start_of_capture' | 'period_start' | 'on_pitch'
  toReason: 'off_pitch' | 'period_end' | 'recording_end'
}
