import type { NullReason, Participant } from '@fmmi/model'
import { RATING_MODEL } from './registry.ts'
import type { Ctx } from './context.ts'

/** Fixed wording. Estimates of upstream mechanics; never a statement about what the game uses. */
export const RATING_LIMITATIONS: readonly string[] = [
  'The breakdown is an estimate produced by FMMatchLens v0.7.0 (upstream), a frontend reconstruction of rating mechanics from observed weights. It is not official Sports Interactive data.',
  'The weight table was observed on an FM26 build and applied to an FM27 recording; whether the FM27 game uses the same weights is unverified, and no result here states that it does.',
  'Two weights (W04, W05) are unresolved upstream, and the sample can follow the native calculation by a few ticks, so a residual is expected.',
  'Categories group upstream weight indices (context, shooting, creativity, passing, defending, goalkeeping). A category is a bookkeeping group, not a measure of how well the player performed in that area.',
  'The rating is sampled at the last captured frame and ignores any time window requested for the other player metrics.',
]

const isFinalCapture = (ctx: Ctx) => ctx.rec.coverage.status === 'full_match' && (ctx.input.completion.status === 'completed' || ctx.input.completion.status === 'completed_manual')

/**
 * Rating block for one player (spec 7.5). Native rating (observed), estimated category contributions, reconstruction
 * residual, model version, limitations and quality flags stay in separate fields. When the model data is missing or not
 * trustworthy the estimate is null with a reason; nothing precise-looking is substituted.
 */
export function ratingBlock(ctx: Ctx, p: Participant) {
  const ev = ctx.input.decoded.ratings
  const mine = ev?.players.get(p.upstreamPlayerId)
  const sampledAt = ev?.sampledAt ?? null
  const native = mine?.nativeRating ?? p.nativeRating
  const final = isFinalCapture(ctx)
  const where = sampledAt ? `period ${sampledAt.period} tick ${sampledAt.tick} (game minute ${sampledAt.displayMinute})` : 'the last captured frame'
  const statement = final
    ? `Sampled at the last captured frame, ${where}.`
    : `Sampled at the last captured frame, ${where}. The capture is ${ctx.rec.coverage.status} and completion is ${ctx.input.completion.status}, so this is the rating at the end of capture, not the final match rating.`
  const offPitch = !p.participation.onPitchAtEndOfRecording && p.participation.status === 'played'
  let estimate: null | Record<string, unknown> = null
  let nullReason: NullReason | null = null
  let reason: string | null = null
  if (!mine) { nullReason = 'not_recorded'; reason = 'rating_model_missing' }
  else if (mine.estimate === null) { nullReason = mine.nullReason; reason = mine.reason }
  else {
    const e = mine.estimate
    estimate = {
      label: 'estimated',
      unit: 'internal_rating_units',
      unitNote: RATING_MODEL.unitNote,
      baseline: e.baseline,
      contributions: e.contributions,
      preFactorTotal: e.preFactorTotal,
      effectiveFactor: e.effectiveFactor,
      globalFactorAdjustment: e.globalFactorAdjustment,
      predictedInternalScore: e.predictedInternalScore,
      recordedInternalScore: e.internalScore,
      reconstructionResidual: { internalUnits: e.reconstructionResidual, ratingPoints: e.reconstructionResidual / 1000, label: 'model_error_not_a_football_contribution' },
      eligibleDurationTicks: e.eligibleDurationTicks,
      classificationDurations: e.classificationDurations,
    }
  }
  return {
    native: { value: native, label: 'observed' as const, basis: 'observed_value_at_sampled_frame', onPitchAtSample: p.participation.onPitchAtEndOfRecording },
    sampledAt,
    statement: offPitch ? `${statement} The player was off the pitch at that frame; the value is the one carried in it.` : statement,
    estimate,
    nullReason,
    reason,
    model: { id: RATING_MODEL.id, version: RATING_MODEL.version, source: RATING_MODEL.source, matchPhaseAtSample: ev?.matchPhase ?? null },
    limitations: [...RATING_LIMITATIONS],
    qualityFlags: mine?.qualityFlags ?? [],
  }
}
