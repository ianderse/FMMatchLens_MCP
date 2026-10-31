// TEST-ONLY synthetic FMLens 2.8 archive writer (spec 5). Produces small, fully synthetic recordings; contains no
// real player or club data. Every frame is written as a keyframe so the encoder stays small. The byte layout mirrors
// what the vendored decoder reads (packages/fmlens-adapter/src/upstream/archiveParser.ts); it is not an independent
// description of the format, so decoder bugs that mirror encoder bugs would not be caught by these tests alone.
import { deflateSync } from 'node:zlib'

export type Side = 'home' | 'away'

export interface SynthPlayer {
  slot: number
  playerId: number
  uid?: number | null
  side: Side
  name: string
  position?: string
  shirt?: number
  startsOnPitch: boolean
}

export interface SynthEvent {
  sequenceIndex: number
  tick: number
  type: number
  flags?: number
  team: Side
  playerId: number
  receiverId?: number
  lateral?: number
  longitudinal?: number
  completionTick?: number
  /** Trajectory points (at most 4), source metres. The last point is the pass end. */
  trajectory?: Array<{ lateral: number; longitudinal: number }>
  /** From this tick on, the event is re-sent with different flags (a new version). */
  reviseFlags?: { fromTick: number; flags: number }
}

export interface SynthPeriod { period: number; fromTick: number; toTick: number; step: number; displayOffset: number }

export type PlayerStatKey =
  | 'passes' | 'passesCompleted' | 'aerials' | 'aerialsWon' | 'shots' | 'goals' | 'assists' | 'xg' | 'progressivePasses'
  | 'keyPasses' | 'crosses' | 'crossesCompleted' | 'throwIns'

export interface SynthOptions {
  upstreamMatchId?: string
  startedUnixMs?: number
  minor?: number
  homeName?: string
  awayName?: string
  homeUid?: number
  awayUid?: number
  humanSide?: Side
  matchDate?: string
  competitionName?: string
  players?: SynthPlayer[]
  periods?: SynthPeriod[]
  /** Explicit frame ticks (overrides periods) for gap tests. */
  frameTicks?: Array<{ period: number; tick: number; displayOffset?: number }>
  subs?: Array<{ tick: number; off: number; on: number }>
  goals?: Array<{ tick: number; side: Side }>
  stats?: (tick: number, playerId: number) => Partial<Record<PlayerStatKey, number>>
  events?: SynthEvent[]
  roleChanges?: Array<{ capturedTick: number; playerId: number; position: string; role: string; duty: string }>
  cleanClose?: boolean
  framesPerBlock?: number
  compress?: boolean
  halfWidth?: number
  halfLength?: number
  /** Declare identical metadata revision numbers twice (revision disorder). */
  duplicateMetadataRevision?: boolean
}

export interface SynthLayout {
  headerLength: number
  blockOffsets: number[]
  /** Offset of each block's compressed payload start and its length. */
  blockPayloads: Array<{ offset: number; length: number }>
  endOffset: number | null
}
export interface SynthArchive { bytes: Buffer; layout: SynthLayout; options: Required<Pick<SynthOptions, 'upstreamMatchId'>> }

// ---------------------------------------------------------------- low-level writer
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (~c) >>> 0
}

class W {
  private a: number[] = []
  get length() { return this.a.length }
  u8(v: number) { this.a.push(v & 0xff); return this }
  u16(v: number) { return this.u8(v).u8(v >> 8) }
  u32(v: number) { return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff) }
  i32(v: number) { return this.u32(v >>> 0) }
  i64(v: bigint) { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, v, true); for (let i = 0; i < 8; i++) this.u8(d.getUint8(i)); return this }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); return this }
  varuint(v: number | bigint) { let n = BigInt(v); do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; this.u8(byte) } while (n > 0n); return this }
  varint(v: number) { const n = BigInt(v); return this.varuint(n >= 0n ? n << 1n : ((-n) << 1n) - 1n) }
  bool(v: boolean) { return this.u8(v ? 1 : 0) }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.a.push(b[i]!); return this }
  str(s: string) { const b = Buffer.from(s, 'utf8'); this.varuint(b.length); return this.bytes(b) }
  floatXorBits(prev: number, next: number) {
    const d = new DataView(new ArrayBuffer(8))
    d.setFloat32(0, prev, true); d.setFloat32(4, next, true)
    return this.varuint((d.getUint32(0, true) ^ d.getUint32(4, true)) >>> 0)
  }
  toBuffer() { return Buffer.from(this.a) }
}

