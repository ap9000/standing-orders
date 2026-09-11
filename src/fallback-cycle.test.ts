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
import { propose, approve, addApprover, chainFromJson, chainDigestOf, digestOf, entryDigestOf } from "./scope.js";
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
  const mirror = store.getScope(taskId)?.approvedProfile ?? null;
  if (mirror === null) throw new Error("no approved profile mirror");
  return {
    kind: "entry" as const,
    expectTail: null,
    approved: { chainDigest: chainDigestOf(chain), profile: mirror },
    entryDigest: entryDigestOf(entry),
    authMode: entry.authMode,
    repairModel: entry.profile.repairModel === "inherit" ? entry.profile.model : entry.profile.repairModel,
    provider: entry.profile.provider,
    model: entry.profile.model,
    // The sealed route's digest, exactly — there is no chain-only digest
    // (raw authority repair); a fixture on a chain with no sealed route
    // presents the word the admission will refuse.
    route: { routeDigest: sealed.ok ? routeDigestOf(sealed.route) : "unsealed", phase: "build" as const, provider: entry.profile.provider, model: entry.profile.model, chosen: "fallback" as const },
  };
};

describe("the fallback cycle state machine", () => {
  let store: Store;
  let taskRef: number;
  let baseRun: number;
  /** The approved chain's digest — the only chain a cycle may open under. */
  let chainDigest: string;

  // The base run takes the chain's custody INSIDE its insert (v48
  // integrity): a chain-approved build presents custody or opens nothing,
  // so the cycle every test below walks was opened by the run's own
  // admission — `openedCycle` reads it back.
  const openRun = (n: number) =>
    store.startRun({ taskRef, leaseId: `l-${n}`, runner: "b-1", branch: `b${n}`, worktree: `/w${n}`, provider: "claude", now: T0, ...presented(store, taskRef), custody: { kind: "base" } });
  const openedCycle = (): { ok: true; id: number } => {
    const live = store.fallbackCycleFor(taskRef);
    if (live === null) throw new Error("the base run opened no cycle");
    return { ok: true, id: live.id };
  };
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
    const opened = openedCycle();
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
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
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
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
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
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 2, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    ) as { ok: true; transitionId: number; toIndex: number };
    store.releaseFallbackToPending(cycleId, 2, T0);
    const before = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    const e1 = entry1();
    const first = store.admitFallback(
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
      T0,
    );
    expect(first.ok).toBe(true);
    const afterFirst = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterFirst).toBe(before + 1); // exactly one run created
    // Replay the consumed transition — the state is open, not
    // pending-admission, and the edge is consumed. NO second run opens.
    const replay = store.admitFallback(
      { cycleId, expectGeneration: 4, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-2", runner: "b-1", branch: "b2", worktree: "/w2", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
      T0,
    );
    expect(replay.ok).toBe(false);
    const afterReplay = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterReplay).toBe(before + 1); // STILL exactly one — no run leaked
  });

  test("an old unconsumed quota-skip transition cannot authorize an unrelated admission (finding 2)", () => {
    // Skip index 0 (its quota exhausted) to pending-admission at cursor 1.
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0) as { ok: true; toIndex: number; transitionId: number };
    // Admit at cursor 1 consumes THAT edge (to_index 1 === cursor 1).
    const e1 = entry1();
    const ad = store.admitFallback(
      { cycleId, expectGeneration: 1, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
      T0,
    );
    expect(ad.ok).toBe(true);
    // A stale reference to that same (now consumed) transition cannot admit
    // again at any cursor.
    expect(
      store.admitFallback(
        { cycleId, expectGeneration: 2, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-9", runner: "b-1", branch: "b9", worktree: "/w9", provider: e1.provider, model: e1.model }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
        T0,
      ).ok,
    ).toBe(false);
  });

  test("the (cycle, from_index) uniqueness backstops even a forced double transition", () => {
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
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
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    // chainLength 1: fromIndex 0 has no next entry.
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 1, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("quota-skip goes open -> pending-admission (nothing ran), recorded, and refuses at the end", () => {
    const { id: cycleId } = openedCycle() as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0);
    expect(skip).toMatchObject({ ok: true, toIndex: 1 });
    // pending-admission with the tail cleared — admission is the one road on.
    const c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null, transitionGeneration: 1 });
    // The at-end bound refuses before any CAS (fromIndex 2 of a length-3 chain).
    expect(store.quotaSkipFallback({ cycleId, expectGeneration: 1, fromIndex: 2, chainLength: 3, tailRun: baseRun }, T0)).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("incident and close are terminal; a new cycle can only open when none is live", () => {
    const { id: cycleId } = openedCycle();
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
    // Base custody is inert without a chain approval: the row opens, no cycle does.
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
    expect(store.getRun(run)).toMatchObject({ chainCycle: null, chainIndex: null, entryDigest: null });
    expect(store.fallbackCycleFor(ref)).toBeNull();
    // And a single-profile build needs no custody at all.
    expect(() => store.startRun({ taskRef: ref, leaseId: "l2", runner: "b-1", branch: "b", worktree: "/w2", provider: "claude", now: T0, ...presented(store, ref) })).not.toThrow();
  });

  test("a CHAIN approval opens a cycle at cursor 0 INSIDE the base run's insert, digest from the snapshot — and a build that presents no custody opens no row", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-chain", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-chain").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-chain", goal: "a guard", now: T0 });
    const token = bootstrap();
    const scope = store.getScope("t-chain")!;
    expect(approve(store, "t-chain", "alex", T0, scope.digest, token).ok).toBe(true);
    const rows = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number }).n);
    // No custody presented: the insert refuses in words, and no row exists.
    expect(() => store.startRun({ taskRef: ref, leaseId: "l0", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref) })).toThrow(/sealed a fallback chain — a build takes the chain's custody/);
    expect(rows()).toBe(0);
    expect(store.fallbackCycleFor(ref)).toBeNull();
    // Custody is a builder's alone.
    expect(() => store.startRun({ taskRef: ref, leaseId: "lp", runner: "b-1", role: "planner", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref, "planner"), custody: { kind: "base" } })).toThrow(/chain custody is a builder's to take/);
    expect(rows()).toBe(0);

    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: run });
    expect(store.getRun(run)).toMatchObject({ chainCycle: c.id, chainIndex: 0, authMode: "subscription" });
    // The cycle's digest is the one the approved snapshot binds — not config.
    const expected = chainDigestOf(chainFromJson(store.getScope("t-chain")!.approvedChainJson!)!);
    expect(c.chainDigest).toBe(expected);
  });

  test("a second dispatch against a live cycle opens NO row — custody never moves in passing, and there is no post-insert binding road (finding 5)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-retry", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-retry").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-retry", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-retry", "alex", T0, store.getScope("t-retry")!.digest, token).ok).toBe(true);

    const first = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
    const c1 = store.fallbackCycleFor(ref)!;
    // The first run is BOUND to entry 0.
    expect(store.getRun(first)).toMatchObject({ chainCycle: c1.id, chainIndex: 0, authMode: "subscription" });
    // A second dispatch while the cycle lives: the insert rolls back — the
    // cycle's tail stays with the first run and no unbound row exists to
    // spend outside the cycle.
    expect(() => store.startRun({ taskRef: ref, leaseId: "l2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } })).toThrow(/base custody cannot open beside it/);
    expect(store.runsFor(ref)).toHaveLength(1);
    expect(store.fallbackCycleFor(ref)!.tailRun).toBe(first);
    // The post-insert roads are gone: nothing binds or re-tags a row after the fact.
    expect("openChainCycleForDispatch" in store).toBe(false);
    expect("inheritChainBinding" in store).toBe(false);
    expect("stampRunRoute" in store).toBe(false);
  });

  test("the PROVEN parked-resume transfer: only a parked tail hands custody to a successor, inside the successor's insert (finding 5)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-resume", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-resume").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-resume", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-resume", "alex", T0, store.getScope("t-resume")!.digest, token).ok).toBe(true);

    const parent = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
    const resume = (lease: string) => store.startRun({ taskRef: ref, leaseId: lease, runner: "b-1", branch: "b", worktree: `/${lease}`, provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "resume", parkedRun: parent } });
    // A LIVE (unconcluded) parent refuses the transfer — the provider may
    // still be alive, and custody is not moved off a possibly-running tail.
    expect(() => resume("l2")).toThrow(/is not this task's parked chain tail/);
    expect(store.runsFor(ref)).toHaveLength(1);
    // A PARKED parent is the paused lineage: the transfer proves and moves.
    store.finishRun(parent, { outcome: "parked", reason: "decision", now: T0 });
    const successor = resume("l3");
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: successor });
    // The successor INHERITED the binding verbatim — pinned auth mode included.
    expect(store.getRun(successor)).toMatchObject({ chainCycle: c.id, chainIndex: 0, authMode: "subscription" });
    // And the transfer is single-use: the parent is no longer the tail.
    expect(() => resume("l4")).toThrow(/is not the live tail of its fallback cycle/);
    expect(store.runsFor(ref)).toHaveLength(2);
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
    // A repair child of the tail inherits IN its insert; a reviewer child
    // (below, once a chain-bound attempt has finished) does not.
    const repairVia = (taskRef: number, parentRun: number) =>
      store.admitRepair({ taskRef, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", parentRun, now: T0, ...(presented(store, taskRef, "repair") as { route: import("./phase-routing.js").RouteStamp }) });
    expect(() => open({ role: "repair", parentRun: base, ...presented(store, ref, "repair") })).toThrow(/a repair turn is admitted by admitRepair/);
    const repaired = repairVia(ref, base);
    if (!repaired.ok) throw new Error(repaired.problem);
    const repair = repaired.runId;
    expect(store.getRun(repair)).toMatchObject({ chainCycle: cycle.id, chainIndex: 0, entryDigest: store.getRun(base)!.entryDigest, authMode: "subscription" });
    // A repair whose parent belongs to ANOTHER task is a caller bug: no row.
    store.createTask({ id: "t-other", title: "w" }, T0);
    const other = store.refFor("built-in", "t-other").id;
    store.placeTask(other, REPO);
    propose(store, { taskId: "t-other", goal: "elsewhere", now: T0 });
    expect(approve(store, "t-other", "alex", T0, store.getScope("t-other")!.digest, token).ok).toBe(true);
    expect(repairVia(other, base)).toMatchObject({ ok: false, problem: expect.stringMatching(/a repair run continues its own task's run only/) });
    expect(store.runsFor(other)).toHaveLength(0);
    // PARKED-RESUME: the tail parks; the successor takes custody in its insert.
    store.finishRun(repair, { outcome: "failed", reason: "x", now: T0 });
    store.finishRun(base, { outcome: "parked", reason: "decision", now: T0 });
    expect(store.resolveChainOnRunEnd(ref, "t-atomic", REPO, base, T0)).toEqual({ kind: "parked-tail" });
    const successor = open({ leaseId: "l4", custody: { kind: "resume", parkedRun: base } });
    expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 0, tailRun: successor });
    expect(store.getRun(successor)).toMatchObject({ chainCycle: cycle.id, chainIndex: 0, authMode: "subscription" });
    // The transfer is single-use: a second resume off the same parked tail rolls back.
    expect(() => open({ leaseId: "l5", custody: { kind: "resume", parkedRun: base } })).toThrow(/is not the live tail of its fallback cycle|not this task's parked chain tail/);
    expect(store.fallbackCycleFor(ref)?.tailRun).toBe(successor);
    // A REVIEWER after a chain-bound attempt: admitted only through the
    // finished attempt's open review request (raw authority repair), and it
    // takes no custody — no cycle, index, digest, or auth mode.
    store.saveArtifact({ run: successor, kind: "terminal-diff", key: "k", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "s", capture: "git diff (exit 0)", captureStatus: "ok" }, T0);
    store.finishRun(successor, { outcome: "built", committed: true, now: T0 });
    expect(() => open({ role: "reviewer", parentRun: successor, branch: undefined, worktree: undefined, ...presented(store, ref, "reviewer") })).toThrow(/reviewed only through its open review request — none was presented/);
    const asked = store.requestReview(successor, "alex", T0);
    if (!asked.ok) throw new Error(asked.reason);
    const review = open({ role: "reviewer", parentRun: successor, request: asked.id, branch: undefined, worktree: undefined, ...presented(store, ref, "reviewer") });
    expect(store.getRun(review)).toMatchObject({ role: "reviewer", chainCycle: null, chainIndex: null, entryDigest: null, authMode: null });
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
      entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved,
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
    // The caller-provided facts the v48 integrity repair added: the exact
    // model is REQUIRED (never defaulted from the entry), the tail must be
    // the cycle's, the mirror must be the approval's, the chain digest the
    // approved one, the phase the run's, and a repair stamp admits no builder.
    refused({ ...exact(), run: { ...exact().run, model: undefined as unknown as string } }, /names no exact model — nothing is defaulted here/);
    refused({ ...exact(), run: { ...exact().run, model: "" } }, /names no exact model/);
    refused({ ...exact(), expectTail: base }, /the cycle's tail is none, not \d+/);
    refused({ ...exact(), approved: { ...exact().approved, chainDigest: "0".repeat(32) } }, /the caller holds chain 0{32}, but the approved chain is/);
    refused({ ...exact(), approved: { ...exact().approved, profile: { ...exact().approved.profile, model: "opus" } } }, /the caller's sealed-profile mirror .* is not the approval's/);
    refused({ ...exact(), route: { ...e1.route, phase: "repair" } }, /a builder run spends as the build leg, but the stamp says repair/);
    refused({ ...exact(), route: { ...e1.route, phase: "plan" } }, /a builder run spends as the build leg/);
    // The store's OWN sealed-profile mirror corrupted, or rewritten to
    // another profile: the chain approval is not downgraded to chain-only
    // authority — nothing admits, and the chain reads as gone.
    const mirrorJson = store.raw().prepare("SELECT approved_profile_json AS p FROM task_scope WHERE task_id = 't-bound'").get() as { p: string };
    for (const corrupt of ["{", "null", JSON.stringify({ digestVersion: 2, profile: { ...exact().approved.profile, model: "opus" } }), JSON.stringify({ digestVersion: 2, profile: { ...exact().approved.profile, extra: 1 } })]) {
      store.raw().prepare("UPDATE task_scope SET approved_profile_json = ? WHERE task_id = 't-bound'").run(corrupt);
      expect(store.approvedChainOf("t-bound")).toBeNull();
      expect(store.sealedRouteOf("t-bound")).toMatchObject({ ok: false, reason: "unreadable" });
      refused(exact(), /chain approval no longer stands \(or its sealed profile mirror does not verify\)/);
    }
    store.raw().prepare("UPDATE task_scope SET approved_profile_json = ? WHERE task_id = 't-bound'").run(mirrorJson.p);
    expect(store.approvedChainOf("t-bound")).not.toBeNull();
    // The approved chain withdrawn (re-filed without reapproval): nothing admits.
    const snapshot = store.raw().prepare("SELECT approved_chain_json AS c FROM task_scope WHERE task_id = 't-bound'").get() as { c: string };
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = '[{' WHERE task_id = 't-bound'").run();
    refused(exact(), /chain approval no longer stands/);
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = ? WHERE task_id = 't-bound'").run(snapshot.c);
    // A resume or repair kind against a pending cycle: refused (the cycle is not open).
    refused({ ...exact(), kind: "resume", parkedRun: base, expectTail: null } as Parameters<Store["admitFallback"]>[0], /is pending-admission, not open/);
    refused({ ...exact(), kind: "repair", parentRun: base, expectTail: null, route: { ...e1.route, phase: "repair" } } as Parameters<Store["admitFallback"]>[0], /is pending-admission, not open/);
    // NO CHAIN-ONLY DIGEST (raw authority repair): the chain approval
    // rewritten as a PRE-ROUTING one — no route era, no route bytes, the
    // digests re-derived over the chain alone so the chain still reads
    // as approved — has no sealed route, and a fallback presented under
    // any digest (the old `chain:` word included) admits nothing. The
    // admission pass says so in words and mutates nothing: no run, no
    // consumed edge, the cycle exactly as it was.
    {
      const rawScope = store.raw();
      const keep = rawScope.prepare("SELECT digest, approved_digest, proposed_route_json, approved_route_json, route_era FROM task_scope WHERE task_id = 't-bound'").get() as Record<string, unknown>;
      const scopeNow = store.getScope("t-bound")!;
      const chainNow = store.approvedChainOf("t-bound")!;
      const unrouted = digestOf({ goal: scopeNow.goal, outOfScope: scopeNow.outOfScope, touches: scopeNow.touches, budgetMicrousd: scopeNow.budgetMicrousd, acceptance: scopeNow.acceptance, qualityMode: scopeNow.qualityMode }, { chain: chainNow }, null);
      rawScope.prepare("UPDATE task_scope SET digest = ?, approved_digest = ?, proposed_route_json = NULL, approved_route_json = NULL, route_era = NULL WHERE task_id = 't-bound'").run(unrouted, unrouted);
      expect(store.approvedChainOf("t-bound")).not.toBeNull();
      expect(store.sealedRouteOf("t-bound")).toMatchObject({ ok: false, reason: "legacy" });
      expect(store.routeAuthorityFor(ref, "builder", { index: 1, entryDigest: e1.entryDigest })).toMatchObject({ ok: false, problem: expect.stringContaining("nothing spends as a fallback under a chain-only digest") });
      // A live mode GRANTS the paid fallback, so the only thing standing
      // between the pending cycle and a run is the sealed-authority proof.
      const grantTerms: ModeTerms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), allowPaidFallback: true };
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(grantTerms), digest: modeDigestOf(grantTerms), signedBy: "alex", absoluteExpiry: grantTerms.absoluteExpiry, publication: grantTerms.publication },
        T0,
      );
      const cycleBefore = rawScope.prepare("SELECT * FROM fallback_cycle WHERE id = ?").get(cycle.id);
      const edgesBefore = rawScope.prepare("SELECT * FROM fallback_transition WHERE cycle = ? ORDER BY id").all(cycle.id);
      for (const digest of [`chain:${chainDigestOf(chainNow)}`, e1.route.routeDigest, "legacy"]) {
        refused({ ...exact(), route: { ...e1.route, routeDigest: digest } }, /sealed agent route does not stand .* nothing spends as a fallback under a chain-only digest/);
      }
      const pass = store.admitNextChainEntry(cycle.id, { leaseId: "lp", runner: "b-1", branch: "bp", worktree: "/wp" }, T0);
      expect(pass).toMatchObject({ ok: false, reason: "stale-approval", detail: expect.stringContaining("chain-only digest") });
      expect(rows()).toBe(before);
      expect(edgeFree()).toBe(true);
      expect(rawScope.prepare("SELECT * FROM fallback_cycle WHERE id = ?").get(cycle.id)).toEqual(cycleBefore);
      expect(rawScope.prepare("SELECT * FROM fallback_transition WHERE cycle = ? ORDER BY id").all(cycle.id)).toEqual(edgesBefore);
      rawScope.prepare("UPDATE task_scope SET digest = ?, approved_digest = ?, proposed_route_json = ?, approved_route_json = ?, route_era = ? WHERE task_id = 't-bound'").run(keep["digest"], keep["approved_digest"], keep["proposed_route_json"], keep["approved_route_json"], keep["route_era"]);
      expect(store.sealedRouteOf("t-bound")).toMatchObject({ ok: true });
    }
    // A recovered draft's lineage rides the insert (raw authority repair):
    // a parent that is not this task's attempt admits nothing; a repair
    // turn recovers none.
    refused({ ...exact(), run: { ...exact().run, recoveredFrom: 9999 } }, /run #9999 is not one of this task's attempts — nothing recovers its draft/);
    // The exact statement admits: one run, the edge consumed, the cycle
    // open at 1 — carrying the interrupted base attempt as its parent.
    const admitted = store.admitFallback({ ...exact(), run: { ...exact().run, recoveredFrom: base } }, T0);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(store.getRun(admitted.runId)).toMatchObject({ parentRun: base, chainCycle: cycle.id, chainIndex: 1 });
    expect(rows()).toBe(before + 1);
    expect(edgeFree()).toBe(false);
    expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 1, tailRun: admitted.runId });

    // THE SUCCESSOR KINDS, on the now-open cycle: a repair turn under the
    // live tail and a parked tail's resume — every mismatch zero rows, the
    // tail unmoved; the generic admission refuses both outright.
    const after = rows();
    const tailStays = (): void => {
      expect(rows()).toBe(after);
      expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 1, tailRun: admitted.runId });
    };
    const repairStamp = { ...e1.route, phase: "repair" as const };
    const repairFacts = (): Parameters<Store["admitFallback"]>[0] => ({
      kind: "repair", parentRun: admitted.runId, cycleId: cycle.id, expectCursor: 1, expectTail: admitted.runId,
      run: { taskRef: ref, leaseId: "lr", runner: "b-1", branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.repairModel },
      entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, approved: e1.approved, route: repairStamp,
    });
    expect(() => store.startRun({ taskRef: ref, leaseId: "lr", runner: "b-1", branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.repairModel, role: "repair", parentRun: admitted.runId, now: T0, route: repairStamp } as never)).toThrow(/a repair turn is admitted by admitRepair/);
    expect(store.admitRepair({ taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.repairModel, parentRun: admitted.runId, now: T0, route: repairStamp })).toMatchObject({ ok: false, problem: expect.stringMatching(/admitted only through admitFallback/) });
    expect(store.admitRepair({ taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.repairModel, parentRun: admitted.runId, now: T0, ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }) })).toMatchObject({ ok: false, problem: expect.stringMatching(/admitted only through admitFallback/) });
    tailStays();
    const refusedRepair = (over: Partial<Parameters<Store["admitFallback"]>[0]>, words: RegExp) => {
      const result = store.admitFallback({ ...repairFacts(), ...over } as Parameters<Store["admitFallback"]>[0], T0);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(words);
      tailStays();
    };
    refusedRepair({ parentRun: base, expectTail: base }, /the cycle's tail is \d+, not \d+/);
    refusedRepair({ parentRun: base }, /is not the tail the caller names|is not bound to entry 1/);
    refusedRepair({ expectTail: base }, /the cycle's tail is \d+, not \d+/);
    refusedRepair({ run: { ...repairFacts().run, model: e1.model === e1.repairModel ? "gemini-2.5-flash" : e1.model } }, /repairs on gemini/);
    refusedRepair({ route: e1.route }, /a repair run spends as the repair leg, but the stamp says build/);
    refusedRepair({ route: { ...repairStamp, chosen: "recommended" } }, /spends as `fallback`/);
    refusedRepair({ run: { ...repairFacts().run, taskRef: elseRef } }, /belongs to task_ref/);
    refusedRepair({ run: { ...repairFacts().run, recoveredFrom: base } }, /a repair turn mends its live tail — it recovers no interrupted attempt/);
    const repaired = store.admitFallback(repairFacts(), T0);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(store.getRun(repaired.runId)).toMatchObject({ role: "repair", parentRun: admitted.runId, chainCycle: cycle.id, chainIndex: 1, entryDigest: e1.entryDigest, authMode: e1.authMode });
    expect(store.runRoute(repaired.runId)).toMatchObject({ phase: "repair", chosen: "fallback", provider: e1.provider, model: e1.repairModel });
    // The parent stays the tail: a repair turn spends under its custody.
    expect(store.fallbackCycleFor(ref)!.tailRun).toBe(admitted.runId);
    // A repair under an ENDED parent: refused, zero rows.
    store.finishRun(repaired.runId, { outcome: "failed", reason: "x", now: T0 });
    store.finishRun(admitted.runId, { outcome: "parked", reason: "decision", now: T0 });
    const ended = rows();
    expect(store.admitFallback({ ...repairFacts(), run: { ...repairFacts().run, leaseId: "lr2" } }, T0)).toMatchObject({ ok: false, problem: expect.stringContaining("has ended — a repair turn mends a live attempt only") });
    expect(rows()).toBe(ended);
    // RESUME of the parked fallback tail: only through admitFallback, only
    // as the parked run, only bound as it was — then the tail moves once.
    const resumeFacts = (): Parameters<Store["admitFallback"]>[0] => ({
      kind: "resume", parkedRun: admitted.runId, cycleId: cycle.id, expectCursor: 1, expectTail: admitted.runId,
      run: { taskRef: ref, leaseId: "ls", runner: "b-1", branch: "bf", worktree: "/ws", provider: e1.provider, model: e1.model },
      entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, approved: e1.approved, route: e1.route,
    });
    expect(() => store.startRun({ taskRef: ref, leaseId: "ls", runner: "b-1", branch: "bf", worktree: "/ws", provider: e1.provider, model: e1.model, now: T0, route: e1.route, custody: { kind: "resume", parkedRun: admitted.runId } })).toThrow(/admitted only through admitFallback/);
    expect(() => store.startRun({ taskRef: ref, leaseId: "ls", runner: "b-1", branch: "bf", worktree: "/ws", provider: e1.provider, model: e1.model, now: T0, ...presented(store, ref), custody: { kind: "resume", parkedRun: admitted.runId } })).toThrow(/parked on fallback entry 1 — its successor is admitted only through admitFallback/);
    expect(rows()).toBe(ended);
    for (const [over, words] of [
      [{ parkedRun: repaired.runId }, /is not the tail the caller names|did not park|is not bound to entry/],
      [{ parkedRun: base }, /is not the tail the caller names|did not park/],
      [{ parkedRun: base, expectTail: base }, /the cycle's tail is \d+, not \d+/],
      [{ expectCursor: 0 }, /stands at entry 1, not 0/],
      [{ run: { ...resumeFacts().run, model: "gemini-2.5-flash" }, route: { ...e1.route, model: "gemini-2.5-flash" } }, /runs on gemini · gemini-2.5-pro, not gemini · gemini-2.5-flash/],
      [{ authMode: "subscription" as const }, /is pinned to api-key, not subscription/],
    ] as const) {
      const result = store.admitFallback({ ...resumeFacts(), ...over } as Parameters<Store["admitFallback"]>[0], T0);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(words);
      expect(rows()).toBe(ended);
      expect(store.fallbackCycleFor(ref)!.tailRun).toBe(admitted.runId);
    }
    const resumed = store.admitFallback(resumeFacts(), T0);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(store.getRun(resumed.runId)).toMatchObject({ role: "builder", chainCycle: cycle.id, chainIndex: 1, entryDigest: e1.entryDigest, authMode: e1.authMode });
    expect(store.runRoute(resumed.runId)).toMatchObject({ phase: "build", chosen: "fallback" });
    expect(store.fallbackCycleFor(ref)).toMatchObject({ state: "open", cursor: 1, tailRun: resumed.runId });
    // Single-use: the parked run is no longer the tail.
    expect(store.admitFallback({ ...resumeFacts(), run: { ...resumeFacts().run, leaseId: "ls2" } }, T0)).toMatchObject({ ok: false, problem: expect.stringContaining("the cycle's tail is") });
    expect(store.fallbackCycleFor(ref)!.tailRun).toBe(resumed.runId);
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
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" } });
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
      { cycleId: cyc.id, expectGeneration: cyc.transitionGeneration, expectCursor: 1, transitionId: txId, run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: "e1", authMode: "api-key", repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
      T0,
    );
    expect(forged).toMatchObject({ ok: false, problem: expect.stringContaining("the stated entry digest e1 is not the approved entry 1's") });
    const admitted = store.admitFallback(
      { cycleId: cyc.id, expectGeneration: cyc.transitionGeneration, expectCursor: 1, transitionId: txId, run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, route: e1.route, kind: e1.kind, expectTail: e1.expectTail, approved: e1.approved },
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
    const tailRow = store.getRun(run)!;
    const repaired = store.admitRepair({
      taskRef: ref, leaseId: tailRow.leaseId, runner: tailRow.runner, branch: "b", worktree: "/w",
      provider: "claude", parentRun: run, now: T0, ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }),
    });
    if (!repaired.ok) throw new Error(repaired.problem);
    const repair = repaired.runId;
    expect(store.getRun(repair)).toMatchObject({ chainCycle: store.getRun(run)!.chainCycle, chainIndex: 0 });
    expect(store.proveChainCustodyForSpawn(repair, T0)).toBe(true);
    // A chain-bound run that is NEITHER the tail nor its repair child
    // cannot even be opened beside the live cycle (v48 integrity) — and a
    // row forged with the binding by hand is still not custody.
    expect(() => store.startRun({
      taskRef: ref, leaseId: "l-s", runner: "b-1", branch: "b", worktree: "/w2",
      provider: "claude", now: T0, ...presented(store, ref), custody: { kind: "base" },
    })).toThrow(/base custody cannot open beside it/);
    const tail = store.getRun(run)!;
    const forged = store.raw()
      .prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, role, provider, chain_cycle, chain_index, entry_digest, auth_mode, started_at) VALUES (?, 'l-s', 'b-1', 'b', '/w2', 'sonnet', 'builder', 'claude', ?, ?, ?, ?, ?)")
      .run(ref, tail.chainCycle, tail.chainIndex, tail.entryDigest, tail.authMode, T0.toISOString());
    const stranger = Number(forged.lastInsertRowid);
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
