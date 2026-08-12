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

    expect(store.setTaskState("t-1", "running", later(1_000))).toBe(true);
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(store.getTask("t-1")?.updatedAt).toBe(later(1_000).toISOString());
  });

  test("says so when there was nothing to move", () => {
    expect(store.setTaskState("ghost", "done", T0)).toBe(false);
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

      expect(first).toBe(false);
      expect(afterwards).toBe(true);
      expect(store.getTask("ghost")?.state).toBe("done");
    });

    test("still replays a mutation that did happen", () => {
      store.createTask({ id: "t-1", title: "first" }, T0, { idempotencyKey: "k-3", at: T0 });
      store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      // The retry must not re-run against a task that has moved on since.
      store.setTaskState("t-1", "running", later(1_000));
      const replayed = store.setTaskState("t-1", "done", T0, { idempotencyKey: "k-4", at: T0 });

      expect(replayed).toBe(true);
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

    const dir = await mkdtemp(join(tmpdir(), "nightorders-store-"));
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

    const dir = await mkdtemp(join(tmpdir(), "nightorders-migrate-"));
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

  test("a task nightorders created is recorded as ours", () => {
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
      branch: "nightorders/t-1",
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
      branch: "nightorders/t-2",
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
      branch: "nightorders/t-1",
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

    const dir = mkdtempSync(join(tmpdir(), "nightorders-m2-"));
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
        VALUES (1,'lease-1','builder-1','nightorders/t-1','/pool/t-1','built',1,'2026-08-11T01:00:00.000Z','2026-08-11T01:10:00.000Z');
      INSERT INTO run (task_ref, lease_id, runner, branch, worktree, started_at)
        VALUES (1,'lease-2','builder-1','nightorders/t-1','/pool/t-1','2026-08-11T02:00:00.000Z');
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
      branch: "nightorders/t-1",
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
