# Telegram: task updates from every project

## Outcome

People should receive useful task progress without asking for status. Record
missing lifecycle facts where real changes happen and deliver them through the
existing notification and Telegram outbox. No parallel event system, polling
snapshot comparison, new scheduler, or token-by-token feed.

Baseline: deployed, reviewed `fcc83c68519f54fc7781f3e661a85d4e1bfbfd46`.
Phone links and login return are already accepted. Do not reopen that slice.
Private Tailscale and real bot pairing are external trial prerequisites, not
excuses to change authentication or invent a completed phone test.

## Inspect and extend the real producers

- Filing: createTask can precede placement. Emit only once its project is
  known. Audit CLI add, fileTaskProposal, revisions and external mirrors.
- Scope approval, holds and release: preserve owner-specific holds and exact
  approval. Holding the next attempt does not necessarily stop a live agent.
  Avoid repeating existing decision/incident attention messages.
- Queued, running, retry/recovery and cancellation: use the shared mutation
  primitives, not CLI-only hooks. Preserve applyCancellationLocked's coordinator
  audit, terminal guards and steering settlement.
- Run start and phase: inspect startRun/setRunPhase/finishRun, reviewer admission
  and settlement. A closed run's leftover phase is history. Built is not the
  same as independently reviewed, and a saved result is not published/merged.
- Terminal/attention producers already exist in claim, dispose, evidence,
  publish, held, contest, push and operate. Map them before adding duplicates.

## Integrity and delivery

Save each fact in the same transaction as its genuine state change. Repeating
the same state must not emit again; a real recurrence must, even under the same
clock value. Repeated finishRun reason updates are not another completion.
Use durable task/run/transition provenance, never display-text inference.
Prefer existing records and identifiers; no new generic event table or schema
change is expected. Document any concrete need before expanding that scope.

Preserve existing project/pairing checks, per-destination order, urgent/digest
rules, retry/rate limits and uncertain acknowledgements. First pairing must not
silently send a historical backlog. Excluded or revoked projects must not leak.
Messages need a short task/project identity, one truthful state and a named
next action only when useful. Reuse trusted links and phone text scrubbing.

## Evidence, kept lean

Extend existing tests where practical. Drive actual mutation/producer paths in
a disposable store, then the existing bridge/delivery transport: two enrolled
projects, one excluded; repeated and recurring changes, rollback, reconnect,
hold/release, cancel, recovery and successful independent review. Do not prove
producer coverage by manually enqueueing the expected notification. Use focused
fault cases to cover rate limits and permission changes, not a redundant matrix.

Run typecheck and affected tests. The native final machine gate alone runs the
unchanged approved full command once for the candidate. No removed tests,
new skips, waived evidence or new agent time limits. Report exact checks and
remaining gaps. Include a concise before/after producer map and representative
sanitized Telegram message transcript in this document; label fixtures honestly.
No browser UI is being redesigned, so do not fabricate screenshots. Direct
image upload, Slack/Discord/Teams, deployment, release, cleanup and live
token/pairing changes are outside this task.

---

## Implementation record (2026-09-16, built on fcc83c6)

### What changed

Every lifecycle fact is recorded by the store mutation that makes it true,
inside that mutation's own transaction, through one private helper
(`noteLifecycle` in `src/store.ts`). A fact is a row in the existing
`notification` outbox: no new table, column, event bus, poller or scheduler.
Its identity is the durable key `life:<kind>:<t<taskRef> | r<runId>>:<ordinal>`;
the ordinal is the count of earlier facts under the same head, read in the same
transaction, so a genuine recurrence (held, released, held again under one
clock value) is a new row while each producer's own same-state guard keeps a
repeat from ever reaching the helper. Provenance is the outbox's existing
`task_ref` / `task_id` / `project` / `source_run` columns, stamped from
`task_ref` and `run`, never from display text. Only a placed task speaks: an
unplaced task has no project to deliver to, so its facts are not recorded.

