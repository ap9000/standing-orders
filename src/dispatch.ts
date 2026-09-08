/**
 * One read-side answer to "will this task run?"
 *
 * The atomic claim remains the authority. This module owns the task-local
 * predicates that claim re-proves under its write transaction, then layers
 * fleet observations on top for people and agents reading the queue. A
 * diagnosis can go stale; it can never grant a lease.
 */

import { isAlive } from "./runner.js";
import { approvalOf, type ExecutionProfile } from "./scope.js";
import { BUILT_IN, parseCapabilityKey, type ChatSnapshot, type Store, type TaskState } from "./store.js";

export const DEFAULT_MAX_OPEN_DECISIONS = 5;

export type TaskReadinessBlocker =
  | { code: "unknown-task"; message: string }
  | { code: "state"; state: TaskState; message: string }
  | { code: "hold"; ownerKind: string; until: string | null; message: string }
  | { code: "dependency"; blockerId: string; blockerState: TaskState; message: string };

export type DispatchAction =
  | "open-result"
  | "retry-task"
  | "place-task"
  | "write-scope"
  | "select-agent"
  | "approve-scope"
  | "answer-decision"
  | "unhold"
  | "inspect-hold"
  | "repair-dependency"
  | "repair-capability"
  | "start-worker";

export type DispatchDiagnosisCode =
  | "complete"
  | "cancelled"
  | "failed"
  | "running"
  | "vanished-run"
  | "retry-scheduled"
  | "waiting-decision"
  | "waiting-incident"
  | "held"
  | "waiting-dependency"
  | "terminal-dependency"
  | "needs-project"
  | "needs-scope"
  | "needs-agent-profile"
  | "needs-approval"
  | "missing-requirement"
  | "no-worker-registered"
  | "no-worker-online"
  | "worker-at-capacity"
  | "provider-quota"
  | "planning-ready"
  | "scouting-ready"
  | "ready";

export type DispatchDiagnosis = {
  /** The four-state Never Stuck contract. */
  condition: "running" | "retrying" | "waiting" | "terminal";
  code: DispatchDiagnosisCode;
  summary: string;
  detail: string;
  action: DispatchAction | null;
  /** When the machine already knows the next automatic wake. */
  nextAt: string | null;
  /** The phase an eventual claim would dispatch. */
  role: "builder" | "planner" | "scout" | null;
  blockerTaskId: string | null;
};

/**
 * Task state, active holds, and unfinished dependencies in the exact order
 * acquireIfReady checks them. The claim path calls this while holding its
 * write transaction; read surfaces call it only as a snapshot.
 */
export function taskReadinessBlocker(store: Store, taskRef: number, now: Date): TaskReadinessBlocker | null {
  const db = store.handle;
  const stamp = now.toISOString();
  const task = db
    .prepare(
      `SELECT task.id, task.state FROM task
       JOIN task_ref ON task_ref.external_id = task.id AND task_ref.backend = ?
       WHERE task_ref.id = ?`,
    )
    .get(BUILT_IN, taskRef);
  if (task === undefined) return { code: "unknown-task", message: "no such task" };
  const state = String(task["state"]) as TaskState;
  if (state !== "queued") return { code: "state", state, message: `state is ${state}, not queued` };

  const hold = db
    .prepare(
      `SELECT owner_kind, until, reason FROM hold
       WHERE task_ref = ? AND (until IS NULL OR until > ?)
       ORDER BY held_at, id LIMIT 1`,
    )
    .get(taskRef, stamp);
  if (hold !== undefined) {
    return {
      code: "hold",
      ownerKind: String(hold["owner_kind"]),
      until: hold["until"] === null || hold["until"] === undefined ? null : String(hold["until"]),
      message: `held: ${String(hold["reason"])}`,
    };
  }

  const blocker = db
    .prepare(
      `SELECT blocker.id, blocker.state FROM task_edge
       JOIN task AS blocker ON blocker.id = task_edge.blocker
       WHERE task_edge.blocked = ? AND blocker.state <> 'done'
       ORDER BY blocker.id LIMIT 1`,
    )
    .get(String(task["id"]));
  if (blocker !== undefined) {
    const blockerId = String(blocker["id"]);
    return {
      code: "dependency",
      blockerId,
      blockerState: String(blocker["state"]) as TaskState,
      message: `waiting on ${blockerId}`,
    };
  }
  return null;
}

/** The exact live approval predicate used by both the scheduler survey and
 * the atomic claim. Mode-backed approvals count only while their signer and
 * mode still stand. */
export function scopeApprovedForDispatch(store: Store, taskRef: number, now: Date): boolean {
  const row = store.handle
    .prepare(
      `SELECT 1 AS hit FROM task_scope
       JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
       WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL
         AND (COALESCE(task_scope.approval_basis, 'password') <> 'mode'
           OR EXISTS (SELECT 1 FROM operating_mode om
                      JOIN approver signer ON signer.name = om.signed_by
                     WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                       AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                       AND signer.revoked_at IS NULL AND signer.role = 'approver'))`,
    )
    .get(taskRef, now.toISOString());
  return row !== undefined;
}

