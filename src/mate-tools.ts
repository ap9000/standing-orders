/**
 * The mate's tools (mate arc §2): reads over the approver's ceiling and
 * proposals that become rows — never a write. Every result passes through
 * `mateView`, a fail-closed choke point (ruling 4; slice-1 review finding
 * 9): repos are opaque `r1..rN` in the principal's order, and every string
 * that leaves is scrubbed of path-shaped text, digests, and account names
 * — titles, questions, and reasons included, because a human typed those
 * and a human may have typed a path into them. Consequences and
 * recommendations are never read at all. The coordinator keeps its own
 * richer DTOs.
 */
import { Buffer } from "node:buffer";
import type { Store, MateProposalKind } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import type { MateToolSchema } from "./converse.js";
import { hasDisguisedText, hasForbiddenControls } from "./decision.js";
import { scanForSecrets } from "./evidence.js";

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
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ------------------------------------------------------------- mateView

/** What a mate-facing string may not carry: an absolute path, a hex digest of 32+ digits, an account name. */
const PATH_SHAPED = /(?:^|[\s"'`(<[=:,])(\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+)/g;
const HEX_DIGEST = /\b[0-9a-f]{32,}\b/gi;

export type MateViewContext = { repos: readonly string[]; names: readonly string[] };

/** Scrub one string. Exact repo paths and their basenames go first (v13: no paths, no basenames), then shapes. */
export function redactForMate(text: string, view: MateViewContext): string {
  let out = text;
  for (const repo of view.repos) {
    if (repo === "") continue;
    out = out.split(repo).join("[path]");
    const base = repo.split("/").filter(one => one !== "").pop();
    if (base !== undefined && base.length >= 4) out = out.split(base).join("[path]");
  }
  out = out.replace(PATH_SHAPED, (whole, path: string) => whole.slice(0, whole.length - path.length) + "[path]");
  out = out.replace(HEX_DIGEST, "[digest]");
  for (const name of view.names) {
    if (name.length < 2) continue;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gi");
    out = out.replace(pattern, (_whole, lead: string) => `${lead}[approver]`);
  }
  return out;
}

/** The choke point: every string inside a tool result, recursively, scrubbed. */
export function mateView<T>(value: T, view: MateViewContext): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactForMate(node, view);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(node)) out[key] = walk(inner);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

export function mateViewContextFor(store: Store, who: VerifiedApprover): MateViewContext {
  return { repos: who.repos, names: store.listApprovers().map(one => one.name) };
}

// ------------------------------------------------------------- helpers

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

/** Plain text of bounded length with no control characters, disguised text, or credential-shaped runs (finding 4). */
function honest(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maxChars &&
    !hasForbiddenControls(value) &&
    !hasDisguisedText(value) &&
    scanForSecrets(value).length === 0
  );
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

function readOptionalText(value: unknown, maxChars: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  return honest(value, maxChars) ? value : undefined;
}

function readTouches(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(one => honest(one, 200))) return null;
  return value as string[];
}

const tooMany = (): MateToolResult => ({ ok: false, message: `this turn already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals` });
const notFound = (): MateToolResult => ({ ok: false, message: "not-found: no such task in your projects" });

const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TASK_ARG = { type: "string", minLength: 1, maxLength: 64 };
const REPO_ARG = { type: "string", pattern: "^r[0-9]{1,3}$" };

export type MateTool = MateToolSchema & { handle: (ctx: MateToolContext, args: Record<string, unknown>) => MateToolResult };

/** Whether a queued task's scope stands approved as written. */
function scopeStandingOf(store: Store, taskId: string): "none" | "approved" | "rewritten since its approval" | "not approved" {
  const scope = store.getScope(taskId);
  if (scope === null) return "none";
  if (scope.approvedAt !== null && scope.approvedDigest === scope.digest) return "approved";
  return scope.approvedAt !== null ? "rewritten since its approval" : "not approved";
}

