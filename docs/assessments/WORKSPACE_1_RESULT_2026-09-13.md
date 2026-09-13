# Workspace package 1 — one navigation shell, truthful status — 2026-09-13

Implements [the package 1 brief](WORKSPACE_1_BRIEF_2026-09-13.md) of
[the workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md) on
the package 0 base `43c102b0736ab3a06a2db871000dd4f8525245b8` (branch
`standing-orders/workspace-1-navigation-20260913`). The final revision is the
commit the Standing Orders worker seals from this working tree; every change
below was left uncommitted for it. No `main`, live installation, real task,
publication, deployment, or service was touched; no runtime dependency was
added (Playwright is still loaded from the npx cache, never installed).

## What changed

### Navigation shell (`src/serve.ts` `shell()`, `/menu`, `/work`)

- **Three primary destinations on desktop and phone: Chat · Work ·
  Projects.** The rail's primary rows and the phone tab bar are exactly those
  three (chat only where the ceiling ever allowed it, unchanged gating). The
  needs-you count rides Work. Every old page keeps its own active key and
  lights the destination it lives under (`primaryDestinationOf` in
  `src/workspace-ui.ts`): `/`, `/tasks`, `/board`, `/board?view=order`,
  `/runs`, `/done`, `/review`, `/activity`, `/t/<id>`, `/r/<id>`, recipes,
  routines, portfolio and ledger light Work; `/chat` and `/chat?task=` light
  Chat; fleet, requirements, people, operating mode, system and settings light
  nothing primary and open the Settings group.
- **Two accordion groups replace workflows/admin:** *work tools* (inbox,
  board, task list, recipes, routines, portfolio, action ledger) and
  *settings* (settings where the console offers it, fleet, requirements,
  people, operating mode, system). A project-scoped login sees the same
  reduced rows it saw before (no portfolio; people only) — moving a link
  never widened role or project visibility, proven by the 403s in the new
  tests. Settings is no longer a pinned rail row and is never a phone tab: on
  a phone it sits with the tools behind a 44 px header action (`≡` →
  `/menu`), which lists *work tools* then *settings*.
- **Work** (`/work`, new) lists every task in view as one row — title first,
  the stable id secondary, the project label whenever rows span projects —
  with the shared status line, one plain-sentence detail, and one next
  action. Views: **All** (default), **Needs you**, **Running**, **Completed**
  (`?view=`, unknown values fall back to All). They are shortcuts over the
  same rows, never a persisted state; each tab wears the count of its own
  members. Needs you uses the existing diagnosis semantics (waiting on a
  person with a concrete act, plus a failed task's retry), Running the live
  claim or a review in flight, Completed `task.state = done` — with failed,
  missing, mismatched, agent-attested and accepted-exception results kept
  visibly distinguished. Queued, waiting, held, paused, failed and cancelled
  tasks stay findable in All, most urgent first. The page is bounded to the
  newest 200 rows and says so; every view has its own empty state. A *Work
  tools* menu on the page keeps board / order / task list / recipes /
  routines / portfolio / ledger one click away.
- **One project selector**, the retractable desktop rail, the phone project
  pill, keyboard access and the prominent Add project card are unchanged.
  With no project open in scoped mode Work rolls up like the inbox: admission
  binds the query and every row's repo is re-proved.
- **The chrome's needs-you count now equals Work's Needs-you membership**
  (per viewer and project, cached five seconds as before), so the rail badge,
  the phone tab dot, the scope bar's "N needs you" (now linking to
  `/work?view=needs-you`), the project cards and the chat overview cannot
  disagree with the Needs-you tab. Previously the badge counted only
  decisions, unapproved scopes, failed/incident tasks and cancelled blockers.

### The admitted run deep link (`handleGet`)

`/r/<id>` (and `/r/<id>/evidence/<n>`) from All projects used to bounce to
`/projects` until a project was chosen (reproduced on the baseline:
`output/playwright/workspace-1/before/desktop-run-deep-link-all-projects.png`).
The path is now let through the project gate; the run handler's own
`runVisible` check (ceiling plus account) still decides, so a run outside
the ceiling, a run in another account's project, or an unknown id still
answers 404 (tested). Project-bound pages such as `/tasks` still defer to the
opener exactly as before.

