// Review checker for SAVED assistant responses (spec Slice 3). Evaluation tool, not a CI golden test.
//   node scripts/review-check.mts --response review.md --results tool-results.json [--json]
// tool-results.json: one JSON value or an array of tool results exactly as the tools returned them
// (an MCP CallToolResult, {tool, arguments, result}, or the raw payload). Exit codes: 0 pass, 1 fail, 2 usage.
import { readFileSync } from 'node:fs'
import { checkReview } from '../packages/mcp/src/reviewCheck.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const responsePath = arg('response'), resultsPath = arg('results')
if (!responsePath || !resultsPath) {
  console.error('usage: node scripts/review-check.mts --response <file.md> --results <tool-results.json> [--json]')
  process.exit(2)
}
let report
try {
  report = checkReview(readFileSync(responsePath, 'utf8'), JSON.parse(readFileSync(resultsPath, 'utf8')))
} catch (e) {
  console.error(`review-check: cannot read inputs: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(report.ok ? 'PASS' : 'FAIL')
  console.log(`sections: ${report.sections.found.map((f) => f.key).join(', ') || 'none'}`)
  console.log(`action units: ${report.action.units}${report.action.withheld ? ' (withheld)' : ''}`)
  console.log(`cited ids ${report.citations.ids.cited.length}, metrics ${report.citations.metrics.cited.length}, windows ${report.citations.windows.cited.length}`)
  for (const f of report.failures) console.log(`  failure: ${f}`)
  for (const w of report.warnings) console.log(`  warning: ${w}`)
}
process.exit(report.ok ? 0 : 1)
