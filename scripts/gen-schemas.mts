import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import {
  CompareResultSchema, ListPlayersResultSchema, NetworkResultSchema, PlayerResultSchema, PlayerTrendsResultSchema, ReportResultSchema, SeasonTrendsResultSchema, ServiceResultSchema,
  SummaryResultSchema, TacticalChangeResultSchema, TacticalNotesResultSchema, ThreatResultSchema,
} from '@fmmi/analytics'
import { ErrorEnvelopeSchema, IngestResultSchema, ListDataSchema, SaveSchema, ShowDataSchema, okEnvelope } from '@fmmi/model'

mkdirSync('schemas', { recursive: true })
const out: Record<string, z.ZodType> = {
  'error.schema.json': ErrorEnvelopeSchema,
  'save.schema.json': okEnvelope(SaveSchema),
  'ingest.schema.json': okEnvelope(z.object({ results: z.array(IngestResultSchema) })),
  'list.schema.json': okEnvelope(ListDataSchema),
  'show.schema.json': okEnvelope(ShowDataSchema),
  'report.schema.json': okEnvelope(ReportResultSchema),
  'player.schema.json': okEnvelope(PlayerResultSchema),
  'network.schema.json': okEnvelope(NetworkResultSchema),
  'service.schema.json': okEnvelope(ServiceResultSchema),
  'summary.schema.json': okEnvelope(SummaryResultSchema),
  'compare.schema.json': okEnvelope(CompareResultSchema),
  'threat.schema.json': okEnvelope(ThreatResultSchema),
  'trends.schema.json': okEnvelope(SeasonTrendsResultSchema),
  'players.schema.json': okEnvelope(ListPlayersResultSchema),
  'player-trends.schema.json': okEnvelope(PlayerTrendsResultSchema),
  'notes.schema.json': okEnvelope(TacticalNotesResultSchema),
  'tactical-change.schema.json': okEnvelope(TacticalChangeResultSchema),
}
for (const [name, schema] of Object.entries(out)) writeFileSync(`schemas/${name}`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n')
console.log(`wrote ${Object.keys(out).length} schemas to schemas/`)
