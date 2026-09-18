# Stop paying for gate failures the change did not cause

Fable 5.1 planned and implemented this change; it is merged on `main` as
eac1fe0 (PR 23) and this task obtains the harness-native gate and review the
installation requires before the runtime is swapped.

## Why

Mayhem-spire run 1784 passed 163 of 164 tests. The only failure was an
untouched, non-asserting balance probe timing out at its own 120 s limit.
The failed-check repair read exit 1 as a refuted proof and drafted `-fix-1`,
whose builder correctly changed nothing and whose gate then passed. The
follow-up review then stalled on a criterion demanding proof that a
regression fails on the original base, which the machine gate never
produces. Separately, the approved local gate ran the suite serially in
about 900 s while CI ran it in parallel in about 130 s.

## Changes

1. `src/gate-failure.ts` classifies a failed gate from its sealed receipt,
   check log and candidate inventory: `gate-timed-out`,
   `untouched-test-timeout`, or `repairable`. `maybeTriggerRepair` in
   `src/dispose.ts` now notifies a person in plain words, naming
   `standing-orders task requeue`, instead of drafting a repair for the first
   two. Assertion failures anywhere, timeouts in touched files, unreadable
   logs and truncated inventories still draft as before.
2. `src/planner.ts` tells the planner to state criteria as things observable
   on the finished candidate alone and never to require "fails on the
   original base" or other before/after comparisons.
3. `vitest.config.ts` default `testTimeout` 15 s to 30 s, and 60 s on the two
   heavy `src/project-learning.test.ts` cases, so the full suite is green
   under file parallelism. The approved verification command for this
   checkout was re-approved without `--no-file-parallelism` at 600 s.

## Acceptance

- c1: focused `src/gate-failure.test.ts` and `src/repair-loop.test.ts` cases
  (gate timeout, untouched-test timeout, and the three still-repairable
  shapes) pass; changed paths `src/gate-failure.ts`, `src/dispose.ts`.
- c2: `src/planner.test.ts` and `src/prompt.test.ts` pass; changed path
  `src/planner.ts`.
- c3: the approved command passes on this candidate under file parallelism;
  changed paths `vitest.config.ts`, `src/project-learning.test.ts`.
