import { safeText } from '@fmmi/model'
import { getDefinition } from './registry.ts'
import { describeFinding } from './findings.ts'
import type { Finding } from './findings.ts'
import type { MetricRow } from './context.ts'
import type { NetworkResult, PlayerResult, ReportResult, ServiceResult } from './queries.ts'
import type { ThreatResult } from './threat.ts'

/** Plain text: names are untrusted data, so control and bidi characters are escaped and the length is bounded. */
export const plainEscape = (s: string | null | undefined): string => safeText(s)

/**
 * Markdown: control/bidi characters are escaped first, then every character that CommonMark or GFM can interpret
 * (emphasis, links, images, autolinks, tables, headings, HTML, entities) is backslash-escaped.
 */
export function mdEscape(s: string | null | undefined): string {
  return safeText(s).replace(/[\\`*_{}[\]()<>#+\-.!|~&:=@$%^"]/g, (c) => '\\' + c)
}

export type Esc = (s: string | null | undefined) => string

// ------------------------------------------------------------------ number formatting (presentation only, from the registry)

function decimalsOf(metric: string): number {
  const r = getDefinition(metric).rounding
  return r.startsWith('integer') ? 0 : r.startsWith('2 ') ? 2 : 1
}
export function fmtValue(metric: string, v: number | null): string {
  if (v === null) return 'n/a'
  return v.toFixed(decimalsOf(metric))
}
export function fmtRow(r: MetricRow): string {
  if (r.value === null) return `n/a (${r.nullReason})`
  const base = r.counts && ['aerial_win_pct', 'pass_completion_pct'].includes(r.metric)
    ? `${fmtValue(r.metric, r.value)}% (${r.counts.numerator}/${r.counts.denominator})`
    : r.metric.endsWith('_pct') || r.metric === 'possession_pct' || r.metric.endsWith('_pct_of_team_completed') ? `${fmtValue(r.metric, r.value)}%` : fmtValue(r.metric, r.value)
  return r.coverage ? `${base} [${r.coverage}]` : base
}
const byMetric = (rows: readonly MetricRow[], m: string) => rows.find((r) => r.metric === m)
const cell = (rows: readonly MetricRow[], m: string) => { const r = byMetric(rows, m); return r ? fmtRow(r) : '-' }

const LABELS: Record<string, string> = {
  goals: 'Goals', xg: 'xG (recorded)', shots: 'Shots', shots_on_target: 'Shots on target', shot_quality: 'xG per shot', passes: 'Passes (counter scope)',
  passes_completed: 'Passes completed (counter scope)', pass_completion_pct: 'Pass completion', progressive_passes: 'Progressive passes (upstream counter)',
  final_third_passes: 'Final-third passes (upstream counter)', final_third_entry_passes: 'Final-third entries (derived, distinct)', crosses: 'Crosses',
  crosses_completed: 'Crosses completed', aerials: 'Aerial duels', aerials_won: 'Aerial duels won', aerial_win_pct: 'Aerial win', possession_pct: 'Possession share (derived, unit unverified)',
  corners: 'Corners', fouls: 'Fouls', yellow_cards: 'Yellow cards', red_cards: 'Red cards',
}

function resultLine(r: ReportResult['result'], home: string, away: string, endMinute: number): string {
  const o = r.observed
  if (r.final) return `${home} ${r.final.home}-${r.final.away} ${away} (final score is MANUAL, confirmed by the user; observed at the end of capture: ${o.home}-${o.away}, game minute ${endMinute})`
  return `${home} ${o.home}-${o.away} ${away} (OBSERVED at the end of capture, game minute ${endMinute}; not a verified final score)`
}

const H = (md: boolean, level: number, text: string) => (md ? `${'#'.repeat(level)} ${text}` : `${text.toUpperCase()}`)
const table = (head: string[], rows: string[][], md: boolean): string => {
  if (md) return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
  return [head.join('  '), ...rows.map((r) => r.join('  '))].join('\n')
}

function windowLine(w: ReportResult['window']): string {
  return `[from,to) period ${w.from.period} tick ${w.from.tick} to period ${w.to.period} tick ${w.to.tick} (game minutes ${w.display.fromMinute} to ${w.display.toMinute}); boundaries ${w.resolution.from.exact && w.resolution.to.exact ? 'exact' : 'sampled, counter-based rows are partial_for_window'}`
}

function findingLine(f: Finding, esc: Esc): string {
  return `${describeFinding(f, esc)} [${f.ruleId}; ${f.label}]`
}

/**
 * Facts, deterministic findings and evidence quality only. No hypotheses and no recommendations (spec 9.1).
 */
export function renderReport(r: ReportResult, o: { markdown: boolean }): string {
  const md = o.markdown
  const esc: Esc = md ? mdEscape : plainEscape
  const code = (s: string) => (md ? `\`${s}\`` : s)
  const b = (s: string) => (md ? `**${s}**` : s)
  const home = esc(r.teams.home.name), away = esc(r.teams.away.name)
  const rep = r.report
  const L: string[] = []
  L.push(H(md, 1, `Match report: ${home} v ${away}`))
  L.push(`Match ${code(r.matchId)}; recording revision ${code(r.recordingRevisionId)}; metric dictionary ${r.metricDictionaryVersion}; schema ${r.schemaVersion}.`)
  const managed = r.teams.home.managed ? home : r.teams.away.managed ? away : null
  L.push(`Human-managed side: ${managed ?? 'not identified'}.`)
  L.push('')
  L.push(H(md, 2, 'Facts'))
  L.push(`${b('Score')}: ${resultLine(r.result, home, away, r.capture.endDisplayMinute)}.`)
  L.push(`${b('Window')}: ${windowLine(r.window)}.`)
  if (r.capture.partial) L.push(`${b('Partial recording')}: ${r.capture.statement} Capture ends at game minute ${r.capture.endDisplayMinute}.`)
  L.push('')
  L.push(H(md, 3, 'Teams'))
  const metricIds = Object.keys(LABELS)
  L.push(table(['Metric', home, away], metricIds.map((m) => [LABELS[m]!, cell(rep.teams.home.metrics, m), cell(rep.teams.away.metrics, m)]), md))
  L.push('')
  for (const side of ['home', 'away'] as const) {
    L.push(H(md, 3, `Players: ${side === 'home' ? home : away}`))
    const ps = rep.players.filter((p) => p.side === side)
    L.push(table(['Player', 'Min', 'Passes', 'Aerials won', 'Shots', 'xG', 'Goals'],
      ps.map((p) => [esc(p.name), p.minutesInWindow.toFixed(1), `${cell(p.metrics, 'passes_completed')}/${cell(p.metrics, 'passes')}`, `${cell(p.metrics, 'aerials_won')}/${cell(p.metrics, 'aerials')}`, cell(p.metrics, 'shots'), cell(p.metrics, 'xg'), cell(p.metrics, 'goals')]), md))
    L.push('')
  }
  if (rep.substitutions.length) {
    L.push(H(md, 3, 'Substitution flips (pairing of off and on is not recorded)'))
    for (const s of rep.substitutions) L.push(`- ${s.side} period ${s.period} tick ${s.tick}: ${s.off.length} off, ${s.on.length} on`)
    L.push('')
  }
  L.push(H(md, 2, 'Deterministic findings'))
  if (rep.findings.length === 0) L.push('No registered finding rule met its gate in this window.')
  for (const f of rep.findings) L.push(`- ${findingLine(f as unknown as Finding, esc)}`)
  const groups = new Map<string, string[]>()
  for (const s of rep.suppressedFindings) {
    const key = `${s.ruleId}: ${s.reasons.join(', ')}`
    groups.set(key, [...(groups.get(key) ?? []), esc((s as { subject?: { name: string } }).subject?.name ?? 'team')])
  }
  for (const [k, names] of groups) L.push(`- Suppressed ${k} (${names.length}): ${names.join(', ')}`)
  L.push('')
  L.push(H(md, 2, 'Evidence quality'))
  const c = r.capture
  L.push(`- File integrity: ${c.integrity}; clean close marker ${c.cleanClose ? 'present' : 'absent'}.`)
  L.push(`- Capture coverage: ${c.coverage}; match completion: ${c.completion}.`)
  for (const side of ['home', 'away'] as const) {
    const g = rep.evidenceQuality.recipientGate[side]
    const cov = g.coverageRatio === null ? 'n/a' : `${(g.coverageRatio * 100).toFixed(1)}%`
    const rc = g.reconciliation
    L.push(`- Recipient gate (${side}, ${g.scope}): ${g.status.toUpperCase()}; receivers verified for ${g.withVerifiedReceiver} of ${g.eligibleCompletedPasses} completed passes (${cov}, minimum ${(g.coverageMin * 100).toFixed(0)}%); reconciliation ${rc.status} (events ${rc.events.completed}/${rc.events.attempts}, counters ${rc.counters.completed ?? 'n/a'}/${rc.counters.attempts ?? 'n/a'}); receiver semantics basis: ${g.semanticsBasis}${g.reasons.length ? `; reasons: ${g.reasons.join(', ')}` : ''}.`)
  }
  L.push('- Receiver semantics are corroborated internally only (not against the FM27 UI) and rest on a single audited recording.')
  for (const u of rep.evidenceQuality.unavailable) L.push(`- Unavailable ${u.id}: ${u.reason}. ${u.note}`)
  for (const w of r.warnings) L.push(`- Warning: ${w}`)
  return L.join('\n')
}

// ------------------------------------------------------------------ CLI text for the other queries

const rowsText = (rows: readonly MetricRow[]) => rows.map((r) => `  ${r.metric.padEnd(40)} ${fmtRow(r)}${r.warnings?.length ? `   (${r.warnings.join('; ')})` : ''}`)

export function renderPlayer(r: PlayerResult, o: { markdown?: boolean } = {}): string {
  const esc: Esc = o.markdown ? mdEscape : plainEscape
  const p = r.player, L: string[] = []
  L.push(`Player ${esc(p.name)} (${p.playerId}) ${p.position ?? ''} side ${p.side}, team ${p.teamId}`)
  L.push(`Match ${r.matchId}  revision ${r.recordingRevisionId}  window ${windowLine(r.window)}`)
  const pa = p.participation
  L.push(`Participation: ${pa.status}${pa.enteredAs ? `, ${pa.enteredAs}` : ''}, ${pa.minutesInWindow.toFixed(2)} min in window (${pa.minutesInRecording.toFixed(2)} in recording); segments ${pa.segments.map((s) => `p${s.period} ${s.fromTick}-${s.toTick}`).join(', ') || 'none'}${pa.sameTickBatch ? '; same-tick substitution batch' : ''}`)
  L.push(`Native rating at last frame: ${p.nativeRating.value === null ? 'n/a' : p.nativeRating.value.toFixed(2)} (observed)`)
  L.push(...ratingLines(p.rating))
  L.push('Metrics:', ...rowsText(p.metrics))
  const g = p.passing.recipientGate
  L.push(`Passes received (${p.passing.scope.scope}; recipient gate ${g.status.toUpperCase()}${g.reasons.length ? `: ${g.reasons.join(', ')}` : ''}):`, ...rowsText(p.passing.received))
  L.push(`Ground service: n/a (not_recorded). Reception locations are derived from trajectory ends, not independent.`)
  for (const f of p.findings) L.push(`Finding: ${findingLine(f as unknown as Finding, esc)}`)
  for (const s of p.suppressedFindings) L.push(`Suppressed ${s.ruleId}: ${s.reasons.join(', ')}`)
  for (const w of r.warnings) L.push(`warning: ${w}`)
  return L.join('\n')
}

export function renderNetwork(r: NetworkResult, o: { markdown?: boolean } = {}): string {
  const esc: Esc = o.markdown ? mdEscape : plainEscape
  const n = r.network, L: string[] = []
  const names = new Map(n.nodes.map((x) => [x.playerId, esc((x as unknown as { name: string }).name)]))
  const g = n.recipientGate
  L.push(`Passing network: ${esc(n.team.name)} (${n.team.teamId}), scope ${n.scope.scope}, window ${windowLine(r.window)}`)
  L.push(`Recipient gate: ${g.status.toUpperCase()} (receivers ${g.withVerifiedReceiver}/${g.eligibleCompletedPasses}, reconciliation ${g.reconciliation.status})${g.reasons.length ? `; ${g.reasons.join(', ')}` : ''}`)
  const t = n.totals as unknown as { attempts: number; completed: number; edgeCompletions: number; edgesTotal: number; edgesReturned: number; truncated: boolean }
  L.push(`Attempts ${t.attempts}, completed ${t.completed}, completed with a verified receiver (edge completions) ${t.edgeCompletions}; ${t.edgesTotal} links, showing ${t.edgesReturned}${t.truncated ? ' (truncated; use --limit)' : ''}`)
  for (const e of n.edges) L.push(`  ${(names.get(e.from) ?? e.from).padEnd(24)} -> ${(names.get(e.to) ?? e.to).padEnd(24)} ${e.completions}`)
  L.push(`Nodes: ${n.nodes.length} (${n.nodesWithoutLocation} without any location sample; their links are kept)`)
  for (const w of r.warnings) L.push(`warning: ${w}`)
  return L.join('\n')
}

export function renderService(r: ServiceResult, o: { markdown?: boolean } = {}): string {
  const esc: Esc = o.markdown ? mdEscape : plainEscape
  const s = r.service, L: string[] = []
  const g = s.recipientGate
  L.push(`Striker service: ${esc(s.subject.player.name)} (${s.subject.player.playerId}); scope ${s.scope.scope}`)
  L.push(`Match ${r.matchId}  revision ${r.recordingRevisionId}  window ${windowLine(r.window)}`)
  L.push(`Recipient gate (${g.side}): ${g.status.toUpperCase()}; receivers ${g.withVerifiedReceiver}/${g.eligibleCompletedPasses}; reconciliation ${g.reconciliation.status}${g.reasons.length ? `; ${g.reasons.join(', ')}` : ''}`)
  L.push(`Diagnosis: ${s.diagnosis.status}. ${s.diagnosis.note}`)
  const sec = (title: string, b: typeof s.subject) => {
    const ex = b.exposure as unknown as { playerMinutes: number; teamCompletedPasses: number }
    L.push(`${title} ${esc(b.player.name)}: ${ex.playerMinutes.toFixed(2)} min on pitch, ${ex.teamCompletedPasses} team completed passes in those minutes`)
    L.push(...rowsText(b.reception), ...rowsText([b.aerial.row]), ...rowsText(b.shooting), ...rowsText(b.passing))
  }
  sec('Subject', s.subject)
  if (s.comparator) sec('Comparator', s.comparator as unknown as typeof s.subject)
  if (s.comparison) {
    L.push(`Comparison: ${s.comparison.status}${s.comparison.reasons.length ? ` (${s.comparison.reasons.join(', ')})` : ''}`)
    const cx = s.comparison.context as null | { confounders: string[]; substitutionFlips: Array<{ side: string; period: number; tick: number }>; subject: { scoreState: { value: null | { minutes: Record<string, number> }; nullReason?: string } }; comparator: { scoreState: { value: null | { minutes: Record<string, number> }; nullReason?: string } } }
    if (cx) {
      const f = (x: typeof cx.subject) => (x.scoreState.value ? `leading ${x.scoreState.value.minutes.leading!.toFixed(1)}, drawing ${x.scoreState.value.minutes.drawing!.toFixed(1)}, trailing ${x.scoreState.value.minutes.trailing!.toFixed(1)} min` : `n/a (${x.scoreState.nullReason})`)
      L.push(`  Context (not adjusted for): score state of ${esc(s.subject.player.name)}: ${f(cx.subject)}; of ${esc((s.comparator as unknown as typeof s.subject).player.name)}: ${f(cx.comparator)}`)
      L.push(`  Substitution flips in window: ${cx.substitutionFlips.length}; flags: ${cx.confounders.join(', ') || 'none'}`)
    }
    const d = (s.comparison as unknown as { differences: null | { receptionsPer90: number | null; progressivePer90: number | null; direction: string | null } }).differences
    if (d) L.push(`  Difference in receptions per 90 (subject minus comparator): ${d.receptionsPer90?.toFixed(1) ?? 'n/a'}; progressive passes per 90: ${d.progressivePer90?.toFixed(1) ?? 'n/a'}`)
  }
  for (const f of s.findings) L.push(`Finding: ${findingLine(f as unknown as Finding, esc)}`)
  for (const x of s.suppressedFindings) L.push(`Suppressed ${x.ruleId}: ${x.reasons.join(', ')}`)
  L.push('Unavailable: ' + s.components.filter((c) => c.availability === 'unavailable').map((c) => `${c.id} (${c.reason})`).join(', '))
  for (const w of r.warnings) L.push(`warning: ${w}`)
  return L.join('\n')
}

// ------------------------------------------------------------------ rating block and opposition threat (Slice 3b)

type RatingView = PlayerResult['player']['rating']
const signed = (n: number) => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)))

