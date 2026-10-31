// TEST-ONLY multi-match season fixtures for Slice 4. Every recording is a LABELLED SYNTHETIC archive written by the test-only
// archive writer into a temporary directory (never into tests/fixtures/local). The club, player and opponent names are invented.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Side } from '@fmmi/model'
import { CatalogService } from '@fmmi/store'
import { buildScenario } from './scenario.ts'
import { buildSyntheticArchive } from './syntheticArchive.ts'
import type { SynthOptions, SynthPeriod } from './syntheticArchive.ts'
import { FULL_PERIODS, tmp } from './helpers.ts'

export const CLUB = 'Synthetic Town'
export const CLUB_UID = 8_000_001
const ALEXANDER = 9, BINGHAM = 11, SPONG = 3

export interface SeasonMatch {
  key: string
  date: string
  /** The side the club plays on. */
  side: Side
  opponent: string
  goals?: Array<{ tick: number; side: Side }>
  periods?: SynthPeriod[]
  passesPerSide?: number
  /** All passes completed with a receiver (the recipient gate can pass). Default true. */
  pureCompleted?: boolean
  dropReceiver?: (side: Side, k: number) => boolean
  /** Striker aerial counters from tick 3000 on (default: the scenario 0 of 7). */
  strikerAerials?: { attempts: number; won: number }
  /** Another club forward: shots and xG from tick 5000 on. */
  teamShots?: { shots: number; xg: number }
  /** Playmaker progressive-pass counter from tick 5000 on. */
  spongProgressive?: number
  /** Bingham replaces Alexander at this tick (default 14003). */
  subTick?: number
  /** Overrides applied to the club players' upstream uid, by shirt index (default 5000 + index). */
  uidOverride?: Record<number, number | null>
  nameOverride?: Record<number, string>
  upstreamMatchId?: string
  /** Raw archive-writer options merged last (for example roleChanges). */
  synth?: Partial<SynthOptions>
}

/** Periods whose captured span is exactly `ticks` ticks (period 1 is 10 800 ticks, period 2 holds the rest). 240 ticks are one game minute. */
export const periodsOf = (ticks: number): SynthPeriod[] => [
  { period: 1, fromTick: 3, toTick: 10803, step: 60, displayOffset: 1 },
  { period: 2, fromTick: 11124, toTick: 11124 + (ticks - 10800), step: 60, displayOffset: 323 },
]

const base = (s: Side) => (s === 'home' ? 1000 : 2000)

export async function buildSeasonMatch(m: SeasonMatch): Promise<SynthOptions> {
  const club = base(m.side), opp = base(m.side === 'home' ? 'away' : 'home')
  const names: Record<number, string> = {}, uids: Record<number, number | null> = {}
  for (let i = 0; i < 14; i++) {
    names[club + i] = m.nameOverride?.[i] ?? (i === ALEXANDER ? 'George Alexander' : i === BINGHAM ? 'Rakish Bingham' : i === SPONG ? 'Jack Spong' : `Synth Player ${i}`)
    uids[club + i] = m.uidOverride && i in m.uidOverride ? m.uidOverride[i]! : 5000 + i
    names[opp + i] = `${m.opponent} Player ${i}`
    uids[opp + i] = (oppUid(m.opponent) % 100_000) * 100 + i
  }
  const striker = club + ALEXANDER, wide = club + 10, mid = club + SPONG
  const sc = await buildScenario({
    humanSide: m.side, strikerSide: m.side, homeName: m.side === 'home' ? CLUB : m.opponent, awayName: m.side === 'away' ? CLUB : m.opponent,
    passesPerSide: m.passesPerSide ?? 120, pureCompleted: m.pureCompleted ?? true, dropReceiver: m.dropReceiver, trajectory: true, goals: m.goals, periods: m.periods ?? FULL_PERIODS, subTick: m.subTick,
    names, uids,
    extraStats: (tick, pid) => {
      if (pid === striker && m.strikerAerials) return tick >= 3000 ? { aerials: m.strikerAerials.attempts, aerialsWon: m.strikerAerials.won } : { aerials: 0, aerialsWon: 0 }
      if (pid === wide && m.teamShots && tick >= 5000) return { shots: m.teamShots.shots, xg: Math.fround(m.teamShots.xg) }
      if (pid === mid && m.spongProgressive !== undefined && tick >= 5000) return { progressivePasses: m.spongProgressive }
      return {}
    },
  })
  return {
    ...sc.synth, upstreamMatchId: m.upstreamMatchId ?? `match-synth-${m.key}`, matchDate: m.date,
    homeUid: m.side === 'home' ? CLUB_UID : oppUid(m.opponent), awayUid: m.side === 'away' ? CLUB_UID : oppUid(m.opponent),
    ...(m.synth ?? {}),
  }
}

