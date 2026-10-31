import { safeText } from '@fmmi/model'
import type { MatchQueries } from '@fmmi/query'

// Slice 4 text renderers. Names and any text from the catalog are untrusted data and are escaped with safeText.

type TrendsOut = Awaited<ReturnType<MatchQueries['seasonTrends']>>
type PlayersOut = ReturnType<MatchQueries['listPlayers']>
type PlayerTrendsOut = Awaited<ReturnType<MatchQueries['playerTrends']>>
type NotesOut = ReturnType<MatchQueries['tacticalNotes']>
type ChangeOut = Awaited<ReturnType<MatchQueries['compareTacticalChange']>>

const t = (s: string | null | undefined) => safeText(s)
const num = (metric: string, v: number | null, reason?: string) => (v === null ? `n/a (${reason ?? 'unavailable'})` : v.toFixed(metric.includes('xg') || metric.includes('quality') ? 2 : 1))

interface RowLike {
  metric: string; value: number | null; nullReason?: string; numerator: number | null; denominator: number | null
  contributing: { matches: number; minutes: number; matchIds?: string[] }; excluded?: Array<{ matchId: string; reason: string }>
}
function rowLines(rows: RowLike[], total: number): string[] {
  const L: string[] = []
  for (const r of rows) {
    const n = r.numerator === null ? '' : `  (${r.numerator.toFixed(2)} / ${r.denominator!.toFixed(2)})`
    L.push(`  ${r.metric.padEnd(38)} ${num(r.metric, r.value, r.nullReason).padStart(10)}${n}  ${r.contributing.matches}/${total} matches, ${r.contributing.minutes.toFixed(1)} min`)
    for (const e of r.excluded ?? []) L.push(`      excluded ${e.matchId}: ${e.reason}`)
  }
  return L
}

type WingOut = NonNullable<TrendsOut['windows'][number]['wing']>
function wingLines(w: WingOut, windowMatches: number): string[] {
  const L = [`  Chance creation by wing (pooled counts, per 90 over measured minutes; ${w.contributing.matches}/${windowMatches} matches, ${w.contributing.minutes.toFixed(1)} min):`]
  const cells = [['shots', 'shots'], ['xg', 'xG'], ['crosses', 'crosses'], ['crossesCompleted', 'crosses done'], ['finalThirdEntries', 'F3 entries'], ['dangerAreaEntries', 'danger entries']] as const
  for (const dir of ['for', 'against'] as const) {
    L.push(`    ${dir === 'for' ? 'for (our attacks, our lanes)' : 'against (their attacks, their lanes; their left is our right flank)'}`)
    for (const lane of ['left', 'centre', 'right'] as const) {
      L.push(`      ${lane.padEnd(6)} ${cells.map(([k, label]) => { const [n, p90] = w[dir].byLane[lane][k]; return `${label} ${k === 'xg' ? n.toFixed(2) : n} (${p90 === null ? 'n/a' : p90.toFixed(2)}/90)` }).join('; ')}`)
    }
    const wl = w[dir].withoutLocation
    const none = Object.values(wl).reduce((a, b) => a + b, 0)
    if (none > 0 || w[dir].xgUnattributedShots > 0) L.push(`      without a location: ${Object.entries(wl).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; shots without attributed xG: ${w[dir].xgUnattributedShots}`)
  }
  for (const e of w.excluded ?? []) L.push(`      excluded ${e.matchId}: ${e.reason}`)
  return L
}

type SplitRows = { matches: number; rates: Array<{ metric: string; value: number | null; nullReason?: string }> }

