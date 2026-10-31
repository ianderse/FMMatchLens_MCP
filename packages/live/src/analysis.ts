import { DomainError, baseCompletion, deriveResult, round, TICKS_PER_MINUTE } from '@fmmi/model'
import type { Boundary, NormalizedRecording, Side } from '@fmmi/model'
import { compareQuery, playerQuery, resolveWindowOptions, summaryQuery } from '@fmmi/analytics'
import type { AnalysisInput, WindowOptions } from '@fmmi/analytics'
import { createHash } from 'node:crypto'
import { LiveReader } from './reader.ts'
import type { LiveView } from './reader.ts'
import { liveHash } from './track.ts'
import type { MatchTrack } from './track.ts'

/**
 * Live analysis reuses the offline analytics unchanged: the live snapshot is a normalised recording of the frames so far, so the same
 * windows, metric registry, null reasons and findings apply. Nothing here parses a binary file or calls a model. Every result carries an
 * explicit snapshot (game minute, period, tick) and the freshness state; an analysis of a stale or missing snapshot is refused with
 * `stale_snapshot` rather than served (spec 8.2).
 */
export const LIVE_SCHEMA_VERSION = '1.0'
/** Spec section 11 Slice 3 / section 8: tool output stays under about 20 KB. */
export const LIVE_MAX_BYTES = 20 * 1024

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')

/** Internal ids of the live snapshot. `lv_`, `lr_` and `lt_` mark them as live: they are NOT catalog ids and no offline tool accepts them. */
export function liveIds(track: MatchTrack, rec: NormalizedRecording) {
  const base = `live:${track.matchId}`
  const playerIdFor = (up: number) => `p_${createHash('sha256').update(`${base}:${up}`).digest('hex').slice(0, 12)}`
  return {
    matchId: `lv_${liveHash(base)}`,
    saveId: 'live',
    // Different for every snapshot: a live snapshot is not an immutable revision, and nothing can pin it.
    recordingRevisionId: `lr_${liveHash(`${base}@${track.lastTick}`)}`,
    teamIds: { home: `lt_${liveHash(`${base}:home`)}`, away: `lt_${liveHash(`${base}:away`)}` } as Record<Side, string>,
    playerIds: new Map(rec.roster.map((p) => [p.upstreamPlayerId, playerIdFor(p.upstreamPlayerId)] as const)),
  }
}

export function liveInput(track: MatchTrack): AnalysisInput | null {
  const decoded = track.decoded()
  if (!decoded) return null
  const completion = { ...baseCompletion(), status: 'in_progress' as const, evidence: 'live_api_snapshot: the match is in progress; no final result exists' }
  return {
    decoded, completion, result: deriveResult(decoded.recording.observedScore, completion), ids: liveIds(track, decoded.recording),
    warnings: ['live_snapshot: not an archive revision; ids are valid only for this live match and are not catalog ids'],
  }
}

export const snapshotLabel = (s: { displayMinute: number; period: number; tick: number }) => `live as of game minute ${s.displayMinute} / period ${s.period} / tick ${s.tick}`

function header(view: LiveView) {
  return {
    state: view.state, reason: view.reason, upstreamMatchId: view.upstreamMatchId,
    snapshot: view.snapshot ? { ...view.snapshot, label: snapshotLabel(view.snapshot) } : null,
    latest: view.latest,
    connection: view.connection, metadata: view.metadata, plugin: view.plugin, counters: view.counters, catchingUp: view.catchingUp,
  }
}

/** The error an analysis tool returns when the snapshot cannot be served. */
export function notServable(view: LiveView): DomainError {
  const d = { state: view.state, reason: view.reason, lastKnown: view.snapshot ? snapshotLabel(view.snapshot) : null, captureAgeMs: view.latest?.captureAgeMs ?? null }
  if (view.state === 'not_in_match') return new DomainError('not_found', 'The plugin is reachable but no match is in progress', { ...d, retryable_hint: 'start or resume a match' }, true)
  return new DomainError('stale_snapshot', view.state === 'stale' ? 'The latest live frame is older than the freshness limit; the snapshot is not served' : 'The local plugin is not reachable; no live snapshot is served', d, true)
}

