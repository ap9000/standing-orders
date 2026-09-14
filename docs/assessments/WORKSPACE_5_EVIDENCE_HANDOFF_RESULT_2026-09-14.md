# Package 5 evidence and reviewer handoffs

Repaired prior-review bindings for intact shortened check logs, added bounded partial ancestor patches for large files, and aligned reviewer generation with native note and array limits. Typecheck and 336 tests across seven affected suites pass. The unchanged full verifier remains the native machine gate's job.

The candidate is the uncommitted working tree on `standing-orders/workspace5-evidence-handoffs`, based on unchanged HEAD `3725ce1c27700774c2130939597980a1af6bf4af`. No commit, history change, network write, migration, approval rewrite, permission change, or artifact-cap increase was made.

The exact source/test diff checked is 74,616 bytes, SHA-256 `a99f688936c1f356c447ac51e9ed3dcedbe0ba969fa1dfa3a860b81529f4ab6f`. Reproduce that input with `git diff --binary --full-index --no-ext-diff --no-textconv --no-color 3725ce1c27700774c2130939597980a1af6bf4af -- src/`. This fingerprint excludes this assessment and the submission protocol files.

Checks on that source/test candidate:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0. |
| `npx vitest run src/review-context.test.ts src/review-context-e2e.test.ts src/reviewer.test.ts src/provider.test.ts src/structured-output.test.ts src/proof.test.ts src/evidence.test.ts` | Exit 0; 7 suites, 336 tests passed in 19.43 seconds. |
| `git diff --check` | Exit 0. |

Vitest's existing global setup ran `npm run build` when source files changed. No full-suite command or approved final verifier was run by this builder. Earlier focused runs exposed two fixture expectation changes and a missing redaction gap label; those were resolved before the final passing run. A final regression also verifies that changing one criterion does not suppress useful partial evidence for another.

Acceptance evidence:

- **integrity:** `readVerifiedArtifact` continues to prove stored bytes, independently of completeness or capture success. Historical review eligibility admits an intact shortened check log, while requiring complete non-log inputs and refusing failed captures. Artifact IDs, hashes, exact scope and evidence requirements, reviewer lineage, ancestry, and later custody checks still bind the review. Regressions cover intact, same-size tampered, missing and failed logs, scope changes, and evidence/lineage drift before spending and during ingestion.
- **context:** Schema 2 records exact Git blob and mode equality independently of file capture. Oversized files can carry complete per-path diff sections copied from verified ancestor artifacts, with run, base/head, artifact hash, and byte-range provenance. The chain includes each changed sealed interval through the current revision; unequal blobs between intervals cause an uncovered-change gap. Tests cover large unchanged guard/store files, small CSS edits in a large serve file, two successive CSS revisions, exact range tampering, binaries, redactions, and item/aggregate budgets. Partial patches always retain `gap` coverage. Eligible prior support never supplies a current judgement or satisfies strict semantic coverage.
- **handoff:** Shared limits keep the native parser at 40 comments, 12 criterion judgements and 500 UTF-16 units per note. Claude's schema caps both note fields at 250 Unicode code points, conservatively fitting even all-astral text within the native limit; initial and correction prompts request one concise finding with evidence. Tests cover ASCII, astral characters, combining marks, ZWJ sequences, and the reported over-limit lengths. Oversized conclusions remain intact and are rejected; normalization does not shorten them. Existing read-only provider isolation, strict whole-response parsing, custody, atomic ingestion and bounded same-session corrections pass their regressions.
- **gate:** Builder checks pass for the fingerprint above. The committed candidate and its unchanged approved full verifier remain pending verification by the machine; this assessment does not claim that gate has passed.

Compatibility and intentional limits:

- The current reader accepts complete-file schema 1 inventories and schema 2 inventories. Older schema-1-only readers refuse schema 2. Unknown schemas, unsupported partial shapes, unbound ranges, and patches represented as full files fail closed. Historical artifacts are not rewritten.
- Partial fallback currently supports plain same-path text diff sections with ASCII letters, digits, underscores, dots, slashes and hyphens in paths, and Git index hashes of at least seven hex digits. Quoted or other path shapes, renames/copies, mode-only sections without an index header, binary/non-UTF-8 content, redacted terminal patches, missing/failed captures, and incomplete ancestor intervals remain explicit gaps. Whole files still use the existing literal-path reader.
- Source diff-stat inventories must have the supported schema, exact endpoints and a complete consistent path list. Unknown or malformed shapes cannot establish source coverage.
- Existing limits remain 48 KiB per file or patch chain, 192 KiB aggregate content, 24 content items, 200 candidate paths and 16 bound ancestors. A chain that exceeds a budget is omitted as a whole with a named gap; no middle segment is silently dropped. Proven identity can survive a content-budget gap, but does not claim full-file coverage.
- The conservative generation bound is stricter than the parser for ASCII notes. Dynamic signed IDs, patch-local paths, provenance and semantic validity remain the native parser's authority; the schema is not an acceptance bypass.

Remaining real-run validation belongs to root: inspect this output, run native Opus review using the repaired code, and exercise a subsequent real revision handoff. This builder used real Git/SQLite handoff fixtures and stubbed provider responses; it did not replay production runs 1570, 1574 or 1575 or establish live provider schema compliance. Those outcomes are not claimed solved. No UI rendering changed or device behavior was claimed.
