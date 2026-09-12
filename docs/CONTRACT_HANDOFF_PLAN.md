# Preserve the task contract through every handoff

Assessed 2026-09-12 UTC. All three bounded tasks ran through Standing Orders
and are integrated on `codex/contract-handoffs`, with additional operator-led
hardening. Both real-provider handoff journeys pass with zero rescue
interventions, and the broader release pilot passed 20/20. See the
[integration evidence](assessments/CONTRACT_HANDOFF_RESULT.md).
The [Agor assessment](assessments/AGOR_CONTEXT.md) keeps the implementation
focused on existing task, run, artifact, and approval boundaries.


## Observed problem this milestone addresses

Bounded review retries ran through Standing Orders itself: planning, an approved
build, independent review, an annotated revision, a continuation, and final
review. The resulting implementation is tested, but completing that journey
still required the supervising operator to repair lost context and terms.
This milestone completes the same kind of journey without those interventions.

Three observed gaps make this more valuable than adding another orchestrator
feature now:

| Handoff | Evidence before this milestone | Consequence |
| --- | --- | --- |
| Filed request → planner | `plannerBrief` in `src/planner.ts` receives the title and prior decision answers, without the filed goal, exclusions, or rubric. | The dogfood plans omitted the requested UI evidence; the operator restored it before approval. |
| Result → revision | Annotation and CI-repair creation in `src/serve.ts` copy selected scope fields; `Store.sealRevision` accepts no risk or quality fields. New scope resolution can fall back to task/installation defaults. | The high-risk revision became routine until the operator corrected it. Other execution terms need an explicit inheritance audit. |
| Revision → reviewer | `src/reviewer.ts` supplies the source run's sealed patch, rubric, proof, check log, and screenshots, without inherited source context or prior review provenance. | Reviewer 1518 could not judge three criteria implemented outside the revision patch, although reviewer 1514 had upheld them on the base. |

The final review recorded six upheld criteria, three `cannot-tell`, and zero
refuted. Separate tests and a code-identity comparison support inherited
coverage; they do not change those recorded judgements. A verified machine
receipt alone is not evidence that the whole request-to-review journey was
unattended.

## Deliver in three bounded implementation tasks

### 1. Preserve the filed request during planning

**Implemented and integrated.** `src/planner-source.ts` records the filed
request; `finalizePlanFenced` verifies its bytes and current identity atomically.
Explicit amendments and mechanical changes appear at approval. The whole source
has a 128 KiB artifact limit; lossless prompt fencing preserves its JSON value.
Earlier decision answers are limited to five with a visible refusal on overflow.
`src/planner-source.test.ts`, `src/claim.test.ts`,
`src/planner.test.ts`, and the migration tests cover these boundaries.


Use the existing scope, plan artifact, and approval transaction. Capture the
actual filed input for each planner attempt: goal, exclusions, touches, exact
criterion ids/statements/evidence needs, execution terms, revision brief when
present, and prior operator decisions. Distinguish filed intent from approved
authority. Preserve bounded, explicitly quoted input and existing prompt/data
boundaries; oversized input must produce a useful refusal, not disappear.

A planner may propose implementation detail or an explicit contract amendment.
It must not silently replace existing requirements with title-derived guesses.
Approval should show any changed requirements and continue binding the exact
accepted terms. Recheck the source digest before ingesting a plan so a concurrent
edit cannot be replaced by an old planner response. Corrections and resumes
must retain the same input identity.

Acceptance: a short title with a detailed filed rubric retains every UI,
exclusion, and evidence requirement through plan and approval; an explicit
amendment is visible; stale source terms refuse; malformed-output correction
does not drop context. Include empty/legacy input and byte-limit cases.

### 2. Preserve revision terms with explicit approval semantics

**Implemented and integrated.** The field-by-field policy and its coverage
are recorded in [REVISION_TERMS.md](REVISION_TERMS.md). Source custody, exact
annotation batches, a real two-process seal race, and bounded repair ancestry
have additional integration regressions.


Define one field-by-field policy at the existing revision creation boundary,
used by annotation revisions, CI repair, and semantic repair. Bind the source
task, source run, source scope digest, and brief artifact together. Reject a
mismatched source before creating a child or consuming comments.

Audit goal, exclusions, touches, rubric, declared risk, quality, permission
mode, budget, phase routes, fallback chain, plan ancestry, publication rights,
and repair lineage. Keep declared requirements and constraints. Explicitly
state which execution choices remain proposed, must be re-resolved, or need
fresh approval. A child must never inherit an approval stamp or new publishing
authority merely because its parent had one. Existing standing-policy coverage
may approve only through its normal checks. Global defaults must not silently
downgrade a high-risk or strict revision, widen permission, or reset a recovery
allowance.

Acceptance: high-risk/strict parents retain those terms across all three draft
paths despite changed installation defaults; budgets and permissions follow the
documented policy; source mismatch and concurrent duplicate creation refuse
atomically; restart preserves lineage and remaining bounds. Task, chat, and
approval views must display the actual resulting terms.

### 3. Make inherited review coverage verifiable

