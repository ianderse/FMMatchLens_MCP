import { DomainError } from '@fmmi/model'

export interface Parsed { positionals: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set(['save', 'home', 'archive-dir', 'score', 'as', 'revision', 'recording-revision', 'team', 'compare', 'format', 'scope', 'from', 'to', 'from-minute', 'to-minute', 'period', 'min-passes', 'limit', 'season', 'cursor', 'players',
  'a-from', 'a-to', 'a-from-minute', 'a-to-minute', 'a-period', 'b-from', 'b-to', 'b-from-minute', 'b-to-minute', 'b-period',
  'last', 'home-away', 'metrics', 'name', 'minute', 'setting', 'prior-value', 'new-value', 'text', 'before', 'after', 'match', 'alias', 'side', 'out', 'socket-seconds', 'boundary'])
const BOOL_FLAGS = new Set(['json', 'new', 'allow-score-change', 'help', 'all-saves', 'include-partial', 'apply', 'live'])

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue }
      if (!VALUE_FLAGS.has(name)) throw new DomainError('invalid_input', `Unknown option --${name}`, { reason: 'usage' })
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new DomainError('invalid_input', `Option --${name} needs a value`, { reason: 'usage' })
      flags.set(name, v)
    } else positionals.push(a)
  }
  return { positionals, flags }
}

export const flag = (p: Parsed, n: string): string | undefined => { const v = p.flags.get(n); return typeof v === 'string' ? v : undefined }
export const has = (p: Parsed, n: string): boolean => p.flags.has(n)
export function need(p: Parsed, n: string): string {
  const v = flag(p, n)
  if (!v) throw new DomainError('invalid_input', `Missing required option --${n}`, { reason: 'usage' })
  return v
}
export function pos(p: Parsed, i: number, what: string): string {
  const v = p.positionals[i]
  if (!v) throw new DomainError('invalid_input', `Missing ${what}`, { reason: 'usage' })
  return v
}
