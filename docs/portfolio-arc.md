# Portfolio arc — spec v5

Console arc for standing-orders `src/serve.ts`. Translates the approved parts of the Claude
Design mockups (screens 1a/1b/1c) under the owner's 2026-08-31 decisions: nav
**Inbox · Work · Builds · Fleet · More** with a persistent scope bar and project chips;
scope split by surface; parked decisions answered inline only when reversible; slices =
1a-as-Portfolio, 1b queue polish, 1c task detail.

v2 closed the v1 findings on routes, metrics, gaps, deferrals, copy, and nav. v3 closes the
round-2 findings: all-scope visibility hygiene, true front semantics for the queue fix, the
roll-up inbox links-only contract, the exhaustive outcome vocabulary, a sensitive-page
composition guard, truthful queue capacity, scope-bar placement/ownership, and
per-capability publication-grant copy.

## 0. Hard boundaries (amended)

- **No schema changes, no new writes, no new authority, no new routes.** Exactly **one**
  new read-only store query is allowed: `portfolioLedgerScoped` (§2); every other feed
  reads existing queries. Explicitly OUT:
  global pause dispatch, idle-spend accounting, generic web Paste-key/Verify, per-worker
  daily rails, remote runtime telemetry, per-worker intent lines, any new timestamp field.
- URLs stay stable, including `/workbench?t=...` and `/workbench?fragment=rail` — the
  two-pane selected-task behavior and rail fragment contract are PRESERVED by 1a
  (serve.test.ts:3379–3411 keep passing unmodified).
- Amber = waits-on-you only; recommended option never amber; blue never for selection.
- Copy: plain words; "last 24 hours" (of run **start** — see §2), "running", measured /
  unmeasured honesty; **"stop threshold"** never "ceiling" (store.ts:492 semantics).
- Existing test coverage is thin on nav labels (v1 overstated it); every slice ADDS the
  contract tests listed in it, and any assertion a change does touch is updated in the same
  commit, never weakened silently.
- Demo banner and fixture honesty untouched. Sensitive (password) screens gain no new
  scripts or forms; the scope bar is inert HTML there.

## 1. Navigation & scope (lands with slice 1a)

Desktop sidebar (labels/grouping only; routes unchanged):

- **inbox** → `/`
- **portfolio** → `/workbench`
- **work** (`nav-label` group): **board** → `/board`, **queue** → `/queue`
  (dependencies joins here in a later arc)
- **builds** → `/runs`
- **fleet** → `/fleet`
- **more** (foot): activity, review, [chat], task list, routines, done, system,
  requirements, [settings]

Mobile: tabbar stays inbox / board / queue / builds / more — a recorded, deliberate
deviation from the five-category model (thumb reach beats taxonomy); `/menu` keeps
everything it has today **including people, operating mode, and its own switch-project
row** (serve.ts:1490), plus routines and done. The one-`/projects`-link invariant is a
CHROME invariant — `/menu`'s project row is page content and an intentional exception.

**Scope bar** — one hairline row under the demo banner on every screen. It REFLECTS shipped
scope semantics rather than inventing new defaults:

- It derives from route/surface + `Chrome.project`, not from `Chrome.project` alone:
  workbench and fleet read `all projects` even while a session has a project selected;
  board reads the project, or `all projects` under `?scope=all`; inbox reads the project
  when one is selected, `all projects` when none (current serve.ts:882 behavior, unchanged);
  queue/routines/requirements/runs read the project (their no-project redirect to
  `/projects` stays, serve.ts:732).
- Placement: inserted between the demo banner and the main/split body inside `.content`
  (serve.ts:6586), so it can never disappear with workbench's hidden list pane. `Chrome`
  gains an explicit surface-scope field ("all" | "project" | "board-all"), because
  `Chrome.project` alone cannot distinguish `/board?scope=all` (serve.ts:6192).
- Ownership: it REPLACES the desktop sidebar workspace card. One visible `/projects`
  link per breakpoint: on desktop it lives in the scope bar; on a phone (≤760px, amended
  by the 2026-09-01 mobile pass) the scope bar is hidden and the sticky header pill IS
  the scope row — project name, the three counts, and the link — so the phone header is
  one row instead of three. The "switch project" copy survives verbatim inside the bar so
  serve.test.ts:1432 keeps passing unmodified.
- Display + navigation only: the bar's `/projects` link is a GET navigation. Project
  switching remains the existing POST + CSRF flows (`/projects/select` serve.ts:3169,
  `/projects/open` serve.ts:3187, forms at serve.ts:8468); no `?project=` GET mutation
  anywhere, ever.
- `/runs` stays project-scoped this arc. An all-projects builds view is OUT (doing it right
  needs admission-before-limit pagination; deferred rather than done naively).

