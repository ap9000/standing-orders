import { verifiedAuthor, type Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { requestTaskStop, taskControlOf, type StopRequest } from "./task-control.js";
import { authorizePlanUnderMode } from "./plan-auto.js";

export const CHAT_TASK_ACTIONS = {
  // Build #1604 feedback: one short consequence that still says saved work
  // remains, other tasks continue, and the pause waits for acknowledgement.
  stop: { label: "Stop task", detail: "Pauses this task once the run acknowledges the stop. Saved work remains; other tasks continue." },
  resume: { label: "Review resume", detail: "Opens password confirmation to lift this stop’s hold and continue from saved work. Other holds and approval requirements still apply." },
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
/** Only current, eligible controls can become cards; retain the exact run the reader saw. */
export function chatTaskRun(store: Store, task: string, operation: "stop" | "resume", now: Date): number | null {
  const ref = store.lookupRef(task);
  if (ref === null) return null;
  const control = taskControlOf(store, ref.id, now);
  return (operation === "stop" && control.kind === "stop") || (operation === "resume" && control.kind === "paused") ? control.run : null;
}
export function applyChatTaskAction(store: Store, who: VerifiedApprover, payload: Record<string, unknown>, now: Date, web: boolean, controls: Pick<StopRequest, "held" | "deferSignal"> = {}):
  { ok: true; taskId: string; said: string } | { ok: false; message: string } {
  const task = payload["task"], operation = payload["operation"];
  if (typeof task !== "string" || !isChatTaskAction(operation)) return { ok: false, message: "This task action is incomplete." };
  const stamp = chatTaskStamp(store, who, task);
  if (stamp === null || stamp !== payload["stamp"]) return { ok: false, message: "This task changed. Review it again before confirming." };
  const ref = store.lookupRef(task)!;
  if (store.openContestFor(ref.id) !== null) return { ok: false, message: "Wait for the agent comparison to finish." };
  if (operation === "stop" || operation === "resume") {
    if (store.isDemo()) return { ok: false, message: "The demo authorizes nothing." };
    const run = chatTaskRun(store, task, operation, now);
    if (run === null || run !== payload["run"]) return { ok: false, message: "This attempt changed. Review the current task before confirming." };
    // Resume remains the existing nonce + password ceremony. A proposal only opens it.
    if (operation === "resume") return { ok: true, taskId: task, said: `Resume review requested for ${task}. Complete the password confirmation on the task to resume.` };
    const result = requestTaskStop(store, { taskId: task, runId: run, by: verifiedAuthor(who.name), via: web ? "web" : "cli", ...controls }, now);
    return result.ok ? { ok: true, taskId: task, said: `Stop requested for ${task}, run #${run}.` }
      : { ok: false, message: result.detail };
  }
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