export const MATE_TOOLS: MateTool[] = [
  {
    name: "recap",
    description:
      "How things stand per project, counts and ids only: what waits on the operator (decisions, incidents, scopes awaiting approval), what runs, what is queued, what finished and what failed. Pass `since` (an ISO timestamp) to count only what changed after it. Call this first when asked how things stand.",
    inputSchema: schema({ since: { type: "string", maxLength: 30 } }),
    handle: (ctx, args) => {
      const since = args["since"];
      if (since !== undefined && (typeof since !== "string" || !ISO_STAMP.test(since) || Number.isNaN(Date.parse(since)))) {
        return { ok: false, message: "since is an ISO timestamp like 2026-09-02T12:00:00Z" };
      }
      const horizonHours = typeof since === "string" ? Math.max(0, (ctx.now.getTime() - Date.parse(since)) / 3_600_000) : Infinity;
      const snapshot = ctx.store.chatSnapshot(ctx.who.repos, ctx.now);
      const recent = <T extends { ageHours: number }>(rows: T[]): T[] => rows.filter(one => one.ageHours <= horizonHours);
      const tasks = recent(snapshot.tasks);
      const decisions = recent(snapshot.decisions);
      const incidents = recent(snapshot.incidents);
      const awaitingApproval = snapshot.tasks.filter(one => one.state === "queued" && scopeStandingOf(ctx.store, one.id) !== "approved");
      const repos = ctx.who.repos.map((_, index) => {
        const mine = <T extends { repoIndex: number }>(rows: T[]): T[] => rows.filter(one => one.repoIndex === index);
        return {
          repo: `r${index + 1}`,
          waitsOnYou: {
            decisions: mine(decisions).length,
            incidents: mine(incidents).length,
            scopesAwaitingApproval: mine(awaitingApproval).length,
          },
          running: mine(tasks).filter(one => one.state === "running").length,
          queued: mine(snapshot.tasks).filter(one => one.state === "queued").length,
          finished: mine(tasks).filter(one => one.state === "done").length,
          failed: mine(tasks).filter(one => one.state === "failed").length,
        };
      });
      return {
        ok: true,
        body: {
          since: typeof since === "string" ? since : null,
          repos,
          waitsOnYou: {
            decisions: decisions.map(one => ({ repo: `r${one.repoIndex + 1}`, decision: one.id, task: one.taskId })),
            incidents: incidents.length,
            scopesAwaitingApproval: awaitingApproval.map(one => ({ repo: `r${one.repoIndex + 1}`, task: one.id })),
          },
          running: tasks.filter(one => one.state === "running").map(one => ({ repo: `r${one.repoIndex + 1}`, task: one.id, title: one.title })),
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
    inputSchema: schema({ repo: REPO_ARG, state: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
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
    description:
      "One task: its state, scope standing (none / not approved / rewritten since approval / approved), queue place, holds, attempts, and its own open decisions. Never its scope text or paths.",
    inputSchema: schema({ task: TASK_ARG }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      if (taskId === null) return { ok: false, message: "task is an id, 1-64 characters" };
      const ref = admittedRef(ctx, taskId);
      const task = ref === null ? null : ctx.store.getTask(taskId);
      if (ref === null || task === null) return notFound();
      const runs = ctx.store.runsFor(ref.id);
      const holds = ctx.store.activeHolds(ref.id, ctx.now);
      const position = ctx.store.queuePosition(taskId);
      const decisionsOpen = ctx.store.decisionsForTask(ref.id).filter(one => one.state === "open").length;
      return {
        ok: true,
        body: {
          repo: ref.repoId,
          task: taskId,
          title: task.title,
          state: task.state,
          scope: scopeStandingOf(ctx.store, taskId),
          queue: position === null ? null : { position: position.position, of: position.total, column: position.column ?? "shared" },
          holds: holds.map(one => ({ owner: one.ownerKind, reason: one.reason })),
          attempts: runs.length,
          lastAttempt: runs[0] === undefined ? null : { build: runs[0].id, outcome: runs[0].outcome ?? "unfinished", worker: runs[0].runner },
          decisionsOpen,
        },
      };
    },
  },
  {
    name: "list_decisions",
    description:
      "Open decisions across your projects: id, task, question, the options (id, label, whether reversible), age in hours. Never consequences or recommendations — you do not choose; the operator answers on the decision page.",
    inputSchema: schema({}),
    handle: ctx => {
      const snapshot = ctx.store.chatSnapshot(ctx.who.repos, ctx.now);
      return {
        ok: true,
        body: {
          decisions: snapshot.decisions.map(one => ({
            repo: `r${one.repoIndex + 1}`,
            decision: one.id,
            task: one.taskId,
            question: one.question,
            options: one.options,
            ageHours: one.ageHours,
          })),
          truncated: snapshot.decisionsSaturated,
        },
      };
    },
  },
  {
    name: "queue",
    description: "One project's queue by column — the shared column, then each worker's reserved column — each in its own dispatch order.",
    inputSchema: schema({ repo: REPO_ARG }, ["repo"]),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      const rows = ctx.store.queueScoped(repo, ctx.now).filter(one => one.repo === repo);
      const columns = new Map<string, { position: number; task: string; title: string; approved: boolean; blockers: unknown; beingTaken: boolean }[]>();
      for (const one of rows) {
        const column = one.assignedRunner ?? "shared";
        const list = columns.get(column) ?? [];
        list.push({ position: list.length + 1, task: one.id, title: one.title, approved: one.approved, blockers: one.blockers, beingTaken: one.taken });
        columns.set(column, list);
      }
      const ordered = [...columns.entries()].sort(([a], [b]) => (a === "shared" ? -1 : b === "shared" ? 1 : a.localeCompare(b)));
      return {
        ok: true,
        body: {
          repo: args["repo"],
          queueRevision: ctx.store.queueRevision(),
          columns: ordered.map(([column, tasks]) => ({ column, tasks })),
        },
      };
    },
  },
  {
    name: "propose_task",
    description: "Propose filing a new task. It becomes a card the operator confirms; nothing is filed until then, and a filed task still needs its scope approved.",
    inputSchema: schema(
      { repo: REPO_ARG, title: { type: "string", maxLength: 200 }, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } },
      ["repo", "title", "goal"],
    ),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      if (!honest(args["title"], 200) || !honest(args["goal"], 2_000)) return { ok: false, message: "title (≤200) and goal (≤2000) are plain text" };
      const not = readOptionalText(args["not"], 2_000);
      if (not === undefined) return { ok: false, message: "not is plain text ≤2000" };
      const touches = readTouches(args["touches"]);
      if (touches === null) return { ok: false, message: "touches is up to 50 plain paths" };
      const id = ctx.draft("task", { repo, repoId: args["repo"], title: args["title"], goal: args["goal"], not, touches });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "task", repo: args["repo"], awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_next",
    description: "Propose moving a queued task to the front of its column. The operator confirms; a queue that moved meanwhile refuses.",
    inputSchema: schema({ task: TASK_ARG }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      // The revision and the place are read in ONE transaction (finding 10):
      // the door's revision check then vouches for the position it saw.
      const seen = ctx.store.transact(() => ({ queueRevision: ctx.store.queueRevision(), position: ctx.store.queuePosition(taskId) }));
      if (seen.position === null) return { ok: false, message: "that task is not queued" };
      if (seen.position.position === 1) return { ok: false, message: "that task is already at the front of its column" };
      const id = ctx.draft("next", { task: taskId, repoId: ref.repoId, queueRevision: seen.queueRevision, position: seen.position.position, of: seen.position.total, column: seen.position.column });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "next", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_reserve",
    description: "Propose reserving a queued task for one worker (or releasing it to the shared queue with worker null). The operator confirms.",
    inputSchema: schema({ task: TASK_ARG, worker: { type: ["string", "null"], maxLength: 60 } }, ["task", "worker"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      const worker = args["worker"];
      if (worker !== null && (typeof worker !== "string" || !ctx.store.listRunners().some(one => one.name === worker && one.retiredAt === null))) {
        return { ok: false, message: "worker must be a registered, active worker name, or null for the shared queue" };
      }
      const seen = ctx.store.transact(() => ({ queueRevision: ctx.store.queueRevision(), position: ctx.store.queuePosition(taskId) }));
      if (seen.position === null) return { ok: false, message: "that task is not queued" };
      if ((seen.position.column ?? null) === worker) return { ok: false, message: "that task is already in that column" };
      const id = ctx.draft("reserve", { task: taskId, repoId: ref.repoId, worker, queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "reserve", task: taskId, worker, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_hold",
    description: "Propose holding a task's next attempt, with a reason. A running attempt is never interrupted. The operator confirms.",
    inputSchema: schema({ task: TASK_ARG, reason: { type: "string", maxLength: 200 } }, ["task", "reason"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      if (!honest(args["reason"], 200)) return { ok: false, message: "reason is plain text ≤200" };
      // The operator's existing hold, if any, is the CAS material (finding
      // 10): a hold placed by hand after this proposal must not be
      // overwritten by model text when the stale card is confirmed.
      const existing = ctx.store.activeHolds(ref.id, ctx.now).find(one => one.ownerKind === "operator");
      const id = ctx.draft("hold", { task: taskId, repoId: ref.repoId, reason: args["reason"], sawHold: existing?.id ?? null });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "hold", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_unhold",
    description: "Propose lifting the operator's own hold on a task. Holds owned by a decision or an incident clear on their own. The operator confirms.",
    inputSchema: schema({ task: TASK_ARG }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      const hold = ctx.store.activeHolds(ref.id, ctx.now).find(one => one.ownerKind === "operator");
      if (hold === undefined) return { ok: false, message: "the operator holds no hold on that task" };
      const id = ctx.draft("unhold", { task: taskId, repoId: ref.repoId, holdId: hold.id });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "unhold", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_scope",
    description:
      "Propose rewriting a task's scope (goal, what not to do, paths it may touch). The operator confirms the rewrite, then approves it with a password — a scope you wrote never approves itself.",
    inputSchema: schema(
      { task: TASK_ARG, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } },
      ["task", "goal"],
    ),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      if (!honest(args["goal"], 2_000)) return { ok: false, message: "goal is plain text ≤2000" };
      const not = readOptionalText(args["not"], 2_000);
      if (not === undefined) return { ok: false, message: "not is plain text ≤2000" };
      const touches = readTouches(args["touches"]);
      if (touches === null) return { ok: false, message: "touches is up to 50 plain paths" };
      if (ctx.store.hasLiveClaim(ref.id, ctx.now)) return { ok: false, message: "a worker is building that task right now — its scope cannot change under it" };
      const scope = ctx.store.getScope(taskId);
      const id = ctx.draft("scope", { task: taskId, repoId: ref.repoId, goal: args["goal"], not, touches, sawDigest: scope?.digest ?? null });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "scope", task: taskId, awaiting: "the operator's confirmation, then a password to approve" } };
    },
  },
  {
    name: "propose_cancel",
    description: "Propose cancelling a task, with a reason. The operator arms and confirms it themselves; this only points at it.",
    inputSchema: schema({ task: TASK_ARG, reason: { type: "string", maxLength: 200 } }, ["task", "reason"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      if (!honest(args["reason"], 200)) return { ok: false, message: "reason is plain text ≤200" };
      const id = ctx.draft("cancel", { task: taskId, repoId: ref.repoId, reason: args["reason"] });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "cancel", task: taskId, awaiting: "the operator arming the cancel" } };
    },
  },
];

export const MATE_TOOL_SCHEMAS: MateToolSchema[] = MATE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export function isMateTool(name: string): boolean {
  return MATE_TOOLS.some(one => one.name === name);
}

/** Run one tool and pass its whole result — body or refusal — through `mateView`. Never throws. */
export function executeMateTool(ctx: MateToolContext, name: string, args: Record<string, unknown>, view?: MateViewContext): MateToolResult {
  const tool = MATE_TOOLS.find(one => one.name === name);
  const scrub = view ?? mateViewContextFor(ctx.store, ctx.who);
  if (tool === undefined) return { ok: false, message: `no tool named ${redactForMate(name, scrub)}` };
  let result: MateToolResult;
  try {
    result = tool.handle(ctx, args);
  } catch {
    result = { ok: false, message: "that tool refused — the plane could not answer it right now" };
  }
  return mateView(result, scrub);
}

/** Bytes of a serialized tool result as it will sit inside the request body. */
export function toolResultBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}
