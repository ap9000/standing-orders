# Make the Telegram conversation ready for a real trial

This is a same-family revision of Telegram build1663, not a new chat system.
Read AGENTS.md, the original conversation implementation brief and the parity
matrix. Their historical baseline/status is superseded here. The input merges
the existing Telegram candidate a29756 with accepted/deployed d864295, keeping
the review formatting and subscription chat fixes. Preserve those fixes.
Do not reset HEAD, switch branches or run candidate schema62 code on the live
schema61 database. Use disposable databases for all checks.

## Fix the reproduced recovery gaps

1. `runTelegramConversation` currently sends reply parts/cards directly, makes
   reply send failure terminal and can mark done after a card send fails.
   Persist the exact output and per-part state before sending, reuse existing
   destination-bound retry/delivery machinery and honor Telegram retry_after.
   Only confirmed message identities count as delivered. Restart resumes unsent
   parts without another model call, proposal or task/revision. Recheck current
   pairing and project access before each outgoing part. Lost network responses
   are uncertain; do not claim exactly-once sends that Telegram cannot provide.
2. Resolve and persist the original session/thread/request binding BEFORE the
   first provider dispatch. Current code binds only after the turn returns and
   resolves today's active session before looking up its session-scoped receipt.
   A crash followed by an ended/replaced session must recover the original
   outcome, or truthfully report an unfinished attempt, never dispatch anew.
   Keep the atomic inbound row before polling acknowledgement and renew claims.
3. Revalidate channel access before every next provider dispatch and shared
   action, after async lookups. Preserve branded principal/generation/claim
   checks. A pairing or enrollment change between model steps stops the turn
   without sending project data or executing another tool. No new scheduler,
   model rerouting, permission broadening or agent time limit.

## Tests and evidence

Extend existing suites, not a new test framework. Reproduce each issue first.
Cover reply and proposal-card outages,429/retry_after, missing message id,
restart after a confirmed part, uncertain network response, and crash while
the original session ends or is replaced. Assert original request/turn identity,
provider call count, task/revision identity, per-part progress and source audit.
Include revocation/enrollment change between steps and true interleaved console
confirmation versus Telegram tap. No second task/action should be created.

Retain one integrated scripted journey through the production bridge:
ordinary text -> proposal -> confirm -> shared/web/CLI state -> status/proof ->
reply to the exact result -> same-family revision. Include the existing
auto-approval mode path so approved revisions can run unattended under the
same signed policy. Preserve the manual-approval path; never collect passwords
or API keys in Telegram. Test the parity matrix's how/remaining-gap columns,
not just its list of tool names, and label handoffs as incomplete phone actions.

Typecheck and affected tests once during implementation. The native final gate
runs the unchanged approved full command once; do not duplicate it in builder
or reviewer. Do not add skips, rewrite evidence or waive failed checks. Include
changed-path and check evidence for all inherited and repair criteria. If a
minimal additional migration is necessary, exercise it from the exact deployed
schema61 and existing candidate62, preserving rows/constraints and rollback.

## Keep the scope lean and the claims honest

Keep shared engine/doors/result-actions and production up/follower/pass wiring.
No Slack/Discord/Teams, event bus, broad status-event expansion or media upload
framework in this recovery revision. No root worktree edits, live DB writes,
service restart, credential changes or deployment from the builder.

Real Telegram acceptance remains pending: no bot is configured or paired. Root
will deploy only a verified and accepted candidate, then the user connects
their bot locally. Fixture success is not a live phone result. Keep screenshots,
scope approval, resume/cancel/settings handoffs and other actual gaps explicit
in the parity matrix; do not label a computer-only instruction as full phone
support. These are subsequent feature slices, not reasons to widen this repair.

## Implementation record (2026-09-16, fixture-verified, not a live trial)

Built as a same-family revision on `db5e213` (the merge of candidate
`a29756` with accepted `d864295`); the review-format and subscription-chat
fixes are untouched. What changed, by gap:

1. **Durable output.** `telegram_conversation_part` (schema v63, additive;
   `migration-v63-telegram-delivery.test.ts` upgrades from the exact v61 and
   v62 shapes and their sentinels, keeps every conversation row and token,
   and shows the rollback as the wind-back). `runTelegramConversation` plans
   the whole outbound half — reply parts and cards, tokens minted with them
   — in one transaction before any send, then sends each part fenced on
   the claim, the live pairing and the session's ceiling digest. Sent means
   a confirmed message id and nothing else. `retry_after` writes the
   outbox's bot-wide `telegram_retry` row, so the conversation and the
   outbox pause together; other refusals and lost answers back off
   (5s, 15s, 60s, 5min) with `uncertain` counted on the part, and the pass
   report names the wait. A restart resumes from the first unsent part
   without a model call. A card whose proposal was already acted on is
   dropped as moot; a changed ceiling fails the row `unsent:…` and tells
   the phone without project data; unsent parts give up explicitly after
   the card lifetime. Exactly-once is not claimed: a lost answer may have
   reached Telegram, and a resend then duplicates — the row says so.
2. **Original binding.** `bindTelegramConversationSession` records the
   session before the first dispatch. A later attempt reads
   `mateRequestReceipt` in that session first — whatever session is live —
   and recovers the original turn's outcome: answered → parts planned and
   sent; running past its deadline → swept and reported as crashed;
   superseded by the console ending the session → reported as such. No
   receipt means no dispatch happened, and only then is a fresh session
   resolved. The inbound row still precedes acknowledgement; claims renew
   as before.
3. **Revalidation.** The engine's hook runs before admission, before every
   provider dispatch, after every provider wait and before every tool, with
   local authority re-read after each awaited lookup (see
   `TELEGRAM_DISPATCH_REPAIR_2026-09-16.md`); the bridge now re-proves
   pairing and ceiling before every outgoing part after the registry read,
   and a tap's principal is minted against the ceiling read for that
   update. Tests cover unpair and unenroll between two model steps.

Evidence lives in `src/telegram-mate.test.ts` (outage, 429, no-id, restart
after a confirmed part, moot card, unenrolled while waiting, session
replaced after an answered and after an unfinished attempt, between-step
revocation, tap-then-console and console-then-tap orders, and the reply-to-
result journey under a signed automatic-approval mode alongside the manual
one) and `src/migration-v63-telegram-delivery.test.ts`. The parity matrix is
checked column for column (support, how, remaining gap) and every handoff
row is labelled an incomplete phone action.

Best-effort notices (a refusal, a failed turn, a changed ceiling) carry no
project data and are still sent once without persistence; the row's
outcome records the refusal regardless. Real Telegram acceptance remains
pending exactly as stated above: no bot is configured or paired, and
fixture success is not a live phone result.
