# One conversation across web, CLI, and Telegram

Historical roadmap and first-slice record. Current integration starts from
accepted/deployed64e8172 under TELEGRAM_EVIDENCE_INTEGRATION_PLAN_2026-09-15.md,
which supersedes the older status, base and model references below. Delivery
commits87551da/3102879 remain source inputs, not yet integrated or deployed.

## Outcome

Every task status change in every connected, authorized project reaches the
owner's paired Telegram chat. Reply there to manage the work. Web, CLI, and
Telegram use the same agent, task records, results, and authorization rules.
Starting in one place and continuing in another must not create duplicate work.

## Current state

- Telegram has paired private-chat decision buttons and reply notes, plus
  deterministic `/status`, `/task`, and `/help` reads. It is not full chat.
- `/status` is a bounded snapshot, not an all-task event feed. Read responses
  are currently best-effort, without crash-safe redelivery.
- `standing-orders chat` already uses the shared conversation engine and action
  services. Some sensitive actions still hand off to the console.
- The one-action result UI and worker are deployed together on `8efa954`.
  A real Request changes action created and auto-started a same-family revision.

Update at 19:22 UTC: phone candidate `78573019` passed 3,061 tests. Review
upheld two criteria but still lacked images for two others. Evidence has an
eight-image cap; the follow-up now explicitly selects eight states that cover
the rubric. Opus run 1622 started automatically from committed brief `c570410`.
This is not a Telegram implementation or a new deployment.

Read-only implementation inventory for the first slice:

- `Store.enqueueNotification`, delivery claims, retries and digest receipts
  already provide a durable outbox. Extend that path, not a second scheduler.
- Notifications currently carry a dedupe key, kind, subject/body and optional
  link, but no typed task/project identity. The `readProjects` callback is
  used for incoming status commands; the inspected outgoing plain-message
  and digest paths do not apply that project ceiling. The expanded feed must
  establish typed provenance and recheck live project visibility on delivery
  and retry, for both individual messages and digests. Do not infer authority
  by parsing arbitrary notification text or a link.
- Current delivery completion is global to a notification. Sending the same
  event to several configured connectors needs destination-specific receipts;
  one Telegram success must not suppress Slack/Discord/Teams delivery. Inspect
  the existing separate web-push receipt pattern before adding storage. Keep
  this as delivery bookkeeping around the existing outbox, not a new task engine.

## Build order

### First bounded implementation: authorized, reliable delivery

Task `telegram-shared-chat-20260915` starts with the delivery foundation below,
not the entire integration roadmap in one build. Preserve existing decisions,
reply notes and deterministic commands. Ordinary conversation, additional
transition producers, media and other connectors remain subsequent slices.

- Add explicit project/task provenance to task-bearing outbox records and
  identify the existing producers that must supply it. Resolve identities from
  trusted task records, never notification text or a URL. Distinguish genuinely
  installation-level messages from task data; do not label unknown legacy
  task notifications as global to let them through.
- Apply the live enrolled-project ceiling and current paired private actor
  generation before each outbound send, retry and digest part. Disabled,
  unpaired, revoked or unenrolled data must not leave the installation.
  If provenance cannot be established safely, retain an explicit undelivered
  reason; do not silently mark it delivered. Include mixed-project digests.
- Reuse existing outbox claims and worker. Use destination-bound receipts and
  lease ownership for retry and delivery acknowledgement so an old pairing
  cannot complete work for a new one. Telegram completion must not consume
  future Slack/Discord/Teams or existing web-push delivery state. Use the
  existing web-push receipt pattern where suitable; no new event bus.
- Persist confirmed Telegram message identity with its exact task/project/run
  when available, for the later reply-routing slice. Preserve current callback
  and reply behavior, no new actions or blanket authorization in this slice.
- Honor Telegram `retry_after`, recover claims after restart, maintain ordered
  task updates and bound message size. Document ambiguous send-timeout duplicate
  risk rather than promising exactly-once network delivery. Do not advance
  inbound polling acknowledgement ahead of durable handling.
- Extend existing focused Telegram/store tests: two projects, mixed digest,
  changed enrollment, revoked or replaced pairing during asynchronous sends,
  crash/retry, stale acknowledgement, rate limit, and unaffected web-push
  receipts. Add only missing regressions, not overlapping test suites.
