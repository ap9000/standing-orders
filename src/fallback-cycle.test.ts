/**
 * Layer E1: the fenced fallback-cycle state machine, exhaustively. Every
 * transition is a CAS proving the exact from-state, generation, and (where
 * it matters) cursor + tail run; the crash-window proof from the design
 * holds because no alternate authority exists until the transition commits,
 * the single-use admission cannot be replayed, and the (cycle, from_index)
 * uniqueness backstops a double advance.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, chainFromJson, chainDigestOf, entryDigestOf } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import * as routing from "./phase-routing.js";

// The production exhaustion module ships NO recognizer-mutation surface
// (Codex E2/E3 review, finding 1) — so the suite proves the ELIGIBLE path by
// MOCKING recognizesEligible here. The mock is controllable per test and
// defaults empty (fail closed); everything else in the module stays real.
const rec = vi.hoisted(() => ({ eligible: new Set<string>() }));
vi.mock("./exhaustion.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./exhaustion.js")>();
  return {
    ...actual,
    recognizesEligible: (provider: string, version: string | null, authMode: string) =>
      version !== null && rec.eligible.has(`${provider}:${version}:${authMode}`),
  };
});

const T0 = new Date("2026-08-29T12:00:00.000Z");

/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so every routed row here presents the sealed (or,
 * for a fallback entry, the bound) leg exactly as the tick would. Absent
 * authority presents nothing — and the admission says so. */
