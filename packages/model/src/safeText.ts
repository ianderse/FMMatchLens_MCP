// Unsafe code point ranges: C0/C1 controls, soft hyphen, ALM, zero-width and bidi marks, line/paragraph separators,
// bidi embeddings/isolates, word joiner range, BOM. Built from numbers so the source stays plain ASCII.
const RANGES: Array<[number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
]

function unsafe(cp: number): boolean {
  for (const [lo, hi] of RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

/** Names in archives are untrusted data. Renderers escape control and bidi characters and bound the length. */
export function safeText(value: string | null | undefined, max = 120): string {
  if (value == null) return ''
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    out += unsafe(cp) ? '\\u{' + cp.toString(16) + '}' : ch
  }
  if (out.length > max) out = out.slice(0, max - 3) + '...'
  return out
}

/** Normalisation at the ingest boundary: bounded length, no lone surrogates. Escaping happens at render time. */
export function boundName(value: string | undefined | null, max = 200): string {
  const s = (value ?? '').toWellFormed()
  return s.length > max ? s.slice(0, max) : s
}
