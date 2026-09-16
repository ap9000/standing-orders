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
