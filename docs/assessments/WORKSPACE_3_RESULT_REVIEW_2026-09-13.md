# Workspace package 3 — result-first review and one revision loop — 2026-09-13

Implements package 3 of [the workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md)
on main `f20bd00aca52893fd2b5ce4e4c8b00bafae29d99` (branch
`standing-orders/workspace-3-result-review-20260913`), preserving packages
0–2 and the concise pass. A cohesion pass over existing records: no new
engine, framework, schema migration, cloud sync, executable preview,
permission or publication change, global setting, live-data mutation,
merge, push, or release. Every change was left uncommitted for the worker
to seal; the unchanged repository verifier runs through that machine-owned
gate. Root inspects the sealed result before acceptance.

## What changed

### One result presentation (`src/serve.ts`, `src/result-review.ts`)

- **`resultPanelHtml`** is the ONE presentation of a finished result. The
  run page (`/r/<run>`, for `built` / `no-change` runs), the review cockpit
  (`/review?result=<task>`), and the chat's new result detail
  (`/chat?task=<id>&result=<run>`) all render it from the same
  `resultDetailOf(run)` assembly of the records the receipt already read:
  `CompletionReceiptView`, the verified handoff, proof bundle, criterion
  matrix, sealed diff and stat, the run's report artifact, live notes,
  reviewer findings, revisions sealed from the run, and the publication row.
  The old `handoff` + `evidenceBundleCard` + `terminalDiffCard` + "Review
  and revise" sequence on the run page, and the cockpit's separate
  evidence / agent-summary / changes / annotate / delivery sections, are
  replaced for finished results. Live, failed, and interrupted runs keep
  their record-by-record page.
- **Order:** heading (`receiptHeadingOf`) and the shared status line → the
  handoff's one-sentence conclusion → **Before you rely on this** (the
  verification explanation when the status is a problem, every evidence
  problem, files outside the approved paths, the proof's caveats, the
  handoff's follow-ups — always in the open, above the tabs) → **Summary /
  Changes / Checks** → **Request changes** → the roads to the other
  surfaces.
- **The deliverable leads Summary** (`resultLeadOf`): the verified report
  for an investigation (title, one-paragraph summary, the document as
  escaped text in a fenced block, *Download the report* — the evidence road
  serves it as a text attachment, never a page), validated screenshots for
  UI work, the handoff's change list plus the first files for code work.
  Then a facts strip: build, agent, commits (base → head from the sealed
  diff summary when it verifies, else the run record, and the source is
  named), evidence sources present, publication (with PR link, observed CI
  state, and the existing *Draft a repair task* when CI is failing).
- **Changes:** the stat line, drift outside the signed touches, the
  priority-ordered file list with its reasons, and the sealed diff with
  the existing **View / Annotate** modes and line pins.
- **Checks:** the status line beside the machine verdict's explanation,
  accepted-with-exception, the criterion matrix, semantic coverage, repair
  chain, independent-review judgements and findings, the check log, the
  agent's declared checks, the handoff's own account, screenshots (a line
  when they already lead Summary), caveats; the cockpit adds its review
  retry panel and accept-with-exception form here.
- **Tabs are anchor links** (`?tab=summary|changes|checks`) the server
  honours (`parseResultTab`), so refresh, Back, and a deep link land on the
  same view without JavaScript. The browser script switches in place,
  records the view with `replaceState`, and moves between tabs with the
  arrow keys.

### Shared facts every surface prints (`src/result-review.ts`)

- `sharedResultFactsOf` computes once: run id, base and head with their
  source, signed criteria passed from the machine matrix, the proof's
  caveats, every evidence problem in words (`evidenceProblemsOf`), and the
  observed publication state and words. `resultFactsAttributes` stamps
  them as `data-result-*` on the task receipt, the chat receipt, the chat
  detail, the run page, and the cockpit; `resultFactsFromHtml` reads them
  back. The serve test and the browser proof assert byte-identical facts
  across the surfaces.
