import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, approvalOf, authenticateApprover, digestOf, describeScope, profileDigestOf, profileFromJson, canonicalProfileJson, chainDigestOf, chainFromJson, canonicalChainJson } from "./scope.js";
import { routeDigestOf, routeFromJson } from "./phase-routing.js";
import { proveApprovedProfile } from "./builder.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");

/** The first approver bootstraps; every later one needs an existing one. */
function bootstrapApprover(store: Store): string {
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap should never be refused");
  return added.token;
}
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("agreeing what a task is allowed to become", () => {
  let store: Store;
  let approverToken: string;

  beforeEach(() => {
    store = openStore(":memory:");
    // v24: approvals bind exact routing, so the install names its default
    // model once — the same act `config set build --model sonnet` performs.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    approverToken = bootstrapApprover(store);
    store.createTask({ id: "t-1", title: "fix the payouts flow" }, T0);
  });

  afterEach(() => store.close());

  const scopeIt = (goal = "add a guard on the payout path") =>
    propose(store, { taskId: "t-1", goal, now: T0 });

  test("a fresh scope is not approved", () => {
    // Writing down what you intend is not the same as somebody agreeing to it.
    expect(approvalOf(scopeIt())).toEqual({ approved: false, reason: "none" });
  });

  test("a task with no scope at all is not approved either", () => {
    expect(approvalOf(null)).toEqual({ approved: false, reason: "never-proposed" });
  });

  test("a person can agree to it", () => {
    scopeIt();

    const approved = approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);

    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approvalOf(approved.scope)).toMatchObject({ approved: true, by: "alex" });
  });

  test("rewriting the scope takes the approval away", () => {
    // The loophole this closes: an agent that could edit its own brief after
    // approval would have approval for whatever it wrote next.
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);

    propose(store, { taskId: "t-1", goal: "rewrite the billing model", now: later(2_000) });

    expect(approvalOf(store.getScope("t-1"))).toEqual({ approved: false, reason: "changed" });
  });

  test("says it was approved before, rather than never", () => {
    // A more useful refusal: somebody did agree to something, and the thing
    // changed. "Never approved" would send them looking for the wrong problem.
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);
    propose(store, { taskId: "t-1", goal: "something else", now: later(2_000) });

    expect(describeScope(store.getScope("t-1")!).join("\n")).toContain("then the scope was rewritten");
  });

  test("re-approving the rewritten scope restores it", () => {
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);
    propose(store, { taskId: "t-1", goal: "something else", now: later(2_000) });

    approve(store, "t-1", "alex", later(3_000), store.getScope("t-1")!.digest, approverToken);

    expect(approvalOf(store.getScope("t-1")).approved).toBe(true);
  });

  test("refuses to approve a scope that moved while it was being read", () => {
    // The operator passes back the reference they were shown, so agreeing to
    // a scope that changed underneath them fails instead of approving the new
    // one silently.
    const first = scopeIt();
    propose(store, { taskId: "t-1", goal: "something else", now: later(1_000) });

    expect(approve(store, "t-1", "alex", later(2_000), first.digest, approverToken)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  test("approves when the reference still matches", () => {
    const scope = scopeIt();

    expect(approve(store, "t-1", "alex", later(1_000), scope.digest, approverToken).ok).toBe(true);
  });

  test("will not approve a task that has no scope", () => {
    expect(approve(store, "t-1", "alex", T0, "anything", approverToken)).toEqual({ ok: false, reason: "no-scope" });
  });

  describe("the digest", () => {
    test("changes when the goal changes", () => {
      const a = digestOf({ goal: "a", outOfScope: null, touches: [] });
      const b = digestOf({ goal: "b", outOfScope: null, touches: [] });

      expect(a).not.toBe(b);
    });

    test("changes when what is out of scope changes", () => {
      // This is the field most likely to be quietly widened, so it must move
      // the digest as surely as the goal does.
      const a = digestOf({ goal: "a", outOfScope: "not the billing model", touches: [] });
      const b = digestOf({ goal: "a", outOfScope: null, touches: [] });

      expect(a).not.toBe(b);
    });

    test("changes when the paths it may touch change", () => {
      const a = digestOf({ goal: "a", outOfScope: null, touches: ["src/pay.ts"] });
      const b = digestOf({ goal: "a", outOfScope: null, touches: ["src/pay.ts", "src/bill.ts"] });

      expect(a).not.toBe(b);
    });

    test("does not change for a reordering or stray whitespace", () => {
      // Otherwise an approval would evaporate over a formatting difference,
      // and operators would learn to re-approve without reading.
      const a = digestOf({ goal: "a", outOfScope: null, touches: ["b", "a"] });
      const b = digestOf({ goal: " a ", outOfScope: null, touches: ["a", "b"] });

      expect(a).toBe(b);
    });
  });
});

describe("who is allowed to say yes", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    // v24: approvals bind exact routing, so the install names its default
    // model once — the same act `config set build --model sonnet` performs.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
  });

  afterEach(() => store.close());

  const digest = () => store.getScope("t-1")!.digest;

  test("nothing can be approved until somebody is allowed to approve", () => {
    // Fails closed. Treating "no approvers registered" as "approval is not
    // required here" would make the whole gate optional, which is the same as
    // not having one.
    expect(approve(store, "t-1", "alex", T0, digest(), "any")).toEqual({
      ok: false,
      reason: "no-approvers",
    });
  });

  test("an approver with the right token can", () => {
    const token = bootstrapApprover(store);

    expect(approve(store, "t-1", "alex", T0, digest(), token).ok).toBe(true);
  });

  test("the first approver bootstraps, and no later one does", () => {
    // Somebody has to be able to create the first, and there is nobody to ask
    // yet. After that the credential would be worth nothing if an agent could
    // simply mint one for itself.
    const first = addApprover(store, "alex", T0);
    expect(first).toMatchObject({ ok: true, bootstrap: true });

    expect(addApprover(store, "an-agent", T0)).toEqual({ ok: false, reason: "not-an-approver" });
    expect(addApprover(store, "an-agent", T0, { name: "alex", token: "guessed" })).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });

  test("an existing approver can vouch for another", () => {
    const first = addApprover(store, "alex", T0);
    if (!first.ok) throw new Error("bootstrap failed");

    const second = addApprover(store, "sam", T0, { name: "alex", token: first.token });

    expect(second).toMatchObject({ ok: true, bootstrap: false });
  });

  test("knowing the digest is not enough", () => {
    // This is the gate's real threat: an agent that can run these commands can
    // read the digest straight out of `task show`. What it cannot do is hold a
    // credential nobody gave it.
    bootstrapApprover(store);

    expect(approve(store, "t-1", "alex", T0, digest(), "guessed")).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });

  test("being a runner is not being an approver", () => {
    // A credential that could both take work and approve it would collapse the
    // separation this exists for.
    bootstrapApprover(store);

    expect(approve(store, "t-1", "builder-1", T0, digest(), "anything")).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });
});

