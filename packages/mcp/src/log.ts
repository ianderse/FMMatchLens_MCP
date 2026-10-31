/**
 * Logging goes to stderr only: stdout is the MCP channel and a stray byte there corrupts the protocol. Lines carry
 * internal ids, durations, sizes and error categories. They never carry absolute paths, raw frames, names or stack traces.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>
export type Logger = (event: string, fields?: LogFields) => void

export const stderrLogger: Logger = (event, fields = {}) => {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
}
export const silentLogger: Logger = () => {}
