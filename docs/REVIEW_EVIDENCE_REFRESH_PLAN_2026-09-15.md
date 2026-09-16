# Complete evidence for the first review

## Current direction

The signed scope c332cc9a443c8079f0fed12fa29a0e36 and decision 5 replace the
manual review refresh plan. Assemble and validate criterion-relevant evidence
before the first reviewer. Use existing sealed full files and range reads in
that same session. There is no manual Refresh review action or second successful
review path. Keep deployed schema 60 compatibility; no migration is needed.

## Implementation and acceptance

- Preflight sealed evidence and exact candidate bindings before substantive
  review. Missing or tampered required inputs remain explicit failures.
- Retain a machine-owned gate receipt that binds the candidate, approved command,
  exit status and retained log bytes independently of shortened verbose output.
  Legacy null capture metadata alone is not a failure. Never reconstruct a
  missing receipt from agent claims or invent missing historical output.
- Deliver complete relevant files through the existing sealed-file handoff and
  same-session range reads. Unrelated secret-redacted fixtures must not hide
  complete criterion-relevant source/tests; relevant redaction remains a gap.
- Bound evidence-delivery retries within the same review session. Recheck
  authority, custody and input bindings. Do not rebuild or repeat unchanged
  verification. Never retry a substantive negative verdict for approval.
- Remove only unfinished manual refresh CLI, chat, result and schema-62 work.
  Preserve useful drafts, historical evidence and ordinary retry safeguards.
- Add focused regressions in existing suites, including run-1627-shaped legacy
  proof metadata and a 14,572-byte retained log from 100,541 bytes. Standing
  Orders runs the unchanged approved native final gate and Opus review.

No Telegram import or deployment occurs here. A later combined candidate gets
its normal first review. Genuine failed tests, authority drift, tampering and
irrecoverable missing evidence stay visible.

## Historical decisions

The earlier plan proposed a manual Refresh review action and decision 4 chose a
60-to-62 migration that refused 61/-61. Decision 5 explicitly retired that
requirement in favor of the latest signed scope. These are historical decisions,
not current implementation requirements. The sealed-file prerequisite was
recorded as deployed at candidate 6b79fd6ac00d2de0e2643047aa22abe021e70cb8,
schema 60; that record is not proof that any old candidate now passes review.

## Implemented behavior and evidence

The builder seals full files for ordinary builds as well as revisions. Changed
files omitted from proof path hints are also delivered. The first reviewer gets
a compact manifest, full sealed files and bounded same-session range reads.
Preflight refuses ambiguous, truncated, failed or tampered sealed inputs, a
malformed proof, drifted custody and a first-review inventory whose own
candidate head the machine could not validate. A truthful gap is not a
refusal: a build that wrote no proof, an oversized path inventory or a stale
ancestor stays a named per-criterion gap the reviewer judges, exactly as the
v51 revision contract already did. The review-only and explicit-retry tick
journeys (build without a proof, then first review) cover that distinction;
an unrelated redacted fixture does not prevent inspecting clean source and
tests.

New verification uses a separate machine receipt in the existing schema-60
artifact store. It records the exact candidate, approved grant, actual result
and retained log hash/size. Legacy single-attempt headers are read only after
checking the original grant, candidate inventory and retained log. An absent or
ambiguous header cannot be reconstructed; historical multi-attempt logs without
a sufficient receipt are refused. Receipt/authority changes stop delivery and
final ingestion. Secret-shaped receipt content is filtered before storage.

Delivery recovery allows at most two attempts in the original reviewer session,
within the existing byte/request bounds. Only evidence-only requests and failed
transport with no substantive reply qualify. Changed session, route, custody,
unknown file/hash, tampering and exhaustion stop. Successful negative reviews
remain final; the one-successful-root-review invariant stays intact.

Revision after build 1635's native gate (3103 passed, 2 failed): both
failures were the review-only success and explicit-retry tick journeys, whose
builder writes no proof. The blanket "source or ancestry unverified" refusal
turned that visible gap into a refused review; it is narrowed as described
above, the tick journey asserts the sealed gap, and a focused test refuses an
inventory whose candidate ancestry git could not prove.

