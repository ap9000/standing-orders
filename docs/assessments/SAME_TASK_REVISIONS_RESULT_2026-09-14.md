# Same task revisions — review comments on build #1586

Applied comments **212, 213 and 216** to the previously reviewed implementation. One root task still owns successive versions, exact results and the shared conversation. All changes remain uncommitted.

## Candidate

- Required branch: `standing-orders/revise-same-task-revisions-20260914-from-3-annotations-o`.
- Unchanged HEAD: `657b58bb63dc0c8557bec745e3c427a7c1331422` (the reviewed build). The original implementation base was `4755b21af6bf3fa4c76c95697c65f9bc3c283364`.
- SHA-256 of `git diff --binary --` over the seven source/test/script paths below: `e368af1120315d2dec2c63790b0b728c071a398c38ce2a83b4881903d0855ed4`.
- The digest excludes this assessment and protocol files. The native gate owns the eventual sealed candidate and the unchanged approved full verifier.

## Review findings addressed

| Comment | Change | Evidence |
| --- | --- | --- |
| 212: task chat says Running while Projects/header count it as queued | Project counts enrich only possible live work through the existing Work/dispatch/run projection, then count families in SQL. Final checks, current claims without a run, live independent reviews and older active siblings count once. Work's Running filter includes a family with an older live version while retaining the newest version's state and History notice. Task state and scheduling are unchanged. | Queued-row/native-claim tests during `agent-running` and `verifying-proof`; older sibling, released/expired/superseded claim and reviewer-heartbeat assertions. Both browser journeys inspect actual header and Projects HTML. |
| 213: opening one task performs fleet-wide lookups | A task uses permission-aware ancestor point reads (the existing 64-task ancestry bound), followed by its own descendant query. Lists select roots and current state in SQL before their page limit, then hydrate every version of those selected families. Work, navigation, Review, palette and mate/fleet chat supply their own limits. Project counts remain SQL aggregates. | With 1,200 unrelated tasks and orphaned build rows, opening a two-version family performs two point reads, one query returning two versions, and zero `lookupRef` calls. A three-family page returns three task rows; fleet chat hydrates 61 for its 60-card page and overflow probe. Orphaned unclaimed builds return no activity candidates. |
| 216: broken-lineage completions disappear from Review | Review retains an admitted exact result with “History unavailable” in the queue and a safe history warning in the result. Done tasks without a build remain visible too. Scope, evidence and mutation targets stay attached to the requested execution/run. | Server tests cover missing and cross-project ancestry, no-build completions, hidden-result refusal and exact comment targets. Desktop and phone captures show the broken-history warning alongside the preserved result. |

Grouping inspects admitted lineage metadata inside SQLite; full task rows leave the database only for the selected family/page or possible live work. There is no raw-row cutoff on versions. A 207-version family retains all siblings on a one-family page. Point and list reads agree on missing, circular, foreign, borrowed-source and over-depth lineage; a depth-65 version is shown separately while all 64 valid ancestors remain available.

No schema, scheduler, provider, dependency, approval, automatic-mode, evidence/reviewer engine or historical-record changes. No subagents, extra model calls, new time limits, commit, merge, push, publication or deployment.

## Signed criteria

### identity

One root task card, canonical task/chat identity and shared conversation persist through two successive revisions. Work counts and state reflect current execution, history exposes exact prior versions, and legacy siblings or broken lineage are not silently hidden

The current store/server regressions and both browser journeys pass. They retain one root Work card and conversation across two revisions, preserve exact History links and show actual current state. New regressions cover family query bounds, old active siblings and the native queued-row count mismatch. See the desktop History and phone live-count captures.

Worker checks are complete; the protocol marks this pending-verification for the native final repository gate.

### safety

Grouping and history obey visibility before pagination, unrelated or hidden version access is refused, and canonical navigation never retargets stale mutation, approval, feedback or run-control actions. Existing evidence lineage and fresh approval remain authoritative

The existing two-revision server regression still refuses unrelated/hidden versions, mismatched approval nonces and stale run-control targets. Exact old seal receipts, later notes, fresh per-version approval and immutable original artifacts pass. Added tests prove permission-aware point/list parity and retained exact Review targets despite broken ancestry. No POST routing was changed.

Worker checks are complete; the protocol marks this pending-verification for the native final repository gate.

### feedback

Plain user feedback and reviewer problems create exactly one intended revision batch with safe retry and later-batch behavior. Informational reviewer notes/questions remain available without generating default revision work

The affected server, result-review, mate and revision-terms suites pass. Browser journeys submit ordinary feedback plus a line annotation, retry lost note/seal responses, create two successive revisions and retain later feedback on the original. Reviewer notes/questions remain available without a default Revise batch; deliberately selecting a question only creates a draft. The existing exact-batch seal remains authoritative.

Worker checks are complete; the protocol marks this pending-verification for the native final repository gate.

### experience

Desktop 1400x900 and phone 390x844 journeys cover result, diff annotation, two revisions, history, draft recovery and failure. Long feedback paths/hashes wrap, actions stay usable, and UI is concise without hiding evidence or approval terms

Both required viewport journeys passed 110 checks. After inspection found a clipped phone header count, the affected 390x844 journey passed 56 checks with an added text-bounds assertion. It covers result, diff annotation, two approvals/revisions, exact History, Back/reload drafts, held/failed/retried work, long paths/hashes, damaged evidence, an empty project and broken-lineage Review. The root agent inspected every capture, including the six refreshed phone captures.