describe("a chosen password is a first-class credential", () => {
  test("add with --password: scrypt-stored, verifies, wrong is wrong, short refused", () => {
    const store = openStore(":memory:");
    try {
      const weak = addApprover(store, "alex", T0, undefined, undefined, {}, "short");
      expect(weak).toMatchObject({ ok: false, reason: "weak-password" });

      const added = addApprover(store, "alex", T0, undefined, undefined, {}, "hunter2hunter2");
      expect(added).toMatchObject({ ok: true, chosen: true });
      // Stored salted and stretched — never the bare digest of the password.
      expect(store.approverHash("alex")).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

      expect(authenticateApprover(store, "alex", "hunter2hunter2")).toMatchObject({ ok: true });
      expect(authenticateApprover(store, "alex", "hunter2hunter3")).toMatchObject({ ok: false });
    } finally {
      store.close();
    }
  });

  test("minted tokens and chosen passwords vouch and rotate interchangeably", () => {
    const store = openStore(":memory:");
    try {
      const first = addApprover(store, "alex", T0);
      if (!first.ok) throw new Error("bootstrap failed");

      // A minted-token approver vouches in a password approver…
      const second = addApprover(
        store, "sam", T0, { name: "alex", token: first.token }, undefined, {}, "correct-horse-battery",
      );
      expect(second).toMatchObject({ ok: true, chosen: true });

      // …and the password approver's credential vouches the other way.
      const third = addApprover(store, "kim", T0, { name: "sam", token: "correct-horse-battery" });
      expect(third).toMatchObject({ ok: true, chosen: false });

      // Rotating alex to a chosen password (self-vouched) still authenticates,
      // and the old minted token dies with the rotation.
      const rotated = addApprover(
        store, "alex", T0, { name: "alex", token: first.token }, undefined, {}, "a-new-chosen-one",
      );
      expect(rotated).toMatchObject({ ok: true, chosen: true });
      expect(authenticateApprover(store, "alex", "a-new-chosen-one")).toMatchObject({ ok: true });
      expect(authenticateApprover(store, "alex", first.token)).toMatchObject({ ok: false });
    } finally {
      store.close();
    }
  });

  test("the installation default never rewrites an approval, while a task override survives later scope rewrites", () => {
    const store = openStore(":memory:");
    try {
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
      store.createTask({ id: "t-1", title: "the work" }, T0);
      const approverToken = bootstrapApprover(store);
      const original = propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
      expect(approve(store, "t-1", "alex", T0, original.digest, approverToken)).toMatchObject({ ok: true });

      store.setPermissionDefault("bypassPermissions", "alex", later(1_000));
      const unchanged = store.getScope("t-1")!;
      expect(approvalOf(unchanged)).toMatchObject({ approved: true });
      expect(unchanged.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });

      const taskChoice = propose(store, {
        taskId: "t-1",
        goal: "a narrower guard",
        permissionMode: "auto",
        now: later(2_000),
      });
      expect(taskChoice.digest).not.toBe(original.digest);
      expect(store.refFor("built-in", "t-1").permissionMode).toBe("auto");

      // This is the planner/mate rewrite shape: it supplies new scope text but
      // no permission field. The durable task choice still wins over global.
      const rewritten = propose(store, { taskId: "t-1", goal: "the planner's guard", now: later(3_000) });
      expect(rewritten.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    } finally {
      store.close();
    }
  });
});

