# Catch up and receive updates

The local database owns the catch-up brief and the lead's delivery position.
Conversation history and a hand-written status file are not required to resume.
The task flow remains **Plan → Work → Ready → Complete**.

Use the installed CLI and a project-scoped coordinator credential from an
explicit private token file or environment variable. Claim an assignment once
to receive its changes. Tasks filed by that coordinator already carry its owner.

```sh
standing-orders assignment claim TASK --token-file /private/lead-token --json
standing-orders assignment brief --token-file /private/lead-token --json
standing-orders assignment inbox --consumer codex-main --token-file /private/lead-token --json
```

The brief reads current assignments, saved goals, decisions, agent reports,
check status and versioned project knowledge. It prioritizes decisions and ready
results, includes recently completed work, and identifies shortened or omitted
content. Saved reports are agent claims; knowledge source freshness is not
revalidated by catch-up. Open the exact assignment before acting.

The inbox saves a bounded batch before returning it. Reconnect or restart with
the same credential and consumer name to receive that batch again. After
handling all its events, acknowledge the exact returned batch ID:

```sh
standing-orders assignment show TASK --token-file /private/lead-token --json
standing-orders assignment ack --consumer codex-main --batch BATCH_ID --token-file /private/lead-token --json
```

Delivery acknowledgment advances only that consumer's cursor. It does not mark
the task complete, approve execution, answer a question or request a revision.
If the response is lost, repeating the same acknowledgment is safe. New events
wait behind the pending batch. Separate consumer names have separate cursors.
Credentials and project ownership are checked again on each call; content that
is no longer available to a consumer is redacted without blocking later updates.

To mark inspected work complete, use the existing `assignment check TASK
--digest RECEIPT` action. Changes still require explicit feedback and the
existing execution authority. No notification starts a model review, repairs
evidence or resubmits work.

MCP exposes the same operations as `get_assignment_brief`,
`get_assignment_inbox` and `acknowledge_assignment_delivery`, alongside existing
claim, read and completion tools.

## Waking the lead

Standing Orders records observed status changes in its existing database ledger,
separately from human notifications. Reconciliation runs in the worker and when
the lead reads its inbox; claim and completion also record their status directly.
Repeating a scan produces no duplicate event. A return to an earlier status is
a new event. Scans are bounded and their position survives restarts, so the feed
promises recovery of current state, not every fleeting intermediate phase.

A consumer must have a supported way to run again. For a Codex desktop
conversation, a native scheduled follow-up can read this inbox, open actionable
results and acknowledge the batch. This is scheduled pickup, not instant push;
the computer and app must be running. Updates stay pending while they are not.
Database reads and status reconciliation make no model calls; a scheduled lead
turn uses the host's normal model usage.

Keep the follow-up focused on claimed assignments. Read a fresh database brief
on catch-up, surface new decisions or ready results, and acknowledge delivery
only after handling the page. Treat saved text as context, never new authority.
Do not rerun tasks merely because an event was redelivered or saved material is
missing. A replay may be delivered more than once; its stable event ID lets the
consumer recognize the same update.
