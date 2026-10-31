// FMMI-authored (not upstream): upstream's `ParsedLocalArchive` type lives in a file that is not vendored.
// Shape reconstructed from the object literal returned by upstream `parseArchiveFile`, plus the `integrity` block added by FMMI.
import type { RealtimeFrame, RealtimeMatchMetadata } from "./realtimeTypes.ts"
import type { RatingWeightConfiguration } from "./ratingCalculator.ts"

export type ArchiveIntegrityInfo = {
  cleanClose: boolean
  truncatedTail: boolean
  blockError: string | undefined
  blocksDecoded: number
  framesDecoded: number
  lastValidatedTick: number
  lastValidatedPeriod: number
}

export type ParsedLocalArchive = {
  archive: {
    matchId: string
    fileName: string
    startedUnixMilliseconds: number
    endedUnixMilliseconds: number | undefined
    ended: boolean
    frameCount: number
    firstTick: number
    lastTick: number
    matchDate: string | undefined
    homeGoals: number
    awayGoals: number
    fileSizeBytes: number
  }
  metadata: RealtimeMatchMetadata | undefined
  metadataTimeline: RealtimeMatchMetadata[]
  frames: RealtimeFrame[]
  ratingConfiguration: RatingWeightConfiguration
  integrity: ArchiveIntegrityInfo
}
