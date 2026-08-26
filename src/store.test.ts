import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, BUILT_IN, type Capability, type Store } from "./store.js";
import { acquire } from "./claim.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("the built-in task store", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("creates a task, queued, with a reference it can be claimed through", () => {
    // A task with no TaskRef is work the control plane can see and never act
    // on, so the two are created together or not at all.
    const task = store.createTask({ id: "t-1", title: "wire the payout webhook" }, T0);

    expect(task.state).toBe("queued");
    expect(store.getTask("t-1")).toEqual(task);
    expect(store.refFor(BUILT_IN, "t-1").id).toBeGreaterThan(0);
  });

  test("is null about a task it does not have", () => {
    expect(store.getTask("nope")).toBeNull();
  });

  test("moves a task between states", () => {
    store.createTask({ id: "t-1", title: "a" }, T0);

    expect(store.setTaskState("t-1", "running", later(1_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(store.getTask("t-1")?.updatedAt).toBe(later(1_000).toISOString());
  });

  test("says so when there was nothing to move", () => {
    expect(store.setTaskState("ghost", "done", T0)).toMatchObject({ ok: false, reason: "unknown-task" });
  });

  describe("the ready set", () => {
    test("holds a task back until what it waits on is done", () => {
      store.createTask({ id: "schema", title: "schema" }, T0);
      store.createTask({ id: "api", title: "api" }, T0);
      store.addEdge("api", "schema");

      expect(ready(store)).toEqual(["schema"]);

      store.setTaskState("schema", "done", later(1_000));
      expect(ready(store)).toEqual(["api"]);
    });

    test("counts only `done` as satisfying a dependency", () => {
      // A blocker that failed or was cancelled has not delivered what the
      // dependent task needs; releasing it would dispatch work onto a
      // foundation that is not there.
      store.createTask({ id: "schema", title: "schema" }, T0);
      store.createTask({ id: "api", title: "api" }, T0);
      store.addEdge("api", "schema");

      for (const state of ["running", "failed", "cancelled"] as const) {
        store.setTaskState("schema", state, later(1_000));
        expect(ready(store)).not.toContain("api");
      }
    });

    test("waits for every blocker, not the first one", () => {
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);
      store.createTask({ id: "c", title: "c" }, T0);
      store.addEdge("c", "a");
      store.addEdge("c", "b");

      store.setTaskState("a", "done", later(1_000));
      expect(ready(store)).not.toContain("c");

      store.setTaskState("b", "done", later(2_000));
      expect(ready(store)).toContain("c");
    });

    test("leaves out anything already claimed", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;

      acquire(store, ref, "runner-a", { now: T0 });

      expect(ready(store)).toEqual([]);
    });

    test("offers a task again once its claim lapses", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;
      acquire(store, ref, "runner-a", { now: T0, ttlMs: 60_000 });

      expect(ready(store, later(120_000))).toEqual(["t-1"]);
    });

    test("leaves out anything on hold, and takes it back when the hold lapses", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;

      store.hold(ref, "waiting on the design call", later(60_000), T0);
      expect(ready(store, later(1_000))).toEqual([]);

      // A hold whose `until` has passed is not a hold. Reading it as one
      // strands the work at the moment it was meant to resume.
      expect(ready(store, later(61_000))).toEqual(["t-1"]);
    });

    test("holds indefinitely when no expiry was given", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;

      store.hold(ref, "needs a decision", null, T0);

      expect(ready(store, later(9e8))).toEqual([]);
      expect(store.unhold(ref)).toBe(true);
      expect(ready(store, later(9e8))).toEqual(["t-1"]);
    });

    test("reports the hold in force, and ignores one that has lapsed", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);
      const ref = store.refFor(BUILT_IN, "t-1").id;
      store.hold(ref, "waiting on the design call", later(60_000), T0);

      expect(store.activeHold(ref, later(1_000))?.reason).toBe("waiting on the design call");
      expect(store.activeHold(ref, later(61_000))).toBeNull();
    });

    test("orders by creation, so the oldest queued work goes first", () => {
      store.createTask({ id: "first", title: "a" }, T0);
      store.createTask({ id: "second", title: "b" }, later(1_000));

      expect(ready(store)).toEqual(["first", "second"]);
    });
  });

  describe("edges", () => {
    test("refuses a task that waits on itself", () => {
      store.createTask({ id: "t-1", title: "a" }, T0);

      expect(store.addEdge("t-1", "t-1")).toMatchObject({ ok: false });
    });

    test("refuses a cycle rather than storing one", () => {
      // Stored, a cycle is invisible: every task in the ring stays un-ready
      // forever, the ready set quietly comes back shorter, and nothing
      // anywhere says why.
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);
      store.createTask({ id: "c", title: "c" }, T0);
      store.addEdge("b", "a");
      store.addEdge("c", "b");

      const result = store.addEdge("a", "c");

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("cycle");
      expect(ready(store)).toEqual(["a"]);
    });

    test("is indifferent to being told the same edge twice", () => {
      store.createTask({ id: "a", title: "a" }, T0);
      store.createTask({ id: "b", title: "b" }, T0);

      expect(store.addEdge("b", "a")).toEqual({ ok: true });
      expect(store.addEdge("b", "a")).toEqual({ ok: true });
      expect(ready(store)).toEqual(["a"]);
    });
  });

  describe("the overlay", () => {
    test("keeps one reference per task, whoever asks", () => {
      const first = store.refFor("beads", "bd-17");
      const again = store.refFor("beads", "bd-17");

      expect(again.id).toBe(first.id);
    });

    test("keeps references from different backends apart", () => {
      // The same external id in two trackers is two different pieces of work,
      // and merging them would attach one task's claims to another's.
      const beads = store.refFor("beads", "17");
      const issues = store.refFor("github-issues", "17");

      expect(beads.id).not.toBe(issues.id);
    });

    test("references a backend it has never seen", () => {
      // The overlay outlives any particular backend; that is the point of
      // keying on (backend, external_id) rather than on our own task table.
      const ref = store.refFor("something-invented-later", "x-1");

      expect(ref.backend).toBe("something-invented-later");
      expect(ref.zones).toEqual([]);
      expect(ref.capabilityRequirements).toEqual([]);
    });
  });

  describe("idempotency", () => {
    test("runs a keyed mutation once, however many times it is retried", () => {
      // The case: a runner completes, the acknowledgement is lost, it retries.
      store.createTask({ id: "t-1", title: "first" }, T0, { idempotencyKey: "k-1", at: T0 });
      store.createTask({ id: "t-1", title: "second" }, T0, { idempotencyKey: "k-1", at: T0 });

      expect(store.getTask("t-1")?.title).toBe("first");
    });

    test("records only mutations that mutated something", () => {
      // A state change matching no task did nothing, so there is nothing to
      // replay. Recording it would answer "no such task" forever — including
      // after somebody creates it, which is exactly what happens when work is
      // queued in one order and dispatched in another.
      const first = store.setTaskState("ghost", "done", T0, { idempotencyKey: "k-2", at: T0 });
      store.createTask({ id: "ghost", title: "now it exists" }, T0);
      const afterwards = store.setTaskState("ghost", "done", T0, { idempotencyKey: "k-2", at: T0 });

      expect(first).toMatchObject({ ok: false, reason: "unknown-task" });
      expect(afterwards).toMatchObject({ ok: true });
      expect(store.getTask("ghost")?.state).toBe("done");
    });

    test("still replays a mutation that did happen", () => {
      store.createTask({ id: "t-1", title: "first" }, T0, { idempotencyKey: "k-3", at: T0 });
      store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      // The retry must not re-run against a task that has moved on since.
      store.setTaskState("t-1", "running", later(1_000));
      const replayed = store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      expect(replayed).toMatchObject({ ok: true });
      expect(store.getTask("t-1")?.state).toBe("running");
    });

    test("treats different keys as different mutations", () => {
      store.createTask({ id: "a", title: "a" }, T0, { idempotencyKey: "k-a", at: T0 });
      store.createTask({ id: "b", title: "b" }, T0, { idempotencyKey: "k-b", at: T0 });

      expect(ready(store)).toEqual(["a", "b"]);
    });
  });

  test("survives being closed and opened again", async () => {
    // WAL, foreign keys, and the schema guard all have to hold on a file that
    // already exists — the second run is the one every real user has.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "standing-orders-store-"));
    const file = join(dir, "nested", "orders.db");

    const first = openStore(file);
    first.createTask({ id: "t-1", title: "persisted" }, T0);
    first.close();

    const second = openStore(file);
    expect(second.getTask("t-1")?.title).toBe("persisted");
    second.close();

    await rm(dir, { recursive: true, force: true });
  });
});

