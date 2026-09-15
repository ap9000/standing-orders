# Same task revisions — result assessment

Implemented one root task identity across successive feedback revisions. Existing execution records, revision links and exact-batch seals remain authoritative. Changes are uncommitted in the required worktree.

## Candidate

- Branch: `standing-orders/same-task-revisions-20260914`.
- Unchanged base/HEAD: `4755b21af6bf3fa4c76c95697c65f9bc3c283364`.
- SHA-256 of `git diff --binary --` for the source/test/script paths listed below: `347b1d17cff448fce409785289db45fefaf85a1c3675143c53d009a77e037773`.
- Assessment and protocol files are excluded from that source diff digest. The native gate owns the eventual sealed candidate and approved full verification command.

## Behavior and boundaries

- [Store projection](../../src/store.ts) admits projects before grouping or pagination. The root keeps its identity; the newest filed execution supplies current state. Timestamp ties use the execution ref ID. All exact versions remain in History; other queued/running siblings are called out. Missing, circular, cross-project and borrowed-source lineage remain separate with a truthful explanation that does not reveal hidden ancestors.
- [Server/UI](../../src/serve.ts) uses the root for Work, task navigation, focused/fleet chat, project counts and conversation drafts. History opens exact prior executions and run records. Root navigation reflects approval, actual Revising activity, hold, failure and completion from the current execution. Older child links and old seal receipts resolve to the version they named.
- POST paths, run IDs, source digests, batch IDs, approval nonces and scopes retain their exact targets. Root navigation does not rewrite mutations. Unrelated and hidden versions/results are refused. Source artifacts and consumed feedback are preserved; earlier feedback is available in a disclosure.
- [Feedback classification](../../src/result-review.ts) includes plain user feedback and reviewer problems in the requested batch. Reviewer notes/questions remain readable without a default revision CTA. An explicit Request change copies a note into a user draft; replacing an existing draft requires confirmation.
- [Mate tools](../../src/mate-tools.ts) expose root and current execution separately. The conversation context stays stable across revisions, and prior proposals keep their exact targets. Project/state filtering occurs before list limits. The palette retains the intersection of selected and admitted projects.
- No schema, scheduler, evidence/reviewer engine, approval policy, automatic-mode rule, provider, dependency, global configuration or verification-command changes. No subagents, extra model calls, new time limits, commit, push, merge or publication.

## Signed criteria

### identity

One root task card, canonical task/chat identity and shared conversation persist through two successive revisions. Work counts and state reflect current execution, history exposes exact prior versions, and legacy siblings or broken lineage are not silently hidden

Checked with the store family regression (205 legacy siblings plus a revision of a revision), the server two-revision flow, mate identity checks and both browser journeys. One root Work card, shared session/draft, current state and exact history pass. Hidden/broken lineage stays visible only within its admitted scope. See the desktop and phone History captures.

Worker verification is complete for this criterion; the proof marks it pending-verification for the native final repository gate.

### safety

Grouping and history obey visibility before pagination, unrelated or hidden version access is refused, and canonical navigation never retargets stale mutation, approval, feedback or run-control actions. Existing evidence lineage and fresh approval remain authoritative

Checked hidden, unrelated, missing, cyclic and borrowed-source lineage; admission before grouping and limits; exact historical forms; old seal receipts; mismatched approval nonce and stop-run targets; fresh approval per revision; immutable source evidence. A reproduced palette admission regression was fixed and its regression now passes.

Worker verification is complete for this criterion; the proof marks it pending-verification for the native final repository gate.

### feedback

Plain user feedback and reviewer problems create exactly one intended revision batch with safe retry and later-batch behavior. Informational reviewer notes/questions remain available without generating default revision work

Checked plain feedback plus annotation, mixed reviewer problems, informational-only findings, forged informational batches, lost note/seal responses, second revisions and later batches. Existing source/batch sealing remains the boundary. Draft replacement confirmation is covered by the existing result-review test file.

Worker verification is complete for this criterion; the proof marks it pending-verification for the native final repository gate.

### experience

Desktop 1400x900 and phone 390x844 journeys cover result, diff annotation, two revisions, history, draft recovery and failure. Long feedback paths/hashes wrap, actions stay usable, and UI is concise without hiding evidence or approval terms

The existing synthetic browser proof passes 98 checks across 1400x900 and 390x844. It covers result, annotation, two revisions, History, Back/reload drafts, hold/failure/recovery, damaged screenshot, empty project, long paths/hashes, keyboard activation and usable buttons. All eight resulting viewport captures were visually inspected; the final keyboard run preserves these layouts.

Worker verification is complete for this criterion; the proof marks it pending-verification for the native final repository gate.

## Checks actually run

