import { TICKS_PER_MINUTE } from './constants.ts'
import { DomainError } from './errors.ts'
import type { Boundary, NullReason, PeriodSpan, PlaySegment } from './types.ts'

export function compareBoundary(a: Boundary, b: Boundary): number {
  return a.period - b.period || a.tick - b.tick || a.sequence - b.sequence
}
const cmpPT = (a: { period: number; tick: number }, b: { period: number; tick: number }) => a.period - b.period || a.tick - b.tick

export interface Window { from: Boundary; to: Boundary; bounds: '[from,to)' }

/** Frame timeline: parallel arrays, one entry per decoded frame, in archive order. */
export class FrameIndex {
  readonly periods: number[] = []
  readonly ticks: number[] = []
  readonly sequences: number[] = []
  readonly displayTicks: number[] = []
  private periodFirst = new Map<number, number>()
  get length() { return this.ticks.length }
  push(period: number, tick: number, sequence: number, displayTick: number) {
    if (!this.periodFirst.has(period)) this.periodFirst.set(period, this.ticks.length)
    this.periods.push(period); this.ticks.push(tick); this.sequences.push(sequence); this.displayTicks.push(displayTick)
  }
  boundary(i: number): Boundary { return { period: this.periods[i]!, tick: this.ticks[i]!, sequence: this.sequences[i]! } }
  firstIndexOfPeriod(period: number): number | undefined { return this.periodFirst.get(period) }
  /**
   * Last frame whose key is strictly before `b`, or -1. Keys compare on (period, tick). A frame at exactly the
   * boundary tick is NOT before it (state at tick T includes events at T, which belong to the window starting at T).
   * Frame `sequence` is only a tie-breaker, and only when the boundary names a non-zero sequence.
   */
  indexBefore(b: Boundary): number {
    let lo = 0, hi = this.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      let c = this.periods[mid]! - b.period || this.ticks[mid]! - b.tick
      if (c === 0) c = b.sequence === 0 ? 1 : this.sequences[mid]! - b.sequence
      if (c < 0) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }
  startBoundary(): Boundary { return { period: this.periods[0] ?? 1, tick: 0, sequence: 0 } }
  /** Explicit end-of-recording boundary, after the last included record. */
  endBoundary(): Boundary { const n = this.length - 1; return { period: this.periods[n]!, tick: this.ticks[n]! + 1, sequence: 0 } }
}

/** Cumulative counter as change points: `val[k]` holds from frame `idx[k]` until the next change point. */
export interface ChangeSeries { idx: number[]; val: number[] }

export class SampledCounters {
  readonly frames = new FrameIndex()
  readonly series = new Map<string, ChangeSeries>()
  /** Whether the first frame is a verified known-zero start. Only then may a window starting before it use 0. */
  initialBaseline: 'zero_verified' | 'unverified' = 'unverified'
  observe(key: string, frameIdx: number, value: number) {
    let s = this.series.get(key)
    if (!s) { s = { idx: [], val: [] }; this.series.set(key, s) }
    if (s.val.length === 0 || s.val[s.val.length - 1] !== value) { s.idx.push(frameIdx); s.val.push(value) }
  }
  valueAtFrame(key: string, i: number): number | undefined {
    const s = this.series.get(key)
    if (!s || i < 0) return undefined
    let lo = 0, hi = s.idx.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.idx[m]! <= i) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans < 0 ? undefined : s.val[ans]
  }
}

export interface BoundaryResolution {
  requested: Boundary
  source: 'frame' | 'verified_zero_baseline' | 'none'
  sampledFrame: Boundary | null
  /** Ticks between the sampled frame and the requested boundary that no frame observed. */
  unobservedTicks: number
  exact: boolean
}
export interface CounterDelta {
  key: string
  value: number | null
  nullReason?: NullReason
  coverage: 'complete_for_window' | 'partial_for_window' | 'unavailable'
  from: BoundaryResolution
  to: BoundaryResolution
  warnings: string[]
}

