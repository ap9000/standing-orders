/** Operator workflows shared by the console and CLI. Callers prove identity. */
import type { Store } from "./store.js";

export function stopTaskRun(store: Store, input: { taskId: string; runId?: number; by: string; now: Date }) {
  return store.transact(() => {
    if (store.getTask(input.taskId) === null) return { ok: false as const, reason: "unknown-task" };
    const ref = store.lookupRef(input.taskId);
    if (ref === null) return { ok: false as const, reason: "unknown-task" };
    const run = input.runId === undefined
      ? store.runsFor(ref.id).find(one => one.outcome === null && one.role !== "repair" && one.leaseId === store.currentLiveLease(ref.id, input.now))
      : store.getRun(input.runId);
    if (run == null || run.taskRef !== ref.id) return { ok: false as const, reason: "not-running" };
    const stopped = store.requestRunStop(run.id, input.by, input.now);
    return stopped.ok ? { ok: true as const, runId: run.id } : stopped;
  });
}

export function resumeTaskWork(store: Store, taskId: string, now: Date) {
  return store.transact(() => {
    if (store.getTask(taskId) === null) return { ok: false as const, reason: "unknown-task" };
    const ref = store.lookupRef(taskId);
    if (ref === null) return { ok: false as const, reason: "unknown-task" };
    if (store.hasLiveClaim(ref.id, now) || store.runsFor(ref.id).some(one => one.outcome === null && store.runStopRequested(one.id))) {
      return { ok: false as const, reason: "still-stopping" };
    }
    if (!store.activeHolds(ref.id, now).some(one => one.ownerKind === "operator")) return { ok: false as const, reason: "not-paused" };
    store.unhold(ref.id);
    return { ok: true as const };
  });
}
