# Existing chatbot as the phone-control surface

Local implementation; not installed or pushed. No schema change, second chat
engine, background agent, new model configuration, or permission bypass.

## What changed

- Native message POSTs carry an opaque send ID and conversation binding.
  Admission, operator message, and receipt commit together. The receipt retains
  only a digest and turn ID in the existing mutation ledger.
- Replaying the same text/task/session returns the original turn. Changing
  its text or task context refuses. Busy/readiness refusals do not consume
  the ID; a previously admitted failed turn is not automatically restarted.
- The authenticated status endpoint exposes only this approver's conversation,
  pending/version markers, and receipt boolean, not message or task contents.
- The mobile composer stays available for a draft during a reply. Drafts are
  scoped by conversation/task in tab session storage, expire after 24 hours,
  and clear only after acknowledgment or explicit conversation end. An offline
  client does not replay POSTs automatically.
- Bounded status polling reconnects on network/HTTP/malformed-response failure.
  It loads ordinary server-rendered cards when a reply changes, never inserts
  password ceremonies via fetched HTML, and waits while an input is focused.
- Mobile context is compact: optional project drawer, collapsed overview,
  composer before starter prompts, and an anchor on the current reply/action.
  Existing scope, task, revision, and confirmation authority stays unchanged.

## Verification

- `npm run typecheck` and `npm run build`: pass.
- `npm test`: **159 files; 2,725 passed; 23 platform skips**, 47.52 seconds.
- Final composer ordering: **275 focused tests passed** in serve,
  chat-continuity, and mate-continuity, followed by typecheck.
- New deterministic coverage: completed/running duplicate sends, database
  reopen, provider failure, changed message/task, ended session/revoked
  credentials, secret refusal, failed admission/retry, CSRF and browser-only
  status access, draft restoration, storage denial, reconnect, double submit,
  and focused-input protection.
- `scripts/chat-phone-fixture.mjs` uses an in-memory SQLite database, a new
  temporary project, an ephemeral login, and an injected scripted subscription
  runner. No production DB, real model, worker, or remote is involved.
- Playwright mobile Chromium: normal login and conversation authorization,
  natural-language pause request, proposal card, confirmed pause; no horizontal
  overflow at 390×844 or 320×740. The send control stays inside the viewport.
- Offline emulation showed the reconnect explanation without losing
  `Next, check the small-screen spacing.`; reconnect loaded turn `1:answered`
  with that follow-up still a draft, not a queued instruction.

Viewport screenshots (not long stitched pages):

- [Ready](../../output/playwright/phone-chat-ready.png)
- [Reply in progress](../../output/playwright/phone-chat-pending.png)
- [Confirmation card](../../output/playwright/phone-chat-proposal.png)
- [Applied pause](../../output/playwright/phone-chat-confirmed.png)
- [Narrow phone](../../output/playwright/phone-chat-narrow.png)
- [Offline](../../output/playwright/phone-chat-offline.png)
- [Reconnected, draft retained](../../output/playwright/phone-chat-reconnected.png)
- [Desktop](../../output/playwright/phone-chat-desktop.png)

## Still unverified

Physical iPhone/Safari keyboard and background-tab behavior, the installed
native app's permission continuity, real subscription-backed execution through
to verified/published output, Windows native acceptance, and access from a
phone outside the current network. No tunnel or public exposure was created.
The earlier Developer ID/access installation gate remains separate from this
headless product work. Telegram free-form chat/media remains optional later
work, not a prerequisite for using Chat on a phone.
