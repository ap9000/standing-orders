/**
 * THE CURRENT-CLAIM TUPLE INVARIANT, as one isolated mutation matrix (repair
 * custody closure): every admission that changes fallback state — the base
 * that opens the cycle, an entry admitted from a pending edge, a parked
 * tail's resume on the primary and the fallback road, a repair turn on the
 * primary and the fallback road — proves inside its own transaction that
 * the run it opens is this task's, under the lease that holds the task RIGHT
 * NOW, on the runner that claim names. For every road, every way the claim
 * can disagree — the SAME lease held by another machine, a lease the caller
 * names that is not the claim, an expired claim, a released one, one
 * superseded by a newer generation, and no claim at all — is applied to a
 * snapshot of the database, the admission is asked, and the database is
 * proved byte-for-byte unchanged: no run, no route, no cycle, no tail, no
 * edge, no claim moved. Then the exact statement admits, so the fixture is
 * shown to be otherwise sound.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, chainDigestOf, entryDigestOf } from "./scope.js";
import type { RouteStamp } from "./phase-routing.js";
import * as routing from "./phase-routing.js";

// The recognizer is mocked exactly as the fallback-cycle suite mocks it: the
// advance off the base needs an eligible exhaustion, nothing else.
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
const REPO = "/repos/chain";
const RUNNER = "b-1";

type Road = "base" | "entry" | "resume" | "fallback-resume" | "primary-repair" | "fallback-repair";
const ROADS: readonly Road[] = ["base", "entry", "resume", "fallback-resume", "primary-repair", "fallback-repair"];

type Mutation = "wrong-runner" | "lease-mismatch" | "expired" | "released" | "superseded" | "nothing-holds";
const MUTATIONS: readonly Mutation[] = ["wrong-runner", "lease-mismatch", "expired", "released", "superseded", "nothing-holds"];

/** The words every road refuses a claim disagreement in: the SAME sentence
 * `custodyClaimProblem` gives, whatever road asked. `lease-mismatch` is the
 * one case a road may refuse earlier in its own words — a repair turn says
 * the parent's lease is not the caller's before the claim is even read —
 * so it accepts either. */
const words = (mutation: Mutation, lease: string): RegExp => {
  switch (mutation) {
    case "wrong-runner":
      return new RegExp(`this task's live claim ${lease} is held by other-machine — .* on ${RUNNER} is another machine's`);
    case "lease-mismatch":
      return new RegExp(`lease l-stranger is not this task's current live claim \\(${lease} does\\)|a repair turn under lease l-stranger is not its own`);
    case "expired":
    case "released":
    case "nothing-holds":
      return new RegExp(`lease ${lease} is not this task's current live claim \\(nothing holds it\\)`);
    case "superseded":
      return new RegExp(`lease ${lease} is not this task's current live claim \\(l-super does\\)`);
  }
};