Lifecycle rows carry no push class. They are routine, digest-eligible facts;
decisions and attention pages keep their existing urgency.

### Producer map

Before this change the outbox had producers for decisions, incidents, gaps,
stalls, plan/report/scout outcomes, fenced or disowned completions,
publication and merge, CI, contests, recovery, sync and push credentials —
and nothing for filing, approval, holds, run start, phase, a saved result, a
stop, a resume, a cancellation, a requeue or an independent review. The table
below lists the shared mutation each new fact rides and which entry points
reach it.

| Fact (kind) | Shared mutation (src/store.ts) | Entry points covered | Existing page reused instead |
| --- | --- | --- | --- |
| `task-filed` | `placeTask` on the first placement (repo null → repo) | console form / `fileTaskProposal` / revisions / routine firings / coordinator via `createConsoleTask`; CLI `task add --repo` and `task place`; external mirror placement | — |
| `scope-approved` | `sealScopeApproval` when the yes is new on these exact bytes | password ceremony (`scope.approve`), mode coverage (`scope.ts`, `plan-auto.ts`, `dispose.ts`, `result-actions.ts`, `serve.ts`, `operate.ts`), routine firings | — |
| `approval-withdrawn` | `reconcileIntentsForMode` demotion of mode-basis approvals | mode revocation / expiry / notify posture | `stale-approval` (route mismatch) keeps its attention page |
| `task-held` | `holdOwned` for the operator owner only | CLI `task hold`, console hold, mate/chat hold | decision, incident, backoff, contest, revision and stop holds ride their own pages or the stop fact |
| `task-released` | `unhold` (operator owner); names what still holds when another owner stands | CLI `task unhold`, console, mate/chat | decision answered / incident resolved keep their own resolution |
| `run-stopping` | `requestRunStop` (not on a repeated request) | console, CLI, Telegram stop | — |
| `run-stopped` | `finishRun` of an open run with `failed/interrupted` while a stop stands | every fenced finalizer (`interruptIfStopped`) | dead-runner recovery keeps `runner-recovered` |
| `run-resumed` | `resumeRunStop` | console, CLI, Telegram resume | — |
| `run-started` | `admitRun` after every admission proof (generic, attended, recovered roads) | tick dispatch, CLI `run`, continuation, recovered draft, root reviewer via `admitReview` | repair turns, correction children, contest lanes, planner corrections say nothing |
| `run-phase` | `setRunPhase` when an OPEN run crosses a new phase | builder phases (`agent-running` … `correcting-proof`) | closed-run phase writes are history |
| `run-finished` | `finishRun` on the open → closed transition, builder `built` / `no-change` | `disposeBuildOutcome` (tick, continuation, standalone) | failed / parked / refused / fenced / external-closed / plan / report keep their pages |
| `task-cancelled` | `applyCancellationLocked` (the one writer of `cancelled`) | `cancelTask`, state verb, mirror latch, disowned completion, chat/Telegram cancel | coordinator audit row unchanged |
| `task-requeued` | `requeueTask` | CLI / console / chat requeue after a stall | `stalled` episode resolves as before |
| `task-queued` | `setTaskState(queued)` from another state; `reopenMirror` | CLI `release`, `task state queued`, `task reopen` | release-on-recovery keeps `runner-recovered` |
| `review-requested` | `requestReview` | `task review`, Retry review, automatic (strict / mode) | — |
| `review-finished` | `finishRun` of a root reviewer (verdict read from `proof_verdict`) | `ingestReview`, reviewer failures | correction children say nothing |

Unchanged and not duplicated: `decision`, `malformed-*`, `commit-failure`,
`attempts-exhausted`, `build-failed`, `plan-*`, `report-ready`, `build-fenced`,
`external-closed`, `external-skipped`, `stale-approval`, `repair-lineage`,
`secret-detected`, `gap`, `runner-recovered`, `worktree-adopted`,
`attended-unsettled`, `contest-*`, `publication-*`, `ci-failing`, `merge`,
`sync-failed`, `push-credentials`, and the `held:…:unkillable` attention row.