const presented = (
  store: Store,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  bound: { index: number; entryDigest: string } | null = null,
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = store.routeAuthorityFor(taskRef, role, bound);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

/** The admission arguments for the approved chain's entry at `index`,
 * stated exactly as the approved chain has them (the proof re-derives all of
 * it; a fixture may override one fact to prove the refusal). */
const entryArgs = (store: Store, taskId: string, index: number) => {
  const chain = store.approvedChainOf(taskId);
  if (chain === null) throw new Error("no approved chain");
  const entry = chain[index];
  if (entry === undefined) throw new Error(`no entry ${index}`);
  const sealed = store.sealedRouteOf(taskId);
  const { routeDigestOf } = routing;
  return {
    entryDigest: entryDigestOf(entry),
    authMode: entry.authMode,
    repairModel: entry.profile.repairModel === "inherit" ? entry.profile.model : entry.profile.repairModel,
    provider: entry.profile.provider,
    model: entry.profile.model,
    route: { routeDigest: sealed.ok ? routeDigestOf(sealed.route) : `chain:${chainDigestOf(chain)}`, phase: "build" as const, provider: entry.profile.provider, model: entry.profile.model, chosen: "fallback" as const },
  };
};

describe("the fallback cycle state machine", () => {
  let store: Store;
  let taskRef: number;
  let baseRun: number;
  /** The approved chain's digest — the only chain a cycle may open under. */
  let chainDigest: string;

  const openRun = (n: number) =>
    store.startRun({ taskRef, leaseId: `l-${n}`, runner: "b-1", branch: `b${n}`, worktree: `/w${n}`, provider: "claude", now: T0, ...presented(store, taskRef) });
  /** Entry 1 of the approved chain, as admitFallback must be told it. */
  const entry1 = () => entryArgs(store, "t-1", 1);

  beforeEach(() => {
    store = openStore(":memory:");
    // A REAL chain approval (v48 authority repair): admission proves the task, the approved
    // chain, the entry's digest, auth mode, provider, model, and repair
    // model against durable state — a synthetic digest admits nothing.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setFallbackConfig("/repos/chain", [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }, { provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, "/repos/chain");
    propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
    expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, added.token).ok).toBe(true);
    chainDigest = chainDigestOf(store.approvedChainOf("t-1")!);
    baseRun = openRun(0);
  });
  afterEach(() => store.close());

  test("the happy walk: open -> sanitizing -> awaiting-release -> pending-admission -> open at i+1", () => {
    const opened = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const cycleId = opened.id;
    let c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: baseRun, transitionGeneration: 0 });

    // Exhaustion of the base run begins the sanitizer.
    expect(store.beginFallbackSanitize(cycleId, 0, baseRun, T0)).toBe(true);
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "sanitizing", transitionGeneration: 1 });

    // The one-step advance: cursor 0 -> 1, a durable transition.
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv).toMatchObject({ ok: true, toIndex: 1 });
    if (!adv.ok) return;
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "awaiting-release", cursor: 1, transitionGeneration: 2 });

    // Custody release -> pending-admission (tail cleared).
    expect(store.releaseFallbackToPending(cycleId, 2, T0)).toBe(true);
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "pending-admission", tailRun: null, transitionGeneration: 3 });

    // Single-use admission CREATES the next run atomically, bound to the
    // exact pending edge (to_index === cursor 1) with the chain metadata.
    const e1 = entry1();
    const admitted = store.admitFallback(
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "open", cursor: 1, tailRun: admitted.runId, transitionGeneration: 4 });
    // The run carries its chain provenance.
    const row = store.getRun(admitted.runId);
    expect(row).toMatchObject({ provider: "gemini" });
    expect(store.raw().prepare("SELECT chain_cycle, chain_index, entry_digest, auth_mode FROM run WHERE id = ?").get(admitted.runId)).toMatchObject({ chain_cycle: cycleId, chain_index: 1, entry_digest: e1.entryDigest, auth_mode: "api-key" });
    expect(store.runRoute(admitted.runId)).toMatchObject({ chosen: "fallback", provider: "gemini", model: "gemini-2.5-pro" });
  });

  test("a stale generation loses every transition (no double-advance)", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0); // gen -> 1
    // A second begin at the STALE generation 0 loses.
    expect(store.beginFallbackSanitize(cycleId, 0, baseRun, T0)).toBe(false);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv.ok).toBe(true);
    // A SECOND advance at the now-stale generation 1 loses — and the state
    // is awaiting-release, not sanitizing, so the from-state guard also fails.
    const again = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(again).toMatchObject({ ok: false, reason: "raced" });
  });

  test("the admission is SINGLE-USE: a replayed transition creates NO second run (finding 2)", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 2, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    ) as { ok: true; transitionId: number; toIndex: number };
    store.releaseFallbackToPending(cycleId, 2, T0);
    const before = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    const e1 = entry1();
    const first = store.admitFallback(
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(first.ok).toBe(true);
    const afterFirst = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterFirst).toBe(before + 1); // exactly one run created
    // Replay the consumed transition — the state is open, not
    // pending-admission, and the edge is consumed. NO second run opens.
    const replay = store.admitFallback(
      { cycleId, expectGeneration: 4, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-2", runner: "b-1", branch: "b2", worktree: "/w2", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(replay.ok).toBe(false);
    const afterReplay = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterReplay).toBe(before + 1); // STILL exactly one — no run leaked
  });

  test("an old unconsumed quota-skip transition cannot authorize an unrelated admission (finding 2)", () => {
    // Skip index 0 (its quota exhausted) to pending-admission at cursor 1.
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0) as { ok: true; toIndex: number; transitionId: number };
    // Admit at cursor 1 consumes THAT edge (to_index 1 === cursor 1).
    const e1 = entry1();
    const ad = store.admitFallback(
      { cycleId, expectGeneration: 1, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(ad.ok).toBe(true);
    // A stale reference to that same (now consumed) transition cannot admit
    // again at any cursor.
    expect(
      store.admitFallback(
        { cycleId, expectGeneration: 2, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-9", runner: "b-1", branch: "b9", worktree: "/w9", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
        T0,
      ).ok,
    ).toBe(false);
  });

  test("the (cycle, from_index) uniqueness backstops even a forced double transition", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv.ok).toBe(true);
    // The DB rejects a second row with the same (cycle, from_index=0), even
    // if some caller forced the cycle back to sanitizing at cursor 0 — the
    // savepoint returns 'dup' and rolls the cursor move back (finding 4).
    store.raw().prepare("UPDATE fallback_cycle SET state = 'sanitizing', cursor = 0, transition_generation = 1 WHERE id = ?").run(cycleId);
    const dup = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(dup).toMatchObject({ ok: false, reason: "dup" });
    // The cursor did NOT advance past the rolled-back move.
    expect(store.fallbackCycleFor(taskRef)?.cursor).toBe(0);
  });

  test("advancing past the last entry refuses (at-end -> the caller pages exhausted-no-fallback)", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    // chainLength 1: fromIndex 0 has no next entry.
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 1, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("quota-skip goes open -> pending-admission (nothing ran), recorded, and refuses at the end", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0);
    expect(skip).toMatchObject({ ok: true, toIndex: 1 });
    // pending-admission with the tail cleared — admission is the one road on.
    const c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null, transitionGeneration: 1 });
    // The at-end bound refuses before any CAS (fromIndex 2 of a length-3 chain).
    expect(store.quotaSkipFallback({ cycleId, expectGeneration: 1, fromIndex: 2, chainLength: 3, tailRun: baseRun }, T0)).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("incident and close are terminal; a new cycle can only open when none is live", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0) as { ok: true; id: number };
    // A second open refuses while one is live.
    expect(store.openFallbackCycle(taskRef, chainDigest, baseRun, T0)).toEqual({ ok: false });
    // incident CAS on the exact generation: a stale gen loses.
    expect(store.incidentFallback(cycleId, 99, "stale", T0)).toBe(false);
    expect(store.incidentFallback(cycleId, 0, "sanitizer-failed", T0)).toBe(true);
    expect(store.fallbackCycleFor(taskRef)).toBeNull(); // incident is not "live"
    // Now a fresh cycle can open.
    const two = store.openFallbackCycle(taskRef, chainDigest, baseRun, T0);
    expect(two.ok).toBe(true);
    if (two.ok) expect(store.closeFallbackCycle(two.id, 0, "succeeded", T0)).toBe(true);
    expect(store.fallbackCycleFor(taskRef)).toBeNull();
  });
});

