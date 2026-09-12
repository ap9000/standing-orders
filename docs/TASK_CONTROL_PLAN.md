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
