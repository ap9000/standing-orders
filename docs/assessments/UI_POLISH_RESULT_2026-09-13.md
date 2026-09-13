# UI simplification and lightweight motion — result, 13 September 2026

Implements the three sections of `UI_POLISH_BRIEF_2026-09-13.md` on the
branch `standing-orders/ux-polish-2026-09-13`, working tree on top of
`b1290a7` ("Snapshot current local improvements as UI polish baseline").
Local implementation only: nothing was installed, published, pushed, or
merged; no migration, dependency, permission, or service change.

## What changed

### 1. Chat and navigation hierarchy (`src/serve.ts`)

- The chat page without a conversation now leads with the start card
  ("Start a conversation", primary button), then the portfolio overview as
  a folded disclosure whose summary carries the two counts a phone reader
  scans (`N need you · N building`), then provider/model/limits under one
  "Model & limits" disclosure. The bare provider chip row is gone from the
  top of both chat modes; in a live conversation the same facts sit under
  "Conversation details" beside the end-conversation act.
- The heading is one line ("Ask about any project. Changes come back as
  cards you confirm."); the idle "unified workspace" badge is gone, only
  "conversation live" remains.
- The desktop project rail defaults to closed on every width; the existing
  toggle opens it and a saved "open" preference is still honored. Escape
  and the close button return focus to the toggle.
- Session-expiry copy: "Your projects changed since this conversation
  started. Start a new conversation below to continue — the earlier one
  closes when you do." The road is unchanged: the same mint ceremony with a
  password; the admitted-project ceiling is not widened or bypassed.
- A membership never shows a dollar figure as a charge: the pending turn
  and recent-turn rows on the legacy chat page say "membership-backed" /
  "membership" instead of `$0.00 reserved`.
- Proposal cards: the confirm act is the primary button; dismiss stays
  quiet. Path lists render one per line instead of a comma run that broke
  mid-token on phones.
- Phone switcher menu: it was `position: fixed` inside a header with
  `backdrop-filter`, which makes the header the containing block, so the
  menu landed above the header, off-screen (visible in the before capture
  `before/nav-open-390.png`). It now drops from the header it belongs to.

### 2. Task, approval and result hierarchy (`src/serve.ts`)

- The approval ceremony on the task page keeps its exact structure and
  every term, and gains an orientation block first: "Waiting for your
  approval. Nothing builds until your password confirms the exact terms
  below.", a factual count line (criteria · path limits · exclusions ·
  tournament/revision brief when present · "every term is shown in full"),
  a **Review scope ↓** jump to `#approval-terms`, and an "Approve after
  reading ↓" jump to `#approval-confirm`. The goal, boundaries, and
  acceptance criteria follow in full inside `#approval-terms`; agents and
  runtime limits keep their existing disclosures; the password and approve
  act are unchanged (sticky above the tab bar on phones). Nothing is
  truncated, paraphrased, pre-accepted, or hidden. Path limits render one
  per line on both the task and chat approval forms.
- "Reuse this scope as a recipe" moved from between the title and the
  action into the scope section.
- Overview and Ask stay one tap apart (`.task-view-switch`); the Ask-mode
  approval disclosure is unchanged.
- Run page: a finished build leads with its result, proof bundle, sealed
  diff, and the annotate/revise section; the machine facts fold under
  "Build details". A live build keeps the facts open because that region
  is what the poller refreshes. Receipt screenshots stay thumbnail-sized
  (`auto-fill`) instead of one full-width poster.

### 3. Motion and mobile fit (`src/serve.ts`, `src/recipe-ui.ts`)

- Motion contract written into the stylesheet: feedback transitions
  140–200 ms on color/border/shadow/opacity/transform; overlay entrances
  ≤ 200 ms opacity + transform (project drawer, its scrim, the switcher
  menu); the `rise` keyframe animates `transform` instead of `margin-top`;
  the sidebar collapse no longer animates `grid-template-columns`.
