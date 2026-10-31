import { FINDING_RULES, METRIC_REGISTRY } from '@fmmi/analytics'
import { REVIEW_SECTIONS } from './prompt.ts'

/**
 * Review checker (spec Slice 3, section 12 Narrative row). It takes a SAVED assistant response and the SAVED tool results
 * that the assistant saw, and verifies deterministically:
 *   1. the five section headings are present, once each, in order;
 *   2. the Action section holds at most one action (or states why none is recommended);
 *   3. every cited id, metric id and time window appears in the tool results.
 * It is an evaluation tool for saved transcripts, not a CI golden test: LLM output is nondeterministic. It cannot judge
 * whether a hypothesis is well reasoned, so a human still reviews that (spec section 12).
 */

export interface ReviewCheckReport {
  ok: boolean
  failures: string[]
  warnings: string[]
  sections: { found: Array<{ key: string; heading: string; line: number }>; missing: string[]; duplicated: string[]; outOfOrder: boolean }
  action: { units: number; withheld: boolean; rule: string }
  citations: {
    ids: { cited: string[]; missing: string[] }
    metrics: { cited: string[]; missing: string[] }
    windows: { cited: string[]; missing: string[] }
  }
}

// ------------------------------------------------------------------ evidence

interface Evidence { text: string; ids: Set<string>; metrics: Set<string>; boundaries: Set<string>; minutePairs: Array<[number, number]>; minutes: number[] }

/** Accepts one record or a list; each may be a raw payload, `{tool, arguments, result}`, or an MCP CallToolResult. */
export function collectEvidence(results: unknown): Evidence {
  const ev: Evidence = { text: '', ids: new Set(), metrics: new Set(), boundaries: new Set(), minutePairs: [], minutes: [] }
  const strings: string[] = []
  const visit = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      strings.push(v)
      if (/^\d{1,2}:\d{1,7}$/.test(v)) ev.boundaries.add(v)
      if (key === 'metric' || key === 'ruleId') ev.metrics.add(v)
      return
    }
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) visit(x); return }
    const o = v as Record<string, unknown>
    if (typeof o.period === 'number' && typeof o.tick === 'number') ev.boundaries.add(`${o.period}:${o.tick}`)
    const d = o.display as Record<string, unknown> | undefined
    if (d && typeof d.fromMinute === 'number' && typeof d.toMinute === 'number') ev.minutePairs.push([d.fromMinute, d.toMinute])
    // Readable game minutes the results carry beside the canonical boundaries (onAtMinute, gameMinute, atMinute, fromMinute, displayMinute...).
    for (const [k, x] of Object.entries(o)) if (typeof x === 'number' && /(?:[a-z]Minute|^minute)$/.test(k)) ev.minutes.push(x)
    if (key === 'metrics' && o && typeof o === 'object') for (const k of Object.keys(o)) ev.metrics.add(k)
    for (const [k, x] of Object.entries(o)) { strings.push(k); visit(x, k) }
  }
  const unwrap = (rec: unknown): unknown[] => {
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      const o = rec as Record<string, unknown>
      // {tool, arguments, result} wrapper; a bare payload has its own `result` field (the match score), so require a sibling.
      if ('result' in o && ('tool' in o || 'arguments' in o)) return unwrap(o.result)
      if (Array.isArray(o.content) || 'structuredContent' in o) {
        const out: unknown[] = []
        if (o.structuredContent !== undefined) out.push(o.structuredContent)
        for (const c of Array.isArray(o.content) ? o.content : []) {
          const t = (c as { text?: unknown })?.text
          if (typeof t === 'string') { try { out.push(JSON.parse(t)) } catch { out.push(t) } }
        }
        return out
      }
    }
    return [rec]
  }
  for (const rec of Array.isArray(results) ? results : [results]) for (const p of unwrap(rec)) visit(p)
  ev.text = strings.join('\n')
  for (const m of ev.text.matchAll(/\b(?:m|r|s|t|p|lv|lr|lt|ln)_[0-9a-f]{12,16}\b/g)) ev.ids.add(m[0])
  return ev
}

// ------------------------------------------------------------------ response structure