async function fresh(reader: LiveReader) {
  const view = await reader.refresh()
  return view
}

function checked<T extends object>(out: T, what: string): T {
  const n = bytes(out)
  if (n > LIVE_MAX_BYTES) throw new DomainError('internal_error', 'The live result exceeds the output limit; narrow the query', { reason: 'result_too_large', tool: what, bytes: n, limit: LIVE_MAX_BYTES })
  return out
}

// ------------------------------------------------------------------ get_live_match

export async function liveMatch(reader: LiveReader) {
  const view = await fresh(reader)
  const base = { schemaVersion: LIVE_SCHEMA_VERSION, query: 'live_match' as const, readOnly: true as const, live: header(view) }
  const track = reader.tracked
  if (view.state !== 'fresh' || !track) {
    return checked({ ...base, available: false as const, summary: null, windows: null, warnings: [`live_${view.state}: ${view.reason ?? 'no snapshot'}`, 'no analysis is served for a snapshot that is not fresh'] }, 'get_live_match')
  }
  const input = liveInput(track)
  if (!input) return checked({ ...base, available: false as const, summary: null, windows: null, warnings: ['no_frame_yet'] }, 'get_live_match')
  const full = summaryQuery(input)
  // Roster entries are kept (playerIds are needed for the follow-up tool) but trimmed to fit the output limit when needed.
  const draft: { schemaVersion: string; query: 'live_match'; readOnly: true; live: ReturnType<typeof header>; available: true; summary: unknown; windows: ReturnType<typeof windowsOf>; warnings: string[] } = {
    ...base, available: true as const, summary: full, windows: windowsOf(input.decoded.recording), warnings: [...full.warnings],
  }
  if (bytes(draft) > LIVE_MAX_BYTES - 1024) {
    const roster = full.summary.roster
    const compact = roster.players.map((p) => ({ playerId: p.playerId, name: p.name, side: p.side, status: p.status, minutes: p.minutes }))
    draft.summary = { ...full, summary: { ...full.summary, roster: { ...roster, players: compact, trimmed: true } } }
  }
  return checked(draft, 'get_live_match')
}

/** Windows the follow-up tools can use: each period seen so far, as canonical boundaries, plus the open end of the snapshot. */
function windowsOf(rec: NormalizedRecording) {
  return {
    periods: rec.periods.map((p) => ({ period: p.period, from: `${p.period}:${p.firstTick}`, to: `${p.period}:${p.lastTick + 1}`, fromMinute: round(p.firstDisplayTick / TICKS_PER_MINUTE, 2), toMinute: round(p.lastDisplayTick / TICKS_PER_MINUTE, 2), frames: p.frames })),
    note: 'Windows are half-open [from,to). The last period is still open: its end is the snapshot, not the end of the period.',
  }
}

// ------------------------------------------------------------------ get_live_player_analysis

export interface LiveNoteRef { noteId: string; side: Side; period: number; tick: number; displayMinute: number }

export async function livePlayer(reader: LiveReader, o: { playerId: string; window?: WindowOptions; note?: LiveNoteRef | null }) {
  const view = await fresh(reader)
  const track = reader.tracked
  if (view.state !== 'fresh' || !track) throw notServable(view)
  const input = liveInput(track)
  if (!input) throw notServable({ ...view, state: 'stale', reason: 'no_frame_yet' })
  const head = { schemaVersion: LIVE_SCHEMA_VERSION, readOnly: true as const, live: header(view) }
  if (o.note) {
    // The annotation boundary splits the snapshot into two windows: before the change and since it. Observational, never a cause.
    const side = input.decoded.recording.roster.find((p) => input.ids.playerIds.get(p.upstreamPlayerId) === o.playerId)?.side
    if (!side) throw new DomainError('not_found', 'Player does not belong to this live match', { reason: 'not_in_match' })
    const b: Boundary = { period: o.note.period, tick: o.note.tick, sequence: 0 }
    const cmp = compareQuery(input, input.ids.teamIds[side], { windowA: { to: b }, windowB: { from: b }, playerIds: [o.playerId] })
    return checked({ ...head, query: 'live_player_note_windows' as const, note: { ...o.note, label: 'manual', statement: 'Windows are [start of snapshot, note boundary) and [note boundary, snapshot end). A tactical change the manager entered; FMMatchLens did not record it.' }, comparison: cmp }, 'get_live_player_analysis')
  }
  const spec = resolveWindowOptions(input, o.window)
  const p = playerQuery(input, o.playerId, { window: spec })
  return checked({ ...head, query: 'live_player' as const, player: p }, 'get_live_player_analysis')
}

