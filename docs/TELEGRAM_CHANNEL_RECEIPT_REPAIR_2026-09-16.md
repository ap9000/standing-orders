# Keep failed Telegram updates visible

Source: run 1684, candidate `29dca8d633a875ccdcc4b3eb262de375aa53129a`.

Independent reproduction: a genuine lifecycle update delivered through the
shell/webhook channel, then refused by Telegram, disappears from the console's
delivery-trouble count. The Telegram receipt correctly records the failure;
`pendingForAttention` loses it by first filtering on the older global delivery
timestamp. This is a presentation/counting bug, not a missing send retry.

## Prepared correction

`pendingForAttention` now selects the union of unresolved non-lifecycle pending
rows and unresolved rows with a failed current Telegram destination. A different
channel's successful receipt cannot remove a Telegram failure from that union.
Resolved facts, revoked pairings and policy-held rows stay excluded. Successful
Telegram retry clears the count without changing the other channel's receipt.

One regression in `src/task-notifications.test.ts` uses the real producer and
scripted transport, persists/reopens the database, then retries successfully.
No schema, scheduler, delivery mechanism or UI layout changes are needed.

## Verified on the prepared patch

- Typecheck passed.
- 175 tests passed across task-notifications, telegram and store.
- Independent mixed-channel reproducer now reports the failure visible.
- Independent privacy and atomic-hold reproductions still pass.
- `git diff --check` passed.

No full suite was duplicated. Standing Orders must run the unchanged approved
command once at the native final gate for its new candidate. Review this narrow
change and preserve the prior lifecycle work; do not reimplement it. A real bot,
paired phone and Tailscale HTTPS journey remain unverified.
