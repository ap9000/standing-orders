# Chat stop and resume — 15 September 2026

Chat can request a stop for the exact current attempt and open the existing resume password ceremony. Changes are uncommitted on `standing-orders/chat-stop-resume-20260915`.

## Baseline and candidate

Verified before implementation: HEAD and the available baseline commit were both `a97f74b996fdef66b7aa1884c7e79a051b45af72`. The branch and HEAD remain unchanged. The installed checkout and its database were not used to obtain the baseline.

Code and test content digest: `d567aa7328b221fae76cc7a9f288c51f5ace73c85d023c274a2b371dc94590ea`. [Candidate manifest](../evidence/chat-stop-resume-2026-09-15/candidate.json) names every hashed file; hash input is each sorted relative path, NUL, file bytes, NUL. Documentation and screenshots are separate evidence. The machine will seal the complete uncommitted candidate.

## Behavior and authorization

- `get_task` exposes the observed control state and run. Stop/resume proposals require that exact run and the current task stamp; unavailable, changed or superseded attempts refuse.
- Stop uses `requestTaskStop`. The proposal receipt and durable stop commit together before signalling owned processes. A rolled-back confirmation signals nothing. Replays do not create another stop or dispatch work.
- Resume proposals only request review. The browser calls the same `armTaskResume` helper as task detail, then submits to the existing `/t/:task/resume` password endpoint. The nonce still binds the approver, run, settlement and current approval. Wrong passwords, stale approvals and replayed nonces refuse. Resume lifts only the stop-owned hold and grants no approval.
- The existing task-control/status projection supplies both screens. Chat shows Stop requested before acknowledgement, then Paused after settlement. Resume reports the remaining task status without inventing a new running attempt.
- Existing tab draft storage and live-region reconciliation preserve the composer on confirmation, refusal and task-page updates. Finished results, saved feedback and revision lineage use the baseline services unchanged.

The baseline has no `src/control.ts`, `src/control.test.ts`, or `src/mate-tools.test.ts`. The relevant owners are `src/task-control.ts`, its existing suites, and the mate/action suites. The shared UI fixture gained an option to avoid creating Git history and an injected scripted runner for this focused journey.

## Focused verification

Prepare a scratch directory inside the checkout with `mkdir -p output/test-tmp` if needed. The standard test setup compiles this worktree when its local runtime is stale; the builder did not separately invoke the full verifier or rebuild the installed checkout.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed on final code. |
| `TMPDIR="$PWD/output/test-tmp" npx vitest run src/chat-task-actions.test.ts src/mate-doors.test.ts src/mate.test.ts src/task-control-console.test.ts src/task-control.test.ts src/chat-continuity.test.ts src/chat-polish.test.ts` | 103 tests passed across 7 affected suites. |
| `npm run typecheck && TMPDIR="$PWD/output/test-tmp" npx vitest run src/mate-doors.test.ts src/serve.test.ts -t 'stop confirmation&#124;chat review'` | 3 selected tests passed: rollback-before-signal and the two chat review/revision cases. Other cases were excluded by the name filter, not changed or skipped in source. |
| `TMPDIR="$PWD/output/test-tmp" npx vitest run src/task-control-process.test.ts` | 2 tests passed with real local subprocess trees, including independent attempts and stop settlement. No live model was involved. |
| `node scripts/chat-stop-resume-journey.mjs --capture` | 64 assertions passed; saved the eight screenshots below. |
| `node scripts/chat-stop-resume-journey.mjs` | 64 assertions passed again in the durable non-capturing mode cited by the proof; scratch fixtures were removed. |

The browser journey covers 1440×900 and 390×844: empty chat; exact stop confirmation; pending acknowledgement; task-detail agreement; resume password confirmation; wrong-password and stale-card refusals; draft preservation; saved work and scope preservation; result Changes inspection; long saved feedback; same-task revision and replay rejection. Desktop forms were submitted by keyboard. Phone confirmation buttons were measured at least 44×44 pixels with single-line labels. No page script errors or document overflow were observed. [Browser assertion report](../evidence/chat-stop-resume-2026-09-15/browser-report.json).

