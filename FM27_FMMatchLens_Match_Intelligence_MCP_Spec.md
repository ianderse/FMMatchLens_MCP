# Football Manager Match Intelligence
## FMMatchLens integration, longitudinal analytics, and a read-only MCP assistant

**Specification:** v1.2  
**Prepared:** 2026-10-30  
**Revised:** 2026-10-30 — v1.1 clarified identity, time, coverage, metric definitions, and milestone dependencies; v1.2 closed tool coverage gaps, added completion and identity fallbacks, changed reception findings to exposure-based gates, deferred recording continuations to Slice 5, and recorded upstream code observations.  
**Initial target:** Football Manager 27, Steam on Windows 10/11 x64, FMMatchLens v0.7.0  
**Initial save:** Farnham Town, English National League South / in-game Enterprise South  
**Preferred AI client:** Oh My Pi (OMP) with a local model, optionally hosted on a separate Mac Studio  
**Delivery approach:** vertical slices with tests and runnable demonstrations, not a one-shot rewrite

---

## 1. Executive decision

**Build a small, local-first match-analysis service and expose it through MCP.** Do **not** make the MCP server itself the place where parsing, calculations, and match histories live. The underlying analysis service must remain useful through a CLI or tests without any LLM connection.

The core loop:

1. FMMatchLens records a Football Manager match on the Windows PC.
2. An importer loads its `.fmlens` archive and creates a normalized, evidence-backed match record.
3. Deterministic analysis modules calculate player, team, time-window, and season metrics.
4. A read-only MCP server provides focused, bounded queries to an AI assistant.
5. The assistant explains observations, proposes hypotheses, and suggests *at most one testable change at a time*, withholding advice when evidence is inadequate.
6. The user makes any changes in Football Manager; the system compares later results without claiming causal certainty.

**MVP definition:** We can finish a recorded game, close Football Manager, ask about a striker's service, and receive an accurate answer referencing data from that recording. Recipient-dependent diagnostics are conditional on verified event coverage (§7.2); otherwise return the available passing, aerial and shooting evidence and explain what cannot be established. The screenshot-only Horsham match is an illustrative question, not required MVP input. The MVP must not need dozens of screenshots or generate invented events.

### Product values

- **Evidence over vibes:** distinguish recorded facts, derived statistics, contextual hypotheses, and recommendations.
- **Never fabricate:** unknown / unrecorded information remains explicitly unavailable, not zero.
- **Football first:** insights should help with tactical decisions in a real save, not just expose raw game telemetry.
- **Local and safe:** no cloud upload by default, no game modification by our service, no in-game automation.
- **Modular:** CLI and MCP are adapters to the same analysis modules; Mac Studio and Windows clients are optional deployment choices.
- **Small slices:** every development slice must run, test, and deliver measurable value before the next begins.

## 2. Current upstream integration facts (verified 2026-10-30)

