import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FINDING_RULES, GATES, METRIC_DICTIONARY_VERSION, METRIC_REGISTRY, COUNTER_KEYS, chanceQualitySuppression, direction, exposureGate, getDefinition,
  lowAerialSuccessGate, per90, percent, pooledRatio, ratio, renderMetricsDoc,
} from '@fmmi/analytics'

const ROOT = join(import.meta.dirname, '..', '..')

describe('versioned metric definition registry (spec 7.7)', () => {
  it('every definition has an ID, an integer version, a unit, a formula, eligibility, null reasons, a scope, rounding and a tolerance', () => {
    expect(METRIC_DICTIONARY_VERSION).toBe('1.3')
    const ids = METRIC_REGISTRY.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of METRIC_REGISTRY) {
      expect(Number.isInteger(d.version) && d.version >= 1, d.id).toBe(true)
      for (const f of ['unit', 'formula', 'scope', 'eligibility', 'rounding', 'tolerance', 'semantics', 'derivation'] as const) expect(d[f], `${d.id}.${f}`).toBeTruthy()
      expect(d.nullReasons.length, d.id).toBeGreaterThan(0)
    }
  })

  it('the derived final-third entry and the upstream counter are distinct IDs; progressive passes stay an upstream counter', () => {
    expect(getDefinition('final_third_entry_passes').id).not.toBe(getDefinition('final_third_passes').id)
    expect(getDefinition('final_third_entry_passes').thresholds).toEqual({ finalThirdFraction: 2 / 3 })
    expect(getDefinition('progressive_passes').title).toMatch(/upstream counter/)
    expect(getDefinition('progressive_passes').semantics).toMatch(/unverified/)
    expect(getDefinition('possession_pct').unitVerified).toBe(false)
    expect(getDefinition('ground_service_receptions').kind).toBe('unavailable')
    expect(() => getDefinition('final_third_touches')).toThrowError(/no registry definition/)
    expect(() => getDefinition('support_proximity')).toThrowError(/no registry definition/)
  })

  it('thresholds in the registry equal the gates the code uses', () => {
    const low = FINDING_RULES.find((r) => r.id === 'low_aerial_success_v1')!
    expect(low.thresholds).toEqual({ minAttempts: 5, maxWinRatio: 0.25 })
    const cmp = FINDING_RULES.find((r) => r.id === 'reception_rate_comparison_v1')!
    expect(cmp.thresholds).toMatchObject({ minPlayerMinutes: 15, minTeamCompletedPasses: 30, recipientCoverageMin: 0.95 })
    expect(GATES.recipientCoverageMin).toBe(0.95)
    for (const id of Object.keys(COUNTER_KEYS)) expect(getDefinition(id).kind).toBe('observed_counter')
  })

  it('docs/metrics.md is generated from the registry and is current', () => {
    const doc = renderMetricsDoc()
    expect(readFileSync(join(ROOT, 'docs', 'metrics.md'), 'utf8')).toBe(doc)
    for (const d of METRIC_REGISTRY) expect(doc).toContain(`\`${d.id}\` (version ${d.version})`)
  })

  it('analytics is pure: it imports no store, FMMatchLens adapter, SQLite or MCP code', () => {
    const dir = join(ROOT, 'packages', 'analytics')
    const files = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const text = readFileSync(join(dir, 'src', f), 'utf8')
      expect(text, f).not.toMatch(/@fmmi\/(store|fmlens-adapter|cli|query)|better-sqlite3|node:sqlite|modelcontextprotocol|node:fs|node:net|fetch\(/)
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@fmmi/model', 'zod'])
  })
})

