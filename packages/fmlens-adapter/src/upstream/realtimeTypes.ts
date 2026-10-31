// EXCERPT of FMMatchLens v0.7.0 frontend/src/api/realtimeMatch.ts lines 48-316 (type declarations only, verbatim).
// MIT, Copyright (c) 2026 osnsyc. Only the import header differs.
import type { PlayerAttributes, PlayerPositionFamiliarities, PlayerProfile, PlayerStats, PlayerTacticalAssignment, TeamSide } from "./match.ts"

export type RealtimeTeam = {
  goals: number
  xg: number
  possessionTime: number
  shots: number
  shotsOnTarget: number
  firstHalfShots: number
  secondHalfShots: number
  shotsOffTarget: number
  blockedShots: number
  clearCutChances: number
  passes: number
  passesCompleted: number
  crosses: number
  crossesCompleted: number
  aerials: number
  aerialsWon: number
  progressivePasses: number
  finalThirdPasses: number
  tacklesAttempted: number
  tacklesWon: number
  fouls: number
  corners: number
  offsides: number
  yellowCards: number
  redCards: number
}

export type RealtimePlayer = PlayerStats & {
  slot: number
  playerId: number
  team: TeamSide
  isBallHolder: boolean
  x: number
  y: number
  /** Integer wire value; divide by 100 for m/s. */
  speedCentimetersPerSecond?: number
  angleDegrees?: number
  rating: number
  isSubstitute: boolean
  isOnPitch: boolean
  subbedOnMinute: number
  subbedOffMinute: number
  penalties: number
  ownGoals: number
  shotsFaced: number
  savesHeld: number
  savesParried: number
  savesTipped: number
  ratingInputs?: RealtimeRatingInputs
  archiveRatingInputs?: ArchiveRatingInputs
  ratingContribution?: RatingContribution
}

/** Compact binary-archive input retained until its frame is displayed. */
export type ArchiveRatingInputs = {
  /** The 36 archive-only bytes not already represented by RealtimePlayer stats. */
  statsPacked: Uint8Array
  internalW25: number
  internalW24: number
  specialW2C: number
  specialW2D: number
  specialW2E: number
  specialW2F: number
  specialW30: number
  specialW31: number
  internalScore: number
  specialConditionA: number
  specialConditionB: number
  inPossessionRoleDuty: bigint
  outOfPossessionRoleDuty: bigint
  totalEligibleDuration: number
  classificationDurations: RatingClassificationDuration[]
  qualityFlags: string[]
  ratingEvents: Uint8Array[]
}

export type RealtimeRatingInputs = {
  /** Base64-encoded 36-byte rating-only stat vector. */
  statsPacked: string
  internalW25: number
  internalW24: number
  specialW2C: number
  specialW2D: number
  specialW2E: number
  specialW2F: number
  specialW30: number
  specialW31: number
  rawInternalRating: number
  specialConditionA: number
  specialConditionB: number
  /** Decimal uint64 strings preserve the raw role/duty values losslessly over JSON. */
  inPossessionRoleDuty: string
  outOfPossessionRoleDuty: string
  totalEligibleDuration: number
  ratingEventsCommonLength: number
  ratingEventsTail: string[]
}

export type RealtimeRatingModel = {
  ratingBaseCondition: number
  matchPhase: number
  eventRewardBranch: number
  activeBaseline: number
  homeBackgroundInput: number
  awayBackgroundInput: number
}

export type RatingContribution = {
  nativeRating: number
  internalScore: number
  groupContributionsPreFactor: Record<RatingContributionGroup, number>
  groupContributionsPostFactor: Record<RatingContributionGroup, number>
  preFactorTotal: number
  selectedFactorIndex: number
  selectedBaseFactor: number
  effectiveFactor: number
  globalFactorAdjustment: number
  predictedInternalScore: number
  reconstructionResidual: number
  classificationDurations: RatingClassificationDuration[]
  qualityFlags: string[]
  terms: RatingContributionTerm[]
  limitation: string
}

