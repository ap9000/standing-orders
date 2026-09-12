/**
 * The build disposition service (Parity II Phase 2, v4 Q2 / v6 W1): the
 * operations that actually END an attempt — sealing parks, accepting
 * completions behind the completion fence, recording failures with their
 * strikes and holds, opening publication intents — extracted from tick's
 * and the standalone build command's finalizers into ONE place, so the
 * held-session coordinator can end a run through exactly the machinery
 * every other road uses. The two historical roads differ deliberately
 * (the standalone command completes no task, strikes nothing, publishes
 * nothing), and the policy record says so explicitly instead of forking
 * the logic: behavior on both is byte-identical to what the callers
 * inlined before.
 */

import { createHash } from "node:crypto";
import {
  completeFenced,
  finalizeFailureFenced,
  finalizeMalformedFenced,
  finalizeParkFenced,
  release,
  type FailureClass,
} from "./claim.js";
import { bodyHashOf, publicationBody } from "./publish.js";
import { modeTermsFromJson } from "./modes.js";
import { writeEvidenceFile } from "./evidence.js";
import type { BuildResult } from "./builder.js";
import type { Store } from "./store.js";
import type { ProofVerdict } from "./proof.js";

/**
 * Which road is disposing. 'tick' = the unattended loop: full task
 * completion, strikes, quota, publication. 'standalone' = the one-off
 * `build` command: run records only — no task state, no strikes, no
 * publication (its historical shape). The held road reuses 'tick' —
 * an attended session is still the task's real attempt.
 */
export type DisposePolicy = "tick" | "standalone" | "continuation";

export type DisposeContext = {
  store: Store;
  policy: DisposePolicy;
  /** The lease this attempt ran under; undefined only on the standalone road. */
  leaseId: string | undefined;
  runId: number;
  taskId: string;
  taskRef: number;
  runner: string;
  /** The canonical repo, for the publication grant lookup (tick policy). */
  repo: string;
  branch: string;
  /** task_ref.origin — the publication selector consults it. */
  origin: string;
  provider: string;
  model: string | null;
  /** Where the attempt's tree lives — failure records name it. */
  worktreePath: string;
  clock: () => Date;
};

export type Disposition =
  | { kind: "parked"; decisionId: number }
  | { kind: "park-fenced" }
  | { kind: "disowned" }
  | { kind: "built"; committed: boolean; noChange: boolean }
  | { kind: "built-fenced" }
  | { kind: "skipped"; reason: "unapproved" | "scope-changed" }
  | { kind: "fenced" }
  | { kind: "malformed"; sealed: boolean }
  | {
      kind: "failed";
      failureClass: FailureClass;
      disposition: string | null;
      strikes: number | null;
      sealed: boolean;
    }
  /** The standalone road's simple record: outcome written, nothing else. */
  | { kind: "recorded"; outcome: "failed" | "refused" }
  | { kind: "invariant"; reason: string };

/** The reasons tick classifies as the attempt itself breaking. */
const TICK_FAILURE_REASONS = new Set([
  "agent",
  "agent-reported",
  "no-op",
  "moved-head",
  "moved-branch",
  "timeout",
  "git",
  "commit-failure",
  "provider-init",
  "setup",
  "revision-brief",
  "stopped",
  // Phase 3 (C1): the gateway's typed refusals consume the task strike
  // budget like every other infrastructure failure — the pre-claim skip
  // keeps the NORMAL road from ever reaching here; these arms bound the
  // races.
  "provider-unattested",
  "provider-protocol",
]);

/** The standalone road's historical "broke" list — narrower, deliberately. */
const STANDALONE_BROKE_REASONS = new Set([
  "agent",
  "agent-reported",
  "no-op",
  "moved-head",
  "timeout",
  "git",
]);

/**
 * Queue the semantic pass when either authority asked for it:
 * - v41 Strict / release is signed into this run's approved scope, so the
 *   approver who sealed those exact bytes is the requester;
 * - the older reviewAuto operating-mode term stays intact and is re-proved
 *   at dispatch as before.
 *
 * Both roads queue, never run inline, and both are ONE-SHOT (v50,
 * explicit-only retries): they declare themselves automatic, so the store
 * refuses them 'explicit-only' once the run carries any root review
 * attempt or any earlier ask — a replayed disposition (crash recovery, a
 * re-dispose, a second tick over the same outcome) never queues a retry,
 * and a stale automatic row is spent unrun at admission. Only a fresh
 * operator act (`task review`, the Retry review button) retries.
 * Refusals are silently fine here: no diff, a truncated capture, or an
 * existing request means there is nothing honest to review (and the run
 * page keeps that evidence visible).
 */
