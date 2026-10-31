import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'

/**
 * Everything the CLI needs from the outside world, as plain values so tests inject them: the terminal (prompts), child processes (`claude`) and
 * the Steam install directories. The real implementations are below and are only used by the real entry point.
 */
export interface Prompter {
  /** False without a terminal, and always false under --json: nothing may prompt there. */
  readonly interactive: boolean
  /** The user's answer, or null at end of input. */
  ask(question: string): Promise<string | null>
  close?(): void
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; /** The executable does not exist. */ missing: boolean }
export type ProcessRunner = (command: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult>

export const nonInteractive: Prompter = { interactive: false, ask: () => Promise.resolve(null) }

export function stdinPrompter(): Prompter {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let rl: Interface | null = null
  return {
    interactive,
    ask: (question) => new Promise((resolve) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout })
      let answered = false
      rl.once('close', () => { if (!answered) resolve(null) })
      rl.question(question, (a) => { answered = true; resolve(a) })
    }),
    close: () => { rl?.close(); rl = null },
  }
}

// ---------------------------------------------------------------------------------------------- executables and processes

export interface Executable { path: string; /** A Windows batch shim: it can only run through cmd.exe. */ viaCmd: boolean }

/** Finds `name` on PATH. On Windows a real `.exe` wins over a `.cmd` shim. Pure apart from the injected existence check. */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): Executable | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const exts = platform === 'win32' ? ['.exe', '.cmd'] : ['']
  for (const ext of exts) {
    for (const d of dirs) {
      const p = join(d, name + ext)
      if (exists(p)) return { path: p, viaCmd: ext === '.cmd' }
    }
  }
  return null
}

/** One argument of a cmd.exe command line. Characters cmd.exe would interpret are refused rather than escaped. */
export function quoteForCmd(arg: string): string {
  if (/["%^&|<>!\r\n]/.test(arg)) throw new Error('unsupported_character')
  return arg === '' || /[\s()]/.test(arg) ? `"${arg}"` : arg
}

/** Spawns with an argument array (never a shell string), so no shell, PowerShell included, can eat `--` or `--live`. */
export const defaultRunner: ProcessRunner = (command, args, opts = {}) => new Promise((resolve) => {
  const exe = resolveExecutable(command, process.env)
  if (!exe) { resolve({ code: null, stdout: '', stderr: '', missing: true }); return }
  let child
  try {
    child = exe.viaCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[exe.path, ...args].map(quoteForCmd).join(' ')}"`], { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(exe.path, args, { cwd: opts.cwd, windowsHide: true })
  } catch { resolve({ code: null, stdout: '', stderr: 'could not start the process', missing: false }); return }
  let stdout = '', stderr = ''
  const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60_000)
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
  child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || 'could not start the process', missing: false }) })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, missing: false }) })
})
