// fmmi sync, the home screen and the --json / non-terminal guarantees. Fake machine, scripted terminal: see tests/support/world.ts.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll } from '../support/helpers.ts'
import { fakeClaude, fillRecordings, mustNotAsk, recording, rig, scripted, world } from '../support/world.ts'
import { FIVE, periodsOf } from '../support/season.ts'

afterAll(cleanupAll)

const open = (home: string) => new CatalogService({ ...loadConfig(home, {}), readOnly: true })
const completion = (home: string) => { const s = open(home); try { return s.listMatches(s.listSaves()[0]!.saveId).matches.map((m) => ({ id: m.matchId, home: m.home.name, away: m.away.name, c: m.status.completion, cov: m.status.coverage, final: m.result.final })) } finally { s.close() } }

/** A set-up machine: two full recordings imported, no partial yet. */
async function ready() {
  const w = world()
  await recording(w.matches, '2026-08-08-Synthetic Town-vs-Horsham Rovers-1-0.fmlens', FIVE[0]!)
  await recording(w.matches, '2026-08-15-Torquay Athletic-vs-Synthetic Town-1-1.fmlens', FIVE[1]!)
  const r = rig(w, { run: fakeClaude({ missing: true }).run })
  const s = await r.run('setup', '--yes', '--no-mcp')
  expect(s.code, s.err).toBe(0)
  return w
}
const addPartial = (w: ReturnType<typeof world>, name = '2026-08-22-Synthetic Town-vs-Bath Wanderers-0-0.fmlens') => recording(w.matches, name, { ...FIVE[2]!, periods: periodsOf(15600) })

