# Telegram delivery foundation

This slice adds authorization and destination receipts to the existing outbox.
It does not add ordinary-text chat, new transition producers, or another worker.
The approved roadmap remains [the shared-chat plan](TELEGRAM_SHARED_CHAT_PLAN_2026-09-15.md).

## Delivery contract

- Producers supply a task reference, run, project, or explicit installation
  source. `Store.enqueueNotification` resolves task/run sources through stored
  records and freezes the full project, task reference, external task ID, and
  available run ID. Text and links never establish authorization. Dedupe cannot
  replace an existing source. Unplaced, invalid, and pre-v61 records remain
  `unknown`, with an undelivered reason when attempted.
- Before every outbound part and retry, the bridge reloads enrollment and
  channel configuration, then checks the live private pairing, actor role,
  credential generation, project access, unchanged task placement, claim owner,
  generation, and expiry. It checks again after asynchronous sends. Before a
  digest is composed, every claimed row is checked in ID order: a row without
  live authority is retained with its reason, and the eligible rows go out
  now instead of waiting on it. A task's later facts stay behind its blocked
  earlier one. If access changes while a part is in flight, the remaining
  parts are refused and every row of that digest stays undelivered.
- `notification_delivery` keys receipts and retry claims by notification and
  exact bot/chat/binding/actor generation. Telegram never writes the legacy
  shell/webhook receipt or `push_delivery`. Those channels keep their existing
  semantics; this does not implement destination fan-out for webhooks.
- `telegram_outbound_message` records confirmed IDs against the original
  destination and exact task/project/run. Each digest part maps only the rows
  whose text it contains. A completed network send can remain in old-destination
  history after revocation, but cannot acknowledge the replacement destination.
  This is future routing data, not a new reply action.
- Updates stay in notification-ID order within a task. Urgent updates flush
  earlier routine facts for that task before the next digest window. An earlier
  failed or delayed notification blocks later task updates. Expired claims can
  be reclaimed after restart, including by the same owner with a new generation.
- A reported `retry_after` pauses outbound outbox sends for that bot durably.
  Routine retry attempts are eligible even before the next digest window.
  Plain messages remain bounded at 3,900 UTF-16 code units without splitting
  surrogate pairs; decision consequences precede the final buttons.

Sources: [outbox, provenance, receipts and leases](../src/store.ts),
[bridge send fences and transport](../src/telegram.ts),
[live registry/configuration wiring](../src/operate.ts),
[identity display](../src/telegram-status.ts),
[independent web-push ledger](../src/push.ts).

## Transition inventory

“Stamped” means an existing producer now supplies provenance. It does not mean
that every instance of the broader transition has a notification.

| Transition or event | Current source | This slice / remaining work |
| --- | --- | --- |
| Created, queued, reprioritized, reserved | `Store.createTask`, queue operations; `mate-doors.ts` | No new feed producer; add distinct transition events later. |
| Awaiting plan approval; plan changed or refused | `claim.ts`: `finalizePlanFenced`, `finalizeRevisionFenced` | Existing plan-ready, plan-revised/blocked, and stale-source messages stamped. Other approval-state changes remain. |
| Started, working, capturing evidence, verifying | `builder.ts`: `build`, `settleProviderOutcome`, `setRunPhase` | State exists; no general start/phase feed. Keep heartbeats and token streams out. |
| Waiting for a decision | `claim.ts`: both park finalizers; `operate.ts`: contestant/resume decisions | Existing messages stamped by run. Opaque buttons, irreversible confirmation, replay checks and reply notes retained. |
| Failure, retry/backoff, attempts exhausted | `claim.ts`: build/plan/scout failure finalizers | Existing failure messages stamped; no general retry-start event. |
| Recovering, stale approval, fenced/disowned work, repair ancestry | `operate.ts`: reconcile; `dispose.ts` | Existing messages stamped. Recovery text no longer lists other recovered tasks inside one task's notification. |
| Capability blocked, tracker sync/skips, worktree adoption | `operate.ts`: tick/reconcile | Existing task/project messages stamped. Not a feed of every waiting reason. |
| Reviewing; built, verified, accepted result | `reviewer.ts`: `review`/`reviewPass`; `dispose.ts`; proof records | No general review/result-ready/accepted transition producer. These states must remain distinct. |
| Report ready | `claim.ts`: `finalizeScoutFenced` | Existing report-ready message stamped by run. |
| Revision created; stopped, resumed, cancelled | `chat-review.ts`, `result-review.ts`, `task-control.ts`, store task operations | Shared records exist; add lifecycle events later. A plan revision message is not a result revision-created event. |
| Contest finish, cleanup, overdue | `contest.ts` | Existing messages stamped by task; aggregation has no single source run. |
| Publication opened/failed, CI failure, merge outcome/attention | `publish.ts` | Existing messages stamped by publication run. No invented “published” status for a local build. |
| Routine blocked; held-process/shutdown attention | `routine.ts`, `held.ts`, `operate.ts` | Existing project/task messages stamped. No extra schedule or firing mechanism. |
| Push credentials rejected; explicit webhook test | `push.ts`, `operate.ts` | Explicit installation messages; only an unrestricted live approver can receive them. |

