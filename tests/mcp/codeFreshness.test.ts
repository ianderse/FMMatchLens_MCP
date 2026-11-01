// A session left open across an update keeps its old server, so the server warns once the code on disk is newer than the code it loaded.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INSTRUCTIONS, LIVE_INSTRUCTIONS, SERVER_OUTDATED_WARNING, liveTools } from '@fmmi/mcp'
import type { LiveAccess } from '@fmmi/mcp'
import { CodeFreshness } from '@fmmi/store'
import { cleanupAll, tmp } from '../support/helpers.ts'
import { connect, openWriter } from '../support/mcp.ts'

afterAll(cleanupAll)

function tree() {
  const dir = tmp('fmmi-code-')
  mkdirSync(join(dir, 'mcp', 'src', 'deep'), { recursive: true })
  const file = join(dir, 'mcp', 'src', 'deep', 'a.ts')
  writeFileSync(file, 'x')
  utimesSync(file, 1000, 1000)
  let now = 0
  return { dir, file, advance: (ms: number) => { now += ms }, code: new CodeFreshness({ packagesDir: dir, intervalMs: 100, now: () => now }) }
}

describe('CodeFreshness', () => {
  it('stays false while the sources are unchanged', () => {
    const t = tree()
    t.advance(1000)
    expect(t.code.changed()).toBe(false)
  })

  it('turns true after a source file changes, and stays true', () => {
    const t = tree()
    utimesSync(t.file, 2000, 2000)
    t.advance(1000)
    expect(t.code.changed()).toBe(true)
    utimesSync(t.file, 1000, 1000)
    t.advance(1000)
    expect(t.code.changed()).toBe(true)
  })

  it('does not rescan inside the interval', () => {
    const t = tree()
    utimesSync(t.file, 2000, 2000)
    t.advance(50)
    expect(t.code.changed()).toBe(false)
    t.advance(50)
    expect(t.code.changed()).toBe(true)
  })

  it('reports false for an unreadable tree instead of throwing', () => {
    let now = 0
    const code = new CodeFreshness({ packagesDir: join(tmp('fmmi-code-'), 'missing'), intervalMs: 1, now: () => now })
    now = 10
    expect(code.changed()).toBe(false)
  })

  it('reads the real packages folder by default', () => {
    expect(new CodeFreshness().changed()).toBe(false)
  })
})

describe('server_outdated warning', () => {
  const seeded = () => { const home = tmp('fmmi-code-home-'); const w = openWriter(home); const saveId = w.createSave('Code FC').saveId; w.close(); return { home, saveId } }

  it('is added to a tool result once the code changed', async () => {
    const t = seeded()
    let changed = false
    const c = await connect(t.home, undefined, { codeChanged: () => changed })
    expect(JSON.stringify((await c.call('list_matches', { saveId: t.saveId })).data)).not.toContain('server_outdated')
    changed = true
    expect((await c.call('list_matches', { saveId: t.saveId })).data.warnings).toContain(SERVER_OUTDATED_WARNING)
    await c.close()
  })
})

describe('instructions about unavailable metrics and live answers', () => {
  it('limits an unavailable list to the metrics it names', () => {
    expect(INSTRUCTIONS).toContain('an unavailable list covers only the metrics it names')
    const player = liveTools({} as LiveAccess).find((t) => t.name === 'get_live_player_analysis')!
    expect(player.description).toContain('it does not mean player analysis is missing')
    expect(player.description).toContain('asks why')
  })

  it('sends why questions to the player tool and flags mixed minutes', () => {
    expect(LIVE_INSTRUCTIONS).toContain('also read get_live_player_analysis')
    expect(LIVE_INSTRUCTIONS).toContain('different minutes')
  })
})
