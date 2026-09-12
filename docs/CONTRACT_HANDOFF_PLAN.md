# Preserve the task contract through every handoff

Assessed 2026-09-12 UTC. All three bounded tasks ran through Standing Orders
and are integrated on `codex/contract-handoffs`, with additional operator-led
hardening. Main through `68ff7eb` is published. This feature is undergoing its
integrated validation; the real-provider completion gate is still pending.
The [Agor assessment](assessments/AGOR_CONTEXT.md) keeps the implementation
focused on existing task, run, artifact, and approval boundaries.


## Why this is next

Bounded review retries ran through Standing Orders itself: planning, an approved
build, independent review, an annotated revision, a continuation, and final
review. The resulting implementation is tested, but completing that journey
still required the supervising operator to repair lost context and terms.
The next milestone is completing that same journey without those interventions.

Three observed gaps make this more valuable than adding another orchestrator
feature now:

| Handoff | Evidence at the integrated revision | Consequence |
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

**Status (2026-09-11, branch `standing-orders/preserve-filed-planning-contract`,
integrated with additional boundary hardening):** implemented over the existing scope row, plan artifact, and
`finalizePlanFenced` transaction, with focused regressions in
`src/planner.test.ts` ("the filed contract reaches planning and survives
it"), `src/planner-source.test.ts`, and
`src/migration-v51-plan-contract.test.ts`. What landed: `src/planner-source.ts`
assembles the filed request per attempt (scope goal/exclusions/touches/rubric
with evidence kinds and `how`, execution terms, revision brief by verified
read, earlier answers) under one explicit cap (`PLANNER_SOURCE_LIMITS.bytes`,
128 KiB, equal to the artifact cap so a record is never truncated); an
oversized or unreadable request is refused in words before any lease, run, or
spend (`planner-source-oversized` / `planner-source-revision-brief`, and the
task page's `planner-source` diagnosis). The source is recorded on the
planner run as a `plan-contract` artifact (`planner-source.json`) before the
brief is composed, the run is stamped with the filed scope digest, and the
brief quotes the whole record as fenced JSON data with its source identity.
A drafted plan must reproduce the filed goal, outOfScope, touches, and
acceptance exactly or state an `amendment`; a silent change is a
`silent-amendment` malformed plan corrected in the same session (the frozen
authority values stay; the correction may only add the note), or a durable
incident when no session can be resumed. `finalizePlanFenced` re-derives the
source identity inside its transaction and refuses a stale draft
(`stale-source`: no strike, claim released, task still requested, the newer
scope untouched); on ingestion it writes `plan-contract.json` (filed terms,
proposed terms, amendment, mechanical changes). The task page, the approval
ceremony, `/next`, the chat approval card, `task show`, and the `task approve`
preview show "preserved exactly", the amendment with every addition/change/
removal and the planner's reason, or "no scope was filed"; the ordinary
approval still binds the scope row's digest — the filed digest when
preserved, the amended one otherwise. The six-stage crash canary passed
on the rebuilt runtime (`evidence/preserve-filed-planning-contract/crash-canary.json`,
runtime `f6eec868…`, source commit `68ff7eb` plus this branch's uncommitted
tree at certification). Not done here: revision-term inheritance (task 2),
inherited review context (task 3), and the integrated request-to-review
journey with a real provider.

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

*Implemented 2026-09-11 on `standing-orders/preserve-revision-contract-terms`;
the policy and its coverage are recorded in [REVISION_TERMS.md](REVISION_TERMS.md).
All three tasks are integrated; final certification remains open.*

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

*Implemented 2026-09-12 (schema v51, `src/review-context.ts`; see
[PROGRESS.md](PROGRESS.md)). Delivered against this baseline alone: sealed
context from git objects at the exact head, verified ancestor artifacts,
prior review as proved context, per-criterion coverage on the shared matrix,
identical evidence for both subscription reviewers, provenance-citing
judgements, and the distinct semantic-coverage projection on task, run, chat,
and CLI. Integration now starts a new revision at its verified source head.
Successive revisions retain a bounded ancestor inventory, re-capturing relevant
files at the new head. Source evidence, review lineage, and criterion-specific
provenance are rechecked before spend and at atomic ingestion.*

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

- Close a small credential/CLI parsing defect before the larger milestone:
  valid 32-byte base64url tokens can begin with `--`, but `parseOperateArgs`
  rejects such a `--token` value. A synthetic credential authenticated in an
  in-memory store and was then refused by the CLI parser. The first merge gate
  also had an intermittent planner setup failure; the focused planner suite
  passed on rerun, but its original error payload was not retained, so the
  token issue is a plausible cause rather than an established diagnosis.
- Fix the reproduced JSONL overflow classifier in `src/exec.ts`, whose
  `leadingCodexCompletedItemType` depends on object-key order. Test equivalent
  events with different key orders and oversized command output. This is a
  bounded transport fix; it is not proven to explain planner 1511's failure.
- Reproduce the observed concurrent SQLite contention before choosing a fix.
  Do not claim that the aggressive reconciliation interval caused it.
- Physical Windows closure/reboot and actual account-exhaustion fallback remain
  explicit certification gaps in [CERTIFICATION.md](CERTIFICATION.md).
- The selected desktop/setup/model-discovery/calendar integration was brought
  forward at the operator's request; see [CONTROL_APP_INTEGRATION.md](CONTROL_APP_INTEGRATION.md).
  Per-task stop/resume and Telegram conversation/media remain distinct forward
  ports over current engines. Project memory follows trustworthy provenance.

## Branch integration assessment

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