export function maybeRequestAutoReview(store: Store, repo: string, runId: number, committed: boolean, noChange: boolean, now: Date): void {
  if (!committed || noChange) return;
  const run = store.getRun(runId);
  const ref = run === null ? null : store.refForId(run.taskRef);
  const scope = ref === null ? null : store.getScope(ref.externalId);
  if (
    run?.qualityMode === "strict" &&
    scope?.qualityMode === "strict" &&
    scope.approvedBy !== null &&
    scope.approvedDigest === scope.digest &&
    run.scopeDigest === scope.digest
  ) {
    store.requestReview(runId, scope.approvedBy, now, undefined, "automatic");
    return;
  }
  const mode = store.activeMode(repo, now);
  if (mode === null) return;
  const terms = modeTermsFromJson(mode.termsJson);
  if (terms === null || !terms.reviewAuto) return;
  store.requestReview(runId, `mode ${mode.name}`, now, { kind: "mode", digest: mode.digest });
}

export function disposeBuildOutcome(context: DisposeContext, result: BuildResult): Disposition {
  const { store, policy, leaseId, runId, taskId, taskRef, runner, repo, branch, origin, provider, model, worktreePath, clock } =
    context;

  if (result.ok && result.parked !== undefined) {
    if (leaseId === undefined) return { kind: "park-fenced" };
    const sealed = finalizeParkFenced(store, {
      leaseId,
      runId,
      taskId,
      decision: result.parked.decision,
      artifactIds: result.parked.artifactIds,
      now: clock(),
    });
    if (!sealed.ok) return { kind: "park-fenced" };
    // A park is the system working, and it ends any failure streak — on the
    // loop's road. The standalone command never touched strikes.
    if (policy === "tick") store.resetStrikes(taskRef);
    return { kind: "parked", decisionId: sealed.decisionId };
  }

  if (result.ok) {
    if (policy === "continuation") {
      // The taskless success (v4 Q7 + v5 P5): run finished, claim released,
      // publication intent under the SAME completion latch the ordinary
      // road holds — and the parent task untouched in state, strikes,
      // holds, and derived stats. All one transaction.
      const sealed = store.transact((): { disowned: boolean } => {
        const latchOpen = store.mirrorAllowsCompletion(taskId);
        store.finishRun(runId, {
          outcome: result.noChange === true ? "no-change" : "built",
          ...(result.noChange === true ? { reason: "handoff" } : {}),
          committed: result.committed,
          now: clock(),
        });
        if (leaseId !== undefined) release(store, leaseId, clock());
        if (!latchOpen) return { disowned: true };
        if (result.noChange !== true && result.committed) {
          const grant = store.publicationGrantFor(repo);
          const headSha = store.getRun(runId)?.headRevision ?? null;
          if (
            grant !== null &&
            headSha !== null &&
            branch.startsWith(grant.headPrefix) &&
            (grant.selector === "all" || origin === "ours")
          ) {
            const intentId = store.createPublicationIntent(
              {
                run: runId,
                taskRef,
                githubRepo: grant.githubRepo,
                remote: grant.remote,
                base: grant.base,
                head: branch,
                headSha,
                bodyHash: "",
                draft: grant.draft,
              },
              clock(),
            );
            const publication = store.publicationForRun(runId);
            if (publication !== null) {
              store.handle
                .prepare("UPDATE publication SET body_hash = ? WHERE id = ?")
                .run(bodyHashOf(publicationBody(store, publication)), intentId);
            }
          }
        }
        return { disowned: false };
      });
      store.clearQuota(runner, provider, model ?? "");
      if (sealed.disowned) return { kind: "disowned" };
      maybeRequestAutoReview(store, repo, runId, result.committed, result.noChange === true, clock());
      return { kind: "built", committed: result.committed, noChange: result.noChange === true };
    }
    if (policy === "standalone") {
      store.finishRun(runId, {
        outcome: result.noChange === true ? "no-change" : "built",
        ...(result.noChange === true ? { reason: "handoff" } : {}),
        committed: result.committed,
        now: clock(),
      });
      return { kind: "built", committed: result.committed, noChange: result.noChange === true };
    }
    if (leaseId === undefined) return { kind: "built-fenced" };
    // The completion has to be *accepted*, not assumed — one transaction
    // around the fenced release, the run's outcome, and the publication
    // intent, so "done" and "this must reach a PR" cannot come apart.
    const sealed = store.transact(() => {
      const fence = completeFenced(store, leaseId, "done", clock());
      if (!fence.ok) return fence;
      // The disowned arm (external dispatch, v4 §24): the tracker closed
      // this mirror while it was being built.
      if (fence.arm === "disowned") {
        store.finishRun(runId, { outcome: "failed", reason: "external-closed", committed: result.committed, now: clock() });
        store.enqueueNotification(
          {
            dedupeKey: `run:${runId}:external-closed`,
            kind: "external-closed",
            subject: `${taskId}: the tracker closed this while it was being built`,
            body: `The branch ${branch} is kept as evidence; nothing is published. Reopen the tracker item and \`standing-orders task reopen ${taskId}\` if the work should continue.`,
          },
          clock(),
        );
        return fence;
      }
      store.finishRun(runId, {
        outcome: result.noChange === true ? "no-change" : "built",
        ...(result.noChange === true ? { reason: "handoff" } : {}),
        committed: result.committed,
        now: clock(),
      });
      // A stated no-change publishes nothing.
      if (result.noChange !== true && result.committed) {
        const grant = store.publicationGrantFor(repo);
        const headSha = store.getRun(runId)?.headRevision ?? null;
        if (
          grant !== null &&
          headSha !== null &&
          branch.startsWith(grant.headPrefix) &&
          (grant.selector === "all" || origin === "ours")
        ) {
          const intentId = store.createPublicationIntent(
            {
              run: runId,
              taskRef,
              githubRepo: grant.githubRepo,
              remote: grant.remote,
              base: grant.base,
              head: branch,
              headSha,
              bodyHash: "",
              draft: grant.draft,
            },
            clock(),
          );
          // The body's identity is computed from the rows this very
          // transaction made durable — reproducible after any crash.
          const publication = store.publicationForRun(runId);
          if (publication !== null) {
            store.handle
              .prepare("UPDATE publication SET body_hash = ? WHERE id = ?")
              .run(bodyHashOf(publicationBody(store, publication)), intentId);
          }
        }
      }
      return fence;
    });
    if (sealed.ok && sealed.arm === "disowned") return { kind: "disowned" };
    if (sealed.ok) {
      // A concluded success ends the failure streak and its backoff — and
      // proves the credential, clearing any quota stamp.
      store.resetStrikes(taskRef);
      store.clearQuota(runner, provider, model ?? "");
      // The standalone road deliberately stays out: its historical shape
      // touches nothing beyond run records, and `task review` covers it.
      maybeRequestAutoReview(store, repo, runId, result.committed, result.noChange === true, clock());
      return { kind: "built", committed: result.committed, noChange: result.noChange === true };
    }
    store.transact(() => {
      store.finishRun(runId, { outcome: "failed", reason: "fenced", committed: result.committed, now: clock() });
      store.enqueueNotification(
        {
          dedupeKey: `run:${runId}:fenced`,
          kind: "build-fenced",
          subject: `${taskId}: completed, but the lease was gone`,
          body: `The commit exists on ${branch}, but the world moved past this lease before the completion was accepted. Look before anything reuses it.`,
        },
        clock(),
      );
    });
    return { kind: "built-fenced" };
  }

  // ---- refusals and failures -----------------------------------------------

  // THE ALREADY-SEALED ENDINGS (adaptive execution plans). Every other arm
  // below ends the attempt itself — releases the claim, writes the run's
  // outcome, counts what it costs. These two arrive with all of that
  // already done: `finalizeRevisionFenced` released the lease, appended the
  // ledger row, placed the hold when one was owed, finished the run, and
  // paged, all inside ONE fenced transaction — the planner road's shape,
  // where claim.ts owns the ending and dispose only reports it.
  //
  // So this branch exists to do NOTHING, deliberately, and it is placed
  // above the policy arms so that every road — tick, standalone, held,
  // continuation — skips them alike.
  //
  // Falling through instead would be wrong twice over. `release()` would
  // survive it (an already-released lease whose `released_by` is
  // 'released' reads as this same lease's duplicate hand-back, not a
  // fence), but `finishRun` overwrites unconditionally, so the sealed
  // `finished_at` would be restamped by a second, later writer; and the
  // bottom of the chain returns `invariant`, which means "the dispatcher
  // broke a rule it was supposed to uphold" — the opposite of what
  // happened here, where the machine worked exactly as designed.
  if (result.reason === "plan-revised" || result.reason === "plan-revision-blocked") {
    return { kind: "skipped", reason: result.reason as never };
  }

  if (policy === "continuation") {
    // The taskless failure (v4 Q7): the run says what happened, the claim
    // releases — NO strikes, NO holds, NO done→failed demotion; three
    // failed continuations still leave the parent exactly as it finished.
    const outcome = result.reason === "fenced" ? "refused" : "failed";
    store.finishRun(runId, { outcome, reason: result.reason, now: clock() });
    if (leaseId !== undefined) release(store, leaseId, clock());
    return { kind: "recorded", outcome };
  }

  if (policy === "standalone") {
    if (result.reason === "malformed-decision" && leaseId !== undefined) {
      const sealed = finalizeMalformedFenced(store, {
        leaseId,
        runId,
        taskId,
        problems: result.problems ?? [],
        now: clock(),
      });
      return { kind: "malformed", sealed: sealed.ok };
    }
    const outcome = STANDALONE_BROKE_REASONS.has(result.reason) ? "failed" : "refused";
    store.finishRun(runId, { outcome, reason: result.reason, now: clock() });
    return { kind: "recorded", outcome };
  }

  // The attended refusal family (v28 sweep): typed, no strike, release and
  // move on — the pre-claim gates make every one a rare race, and the
  // invariant arm they used to fall through is for BUGS, not races.
  if (
    result.reason === "attended-only" ||
    result.reason === "attended-held" ||
    result.reason === "stale-authorization" ||
    result.reason === "session-cap" ||
    result.reason === "run-held"
  ) {
    if (leaseId !== undefined) release(store, leaseId, clock());
    store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
    return { kind: "skipped", reason: result.reason as never };
  }

  if (result.reason === "unapproved" || result.reason === "scope-changed") {
    // Approval drifted between the prefilter and the builder's own gate.
    if (leaseId !== undefined) release(store, leaseId, clock());
    store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
    return { kind: "skipped", reason: result.reason };
  }

  if (result.reason === "fenced") {
    // The lease did not survive the build. Nothing is ours to release.
    store.finishRun(runId, { outcome: "refused", reason: "fenced", now: clock() });
    return { kind: "fenced" };
  }

  if (result.reason === "malformed-decision") {
    if (leaseId === undefined) return { kind: "malformed", sealed: false };
    const sealed = finalizeMalformedFenced(store, {
      leaseId,
      runId,
      taskId,
      problems: result.problems ?? [],
      now: clock(),
    });
    return { kind: "malformed", sealed: sealed.ok };
  }

  if (TICK_FAILURE_REASONS.has(result.reason)) {
    // One fenced transaction decides what the failure means. The
    // classification trusts only what the machine itself observed.
    const failureClass: FailureClass =
      result.reason === "agent-reported"
        ? "agent-reported"
        : result.reason === "no-op" || result.reason === "moved-head" || result.reason === "moved-branch"
          ? "no-op"
          : result.reason === "timeout" || result.reason === "git" || result.reason === "provider-init" || result.reason === "setup" || result.reason === "stopped" || result.reason === "provider-unattested" || result.reason === "provider-protocol"
            ? "retryable-infra"
            : result.reason === "commit-failure"
              ? "commit-failure"
              : "unknown";
    // The attempt's ending, in words, on the run itself: the class is what
    // the strikes count, the message is what a person reads (an agent's
    // own verdict was already recorded by the builder under the same key).
    if (result.reason !== "agent-reported" && result.message.trim() !== "") {
      store.recordOutcomeFacts(runId, { handoff: result.message });
    }
    if (leaseId === undefined) {
      store.finishRun(runId, { outcome: "failed", reason: result.reason, now: clock() });
      return { kind: "failed", failureClass, disposition: null, strikes: null, sealed: false };
    }
    const sealed = finalizeFailureFenced(store, {
      leaseId,
      runId,
      taskId,
      failureClass,
      message: result.message,
      worktree: worktreePath,
      now: clock(),
    });
    return {
      kind: "failed",
      failureClass,
      disposition: sealed.ok ? sealed.disposition : null,
      strikes: sealed.ok && "strikes" in sealed ? sealed.strikes : null,
      sealed: sealed.ok,
    };
  }

  // no-claim, not-yours, not-leased, protected-branch, wrong-branch:
  // invariants the dispatcher was supposed to uphold.
  if (leaseId !== undefined) release(store, leaseId, clock());
  store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
  if (result.reason === "stale-approval") {
    // A deterministic refusal (setup review): the approval no longer
    // matches the routing, and nothing about the next pass changes that.
    // Retrying every pass wrote a thousand refused runs in minutes. So:
    // release, record, HOLD the task under a backoff the approval door
    // lifts, and page once per approval — the operator re-approves (or
    // reconfigures the build agent) and the hold goes with the yes.
    if (leaseId !== undefined) release(store, leaseId, clock());
    store.finishRun(runId, { outcome: "refused", reason: "stale-approval", now: clock() });
    holdStaleApproval(store, { taskRef, taskId, message: result.message }, clock());
    return { kind: "skipped", reason: "stale-approval" as never };
  }

  return { kind: "invariant", reason: result.reason };
}

