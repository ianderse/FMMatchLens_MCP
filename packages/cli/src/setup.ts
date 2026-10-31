import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomainError, safeText } from '@fmmi/model'
import { CatalogService, loadConfig, updateConfigFile } from '@fmmi/store'
import type { ProcessRunner, Prompter } from './io.ts'
import { confirmFlow, importLines } from './sync.ts'
import type { ConfirmOutcome } from './sync.ts'

/** The path from a Steam library root to the folder the FMMatchLens plugin writes its recordings to. */
export const RECORDINGS_SUBPATH = join('steamapps', 'common', 'Football Manager 27', 'BepInEx', 'plugins', 'FMMatchLens', 'data', 'matches')

// ---------------------------------------------------------------------------------------------- recordings folder

/** A pasted path: surrounding quotes, whitespace and line breaks (a terminal wraps long pasted lines) are removed. Never touches the file system. */
export function cleanPastedPath(text: string): string {
  let t = text.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').replace(/[\r\n]+/g, '').trim()
  t = t.replace(/^&\s*/, '') // PowerShell's call operator when a quoted path is dragged into the window
  for (let i = 0; i < 3; i++) {
    const m = /^(['"\u2018\u201c])(.*)(['"\u2019\u201d])$/s.exec(t)
    if (!m) break
    t = m[2]!.trim()
  }
  return t
}

/** `"path"  "D:\\SteamLibrary"` entries of a Steam libraryfolders.vdf (backslashes are escaped in the file). */
export function parseLibraryFolders(vdf: string): string[] {
  const out: string[] = []
  for (const m of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!.replace(/\\(.)/g, '$1'))
  return out
}

/** Steam install directories to look in. `steamRoots` replaces the search entirely (tests). */
export function steamInstallDirs(env: NodeJS.ProcessEnv, steamRoots?: string[]): string[] {
  if (steamRoots) return steamRoots
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', pf = env.ProgramFiles ?? 'C:\\Program Files'
  const dirs = [join(pf86, 'Steam'), join(pf, 'Steam')]
  for (const d of ['C', 'D', 'E', 'F', 'G']) dirs.push(`${d}:\\Steam`, `${d}:\\SteamLibrary`, `${d}:\\Games\\Steam`)
  return dirs
}

export interface Found { path: string; fmlensFiles: number }

const countRecordings = (dir: string): number => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.fmlens')).length } catch { return 0 }
}
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

/** Read-only: looks for the plugin's recordings folder in the standard Steam paths and in the libraries listed by each libraryfolders.vdf. */
export function findRecordingFolders(env: NodeJS.ProcessEnv, steamRoots?: string[]): Found[] {
  const libraries: string[] = []
  for (const steam of steamInstallDirs(env, steamRoots)) {
    if (!isDir(steam)) continue
    libraries.push(steam)
    const vdf = join(steam, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) { try { libraries.push(...parseLibraryFolders(readFileSync(vdf, 'utf8'))) } catch { /* unreadable: the standard path was still tried */ } }
  }
  const seen = new Set<string>()
  const found: Found[] = []
  for (const lib of libraries) {
    const p = resolve(join(lib, RECORDINGS_SUBPATH))
    const key = p.toLowerCase()
    if (seen.has(key) || !isDir(p)) continue
    seen.add(key)
    found.push({ path: p, fmlensFiles: countRecordings(p) })
  }
  return found
}

/** What a user pasted may be the matches folder, the plugin folder or the game folder: accept the first that holds the recordings folder. */
export function recordingsFolderFrom(pasted: string): string | null {
  const p = cleanPastedPath(pasted)
  if (!p) return null
  const rel = [['BepInEx', 'plugins', 'FMMatchLens', 'data', 'matches'], ['plugins', 'FMMatchLens', 'data', 'matches'], ['FMMatchLens', 'data', 'matches'], ['data', 'matches'], []]
  for (const r of rel) { const c = resolve(p, ...r); if (isDir(c)) return c }
  return null
}

// ---------------------------------------------------------------------------------------------- Claude Code registration

export const MCP_NAME = 'fmmi'

export interface McpEntry { scope: 'user' | 'local' | 'project' | 'unknown'; command: string; args: string; raw: string }

/** The `claude mcp get` text, read leniently. Null when the output does not describe a server. */
export function parseMcpGet(stdout: string): McpEntry | null {
  const line = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, 'im').exec(stdout)?.[1]?.trim()
  const command = line('Command')
  if (command === undefined && line('Scope') === undefined) return null
  const scopeText = (line('Scope') ?? '').toLowerCase()
  const scope = scopeText.startsWith('local') ? 'local' : scopeText.startsWith('user') ? 'user' : scopeText.startsWith('project') ? 'project' : 'unknown'
  return { scope, command: command ?? '', args: line('Args') ?? '', raw: stdout.trim() }
}