**Project chips**: every row in an all-projects view (inbox unscoped, portfolio, fleet
claims, board `?scope=all`) names its project with the mono `projectName()` chip, linking
to the entity (`/t/:id`, `/r/:id`) — never switching session scope.

Contract tests (slice 1): scope-bar words per surface (workbench=all projects even with a
project selected; queue=project); chip present on portfolio rows; scope bar contains no
form/script on the ceremony-bearing pages.

## 2. Slice 1a — Portfolio (`/workbench`, relabeled; rail + `?t=` contracts preserved)

The overview pane recomposes into four sections. Data sources are named; one is a new
read-only query.

**All-scope hygiene (applies to every feed below, copying the shipped workbench pattern at
serve.ts:964)**: `admissionList()` (serve.ts:434) is passed BEFORE any SQL limit on
approvals, requeues, and cancelled blockers; unlimited feeds (`listDecisionsScoped(null)`,
`runsSinceScoped(since, null)`, `liveClaims(null, now)`) are post-filtered through
`visible()` on their repo before rendering OR tallying — hidden projects may not leak into
counts, spend, tokens, rows, or claims. Contract test: an out-of-ceiling run with a
distinctive title, cost, token count, live claim, and decision affects no portfolio row or
aggregate.

1. **waits on you** — the existing scoped attention kinds, each an amber-outlined card with
   a project chip when unscoped: decisions (`listDecisionsScoped`), scope approvals
   (`scopesAwaitingApproval` → "review and sign" links to the existing ceremony),
   requeues/strikes (`listRequeueablesScoped`), **cancelled blockers**
   (`listCancelledBlockersScoped` — v1 omitted them; they stay). **Capability gaps keep the
   existing project-relative rule** (serve.ts:882): shown only for the selected project via
   `computeGaps`; unscoped portfolio shows the existing "gaps are checked one project at a
   time" line linking `/projects`. No cross-project gap fan-out this arc (no deep-link road
   to another project's `/caps` exists without scope mutation).
2. **last 24 hours** — honestly framed as **runs started in the last 24 hours**
   (`runsSinceScoped` is a started_at window, store.ts:10353): counts grouped by the
   EXHAUSTIVE stored outcome vocabulary — built / no change / failed / refused / parked /
   interrupted / unfinished (store.ts:400; zero-count groups omitted from display, never
   folded into each other — `tally()`'s built+no-change fold is not reused for these
   counts). Spend renders `spendLine()` **verbatim** (summary.ts:43 — it says "measured
   across all N invocation(s)" when everything measured, "N/M" otherwise; the spec dictates
   the function, not a phrase). Tokens come from invocations that reported token usage
   (tally.tokens, summary.ts:37 — independent of whether cost was measured). **No "PRs
   opened" count** (no immutable opened-at timestamp exists; forbidden to add one). PR
   numbers appear on ledger rows instead, without a time claim.
3. **running** — `liveClaims()` rows, running chips, project chips.
4. **terminal runs started in the last 24 hours** — ledger rows for runs started in the
   window that
   reached a TERMINAL outcome: SQL predicate `outcome IS NOT NULL`, i.e. built, no-change,
   failed, refused, parked, and interrupted, each wearing its own chip (no-change distinct
   from built; unfinished/null rows are excluded — a live one is already in **running**,
   a crashed one belongs to the reconciler, not this ledger). Row: title, outcome chip,
   mono meta (provider · model · duration · measured-or-unmeasured cost · PR # when a
   publication exists), project chip. **The one new read-only query**
   `portfolioLedgerScoped(repo: string | null, since: string, limit: number, admitted:
   string[] | null)` — signature and shape copying `listCompletedWorkScoped`
   (store.ts:12920): one SQL join over runs started in the window × task ref/title ×
   publication row (`publication.run` is unique, store.ts:2066, so the left join cannot
   duplicate rows); outcome predicate `outcome IS NOT NULL` (the §"finished" population
   above); the admission predicate sits inside `WHERE` before `ORDER BY … LIMIT`, with a
   post-query `visible()` recheck in serve. Tests: the distinctive hidden-row leak test
   AND an admission crowd-out test — more hidden recent rows than `limit` plus one older
   admitted row; the admitted row must survive (admission applied before LIMIT, not after).

