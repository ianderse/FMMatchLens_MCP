// The published JSON schemas for the Slice 4 results are generated from the same zod schemas the queries validate with.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ListPlayersResultSchema, PlayerTrendsResultSchema, SeasonTrendsResultSchema, TacticalChangeResultSchema, TacticalNotesResultSchema } from '@fmmi/analytics'
import { okEnvelope } from '@fmmi/model'

const ROOT = join(import.meta.dirname, '..', '..')

describe('Slice 4 published schemas', () => {
  it('schemas/*.schema.json for trends, players, player-trends, notes and tactical-change are current (run `npm run schemas`)', () => {
    const files: Array<[string, z.ZodType]> = [
      ['trends.schema.json', SeasonTrendsResultSchema], ['players.schema.json', ListPlayersResultSchema], ['player-trends.schema.json', PlayerTrendsResultSchema],
      ['notes.schema.json', TacticalNotesResultSchema], ['tactical-change.schema.json', TacticalChangeResultSchema],
    ]
    for (const [name, schema] of files) {
      expect(readFileSync(join(ROOT, 'schemas', name), 'utf8'), name).toBe(JSON.stringify(z.toJSONSchema(okEnvelope(schema)), null, 2) + '\n')
    }
  })
})