const norm = (s: string) => s.replace(/["']/g, '').replace(/\//g, '\\').replace(/\s+/g, ' ').trim().toLowerCase()

export interface McpWanted { command: string; args: string[] }
export const sameEntry = (e: McpEntry, w: McpWanted): boolean => norm(e.command) === norm(w.command) && norm(e.args) === norm(w.args.join(' '))

/** The absolute command the Claude Code entry runs: this Node binary and this repository's fmmi-mcp launcher. */
export function wantedMcp(home: string, defaultHome: string): McpWanted {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'bin', 'fmmi-mcp.mjs')
  return { command: process.execPath, args: [script, '--live', ...(resolve(home) === resolve(defaultHome) ? [] : ['--home', resolve(home)])] }
}

export const mcpJsonBlock = (w: McpWanted): string => JSON.stringify({ mcpServers: { [MCP_NAME]: { command: w.command, args: w.args } } }, null, 2)

const NOT_FOUND = /no mcp server found/i

export interface McpOutcome { status: 'registered' | 'already' | 'replaced' | 'declined' | 'no_claude' | 'skipped' | 'failed'; localRemoved?: boolean; detail?: string }

interface McpCtx { run: ProcessRunner; prompt: Prompter; yes: boolean; out: (s: string) => void; wanted: McpWanted; repoRoot: string }

async function agree(ctx: McpCtx, question: string): Promise<boolean> {
  if (ctx.yes) return true
  if (!ctx.prompt.interactive) return false
  const a = await ctx.prompt.ask(`${question} [Y/n] `)
  return a !== null && (a.trim() === '' || /^y(es)?$/i.test(a.trim()))
}

const describeEntry = (e: McpEntry) => `${e.scope} scope: ${e.command} ${e.args}`.trim()

/** Registers the MCP server with Claude Code at user scope through the `claude` command (an argument array, no shell). Never edits Claude's config itself. */
export async function registerMcp(ctx: McpCtx): Promise<McpOutcome> {
  const { run, wanted } = ctx
  const ver = await run('claude', ['--version'])
  if (ver.missing || ver.code !== 0) {
    ctx.out(`Claude Code (the \`claude\` command) was not found. Add this to your MCP configuration:\n${mcpJsonBlock(wanted)}`)
    return { status: 'no_claude' }
  }
  const get = async (cwd: string) => {
    const r = await run('claude', ['mcp', 'get', MCP_NAME], { cwd })
    return r.code === 0 && !NOT_FOUND.test(r.stdout + r.stderr) ? parseMcpGet(r.stdout) : null
  }
  let localRemoved = false

  // A local-scope entry for this repository overrides the user-scope one here, so check what applies in the repository itself.
  const here = await get(ctx.repoRoot)
  if (here?.scope === 'local' && !sameEntry(here, wanted)) {
    ctx.out(`Claude Code has a different local-scope entry for ${MCP_NAME} in this repository (it overrides the user-level one here):\n  ${describeEntry(here)}`)
    if (await agree(ctx, 'Remove the local entry?')) {
      const r = await run('claude', ['mcp', 'remove', MCP_NAME, '--scope', 'local'], { cwd: ctx.repoRoot })
      if (r.code !== 0) { ctx.out(`Could not remove it (${safeText(r.stderr.trim() || r.stdout.trim())}). Run in this folder: claude mcp remove ${MCP_NAME} --scope local`); return { status: 'failed', detail: 'local_remove' } }
      localRemoved = true
    } else ctx.out(`Left as is. Remove it later with: claude mcp remove ${MCP_NAME} --scope local (run it in this folder).`)
  }

  const user = await get(tmpdir())
  const existing = user && user.scope === 'user' ? user : null
  if (existing && sameEntry(existing, wanted)) { ctx.out('Claude Code already has the fmmi server registered for all projects.'); return { status: 'already', localRemoved } }

  let replaced = false
  if (existing) {
    ctx.out(`Claude Code has an older fmmi entry (it differs):\n  ${describeEntry(existing)}\nThe new one runs:\n  ${wanted.command} ${wanted.args.join(' ')}`)
    if (!(await agree(ctx, 'Replace it?'))) { ctx.out('Left as is.'); return { status: 'declined', localRemoved } }
    const r = await run('claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { cwd: tmpdir() })
    if (r.code !== 0) { ctx.out(`Could not remove the old entry (${safeText(r.stderr.trim() || r.stdout.trim())}).`); return { status: 'failed', detail: 'user_remove', localRemoved } }
    replaced = true
  } else if (!(await agree(ctx, 'Register the fmmi server in Claude Code for all your projects (user scope)?'))) {
    ctx.out(`Not registered. To register it later run fmmi setup again, or add this to your MCP configuration:\n${mcpJsonBlock(wanted)}`)
    return { status: ctx.yes || ctx.prompt.interactive ? 'declined' : 'skipped', localRemoved }
  }
  const add = await run('claude', ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', wanted.command, ...wanted.args], { cwd: tmpdir() })
  if (add.code !== 0) {
    ctx.out(`Claude Code refused the registration (${safeText(add.stderr.trim() || add.stdout.trim())}). Add this to your MCP configuration instead:\n${mcpJsonBlock(wanted)}`)
    return { status: 'failed', detail: 'add', localRemoved }
  }
  ctx.out('Registered the fmmi server in Claude Code (user scope, all projects). Start a new Claude Code session so the tools appear.')
  return { status: replaced ? 'replaced' : 'registered', localRemoved }
}

// ---------------------------------------------------------------------------------------------- the setup command

export interface SetupOptions {
  home: string
  defaultHome: string
  env: NodeJS.ProcessEnv
  prompt: Prompter
  run: ProcessRunner
  out: (s: string) => void
  steamRoots?: string[]
  yes: boolean
  archiveDir?: string
  saveName?: string
  noMcp: boolean
  /** Folder of this repository (where a local-scope Claude entry would live). */
  repoRoot: string
}

export interface SetupSummary {
  archiveDir: string
  saveId: string
  saveName: string
  matches: number
  imported: number
  managedTeam: string | null
  confirmation: ConfirmOutcome
  mcp: McpOutcome | null
}

const setupError = (message: string, details: Record<string, unknown>) => new DomainError('invalid_input', message, { reason: 'setup', ...details })

async function askLine(o: SetupOptions, q: string): Promise<string> {
  const a = await o.prompt.ask(q)
  if (a === null) throw setupError('Setup was interrupted (no more input).', { step: 'prompt' })
  return a
}

async function chooseFolder(o: SetupOptions, configured: string | undefined): Promise<string> {
  const { out } = o
  if (o.archiveDir !== undefined) {
    const p = recordingsFolderFrom(o.archiveDir)
    if (!p) throw new DomainError('not_found', `That recordings folder does not exist: ${cleanPastedPath(o.archiveDir)}`, { reason: 'archive_dir_missing', path: cleanPastedPath(o.archiveDir) })
    return p
  }
  if (configured && isDir(configured)) { out(`Recordings folder: ${configured} (already set)`); return configured }
  const found = findRecordingFolders(o.env, o.steamRoots)
  const describe = (f: Found) => `${f.path} (${f.fmlensFiles} recording${f.fmlensFiles === 1 ? '' : 's'})`
  if (o.yes && found.length === 1) { out(`Recordings folder: ${describe(found[0]!)}`); return found[0]!.path }
  if (!o.prompt.interactive) {
    if (found.length === 1 && o.yes) { out(`Recordings folder: ${describe(found[0]!)}`); return found[0]!.path }
    if (found.length === 0) throw new DomainError('not_found', 'Could not find the FMMatchLens recordings folder. Run fmmi setup --archive-dir "<folder>" with its path.', { reason: 'archive_dir_unset' })
    if (found.length > 1) throw new DomainError('ambiguous_selection', `Found more than one recordings folder; pass --archive-dir with one of: ${found.map((f) => f.path).join(' | ')}`, { reason: 'archive_dir_ambiguous', candidates: found.map((f) => f.path) })
    throw new DomainError('invalid_input', `Found ${describe(found[0]!)}. Pass --yes to use it, or --archive-dir with the folder.`, { reason: 'setup', step: 'folder' })
  }
  if (found.length === 1) {
    out(`Found the recordings folder: ${describe(found[0]!)}`)
    const a = (await askLine(o, 'Use it? [Y/n or paste another path] ')).trim()
    if (a === '' || /^y(es)?$/i.test(a)) return found[0]!.path
    if (!/^n(o)?$/i.test(a)) { const p = recordingsFolderFrom(a); if (p) return p; out('That folder does not exist.') }
  } else if (found.length > 1) {
    out('Found more than one recordings folder:')
    found.forEach((f, i) => out(`  ${i + 1}) ${describe(f)}`))
    const a = (await askLine(o, `Which one? [1-${found.length} or paste a path] `)).trim()
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= found.length) return found[n - 1]!.path
    const p = recordingsFolderFrom(a)
    if (p) return p
    out('That is not one of the choices.')
  } else out('Could not find the FMMatchLens recordings folder in the Steam locations.')
  for (let i = 0; i < 3; i++) {
    const p = recordingsFolderFrom(await askLine(o, 'Paste the path of the recordings folder (the one holding the .fmlens files): '))
    if (p) return p
    out('That folder does not exist. Check the path and try again.')
  }
  throw new DomainError('not_found', 'No valid recordings folder was given.', { reason: 'archive_dir_missing' })
}

async function chooseSave(o: SetupOptions, svc: CatalogService, dir: string, defaultSaveId: string | undefined): Promise<{ saveId: string; saveName: string }> {
  const { out } = o
  const saves = svc.listSaves()
  const byName = (name: string) => saves.find((s) => s.displayName.trim().toLowerCase() === name.trim().toLowerCase())
  const make = (name: string) => { const s = svc.createSave(name); out(`Created save "${s.displayName}".`); return { saveId: s.saveId, saveName: s.displayName } }
  if (o.saveName !== undefined) {
    const s = byName(o.saveName)
    if (s) { out(`Using save "${s.displayName}".`); return { saveId: s.saveId, saveName: s.displayName } }
    return make(o.saveName)
  }
  const current = defaultSaveId ? saves.find((s) => s.saveId === defaultSaveId) : undefined
  if (current) { out(`Save: "${current.displayName}" (already the default)`); return { saveId: current.saveId, saveName: current.displayName } }
  if (saves.length === 1) { out(`Using your existing save "${saves[0]!.displayName}" as the default.`); return { saveId: saves[0]!.saveId, saveName: saves[0]!.displayName } }
  if (saves.length > 1) {
    if (!o.prompt.interactive) throw new DomainError('ambiguous_selection', `More than one save exists. Pass --save-name with one of: ${saves.map((s) => `"${safeText(s.displayName)}"`).join(', ')}`, { reason: 'save_required', candidates: saves.map((s) => ({ saveId: s.saveId, name: s.displayName })) })
    out('You have more than one save:')
    saves.forEach((s, i) => out(`  ${i + 1}) ${safeText(s.displayName)}`))
    const a = (await askLine(o, `Which is the default? [1-${saves.length}, or type a new name] `)).trim()
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= saves.length) return { saveId: saves[n - 1]!.saveId, saveName: saves[n - 1]!.displayName }
    const s = a ? byName(a) : undefined
    if (s) return { saveId: s.saveId, saveName: s.displayName }
    if (a) return make(a)
    throw setupError('No save chosen.', { step: 'save' })
  }
  // No save yet: name it after the club the manager played as, when the recordings say so (read-only look), else ask.
  const clubs = await svc.peekManagedClubs(dir)
  if (clubs.length === 1) { out(`Detected your club from the recordings: ${safeText(clubs[0]!)}`); return make(clubs[0]!) }
  if (!o.prompt.interactive) throw new DomainError('invalid_input', 'Could not tell which club you manage. Pass --save-name "<name>" (any name, for example your club).', { reason: 'setup', step: 'save_name' })
  const name = (await askLine(o, clubs.length > 1 ? `The recordings show more than one club (${clubs.map(safeText).join(', ')}). Name for this save: ` : 'Name for this save (for example your club): ')).trim()
  if (!name) throw setupError('A save needs a name.', { step: 'save_name' })
  return make(name)
}

/** Guided, idempotent setup. Writes only under the catalog home (config.json and the catalog) and, through the `claude` command, Claude's own config. */
export async function runSetup(o: SetupOptions): Promise<SetupSummary> {
  const { out } = o
  out('fmmi setup')
  const cfg0 = loadConfig(o.home, {}) // the file only: flags and environment must not be written back as if they were choices
  const dir = await chooseFolder(o, cfg0.archiveDir ?? o.env.FMMI_ARCHIVE_DIR)
  const svc = new CatalogService({ ...loadConfig(o.home, o.env, { archiveDir: dir }) })
  try {
    const { saveId, saveName } = await chooseSave(o, svc, dir, cfg0.defaultSaveId ?? o.env.FMMI_DEFAULT_SAVE)
    const patch: Record<string, string | undefined> = {}
    if (cfg0.archiveDir !== dir) patch.archiveDir = dir
    if (cfg0.defaultSaveId !== saveId) patch.defaultSaveId = saveId
    if (Object.keys(patch).length > 0) updateConfigFile(o.home, patch)
    out(`Settings saved in ${join(o.home, 'config.json')}`)

    const imp = await svc.ingestNew(saveId, { includeInProgress: false })
    const lines = importLines(svc, saveId, imp.results, imp.skippedAlreadyIngested, imp.skippedInProgress)
    if (lines.length) out(lines.join('\n'))
    else if (imp.skippedAlreadyIngested > 0) out(`${imp.skippedAlreadyIngested} recording(s) in the folder were already imported.`)
    else out('No recordings in the folder yet. Play a match; fmmi picks it up on the next sync or when Claude asks.')

    let managedTeam: string | null = null
    const cur = svc.getManagedTeam(saveId)
    if (!cur) {
      const d = svc.detectManagedTeam(saveId)
      if (d.suggestion) { const r = svc.applyDetectedManagedTeam(saveId); managedTeam = r.name; out(`Your club: ${safeText(r.name)} (detected from the recordings).`) }
      else if (d.matches > 0) out('Could not tell which club you manage. Set it with: fmmi save team set --team "<club>"')
    } else managedTeam = svc.store.getTeam(cur.teamId)?.name ?? null

    const confirmation = await confirmFlow(svc, saveId, o.prompt, out, { all: false })
    if (confirmation.pending.length > 0) {
      out(`${confirmation.pending.length} partial recording(s) wait for your final score. Run: fmmi sync`)
    }

    let mcp: McpOutcome | null = null
    if (!o.noMcp) mcp = await registerMcp({ run: o.run, prompt: o.prompt, yes: o.yes, out, wanted: wantedMcp(o.home, o.defaultHome), repoRoot: o.repoRoot })

    const matches = svc.listMatches(saveId).matches.length
    out('')
    out(`Done. Save "${safeText(saveName)}", ${matches} match(es) imported${managedTeam ? `, club ${safeText(managedTeam)}` : ''}.`)
    out(mcp && (mcp.status === 'registered' || mcp.status === 'replaced' || mcp.status === 'already')
      ? 'Next: start a new Claude Code session and ask about your last match. Claude imports new recordings by itself. Without Claude, run fmmi sync after a match.'
      : 'Next: run fmmi sync after a match to import it (and fmmi report latest to read it).')
    return { archiveDir: dir, saveId, saveName, matches, imported: imp.results.filter((r) => r.status !== 'rejected').length, managedTeam, confirmation, mcp }
  } finally { svc.close() }
}

export const defaultHomeOf = (env: NodeJS.ProcessEnv): string => join(env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'fmmi')