describe("execution profiles (foundations, findings 13/14/17/21)", () => {
  const claude = {
    provider: "claude" as const,
    model: "sonnet",
    permissionArgv: "acceptEdits" as const,
    maxTurns: 40,
    repairMaxTurns: 4,
    timeoutSeconds: 1800,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };
  const codex = {
    provider: "codex" as const,
    model: "gpt-5.2-codex",
    sandboxMode: "workspace-write" as const,
    maxTurns: "unsupported" as const,
    repairMaxTurns: "unsupported" as const,
    timeoutSeconds: 1200,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };
  const openrouter = { ...codex, provider: "openrouter" as const, model: "anthropic/claude-sonnet" };

  test("the legacy digest is BYTE-PINNED — v24 changed nothing behind old approvals", () => {
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] })).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] }, null)).toBe("a24c72e6603f78291e1eea2e162b383e");
  });

  test("profile digests are stable golden vectors, one per variant plus inherit", () => {
    // Pinned by value: if these move, an approval's meaning moved.
    expect(profileDigestOf(claude)).toBe(profileDigestOf({ ...claude }));
    expect(profileDigestOf(codex)).not.toBe(profileDigestOf(openrouter));
    expect(profileDigestOf({ ...claude, repairModel: "haiku" })).not.toBe(profileDigestOf(claude));
    // canonical: key order cannot matter
    const shuffled = JSON.parse(JSON.stringify(claude)) as typeof claude;
    expect(profileDigestOf(shuffled)).toBe(profileDigestOf(claude));
    // and the digest joins the scope digest deterministically
    const withProfile = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude);
    expect(withProfile).not.toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(withProfile).toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude));
    // The EXACT profile-bearing golden from the fallback design review —
    // pinned so a chain change can never silently move a legacy approval.
    expect(profileDigestOf(claude)).toBe("6df214084f95a74ed2694ecc45b2f043");
    expect(withProfile).toBe("6d7cc772f312c1295df747e243a49717");
  });

  test("fallback chains (v30): a chain digest is domain-separated and a chain-of-one is a DISTINCT explicit target", () => {
    const chain = [{ profile: claude, authMode: "subscription" as const }];
    // A chain digest can never collide with the single-profile digest.
    expect(chainDigestOf(chain)).not.toBe(profileDigestOf(claude));
    // Order is authority: reordering entries moves the digest.
    const two = [{ profile: claude, authMode: "subscription" as const }, { profile: codex, authMode: "api-key" as const }];
    const reversed = [two[1]!, two[0]!];
    expect(chainDigestOf(two)).not.toBe(chainDigestOf(reversed));
    // An explicit chain-of-one is a DIFFERENT scope digest than the same
    // single profile — it is an explicit chain, not a legacy profile.
    const asChain = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain });
    const asProfile = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude);
    expect(asChain).not.toBe(asProfile);
    // The no-profile golden is STILL untouched by any of this.
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] })).toBe("a24c72e6603f78291e1eea2e162b383e");
    // auth mode is bound: same profile, different mode => different digest.
    const subMode = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain: [{ profile: claude, authMode: "subscription" as const }] });
    const keyMode = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain: [{ profile: claude, authMode: "api-key" as const }] });
    expect(subMode).not.toBe(keyMode);
  });

  test("chainFromJson round-trips strictly; duplicates and bad shapes are null", () => {
    const chain = [{ profile: claude, authMode: "subscription" as const }, { profile: claude, authMode: "api-key" as const }];
    const json = canonicalChainJson(chain);
    const back = chainFromJson(json);
    expect(back).not.toBeNull();
    expect(back).toHaveLength(2);
    expect(back?.[0]?.authMode).toBe("subscription");
    expect(back?.[1]?.authMode).toBe("api-key");
    // Exact duplicate entry (same profile + same auth mode) => null.
    expect(chainFromJson(canonicalChainJson([{ profile: claude, authMode: "subscription" as const }, { profile: claude, authMode: "subscription" as const }]))).toBeNull();
    // Empty, over-length, wrong version, bad auth mode => null.
    expect(chainFromJson(canonicalChainJson([]))).toBeNull();
    expect(chainFromJson('{"digestVersion":1,"chain":[{"profile":{},"authMode":"nope"}]}')).toBeNull();
    expect(chainFromJson('{"digestVersion":99,"chain":[]}')).toBeNull();
    expect(chainFromJson("not json")).toBeNull();
  });

  test("snapshots round-trip strictly; anything malformed is null, never a guess", () => {
    for (const profile of [claude, codex, openrouter]) {
      expect(profileFromJson(canonicalProfileJson(profile))).toEqual(profile);
    }
    expect(profileFromJson(null)).toBeNull();
    expect(profileFromJson("not json")).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 1, profile: claude }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...claude, model: "" } }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...codex, maxTurns: 40 } }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...claude, provider: "gemini" } }))).toBeNull();
  });
});


