# Package 5 evidence and reviewer handoffs

## Operator follow-up

After candidate `284bd26`, native Opus review 1580 completed on its first response but left three inherited criteria `cannot-tell`. Root replay identified two additional false classifications: quoted `[redacted: ...]` source text was treated as hidden content, and valid UTF-8 containing a literal U+FFFD was called binary.

Root repaired these directly. Only complete native redaction-marker lines disqualify a patch section. UTF-8 roundtrips and the existing exact Git blob hash distinguish actual decoding damage from valid text. Two new regressions failed before the fix; typecheck and all 164 tests in the three affected context/reviewer suites now pass, including malformed-byte rejection. No evidence, review, approval or cap was waived.

The read-only replay of real run 1579 now carries `src/provider.ts` (48,925 bytes), the context implementation's source/revision patches (33,753), and the reviewer patch (5,111). Its 174,098-byte packet roundtrips and passes custody checks; SHA-256 `da4a958d3e1be3af5b238cdc427e0f697b20559fb8904e016c3790f1324d3005`. Prior handoff support is eligible. Truly redacted tests and partial whole-file coverage remain explicit gaps. The original review and artifact 640 are unchanged; this replay is not a new independent review.

The fixes were committed as `bfa520b` and included in naming candidate `7c813e09cb0b55f2440c7c2c5172cba74e50f615`. Native build 1581 passed the unchanged full gate: typecheck/build, 2,932 tests passed and 23 existing skips across 167 suites. Check artifact 656 has SHA-256 `09df39b33a35269af399375f6d0c49aa5a71fe58ca654da0a07330d0025f06c2`. Its Opus review upheld naming's three criteria after one automatic invalid-path correction; that is not an independent review of the evidence-engine changes.

The promised real follow-up succeeded: linked build **1584**, candidate `14e65755258f0f262542d7e4541718090983c962`, passed its own unchanged full gate (2,932 passed / 23 existing skips). Complete native context artifact **675**, SHA-256 `d613cdd5d7b24ba1865cd8716ee82b79999bcee74a50063da090bc3c2d71ef32`, carries both the original naming implementation and the small revision, including exact source/test/browser patch chains. All prior bindings verify; partial coverage remains explicit. Independent Opus **1585** cited that restored context and upheld all three inherited criteria on its **first response**, with no cannot-tell or correction. Response artifact **676**, SHA-256 `e1598bbb0b8463029e69c2b81a33a63260f0af7a27adde3df88e91dfe496f0f2`. This verifies the real evidence handoff, not every possible repository or failure case. The installed older worker is unchanged; deployment is still separate.

## Native builder record — candidate 284bd26

Clean file sections now survive redaction elsewhere in a verified ancestor patch. Capture still proves exact Git endpoints, and custody now reselects the entire section by path and byte range before review and at ingestion. Selected redactions, ambiguous sections and incomplete coverage remain gaps. Typecheck and 341 tests across the seven existing focused suites pass.

This revision applies annotation 167 only, as directed by annotation 181. The candidate is the uncommitted tree on `standing-orders/revise-workspace5-evidence-handoffs-from-15-annotations-`, based on unchanged HEAD `f440f198a3d7c291b2955ac1c277a09cbfd61dc7`. The inherited base `3725ce1c27700774c2130939597980a1af6bf4af` is historical. Changes are limited to `src/review-context.ts`, its existing test suite, and this assessment. No live database/evidence, history, approvals, provider permissions, artifact caps or verifier configuration changed.

The exact source/test diff checked is 17,863 bytes, SHA-256 `476987f419f7acf22f8cb9b08f733afc0e544677ba848cbe052c4d8d88acb19f`. Reproduce it with `git diff --binary --full-index --no-ext-diff --no-textconv --no-color f440f198a3d7c291b2955ac1c277a09cbfd61dc7 -- src/`. This fingerprint excludes this assessment and submission protocol files.

Checks on this candidate:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0. |
| `npx vitest run src/review-context.test.ts` | Exit 0; 49 tests passed. |
| `npx vitest run src/review-context-e2e.test.ts src/reviewer.test.ts src/provider.test.ts src/structured-output.test.ts src/proof.test.ts src/evidence.test.ts` | Exit 0; 6 suites, 292 tests passed. |
| `git diff --check` | Exit 0. |