// ------------------------------------------------------------------ get_recent_tactical_events

export interface LiveEventNote { noteId: string; side: Side; period: number; tick: number; displayMinute: number; setting: string; priorValue: string; newValue: string; comment: string | null; createdAt: string; supersededBy: string | null }

function minuteAtTick(rec: { ticks: number[]; displayTicks: number[]; periods: number[] }, tick: number): { period: number; minute: number } | null {
  let lo = 0, hi = rec.ticks.length - 1, ans = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rec.ticks[m]! <= tick) { ans = m; lo = m + 1 } else hi = m - 1 }
  return ans < 0 ? null : { period: rec.periods[ans]!, minute: round(rec.displayTicks[ans]! / TICKS_PER_MINUTE, 2) }
}

const roleText = (a: { position: string; role: string; duty: string | null } | null) => (a ? `${a.position} ${a.role}${a.duty ? ` (${a.duty})` : ''}` : null)

export async function liveTacticalEvents(reader: LiveReader, o: { limit?: number; sinceTick?: number; notes?: (upstreamMatchId: string) => LiveEventNote[] }) {
  const view = await fresh(reader)
  const track = reader.tracked
  if (view.state !== 'fresh' || !track) throw notServable(view)
  const input = liveInput(track)
  if (!input) throw notServable({ ...view, state: 'stale', reason: 'no_frame_yet' })
  const limit = o.limit ?? 10
  const rec = input.decoded.recording
  const fi = input.decoded.sampled.frames
  const changes: Array<{ tick: number; period: number | null; displayMinute: number | null; playerId: string; name: string; side: Side; from: string | null; to: string | null; kind: 'role_or_position_change' }> = []
  for (const p of rec.roster) {
    for (let i = 1; i < p.roleTimeline.length; i++) {
      const prev = p.roleTimeline[i - 1]!, cur = p.roleTimeline[i]!
      if (o.sinceTick !== undefined && cur.capturedTick < o.sinceTick) continue
      // A first assignment noticed in the opening game minute is the starting set-up, not a change.
      const hadNothing = !prev.inPossession && !prev.outOfPossession
      if (hadNothing && cur.capturedTick <= (track.firstTick ?? 0) + TICKS_PER_MINUTE) continue
      const at = minuteAtTick(fi, cur.capturedTick)
      const text = (e: typeof prev) => [e.position, roleText(e.inPossession), roleText(e.outOfPossession)].filter(Boolean).join(' / ') || null
      changes.push({ tick: cur.capturedTick, period: at?.period ?? null, displayMinute: at?.minute ?? null, playerId: input.ids.playerIds.get(p.upstreamPlayerId)!, name: p.name, side: p.side, from: text(prev), to: text(cur), kind: 'role_or_position_change' })
    }
  }
  changes.sort((a, b) => b.tick - a.tick)
  const subs = rec.substitutionBatches.filter((b) => o.sinceTick === undefined || b.tick >= o.sinceTick).slice(-limit).reverse().map((b) => {
    const at = minuteAtTick(fi, b.tick)
    return { tick: b.tick, period: b.period, displayMinute: at?.minute ?? null, side: b.side, off: b.off.map((id) => input.ids.playerIds.get(id) ?? null), on: b.on.map((id) => input.ids.playerIds.get(id) ?? null), pairing: b.pairing }
  })
  const notes = (o.notes ? o.notes(track.matchId) : []).slice(-limit)
  return checked({
    schemaVersion: LIVE_SCHEMA_VERSION, query: 'live_tactical_events' as const, readOnly: true as const, live: header(view),
    observed: {
      label: 'observed_by_plugin',
      statement: 'Role and position changes the plugin noticed, with the tick at which it noticed them (not necessarily when the manager acted), and observed substitution batches (off/on pairing is not recorded).',
      roleChanges: { total: changes.length, returned: Math.min(limit, changes.length), items: changes.slice(0, limit) },
      substitutions: subs,
    },
    userNotes: {
      label: 'manual',
      statement: 'Tactical changes entered by the manager with the local fmmi CLI at a live snapshot boundary. FMMatchLens did not record them, and a note is not evidence that the change had an effect.',
      items: notes,
    },
    warnings: [...(view.counters.formationEntries === 0 ? ['no_formation_history_entries_yet'] : [])],
  }, 'get_recent_tactical_events')
}

