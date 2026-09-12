import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquireIfReady } from "./claim.js";
import {
  diagnoseTaskDispatch,
  diagnosisIsDispatchable,
  taskReadinessBlocker,
  withDispatchDiagnoses,
} from "./dispatch.js";
import { register } from "./runner.js";
import { addApprover, approve } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { resolve } from "node:path";

const T0 = new Date("2026-09-08T16:00:00.000Z");
const REPO = resolve("never-stuck-test-repo");
const TOKEN = "runner-token";
let approverToken = "";

function file(store: Store, id: string): number {
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  store.saveScope({
    taskId: id,
    goal: `finish ${id}`,
    outOfScope: null,
    touches: [],
    acceptance: [],
    proposedAt: T0.toISOString(),
    digest: `digest-${id}`,
    approvedAt: null,
    approvedBy: null,
    approvedDigest: null,
  });
  const signed = approve(store, id, "operator", T0, store.getScope(id)?.digest ?? "", approverToken);
  if (!signed.ok) throw new Error(`approval refused: ${signed.reason}`);
  return ref;
}

function enroll(store: Store): void {
  register(store, {
    name: "worker",
    host: "test",
    capacity: 1,
    repos: [REPO],
    now: T0,
    newToken: () => TOKEN,
  });
}

describe("Never Stuck dispatch diagnosis", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const added = addApprover(store, "operator", T0);
    if (!added.ok) throw new Error("approver bootstrap refused");
    approverToken = added.token;
  });

  afterEach(() => store.close());

  test("covers waiting, retrying, running, and terminal with one contract", () => {
    const ref = file(store, "t-life");

    expect(diagnoseTaskDispatch(store, "t-life", T0)).toMatchObject({
      condition: "waiting",
      code: "no-worker-registered",
      action: "start-worker",
      summary: "Builder not connected",
      detail: "This project has not been connected to a builder yet.",
    });

    enroll(store);
    const ready = diagnoseTaskDispatch(store, "t-life", T0);
    expect(ready).toMatchObject({ condition: "retrying", code: "ready", role: "builder" });
    expect(diagnosisIsDispatchable(ready)).toBe(true);

    expect(acquireIfReady(store, ref, "worker", {
      token: TOKEN,
      repo: REPO,
      now: T0,
      newLeaseId: () => "lease-life",
    })).toMatchObject({ ok: true });
    expect(diagnoseTaskDispatch(store, "t-life", T0)).toMatchObject({ condition: "running", code: "running" });

    store.setTaskState("t-life", "done", new Date(T0.getTime() + 1_000));
    expect(diagnoseTaskDispatch(store, "t-life", new Date(T0.getTime() + 1_000))).toMatchObject({ condition: "waiting", code: "needs-verification" });
    store.setTaskState("t-life", "cancelled", new Date(T0.getTime() + 2_000));
    expect(diagnoseTaskDispatch(store, "t-life", new Date(T0.getTime() + 2_000))).toMatchObject({ condition: "terminal", code: "cancelled" });
  });

  test("a refuted build stays actionable after a newer successful review; acceptance is explicit", () => {
    const ref = file(store, "t-proof");
    enroll(store);
    expect(acquireIfReady(store, ref, "worker", { token: TOKEN, repo: REPO, now: T0, newLeaseId: () => "lease-proof" }).ok).toBe(true);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("fixture route missing");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-proof", runner: "worker", branch: "feat/proof", worktree: REPO,
      provider: authority.stamp.provider, ...(authority.stamp.model === null ? {} : { model: authority.stamp.model }),
      route: authority.stamp, now: T0 });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(run, "refuted", ["signed statement changed"], T0);
    store.setTaskState("t-proof", "done", T0);
    // A historical review row must never replace the build's result.
    store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, outcome, started_at, finished_at) VALUES (?, 'lease-proof', 'worker', 'reviewer', 'claude', ?, 'no-change', ?, ?)").run(ref, run, T0.toISOString(), T0.toISOString());
    expect(diagnoseTaskDispatch(store, "t-proof", T0)).toMatchObject({ condition: "waiting", code: "proof-refuted", summary: "Proof correction needed", action: "open-result" });
    expect(diagnosisIsDispatchable(diagnoseTaskDispatch(store, "t-proof", T0))).toBe(false);
    store.acceptProof(run, "operator", "Reviewed the exact exception", T0);
    expect(diagnoseTaskDispatch(store, "t-proof", T0)).toMatchObject({ condition: "terminal", code: "complete", summary: "Complete with recorded acceptance" });
  });

  test("a finished build shows pending, live, failed, queued-retry, exhausted, and succeeded review states with attempt counts (v50)", () => {
    const ref = file(store, "t-review-state");
    enroll(store);
    expect(acquireIfReady(store, ref, "worker", { token: TOKEN, repo: REPO, now: T0, newLeaseId: () => "lease-review-state" }).ok).toBe(true);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("fixture route missing");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-review-state", runner: "worker", branch: "feat/review-state", worktree: REPO,
      provider: authority.stamp.provider, ...(authority.stamp.model === null ? {} : { model: authority.stamp.model }), route: authority.stamp, now: T0 });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(run, "verified", [], T0);
    store.setTaskState("t-review-state", "done", T0);
    const request = (): number => Number(store.raw().prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'operator', 'human', ?)").run(run, T0.toISOString()).lastInsertRowid);
    const root = (attempt: number, requestId: number): number => {
      const inserted = store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, review_attempt) VALUES (?, 'review-state', 'worker', 'reviewer', 'claude', ?, ?, ?)").run(ref, run, T0.toISOString(), attempt);
      store.raw().prepare("UPDATE review_request SET consumed_at = ?, consumed_reason = 'dispatched', reviewer_run = ? WHERE id = ?").run(T0.toISOString(), Number(inserted.lastInsertRowid), requestId);
      return Number(inserted.lastInsertRowid);
    };
    expect(diagnoseTaskDispatch(store, "t-review-state", T0)).toMatchObject({ condition: "terminal", code: "complete", review: null });
    const first = request();
    expect(diagnoseTaskDispatch(store, "t-review-state", T0)).toMatchObject({ condition: "waiting", code: "review-pending", summary: "Waiting for review", action: "open-result", review: { state: "queued", attempt: 1, cap: 3, retriesRemaining: 2, queued: { requestedBy: "operator", origin: "operator" } } });
    const review = root(1, first);
    expect(diagnoseTaskDispatch(store, "t-review-state", T0)).toMatchObject({ condition: "running", code: "reviewing", summary: "Reviewing", review: { state: "running", attempt: 1, retriesRemaining: 0 } });
    expect(diagnoseTaskDispatch(store, "t-review-state", new Date(T0.getTime() + 60 * 60_000))).toMatchObject({ condition: "waiting", code: "review-failed", summary: "Review interrupted", action: "open-result", review: { state: "running", attempt: 1 } });
    store.finishRun(review, { outcome: "failed", reason: "reviewer-ingestion: database busy", now: T0 });
    // The latest failure names its attempt, its reason, and the one explicit next act.
    const failed = diagnoseTaskDispatch(store, "t-review-state", T0);
    expect(failed).toMatchObject({ condition: "waiting", code: "review-failed", summary: "Review failed — retry available", action: "retry-review",
      review: { state: "retryable", attempt: 1, cap: 3, retriesUsed: 0, retriesRemaining: 2, latestRun: review, latestReason: "reviewer-ingestion: database busy", interrupted: false } });
    expect(failed?.detail).toContain("attempt 1 of 3 failed (reviewer-ingestion: database busy)");
    expect(failed?.detail).toContain("2 explicit retries left");
    // A queued retry is NOT hidden behind the older failed run.
    const second = request();
    const queuedRetry = diagnoseTaskDispatch(store, "t-review-state", T0);
    expect(queuedRetry).toMatchObject({ condition: "waiting", code: "review-pending", summary: "Review retry queued (attempt 2 of 3)", action: "open-result", review: { state: "queued", attempt: 2, retriesRemaining: 1, latestRun: review, queued: { requestedBy: "operator", origin: "operator" } } });
    expect(queuedRetry?.detail).toContain("asked by operator");
    // A retry is always an operator's ask (explicit-only): the typed view
    // names the asker and the origin, never 'automatic' past attempt 1.
    expect(store.raw().prepare("SELECT origin FROM review_request WHERE id = ?").get(second)).toEqual({ origin: "operator" });
    const retry = root(2, second);
    expect(diagnoseTaskDispatch(store, "t-review-state", T0)).toMatchObject({ condition: "running", code: "reviewing", summary: "Reviewing (retry 1 of 2)", review: { state: "running", attempt: 2 } });
    store.finishRun(retry, { outcome: "failed", reason: "interrupted", now: T0 });
    const interrupted = diagnoseTaskDispatch(store, "t-review-state", T0);
    expect(interrupted).toMatchObject({ code: "review-failed", summary: "Review interrupted — retry available", action: "retry-review", review: { state: "retryable", attempt: 2, retriesUsed: 1, retriesRemaining: 1, latestRun: retry, interrupted: true } });
    expect(interrupted?.detail).toContain("1 explicit retry left");
    const third = request();
    const last = root(3, third);
    store.finishRun(last, { outcome: "failed", reason: "reviewer-agent", now: T0 });
    // Exhausted: no retry action, the count and the latest reason stated.
    const exhausted = diagnoseTaskDispatch(store, "t-review-state", T0);
    expect(exhausted).toMatchObject({ condition: "waiting", code: "review-exhausted", summary: "Review retries exhausted", action: "open-result", review: { state: "exhausted", attempt: 3, retriesUsed: 2, retriesRemaining: 0, latestRun: last, latestReason: "reviewer-agent" } });
    expect(exhausted?.detail).toContain("All 3 review attempts ended without a review (latest: reviewer-agent)");
    expect(diagnosisIsDispatchable(exhausted)).toBe(false);
    store.acceptProof(run, "operator", "Accepted the verified build after inspecting its result", T0);
    expect(diagnoseTaskDispatch(store, "t-review-state", T0)).toMatchObject({ condition: "terminal", code: "complete", review: { state: "exhausted" } });

    // A successful retry reads as complete and says which attempt landed it.
    const other = file(store, "t-review-won");
    const otherAuthority = store.routeAuthorityFor(other, "builder");
    if (!otherAuthority?.ok) throw new Error("fixture route missing");
    const won = store.startRun({ taskRef: other, leaseId: "lease-review-won", runner: "worker", branch: "feat/review-won", worktree: REPO,
      provider: otherAuthority.stamp.provider, ...(otherAuthority.stamp.model === null ? {} : { model: otherAuthority.stamp.model }), route: otherAuthority.stamp, now: T0 });
    store.finishRun(won, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(won, "verified", [], T0);
    store.setTaskState("t-review-won", "done", T0);
    store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, finished_at, outcome, reason, review_attempt) VALUES (?, 'x', 'worker', 'reviewer', 'claude', ?, ?, ?, 'failed', 'reviewer-timeout', 1)").run(other, won, T0.toISOString(), T0.toISOString());
    store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, finished_at, outcome, reason, review_attempt) VALUES (?, 'y', 'worker', 'reviewer', 'claude', ?, ?, ?, 'no-change', 'reviewed — 0 comment(s)', 2)").run(other, won, T0.toISOString(), T0.toISOString());
    const complete = diagnoseTaskDispatch(store, "t-review-won", T0);
    expect(complete).toMatchObject({ condition: "terminal", code: "complete", summary: "Complete", action: "open-result", review: { state: "succeeded", attempt: 2, retriesUsed: 1, retriesRemaining: 0 } });
    expect(complete?.detail).toContain("succeeded on attempt 2 of 3");
  });

  test("a cancelled dependency is a repair, never a calm wait or a claim", () => {
    const blocker = file(store, "t-blocker");
    const dependent = file(store, "t-dependent");
    enroll(store);
    expect(store.addEdge("t-dependent", "t-blocker")).toEqual({ ok: true });
    expect(store.cancelTask("t-blocker", T0, "superseded")).toMatchObject({ ok: true });

    const diagnosis = diagnoseTaskDispatch(store, "t-dependent", T0);
    expect(diagnosis).toMatchObject({
      condition: "waiting",
      code: "terminal-dependency",
      action: "repair-dependency",
      blockerTaskId: "t-blocker",
    });
    expect(diagnosis?.detail).toContain("cancelled");
    expect(taskReadinessBlocker(store, dependent, T0)).toEqual({
      code: "dependency",
      blockerId: "t-blocker",
      blockerState: "cancelled",
      message: "waiting on t-blocker",
    });
    expect(acquireIfReady(store, dependent, "worker", {
      token: TOKEN,
      repo: REPO,
      now: T0,
    })).toEqual({ ok: false, reason: "not-ready", message: "waiting on t-blocker" });

    const snapshot = withDispatchDiagnoses(store, store.chatSnapshot([REPO], T0), T0);
    expect(snapshot.tasks.find(one => one.id === "t-dependent")?.dispatch?.code).toBe("terminal-dependency");
    expect(store.refForId(blocker)?.externalId).toBe("t-blocker");
  });

  test("an automatic backoff states when it will retry", () => {
    const ref = file(store, "t-backoff");
    enroll(store);
    const next = new Date(T0.getTime() + 60_000);
    store.holdOwned({ taskRef: ref, ownerKind: "backoff", ownerId: "attempt-1", reason: "cool down", until: next }, T0);

    expect(diagnoseTaskDispatch(store, "t-backoff", T0)).toMatchObject({
      condition: "retrying",
      code: "retry-scheduled",
      nextAt: next.toISOString(),
      action: null,
    });
  });

  test("quota diagnosis is read-only and exposes a known reset", () => {
    file(store, "t-quota");
    enroll(store);
    const reset = new Date(T0.getTime() + 60_000);
    store.stampQuota({ runner: "worker", provider: "claude", scope: "sonnet", reason: "membership window", resetAt: reset }, T0);

    expect(diagnoseTaskDispatch(store, "t-quota", T0)).toMatchObject({
      condition: "retrying",
      code: "provider-quota",
      nextAt: reset.toISOString(),
    });

    const after = new Date(reset.getTime() + 1);
    store.touchRunner("worker", after);
    expect(diagnoseTaskDispatch(store, "t-quota", after)?.code).toBe("ready");
    expect(store.handle.prepare("SELECT state FROM quota").get()?.["state"]).toBe("exhausted");
  });
});
