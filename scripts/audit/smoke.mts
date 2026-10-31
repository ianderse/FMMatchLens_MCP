import { readFileSync } from 'node:fs'
import { parseArchiveFile } from './lib/archiveParser.ts'
const b = readFileSync(process.argv[2])
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const r = await parseArchiveFile(ab as ArrayBuffer, 'x')
console.log(r.archive, r.frames.length, r.metadataTimeline.length)