- **Missing, corrupt, or truncated evidence is visible and never called
  validated:** screenshot artifacts are re-verified at render
  (`proofBundleView` now carries `problem`); an altered file is counted as
  unavailable, listed by path with its reason, never rendered as an image,
  and the evidence road still answers 410 for its bytes. A failed stat
  capture, an unverifiable or shortened diff, a shortened check log, an
  unreadable proof, a proof-cited screenshot with no stored artifact, a
  report that no longer verifies, and a no-change conclusion missing its
  handoff or diff each name themselves in *Before you rely on this* and in
  the receipt's *Before you move on*; the receipt's screenshot fact reads
  "N unavailable — not validated".

### The receipt (`completionReceiptCard`)

- Stamps the shared facts; leads with the report title or the validated
  screenshots; shows caveats and evidence problems before the counts; the
  change fact names the head and its source; one primary road **Open
  result** (the chat's own result view from chat, the run page from the
  task page) with *Full build record* / *Discuss in chat* and the cockpit
  as secondary links. "Review & annotate" and "Request changes in chat →"
  are gone.

### Chat result detail (`/chat?task=<id>&result=<run>`)

- `?result=` names one finished build of THIS task; another task's run, a
  live or failed attempt, or a non-number is refused in one sentence and
  the conversation shows alone. The panel is the ONE auxiliary panel: the
  task context aside steps aside; the receipt in the thread keeps only its
  heading, status, and roads while the detail is open (CSS, said once).
- Desktop ≥ 1200 px: two columns, conversation beside the result. Below
  that, and on phones: a dedicated result view with **← Back to chat**
  first; the conversation and composer are out of the way (the same
  markup; CSS decides). The composer, its draft, and the status poll are
  untouched.

### Request changes beside the result — one sealed road

- Both feedback styles post to the existing `POST /r/<run>/comment`: a
  plain note (no pin), or a note pinned by Annotate → line pin / file
  *comment* button, which fills a folded *Pin to a file or line* disclosure.
  The 500-character note limit, helper, and counter are unchanged; the
  batch lists every live note; **Create revision** posts to the existing
  `POST /r/<run>/revise` → `sealRevision` (exact original run/base lineage,
  signed scope inherited, the child filed UNAPPROVED; the live mode's own
  explicitly authorized coverage, when present, is the only other approval
  road, unchanged).
- **Replay and double submission:** the note form carries a per-render
  `request` token; the server stores the note under
  `source_key = review:<account>:<token>` (the existing `ON CONFLICT DO
  NOTHING` index), so a replayed or double-clicked submission lands on the
  same receipt with no second note, and another account's replay of the
  token is its own note. A replayed **Create revision** finds the batch
  consumed and redirects to the revision it produced
  (`store.revisionsFromRun`, a read-only query added in `src/store.ts`); a
  losing racer is sent to the winner's revision.
- **Recoverable failure:** refusals send the reader back to the exact view
  they came from (`resultReturnTarget`: the cockpit deep link, the chat
  result view for this run, or the run page — never an open redirect),
  where the browser restores the note, file, and line.
- **Linked both ways:** the result shows *Proposed revision → <title> ·
  waiting for your approval / approved / finished · this result stays on
  record*, keeping its own screenshots, diff, and checks; the revision's
  task page already named its source task and build, and its chat approval
  card now links *Original result: build #N →*. "Looks good" is never a
  publication or an approval: no publication or merge path was touched.

### Bounded browser continuity (`RESULT_REVIEW_SCRIPT`)

- Review draft (note, file, line, request token) in `sessionStorage`
  under `standing-orders:review-draft:<account>:<task>:<run>`, at most a
  day; restored on load; cleared only by the receipt for ITS token
  (`?noted=<token>`); other accounts' entries on the tab are dropped on
  load, never shown. The chat draft keeps package 2's own key and rules.
- Reading position under `standing-orders:result-scroll:<account>:<task>:
  <result>:<tab>` from scroll events (never at pagehide — a cross-document
  transition can move the document first), restored on load when the URL
  has no fragment; leaving the result marks the way back so **Back to
  chat** returns to the same message. Selected result and tab live in the
  URL, so Back and refresh keep them.
- The note form's double-submit latch is left to the conversation's own
  delegated handler on chat pages (it runs after the panel's form-level
  listener and would refuse a form already marked busy); elsewhere the
  panel latches. The focus after a receipt is set after load, because
  browsers skip `autofocus` on a fragment URL and move focus to the target.
- The script never fetches, never submits, never writes markup.

### Review context

