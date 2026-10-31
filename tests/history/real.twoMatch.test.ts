// Real two-recording goldens: Farnham 0-3 Torquay (home, partial, skipped) and Hemel Hempstead 1-2 Farnham (away, full match) in ONE save.
// Reads tests/fixtures/local/ (gitignored) and reports a skip when either file is absent. FMMI_HOME-isolated temporary catalogs; the
// game folder is never read. Expected values are either measured constants of these two recordings (labelled) or computed from the data
// by an independent route in the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { PlayerTrendsResultSchema, SeasonTrendsResultSchema } from '@fmmi/analytics'
import { MatchQueries } from '@fmmi/query'
import { HAS_REAL_PAIR, REAL_FIXTURE, REAL_FIXTURE_HEMEL, cleanupAll, service } from '../support/helpers.ts'
import { connect, KB } from '../support/mcp.ts'
import type { Connected, Json } from '../support/mcp.ts'

afterAll(cleanupAll)

// Measured on the two real recordings (Torquay 0-3, Hemel 1-2), game minutes leading / drawing / trailing, Farnham's view. Filled in from the first run.
const MEASURED_SCORE_STATE = { alexander: { leading: 54.36, drawing: 21.96, trailing: 31.88 }, bingham: { leading: 5.74, drawing: 55.76, trailing: 14.92 } }
const MEASURED_CONFOUNDERS = ['different_score_state', 'opposition_strength_unavailable']
const MEASURED_COMPARISON_STATUS = 'qualified'

