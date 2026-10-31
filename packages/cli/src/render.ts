import { safeText } from '@fmmi/model'
import type { CatalogService, IngestResult } from '@fmmi/store'
import type { MatchQueries } from '@fmmi/query'

type Show = ReturnType<CatalogService['showMatch']>
type ListOut = ReturnType<MatchQueries['listMatches']>
type SummaryOut = Awaited<ReturnType<MatchQueries['summary']>>
type CompareOut = Awaited<ReturnType<MatchQueries['compare']>>
type StatusOut = Awaited<ReturnType<MatchQueries['recordingStatus']>>

const t = (s: string | null | undefined) => safeText(s)
const f2 = (n: number) => n.toFixed(2)
const min = (ticks: number) => (ticks / 240).toFixed(1)

export function renderSaves(saves: Array<{ saveId: string; displayName: string; createdAt: string }>): string {
  if (saves.length === 0) return 'No save profiles. Create one with: fmmi save create <name>'
  return saves.map((s) => `${s.saveId}  ${t(s.displayName)}  (created ${s.createdAt})`).join('\n')
}

export function renderIngest(results: IngestResult[], extra: { skippedAlreadyIngested?: number } = {}): string {
  const lines = results.map((r) => {
    const head = `${r.status.padEnd(18)} ${t(r.file)}`
    if (r.status === 'rejected') return `${head}\n    error ${r.error?.code}: ${t(r.error?.message)}`
    const ids = `match ${r.matchId}  revision ${r.recordingRevisionId}`
    const st = r.integrity ? `  integrity=${r.integrity} coverage=${r.coverage} completion=${r.completion}` : ''
    return [`${head}\n    ${ids}${st}`, ...r.warnings.map((w) => `    warning: ${t(w)}`)].join('\n')
  })
  if (extra.skippedAlreadyIngested) lines.push(`(${extra.skippedAlreadyIngested} file(s) already ingested, skipped)`)
  if (lines.length === 0) lines.push('Nothing to ingest.')
  return lines.join('\n')
}

export function renderList(l: ListOut): string {
  if (l.matches.length === 0) return l.saveId ? `No matches in save ${l.saveId}.` : 'No matches match this query.'
  const rows = l.matches.map((m) => {
    const score = m.result.final ? `${m.result.final.home}-${m.result.final.away} (manual final)` : `${m.result.observed.home}-${m.result.observed.away} (observed, ${m.result.observed.at.displayMinute} min)`
    return [
      `${m.matchId}  ${m.matchDate ?? 'no date'}  ${t(m.home.name)} v ${t(m.away.name)}  ${score}`,
      `    integrity=${m.status.integrity} coverage=${m.status.coverage} completion=${m.status.completion}` + (m.conflictingRevisions ? `  conflicts=${m.conflictingRevisions}` : ''),
    ].join('\n')
  })
  const head = l.saveId ? `Save ${l.saveId} (${t(l.saveName)})` : 'All saves'
  const more = l.page.nextCursor ? `\nMore: --cursor ${l.page.nextCursor}` : ''
  return `${head}: ${l.page.returned} of ${l.page.totalMatching} match(es)\n${rows.join('\n')}${more}`
}