### Message catalogue (as delivered)

The bridge prefixes every fact with `<project label> / <task id> · `. Subjects
never repeat the task id. Bodies are one sentence. A plain fact with a link
carries one URL button under the trusted console origin (the same road as
`/task`): `Open task` for the task lens, `Review result` for an exact saved
result. With no trusted origin the words stand alone.

- `New task: <title>` — `Filed and waiting in the queue.`
- `Scope approved` — `Approved by <name>. A connected worker can take it next.` / `Approved automatically under the operating mode. …`
- `Approval needs renewing` — `The automatic approval it ran under has ended. Approve it again before it runs.`
- `Paused` / `Paused until <time> UTC` — `The next attempt waits until the hold is released. An attempt already running is not stopped by this.`
- `Hold released` — `The next attempt can start.` / `It still waits on an unanswered question.` (or an incident, retry backoff, tournament, plan revision, stopped attempt)
- `Stopping attempt #N` — `Its processes are being stopped and its work is preserved. The task stays paused until this attempt is resumed.`
- `Attempt #N stopped` — `Its work is preserved. Resume this attempt from the task page when ready.`
- `Attempt #N resumed` — `The next pass takes a fresh claim and continues from the preserved work.`
- `Attempt #N started` / `Attempt #N resumed from its preserved draft` — `Building on <provider · model>.`
- `Planning started (run #N)` / `Scouting started (run #N)` / `Independent review started (attempt k)`
- `Attempt #N: agent working | checking the handoff | capturing evidence | committing | verifying the proof | correcting the proof`
- `Attempt #N built` — `The result is saved locally. It is not yet independently reviewed or published.`
- `Attempt #N finished with no changes` — `Nothing needed to change; the handoff explains why.`
- `Independent review requested` — `Requested by <name> for attempt #N's saved result. A connected reviewer runs it next.`
- `Independent review finished: checks verified | evidence conflicts with the result | agent-reported evidence only | required evidence is missing | comments only`
- `Independent review attempt k did not finish` — `The saved result is unchanged. Another review needs an explicit request.`
- `Cancelled` — `Cancelled by an operator[: reason]. Nothing more runs for it.` / `The tracker closed it. …` / `… the finished work was not accepted.`
- `Requeued` — `Its failure streak is cleared; a worker can take it again.`
- `Back in the queue` — `Its worker released it without finishing; …` / `Reopened for another attempt.` / `The tracker item is open again; …`

Publication and merge keep their existing `PR ready` and merge pages, so a
saved result, a reviewed result and a published one are three different
messages.

### Delivery rules kept, and one added

Per-destination order, the earlier-undelivered fence per task, urgent-over-
digest flushing, `retry_after` deferral, claim expiry and generation checks,
project enrollment and pairing/actor re-proof before every part — all
unchanged and exercised by the new suite with real producers. Added: a bot's
FIRST pairing settles every routine row already in the outbox for that
destination with the receipt `skipped:before-pairing`, in the pairing's own
transaction, so a phone that just arrived never receives months of history;
an open decision or an attention-class fact still pages. The skip is explicit
and never a delivery: the receipt carries no `delivered_at`, no attempt and no
error, every reader that means "undelivered" treats a `skipped:` receipt as
settled, and skipped history never fences the facts that follow it (revised
2026-09-16, see `TELEGRAM_LIFECYCLE_REPAIR_2026-09-16.md`). A re-pairing
after a revocation keeps the older promise (what no phone ever received still
waits), which an existing test enshrines.

Two tallies changed meaning slightly so progress never reads as attention,
without hiding trouble: the morning brief's and the console's `outboxPending`
(`pendingForAttention` in `src/store.ts`) count rows that want a person plus
any task update the live pairing actually tried to send and the wire refused
("offline", a rate-limit answer, no confirmed message id). Routine progress
waiting for its digest window or a pairing, skipped history, and rows the
store itself holds back (an excluded project, changed provenance, the
per-task order fence — `TELEGRAM_HOLD_REASONS`) never pad the number; the
bridge's pass report still names every held row. The unpaired bridge names
"outbox rows are pending but no chat is paired" only when a non-lifecycle row
is pending — a first pairing settles routine rows as history anyway.
`bridge status` and `outbox list` still show the raw outbox.

