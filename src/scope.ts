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

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import type { Store, Mutation } from "./store.js";

/** Same shape as a runner's credential, for the same reasons. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A person's chosen password gets a real KDF. Bare sha256 is fine for the
 * minted 256-bit tokens — nothing brute-forces that space — but a password a
 * human picked lives in a much smaller one, so it is salted and stretched
 * (scrypt), and the stored string names its own scheme so both generations
 * of credential verify side by side.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Verify a presented secret against a stored hash of either scheme. */
export function verifyCredential(stored: string, presented: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, salt, hex] = stored.split("$");
    if (salt === undefined || hex === undefined) return false;
    const known = Buffer.from(hex, "hex");
    const candidate = scryptSync(presented, salt, 32);
    return known.length === candidate.length && timingSafeEqual(known, candidate);
  }
  return sameDigest(stored, hashToken(presented));
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The execution profile (Parity II foundations, findings 1/2/13/14/22):
 * WHAT RUNS, bound into what the operator signs. A discriminated union —
 * each variant asserts only what its provider actually supports, with the
 * EFFECTIVE constants the argv will carry, never aspirations. The model
 * is always an exact string and always emitted on the argv: nothing in an
 * approved profile is left for later resolution to decide (ruling 10).
 * providerVersion and resolvedFrom are PROVENANCE and live outside these
 * shapes (finding 20) — they never enter a digest.
 */
export const CLAUDE_LIMITS = {
  maxTurns: 40,
  repairMaxTurns: 4,
  timeoutSeconds: 1800,
  repairTimeoutSeconds: 300,
} as const;
export const CODEX_SHAPED_LIMITS = {
  timeoutSeconds: 1200,
  repairTimeoutSeconds: 300,
} as const;

export type ClaudeProfile = {
  provider: "claude";
  /** The exact model string the argv carries. Never empty, never "default". */
  model: string;
  /** Claude's real argv semantic: --permission-mode acceptEdits, or the
   * separate --dangerously-skip-permissions flag. Phase 1 files
   * acceptEdits ONLY (finding 22); bypass arrives with the attended
   * authorization work. */
  permissionArgv: "acceptEdits" | "bypassPermissions";
  maxTurns: number;
  repairMaxTurns: number;
  timeoutSeconds: number;
  repairTimeoutSeconds: number;
  /** Exact model for repairs, or the stable literal "inherit" (= the
   * build model, which is itself exact). */
  repairModel: string;
};

export type CodexShapedProfile = {
  provider: "codex" | "openrouter";
  model: string;
  /** Codex's real constraint surface: the sandbox argument. There is no
   * separate permission argument, so no invented field. */
  sandboxMode: "workspace-write";
  /** The tool has no turn limit; the wall clock is the bound. Stored as
   * the literal so the approval words can say so honestly. */
  maxTurns: "unsupported";
  repairMaxTurns: "unsupported";
  timeoutSeconds: number;
  repairTimeoutSeconds: number;
  repairModel: string;
};

export type ExecutionProfile = ClaudeProfile | CodexShapedProfile;

export const PROFILE_DIGEST_VERSION = 2;

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The stored snapshot bytes: version embedded IN the snapshot (finding 17). */
export function canonicalProfileJson(profile: ExecutionProfile): string {
  return canonicalJson({ digestVersion: PROFILE_DIGEST_VERSION, profile });
}

/** sha256 over a domain-separated canonical encoding, truncated to the
 * same 128 bits every other safety digest here uses (finding 21). */
