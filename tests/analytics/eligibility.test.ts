// The one shared season-eligibility function (spec 6.3, 7.6) on plain facts: no recording, no catalog.
import { describe, expect, it } from 'vitest'
import { GATES, METRIC_DICTIONARY_HISTORY, METRIC_DICTIONARY_VERSION, SEASON_POLICY, seasonEligibility, renderMetricsDoc } from '@fmmi/analytics'
import type { EligibilityFacts } from '@fmmi/analytics'

const full: EligibilityFacts = {
  identityStatus: 'ok', completion: 'completed_manual', manualFinalScore: { home: 1, away: 0, differsFromObserved: false },
  coverage: { status: 'full_match', reasons: [], initialBaseline: 'zero_verified', endCaptureEndsAt: null }, capturedMinutes: 91, matchDate: '2026-08-01',
}
const early = (minutes: number, over: Partial<EligibilityFacts['coverage']> = {}): EligibilityFacts => ({
  ...full, capturedMinutes: minutes,
  coverage: { status: 'partial', reasons: ['recording_ends_before_regulation_end'], initialBaseline: 'zero_verified', endCaptureEndsAt: { period: 2, tick: 1, displayMinute: minutes }, ...over },
})

describe('Slice 4 eligibility policy: one function for every season query', () => {
  it('the early-ending minimum is a labelled heuristic held in the registry (80 captured game minutes)', () => {
    expect(GATES.season.earlyEndingMinCapturedMinutes).toBe(80)
    expect(GATES.season.label).toBe('heuristic')
    expect(SEASON_POLICY.earlyEndingMinCapturedMinutes).toBe(GATES.season.earlyEndingMinCapturedMinutes)
    expect(SEASON_POLICY.earlyEndingLabel).toBe('heuristic')
    expect(renderMetricsDoc()).toMatch(/Early-ending minimum\*\*: 80 captured game minutes \(heuristic, not a calibrated norm\)/)
  })

  it('a confirmed full-match capture is in rates, totals and the record; the manual confirmation is disclosed', () => {
    const e = seasonEligibility(full)
    expect(e).toMatchObject({ rates: true, totals: true, record: 'manual', matchClass: 'full_match', reasons: [], partialOptIn: false })
    expect(e.disclosures).toEqual(['manual_confirmation'])
  })

  it('a verified `completed` match counts with an observed (not manual) final score', () => {
    expect(seasonEligibility({ ...full, completion: 'completed', manualFinalScore: null })).toMatchObject({ rates: true, totals: true, record: 'observed_final', disclosures: [] })
  })

  it('unknown and in-progress completion are excluded with a reason, however complete the capture is', () => {
    expect(seasonEligibility({ ...full, completion: 'unknown', manualFinalScore: null })).toMatchObject({ rates: false, totals: false, reasons: ['completion_unknown'], partialOptIn: false })
    expect(seasonEligibility({ ...full, completion: 'in_progress', manualFinalScore: null }).reasons).toEqual(['completion_in_progress'])
  })

  it('an unresolved identity conflict is excluded and is never offered by the partial opt-in', () => {
    const e = seasonEligibility({ ...full, identityStatus: 'identity_conflict' })
    expect(e).toMatchObject({ rates: false, reasons: ['identity_conflict_unresolved'], partialOptIn: false })
    expect(seasonEligibility({ ...full, identityStatus: 'separate_occurrence' }).rates).toBe(true)
    expect(seasonEligibility({ ...full, identityStatus: 'ignored' }).rates).toBe(false)
  })

  it('an undated match cannot be placed in a rolling window and is excluded', () => {
    expect(seasonEligibility({ ...full, matchDate: null })).toMatchObject({ rates: false, reasons: ['match_date_unavailable'], partialOptIn: false })
  })

  it('early-ending boundary: 79.99 minutes is excluded, exactly 80 and 80.01 are in rates but never in totals', () => {
    const below = seasonEligibility(early(79.99))
    expect(below).toMatchObject({ rates: false, totals: false, matchClass: 'partial_recording', partialOptIn: true })
    expect(below.reasons).toEqual(['early_ending_below_80_captured_minutes'])
    for (const m of [80, 80.01, 87.62]) {
      const e = seasonEligibility(early(m))
      expect(e, String(m)).toMatchObject({ rates: true, totals: false, record: 'manual', matchClass: 'early_ending', reasons: [], totalsExcludedBecause: ['early_ending_unseen_time'] })
      expect(e.disclosures).toEqual(['manual_confirmation', 'early_ending'])
    }
  })

  it('an early ending needs a trustworthy baseline and no gap or missing period; otherwise it is a partial capture', () => {
    const gap = seasonEligibility(early(85, { reasons: ['recording_ends_before_regulation_end', 'gap_exceeds_tolerance'] }))
    expect(gap).toMatchObject({ rates: false, matchClass: 'partial_recording', partialOptIn: true })
    expect(gap.reasons).toEqual(['partial_capture', 'capture:recording_ends_before_regulation_end', 'capture:gap_exceeds_tolerance'])
    const base = seasonEligibility(early(85, { reasons: ['recording_ends_before_regulation_end', 'initial_baseline_unverified'], initialBaseline: 'unverified' }))
    expect(base.rates).toBe(false)
    expect(seasonEligibility(early(85, { endCaptureEndsAt: null })).rates).toBe(false)
  })

  it('an unconfirmed early-ending recording is excluded for completion and is a partial opt-in candidate', () => {
    const e = seasonEligibility({ ...early(87.6), completion: 'unknown', manualFinalScore: null })
    expect(e).toMatchObject({ rates: false, partialOptIn: true })
    expect(e.reasons).toContain('completion_unknown')
  })

  it('a manual final score that differs from the observed score is disclosed', () => {
    expect(seasonEligibility({ ...full, manualFinalScore: { home: 3, away: 0, differsFromObserved: true } }).disclosures).toEqual(['manual_confirmation', 'manual_final_score_differs_from_observed'])
  })
})

describe('Slice 4 dictionary version and history', () => {
  it('the dictionary is 1.2 and the version history in docs/metrics.md names 1.0, 1.1 and 1.2', () => {
    expect(METRIC_DICTIONARY_VERSION).toBe('1.2')
    expect(METRIC_DICTIONARY_HISTORY.map((h) => h.version)).toEqual(['1.0', '1.1', '1.2'])
    const doc = renderMetricsDoc()
    expect(doc).toContain('## Version history')
    expect(doc).toMatch(/\| 1\.2 \| 2026-10-30 \|/)
    expect(doc).toMatch(/\| 1\.1 \| 2026-10-30 \|/)
    expect(doc).toMatch(/\| 1\.0 \| 2026-10-30 \|/)
    expect(METRIC_DICTIONARY_HISTORY[1]!.added).toEqual(expect.arrayContaining(['attack_lane', 'native_rating', 'goals_per_90', 'non_penalty_xg']))
    expect(METRIC_DICTIONARY_HISTORY[2]!.changed).toEqual(['chance_creation_by_wing_trend (v1 unavailable -> v2 derived)'])
  })
})
