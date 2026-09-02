/**
 * The mate's tools (mate arc §2): reads over the approver's ceiling and
 * proposals that become rows — never a write. Every result passes through
 * `mateView`: repos are opaque `r1..rN` in the principal's order, and no
 * path, digest, approver name, consequence, or recommendation leaves
 * (ruling 4). The same handlers serve the MCP gateway's read tools later;
 * the coordinator keeps its own richer DTOs.
 */
import type { Store, MateProposalKind } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import type { MateToolSchema } from "./converse.js";
import { hasDisguisedText, hasForbiddenControls } from "./decision.js";

export const MATE_MAX_PROPOSALS_PER_TURN = 5;

export type MateToolContext = {
  store: Store;
  who: VerifiedApprover;
  now: Date;
  /** Records a proposal as `drafting` under the running turn; null when the turn may draft no more. */
  draft: (kind: MateProposalKind, payload: Record<string, unknown>) => number | null;
};

export type MateToolResult = { ok: true; body: unknown } | { ok: false; message: string };

const REPO_ID = /^r[0-9]{1,3}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function repoIdOf(who: VerifiedApprover, path: string | null): string | null {
  if (path === null) return null;
  const index = who.repos.indexOf(path);
  return index === -1 ? null : `r${index + 1}`;
}

function repoPathOf(who: VerifiedApprover, id: unknown): string | null {
  if (typeof id !== "string" || !REPO_ID.test(id)) return null;
  const path = who.repos[Number(id.slice(1)) - 1];
  return path ?? null;
}

function honest(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxChars && !hasForbiddenControls(value) && !hasDisguisedText(value);
}

function taskIdOf(args: Record<string, unknown>): string | null {
  const id = args["task"];
  return typeof id === "string" && TASK_ID.test(id) ? id : null;
}

/** The task's ref inside the principal's ceiling, or null — a task outside answers not-found, never its repo. */
function admittedRef(ctx: MateToolContext, taskId: string): { id: number; repo: string; repoId: string } | null {
  const ref = ctx.store.lookupRef(taskId);
  if (ref === null || ref.repo === null) return null;
  const repoId = repoIdOf(ctx.who, ref.repo);
  return repoId === null ? null : { id: ref.id, repo: ref.repo, repoId };
}

const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export type MateTool = MateToolSchema & { handle: (ctx: MateToolContext, args: Record<string, unknown>) => MateToolResult };