/** The ready set as task ids, which is what the assertions are actually about. */
function ready(store: Store, now: Date = later(5_000)): string[] {
  return store.listReady(now).map(ref => ref.externalId);
}

describe("opening a database that already exists", () => {
  test("adds a column the schema grew after the file was made", async () => {
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table already there, so a
    // column added later never reaches an existing database — and every test
    // against :memory: or a fresh path passes while the first real one fails
    // on the next query. Which is exactly how this was found.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "standing-orders-migrate-"));
    const file = join(dir, "orders.db");

    const first = openStore(file);
    first.createTask({ id: "t-1", title: "before" }, T0);
    // Put the file back the way an older build would have left it.
    first.handle.exec("ALTER TABLE task_ref DROP COLUMN origin");
    first.close();

    const second = openStore(file);
    expect(second.originOf(BUILT_IN, "t-1")).toBe("theirs");
    expect(() => second.listReady(T0)).not.toThrow();
    second.close();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("a task and its reference are created together", () => {
  test("a failure partway leaves neither behind", () => {
    // Found in a real database. A schema change made the reference insert
    // fail, the task insert had already committed, and the result was a task
    // the ready query could not see and nothing could claim — which something
    // else later gave a reference to, with the wrong origin. The invariant was
    // written in a comment and not enforced.
    const store = openStore(":memory:");
    store.handle.exec("DROP TABLE task_ref");

    expect(() => store.createTask({ id: "t-1", title: "doomed" }, T0)).toThrow();

    // The task row must not have survived its own half-finished creation.
    const rows = store.handle.prepare("SELECT count(*) AS n FROM task").get();
    expect(Number(rows?.["n"])).toBe(0);
    store.close();
  });

  test("a task standing-orders created is recorded as ours", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "ours" }, T0);

    expect(store.originOf(BUILT_IN, "t-1")).toBe("ours");
    store.close();
  });
});

describe("capabilities", () => {
  const T0 = new Date("2026-08-11T22:00:00.000Z");

  const one = (over: Partial<Capability> = {}): Capability => ({
    repo: "/code/thing",
    kind: "env",
    name: "SUPABASE_KEY",
    probe: 'test -n "$SUPABASE_KEY"',
    status: "unprobed",
    addedBy: "alex",
    createdAt: T0.toISOString(),
    lastVerifiedAt: null,
    verifiedBy: null,
    lastResult: null,
    expiresAt: null,
    ...over,
  });

  test("records metadata and only metadata — there is no value column", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "unprobed",
      probe: 'test -n "$SUPABASE_KEY"',
    });
    // The schema itself must have nowhere to put a secret.
    const columns = store.handle
      .prepare("PRAGMA table_info(capability)")
      .all()
      .map(row => String(row["name"]));
    expect(columns).not.toContain("value");
    store.close();
  });

  test("verification carries the moment it happened", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());

    store.markCapability("/code/thing", "env", "SUPABASE_KEY", { status: "verified", by: "builder-1" }, T0);

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "verified",
      lastVerifiedAt: T0.toISOString(),
      verifiedBy: "builder-1",
    });
    store.close();
  });

  test("a failed probe clears the verification stamp", () => {
    const store = openStore(":memory:");
    store.saveCapability(one());
    store.markCapability("/code/thing", "env", "SUPABASE_KEY", { status: "verified", by: "builder-1" }, T0);

    store.markCapability(
      "/code/thing", "env", "SUPABASE_KEY",
      { status: "failed", by: "builder-1", detail: "exit 1" },
      new Date(T0.getTime() + 1_000),
    );

    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "failed",
      lastVerifiedAt: null,
      lastResult: "exit 1",
    });
    store.close();
  });

  test("requirements replace what a task needed before", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1").id;

    store.setRequirements(ref, ["env:SUPABASE_KEY", "cli:gh"]);
    expect(store.refFor(BUILT_IN, "t-1").capabilityRequirements).toEqual(["env:SUPABASE_KEY", "cli:gh"]);

    store.setRequirements(ref, ["cli:gh"]);
    expect(store.refFor(BUILT_IN, "t-1").capabilityRequirements).toEqual(["cli:gh"]);
    store.close();
  });

  test("a task can be placed in a repository, and starts placed nowhere", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1");
    expect(ref.repo).toBeNull();

    store.placeTask(ref.id, "/code/thing");

    expect(store.refFor(BUILT_IN, "t-1").repo).toBe("/code/thing");
    store.close();
  });
});

