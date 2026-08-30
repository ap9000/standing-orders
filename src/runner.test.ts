import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  register,
  authenticate,
  heartbeat,
  isAlive,
  deadRunners,
  recoverDead,
  hashToken,
  DEFAULT_LIVENESS_MS,
} from "./runner.js";
import { acquire, currentClaim } from "./claim.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

/** The runner gate (MCP spec v6): every acquisition authenticates the runner
 * and proves the task's placed repo is in its registered `repos` — so tests
 * that acquire register against REPO and place their tasks there. */
const REPO = "/repo/runners";

describe("registering a runner", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("mints a token and keeps only its hash", () => {
    // A control plane that can hand back a runner's credential is one whose
    // database is worth stealing.
    const { token } = register(store, { name: "builder-1", host: "laptop", now: T0 });

    const stored = store.getRunner("builder-1");
    expect(stored?.credentialHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test("mints a different token every time", () => {
    const first = register(store, { name: "a", host: "h", now: T0 }).token;
    const second = register(store, { name: "b", host: "h", now: T0 }).token;

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(20);
  });

  test("accepts the right token and refuses a wrong one", () => {
    const { token } = register(store, { name: "builder-1", host: "laptop", now: T0 });

    expect(authenticate(store, "builder-1", token).ok).toBe(true);
    expect(authenticate(store, "builder-1", "not-it")).toEqual({ ok: false, reason: "bad-token" });
  });

  test("tells an unknown runner apart from a wrong token", () => {
    // Different situations, different fixes: one registers, one re-mints.
    register(store, { name: "builder-1", host: "laptop", now: T0 });

    expect(authenticate(store, "ghost", "x")).toEqual({ ok: false, reason: "unknown" });
  });

  test("refuses a retired runner even with its token", () => {
    const { token } = register(store, { name: "builder-1", host: "laptop", now: T0 });
    store.retireRunner("builder-1", later(1_000));

    expect(authenticate(store, "builder-1", token)).toEqual({ ok: false, reason: "retired" });
  });

  test("re-registering replaces the credential rather than keeping both", () => {
    const first = register(store, { name: "builder-1", host: "laptop", now: T0 }).token;
    const second = register(store, { name: "builder-1", host: "laptop", now: later(1_000) }).token;

    expect(authenticate(store, "builder-1", second).ok).toBe(true);
    expect(authenticate(store, "builder-1", first).ok).toBe(false);
  });

  test("brings a retired runner back when it registers again", () => {
    const { token } = register(store, { name: "builder-1", host: "laptop", now: T0 });
    store.retireRunner("builder-1", later(1_000));

    const fresh = register(store, { name: "builder-1", host: "laptop", now: later(2_000) });

    expect(authenticate(store, "builder-1", fresh.token).ok).toBe(true);
    expect(authenticate(store, "builder-1", token).ok).toBe(false);
  });
});

describe("liveness", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("a runner that checked in recently is alive", () => {
    const { runner } = register(store, { name: "builder-1", host: "h", now: T0 });

    expect(isAlive(runner, later(1_000))).toBe(true);
    expect(isAlive(runner, later(DEFAULT_LIVENESS_MS + 1))).toBe(false);
  });

  test("a heartbeat keeps it alive, and needs the token", () => {
    // Otherwise anybody could keep a dead machine looking healthy.
    const { token } = register(store, { name: "builder-1", host: "h", now: T0 });

    expect(heartbeat(store, "builder-1", "wrong", later(1_000)).ok).toBe(false);
    expect(heartbeat(store, "builder-1", token, later(DEFAULT_LIVENESS_MS - 1_000)).ok).toBe(true);

    const [runner] = store.listRunners();
    expect(isAlive(runner!, later(DEFAULT_LIVENESS_MS + 1_000))).toBe(true);
  });

  test("a retired runner is never alive", () => {
    register(store, { name: "builder-1", host: "h", now: T0 });
    store.retireRunner("builder-1", later(1_000));

    expect(deadRunners(store, later(2_000)).map(one => one.name)).toEqual(["builder-1"]);
  });

  test("names the runners that have stopped answering", () => {
    register(store, { name: "quiet", host: "h", now: T0 });
    register(store, { name: "chatty", host: "h", now: T0 });
    const { token } = register(store, { name: "chatty", host: "h", now: T0 });
    heartbeat(store, "chatty", token, later(DEFAULT_LIVENESS_MS));

    const dead = deadRunners(store, later(DEFAULT_LIVENESS_MS + 1_000)).map(one => one.name);

    expect(dead).toEqual(["quiet"]);
  });
});

describe("recovering a dead runner", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    task = store.refFor("built-in", "t-1").id;
    store.placeTask(task, REPO);
  });

  afterEach(() => store.close());

  test("takes back the claims it was holding", () => {
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });

    const recovered = recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(recovered[0]?.claims).toHaveLength(1);
    expect(currentClaim(store, task, later(DEFAULT_LIVENESS_MS + 2_000))).toBeNull();
  });

  test("frees a task whose lease had not expired yet", () => {
    // This is the point of tracking liveness separately: the lease was good
    // for another hour, but the machine holding it is gone.
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });

    expect(store.listReady(later(1_000))).toHaveLength(0);
    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));
    expect(store.listReady(later(DEFAULT_LIVENESS_MS + 2_000))).toHaveLength(1);
  });

  test("still fences the dead runner's completion if it wakes up", () => {
    // Recovery does not touch the generation, so the fence that was already
    // there keeps doing its job.
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    const first = acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });
    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    const other = register(store, { name: "builder-2", host: "h", repos: [REPO], now: later(DEFAULT_LIVENESS_MS + 2_000) });
    const second = acquire(store, task, "builder-2", { token: other.token, now: later(DEFAULT_LIVENESS_MS + 2_000) });

    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.claim.generation).toBe(first.claim.generation + 1);
    }
  });

  test("hands its worktrees back unverified", () => {
    // Nobody watched what the dead process was doing, so what is on disk
    // describes the past. Something has to look before it is reused.
    register(store, { name: "builder-1", host: "h", now: T0 });
    store.saveWorktree({
      path: "/pool/thing/feat-a",
      repo: "/code/thing",
      branch: "feat/a",
      runner: "builder-1",
      taskRef: task,
      createdAt: T0.toISOString(),
      leasedAt: T0.toISOString(),
      releasedAt: null,
      verified: true,
    });

    const recovered = recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(recovered[0]?.worktrees).toEqual(["/pool/thing/feat-a"]);
    expect(store.getWorktree("/pool/thing/feat-a")?.verified).toBe(false);
  });

  test("leaves a live runner's work alone", () => {
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });
    heartbeat(store, "builder-1", token, later(DEFAULT_LIVENESS_MS));

    const recovered = recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(recovered).toEqual([]);
    expect(currentClaim(store, task, later(DEFAULT_LIVENESS_MS + 1_000))?.runner).toBe("builder-1");
  });

  test("is quiet about a dead runner that held nothing", () => {
    register(store, { name: "idle", host: "h", now: T0 });

    const recovered = recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(recovered[0]).toMatchObject({ runner: "idle", claims: [], worktrees: [] });
  });
});

