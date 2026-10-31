// Spec deviation B: a full-match capture counts without a confirmation step (completion stays unknown, the score is labelled observed and
// not final); a partial recording still waits for one and the output names the next step; a manual confirmation takes precedence.
import { afterAll, describe, expect, it } from 'vitest'
import { MatchQueries } from '@fmmi/query'
import { SeasonTrendsResultSchema } from '@fmmi/analytics'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { FIVE, ingestSeason, periodsOf } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

const SPECS: SeasonMatch[] = [
  { ...FIVE[0]!, key: 'full1', date: '2026-08-01', goals: [{ tick: 5000, side: 'home' }] }, // home 1-0
  { ...FIVE[1]!, key: 'full2', date: '2026-08-08', side: 'home', goals: [{ tick: 5000, side: 'home' }, { tick: 9000, side: 'away' }] }, // 1-1
  { ...FIVE[2]!, key: 'cut', date: '2026-08-15', side: 'home', periods: periodsOf(15600) }, // a partial recording (65 minutes)
]

async function build() {
  const svc = new CatalogService(loadConfig(tmp('fmmi-unconf-'), {}))
  const save = svc.createSave('Unconfirmed FC')
  const ids = await ingestSeason(svc, save.saveId, SPECS)
  const q = new MatchQueries(svc)
  const teamId = svc.listMatches(save.saveId).matches[0]!.home.teamId
  return { svc, q, saveId: save.saveId, ids, teamId }
}

describe('full recordings count without a confirmation', () => {
  it('are eligible in rates, totals and the record, disclosed as full_capture_unconfirmed; completion stays unknown and the result stays observed_not_final', async () => {
    const t = await build()
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    expect(SeasonTrendsResultSchema.safeParse(r).success).toBe(true)
    expect(r.windows[0]!.matchIds).toEqual([t.ids.full1!.matchId, t.ids.full2!.matchId])
    expect(r.windows[0]!.disclosures.fullCaptureUnconfirmed).toEqual([t.ids.full1!.matchId, t.ids.full2!.matchId])
    expect(r.windows[0]!.disclosures.manualConfirmation).toEqual([])
    expect(r.windows[0]!.totals).toMatchObject({ matches: 2, goalsFor: 2, goalsAgainst: 1 })
    expect(r.windows[0]!.record).toMatchObject({ matches: 2, won: 1, drawn: 1, lost: 0, manualScores: 0, observedScores: 2 })
    expect(r.matches.map((m) => m.score)).toEqual([
      { for: 1, against: 0, basis: 'observed', outcome: 'win' },
      { for: 1, against: 1, basis: 'observed', outcome: 'draw' },
    ])
    // the match itself is not promoted: completion unknown, label observed_not_final, nothing final
    const show = t.svc.showMatch(t.ids.full1!.matchId)
    expect(show.status.completion.status).toBe('unknown')
    expect(show.result).toMatchObject({ final: null, label: 'observed_not_final' })
    expect(t.svc.listMatches(t.saveId).matches.find((m) => m.matchId === t.ids.full1!.matchId)!.status.completion).toBe('unknown')
    t.svc.close()
  })

  it('a partial recording stays excluded until confirmed, and trends and list_matches name the next step: fmmi sync', async () => {
    const t = await build()
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    expect(r.excluded).toEqual([{ matchId: t.ids.cut!.matchId, date: '2026-08-15', reasons: ['completion_unknown', 'early_ending_below_80_captured_minutes'], nextStep: 'fmmi sync' }])
    const list = t.q.listMatches({ saveId: t.saveId })
    const byId = new Map(list.matches.map((m) => [m.matchId, m]))
    expect(byId.get(t.ids.cut!.matchId)).toMatchObject({ needsConfirmation: true, nextStep: 'fmmi sync' })
    expect(byId.get(t.ids.full1!.matchId)).toMatchObject({ needsConfirmation: false })
    expect(byId.get(t.ids.full1!.matchId)!).not.toHaveProperty('nextStep')
    t.svc.close()
  })

  it('a manual confirmation takes precedence and can correct the observed score: manual record, disclosed, observed counters untouched', async () => {
    const t = await build()
    const m = t.ids.full1!.matchId
    const observedGoals = (await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })).windows[0]!.totals.goalsFor
    t.svc.confirmMatch(m, '3-1', { allowScoreChange: true })
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    const row = r.matches.find((x) => x.matchId === m)!
    expect(row.score).toEqual({ for: 3, against: 1, basis: 'manual', outcome: 'win' })
    expect(row.disclosures).toEqual(['manual_confirmation', 'manual_final_score_differs_from_observed'])
    expect(r.windows[0]!.disclosures.fullCaptureUnconfirmed).toEqual([t.ids.full2!.matchId])
    expect(r.windows[0]!.record).toMatchObject({ manualScores: 1, observedScores: 1 })
    expect(r.windows[0]!.totals.goalsFor).toBe(observedGoals) // totals stay observed counters
    t.svc.close()
  })

  it('confirming the partial recording brings it in only once it qualifies as an early ending; at 65 minutes it stays out', async () => {
    const t = await build()
    t.svc.confirmMatch(t.ids.cut!.matchId, '0-0')
    const r = await t.q.seasonTrends({ saveId: t.saveId, teamId: t.teamId, lastN: 5 })
    expect(r.excluded[0]).toMatchObject({ reasons: ['early_ending_below_80_captured_minutes'] })
    expect(r.excluded[0]).not.toHaveProperty('nextStep')
    t.svc.close()
  })
})
