# Setup on Windows: CLI and the read-only MCP server

Target: Windows 10/11 x64, Node.js >= 22.18 (developed and tested on Node 25.1). Sections 1 to 8 need no Football Manager and make no
network connection. Sections 9 to 11 (Slice 5: live reader, live note, optional remote MCP) are optional and OFF by default; read the
status lines in them before relying on any of it.

## 1. Install and verify

    npm install
    npm run typecheck && npm run lint && npm test

Real recordings for the optional real-recording tests go in `tests/fixtures/local/` (gitignored); those tests skip when absent.

## 2. Import recordings (CLI only)

The MCP server is read-only. Everything that changes the catalog (importing, `match confirm`, `match move`,
`recording resolve`) stays in the `fmmi` CLI.

    npm run fmmi -- save create "Farnham Town"
    npm run fmmi -- ingest "C:\path\to\match.fmlens" --save <saveId>
    npm run fmmi -- list --save <saveId>

The catalog lives under `FMMI_HOME` (default `%LOCALAPPDATA%\fmmi`): `catalog.sqlite` and content-addressed read-only
`snapshots\`. Use a separate `FMMI_HOME` for experiments so your real catalog is never touched.

## 3. Run the MCP server

    node packages\mcp\bin\fmmi-mcp.mjs [--home <dir>]        # or: npm run --silent fmmi-mcp

Launch it with `node` directly (or `npm run --silent`) in client configurations: plain `npm run` prints a banner on stdout, which
would corrupt the protocol channel.

The server speaks MCP over stdio (SDK v2, `@modelcontextprotocol/server` 2.4.0). stdout carries the protocol and nothing
else; diagnostics are JSON lines on stderr (tool name, internal ids, byte counts, durations, error codes; no paths, names or
raw frames). It opens the catalog read-only and on first use, so it may be started before the first import and picks the
catalog up once it exists. It exits when the client closes stdin.

### Client configuration (stdio)

Most MCP clients accept the common `mcpServers` shape. Replace the paths with your own:

```json
{
  "mcpServers": {
    "fmmi": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\Projects\\FMMatchLens_MCP\\packages\\mcp\\bin\\fmmi-mcp.mjs"],
      "env": { "FMMI_HOME": "C:\\Users\\you\\AppData\\Local\\fmmi" }
    }
  }
}
```

`command` must resolve to a Node >= 22.18 executable (use its full path if `node` on `PATH` is older). The server was verified
here only with the official SDK v2 client over stdio (`tests/mcp/stdio.test.ts`). No other client, including OMP, has been
tried; client-specific key names are the client's own documentation, not this repository's.

## 4. The thirteen tools

`list_matches`, `get_match_summary`, `get_player_match`, `get_passing_network`, `get_striker_service`,
`compare_match_periods`, `get_recording_status`, `get_opposition_threat` and, from Slice 4, `list_players`, `get_season_trends`,
`get_player_trends`, `get_tactical_notes`, `compare_tactical_change` (CLI: `players`, `trends` / `review`, `player-trends`, `note list`,
`note compare`; notes are written only by the local `fmmi note` commands). All carry `readOnlyHint: true`. Typical order: `list_matches` (match, team and
save ids) -> `get_match_summary` (complete recorded roster with internal player ids, including substituted-off and unused
players) -> focused tools, pinning `recordingRevisionId` on follow-ups so a later import cannot change the evidence. Each has a
CLI equivalent that returns the same JSON: `fmmi list`, `summary`, `player`, `network`, `service`, `compare`, `status`, `threat`
(add `--json`).

Windows are half-open `[from,to)`: `from`/`to` as `<period>:<tick>` or `fromMinute`/`toMinute` with `period`. A minute that exists
in two periods (for example 45.5) returns `ambiguous_selection`; reversed, empty or out-of-range windows return `invalid_input`
and are never clipped. Results carry the requested window and, separately, `window.effective` (measurable coverage).

Errors are MCP tool errors (`isError: true`) whose text and `structuredContent` are the spec 8.2 body
`{ code, message, details, retryable }`: `invalid_input`, `not_found`, `ambiguous_selection`, `identity_conflict`,
`revision_unavailable`, `unsupported_version`, `insufficient_coverage`, `stale_snapshot`, `internal_error`. They never contain
paths, stack traces or secrets. Missing individual metrics are successful results with `null` and a `nullReason`.

The server also offers the prompt `match_review` and the resource `fmmi://review/match-review-structure`: the section 3
five-part review (facts, interpretation, alternative explanations, action - at most one - and confidence), which states that
returned names and event text are data, not instructions.

