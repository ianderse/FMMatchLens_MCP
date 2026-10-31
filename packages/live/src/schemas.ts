import { z } from 'zod'
import type { RealtimeFrame, RealtimeMatchMetadata } from '@fmmi/fmlens-adapter'

/**
 * Response schemas for the loopback plugin API. Every response is validated before any field is read; a response that does not match is
 * reported as `schema_mismatch` and the reader degrades (never crashes, never guesses). The schemas are `looseObject`s that require only
 * what this project reads, so an additive plugin change does not break the reader while a removed or retyped field does.
 *
 * Evidence: `health`, `archives` and `status` were observed from a running plugin (docs/data-coverage.md section 10). On 2026-10-31, during
 * one real match, all nine HTTP routes answered, and the reader reached `fresh` once `inPossession` and `outOfPossession` were made
 * nullable (substitutes carry null in `/api/match/meta`); so meta, current, frames and formation history were accepted by these schemas
 * for that one match. The momentum routes answered but their bodies are not parsed (the schema accepts any object or array). Over the
 * WebSocket, `connection_status` and `realtime_tick` envelopes arrived; `formation_changed` was not seen, so its payload schema is still
 * only MODELLED from the vendored v0.7.0 source. `fmmi live capture` and `fmmi live check` validate each full raw response, not a sample.
 */
const int = z.number().int()
const num = z.number().finite()
const side = z.enum(['home', 'away'])

export const TEAM_COUNTERS = [
  'goals', 'xg', 'possessionTime', 'shots', 'shotsOnTarget', 'firstHalfShots', 'secondHalfShots', 'shotsOffTarget', 'blockedShots', 'clearCutChances', 'passes',
  'passesCompleted', 'crosses', 'crossesCompleted', 'aerials', 'aerialsWon', 'progressivePasses', 'finalThirdPasses', 'tacklesAttempted', 'tacklesWon', 'fouls',
  'corners', 'offsides', 'yellowCards', 'redCards',
] as const

// ------------------------------------------------------------------ observed
export const HealthSchema = z.looseObject({
  status: z.string(), pluginVersion: z.string(), game: z.string().optional(), gameVersion: z.string().optional(),
  inMatch: z.boolean(), tick: num.optional(), frameCount: int.optional(), webSocketConnections: int.optional(),
})
export type Health = z.infer<typeof HealthSchema>

export const MatchStatusSchema = z.looseObject({
  status: z.string(), period: int.optional(), matchId: z.string().optional(), lastTick: int.optional(),
  missingTickCount: int.optional(), duplicateTickCount: int.optional(), outOfOrderTickCount: int.optional(),
})
export type MatchStatus = z.infer<typeof MatchStatusSchema>

export const ArchivesSchema = z.looseObject({
  items: z.array(z.looseObject({ matchId: z.string(), ended: z.boolean().optional(), frameCount: int.optional(), firstTick: num.optional(), lastTick: num.optional() })),
})

// ------------------------------------------------------------------ modelled (vendored source)
const TeamCounters = z.looseObject(Object.fromEntries(TEAM_COUNTERS.map((k) => [k, num])))

const MomentumEvent = z.looseObject({
  eventIndex: int, tick: int, lateralPosition: num, longitudinalPosition: num, team: side, playerSlot: int, playerId: int,
  receiverPlayerSlot: int, receiverPlayerId: int, eventType: int, flags: int, sequenceIndex: int, completionTick: int,
})

const Assignment = z.looseObject({ position: z.string(), role: z.string(), duty: z.string().optional() })

const FramePlayer = z.looseObject({ slot: int, playerId: int, team: side, isOnPitch: z.boolean(), rating: num })

export const FrameSchema = z.looseObject({
  sequence: int, matchId: z.string().min(1), tick: int.min(0), displayTick: int, period: int.min(1), capturedUnixMilliseconds: num,
  halfPitchWidth: num, halfPitchLength: num,
  momentumEvents: z.array(MomentumEvent),
  home: TeamCounters, away: TeamCounters,
  players: z.array(FramePlayer).max(255),
})

export const MetadataSchema = z.looseObject({
  matchId: z.string().min(1), startedUnixMilliseconds: num, capturedTick: int,
  matchDate: z.string().optional(),
  competition: z.looseObject({ uid: int.optional(), name: z.string().optional() }).optional(),
  home: z.looseObject({ name: z.string(), uid: int.optional(), clubUid: int.optional(), manager: z.looseObject({ isHumanControlled: z.boolean() }).optional() }),
  away: z.looseObject({ name: z.string(), uid: int.optional(), clubUid: int.optional(), manager: z.looseObject({ isHumanControlled: z.boolean() }).optional() }),
  players: z.array(z.looseObject({
    slot: int, playerId: int, uid: int.optional(), team: side, displayName: z.string(), position: z.string().optional(),
    // Null for substitutes in a real match: they hold no tactical assignment until they come on.
    shirtNumber: int.optional(), inPossession: Assignment.nullish(), outOfPossession: Assignment.nullish(),
  })).max(255),
})

/** `/api/match/current` and `/api/match/meta` answer `null` between matches (upstream treats both as nullable). */
export const CurrentSchema = FrameSchema.nullable()
export const MetaSchema = MetadataSchema.nullable()

export const FramesSliceSchema = z.looseObject({
  matchId: z.string().optional(), status: z.string(), totalFrameCount: int, frames: z.array(FrameSchema),
})

const FormationEntry = z.looseObject({
  index: int.min(0), tick: int, displayTick: int.optional(),
  players: z.array(z.looseObject({
    slot: int, playerId: int, team: side, isSubstitute: z.boolean().optional(), isOnPitch: z.boolean().optional(),
    inPossession: Assignment.nullish(), outOfPossession: Assignment.nullish(),
  })),
})
export const FormationSliceSchema = z.looseObject({
  matchId: z.string().optional(), status: z.string(), totalEntryCount: int, entries: z.array(FormationEntry),
})
export type FormationEntry = z.infer<typeof FormationEntry>

/** Momentum routes are not used by the reader (frames carry the events); they are only captured and checked. Shapes are unknown, so only "valid JSON object or array". */
export const MomentumSchema = z.union([z.array(z.unknown()), z.looseObject({})])

export const EnvelopeSchema = z.looseObject({ type: z.string(), payload: z.unknown() })

export const asFrame = (f: z.infer<typeof FrameSchema>): RealtimeFrame => f as unknown as RealtimeFrame
export const asMetadata = (m: z.infer<typeof MetadataSchema>): RealtimeMatchMetadata => m as unknown as RealtimeMatchMetadata
