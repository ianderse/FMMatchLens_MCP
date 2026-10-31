#!/usr/bin/env node
// Thin launcher: Node strips TypeScript types natively (>= 22.18). stdout is the MCP channel, so every notice goes to stderr.
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /type stripping|SQLite/i.test(w.message)) return
  console.error(`${w.name}: ${w.message}`)
})
const { main } = await import('../src/main.ts')
process.exitCode = await main(process.argv.slice(2))