const HEADING = /^\s{0,3}(?:#{1,6}\s+|\*\*|__)(.+?)(?:\*\*|__)?\s*:?\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const WITHHELD = /\b(no action|no change is recommended|not recommend|do not recommend|cannot recommend|no recommendation|withh[eo]ld|withholding|decline to recommend)/i

function classify(heading: string): (typeof REVIEW_SECTIONS)[number] | null {
  const text = heading.replace(/^[\s\W\d]*?(?=[A-Za-z])/, '').trim()
  return REVIEW_SECTIONS.find((s) => new RegExp(`^${s.pattern.source}`, s.pattern.flags).test(text)) ?? null
}

function splitSections(response: string) {
  const lines = response.split(/\r?\n/)
  const found: Array<{ key: string; heading: string; line: number; body: string[] }> = []
  let current: (typeof found)[number] | null = null
  lines.forEach((line, i) => {
    const m = HEADING.exec(line)
    const sec = m ? classify(m[1]!) : null
    if (sec) { current = { key: sec.key, heading: line.trim(), line: i + 1, body: [] }; found.push(current); return }
    if (m && /^#{1,3}\s/.test(line.trim())) current = null // an unrelated top-level heading ends the section
    else current?.body.push(line)
  })
  return found
}

/** Units of an Action section: list items when it is a list, else paragraphs. */
function actionUnits(body: string[]): number {
  const text = body.join('\n').trim()
  if (!text) return 0
  const items = body.filter((l) => LIST_ITEM.test(l)).length
  if (items > 0) return items
  return text.split(/\n\s*\n/).filter((p) => p.trim()).length
}

// ------------------------------------------------------------------ citations

const METRIC_IDS = new Set<string>([...METRIC_REGISTRY.map((m) => m.id), ...FINDING_RULES.map((r) => r.id)])
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

function citedMetrics(response: string): string[] {
  const out = new Set<string>()
  for (const m of response.matchAll(/`([^`\n]+)`/g)) if (SNAKE.test(m[1]!)) out.add(m[1]!)
  for (const m of response.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) if (METRIC_IDS.has(m[0])) out.add(m[0])
  return [...out]
}

function citedBoundaries(response: string): string[] {
  const out = new Set<string>()
  // Tick parts have at least three digits, so clock times such as 12:30 are not read as windows.
  for (const m of response.matchAll(/(?<![\d:.])(\d{1,2}:\d{3,7})(?![\d:])/g)) out.add(m[1]!)
  return [...out]
}

const MINUTE_PAIR = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:min\b|mins\b|minutes\b|')/gi
function citedMinutePairs(response: string): Array<[number, number]> {
  return [...response.matchAll(MINUTE_PAIR)].map((m) => [Number(m[1]), Number(m[2])] as [number, number])
}

/** Display minutes are rounded to two decimals in the results; a cited whole minute may round them by up to half a minute. */
const MINUTE_TOLERANCE = 0.5

export function checkReview(response: string, results: unknown): ReviewCheckReport {
  const failures: string[] = []
  const warnings: string[] = []
  const ev = collectEvidence(results)
  if (ev.text.trim() === '') failures.push('no_tool_results: nothing to check citations against')

  // 1. sections
  const found = splitSections(response)
  const keys = REVIEW_SECTIONS.map((s) => s.key)
  const missing = keys.filter((k) => !found.some((f) => f.key === k))
  const duplicated = keys.filter((k) => found.filter((f) => f.key === k).length > 1)
  const order = found.map((f) => keys.indexOf(f.key as (typeof keys)[number]))
  const outOfOrder = order.some((v, i) => i > 0 && v < order[i - 1]!)
  if (missing.length) failures.push(`missing_sections: ${missing.join(', ')}`)
  if (duplicated.length) failures.push(`duplicated_sections: ${duplicated.join(', ')}`)
  if (outOfOrder) failures.push('sections_out_of_order')

  // 2. at most one action
  const actionSec = found.find((f) => f.key === 'action')
  let units = 0, withheld = false
  if (actionSec) {
    const body = actionSec.body.join('\n')
    withheld = WITHHELD.test(body)
    units = actionUnits(actionSec.body)
    if (units === 0) failures.push('action_section_empty: give one action or state why none is recommended')
    else if (!withheld && units > 1) failures.push(`more_than_one_action: ${units} items in the Action section`)
    else if (withheld && actionSec.body.filter((l) => LIST_ITEM.test(l)).length > 1) failures.push('withheld_but_lists_several_items')
  }

  // 3. citations
  const ids = [...new Set([...response.matchAll(/\b(?:m|r|s|t|p|lv|lr|lt|ln)_[0-9a-f]{12,16}\b/g)].map((m) => m[0]))]
  const missingIds = ids.filter((id) => !ev.ids.has(id))
  if (missingIds.length) failures.push(`ids_not_in_tool_results: ${missingIds.join(', ')}`)
  const factsSec = found.find((f) => f.key === 'facts')
  if (factsSec && !/\b(?:m|r|s|t|p|lv|lr|lt|ln)_[0-9a-f]{12,16}\b/.test(factsSec.body.join('\n'))) failures.push('facts_cite_no_ids')

  const metrics = citedMetrics(response)
  // A registry metric id must be a metric the results actually reported; any other backticked token must at least occur in them.
  const missingMetrics = metrics.filter((m) => (METRIC_IDS.has(m) ? !ev.metrics.has(m) : !ev.text.includes(m)))
  if (missingMetrics.length) failures.push(`metrics_not_in_tool_results: ${missingMetrics.join(', ')}`)

  const bounds = citedBoundaries(response)
  const missingBounds = bounds.filter((b) => !ev.boundaries.has(b))
  const pairs = citedMinutePairs(response)
  // A cited span is real when it is a window the results report, or when both of its ends are game minutes the results report
  // (for example from a player's onAtMinute to his offAtMinute, or between two role changes).
  const near = (n: number) => ev.minutes.some((m) => Math.abs(m - n) <= MINUTE_TOLERANCE)
  const missingPairs = pairs.filter(([a, b]) => !ev.minutePairs.some(([x, y]) => Math.abs(x - a) <= MINUTE_TOLERANCE && Math.abs(y - b) <= MINUTE_TOLERANCE) && !(near(a) && near(b)))
  const missingWindows = [...missingBounds, ...missingPairs.map(([a, b]) => `${a}-${b} min`)]
  if (missingWindows.length) failures.push(`windows_not_in_tool_results: ${missingWindows.join(', ')}`)
  if (!bounds.length && !pairs.length) warnings.push('no_window_cited: the response cites no time window')

  return {
    ok: failures.length === 0, failures, warnings,
    sections: { found: found.map((f) => ({ key: f.key, heading: f.heading, line: f.line })), missing, duplicated, outOfOrder },
    action: { units, withheld, rule: 'units = list items if the section is a list, else paragraphs; more than one unit fails unless the section states that no action is recommended' },
    citations: {
      ids: { cited: ids, missing: missingIds },
      metrics: { cited: metrics, missing: missingMetrics },
      windows: { cited: [...bounds, ...pairs.map(([a, b]) => `${a}-${b} min`)], missing: missingWindows },
    },
  }
}
