# Unattended work: completion plan

Updated 2026-09-11. This is the next implementation plan, not a claim that
these release gates already pass. It takes priority over new orchestration
features. Implementation proceeds one slice at a time through Standing Orders.

## The product promise

After initial project setup and a standing approval, a person can describe an
outcome and leave. Standing Orders plans, builds, checks, repairs when allowed,
and returns a reviewable result with evidence. App or terminal closure must not
interrupt the installed worker; after sleep or reboot, it reconciles and resumes.
The machine must be awake and online for local agents to work.

Every task has either a live owner, a scheduled next action, a clear external
decision, or a recorded terminal outcome. No indefinite unexplained queue,
invisible agent, unbounded repair chain, or “done” based only on a model's claim.
Missing credentials, exhausted subscriptions, impossible requirements, and
changes outside approved authority can still require a person. Preserve the
work, explain the issue, and give one useful action in those cases.

## What the recent runs exposed

The existing foundation includes a machine-wide worker, transactional claims,
execution profiles, standing approvals, structured-output correction, approved
dependency setup, sealed proof, review, and bounded repair. Extend those paths.

The September 11 run history still shows gaps:

- Run 1501 has no terminal outcome while a successor for the same task finished.
  Investigate and reconcile its process and claim ownership before changing it.
- Reviews 1498 and 1499 ended with `reviewer-stale-evidence`; useful work did not
  translate into a smoothly completed review.
- Independent checks found admission paths that accepted a changed current
  runner, and proof claiming success while citing failed checks. Multiple
  manually launched repair tasks were needed.
- An optional nested review failed because its selected Astra model required a
  newer Codex runtime. Main-role readiness did not cover this hidden dependency.
- Completed build rows can retain a last phase of `verifying-proof`. The public
  status must resolve terminal outcomes first; internal phase text is historical.

The latest repair produced commit `f3590d4` on its isolated branch. Its recorded
suite passed 114 files / 2,302 tests, with 12 skipped. During plan preparation,
run 1504 was still verifying proof. A passing builder suite and a commit are
useful evidence, but do not establish final acceptance or integration into main.
Main was still `917bc5b` when this plan was prepared.

## Execution status

- P0.0: run 1504 finished at 19:33 UTC with commit `f3590d4`. The worker's
  approved gate passed typecheck, all 2,302 tests (12 skipped), and build.
  A separate post-run check passed 86 focused custody/proof regressions.
  Criteria c1–c4 pass. Criterion c5 explicitly requires human acceptance, so
  its proof remains `short`; acceptance and integration have been requested.
  The original preflight command used consumed protocol input files: it is a
  recorded check, not a standalone command that can still be replayed without
  reconstructing those inputs. Durable preflight regression tests pass.
- P0.1a: task `reconcile-abandoned-run-records`, run 1505, completed through
  Standing Orders on Claude Opus at 20:06 UTC, commit `8bfbafa` based on
  `f3590d4`. All four automated criteria pass. The worker's gate passed
  typecheck, 2,309 tests (12 skipped), and build. An independent isolated
  public-CLI regression fails on the old runtime and passes on this commit:
  an abandoned attempt is interrupted, its completed successor and task stay
  unchanged, and a repeat reconcile does nothing. This is deterministic
  recovery coverage, not a real process-crash or Windows certification.
- The independent review of run 1505 did **not** complete: root 1506 and its
  same-session format-correction child 1507 failed during ingestion. A replay
  on a database backup identified a missing additive migration: existing
  `criterion_review` tables lack seven binding columns used by the writer.
  The reviewer mislabels this SQLite error as stale evidence. Its raw findings
  remain available; they are not counted as accepted review judgements.
- A bounded follow-up, `repair-existing-review-database-upgrade` (run 1508),
  finished at 20:25 UTC on Claude Opus, commit `3a1424a` based on `8bfbafa`.
  Its worker gate passed typecheck, 2,313 tests (12 skipped), and build.
  Independent replay using this runtime on a fresh backup of the real database
  successfully ingested the formerly failed
  correction and retained verified proof. The old runtime failed the identical
  replay with a missing-column error. Historical failed review outcomes were
  not rewritten in the live database.
