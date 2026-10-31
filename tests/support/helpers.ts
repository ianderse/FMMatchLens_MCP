import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { CatalogService, loadConfig } from '@fmmi/store'
import type { ServiceConfig } from '@fmmi/store'
import { buildSyntheticArchive } from './syntheticArchive.ts'
import type { SynthOptions } from './syntheticArchive.ts'

export const REAL_FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'local', '2026-08-31-Farnham-vs-Torquay-0-3.fmlens')
export const HAS_REAL = existsSync(REAL_FIXTURE)
/** The second real recording: an away win at Hemel Hempstead (Farnham away). Tests that need only one recording use REAL_FIXTURE and do not depend on this one. */
export const REAL_FIXTURE_HEMEL = join(import.meta.dirname, '..', 'fixtures', 'local', '2026-09-05-Hemel Hempstead-vs-Farnham-1-2.fmlens')
export const HAS_REAL_PAIR = HAS_REAL && existsSync(REAL_FIXTURE_HEMEL)

const dirs: string[] = []
export function tmp(prefix = 'fmmi-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
export function registerCleanup() {
  afterEach(() => { /* directories are removed in cleanupAll */ })
}
export function cleanupAll() {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* Windows may hold SQLite handles briefly */ } }
}

export function service(home = tmp(), over: Partial<ServiceConfig> = {}): CatalogService {
  return new CatalogService({ ...loadConfig(home, {}), ...over })
}

/** Period 2 reaches 90:00 display time, so the recording can claim to reach regulation end. */
export const FULL_PERIODS = [
  { period: 1, fromTick: 3, toTick: 11041, step: 60, displayOffset: 1 },
  { period: 2, fromTick: 11124, toTick: 22000, step: 60, displayOffset: 323 },
]

export function writeArchive(dir: string, name: string, opts: SynthOptions = {}): string {
  const p = join(dir, name)
  writeFileSync(p, buildSyntheticArchive(opts).bytes)
  return p
}
