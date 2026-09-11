/**
 * Phase-agent resolution: the layers in their stated order, complete pairs
 * from config rows, per-field flags with the one stated rule, and the pin
 * that nothing overrides.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { resolvePhaseAgent, resolveRouteCandidates, routeOfTask, INSTALLATION_SCOPE } from "./agentconfig.js";
import { approveRoutine, fireRoutine, routineDigestOf, type RoutineTerms } from "./routine.js";
import { resolveScopeProfile, resolveRoutineAuthority, agentChoicesFor } from "./agentconfig.js";

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

  test("gemini is NEVER a default or fallback — it dispatches only on explicit selection (the trust-posture invariant)", () => {
    // The operator's ruling (2026-08-29): gemini's workspace-trust grant
    // is acceptable BECAUSE gemini runs only when deliberately chosen. So
    // no default/fallback road may ever resolve to gemini: an unconfigured
    // phase is claude, an unconfigured repo is claude, and a broken config
    // refuses rather than silently landing on gemini.
    for (const phase of ["plan", "build", "repair", "review"] as const) {
      expect(resolvePhaseAgent(store, phase, "/repo", {})).toMatchObject({ spec: { provider: "claude" }, source: "default" });
    }
    // Gemini appears ONLY when explicitly named — a config row, a flag, or
    // a pin — each a deliberate operator act.
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "gemini", "gemini-2.5-pro", "alex", T0);
    expect(resolvePhaseAgent(store, "build", "/repo", {})).toMatchObject({ spec: { provider: "gemini" }, source: "installation" });
    expect(resolvePhaseAgent(store, "build", "/repo", { provider: "gemini", model: "gemini-2.5-pro" })).toMatchObject({
      spec: { provider: "gemini" }, source: "flag",
    });
    // And a DIFFERENT phase with no gemini row still resolves to claude —
    // one phase's explicit gemini never leaks onto another.
    expect(resolvePhaseAgent(store, "plan", "/repo", {})).toMatchObject({ spec: { provider: "claude" }, source: "default" });
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

  test("an unset reviewer inherits the planner, while an explicit review route wins", () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "plan", "claude", "opus", "alex", T0);
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "codex", "gpt-6-astra", "alex", T0);
    expect(resolvePhaseAgent(store, "review", "/repo", {})).toMatchObject({
      spec: { provider: "claude", model: "opus" }, source: "installation",
    });

    store.setPhaseConfig(INSTALLATION_SCOPE, "review", "codex", "gpt-6-astra", "alex", T0);
    expect(resolvePhaseAgent(store, "review", "/repo", {})).toMatchObject({
      spec: { provider: "codex", model: "gpt-6-astra" }, source: "installation",
    });
  });

  test("gemini has no fail-closed isolation for review yet — refused however it was resolved: config, flag, or pin", () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "review", "gemini", "gemini-2.5-pro", "alex", T0);
    expect(resolvePhaseAgent(store, "review", "/repo", {})).toMatchObject({ ok: false });
    // build is untouched — the refusal is review-specific.
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "gemini", "gemini-2.5-pro", "alex", T0);
    expect(resolvePhaseAgent(store, "build", "/repo", {})).toMatchObject({ ok: true, spec: { provider: "gemini" } });

    expect(resolvePhaseAgent(store, "review", "/repo", { provider: "gemini", model: "gemini-2.5-pro" })).toMatchObject({ ok: false });

    store.createTask({ id: "t-gem", title: "w" }, T0);
    const ref = store.refFor(BUILT_IN, "t-gem");
    store.pinTaskAgent(ref.id, "gemini", "gemini-2.5-pro");
    const pinned = store.refFor(BUILT_IN, "t-gem");
    expect(resolvePhaseAgent(store, "review", "/repo", {}, pinned)).toMatchObject({ ok: false });
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

  test("Full access resolves to Codex's danger-full-access profile", () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPermissionDefault("bypassPermissions", "alex", T0);

    expect(resolveScopeProfile(store, "/repo", undefined, {})).toMatchObject({
      ok: true,
      profile: { provider: "codex", sandboxMode: "danger-full-access" },
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
    acceptance: [{ id: "c1", statement: "The notes are refreshed.", how: null, evidence: ["manual-review"] }],
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
    // v24/v48: filing resolves the profile AND the four-role route from the
    // config the test just set, exactly as fileRoutineProposal does — the
    // digest binds both.
    const authority = resolveRoutineAuthority(store, terms.repo, terms.acceptance, T0);
    if (!authority.ok) throw new Error(`setup: ${authority.problem}`);
    const digest = routineDigestOf(terms, authority.profile, authority.route);
    const created = store.createRoutine({ name, ...terms, digest, profile: authority.profile, route: authority.route }, T0);
    if (!created.ok) throw new Error("setup");
    const approved = approveRoutine(store, created.id, "alex", T0, digest, token);
    expect(approved.ok).toBe(true);
    return created.id;
  };

  test("the instance carries the agent the fire resolved — later flags cannot re-route it", () => {
    store.setPhaseConfig("/work/repo", "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/work/repo", "plan", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/work/repo", "review", "codex", "gpt-5-codex", "alex", T0);
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
    store.setPhaseConfig("/work/repo", "plan", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/work/repo", "review", "codex", "gpt-5-codex", "alex", T0);
    const id = arm({ ...TERMS, costCeilingUsd: 5 }, "capped");
    const refused = fireRoutine(store, id, new Date(T0.getTime() + 2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "unmeasured" });
    const fires = store.routineFires(id);
    expect(fires[0]).toMatchObject({ outcome: "skipped" });
    expect(fires[0]?.reason).toContain("unmeasured-provider");
    expect(store.listNotifications("all").some(one => one.subject.includes("cannot honor a cost ceiling"))).toBe(true);
    // v24: dropping the config is no longer enough — the approved profile
    // IS the routing. The road is restatement onto claude and a fresh yes.
    store.clearPhaseConfig("/work/repo", "build");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    const restated = resolveRoutineAuthority(store, "/work/repo", TERMS.acceptance, T0);
    if (!restated.ok) throw new Error(restated.problem);
    const terms = { ...TERMS, costCeilingUsd: 5 };
    const newDigest = routineDigestOf(terms, restated.profile, restated.route);
    expect(store.updateRoutineTerms(id, { ...terms, digest: newDigest, profile: restated.profile, route: restated.route }, new Date(T0.getTime() + 2 * HOUR))).toBe(true);
    expect(approveRoutine(store, id, "alex", new Date(T0.getTime() + 2 * HOUR), newDigest, token).ok).toBe(true);
    const fired = fireRoutine(store, id, new Date(T0.getTime() + 3 * HOUR));
    expect(fired.ok).toBe(true);
  });
});

describe("route candidates and the task route (v47)", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  const exactInstall = () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig(INSTALLATION_SCOPE, "review", "claude", "sonnet", "test", T0);
  };

  test("every candidate is exact: a phase with no model id refuses with the words to fix it — nothing is inferred", () => {
    // Only the build named a model: the planner cannot be a candidate.
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", "sonnet", "test", T0);
    const bare = resolveRouteCandidates(store, "/repo");
    expect(bare).toMatchObject({ ok: false, phase: "plan" });
    if (bare.ok) return;
    expect(bare.problem).toContain("config set plan --provider claude --model <model>");
    exactInstall();
    const exact = resolveRouteCandidates(store, "/repo");
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.candidates.build).toEqual({ routine: { provider: "claude", model: "sonnet", source: "installation" }, strong: null });
    expect(exact.candidates.plan.routine).toEqual({ provider: "claude", model: "sonnet", source: "installation" });
    // Repair with no row: null — the policy inherits the build leg.
    expect(exact.candidates.repair).toEqual({ routine: null, strong: null });
    expect(exact.candidates.review.strong).toBeNull();
  });

  test("agent choices (v48): role-specific — only the pairs the active configuration names FOR that role are selectable; gemini never reviews, repair stays on the build provider; a stale current agent is display-only; a bare configuration offers nothing", () => {
    expect(agentChoicesFor(store, "/repo", null)).toEqual({ plan: [], build: [], repair: [], review: [] });
    exactInstall();
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "strong", "gemini", "gemini-2.5-pro", "alex", T0);
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "review", "strong", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/repo", "repair", "claude", "haiku", "alex", T0);
    const bare = agentChoicesFor(store, "/repo", null);
    const pairs = (list: { provider: string; model: string }[]) => list.map(one => `${one.provider} · ${one.model}`);
    // Each role offers ITS configured agents, not every role's pooled together.
    expect(pairs(bare.plan)).toEqual(["claude · sonnet"]);
    expect(pairs(bare.build)).toEqual(["claude · sonnet", "gemini · gemini-2.5-pro"]);
    expect(pairs(bare.review)).toEqual(["claude · sonnet", "codex · gpt-5-codex"]);
    // Repair: the configured repair row and the build role's agents, on the build provider.
    expect(pairs(bare.repair)).toEqual(["claude · haiku", "claude · sonnet"]);
    expect(Object.values(bare).flat().every(one => one.selectable)).toBe(true);
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor(BUILT_IN, "t");
    store.placeTask(ref.id, "/repo");
    propose(store, { taskId: "t", goal: "g", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], riskLevel: "high", now: T0 });
    const routed = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    if (routed === null || routed.kind !== "route") throw new Error("expected a route");
    expect(routed.route.legs.find(one => one.phase === "build")).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro" });
    const withRoute = agentChoicesFor(store, "/repo", routed.route);
    // The build leg runs gemini, so repair follows gemini: the configured
    // build agent on that provider is the one selectable choice.
    expect(pairs(withRoute.repair)).toEqual(["gemini · gemini-2.5-pro"]);
    expect(withRoute.build.find(one => one.provider === "gemini")).toMatchObject({ current: true, selectable: true });
    expect(withRoute.review.every(one => one.provider !== "gemini")).toBe(true);
    expect(withRoute.review.find(one => one.model === "gpt-5-codex")).toMatchObject({ current: true, selectable: true });
    // A current leg the configuration no longer names (an override typed
    // on the CLI) is shown for what runs today — never offered again.
    store.editTaskRoute(ref.id, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "plan", provider: "codex", model: "o3" } }, T0);
    const overridden = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    if (overridden === null || overridden.kind !== "route") throw new Error("expected a route");
    const stale = agentChoicesFor(store, "/repo", overridden.route);
    expect(stale.plan).toEqual([
      { provider: "claude", model: "sonnet", source: "installation", current: false, selectable: true },
      { provider: "codex", model: "o3", source: "this task's current agent — not in today's configuration", current: true, selectable: false },
    ]);
    // …and the configured proof inside the edit refuses it, mutating nothing.
    const before = store.getScope("t")!.digest;
    expect(store.editTaskRoute(ref.id, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "codex", model: "o3" }, configured: true }, T0)).toMatchObject({ ok: false, reason: "not-configured", choices: [{ provider: "claude", model: "sonnet" }, { provider: "codex", model: "gpt-5-codex" }] });
    expect(store.getScope("t")!.digest).toBe(before);
    expect(store.refFor(BUILT_IN, "t").routeOverrides?.map(one => one.phase)).toEqual(["plan"]);
  });

  test("routine authority (v48): the four-role route and its exact profile resolve together from configuration, or refuse with the words", () => {
    expect(resolveRoutineAuthority(store, "/repo", [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], T0)).toMatchObject({ ok: false, problem: expect.stringContaining("planner") });
    exactInstall();
    store.setPhaseConfig("/repo", "repair", "claude", "haiku", "alex", T0);
    const authority = resolveRoutineAuthority(store, "/repo", [{ id: "c1", statement: "s", how: null, evidence: ["screenshot"] }], T0);
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    expect(authority.route.risk).toBe("routine");
    expect(authority.route.evidence).toEqual(["screenshot"]);
    expect(authority.route.legs.map(one => [one.phase, one.provider, one.model])).toEqual([["plan", "claude", "sonnet"], ["build", "claude", "sonnet"], ["repair", "claude", "haiku"], ["review", "claude", "sonnet"]]);
    expect(authority.profile).toMatchObject({ provider: "claude", model: "sonnet", repairModel: "haiku" });
    // A repair row on another provider cannot make a runnable route.
    store.setPhaseConfig("/repo", "repair", "codex", "gpt-5", "alex", T0);
    expect(resolveRoutineAuthority(store, "/repo", [], T0)).toMatchObject({ ok: false, problem: expect.stringContaining("cross-provider repair does not exist") });
  });

  test("the strong tier is only ever a configured EXACT row: project beats installation, review inherits the plan's; a null-model or unknown row refuses", () => {
    exactInstall();
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "strong", "claude", "opus", "alex", T0);
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "plan", "strong", "codex", "gpt-5", "alex", T0);
    store.setPhaseTierConfig("/repo", "build", "strong", "codex", "gpt-5-codex", "alex", T0);
    const configured = resolveRouteCandidates(store, "/repo");
    if (!configured.ok) throw new Error("expected candidates");
    expect(configured.candidates.build.strong).toEqual({ provider: "codex", model: "gpt-5-codex", source: "project (strong)" });
    expect(configured.candidates.plan.strong).toEqual({ provider: "codex", model: "gpt-5", source: "installation (strong)" });
    expect(configured.candidates.review.strong).toEqual({ provider: "codex", model: "gpt-5", source: "installation (strong, inherited from plan)" });
    const other = resolveRouteCandidates(store, "/other");
    if (!other.ok) throw new Error("expected candidates");
    expect(other.candidates.build.strong).toEqual({ provider: "claude", model: "opus", source: "installation (strong)" });
    // A configured strong row with no model is malformed — refused, never skipped.
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "repair", "strong", "claude", null, "alex", T0);
    const nullModel = resolveRouteCandidates(store, "/other");
    expect(nullModel).toMatchObject({ ok: false, phase: "repair" });
    if (!nullModel.ok) expect(nullModel.problem).toContain("with no model");
    store.clearPhaseTierConfig(INSTALLATION_SCOPE, "repair", "strong");
    // A configured repair row must be exact too; a cross-provider one is
    // stated by the policy (the leg's problem), not skipped.
    store.setPhaseConfig(INSTALLATION_SCOPE, "repair", "codex", null, "test", T0);
    expect(resolveRouteCandidates(store, "/other")).toMatchObject({ ok: false, phase: "repair" });
    store.setPhaseConfig(INSTALLATION_SCOPE, "repair", "codex", "gpt-5-codex", "test", T0);
    const crossed = resolveRouteCandidates(store, "/other");
    if (!crossed.ok) throw new Error("expected candidates");
    expect(crossed.candidates.repair.routine).toEqual({ provider: "codex", model: "gpt-5-codex", source: "installation" });
  });

  test("routeOfTask says which route governs: live before a scope, proposed after filing, approved after the seal — and FAILS CLOSED on a routed row whose route is gone", () => {
    exactInstall();
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor(BUILT_IN, "t");
    store.placeTask(ref.id, "/repo");
    expect(store.editTaskRoute(ref.id, { by: "alex", authenticate: () => ({ ok: true }), risk: "high" }, T0).ok).toBe(true);
    const live = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    expect(live).toMatchObject({ kind: "route", source: "live" });
    if (live?.kind === "route") expect(live.route.risk).toBe("high");

    propose(store, { taskId: "t", goal: "g", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: T0 });
    expect(routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0)).toMatchObject({ kind: "route", source: "proposed" });
    const scope = store.getScope("t")!;
    expect(scope.routeEra).toBe(1);
    expect(approve(store, "t", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    const sealed = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    expect(sealed).toMatchObject({ kind: "route", source: "approved" });
    if (sealed?.kind === "route") expect(sealed.route.risk).toBe("high");

    // Route data removed from a ROUTED row (the era is set): nothing
    // downgrades to a legacy profile — the task is unreadable, in words.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 't'").run();
    const gone = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    expect(gone).toMatchObject({ kind: "unreadable" });
    if (gone?.kind === "unreadable") expect(gone.problem).toContain("sealed no agent route");
    expect(store.sealedRouteOf("t")).toMatchObject({ ok: false, reason: "unreadable" });
    // Malformed route data on a routed row: the same closed door.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = '{\"version\":1}' WHERE task_id = 't'").run();
    expect(routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0)).toMatchObject({ kind: "unreadable" });
    // Only a row PROVEN to predate routing (no era) reads as legacy.
    store.raw().prepare("UPDATE task_scope SET route_era = NULL, approved_route_json = NULL, proposed_route_json = NULL WHERE task_id = 't'").run();
    const legacy = routeOfTask(store, "t", store.refFor(BUILT_IN, "t"), T0);
    expect(legacy).toMatchObject({ kind: "legacy", profile: { provider: "claude", model: "sonnet" } });
    expect(store.sealedRouteOf("t")).toMatchObject({ ok: false, reason: "legacy" });
  });

  test("a plan pin with no model cannot route: the live recommendation says so instead of guessing", () => {
    exactInstall();
    store.createTask({ id: "p", title: "p" }, T0);
    const ref = store.refFor(BUILT_IN, "p");
    store.placeTask(ref.id, "/repo");
    store.setPlanPins(ref.id, "claude", null, T0);
    const routed = routeOfTask(store, "p", store.refFor(BUILT_IN, "p"), T0);
    expect(routed).toMatchObject({ kind: "unreadable" });
    if (routed?.kind === "unreadable") expect(routed.problem).toContain("task plan <id> --provider claude --model <model>");
    store.setPlanPins(ref.id, "claude", "opus", T0);
    const pinned = routeOfTask(store, "p", store.refFor(BUILT_IN, "p"), T0);
    expect(pinned).toMatchObject({ kind: "route", source: "live" });
    if (pinned?.kind === "route") expect(pinned.route.legs[0]).toMatchObject({ phase: "plan", provider: "claude", model: "opus", chosen: "pinned" });
  });
});