- A fresh live review of 1508 through the repaired runtime completed at 20:30
  UTC: root 1509 and same-session correction 1510 both settled, with three
  saved `upholds` judgements. The missing-column failure is fixed. The reviewer
  asked whether new artifact columns need foreign keys; checking the complete
  fresh DDL confirmed both are also bare INTEGER there, so no parity gap exists.
- **The 1508 completion handoff is still refuted, not accepted.** Its proof
  restated every signed criterion with the prompt's display-only suffix
  `(requires evidence: check, changed-path)`. Preflight accepted that wording
  because it receives criterion IDs, while final adjudication compares exact
  statements. A positive review correctly does not erase the machine failure.
  The task nevertheless projects `done` / `Complete`: that inconsistency and
  bounded proof-only correction are the next slice, not another full rebuild.
- **Verification isolation remains a P0 gap.** The live database already had
  the additive columns by the 20:26 backup, before the planned fixed-runtime
  CLI step. The worker's full gate runs outside the provider child's database
  override. `cli.test.ts` invokes `graph --json` without an isolated store;
  `enrolledBackend()` opens the default database with migrations despite being
  described as read-only. An independent temporary-database witness reproduced
  that reporting command changing the old ten-column layout to seventeen.
  No historical review rows were present at backup time. A backup is retained
  under the local state directory's `backups/`; it is **not** a pre-upgrade
  backup. Fix verification/setup isolation before the next self-hosted gate.
- These isolated follow-ups proceed while the preceding human acceptance is
  outstanding; no implementation branch is being treated as merged or
  release-certified.
- Remaining P0.1 work (process fencing at every crash boundary, session/dirty
  work recovery, interrupted verification, and broader platform certification)
  is still pending. P0.1a does not claim the whole restart workstream is done.

## Prioritized implementation

### Immediate follow-ups from the first two slices

Run these bounded fixes before the remaining restart work or a release claim:

1. **Keep checks away from the live control plane.** Apply a dedicated database
   override to approved verification/setup children as well as provider children;
   make CLI tests isolate their state; use a non-migrating read path for reports.
   Test from a real-home sentinel fixture and prove schema, rows, and filesystem
   state stay unchanged across the full approved gate. The gate must not depend
   on the operator remembering an environment variable. Preserve native Windows
   environment/shell behavior. Do not introduce a new isolation framework.
2. **Finish good work without rebuilding it for a malformed receipt.** Pass the
   canonical signed rubric separately from presentation text. Preflight and
   adjudication must agree about IDs, exact statements, required evidence, and
   failed checks. Use one bounded same-session or proof-only correction through
   existing recovery machinery, preserving the commit, check receipt, and failed
   attempt. Never silently accept changed criteria or overwrite sealed evidence.
   Task/chat/CLI must say proof correction is needed, not simply Complete, while
   the verdict is refuted. Reproduce run 1508's suffix mistake in regression tests.

Then close the pending human acceptance/integration, reconcile audited orphaned
records through the normal recovery path, and continue P0.1. Do not add another
open-ended "fix everything" task or count operator diagnosis as unattended success.

### P0.0 — Close the current repair and establish the baseline

Finish the existing task before starting another broad reliability task.

- Check the exact commit against the reproduced admission and proof defects.
  Wrong task, runner, lease, route, or signed revision must refuse before
  consuming an attempt or creating a provider invocation.
- Confirm that preflight and final adjudication agree about failed cited checks,
  and that the stored proof uses durable evidence for the current revision.
- Settle the current run and its review through the ordinary workflow. Reconcile
  the older unfinished record only after proving which process owns the work.
- Preserve the useful fixes; integrate the accepted branch under the project's
  publication policy. Keep rejected attempts and reasons available.

Exit: one accepted revision, a truthful result receipt, no unexplained active
record for this task, and an idle subsequent dispatch. Any new finding gets a
specific regression and bounded repair, with remaining unrelated work recorded
separately. Do not recursively create fresh “close everything” tasks.