Source links: [claim](../src/claim.ts), [operate](../src/operate.ts),
[builder](../src/builder.ts), [reviewer](../src/reviewer.ts),
[dispose](../src/dispose.ts), [contest](../src/contest.ts),
[publish](../src/publish.ts), [routine](../src/routine.ts), [held](../src/held.ts).

## Unified-chat action inventory

Web and CLI below describe source-backed service paths, not a fresh end-to-end
certification of those channels. Telegram has no model/tool loop in this slice.
Every later integration must retain the same actor/project ceiling and current
proposal/result identity. A control link is a handoff, not a completed action.

| Intent / current tools | Web and CLI owner | Telegram now / next slice |
| --- | --- | --- |
| Context: `recap`, `list_repos`, `get_project_knowledge`, `list_tasks`, `get_task`, `get_agents`, `list_decisions`, `get_decision`, `queue` | `MATE_TOOLS` read projections | Only deterministic `/help`, `/status`, `/task`; full conversation context and history reads remain. |
| Create work: `propose_task`; plan/scope: `propose_scope` | `mate-doors.ts`, task filing and scope services | Console handoff. Add shared proposal confirmation and durable inbound receipts; never collect passwords. |
| Queue/settings: `propose_next`, `propose_reserve`, `propose_agents` | Queue revision and scope/route checks in `mate-doors.ts` | Unsupported in Telegram; retain stale-proposal rejection and any renewed approval. |
| Hold/steer: `propose_hold`, `propose_unhold`, `propose_steer` | Same store hold/steering records | Unsupported; do not turn a steering request into a saved note. |
| Dependencies: `propose_dependency_repair`; `propose_task_action` wait_for/stop_waiting | `mate-doors.ts`, `chat-task-actions.ts` | Unsupported; check both projects and current dependency graph. |
| Stop/retry/plan/resume: `propose_task_action` | `chat-task-actions.ts`, `task-control.ts` | Console handoff. Resume still needs its existing password confirmation; no new Telegram authority. |
| Answer: `propose_answer` | Shared decision service, current choice and confirmation | Existing paired decision buttons and reply-to-decision notes retained; ordinary-text answers remain unsupported. |
| Result: `get_result`, `propose_review` note/revise | `chat-review.ts`, `result-review.ts`, shared comments and same-family revision | `/task` gives a bounded evidence summary. Result previews, exact-feedback confirmation, save-note and reply-driven revision remain. |
| Cancel: `propose_cancel`; approval/publication and administration: `get_controls`, `show_control` | `chat-controls.ts` fixed authenticated destinations | Existing console handoffs only. Approval, publication, worker/provider/project/settings/routine/recipe/knowledge/learning/mode controls are not Telegram actions. |

Complete tool vocabulary and guards: [mate-tools.ts](../src/mate-tools.ts),
[proposal execution](../src/mate-doors.ts),
[task actions](../src/chat-task-actions.ts), [result review](../src/chat-review.ts),
[fixed controls](../src/chat-controls.ts), [Telegram commands](../src/telegram-status.ts).
Slack, Discord and Teams unified-chat adapters remain subsequent slices.

## Candidate and checks