**Implemented and integrated.** `src/review-context.ts` seals bounded source
context, verified ancestor evidence, and prior review provenance. New revisions
start at their verified source head. Successive revisions retain source paths;
coverage and citations are criterion-specific, and evidence custody is rechecked
when accepting a review. Schema 51 includes both plan-contract and review-context
artifacts in one migration. See [the final evidence](assessments/CONTRACT_HANDOFF_RESULT.md).


Extend the existing sealed evidence inventory with bounded context from the
exact source and accepted head. Prefer criterion-relevant source files and
verified ancestor artifacts; bind every item to its commit, path, digest, and
source run. Reuse only review provenance that matches both the criterion and
the relevant unchanged code. An earlier positive judgement is context, not an
automatic judgement for a later revision.

Keep reviewers restricted to verified artifacts. Do not read a mutable checkout
as if it were sealed evidence. Missing, truncated, stale, tampered, or over-limit
context must yield a visible coverage gap. Required independent coverage cannot
be labeled satisfied by `cannot-tell`; preserve default/strict semantics and
make any policy change explicit. Keep the existing finite retry bounds and
immutable earlier attempts.

Acceptance: a small revision to a larger feature can assess inherited criteria
from verified context; changed criteria, changed relevant code, stale ancestry,
and tampered artifacts invalidate inherited support; omitted context remains
visible on task/result/chat/CLI. Both supported subscription reviewers receive
the same evidence content and can cite its provenance.

## Completion gate

Use Standing Orders for each bounded task, then run one integrated journey with
each supported subscription provider: file detailed intent → plan → ordinary
approval → build → review → request a scoped revision → approve → final review.
Include a real UI criterion with desktop and phone screenshots, strict/high-risk
terms, and an inherited criterion outside the revision diff. Necessary user
approval is part of the journey; manual scope repair, direct worktree patching,
or database edits are interventions and must be counted as such.

Require complete contract retention, correct approval invalidation, truthful
criterion coverage, preserved failed attempts, no duplicate dispatch, and no
out-of-band rescue. Pair these journeys with deterministic stale-source,
interruption, concurrency, and evidence-tampering regressions. Run the full
project gate on the integrated runtime; repeat the larger release pilot after
the new journey passes, not after every small change.

## Separate follow-ups and feature sequencing

- Completed: exact 43-character base64url credentials beginning with `--` now
  parse through the CLI without weakening ordinary missing-value checks.
- Completed: the bounded Codex JSONL overflow classifier recognizes equivalent
  telemetry independent of object-key order, while malformed or unknown records
  still refuse. This is not claimed to explain the earlier planner failure.
- Reproduce the observed concurrent SQLite contention before choosing a fix.
  Do not claim that the aggressive reconciliation interval caused it.
- Physical Windows closure/reboot and actual account-exhaustion fallback remain
  explicit certification gaps in [CERTIFICATION.md](CERTIFICATION.md).
- The selected desktop/setup/model-discovery/calendar integration was brought
  forward at the operator's request; see [CONTROL_APP_INTEGRATION.md](CONTROL_APP_INTEGRATION.md).
  Per-task stop/resume and Telegram conversation/media remain distinct forward
  ports over current engines. Project memory follows trustworthy provenance.

## Earlier branch integration assessment

Fetching origin and inspecting all refs found 45 local branches. This merge
fast-forwarded main from `984fb49` to `b96d53e`, integrating 25 commits including
the reliability and routing stack. Forty-two other local branch tips are now
ancestors of main. All 39 checked-out worktrees had no tracked edits at audit.

Integration validation passed typecheck, build, and all 121 test files / 2,385
tests, with 12 existing skips, on the second full run. The first run had one
planner setup assertion failure; the focused rerun passed all 22 planner tests.
The failure and the separately reproduced token issue above remain recorded.
The compiled runtime matches the existing six-stage crash-canary certificate
hash `161cf81e70fde5e3757e01e88842d3690e24c226766e8d7c868de62279f565cb`;
the merge did not rerun the real-provider release pilot.

| Remaining separate branch | Disposition |
| --- | --- |
| `standing-orders/explainable-risk-aware-phase-routing-v1` (`c701b7f`) | Superseded by the integrated revision `1d0fc90`, whose commit records applying all seven comments to that implementation, and subsequent authority fixes. Do not merge the earlier implementation again. |
| `standing-orders/nightly-deps-20260812-1534` (`f2f0985`) | Only adds `docs/DEPS.md`. Its upstream claims were explicitly not checked against a registry. Retain as historical notes; regenerate from current manifests and primary sources if dependency review becomes a priority. |
| `origin/codex/control-app` (`15a1d9c`) | Assessed and selectively integrated over current main. Native shell, setup, provider/model discovery, and calendar schedules are adapted; superseded engines are omitted. See [the full disposition and remaining forward ports](CONTROL_APP_INTEGRATION.md). |

No branches or worktrees were deleted. Main through `68ff7eb` has been pushed to GitHub. Upgrading the live
schema-v49 controller remains a separate delivery step. The live
controller remains on its stable reliability worktree.
