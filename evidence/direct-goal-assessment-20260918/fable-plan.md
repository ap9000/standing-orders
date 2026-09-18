Recommendation: yes, the supplied code supports dropping builder proof as a prerequisite and letting the existing reviewer assess the signed goal against machine-collected evidence. The change fits the current adjudicate, dispose, and reviewer seams. Two blockers must be handled first. They are listed in section 6.

1. Recommended flow

The builder still ends with the tiny handoff file, but only its status matters to the machine: completed, no-change, or failed. The conclusion stays a one-line courtesy for operators. The proof file stays optional and is treated as supplementary claims, never as a gate.

At fence time the controller collects facts exactly as today: sealed diff and diff stat, approved command result and retained log bound to the sealed head, screenshots, and the review context inventory. It computes a machine verdict from those facts alone. A run with no proof has an empty claim set, so nothing can be refuted, and the verdict is about evidence readiness only.

When the machine verdict is ready and the check rows pass, the existing one-shot automatic review is requested under the same strict-scope and mode terms. The reviewer receives the patch, rubric, gate receipt, check log, screenshots, and context inventory, and judges every criterion id. Its judgements populate the existing semantic coverage projection. Goal status is read from that projection plus human sign-off for human-only criteria. Passing tests never move goal status.

2. Seams and two statuses

Machine verdict, the existing field, keeps its values. In `adjudicate` remove the early return that yields short for a missing proof. Instead, when no proof exists, build the matrix from facts: check-evidence rows pass when the approved command ran at this head and exited zero; changed-path rows are settled by the sealed diff stat; screenshot and manual-review rows stay unproven. Handoff missing, diff missing or failed, and truncated diff stat remain short. When a proof is present, all existing claim checks still run, including exact changed-path equality and pending-verification resolution. Add a reason string noting the verdict rests on machine facts only.

Goal status is the existing `SemanticCoverage` projection, unchanged. Satisfied only when every criterion is upheld under strict, and human-only criteria additionally need the human act. No new status engine.

In `maybeRequestAutoReview` replace the proof-null bail with a check that the machine verdict is verified and the check rows pass. Keep the stale-command refusal, the strict approved-digest match, and the explicit-only retry semantics untouched.

`foldReview` and `saveProofVerdict` already preserve the machine verdict and let upholds never raise it. No change. Contradicts still lowers to refuted.

3. Missing evidence and genuine no-change

Missing proof is not missing evidence. Missing handoff, diff, gate, or log is, and stays short with no automatic review. Stale approved command still refuses. A genuine no-change run has handoff status no-change, an empty captured diff stat, and a gate at the unchanged head. That is ready. For the repair path the existing unchangedRepair branch already admits it. Reuse of verification is limited to what the gate binding already proves: same sealed head and same approved command. The excerpts show no config or dependency hash in that binding, so cross-run reuse beyond that is not supported today and should not be claimed.

4. Shortest regression coverage

Replay the real Mayhem failure as one integration test: no-change repair, handoff no-change, no proof, empty diff, passing full check. Assert machine verdict is not short, automatic review is requested exactly once, and goal status comes only from reviewer judgements. Strip the auto-supplied proof from the existing synthetic no-change test so it stops masking the gap.

Add unit cases for adjudicate: no proof with passing check yields pass on check rows and unproven on manual rows; no proof with failed check stays not ready; no proof with missing handoff or truncated stat stays short; proof present still refutes overclaimed paths.

Add one foldReview case: reviewer upholds on a failed check row leaves the machine verdict and row state failed.

Add one reviewer preflight case: rubric present, no proof artifact, review proceeds with the proof file absent and the context inventory not all gaps.

5. Defer

Cross-run verification reuse keyed on dependency or config hashes. Screenshot criteria without proof, which need a machine-captured screenshot manifest. Showing the handoff conclusion to the reviewer. Any prompt rewrite beyond one sentence telling the builder that proof is supplementary. New UI beyond surfacing the two statuses side by side.

6. Support and hard blockers

Supported by the code: the reviewer brief already handles an absent proof and instructs cannot-tell when files cannot settle a criterion. Preflight only reads the proof if it exists. The gate receipt and check log are sealed inputs. The machine verdict is stored separately and upholds cannot raise it.

Blocker one: `manualReviewOnly` takes the proof as its argument. It must be derived from the approved criteria's evidence lists instead, or human-only runs will never reach review without a proof.

Blocker two: `captureReviewContext` calls gapAll with source-proof-missing whenever the source proof is null, and criterion relevance is planned from the source proof's criteria. If that applies to a first review whose source is itself, a proofless run inventories nothing and every criterion becomes a context gap, leaving the reviewer only cannot-tell. First-review relevance must fall back to the sealed diff paths for every criterion when no proof exists. The excerpt does not show whether the first-review path is exempt, so this needs confirmation.

Uncertainties: the behavior of `criterionMatrix` with a null proof is not shown, and the underclaimed branch is cut off. `maybeSettleRepairChain` closes the repair chain on a verified machine verdict, which is acceptable because the chain's goal is the failed check, but this should be stated as machine settlement, not goal acceptance.
