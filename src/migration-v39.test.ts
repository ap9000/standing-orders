/**
 * Schema v39 (Acceptance Contract v2): the migration is purely additive —
 * one nullable column, `task_scope.acceptance_json` and
 * `routine.acceptance_json`, added by the same idempotent `addColumn`
 * every migration since v8 has used. The property this file exists to
 * prove is the grandfathering promise itself: a scope approved on a v38
 * database keeps EXACTLY the digest and approval it had before the
 * database file ever sees this code, and reads its rubric back as `[]`,
 * not an error.
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeFromJson } from "./phase-routing.js";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { propose, approve, addApprover, digestOf } from "./scope.js";

const T0 = new Date("2026-09-01T00:00:00.000Z");

describe("schema v39: acceptance_json is additive, and a v38 approval survives byte for byte", () => {
  let dir: string;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("a scope approved before this migration keeps its digest, its approval, and reads acceptance as []", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v39-"));
    const file = join(dir, "queue.db");

    // Seed on a database that is honestly at v39 already (openStore always
    // speaks its own SCHEMA_VERSION) — then roll the version marker back to
    // simulate "this file has not seen v39 code yet". The column stays
    // exactly as it was written: this is what a real v38 file looks like
    // to the migration, since acceptance_json is additive and nothing here
    // ever widens a CHECK or rebuilds a table.
    let seeded = openStore(file);
    seeded.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    seeded.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    seeded.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    seeded.createTask({ id: "t-legacy", title: "legacy task" }, T0);
    const added = addApprover(seeded, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    const draft = { goal: "guard the payout path", outOfScope: "no schema changes", touches: ["src/payout.ts"] };
    const proposed = propose(seeded, { taskId: "t-legacy", ...draft, now: T0 });
    const sealed = approve(seeded, "t-legacy", "alex", T0, proposed.digest, added.token);
    if (!sealed.ok) throw new Error(`approve failed: ${sealed.reason}`);
    const beforeDigest = sealed.scope.digest;
    const beforeApprovedDigest = sealed.scope.approvedDigest;
    expect(beforeApprovedDigest).toBe(beforeDigest);
    // Bound to the resolved profile (v24 filing invariant), not the bare
    // fields-only digest — proving that still holds is the point of the
    // final re-derivation check below, against the ACTUAL stored profile.

    // Roll the marker back to v38 — a real upgrade candidate.
    seeded.raw().prepare("UPDATE schema_version SET version = 38").run();
    seeded.close();

    // Reopen: the migration runs, bumps the marker back to SCHEMA_VERSION,
    // and touches nothing about the row's meaning.
    store = openStore(file);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);

    const scope = store.getScope("t-legacy");
    expect(scope?.digest).toBe(beforeDigest);
    expect(scope?.approvedDigest).toBe(beforeApprovedDigest);
    expect(scope?.approvedAt).not.toBeNull();
    expect(scope?.acceptance).toEqual([]);

    // The column exists and is genuinely nullable — a legacy row reads
    // back NULL, not a coerced empty string or a parse failure.
    const raw = store.raw().prepare("SELECT acceptance_json FROM task_scope WHERE task_id = 't-legacy'").get();
    expect(raw?.["acceptance_json"]).toBeNull();

    // The digest computation itself is the same function, unconditionally
    // re-derivable from the row (fields plus the resolved profile it bound,
    // plus — since v47 — the exact agent route every fresh row binds) —
    // proving the migration did not silently fold anything new into what
    // was signed.
    expect(
      digestOf({ goal: scope!.goal, outOfScope: scope!.outOfScope, touches: scope!.touches }, scope!.profile ?? null, routeFromJson(scope!.proposedRouteJson ?? null)),
    ).toBe(beforeDigest);
  });

  test("re-running the migration on an already-v39 file is a no-op (idempotent addColumn)", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v39-idem-"));
    const file = join(dir, "queue.db");
    store = openStore(file);
    store.createTask({ id: "t-a", title: "a" }, T0);
    store.close();
    // Reopening an already-current file must not throw, and must not
    // duplicate the column or otherwise change shape.
    store = openStore(file);
    expect(store.getTask("t-a")).not.toBeNull();
    const columns = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('task_scope') WHERE name = 'acceptance_json'")
      .get();
    expect(columns?.["n"]).toBe(1);
  });
});