/**
 * The stale-approval HOLD, shared by the post-build disposition above and
 * the tick's pre-admission refusal (v48 integrity): a pre-routing row
 * whose sealed profile no longer matches what would resolve is refused
 * BEFORE any run row exists — held under the backoff the approval door
 * lifts, paged once per approval — so the fail-closed admission never
 * turns into a refusal every pass.
 */
export function holdStaleApproval(store: Store, args: { taskRef: number; taskId: string; message: string }, now: Date): void {
  const scope = store.getScope(args.taskId);
  store.holdOwned(
    {
      taskRef: args.taskRef,
      ownerKind: "backoff",
      ownerId: `stale:${args.taskRef}`,
      reason: "stale-approval — the approval no longer matches how builds are routed; approve the scope again on its page",
      until: new Date(now.getTime() + 6 * 60 * 60_000),
    },
    now,
  );
  store.enqueueNotification(
    {
      dedupeKey: `stale-approval:${args.taskRef}:${scope?.approvedDigest ?? "none"}`,
      kind: "stale-approval",
      pushClass: "attention",
      link: `/t/${encodeURIComponent(args.taskId)}`,
      subject: `${args.taskId}: its approval no longer matches the build routing — approve it again`,
      body: `${args.message}\nNothing runs on it until the scope is approved again; the hold lifts with the yes.`,
    },
    now,
  );
}