Integrated on 2026-09-16 per the [integration plan](TELEGRAM_EVIDENCE_INTEGRATION_PLAN_2026-09-15.md).
Base HEAD is `ba101e694cd94907a493c0ae3a5efa666477e977`, the docs-only input
commit on the accepted evidence runtime `64e81727133c7a791a38c6cec9ee7bba02419415`.
The two source commits, `87551dafc9c1d4e457bcd62d4f36988340b5dfb3` (provenance,
authorization, receipts, retry) and `3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`
(digest partition), were replayed as one diff over that base. The replay applied
without textual conflict; the three files both lines of work touched
(`src/store.ts`, `src/evidence.ts`, `src/tick.test.ts`) keep every newer
review-evidence guard (verification receipt binding, sealed review context,
first-review proof gaps) beside the Telegram changes. No evidence, review or
proof code was rewritten.

Schema: the accepted evidence runtime was still schema 60, so the exact
60-to-61 migration and reader fence from the source commits stand unchanged.
The evidence fix's own compatibility block in
`src/migration-v50-review-retries.test.ts` had pinned the build to 60 and
proved that reader refusing 61; on the integrated candidate it now proves the
60-to-61 (and -60 sentinel) upgrade preserves every historical review row,
receipt and ID, that no schema-62 refresh object exists, that 62 and -62 refuse
as a newer build before any write (the same fence v60 applied to 61), and that
-61 is an impossible marker. `src/migration-v61-telegram.test.ts` proves legacy
notification rows stay `unknown` and a v61 file missing its delivery history
fails closed.

The [candidate manifest](TELEGRAM_DELIVERY_CANDIDATE_2026-09-15.json)
is a historical delivery snapshot of the accepted candidate, `sourceHead`
`8217f5579d02c4feed7dcdcc24c8e01ff8d35a71`. It records every source/test path
in the exact Git diff `ba101e6..8217f55` under `src/` (23 paths) with the
SHA-256 of that path's bytes at `8217f55`.
Source digest: `80ba1b57c26f8375013dfac7cdd3165ab2dc7125a739757dd7df48b088cca2ad`. Its aggregate is SHA-256
of sorted `path + NUL + fileHash + LF` entries. Documentation and protocol files
are excluded from that aggregate; the base plus these file bytes identifies
the tested implementation without moving HEAD. The manifest does not describe
any later commit or the current tree.

Correction 2026-09-16: the original hand-typed list held 22 paths and its
digest `77cf98cb0245f5cc8aa648c1396d09b9ec8488dffa64ce2dc6ff118780821df6`
omitted `src/claim.ts`, whose stamped producers the table below already
cited. The machine-sealed review inventory for that candidate always
contained all 25 delivery paths, so no evidence changed; only this document
and the manifest did. The 22 original hashes are unchanged. Running
`node scripts/delivery-manifest-check.mjs` reads Git objects only and refuses
the manifest when its path list differs from that diff, when any hash differs
from the `8217f55` bytes, or when the digest does not recompute. The native
test gate runs that check from `src/provider.test.ts`, so an incomplete
manifest fails the suite.

### Criteria mapped to code and executable regressions

