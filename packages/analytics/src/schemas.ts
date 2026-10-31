import { z } from 'zod'
import { DomainError } from '@fmmi/model'

const Coverage = z.enum(['complete_for_window', 'partial_for_window', 'unavailable'])
const NullReason = z.enum(['not_recorded', 'unsupported_version', 'partial', 'unverified_semantics', 'missing_baseline', 'unresolved_boundary', 'zero_denominator', 'not_applicable'])
const Boundary = z.strictObject({ period: z.number().int(), tick: z.number().int(), sequence: z.number().int() })
const Side = z.enum(['home', 'away'])

/** A metric row states only what differs from the envelope; unit, derivation and confidence come from the registry entry. */
export const MetricRowSchema = z.strictObject({
  metric: z.string(),
  value: z.number().nullable(),
  coverage: Coverage.optional(),
  nullReason: NullReason.optional(),
  counts: z.strictObject({ numerator: z.number(), denominator: z.number() }).optional(),
  teamId: z.string().optional(),
  playerId: z.string().optional(),
  warnings: z.array(z.string()).optional(),
}).refine((r) => (r.value === null) === (r.nullReason !== undefined), { message: 'a null value needs a nullReason and a value must not have one' })

const TeamRef = z.strictObject({ teamId: z.string(), name: z.string(), side: Side, managed: z.boolean() })
const PlayerRef = z.looseObject({ playerId: z.string().startsWith('p_'), name: z.string(), side: Side, teamId: z.string(), identity: z.enum(['match_local', 'persistent', 'linked']), persistentPlayerId: z.string().startsWith('pe_').nullable() })

export const EnvelopeShape = {
  schemaVersion: z.string(),
  query: z.enum(['report', 'player', 'network', 'service', 'summary', 'compare', 'status', 'threat']),
  matchId: z.string(), saveId: z.string(), recordingRevisionId: z.string(),
  source: z.strictObject({ kind: z.literal('fmlens_archive'), format: z.string(), startTick: z.number().int(), endTick: z.number().int() }),
  metricDictionaryVersion: z.string(),
  window: z.looseObject({
    from: Boundary, to: Boundary, bounds: z.literal('[from,to)'),
    display: z.strictObject({ fromMinute: z.number(), toMinute: z.number() }),
    resolution: z.looseObject({ from: z.looseObject({ exact: z.boolean() }), to: z.looseObject({ exact: z.boolean() }) }),
  }),
  coverage: Coverage,
  capture: z.looseObject({
    integrity: z.enum(['valid', 'recovered_prefix', 'invalid']), coverage: z.enum(['full_match', 'partial', 'unknown']),
    completion: z.enum(['completed', 'completed_manual', 'in_progress', 'unknown']), partial: z.boolean(), statement: z.string().nullable(), endBoundary: Boundary,
  }),
  result: z.looseObject({ observed: z.looseObject({ home: z.number(), away: z.number() }), label: z.enum(['observed_not_final', 'final_manual', 'final']) }),
  teams: z.strictObject({ home: TeamRef, away: TeamRef }),
  metrics: z.record(z.string(), z.looseObject({ version: z.number().int(), unit: z.string(), unitVerified: z.boolean(), derivation: z.string(), confidence: z.string() })),
  warnings: z.array(z.string()),
}

const Finding = z.looseObject({ ruleId: z.string(), ruleVersion: z.number().int(), subject: z.looseObject({ playerId: z.string(), name: z.string() }), label: z.string(), summary: z.string() })
const Suppressed = z.looseObject({ ruleId: z.string(), reasons: z.array(z.string()) })
const Gate = z.looseObject({ status: z.enum(['pass', 'fail']), side: Side, scope: z.string(), semanticsBasis: z.literal('internal_corroboration'), reasons: z.array(z.string()) })

export const ReportResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('report'),
  report: z.looseObject({
    teams: z.strictObject({ home: TeamRef.extend({ metrics: z.array(MetricRowSchema) }), away: TeamRef.extend({ metrics: z.array(MetricRowSchema) }) }),
    players: z.array(PlayerRef.extend({ minutesInWindow: z.number(), metrics: z.array(MetricRowSchema) })),
    findings: z.array(Finding), suppressedFindings: z.array(Suppressed),
    evidenceQuality: z.looseObject({ recipientGate: z.strictObject({ home: Gate, away: Gate }) }),
  }),
})

