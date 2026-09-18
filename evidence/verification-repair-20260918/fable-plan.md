The Write tool is disabled in this session, so I can't create the plan file. Here is the plan directly.

# Standing Orders: failed machine verification → bounded repair draft

**Context.** A committed candidate whose approved verification command exits non-zero ends today with no review and no repair. `disposeBuildOutcome` (`src/dispose.ts:268,353`) only calls `maybeRequestAutoReview`, which deliberately refuses failed machine checks. `maybeTriggerRepair` is reached only from `src/reviewer.ts:1645` after a reviewer folds a verdict. Even if reached, its `unresolved` set comes from matrix rows in `missing`/`failed` state. A machine-gate failure (`adjudicate` → `refuted`, reason "the repository's approved verification command exited N", `src/proof.ts:1094`) leaves the matrix as the agent's own proof answered it, often all `pass`, so the trigger returns `none`. Mayhem hit both gaps.

## Design (minimal)

**1. One gate predicate, `machineGateRepairable`, new export in `src/dispose.ts`.** Returns `null` or `{ exitCode, setupReplayed, reason, receipt: {artifactId, sha256}, log: {artifactId, sha256, key, bytesStored} }`. True only when all hold:
- Run exists, `outcome === "built"`, `committed`, `headRevision !== null`, and `store.applicableStopFor(runId) === null` (stop fence).
- Stored proof `(machineVerdict ?? verdict) === "refuted"` and a reason matches the machine-gate phrase. Reuse `failedCheckExit` from `src/workspace-ui.ts:187`, so structural or integrity refutations never route here.
- `verificationEvidence(store, root, runId)` is `ok` with `bytes !== null`, and the parsed receipt has `result.ran === true && result.exitCode !== 0`. This already binds head, base, scope digest, the live approved command, and the log artifact.
- Exactly one `check-log` artifact with `captureStatus === "ok"` and `truncated === false`. Redaction is fine; a shortened log is not "the full pinned log".

**2. Fire the existing trigger from disposition.**
- `DisposeContext` gains optional `evidenceRoot?: string`. Pass `context.evidenceRoot` at the two tick call sites in `src/operate.ts` (about lines 3685 and 3907). Extend `args.dispose` in `src/held.ts:68` to forward it. Standalone and continuation pass nothing and stay byte-identical.
- In `disposeBuildOutcome`, after the locked transaction returns (outside the lock, matching the reviewer road): when `policy === "tick"`, the disposition is `built` with `committed && !noChange`, `evidenceRoot` is set, and the predicate is non-null, call `maybeTriggerRepair(store, repo, evidenceRoot, runId, "refuted", clock())`. `repair_chain.source_run UNIQUE` makes replays and a later explicit review no-ops.

**3. `maybeTriggerRepair` folds the gate into `unresolved`.**
- Compute the predicate once, after the verdict and UNIQUE checks.
- When it fires, append the sentinel id `machine-verification` to `unresolved` (sorted) before the `length === 0 → none` check. Add a detail row `{ id: "machine-verification", statement: "the approved verification command exits 0 on the candidate", detail: [reason] }`. The brief gains `machineVerification: { exitCode, setupReplayed, reason, receipt, log }`. JSON body only, schema stays 1, no DB change.
- Everything else is untouched: lineage and attempt numbering, integrity stop, no-progress (`[c1, machine-verification]` → `[c1]` is progress; three identical sentinel sets stop), attempt cap, `basis` human vs `mode repairAuto`, `openRepairDraft`, `sealScopeApproval`, publication, decision, steer, and acceptance guards.
- Reviewer road unchanged. If a machine-failed run is reviewed explicitly, the sentinel is added there too, and UNIQUE dedupes.

**4. Builder instructions, `src/builder.ts` prompt block near line 3213.** The brief is already read verified and parsed at line 1283. Pass `kind` and `machineVerification` into the prompt builder. When `kind === "criterion-repair"` and `machineVerification` is present, add after the quoted brief:
- The previous candidate's approved verification command exited N. Its complete log is pinned at `<root>/<log.key>` with the stated sha256. Read the whole log before changing anything.
- When the failure reads as a timeout or transient, rerun exactly that failing test once to diagnose. Do not assume flake. Never skip a test, loop retries, or raise a timeout.
- Fix within the scope above. Run the focused tests and the typecheck yourself; do not run the full gate. The machine runs the unchanged full gate once on your final candidate, and an independent review follows a green gate.

Review after green is the existing `maybeRequestAutoReview` on the fix run. No other prompt, mode, or store change.

## Edge cases

- **Publication grant present.** Dispose creates an `intended` publication for every committed tick build before the verdict is weighed, and `maybeTriggerRepair` refuses any run with a publication row. Both roads already share this limit. Keep it, but confirm the Mayhem repo has no live grant, and say so in the PR.
- **Truncated check log.** No machine repair. The run keeps today's behavior and the run page still shows the truncated evidence.
- **Structural refutation before the gate** (`sealedStatAltered`), integrity refutations, and `ran:false` receipts (`short`) are excluded by the predicate.
- **Recovery replay** (`setupReplayed`) is allowed and recorded in the brief.
- **Legacy header receipts** with no sealed artifact are reconstructed by `verificationEvidence` and accepted, since the bindings are identical.
- **Stop won at settlement** yields `stopped`, never `built`, so no trigger.
- **No mode or no `repairAuto`**: the draft is composed and waits unapproved, the existing human road.
- **Draft scope profile unresolved**: approval is skipped, as today.
- **Held road** fires only if the coordinator passes `evidenceRoot`.
- **Agent file access.** The pinned log lives under the evidence root, outside the worktree. Confirm the builder's permission profile allows reading it. If not, the instruction should name the artifact id and the CLI command that prints it.

## Targeted tests

`src/repair-loop.test.ts`, extending `seedRun` to optionally store a check-log plus sealed receipt via `storeEvidence` and `sealVerificationReceipt` under an approved verify command:
- Machine-failed run, matrix all `pass` → draft `…-fix-1`, `unresolved === ["machine-verification"]`, brief carries `machineVerification` with receipt and log bindings. `approved` is false without a mode and true with `repairAuto`.
- With `[c1 missing]` → `["c1","machine-verification"]`. Fix run green with `c1` still missing counts as progress. Three identical sentinel sets → `repair-no-progress`. Cap of 1 → `repair-attempts-spent`.
- Truncated log, `ran:false` receipt, structural refutation, `attested` or `verified`, and stale approved command (`approvedAt > startedAt`) → `none`.
- Second trigger for the same source run → `none`.

`src/task-control.test.ts` (dispose): tick policy with `evidenceRoot` and a machine-failed run → one `repair_chain` row after `disposeBuildOutcome`. Standalone and continuation → none. Stop before settlement → none. Missing `evidenceRoot` → none.

`src/builder.test.ts`: a criterion-repair brief with `machineVerification` renders the three instruction lines and the log path. A plain criterion-repair or annotations brief does not.

`src/reviewer.test.ts`: auto-review refusal on failed checks unchanged. Explicit review after a machine-repair draft does not duplicate the draft.

## Verification

Run the typecheck and the four suites above. Then seed a run with a failing verify command through a tick in a scratch repo and confirm a single `…-fix-1` task appears with the brief on the task page.
