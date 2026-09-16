# Telegram: the same chat, from your phone

Implement the conversation slice on verified/deployed 4bad388. Read
AGENTS.md, TELEGRAM_CONVERSATION_RECON_2026-09-15.md and the shared-chat plan.
This brief supersedes their historical base/model/status references. All
phases use the task-pinned Claude Fable 5.1 subscription route.

## Deliverable

Ordinary private Telegram messages use runMateTurn and the same saved thread,
proposal records, shared confirmation doors and result-actions as web/CLI.
Keep cheap /status, /task and /help. Replying to a result to request changes
must target that exact task family/result, not silently save a decision note.
Preserve explicit decision-note replies and legacy decision buttons.

Provide concise proposal previews and stable confirm/dismiss controls using
confirmMateProposal. Support all existing safely confirmable shared actions,
not a second hand-coded create/hold/revise implementation. Keep fresh-auth
actions behind their existing secure handoff; never collect passwords or
pretend a link performed an action. Honor task auto-approval settings without
changing global policy. Truthfully record Telegram as the source throughout.

Use the existing configured subscription chat provider and session. Reuse a
compatible web/CLI session/thread; never terminate an unrelated conversation
or widen its project access. If no compatible subscription session exists,
establish it through a validated paired-actor path with current terms, not
with a forged principal. Do not silently opt in to direct API spending.

## Boundaries and reliability

- Authenticate current private chat AND immutable sender, bot, binding,
  approver generation and enrolled-project ceiling before any model call.
  Revalidate pairing/enrollment after waits, before tool actions, before
  confirmation and each outgoing part. Existing account-generation checks
  alone are insufficient. Runtime-branded principals only, no structural casts.
- Durable inbound handling must precede polling acknowledgement. The current
  markTelegramUpdateApplied + best-effort effects path cannot hold an async
  model turn: persist its exact binding/update/request identity and state.
  Reuse mate request receipts and outbox/destination delivery machinery. After
  a restart/replay, recover the original outcome without another task,
  revision, approval or provider dispatch. A failed or uncertain provider
  attempt stays truthful rather than silently starting over.
- Long turns must not lose the bridge lease and allow a competing poller.
  Reuse existing lease renewal or durably queue then process without holding
  a SQLite transaction over async work. Do not add a second scheduler.
- Replies/buttons bind to exact task/project/run/proposal/message. Ambiguous
  references ask which task. Reject stale cards and wrong sender, chat,
  forwarded/via-bot/edited messages; never infer authority from message text.
- Handle Telegram limits and rate limits through existing splitting/retry.
  Do not silently truncate user instructions beyond mate's 2000-char bound.
  Do not expose secrets, arbitrary files, local paths, or localhost links as
  phone-ready. Proof replies show actual verification summaries and disclose
  if screenshots/secure remote detail access are not yet available.

## Scope discipline

Implement ordinary conversation, shared proposals and exact reply revisions
first. Keep destination-bound delivery foundation intact. Maintain a concise
matrix sourced from MATE_TOOL_SCHEMAS: direct action, secure handoff, or missing,
with tests and explicit remaining gaps for every action. Do not claim full
integration solely because create/status/revision examples pass.

No new Slack/Discord/Teams adapter, all-transition producer expansion, media
upload system, event bus, retention cleanup, permission changes, model/provider
upgrades or historical manifest repair. Minimal schema migration is permitted
only for necessary durable inbound/channel-context bookkeeping, with existing
migration tests. Existing tests/frameworks first. A small telegram-mate module
is allowed if it keeps transport separate from shared actions.

Production wiring is required in both bridge pass/follower and the normal up
worker. Tests that only invoke a helper are not end-to-end coverage.

## Evidence and verification

Use isolated fixtures and injectable Telegram/model transports. Extend existing
telegram, telegram-status, mate, mate-doors, principal and store suites as needed.
One integrated fixture journey must create a task through ordinary text,
confirm using Telegram, inspect the same state through shared/web/CLI APIs,
read result evidence, and request/confirm a same-family revision. Include
replay/restart and concurrent web confirmation without duplicate work.
Cover pairing revocation and enrollment change while the provider waits,
wrong sender/project, stale buttons, long text and ambiguous result replies.
Assert actual source-channel audit, not just response strings.

Typecheck and focused tests during implementation. Leave the unchanged full
command to the native final gate ONCE. No new skips/frameworks/agent timers.
Machine evidence must come from tests included in that command; don't create
a standalone check and assume the reviewer can use an unbound claim. Validate
the normal proof/handoff before exit; preserve failures and exact executed
commands. Independent review uses sealed evidence, not a second full suite.

## Live acceptance limitation (known before build)

Read-only bridge status on September16: token absent, paired false. No real
Telegram sends or live phone journey can be claimed. Do not create credentials,
pair a stranger, read/print secrets, mutate the live DB or restart/deploy from
the builder. Root will deploy an accepted candidate safely, then the user
connects their bot in settings for a real trial. Record this gap separately
from the automated implementation criteria. No new permission grant inferred.

Protocol references checked September16:
- https://core.telegram.org/bots/api#getupdates (acknowledgement via offset)
- https://core.telegram.org/bots/faq (polling and rate limits)

Keep plain messages/buttons; new rich-message APIs aren't needed for this slice.
