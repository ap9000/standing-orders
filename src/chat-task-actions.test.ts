import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { acquire, finalizeInterruptedFenced } from "./claim.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { applyChatTaskAction, chatTaskStamp } from "./chat-task-actions.js";
import { executeMateTool } from "./mate-tools.js";
import { taskControlOf } from "./task-control.js";

const now = new Date("2026-09-15T12:00:00Z"), repo = "/repo/chat-stop";
let store: Store, who: VerifiedApprover, run: number, leaseId: string, ref: number;
beforeEach(() => {
  store = openStore(":memory:");
  const login = addApprover(store, "alex", now);
  if (!login.ok) throw new Error("login");
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
  store.createTask({ id: "task", title: "Keep the same task" }, now);
  ref = store.refFor("built-in", "task").id; store.placeTask(ref, repo);
  propose(store, { taskId: "task", goal: "Keep the work", now });
  expect(approve(store, "task", "alex", now, store.getScope("task")!.digest, login.token).ok).toBe(true);
  register(store, { name: "worker", host: "test", capacity: 2, repos: [repo], now, newToken: () => "runner-token" });
  const claim = acquire(store, ref, "worker", { token: "runner-token", now });
  if (!claim.ok) throw new Error(claim.reason);
  leaseId = claim.claim.leaseId;
  const route = store.routeAuthorityFor(ref, "builder", null);
  if (!route?.ok) throw new Error("route");
  run = store.startRun({ taskRef: ref, leaseId, runner: "worker", branch: "standing-orders/task", worktree: "/pool/task", now, route: route.stamp });
  const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
  if (!verified.ok) throw new Error(verified.reason);
  who = verified.who;
});
afterEach(() => store.close());
const payload = (operation: string) => ({ task: "task", run, operation, stamp: chatTaskStamp(store, who, "task") });
const ctx = () => ({ store, who, now, step: 1, readDecisions: new Map(), draft: vi.fn(() => 1) });

test("tools expose the observed run, require its identity, and never dispatch a proposal", () => {
  const context = ctx();
  expect(executeMateTool(context, "get_task", { task: "task" })).toMatchObject({ ok: true, body: { control: { state: "stop", run, action: "stop" } } });
  for (const args of [{ operation: "stop" }, { operation: "stop", run: run + 1 }, { operation: "resume", run }, { operation: "stop", run, dependency: "task" }]) {
    expect(executeMateTool(context, "propose_task_action", { task: "task", ...args }).ok).toBe(false);
  }
  expect(context.draft).not.toHaveBeenCalled();
  expect(executeMateTool(context, "propose_task_action", { task: "task", operation: "stop", run }).ok).toBe(true);
  expect(context.draft).toHaveBeenCalledWith("task_action", expect.objectContaining({ run, task: "task", stamp: chatTaskStamp(store, who, "task") }));
  expect(store.stopOf(run)).toBeNull();
});

test("stop is durable before deferred signals; replay refuses and resume only prepares the ceremony", () => {
  const effects: (() => void)[] = [], first = payload("stop"), approval = store.getScope("task");
  const result = store.transact(() => applyChatTaskAction(store, who, first, now, true, { deferSignal: signal => effects.push(signal) }));
  expect(result).toMatchObject({ ok: true, said: expect.stringContaining("Stop requested") });
  expect(store.stopOf(run)).toMatchObject({ settledAt: null, requestedBy: "alex" });
  expect(effects).toHaveLength(1); effects[0]!();
  expect(applyChatTaskAction(store, who, first, now, true).ok).toBe(false);
  expect(executeMateTool(ctx(), "propose_task_action", { task: "task", run, operation: "resume" }).ok).toBe(false);
  expect(taskControlOf(store, ref, now).kind).toBe("stopping");
  finalizeInterruptedFenced(store, { leaseId, runId: run, taskId: "task", stopRun: run, now });
  expect(applyChatTaskAction(store, who, payload("resume"), now, true)).toMatchObject({ ok: true, said: expect.stringContaining("password confirmation") });
  expect(store.stopOf(run)?.resumedAt).toBeNull();
  expect(store.getScope("task")).toEqual(approval);
  expect(store.runsFor(ref)).toHaveLength(1);
});

test("stale scope, wrong run, and foreign task refuse without stopping", () => {
  const first = payload("stop");
  expect(applyChatTaskAction(store, who, { ...first, run: run + 1 }, now, true).ok).toBe(false);
  expect(applyChatTaskAction(store, who, { ...first, task: "absent" }, now, true).ok).toBe(false);
  propose(store, { taskId: "task", goal: "Changed scope", now });
  expect(applyChatTaskAction(store, who, first, now, true).ok).toBe(false);
  expect(store.stopOf(run)).toBeNull();
});
