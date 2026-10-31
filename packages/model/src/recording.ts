import type { SampledCounters } from './time.ts'
import type { Boundary, CaptureCoverage, FileIntegrity, NullReason, ObservedScore, PeriodSpan, PlaySegment, Side } from './types.ts'

export interface RoleAssignment { position: string; role: string; duty: string | null }
export interface RoleTimelineEntry {
  /** Tick at which the plugin noticed the assignment, not necessarily when the manager acted. */
  capturedTick: number
  position: string | null
  inPossession: RoleAssignment | null
  outOfPossession: RoleAssignment | null
}

export interface Participation {
  status: 'played' | 'unused_substitute'
  enteredAs: 'starter' | 'substitute' | null
  segments: PlaySegment[]
  elapsedTicks: number
  elapsedMinutes: number
  firstOn: Boundary | null
  lastOff: Boundary | null
  onPitchAtEndOfRecording: boolean
  /** True when a same-tick substitution batch involves this player: off/on pairing is not recorded. */
  sameTickBatch: boolean
}

export interface Participant {
  /** Match-local identity: the upstream player id (equals uid in the audited recording; persistence across matches unverified). */
  upstreamPlayerId: number
  uid: number | null
  slot: number
  side: Side
  name: string
  shirtNumber: number | null
  position: string | null
  participation: Participation
  roleTimeline: RoleTimelineEntry[]
  nativeRating: number | null
  /** Cumulative counters at the last frame. Substituted-off players keep theirs. Absent key = not recorded. */
  counters: Record<string, number>
  hasPositionSamples: boolean
}

export interface SubstitutionBatch {
  side: Side
  period: number
  tick: number
  off: number[]
  on: number[]
  pairing: 'not_recorded'
}

export interface TeamInfo {
  uid: number | null
  clubUid: number | null
  name: string
  managerIsHuman: boolean | null
}

export type CoordinateFrame = {
  /** Source metres, pitch-centred, as recorded. Never clamped. */
  lateralM: number
  longitudinalM: number
}
export interface AttackNormalised {
  attackDirection: 'toward_positive_longitudinal' | 'toward_negative_longitudinal'
  /** Rotated so the event team always attacks toward +forward. Metres, unclamped. */
  lateralM: number
  forwardM: number
  /** 0..1 over the pitch when pitch dimensions are known (may fall outside 0..1). */
  lateralUnit: number | null
  forwardUnit: number | null
}

export interface NormalizedEvent {
  /** Event `sequenceIndex`: the identity inside this recording (not eventIndex). */
  eventId: number
  type: number
  kind: string
  semantics: 'verified' | 'unverified' | 'unmapped'
  side: Side
  /** Upstream player ids, joined on id (event slots are side-local). */
  playerId: number
  receiverPlayerId: number | null
  receiverNullReason: NullReason | null
  tick: number
  completionTick: number
  period: number | null
  periodNullReason: 'in_period_gap' | 'outside_capture' | null
  flags: number
  keyPass: boolean
  throwIn: boolean
  source: CoordinateFrame
  normalised: AttackNormalised
  trajectory: CoordinateFrame[]
  versions: number
  firstSeenFrameSequence: number
}

export interface TeamTotals { [counter: string]: number }

export interface NormalizedRecording {
  schemaVersion: string
  source: { kind: 'fmlens_archive' | 'fmlens_live_api'; format: string; upstreamMatchId: string; startedUnixMs: number; endedUnixMs: number | null; sizeBytes: number }
  parser: { name: string; version: string; upstream: string }
  integrity: FileIntegrity
  matchDate: string | null
  competition: { uid: number | null; name: string } | null
  pitch: { halfWidthM: number; halfLengthM: number } | null
  teams: { home: TeamInfo; away: TeamInfo }
  humanControlledSide: Side | null
  periods: PeriodSpan[]
  frameCount: number
  firstBoundary: Boundary
  lastBoundary: Boundary
  observedScore: ObservedScore
  teamTotals: { home: TeamTotals; away: TeamTotals }
  roster: Participant[]
  substitutionBatches: SubstitutionBatch[]
  metadataRevisions: number
  eventSummary: { distinct: number; withRevisions: number; byKind: Record<string, number> }
  coverage: CaptureCoverage
  warnings: string[]
}

export type RatingCategory = 'context' | 'shooting' | 'creativity' | 'passing' | 'defending' | 'goalkeeping'

/**
 * Upstream's reconstruction of one player's rating at the last captured frame. An ESTIMATE of rating mechanics, never an
 * observed value and never official Sports Interactive causation. Units are the archive's internal rating units
 * (native rating * 1000, inferred: the baseline 6700 is the 6.70 every player starts on).
 */
export interface RatingEstimate {
  contributions: Array<{ category: RatingCategory; preFactor: number; postFactor: number }>
  baseline: number
  preFactorTotal: number
  effectiveFactor: number
  globalFactorAdjustment: number
  predictedInternalScore: number
  internalScore: number
  /** internalScore minus predictedInternalScore: reconstruction error, not a football contribution. */
  reconstructionResidual: number
  eligibleDurationTicks: number
  classificationDurations: Array<{ categoryBit: number; duration: number }>
  qualityFlags: string[]
}
export interface RatingPlayerEvidence {
  nativeRating: number
  /** Null when the model data is missing or the reconstruction is not trustworthy; the reason says which. */
  estimate: RatingEstimate | null
  nullReason: NullReason | null
  reason: string | null
  qualityFlags: string[]
}
export interface RatingEvidence {
  /** The frame every rating and estimate is sampled at: the last decoded frame. */
  sampledAt: { period: number; tick: number; displayMinute: number }
  matchPhase: number | null
  players: Map<number, RatingPlayerEvidence>
}

/** In-memory only: events and counter series are re-derived from the retained snapshot, not stored in SQLite. */
export interface DecodedRecording {
  recording: NormalizedRecording
  events: NormalizedEvent[]
  sampled: SampledCounters
  /** Rating evidence at the last frame; absent when the archive carries no rating model. */
  ratings?: RatingEvidence
}
