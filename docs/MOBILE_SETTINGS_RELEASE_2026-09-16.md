# Finish the mobile Settings fix

The user requests merging the latest work to main, pushing it, and updating the
live app. The operator handles publication and deployment after this normal
native verification and independent review; this task prepares the candidate.

Start from the pinned input based on accepted deployed
cab3a944163935e63106969a6f245b637d1bac05. Apply the prepared patch with
`git cherry-pick --no-commit 729e7d1c228bd6aff20cc26b03131debb8584f4b` so the
native host owns the final commit. Inspect the two-file diff; correct only a
reproduced in-scope issue. Do not reset the task branch or change its original
base. Prior Telegram/provider work is already accepted and remains unchanged.

## Required result

- With All projects selected, the mobile hamburger opens Tools and settings
  rather than redirecting to Projects. Its Settings row opens `/settings`.
- Project-bound pages still require a selected project; authentication,
  project admission and role-specific menu destinations remain unchanged.
  Selecting a project and returning to All projects must both keep the menu
  available. The new regression failed with 303 before the patch and passes
  afterward; keep it in the existing serve suite.
- Keep the existing accessible links and concise menu. The patch removes the
  redundant subtitle that also incorrectly described desktop navigation as
  tabs below. No new controls, dependencies, schema, or broad redesign.

## Evidence and lean verification

On the exact prepared patch, the operator passed typecheck, build and three
focused navigation tests. Real Chromium at 390x844 and 1440x900 opened the menu
and Settings. A synthetic result -> Changes -> feedback -> unapproved revision
journey passed at each viewport. Empty Work, a long project name, keyboard
activation, and 404 -> Back -> menu recovery were inspected. No physical-phone
Safari or live HTTPS verification is claimed from these fixtures.

The two committed screenshots under `evidence/mobile-settings-navigation/`
show the final patched menu from that same operator session, using synthetic
fixture data and the existing UI-polish fixture. Inspect them. They may be
reused for unchanged code; do not present them as live agent output. The phone
menu button is 44x44 and rows are 68.5px high with no horizontal overflow.
Removing the subtitle makes the full Settings row visible in the initial
390x844 All projects viewport. Smaller heights scroll normally.

Run `npm run typecheck` and
`npx vitest run src/serve.test.ts -t 'the mobile menu reaches settings from All projects|chat, work, and projects are the only primary destinations|settings is secondary'`.
Do not run the full suite in the builder or independent reviewer. Standing
Orders runs the unchanged approved full command at its final machine gate.
No removed tests, new skips, weakened safeguards, fabricated receipts, or new
agent time limits. Include honest changed-path/check and screenshot evidence
in the normal native proof. The reviewer must inspect this bounded diff and
the existing screenshot bytes, not presume they were checked.

## Boundaries

Only `src/serve.ts` and `src/serve.test.ts` should require implementation
changes. Update this document only to record concrete corrections or final
validation. Do not change live configuration, approvals, database, processes,
credentials, GitHub, main, global packages, or installed runtime. Do not
touch the dirty operator checkout. The operator will use the accepted final
candidate for a guarded backup, compatibility rehearsal, idle process stop,
deployment, normal browser checks, and matching UI/worker build verification.

## Final validation (builder, 2026-09-16)

Applied `git cherry-pick --no-commit 729e7d1` on b3002a9; the diff is the
expected two files and needed no correction. `npm run typecheck` exited 0 and
the three focused navigation tests passed (3 passed, 332 skipped). Negative
control reproduced: with only the `/menu` guard exemption removed, the new
regression fails with `expected 303 to be 200`; restored afterward. Both
committed screenshots were re-read as valid PNGs (390x844 and 1440x900) and
match the patched menu: All projects selected, no subtitle, Settings row
visible. No physical-phone or live HTTPS check is claimed. The unchanged full
verification command is left to the final machine gate.
