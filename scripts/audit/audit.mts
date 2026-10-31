// Slice 0 audit of a single .fmlens recording (FMMatchLens v0.7.0, format 2.x).
// Usage: node scripts/audit/audit.mts <file.fmlens> [outDir]
// Throwaway-but-kept. Everything here is MEASURED from the file; interpretation notes are
// labelled "inferred" in docs/data-coverage.md, never in this output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArchiveFile } from './lib/archiveParser.ts'

const file = resolve(process.argv[2] ?? 'tests/fixtures/local/2026-08-31-Farnham-vs-Torquay-0-3.fmlens')
const outDir = resolve(process.argv[3] ?? 'audit-output')
mkdirSync(outDir, { recursive: true })
const buf = readFileSync(file)
const sha256 = createHash('sha256').update(buf).digest('hex')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
const R: Record<string, any> = {}
const r2 = (n: number, d = 4) => Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n
const hist = <T,>(xs: T[], f: (x: T) => string | number) => { const h: Record<string, number> = {}; for (const x of xs) { const k = String(f(x)); h[k] = (h[k] ?? 0) + 1 } return h }

// ---------- A. raw record walk (independent of the parser; CRC is checked by the parser itself) ----------
{
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = buf.subarray(0, 8).toString('latin1')
  const major = dv.getUint16(8, true), minor = dv.getUint16(10, true), headerLength = dv.getUint32(12, true)
  const recs: any[] = []
  let off = headerLength, endOffset: number | null = null, trailing = 0, truncated = false
  const rv = (o: number) => { // varuint
    let v = 0n; let i = 0
    for (; i < 10; i++) { const b = buf[o + i]; v |= BigInt(b & 0x7f) << BigInt(7 * i); if (!(b & 0x80)) break }
    return [v, i + 1] as const
  }
  while (off < buf.length) {
    const t = buf[off]
    if (t === 2) { // block: 1 + 28 header tail + 4 crc + payload
      const cLen = dv.getUint32(off + 1 + 4 + 2 + 4 + 4 + 2 + 4, true)
      const startTick = dv.getInt32(off + 1 + 4 + 2, true), endTick = dv.getInt32(off + 1 + 4 + 2 + 4, true)
      const frameCount = dv.getUint16(off + 1 + 4 + 2 + 8, true)
      const uLen = dv.getUint32(off + 1 + 4 + 2 + 8 + 2, true)
      recs.push({ type: 2, off, startTick, endTick, frameCount, uLen, cLen })
      off += 1 + 28 + 4 + cLen
    } else {
      const len = dv.getUint32(off + 1, true)
      recs.push({ type: t, off, len })
      off += 1 + 8 + len
      if (t === 4) { endOffset = off; trailing = buf.length - off; break }
    }
  }
  if (off > buf.length) truncated = true
  const blocks = recs.filter(r => r.type === 2)
  const contiguousGaps = blocks.slice(1).map((b, i) => b.startTick - blocks[i].endTick)
  const endRec = recs.find(r => r.type === 4)
  const endMs = endRec ? Number(dv.getBigInt64(endRec.off + 9, true)) : null
  R.integrity = {
    file: basename(file), sizeBytes: buf.length, sha256, magic: JSON.stringify(magic), structure: `${major}.${minor}`, headerLength,
    recordTypeCounts: hist(recs, r => r.type), recordTypeLegend: { 1: 'metadata', 2: 'chunk', 3: 'finalIndex', 4: 'end', 5: 'metadataDelta', 7: 'ratingModelMetadata' },
    recordOrder: recs.filter(r => r.type !== 2).map(r => `${r.type}@${r.off}`),
    blockCount: blocks.length, framesPerBlock: hist(blocks, b => b.frameCount),
    blockTickGapsBetweenBlocks: hist(contiguousGaps, g => g),
    compressedBytes: blocks.reduce((a, b) => a + b.cLen, 0), uncompressedBytes: blocks.reduce((a, b) => a + b.uLen, 0),
    endRecordPresent: !!endRec, endRecordIsLastRecord: endOffset === buf.length, bytesAfterEndRecord: trailing, truncatedWalk: truncated,
    endedUnixMs: endMs,
  }
}

// ---------- parse (parser verifies header CRC, record CRC, block CRC, sizes, final index vs block headers) ----------
let parsed: any, parseError: string | null = null
try { parsed = await parseArchiveFile(ab, basename(file)) } catch (e: any) { parseError = String(e?.message ?? e) }
R.parse = { ok: !parseError, error: parseError, note: 'parseArchiveFile throws on any header/record/block CRC, length, revision-order, final-index or trailing-byte violation; success implies all CRCs matched.' }
if (parseError) { writeFileSync(resolve(outDir, 'audit.json'), JSON.stringify(R, null, 1)); console.log(JSON.stringify(R, null, 1)); process.exit(2) }

const frames: any[] = parsed.frames, meta = parsed.metadata, timeline: any[] = parsed.metadataTimeline
const first = frames[0], last = frames.at(-1)
R.archive = parsed.archive
R.integrity.parsedFrameCount = frames.length
R.integrity.metadataRevisions = timeline.length

// ---------- B. identities ----------
const players: any[] = meta.players
const bySlot = new Map(players.map(p => [p.slot, p]))
const byPid = new Map(players.map(p => [p.playerId, p]))
// MEASURED: event playerSlot/receiverPlayerSlot are SIDE-LOCAL (0..17 per side); frame/metadata slots are global (away starts at awayBase).
const awayBase = Math.min(...players.filter(p => p.team === 'away').map(p => p.slot))
const gslot = (team: string, s: number) => team === 'away' ? s + awayBase : s
{
  let slotPidMismatch = 0, slotTeamMismatch = 0, rosterSizes = new Set<number>()
  for (const f of frames) {
    rosterSizes.add(f.players.length)
    for (const p of f.players) { const m = bySlot.get(p.slot); if (!m || m.playerId !== p.playerId) slotPidMismatch++; if (m && m.team !== p.team) slotTeamMismatch++ }
  }
  const tl = timeline.map(m => ({ capturedTick: m.capturedTick, players: m.players.length }))
  R.identity = {
    home: meta.home, away: meta.away, competition: meta.competition, matchDate: meta.matchDate, halfPitch: [meta.halfPitchWidth, meta.halfPitchLength],
    sourceMatchIdInHeader: parsed.archive.matchId, startedUnixMs: parsed.archive.startedUnixMilliseconds,
    startedIso: new Date(parsed.archive.startedUnixMilliseconds).toISOString(),
    sourceMatchIdLooksLike: 'match-<startedUnixMs>', sourceMatchIdEqualsStartMs: parsed.archive.matchId === `match-${parsed.archive.startedUnixMilliseconds}`,
    metadataPlayerCount: players.length, perSide: hist(players, p => p.team),
    uidNull: players.filter(p => p.uid == null).length, playerIdEqualsUid: players.filter(p => p.playerId === p.uid).length,
    negativePlayerIds: players.filter(p => p.playerId < 0).length, duplicatePlayerIds: players.length - byPid.size,
    slotsContiguousFromZero: players.every((p, i) => p.slot === i),
    homeSlots: [Math.min(...players.filter(p => p.team === 'home').map(p => p.slot)), Math.max(...players.filter(p => p.team === 'home').map(p => p.slot))],
    awaySlots: [Math.min(...players.filter(p => p.team === 'away').map(p => p.slot)), Math.max(...players.filter(p => p.team === 'away').map(p => p.slot))],
    frameRosterSizes: [...rosterSizes], frameSlotPlayerIdMismatchesVsMetadata: slotPidMismatch, frameSlotTeamMismatchesVsMetadata: slotTeamMismatch,
    metadataTimeline: tl,
    uidRange: [Math.min(...players.map(p => p.uid)), Math.max(...players.map(p => p.uid))],
    uidMagnitudeBands: hist(players, p => p.uid >= 2e9 ? '>=2.0e9' : p.uid >= 2e9 - 1 ? 'x' : p.uid > 1e8 ? '1e8..2e9' : '<1e8'),
    shirtNumberDuplicatesPerSide: ['home', 'away'].map(t => { const h = hist(players.filter(p => p.team === t), p => p.shirtNumber); return Object.entries(h).filter(([, n]) => n > 1) }),
    humanManagers: { home: meta.home.manager?.isHumanControlled, away: meta.away.manager?.isHumanControlled },
    profilePresent: players.filter(p => p.profile).length, attributesPresent: players.filter(p => p.attributes).length,
    roster: players.map(p => ({ slot: p.slot, playerId: p.playerId, uid: p.uid, team: p.team, name: p.displayName, pos: p.position, shirt: p.shirtNumber, squad: p.squadNumber })),
  }
}