### P0.1 — Reliable ownership and restart recovery

Extend the current claim, process supervisor, reconciliation, and checkpoint
paths. Do not introduce a second scheduler.

- Persist the owning worker incarnation, run/session identity, approved terms,
  branch/revision, latest checkpoint, and pending transition before work starts.
  Reuse existing records; add fields only where a restart cannot reconstruct
  the necessary fact.
- Keep reconciliation running independently of long provider calls. On startup
  and at its normal cadence, reconcile unfinished attempts with actual process
  ownership, leases, and saved work.
- Resume a compatible session when safe. Otherwise fence the old owner and
  continue once from the preserved worktree with a concise recovery brief.
  Never allow a replacement to write while an old process can still write.
- Cover interruptions during planning, building, committing, checking, reviewing,
  and recording the result. Recover a finished commit or check before repeating
  it. Preserve dirty work instead of resetting the checkout.
- Terminal outcomes take precedence over old progress phases. Clear execution
  slots and custody consistently; keep the historical attempt readable.
- Handle database contention and disk exhaustion explicitly: a result that
  cannot be persisted is unfinished. Preserve artifacts for reconciliation.
  Pin runtime identity for an in-flight attempt; upgrades must not replace its
  executable or migrate its state underneath it.
- Exercise upgrades from real supported table layouts, including databases
  already stamped with the current version. Fresh-store tests alone missed
  the review-binding migration. Keep a backup before a live upgrade and
  preserve unbound historical evidence as unbound.
- Cancellation stops the entire owned process tree on each supported platform.
  For publishing, reconcile an uncertain remote response before retrying it;
  do not promise exactly-once external effects from a local transaction.

Exit: injected crashes at each boundary recover without duplicate builders,
lost changes, orphaned slots, or false completion. Detection occurs within two
configured reconciliation intervals while the worker is available; takeover
still requires the existing ownership fences. Physical Windows reboot remains
an explicit certification gate.

### P0.2 — Make every task ready for unattended execution

- Before admission, inspect the executable/version, supported model and options,
  known login state, project access, approved setup, and verification command for
  every required role. Recheck when a relevant runtime or configuration changes.
  Report unknown account availability honestly; local probes cannot guarantee
  that the next subscription request will succeed.
- Resolve planning, building, repair, and review to tested, pinned routes.
  Use the strongest compatible configured models for careful work. Model quality
  must not depend on an untracked nested “rescue” agent or local plugin.
- Keep the existing global permission default and per-task override. Explain
  that Full access removes provider permission prompts but does not grant new
  repositories, broader scope, credentials, publishing, or destructive authority.
- Let an operator approve a standing policy for designated projects: allowed
  work, setup, routes, repair budget, and delivery behavior. Tasks inside it
  can proceed without a fresh approval ceremony. Outside it, show one specific
  decision. A default change must not silently broaden existing approvals.
- Catch accidental human-only criteria during planning. For unattended code
  work, prefer executable checks and evidence-backed automated review. Preserve
  explicitly requested human judgement as a visible delivery gate.
- Use already-approved dependency setup automatically for the supported missing
  executable case. Broader package/system changes need an explicit policy;
  “fix dependencies” cannot authorize arbitrary installers or credentials.
- Keep provider fallback disabled for an unproven exhaustion classification.
  With a certified response and approved fallback route, continue once using
  the existing fallback machinery; never silently switch accounts or models.

Exit: an incompatible model/runtime is detected before the build consumes an
attempt; a ready task runs without permission prompts; an out-of-policy task
explains the precise missing approval. Test these as separate outcomes.

### P0.3 — One finite recovery policy

Put recovery decisions in the existing disposition/repair paths. Each recovery
records its failure class, parent attempt, evidence, remaining budget, and next
action. Counters survive restart, provider fallback, and child task creation.

Recommended defaults for newly approved unattended work:

| Failure | Automatic action | Bound |
| --- | --- | --- |
| Recognized transient transport/service fault | Retry with backoff and jitter | Three retries; honor a supplied retry time |
| Known subscription reset | Persist the wake time; resume after reset, or use certified approved fallback | No repeated agent polling; existing fallback attempt cap applies |
| Missing approved project executable | Run approved setup, then the exact check | One setup and one check retry |
| Invalid structured response | Return exact validation errors in the same resumable session | Existing two corrections |
| Missing/contradictory proof | Correct the evidence submission without weakening criteria | Two evidence-only corrections per unchanged revision |
| Stale review snapshot | Seal fresh inputs and issue a replacement review | One refresh per unchanged revision |
| Actual test or review failure | Repair the named findings within approved scope | Two code-repair attempts; stop after two without measurable progress |
| Worker/session interruption | Reconcile, fence, then resume or continue safely | Three consecutive recovery failures without progress, then a visible failure |
| Changed authority, unknown unsafe failure, missing login, or budget exhausted | Preserve work and report the exact next action | No blind retry |

All recovery paths share the root task's ledger. Moving a task into another
category must not reset its budget. A repeated failure fingerprint with no
changed evidence stops; a new label is not progress. Reviewers may identify
real defects but cannot expand the signed acceptance criteria. Enhancements
outside that scope become suggestions, not new mandatory repair work.

Keep long-running builds free of a default whole-task dollar or wall-clock cap
when using subscriptions. Retain bounded tool calls and recovery attempts.
Track transport liveness separately from useful progress: heartbeat/log chatter
alone does not justify an endless run, and a known long-running check is not
automatically a hung agent. Show suspected inactivity; apply the configured
no-progress policy only with enough evidence to classify it safely.

Exit: every supported failure either recovers under its budget or gives a
preserved, actionable result. Rebooting, spawning a child, or changing provider
cannot create an unlimited repair loop.

### P0.4 — Finish with trustworthy evidence, without repeated busywork

- Use one completion contract for builder preflight and final adjudication.
  Report all actionable validation errors together, early enough to correct them.
- Clearly separate agent-reported checks from checks Standing Orders actually
  ran. The worker executes only the operator-approved verification command,
  never arbitrary commands copied from a model's proof manifest.
- Bind the result to the approved criteria, exact revision/diff, verification
  configuration, and captured evidence. An invented criterion or failed cited
  check cannot satisfy an approved requirement.
- During development, run focused checks relevant to changed behavior. Before
  completion, run the approved project gate. Reuse its sealed receipt for review
  and display within that attempt; rerun after relevant code, configuration,
  environment, or evidence changes. Record why a rerun was needed.
- Make the prerequisites for required tests explicit. The first P0.1a suite
  skipped nine preflight tests because `dist/` did not exist yet, then repeated
  the suite after building. Required tests must not silently disappear on a
  fresh checkout. Allow the worker's post-build check to supply its own evidence
  after the agent exits; the builder should not need to run the whole gate
  merely to claim it has passed in a pre-exit proof manifest.
- Keep the existing lightweight/careful execution choices. Careful work gets
  the configured independent reviewer over sealed inputs and the bounded repair
  loop. Do not add compulsory reviewer-of-reviewer stages.
- UI work includes actual viewport screenshots at the approved desktop/mobile
  sizes and an interaction check for the requested flow. Record the tested app
  revision and route. Image existence and dimensions alone do not prove quality.
- Produce one result: what changed, acceptance results, verified versus reported
  checks, screenshots when relevant, annotated diff, caveats, and delivery state.
  Distinguish a finished branch from a published PR or a merged change.

Exit: an intentionally broken feature, misleading proof, stale screenshot,
or failed required check cannot be displayed as verified completion. A corrected
handoff does not unnecessarily restart the whole build or full test suite.

### P1.1 — Make hands-off operation understandable

Use the existing task/chat projection, not another lifecycle store. Present the
current stage in ordinary language: Planning, Building, Checking, Reviewing,
Done. Waiting and recovery explain what happens next.

- One compact status card: current action, last useful progress, recovery count,
  and next wake or decision. Expand for logs and technical detail.
- Notify once for a result or a new human decision. Routine recovery belongs in
  the timeline; do not send repeated unchanged alerts.