/** The phase the ordinary dispatch loop would choose before it resolves an
 * agent. Attended authorization is deliberately outside this ordinary path. */
export function dispatchRoleFor(store: Store, taskRef: number, now: Date): "builder" | "planner" | "scout" {
  const ref = store.refForId(taskRef);
  const approved = scopeApprovedForDispatch(store, taskRef, now);
  if (ref?.plan === "requested" && !approved) return "planner";
  if (ref?.deliverable === "report" && approved) return "scout";
  return "builder";
}

/** The first requirement this task fails, in words, or null. */
export function missingCapability(store: Store, taskRef: number, dispatchRepo: string | null, now: Date): string | null {
  const db = store.handle;
  const row = db.prepare("SELECT repo, capability_requirements FROM task_ref WHERE id = ?").get(taskRef);
  if (row === undefined) return "no such task reference";
  let keys: string[];
  try {
    keys = JSON.parse(String(row["capability_requirements"] ?? "[]")) as string[];
  } catch {
    keys = [];
  }
  if (keys.length === 0) return null;
  const repo = row["repo"] === null || row["repo"] === undefined ? dispatchRepo : String(row["repo"]);
  if (repo === null) return `requires ${keys[0]} but is placed in no repository`;
  const stamp = now.toISOString();
  for (const key of keys) {
    const parsed = parseCapabilityKey(key);
    if (parsed === null) return `requirement \`${key}\` is not a capability key`;
    const found = db.prepare("SELECT status, expires_at FROM capability WHERE repo = ? AND kind = ? AND name = ?").get(repo, parsed.kind, parsed.name);
    if (found === undefined) return `needs ${key} — unrecorded for ${repo}`;
    if (String(found["status"]) !== "verified") return `needs ${key} — not verified`;
    const expires = found["expires_at"];
    if (expires !== null && String(expires) <= stamp) return `needs ${key} — verification expired`;
  }
  return null;
}

function answer(
  code: DispatchDiagnosisCode,
  condition: DispatchDiagnosis["condition"],
  summary: string,
  detail: string,
  options: Partial<Pick<DispatchDiagnosis, "action" | "nextAt" | "role" | "blockerTaskId">> = {},
): DispatchDiagnosis {
  return {
    condition,
    code,
    summary,
    detail,
    action: options.action ?? null,
    nextAt: options.nextAt ?? null,
    role: options.role ?? null,
    blockerTaskId: options.blockerTaskId ?? null,
  };
}

function approvedProfile(scope: ReturnType<Store["getScope"]>): ExecutionProfile | null {
  if (scope === null || scope.approvalKind === "chain") return null;
  return scope.approvedProfile ?? scope.profile ?? null;
}

