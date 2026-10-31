// Cross-match player comparison context (spec 7.1, 7.6): per-player pooled score-state minutes, the opposition faced, the contributing
// matches and a confounders list under the registry thresholds. LABELLED SYNTHETIC fixtures (invented club, players and opponents)
// written by the test-only archive writer; isolated FMMI_HOME catalogs. Expected minutes come from an independent walk over the
// known frame ticks and the known goal ticks, not from the code under test.
import { afterAll, describe, expect, it } from 'vitest'
import { GATES, playerComparisonConfounders, PlayerTrendsResultSchema } from '@fmmi/analytics'
import type { PlayerComparisonSide } from '@fmmi/analytics'
import { MatchQueries } from '@fmmi/query'
import { cleanupAll, service } from '../support/helpers.ts'
import { confirmObserved, ingestSeason } from '../support/season.ts'
import type { SeasonMatch } from '../support/season.ts'

afterAll(cleanupAll)

type State = 'leading' | 'drawing' | 'trailing'
// FULL_PERIODS of the archive writer: frames every 60 ticks inside each period.
const FRAMES = [
  { period: 1, from: 3, to: 11041 }, { period: 2, from: 11124, to: 22000 },
].map((p) => ({ period: p.period, ticks: Array.from({ length: Math.floor((p.to - p.from) / 60) + 1 }, (_, k) => p.from + 60 * k) }))

/** Ticks leading/drawing/trailing from the CLUB's view over `segments`; goals are the club side's `for` and `against` ticks (frame-aligned). */
function expectedTicks(segments: Array<{ period: number; fromTick: number; toTick: number }>, forTicks: number[], againstTicks: number[]): Record<State, number> {
  const out: Record<State, number> = { leading: 0, drawing: 0, trailing: 0 }
  for (const f of FRAMES) {
    f.ticks.forEach((t0, i) => {
      const t1 = i + 1 < f.ticks.length ? f.ticks[i + 1]! : Infinity
      const own = forTicks.filter((g) => g <= t0).length, opp = againstTicks.filter((g) => g <= t0).length
      const state: State = own > opp ? 'leading' : own < opp ? 'trailing' : 'drawing'
      for (const s of segments) {
        if (s.period !== f.period) continue
        const lo = Math.max(t0, s.fromTick), hi = Math.min(t1, s.toTick)
        if (lo < hi) out[state] += hi - lo
      }
    })
  }
  return out
}

const sum = (a: Record<State, number>, b: Record<State, number>): Record<State, number> => ({ leading: a.leading + b.leading, drawing: a.drawing + b.drawing, trailing: a.trailing + b.trailing })

// The club is the home side in both matches. Goal ticks are frame aligned (3 + 60k in period 1, 11124 + 60k in period 2).
const TRAIL: SeasonMatch = { key: 'a1', date: '2026-08-08', side: 'home', opponent: 'Alpha Town', goals: [{ tick: 603, side: 'away' }] }
const LEAD_LATE: SeasonMatch = { key: 'a2', date: '2026-08-15', side: 'home', opponent: 'Bravo City', goals: [{ tick: 15024, side: 'home' }] }
const LEAD_EARLY: SeasonMatch = { key: 'a3', date: '2026-08-15', side: 'home', opponent: 'Bravo City', goals: [{ tick: 603, side: 'home' }] }

async function fresh(specs: SeasonMatch[]) {
  const svc = service()
  const saveId = svc.createSave('Synthetic Town').saveId
  const ids = await ingestSeason(svc, saveId, specs)
  for (const k of Object.keys(ids)) confirmObserved(svc, ids[k]!.matchId)
  const q = new MatchQueries(svc)
  const find = (name: string) => q.listPlayers({ saveId, nameQuery: name }).players.find((p) => p.identityStatus === 'persistent')!.playerId
  return { svc, saveId, ids, q, find }
}

const segmentsOf = (svc: ReturnType<typeof service>, matchId: string, name: string) => svc.showMatch(matchId).roster.find((p) => p.name.includes(name))!.participation.segments

