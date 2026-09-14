# Package 5 pilot 2 — chat path wrap revision

The corrected chat path now wraps in sent messages and replies, including inline code. The production change is one `overflow-wrap: anywhere` declaration on `.thread .msg`. No message is shortened, hidden or truncated.

This applies notes 138–139 under the final triage in note 155. The inherited dispatch/control/result presentation, sidebar repair, approvals and other reviewed behavior remain unchanged. The scope/recovery links, result-link behavior and disclosure-refresh trade-off stay as triaged; this revision adds no state rules or chat transport changes.

| Before | After |
| --- | --- |
| The operator reported a 278px message paragraph scrolling to 402px and a 469px document at 390×844, containing `docs/assessments/WORKSPACE_5_REAL_WORK_PILOT_2026-09-14.md`. | The existing fixture sends that exact path through both message roles, as plain text and inline code. At 390px, the sent paragraph is 288/288px and both reply paragraphs are 313/313px; the document is exactly 390px. |
| The exploratory run against the inherited CSS reproduced a 472px phone document after the path reply. That run stopped at a pointer-intercepted conversation control; it was not a passing proof. | The final focused proof passes every check, including real pointer interactions, message geometry, draft recovery and revision creation at both widths. Desktop paragraphs are 606/606px and 705/705px, with a 1440px document. |
| The allowed-files regression used the separate `WORKSPACE_5_LONG_REQUEST_RESULT_2026-09-14.md` path. | That case still passes unchanged; it is not substituted for the corrected chat-message case. |

Simplicity inspection: the repair adds no copy, controls or steps. The full path remains readable, the short actions stay on one line with 44px targets, and the chat draft clears the phone tab bar. One status/action still leads each tested view. Stop remains reachable by scrolling on the phone; it is not claimed visible on first paint. The expanded approval screenshots show the declared risk and its consequences before consent. Exact terms and the password field remain available.

## Actual checks on this candidate

- `npm run typecheck` — passed.
- `GIT_CEILING_DIRECTORIES="$PWD/output/tmp" TMPDIR="$PWD/output/tmp" npx vitest run src/serve.test.ts src/workspace-ui.test.ts src/task-control-console.test.ts` — 308 tests passed in three affected suites.
- `GIT_CEILING_DIRECTORIES="$PWD/output/tmp" TMPDIR="$PWD/output/tmp" node scripts/workspace-proof.mjs --status-only --strict --out output/playwright/workspace-5-status` — 196 checks passed, zero failed, ten screenshots.
- `node --check scripts/workspace-proof.mjs`, `node --check scripts/ui-polish-fixture.mjs` and `git diff --check` — passed.

The existing chat-rendering test now checks the corrected path in operator text, plain replies and inline code, retaining its escaping assertions. The unchanged state regressions cover approval, dependency/queue waits, live build/check phases, stopping/stopped, hold, stale approval after rescope, previous results, failures, missing evidence and live/orphaned review history. Focused browser checks compare Work with Chat and task details across thirteen synthetic status cases, plus long content, expanded approval and empty Work.

Each viewport follows one result journey: receive the path reply while keeping the composer node, draft, focus and selection; reload without losing the draft; open the result; inspect Changes and Checks; reload a feedback draft; save one note; create an unapproved linked revision; return to the preserved chat draft. The existing fixture and proof were extended; no second browser suite or new timeout was added. Disposable fixtures stay under this worktree's `output/tmp`; the Git ceiling prevents fixture directories from inheriting this checkout.

All ten final PNGs in [the evidence directory](../../output/playwright/workspace-5-status/) were visually inspected, including desktop/phone `status-chat-path`, `status-failure`, `status-reviewing`, `status-approval` and `status-long-path`. [report.json](../../output/playwright/workspace-5-status/report.json) records assertions and geometry. These are real Chromium captures at 1440×900 and 390×844 of explicitly synthetic cases. The gradient inside result receipts is a labeled fixture image, not a model deliverable.

## Candidate and remaining native work

HEAD remains `673a004279abe920c2da3f1141eb1ce4fbe992c4`; all changes are uncommitted on the assigned revision branch. The implementation/test/script fingerprint is `ad8840ca096acd076a7b2978a029fa8cd4b06d05451752b0aec050cec7a63f02`: SHA-256 of compact JSON containing sorted `{path, sha256}` entries for the four changed files under `src/` and `scripts/`. This assessment and evidence/protocol files are excluded to avoid self-reference.

The native machine owns the unchanged approved full verifier for this candidate; it was not run by this revision builder. The affected-test harness rebuilt current `dist/` for its fixtures. The prior build's captured full verification is historical evidence only and does not certify this revision. The signed proof entries await the final repository gate.

Root retains actual-result inspection and native Opus review. This builder did not inspect the installed live task or complete independent review, physical-phone/Safari acceptance, or a real model revision result. No original approval was changed or copied; the fixture revision requires fresh approval. No subagents, new timeouts, unrelated cleanup, commits to this worktree, pushes, publication or deployment occurred.
