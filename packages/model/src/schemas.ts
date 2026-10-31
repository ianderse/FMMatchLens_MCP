import { z } from 'zod'

/** Output schemas for the CLI `--json` envelope. Nested evidence objects are open so adding fields is not breaking. */
export const ErrorBodySchema = z.object({
  code: z.enum(['invalid_input', 'not_found', 'ambiguous_selection', 'identity_conflict', 'revision_unavailable', 'unsupported_version',
    'insufficient_coverage', 'stale_snapshot', 'storage_limit_exceeded', 'internal_error']),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
  retryable: z.boolean(),
})

export const ErrorEnvelopeSchema = z.object({ ok: z.literal(false), schemaVersion: z.string(), error: ErrorBodySchema })

export const okEnvelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), schemaVersion: z.string(), data })

const BoundarySchema = z.object({ period: z.number().int(), tick: z.number().int(), sequence: z.number().int() })

export const SaveSchema = z.object({ saveId: z.string().startsWith('s_'), displayName: z.string(), seasonStart: z.string(), createdAt: z.string() })

export const IngestResultSchema = z.object({
  file: z.string(),
  status: z.enum(['ingested', 'already_ingested', 'identity_conflict', 'continuation', 'rejected']),
  sha256: z.string().optional(),
  matchId: z.string().optional(),
  recordingRevisionId: z.string().optional(),
  integrity: z.string().optional(),
  coverage: z.string().optional(),
  completion: z.string().optional(),
  warnings: z.array(z.string()),
  error: ErrorBodySchema.optional(),
})

const ResultSchema = z.object({
  observed: z.object({ home: z.number().int(), away: z.number().int(), at: z.object({ period: z.number(), tick: z.number(), displayMinute: z.number() }) }),
  final: z.object({ home: z.number().int(), away: z.number().int(), basis: z.literal('manual') }).nullable(),
  label: z.enum(['observed_not_final', 'final_manual', 'final']),
})
const StatusSchema = z.object({
  integrity: z.enum(['valid', 'recovered_prefix', 'invalid']),
  coverage: z.enum(['full_match', 'partial', 'unknown']),
  completion: z.enum(['completed', 'completed_manual', 'in_progress', 'unknown']),
})

export const ListDataSchema = z.object({
  schemaVersion: z.string(), query: z.literal('list'),
  saveId: z.string().nullable(), saveName: z.string().nullable(),
  filters: z.object({ saveId: z.string().nullable(), teamId: z.string().nullable(), season: z.string().nullable() }),
  page: z.object({ limit: z.number().int(), returned: z.number().int(), totalMatching: z.number().int(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
  matches: z.array(z.object({
    matchId: z.string(), saveId: z.string(), upstreamMatchId: z.string(), matchDate: z.string().nullable(), season: z.string().nullable(),
    competition: z.string().nullable(), home: z.object({ teamId: z.string(), name: z.string() }), away: z.object({ teamId: z.string(), name: z.string() }),
    managedSide: z.enum(['home', 'away']).nullable(), result: ResultSchema, selectedRecordingRevisionId: z.string(), status: StatusSchema,
    format: z.string(), conflictingRevisions: z.number().int(),
    managedTeamId: z.string().nullable(), opponent: z.object({ teamId: z.string(), name: z.string() }).nullable(),
    /** True for a partial recording that waits for the user's confirmation; `nextStep` is then the command. A full-match capture needs none. */
    needsConfirmation: z.boolean().optional(), nextStep: z.string().optional(),
  })),
  /** MCP only: recordings the server imported automatically before answering (see the fmmi-mcp instructions). */
  newlyImported: z.array(z.looseObject({ file: z.string() })).optional(), warnings: z.array(z.string()).optional(),
})

const ParticipantSchema = z.object({
  playerId: z.string().startsWith('p_'),
  identity: z.enum(['match_local', 'persistent', 'linked']), persistentPlayerId: z.string().startsWith('pe_').nullable(),
  upstream: z.object({ playerId: z.number(), uid: z.number().nullable(), slot: z.number() }),
  side: z.enum(['home', 'away']), name: z.string(), shirtNumber: z.number().nullable(), position: z.string().nullable(),
  participation: z.looseObject({ status: z.enum(['played', 'unused_substitute']), elapsedTicks: z.number(), elapsedMinutes: z.number() }),
  roleTimeline: z.array(z.unknown()), nativeRating: z.number().nullable(), counters: z.record(z.string(), z.number()),
})

export const ShowDataSchema = z.object({
  schemaVersion: z.string(), matchId: z.string(), saveId: z.string(), saveName: z.string(), upstreamMatchId: z.string(),
  season: z.string().nullable(), matchDate: z.string().nullable(), competition: z.string().nullable(),
  home: z.object({ teamId: z.string(), name: z.string(), uid: z.number().nullable() }),
  away: z.object({ teamId: z.string(), name: z.string(), uid: z.number().nullable() }),
  managedSide: z.enum(['home', 'away']).nullable(),
  result: ResultSchema,
  recording: z.looseObject({ recordingRevisionId: z.string(), archiveSha256: z.string().length(64), firstBoundary: BoundarySchema, lastBoundary: BoundarySchema }),
  status: z.object({
    integrity: z.looseObject({ status: z.enum(['valid', 'recovered_prefix', 'invalid']), cleanClose: z.boolean() }),
    coverage: z.looseObject({ status: z.enum(['full_match', 'partial', 'unknown']), reasons: z.array(z.string()), initialBaseline: z.enum(['zero_verified', 'unverified']) }),
    completion: z.looseObject({ status: z.enum(['completed', 'completed_manual', 'in_progress', 'unknown']) }),
  }),
  teamTotals: z.object({ home: z.record(z.string(), z.number()), away: z.record(z.string(), z.number()) }),
  derived: z.looseObject({}),
  roster: z.array(ParticipantSchema),
  substitutions: z.array(z.looseObject({ pairing: z.literal('not_recorded') })),
  events: z.looseObject({ distinct: z.number() }),
  revisions: z.array(z.looseObject({ recordingRevisionId: z.string(), identityStatus: z.string() })),
  unavailable: z.array(z.object({ metric: z.string(), reason: z.string(), note: z.string() })),
  warnings: z.array(z.string()),
})
