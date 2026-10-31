// fmmi setup: folder detection, saves, import, managed team and Claude Code registration, all against a fake machine in temporary
// directories with an injected terminal and an injected `claude`. Nothing touches the real catalog, game folder or ~/.claude.json.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RECORDINGS_SUBPATH, cleanPastedPath, findRecordingFolders, parseLibraryFolders, parseMcpGet, quoteForCmd, recordingsFolderFrom, resolveExecutable, wantedMcp } from '@fmmi/cli'
import { CatalogService, loadConfig } from '@fmmi/store'
import { cleanupAll } from '../support/helpers.ts'
import { REPO_ROOT, fakeClaude, fillRecordings, mustNotAsk, recording, rig, scripted, snapshotDir, world } from '../support/world.ts'
import { FIVE } from '../support/season.ts'

afterAll(cleanupAll)

const open = (home: string) => new CatalogService({ ...loadConfig(home, {}), readOnly: true })
const config = (home: string) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, string>

describe('pasted paths', () => {
  it('strips surrounding quotes, whitespace and line breaks, PowerShell call syntax and invisible marks', () => {
    expect(cleanPastedPath('"C:\\Program Files (x86)\\Steam\\steamapps"')).toBe('C:\\Program Files (x86)\\Steam\\steamapps')
    expect(cleanPastedPath("  'C:\\a b\\c'  \r\n")).toBe('C:\\a b\\c')
    expect(cleanPastedPath('C:\\Program Files (x86)\\Steam\\steamapps\\com\r\nmon\\Football Manager 27\n')).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Football Manager 27')
    expect(cleanPastedPath("& 'C:\\a\\b'")).toBe('C:\\a\\b')
    expect(cleanPastedPath('\u202a"C:\\x"\ufeff')).toBe('C:\\x')
    expect(cleanPastedPath('\u201cD:\\y\u201d')).toBe('D:\\y')
    expect(cleanPastedPath('   \r\n  ')).toBe('')
  })

  it('accepts the matches folder, the plugin folder or the game folder', () => {
    const w = world()
    const game = join(w.library, 'steamapps', 'common', 'Football Manager 27')
    expect(recordingsFolderFrom(`"${w.matches}"`)).toBe(w.matches)
    expect(recordingsFolderFrom(game)).toBe(w.matches)
    expect(recordingsFolderFrom(join(game, 'BepInEx', 'plugins', 'FMMatchLens'))).toBe(w.matches)
    expect(recordingsFolderFrom(join(w.root, 'nowhere'))).toBeNull()
    expect(recordingsFolderFrom('   ')).toBeNull()
  })
})