describe("opening the base cycle from the approved chain (E3b)", () => {
  let store: Store;
  const REPO = "/repos/chain";
  const bootstrap = () => {
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    return added.token;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  });
  afterEach(() => store.close());

  test("a SINGLE-PROFILE approval opens no cycle — inert by default", () => {
    store.createTask({ id: "t-plain", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-plain").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-plain", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-plain", "alex", T0, store.getScope("t-plain")!.digest, token).ok).toBe(true);
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) });
    expect(store.openChainCycleForDispatch(ref, "t-plain", run, T0)).toBeNull();
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });

  test("a CHAIN approval opens a cycle at cursor 0, bound to the dispatched run, digest from the snapshot", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-chain", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-chain").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-chain", goal: "a guard", now: T0 });
    const token = bootstrap();
    const scope = store.getScope("t-chain")!;
    expect(approve(store, "t-chain", "alex", T0, scope.digest, token).ok).toBe(true);

    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) });
    const cycleId = store.openChainCycleForDispatch(ref, "t-chain", run, T0);
    expect(cycleId).not.toBeNull();
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: run });
    // The cycle's digest is the one the approved snapshot binds — not config.
    const expected = chainDigestOf(chainFromJson(store.getScope("t-chain")!.approvedChainJson!)!);
    expect(c.chainDigest).toBe(expected);
  });

  test("a second dispatch against a live cycle gets NO binding — custody never moves in passing (finding 5)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-retry", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-retry").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-retry", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-retry", "alex", T0, store.getScope("t-retry")!.digest, token).ok).toBe(true);

    const first = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "claude", now: T0, ...presented(store, ref) });
    const c1 = store.openChainCycleForDispatch(ref, "t-retry", first, T0);
    expect(c1).not.toBeNull();
    // The first run is BOUND to entry 0.
    expect(store.getRun(first)).toMatchObject({ chainCycle: c1, chainIndex: 0, authMode: "subscription" });
    // A second dispatch while the cycle lives: refused a binding — the
    // cycle's tail stays with the first run, and the unbound second run
    // would fail the chain-entry dispatch proof before spending.
    const second = store.startRun({ taskRef: ref, leaseId: "l2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "claude", now: T0, ...presented(store, ref) });
    expect(store.openChainCycleForDispatch(ref, "t-retry", second, T0)).toBeNull();
    const c = store.fallbackCycleFor(ref)!;
    expect(c.tailRun).toBe(first);
    expect(store.getRun(second)?.chainCycle ?? null).toBeNull();
  });

  test("the PROVEN parked-resume transfer: only a parked tail hands custody to a successor (finding 5)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-resume", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-resume").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-resume", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-resume", "alex", T0, store.getScope("t-resume")!.digest, token).ok).toBe(true);

    const parent = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) });
    store.openChainCycleForDispatch(ref, "t-resume", parent, T0);
    const successor = store.startRun({ taskRef: ref, leaseId: "l2", runner: "b-1", branch: "b", worktree: "/w2", provider: "claude", now: T0, ...presented(store, ref) });
    // A LIVE (unconcluded) parent refuses the transfer — the provider may
    // still be alive, and custody is not moved off a possibly-running tail.
    expect(store.resumeChainCustody(parent, successor, T0)).toBe(false);
    // A PARKED parent is the paused lineage: the transfer proves and moves.
    store.finishRun(parent, { outcome: "parked", reason: "decision", now: T0 });
    expect(store.resumeChainCustody(parent, successor, T0)).toBe(true);
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: successor });
    // The successor INHERITED the binding verbatim — pinned auth mode included.
    expect(store.getRun(successor)).toMatchObject({ chainCycle: c.id, chainIndex: 0, authMode: "subscription" });
    // And the transfer is single-use: the parent is no longer the tail.
    const third = store.startRun({ taskRef: ref, leaseId: "l3", runner: "b-1", branch: "b", worktree: "/w3", provider: "claude", now: T0, ...presented(store, ref) });
    expect(store.resumeChainCustody(parent, third, T0)).toBe(false);
  });

  test("atomic-chain: base and parked-resume custody are proved and written IN the run's insert — a binding that cannot be proved rolls the row back, only a same-task repair inherits, a reviewer after a fallback takes no custody", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-atomic", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-atomic").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-atomic", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-atomic", "alex", T0, store.getScope("t-atomic")!.digest, token).ok).toBe(true);
    const rows = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number }).n);
    const open = (over: Record<string, unknown>) =>
      store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), ...over } as Parameters<Store["startRun"]>[0]);
    // BASE: the cycle opens with the row, bound to entry 0.
    const base = open({ custody: { kind: "base" } });
    const cycle = store.fallbackCycleFor(ref)!;
    expect(cycle).toMatchObject({ state: "open", cursor: 0, tailRun: base });
    expect(store.getRun(base)).toMatchObject({ chainCycle: cycle.id, chainIndex: 0, authMode: "subscription" });
    // A second BASE beside the live cycle: the insert rolls back — no row.
    expect(() => open({ leaseId: "l2", custody: { kind: "base" } })).toThrow(/fallback cycle is live — base custody cannot open beside it/);
    expect(rows()).toBe(1);
    expect(store.fallbackCycleFor(ref)?.tailRun).toBe(base);
    // RESUME from a tail that is not parked: rolled back — no row.
    expect(() => open({ leaseId: "l3", custody: { kind: "resume", parkedRun: base } })).toThrow(/is not this task's parked chain tail/);
    expect(rows()).toBe(1);
    // A repair child of the tail inherits IN its insert; a reviewer child does not.
    const repair = open({ role: "repair", parentRun: base, ...presented(store, ref, "repair") });
    expect(store.getRun(repair)).toMatchObject({ chainCycle: cycle.id, chainIndex: 0, entryDigest: store.getRun(base)!.entryDigest, authMode: "subscription" });
    const review = open({ role: "reviewer", parentRun: base, branch: undefined, worktree: undefined, ...presented(store, ref, "reviewer") });
    expect(store.getRun(review)).toMatchObject({ role: "reviewer", chainCycle: null, chainIndex: null, entryDigest: null, authMode: null });
    // A repair whose parent belongs to ANOTHER task is a caller bug: no row.
    store.createTask({ id: "t-other", title: "w" }, T0);
    const other = store.refFor("built-in", "t-other").id;
    store.placeTask(other, REPO);
    propose(store, { taskId: "t-other", goal: "elsewhere", now: T0 });
    expect(approve(store, "t-other", "alex", T0, store.getScope("t-other")!.digest, token).ok).toBe(true);
    expect(() => store.startRun({ taskRef: other, leaseId: "lo", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", role: "repair", parentRun: base, now: T0, ...presented(store, other, "repair") })).toThrow(/a repair turn mends its own task's run only/);
    expect(store.runsFor(other)).toHaveLength(0);
    // PARKED-RESUME: the tail parks; the successor takes custody in its insert.
    store.finishRun(repair, { outcome: "failed", reason: "x", now: T0 });
    store.finishRun(base, { outcome: "parked", reason: "decision", now: T0 });
    expect(store.resolveChainOnRunEnd(ref, "t-atomic", REPO, base, T0)).toEqual({ kind: "parked-tail" });
    const successor = open({ leaseId: "l4", custody: { kind: "resume", parkedRun: base } });
    expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 0, tailRun: successor });
    expect(store.getRun(successor)).toMatchObject({ chainCycle: cycle.id, chainIndex: 0, authMode: "subscription" });
    // The transfer is single-use: a second resume off the same parked tail rolls back.
    expect(() => open({ leaseId: "l5", custody: { kind: "resume", parkedRun: base } })).toThrow(/is not open with it as the parked tail|not this task's parked chain tail/);
    expect(store.fallbackCycleFor(ref)?.tailRun).toBe(successor);
  });

  test("fallback-bound: admission requires chosen=fallback and the exact task, live cycle, approved chain, index, entry digest, provider, model, auth mode, and repair model — every mismatch creates no run and consumes no edge", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }, { provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
    store.createTask({ id: "t-bound", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-bound").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-bound", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-bound", "alex", T0, store.getScope("t-bound")!.digest, token).ok).toBe(true);
    // A second task with its own approved chain — the "wrong task" case.
    store.createTask({ id: "t-else", title: "w" }, T0);
    const elseRef = store.refFor("built-in", "t-else").id;
    store.placeTask(elseRef, REPO);
    propose(store, { taskId: "t-else", goal: "a guard", now: T0 });
    expect(approve(store, "t-else", "alex", T0, store.getScope("t-else")!.digest, token).ok).toBe(true);
    const base = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
    const cycle = store.fallbackCycleFor(ref)!;
    expect(store.beginFallbackSanitize(cycle.id, 0, base, T0)).toBe(true);
    const adv = store.advanceFallbackFenced({ cycleId: cycle.id, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: base, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } }, T0);
    if (!adv.ok) throw new Error("advance");
    expect(store.releaseFallbackToPending(cycle.id, 2, T0)).toBe(true);
    const e1 = entryArgs(store, "t-bound", 1);
    const exact = () => ({
      cycleId: cycle.id, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId,
      run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.model },
      entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route,
    });
    const rows = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n);
    const edgeFree = () => (store.raw().prepare("SELECT consumed_by FROM fallback_transition WHERE id = ?").get(adv.transitionId) as { consumed_by: number | null }).consumed_by === null;
    const before = rows();
    const refused = (args: Parameters<Store["admitFallback"]>[0], words: RegExp | null) => {
      const result = store.admitFallback(args, T0);
      expect(result.ok).toBe(false);
      if (words !== null && !result.ok) expect(result.problem ?? "").toMatch(words);
      expect(rows()).toBe(before);
      expect(edgeFree()).toBe(true);
      expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "pending-admission", cursor: 1, transitionGeneration: 3 });
    };
    // Task, cycle, chain, index, digest, auth, provider, model, repair model, chosen.
    refused({ ...exact(), run: { ...exact().run, taskRef: elseRef } }, /belongs to task_ref/);
    refused({ ...exact(), cycleId: cycle.id + 1 }, null);
    refused({ ...exact(), expectGeneration: 2 }, null);
    refused({ ...exact(), expectCursor: 2 }, null);
    refused({ ...exact(), entryDigest: entryDigestOf(store.approvedChainOf("t-bound")![2]!) }, /is not the approved entry 1's/);
    refused({ ...exact(), entryDigest: "forged" }, /is not the approved entry 1's/);
    refused({ ...exact(), authMode: "subscription" }, /is pinned to api-key, not subscription/);
    refused({ ...exact(), run: { ...exact().run, provider: "codex" }, route: { ...e1.route, provider: "codex" } }, /runs gemini, not codex/);
    refused({ ...exact(), run: { ...exact().run, model: "gemini-2.5-flash" }, route: { ...e1.route, model: "gemini-2.5-flash" } }, /not gemini · gemini-2.5-flash/);
    refused({ ...exact(), repairModel: "gemini-2.5-flash" }, /repairs on gemini · gemini-2.5-pro, not gemini-2.5-flash/);
    refused({ ...exact(), route: { ...e1.route, chosen: "recommended" } }, /spends as `fallback`, not `recommended`/);
    refused({ ...exact(), route: { ...e1.route, routeDigest: "f".repeat(32) } }, /is not the approved authority/);
    // The approved chain withdrawn (re-filed without reapproval): nothing admits.
    const snapshot = store.raw().prepare("SELECT approved_chain_json AS c FROM task_scope WHERE task_id = 't-bound'").get() as { c: string };
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = '[{' WHERE task_id = 't-bound'").run();
    refused(exact(), /chain approval no longer stands/);
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = ? WHERE task_id = 't-bound'").run(snapshot.c);
    // The exact statement admits: one run, the edge consumed, the cycle open at 1.
    const admitted = store.admitFallback(exact(), T0);
    expect(admitted.ok).toBe(true);
    expect(rows()).toBe(before + 1);
    expect(edgeFree()).toBe(false);
    expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 1 });
  });

  test("a scope REWRITTEN after a chain approval loses fallback authority — no cycle opens (finding 2)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-stale", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-stale").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-stale", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-stale", "alex", T0, store.getScope("t-stale")!.digest, token).ok).toBe(true);
    // The scope is rewritten WITHOUT reapproval — approved_digest !== digest.
    propose(store, { taskId: "t-stale", goal: "a wider guard", now: T0 });
    expect(store.approvedChainOf("t-stale")).toBeNull(); // authority withdrawn
    // v48: with no sealed route, no run opens at all — zero rows, no cycle.
    expect(() => store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) })).toThrow(/approved and then changed/);
    expect(Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number }).n)).toBe(0);
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });
});

