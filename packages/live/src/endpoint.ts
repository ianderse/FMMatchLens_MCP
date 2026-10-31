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
 * What the evidence for each route is. `observed` means a real plugin answered it and, for the routes the reader parses, the response
 * was accepted by this project's schema: health, archives and status (docs/data-coverage.md section 10) and, on 2026-10-31 during a
 * real match, meta, current, frames and formation history (the reader reached `fresh`; one real match, one session).
 * `observed_route_only` means the route answered during that match but this project does not parse or validate its body (the momentum
 * routes, whose schema accepts any object or array). `modelled` means the shape comes only from the vendored v0.7.0 source
 * (frontend realtimeMatch.ts); no route is `modelled` any more, the value is kept for a route that has not been seen. The WebSocket is
 * `basis: 'websocket'` in the check report: `connection_status` and `realtime_tick` were seen, `formation_changed` was not.
 */
export interface EndpointSpec { id: string; path: string; basis: 'observed' | 'observed_route_only' | 'modelled' }
export const ENDPOINTS: readonly EndpointSpec[] = [
  { id: 'health', path: '/api/health', basis: 'observed' },
  { id: 'archives', path: '/api/archives?page=1&pageSize=5', basis: 'observed' },
  { id: 'status', path: '/api/match/status', basis: 'observed' },
  { id: 'meta', path: '/api/match/meta', basis: 'observed' },
  { id: 'current', path: '/api/match/current', basis: 'observed' },
  { id: 'frames', path: '/api/match/frames?fromTick=0&stride=1&limit=3', basis: 'observed' },
  { id: 'formation_history', path: '/api/match/formation/history?fromIndex=0&limit=8', basis: 'observed' },
  { id: 'momentum_events', path: '/api/match/momentum/events', basis: 'observed_route_only' },
  { id: 'momentum_updates', path: '/api/match/momentum/updates?after=0&limit=8', basis: 'observed_route_only' },
] as const
