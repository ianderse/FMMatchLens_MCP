# Third-party notice: FMMatchLens decoder

The files in `src/upstream/` are copied from FMMatchLens v0.7.0 (https://github.com/osnsyc/FMMatchLens, tag `v0.7.0`),
MIT licence, Copyright (c) 2026 osnsyc. The licence text is in `LICENSE-UPSTREAM-MIT` and must stay with any copy.

| File here | Upstream source (vendored untouched under `vendor/fmmatchlens-v0.7.0/`) |
|---|---|
| `src/upstream/archiveParser.ts` | `frontend/src/api/archiveParser.ts` (edited, see below) |
| `src/upstream/ratingCalculator.ts` | `frontend/src/lib/ratingCalculator.ts` (import specifiers only) |
| `src/upstream/match.ts` | `frontend/src/types/match.ts` (import specifiers; two inline display-only type imports replaced) |
| `src/upstream/realtimeTypes.ts` | `frontend/src/api/realtimeMatch.ts` lines 48-316, type declarations only, verbatim |
| `src/upstream/localArchive.ts` | not upstream: FMMI-authored type for the object `parseArchiveFile` returns |

`UPSTREAM_DIFF.patch` is the exact diff of the three edited files against the vendored originals (regenerate with the command in
`docs/` history or `diff -u`). Edits to `archiveParser.ts` and why:

1. Import specifiers rewritten to relative `.ts` paths (Node type stripping).
2. `firstSupportedStructureMinor` 1 -> 8: format 2.8 only (spec 2.2); anything else is `unsupported_version`.
3. Size bounds (`ArchiveLimits`): file size, block count, total declared frames, total declared uncompressed bytes. Upstream already
   caps one record at 4 MiB, one chunk at 16 MiB and 255 players.
4. Streaming sink (`onFrame`): frames are handed out per block and not retained, so memory stays bounded.
5. `integrity` block on the result (truncated tail, first block error, blocks and frames decoded, last validated tick/period). Upstream
   silently turns an end-of-file into a shorter archive; FMMI must report it.
6. `ArchiveError` exported so the adapter can map parser messages to stable error kinds.

No decoding logic was changed. The decoder sits behind the `ArchiveDecoder` interface in `src/decoder.ts`.

## Slice 3b: runtime use of the retained rating calculator

From Slice 3b, `src/upstream/ratingCalculator.ts` (MIT, Copyright (c) 2026 osnsyc) is also run at analysis time, not only by the parser:
`src/ratings.ts` (FMMI-authored, not upstream) calls `decodeArchiveRatingInputs` and `calculateRatingContribution` once per player over
the LAST decoded frame, and maps the six upstream groups to context, shooting, creativity, passing, defending and goalkeeping. The
calculator, its weight table and its factor table are used **unmodified**: the only edits to that file remain the two import
specifiers listed above, so `UPSTREAM_DIFF.patch` is unchanged (regenerated and compared hunk for hunk on 2026-10-30; only the file
order in the patch differs from a fresh `diff -u`). The MIT notice above and `LICENSE-UPSTREAM-MIT` therefore continue to cover this use.

What the output is: an upstream **estimate** of rating mechanics, labelled `estimated`, with its reconstruction residual and the
model id `fmmatchlens_rating_reconstruction` / version `fmmatchlens-v0.7.0-ratingCalculator`. Upstream states that the weight
table was observed on an FM26 build and that two weights (W04, W05) are unresolved; FMMI never states that the game uses any weight.
A player whose role pair is missing from the upstream table, or who has no eligible playing time, gets a null estimate with a reason.
`scripts/audit/lib/ratingCalculator.ts` is a separate audit-only copy and is not used at runtime.
