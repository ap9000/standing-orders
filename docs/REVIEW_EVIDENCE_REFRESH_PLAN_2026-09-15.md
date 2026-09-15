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
Preflight checks artifact integrity, candidate/ancestry and required source
inputs. Per-criterion gaps remain visible; an unrelated redacted fixture does
not prevent inspecting clean source and tests.

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
