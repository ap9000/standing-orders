# Same task revisions — build #1588 feedback

Applied comment **246**: reviewer file locations and hashes now wrap in Checks, and the broken-history warning says **task**. All changes are uncommitted.

## Candidate and scope

- Branch: `standing-orders/revise-revise-same-task-revisions-20260914-from-3-annota`.
- Unchanged HEAD: `70e6d2fba456c1291026e34827d52fdfaebe8e2f` (reviewed build #1588). Original implementation base: `4755b21af6bf3fa4c76c95697c65f9bc3c283364`.
- Source/test/fixture diff SHA-256: `23134ecb2384053d0264d129c88f76d83b8d8c9beb710f5144d93fa5437b78fa`, from `git diff --binary -- src/serve.ts src/store.ts src/serve.test.ts scripts/ui-polish-fixture.mjs scripts/workspace-result-proof.mjs | shasum -a 256`. Excludes this assessment and protocol files.
- Build #1586 feedback fixes (212, 213, 216) are inherited in HEAD: truthful family counts, bounded family queries and retained broken-lineage results. This repair leaves that behavior intact and reruns its focused regressions.

## Small presentation repair

| Before | After |
| --- | --- |
| Reviewer locations in Checks did not inherit feedback wrapping. | One rule, `.result-section[data-cockpit-source="reviewer"] li { overflow-wrap: anywhere; }`, wraps the complete location, note and hash across shared result surfaces. Diff styles are unchanged. |
| “This execution is shown separately.” | “This task is shown separately.” The warning still names unavailable or incomplete history. |
| The fixture checked inherited feedback but missed reviewer locations in Checks. | It now includes `docs/assessments/WORKSPACE_5_NAMES_RESULT_2026-09-14.md:28` and a labelled synthetic 64-character hash in an informational reviewer note. The existing journey checks all text bounds, clipping, page width, action size and unchanged diff whitespace. |

The pre-fix phone run reproduced three failures: chat/Review grew to 544px and the run page to 560px with the exact reported path plus the added hash. After the repair all three document widths are 390px. Reviewer rows fit their available widths (338px in chat/Review, 306px on the run page), with exact text retained and no clipping. Desktop pages remain 1400px wide.

## Signed criteria

### identity

One root task card, canonical task/chat identity and shared conversation persist through two successive revisions. Work counts and state reflect current execution, history exposes exact prior versions, and legacy siblings or broken lineage are not silently hidden

The selected store/server/mate regressions and both browser journeys preserve one root card, navigation and conversation through two revisions. They check current live/approval/failure counts, exact History versions, bounded family reads, legacy siblings and broken lineage.

Worker checks complete; pending the native final repository gate.

### safety

Grouping and history obey visibility before pagination, unrelated or hidden version access is refused, and canonical navigation never retargets stale mutation, approval, feedback or run-control actions. Existing evidence lineage and fresh approval remain authoritative

Existing regressions still enforce visibility before grouping/pagination, refuse unrelated/hidden versions and stale approval/run-control targets, and preserve exact feedback targets, source artifacts and fresh approval. This repair changes one CSS rule and warning wording; no action routing changed.

Worker checks complete; pending the native final repository gate.

### feedback

Plain user feedback and reviewer problems create exactly one intended revision batch with safe retry and later-batch behavior. Informational reviewer notes/questions remain available without generating default revision work

The added reviewer location/hash remains informational: it stays visible and never enters the default revision batch. Existing tests and both journeys cover user feedback, reviewer problems, explicit question-to-draft selection, two exact batches, lost-response replay and later feedback.

Worker checks complete; pending the native final repository gate.

### experience

Desktop 1400x900 and phone 390x844 journeys cover result, diff annotation, two revisions, history, draft recovery and failure. Long feedback paths/hashes wrap, actions stay usable, and UI is concise without hiding evidence or approval terms

Both complete synthetic journeys pass at 1400x900 and 390x844: result, Changes/annotation, two revisions and approvals, History, draft reload/Back, hold/failure/retry, damaged evidence and an empty project. New checks measure exact reviewer text and controls on chat, run and Review pages. Diff code retains preformatted whitespace and its own horizontal scroll.

Worker checks complete; pending the native final repository gate.

## Checks actually run

| Command | Result |
| --- | --- |
| `npm run build` | Passed; built the runtime for the pre-fix reproduction. |
| `npm run typecheck && npx vitest run src/store.test.ts src/serve.test.ts src/result-review.test.ts src/mate.test.ts src/workspace-ui.test.ts src/revision-terms.test.ts -t 'same task|revision|reviewer observation|pilot 2: approval'` | Passed: typecheck and 47 selected tests across five suites. The filter left 442 tests unselected; workspace-ui had no matching test. No tests were disabled or removed. Existing Vitest setup rebuilt the repaired source. |
| `PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --same-task-revisions --phone-only --strict --out output/playwright/same-task-review-wrap-before` | Pre-fix reproduction: exit 1, 61 passed and three reviewer-wrapping failures. All three are resolved by the final run below. |
| `PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --same-task-revisions --strict --out output/playwright/same-task-review-wrap` | Passed: 129 checks, zero failures, one complete journey at each required viewport. |
| `git diff --check` | Passed. |

The source/test/fixture digest above is the candidate covered by the passing tests and browser run. No full repository verifier was run by this worker. Protocol preflight uses the signed rubric and checks the submission separately; it does not replace the native gate.

## Visual inspection and simplicity

Inspected all 14 final viewport captures: result, Checks, approval, live state, failure, History and broken Review at both sizes. Also inspected the pre-fix phone Checks capture. The repaired text wraps inside the page, the short Request change controls remain usable, and the warning explains the task state without adding instructions. History remains keyboard reachable with visible focus. Exact approval terms and the recovered phone draft remain readable while scrolling. No new controls or explanatory paragraphs were added to the product.

Selected evidence:

- [Desktop Checks](../../output/playwright/same-task-review-wrap/desktop-same-task-checks.png) and [phone Checks](../../output/playwright/same-task-review-wrap/phone-same-task-checks.png).
- [Desktop History](../../output/playwright/same-task-review-wrap/desktop-same-task-history.png) and [phone History with recovered draft](../../output/playwright/same-task-review-wrap/phone-same-task-history.png).
- [Desktop history warning](../../output/playwright/same-task-review-wrap/desktop-same-task-review.png) and [phone history warning](../../output/playwright/same-task-review-wrap/phone-same-task-review.png).
- [Phone approval terms](../../output/playwright/same-task-review-wrap/phone-same-task-approval.png) and [phone failed revision](../../output/playwright/same-task-review-wrap/phone-same-task-failure.png).
- [Final browser report](../../output/playwright/same-task-review-wrap/report.json) and [pre-fix reproduction](../../output/playwright/same-task-review-wrap-before/report.json).

## Provenance and remaining owner checks

The fixture is synthetic: in-memory records, fixture repositories, sealed example artifacts and a scripted chat response. It exercises real HTTP forms, approvals, exact-batch seals, session drafts and state transitions, while supplying completed build artifacts. It makes no model calls. The screenshots show browser viewports, not physical phones; native keyboards/IME and other browser engines remain untested.

The operator/root retains actual-result inspection, native Opus review and live follow-up tests as assigned in the plan. This worker does not claim those steps or two model-built revisions. The machine owns the unchanged approved full verifier for its final candidate. No known worker repair or required viewport check remains unfinished.

No scheduler, schema, provider, dependency, permission, approval, evidence/reviewer engine or historical-record changes. No subagents, extra model calls, new time limits, commit, merge, push or deployment.

## Changed paths

- `src/serve.ts`
- `src/store.ts`
- `src/serve.test.ts`
- `scripts/ui-polish-fixture.mjs`
- `scripts/workspace-result-proof.mjs`
- `docs/assessments/SAME_TASK_REVISIONS_RESULT_2026-09-14.md`