// ---------- C. time ----------
const ticks = frames.map(f => f.tick)
const dTick = ticks.slice(1).map((t, i) => t - ticks[i])
const seqs = frames.map(f => f.sequence)
const periods = [...new Set(frames.map(f => f.period))]
const perStats = periods.map(p => {
  const fs = frames.filter(f => f.period === p)
  const offs = fs.map(f => f.tick - f.displayTick)
  return { period: p, frames: fs.length, firstTick: fs[0].tick, lastTick: fs.at(-1).tick, firstDisplay: fs[0].displayTick, lastDisplay: fs.at(-1).displayTick,
    firstSeq: fs[0].sequence, lastSeq: fs.at(-1).sequence, tickMinusDisplayMin: Math.min(...offs), tickMinusDisplayMax: Math.max(...offs), tickMinusDisplayFirst: offs[0], tickMinusDisplayLast: offs.at(-1) }
})
const wallDt = frames.slice(1).map((f, i) => f.capturedUnixMilliseconds - frames[i].capturedUnixMilliseconds)
const bigGaps = dTick.map((d, i) => ({ d, i })).filter(x => x.d > 1)
const gapLocByDecile = hist(bigGaps, g => Math.floor(g.i / frames.length * 10))
const goalEvents: any[] = []
for (let i = 1; i < frames.length; i++) for (const side of ['home', 'away'] as const) if (frames[i][side].goals > frames[i - 1][side].goals) goalEvents.push({ side, tick: frames[i].tick, displayTick: frames[i].displayTick, period: frames[i].period, displayMinute: r2(frames[i].displayTick / 240, 2), score: `${frames[i].home.goals}-${frames[i].away.goals}` })
R.time = {
  frameCount: frames.length, firstTick: first.tick, lastTick: last.tick,
  tickDeltaHist: hist(dTick, d => d > 20 ? '>20' : d), nonMonotonicTicks: dTick.filter(d => d <= 0).length,
  sequenceMonotonicStrict: seqs.slice(1).every((s, i) => s > seqs[i]), sequenceDeltaHist: hist(seqs.slice(1).map((s, i) => s - seqs[i]), d => d > 10 ? '>10' : d),
  sequenceRelationToTick: 'sequence is a global per-capture counter; frames carry both. sequence-tick at first/last: ' + [first.sequence - first.tick, last.sequence - last.tick].join('/'),
  missingTicksTotal: dTick.reduce((a, d) => a + (d > 1 ? d - 1 : 0), 0), gapsCount: bigGaps.length, largestGaps: bigGaps.sort((a, b) => b.d - a.d).slice(0, 8).map(g => ({ gap: g.d, atTick: ticks[g.i], atDisplay: frames[g.i].displayTick, period: frames[g.i].period })),
  gapLocationByFrameDecile: gapLocByDecile,
  periods: perStats,
  halftimeTickGap: periods.length > 1 ? perStats[1].firstTick - perStats[0].lastTick : null,
  displayTickResetsPerPeriod: periods.length > 1 ? { p1LastDisplay: perStats[0].lastDisplay, p2FirstDisplay: perStats[1].firstDisplay, resetsToZero: perStats[1].firstDisplay < 100 } : null,
  ticksPerMinuteAssumed240Check: { p2FirstDisplayMinutes: r2(perStats[1].firstDisplay / 240, 3), p1LastDisplayMinutes: r2(perStats[0].lastDisplay / 240, 3), lastDisplayMinutes: r2(last.displayTick / 240, 3), lastTickMinutes: r2(last.tick / 240, 3) },
  wallClock: { totalSeconds: r2((last.capturedUnixMilliseconds - first.capturedUnixMilliseconds) / 1000, 1), framesWithZeroWallDelta: wallDt.filter(d => d === 0).length, wallDeltaMedianMs: [...wallDt].sort((a, b) => a - b)[Math.floor(wallDt.length / 2)] },
  headerStartMsMinusFirstFrameCapturedMs: first.capturedUnixMilliseconds - parsed.archive.startedUnixMilliseconds,
  lastFrameCapturedMinusEndRecordMs: last.capturedUnixMilliseconds - (R.integrity.endedUnixMs ?? NaN),
  wallClockPlayDurationMin: r2((parsed.archive.endedUnixMilliseconds - parsed.archive.startedUnixMilliseconds) / 60000, 2),
  goalTransitions: goalEvents,
  postLastGoalFramesAndTicks: null as any,
  matchPhaseFromRatingModel: (() => { const h: Record<string, any> = {}; for (const f of frames) { const m = f.ratingModel; const k = m ? `phase=${m.matchPhase},branch=${m.eventRewardBranch}` : 'none'; (h[k] ??= { frames: 0, firstTick: f.tick, lastTick: f.tick, firstPeriod: f.period, lastPeriod: f.period }); h[k].frames++; h[k].lastTick = f.tick; h[k].lastPeriod = f.period } return h })(),
}
const lastGoalTick = goalEvents.at(-1)?.tick
R.time.postLastGoalFramesAndTicks = lastGoalTick == null ? null : { lastGoalTick, ticksAfter: last.tick - lastGoalTick, minutesAfterAt240: r2((last.displayTick - frames.find(f => f.tick >= lastGoalTick)!.displayTick) / 240, 2) }

// ---------- D. scores / team counters ----------
const T = (s: 'home' | 'away') => last[s]
const shotSum = (s: 'home' | 'away') => T(s).shotsOnTarget + T(s).shotsOffTarget + T(s).blockedShots
// monotonicity of cumulative counters
const decreases: Record<string, number> = {}
for (let i = 1; i < frames.length; i++) for (const s of ['home', 'away'] as const) for (const k of Object.keys(frames[i][s])) if (frames[i][s][k] < frames[i - 1][s][k]) decreases[`${s}.${k}`] = (decreases[`${s}.${k}`] ?? 0) + 1
const finalIdxMatch = { parsedHomeGoals: last.home.goals, parsedAwayGoals: last.away.goals, archiveHomeGoals: parsed.archive.homeGoals, archiveAwayGoals: parsed.archive.awayGoals }
// first-frame counters (is the baseline zero?)
R.team = { final: { home: last.home, away: last.away }, firstFrame: { home: first.home, away: first.away }, shotsOnPlusOffPlusBlocked: { home: shotSum('home'), away: shotSum('away') },
  counterDecreases: decreases, finalIndexVsLast: finalIdxMatch, possessionTimeShare: { home: r2(100 * last.home.possessionTime / (last.home.possessionTime + last.away.possessionTime), 2), away: r2(100 * last.away.possessionTime / (last.home.possessionTime + last.away.possessionTime), 2), unitsNote: 'possessionTime sums: ' + (last.home.possessionTime + last.away.possessionTime) + ' vs last tick ' + last.tick },
  humanSide: meta.home.manager?.isHumanControlled ? 'home' : meta.away.manager?.isHumanControlled ? 'away' : 'none' }