describe("the gemini execution profile (Phase 3)", () => {
  const profile: import("./scope.js").ExecutionProfile = {
    provider: "gemini",
    model: "gemini-2.5-pro",
    approvalArgv: "auto_edit",
    maxTurns: "unsupported",
    repairMaxTurns: "unsupported",
    timeoutSeconds: 1200,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };

  test("snapshots roundtrip byte-stably through the digest chain", () => {
    const json = canonicalProfileJson(profile);
    const back = profileFromJson(json);
    expect(back).toEqual(profile);
    expect(profileDigestOf(back as ExecutionProfile)).toBe(profileDigestOf(profile));
  });

  test("rehydration is strict: a foreign approval dial or missing field is null, never a guess", () => {
    const loose = JSON.parse(canonicalProfileJson(profile)) as { profile: Record<string, unknown> };
    loose.profile["approvalArgv"] = "default";
    expect(profileFromJson(JSON.stringify(loose))).toBeNull();
    const missing = JSON.parse(canonicalProfileJson(profile)) as { profile: Record<string, unknown> };
    delete missing.profile["repairModel"];
    expect(profileFromJson(JSON.stringify(missing))).toBeNull();
  });

  test("yolo is a distinct signed byte — the digest moves", () => {
    expect(profileDigestOf({ ...profile, approvalArgv: "yolo" })).not.toBe(profileDigestOf(profile));
  });
});

