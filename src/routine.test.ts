/**
 * Routines: the schedule algebra, the template digest, and — the part that
 * matters — the one store-owned fire transaction that re-proves approval,
 * pause, due-ness, single-flight, and budget before any write (Codex
 * planning/routines review, findings 4, 5, 9, 10).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover, approvalOf } from "./scope.js";
import { legOf, recommendRoute, routeDigestOf, type PhaseRoute } from "./phase-routing.js";
import {
  approveRoutine,
  describeSchedule,
  fireRoutine,
  firstFireAt,
  instanceId,
  nextFireAt,
  parseSchedule,
  refreshRoutineAgents,
  routineAgentsState,
  routineIntegrity,
  routineDigestOf,
  termsOf,
  validateRoutineTerms,
  type RoutineTerms,
} from "./routine.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  bound: { index: number; entryDigest: string } | null = null,
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role, bound);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-08-13T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const V24_PROFILE = {
  provider: "claude" as const,
  model: "sonnet",
  permissionArgv: "acceptEdits" as const,
  maxTurns: 40, repairMaxTurns: 4, timeoutSeconds: 1800, repairTimeoutSeconds: 300,
  repairModel: "inherit",
};
/** v48: the four-role route a routine's approval freezes — the profile
 * above restates its build and repair legs exactly. */
const SONNET = { provider: "claude" as const, model: "sonnet", source: "installation" };
const V48_ROUTE: PhaseRoute = recommendRoute({
  risk: "routine",
  qualityMode: "default",
  evidence: ["check"],
  publication: "none",
  candidates: { plan: { routine: SONNET, strong: null }, build: { routine: SONNET, strong: null }, repair: { routine: null, strong: null }, review: { routine: SONNET, strong: null } },
  overrides: [],
});

describe("the schedule algebra", () => {
  test("parses the two shapes and refuses everything else", () => {
    expect(parseSchedule("every:60")).toEqual({ kind: "every", minutes: 60 });
    expect(parseSchedule("daily:03:30")).toEqual({ kind: "daily", hhmm: "03:30" });
    expect(parseSchedule("every:4")).toBeNull(); // under the 5-minute floor
    expect(parseSchedule("every:999999")).toBeNull();
    expect(parseSchedule("daily:24:00")).toBeNull();
    expect(parseSchedule("daily:9:30")).toBeNull(); // zero-padded or nothing
    expect(parseSchedule("cron:* * * * *")).toBeNull();
  });

  test("says what it means in words", () => {
    expect(describeSchedule({ kind: "every", minutes: 90 })).toBe("every 90 minutes");
    expect(describeSchedule({ kind: "every", minutes: 120 })).toBe("every 2 hour(s)");
    expect(describeSchedule({ kind: "every", minutes: 2880 })).toBe("every 2 day(s)");
    expect(describeSchedule({ kind: "daily", hhmm: "03:30" })).toBe("daily at 03:30 UTC");
  });

  test("advances aligned: strictly after now, anchored to the fired slot", () => {
    const every = { kind: "every" as const, minutes: 60 };
    const anchor = T0.toISOString();
    // On time: exactly one interval later.
    expect(nextFireAt(every, anchor, T0)).toBe(later(HOUR).toISOString());
    // A pass 10 minutes late does not tilt the grid.
    expect(nextFireAt(every, anchor, later(10 * MINUTE))).toBe(later(HOUR).toISOString());
    // Down for five slots: ONE overdue firing was taken by the caller; the
    // next lands on the grid strictly after now — no backfill burst.
    expect(nextFireAt(every, anchor, later(5 * HOUR + 10 * MINUTE))).toBe(later(6 * HOUR).toISOString());
    // Landing exactly on an occurrence: that one already fired; take the next.
    expect(nextFireAt(every, anchor, later(2 * HOUR))).toBe(later(3 * HOUR).toISOString());
  });

  test("daily aligns to the clock, not to when the pass happened to run", () => {
    const daily = { kind: "daily" as const, hhmm: "03:30" };
    // T0 is 22:00 UTC — the next 03:30 is tomorrow.
    expect(nextFireAt(daily, T0.toISOString(), T0)).toBe("2026-08-14T03:30:00.000Z");
    expect(firstFireAt(daily, new Date("2026-08-13T02:00:00.000Z"))).toBe("2026-08-13T03:30:00.000Z");
    // Exactly at 03:30, that occurrence is past — tomorrow's fires next.
    expect(firstFireAt(daily, new Date("2026-08-13T03:30:00.000Z"))).toBe("2026-08-14T03:30:00.000Z");
  });

  test("the instance id carries the slot it satisfied", () => {
    expect(instanceId("deps", "2026-08-13T22:00:00.000Z")).toBe("deps-20260813-2200");
  });
});

const TERMS: RoutineTerms = {
  repo: "/work/repo",
  goal: "Refresh the dependency lockfile and note anything major",
  outOfScope: "No version bumps beyond patch",
  touches: ["package.json"],
  acceptance: [{ id: "c1", statement: "The refreshed lockfile still installs cleanly.", how: null, evidence: ["check"] }],
  requirements: [],
  schedule: "every:60",
  singleFlight: true,
  costCeilingUsd: 10,
};

describe("the template digest", () => {
  test("binds every term, not just the scope trio", () => {
    const base = routineDigestOf(TERMS);
    expect(routineDigestOf({ ...TERMS, schedule: "every:30" })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, costCeilingUsd: null })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, repo: "/other" })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, requirements: ["env:KEY"] })).not.toBe(base);
    // Order of paths is presentation, not meaning.
    expect(
      routineDigestOf({ ...TERMS, touches: ["b", "a"] }),
    ).toBe(routineDigestOf({ ...TERMS, touches: ["a", "b"] }));
    // v48: the four-role route is a term — a different reviewer is a
    // different standing order; no route at all keeps the legacy bytes.
    const routed = routineDigestOf(TERMS, V24_PROFILE, V48_ROUTE);
    expect(routed).not.toBe(routineDigestOf(TERMS, V24_PROFILE));
    expect(routineDigestOf(TERMS, V24_PROFILE, null)).toBe(routineDigestOf(TERMS, V24_PROFILE));
    const otherReviewer = recommendRoute({
      risk: "routine", qualityMode: "default", evidence: ["check"], publication: "none", overrides: [],
      candidates: { plan: { routine: SONNET, strong: null }, build: { routine: SONNET, strong: null }, repair: { routine: null, strong: null }, review: { routine: { provider: "codex", model: "gpt-5-codex", source: "installation" }, strong: null } },
    });
    expect(routineDigestOf(TERMS, V24_PROFILE, otherReviewer)).not.toBe(routed);
  });

  test("validation names every problem at once", () => {
    const problems = validateRoutineTerms({
      ...TERMS,
      goal: "",
      schedule: "hourly",
      requirements: ["not-a-key"],
      costCeilingUsd: -1,
    });
    expect(problems.map(one => one.field).sort()).toEqual([
      "costCeilingUsd", "goal", "requirements", "schedule",
    ]);
  });
});

