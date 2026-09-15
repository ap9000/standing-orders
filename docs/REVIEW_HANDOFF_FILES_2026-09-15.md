# Keep large review evidence available

## User request and reproduced problem

Remove the handoff size limits that keep blocking honest reviews. Do not just
increase a constant until the next file hits it. Keep a small prompt and let
reviewers read the complete relevant evidence in pieces, with immutable
identity and without repository, shell, network or credential access.

Telegram revision run 1627, candidate
`3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`, passed 3,084 tests and a focused
root reproduction of three delivery cases. Independent review 1628 upheld
c1/c2/c4 but could not assess c3: restart and rate-limit tests were outside the
revision patch, and the inherited test file was omitted for size. The source
files are ~62 KB (`telegram.test.ts`), ~51 KB (`telegram.ts`), and ~1.1 MB
(`store.ts`). The current limits are 48 KB per item, 192 KB combined content,
24 items, and 1 MB inline reviewer input. JSON escaping can add more overhead.
This is missing evidence, not a failing test. Do not waive the criterion.

## Starting point

Start from deployed c29b6a9, schema 60, not the unaccepted Telegram change.
This is a separate harness fix so it can safely repair review without deploying
the feature that review still cannot establish. This brief is committed before
first dispatch. Do not edit the live database or installed runtime.

## Intended change

- Separate evidence storage/availability from prompt size. Remove the small
  per-file and aggregate prompt caps as reasons to omit ordinary source/test
  files from review. Retain full relevant UTF-8 text as machine-sealed evidence
  addressed by exact candidate, literal path, Git blob and content hash. Keep
  a compact manifest with criterion associations and explicit real gaps.
- Reuse current evidence storage, review scratch and provider session. Materialize
  individual sealed files where the reviewer already has a read-only file tool;
  the prompt points to them and supports bounded reads by line/range. For inline
  providers, use a narrow machine-mediated request for a declared evidence item
  and range in the existing session, not general shell/repository/file access.
  A model's context window still exists; never inline unlimited text or silently
  send less evidence to one provider than another can access.
- Keep the implementation small. No vector database, retrieval service, new
  scheduler, agent framework, paid fallback or unrelated file refactor. An explicit
  generous resource ceiling against pathological input is okay; distinguish it
  from prompt delivery size, disclose it honestly, and handle it without truncation.
  The concrete 62 KB test file and 1.1 MB source file must both be available.
- Preserve literal-path restrictions, no-follow reads, UTF-8/binary handling,
  secret redaction, ancestry and exact-head bindings, tamper checks before/after
  review, citation validation and stale-evidence refusal. Do not mark partial or
  redacted evidence complete, copy an earlier verdict, widen provider permissions,
  enable shell/network, rewrite old evidence, or bypass approval/custody.
- Read legacy schema-1/2 contexts as before. New evidence format must be
  explicitly versioned and truthful; prefer no database schema migration.
- Support an explicit evidence-only re-review for a finished unchanged candidate
  through the existing review-request path if feasible within these files. Append
  fresh context/review receipts; never mutate the old sealed inputs or judgement.
  Prove the head and original passing gate still match. Do not rerun a builder or
  the full gate just to read omitted unchanged evidence. If that needs a separate
  authority change, document the exact smallest follow-up instead of bypassing it.

## Verification and handoff

Use existing review-context/reviewer/provider tests. Reproduce both above-old-cap
files, combined context above 192 KB, evidence beyond the initial prompt, complete
range access, and honest missing/secret/tampered/stale cases. Exercise the actual
Claude file-reading path and inline-provider request path with isolated fixtures.
No live provider or Telegram calls in builder tests. No new overlapping suite.

Typecheck and focused tests while coding. Leave the unchanged approved full
verification command to the native final gate once. Bind proof to precise relevant
files and test commands; avoid citing every source file for one check criterion.
Provide concise before/after evidence, compatibility notes, actual remaining
ceilings and a safe replay plan for run 1627. Do not claim deployed or live re-review.

## Implementation and evidence (2026-09-15)

Implemented from prepared base `1022eb65238f3e75202cd0b5f23f91eb0dc2a887`.
This changes the review harness; it does not deploy it or re-review run 1627.

### Storage and delivery

Before: a file over 48 KiB became a gap or a partial ancestor patch; content
above 192 KiB or the 24-item limit was omitted. Every provider was also refused
when the JSON-encoded text bundle exceeded 1 MiB.

After: schema 3 retains complete relevant UTF-8 files inside the existing sealed
`review-context` artifact. The exact candidate commit, literal path, Git blob,
stored-content SHA-256, source run, criterion associations, redaction and partial
coverage travel with each item. No database migration is needed. Schema 1 and 2
remain readable with their historical content bounds; historical artifacts are
not upgraded or overwritten.

At review time, `REVIEW-CONTEXT.json` is a compact, explicitly labelled
`review-context-manifest-v1` projection. Each item names a generated flat file,
`REVIEW-CONTEXT-ctx-N.txt`, containing exactly its sealed content. The manifest
hash describes that projection; review ingestion still binds the original
artifact ID and hash, not a replacement artifact. Both transports receive the
same declarations and have access to the same bytes.

Claude retains its restricted Read-only tool profile and can read those files
in line ranges. For long lines or shortened tool output it can request bytes.
Codex and OpenRouter use the same narrow JSON byte-range request channel, with
shell, unified execution, web search and MCP access still disabled by their
existing review profile. Each request supplies an exact declared name and hash,
UTF-8 byte offset and bounded length. The machine replies inside the original
provider session with content, actual byte count, next offset and EOF. It never
opens a model-supplied path. UTF-8 boundaries preserve complete reconstruction.
No new provider tool, shell, network access or provider fallback is introduced.