export function resolveCounterAt(sc: SampledCounters, key: string, b: Boundary): { value: number | null; res: BoundaryResolution } {
  const i = sc.frames.indexBefore(b)
  if (i < 0) {
    if (sc.initialBaseline === 'zero_verified') {
      return { value: 0, res: { requested: b, source: 'verified_zero_baseline', sampledFrame: null, unobservedTicks: 0, exact: true } }
    }
    return { value: null, res: { requested: b, source: 'none', sampledFrame: null, unobservedTicks: 0, exact: false } }
  }
  const f = sc.frames.boundary(i)
  let unobserved = 0
  let exact: boolean
  if (f.period === b.period) {
    unobserved = Math.max(0, b.tick - 1 - f.tick)
    exact = unobserved === 0
  } else {
    const first = sc.frames.firstIndexOfPeriod(b.period)
    exact = first === undefined ? false : b.tick <= sc.frames.ticks[first]!
  }
  const v = sc.valueAtFrame(key, i)
  return { value: v ?? null, res: { requested: b, source: 'frame', sampledFrame: f, unobservedTicks: unobserved, exact } }
}

/**
 * Counter(before `to`) minus counter(before `from`), per spec 7.1. Never sums snapshots, never interpolates, never
 * invents a zero: a window starting before the first frame needs a verified zero baseline, else `missing_baseline`.
 */
export function counterDelta(sc: SampledCounters, key: string, w: Window): CounterDelta {
  const a = resolveCounterAt(sc, key, w.from)
  const b = resolveCounterAt(sc, key, w.to)
  const base = { key, from: a.res, to: b.res, warnings: [] as string[] }
  if (!sc.series.has(key)) return { ...base, value: null, nullReason: 'not_recorded', coverage: 'unavailable' }
  if (a.value === null || b.value === null) {
    return { ...base, value: null, nullReason: a.value === null ? 'missing_baseline' : 'unresolved_boundary', coverage: 'unavailable' }
  }
  const d = b.value - a.value
  if (d < 0) {
    return { ...base, value: null, nullReason: 'unverified_semantics', coverage: 'unavailable', warnings: ['counter_decreased'] }
  }
  const exact = a.res.exact && b.res.exact
  if (!exact) base.warnings.push('boundary_sampled_not_exact')
  return { ...base, value: d, coverage: exact ? 'complete_for_window' : 'partial_for_window' }
}

function boundaryIsInRecording(fi: FrameIndex, b: Boundary): boolean {
  if (b.tick < 0 || b.sequence < 0 || !Number.isInteger(b.tick) || !Number.isInteger(b.period)) return false
  return compareBoundary(b, fi.startBoundary()) >= 0 && compareBoundary(b, fi.endBoundary()) <= 0 && fi.periods.includes(b.period)
}

/** Validates a window against the recording. Rejects negative, reversed and out-of-range input; never clips. */
export function resolveWindow(fi: FrameIndex, spec: { from?: Boundary; to?: Boundary }): Window {
  if (fi.length === 0) throw new DomainError('insufficient_coverage', 'Recording has no frames')
  const from = spec.from ?? fi.startBoundary()
  const to = spec.to ?? fi.endBoundary()
  for (const [name, b] of [['from', from], ['to', to]] as const) {
    if (b.tick < 0 || b.sequence < 0) throw new DomainError('invalid_input', `Window ${name} is negative`, { reason: 'negative', which: name })
    if (!boundaryIsInRecording(fi, b)) throw new DomainError('invalid_input', `Window ${name} is outside the recording`, { reason: 'out_of_range', which: name })
  }
  if (compareBoundary(from, to) >= 0) throw new DomainError('invalid_input', 'Window is empty or reversed', { reason: 'reversed' })
  return { from, to, bounds: '[from,to)' }
}

/**
 * Period-aware minute shortcut. Display ticks restart at 45:00 in period 2 and overlap period 1, so a display minute
 * inside the overlapping range needs an explicit period (spec 7.1).
 */
