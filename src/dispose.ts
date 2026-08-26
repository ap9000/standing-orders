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

import {
  completeFenced,
  finalizeFailureFenced,
  finalizeMalformedFenced,
  finalizeParkFenced,
  release,
  type FailureClass,
} from "./claim.js";
import { bodyHashOf, publicationBody } from "./publish.js";
import type { BuildResult } from "./builder.js";
import type { Store } from "./store.js";

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
  return { kind: "invariant", reason: result.reason };
}
