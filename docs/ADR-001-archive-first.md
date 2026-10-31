# ADR-001: Archive-first parsing, API adapter second

Status: accepted (Slice 0, 2026-10-30). Revisit when FMMatchLens, FM27 or Node major versions change.

## Context

Spec §14 requires a parser-strategy ADR: a direct archive parser (required for offline use) plus an API adapter (verification and live use).
Facts established in Slice 0 (details and numbers in `docs/data-coverage.md`):

- The v0.7.0 `.fmlens` format 2.8 is fully decodable under Node 25.1 by upstream's own `archiveParser.ts`. Only the import
  specifiers had to change; no logic edits, no new dependencies. `DecompressionStream("deflate")`, `Blob` and `TextDecoder` are
  global in Node 22+. The real recording (1.83 MB, 15,768 frames) decodes in about 2 s including the audit, and every header, record,
  block and final-index check in the parser passes.
- The same recording was also served by the live HTTP API (`/api/health`, `/api/archives`, `/api/match/status`) while FM was
  still running: frame count, first/last tick and final score agree with the file. The API is also gone the moment FM exits,
  while the file remains readable.
- Archive structure is the plugin's wire contract, versioned by the file header ("the file-header version is the sole authority").
  The HTTP routes are not a versioned public contract (spec §2.1).

## Decision

1. **The archive parser is the primary and only source of truth for Slices 1-4.** Offline, deterministic, hashable, retains
   provenance, works with FM closed or on another machine.
2. **Reuse upstream's decoder, do not rewrite it.** Vendor the pinned v0.7.0 sources untouched in `vendor/fmmatchlens-v0.7.0/`
   (untrusted reference, never executed, SHA-256 and tag recorded in `PROVENANCE.md`, MIT licence retained). Slice 1 copies the
   decoder into `packages/fmlens-adapter/` behind an interface, keeps the MIT notice, and changes only what is required
   (path aliases, the stubbed rating dependency if the estimated rating breakdown is deferred, bounds on memory). Any further
   edit is recorded as a diff against the vendored file.
3. **Pin format 2.8 only** (spec §2.2). Reject other minors with `unsupported_version` until a real archive is reviewed.
4. **Do not depend on upstream's frontend derivations** (`passMap.ts`, `replayDerivations.ts`, `realtimeMatch.ts`). They are
   display code. Slice 0 measured that `buildPassMap` drops 141 of 522 (home) and 312 of 468 (away) completed open-play links
   when the on-pitch set is taken at the final frame, counts edges without checking completion, and drops edges whose endpoints have
   no node position. Our analytics derive from the decoded frames and event ledger and are tested against the cumulative counters.
5. **The API adapter is optional and secondary.** Uses: (a) cross-check a just-finished match against its archive
   (`/api/archives`, `/api/archives/{id}/frames`), (b) the Slice 5 live path. It must validate every response, tolerate absence,
   and never be a prerequisite for ingest. Never rebind or expose port 16726.
6. **Treat decoded data as untrusted.** Player and club names are strings from a game file; escape them in renderers and never treat
   them as instructions. Enforce the parser's size limits (4 MiB record, 16 MiB chunk, 255 players) and add our own total-size cap.

## Consequences

- Slice 1 can start immediately; there is no reverse-engineering risk.
- Upstream schema changes arrive as a new format minor (2.9+). Our reader fails closed and we port the new fields deliberately.
- Archive-level semantics are not self-describing. The raw integer `eventType`, `flags`, side-local event slots and the
  `0x100` direction bit must be mapped by us; the mapping verified against this recording is listed in `docs/data-coverage.md`.
  Unverified types stay unverified in the registry.
- A decoder that matches upstream byte for byte means upstream bug fixes can be diffed in. We accept the maintenance cost of
  tracking v0.7.x tags.
- A finished archive does not prove a finished match (`docs/data-coverage.md`, completion). That is a data-model problem the
  parser choice cannot solve; `fmmi match confirm` remains necessary.

## Alternatives rejected

- **API-only ingestion:** needs FM running, is not versioned, is lost on exit, and cannot serve recordings made while we were not
  connected.
- **Reimplementing the decoder:** the wire format is intricate (delta/XOR streams, tail-compressed event lists, rating vectors).
  Upstream already maintains it; rewriting adds risk for no gain.
- **Embedding upstream's frontend modules wholesale:** pulls React-oriented, alias-heavy display code into a headless service.
