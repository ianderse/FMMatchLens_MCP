import type { z } from 'zod'
import { ENDPOINTS } from './endpoint.ts'
import type { EndpointSpec } from './endpoint.ts'
import { LocalPluginClient } from './client.ts'
import type { FetchFailure } from './client.ts'
import { ArchivesSchema, CurrentSchema, EnvelopeSchema, FormationSliceSchema, FramesSliceSchema, FrameSchema, HealthSchema, MatchStatusSchema, MetaSchema, MomentumSchema } from './schemas.ts'

/**
 * `fmmi live capture` / `fmmi live check`: the diagnostic that closes the gap between what is MODELLED here and what a real plugin
 * serves. During a real match the user runs capture; it records each endpoint's response as a sanitised SKELETON (structure, types,
 * numbers, array lengths) in a local, gitignored file. and validates each RAW response with its schema at that moment. `check` reports that stored verdict
 * (the skeleton, cut to two array elements, is not validated: it would hide an invalid later element). Until that has been run against a real match, the live path is unverified (docs/data-coverage.md, setup docs).
 *
 * Sanitising: no free text leaves the response. Strings are replaced by a placeholder except a short allowlist of enum-like keys; the
 * identifier-like numbers (uids, player ids, timestamps) are zeroed; arrays keep their first two elements and record their length.
 * The skeleton cannot be turned back into names or paths.
 */
export const CAPTURE_VERSION = 2

/**
 * The verdict of validating one RAW response (or socket envelope) with its schema at capture time. The sanitised skeleton cannot carry
 * it: arrays are cut to two elements, so an invalid third element would pass on the skeleton while the full response fails. Issues name
 * a path with array indices collapsed to `[]`, the issue code and the expected and received TYPES; never a value, a name or an id.
 */
export interface ShapeValidation { valid: boolean; issueCount: number; issues: ShapeIssue[] }
export interface ShapeIssue { path: string; code: string; expected: string | null; received: string | null }
const MAX_ISSUES = 10

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const collapse = (path: ReadonlyArray<PropertyKey>): string => path.map((k) => (typeof k === 'number' ? '[]' : `.${String(k)}`)).join('').replace(/^\./, '') || '(root)'
function receivedTypeAt(root: unknown, path: ReadonlyArray<PropertyKey>): string | null {
  let cur = root
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<PropertyKey, unknown>)[k as never]
  }
  return typeName(cur)
}

export function validateRaw(schema: z.ZodType, raw: unknown, prefix: ReadonlyArray<PropertyKey> = []): ShapeValidation {
  const r = schema.safeParse(raw)
  if (r.success) return { valid: true, issueCount: 0, issues: [] }
  const seen = new Set<string>()
  const issues: ShapeIssue[] = []
  for (const i of r.error.issues) {
    const issue: ShapeIssue = {
      path: collapse([...prefix, ...i.path]), code: i.code,
      expected: typeof (i as { expected?: unknown }).expected === 'string' ? (i as unknown as { expected: string }).expected : null,
      received: receivedTypeAt(raw, i.path),
    }
    const key = JSON.stringify(issue)
    if (seen.has(key)) continue
    seen.add(key)
    issues.push(issue)
  }
  return { valid: false, issueCount: r.error.issues.length, issues: issues.slice(0, MAX_ISSUES) }
}

const detailOf = (v: ShapeValidation): string =>
  v.issues.slice(0, 3).map((i) => `${i.path}: ${i.code}${i.expected ? ` (expected ${i.expected}${i.received ? `, received ${i.received}` : ''})` : ''}`).join('; ').slice(0, 200) || 'invalid'

const KEEP_STRING_KEYS = new Set(['status', 'team', 'type', 'game', 'gameVersion', 'pluginVersion', 'operation', 'side'])
const ZERO_NUMBER_KEYS = new Set(['uid', 'clubUid', 'playerId', 'receiverPlayerId', 'shirtNumber', 'squadNumber', 'startedUnixMilliseconds', 'capturedUnixMilliseconds', 'fileSizeBytes', 'slot', 'receiverPlayerSlot', 'playerSlot'])
const KEEP_ARRAY = 2
const MAX_DEPTH = 8

export function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (depth > MAX_DEPTH) return null
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return ZERO_NUMBER_KEYS.has(key) ? 0 : value
  if (typeof value === 'string') return KEEP_STRING_KEYS.has(key) && value.length <= 24 && /^[A-Za-z0-9._ -]*$/.test(value) ? value : 'x'
  if (Array.isArray(value)) {
    return value.slice(0, KEEP_ARRAY).map((v) => sanitize(v, key, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, k, depth + 1)
      if (Array.isArray(v) && v.length > KEEP_ARRAY) (out as Record<string, unknown>)[`${k}__length`] = v.length
    }
    return out
  }
  return null
}