export function ratingLines(r: RatingView): string[] {
  const L: string[] = []
  L.push(`Rating: native ${r.native.value === null ? 'n/a' : r.native.value.toFixed(2)} (observed). ${r.statement}`)
  const e = r.estimate as null | { contributions: Array<{ category: string; postFactor: number }>; baseline: number; predictedInternalScore: number; recordedInternalScore: number; reconstructionResidual: { internalUnits: number; ratingPoints: number } }
  if (!e) {
    L.push(`  Estimated breakdown: n/a (${r.nullReason}: ${r.reason}). No category figures are shown.`)
  } else {
    L.push(`  ESTIMATED contributions (${r.model.version}, internal units where 1000 = 1.0 rating point; baseline ${e.baseline}): ${e.contributions.map((c) => `${c.category} ${signed(c.postFactor)}`).join(', ')}`)
    L.push(`  Reconstruction: predicted ${e.predictedInternalScore}, recorded ${e.recordedInternalScore}, residual ${signed(e.reconstructionResidual.internalUnits)} (${e.reconstructionResidual.ratingPoints.toFixed(3)} rating points; model error, not a football contribution)`)
  }
  L.push(`  Model ${r.model.id} ${r.model.version}; quality flags: ${r.qualityFlags.join(', ') || 'none'}`)
  for (const l of r.limitations) L.push(`  Limitation: ${l}`)
  return L
}