`src/review-context.ts` is unchanged: no lineage gap was demonstrated —
`revisionLineageOf`, `repairLineageOf`, and the review-context inventory
already carry the source task, run, ancestry, and terms the panel shows.

## Simplicity pass (AGENTS.md)

- Plain English throughout: "Before you rely on this", "Request changes",
  "Add note", "Create revision", "Proposed revision", "this result stays on
  record", "Screenshot unavailable — <path>: <reason>".
- Said once: the run page lost its parallel *result* / *verification and
  evidence* / *what changed* / *Review and revise* headings; the cockpit's
  header keeps the status chip and the panel's head omits it; the receipt
  collapses to heading + status + roads while the detail is open beside
  it; the publication is one line in Summary, not a section per surface.
- Secondary detail on demand: the pin fields fold; screenshots, agent
  checks, and check output are disclosures under Checks; build details
  stay folded. Risks stay visible: every caveat, failed check, evidence
  problem, and drift line sits above the tabs on every surface.
- Fewer competing controls: one primary road on the receipt, one seal
  per batch, one back link on the dedicated view, tabs instead of stacked
  sections.

## Verification

Focused, while iterating: `npx vitest run src/serve.test.ts` (280 → 284
tests; 18 assertions updated to the shared markup, none weakened — the
replayed-seal test now proves ONE revision instead of a bare 400),
`src/result-review.test.ts` (7, new), `src/chat-continuity.test.ts` (24,
three new happy-dom tests for the panel beside the chat), `npm run
typecheck`, `npm run build`.

Browser proof: `node scripts/workspace-result-proof.mjs --strict` — 65
checks against the synthetic fixture (extended with a scout investigation
whose report is verified, and a build whose screenshot was altered after
sealing, whose stat capture failed, and whose check log was stored
shortened), with exact-viewport screenshots at 1440×900, 390×844, and
320×740 under `output/playwright/workspace-3-result-2026-09-13/`
(ignored, never tracked; every image is of synthetic fixture data). The
proof exercises facts agreement, tabs by click / URL / keyboard, the
evidence road (200 for a validated image, 410 for the tampered one, a
text attachment for the report), both feedback styles into one revision,
replayed note and seal, the two-way links, chat and review drafts across
Open result / Back to chat / browser Back / refresh / a refused
submission, another task and another account on the same tab, and the
phone's dedicated view with no document overflow and reachable controls.

Existing proofs re-run here: `node scripts/workspace-proof.mjs --strict`
(227/227), `node scripts/workspace-chat-proof.mjs --strict` (51/51), and
`node scripts/ui-polish-proof.mjs --strict --out output/playwright/ui-polish-recheck`
(76/76 after two minimal updates: it opens the Changes view before
Annotate, and its receipt regex accepts the receipt's current proof
words; its default `--out` is the TRACKED `evidence/ui-polish-2026-09-13/after`
directory, which a first run here overwrote and which was restored to
HEAD — no tracked binary changed in this delivery).

The full serial verifier (`npm run typecheck && npm test -- --run
--reporter=dot --no-file-parallelism && npm run build`) passed once here
before handoff (164 files, 2846 tests, 23 skipped, 299 s); the machine
re-runs it at sealed completion.

## Limitations and honest notes

- Headless Chromium at 390 and 320 px is not physical iPhone Safari; the
  fixture is synthetic and labeled so; no real task result was exercised.
- The chat's result detail opens through a full navigation
  (`?result=`), not a fetched fragment: Back and refresh come for free,
  at the cost of one page load per open/close. Reading position is
  restored from the last scroll event within the tab's session storage;
  a chat that grew while the reader was away restores an offset, not a
  message identity.
- On a desktop the result column and the conversation scroll together
  (no sticky inner pane), so a long diff scrolls the conversation out of
  view; the diff itself scrolls within its own region.