// ---------- E. player participation ----------
const pstat = new Map<number, any>()
for (const p of players) pstat.set(p.slot, { slot: p.slot, name: p.displayName, team: p.team, firstOnPitchTick: null, lastOnPitchTick: null, onPitchFrames: 0, onPitchTransitions: [] as any[], isSubstituteFirst: null, isSubstituteLast: null, subbedOnMinute: 0, subbedOffMinute: 0, distinctXY: new Set<string>(), nonzeroXYFrames: 0 })
let prevOn = new Map<number, boolean>()
for (const f of frames) for (const p of f.players) {
  const s = pstat.get(p.slot)
  if (s.isSubstituteFirst === null) s.isSubstituteFirst = p.isSubstitute
  s.isSubstituteLast = p.isSubstitute; s.subbedOnMinute = p.subbedOnMinute; s.subbedOffMinute = p.subbedOffMinute
  if (p.isOnPitch) { s.onPitchFrames++; if (s.firstOnPitchTick === null) s.firstOnPitchTick = f.tick; s.lastOnPitchTick = f.tick }
  if (prevOn.get(p.slot) !== p.isOnPitch) { s.onPitchTransitions.push({ tick: f.tick, display: f.displayTick, period: f.period, on: p.isOnPitch }); prevOn.set(p.slot, p.isOnPitch) }
  if (p.x !== 0 || p.y !== 0) s.nonzeroXYFrames++
}
const pl = (slot: number): any => last.players.find((p: any) => p.slot === slot)
R.participation = Array.from(pstat.values()).map(s => ({ slot: s.slot, name: s.name, team: s.team, isSubstituteFirstFrame: s.isSubstituteFirst, isSubstituteLastFrame: s.isSubstituteLast, onPitchFrames: s.onPitchFrames, firstOnTick: s.firstOnPitchTick, lastOnTick: s.lastOnPitchTick, transitions: s.onPitchTransitions.slice(0, 6), subbedOnMinute: s.subbedOnMinute, subbedOffMinute: s.subbedOffMinute, nonzeroXYFrames: s.nonzeroXYFrames, finalRating: r2(pl(s.slot).rating, 2) }))
R.participationSummary = {
  playedAtLeastOneFrame: R.participation.filter((p: any) => p.onPitchFrames > 0).length,
  startersByFirstFrame: R.participation.filter((p: any) => p.firstOnTick === first.tick).length,
  subsEntered: R.participation.filter((p: any) => p.firstOnTick !== null && p.firstOnTick !== first.tick).map((p: any) => ({ name: p.name, team: p.team, onTick: p.firstOnTick, subbedOnMinute: p.subbedOnMinute })),
  leftPitchBeforeEnd: R.participation.filter((p: any) => p.transitions.some((t: any) => !t.on && t.tick > first.tick)).map((p: any) => ({ name: p.name, team: p.team, transitions: p.transitions, subbedOffMinute: p.subbedOffMinute })),
  neverOnPitch: R.participation.filter((p: any) => p.onPitchFrames === 0).length,
  playersWithoutAnyNonzeroPosition: R.participation.filter((p: any) => p.nonzeroXYFrames === 0).map((p: any) => p.name),
  onPitchCountAtLastFrame: hist(last.players.filter((p: any) => p.isOnPitch), (p: any) => p.team),
}

function onPitchRange(k: string) { let lo = Infinity, hi = -Infinity; for (const f of frames) for (const p of f.players) if (p.isOnPitch) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]) } return [lo, hi] }
// ---------- F. events ledger ----------
type Ver = { e: any, firstFrameTick: number, firstFramePeriod: number, firstFrameSeq: number }
const vers = new Map<number, Ver[]>()
const ekey = (e: any) => JSON.stringify([e.tick, e.lateralPosition, e.longitudinalPosition, e.team, e.playerSlot, e.playerId, e.receiverPlayerSlot, e.receiverPlayerId, e.eventType, e.flags, e.sequenceIndex, e.completionTick, e.trajectoryPoints])
const lastKey = new Map<number, string>()
const eventIndexSeen = new Map<number, Set<number>>()
let maxTail = 0
for (const f of frames) {
  maxTail = Math.max(maxTail, f.momentumEvents.length)
  for (const e of f.momentumEvents) {
    const k = ekey(e)
    if (lastKey.get(e.sequenceIndex) !== k) { lastKey.set(e.sequenceIndex, k); const a = vers.get(e.sequenceIndex) ?? []; a.push({ e, firstFrameTick: f.tick, firstFramePeriod: f.period, firstFrameSeq: f.sequence }); vers.set(e.sequenceIndex, a) }
    ;(eventIndexSeen.get(e.sequenceIndex) ?? eventIndexSeen.set(e.sequenceIndex, new Set()).get(e.sequenceIndex)!).add(e.eventIndex)
  }
}
const ledger = [...vers.entries()].sort((a, b) => a[0] - b[0]).map(([seq, a]) => ({ seq, v: a, ev: a.at(-1)!.e, first: a[0] }))
const finalTailIdx = last.momentumEvents.map((e: any) => e.eventIndex)
const seqKeys = ledger.map(l => l.seq)
const changedFields: Record<string, number> = {}
const revisedBits: Record<string, number> = {}
for (const l of ledger) for (let i = 1; i < l.v.length; i++) { for (const k of Object.keys(l.v[i].e)) if (JSON.stringify(l.v[i].e[k]) !== JSON.stringify(l.v[i - 1].e[k])) changedFields[k] = (changedFields[k] ?? 0) + 1; const x = l.v[i].e.flags ^ l.v[i - 1].e.flags; if (x) revisedBits['0x' + x.toString(16)] = (revisedBits['0x' + x.toString(16)] ?? 0) + 1 }
const evs = ledger.map(l => l.ev)
const periodOfTick = (t: number) => t <= perStats[0].lastTick ? 1 : t >= perStats[1].firstTick ? 2 : 0
const tickOrderViolations = ledger.slice(1).filter((l, i) => l.ev.tick < ledger[i].ev.tick).length
// events appear in tail: do all remain readable in last frame? tail window cap
R.events = {
  maxTailLengthInAnyFrame: maxTail, lastFrameTailLength: last.momentumEvents.length, uniqueSequenceIndexes: ledger.length, sequenceMin: seqKeys[0], sequenceMax: seqKeys.at(-1),
  missingSequenceNumbersInRange: seqKeys.at(-1)! - seqKeys[0] + 1 - ledger.length,
  eventIndexMaxPlusOne: Math.max(...evs.map(e => e.eventIndex)) + 1, eventIndexDistinctFinal: new Set(evs.map(e => e.eventIndex)).size,
  eventIndexFinalContiguousFromZero: new Set(evs.map(e => e.eventIndex)).size === Math.max(...evs.map(e => e.eventIndex)) + 1,
  eventIndexRelocated: [...eventIndexSeen.values()].filter(s => s.size > 1).length,
  versionsPerSequence: hist(ledger, l => l.v.length), changedFieldsAcrossRevisions: changedFields, flagBitsToggledByRevision: revisedBits,
  eventsWithAnyRevisionOtherThanRelocation: ledger.filter(l => l.v.some((x, i) => i > 0 && ekey({ ...x.e }) !== ekey({ ...l.v[i - 1].e }))).length,
  typeHist: hist(evs, e => e.eventType), teamHist: hist(evs, e => e.team),
  tickOrderViolationsBySequence: tickOrderViolations,
  eventPeriodByTick: hist(evs, e => periodOfTick(e.tick)), eventsInHalftimeTickGap: evs.filter(e => periodOfTick(e.tick) === 0).length,
  eventFirstSeenPeriodVsTickPeriodMismatch: ledger.filter(l => periodOfTick(l.ev.tick) !== 0 && periodOfTick(l.ev.tick) !== l.first.firstFramePeriod).length,
  completionTickMinusTick: hist(evs.filter(e => e.eventType === 7), e => { const d = e.completionTick - e.tick; return d > 40 ? '>40' : d < 0 ? '<0' : d }),
  flagsHist: hist(evs, e => '0x' + e.flags.toString(16)),
  flagBitCountsAllEvents: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(b => [`0x${(1 << b).toString(16)}`, evs.filter(e => e.flags & (1 << b)).length])),
  trajectoryPointCountHist: hist(evs, e => `${e.eventType >= 6 && e.eventType <= 17 ? 'passOrCross' : 'other'}:${e.trajectoryPoints?.length ?? 'na'}`),
  coordRanges: {
    lateral: [Math.min(...evs.map(e => e.lateralPosition)), Math.max(...evs.map(e => e.lateralPosition))],
    longitudinal: [Math.min(...evs.map(e => e.longitudinalPosition)), Math.max(...evs.map(e => e.longitudinalPosition))],
    playerX: onPitchRange('x'),
    playerY: onPitchRange('y'),
    halfPitchWidth: meta.halfPitchWidth, halfPitchLength: meta.halfPitchLength,
  },
}

