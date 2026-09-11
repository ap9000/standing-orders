import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  register,
  authenticate,
  heartbeat,
  isAlive,
  deadRunners,
  recoverDead,
  recoveredAnything,
  hashToken,
  addRunnerReposAuthed,
  observeProviderReadiness,
  reportProviderReadinessAuthed,
  DEFAULT_LIVENESS_MS,
  type ReadinessProbe,
} from "./runner.js";
import { acquire, completeFenced, currentClaim, release } from "./claim.js";

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

  test("re-registering in the same clock millisecond advances the incarnation fence", () => {
    const first = register(store, { name: "builder-1", host: "laptop", now: T0 });
    const second = register(store, { name: "builder-1", host: "laptop", now: T0 });

    expect(Date.parse(second.runner.registeredAt)).toBe(Date.parse(first.runner.registeredAt) + 1);
    expect(store.getRunner("builder-1")?.runner.registeredAt).toBe(second.runner.registeredAt);
  });

  test("stale concurrent registration candidates serialize to distinct incarnations", () => {
    const first = register(store, {
      name: "builder-1",
      host: "laptop",
      now: T0,
      newToken: () => "first-token",
    });
    // Model two registrars that both took their wall-clock snapshot before
    // either replacement committed. saveRunner must derive from the live row
    // while holding the write lock, not trust either stale candidate.
    const stale = { ...first.runner, registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString() };
    const second = store.saveRunner(stale, hashToken("second-token"));
    const third = store.saveRunner(stale, hashToken("third-token"));

    expect(Date.parse(second.registeredAt)).toBe(Date.parse(first.runner.registeredAt) + 1);
    expect(Date.parse(third.registeredAt)).toBe(Date.parse(second.registeredAt) + 1);
    expect(store.getRunner("builder-1")?.runner.registeredAt).toBe(third.registeredAt);
    expect(authenticate(store, "builder-1", "third-token").ok).toBe(true);
    expect(authenticate(store, "builder-1", "second-token").ok).toBe(false);
  });

  test("brings a retired runner back when it registers again", () => {
    const { token } = register(store, { name: "builder-1", host: "laptop", now: T0 });
    store.retireRunner("builder-1", later(1_000));

    const fresh = register(store, { name: "builder-1", host: "laptop", now: later(2_000) });

    expect(authenticate(store, "builder-1", fresh.token).ok).toBe(true);
    expect(authenticate(store, "builder-1", token).ok).toBe(false);
  });

  test("a live runner can add a project only with its current credential", () => {
    const { token } = register(store, { name: "builder-1", host: "laptop", repos: ["/repo/a"], now: T0 });

    expect(addRunnerReposAuthed(store, { name: "builder-1", token: "wrong", repos: ["/repo/b"] }, later(1_000))).toEqual({ ok: false, reason: "bad-token" });
    const added = addRunnerReposAuthed(store, { name: "builder-1", token, repos: ["/repo/b"] }, later(2_000));

    expect(added.ok && added.runner.repos).toEqual(["/repo/a", "/repo/b"]);
    expect(store.getRunner("builder-1")?.runner.repos).toEqual(["/repo/a", "/repo/b"]);
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

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review" = "build") => ({
  route: { routeDigest: "legacy", phase, provider: "claude", model: null, chosen: "legacy" as const },
});

