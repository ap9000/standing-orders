# Workspace packages 0 and 1 — execution record

User authorized starting packages 0 and 1 on September 13, 2026. The full plan is [Workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md). This record distinguishes implementation, verification, integration, and deployment.

## Baseline preservation

- Main remains `45ad5a70e1c4b4435d663066e3c9d7c329513c00` with the user's existing edits.
- Read-only byte comparison confirmed all 52 files captured by snapshot `b1290a74795761d070f14993a789980ff849c71e` still match their current working files. Untracked files were compared explicitly; ordinary `git diff` incorrectly looks like deletion for those snapshot-added files in this untracked checkout.
- Reviewed UI candidate: `d12d776897e3d4a0bb329737e8f09f624285f467`. Original builds 1540/1541 and failed-verifier evidence remain intact.
- No service restart, installation update, credential change, push, publication, or main merge has been performed.

## Package 0

- Task: `workspace-0-verifier-20260913` — Resolve repository verification discrepancy before workspace redesign.
- Exact approved scope: `44461243aa89a575268b604f078bafda`, approved by the existing saved operator login at 21:46:46 UTC.
- Real build: **1542**, on the existing `alexsmacstudio-localdomain` worker.
- Actual builder: Claude Opus. Existing route/permission settings and optional dollar maximum were retained; no global setting was changed.
- The normal task branch was seeded from `d12d776897e3d4a0bb329737e8f09f624285f467` before dispatch. The run's recorded base confirms that revision, preserving the previous UI pass.
- Scope: diagnose the serial-test discrepancy, measure database operation separately from assertion overhead, apply only an evidence-backed fix, preserve timeout/no-partial-write guarantees, and run the exact approved command twice consecutively.
- Diagnosis: the raw SQLite lock wait also took about 12.3 seconds in the background worker process; the assertion matcher was not responsible. Temporary scheduling-tier probes support timer coalescing as the context difference. A direct independent probe outside that process tree took 5.306 seconds for the same nominal 5-second wait.
- Candidate fix: charge transaction-entry lock retries against a monotonic elapsed-time budget, retaining the 5,000 ms connection default, the existing less-than-10,000 ms assertion, no transaction-body replay, and recovery after release. Other SQLite statements still use their existing nominal busy timeout; this is not a hard real-time guarantee against OS suspension.
- Two consecutive builder-context executions of the unchanged approved typecheck/serial-suite/build command passed: 2,789 tests passed, 23 existing platform skips, 161 test files; suite durations 284.34 and 287.35 seconds; command exits 0 and 0. The worker's final seal and independently executed repository gate remain pending.
- Independent review identified two points to resolve before integration: an extra diagnostic script outside the declared file list, and wording that overstates the deadline as a guarantee across all scheduling conditions. Preserve the original result and record any correction rather than treating it as already approved.
- Original sealed head: `6b125833475591ecb8aac02aa02225e19e16d913`; the machine's independent verifier is running on it. Two review annotations were filed on build 1542 and sealed through the real console into `revise-workspace-0-verifier-20260913-from-2-annotations-`. Its narrow cleanup scope `471021226a3488d1c34593c14c9daa07` was approved at 22:18:01 UTC. This authorizes removing that helper and correcting comments/documentation only, not changing the tested behavior. Package 1 explicitly depends on this revision as well and remains held.
- The independent machine verifier on that sealed head finished at 22:19:22 UTC with verdict **verified**: typecheck, unchanged serial suite (2,789 passed / 23 existing skips / 161 files / 288.76 seconds), and build passed. Review cleanup is build **1543**, started at 22:19:23 UTC. The source's verified record remains separate from the cleanup and does not erase the review findings.
- A fresh preservation check at 22:20 UTC still found all 52 baseline files byte-identical in the user's main checkout.
- Independent root verification on sealed build 1542 passed: `npm run typecheck && npx vitest run src/store-contention.test.ts src/schema-epoch.test.ts --no-file-parallelism` — 10 tests in 2 files, 12.70 seconds. The cleanup candidate was also compared directly against the sealed source: `src/store.ts` is byte-identical outside its one edited comment block, the contention test is entirely byte-identical, and the extra diagnostic is removed. Two attempted compiler-API comparisons were unavailable because this installed TypeScript package exports version metadata only; the explicit comment-boundary byte comparison established the intended fact without that API.
- Fresh isolated browser baseline on build 1542: **75/75 checks passed, 21 viewport screenshots**, saved under `output/playwright/workspace-0-ui-baseline/`. This covers chat, approvals, normal and annotation revisions, phone fit at 320/390/430 px, fresh empty desktop chats at 1280×800 and 1440×900, keyboard access, and reduced motion. Baseline HTML bytes (not claimed transferred/compressed bytes): chat start 180,804; ready chat 195,380; approval 197,736; task result 198,507; run page 195,585.
- Cleanup build 1543 sealed `38ca99341784f8ba406ca2d23af8b37f5a88960c`, based on build 1542's head, using Opus with recorded subscription authentication. It changes only the two reviewed source/doc files and removes the extra helper. Builder-context checks passed (10 focused tests and the full 2,789-test serial suite, 23 existing skips); the machine's own verifier is now running. The minor pre-existing universal wording in the test's explanatory comments is noted as a limitation; no further runtime or test change is being added to this cleanup.

## Package 1

- Task: `workspace-1-navigation-20260913` — Unify navigation and truthful status across the workspace.
- Filed through Standing Orders and explicitly depends on package 0.
- Execution is not approved yet. A terminal task state alone will not release this gate: package 0 needs its required passing verification and independent inspection.
- Planned base: the verified package 0 result, to be resolved after its evidence is inspected.
- Planned changes: Chat / Work / Projects shell, compatible legacy links, secondary Work/Settings destinations, status projection from existing records, and removal of premature shipment/completion language.
- Preserve both revision modes, all existing approvals, subscription behavior, project visibility, phone fit, and the previous UI fixes. Packages 2–5 are not started by this authorization.

## Required handoff

Record final run/head identities, exact verifier outcomes, independent focused checks, viewport screenshots, remaining limitations, and integration/deployment state here as the work progresses. Keep any initial failures in the record.
