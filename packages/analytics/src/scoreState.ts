import { TICKS_PER_MINUTE } from '@fmmi/model'
import type { NullReason, PlaySegment, SampledCounters, Side } from '@fmmi/model'
import { GATES } from './registry.ts'

export type ScoreState = 'leading' | 'drawing' | 'trailing'
export interface ScoreStateMinutes {
  side: Side
  ticks: Record<ScoreState, number>
  minutes: Record<ScoreState, number>
  totalMinutes: number
  /** Share of the verified minutes in each state. */
  shares: Record<ScoreState, number>
  dominant: ScoreState | null
  note: string
}
export type ScoreStateResult = { value: ScoreStateMinutes; nullReason?: undefined } | { value: null; nullReason: NullReason }

/**
 * Verified minutes leading, drawing and trailing from `side`'s perspective, over the given play segments. The score is
 * the observed goal counters; a frame's score holds until the next frame (goals appear at the first frame that shows
 * them). Null when the goal counters are not recorded.
 */
export function scoreStateMinutes(sampled: SampledCounters, segments: readonly PlaySegment[], side: Side): ScoreStateResult {
  const own = `team.${side}.goals`, opp = `team.${side === 'home' ? 'away' : 'home'}.goals`
  if (!sampled.series.has(own) || !sampled.series.has(opp)) return { value: null, nullReason: 'not_recorded' }
  const fi = sampled.frames
  const ticks: Record<ScoreState, number> = { leading: 0, drawing: 0, trailing: 0 }
  for (let i = 0; i < fi.length; i++) {
    const p = fi.periods[i]!, t0 = fi.ticks[i]!
    const t1 = i + 1 < fi.length && fi.periods[i + 1] === p ? fi.ticks[i + 1]! : Infinity
    let state: ScoreState | null = null
    for (const s of segments) {
      if (s.period !== p) continue
      const lo = Math.max(t0, s.fromTick), hi = Math.min(t1, s.toTick)
      if (lo >= hi) continue
      if (state === null) {
        const a = sampled.valueAtFrame(own, i), b = sampled.valueAtFrame(opp, i)
        if (a === undefined || b === undefined) return { value: null, nullReason: 'missing_baseline' }
        state = a > b ? 'leading' : a < b ? 'trailing' : 'drawing'
      }
      ticks[state] += hi - lo
    }
  }
  const total = ticks.leading + ticks.drawing + ticks.trailing
  if (total === 0) return { value: null, nullReason: 'zero_denominator' }
  const minutes = { leading: ticks.leading / TICKS_PER_MINUTE, drawing: ticks.drawing / TICKS_PER_MINUTE, trailing: ticks.trailing / TICKS_PER_MINUTE }
  const shares = { leading: ticks.leading / total, drawing: ticks.drawing / total, trailing: ticks.trailing / total }
  const order: ScoreState[] = ['leading', 'drawing', 'trailing']
  const dominant = order.reduce((a, b) => (ticks[b] > ticks[a] ? b : a))
  return { value: { side, ticks, minutes, totalMinutes: total / TICKS_PER_MINUTE, shares, dominant, note: 'Observed goal counters; a frame score holds until the next frame.' } }
}

/** Confounders between two comparison sides. Thresholds are labelled heuristics in the registry (GATES.context). */
export function comparisonConfounders(a: ScoreStateResult, b: ScoreStateResult, minutesA: number, minutesB: number, substitutionsInWindow: number): string[] {
  const out: string[] = []
  if (a.value === null || b.value === null) out.push('score_state_unavailable')
  else {
    const states: ScoreState[] = ['leading', 'drawing', 'trailing']
    const shareGap = Math.max(...states.map((s) => Math.abs(a.value.shares[s] - b.value.shares[s])))
    if (a.value.dominant !== b.value.dominant || shareGap > GATES.context.scoreStateShareDifference) out.push('different_score_state')
  }
  const lo = Math.min(minutesA, minutesB), hi = Math.max(minutesA, minutesB)
  if (hi > 0 && lo / hi < GATES.context.minutesRatioMin) out.push('different_minutes_on_pitch')
  if (substitutionsInWindow > 0) out.push('substitutions_in_window')
  return out
}
