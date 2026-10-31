import { homedir } from 'node:os'
import { join } from 'node:path'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { LiveReader, LocalPluginClient } from '@fmmi/live'
import { AutoImporter } from '@fmmi/store'
import { CatalogHolder } from './catalog.ts'
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT, DEFAULT_RATE_PER_MINUTE, PRIVATE_TRANSPORTS, newToken, startRemoteServer, validateRemoteConfig } from '@fmmi/remote'
import type { PrivateTransport, RemoteConfig } from '@fmmi/remote'
import { stderrLogger } from './log.ts'
import { createMcpServer } from './server.ts'
import type { LiveAccess } from './liveTools.ts'
import { TOOLS } from './tools.ts'

const HELP = `fmmi-mcp - read-only MCP server over the fmmi catalog (stdio by default)

  fmmi-mcp [--home <dir>] [--live] [--no-auto-import]
  fmmi-mcp --http [--home <dir>] [--live] [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--token-env <NAME>] ...   (optional remote transport, OFF unless --http)
  fmmi-mcp --print-new-token

The catalog home is --home, else FMMI_HOME, else %LOCALAPPDATA%\\fmmi. The server only reads: import recordings with the fmmi CLI.
stdout carries the MCP protocol on stdio; diagnostics go to stderr. Set FMMI_DEBUG=1 to also write the stack of an unexpected error to stderr (clients still only see the opaque internal_error).

--no-auto-import  Stdio only. By default the stdio server imports new finished recordings from the configured archive folder into the default save
                  (fmmi setup) before serving a catalog-reading call, at most every 30 s. The folder and save come only from the operator's configuration,
                  never from a client. --http never imports. In-progress match-<digits>.fmlens files are skipped.
--live            Also serve get_live_match, get_live_player_analysis and get_recent_tactical_events from the LOCAL plugin (127.0.0.1:16726 only;
                  the address cannot be changed). Off by default; without it the tools are exactly the thirteen offline tools. UNVERIFIED against a real match.

Streamable HTTP (--http). It serves the same read-only tools and never proxies to the plugin.
  --host <addr>             Bind address. Default 127.0.0.1. Beyond loopback it must be a LITERAL IP of the private interface (a host name is refused, and so is any spelling of 0.0.0.0 or ::), and every item below is required.
  --port <n>                Default ${DEFAULT_PORT}.
  --token-env <NAME>        Environment variable holding the bearer token (default FMMI_MCP_TOKEN). A token is ALWAYS required, at least 24 characters.
  --allow-non-loopback      Explicit opt-in for a non-loopback bind.
  --private-transport <t>   ${PRIVATE_TRANSPORTS.join(' | ')}. Your statement that traffic beyond loopback is protected (this server speaks plain HTTP).
  --allow-host <host[:port]>   Host header to accept besides the loopback names (repeatable; required for a non-loopback bind).
  --allow-origin <origin>   Origin to accept (repeatable). By default a request that carries an Origin header is refused.
  --rate-limit <n>          Requests per minute per client (default ${DEFAULT_RATE_PER_MINUTE}).
  --max-body <bytes>        Request body limit (default ${DEFAULT_MAX_BODY_BYTES}).
  --print-new-token         Print a fresh random token and exit. Put it in the environment variable; it is never logged.`

export interface McpIo {
  env: NodeJS.ProcessEnv
  err: (s: string) => void
  /** Test hooks: stop an HTTP server without a signal, and learn its address. */
  abort?: AbortSignal
  onListening?: (url: string) => void
  /** TEST ONLY: the fake plugin port. No flag or variable reaches it. */
  livePort?: number
  out?: (s: string) => void
  /** TEST ONLY: replaces the importer of the stdio server (a fake clock or folder). Ignored by --http, which never imports. */
  autoImport?: Pick<AutoImporter, 'beforeCall' | 'run'>
}

interface Parsed {
  home?: string; live: boolean; autoImport: boolean; http: boolean; host: string; port: number; tokenEnv: string; allowNonLoopback: boolean; privateTransport: string | null
  allowHosts: string[]; allowOrigins: string[]; rate: number; maxBody: number; printToken: boolean
}