/** The read-side lifecycle answer. It changes nothing and grants nothing. */
export function diagnoseTaskDispatch(store: Store, taskId: string, now: Date): DispatchDiagnosis | null {
  const task = store.getTask(taskId);
  const ref = store.lookupRef(taskId);
  if (task === null || ref === null) return null;

  if (task.state === "done") return answer("complete", "terminal", "Complete", "The task finished; open its result for proof.", { action: "open-result" });
  if (task.state === "cancelled") return answer("cancelled", "terminal", "Cancelled", "Nothing else will run for this task.");
  if (task.state === "failed") return answer("failed", "terminal", "Needs a retry", "The last attempt stopped; review its incident, then retry it.", { action: "retry-task" });
  if (store.hasLiveClaim(ref.id, now)) return answer("running", "running", "Running now", "A worker owns the current live claim.");
  if (task.state === "running") return answer("vanished-run", "waiting", "Build vanished", "The task says running, but no current claim owns it; reconcile it before retrying.", { action: "retry-task" });

  const local = taskReadinessBlocker(store, ref.id, now);
  if (local?.code === "hold") {
    if (local.ownerKind === "backoff") {
      return answer("retry-scheduled", "retrying", "Retry scheduled", local.until === null ? "The failed attempt is backing off before retrying." : `The next attempt is eligible at ${local.until}.`, { nextAt: local.until });
    }
    if (local.ownerKind === "decision") return answer("waiting-decision", "waiting", "Waiting on your answer", "An agent parked a question; answering it resumes the task.", { action: "answer-decision" });
    if (local.ownerKind === "incident") return answer("waiting-incident", "waiting", "Needs a retry", "An unresolved incident holds the next attempt.", { action: "retry-task" });
    return answer("held", "waiting", "On hold", local.message.replace(/^held:\s*/, ""), { action: local.ownerKind === "operator" ? "unhold" : "inspect-hold" });
  }
  if (local?.code === "dependency") {
    const terminal = local.blockerState === "failed" || local.blockerState === "cancelled";
    return terminal
      ? answer("terminal-dependency", "waiting", "A required task did not finish", `${local.blockerId} ${local.blockerState === "cancelled" ? "was cancelled" : "failed"} before it finished.`, { action: "repair-dependency", blockerTaskId: local.blockerId })
      : answer("waiting-dependency", "waiting", "Waiting for another task", `${local.blockerId} must finish before this task can start.`, { blockerTaskId: local.blockerId });
  }

  const role = dispatchRoleFor(store, ref.id, now);
  const scope = store.getScope(taskId);
  if (ref.repo === null) return answer("needs-project", "waiting", "Needs a project", "Place this task in a repository before a worker can claim it.", { action: "place-task", role });
  if (role !== "planner") {
    if (scope === null) return answer("needs-scope", "waiting", "Needs a scope", "Write the success contract or ask the planner to draft it.", { action: "write-scope", role });
    if (scope.profileState === "unresolved") return answer("needs-agent-profile", "waiting", "Needs an agent profile", scope.unresolvedReason ?? "Choose an available provider and model.", { action: "select-agent", role });
    if (!scopeApprovedForDispatch(store, ref.id, now) || !approvalOf(scope).approved) {
      return answer("needs-approval", "waiting", "Needs your approval", "Review and sign the current scope before a worker can claim it.", { action: "approve-scope", role });
    }
  }

  const gap = missingCapability(store, ref.id, ref.repo, now);
  if (gap !== null) return answer("missing-requirement", "waiting", "Missing a requirement", gap, { action: "repair-capability", role });

  const all = store.listRunners().filter(one => one.retiredAt === null);
  const bound = all.filter(one => one.repos.includes(ref.repo as string));
  const eligible = ref.assignedRunner === null ? bound : bound.filter(one => one.name === ref.assignedRunner);
  if (eligible.length === 0) {
    const detail = ref.assignedRunner === null
      ? all.length === 0 ? "No worker is registered yet." : "Workers exist, but none is registered for this project."
      : `This task is reserved for ${ref.assignedRunner}, but that worker is not registered for this project.`;
    return answer("no-worker-registered", "waiting", "No eligible worker", `${detail} Run standing-orders up on the machine that should build.`, { action: "start-worker", role });
  }
  const alive = eligible.filter(one => isAlive(one, now));
  if (alive.length === 0) {
    const last = eligible.map(one => one.heartbeatAt).sort().at(-1) ?? null;
    return answer("no-worker-online", "waiting", "No worker online", `The eligible worker${eligible.length === 1 ? " is" : "s are"} not answering${last === null ? "" : `; last heard ${last}`}. Nothing will start until it answers. Run standing-orders up on the machine that should build.`, { action: "start-worker", role });
  }
  const available = alive.filter(one => store.liveClaimCount(one.name, now) < one.capacity);
  if (available.length === 0) return answer("worker-at-capacity", "retrying", "Waiting for worker capacity", "Every eligible worker is busy; this task starts when a slot is released.", { role });

  const profile = approvedProfile(scope);
  if (profile !== null) {
    const exhausted = available.map(one => store.readQuotaState(one.name, profile.provider, profile.model, now)).filter(one => one?.state === "exhausted");
    if (exhausted.length === available.length) {
      const resets = exhausted.map(one => one?.resetAt ?? null).filter((one): one is string => one !== null).sort();
      const nextAt = resets[0] ?? null;
      return answer("provider-quota", "retrying", "Provider quota exhausted", nextAt === null ? "The provider has not supplied a reset time; this needs operator attention." : `The next recorded reset is ${nextAt}.`, { action: nextAt === null ? "select-agent" : null, nextAt, role });
    }
  }

  const openDecisions = store.countUnanswered();
  if (openDecisions >= DEFAULT_MAX_OPEN_DECISIONS && (role === "planner" || ref.parkRate > 0)) {
    return answer("waiting-decision", "waiting", "Decision queue is full", `${openDecisions} decisions already wait; answer some before this task may add another.`, { action: "answer-decision", role });
  }
  if (role === "planner") return answer("planning-ready", "retrying", "Planner ready", "An eligible worker can draft the scope on the next pass.", { role });
  if (role === "scout") return answer("scouting-ready", "retrying", "Scout ready", "An eligible worker can produce the report on the next pass.", { role });
  return answer("ready", "retrying", "Ready to run", "An eligible worker has capacity and every dispatch gate currently passes.", { role });
}

export function diagnosisIsDispatchable(diagnosis: DispatchDiagnosis | null): boolean {
  return diagnosis?.code === "ready" || diagnosis?.code === "planning-ready" || diagnosis?.code === "scouting-ready";
}

/** Attach the same lifecycle answer to the bounded fleet snapshot used by
 * both direct chat and the long-running mate. */
export function withDispatchDiagnoses(store: Store, snapshot: ChatSnapshot, now: Date): ChatSnapshot {
  return {
    ...snapshot,
    tasks: snapshot.tasks.map(one => ({ ...one, dispatch: diagnoseTaskDispatch(store, one.id, now) })),
  };
}