- `prefers-reduced-motion: reduce` is universal: every animation and
  transition dies (`*, *::before, *::after`), including the thinking and
  planner pulses that the old selector list missed.
- Composer textarea is 16 px on phones (was 15 px → iOS zoom).
- Long titles and project names wrap (`overflow-wrap: anywhere`).
- Recipe cards and criterion/question boxes use the console's radius
  token instead of their own values.

No new runtime or animation dependency; `package.json` and the lockfile
are untouched.

## Fixture and evidence

- `scripts/ui-polish-fixture.mjs` — isolated: in-memory SQLite, a
  throwaway git repository, an ephemeral approver, and a scripted
  subscription chat runner. No live database, worker, key, or model call.
  It seeds a long unapproved scope (`ledger-export`: 6 criteria, 8 paths,
  exclusions) and a finished build with sealed diff, handoff, proof,
  screenshot, and machine verdict (`payout-rounding`).
- `scripts/ui-polish-proof.mjs` — drives the fixture in headless Chromium
  (Playwright from the npx cache; not a dependency), captures exact
  viewport screenshots, and records checks to `report.json`.

Captured screenshots (viewports, not stitched pages; every one labeled
"(fixture)" in `report.json`):

| State | Path |
| --- | --- |
| Chat start, 390×844, before / after | `evidence/ui-polish-2026-09-13/before/chat-start-390.png` / `after/chat-start-390.png` |
| Chat ready, 390×844 | `after/chat-ready-390.png` (before: `before/chat-ready-390.png`) |
| Chat ready, 320×740 / 430×932 | `after/chat-ready-320.png`, `after/chat-ready-430.png` |
| Chat, 1440×900 | `after/chat-ready-desktop.png` (before: `before/chat-ready-desktop.png`) |
| NEW empty conversation, 1440×900 / 1280×800 (follow-up on build 1540) | `after/chat-fresh-1440x900.png`, `after/chat-fresh-1280x800.png` |
| Pending reply | `after/chat-pending-390.png` |
| Hold proposal card | `after/chat-action-card-390.png` |
| Ordinary revision (scope rewrite card) | `after/chat-scope-revision-390.png` |
| Mobile navigation open | `after/nav-open-390.png` (before: `before/nav-open-390.png`, menu off-screen) |
| Long scope approval, 390 / 320 / 1440 | `after/task-approval-390.png`, `after/task-approval-320.png`, `after/task-approval-desktop.png` |
| Same task in Ask mode | `after/task-ask-390.png` |
| Result, 390 / 1440 | `after/result-390.png`, `after/result-desktop.png` |
| Annotate mode on the sealed diff | `after/result-annotate-390.png` |
| Revision task from the annotation | `after/revision-task-390.png` |
| Task after the ordinary scope revision | `after/task-rescoped-390.png` |
| Review cockpit, 1440 | `after/review-cockpit-desktop.png` |

## Validation — exact commands and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (exit 0) |
| `npm run build` | pass (exit 0) |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/mate-continuity.test.ts src/recipe-surface.test.ts src/recipes.test.ts` | 5 files, 297 tests passed (build 1540); 299 after the follow-up below |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/mate-continuity.test.ts` | 3 files, 278 passed (build 1540) |
| `npx vitest run` (full suite) | 161 files; 2785 passed, 23 platform skips; 71 s (build 1540) — see the follow-up section for the re-run |
| `node scripts/ui-polish-proof.mjs --out evidence/ui-polish-2026-09-13/after --strict` | 55/55 checks passed, 19 screenshots (build 1540); 75/75 and 21 screenshots after the follow-up |
| `node scripts/ui-polish-proof.mjs --out evidence/ui-polish-2026-09-13/before` (run against the unmodified build) | 48/54 checks passed — the six failures are the defects this pass fixes (start action at y = 946 px, 15 px composer, no Review-scope jump, pulse alive under reduced motion, `grid-template-columns` transition, `rise` animating margin); the 55th check (switcher placement) was added after the baseline run |

