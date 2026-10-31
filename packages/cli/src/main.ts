import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomainError, debugReport, safeText, toErrorBody } from '@fmmi/model'
import { CatalogService, loadConfig } from '@fmmi/store'
import { renderNetwork, renderPlayer, renderReport, renderService, renderThreat } from '@fmmi/analytics'
import { LocalPluginClient, LiveReader, HealthSchema, captureShapes, checkCapture, liveBoundary, liveNoteCompare, snapshotLabel } from '@fmmi/live'
import type { Capture } from '@fmmi/live'
import { MatchQueries, parseBoundary, parseScope } from '@fmmi/query'
import type { CommonOptions } from '@fmmi/query'
import { flag, has, need, parseArgs, pos } from './args.ts'
import { renderCompare, renderDoctor, renderIngest, renderList, renderSaves, renderShow, renderStatus, renderSummary } from './render.ts'
import { defaultRunner, nonInteractive, stdinPrompter } from './io.ts'
import type { ProcessRunner, Prompter } from './io.ts'
import { homeScreen } from './home.ts'
import { defaultHomeOf, runSetup } from './setup.ts'
import { confirmFlow, importLines } from './sync.ts'
import { renderLiveCapture, renderLiveCheck, renderLiveNoteCompare } from './renderLive.ts'
import { renderManaged, renderNotes, renderPlayerLink, renderPlayerTrends, renderPlayers, renderTacticalChange, renderTrends } from './renderHistory.ts'

/** `livePort` is TEST ONLY: it lets the tests point the live commands at the fake plugin. No flag, variable or file reaches it; the host is fixed to 127.0.0.1 in @fmmi/live. */
export interface Io {
  out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; livePort?: number
  /** Prompts. Absent means no terminal: nothing is ever asked. Under --json it is ignored. */
  prompt?: Prompter
  /** Runs `claude` for setup. Defaults to a real child process (argument array, no shell). Tests inject a fake: they never touch the real Claude config. */
  run?: ProcessRunner
  /** Steam install directories searched by setup. Defaults to the standard Windows locations. Tests point it at a temporary folder. */
  steamRoots?: string[]
}
const defaultIo: Io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n'), env: process.env, prompt: stdinPrompter() }
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')

