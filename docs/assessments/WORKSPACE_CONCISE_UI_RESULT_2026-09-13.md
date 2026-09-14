# Workspace concise-content pass — result — 2026-09-13

Implements the focused clean-and-concise direction (the brief of the same
date) on the package 1 query correction `a626e87b945b6c3f0d5520a21618dadc8c88b222`
(branch `standing-orders/workspace-concise-ui-20260913`). A content-density
pass over the existing shell only: no store schema, scheduler, authority,
permission, provider, billing, global setting, installation, publication,
deployment, dependency, transport, or continuity change; package 2 and
packages 3–5 are untouched. Every change was left uncommitted for the worker
to seal; the unchanged full repository verifier runs through that
machine-owned gate and is **pending** at the time of writing.

## What changed

### Work (`src/serve.ts` `workPage`, CSS)

- **Head:** the title and the *Work tools* control share one line; the
  hint paragraph ("Every task in view, most urgent first.") is gone from the
  page and rides each view tab's `title` instead. On a phone the head no
  longer stacks into two rows.
- **Rows:** title first, the stable id and age beneath it, then ONE
  wrapping line: the shared status line, the existing next action, and a
  native `<details class="work-details"><summary>Details</summary>` holding
  the diagnosis sentence that every row used to print in full. The
  disclosure works without script and by keyboard (Tab to the summary,
  Enter opens and closes; proved in the browser), its summary is 36 px tall
  on a desk and 40 px on a phone, and an opened body wraps onto its own
  full-width line by itself. The diagnosis words are unchanged and still in
  the HTML (`.work-detail`), only folded.
- Nothing critical folds: the status label itself names the failed check
  ("Changes saved, but checks failed"), the needed approval, the retry, the
  exception ("Accepted with an exception"), the failed review, and the
  missing or mismatched evidence — asserted per row in the browser proof.
  No type size shrank (title 15 px, status 14 px, unchanged); row padding
  went from 14 px to 12 px (10 px on a phone).
- The filter strip, the tools menu, the bound notice, every empty state,
  the `data-work-*` tokens, ordering, counts, and the admitted-before-limit
  query are untouched.

### Chat (`src/serve.ts` `matePage`, `taskChatHeading`, `matePromptStarters`; `src/chat-continuity.ts`)

- The live conversation's heading intro ("Ask about any project. Changes
  come back as cards you confirm.") is gone; `chatHeading` skips an empty
  sentence. The pre-conversation start page is unchanged.
- The empty thread keeps ONE contextual sentence: "Describe the outcome you
  want; changes come back as cards you confirm." (a focused task: "I read
  the task first — ask anything, or start below.").