describe("filing under a fallback chain (E3a): the digest binds it, the seal copies it", () => {
  let store: Store;
  const REPO = "/repos/chain";
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  });
  afterEach(() => store.close());

  const placeAndPropose = (id: string, goal: string) => {
    store.createTask({ id, title: goal }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal, now: T0 });
    return store.getScope(id)!;
  };

  test("no configured fallbacks: BYTE-IDENTICAL legacy filing — profile digest, no chain snapshot", () => {
    const scope = placeAndPropose("t-plain", "a guard");
    expect(scope.approvalKind).toBe("profile");
    expect(scope.proposedChainJson ?? null).toBeNull();
    // The digest is exactly the single-profile binding plus the exact
    // agent route every fresh row binds (v47).
    expect(scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, scope.profile ?? null, routeFromJson(scope.proposedRouteJson ?? null)),
    );
  });

  test("with fallbacks: the proposed digest binds the WHOLE chain and stores the working snapshot", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-chain", "a guard");
    expect(scope.proposedChainJson).not.toBeNull();
    // The stored snapshot re-hydrates strictly, base first.
    const chain = chainFromJson(scope.proposedChainJson!);
    expect(chain).not.toBeNull();
    expect(chain).toHaveLength(2);
    expect(chain![0]?.profile.provider).toBe("claude");
    expect(chain![1]?.profile.provider).toBe("gemini");
    // The digest binds that exact chain — and DIFFERS from the single-profile
    // binding a plain filing would carry.
    const route = routeFromJson(scope.proposedRouteJson ?? null);
    expect(scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, { chain: chain! }, route),
    );
    expect(scope.digest).not.toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, scope.profile ?? null, route),
    );
    // Not yet approved: the approved snapshot stays empty until the seal.
    expect(scope.approvedChainJson ?? null).toBeNull();
    expect(scope.approvalKind).toBe("profile");
  });

  test("the seal COPIES the working chain into the immutable approved snapshot — never re-resolves", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-seal", "a guard");
    const token = bootstrapApprover(store);
    expect(approve(store, "t-seal", "alex", T0, scope.digest, token).ok).toBe(true);
    const approved = store.getScope("t-seal")!;
    expect(approved.approvalKind).toBe("chain");
    // Byte-for-byte the working snapshot the signed digest bound.
    expect(approved.approvedChainJson).toBe(scope.proposedChainJson);
    // Mutating the config AFTER approval never moves the sealed snapshot.
    store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", later(1_000));
    expect(store.getScope("t-seal")!.approvedChainJson).toBe(scope.proposedChainJson);
  });

  test("the approval card SAYS the chain — every entry, credential included (Layer F)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-words", "a guard");
    const words = describeScope(scope).join("\n");
    expect(words).toContain("runs on      claude (sonnet) — your subscription");
    expect(words).toContain("falls back to gemini (gemini-2.5-pro) — your API key; spend moves to that account");
    // A plain scope says nothing about chains.
    const plain = placeAndPropose("t-words-plain", "a guard");
    store.clearFallbackConfig(REPO);
    propose(store, { taskId: "t-words-plain", goal: "a guard", now: later(1_000) });
    expect(describeScope(store.getScope("t-words-plain")!).join("\n")).not.toContain("falls back");
    void plain;
  });

  test("a configured chain that CANNOT file makes the scope visibly UNRESOLVED — never a silent single-profile approval (F+G finding 4)", () => {
    // The config road validates, but the store can be reached directly (or
    // the base can change after a valid set): a duplicate-of-base chain.
    store.setFallbackConfig(REPO, [{ provider: "claude", model: "sonnet", authMode: "subscription" }], "alex", T0);
    const scope = placeAndPropose("t-unfileable", "a guard");
    expect(scope.profileState).toBe("unresolved");
    expect(scope.unresolvedReason).toContain("fallback chain cannot file");
    expect(scope.proposedChainJson ?? null).toBeNull();
    // Unresolved blocks approval — the operator sees WHY instead of signing
    // something other than what they configured.
    const token = bootstrapApprover(store);
    expect(approve(store, "t-unfileable", "alex", T0, scope.digest, token)).toMatchObject({ ok: false, reason: "profile-unresolved" });
  });

  test("a re-approved plain scope re-seals to 'profile' — a stale chain can never survive a rewrite", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-rewrite", "a guard");
    const token = bootstrapApprover(store);
    expect(approve(store, "t-rewrite", "alex", T0, scope.digest, token).ok).toBe(true);
    expect(store.getScope("t-rewrite")!.approvalKind).toBe("chain");
    // The operator clears the fallbacks, then rewrites + re-approves the scope.
    store.clearFallbackConfig(REPO);
    propose(store, { taskId: "t-rewrite", goal: "a narrower guard", now: later(2_000) });
    const rewritten = store.getScope("t-rewrite")!;
    expect(rewritten.proposedChainJson ?? null).toBeNull();
    expect(approve(store, "t-rewrite", "alex", later(2_000), rewritten.digest, token).ok).toBe(true);
    const resealed = store.getScope("t-rewrite")!;
    expect(resealed.approvalKind).toBe("profile");
    expect(resealed.approvedChainJson ?? null).toBeNull();
  });
});