export function renderShow(s: Show): string {
  const L: string[] = []
  const m = (n: number | undefined) => (n === undefined ? '-' : String(n))
  L.push(`Match ${s.matchId}   save ${s.saveId} (${t(s.saveName)})`)
  L.push(`${t(s.home.name)} v ${t(s.away.name)}   ${s.matchDate ?? 'no date'}   ${t(s.competition) || 'no competition'}   season ${s.season ?? 'unknown'}`)
  const side = s.managedSide ? `${s.managedSide} (${t(s.managedSide === 'home' ? s.home.name : s.away.name)})` : 'not identified'
  L.push(`Human-managed side: ${side}`)
  const o = s.result.observed
  if (s.result.final) {
    L.push(`Final score (manual): ${s.result.final.home}-${s.result.final.away}   observed ${o.home}-${o.away} at ${o.at.displayMinute} min`)
  } else {
    L.push(`Score: ${o.home}-${o.away}  OBSERVED, NOT FINAL (last frame: period ${o.at.period}, tick ${o.at.tick}, game minute ${o.at.displayMinute})`)
  }
  const th = s.teamTotals.home, ta = s.teamTotals.away
  L.push(`xG ${f2(th.xg!)} - ${f2(ta.xg!)}   shots ${m(th.shots)}-${m(ta.shots)} (on target ${m(th.shotsOnTarget)}-${m(ta.shotsOnTarget)})   passes ${m(th.passesCompleted)}/${m(th.passes)} - ${m(ta.passesCompleted)}/${m(ta.passes)}   aerials won ${m(th.aerialsWon)}/${m(th.aerials)} - ${m(ta.aerialsWon)}/${m(ta.aerials)}`)
  const pp = s.derived.possessionPct
  L.push(pp.home === null ? 'Possession: unavailable (zero denominator)' : `Possession time split: ${pp.home.toFixed(1)}% - ${pp.away!.toFixed(1)}% (ratio of possessionTime counters; unit unverified)`)
  L.push('')
  const r = s.recording
  L.push(`Recording ${r.recordingRevisionId}${r.selected ? ' (selected)' : ''}  identity=${r.identityStatus}  format ${r.format}  ${r.frames} frames`)
  L.push(`  sha256 ${r.archiveSha256}   ${r.sizeBytes} bytes   source ${t(r.sourceMatchId)}   files: ${r.sourceLocators.map(t).join(', ')}`)
  const st = s.status
  L.push(`Status (independent):`)
  L.push(`  file integrity : ${st.integrity.status}   clean close marker: ${st.integrity.cleanClose ? 'present' : 'absent'}   last validated: period ${st.integrity.lastValidatedBoundary?.period} tick ${st.integrity.lastValidatedBoundary?.tick}${st.integrity.error ? `   error: ${t(st.integrity.error)}` : ''}`)
  const c = st.coverage
  L.push(`  capture coverage: ${c.status}   baseline ${c.initialBaseline}   gaps over ${c.gaps.toleranceTicks} ticks: ${c.gaps.countOverTolerance} (sampling gaps ${c.gaps.samplingGapCount}, largest ${c.gaps.largestGapTicks})${c.reasons.length ? `   reasons: ${c.reasons.join(', ')}` : ''}`)
  if (c.endCaptureEndsAt) L.push(`                    end_capture_ends_at: period ${c.endCaptureEndsAt.period}, tick ${c.endCaptureEndsAt.tick}, game minute ${c.endCaptureEndsAt.displayMinute}`)
  L.push(`  match completion: ${st.completion.status}   (${t(st.completion.evidence)})`)
  L.push('')
  const played = s.roster.filter((p) => p.participation.status === 'played').length
  L.push(`Participants: ${s.roster.length} recorded, ${played} played, ${s.roster.length - played} unused substitute(s)`)
  for (const sd of ['home', 'away'] as const) {
    L.push(`  ${sd.toUpperCase()} ${t(sd === 'home' ? s.home.name : s.away.name)}`)
    for (const p of s.roster.filter((x) => x.side === sd)) {
      const pa = p.participation
      const when = pa.status === 'unused_substitute' ? 'did not play'
        : `${pa.enteredAs === 'starter' ? 'starter' : `on p${pa.firstOn?.period} t${pa.firstOn?.tick}`}${pa.lastOff ? `, off p${pa.lastOff.period} t${pa.lastOff.tick}` : pa.onPitchAtEndOfRecording ? ', on at end of recording' : ''}, ${min(pa.elapsedTicks)} min`
      const c = p.counters
      L.push(`    ${t(p.name).padEnd(24)} ${String(p.position ?? '').padEnd(4)} ${when}${pa.sameTickBatch ? ' [same-tick batch]' : ''}`)
      if (pa.status === 'played') L.push(`        passes ${c.passesCompleted ?? '-'}/${c.passes ?? '-'}  aerials ${c.aerialsWon ?? '-'}/${c.aerials ?? '-'}  shots ${c.shots ?? '-'}  xG ${c.xg === undefined ? '-' : f2(c.xg)}  goals ${c.goals ?? '-'}  id ${p.playerId}`)
    }
  }
  if (s.substitutions.length) {
    L.push('')
    L.push('Substitution flips (off/on pairing is not recorded and is never inferred):')
    for (const b of s.substitutions) L.push(`  ${b.side} p${b.period} tick ${b.tick}: off ${b.off.length}, on ${b.on.length}`)
  }
  L.push('')
  L.push(`Events: ${s.events.distinct} distinct (merged by sequenceIndex), ${s.events.withRevisions} revised`)
  L.push('Unavailable (null, never zero):')
  for (const u of s.unavailable) L.push(`  ${u.metric}: ${u.reason} - ${u.note}`)
  if (s.revisions.length > 1) {
    L.push('')
    L.push('Revisions:')
    for (const v of s.revisions) L.push(`  ${v.recordingRevisionId}  ${v.identityStatus}${v.selected ? '  (selected)' : ''}  ${v.archiveSha256.slice(0, 12)}`)
  }
  for (const w of s.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

const cellText = (c: { value: number | null; nullReason?: string }) => (c.value === null ? `n/a (${c.nullReason ?? 'unavailable'})` : String(Math.round(c.value * 100) / 100))

export function renderSummary(s: SummaryOut): string {
  const L: string[] = []
  const r = s.summary.roster
  L.push(`Match ${s.matchId}  revision ${s.recordingRevisionId}  ${t(s.teams.home.name)} v ${t(s.teams.away.name)}  coverage ${s.coverage}  capture ${s.capture.coverage}  completion ${s.capture.completion}`)
  L.push(`Score: ${s.result.observed.home}-${s.result.observed.away} (${s.result.label})`)
  L.push('Team comparison (home | away):')
  for (const c of s.summary.comparison) L.push(`  ${c.metric.padEnd(26)} ${cellText(c.home).padStart(10)} | ${cellText(c.away)}`)
  L.push(`Roster: ${r.returned} of ${r.total} recorded (${r.played} played, ${r.unusedSubstitutes} unused substitute(s))`)
  for (const p of r.players) L.push(`  ${p.playerId}  ${p.side.padEnd(4)} ${t(p.name).padEnd(24)} ${String(p.position ?? '').padEnd(6)} ${p.status === 'played' ? `${p.minutes} min, on ${p.onAt}${p.offAt ? `, off ${p.offAt}` : ''}` : 'did not play'}`)
  for (const f of s.summary.findings) L.push(`finding: ${t(f.summary)}`)
  for (const w of s.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderCompare(c: CompareOut): string {
  const L: string[] = []
  L.push(`Match ${c.matchId}  revision ${c.recordingRevisionId}  team ${t(c.comparison.team.name)} (${c.comparison.team.teamId})`)
  for (const k of ['a', 'b'] as const) {
    const w = c.windows[k]
    L.push(`Window ${k.toUpperCase()}: ${w.from.period}:${w.from.tick} to ${w.to.period}:${w.to.tick} (minutes ${w.display.fromMinute}-${w.display.toMinute}), ${w.teamMinutes.toFixed(1)} team minutes, ${w.coverage}`)
  }
  L.push('Team (B minus A; counts as per 90):')
  for (const r of c.comparison.teamRates) {
    const v = (x: { value: number | null; perNinety?: number | null; nullReason?: string }) => cellText(r.comparedAs === 'per_90' ? { value: x.perNinety ?? null, nullReason: x.nullReason } : x)
    L.push(`  ${r.metric.padEnd(26)} A ${v(r.a).padStart(10)}  B ${v(r.b).padStart(10)}  delta ${r.delta === null ? 'n/a' : (Math.round(r.delta * 100) / 100).toString()}`)
  }
  for (const p of c.comparison.players) L.push(`Player ${t(p.player.name)} (${p.player.playerId}): ${p.status}${p.reasons.length ? ` - ${p.reasons.join(', ')}` : ''}`)
  L.push(`Context flags: ${c.comparison.context.confounders.join(', ') || 'none'}`)
  for (const w of c.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderStatus(s: StatusOut): string {
  const L: string[] = []
  if (s.scope === 'catalog') {
    L.push(`Catalog: ${s.totals.saves} save(s), ${s.totals.matches} match(es), ${s.totals.conflictingRevisions} conflicting revision(s); snapshots ${s.storage.snapshotBytes} of ${s.storage.limitBytes} bytes`)
    for (const x of s.saves) L.push(`  ${x.saveId}  ${t(x.displayName)}  ${x.matches} match(es)  completion ${JSON.stringify(x.completion)}  capture ${JSON.stringify(x.captureCoverage)}`)
    for (const a of s.attention) L.push(`  attention ${a.matchId}: ${a.reasons.join(', ')}`)
    if (s.attentionTruncated) L.push(`  ... ${s.attentionTotal - s.attention.length} more`)
  } else {
    L.push(`Match ${s.matchId}  revision ${s.recordingRevisionId}${s.selected ? ' (selected)' : ''}  identity ${s.identity.status}`)
    L.push(`  integrity ${s.status.integrity.status}  capture ${s.status.coverage.status}  completion ${s.status.completion.status}`)
    for (const i of s.observedIntervals) L.push(`  period ${i.period}: ticks ${i.fromTick}-${i.toTick} (${i.frames} frames)`)
    for (const side of ['home', 'away'] as const) L.push(`  recipient diagnostic ${side}: ${s.recipientDiagnostic[side].status}${s.recipientDiagnostic[side].reasons.length ? ` (${s.recipientDiagnostic[side].reasons.join(', ')})` : ''}`)
    for (const m of s.missingMetrics) L.push(`  missing ${m.metric}: ${m.reason}`)
    for (const c of s.identity.conflictingRevisions) L.push(`  identity conflict: ${c.recordingRevisionId}`)
  }
  for (const w of s.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderDoctor(d: Awaited<ReturnType<CatalogService['doctor']>>): string {
  return [`fmmi doctor: ${d.ok ? 'OK' : 'PROBLEMS FOUND'}`, ...d.checks.map((c) => `  [${c.status}] ${c.name}: ${t(c.detail)}`)].join('\n')
}