const RatingBlock = z.looseObject({
  native: z.looseObject({ value: z.number().nullable(), label: z.literal('observed') }),
  sampledAt: z.looseObject({ period: z.number().int(), tick: z.number().int() }).nullable(),
  statement: z.string(),
  estimate: z.looseObject({
    label: z.literal('estimated'),
    contributions: z.array(z.looseObject({ category: z.string(), postFactor: z.number() })),
    reconstructionResidual: z.looseObject({ internalUnits: z.number() }),
  }).nullable(),
  nullReason: NullReason.nullable(), reason: z.string().nullable(),
  model: z.looseObject({ id: z.string(), version: z.string() }),
  limitations: z.array(z.string()), qualityFlags: z.array(z.string()),
})
export { RatingBlock as RatingBlockSchema }

export const PlayerResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('player'),
  player: PlayerRef.extend({
    participation: z.looseObject({ minutesInWindow: z.number() }),
    metrics: z.array(MetricRowSchema),
    rating: RatingBlock,
    passing: z.looseObject({ recipientGate: Gate, received: z.array(MetricRowSchema) }),
    findings: z.array(Finding), suppressedFindings: z.array(Suppressed),
  }),
})

export const NetworkResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('network'),
  network: z.looseObject({
    team: TeamRef, scope: z.looseObject({ scope: z.enum(['counter_scope', 'open_play', 'all_passes']), warnings: z.array(z.string()) }), recipientGate: Gate,
    totals: z.looseObject({ edgesTotal: z.number().int(), truncated: z.boolean() }),
    edges: z.array(z.strictObject({ from: z.string(), to: z.string(), completions: z.number().int(), forwardDistanceM: z.strictObject({ sum: z.number(), measured: z.number().int() }).nullable() })),
    nodes: z.array(z.looseObject({ playerId: z.string(), location: z.string().nullable() })),
  }),
})

export const ServiceResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('service'),
  service: z.looseObject({
    subject: z.looseObject({ player: PlayerRef, reception: z.array(MetricRowSchema) }),
    comparator: z.looseObject({ player: PlayerRef }).nullable(),
    recipientGate: Gate,
    diagnosis: z.strictObject({ status: z.enum(['descriptive_only', 'withheld']), note: z.string() }),
    comparison: z.looseObject({ status: z.enum(['qualified', 'suppressed']), reasons: z.array(z.string()), context: z.looseObject({ confounders: z.array(z.string()), substitutionFlips: z.array(z.looseObject({})), subject: z.looseObject({}), comparator: z.looseObject({}) }).nullable() }).nullable(),
    findings: z.array(Finding), suppressedFindings: z.array(Suppressed),
  }),
})

/** Validates a result against its schema and returns the original object (extra fields are kept). */
export function validated<T>(schema: z.ZodType, value: T): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new DomainError('internal_error', 'Result failed schema validation', { issues: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) })
  return value
}

// ------------------------------------------------------------------ Slice 3 results

const GateSummary = z.looseObject({ status: z.enum(['pass', 'fail']), reasons: z.array(z.string()) })
const Cell = z.looseObject({ value: z.number().nullable() })

export const SummaryResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('summary'),
  summary: z.looseObject({
    comparison: z.array(z.strictObject({ metric: z.string(), home: Cell, away: Cell })),
    roster: z.looseObject({
      total: z.number().int(), returned: z.number().int(),
      players: z.array(z.strictObject({
        playerId: z.string().startsWith('p_'), name: z.string(), side: Side, position: z.string().nullable(), shirtNumber: z.number().nullable(),
        status: z.enum(['played', 'unused_substitute']), enteredAs: z.enum(['starter', 'substitute']).nullable(), minutes: z.number(),
        onAt: z.string().nullable(), offAt: z.string().nullable(),
        onAtMinute: z.number().nullable(), offAtMinute: z.number().nullable(),
        identity: z.enum(['match_local', 'persistent', 'linked']), persistentPlayerId: z.string().startsWith('pe_').nullable(),
      })),
    }),
    findings: z.array(Finding), suppressedFindings: z.array(Suppressed),
    evidenceQuality: z.looseObject({ recipientGate: z.strictObject({ home: GateSummary, away: GateSummary }) }),
  }),
})

