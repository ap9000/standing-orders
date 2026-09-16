# Integrate Telegram delivery with complete first-review evidence

Ready for native integration on September16. The first-review evidence fix is
accepted and deployed as `64e81727133c7a791a38c6cec9ee7bba02419415`.
Its native gate passed3153 tests; independent Fable1652 upheld all four signed
criteria, and the user explicitly accepted its manual-review row. GitHub and
local main point to that candidate; the installed worker now has the corrected
Claude review schema. Do not repeat the historical review or bootstrap scripts.

## Start from the right version

This brief and its two companion planning documents are committed on that exact
code baseline before first dispatch. The input commit is docs-only. Pin the
native task to this input commit; do not move its baseline after dispatch.
Use Claude Fable5.1 (`claude-fable-5-1`) for plan/build/repair and independent
review, reusing the existing logged-in subscription. This current instruction
supersedes the older Astra/Opus wording and deployment statuses in the historical
shared-chat plan. No global model, provider permission or paid-extra changes.
Do not import the obsolete schema62 draft. The task title in old evidence is
historical: the user rejected a manual refresh feature.

## Bounded change

Integrate the two existing Telegram delivery commits, resolving conflicts while
preserving the newly verified evidence and review code:

- `87551dafc9c1d4e457bcd62d4f36988340b5dfb3`, parent
  `9cc5ef158b626fbf1cca48b5c76ca6e1968a9499`: typed notification provenance,
  live authorization checks, destination-specific delivery receipts and retry.
- `3102879d2c38d6ef925f26c3e5c9e30110aaf3b8`, parent the commit above:
  prevent blocked legacy or unenrolled digest rows from starving valid updates.

These are source inputs, not accepted final output. Read their committed
`docs/TELEGRAM_DELIVERY_FOUNDATION_2026-09-15.md` and candidate record. Do not
overwrite newer files wholesale or lose reviewer receipt/context guards.

Keep the delivery scope unchanged: existing paired private Telegram transport,
typed project/task provenance, per-destination claims, exact receipt ownership,
restart/rate-limit recovery, per-task ordering, and existing deterministic
commands/replies. Retain blocked rows and explanations. Never infer authorization
from message text or mark unsent data delivered. No new scheduler or connector.

Inspect schema compatibility rather than merely bumping the version. If the
verified evidence fix remains schema 60, preserve the exact Telegram 60-to-61
migration and reader fencing. No two incompatible formats may share a version.
Old notification provenance stays unknown; do not backfill authority from text.

## Acceptance

1. Both Telegram changes work on the verified evidence base without regressing
   first-review full-file delivery, gate receipts, or existing web/CLI behavior.
2. Restart, rate limiting, duplicate/stale claims, pairing/enrollment changes,
   and mixed legacy/unauthorized/valid digests retain correct authorization and
   ordering. Valid updates flow without leaking blocked project content.
3. Upgrade/reopen preserves historical rows, IDs and receipts; old incompatible
   readers refuse the new format. Test against isolated databases only.
4. The first independent reviewer receives the relevant complete Telegram tests
   and sources, exact candidate/check receipt, and honest remaining gaps. No
   manual refresh, rewriting the old review, or waiving a cannot-tell judgement.

Use existing focused suites during coding, then the unchanged native full gate
once for this new combined candidate and independent Fable review. The old
Telegram gate does not cover this integrated candidate. Ensure proof explicitly
names restart/rate-limit coverage in `src/telegram.test.ts` so the reviewer can
inspect it, not merely trust a test count.

Before sealing the result, map each criterion to concrete implemented code and
executable regressions in the existing proof format. Cite the exact relevant
test paths, not just the plan document or a command name. Preserve complete
source evidence for restart/retry behavior, digest isolation, authorization,
migration and first-review delivery. An agent's manual-grep statement is not
proof of behavior or absence: supply inspectable assertions and their bound
machine result. Do not label an unchanged file a changed path to make it fit;
use supported context evidence and keep any unsupported gap explicit.

Root already reproduced and confirmed the digest repair in three isolated
cases on 3102879; reuse its fixture design, not its result as proof for new code:
`/tmp/standing-orders-telegram-review-t7NAO2/digest-isolation.mjs`.
The earlier private migration rehearsal is likewise historical, not a fresh
deployment backup. No live sends, credential changes, pairing changes or live
database migration during the build.

## After review

Inspect all criterion judgements and exact final diff. Only a verified,
independently accepted combined candidate qualifies for the guarded deployment.
Check UI and all project workers afterward. This finishes delivery foundation,
not full Telegram conversational parity.

The next body of work is in `docs/TELEGRAM_CONVERSATION_RECON_2026-09-15.md`:
shared chat/actions, exact reply identity, proof and a real cross-channel
journey. Slack, Discord and Teams remain held until Telegram acceptance.