export function renderThreat(r: ThreatResult, o: { markdown?: boolean } = {}): string {
  const esc: Esc = o.markdown ? mdEscape : plainEscape
  const t = r.threat, L: string[] = []
  L.push(`Opposition threat: ${esc(t.opposition.name)} attacking ${esc(t.team.name)} (${t.team.teamId})`)
  L.push(`Match ${r.matchId}  revision ${r.recordingRevisionId}  window ${windowLine(r.window)}`)
  if (r.capture.partial) L.push(`Partial recording: ${r.capture.statement}`)
  L.push(`Lanes are thirds of pitch width from the ATTACKING team perspective (${t.lanes.mirrorRule})`)
  L.push(table(['Lane (attackers)', 'Selected team flank', 'Shots', 'xG (derived)', 'Crosses (completed)', 'Completed passes', 'Final-third entries', 'Danger-area entries'],
    t.byLane.map((l) => [l.lane, l.defendingTeamFlank, String(l.shots), `${l.xg.value.toFixed(2)} (${l.xg.attributedShots} shots${l.xg.unattributedShots ? `, ${l.xg.unattributedShots} unattributed` : ''})`,
      `${l.crosses} (${l.crossesCompleted})`, String(l.passesCompleted), String(l.finalThirdEntries), String(l.dangerAreaEntries)]), !!o.markdown))
  const rc = t.reconciliation as unknown as { shots: { byLane: number; withoutLocation: number; counter: { value: number | null } }; crosses: { byLane: number; withoutLocation: number; counter: { value: number | null } }; xg: { attributedToLanes: number; notAttributedToLanes: number | null; teamCounter: { value: number | null } } }
  L.push(`Reconciliation: shots by lane ${rc.shots.byLane} + ${rc.shots.withoutLocation} without location vs team counter ${rc.shots.counter.value ?? 'n/a'}; crosses ${rc.crosses.byLane} + ${rc.crosses.withoutLocation} vs ${rc.crosses.counter.value ?? 'n/a'}; xG attributed to lanes ${rc.xg.attributedToLanes.toFixed(2)} of team ${rc.xg.teamCounter.value === null ? 'n/a' : rc.xg.teamCounter.value.toFixed(2)}`)
  for (const s of t.statements) L.push(s)
  L.push(`Goals scored by the opposition (${t.goals.label}): ${t.goals.statement}`)
  for (const g of t.goals.items as unknown as Array<{ period: number | null; tick: number; displayMinute: number | null; lane: string | null; involvedInEvent: Array<{ name: string; roleInEvent: string }> }>) {
    L.push(`  period ${g.period} tick ${g.tick} (game minute ${g.displayMinute}) lane ${g.lane ?? 'unknown'}; named in the event: ${g.involvedInEvent.map((p) => `${esc(p.name)} (${p.roleInEvent})`).join(', ') || 'none'}`)
  }
  const d = t.defensiveInvolvement as unknown as { team: { kinds: Record<string, number>; lanes: Record<string, number>; total: number }; players: Array<{ name: string; position: string | null; minutesInWindow: number; roles: { inPossession: { role: string; duty: string | null } | null; outOfPossession: { role: string; duty: string | null } | null }; involvement: { kinds: Record<string, number>; lanes: Record<string, number>; total: number } }>; note: string }
  L.push(`Recorded defensive events of ${esc(t.team.name)} by opposition lane (tackles, interceptions, aerial duels; ${d.team.total} total): left ${d.team.lanes.left}, centre ${d.team.lanes.centre}, right ${d.team.lanes.right}, no location ${d.team.lanes.unknown}`)
  const role = (x: { role: string; duty: string | null } | null) => (x ? `${esc(x.role)}${x.duty ? ` (${esc(x.duty)})` : ''}` : 'none recorded')
  for (const p of d.players) {
    const k = p.involvement.kinds
    L.push(`  ${esc(p.name).padEnd(24)} ${String(p.position ?? '').padEnd(4)} ${p.minutesInWindow.toFixed(1)} min  tackles won/lost ${k.tackle_won}/${k.tackle_lost}, interceptions ${k.interception}, aerials won/lost ${k.aerial_won}/${k.aerial_lost}; lanes L${p.involvement.lanes.left} C${p.involvement.lanes.centre} R${p.involvement.lanes.right}; in possession ${role(p.roles.inPossession)}; out of possession ${role(p.roles.outOfPossession)}`)
  }
  L.push(d.note)
  for (const u of t.unavailable) L.push(`Unavailable ${u.id}: ${u.reason}. ${u.note}`)
  for (const w of r.warnings) L.push(`warning: ${w}`)
  return L.join('\n')
}