const { window: _window, ...EnvelopeWithoutWindow } = EnvelopeShape
const WindowSide = z.looseObject({
  from: Boundary, to: Boundary, bounds: z.literal('[from,to)'), teamMinutes: z.number(), coverage: Coverage,
  effective: z.looseObject({ coverage: Coverage, exact: z.boolean() }),
})
const CompareCell = z.looseObject({ value: z.number().nullable() })

export const CompareResultSchema = z.looseObject({
  ...EnvelopeWithoutWindow, query: z.literal('compare'),
  windows: z.strictObject({ a: WindowSide, b: WindowSide }),
  comparison: z.looseObject({
    team: TeamRef, pairing: z.literal('b_minus_a'),
    teamRates: z.array(z.strictObject({ metric: z.string(), comparedAs: z.enum(['per_90', 'value']), a: CompareCell, b: CompareCell, delta: z.number().nullable() })),
    players: z.array(z.looseObject({ player: PlayerRef, status: z.enum(['qualified', 'suppressed']), reasons: z.array(z.string()) })),
    context: z.looseObject({ confounders: z.array(z.string()) }),
  }),
})

export const StatusResultSchema = z.looseObject({
  observedIntervals: z.array(z.looseObject({ period: z.number().int(), fromTick: z.number().int(), toTick: z.number().int() })),
  recipientDiagnostic: z.strictObject({ home: GateSummary, away: GateSummary }),
  unavailable: z.array(z.strictObject({ metric: z.string(), reason: z.string(), note: z.string() })),
})

// ------------------------------------------------------------------ Slice 3b results

const LaneId = z.enum(['left', 'centre', 'right'])
const CounterRef = z.looseObject({ value: z.number().nullable() })
const Recon = z.looseObject({ byLane: z.number().int(), withoutLocation: z.number().int(), events: z.number().int(), counter: CounterRef })
const Involvement = z.strictObject({
  kinds: z.strictObject({ tackle_won: z.number().int(), tackle_lost: z.number().int(), interception: z.number().int(), aerial_won: z.number().int(), aerial_lost: z.number().int() }),
  lanes: z.strictObject({ left: z.number().int(), centre: z.number().int(), right: z.number().int(), unknown: z.number().int() }),
  total: z.number().int(),
})

export const ThreatResultSchema = z.looseObject({
  ...EnvelopeShape, query: z.literal('threat'),
  threat: z.looseObject({
    team: TeamRef, opposition: TeamRef,
    lanes: z.looseObject({ perspective: z.literal('attacking_team'), ids: z.array(LaneId), mirrorRule: z.string() }),
    byLane: z.array(z.looseObject({
      lane: LaneId, defendingTeamFlank: LaneId, shots: z.number().int(), crosses: z.number().int(), crossesCompleted: z.number().int(), passesCompleted: z.number().int(),
      finalThirdEntries: z.number().int(), dangerAreaEntries: z.number().int(),
      xg: z.strictObject({ value: z.number(), attributedShots: z.number().int(), unattributedShots: z.number().int() }),
    })),
    reconciliation: z.looseObject({ shots: Recon, crosses: Recon, crossesCompleted: Recon, passesCompleted: Recon }),
    goals: z.looseObject({
      label: z.literal('context_only'), statement: z.string(),
      items: z.array(z.looseObject({ tick: z.number().int(), lane: LaneId.nullable(), involvedInEvent: z.array(z.looseObject({ playerId: z.string(), roleInEvent: z.enum(['event_actor', 'event_receiver']) })) })),
    }),
    defensiveInvolvement: z.looseObject({ label: z.literal('recorded_events_not_performance'), team: Involvement, players: z.array(z.looseObject({ playerId: z.string(), involvement: Involvement })) }),
    unavailable: z.array(z.strictObject({ id: z.string(), reason: NullReason, note: z.string() })),
    statements: z.array(z.string()),
  }),
})