// ---------- G. pass-event semantics, reconciliation ----------
const PASS = new Set([6, 7, 8, 9, 10, 11]), CROSS = new Set([12, 13, 14, 15, 16, 17])
const SETPIECE_BITS = 0x08 | 0x10 | 0x20 | 0x40
const side = ['home', 'away'] as const
const passEv = (s: string, f: (e: any) => boolean = () => true) => evs.filter(e => e.team === s && PASS.has(e.eventType) && f(e))
const sideCounts: any = {}
for (const s of side) {
  const all = passEv(s), comp = passEv(s, e => e.eventType === 7)
  const open = all.filter(e => (e.flags & SETPIECE_BITS) === 0)
  const crossAll = evs.filter(e => e.team === s && CROSS.has(e.eventType)), crossComp = crossAll.filter(e => e.eventType === 12)
  const t = last[s]
  sideCounts[s] = {
    counter: { passes: t.passes, passesCompleted: t.passesCompleted, crosses: t.crosses, crossesCompleted: t.crossesCompleted, progressivePasses: t.progressivePasses, finalThirdPasses: t.finalThirdPasses },
    events: { pass6to11: all.length, pass7: comp.length, pass6to11_openPlayFlags: open.length, pass7_openPlayFlags: open.filter(e => e.eventType === 7).length, cross12to17: crossAll.length, cross12: crossComp.length,
      pass6to17: all.length + crossAll.length, pass7plus12: comp.length + crossComp.length, byType: hist(all, e => e.eventType) },
    excl0x8: { pass6to11: all.filter(e => !(e.flags & 0x8)).length, pass7: comp.filter(e => !(e.flags & 0x8)).length, diffAttempts: all.filter(e => !(e.flags & 0x8)).length - t.passes, diffCompleted: comp.filter(e => !(e.flags & 0x8)).length - t.passesCompleted, with0x8: all.filter(e => e.flags & 0x8).length, with0x8Completed: comp.filter(e => e.flags & 0x8).length, throwInsCounterSum: players.filter(q => q.team === s).reduce((a, q) => a + (pl(q.slot).throwIns ?? 0), 0), cornersFlag0x40OnCross: crossAll.filter(e => e.flags & 0x40).length, cornersCounter: t.corners, aerialEventsWon28: evs.filter(e => e.team === s && e.eventType === 28).length, aerialEventsLost29: evs.filter(e => e.team === s && e.eventType === 29).length, aerialsCounter: t.aerials, aerialsWonCounter: t.aerialsWon },
    diffVsCounter: { passes_6to11: all.length - t.passes, passes_7: comp.length - t.passesCompleted, passes_6to17: all.length + crossAll.length - t.passes, completed_7plus12: comp.length + crossComp.length - t.passesCompleted, crosses_12to17: crossAll.length - t.crosses, crossesCompleted_12: crossComp.length - t.crossesCompleted },
  }
}
// player-level reconciliation
const perPlayer: any[] = []
for (const p of players) {
  const lp = pl(p.slot)
  const mine = evs.filter(e => gslot(e.team, e.playerSlot) === p.slot && e.team === p.team)
  const mineP = mine.filter(e => PASS.has(e.eventType)), mineC = mine.filter(e => CROSS.has(e.eventType))
  perPlayer.push({ slot: p.slot, name: p.displayName, team: p.team,
    counter: { passes: lp.passes, passesCompleted: lp.passesCompleted, crosses: lp.crosses, crossesCompleted: lp.crossesCompleted, keyPasses: lp.keyPasses, progressivePasses: lp.progressivePasses, aerials: lp.aerials, aerialsWon: lp.aerialsWon, shots: lp.shots, xg: lp.xg, goals: lp.goals, assists: lp.assists },
    events: { pass6to11_excl0x8: mineP.filter(e => !(e.flags & 8)).length, pass7_excl0x8: mineP.filter(e => e.eventType === 7 && !(e.flags & 8)).length, flag0x8: mineP.filter(e => e.flags & 8).length, throwInsCounter: lp.throwIns, pass6to11: mineP.length, pass7: mineP.filter(e => e.eventType === 7).length, cross12to17: mineC.length, cross12: mineC.filter(e => e.eventType === 12).length, aerial28: mine.filter(e => e.eventType === 28).length, aerial29: mine.filter(e => e.eventType === 29).length, keyPassFlag: mine.filter(e => (e.eventType >= 6 && e.eventType <= 17) && (e.flags & 2)).length,
      shots1to5: mine.filter(e => e.eventType >= 1 && e.eventType <= 5).length } })
}
const sumCmp = (key: string, evKey: string, d: (pp: any) => number) => perPlayer.filter(pp => d(pp) !== 0).length
R.playerEventReconciliation = {
  playersWhereEventPassesNeqCounterPasses: perPlayer.filter(p => p.events.pass6to11 !== p.counter.passes).length,
  playersWhereEventPassesPlusCrossesNeqCounterPasses: perPlayer.filter(p => p.events.pass6to11 + p.events.cross12to17 !== p.counter.passes).length,
  playersWhereEventPassesExcl0x8NeqCounter: perPlayer.filter(p => p.events.pass6to11_excl0x8 !== p.counter.passes).length,
  playersWhereCompletedExcl0x8NeqCounter: perPlayer.filter(p => p.events.pass7_excl0x8 !== p.counter.passesCompleted).length,
  playersWhere0x8FlagNeqThrowIns: perPlayer.filter(p => p.events.flag0x8 !== (p.events.throwInsCounter ?? 0)).length,
  playersWhereCompletedNeq: perPlayer.filter(p => p.events.pass7 !== p.counter.passesCompleted).length,
  playersWhereCompletedPlusCrossCompletedNeq: perPlayer.filter(p => p.events.pass7 + p.events.cross12 !== p.counter.passesCompleted).length,
  playersWhereCrossesNeq: perPlayer.filter(p => p.events.cross12to17 !== p.counter.crosses).length,
  playersWhereAerialsNeq: perPlayer.filter(p => p.events.aerial28 + p.events.aerial29 !== p.counter.aerials).length,
  playersWhereAerialsWonNeq: perPlayer.filter(p => p.events.aerial28 !== p.counter.aerialsWon).length,
  playersWhereKeyPassFlagNeqCounter: perPlayer.filter(p => p.events.keyPassFlag !== p.counter.keyPasses).length,
  sumPlayerCountersVsTeam: Object.fromEntries(side.map(s => [s, Object.fromEntries(['passes', 'passesCompleted', 'crosses', 'crossesCompleted', 'aerials', 'aerialsWon', 'progressivePasses', 'shots', 'goals'].map(k => [k, { players: perPlayer.filter(p => p.team === s).reduce((a, p) => a + (p.counter as any)[k], 0), team: (last[s] as any)[k] }]))])),
  rows: perPlayer.filter(p => p.counter.passes || p.events.pass6to11 || p.counter.aerials || p.events.aerial28 || p.events.aerial29),
}
R.passReconciliation = sideCounts

