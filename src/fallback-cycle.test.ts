/**
 * Layer E1: the fenced fallback-cycle state machine, exhaustively. Every
 * transition is a CAS proving the exact from-state, generation, and (where
 * it matters) cursor + tail run; the crash-window proof from the design
 * holds because no alternate authority exists until the transition commits,
 * the single-use admission cannot be replayed, and the (cycle, from_index)
 * uniqueness backstops a double advance.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, chainFromJson, chainDigestOf } from "./scope.js";
import { __installRecognizerForTest, __resetRecognizersForTest } from "./exhaustion.js";

const T0 = new Date("2026-08-29T12:00:00.000Z");

describe("the fallback cycle state machine", () => {
  let store: Store;
  let taskRef: number;
  let baseRun: number;

  const openRun = (n: number) =>
    store.startRun({ taskRef, leaseId: `l-${n}`, runner: "b-1", branch: `b${n}`, worktree: `/w${n}`, provider: "claude", now: T0 });

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    baseRun = openRun(0);
  });
  afterEach(() => store.close());

  test("the happy walk: open -> sanitizing -> awaiting-release -> pending-admission -> open at i+1", () => {
    const opened = store.openFallbackCycle(taskRef, "digest-abc", baseRun, T0);
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
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 2, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
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
    const admitted = store.admitFallback(
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: "entry-1", authMode: "api-key" },
      T0,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "open", cursor: 1, tailRun: admitted.runId, transitionGeneration: 4 });
    // The run carries its chain provenance.
    const row = store.getRun(admitted.runId);
    expect(row).toMatchObject({ provider: "gemini" });
    expect(store.raw().prepare("SELECT chain_cycle, chain_index, entry_digest, auth_mode FROM run WHERE id = ?").get(admitted.runId)).toMatchObject({ chain_cycle: cycleId, chain_index: 1, entry_digest: "entry-1", auth_mode: "api-key" });
  });

  test("a stale generation loses every transition (no double-advance)", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
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
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 2, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    ) as { ok: true; transitionId: number; toIndex: number };
    store.releaseFallbackToPending(cycleId, 2, T0);
    const before = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    const first = store.admitFallback(
      { cycleId, expectGeneration: 3, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "claude" }, entryDigest: "e1", authMode: "api-key" },
      T0,
    );
    expect(first.ok).toBe(true);
    const afterFirst = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterFirst).toBe(before + 1); // exactly one run created
    // Replay the consumed transition — the state is open, not
    // pending-admission, and the edge is consumed. NO second run opens.
    const replay = store.admitFallback(
      { cycleId, expectGeneration: 4, expectCursor: 1, transitionId: adv.transitionId, run: { taskRef, leaseId: "l-2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "claude" }, entryDigest: "e1", authMode: "api-key" },
      T0,
    );
    expect(replay.ok).toBe(false);
    const afterReplay = Number((store.raw().prepare("SELECT COUNT(*) n FROM run WHERE task_ref = ?").get(taskRef) as { n: number }).n);
    expect(afterReplay).toBe(before + 1); // STILL exactly one — no run leaked
  });

  test("an old unconsumed quota-skip transition cannot authorize an unrelated admission (finding 2)", () => {
    // Skip index 0 (its quota exhausted) to pending-admission at cursor 1.
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0) as { ok: true; toIndex: number; transitionId: number };
    // Admit at cursor 1 consumes THAT edge (to_index 1 === cursor 1).
    const ad = store.admitFallback(
      { cycleId, expectGeneration: 1, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "claude" }, entryDigest: "e1", authMode: "subscription" },
      T0,
    );
    expect(ad.ok).toBe(true);
    // A stale reference to that same (now consumed) transition cannot admit
    // again at any cursor.
    expect(
      store.admitFallback(
        { cycleId, expectGeneration: 2, expectCursor: 1, transitionId: skip.transitionId, run: { taskRef, leaseId: "l-9", runner: "b-1", branch: "b9", worktree: "/w9", provider: "claude" }, entryDigest: "e1", authMode: "subscription" },
        T0,
      ).ok,
    ).toBe(false);
  });

  test("the (cycle, from_index) uniqueness backstops even a forced double transition", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
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
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    // chainLength 1: fromIndex 0 has no next entry.
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 1, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    );
    expect(adv).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("quota-skip goes open -> pending-admission (nothing ran), recorded, and refuses at the end", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3, tailRun: baseRun }, T0);
    expect(skip).toMatchObject({ ok: true, toIndex: 1 });
    // pending-admission with the tail cleared — admission is the one road on.
    const c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null, transitionGeneration: 1 });
    // The at-end bound refuses before any CAS (fromIndex 2 of a length-3 chain).
    expect(store.quotaSkipFallback({ cycleId, expectGeneration: 1, fromIndex: 2, chainLength: 3, tailRun: baseRun }, T0)).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("incident and close are terminal; a new cycle can only open when none is live", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    // A second open refuses while one is live.
    expect(store.openFallbackCycle(taskRef, "d", baseRun, T0)).toEqual({ ok: false });
    // incident CAS on the exact generation: a stale gen loses.
    expect(store.incidentFallback(cycleId, 99, "stale", T0)).toBe(false);
    expect(store.incidentFallback(cycleId, 0, "sanitizer-failed", T0)).toBe(true);
    expect(store.fallbackCycleFor(taskRef)).toBeNull(); // incident is not "live"
    // Now a fresh cycle can open.
    const two = store.openFallbackCycle(taskRef, "d2", baseRun, T0);
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
  });
  afterEach(() => store.close());

  test("a SINGLE-PROFILE approval opens no cycle — inert by default", () => {
    store.createTask({ id: "t-plain", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-plain").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-plain", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-plain", "alex", T0, store.getScope("t-plain")!.digest, token).ok).toBe(true);
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0 });
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

    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0 });
    const cycleId = store.openChainCycleForDispatch(ref, "t-chain", run, T0);
    expect(cycleId).not.toBeNull();
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "open", cursor: 0, tailRun: run });
    // The cycle's digest is the one the approved snapshot binds — not config.
    const expected = chainDigestOf(chainFromJson(store.getScope("t-chain")!.approvedChainJson!)!);
    expect(c.chainDigest).toBe(expected);
  });

  test("a second dispatch at the open cursor RE-TAGS the tail — never opens a second cycle", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id: "t-retry", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-retry").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-retry", goal: "a guard", now: T0 });
    const token = bootstrap();
    expect(approve(store, "t-retry", "alex", T0, store.getScope("t-retry")!.digest, token).ok).toBe(true);

    const first = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b-1", branch: "b1", worktree: "/w1", provider: "claude", now: T0 });
    const c1 = store.openChainCycleForDispatch(ref, "t-retry", first, T0);
    const second = store.startRun({ taskRef: ref, leaseId: "l2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "claude", now: T0 });
    const c2 = store.openChainCycleForDispatch(ref, "t-retry", second, T0);
    expect(c2).toBe(c1); // same cycle
    const c = store.fallbackCycleFor(ref)!;
    expect(c.tailRun).toBe(second); // re-tagged to the live run
    expect(c.cursor).toBe(0);
  });
});

describe("advancing on exhaustion at disposition (E3c)", () => {
  let store: Store;
  const REPO = "/repos/chain";
  const VERSION = "1.0.0";

  // A recognizer that matches ANY failed terminal — the ELIGIBLE path a real
  // build (shipping no fixtures) can never take. Installed per test, cleared
  // in afterEach so the suite stays fail-closed by default.
  const matchAll = { eligibleUsage: [/./], eligibleCredits: [/./], transient: [] as RegExp[] };

  /** A chain-approved task with its base cycle open, and the base run stamped
   * as the coordinator's gateway would have: an eligible exhaustion class,
   * the proven version, the auth mode. */
  const setup = (id: string) => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id, title: "w" }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", now: T0 });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, added.token).ok).toBe(true);
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0 });
    store.openChainCycleForDispatch(ref, id, run, T0);
    return { ref, run };
  };

  const stampExhausted = (run: number, cls: "usage-exhausted" | "credits-depleted" | "not-exhausted") => {
    store.stampProviderVersion(run, VERSION);
    store.stampTerminalClass(run, "subscription", cls);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
  });
  afterEach(() => {
    __resetRecognizersForTest();
    store.close();
  });

  test("eligible + recognized + granted + a next entry: sanitize→advance→pending, atomically", () => {
    __installRecognizerForTest("claude", VERSION, matchAll);
    const { ref, run } = setup("t-adv");
    stampExhausted(run, "usage-exhausted");
    const step = store.advanceChainIfExhausted(ref, "t-adv", run, true, T0);
    expect(step).toEqual({ kind: "advanced", toIndex: 1 });
    const c = store.fallbackCycleFor(ref)!;
    expect(c).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null });
  });

  test("C8: an eligible class this build no longer recognizes NEVER advances — it severs to incident", () => {
    // No recognizer installed: the class was (synthetically) stamped eligible,
    // but hasRecognizer is false, so the advance is refused and paged.
    const { ref, run } = setup("t-c8");
    stampExhausted(run, "usage-exhausted");
    const step = store.advanceChainIfExhausted(ref, "t-c8", run, true, T0);
    expect(step).toEqual({ kind: "blocked", reason: "no-recognizer" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // incident is not "live"
  });

  test("no grant: eligible + recognized but the mode never allowed a paid fallback — the cycle ends cleanly", () => {
    __installRecognizerForTest("claude", VERSION, matchAll);
    const { ref, run } = setup("t-nogrant");
    stampExhausted(run, "usage-exhausted");
    const step = store.advanceChainIfExhausted(ref, "t-nogrant", run, false, T0);
    expect(step).toEqual({ kind: "blocked", reason: "grant-withheld" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // closed, not incident
  });

  test("exhausted-end: eligible + recognized + granted but the whole chain is spent — the terminal, closed", () => {
    __installRecognizerForTest("claude", VERSION, matchAll);
    const { ref, run } = setup("t-end");
    stampExhausted(run, "usage-exhausted");
    // Advance off the base (cursor 0 -> pending at cursor 1).
    expect(store.advanceChainIfExhausted(ref, "t-end", run, true, T0)).toEqual({ kind: "advanced", toIndex: 1 });
    // Admit the fallback run (the last entry) at cursor 1.
    const cyc = store.fallbackCycleFor(ref)!;
    const txId = Number((store.raw().prepare("SELECT id FROM fallback_transition WHERE cycle = ? ORDER BY id DESC LIMIT 1").get(cyc.id) as { id: number }).id);
    const admitted = store.admitFallback(
      { cycleId: cyc.id, expectGeneration: cyc.transitionGeneration, expectCursor: 1, transitionId: txId, run: { taskRef: ref, leaseId: "lf", runner: "b-1", branch: "bf", worktree: "/wf", provider: "gemini", model: "gemini-2.5-pro" }, entryDigest: "e1", authMode: "api-key" },
      T0,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // Exhaust the fallback run (gemini) at the LAST index — no entry left.
    __resetRecognizersForTest();
    __installRecognizerForTest("gemini", VERSION, matchAll);
    stampExhausted(admitted.runId, "credits-depleted");
    expect(store.advanceChainIfExhausted(ref, "t-end", admitted.runId, true, T0)).toEqual({ kind: "exhausted-end" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // closed: chain-exhausted
  });

  test("an ordinary (non-exhaustion) failure leaves the cycle open — the retry road, untouched", () => {
    __installRecognizerForTest("claude", VERSION, matchAll);
    const { ref, run } = setup("t-plainfail");
    stampExhausted(run, "not-exhausted");
    const step = store.advanceChainIfExhausted(ref, "t-plainfail", run, true, T0);
    expect(step).toEqual({ kind: "not-eligible" });
    expect(store.fallbackCycleFor(ref)!.state).toBe("open");
  });

  test("success closes the cycle", () => {
    const { ref } = setup("t-win");
    expect(store.closeChainCycleOnTerminal(ref, "succeeded", T0)).toBe(true);
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });
});
