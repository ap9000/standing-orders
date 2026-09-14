# Workspace package 2 — continuous chat, planning, and approval — 2026-09-13

Implements [the package 2 brief](WORKSPACE_2_BRIEF_2026-09-13.md) of
[the workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md) on
the seeded branch `53e7195` (`standing-orders/workspace-2-chat-20260913`),
which already carries packages 0/1, the concise UI pass, and the recovery-CTA
follow-up. Every change was left uncommitted for the worker to seal. No
`main`, live installation, real task, worker, provider, key, publication,
schema, scheduler, billing, permission, or global configuration was touched;
no dependency was added (Playwright is still loaded from the npx cache).

## What changed

### One journey from request to approved work (`src/serve.ts`)

- **Confirming a task proposal leads to the task it created.** The mate
  proposal door already records the filed id in the card's outcome; the
  confirm handler now redirects there (`/chat?task=<id>#task-chat-live`)
  when — and only when — the outcome is `ok`, its kind is `task`, and the id
  resolves as an admitted task lens. A refused, replayed ("already acted
  on"), or unavailable confirmation returns to the conversation exactly as
  before, with the door's own words on the card. The id is never inferred
  from prose or a title. The confirmed card itself now carries one clear
  road: `Open task <id> →` (tagged `data-filed-task`) beside the overview
  link.
- **The concise plan replaces the stacked ceremony summary.** The focused
  chat's action card (`taskChatApproval`) is now a section: *your next step
  → Plan ready — approve to start*, then four signed facts — **Goal**,
  **Changes** (the drafted plan's milestones when a plan document exists,
  else the paths it may touch), **Success checks** (the acceptance
  criteria), **Limits** (exclusions, report-only, attempt cap, permission
  posture, race terms) — then ONE **Review plan** disclosure. Opening it
  reveals the existing focused form unchanged: full goal, exclusions,
  paths, every criterion with its evidence kinds, agents ceremony, runtime
  limits, plan document and contract, revision batch and lineage, race
  terms, the composite digest, the nonce, the honeypot username field, the
  password, and **Approve & start** — the only primary submit on the
  region. Creation (the confirm door) and execution approval (the approve
  door) remain two acts, proven by the scope's `approvedAt` staying null
  between them.
- Before: the card was a `<details>` whose summary was itself the primary
  action ("Review & start") and whose body opened straight onto the long
  form; a filed task's card said "continue in chat · overview" and the
  confirmation returned to `/chat#latest`.

### Live updates over the existing status poll (`src/serve.ts`, `src/chat-continuity.ts`)

- **`/chat/mate/status` is the one refresh road**, extended rather than
  replaced. It still answers `session`, `pending`, and the send `received`
  receipt with the same cookie-and-approver, ceiling, and generation checks
  and `Cache-Control: no-store`. It now also answers `task` (the lens it
  rendered for), `approval` (the composite digest the form would bind), and
  `version` — a 16-hex digest of the DISPLAYED facts (`mateChatVersion`):
  message identities, card states and recorded outcomes, the decisions the
  cards name, the live turn and its step count, the last turn's state, and
  for a task lens its state, scope state, plan state, approval digest,
  consent-door state, live run, control, dispatch code/summary/detail,
  decisions, result, publication, milestones, plan revisions, and route.
  Relative ages, freshly minted nonces, and the csrf token are not facts:
  ten minutes of nothing happening is the same version. When the caller's
  `?version=` differs, the response carries three server-rendered
  fragments: `thread` (`#chat-thread`), `after` (`#chat-after-composer`),
  and `live` (`#task-chat-live`, or null). The page and the fragments
  render through the same `mateThreadHtml` / `mateAfterComposerHtml` /
  `taskChatLiveRegion` functions over the same `mateConversationRows`, so a
  live update can never show a card the page would not.
- **Fragments mint nothing.** `taskViewData` and `taskChatFocus` take a
  `mintNonce: false` render option used by the status poll and by the
  older `/chat/task-status` fragment; a five-second poll no longer churns
  the bounded nonce store, and no fragment ever carries a password form or
  a nonce (tested).
- **Stable identities.** Every thread child carries a `data-key`
  (`m<messageId>`, `pending`, `starters`, `coordinators`, `empty`, `said`);
  the message list and coordinator list are `data-chat-list` containers.
  The page reconciles a fragment by key: a node whose server rendering is
  unchanged (relative `<time>` text and `id="latest"` normalised away) is
  kept — with its open disclosures and its focus — and only nodes the
  server rendered differently are replaced. The composer is outside every
  region and is never touched: node, text, caret/selection, and focus
  survive every update (browser-proved on desktop and phone).
- **Reading anchor and New update.** Before applying a fragment the page
  notes whether the reader is at the bottom; if so it follows new content
  (the phone's fixed composer and tab bar are cleared by the existing
  bottom padding). Otherwise the top-most visible keyed node is re-anchored
  to its previous viewport offset and a real `<button id="chat-new-update">
  New update ↓</button>` appears (sticky above the composer; on the phone
  above the fixed composer and tab bar). It is reached by Shift+Tab from
  the textarea; Enter scrolls to the first unread node and moves focus
  there. Scrolling to the bottom by hand hides it. Only that act moves the
  reader.
- **One delegated submit handler** on the document covers every form the
  conversation renders now or later: the composer's enhanced send, the
  native prompt buttons (their value is the prompt; they gain the
  `request`/`request-session` bindings at submit if missing), and a
  double-submit latch (`aria-busy`) for card forms — so repeated refreshes
  cannot multiply listeners or requests. Cards that arrive live confirm once
  through their own native form after several polls (browser-proved).
- **Never under an open approval form.** If `#task-chat-live` contains an
  approve form, or the reader is inside the region, the live fragment is not
  applied. Every poll compares the region's `data-approval` with the
  server's `approval`; on a change the page inserts one `role="alert"`
  notice — *The plan changed since this form opened. Review the current
  exact terms before approving.* — disables the stale submit, marks the form
  `data-stale="1"`, and offers a **Review the current plan** button that
  reloads on the reader's act. The typed password, the old digest, and the
  old nonce are left exactly as rendered. The server stays the authority:
  the stale form, submitted anyway, is refused with the existing "the scope
  or plan changed while this form was open" answer (server- and
  browser-proved), and the reviewed page's fresh form approves.
