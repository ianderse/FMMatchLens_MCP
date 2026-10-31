import type { NullReason } from '@fmmi/model'
import { TICKS_PER_MINUTE } from '@fmmi/model'

export interface RatioResult { value: number | null; nullReason?: NullReason }

/** 100 * numerator / denominator. Missing inputs or a zero denominator yield null with a reason, never 0. */
export function percent(numerator: number | null, denominator: number | null): RatioResult {
  if (numerator === null || denominator === null) return { value: null, nullReason: 'missing_baseline' }
  if (denominator === 0) return { value: null, nullReason: 'zero_denominator' }
  return { value: (100 * numerator) / denominator }
}

export function ratio(numerator: number | null, denominator: number | null): RatioResult {
  if (numerator === null || denominator === null) return { value: null, nullReason: 'missing_baseline' }
  if (denominator === 0) return { value: null, nullReason: 'zero_denominator' }
  return { value: numerator / denominator }
}

/** count * 90 / minutes. Zero or unknown duration is null. */
export function per90(count: number | null, ticks: number | null): RatioResult {
  if (count === null || ticks === null) return { value: null, nullReason: 'missing_baseline' }
  if (ticks <= 0) return { value: null, nullReason: 'zero_denominator' }
  return { value: (count * 90 * TICKS_PER_MINUTE) / ticks }
}

export interface RatioPart { numerator: number | null; denominator: number | null }
export interface PooledRatio {
  numerator: number
  denominator: number
  /** numerator / denominator (scaled), or null when the pooled denominator is zero or nothing contributed. */
  value: number | null
  nullReason?: NullReason
  contributing: number
  excluded: number
}

/**
 * Pooled aggregation for season percentages and per-90 rates (spec 7.6): sum numerators and denominators across
 * parts, then divide once. Individual ratios are never averaged. A part with a missing numerator or denominator
 * contributes to neither; a part with a zero denominator contributes its numerator and a zero denominator.
 */
export function pooledRatio(parts: readonly RatioPart[], scale = 1): PooledRatio {
  let n = 0, d = 0, contributing = 0, excluded = 0
  for (const p of parts) {
    if (p.numerator === null || p.denominator === null) { excluded++; continue }
    n += p.numerator; d += p.denominator; contributing++
  }
  if (contributing === 0) return { numerator: 0, denominator: 0, value: null, nullReason: 'missing_baseline', contributing, excluded }
  if (d === 0) return { numerator: n, denominator: d, value: null, nullReason: 'zero_denominator', contributing, excluded }
  return { numerator: n, denominator: d, value: (scale * n) / d, contributing, excluded }
}