- The second hint under the composer ("One message is enough. I'll infer
  the title, scope, and proof; …") is removed.
- The composer's status line (`#chat-connection`, still `role="status"
  aria-live="polite"`) renders empty while idle and hides itself
  (`.composer-hint:empty { display: none }`); it still says "Reply in
  progress…" while a reply runs. The continuity script's idle words are now
  "Connected." instead of "Connected · changes appear as cards for you to
  confirm."; every other state ("Sending…", "Connection lost…",
  "Reconnecting…", "Message not confirmed…", "Finish editing…", "Sign in
  again…", storage denial) is unchanged, as are drafts, the request
  binding, the reload rules and the double-send latch.
- Starters: three each. General — *brief me*, *decisions*, *new task*
  (dropped *building now*, *prioritize queues*). Focused — *what's
  happening*, *check the proof*, *revise scope* (dropped *steer next
  attempt*). Their messages are unchanged.
- The focused chat's title line drops "Ask, steer, or revise this task in
  the same unified conversation."; the title, the Overview/Ask switch, the
  journey card and its headline, the exact-run control, the approval
  ceremony, decisions, and the receipt are exactly as before.

### Task and result (`src/serve.ts` `completionReceiptCard`, `completionReceiptView`)

- The receipt's review-history paragraph (review in flight: "… Until the
  review settles, the earlier verdict — "Ready to review" — stays on record
  as history.") sits behind `<details class="receipt-history"><summary>Review
  history</summary>` on the task page and in chat alike — the same
  `data-receipt-review` paragraph, the same words. The status box above it
  still leads with the review and carries the same history sentence in the
  open (`[data-review-lead]`), and the v50 review panel with its retry
  control is untouched.
- The receipt's *Independent review* coverage block folds behind a
  disclosure ONLY when nothing is owed: review optional under default
  quality and not settled, or satisfied, with no context gap
  (`coverageSecondary`, computed from the same `semanticCoverage` facts the
  CLI prints). A strict-quality shortfall, a strict review still pending,
  or a named context gap stays in the open exactly as before
  (`data-semantic-coverage=""` div; tested).
- Everything else on the task page is unchanged: the title status line, the
  one status box with its exit code, the *Review the failed check* action,
  the *Accept with exception* control, the requirements disclosure, the
  receipt heading, narrative, publication fact and facts tiles, screenshots,
  caveats ("Before you move on" never folds), the scope card with its signed
  terms, agents, attempts, and both revision paths.

## Files

`src/serve.ts`, `src/chat-continuity.ts` (idle words only),
`src/serve.test.ts`, `src/chat-continuity.test.ts` (idle words only),
`scripts/workspace-proof.mjs`, `scripts/ui-polish-proof.mjs`, this record.
`package.json`, the verifier, the store, the scheduler and every authority
door are unchanged (`git diff --stat` names only these files).

## Verification

Commands, run from this checkout on the final tree:

| Command | Result |
| --- | --- |
| `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/workspace-ui.test.ts src/dispatch.test.ts` | 4 files, 295 passed (1 new test, assertions added or updated as listed below), exit 0 |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/concise-ui/after/workspace --strict` | 197/197 checks, 29 screenshots, exit 0 (167/167 on the base before the change) |
| `node scripts/ui-polish-proof.mjs --out output/playwright/concise-ui/after/ui-polish --strict` | 76/76 checks, 21 screenshots, exit 0 (75/75 on the base) |
| `node /Users/alekseypelletier/Documents/standing-orders/output/playwright/workspace-boundary-review.mjs "$PWD"` (the reviewer's independent five-case boundary script, outside the source tree) | all five cases `ok: true`, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | **pending** — runs once through the machine-owned sealing gate after this handoff; not duplicated here |

Test changes (`src/serve.test.ts`): one new test — a Work row is title,
status, next act, and a native Details disclosure over the diagnosis; the
head is one line; the receipt folds only what is not owed (default-quality
matrix with no settled review folds; the failed check keeps its exit code,
action, and exception control). Assertions added to existing tests: the
fresh conversation's one sentence, empty idle status, three starters, no
heading intro or second hint; the focused fresh thread's one sentence and
three starters, and the populated thread keeping its real messages; a strict
shortfall with a context gap stays an open `<div>`. Assertions updated for
intentional behaviour without dropping their meaning: the receipt-history
paragraph is now matched inside its disclosure (same words, same
`data-receipt-review`); the All tab is matched with its new `title`
attribute; "One message is enough." is asserted absent instead of present.
`src/chat-continuity.test.ts`: the idle status is "Connected.".

Browser proofs: `scripts/workspace-proof.mjs` gains a `c6` section (per
viewport: head layout; every row's status/action shown and diagnosis
folded; 36/40 px targets; critical labels in the open; type sizes; the
keyboard open/close of one row's Details with the exact words and no
overflow; the fresh and focused-fresh threads; a populated focused thread
with the real messages, journey, receipt and three starters; the failed-check
and pending-review task pages with the status box leading and the receipt's
history folded and openable) and records `density` in `report.json`.
`scripts/ui-polish-proof.mjs` gains one check on the ready thread; its
approval, both revision modes, draft, keyboard and reduced-motion checks run
unchanged.

## Evidence — before/after, exact viewports, same synthetic fixture

Generated under the ignored `output/playwright/concise-ui/` (never in the
source diff). *Before* is the sealed base `a626e87` (extracted with
`git archive` into `output/playwright/concise-ui/baseline-tree/`, built there,
measured by the SAME `visibleDensity` function — see `report.json` for the
after numbers and `before/density/density.json` for the before numbers).
All PNGs are device-scale-1 exact viewports of synthetic data.

Before: `before/workspace/phone-work-all.png`, `narrow-work-320.png`,
`desktop-work-all.png`, `chat-fresh-1440x900.png`, `chat-fresh-1280x800.png`,
`desktop-task-failed-checks.png`, `phone-task-failed-checks.png`,
`desktop-chat-failed-checks.png`, `desktop-task-review-failed.png`;
`before/density/phone-chat-focused-populated.png`,
`desktop-chat-focused-populated.png`.

After: `after/workspace/phone-work-all.png`, `narrow-work-320.png`,
`desktop-work-all.png`, `phone-work-details-open.png` (a row's Details
opened by keyboard), `chat-fresh-1440x900.png`, `chat-fresh-1280x800.png`,
`phone-chat-focused-populated.png`, `desktop-chat-focused-populated.png`,
`desktop-task-failed-checks.png`, `phone-task-failed-checks.png`,
`phone-task-pending-review.png`, `desktop-task-review-failed.png`.

### Visible density, measured — not DOM text

`visibleDensity` counts only rendered text whose client rectangles
intersect the first viewport, from elements that are computed visible (a
closed disclosure's body, `display:none`, and `aria-hidden` never count),
plus Work rows whose whole box sits inside the viewport, and the document
height. Before → after:

| Surface | Doc height | Visible chars | Text lines | Whole rows | Mean row px |
| --- | --- | --- | --- | --- | --- |
| `work-narrow` (320×740) | 3411 → 2599 | 575 → 477 | 27 → 25 | 2 → 3 | 178 → 135 |
| `work-phone` (390×844) | 3060 → 2342 | 800 → 634 | 30 → 25 | 3 → 5 | 160 → 122 |
| `work-desktop` (1440×900) | 2261 → 1638 | 1266 → 997 | 38 → 37 | 5 → 8 | 115 → 79 |
| `chat-fresh-phone` (390×844) | 1016 → 849 | 590 → 270 | 19 → 13 | — | — |
| `chat-fresh-1440x900` | 900 → 900 | 626 → 306 | 19 → 16 | — | — |
| `chat-fresh-1280x800` | 800 → 800 | 626 → 306 | 19 → 16 | — | — |
| `chat-focused-populated-phone` (390×844) | 2309 → 2178 | 500 → 437 | 15 → 15 | — | — |
| `chat-focused-populated-desktop` (1440×900) | 1812 → 1738 | 960 → 785 | 29 → 28 | — | — |
| `task-failed-checks-phone` (390×844) | 3213 → 3129 | 737 → 737 | 25 → 25 | — | — |
| `task-failed-checks-desktop` (1440×900) | 2157 → 2111 | 1852 → 1798 | 51 → 49 | — | — |

What that means honestly:

- **Work** is the real win: at 390×844 the first row starts 68 px higher
  (267 → 199) and rows average 122 px instead of 160, so five whole rows fit
  where three did; at 320×740 three where two did; on a desk eight where
  five did. Visible text in the first phone viewport fell from 800 to 634
  characters because the diagnosis sentences are folded, not because
  anything shrank. Page height at 390 px fell from 3060 to 2342 px.
- **Fresh chat** loses about half its visible words on a desk (626 → 306
  characters, 19 → 16 text lines) and on a phone (590 → 270, 19 → 13): two
  intro sentences, the second hint, and two starters are gone; the composer
  and send control stay inside the first viewport (checked).
- **Populated focused chat** changes less (phone 500 → 437 characters, desk
  960 → 785): the real messages, the journey and the receipt dominate the
  viewport by design; what went is the title's intro sentence and one
  starter.
- **Task page with a failed check:** the first phone viewport is
  effectively unchanged (737 → 737 characters) — the title, the one status
  box with its exit code, the review action, the exception control, the
  requirements disclosure and the receipt head were already the content
  there and stay. The savings are below the fold (the optional coverage
  block folds; page height 3213 → 3129 px at 390). No
  percentage claim is made beyond these measured numbers.

## Limitations and caveats

- The v50 review panel ("Review queued … Retry queued") above the status
  box still restates the review that the status box also leads with. It
  carries the retry control and attempt list and belongs to the review
  authority surface, so it was left as it is.
- The task page's title status line, status box, and receipt chip still
  each carry the same short status for the same run — that agreement is a
  package 1 contract every surface test asserts; only the repeated
  paragraphs were folded.
- Keyboard and disclosure behaviour were observed in headless Chromium
  only.
- The full repository verifier is pending on the machine-owned gate.
