// `fmmi live capture` and `fmmi live check` (Slice 5): the diagnostic the user runs during a REAL match to close the gap between what is
// modelled and what the plugin serves. These tests run it against the MODELLED fake plugin (tests/support/fakePlugin.ts) and prove only
// that the tooling works: it sanitises, it saves locally, it detects a changed shape and it refuses to call a partial capture verified.
// It has not been run against a real match.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { checkCapture, sanitize } from '@fmmi/live'
import type { Capture } from '@fmmi/live'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { rig, syntheticReplay } from '../support/live.ts'
import type { Json } from '../support/mcp.ts'

afterAll(cleanupAll)

function cli(home: string, livePort?: number) {
  return async (...args: string[]) => {
    const out: string[] = [], err: string[] = []
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home }, livePort }
    const code = await main([...args, '--json'], io)
    return { code, body: out.length ? (JSON.parse(out.join('\n')) as Json) : null, err: err.join('\n'), text: out.join('\n') }
  }
}
const textCli = (home: string, livePort?: number) => async (...args: string[]) => {
  const out: string[] = [], err: string[] = []
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: home }, livePort })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('[S4][MODELLED] fmmi live capture / check', () => {
  it('capture saves sanitised shapes under <home>/live-capture; check validates them: every endpoint and the socket match, so this capture verifies the path (for the model)', async () => {
    const { replay } = await syntheticReplay({ roleChanges: [{ capturedTick: 4000, playerId: 1003, position: 'AMC', role: 'Advanced Playmaker', duty: 'Support' }] })
    const r = await rig(replay)
    r.plugin.advance(150)
    r.plugin.revealFormation(1)
    const home = tmp('fmmi-cap-')
    // the plugin pushes both envelope kinds while the capture listens
    const timer = setInterval(() => { r.plugin.pushTick(); r.plugin.pushFormation(0) }, 60)
    const res = await cli(home, r.plugin.boundPort)('live', 'capture', '--socket-seconds', '1')
    clearInterval(timer)
    expect(res.code, res.err).toBe(0)
    const file = res.body!.data.file as string
    expect(file.startsWith(join(home, 'live-capture'))).toBe(true)
    expect(res.body!.data.endpoints.every((e: Json) => e.ok)).toBe(true)
    expect(res.body!.data.websocket).toMatchObject({ attempted: true, opened: true })
    expect(res.body!.data.websocket.messages).toEqual(expect.arrayContaining(['realtime_tick', 'formation_changed']))
    // it only asked the allowed routes, once each
    expect(r.plugin.hits.map((h) => h.path.split('?')[0])).toEqual(['/api/health', '/api/archives', '/api/match/status', '/api/match/meta', '/api/match/current', '/api/match/frames', '/api/match/formation/history', '/api/match/momentum/events', '/api/match/momentum/updates'])

    const saved = JSON.parse(readFileSync(file, 'utf8')) as Capture
    expect(saved.host).toBe('127.0.0.1')
    // sanitised: no name, no club, no identifier survives; arrays are cut to two elements with their length recorded
    const raw = readFileSync(file, 'utf8')
    for (const secret of ['Home Player', 'Away Player', 'Synth Home', 'Synth Away', 'Synthetic League', 'match-synth-1', 'Advanced Playmaker', '2026-08-31']) expect(raw, secret).not.toContain(secret)
    const meta = saved.endpoints.find((e) => e.id === 'meta')!.skeleton as Json
    expect(meta.players).toHaveLength(2)
    expect(meta.players__length).toBe(28)
    expect(meta.players[0]).toMatchObject({ playerId: 0, uid: 0, slot: 0, displayName: 'x' })
    expect(saved.endpoints.find((e) => e.id === 'health')!.skeleton).toMatchObject({ status: 'recording', pluginVersion: '0.7.0', game: 'Football Manager' }) // enum-like keys keep their value

    const chk = await cli(home)('live', 'check')
    expect(chk.code, chk.text).toBe(0)
    expect(chk.body!.data).toMatchObject({ ok: true, verifiesLivePath: true })
    expect(chk.body!.data.lines.map((l: Json) => l.verdict).every((v: string) => v === 'ok')).toBe(true)
    expect(chk.body!.data.lines.find((l: Json) => l.id === 'health').basis).toBe('observed')
    expect(chk.body!.data.lines.find((l: Json) => l.id === 'frames').basis).toBe('modelled')
    const text = await textCli(home)('live', 'check', file)
    expect(text.out).toMatch(/Live capture check: no mismatch, complete/)
    expect(text.out).toMatch(/ONE real capture/)
    await r.close()
  }, 60_000)

  it('check detects a changed endpoint: a removed counter, a retyped field and a changed envelope are named, exit code 1, and the capture does not verify the path', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.advance(60)
    const home = tmp('fmmi-cap-')
    const timer = setInterval(() => r.plugin.pushTick(), 60)
    const res = await cli(home, r.plugin.boundPort)('live', 'capture', '--socket-seconds', '1')
    clearInterval(timer)
    const file = res.body!.data.file as string
    const cap = JSON.parse(readFileSync(file, 'utf8')) as Capture

    const bad = structuredClone(cap)
    const frames = bad.endpoints.find((e) => e.id === 'frames')!.skeleton as Json
    delete frames.frames[0].home.passesCompleted // a counter the plugin no longer sends
    const health = bad.endpoints.find((e) => e.id === 'health')!.skeleton as Json
    health.inMatch = 'yes' // a retyped field
    const meta = bad.endpoints.find((e) => e.id === 'meta')!.skeleton as Json
    meta.extraTopLevel = 1 // an additive change: reported, not a failure
    const tick = bad.websocket.messages.find((m) => m.type === 'realtime_tick')!
    ;(tick.skeleton as Json).payload = 'not-a-frame'
    const report = checkCapture(bad)
    const by = Object.fromEntries(report.lines.map((l) => [l.id, l]))
    expect(report.ok).toBe(false)
    expect(report.verifiesLivePath).toBe(false)
    expect(by.frames).toMatchObject({ verdict: 'schema_mismatch' })
    expect(by.frames!.detail).toMatch(/passesCompleted/)
    expect(by.health).toMatchObject({ verdict: 'schema_mismatch' })
    expect(by.health!.detail).toMatch(/inMatch/)
    expect(by.meta).toMatchObject({ verdict: 'ok' })
    expect(by.meta!.extraKeys).toContain('extraTopLevel')
    expect(by.ws_realtime_tick).toMatchObject({ verdict: 'schema_mismatch' })
    expect(report.summary).toMatch(/will report schema_mismatch for them and degrade/)

    const badFile = join(tmp('fmmi-cap-'), 'bad.json')
    writeFileSync(badFile, JSON.stringify(bad))
    const chk = await cli(home)('live', 'check', badFile)
    expect(chk.code).toBe(1)
    expect(chk.body!.data.ok).toBe(false)
    await r.close()
  }, 60_000)

  it('a capture taken with no match running, or without the socket, is reported as incomplete and never as verified', async () => {
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    r.plugin.inMatch = false // revealed = 0: meta and current answer null
    const home = tmp('fmmi-cap-')
    const res = await cli(home, r.plugin.boundPort)('live', 'capture', '--socket-seconds', '0')
    expect(res.code).toBe(0) // the plugin answered, so the capture itself worked
    const chk = await cli(home)('live', 'check', res.body!.data.file)
    const lines = Object.fromEntries((chk.body!.data.lines as Json[]).map((l) => [l.id, l]))
    expect(lines.meta.verdict).toBe('no_match_data')
    expect(lines.current.verdict).toBe('no_match_data')
    expect(lines.ws_realtime_tick.verdict).toBe('not_captured')
    expect(chk.body!.data.verifiesLivePath).toBe(false)
    expect(chk.body!.data.summary).toMatch(/remains unverified/)
    await r.close()
  }, 60_000)

  it('plugin not running: status and capture fail with a clear message and exit 1; check needs a capture file and says how to make one', async () => {
    const home = tmp('fmmi-cap-')
    const { replay } = await syntheticReplay()
    const r = await rig(replay)
    const port = r.plugin.boundPort
    await r.plugin.stop()
    const st = await textCli(home, port)('live', 'status')
    expect(st.code).toBe(1)
    expect(st.out).toMatch(/not reachable on 127\.0\.0\.1/)
    const cap = await cli(home, port)('live', 'capture', '--socket-seconds', '0')
    expect(cap.code).toBe(1)
    expect(cap.body!.data.endpoints.every((e: Json) => !e.ok)).toBe(true)
    const none = await cli(tmp('fmmi-cap-'))('live', 'check')
    expect(none.code).toBe(1)
    expect(none.body!.error).toMatchObject({ code: 'not_found', details: { reason: 'no_capture' } })
    const junk = join(tmp('fmmi-cap-'), 'junk.json'); writeFileSync(junk, '{"hello":1}')
    expect((await cli(home)('live', 'check', junk)).body!.error).toMatchObject({ code: 'invalid_input', details: { reason: 'capture_file' } })
    expect((await textCli(home)('live', 'bogus')).code).toBe(2)
    r.reader.close()
  }, 60_000)

  it('the default output directory is gitignored, and the sanitiser keeps structure only', () => {
    const ignore = readFileSync(join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^live-capture\/$/m)
    expect(ignore).toMatch(/^\.fmmi\/$/m)
    const s = sanitize({ status: 'live', name: 'A Real Name', path: 'C:\\Users\\me\\x.png', uid: 123456, playerId: 99, goals: 3, list: [{ team: 'home', displayName: 'Z' }, 2, 3, 4], nested: { deep: { a: [1, 2, 3] } } }) as Json
    expect(s).toEqual({ status: 'live', name: 'x', path: 'x', uid: 0, playerId: 0, goals: 3, list: [{ team: 'home', displayName: 'x' }, 2], list__length: 4, nested: { deep: { a: [1, 2] , a__length: 3 } } })
    expect(existsSync(join(tmp('fmmi-cap-'), 'nothing'))).toBe(false)
    expect(readdirSync(tmp('fmmi-cap-'))).toEqual([])
  })
})