describe("closing abandoned run records during reconciliation (P0.1a)", () => {
  // The real shape this guards: run 1501 opened under lease gen 1, the
  // lease was released without the run being finished, a successor took
  // gen 2, ran 1502 and built — and 1501 stayed open forever, because the
  // reconcile pass only ever released claims and worktrees. Every test here
  // drives the PUBLIC reconcile road (`recoverDead`, what `tick` and
  // `runner reap` call) against an in-memory store — never the user's
  // database.
  let store: Store;
  let task: number;
  const DEAD = later(DEFAULT_LIVENESS_MS + 60_000);

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    task = store.refFor("built-in", "t-1").id;
    store.placeTask(task, REPO);
  });

  afterEach(() => store.close());

  /** Runner `old` opens a run under lease `lease-old`, then hands the lease
   * back WITHOUT finishing the run — the abandoned record. */
  const abandonRun = (old: string, token: string): number => {
    acquire(store, task, old, { token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-old" });
    store.setTaskState("t-1", "running", T0);
    const runId = store.startRun({
      taskRef: task, leaseId: "lease-old", runner: old, branch: "b", worktree: "/pool/old", ...bareLegacy(), now: T0,
    });
    store.saveWorktree({
      path: "/pool/old", repo: REPO, branch: "b", runner: old, taskRef: task,
      createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true,
    });
    expect(release(store, "lease-old", later(5_000))).toMatchObject({ ok: true });
    return runId;
  };

  test("finishes the released old claim's open run after a successor built the task, touching nothing else", () => {
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    const oldRun = abandonRun("old", old.token);
    // The successor: gen 2 on another runner, run to completion.
    const next = register(store, { name: "next", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "next", { token: next.token, now: later(10_000), ttlMs: 60 * 60_000, newLeaseId: () => "lease-next" });
    store.setTaskState("t-1", "running", later(10_000));
    const nextRun = store.startRun({
      taskRef: task, leaseId: "lease-next", runner: "next", branch: "b", worktree: "/pool/next", ...bareLegacy(), now: later(10_000),
    });
    store.finishRun(nextRun, { outcome: "built", committed: true, now: later(20_000) });
    expect(completeFenced(store, "lease-next", "done", later(20_000))).toMatchObject({ ok: true });
    heartbeat(store, "next", next.token, DEAD);
    const before = store.getRun(nextRun);

    // The old runner's lease is long gone, so there is NO claim to release —
    // exactly the case the reconcile pass used to walk past in silence.
    const recovered = recoverDead(store, DEAD);

    expect(recovered).toEqual([{ runner: "old", claims: [], worktrees: ["/pool/old"], runs: [oldRun], requeued: [] }]);
    expect(store.getRun(oldRun)).toMatchObject({ outcome: "failed", reason: "interrupted", finishedAt: DEAD.toISOString() });
    // The successor's finished outcome and the task's terminal state stand.
    expect(store.getRun(nextRun)).toEqual(before);
    expect(store.getTask("t-1")?.state).toBe("done");
    expect(store.getWorktree("/pool/old")?.verified).toBe(false);
  });

  test("reports the run through `runner reap` even when no claim was released", () => {
    // `runner reap` hides passes that took nothing back; an open run alone
    // is something taken back.
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    const oldRun = abandonRun("old", old.token);
    store.releaseWorktreesOf("old", later(6_000));

    const recovered = recoverDead(store, DEAD).filter(recoveredAnything);

    expect(recovered).toEqual([{ runner: "old", claims: [], worktrees: [], runs: [oldRun], requeued: ["t-1"] }]);
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("counts tasks requeued while releasing claims, even when the run walk finds them already queued", () => {
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    expect(acquire(store, task, "old", { token: old.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-old" })).toMatchObject({ ok: true });
    store.setTaskState("t-1", "running", T0);
    const oldRun = store.startRun({ taskRef: task, leaseId: "lease-old", runner: "old", branch: "b", worktree: "/pool/old", ...bareLegacy(), now: T0 });

    expect(recoverDead(store, DEAD)).toEqual([{ runner: "old", claims: ["lease-old"], worktrees: [], runs: [oldRun], requeued: ["t-1"] }]);
    expect(recoverDead(store, DEAD).filter(recoveredAnything)).toEqual([]);
  });

  test("leaves an active successor's claim, run, worktree, and task state alone", () => {
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    const oldRun = abandonRun("old", old.token);
    const next = register(store, { name: "next", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "next", { token: next.token, now: later(10_000), ttlMs: 60 * 60_000, newLeaseId: () => "lease-next" });
    store.setTaskState("t-1", "running", later(10_000));
    const nextRun = store.startRun({
      taskRef: task, leaseId: "lease-next", runner: "next", branch: "b", worktree: "/pool/next", ...bareLegacy(), now: later(10_000),
    });
    store.saveWorktree({
      path: "/pool/next", repo: REPO, branch: "b", runner: "next", taskRef: task,
      createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true,
    });
    heartbeat(store, "next", next.token, DEAD);

    const recovered = recoverDead(store, DEAD);

    expect(recovered).toEqual([{ runner: "old", claims: [], worktrees: ["/pool/old"], runs: [oldRun], requeued: [] }]);
    expect(store.getRun(oldRun)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getRun(nextRun)?.outcome).toBeNull();
    expect(currentClaim(store, task, DEAD)?.leaseId).toBe("lease-next");
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(store.getWorktree("/pool/next")).toMatchObject({ releasedAt: null, verified: true });
  });

  test("an expired, never-released old claim cannot requeue a task its successor is running", () => {
    // The lease ran out (nobody released it) and a successor took gen 2. The
    // dead runner's row is still `released_at IS NULL`, so the reconcile
    // pass releases it — but the task belongs to the live holder now.
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    acquire(store, task, "old", { token: old.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-old" });
    store.setTaskState("t-1", "running", T0);
    const oldRun = store.startRun({
      taskRef: task, leaseId: "lease-old", runner: "old", branch: "b", worktree: "/pool/old", ...bareLegacy(), now: T0,
    });
    const next = register(store, { name: "next", host: "h", repos: [REPO], now: T0 });
    expect(acquire(store, task, "next", { token: next.token, now: later(120_000), ttlMs: 60 * 60_000, newLeaseId: () => "lease-next" })).toMatchObject({ ok: true });
    store.setTaskState("t-1", "running", later(120_000));
    heartbeat(store, "next", next.token, DEAD);

    const recovered = recoverDead(store, DEAD);

    expect(recovered).toEqual([{ runner: "old", claims: ["lease-old"], worktrees: [], runs: [oldRun], requeued: [] }]);
    expect(store.getTask("t-1")?.state).toBe("running");
    expect(currentClaim(store, task, DEAD)?.leaseId).toBe("lease-next");
  });

  test("a heartbeat landing between the survey and the transaction saves the run", () => {
    // The survey (`deadRunners`) sees `old` silent; its pulse lands before
    // the transaction re-reads it. Simulated by making the in-transaction
    // re-read stamp the heartbeat first — the exact interleaving the
    // re-proof exists for.
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    const oldRun = abandonRun("old", old.token);
    const realGetRunner = store.getRunner.bind(store);
    let raced = false;
    store.getRunner = (name: string) => {
      if (name === "old" && !raced) {
        raced = true;
        store.touchRunner("old", DEAD);
      }
      return realGetRunner(name);
    };

    const recovered = recoverDead(store, DEAD);

    expect(raced).toBe(true);
    expect(recovered).toEqual([]);
    expect(store.getRun(oldRun)?.outcome).toBeNull();
    expect(store.getTask("t-1")?.state).toBe("running");
  });

  test("a second pass settles nothing and says so", () => {
    const old = register(store, { name: "old", host: "h", repos: [REPO], now: T0 });
    const oldRun = abandonRun("old", old.token);
    const first = recoverDead(store, DEAD);
    expect(first).toEqual([{ runner: "old", claims: [], worktrees: ["/pool/old"], runs: [oldRun], requeued: ["t-1"] }]);
    const settled = store.getRun(oldRun);
    const wake = store.wakeSeq();

    const again = recoverDead(store, later(DEFAULT_LIVENESS_MS + 120_000));

    expect(again).toEqual([{ runner: "old", claims: [], worktrees: [], runs: [], requeued: [] }]);
    expect(again.filter(recoveredAnything)).toEqual([]);
    expect(store.getRun(oldRun)).toEqual(settled);
    expect(store.wakeSeq()).toBe(wake);
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

describe("provider readiness observations (v47)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  /** A fake machine: claude installed, codex installed but logged out,
   * openrouter installed with no key, gemini missing entirely. */
  const machine: ReadinessProbe = async (file, args) => {
    if (file === "gemini") return { ...OK, code: 127, notFound: true };
    if (args[0] === "--version") return { ...OK, stdout: `${file} 9.9.9\n` };
    if (file === "codex" && args[0] === "login") return { ...OK, code: 1, stderr: "Not logged in" };
    return OK;
  };

  test("each provider's state is the probe's own answer, and claude is UNKNOWN — never upgraded to ready", async () => {
    const observed = await observeProviderReadiness(machine, { OPENROUTER_API_KEY: "" });
    const byProvider = Object.fromEntries(observed.map(one => [one.provider, one]));
    expect(byProvider["claude"]).toMatchObject({ state: "unknown", probe: "version" });
    expect(byProvider["claude"]?.reason).toContain("no non-spending login check exists");
    expect(byProvider["codex"]).toMatchObject({ state: "unavailable", probe: "identity" });
    expect(byProvider["codex"]?.reason).toContain("not logged in");
    expect(byProvider["openrouter"]).toMatchObject({ state: "unavailable", probe: "key" });
    expect(byProvider["openrouter"]?.reason).toContain("OPENROUTER_API_KEY is absent");
    expect(byProvider["gemini"]).toMatchObject({ state: "unavailable", probe: "version" });
    expect(byProvider["gemini"]?.reason).toContain("not installed");
    // With the key present, openrouter is ready on presence alone — it
    // rides the codex harness on the key, not on a harness login.
    const keyed = await observeProviderReadiness(machine, { OPENROUTER_API_KEY: "sk-or-test" });
    expect(keyed.find(one => one.provider === "openrouter")).toMatchObject({ state: "ready", probe: "key" });
  });

  test("an attested provider outside its range is unavailable, and one inside it is not", async () => {
    const versioned = (version: string): ReadinessProbe => async (file, args) =>
      args[0] === "--version" ? { ...OK, stdout: file === "gemini" ? `${version}\n` : "1.0.0\n" } : OK;
    const old = await observeProviderReadiness(versioned("0.40.0"), {}, ["gemini"]);
    expect(old[0]).toMatchObject({ state: "unavailable" });
    expect(old[0]?.reason).toContain("outside this build's attested range");
    const current = await observeProviderReadiness(versioned("0.57.0"), {}, ["gemini"]);
    expect(current[0]?.state).not.toBe("unavailable");
  });

  test("only the runner's own credential records under its name; the store keeps the newest observation per provider", async () => {
    register(store, { name: "mac-mini", host: "h", repos: [REPO], now: T0, newToken: () => "tok-mini" });
    const observed = await observeProviderReadiness(machine, {});
    expect(reportProviderReadinessAuthed(store, { name: "mac-mini", token: "wrong", observations: observed }, T0)).toMatchObject({ ok: false, reason: "bad-token" });
    expect(store.providerReadiness("mac-mini")).toHaveLength(0);
    expect(reportProviderReadinessAuthed(store, { name: "ghost", token: "tok-mini", observations: observed }, T0)).toMatchObject({ ok: false, reason: "unknown" });
    expect(reportProviderReadinessAuthed(store, { name: "mac-mini", token: "tok-mini", observations: observed }, T0)).toMatchObject({ ok: true });
    expect(store.providerReadiness("mac-mini")).toHaveLength(4);
    expect(store.runnerReadinessOf("mac-mini", "codex")).toMatchObject({ state: "unavailable", observedAt: T0.toISOString(), runner: "mac-mini" });
    // A later, different answer replaces it — with its own time.
    expect(reportProviderReadinessAuthed(store, { name: "mac-mini", token: "tok-mini", observations: [{ provider: "codex", state: "ready", reason: "logged in as ops", probe: "identity" }] }, later(60_000)).ok).toBe(true);
    expect(store.runnerReadinessOf("mac-mini", "codex")).toMatchObject({ state: "ready", observedAt: later(60_000).toISOString() });
    // A retired-and-replaced incarnation cannot report with the old token.
    register(store, { name: "mac-mini", host: "h", repos: [REPO], now: later(120_000), newToken: () => "tok-mini-2" });
    expect(reportProviderReadinessAuthed(store, { name: "mac-mini", token: "tok-mini", observations: observed }, later(130_000)).ok).toBe(false);
  });
});