// ---------------------------------------------------------------- scenario
const TEAM_KEYS = [
  'goals', 'xg', 'possessionTime', 'shots', 'shotsOnTarget', 'shotsOffTarget', 'blockedShots', 'clearCutChances', 'passes',
  'passesCompleted', 'crosses', 'crossesCompleted', 'aerials', 'aerialsWon', 'progressivePasses', 'finalThirdPasses',
  'tacklesAttempted', 'tacklesWon', 'fouls', 'corners', 'offsides', 'yellowCards', 'redCards', 'firstHalfShots', 'secondHalfShots',
] as const
const PLAYER_INT_STATS = [
  'shots', 'shotsOnTarget', 'blockedShots', 'clearCutChances', 'hitWoodwork', 'dribbles', 'fouls', 'fouled', 'crosses', 'crossesCompleted',
  'passes', 'passesCompleted', 'keyPasses', 'tacklesAttempted', 'tacklesWon', 'keyTackles', 'aerials', 'aerialsWon', 'interceptions',
  'throwIns', 'corners', 'defensiveFreeKicks', 'attackingFreeKicks', 'clearances', 'shotsFaced',
  'overallPhysicalCondition', 'matchSharpness', 'savesHeld', 'savesParried', 'savesTipped', 'progressivePasses',
] as const

export function defaultPlayers(): SynthPlayer[] {
  const out: SynthPlayer[] = []
  for (const side of ['home', 'away'] as const) {
    for (let i = 0; i < 14; i++) {
      const slot = (side === 'home' ? 0 : 14) + i
      out.push({ slot, playerId: (side === 'home' ? 1000 : 2000) + i, uid: (side === 'home' ? 1000 : 2000) + i, side,
        name: `${side === 'home' ? 'Home' : 'Away'} Player ${i}`, position: i === 0 ? 'GK' : i >= 9 && i <= 10 ? 'ST' : 'M', shirt: i + 1, startsOnPitch: i < 11 })
    }
  }
  return out
}

export function defaultPeriods(): SynthPeriod[] {
  return [
    { period: 1, fromTick: 3, toTick: 11041, step: 60, displayOffset: 1 },
    { period: 2, fromTick: 11124, toTick: 21700, step: 60, displayOffset: 323 },
  ]
}

interface FrameSpec { period: number; tick: number; displayOffset: number }

function frameSpecs(o: SynthOptions): FrameSpec[] {
  if (o.frameTicks) return o.frameTicks.map((f) => ({ period: f.period, tick: f.tick, displayOffset: f.displayOffset ?? 1 }))
  const out: FrameSpec[] = []
  for (const p of o.periods ?? defaultPeriods()) {
    for (let t = p.fromTick; t < p.toTick; t += p.step) out.push({ period: p.period, tick: t, displayOffset: p.displayOffset })
    out.push({ period: p.period, tick: p.toTick, displayOffset: p.displayOffset })
  }
  return out
}


