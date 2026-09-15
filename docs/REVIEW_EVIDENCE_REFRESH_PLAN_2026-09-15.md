# Refresh missing review evidence without rebuilding

The sealed-file handoff prerequisite was deployed on September 15 at
21:56 UTC: candidate `6b79fd6ac00d2de0e2643047aa22abe021e70cb8`, schema 60.
This brief is the durable input for `review-evidence-refresh-20260915`.

## Outcome

An authenticated user can ask for a fresh review of the same finished candidate
when the earlier review could not see enough evidence. The current code and its
passing verification stay unchanged. Both reviews remain visible in history.

This completes the handoff-size repair for Telegram run 1627; it does not accept
its current `cannot-tell` result or automatically rerun reviews until one passes.

## Smallest implementation

1. Extend the existing review request, admission and ingestion path with an
   explicit evidence-refresh request. Ordinary review/retry rules remain intact.
   Authenticate the operator and recheck project access, current scope, route,
   runner custody and existing spending authority. Do not add a scheduler.
2. Bind the request to the source run, exact candidate, scope/route digests,
   terminal diff, proof, original passing verification command and receipt, and
   ancestry. Compare those bindings again at admission, before provider calls,
   and atomically at ingestion. Changed or missing gate evidence refuses reuse.
3. Derive fresh context from exact Git objects using the new sealed-file handoff.
   Store it under the new request/reviewer, not as a second ambiguous artifact
   on the old source run. Capture and delivery remain secret-filtered and
   read-only; no checkout substitution or provider permission expansion.
4. Append new judgements with their own context binding. Preserve the old review,
   old evidence, and `cannot-tell`. Failed refreshes cannot replace a valid
   current review. Duplicate requests are idempotent; concurrent requests admit
   only one active review. Keep normal retry policy, no automatic verdict hunting.
5. Expose one clear **Refresh review** action when evidence was missing, through
   the existing authenticated CLI, shared chat action and result control. Show
   the reason and precise effect before confirmation; no extra order form.

## Constraints to inspect before editing

- `Store.rootReviewAdmissionProblem`, `requestReview`, `admitReview`, and
  `admitRun` all enforce the successful-root rule. Extend the specific authorized
  refresh case consistently; do not simply delete the rule.
- `review()` and `Store.ingestReview` require singular source context artifacts.
  Preserve legacy behavior and add a request-specific binding for the new path.
- Result summaries and criterion-history queries must choose the latest valid
  completed review deterministically without erasing historical rows.
- Deploy the verified handoff runtime before real refresh use. Do not update
  its code while an agent is running. Required input must be committed into the
  next task branch before first dispatch.
- Coordinate schema versions with the unshipped Telegram schema-61 change.
  Never produce two incompatible formats both labelled 61. Prefer existing
  durable request metadata where appropriate, not a parallel authority ledger.

## Lean acceptance

Reuse existing review/store/CLI/chat tests for one successful unchanged-candidate
refresh, duplicate/concurrent requests, and rejection after head/scope/route,
gate/context or custody changes. Confirm no builder or full verifier executes
for an evidence-only request. Preserve old review bytes and newly bound receipts.
For any UI change, use one desktop and one phone journey with a clear pending,
success and refusal state. One native full gate for the new harness candidate.

Final real acceptance: request the supported refresh for run 1627 at
`3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`, let the independent approved
reviewer inspect the actual restart/rate-limit tests, and read its judgements.
Only then qualify the Telegram candidate for deployment. The prior root
availability diagnostic is not a substitute for that independent review.