// flag-bit vs progressive/final-third/keyPass counters: which flag bit count matches team counter?
const bitSearch: any = {}
for (const s of side) {
  bitSearch[s] = {}
  for (let b = 0; b < 12; b++) {
    const m = 1 << b
    const c7 = passEv(s, e => e.eventType === 7 && (e.flags & m) !== 0).length
    const call = passEv(s, e => (e.flags & m) !== 0).length
    bitSearch[s][`0x${m.toString(16)}`] = { completedWithBit: c7, anyPassWithBit: call }
  }
  bitSearch[s].counters = { progressivePasses: last[s].progressivePasses, finalThirdPasses: last[s].finalThirdPasses, passesCompleted: last[s].passesCompleted, corners: last[s].corners }
}
R.flagBitSearch = bitSearch
R.flagBitSearch.crossesCornerFlag = Object.fromEntries(side.map(s => [s, { cornerFlagOnCross: evs.filter(e => e.team === s && CROSS.has(e.eventType) && (e.flags & 0x40)).length, cornersCounter: last[s].corners, type52WithCornerFlag: evs.filter(e => e.team === s && e.eventType === 52 && (e.flags & 0x40)).length }]))

// ---------- H. receiver semantics ----------
const nearestFrame = (tick: number) => { let lo = 0, hi = frames.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].tick < tick) lo = mid + 1; else hi = mid } const c = [lo - 1, lo].filter(i => i >= 0 && i < frames.length).sort((a, b) => Math.abs(frames[a].tick - tick) - Math.abs(frames[b].tick - tick))[0]; return frames[c] }
const passes = evs.filter(e => PASS.has(e.eventType))
const recvStat = (list: any[]) => {
  const withRecv = list.filter(e => e.receiverPlayerId !== 0 && e.receiverPlayerSlot !== 255)
  const known = withRecv.filter(e => byPid.has(e.receiverPlayerId))
  const slotAgree = withRecv.filter(e => bySlot.get(gslot(e.team, e.receiverPlayerSlot))?.playerId === e.receiverPlayerId)
  const sameTeam = known.filter(e => byPid.get(e.receiverPlayerId).team === e.team)
  const self = withRecv.filter(e => e.receiverPlayerId === e.playerId)
  const actorKnown = list.filter(e => byPid.has(e.playerId))
  const actorSlotAgree = list.filter(e => bySlot.get(gslot(e.team, e.playerSlot))?.playerId === e.playerId)
  return { events: list.length, withReceiverId: withRecv.length, receiverIdZeroOrSlot255: list.length - withRecv.length, receiverIdInRoster: known.length, receiverSlotMatchesId: slotAgree.length, receiverSameTeamAsPasser: sameTeam.length, receiverOppositeTeam: known.length - sameTeam.length, receiverIsPasser: self.length, actorIdInRoster: actorKnown.length, actorSlotMatchesId: actorSlotAgree.length }
}
// position-based test: distance from event trajectory end to receiver's position at completionTick
function endDistance(e: any, hypo: number) {
  const pts = e.trajectoryPoints ?? []; if (!pts.length) return null
  const end = pts.at(-1); const f = nearestFrame(e.completionTick || e.tick)
  const rs = byPid.get(e.receiverPlayerId)?.slot; const rec = f.players.find((p: any) => p.slot === rs); if (!rec) return null
  const [ex, ey] = hypo === 0 ? [end.lateralPosition, end.longitudinalPosition] : hypo === 1 ? [end.longitudinalPosition, end.lateralPosition] : hypo === 2 ? [-end.lateralPosition, -end.longitudinalPosition] : [-end.longitudinalPosition, -end.lateralPosition]
  return Math.hypot(rec.x - ex, rec.y - ey)
}
const median = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null
const axisTest: any = {}
for (const h of [0, 1, 2, 3]) axisTest['hypothesis' + h] = median(passes.filter(e => e.eventType === 7).map(e => endDistance(e, h)).filter((x): x is number => x != null))
axisTest.legend = { hypothesis0: 'player.x~lateral, player.y~longitudinal', hypothesis1: 'x~longitudinal,y~lateral', hypothesis2: 'x~-lateral,y~-longitudinal', hypothesis3: 'x~-longitudinal,y~-lateral' }
const byType: any = {}
for (const t of [7, 8, 9, 10, 11]) {
  const list = passes.filter(e => e.eventType === t)
  const wr = list.filter(e => e.receiverPlayerId !== 0 && e.receiverPlayerSlot !== 255)
  const dBest = wr.map(e => endDistance(e, 0)).filter((x): x is number => x != null)
  byType[t] = { ...recvStat(list), medianReceiverDistToTrajectoryEnd_h0: median(dBest), p90: dBest.length ? [...dBest].sort((a, b) => a - b)[Math.floor(dBest.length * 0.9)] : null, trajectoryPointsHist: hist(list, e => e.trajectoryPoints?.length ?? 'na') }
}
// receiver sees a pass receive event? does the receiver's later action start near completion? (not done)
const comp = passes.filter(e => e.eventType === 7)
R.receivers = {
  axisTestMedianDistanceMetres_receiverPositionVsTrajectoryEnd: axisTest,
  byEventType: byType,
  completedPassCoverage: { completed: comp.length, withValidReceiver: comp.filter(e => e.receiverPlayerId !== 0 && e.receiverPlayerSlot !== 255 && bySlot.get(gslot(e.team, e.receiverPlayerSlot))?.playerId === e.receiverPlayerId && e.receiverPlayerId !== e.playerId && byPid.get(e.receiverPlayerId)?.team === e.team).length },
  completedCoveragePerSide: Object.fromEntries(side.map(s => { const c = comp.filter(e => e.team === s); const v = c.filter(e => e.receiverPlayerId !== 0 && e.receiverPlayerSlot !== 255 && bySlot.get(gslot(e.team, e.receiverPlayerSlot))?.playerId === e.receiverPlayerId && e.receiverPlayerId !== e.playerId && byPid.get(e.receiverPlayerId)?.team === e.team); return [s, { completed: c.length, validReceiver: v.length, ratio: r2(v.length / c.length, 5) }] })),
  openPlayCompletedCoveragePerSide: Object.fromEntries(side.map(s => { const c = comp.filter(e => e.team === s && (e.flags & SETPIECE_BITS) === 0); const v = c.filter(e => e.receiverPlayerId !== 0 && byPid.get(e.receiverPlayerId)?.team === e.team && e.receiverPlayerId !== e.playerId); return [s, { completed: c.length, validReceiver: v.length, ratio: r2(v.length / c.length, 5) }] })),
  incompleteWithReceiverId: passes.filter(e => e.eventType !== 7 && e.receiverPlayerId !== 0).length,
  incompleteTotal: passes.filter(e => e.eventType !== 7).length,
  completedRevisions: ledger.filter(l => l.v.length > 1 && PASS.has(l.ev.eventType)).map(l => ({ seq: l.seq, versions: l.v.map(x => ({ type: x.e.eventType, flags: '0x' + x.e.flags.toString(16), recv: x.e.receiverPlayerId, firstFrameTick: x.firstFrameTick })) })).slice(0, 12),
}
// reception-coordinate availability for completed passes; receiver nodes without origin samples
{
  const withEnd = comp.filter(e => (e.trajectoryPoints?.length ?? 0) > 0)
  const originSlots = new Set(passes.filter(e => e.eventType === 7 || true).map(e => `${e.team}:${e.playerSlot}`))
  const recvNodes = new Set(comp.filter(e => e.receiverPlayerId !== 0).map(e => `${e.team}:${e.receiverPlayerSlot}`))
  const missingOrigin = [...recvNodes].filter(k => !originSlots.has(k))
  const trajHist = hist(comp, e => e.trajectoryPoints?.length ?? 0)
  const endEqualsNextOrigin = (() => { let tested = 0, ok = 0; for (const e of comp) { const nxt = passes.find(n => n.team === e.team && n.playerSlot === e.receiverPlayerSlot && n.tick >= e.completionTick && n.tick - e.completionTick <= 40); const pts = e.trajectoryPoints ?? []; if (nxt && pts.length) { tested++; const end = pts.at(-1); if (Math.hypot(end.lateralPosition - nxt.lateralPosition, end.longitudinalPosition - nxt.longitudinalPosition) < 3) ok++ } } return { tested, within3m: ok } })()
  R.receptionCoordinates = { completedPasses: comp.length, withTrajectoryEnd: withEnd.length, missingTrajectoryEnd: comp.length - withEnd.length, trajHist, receiverNodesTotal: recvNodes.size, receiverNodesWithNoPassOriginSample: missingOrigin,
    rosterPlayersWithNoPassEventAsPasser: players.filter(p => !passes.some(e => e.team === p.team && gslot(e.team, e.playerSlot) === p.slot)).map(p => `${p.displayName} (${p.team}, onPitchFrames=${pstat.get(p.slot).onPitchFrames})`),
    endEqualsNextOriginOfReceiver: endEqualsNextOrigin,
    receiverPositionAtCompletionAvailable: comp.filter(e => nearestFrame(e.completionTick).players.some((p: any) => p.slot === byPid.get(e.receiverPlayerId)?.slot && p.isOnPitch)).length,
    nearestFrameTickDistanceForCompletion: hist(comp, e => Math.min(10, Math.abs(nearestFrame(e.completionTick).tick - e.completionTick))) }
}