describe("advancing on exhaustion at disposition (E3c)", () => {
  let store: Store;
  const REPO = "/repos/chain";
  const VERSION = "1.0.0";
  const EXPIRY = new Date(T0.getTime() + 24 * 60 * 60_000).toISOString();

  /** Sign a live mode for REPO that GRANTS a paid fallback. */
  const grant = () => {
    const terms: ModeTerms = { ...presetTerms("standard", EXPIRY), allowPaidFallback: true };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
  };

  /** A chain-approved task with its base cycle open. */
  const setup = (id: string) => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id, title: "w" }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", now: T0 });
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, alexToken).ok).toBe(true);
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) });
    store.openChainCycleForDispatch(ref, id, run, T0);
    return { ref, run };
  };

  /** Conclude a run exactly as the gateway + disposition would: proven
   * version, stamped class+auth, and a genuine terminal outcome + finished_at. */
  const conclude = (
    run: number,
    cls: "usage-exhausted" | "credits-depleted" | "not-exhausted",
    authMode: "subscription" | "api-key",
  ) => {
    store.stampProviderStart(run, T0, VERSION);
    store.stampTerminalClass(run, authMode, cls);
    store.finishRun(run, { outcome: "failed", reason: "exhausted", now: T0 });
  };

  let alexToken: string;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    alexToken = added.token;
  });
  afterEach(() => {
    rec.eligible.clear();
    store.close();
  });

  test("eligible + recognized + granted + a next entry: sanitize→advance→pending, atomically", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    grant();
    const { ref, run } = setup("t-adv");
    conclude(run, "usage-exhausted", "subscription");
    const step = store.resolveChainOnRunEnd(ref, "t-adv", REPO, run, T0);
    expect(step).toEqual({ kind: "advanced", toIndex: 1 });
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null });
  });

  test("an UNFINISHED run is never advanced off — the predecessor must be concluded (finding 7)", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    grant();
    const { ref, run } = setup("t-live");
    // Stamp the eligible class but DON'T finish the run — it still owns custody.
    store.stampProviderStart(run, T0, VERSION);
    store.stampTerminalClass(run, "subscription", "usage-exhausted");
    expect(store.resolveChainOnRunEnd(ref, "t-live", REPO, run, T0)).toEqual({ kind: "no-cycle" });
    expect(store.fallbackCycleFor(ref)!.state).toBe("open");
  });

  test("C8: an eligible class this build no longer recognizes NEVER advances — it severs to incident", () => {
    grant();
    const { ref, run } = setup("t-c8"); // NO recognizer added
    conclude(run, "usage-exhausted", "subscription");
    const step = store.resolveChainOnRunEnd(ref, "t-c8", REPO, run, T0);
    expect(step).toEqual({ kind: "blocked", reason: "no-recognizer" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // incident is not "live"
  });

  test("C8 exactness: a fixture for the WRONG auth mode never advances (finding 8)", () => {
    // The build knows this version's api-key (credits) shape ONLY — the
    // subscription (usage) class must still sever, not ride the other set.
    rec.eligible.add(`claude:${VERSION}:api-key`);
    grant();
    const { ref, run } = setup("t-exact");
    conclude(run, "usage-exhausted", "subscription");
    const step = store.resolveChainOnRunEnd(ref, "t-exact", REPO, run, T0);
    expect(step).toEqual({ kind: "blocked", reason: "no-recognizer" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // severed to incident
  });

  test("a class/auth-mode MISMATCH is a corrupt stamp — never eligible (finding 8)", () => {
    // The stamp road itself can no longer produce the mismatch (the pinned
    // auth mode wins, first-write) — so corrupt the column DIRECTLY, the way
    // only a bug or a tamper could, and prove the resolver reads it as an
    // ordinary end, never an advance.
    rec.eligible.add(`claude:${VERSION}:subscription`);
    rec.eligible.add(`claude:${VERSION}:api-key`);
    grant();
    const { ref, run } = setup("t-mismatch");
    conclude(run, "usage-exhausted", "subscription");
    store.raw().prepare("UPDATE run SET terminal_class = 'credits-depleted' WHERE id = ?").run(run);
    expect(store.resolveChainOnRunEnd(ref, "t-mismatch", REPO, run, T0)).toEqual({ kind: "closed", reason: "entry-ended" });
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });

  test("grant TOCTOU: the LIVE mode is re-proved in-transaction — a revoked grant denies (finding 4)", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    grant();
    const { ref, run } = setup("t-toctou");
    conclude(run, "usage-exhausted", "subscription");
    // The grant is revoked AFTER conclusion, BEFORE the advance.
    store.revokeMode(REPO, "alex", "test", T0);
    const step = store.resolveChainOnRunEnd(ref, "t-toctou", REPO, run, T0);
    expect(step).toEqual({ kind: "blocked", reason: "grant-withheld" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // closed cleanly, not incident
  });

  test("no grant at all: the cycle ends cleanly, not as an incident", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    const { ref, run } = setup("t-nogrant"); // no mode signed
    conclude(run, "usage-exhausted", "subscription");
    expect(store.resolveChainOnRunEnd(ref, "t-nogrant", REPO, run, T0)).toEqual({ kind: "blocked", reason: "grant-withheld" });
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });

  test("exhausted-end: eligible + recognized + granted but the whole chain is spent — the terminal, closed", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    grant();
    const { ref, run } = setup("t-end");
    conclude(run, "usage-exhausted", "subscription");
    expect(store.resolveChainOnRunEnd(ref, "t-end", REPO, run, T0)).toEqual({ kind: "advanced", toIndex: 1 });
    // Admit the fallback run (the last entry) at cursor 1.
    const cyc = store.fallbackCycleFor(ref)!;
    const txId = Number((store.raw().prepare("SELECT id FROM fallback_transition WHERE cycle = ? ORDER BY id DESC LIMIT 1").get(cyc.id) as { id: number }).id);
    // The admission binds the approved chain's EXACT entry (v48): a made-up
    // entry digest opens nothing.
    const e1 = entryArgs(store, "t-end", 1);
    const forged = store.admitFallback(
      { cycleId: cyc.id, expectGeneration: cyc.transitionGeneration, expectCursor: 1, transitionId: txId, run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: "e1", authMode: "api-key", repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(forged).toMatchObject({ ok: false, problem: expect.stringContaining("the stated entry digest e1 is not the approved entry 1's") });
    const admitted = store.admitFallback(
      { cycleId: cyc.id, expectGeneration: cyc.transitionGeneration, expectCursor: 1, transitionId: txId, run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route },
      T0,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // Exhaust the fallback run (gemini) at the LAST index — no entry left.
    rec.eligible.add(`gemini:${VERSION}:api-key`);
    conclude(admitted.runId, "credits-depleted", "api-key");
    expect(store.resolveChainOnRunEnd(ref, "t-end", REPO, admitted.runId, T0)).toEqual({ kind: "exhausted-end" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // closed: chain-exhausted
  });

  test("an ordinary (non-exhaustion) failure ENDS the cycle — the retry road opens a fresh one at the base", () => {
    rec.eligible.add(`claude:${VERSION}:subscription`);
    grant();
    const { ref, run } = setup("t-plainfail");
    conclude(run, "not-exhausted", "subscription");
    expect(store.resolveChainOnRunEnd(ref, "t-plainfail", REPO, run, T0)).toEqual({ kind: "closed", reason: "entry-ended" });
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });

  test("a PARKED tail keeps the cycle open — repair resumes the same custody", () => {
    const { ref, run } = setup("t-park");
    store.stampProviderStart(run, T0, VERSION);
    store.finishRun(run, { outcome: "parked", reason: "decision", now: T0 });
    expect(store.resolveChainOnRunEnd(ref, "t-park", REPO, run, T0)).toEqual({ kind: "parked-tail" });
    expect(store.fallbackCycleFor(ref)!.state).toBe("open");
  });

  test("the pre-spawn custody proof holds for the tail AND its repair child — nothing else (verify R2)", () => {
    const { ref, run } = setup("t-custody");
    // The tail itself proves and gets its start stamp.
    expect(store.proveChainCustodyForSpawn(run, T0)).toBe(true);
    expect(store.getRun(run)?.providerStartedAt).not.toBeNull();
    // A bounded repair child of the tail spends under the parent's custody —
    // the binding inherited IN its admission (v48 authority repair), presenting the entry's
    // repair authority (the base entry: the sealed repair leg).
    const repair = store.startRun({
      taskRef: ref, leaseId: "l-r", runner: "b-1", branch: "b", worktree: "/w",
      provider: "claude", role: "repair", parentRun: run, now: T0, ...presented(store, ref, "repair"),
    });
    expect(store.getRun(repair)).toMatchObject({ chainCycle: store.getRun(run)!.chainCycle, chainIndex: 0 });
    expect(store.proveChainCustodyForSpawn(repair, T0)).toBe(true);
    // A chain-bound run that is NEITHER the tail nor its repair child refuses.
    const stranger = store.startRun({
      taskRef: ref, leaseId: "l-s", runner: "b-1", branch: "b", worktree: "/w2",
      provider: "claude", now: T0, ...presented(store, ref),
    });
    store.inheritChainBinding(stranger, run); // binding alone is not custody
    expect(store.proveChainCustodyForSpawn(stranger, T0)).toBe(false);
    expect(store.getRun(stranger)?.providerStartedAt ?? null).toBeNull();
  });

  test("success closes the cycle through the SAME resolver", () => {
    const { ref, run } = setup("t-win");
    store.stampProviderStart(run, T0, VERSION);
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    expect(store.resolveChainOnRunEnd(ref, "t-win", REPO, run, T0)).toEqual({ kind: "closed", reason: "succeeded" });
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });
});
