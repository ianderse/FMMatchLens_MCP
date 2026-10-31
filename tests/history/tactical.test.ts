// Slice 4 acceptance: tactical notes (local, immutable, manual), the before/after comparison, club aliases and managed-team detection.
// Labelled synthetic recordings; isolated catalogs only.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { cleanupAll, service } from '../support/helpers.ts'
import { FIVE, confirmObserved, ingestOne, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

const CAUSAL = /\b(because|caused|causes|due to|led to|leads to|thanks to|as a result|resulted in|impact|improved|improves|improvement|worked|effect of)\b/i
const prose = (r: { statements?: string[]; warnings?: string[]; label?: unknown }) => [...(r.statements ?? []), ...(r.warnings ?? [])].join('\n')

// f3 carries a plugin-observed role change for the playmaker (player index 3 of the club side, home here).
const SPECS: SeasonMatch[] = FIVE.map((s) => (s.key === 'f3'
  ? { ...s, synth: { roleChanges: [{ capturedTick: 9000, playerId: 1003, position: 'AMC', role: 'Advanced Playmaker', duty: 'Support' }] } }
  : s))

describe('Slice 4: tactical notes and the comparison', () => {
  let svc: ReturnType<typeof service>
  let saveId: string, teamId: string
  let ids: Awaited<ReturnType<typeof ingestSeason>>
  let q: MatchQueries
  beforeAll(async () => {
    svc = service()
    saveId = svc.createSave('Synthetic Town').saveId
    ids = await ingestSeason(svc, saveId, SPECS)
    for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
    q = new MatchQueries(svc)
    teamId = q.listMatches({ saveId }).matches[0]!.managedTeamId!
  }, 120_000)

  it('AC a user-entered tweak is clearly distinguished from observed formation changes', async () => {
    const n = await svc.addNote(ids.f3!.matchId, { minute: 60, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Positive', comment: 'Pushed up after the break' })
    const r = q.tacticalNotes({ saveId, matchId: ids.f3!.matchId })
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toMatchObject({
      noteId: n.noteId, saveId, matchId: ids.f3!.matchId, teamId, side: 'home', minute: 60, period: 2, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Positive',
      confidence: 'manual', source: 'user_entered', status: 'current', supersedes: null, supersededBy: null,
    })
    expect(r.label).toMatch(/FMMatchLens did not record this change; it is not an observed formation change/)
    const obs = r.observedFormationChanges as { source: string; players: Array<{ name: string; changes: Array<Record<string, unknown>> }> }
    expect(obs.source).toBe('observed_by_plugin')
    expect(obs.players.map((p) => p.name)).toContain('Jack Spong')
    // the two are separate: no note text in the observed block and no plugin role text in the notes
    expect(JSON.stringify(obs)).not.toContain('Mentality')
    expect(JSON.stringify(r.notes)).not.toContain('Advanced Playmaker')
    expect(JSON.stringify(obs)).toContain('Advanced Playmaker')
    // without a matchId the observed block is not mixed in at all
    expect(q.tacticalNotes({ saveId }).observedFormationChanges).toBeNull()
  })

  it('AC notes are immutable: a correction is a superseding note with an audit trail, and the database refuses an edit or a delete', async () => {
    const first = (await q.tacticalNotes({ saveId, matchId: ids.f3!.matchId })).notes[0]!
    const second = await svc.supersedeNote(first.noteId, { minute: 62, newValue: 'Very positive' })
    expect(second).toMatchObject({ supersedesNoteId: first.noteId, minute: 62, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Very positive', confidence: 'manual' })
    const r = q.tacticalNotes({ saveId, matchId: ids.f3!.matchId })
    expect(r.notes.map((x) => [x.noteId, x.status])).toEqual([[first.noteId, 'superseded'], [second.noteId, 'current']])
    expect(r.notes[0]).toMatchObject({ supersededBy: second.noteId })
    expect(r.notes[1]).toMatchObject({ supersedes: first.noteId })
    expect(r.notes[0]!.newValue).toBe('Positive') // the original text is intact
    await expect(svc.supersedeNote(first.noteId, { minute: 70 })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'already_superseded', supersededBy: second.noteId } })
    await expect(svc.supersedeNote(second.noteId, {})).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'usage' } })
    const audit = svc.store.listAudit().filter((a) => a.subjectType === 'tactical_note')
    expect(audit.map((a) => a.action)).toEqual(['note.add', 'note.supersede'])
    expect(audit[1]!.details).toMatchObject({ supersedes: first.noteId, changedFields: ['minute', 'newValue'], matchId: ids.f3!.matchId })
    const raw = new Database(join(svc.config.home, 'catalog.sqlite'))
    try {
      expect(() => raw.prepare('UPDATE tactical_note SET new_value = ? WHERE note_id = ?').run('edited', first.noteId)).toThrowError(/immutable/)
      expect(() => raw.prepare('DELETE FROM tactical_note WHERE note_id = ?').run(first.noteId)).toThrowError(/immutable/)
      expect(() => raw.prepare(`INSERT INTO tactical_note (note_id, match_id, recording_revision_id, side, minute, setting, prior_value, new_value, confidence, created_at)
        VALUES ('n_x', ?, ?, 'home', 5, 's', 'a', 'b', 'observed', 'now')`).run(ids.f3!.matchId, ids.f3!.revisionId)).toThrowError(/CHECK/)
    } finally { raw.close() }
    // pagination is stable and bounded
    const p1 = q.tacticalNotes({ saveId, limit: 1 })
    expect(p1.page).toMatchObject({ returned: 1, totalMatching: 2, truncated: true })
    const p2 = q.tacticalNotes({ saveId, limit: 1, cursor: p1.page.nextCursor! })
    expect([p1.notes[0]!.noteId, p2.notes[0]!.noteId]).toEqual([first.noteId, second.noteId])
    expect(p2.page.nextCursor).toBeNull()
  })

  it('AC a note minute is validated against the recording: ambiguous stoppage-time labels need a period, out-of-range minutes and empty fields are refused', async () => {
    const base = { setting: 'Line of engagement', priorValue: 'Standard', newValue: 'Higher' }
    await expect(svc.addNote(ids.f1!.matchId, { ...base, minute: 45.5 })).rejects.toMatchObject({ code: 'ambiguous_selection' })
    await expect(svc.addNote(ids.f1!.matchId, { ...base, minute: 400 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(svc.addNote(ids.f1!.matchId, { ...base, minute: -1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(svc.addNote(ids.f1!.matchId, { ...base, minute: 30, setting: '  ' })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'note_field' } })
    const ok = await svc.addNote(ids.f1!.matchId, { ...base, minute: 45.5, period: 2 })
    expect(ok.period).toBe(2)
    await expect(svc.addNote('m_nope', { ...base, minute: 30 })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('AC the comparison reports per-90 rates before and after within the match and pooled across the matches before and after, with context and an observational warning', async () => {
    const n = await svc.addNote(ids.f3!.matchId, { minute: 30, setting: 'Pressing', priorValue: 'Standard', newValue: 'More urgent' })
    const r = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId, matchesBefore: 3, matchesAfter: 3 })
    expect(r.singleMatchComparison).toBe(false)
    expect(r.note).toMatchObject({ noteId: n.noteId, confidence: 'manual', source: 'user_entered' })
    const across = r.across as unknown as { status: string; before: { matches: Array<{ matchId: string; recordingRevisionId: string }>; rates: Array<{ metric: string }>; opponents: string[] }; after: { matches: Array<{ matchId: string }>; opponents: string[] }; deltas: unknown[]; confounders: string[] }
    expect(across.status).toBe('available')
    expect(across.before.matches.map((m) => m.matchId)).toEqual([ids.f1!.matchId, ids.f2!.matchId]) // the match with the change belongs to neither set
    expect(across.after.matches.map((m) => m.matchId)).toEqual([ids.f4!.matchId, ids.f5!.matchId])
    expect(across.before.matches.map((m) => m.recordingRevisionId)).toEqual([ids.f1!.revisionId, ids.f2!.revisionId])
    expect(across.before.opponents).toEqual(['Horsham Rovers', 'Torquay Athletic'])
    expect(across.deltas).toHaveLength(across.before.rates.length)
    expect(across.confounders).toEqual(expect.arrayContaining(['opposition_strength_unavailable']))
    // within the match
    expect(r.within.status).toBe('available')
    const w = r.within.windows!
    const shows = svc.showMatch(ids.f3!.matchId)
    const teamMinutes = shows.status.coverage.periods.reduce((a, p) => a + (p.lastTick - p.firstTick), 0) / 240
    expect(w.before.minutes + w.after.minutes).toBeCloseTo(teamMinutes, 6)
    expect(r.within.boundary).toMatch(/^1:\d+$/)
    expect(r.within.rates.map((x) => x.metric)).toEqual(expect.arrayContaining(['goals', 'xg', 'shots', 'passes_completed', 'progressive_passes', 'pass_completion_pct']))
    const g = r.within.rates.find((x) => x.metric === 'shots')!
    expect(g.delta).toBeCloseTo(g.after! - g.before!, 9)
    expect(r.within.scoreState).not.toBeNull()
    expect(r.within.playersOnPitch.map((p) => p.name)).toContain('George Alexander') // a starter, on at minute 30
    expect(r.within.playersOnPitch.map((p) => p.name)).not.toContain('Rakish Bingham')
    expect(r.within.playersOnPitch.filter((p) => p.persistentPlayerId !== null).length).toBeGreaterThan(5) // followable across matches
    expect(r.playersOnPitchPresence!.before.every((x) => x.linkedPresent > 5)).toBe(true)
    expect(r.warnings).toContain('observational_comparison: not a controlled test; context and confounders are reported beside the rates and are not adjusted for')
    expect(r.metrics.goals_per_90 ?? r.metrics.xg_per_90).toBeDefined()
    expect(r.source.aggregates).toBe(5)
  })

  it('AC a substitution changes who was on the pitch: Bingham, not Alexander, at minute 75', async () => {
    const n = await svc.addNote(ids.f2!.matchId, { minute: 75, setting: 'Mentality', priorValue: 'Positive', newValue: 'Cautious' })
    const r = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId })
    const names = r.within.playersOnPitch.map((p) => p.name)
    expect(names).toContain('Rakish Bingham')
    expect(names).not.toContain('George Alexander')
    expect(names).toHaveLength(11)
    expect(r.within.windows!.after.minutes).toBeLessThan(r.within.windows!.before.minutes)
    expect(r.warnings.some((x) => x.startsWith('short_window_after'))).toBe(false)
  })

  it('AC the within-match rates split a goal correctly: a goal before the change is in the before window only', async () => {
    const n = await svc.addNote(ids.f4!.matchId, { minute: 60, period: 2, setting: 'Tempo', priorValue: 'Standard', newValue: 'Higher' }) // goal at tick 12000 = minute 48.7
    const r = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId, matchesBefore: 0, matchesAfter: 0 })
    const goals = r.within.rates.find((x) => x.metric === 'goals')!
    const w = r.within.windows!
    expect((goals.before! * w.before.minutes) / 90).toBeCloseTo(1, 6)
    expect(goals.after).toBe(0)
    expect(goals.delta).toBeCloseTo(-goals.before!, 9)
  })

  it('AC a single-match comparison says so, and no eligible neighbours is not a failure', async () => {
    const n = await svc.addNote(ids.f1!.matchId, { minute: 60, setting: 'Width', priorValue: 'Standard', newValue: 'Wide' })
    const r = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId }) // nothing eligible before the first match
    expect(r.singleMatchComparison).toBe(true)
    expect(r.across).toMatchObject({ status: 'unavailable', reason: 'no_eligible_match_before_the_change' })
    expect(r.warnings.some((x) => x.startsWith('single_match_comparison'))).toBe(true)
    expect(r.statements.join(' ')).toMatch(/single-match comparison/)
    const none = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId, matchesBefore: 0, matchesAfter: 0 })
    expect(none.across).toMatchObject({ status: 'unavailable', reason: 'matches_before_not_requested,matches_after_not_requested' })
    expect(none.singleMatchComparison).toBe(true)
  })

  it('AC a note early in the match warns that the window before it is short; a superseded note is flagged', async () => {
    const n = await svc.addNote(ids.f5!.matchId, { minute: 5, setting: 'Mentality', priorValue: 'Balanced', newValue: 'Attacking' })
    const r = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId })
    expect(r.warnings.some((x) => x.startsWith('short_window_before'))).toBe(true)
    const next = await svc.supersedeNote(n.noteId, { minute: 8 })
    const old = await q.compareTacticalChange({ saveId, teamId, noteId: n.noteId })
    expect(old.warnings).toContain(`note_superseded_by:${next.noteId}`)
  })

  it('AC the note must be about the requested team and belong to the save', async () => {
    const note = q.tacticalNotes({ saveId, limit: 1 }).notes[0]!
    const opp = q.listMatches({ saveId }).matches.find((m) => m.matchId === note.matchId)!.opponent!.teamId
    await expect(q.compareTacticalChange({ saveId, teamId: opp, noteId: note.noteId })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'note_team_mismatch' } })
    const other = svc.createSave('Other').saveId
    await expect(q.compareTacticalChange({ saveId: other, teamId, noteId: note.noteId })).rejects.toMatchObject({ code: 'not_found' })
    await expect(q.compareTacticalChange({ saveId, teamId, noteId: 'n_nope' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(q.compareTacticalChange({ saveId, teamId, noteId: note.noteId, matchesBefore: 11 })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'matches_each_side' } })
  })

  it('AC no causal wording anywhere in the generated statements, warnings or labels of the new results', async () => {
    const note = q.tacticalNotes({ saveId, limit: 1 }).notes[0]!
    const results: Array<{ statements?: string[]; warnings?: string[] }> = [
      await q.seasonTrends({ saveId, teamId }),
      await q.seasonTrends({ saveId, teamId, includePartial: true, homeAway: 'home' }),
      await q.compareTacticalChange({ saveId, teamId, noteId: note.noteId }),
      q.tacticalNotes({ saveId, matchId: ids.f3!.matchId }) as { statements?: string[]; warnings?: string[] },
      q.listPlayers({ saveId }),
    ]
    const alex = (q.listPlayers({ saveId, nameQuery: 'Alexander' }).players[0] as { playerId: string }).playerId
    const bing = (q.listPlayers({ saveId, nameQuery: 'Bingham' }).players[0] as { playerId: string }).playerId
    results.push(await q.playerTrends({ saveId, playerIds: [alex, bing] }))
    for (const r of results) expect(prose(r)).not.toMatch(CAUSAL)
    expect(q.tacticalNotes({ saveId }).label).not.toMatch(CAUSAL)
    const t = await q.compareTacticalChange({ saveId, teamId, noteId: note.noteId })
    expect(t.statements.join(' ')).toMatch(/do not establish what produced them/)
  })
})

