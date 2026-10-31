// Reduce audit-output/audit.json to a numeric, name-free, frame-free golden summary (commit-safe).
// Usage: node scripts/audit/sanitize.mts audit-output/audit.json tests/fixtures/farnham-torquay-0-3.summary.json
import { readFileSync, writeFileSync } from 'node:fs'
const [inp, out] = [process.argv[2] ?? 'audit-output/audit.json', process.argv[3] ?? 'tests/fixtures/farnham-torquay-0-3.summary.json']
const R = JSON.parse(readFileSync(inp, 'utf8'))
const S = {
  _about: 'Numeric golden summary of one real FM27 recording (FMMatchLens v0.7.0, format 2.8). No names, no frames, no coordinates. Produced by scripts/audit/audit.mts + sanitize.mts. Values are MEASURED unless a key says otherwise.',
  archive: { sha256: R.integrity.sha256, sizeBytes: R.integrity.sizeBytes, structure: R.integrity.structure, recordTypeCounts: R.integrity.recordTypeCounts, blockCount: R.integrity.blockCount, frameCount: R.integrity.parsedFrameCount, metadataRevisions: R.integrity.metadataRevisions, endRecordPresent: R.integrity.endRecordPresent, bytesAfterEndRecord: R.integrity.bytesAfterEndRecord, parserOk: R.parse.ok },
  time: { firstTick: R.time.firstTick, lastTick: R.time.lastTick, periods: R.time.periods.map((p: any) => ({ period: p.period, frames: p.frames, firstTick: p.firstTick, lastTick: p.lastTick, firstDisplay: p.firstDisplay, lastDisplay: p.lastDisplay, tickMinusDisplay: p.tickMinusDisplayFirst })), missingTicksTotal: R.time.missingTicksTotal, gapsCount: R.time.gapsCount, goalTransitions: R.time.goalTransitions, ticksPerMinute240Consistent: R.clock.labelEqualsFloorPlus1 },
  teamFinal: R.team.final,
  shotsOnPlusOffPlusBlocked: R.team.shotsOnPlusOffPlusBlocked,
  identity: { players: R.identity.metadataPlayerCount, perSide: R.identity.perSide, uidNull: R.identity.uidNull, playerIdEqualsUid: R.identity.playerIdEqualsUid, homeSlots: R.identity.homeSlots, awaySlots: R.identity.awaySlots, humanSide: R.team.humanSide },
  events: { uniqueSequenceIndexes: R.events.uniqueSequenceIndexes, typeHist: R.events.typeHist, versionsPerSequence: R.events.versionsPerSequence, changedFieldsAcrossRevisions: R.events.changedFieldsAcrossRevisions },
  passReconciliation: R.passReconciliation,
  receivers: { completedCoveragePerSide: R.receivers.completedCoveragePerSide, incompleteWithReceiverId: R.receivers.incompleteWithReceiverId, incompleteTotal: R.receivers.incompleteTotal, nextActorConsistency: R.receivers.nextActorConsistency, axisTestMedianDistanceMetres: R.receivers.axisTestMedianDistanceMetres_receiverPositionVsTrajectoryEnd },
  substitutions: R.clock.transitions.map((t: any) => ({ team: t.team, on: t.on, tick: t.tick, period: t.period, displayTick: t.displayTick, label: t.label })),
  perSlotCounters: R.playerEventReconciliation.rows.map((r: any) => ({ slot: r.slot, team: r.team, counter: r.counter, events: r.events })),
  direction: R.direction.passFlag0x100ByTeamPeriod,
  playerEventReconciliation: Object.fromEntries(Object.entries(R.playerEventReconciliation).filter(([k]) => k.startsWith('playersWhere'))),
}
writeFileSync(out, JSON.stringify(S, null, 1))
console.log('wrote', out)
