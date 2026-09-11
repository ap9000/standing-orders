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
import { readVerifiedReport, scanForSecrets } from "./evidence.js";
import { parseAcceptanceCriteria, ACCEPTANCE_LIMITS, EVIDENCE_KINDS, type AcceptanceCriterion } from "./scope.js";
import { diagnoseTaskDispatch, withDispatchDiagnoses } from "./dispatch.js";
import { agentChoicesFor, routeOfTask } from "./agentconfig.js";
import { agentsSummary, chosenWords, isRiskLevel, PHASES, postureWords, RISK_CHOICES, riskConsequence, riskTitle, routeProblems, sameSpec, specWords, type PhaseRoute } from "./phase-routing.js";
import type { Phase } from "./provider.js";

export const MATE_MAX_PROPOSALS_PER_TURN = 5;

export type MateToolContext = {
  store: Store;
  who: VerifiedApprover;
  now: Date;
  /** Records a proposal as `drafting` under the running turn; null when the turn may draft no more. */
  draft: (kind: MateProposalKind, payload: Record<string, unknown>) => number | null;
  /** The step this call runs in, and which decisions were read (by get_decision) at which step —
   * an answer may be proposed only for a decision read in an EARLIER step (v3 review, finding 6). */
  step: number;
  readDecisions: Map<number, number>;
  /** Where evidence lives, when the surface knows — a scout's report reads from here. */
  evidenceRoot?: string;
};

export type MateToolResult = { ok: true; body: unknown } | { ok: false; message: string };

/** The report a scout delivered, for get_task: title, summary, follow-ups —
 * verified before it is read; the document itself stays on the task page. */
export function reportSummaryFor(
  store: Store,
  evidenceRoot: string | undefined,
  taskRef: number,
): { title: string; summary: string; followUps: { title: string; goal: string }[] } | { problem: string } | null {
  if (store.latestReportArtifact(taskRef) === null) return null;
  if (evidenceRoot === undefined) return { problem: "a report exists, but this surface cannot read evidence" };
  const view = readVerifiedReport(store, evidenceRoot, taskRef);
  if (view === null) return null;
  if (!view.ok) return { problem: view.problem };
  return { title: view.report.title, summary: view.report.summary, followUps: view.report.followUps };
}

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

/** The same text rule, for the gateway's proposals. */
export function honestText(value: unknown, maxChars: number): value is string {
  return honest(value, maxChars);
}

export function readOptionalText(value: unknown, maxChars: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  return honest(value, maxChars) ? value : undefined;
}

export function readTouches(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(one => honest(one, 200))) return null;
  return value as string[];
}

/** v39: the rubric a mate or coordinator proposal drafts — mandatory,
 * parsed the same way every other authoring road parses one. `null` means
 * the argument did not even parse into a non-empty rubric. */
export function readAcceptanceArg(value: unknown): AcceptanceCriterion[] | null {
  const parsed = parseAcceptanceCriteria(value);
  if (parsed.problems.length > 0 || parsed.criteria.length === 0) return null;
  return parsed.criteria;
}

const ACCEPTANCE_ARG_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: ACCEPTANCE_LIMITS.criteria,
  items: {
    type: "object",
    properties: {
      id: { type: "string", maxLength: ACCEPTANCE_LIMITS.id },
      statement: { type: "string", maxLength: ACCEPTANCE_LIMITS.statement },
      evidence: { type: "array", minItems: 1, items: { type: "string", enum: [...EVIDENCE_KINDS] } },
      how: { type: ["string", "null"], maxLength: ACCEPTANCE_LIMITS.how },
    },
    required: ["id", "statement", "evidence"],
    additionalProperties: false,
  },
} as const;

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

// ------------------------------------------------- shared queries (§2)
// The one set of queries both the mate and the MCP gateway read. Every
// row names its repo by INDEX into the caller's admitted list; the view
// then labels it — `rN` for the mate, the path for a coordinator whose
// allowlist is its authority. Consequences and recommendations are never
// read here at all.

