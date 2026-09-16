# Telegram lifecycle: focused revision

Source result: run1682, candidate c130f321d35598052640281e718793621977124f.
Its native gate passed3298 tests with23 existing skips; reviewer1683 upheld
all six criteria. Independent reproductions nevertheless found two defects.
Do not replace that historical evidence or treat the review as proof these
cases passed. The revision needs fresh evidence for its changed candidate.

## Prepared fixes in this commit

- lifecycleWords now uses the existing secret detector plus the existing phone
  bot-token pattern on the original input, before truncation. Sensitive task
  titles and cancellation reasons no longer leak in individual or digest sends.
- holdOwned owns its transaction, including the notification. A failed outbox
  insert rolls back the hold even when the caller supplies no outer transaction.
- Four small cases in the existing task-notifications suite reproduce these
  failures and cover both public hold entry points and both delivery modes.

Checks run: typecheck;161 tests across task-notifications, store,
store-contention and telegram-status; git diff --check; the independent
in-memory/scripted-transport reproducer now passes. No full suite run here.
No live DB, configuration, network send, deployment or release was changed.

## Corrections completed in this revision

The three items the prepared commit left open, and how each was closed. No
schema, event bus, poller, scheduler or live configuration changed; the
existing `notification_delivery` columns carry every distinction below.

1. **Skipped history is not a delivery** (comment 484). A bot's first pairing
   still settles pre-pairing routine rows inside its own transaction, but the
   receipt is now only `skipped:before-pairing`: no `delivered_at`, no
   attempt, no error. One SQL fragment in `src/store.ts` (`TELEGRAM_UNSETTLED`)
   defines "still owes a send" as not delivered and not skipped, and the
   claim query, the per-task order fence and `countRoutinePending` all use it,
   so a skip settles a row without ever reading as a send. Open decisions and
   attention facts still page; per-destination isolation, re-pairing (nothing
   skipped, everything owed) and same-clock ordering are unchanged and still
   asserted. The pairing test now checks the receipt, the null delivered
   timestamp, the zero attempt count and the routine-pending count together.
2. **Delivery trouble is visible; quiet progress stays quiet** (comment 485).
   The console home and activity pages and the morning brief now count
   `store.pendingForAttention()`: every non-lifecycle pending row as before,
   plus a lifecycle row only once the live pairing actually tried to send it
   and the wire refused ("offline", a rate-limit answer, no confirmed message
   identity). Rows the store itself holds back are not trouble and are not
   counted: the reasons are one exported table, `TELEGRAM_HOLD_REASONS`
   (authority, destination, claim, rate-limit wait, resolved, provenance,
   installation access, excluded project, task provenance, order fence,
   delivery disabled), used by the fence in `telegramDeliveryProblem`, by the
   bridge's disabled-channel check and by the tally, so the words cannot
   drift apart. No success line was added; a delivered row simply stops
   counting. Supporting changes: `src/serve.ts` (two `outboxPending` sites,
   unused import dropped), `src/operate.ts` (brief), `src/telegram.ts` (shared
   constant), `src/tick.test.ts` (a brief regression that pairs a bot, holds
   the filed task, fails the send with a scripted transport, reads
   `outboxPending: 1`, then delivers and reads 0), and the transport suite
   (excluded project not counted; offline and rate-limited sends counted once,
   the fenced row behind them not counted twice; cleared after delivery).
3. **Cancellation punctuation, fact links, reviewer settlement** (comment 486
   and the concrete review questions). `cancellationWords` in `src/store.ts`
   closes the operator's reason with one full stop unless it already ends a
   sentence or was shortened to an ellipsis: "Cancelled by an operator: not
   needed this sprint. Nothing more runs for it." The producer suite now
   asserts after every case that each fact's link is a machine-minted console
   control for its own task (the task lens, its details page with the
   approval anchor, or one exact saved result), and a transport case shows a
   hold's single button opening `/t/<id>` under the trusted origin. The
   reviewer suite's real `reviewPass` case (a "contradicts" judgement) now
   checks the phone's facts in the actual ingestion order — review requested,
   review started, review finished naming the folded verdict "evidence
   conflicts with the result" with the exact result's checks link, then the
   repair task that fold filed — rather than a hand-saved verdict.

Preserved: the privacy and atomic-hold fixes above, task/result/revision
identity, exact approvals, shared mutation ownership, project exclusions,
retry, claim-generation and pairing safeguards, the cancellation audit row
and review settlement. No test was removed or skipped; no assertion was
loosened to match new output.

## Checks run for this candidate

- `npm run typecheck`
- `npx vitest run src/task-notifications.test.ts` (15 tests: producers,
  atomic holds, privacy, pairing skip, attention tally, hold button)
- `npx vitest run src/task-notifications.test.ts src/telegram.test.ts
  src/telegram-status.test.ts src/telegram-mate.test.ts src/store.test.ts
  src/store-contention.test.ts src/claim.test.ts src/pushstore.test.ts
  src/push.test.ts src/reviewer.test.ts src/tick.test.ts src/serve.test.ts
  src/operate.test.ts` (973 tests, all passing after the reviewer assertion
  was corrected to include the repair filing)
- `git diff --check`
- The unchanged approved full verification command runs once at the native
  final machine gate, not here.

## Gaps that remain

- No real Telegram bot, Tailscale or physical-phone trial was run; every
  transcript is a scripted-transport fixture. Live token, pairing and
  configuration were not touched.
- A row held back by policy (an excluded project, changed provenance) is
  named in the bridge's pass report but not in the console's count; that is
  deliberate, and `bridge status` / `outbox list` still show the raw outbox.
- Media and other chat connectors are separate work; no deployment, release,
  cleanup or live pairing happened in this build.