describe("firing, inside one proving transaction", () => {
  let store: Store;
  let token: string;
  let routineId: number;

  const create = (terms: RoutineTerms = TERMS, name = "deps") => {
    const created = store.createRoutine(
      { name, ...terms, digest: routineDigestOf(terms, V24_PROFILE, V48_ROUTE), profile: V24_PROFILE, route: V48_ROUTE },
      T0,
    );
    if (!created.ok) throw new Error("duplicate routine in test setup");
    return created.id;
  };

  const approve = (id: number, at: Date = T0) => {
    const approved = approveRoutine(store, id, "alex", at, store.getRoutine(id)?.digest ?? "", token);
    expect(approved.ok).toBe(true);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver setup failed");
    token = added.token;
    routineId = create();
  });

  afterEach(() => store.close());

  test("nothing fires until a person agrees to the template", () => {
    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(store.routineFires(routineId)).toHaveLength(0);
  });

  test("approval binds the digest and arms the schedule from the yes", () => {
    const stale = approveRoutine(store, routineId, "alex", T0, "wrong-digest", token);
    expect(stale).toMatchObject({ ok: false, reason: "changed" });

    approve(routineId);
    const routine = store.getRoutine(routineId);
    expect(routine?.approvedBy).toBe("alex");
    expect(routine?.nextFireAt).toBe(later(HOUR).toISOString());
  });

  test("an edit after approval strands the yes — the firing refuses", () => {
    approve(routineId);
    const edited = { ...TERMS, goal: "Something the approver never read" };
    store.updateRoutineTerms(routineId, { ...edited, digest: routineDigestOf(edited) }, later(MINUTE));

    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(refused).toMatchObject({ detail: expect.stringContaining("edited") });
  });

  test("a due firing spawns a placed, linked, requirement-carrying, APPROVED instance", () => {
    const terms = { ...TERMS, requirements: ["env:GITHUB_TOKEN"] };
    const withReqs = create(terms, "audit");
    approve(withReqs);

    const fired = fireRoutine(store, withReqs, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    expect(fired.taskId).toBe("audit-20260813-2300");

    const task = store.getTask(fired.taskId);
    expect(task?.state).toBe("queued");
    const ref = store.refFor(BUILT_IN, fired.taskId);
    expect(ref.repo).toBe("/work/repo");
    expect(ref.routineId).toBe(withReqs);
    expect(ref.capabilityRequirements).toEqual(["env:GITHUB_TOKEN"]);
    expect(ref.origin).toBe("ours");

    // The scope is the template's terms byte for byte, and it is APPROVED —
    // by the person who approved the template, not by any caller's say-so.
    const scope = store.getScope(fired.taskId);
    expect(scope?.goal).toBe(terms.goal);
    expect(scope?.outOfScope).toBe(terms.outOfScope);
    expect(approvalOf(scope)).toMatchObject({ approved: true, by: "alex" });

    // The ledger has the slot; the schedule advanced strictly past now.
    const fires = store.routineFires(withReqs);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ outcome: "fired", scheduledFor: later(HOUR).toISOString() });
    expect(store.getRoutine(withReqs)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
  });

  test("routine-freeze: approval seals the four-role route; a configuration change after the yes cannot re-route a firing", () => {
    // Configuration exists and names OTHER agents than the frozen route —
    // a firing must never read it.
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5-codex", "ops", T0);
    store.setPhaseConfig("installation", "build", "codex", "gpt-5-codex", "ops", T0);
    store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "ops", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "ops", T0);
    approve(routineId);
    const routine = store.getRoutine(routineId)!;
    expect(routine.approvedRoute).not.toBeNull();
    expect(routeDigestOf(routine.approvedRoute!)).toBe(routeDigestOf(V48_ROUTE));
    // More configuration lands after the yes.
    store.setPhaseConfig("installation", "review", "codex", "gpt-5", "ops", later(MINUTE));
    const fired = fireRoutine(store, routineId, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    // The instance's SEALED route is the routine's frozen snapshot, every
    // leg — planner and reviewer included — not today's configuration.
    const sealed = store.sealedRouteOf(fired.taskId);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(routeDigestOf(sealed.route)).toBe(routeDigestOf(V48_ROUTE));
    expect(sealed.route.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
      ["plan", "claude", "sonnet"], ["build", "claude", "sonnet"], ["repair", "claude", "sonnet"], ["review", "claude", "sonnet"],
    ]);
    expect(legOf(sealed.route, "review").provider).toBe("claude");
    const scope = store.getScope(fired.taskId)!;
    expect(scope.profileState).toBe("resolved");
    expect(scope.approvedProfile).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(approvalOf(scope)).toMatchObject({ approved: true, by: "alex" });
    // The pin is the frozen build leg.
    const ref = store.refFor(BUILT_IN, fired.taskId);
    expect([ref.agentProvider, ref.agentModel]).toEqual(["claude", "sonnet"]);
  });

  test("routine-freeze: a routine with no frozen route cannot be approved, and one approved before agents were frozen fires nothing and pages once", () => {
    // Filed without a route (a configuration that could not make one, or a
    // row that predates v48): unapprovable until filed again.
    const legacy = store.createRoutine({ name: "legacy", ...TERMS, digest: routineDigestOf(TERMS, V24_PROFILE), profile: V24_PROFILE }, T0);
    if (!legacy.ok) throw new Error("setup");
    expect(approveRoutine(store, legacy.id, "alex", T0, store.getRoutine(legacy.id)!.digest, token)).toMatchObject({ ok: false, reason: "profile-unresolved" });
    // A pre-v48 approval: the columns say approved, no route was ever sealed.
    store.raw().prepare("UPDATE routine SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approved_profile_json = profile_json, next_fire_at = ? WHERE id = ?").run(T0.toISOString(), later(HOUR).toISOString(), legacy.id);
    const refused = fireRoutine(store, legacy.id, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(store.listTasks()).toHaveLength(0);
    // Paged once — the same slot does not page twice — and the slot stays
    // due (no skip on the ledger) until a person approves it again.
    const pages = () => store.raw().prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'routine-route:%'").get() as { n: number };
    expect(pages().n).toBe(1);
    fireRoutine(store, legacy.id, later(3 * HOUR));
    expect(pages().n).toBe(1);
    expect(store.routineFires(legacy.id)).toHaveLength(0);
    // Run-now refuses to the person's face in the same words, paging nobody more.
    expect(fireRoutine(store, legacy.id, later(3 * HOUR), { manual: true })).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("approve it again") });
    expect(pages().n).toBe(1);
  });

  test("routine-integrity: the firing re-hashes the APPROVED snapshot, holds the repair leg's provider to the profile, and rolls back whole when the instance cannot seal", () => {
    approve(routineId);
    const pages = () => (store.raw().prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'routine-route:%'").get() as { n: number }).n;
    // A snapshot column rewritten after the yes: the terms still hash to
    // the digest (working columns untouched), but the APPROVED route does
    // not — nothing fires, nothing is written, the slot stays due.
    const approvedJson = String((store.raw().prepare("SELECT approved_route_json AS j FROM routine WHERE id = ?").get(routineId) as { j: string }).j);
    const rerouted = approvedJson.replace('"model":"sonnet","phase":"review"', '"model":"opus","phase":"review"');
    expect(rerouted).not.toBe(approvedJson);
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(rerouted, routineId);
    expect(fireRoutine(store, routineId, later(HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("do not hash to the approval") });
    expect(store.listTasks()).toHaveLength(0);
    expect(store.routineFires(routineId)).toHaveLength(0);
    // A repair leg on another provider than the sealed profile: parity fails.
    const otherRepair = approvedJson.replace('"phase":"repair","problem":null,"provider":"claude"', '"phase":"repair","problem":null,"provider":"codex"');
    expect(otherRepair).not.toBe(approvedJson);
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(otherRepair, routineId);
    const parity = fireRoutine(store, routineId, later(HOUR));
    expect(parity.ok).toBe(false);
    expect(store.listTasks()).toHaveLength(0);
    // Corrupt snapshot bytes: fail closed in their own words, paged once.
    store.raw().prepare("UPDATE routine SET approved_route_json = '{\"version\":1' WHERE id = ?").run(routineId);
    expect(routineAgentsState(store.getRoutine(routineId)!)).toMatchObject({ state: "unreadable", approvable: false, refresh: true });
    expect(fireRoutine(store, routineId, later(HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("cannot be read") });
    expect(pages()).toBe(1);
    // Restore the true snapshot; the firing seals, and the instance's
    // sealed route IS the frozen one. Then prove the rollback road: a
    // firing whose instance seal is refused leaves NO instance, NO ledger
    // row, and the slot still due — the seal is proved, not assumed.
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(approvedJson, routineId);
    const sealSpy = store.sealScopeApproval.bind(store);
    (store as unknown as { sealScopeApproval: typeof store.sealScopeApproval }).sealScopeApproval = () => false;
    const rolled = fireRoutine(store, routineId, later(HOUR));
    expect(rolled).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("nothing fired") });
    expect(store.listTasks()).toHaveLength(0);
    expect(store.routineFires(routineId)).toHaveLength(0);
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(HOUR).toISOString());
    (store as unknown as { sealScopeApproval: typeof store.sealScopeApproval }).sealScopeApproval = sealSpy;
    const fired = fireRoutine(store, routineId, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    const sealed = store.sealedRouteOf(fired.taskId);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) expect(routeDigestOf(sealed.route)).toBe(routeDigestOf(V48_ROUTE));
    // Success resolves the route episode.
    expect((store.raw().prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'routine-route:%' AND resolved_at IS NULL").get() as { n: number }).n).toBe(0);
  });

  test("migration-recovery: an AUTHENTIC v47 routine (approved with a profile, no route columns) survives the v48 upgrade with its data, fires nothing, and the plain refresh → approve → fire road seals the exact new snapshot with no auto-approval", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SCHEMA_VERSION } = await import("./store.js");
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v47-routine-"));
    const db = join(dir, "orders.db");
    try {
      // Seed under today's store, then roll the file back to the v47 shape
      // exactly as a v47 build left it: the digest binds terms + profile
      // only, the approval stamp covers it, and no route column exists.
      const v47 = openStore(db);
      const alex = addApprover(v47, "alex", T0);
      if (!alex.ok) throw new Error("approver");
      const v47Digest = routineDigestOf(TERMS, V24_PROFILE);
      const created = v47.createRoutine({ name: "nightly-deps", ...TERMS, digest: v47Digest, profile: V24_PROFILE }, T0);
      if (!created.ok) throw new Error("setup");
      v47.raw().prepare("UPDATE routine SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approved_profile_json = profile_json, next_fire_at = ? WHERE id = ?").run(T0.toISOString(), later(HOUR).toISOString(), created.id);
      v47.raw().exec("ALTER TABLE routine DROP COLUMN route_json");
      v47.raw().exec("ALTER TABLE routine DROP COLUMN approved_route_json");
      v47.raw().prepare("UPDATE schema_version SET version = 47").run();
      v47.close();

      // The upgrade: additive, data intact.
      const up = openStore(db);
      expect(up.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
      const migrated = up.getRoutine(created.id)!;
      expect(termsOf(migrated)).toEqual({ ...TERMS, budgetPerRunMicrousd: null });
      expect(migrated).toMatchObject({ digest: v47Digest, approvedDigest: v47Digest, approvedBy: "alex", route: null, approvedRoute: null, routeUnreadable: false, approvedRouteUnreadable: false });
      expect(migrated.approvedProfile).toMatchObject({ provider: "claude", model: "sonnet" });
      expect(routineAgentsState(migrated)).toMatchObject({ state: "unfrozen", approvable: false, refresh: true });

      // A legacy unfrozen firing is BLOCKED — paged once, slot still due, no instance.
      expect(fireRoutine(up, created.id, later(2 * HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("refresh its agents") });
      expect(up.listTasks()).toHaveLength(0);
      expect(up.routineFires(created.id)).toHaveLength(0);
      expect(up.getRoutine(created.id)?.nextFireAt).toBe(later(HOUR).toISOString());

      // The recovery road, step 1: refresh. With no exact agents configured
      // it says so and changes nothing.
      expect(refreshRoutineAgents(up, created.id, later(2 * HOUR))).toMatchObject({ ok: false, reason: "unresolved" });
      expect(up.getRoutine(created.id)?.digest).toBe(v47Digest);
      up.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
      up.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
      up.setPhaseConfig("installation", "review", "claude", "opus", "alex", T0);
      const refreshed = refreshRoutineAgents(up, created.id, later(2 * HOUR));
      expect(refreshed).toMatchObject({ ok: true, changed: true });
      if (!refreshed.ok) return;
      // Refreshing approves NOTHING: the digest moved, the old yes is stale,
      // and the old snapshot cannot fire.
      const pending = up.getRoutine(created.id)!;
      expect(pending.digest).not.toBe(v47Digest);
      // The unfrozen approval is WITHDRAWN by the refresh (v48 authority repair): no digest,
      // no snapshot, no armed slot — only the history of who once agreed.
      expect(pending).toMatchObject({ approvedDigest: null, approvedRoute: null, approvedProfile: null, nextFireAt: null, approvedBy: "alex" });
      expect(pending.route).not.toBeNull();
      expect(routineAgentsState(pending)).toMatchObject({ state: "pending", approvable: true, refresh: false });
      expect(fireRoutine(up, created.id, later(2 * HOUR))).toMatchObject({ ok: false, reason: "not-approved" });
      expect(up.listTasks()).toHaveLength(0);
      // Refreshing again under the same configuration is a no-op.
      expect(refreshRoutineAgents(up, created.id, later(2 * HOUR))).toMatchObject({ ok: true, changed: false });

      // Step 2: approve, through the ceremony, against the digest read.
      const yes = approveRoutine(up, created.id, "alex", later(2 * HOUR), pending.digest, alex.token);
      expect(yes.ok).toBe(true);
      const frozen = up.getRoutine(created.id)!;
      expect(routineAgentsState(frozen)).toMatchObject({ state: "frozen" });
      expect(frozen.approvedRoute!.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
        ["plan", "claude", "sonnet"], ["build", "claude", "sonnet"], ["repair", "claude", "sonnet"], ["review", "claude", "opus"],
      ]);

      // Step 3: fire — the instance seals the EXACT new snapshot.
      const fired = fireRoutine(up, created.id, later(4 * HOUR));
      expect(fired.ok).toBe(true);
      if (!fired.ok) return;
      const sealed = up.sealedRouteOf(fired.taskId);
      expect(sealed.ok).toBe(true);
      if (sealed.ok) expect(routeDigestOf(sealed.route)).toBe(routeDigestOf(frozen.approvedRoute!));
      expect(up.getScope(fired.taskId)?.approvedProfile).toMatchObject({ provider: "claude", model: "sonnet" });
      up.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("routine-recovery: ONE integrity projection gates state, consent, approval, and fire — a corrupt approved snapshot is not live, refresh withdraws it even though the working data is unchanged, and reapproval restores firing", () => {
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    // File the working agents from today's configuration, then approve —
    // so a later refresh under the same configuration changes no term.
    expect(refreshRoutineAgents(store, routineId, T0).ok).toBe(true);
    approve(routineId);
    const liveBefore = routineIntegrity(store.getRoutine(routineId)!);
    expect(liveBefore).toMatchObject({ approved: true, live: true, liveProblem: null, agents: { state: "frozen", approvable: false, refresh: false } });
    // The working columns stay EXACTLY as approved; only the frozen snapshot
    // is rewritten (a review leg the approver never saw). The approval
    // columns still claim a yes.
    const approvedJson = String((store.raw().prepare("SELECT approved_route_json AS j FROM routine WHERE id = ?").get(routineId) as { j: string }).j);
    const rerouted = approvedJson.replace('"model":"sonnet","phase":"review"', '"model":"opus","phase":"review"');
    expect(rerouted).not.toBe(approvedJson);
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(rerouted, routineId);
    const corrupt = store.getRoutine(routineId)!;
    expect(corrupt.approvedDigest).toBe(corrupt.digest);
    // The projection: approved on the columns, NOT live — and every gate
    // reads that one answer.
    const integrity = routineIntegrity(corrupt);
    expect(integrity).toMatchObject({ approved: true, live: false, liveProblem: expect.stringContaining("do not hash to the approval"), agents: { state: "unverified", approvable: false, refresh: true } });
    expect(routineAgentsState(corrupt)).toEqual(integrity.agents);
    // Fire: refused, nothing written, the slot still due.
    expect(fireRoutine(store, routineId, later(HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen", detail: expect.stringContaining("do not hash to the approval") });
    expect(store.listTasks()).toHaveLength(0);
    expect(store.routineFires(routineId)).toHaveLength(0);
    // Approve: a yes on the same digest lands nothing new — the snapshot the
    // columns claim is not one a person can meaningfully agree to.
    expect(approveRoutine(store, routineId, "alex", later(HOUR), corrupt.digest, token)).toMatchObject({ ok: false, reason: "changed" });
    expect(String((store.raw().prepare("SELECT approved_route_json AS j FROM routine WHERE id = ?").get(routineId) as { j: string }).j)).toBe(rerouted);
    // Refresh: the working agents already bind these exact terms — the
    // digest does not move — and the corrupt approval is still WITHDRAWN.
    const refreshed = refreshRoutineAgents(store, routineId, later(HOUR));
    expect(refreshed).toMatchObject({ ok: true, changed: true });
    const withdrawn = store.getRoutine(routineId)!;
    expect(withdrawn.digest).toBe(corrupt.digest);
    expect(withdrawn).toMatchObject({ approvedDigest: null, approvedRoute: null, approvedProfile: null, nextFireAt: null, approvedBy: "alex" });
    expect(routineIntegrity(withdrawn)).toMatchObject({ approved: false, live: false, agents: { state: "pending", approvable: true, refresh: false } });
    expect(fireRoutine(store, routineId, later(2 * HOUR))).toMatchObject({ ok: false, reason: "not-approved" });
    // A second refresh under the same configuration is a no-op now.
    expect(refreshRoutineAgents(store, routineId, later(HOUR))).toMatchObject({ ok: true, changed: false });
    // Reapproval seals the working snapshot afresh, and firing resumes
    // under exactly the approved route.
    expect(approveRoutine(store, routineId, "alex", later(2 * HOUR), withdrawn.digest, token).ok).toBe(true);
    const again = store.getRoutine(routineId)!;
    expect(routineIntegrity(again)).toMatchObject({ approved: true, live: true, agents: { state: "frozen" } });
    const fired = fireRoutine(store, routineId, later(4 * HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    const sealed = store.sealedRouteOf(fired.taskId);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) expect(routeDigestOf(sealed.route)).toBe(routeDigestOf(again.approvedRoute!));
  });

  test("routine-integrity (v48): the projection reads the FULL row and requires working/approved parity — a frozen pair that hashes to the approval while the working pair says something else is not live", () => {
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    expect(refreshRoutineAgents(store, routineId, T0).ok).toBe(true);
    approve(routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: true });
    // The WORKING route rewritten under the same digest column while the
    // frozen snapshot still hashes to the approval: the working terms no
    // longer re-derive the digest, so the row is not even approved.
    const workingJson = String((store.raw().prepare("SELECT route_json AS j FROM routine WHERE id = ?").get(routineId) as { j: string }).j);
    const rerouted = workingJson.replace('"model":"sonnet","phase":"review"', '"model":"opus","phase":"review"');
    expect(rerouted).not.toBe(workingJson);
    store.raw().prepare("UPDATE routine SET route_json = ? WHERE id = ?").run(rerouted, routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: false, live: false, agents: { state: "unverified", approvable: false } });
    expect(fireRoutine(store, routineId, later(HOUR))).toMatchObject({ ok: false, reason: "not-approved" });
    // The working route made UNREADABLE while the frozen one still hashes:
    // the digest cannot be re-derived from the working columns — unverified.
    store.raw().prepare("UPDATE routine SET route_json = '{\"version\":1' WHERE id = ?").run(routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: false, live: false, agents: { state: "unreadable" } });
    store.raw().prepare("UPDATE routine SET route_json = ? WHERE id = ?").run(workingJson, routineId);
    // Parity in the other direction: the approval's digest column
    // rewritten to the frozen pair's own hash while the working pair
    // differs — the stamp no longer equals the stored digest: not approved.
    const routine = store.getRoutine(routineId)!;
    const frozenHash = routineDigestOf(termsOf(routine), routine.approvedProfile!, routine.approvedRoute!);
    expect(frozenHash).toBe(routine.digest);
    store.raw().prepare("UPDATE routine SET route_json = ?, digest = ? WHERE id = ?").run(rerouted, routineDigestOf(termsOf(routine), routine.profile!, JSON.parse(rerouted) as never), routineId);
    const parity = routineIntegrity(store.getRoutine(routineId)!);
    expect(parity).toMatchObject({ approved: false, live: false });
    store.raw().prepare("UPDATE routine SET route_json = ?, digest = ? WHERE id = ?").run(workingJson, routine.digest, routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: true });
    // A frozen pair that STILL hashes to the approval but is not the
    // working pair (the approved digest column and the working digest
    // column both moved with the working route): unverified, in words.
    const reroutedRoute = JSON.parse(rerouted) as never;
    const movedDigest = routineDigestOf(termsOf(routine), routine.profile!, reroutedRoute);
    store.raw().prepare("UPDATE routine SET route_json = ?, digest = ?, approved_digest = ? WHERE id = ?").run(rerouted, movedDigest, movedDigest, routineId);
    const drift = routineIntegrity(store.getRoutine(routineId)!);
    expect(drift).toMatchObject({ approved: true, live: false, agents: { state: "unverified" }, liveProblem: expect.stringContaining("do not hash to the approval") });
    expect(fireRoutine(store, routineId, later(HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(store.listTasks()).toHaveLength(0);
    expect(store.routineFires(routineId)).toHaveLength(0);
  });

  test("routine-fire (v48): a not-live approval refuses BEFORE the slot heal, the blocker ledger, the instance, the page-per-blocker, and the next-fire time — even when a stale slot and a live blocker are both present; a manual fire writes nothing at all", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A stale scheduled pointer (the slot already on the ledger) AND a
    // live blocker (the first instance never finished).
    const due = store.getRoutine(routineId)!.nextFireAt as string;
    store.recordRoutineFire({ routineId, scheduledFor: due, outcome: "fired", reason: null, instanceTaskRef: null }, later(HOUR));
    const before = {
      fires: store.routineFires(routineId),
      tasks: store.listTasks().map(one => one.id),
      nextFireAt: store.getRoutine(routineId)!.nextFireAt,
      notifications: store.listNotifications("all").length,
      row: store.raw().prepare("SELECT * FROM routine WHERE id = ?").get(routineId),
    };
    // Now the frozen snapshot is corrupted: not live.
    store.raw().prepare("UPDATE routine SET approved_route_json = '{\"version\":1' WHERE id = ?").run(routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: false, agents: { state: "unreadable" } });
    const corruptRow = store.raw().prepare("SELECT * FROM routine WHERE id = ?").get(routineId);
    // Scheduled: refused as not-live — not slot-taken, not single-flight —
    // and the ONLY write is the once-per-episode page at the edge.
    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(store.routineFires(routineId)).toEqual(before.fires);
    expect(store.listTasks().map(one => one.id)).toEqual(before.tasks);
    expect(store.getRoutine(routineId)!.nextFireAt).toBe(before.nextFireAt);
    expect(store.raw().prepare("SELECT * FROM routine WHERE id = ?").get(routineId)).toEqual(corruptRow);
    const pages = store.listNotifications("all").filter(one => one.kind === "routine-blocked");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.dedupeKey).toMatch(new RegExp(`^routine-route:${routineId}:`));
    expect(pages[0]?.subject).toContain("cannot be read");
    // Again: still nothing, and no second page.
    expect(fireRoutine(store, routineId, later(3 * HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(store.routineFires(routineId)).toEqual(before.fires);
    expect(store.listNotifications("all").length).toBe(before.notifications + 1);
    // Manual: the refusal to the person's face, and NOTHING written — not a page.
    const manual = fireRoutine(store, routineId, later(3 * HOUR), { manual: true });
    expect(manual).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(store.listNotifications("all").length).toBe(before.notifications + 1);
    expect(store.raw().prepare("SELECT * FROM routine WHERE id = ?").get(routineId)).toEqual(corruptRow);
    // Consent and approval read the same projection: no yes lands on it.
    expect(routineAgentsState(store.getRoutine(routineId)!)).toMatchObject({ approvable: false, refresh: true });
    expect(approveRoutine(store, routineId, "alex", later(3 * HOUR), store.getRoutine(routineId)!.digest, token).ok).toBe(false);
  });

  test("routine-terms (raw authority repair): stored terms that do not read back exactly are not approved — no consent, no yes, no refresh, no firing, and NOTHING written: not the row, a slot, the ledger, a task, a notification, or the next-fire time", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    const raw = store.raw();
    const sound = raw.prepare("SELECT touches, requirements, acceptance_json, single_flight, cost_ceiling_usd, budget_per_run_microusd, digest_version FROM routine WHERE id = ?").get(routineId) as Record<string, unknown>;
    const restore = () =>
      raw.prepare("UPDATE routine SET touches = ?, requirements = ?, acceptance_json = ?, single_flight = ?, cost_ceiling_usd = ?, budget_per_run_microusd = ?, digest_version = ? WHERE id = ?")
        .run(sound["touches"], sound["requirements"], sound["acceptance_json"], sound["single_flight"], sound["cost_ceiling_usd"], sound["budget_per_run_microusd"], sound["digest_version"], routineId);
    const acceptance = JSON.parse(String(sound["acceptance_json"])) as Record<string, unknown>[];
    // Each corruption is one the LENIENT readers filter, default, or
    // coerce into the very same digest the approver signed.
    const cases: [string, string, RegExp][] = [
      ["a touch entry that is not a string", `UPDATE routine SET touches = '${JSON.stringify([...(JSON.parse(String(sound["touches"])) as string[]), 7])}' WHERE id = ${routineId}`, /touches carries an entry that is not a string/],
      ["a requirement that is not a string", `UPDATE routine SET requirements = '[null]' WHERE id = ${routineId}`, /requirements carries an entry that is not a string/],
      ["touches that are not JSON", `UPDATE routine SET touches = '[' WHERE id = ${routineId}`, /touches is not valid JSON/],
      ["a rubric entry with an unknown key", `UPDATE routine SET acceptance_json = '${JSON.stringify(acceptance.map((one, i) => (i === 0 ? { ...one, extra: 1 } : one)))}' WHERE id = ${routineId}`, /carries a key this code never writes/],
      ["a rubric entry that does not parse", `UPDATE routine SET acceptance_json = '${JSON.stringify([...acceptance, { id: 9, statement: "", how: null, evidence: [] }])}' WHERE id = ${routineId}`, /does not parse/],
      ["a single-flight flag that is not 0 or 1", `UPDATE routine SET single_flight = 2 WHERE id = ${routineId}`, /single-flight flag is not 0 or 1/],
      ["a text cost ceiling", `UPDATE routine SET cost_ceiling_usd = 'lots' WHERE id = ${routineId}`, /cost ceiling is not a number/],
      ["a fractional per-run budget", `UPDATE routine SET budget_per_run_microusd = 1.5 WHERE id = ${routineId}`, /per-run budget is not a safe integer/],
      ["a digest version no build writes", `UPDATE routine SET digest_version = 7 WHERE id = ${routineId}`, /digest version is not one this code writes/],
    ];
    for (const [label, sql, words] of cases) {
      restore();
      raw.exec(sql);
      const before = {
        row: raw.prepare("SELECT * FROM routine WHERE id = ?").get(routineId),
        fires: store.routineFires(routineId),
        tasks: store.listTasks().map(one => one.id),
        notifications: store.listNotifications("all").length,
      };
      const integrity = routineIntegrity(store.getRoutine(routineId)!);
      expect(integrity, label).toMatchObject({ approved: false, live: false, agents: { state: "unverified", approvable: false, refresh: false } });
      expect(integrity.agents.problem, label).toMatch(words);
      expect(routineAgentsState(store.getRoutine(routineId)!).approvable, label).toBe(false);
      // Scheduled and manual firings alike: refused as not approved, in
      // the terms' own words, with NOTHING written.
      for (const manual of [false, true]) {
        const refused = fireRoutine(store, routineId, later(3 * HOUR), { manual });
        expect(refused, label).toMatchObject({ ok: false, reason: "not-approved", detail: expect.stringContaining("cannot be read exactly") });
      }
      expect(approveRoutine(store, routineId, "alex", later(3 * HOUR), store.getRoutine(routineId)!.digest, token).ok, label).toBe(false);
      expect(refreshRoutineAgents(store, routineId, later(3 * HOUR)), label).toMatchObject({ ok: false, reason: "unresolved", problem: expect.stringContaining("cannot be read exactly") });
      expect(raw.prepare("SELECT * FROM routine WHERE id = ?").get(routineId), label).toEqual(before.row);
      expect(store.routineFires(routineId), label).toEqual(before.fires);
      expect(store.listTasks().map(one => one.id), label).toEqual(before.tasks);
      expect(store.listNotifications("all").length, label).toBe(before.notifications);
    }
    restore();
    expect(store.getRoutine(routineId)!.termsProblem).toBeNull();
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: true });
  });

  test("routine-recovery: unreadable snapshot bytes and an unfrozen approval are withdrawn by the refresh the same way, and a LIVE approval under unchanged terms is left alone", () => {
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    expect(refreshRoutineAgents(store, routineId, T0).ok).toBe(true);
    approve(routineId);
    // Live + unchanged: byte-for-byte alone, still approved.
    expect(refreshRoutineAgents(store, routineId, later(HOUR))).toMatchObject({ ok: true, changed: false });
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: true });
    // Unreadable snapshot bytes: not live; refresh withdraws.
    store.raw().prepare("UPDATE routine SET approved_route_json = '{\"version\":1' WHERE id = ?").run(routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: false, agents: { state: "unreadable", refresh: true } });
    expect(refreshRoutineAgents(store, routineId, later(HOUR))).toMatchObject({ ok: true, changed: true });
    expect(store.getRoutine(routineId)).toMatchObject({ approvedDigest: null, approvedRouteUnreadable: false, nextFireAt: null });
    expect(fireRoutine(store, routineId, later(2 * HOUR))).toMatchObject({ ok: false, reason: "not-approved" });
    // Approve again; then an approval whose snapshot was never taken.
    expect(approveRoutine(store, routineId, "alex", later(2 * HOUR), store.getRoutine(routineId)!.digest, token).ok).toBe(true);
    store.raw().prepare("UPDATE routine SET approved_route_json = NULL WHERE id = ?").run(routineId);
    expect(routineIntegrity(store.getRoutine(routineId)!)).toMatchObject({ approved: true, live: false, agents: { state: "unfrozen", refresh: true } });
    expect(fireRoutine(store, routineId, later(3 * HOUR))).toMatchObject({ ok: false, reason: "route-unfrozen" });
    expect(refreshRoutineAgents(store, routineId, later(3 * HOUR))).toMatchObject({ ok: true, changed: true });
    expect(store.getRoutine(routineId)).toMatchObject({ approvedDigest: null, nextFireAt: null });
    expect(approveRoutine(store, routineId, "alex", later(3 * HOUR), store.getRoutine(routineId)!.digest, token).ok).toBe(true);
    expect(fireRoutine(store, routineId, later(5 * HOUR)).ok).toBe(true);
  });

  test("early is not due, and a recorded slot cannot fire twice", () => {
    approve(routineId);
    expect(fireRoutine(store, routineId, later(30 * MINUTE))).toMatchObject({ ok: false, reason: "not-due" });

    expect(fireRoutine(store, routineId, later(HOUR)).ok).toBe(true);
    // The same slot again — as if two passes raced: the ledger's unique
    // slot answers, whatever the schedule column says.
    store.setRoutineNextFire(routineId, later(HOUR).toISOString(), later(HOUR));
    expect(fireRoutine(store, routineId, later(HOUR + MINUTE))).toMatchObject({ ok: false, reason: "slot-taken" });
  });

  test("downtime fires ONCE and re-aligns — no backfill burst", () => {
    approve(routineId);
    // The daemon slept through five slots. One overdue firing happens...
    const fired = fireRoutine(store, routineId, later(6 * HOUR + 10 * MINUTE));
    expect(fired.ok).toBe(true);
    // ...for the slot that was due, and the next lands on the grid ahead.
    expect(store.routineFires(routineId)[0]?.scheduledFor).toBe(later(HOUR).toISOString());
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(7 * HOUR).toISOString());
    // Nothing else is due — the missed slots are gone, not queued.
    expect(fireRoutine(store, routineId, later(6 * HOUR + 11 * MINUTE))).toMatchObject({ ok: false, reason: "not-due" });
  });

  test("single-flight: an unfinished instance skips the slot, on the ledger, and pages ONCE", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The instance never finished. The next two slots skip — recorded as
    // hollow dots — and the stuck instance pages exactly once.
    const skipped = fireRoutine(store, routineId, later(2 * HOUR));
    expect(skipped).toMatchObject({ ok: false, reason: "single-flight" });
    const again = fireRoutine(store, routineId, later(3 * HOUR));
    expect(again).toMatchObject({ ok: false, reason: "single-flight" });

    const fires = store.routineFires(routineId);
    expect(fires.map(one => one.outcome)).toEqual(["skipped", "skipped", "fired"]);
    expect(fires[0]?.reason).toContain("single-flight");
    const pages = store.listNotifications("all").filter(one => one.kind === "routine-blocked");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.subject).toContain("stuck");

    // The blocker finishes; the next slot fires and the episode resolves.
    store.setTaskState(first.taskId, "done", later(3 * HOUR + MINUTE));
    const resumed = fireRoutine(store, routineId, later(4 * HOUR));
    expect(resumed.ok).toBe(true);
    const open = store.listNotifications("pending").filter(one => one.kind === "routine-blocked");
    expect(open).toHaveLength(0);
  });

  test("budget fails closed: measured overspend skips, and an unmeasured paid run blocks outright", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // A paid run with no recorded cost: the ceiling cannot be honestly
    // enforced, so the track blocks as UNMEASURED, not as headroom.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run = store.startRun({
      taskRef: ref.id, leaseId: "lease-1", runner: "r1",
      branch: "b", worktree: "w", now: later(HOUR),
      ...presented(store, ref.id, "builder"),
    });
    store.stampProviderStart(run, later(HOUR));
    const unmeasured = fireRoutine(store, routineId, later(2 * HOUR));
    expect(unmeasured).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").some(one => one.subject.includes("unmeasured"))).toBe(true);

    // The cost lands, over the ceiling: now it is a plain budget skip.
    store.recordUsage(run, { costUsd: 12.5 });
    const over = fireRoutine(store, routineId, later(3 * HOUR));
    expect(over).toMatchObject({ ok: false, reason: "budget" });
    const fires = store.routineFires(routineId);
    expect(fires.map(one => one.outcome)).toEqual(["skipped", "skipped", "fired"]);
    expect(store.listNotifications("all").some(one => one.subject.includes("budget"))).toBe(true);

    // No ceiling, no budget gate: the same spend fires freely.
    const unbounded = { ...TERMS, costCeilingUsd: null };
    const free = create(unbounded, "free");
    approve(free, later(3 * HOUR));
    expect(fireRoutine(store, free, later(4 * HOUR + MINUTE)).ok).toBe(true);
  });

  test("run-now is a manual fire: same proofs, no ledger noise on refusal, schedule untouched", () => {
    approve(routineId);
    const scheduled = store.getRoutine(routineId)?.nextFireAt;

    const manual = fireRoutine(store, routineId, later(10 * MINUTE), { manual: true });
    expect(manual.ok).toBe(true);
    // The scheduled occurrence still stands — run-now is extra, not instead.
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(scheduled);
    expect(store.routineFires(routineId)[0]?.outcome).toBe("fired");

    // A manual fire against a blocker refuses to the person's face and
    // records nothing — there is no slot to ledger and nobody to page.
    const refused = fireRoutine(store, routineId, later(20 * MINUTE), { manual: true });
    expect(refused).toMatchObject({ ok: false, reason: "single-flight" });
    expect(store.routineFires(routineId)).toHaveLength(1);
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(0);

    // Paused refuses even by hand — pausing means stopped, not "stopped
    // unless somebody clicks harder".
    store.setRoutinePaused(routineId, true, later(21 * MINUTE));
    expect(fireRoutine(store, routineId, later(22 * MINUTE), { manual: true })).toMatchObject({
      ok: false,
      reason: "paused",
    });
  });

  test("two standing orders cannot share a name", () => {
    expect(store.createRoutine({ name: "deps", ...TERMS, digest: routineDigestOf(TERMS, V24_PROFILE, V48_ROUTE), profile: V24_PROFILE, route: V48_ROUTE }, T0)).toMatchObject({
      ok: false,
      reason: "duplicate",
    });
  });

  test("dueRoutines nominates only approved, unpaused, due work in this repo", () => {
    approve(routineId);
    const elsewhere = create({ ...TERMS, repo: "/elsewhere" }, "other-repo");
    approve(elsewhere);
    const pausedId = create({ ...TERMS }, "paused-one");
    approve(pausedId);
    store.setRoutinePaused(pausedId, true, later(MINUTE));
    create({ ...TERMS }, "never-approved");

    const due = store.dueRoutines("/work/repo", later(2 * HOUR));
    expect(due.map(one => one.name)).toEqual(["deps"]);
  });
});