export function renderTrends(r: TrendsOut, o: { review?: boolean } = {}): string {
  const L: string[] = []
  L.push(`${o.review ? 'Rolling review' : 'Season trends'}: ${t(r.team.name)} (${r.team.teamId}) in save ${r.saveId}   coverage ${r.coverage}   dictionary ${r.metricDictionaryVersion}`)
  L.push(`Aggregates (${r.source.aggregateKey}): ${r.source.aggregates} used, ${r.source.servedFromCatalog} from the catalog cache, ${r.source.builtThisCall} built this call`)
  L.push(`Eligible matches: ${r.eligibleMatches}. Policy ${r.policy.id} v${r.policy.version}: rates need confirmed completion and full-match capture, or an early-ending capture of at least ${r.policy.earlyEndingMinCapturedMinutes} minutes (${r.policy.earlyEndingLabel}); see ${r.policy.documented}`)
  const byId = new Map(r.matches.map((m) => [m.matchId, m]))
  for (const w of r.windows) {
    L.push('')
    L.push(`Last ${w.lastN} eligible match(es): ${w.matchIds.length} used${w.sameMatchesAsWindow ? ` (the same matches as the last ${w.sameMatchesAsWindow}; figures above)` : ''}`)
    for (const m of w.matchIds.map((id) => byId.get(id)!)) {
      const sc = m.score ? `${m.score.for}-${m.score.against} ${m.score.outcome} (${m.score.basis})` : 'no final score'
      const flags = [m.class === 'early_ending' ? `EARLY-ENDING ${m.capturedMinutes.toFixed(1)} min` : '', m.disclosures.includes('manual_confirmation') ? 'manual confirmation' : ''].filter(Boolean).join(', ')
      L.push(`  ${m.date ?? 'no date'}  ${m.side.padEnd(4)} v ${t(m.opponent.name).padEnd(22)} ${sc}  ${m.matchId}  ${m.recordingRevisionId}${flags ? `  [${flags}]` : ''}`)
    }
    const rec = w.record
    L.push(`  Record: ${rec.won}W ${rec.drawn}D ${rec.lost}L from ${rec.matches} final score(s), ${rec.manualScores} manual`)
    const tt = w.totals
    const f2 = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : 'n/a')
    L.push(`  Totals (full-match captures only, ${tt.matches} match(es), ${(tt.minutes as number).toFixed(1)} min): goals ${tt.goalsFor}-${tt.goalsAgainst}, xG ${f2(tt.xgFor)}-${f2(tt.xgAgainst)}, shots ${tt.shotsFor}-${tt.shotsAgainst}`)
    for (const e of w.totals.excludedFromTotals) L.push(`      left out of totals ${e.matchId}: ${e.reason}`)
    if (w.sameMatchesAsWindow) continue
    L.push('  Pooled rates (numerator / denominator):')
    L.push(...rowLines(w.rates as RowLike[], w.matchIds.length))
    if (w.wing) L.push(...wingLines(w.wing, w.matchIds.length))
    const sp = (w as { splits?: { home: SplitRows; away: SplitRows } }).splits
    if (sp) for (const s of ['home', 'away'] as const) L.push(`  ${s} (${sp[s].matches} match(es), pooled values): ${sp[s].rates.map((x) => `${x.metric} ${num(x.metric, x.value, x.nullReason)}`).join('; ')}`)
  }
  if (r.excluded.length) {
    L.push('')
    L.push('Excluded from the default comparison:')
    for (const e of r.excluded) L.push(`  ${e.matchId} (${e.date ?? 'no date'}): ${e.reasons.join(', ')}`)
  }
  for (const e of r.excludedRecordings) L.push(`  recording ${e.recordingRevisionId} of ${e.matchId}: ${e.reason}`)
  const part = (r as { partial?: { matches: Array<{ matchId: string; capturedMinutes: number; reasons: string[] }>; rates: RowLike[] } | null }).partial
  if (part) {
    L.push('')
    L.push(`PARTIAL RECORDINGS (separate; not part of the comparison above): ${part.matches.length}`)
    for (const m of part.matches) L.push(`  ${m.matchId} ${m.capturedMinutes.toFixed(1)} min captured: ${m.reasons.join(', ')}`)
    L.push(...rowLines(part.rates, part.matches.length))
  }
  for (const u of r.unavailable) L.push(`unavailable ${u.metric}: ${u.reason}`)
  for (const w of r.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderPlayers(r: PlayersOut): string {
  const L: string[] = []
  L.push(`Players in save ${r.saveId}: ${r.page.returned} of ${r.page.totalMatching} (persistent ${r.summary.persistent}, linked ${r.summary.linked}, match-local ${r.summary.matchLocal})`)
  for (const p of r.players as Array<Record<string, unknown>>) {
    const extra = p.identityStatus === 'match_local' ? `reason ${p.reason}, match ${p.matchId}` : `${p.supportingMatchesTotal} supporting match(es)`
    L.push(`  ${String(p.playerId).padEnd(18)} ${t(String(p.name)).padEnd(26)} ${String(p.identityStatus).padEnd(11)} ${p.matches} match(es)  uid ${p.uid ?? 'none'}  ${extra}`)
  }
  if (r.page.nextCursor) L.push(`More: --cursor ${r.page.nextCursor}`)
  for (const w of r.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}


type ScoreStateOut = { value: { minutes: Record<string, number> } | null; nullReason?: string }
type WindowContext = { contributing?: { matches: number }; opposition?: string[]; scoreState?: ScoreStateOut }
function scoreStateText(ss: ScoreStateOut): string {
  return ss.value ? `score state while on pitch (min leading/drawing/trailing) ${ss.value.minutes.leading!.toFixed(1)}/${ss.value.minutes.drawing!.toFixed(1)}/${ss.value.minutes.trailing!.toFixed(1)}` : `score state unavailable (${ss.nullReason})`
}
function windowContextLines(w: WindowContext): string[] {
  if (!w.scoreState) return []
  return [`    played in ${w.contributing?.matches ?? 0} match(es); ${scoreStateText(w.scoreState)}; opposition ${w.opposition?.length ? w.opposition.map((o) => t(o)).join(', ') : 'none'}`]
}

export function renderPlayerTrends(r: PlayerTrendsOut): string {
  const L: string[] = []
  L.push(`Player trends in save ${r.saveId}   coverage ${r.coverage}   dictionary ${r.metricDictionaryVersion}`)
  const byId = new Map(r.matches.map((m) => [m.matchId, m]))
  for (const p of r.players) {
    L.push('')
    L.push(`${t(p.name)} (${p.playerId}, ${p.kind}), ${p.memberMatches} match(es) in the save`)
    for (const w of p.windows) {
      L.push(`  Last ${w.lastN}: ${w.matchIds.length} match(es), ${w.minutes.toFixed(1)} min${w.sameMatchesAsWindow ? ` (the same matches as the last ${w.sameMatchesAsWindow})` : ''}`)
      if (w.sameMatchesAsWindow) continue
      w.matchIds.forEach((id, i) => {
        const m = byId.get(id)!
        const mins = w.matchMinutes[i]!
        L.push(`    ${m.date ?? 'no date'} ${mins.toFixed(1).padStart(5)} min ${mins === 0 ? '(did not play) ' : ''}${m.class === 'early_ending' ? '(early-ending) ' : ''}${m.matchId} ${m.recordingRevisionId}`)
      })
      L.push(...rowLines(w.rates as RowLike[], w.matchIds.length))
      L.push(...windowContextLines(w as unknown as WindowContext))
    }
    for (const e of p.excluded) L.push(`  excluded ${e.matchId}: ${e.reasons.join(', ')}`)
  }
  type Diff = { subject: number; comparator: number; delta: number; direction: string } | null
  const f = (x: Diff) => (x ? `${x.subject.toFixed(1)} vs ${x.comparator.toFixed(1)} per 90 (${x.direction})` : 'suppressed')
  for (const c of r.comparisons as Array<{ lastN: number; subject: string; comparator: string; status: string; reasons?: string[]; passesReceivedPer90: Diff; progressivePassesPer90: Diff; confounders: string[] }>) {
    L.push(`Comparison last ${c.lastN} ${c.subject} vs ${c.comparator}: ${c.status}; receptions ${f(c.passesReceivedPer90)}; progressive ${f(c.progressivePassesPer90)}${c.reasons?.length ? `; ${c.reasons.join(', ')}` : ''}`)
    L.push(`    context flags (not adjusted for; the finding is not suppressed): ${c.confounders.join(', ') || 'none'}`)
  }
  for (const x of r.excludedIdentities as Array<{ playerId: string; identityNote: string; persistentPlayerId: string | null }>) L.push(`excluded match-local identity ${x.playerId}: ${x.identityNote}${x.persistentPlayerId ? ` (member of ${x.persistentPlayerId})` : ''}`)
  L.push(`Ground service: unavailable (${r.groundService.nullReason}). ${t(r.groundService.note)}`)
  for (const w of r.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderPlayerLink(r: { playerId: string; status: string; created: boolean; localPlayerIds: string[]; matchIds: string[]; warnings: string[] }): string {
  const n = r.localPlayerIds.length
  return [`${r.created ? 'Created' : 'Extended'} ${r.status} player ${r.playerId} with ${n} match-local identit${n === 1 ? 'y' : 'ies'} (${r.localPlayerIds.join(', ')}). Recorded in the audit log; undo with: fmmi player unlink <p_id>.`, ...r.warnings.map((w) => `warning: ${w}`)].join('\n')
}

export function renderNotes(r: NotesOut): string {
  const L: string[] = []
  L.push(`Tactical notes in save ${r.saveId}: ${r.page.returned} of ${r.page.totalMatching}. All are user-entered (confidence manual); FMMatchLens did not record them.`)
  for (const n of r.notes as Array<Record<string, unknown>>) {
    const state = n.status === 'superseded' ? `[superseded by ${n.supersededBy}]` : '[current]'
    L.push(`  ${n.noteId} ${state} match ${n.matchId}  minute ${n.minute} (period ${n.period}, ${n.side})  ${t(String(n.setting))}: ${t(String(n.priorValue))} -> ${t(String(n.newValue))}${n.supersedes ? `  supersedes ${n.supersedes}` : ''}${n.comment ? `  "${t(String(n.comment))}"` : ''}`)
  }
  const o = (r as { observedFormationChanges?: { players: Array<{ name: string; side: string; changes: unknown[] }>; substitutionFlips: number; playersWithChanges: number } | null }).observedFormationChanges
  if (o) {
    L.push('')
    L.push(`Observed by the plugin (separate from the notes above): ${o.substitutionFlips} substitution flip(s), ${o.playersWithChanges} player(s) with role or position changes`)
    for (const p of o.players) {
      L.push(`  ${t(p.name)} (${p.side}): ${p.changes.length} assignment record(s)`)
      for (const c of p.changes as Array<{ gameLabel: string; capturedTick: number; position: string | null; inPossession: string | null; outOfPossession: string | null }>) {
        L.push(`    ${c.gameLabel} (captured tick ${c.capturedTick}): ${t(c.position ?? '-')} in possession ${t(c.inPossession ?? 'n/a')}; out of possession ${t(c.outOfPossession ?? 'n/a')}`)
      }
    }
  }
  if (r.page.nextCursor) L.push(`More: --cursor ${r.page.nextCursor}`)
  for (const w of r.warnings) L.push(`warning: ${t(w)}`)
  return L.join('\n')
}

export function renderTacticalChange(r: ChangeOut): string {
  const L: string[] = []
  const n = r.note as Record<string, unknown>
  L.push(`Tactical change comparison for ${t(r.team.name)}: note ${n.noteId} (manual, user-entered) minute ${n.minute}, ${t(String(n.setting))}: ${t(String(n.priorValue))} -> ${t(String(n.newValue))}`)
  if (r.singleMatchComparison) L.push('SINGLE-MATCH COMPARISON: no eligible matches on at least one side.')
  const w = r.within
  if (w.status === 'available' && w.windows) {
    L.push(`Within the match (boundary ${w.boundary}): before ${w.windows.before.minutes.toFixed(1)} min, after ${w.windows.after.minutes.toFixed(1)} min`)
    for (const x of w.rates) L.push(`  ${x.metric.padEnd(30)} before ${num(x.metric, x.before).padStart(8)}  after ${num(x.metric, x.after).padStart(8)}  delta ${x.delta === null ? 'n/a' : x.delta.toFixed(2)}`)
    L.push(`  players on the pitch at the change: ${w.playersOnPitch.map((p) => t(p.name)).join(', ')}`)
  } else L.push(`Within the match: unavailable (${w.reason})`)
  const a = r.across as Record<string, unknown>
  if (a.status === 'available') {
    const side = (s: { matches: Array<{ matchId: string; date: string | null }>; minutes: number }, label: string) => L.push(`${label}: ${s.matches.map((m) => `${m.matchId} (${m.date})`).join(', ')}; ${s.minutes.toFixed(1)} min`)
    side(a.before as never, 'Before matches')
    side(a.after as never, 'After matches')
    for (const d of a.deltas as Array<{ metric: string; before: number | null; after: number | null; delta: number | null }>) {
      L.push(`  ${d.metric.padEnd(30)} before ${num(d.metric, d.before).padStart(8)}  after ${num(d.metric, d.after).padStart(8)}  delta ${d.delta === null ? 'n/a' : d.delta.toFixed(2)}`)
    }
  } else L.push(`Across matches: unavailable (${a.reason})`)
  L.push(`Confounders: ${r.confounders.join(', ') || 'none'}`)
  for (const s of r.statements) L.push(t(s))
  for (const x of r.warnings) L.push(`warning: ${t(x)}`)
  return L.join('\n')
}

export function renderManaged(d: {
  saveId: string; matches: number; candidates: Array<{ teamId: string; name: string; matches: number; humanControlledMatches: number }>
  suggestion: { teamId: string; name: string; evidence: string } | null; reason: string | null; current: { teamId: string; source: string } | null
}): string {
  const L: string[] = [`Managed-team detection for save ${d.saveId} (${d.matches} match(es)); the save assignment of matches is never inferred.`]
  for (const c of d.candidates) L.push(`  ${t(c.name)} (${c.teamId}): human-managed in ${c.humanControlledMatches} of ${c.matches} appearance(s)`)
  L.push(d.suggestion ? `Suggestion: ${t(d.suggestion.name)} (${d.suggestion.teamId}), ${d.suggestion.evidence}. Apply with: fmmi save team detect --apply --save ${d.saveId}` : `No suggestion (${d.reason}).`)
  L.push(d.current ? `Current managed team: ${d.current.teamId} (${d.current.source})` : 'No managed team is set.')
  return L.join('\n')
}
