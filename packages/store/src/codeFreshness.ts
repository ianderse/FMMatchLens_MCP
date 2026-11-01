import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * An MCP client keeps the server it started, so a session left open across an update answers from old code with nothing to show for it. This
 * compares the newest source modification time with the one at startup, at most once per interval, and never throws. Like the importer it lives
 * in the store package because the MCP sources import no file API.
 */
export const CODE_CHECK_INTERVAL_MS = 60_000

const DEFAULT_PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

function newestSourceMs(packagesDir: string): number | null {
  try {
    let newest = 0
    for (const pkg of readdirSync(packagesDir)) {
      const src = join(packagesDir, pkg, 'src')
      let names: string[]
      try { names = readdirSync(src, { recursive: true, encoding: 'utf8' }) } catch { continue }
      for (const name of names) if (name.endsWith('.ts')) newest = Math.max(newest, statSync(join(src, name)).mtimeMs)
    }
    return newest
  } catch { return null }
}

export class CodeFreshness {
  private readonly dir: string
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly startedAt: number | null
  private checkedAt: number
  private isChanged = false

  constructor(o: { packagesDir?: string; intervalMs?: number; now?: () => number } = {}) {
    this.dir = o.packagesDir ?? DEFAULT_PACKAGES_DIR
    this.intervalMs = o.intervalMs ?? CODE_CHECK_INTERVAL_MS
    this.now = o.now ?? (() => Date.now())
    this.startedAt = newestSourceMs(this.dir)
    this.checkedAt = this.now()
  }

  /** True once the code on disk is newer than the code this process loaded. An unreadable tree reports false: this is a hint, not a gate. */
  changed(): boolean {
    if (this.isChanged || this.startedAt === null || this.now() - this.checkedAt < this.intervalMs) return this.isChanged
    this.checkedAt = this.now()
    const newest = newestSourceMs(this.dir)
    this.isChanged = newest !== null && newest > this.startedAt
    return this.isChanged
  }
}
