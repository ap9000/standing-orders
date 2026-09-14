# Package 5 pilot 2 — one task status

Chat, Work and task details now read the same display projection. One current status and next action lead; the result receipt takes over when a result exists. All changes remain uncommitted on `standing-orders/show-one-clear-task-status`.

## Before and after

| Before | After |
| --- | --- |
| Task headers and navigation showed raw queued/finished badges beside a different dispatch status. | Headers use Work's dispatch/control/result projection; navigation carries identity without a competing state badge. Approval says **Needs your approval** and **Review plan**. |
| A journey, status box, review panel and receipt repeated Reviewing. | One receipt leads. Recorded checks and retry controls live in Task options; review history is stated once. Stop remains reachable. |
| A live review appeared as never finished in the attempt list and last-attempt row. | Both read the existing review/control liveness facts. A live reviewer reads running; an orphaned reviewer still reads unfinished. |
| Current task controls competed with an older result after a rescope. | The current projection leads; the earlier receipt remains under Previous result, with its own evidence status. No approval is copied. |
| Refresh could replace a focused control or a draft in the status region. | Refresh defers while a control is focused, a disclosure is open or an input is dirty, including when a response is already in flight. The composer is untouched. |
| The operator reported a 486px document at 390px: the allowed-files paragraph was 277px wide and scrolled to 435px. | The full reported path wraps with `overflow-wrap: anywhere` on `#scope .scope-paths`. In this synthetic fixture, the paragraph is 288/288px at 390px and 394/394px at desktop; documents are exactly 390px and 1440px wide. |

The fixture uses the exact reported allowed path, `docs/assessments/WORKSPACE_5_LONG_REQUEST_RESULT_2026-09-14.md`, in both the request and result scope. These measurements are of synthetic data, not a claim about the live task after installation. No path is hidden, truncated or shortened.

The simplicity pass also removed the approval form's misleading “ready to run” caption, moved the result above secondary Stop/agent details, and gave each primary action a 44px target. Failed-check and missing/damaged-evidence wording stays visible; full signed terms, risks, password confirmation, exceptions and preserved work remain accessible.

## Actual checks

- `npm run typecheck` — passed.
- `GIT_CEILING_DIRECTORIES="$PWD/output/tmp" TMPDIR="$PWD/output/tmp" npx vitest run src/serve.test.ts src/workspace-ui.test.ts src/task-control-console.test.ts` — 308 passed in three affected suites.
- `GIT_CEILING_DIRECTORIES="$PWD/output/tmp" TMPDIR="$PWD/output/tmp" node scripts/workspace-proof.mjs --status-only --strict --out output/playwright/workspace-5-status` — 188 passed, zero failed; eight viewport screenshots. The existing proof/fixture supplies this focused mode; no second browser suite ran.
- `node --check scripts/workspace-proof.mjs`, `node --check scripts/ui-polish-fixture.mjs` and `git diff --check` — passed.

The temporary directory is inside this worktree. The Git ceiling prevents disposable non-repository fixture directories from accidentally inheriting this worktree's Git repository. The affected test harness builds current `dist/` for its HTTP fixture; this is not the approved full verifier.

The regressions cover approval, ordinary queue/dependency waits, raw queued plus a live build claim, both agent-running and verifying-proof phases, stopping/settled pause, hold, stale approval after rescope, a previous result after rescope, failed tasks, failed checks, missing proof, live/orphaned review history, and focus/draft preservation. Existing stop authorization and confirmation tests remain intact.

Each browser viewport follows one result journey: open the result, inspect Changes and Checks, preserve and reload a feedback draft, save one note, create an unapproved linked revision, and return to the preserved chat draft. Thirteen synthetic status cases, long titles, full allowed paths, expanded approval and empty Work are also checked. Keyboard actions reveal the actual hold, resume and connection controls. Initial browser inspection caught links aimed at closed disclosures; the repaired links target their controls and pass at both widths.

## Screenshot inspection

All eight final PNGs in [the evidence directory](../../output/playwright/workspace-5-status/) were inspected: desktop and phone versions of `status-failure`, `status-reviewing`, `status-long-path` and `status-approval`. [report.json](../../output/playwright/workspace-5-status/report.json) records every assertion and measured geometry. These are real Chromium viewport captures of a synthetic fixture at 1440×900 and 390×844, not generated UI mockups or physical-phone acceptance. The gradient inside a receipt is the fixture's labeled evidence image, not a screenshot of a real model deliverable.

The screenshots show wrapping without document overflow, readable status/error text, one clear primary action and unbroken short button labels. Full approval text uses ordinary vertical scrolling. Native disclosures retain keyboard access and the existing motion policy is unchanged.

## Candidate and handoff

HEAD remains `cab3e6a59819649a2207c2401717e81d668d8da6`. The implementation/test/script fingerprint is `9d5a3be6ecaa82961407de1f3f55ae73cc58af84d9296011a2416e8ebbfb7f56`: SHA-256 of compact JSON containing sorted `{path, sha256}` entries for the six changed files under `src/` and `scripts/`. This assessment and protocol/evidence files are excluded to avoid self-reference. The native machine must bind its final gate to its own candidate.

The lease names runner `workspace5-pilot-20260914`, group `0774c645-ad9a-4d83-9efb-eca6506656c5`. The native ledger owns task/run IDs and actual provider/model/auth stamps; no route or approval settings changed. No subagents, new timeouts, schema/state-machine changes, commits, pushes, signing, publication or deployment occurred.

The signed `agree`, `one-action` and `fit` proof entries await the native final repository gate; the builder did not run the unchanged approved full verifier. Root still owns actual-result inspection and native Opus review. The steering request to inspect the real task was attempted through read-only computer discovery, which reported that the Mac was locked and exposed no browser surfaces. The live task has therefore **not** been re-inspected by this builder; root must check its full allowed path on the native candidate. Independent review, physical-phone/Safari acceptance and a real model revision result are not claimed.