describe("the regressions these fixes were for", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    task = store.refFor("built-in", "t-1").id;
    store.placeTask(task, REPO);
  });

  afterEach(() => store.close());

  test("returns a claimed task to the queue when its runner dies", () => {
    // The stranding this prevents: claiming moves a task to `running`, the
    // ready query asks for `queued`, and a lease taken back without this
    // leaves the task held by nobody and offered to nobody, forever.
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });
    store.setTaskState("t-1", "running", T0);

    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.listReady(later(DEFAULT_LIVENESS_MS + 2_000))).toHaveLength(1);
  });

  test("does not drag a finished task back to the queue", () => {
    // Only work that was in flight comes back. A task the runner completed
    // before dying is done, and requeuing it would repeat it.
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });
    store.setTaskState("t-1", "done", T0);

    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(store.getTask("t-1")?.state).toBe("done");
  });

  test("takes back what the previous holder of a name was still holding", () => {
    // Re-registering resets the heartbeat, so without this the old identity
    // looks alive again and the reaper walks straight past its abandoned
    // work — stranded for good, with nothing anywhere reporting it.
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });
    store.setTaskState("t-1", "running", T0);

    const again = register(store, { name: "builder-1", host: "h", now: later(1_000) });

    expect(again.reclaimed?.claims).toHaveLength(1);
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("says nothing about reclaiming when there was nothing to reclaim", () => {
    register(store, { name: "builder-1", host: "h", now: T0 });

    expect(register(store, { name: "builder-1", host: "h", now: later(1_000) }).reclaimed).toBeNull();
  });
});

describe("recovery stays inside its own backend", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("does not requeue a built-in task because an external id matched", () => {
    // Claims are backend-agnostic and ids are only unique within a backend.
    // Requeuing by id alone lets a dead runner's GitHub issue #17 reset a
    // built-in task called `17` — somebody else's work, moved by a
    // coincidence of naming.
    store.createTask({ id: "17", title: "ours, and running" }, T0);
    store.setTaskState("17", "running", T0);

    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    const theirs = store.refFor("github-issues", "17");
    store.placeTask(theirs.id, REPO);
    acquire(store, theirs.id, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });

    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    // The lease is released, but our unrelated task is untouched.
    expect(store.getTask("17")?.state).toBe("running");
  });

  test("still requeues the built-in task when that is what was held", () => {
    store.createTask({ id: "17", title: "ours" }, T0);
    store.setTaskState("17", "running", T0);
    const { token } = register(store, { name: "builder-1", host: "h", repos: [REPO], now: T0 });
    const ours = store.refFor("built-in", "17").id;
    store.placeTask(ours, REPO);
    acquire(store, ours, "builder-1", { token, now: T0, ttlMs: 60 * 60_000 });

    recoverDead(store, later(DEFAULT_LIVENESS_MS + 1_000));

    expect(store.getTask("17")?.state).toBe("queued");
  });
});