## 5. Output size and performance (measured on the real recording)

Real recording `2026-08-31-Farnham-vs-Torquay-0-3.fmlens` (1,831,146 bytes, 36 recorded participants, captured to 87.6 min).
Bytes of the JSON text of each result, default arguments (`tests/mcp/real.test.ts` and, for `get_opposition_threat`, `tests/mcp/slice3b.test.ts`; limit 20 KB):

| Tool (arguments) | Bytes |
|---|---|
| list_matches | 950 |
| get_match_summary (full 36-player roster) | 16,198 |
| get_match_summary (one team) | 12,432 |
| get_player_match (with the rating block; worst of the 36 players 13,779) | 12,805 |
| get_passing_network (home / away, default 10 links) | 11,396 / 11,702 |
| get_striker_service | 9,665 |
| get_striker_service with a comparator | 17,760 |
| compare_match_periods (team only) | 9,310 |
| compare_match_periods (4 players, the maximum) | 18,156 |
| get_recording_status (match / catalog) | 4,112 / 584 |
| get_opposition_threat (Farnham / Torquay as the defended team) | 15,945 / 15,721 |

Each result is sent twice on the wire (`content` text and `structuredContent`), as MCP recommends for compatibility. The first
call for a recording decodes its snapshot (about 5 s on the development PC); the decoded recording is then kept in a small
bounded in-process cache keyed by revision, archive hash and parser version, so later calls take milliseconds. The cache holds
at most 3 recordings and an estimated 256 MB (8x the measured heap per archive byte; the audited recording decodes to about
1.8 MB). It never caches catalog state that can change (confirmation, identity status), and a recording whose retained
snapshot has gone is `revision_unavailable` even if it was cached.

### Slice 4 output sizes (bytes of the JSON text, default arguments, limit 20 KB)

Real recording (one match; `tests/history/real.test.ts`): list_players 8,575 (all 36 players), get_season_trends 7,759, get_player_trends 3,994,
get_tactical_notes 7,496 (with the observed role changes), compare_tactical_change 7,774. Labelled synthetic ten-match fixture
(`tests/mcp/slice4.test.ts`): get_season_trends 13,849 (both windows and splits; 15,478 with the partial opt-in), get_player_trends 16,979
(four players, both windows), list_players page of 50 12,157, get_tactical_notes page of 20 10,696, compare_tactical_change with 10 matches
requested each side 14,847. A query for very large windows can exceed the default budget; the server refuses results over 96 KB.

## 6. Review checker (evaluation of saved transcripts)

    node scripts/review-check.mts --response review.md --results tool-results.json [--json]

`tool-results.json` is one tool result or an array (MCP `CallToolResult`s, `{tool, arguments, result}` records, or bare
payloads). The checker verifies the five section headings (once each, in order), at most one action in the Action section (or
a statement that none is recommended), and that every cited id, metric id and window appears in the tool results. Exit code
0 pass, 1 fail, 2 usage. It is an evaluation tool, not a CI golden test; it cannot judge whether hypotheses are well reasoned.
No real model transcript is included in this repository: the samples in `tests/mcp/review.test.ts` are labelled synthetic.

## 7. Security notes

