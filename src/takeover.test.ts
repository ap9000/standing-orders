/**
 * Arc 2's credentialed doors: takeover, authenticated leases and
 * heartbeats, fenced retirement, and the first-approver bootstrap. Every
 * test here is one of the review's interleavings, replayed deliberately.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  acquireWatchLeaseAuthed,
  DEFAULT_LIVENESS_MS,
  heartbeat,
  heartbeatWatchLeaseAuthed,
  normalizeRunnerName,
  register,
  registerRunnerIfIdle,
  retireRunnerIfCurrent,
  RUNNER_NAME_MAX,
  validRunnerName,
} from "./runner.js";
import { acquire } from "./claim.js";
import { authenticateApprover, hashToken } from "./scope.js";

const T0 = new Date("2026-08-24T05:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const DEAD = later(DEFAULT_LIVENESS_MS + 60_000);

/** The runner gate (MCP spec v6): acquisitions authenticate the runner and
 * bind to the task's placed repo, so acquiring tests register against REPO
 * and place their tasks there. */
const REPO = "/repo/takeover";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});

describe("registerRunnerIfIdle — the atomic take-or-refuse door", () => {
  test("refuses a runner whose heartbeat is fresh", () => {
    register(store, { name: "w-1", host: "here", now: T0 });
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(1_000) });
    expect(taken).toMatchObject({ ok: false, reason: "runner-alive" });
  });

  test("refuses while any watch lease is unexpired, even on a dead runner", () => {
    register(store, { name: "w-1", host: "here", now: T0 });
    store.acquireWatchLease("w-1", "/repo", "inc-a", 90_000, T0);
    // Heartbeat aged past liveness, lease TTL not yet expired at this instant.
    const during = new Date(T0.getTime() + 89_000);
    const runner = store.getRunner("w-1");
    expect(runner?.runner).toBeTruthy();
    // Force the heartbeat to look dead while the lease lives: use a long lease.
    store.acquireWatchLease("w-1", "/repo", "inc-a", DEFAULT_LIVENESS_MS + 120_000, during);
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: false, reason: "watch-live" });
  });

  test("takes over a dead runner: open runs finish, the task requeues, the token rotates", () => {
    const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-1", title: "left behind" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    store.placeTask(ref, REPO);
    acquire(store, ref, "w-1", { token: first.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-a", incarnation: "inc-a" });
    store.setTaskState("t-1", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-a", runner: "w-1", branch: "b", worktree: "/w", now: T0,
    });

    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: true });
    if (!taken.ok) return;
    expect(taken.recoveredRuns).toBeGreaterThan(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-1")).toMatchObject({ state: "queued" });
    // The old credential is dead the moment the takeover commits.
    expect(heartbeat(store, "w-1", first.token, DEAD)).toMatchObject({ ok: false, reason: "bad-token" });
    expect(heartbeat(store, "w-1", taken.token, DEAD)).toMatchObject({ ok: true });
  });

  test("a reap-released claim's open run still recovers and requeues (finding 31)", () => {
    const reg = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-r", title: "reaped mid-build" }, T0);
    const ref = store.refFor("built-in", "t-r").id;
    store.placeTask(ref, REPO);
    acquire(store, ref, "w-1", { token: reg.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-r", incarnation: "inc-r" });
    store.setTaskState("t-r", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-r", runner: "w-1", branch: "b", worktree: "/w", now: T0,
    });
    // The reaper releases the claim WITHOUT finishing the run — the exact
    // evidence-destroying step the takeover must survive.
    store.releaseClaimsOf("w-1", later(120_000));

    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: true });
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-r")).toMatchObject({ state: "queued" });
  });

  test("a retired runner is idle by definition — restart reuses the name instantly", () => {
    const first = register(store, { name: "w-1", host: "here", now: T0 });
    const retired = retireRunnerIfCurrent(store, "w-1", first.token, later(1_000));
    expect(retired).toMatchObject({ ok: true });
    const again = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(2_000) });
    expect(again).toMatchObject({ ok: true });
  });
});