describe('finding gates (spec 7.7): equality and just-below cases', () => {
  const g = (a: number | null, w: number | null) => lowAerialSuccessGate(a, w)
  it('low_aerial_success_v1 fires at exactly 5 attempts and at exactly 25%, and not just below either threshold', () => {
    expect(g(5, 0).fires).toBe(true) // 0/5 at the minimum attempts
    expect(g(4, 0).fires).toBe(false) // one attempt short
    expect(g(4, 0).eligible).toBe(false)
    expect(g(8, 2).fires).toBe(true) // exactly 25%
    expect(g(12, 3).fires).toBe(true) // exactly 25%
    expect(g(9, 3).fires).toBe(false) // 33%
    expect(g(7, 2).fires).toBe(false) // 28.6%: just above 25%
    expect(g(20, 5).fires).toBe(true)
    expect(g(20, 6).fires).toBe(false)
    expect(g(7, 0).fires).toBe(true) // the 0/7 case
    expect(g(4, 3).fires).toBe(false) // the 3/4 case: too few attempts and a high ratio
  })
  it('missing or inconsistent denominators never fire', () => {
    expect(g(null, 0).fires).toBe(false)
    expect(g(5, null).reasons).toEqual(['aerial_counters_unresolved'])
    expect(g(0, 0).fires).toBe(false)
    expect(g(5, 6).reasons).toEqual(['aerial_counters_inconsistent'])
  })
  it('the comparative exposure gate passes at exactly 15 minutes and 30 team passes and fails just below either; it ignores the player own count', () => {
    expect(exposureGate({ playerTicks: 3600, teamCompletedPasses: 30 }).passes).toBe(true)
    expect(exposureGate({ playerTicks: 3599, teamCompletedPasses: 30 })).toMatchObject({ passes: false, reasons: ['fewer_than_15_verified_playing_minutes'] })
    expect(exposureGate({ playerTicks: 3600, teamCompletedPasses: 29 })).toMatchObject({ passes: false, reasons: ['fewer_than_30_team_completed_passes'] })
    expect(exposureGate({ playerTicks: 0, teamCompletedPasses: 0 }).reasons).toHaveLength(2)
    expect(exposureGate.length).toBe(1) // exposure only: there is no argument for a reception or progression count
  })
  it('chance-quality findings are suppressed for a single-shot window and for zero or unknown shots', () => {
    expect(chanceQualitySuppression(1)).toEqual(['single_shot_window'])
    expect(chanceQualitySuppression(0)).toEqual(['zero_shots'])
    expect(chanceQualitySuppression(null)).toEqual(['shots_unresolved'])
    expect(chanceQualitySuppression(2)).toEqual([])
  })
  it('direction reports the sign of a difference only', () => {
    expect([direction(2, 1), direction(1, 2), direction(1, 1)]).toEqual(['higher', 'lower', 'equal'])
  })
})

describe('ratios and pooled aggregation', () => {
  it('missing denominators give null with a reason, never zero', () => {
    expect(percent(0, 0)).toEqual({ value: null, nullReason: 'zero_denominator' })
    expect(percent(null, 5)).toEqual({ value: null, nullReason: 'missing_baseline' })
    expect(percent(5, null)).toEqual({ value: null, nullReason: 'missing_baseline' })
    expect(percent(0, 7).value).toBe(0)
    expect(ratio(1, 0).nullReason).toBe('zero_denominator')
    expect(per90(3, 0)).toEqual({ value: null, nullReason: 'zero_denominator' })
    expect(per90(null, 100).value).toBeNull()
    expect(per90(1, 240 * 90).value).toBe(1)
    expect(per90(2, 240 * 45).value).toBe(4)
  })
  it('pooled ratios sum numerators and denominators; they never average the ratios', () => {
    const parts = [{ numerator: 1, denominator: 2 }, { numerator: 3, denominator: 10 }]
    const p = pooledRatio(parts, 100)
    expect(p).toMatchObject({ numerator: 4, denominator: 12, contributing: 2, excluded: 0 })
    expect(p.value).toBeCloseTo((100 * 4) / 12, 10) // 33.3, not the mean of 50 and 30
    expect(p.value).not.toBeCloseTo(40, 3)
  })
  it('a match with a missing numerator or denominator contributes to neither; a zero denominator contributes its numerator and zero', () => {
    const p = pooledRatio([{ numerator: 1, denominator: 2 }, { numerator: null, denominator: 10 }, { numerator: 5, denominator: null }, { numerator: 0, denominator: 0 }], 100)
    expect(p).toMatchObject({ numerator: 1, denominator: 2, contributing: 2, excluded: 2, value: 50 })
    expect(pooledRatio([{ numerator: null, denominator: null }])).toMatchObject({ value: null, nullReason: 'missing_baseline', contributing: 0, excluded: 1 })
    expect(pooledRatio([{ numerator: 0, denominator: 0 }])).toMatchObject({ value: null, nullReason: 'zero_denominator', contributing: 1 })
    expect(pooledRatio([])).toMatchObject({ value: null })
  })
  it('pooled per-90 weights by minutes: 2 in 45 plus 0 in 90 is 1.33 per 90, not the mean of 4 and 0', () => {
    const p = pooledRatio([{ numerator: 2, denominator: 45 }, { numerator: 0, denominator: 90 }], 90)
    expect(p.value).toBeCloseTo(1.3333333, 6)
  })
})