describe("the M3 schema: owned holds, decisions, evidence, incidents", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  const refOf = (id: string) => {
    store.createTask({ id, title: id }, T0);
    return store.refFor(BUILT_IN, id).id;
  };

  const runOn = (ref: number) =>
    store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });

  test("two owners can hold one task, and each lifts only its own", () => {
    const ref = refOf("t-1");

    store.hold(ref, "operator pause", null, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: "7", reason: "decision:7", until: null },
      T0,
    );

    expect(store.activeHolds(ref, later(1_000))).toHaveLength(2);

    // The CLI's unhold is the operator's hand; the decision's hold survives it.
    expect(store.unhold(ref)).toBe(true);
    const remaining = store.activeHolds(ref, later(1_000));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ownerKind).toBe("decision");

    expect(store.releaseOwnedHold("decision", "7")).toBe(true);
    expect(store.activeHolds(ref, later(1_000))).toHaveLength(0);
  });

  test("any active hold keeps a task off the ready set, whoever owns it", () => {
    const ref = refOf("t-1");
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: "3", reason: "decision:3", until: null },
      T0,
    );

    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual([]);
  });

  test("a decision round-trips, its options typed and its task attached", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The migration drops signup_source, which analytics reads.",
        question: "Drop the column, or keep it and backfill?",
        options: [
          { id: "keep", label: "Keep + backfill", consequence: "Analytics unaffected.", reversible: true },
          { id: "drop", label: "Drop it", consequence: "3 dashboards break silently.", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );

    const decision = store.getDecision(id);
    expect(decision?.state).toBe("open");
    expect(decision?.options[1]?.reversible).toBe(false);
    expect(store.decisionForRun(run)?.id).toBe(id);
    expect(store.listDecisions()[0]).toMatchObject({ id, taskId: "t-1" });
  });

  test("one run gets one decision, ever", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);
    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "a" },
      T0,
    );

    expect(() =>
      store.saveDecision(
        { run, urgency: "blocking", recap: "r2", question: "q2", options: [option], recommendation: "a" },
        T0,
      ),
    ).toThrow();
  });

  test("an overdue open decision expires — louder, never chosen for", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);
    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "q",
        options: [option],
        recommendation: "a",
        deadline: later(60_000).toISOString(),
      },
      T0,
    );

    expect(store.expireOverdueDecisions(later(30_000))).toBe(0);
    expect(store.expireOverdueDecisions(later(61_000))).toBe(1);

    const expired = store.getDecision(id);
    expect(expired?.state).toBe("expired");
    expect(expired?.choice).toBeNull();
    // Expired is still unanswered — it shows up, it does not go away.
    expect(store.countUnanswered()).toBe(1);
    expect(store.listDecisions("open")).toHaveLength(0);
  });

  test("evidence links only within the decision's own run", () => {
    const ref = refOf("t-1");
    const other = refOf("t-2");
    const run = runOn(ref);
    const foreign = store.startRun({
      taskRef: other,
      leaseId: "lease-2",
      runner: "builder-1",
      branch: "standing-orders/t-2",
      worktree: "/pool/t-2",
      now: T0,
    });

    const option = { id: "a", label: "a", consequence: "c", reversible: true };
    const decision = store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "a" },
      T0,
    );
    const ours = store.saveArtifact(
      { run, kind: "diff", key: "1/diff.patch", bytesOriginal: 10, bytesStored: 10, truncated: false, sha256: "x", capture: "git diff (exit 0)" },
      T0,
    );
    const theirs = store.saveArtifact(
      { run: foreign, kind: "diff", key: "2/diff.patch", bytesOriginal: 10, bytesStored: 10, truncated: false, sha256: "y", capture: "git diff (exit 0)" },
      T0,
    );

    store.linkEvidence(decision, ours);
    expect(store.evidenceFor(decision).map(a => a.id)).toEqual([ours]);

    // Another run's artifact is not this decision's evidence, whatever any
    // payload claims — the guard is the INSERT itself.
    expect(() => store.linkEvidence(decision, theirs)).toThrow(/never crosses runs/);
  });

  test("an incident stays open until resolved, and resolving lifts its hold", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    const id = store.createIncident({ run, kind: "malformed-decision" }, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "incident", ownerId: String(id), reason: "malformed-decision", until: null },
      T0,
    );

    expect(store.openIncidents()[0]).toMatchObject({ id, taskId: "t-1" });
    expect(store.listReady(later(9e8))).toHaveLength(0);

    expect(store.resolveIncident(id, "alex", later(1_000))).toBe(true);
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual(["t-1"]);
    // Resolving twice is not a second resolution.
    expect(store.resolveIncident(id, "alex", later(2_000))).toBe(false);
  });

  test("a resolved episode stops being pending but keeps its receipts", () => {
    store.enqueueNotification(
      { dedupeKey: "decision:1", kind: "decision", subject: "s", body: "b" },
      T0,
    );
    const [row] = store.listNotifications("pending");
    expect(row).toBeDefined();
    store.recordDelivery(row!.id, { ok: true, receipt: "msg-42" }, later(1_000));

    store.resolveEpisode("decision:1", later(2_000));

    expect(store.listNotifications("pending")).toHaveLength(0);
    const [kept] = store.listNotifications("all");
    expect(kept?.receipt).toBe("msg-42");
    expect(kept?.resolvedAt).toBe(later(2_000).toISOString());
  });

  test("a run stamps its base revision and session once, first answer wins", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);

    store.stampRun(run, { baseRevision: "abc123" });
    store.stampRun(run, { baseRevision: "def456", sessionId: "sess-1" });

    expect(store.getRun(run)).toMatchObject({
      baseRevision: "abc123",
      sessionId: "sess-1",
      role: "builder",
      parentRun: null,
    });
  });

  test("a repair run records its parentage, and 'parked' is a real outcome", () => {
    const ref = refOf("t-1");
    const run = runOn(ref);
    const repair = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      role: "repair",
      parentRun: run,
      sessionId: "sess-1",
      now: later(1_000),
    });

    store.finishRun(run, { outcome: "parked", reason: "decision:1", now: later(2_000) });

    expect(store.getRun(repair)).toMatchObject({ role: "repair", parentRun: run });
    expect(store.getRun(run)).toMatchObject({ outcome: "parked", reason: "decision:1" });
  });
});