describe("authenticated heartbeats and leases", () => {
  test("the lease door refuses a stale credential after rotation", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", repos: ["/repo"], now: DEAD });
    if (!taken.ok) throw new Error("takeover failed in setup");
    const stale = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-old", ttlMs: 90_000 },
      later(DEFAULT_LIVENESS_MS + 61_000),
    );
    expect(stale).toMatchObject({ ok: false, reason: "bad-token" });
    const fresh = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: taken.token, repo: "/repo", owner: "inc-new", ttlMs: 90_000 },
      later(DEFAULT_LIVENESS_MS + 61_000),
    );
    expect(fresh).toMatchObject({ ok: true });
  });

  test("taking over an EXPIRED lease recovers the superseded incarnation in the same call", () => {
    const reg = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-s", title: "superseded work" }, T0);
    const ref = store.refFor("built-in", "t-s").id;
    store.placeTask(ref, REPO);
    acquire(store, ref, "w-1", { token: reg.token, now: T0, ttlMs: 30 * 60_000, newLeaseId: () => "lease-s", incarnation: "inc-a" });
    store.setTaskState("t-s", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-s", runner: "w-1", branch: "b", worktree: "/w", now: T0,
    });
    store.acquireWatchLease("w-1", REPO, "inc-a", 90_000, T0);

    // inc-a's lease expires; inc-b (same runner, still-valid token) takes over.
    const afterExpiry = later(5 * 60_000);
    const took = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: reg.token, repo: REPO, owner: "inc-b", ttlMs: 90_000 },
      afterExpiry,
    );
    expect(took).toMatchObject({ ok: true, superseded: "inc-a" });
    if (took.ok) expect(took.recovered).toBeGreaterThan(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-s")).toMatchObject({ state: "queued" });
  });

  test("renewal answers false the moment the credential rotates — the caller must stop", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    acquireWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, T0);
    expect(
      heartbeatWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, later(30_000)),
    ).toBe(true);
    // The lease must expire before a takeover may rotate.
    const gone = later(DEFAULT_LIVENESS_MS + 120_000);
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: gone });
    expect(taken).toMatchObject({ ok: true });
    expect(
      heartbeatWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, later(DEFAULT_LIVENESS_MS + 121_000)),
    ).toBe(false);
  });
});

describe("fenced retirement (finding 28)", () => {
  test("a predecessor cannot retire its successor", () => {
    const first = register(store, { name: "w-1", host: "here", now: T0 });
    const successor = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    if (!successor.ok) throw new Error("takeover failed in setup");
    const attempt = retireRunnerIfCurrent(store, "w-1", first.token, later(DEFAULT_LIVENESS_MS + 61_000));
    expect(attempt).toMatchObject({ ok: false, reason: "bad-token" });
    expect(store.getRunner("w-1")?.runner.retiredAt).toBeNull();
    const own = retireRunnerIfCurrent(store, "w-1", successor.token, later(DEFAULT_LIVENESS_MS + 62_000));
    expect(own).toMatchObject({ ok: true });
    expect(store.getRunner("w-1")?.runner.retiredAt).not.toBeNull();
  });
});

describe("the first-approver bootstrap (finding 2)", () => {
  test("inserts only while the table is empty; the winner's password authenticates", () => {
    // The hash recipe must match scope.ts's — proved by authenticating.
    const first = store.bootstrapApproverIfNone("alex", hashToken("hunter2hunter2"), T0);
    expect(first).toEqual({ ok: true });
    const second = store.bootstrapApproverIfNone("mallory", hashToken("stolen-password"), later(1));
    expect(second).toEqual({ ok: false, reason: "approvers-exist" });
    expect(store.listApprovers().map(one => one.name)).toEqual(["alex"]);
    expect(authenticateApprover(store, "alex", "hunter2hunter2").ok).toBe(true);
  });
});

describe("the shared runner-name rule", () => {
  test("validation and normalization agree with the console form", () => {
    expect(validRunnerName("builder-1")).toBe(true);
    expect(validRunnerName("")).toBe(false);
    expect(validRunnerName("a".repeat(RUNNER_NAME_MAX + 1))).toBe(false);
    expect(validRunnerName("hasbell")).toBe(false);
    expect(normalizeRunnerName("Alekseys-MacBook.Pro.local")).toBe("alekseys-macbook-pro-local");
    expect(normalizeRunnerName("!!!")).toBe("worker");
    expect(normalizeRunnerName("x".repeat(90)).length).toBe(RUNNER_NAME_MAX);
  });
});