const HELP = `fmmi - FM27 match intelligence

Start here
  fmmi setup                          one-time guided setup: finds your recordings folder, creates the save, imports, registers Claude Code
                                      (--yes --archive-dir <folder> --save-name <name> --no-mcp for scripts)
  fmmi sync                           optional: import new recordings now and confirm the final score of partial ones
                                      (--include-in-progress --all). With the MCP server connected, Claude imports new recordings itself.
  fmmi report [latest|<team>|<id>]    the match report (default: the latest match)
  fmmi                                home screen: your save, matches, what is new, the next step

References: --save is optional everywhere (the default save, else the only save) and takes a save name or id. A <matchId> may be
  latest, an exact id or a team-name fragment such as hemel; a <playerId> may be a p_ id, a pe_ id or a name fragment such as alexander.
  An ambiguous reference lists the candidates and stops. --team defaults to your club where a command needs one.

All commands

  fmmi doctor
  fmmi save create <name> | save list
  fmmi ingest <file-or-dir> [--save <save>]
  fmmi ingest --new [--save <save>]            (configured archive directory)
  fmmi list [--save <save>] | --all-saves [--team <teamId>] [--season <label>] [--limit <n>] [--cursor <cursor>]
  fmmi show <matchId> [--revision <recordingRevisionId>]
  fmmi match confirm <matchId> --score <home>-<away> [--allow-score-change]
  fmmi match move <matchId> [--save <save>]
  fmmi recording resolve <recordingRevisionId> --as separate-occurrence|ignored|continuation|alternate
        (continuation is verified from the frames: the selected revision must be an unchanged prefix of this recording; alternate is your choice
         of a different recording of the same match. Every earlier revision stays inspectable and pinnable.)
  fmmi report <matchId> [--format text|markdown]
  fmmi player <matchId> <playerId>
  fmmi network <matchId> --team <teamId> [--min-passes <n>] [--limit <n>]
  fmmi service <matchId> <playerId> [--compare <playerId>]
  fmmi threat <matchId> --team <teamId>                         (how the opponent of --team created chances, by attacking lane)
  fmmi summary <matchId> [--team <teamId>]                       (compact summary with the full roster)
  fmmi compare <matchId> --team <teamId> [--players <id,id>]     (windows A and B: --a-from/--a-to/--a-from-minute/--a-to-minute/--a-period, same for --b-*)
  fmmi status [<matchId>]                                        (recording evidence status, or catalog health without a match)

Live (Slice 5, optional; loopback 127.0.0.1:16726 only; UNVERIFIED against a real match until you run capture and check):
  fmmi live status                                              (is the plugin reachable, is a match running)
  fmmi live capture [--out <dir>] [--socket-seconds <n>]        (run during a REAL match: saves sanitised endpoint shapes under <home>/live-capture)
  fmmi live check [<capture-file>]                              (reports the schema validation of each full response, made at capture time)
  fmmi note add --live [--save <save>] --setting <t> --prior-value <t> --new-value <t> [--boundary <period>:<tick>] [--side home|away] [--text <t>]
        (pins the change to the live snapshot boundary it read from the plugin; imported into the match's notes when the recording is imported)
  fmmi note compare ln_<id>                                     (live: before and after windows around the live note)

Season history (Slice 4). --team takes a team id, a club alias or an exact team name, and defaults to the save's managed team:
  fmmi trends [--save <save>] [--team <ref>] [--last <n>] [--home-away home|away] [--metrics a,b] [--season <label>] [--include-partial]
  fmmi review --last 5 [--save <save>] [--team <ref>]            (five-match rolling review: the exact contributing matches and pooled rates)
  fmmi players [--save <save>] [--team <ref>] [--name <text>] [--limit <n>] [--cursor <cursor>]
  fmmi player-trends [--save <save>] --players <peId,peId> [--last <n>] [--home-away home|away] [--metrics a,b]
  fmmi player link <id> <id>... [--save <save>] [--name <text>]  (join match-local ids p_... and at most one persistent id pe_...; audited, never by name)
  fmmi player unlink <p_id> [--save <save>]
  fmmi note add <matchId> --minute <m> [--period <p>] [--team <ref> | --side home|away] --setting <text> --prior-value <text> --new-value <text> [--text <comment>]
  fmmi note list [--save <save>] [--match <matchId>] [--limit <n>] [--cursor <cursor>]
  fmmi note supersede <noteId> [--minute <m>] [--period <p>] [--setting <t>] [--prior-value <t>] [--new-value <t>] [--text <t>] [--side home|away]
  fmmi note compare <noteId> [[--save <save>]] [--team <ref>] [--before <n>] [--after <n>]
  fmmi save team detect [--apply] | set --team <ref> | clear   (each with --save)
  fmmi club alias add|remove|list [--save <save>] [--team <ref>] --alias <text>
  fmmi aggregates rebuild [[--save <save>]]                      (rebuild missing or stale cached aggregates; ingest and trends do this on their own)

Analysis options: --recording-revision <id>  --scope counter_scope|open_play|all_passes (default counter_scope)
  Window [from,to): --from <period>:<tick> --to <period>:<tick>, or --from-minute <m> --to-minute <m> [--period <p>]
Global options: --json (never prompts)  --home <dir> (or FMMI_HOME)  --archive-dir <dir> (or FMMI_ARCHIVE_DIR)
Environment: FMMI_DEBUG=1 writes the stack of an unexpected (internal_error) failure to stderr; the printed error stays opaque.
Exit codes: 0 ok, 1 failed, 2 usage error.`

export const SCHEMA_VERSION = '1.0'