// ---------- I. coordinates / direction ----------
{
  const shots = evs.filter(e => e.eventType >= 1 && e.eventType <= 5)
  const goalOf = (s: string, p: number) => {
    // goalkeeper mean y per team per period (player coordinates), and the goal-mouth side from shots.
    const gk = players.find(q => q.team === s && q.position === 'GK' && pstat.get(q.slot).firstOnPitchTick === first.tick)
    const ys = frames.filter(f => f.period === p).map(f => f.players.find((q: any) => q.slot === gk.slot).y)
    return { gk: gk.displayName, meanY: r2(ys.reduce((a, b) => a + b, 0) / ys.length, 2) }
  }
  const dir: any = {}
  for (const s of side) for (const p of [1, 2]) {
    const sh = shots.filter(e => e.team === s && periodOfTick(e.tick) === p)
    dir[`${s}.p${p}`] = { gkMeanY_playerCoords: goalOf(s, p), shotCount: sh.length, shotLongitudinalMean: sh.length ? r2(sh.reduce((a, e) => a + e.longitudinalPosition, 0) / sh.length, 1) : null, shotLongitudinalSignHist: hist(sh, e => Math.sign(e.longitudinalPosition)), shotsFlag0x100Hist: hist(sh, e => (e.flags & 0x100) ? 'set' : 'unset') }
  }
  const passDir: any = {}
  for (const s of side) for (const p of [1, 2]) { const l = passes.filter(e => e.team === s && periodOfTick(e.tick) === p); passDir[`${s}.p${p}`] = { n: l.length, flag0x100: hist(l, e => (e.flags & 0x100) ? 'set' : 'unset') } }
  // does 0x100 flip within a period?
  const flagByTeamPeriodAllEvents: any = {}
  for (const s of side) for (const p of [1, 2]) { const l = evs.filter(e => e.team === s && periodOfTick(e.tick) === p); flagByTeamPeriodAllEvents[`${s}.p${p}`] = hist(l, e => (e.flags & 0x100) ? 'set' : 'unset') }
  // team-mean player y during open play vs period (average defensive y of outfield)
  const meanOutfieldY: any = {}
  for (const s of side) for (const p of [1, 2]) { const ys: number[] = []; for (const f of frames.filter(f => f.period === p)) for (const q of f.players) if (q.team === s && q.isOnPitch) ys.push(q.y); meanOutfieldY[`${s}.p${p}`] = r2(ys.reduce((a, b) => a + b, 0) / ys.length, 2) }
  R.direction = { shotsByTeamPeriod: dir, passFlag0x100ByTeamPeriod: passDir, flag0x100AllEvents: flagByTeamPeriodAllEvents, meanOnPitchPlayerY: meanOutfieldY,
    ballXYZCm: { xRange: [Math.min(...frames.map(f => f.ballXCentimeters)), Math.max(...frames.map(f => f.ballXCentimeters))], yRange: [Math.min(...frames.map(f => f.ballYCentimeters)), Math.max(...frames.map(f => f.ballYCentimeters))], zRange: [Math.min(...frames.map(f => f.ballZCentimeters)), Math.max(...frames.map(f => f.ballZCentimeters))] },
    goalEventPositions: evs.filter(e => e.eventType === 1).map(e => ({ team: e.team, tick: e.tick, period: periodOfTick(e.tick), lateral: r2(e.lateralPosition, 1), longitudinal: r2(e.longitudinalPosition, 1), flags: '0x' + e.flags.toString(16) })) }
}

// ---------- J. ground-pass availability ----------
{
  // ball Z during pass flight, from frames between tick and completionTick
  const zmax: number[] = []
  for (const e of comp.slice(0, 5000)) { const zs = frames.filter(f => f.tick >= e.tick && f.tick <= e.completionTick).map(f => f.ballZCentimeters); if (zs.length) zmax.push(Math.max(...zs)) }
  const z = zmax.sort((a, b) => a - b)
  R.groundPassAvailability = { explicitGroundOrAirField: 'none found in event schema (fields: eventType, flags, trajectoryPoints[lat,long only])', frameBallZPresent: frames.some(f => f.ballZCentimeters !== 0), completedPassesWithFramesDuringFlight: z.length, ballZMaxDuringFlightCmQuantiles: z.length ? { p10: z[Math.floor(z.length * .1)], p50: z[Math.floor(z.length * .5)], p90: z[Math.floor(z.length * .9)], p99: z[Math.floor(z.length * .99)], max: z.at(-1) } : null, flightFramesPerPassHist: hist(comp.slice(0, 5000), e => Math.min(8, frames.filter(f => f.tick >= e.tick && f.tick <= e.completionTick).length)) }
}

