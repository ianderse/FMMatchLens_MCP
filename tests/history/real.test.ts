// Slice 4 on the one real recording (Farnham 0-3 Torquay, display clock 87.6 minutes, 88.6 captured on-pitch minutes). Reads tests/fixtures/local/ (gitignored) and
// reports a skip when the file is absent. Catalogs are FMMI_HOME-isolated temporary directories. The single second match used for
// the identity step is a LABELLED SYNTHETIC archive written to a temporary directory (never the fixture directory); it reuses one
// uid and display name read from the real roster at run time so that "the same player in two matches" can be shown.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { HAS_REAL, REAL_FIXTURE, cleanupAll, service } from '../support/helpers.ts'
import { defaultPlayers } from '../support/syntheticArchive.ts'
import { writeSynth } from '../support/season.ts'

afterAll(cleanupAll)

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')

describe.skipIf(!HAS_REAL)('Slice 4 on the real recording', () => {
  let svc: ReturnType<typeof service>
  let q: MatchQueries
  let saveId = '', matchId = '', revisionId = '', teamId = ''
  const sizes: Record<string, number> = {}
  beforeAll(async () => {
    svc = service()
    saveId = svc.createSave('Farnham Town').saveId
    const r = await svc.ingestFile(REAL_FIXTURE, saveId)
    expect(r.status).toBe('ingested')
    matchId = r.matchId!; revisionId = r.recordingRevisionId!
    q = new MatchQueries(svc)
    teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
  }, 120_000)
  afterAll(() => { console.log('SLICE 4 REAL OUTPUT SIZES (bytes):', JSON.stringify(sizes)); svc.close() })

  it('AC the real recording stays match_local until a second match exists: no persistent player, every reason is a single match', () => {
    const list = q.listPlayers({ saveId, limit: 50 })
    expect(list.summary).toEqual({ persistent: 0, linked: 0, matchLocal: 36 })
    expect(list.players).toHaveLength(36)
    expect(list.players.every((p) => p.identityStatus === 'match_local' && String((p as { reason: string }).reason) === 'single_match_uid' && p.playerId.startsWith('p_'))).toBe(true)
    sizes.list_players = bytes(list)
    expect(sizes.list_players).toBeLessThan(20 * 1024)
  })

  it('AC a match-local identity from the real recording is excluded from get_player_trends and listed', async () => {
    const roster = svc.showMatch(matchId).roster
    const striker = roster.find((p) => p.side === 'home' && p.participation.status === 'played')!
    const r = await q.playerTrends({ saveId, playerIds: [striker.playerId] })
    expect(r.players).toEqual([])
    expect(r.excludedIdentities).toEqual([{ playerId: striker.playerId, identity: 'match_local', reason: 'match_local_identity', identityNote: 'single_match_uid', persistentPlayerId: null }])
    expect(r.groundService).toMatchObject({ value: null, nullReason: 'not_recorded' })
  })

  it('AC unconfirmed, the real match is excluded with a reason and shown only by the explicit partial opt-in', async () => {
    const r = await q.seasonTrends({ saveId, teamId })
    expect(r.eligibleMatches).toBe(0)
    expect(r.excluded).toEqual([{ matchId, date: '2026-08-31', reasons: ['completion_unknown'] }])
    expect(r.windows.every((w) => w.matchIds.length === 0)).toBe(true)
    expect(r.coverage).toBe('unavailable')
    expect(r.warnings.some((w) => w.startsWith('no_eligible_matches'))).toBe(true)
    const p = await q.seasonTrends({ saveId, teamId, includePartial: true })
    expect(p.partial!.matches).toHaveLength(1)
    expect(p.partial!.matches[0]).toMatchObject({ matchId, completion: 'unknown' })
    expect(p.partial!.matches[0]!.capturedMinutes).toBeCloseTo(88.6, 1)
    expect(p.windows.every((w) => w.matchIds.length === 0)).toBe(true) // never mixed into the comparison
  })

  it('AC once confirmed, it is included in the rates as an early-ending recording and left out of the totals; the manual score is labelled manual', async () => {
    svc.confirmMatch(matchId, '0-3')
    const r = await q.seasonTrends({ saveId, teamId, lastN: 5 })
    sizes.get_season_trends = bytes(r)
    expect(sizes.get_season_trends).toBeLessThan(20 * 1024)
    expect(r.eligibleMatches).toBe(1)
    const w = r.windows[0]!
    expect(w.matchIds).toEqual([matchId])
    expect(r.matches[0]).toMatchObject({ matchId, recordingRevisionId: revisionId, side: 'home', class: 'early_ending', disclosures: ['manual_confirmation', 'early_ending'] })
    expect(r.matches[0]!.score).toEqual({ for: 0, against: 3, basis: 'manual', outcome: 'loss' })
    expect(r.matches[0]!.capturedMinutes).toBeGreaterThanOrEqual(80)
    expect(r.matches[0]!.capturedMinutes).toBeCloseTo(88.6, 1)
    expect(w.totals.matches).toBe(0)
    expect(w.totals.excludedFromTotals).toEqual([{ matchId, reason: 'early_ending_unseen_time' }])
    // the rate uses the measured minutes of the recording (87.6), never a nominal 90
    const against = w.rates.find((x) => x.metric === 'goals_against_per_90')!
    const show = svc.showMatch(matchId)
    const minutes = show.status.coverage.periods.reduce((a, p) => a + (p.lastTick - p.firstTick), 0) / 240
    expect(against.numerator).toBe(3) // observed Torquay goals, documented in docs/data-coverage.md
    expect(against.denominator).toBeCloseTo(minutes, 9)
    expect(against.value).toBeCloseTo((90 * 3) / minutes, 9)
    expect(w.rates.find((x) => x.metric === 'goals_per_90')!.numerator).toBe(0)
    expect(r.coverage).toBe('partial_for_window')
    expect(r.warnings.some((x) => x.startsWith('early_ending_matches_in_rates'))).toBe(true)
    // the partial block disappears when nothing partial is excluded
    expect((await q.seasonTrends({ saveId, teamId, includePartial: true })).partial!.matches).toEqual([])
  })

  it('AC with a second match that shares one verified uid and name, exactly that player becomes persistent; the other 35 stay match-local', async () => {
    const roster = svc.showMatch(matchId).roster
    const real = roster.find((p) => p.side === 'home' && p.participation.status === 'played' && p.upstream.uid !== null && p.upstream.uid > 0)!
    const players = defaultPlayers().map((p) => (p.slot === 5 ? { ...p, name: real.name, uid: real.upstream.uid } : p))
    const file = writeSynth({ upstreamMatchId: 'match-synth-second', matchDate: '2026-09-07', homeName: 'Synthetic Second FC', awayName: 'Synthetic Third FC', homeUid: 31, awayUid: 32, players }, 'second.fmlens')
    const r = await svc.ingestFile(file, saveId)
    expect(r.status).toBe('ingested')
    const list = q.listPlayers({ saveId, limit: 50, nameQuery: real.name })
    const hits = list.players.filter((p) => p.name === real.name)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ identityStatus: 'persistent', matches: 2, uid: real.upstream.uid, supportingMatchesTotal: 2 })
    expect((hits[0] as { supportingMatchIds: string[] }).supportingMatchIds.slice().sort()).toEqual([matchId, r.matchId!].sort())
    expect(q.listPlayers({ saveId, limit: 50 }).summary.persistent).toBe(1)
    expect(q.listPlayers({ saveId, limit: 50 }).summary.matchLocal).toBe(36 + 28 - 2)

    // the persistent player pools over the real match only: the second match is unconfirmed
    const pe = (hits[0] as { playerId: string }).playerId
    const t = await q.playerTrends({ saveId, playerIds: [pe], lastN: 5 })
    sizes.get_player_trends = bytes(t)
    expect(sizes.get_player_trends).toBeLessThan(20 * 1024)
    expect(t.players[0]!.windows[0]!.matchIds).toEqual([matchId])
    expect(t.players[0]!.excluded).toEqual([{ matchId: r.matchId, date: '2026-09-07', reasons: ['completion_unknown'] }])
    // receiver-based metrics respect the per-recording section 7.2 gate (whatever it measured on this recording)
    const gate = (await q.summary(matchId)).summary.evidenceQuality.recipientGate.home.status
    const recv = t.players[0]!.windows[0]!.rates.find((x) => x.metric === 'passes_received_per_90')!
    if (gate === 'pass') expect(recv.contributing.matches).toBe(1)
    else expect(recv.excluded).toEqual([{ matchId, reason: 'recipient_gate_failed' }])
  }, 120_000)

  it('AC a note on the real recording resolves its minute, and a single-match comparison says so within 20 KB', async () => {
    const n = await svc.addNote(matchId, { minute: 60, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Positive' })
    expect(n).toMatchObject({ side: 'home', period: 2, confidence: 'manual' })
    const notes = q.tacticalNotes({ saveId, matchId })
    sizes.get_tactical_notes = bytes(notes)
    expect((notes.observedFormationChanges as { source: string }).source).toBe('observed_by_plugin')
    expect(sizes.get_tactical_notes).toBeLessThan(20 * 1024)
    const c = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId })
    sizes.compare_tactical_change = bytes(c)
    expect(sizes.compare_tactical_change).toBeLessThan(20 * 1024)
    expect(c.singleMatchComparison).toBe(true)
    expect(c.within.status).toBe('available')
    expect(c.within.windows!.before.minutes + c.within.windows!.after.minutes).toBeCloseTo(88.6, 1)
    expect(c.within.playersOnPitch).toHaveLength(11)
    expect(c.statements.join(' ')).toMatch(/single-match comparison/)
  }, 120_000)
})