describe('Slice 4: club aliases and assisted managed-team detection (explicit save assignment is untouched)', () => {
  const OWN = (k: string, d: string, side: 'home' | 'away'): SeasonMatch => ({ key: k, date: d, side, opponent: `Opp ${k}`, passesPerSide: 30 })

  it('AC detection only suggests; applying is audited; an explicit assignment always wins and is never replaced by a detected one', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    await ingestSeason(svc, saveId, [OWN('d1', '2026-08-01', 'home'), OWN('d2', '2026-08-08', 'away'), OWN('d3', '2026-08-15', 'home')])
    const matchesBefore = svc.listMatches(saveId).matches.map((x) => x.matchId)
    const d = svc.detectManagedTeam(saveId)
    expect(d.suggestion).toMatchObject({ name: 'Synthetic Town', evidence: 'human_manager_flag_in_3_of_3_appearances' })
    expect(d.candidates).toHaveLength(1)
    expect(d.current).toBeNull()
    expect(svc.getManagedTeam(saveId)).toBeNull() // detection alone changes nothing
    const applied = svc.applyDetectedManagedTeam(saveId)
    expect(applied).toMatchObject({ source: 'assisted', name: 'Synthetic Town' })
    expect(svc.getManagedTeam(saveId)).toEqual({ teamId: d.suggestion!.teamId, source: 'assisted' })
    expect(svc.store.listAudit().map((a) => a.action)).toContain('save.managed_team.assisted')

    // an explicit choice replaces the assisted one, and a detected one can never replace an explicit one
    const opp = svc.listMatches(saveId).matches[0]!.away.name === 'Synthetic Town' ? svc.listMatches(saveId).matches[0]!.home : svc.listMatches(saveId).matches[0]!.away
    expect(svc.setManagedTeam(saveId, opp.teamId)).toMatchObject({ source: 'explicit' })
    expect(() => svc.applyDetectedManagedTeam(saveId)).toThrowError(/explicit managed team is already set/)
    expect(svc.getManagedTeam(saveId)).toEqual({ teamId: opp.teamId, source: 'explicit' })
    expect(svc.clearManagedTeam(saveId)).toMatchObject({ cleared: true })
    expect(svc.applyDetectedManagedTeam(saveId).source).toBe('assisted')
    // the save assignment of the matches is exactly as the user made it
    expect(svc.listMatches(saveId).matches.map((x) => x.matchId)).toEqual(matchesBefore)
    svc.close()
  }, 120_000)

  it('AC detection offers nothing when more than one team was human-managed or no manager flag exists', async () => {
    const svc = service()
    const saveId = svc.createSave('S').saveId
    await ingestSeason(svc, saveId, [OWN('h1', '2026-08-01', 'home'), { ...OWN('h2', '2026-08-08', 'home'), synth: { humanSide: 'away' } }])
    const d = svc.detectManagedTeam(saveId)
    expect(d.suggestion).toBeNull()
    expect(d.reason).toBe('more_than_one_team_was_human_managed')
    expect(() => svc.applyDetectedManagedTeam(saveId)).toThrowError(/no single human-managed team/)
    const none = service(), s2 = none.createSave('N').saveId
    await ingestSeason(none, s2, [{ ...OWN('z1', '2026-08-01', 'home'), synth: { humanSide: undefined } }])
    expect(none.detectManagedTeam(s2).reason).toBe('no_human_manager_flag_recorded')
    svc.close(); none.close()
  }, 120_000)

  it('AC club aliases resolve a team by id, alias or exact name inside one save; collisions are refused; aliases are audited and removable', async () => {
    const svc = service()
    const a = svc.createSave('A').saveId, b = svc.createSave('B').saveId
    await ingestSeason(svc, a, [OWN('a1', '2026-08-01', 'home')])
    await ingestSeason(svc, b, [OWN('b1', '2026-08-01', 'away')])
    const team = svc.resolveTeamRef(a, 'Synthetic Town')
    expect(svc.resolveTeamRef(a, team.teamId).teamId).toBe(team.teamId)
    expect(svc.addClubAlias(a, 'Synthetic Town', 'STFC')).toMatchObject({ created: true, teamId: team.teamId })
    expect(svc.addClubAlias(a, team.teamId, 'stfc')).toMatchObject({ created: false }) // same alias, case-insensitive
    expect(svc.resolveTeamRef(a, '  stfc ').teamId).toBe(team.teamId)
    expect(svc.listClubAliases(a)).toEqual([{ teamId: team.teamId, teamName: 'Synthetic Town', alias: 'STFC' }])
    expect(() => svc.resolveTeamRef(b, 'STFC')).toThrowError(/No team, alias or team name/) // aliases are save-scoped
    expect(() => svc.addClubAlias(a, 'Synthetic Town', 'Opp a1')).toThrowError(/name of another team/)
    expect(() => svc.addClubAlias(a, 'Opp a1', 'STFC')).toThrowError(/already points at another team/)
    expect(svc.store.listAudit().filter((x) => x.action === 'club.alias.add')).toHaveLength(1)
    expect(svc.removeClubAlias(a, 'STFC')).toMatchObject({ removed: true })
    expect(() => svc.removeClubAlias(a, 'STFC')).toThrowError(/No such alias/)
    // two teams with one name in a save are ambiguous without an id
    const c = svc.createSave('C').saveId
    await ingestOne(svc, c, { key: 'c1', date: '2026-08-01', side: 'home', opponent: 'Twin FC', passesPerSide: 30, synth: { homeUid: 1 } })
    await ingestOne(svc, c, { key: 'c2', date: '2026-08-08', side: 'home', opponent: 'Twin FC', passesPerSide: 30, synth: { homeUid: 2, awayUid: 333 } })
    expect(() => svc.resolveTeamRef(c, 'Synthetic Town')).toThrowError(/More than one team has this name/)
    svc.close()
  }, 120_000)
})