describe("the current-claim tuple invariant: one mutation matrix over every fallback state-changing admission", () => {
  let store: Store;
  let ref: number;
  let token: string;

  const hold = (lease: string, runner = RUNNER): void => {
    const generation = Number((store.raw().prepare("SELECT COALESCE(MAX(lease_generation), 0) + 1 AS g FROM claim WHERE task_ref = ?").get(ref) as { g: number }).g);
    store
      .raw()
      .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(lease, ref, generation, runner, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
  };
  const presented = (role: "builder" | "repair", bound: { index: number; entryDigest: string } | null = null): { route: RouteStamp } => {
    const authority = store.routeAuthorityFor(ref, role, bound);
    if (authority === null || !authority.ok) throw new Error(`no ${role} authority`);
    return { route: authority.stamp };
  };
  const entryArgs = (index: number) => {
    const chain = store.approvedChainOf("t-1");
    if (chain === null) throw new Error("no approved chain");
    const entry = chain[index];
    if (entry === undefined) throw new Error(`no entry ${index}`);
    const sealed = store.sealedRouteOf("t-1");
    if (!sealed.ok) throw new Error("no sealed route");
    const mirror = store.getScope("t-1")?.approvedProfile ?? null;
    if (mirror === null) throw new Error("no approved profile mirror");
    return {
      approved: { chainDigest: chainDigestOf(chain), profile: mirror },
      entryDigest: entryDigestOf(entry),
      authMode: entry.authMode,
      repairModel: entry.profile.repairModel === "inherit" ? entry.profile.model : entry.profile.repairModel,
      provider: entry.profile.provider,
      model: entry.profile.model,
      route: { routeDigest: routing.routeDigestOf(sealed.route), phase: "build" as const, provider: entry.profile.provider, model: entry.profile.model, chosen: "fallback" as const },
    };
  };

  /** Every table an admission could write, read whole and in a fixed order —
   * the before-and-after fact the matrix compares. */
  const snapshot = () => {
    const db = store.raw();
    return {
      run: db.prepare("SELECT * FROM run ORDER BY id").all(),
      route: db.prepare("SELECT * FROM run_route ORDER BY run").all(),
      cycle: db.prepare("SELECT * FROM fallback_cycle ORDER BY id").all(),
      edges: db.prepare("SELECT * FROM fallback_transition ORDER BY id").all(),
      claim: db.prepare("SELECT * FROM claim ORDER BY lease_id").all(),
      sqlite: db.prepare("SELECT total_changes() AS n").get(),
    };
  };

  /** Apply one claim disagreement to the live claim `lease`; returns the
   * lease the caller should present, and the undo. */
  const mutate = (mutation: Mutation, lease: string): { present: string; undo: () => void } => {
    const db = store.raw();
    switch (mutation) {
      case "wrong-runner":
        db.prepare("UPDATE claim SET runner = 'other-machine' WHERE lease_id = ?").run(lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET runner = ? WHERE lease_id = ?").run(RUNNER, lease) };
      case "lease-mismatch":
        return { present: "l-stranger", undo: () => undefined };
      case "expired":
        db.prepare("UPDATE claim SET expires_at = ? WHERE lease_id = ?").run(new Date(T0.getTime() - 1).toISOString(), lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET expires_at = ? WHERE lease_id = ?").run(new Date(T0.getTime() + 900_000).toISOString(), lease) };
      case "released":
        db.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = ?").run(T0.toISOString(), lease);
        return { present: lease, undo: () => db.prepare("UPDATE claim SET released_at = NULL, released_by = NULL WHERE lease_id = ?").run(lease) };
      case "superseded":
        hold("l-super");
        return { present: lease, undo: () => db.prepare("DELETE FROM claim WHERE lease_id = 'l-super'").run() };
      case "nothing-holds": {
        const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(lease) as Record<string, unknown>;
        db.prepare("DELETE FROM claim WHERE lease_id = ?").run(lease);
        return {
          present: lease,
          undo: () =>
            db
              .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(row["lease_id"], row["task_ref"], row["lease_generation"], row["runner"], row["acquired_at"], row["expires_at"], row["heartbeat_at"], row["released_at"], row["released_by"]),
        };
      }
    }
  };

  /** One road, brought to the instant before its admission: `lease` is the
   * live claim the exact statement admits under; `admit(lease)` asks the
   * road, returning the refusal's words or the run id. */
  const arrange = (road: Road): { lease: string; admit: (lease: string) => { ok: true; runId: number } | { ok: false; problem: string } } => {
    const asWords = (body: () => number): { ok: true; runId: number } | { ok: false; problem: string } => {
      try {
        return { ok: true, runId: body() };
      } catch (error) {
        return { ok: false, problem: error instanceof Error ? error.message : String(error) };
      }
    };
    const base = (lease: string) =>
      asWords(() => store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w", provider: "claude", now: T0, ...presented("builder"), custody: { kind: "base" } }));
    if (road === "base") {
      hold("l-base");
      return { lease: "l-base", admit: base };
    }
    hold("l-base");
    const baseRun = base("l-base");
    if (!baseRun.ok) throw new Error(baseRun.problem);
    const cycle = store.fallbackCycleFor(ref);
    if (cycle === null) throw new Error("no cycle");
    if (road === "primary-repair") {
      return {
        lease: "l-base",
        admit: lease =>
          store.admitRepair({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w", provider: "claude", parentRun: baseRun.runId, now: T0, ...presented("repair") }),
      };
    }
    if (road === "resume") {
      store.finishRun(baseRun.runId, { outcome: "parked", reason: "decision", now: T0 });
      expect(store.resolveChainOnRunEnd(ref, "t-1", REPO, baseRun.runId, T0)).toEqual({ kind: "parked-tail" });
      store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'l-base'").run(T0.toISOString());
      hold("l-resume");
      return {
        lease: "l-resume",
        admit: lease =>
          asWords(() => store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w2", provider: "claude", now: T0, ...presented("builder"), custody: { kind: "resume", parkedRun: baseRun.runId } })),
      };
    }
    // The chain advances off the exhausted base to a pending edge at entry 1.
    expect(store.beginFallbackSanitize(cycle.id, 0, baseRun.runId, T0)).toBe(true);
    const adv = store.advanceFallbackFenced({ cycleId: cycle.id, expectGeneration: 1, fromIndex: 0, chainLength: 3, predecessorRun: baseRun.runId, terminalClass: "usage-exhausted", evidence: { provider: "claude", version: "1.0.0", authMode: "subscription", fp: "" } }, T0);
    if (!adv.ok) throw new Error("advance");
    expect(store.releaseFallbackToPending(cycle.id, 2, T0)).toBe(true);
    store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'l-base'").run(T0.toISOString());
    const e1 = entryArgs(1);
    const entry = (lease: string) =>
      store.admitFallback(
        {
          kind: "entry", cycleId: cycle.id, expectGeneration: 3, expectCursor: 1, expectTail: null, transitionId: adv.transitionId,
          run: { taskRef: ref, leaseId: lease, runner: RUNNER, branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.model },
          entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, approved: e1.approved, route: e1.route,
        },
        T0,
      );
    if (road === "entry") {
      hold("l-entry");
      return { lease: "l-entry", admit: entry };
    }
    hold("l-entry");
    const admitted = entry("l-entry");
    if (!admitted.ok) throw new Error(admitted.problem);
    if (road === "fallback-repair") {
      return {
        lease: "l-entry",
        admit: lease =>
          store.admitFallback(
            {
              kind: "repair", parentRun: admitted.runId, cycleId: cycle.id, expectCursor: 1, expectTail: admitted.runId,
              run: { taskRef: ref, leaseId: lease, runner: RUNNER, branch: "bf", worktree: "/wf", provider: e1.provider, model: e1.repairModel },
              entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, approved: e1.approved, route: { ...e1.route, phase: "repair" },
            },
            T0,
          ),
      };
    }
    // fallback-resume: the entry parks, its claim is handed back, a new one holds.
    store.finishRun(admitted.runId, { outcome: "parked", reason: "decision", now: T0 });
    expect(store.resolveChainOnRunEnd(ref, "t-1", REPO, admitted.runId, T0)).toEqual({ kind: "parked-tail" });
    store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'l-entry'").run(T0.toISOString());
    hold("l-fresume");
    return {
      lease: "l-fresume",
      admit: lease =>
        store.admitFallback(
          {
            kind: "resume", parkedRun: admitted.runId, cycleId: cycle.id, expectCursor: 1, expectTail: admitted.runId,
            run: { taskRef: ref, leaseId: lease, runner: RUNNER, branch: "bf", worktree: "/ws", provider: e1.provider, model: e1.model },
            entryDigest: e1.entryDigest, authMode: e1.authMode, repairModel: e1.repairModel, approved: e1.approved, route: e1.route,
          },
          T0,
        ),
    };
  };

  beforeEach(() => {
    rec.eligible.clear();
    rec.eligible.add("claude:1.0.0:subscription");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }, { provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    token = added.token;
    store.createTask({ id: "t-1", title: "the work" }, T0);
    ref = store.refFor("built-in", "t-1").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
    expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, token).ok).toBe(true);
  });
  afterEach(() => store.close());

  for (const road of ROADS) {
    test(`${road}: every claim disagreement refuses in the shared words and writes nothing; the exact statement then admits`, () => {
      const { lease, admit } = arrange(road);
      for (const mutation of MUTATIONS) {
        const { present, undo } = mutate(mutation, lease);
        const before = snapshot();
        const result = admit(present);
        expect(result.ok, `${road} under ${mutation} admitted run #${result.ok ? result.runId : "?"}`).toBe(false);
        if (!result.ok) expect(result.problem).toMatch(words(mutation, lease));
        // WRITE-FREE: every table the admission could touch is exactly as
        // it was, and SQLite counted no change at all.
        expect(snapshot()).toEqual(before);
        undo();
      }
      // The exact statement — this task, this lease, this runner — admits,
      // and its row carries a route.
      const admitted = admit(lease);
      expect(admitted.ok, admitted.ok ? "" : admitted.problem).toBe(true);
      if (!admitted.ok) return;
      expect(store.getRun(admitted.runId)).toMatchObject({ taskRef: ref, leaseId: lease, runner: RUNNER });
      expect(store.runRoute(admitted.runId)).not.toBeNull();
      const cycle = store.fallbackCycleFor(ref);
      expect(cycle).not.toBeNull();
      // The cycle's tail is the admitted run for every road but a repair
      // turn, which spends under its parent's custody.
      if (road === "primary-repair" || road === "fallback-repair") expect(cycle!.tailRun).toBe(store.getRun(admitted.runId)!.parentRun);
      else expect(cycle!.tailRun).toBe(admitted.runId);
    });
  }

  test("the six roads' refusals share one sentence for the same-lease wrong-runner case, primary repair included", () => {
    const seen = new Map<Road, string>();
    for (const road of ROADS) {
      const { lease, admit } = arrange(road);
      const { present, undo } = mutate("wrong-runner", lease);
      const result = admit(present);
      expect(result.ok).toBe(false);
      if (!result.ok) seen.set(road, result.problem.replace(/^.*?(this task's live claim)/, "$1"));
      undo();
      store.close();
      store = openStore(":memory:");
      // Rebuild the fixture for the next road.
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
      store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }, { provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
      const added = addApprover(store, "alex", T0);
      if (!added.ok) throw new Error("approver");
      store.createTask({ id: "t-1", title: "the work" }, T0);
      ref = store.refFor("built-in", "t-1").id;
      store.placeTask(ref, REPO);
      propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
      expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, added.token).ok).toBe(true);
    }
    expect(seen.get("primary-repair")).toBe("this task's live claim l-base is held by other-machine — a repair turn on b-1 is another machine's");
    expect(seen.get("fallback-repair")).toBe("this task's live claim l-entry is held by other-machine — a fallback repair turn on b-1 is another machine's");
    expect(seen.get("base")).toBe("this task's live claim l-base is held by other-machine — base custody on b-1 is another machine's");
    expect(seen.get("entry")).toBe("this task's live claim l-entry is held by other-machine — a fallback entry on b-1 is another machine's");
    expect(seen.get("resume")).toBe("this task's live claim l-resume is held by other-machine — a parked tail's resume on b-1 is another machine's");
    expect(seen.get("fallback-resume")).toBe("this task's live claim l-fresume is held by other-machine — a fallback resume on b-1 is another machine's");
  });
});
