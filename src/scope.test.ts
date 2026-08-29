import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, approvalOf, authenticateApprover, digestOf, describeScope, profileDigestOf, profileFromJson, canonicalProfileJson, chainDigestOf, chainFromJson, canonicalChainJson } from "./scope.js";

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