describe('finding the recordings folder (read-only)', () => {
  it('parses libraryfolders.vdf and finds the folder in a library listed there, without touching the game folder', async () => {
    const w = world()
    await fillRecordings(w)
    const vdf = readFileSync(join(w.steam, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    expect(parseLibraryFolders(vdf)).toEqual([w.steam, w.library])
    const before = snapshotDir(w.root)
    const found = findRecordingFolders({}, [w.steam, join(w.root, 'NoSteamHere')])
    expect(found).toEqual([{ path: w.matches, fmlensFiles: 4 }])
    expect(snapshotDir(w.root)).toBe(before)
  })

  it('finds the folder in the standard Steam path itself and reports nothing when the game is not installed', () => {
    const w = world({ game: false })
    expect(findRecordingFolders({}, [w.steam])).toEqual([])
    const std = join(w.steam, RECORDINGS_SUBPATH)
    mkdirSync(std, { recursive: true })
    expect(findRecordingFolders({}, [w.steam])).toEqual([{ path: std, fmlensFiles: 0 }])
  })
})

describe('fmmi setup', () => {
  it('non-interactive: finds the folder, names the save after the detected club, imports, sets the managed team, registers Claude Code, and writes only under the home', async () => {
    const w = world()
    await fillRecordings(w)
    const claude = fakeClaude()
    const r = rig(w, { run: claude.run })
    const beforeGame = snapshotDir(w.library)
    const res = await r.run('setup', '--yes')
    expect(res.code, res.err).toBe(0)
    expect(snapshotDir(w.library)).toBe(beforeGame) // the game folder was only read
    expect(res.out).toContain('Detected your club from the recordings: Synthetic Town')
    expect(res.out).toMatch(/Skipped match-1767225600000\.fmlens: the game is still recording/)

    const cfg = config(w.home)
    expect(cfg.archiveDir).toBe(w.matches)
    const svc = open(w.home)
    const saves = svc.listSaves()
    expect(saves.map((s) => s.displayName)).toEqual(['Synthetic Town'])
    expect(cfg.defaultSaveId).toBe(saves[0]!.saveId)
    expect(svc.listMatches(saves[0]!.saveId).matches).toHaveLength(3) // the in-progress file was not imported
    expect(svc.getManagedTeam(saves[0]!.saveId)).toMatchObject({ source: 'assisted' })
    svc.close()

    // user scope, an argument array with the `--` separator, absolute paths, --live
    const add = claude.calls.find((c) => c.args[1] === 'add')!
    expect(add.args.slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'user', 'fmmi'])
    const dash = add.args.indexOf('--')
    expect(add.args[dash + 1]).toBe(process.execPath)
    expect(add.args[dash + 2]).toBe(join(REPO_ROOT, 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs'))
    expect(existsSync(add.args[dash + 2]!)).toBe(true)
    expect(add.args.slice(dash + 3)).toEqual(['--live', '--home', w.home]) // a non-default catalog home is passed on, so the server reads the same catalog
    expect(res.out).toMatch(/Start a new Claude Code session/)
    expect(res.out).toMatch(/fmmi sync/)
  })

  it('is idempotent: running it again duplicates nothing, keeps the save, the match count and a confirmed match, and registers nothing twice', async () => {
    const w = world()
    await fillRecordings(w)
    const claude = fakeClaude()
    const r = rig(w, { run: claude.run })
    expect((await r.run('setup', '--yes')).code).toBe(0)
    let svc = open(w.home)
    const saveId = svc.listSaves()[0]!.saveId
    const partial = svc.listMatches(saveId).matches.find((m) => m.status.coverage !== 'full_match')!
    svc.close()
    // the user confirms the partial one (1-0 is the observed score)
    const synced = await rig(w, { run: claude.run, prompt: scripted(['']) }).run('sync')
    expect(synced.code, synced.err).toBe(0)
    const auditBefore = (() => { const s = open(w.home); try { return s.store.listAudit().length } finally { s.close() } })()

    const addsBefore = claude.calls.filter((c) => c.args[1] === 'add').length
    const again = await rig(w, { run: claude.run, prompt: mustNotAsk }).run('setup')
    expect(again.code, again.err).toBe(0)
    expect(again.out).toMatch(/already has the fmmi server registered/)
    expect(again.out).toMatch(/\(already set\)/)
    expect(claude.calls.filter((c) => c.args[1] === 'add').length).toBe(addsBefore)
    svc = open(w.home)
    expect(svc.listSaves()).toHaveLength(1)
    const matches = svc.listMatches(saveId).matches
    expect(matches).toHaveLength(3)
    expect(matches.find((m) => m.matchId === partial.matchId)!.status.completion).toBe('completed_manual')
    expect(svc.store.listAudit().length).toBe(auditBefore) // nothing re-confirmed, nothing re-assigned
    svc.close()
  })

  it('interactive: shows what it found and asks; Enter accepts the folder, the partial recording prompt confirms, and Claude is registered after a yes', async () => {
    const w = world()
    await fillRecordings(w)
    const claude = fakeClaude()
    const term = scripted(['', '', 'y'])
    const res = await rig(w, { run: claude.run, prompt: term }).run('setup')
    expect(res.code, res.err).toBe(0)
    expect(term.asked[0]).toMatch(/Use it\?/)
    expect(res.out).toContain(`Found the recordings folder: ${w.matches} (4 recordings)`)
    expect(term.asked[1]).toMatch(/Final score 0-0\? \[Y\/n\/type score\]/)
    expect(term.asked[2]).toMatch(/Register the fmmi server in Claude Code/)
    expect(claude.calls.some((c) => c.args[1] === 'add')).toBe(true)
    const svc = open(w.home)
    expect(svc.listMatches(svc.listSaves()[0]!.saveId).matches.filter((m) => m.status.completion === 'completed_manual')).toHaveLength(1)
    svc.close()
  })

  it('asks for a path when nothing is found, and cleans a pasted quoted path with a line break', async () => {
    const w = world({ game: false })
    const folder = join(w.root, 'My Recordings')
    mkdirSync(folder, { recursive: true })
    await recording(folder, '2026-08-08-Synthetic Town-vs-Horsham Rovers-1-0.fmlens', FIVE[0]!)
    const pasted = `"${folder.slice(0, 20)}\r\n${folder.slice(20)}"  `
    const term = scripted(['C:\\definitely\\not\\here', pasted, ''])
    const res = await rig(w, { run: fakeClaude({ missing: true }).run, prompt: term }).run('setup', '--no-mcp')
    expect(res.code, res.err).toBe(0)
    expect(res.out).toMatch(/Could not find the FMMatchLens recordings folder/)
    expect(res.out).toMatch(/That folder does not exist/)
    expect(config(w.home).archiveDir).toBe(folder)
  })

  it('without a terminal and without --yes it never guesses: it says what to pass', async () => {
    const w = world()
    await fillRecordings(w)
    const res = await rig(w).run('setup')
    expect(res.code).toBe(1)
    expect(res.err).toMatch(/Pass --yes to use it, or --archive-dir/)
    expect(existsSync(join(w.home, 'config.json'))).toBe(false)
    const none = world({ game: false })
    const r2 = await rig(none).run('setup', '--yes')
    expect(r2.code).toBe(1)
    expect(r2.err).toMatch(/--archive-dir/)
  })

  it('--archive-dir and --save-name need no terminal; a missing folder is named in the error', async () => {
    const w = world()
    await fillRecordings(w)
    const ok = await rig(w).run('setup', '--archive-dir', `"${w.matches}"`, '--save-name', 'My Club', '--no-mcp', '--json')
    expect(ok.code, ok.err).toBe(0)
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, data: { saveName: 'My Club', matches: 3 } })
    const bad = await rig(world()).run('setup', '--archive-dir', 'C:\\nope\\matches', '--no-mcp')
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('C:\\nope\\matches')
  })

  describe('saves', () => {
    const seed = (w: ReturnType<typeof world>, names: string[]) => {
      const svc = new CatalogService(loadConfig(w.home, {}))
      const ids = names.map((n) => svc.createSave(n).saveId)
      svc.close()
      return ids
    }

    it('one existing save becomes the default and no second one is created', async () => {
      const w = world()
      await fillRecordings(w)
      const [only] = seed(w, ['Existing Save'])
      const res = await rig(w).run('setup', '--yes', '--no-mcp')
      expect(res.code, res.err).toBe(0)
      expect(res.out).toMatch(/Using your existing save "Existing Save" as the default/)
      const svc = open(w.home)
      expect(svc.listSaves().map((s) => s.saveId)).toEqual([only])
      svc.close()
      expect(config(w.home).defaultSaveId).toBe(only)
    })

    it('no save: it is named from the managed club, or asked for when the club cannot be detected', async () => {
      const w = world()
      await recording(w.matches, 'plain.fmlens', { ...FIVE[0]!, synth: { humanSide: undefined } }) // no human-managed side recorded
      const term = scripted(['Chosen Name'])
      const res = await rig(w, { prompt: term }).run('setup', '--archive-dir', w.matches, '--no-mcp')
      expect(res.code, res.err).toBe(0)
      expect(term.asked[0]).toMatch(/Name for this save/)
      const svc = open(w.home)
      expect(svc.listSaves().map((x) => x.displayName)).toEqual(['Chosen Name'])
      svc.close()
      const nonInteractive = world()
      await recording(nonInteractive.matches, 'plain.fmlens', { ...FIVE[0]!, synth: { humanSide: undefined } })
      const refused = await rig(nonInteractive).run('setup', '--archive-dir', nonInteractive.matches, '--no-mcp')
      expect(refused.code).toBe(1)
      expect(refused.err).toMatch(/--save-name/)
    })

    it('several saves: non-interactive lists them by name and stops; interactive lets you pick; --save-name picks by name', async () => {
      const w = world()
      await fillRecordings(w)
      const [, second] = seed(w, ['First', 'Second'])
      const refuse = await rig(w).run('setup', '--yes', '--no-mcp')
      expect(refuse.code).toBe(1)
      expect(refuse.err).toContain('"First"')
      expect(refuse.err).toContain('"Second"')
      const picked = await rig(w, { prompt: scripted(['Second', '']) }).run('setup', '--yes', '--no-mcp') // --yes takes the one folder found; the save still needs a choice (typed by name: the list order is not creation order)
      expect(picked.code, picked.err).toBe(0)
      expect(config(w.home).defaultSaveId).toBe(second)
      const byName = await rig(w).run('setup', '--yes', '--no-mcp', '--save-name', 'first')
      expect(byName.code, byName.err).toBe(0)
      expect(config(w.home).defaultSaveId).toBe(seedIds(w).find((x) => x.name === 'First')!.id)
    })

    const seedIds = (w: ReturnType<typeof world>) => { const s = open(w.home); try { return s.listSaves().map((x) => ({ id: x.saveId, name: x.displayName })) } finally { s.close() } }
  })

  describe('registering with Claude Code', () => {
    const wanted = () => wantedMcp(join('x', 'home'), join('x', 'home'))

    it('without `claude` it prints a ready-to-paste JSON block with real absolute paths and no placeholders', async () => {
      const w = world()
      await fillRecordings(w)
      const claude = fakeClaude({ missing: true })
      const res = await rig(w, { run: claude.run }).run('setup', '--yes')
      expect(res.code, res.err).toBe(0)
      const json = /\{\s*"mcpServers"[\s\S]*?\n\}/.exec(res.out)![0]
      const block = JSON.parse(json) as { mcpServers: { fmmi: { command: string; args: string[] } } }
      expect(block.mcpServers.fmmi.command).toBe(process.execPath)
      expect(block.mcpServers.fmmi.args[0]).toBe(wanted().args[0])
      expect(block.mcpServers.fmmi.args).toContain('--live')
      expect(existsSync(block.mcpServers.fmmi.args[0]!)).toBe(true)
      expect(json).not.toMatch(/[<>]|path\/to|YOUR/i)
    })

    it('an identical entry is left alone; a stale one is shown and replaced only after consent (or --yes) and only when it differs', async () => {
      const w = world()
      await fillRecordings(w)
      const same = fakeClaude({ user: { command: process.execPath, args: [join(REPO_ROOT, 'packages', 'mcp', 'bin', 'fmmi-mcp.mjs'), '--live', '--home', w.home] } })
      const r1 = await rig(w, { run: same.run }).run('setup', '--yes')
      expect(r1.out).toMatch(/already has the fmmi server registered/)
      expect(same.calls.some((c) => c.args[1] === 'add' || c.args[1] === 'remove')).toBe(false)

      const stale = fakeClaude({ user: { command: 'node', args: ['C:\\old\\fmmi-mcp.mjs'] } })
      const declined = await rig(w, { run: stale.run, prompt: scripted(['', 'n']) }).run('setup') // (folder and save are already set by the run above) partial score yes, replace no
      expect(declined.out).toMatch(/older fmmi entry/)
      expect(declined.out).toContain('C:\\old\\fmmi-mcp.mjs')
      expect(declined.out).toMatch(/Left as is/)
      expect(stale.calls.some((c) => c.args[1] === 'remove' || c.args[1] === 'add')).toBe(false)
    })

    it('a stale entry is replaced after --yes: remove at user scope, then add', async () => {
      const w = world()
      await fillRecordings(w)
      const stale = fakeClaude({ user: { command: 'node', args: ['C:\\old\\fmmi-mcp.mjs'] } })
      const res = await rig(w, { run: stale.run }).run('setup', '--yes')
      expect(res.code, res.err).toBe(0)
      const verbs = stale.calls.map((c) => c.args.slice(0, 2).join(' ') + (c.args[1] === 'remove' ? ` ${c.args[c.args.indexOf('--scope') + 1]}` : ''))
      expect(verbs.filter((v) => v.startsWith('mcp remove') || v.startsWith('mcp add'))).toEqual(['mcp remove user', 'mcp add'])
      expect(stale.state.user!.command).toBe(process.execPath)
    })

    it('without a terminal and without --yes nothing is registered', async () => {
      const w = world()
      await fillRecordings(w)
      const claude = fakeClaude()
      const res = await rig(w, { run: claude.run }).run('setup', '--archive-dir', w.matches, '--save-name', 'X')
      expect(res.code, res.err).toBe(0)
      expect(claude.calls.some((c) => c.args[1] === 'add')).toBe(false)
      expect(res.out).toMatch(/"mcpServers"/)
    })

    it('a local-scope entry for this repository overrides the user one: it is shown and removed after consent, then the user entry is added', async () => {
      const w = world()
      await fillRecordings(w)
      const claude = fakeClaude({ local: { command: 'node', args: ['C:\\old\\fmmi-mcp.mjs'] } })
      const res = await rig(w, { run: claude.run }).run('setup', '--yes')
      expect(res.code, res.err).toBe(0)
      expect(res.out).toMatch(/different local-scope entry/)
      const removal = claude.calls.find((c) => c.args[1] === 'remove')!
      expect(removal.args).toEqual(['mcp', 'remove', 'fmmi', '--scope', 'local'])
      expect(removal.cwd).toBe(REPO_ROOT)
      expect(claude.state.local).toBeUndefined()
      expect(claude.state.user).toBeDefined()
    })

    it('--no-mcp never runs claude', async () => {
      const w = world()
      await fillRecordings(w)
      const claude = fakeClaude()
      expect((await rig(w, { run: claude.run }).run('setup', '--yes', '--no-mcp')).code).toBe(0)
      expect(claude.calls).toEqual([])
    })

    it('parses `claude mcp get` and builds a Windows-safe command line', () => {
      const e = parseMcpGet('fmmi:\n  Scope: Local config (private to you in this project)\n  Command: C:\\n\\node.exe\n  Args: a b\n')!
      expect(e).toMatchObject({ scope: 'local', command: 'C:\\n\\node.exe', args: 'a b' })
      expect(parseMcpGet('No MCP server found with name: fmmi')).toBeNull()
      expect(quoteForCmd('C:\\Program Files (x86)\\x.exe')).toBe('"C:\\Program Files (x86)\\x.exe"')
      expect(quoteForCmd('--live')).toBe('--live')
      expect(() => quoteForCmd('a&b')).toThrow()
      expect(() => quoteForCmd('50%')).toThrow()
      const exists = (p: string) => p === 'C:\\bin\\claude.cmd' || p === 'C:\\other\\claude.exe'
      expect(resolveExecutable('claude', { PATH: 'C:\\bin;C:\\other' }, 'win32', exists)).toEqual({ path: 'C:\\other\\claude.exe', viaCmd: false })
      expect(resolveExecutable('claude', { PATH: 'C:\\bin' }, 'win32', exists)).toEqual({ path: 'C:\\bin\\claude.cmd', viaCmd: true })
      expect(resolveExecutable('claude', { PATH: 'C:\\nothing' }, 'win32', exists)).toBeNull()
    })
  })
})
