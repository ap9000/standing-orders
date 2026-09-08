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
    expect(diagnoseTaskDispatch(store, "t-life", new Date(T0.getTime() + 1_000))).toMatchObject({ condition: "terminal", code: "complete" });
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
