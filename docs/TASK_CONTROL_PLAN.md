# Stop and resume one task safely

Started 2026-09-12 after the contract-handoff release reached main and the live
desktop controller. This is the next distinct forward port identified by
[the control-app assessment](CONTROL_APP_INTEGRATION.md). Extend the existing
queue, claims, invocation gateway, recovery, and approval mechanisms.

## Operator contract

An authenticated operator can stop one exact active attempt. The first response
says **Stop requested**, not **Stopped**: process shutdown and durable settlement
must finish before the UI claims that work has stopped. Other tasks keep running.
The task stays paused across controller restarts. Its branch, uncommitted work,
logs, proof attempts, signed requirements, and decisions remain available.

Resume targets the stopped attempt the operator actually reviewed. It refuses
while that attempt or its process descendants still own work. It clears only
the hold created by that stop, preserves unrelated operator/policy holds, and
does not approve changed terms or bypass budget, risk, routing, verification,
fallback, publication, or review-attempt bounds. Repeated and stale actions
must never stop or resume a successor accidentally.

For a build, resume uses the existing recovered-draft path with fresh lease and
proof identity. An earlier handoff is quarantined, not reused as proof for the
new attempt. A planner starts another plan attempt under current filed intent;
a stopped review retains its source build and uses the existing explicit,
bounded review-retry door. Surface those distinctions honestly.

## Implementation scope

1. Add durable exact-run stop intent using the next migration after schema 51.
   Preserve identity, actor, request time, settlement, and resume provenance.
   Reuse the hold table with precise ownership so removing a stop hold cannot
   remove a pre-existing hold. Use atomic compare-and-set transitions.
2. Fence invocation, corrections, repairs, final settlement, plan ingestion,
   review ingestion, task completion, fallback advancement, and publication
   admission when an applicable stop wins. Descendants of the stopped attempt
   inherit its stop; a later independently admitted attempt does not. Reviewer
   runs use synthetic leases, so a task-claim predicate is insufficient for them.
3. Stop only the owned subprocess tree through its live handle or the existing
   held-session supervisor. Do not use the global terminateLiveProviders sweep
   for a task action. Observe stop during setup, provider work, repair, and
   verification. Preserve ordinary timeout/failure classification; operator
   interruption must not add strikes, incident penalties, fallback budget, or
   an automatically approved repair task.
4. Reuse existing interruption recovery to settle a stop after a controller
   crash. Late output cannot become accepted proof or a successful task outcome.
   Preserve already-created commits as reviewable artifacts; do not reset or
   destroy sound work to simulate an uncommitted state. Never kill by an
   unverified PID read from durable state. Uncertain process death remains
   visibly stopping/needs attention and blocks resume.
5. Provide CLI and authenticated console actions over one shared domain API.
   Task and focused-chat surfaces show the same state and exact run identity.
   Use existing nonce, session, project-boundary, and password-step-up conventions
   for actions that resume spend. A stale page or replay must not affect a new
   attempt. Keep controls concise: Stop, Stopping…, Resume, or the existing
   Review again action as appropriate. Show the concrete gate if resume cannot
   start work. Preserve typed chat input through live status updates.

## Boundaries and race semantics

- A stop that commits before terminal settlement wins. The losing terminal path
  records interruption with preserved evidence and cannot mark the task done.
  A completed attempt refuses a new stop; earlier completion is not rewritten.
- Publication is an irreversible external effect. Refuse stop when publication
  is already admitted/in flight, or report that boundary explicitly using the
  existing publication state. Do not claim a stop recalls an external request.
  Stop before admission prevents that attempt from later publishing.
- A stop request is durable before process cancellation. Mark settled only after
  owned process/held-session shutdown is established. Resume cannot race ahead
  of finalization, released claims, cleanup, or recovery custody.
- No task-wide sticky bit that infects successors; no alternate queue, chat,
  execution, credential, or approval engine. Tournaments remain behind their
  existing explicit controls and must refuse unsupported generic stop/resume.
- Preserve live schema fencing, raw-authority validation, signed terms,
  immutable evidence, bounded repairs, and the schema-51 handoff features.
- The old source branch `origin/codex/control-app` at `15a1d9c` is reference only.
  It has weaker lease assumptions and older recovery logic; do not merge it or
  overwrite current modules wholesale. Do not change timeout policy as part of
  this feature. Do not add Telegram or project memory in this milestone.

## Acceptance and release evidence

Meaningful deterministic tests must cover both orders of stop versus success,
stale/replayed actions versus a successor, task/actor/project mismatch, rollback
on refused resume, preservation of unrelated holds and original scope terms,
restart before and after interruption settlement, and stopped review retry
bounds. Exercise planner, builder, repair, reviewer, setup/check subprocesses,
held-session shutdown, and publication admission as applicable.

A real subprocess test stops one of two simultaneous groups and proves the
other continues; it also proves no descendant writes after stopped settlement.
A real Git test interrupts a dirty draft, resumes it, preserves that draft,
requires fresh proof, and produces one accepted result without default-branch
changes. Capture desktop and phone screenshots of the actual controls, including
Stopping and Paused, and prove an ordinary authenticated stop/resume journey.