describe('Slice 5 fix: cross-match player comparison carries score-state context and confounders', () => {
  it('AC pooled per-player score-state minutes equal an independent frame walk; contributing matches and opposition are listed; different_score_state fires and the finding is not suppressed', async () => {
    const t = await fresh([TRAIL, LEAD_LATE])
    const [alex, bing] = [t.find('Alexander'), t.find('Bingham')]
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [alex, bing] })
    expect(PlayerTrendsResultSchema.safeParse(r).success).toBe(true)

    const forAgainst = { a1: { f: [], a: [603] }, a2: { f: [15024], a: [] } }
    for (const [name, p] of [['Alexander', r.players[0]!], ['Bingham', r.players[1]!]] as const) {
      const w = p.windows[0]!
      let want: Record<State, number> = { leading: 0, drawing: 0, trailing: 0 }
      for (const k of ['a1', 'a2'] as const) want = sum(want, expectedTicks(segmentsOf(t.svc, t.ids[k]!.matchId, name), forAgainst[k].f, forAgainst[k].a))
      expect(w.scoreState!.value, name).not.toBeNull()
      expect(w.scoreState!.value!.ticks, name).toEqual(want)
      expect(w.scoreState!.value!.minutes.trailing).toBeCloseTo(want.trailing / 240, 2)
      // both matches contributed; the opposition is listed in game order
      expect(w.contributing).toEqual({ matches: 2 })
      expect(w.opposition).toEqual(['Alpha Town', 'Bravo City'])
    }
    // Alexander never trails in match 2 and never leads in either (he leaves before the 15024 goal); Bingham does lead late in match 2.
    expect(r.players[0]!.windows[0]!.scoreState!.value!.ticks.leading).toBe(0)
    expect(r.players[1]!.windows[0]!.scoreState!.value!.ticks.leading).toBeGreaterThan(0)

    const c = r.comparisons[0]!
    expect(c.confounders).toContain('different_score_state')
    expect(c.confounders).toContain('opposition_strength_unavailable')
    // the finding is reported, not suppressed: the exposure gates pass in both windows
    expect(c.status).toBe('qualified')
    expect(c.passesReceivedPer90).not.toBeNull()
    t.svc.close()
  }, 120_000)

  it('AC like-for-like score state does not fire: a starter who plays the whole match and a player who leaves at the same score states share the confounder-free comparison', async () => {
    const t = await fresh([TRAIL, LEAD_EARLY])
    const [alex, spong] = [t.find('Alexander'), t.find('Spong')]
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [alex, spong] })
    const c = r.comparisons[0]!
    expect(c.confounders).not.toContain('different_score_state')
    expect(c.confounders).not.toContain('score_state_unavailable')
    // Spong plays both matches in full, Alexander leaves at 14003: the minutes ratio is above the registry floor, so no minutes confounder either
    const mins = [r.players[0]!.windows[0]!.minutes, r.players[1]!.windows[0]!.minutes]
    expect(Math.min(...mins) / Math.max(...mins)).toBeGreaterThanOrEqual(GATES.context.minutesRatioMin)
    expect(c.confounders).not.toContain('different_minutes_on_pitch')
    t.svc.close()
  }, 120_000)

  it('AC the text output carries the same context: score state, contributing matches, opposition and the flags', async () => {
    const t = await fresh([TRAIL, LEAD_LATE])
    const { renderPlayerTrends } = await import('../../packages/cli/src/renderHistory.ts')
    const r = await t.q.playerTrends({ saveId: t.saveId, playerIds: [t.find('Alexander'), t.find('Bingham')] })
    const text = renderPlayerTrends(r)
    expect(text).toMatch(/played in 2 match\(es\); score state while on pitch \(min leading\/drawing\/trailing\) 0\.0\//)
    expect(text).toMatch(/opposition Alpha Town, Bravo City/)
    expect(text).toMatch(/context flags \(not adjusted for; the finding is not suppressed\): .*different_score_state/)
    t.svc.close()
  }, 120_000)
})

describe('Slice 5 fix: playerComparisonConfounders thresholds (registry GATES.context)', () => {
  const side = (ticks: Record<State, number>, minutes = 100): PlayerComparisonSide => {
    const order: State[] = ['leading', 'drawing', 'trailing']
    return {
      playerId: 'x', minutes, contributingMatches: 2,
      scoreState: { value: { ticks, minutes: { leading: ticks.leading / 240, drawing: ticks.drawing / 240, trailing: ticks.trailing / 240 }, dominant: order.reduce((a, b) => (ticks[b] > ticks[a] ? b : a)) } },
    }
  }
  const base = side({ leading: 100, drawing: 100, trailing: 0 }) // shares 0.5 / 0.5 / 0, dominant leading (tie keeps the first)

  it('AC a share gap exactly at the threshold does not fire, just above it does (the dominant state is held equal)', () => {
    expect(GATES.context.scoreStateShareDifference).toBe(0.25)
    // shares 0.25/0.5/0.25 vs 0.5/0.5/0: dominant drawing vs leading differs, so hold dominant equal instead: 0.5/0.25/0.25 vs 0.75/0/0.25 has gap 0.25
    const a = side({ leading: 200, drawing: 100, trailing: 100 }), atThreshold = side({ leading: 300, drawing: 0, trailing: 100 })
    expect(playerComparisonConfounders(a, atThreshold)).not.toContain('different_score_state')
    const above = side({ leading: 301, drawing: 0, trailing: 99 }) // gap 0.2525 on the trailing and leading shares
    expect(playerComparisonConfounders(a, above)).toContain('different_score_state')
    expect(playerComparisonConfounders(base, base)).not.toContain('different_score_state')
  })

  it('AC a different dominant state fires even when no share gap exceeds the threshold', () => {
    const a = side({ leading: 100, drawing: 99, trailing: 101 }), b = side({ leading: 101, drawing: 99, trailing: 100 })
    expect(playerComparisonConfounders(a, b)).toContain('different_score_state')
  })

  it('AC unavailable score state is a confounder, not a suppression; minutes below the registry ratio fire', () => {
    const unavailable: PlayerComparisonSide = { playerId: 'y', minutes: 100, contributingMatches: 2, scoreState: { value: null, nullReason: 'not_recorded' } }
    expect(playerComparisonConfounders(base, unavailable)).toContain('score_state_unavailable')
    expect(playerComparisonConfounders(base, { ...base, minutes: 50 })).not.toContain('different_minutes_on_pitch') // ratio exactly 0.5 does not fire
    expect(playerComparisonConfounders(base, { ...base, minutes: 49.9 })).toContain('different_minutes_on_pitch')
  })
})
