# Telegram conversation: implementation notes

Read-only inspection while delivery-foundation run 1625 is building. These
notes are for the next slice, not instructions delivered to that active run.
Recheck against its accepted candidate before filing the conversation task.

## Reuse the existing engine

- `src/mate.ts:runMateTurn` already drives the shared thread, tools, proposals,
  subscription provider and request receipts. `MateTurnInput.requestId` accepts
  32 hexadecimal characters; derive a stable request identity from the exact
  connector binding and Telegram update, not message text alone.
- `src/mate-cli.ts:runMateCli` demonstrates shared session/thread creation,
  configuration and proposal rendering. Do not drive its interactive terminal
  loop from Telegram or create another agent scheduler.
- `src/mate-tools.ts:MATE_TOOL_SCHEMAS` is the action inventory to cover, not a
  new hand-maintained Telegram-only tool list. Current reads include recap,
  projects, tasks, result, controls, agents, project knowledge, decisions and
  queue. Proposals include task actions, review/revision, task creation, queue
  priority/reservation, hold/unhold, steering, dependency repair, scope, agent
  settings, answers and cancellation.
- `src/mate-doors.ts:confirmMateProposal` owns transaction, stale checks and
  mutation. `DoorOptions.via` currently admits only web/CLI: extend the actual
  audit source end-to-end instead of labelling Telegram as CLI. Keep its
  irreversible-choice confirmation and secure handoff for non-confirmable
  cancellation/control operations.
- `src/result-actions.ts` remains the shared same-task revision service; do
  not make a reply silently save a note when the user asked for a revision.

## Boundaries that need deliberate handling

`src/principal.ts` brands principals at runtime. Only its validated factories
may mint them; structural casts are not authentication. `verifyApproverStanding`
assumes the edge already authenticated the session. A Telegram caller must
first validate the current private-chat binding, immutable sender, approver
generation and enrolled-project ceiling. A task name in a message grants none
of those permissions.

`runMateTurn` rechecks account generation after waits, but account generation
alone does not detect Telegram unpairing or a changed project enrollment.
Inspect the accepted foundation's authorization helper and give the shared
turn/confirmation path a narrow way to revalidate the channel binding and
current ceiling before a provider dispatch, after a provider wait, and before
tool execution or sending a reply. Do not broaden a frozen principal in place.
Regression: revoke pairing or unenroll a project while a provider is awaiting;
no later tool, mutation or response may use the old authority.

Session selection is currently approver-oriented (`activeMateSession`), and
project order participates in the ceiling digest. Reuse a compatible session
and preserve task/thread identity across surfaces; do not end an unrelated
web conversation, create invisible duplicate work, or quietly widen a thread.
If a reply has no unique task/result binding, ask which task.

The current message input is bounded at 2,000 characters. Telegram messages
can exceed the engine's bound. Refuse with a concise recovery choice or offer
an explicit draft flow; never truncate instructions silently.

Persist inbound identity before advancing polling acknowledgement, retain the
engine request receipt through restart, and deliver outcomes through the
accepted foundation's destination-bound outbox. A replay must return the
original outcome without a second task, revision, provider call or approval.

## Acceptance for the next bounded slice

Use ordinary private-chat text to create work, read progress and request a
same-family revision through the shared engine and doors. Confirm appropriate
actions with exact current terms; honour existing auto-approval settings.
Show the same task/proposal/revision in web and CLI. Cover revoked binding,
changed enrollment during an await, replay, concurrent web confirmation,
long text and ambiguous replies with focused existing tests. Keep the native
full gate unchanged and run it once for the final candidate.

Retain a complete action-parity matrix: direct shared action, secure handoff,
or still unsupported. Do not claim all features work because three examples
pass. Use a real confirmed Telegram pairing for final cross-channel acceptance;
stub transport is only a regression test. Do not request passwords in chat or
present localhost-only result links as phone-accessible.