The unchanged approved full verification command has **not** run in the builder. Criterion c4 is pending-verification for the machine's final gate on the exact sealed candidate. Its command and exit result must come from the machine; this note invents neither.

## Simplicity pass and screenshots

Before: long unbroken task names widened the 390px page to 1700 CSS pixels and interfered with tapping Start the conversation. After: chat, task detail and resume titles wrap; the same journey has no document overflow. Before: resume terms exposed a long internal worktree path alongside implementation language. After: concise consequences and full approval limits stay visible, while the stop record and path live in one disclosure. Stop proposals now say Stop task? and name the task and run; the primary actions are Stop task, Review resume and Resume task.

| Screenshot | What it demonstrates |
| --- | --- |
| [Desktop empty chat](../evidence/chat-stop-resume-2026-09-15/desktop-empty.png) | Running task and available Stop task control before conversation. |
| [Desktop stop confirmation](../evidence/chat-stop-resume-2026-09-15/desktop-stop-confirm.png) | Exact task/run, saved-work consequence and one primary confirmation. |
| [Desktop stopping](../evidence/chat-stop-resume-2026-09-15/desktop-stopping.png) | Observed Stopping status and Stop requested receipt. |
| [Desktop result](../evidence/chat-stop-resume-2026-09-15/desktop-result.png) | Exact result, Changes view, diff and a long feedback path. |
| [390px long confirmation](../evidence/chat-stop-resume-2026-09-15/phone-stop-confirm-long.png) | Full long task name, consequence and unbroken Stop task button. |
| [390px resume ceremony](../evidence/chat-stop-resume-2026-09-15/phone-resume-password.png) | Exact target, retained limits, optional record and password control. |
| [390px refusal and draft](../evidence/chat-stop-resume-2026-09-15/phone-refusal-draft.png) | Stale-card refusal with the unsent draft still present. |
| [390px same-task revision](../evidence/chat-stop-resume-2026-09-15/phone-revision.png) | Same task title, Needs your approval, Review plan and history. |

All images are real Chrome viewport captures of synthetic fixture data. They are not live-model execution proof. Physical phone/Safari behavior and the mobile software keyboard were not tested. Real-subprocess tests verify local process behavior separately from the scripted browser acknowledgement.

## Execution receipt

- Builder model: GPT-6, as identified by this session. Its exact backend variant was not exposed; no more specific model identifier is claimed. No subagents were used.
- Browser chat provider: scripted fixture answers; configuration labels Codex/default but makes zero external model calls. No live-provider canary or API billing was used.
- Elapsed reference: lease creation at 2026-09-15T14:10:42.834Z to receipt at 2026-09-15T14:33:31.362309+00:00, 1368.5 seconds (22.8 minutes). This includes tool waits and fixture debugging; earlier dispatch time is not measured.
- Operator interventions: zero; no permission questions or manual operator repairs. Builder corrections included a missing worktree in a new test fixture, an outdated schema assertion (58 → current 60), hidden-control waiting and feedback-button selectors in the browser script, choosing installed Chrome after a cached Chromium executable was absent, and the reproduced long-title CSS defect. Failed exploratory checks were corrected before the passing results above.
- No commit, branch switch, push, PR, deployment, installed-database migration, provider/permission change, or full-verifier invocation was performed by the builder. Source HEAD remains the approved baseline; the machine owns the commit and final gate.

## Repair 1 (c4): the final gate on `b8594f1`

The machine's full verifier on the sealed candidate `b8594f1` exited 1: 5 files, 9 tests failed. Diagnosis on this repair branch (`standing-orders/chat-stop-resume-20260915-fix-1`) reproduced all nine and traced each to an assertion that the `native-chat-flow` baseline lineage had left behind, not to the stop/resume behavior. No product code changed in this repair; no test was deleted or skipped.