describe.skipIf(!HAS_REAL_PAIR)('two real recordings in one save', () => {
  const svc = service()
  let saveId = '', hemel = '', torquay = '', farnham = ''
  let hemelRev = '', torquayRev = ''
  const home = svc.config.home
  let mcp: Connected

  const cli = async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home } }
    const code = await main(args, io)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const minutesOf = (r: ReturnType<typeof service>, matchId: string) => r.showMatch(matchId).status.coverage.periods.reduce((a, p) => a + (p.lastTick - p.firstTick), 0) / 240

  beforeAll(async () => {
    saveId = svc.createSave('Farnham Town').saveId
    const a = await svc.ingestFile(REAL_FIXTURE, saveId), b = await svc.ingestFile(REAL_FIXTURE_HEMEL, saveId)
    expect([a.status, b.status]).toEqual(['ingested', 'ingested'])
    torquay = a.matchId!; torquayRev = a.recordingRevisionId!
    hemel = b.matchId!; hemelRev = b.recordingRevisionId!
    farnham = svc.showMatch(torquay).home.teamId
    // Completion is unknown until the user confirms; confirming attests the match, never the capture.
    expect(svc.showMatch(hemel).status.completion.status).toBe('unknown')
    svc.confirmMatch(hemel, '1-2')
    svc.confirmMatch(torquay, '0-3')
    svc.applyDetectedManagedTeam(saveId)
    svc.close()
    mcp = await connect(home)
  }, 240_000)
  afterAll(async () => { await mcp?.close() })

  // The service is closed after set-up (the CLI and the MCP server open their own connections); a fresh read-only handle serves the checks.
  const reader = () => service(home)

  it('AC Farnham is the away side at Hemel: observed 1-2, xG 0.85 / 1.95 within source precision, passes 522/611 and 387/476 (completed/attempted, home/away)', () => {
    const r = reader()
    try {
      const s = r.showMatch(hemel)
      expect(s.home.name).toBe('Hemel Hempstead')
      expect(s.away).toMatchObject({ name: 'Farnham', teamId: farnham })
      expect(s.managedSide).toBe('away')
      expect(s.result.observed).toMatchObject({ home: 1, away: 2 })
      const t = s.teamTotals
      expect(t.home.xg).toBeCloseTo(0.85, 2)
      expect(t.away.xg).toBeCloseTo(1.95, 2)
      expect(Math.abs(t.home.xg! - 0.8519279956817627)).toBeLessThan(1e-6) // float32 source, measured by the audit
      expect(Math.abs(t.away.xg! - 1.9457755088806152)).toBeLessThan(1e-6)
      expect([t.home.passesCompleted, t.home.passes]).toEqual([522, 611])
      expect([t.away.passesCompleted, t.away.passes]).toEqual([387, 476])
      // the same Farnham team id as in the Torquay match: one club across a home and an away fixture
      expect(r.showMatch(torquay).home.teamId).toBe(farnham)
      expect(r.showMatch(torquay).managedSide).toBe('home')
    } finally { r.close() }
  })

  it('AC the Hemel recording is full_match and Torquay is partial (the >= 90:00 rule is a heuristic; it does not prove the whistle)', () => {
    const r = reader()
    try {
      const h = r.showMatch(hemel).status.coverage, t = r.showMatch(torquay).status.coverage
      expect(h.status).toBe('full_match')
      expect(t.status).toBe('partial')
      expect(t.endCaptureEndsAt).toMatchObject({ period: 2 })
      expect(h.endCaptureEndsAt).toBeNull()
      expect(r.showMatch(hemel).status.completion.status).toBe('completed_manual')
      expect(r.showMatch(hemel).result.observed.at.displayMinute).toBeGreaterThanOrEqual(90) // the rule's input, measured: 94.03
    } finally { r.close() }
  })

  it('AC 17 persistent identities merge on uid plus name; Alexander, Bingham and Spong are persistent; opposition players stay match_local', () => {
    const r = reader()
    const rq = new MatchQueries(r)
    try {
      const rosterH = r.showMatch(hemel).roster, rosterT = r.showMatch(torquay).roster
      // Independent expectation: players of the Farnham sides with the same positive uid AND the same name in both rosters.
      const farnhamOf = (roster: typeof rosterH, side: 'home' | 'away') => roster.filter((p) => p.side === side)
      const expected = farnhamOf(rosterT, 'home').filter((a) => (a.upstream.uid ?? 0) > 0 && farnhamOf(rosterH, 'away').some((b) => b.upstream.uid === a.upstream.uid && b.name === a.name))
      expect(expected.length).toBe(17) // measured on these two recordings

      const all: Json[] = []
      for (let cursor: string | undefined, i = 0; i < 5; i++) {
        const page = rq.listPlayers({ saveId, limit: 50, cursor })
        all.push(...page.players)
        if (!page.page.nextCursor) break
        cursor = page.page.nextCursor
      }
      const persistent = all.filter((p) => p.identityStatus === 'persistent')
      expect(persistent).toHaveLength(17)
      expect(new Set(persistent.map((p) => p.uid))).toEqual(new Set(expected.map((p) => p.upstream.uid)))
      for (const p of persistent) {
        expect(p.matches).toBe(2)
        expect(p.supportingMatchIds.slice().sort()).toEqual([hemel, torquay].sort())
        expect(p.playerId).toMatch(/^pe_/)
      }
      for (const name of ['Alexander', 'Bingham', 'Spong']) {
        const hit = all.find((p) => String(p.name).includes(name))!
        expect(hit.identityStatus, name).toBe('persistent')
      }
      // Opposition players (both Hemel and Torquay) appear once and stay match-local; nothing links by name alone.
      const oppositionIds = [...farnhamOf(rosterH, 'home'), ...farnhamOf(rosterT, 'away')].map((p) => p.playerId)
      expect(oppositionIds.length).toBeGreaterThan(30)
      for (const id of oppositionIds) expect(r.store.getMember(id), id).toBeNull()
      const locals = all.filter((p) => p.identityStatus === 'match_local')
      expect(locals.every((p) => p.matches === 1 && p.playerId.startsWith('p_'))).toBe(true)
      expect(rq.listPlayers({ saveId, limit: 1 }).summary).toMatchObject({ persistent: 17, linked: 0 })
    } finally { r.close() }
  })

  it('AC fmmi review: totals exclude the Torquay unseen time, rates use the 184.62 measured minutes, pooled ratios are pooled numerator over denominator', async () => {
    const res = await cli('review', '--save', saveId, '--json')
    expect(res.code, res.err).toBe(0)
    const data = JSON.parse(res.out).data as Json
    expect(SeasonTrendsResultSchema.safeParse(data).success).toBe(true)
    const w = data.windows[0]
    expect(w.matchIds.sort()).toEqual([hemel, torquay].sort())
    expect(data.matches.find((m: Json) => m.matchId === torquay)).toMatchObject({ class: 'early_ending' })
    expect(w.totals.matches).toBe(1)
    expect(w.totals.excludedFromTotals).toEqual([{ matchId: torquay, reason: 'early_ending_unseen_time' }])
    const r = reader()
    try {
      const minH = minutesOf(r, hemel), minT = minutesOf(r, torquay)
      expect(w.totals.minutes).toBeCloseTo(minH, 6)
      const total = minH + minT
      expect(total).toBeCloseTo(184.62, 2)
      const farnhamTotals = (matchId: string) => { const s = r.showMatch(matchId); return s.teamTotals[s.managedSide!] }
      const fh = farnhamTotals(hemel), ft = farnhamTotals(torquay)
      expect(w.totals.goalsFor).toBe(fh.goals) // totals: Hemel only
      const row = (m: string) => w.rates.find((x: Json) => x.metric === m)
      // per-90 rates divide by BOTH recordings' measured minutes
      const g = row('goals_per_90')
      expect(g.denominator).toBeCloseTo(total, 6)
      expect(g.numerator).toBe(fh.goals! + ft.goals!)
      expect(g.value).toBeCloseTo((90 * (fh.goals! + ft.goals!)) / total, 9)
      expect(row('xg_per_90').numerator).toBeCloseTo(fh.xg! + ft.xg!, 6)
      // pooled percentage = pooled numerator over pooled denominator, not the mean of the two match percentages
      const pc = row('pass_completion_pct')
      expect(pc.numerator).toBe(fh.passesCompleted! + ft.passesCompleted!)
      expect(pc.denominator).toBe(fh.passes! + ft.passes!)
      expect(pc.value).toBeCloseTo((100 * pc.numerator) / pc.denominator, 9)
      const meanOfRatios = (100 * fh.passesCompleted! / fh.passes! + 100 * ft.passesCompleted! / ft.passes!) / 2
      expect(Math.abs(pc.value - meanOfRatios)).toBeGreaterThan(0.1)
      const aw = row('aerial_win_pct')
      expect(aw.value).toBeCloseTo((100 * (fh.aerialsWon! + ft.aerialsWon!)) / (fh.aerials! + ft.aerials!), 9)
    } finally { r.close() }
    // the text review is the same data
    const text = await cli('review', '--save', saveId)
    expect(text.code).toBe(0)
    expect(text.out).toMatch(/early_ending_unseen_time/)
    expect(text.out).toMatch(/Chance creation by wing/)
  })

  it('AC the recipient gate passes for both sides of both matches, with exact whole-recording reconciliation computed from the data', async () => {
    for (const matchId of [hemel, torquay]) {
      const r = reader()
      try {
        const totals = r.showMatch(matchId).teamTotals
        const gate = (await new MatchQueries(r).summary(matchId)).summary.evidenceQuality.recipientGate
        for (const side of ['home', 'away'] as const) {
          const g = gate[side]
          expect(g.status, `${matchId} ${side}`).toBe('pass')
          expect(g.reconciliation).toBe('exact')
          expect(g.eligibleCompletedPasses).toBe(totals[side].passesCompleted) // reconciles to the cumulative counter
          expect(g.withVerifiedReceiver).toBe(g.eligibleCompletedPasses)
          expect(g.coverageRatio).toBe(1)
          expect(g.verifiedAgainstUi).toBe(false) // never claimed
        }
      } finally { r.close() }
    }
  })

  it('AC the section 14 query: player-trends for two and three persistent players works over the CLI (text and --json) and a real SDK client', async () => {
    const find = async (name: string) => (JSON.parse((await cli('players', '--save', saveId, '--name', name, '--json')).out).data.players as Json[]).find((p) => p.identityStatus === 'persistent')!.playerId as string
    const [alex, bing, spong] = [await find('Alexander'), await find('Bingham'), await find('Spong')]
    for (const ids of [[alex, bing], [alex, spong], [bing, spong], [alex, bing, spong]]) {
      const text = await cli('player-trends', '--save', saveId, '--players', ids.join(','))
      expect(text.code, text.err).toBe(0)
      expect(text.out).toMatch(/Comparison last 5 /)
      const js = await cli('player-trends', '--save', saveId, '--players', ids.join(','), '--json')
      expect(js.code, js.err).toBe(0)
      const body = JSON.parse(js.out).data as Json
      expect(PlayerTrendsResultSchema.safeParse(body).success).toBe(true)
      expect(body.players).toHaveLength(ids.length)
      const sdk = await mcp.call('get_player_trends', { saveId, playerIds: ids })
      expect(sdk.isError, sdk.text.slice(0, 300)).toBe(false)
      expect(sdk.data).toEqual(body)
      expect(Buffer.byteLength(sdk.text, 'utf8')).toBeLessThan(20 * KB)
    }
    // Each player's two matches both contribute (Alexander was substituted on in the Hemel match, Bingham off in the Torquay one)
    const one = JSON.parse((await cli('player-trends', '--save', saveId, '--players', alex, '--json')).out).data as Json
    expect(one.players[0].windows[0].matchIds.slice().sort()).toEqual([hemel, torquay].sort())
    expect(hemelRev && torquayRev).toBeTruthy()
  })

  it('AC player-trends Alexander vs Bingham carries per-player score-state minutes, opposition, contributing matches and confounders; the minutes equal the per-match score-state queries over each player segment', async () => {
    const r = reader()
    try {
      const rq = new MatchQueries(r)
      const find = (name: string) => rq.listPlayers({ saveId, nameQuery: name }).players.find((p) => p.identityStatus === 'persistent')!.playerId
      const [alex, bing] = [find('Alexander'), find('Bingham')]
      const body = await rq.playerTrends({ saveId, playerIds: [alex, bing] })
      expect(PlayerTrendsResultSchema.safeParse(body).success).toBe(true)
      // Independent route: the match-level score-state query over each of the player's own on-pitch segments, per match, summed.
      const expectTicks = async (name: string) => {
        const t = { leading: 0, drawing: 0, trailing: 0 }
        for (const m of [hemel, torquay]) {
          const segs = r.showMatch(m).roster.find((p) => p.name.includes(name))!.participation.segments
          for (const s of segs) {
            const q = await rq.scoreState(m, farnham, { window: { from: `${s.period}:${s.fromTick}`, to: `${s.period}:${s.toTick}` } })
            const v = q.scoreState.value!
            t.leading += v.ticks.leading; t.drawing += v.ticks.drawing; t.trailing += v.ticks.trailing
          }
        }
        return t
      }
      for (const [i, name] of [[0, 'Alexander'], [1, 'Bingham']] as const) {
        const w = body.players[i]!.windows[0]!
        expect(w.scoreState!.value!.ticks, name).toEqual(await expectTicks(name))
        expect(w.contributing).toEqual({ matches: 2 })
        expect(w.opposition!.slice().sort()).toEqual(['Hemel Hempstead', 'Torquay'])
      }
      // Measured on these two recordings (not derived from the code under test): Alexander and Bingham pooled over both matches.
      const mins = (i: number) => body.players[i]!.windows[0]!.scoreState!.value!.minutes
      expect(MEASURED_SCORE_STATE.alexander).toEqual(mins(0))
      expect(MEASURED_SCORE_STATE.bingham).toEqual(mins(1))
      const c = body.comparisons[0]!
      expect(c.confounders).toEqual(MEASURED_CONFOUNDERS)
      expect(c.status).toBe(MEASURED_COMPARISON_STATUS) // the finding is reported, never suppressed by a confounder
      // The CLI shows the same context, and the MCP result equals the CLI JSON.
      const text = await cli('player-trends', '--save', saveId, '--players', `${alex},${bing}`)
      expect(text.out).toMatch(/score state while on pitch/)
      expect(text.out).toMatch(/context flags \(not adjusted for; the finding is not suppressed\)/)
      const sdk = await mcp.call('get_player_trends', { saveId, playerIds: [alex, bing] })
      expect(sdk.data).toEqual(JSON.parse((await cli('player-trends', '--save', saveId, '--players', `${alex},${bing}`, '--json')).out).data)
    } finally { r.close() }
  })

  it('AC wing trend on the two real recordings: pooled lanes reconcile to the per-match threat reports and the shot counters; MCP stays under 20 KB', async () => {
    const sdk = await mcp.call('get_season_trends', { saveId, teamId: farnham })
    expect(sdk.isError, sdk.text.slice(0, 300)).toBe(false)
    expect(Buffer.byteLength(sdk.text, 'utf8')).toBeLessThan(20 * KB)
    const wing = sdk.data.windows[0].wing as Json
    expect(wing.contributing.matches).toBe(2)
    const r = reader()
    try {
      const lanes = ['left', 'centre', 'right']
      const laneShots = (d: Json) => lanes.reduce((a, l) => a + d.byLane[l].shots[0], 0) + d.withoutLocation.shots
      const f = (id: string) => { const s = r.showMatch(id); return { own: s.teamTotals[s.managedSide!], opp: s.teamTotals[s.managedSide === 'home' ? 'away' : 'home'] } }
      // every shot event has a location here, so lanes plus unlocated shots equal the shot counters of both recordings exactly
      expect(laneShots(wing.for)).toBe(f(hemel).own.shots! + f(torquay).own.shots!)
      expect(laneShots(wing.against)).toBe(f(hemel).opp.shots! + f(torquay).opp.shots!)
      // xG per lane is rounded to 4 decimals in the result (registry rounding), so the bound allows 3 x 5e-5 of rounding.
      // xG: lane xG plus the unattributed remainder is bounded by the team xG (nothing is invented)
      const laneXg = (d: Json) => lanes.reduce((a, l) => a + d.byLane[l].xg[0], 0)
      expect(laneXg(wing.for)).toBeLessThanOrEqual(f(hemel).own.xg! + f(torquay).own.xg! + 1e-3)
      expect(laneXg(wing.against)).toBeLessThanOrEqual(f(hemel).opp.xg! + f(torquay).opp.xg! + 1e-3)
      if (wing.for.xgUnattributedShots === 0) expect(laneXg(wing.for)).toBeCloseTo(f(hemel).own.xg! + f(torquay).own.xg!, 4)
      // per-lane equality with the per-match threat query: Torquay's lanes against Farnham are the Torquay match's 'against' side
      const rq = new MatchQueries(r)
      const tq = (await rq.threat(torquay, farnham)).threat.byLane, th = (await rq.threat(hemel, farnham)).threat.byLane
      for (const l of tq) {
        const other = th.find((x) => x.lane === l.lane)!
        expect(wing.against.byLane[l.lane].crosses[0]).toBe(l.crosses + other.crosses)
        expect(wing.against.byLane[l.lane].dangerAreaEntries[0]).toBe(l.dangerAreaEntries + other.dangerAreaEntries)
      }
    } finally { r.close() }
  })
})
