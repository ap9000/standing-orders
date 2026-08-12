import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, approvalOf, digestOf, describeScope } from "./scope.js";

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