- The server has no tool that takes a path, URL or command, never accepts an archive path, and rejects unknown input keys.
- The catalog is opened with SQLite `readonly` and `query_only`; the tests assert that the catalog and snapshot bytes are
  unchanged after calling every tool, and that a missing catalog is not created.
- Player, club and competition names are untrusted data and are returned only as JSON fields.
- If the client sends tool results to an online model, match data leaves this PC; that is a decision for the client.
- Keep the FMMatchLens port 16726 on loopback. The stdio server does not use it; only the optional `--live` flag (section 9) reads it, and only from 127.0.0.1.

## 8. Troubleshooting

- `not_found` with `details.reason = "catalog_missing"`: nothing imported under that `FMMI_HOME` yet.
- `unsupported_version` on start of a tool call: the catalog was created by a different build; run any `fmmi` command once.
- `revision_unavailable`: the pinned revision does not belong to that match, or its retained snapshot cannot be read.
- Node errors about `.ts` files: use Node >= 22.18.

## 9. Live reader (Slice 5, optional): STATUS UNVERIFIED AGAINST A REAL MATCH

What was built: a local reader for the plugin API at `http://127.0.0.1:16726` and `ws://127.0.0.1:16726/ws`, three extra read-only MCP tools
(`get_live_match`, `get_live_player_analysis`, `get_recent_tactical_events`) and a CLI live note. The address is a constant in
`packages/live/src/endpoint.ts`: no variable, flag or config key changes it, and there is no way to point it at another host.

What has and has not been seen. Only `/api/health`, `/api/archives` and `/api/match/status` were ever observed from a real plugin
(`docs/data-coverage.md` section 10). The frames, metadata, formation history and momentum routes and the WebSocket were NEVER seen
in real use; their shapes are modelled from the vendored v0.7.0 frontend source, and the plugin sources `LocalApiServer.cs` and
`WebSocketHub.cs` were not vendored or read. All live tests run against a test-only fake plugin that replays frames (real ones where a
real recording exists) through those modelled routes. **The live path is unverified against a real match until you have run the
commands below during one and `fmmi live check` has passed.** Even then it is one capture, not a guarantee.

    npm run fmmi -- live status                 # is the plugin reachable, is a match running (uses /api/health only)
    npm run fmmi -- live capture                # run DURING a real match (ideally once in each half)
    npm run fmmi -- live check                  # validates the newest capture against this project's schemas