- Provide Stop, Continue after fixing the issue, and Ask for changes where
  applicable. Task page, chat, inbox, and CLI must agree.
- Preserve the actual review-ingestion failure category and a safe diagnostic;
  a database error is not stale evidence. A failed ingestion must not silently
  exhaust the only possible review forever: provide a bounded explicit retry
  with retained failed history and newly sealed inputs. Report review-only
  dispatch accurately, and show reviewer progress while it owns a live session.
- Report actual requeues across the complete reconcile transaction. Releasing
  a claim can requeue first; a later recovery helper must not then announce
  "nothing requeued" merely because it performed no second state change.
- Group repair attempts under the original requested outcome. Internal child
  records must not flood the project with apparently unrelated new tasks.
- A person returning after hours can immediately tell whether work finished,
  is progressing, is waiting for a known reset, or needs them.
- Keep the mobile result/status card within the viewport with usable controls.
  Test true phone-sized captures, including a long task title and failure text.

Exit: identical backend outcomes show identical next actions on every surface;
no task requires reading a transcript to discover why it stopped.

### P1.2 — Certify the whole experience with real work

Add cases to the existing certification harness and failure tests. Test doubles
cover exact fault boundaries; real subscription tasks prove integration.

1. Start with two small tasks, one per supported subscription route, observed
   without manual fixes: request → plan/standing approval → build → check →
   review if required → result → no duplicate dispatch.
2. Run deterministic fault cases for process death, restart, stale ownership,
   disconnect, malformed output, check failure, stale review, changed approval,
   cancellation, missing dependency, and uncertain publication response. Repeat
   the ownership/restart matrix 100 times with zero duplicate active writers,
   false-success results, or unexplained unfinished attempts.
3. After those pass, run a recorded 20-task pilot across both providers and a
   small variety of repositories: backend bug, UI flow, dependency setup,
   multi-file feature, and a task requiring a revision. Spread runs across more
   than one service session. Count any out-of-band intervention as a failure of
   unattended completion, even if the final code is good.
4. Target at least 19/20 eligible tasks completed with required evidence and no
   assistance; require 20/20 truthful outcomes with preserved work. External
   blockers remain visible in the report and are not relabeled successful.
   This is a release pilot, not statistical proof of universal reliability.
5. Record planning/build/check/review/recovery durations and p50/p95 total time
   against comparable direct-provider tasks. Require an explanation for
   duplicated expensive checks and long orchestration gaps before release.
6. On the Windows PC, follow the existing physical-machine checklist: real
   providers, app/terminal closed, reboot, native shell checks, process-tree
   cancellation, paths with spaces, and a second successful task. Keep actual
   account-exhaustion fallback certification separate from normal canaries.

Exit: a versioned report links commits, task/run ids, failures, durations, diffs,
and viewport evidence. Publish the measured supported-platform status. A manual
rescue updates the regression suite and is reported honestly in the pilot.

## Execution order and scope discipline

Ship P0.0, then P0.1 and P0.2, then P0.3 and P0.4. Include the relevant status
copy with each slice; finish cross-surface/mobile polish in P1.1. Run a small
end-to-end canary after each slice and the broader P1.2 pilot after integration.
Do not launch all slices as one enormous agent task.

Each implementation task has one bounded outcome, objective acceptance criteria,
an approved test command, and a required result receipt. Use Standing Orders
itself. Observe without quietly patching its worktree; record any intervention
as a product failure and file the smallest follow-up through the same flow.

Deferred: distributed workers, a second queue, a general autonomous watchdog
LLM, automatic model tournaments, elaborate repository-learning infrastructure,
an always-on cloud service, and a navigation redesign. The existing local
architecture should earn unattended trust before adding those systems.

References: [product roadmap](PRIORITIES.md), [Never Stuck contract](NEVER_STUCK.md),
[certification](CERTIFICATION.md), and the existing `src/dispatch.ts`,
`src/operate.ts`, `src/store.ts`, `src/exec.ts`, `src/invoke.ts`, `src/dispose.ts`,
`src/builder.ts`, and `src/reviewer.ts` implementation paths.