export function resolveDisplayMinute(fi: FrameIndex, minute: number, period?: number): Boundary {
  if (!(minute >= 0)) throw new DomainError('invalid_input', 'Minute must be non-negative', { reason: 'negative' })
  const d = minute * TICKS_PER_MINUTE
  // Minute 0 is the kick-off, but the first frame's display tick is above 0 (2 in the real recording): resolve it to the
  // recording start boundary when that lies in period 1. Any other minute outside the recording is still rejected.
  if (d === 0 && (period === undefined || period === 1) && fi.periods[0] === 1) return fi.startBoundary()
  const range = new Map<number, [number, number]>()
  for (let i = 0; i < fi.length; i++) {
    const p = fi.periods[i]!, dt = fi.displayTicks[i]!
    const r = range.get(p)
    if (!r) range.set(p, [dt, dt])
    else { r[0] = Math.min(r[0], dt); r[1] = Math.max(r[1], dt) }
  }
  let candidates = [...range.entries()].filter(([, [lo, hi]]) => d >= lo && d <= hi).map(([p]) => p)
  if (period !== undefined) {
    const r = range.get(period)
    if (!r) throw new DomainError('invalid_input', 'Period not present in recording', { reason: 'out_of_range' })
    if (d < r[0] || d > r[1]) throw new DomainError('invalid_input', 'Minute outside the period', { reason: 'out_of_range' })
    candidates = [period]
  }
  if (candidates.length === 0) throw new DomainError('invalid_input', 'Minute is outside the recording', { reason: 'out_of_range' })
  if (candidates.length > 1) throw new DomainError('ambiguous_selection', 'Minute exists in more than one period; specify a period', { periods: candidates })
  const p = candidates[0]!
  for (let i = fi.firstIndexOfPeriod(p)!; i < fi.length && fi.periods[i] === p; i++) {
    if (fi.displayTicks[i]! >= d) return { period: p, tick: fi.ticks[i]!, sequence: 0 }
  }
  return fi.endBoundary()
}

/**
 * A tick or boundary read off the game clock. `minute` is the displayed game clock in minutes (two decimals) and is null only when
 * the instant has no clock (the half-time gap, or after the end of the capture). `label` is for people: whole elapsed minutes with
 * stoppage in the football form ("40'", "45+2'", "90+3'"), "start of match", "half-time" or "after the end of capture".
 */
export interface GameClock { minute: number | null; label: string; period: number | null }

