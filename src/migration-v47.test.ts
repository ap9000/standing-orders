/**
 * Schema v47 adds the phase route beside every other digest-bound field —
 * additively. A scope approved under v46 keeps its exact digest, reads back
 * as routine risk with no route, and its sealed profile remains the whole
 * authority for its build; the three new tables arrive by IF NOT EXISTS.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover, approve, approvalOf, propose } from "./scope.js";
import { proveApprovedProfile } from "./builder.js";
import { register } from "./runner.js";
import { routeFromJson, routeIsSigned } from "./phase-routing.js";

const T0 = new Date("2026-09-10T12:00:00.000Z");

function file(store: Store, taskId: string, risk?: "routine" | "elevated" | "high"): void {
  store.createTask({ id: taskId, title: taskId }, T0);
  const ref = store.refFor("built-in", taskId);
  store.placeTask(ref.id, "/repo/app");
  propose(store, {
    taskId,
    goal: "ship it",
    acceptance: [{ id: "c1", statement: "it ships", how: null, evidence: ["check"] }],
    now: T0,
    ...(risk === undefined ? {} : { riskLevel: risk }),
  });
}

describe("schema v47: explainable phase routing is additive", () => {
  let dir: string | undefined;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a v46 database migrates: legacy approvals keep their digest, read as routine with no route, and still prove for dispatch", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v47-"));
    const db = join(dir, "orders.db");
    store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    expect(added.ok).toBe(true);
    file(store, "legacy");
    const filed = store.getScope("legacy")!;
    const sealed = approve(store, "legacy", "alex", T0, filed.digest, "tok-alex");
    expect(sealed.ok).toBe(true);
    const digestBefore = store.getScope("legacy")!.digest;

    // Wind the file back to the v46 shape: drop every v47 column and table.
    const raw = store.raw();
    raw.exec("ALTER TABLE task_scope DROP COLUMN risk_level");
    raw.exec("ALTER TABLE task_scope DROP COLUMN proposed_route_json");
    raw.exec("ALTER TABLE task_scope DROP COLUMN approved_route_json");
    raw.exec("ALTER TABLE task_ref DROP COLUMN risk_level");
    raw.exec("ALTER TABLE task_ref DROP COLUMN route_overrides_json");
    raw.exec("ALTER TABLE review_request DROP COLUMN route_digest");
    raw.exec("DROP TABLE phase_tier_config");
    raw.exec("DROP TABLE provider_readiness");
    raw.exec("DROP TABLE run_route");
    raw.prepare("UPDATE schema_version SET version = 46").run();
    store.close();
    store = null;

    store = openStore(db);
    expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    for (const table of ["phase_tier_config", "provider_readiness", "run_route"]) {
      expect(store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
    }
    const scope = store.getScope("legacy")!;
    expect(scope.digest).toBe(digestBefore);
    expect(scope.riskLevel).toBe("routine");
    expect(scope.proposedRouteJson).toBeNull();
    expect(scope.approvedRouteJson).toBeNull();
    expect(approvalOf(scope).approved).toBe(true);
    expect(store.approvedRouteOf("legacy")).toBeNull();
    expect(store.refFor("built-in", "legacy")).toMatchObject({ riskLevel: null, routeOverrides: [] });
    // The sealed profile alone governs a legacy build — exactly as before.
    const proof = proveApprovedProfile(scope, null, { provider: "claude", model: "sonnet", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false });
    expect(proof.ok).toBe(true);
  });

  test("a fresh v47 scope files a canonical route; routine defaults are legacy-equivalent and digest as before", () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    file(store, "plain");
    const plain = store.getScope("plain")!;
    const route = routeFromJson(plain.proposedRouteJson ?? null);
    expect(route).not.toBeNull();
    expect(routeIsSigned(route!)).toBe(false);
    expect(route!.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
      ["plan", "claude", null],
      ["build", "claude", "sonnet"],
      ["repair", "claude", null],
      ["review", "claude", null],
    ]);
    // Same terms, same digest: the route folds in nothing on a routine scope.
    file(store, "twin");
    expect(store.getScope("twin")!.digest).toBe(plain.digest);
    // Risk is a signed term: the digest moves, and the route is sealed by approval.
    file(store, "risky", "high");
    const risky = store.getScope("risky")!;
    expect(risky.riskLevel).toBe("high");
    expect(risky.digest).not.toBe(plain.digest);
    expect(routeIsSigned(routeFromJson(risky.proposedRouteJson ?? null)!)).toBe(true);
  });

  test("runner readiness rows are per runner and survive reopen; a cascade removes a retired runner's rows", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v47-readiness-"));
    const db = join(dir, "orders.db");
    store = openStore(db);
    register(store, { name: "mac-mini", host: "h", repos: ["/repo/app"], now: T0 });
    store.recordProviderReadiness(
      "mac-mini",
      [
        { provider: "codex", state: "unavailable", reason: "not logged in", probe: "identity" },
        { provider: "claude", state: "unknown", reason: "no non-spending login check exists", probe: "version" },
      ],
      T0,
    );
    store.close();
    store = openStore(db);
    expect(store.runnerReadinessOf("mac-mini", "codex")).toMatchObject({ state: "unavailable", reason: "not logged in", observedAt: T0.toISOString() });
    expect(store.runnerReadinessOf("mac-mini", "gemini")).toBeNull();
    const lookup = store.readinessLookupFor("/repo/app", null, T0);
    expect(lookup("claude")?.state).toBe("unknown");
    expect(lookup("codex")?.runner).toBe("mac-mini");
    expect(lookup("openrouter")).toBeNull();
    // A newer observation replaces the older one for the same runner.
    store.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "ready", reason: "logged in as ops", probe: "identity" }], new Date(T0.getTime() + 60_000));
    expect(store.runnerReadinessOf("mac-mini", "codex")?.state).toBe("ready");
    expect(store.providerReadiness("mac-mini")).toHaveLength(2);
  });
});
