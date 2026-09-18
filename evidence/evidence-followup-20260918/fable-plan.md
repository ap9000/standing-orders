I'll lay out one design, then the acceptance cases. No files or tools touched.

## Design: observation attempt on the existing repair chain

**Core idea.** A cannot-tell review composes one more repair-chain attempt whose draft kind is `evidence-observation` instead of `criterion-repair`. The draft names exactly the cannot-tell criterion ids. Its run changes nothing in the tree. The machine executes a small observation manifest in isolated archives, seals the results as artifacts on that new run, and the new run gets its own fresh root review. The old review stays untouched, and the one-successful-review index stays as is. Everything rides `repair_chain`, `openRepairDraft`, `sealRevision`, the ordinary tick, and review admission.

**Trigger** in `src/dispose.ts:620` area. In the `cause === "review" && direct && no contradicts` branch, replace notify-and-stop with:
- Collect `unresolved` as the ids whose latest review judgement is `cannot-tell`. Empty set keeps today's return.
- Fall through the same guards, lineage, integrity, no-progress, and attempt cap. An observation attempt spends one `repairMaxAttempts` slot. No new bound.
- Compose the draft through `openRepairDraft` with brief `kind: "evidence-observation"`, `observed: { head, originalBase }`, and `manifest: null`. Title "collect evidence for <task>: c1". Repair text says: change no files, write the observation manifest.
- Mode with `repairAuto` auto-approves as today. No mode gives an unapproved draft plus the existing "More evidence is needed" notification, now linking to the draft.

**Original base.** The machine resolves `originalBase` as the root task's first builder base via `firstBuilderBase`, the same lookup `assessmentFromSavedEvidence` uses. Manifests never carry a raw sha.

**Manifest.** Mailbox file `.standing-orders/observations.json`, ingested with the park pattern from `src/builder.ts:2740`: read, validate, remove from the worktree before diff. Shape:

```json
{ "version": 1, "observations": [
  { "criterion": "c1", "at": "base" | "head", "overlay": ["test/augment.test.ts"], "command": "npx vitest run test/augment.test.ts" }
] }
```

Bounds: at most 4 entries. `criterion` must be in the draft's unresolved set. `overlay` paths must be a subset of the candidate's sealed diff-stat paths, normalized, no `..`, no symlinks after extraction. `command` is one line, at most 4 KiB.

**Execution.** After the agent exits and the manifest is ingested, for each observation: `git archive <resolved sha>` into a fresh directory under the run's scratch root, overlay each path with `git show <head>:<path>` and record its sha256, run the command with the builder's sealed `ExecutionProfile`, the `AGENT_ENV_DENYLIST`, and the existing idle timeout. Capture stdout and stderr with the check-log byte bound and secret redaction. Delete the directory. Seal each log as `observation-<n>.log` and one `observation-receipt.json` with capture string `machine observation receipt v1`, binding run, criterion, `at`, resolved sha, overlay hashes, command, exit code, and the log artifact binding. Lockfile hash is recorded as the sha of the lockfile at each revision. This is agent-proposed, machine-witnessed. The command gets no authority beyond what the builder already had in its worktree.

**No-change requirement.** If the worktree shows any diff after manifest removal, the run finishes `refused` with reason `observation-changed-tree`. A malformed manifest finishes `refused` with `observation-malformed`. Both count as a spent attempt under the existing chain rules.

**Gate reuse.** Before running the approved command, look for a lineage run with the same head, base, scope digest, and command whose `verificationEvidence` passes with exit 0. If found, copy its check-log bytes into a new artifact on this run and call `sealVerificationReceipt` with a `reusedFrom` field naming the source run, artifact id, and sha. Byte-identical, so `src/verification-evidence.ts` accepts it unchanged. Otherwise the full approved command runs as today. The command itself is never altered.