New deterministic coverage in `src/serve.test.ts`: chat page order (start
card → folded overview → limits disclosure), no forced-open overview, the
plain session-expiry copy with the same mint road, membership pages free
of `$0.00`, the approval orientation/terms/confirm order with the full
goal and per-line paths, the recipe link's new place, both view tabs, the
run page's folded facts with the annotation road intact, the universal
reduced-motion rule, and the amber law extended to the folded overview's
needs-you count. Existing draft/request-idempotency/reconnect/focus tests
in `chat-continuity.test.ts` and `mate-continuity.test.ts` pass unchanged;
`chat-continuity.ts` itself was not modified.

### Browser checks (from `after/report.json`)

- No document horizontal overflow at 320, 390, and 430 px on `/chat`,
  the long approval, the result task, the run page, and `/menu`.
- Composer send control and the approve act both sit above the tab bar
  at all three widths (`send.bottom < tabbar.top`, `approve.bottom <
  tabbar.top`).
- Start action inside the first 390×844 viewport (y 576–620; before:
  946–990). Composer send at y 511–555 once a conversation exists.
- Send control reachable by Tab; the project drawer opens by keyboard,
  closes on Escape, and focus returns to its toggle.
- Under `prefers-reduced-motion: reduce`: thinking pulse `animation-name:
  none`, button and tab transitions `0s`.
- Stylesheet audit: no transition or keyframe touches width, height,
  margin, padding, inset, grid tracks, `filter`, or `backdrop-filter`;
  longest transition 160 ms across 17 declarations.
- Controls exercised on the fixture: mint, send, hold card confirm, scope
  revision card confirm (the task then shows the rewritten scope waiting
  for approval), annotate mode → line pick → comment → "Create revision
  from annotations" → revision task whose brief restates the comment.

### Served payload, same fixture pages, before → after (bytes)

| Page | HTML | inline CSS | inline JS |
| --- | --- | --- | --- |
| `/chat` (no conversation) | 173 706 → 179 090 (+5 384) | 156 089 → 161 248 (+5 159) | 4 093 → 4 122 (+29) |
| `/chat` (live) | 188 371 → 193 666 (+5 295) | 156 127 → 161 286 (+5 159) | 14 589 → 14 618 (+29) |
| `/t/ledger-export` (long approval) | 190 038 → 196 062 (+6 024) | +5 159 | 1 037 → 1 037 |
| `/t/payout-rounding` (result) | 191 674 → 196 833 (+5 159) | +5 159 | 6 484 → 6 484 |
| `/r/1` (run page) | 188 143 → 193 436 (+5 293) | +5 159 | 7 554 → 7 554 |

The +5.2 KB (≈3.3 %) stylesheet growth is the new rules (orientation
block, limits disclosure, folded overview summary, path lists, run-facts
disclosure, motion contract) plus their explanatory comments; the
stylesheet is served inline and uncompressed on every page, as before. The
approval page adds ~0.9 KB of markup for the orientation block and the
per-line path list; the chat page adds ~0.2 KB for the disclosures. JS
grows 29 bytes (focus return on Escape). No page-load resource was added.

## Acceptance mapping

| Criterion | Evidence |
| --- | --- |
| c1 — start action in the first 390 px viewport, compact project context, plain guidance | checks `c1 …` in `after/report.json`; `after/chat-start-390.png`, `after/chat-ready-390.png` |
| c2 — long scopes expose a clear next step, exact terms accessible, Ask and Overview retained | checks `c2 …`; `after/task-approval-390.png`, `after/task-approval-desktop.png`, `after/task-ask-390.png`; serve.test.ts approval assertions |
| c3 — result proof, annotated diff and ordinary revision paths functional and readable | checks `c3 …`; `after/result-390.png`, `after/result-annotate-390.png`, `after/revision-task-390.png`, `after/chat-scope-revision-390.png`, `after/task-rescoped-390.png` |
| c4 — no overflow / overlap at 320, 390, 430; keyboard-usable | checks `c4 …`; `after/chat-ready-320.png`, `after/chat-ready-430.png`, `after/task-approval-320.png`, `after/nav-open-390.png` |
| c5 — reduced motion, no new dependency, no animated layout/blur, payload measured | checks `c5 …`; payload table above; `package.json` unchanged |
| c6 — build and focused continuity checks pass; assessment maps evidence | command table above; this document |