**Decision card partial** (shared by portfolio, the SELECTED-PROJECT inbox, and 1c): recap,
then each option as its real label + consequence + `reversible`/`irreversible` tag +
`recommended` prefix. Reversible option = a form POSTing `choice` (+ csrf) to the existing
`POST /d/:id/answer` (serve.ts:3588 contract; no endpoint changes). Plain-form behavior:
the existing 303 to the decision page, which shows the answered state — accepted. With JS: progressive
enhancement submits via fetch with an **`application/x-www-form-urlencoded` body**
(`URLSearchParams(new FormData(form))` — raw FormData would go multipart and hit the 415
gate, serve.ts:487), follows the default redirect to `/d/:id`. **Success disposition —
the card is EXPECTED to disappear**: an answered decision leaves `listDecisionsScoped()`
(open/expired only, store.ts:10574), so a surface re-fetch will not contain it. The
enhancement therefore replaces the original card (located by a stable `data-decision-id`
attribute) with an answered receipt parsed from the followed `/d/:id` response
(serve.ts:10536) — or, minimally, removes just that card — and touches nothing else; the
inbox quick-capture fields' typed input survives (the no-refresh contract, serve.ts:6836 /
serve.test.ts:986; a test proves neighboring typed input is preserved across an answer).
On an authentication failure or an unexpected response shape it navigates instead of
inserting anything. No card-fragment route is added. Irreversible
options render as links to `/d/:id`, where the server-side `confirm=yes` guard lives.
Never letters as answer labels.

**Roll-up inbox stays links-only.** The projectless roll-up inbox's contract — "links only,
acting means opening the project" (serve.ts:882, 6696) — is PRESERVED: there, decision
cards render options as text with a link to `/d/:id`, no forms. The interactive partial
appears only on the selected-project inbox, portfolio (whose all-scope forms carry the §2
hygiene + csrf), and the task page. Contract test: roll-up inbox contains no
`/d/:id/answer` form; selected-project inbox does.

Contract tests: no pause control; no idle-spend string; "runs started in the last 24 hours"
wording; outcome words match store outcomes; reversible option is a form to `/d/:id/answer`
without `confirm`; irreversible option is a link, not a form; recommended row not amber;
ledger row carries measured/unmeasured; rail fragment + `?t=` tests still green.

## 3. Slice 1b — Queue (polish + two named behavior changes)

v1 called this "behavior frozen"; the review showed it is not. This slice contains exactly
two behavior changes, both fixes:

1. **Bug fix — move-to-front fallback**: the no-JS form submits `before="__TOP__"`
   (serve.ts:8561) which the handler rejects as an unknown task (serve.ts:3364).
   `moveTask()` partitions free members by destination runner AND the moving task's exact
   repo (store.ts:4706), and the queue snapshot is bounded (200 rows, store.ts:4761), so
   "first task in the column" is NOT the front. The fix contract, exactly:
   1. `__TOP__` is accepted only when `column` equals the task's existing assignment — the
      no-JS move-to-front button's exact case; any other use gets the existing typed
      refusal (no sentinel-based cross-column moves — the bounded snapshot cannot prove
      the front there).
   2. The handler filters the existing snapshot by the moving task's exact `repo`, the
      same assignment, and `taken === false` — and **the moving task itself must be
      present in that filtered partition**. If it is absent or marked taken (a live claim
      or contest can land after the form rendered WITHOUT bumping `queueRevision`,
      store.ts:804/4783), the handler returns the existing typed 409 refusal — never the
      no-op success, which would bypass `moveTask()`'s claimed/contest recheck
      (store.ts:4687).
   3. If the moving card is present and no free card precedes it, the move is an
      already-front no-op — but ONLY after an explicit handler-side revision check: the
      submitted `queueRevision` is compared against the existing `queueRevision()` read
      (store.ts:4646) and a mismatch is the typed 409 (the only revision CAS today lives
      inside `moveTask()`, store.ts:4677, which this branch never calls).
   4. Otherwise the first free card's REAL id is passed to `moveTask()` untouched.
   5. The submitted `queueRevision` CAS (inside `moveTask()`) rejects races on the moving
      branch.
   Regression tests assert the resulting ORDER within the partition (including a
   mixed-repo column fixture), never merely a 200 — plus: render `__TOP__`, claim or
   contest the task without a `queueRevision` change, submit → 409 and unchanged order;
   and stale-revision + already-front → 409.
2. **Inline refusal rendering** (client-only): the fragment path already returns a typed
   `text/plain` 409 (serve.ts:3343) that today's script discards (serve.ts:8817). The
   script now renders that text as a problem row on the affected card instead of a blind
   navigate-back. Server contract unchanged.

Card content is presentation over the EXISTING `queueScoped()` shape (store.ts:4761:
approval boolean, blocker count, reservation owner, taken): state chip
(queued/reserved), `scope unapproved`, `N blockers`, reservation owner. **No running or
held rows** (the query is `state='queued'` only — running lives on board/portfolio), **no
dollar figures** (budget/threshold data isn't in the queue query; rather than widen it,
money stays on the task page where it is labeled).