/** Whole elapsed minutes of the displayed clock; stoppage after 45 in period 1 and after 90 in period 2 reads "45+n'" and "90+n'". */
export function minuteLabel(minute: number, period: number | null): string {
  const whole = Math.floor(minute + 1e-9)
  if (minute < 0.1 && period !== 2) return "0'"
  if (period === 1 && whole > 45) return `45+${whole - 45}'`
  if (period === 2 && whole > 90) return `90+${whole - 90}'`
  return `${whole}'`
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Game clock of a tick, from the recorded frame display ticks. NEVER tick / 240: the tick to display-tick offset differs per
 * period and per recording (period 2 display ticks restart at 45:00, with offsets such as 323 and 564 in the real recordings).
 * With `period` the tick is read inside that period; without it the period is the one whose frames contain the tick (ticks keep
 * counting across periods). A tick below zero is the start of the match (the role timeline stores its first entry at -1).
 */
export function gameClockAt(fi: FrameIndex, tick: number, period?: number): GameClock {
  if (fi.length === 0) return { minute: null, label: 'unknown', period: null }
  if (tick < 0) return { minute: 0, label: 'start of match', period: fi.periods[0]! }
  let lo = 0, hi = fi.length - 1
  if (period !== undefined) {
    const first = fi.firstIndexOfPeriod(period)
    if (first === undefined) return { minute: null, label: 'unknown', period: null }
    lo = first
    while (hi > lo && fi.periods[hi] !== period) hi--
  }
  // First frame in [lo, hi] whose tick is at or after `tick`.
  let a = lo, b = hi + 1
  while (a < b) { const m = (a + b) >> 1; if (fi.ticks[m]! >= tick) b = m; else a = m + 1 }
  let i: number
  if (a > hi) {
    // After the last frame: read it from the last frame's offset only within one game minute, else there is no clock.
    if (tick - fi.ticks[hi]! > TICKS_PER_MINUTE) return { minute: null, label: 'after the end of capture', period: null }
    i = hi
  } else {
    i = a
    // In the gap between two periods there is no clock.
    if (period === undefined && fi.ticks[i]! > tick && i > 0 && fi.periods[i - 1] !== fi.periods[i]) return { minute: null, label: 'half-time', period: null }
    // The nearer of the two surrounding frames of the same period supplies the offset.
    if (fi.ticks[i]! > tick && i > lo && fi.periods[i - 1] === fi.periods[i] && tick - fi.ticks[i - 1]! < fi.ticks[i]! - tick) i--
  }
  const p = fi.periods[i]!
  const minute = round2(Math.max(0, tick - (fi.ticks[i]! - fi.displayTicks[i]!)) / TICKS_PER_MINUTE)
  return { minute, label: minuteLabel(minute, p), period: p }
}

/**
 * Game clock for views that have no frames (the catalog's stored recording keeps only each period's first and last display tick).
 * The period offset (tick minus display tick) is read at both ends of the period; when they agree it is applied to the tick, when they
 * differ the clock is reported as unknown rather than guessed. Never tick / 240. `gameClockAt` over the frames is exact and is used by
 * every analytics result; this one only serves `fmmi show` and the observed role changes in the tactical-notes result.
 */
export function gameClockFromPeriods(periods: readonly PeriodSpan[], tick: number, period?: number): GameClock {
  if (periods.length === 0) return { minute: null, label: 'unknown', period: null }
  if (tick < 0) return { minute: 0, label: 'start of match', period: periods[0]!.period }
  let span: PeriodSpan | undefined
  if (period !== undefined) span = periods.find((p) => p.period === period)
  else {
    span = periods.find((p) => tick >= p.firstTick && tick <= p.lastTick)
    if (!span) {
      if (tick < periods[0]!.firstTick) span = periods[0]
      else {
        const last = periods[periods.length - 1]!
        if (tick <= last.lastTick) return { minute: null, label: 'half-time', period: null }
        if (tick - last.lastTick > TICKS_PER_MINUTE) return { minute: null, label: 'after the end of capture', period: null }
        span = last
      }
    }
  }
  if (!span) return { minute: null, label: 'unknown', period: null }
  const first = span.firstTick - span.firstDisplayTick, end = span.lastTick - span.lastDisplayTick
  if (first !== end) return { minute: null, label: 'unknown', period: span.period }
  const minute = round2(Math.max(0, tick - first) / TICKS_PER_MINUTE)
  return { minute, label: minuteLabel(minute, span.period), period: span.period }
}

/** Elapsed on-pitch game-clock ticks inside a half-open window. Halftime is excluded because segments are per period. */
export function playingTicksInWindow(segments: readonly PlaySegment[], w: Window): number {
  let total = 0
  for (const s of segments) {
    const start = { period: s.period, tick: s.fromTick }
    const end = { period: s.period, tick: s.toTick }
    const lo = cmpPT(start, w.from) >= 0 ? start : { period: w.from.period, tick: w.from.tick }
    const hi = cmpPT(end, w.to) <= 0 ? end : { period: w.to.period, tick: w.to.tick }
    if (cmpPT(lo, hi) < 0 && lo.period === s.period && hi.period === s.period) total += hi.tick - lo.tick
  }
  return total
}

export function ticksToMinutes(ticks: number): number { return ticks / TICKS_PER_MINUTE }

/** 'ambiguous' when the instant coincides with a substitution flip: event-versus-flip order is not recorded. */
export function participationAt(segments: readonly PlaySegment[], b: { period: number; tick: number }): 'on' | 'off' | 'ambiguous' {
  let on = false
  for (const s of segments) {
    if (s.period !== b.period) continue
    if (s.fromReason === 'on_pitch' && s.fromTick === b.tick) return 'ambiguous'
    if (s.toReason === 'off_pitch' && s.toTick === b.tick) return 'ambiguous'
    if (b.tick >= s.fromTick && b.tick < s.toTick) on = true
  }
  return on ? 'on' : 'off'
}

/** Events are placed by (period, tick); the window is [from,to) so a boundary event is counted once. */
export function inWindow(e: { period: number | null; tick: number }, w: Window): boolean {
  if (e.period === null) return false
  const k = { period: e.period, tick: e.tick }
  return cmpPT(k, w.from) >= 0 && cmpPT(k, w.to) < 0
}
