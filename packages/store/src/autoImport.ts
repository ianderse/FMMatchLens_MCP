import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { toErrorBody } from '@fmmi/model'
import { CatalogService, isBusyError, isInProgressName, loadConfig } from './service.ts'

/**
 * Automatic import for the stdio MCP server (a deliberate deviation from spec 8: the server is otherwise read-only). It is NOT reachable from a
 * tool: the folder and the save come only from the operator's configuration (flag-free: config.json, FMMI_ARCHIVE_DIR, FMMI_DEFAULT_SAVE), a client
 * argument cannot change either. It imports finished `.fmlens` files that are new to the catalog into the configured default save, using a
 * short-lived writer connection that is separate from the server's read connection. The code lives here, in the store package, and the MCP entry
 * point injects it; the MCP sources themselves import no file API.
 */

export const AUTO_IMPORT_INTERVAL_MS = 30_000
export const AUTO_IMPORT_BUSY_TIMEOUT_MS = 500
export const AUTO_IMPORT_CALL_DEADLINE_MS = 15_000

export type AutoImportedFile = { file: string; matchId: string; recordingRevisionId: string; status: string; coverage: string | null; completion: string | null }
export interface AutoImportNotice { imported: AutoImportedFile[]; warnings: string[] }
export type AutoImportLog = (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => void

export interface AutoImporterOptions {
  home: string
  env: NodeJS.ProcessEnv
  intervalMs?: number
  busyTimeoutMs?: number
  /** How long a tool call waits for an import before answering without it (the import goes on in the background). */
  callDeadlineMs?: number
  now?: () => number
  log?: AutoImportLog
}

const signature = (name: string, size: number, mtimeMs: number) => `${name}|${size}|${mtimeMs}`

export class AutoImporter {
  private readonly o: Required<Omit<AutoImporterOptions, 'log'>> & { log: AutoImportLog }
  private lastRunAt: number | null = null
  private inFlight: Promise<void> | null = null
  /** File name -> signature last handled in this process. A directory listing equal to this needs no catalog access at all. */
  private readonly seen = new Map<string, string>()
  private pending: AutoImportNotice = { imported: [], warnings: [] }

  constructor(opts: AutoImporterOptions) {
    this.o = {
      intervalMs: AUTO_IMPORT_INTERVAL_MS, busyTimeoutMs: AUTO_IMPORT_BUSY_TIMEOUT_MS, callDeadlineMs: AUTO_IMPORT_CALL_DEADLINE_MS, now: () => Date.now(), log: () => {}, ...opts,
    }
  }

  /** Called before a catalog-reading tool call. Never throws and never waits longer than the call deadline. Returns what was imported (once) or null. */
  async beforeCall(): Promise<AutoImportNotice | null> {
    try {
      await Promise.race([this.run(), new Promise<void>((resolve) => setTimeout(resolve, this.o.callDeadlineMs).unref())])
    } catch (e) {
      this.warn('failed', e)
    }
    return this.takeNotice()
  }

  /** Runs one import round unless one ran within the interval (`force` skips the throttle: startup). A round already running is shared. */
  run(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight
    const t = this.o.now()
    if (!force && this.lastRunAt !== null && t - this.lastRunAt < this.o.intervalMs) return Promise.resolve()
    this.lastRunAt = t
    this.inFlight = this.round().catch((e) => this.warn('failed', e)).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  takeNotice(): AutoImportNotice | null {
    if (this.pending.imported.length === 0 && this.pending.warnings.length === 0) return null
    const n = this.pending
    this.pending = { imported: [], warnings: [] }
    return n
  }

  private warn(category: string, e?: unknown, extra: Record<string, string | number | undefined> = {}) {
    const code = e === undefined ? undefined : toErrorBody(e).code
    this.o.log('auto_import_failed', { category, code, errorName: e instanceof Error ? e.name : undefined, ...extra })
    const text = `auto_import_${category}: new recordings could not be imported automatically this time${category === 'busy' ? ' (the catalog is busy; it will retry)' : ''}; run \`fmmi sync\` to import them`
    if (!this.pending.warnings.includes(text)) this.pending.warnings.push(text)
  }

  private async round(): Promise<void> {
    let cfg
    try { cfg = loadConfig(this.o.home, this.o.env) } catch (e) { this.warn('config', e); return }
    const dir = cfg.archiveDir, saveId = cfg.defaultSaveId
    if (!dir || !saveId) return
    if (!existsSync(join(this.o.home, 'catalog.sqlite'))) return
    if (!existsSync(dir) || !statSync(dir).isDirectory()) { this.warn('folder_missing'); return }

    // The cheap path: a directory listing compared with what this process already handled. No hashing, no catalog.
    const listed: Array<{ name: string; path: string; sig: string }> = []
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isFile() || !d.name.toLowerCase().endsWith('.fmlens') || isInProgressName(d.name)) continue
      const path = join(dir, d.name)
      let st
      try { st = statSync(path) } catch { continue }
      listed.push({ name: d.name, path, sig: signature(d.name, st.size, st.mtimeMs) })
    }
    listed.sort((a, b) => (a.name < b.name ? -1 : 1))
    let todo = listed.filter((f) => this.seen.get(f.name) !== f.sig)
    if (todo.length === 0) return

    // Files this process has not seen: drop those the catalog already knows by file name (read-only look), so a restart does not re-hash the folder.
    const firstSight = todo.filter((f) => !this.seen.has(f.name))
    if (firstSight.length > 0) {
      const known = this.knownLocators(saveId)
      if (known === null) return
      for (const f of firstSight) if (known.has(f.name)) { this.seen.set(f.name, f.sig) }
      todo = todo.filter((f) => this.seen.get(f.name) !== f.sig)
      if (todo.length === 0) return
    }

    const writer = new CatalogService({ ...cfg, busyTimeoutMs: this.o.busyTimeoutMs })
    try {
      if (!writer.store.getSave(saveId)) { this.warn('default_save_missing'); return }
      for (const f of todo) {
        let r
        try { r = await writer.ingestFile(f.path, saveId) } catch (e) {
          if (isBusyError(e)) { this.o.log('auto_import_busy'); this.warn('busy'); return }
          throw e
        }
        if (r.status === 'rejected') {
          const retryable = r.error?.retryable === true
          this.o.log('auto_import_rejected', { code: r.error?.code, retryable })
          if (!retryable) this.seen.set(f.name, f.sig)
          this.warn('rejected', undefined, { code: r.error?.code })
          continue
        }
        this.seen.set(f.name, f.sig)
        if (r.status !== 'already_ingested') {
          this.pending.imported.push({ file: basename(f.path), matchId: r.matchId!, recordingRevisionId: r.recordingRevisionId!, status: r.status, coverage: r.coverage ?? null, completion: r.completion ?? null })
        }
      }
      if (this.pending.imported.length > 0) this.o.log('auto_import_ok', { imported: this.pending.imported.length })
    } finally { writer.close() }
  }

  /** File names the catalog has imported from, opened read-only. Null when the catalog cannot be read right now. */
  private knownLocators(saveId: string): Set<string> | null {
    let svc: CatalogService | null = null
    try {
      svc = new CatalogService({ ...loadConfig(this.o.home, this.o.env), readOnly: true })
      const known = new Set<string>()
      for (const m of svc.store.listMatches(saveId)) for (const r of svc.store.listRevisions(m.matchId)) for (const l of svc.store.listLocators(r.recordingRevisionId)) known.add(l)
      return known
    } catch (e) { this.warn('catalog', e); return null } finally { svc?.close() }
  }
}