Webhook mirrors (Slack/Discord) share this outbox and will carry the same
routine rows when Telegram is not paired; nothing about those integrations
was changed.

### Sanitized fixture transcript

From `src/task-notifications.test.ts` against the scripted Bot API, projects
`/projects/alpha` and `/projects/beta` enrolled, `/projects/excluded` not.
Fixture data, not a real bot conversation.

```
alpha / old-1 · old-1 parked a decision            (open decision from before pairing: still pages; keyboard = its own tap buttons)
alpha / alpha-1 · New task: Guard the payout path
Filed and waiting in the queue.                    [Open task → https://console.example/chat?task=alpha-1]
beta / beta-1 · New task: Rotate the API keys
Filed and waiting in the queue.                    [Open task → https://console.example/chat?task=beta-1]
(x-1 in the excluded project: retained, "Notification project is not currently authorized and enrolled")
— send fails "offline"; the attempt's phase row waits behind it; restart; retry_after 30 pauses the bot —
alpha / alpha-1 · Attempt #1 started
Building on claude.                                [Open task]
alpha / alpha-1 · Attempt #1: agent working
The agent is working in its own checkout. Nothing is finished yet.   [Open task]
alpha / alpha-1 · Attempt #1 built
The result is saved locally. It is not yet independently reviewed or published.
                                                   [Review result → https://console.example/chat?task=alpha-1&result=1&tab=changes]
digest — 2 routine fact(s) since … (as of …)       (away mode: flushed ahead of an attention page for the same task)
• alpha / alpha-1 · New task: Guard the payout path
    Filed and waiting in the queue.
• alpha / alpha-1 · Attempt #1 started
    Building on claude.
alpha / alpha-1 · alpha-1 stalled after 3 straight failures   (existing attention page, fixture row)
```

Rows before the first pairing (`old-1` filed, started, built) were settled as
`skipped:before-pairing` and never sent: receipt only, no delivered timestamp.

### Verification run for this candidate

- `npm run typecheck`
- `npx vitest run src/task-notifications.test.ts src/telegram.test.ts` (new suite plus the transport suite)
- Focused regressions over the suites that read the outbox or the changed mutations (telegram-mate, telegram-status, store, store-contention, claim, pushstore, push, tick, task-control, publish, scout, tournament, stale-approval, routine, routines-e2e, planner, agentconfig, webhooks, migrations v61–v63, reviewer, dispatch, scope, modes, evidence, operate)
- The unchanged approved full command runs once at the native final machine gate, not here.

Existing transport-focused fixtures (`telegram.test.ts`, `telegram-mate.test.ts`)
settle lifecycle rows before each pass so they keep testing the hand-enqueued
rows they were written for; three claim/store assertions filter lifecycle rows
by their durable key. No test was removed or skipped.

### Gaps and honest labels

- No real Telegram bot, phone or Tailscale trial was run; the transcript is a
  scripted-transport fixture. Live token, pairing and configuration were not
  touched.
- Contest lanes, repair turns and correction children record no start/ending
  of their own (the tournament and attempt pages cover them).
- A task marked done or failed by hand (`task state`) records no fact; the
  run that concluded it does.
- Dead-runner recovery, `release --requeue` walks and the interrupted-run
  requeue keep the existing `runner-recovered` / stop facts rather than a
  second return-to-queue row.
- The phase catalogue is verbose in "every fact pages as it lands" mode; away
  mode batches it. No cadence change was made.
- Timestamps on facts from `placeTask`/`unhold`/`setRunPhase` callers that
  pass no clock use the wall clock; ordering is by outbox id, never by time.