| Command | Result and candidate coverage |
| --- | --- |
| `npm run typecheck` | Passed after the final source repair. |
| `npx vitest run src/store.test.ts src/serve.test.ts src/workspace-ui.test.ts src/result-review.test.ts src/mate.test.ts src/revision-terms.test.ts` | 486 passed in six affected files. This was the broad focused implementation run, not the full repository suite. |
| `npx vitest run src/serve.test.ts` | 303 passed after the final server repair, including old seal receipts and retained historical result links. |
| `npx vitest run src/store.test.ts` | 110 passed after the final palette admission repair. |
| `npx vitest run src/mate.test.ts` | 35 passed after the selected-project-before-limit repair. |
| `npx vitest run src/serve.test.ts -t 'palette'` | Three selected tests passed after the palette repair; the other 300 were unselected by this focused command, not changed or disabled. |
| `npm run build` | Passed during implementation; the final store/server test setup also rebuilt the source successfully. |
| `PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --same-task-revisions --strict --out output/playwright/same-task-revisions` | Final run: 98 passed, zero failed. Same existing journey and fixture, both required viewports, reduced motion. |
| `git diff --check` | Passed. |

The final affected-file reruns refresh the changed store, server and mate behavior; evidence from the unchanged workspace UI, result-review and revision-terms tests is reused. The last browser run covers the final source and updated keyboard/target assertions. No approved full verifier was run by this worker.

A focused negative regression first reproduced the palette leak (selecting /hidden returned a hidden task despite admission limited to /visible). Intersecting selected/admitted projects fixed it; the full affected store file now passes. Earlier browser failures reproduced horizontal overflow from long changed-file paths/hashes and exposed the affected Add note interaction; those failures are resolved in the final passing journey.

## Simplicity and visual inspection

| Before | After / observed evidence |
| --- | --- |
| Revisions appear as separate task destinations and can leave the original looking complete. | One root identity with current execution state; a compact History disclosure names Original, Revision 1 and Revision 2, including the failed prior attempt. |
| Verbose Create revision controls and repeated revision instructions. | Revise with the batch count; exact inherited terms and fresh approval remain in the review. |
| Informational reviewer comments look like default revision work. | Notes/questions remain in Checks; only an explicit user action copies one into feedback. |
| Long changed-file path/hash expanded the 390px page to 551px. | Paths/hashes wrap within the viewport, with no horizontal overflow. Phone line annotation targets are at least 44 by 44px; Revise stays single-line and at least 44px high. |
| A later execution could be mistaken for the answer to an old seal receipt. | The old receipt opens its exact historical execution, with a link back to current work. |

The browser activates Changes, approval details and History by keyboard. It preserves the chat draft through both revisions, old links, Back and reload, and preserves per-run annotation drafts. Captures show readable contrast/alignment and a concise failure state with Review and retry. Scrolling exposes full approval content; no signed terms were removed. Motion checks use the existing reduced-motion path.

## Screenshots and fixture provenance

The result evidence, completion records and chat runner are explicitly synthetic. The fixture drives real HTTP forms, exact-batch seals, approval and claim/state records; it supplies the build outcomes and stored example evidence without invoking a model. The displayed example result image is labelled as a fixture image, not a live application result.

- [desktop result](../../output/playwright/same-task-revisions/desktop-same-task-result.png)
- [desktop approval](../../output/playwright/same-task-revisions/desktop-same-task-approval.png)
- [desktop failure](../../output/playwright/same-task-revisions/desktop-same-task-failure.png)
- [desktop history](../../output/playwright/same-task-revisions/desktop-same-task-history.png)
- [phone result](../../output/playwright/same-task-revisions/phone-same-task-result.png)
- [phone approval](../../output/playwright/same-task-revisions/phone-same-task-approval.png)
- [phone failure](../../output/playwright/same-task-revisions/phone-same-task-failure.png)
- [phone history](../../output/playwright/same-task-revisions/phone-same-task-history.png)

The detailed generated report is [report.json](../../output/playwright/same-task-revisions/report.json). The eight captures are also named in the protocol proof for machine collection.

## Remaining owner steps and limits

Per the agreed plan, the parent/root still owns inspection of the actual result, native Opus review and live follow-up through the application. This worker did not invoke those models or claim two live model-built revisions. The native final gate must run the unchanged approved full command for its sealed candidate.

Phone evidence is a real Chrome browser at a 390x844 viewport, not physical iOS/Android hardware. Native mobile keyboards/IME and other browser engines were not tested. The older optional result-proof modes and workspace-chat-proof script were not rerun; the agreed two-viewport journey supplies this task's browser evidence. These are stated verification limits, not claims of future success.

## Changed source paths

- `scripts/ui-polish-fixture.mjs`
- `scripts/workspace-result-proof.mjs`
- `src/mate-tools.ts`
- `src/mate.test.ts`
- `src/mate.ts`
- `src/result-review.test.ts`
- `src/result-review.ts`
- `src/serve.test.ts`
- `src/serve.ts`
- `src/store.test.ts`
- `src/store.ts`
