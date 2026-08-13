/**
 * Phase-agent resolution: the layers in their stated order, complete pairs
 * from config rows, per-field flags with the one stated rule, and the pin
 * that nothing overrides.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { resolvePhaseAgent, INSTALLATION_SCOPE } from "./agentconfig.js";
import { approveRoutine, fireRoutine, routineDigestOf, type RoutineTerms } from "./routine.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");
const HOUR = 60 * 60_000;

describe("phase-agent resolution", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  test("nothing configured: claude, harness default, source 'default'", () => {
    expect(resolvePhaseAgent(store, "build", "/repo", {})).toEqual({
      ok: true, spec: { provider: "claude", model: null }, source: "default",
    });
  });

  test("installation < project < flags, and rows travel as complete pairs", () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", "sonnet", "alex", T0);
    expect(resolvePhaseAgent(store, "build", "/repo", {})).toMatchObject({
      spec: { provider: "claude", model: "sonnet" }, source: "installation",
    });

    store.setPhaseConfig("/repo", "build", "codex", "gpt-5-codex", "alex", T0);
    expect(resolvePhaseAgent(store, "build", "/repo", {})).toMatchObject({
      spec: { provider: "codex", model: "gpt-5-codex" }, source: "project",
    });
    // Another repo still sees the installation answer.
    expect(resolvePhaseAgent(store, "build", "/other", {})).toMatchObject({
      spec: { provider: "claude", model: "sonnet" }, source: "installation",
    });

    // --provider alone runs that provider's default model — the project
    // row's model never crosses onto a provider it was not written for.
    expect(resolvePhaseAgent(store, "build", "/repo", { provider: "claude" })).toMatchObject({
      spec: { provider: "claude", model: null }, source: "flag",
    });
    // --model alone rides whatever provider resolves.
    expect(resolvePhaseAgent(store, "build", "/repo", { model: "o3" })).toMatchObject({
      spec: { provider: "codex", model: "o3" },
    });
  });

  test("a pinned task agent outranks every flag — the critical finding", () => {
    store.createTask({ id: "t-pin", title: "w" }, T0);
    const ref = store.refFor(BUILT_IN, "t-pin");
    store.pinTaskAgent(ref.id, "codex", "gpt-5-codex");
    const pinned = store.refFor(BUILT_IN, "t-pin");
    expect(
      resolvePhaseAgent(store, "build", "/repo", { provider: "claude", model: "opus" }, pinned),
    ).toMatchObject({ spec: { provider: "codex", model: "gpt-5-codex" }, source: "pinned" });
  });

  test("an invalid resolved pair refuses instead of dispatching", () => {
    // openrouter with no model has no meaning; the refusal names it.
    expect(resolvePhaseAgent(store, "build", "/repo", { provider: "openrouter" })).toMatchObject({
      ok: false,
    });
  });
});

describe("firing pins the agent and re-proves the ceiling against it", () => {
  let store: Store;
  let token: string;

  const TERMS: RoutineTerms = {
    repo: "/work/repo",
    goal: "Refresh the notes",
    outOfScope: null,
    touches: [],
    requirements: [],
    schedule: "every:60",
    singleFlight: true,
    costCeilingUsd: null,
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("setup");
    token = added.token;
  });
  afterEach(() => store.close());

  const arm = (terms: RoutineTerms, name: string): number => {
    const created = store.createRoutine({ name, ...terms, digest: routineDigestOf(terms) }, T0);
    if (!created.ok) throw new Error("setup");
    const approved = approveRoutine(store, created.id, "alex", T0, routineDigestOf(terms), token);
    expect(approved.ok).toBe(true);
    return created.id;
  };

  test("the instance carries the agent the fire resolved — later flags cannot re-route it", () => {
    store.setPhaseConfig("/work/repo", "build", "codex", "gpt-5-codex", "alex", T0);
    const id = arm(TERMS, "notes");
    const fired = fireRoutine(store, id, new Date(T0.getTime() + 2 * HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    const ref = store.refFor(BUILT_IN, fired.taskId);
    expect(ref.agentProvider).toBe("codex");
    expect(ref.agentModel).toBe("gpt-5-codex");
    // Resolution for this task now answers 'pinned', whatever flags say.
    expect(resolvePhaseAgent(store, "build", "/work/repo", { provider: "claude" }, ref)).toMatchObject({
      source: "pinned", spec: { provider: "codex" },
    });
  });

  test("a ceiling against a provider that reports no dollars skips the slot and says why", () => {
    store.setPhaseConfig("/work/repo", "build", "codex", "gpt-5-codex", "alex", T0);
    const id = arm({ ...TERMS, costCeilingUsd: 5 }, "capped");
    const refused = fireRoutine(store, id, new Date(T0.getTime() + 2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "unmeasured" });
    const fires = store.routineFires(id);
    expect(fires[0]).toMatchObject({ outcome: "skipped" });
    expect(fires[0]?.reason).toContain("unmeasured-provider");
    expect(store.listNotifications("all").some(one => one.subject.includes("cannot honor a cost ceiling"))).toBe(true);
    // Drop the provider back to claude: the next slot fires.
    store.clearPhaseConfig("/work/repo", "build");
    const fired = fireRoutine(store, id, new Date(T0.getTime() + 3 * HOUR));
    expect(fired.ok).toBe(true);
  });
});