export interface CapturedEndpoint {
  id: string
  path: string
  basis: EndpointSpec['basis']
  ok: boolean
  failure: FetchFailure | null
  httpStatus: number | null
  bytes: number | null
  ms: number
  skeleton: unknown
  /** Verdict on the full raw response. Absent in a capture file made before CAPTURE_VERSION 2: such a file cannot verify anything. */
  validation?: ShapeValidation
}
export interface CapturedMessage { type: string; bytes: number; skeleton: unknown; validation?: ShapeValidation }
export interface Capture {
  captureVersion: number
  createdAt: string
  host: string
  port: number
  endpoints: CapturedEndpoint[]
  websocket: { attempted: boolean; opened: boolean; failure: string | null; messages: CapturedMessage[] }
  note: string
}

export interface CaptureOptions {
  client: LocalPluginClient
  now?: () => string
  /** How long to listen on the socket for sample envelopes. 0 skips the socket. */
  socketMs?: number
  maxMessages?: number
  openSocket?: (url: string) => { onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; close(): void }
  port?: number
}

const SCHEMAS: Record<string, z.ZodType> = {
  health: HealthSchema, archives: ArchivesSchema, status: MatchStatusSchema, meta: MetaSchema, current: CurrentSchema, frames: FramesSliceSchema,
  formation_history: FormationSliceSchema, momentum_events: MomentumSchema, momentum_updates: MomentumSchema,
}

const PAYLOAD_SCHEMAS: Record<string, z.ZodType> = { realtime_tick: FrameSchema, formation_changed: FormationSliceSchema }

/** The envelope, and for the two payload kinds this project reads, the payload with its own schema (issue paths are prefixed `payload`). */
function validateEnvelope(env: unknown): ShapeValidation {
  const e = validateRaw(EnvelopeSchema, env)
  if (!e.valid) return e
  const o = env as { type: string; payload: unknown }
  const schema = PAYLOAD_SCHEMAS[o.type]
  return schema ? validateRaw(schema, o.payload, ['payload']) : e
}

export async function captureShapes(o: CaptureOptions): Promise<Capture> {
  const endpoints: CapturedEndpoint[] = []
  for (const e of ENDPOINTS) {
    const t0 = performance.now()
    const r = await o.client.getRaw(e.path)
    endpoints.push({
      id: e.id, path: e.path, basis: e.basis, ok: r.ok, failure: r.ok ? null : r.kind, httpStatus: r.ok ? 200 : (r.status ?? null),
      bytes: r.ok ? r.bytes : null, ms: Math.round(performance.now() - t0), skeleton: r.ok ? sanitize(r.data) : null,
      ...(r.ok ? { validation: validateRaw(SCHEMAS[e.id]!, r.data) } : {}),
    })
  }
  const ws: Capture['websocket'] = { attempted: (o.socketMs ?? 0) > 0, opened: false, failure: null, messages: [] }
  if (ws.attempted) {
    await new Promise<void>((resolve) => {
      let s: ReturnType<NonNullable<CaptureOptions['openSocket']>> | null = null
      const done = () => { try { s?.close() } catch { /* closed */ } resolve() }
      const timer = setTimeout(done, o.socketMs!)
      try { s = (o.openSocket ?? ((u) => new WebSocket(u) as never))(o.client.webSocketUrl) } catch { ws.failure = 'could_not_open'; clearTimeout(timer); resolve(); return }
      s!.onopen = () => { ws.opened = true }
      s!.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        try {
          const env = JSON.parse(ev.data) as { type?: unknown; payload?: unknown }
          ws.messages.push({ type: typeof env.type === 'string' ? env.type.slice(0, 40) : 'unknown', bytes: ev.data.length, skeleton: sanitize(env), validation: validateEnvelope(env) })
        } catch { ws.messages.push({ type: 'not_json', bytes: ev.data.length, skeleton: null, validation: { valid: false, issueCount: 1, issues: [{ path: '(root)', code: 'invalid_json', expected: null, received: null }] } }) }
        if (ws.messages.length >= (o.maxMessages ?? 3)) { clearTimeout(timer); done() }
      }
      s!.onerror = () => { ws.failure = ws.opened ? 'socket_error' : 'could_not_connect' }
      s!.onclose = () => { clearTimeout(timer); resolve() }
    })
  }
  return {
    captureVersion: CAPTURE_VERSION, createdAt: (o.now ?? (() => new Date().toISOString()))(), host: o.client.host, port: o.port ?? 16726, endpoints, websocket: ws,
    note: 'Sanitised structure only: free text is replaced, identifiers are zeroed, arrays keep two elements. Safe to keep locally; do not publish without reading it.',
  }
}

// ------------------------------------------------------------------ check

export interface CheckLine {
  id: string
  basis: EndpointSpec['basis'] | 'websocket'
  verdict: 'ok' | 'schema_mismatch' | 'not_captured' | 'no_match_data' | 'recapture_needed'
  detail: string
  extraKeys: string[]
}
export interface CheckReport {
  ok: boolean
  /** True only when every endpoint and the socket answered AND matched. A partial capture never verifies the live path. */
  verifiesLivePath: boolean
  lines: CheckLine[]
  summary: string
}