describe("migration from an M2 database", () => {
  test("rebuilds hold and run in place, keeping every row", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m2-"));
    const file = join(dir, "orders.db");

    // The M2 shapes, verbatim — this is what a real database looks like the
    // morning M3 ships. Fresh-`:memory:` tests never see this file; the first
    // real `park` would have.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        UNIQUE (backend, external_id)
      );
      CREATE TABLE hold (
        task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, until TEXT, held_at TEXT NOT NULL
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL, branch TEXT NOT NULL,
        worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE notification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
        last_error TEXT, delivered_at TEXT, receipt TEXT
      );
      INSERT INTO task VALUES ('t-1','the work','queued','2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin) VALUES ('built-in','t-1','ours');
      INSERT INTO hold VALUES (1, 'waiting on legal', NULL, '2026-08-11T00:00:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, committed, started_at, finished_at)
        VALUES (1,'lease-1','builder-1','standing-orders/t-1','/pool/t-1','built',1,'2026-08-11T01:00:00.000Z','2026-08-11T01:10:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, started_at)
        VALUES (1,'lease-2','builder-1','standing-orders/t-1','/pool/t-1','2026-08-11T02:00:00.000Z');
      INSERT INTO notification (dedupe_key, kind, subject, body, created_at, delivered_at, receipt)
        VALUES ('gap:x:env:KEY','gap','s','b','2026-08-11T00:00:00.000Z','2026-08-11T00:01:00.000Z','r-1');
    `);
    old.close();

    const store = openStore(file);
    try {
      // The old hold survived as the operator's, and still holds.
      const holds = store.activeHolds(1, T0);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ ownerKind: "operator", reason: "waiting on legal" });
      expect(store.listReady(T0)).toHaveLength(0);
      expect(store.unhold(1)).toBe(true);
      expect(store.listReady(T0).map(r => r.externalId)).toEqual(["t-1"]);

      // Runs kept their ids, their outcomes, and their cut-down NULLs.
      expect(store.getRun(1)).toMatchObject({ outcome: "built", committed: true, role: "builder" });
      expect(store.getRun(2)).toMatchObject({ outcome: null, role: "builder" });

      // And the widened CHECK is real on this database, not just on fresh ones.
      store.finishRun(2, { outcome: "parked", reason: "decision:1", now: T0 });
      expect(store.getRun(2)?.outcome).toBe("parked");

      // The delivered notification kept its receipt through the column add.
      expect(store.listNotifications("all")[0]).toMatchObject({ receipt: "r-1", resolvedAt: null });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answering a decision", () => {
  let store: Store;
  let ref: number;
  let decisionId: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    ref = store.refFor(BUILT_IN, "t-1").id;
    const run = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    decisionId = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "q",
        options: [
          { id: "keep", label: "Keep", consequence: "fine", reversible: true },
          { id: "drop", label: "Drop", consequence: "gone", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );
    store.holdOwned(
      { taskRef: ref, ownerKind: "decision", ownerId: String(decisionId), reason: "decision", until: null },
      T0,
    );
    store.enqueueNotification(
      { dedupeKey: `decision:${decisionId}`, kind: "decision", subject: "s", body: "b" },
      T0,
    );
  });

  afterEach(() => store.close());

  test("one act: the answer, the hold, and the outbox episode", () => {
    const answered = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli", note: "backfill tonight" },
      later(1_000),
    );

    expect(answered).toMatchObject({ ok: true });
    if (!answered.ok) return;
    expect(answered.decision).toMatchObject({
      state: "answered",
      choice: "keep",
      answeredBy: "alex",
      answeredVia: "cli",
      note: "backfill tonight",
    });
    // The hold is gone and the task is dispatchable again.
    expect(store.activeHolds(ref, later(2_000))).toHaveLength(0);
    expect(store.listReady(later(2_000)).map(r => r.externalId)).toEqual(["t-1"]);
    // The episode is resolved, not deleted — receipts survive.
    expect(store.listNotifications("pending")).toHaveLength(0);
    expect(store.listNotifications("all")[0]?.resolvedAt).toBe(later(1_000).toISOString());
  });

  test("a decision is answered once: same choice replays, different choice refuses", () => {
    store.answerDecision({ id: decisionId, choice: "keep", by: "alex", via: "cli" }, later(1_000));

    const replay = store.answerDecision({ id: decisionId, choice: "keep", by: "alex", via: "web" }, later(2_000));
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    if (replay.ok) expect(replay.decision.answeredVia).toBe("cli");

    const contradiction = store.answerDecision({ id: decisionId, choice: "drop", by: "sam", via: "cli" }, later(3_000));
    expect(contradiction).toMatchObject({ ok: false, reason: "already-answered" });
    expect(store.getDecision(decisionId)?.choice).toBe("keep");
  });

  test("an expired decision is still answerable — expiry never chooses", () => {
    store.handle
      .prepare("UPDATE decision SET state = 'expired' WHERE id = ?")
      .run(decisionId);

    const answered = store.answerDecision({ id: decisionId, choice: "drop", by: "alex", via: "cli" }, later(1_000));
    expect(answered).toMatchObject({ ok: true });
    expect(store.getDecision(decisionId)?.state).toBe("answered");
  });

  test("refusals: an option that is not there, a hostile note, a ghost id", () => {
    expect(store.answerDecision({ id: decisionId, choice: "ship-it", by: "alex", via: "cli" }, T0)).toMatchObject({
      ok: false,
      reason: "bad-option",
    });
    expect(
      store.answerDecision(
        { id: decisionId, choice: "keep", by: "alex", via: "cli", note: "ok\u001b]0;pwn" },
        T0,
      ),
    ).toMatchObject({ ok: false, reason: "bad-note" });
    expect(store.answerDecision({ id: 999, choice: "keep", by: "alex", via: "cli" }, T0)).toMatchObject({
      ok: false,
      reason: "unknown-decision",
    });
    // Nothing above lifted the hold.
    expect(store.activeHolds(ref, later(1_000))).toHaveLength(1);
  });

  test("an idempotency key replays the first answer", () => {
    const first = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli" },
      later(1_000),
      { idempotencyKey: "answer-1" },
    );
    const replay = store.answerDecision(
      { id: decisionId, choice: "keep", by: "alex", via: "cli" },
      later(60_000),
      { idempotencyKey: "answer-1" },
    );
    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true });
    if (first.ok && replay.ok) {
      expect(replay.decision.answeredAt).toBe(first.decision.answeredAt);
    }
  });
});

describe("migration from an M3 database", () => {
  test("rebuilds decision's answered_via CHECK in place, rows and ids intact", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m3-"));
    const file = join(dir, "orders.db");

    // The M3 shapes for exactly the tables the rebuild touches or references:
    // decision (with the old two-value CHECK), its run and task_ref parents,
    // and the relations that must survive the copy.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (2);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        UNIQUE (backend, external_id)
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
        parent_run INTEGER REFERENCES run(id), session_id TEXT, base_revision TEXT,
        branch TEXT NOT NULL, worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused','parked')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE decision (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run            INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
        urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
        state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
        recap          TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL,
        recommendation TEXT NOT NULL, assignee TEXT, deadline TEXT, created_at TEXT NOT NULL,
        answered_at    TEXT, answered_by TEXT,
        answered_via   TEXT CHECK (answered_via IN ('cli','web')),
        choice         TEXT, note TEXT
      );
      CREATE TABLE run_decision (
        run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
        choice TEXT NOT NULL, note TEXT, PRIMARY KEY (run, decision)
      );
      INSERT INTO task VALUES ('t-1','w','queued','2026-08-11T00:00:00.000Z','2026-08-11T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin) VALUES ('built-in','t-1','ours');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, started_at)
        VALUES (1,'l-1','b','br','/w','parked','2026-08-11T01:00:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, outcome, started_at)
        VALUES (1,'l-2','b','br','/w','parked','2026-08-11T02:00:00.000Z');
      INSERT INTO decision (run, urgency, recap, question, options, recommendation, created_at,
                            state, answered_at, answered_by, answered_via, choice, note)
        VALUES (1,'blocking','r','q','[{"id":"a","label":"a","consequence":"c","reversible":true},{"id":"b","label":"b","consequence":"c","reversible":true}]','a',
                '2026-08-11T01:00:00.000Z','answered','2026-08-11T03:00:00.000Z','alex','web','a','noted');
      INSERT INTO decision (run, urgency, recap, question, options, recommendation, created_at)
        VALUES (2,'blocking','r2','q2','[{"id":"a","label":"a","consequence":"c","reversible":true},{"id":"b","label":"b","consequence":"c","reversible":true}]','b',
                '2026-08-11T02:00:00.000Z');
      INSERT INTO run_decision (run, decision, choice, note) VALUES (2, 1, 'a', 'noted');
    `);
    old.close();

    const store = openStore(file);
    try {
      // Everything survived the copy: ids, the answered row's whole shape,
      // the open row, and the relation across the rebuilt table.
      expect(store.getDecision(1)).toMatchObject({
        state: "answered", choice: "a", answeredBy: "alex", answeredVia: "web", note: "noted",
      });
      expect(store.getDecision(2)).toMatchObject({ state: "open", recommendation: "b" });
      expect(store.answersFor(2)).toMatchObject([{ choice: "a", note: "noted" }]);

      // The widened CHECK is real on this database: telegram answers land.
      const answered = store.answerDecision(
        { id: 2, choice: "b", by: "alex", via: "telegram" },
        new Date("2026-08-11T04:00:00.000Z"),
      );
      expect(answered).toMatchObject({ ok: true });
      expect(store.getDecision(2)?.answeredVia).toBe("telegram");

      // The v4 CHECK widenings are real on this database too.
      store.finishRun(2, { outcome: "no-change", reason: "handoff", now: new Date("2026-08-12T06:00:00.000Z") });
      expect(store.getRun(2)?.outcome).toBe("no-change");
      store.holdOwned(
        { taskRef: 1, ownerKind: "backoff", ownerId: "1", reason: "retry in 2m", until: null },
        new Date("2026-08-12T06:00:00.000Z"),
      );
      expect(store.activeHolds(1, new Date("2026-08-12T06:01:00.000Z"))[0]?.ownerKind).toBe("backoff");
      store.releaseOwnedHold("backoff", "1");
      const stallRun = store.startRun({
        taskRef: 1, leaseId: "l-stall", runner: "b", branch: "br", worktree: "/w",
        now: new Date("2026-08-12T06:00:00.000Z"),
      });
      const stall = store.createIncident({ run: stallRun, kind: "attempts-exhausted" }, new Date("2026-08-12T06:00:00.000Z"));
      expect(store.openIncidents().find(one => one.id === stall)?.kind).toBe("attempts-exhausted");

      // New decisions keep counting from where the old table left off.
      const run3 = store.startRun({
        taskRef: 1, leaseId: "l-3", runner: "b", branch: "br", worktree: "/w",
        now: new Date("2026-08-11T05:00:00.000Z"),
      });
      const next = store.saveDecision(
        {
          run: run3, urgency: "blocking", recap: "r3", question: "q3",
          options: [
            { id: "a", label: "a", consequence: "c", reversible: true },
            { id: "b", label: "b", consequence: "c", reversible: true },
          ],
          recommendation: "a",
        },
        new Date("2026-08-11T05:00:00.000Z"),
      );
      expect(next).toBe(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognized decision DDL is refused, not guessed at", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-m3-odd-"));
    const file = join(dir, "orders.db");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const odd = new DatabaseSync(file);
    // Somebody's hand-edited shape: neither the old CHECK nor the new one.
    odd.exec(`CREATE TABLE decision (id INTEGER PRIMARY KEY, answered_via TEXT);`);
    odd.close();

    expect(() => openStore(file)).toThrow(/not a shape this migration knows/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the watch foundations", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("the wake sequence moves when readiness could have", () => {
    const before = store.wakeSeq();
    store.createTask({ id: "t-1", title: "w" }, T0);
    expect(store.wakeSeq()).toBeGreaterThan(before);

    const afterCreate = store.wakeSeq();
    store.setTaskState("t-1", "done", later(1_000));
    expect(store.wakeSeq()).toBeGreaterThan(afterCreate);
  });

  test("one watch per (runner, repo); takeover names the superseded incarnation", () => {
    const first = store.acquireWatchLease("builder-1", "/repo", "inc-a", 60_000, T0);
    expect(first).toMatchObject({ ok: true, generation: 1, superseded: null });

    const contender = store.acquireWatchLease("builder-1", "/repo", "inc-b", 60_000, later(1_000));
    expect(contender).toMatchObject({ ok: false, reason: "watch-busy", holder: "inc-a" });

    // A different repo is a different watch entirely.
    expect(store.acquireWatchLease("builder-1", "/other", "inc-b", 60_000, later(1_000))).toMatchObject({
      ok: true,
    });

    // Expiry hands over — and says whose mess to recover.
    const takeover = store.acquireWatchLease("builder-1", "/repo", "inc-b", 60_000, later(120_000));
    expect(takeover).toMatchObject({ ok: true, generation: 2, superseded: "inc-a" });
  });

  test("recovery is keyed to the incarnation, not to runner liveness", async () => {
    const { register } = await import("./runner.js");
    register(store, { name: "builder-1", host: "h", now: T0 });
    store.createTask({ id: "t-1", title: "w" }, T0);
    const ref = store.refFor(BUILT_IN, "t-1").id;
    // The dead incarnation's claim, task mid-flight, run open, worktree leased.
    acquire(store, ref, "builder-1", { now: T0, ttlMs: 60 * 60_000, newLeaseId: () => "lease-a", incarnation: "inc-a" });
    store.setTaskState("t-1", "running", T0);
    const run = store.startRun({
      taskRef: ref, leaseId: "lease-a", runner: "builder-1", branch: "b", worktree: "/w", now: T0,
    });
    store.saveWorktree({
      path: "/w", repo: "/repo", branch: "b", runner: "builder-1", taskRef: ref,
      createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true,
    });

    // The successor is the same runner, heartbeating — which is exactly how
    // this crash would hide from liveness-based recovery.
    const recovered = store.recoverIncarnation("builder-1", "inc-a", later(5_000));

    expect(recovered).toBe(1);
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.getRun(run)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getWorktree("/w")?.releasedAt).not.toBeNull();
    expect(store.getWorktree("/w")?.verified).toBe(false);
    // The claim is released as recovered: its late completion will be fenced.
    const claim = store.handle.prepare("SELECT released_by FROM claim WHERE lease_id = 'lease-a'").get();
    expect(String(claim?.["released_by"])).toBe("recovered");
  });

  test("recovery leaves other incarnations' work alone", () => {
    store.createTask({ id: "t-1", title: "w" }, T0);
    store.createTask({ id: "t-2", title: "w" }, T0);
    const one = store.refFor(BUILT_IN, "t-1").id;
    const two = store.refFor(BUILT_IN, "t-2").id;
    acquire(store, one, "builder-1", { now: T0, newLeaseId: () => "lease-old", incarnation: "inc-a" });
    acquire(store, two, "builder-1", { now: T0, newLeaseId: () => "lease-live", incarnation: "inc-b" });

    expect(store.recoverIncarnation("builder-1", "inc-a", later(1_000))).toBe(1);

    const live = store.handle.prepare("SELECT released_at FROM claim WHERE lease_id = 'lease-live'").get();
    expect(live?.["released_at"]).toBeNull();
  });
});

