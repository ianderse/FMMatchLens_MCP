import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Content-addressed, immutable, managed copies of accepted archives. Originals are never touched. */
export class SnapshotDir {
  readonly root: string
  constructor(home: string) { this.root = join(home, 'snapshots') }

  relPath(sha256: string): string { return `snapshots/${sha256.slice(0, 2)}/${sha256}.fmlens` }
  absPath(home: string, rel: string): string { return join(home, ...rel.split('/')) }

  /** Writes the snapshot unless an identical-size file already exists. Returns the relative path. */
  put(home: string, sha256: string, bytes: Uint8Array): string {
    const rel = this.relPath(sha256)
    const abs = this.absPath(home, rel)
    if (existsSync(abs)) {
      if (statSync(abs).size === bytes.byteLength) return rel
    }
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, bytes, { flag: 'wx' })
    try { chmodSync(tmp, 0o444) } catch { /* best effort on Windows */ }
    renameSync(tmp, abs)
    return rel
  }

  /** True when the snapshot file exists with exactly this size. Cheap check used before serving from a cache. */
  hasSize(home: string, rel: string, size: number): boolean {
    try { return statSync(this.absPath(home, rel)).size === size } catch { return false }
  }

  read(home: string, rel: string): Buffer { return readFileSync(this.absPath(home, rel)) }
}