export const MATE_TOOLS: MateTool[] = [
  {
    name: "recap",
    description: "What waits on the operator, what runs, what is queued, per project — counts and ids only. Call this first when asked how things stand.",
    inputSchema: schema({}),
    handle: ctx => {
      const snapshot = ctx.store.chatSnapshot(ctx.who.repos, ctx.now);
      const repos = ctx.who.repos.map((_, index) => {
        const tasks = snapshot.tasks.filter(one => one.repoIndex === index);
        return {
          repo: `r${index + 1}`,
          queued: tasks.filter(one => one.state === "queued").length,
          running: tasks.filter(one => one.state === "running").length,
          failed: tasks.filter(one => one.state === "failed").length,
          decisionsOpen: snapshot.decisions.filter(one => one.repoIndex === index).length,
          incidentsOpen: snapshot.incidents.filter(one => one.repoIndex === index).length,
          routines: snapshot.routines.filter(one => one.repoIndex === index).length,
        };
      });
      return {
        ok: true,
        body: {
          repos,
          waitsOnYou: { decisions: snapshot.decisions.length, incidents: snapshot.incidents.length },
          running: snapshot.tasks.filter(one => one.state === "running").map(one => ({ repo: `r${one.repoIndex + 1}`, task: one.id, title: one.title })),
          truncated: snapshot.tasksSaturated || snapshot.decisionsSaturated || snapshot.incidentsSaturated,
        },
      };
    },
  },
  {
    name: "list_repos",
    description: "The projects this conversation may see, as opaque ids r1..rN. The operator's screen shows which name each id stands for.",
    inputSchema: schema({}),
    handle: ctx => ({ ok: true, body: { repos: ctx.who.repos.map((_, index) => ({ repo: `r${index + 1}` })) } }),
  },
  {
    name: "list_tasks",
    description: "Tasks in one project or all of them, newest first, with state, age in hours, and failed-attempt strikes.",
    inputSchema: schema({ repo: { type: "string", pattern: "^r[0-9]{1,3}$" }, state: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
    handle: (ctx, args) => {
      const repo = args["repo"] === undefined ? null : repoPathOf(ctx.who, args["repo"]);
      if (args["repo"] !== undefined && repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      const snapshot = ctx.store.chatSnapshot(ctx.who.repos, ctx.now);
      const limit = typeof args["limit"] === "number" ? Math.min(50, Math.max(1, Math.floor(args["limit"]))) : 20;
      const rows = snapshot.tasks
        .filter(one => (repo === null || ctx.who.repos[one.repoIndex] === repo) && (args["state"] === undefined || one.state === args["state"]))
        .slice(0, limit)
        .map(one => ({ repo: `r${one.repoIndex + 1}`, task: one.id, title: one.title, state: one.state, ageHours: one.ageHours, strikes: one.strikes }));
      return { ok: true, body: { tasks: rows, truncated: snapshot.tasksSaturated } };
    },
  },
  {
    name: "get_task",
    description: "One task: its state, scope standing (none / not approved / rewritten since approval / approved), queue place, holds, attempts, and open decisions. Never its scope text or paths.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 } }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      if (taskId === null) return { ok: false, message: "task is an id, 1-64 characters" };
      const ref = admittedRef(ctx, taskId);
      const task = ref === null ? null : ctx.store.getTask(taskId);
      if (ref === null || task === null) return { ok: false, message: `not-found: no task \`${taskId}\` in your projects` };
      const scope = ctx.store.getScope(taskId);
      const scopeStanding =
        scope === null
          ? "none"
          : scope.approvedAt !== null && scope.approvedDigest === scope.digest
            ? "approved"
            : scope.approvedAt !== null
              ? "rewritten since its approval"
              : "not approved";
      const runs = ctx.store.runsFor(ref.id);
      const holds = ctx.store.activeHolds(ref.id, ctx.now);
      const position = ctx.store.queuePosition(taskId);
      const decisions = ctx.store.chatSnapshot([ref.repo], ctx.now).decisions.length;
      return {
        ok: true,
        body: {
          repo: ref.repoId,
          task: taskId,
          title: task.title,
          state: task.state,
          scope: scopeStanding,
          queue: position === null ? null : { position: position.position, of: position.total, column: position.column ?? "shared" },
          holds: holds.map(one => ({ owner: one.ownerKind, reason: one.reason })),
          attempts: runs.length,
          lastAttempt: runs[0] === undefined ? null : { build: runs[0].id, outcome: runs[0].outcome ?? "unfinished", worker: runs[0].runner },
          decisionsOpen: decisions,
        },
      };
    },
  },
  {
    name: "list_decisions",
    description: "Open decisions across your projects: id, task, question, and option labels. Never consequences or recommendations — you do not choose; the operator answers on the decision page.",
    inputSchema: schema({}),
    handle: ctx => {
      const snapshot = ctx.store.chatSnapshot(ctx.who.repos, ctx.now);
      return {
        ok: true,
        body: {
          decisions: snapshot.decisions.map(one => ({ repo: `r${one.repoIndex + 1}`, decision: one.id, question: one.question, options: one.optionLabels })),
          truncated: snapshot.decisionsSaturated,
        },
      };
    },
  },
  {
    name: "queue",
    description: "One project's queue in dispatch order: the shared column first, then each worker's reserved column.",
    inputSchema: schema({ repo: { type: "string", pattern: "^r[0-9]{1,3}$" } }, ["repo"]),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      const rows = ctx.store.queueScoped(repo, ctx.now).filter(one => one.repo === repo);
      return {
        ok: true,
        body: {
          repo: args["repo"],
          queueRevision: ctx.store.queueRevision(),
          queue: rows.map((one, index) => ({ position: index + 1, task: one.id, title: one.title, column: one.assignedRunner ?? "shared", approved: one.approved, blockers: one.blockers, beingTaken: one.taken })),
        },
      };
    },
  },
  {
    name: "propose_task",
    description: "Propose filing a new task. It becomes a card the operator confirms; nothing is filed until then, and a filed task still needs its scope approved.",
    inputSchema: schema(
      { repo: { type: "string", pattern: "^r[0-9]{1,3}$" }, title: { type: "string", maxLength: 200 }, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } },
      ["repo", "title", "goal"],
    ),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      if (!honest(args["title"], 200) || !honest(args["goal"], 2_000)) return { ok: false, message: "title (≤200) and goal (≤2000) are plain text" };
      const not = args["not"] === undefined || args["not"] === null ? null : honest(args["not"], 2_000) ? (args["not"] as string) : undefined;
      if (not === undefined) return { ok: false, message: "not is plain text ≤2000" };
      const touches = args["touches"] === undefined ? [] : Array.isArray(args["touches"]) && args["touches"].every(one => honest(one, 200)) && args["touches"].length <= 50 ? (args["touches"] as string[]) : null;
      if (touches === null) return { ok: false, message: "touches is up to 50 plain paths" };
      const id = ctx.draft("task", { repo, repoId: args["repo"], title: args["title"], goal: args["goal"], not, touches });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "task", repo: args["repo"], awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_next",
    description: "Propose moving a queued task to the front of its column. The operator confirms; a queue that moved meanwhile refuses.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 } }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      const position = ctx.store.queuePosition(taskId);
      if (position === null) return { ok: false, message: "that task is not queued" };
      if (position.position === 1) return { ok: false, message: "that task is already at the front of its column" };
      const id = ctx.draft("next", { task: taskId, repoId: ref.repoId, queueRevision: ctx.store.queueRevision(), position: position.position, of: position.total });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "next", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_reserve",
    description: "Propose reserving a queued task for one worker (or releasing it to the shared queue with worker null). The operator confirms.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 }, worker: { type: ["string", "null"], maxLength: 60 } }, ["task", "worker"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      const worker = args["worker"];
      if (worker !== null && (typeof worker !== "string" || !ctx.store.listRunners().some(one => one.name === worker && one.retiredAt === null))) {
        return { ok: false, message: "worker must be a registered, active worker name, or null for the shared queue" };
      }
      if (ctx.store.queuePosition(taskId) === null) return { ok: false, message: "that task is not queued" };
      const id = ctx.draft("reserve", { task: taskId, repoId: ref.repoId, worker, queueRevision: ctx.store.queueRevision() });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "reserve", task: taskId, worker, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_hold",
    description: "Propose holding a task's next attempt, with a reason. A running attempt is never interrupted. The operator confirms.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 }, reason: { type: "string", maxLength: 200 } }, ["task", "reason"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      if (!honest(args["reason"], 200)) return { ok: false, message: "reason is plain text ≤200" };
      const id = ctx.draft("hold", { task: taskId, repoId: ref.repoId, reason: args["reason"] });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "hold", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_unhold",
    description: "Propose lifting the operator's own hold on a task. Holds owned by a decision or an incident clear on their own. The operator confirms.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 } }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      const hold = ctx.store.activeHolds(ref.id, ctx.now).find(one => one.ownerKind === "operator");
      if (hold === undefined) return { ok: false, message: "the operator holds no hold on that task" };
      const id = ctx.draft("unhold", { task: taskId, repoId: ref.repoId, holdId: hold.id });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "unhold", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_scope",
    description: "Propose rewriting a task's scope (goal, what not to do, paths it may touch). The operator confirms the rewrite, then approves it with a password — a scope you wrote never approves itself.",
    inputSchema: schema(
      { task: { type: "string", minLength: 1, maxLength: 64 }, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } },
      ["task", "goal"],
    ),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      if (!honest(args["goal"], 2_000)) return { ok: false, message: "goal is plain text ≤2000" };
      const not = args["not"] === undefined || args["not"] === null ? null : honest(args["not"], 2_000) ? (args["not"] as string) : undefined;
      if (not === undefined) return { ok: false, message: "not is plain text ≤2000" };
      const touches = args["touches"] === undefined ? [] : Array.isArray(args["touches"]) && args["touches"].every(one => honest(one, 200)) && args["touches"].length <= 50 ? (args["touches"] as string[]) : null;
      if (touches === null) return { ok: false, message: "touches is up to 50 plain paths" };
      if (ctx.store.hasLiveClaim(ref.id, ctx.now)) return { ok: false, message: "a worker is building that task right now — its scope cannot change under it" };
      const scope = ctx.store.getScope(taskId);
      const id = ctx.draft("scope", { task: taskId, repoId: ref.repoId, goal: args["goal"], not, touches, sawDigest: scope?.digest ?? null });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "scope", task: taskId, awaiting: "the operator's confirmation, then a password to approve" } };
    },
  },
  {
    name: "propose_cancel",
    description: "Propose cancelling a task, with a reason. The operator arms and confirms it themselves; this only points at it.",
    inputSchema: schema({ task: { type: "string", minLength: 1, maxLength: 64 }, reason: { type: "string", maxLength: 200 } }, ["task", "reason"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return { ok: false, message: "not-found: no such task in your projects" };
      if (!honest(args["reason"], 200)) return { ok: false, message: "reason is plain text ≤200" };
      const id = ctx.draft("cancel", { task: taskId, repoId: ref.repoId, reason: args["reason"] });
      if (id === null) return { ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` };
      return { ok: true, body: { proposal: id, kind: "cancel", task: taskId, awaiting: "the operator arming the cancel" } };
    },
  },
];

export const MATE_TOOL_SCHEMAS: MateToolSchema[] = MATE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export function executeMateTool(ctx: MateToolContext, name: string, args: Record<string, unknown>): MateToolResult {
  const tool = MATE_TOOLS.find(one => one.name === name);
  if (tool === undefined) return { ok: false, message: `no tool named ${name}` };
  return tool.handle(ctx, args);
}
