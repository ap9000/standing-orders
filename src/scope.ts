/**
 * What a task is allowed to become, agreed before anything builds it.
 *
 * The gap this closes is the one an operator notices immediately and a
 * scheduler never does: a task called "fix the payouts flow" is a sentence, and
 * an agent handed it at 3am will decide for itself what that means. It might
 * mean a two-line guard. It might mean rewriting the billing model. Nobody
 * agreed to the second one, and by morning it is a diff.
 *
 * So a scope is written down, and a human opts in to it, and the builder will
 * not run on a task where that has not happened. Not a code review after the
 * fact — an agreement about the goal, before the work.
 *
 * **Approval binds to the words that were approved.** The record keeps a digest
 * of the scope text, and approval stores the digest it saw. Rewriting the scope
 * afterwards does not carry the approval with it; the digests stop matching and
 * the task is unapproved again. Without that, "approved" would mean "was
 * approved once, in some form" — which is exactly the loophole an agent editing
 * its own brief would walk through.
 *
 * The scope is deliberately three plain fields rather than a template. What is
 * the goal, what is explicitly not in it, and which paths it expects to touch.
 * An operator reading that at a glance can tell whether they agree, and that
 * glance is the whole safety property.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import type { Store, Mutation } from "./store.js";

/** Same shape as a runner's credential, for the same reasons. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Scope = {
  taskId: string;
  /** What success looks like, in the operator's words. */
  goal: string;
  /** What this task is explicitly not allowed to turn into. */
  outOfScope: string | null;
  /** Paths the work is expected to touch. Advisory, and worth stating. */
  touches: string[];
  proposedAt: string;
  /** Of the scope as written. Approval is bound to this exact value. */
  digest: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** The digest that was actually agreed to, which may now be stale. */
  approvedDigest: string | null;
};

export type Approval =
  | { approved: true; at: string; by: string }
  | { approved: false; reason: "none" | "changed" | "never-proposed" };

export type ScopeInput = {
  taskId: string;
  goal: string;
  outOfScope?: string | null;
  touches?: readonly string[];
  now: Date;
  mutation?: Mutation;
};

/**
 * The exact bytes an operator agreed to.
 *
 * Every field that constrains the work goes in. If a change to a field would
 * change what an operator would have said, it has to move the digest, or the
 * approval it invalidates would be an approval of something else.
 */
export function digestOf(scope: Pick<Scope, "goal" | "outOfScope" | "touches">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: scope.goal.trim(),
        outOfScope: scope.outOfScope?.trim() ?? null,
        touches: [...scope.touches].sort(),
      }),
      "utf8",
    )
    .digest("hex")
    // 128 bits. This is a safety token binding an approval to exact content,
    // so it has to be well past the reach of a deliberate collision search —
    // 64 bits is not, and the only cost of the longer one is a longer thing to
    // paste back.
    .slice(0, 32);
}

export function propose(store: Store, input: ScopeInput): Scope {
  const { taskId, goal, outOfScope = null, touches = [], now, mutation = {} } = input;

  const draft = { goal, outOfScope, touches: [...touches] };
  const previous = store.getScope(taskId);

  const scope: Scope = {
    taskId,
    ...draft,
    proposedAt: now.toISOString(),
    digest: digestOf(draft),
    // The previous approval is kept rather than cleared, and is invalidated by
    // the digest no longer matching. Same safety — `approvalOf` requires them
    // equal — but it preserves the fact that somebody once agreed to
    // something, so the refusal can say "this was approved and then rewritten"
    // instead of the much less useful "this was never approved".
    approvedAt: previous?.approvedAt ?? null,
    approvedBy: previous?.approvedBy ?? null,
    approvedDigest: previous?.approvedDigest ?? null,
  };

  store.saveScope(scope, mutation);
  return scope;
}

export type GuardedProposeResult =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      reason: "changed" | "claimed" | "bad-goal" | "bad-out-of-scope" | "bad-touches";
    };

/**
 * A scope edit from a surface where the editor might be stale — two browser
 * tabs, a form submitted after the world moved. `sawDigest` names the version
 * the editor was looking at (null: they saw no scope at all); a mismatch is a
 * refusal, never a silent overwrite of somebody else's words. Edits are also
 * refused while a live claim holds the task: the running build read its scope
 * at start, and rewording the agreement under it would make the digest lie
 * about what the work was agreed to. Field caps and control-character rules
 * live here because every one of these strings will later be rendered.
 */
export function proposeGuarded(
  store: Store,
  input: ScopeInput & { sawDigest: string | null; taskRef: number | null },
): GuardedProposeResult {
  const goal = input.goal.trim();
  if (goal === "" || goal.length > 2_000 || hasForbiddenControls(goal)) {
    return { ok: false, reason: "bad-goal" };
  }
  const outOfScope = input.outOfScope?.trim() || null;
  if (outOfScope !== null && (outOfScope.length > 2_000 || hasForbiddenControls(outOfScope))) {
    return { ok: false, reason: "bad-out-of-scope" };
  }
  const touches = [...(input.touches ?? [])].map(one => one.trim()).filter(one => one !== "");
  if (touches.length > 50 || touches.some(one => one.length > 200 || hasForbiddenControls(one))) {
    return { ok: false, reason: "bad-touches" };
  }

  return store.transact(() => {
    if (input.taskRef !== null && store.hasLiveClaim(input.taskRef, input.now)) {
      return { ok: false as const, reason: "claimed" as const };
    }
    const previous = store.getScope(input.taskId);
    if ((previous?.digest ?? null) !== input.sawDigest) {
      return { ok: false as const, reason: "changed" as const };
    }
    const scope = propose(store, { ...input, goal, outOfScope, touches });
    return { ok: true as const, scope };
  });
}