export type RatingContributionGroup =
  | "BaseContext" | "Shooting" | "Creativity" | "Passing" | "Defence" | "Goalkeeping"

export type RatingClassificationDuration = { categoryBit: number; duration: number }

export type RatingContributionTerm = {
  index: number
  categoryBit: number
  group: RatingContributionGroup
  input: number
  coefficient: number
  contribution: number
  postFactorContribution: number
  confidence: string
}

export type RealtimeFrame = {
  sequence: number
  matchId: string
  tick: number
  displayTick: number
  period: number
  ratingModel?: RealtimeRatingModel
  capturedUnixMilliseconds: number
  possessionTeam?: TeamSide
  ballHolderPlayerId?: number
  /** Integer wire values in centimeters. */
  ballXCentimeters: number
  ballYCentimeters: number
  ballZCentimeters: number
  halfPitchWidth: number
  halfPitchLength: number
  momentumEvents: RealtimeMomentumEvent[]
  momentumEventUpdates?: RealtimeMomentumEventUpdate[]
  momentum: RealtimeMomentumPoint[]
  rollingMomentum: RealtimeMomentumPoint[]
  home: RealtimeTeam
  away: RealtimeTeam
  players: RealtimePlayer[]
}

export type RealtimeMomentumEvent = {
  eventIndex: number
  tick: number
  lateralPosition: number
  longitudinalPosition: number
  trajectoryStartLateralPosition?: number | null
  trajectoryStartLongitudinalPosition?: number | null
  trajectoryEndLateralPosition?: number | null
  trajectoryEndLongitudinalPosition?: number | null
  trajectoryPoints?: Array<{
    lateralPosition: number
    longitudinalPosition: number
  }> | null
  team: TeamSide
  playerSlot: number
  playerId: number
  receiverPlayerSlot: number
  receiverPlayerId: number
  eventType: number
  flags: number
  sequenceIndex: number
  completionTick: number
}

export type RealtimeMomentumEventUpdate = {
  updateSequence: number
  operation: "add" | "update"
  sequenceIndex: number
  revision: number
  event: RealtimeMomentumEvent
}

export type RealtimeMomentumPoint = {
  value: number
  timeTicks: number
  homeWeight: number
  awayWeight: number
}

export type RealtimePlayerMetadata = {
  slot: number
  playerId: number
  uid?: number
  team: TeamSide
  shirtNumber?: number
  squadNumber?: number
  shirtName?: string
  position?: string
  positionFamiliarities?: PlayerPositionFamiliarities
  inPossession?: PlayerTacticalAssignment
  outOfPossession?: PlayerTacticalAssignment
  firstName?: string
  secondName?: string
  commonName?: string
  displayName: string
  portraitPath?: string
  profile?: PlayerProfile
  attributes?: PlayerAttributes
}

export type RealtimeTeamMetadata = {
  uid?: number
  clubUid?: number
  name: string
  backgroundColour?: number
  foregroundColour?: number
  outlineColour?: number
  shirtNumberColor?: number
  shirtBackgroundColor?: number
  shirtBackgroundColorGK?: number
  logoPath?: string
  manager?: RealtimeManagerMetadata
}

export type RealtimeManagerMetadata = {
  uid?: number
  firstName?: string
  secondName?: string
  isHumanControlled: boolean
}

export type RealtimeCompetitionMetadata = {
  uid?: number
  name?: string
  logoPath?: string
  primaryColour?: number
  secondaryColour?: number
  tertiaryColour?: number
}

export type RealtimeMatchMetadata = {
  matchId: string
  startedUnixMilliseconds: number
  capturedTick: number
  matchDate?: string
  halfPitchWidth?: number
  halfPitchLength?: number
  competition?: RealtimeCompetitionMetadata
  home: RealtimeTeamMetadata
  away: RealtimeTeamMetadata
  players: RealtimePlayerMetadata[]
}