describe("the phase route is a signed term (v47): the digest binds it, the seal copies it, later changes stale it", () => {
  let store: Store;
  const REPO = "/repos/routed";
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "alex", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  const file = (id: string, options: { risk?: "routine" | "elevated" | "high"; qualityMode?: "default" | "strict" } = {}) => {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0, ...(options.risk === undefined ? {} : { riskLevel: options.risk }), ...(options.qualityMode === undefined ? {} : { qualityMode: options.qualityMode }) });
    return { ref, scope: store.getScope(id)! };
  };

  test("EVERY route binds into the digest — a routine-shaped one included — and the route drives the profile; a high-risk route selects the strong build agent", () => {
    const routine = file("t-routine");
    const routineRoute = routeFromJson(routine.scope.proposedRouteJson ?? null)!;
    expect(routine.scope.routeEra).toBe(1);
    expect(routineRoute.posture).toBe("economy");
    // Routine-shaped routes are signed terms too: the digest with the
    // route differs from the pre-v47 profile-only binding.
    expect(routine.scope.digest).toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: routine.scope.acceptance }, routine.scope.profile ?? null, routineRoute));
    expect(routine.scope.digest).not.toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: routine.scope.acceptance }, routine.scope.profile ?? null));
    expect(routine.scope.profile?.model).toBe("sonnet");
    expect(routine.scope.profile?.repairModel).toBe("inherit");
    // Every frozen leg is exact.
    expect(routineRoute.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
      ["plan", "claude", "sonnet"],
      ["build", "claude", "sonnet"],
      ["repair", "claude", "sonnet"],
      ["review", "claude", "sonnet"],
    ]);

    const risky = file("t-high", { risk: "high" });
    const riskyRoute = routeFromJson(risky.scope.proposedRouteJson ?? null)!;
    expect(risky.scope.riskLevel).toBe("high");
    // The strong tier drove the SEALED profile — route and profile agree.
    expect(risky.scope.profile?.model).toBe("opus");
    expect(riskyRoute.legs.find(one => one.phase === "build")).toMatchObject({ provider: "claude", model: "opus", tier: "strong" });
    // No strong repair row: repairs inherit the strong build model, exactly.
    expect(riskyRoute.legs.find(one => one.phase === "repair")).toMatchObject({ provider: "claude", model: "opus" });
    expect(risky.scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: risky.scope.acceptance }, risky.scope.profile ?? null, riskyRoute),
    );
    expect(risky.scope.digest).not.toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: risky.scope.acceptance }, risky.scope.profile ?? null),
    );
    const provenance = JSON.parse(String(store.raw().prepare("SELECT profile_provenance FROM task_scope WHERE task_id = 't-high'").get()?.["profile_provenance"])) as Record<string, unknown>;
    expect(provenance["resolvedFrom"]).toBe("route");
    expect(provenance["routeDigest"]).toBe(routeDigestOf(riskyRoute));
  });

  test("a configuration that cannot make an exact route files the scope UNRESOLVED with the words — nothing is guessed", () => {
    // The planner loses its model: the scope cannot say who plans.
    store.setPhaseConfig("installation", "plan", "claude", null, "alex", T0);
    const noPlan = file("t-noplan");
    expect(noPlan.scope.profileState).toBe("unresolved");
    expect(noPlan.scope.unresolvedReason).toContain("the planner (claude) has no exact model");
    expect(approve(store, "t-noplan", "alex", T0, noPlan.scope.digest, "tok-alex")).toMatchObject({ ok: false, reason: "profile-unresolved" });
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    // A cross-provider repair row is a stated problem on the route, and
    // the scope files unresolved rather than skipping the row.
    store.setPhaseConfig("installation", "repair", "codex", "gpt-5-codex", "alex", T0);
    const crossed = file("t-cross");
    expect(crossed.scope.profileState).toBe("unresolved");
    expect(crossed.scope.unresolvedReason).toContain("cross-provider repair does not exist");
    expect(routeFromJson(crossed.scope.proposedRouteJson ?? null)!.legs.find(one => one.phase === "repair")?.problem).toContain("cross-provider");
    store.clearPhaseConfig("installation", "repair");
    // A malformed override list on the task: unresolved, never "as if none".
    const { ref, scope } = file("t-badover");
    expect(scope.profileState).toBe("resolved");
    store.raw().prepare("UPDATE task_ref SET route_overrides_json = '[{\"phase\":\"build\"}]' WHERE id = ?").run(ref);
    const refiled = store.refileScope("t-badover", T0)!;
    expect(refiled.profileState).toBe("unresolved");
    expect(refiled.unresolvedReason).toContain("route overrides cannot be read");
  });

  test("approval seals the exact route bytes; a task-level route edit stales it; a global config change cannot rewrite the sealed route", () => {
    const { ref, scope } = file("t-seal", { risk: "elevated" });
    expect(store.approvedRouteOf("t-seal")).toBeNull();
    expect(approve(store, "t-seal", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    const sealed = store.getScope("t-seal")!;
    expect(sealed.approvedRouteJson).toBe(sealed.proposedRouteJson);
    const approvedRoute = store.approvedRouteOf("t-seal");
    expect(approvedRoute).not.toBeNull();
    expect(approvedRoute!.legs.find(one => one.phase === "review")).toMatchObject({ provider: "codex", model: "gpt-5-codex", tier: "strong" });
    const sealedDigest = routeDigestOf(approvedRoute!);

    // Global configuration moves: the strong reviewer changes. The sealed
    // route does not — and neither does the approval.
    store.setPhaseTierConfig("installation", "review", "strong", "claude", "opus", "alex", T0);
    expect(approvalOf(store.getScope("t-seal")!).approved).toBe(true);
    expect(routeDigestOf(store.approvedRouteOf("t-seal")!)).toBe(sealedDigest);

    // A task-level override re-files the scope in ONE transaction: the
    // digest moves, the approval is stale, and the sealed route no longer
    // governs.
    const set = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "opus" }, expectDigest: sealed.digest }, new Date(T0.getTime() + 1_000));
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.staled).toBe(true);
    const refiled = set.scope!;
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
    expect(store.approvedRouteOf("t-seal")).toBeNull();
    expect(routeFromJson(refiled.proposedRouteJson ?? null)!.legs.find(one => one.phase === "review")).toMatchObject({ provider: "claude", model: "opus", chosen: "override" });
    // The old snapshot is kept as history until a fresh yes re-seals.
    expect(refiled.approvedRouteJson).toBe(sealed.approvedRouteJson);
    // Re-approving seals the new route.
    expect(approve(store, "t-seal", "alex", T0, refiled.digest, "tok-alex").ok).toBe(true);
    expect(store.approvedRouteOf("t-seal")!.overrides).toHaveLength(1);
  });

  test("a risk change stales the approval exactly as a goal edit does — even from routine to elevated", () => {
    const { ref, scope } = file("t-risk");
    expect(approve(store, "t-risk", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    // The digest-CAS: an edit made against a digest the editor never saw
    // is refused; null means "I saw no scope" and is not the same as a digest.
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: "0".repeat(32) }, T0)).toMatchObject({ ok: false, reason: "changed" });
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: null }, T0)).toMatchObject({ ok: false, reason: "changed" });
    expect(store.getScope("t-risk")!.riskLevel).toBe("routine");
    // An editor who is no longer an approver changes nothing either.
    expect(store.editTaskRoute(ref, { by: "mallory", authenticate: () => ({ ok: false, reason: "not-an-approver" }), risk: "elevated" }, T0)).toMatchObject({ ok: false, reason: "unauthenticated" });
    const edited = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: scope.digest }, T0);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const refiled = edited.scope!;
    expect(refiled.riskLevel).toBe("elevated");
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
    // The words in the approval card say the route and its reasons.
    const words = describeScope(refiled);
    expect(words).toContain("  risk         elevated");
    expect(words.some(line => line.includes("review codex · gpt-5-codex  [recommended · strong]"))).toBe(true);
    expect(words.some(line => line.includes("risk is elevated — the review runs on the strongest configured reviewer"))).toBe(true);
  });

  test("the seal refuses a routed row whose working profile and route disagree, or whose route is gone — nothing is approved that cannot be restated exactly", () => {
    const { scope } = file("t-belt");
    // The working profile drifts from the route (a corrupt row): no seal.
    store.raw().prepare("UPDATE task_scope SET profile_json = REPLACE(profile_json, '\"model\":\"sonnet\"', '\"model\":\"haiku\"') WHERE task_id = 't-belt'").run();
    expect(store.sealScopeApproval("t-belt", "alex", T0)).toBe(false);
    expect(approvalOf(store.getScope("t-belt")!).approved).toBe(false);
    store.raw().prepare("UPDATE task_scope SET profile_json = REPLACE(profile_json, '\"model\":\"haiku\"', '\"model\":\"sonnet\"') WHERE task_id = 't-belt'").run();
    // The route removed from a routed row: no seal either.
    const kept = store.getScope("t-belt")!.proposedRouteJson;
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL WHERE task_id = 't-belt'").run();
    expect(store.sealScopeApproval("t-belt", "alex", T0)).toBe(false);
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-belt'").run(kept);
    // Restored: the exact seal lands, copying the route.
    expect(approve(store, "t-belt", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    expect(store.getScope("t-belt")!.approvedRouteJson).toBe(kept);
    expect(store.sealedRouteOf("t-belt").ok).toBe(true);
  });

  test("a tampered approved route snapshot no longer proves — the seal is the digest, not the column", () => {
    const { scope } = file("t-tamper", { risk: "high" });
    expect(approve(store, "t-tamper", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    expect(store.approvedRouteOf("t-tamper")).not.toBeNull();
    store.raw().prepare("UPDATE task_scope SET approved_route_json = REPLACE(approved_route_json, '\"risk\":\"high\"', '\"risk\":\"elevated\"') WHERE task_id = 't-tamper'").run();
    expect(store.approvedRouteOf("t-tamper")).toBeNull();
    expect(proveApprovedProfile(store.getScope("t-tamper"), null, { provider: "claude", model: "opus", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false })).toMatchObject({ ok: false });
  });

  test("route edits are refused under a live claim", () => {
    const { ref } = file("t-live");
    register(store, { name: "r", host: "h", repos: [REPO], now: T0, newToken: () => "tok-r" });
    store.saveScope({ ...store.getScope("t-live")!, approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: store.getScope("t-live")!.digest });
    const taken = acquire(store, ref, "r", { token: "tok-r", now: T0 });
    expect(taken.ok).toBe(true);
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "high" }, T0)).toMatchObject({ ok: false, reason: "live-claim" });
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "codex", model: "gpt-5" } }, T0)).toMatchObject({ ok: false, reason: "live-claim" });
  });

  test("a plan override becomes the planner pin and re-requests a drafted plan — one transaction, no half-updated authority", () => {
    const { ref } = file("t-plan");
    store.setPlanPins(ref, "codex", "gpt-5", T0);
    store.setPlanState(ref, "drafted");
    const edited = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "plan", provider: "claude", model: "opus" } }, T0);
    expect(edited).toMatchObject({ ok: true, replanned: true });
    const after = store.refForId(ref)!;
    expect(after).toMatchObject({ planProvider: "claude", planModel: "opus", plan: "requested" });
    expect(routeFromJson(store.getScope("t-plan")!.proposedRouteJson ?? null)!.legs[0]).toMatchObject({ phase: "plan", provider: "claude", model: "opus" });
    // Clearing the override clears the pin with it.
    const cleared = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "plan", clear: true } }, T0);
    expect(cleared.ok).toBe(true);
    expect(store.refForId(ref)).toMatchObject({ planProvider: null, planModel: null });
    expect(routeFromJson(store.getScope("t-plan")!.proposedRouteJson ?? null)!.legs[0]).toMatchObject({ phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" });
  });
});