| Failing test | Cause | Repair |
| --- | --- | --- |
| `migration-v53-process-custody`, `migration-v58-project-learning`, `recipe-creator` (v56 upgrade) | Pinned `SCHEMA_VERSION` to 58; `6c12fc1` (before baseline `a97f74b`) bumped it to 60. Migrations are additive and stamp the version last, so old files land at the current version. | Pins moved to 60, matching `task-control.test.ts`. |
| `project-knowledge` (v58 upgrade) | Asserted the migrated file's `schema_version` is 59; current is 60 for the same reason. | Expected file version 60. |
| `serve` legacy long plain/annotated/mixed feedback (3) | Expected the pre-`a97f74b` "N note(s) ready" card with a bare Revise button. `a97f74b` intentionally shows "Saved for later · N" and one Request changes submit inside the comment form; the sealed batch and `/r/:run/revise` road are unchanged and still exercised. | Assert the current projection and the absence of the old card; seal, refusal and replay assertions kept. |
| `serve` task filed from chat → focused conversation | Expected the "The planner is preparing a scope for you" card that `f53b7f1` removed because the task status card already names planning. | Assert the one task-journey card with `data-plan="requested"` and no second planning card. |
| `serve` focused chat agents strip | Expected the `<p class="task-chat-agents">` eyebrow strip that `4ce2b88` turned into an `Agent setup` disclosure. | Match the disclosure: summary, agents sentence, View agents link; jargon check kept. |

A sixth `serve` case (`opening a project: outside the ceiling refused`) failed only while `TMPDIR` pointed inside this checkout, because the "not a git repository" fixture path then sat inside this worktree. It passes under the default temporary directory, which is what the gate uses; the earlier `TMPDIR` advice above is unnecessary and was not used for the results below.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npx vitest run src/serve.test.ts src/project-knowledge.test.ts src/recipe-creator.test.ts src/migration-v53-process-custody.test.ts src/migration-v58-project-learning.test.ts` | 5 files, 329 tests passed (exit 0). |

The unchanged approved full verifier was not run by the builder; it runs once at the machine's final gate for this repaired candidate. Remaining gap: `scripts/workspace-result-proof.mjs` (an older package's browser proof) still looks for "2 notes ready"; it is not part of the verifier and was left outside this criterion repair.

Repair receipt: builder Claude Opus 5 (`claude-opus-5`), no subagents, no live model calls, zero operator interventions. Started 2026-09-15T15:54:55Z (steering note) and finished about 2026-09-15T16:02Z, roughly 7 minutes including two full `serve.test.ts` runs. No commit, push, branch switch, migration of the installed database, or provider/permission change.

## Repair 2 (build #1604 comment 292): the clipped phone revision and a shorter stop confirmation

Branch `standing-orders/revise-chat-stop-resume-20260915-fix-1-from-1-annotation`, uncommitted on top of `93aa844`.

**Reproduced.** Evidence 792 (`before/phone-revision.png`) is the 390px chat after confirming a same-task revision. The confirmation redirected to `/chat?task=…&revision=…` with no anchor, so the page opened at the top: the reader's own last message ("Apply the saved feedback", 703–760px) sat under the fixed composer (724–784px) and the assistant's receipt — the confirmed card with **Revision created. Review and approve it to start — review & start in chat** — was entirely below the fold (776–1311px). The dark shape peeking from behind the composer was that message bubble. Geometry was measured with a throwaway Playwright script; the same page on desktop (`before/desktop-revision.png`) showed the plan first with the receipt cut off at the fold, without an overlay because the desktop composer stays in the document flow.

**Fixed.**

- A revision confirmed from chat returns to `…&revision=<child>#latest`, the same receipt anchor every other chat confirmation uses. The newest reply, its card and its plan link land readable above the composer on both viewports; the plan itself is one link away and unchanged. The result-panel form road (`/r/:run/revise`) keeps its existing destination.
- While a phone keyboard is open the chat page now grows the same room beneath the raised composer that it has beneath the resting one, and controls keep a matching scroll margin. The viewport script keeps a reader who was at the end of the thread at the end when the keyboard opens — one instant scroll on that transition only, never while reading the middle of a thread or while the keyboard is already up. `src/mobile-viewport.test.ts` covers both branches.
- The stop confirmation is two sentences: **Pauses this task once the run acknowledges the stop. Saved work remains; other tasks continue.** (94 characters, was 142 and three sentences). It still says saved work remains, other tasks continue and the pause waits for acknowledgement; the card still names the exact task, title and run, and the chat-surface task control shares the string.

