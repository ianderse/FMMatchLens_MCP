// TEST-ONLY: a fake machine for the setup and sync tests. A temporary Steam install with a libraryfolders.vdf, a second library holding the
// plugin's recordings folder, a catalog home, a scripted terminal and a fake `claude`. Nothing here touches the real %LOCALAPPDATA%\fmmi,
// the real game folder or ~/.claude.json.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORDINGS_SUBPATH, main } from '@fmmi/cli'
import type { Io, ProcessResult, ProcessRunner, Prompter } from '@fmmi/cli'
import { buildSyntheticArchive } from './syntheticArchive.ts'
import { FIVE, buildSeasonMatch, periodsOf } from './season.ts'
import type { SeasonMatch } from './season.ts'
import { tmp } from './helpers.ts'

export const REPO_ROOT = join(import.meta.dirname, '..', '..')

export interface World { root: string; steam: string; library: string; matches: string; home: string }

const vdfPath = (p: string) => p.replace(/\\/g, '\\\\')

/** `withVdf: false` leaves the recordings folder only in the second library, found through libraryfolders.vdf. */
export function world(opts: { game?: boolean } = {}): World {
  const root = tmp('fmmi-world-')
  const steam = join(root, 'Program Files (x86)', 'Steam'), library = join(root, 'SteamLibrary')
  mkdirSync(join(steam, 'steamapps'), { recursive: true })
  const matches = join(library, RECORDINGS_SUBPATH)
  if (opts.game !== false) mkdirSync(matches, { recursive: true })
  writeFileSync(join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steam)}"\n\t\t"label"\t\t""\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(library)}"\n\t}\n}\n`)
  return { root, steam, library, matches, home: join(root, 'fmmi-home') }
}

export async function recording(dir: string, name: string, spec: SeasonMatch): Promise<string> {
  const p = join(dir, name)
  writeFileSync(p, buildSyntheticArchive(await buildSeasonMatch(spec)).bytes)
  return p
}

/** Two full recordings and one partial one (it stops at 65 minutes), plus the file the plugin is still writing. */
export async function fillRecordings(w: World): Promise<{ full1: string; full2: string; partial: string; inProgress: string }> {
  const full1 = await recording(w.matches, '2026-08-08-Synthetic Town-vs-Horsham Rovers-1-0.fmlens', FIVE[0]!)
  const full2 = await recording(w.matches, '2026-08-15-Torquay Athletic-vs-Synthetic Town-1-1.fmlens', FIVE[1]!)
  const partial = await recording(w.matches, '2026-08-22-Synthetic Town-vs-Bath Wanderers-0-0.fmlens', { ...FIVE[2]!, periods: periodsOf(15600) })
  const inProgress = await recording(w.matches, 'match-1767225600000.fmlens', { ...FIVE[3]!, periods: periodsOf(12000) })
  return { full1, full2, partial, inProgress }
}

/** A terminal that answers from a script. Questions are recorded; when the script runs out it behaves like end of input. */
export function scripted(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = []
  return { interactive: true, asked, ask: (q) => { asked.push(q); return Promise.resolve(answers.length ? answers.shift()! : null) } }
}

/** A terminal that fails the test if anything is ever asked. */
export const mustNotAsk: Prompter = { interactive: true, ask: () => { throw new Error('a prompt was shown') } }

export interface ClaudeEntry { command: string; args: string[] }
export interface FakeClaude { run: ProcessRunner; calls: Array<{ args: string[]; cwd?: string }>; state: { missing?: boolean; user?: ClaudeEntry; local?: ClaudeEntry } }

const text = (e: ClaudeEntry, scope: 'User' | 'Local') =>
  `fmmi:\n  Scope: ${scope} config (${scope === 'User' ? 'available in all your projects' : 'private to you in this project'})\n  Status: connected\n  Type: stdio\n  Command: ${e.command}\n  Args: ${e.args.join(' ')}\n  Environment:\n`

/** An in-memory `claude mcp` (get, add, remove). A local entry only applies in the repository folder and overrides the user one there. */
export function fakeClaude(state: FakeClaude['state'] = {}): FakeClaude {
  const calls: FakeClaude['calls'] = []
  const run: ProcessRunner = (command, args, o): Promise<ProcessResult> => {
    const ok = (stdout = ''): Promise<ProcessResult> => Promise.resolve({ code: 0, stdout, stderr: '', missing: false })
    const fail = (stderr: string): Promise<ProcessResult> => Promise.resolve({ code: 1, stdout: '', stderr, missing: false })
    if (command !== 'claude' || state.missing) return Promise.resolve({ code: null, stdout: '', stderr: '', missing: true })
    calls.push({ args, cwd: o?.cwd })
    if (args[0] === '--version') return ok('2.1.0 (Claude Code)')
    if (args[0] === 'mcp' && args[1] === 'get') {
      const here = o?.cwd === REPO_ROOT
      if (here && state.local) return ok(text(state.local, 'Local'))
      if (state.user) return ok(text(state.user, 'User'))
      return fail('No MCP server found with name: fmmi')
    }
    if (args[0] === 'mcp' && args[1] === 'remove') {
      const scope = args[args.indexOf('--scope') + 1]
      if (scope === 'local') { delete state.local; return ok('removed') }
      delete state.user
      return ok('removed')
    }
    if (args[0] === 'mcp' && args[1] === 'add') {
      const dash = args.indexOf('--')
      if (dash < 0) return fail("error: unknown option '--live'") // what PowerShell's eaten `--` produced
      state.user = { command: args[dash + 1]!, args: args.slice(dash + 2) }
      return ok('added')
    }
    return fail('unexpected')
  }
  return { run, calls, state }
}

export interface Rig { out: string[]; err: string[]; io: Io; run: (...args: string[]) => Promise<{ code: number; out: string; err: string }> }

export function rig(w: World, over: Partial<Io> = {}): Rig {
  const out: string[] = [], err: string[] = []
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { FMMI_HOME: w.home }, steamRoots: [w.steam], ...over }
  return {
    out, err, io,
    async run(...args) {
      out.length = 0; err.length = 0
      const code = await main(args, io)
      return { code, out: out.join('\n'), err: err.join('\n') }
    },
  }
}

/** Names and modification times of every file under a directory: proves a directory was only read. */
export function snapshotDir(dir: string): string {
  const rows: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else rows.push(`${p}|${statSync(p).size}|${statSync(p).mtimeMs}`) } }
  walk(dir)
  return rows.sort().join('\n')
}