Revision after build 1638 (comment 381): the Claude review session failed
before any review turn. The reply schema sent with `--json-schema` expressed
"a review or an evidence read request" as a root `anyOf`; the API refuses
that before a model turn (`400 tools.2.custom.input_schema.type: Field
required`), and a root `type` beside the union is refused too, because
top-level unions are unsupported. The schema is now one flat object whose
properties are the review fields plus `readEvidence`, with only `version`
required. The machine parsers keep the strictness the schema no longer can:
`isEvidenceOnlyReply`/`evidenceRequest` accept exactly
`{"version":1,"readEvidence":{...}}`; `parseReview` refuses any reply carrying
`readEvidence` beside review fields and still refuses a review missing
comments or a signed criterion. Isolation flags and the same-session read loop
are unchanged. Focused regressions: `src/provider.test.ts` (flat schema, no
combinators, mixed/incomplete replies), `src/reviewer.test.ts` (parser
refusal) and `src/review-context.test.ts` (read envelope exactness).
`src/fixtures/claude-review-schema-smoke.mjs` drives the real `claude` CLI
through dist's own review adapter in an empty temporary directory; its
2026-09-15 certificate against `claude-opus-5` is stored at
`docs/assessments/evidence/review-evidence-refresh/claude-review-schema-smoke-2026-09-15.json`:
the legacy root-union control was refused before a turn at zero cost, a fresh
session returned a parseable review, and one session returned an exact
evidence-only request and then, resumed with the served range, a parseable
review. No refresh UI, no schema change; the builder ran the focused suites
and typecheck only, not the full gate.

