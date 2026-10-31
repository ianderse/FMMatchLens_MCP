import { TICKS_PER_MINUTE, round } from '@fmmi/model'
import type { RatingCategory, RatingEstimate, RatingEvidence, RatingPlayerEvidence } from '@fmmi/model'
import type { RealtimeFrame, RatingContributionGroup } from './upstream/realtimeTypes.ts'
import { calculateRatingContribution, decodeArchiveRatingInputs } from './upstream/ratingCalculator.ts'

/**
 * FMMI-authored. Runs the retained upstream rating calculator (MIT, see NOTICE.md) over the LAST decoded frame only, so the
 * result is the rating state at the end of capture, never a final match rating. The calculator is an upstream estimate of
 * rating mechanics; nothing here claims the game uses these weights.
 */
export const RATING_MODEL_ID = 'fmmatchlens_rating_reconstruction'
export const RATING_MODEL_VERSION = 'fmmatchlens-v0.7.0-ratingCalculator'

const CATEGORY: Record<RatingContributionGroup, RatingCategory> = {
  BaseContext: 'context', Shooting: 'shooting', Creativity: 'creativity', Passing: 'passing', Defence: 'defending', Goalkeeping: 'goalkeeping',
}
const CATEGORY_ORDER: RatingContributionGroup[] = ['Shooting', 'Creativity', 'Passing', 'Defence', 'Goalkeeping', 'BaseContext']

/** Flags that mean part of the weight table did not apply, so a breakdown would look more precise than it is. */
const UNTRUSTED = /^(unmapped_role_|missing_weight_bit_|unmapped_rating_event_mask_|invalid_rating_event_record)/

export function estimateRatings(f: RealtimeFrame): RatingEvidence {
  const sampledAt = { period: f.period, tick: f.tick, displayMinute: round(f.displayTick / TICKS_PER_MINUTE, 2) }
  const players = new Map<number, RatingPlayerEvidence>()
  for (const p of f.players) {
    const base = { nativeRating: p.rating }
    const none = (nullReason: RatingPlayerEvidence['nullReason'], reason: string, qualityFlags: string[] = []): RatingPlayerEvidence =>
      ({ ...base, estimate: null, nullReason, reason, qualityFlags })
    if (!f.ratingModel) { players.set(p.playerId, none('not_recorded', 'rating_model_missing')); continue }
    if (!p.archiveRatingInputs) { players.set(p.playerId, none('not_recorded', 'rating_inputs_missing')); continue }
    if (p.archiveRatingInputs.totalEligibleDuration <= 0) { players.set(p.playerId, none('not_applicable', 'no_eligible_playing_time', p.archiveRatingInputs.qualityFlags)); continue }
    let c
    try { c = calculateRatingContribution(decodeArchiveRatingInputs(p.archiveRatingInputs, p, f.ratingModel)) } catch {
      players.set(p.playerId, none('unverified_semantics', 'calculation_failed')); continue
    }
    const untrusted = c.qualityFlags.filter((x) => UNTRUSTED.test(x))
    if (untrusted.length > 0) { players.set(p.playerId, none('unverified_semantics', 'role_or_weight_not_in_upstream_table', c.qualityFlags)); continue }
    if (c.qualityFlags.includes('partial_classification_history') || c.qualityFlags.includes('classification_duration_reset')) {
      players.set(p.playerId, none('partial', 'classification_history_incomplete', c.qualityFlags)); continue
    }
    const estimate: RatingEstimate = {
      contributions: CATEGORY_ORDER.map((g) => ({ category: CATEGORY[g], preFactor: c.groupContributionsPreFactor[g], postFactor: c.groupContributionsPostFactor[g] })),
      baseline: f.ratingModel.activeBaseline,
      preFactorTotal: c.preFactorTotal,
      effectiveFactor: c.effectiveFactor,
      globalFactorAdjustment: c.globalFactorAdjustment,
      predictedInternalScore: c.predictedInternalScore,
      internalScore: c.internalScore,
      reconstructionResidual: c.reconstructionResidual,
      eligibleDurationTicks: p.archiveRatingInputs.totalEligibleDuration,
      classificationDurations: c.classificationDurations.map((d) => ({ categoryBit: d.categoryBit, duration: d.duration })),
      qualityFlags: c.qualityFlags,
    }
    players.set(p.playerId, { ...base, estimate, nullReason: null, reason: null, qualityFlags: c.qualityFlags })
  }
  return { sampledAt, matchPhase: f.ratingModel?.matchPhase ?? null, players }
}