### Truthful status (`src/workspace-ui.ts`, `src/dispatch.ts`, `src/serve.ts`)

One pure display projection over recorded facts — task state, the dispatch
diagnosis, the latest finished builder/scout run, the machine's proof verdict
**and its reasons**, an operator's acceptance, the publication row:

| Recorded facts | Main wording (`data-work-status`) |
| --- | --- |
| done, no finished attempt | Marked done without a build record (`no-build-record`) |
| scout result | Report ready (`report-ready`) |
| operator accepted, any verdict | Accepted with an exception (`accepted-exception`) — never "Checks passed" |
| refuted, reason = the approved verification command exited *n* | Changes saved, but checks failed (`checks-failed`), exit code named |
| refuted, any other reason (mismatched changed path, altered statement, contradicting caveat, reviewer contradiction) | Result saved, but its evidence does not match (`evidence-mismatch`) — never a failed-test claim |
| short, or no verdict on a built run | Result saved — verification needed (`verification-needed`) |
| no-change with handoff and sealed diff (verdict null, attested or verified) | No changes were needed (`no-change`); missing records → `record-incomplete` |
| attested | Result saved — checks reported by the agent (`agent-attested`) |
| verified, no publication | Ready to review (`ready-to-review`) |
| verified + observed publication | PR opened / Merge observed / PR closed without merging (`pr-opened` / `merge-observed` / `pr-closed`) |

A refuted or short verdict is never masked by a no-change outcome. A
published-but-unverified result keeps its evidence problem as the headline and
carries the publication in the detail. Deployment is never claimed: the merge
wording says "Deployment is not confirmed by any record here."

