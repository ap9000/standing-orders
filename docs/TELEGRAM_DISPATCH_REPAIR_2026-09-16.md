# Close two production-path Telegram recovery gaps

This is a small follow-up to same-family builder 1669, candidate
`b6ca9b7f231cce8749eda5c86ae0126c8f13280a`. Preserve its durable delivery,
original-turn recovery, migration 63, shared action doors and parity matrix,
and the accepted chat transport fixes inherited from d864295.

## Reproduced defects

1. The real `createTransport` catches lost network acknowledgements into
   `{ ok: false }`. The conversation deliverer counted only a throwing fake
   transport as uncertain, so production acknowledgement loss incorrectly
   stored uncertainty zero. A full bridge fixture using the actual HTTP
   adapter reproduced it with mocked fetch and no external request.
2. The engine revalidated the channel before admission and after provider
   responses, not before each next dispatch. A changed channel was detected
   only after a second provider had already received context. The reproducer
   expected one provider call and observed two, then a revoked outcome.

Disposable reproducer (no live DB or network):
`/tmp/standing-orders-telegram-production-audit-EJ1nta/reproduce.mts`.
It accepts a source checkout path as its first argument; run it with the
checkout's installed `node node_modules/tsx/dist/cli.mjs`.

## Prepared minimal implementation

- `TelegramTransport` carries explicit uncertainty for lost, aborted or
  malformed acknowledgements; a valid Bot API rejection remains definite.
  The conversation module imports the same transport type, rather than a
  duplicate result contract. Delivery preserves uncertainty through retry
  and success, using the existing counters/backoff/confirmed-message rules.
- `runMateTurn` checks channel authority before every provider dispatch and
  before subsequent tools in a batch, retaining the post-response check.
  Local principal/session/thread/turn state is read after each awaited
  channel lookup, in the same continuation before the next action.
- No schema change, scheduler, new provider, approval bypass, time limit,
  live configuration mutation, or new test framework.

The prepared patch is available on branch
`codex/telegram-dispatch-repair-20260916`, checkout
`/tmp/standing-orders-telegram-dispatch-repair-g6uqlR/tree`.
The native repair should inspect and apply the source/test delta from b6ca9b7
without changing its own HEAD, then improve only if a concrete issue remains.
Do not rebuild these fixes as a parallel architecture or widen to the phone
handoff, notification-expansion or media-upload feature slices.

## Focused evidence before native execution

- Typecheck passed.
- `src/mate.test.ts`, `src/telegram-mate.test.ts`, `src/telegram.test.ts`:
  132 tests passed. The test setup also built the local disposable runtime.
- A final small guard refinement removed an extra async boundary; typecheck
  and the affected `mate.test.ts` rerun passed (41 tests). Telegram code was
  unchanged by that refinement.
- Both original standalone reproducers pass against this prepared checkout:
  acknowledgement-loss uncertainty is 1, and only one provider call occurs
  before access rejection. These are fixture results, not a real bot trial.
- New regression coverage is confined to the existing suites: the actual
  adapter's network/abort/invalid-JSON/invalid-envelope paths, durable retry
  without a second turn, API and subscription next-dispatch fences, and
  account/session changes during awaited access checks. Existing rate-limit
  tests retain definite-rejection behavior.

This prepared patch is NOT accepted or deployed. The native final machine
gate must run the unchanged full approved command once for its new sealed
candidate, followed by independent review. Do not reuse b6ca9b7's successful
gate as proof of these changed bytes, duplicate a successful full suite in
the builder/reviewer, skip tests, import verdicts or touch the live schema61
database with candidate schema63 code.

No UI layout changed. Keep the phone-only gaps truthful: Tailscale Serve
still needs account setup, no real bot is configured/paired, and secure phone
handoffs, direct screenshots and all-lifecycle notifications are subsequent
slices. No deployment, token/pairing changes or GitHub/npm release by builder.