- Before: a version change triggered `location.reload()` (deferred with
  "finish editing" while a field had focus), losing the reading position,
  open disclosures, and result selection; the task live region refreshed
  only while no approval form existed, so a scope edited during password
  entry went unnoticed until the server refused it.

### Sending, receipts, and safe failure (`src/serve.ts`, `src/chat-continuity.ts`)

- **The enhanced send is the same endpoint, fields, request receipt key,
  and session binding.** The composer's submit posts the native form data
  to `POST /chat` by fetch with `Accept: application/json`; the handler,
  unchanged in every check, answers `202 {ok:true, session, task, request}`
  or the refusal's words as JSON (`409` changed session / ended
  conversation, `400` empty message, `404` unavailable task, `403` standing)
  instead of a redirect. Without JavaScript, or from a prompt button, the
  native redirect path is untouched. A send is never retried by the page: a
  lost response leaves the draft marked submitted and says *Message not
  confirmed*; the status poll asks after that request key and the draft
  clears only on the server's receipt — a durable row written by the turn's
  own admission, so a reload restores the submitted draft and settles it on
  the same receipt (one turn, one provider dispatch). Resending the same key
  replays the same turn. An edit after a send rotates the request key: the
  older send settles on its own key while the newer words stay in the box.
- **Stale authority stops sending, never drafting.** `{session:null}`, a
  different session, a `401/403`/redirected poll, and an unavailable task
  each say so in their own words, disable the send controls, and show a
  **Reconnect** control; the visible draft and its stored copy are kept. A
  reconnection is the reader's act (a reload); the unsent words ride along
  as a NEW draft under the new session and a fresh request key — nothing is
  sent, and nothing from the old session is treated as received.
  `offline` disables sending with its own words; `online` re-enables and
  checks again. Denied storage keeps the draft on the page and says so,
  and sending still works. A `503`, non-JSON, or fragment-without-region
  answer changes nothing and retries in 10 s.
- **Task binding.** Each lens keeps its own same-tab draft
  (`chat-draft:<session>:<task>`); every poll and send names the lens's
  task, and an answer for another task (or a missing `task`) is ignored
  without touching the page. The provider request for a focused send
  carries `Current task: <id>` (fixture-recorded and server-tested); the
  receipt digest binds message + context, so the same request key under
  the other task's context is refused as changed, never replayed.
- Before: a changed session cleared the draft and reloaded
  (`draft=null; save(); location.reload()`); every send navigated the whole
  page; the JSON status carried only `<turn>:<state>` as its version.

### Kept as they were

Native POSTs and redirects, the request receipt and `request-session`
binding, the `/chat/mate/status` admission/role/session/ceiling checks and
no-store policy, the consent door, nonce single-use and TTL, the composite
approval digest, the approve/confirm doors, the coordinator cards, the
concise empty state and three starters, the package 1 status projection,
the recovery CTAs, the CSP (no new connect target, no inline handlers), and
every prior UI fix. `src/mate.ts` was not changed: the request/context
binding it already enforces is what the new tests and proof rely on.

## Verification

Focused tests (all pass):