export function profileDigestOf(profile: ExecutionProfile): string {
  return createHash("sha256")
    .update(`standing-orders:profile:${canonicalProfileJson(profile)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Strict re-hydration of a stored snapshot — every field type-proved;
 * anything unexpected is null, never a guess. */
export function profileFromJson(json: string | null): ExecutionProfile | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const wrapper = parsed as { digestVersion?: unknown; profile?: unknown };
  if (wrapper.digestVersion !== PROFILE_DIGEST_VERSION) return null;
  const p = wrapper.profile as Record<string, unknown> | null | undefined;
  if (p === null || p === undefined || typeof p !== "object") return null;
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (p["provider"] === "claude") {
    if (
      str(p["model"]) &&
      (p["permissionArgv"] === "acceptEdits" || p["permissionArgv"] === "bypassPermissions") &&
      num(p["maxTurns"]) && num(p["repairMaxTurns"]) &&
      num(p["timeoutSeconds"]) && num(p["repairTimeoutSeconds"]) &&
      str(p["repairModel"])
    ) {
      return {
        provider: "claude",
        model: p["model"],
        permissionArgv: p["permissionArgv"],
        maxTurns: p["maxTurns"],
        repairMaxTurns: p["repairMaxTurns"],
        timeoutSeconds: p["timeoutSeconds"],
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  if (p["provider"] === "codex" || p["provider"] === "openrouter") {
    if (
      str(p["model"]) &&
      p["sandboxMode"] === "workspace-write" &&
      p["maxTurns"] === "unsupported" && p["repairMaxTurns"] === "unsupported" &&
      num(p["timeoutSeconds"]) && num(p["repairTimeoutSeconds"]) &&
      str(p["repairModel"])
    ) {
      return {
        provider: p["provider"],
        model: p["model"],
        sandboxMode: "workspace-write",
        maxTurns: "unsupported",
        repairMaxTurns: "unsupported",
        timeoutSeconds: p["timeoutSeconds"],
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  return null;
}

export type Scope = {
  taskId: string;
  /** What success looks like, in the operator's words. */
  goal: string;
  /** What this task is explicitly not allowed to turn into. */
  outOfScope: string | null;
  /** Paths the work is expected to touch. Advisory, and worth stating. */
  touches: string[];
  /** The dollar cap per build attempt, integer micro-dollars (v15) —
   * approved spend, restated at the yes, enforced by the provider's own
   * stop. NULL = no per-attempt cap was asked for. */
  budgetMicrousd: number | null;
  proposedAt: string;
  /** Of the scope as written. Approval is bound to this exact value. */
  digest: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** The digest that was actually agreed to, which may now be stale. */
  approvedDigest: string | null;
  /** v24 (optional so hand-built scopes in tests stay valid): the working
   * execution profile, its resolution state, and the immutable snapshot
   * the approval act sealed. */
  profile?: ExecutionProfile | null;
  profileState?: "resolved" | "unresolved";
  unresolvedReason?: string | null;
  approvedProfile?: ExecutionProfile | null;
  digestVersion?: number;
};

export type Approval =
  | { approved: true; at: string; by: string }
  | { approved: false; reason: "none" | "changed" | "never-proposed" };

export type ScopeInput = {
  taskId: string;
  goal: string;
  outOfScope?: string | null;
  touches?: readonly string[];
  /** v24: an EXPLICIT profile skips resolution in the store (routine
   * firings and the demo's illustrative scopes use this road). */
  profile?: ExecutionProfile;
  /** Integer micro-dollars per build attempt; digest-bound when present. */
  budgetMicrousd?: number | null;
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
export function digestOf(
  scope: Pick<Scope, "goal" | "outOfScope" | "touches"> & { budgetMicrousd?: number | null },
  profile?: ExecutionProfile | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: scope.goal.trim(),
        outOfScope: scope.outOfScope?.trim() ?? null,
        touches: [...scope.touches].sort(),
        // Absent and null digest identically, so every pre-v15 approval
        // stays exactly as approved.
        ...(scope.budgetMicrousd == null ? {} : { budget: scope.budgetMicrousd }),
        // Same discipline for the execution profile (v24): absent and null
        // are byte-identical with history — the legacy golden test pins
        // this. A profile enters by ITS digest, so the scope digest binds
        // routing/permissions/limits without re-serializing them here.
        ...(profile == null ? {} : { profileDigest: profileDigestOf(profile) }),
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
  const { taskId, goal, outOfScope = null, touches = [], budgetMicrousd = null, now, mutation = {}, profile } = input;

  const draft = { goal, outOfScope, touches: [...touches], budgetMicrousd };
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

  store.saveScope(scope, mutation, profile === undefined ? {} : { profile });
  // The store may have RECOMPUTED the digest to bind the resolved profile
  // (v24 filing invariant) — what callers display must be what is stored.
  return store.getScope(taskId) ?? scope;
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
  | { ok: true; name: string; token: string; bootstrap: boolean; chosen: boolean }
  | { ok: false; reason: "not-an-approver" | "weak-password" };

export function addApprover(
  store: Store,
  name: string,
  now: Date,
  by?: { name: string; token: string },
  newToken: () => string = mintToken,
  mutation: Mutation = {},
  /** A password the person chose. Absent, a token is minted and shown once. */
  password?: string,
): AddApproverResult {
  if (password !== undefined && password.length < 8) {
    return { ok: false, reason: "weak-password" };
  }
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
    if (vouching === null || !verifyCredential(vouching, by?.token ?? "")) {
      return { ok: false, reason: "not-an-approver" };
    }
  }

  if (password !== undefined) {
    store.saveApprover(name, hashPassword(password), now, mutation);
    return { ok: true, name, token: password, bootstrap, chosen: true };
  }
  const token = newToken();
  store.saveApprover(name, hashToken(token), now, mutation);
  return { ok: true, name, token, bootstrap, chosen: false };
}

export type ApproveResult =
  | { ok: true; scope: Scope }
  | { ok: false; reason: "no-scope" | "changed" | "no-approvers" | "not-an-approver" | "profile-unresolved" };

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
  if (known === null || !verifyCredential(known, token)) {
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

    // An unresolved scope cannot say exactly what would run, so nobody can
    // agree to it (foundations finding 16) — restatement is the road.
    if (scope.profileState === "unresolved") {
      return { ok: false as const, reason: "profile-unresolved" as const };
    }

    // SEAL, never re-resolve: the approval snapshots the stored working
    // profile — the exact bytes the digest the approver signed was bound
    // to. Routing saveScope here would re-run resolution and could sign a
    // profile nobody saw.
    const sealed = store.sealScopeApproval(taskId, by, now, mutation);
    if (!sealed) return { ok: false as const, reason: "changed" as const };
    const approved = store.getScope(taskId);
    if (approved === null) return { ok: false as const, reason: "no-scope" as const };
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
    ...(scope.budgetMicrousd === null
      ? []
      : [`  budget       $${(scope.budgetMicrousd / 1_000_000).toFixed(2)} per build attempt — the agent is stopped at this figure`]),
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

// ---- attended authorization terms (Parity II Phase 2E, ruling 12) ----------

/**
 * EVERY rendered term of one watched attempt — what the form shows is what
 * the password signs, byte for byte. The subset the dispatch proof
 * re-derives (scopeDigest, profileDigest, profileJson, repo, head) is read
 * back by the builder and the coordinator; the rest are the product terms
 * the ceremony renders in words: the budget as a STOP THRESHOLD, the turn
 * cap, the per-turn clock whose expiry is SESSION-FATAL, and the absolute
 * expiry. Continuation carries the parent attempt and the follow-up text
 * INSIDE the signed terms (v3 R7).
 */
export type AttendedTerms = {
  taskId: string;
  scopeDigest: string;
  profileDigest: string;
  profileJson: string;
  repo: string;
  runner: string;
  runnerGeneration: number;
  head: string;
  maxSessionTurns: number;
  budgetMicrousd: number;
  turnTimeoutSeconds: number;
  absoluteExpiry: string;
  parentRun?: number | null;
  followup?: string | null;
};

/** Deterministic bytes: sorted keys, undefined dropped — the signed text. */
export function attendedTermsJson(terms: AttendedTerms): string {
  return canonicalJson(terms);
}

/** The composite digest one password signs (ruling 12), domain-separated. */
export function attendedDigestOf(terms: AttendedTerms): string {
  return createHash("sha256")
    .update(`standing-orders:attended:${attendedTermsJson(terms)}`)
    .digest("hex")
    .slice(0, 32);
}