The same words render on every touched surface for the same run, each tagged
`data-work-status`: the Work row, the task page's title status and status box
(replacing the raw `done` badge and "Complete — verified / Complete with
evidence / Conflicting evidence / Missing evidence"), the focused chat's
journey headline and receipt, the review cockpit's headline chip, and the run
page's evidence card. `diagnoseTaskDispatch` (CLI, Telegram, chat overview)
takes its done-task summaries from the same projection; its codes and
conditions are unchanged, except that a no-change conclusion with both its
records is now `complete` rather than `needs-verification`.

The completion receipt's unconditional **What shipped** heading is gone. The
heading is what the record supports — *Changes saved*, *No changes were
needed*, *PR opened*, *Merge observed* — followed by the publication fact
("Saved on the build branch — not published, merged, or deployed." / "PR #482
is open on GitHub. Merging stays a person's act; nothing is merged or deployed
yet.") and the shared status line. The criteria count says "cited by the
agent — not verified" whenever the result is not verified.

### Phone task list

The `/tasks` intro leads with the project label and shows the raw repository
path on its own wrapping line (`.path-words { overflow-wrap: anywhere }`).
The phone project pill also stopped inheriting the desktop switcher's
`align-items: center`, which let a long project name widen the document at
320 px. Baseline: 522 px document width at 390 px
(`output/playwright/workspace-1/before/phone-tasks.png`); after: 390/390 and
320/320.

## Files

`src/serve.ts`, `src/dispatch.ts`, `src/workspace-ui.ts` (new, pure),
`src/serve.test.ts`, `src/dispatch.test.ts`, `src/workspace-ui.test.ts`
(new), `src/telegram-status.test.ts`, `scripts/ui-polish-fixture.mjs`
(fourteen synthetic status tasks, an optional second long-path project and an
empty third), `scripts/workspace-proof.mjs` (new), this record. No store
schema, authority, migration, approval, revision, draft or request-idempotency
code changed.

## Verification

Commands, run from this checkout:

| Command | Result |
| --- | --- |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (the unchanged approved verifier) | two serial runs, the second on the final tree: 162 files, 2801 passed, 23 skipped, exit 0 each time |
| `npx vitest run src/workspace-ui.test.ts src/dispatch.test.ts src/telegram-status.test.ts` | 39 passed |
| `npx vitest run src/serve.test.ts` | 269 passed (5 new `workspace package 1` tests; 14 label/navigation assertions updated, none dropped) |
| `npm run build && node scripts/workspace-proof.mjs --out output/playwright/workspace-1/after --strict` | 141/141 checks, 23 screenshots |
| `node scripts/ui-polish-proof.mjs --out output/playwright/workspace-1/ui-polish-regression --strict` | 75/75 checks — the prior package's approval, both revision modes, draft, keyboard, reduced-motion and fresh-composer checks still pass on the extended fixture |

New regression tests: the three-destination shell per page and per role; Work
views, counts, ordering and empty states over queued / waiting / held /
paused / failed / cancelled / running / failed-check / mismatched / missing /
agent-attested / accepted / verified / PR / merged fixtures; same-run status
agreement across Work, task page, focused chat and review cockpit (with the
failed-check vs mismatch distinction, "never Ready to review", "never Checks
passed", "never shipped"); the All-projects `/r/<id>` deep link with
unchanged 404s; the task-list label and path wrap; and 7 pure projection
tests.

## Evidence

Generated under the ignored `output/playwright/workspace-1/` (never added to
the source diff; the committed `evidence/ui-polish-2026-09-13/` stays
historical). All PNGs are exact-viewport at device scale 1 and show synthetic
fixture data.

Before (baseline `43c102b`, same extended fixture, `output/playwright/workspace-1/before/`):
`desktop-inbox.png`, `desktop-tasks.png`, `desktop-task-failed-checks.png`
(raw `done` badge, "What shipped" over a failed check),
`desktop-run-deep-link-all-projects.png` (landed on `/projects`),
`phone-tasks.png` (522 px overflow), `phone-menu.png`, and matching phone
captures.

After (`output/playwright/workspace-1/after/`, captions in `report.json`):
`desktop-work-all.png`, `desktop-work-needs-you.png`,
`desktop-work-completed.png`, `desktop-work-empty.png`,
`desktop-work-all-projects.png`, `desktop-work-tools-open.png`,
`desktop-task-failed-checks.png`, `desktop-chat-failed-checks.png`,
`desktop-review-failed-checks.png`, `desktop-run-deep-link-all-projects.png`,
`phone-work-all.png`, `phone-work-needs-you.png`, `phone-work-completed.png`,
`phone-work-empty.png`, `phone-work-empty-needs-you.png`,
`phone-work-tools-open.png`, `phone-menu.png`, `phone-task-failed-checks.png`,
`phone-tasks-long-path.png`, `narrow-work-320.png`, `narrow-tasks-320.png`,
`chat-fresh-1440x900.png`, `chat-fresh-1280x800.png` (each a NEW empty
conversation, the whole composer and send control inside the first viewport).

Measured: no document horizontal overflow on `/work`, `/work?view=needs-you`,
`/tasks`, `/t/<id>`, `/r/<id>`, `/chat`, `/menu`, `/projects` at 320, 390 and
1440 px; phone view tabs, header controls and tab-bar targets ≥ 40 px;
every 320 px header control inside the viewport.

Payload: `/work` serves 197,805 bytes uncompressed (168,324 inline CSS,
7,144 inline JS). The shared stylesheet grew by about 5.4 KB, so the five
pages the UI-polish report measured grew from 180.8–198.5 KB to 187.3–207.9 KB
uncompressed. Calculated sizes, not transferred sizes.

## Limitations and caveats

- The chrome's needs-you count now runs the dispatch diagnosis over the
  bounded Work page (≤ 200 tasks) per viewer and project, cached five seconds
  like the old count. It is a behaviour change: the app-icon badge and every
  "N needs you" now include held, paused, builder-disconnected and
  unverified-result tasks. The old count's decision/approval semantics survive
  on the inbox page itself.
- A done task whose review is in flight or queued shows the review's words on
  the Work row and the chat headline (from the diagnosis) while the receipt's
  status line shows the stored verdict; no fixture exercises this, so it is
  untested here.
- The `/tasks` state filter still wears raw state badges — it is the
  state-filter tool by definition; the task page's own master pane now says
  "finished" instead of "done".
- Screenshots and reports live in the ignored output directory as the brief
  asks; a verifier that reads only committed files will not find them.
- The task journey's five steps still mark "Result" complete for a saved
  result with failed checks; the headline, badge and receipt say otherwise.
  The journey component belongs to package 2/3.
- Reviewed in headless Chromium only; no Safari keyboard behaviour was
  observed. Fixture data is synthetic and labeled so.