| Suite | Tests |
| --- | --- |
| `src/chat-continuity.test.ts` (rewritten for the new contract) | 15 |
| `src/serve.test.ts` (5 new `package 2:` tests in the mate describe; 8 assertions intentionally superseded — keyed markup, the plan card's shape, the JSON version, the confirm redirect) | 279 |
| `src/mate-continuity.test.ts`, `src/mate.test.ts`, `src/mate-doors.test.ts`, `src/chat-continuity.test.ts` together | 65 |

- `npx vitest run src/chat-continuity.test.ts src/mate-continuity.test.ts src/mate.test.ts src/mate-doors.test.ts` — 65 passed.
- `npx vitest run src/serve.test.ts` — 279 passed.
- `npm run typecheck` — clean.

Browser proof, all against the synthetic fixture
(`scripts/ui-polish-fixture.mjs`: one in-memory database, a throwaway
repository, an ephemeral approver, a scripted subscription runner standing
in for the model; the fixture now records what the runner is handed and
answers "add a task" with a `propose_task` card, `planning: skip`):

- `node scripts/workspace-chat-proof.mjs --strict` (new) — **44/44 checks**,
  9 exact-viewport screenshots under `evidence/workspace-2-chat-2026-09-13/`
  (`report.json` beside them):
  `desktop-new-task-proposal.png`, `desktop-concise-plan.png`,
  `desktop-expanded-approval.png`, `desktop-live-update-while-typing.png`,
  `desktop-stale-approval.png` (1440×900); `phone-new-task-proposal.png`,
  `phone-concise-plan.png`, `phone-expanded-approval.png`,
  `phone-live-update-while-typing.png` (390×844). No document horizontal
  overflow at 1440, 390, or 320 on the proposal, plan, expanded approval,
  and live-update surfaces; Approve & start and New update clear the tab
  bar and the fixed composer.
- `node scripts/ui-polish-proof.mjs --strict` — 76/76 (its composer sends
  now click and wait for the thread to move instead of a new document;
  every approval, revision, keyboard, overflow, and motion check unchanged).
- `node scripts/workspace-proof.mjs --strict` — 227/227 (one assertion
  adapted: only VISIBLE composer hints count, since the hidden Reconnect
  control is a hint element too).
- The unchanged full serial repository verifier is left to the machine's
  sealing gate; it was not run or duplicated here.

## Limitations and follow-ups

- Headless Chromium at 390×844/320×740 is not physical iPhone Safari or a
  Windows browser; the proof says so.
- The browser proof exercises an ended session, a bad refresh, offline/online,
  denied storage (a `Storage.prototype.setItem` patch, not a browser
  setting), and JavaScript disabled. A changed admission ceiling and an
  unavailable task are exercised at the server/unit level (`{session:null}`
  / `unavailable: true` answers and the page's response to each), not by
  restarting the fixture server under a different ceiling.
- The status poll still counts as session activity, as it did before this
  package; the brief's touch policy was not changed.
- Coordinator-proposal confirmations keep their previous return road; only
  the mate's task proposals redirect into the created task's lens.
- The New update control announces new content but not a count; a reader
  who is mid-thread and receives several updates is taken to the first
  unread node.

## Revision — the seven annotations on build 1550 (2026-09-14)

Applied on the seeded reviewed head (`c725c82`, plus the AGENTS.md
simplicity rule at `33ed9ac`), within the package scope. Where this
section disagrees with the text above, this section is current. Nothing
outside the batch was changed; no schema, scheduler, provider, billing,
permission, publication, or global configuration was touched, and no
dependency was added.

### What the annotations found, and what changed

| # | Finding (P1 unless noted) | Change |
| --- | --- | --- |
| 100 | From **All projects** (two or more admitted projects, none chosen) `/chat/mate/status` bounced to `/projects` and answered HTML; the page then said "Sign in again" under a valid session. | `needsProject` (`src/serve.ts`) now exempts exactly two read-only refresh paths, `/chat/mate/status` and `/chat/task-status`, beside `/chat` itself. Every other guard on those routes is untouched: cookie-only, approver role, session/ceiling/generation, `taskChatFocus` admission (a task outside the ceiling or unknown answers `unavailable: true` / 404, never a redirect). Other collections still bounce to the opener from All projects. |
| 101 | Poll A asked for send A's receipt; B was submitted before A resolved; A's `received: true` cleared B. | `check()` captures `asked = sent.request` when the poll starts and `receipt(asked)` settles only a draft or send whose key equals `asked`. B keeps its words and its submitted state until its own receipt; each request is posted once. |
| 102 | A changed `version` without fragments advanced the page's version as if rendered; a malformed `{}` latched "changed session" forever. | `valid(data)` checks the whole answer before any state changes: `session` null (valid, ends the conversation) or number/string; `task` string; then `unavailable`, or `version`/`pending`/`received` typed, `approval` string when present, `fragments` an object whose `thread` is a string. A changed version without fragments, and a fragment set missing any region this page has (thread, after-composer, or the focused task's live region), throws before anything is touched — a bad refresh that retries in 10 s with the draft intact. |
| 103 | A live-region fragment skipped while an input in that region had focus was forgotten once the global version advanced. | The skipped fragment is kept as `deferredLive`; `settleLive()` runs after every poll (a `focusout` schedules one) and lands it once the reader has left the region — no new server change needed. An open approval form still holds it back for the life of that form; its stale notice, typed password, digest, and nonce stay exactly as rendered. |
| 104 | The reconnect carry was keyed by task only, so the next account signed in on the same tab could inherit the previous account's draft. | The composer now carries `data-chat-user` (the mate session's approver, server-rendered). The carry record is `{text, at, owner, task}` and is honoured only when `owner` equals the page's account, `task` matches, and `at` is within a day; anything else is removed unread. No account on the page, no carry. Same-user reconnection still restores the words unsent under the new session and a fresh key. |
| 105 (P2) | Screenshot feedback: the card said the same thing three times and the button wrapped. | The plan card is now **Plan ready** (or **Revision ready**), the goal in one 200-character line, one line of counts and limits (`8 paths · 6 checks · Workspace sandbox`), and one non-wrapping **Review plan** (44 px). The eyebrow, "approve to start", "Nothing builds until…", and the summary footer are gone. Inside the expanded review, one line — *These are the exact terms. Nothing builds until your password approves them.* (plus *Filed by …* when a coordinator filed it) — precedes the unchanged signed terms. Taken from the operator's plan-card-only prototype diff; nothing else from that snapshot. Measured: 390 px card 267.6 px, 320 px card 309.8 px, button 44 × 103.4 px, full 812-character goal behind the disclosure. |
| 106 | Use the root repro harness and independent review; promote regressions; add All-projects and full-reconnect browser checks. | Root harness `output/playwright/workspace-chat-race-review.mjs` (now nine checks, run with this worktree as cwd and candidate): **9/9**. Each is promoted into `src/chat-continuity.test.ts`; the All-projects and denied-task regressions live in `src/serve.test.ts`; the browser proof gained the All-projects, full-reconnect, cross-account, and long-scope card sections. |

