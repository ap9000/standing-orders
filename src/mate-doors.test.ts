import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { credentialKeyOf } from "./converse.js";
import { confirmMateProposal, dismissMateProposal } from "./mate-doors.js";
import { executeMateTool } from "./mate-tools.js";
import { approve, approvalOf, hashToken, propose } from "./scope.js";
import { routeDigestOf } from "./phase-routing.js";

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
  const session = () =>
    store.mintMateSession({ approver: "alex", approverGeneration: who.generation, credentialKey: CREDENTIAL, ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, clock());
  /** An answered turn holding one pending proposal of the given kind. */
  const pending = (kind: "task" | "next" | "reserve" | "hold" | "steer" | "answer" | "repair" | "agents", payload: Record<string, unknown>): number => {
    const thread = store.openMateThread("alex", who.ceilingDigest, clock()).thread;
    const live = store.activeMateSession("alex")!;
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

  test("an explicitly ended conversation refuses an old card although the principal still stands", () => {
    const sessionId = session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    store.endMateSession(sessionId, "alex", clock());
    expect(confirmMateProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "session-ended" });
    expect(store.getMateProposal(id)?.state).toBe("pending");
    expect(store.queuePosition("c")?.position).toBe(3);
  });

  test("a credential rotation ends the session, deletes the thread's proposals, and the old principal is dead", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    store.saveApprover("alex", "n".repeat(64), clock());
    expect(store.activeMateSession("alex")).toBeNull();
    expect(store.getMateProposal(id)).toBeNull();
    expect(confirmMateProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "standing" });
    // The new generation mints its own principal and finds nothing to confirm.
    const fresh = principal();
    expect(fresh.generation).toBe(who.generation + 1);
    expect(confirmMateProposal(store, fresh, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "not-yours" });
  });

  test("the place the mate saw is part of the CAS: a neighbour leaving the queue refuses a stale next", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    // `b` is cancelled — no queue move, no revision bump, but c is now 2 of 2.
    expect(store.cancelTask("b", clock())).toMatchObject({ ok: true });
    expect(store.queueRevision()).toBe(seen.queueRevision);
    expect(store.queuePosition("c")?.position).toBe(2);
    expect(confirmMateProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getMateProposal(id)?.state).toBe("refused");
  });

  test("a hold card confirms as the operator's own hold, once; a second confirm and a dismiss both answer in words", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    expect(confirmMateProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: true, said: "a held: wait" });
    expect(store.activeHolds(store.refFor("built-in", "a").id, clock()).map(one => one.reason)).toEqual(["wait"]);
    expect(confirmMateProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "not-pending" });
    expect(dismissMateProposal(store, who, id, clock())).toBe(false);
    // A hand-placed hold after the proposal: the stale card must not overwrite it.
    const again = pending("hold", { task: "b", reason: "model text", sawHold: null });
    store.hold(store.refFor("built-in", "b").id, "by hand", null, clock());
    expect(confirmMateProposal(store, who, again, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.activeHolds(store.refFor("built-in", "b").id, clock()).map(one => one.reason)).toEqual(["by hand"]);
  });

  test("a confirmed intake card honors plan-first instead of pretending its draft is ready to approve", () => {
    session();
    const id = pending("task", {
      repo: REPO,
      repoId: "r1",
      title: "Modernize the whole navigation",
      goal: "Make navigation coherent across desktop and mobile.",
      not: null,
      touches: [],
      acceptance: [{ id: "c1", statement: "Navigation works coherently at desktop and mobile widths.", evidence: ["screenshot"] }],
      planning: "required",
      report: false,
    });
    const outcome = confirmMateProposal(store, who, id, clock(), { via: "web" });
    expect(outcome).toMatchObject({
      ok: true,
      said: expect.stringContaining("the planner is reading the project before you approve anything"),
      taskId: expect.any(String),
    });
    if (!outcome.ok || outcome.taskId === null) throw new Error("task was not filed");
    expect(store.lookupRef(outcome.taskId)?.plan).toBe("requested");
    expect(store.getScope(outcome.taskId)?.approvedAt).toBeNull();
  });

  test("a steering card becomes verified guidance for the next attempt only after confirmation", () => {
    session();
    const id = pending("steer", { task: "a", taskTitle: "task a", note: "Start with the mobile flow." });
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toEqual([]);
    expect(confirmMateProposal(store, who, id, clock(), { via: "web" })).toMatchObject({
      ok: true,
      said: "Guidance saved for task a's next attempt",
      taskId: "a",
    });
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toMatchObject([
      { author: "alex", authorshipState: "verified", note: "Start with the mobile flow.", deliveredAt: null },
    ]);
  });

  test("dependency repair cards retry, atomically replace, unlink, and refuse stale graph state", () => {
    session();
    store.setTaskState("a", "failed", clock());
    store.addEdge("b", "a");
    const retry = pending("repair", { task: "b", blocker: "a", operation: "retry", sawBlockerState: "failed" });
    expect(confirmMateProposal(store, who, retry, clock(), { via: "web" })).toMatchObject({ ok: true, said: expect.stringContaining("queued again") });
    expect(store.getTask("a")?.state).toBe("queued");
    expect(store.blockers("b")).toEqual(["a"]);

    store.setTaskState("a", "cancelled", clock());
    const replace = pending("repair", { task: "b", blocker: "a", operation: "replace", replacement: "c", sawBlockerState: "cancelled" });
    expect(confirmMateProposal(store, who, replace, clock(), { via: "web" })).toMatchObject({ ok: true, said: "b will now wait for c instead of a" });
    expect(store.blockers("b")).toEqual(["c"]);

    store.setTaskState("c", "cancelled", clock());
    const unlink = pending("repair", { task: "b", blocker: "c", operation: "unlink", sawBlockerState: "cancelled" });
    expect(confirmMateProposal(store, who, unlink, clock(), { via: "web" })).toMatchObject({ ok: true, said: "b can now continue without c" });
    expect(store.blockers("b")).toEqual([]);

    store.addEdge("b", "a");
    const stale = pending("repair", { task: "b", blocker: "a", operation: "unlink", sawBlockerState: "cancelled" });
    store.removeEdge("b", "a");
    expect(confirmMateProposal(store, who, stale, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.blockers("b")).toEqual([]);
  });

  test("an answer card answers the decision as the operator; an irreversible option needs the explicit field; an answered decision refuses", () => {
    session();
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "Which?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }, { id: "y", label: "Y", consequence: "cy", reversible: false }], recommendation: "x" },
      T0,
    );
    const irreversible = pending("answer", { decision: 1, task: "a", option: "y", optionLabel: "Y", reversible: false, rationale: "because" });
    expect(confirmMateProposal(store, who, irreversible, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(irreversible)?.state).toBe("pending");
    expect(store.getDecision(1)?.state).toBe("open");
    expect(confirmMateProposal(store, who, irreversible, clock(), { confirm: true, via: "cli" })).toMatchObject({ ok: true, said: "decision #1 answered: Y", taskId: "a" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "cli" });
    const late = pending("answer", { decision: 1, task: "a", option: "x", optionLabel: "X", reversible: true, rationale: "too late" });
    expect(confirmMateProposal(store, who, late, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "already-answered" });
    // The SAME choice landing first elsewhere is not this card's answer either (v3 review, finding 5).
    const run2 = store.startRun({ taskRef: store.refFor("built-in", "b").id, leaseId: "l2", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store.saveDecision({ run: run2, urgency: "blocking", recap: "r", question: "Again?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }], recommendation: "x" }, T0);
    const same = pending("answer", { decision: 2, task: "b", option: "x", optionLabel: "X", reversible: true, rationale: "x" });
    store.answerDecision({ id: 2, choice: "x", by: "root", via: "cli" }, clock());
    expect(confirmMateProposal(store, who, same, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "already-answered" });
    expect(store.getDecision(2)).toMatchObject({ answeredBy: "root", answeredVia: "cli" });
    // A decision past its deadline is not "open" for a card, swept or not (finding 7).
    const run3 = store.startRun({ taskRef: store.refFor("built-in", "c").id, leaseId: "l3", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store.saveDecision({ run: run3, urgency: "blocking", recap: "r", question: "Late?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }], recommendation: "x", deadline: new Date(clockAt + 60_000).toISOString() }, T0);
    const timed = pending("answer", { decision: 3, task: "c", option: "x", optionLabel: "X", reversible: true, rationale: "x" });
    clockAt += 120_000;
    expect(confirmMateProposal(store, who, timed, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getDecision(3)?.state).toBe("open");
  });

  test("chat-steer: get_agents reads risk and agents in the route's own words; propose_agents drafts only a configured, role-valid choice; the confirmed card changes the agents through the authenticated route edit and stales the approval", () => {
    // A routed installation: everyday and strong agents named once, in configuration.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "ops", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "ops", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "ops", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "ops", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "gemini", "gemini-2.5-pro", "ops", T0);
    store.setPhaseTierConfig("installation", "plan", "strong", "codex", "gpt-5", "ops", T0);
    // alex's real password, so the approval ceremony below can run.
    store.saveApprover("alex", hashToken("alex-password"), T0);
    who = principal();
    propose(store, { taskId: "a", goal: "Harden the payouts flow", acceptance: [{ id: "c1", statement: "Payouts never double-send", how: null, evidence: ["check"] }], now: T0 });
    session();
    const ctx = { store, who, now: clock(), draft: (kind: string, payload: Record<string, unknown>) => pending(kind as "agents", payload), step: 1, readDecisions: new Map<number, number>() };
    const read = executeMateTool(ctx, "get_agents", { task: "a" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const body = read.body as Record<string, unknown>;
    expect(body).toMatchObject({
      task: "a",
      risk: { level: "routine", title: "Routine", consequence: expect.stringContaining("everyday configured agent") },
      standing: "awaiting approval",
      summary: "claude · sonnet plans, builds, repairs, and reviews",
      editable: true,
      approval: "not approved",
    });
    expect((body["riskChoices"] as { risk: string; consequence: string }[]).map(one => one.risk)).toEqual(["routine", "elevated", "high"]);
    expect((body["agents"] as { role: string; provider: string; reasons: string[] }[]).map(one => one.role)).toEqual(["planner", "builder", "repair", "reviewer"]);
    const choices = body["choices"] as Record<string, { provider: string; model: string; current: boolean }[]>;
    // Only configured pairs; gemini never reviews; repair stays on the build provider.
    expect(choices["reviewer"]).toEqual([{ provider: "claude", model: "sonnet", current: true }, { provider: "codex", model: "gpt-5", current: false }, { provider: "codex", model: "gpt-5-codex", current: false }]);
    expect(choices["reviewer"].some(one => one.provider === "gemini")).toBe(false);
    expect(choices["builder"]).toEqual(expect.arrayContaining([{ provider: "gemini", model: "gemini-2.5-pro", current: false }]));
    expect(choices["repair"]).toEqual([{ provider: "claude", model: "sonnet", current: true }]);
    expect(choices["builder"]).toEqual(expect.arrayContaining([{ provider: "codex", model: "gpt-5", current: false }]));
    // An unlisted agent is refused, naming the choices; so is a no-op.
    expect(executeMateTool(ctx, "propose_agents", { task: "a", role: "reviewer", agent: { provider: "claude", model: "opus" } })).toMatchObject({ ok: false, message: expect.stringContaining("one of the reviewer choices") });
    expect(executeMateTool(ctx, "propose_agents", { task: "a", role: "reviewer", agent: { provider: "gemini", model: "gemini-2.5-pro" } })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_agents", { task: "a", role: "reviewer", agent: { provider: "claude", model: "sonnet" } })).toMatchObject({ ok: false, message: expect.stringContaining("already runs") });
    expect(executeMateTool(ctx, "propose_agents", { task: "a", risk: "routine" })).toMatchObject({ ok: false, message: expect.stringContaining("already declared") });
    expect(executeMateTool(ctx, "propose_agents", { task: "a", role: "reviewer", clear: true })).toMatchObject({ ok: false, message: expect.stringContaining("nothing to clear") });
    // Approve the scope as it stands, then propose a real change.
    const first = store.getScope("a")!;
    expect(approve(store, "a", "alex", T0, first.digest, "alex-password").ok).toBe(true);
    const sealedBefore = store.approvedRouteOf("a")!;
    // A card naming an agent that is no longer configured refuses — even
    // with the right digest — and the approval stands untouched.
    store.clearPhaseTierConfig("installation", "plan", "strong");
    const gone = pending("agents", { task: "a", phase: "build", role: "builder", provider: "codex", model: "gpt-5", sawDigest: first.digest });
    expect(confirmMateProposal(store, who, gone, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale", said: expect.stringContaining("no longer one of the configured agents") });
    expect(approvalOf(store.getScope("a")!).approved).toBe(true);
    const proposed = executeMateTool({ ...ctx, now: clock() }, "propose_agents", { task: "a", risk: "high", role: "reviewer", agent: { provider: "codex", model: "gpt-5-codex" }, why: "payouts move money" });
    expect(proposed).toMatchObject({ ok: true, body: { kind: "agents", task: "a", risk: "high", role: "reviewer", agent: { provider: "codex", model: "gpt-5-codex" }, awaiting: expect.stringContaining("renewing") } });
    if (!proposed.ok) return;
    const id = (proposed.body as { proposal: number }).proposal;
    expect(store.getMateProposal(id)?.payload).toMatchObject({ task: "a", risk: "high", phase: "review", role: "reviewer", provider: "codex", model: "gpt-5-codex", sawDigest: first.digest, approval: "approved" });
    // Confirmed: the ONE authenticated route edit — recorded as the
    // operator, the approval staled, the sealed route gone.
    const outcome = confirmMateProposal(store, who, id, clock(), { via: "web" });
    expect(outcome).toMatchObject({ ok: true, kind: "agents", taskId: "a", said: expect.stringContaining("risk is now high risk; the reviewer is now codex · gpt-5-codex — the earlier approval no longer covers this task; approve it again") });
    const ref = store.refFor("built-in", "a");
    expect(ref.riskLevel).toBe("high");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "review", provider: "codex", model: "gpt-5-codex", by: "alex" })]);
    const after = store.getScope("a")!;
    expect(approvalOf(after)).toMatchObject({ approved: false, reason: "changed" });
    expect(store.approvedRouteOf("a")).toBeNull();
    expect(routeDigestOf(sealedBefore)).not.toBe(after.proposedRouteJson === null ? "" : routeDigestOf(JSON.parse(after.proposedRouteJson!) as never));
    // A stale card — drafted against the earlier digest — refuses; nothing moves again.
    const stale = pending("agents", { task: "a", phase: "review", role: "reviewer", provider: "claude", model: "sonnet", sawDigest: first.digest });
    expect(confirmMateProposal(store, who, stale, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.refFor("built-in", "a").routeOverrides).toHaveLength(1);
    // Clearing the hand-picked reviewer restores the recommendation.
    const clear = executeMateTool({ ...ctx, now: clock() }, "propose_agents", { task: "a", role: "reviewer", clear: true });
    expect(clear).toMatchObject({ ok: true, body: { role: "reviewer", clear: true } });
    if (!clear.ok) return;
    expect(confirmMateProposal(store, who, (clear.body as { proposal: number }).proposal, clock(), { via: "web" })).toMatchObject({ ok: true, said: expect.stringContaining("the reviewer choice was cleared") });
    expect(store.refFor("built-in", "a").routeOverrides).toEqual([]);
  });

  test("a structural principal never confirms", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    const copy = { ...who } as unknown as VerifiedApprover;
    expect(confirmMateProposal(store, copy, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "standing" });
    expect(store.getMateProposal(id)?.state).toBe("pending");
  });
});