Revision after build 1641 (comment 389): c4 now has executable proof in the
existing suites instead of source-grep claims. `src/review-context.test.ts`
("retired refresh: after one successful first review, CLI, shared chat,
result, task, cockpit and work pages expose no manual Refresh review action
and the review stays final") completes a real first review on the schema-60
fixture and then, on that reviewed run, proves: the CLI has no refresh verb,
flag or help entry (`--refresh` is an unknown option, `task refresh-review`
is unknown, `task review` refuses with `already-reviewed`); chat has no
refresh action, control or tool wording and refuses a `refresh_review`
proposal, control or confirmed action; the `/r/<run>`, `/t/<task>`,
`/chat?task=&result=`, `/review?result=` and `/work` pages carry no refresh
control while the task and cockpit show the reviewed state with the disabled
"Reviewed" control; `POST /t/<task>/refresh-review` and `/r/<run>/refresh` are
404; `POST /t/<task>/retry-review` refuses because a successful review is
never retried; one reviewer run, no open request and all four judgements
remain. `src/migration-v50-review-retries.test.ts` ("fresh and reopened v60
preserves every historical review row and receipt, and no schema-62 refresh
object exists") scans the whole live `sqlite_master` and the review tables
for any refresh or second-review table, column, index or trigger, keeps
`SCHEMA_VERSION` 60 across reopen, and checks v50's
`one_successful_root_review_per_source` index still carries its exact
predicate. The real-model smoke script moved from `scripts/` to
`src/fixtures/claude-review-schema-smoke.mjs` so every changed path stays
within the approved `src` and `docs` paths; its behavior and its stored
certificate are unchanged.

Revision after build 1642 (comment 396) and the shared reliability steering:
build 1642 passed its tests and every review criterion, but its proof listed
both names of the smoke-script move (`scripts/claude-review-schema-smoke.mjs`
and `src/fixtures/claude-review-schema-smoke.mjs`). The machine seals the
diff-stat with `git diff --numstat -z` between the pinned base and its own
commit of the final tree, with git's rename detection, so a paired move is one
entry under its destination and the old name is a path the sealed diff never
had; `adjudicate` refuted the proof as an overclaim. That rule is correct and
unchanged. Prompt-only guidance is brittle (an earlier draft's unstaged
`diff --name-only HEAD` plus `ls-files --others` recipe reproduces the bug for
an uncommitted `mv`), so the fix is shared and machine-owned, in the existing
pre-review receipt-correction boundary rather than a new framework:

- The changed-list contract is stated in the builder brief: `changed` equals
  the sealed diff exactly — every path in `git diff --numstat <base> <commit>`
  once each and nothing else; a move git pairs is one path, its destination; a
  move git does not pair is a delete plus an add. The brief names the unstaged
  recipe as the trap and no longer offers a staging recipe of its own.
- `changedListProblems` (`src/proof.ts`) reviews a submitted `changed` against
  the sealed stat, whose rename provenance `sealedDiffStatFacts`
  (`src/builder.ts`) restates alongside its paths. A discrepancy the sealed
  input itself establishes — the old name of a paired rename, or a sealed path
  left out — is recoverable; a path the diff never had is an unexplained
  contradiction and never is. A missing, failed, tampered or truncated stat
  proves nothing either way and offers no correction.
- `correctProofReceipt` reads the sealed stat before the first review. For a
  recoverable list it resumes the same session with the precise error and the
  exact sealed inventory (the Goose FinalOutputTool shape) and accepts only a
  receipt whose `changed` is exactly that list; checks, screenshots and caveats
  stay byte-for-byte frozen, verdicts cannot be upgraded, and the committed
  checkout and custody are re-proved. An unexplained path is never handed back:
  no turn is spent, the list stays as submitted, and adjudication refutes it by
  name. The original submission and every correction attempt remain in the
  structured-output audit artifacts; the repair budget is the existing bounded
  one; the approved project check still runs exactly once afterwards.

Focused regressions in existing suites: `src/proof.test.ts` (the helper's
rename, omission, unexplained, exact and missing/uncaptured/truncated cases;
rule 4 on a parsed rename numstat), `src/builder.test.ts` (the brief carries
the contract on a first attempt and names the pinned base on a retry; a real
build whose sealed stat holds a rename — both names handed back and corrected
to the destination with one commit and one check, an omitted sealed path
handed back, four rejected corrections that leave the original refuted by
name, an unexplained path never handed back, a failed stat capture reading
short with no turn) and `src/review-context.test.ts` (real Git: a moved file,
an edit, a delete, an add and an unpaired rewrite sealed by
`captureTerminalDiff`, restated with the rename as provenance, and only the
diff-explained lists recoverable; a tampered stat reads as not captured).
Resumed-branch sealing from the pinned base is the existing run-1461 coverage
in `src/builder.test.ts`; the correction reads whatever that capture sealed.
No validation was loosened, no sealed receipt or verdict edited, no schema or
new framework added.

Validation on the uncommitted revision based on
`bc4d26b7633c4e6fd57e6ca8fc7190e1df5d6584`: `npm run typecheck` passed and the
focused builder, proof, proof-contract, evidence and review-context suites
passed. The native full gate and the Opus review remain Standing Orders' to run
once for the sealed candidate.

Validation on the uncommitted candidate based on
`924fd00731649f88e7450c75776c31474a150e81`:

- `npm run typecheck` passed.
- The five focused builder, reviewer, context, context end-to-end and schema-60
  migration suites passed: 345 tests. The real Git/tick journey covers build,
  first review, revision build and its first review, with full files supplied.
- Realistic isolated fixtures cover null proof capture metadata, 14,572 retained
  bytes from 100,541, complete source/test files, unrelated redaction, failed
  checks, missing receipts, tampering and bounded delivery recovery. Run 1627's
  actual sealed files were not supplied or changed; no old verdict was replaced.
- Simplicity pass: the draft added a Refresh review button, preview and chat/CLI
  confirmations. Those controls and schema-62 code are absent. Chromium at
  1440×900 and 390×844 opened the result and diff, submitted long feedback and
  created revisions requiring approval. Empty feedback kept submission disabled;
  keyboard tabs worked, horizontal overflow was absent and the phone primary
  button stayed on one line at 44px high. Tampered check-log evidence remained
  visible. Screenshots are under `output/playwright/first-review/`.
  These are browser viewports, not physical phone/Safari testing.

Standing Orders must run the unchanged approved native final gate and Opus
review for the sealed candidate. Neither was run or represented as passed by the
builder. No deployment, Telegram import, live database edit or history rewrite
was performed.