describe("console mutation semantics, re-proved server-side", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
  });

  afterEach(() => store.close());

  test("cancel refuses while a live claim holds the task", () => {
    const ref = store.refFor(BUILT_IN, "t-1").id;
    acquire(store, ref, "runner-a", { now: T0, ttlMs: 60 * 60_000 });

    expect(store.cancelTask("t-1", later(1_000))).toMatchObject({ ok: false, reason: "claimed" });
    expect(store.getTask("t-1")?.state).toBe("queued");

    // Claim lapsed: cancellation lands, and twice is already-terminal.
    expect(store.cancelTask("t-1", later(2 * 60 * 60_000))).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("cancelled");
    expect(store.cancelTask("t-1", later(2 * 60 * 60_000 + 1_000))).toMatchObject({
      ok: false,
      reason: "already-terminal",
    });
  });

  test("requeue refuses a healthy task and a claimed one — a stale button erases nothing", () => {
    expect(store.requeueTask("t-1", "alex", T0)).toMatchObject({ ok: false, reason: "not-stalled" });

    const ref = store.refFor(BUILT_IN, "t-1").id;
    store.setTaskState("t-1", "failed", T0);
    acquire(store, ref, "runner-a", { now: later(1_000), ttlMs: 60 * 60_000 });
    expect(store.requeueTask("t-1", "alex", later(2_000))).toMatchObject({ ok: false, reason: "claimed" });
  });

  test("console task creation is atomic, capped, and validates what it will later render", () => {
    expect(store.createConsoleTask({ id: "../evil", title: "x" }, T0)).toMatchObject({ ok: false, reason: "bad-id" });
    expect(
      store.createConsoleTask({ id: "ok", title: "x".repeat(300) }, T0),
    ).toMatchObject({ ok: false, reason: "bad-title" });
    expect(store.createConsoleTask({ id: "t-1", title: "dupe" }, T0)).toMatchObject({
      ok: false,
      reason: "duplicate",
    });

    const made = store.createConsoleTask(
      { id: "t-2", title: "wire the API", repo: "/code/thing", goal: "wire it end to end" },
      T0,
    );
    expect(made).toMatchObject({ ok: true });
    expect(store.refFor(BUILT_IN, "t-2").repo).toBe("/code/thing");
    expect(store.getScope("t-2")?.goal).toBe("wire it end to end");
    // Scope created through the console is proposed, never approved.
    expect(store.getScope("t-2")?.approvedDigest).toBeNull();

    // The admission cap counts the active backlog only.
    expect(store.createConsoleTask({ id: "t-3", title: "x" }, T0, 3)).toMatchObject({ ok: true });
    expect(store.createConsoleTask({ id: "t-4", title: "x" }, T0, 3)).toMatchObject({
      ok: false,
      reason: "backlog-full",
    });
    store.setTaskState("t-1", "done", later(1_000));
    expect(store.createConsoleTask({ id: "t-4", title: "x" }, later(2_000), 3)).toMatchObject({ ok: true });
  });

  test("resolveIncident owns its transaction now — no caller can half-do it", () => {
    const ref = store.refFor(BUILT_IN, "t-1").id;
    const run = store.startRun({
      taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0,
    });
    const incident = store.createIncident({ run, kind: "attempts-exhausted" }, T0);
    store.holdOwned(
      { taskRef: ref, ownerKind: "incident", ownerId: String(incident), reason: "stall", until: null },
      T0,
    );

    expect(store.resolveIncident(incident, "alex", later(1_000))).toBe(true);
    expect(store.activeHolds(ref, later(2_000))).toHaveLength(0);
  });
});