// ---- the bounded repair loop (v40, evidence-review-v1) --------------------

/** Whether a run's proof reasons name a LIE about the signed terms — an
 * altered criterion statement, or an overclaimed changed path — rather
 * than a gap in the work. The exact phrases `adjudicate()` uses for those
 * two rules, and no others; the integrity stop's own predicate. */
function isIntegrityRefutation(reasons: readonly string[]): boolean {
  return reasons.some(one => one.includes("was signed as") || one.includes("not in the sealed diff"));
}

/** Strict shrink: `to` is a proper subset of `from` — gnhf's no-progress
 * rule (docs/DESIGN.md:229), extended: an attempt that does not strictly
 * shrink the unresolved-criterion set counts as a failure. */
function strictlyShrunk(from: readonly string[], to: readonly string[]): boolean {
  if (to.length >= from.length) return false;
  const fromSet = new Set(from);
  return to.every(id => fromSet.has(id));
}

/** The public, envelope-documented name for each stop — distinct from the
 * store's own short `repair_chain.outcome` word (the DB enum is a
 * different namespace; these are the CLI/console-facing reason tokens,
 * registered in envelope.ts's DOCUMENTED_REASONS). */
export type RepairStopReason = "repair-attempts-spent" | "repair-no-progress" | "repair-refused-integrity";

