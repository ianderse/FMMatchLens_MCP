import { DomainError, SUPPORTED_FORMAT } from '@fmmi/model'
import type { DecodedRecording } from '@fmmi/model'
import { parseArchiveFile } from './upstream/archiveParser.ts'
import type { ArchiveLimits } from './upstream/archiveParser.ts'
import { RecordingBuilder } from './normalize.ts'

export interface DecodeOptions { fileName?: string; limits?: Partial<ArchiveLimits> }

/** Source of recordings. The `.fmlens` file decoder is one implementation; a live API reader would be another. */
export interface ArchiveDecoder {
  readonly id: string
  readonly supportedFormats: readonly string[]
  decode(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodedRecording>
}

const MAGIC = 'FMLENS2\0'

function kindOf(message: string): { kind: string; code: 'invalid_input' | 'unsupported_version' } {
  if (/Not a valid FMMatchLens archive/.test(message)) return { kind: 'bad_magic', code: 'invalid_input' }
  if (/Unsupported archive structure/.test(message)) return { kind: 'unsupported_version', code: 'unsupported_version' }
  if (/CRC/.test(message)) return { kind: 'crc_mismatch', code: 'invalid_input' }
  if (/limit|Invalid block length|exceeds the declared length/.test(message)) return { kind: 'size_limit', code: 'invalid_input' }
  if (/no complete match frames|no recoverable/.test(message)) return { kind: 'no_frames', code: 'invalid_input' }
  if (/incomplete record|ends with/.test(message)) return { kind: 'truncated', code: 'invalid_input' }
  if (/revision/.test(message)) return { kind: 'metadata_revision_order', code: 'invalid_input' }
  return { kind: 'malformed', code: 'invalid_input' }
}

export class FmlensV28Decoder implements ArchiveDecoder {
  readonly id = 'fmlens-2.8'
  readonly supportedFormats = [SUPPORTED_FORMAT] as const

  async decode(bytes: Uint8Array, options: DecodeOptions = {}): Promise<DecodedRecording> {
    if (bytes.byteLength < 16) throw new DomainError('invalid_input', 'Archive is too short to contain a header', { kind: 'truncated' })
    const magic = String.fromCharCode(...bytes.subarray(0, 8))
    if (magic !== MAGIC) throw new DomainError('invalid_input', 'Not a valid FMMatchLens archive', { kind: 'bad_magic' })
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const found = `${dv.getUint16(8, true)}.${dv.getUint16(10, true)}`
    if (found !== SUPPORTED_FORMAT) {
      throw new DomainError('unsupported_version', `Archive format ${found} is not supported; only ${SUPPORTED_FORMAT}`, { found, supported: [SUPPORTED_FORMAT] })
    }
    const builder = new RecordingBuilder()
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    try {
      const parsed = await parseArchiveFile(ab, options.fileName ?? 'archive.fmlens', { limits: options.limits, onFrame: builder.onFrame })
      if (!parsed.metadata) throw new DomainError('invalid_input', 'Archive has no match metadata', { kind: 'no_metadata' })
      return builder.finish(parsed, parsed.metadata, bytes.byteLength)
    } catch (e) {
      if (e instanceof DomainError) throw e
      const m = e instanceof Error ? e.message : ''
      const k = kindOf(m)
      // Parser messages are fixed strings (no paths); expose the kind and the parser message only.
      throw new DomainError(k.code, `Archive rejected: ${k.kind}`, { kind: k.kind, parser: m.slice(0, 200) })
    }
  }
}
