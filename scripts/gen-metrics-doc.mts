import { writeFileSync } from 'node:fs'
import { renderMetricsDoc } from '@fmmi/analytics'

writeFileSync('docs/metrics.md', renderMetricsDoc())
console.log('wrote docs/metrics.md')
