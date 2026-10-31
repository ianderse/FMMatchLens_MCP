// TEST-ONLY helpers for the MCP adapter: seed an FMMI_HOME-isolated catalog (never the user's real one), connect a real
// SDK v2 client to the real server over an in-memory transport, and call tools. No Football Manager process is involved.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { CatalogHolder, createMcpServer } from '@fmmi/mcp'
import type { DecodedCacheOptions } from '@fmmi/query'
import { CatalogService, loadConfig } from '@fmmi/store'
import { buildSyntheticArchive } from './syntheticArchive.ts'
import type { SynthOptions } from './syntheticArchive.ts'
import { tmp } from './helpers.ts'

export interface Seed {
  home: string
  saveId: string
  matchId: string
  revisionId: string
  homeTeamId: string
  awayTeamId: string
}

export function openWriter(home: string): CatalogService { return new CatalogService(loadConfig(home, {})) }

/** Imports one archive file into a fresh isolated catalog and returns the ids the tools would hand out. */
export async function seedFile(file: string, home = tmp('fmmi-mcp-')): Promise<Seed> {
  const w = openWriter(home)
  try {
    const save = w.createSave('Test save')
    const r = await w.ingestFile(file, save.saveId)
    if (r.status !== 'ingested') throw new Error(`seed ingest failed: ${r.status} ${JSON.stringify(r.error)}`)
    const m = w.listMatches(save.saveId).matches[0]!
    return { home, saveId: save.saveId, matchId: m.matchId, revisionId: m.selectedRecordingRevisionId, homeTeamId: m.home.teamId, awayTeamId: m.away.teamId }
  } finally { w.close() }
}

export async function seedSynthetic(synth: SynthOptions, home = tmp('fmmi-mcp-')): Promise<Seed> {
  const file = join(tmp('fmmi-arch-'), 'a.fmlens')
  writeFileSync(file, buildSyntheticArchive(synth).bytes)
  return seedFile(file, home)
}

/** Adds another archive to an existing catalog through a separate writer connection (a concurrent import). */
export async function importMore(home: string, saveId: string, synth: SynthOptions, name = 'b.fmlens') {
  const file = join(tmp('fmmi-arch-'), name)
  writeFileSync(file, buildSyntheticArchive(synth).bytes)
  const w = openWriter(home)
  try { return await w.ingestFile(file, saveId) } finally { w.close() }
}

/** Imports an archive into a brand-new save profile of an existing catalog. */
export async function importToNewSave(home: string, synth: SynthOptions, name = 'other.fmlens') {
  const file = join(tmp('fmmi-arch-'), name)
  writeFileSync(file, buildSyntheticArchive(synth).bytes)
  const w = openWriter(home)
  try {
    const save = w.createSave('Second save')
    const r = await w.ingestFile(file, save.saveId)
    return { ...r, saveId: save.saveId }
  } finally { w.close() }
}

/** Parsed tool payloads are checked field by field in the tests, so they are loosely typed here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any

export interface ToolCall { isError: boolean; text: string; data: Json; raw: Json }

export interface Connected {
  client: Client
  holder: CatalogHolder
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolCall>
  close: () => Promise<void>
}

export async function connect(home: string, cache?: DecodedCacheOptions): Promise<Connected> {
  const holder = new CatalogHolder(home, {}, cache)
  const server = createMcpServer(holder.get)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'fmmi-test-client', version: '0.0.0' })
  await client.connect(clientSide)
  return {
    client, holder,
    async call(name, args = {}) {
      const raw: Json = await client.callTool({ name, arguments: args })
      const text: string = raw.content?.[0]?.text ?? ''
      let data: Json
      try { data = JSON.parse(text) } catch { data = undefined }
      return { isError: raw.isError === true, text, data, raw }
    },
    async close() { await client.close(); await server.close(); holder.close() },
  }
}

export const KB = 1024