/**
 * The chain's happy exit (v40): the instant one of its own attempts
 * reaches `verified` or `attested`, the chain is done. Checked at every
 * completed build's own verdict-save point — not only after a review —
 * since a review can never UPGRADE a verdict past what `adjudicate`
 * already found (foldReview's monotonicity), so only the structural save
 * can ever produce one of these two words.
 */
export function maybeSettleRepairChain(store: Store, taskId: string, verdict: ProofVerdict, now: Date): void {
  if (verdict !== "verified" && verdict !== "attested") return;
  const chain = store.repairChainForDraft(taskId);
  if (chain === null || chain.outcome !== "drafted") return;
  store.settleRepairChain(chain.id, "resolved", now);
}

export type RepairTrigger =
  | { kind: "drafted"; draftTaskId: string; attempt: number; approved: boolean }
  | { kind: "stopped"; reason: RepairStopReason }
  | { kind: "none" };

/**
 * The bounded repair loop's trigger (v40): fired after a review pass folds
 * at least one criterion judgement into a run's proof verdict. Composes at
 * most one durable revision draft naming exactly the unmet criterion ids,
 * inheriting the source scope and rubric verbatim — or settles the chain
 * at one of its four independent stops (integrity, no-progress, attempts
 * cap; the fourth — existing spend/run rails — is the ordinary tick's own
 * job once a mode-approved draft dispatches as a normal builder run).
 *
 * Never dispatches anything itself: a mode-authorized draft is
 * auto-APPROVED here, but still builds through the ordinary tick, under
 * the ordinary rails and strikes — this function only ever composes a
 * task and, at most, one scope approval.
 */
