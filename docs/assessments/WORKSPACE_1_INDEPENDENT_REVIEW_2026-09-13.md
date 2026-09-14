# Workspace package 1 — independent review

Review of build 1544, based on `43c102b0736ab3a06a2db871000dd4f8525245b8`. The builder's 2,801-test final suite and 141/141 + 75/75 browser reports passed. They do not cover all of these independently observed cases. No live tasks or permissions were changed by the synthetic checks.

## Required focused correction

1. **Admit before limiting the Work query.** The independent script `output/playwright/workspace-boundary-review.mjs` returns 200 rows without a bound notice after seeding 201 tasks in a selected project. It then returns zero admitted rows after 501 newer tasks are added to an excluded project. A further account-visibility case seeds 201 newer unplaced tasks: a project-restricted member's assigned tasks disappear, because the existing project-bound query includes unplaced rows that the account cannot see. The tasks are not lost, but Work makes a false empty claim. Use the same admitted, bounded query for rows and navigation counts, with an explicit overflow probe and honest counts/empty states. Keep original visibility constraints. Add permanent regressions; do not modify the store schema or scheduler.
2. **Remove unsupported negative status claims.** An accepted exception does not establish that machine checks failed or did not pass. A generic refutation does not prove that no check failed. Missing/stale publication observations cannot prove nothing merged or deployed, and the product already supports authorized automatic merge. Describe what was recorded or last observed and what remains unconfirmed. Preserve the distinct verified, attested, missing, refuted, accepted, PR and merge states.
3. **Make visibility proof real and finish narrow-phone fit.** `workspace-proof.mjs` reports Add project visible for a zero-width/zero-height rectangle. Assert positive size, computed visibility, and full viewport bounds for the actual CTA. Its 320px screenshot clips Completed in a scrollbar-hidden filter strip. Keep all four filters discoverable and legible at 320px, maintain usable targets, and assert each filter's bounds rather than merely the container/document bounds. Keep the compact desktop design; do not start package 2.
4. **Keep an in-progress independent review consistent across result surfaces.** The builder's result document explicitly notes that Work and the chat headline can show a pending/in-flight review while the receipt still shows the prior stored verdict. The approved package asks for one truthful projection for the same run across Work, task/chat/Details, receipt and review. Carry the existing review facts into presentation (no lifecycle changes), retain the prior evidence as secondary historical detail, and add pending/running/failed-review fixtures. Preserve selected older results and reviewer lineage.

## Findings already resolved or not reproduced

- The earlier no-change branch hiding refuted/short verdicts was fixed by the builder before final submission.
- Work's attention badge now agrees with the Needs-you tab in the final ordinary fixture.
- A synthetic account assigned to two projects can open Work and an admitted run without a manual project selection (both HTTP 200). No restricted-account defect is asserted from the earlier source suspicion.
- Long project labels wrap/truncate within the viewport; do not replace that working behavior.

## Evidence and review gate

- Root boundary script: two failing listing tests and one passing restricted-account check, repeated against the final implementation before sealing.
- Builder screenshots: `output/playwright/workspace-1/after/phone-work-all.png`, `desktop-work-all.png`, `narrow-work-320.png` in build 1544's worktree. Exact viewports, synthetic data.
- Four actual annotations were recorded on build 1544 (92–95). The normal Create revision action refused HTTP 409 `bad-goal`: the source's approved goal is 2,326 characters, but `createConsoleTask` caps goals at 2,000, before even appending the revision suffix. No task was created and the annotation batch remains intact. This is an existing filing-path limit mismatch, not a reason to rewrite the source approval or weaken custody checks.
- Safe continuation: ordinary task `workspace-1-review-fixes-20260913`, explicitly dependent on the source task and seeded from its sealed head `66a81a458e8607105735aa9e478edb2f0a44dae2`. It is a linked follow-up, **not** a native annotated revision. Exact scope `81b80771d87c17a035e05fff45a76bda` names these findings, the source annotations, and the reproduction. It uses normal approval and the existing Opus subscription route. The filer mismatch is recorded for a separate core fix outside this UI package's no-store-change scope.
- Require focused regressions, the unchanged typecheck/serial-suite/build command, both browser scripts, and independent rechecks before integration. No acceptance override. Build 1544's own machine verifier passed at 23:29:28 UTC; independent review findings remain valid despite that green result.
- This review authorizes no new product phase, global setting, installation change, push or deployment.
