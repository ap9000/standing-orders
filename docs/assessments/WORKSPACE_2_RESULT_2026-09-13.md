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
