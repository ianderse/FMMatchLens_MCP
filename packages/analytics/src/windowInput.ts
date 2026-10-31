import { DomainError, resolveDisplayMinute } from '@fmmi/model'
import type { Boundary } from '@fmmi/model'
import type { AnalysisInput, WindowSpec } from './context.ts'

/**
 * Window input shared by the CLI, the MCP tools and the live tools, so every surface resolves a window the same way: a canonical boundary
 * `<period>:<tick>` or a period-aware minute shortcut (spec 7.1). Half-open [from,to); ambiguous or out-of-range input is an error.
 */
export interface WindowOptions {
  /** Canonical boundary `<period>:<tick>`. */
  from?: string
  to?: string
  /** Period-aware minute shortcuts; `period` is required when the minute exists in more than one period. */
  fromMinute?: number
  toMinute?: number
  period?: number
}

export function parseBoundary(text: string): Boundary {
  const m = /^(\d+):(\d+)(?::(\d+))?$/.exec(text.trim())
  if (!m) throw new DomainError('invalid_input', 'A boundary looks like <period>:<tick>, for example 2:13700', { reason: 'boundary_format' })
  return { period: Number(m[1]), tick: Number(m[2]), sequence: m[3] ? Number(m[3]) : 0 }
}

export function resolveWindowOptions(input: AnalysisInput, o: WindowOptions | undefined): WindowSpec {
  if (!o) return {}
  const fi = input.decoded.sampled.frames
  if (o.from !== undefined && o.fromMinute !== undefined) throw new DomainError('invalid_input', 'Use either from or fromMinute', { reason: 'window_conflict' })
  if (o.to !== undefined && o.toMinute !== undefined) throw new DomainError('invalid_input', 'Use either to or toMinute', { reason: 'window_conflict' })
  const spec: WindowSpec = {}
  if (o.from !== undefined) spec.from = parseBoundary(o.from)
  else if (o.fromMinute !== undefined) spec.from = resolveDisplayMinute(fi, o.fromMinute, o.period)
  if (o.to !== undefined) spec.to = parseBoundary(o.to)
  else if (o.toMinute !== undefined) spec.to = resolveDisplayMinute(fi, o.toMinute, o.period)
  return spec
}
