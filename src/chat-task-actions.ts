import type { Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { authorizePlanUnderMode } from "./plan-auto.js";

export const CHAT_TASK_ACTIONS = {
  retry: { label: "Try again", detail: "Queues another attempt. Existing approvals and holds still apply." },
  plan: { label: "Plan first", detail: "Requests a plan. Building still requires approval." },
  wait_for: { label: "Add dependency", detail: "Waits for the selected task to finish." },
  stop_waiting: { label: "Remove dependency", detail: "Stops waiting for the selected task. Other requirements still apply." },
} as const;
export function isChatTaskAction(value: unknown): value is keyof typeof CHAT_TASK_ACTIONS {
  return typeof value === "string" && Object.hasOwn(CHAT_TASK_ACTIONS, value);
}
/** Bind cards to a specific execution and its current state, not the family's moving pointer. */
export function chatTaskStamp(store: Store, who: VerifiedApprover, task: string): string | null {
  const ref = store.lookupRef(task), row = store.getTask(task);
  if (!ref?.repo || !who.repos.includes(ref.repo) || row === null) return null;
  const family = store.taskFamilyOf(task, who.repos, false);
  if (!family || family.problem || family.current.id !== task) return null;
  return JSON.stringify([task, row.state, row.updatedAt, store.getScope(task)?.digest ?? null,
    ref.plan, store.runsFor(ref.id)[0]?.id ?? null, store.blockers(task).sort()]);
}
export function applyChatTaskAction(store: Store, who: VerifiedApprover, payload: Record<string, unknown>, now: Date, web: boolean):
  { ok: true; taskId: string; said: string } | { ok: false; message: string } {
  const task = payload["task"], operation = payload["operation"];
  if (typeof task !== "string" || !isChatTaskAction(operation)) return { ok: false, message: "This task action is incomplete." };
  const stamp = chatTaskStamp(store, who, task);
  if (stamp === null || stamp !== payload["stamp"]) return { ok: false, message: "This task changed. Review it again before confirming." };
  const ref = store.lookupRef(task)!;
  if (store.openContestFor(ref.id) !== null) return { ok: false, message: "Wait for the agent comparison to finish." };
  if (operation === "retry") {
    const result = store.requeueTask(task, who.name, now);
    return result.ok ? { ok: true, taskId: task, said: "Task queued again." } : { ok: false, message:
      result.reason === "claimed" ? "This task is already running." : result.reason === "not-stalled" ? "This task does not need another attempt." : "That task is no longer available." };
  }
  if (operation === "plan") {
    const result = store.requestPlan(ref.id, now);
    if (!result.ok) return { ok: false, message: `Could not request a plan: ${result.reason}.` };
    if (web) authorizePlanUnderMode(store, task, who.name, now);
    return { ok: true, taskId: task, said: "Plan requested. Building still requires approval." };
  }
  const other = payload["dependency"];
  const otherRef = typeof other === "string" ? store.lookupRef(other) : null;
  if (!otherRef?.repo || !who.repos.includes(otherRef.repo)) return { ok: false, message: "That dependency is not in your projects." };
  const result = operation === "wait_for" ? store.addEdge(task, other as string) : store.removeEdge(task, other as string);
  return result.ok ? { ok: true, taskId: task, said: operation === "wait_for" ? "Dependency added." : "Dependency removed." }
    : { ok: false, message: "The dependency could not be changed. Review the current task." };
}