| Criterion | Implementation | Regressions (exact tests) |
| --- | --- | --- |
| Both changes on the evidence base without regressing first-review delivery, gate receipts, web/CLI | `src/store.ts` (`enqueueNotification` provenance, `claimTelegramDeliveries`, `finalizeTelegramDelivery`), `src/telegram.ts` (`deliverOutbox`), stamped producers in `src/claim.ts`, `src/operate.ts`, `src/publish.ts`, `src/dispose.ts`, `src/contest.ts`, `src/held.ts`, `src/routine.ts`, `src/evidence.ts`, `src/push.ts` | `src/telegram.test.ts` "the telegram bridge" and "away mode" blocks; `src/tick.test.ts` "the bridge, end to end"; `src/builder.test.ts`, `src/reviewer.test.ts`, `src/review-context.test.ts`, `src/review-context-e2e.test.ts`, `src/proof.test.ts` (unchanged evidence suites, rerun on this tree) |
| Restart, rate limits, duplicate/stale claims, pairing/enrollment changes, mixed digests | `Store.telegramDeliveryProblem`, `Store.deferTelegram`/`telegramRetryAt`, `Store.telegramClaimHeld`, digest partition in `deliverOutbox` | `src/telegram.test.ts` "destination-bound authorized outbox": "retry_after survives restart, blocks all sends, then resumes in task order"; "restart recovers expired claims; same-owner stale generations and replaced destinations cannot settle"; "a retry rechecks removed enrollment; a later update cannot overtake it"; "a mixed digest sends the eligible rows now; legacy and unenrolled rows wait with reasons, in task order"; "%s digest isolation survives a restart" (legacy, unauthorized, both); "%s while a message is in flight cannot acknowledge or send its next part" (unpair, replace, revoke, generation, viewer, disable); "urgent updates flush earlier task facts in order even before the digest window"; "missing registry, changed task placement and mismatched decision provenance all fail closed" |
| Isolated upgrade/reopen preserves rows, IDs, receipts; legacy provenance unknown; old readers refuse 61 | v61 DDL and `migrate` column adds in `src/store.ts`; `readSchemaVersion` fence (unchanged) | `src/migration-v61-telegram.test.ts` (v60 and -60 fixtures, missing-history refusal); `src/migration-v50-review-retries.test.ts` "schema 61 compatibility without manual refresh" |
| First independent review receives complete Telegram code and tests plus the exact verification receipt | unchanged `src/review-context.ts` (every candidate changed path captured whole, 8 MiB item / 32 MiB aggregate bounds), `src/verification-evidence.ts`, `src/reviewer.ts` | `src/review-context.test.ts`, `src/review-context-e2e.test.ts`, `src/reviewer.test.ts`, `src/builder.test.ts` (unchanged, rerun); the largest captured file, `src/store.ts`, is about 1.1 MiB |

Focused commands and their final results are recorded in the task proof:

- Typecheck.
- Existing Telegram/status/store/push suites plus v61 migration fixtures and
  the moved schema-compatibility block.
- Existing builder/reviewer/review-context/proof/verification suites from the
  evidence runtime, unchanged, rerun on the integrated tree.
- Existing claim/publication/evidence/routine/held/operate suites and affected
  historical migrations.
- Existing bridge end-to-end selection: pair, park, deliver, tap, next tick,
  and follower response. Its fixture explicitly enrolls the project.
- Three existing schema-marker suites at v61.

The unchanged full native gate is reserved for Standing Orders, once, for this
combined candidate; the historical Telegram gate on `3102879` does not cover it.
No verifier, provider route, subscription, installed runtime, live database, or
pairing was changed. Tests use isolated stores, synthetic pairings and scripted
transport; the HTTP-adapter test replaces `fetch` before calling it. No live
sends occurred. Deploying v61 still needs the normal managed migration and
runtime rollout after independent acceptance.

## Practical limits and next acceptance

Telegram considers polling updates confirmed when a later `getUpdates` offset
passes their IDs. Durable inbound application still precedes cursor advancement.
`retry_after` is a wait in seconds; `sendMessage` accepts at most 4,096 characters.
See the current [Bot API](https://core.telegram.org/bots/api#getupdates),
[response parameters](https://core.telegram.org/bots/api#responseparameters), and
[sendMessage](https://core.telegram.org/bots/api#sendmessage), checked 2026-09-15.
The [Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
advises roughly one message per second per chat. This slice reacts to flood
responses; it does not add paid broadcasts or promise unlimited throughput.

A message already in flight cannot be recalled by a later revocation. A crash
or ambiguous timeout between remote acceptance and the local receipt may cause
a duplicate. A failed multipart notification/digest retries as a whole, so its
confirmed earlier parts may also repeat. Read-command responses remain
best-effort; users retry the command after a lost response. Long outages can
outlast Telegram's inbound retention. The host and bridge must be online.

Legacy unknown rows require local inspection; they are never promoted to global
messages. They no longer hold a mixed digest: each pass retains them with their
reason while the authorized rows around them are delivered.
A dedicated delivery-status/recovery view and resumable multipart progress remain
follow-ups. The schema migration was exercised only on fixtures; deploying v61
still needs the normal managed migration and runtime rollout.

Simplicity pass: decision headings changed from an unqualified task name to
`project / task · Decision needed`, with no repeated task heading; all option
consequences and irreversible warnings remain. Long text, failure and empty
status behavior are covered by scripted tests. No desktop/phone visual journey,
reachability check, screenshot delivery, or live Telegram acceptance is claimed.
The later real trial must cover create, approve, progress, proof, exact reply
feedback and same-family revision across Telegram, web and CLI.
