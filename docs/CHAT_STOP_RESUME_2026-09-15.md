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