describe("the review's regressions (Codex Phase C findings)", () => {
  let store: Store;
  let token: string;
  let routineId: number;

  const create = (terms: RoutineTerms = TERMS, name = "deps") => {
    const created = store.createRoutine({ name, ...terms, digest: routineDigestOf(terms, V24_PROFILE, V48_ROUTE), profile: V24_PROFILE, route: V48_ROUTE }, T0);
    if (!created.ok) throw new Error("duplicate routine in test setup");
    return created.id;
  };
  const approve = (id: number, at: Date = T0) => {
    const approved = approveRoutine(store, id, "alex", at, store.getRoutine(id)?.digest ?? "", token);
    expect(approved.ok).toBe(true);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver setup failed");
    token = added.token;
    routineId = create();
  });

  afterEach(() => store.close());

  test("H1: terms edited under a REUSED digest fire nothing — the digest is re-derived, not trusted", () => {
    approve(routineId);
    // A store-API caller smuggles new terms while presenting the digest the
    // operator approved. The columns now agree with each other and lie
    // about the terms.
    const smuggled = { ...TERMS, goal: "Wire the money elsewhere", schedule: "every:5" };
    store.updateRoutineTerms(routineId, { ...smuggled, digest: routineDigestOf(TERMS) }, later(MINUTE));

    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(store.listTasks()).toHaveLength(0);

    // Approval over a lying row refuses the same way.
    const reapprove = approveRoutine(store, routineId, "alex", later(MINUTE), routineDigestOf(TERMS), token);
    expect(reapprove).toMatchObject({ ok: false, reason: "changed" });
  });

  test("H2: a live claim blocks single-flight whatever the task's state string says", async () => {
    const { acquire } = await import("./claim.js");
    const { register } = await import("./runner.js");
    // The runner gate (MCP spec v6): the claiming runner is registered and
    // bound to the routine's repo, and the claim carries its token.
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [TERMS.repo], now: T0, newToken: () => "tok-builder-1" });
    approve(routineId);
    const fired = fireRoutine(store, routineId, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;

    // A runner takes the instance; the provider is live.
    const ref = store.refFor(BUILT_IN, fired.taskId);
    const taken = acquire(store, ref.id, "builder-1", { token: "tok-builder-1", now: later(HOUR + MINUTE), ttlMs: 60 * MINUTE });
    expect(taken.ok).toBe(true);

    // Somebody writes 'done' over it with the generic state command,
    // bypassing the guarded cancel. The claim is still live — no twin.
    store.setTaskState(fired.taskId, "done", later(HOUR + 2 * MINUTE));
    const skipped = fireRoutine(store, routineId, later(2 * HOUR));
    expect(skipped).toMatchObject({ ok: false, reason: "single-flight" });
  });

  test("M1: run-now landing exactly on the due instant cannot strand the schedule", () => {
    approve(routineId);
    const due = store.getRoutine(routineId)?.nextFireAt as string;

    // The manual fire at the exact due moment takes a MANUAL ledger key.
    const manual = fireRoutine(store, routineId, new Date(due), { manual: true });
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;
    store.setTaskState(manual.taskId, "done", later(HOUR + MINUTE));

    // The scheduled slot is still open: the pass fires it and advances.
    const scheduled = fireRoutine(store, routineId, later(HOUR + 2 * MINUTE));
    expect(scheduled.ok).toBe(true);
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
  });

  test("M1: a stale scheduled pointer heals — slot-taken advances past the recorded slot", () => {
    approve(routineId);
    const due = store.getRoutine(routineId)?.nextFireAt as string;
    // The slot is already on the ledger (a crash between insert and
    // advance, or an older bug): the refusal must move the pointer.
    store.recordRoutineFire(
      { routineId, scheduledFor: due, outcome: "fired", reason: null, instanceTaskRef: null },
      later(HOUR),
    );
    const refused = fireRoutine(store, routineId, later(HOUR + MINUTE));
    expect(refused).toMatchObject({ ok: false, reason: "slot-taken" });
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
    // And the next pass is back on the grid.
    expect(fireRoutine(store, routineId, later(2 * HOUR)).ok).toBe(true);
  });

  test("M2: the budget window anchors to when money could move, not when the run row opened", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // The run row was opened EIGHT days before this firing's window, but
    // its provider started inside the window and never recorded a cost:
    // it is unmeasured spend inside the window, and it blocks.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run = store.startRun({
      taskRef: ref.id, leaseId: "old-lease", runner: "r1",
      branch: "b", worktree: "w", now: new Date(T0.getTime() - 8 * DAY),
      ...presented(store, ref.id, "builder"),
    });
    store.stampProviderStart(run, later(HOUR));
    const blocked = fireRoutine(store, routineId, later(2 * HOUR));
    expect(blocked).toMatchObject({ ok: false, reason: "unmeasured" });
  });

  test("L1: a recurrence AFTER recovery pages again — resolved history does not gag the pager", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // Episode one: an unmeasured paid run blocks and pages.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run1 = store.startRun({ taskRef: ref.id, leaseId: "l1", runner: "r1", branch: "b", worktree: "w", now: later(HOUR), ...presented(store, ref.id, "builder") });
    store.stampProviderStart(run1, later(HOUR));
    expect(fireRoutine(store, routineId, later(2 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    // Still episode one: a second blocked slot does not page twice.
    expect(fireRoutine(store, routineId, later(3 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(1);

    // Recovery: the cost lands small, the next slot fires, episodes resolve.
    store.recordUsage(run1, { costUsd: 0.1 });
    const recovered = fireRoutine(store, routineId, later(4 * HOUR));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    store.setTaskState(recovered.taskId, "done", later(4 * HOUR + MINUTE));

    // Episode two: a NEW unmeasured run blocks again — and pages again.
    const ref2 = store.refFor(BUILT_IN, recovered.taskId);
    const run2 = store.startRun({ taskRef: ref2.id, leaseId: "l2", runner: "r1", branch: "b", worktree: "w", now: later(4 * HOUR), ...presented(store, ref2.id, "builder") });
    store.stampProviderStart(run2, later(4 * HOUR));
    expect(fireRoutine(store, routineId, later(5 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(2);
  });

  test("M4: a template that asks for concurrent instances is refused at validation", () => {
    const problems = validateRoutineTerms({ ...TERMS, singleFlight: false });
    expect(problems.map(one => one.field)).toContain("singleFlight");
  });
});