Drafts, the exact-run stamp and run checks, replay protection and same-task lineage are unchanged; the journey asserts each again.

**Journey additions** (`scripts/chat-stop-resume-journey.mjs`): on arrival at the revision the receipt is the thread's last element, fully above the composer's top, with its plan link visible; a simulated keyboard (the reported visual viewport shrunk by 336px while the composer is focused, so the page's own script raises the composer) keeps the receipt's end and link above the raised composer with the draft intact; the confirmation consequence is at most two sentences and 110 characters and names other tasks and acknowledgement. Desktop now captures the refusal and the revision too. The simulated keyboard is not a physical device, Safari, or a live model.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npx vitest run src/chat-task-actions.test.ts src/mate-doors.test.ts src/mate.test.ts src/task-control-console.test.ts src/task-control.test.ts src/chat-continuity.test.ts src/chat-polish.test.ts src/mobile-viewport.test.ts` | 8 files, 105 tests passed. |
| `npx vitest run src/serve.test.ts` | 309 tests passed, including the updated chat revision destination assertion. |
| `node scripts/chat-stop-resume-journey.mjs --capture` | 72 assertions passed; wrote the screenshots below. |
| `node scripts/chat-stop-resume-journey.mjs` | 72 assertions passed in the durable non-capturing mode. |

The unchanged approved full verifier was not run by the builder; it runs once at the machine's final gate for this exact candidate. Remaining gap from repair 1 stands: `scripts/workspace-result-proof.mjs` is outside the verifier and untouched.

| Before | After | What changed |
| --- | --- | --- |
| [phone revision](../evidence/chat-stop-resume-2026-09-15/before/phone-revision.png) | [phone revision](../evidence/chat-stop-resume-2026-09-15/phone-revision.png) | Receipt and plan link readable above the composer instead of a bubble clipped behind it. |
| — | [phone revision, typing](../evidence/chat-stop-resume-2026-09-15/phone-revision-typing.png) | Raised composer with the draft; receipt still above it (simulated keyboard). |
| [desktop revision](../evidence/chat-stop-resume-2026-09-15/before/desktop-revision.png) | [desktop revision](../evidence/chat-stop-resume-2026-09-15/desktop-revision.png) | Receipt in view rather than cut at the fold. |
| [desktop stop confirmation](../evidence/chat-stop-resume-2026-09-15/before/desktop-stop-confirm.png) | [desktop stop confirmation](../evidence/chat-stop-resume-2026-09-15/desktop-stop-confirm.png) | Two-sentence consequence. |
| [390px long confirmation](../evidence/chat-stop-resume-2026-09-15/before/phone-stop-confirm-long.png) | [390px long confirmation](../evidence/chat-stop-resume-2026-09-15/phone-stop-confirm-long.png) | Same, with the long unbroken title still wrapping. |
| [390px refusal and draft](../evidence/chat-stop-resume-2026-09-15/before/phone-refusal-draft.png) | [390px refusal and draft](../evidence/chat-stop-resume-2026-09-15/phone-refusal-draft.png) | Unchanged refusal; draft still present. |
| — | [desktop refusal and draft](../evidence/chat-stop-resume-2026-09-15/desktop-refusal-draft.png) | Desktop stale-card refusal with the unsent draft (new capture; the state itself is unchanged). |

The other before captures (`before/desktop-empty.png`, `before/desktop-stopping.png`, `before/desktop-result.png`, `before/phone-resume-password.png`) are the reviewed build's; their after versions are regenerated and differ only where the shorter copy or nothing at all appears. `before/browser-report.json` is the prior assertion list; `browser-report.json` is the current one.

Not changed, on purpose: the previous message scrolling under the top bar on arrival at `#latest` is ordinary thread behaviour, not an overlay over the newest message or a control. The desktop landing now follows the phone's receipt anchor for one consistent chat return; if the plan-first landing is preferred on desktop, that is a product choice to raise, not a defect.

Repair 2 receipt: builder Claude Opus 5 (`claude-opus-5`), no subagents, zero live model calls (the browser provider is the scripted fixture), zero operator interventions. Comment recorded 2026-09-15T16:16:26Z; work ran from about 16:17Z to 16:32Z, roughly 15 minutes including one serve suite run and four browser journeys. Builder corrections along the way: an over-strict "whole message visible" check for the typing state (the receipt is taller than the space above a raised composer, so the check now requires its end and link) and a first keyboard simulation by attribute alone, which the page's own viewport script undid on the screenshot's resize; the simulation now shrinks the reported visual viewport instead. No commit, push, branch switch, installed-database migration, or provider/permission change.
# Current evidence follow-up — 2026-09-15

The task input combines deployed `8efa954` with the existing phone revision
`ec49769` and realistic screenshot-fixture correction `88ef100`. This is an
unverified integration input, not a new claim that the phone revision passed
independent review. Its merge preserves both histories and all deployed
process-identity fixes. Do not move HEAD or replace this prepared checkout with
the older baseline named in the inherited original scope.

Source run 1606's review 1607 upheld c4 but could not determine c1–c3: the old
installed parser could not read inherited evidence, and screenshots/captured
journey output were missing from its sealed package. The installed UI/worker
now both use `8efa954` and schema 60; preserve the old review as history.

Keep the existing phone overlap repair and concise stop consequences. Reuse
`scripts/chat-stop-resume-journey.mjs` for one desktop and 390px journey; inspect
long feedback, failure/draft recovery, same-task revision and simulated keyboard.
Capture current screenshots plus readable command output, include those exact
files in the supported handoff/proof so the independent reviewer can see them,
and explicitly identify inherited unchanged controls. Label synthetic Chromium
evidence honestly; no physical-device claim or live queue manipulation.

Use focused tests and typecheck only while building. The native machine gate
runs the unchanged full verifier once on the final candidate. Do not rebuild
the installed root, rerun the full suite in review, change runtime/settings,
rewrite sealed history or weaken any evidence, approval or execution safeguard.
The screenshot's old repeated filler was fixture text, not actual model output;
the prepared script already replaces it with realistic long feedback.

## Evidence follow-up (build #1606 comment 329): current captures on the prepared candidate

Branch `standing-orders/revise-revise-chat-stop-resume-20260915-fix-1-from-1-ann`, uncommitted on top of `515b307`, which already merges deployed `8efa954` with the phone revision `ec49769` and the realistic-feedback script fix `88ef100`. Verified before any check: `a97f74b`, `8efa954` and `ec49769` are all ancestors of HEAD; the installed checkout and its database were not rebuilt, migrated or read. No product code, test, script, history or runtime setting changed in this follow-up: the phone overlap repair, the two-sentence stop consequence and every deployed process-identity fix stand as merged. What was missing — and is now in the sealed tree — is evidence of that exact candidate.

**Inherited controls, unchanged and exercised by this journey.** Chat adds no second task system; each step lands on the control that already owns it:

| Step in chat | Owner (unchanged in this lineage) | Where the journey proves it |
| --- | --- | --- |
| Stop task confirmation | `requestTaskStop` in `src/task-control.ts`, called from `src/chat-task-actions.ts` with the exact task, run and current stamp | "stop requested is still stopping", "repeated confirmation records one stop" |
| Observed status on both screens | `taskControlOf` projection (`src/task-control.ts`) behind `[data-task-control]` on chat and `/t/:task` | "chat and task show stopping for the same run", "task and chat agree after resume" |
| Worker acknowledgement | `finalizeInterruptedFenced` in `src/claim.ts` (synthetic call in the journey; real subprocess trees in `src/task-control-process.test.ts`) | "task-page acknowledgement reaches chat without clearing draft" |
| Resume ceremony | `armTaskResume` in `src/serve.ts`, then the task page's own `/t/:task/resume` password form and nonce | "resume opens existing nonce and password form", "wrong password refuses resume" |
| Stale card | The proposal confirmation door re-checks the task stamp | "stale card refuses without draft loss" |
| Draft across confirmation, refusal and updates | Tab draft storage and live-region reconciliation in `src/chat-continuity.ts` | every "preserves … draft" and "retains chat draft" check |
| Feedback and same-task revision | Shared `liveDiffComments` history and the one-task revision lineage (`taskFamilyOf`, `revisionLineageOf`) | "result feedback saved in shared history", "revision preserves one task and result lineage", "revision replay creates no duplicate" |

**Focused checks run by the builder** (readable output: [journey-output.txt](../evidence/chat-stop-resume-2026-09-15/journey-output.txt)):

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, exit 0. |
| `npx vitest run src/chat-task-actions.test.ts src/mate-doors.test.ts src/mate.test.ts src/task-control-console.test.ts src/task-control.test.ts src/chat-continuity.test.ts src/chat-polish.test.ts src/mobile-viewport.test.ts` | 8 files, 107 tests passed; its setup compiled this worktree's local runtime. |
| `npx vitest run src/serve.test.ts src/mate-doors.test.ts -t 'chat review|stop confirmation|same task: two revisions'` | 4 selected tests passed (317 excluded by the name filter, none changed or skipped in source). |
| `node scripts/chat-stop-resume-journey.mjs --capture` | 72 assertions passed at 1440×900 and 390×844; wrote the eleven captures below. |
| `node scripts/chat-stop-resume-journey.mjs` | 72 assertions passed again in the durable non-capturing mode the proof cites. |

The unchanged approved full verifier was **not** run by the builder; it runs once at the machine's final gate for this exact sealed candidate, and c4 stays pending-verification until then. Remaining gap from repair 1 stands: `scripts/workspace-result-proof.mjs` is outside the verifier and untouched.

**Screenshots** — all eleven are current Chrome viewport captures of this candidate. Eight are byte-identical to the reviewed build's files (the merge changed nothing they render); the three revision captures now carry the realistic saved feedback instead of the old "Preserve exact feedback" filler, which was fixture text rather than model output. Hashes: [follow-up-manifest.json](../evidence/chat-stop-resume-2026-09-15/follow-up-manifest.json); assertion list: [browser-report.json](../evidence/chat-stop-resume-2026-09-15/browser-report.json).

| Screenshot | What it shows |
| --- | --- |
| [Desktop empty chat](../evidence/chat-stop-resume-2026-09-15/desktop-empty.png) | Running task with its Stop control before any message. |
| [Desktop stop confirmation](../evidence/chat-stop-resume-2026-09-15/desktop-stop-confirm.png) | Stop task? naming the task and Run #, two-sentence consequence, one primary Stop task. |
| [Desktop stopping](../evidence/chat-stop-resume-2026-09-15/desktop-stopping.png) | Task page reads Stopping… while chat shows the confirmed card and Stop requested receipt; the draft is still in the composer. |
| [Desktop refusal and draft](../evidence/chat-stop-resume-2026-09-15/desktop-refusal-draft.png) | Stale card refused in plain words; unsent draft intact. |
| [Desktop result](../evidence/chat-stop-resume-2026-09-15/desktop-result.png) | Exact result, Changes tab, diff and the feedback form. |
| [Desktop revision](../evidence/chat-stop-resume-2026-09-15/desktop-revision.png) | Same-task revision receipt with the realistic feedback and its review link in view. |
| [390px long stop confirmation](../evidence/chat-stop-resume-2026-09-15/phone-stop-confirm-long.png) | Long unbroken title wraps; single-line 44px buttons; no overflow. |
| [390px resume ceremony](../evidence/chat-stop-resume-2026-09-15/phone-resume-password.png) | Resume task? with retained limits, record behind one disclosure, password control. |
| [390px refusal and draft](../evidence/chat-stop-resume-2026-09-15/phone-refusal-draft.png) | Stale-card refusal with the draft still present under it. |
| [390px revision](../evidence/chat-stop-resume-2026-09-15/phone-revision.png) | Receipt and plan link readable above the composer on arrival (the repaired defect). |
| [390px revision, typing](../evidence/chat-stop-resume-2026-09-15/phone-revision-typing.png) | Simulated keyboard: composer raised with the draft; receipt end and link still above it. |

Simplicity pass on these captures: each state has one title, one outcome and one primary action (Stop task, Resume task, review & start in chat); the resume record and worktree path stay behind Stop record and saved work; refusals say what changed and what to do. Nothing further was found to remove without hiding a safeguard, so no copy changed.

Honest labels: synthetic fixture data and a scripted chat provider with zero model calls; the keyboard is a shrunk visual viewport, not a physical phone or Safari; the worker acknowledgement in the browser journey is a direct fenced call, not a live process (real subprocess behaviour is covered by `src/task-control-process.test.ts`, unchanged).

Follow-up receipt: builder Claude Opus 5 (`claude-opus-5`), no subagents, zero live model calls, zero operator interventions or permission questions. Comment 329 recorded 2026-09-15T18:53:28Z; checks and captures ran from about 18:54Z to 18:57Z, roughly 4 minutes, with the handoff written after. One builder correction: none needed — every focused check passed first time. No commit, push, branch switch, installed-database migration, rebuild of the installed root, or provider/permission change.

## Eight-capture follow-up (build #1620 comments 330 and 335): the sealed selection

Branch `standing-orders/revise-revise-revise-chat-stop-resume-20260915-fix-1-fro`, uncommitted on top of `c570410` (the brief in [EIGHT_CAPTURE_REVIEW_2026-09-15.md](EIGHT_CAPTURE_REVIEW_2026-09-15.md) over `7857301`). Verified before any check: `7857301`, `8efa954`, `ec49769` and `a97f74b` are all ancestors of HEAD; the installed checkout and its database were not rebuilt, migrated or read.

Comment 330 was right: the previous proof named eight images but its selection left out states the criteria depend on, while the doc above listed eleven. The proof carries at most eight screenshots (`PROOF_LIMITS.screenshots`); that cap was not raised. Comment 335 fixed the selection, so this follow-up seals exactly those eight and adds the two capture points the journey lacked. **No product code, test, verifier, approval or evidence check changed.** The only source change is `scripts/chat-stop-resume-journey.mjs`: on desktop it now also captures the separate `/t/csv-range-tests` page while it still reads Stopping (before the synthetic acknowledgement changes its state), and on the phone it frames the result so the selected Changes tab, file list and diff start share one 390px viewport, with a new assertion that they do. Eleven of the thirteen captures are byte-identical to the previous follow-up's files, which confirms the product source is unchanged; [follow-up-manifest.json](../evidence/chat-stop-resume-2026-09-15/follow-up-manifest.json) records every hash, the `captureSourceHead` (the product source when the images were captured — `c570410`, not the later commit that stores them), the prior capture head, and which names are sealed versus optional.

**The eight sealed images** (all real Chrome viewport captures, 1440×900 or 390×844, synthetic fixture data, scripted chat provider, zero model calls):

| # | Screenshot | Criteria | What it shows |
| --- | --- | --- | --- |
| 1 | [Desktop empty chat](../evidence/chat-stop-resume-2026-09-15/desktop-empty.png) | c3 | Running now, one Stop task control, the empty prompt and composer before any message. |
| 2 | [Desktop confirmed stop](../evidence/chat-stop-resume-2026-09-15/desktop-stopping.png) | c1, c2 | Chat page: confirmed Stop task? card naming csv-range-tests · Run #9, the header reading Stopping…, the Stop requested receipt, and the unsent draft still in the composer. |
| 3 | [Desktop task detail while Stopping](../evidence/chat-stop-resume-2026-09-15/desktop-task-detail-stopping.png) | c2 | The separate `/t/csv-range-tests` page for the same run #9, captured before its state changed: Stopping…, View stop details, attempt #9 still running. |
| 4 | [Phone stale-card refusal](../evidence/chat-stop-resume-2026-09-15/phone-refusal-draft.png) | c2, c3 | 390px: the long unbroken title wraps, the refused Resume task? card says the task changed, and the draft is intact above the tab bar. |
| 5 | [Desktop result Changes](../evidence/chat-stop-resume-2026-09-15/desktop-result.png) | c3 | Changes tab selected on the exact result, file list with the long inherited path, and the readable payout.ts diff. |
| 6 | [Phone result Changes](../evidence/chat-stop-resume-2026-09-15/phone-result.png) | c3 | 390px: Changes 3 files selected, the file list and the first diff hunk in one viewport with no document overflow. |
| 7 | [Desktop revision receipt](../evidence/chat-stop-resume-2026-09-15/desktop-revision.png) | c3 | Same-task revision confirmed: exact saved feedback, Revision created and the review & start in chat link, task still payout-rounding. |
| 8 | [Phone revision receipt while typing](../evidence/chat-stop-resume-2026-09-15/phone-revision-typing.png) | c3 | 390px simulated keyboard: composer raised with the draft, receipt end and its review link readable above it. |

**Optional captures**, kept in the evidence folder and hashed in the manifest but not in the proof: `desktop-stop-confirm.png` (the pending Stop task? card), `desktop-refusal-draft.png`, `phone-stop-confirm-long.png`, `phone-resume-password.png` (the resume password ceremony) and `phone-revision.png` (arrival at the receipt before typing). They remain byte-identical to the reviewed build. The resume ceremony's behaviour is asserted by the journey ("resume opens existing nonce and password form", "wrong password refuses resume") and by the inherited `serve` and `mate-doors` tests rather than by a sealed image.

**Focused checks run by the builder** (readable output, labelled as the builder journey log and not the machine gate log: [journey-output.txt](../evidence/chat-stop-resume-2026-09-15/journey-output.txt)):

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, exit 0. |
| `npx vitest run src/chat-task-actions.test.ts src/mate-doors.test.ts src/mate.test.ts src/task-control-console.test.ts src/task-control.test.ts src/chat-continuity.test.ts src/chat-polish.test.ts src/mobile-viewport.test.ts` | 8 files, 107 tests passed; its setup compiled this worktree's local runtime. |
| `npx vitest run src/serve.test.ts src/mate-doors.test.ts -t 'chat review|stop confirmation|same task: two revisions'` | 4 selected tests passed (317 excluded by the name filter, none changed or skipped in source). |
| `node scripts/chat-stop-resume-journey.mjs --capture` | 75 assertions passed at 1440×900 and 390×844; wrote the thirteen captures. |
| `node scripts/chat-stop-resume-journey.mjs` | 75 assertions passed again in the durable non-capturing mode the proof cites. |

The unchanged approved full verifier was **not** run by the builder; it runs once at the machine's final gate for this exact sealed candidate, and c4 stays pending-verification until then. Remaining gap from repair 1 stands: `scripts/workspace-result-proof.mjs` is outside the verifier and untouched.

Simplicity pass on the two new captures: the task page shows one status (Stopping…), one primary action (View stop details) and its details behind disclosures; the phone result shows one selected tab, the file list and the diff without a second explanation. Nothing was found to remove, so no copy changed.

Follow-up receipt: builder Claude Opus 5 (`claude-opus-5`), no subagents, zero live model calls, zero operator interventions or permission questions. Comment 335 recorded 2026-09-15T19:20:57Z; checks and captures ran from about 19:21Z to 19:26Z, roughly 5 minutes, with the handoff written after. One builder correction: the first phone result capture scrolled the diff into view but left the Changes tab above the fold; the capture now anchors on the tab strip and asserts the tab and diff share the viewport. No commit, push, branch switch, installed-database migration, rebuild of the installed root, or provider/permission change.