export function buildSyntheticArchive(o: SynthOptions = {}): SynthArchive {
  const minor = o.minor ?? 8
  const matchId = o.upstreamMatchId ?? 'match-1000000000000'
  const started = o.startedUnixMs ?? 1_000_000_000_000
  const players = o.players ?? defaultPlayers()
  const halfW = o.halfWidth ?? 34.3125, halfL = o.halfLength ?? 50.325
  const specs = frameSpecs(o)
  const subs = [...(o.subs ?? [])].sort((a, b) => a.tick - b.tick)
  const goals = o.goals ?? []
  const stats: NonNullable<SynthOptions['stats']> = o.stats ?? (() => ({}))
  const evAll = [...(o.events ?? [])].sort((a, b) => a.sequenceIndex - b.sequenceIndex)
  const awayBase = Math.min(...players.filter((p) => p.side === 'away').map((p) => p.slot))
  const sideSlot = (side: Side, pid: number) => { const p = players.find((x) => x.playerId === pid); return p ? p.slot - (side === 'away' ? awayBase : 0) : 255 }

  const out = new W()
  // ---- header
  const mid = Buffer.from(matchId, 'utf8')
  const headerLength = 16 + 8 + (mid.length < 128 ? 1 : 2) + mid.length + 8 + 1 + 2 + 1 + 4
  const h = new W()
  h.bytes(Buffer.from('FMLENS2\0', 'latin1')).u16(2).u16(minor).u32(headerLength)
  h.bytes(new Array(8).fill(0)).str(matchId).i64(BigInt(started)).u8(1).u16(0).u8(o.compress === false ? 0 : 1)
  const hb = h.toBuffer()
  out.bytes(hb).u32(crc32(hb))

  const record = (type: number, payload: Buffer) => { out.u8(type).u32(payload.length).u32(crc32(payload)).bytes(payload) }

  // ---- metadata (strings table)
  const strings: string[] = []
  const sid = (s: string | undefined | null) => { if (s == null || s === '') return 0; let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1 } return i + 1 }
  const nullUint = (w: W, v: number | null | undefined) => { w.bool(v != null); if (v != null) w.varuint(v) }
  const nullInt = (w: W, v: number | null | undefined) => { w.bool(v != null); if (v != null) w.varint(v) }
  const body = new W()
  const team = (s: Side) => {
    nullUint(body, s === 'home' ? (o.homeUid ?? 11) : (o.awayUid ?? 22)); nullUint(body, s === 'home' ? (o.homeUid ?? 11) : (o.awayUid ?? 22))
    body.varuint(sid(s === 'home' ? (o.homeName ?? 'Synth Home') : (o.awayName ?? 'Synth Away')))
    nullUint(body, 1); nullUint(body, 2); nullUint(body, 3); body.varuint(0)
    if (minor >= 7) { nullUint(body, null); nullUint(body, null); nullUint(body, null) }
  }
  team('home'); team('away')
  body.varuint(players.length)
  for (const p of players) {
    body.varuint(p.slot).varint(p.playerId); nullUint(body, p.uid === undefined ? p.playerId : p.uid)
    body.u8(p.side === 'away' ? 1 : 0); nullInt(body, p.shirt ?? null); if (minor >= 7) nullInt(body, p.shirt ?? null)
    body.varuint(sid(p.position ?? 'M')).bool(false).bool(false).bool(false)
    body.varuint(0).varuint(0).varuint(0).varuint(sid(p.name))
    if (minor >= 7) body.varuint(0)
    body.varuint(0).bool(false).bool(false)
  }
  // extension: date(1) managers(2) pitch(4) competition(8)
  const ext = 1 | 2 | 4 | 8
  body.u8(ext)
  body.str(o.matchDate ?? '2026-08-31')
  for (const s of ['home', 'away'] as const) { body.bool(true); nullUint(body, 5); body.varuint(0).varuint(0).bool(o.humanSide === s) }
  body.f32(halfW).f32(halfL)
  nullUint(body, 99); body.varuint(sid(o.competitionName ?? 'Synthetic League')); body.varuint(0); nullUint(body, null); nullUint(body, null); nullUint(body, null)
  const meta = (revision: number) => {
    const w = new W().varuint(revision).varint(-1).varuint(strings.length)
    for (const s of strings) w.str(s)
    return Buffer.concat([w.toBuffer(), body.toBuffer()])
  }
  record(1, meta(1))
  if (o.duplicateMetadataRevision) record(1, meta(1))


  // ---- metadata deltas (role changes)
  let metaRevision = 1
  for (const rc of [...(o.roleChanges ?? [])].sort((a, b) => a.capturedTick - b.capturedTick)) {
    const ds: string[] = []
    const dsid = (s: string) => { let i = ds.indexOf(s); if (i < 0) { ds.push(s); i = ds.length - 1 } return i + 1 }
    const dbody = new W().u8(0).varuint(1).u8(0x02).varint(rc.playerId).bool(true).varuint(1)
      .varuint(dsid(rc.position)).varuint(0).varuint(dsid(rc.role)).varuint(dsid(rc.role.slice(0, 3))).varuint(dsid(rc.duty))
      .u8(0)
    const dw = new W().varuint(++metaRevision).varint(rc.capturedTick).varuint(ds.length)
    for (const s of ds) dw.str(s)
    record(5, Buffer.concat([dw.toBuffer(), dbody.toBuffer()]))
  }

  // ---- frames
  const framesPerBlock = o.framesPerBlock ?? 50
  const blockOffsets: number[] = []
  const blockPayloads: Array<{ offset: number; length: number }> = []
  const blockInfo: Array<{ start: number; end: number; offset: number; clen: number; frames: number }> = []
  const isOn = (tick: number, p: SynthPlayer) => {
    let on = p.startsOnPitch
    for (const s of subs) { if (s.tick > tick) break; if (s.off === p.playerId) on = false; if (s.on === p.playerId) on = true }
    return on
  }
  const goalsAt = (tick: number, side: Side) => goals.filter((g) => g.side === side && g.tick <= tick).length
  let seq = 186_000
  let lastGoals = { home: 0, away: 0 }
  const evVersion = (e: SynthEvent, tick: number) => (e.reviseFlags && e.reviseFlags.fromTick <= tick ? e.reviseFlags.flags : (e.flags ?? 1))
  type EvRow = { eventIndex: number; e: SynthEvent; flags: number }

  for (let bs = 0; bs < specs.length; bs += framesPerBlock) {
    const chunk = specs.slice(bs, bs + framesPerBlock)
    const fw = new W()
    let prev: { seq: number; tick: number; display: number; cap: number; period: number; team: Record<Side, Record<string, number>>; events: EvRow[] } | null = null
    for (const fs of chunk) {
      const display = fs.tick - fs.displayOffset
      seq += 3
      const cap = started + fs.tick * 250
      fw.u8(1 | 2 | 4 | 8 | 16).varint(seq - (prev?.seq ?? 0)).varint(fs.tick - (prev?.tick ?? 0)).varint(display - (prev?.display ?? 0))
        .varint(cap - (prev?.cap ?? 0)).varint(fs.period - (prev?.period ?? 0))
      fw.u8(0).varuint(0)
      fw.varint(0).varint(0).varint(0)
      fw.f32(halfW).f32(halfL)
      const ps = players.map((p) => ({ p, on: isOn(fs.tick, p), st: stats(fs.tick, p.playerId) }))
      const teamVals: Record<Side, Record<string, number>> = { home: {}, away: {} }
      for (const side of ['home', 'away'] as const) {
        for (const k of TEAM_KEYS) teamVals[side][k] = 0
        teamVals[side].goals = goalsAt(fs.tick, side)
        for (const x of ps.filter((q) => q.p.side === side)) {
          for (const k of ['passes', 'passesCompleted', 'crosses', 'crossesCompleted', 'aerials', 'aerialsWon', 'shots', 'progressivePasses'] as const) {
            teamVals[side][k] = (teamVals[side][k] ?? 0) + (x.st[k] ?? 0)
          }
          teamVals[side].xg = Math.fround((teamVals[side].xg ?? 0) + (x.st.xg ?? 0))
        }
      }
      for (const side of ['home', 'away'] as const) {
        const priorT = prev?.team[side] ?? Object.fromEntries(TEAM_KEYS.map((k) => [k, 0]))
        let mask = 0n
        const fieldsW = new W()
        TEAM_KEYS.forEach((k, bit) => {
          const nv = teamVals[side][k]!, pv = priorT[k]!
          if (nv === pv) return
          mask |= 1n << BigInt(bit)
          if (k === 'xg') fieldsW.floatXorBits(pv, nv); else fieldsW.varint(nv - pv)
        })
        fw.varuint(mask).bytes(fieldsW.toBuffer())
      }
      fw.varuint(ps.length)
      for (const { p, on, st } of ps) {
        fw.varuint(p.slot).varint(p.playerId).u8(p.side === 'away' ? 1 : 0)
        const x = on ? ((p.slot % 14) - 7) * 4.5 : -39.25
        const y = on ? (p.side === 'home' ? 1 : -1) * ((p.slot % 14) * 3.5) : 0
        fw.u16(Math.round(x * 100) & 0xffff).u16(Math.round(y * 100) & 0xffff)
        fw.varuint(0).varuint(361)
        fw.floatXorBits(0, 6.7)
        fw.bool(!p.startsOnPitch).bool(on)
        // subbedOnMinute, subbedOffMinute, penalties, ownGoals, goals, assists
        fw.varint(0).varint(0).varint(0).varint(0).varint(st.goals ?? 0).varint(st.assists ?? 0)
        fw.floatXorBits(0, st.xg ?? 0).floatXorBits(0, 0)
        for (const k of PLAYER_INT_STATS) fw.varint((st as Record<string, number>)[k] ?? 0)
        fw.varint(0) // distanceM
      }
      // events: rolling tail of the 64 most recent events seen so far
      const visible = evAll.filter((e) => e.tick <= fs.tick).slice(-64)
      const rows: EvRow[] = visible.map((e, i) => ({ eventIndex: i, e, flags: evVersion(e, fs.tick) }))
      const same = (a: EvRow, b: EvRow) => a.eventIndex === b.eventIndex && a.e === b.e && a.flags === b.flags
      let common = 0
      const pe = prev?.events ?? []
      while (common < pe.length && common < rows.length && same(pe[common]!, rows[common]!)) common++
      fw.varuint(common).varuint(rows.length - common)
      for (const r of rows.slice(common)) {
        const e = r.e
        fw.varint(r.eventIndex).varint(e.tick).f32(e.lateral ?? 0).f32(e.longitudinal ?? 0).u8(e.team === 'away' ? 1 : 0)
          .varint(sideSlot(e.team, e.playerId)).varint(e.playerId)
          .varint(e.receiverId ? sideSlot(e.team, e.receiverId) : 255).varint(e.receiverId ?? 0)
          .varint(e.type).varint(r.flags).varint(e.sequenceIndex).varint(e.completionTick ?? e.tick).varuint((e.trajectory ?? []).length)
        for (const pt of e.trajectory ?? []) fw.f32(pt.lateral).f32(pt.longitudinal)
      }
      fw.varuint(0).varuint(0).varuint(0).varuint(0)
      fw.bool(false) // no rating research
      prev = { seq, tick: fs.tick, display, cap, period: fs.period, team: teamVals, events: rows }
      lastGoals = { home: teamVals.home.goals!, away: teamVals.away.goals! }
    }
    const raw = fw.toBuffer()
    const comp = o.compress === false ? raw : deflateSync(raw)
    const start = chunk[0]!.tick, end = chunk[chunk.length - 1]!.tick
    const rec = new W().u8(2)
    const tail = new W().u32(0x324b4c42).u16(o.compress === false ? 0 : 1).i32(start).i32(end).u16(chunk.length)
      .u32(raw.length).u32(comp.length).u32(crc32(raw))
    const recStart = out.length
    blockOffsets.push(recStart)
    const headBytes = Buffer.concat([rec.toBuffer(), tail.toBuffer()])
    out.bytes(headBytes).u32(crc32(headBytes))
    blockPayloads.push({ offset: out.length, length: comp.length })
    out.bytes(comp)
    blockInfo.push({ start, end, offset: recStart, clen: comp.length, frames: chunk.length })
  }

  let endOffset: number | null = null
  if (o.cleanClose !== false) {
    const fi = new W().varuint(specs.length).varint(specs[0]!.tick).varint(specs[specs.length - 1]!.tick)
      .varint(lastGoals.home).varint(lastGoals.away).varuint(blockInfo.length)
    for (const b of blockInfo) fi.varint(b.start).varint(b.end).varuint(b.offset).varuint(b.clen).varuint(b.frames)
    record(3, fi.toBuffer())
    endOffset = out.length
    record(4, new W().i64(BigInt(started + 60_000)).toBuffer())
  }
  return {
    bytes: out.toBuffer(),
    layout: { headerLength, blockOffsets, blockPayloads, endOffset },
    options: { upstreamMatchId: matchId },
  }
}