/**
 * A person says yes.
 *
 * Takes the digest they were shown, so agreeing to a scope that changed while
 * they were reading it fails rather than silently approving the new one.
 */
/**
 * Register somebody who is allowed to agree to scopes.
 *
 * The token is shown once and stored only as a hash, exactly like a runner's.
 * It exists because an approval nobody has to authenticate is not a gate: an
 * agent that can run these commands can read a scope's digest out of `task
 * show` and approve its own brief with it. Requiring a credential the agent
 * was never given is what keeps "a person agreed to this" true.
 */
export type AddApproverResult =
  | { ok: true; name: string; token: string; bootstrap: boolean }
  | { ok: false; reason: "not-an-approver" };

export function addApprover(
  store: Store,
  name: string,
  now: Date,
  by?: { name: string; token: string },
  newToken: () => string = mintToken,
  mutation: Mutation = {},
): AddApproverResult {
  // The first one bootstraps, because somebody has to be able to create the
  // first one and there is nobody to ask yet. Every one after it has to be
  // vouched for by an existing approver.
  //
  // Without that second rule the credential is worth nothing: an agent that
  // can run these commands would simply mint an approver for itself and
  // approve its own scope with it. The bootstrap window is real and is why
  // this is the first thing an operator should do, before anything else can
  // reach the queue.
  const existing = store.listApprovers();
  const bootstrap = existing.length === 0;

  if (!bootstrap) {
    const vouching = by === undefined ? null : store.approverHash(by.name);
    if (vouching === null || !sameDigest(vouching, hashToken(by?.token ?? ""))) {
      return { ok: false, reason: "not-an-approver" };
    }
  }

  const token = newToken();
  store.saveApprover(name, hashToken(token), now, mutation);
  return { ok: true, name, token, bootstrap };
}

export type ApproveResult =
  | { ok: true; scope: Scope }
  | { ok: false; reason: "no-scope" | "changed" | "no-approvers" | "not-an-approver" };

/**
 * Whether this name-and-token pair is a person the store knows. Shared by
 * every act that requires a human's authority — approving a scope, answering
 * a decision — because "who said yes" must never be a string the caller
 * typed. Fails closed: with no approver registered there is nobody who can
 * agree to anything, and treating that as "authority is not required here"
 * would make the gate optional — which is the same as not having one.
 */
export function authenticateApprover(
  store: Store,
  by: string,
  token: string,
): { ok: true } | { ok: false; reason: "no-approvers" | "not-an-approver" } {
  if (store.listApprovers().length === 0) return { ok: false, reason: "no-approvers" };
  const known = store.approverHash(by);
  if (known === null || !sameDigest(known, hashToken(token))) {
    return { ok: false, reason: "not-an-approver" };
  }
  return { ok: true };
}

export function approve(
  store: Store,
  taskId: string,
  by: string,
  now: Date,
  sawDigest: string,
  token: string,
  mutation: Mutation = {},
): ApproveResult {
  // Read and write in one transaction, re-reading inside it — the credential
  // check included, so a token rotated between authentication and the write
  // cannot leave an approval signed by an authority that no longer exists.
  // Apart, a scope rewritten between the read and the write is overwritten by
  // this approval — which would resurrect the old wording *and* mark it
  // agreed, the precise opposite of what the digest is for.
  return store.transact(() => {
    const authenticated = authenticateApprover(store, by, token);
    if (!authenticated.ok) return authenticated;

    const scope = store.getScope(taskId);
    if (scope === null) return { ok: false as const, reason: "no-scope" as const };

    // The digest is required, not optional. An operator reads a scope, somebody
    // rewrites it, and an approval that did not name what it saw would agree to
    // the new one in silence — which is the whole failure this guards.
    if (sawDigest !== scope.digest) return { ok: false as const, reason: "changed" as const };

    const approved: Scope = {
      ...scope,
      approvedAt: now.toISOString(),
      approvedBy: by,
      approvedDigest: scope.digest,
    };
    store.saveScope(approved, mutation);
    return { ok: true as const, scope: approved };
  });
}

/**
 * Whether this task may be built.
 *
 * `changed` is the interesting answer and the reason the digest exists: the
 * scope was approved, and then somebody — possibly an agent, possibly the
 * operator, possibly a different session — rewrote it. The old yes does not
 * transfer.
 */
export function approvalOf(scope: Scope | null): Approval {
  if (scope === null) return { approved: false, reason: "never-proposed" };
  if (scope.approvedAt === null || scope.approvedBy === null) {
    return { approved: false, reason: "none" };
  }
  if (scope.approvedDigest !== scope.digest) return { approved: false, reason: "changed" };
  return { approved: true, at: scope.approvedAt, by: scope.approvedBy };
}

/** The scope, in the words an operator has to be able to agree or disagree with. */
export function describeScope(scope: Scope): string[] {
  const approval = approvalOf(scope);
  return [
    `  goal         ${scope.goal}`,
    ...(scope.outOfScope === null ? [] : [`  not this     ${scope.outOfScope}`]),
    ...(scope.touches.length === 0 ? [] : [`  touches      ${scope.touches.join(", ")}`]),
    `  reference    ${scope.digest}`,
    `  approved     ${describeApproval(approval)}`,
  ];
}

function describeApproval(approval: Approval): string {
  if (approval.approved) return `yes, by ${approval.by} at ${approval.at}`;
  if (approval.reason === "changed") {
    return "no — it was approved, then the scope was rewritten; approve it again";
  }
  return "no — nothing will build this until somebody agrees to it";
}
