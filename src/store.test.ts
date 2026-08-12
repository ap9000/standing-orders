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
