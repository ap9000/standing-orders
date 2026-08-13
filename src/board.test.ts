/**
 * The board: one exhaustive classifier over one snapshot.
 *
 * The classifier's contract (Codex board review, findings 1, 2, 6, 7): every
 * task lands in exactly one lane; a parked task is attention, never also
 * waiting through its own decision hold; a claim legitimately precedes its
 * run and the card says so; "queued" claims only task-local readiness.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { classify, type BoardFacts } from "./board.js";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";

const T0 = new Date("2026-08-01T12:00:00Z");

function facts(overrides: Partial<BoardFacts> = {}): BoardFacts {
  return {
    taskId: "t-1",
    title: "the work",
    repo: null,
    state: "queued",
    updatedAt: T0.toISOString(),
    strikes: 0,
    hasScope: true,
    approved: true,
    plan: null,
    goal: null,
    openDecisionId: null,
    question: null,
    decisionCreatedAt: null,
    openIncidents: 0,
    oldestIncidentAt: null,
    blockerState: null,
    claim: null,
    hold: null,
    unmetDependency: null,
    missingRequirement: null,
    ...overrides,
  };
}

describe("the lane classifier", () => {
  test("task-local readiness satisfied lands in queued — and claims nothing about the fleet", () => {
    const card = classify(facts(), T0);
    expect(card.lane).toBe("queued");
    expect(card.reason).toBe("ready");
  });

  test("a live claim is building, whatever else is true of the task", () => {
    const card = classify(
      facts({
        state: "running",
        openDecisionId: 7,
        hold: { ownerKind: "decision", until: null },
        claim: { runner: "builder-1", claimedAt: T0.toISOString(), model: "claude", branch: "nightorders/t-1", worktree: "/pool/t-1", role: "builder" },
      }),
      T0,
    );
    expect(card.lane).toBe("building");
    expect(card.reason).toBe("builder-1");
  });

  test("a claim before its run exists says it is preparing, not lying about a model", () => {
    const card = classify(
      facts({ claim: { runner: "builder-1", claimedAt: T0.toISOString(), model: null, branch: null, worktree: null, role: null } }),
      T0,
    );
    expect(card.lane).toBe("building");
    expect(card.reason).toBe("builder-1 · preparing workspace");
  });

  test("a parked task is attention exactly once — its decision hold does not double it into waiting", () => {
    const card = classify(
      facts({ state: "running", openDecisionId: 42, hold: { ownerKind: "decision", until: null } }),
      T0,
    );
    expect(card.lane).toBe("attention");
    expect(card.reason).toBe("answer a question");
    expect(card.href).toBe("/d/42");
  });

  test("failed, incidents, no scope, unapproved scope, and orphaned running each need a person", () => {
    expect(classify(facts({ state: "failed", strikes: 3 }), T0).reason).toBe("failed after 3 attempts");
    expect(classify(facts({ openIncidents: 2 }), T0).reason).toBe("stopped — 2 incidents");
    expect(classify(facts({ hasScope: false, approved: false }), T0).reason).toBe("write its scope");
    expect(classify(facts({ approved: false }), T0).reason).toBe("approve its scope");
    const orphan = classify(facts({ state: "running" }), T0);
    expect(orphan.lane).toBe("attention");
    expect(orphan.reason).toBe("build vanished — needs repair");
  });

  test("waiting names its one reason: hold beats dependency beats requirement", () => {
    const held = classify(
      facts({
        hold: { ownerKind: "operator", until: null },
        unmetDependency: "t-0",
        missingRequirement: "env:KEY",
      }),
      T0,
    );
    expect(held.lane).toBe("waiting");
    expect(held.reason).toBe("held by you");
    expect(
      classify(facts({ hold: { ownerKind: "backoff", until: "2026-08-01T14:32:00Z" } }), T0).reason,
    ).toBe("retrying 14:32");
    expect(
      classify(facts({ hold: { ownerKind: "backoff", until: "2026-08-01T11:00:00Z" } }), T0).reason,
    ).toBe("retrying now");
    expect(classify(facts({ unmetDependency: "t-0" }), T0).reason).toBe("waits on t-0");
    expect(classify(facts({ missingRequirement: "env:KEY" }), T0).reason).toBe("needs env:KEY");
  });

  test("the card accretes: question as content, goal as promise, blocker state, attempt", () => {
    const asked = classify(
      facts({ openDecisionId: 5, question: "Fail open or fail closed?", decisionCreatedAt: "2026-08-01T09:00:00Z" }),
      T0,
    );
    expect(asked.reason).toBe("Fail open or fail closed?");
    expect(asked.stalledSince).toBe("2026-08-01T09:00:00Z");

    expect(classify(facts({ goal: "One row per real job across boards" }), T0).reason).toBe(
      "One row per real job across boards",
    );

    expect(
      classify(facts({ unmetDependency: "t-0", blockerState: "running" }), T0).reason,
    ).toBe("waits on t-0 — building now");
    expect(
      classify(facts({ unmetDependency: "t-0", blockerState: "failed" }), T0).reason,
    ).toBe("waits on t-0 — failed");
    // Redacted blocker state: the name stays, the other project's status
    // does not.
    expect(classify(facts({ unmetDependency: "t-0" }), T0).reason).toBe("waits on t-0");

    const secondTry = classify(
      facts({
        strikes: 1,
        claim: { runner: "r", claimedAt: T0.toISOString(), model: "claude", branch: "b", worktree: "/w", role: "builder" },
      }),
      T0,
    );
    expect(secondTry.attempt).toBe(2);
  });

  test("total: every combination lands in exactly one lane", () => {
    const holds: BoardFacts["hold"][] = [null, { ownerKind: "operator", until: null }];
    const claims: BoardFacts["claim"][] = [
      null,
      { runner: "r", claimedAt: T0.toISOString(), model: null, branch: null, worktree: null, role: null },
    ];
    for (const state of ["queued", "running", "failed"] as const) {
      for (const hasScope of [true, false]) {
        for (const approved of [true, false]) {
          for (const openDecisionId of [null, 1]) {
            for (const hold of holds) {
              for (const claim of claims) {
                const card = classify(
                  facts({ state, hasScope, approved, openDecisionId, hold, claim }),
                  T0,
                );
                expect(["attention", "queued", "waiting", "building"]).toContain(card.lane);
              }
            }
          }
        }
      }
    }
  });
});

describe("boardScoped — one snapshot, all the facts", () => {
  let store: Store;

  const approvedScope = (taskId: string) =>
    store.saveScope({
      taskId,
      goal: "do the thing",
      outOfScope: null,
      touches: [],
      proposedAt: T0.toISOString(),
      digest: "d1",
      approvedAt: T0.toISOString(),
      approvedBy: "alex",
      approvedDigest: "d1",
    });

  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  test("a claimed task carries its run's provenance; a claim without a run carries honest nulls", () => {
    const now = new Date(T0.getTime() + 60_000);
    store.createTask({ id: "t-run", title: "with a run" }, T0);
    store.createTask({ id: "t-bare", title: "claim only" }, T0);
    const withRun = store.refFor("built-in", "t-run").id;
    const bare = store.refFor("built-in", "t-bare").id;
    approvedScope("t-run");
    approvedScope("t-bare");

    const taken = acquire(store, withRun, "builder-1", { now, ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({
      taskRef: withRun,
      leaseId: taken.claim.leaseId,
      runner: "builder-1",
      branch: "nightorders/t-run",
      worktree: "/pool/t-run",
      model: "claude",
      now,
    });
    const bareTaken = acquire(store, bare, "builder-2", { now, ttlMs: 60 * 60_000 });
    if (!bareTaken.ok) throw new Error("claim refused");

    const board = store.boardScoped(null, new Date(now.getTime() + 5 * 60_000));
    const one = board.tasks.find(row => row.taskId === "t-run");
    expect(one?.claim).toMatchObject({
      runner: "builder-1",
      model: "claude",
      branch: "nightorders/t-run",
      worktree: "/pool/t-run",
    });
    const other = board.tasks.find(row => row.taskId === "t-bare");
    expect(other?.claim).toMatchObject({ runner: "builder-2", model: null, branch: null, worktree: null, role: null });
  });

  test("a parked task reports both the open decision and its hold — and classifies once", () => {
    const now = new Date(T0.getTime() + 60_000);
    store.createTask({ id: "t-parked", title: "asked a question" }, T0);
    const ref = store.refFor("built-in", "t-parked").id;
    approvedScope("t-parked");
    const taken = acquire(store, ref, "builder-1", { now, ttlMs: 60_000 });
    if (!taken.ok) throw new Error("claim refused");
    const run = store.startRun({
      taskRef: ref,
      leaseId: taken.claim.leaseId,
      runner: "builder-1",
      branch: "nightorders/t-parked",
      worktree: "/pool/t-parked",
      now,
    });
    const decisionId = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "recap",
        question: "which way?",
        options: [{ id: "a", label: "A", consequence: "fine", reversible: true }],
        recommendation: "a",
      },
      now,
    );
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: String(decisionId), reason: "parked", until: null },
      now,
    );
    release(store, taken.claim.leaseId, now);

    const later = new Date(now.getTime() + 5 * 60_000);
    const board = store.boardScoped(null, later);
    const one = board.tasks.find(row => row.taskId === "t-parked");
    expect(one?.openDecisionId).toBe(decisionId);
    expect(one?.hold).toMatchObject({ ownerKind: "decision" });
    const card = classify(one as BoardFacts, later);
    expect(card.lane).toBe("attention");
    expect(card.href).toBe(`/d/${decisionId}`);
  });

  test("dependencies and requirement gaps are named; a verified capability clears the gap", () => {
    store.createTask({ id: "t-blocked", title: "waits" }, T0);
    store.createTask({ id: "t-first", title: "goes first" }, T0);
    store.addEdge("t-blocked", "t-first");
    approvedScope("t-blocked");
    approvedScope("t-first");

    store.createTask({ id: "t-needs", title: "needs a key" }, T0);
    const needs = store.refFor("built-in", "t-needs").id;
    store.placeTask(needs, "/repo/main");
    store.setRequirements(needs, ["env:STRIPE_KEY"]);
    approvedScope("t-needs");

    const before = store.boardScoped(null, T0);
    expect(before.tasks.find(row => row.taskId === "t-blocked")?.unmetDependency).toBe("t-first");
    expect(before.tasks.find(row => row.taskId === "t-needs")?.missingRequirement).toBe("env:STRIPE_KEY");

    store.saveCapability({
      repo: "/repo/main",
      kind: "env",
      name: "STRIPE_KEY",
      probe: null,
      status: "verified",
      addedBy: "alex",
      createdAt: T0.toISOString(),
      lastVerifiedAt: T0.toISOString(),
      verifiedBy: "builder-1",
      lastResult: null,
      expiresAt: null,
    });
    const after = store.boardScoped(null, T0);
    expect(after.tasks.find(row => row.taskId === "t-needs")?.missingRequirement).toBeNull();
  });

  test("the ceiling holds: another repo's tasks are not on this board", () => {
    store.createTask({ id: "t-ours", title: "ours" }, T0);
    store.createTask({ id: "t-theirs", title: "theirs" }, T0);
    store.placeTask(store.refFor("built-in", "t-ours").id, "/repo/main");
    store.placeTask(store.refFor("built-in", "t-theirs").id, "/repo/other");

    const board = store.boardScoped("/repo/main", T0);
    expect(board.tasks.map(row => row.taskId)).toContain("t-ours");
    expect(board.tasks.map(row => row.taskId)).not.toContain("t-theirs");
  });

  test("the cap is honest, and an old stall is rescued past it", () => {
    // Three tasks, created oldest-first; each is an attention candidate
    // (no approved scope). Under a cap of 2 the newest page holds two,
    // saturation is declared — and the oldest stall still reaches the
    // board through the attention page (Codex round 2, finding 11).
    for (let i = 0; i < 3; i++) {
      store.createTask({ id: `t-${i}`, title: `t ${i}` }, new Date(T0.getTime() + i * 60_000));
    }
    const capped = store.boardScoped(null, T0, 2);
    expect(capped.saturated).toBe(true);
    expect(capped.tasks.map(row => row.taskId)).toContain("t-0");
    const roomy = store.boardScoped(null, T0, 50);
    expect(roomy.tasks).toHaveLength(3);
    expect(roomy.saturated).toBe(false);
  });

  test("the admission list bounds the page itself, not just the render", () => {
    store.createTask({ id: "t-in", title: "admitted" }, T0);
    store.createTask({ id: "t-out", title: "beyond the ceiling" }, T0);
    store.placeTask(store.refFor("built-in", "t-in").id, "/repo/main");
    store.placeTask(store.refFor("built-in", "t-out").id, "/repo/other");
    const board = store.boardScoped(null, T0, 200, ["/repo/main"]);
    expect(board.tasks.map(row => row.taskId)).toContain("t-in");
    expect(board.tasks.map(row => row.taskId)).not.toContain("t-out");
  });

  test("the snapshot carries the accretion facts: goal, question, blocker state", () => {
    const now = new Date(T0.getTime() + 60_000);
    store.createTask({ id: "t-first", title: "goes first" }, T0);
    store.createTask({ id: "t-second", title: "waits behind" }, T0);
    store.addEdge("t-second", "t-first");
    store.setTaskState("t-first", "running", now);
    approvedScope("t-second");

    const board = store.boardScoped(null, now);
    const second = board.tasks.find(row => row.taskId === "t-second");
    expect(second?.goal).toBe("do the thing");
    expect(second?.unmetDependency).toBe("t-first");
    expect(second?.blockerState).toBe("running");
    expect(second?.blockerRepo).toBeNull();
  });
});
