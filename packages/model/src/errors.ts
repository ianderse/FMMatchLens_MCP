export type ErrorCode =
  | 'invalid_input' | 'not_found' | 'ambiguous_selection' | 'identity_conflict' | 'revision_unavailable'
  | 'unsupported_version' | 'insufficient_coverage' | 'stale_snapshot' | 'storage_limit_exceeded' | 'internal_error'

export interface ErrorBody {
  code: ErrorCode
  message: string
  details: Record<string, unknown>
  retryable: boolean
}

/** Domain error with the stable body from spec 8.2. Never carries paths or stack traces in its body. */
export class DomainError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>
  readonly retryable: boolean
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, retryable = false) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
    this.retryable = retryable
  }
  toBody(): ErrorBody {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable }
  }
}

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof DomainError) return e.toBody()
  return { code: 'internal_error', message: 'Unexpected internal error', details: {}, retryable: false }
}

/**
 * Opt-in diagnosability (FMMI_DEBUG=1): the stack of an unexpected, non-domain error goes to the supplied stderr writer.
 * Client-facing bodies stay opaque either way. Domain errors never print a stack.
 */
export function debugEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.FMMI_DEBUG
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

export function debugReport(e: unknown, env: NodeJS.ProcessEnv, write: (s: string) => void): void {
  if (e instanceof DomainError || !debugEnabled(env)) return
  write(`FMMI_DEBUG ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
}