const keysOfSchema = (schema: z.ZodType): Set<string> => {
  const shape = (schema as unknown as { shape?: Record<string, unknown>; unwrap?: () => z.ZodType }).shape
  if (shape) return new Set(Object.keys(shape))
  const inner = (schema as unknown as { unwrap?: () => z.ZodType }).unwrap?.()
  return inner ? keysOfSchema(inner) : new Set()
}

const RECAPTURE = 'this capture file has no validation of the full response (made by an older version): recapture needed during a match; it cannot verify the live path'

export function checkCapture(c: Capture): CheckReport {
  const lines: CheckLine[] = []
  for (const spec of ENDPOINTS) {
    const e = c.endpoints.find((x) => x.id === spec.id)
    const schema = SCHEMAS[spec.id]!
    if (!e) { lines.push({ id: spec.id, basis: spec.basis, verdict: 'not_captured', detail: 'endpoint missing from the capture file', extraKeys: [] }); continue }
    if (!e.ok) { lines.push({ id: spec.id, basis: spec.basis, verdict: 'not_captured', detail: `the plugin did not answer (${e.failure ?? 'unknown'}${e.httpStatus ? ` ${e.httpStatus}` : ''})`, extraKeys: [] }); continue }
    if (e.skeleton === null && (spec.id === 'meta' || spec.id === 'current')) { lines.push({ id: spec.id, basis: spec.basis, verdict: 'no_match_data', detail: 'the plugin answered null: no match was running when this was captured; run capture again during a match', extraKeys: [] }); continue }
    // The verdict is the one taken on the RAW response at capture time. The skeleton is cut and sanitised, so it only supplies the extra-key notes.
    const known = keysOfSchema(schema)
    const extra = e.skeleton && typeof e.skeleton === 'object' && !Array.isArray(e.skeleton) ? Object.keys(e.skeleton as object).filter((k) => !k.endsWith('__length') && known.size > 0 && !known.has(k)) : []
    if (!e.validation) lines.push({ id: spec.id, basis: spec.basis, verdict: 'recapture_needed', detail: RECAPTURE, extraKeys: extra })
    else if (e.validation.valid) lines.push({ id: spec.id, basis: spec.basis, verdict: 'ok', detail: 'the full response matches the schema', extraKeys: extra })
    else lines.push({ id: spec.id, basis: spec.basis, verdict: 'schema_mismatch', detail: detailOf(e.validation), extraKeys: extra })
  }
  // The frame inside a socket tick and the formation slice inside formation_changed use the same schemas as the HTTP routes.
  const tick = c.websocket.messages.find((m) => m.type === 'realtime_tick')
  const form = c.websocket.messages.find((m) => m.type === 'formation_changed')
  const wsLine = (id: string, m: CapturedMessage | undefined, what: string): CheckLine => {
    if (!c.websocket.attempted) return { id, basis: 'websocket', verdict: 'not_captured', detail: 'the socket was not sampled (use --socket-seconds)', extraKeys: [] }
    if (!c.websocket.opened) return { id, basis: 'websocket', verdict: 'not_captured', detail: `the socket did not open (${c.websocket.failure ?? 'no reason'})`, extraKeys: [] }
    if (!m) return { id, basis: 'websocket', verdict: 'not_captured', detail: `no ${what} envelope arrived while listening`, extraKeys: [] }
    if (!m.validation) return { id, basis: 'websocket', verdict: 'recapture_needed', detail: RECAPTURE, extraKeys: [] }
    return m.validation.valid ? { id, basis: 'websocket', verdict: 'ok', detail: `the full ${what} envelope matches the schema`, extraKeys: [] } : { id, basis: 'websocket', verdict: 'schema_mismatch', detail: detailOf(m.validation), extraKeys: [] }
  }
  lines.push(wsLine('ws_realtime_tick', tick, 'realtime_tick'))
  lines.push(wsLine('ws_formation_changed', form, 'formation_changed'))
  const mismatches = lines.filter((l) => l.verdict === 'schema_mismatch')
  const missing = lines.filter((l) => l.verdict !== 'ok' && l.verdict !== 'schema_mismatch')
  const stale = lines.filter((l) => l.verdict === 'recapture_needed')
  const ok = mismatches.length === 0 && !lines.some((l) => l.verdict === 'recapture_needed')
  const verifies = ok && missing.length === 0
  const summary = verifies
    ? 'Every endpoint and the socket matched the schemas in this capture. The live path is now checked against ONE real capture; it is still not a guarantee for other match states.'
    : mismatches.length > 0
      ? `${mismatches.length} endpoint(s) differ from what this project expects: ${mismatches.map((m) => m.id).join(', ')}. The live reader will report schema_mismatch for them and degrade; do not rely on it until this is resolved.`
      : stale.length > 0
        ? `Recapture needed: ${stale.length} line(s) come from a capture made before the full response was validated at capture time (${stale.map((m) => m.id).join(', ')}). Nothing is verified from this file; run fmmi live capture again during a match.`
        : `No mismatch, but ${missing.length} endpoint(s) were not captured (${missing.map((m) => m.id).join(', ')}). The live path remains unverified for them. Run capture during a real match.`
  return { ok, verifiesLivePath: verifies, lines, summary }
}
