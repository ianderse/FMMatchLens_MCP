// TEST-ONLY helpers for the live reader tests. Everything served here is MODELLED (see tests/support/fakePlugin.ts).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LiveReader, LocalPluginClient, RequestGovernor } from '@fmmi/live'
import type { LiveReaderOptions } from '@fmmi/live'
import { FakePlugin, loadReplay } from './fakePlugin.ts'
import type { Replay } from './fakePlugin.ts'
import { buildScenario } from './scenario.ts'
import { buildSyntheticArchive } from './syntheticArchive.ts'
import type { SynthOptions } from './syntheticArchive.ts'
import { FULL_PERIODS, tmp } from './helpers.ts'

/** A replay of a synthetic archive (labelled synthetic: invented teams and players). */
export async function syntheticReplay(over: Partial<SynthOptions> = {}, scenario: Parameters<typeof buildScenario>[0] = {}): Promise<{ replay: Replay; file: string; synth: SynthOptions }> {
  const sc = await buildScenario({ passesPerSide: 80, pureCompleted: true, periods: FULL_PERIODS, ...scenario })
  const synth: SynthOptions = { ...sc.synth, ...over }
  const file = join(tmp('fmmi-live-'), 'replay.fmlens')
  writeFileSync(file, buildSyntheticArchive(synth).bytes)
  return { replay: await loadReplay(file, 'synthetic_archive'), file, synth }
}

export interface Rig {
  plugin: FakePlugin
  client: LocalPluginClient
  reader: LiveReader
  governor: RequestGovernor
  /** Virtual wall clock in ms shared by the plugin's capture stamps and the reader. */
  time: { now: number }
  close: () => Promise<void>
}

/** A plugin on a free loopback port and a reader wired to it. Time is virtual: no real waiting, no flakiness; the rate governor runs on the same virtual clock. */
export async function rig(replay: Replay, o: Partial<LiveReaderOptions> = {}): Promise<Rig> {
  const time = { now: 1_800_000_000_000 }
  const plugin = new FakePlugin(replay)
  plugin.clock = () => time.now
  await plugin.start()
  // Virtual time for the governor: a wait advances the clock instead of sleeping.
  const governor = new RequestGovernor({ now: () => time.now, sleep: async (ms) => { time.now += ms } })
  const client = new LocalPluginClient({ port: plugin.boundPort, governor, timeoutMs: 3000 })
  const reader = new LiveReader({ client, now: () => time.now, useWebSocket: false, minSyncIntervalMs: 0, ...o })
  return { plugin, client, reader, governor, time, close: async () => { reader.close(); await plugin.stop() } }
}

/** A minimal text-frame-aware WebSocket stand-in for tests that drive the reader's socket handlers without a network socket. */
export class ScriptedSocket {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  close() { this.closed = true }
  open() { this.onopen?.({}) }
  send(data: string) { this.onmessage?.({ data }) }
  drop() { this.onclose?.({}) }
}

// ---------------------------------------------------------------- MCP wiring with the live tools (real SDK client, in-memory transport)
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { CatalogHolder, createMcpServer } from '@fmmi/mcp'
import type { Connected, Json } from './mcp.ts'

export async function connectLive(home: string, r: { reader: LiveReader } | null): Promise<Connected> {
  const holder = new CatalogHolder(home, {})
  const server = createMcpServer(holder.get, undefined, {}, () => undefined, r ? { live: { reader: r.reader, notes: holder.liveNotes, note: holder.liveNote } } : {})
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'fmmi-live-test-client', version: '0.0.0' })
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