/** Failures whose message already says what to do; the text output omits their details (the JSON error body keeps them, unchanged). */
const FRIENDLY = new Set(['no_saves', 'save_required', 'save_ref', 'save_ambiguous', 'archive_dir_unset', 'archive_dir_missing', 'archive_dir_ambiguous', 'no_matches', 'match_ambiguous', 'match_ref', 'player_ambiguous', 'player_ref', 'setup'])

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let json = false
  try {
    const p = parseArgs(argv)
    json = has(p, 'json')
    if (has(p, 'help') || p.positionals[0] === 'help') { io.out(HELP); return 0 }
    const home = flag(p, 'home') ?? io.env.FMMI_HOME ?? defaultHomeOf(io.env)
    const emit = (data: unknown, text: string) => io.out(json ? JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, data }, null, 2) : text)
    // --json never prompts, whatever the terminal is.
    const prompt: Prompter = json ? nonInteractive : (io.prompt ?? nonInteractive)
    if (p.positionals.length === 0 || p.positionals[0] === 'home') {
      const h = await homeScreen({ home, env: io.env, archiveDir: flag(p, 'archive-dir'), livePort: io.livePort })
      emit(h.data, h.text)
      return 0
    }
    if (p.positionals[0] === 'setup') {
      const summary = await runSetup({
        home, defaultHome: defaultHomeOf(io.env), env: io.env, prompt, run: io.run ?? defaultRunner, out: json ? () => {} : io.out, steamRoots: io.steamRoots,
        yes: has(p, 'yes'), archiveDir: flag(p, 'archive-dir'), saveName: flag(p, 'save-name'), noMcp: has(p, 'no-mcp'), repoRoot: REPO_ROOT,
      })
      if (json) emit(summary, '')
      return 0
    }
    const svc = new CatalogService(loadConfig(home, io.env, { archiveDir: flag(p, 'archive-dir') }))
    try {
      const [cmd, sub] = p.positionals
      const numOpt = (n: string) => { const v = flag(p, n); if (v === undefined) return undefined; const x = Number(v); if (!Number.isFinite(x)) throw new DomainError('invalid_input', `--${n} must be a number`, { reason: 'usage' }); return x }
      const numReq = (n: string): number => { const v = numOpt(n); if (v === undefined) throw new DomainError('invalid_input', `Missing required option --${n}`, { reason: 'usage' }); return v }
      const listFlag = (n: string) => { const v = flag(p, n); return v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean) }
      const sideFlag = (n: string): 'home' | 'away' | undefined => {
        const v = flag(p, n)
        if (v === undefined) return undefined
        if (v !== 'home' && v !== 'away') throw new DomainError('invalid_input', `--${n} must be home or away`, { reason: 'usage' })
        return v
      }
      const saveOf = (): string => svc.resolveSave(flag(p, 'save')).saveId
      const matchOf = (ref: string): string => svc.resolveMatch(ref, flag(p, 'save'))
      const playerOf = (matchId: string, ref: string): string => svc.resolvePlayer(matchId, ref, { names: true, revisionId: flag(p, 'recording-revision') })
      /** --team <ref>, else the managed team of the match's save (which must have played in the match). */
      const matchTeamOf = (matchId: string): string => {
        const m = svc.store.getMatch(matchId)
        if (!m) throw new DomainError('not_found', 'Match not found', { matchId })
        const t = flag(p, 'team')
        if (t !== undefined) {
          // A reference that names no team is passed on unchanged, so the query reports the same error as before (and as the MCP tool does).
          try { return svc.resolveTeamRef(m.saveId, t).teamId } catch (e) { if (e instanceof DomainError && e.code === 'not_found') return t; throw e }
        }
        const mg = svc.getManagedTeam(m.saveId)
        if (!mg) throw new DomainError('invalid_input', 'Missing required option --team (or set your club once: fmmi save team detect --apply)', { reason: 'usage' })
        if (mg.teamId !== m.homeTeamId && mg.teamId !== m.awayTeamId) throw new DomainError('invalid_input', 'Your club did not play in this match; pass --team', { reason: 'usage' })
        return mg.teamId
      }
      /** --team <ref>, else the save's managed team. */
      const teamOf = (saveId: string): string => {
        const t = flag(p, 'team')
        if (t !== undefined) return svc.resolveTeamRef(saveId, t).teamId
        const m = svc.getManagedTeam(saveId)
        if (!m) throw new DomainError('invalid_input', 'Missing --team and the save has no managed team (try: fmmi save team detect)', { reason: 'usage' })
        return m.teamId
      }
      switch (cmd) {
        case 'doctor': {
          const d = await svc.doctor()
          emit(d, renderDoctor(d))
          return d.ok ? 0 : 1
        }
        case 'save': {
          if (sub === 'create') {
            const s = svc.createSave(p.positionals.slice(2).join(' '))
            emit(s, `Created save ${s.saveId} (${s.displayName})`)
            return 0
          }
          if (sub === 'list') { const l = svc.listSaves(); emit({ saves: l }, renderSaves(l)); return 0 }
          if (sub === 'team') {
            const saveId = saveOf()
            const act = p.positionals[2]
            if (act === 'detect') {
              const d = svc.detectManagedTeam(saveId)
              if (!has(p, 'apply')) { emit(d, renderManaged(d)); return 0 }
              const r = svc.applyDetectedManagedTeam(saveId)
              emit(r, `Managed team of ${saveId} set to ${safeText(r.name)} (${r.teamId}), source assisted (${r.evidence}). An explicit "save team set" always takes precedence.`)
              return 0
            }
            if (act === 'set') { const r = svc.setManagedTeam(saveId, need(p, 'team')); emit(r, `Managed team of ${saveId} set to ${safeText(r.name)} (${r.teamId}), source explicit.`); return 0 }
            if (act === 'clear') { const r = svc.clearManagedTeam(saveId); emit(r, r.cleared ? 'Managed team cleared.' : 'No managed team was set.'); return 0 }
            throw new DomainError('invalid_input', 'Usage: fmmi save team detect [--apply] | set --team <ref> | clear  (each with --save)', { reason: 'usage' })
          }
          throw new DomainError('invalid_input', 'Usage: fmmi save create <name> | save list | save team detect|set|clear', { reason: 'usage' })
        }
        case 'sync': {
          const saveId = saveOf()
          svc.requireArchiveDir()
          const imp = await svc.ingestNew(saveId, { includeInProgress: has(p, 'include-in-progress') })
          const lines = importLines(svc, saveId, imp.results, imp.skippedAlreadyIngested, imp.skippedInProgress)
          if (!json) for (const l of lines) io.out(l)
          const conf = await confirmFlow(svc, saveId, prompt, json ? () => {} : io.out, { all: has(p, 'all') })
          if (json) emit({ saveId, results: imp.results, skippedAlreadyIngested: imp.skippedAlreadyIngested, skippedInProgress: imp.skippedInProgress, confirmation: conf }, '')
          else if (conf.pending.length > 0) {
            io.out(`${conf.pending.length} recording(s) wait for your final score. Record it with one of these commands (add --allow-score-change if the final score differs from the observed one):`)
            for (const m of conf.pending) io.out(`  ${m.label}\n    ${m.command}`)
          } else if (lines.length === 0 && conf.confirmed.length === 0 && conf.skipped.length === 0) io.out('Everything is up to date.')
          return imp.results.some((x) => x.status === 'rejected') ? 1 : 0
        }
        case 'ingest': {
          const saveId = saveOf()
          if (has(p, 'new')) {
            const r = await svc.ingestNew(saveId)
            emit(r, renderIngest(r.results, r))
            return r.results.some((x) => x.status === 'rejected') ? 1 : 0
          }
          const results = await svc.ingestPath(pos(p, 1, 'file or directory'), saveId)
          emit({ results }, renderIngest(results))
          return results.some((x) => x.status === 'rejected') ? 1 : 0
        }
        case 'list': {
          const num = (n: string) => { const v = flag(p, n); if (v === undefined) return undefined; const x = Number(v); if (!Number.isFinite(x)) throw new DomainError('invalid_input', `--${n} must be a number`, { reason: 'usage' }); return x }
          const listSave = has(p, 'all-saves') ? undefined : saveOf()
          const listTeam = flag(p, 'team')
          const l = new MatchQueries(svc).listMatches({ saveId: listSave, teamId: listTeam === undefined || listSave === undefined ? listTeam : svc.resolveTeamRef(listSave, listTeam).teamId, season: flag(p, 'season'), limit: num('limit'), cursor: flag(p, 'cursor') })
          emit(l, renderList(l))
          return 0
        }
        case 'show': {
          const s = svc.showMatch(matchOf(pos(p, 1, 'matchId')), { revisionId: flag(p, 'revision') })
          emit(s, renderShow(s))
          return 0
        }
        case 'match': {
          if (sub === 'confirm') {
            const ref = pos(p, 2, 'matchId'), score = need(p, 'score')
            const r = svc.confirmMatch(matchOf(ref), score, { allowScoreChange: has(p, 'allow-score-change') })
            const f = r.result.final!
            emit(r, `Match ${r.matchId} confirmed as full time with manual final score ${f.home}-${f.away} (observed ${r.result.observed.home}-${r.result.observed.away}). Completion: ${r.completion.status}. Capture coverage unchanged: ${r.coverage.status}.${r.warnings.map((w) => `\nwarning: ${w}`).join('')}`)
            return 0
          }
          if (sub === 'move') {
            const r = svc.moveMatch(matchOf(pos(p, 2, 'matchId')), svc.resolveSave(need(p, 'save')).saveId)
            emit(r, `Moved match ${r.matchId} from ${r.fromSaveId} to ${r.toSaveId} (${r.revisionsMoved} revision(s)).`)
            return 0
          }
          throw new DomainError('invalid_input', 'Usage: fmmi match confirm|move ...', { reason: 'usage' })
        }
        case 'recording': {
          if (sub === 'resolve') {
            const as = need(p, 'as')
            const id = pos(p, 2, 'recordingRevisionId')
            if (as === 'continuation' || as === 'alternate') {
              const r = await svc.chooseRecording(id, as)
              emit(r, `Revision ${r.recordingRevisionId} resolved as ${r.resolution}; it is now the selected revision of match ${r.matchId} (previously ${r.previousSelectedRevisionId}).${r.warnings.map((w) => `\nwarning: ${w}`).join('')}`)
              return 0
            }
            if (as !== 'separate-occurrence' && as !== 'ignored') throw new DomainError('invalid_input', '--as must be separate-occurrence, ignored, continuation or alternate', { reason: 'usage' })
            const r = svc.resolveRecording(id, as)
            emit(r, `Revision ${r.recordingRevisionId} resolved as ${r.resolution}; match ${r.matchId}.`)
            return 0
          }
          throw new DomainError('invalid_input', 'Usage: fmmi recording resolve <recordingRevisionId> --as separate-occurrence|ignored|continuation|alternate', { reason: 'usage' })
        }
        case 'live': {
          const client = new LocalPluginClient({ port: io.livePort })
          const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
          if (sub === 'status') {
            const h = await client.getJson('/api/health', HealthSchema)
            const out = h.ok ? { reachable: true, host: client.host, health: h.data } : { reachable: false, host: client.host, failure: h.kind, detail: h.detail }
            emit(out, h.ok ? `Plugin reachable on ${client.host}: status ${h.data.status}, plugin ${h.data.pluginVersion}, in match: ${h.data.inMatch}. (health is one of the three endpoints ever observed from a real plugin)` : `Plugin not reachable on ${client.host} (${h.kind}). Football Manager is closed, the plugin is not loaded, or the endpoint changed. The offline commands do not need it.`)
            return h.ok ? 0 : 1
          }
          if (sub === 'capture') {
            const dir = resolve(flag(p, 'out') ?? join(home, 'live-capture'))
            mkdirSync(dir, { recursive: true })
            const socketSeconds = numOpt('socket-seconds') ?? 10
            const cap = await captureShapes({ client, socketMs: Math.max(0, Math.min(120, socketSeconds)) * 1000, port: io.livePort })
            const file = join(dir, `capture-${stamp()}.json`)
            writeFileSync(file, JSON.stringify(cap, null, 2), { flag: 'wx' })
            const reached = cap.endpoints.some((e) => e.ok)
            emit({ file: resolve(file), endpoints: cap.endpoints.map((e) => ({ id: e.id, basis: e.basis, ok: e.ok, failure: e.failure, bytes: e.bytes })), websocket: { attempted: cap.websocket.attempted, opened: cap.websocket.opened, messages: cap.websocket.messages.map((m) => m.type) } }, renderLiveCapture(cap, resolve(file)))
            return reached ? 0 : 1
          }
          if (sub === 'check') {
            const dir = join(home, 'live-capture')
            let file = p.positionals[2]
            if (!file) {
              let names: string[] = []
              try { names = readdirSync(dir).filter((n) => /^capture-.*\.json$/.test(n)).sort() } catch { /* no directory yet */ }
              if (names.length === 0) throw new DomainError('not_found', 'No capture file found; run `fmmi live capture` during a real match first', { reason: 'no_capture' })
              file = join(dir, names[names.length - 1]!)
            }
            let cap: Capture
            try { cap = JSON.parse(readFileSync(file, 'utf8')) as Capture } catch { throw new DomainError('invalid_input', 'The capture file cannot be read as JSON', { reason: 'capture_file' }) }
            if (!cap || typeof cap.captureVersion !== 'number' || !Array.isArray(cap.endpoints) || !cap.websocket) throw new DomainError('invalid_input', 'Not an fmmi live capture file', { reason: 'capture_file' })
            const rep = checkCapture(cap)
            emit(rep, renderLiveCheck(rep))
            return rep.ok ? 0 : 1
          }
          throw new DomainError('invalid_input', 'Usage: fmmi live status | capture | check', { reason: 'usage' })
        }
        case 'club': {
          const saveId = saveOf()
          if (sub === 'alias') {
            const act = p.positionals[2]
            if (act === 'add') { const r = svc.addClubAlias(saveId, need(p, 'team'), need(p, 'alias')); emit(r, `${r.created ? 'Added' : 'Already present:'} alias ${safeText(r.alias)} -> ${r.teamId}`); return 0 }
            if (act === 'remove') { const r = svc.removeClubAlias(saveId, need(p, 'alias')); emit(r, `Removed alias ${safeText(r.alias)} (${r.teamId})`); return 0 }
            if (act === 'list') { const l = svc.listClubAliases(saveId); emit({ aliases: l }, l.length ? l.map((a) => `${safeText(a.alias)} -> ${safeText(a.teamName)} (${a.teamId})`).join('\n') : 'No club aliases.'); return 0 }
          }
          throw new DomainError('invalid_input', 'Usage: fmmi club alias add|remove|list --save <saveId> [--team <ref>] --alias <text>', { reason: 'usage' })
        }
        case 'aggregates': {
          if (sub !== 'rebuild') throw new DomainError('invalid_input', 'Usage: fmmi aggregates rebuild [--save <saveId>]', { reason: 'usage' })
          const r = await svc.rebuildAggregates(flag(p, 'save'))
          emit(r, `Aggregates (${r.key}): ${r.revisions} selected revision(s), ${r.rebuilt} rebuilt, ${r.alreadyCurrent} already current.`)
          return 0
        }
        case 'trends': case 'review': {
          const saveId = saveOf()
          const r = await new MatchQueries(svc).seasonTrends({
            saveId, teamId: teamOf(saveId), lastN: cmd === 'review' ? (numOpt('last') ?? 5) : numOpt('last'), homeAway: sideFlag('home-away'), metrics: listFlag('metrics'),
            season: flag(p, 'season'), includePartial: has(p, 'include-partial'),
          })
          emit(r, renderTrends(r, { review: cmd === 'review' }))
          return 0
        }
        case 'players': {
          const saveId = saveOf()
          const t = flag(p, 'team')
          const r = new MatchQueries(svc).listPlayers({ saveId, teamId: t === undefined ? undefined : svc.resolveTeamRef(saveId, t).teamId, nameQuery: flag(p, 'name'), limit: numOpt('limit'), cursor: flag(p, 'cursor') })
          emit(r, renderPlayers(r))
          return 0
        }
        case 'player-trends': {
          const saveId = saveOf()
          const ids = listFlag('players')
          if (!ids || ids.length === 0) throw new DomainError('invalid_input', 'Missing required option --players', { reason: 'usage' })
          const r = await new MatchQueries(svc).playerTrends({ saveId, playerIds: ids, lastN: numOpt('last'), homeAway: sideFlag('home-away'), metrics: listFlag('metrics') })
          emit(r, renderPlayerTrends(r))
          return 0
        }
        case 'note': {
          const q = new MatchQueries(svc)
          if (sub === 'add' && has(p, 'live')) {
            // Live annotation: the change is pinned to the live snapshot boundary read from the plugin, never to a typed minute.
            const saveId = saveOf()
            const client = new LocalPluginClient({ port: io.livePort })
            const reader = new LiveReader({ client, useWebSocket: false, minSyncIntervalMs: 0 })
            try {
              const view = await reader.refresh({ force: true })
              if ((view.state !== 'fresh' && view.state !== 'held') || !reader.tracked) {
                throw new DomainError(view.state === 'not_in_match' ? 'not_found' : 'stale_snapshot', `No fresh or held live snapshot (${view.state}${view.reason ? `: ${view.reason}` : ''}); a live note needs the plugin and a running match`, { state: view.state, reason: view.reason }, true)
              }
              const track = reader.tracked
              const bflag = flag(p, 'boundary')
              const b = parseBoundary(bflag ?? `${track.snapshotStamp!.period}:${track.snapshotStamp!.tick}`)
              const boundary = liveBoundary(track, bflag === undefined ? undefined : { period: b.period, tick: b.tick })
              const rec = track.decoded()!.recording
              const side = sideFlag('side') ?? rec.humanControlledSide
              if (!side) throw new DomainError('ambiguous_selection', 'The live match does not say which side is human-managed; pass --side home|away', { reason: 'side_required' })
              const row = svc.addLiveNote(saveId, {
                upstreamMatchId: track.matchId, side, period: boundary.period, tick: boundary.tick, displayMinute: boundary.displayMinute, snapshotTick: boundary.snapshotTick, boundarySource: boundary.source,
                setting: need(p, 'setting'), priorValue: need(p, 'prior-value'), newValue: need(p, 'new-value'), comment: flag(p, 'text'),
              })
              emit({ ...row, snapshotLabel: snapshotLabel({ displayMinute: boundary.displayMinute, period: boundary.period, tick: boundary.tick }), label: 'manual', adoptedWhenImported: true },
                `Recorded live note ${row.noteId} (manual, user-entered) at live snapshot boundary ${row.period}:${row.tick} (${snapshotLabel({ displayMinute: boundary.displayMinute, period: boundary.period, tick: boundary.tick })}; boundary ${boundary.source === 'explicit' ? 'named by you' : 'is the snapshot end'}): ${safeText(row.setting)}: ${safeText(row.priorValue)} -> ${safeText(row.newValue)}. FMMatchLens did not record this change. It becomes a regular tactical note of the match when the finished recording is imported into this save.`)
              return 0
            } finally { reader.close() }
          }
          if (sub === 'add') {
            const matchId = matchOf(pos(p, 2, 'matchId'))
            const t = flag(p, 'team')
            let side = sideFlag('side')
            if (t !== undefined) {
              const m = svc.store.getMatch(matchId)
              if (!m) throw new DomainError('not_found', 'Match not found', { matchId })
              const team = svc.resolveTeamRef(m.saveId, t)
              if (team.teamId !== m.homeTeamId && team.teamId !== m.awayTeamId) throw new DomainError('invalid_input', 'That team did not play in this match', { reason: 'team_not_in_match' })
              side = team.teamId === m.homeTeamId ? 'home' : 'away'
            }
            const row = await svc.addNote(matchId, { minute: numReq('minute'), period: numOpt('period'), side, setting: need(p, 'setting'), priorValue: need(p, 'prior-value'), newValue: need(p, 'new-value'), comment: flag(p, 'text') })
            const v = q.history.viewNote(row)
            emit(v, `Recorded note ${v.noteId} (manual, user-entered) for match ${v.matchId}: minute ${v.minute} (period ${v.period}), ${safeText(v.setting)}: ${safeText(v.priorValue)} -> ${safeText(v.newValue)}. FMMatchLens did not record this change.`)
            return 0
          }
          if (sub === 'supersede') {
            const row = await svc.supersedeNote(pos(p, 2, 'noteId'), {
              minute: numOpt('minute'), period: numOpt('period'), side: sideFlag('side'), setting: flag(p, 'setting'), priorValue: flag(p, 'prior-value'), newValue: flag(p, 'new-value'), comment: flag(p, 'text'),
            })
            const v = q.history.viewNote(row)
            emit(v, `Note ${v.noteId} supersedes ${v.supersedes}: minute ${v.minute}, ${safeText(v.setting)}: ${safeText(v.priorValue)} -> ${safeText(v.newValue)}. The earlier note is kept in the audit trail.`)
            return 0
          }
          if (sub === 'list') {
            const r = q.tacticalNotes({ saveId: saveOf(), matchId: flag(p, 'match') === undefined ? undefined : /^m_/.test(flag(p, 'match')!) ? flag(p, 'match') : matchOf(flag(p, 'match')!), limit: numOpt('limit'), cursor: flag(p, 'cursor') })
            emit(r, renderNotes(r))
            return 0
          }
          if (sub === 'compare' && (p.positionals[2] ?? '').startsWith('ln_')) {
            const ln = svc.getLiveNote(pos(p, 2, 'noteId'))
            if (!ln) throw new DomainError('not_found', 'Live note not found', { reason: 'live_note' })
            const client = new LocalPluginClient({ port: io.livePort })
            const reader = new LiveReader({ client, useWebSocket: false, minSyncIntervalMs: 0 })
            try {
              const r = await liveNoteCompare(reader, { noteId: ln.noteId, side: ln.side, period: ln.period, tick: ln.tick, displayMinute: ln.displayMinute, upstreamMatchId: ln.upstreamMatchId })
              emit({ ...r, adoption: ln.adoption }, renderLiveNoteCompare(r, ln.adoption))
              return 0
            } finally { reader.close() }
          }
          if (sub === 'compare') {
            const noteId = pos(p, 2, 'noteId')
            const note = svc.store.getNote(noteId)
            const nm = note ? svc.store.getMatch(note.matchId) : null
            if (!note || !nm) throw new DomainError('not_found', 'Tactical note not found', { noteId })
            const saveId = flag(p, 'save') ?? nm.saveId
            const t = flag(p, 'team')
            const teamId = t !== undefined ? svc.resolveTeamRef(saveId, t).teamId : (note.side === 'home' ? nm.homeTeamId : nm.awayTeamId)
            const r = await q.compareTacticalChange({ saveId, teamId, noteId, matchesBefore: numOpt('before'), matchesAfter: numOpt('after') })
            emit(r, renderTacticalChange(r))
            return 0
          }
          throw new DomainError('invalid_input', 'Usage: fmmi note add|list|supersede|compare ...', { reason: 'usage' })
        }
        case 'report': case 'player': case 'network': case 'service': case 'summary': case 'compare': case 'status': case 'threat': {
          if (cmd === 'player' && (sub === 'link' || sub === 'unlink')) {
            const saveId = saveOf()
            if (sub === 'link') {
              const r = svc.linkPlayers(saveId, p.positionals.slice(2), { name: flag(p, 'name') })
              emit(r, renderPlayerLink(r))
              return 0
            }
            const r = svc.unlinkPlayer(saveId, pos(p, 2, 'match-local playerId'))
            emit(r, `Unlinked ${r.localPlayerId} from ${r.fromPlayerId} (${r.previousSource === 'uid' ? 'automatic uid identity; it will not be re-merged' : 'manual link'})${r.entityRemoved ? '; the player no longer has two matches and was removed' : ''}.`)
            return 0
          }
          const q = new MatchQueries(svc)
          const optMatch = cmd === 'status' && p.positionals[1] !== undefined ? matchOf(p.positionals[1]) : undefined
          if (cmd === 'status') { const r = await q.recordingStatus(optMatch, { recordingRevisionId: flag(p, 'recording-revision') }); emit(r, renderStatus(r)); return 0 }
          const matchId = matchOf(cmd === 'report' && p.positionals[1] === undefined ? 'latest' : pos(p, 1, 'matchId'))
          const num = (n: string) => { const v = flag(p, n); if (v === undefined) return undefined; const x = Number(v); if (!Number.isFinite(x)) throw new DomainError('invalid_input', `--${n} must be a number`, { reason: 'usage' }); return x }
          const common: CommonOptions = {
            recordingRevisionId: flag(p, 'recording-revision'), scope: parseScope(flag(p, 'scope')),
            window: { from: flag(p, 'from'), to: flag(p, 'to'), fromMinute: num('from-minute'), toMinute: num('to-minute'), period: num('period') },
          }
          if (cmd === 'summary') { const r = await q.summary(matchId, { recordingRevisionId: flag(p, 'recording-revision'), teamId: flag(p, 'team') === undefined ? undefined : matchTeamOf(matchId) }); emit(r, renderSummary(r)); return 0 }
          if (cmd === 'compare') {
            const win = (k: 'a' | 'b') => ({ from: flag(p, `${k}-from`), to: flag(p, `${k}-to`), fromMinute: num(`${k}-from-minute`), toMinute: num(`${k}-to-minute`), period: num(`${k}-period`) })
            const players = flag(p, 'players')
            const r = await q.compare(matchId, matchTeamOf(matchId), {
              recordingRevisionId: flag(p, 'recording-revision'), scope: parseScope(flag(p, 'scope')), windowA: win('a'), windowB: win('b'),
              playerIds: players === undefined ? undefined : players.split(',').map((x) => x.trim()).filter(Boolean).map((x) => playerOf(matchId, x)),
            })
            emit(r, renderCompare(r)); return 0
          }
          const format = flag(p, 'format') ?? 'text'
          if (format !== 'text' && format !== 'markdown') throw new DomainError('invalid_input', '--format must be text or markdown', { reason: 'usage' })
          const md = format === 'markdown'
          if (cmd === 'report') { const r = await q.report(matchId, common); emit(r, renderReport(r, { markdown: md })); return 0 }
          if (cmd === 'threat') { const r = await q.threat(matchId, matchTeamOf(matchId), common); emit(r, renderThreat(r, { markdown: md })); return 0 }
          if (cmd === 'player') { const r = await q.player(matchId, playerOf(matchId, pos(p, 2, 'playerId')), common); emit(r, renderPlayer(r, { markdown: md })); return 0 }
          if (cmd === 'network') {
            const r = await q.network(matchId, matchTeamOf(matchId), { ...common, minPasses: num('min-passes'), limit: num('limit') })
            emit(r, renderNetwork(r, { markdown: md })); return 0
          }
          const cmp = flag(p, 'compare')
          const r = await q.service(matchId, playerOf(matchId, pos(p, 2, 'playerId')), { ...common, comparePlayerId: cmp === undefined ? undefined : playerOf(matchId, cmp) })
          emit(r, renderService(r, { markdown: md })); return 0
        }
        default:
          throw new DomainError('invalid_input', `Unknown command ${JSON.stringify(cmd)}`, { reason: 'usage' })
      }
    } finally {
      svc.close()
    }
  } catch (e) {
    const body = toErrorBody(e)
    debugReport(e, io.env, io.err)
    if (json) io.out(JSON.stringify({ ok: false, schemaVersion: SCHEMA_VERSION, error: body }, null, 2))
    else io.err(`error ${body.code}: ${body.message}${Object.keys(body.details).length && !FRIENDLY.has(String(body.details.reason)) ? ` ${JSON.stringify(body.details)}` : ''}`)
    return body.code === 'invalid_input' && body.details.reason === 'usage' ? 2 : 1
  } finally {
    io.prompt?.close?.()
  }
}