function parse(argv: string[]): Parsed | { error: string } | 'help' {
  const p: Parsed = { live: false, autoImport: true, http: false, host: '127.0.0.1', port: DEFAULT_PORT, tokenEnv: 'FMMI_MCP_TOKEN', allowNonLoopback: false, privateTransport: null, allowHosts: [], allowOrigins: [], rate: DEFAULT_RATE_PER_MINUTE, maxBody: DEFAULT_MAX_BODY_BYTES, printToken: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const name = a.startsWith('--') ? (eq > 0 ? a.slice(0, eq) : a) : a
    const value = (): string | undefined => (eq > 0 ? a.slice(eq + 1) : argv[++i])
    const need = (): string | { error: string } => { const v = value(); return v === undefined || v.startsWith('--') ? { error: `fmmi-mcp: ${name} needs a value` } : v }
    switch (name) {
      case '--help': case '-h': return 'help'
      case '--live': p.live = true; break
      case '--no-auto-import': p.autoImport = false; break
      case '--http': p.http = true; break
      case '--allow-non-loopback': p.allowNonLoopback = true; break
      case '--print-new-token': p.printToken = true; break
      case '--home': case '--host': case '--port': case '--token-env': case '--private-transport': case '--allow-host': case '--allow-origin': case '--rate-limit': case '--max-body': {
        const v = need()
        if (typeof v !== 'string') return v
        if (name === '--home') p.home = v
        else if (name === '--host') p.host = v
        else if (name === '--port') p.port = Number(v)
        else if (name === '--token-env') p.tokenEnv = v
        else if (name === '--private-transport') p.privateTransport = v
        else if (name === '--allow-host') p.allowHosts.push(v)
        else if (name === '--allow-origin') p.allowOrigins.push(v)
        else if (name === '--rate-limit') p.rate = Number(v)
        else p.maxBody = Number(v)
        break
      }
      default: return { error: `fmmi-mcp: unknown argument ${JSON.stringify(a.slice(0, 40))}` }
    }
  }
  return p
}

export async function main(argv: string[], io: McpIo = { env: process.env, err: (s) => process.stderr.write(s + '\n') }): Promise<number> {
  const parsed = parse(argv)
  if (parsed === 'help') { io.err(HELP); return 0 }
  if ('error' in parsed) { io.err(`${parsed.error}\n${HELP}`); return 2 }
  if (parsed.printToken) { (io.out ?? ((s) => process.stdout.write(s + '\n')))(newToken()); return 0 }

  const resolved = parsed.home ?? io.env.FMMI_HOME ?? join(io.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'fmmi')
  const holder = new CatalogHolder(resolved, io.env)

  let live: LiveAccess | undefined
  if (parsed.live) {
    const reader = new LiveReader({ client: new LocalPluginClient({ port: io.livePort }), log: (e, f) => stderrLogger(e, f) })
    live = {
      reader,
      notes: (id) => holder.liveNotes(id),
      note: (id) => holder.liveNote(id),
    }
  }
  const toolCount = TOOLS.length + (live ? 3 : 0)

  if (parsed.http) {
    const cfg: RemoteConfig = {
      host: parsed.host, port: parsed.port, token: io.env[parsed.tokenEnv] ?? '', allowNonLoopback: parsed.allowNonLoopback,
      privateTransport: (PRIVATE_TRANSPORTS as readonly string[]).includes(parsed.privateTransport ?? '') ? (parsed.privateTransport as PrivateTransport) : null,
      allowedHosts: parsed.allowHosts, allowedOrigins: parsed.allowOrigins, ratePerMinute: parsed.rate, maxBodyBytes: parsed.maxBody,
    }
    try {
      if (parsed.privateTransport !== null && cfg.privateTransport === null) throw new Error(`--private-transport must be one of ${PRIVATE_TRANSPORTS.join(', ')}`)
      validateRemoteConfig(cfg)
    } catch (e) {
      // The message never contains the token. The environment variable is named, not its value.
      io.err(`fmmi-mcp: ${e instanceof Error ? e.message : 'invalid configuration'}${cfg.token === '' ? ` (environment variable ${parsed.tokenEnv} is not set)` : ''}`)
      holder.close(); live?.reader.close()
      return 2
    }
    const remote = await startRemoteServer(cfg, () => createMcpServer(holder.get, stderrLogger, io.env, (s) => { process.stderr.write(s + '\n') }, { live }), stderrLogger)
    stderrLogger('started', { transport: 'streamable-http', tools: toolCount, live: !!live, bind: parsed.host, port: remote.port, loopback: parsed.host === '127.0.0.1' || parsed.host === '::1' || parsed.host === 'localhost' })
    io.onListening?.(remote.url)
    await new Promise<void>((resolve) => {
      const stop = () => resolve()
      io.abort?.addEventListener('abort', stop, { once: true })
      if (!io.abort) { process.once('SIGINT', stop); process.once('SIGTERM', stop) }
    })
    await remote.close()
    holder.close(); live?.reader.close()
    stderrLogger('stopped')
    return 0
  }

  // Stdio only. The importer is the one write path of this server; it reads the operator's configuration, never anything a client sends.
  const autoImport = parsed.autoImport ? (io.autoImport ?? new AutoImporter({ home: resolved, env: io.env, log: (e, f) => stderrLogger(e, f) })) : undefined
  void autoImport?.run(true)
  const handle = serveStdio(() => createMcpServer(holder.get, stderrLogger, io.env, (s) => { process.stderr.write(s + '\n') }, { live, autoImport }), { onerror: (e) => stderrLogger('transport_error', { errorName: e.name }) })
  stderrLogger('started', { tools: toolCount, live: !!live })
  await new Promise<void>((resolve) => {
    process.stdin.once('end', () => resolve())
    process.stdin.once('close', () => resolve())
  })
  await handle.close()
  holder.close(); live?.reader.close()
  stderrLogger('stopped')
  return 0
}