Before the repair, `npx vitest run src/review-context.test.ts -t 'large unchanged files and a small CSS revision|a .* in a redacted artifact'` exited 1: two regressions failed and three rejection cases passed. It reproduced both the missing clean sections and custody accepting a self-consistent fragment instead of the whole path section. Both now pass in the 49-test suite. Test fixtures use the native line scanner/redactor for stored patches and real Git/SQLite state. Vitest's unchanged global setup ran its required build; the builder did not run the full verifier.

Acceptance evidence:

- **integrity:** The existing intact/tampered/missing/failed/changed-scope shortened-log cases pass unchanged. Stored-byte hashes, capture completeness, exact scope, reviewer lineage and ancestry remain authoritative. The clean-section repair does not alter `usableReviewInput`. A new redacted-source case changes a clean patch line during reviewer execution; ingestion refuses atomically and saves no judgement.
- **context:** Large guard/store files retain exact unchanged blob identity. A small CSS revision includes both the source and revision sections, even when both artifacts redact `src/mate.test.ts`. Clean sections before and after that file survive; multibyte context verifies UTF-8 byte offsets. The selected redacted file remains absent with a named gap. Duplicated sections, hidden path headers and wrong endpoint hashes are refused. Custody independently reselects the whole path section, rejecting hashed fragments, another file's exact range and changed offsets. Existing uncovered/reverted changes, successive revisions, binary and item/aggregate-budget regressions pass. Partial items retain gap coverage, and prior support never creates a current judgement.
- **handoff:** The existing shared generation/parser limits and prompts are unchanged. Focused provider, reviewer and structured-output suites pass for comment/criterion bounds, ASCII and Unicode notes, strict rejection without truncation, read-only isolation and bounded corrections. Both subscription-provider fixtures now complete ingestion with a clean partial section from a redacted ancestor artifact, preserving `cannot-tell` and gap coverage.
- **gate:** Typecheck and focused regressions pass for the fingerprint above. Only the machine's unchanged approved full verifier for its committed candidate remains pending verification. No previous candidate's gate result is claimed for this revision.

Compatibility and intentional limits:

- No inventory shape changed. The current reader accepts supported complete-file schema 1 and schema 2 inventories. Schema-1-only readers still refuse schema 2; the previous schema 2 custody implementation refuses these newly usable redacted-source sections. Historical evidence is not rewritten.
- Partial fallback still accepts only plain same-path text sections with supported paths and index hashes of at least seven hexadecimal digits matching both exact tree blobs. Selected secret-shaped/redacted lines, duplicate or hidden path headers, quoted/unsupported paths, renames/copies, mode-only sections without an index header, binary/non-UTF-8 artifacts, failed/missing captures, truncated artifacts and uncovered intervals remain gaps. Redaction outside an unambiguous selected section no longer disqualifies it; hidden lines are never reconstructed.
- SHA-256 verification covers the whole stored artifact. The segment retains its artifact ID/hash, source run, exact base/head and original stored byte range. Ingestion rechecks source bindings, capture eligibility and whole-section equality. Content is explicitly partial, never represented as a complete file.
- Bounds remain 48 KiB per file/patch chain, 192 KiB aggregate, 24 items, 200 candidate paths and 16 ancestors. Over-budget chains are dropped whole. Proven unchanged identity can survive a content gap, but cannot claim complete coverage or automatically uphold a criterion.

The real replay motivating this revision is operator-reported: run 1565 lost clean store/serve sections because artifact 549 redacted only `src/mate.test.ts`. The fixture reproduces that pattern and proves the repaired behavior; it is not a replay of artifact 549. The supplied review notes also report that root restored status-code context and shortened-log bindings, that Opus 1578 upheld all four criteria on its first response, and that the earlier candidate's native full gate passed (167 files, 2,917 passed, 23 skipped). Those are historical reports, not checks performed by this builder or results for this candidate.

Root owns the production read-only replay, native Opus review with this repair, and subsequent real revision handoff. This builder did not access production evidence, replay runs 1565/1570/1574/1575, or establish live provider schema compliance. No UI changed or device behavior was claimed.
