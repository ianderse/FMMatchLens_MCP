import { DomainError, parseScore, safeText, toErrorBody } from '@fmmi/model'
import type { CatalogService, IngestResult } from '@fmmi/store'
import type { Prompter } from './io.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-09-12` -> `12 Sep`. */
export function shortDate(matchDate: string | null): string {
  const m = matchDate ? /^(\d{4})-(\d{2})-(\d{2})/.exec(matchDate) : null
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}` : 'no date'
}

export interface Pending {
  matchId: string
  saveId: string
  home: string
  away: string
  date: string | null
  observed: { home: number; away: number }
  coverage: string
  /** `Folkestone 2-1 Farnham, 12 Sep, partial recording` */
  label: string
  /** The exact command that records the observed score as the final score. */
  command: string
}

type Row = ReturnType<CatalogService['listMatches']>['matches'][number]
const labelOf = (m: Row) => `${safeText(m.home.name)} ${m.result.observed.home}-${m.result.observed.away} ${safeText(m.away.name)}, ${shortDate(m.matchDate)}`

/**
 * Matches of the save that wait for the user to confirm the final score: completion unknown and no confirmation yet. A full-match capture
 * already counts without one (spec deviation, see docs/metrics.md), so by default only partial recordings are listed; `all` also lists the
 * full ones (to record or correct a score).
 */
export function pendingConfirmations(svc: CatalogService, saveId: string, opts: { all?: boolean } = {}): Pending[] {
  return svc.listMatches(saveId).matches
    .filter((m) => m.status.completion === 'unknown' && (opts.all || m.status.coverage !== 'full_match'))
    .sort((a, b) => ((a.matchDate ?? '') < (b.matchDate ?? '') ? -1 : 1))
    .map((m) => ({
      matchId: m.matchId, saveId, home: m.home.name, away: m.away.name, date: m.matchDate, observed: { home: m.result.observed.home, away: m.result.observed.away }, coverage: m.status.coverage,
      label: `${labelOf(m)}, ${m.status.coverage === 'full_match' ? 'full recording' : 'partial recording'}`,
      command: `fmmi match confirm ${m.matchId} --score ${m.result.observed.home}-${m.result.observed.away}`,
    }))
}

export interface ConfirmOutcome { confirmed: string[]; skipped: string[]; pending: Pending[] }

/**
 * Walks the unconfirmed matches. Enter confirms the observed score; a typed score confirms that score (a score that differs from the observed
 * one is asked again before it is stored, as the manual final score); `n` skips. Without a terminal nothing is asked: the matches are returned
 * as `pending` with their exact commands. Confirmation is always the user's action; nothing here confirms on its own.
 */
export async function confirmFlow(svc: CatalogService, saveId: string, prompt: Prompter, out: (s: string) => void, opts: { all?: boolean } = {}): Promise<ConfirmOutcome> {
  const todo = pendingConfirmations(svc, saveId, opts)
  const outcome: ConfirmOutcome = { confirmed: [], skipped: [], pending: [] }
  if (!prompt.interactive) { outcome.pending = todo; return outcome }
  let stop = false
  for (const m of todo) {
    if (stop) { outcome.pending.push(m); continue }
    let done = false
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const answer = await prompt.ask(`${m.label}. Final score ${m.observed.home}-${m.observed.away}? [Y/n/type score] `)
      if (answer === null) { stop = true; outcome.pending.push(m); done = true; break }
      const a = answer.trim().toLowerCase()
      if (a === '' || a === 'y' || a === 'yes') {
        done = confirmOne(svc, m, `${m.observed.home}-${m.observed.away}`, false, out, outcome)
      } else if (a === 'n' || a === 'no' || a === 's' || a === 'skip') {
        outcome.skipped.push(m.matchId); out(`  skipped (still unconfirmed; confirm later with: ${m.command})`); done = true
      } else if (a === 'q' || a === 'quit') {
        stop = true; outcome.pending.push(m); done = true
      } else {
        const score = parseScore(a)
        if (!score) { out('  Press Enter to confirm, n to skip, or type a score such as 2-1.'); continue }
        const differs = score.home !== m.observed.home || score.away !== m.observed.away
        if (differs) {
          const ok = await prompt.ask(`  The last observed score is ${m.observed.home}-${m.observed.away}. Store ${score.home}-${score.away} as the final score? [y/N] `)
          if (ok === null) { stop = true; outcome.pending.push(m); done = true; break }
          if (!/^y(es)?$/i.test(ok.trim())) { out('  not stored'); continue }
        }
        done = confirmOne(svc, m, `${score.home}-${score.away}`, differs, out, outcome)
      }
    }
    if (!done) { outcome.skipped.push(m.matchId); out(`  skipped (still unconfirmed; confirm later with: ${m.command})`) }
  }
  return outcome
}

function confirmOne(svc: CatalogService, m: Pending, score: string, allowScoreChange: boolean, out: (s: string) => void, outcome: ConfirmOutcome): boolean {
  try {
    svc.confirmMatch(m.matchId, score, { allowScoreChange })
    outcome.confirmed.push(m.matchId)
    out(`  confirmed ${score}${allowScoreChange ? ' (differs from the observed score; stored as the manual final score)' : ''}`)
    return true
  } catch (e) {
    out(`  could not confirm: ${toErrorBody(e).message}`)
    if (!(e instanceof DomainError)) throw e
    return false
  }
}

// ---------------------------------------------------------------------------------------------- import report

/** One line per newly imported or problematic recording; already-imported files are only counted. */
export function importLines(svc: CatalogService, saveId: string, results: IngestResult[], skippedAlreadyIngested: number, skippedInProgress: string[]): string[] {
  const byId = new Map(svc.listMatches(saveId).matches.map((m) => [m.matchId, m]))
  const lines: string[] = []
  for (const r of results) {
    const m = r.matchId ? byId.get(r.matchId) : undefined
    const what = m ? `${labelOf(m)}` : safeText(r.file)
    if (r.status === 'rejected') lines.push(`Could not import ${safeText(r.file)}: ${safeText(r.error?.message ?? 'rejected')}`)
    else if (r.status === 'identity_conflict') lines.push(`Needs your attention: ${safeText(r.file)} has the same match id as an existing recording but different content (excluded until: fmmi recording resolve ${r.recordingRevisionId} --as continuation|alternate|separate-occurrence|ignored)`)
    else lines.push(`Imported ${what}${m ? (m.status.coverage === 'full_match' ? ' (full recording)' : ` (${m.status.coverage} recording)`) : ''}${r.status === 'continuation' ? ' as a continuation of an earlier recording' : ''}`)
  }
  if (skippedAlreadyIngested > 0 && (results.length > 0 || skippedInProgress.length > 0)) lines.push(`${skippedAlreadyIngested} recording(s) were already imported.`)
  for (const f of skippedInProgress) lines.push(`Skipped ${safeText(f)}: the game is still recording this match (it is renamed when the match ends). Use --include-in-progress to import it as a partial.`)
  return lines
}