- The dedicated phone view still ships the conversation's markup hidden
  by CSS (the composer's draft logic and the status poll stay identical);
  package 4's delivery-weight work may trim it.
- The report artifact, the check log, and the diff download stay text
  attachments; no live preview of any artifact was added.
- Two existing serve tests changed meaning deliberately, not weakly: a
  replayed seal now proves ONE revision (303 to it) instead of a bare 400,
  and the cockpit's "no merge" assertion now forbids a merge button or link
  rather than the word "merge", which the shared publication words use
  ("no merge or deployment is recorded").

## Repair follow-up — 2026-09-14

This section records the follow-up on branch
`standing-orders/workspace-3-result-repair-20260914`, based on reviewed
commit `5d502abf6f372b6b4aaa5e34b91b9c228f705924`. The earlier sections are
historical package-3 evidence, not verification of this candidate. The
interrupted draft was inspected and retained. Its `workspace-ui.ts` change
was moved into the allowed `result-review.ts` presentation helper; the
former file is byte-for-byte unchanged from the reviewed commit. No new
schema, engine, permission, scope, or publication authority was added.

The five repaired findings:

- A feedback token follows the exact note, path and line displayed in the
  form, including FormData sent directly without a submit event. Unchanged
  retries record once; any edit receives a new token. Conflicting reuse
  on the same or another run returns 409 and keeps the recoverable draft.
- Revision forms name the displayed note IDs and source digest. The
  existing transactional seal consumes only that batch. Replay checks the
  child's verified immutable brief against the entire batch and source;
  subsets, reordered batches, overlap and foreign notes cannot masquerade
  as an earlier request. An exact old request returns its original child,
  even after source rescoping, without consuming later notes. Fresh stale
  submissions remain refused by the original exact source checks.
- Stored check-log damage joins the shared evidence problems. Missing log
  and diff files, missing/corrupt reports, shortened reports and diffs, and
  unparseable shortened reports have focused HTTP coverage. Evidence that
  cannot be read is withheld; shortened downloads say they contain only
  the stored portion. Existing failed-check and mismatch states, review
  history, recorded verdicts and acceptance decisions remain intact.
- Revision approval reads `approvalOf` for the current scope and rejects
  damaged terms. The revision line uses the child's existing Work status,
  so approve/rescope, on hold, live activity and pause remain distinct.
- Summary keeps one bounded outcome and one primary action. The screenshot,
  escaped report or changed files leads its content. Full agent narrative
  and technical facts are disclosed on demand; caveats, evidence problems,
  required review gaps and publication failures stay visible. Receipts now
  put their deliverable before the shortened narrative and disclose the
  repeated counts and secondary destinations.

Simplicity evidence: the reviewed six-line narrative and five technical
boxes became a short outcome plus two closed disclosures. Back measures
44px at 390px and 320px. The initial phone inspection found a wrapping
Build details label; its redundant timestamp was removed from the label
and remains inside the disclosure. Annotation scrolling respects reduced
motion. The final viewport evidence is under
`output/playwright/workspace3-repair-final/`; it uses real Chromium renders
of a synthetic in-memory fixture, not live task data or physical Safari.

Current verification uses `npm run typecheck` and the focused result,
chat-continuity, HTTP, revision-terms and stale-approval tests: 343 passed,
zero skips. The browser journey is `node scripts/workspace-result-proof.mjs
--strict --out output/playwright/workspace3-repair-final`. It exercises one
desktop and one 390px result-to-revision journey, the required 320px layout,
long feedback/path input, empty drafts, damaged evidence, rejected requests,
keyboard tabs, Back/refresh positions, and account/task isolation.

The approved serial verifier remains unchanged. The attempt rules state
that the repository verifier is rerun by the machine, never by the builder;
therefore its success for this uncommitted candidate is pending that gate.
No full suite was run here, and no success, skip, timeout increase or proof
exception substitutes for the machine's result. Original task, scope and
sealed evidence remain untouched. No commit, merge, push or deployment was
performed.

Final inspection: the full journey passed 100/100 checks. The last
presentation-only cleanup moved duplicate screenshot failures into Build
details and removed the second status label from Checks, retaining the
recorded verdict as history. All 289 HTTP tests passed again. The affected
visual/evidence recheck (`node scripts/workspace-result-proof.mjs --strict
--layout-only --out output/playwright/workspace3-repair-layout`) passed
18/18 checks; its six fresh viewport images were opened and inspected.
`--layout-only` is an explicit affected-view check; the default command
still runs every journey check. No test was skipped or weakened. The
unchanged revision-created and two-tab-refusal screenshots remain in the
full-journey output. The proof names the exact eight images inspected.