/** Replace every `repoIndex` with a `repo` label, recursively. */
export function labelRepos<T>(value: T, label: (index: number) => string): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(node)) {
        if (key === "repoIndex" && typeof inner === "number") out["repo"] = label(inner);
        else out[key] = walk(inner);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

export function recapOver(store: Store, repos: readonly string[], now: Date, since: string | null): Record<string, unknown> {
  // Ages arrive rounded to the hour, so the horizon is inclusive by half an
  // hour: a row newer than `since` is never dropped (finding 8).
  const horizonHours = since === null ? Infinity : Math.max(0, (now.getTime() - Date.parse(since)) / 3_600_000) + 0.5;
  const snapshot = store.chatSnapshot(repos, now);
  const recent = <T extends { ageHours: number }>(rows: T[]): T[] => rows.filter(one => one.ageHours <= horizonHours);
  const tasks = recent(snapshot.tasks);
  const decisions = recent(snapshot.decisions);
  const incidents = recent(snapshot.incidents);
  const awaitingApproval = snapshot.tasks.filter(one => one.state === "queued" && scopeStandingOf(store, one.id) !== "approved");
  const perRepo = repos.map((_, index) => {
    const mine = <T extends { repoIndex: number }>(rows: T[]): T[] => rows.filter(one => one.repoIndex === index);
    return {
      repoIndex: index,
      waitsOnYou: { decisions: mine(decisions).length, incidents: mine(incidents).length, scopesAwaitingApproval: mine(awaitingApproval).length },
      running: mine(tasks).filter(one => one.state === "running").length,
      queued: mine(snapshot.tasks).filter(one => one.state === "queued").length,
      finished: mine(tasks).filter(one => one.state === "done").length,
      failed: mine(tasks).filter(one => one.state === "failed").length,
      // v39: a finished task whose proof is short or refuted reads as
      // waiting on you too — the same split the inbox and board make.
      needsVerification: mine(tasks).filter(one => one.state === "done" && (one.proofVerdict === "short" || one.proofVerdict === "refuted")).length,
    };
  });
  return {
    since,
    repos: perRepo,
    waitsOnYou: {
      decisions: decisions.map(one => ({ repoIndex: one.repoIndex, decision: one.id, task: one.taskId })),
      incidents: incidents.length,
      scopesAwaitingApproval: awaitingApproval.map(one => ({ repoIndex: one.repoIndex, task: one.id })),
    },
    running: tasks.filter(one => one.state === "running").map(one => ({ repoIndex: one.repoIndex, task: one.id, title: one.title })),
    truncated: snapshot.tasksSaturated || snapshot.decisionsSaturated || snapshot.incidentsSaturated,
  };
}

export function decisionsOver(store: Store, repos: readonly string[], now: Date): Record<string, unknown> {
  const snapshot = store.chatSnapshot(repos, now);
  return {
    decisions: snapshot.decisions.map(one => ({ repoIndex: one.repoIndex, decision: one.id, task: one.taskId, question: one.question, options: one.options, ageHours: one.ageHours })),
    truncated: snapshot.decisionsSaturated,
  };
}

/**
 * One decision as a proposer may read it (mate arc v3, rule change #3):
 * the question, each option's id, label, reversibility, and consequence —
 * never the recap or the builder's recommendation. `repoIndex` names the
 * task's repo for the view; a decision outside `repos` is null.
 */
export function decisionOver(store: Store, repos: readonly string[], decisionId: number, now: Date): Record<string, unknown> | null {
  const decision = store.getDecision(decisionId);
  if (decision === null) return null;
  const run = store.getRun(decision.run);
  const ref = run === null ? null : store.refById(run.taskRef);
  if (ref === null || ref.repo === null) return null;
  const repoIndex = repos.indexOf(ref.repo);
  if (repoIndex === -1) return null;
  // "Open" is derived, not stored (v3 review, finding 7): a decision past
  // its deadline is expired here whether or not the sweep has run.
  const state = decision.state === "open" && decision.deadline !== null && Date.parse(decision.deadline) <= now.getTime() ? "expired" : decision.state;
  return {
    repoIndex,
    decision: decision.id,
    task: ref.externalId,
    state,
    question: decision.question,
    options: decision.options.map(one => ({ id: one.id, label: one.label, reversible: one.reversible, consequence: one.consequence })),
    ageHours: Math.max(0, Math.round((now.getTime() - Date.parse(decision.createdAt)) / 3_600_000)),
  };
}

export function queueOver(store: Store, repo: string, now: Date): Record<string, unknown> {
  const rows = store.queueScoped(repo, now).filter(one => one.repo === repo);
  const columns = new Map<string, { position: number; task: string; title: string; approved: boolean; blockers: unknown; beingTaken: boolean; dispatch: ReturnType<typeof diagnoseTaskDispatch> }[]>();
  for (const one of rows) {
    const column = one.assignedRunner ?? "shared";
    const list = columns.get(column) ?? [];
    list.push({ position: list.length + 1, task: one.id, title: one.title, approved: one.approved, blockers: one.blockers, beingTaken: one.taken, dispatch: diagnoseTaskDispatch(store, one.id, now) });
    columns.set(column, list);
  }
  const ordered = [...columns.entries()].sort(([a], [b]) => (a === "shared" ? -1 : b === "shared" ? 1 : a.localeCompare(b)));
  return { queueRevision: store.queueRevision(), columns: ordered.map(([column, tasks]) => ({ column, tasks })) };
}

export const ISO_STAMP_RULE = ISO_STAMP;

/** Whether a queued task's scope stands approved as written. */
function scopeStandingOf(store: Store, taskId: string): "none" | "approved" | "rewritten since its approval" | "not approved" {
  const scope = store.getScope(taskId);
  if (scope === null) return "none";
  if (scope.approvedAt !== null && scope.approvedDigest === scope.digest) return "approved";
  return scope.approvedAt !== null ? "rewritten since its approval" : "not approved";
}

const ROLE_WORD: Record<Phase, string> = { plan: "planner", build: "builder", repair: "repair", review: "reviewer" };
const ROLE_OF_WORD: Record<string, Phase> = { planner: "plan", plan: "plan", builder: "build", build: "build", repair: "repair", reviewer: "review", review: "review" };

/**
 * THE AGENTS A TASK RUNS UNDER, as chat reads them (v48): the declared
 * risk and what it means, the same one-line summary the task page and CLI
 * print, each role's exact agent with its reasons, the standing of those
 * agents (approved / awaiting approval / recommended), and — for a
 * proposal — only the configured, role-valid choices an operator could
 * pick. Nothing here is a term chat may bind on its own; every change goes
 * through a confirmed card into the one authenticated edit transaction.
 */
export function agentsOver(store: Store, taskId: string, now: Date): Record<string, unknown> | null {
  const ref = store.lookupRef(taskId);
  if (ref === null) return null;
  const routed = routeOfTask(store, taskId, ref, now);
  const scope = store.getScope(taskId);
  const risk = ref.riskLevel ?? scope?.riskLevel ?? "routine";
  const editable = !store.hasLiveClaim(ref.id, now) && store.activeTournamentTerms(ref.id) === null;
  const editableWhy = store.hasLiveClaim(ref.id, now) ? "this task is running — its agents cannot change under a live claim" : store.activeTournamentTerms(ref.id) !== null ? "tournament terms decide the agents while the contest is open" : null;
  const base = {
    task: taskId,
    risk: { level: risk, title: riskTitle(risk), consequence: riskConsequence(risk) },
    riskChoices: RISK_CHOICES.map(one => ({ risk: one.risk, title: one.title, consequence: one.consequence })),
    editable,
    editableWhy,
    approval: scope === null ? "none" : scopeStandingOf(store, taskId),
  };
  if (routed === null) return { ...base, standing: "no agents yet", summary: null, agents: [], choices: {} };
  if (routed.kind === "legacy") {
    return { ...base, standing: routed.approved ? "approved before agent routing" : "not approved", summary: `${routed.profile.provider} · ${routed.profile.model} builds and repairs; the planner and reviewer come from configuration at run time`, agents: [], choices: {} };
  }
  if (routed.kind === "unreadable") return { ...base, standing: "cannot be read", summary: null, problem: routed.problem, agents: [], choices: {} };
  const route: PhaseRoute = routed.route;
  const choices = agentChoicesFor(store, ref.repo, route);
  return {
    ...base,
    standing: routed.source === "approved" ? "approved" : routed.source === "proposed" ? "awaiting approval" : "recommended",
    summary: agentsSummary(route),
    posture: postureWords(route),
    demands: route.demands,
    agents: route.legs.map(leg => ({ role: ROLE_WORD[leg.phase], provider: leg.provider, model: leg.model, chosen: chosenWords(leg), reasons: leg.reasons, problem: leg.problem })),
    problems: routeProblems(route),
    // Only SELECTABLE choices are offered to the mate: a current agent the
    // configuration no longer names appears under `agents` (what runs
    // today) and nowhere a proposal could pick it.
    choices: Object.fromEntries(PHASES.map(phase => [ROLE_WORD[phase], choices[phase].filter(one => one.selectable).map(one => ({ provider: one.provider, model: one.model, current: one.current }))])),
  };
}

export const MATE_TOOLS: MateTool[] = [
  {
    name: "recap",
    description:
      "How things stand per project, counts and ids only: what waits on the operator (decisions, incidents, scopes awaiting approval), what runs, what is queued, what finished and what failed. Pass `since` (an ISO timestamp) to count only decisions, incidents, and attempts newer than it, to the hour; queued work and scopes awaiting approval are current standing and always count. Call this first when asked how things stand.",
    inputSchema: schema({ since: { type: "string", maxLength: 30 } }),
    handle: (ctx, args) => {
      const since = args["since"];
      if (since !== undefined && (typeof since !== "string" || !ISO_STAMP.test(since) || Number.isNaN(Date.parse(since)))) {
        return { ok: false, message: "since is an ISO timestamp like 2026-09-02T12:00:00Z" };
      }
      return { ok: true, body: labelRepos(recapOver(ctx.store, ctx.who.repos, ctx.now, typeof since === "string" ? since : null), index => `r${index + 1}`) };
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
      const snapshot = withDispatchDiagnoses(ctx.store, ctx.store.chatSnapshot(ctx.who.repos, ctx.now), ctx.now);
      const limit = typeof args["limit"] === "number" ? Math.min(50, Math.max(1, Math.floor(args["limit"]))) : 20;
      const rows = snapshot.tasks
        .filter(one => (repo === null || ctx.who.repos[one.repoIndex] === repo) && (args["state"] === undefined || one.state === args["state"]))
        .slice(0, limit)
        .map(one => ({ repo: `r${one.repoIndex + 1}`, task: one.id, title: one.title, state: one.state, ageHours: one.ageHours, strikes: one.strikes, dispatch: one.dispatch ?? null }));
      return { ok: true, body: { tasks: rows, truncated: snapshot.tasksSaturated } };
    },
  },
  {
    name: "get_task",
    description:
      "One task: its state, dispatch diagnosis, dependencies, deliverable (branch or report), scope standing (none / not approved / rewritten since approval / approved), queue place, holds, attempts, its own open decisions, and — for a finished scout — the report's title, summary, and follow-ups. Never its scope text or paths. Read this before proposing a dependency repair.",
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
          dispatch: diagnoseTaskDispatch(ctx.store, taskId, ctx.now),
          dependencies: ctx.store.blockers(taskId).map(blocker => {
            const blockerRef = admittedRef(ctx, blocker);
            const state = blockerRef === null ? null : ctx.store.getTask(blocker)?.state ?? null;
            return { task: blocker, state };
          }),
          deliverable: ctx.store.refForId(ref.id)?.deliverable ?? "branch",
          report: reportSummaryFor(ctx.store, ctx.evidenceRoot, ref.id),
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
    name: "get_agents",
    description:
      "Which agents plan, build, repair, and review one task, and why: the declared risk with what each risk level does, one plain summary, each role's exact agent (provider and model) with its reasons, whether those agents are approved, and — per role — the only configured agents the operator could switch to. Read this before propose_agents, and use it to answer any question about a task's agents or risk.",
    inputSchema: schema({ task: TASK_ARG }, ["task"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      if (taskId === null) return { ok: false, message: "task is an id, 1-64 characters" };
      const ref = admittedRef(ctx, taskId);
      if (ref === null) return notFound();
      const view = agentsOver(ctx.store, taskId, ctx.now);
      if (view === null) return notFound();
      return { ok: true, body: { repo: ref.repoId, ...view } };
    },
  },
  {
    name: "list_decisions",
    description:
      "Open decisions across your projects: id, task, question, the options (id, label, whether reversible), age in hours. Never consequences or recommendations — you do not choose; the operator answers on the decision page.",
    inputSchema: schema({}),
    handle: ctx => ({ ok: true, body: labelRepos(decisionsOver(ctx.store, ctx.who.repos, ctx.now), index => `r${index + 1}`) }),
  },
  {
    name: "get_decision",
    description:
      "One open decision in full: the question and every option with its id, label, whether it is reversible, and its consequence. Never the builder's recommendation. Read this before propose_answer.",
    inputSchema: schema({ decision: { type: "integer", minimum: 1 } }, ["decision"]),
    handle: (ctx, args) => {
      const id = args["decision"];
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return { ok: false, message: "decision is its id" };
      const found = decisionOver(ctx.store, ctx.who.repos, id, ctx.now);
      if (found === null) return { ok: false, message: "not-found: no such decision in your projects" };
      ctx.readDecisions.set(id, ctx.step);
      return { ok: true, body: labelRepos(found, index => `r${index + 1}`) };
    },
  },
  {
    name: "queue",
    description: "One project's queue by column — the shared column, then each worker's reserved column — each in its own dispatch order.",
    inputSchema: schema({ repo: REPO_ARG }, ["repo"]),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      return { ok: true, body: { repo: args["repo"], ...queueOver(ctx.store, repo, ctx.now) } };
    },
  },
  {
    name: "propose_task",
    description: "Propose filing a new task from a plain-language outcome. Infer routine fields instead of asking for them. It becomes a card the operator confirms; nothing is filed until then. planning chooses repository inspection before approval: required for broad/risky work, skip only when explicitly requested for a small direct change, otherwise auto. report: true proposes a SCOUT task — a read-only investigation whose only deliverable is a report, never a branch.",
    inputSchema: schema(
      { repo: REPO_ARG, title: { type: "string", maxLength: 200 }, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 }, acceptance: ACCEPTANCE_ARG_SCHEMA, planning: { type: "string", enum: ["auto", "required", "skip"] }, report: { type: "boolean" } },
      ["repo", "title", "goal", "acceptance"],
    ),
    handle: (ctx, args) => {
      const repo = repoPathOf(ctx.who, args["repo"]);
      if (repo === null) return { ok: false, message: "repo must be one of the ids from list_repos" };
      if (!honest(args["title"], 200) || !honest(args["goal"], 2_000)) return { ok: false, message: "title (≤200) and goal (≤2000) are plain text" };
      const not = readOptionalText(args["not"], 2_000);
      if (not === undefined) return { ok: false, message: "not is plain text ≤2000" };
      const touches = readTouches(args["touches"]);
      if (touches === null) return { ok: false, message: "touches is up to 50 plain paths" };
      const acceptance = readAcceptanceArg(args["acceptance"]);
      if (acceptance === null) return { ok: false, message: "acceptance is required: at least one criterion with an id, statement, and evidence kinds" };
      const planning = args["planning"] ?? "auto";
      if (planning !== "auto" && planning !== "required" && planning !== "skip") return { ok: false, message: "planning is auto, required, or skip" };
      if (args["report"] !== undefined && typeof args["report"] !== "boolean") return { ok: false, message: "report is true or false" };
      const report = args["report"] === true;
      const id = ctx.draft("task", { repo, repoId: args["repo"], title: args["title"], goal: args["goal"], not, touches, acceptance, planning, report });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "task", repo: args["repo"], deliverable: report ? "report" : "branch", planning: report ? "not needed for a scout" : planning, awaiting: "the operator's confirmation" } };
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
    name: "propose_steer",
    description:
      "Propose guidance for a task's next attempt. The note refines priorities without changing the task's scope and never interrupts a running attempt. The operator confirms because the note will speak in their voice.",
    inputSchema: schema({ task: TASK_ARG, note: { type: "string", maxLength: 2_000 } }, ["task", "note"]),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      const task = taskId === null ? null : ctx.store.getTask(taskId);
      if (taskId === null || ref === null || task === null) return notFound();
      if (!honest(args["note"], 2_000)) return { ok: false, message: "guidance is plain text up to 2,000 characters" };
      if (task.state === "done" || task.state === "cancelled") return { ok: false, message: "that task is finished, so guidance has no next attempt to reach" };
      if (ctx.store.openContestFor(ref.id) !== null) return { ok: false, message: "agents are racing on that task — wait until the comparison finishes" };
      const id = ctx.draft("steer", { task: taskId, taskTitle: task.title, repoId: ref.repoId, note: args["note"] });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "steer", task: taskId, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_dependency_repair",
    description:
      "Propose repairing a task stranded behind a failed or cancelled dependency. Read the dependent task with get_task first, then choose: retry (failed blocker only), unlink, or replace (replacement required). The operator sees the exact graph change and confirms it; nothing is changed by this tool.",
    inputSchema: schema(
      {
        task: TASK_ARG,
        blocker: TASK_ARG,
        operation: { type: "string", enum: ["retry", "unlink", "replace"] },
        replacement: TASK_ARG,
      },
      ["task", "blocker", "operation"],
    ),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      if (taskId === null || ref === null) return notFound();
      const blocker = typeof args["blocker"] === "string" && TASK_ID.test(args["blocker"]) ? args["blocker"] : null;
      if (blocker === null || !ctx.store.blockers(taskId).includes(blocker)) {
        return { ok: false, message: "that task is no longer waiting for the selected work — read it again with get_task" };
      }
      const blockedBy = ctx.store.getTask(blocker);
      if (blockedBy === null || (blockedBy.state !== "failed" && blockedBy.state !== "cancelled")) {
        return { ok: false, message: "the task it was waiting for is no longer failed or cancelled — read the task again" };
      }
      const operation = args["operation"];
      if (operation !== "retry" && operation !== "unlink" && operation !== "replace") {
        return { ok: false, message: "choose try again, wait for another task, or continue without it" };
      }
      if (operation === "retry") {
        if (blockedBy.state !== "failed") return { ok: false, message: "only failed work can be tried again; wait for a different task or continue without cancelled work" };
        if (admittedRef(ctx, blocker) === null) return { ok: false, message: "the failed task is outside this conversation's projects" };
      }
      let replacement: string | null = null;
      let replacementTitle: string | null = null;
      if (operation === "replace") {
        replacement = typeof args["replacement"] === "string" && TASK_ID.test(args["replacement"]) ? args["replacement"] : null;
        const replacementRef = replacement === null ? null : admittedRef(ctx, replacement);
        const replacementTask = replacement === null ? null : ctx.store.getTask(replacement);
        if (replacement === null || replacementRef === null || replacementTask === null) return { ok: false, message: "choose another task from this conversation's projects" };
        if (replacement === taskId || replacement === blocker || (replacementTask.state !== "queued" && replacementTask.state !== "running")) {
          return { ok: false, message: "choose different, unfinished work that can still complete" };
        }
        replacementTitle = replacementTask.title;
      } else if (args["replacement"] !== undefined) {
        return { ok: false, message: "only include another task when this one should wait for it" };
      }
      const id = ctx.draft("repair", {
        task: taskId,
        taskTitle: ctx.store.getTask(taskId)?.title ?? taskId,
        repoId: ref.repoId,
        blocker,
        blockerTitle: blockedBy.title,
        operation,
        sawBlockerState: blockedBy.state,
        ...(replacement === null ? {} : { replacement, replacementTitle }),
      });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "repair", task: taskId, blocker, operation, awaiting: "the operator's confirmation" } };
    },
  },
  {
    name: "propose_scope",
    description:
      "Propose rewriting a task's scope (goal, what not to do, paths it may touch). The operator confirms the rewrite, then approves it with a password — a scope you wrote never approves itself.",
    inputSchema: schema(
      { task: TASK_ARG, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 }, acceptance: ACCEPTANCE_ARG_SCHEMA },
      ["task", "goal", "acceptance"],
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
      const acceptance = readAcceptanceArg(args["acceptance"]);
      if (acceptance === null) return { ok: false, message: "acceptance is required: at least one criterion with an id, statement, and evidence kinds" };
      if (ctx.store.hasLiveClaim(ref.id, ctx.now)) return { ok: false, message: "a worker is building that task right now — its scope cannot change under it" };
      const scope = ctx.store.getScope(taskId);
      const id = ctx.draft("scope", { task: taskId, repoId: ref.repoId, goal: args["goal"], not, touches, acceptance, sawDigest: scope?.digest ?? null });
      if (id === null) return tooMany();
      return { ok: true, body: { proposal: id, kind: "scope", task: taskId, awaiting: "the operator's confirmation, then a password to approve" } };
    },
  },
  {
    name: "propose_agents",
    description:
      "Propose changing a task's declared risk, or which configured agent runs one role (planner, builder, repair, or reviewer), or clearing an earlier per-role choice. Read get_agents first: `agent` must be one of that role's listed choices, exactly (provider and model) — nothing unconfigured can be proposed. The operator confirms the card; the change is then recorded under their name and any approval given under the earlier agents must be renewed. Never changes a running task.",
    inputSchema: schema(
      {
        task: TASK_ARG,
        risk: { type: "string", enum: ["routine", "elevated", "high"] },
        role: { type: "string", enum: ["planner", "builder", "repair", "reviewer"] },
        agent: schema({ provider: { type: "string", maxLength: 20 }, model: { type: "string", maxLength: 120 } }, ["provider", "model"]),
        clear: { type: "boolean" },
        why: { type: "string", maxLength: 400 },
      },
      ["task"],
    ),
    handle: (ctx, args) => {
      const taskId = taskIdOf(args);
      const ref = taskId === null ? null : admittedRef(ctx, taskId);
      const task = taskId === null ? null : ctx.store.getTask(taskId);
      if (taskId === null || ref === null || task === null) return notFound();
      const risk = args["risk"];
      if (risk !== undefined && !isRiskLevel(risk)) return { ok: false, message: "risk is routine, elevated, or high" };
      const roleWord = args["role"];
      const phase = roleWord === undefined ? null : typeof roleWord === "string" ? ROLE_OF_WORD[roleWord] ?? null : null;
      if (roleWord !== undefined && phase === null) return { ok: false, message: "role is planner, builder, repair, or reviewer" };
      const clear = args["clear"] === true;
      const agent = args["agent"];
      if (risk === undefined && phase === null) return { ok: false, message: "say what changes: a risk, or a role with an agent (or clear: true)" };
      if (phase !== null && !clear && (agent === null || typeof agent !== "object")) return { ok: false, message: "a role change names an agent from get_agents, or clear: true" };
      if (phase === null && (clear || agent !== undefined)) return { ok: false, message: "an agent or clear needs the role it applies to" };
      if (args["why"] !== undefined && !honest(args["why"], 400)) return { ok: false, message: "why is plain text ≤400" };
      if (ctx.store.hasLiveClaim(ref.id, ctx.now)) return { ok: false, message: "a worker is building that task right now — its agents cannot change under it" };
      if (ctx.store.activeTournamentTerms(ref.id) !== null) return { ok: false, message: "tournament terms decide this task's agents while the contest is open" };
      const view = agentsOver(ctx.store, taskId, ctx.now);
      if (view === null) return notFound();
      const scope = ctx.store.getScope(taskId);
      const current = ctx.store.refForId(ref.id);
      let chosen: { provider: string; model: string } | null = null;
      if (phase !== null && !clear) {
        const wanted = agent as Record<string, unknown>;
        const offered = ((view["choices"] as Record<string, { provider: string; model: string }[]>)[ROLE_WORD[phase]] ?? []);
        const match = offered.find(one => one.provider === wanted["provider"] && one.model === wanted["model"]);
        if (match === undefined) {
          return {
            ok: false,
            message: offered.length === 0
              ? `no configured agent can run the ${ROLE_WORD[phase]} role for this task — the operator configures agents first`
              : `agent must be one of the ${ROLE_WORD[phase]} choices from get_agents: ${offered.map(one => specWords(one)).join(", ")}`,
          };
        }
        chosen = { provider: match.provider, model: match.model };
        const currentLeg = (view["agents"] as { role: string; provider: string; model: string }[]).find(one => one.role === ROLE_WORD[phase]);
        if (currentLeg !== undefined && sameSpec(currentLeg, chosen) && risk === undefined) return { ok: false, message: `${specWords(chosen)} already runs the ${ROLE_WORD[phase]} role` };
      }
      if (phase !== null && clear && !(current?.routeOverrides ?? []).some(one => one.phase === phase)) {
        return { ok: false, message: `nobody chose a ${ROLE_WORD[phase]} for this task by hand — there is nothing to clear` };
      }
      if (risk !== undefined && phase === null && risk === (view["risk"] as { level: string }).level) return { ok: false, message: `this task is already declared ${riskTitle(risk).toLowerCase()}` };
      const id = ctx.draft("agents", {
        task: taskId,
        taskTitle: task.title,
        repoId: ref.repoId,
        ...(risk === undefined ? {} : { risk, riskConsequence: riskConsequence(risk) }),
        ...(phase === null ? {} : { phase, role: ROLE_WORD[phase] }),
        ...(chosen === null ? {} : { provider: chosen.provider, model: chosen.model }),
        ...(clear ? { clear: true } : {}),
        ...(typeof args["why"] === "string" ? { why: args["why"] } : {}),
        before: view["summary"] ?? null,
        approval: view["approval"],
        sawDigest: scope?.digest ?? null,
      });
      if (id === null) return tooMany();
      return {
        ok: true,
        body: {
          proposal: id,
          kind: "agents",
          task: taskId,
          ...(risk === undefined ? {} : { risk }),
          ...(phase === null ? {} : { role: ROLE_WORD[phase], ...(chosen === null ? { clear: true } : { agent: chosen }) }),
          awaiting: view["approval"] === "approved" ? "the operator's confirmation — the current approval will then need renewing" : "the operator's confirmation",
        },
      };
    },
  },
  {
    name: "propose_answer",
    description:
      "Propose an answer to an open decision you have read with get_decision, with a short rationale. The operator confirms on a card showing every consequence and the builder's recommendation; an irreversible option needs their explicit confirmation there.",
    inputSchema: schema({ decision: { type: "integer", minimum: 1 }, option: { type: "string", minLength: 1, maxLength: 64 }, rationale: { type: "string", maxLength: 400 } }, ["decision", "option", "rationale"]),
    handle: (ctx, args) => {
      const id = args["decision"];
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return { ok: false, message: "decision is its id" };
      const found = decisionOver(ctx.store, ctx.who.repos, id, ctx.now);
      if (found === null) return { ok: false, message: "not-found: no such decision in your projects" };
      if (found["state"] !== "open") return { ok: false, message: "that decision is no longer open" };
      const readAt = ctx.readDecisions.get(id);
      if (readAt === undefined || readAt >= ctx.step) {
        return { ok: false, message: "read the decision first with get_decision, and propose in a later step — an answer chosen before its consequences arrived is a guess" };
      }
      const options = found["options"] as { id: string; label: string; reversible: boolean }[];
      const chosen = options.find(one => one.id === args["option"]);
      if (chosen === undefined) return { ok: false, message: `option must be one of ${options.map(one => one.id).join(", ")}` };
      if (!honest(args["rationale"], 400)) return { ok: false, message: "rationale is plain text ≤400" };
      const proposalId = ctx.draft("answer", {
        decision: id,
        task: found["task"],
        repoId: `r${(found["repoIndex"] as number) + 1}`,
        option: chosen.id,
        optionLabel: chosen.label,
        reversible: chosen.reversible,
        rationale: args["rationale"],
        readConsequences: true,
      });
      if (proposalId === null) return tooMany();
      return { ok: true, body: { proposal: proposalId, kind: "answer", decision: id, option: chosen.id, awaiting: chosen.reversible ? "the operator's confirmation" : "the operator's explicit confirmation — this option is irreversible" } };
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
