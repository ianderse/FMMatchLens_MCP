import { DomainError, toErrorBody } from '@fmmi/model'
import type { ErrorBody } from '@fmmi/model'
import type * as z from 'zod/v4'

/** Spec 8.2 domain-error body for a schema failure. Field names and constraint messages only, never the offending values. */
export function schemaError(error: z.ZodError): DomainError {
  const issues = error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.') || '(arguments)', message: i.message }))
  return new DomainError('invalid_input', 'The arguments do not match the tool input schema', { reason: 'schema', issues })
}

/** Every thrown value becomes the stable body; anything that is not a DomainError is an opaque internal_error. */
export function bodyOf(e: unknown): ErrorBody { return toErrorBody(e) }

export function errorResult(body: ErrorBody) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body as unknown as Record<string, unknown>, isError: true as const }
}
