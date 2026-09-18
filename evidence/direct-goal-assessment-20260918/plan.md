# Assess the goal from captured evidence

Keep a small terminal signal from the builder: finished, blocked or failed, with an optional summary. Remove the builder-authored proof document as a prerequisite for evaluating the result. A clean process exit or green test suite alone does not establish that the goal was met.

The controller already records the exact candidate, whole-task changes and inherited source context, approved verification command and its output. Let it collect and validate these facts once. The existing independent reviewer should then assess the approved goal, constraints and each acceptance criterion directly against that evidence. Builder notes are context, not authority.

## Minimal flow

1. Builder finishes or identifies a blocker.
2. Controller captures current evidence and verifies its identity and completeness.
3. Reuse a valid check receipt for the exact candidate and unchanged approved verification setup where supported; otherwise run the approved check once.
4. One independent assessment returns goal met, changes needed, or evidence missing, with evidence references for each criterion.
5. A code defect uses the existing bounded repair path. Missing evidence requests only the specific observation or artifact; it does not require a report-writing repair or automatically repeat a full suite. Required human decisions remain human decisions.

No-change results follow the same flow. A lack of new changes says nothing by itself about whether the existing implementation satisfies the goal.

## Concrete changes

- `src/dispose.ts`: automatic assessment admission should depend on validated machine evidence, a current approved scope and the existing review authority. It must not depend on a builder-authored proof being present.
- `src/proof.ts` / `src/store.ts`: represent machine facts and independent goal assessment separately, and derive readiness from both. Do not add a blanket exception letting `upholds` upgrade every `short` result. Existing failed checks, changed authority, invalid artifacts and human-only criteria remain blockers. Historical assessments are preserved.
- `src/review-context.ts`: derive the bounded evidence inventory from the exact candidate diff, original task base, declared scope and verified ancestry. Optional builder citations may aid navigation; they must not be the sole source of evidence selection. A first-time no-change task may need scoped source files even with an empty diff.
- `src/reviewer.ts`: use the existing sealed evidence and range-reading mechanism. Assess the signed goal and criteria directly; require citations and identify the exact missing evidence. Keep code review and goal assessment in the same pass.
- `src/builder.ts`: retain the small lifecycle signal, stop requiring duplicate criterion restatements and self-reported changed-file inventories, and keep concise optional caveats visible to assessment. The controller owns mechanically observable facts.

Existing screenshot and artifact capture must remain explicit and bound to the candidate; do not discover arbitrary files and treat them as approved evidence. Evidence collection cannot silently widen the scope, execute unapproved commands or turn a human acceptance requirement into a machine pass.

For this direct-assessment path, goal assessment must be required before declaring the result ready, including default-quality tasks. The current `SemanticCoverage` projection requires assessment only under strict policy, so reusing it unchanged would leave a completion gap. A passing check proves the check passed; it does not automatically prove every behavioral criterion or settle the whole repair goal. Preserve the distinction between a repaired check and an accepted result.

`manualReviewOnly` already reads the stored verdict and matrix rather than requiring a builder-authored artifact. Preserve that safeguard; change its inputs only if the new facts-derived representation requires it.

## First regression and live validation

Extend the existing real-Git recovery journey to model the actual Mayhem behavior: a failed source check, a legitimate no-change repair, no builder proof, a passing fresh machine gate, one independent goal assessment, and a truthful resulting state. Include a substantive criterion failure despite green tests, missing required evidence, stale/tampered evidence and a changed verification setup. No blanket waiver for absent or malformed proof.

After deployment, request a fresh assessment of Mayhem run 1787 against its existing complete gate receipt and saved source. Keep runs 1784 and 1787 intact. The existing gate passed all 164 tests and the production build for commit f6bee2ac9b419ee59070d5f7c16e752aa0e02515. Reuse that receipt only if current identity and verification-authority checks still pass. This is a proposed validation, not a completed assessment.

## Keep this change small

Reuse the existing reviewer, immutable artifact store, review requests and repair bounds. Defer a general-purpose evidence planner, extra judging agents, broader test caching, new dashboards and removal of the terminal lifecycle protocol. Prefer fewer product steps and show one primary state with details available when needed.

Status: code paths inspected and Fable 5.1's planning assessment checked against the implementation. The recommendations above correct its assumptions about optional default-policy assessment and `manualReviewOnly`. This document does not change the running installation or claim implementation/tests of the new design.
