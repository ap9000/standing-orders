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

    // Single-use admission opens the next run.
    const fallbackRun = openRun(1);
    expect(store.admitFallback(cycleId, 3, adv.transitionId, fallbackRun, T0)).toBe(true);
    c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "open", cursor: 1, tailRun: fallbackRun, transitionGeneration: 4 });
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

  test("the admission is SINGLE-USE: a replayed transition cannot open a second run", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    store.beginFallbackSanitize(cycleId, 0, baseRun, T0);
    const adv = store.advanceFallbackFenced(
      { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 2, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
      T0,
    ) as { ok: true; transitionId: number; toIndex: number };
    store.releaseFallbackToPending(cycleId, 2, T0);
    const run1 = openRun(1);
    expect(store.admitFallback(cycleId, 3, adv.transitionId, run1, T0)).toBe(true);
    // Replay the SAME transition — it is consumed, and the state is open,
    // not pending-admission. Both guards refuse; no second run opens.
    const run2 = openRun(2);
    expect(store.admitFallback(cycleId, 3, adv.transitionId, run2, T0)).toBe(false);
    expect(store.admitFallback(cycleId, 4, adv.transitionId, run2, T0)).toBe(false);
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
    // if some caller forced the cycle back to sanitizing at cursor 0.
    store.raw().prepare("UPDATE fallback_cycle SET state = 'sanitizing', cursor = 0, transition_generation = 1 WHERE id = ?").run(cycleId);
    expect(() =>
      store.advanceFallbackFenced(
        { cycleId, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } },
        T0,
      ),
    ).toThrow(/duplicate/);
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

  test("quota-skip advances one step from open, recorded, and refuses at the end", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    const skip = store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 0, chainLength: 3 }, T0);
    expect(skip).toMatchObject({ ok: true, toIndex: 1 });
    const c = store.fallbackCycleFor(taskRef)!;
    expect(c).toMatchObject({ state: "open", cursor: 1, transitionGeneration: 1 });
    // A stale-generation skip loses (cursor 1 is real, but gen 0 is stale).
    expect(store.quotaSkipFallback({ cycleId, expectGeneration: 0, fromIndex: 1, chainLength: 3 }, T0)).toMatchObject({ ok: false, reason: "raced" });
    // The at-end bound refuses before any CAS (fromIndex 2 of a length-3 chain).
    expect(store.quotaSkipFallback({ cycleId, expectGeneration: 1, fromIndex: 2, chainLength: 3 }, T0)).toMatchObject({ ok: false, reason: "at-end" });
  });

  test("incident and close are terminal; a new cycle can only open when none is live", () => {
    const { id: cycleId } = store.openFallbackCycle(taskRef, "d", baseRun, T0) as { ok: true; id: number };
    // A second open refuses while one is live.
    expect(store.openFallbackCycle(taskRef, "d", baseRun, T0)).toEqual({ ok: false });
    expect(store.incidentFallback(cycleId, "sanitizer-failed", T0)).toBe(true);
    expect(store.fallbackCycleFor(taskRef)).toBeNull(); // incident is not "live"
    // Now a fresh cycle can open.
    const two = store.openFallbackCycle(taskRef, "d2", baseRun, T0);
    expect(two.ok).toBe(true);
    if (two.ok) expect(store.closeFallbackCycle(two.id, "succeeded", T0)).toBe(true);
    expect(store.fallbackCycleFor(taskRef)).toBeNull();
  });
});
