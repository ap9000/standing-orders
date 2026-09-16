# Fix review formatting at the right boundary

Apply and inspect prepared commit `1df4dedae274a54d6ba576715913e981872c99f8`
with `git cherry-pick` in this task worktree. It is a three-file correction
based on deployed `4bad388010be580d783a6bbd5e02ecebe25fce1e`, not the unaccepted
Telegram candidate. Keep this change small; do not redesign review or messaging.

## Reproduced failure

Telegram builder1663 passed its full machine gate. Reviewer1664 then failed
inside Claude StructuredOutput: an optional learning observation126characters
exceeded the provider schema's125-character cap, though native learning allows
500UTF8bytes. Earlier retries also hit real core notes over500UTF16units. The
previous note-only correction missed the optional learning fields.

## Desired ownership

- Claude's flat review schema remains a formatting floor, not text authority.
- Native parseReview owns exact rubric ids, core text bounds, patch paths,
  provenance and existing same-session correction. Never clip review text,
  change a judgement, invent evidence or accept partial criteria.
- Existing project-learning validation owns optional advice shape,500-byte
  reasons/observations/actions,300-byte paths/excerpts, sensitive-text checks
  and evidence. Invalid optional advice is recorded as invalid in its ledger;
  it must not change or block the core review.
- Preserve strict isolation, approval, signed criteria, custody and evidence
  checks. No limit changes, new framework, new timeouts, migrations or UI work.

## Acceptance

1. Transport no longer rejects native-valid review text or optional learning
   through duplicated text caps. Flat root and review isolation are preserved.
2. Existing native parsers still reject overlong core notes and invalid advice,
   keep contradicts/cannot-tell unchanged, and record invalid learning without
   failing an otherwise valid review.
3. Existing tests cover126/500ASCII and astral boundaries, optional invalid
   metadata, and real learning-ledger ingestion. No skipped/deleted tests.

## Verification already performed by the operator

Prepared patch: typecheck and208tests passed across provider, project-learning,
structured-output and reviewer suites. Native final gate remains authoritative
for the task's exact final candidate; do not duplicate that full suite yourself.
Use typecheck and affected focused tests only if changing the prepared patch.

Real restricted Claude Fable transport canary returned success, session
`f1db4045-c72e-4d2d-8410-4ccd81c3d6b3`: exact126ASCII observation accepted,
core contradicts preserved, native learning accepted. This is synthetic schema
evidence, NOT a review verdict or live Telegram acceptance. Raw local capture:
`/tmp/standing-orders-format-canary-54TlCh/transport.jsonl`.
Do not rerun paid canaries or import this output as a review.

Builder: inspect the applied diff and finish the normal handoff. Cite actual
checks only. Reviewer: inspect changed sources/tests and native final gate;
do not rerun the full suite. Judge each signed criterion and keep optional
learning concise. Unaccepted Telegram delivery/replay defects remain outside
this task and must not be deployed with this repair.
