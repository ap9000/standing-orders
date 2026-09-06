import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { resumeTaskWork, stopTaskRun } from "./control.js";
import { disposeBuildOutcome } from "./dispose.js";
import { invokeAgent } from "./invoke.js";
import { run } from "./exec.js";

const NOW = new Date("2026-09-05T12:00:00Z");
let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  register(store, { name: "worker", host: "test", capacity: 4, repos: ["/repo"], now: NOW, newToken: () => "token" });
});
afterEach(() => store.close());

function started(taskId: string) {
  store.createTask({ id: taskId, title: taskId }, NOW);
  const taskRef = store.refFor("built-in", taskId).id;
  store.placeTask(taskRef, "/repo");
  const claim = acquire(store, taskRef, "worker", { now: NOW, token: "token" });
  if (!claim.ok) throw new Error(claim.reason);
  store.setTaskState(taskId, "running", NOW);
  const runId = store.startRun({ taskRef, leaseId: claim.claim.leaseId, runner: "worker", branch: `work/${taskId}`, worktree: "/work", now: NOW });
  return { taskRef, runId, leaseId: claim.claim.leaseId, taskId };
}

describe("operator control", () => {
  test("stop is bound to one run, survives repeats, and cannot resume before settlement", () => {
    const a = started("a");
    const b = started("b");
    expect(stopTaskRun(store, { taskId: "a", runId: b.runId, by: "alex", now: NOW })).toMatchObject({ ok: false });
    expect(stopTaskRun(store, { taskId: "a", runId: a.runId, by: "alex", now: NOW })).toMatchObject({ ok: true });
    expect(stopTaskRun(store, { taskId: "a", runId: a.runId, by: "alex", now: NOW })).toMatchObject({ ok: true });
    expect(store.notesForRun(a.runId)).toHaveLength(1);
    expect(store.runStopRequested(a.runId)).toBe(true);
    expect(store.runStopRequested(b.runId)).toBe(false);
    expect(resumeTaskWork(store, "a", NOW)).toMatchObject({ ok: false, reason: "still-stopping" });
    expect(store.activeHolds(b.taskRef, NOW)).toHaveLength(0);
  });

  test.each(["stopped", "handoff-incomplete"] as const)("%s preserves strikes, releases the lease, and waits for resume", reason => {
    const a = started("a");
    store.addStrike(a.taskRef);
    const disposition = disposeBuildOutcome({ store, policy: "tick", ...a, runner: "worker", repo: "/repo", branch: "work/a", origin: "ours", provider: "claude", model: null, worktreePath: "/work", clock: () => NOW },
      { ok: false, reason, message: "Work preserved." });
    expect(disposition).toEqual({ kind: "recorded", outcome: "interrupted" });
    expect(store.refForId(a.taskRef)?.strikes).toBe(1);
    expect(store.currentLiveLease(a.taskRef, NOW)).toBeNull();
    expect(store.getTask("a")?.state).toBe("queued");
    expect(store.listReady(NOW)).toHaveLength(0);
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "interrupted", reason });
    expect(resumeTaskWork(store, "a", NOW)).toEqual({ ok: true });
    expect(store.activeHolds(a.taskRef, NOW)).toHaveLength(0);
  });

  test("repair inherits a stop; a successor build does not", () => {
    const a = started("a");
    stopTaskRun(store, { taskId: "a", runId: a.runId, by: "alex", now: NOW });
    const child = (role: "repair" | "builder") => store.startRun({ taskRef: a.taskRef, leaseId: a.leaseId, runner: "worker", branch: "work/a", worktree: "/work", role, parentRun: a.runId, now: NOW });
    expect(store.runStopRequested(child("repair"))).toBe(true);
    expect(store.runStopRequested(child("builder"))).toBe(false);
  });

  test("a stop arriving during git commit cannot become accepted work or a publication", () => {
    const a = started("a");
    store.recordOutcomeFacts(a.runId, { headRevision: "a".repeat(40) });
    stopTaskRun(store, { taskId: "a", runId: a.runId, by: "alex", now: NOW });
    const result = disposeBuildOutcome({ store, policy: "tick", ...a, runner: "worker", repo: "/repo", branch: "work/a", origin: "ours", provider: "claude", model: null, worktreePath: "/work", clock: () => NOW }, { ok: true, committed: true });
    expect(result).toEqual({ kind: "recorded", outcome: "interrupted" });
    expect(store.getTask("a")?.state).toBe("queued");
    expect(store.publicationForRun(a.runId)).toBeNull();
  });

  test("a stale run cannot pause a successor's task", () => {
    const a = started("a");
    store.handle.prepare("UPDATE claim SET released_at = ? WHERE lease_id = ?").run(NOW.toISOString(), a.leaseId);
    expect(store.pauseInterruptedRun(a.runId, "stopped", "late", NOW)).toBe(false);
    expect(store.activeHolds(a.taskRef, NOW)).toHaveLength(0);
  });

  test("the gateway kills only the requested provider process group", async () => {
    const a = started("a");
    const b = started("b");
    const spec = { provider: "claude" as const, model: null };
    const ask = { phase: "build" as const, brief: "fixture", maxTurns: 10, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null };
    const first = invokeAgent(store, a.runId, spec, ask, { clock: () => NOW, runner: async (_file, _argv, options) => {
      return run(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { ...options, onSpawn: pid => {
        options?.onSpawn?.(pid);
        stopTaskRun(store, { taskId: "a", runId: a.runId, by: "alex", now: NOW });
      } });
    } });
    const second = invokeAgent(store, b.runId, spec, ask, { clock: () => NOW, runner: (_file, _argv, options) =>
      run(process.execPath, ["-e", 'setTimeout(() => console.log(JSON.stringify({result:"finished"})), 900)'], options) });
    const [stopped, finished] = await Promise.all([first, second]);
    expect(stopped.kind === "ran" && stopped.outcome.code !== 0).toBe(true);
    expect(finished.kind === "ran" && finished.outcome.code).toBe(0);
    expect(store.runStopRequested(b.runId)).toBe(false);
  });
});
