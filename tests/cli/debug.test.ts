// FMMI_DEBUG: internal errors stay opaque to clients; the opt-in variable writes the stack to stderr only, for the CLI and the MCP server.
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { main } from '@fmmi/cli'
import type { Io } from '@fmmi/cli'
import { createMcpServer } from '@fmmi/mcp'
import type { QueryAccess } from '@fmmi/mcp'
import { cleanupAll, tmp } from '../support/helpers.ts'

afterAll(cleanupAll)

const SECRET = 'boom-internal-detail'

async function cliFailure(env: Record<string, string>) {
  const home = tmp('fmmi-dbg-')
  const out: string[] = [], err: string[] = []
  let first = true
  // The first output call throws an unexpected (non-domain) error: the failure is internal by construction.
  const io: Io = { out: (s) => { if (first) { first = false; throw new Error(SECRET) } out.push(s) }, err: (s) => err.push(s), env: { FMMI_HOME: home, ...env } }
  const code = await main(['doctor'], io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function mcpFailure(env: Record<string, string>) {
  const debug: string[] = []
  const access: QueryAccess = () => { throw new Error(SECRET) }
  const server = createMcpServer(access, undefined, env, (s) => debug.push(s))
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  const client = new Client({ name: 'dbg', version: '0.0.0' })
  await client.connect(a)
  try {
    const raw = (await client.callTool({ name: 'list_matches', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> }
    return { raw, text: raw.content[0]!.text, debug: debug.join('\n') }
  } finally { await client.close(); await server.close() }
}

describe('FMMI_DEBUG', () => {
  it('CLI default: opaque internal_error, no stack and no internal detail anywhere', async () => {
    const r = await cliFailure({})
    expect(r.code).toBe(1)
    expect(r.err).toBe('error internal_error: Unexpected internal error')
    expect(r.err + r.out).not.toMatch(/boom-internal-detail|\n\s+at |\.ts:\d+/)
  })

  it('CLI with FMMI_DEBUG=1: the stack goes to stderr (after the unchanged opaque error line is still printed)', async () => {
    const r = await cliFailure({ FMMI_DEBUG: '1' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/FMMI_DEBUG Error: boom-internal-detail\n\s+at /)
    expect(r.err).toMatch(/error internal_error: Unexpected internal error/)
    expect(r.out).toBe('')
    expect((await cliFailure({ FMMI_DEBUG: '0' })).err).not.toMatch(/at /)
  })

  it('MCP default: the client gets the opaque body and nothing is written for debugging', async () => {
    const r = await mcpFailure({})
    expect(r.raw.isError).toBe(true)
    expect(JSON.parse(r.text)).toEqual({ code: 'internal_error', message: 'Unexpected internal error', details: {}, retryable: false })
    expect(r.text).not.toMatch(/boom-internal-detail|\bat \w/)
    expect(r.debug).toBe('')
  })

  it('MCP with FMMI_DEBUG=1: the stack goes to the debug (stderr) writer; the client body is identical and still opaque', async () => {
    const r = await mcpFailure({ FMMI_DEBUG: '1' })
    expect(JSON.parse(r.text)).toEqual({ code: 'internal_error', message: 'Unexpected internal error', details: {}, retryable: false })
    expect(r.debug).toMatch(/FMMI_DEBUG Error: boom-internal-detail\n\s+at /)
  })
})