export function maybeTriggerRepair(store: Store, repo: string, evidenceRoot: string, sourceRunId: number, verdict: ProofVerdict, now: Date): RepairTrigger {
  if (verdict !== "short" && verdict !== "refuted") return { kind: "none" };
  // One attempt per source run, ever (source_run UNIQUE) — checked first so
  // a re-fired trigger is a silent no-op, never a duplicate.
  if (store.repairChainFor(sourceRunId) !== null) return { kind: "none" };

  const run = store.getRun(sourceRunId);
  if (run === null) return { kind: "none" };
  const stored = store.proofVerdictFor(sourceRunId);
  if (stored === null) return { kind: "none" };
  const unresolved = stored.matrix
    .filter(row => row.state === "missing" || row.state === "failed")
    .map(row => row.id)
    .sort();
  if (unresolved.length === 0) return { kind: "none" };

  const brief = store.refById(run.taskRef);
  const ref = brief === null ? null : store.lookupRef(brief.externalId);
  if (ref === null) return { kind: "none" };

  // Never repair: a scout task (a report, not a branch — nothing to build
  // back into).
  if (ref.deliverable === "report") return { kind: "none" };
  // Never repair: a run already published or holding a merge blocker.
  if (store.publicationForRun(sourceRunId) !== null) return { kind: "none" };
  // Never repair: a task with an open decision or a pending steering note.
  if (store.decisionsForTask(ref.id).some(d => d.state === "open" || d.state === "expired")) return { kind: "none" };
  if (store.pendingSteerCount(ref.id) > 0) return { kind: "none" };
  // Never repair: a run whose proof was already accepted.
  if (store.proofAcceptance(sourceRunId) !== null) return { kind: "none" };

  const task = store.getTask(ref.externalId);
  const scope = store.getScope(ref.externalId);
  if (task === null || scope === null) return { kind: "none" };

  const priorChain = store.repairChainForDraft(ref.externalId);
  const rootTask = priorChain?.rootTask ?? ref.externalId;
  const attempt = (priorChain?.attempt ?? 0) + 1;

  const mode = store.activeMode(repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  const auto = terms?.repairAuto === true;
  const basis: "human" | "mode" = auto ? "mode" : "human";
  const modeDigest = auto && mode !== null ? mode.digest : null;

  // THE INTEGRITY STOP (unconditional, both roads): a refutation that lies
  // about the signed terms is never handed back to the same machine
  // unattended — park for a human instead.
  if (isIntegrityRefutation(stored.reasons)) {
    if (priorChain === null) {
      store.recordRepairStop({ rootTask, sourceRun: sourceRunId, attempt, basis, modeDigest, unresolved, outcome: "integrity-refused" }, now);
    } else {
      store.settleRepairChain(priorChain.id, "integrity-refused", now);
    }
    return { kind: "stopped", reason: "repair-refused-integrity" };
  }

  // THE NO-PROGRESS STOP (unconditional, both roads): two consecutive
  // attempts that fail to strictly shrink the unresolved set.
  if (priorChain !== null) {
    const history = store.repairChainForRoot(rootTask).map(row => [...row.unresolved].sort());
    const sequence = [...history, unresolved];
    if (sequence.length >= 3) {
      const last = sequence[sequence.length - 1]!;
      const mid = sequence[sequence.length - 2]!;
      const first = sequence[sequence.length - 3]!;
      if (!strictlyShrunk(mid, last) && !strictlyShrunk(first, mid)) {
        store.settleRepairChain(priorChain.id, "no-progress", now);
        return { kind: "stopped", reason: "repair-no-progress" };
      }
    }
  }

  // THE ATTEMPT CAP: bounds only the AUTOMATIC road (a mode's signed
  // repairMaxAttempts) — the default road's loop is already bounded by
  // requiring a fresh human "yes" for every attempt.
  if (auto && terms !== null && attempt > terms.repairMaxAttempts) {
    if (priorChain !== null) store.settleRepairChain(priorChain.id, "attempts-spent", now);
    return { kind: "stopped", reason: "repair-attempts-spent" };
  }

  // THE DRAFT: no log content, no new instructions — exactly the unmet
  // ids, their matrix detail sentences, and the reviewer's own
  // contradiction notes.
  const contradictions = store.criterionReviewsFor(sourceRunId).filter(one => one.judgement === "contradicts");
  const unresolvedDetail = stored.matrix.filter(row => unresolved.includes(row.id)).map(row => ({ id: row.id, statement: row.statement, detail: row.detail }));
  const draftBrief = {
    schema: 1 as const,
    kind: "criterion-repair" as const,
    sourceTask: ref.externalId,
    sourceRun: sourceRunId,
    rootTask,
    attempt,
    unresolved: unresolvedDetail,
    reviewerContradictions: contradictions.map(one => ({ id: one.criterionId, author: one.author, note: one.note })),
  };
  const briefBytes = Buffer.from(JSON.stringify(draftBrief, null, 2), "utf8");
  const key = writeEvidenceFile(evidenceRoot, sourceRunId, `repair-brief-${sourceRunId}-${attempt}.json`, briefBytes);
  // Suffixes survive truncation (the CI-repair rule, verbatim): the prefix
  // gives way, the identity-bearing tail never does.
  const suffix = `-fix-${attempt}`;
  const draftId = `${rootTask.slice(0, 64 - suffix.length)}${suffix}`;
  const drafted = store.openRepairDraft(
    {
      task: {
        id: draftId,
        title: `repair ${ref.externalId}: ${unresolved.length} criteri${unresolved.length === 1 ? "on" : "a"} unmet`,
        repo,
        goal: `${scope.goal} — repair exactly the unmet criteria named below; a comment cannot widen the scope. Unmet: ${unresolved.join(", ")}.`,
        outOfScope: scope.outOfScope,
        touches: scope.touches,
        acceptance: scope.acceptance,
      },
      artifact: {
        run: sourceRunId,
        kind: "revision-brief",
        key,
        bytesOriginal: briefBytes.length,
        bytesStored: briefBytes.length,
        truncated: false,
        sha256: createHash("sha256").update(briefBytes).digest("hex"),
        capture: "machine-authored repair brief (exit 0)",
      },
      revisionOf: ref.externalId,
      sourceRun: sourceRunId,
      rootTask,
      attempt,
      basis,
      modeDigest,
      unresolved,
    },
    now,
  );
  if (!drafted.ok) return { kind: "none" };

  let approved = false;
  if (auto && mode !== null) {
    const draftScope = store.getScope(drafted.id);
    // A scope whose profile could not resolve is unapprovable by the human
    // road; the mode road refuses the same way — the draft stays honestly
    // unapproved rather than sealing an approval nobody could act on.
    if (draftScope?.profileState === "resolved") {
      approved = store.sealScopeApproval(drafted.id, `mode ${mode.name}`, now, {}, { kind: "mode", modeDigest: mode.digest });
    }
  }
  return { kind: "drafted", draftTaskId: drafted.id, attempt, approved };
}
