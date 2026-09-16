# Telegram: finish an action from the phone

## Starting point and outcome

Build on accepted/deployed `841b0eb7bcdbec611fa513857e1ac601d7e2cc21`
(schema63). This is a narrow transport/navigation improvement, not another
task engine. Preserve its durable reply delivery, real-adapter uncertainty,
fresh authority checks and exact same-family revisions.

Today some cards say "on the computer", have no usable button, or tell users
to approve work that their signed automatic mode already approved. A browser
GET to an exact result redirects to `/login`, and successful login redirects
to `/`, losing the original result. Fix those gaps together: one precise
Telegram button, ordinary sign-in, then the exact existing control/result.
Opening a link never approves, resumes, cancels, publishes or otherwise acts.

## Concrete implementation

1. Reuse installation `loadConsoleUrl`/`saveConsoleUrl` in `webhooks.ts`.
   Add no second persistent Telegram URL setting. Phone links require an
   operator-configured canonical HTTPS origin: no credentials, path prefix,
   query, fragment, loopback/localhost or opaque/relative destinations. The
   current generic webhook setting permits HTTP/path prefixes; preserve that
   behavior for unrelated consumers but refuse those as phone origins. Never
   trust a model URL, incoming Host header, or arbitrary proposal field as the
   base. Where a co-hosted console has `--public-url`, mismatch must produce no
   phone link; pass that known server origin through existing context. External
   standalone bridges can use their explicitly configured console origin.
   Configuration must be re-read by both bridgePass/followBridge/watch paths
   after changes, including delivery retries. Do not persist a URL that can
   silently outlive a changed/removed configuration. Do not probe arbitrary
   URLs or claim reachability simply because syntax is valid.
2. Use fixed `chatControlHref` destinations and actual stored task/result
   identities. A result link binds exact run AND execution/project, never the
   latest run by guess. Add a specific URL button to non-confirmable controls
   (approval/planning/cancel/recovery/publication/settings etc.) and to the
   relevant outcome of confirmed scope/agent/task/manual-revision/resume
   proposals. Retain confirm/dismiss callback tokens for real in-chat acts;
   a URL button is navigation, never authority. `/task` should offer the exact
   result's Checks/Changes when that recorded result is authorized, otherwise
   the appropriate task action. Avoid duplicate buttons or a button that lies
   about what happens next. No Telegram Login widget, Mini App, rich-message
   framework, bearer link, credential in a message or new mutation endpoint.
3. Use outcome/state facts, not an `/approve/` word search, to distinguish
   automatic approval, manual approval and actual resumed/queued/running work.
   Do not append "approve" to an auto-approved outcome. A staged resume says
   what remains, not "resumed". With no valid phone origin, show one concise
   missing-setup explanation; do not emit localhost or promise phone parity.
   Fix affected help/parity wording as part of the same change.
4. Preserve safe return destinations through normal login: unauthenticated
   GET, failed sign-in, successful sign-in, exact task/query/result tab.
   Reuse/strengthen existing `safeReturn`, not a second redirect framework.
   Refuse external/protocol-relative, backslash, control-character/encoded
   bypass and recursive-login destinations. No secret query propagation;
   use allowlisted app destinations if needed. Authentication, allowed-host,
   HTTPS, SameSite, CSRF, fresh approval terms, project authorization and stale
   card checks remain unchanged. A changed/stale result must not silently send
   a person to a different execution. Query fragments do not reach the server;
   ensure generated approval links remain useful after sign-in without relying
   on a fragment being secretly transmitted.
5. Keep durable delivery unchanged. Generate current URL buttons from trusted
   persisted proposal/result identity immediately before sending/editing;
   existing pending-part retry should not replay a stale URL. Preserve fresh
   pairing/enrollment checks across awaits. URL-only controls must not be
   minted as confirm tokens. Do not add schema versions or store a new queue.
   A shared button union/type may be widened only if the existing JSON needs
   it, with callback placement operating only on real callback tokens.

## Lean verification

Extend the existing `telegram-mate`, `telegram`, `telegram-status`, `operate`,
`webhooks` and `serve` tests only where affected. Typecheck plus focused tests
in implementation; unchanged approved full suite ONCE at native machine gate,
never again in independent review. Do not add parallel overlapping suites or
new orchestration to test links. Include:

- actual production wiring, configured/unconfigured/mismatched origin,
  credentials/path/query/fragment/HTTP/loopback refusal and config removal or
  change during an existing follower/retry;
- exact task/result button after confirming task/scope/agent/manual revision,
  automatic-mode outcome without a second approval instruction, staged resume,
  cancel/settings and read-only `/task` result; exact source feedback retained;
- stale/foreign result, revoked pairing/project or account across awaits,
  duplicate confirm, interrupted send/restart; no extra model call/mutation;
- unauthenticated deep link -> failed login -> successful normal login -> exact
  task/result; external/encoded redirect attacks remain local and no GET acts.

Use realistic short/long/error fixtures. Keep one title, useful outcome and
one precisely named primary action; remove repeated helper paragraphs. Preserve
full terms where consent happens. No new CSS redesign is necessary. Record
concise before/after examples and exact checks. Root will inspect an actual
desktop and phone-width journey on the accepted candidate before claiming
phone readiness; do not invent screenshots if no browser is available.

The actual bot remains unpaired and Tailscale account approval is pending.
Do not touch live DB/config/pairing, request secrets, change tailnet permissions,
send real messages or deploy from the builder. Fixtures prove the implementation,
not an actual Telegram/physical-phone/OS-reboot trial. Report that limitation.

## Not this task

No lifecycle-producer expansion, screenshot upload, Slack/Discord/Teams,
provider/model changes, retention/cleanup, scheduler/event bus, migrations,
new permission bypass, agent timeout, public exposure, release or deployment.
Those remain following slices. Do not import an unrelated old branch or edit
the dirty operator checkout. Seal proof through the normal existing format;
validate its parser/short exact references before handing off.

## Reference

[Telegram InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton),
checked2026-09-16: a standard button has one action type, such as `url` for
navigation or `callback_data` for a callback. Use the ordinary URL type here,
not `login_url`, and keep the existing authenticated web app responsible for
the actual action.