describe('fmmi sync', () => {
  it('imports a new recording and asks about a partial one: Enter confirms the observed score', async () => {
    const w = await ready()
    await addPartial(w)
    const term = scripted([''])
    const res = await rig(w, { prompt: term }).run('sync')
    expect(res.code, res.err).toBe(0)
    expect(res.out).toMatch(/Imported Synthetic Town 0-0 Bath Wanderers, 22 Aug \(partial recording\)/)
    expect(term.asked).toEqual(['Synthetic Town 0-0 Bath Wanderers, 22 Aug, partial recording. Final score 0-0? [Y/n/type score] '])
    expect(completion(w.home).find((m) => m.away === 'Bath Wanderers')).toMatchObject({ c: 'completed_manual', final: { home: 0, away: 0 } })
    const svc = open(w.home)
    expect(svc.store.listAudit().filter((a) => a.action.includes('confirm')).length).toBeGreaterThan(0) // recorded with audit
    svc.close()
    // nothing left to ask, and a second sync is quiet
    const again = await rig(w, { prompt: mustNotAsk }).run('sync')
    expect(again.out).toBe('Everything is up to date.')
  })

  it('n skips and leaves it unconfirmed for the next sync, which asks again (earlier imports are included)', async () => {
    const w = await ready()
    await addPartial(w)
    const res = await rig(w, { prompt: scripted(['n']) }).run('sync')
    expect(res.out).toMatch(/skipped \(still unconfirmed; confirm later with: fmmi match confirm m_/)
    expect(completion(w.home).find((m) => m.away === 'Bath Wanderers')!.c).toBe('unknown')
    const term = scripted([''])
    const next = await rig(w, { prompt: term }).run('sync')
    expect(next.out).not.toMatch(/Imported/) // imported earlier, still asked
    expect(term.asked).toHaveLength(1)
    expect(completion(w.home).find((m) => m.away === 'Bath Wanderers')!.c).toBe('completed_manual')
  })

  it('a typed score that differs is asked again before it is stored as the manual final score; declining stores nothing', async () => {
    const w = await ready()
    await addPartial(w)
    const term = scripted(['3-1', 'n', '3-1', 'y'])
    const res = await rig(w, { prompt: term }).run('sync')
    expect(res.code, res.err).toBe(0)
    expect(term.asked[1]).toMatch(/The last observed score is 0-0\. Store 3-1 as the final score\? \[y\/N\]/)
    expect(res.out).toMatch(/not stored/)
    expect(res.out).toMatch(/confirmed 3-1 \(differs from the observed score; stored as the manual final score\)/)
    expect(completion(w.home).find((m) => m.away === 'Bath Wanderers')).toMatchObject({ c: 'completed_manual', final: { home: 3, away: 1 } })
  })

  it('a typed score equal to the observed one needs no second question; nonsense is re-asked and finally skipped', async () => {
    const w = await ready()
    await addPartial(w)
    const same = scripted(['0-0'])
    await rig(w, { prompt: same }).run('sync')
    expect(same.asked).toHaveLength(1)
    const w2 = await ready()
    await addPartial(w2)
    const junk = scripted(['banana', 'x y', '??'])
    const res = await rig(w2, { prompt: junk }).run('sync')
    expect(res.out).toMatch(/Press Enter to confirm, n to skip, or type a score/)
    expect(completion(w2.home).find((m) => m.away === 'Bath Wanderers')!.c).toBe('unknown')
  })

  it('end of input stops asking and lists what is left with its exact command', async () => {
    const w = await ready()
    await addPartial(w)
    const res = await rig(w, { prompt: scripted([]) }).run('sync')
    expect(res.code).toBe(0)
    expect(res.out).toMatch(/1 recording\(s\) wait for your final score/)
    expect(res.out).toMatch(/fmmi match confirm m_[0-9a-f]+ --score 0-0/)
  })

  it('without a terminal it imports, lists what needs confirmation with the exact commands, never asks and never confirms', async () => {
    const w = await ready()
    await addPartial(w)
    const res = await rig(w).run('sync') // no prompt at all: the default io of a pipe or a test
    expect(res.code, res.err).toBe(0)
    expect(res.out).toMatch(/Imported Synthetic Town 0-0 Bath Wanderers/)
    expect(res.out).toMatch(/1 recording\(s\) wait for your final score/)
    expect(res.out).toMatch(/Synthetic Town 0-0 Bath Wanderers, 22 Aug, partial recording\n\s+fmmi match confirm m_[0-9a-f]+ --score 0-0/)
    expect(completion(w.home).find((m) => m.away === 'Bath Wanderers')!.c).toBe('unknown')
  })

  it('--json never prompts, even when a terminal is attached, and reports the pending confirmations', async () => {
    const w = await ready()
    await addPartial(w)
    const res = await rig(w, { prompt: mustNotAsk }).run('sync', '--json')
    expect(res.code, res.err).toBe(0)
    const body = JSON.parse(res.out)
    expect(body.ok).toBe(true)
    expect(body.data.results).toHaveLength(1)
    expect(body.data.confirmation.pending).toHaveLength(1)
    expect(body.data.confirmation.pending[0].command).toMatch(/^fmmi match confirm m_/)
    expect(res.err).toBe('')
  })

  it('skips the file the plugin is still writing (match-<digits>.fmlens) and says so; --include-in-progress imports it', async () => {
    const w = await ready()
    await recording(w.matches, 'match-1767225600000.fmlens', { ...FIVE[3]!, periods: periodsOf(12000) })
    const res = await rig(w).run('sync')
    expect(res.out).toMatch(/Skipped match-1767225600000\.fmlens: the game is still recording this match/)
    expect(completion(w.home)).toHaveLength(2)
    const inc = await rig(w).run('sync', '--include-in-progress')
    expect(inc.out).toMatch(/Imported/)
    expect(completion(w.home)).toHaveLength(3)
  })

  it('full recordings are not asked about by default; --all offers them (to record or correct a score) and a confirmed match is never re-asked', async () => {
    const w = await ready()
    expect((await rig(w, { prompt: mustNotAsk }).run('sync')).out).toBe('Everything is up to date.')
    const term = scripted(['2-1', 'y', 'n'])
    const res = await rig(w, { prompt: term }).run('sync', '--all')
    expect(res.code, res.err).toBe(0)
    expect(term.asked[0]).toMatch(/full recording\. Final score 1-0\?/)
    expect(completion(w.home).filter((m) => m.c === 'completed_manual')).toHaveLength(1)
    const once = scripted(['n'])
    await rig(w, { prompt: once }).run('sync', '--all')
    expect(once.asked).toHaveLength(1) // only the one still unconfirmed
  })

  it('a friendly error names the folder when it is gone, and when nothing is set up', async () => {
    const fresh = world()
    const none = await rig(fresh).run('sync')
    expect(none.code).toBe(1)
    expect(none.err).toMatch(/No save exists yet\. Run: fmmi setup/)
    const w = await ready()
    await fillRecordings(world()) // unrelated world: proves nothing global is read
    const moved = rig(w, { env: { FMMI_HOME: w.home, FMMI_ARCHIVE_DIR: join(w.root, 'moved') } })
    const r = await moved.run('sync')
    expect(r.code).toBe(1)
    expect(r.err).toContain(join(w.root, 'moved'))
    expect(r.err).toMatch(/Run: fmmi setup/)
    expect(r.err).not.toMatch(/\{"reason"/) // the text output does not dump the details object
    const json = JSON.parse((await moved.run('sync', '--json')).out)
    expect(json.error).toMatchObject({ code: 'not_found', details: { reason: 'archive_dir_missing' } }) // the JSON error body keeps its code and details
  })
})

describe('the home screen', () => {
  it('not set up is one line pointing at fmmi setup, exit 0, and it creates nothing', async () => {
    const w = world()
    const res = await rig(w).run()
    expect(res.code).toBe(0)
    expect(res.out.split('\n')).toHaveLength(1)
    expect(res.out).toMatch(/fmmi setup/)
    expect(existsSync(w.home)).toBe(false)
    const json = JSON.parse((await rig(w).run('--json')).out)
    expect(json.data).toMatchObject({ setUp: false, next: 'fmmi setup' })
  })

  it('set up: save, matches, new recordings, what needs confirming, plugin reachability and the next command', async () => {
    const w = await ready()
    const quiet = await rig(w).run()
    expect(quiet.out).toMatch(/Save:\s+Synthetic Town, 2 matches/)
    expect(quiet.out).toMatch(/nothing new/)
    expect(quiet.out).toMatch(/Plugin:\s+not reachable/)
    expect(quiet.out).toMatch(/Next: fmmi report latest/)
    await addPartial(w)
    await recording(w.matches, 'match-1767225600001.fmlens', { ...FIVE[3]!, periods: periodsOf(12000) })
    const busy = await rig(w, { prompt: mustNotAsk }).run()
    expect(busy.out).toMatch(/New:\s+1 recording not imported yet/)
    expect(busy.out).toMatch(/1 still being recorded/)
    expect(busy.out).toMatch(/Next: fmmi sync/)
    await rig(w).run('sync')
    const after = await rig(w).run('--json')
    expect(JSON.parse(after.out).data).toMatchObject({ setUp: true, matches: 3, newRecordings: 0, needConfirming: 1, inProgressRecordings: 1, next: 'fmmi sync' })
    expect(after.err).toBe('')
  })

  it('fmmi --help leads with setup, sync, report and the home screen, and still lists the rest', async () => {
    const res = await rig(world()).run('--help')
    expect(res.code).toBe(0)
    const at = (s: string) => res.out.indexOf(s)
    expect(at('Start here')).toBeGreaterThanOrEqual(0)
    expect(at('fmmi setup')).toBeLessThan(at('fmmi sync'))
    expect(at('fmmi sync')).toBeLessThan(at('fmmi report [latest'))
    expect(at('fmmi report [latest')).toBeLessThan(at('All commands'))
    expect(res.out).toMatch(/fmmi live capture/)
    expect(res.out).toMatch(/fmmi trends/)
    expect(res.out).not.toMatch(/<saveId>/)
  })
})
