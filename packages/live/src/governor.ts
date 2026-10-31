/**
 * Explicit cap on the request rate to the plugin (spec 9.2, slice 5 "protect game performance"). A sliding window: at most
 * `requests` HTTP requests in any `perMs` span. Callers wait for a slot instead of failing; waiting is bounded by the cap, so a burst of
 * work (a long catch-up of historical pages, many tool calls at once) is spread out and the game is never hammered.
 *
 * The constants below are the ceiling. A caller may ask for a lower rate (tests do); it can never ask for a higher one.
 */
export const PLUGIN_RATE_CAP = { requests: 4, perMs: 1000 } as const

export interface GovernorOptions {
  requests?: number
  perMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class RequestGovernor {
  readonly requests: number
  readonly perMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly stamps: number[] = []
  private chain: Promise<void> = Promise.resolve()
  private granted = 0
  private waitedMs = 0

  constructor(o: GovernorOptions = {}) {
    // Never above the ceiling rate (requests / perMs <= 4 per second): a faster request is clamped, not honoured.
    this.requests = Math.max(1, Math.min(o.requests ?? PLUGIN_RATE_CAP.requests, PLUGIN_RATE_CAP.requests))
    this.perMs = Math.max(this.requests * (PLUGIN_RATE_CAP.perMs / PLUGIN_RATE_CAP.requests), o.perMs ?? PLUGIN_RATE_CAP.perMs)
    this.now = o.now ?? (() => performance.now())
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Resolves when the caller may send one request. Requests are granted strictly in call order. */
  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const t = this.now()
        while (this.stamps.length > 0 && t - this.stamps[0]! >= this.perMs) this.stamps.shift()
        if (this.stamps.length < this.requests) { this.stamps.push(t); this.granted++; return }
        const wait = this.perMs - (t - this.stamps[0]!)
        this.waitedMs += wait
        await this.sleep(Math.max(1, Math.ceil(wait)))
      }
    })
    this.chain = next.catch(() => undefined)
    return next
  }

  stats() { return { cap: { requests: this.requests, perMs: this.perMs }, granted: this.granted, waitedMs: Math.round(this.waitedMs) } }
}