## Follow-up on build 1540 (two annotations, 13 September 2026)

The operator's two comments on the sealed diff of build 1540, applied as a
narrow repair on the same branch. No dependency, migration, permission,
backend, deployment, push, or merge; both revision modes and every approval
term stay as they were.

### Annotation 88 — the fresh desktop chat clipped its composer

A NEW conversation on a desk (after the mint, before the first message)
rendered the portfolio overview forced open above a centered empty state:
at 1440×900 the textarea sat at y 883–939 and the send control below the
fold; at 1280×800 both were off-screen. The earlier desktop capture
(`after/chat-ready-desktop.png`) reused the phone's history, which is
why the proof did not see it.

- `src/serve.ts` — behind `@media (min-width: 761px)`, only while the
  thread is empty (`.chat-main:has(.chat-empty)`): the `chat-fleet-context`
  disclosure keeps its summary row visible (previously `display: none` on
  a desk), so the overview folds behind "Project overview · N need you ·
  N building"; the `<summary>` is the native disclosure control, focusable
  and toggled by Enter/Space. The thread drops its `min(32rem, 48vh)`
  minimum and the empty state's `clamp(3rem, 9vh, 6rem)` top padding
  becomes `clamp(1.25rem, 4vh, 2.25rem)`. The chrome script no longer
  forces the disclosure open when `.chat-empty` is on the page; with
  messages present the desk behavior is unchanged (overview open, summary
  hidden). The summary's amber needs-you rule moved from the phone block to
  the base stylesheet so the amber law's selector list is unchanged.
- Phone: no rule in the phone block changed; the new rules are desk-only.
  The 320/390/430 captures from build 1540 are byte-identical after the
  re-run (`chat-start-390`, `chat-ready-320/390/430`, `nav-open-390`),
  and so is `chat-ready-desktop.png` (a thread with history).
- Measured after the change (`after/report.json`, `followup c1 …`
  checks, each on a NEW empty conversation minted in its own context after
  ending the previous one):

| Viewport | textarea (top–bottom) | send (top–bottom) | overview | page scroll |
| --- | --- | --- | --- | --- |
| 1440×900 | y 464–520 | y 476–520 | folded; summary y 191–231 | none (document = viewport) |
| 1280×800 | y 460–516 | y 472–516 | folded; summary y 191–231 | none |

  With the overview opened from its summary the send control still ends
  at y 736 (1440×900) / 732 (1280×800), inside the viewport.

### Annotation 89 — the annotation form advertised 2000, the server allowed 500