Run typecheck, focused tests, the full suite, build, and the platform CI gate.
Use Standing Orders to implement the feature, then record independent operator
review, any repairs, real-provider certification, and remaining physical-machine
limits honestly. Only the tested integrated runtime is eligible for the next
live upgrade. Keep a pre-migration backup and verify login, schema integrity,
launchd ownership, and fresh runner heartbeats after deployment.

## Implementation record (2026-09-12)

Delivered on `standing-orders/safe-task-stop-and-resume` as schema 52.

- **Durable intent.** `run_stop` (one row per exact run: requested by/via/at,
  settlement `interrupted | recovered | held | finished` with its time, resumed
  by/via/at) and the `stop` hold owner (`hold.owner_kind`), lifted only by
  resuming that run. `Store.requestRunStop` proves the run is this task's
  current live attempt (a reviewer's open outcome counts through its
  synthetic lease), not a tournament lane, and has admitted no publication;
  a repeated request answers with the same row.
- **Fences.** `Store.applicableStopFor` follows `parent_run` while the lease
  is shared (repair turns, reviewer corrections). It is consulted at the
  invocation gateway before spawn, in the builder after the provider and at
  the commit gate and the repair loop, inside every fenced finalizer
  (`interruptIfStopped` in claim.ts), at settlement in `disposeBuildOutcome`
  (inside one transaction, before any arm), in `Store.ingestReview`, in
  `resolveChainOnRunEnd` (a stopped tail ends the cycle without advancing),
  and in the recovered-draft grant (an unresumed stop admits no successor).
- **Process ownership.** `exec.ts` registers children under an `owner` tag
  (database identity plus run ID); `terminateOwnedProcesses` kills only that tag's process
  groups. `underStopWatch` re-reads the stop row every 1.5 s while a provider,
  setup, or check child runs. The held coordinator fences a stopped session
  through its supervisor (`HeldSessionCoordinator.stop`, and the lapse
  interval for stops filed elsewhere). No global sweep is used for a task act.
- **Settlement.** `finalizeInterruptedFenced` (claim.ts) releases the claim
  as `interrupted`, ends the run and its owned descendants as
  `failed / interrupted`, keeps a commit already made, requeues the task
  under the stop's hold. Settlement separately requires every owned run to
  end and every retained process witness to establish exit. Worker death
  alone is insufficient. Each OS spawn first reserves a durable `run_process`
  row, then attaches its PID; a crash in between stays visibly Stopping.
  Reconcile revisits pending stops after orphan processes exit. Saved PIDs
  are read-only liveness witnesses and never authorize signals.
- **Resume.** `Store.resumeRunStop` refuses `stopping`, `already-resumed`,
  `superseded` (a newer attempt head), `busy` (a live claim), `review`; the
  store always checks retained process witnesses and workspace occupancy,
  including web callers without a configured pool; the domain door reports
  the concrete gate (`diagnoseTaskDispatch`) when work cannot start yet.
- **Surfaces.** `src/task-control.ts` is the shared domain API and the one
  projection (`taskControlOf`: stop / stopping / paused / review-stopped).
  CLI: `task stop`, `task resume`, and `task show` (`control`, `stops`).
  Console: `POST /t/:id/stop` (approver session, csrf, exact run),
  `POST /t/:id/resume-arm` → ceremony, `POST /t/:id/resume` (password +
  durable `run-resume` nonce over the run, its settlement, and the scope
  approval), rendered by `taskControlHtml` on the task page and inside the
  focused chat's live region (which the page script swaps alone, leaving
  the composer's typed input untouched).
- **Tests.** `task-control.test.ts` (both stop-versus-success orders,
  stale/replayed actions against a successor, hold precision, restart
  settlement, the v51→v52 upgrade), `task-control-process.test.ts` (two real
  process trees, one stopped; no write after settlement),
  `task-control-git.test.ts` (real Git journey through the CLI),
  `task-control-console.test.ts` (auth, viewer, bearer, stale nonce, changed
  approval, foreign project, finished run, stopped review), plus held and
  reviewer cases in their own suites.
- **Independent hardening.** Self-hosted build #1520 and review #1521
  produced and assessed the initial implementation. Operator review then
  reproduced and fixed cross-database process collisions, a late-spawn stop
  race, an unlocked completion window, orphan recovery/resume, and review
  retry over a live orphan. Completion and stop disposition share one write
  transaction. CLI, task page, and focused chat derive the same state.
  `task-control-adversarial.test.ts` exercises these boundaries with real
  database connections and subprocesses. The provider review covers its
  original commit only; it is not evidence for later operator changes.
- **Certification gates.** The frozen candidate must pass the full suite,
  platform CI, six-stage crash canary plus stop-before-crash, and ordinary
  authenticated real-provider Stop/Resume journeys before live deployment.
  The journey also verifies that live chat polling preserves unsent text.