### Simplicity pass (AGENTS.md)

Before: eyebrow *your next step* · *Plan ready — approve to start* ·
*Nothing builds until you approve the exact terms.* · four labelled rows
· *Review plan* + *The full exact terms, then Approve & start with your
password.* (roughly 500 px tall on the phone, two-line button). After:
*Plan ready* · one outcome line · one facts line · *Review plan*.
First-time reading: the plan is ready; press Review plan to see the exact
terms and approve. Nothing signed was shortened — the full goal,
exclusions, paths, criteria, agents, limits, digest, nonce, and password
are unchanged inside the disclosure. Status words for the other paths
(*Connection lost…*, *This conversation changed or ended…*, *Sign in
again…*) were not changed.

### Verification

- `node output/playwright/workspace-chat-race-review.mjs .` (the main
  checkout's root harness, run from this worktree) — 9/9.
- `npx vitest run src/chat-continuity.test.ts` — 21 passed (15 before;
  the six new tests and the extended reconnect test cover annotations
  101–104 and the missing-region cases; all seven fail when run against
  the build 1550 script, checked by swapping it in).
- `npx vitest run src/serve.test.ts` — 280 passed (one new: All projects
  on a two-project server, a task in each project, a task outside the
  ceiling, the route's own guards, other collections still bouncing; the
  test fails with a 303 when the exemption is removed).
- `npx vitest run src/chat-continuity.test.ts src/mate-continuity.test.ts src/mate.test.ts src/mate-doors.test.ts src/serve.test.ts` — 351 passed.
- `npm run typecheck` — clean.
- `node scripts/workspace-chat-proof.mjs --strict` — **51/51**, 12
  exact-viewport screenshots under `output/playwright/workspace-2-chat-2026-09-13/`
  (the ignored output tree, per the steering note; `evidence/` was left
  as inherited). New captures: `desktop-all-projects-task-focus.png`,
  `phone-concise-plan-long-scope.png` (390×844),
  `narrow-concise-plan-long-scope.png` (320×740).
- `node scripts/ui-polish-proof.mjs --strict --out output/playwright/ui-polish-2026-09-13-revision` — 76/76.
- `node scripts/workspace-proof.mjs --strict --out output/playwright/workspace-1-revision` — 227/227.
- The unchanged full serial verifier is left to the machine's gate.

### Still true

- Headless Chromium is not physical iPhone Safari.
- The cross-account browser check signs a second synthetic approver in on
  the same tab of the synthetic fixture; it is a script-level proof that
  the carry is discarded, not a claim about live data.
- The status poll still counts as session activity, as before.