const oppUid = (name: string) => 9_000_000 + [...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 90_000

export function writeSynth(synth: SynthOptions, name: string): string {
  const f = join(tmp('fmmi-season-'), name)
  writeFileSync(f, buildSyntheticArchive(synth).bytes)
  return f
}

export interface Ingested { key: string; matchId: string; revisionId: string; file: string }

/** Ingests the matches in order into one save. Returns the ids by key. */
export async function ingestSeason(svc: CatalogService, saveId: string, ms: SeasonMatch[]): Promise<Record<string, Ingested>> {
  const out: Record<string, Ingested> = {}
  for (const m of ms) {
    const file = writeSynth(await buildSeasonMatch(m), `${m.key}.fmlens`)
    const r = await svc.ingestFile(file, saveId)
    if (r.status !== 'ingested') throw new Error(`season ingest failed for ${m.key}: ${r.status} ${JSON.stringify(r.error)}`)
    out[m.key] = { key: m.key, matchId: r.matchId!, revisionId: r.recordingRevisionId!, file }
  }
  return out
}

/** Ingests one match (fails the test on anything but a fresh ingest). */
export async function ingestOne(svc: CatalogService, saveId: string, m: SeasonMatch): Promise<Ingested> {
  return (await ingestSeason(svc, saveId, [m]))[m.key]!
}

/** Confirms a match as full time with its observed score (no --allow-score-change needed). */
export function confirmObserved(svc: CatalogService, matchId: string): void {
  const m = svc.showMatch(matchId)
  svc.confirmMatch(matchId, `${m.result.observed.home}-${m.result.observed.away}`)
}

/** A realistic five-match run for the definition-of-done question. Home/away alternate; results and rates vary. */
export const FIVE: SeasonMatch[] = [
  { key: 'f1', date: '2026-08-08', side: 'home', opponent: 'Horsham Rovers', goals: [{ tick: 5000, side: 'home' }], strikerAerials: { attempts: 7, won: 0 }, teamShots: { shots: 4, xg: 0.9 }, spongProgressive: 3 },
  { key: 'f2', date: '2026-08-15', side: 'away', opponent: 'Torquay Athletic', goals: [{ tick: 6000, side: 'home' }, { tick: 9000, side: 'away' }], strikerAerials: { attempts: 6, won: 1 }, teamShots: { shots: 3, xg: 0.5 }, spongProgressive: 5 },
  { key: 'f3', date: '2026-08-22', side: 'home', opponent: 'Bath Wanderers', goals: [], strikerAerials: { attempts: 5, won: 1 }, teamShots: { shots: 2, xg: 0.3 }, spongProgressive: 4 },
  { key: 'f4', date: '2026-08-29', side: 'away', opponent: 'Chelmsford Albion', goals: [{ tick: 12000, side: 'away' }], strikerAerials: { attempts: 4, won: 2 }, teamShots: { shots: 6, xg: 1.4 }, spongProgressive: 8 },
  { key: 'f5', date: '2026-09-05', side: 'home', opponent: 'Eastbourne Union', goals: [{ tick: 4000, side: 'home' }, { tick: 7000, side: 'home' }, { tick: 15000, side: 'away' }], strikerAerials: { attempts: 5, won: 3 }, teamShots: { shots: 5, xg: 1.1 }, spongProgressive: 6 },
]