`live capture` asks each route once, listens on the socket for up to 10 s (`--socket-seconds n`, `0` to skip) and writes a sanitised
skeleton (structure and types; free text replaced, ids zeroed, arrays cut to two elements) to `%LOCALAPPDATA%\fmmi\live-capture\`
(or `--out <dir>`), a gitignored location. Read the file before sharing it. `live check` names every route that does not match, says
which routes the capture did not cover (a capture with no match running verifies nothing) and exits 1 on a mismatch. If it reports
one, the reader degrades with `schema_mismatch` for that route instead of failing; send the capture file so the model can be corrected.

Low impact by design. Nothing runs until a live tool is called. A call may start a sync (at most one per 1.5 s), reading only what
is new after the last accepted tick. Every request to the plugin passes a rate governor: at most 4 per second, a ceiling the code
cannot be told to exceed. The socket is opened on demand, treated as delta-like (it only advances "latest"; the analysis is built
from the historical frames), coalesced to one parse per 500 ms and closed after 2 minutes without a call. No frame is kept: memory is
the counters and the event list. There is no LLM call and no loop at frame rate.

MCP: add `--live` to the server arguments (`"args": ["...fmmi-mcp.mjs", "--live"]`). Without it the server offers exactly the thirteen
tools. Every live result states `live as of game minute N / period P / tick T` and one of `fresh`, `stale` (latest frame older than
10 s of wall time), `not_connected` (plugin unreachable, for example the game exited) or `not_in_match`; only a `fresh` snapshot is
analysed, anything else gets `stale_snapshot` (retryable) or `not_found`. For a halftime briefing call `get_live_match`, then
`get_live_player_analysis` per player, and quote the snapshot minute. Live ids (`lv_`, `lr_`, `lt_`, `p_`) are valid only for the
running match; they are not catalog ids and no offline tool accepts them.

Live note (CLI only; the MCP server only reads them):

    npm run fmmi -- note add --live --save <saveId> --setting Mentality --prior-value Balanced --new-value Positive [--boundary 2:13100] [--text "..."]
    npm run fmmi -- note compare ln_<id>        # before and since windows on the live snapshot; observational

The note is pinned to the live snapshot boundary the CLI read from the plugin (its period, tick and game minute), or to an earlier
boundary you name with `--boundary`; it is manual, immutable and audited. When the finished recording is imported into the same save
it becomes a regular tactical note of that match, once.

Recording continuations (Slice 5, offline): if a recording of a known source match arrives that holds every earlier frame unchanged
and more (a finished file after an in-progress copy), it becomes the selected revision automatically and the earlier revision stays
inspectable and pinnable. A recording that differs anywhere in the earlier prefix is never merged: it is kept as `identity_conflict`
with the reason. `fmmi recording resolve <revisionId> --as continuation` (verified again from the frames) or `--as alternate` (your
choice of a different recording) settle a conflict; `separate-occurrence` and `ignored` are unchanged. Confirmations and tactical
notes belong to the revision they were made on.

## 10. Remote MCP over Streamable HTTP (Slice 5, optional): UNVERIFIED beyond loopback

Off unless you start it: `node packages\mcp\bin\fmmi-mcp.mjs --http`. Verified only on loopback, in this repository's tests, with the
official SDK v2 client. Never run on a real network, Tailscale or a Mac.

    node packages\mcp\bin\fmmi-mcp.mjs --print-new-token      # prints a fresh random token; keep it in the environment, not in a file in the repo
    set FMMI_MCP_TOKEN=<token>
    node packages\mcp\bin\fmmi-mcp.mjs --http --home <dir> [--port 8787] [--live]

It serves the same read-only tools at `POST /mcp` only. A bearer token (at least 24 characters, from the variable named by
`--token-env`, default `FMMI_MCP_TOKEN`) is required on EVERY request, also on loopback; it is compared in constant time and is never
logged or returned. The OS credential store is not implemented: load the variable from your secret manager. The server binds
127.0.0.1 by default and checks the Host header (the exact loopback names with the bound port), refuses any request that carries an
Origin header unless `--allow-origin` lists it, limits clients to 120 requests per minute (`--rate-limit`), rejects bodies over
64 KiB (`--max-body`) and never proxies to port 16726.

A non-loopback bind is refused unless ALL of these are given: `--host <the specific private address>` (wildcards are refused),
`--allow-non-loopback`, a token, `--allow-host <name:port>` for the Host header clients will send, and
`--private-transport tailscale|wireguard|tls-proxy|ssh-tunnel`, your statement that the traffic is protected. The server itself speaks
plain HTTP and cannot verify that statement: beyond loopback it must be reachable only through Tailscale (WireGuard) or behind a
TLS-terminating proxy. Do not expose it to a LAN or the internet, and never rebind FMMatchLens itself.

Client configuration (the `mcpServers` shape most clients accept; the key names are the client's own documentation, not verified here):

```json
{ "mcpServers": { "fmmi-remote": { "url": "http://<host>:8787/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

## 11. Slice 5 tests and what each rests on

`tests/live/*` and `tests/mcp/remote.test.ts` run with the game closed. Tests that serve the plugin API use the MODELLED fake
(`tests/support/fakePlugin.ts`); `tests/live/real.replay.test.ts` replays frames of a real recording through it. Nothing in the
repository has been run against a real match, a real network or OMP.