Column headers are the one place queue reads BEYOND `queueScoped()`: worker name +
**`N building in this project · unattended capacity M`** — never a `N/M` ratio, because N
(live claims in the open project, `liveClaims(project, now)`) and M (the runner's GLOBAL
unattended capacity, which attended claims may legitimately exceed, claim.ts:447) are
different scopes; a ratio would show `0/1` for a worker busy in another project. The route
keeps `capacity` instead of discarding it (serve.ts:1398). Never "slots" for queued cards —
reservations are not occupied capacity. Shared column explained in plain words ("workers take from here
when their column is empty"). The claim-primitive sentence moves behind `<details>`.
Keyboard: the existing Tab/select/button forms remain the accessible path (global j/k does
not target queue cards today; extending it is optional polish, not a contract).

Contract tests: `__TOP__` move-to-front yields the asserted partition order (never merely
a 200); already-front no-op; cross-column `__TOP__` refused; refused move renders the
typed text inline (fixture); no unlabeled `$` figure on the screen; details element.

**Inline refusal transport**: the client inlines ONLY `text/plain` refusal bodies from an
AUTHENTICATED 409 (serve.ts:3343 — unauthenticated POSTs are also plain text,
serve.ts:712, and must navigate to login instead), assigns them via `textContent` — never
`innerHTML` — and navigates/reloads on HTML (e.g. the stale-`projectRevision` HTML 409 via
`refuse()`, serve.ts:3333), authentication, or any unexpected response. Today's script discards all
non-OK bodies (serve.ts:8817); this is the deliberate replacement behavior.

## 4. Slice 1c — Task detail (`/t/:id`)

- **Active attempt panel** when `runsFor(...).find(runIsLive)` hits: header
  **`build #<run.id> · <worker> · running Xm`** (the unambiguous existing identity —
  `runsFor` mixes builder/repair/planner/reviewer roles newest-first, store.ts:10401, so
  an "attempt N" ordinal is undefined and is not used), embedded live transcript + peek. The existing
  pollers hardcode `location.pathname` (serve.ts:6274, 6300) — parameterize them to fetch
  `/r/<liveRunId>?fragment=peek|transcript` (the existing authenticated, visibility-checked
  endpoints, serve.ts:1538). **No `/t/:id?fragment=` proxy routes.** Link `full build
  view →` to **`/r/:id`** (v1's `/runs/:id` was wrong). Task/Run split preserved.
  **Sensitive-page composition guard**: a live attended attempt can coexist with an
  unapproved scope, so the task page may carry a password ceremony; `sendScreen()`
  suppresses chrome scripts there but keeps functional ones (serve.ts:2195). On any
  password-bearing task page: no live pollers run, the panel degrades to a static line +
  `full build view →` link, and the decision partial renders link-only — the "sensitive
  screens gain no new scripts or forms" boundary holds by construction, with a contract
  test on a fixture that has both a ceremony and a live run. The existing degraded states
  are preserved verbatim: the `--runner`-absent "off" state and the Claude-only transcript
  limitation (serve.ts:10007).
- **Right rail**: approved-scope card with digest seal (existing data, Ledger styling);
  the shared decision-card partial; economics rows `this attempt` / `task total`, each
  explicitly measured or unmeasured; `publishes as` derived ONLY from
  `publicationGrantFor(repo)` (store.ts:12507 — never `listGrants()`, which is dispatch
  authority, store.ts:5617). Push, open-PR, and merge are INDEPENDENT fields on the
  PublicationGrant record (store.ts:722): the renderer phrases each separately ("may
  push", "· may open a PR" only when true, "· cannot merge" / "· may merge" from the merge
  field) and says "no publication grant" when absent. Contract tests cover all four
  fixtures: no grant, push-only, push+PR without merge, merge-capable.
- **Hold** relabeled `hold next attempt` (verified accurate: operator hold never disturbs
  a live claim, serve.ts:4811). **Requeue** copy: "retry becomes available after this
  attempt finishes" — a live claim refuses `claimed` today (store.ts:8078); the button
  must not imply deferred queueing.
- Attempts ledger restyled as Ledger rows. The existing task-page copy contracts
  (serve.test.ts:3547–3570) are reviewed one by one: any the panel supersedes are updated
  in this commit with equivalent-or-stronger assertions, none deleted.

Contract tests: panel names run identity; pollers hit `/r/<id>` fragments (not the task
URL); grant-present and grant-absent publishes-as words; `hold next attempt` label;
requeue copy; measured/unmeasured on both economics rows.

## 5. Sequencing

Three commits — 1 (nav + scope bar + portfolio + inbox decision partial) → 2 (queue) →
3 (task detail). Each commit: its behavior changes only, its contract tests, suite green.
Codex review after commit 1 and after commit 3.

## Recorded deviations & deferrals

- Mobile tabbar keeps board/queue/builds directly (deviation from the five-category model).
- All-projects builds view: deferred (admission-before-limit pagination is its own slice).
- Cross-project capability-gap fan-out: deferred (needs a scope-safe deep-link design).
- Queue money/held/running metadata: deferred with the same reasoning.