describe("the console read model, bounded by construction", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  const refOf = (id: string) => {
    store.createTask({ id, title: id }, T0);
    return store.refFor(BUILT_IN, id).id;
  };

  const runOn = (ref: number, n: number) =>
    store.startRun({
      taskRef: ref,
      leaseId: `lease-${n}`,
      runner: "builder-1",
      branch: `standing-orders/t-${n}`,
      worktree: `/pool/t-${n}`,
      now: T0,
    });

  test("runs page newest-first, the cursor strictly exclusive, the task attached", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const runs = [runOn(a, 1), runOn(b, 2), runOn(a, 3), runOn(b, 4), runOn(a, 5)];

    const first = store.listRunsBefore(null, 2);
    expect(first.map(one => one.id)).toEqual([runs[4], runs[3]]);
    expect(first[0]?.taskId).toBe("t-a");

    // The next page starts strictly below the last row seen — no repeats,
    // no skips, whatever was inserted in between.
    const next = store.listRunsBefore(first[1]!.id, 2);
    expect(next.map(one => one.id)).toEqual([runs[2], runs[1]]);

    const last = store.listRunsBefore(next[1]!.id, 2);
    expect(last.map(one => one.id)).toEqual([runs[0]]);
    expect(store.listRunsBefore(runs[0]!, 2)).toEqual([]);
  });

  test("the page size is clamped and an unsafe cursor is nothing, not everything", () => {
    const a = refOf("t-a");
    runOn(a, 1);
    runOn(a, 2);

    expect(store.listRunsBefore(null, 0)).toHaveLength(1);
    expect(store.listRunsBefore(null, -5)).toHaveLength(1);
    expect(store.listRunsBefore(null, 1e9)).toHaveLength(2);
    // 2^53 is where integers stop being exact — a cursor there could silently
    // alias another row, so it matches none.
    expect(store.listRunsBefore(2 ** 53, 10)).toEqual([]);
    expect(store.listRunsBefore(0, 10)).toEqual([]);
    expect(store.listRunsBefore(-1, 10)).toEqual([]);
  });

  test("a task's decisions and incidents are its own, newest first, resolved included", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const mine = runOn(a, 1);
    const alsoMine = runOn(a, 2);
    const foreign = runOn(b, 3);

    const option = { id: "x", label: "x", consequence: "c", reversible: true };
    const early = store.saveDecision(
      { run: mine, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );
    const late = store.saveDecision(
      { run: alsoMine, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );
    store.saveDecision(
      { run: foreign, urgency: "blocking", recap: "r", question: "q", options: [option], recommendation: "x" },
      T0,
    );

    expect(store.decisionsForTask(a).map(one => one.id)).toEqual([late, early]);

    const incident = store.createIncident({ run: mine, kind: "attempts-exhausted" }, T0);
    store.createIncident({ run: foreign, kind: "malformed-decision" }, T0);
    store.resolveIncident(incident, "alex", later(1_000));

    // Resolved incidents stay on the task's page: history, not attention.
    expect(store.incidentsForTask(a).map(one => one.id)).toEqual([incident]);
    expect(store.incidentsForTask(a)[0]?.resolvedAt).not.toBeNull();
  });

  test("an artifact is found only through its own run", () => {
    const a = refOf("t-a");
    const b = refOf("t-b");
    const mine = runOn(a, 1);
    const foreign = runOn(b, 2);

    const artifact = store.saveArtifact(
      { run: mine, kind: "diff", key: "1/diff.patch", bytesOriginal: 4, bytesStored: 4, truncated: false, sha256: "h", capture: "git diff (exit 0)" },
      T0,
    );

    expect(store.artifactForRun(mine, artifact)?.id).toBe(artifact);
    // A mismatched pair is not an error to explain — it is simply not found.
    expect(store.artifactForRun(foreign, artifact)).toBeNull();
    expect(store.artifactForRun(mine, artifact + 99)).toBeNull();
  });
});