// ------------------------------------------------------------------ CLI helpers

/** The explicit boundary a live note is pinned to: the snapshot end, or an earlier boundary the user names (never a later one). */
export function liveBoundary(track: MatchTrack, explicit?: { period: number; tick: number }): { period: number; tick: number; displayMinute: number; snapshotTick: number; source: 'live_snapshot_end' | 'explicit' } {
  const snap = track.snapshotStamp
  if (!snap) throw new DomainError('insufficient_coverage', 'No live frame has been read yet', { reason: 'no_frame_yet' }, true)
  if (!explicit) return { period: snap.period, tick: snap.tick, displayMinute: snap.displayMinute, snapshotTick: snap.tick, source: 'live_snapshot_end' }
  const input = liveInput(track)!
  const fi = input.decoded.sampled.frames
  const later = explicit.period > snap.period || (explicit.period === snap.period && explicit.tick > snap.tick)
  const first = fi.boundary(0)
  const earlier = explicit.period < first.period || (explicit.period === first.period && explicit.tick < first.tick)
  if (later || earlier) throw new DomainError('invalid_input', 'The boundary is outside the live snapshot; a note can only refer to a moment the reader has seen', { reason: 'boundary_outside_snapshot', snapshot: `${snap.period}:${snap.tick}`, first: `${first.period}:${first.tick}` })
  const at = minuteAtTick(fi, explicit.tick)
  return { period: explicit.period, tick: explicit.tick, displayMinute: at && at.period === explicit.period ? at.minute : snap.displayMinute, snapshotTick: snap.tick, source: 'explicit' }
}


/** Team-level before/after windows around a live note: [start of snapshot, boundary) against [boundary, snapshot end). Observational. */
export async function liveNoteCompare(reader: LiveReader, note: LiveNoteRef & { upstreamMatchId: string }) {
  const view = await fresh(reader)
  const track = reader.tracked
  if (view.state !== 'fresh' || !track) throw notServable(view)
  if (track.matchId !== note.upstreamMatchId) throw new DomainError('not_found', 'The live match is not the match this note was made in', { reason: 'different_live_match' })
  const input = liveInput(track)
  if (!input) throw notServable({ ...view, state: 'stale', reason: 'no_frame_yet' })
  const b: Boundary = { period: note.period, tick: note.tick, sequence: 0 }
  const comparison = compareQuery(input, input.ids.teamIds[note.side], { windowA: { to: b }, windowB: { from: b } })
  return checked({
    schemaVersion: LIVE_SCHEMA_VERSION, query: 'live_note_compare' as const, readOnly: true as const, live: header(view),
    note: { ...note, label: 'manual', statement: 'Windows are [start of snapshot, note boundary) and [note boundary, snapshot end). The change was entered by the manager; FMMatchLens did not record it. Observational: no cause is implied.' },
    comparison,
  }, 'live_note_compare')
}
