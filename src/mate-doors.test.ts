import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { credentialKeyOf } from "./converse.js";
import { confirmMateProposal, dismissMateProposal } from "./mate-doors.js";

const T0 = new Date("2026-09-02T12:00:00.000Z");
const REPO = "/repo/doors";
const CREDENTIAL = credentialKeyOf("anthropic-api", "sk-test");

describe("the mate's confirm doors (mate arc, ruling 7; slice-2 review)", () => {
  let store: Store;
  let who: VerifiedApprover;
  let clockAt = T0.getTime();
  const clock = () => new Date(clockAt);

  const principal = (): VerifiedApprover => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const session = (expiresInMs = 3_600_000) =>
    store.mintMateSession({ approver: "alex", approverGeneration: who.generation, credentialKey: CREDENTIAL, ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64), expiresAt: new Date(clockAt + expiresInMs) }, clock());
  /** An answered turn holding one pending proposal of the given kind. */
  const pending = (kind: "next" | "reserve" | "hold" | "answer", payload: Record<string, unknown>): number => {
    const thread = store.openMateThread("alex", who.ceilingDigest, clock()).thread;
    const live = store.activeMateSession("alex", clock())!;
    const opened = store.openMateTurn({ approver: "alex", session: live.id, thread: thread.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, clock());
    if (!started.ok) throw new Error("start");
    const id = store.draftMateProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, clock());
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1 }, clock());
    return id;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    clockAt = T0.getTime();
    store.saveApprover("root", "r".repeat(64), T0);
    store.saveApprover("alex", "h".repeat(64), T0);
    who = principal();
    for (const id of ["a", "b", "c"]) {
      const filed = fileTaskProposal(store, { id, title: `task ${id}`, repo: REPO, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    }
  });
  afterEach(() => store.close());

  test("a card outlives its session: an expired session refuses the confirm although the cookie's principal still stands", () => {
    session(1_000);
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    clockAt += 5_000;
    expect(confirmMateProposal(store, who, id, clock())).toMatchObject({ ok: false, reason: "session-ended" });
    expect(store.getMateProposal(id)?.state).toBe("pending");
    expect(store.queuePosition("c")?.position).toBe(3);
  });

  test("a credential rotation ends the session, deletes the thread's proposals, and the old principal is dead", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    store.saveApprover("alex", "n".repeat(64), clock());
    expect(store.activeMateSession("alex", clock())).toBeNull();
    expect(store.getMateProposal(id)).toBeNull();
    expect(confirmMateProposal(store, who, id, clock())).toMatchObject({ ok: false, reason: "standing" });
    // The new generation mints its own principal and finds nothing to confirm.
    const fresh = principal();
    expect(fresh.generation).toBe(who.generation + 1);
    expect(confirmMateProposal(store, fresh, id, clock())).toMatchObject({ ok: false, reason: "not-yours" });
  });

  test("the place the mate saw is part of the CAS: a neighbour leaving the queue refuses a stale next", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    // `b` is cancelled — no queue move, no revision bump, but c is now 2 of 2.
    expect(store.cancelTask("b", clock())).toMatchObject({ ok: true });
    expect(store.queueRevision()).toBe(seen.queueRevision);
    expect(store.queuePosition("c")?.position).toBe(2);
    expect(confirmMateProposal(store, who, id, clock())).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getMateProposal(id)?.state).toBe("refused");
  });

  test("a hold card confirms as the operator's own hold, once; a second confirm and a dismiss both answer in words", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    expect(confirmMateProposal(store, who, id, clock())).toMatchObject({ ok: true, said: "a held: wait" });
    expect(store.activeHolds(store.refFor("built-in", "a").id, clock()).map(one => one.reason)).toEqual(["wait"]);
    expect(confirmMateProposal(store, who, id, clock())).toMatchObject({ ok: false, reason: "not-pending" });
    expect(dismissMateProposal(store, who, id, clock())).toBe(false);
    // A hand-placed hold after the proposal: the stale card must not overwrite it.
    const again = pending("hold", { task: "b", reason: "model text", sawHold: null });
    store.hold(store.refFor("built-in", "b").id, "by hand", null, clock());
    expect(confirmMateProposal(store, who, again, clock())).toMatchObject({ ok: false, reason: "stale" });
    expect(store.activeHolds(store.refFor("built-in", "b").id, clock()).map(one => one.reason)).toEqual(["by hand"]);
  });

  test("an answer card answers the decision as the operator; an irreversible option needs the explicit field; an answered decision refuses", () => {
    session();
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "Which?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }, { id: "y", label: "Y", consequence: "cy", reversible: false }], recommendation: "x" },
      T0,
    );
    const irreversible = pending("answer", { decision: 1, task: "a", option: "y", optionLabel: "Y", reversible: false, rationale: "because" });
    expect(confirmMateProposal(store, who, irreversible, clock())).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(irreversible)?.state).toBe("pending");
    expect(store.getDecision(1)?.state).toBe("open");
    expect(confirmMateProposal(store, who, irreversible, clock(), { confirm: true, via: "cli" })).toMatchObject({ ok: true, said: "decision #1 answered: Y", taskId: "a" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "cli" });
    const late = pending("answer", { decision: 1, task: "a", option: "x", optionLabel: "X", reversible: true, rationale: "too late" });
    expect(confirmMateProposal(store, who, late, clock())).toMatchObject({ ok: false, reason: "already-answered" });
  });

  test("a structural principal never confirms", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    const copy = { ...who } as unknown as VerifiedApprover;
    expect(confirmMateProposal(store, copy, id, clock())).toMatchObject({ ok: false, reason: "standing" });
    expect(store.getMateProposal(id)?.state).toBe("pending");
  });
});
