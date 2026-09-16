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
