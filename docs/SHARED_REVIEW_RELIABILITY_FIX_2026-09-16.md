# Shared review reliability: finish the existing fix

User direction: switch this task to Claude Fable 5.1, fix the repeated handoff
passes without overengineering, and make the correction work across workflows,
not only Standing Orders' own repository or this task's filenames.

Preserve the recovered draft and the original first-review improvements. Finish
the current scope; do not build a new framework or replace the scheduler.

## Root cause and implementation target

The machine knows the exact final diff, yet requires the agent to reconstruct
its path inventory before that commit exists. Run1642 passed the full check and
all independent criteria, but listed both sides of a rename; the canonical
sealed inventory has only the destination. Prompt-only guidance is brittle.
The first draft's unstaged diff plus untracked-files recipe reproduced the bug.
Root verified this with real Git in a disposable repo. Preserve the draft's
real-Git regression and replace inaccurate guidance, without adding paragraphs.

Use the existing receipt validation/correction boundary before final review.
Supply trustworthy, exact sealed facts where the machine already owns them;
do not make an LLM guess Git's representation. Make mechanically recoverable
submission errors correctable in that existing bounded path, with the original
submission and correction retained in the existing audit artifacts. Prefer a
small shared helper over parallel provider/workflow implementations. No schema,
dependency, new task/reviewer loop, or manual refresh action.

Safety boundaries: changes to actual checks, exit codes, screenshots, caveats,
criterion meaning/verdicts, code, scope, route or custody are not bookkeeping
corrections. Do not upgrade failed/unchecked work: the submitted criterion
id/verdict pairs are frozen exactly (comment 397) — no not-met or not-checked
answer becomes pending-verification, no extra negative criterion is dropped,
none is added; statement and reference corrections against the exact rubric
stay allowed. Re-read and verify the sealed diff-stat after the correction and
after the final gate; never adjudicate cached facts once the artifact differs. Do not weaken final exact-path
or evidence checks or silently normalize arbitrary overclaims. Only permit a
correction whose result is independently established by the exact sealed input;
keep unexplained or unprovable contradictions visible. Missing/tampered stat,
ambiguous legacy receipts, and changed candidates fail closed. Never mutate a
completed run's receipt or verdict. Never retry a substantive reviewer verdict.
Reuse the existing same-session correction guard and artifact history where
appropriate; avoid a special path keyed to run1642 or this repository.

## Proven pattern, not another orchestrator

Goose's FinalOutputTool validates structured output and returns precise errors
and the expected format to the same agent before accepting it:
https://github.com/aaif-goose/goose/blob/main/crates/goose/src/agents/final_output_tool.rs
This is a useful small pattern. Reuse that principle in the existing boundary;
do not import Goose, copy its whole execution-retry loop, or replace this tool.
Our checks additionally bind the evidence to the candidate and approvals.

## Lean acceptance evidence

Exercise the shared behavior in existing suites. Cover ordinary build, revision
and recovered/resumed attempt semantics, using existing coverage where sound.
The concrete positive regression must use real Git rename detection, not only
mock numstat. Include ordinary add/delete/edit cases, and negative coverage for
unrelated claimed paths, missing/truncated/tampered sealed facts, changed code
or authority, and actual failing checks. Cite the existing tests that already
cover a case rather than adding an overlapping test for every permutation.

Demonstrate a recoverable receipt issue reaches one normal first substantive
review with truthful evidence and one native final verification command for
the candidate. Genuine failures stay failures; exhausted delivery corrections
stop clearly. Keep both Claude and Codex paths provider-neutral, and retain the
flat Claude structured-output schema fix and parser rejection of mixed replies.

Run focused affected tests and typecheck during implementation. Standing Orders
runs the unchanged approved full gate once after settlement; no duplicate full
suite in the agent or reviewer. Do not add skips, delete tests or add time limits.
Supply the inherited c1-c4 rubric verbatim, with explicit inspectable code/test
references and exact canonical changed paths. Record any gap honestly. No
deployment, network writes or live DB edits in this task.
