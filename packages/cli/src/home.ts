import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError, safeText } from '@fmmi/model'
import { CatalogService, loadConfig } from '@fmmi/store'
import { HealthSchema, LocalPluginClient } from '@fmmi/live'
import { pendingConfirmations } from './sync.ts'

export interface HomeData {
  setUp: boolean
  save: { saveId: string; name: string } | null
  matches: number
  archiveDir: string | null
  newRecordings: number
  inProgressRecordings: number
  needConfirming: number
  plugin: { reachable: boolean; inMatch: boolean | null } | null
  next: string
}

/** How long the home screen waits for the plugin. Connection refused (the game is closed) answers at once; this only bounds a hung port. */
const PLUGIN_TIMEOUT_MS = 400

/**
 * The bare `fmmi` screen. Read-only: it never creates the catalog, never writes and never prompts. Not set up gives one line pointing at
 * `fmmi setup`; otherwise the save, the match count, what is new, what needs confirming, the plugin and the one next command.
 */
export async function homeScreen(o: { home: string; env: NodeJS.ProcessEnv; archiveDir?: string; livePort?: number }): Promise<{ data: HomeData; text: string }> {
  const notSetUp = (): { data: HomeData; text: string } => ({
    data: { setUp: false, save: null, matches: 0, archiveDir: null, newRecordings: 0, inProgressRecordings: 0, needConfirming: 0, plugin: null, next: 'fmmi setup' },
    text: 'fmmi is not set up yet. Run: fmmi setup   (fmmi --help lists every command)',
  })
  if (!existsSync(join(o.home, 'catalog.sqlite'))) return notSetUp()
  const svc = new CatalogService(loadConfig(o.home, o.env, { archiveDir: o.archiveDir }))
  try {
    if (svc.listSaves().length === 0) return notSetUp()
    let save: { saveId: string; name: string } | null = null
    try { save = svc.resolveSave() } catch (e) { if (!(e instanceof DomainError)) throw e }
    if (!save) {
      const names = svc.listSaves().map((s) => safeText(s.displayName)).join(', ')
      return { data: { ...notSetUp().data, setUp: true, next: 'fmmi setup' }, text: `More than one save exists (${names}) and none is the default. Run: fmmi setup` }
    }
    const matches = svc.listMatches(save.saveId).matches.length
    const archiveDir = svc.config.archiveDir ?? null
    const fresh = archiveDir && existsSync(archiveDir) ? svc.newRecordingFiles(save.saveId) : { files: [], inProgress: [] }
    const pending = pendingConfirmations(svc, save.saveId).length
    const client = new LocalPluginClient({ port: o.livePort, timeoutMs: PLUGIN_TIMEOUT_MS })
    const h = await client.getJson('/api/health', HealthSchema)
    const plugin = h.ok ? { reachable: true, inMatch: h.data.inMatch } : { reachable: false, inMatch: null }
    const next = !archiveDir ? 'fmmi setup' : fresh.files.length > 0 || pending > 0 ? 'fmmi sync' : matches > 0 ? 'fmmi report latest' : 'play a match, then ask Claude or run fmmi sync'
    const data: HomeData = { setUp: true, save, matches, archiveDir, newRecordings: fresh.files.length, inProgressRecordings: fresh.inProgress.length, needConfirming: pending, plugin, next }
    const L = [
      'FM27 match intelligence',
      `  Save:        ${safeText(save.name)}, ${matches} match${matches === 1 ? '' : 'es'}`,
      `  Recordings:  ${archiveDir ?? 'no folder set (run fmmi setup)'}${archiveDir && !existsSync(archiveDir) ? '  (folder not found: run fmmi setup)' : ''}`,
      `  New:         ${fresh.files.length === 0 ? 'nothing new' : `${fresh.files.length} recording${fresh.files.length === 1 ? '' : 's'} not imported yet (Claude imports them when asked; or run fmmi sync)`}${fresh.inProgress.length ? `; ${fresh.inProgress.length} still being recorded` : ''}`,
      `  To confirm:  ${pending === 0 ? 'nothing' : `${pending} partial recording${pending === 1 ? '' : 's'} (fmmi sync)`}`,
      `  Plugin:      ${plugin.reachable ? `reachable${plugin.inMatch ? ', a match is running' : ''}` : 'not reachable (the game is closed; only needed for live analysis)'}`,
      `Next: ${next}`,
    ]
    return { data, text: L.join('\n') }
  } finally { svc.close() }
}