// ---------- K. role / formation / ratings / subs / aerials ----------
{
  const roleChanges: any[] = []
  for (let i = 1; i < timeline.length; i++) {
    for (const p of timeline[i].players) {
      const q = timeline[i - 1].players.find((x: any) => x.slot === p.slot)
      if (!q) { roleChanges.push({ rev: i, capturedTick: timeline[i].capturedTick, slot: p.slot, name: p.displayName, change: 'player added' }); continue }
      for (const k of ['inPossession', 'outOfPossession'] as const) if (JSON.stringify(q[k]) !== JSON.stringify(p[k])) roleChanges.push({ rev: i, capturedTick: timeline[i].capturedTick, slot: p.slot, name: p.displayName, team: p.team, which: k, from: q[k] ? `${q[k].position}/${q[k].role}/${q[k].duty}` : null, to: p[k] ? `${p[k].position}/${p[k].role}/${p[k].duty}` : null })
      if (q.position !== p.position) roleChanges.push({ rev: i, capturedTick: timeline[i].capturedTick, slot: p.slot, name: p.displayName, which: 'position', from: q.position, to: p.position })
    }
  }
  R.roles = { revisionCount: timeline.length, revisionTicks: timeline.map(m => m.capturedTick), changes: roleChanges }
  R.ratings = {
    finalRatings: last.players.filter((p: any) => pstat.get(p.slot).onPitchFrames > 0).map((p: any) => ({ slot: p.slot, name: bySlot.get(p.slot).displayName, team: p.team, rating: r2(p.rating, 2) })),
    ratingFirstFrameRange: [Math.min(...first.players.map((p: any) => p.rating)), Math.max(...first.players.map((p: any) => p.rating))],
    archiveRatingInputsPresentOnLastFrame: last.players.filter((p: any) => p.archiveRatingInputs).length, ratingModelOnLastFrame: !!last.ratingModel,
    ratingModelMetadata: last.ratingModel ? { activeBaseline: last.ratingModel.activeBaseline, homeBackgroundInput: last.ratingModel.homeBackgroundInput, awayBackgroundInput: last.ratingModel.awayBackgroundInput } : null,
    framesWithRatingModel: frames.filter(f => f.ratingModel).length,
  }
  R.aerialsAndProgressive = Object.fromEntries(players.filter(p => pl(p.slot).aerials > 0 || pl(p.slot).progressivePasses > 0).map(p => [p.displayName, { team: p.team, aerials: pl(p.slot).aerials, aerialsWon: pl(p.slot).aerialsWon, progressivePasses: pl(p.slot).progressivePasses, passes: pl(p.slot).passes, shots: pl(p.slot).shots, xg: r2(pl(p.slot).xg ?? 0, 3) }]))
  R.playerCounterMonotonic = (() => { const bad: Record<string, number> = {}; for (let i = 1; i < frames.length; i++) for (let j = 0; j < frames[i].players.length; j++) { const a = frames[i - 1].players[j], b = frames[i].players[j]; for (const k of ['passes', 'passesCompleted', 'aerials', 'aerialsWon', 'progressivePasses', 'shots', 'keyPasses', 'crosses']) if (b[k] < a[k]) bad[k] = (bad[k] ?? 0) + 1 } return bad })()
  R.shotEvents = { byType: hist(evs.filter(e => e.eventType >= 1 && e.eventType <= 5), e => `${e.team}:${e.eventType}`), types: '1 goal,2 off target,3 woodwork,4 on target,5 blocked (upstream mapping)' }
}


// ---------- M. extra: next-actor consistency, clock/minute labels, minutes played, counter timing ----------
{
  // (1) completed pass: is the next recorded same-team actor (any pass/cross/shot event) the receiver?
  const actions = evs.filter(e => (e.eventType >= 1 && e.eventType <= 17)).sort((a, b) => a.tick - b.tick || a.sequenceIndex - b.sequenceIndex)
  let tested = 0, same = 0, sameWithin = 0
  for (const e of comp) {
    const nxt = actions.find(n => n.team === e.team && n.tick >= e.completionTick && n.sequenceIndex !== e.sequenceIndex)
    if (!nxt) continue
    tested++
    if (nxt.playerId === e.receiverPlayerId) { same++; if (nxt.tick - e.completionTick <= 40) sameWithin++ }
  }
  R.receivers.nextActorConsistency = { completedPassesTested: tested, nextSameTeamActionByReceiver: same, ratio: r2(same / tested, 4), withinTenSecondsOf240tpm: sameWithin }
  // (2) sub boundaries vs minute labels
  const flips: any[] = []
  for (const p of players) for (const t of pstat.get(p.slot).onPitchTransitions) if (t.tick > first.tick) {
    const f = frames.find(fr => fr.tick === t.tick)
    flips.push({ name: p.displayName, team: p.team, on: t.on, tick: t.tick, period: t.period, displayTick: t.display, displayMinute: r2(t.display / 240, 2), floorPlus1: Math.floor(t.display / 240) + 1, label: t.on ? f.players.find((q: any) => q.slot === p.slot).subbedOnMinute : f.players.find((q: any) => q.slot === p.slot).subbedOffMinute })
  }
  R.clock = { transitions: flips.sort((a, b) => a.tick - b.tick), labelEqualsFloorPlus1: flips.filter(f => f.label === f.floorPlus1).length, labelEqualsFloor: flips.filter(f => f.label === Math.floor(f.displayMinute)).length, total: flips.length,
    sameTickBatches: hist(flips, f => f.tick + ':' + f.team) }
  // (3) minutes on pitch per player: sum of tick deltas inside a period while isOnPitch at the earlier frame
  const mins = new Map<number, number>()
  for (let i = 1; i < frames.length; i++) { if (frames[i].period !== frames[i - 1].period) continue; const dt = frames[i].tick - frames[i - 1].tick; for (const p of frames[i - 1].players) if (p.isOnPitch) mins.set(p.slot, (mins.get(p.slot) ?? 0) + dt) }
  R.minutesPlayedFromTicks = Object.fromEntries([...mins.entries()].map(([slot, t]) => [bySlot.get(slot).displayName, r2(t / 240, 2)]))
  R.clock.periodTickSpanMinutes = perStats.map(p => ({ period: p.period, minutes: r2((p.lastTick - p.firstTick) / 240, 2) }))
  R.clock.perPlayerMinutesSumPerSide = Object.fromEntries(side.map(sd => [sd, r2(players.filter(p => p.team === sd).reduce((a, p) => a + (mins.get(p.slot) ?? 0), 0) / 240, 2)]))
  // (4) counter timing vs event ticks (team passes excl 0x8)
  const pe = (sd: string) => evs.filter(e => e.team === sd && PASS.has(e.eventType) && !(e.flags & 8)).sort((a, b) => a.tick - b.tick)
  const timing: any = {}
  for (const sd of side) {
    const L = pe(sd); const byTick = [...L].sort((a, b) => a.tick - b.tick); const byComp = [...L].sort((a, b) => a.completionTick - b.completionTick)
    let i = 0, j = 0, eqTick = 0, eqComp = 0, maxDiffTick = 0, maxDiffComp = 0
    for (const f of frames) {
      while (i < byTick.length && byTick[i].tick <= f.tick) i++
      while (j < byComp.length && byComp[j].completionTick <= f.tick) j++
      const c = f[sd].passes
      if (c === i) eqTick++; if (c === j) eqComp++
      maxDiffTick = Math.max(maxDiffTick, Math.abs(c - i)); maxDiffComp = Math.max(maxDiffComp, Math.abs(c - j))
    }
    const p1last = frames.filter(f => f.period === 1).at(-1)
    timing[sd] = { framesEqualCounterAndEventsByStartTick: eqTick, framesEqualCounterAndEventsByCompletionTick: eqComp, framesTotal: frames.length, maxAbsDiffStartTick: maxDiffTick, maxAbsDiffCompletionTick: maxDiffComp,
      atEndOfPeriod1: { counterPasses: p1last[sd].passes, eventAttempts: L.filter(e => e.tick <= p1last.tick).length, counterCompleted: p1last[sd].passesCompleted, eventCompleted: L.filter(e => e.tick <= p1last.tick && e.eventType === 7).length } }
  }
  R.counterTiming = timing
}