**Review.** Declare `REVIEW-OBSERVATIONS.json` and the logs as sealed files, and list them as items in the v51 review-context inventory so `context_sha` binds them and ingest re-validates them. One prompt line near `src/reviewer.ts:365`: the receipt records an agent-proposed command and a machine-captured result at an exact revision; judge what the log shows. The new run is a new source run, so `requestReview` opens attempt 1 normally, automatically under `reviewAuto` and otherwise by `task review`.

**Reassessment.** The observation run's review verdict flows into `maybeTriggerRepair` as today. Upholds ends the chain with human acceptance still pending. Contradicts composes a code repair draft. Cannot-tell again meets the existing no-progress and cap stops. No proof report is written for observation runs. The machine writes a short handoff note so direct assessment from saved evidence still applies.

**Manual action.** `task observe <run> --criterion c1 [--manifest file.json]` is one credentialed act. It opens the same draft with human basis, embeds the manifest in the sealed brief artifact when given, and approves it through the same single scope approval the automatic road uses. With a manifest present the run skips the agent entirely. The result page's existing evidence notification gets a "Collect evidence" button that calls the same action without a manifest.

**Schema.** No migration. The draft kind, manifest, and receipt live in artifact JSON. Chain rows, stops, and attempts are the existing persisted rows written in the seal transaction, so restart safety is inherited. A crash mid-observation leaves an interrupted run via dead-watch, no receipt, and the chain row untouched.

**Mayhem.** Run `task observe 1787 --criterion c1 --manifest mayhem-c1.json` with two entries: `at: base` overlaying the regression test, and `at: head` with no overlay, same command. Expected logs: base exit 1 with the expected augment_draft, received map text, head exit 0. Gate is reused from run 1787. Then the new run's review judges c1 from the receipt. Reviewer 1792 and `task review 1787` are unchanged.

## Acceptance cases

1. **Auto trigger.** Direct-assessment review with c1 cannot-tell and c2, c3 upholds under a `repairAuto` mode composes exactly one approved `evidence-observation` draft with unresolved `[c1]`. A second trigger is a no-op. No notification is queued.
2. **No mode.** Same review without a mode produces an unapproved draft and one notification linking to it.
3. **Guards unchanged.** Stops, holds, open decisions, pending steer, accepted proof, published run, and report deliverables all yield no draft.
4. **Bounds.** Cap exhausted settles `attempts-spent`. Two consecutive identical unresolved sets settle `no-progress`. Both persist across restart.
5. **Manifest rejected.** Overlay path outside the patch, raw sha in `at`, five entries, a multiline command, or a symlinked overlay refuses the run with `observation-malformed` and seals nothing.
6. **Tree changed.** An agent that edits a file gets `observation-changed-tree`, and nothing is committed.
7. **Execution and custody.** Each observation runs in its own extracted archive, which is gone afterward. Receipt fields match the resolved sha and overlay hashes. Logs are redacted and bounded like check-logs.
8. **Gate reuse.** A lineage run with a matching verified receipt yields a byte-identical check-log and a receipt with `reusedFrom`, and `verificationEvidence` returns ok. No match runs the approved command unchanged.
9. **Review binding.** The reviewer sees the receipt and logs as declared files. Tampering with a log after seal makes ingest fail, as today.
10. **Reassessment.** Upholds ends the chain with no new draft and human acceptance pending. Contradicts composes a `criterion-repair` draft. Cannot-tell again follows case 4.
11. **Manual path.** `task observe 1787 --criterion c1 --manifest m.json` opens and approves the draft, skips the agent, executes both observations, and seals the receipt. `task review 1787` still refuses already-reviewed. Reviewer 1792 rows are unchanged.
12. **Interrupted run.** Killing the process mid-observation leaves the run interrupted, no receipt, and the chain row as it was. Redispatch behaves like any interrupted repair draft.

The one cut that keeps the design intact if Astra wants it smaller is gate reuse. Without it the observation run reruns the full approved command, which is correct but slower.
