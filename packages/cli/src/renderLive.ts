import { safeText } from '@fmmi/model'
import type { Capture, CheckReport, liveNoteCompare } from '@fmmi/live'
import { renderCompare } from './render.ts'

const t = (s: string | null | undefined) => safeText(s)

export function renderLiveCapture(cap: Capture, file: string): string {
  const L: string[] = []
  L.push(`Captured ${cap.endpoints.length} endpoint shape(s) from ${cap.host}:${cap.port} (sanitised structure only: no names, ids zeroed, arrays cut to two elements).`)
  for (const e of cap.endpoints) L.push(`  ${e.id.padEnd(18)} ${e.ok ? 'answered' : `FAILED (${e.failure}${e.httpStatus ? ` ${e.httpStatus}` : ''})`}  ${e.basis}${e.bytes !== null ? `  ${e.bytes} bytes` : ''}`)
  const ws = cap.websocket
  L.push(`  websocket          ${!ws.attempted ? 'not sampled' : ws.opened ? `opened, ${ws.messages.length} envelope(s): ${ws.messages.map((m) => m.type).join(', ') || 'none'}` : `did not open (${ws.failure ?? 'no reason'})`}`)
  L.push(`Saved: ${file}`)
  L.push('Next: fmmi live check   (validates the saved shapes against this project\'s schemas). The live path stays UNVERIFIED until a capture from a running match has passed.')
  return L.join('\n')
}

export function renderLiveCheck(r: CheckReport): string {
  const L = r.lines.map((l) => `  ${l.id.padEnd(22)} ${l.verdict.padEnd(15)} ${l.basis.padEnd(9)} ${safeText(l.detail, 240)}${l.extraKeys.length ? `  (keys we do not model: ${l.extraKeys.slice(0, 8).map(t).join(', ')})` : ''}`)
  return [`Live capture check: ${r.ok ? 'no mismatch' : 'MISMATCH'}${r.verifiesLivePath ? ', complete' : ', incomplete'}`, ...L, safeText(r.summary, 700)].join('\n')
}

type NoteCompare = Awaited<ReturnType<typeof liveNoteCompare>>
export function renderLiveNoteCompare(r: NoteCompare, adoption: { tacticalNoteId: string } | null): string {
  const s = r.live.snapshot
  return [
    `Live note ${r.note.noteId} (manual): boundary ${r.note.period}:${r.note.tick} (game minute ${r.note.displayMinute}); ${s ? s.label : 'no snapshot'}.`,
    adoption ? `Already imported as tactical note ${adoption.tacticalNoteId}: \`fmmi note compare ${adoption.tacticalNoteId}\` compares across matches.` : 'Not yet imported: the match is still unknown to the catalog.',
    safeText(r.note.statement, 400),
    renderCompare(r.comparison as Parameters<typeof renderCompare>[0]),
  ].join('\n')
}