- Leave a concise transition-producer and action-parity inventory showing what
  exists and what remains. This first slice is not full conversational parity.

Read current official [Bot API](https://core.telegram.org/bots/api#getupdates)
and [Bot FAQ](https://core.telegram.org/bots/faq) for acknowledgement, retry and
message-rate behavior. Keep the existing polling transport and plain messages;
new rich-message APIs are not a requirement. No paid broadcasts or API fallback.

Use GPT-6 Astra for the builder and repairs, with the project's independent
Opus review and existing subscription authentication. Run affected tests and
typecheck during implementation, then the unchanged native full gate once.
Record the exact candidate and distinguish mocked transport verification from
live acceptance. No live Telegram sends, token reads in test output, credential
changes, new pairing or live database migration during the build. Use isolated
fixtures and preserve installed runtime and other projects.

The phone candidate passed all four independent criteria and the 3,061-test
native gate. Candidate c29b6a9 is deployed and merged into this input branch
before its first dispatch. The prior deployment hold can now be released.
Never move the baseline after dispatch.

### 1. Reliable updates and replies

Inventory existing notification/outbox producers before changing delivery.
Reuse them where possible; do not add a second task scheduler or event bus.

- Record every user-visible transition: created, awaiting plan approval,
  queued, started, waiting with its reason, recovering/retrying, reviewing,
  result ready, revision created, stopped, cancelled, and publication outcome.
  Preserve distinctions between built, verified, accepted, and published.
- Default this owner's subscription to all authorized enrolled projects,
  including future enrolled projects under an explicit all-project selection.
  Never infer visibility from unrelated database rows or recently opened paths.
- Send concise updates: project/task, changed state, and one precise next action
  when needed. Deliver each transition, not just the latest snapshot. Exclude
  unchanged heartbeats and token streaming; keep detailed logs on demand.
- Persist delivery progress; retry network failures and rate limits after
  restart. Keep per-task ordering and prevent routine duplicates. Do not
  promise exactly-once Telegram delivery after an ambiguous network timeout.
- Bind every reply and button to stable project, task, run, and message IDs.
  Ask which task when context is ambiguous; never guess what “approve it” means.
- Show disconnected/delivery-failed status and recovery in integration settings.
  Disabling or unpairing stops sends, including previously queued messages.

### 2. Full conversation and shared actions

Route ordinary Telegram text through the existing unified chat engine, with
its configured subscription provider. Do not introduce a separate agent or
default to a paid API. Preserve deterministic shortcuts for cheap status reads.

Inventory every current agent action and give it a channel-parity acceptance
row: web, CLI, Telegram, authorization, evidence, and any secure handoff.
At minimum cover:

| User intent | Shared behavior |
| --- | --- |
| Create work | Select the project, file a task, plan/scope it using existing modes |
| Get updates | Read all authorized projects, task history, waiting reason and next action |
| Steer work | Change supported task settings, answer questions, hold, stop, resume, and repair dependencies |
| Approve a plan | Show exact current terms, authenticate the actor, reject stale/replayed approval |
| Review a result | Show actual checks, screenshots, changed files and remaining gaps |
| Request changes | Apply feedback to the exact result and create a revision in the same task family |
| Save a note | Save without starting work only when explicitly requested |
| Other agent actions | Use the same existing service and permissions; document any unsupported action |

Keep proposals and confirmations compact. A reply requesting changes should
not silently become a saved note. Changes made in any channel must appear in
the others with actor, source channel, task and result identity intact.

Use durable inbound receipts and transactional shared actions so reconnects,
repeated Telegram updates, concurrent web actions, and button replay cannot
create duplicate tasks or revisions. Continue the appropriate conversation
without merging unrelated task contexts or escalating its project visibility.

### 3. Proof, CLI parity, and a real cross-channel trial

- Deliver authorized screenshot previews and concise verification summaries.
  Offer authenticated, reachable detail links or safe file delivery, never a
  localhost-only link presented as usable from the phone. Do not expose logs,
  secrets, local paths, or arbitrary project files automatically.
- Finish CLI parity through the same services, including structured output for
  automation and clear confirmation/refusal results. No separate business rules.
- Keep a small channel interface around these existing services so later chat
  integrations can reuse them. Do not build other integrations in the Telegram
  task; they are the explicitly requested follow-on sequence below.
- Exercise one real task: create in Telegram, inspect in web and CLI, approve
  when required, receive progress, review proof, request a revision by reply,
  and inspect its result in the original task family.

## Authorization and practical boundaries

Keep the existing paired private chat, immutable sender ID, live approver
generation, enrolled-project boundary, and one-time action checks. Revalidate
authorization before delivery and mutation. Groups/strangers/forwards do not
gain access. Pairing is not blanket permission to bypass task safeguards.

Honor the configured auto-approval mode. Where manual approval remains required,
prefer a scoped, revocable authorization established locally; assess whether it
can safely support the existing approval contract. If fresh authentication is
required, offer a secure web handoff instead of collecting passwords in Telegram.
Document that exception rather than claiming universal inline approval. Do not
send credentials, silently publish code, or expand global execution permissions.

The host and bridge must be online. Queue missed outgoing transitions durably;
be honest about inbound messages Telegram no longer retains during long outages.
Use the existing polling transport unless a concrete requirement needs webhooks.
Telegram documents polling acknowledgement and rate limits in its
[Bot FAQ](https://core.telegram.org/bots/faq); check the current
[Bot API](https://core.telegram.org/bots/api) when implementing retry and media
handling. Do not enable paid broadcasts.

## Acceptance and lean verification

Use focused regressions for missed/replayed updates, rate limiting, restart
recovery, wrong sender/project, revoked pairing, stale approvals, concurrent
actions, safe evidence delivery, and ambiguous replies. Reuse existing bridge
and shared-action tests; run the approved full gate once per final candidate.

Inspect actual web desktop and phone views plus the Telegram conversation:
short copy, one action, long titles, failures, and readable evidence. Record
the real task IDs, candidate, delivery receipts, screenshots, and manual steps.
Scripted Telegram transport tests are not proof of a live phone journey.

Implementation is sequential after deployment. Keep the follow-up held until
that prerequisite is verified; then scope the first slice against this plan.
Do not broadcast project data, rotate credentials, or start a competing worker
while the current rollout is in progress.

## Next connectors: Slack, Discord, Teams

Requested 2026-09-15 after the Telegram plan: deliver Slack, then Discord, then
Microsoft Teams on the same shared conversation/action services. These are
planned, not implemented or connected. Each connector gets its own bounded task
after Telegram's real end-to-end acceptance.

- One authoritative task state, action implementation and permission check.
  Channel adapters handle identity, delivery, reply/thread context, buttons and
  evidence rendering; they do not become independent agents or schedulers.
- Maintain a tested action inventory for every unified-chat capability, with
  web, CLI, Telegram, Slack, Discord and Teams coverage. Adding an agent action
  must update that inventory so connector support cannot silently drift.
- Support task creation, updates, scope approval, steering, hold/stop/resume,
  supported dependency repair, result/proof inspection and same-task revision.
  Preserve the distinction between a saved note and a request that starts work.
- Private identity binding comes first. Workspace/server/tenant and channel
  membership do not automatically grant project access or approval authority.
  Default private; posting into shared channels needs an explicit destination
  and visibility selection. Never broadcast every project to a newly installed
  workspace or team merely because the app can see it.
- Replies bind to the exact task/result across threads. Ask when ambiguous;
  refresh stale buttons and reject replay. Web/CLI edits appear in the channel
  and channel actions appear in the unified UI with actor/source recorded.
- Respect platform limits with durable queues and visible delivery recovery.
  Provide concise native messages/cards, evidence previews and secure detail
  access without exposing credentials or making local links look phone-ready.
- Pairing, app installation, scopes and any workspace-admin consent are explicit
  setup steps, not permissions the agent invents. Use current official platform
  documentation at implementation time; do not ask for secrets in chat.
- For each connector, run one real task through creation, approval when needed,
  progress, proof and a reply-driven revision; verify shared state in web and
  CLI, and test wrong-user/project, stale/replayed action and delivery outage.
  Stubbed transport tests alone do not qualify a connector as live-ready.
