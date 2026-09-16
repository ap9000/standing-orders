# Make status replies easy to act on

The operator pasted a Telegram reply with opaque project codes, long task IDs,
raw review/proof statuses, stale incidents and a vague offer to draft something.
They want readable recommendations and selected **up to three recommended
actions, with more on request**. Apply this to the shared assistant used by
Telegram, the browser and CLI. Do not change work priority or approvals for them.

Start from this pinned input based on verified deployed
`2a630907e12c8f6e1b522cce4c32367a755bd838`. Apply the prepared patch with
`git cherry-pick --no-commit 51ef811 d2cd926 7cd9057` so the native host owns the final commit.
Inspect it and correct only reproduced issues within this scope. Never advance
the task's original base to hide changes. The operator handles merge and guarded
installation after successful native verification and independent review.

## Required behavior

- A default status/priority reply has one short project summary and at most
  three useful next actions, each naming the task plainly, explaining its
  problem and giving a next step. More is available on request. Use current
  task/result evidence; keep partial counts and urgent unresolved risks honest.
  Do not call missing checks a failed build or declare finished-but-unverified
  work complete. Do not prioritize paused optional features just to fill a queue.
- `list_repos` supplies validated display names for the exact admitted projects,
  retaining opaque IDs as tool arguments. No guessing a project from task titles.
  This is a narrow, documented exception to basename hiding for display metadata
  only. Full paths, free-text basenames, account names, secrets, digests and
  out-of-scope projects stay protected. Unsafe/overlong labels use `Project N`.
- Recommendations attach real existing controls through `show_control`; status
  requests do not change tasks. Explicit requests can draft ordinary proposals,
  but confirmation, approval and exact task/result identity remain enforced.
  No new action system, schema, transport, model defaults or authority changes.

## Validation and boundaries

Product edits cover `src/mate-contract.ts`, `src/mate-tools.ts`,
`src/mate.test.ts`, `src/serve.ts`, and `src/serve.test.ts`; `docs/mate-arc.md` documents the display-label exception.
This document and `evidence/actionable-chat/` record inspected evidence.
Do not modify live configuration, databases, processes, credentials, global
packages, main, GitHub or the dirty original checkout.

The operator ran typecheck and the existing mate/Telegram mate suites: 99 tests
passed before final wording refinements. The four focused contract/label/privacy
regressions and typecheck passed again on the prepared patch. Run typecheck and
those two affected suites on the native candidate; include the focused serve test named `navigation cards offer one labelled link|blank lines do not reset`.
Both new label and navigation-card regressions failed against the old
implementation and passed after restoration; the operator already ran these
negative controls, so reuse that evidence. Navigation cards now show a task
title and one link, omitting the misleading pending/proposed-by header. Actual
change proposals retain their confirmation and status.
Do not duplicate the unchanged approved full suite in the builder or reviewer;
Standing Orders runs it once at the final machine gate. Never remove tests, add
skips, relax spend/approval/evidence checks or introduce agent time limits.

The contract was compressed to retain existing direct-API reservation tests;
no limits or financial safeguards changed. The initial replay still overlisted
items and recommended optional holds; later wording explicitly prevents those
patterns. A live-model reply is evidence of that trial, not a guarantee that all
future prose will be identical. Inspect the final recorded reply and controls.

The operator's replay uses a private SQLite snapshot with the candidate's real
shared chat engine and the configured Anthropic membership model. There are no
workers, Telegram sends, confirmations or live state writes. Screenshots are an
isolated replay, not production output. Browser result/revision machinery is
unchanged; reuse the prior accepted mobile-settings journey evidence for that
unchanged machinery. Inspect the affected reply at 390x844 and 1440x900, including
its long task titles and recovery controls. State any untested device behavior.

The viewport check also reproduced numbered actions resetting to 1 after each
blank line. The prepared renderer patch preserves explicit numbers using safe
numeric list-item values; its focused browser-route regression passes and
retains HTML escaping. No CSS, task action or transport changes were needed.
