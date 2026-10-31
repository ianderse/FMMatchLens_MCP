/**
 * Raw `eventType` mapping. Status 'verified' means the type was reconciled exactly against cumulative counters on the
 * audited recording (docs/data-coverage.md section 8). Everything else stays unverified/unmapped; nothing is guessed.
 */
export interface EventKind { kind: string; semantics: 'verified' | 'unverified' }

const K: Record<number, EventKind> = {
  1: { kind: 'goal', semantics: 'verified' },
  2: { kind: 'shot_off_target', semantics: 'verified' },
  3: { kind: 'shot_woodwork', semantics: 'verified' },
  4: { kind: 'shot_on_target', semantics: 'verified' },
  5: { kind: 'shot_blocked', semantics: 'verified' },
  6: { kind: 'pass_unverified', semantics: 'unverified' },
  7: { kind: 'pass_completed', semantics: 'verified' },
  8: { kind: 'pass_incomplete', semantics: 'verified' },
  9: { kind: 'pass_incomplete', semantics: 'verified' },
  10: { kind: 'pass_incomplete', semantics: 'verified' },
  11: { kind: 'pass_incomplete', semantics: 'verified' },
  12: { kind: 'cross_completed', semantics: 'verified' },
  13: { kind: 'cross_incomplete', semantics: 'verified' },
  14: { kind: 'cross_incomplete', semantics: 'verified' },
  15: { kind: 'cross_incomplete', semantics: 'verified' },
  16: { kind: 'cross_incomplete', semantics: 'verified' },
  17: { kind: 'cross_incomplete', semantics: 'verified' },
  18: { kind: 'fouled', semantics: 'verified' },
  19: { kind: 'foul_committed', semantics: 'unverified' },
  22: { kind: 'penalty', semantics: 'verified' },
  23: { kind: 'offside', semantics: 'verified' },
  24: { kind: 'clearance', semantics: 'unverified' },
  26: { kind: 'tackle_won', semantics: 'verified' },
  27: { kind: 'tackle_lost', semantics: 'verified' },
  28: { kind: 'aerial_won', semantics: 'verified' },
  29: { kind: 'aerial_lost', semantics: 'verified' },
  31: { kind: 'interception', semantics: 'verified' },
  34: { kind: 'dribble', semantics: 'verified' },
  35: { kind: 'clear_cut_chance', semantics: 'verified' },
}

export function eventKind(type: number): { kind: string; semantics: 'verified' | 'unverified' | 'unmapped' } {
  return K[type] ?? { kind: `type_${type}`, semantics: 'unmapped' }
}

export function isPassOrCross(type: number): boolean { return type >= 6 && type <= 17 }

export const FLAG_KEY_PASS = 0x2
/** Inferred: counts equal the player throw-in counters exactly for all 36 players. */
export const FLAG_THROW_IN = 0x8
/** Set means the event team attacks toward +longitudinal (verified 100% over passes, shots, goals). */
export const FLAG_ATTACK_POSITIVE = 0x100
