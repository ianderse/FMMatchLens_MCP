/** 240 ticks = 1 game minute (docs/data-coverage.md section 3). */
export const TICKS_PER_MINUTE = 240

/**
 * Registry tolerance for a gap inside one period (spec 6.3). Frames are sampled, so ordinary tick gaps are normal
 * (the audited recording has 738, largest 127 ticks). Only a frame-to-frame gap strictly greater than this inside
 * a period counts as a capture gap. Initial value: 240 ticks, one game minute.
 */
export const GAP_TOLERANCE_TICKS = 240

/**
 * Earliest display tick at which period 2 can end naturally (90:00). Heuristic, not a source signal: the format has
 * no full-time marker (docs/data-coverage.md section 3).
 */
export const REGULATION_END_DISPLAY_TICKS = 90 * TICKS_PER_MINUTE

export const SCHEMA_VERSION = '1.0'
export const PROJECTION_VERSION = 'slice1.v1'
export const SUPPORTED_FORMAT = '2.8'