// ---------- N. event-type mapping checks, upstream passMap behaviour, bench positions ----------
{
  const sumP = (sd: string, k: string) => players.filter(p => p.team === sd).reduce((a, p) => a + (pl(p.slot)[k] ?? 0), 0)
  const cnt = (sd: string, ...ts: number[]) => evs.filter(e => e.team === sd && ts.includes(e.eventType)).length
  const checks: Record<string, any> = {}
  const mk = (name: string, types: number[], playerKey: string | null, teamKey: string | null) => { checks[name] = Object.fromEntries(side.map(sd => [sd, { events: cnt(sd, ...types), playerCounterSum: playerKey ? sumP(sd, playerKey) : null, teamCounter: teamKey ? (last[sd] as any)[teamKey] : null }])) }
  mk('fouls_type19', [19], 'fouls', 'fouls'); mk('fouled_type18', [18], 'fouled', null); mk('offsides_type23', [23], null, 'offsides')
  mk('tacklesWon_type26', [26], 'tacklesWon', 'tacklesWon'); mk('tacklesWon_26plus45', [26, 45], 'tacklesWon', 'tacklesWon'); mk('tacklesAttempted_26_27', [26, 27], 'tacklesAttempted', 'tacklesAttempted'); mk('tacklesAttempted_26_27_45', [26, 27, 45], 'tacklesAttempted', 'tacklesAttempted')
  mk('keyTackles_type45', [45], 'keyTackles', null); mk('clearances_type24', [24], 'clearances', null); mk('interceptions_type31', [31], 'interceptions', null); mk('dribbles_type34', [34], 'dribbles', null)
  mk('shotsOnTarget_4_plus_goals1', [1, 4], null, 'shotsOnTarget'); mk('shotsOff_type2', [2], null, 'shotsOffTarget'); mk('blocked_type5', [5], null, 'blockedShots'); mk('woodwork_type3', [3], 'hitWoodwork', null); mk('shots_1to5', [1, 2, 3, 4, 5], 'shots', 'shots'); mk('goals_type1', [1], 'goals', 'goals'); mk('ownGoal_49', [49], 'ownGoals', null)
  mk('clearCutChance_35', [35], 'clearCutChances', 'clearCutChances'); mk('penalty_22', [22], 'penalties', null)
  R.eventTypeMappingChecks = checks
  // upstream buildPassMap replica: open-play (flags & 0x78 == 0), passer and receiver must be isOnPitch at the LAST frame; counts every pass with receiver id regardless of completion
  const onEnd = new Set(last.players.filter((p: any) => p.isOnPitch).map((p: any) => p.playerId))
  for (const sd of side) {
    const open = passes.filter(e => e.team === sd && !(e.flags & SETPIECE_BITS))
    const upstreamEdges = open.filter(e => e.receiverPlayerId !== 0 && e.receiverPlayerId !== e.playerId && onEnd.has(e.playerId) && onEnd.has(e.receiverPlayerId))
    const allCompletedOpenWithRecv = open.filter(e => e.eventType === 7 && e.receiverPlayerId !== 0)
    ;(R.upstreamPassMapComparison ??= {})[sd] = { openPlayPassEvents: open.length, openPlayCompletedWithReceiver: allCompletedOpenWithRecv.length, edgeCountSumUpstreamLogic_lastFrameOnPitchOnly: upstreamEdges.length, droppedBecausePasserOrReceiverNotOnPitchAtEnd: allCompletedOpenWithRecv.length - upstreamEdges.length, incompletePassesCountedAsEdgeByUpstreamLogic: upstreamEdges.filter(e => e.eventType !== 7).length }
  }
  // bench positions
  const neverOn = players.filter(p => pstat.get(p.slot).onPitchFrames === 0)
  R.benchPositions = neverOn.map(p => { const ys = frames.map(f => f.players.find((q: any) => q.slot === p.slot)); const xs = ys.map((q: any) => q.x), yy = ys.map((q: any) => q.y); return { name: p.displayName, team: p.team, distinctXY: new Set(ys.map((q: any) => q.x + ',' + q.y)).size, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...yy), Math.max(...yy)] } })
  // last frame state
  R.endState = { lastFramePossession: last.possessionTeam, lastEventTick: Math.max(...evs.map(e => e.tick)), lastTick: last.tick, lastEventsTicksWithin10OfEnd: evs.filter(e => e.tick >= last.tick - 10).length, ballXYCmLast: [last.ballXCentimeters, last.ballYCentimeters], ballHolderLast: last.ballHolderPlayerId ?? null }
}


{
  R.xgReconciliation = Object.fromEntries(side.map(sd => { const ps = players.filter(p => p.team === sd).reduce((a, p) => a + (pl(p.slot).xg ?? 0), 0); const xa = players.filter(p => p.team === sd).reduce((a, p) => a + (pl(p.slot).xa ?? 0), 0); return [sd, { teamXg: last[sd].xg, sumPlayerXg: ps, absDiff: Math.abs(ps - last[sd].xg), sumPlayerXa: xa, float32Epsilon: 1.19e-7 }] }))
  R.possession = { homePossessionTime: last.home.possessionTime, awayPossessionTime: last.away.possessionTime, sum: last.home.possessionTime + last.away.possessionTime, lastTick: last.tick, sumOverTicks: (last.home.possessionTime + last.away.possessionTime) / (last.tick - first.tick), note: 'possessionTime units not established; ratio sum/ticks reported only' }
}

// ---------- L. recipient gate (§7.2) ----------
{
  const gate = (s: 'home' | 'away') => {
    const rc = R.receivers.completedCoveragePerSide[s], rcOP = R.receivers.openPlayCompletedCoveragePerSide[s]
    return { receiverCoverageAllCompleted: rc.ratio, receiverCoverageOpenPlayCompleted: rcOP.ratio, coverageMeets95: rc.ratio >= 0.95,
      reconcile: { counterPasses: last[s].passes, eventPasses: sideCounts[s].events.pass6to11, eventPassesPlusCrosses: sideCounts[s].events.pass6to17, counterCompleted: last[s].passesCompleted, eventCompleted: sideCounts[s].events.pass7, eventCompletedPlusCrossCompleted: sideCounts[s].events.pass7plus12 } }
  }
  R.recipientGateInputs = { home: gate('home'), away: gate('away'), note: 'Pass/fail judgement is in docs/data-coverage.md; this block only lists measured inputs.' }
}

writeFileSync(resolve(outDir, 'audit.json'), JSON.stringify(R, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1))
console.log(`audit written to ${resolve(outDir, 'audit.json')}`)
for (const k of Object.keys(R)) console.log(`  section: ${k}`)
