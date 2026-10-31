/**
 * The ONLY place the plugin address exists. FMMatchLens listens on loopback (spec 2.1, 9.3, 10); this reader talks to
 * `http://127.0.0.1:16726` and `ws://127.0.0.1:16726/ws` and to nothing else. There is deliberately no environment variable,
 * config key, CLI flag or MCP argument for the host or the port: a different address is a code change, not a setting.
 * The one exception is the `port` of `LocalPluginClient`, a constructor argument that exists so the test-only fake plugin can bind a
 * free port on the same loopback address. The host cannot be changed even there, and no entry point in this repository passes it.
 */
export const LIVE_HOST = '127.0.0.1' as const
export const LIVE_PORT = 16726 as const

/** Paths the reader may request. Anything else is refused before a socket is opened. */
const ALLOWED_PATH = /^\/api\/(health|archives|match\/(current|meta|status|frames|formation\/history|momentum\/(events|updates)))(\?[A-Za-z0-9=&._-]{0,200})?$/

export function assertPluginPath(path: string): void {
  if (!ALLOWED_PATH.test(path)) throw new Error('path_not_allowed')
}

export function httpBase(port: number = LIVE_PORT): string { return `http://${LIVE_HOST}:${port}` }
export function wsUrl(port: number = LIVE_PORT): string { return `ws://${LIVE_HOST}:${port}/ws` }

/**
 * What the evidence for each route is. `observed` means a real plugin answered it and the response was recorded in
 * docs/data-coverage.md section 10. `modelled` means the shape comes from the vendored v0.7.0 source (frontend
 * realtimeMatch.ts) and has never been seen from a running plugin. The WebSocket has never been observed either.
 */
export interface EndpointSpec { id: string; path: string; basis: 'observed' | 'modelled' }
export const ENDPOINTS: readonly EndpointSpec[] = [
  { id: 'health', path: '/api/health', basis: 'observed' },
  { id: 'archives', path: '/api/archives?page=1&pageSize=5', basis: 'observed' },
  { id: 'status', path: '/api/match/status', basis: 'observed' },
  { id: 'meta', path: '/api/match/meta', basis: 'modelled' },
  { id: 'current', path: '/api/match/current', basis: 'modelled' },
  { id: 'frames', path: '/api/match/frames?fromTick=0&stride=1&limit=3', basis: 'modelled' },
  { id: 'formation_history', path: '/api/match/formation/history?fromIndex=0&limit=8', basis: 'modelled' },
  { id: 'momentum_events', path: '/api/match/momentum/events', basis: 'modelled' },
  { id: 'momentum_updates', path: '/api/match/momentum/updates?after=0&limit=8', basis: 'modelled' },
] as const