Worker checks are complete; the protocol marks this pending-verification for the native final repository gate.

## Checks actually run

| Command | Result and coverage |
| --- | --- |
| `npm run typecheck` | Passed after implementation repairs; also rerun in both final composite commands below. |
| `npx vitest run src/store.test.ts -t 'same task revision identity'` | 2 selected regressions passed during implementation. |
| `npx vitest run src/serve.test.ts -t 'same task:|pilot 2: approval'` | 3 selected regressions passed during implementation. |
| `npx vitest run src/store.test.ts src/serve.test.ts src/workspace-ui.test.ts src/result-review.test.ts src/mate.test.ts src/revision-terms.test.ts` | 488 passed across the six affected files. This was a focused implementation run, not the repository's full suite. |
| `npm run typecheck && npx vitest run src/store.test.ts src/serve.test.ts` | Passed; 416 tests, including older active siblings, claim expiry/generation, live/dead reviewers and broken Review. Refreshed after final server/CSS changes. |
| `npm run typecheck && npx vitest run src/store.test.ts src/serve.test.ts -t 'same task|pilot 2: approval'` | Final source check: 6 selected tests passed after excluding orphaned unclaimed build rows from activity candidates. The other 410 were unselected by this command; no tests were disabled or removed. |
| `PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --same-task-revisions --strict --out output/playwright/same-task-revisions` | 110 passed, zero failed, at 1400x900 and 390x844. Desktop evidence remains valid after the subsequent phone-only CSS repair. |
| `PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --same-task-revisions --phone-only --strict --out output/playwright/same-task-revisions-phone-refresh` | 56 passed, zero failed; refreshed phone journey after count wrapping, including a text-bounds assertion for every header count. |
| `git diff --check` | Passed. |

Vitest's existing setup rebuilt the source. The final focused rerun covers the last store-only candidate filter change; the previous server/UI/browser evidence remains valid because that change only avoids enriching unowned stale builds that already projected as non-live. The existing approval, feedback, mate and revision-terms evidence from this session is reused. No approved full verifier was run by this worker.

The first browser attempt stopped at the new count assertion because its session still selected All projects. The fixture now explicitly selects its main project before inspecting a project header. That setup failure is resolved in the passing runs above. Visual inspection then found the clipped “queued” label and prompted the phone-only CSS repair and rerun.

## Simplicity and visual inspection

| Before | After |
| --- | --- |
| Projects/header disagree with a live task's status. | Counts and the current task read live throughout build and final checks, without rewriting the queued task row. |
| Broken history makes the result vanish from Review. | A short queue warning and the preserved exact result explain the problem; Open task and evidence/approval terms remain available. |
| Phone header clips the end of “queued”. | Count labels wrap as complete items inside the project pill. The new text-bounds check and refreshed capture confirm all three labels are readable. |
| Long inherited feedback can dominate a narrow page. | Existing wrapping retains the complete path, hash and exact approval terms; Revise and History stay concise, keyboard reachable and usable. |

Inspected 1400x900 desktop and 390x844 phone captures for result, approval, live work, failure, History and broken Review. Checked alignment, readable text, horizontal overflow, focus, 44px short controls, fixed composer/footer behavior and reduced motion. The phone composer retains its draft while scrolling long approval content. No evidence or consent terms were removed.

## Evidence and provenance

The fixture is synthetic: in-memory records, temporary repositories, sealed example artifacts and a scripted chat response. It exercises real HTTP forms, session drafts, exact-batch seals, approvals and claim/state records, but supplies its own build results. The sample screenshot is explicitly labelled a fixture image. These are browser viewports, not physical iOS/Android hardware.

Selected protocol captures:

- [Desktop History](../../output/playwright/same-task-revisions/desktop-same-task-history.png)
- [Phone live counts](../../output/playwright/same-task-revisions-phone-refresh/phone-same-task-live.png)
- [Desktop result](../../output/playwright/same-task-revisions/desktop-same-task-result.png)
- [Phone approval and long feedback](../../output/playwright/same-task-revisions-phone-refresh/phone-same-task-approval.png)
- [Desktop live counts](../../output/playwright/same-task-revisions/desktop-same-task-live.png)
- [Desktop broken Review](../../output/playwright/same-task-revisions/desktop-same-task-review.png)
- [Phone History and recovered draft](../../output/playwright/same-task-revisions-phone-refresh/phone-same-task-history.png)
- [Phone broken Review](../../output/playwright/same-task-revisions-phone-refresh/phone-same-task-review.png)

The [two-viewport report](../../output/playwright/same-task-revisions/report.json) and [phone refresh report](../../output/playwright/same-task-revisions-phone-refresh/report.json) include all checks and the additional result/failure captures inspected in this session.

## Owner steps and limits

The operator/root still owns actual-result inspection, native Opus review and live follow-up tests as assigned in the plan. This unattended worker made no model calls and does not claim two model-built revisions or completion of those owner steps. The native final gate must run the unchanged approved full verifier for the sealed candidate.

Native mobile keyboards/IME and other browser engines were not tested. The separate workspace-chat-proof script and unrelated result-proof modes were not rerun; the agreed two-viewport journey covered this revision. No known worker implementation or required viewport check remains unfinished.

## Changed source paths

- `scripts/ui-polish-fixture.mjs`
- `scripts/workspace-result-proof.mjs`
- `src/mate-tools.ts`
- `src/serve.test.ts`
- `src/serve.ts`
- `src/store.test.ts`
- `src/store.ts`