This plan is pinned initially to [FMMatchLens v0.7.0](https://github.com/osnsyc/FMMatchLens/releases/tag/v0.7.0), whose release notes announce **FM27 support for the Steam version only** and do not name an operating system; Windows is this project's target and is verified in Slice 0. The same notes say testing of rare events, extra time, substitutions and match-lifecycle combinations is incomplete, so Slice 0 must exercise those scenarios. The repository's root README still contains FM26-specific setup text; **release notes take precedence for FM27 installation**. Compatibility with later FM27 builds, other storefronts, or untested match scenarios must be re-verified.

FMMatchLens has an MIT license; reusing portions of its code requires retaining the license and copyright notice. Reuse or adapt its existing TypeScript decoder and derivation logic rather than inventing another proprietary-file reader. Do not copy large amounts of upstream code without tracking provenance and ongoing compatibility.

### 2.1 Actual local endpoints

The FMMatchLens plugin starts an HTTP listener at **`http://127.0.0.1:16726/`** and WebSocket at **`ws://127.0.0.1:16726/ws`**. The upstream server presently exposes:

| Endpoint | Purpose | MVP use |
|---|---|---|
| `GET /api/health` | Plugin/game/version/status information | Preflight & compatibility |
| `GET /api/archives?page=N&pageSize=N` | Recorded match index | Discovery and archive cross-check |
| `GET /api/archives/{matchId}/frames?fromTick=&toTick=&stride=&limit=` | Paged recorded frames and metadata | Online source / validation |
| `GET /api/match/current` | Latest live frame | Live phase |
| `GET /api/match/meta` | Match, team, player metadata | Live phase |
| `GET /api/match/status` | Capture status | Live phase |
| `GET /api/match/frames?fromTick=&toTick=&stride=&limit=` | Historical frames of current match | Live reconciliation |
| `GET /api/match/formation/history?fromIndex=&limit=` | Time-stamped player/role changes | Tactical-change support |
| `GET /api/match/momentum/events` | Momentum/event snapshot | Live phase |
| `GET /api/match/momentum/updates?after=&limit=` | Incremental event updates | Live phase |
| `WS /ws` | Envelopes including `realtime_tick` and `formation_changed` | Optional low-latency phase |

These are source-code-verified API paths, **not** an independently versioned public contract. An adapter must validate responses and fail gracefully if a later release changes them. The WebSocket can send delta-like live representations; on connection/reconnection use authoritative metadata and historical-frame APIs to synchronize instead of assuming every event is a complete, self-contained lifetime snapshot.

Relevant implementation: [LocalApiServer.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/LocalApiServer.cs), [WebSocketHub.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/WebSocketHub.cs), [realtimeMatch.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/realtimeMatch.ts).

### 2.2 Archive source

- Default recording location is under the FM27 game root: `BepInEx/plugins/FMMatchLens/data/matches/`. Back this directory up before upgrading the plugin or reinstalling the game; recordings not yet ingested have no other copy.
- Files have extension `.fmlens`. The v0.7.0 format is **2.8**, with parser support for archive structures 2.1–2.8; older recordings may lack newer fields. This project has no older archives, so it initially supports 2.8 only; add an older or newer format when a real archive needs it.
- Records may be incomplete if the game exits unexpectedly; completed chunks can remain recoverable.
- Archive parsing is **already implemented** in `frontend/src/api/archiveParser.ts`, with rating and movement derivations in other frontend modules.
- The existing frontend decoder uses `DecompressionStream("deflate")`, `Blob` and `TextDecoder`, which Node 22+ also provides globally, so first try it with minimal changes, then verify zlib-wrapped Deflate, CRC, size limits, metadata changes and recoverable partial archives with golden fixtures. Do not assume copying the file into a Node package will work without dependency and runtime adapters.
- Archives only contain matches recorded while the plugin was active. **Do not claim to reconstruct earlier Farnham matches** from FM27's built-in historical menus.

Relevant implementation: [archiveParser.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/archiveParser.ts), [ArchiveFormat.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/ArchiveFormat.cs), [replayDerivations.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/replay/replayDerivations.ts), [passMap.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/passMap.ts).

### 2.3 Available and unavailable data

**Supported or expected in recorded frames (verify by fixture):** match identity, side/home-away, scores, xG, shot counts, passing and progressive passing, possession information, substitutions/participation, player statistics including aerial duels, movement/coordinates, player roles and formation history, tactical events and annotations, momentum, heatmaps/pass networks derived from tracked events, and estimated rating contributions.

**Not guaranteed:** complete user-selected team instructions (e.g., precise `Pass Into Space` setting), every tactical tweak, referee reasoning, exhaustive ball trajectories, hidden game AI intentions, every coaching/medical metric, transfer negotiations, player contracts, scouting budget, and pre-install match history. A data audit in Slice 0 determines which *exact* fields are usable in the local FM27 build. For missing tactical changes, provide a **manual timestamped note** rather than pretending to observe them automatically.

### 2.4 Upstream code observations to confirm in Slice 0

These come from reading the v0.7.0 source, not from a real recording. Slice 0 has since measured them on one recording; `docs/data-coverage.md` holds the results and takes precedence over this list:

- **Pass-map counts:** `passMap.ts` adds to an edge without checking completion, so an upstream edge `count` is not a completed-pass count. Its `buildPassMap` also filters to `isOnPitch` players.
- **Receiver IDs on incomplete passes:** incomplete passes can carry a receiver ID. Whether that means the intended recipient is unknown; if verified, it could enable the receiver-specific attempt rates that §7.2 otherwise leaves null.
- **Player identifiers:** the parser exposes `playerId`, `slot` and a nullable `uid`, and events carry `playerId` and slot. The meaning and persistence of each are not documented.
- **Event types:** `eventType` is a raw integer in the parser, so pass and other event classifications need a verified mapping.
- **Coordinates:** `passMap.ts` assigns `event.y` to a node's X value and uses percentages, whereas §7.7 uses `[0,1]`. Establish the axes and units before writing orientation code.

## 3. Target user stories

In priority order:

1. **Match recap:** “What actually happened in Farnham vs. Horsham? How did the match change over time?”
2. **Striker isolation:** “Why is George Alexander receiving so little useful service? Is it aerial losses, poor support, poor passing connections, or a combination?”
3. **Playmaker involvement:** “Which players did Jack Spong pass to? Did he progress the ball, or recycle it? Did his role or touch locations change?”
4. **Defensive weakness:** “Which flank did the opposition attack? Where were attacks created, and who was defending those areas?”
5. **Substitution impact:** “What changed after Bingham replaced Alexander or after we moved Spong to AMC?”
6. **Tactical experiment:** “Before/after switching from Bypass Press to Balanced buildup, did our progressive passes and xG creation improve?”
7. **Five-match review:** “Are we creating better chances and conceding less, or merely benefiting from unusually good finishing?”
8. **Halftime assistant (later):** “Summarize the main threats and give at most one conservative, reversible adjustment based on data so far.”

An assistant's match review uses one five-part structure: **facts, interpretation, alternative explanations, action (at most one, or the reason for withholding it), and confidence with what to watch next**. No recommendation should be represented as proven solely by one match or an observational before/after comparison.

## 4. Scope

### 4.1 In scope for MVP

- Windows local archive discovery and ingestion.
- Completely offline analysis of recorded `.fmlens` files **after FM is closed**.
- Select a save/team and identify whether Farnham was home or away.
- Match and player summaries; xG, possession, progressive passing, shooting and aerial stats where present.
- Time-window comparisons and passing networks where coverage permits; substitution-aware participation and an explicit fallback when recipient evidence is inadequate.
- Read-only MCP tools with bounded outputs; local stdio integration.
- Explicit data-quality flags and evidence locators.
- CLI to list/analyze a match without an LLM.
- Unit, integration and golden-fixture tests.

### 4.2 Later, behind explicit milestones

- Defensive threat and rating diagnostics.
- Season-indexed history and rolling comparisons.
- Manual notes for tactical tweaks, roles, instructions, and observations.
- Live HTTP/WebSocket ingestion, recording continuations and on-demand halftime reporting.
- Automatic archive-directory watching with an explicitly configured save assignment.
- Remote access from the Mac Studio over an authenticated private channel.
- Optional HTML dashboard, structured JSON/CSV report export.
- Optional ChatGPT remote connector if its current connector requirements can be met securely.

### 4.3 Out of scope

- Automating the Football Manager GUI, changing tactics or transfers in-game, save editing, or writing into FMMatchLens memory.
- Altering FMMatchLens's game hooks or the Football Manager binary.
- Automatically inferring the manager's tactical instructions from pass maps.
- LLM calls, model hosting or embeddings inside the core analysis library.
- Recreating every dashboard visualization before basic analytical queries work.
- Selling/monetizing data or publishing private match data.
- Making authoritative claims about FM's internal match-engine rating algorithm; upstream rating breakdowns are an approximation.

## 5. Proposed technical architecture

```text
WINDOWS 10/11 (Steam FM27)
  Football Manager 27
       |
  FMMatchLens v0.7.0 + BepInEx 6 IL2CPP x64
       |                \
       |                 -> *.fmlens files (BepInEx/plugins/FMMatchLens/data/matches)
       +--> 127.0.0.1:16726 (HTTP and WS; remain localhost-only)
                                  |
  FM Match Intelligence (Node.js/TypeScript)
       - upstream adapter (file archive + optional local HTTP)
       - normalizer + provenance and quality checks
       - metrics/analysis engine (pure functions)
       - local metadata/derived-index store (SQLite)
       - CLI (works without LLM or MCP)
       - MCP adapter (READ-ONLY)
             | stdio: local process
             | optional authenticated Streamable HTTP over private network
             v
  OMP on Mac Studio / Windows MCP client / approved remote connector
       |
       v
  Explanation + limited tactical recommendation (user applies changes)
```

### Technology choices

| Component | Initial choice | Rationale |
|---|---|---|
| Runtime | Node.js 22+ and TypeScript (strict) | Shared language with upstream frontend parser; OMP-friendly development |
| MCP | Official TypeScript SDK **v2**, `@modelcontextprotocol/server` | Current stable 2026 MCP API; avoid older v1 examples |
| Local transport | stdio | Least exposure, easiest first integration |
| Remote transport | Streamable HTTP (optional later) | Supported approach for remote MCP hosts |
| Schema validation | Zod v4 or equivalent | Validate inputs, upstream output, and tool results |
| Archive decoder | Upstream MIT parser adapted behind an interface | Avoid fragile reverse engineering |
| Persistence | SQLite via `better-sqlite3` for metadata/derived aggregates, behind the `store` interface | Search, deduplication, season trends; mature synchronous driver. Verify the Windows install on the pinned Node version in Slice 1 and fall back to `node:sqlite` if needed |
| Raw input | Original `.fmlens` retained read-only | Provenance and reprocessing when formulas change |
| Tests | Vitest; fixture and parity tests | Fast deterministic checks |
| CLI | Node entrypoint with JSON and readable text modes | Usable without any AI client |
| Windows packaging | `npm`/standalone build initially | Keep first slice simple; installer later |

Use SDK v2 documentation: <https://ts.sdk.modelcontextprotocol.io/v2/>. Avoid copying v1 import examples; the v2 package layout differs.

**Deployment decision:** place the importer/service on **Windows** first so it can read archives and access FMMatchLens's loopback API. Running OMP on the Mac Studio should not be a blocker. For offline analysis, copied archives can alternatively be processed on the Mac; for live analysis, access must traverse a deliberate, authenticated bridge. **Never rebind FMMatchLens itself to `0.0.0.0`.**

### Suggested repository layout

```text
FMMatchLens_MCP/
  README.md
  LICENSES/                    # upstream attribution/third-party notices
  docs/
    architecture.md
    metrics.md
    data-coverage.md
    setup-windows.md
    setup-omp-mac.md
    troubleshooting.md
    ADR-001-archive-first.md
  config/
    example.config.json
  packages/
    model/                     # normalized immutable types & validators
    fmlens-adapter/            # file parser + optional local API client
    analytics/                 # deterministic metrics & analysis queries
    store/                     # SQLite metadata and derived indexing
    mcp/                       # thin read-only MCP adapter
    cli/                       # inspect, ingest, report, diagnostics
  tests/
    fixtures/                  # synthetic archives and normalized inputs (committed)
    fixtures/local/            # real recordings (gitignored)
    golden/
    e2e/
  scripts/
    smoke-check-windows.ps1
```

Keep core `analytics` entirely independent of FMMatchLens APIs, MCP, and database calls so it can be tested with ordinary normalized in-memory fixtures.

Real recordings stay in the gitignored `tests/fixtures/local/` directory and are never committed. Tests that need them report a skip when they are absent, and the §12 real-fixture quality gate is run locally before a slice is accepted. Committed integrity and format tests use a small test-only synthetic archive writer.

## 6. Data model and ingestion

### 6.1 Core entities

- **SaveProfile:** app-generated `saveId`, `displayName`, optional favorite club UID and human-manager identity, season start date (default 1 July); explicit import assignment and separate profiles for divergent save branches.
- **Match:** app-generated opaque `matchId`, `saveId`, preserved `upstreamMatchId`, competition/date, `season` label derived from the in-game date and the save's season start (`null` if the date is unavailable), home and away identifiers, observed goals, final result only when verified, and selected recording revision.
- **RecordingRevision:** immutable `recordingRevisionId`, parent revision (null until continuation support in Slice 5), archive SHA-256, managed snapshot location, original source location, source/parser versions, processing time, integrity, capture coverage and match completion (§6.3). Metric formula versions identify derived projections separately from raw revisions.
- **TeamMatch:** `matchId`, `teamId`, `side`, opponent, latest observed team-stat snapshot (final only when verified), periods available, data coverage.
- **PlayerIdentity:** app-generated `playerId` scoped to `saveId` and verified upstream persistent UID; separate match-local participant ID when no persistent UID is available. Display names are presentation only, not keys.
- **PlayerParticipation:** match-local source player ID mapped to `playerId`, canonical on/off boundaries, elapsed playing duration and role/position timeline; substitutes must be represented even when absent at full time.
- **Frame:** ordered tick/display tick, observed game state and measured cumulative statistics. Retain in-memory or file-backed; do not require all frames in SQLite.
- **Event:** canonical boundary, actor, recipient, action, team, coordinates, source event ID and annotations; preserve revision-scoped provenance and stable event identity. Deduplicate event revisions within their recording, never across unrelated matches on event ID alone.
- **TacticalNote:** `noteId`, `saveId`, `matchId`, user-entered minute, affected side, tactic/setting, prior value, new value and confidence `manual`.
- **Metric:** value, unit, window, participation denominator, derivation, coverage, sample size, source locator and any warnings.

### 6.2 Identity and orientation

- Identify the managed club using team UID and human-manager metadata when available; otherwise require one explicit profile selection.
- Do not infer Farnham's side from scoreboard color or its position in a filename.
- Normalize all coordinates into team attack orientation **per period**; validate direction changes at halftime before building heatmaps/field-third metrics.
- Preserve source coordinates, units and source tick alongside normalized coordinates. No silent assumptions about pitch dimensions.
- Public CLI/MCP `matchId`, `teamId` and `playerId` are opaque internal IDs. Preserve upstream IDs in separate fields; match-local player slots must never be treated as persistent player UIDs. Without a verified UID, retain a match-local identity and withhold cross-match player aggregation until explicitly resolved with `fmmi player link` (Slice 4), which records an audit entry; never merge on name alone.
- Assign every import to an explicit save profile (`fmmi ingest ... --save <saveId>` or an explicitly configured default). Team and persistent player identities are save-scoped; a reloaded, divergent save branch requires a separate profile when both branches are retained. Archives do not identify their save, so `fmmi match move <matchId> --save <saveId>` corrects a wrong assignment, rebuilds the save-scoped identities and records an audit entry.
- Deduplicate identical archive hashes within a save regardless of filename/path. Through Slice 4, a changed archive with the same source identity is not an automatic update: retain it as an immutable revision marked `identity_conflict`. Automatic extension of a verified recording prefix arrives with live ingestion in Slice 5, or earlier only if Slice 0 shows that finished archives change.
- A replayed fixture is a separate internal match occurrence, even if date, opponents or upstream ID repeat. Conflicting recordings are retained with `identity_conflict` and excluded from default analysis until `fmmi recording resolve` marks them as a separate occurrence or ignored; continuation and alternate-recording choices arrive in Slice 5. No silent merging or overwriting of results.

### 6.3 Ingestion rules

1. Search user-selected archive directory (default under game installation); show a clear error if missing.
2. Prefer finalized archives, but classify file integrity, capture coverage and match completion independently as defined below. Do not treat a clean close as proof of full-time coverage.
3. Read a stable copy or snapshot (size/mtime check before/after) rather than assuming a game-writing file is immutable. Retain a content-addressed, immutable managed snapshot for every accepted revision so later source growth/replacement does not invalidate evidence; if a configured storage limit would be exceeded, refuse the ingest with a stable error before any catalog change, never evict retained snapshots automatically, and never modify the original.
4. Validate archive header/version, CRC, decompressed block sizes, tick order, metadata revisions and match identity. Bound memory and decompression sizes.
5. Parse all recorded participant metadata, including substituted-off players, late-added players and role changes.
6. Compute deterministic aggregates; store metrics and their algorithm version, retaining references to the original archive.
7. Make re-ingestion idempotent using save assignment, archive hash and the identity rules in §6.2. Stage validation and derived projections before an atomic catalog update. Formula/parser changes rebuild versioned projections without changing raw revision identity; results cite the exact revision and algorithm used.
8. An unavailable field remains `null` with reason, e.g., `not_recorded`, `unsupported_version`, `partial`, `unverified_semantics`.
9. Support manually registering archives copied to the Mac or another path without requiring FM to be running.
10. Respect local file permissions; no recursive arbitrary-drive scanning or implicit deletion of source files.

**Important upstream nuance:** some existing pass-map code filters participants using `isOnPitch`. A full-match analysis must include players who were substituted **off** during the selected window, not just the XI visible at full time. Test this explicitly.

Record these independent dimensions:

| Dimension | Values / required evidence |
|---|---|
| File integrity | `valid`, `recovered_prefix`, `invalid`; include last validated boundary, error and clean-close marker separately |
| Capture coverage | `full_match`, `partial`, `unknown`; include observed period/tick intervals, gaps and whether a trustworthy initial baseline exists |
| Match completion | `completed`, `completed_manual`, `in_progress`, `unknown`; `completed` requires a source signal whose full-time semantics were verified in Slice 0, not merely a stable file, footer, minute >= 90 or closed writer; `completed_manual` requires an audited user confirmation |

Only label goals/result as final when match completion is `completed` or `completed_manual`; otherwise show the observed score and its boundary. A completed match can still have partial capture, and individual metrics can have narrower coverage than the recording. Default season trends include only nonconflicting `completed` or `completed_manual` matches with full-match capture; disclose exclusions and which matches rely on manual confirmation. An explicit opt-in may show partial recordings separately, without mixing them into full-match comparisons. If upstream cannot prove completion, retain `unknown` until the user runs `fmmi match confirm <matchId> --score <home>-<away>`. The command records an audit entry and sets `completed_manual`. It attests that the match reached full time, not that the recording did: skipping the rest of a match ends the recording early, and goals can fall in the unseen time. A score that differs from the last observed score therefore needs `--allow-score-change`, is stored as a manual final score with a warning, and never alters observed counters. Confirmation does not change capture coverage. `full_match` requires a trustworthy baseline, a recording that reaches full time, and no gap inside a period longer than the registry tolerance (initially 240 ticks, one game minute); ordinary tick gaps are normal because frames are sampled. Never set this state automatically.

A confirmed match whose capture ends early is `partial` with `end_capture_ends_at` set. Default season **rates** may include it when it has a trustworthy baseline and at least 80 captured game minutes, because their denominators use measured minutes; disclose it as early-ending. Season **totals** and final results exclude its unseen time, and a manual final score is reported as such.

### 6.4 Metric evidence contract

Every nontrivial analytic result carries the fields below. In a response with several metrics, shared fields (match, save, revision, source, dictionary version) sit once on the response envelope and each metric row states only what differs, so the evidence contract does not consume the §8 output limits:

```json
{
  "metric": "progressive_passes",
  "value": 3,
  "unit": "count",
  "matchId": "<internal-match-id>",
  "saveId": "<save-profile-id>",
  "recordingRevisionId": "<immutable-recording-revision-id>",
  "teamId": "<stable-team-id>",
  "playerId": "<stable-player-id>",
  "window": {
    "from": { "period": 1, "tick": 0, "sequence": 0 },
    "to": { "period": 2, "tick": 16560, "sequence": 0 },
    "bounds": "[from,to)",
    "display": { "fromMinute": 0, "toMinute": 69 }
  },
  "coverage": "complete_for_window",
  "source": { "kind": "fmlens_archive", "format": "2.8", "startTick": 0, "endTick": 16560 },
  "derivation": "observed_player_cumulative_delta_v1",
  "metricDictionaryVersion": "1.0",
  "confidence": "deterministic",
  "warnings": []
}
```

Allowed `coverage` values are `complete_for_window`, `partial_for_window` and `unavailable`. Allowed `confidence` values are `recorded`, `deterministic`, `estimated` and `manual`.

This is an **illustrative contract**, not an assertion that those are any particular player's observed ticks. Include actual stable event IDs/ticks only if returned by a recording. If a metric is estimated or not reconstructable, label it; do not silently substitute a model guess.

## 7. Analytical methods

### 7.1 Match timeline and periods

- Use canonical ordered boundaries `(period, source tick, source sequence)` internally; retain display tick and displayed minute separately. Slice 0 must document actual tick/period/sequence semantics. If sequence is absent, use deterministic source record order and flag any event-versus-substitution ordering that remains unresolved.
- Windows are half-open `[from,to)`. Adjacent windows count a boundary event once; a full-match query uses an explicit end-of-recording boundary after the last included record. Return the resolved boundaries in every result. Minute shortcuts resolve to period-aware boundaries; ambiguous stoppage-time labels require a period or return `ambiguous_selection`, never silently map `45+2` into the second half.
- Match/period summaries: goals, xG for/against, non-penalty xG **only where penalty event classification is reliable**, shots, shots on target, big chances, possession, passes, progressive passes, final-third actions, corners, fouls/cards, substitutions.
- For cumulative counters, subtract the counter immediately before `from` from the counter immediately before `to`, using verified snapshot/event ordering so the result follows `[from,to)`. A known initial zero is valid only when verified. If snapshots cannot isolate the requested boundaries, return the actual measurable interval and mark requested-window coverage partial, or return `null` with `missing_baseline` / `unresolved_boundary`; do not interpolate exact event counts. Handle documented resets/corrections explicitly, flag unexplained decreases, and never sum successive cumulative snapshots.
- When period possession must be derived from accumulated possession time, compute component deltas before forming a percentage; do not subtract two already-computed possession percentages.
- Handle first/second half, halftime, stoppage time, extra time, event-driven corrections, and windows clipped to a player's minutes on pitch.
- A player participates on `[on,off)`; use ordered source evidence to resolve same-minute substitutions/events. If ordering is unknown, flag attribution as ambiguous rather than allocating by rounded minute. Playing duration is the sum of verified elapsed game-clock intervals on pitch, including stoppage and extra time and excluding halftime/breaks; it is not wall time, nominal 90 minutes or raw display-minute subtraction. Missing clock mapping/participation coverage makes the duration and dependent rates unavailable. Shootout events are reported separately and excluded from match xG/rate denominators.
- Include score state (leading/drawing/trailing), opponent strength proxy if available, and substitutions as context for comparisons.
- A before/after comparison is observational; label potential confounders. If only one shot occurs in a window, warn against drawing firm conclusions.

### 7.2 Passing network and progression

- Directed edge `(passerId -> receiverId)` with observed completions, region, time window and evidence; use **events with receiver IDs** where recorded, counting completions from verified completed events rather than reusing upstream `passMap` edge counts (§2.4). Receiver-specific attempts/success rates require verified intended-recipient data for incomplete passes; otherwise those fields remain null while passer-level attempt/completion totals are reported separately.
- Calculate individual: pass attempts/completions, progressive passes, key passes, passes into final third, forward progression and involvement per 90 where reliably available.
- Distinguish pass volume from *progression*: a player completing 95% of sideways passes should not automatically be praised as the primary creative outlet.
- Include receiver-side metrics: passes received, where received, top supplying players, frequency and changes by game period.
- Where a link is only estimated from positions/events, label `estimated`, and do not merge it with observed passing counts.
- Do not infer *intended* recipients or why a pass was attempted unless the data explicitly contains that fact.
- In Slice 0, audit completed/incomplete event semantics, receiver assignment, duplicate/revised events and coordinate meaning. For each side/window, report relevant pass-event count, count with verified receivers, recipient coverage ratio, cumulative-counter reconciliation and unresolved discrepancies. Reconcile like-for-like scopes (open play versus all passes); use `null` when an equivalent counter is unavailable, not a misleading coverage percentage.
- The initial recipient-diagnostic gate requires verified receiver semantics, at least 95% receiver coverage among eligible completed pass events, and event totals reconciled to equivalent counters within the documented source tolerance. This 95% threshold is a configurable product quality gate, not statistical confidence; missing evidence or unknown reconciliation fails the gate. Partial observed edges remain inspectable with warnings, but cannot support claims that a player received little/no service. Additional sample-size gates apply under §7.7.
- Preserve all valid observed links independently of node coordinates and current `isOnPitch` status. A receiver with no location samples remains a node with `location: null`; visual layout may omit its position but must not delete its links or counts. Pass-origin, reception and average tracking locations are distinct measurements; missing reception coordinates must not be replaced by a player's average position.
- If recipient quality fails the gate, return the available cumulative passing, aerial and shooting data, plus explicit missing-service evidence. Withhold a definitive isolation/connection diagnosis; an unavailable network is an accepted MVP fallback when accurately explained, not a reason to invent recipients.

### 7.3 Striker service / isolation diagnostic

Do not invent an opaque “isolation score” in MVP. Return interpretable components:

| Signal | Interpretation | Availability gate |
|---|---|---|
| Passes received per 90 and match window | Is the striker receiving service? | Reliable pass recipient events |
| Received pass locations / types | Where and how does service arrive? | Coordinates and event types |
| Attempts/shot xG/xG per 90 | Is service becoming useful chances? | Shots/xG recorded |
| Aerial duels attempted/won | Are long balls useful? | Player aerial counters |
| Touches in final third | Is striker involved high up? | Touch event fidelity |
| AMC/winger proximity and supporting runs | Are teammates nearby when striker receives ball? | Tracking samples, valid pitch orientation |
| Opponent CB matchup context | Potential explanation | Match positions + annotations; hypothesis only |

The CLI exposes these components through `fmmi service` and MCP through `get_striker_service`, each with its availability, the §7.2 gate status and the fallback result. Final-third touches and support proximity stay unavailable until they have §7.7 registry definitions.

Narrative example based on the screenshot facts in §13: “Alexander won 0/7 aerial contests. Bingham won 3/4 after replacing him and generated 0.33 xG. These counts suggest testing distribution or striker selection, but do **not** establish pass-reception volume or prove either player caused the result. Recipient and delivery-type evidence would be needed to assess service.” An actual report must cite its own recording; the screenshots do not establish a service diagnosis.

### 7.4 Wide threat and defensive analysis

Delivered in Slice 3b.

- Compare opposition chance creation by attacking lane/side, progressive passes/crosses, entries into danger areas, high-value sequences and our defenders' recorded involvement.
- Attribute a conceded goal to a specific player **only when replay/event evidence supports it**; present alternatives and confidence otherwise.
- Preserve in-possession and out-of-possession tactical roles as distinct fields.
- Defenders' stamina concerns: show recorded distance/sprints/participation and, if genuinely captured, condition. Distance by itself is not proof of fatigue, nor is one declining rating.

### 7.5 Rating explanations

Delivered in Slice 3b. FMMatchLens v0.7.0 reconstructs components of player ratings. These are **upstream estimates of rating mechanics**, not official Sports Interactive causation. Surface:

- native in-game rating,
- estimated contribution categories (shooting, creativity, passing, defending, goalkeeping, context),
- reconstruction residual, model version, limitations and quality flags.

A question like “Why did Spong get a 6.3?” can be answered using both recorded statistical changes and an **estimated** rating breakdown; never say the game definitely used an exact weight unless verified.

### 7.6 Season trends and experimental comparison

- Rolling windows: last 5 and 10 recorded matches, with home/away and opposition-context breakdowns.
- Per-90/percent ratios require adequate denominators; list sample size.
- Look at xG difference, non-penalty xG where available, chance quality, striker aerial success, final-third progression, chance creation by wing and set-piece production.
- Track user-annotated interventions: minute, old/new setting, opponent, score at change, players on pitch.
- Compare *normalized per-minute rates* before/after, and ideally multiple matches under each variation; avoid claiming a causal win from a one-match comparison.
- Prefer identifying a **testable next adjustment** with an expected measurable signal and downside risk.
- Apply the default recording eligibility policy in §6.3; list included and excluded matches with reasons. Pool numerators/denominators for percentages and per-90 rates instead of averaging individual match percentages/rates. Missing fields contribute to neither numerator nor denominator; disclose metric-specific contributing matches, minutes and exclusions.

### 7.7 Versioned metric dictionary and finding gates

`docs/metrics.md` and a shared machine-readable definition registry must be implemented in Slice 2, with the evidence/clock definitions established in Slice 1. Each entry records its ID/version, unit, source fields, formula, eligibility, null reasons, sample-size gates, scope (including set pieces), rounding and any thresholds. Formula or threshold changes version the definition and rebuild affected projections; CLI and MCP use the same registry.

Initial definitions:

| Metric / concept | Definition and gate |
|---|---|
| Recorded progressive passes | Verified upstream cumulative counter delta; preserve upstream definition/version. Do not substitute a new distance rule under the same ID. If its football semantics are unverified, label it as an upstream counter rather than claiming a specific progression distance. |
| Derived final-third entry | A verified completed pass starting below normalized attacking length `2/3` and ending at or above `2/3` on a `[0,1]` pitch; requires both endpoints and validated direction. Distinct ID from upstream `finalThirdPasses`, which may use different semantics. |
| Forward pass distance | End minus start along normalized attack direction, converted to metres only with valid pitch dimensions. Do not conflate positive forward distance with the upstream progressive-pass classification. |
| Passing network | Separate observed attempts/completions; label `open_play`, `all_passes` or `counter_scope` (all passes except throw-ins, crosses counted separately; the scope the cumulative counters use, per `docs/data-coverage.md`) and expose set-piece inclusion. Default is open play with verified classification; otherwise scope is unknown and cross-scope comparisons are unavailable. Unknown intended receivers of incomplete passes do not create receiver-specific attempts or success percentages. |
| Ground service | Verified completed receptions explicitly classified as ground passes by a validated source type or documented trajectory rule. Absence of an aerial duel does not establish ground service; without reliable classification return `null`. Keep all-pass receptions as a separate metric. |
| Aerial win percentage | `100 * aerialsWon / aerialsAttempted`, after verifying that source counters share that meaning; attempts of zero yield `null` with `zero_denominator`. Show won/attempted counts alongside it. |
| Shot quality | Recorded player/team xG divided by corresponding shot count for the same scope/window; zero shots yield `null`. Per-shot estimates retain their own confidence and are not substituted for recorded aggregate xG. |
| Possession percentage | `100 * own possession-time delta / (own + opponent possession-time deltas)`; zero/unknown denominator yields `null`. |
| Per-90 rate | `count * 90 / verified elapsed playing minutes` for players, or verified match playing minutes for teams, restricted to the metric's covered intervals. Zero/unknown duration yields `null`; report exact duration and coverage. |
| Rounding | Calculate/store at source precision; round only presentation (counts: integers, xG: 2 decimals, percentages/rates: 1 decimal). Reconciliation uses unrounded values and source-specific tolerances recorded in the registry. |

Raw observed counts remain reportable at any sample size. Initial deterministic finding rules are deliberately narrow:

- `low_aerial_success_v1`: at least 5 verified attempts and a win ratio <= 25%; emit counts and label the threshold as a descriptive heuristic, not proof that distribution or player selection caused the outcome.
- Comparative reception/progression rate findings require, in **each** window, at least 15 verified playing minutes for the player and at least 30 verified team completed passes during those minutes, plus equivalent metric scope, adequate coverage and a named comparator. Recipient-dependent findings also require the §7.2 quality gate. The gate measures exposure rather than the player's own count, so a player who received few or no passes is still reportable. Report the direction/size of the difference; do not assign an absolute “low service” or “weak progression” label without a separately documented, versioned benchmark rule.
- Suppress firm chance-quality findings from a single-shot window. No recommendation is mandatory when sample size, source semantics or coverage are inadequate; return facts and what to record/watch next.

These are initial product gates, not significance tests or calibrated tactical norms. Tests must cover equality at each threshold, below-threshold suppression, missing denominators, and pooled season aggregation.

## 8. MCP contract (read-only)

MCP is a thin query layer over the domain service. It should **not** ask an LLM to parse binary files or perform arithmetic on thousands of frames in context. Use JSON schema validation, pagination, bounded tool outputs and descriptive errors. Use server SDK v2 and test through the official inspector or a small client.

### 8.1 First tools, in build order

Match-scoped tools also accept the optional `recordingRevisionId` (§8.2).

| Tool | Input | Output |
|---|---|---|
| `list_matches` | `saveId?`, `teamId?`, `season?`, `limit <= 50`, `cursor?` | Internal match/save/team IDs, opponent, date, final result or explicitly provisional score, integrity/coverage/completion, selected recording revision, archive version |
| `get_match_summary` | `matchId`, `teamId?` | Team comparison, xG, shot quality, events, narrative-ready evidence, complete recorded participant roster with internal player IDs, names, side and participation (including substituted-off players) |
| `get_player_match` | `matchId`, `playerId`, `window?` | Minutes, roles, stats, passing/aerial contributions, receptions where verified, availability flags; estimated rating breakdown from Slice 3b |
| `get_passing_network` | `matchId`, `teamId`, `window?`, `minPasses?`, `limit?` | Directed observed links, nodes, locations, counts, caveats |
| `get_striker_service` | `matchId`, `playerId`, `window?`, `comparePlayerId?` | §7.3 components with availability, recipient-gate status, qualified comparison and fallback evidence |
| `compare_match_periods` | `matchId`, `teamId`, `windowA`, `windowB`, `playerIds?` | Team rates, and player rates when requested, with deltas, substitutions, confounders, coverage |
| `get_recording_status` | optional `matchId` | Bounded ingestion health, integrity, observed intervals/gaps, completion evidence, identity conflicts, selected revision, missing metrics and recipient-diagnostic gate status |
| `get_opposition_threat` (Slice 3b) | `matchId`, `teamId`, `window?` | §7.4 opposition chance creation by lane, entries, defender involvement and coverage |
| `list_players` (Slice 4) | `saveId`, `teamId?`, `nameQuery?`, `limit <= 50`, `cursor?` | Save-scoped player IDs, names, identity status (persistent, linked or match-local) and match counts |
| `get_season_trends` (Slice 4) | `saveId`, `teamId`, `lastN?`, `homeAway?`, `metrics?` | Pooled rolling aggregates with included/excluded match/sample IDs and reasons |
| `get_player_trends` (Slice 4) | `saveId`, `playerIds` (1-4), `metrics?`, `lastN?`, `homeAway?` | Pooled per-player aggregates with contributing matches, minutes, exclusions and reasons; match-local identities are excluded and listed |
| `get_tactical_notes` (Slice 4) | `saveId`, `matchId?`, `limit?`, `cursor?` | User-entered notes labelled `manual`, kept separate from observed formation changes |
| `compare_tactical_change` (Slice 4) | `saveId`, `teamId`, `noteId`, `matchesBefore?`, `matchesAfter?` | Before/after rates across and within matches, score-state and opposition context, confounders, contributing matches and an observational warning |

**Later, once reliable live ingestion exists:**

- `get_live_match` with bounded latest snapshot, capture age and available windows.
- `get_live_player_analysis` for selected player/window.
- `get_recent_tactical_events` (formation/role changes observed; user-manual instruction notes separately).

For manual experiment notes, use a **local CLI/config file or small UI** in the initial design. Do not include writable MCP tools until there is an explicit reason, audit log, and authorization boundary.

### 8.2 Input and output rules

- Read-only tools. No arbitrary paths, URL fetches, shell commands, code execution, game saves, or club-management actions.
- Identifiers must refer to already indexed internal matches/players/teams (§6.2); validate that every player/team belongs to the requested match/save. `list_matches` supplies match/save/team IDs, and `get_match_summary` supplies the complete recorded participant roster so no guessed player ID is required.
- Match-scoped tools accept optional `recordingRevisionId`. If omitted, resolve to the selected nonconflicting revision; always return that revision and projection/metric versions. Follow-up queries can pin it so a new import cannot silently change the evidence during a review. Return `revision_unavailable` if the requested revision cannot be served; never silently substitute another.
- Every result includes, on the envelope where shared (§6.4), source, coverage, schema version, metric formula IDs/versions and a `warnings` array. Formula definitions come from the shared registry (§7.7). Use `null` with an availability reason for missing metrics—not zero. Recording status exposes safe source locators rather than absolute local paths.
- Use a consistent domain-error body: `{ "code": "not_found", "message": "...", "details": {}, "retryable": false }`, represented as an MCP tool error (or CLI structured error) without a success-shaped result. Codes include `invalid_input`, `not_found`, `ambiguous_selection`, `identity_conflict`, `revision_unavailable`, `unsupported_version`, `insufficient_coverage`, `stale_snapshot`, and `internal_error`. Missing individual metrics are a successful partial result with null reasons/warnings; use `insufficient_coverage` only when the requested analysis itself cannot be produced. Do not expose paths, secrets or stack traces in errors.
- Limit arrays (e.g., top 10 relevant passing links); allow explicit pagination or a filtered follow-up query.
- Cap time windows and data volume; accept canonical boundaries or resolve period-aware minute shortcuts under §7.1. Reject negative/out-of-range/reversed windows, unsupported archive versions and stale live snapshots; do not silently clip a requested window to recording coverage. Return requested and effective measurable coverage separately.
- LLM prose must cite facts by match ID, player ID/name, metric and time window; distinguish facts from hypotheses and tentative suggestions.
- Never put raw frames or portrait assets in the LLM response by default. Inspect explicit windows only when required.

### 8.3 Example tool query and report shape

```json
{
  "tool": "get_match_summary",
  "arguments": { "matchId": "selected-from-list_matches" },
  "response": {
    "schemaVersion": "1.1",
    "matchId": "selected-from-list_matches",
    "saveId": "selected-save-profile",
    "recordingRevisionId": "selected-immutable-revision",
    "managedClub": "Farnham Town",
    "result": "loss",
    "opponent": "Horsham",
    "xgFor": 0.83,
    "xgAgainst": 1.83,
    "coverage": "complete_for_window",
    "participants": [
      { "playerId": "internal-player-id", "name": "Example participant", "side": "away", "participation": "resolved-canonical-intervals" }
    ],
    "evidence": ["refer-to-real-source-records"],
    "warnings": []
  }
}
```

The real output must be **generated from recorded data**. The sample score/xG values above came from the user's FM27 screenshots of the Horsham match, not from an existing `.fmlens` archive. An MVP test must compare actual parsed values against the screenshots if a real recording exists, or else use a separate test fixture.

## 9. Operating workflow and UX

### 9.1 After each match (MVP)

1. FMMatchLens creates/finishes `.fmlens` recording.
2. `fmmi ingest --new --save <saveId>` validates and indexes it. A stable file does not establish match completion; if completion stays `unknown`, the user can run `fmmi match confirm` (§6.3).
3. `fmmi list --save <saveId>` displays indexed matches and collection status.
4. `fmmi report <matchId> --format markdown` emits match facts, deterministic findings (§7.7) and evidence quality. It contains no hypotheses or recommendations, because the CLI has no LLM.
5. An MCP assistant calls `list_matches`, `get_match_summary`, and targeted queries, then writes the §3 five-part review; it may ask for a replay clip when the data cannot resolve cause.

### 9.2 During matches (later)

- Live mode must be **on demand**, not an LLM called every 250 ms. Cache latest state and return a summary only when asked or at an explicitly initiated halftime request.
- WebSocket: connect locally; filter by source `upstreamMatchId` mapped to the selected internal match/save, reconcile missed frames through paginated HTTP, and process `formation_changed` without losing context.
- On reconnect, protect against stale/older data replacing newer match state.
- Explicit freshness indicator: “live as of game minute 54 / recorded tick X”, or “not connected” / “stale” if relevant.
- Never send an in-game command. Advice is displayed to the manager, who chooses what to do.
- Match speed and frame rates can vary; no assumptions that real-world seconds map directly to in-game minutes.

### 9.3 OMP and Windows/Mac setup

- First, prove CLI + MCP **locally on Windows** with stdio and a known archive.
- Option A: connect a Windows local MCP client.
- Option B: let Mac Studio OMP query a **separate authenticated MCP endpoint** hosted by the Windows service over a private network (e.g. Tailscale with TLS and authorization); alternatively copy archives to Mac and run the same offline service locally there.
- Do not expose raw FMMatchLens port `16726` to the LAN or Internet; it presently listens on loopback and has permissive CORS. Expose **only** the controlled analysis API/MCP bridge with authentication and least privilege.
- Remote ChatGPT connection is an optional separate milestone; a localhost MCP server does **not** automatically become available in ChatGPT.

## 10. Security, compatibility and reliability

- **Read-only against Football Manager and FMMatchLens:** no writes to game memory, saves, installed plugin files or FMMatchLens recordings.
- Back up the FM save before adding a third-party plugin; FMMatchLens and BepInEx are unofficial runtime modifications and patch compatibility can change.
- **Network:** bind local services to localhost by default; remote mode explicitly opt-in, TLS/private transport plus authentication, narrow origin/host policy and rate limits. Do not allow arbitrary proxying to `127.0.0.1`.
- **Secrets:** OS-backed secret/config store or environment variable; never print tokens or include them in MCP tool results or logs.
- **Input safety:** canonicalize and restrict local archive paths; no path traversal, unbounded file reads, compression bombs, symlink escape, arbitrary URL loading or command execution.
- **Data privacy:** match data stays local by default. If an AI client sends tool results to an online model, tell the user this changes the data boundary. Do not send full player/manager histories unnecessarily.
- **Prompt-injection resilience:** all player/club names, event text and third-party records are untrusted data, not instructions. Escape them in renderers and never execute them.
- **Source fidelity:** pin plugin version during development, record game version and archive structure, reject unknown formats safely, provide upgrade notes.
- **Observability:** human-readable logs with match IDs, durations, coverage and error categories; no full raw frames or identifiable paths logged by default.
- **Recovery:** partial/corrupt archives yield a recoverable prefix when valid, an explicit warning, and no quiet replacement of absent data by zeros.
- **Performance:** bounded memory and event lists; reuse processed archives and aggregate queries, avoid continuously reparsing full histories.

## 11. Development plan — vertical slices

**Each slice is independently shippable. Stop if its acceptance criteria are not met; document blockers rather than inventing data or silently widening scope.**

### Slice 0 — Install, inspect, and prove upstream viability

**Goal:** verify that the user's exact Steam FM27 setup yields parsable source data.

Tasks:

- Pin FMMatchLens v0.7.0 plugin and dashboard; record the Steam FM27 build/version.
- Install compatible BepInEx 6 IL2CPP x64 from reputable sources per upstream instructions; verify plugin load in log. Back up save first.
- Record a small scenario set with the plugin: a home match, an away match, a substitution, a match quit midway and, if practical, extra time. Test whether an instant-result match is recorded at all. Verify `GET /api/health` and `GET /api/archives` on port 16726 while the game is running.
- Confirm a closed `.fmlens` file is created in the actual Windows install path, and whether it is format 2.8.
- Inspect a genuine file and API sample: metadata, team/person identities, xG, shots, progressive passes, aerials, role changes, pass receiver IDs, frame/snapshot meaning, and last-match completion semantics.
- Document persistent UIDs versus match-local slots, including what `playerId`, `slot` and `uid` each mean and how often `uid` is missing, source match-ID behavior, period/tick/sequence ordering, elapsed playing-clock mapping and the source signal (if any) that proves full time. Distinguish a closed recording from a completed match; mark any unverified semantics explicitly.
- Audit pass-event scope, event-type mapping, coordinate axes, completion/receiver semantics and revisions, including what a receiver ID on an incomplete pass means (§2.4); record recipient coverage and like-for-like cumulative-counter reconciliation, including missing reception coordinates and participants without location samples. Record source precision/tolerances and whether the §7.2 gate can be met.
- Compare the same match's scoreboard and a few player stats against FM27 UI.
- Connect the installed OMP to a one-tool SDK v2 stdio server and record whether they interoperate. This spike needs neither FM27 nor a recording.
- Record a `docs/data-coverage.md` matrix: directly observed / derivable / partial / unavailable.

Acceptance:

- `health` identifies a supported plugin/game combination; 1 match archive can be opened in upstream dashboard.
- Data-coverage matrix and sample fixture exist; match score, sides and timestamps agree with FM27 UI.
- Coverage matrix states whether completion, persistent player UIDs, playing duration, pass recipients and ground-pass classification are verified, partial or unavailable; include measured pass coverage/reconciliation and an explicit recipient-diagnostic go/no-go. Inadequate recipient coverage selects the documented fallback rather than blocking all offline summaries; unverified completion selects `fmmi match confirm`, and missing UIDs select `fmmi player link`. Unavailable core identity/score decoding remains a blocker.
- Explicit evidence that the file can be read after closing the game; if not, document the compatibility blocker.
- No changes made to the user save beyond normal playing.
- The scenario results and the OMP spike result are recorded; an OMP incompatibility is documented with the client to use instead.

### Slice 1 — Offline importer + minimal CLI

**Goal:** an LLM-free command shows a match accurately, with the game closed.

Tasks:

- Extract/port upstream decoder under an adapter with MIT attribution; implement Node decompression and CRC/version validation.
- Normalize match/team/player/participation/frame/event records.
- Handle partial recordings, substitution windows and metadata revisions.
- Establish a minimal SQLite catalog with migrations, explicit save profiles/assignment, internal IDs, immutable recording snapshots/revisions and atomic projection updates. Save isolation and durable indexing are required here; rolling season analysis remains Slice 4.
- Implement `fmmi doctor`, `fmmi save create <name>`, `fmmi save list`, `fmmi ingest <file-or-dir> --save <saveId>`, `fmmi ingest --new --save <saveId>` (configured archive directory), `fmmi list --save <saveId>`, `fmmi show <matchId>`, `fmmi match confirm <matchId> --score <home>-<away>`, `fmmi match move <matchId> --save <saveId>`. `show` includes the complete recorded participant roster and independent recording status dimensions.
- Implement `fmmi recording resolve` to mark a conflicting recording as a separate occurrence or ignored (§6.2), with an audit record; do not expose this or any other local correction through MCP.
- Establish canonical boundary resolution, participation/clock semantics and null reasons for missing baselines so Slice 2 uses a single temporal contract.
- Add JSON schema and robust errors.
- Add the test-only synthetic archive writer and the gitignored real-fixture path (§5).

Acceptance:

- CLI works on Windows without the game or MCP running.
- 2.8 test archive passes golden comparison of team names, score (final when completion is `completed` or `completed_manual`, otherwise observed), xG and player identities.
- Fixture with a substitution includes **both** departing and incoming players in their played windows.
- Broken/truncated input produces an explicit partial result or stable error, never invented statistics.
- Repeated import is idempotent; file never modified or deleted.
- Import/list/show survive process restart. Identical archives at renamed paths do not duplicate a match; two save profiles remain isolated. A changed archive with the same source identity is retained as `identity_conflict` and does not overwrite the selected result. Prior revision evidence remains inspectable.
- Cleanly closed mid-match capture remains partial/incomplete or unknown, not a final result. Adjacent windows, same-minute substitutions and missing baselines follow §7.1 without invented zeros or duplicate events.
- `fmmi match confirm` refuses a mismatched score without `--allow-score-change`, keeps observed counters separate from a manual final score, and leaves capture coverage unchanged. `fmmi match move` keeps the two saves isolated. Both write audit records.

### Slice 2 — First useful tactical diagnostics

**Goal:** answer our actual Farnham questions without any LLM reasoning in the analytics library.

Tasks:

- Build match overview, time-window xG/progression, player passing and aerial reports, pass network and striker service report.
- Implement `docs/metrics.md` and the versioned definition registry in §7.7, including source tolerances, eligibility, pooled aggregation formulas and initial finding gates. Carry Slice 0 limitations through all diagnostics.
- Include metric provenance/availability and normalized time-window denominators.
- CLI: `fmmi report <matchId>`, `fmmi player <matchId> <playerId>`, `fmmi network <matchId> --team <teamId>`, `fmmi service <matchId> <playerId> [--compare <playerId>]`.
- Generate deterministic finding candidates under §7.7 (e.g. low aerial success or a qualified reception/progression rate comparison); suppress unsupported absolute low-service/weak-progression labels when gates fail. Reports contain no recommendations (§9.1).
- Validate against 1 real recorded match and synthetic test cases.

Acceptance:

- The tool can identify that a test striker won 0/7 aerial duels (lost all 7), and a substitute won 3/4, without double-counting cumulative stats; only the first meets the initial low-aerial-success finding gate.
- Reports correctly attribute player events to Farnham when Farnham is **away**.
- Correctly reports window totals before and after a substitution and shows uncertainty if pass recipient events are incomplete.
- Recipient diagnostics require the measured §7.2 gate; a failed/unknown gate returns partial observed links and the passing/aerial/shooting fallback without claiming little/no service. A missing node position never deletes a valid edge. Unknown ground-pass type never becomes “ground service.”
- Adjacent measurable windows reconcile to totals; unavailable baselines/boundaries remain explicit. Definition/sample thresholds and pooled ratios pass boundary and missing-data cases.
- A striker with few or no receptions, but adequate minutes and team passes in both windows, still produces a qualified comparison.
- No assertion of tactical cause from a statistical correlation alone.

### Slice 3 — Read-only MCP server

**Goal:** a compatible assistant can ask focused questions about recorded matches.

Tasks:

- Implement SDK v2 MCP server using stdio and the first seven tools from §8, with schemas and output limits.
- Add `list_matches`, `get_match_summary`, `get_player_match`, `get_passing_network`, `get_striker_service`, `compare_match_periods`, `get_recording_status`; use existing domain functions, registry and consistent error codes.
- Define a reusable prompt/resource for the §3 five-part match review.
- Add a review checker that takes a saved assistant response and verifies the five sections, at most one action, and that every cited ID, metric and window appears in the tool results. LLM output is nondeterministic, so run it on saved transcripts as an evaluation, not as a CI golden test.
- Test with an MCP client/inspector; add OMP example configuration only after checking the locally installed OMP's supported MCP client configuration.

Acceptance:

- A client can call all seven tools using an imported match ID, without a Football Manager process. It discovers match/team IDs through `list_matches` and player IDs through the summary roster, including substituted-off players.
- No arbitrary file reads, network fetches or executable operations are exposed to the client.
- Tool output for a complete match remains bounded (e.g. default under ~20 KB, paginated when necessary).
- A client can answer the MVP striker-service question and cite returned match/player/time-window identifiers; a saved response passes the review checker.
- CLI output and MCP output agree for the same inputs.
- Revision-pinned follow-ups return consistent evidence across a concurrent import; conflicting identity, wrong-match player IDs, missing revisions, ambiguous time input and inadequate recipient evidence return the defined errors or partial-result warnings.

### Slice 3b — Defensive threat and rating explanations

**Goal:** answer the defensive-weakness and rating questions after the MVP is proven. This slice does not block the MVP.

Tasks:

- Implement §7.4 lane-based opposition chance creation and defender involvement, with `fmmi threat <matchId> --team <teamId>` and `get_opposition_threat`. Use only fields the coverage matrix verifies, and add their §7.7 registry entries first.
- Implement §7.5 and add the estimated rating breakdown to `fmmi player` and `get_player_match`.

Acceptance:

- A real recording answers which flank the opposition attacked, or reports exactly which evidence is missing.
- No conceded goal is attributed to a player without supporting event evidence.
- Rating output keeps the native rating, estimated contributions, residual and model version separate, and labels contributions `estimated`.
- CLI and MCP output agree for the same inputs.

### Slice 4 — Indexed season history and tactical experiment log

**Goal:** longitudinal analysis rather than one-off reactive advice.

Tasks:

- Extend the Slice 1 SQLite catalog with season query indexes and cached versioned aggregates; retained raw recording revisions remain authoritative. No second persistence implementation or delayed identity migration.
- Add club aliases and assisted human-managed team detection while retaining Slice 1 explicit save isolation/assignment.
- Add `list_players`, `get_season_trends`, `get_player_trends` and five-match rolling review.
- Add `fmmi player link` to resolve match-local identities into a save-scoped player, with an audit record and without name-based merging.
- Provide local `fmmi note` for user-supplied tactic changes (minute, setting, prior/new value), with immutable audit trail; do not imply FMMatchLens directly recorded them.
- Add read-only `get_tactical_notes` and `compare_tactical_change`, comparing changes across matches with score state, opposition, time windows and coverage qualifiers.

Acceptance:

- Five-match review lists exact contributing matches; per-90 stats and totals reconcile.
- Default trends disclose `completed_manual` matches and exclude partial, `unknown`-completion and unresolved-conflict recordings with reasons. Ratios pool numerators/denominators and list metric-specific contributing minutes/matches instead of averaging match percentages.
- A user-entered tweak is clearly distinguished from observed formation changes.
- Reingesting an archive or changing a metric formula safely rebuilds aggregates.
- Two Farnham saves do not merge matches accidentally.
- A client can run the §14 five-match Alexander and Bingham comparison end to end, discovering player IDs through `list_players`. Match-local identities stay excluded until linked.
- A client can read a tactical note and compare before/after across matches through MCP, with observational warnings.

### Slice 5 — Live assistant and Mac Studio connectivity (optional)

**Goal:** on-demand halftime and full-time insight without disrupting game performance.

Tasks:

- Add Windows-local API reader, WebSocket streaming and historical reconciliation; process latest live frame incrementally.
- Add verified-prefix continuation revisions and the continuation and alternate-recording choices in `fmmi recording resolve` (§6.2).
- Add `get_live_match` with fresh/stale/not-in-match states.
- Allow manual annotation of a live tactical change and compare its windows.
- Protect game performance with low-frequency summaries, caching, and backpressure.
- Optionally expose a hardened, authenticated private Streamable HTTP MCP endpoint to the Mac Studio/OMP; no raw port exposure.

Acceptance:

- User can obtain a halftime briefing while in a match with an explicit snapshot minute.
- Network disconnect/reconnect does not duplicate events or regress match state.
- Offline service still works when FM27 is closed or live connectivity is disabled.
- Transport rejects unauthenticated remote clients; safe localhost-only behavior is default.
- A brief recommends at most one reversible change, expresses uncertainty and may withhold a recommendation when evidence is inadequate; saved briefs pass the Slice 3 review checker.

### Slice 6 — Optional visual/report experience

**Goal:** enjoyable season companion without replacing the game UI.

Candidates:

- Match cards, pass-network diagrams, position/role timelines, shot maps, experiment comparison screens.
- One-page shareable Markdown/HTML reports, season review and export of aggregated metrics.
- Optional in-app note taking during matches and explicit opt-in recurring reports.

Only begin after stable parsing and reports are proven useful.

## 12. Test and validation matrix

| Category | Test cases / oracle |
|---|---|
| Versioning | 2.8 supported; any other format rejected with `unsupported_version` until a real archive is reviewed; source file left intact for later ingest |
| File integrity | Invalid magic, CRC failure, oversized compressed block, incomplete last chunk, empty archive, duplicate header, metadata revision disorder |
| Identity | Farnham home vs away; namesakes; match-local slot vs persistent UID; substitution; loan appearance; multiple human-controlled teams/saves; replayed fixture; renamed archive; conflicting upstream ID; changed archive retained as `identity_conflict`; wrong-save correction; manual player link; missing `uid` |
| Temporal | Halftime, minute 45+, second half, ordered goal/substitution in same display minute, half-open adjacent/overlapping windows, missing baselines, stoppage/extra time playing duration, unknown ordering, shootout exclusion |
| Recording status | Cleanly closed mid-match file; full time with partial capture; recovered prefix; unknown completion; manual confirmation accepted, score change refused without its flag, early-ending recording kept `partial` and disclosed in trends; default trend exclusions and explicit partial opt-in |
| Cumulative stats | No sum-of-snapshots error; zero and null differ; match totals equal final snapshot and period changes reconcile |
| Passing | Directed passer/receiver links, completion vs attempted, incomplete pass with receiver ID not counted as a completion, scope reconciliation, recipient-coverage gate at/below 95%, missing coordinate node retains edges, substitutions, unknown ground-pass type, fallback without isolation claims |
| Shot and xG | Final xG agrees with upstream UI within known rounding; window xG delta; penalty classification guarded |
| Player rates | Divide by actual minutes, not match duration; no per-90 value if played minutes are zero |
| Metric registry | Versioned formulas/thresholds, source precision and tolerances, display-only rounding, finding sample gates at/below thresholds, low-reception player passes the exposure gate, pooled season ratios with missing data |
| Ratings | Reconstructed contributions labeled estimated; residual/limitations preserved; missing model data does not yield precise explanations |
| Live | WS reconnect, events reorder/duplicate, bad metadata, stale frames, FM process exit, mid-match archive incompleteness |
| MCP | Schema validation, roster ID discovery, recording status, revision pinning, error-code parity, wrong-match player IDs, pagination/size limits, no writes, no path traversal, auth in remote mode |
| Narrative | Review checker on saved transcripts: five sections, at most one action, every cited ID/metric/window present in tool results; human review confirms hypotheses are distinguished and missing data is noted |

### Quality gates

- `typecheck`, lint and unit/integration test suite pass.
- Real fixture score, team side, player substitutions, shots/xG and aerial records match FM27/UI/known authoritative upstream dashboard values.
- CLI and MCP produce the same canonical calculations.
- Repository contains installation guide, version pin, data-coverage table, limitations and security instructions.
- Every published match conclusion can be traced to an event, series, or clearly declared derivation.

## 13. First real-case review: Horsham 1–0 Farnham

**Status:** screenshot-grounded *example*, **not** a captured archive. Do not fabricate a `.fmlens` recording for this match or use its numbers as automated integration-test evidence.

Known facts from manager screenshots:

- Farnham lost 1–0 away; xG **Farnham 0.83, Horsham 1.83**.
- Horsham generated more progressive passes (**59 vs 32**) and had greater possession (**59% vs 41%**).
- George Alexander: **0/7 aerial duels won**, approximately 69 minutes, **0 shots**.
- Rakish Bingham, replacing Alexander: **3/4 aerial duels won**, **0.33 xG**.
- Jack Spong: approximately **3 progressive passes**; Billy Clifford: approximately **3**; Brandon Mason: **8**.
- Horsham's Jamie Yila generated high chance-creation numbers. The exact defensive responsibility for the goal is unknown without replay/positional evidence.
- Some late-match role and personnel switches occurred; entire-match player ratings should not be attributed exclusively to opening roles.

**Hypotheses to test with future recordings:**

1. Long aerial deliveries make up much of Alexander's service despite his weak aerial outcomes. The screenshots establish neither the volume nor the quality of that service.
2. Spong's possession was insufficiently connected to the AMC/striker in the dangerous third, even though pass accuracy was reasonable.
3. Horsham were more successful advancing through/around Farnham's deep block than Farnham were escaping theirs.
4. The relevant fix may be distribution/connection and support spacing, **not** “more shots” or an immediate wholesale formation change.

**What a future machine-generated report for a similarly recorded match must do:** show observed pass-network edges and receiving locations where verified, contrast periods when the strikers played, identify time windows of recorded formation/role changes, provide opponent wide-creation evidence where available, and explicitly refuse claims that cannot be recovered. Apply the recipient-quality gate and fallback; this does not imply the screenshot-only Horsham fixture can be reconstructed.

## 14. Developer handoff instructions

This document is the implementation specification. A coding agent should:

1. **Start with Slice 0 only.** Do not build live MCP before confirming an actual FM27 v0.7.0 recording and data coverage.
2. Work in **this existing standalone `FMMatchLens_MCP` repository** (`C:\Users\iande\Documents\Projects\FMMatchLens_MCP`), separate from FMMatchLens upstream and unrelated projects. Do not create another repository unless the user requests a different destination.
3. Read and pin the upstream files cited in §2 before reusing code; include MIT attribution for reused portions.
4. Write an `ADR` for parser strategy: **direct archive parser** (required for offline) plus **API adapter** (useful for verification/live).
5. Implement the smallest vertical end-to-end path: archive -> normalized match -> deterministic CLI report -> tests.
6. After each slice, provide: files changed, commands to run, passing tests, a sample output, measured limitations and next-slice blockers.
7. Never skip tests or invent an event/metric merely to satisfy a demonstration.
8. If FM27 v0.7.0 compatibility fails on the installed build, document the failure, leave the existing game setup intact, and investigate upstream updates rather than patching undocumented memory offsets immediately.

### Definition of done for overall project

A manager can ask an MCP-connected assistant:

> “In the last five Farnham matches, has Alexander been receiving better ground service? Compare him to Bingham, explain Spong's role in possession, and recommend one change to try next.”

The assistant returns **actual recorded** internal match IDs and recording revisions, windowed stats, qualified pass-network evidence, limits/confounders, and at most one testable recommendation; the recommendation is not performed inside the game. Ground-service claims require verified ground-pass classification; inadequate recipient evidence triggers the explicit fallback rather than an isolation claim. Season comparisons disclose included/excluded matches and require sufficient eligible recordings. The same core analysis is inspectable via CLI, remains available after FM is closed, and is safe by default.

---

## 15. Source and version references

- FMMatchLens [repository](https://github.com/osnsyc/FMMatchLens), [v0.7.0 release notes](https://github.com/osnsyc/FMMatchLens/releases/tag/v0.7.0), [MIT license](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/LICENSE).
- Upstream local HTTP / WS routes: [LocalApiServer.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/LocalApiServer.cs) and [WebSocketHub.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/WebSocketHub.cs).
- Archive decoder / format: [archiveParser.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/archiveParser.ts), [ArchiveFormat.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/ArchiveFormat.cs), [MatchArchiveStore.cs](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/src/FMMatchLens.Plugin/Services/MatchArchiveStore.cs).
- Relevant analysis code: [realtimeMatch.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/realtimeMatch.ts), [passMap.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/passMap.ts), [replayDerivations.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/api/replay/replayDerivations.ts), [match.ts](https://github.com/osnsyc/FMMatchLens/blob/v0.7.0/frontend/src/types/match.ts).
- Official [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and [server SDK package](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/).

**Versioning note:** all upstream implementation details in this spec were checked against FMMatchLens v0.7.0 on October 30, 2026. Re-verify when upgrading FM27, FMMatchLens or MCP SDK versions.