Each successful range preparation appends an immutable receipt on the reviewer
run identifying the request, supplied range and content hash. A receipt records
what was prepared for delivery, not proof that a provider inspected it. Usage
from resumed evidence turns accumulates on the existing run. Every turn uses
the existing invocation authority, route, stop and custody checks. Scratch files
and source context bindings are rechecked before delivery and after replies;
final ingestion retains its transactional evidence checks. A changed session,
head, ancestor, artifact or scratch file refuses the review. Missing, binary,
redacted, partial or over-ceiling evidence remains an explicit gap. A prior
judgement never becomes the current judgement automatically.

### Remaining resource ceilings

| Resource | Ceiling and behavior |
| --- | --- |
| Complete source item | 8 MiB UTF-8 storage, independent of prompt size; larger items remain named gaps, possibly with a verified partial ancestor patch |
| Combined stored content | 32 MiB; an item that would cross it is an explicit aggregate gap, never a truncated complete file |
| Items / candidate paths | 200 / 200, in deterministic relevance order; excess paths are named gaps |
| Encoded context artifact | 200 MiB, allowing worst-case JSON escaping of the 32 MiB content budget plus metadata; capture never byte-truncates structured JSON |
| Initial encoded evidence delivery | 1 MiB; small core files share a 512 KiB content budget, and other contents remain available by range; an oversized declaration manifest refuses delivery explicitly |
| Byte-range response | Request JSON at most 2 KiB; response at most 64 KiB of content; UTF-8 boundaries can shorten a response, with the exact next offset returned; encoded JSON remains bounded |
| Range requests per review | 1,024 requests / 64 MiB returned content; exhaustion refuses acceptance and retains the attempt history |
| Claude native Read | Prompt requests at most 200 lines per read; this is provider-tool policy, not a new OS enforcement boundary; byte requests handle long lines |
| Ancestry / prior review context | 16 ancestor bindings / 48 prior review rows; partial patch chains retain their 48 KiB bound and explicit partial status |
| Other evidence | Existing terminal diff 256 KiB, diff-stat 32 KiB, proof 64 KiB, check log 64 KiB, screenshots 5 MiB each; a failed or truncated required structured input is still refused |

Model context windows, provider turn limits, existing idle timeouts, route
budgets and approval requirements still apply. Availability is not a claim that
all content fits one context window or was inspected. Storage and integrity
checks still read bounded artifacts in memory. No new agent time limit is added.
Read confinement continues to rely on the existing provider posture; this work
does not claim a stronger OS sandbox or live provider certification.

### Focused verification

`npm run typecheck` and
`npx vitest run src/review-context.test.ts src/review-context-e2e.test.ts src/reviewer.test.ts src/provider.test.ts src/invoke.test.ts`
exercise isolated repositories, stores and provider runners without live provider
or Telegram calls. Regressions cover approximately 62 KiB tests and 1.1 MiB
source, combined content above both former content ceilings, more than 24 items,
complete range reconstruction beyond the initial prompt, Unicode and escaped
long lines, Claude native files and structured byte requests, inline requests,
unchanged isolation flags, usage accumulation, legacy parsing, redaction, source
ancestry, citation checks, no-follow tamper checks, stale heads and session drift.
The native full verification command remains unchanged and belongs to the final
machine gate; it is not duplicated by the builder.

### Exact follow-up for run 1627 / candidate 3102879

The existing authority cannot append an evidence-only review after review 1628:
`Store.rootReviewAdmissionProblem` refuses a successful root with
`already-reviewed`, even if a criterion is `cannot-tell`. `review()` and
`Store.ingestReview` also require one unambiguous context artifact on the source
run. Tests preserve both refusals. Adding another artifact to run 1627 or
replacing its old context would violate those bindings. The recorded 3,084-test
pass is historical information from this brief, not a gate revalidated here.

The smallest supported follow-up is a separately approved extension of the
existing explicit review-request path, with these acceptance requirements:

1. An authenticated operator explicitly requests evidence-only re-review of
   run 1627 at full head `3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`.
   Bind the request to its original scope, approved route, source ancestry,
   terminal diff, proof, verification command and passing check-log receipt.
   Prove the candidate head and original passing gate still match before any
   capture or spend; missing or mismatched gate evidence refuses reuse.
2. Capture fresh schema-3 context from Git objects at that exact head into a
   new request-owned evidence receipt. Preserve every old artifact, review 1628
   and its c3 `cannot-tell` result. Introduce an explicit context binding on the
   new request/review instead of weakening the old source-run uniqueness rule.
3. Admit only the approved reviewer route under current runner custody and
   spending authority. No builder, verification rerun, automatic retry, feature
   acceptance, deployment or branch change is part of this operation. A changed
   candidate or unverifiable gate must use the normal approved verification
   path; it cannot be labelled unchanged evidence-only work.
4. Append fresh judgements and provenance bound to that new evidence receipt.
   Define which receipt the result view displays while retaining both histories;
   make the same action available through the existing authenticated CLI/chat
   review path and result control. Test rejection for changed head/scope/route,
   gate mismatch, stale context, duplicate requests and lost custody.

Until that authority change is approved and implemented, there is no supported
command that safely re-reviews run 1627 with new evidence. Do not manually edit
the live database, erase review 1628, rewrite its context or claim c3/deployment.