Both review annotation textareas (the run page's "request changes" form
and the review cockpit's form, the same `/r/:id/comment` endpoint) carried
`maxlength="2000"` while `validateNote` in `src/decision.ts` refuses
anything over `LIMITS.note` = 500 characters, so a long note was typed in
full and then discarded onto the refusal page.

- `src/serve.ts` — both textareas now render `maxlength="${LIMITS.note}"`
  (500, the server's own constant, never a second number), with a helper
  `up to 500 characters` that the textarea names through
  `aria-describedby`. The existing prefill script (already on both pages)
  updates the same helper to `N of 500 characters` while typing; it reads
  the textarea's own `maxLength`, so the two cannot drift. The server rule
  is untouched; the refusal for an over-long POST is the same sentence as
  before.
- Coverage: `src/serve.test.ts` — the run page advertises 500 with the
  helper and counter, no `maxlength="2000"` remains, a 500-character note
  lands and a 501-character note is refused with "a note is at most 500
  characters" leaving the batch unchanged; the review cockpit form carries
  the same attribute and helper. Browser: `followup c2 …` checks type 600
  characters into the run-page form and read back 500 with the counter at
  "500 of 500 characters"; the cockpit form reads "12 of 500 characters"
  after 12 keystrokes.

### Follow-up validation — exact commands and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (exit 0) |
| `npm run build` | pass (exit 0) |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/mate-continuity.test.ts src/recipe-surface.test.ts src/recipes.test.ts` | 5 files, 299 passed (297 + the two follow-up tests) |
| `npx vitest run` (full suite) | 161 files; 2787 passed (2785 + 2), 23 platform skips; 68 s (exit 0) |
| `node scripts/ui-polish-proof.mjs --out evidence/ui-polish-2026-09-13/after --strict` | 75/75 checks passed, 21 screenshots (exit 0): the 55 checks of build 1540 by their exact names, all passing, plus 20 `followup …` checks |

New browser checks (`after/report.json`): per desktop viewport — starts
from no conversation, the minted conversation is new and empty at scroll 0,
the ENTIRE textarea and the ENTIRE send button lie inside the viewport, no
horizontal overflow, the overview is folded behind a visible summary with
its counts, the overview opens and closes again from the summary by
keyboard (8 × 2); the two annotation forms' limit, helper, and counter (4).

Re-captured screenshots: `after/chat-fresh-1440x900.png` and
`after/chat-fresh-1280x800.png` are new; `after/review-cockpit-desktop.png`
now shows the helper under the annotation form; `after/chat-pending-390.png`
differs only by the thinking pulse's frame at capture time, and
`after/result-annotate-390.png` by the scroll position after the new
600-character fill that precedes it. Every other capture from build 1540
(all 16) is byte-identical.

Served payload, same fixture pages, build 1540 → follow-up (bytes): inline
CSS 161 248 → 162 922 (+1 674: the desk-only fresh-thread rules, the helper
rule, and their comments); chat JS 4 122 → 4 162 (+40); run page JS 7 554 →
7 903 (+349, the counter); run page HTML 193 436 → 195 585. No page-load
resource was added; `package.json` and the lockfile are untouched.

## Limitations

- All browser evidence is headless Chromium against the synthetic
  fixture, not the installed console or a physical phone; iOS Safari
  keyboard behavior, notch safe areas on hardware, and the native app's
  permission continuity were not exercised.
- Motion was verified through computed styles and a stylesheet audit;
  frame timing was not measured, and no claim about smoothness is made
  from static images.
- The chat's `#latest` anchor and the status poller were exercised only as
  far as the proof needed (reloads landed the scripted replies); the
  full offline/reconnect matrix is covered by the existing
  `chat-continuity.test.ts` suite, which passes unchanged.
- `control-ui.ts` and `chat-continuity.ts` were read and left as they
  were: nothing in the brief required a change there.

## Self-assessment against the brief's rubric

Scored by the implementer after inspecting the rendered output above, so
this is not the independent score the brief asks for.

| Dimension | Weight | Score | Why |
| --- | --- | --- | --- |
| Hierarchy / clarity | 25 % | 8 | Start action and composer lead on the phone; approval opens with the wait and the road to the terms; result leads with outcome. The ceremony still carries its full-length terms by design. |
| Workflow cohesion | 25 % | 8 | Overview ↔ Ask, chat cards → task, annotate → revision, scope card → task all exercised end to end on the fixture. |
| Mobile fit | 20 % | 8 | No overflow or overlap at 320/390/430; 16 px inputs; switcher menu placement fixed. Hardware not tested. |
| Visual consistency | 15 % | 7 | One primary per card, neutral orientation frame, shared radius token in recipes; the glass shell's existing weight is unchanged. |
| Motion / accessibility / performance | 15 % | 8 | Universal reduced-motion, no layout/blur animation, ≤ 200 ms entrances, focus return on Escape; +3 % inline CSS. |

Weighted: 7.9 / 10 (baseline judgment in the brief: 6).