describe("migration from a v6 database (planning, v7)", () => {
  test("widens run role, artifact kind, and incident kind in place; planner rows insert after", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");

    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v6-"));
    const file = join(dir, "orders.db");

    // The v6 shapes for exactly the tables the v7 rebuilds touch or
    // reference: run with the two-role CHECK, artifact with three kinds,
    // incident with three kinds, and their parents.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (6);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL, external_id TEXT NOT NULL, repo TEXT,
        zones TEXT NOT NULL DEFAULT '[]',
        capability_requirements TEXT NOT NULL DEFAULT '[]',
        park_rate REAL NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'theirs',
        strikes INTEGER NOT NULL DEFAULT 0,
        UNIQUE (backend, external_id)
      );
      CREATE TABLE run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, runner TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
        parent_run INTEGER REFERENCES run(id), session_id TEXT, base_revision TEXT,
        branch TEXT NOT NULL, worktree TEXT NOT NULL, model TEXT,
        outcome TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change')),
        reason TEXT, committed INTEGER, started_at TEXT NOT NULL, finished_at TEXT,
        provider_started_at TEXT, tokens_in INTEGER, tokens_out INTEGER,
        cost_usd REAL, usage_json TEXT, head_revision TEXT, handoff TEXT
      );
      CREATE TABLE artifact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload')),
        key TEXT NOT NULL, bytes_original INTEGER NOT NULL, bytes_stored INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL, capture TEXT NOT NULL,
        created_at TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE incident (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure')),
        created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
      );
      INSERT INTO task VALUES ('t-1','w','queued','2026-08-12T00:00:00.000Z','2026-08-12T00:00:00.000Z');
      INSERT INTO task_ref (backend, external_id, origin, strikes) VALUES ('built-in','t-1','ours',2);
      INSERT INTO run (task_ref, lease_id, runner, role, branch, worktree, outcome, started_at, cost_usd)
        VALUES (1,'l-1','b','repair','br','/w','failed','2026-08-12T01:00:00.000Z',0.42);
      INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at)
        VALUES (1,'diff','1/diff.patch',10,10,'abc','git diff (exit 0)','2026-08-12T01:05:00.000Z');
      INSERT INTO incident (run, kind, created_at)
        VALUES (1,'attempts-exhausted','2026-08-12T01:10:00.000Z');
    `);
    old.close();

    const store = openStore(file);
    try {
      // Every v6 row survived the three rebuilds, ids and values intact.
      const run = store.handle.prepare("SELECT * FROM run WHERE id = 1").get();
      expect(run).toMatchObject({ role: "repair", outcome: "failed", cost_usd: 0.42 });
      const artifact = store.handle.prepare("SELECT * FROM artifact WHERE id = 1").get();
      expect(artifact).toMatchObject({ kind: "diff", key: "1/diff.patch" });
      const incident = store.handle.prepare("SELECT * FROM incident WHERE id = 1").get();
      expect(incident).toMatchObject({ kind: "attempts-exhausted" });

      // The widened CHECKs admit the planning rows v6 refused.
      const planner = store.startRun({
        taskRef: 1, leaseId: "l-2", runner: "b", role: "planner",
        branch: "standing-orders-plan/t-1", worktree: "/w2", now: new Date("2026-08-12T02:00:00.000Z"),
      });
      expect(planner).toBeGreaterThan(1);
      store.handle
        .prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(planner, "plan", `${planner}/plan.md`, 5, 5, "def", "plan handoff", "2026-08-12T02:05:00.000Z");
      store.handle
        .prepare("INSERT INTO incident (run, kind, created_at) VALUES (?,?,?)")
        .run(planner, "malformed-plan", "2026-08-12T02:10:00.000Z");

      // The additive planning columns exist and default honestly.
      const ref = store.handle.prepare("SELECT plan, plan_strikes FROM task_ref WHERE id = 1").get();
      expect(ref).toMatchObject({ plan: null, plan_strikes: 0 });

      // v8 rode the same open: the routine tables exist, the instance link
      // is present and honestly NULL, and a standing order can be filed on
      // the migrated database.
      const ref8 = store.handle.prepare("SELECT routine_id FROM task_ref WHERE id = 1").get();
      expect(ref8).toMatchObject({ routine_id: null });
      const created = store.createRoutine(
        {
          name: "deps", repo: "/work/repo", goal: "refresh", outOfScope: null,
          touches: [], requirements: [], schedule: "every:60",
          singleFlight: true, costCeilingUsd: null, digest: "d".repeat(32),
        },
        new Date("2026-08-12T03:00:00.000Z"),
      );
      expect(created.ok).toBe(true);
      expect(store.routineByName("deps")?.paused).toBe(false);

      // v9 rode the same open: history reads provider 'claude' truthfully
      // (nothing else ever spawned), a new run records its own, the agent
      // pin columns exist and default honestly NULL, and phase_config is
      // writable on the migrated database.
      expect(store.getRun(1)?.provider).toBe("claude");
      const codexRun = store.startRun({
        taskRef: 1, leaseId: "l-9", runner: "b", branch: "br", worktree: "/w9",
        provider: "codex", now: new Date("2026-08-12T04:00:00.000Z"),
      });
      expect(store.getRun(codexRun)?.provider).toBe("codex");
      const pin = store.handle.prepare("SELECT agent_provider, agent_model FROM task_ref WHERE id = 1").get();
      expect(pin).toMatchObject({ agent_provider: null, agent_model: null });
      store.setPhaseConfig("installation", "plan", "claude", "opus", "alex", new Date("2026-08-12T04:01:00.000Z"));
      expect(store.phaseConfig("installation", "plan")).toMatchObject({ provider: "claude", model: "opus", updatedBy: "alex" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the same-day upgrade shape (audit TG-8)", () => {
  test("a v11 database whose diff_comment predates source_key opens, gains the column, and gets its index", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "standing-orders-sameday-"));
    const file = join(dir, "orders.db");
    try {
      // The exact e2a08c5 regression shape: diff_comment exists WITHOUT
      // source_key, so the fresh schema's CREATE TABLE IF NOT EXISTS skips
      // it — and a partial index inside the schema block would die before
      // addColumn could run. The index lives in the post-migration block
      // precisely so this file opens.
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (11);
        CREATE TABLE diff_comment (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          artifact      INTEGER NOT NULL,
          artifact_sha  TEXT NOT NULL,
          run           INTEGER NOT NULL,
          path          TEXT,
          line          INTEGER,
          note          TEXT NOT NULL,
          author        TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          superseded_by INTEGER,
          consumed_by   TEXT
        );
      `);
      old.close();

      const store = openStore(file);
      try {
        const columns = store.handle
          .prepare("PRAGMA table_info(diff_comment)")
          .all()
          .map((row: Record<string, unknown>) => String(row["name"]));
        expect(columns).toContain("source_key");
        const index = store.handle
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'diff_comment_source'")
          .get();
        expect(index).toBeDefined();
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a v17 database whose task table predates priority opens, gains the column, and old rows read as filing order", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "standing-orders-v18-"));
    const file = join(dir, "orders.db");
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (17);
        CREATE TABLE task (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO task VALUES ('old-row', 'work filed before v18', 'queued', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      `);
      old.close();

      const store = openStore(file);
      try {
        const columns = store.handle
          .prepare("PRAGMA table_info(task)")
          .all()
          .map((row: Record<string, unknown>) => String(row["name"]));
        expect(columns).toContain("priority");
        const task = store.getTask("old-row");
        expect(task?.priority).toBe(0);
        const moved = store.moveTaskNext("old-row", new Date("2026-08-19T00:00:00.000Z"));
        expect(moved).toMatchObject({ ok: true, priority: 1 });
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("the v24 migration (Parity II foundations, rulings 10/11)", () => {
  const T0 = new Date("2026-08-11T22:00:00.000Z");

  /** A faithful v23 simulation: rows written WITHOUT the v24 columns (the
   * ALTER defaults are the legacy classification), version wound back,
   * store reopened so migrateToV24 runs exactly once. */
  const legacyDb = (seed: (db: ReturnType<typeof openStore>) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), "so-v24-migr-"));
    const file = join(dir, "db.sqlite");
    const store = openStore(file);
    seed(store);
    store.raw().prepare("UPDATE schema_version SET version = 23").run();
    store.close();
    return file;
  };

  test("an approved scope is PINNED and grandfathered: signed bytes untouched, snapshot resolved from the config of the day", () => {
    const file = legacyDb(db => {
      db.setPhaseConfig("installation", "build", "claude", "sonnet", "old", T0);
      db.createTask({ id: "t-old", title: "approved long ago" }, T0);
      db.refFor("built-in", "t-old");
      db.raw()
        .prepare(
          `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest, approved_at, approved_by, approved_digest)
           VALUES ('t-old', 'a guard', NULL, '[]', ?, 'a24c72e6603f78291e1eea2e162b383e', ?, 'alex', 'a24c72e6603f78291e1eea2e162b383e')`,
        )
        .run(T0.toISOString(), T0.toISOString());
    });
    const store = openStore(file);
    const scope = store.getScope("t-old");
    // the golden bytes survived the migration untouched
    expect(scope?.digest).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(scope?.approvedDigest).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(scope?.digestVersion).toBe(1);
    // and the effective profile of the day is sealed beside them
    expect(scope?.approvedProfile).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(scope?.profileState).toBe("resolved");
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("an approved scope with NO resolvable model becomes unresolved — unapprovable and undispatchable, never guessed", () => {
    const file = legacyDb(db => {
      db.createTask({ id: "t-stranded", title: "no routing anywhere" }, T0);
      db.refFor("built-in", "t-stranded");
      db.raw()
        .prepare(
          `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest, approved_at, approved_by, approved_digest)
           VALUES ('t-stranded', 'work', NULL, '[]', ?, 'deadbeefdeadbeefdeadbeefdeadbeef', ?, 'alex', 'deadbeefdeadbeefdeadbeefdeadbeef')`,
        )
        .run(T0.toISOString(), T0.toISOString());
    });
    const store = openStore(file);
    const scope = store.getScope("t-stranded");
    expect(scope?.profileState).toBe("unresolved");
    expect(scope?.approvedProfile ?? null).toBeNull();
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("undelivered legacy steering is QUARANTINED: labeled, superseded, and never attachable to a brief", () => {
    const file = legacyDb(db => {
      db.createTask({ id: "t-note", title: "steered once" }, T0);
      const ref = db.refFor("built-in", "t-note").id;
      db.raw()
        .prepare("INSERT INTO task_steer (task_ref, author, note, created_at) VALUES (?, 'mystery-cli', 'do it my way', ?)")
        .run(ref, T0.toISOString());
    });
    const store = openStore(file);
    const ref = store.refFor("built-in", "t-note").id;
    const notes = store.listSteerNotes(ref);
    expect(notes[0]).toMatchObject({ authorshipState: "unverified-legacy", supersededReason: "unverified-author" });
    expect(notes[0]?.supersededAt).not.toBeNull();
    const run = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0 });
    expect(store.attachSteerNotes(ref, run, T0)).toEqual([]);
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("an approved routine that cannot resolve is PARKED — approval demoted, said in provenance", () => {
    const file = legacyDb(db => {
      db.raw()
        .prepare(
          `INSERT INTO routine (name, repo, goal, touches, requirements, schedule, digest, approved_at, approved_by, approved_digest, next_fire_at, created_at, updated_at)
           VALUES ('nightly', '/repo/x', 'check things', '[]', '[]', 'every:60', 'cafecafecafecafecafecafecafecafe', ?, 'alex', 'cafecafecafecafecafecafecafecafe', ?, ?, ?)`,
        )
        .run(T0.toISOString(), T0.toISOString(), T0.toISOString(), T0.toISOString());
    });
    const store = openStore(file);
    const routine = store.listRoutines(null).find(one => one.name === "nightly");
    expect(routine?.approvedAt).toBeNull();
    expect(routine?.approvedDigest).toBeNull();
    expect(routine?.nextFireAt).toBeNull();
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  test("legacy contestants get snapshots under race semantics 1; the stored fingerprint bytes survive", () => {
    const file = legacyDb(db => {
      db.createTask({ id: "t-race", title: "raced" }, T0);
      const ref = db.refFor("built-in", "t-race").id;
      db.raw()
        .prepare(
          `INSERT INTO tournament_terms (task_ref, generation, race_digest, agents, n, per_agent_budget_microusd, overrun_reserve_microusd, total_budget_microusd, price_version, retries, publication_policy, created_at)
           VALUES (?, 1, 'feedfacefeedface', '[]', 2, 1000, 100, 5000, 1, 0, 'none', ?)`,
        )
        .run(ref, T0.toISOString());
      const terms = Number(db.raw().prepare("SELECT id FROM tournament_terms").get()!["id"]);
      db.raw()
        .prepare(
          `INSERT INTO contest (task_ref, terms, state, scope_digest, race_digest, created_at)
           VALUES (?, ?, 'pick-wait', 'aaaa', 'feedfacefeedface', ?)`,
        )
        .run(ref, terms, T0.toISOString());
      const contest = Number(db.raw().prepare("SELECT id FROM contest").get()!["id"]);
      db.raw()
        .prepare(
          `INSERT INTO contestant (contest, ordinal, provider, model, repair_model, branch, budget_microusd, reserve_microusd)
           VALUES (?, 1, 'claude', 'claude-sonnet-5', 'inherit', 'race/a', 1000, 100)`,
        )
        .run(contest);
    });
    const store = openStore(file);
    const contestRow = store.raw().prepare("SELECT race_semantics, race_digest FROM contest").get()!;
    expect(Number(contestRow["race_semantics"])).toBe(1);
    expect(String(contestRow["race_digest"])).toBe("feedfacefeedface");
    const contestant = store.raw().prepare("SELECT profile_json FROM contestant").get()!;
    expect(String(contestant["profile_json"])).toContain("claude-sonnet-5");
    store.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});
