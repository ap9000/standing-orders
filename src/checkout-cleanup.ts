/**
 * Checkout cleanup (Settings → Storage, `toolroll storage clean`): which task checkouts can go, and removing them.
 *
 * A finished task's clean checkout goes as the setting says: when its task is complete or cancelled (the default),
 * 2 days or a week after that, or never (only a clean-up by hand). A clean-up by hand doesn't wait for the setting.
 * Only the working copy goes: its branch, and so every commit, stays, and a later lease of the branch makes a new one.
 *
 * Always kept: a checkout in use, one whose task isn't finished (on hold, failed, a revision under way), a result
 * still waiting for review, a release candidate for a week after it was done (a deploy installs from it), a checkout
 * with changes (files Toolroll wrote itself aside), and one with commits on no branch. A checkout no task names
 * (adopted after a crash) goes only in a clean-up by hand. Every removal is in the ledger.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { taskBranches } from "./names.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { CLEANUP_CHOICES, bytesWords, diskBytes, type CheckoutCleanup } from "./storage.js";
import type { Store, WorktreeRow } from "./store.js";
import { worktreePath, type WorktreePool } from "./worktree.js";

const DAY_MS = 86_400_000;
/** A release candidate's checkout holds the build a deploy installs: kept a week after its task was done. */
export const CANDIDATE_KEEP_MS = 7 * DAY_MS;
/** The worker's pass removes at most this many; a clean-up by hand has no cap. */
export const AUTO_MAX = 20;
/** Git inspections at once. */
const INSPECT_AT_ONCE = 8;

export type KeepWhy =
  | "in use" | "task not finished" | "waiting for review" | "release candidate"
  | "has changes" | "has commits" | "unreadable" | "git refused" | "not due yet" | "cleanup is off" | "no task";

export type CheckoutItem = {
  path: string; repo: string; branch: string; taskId: string | null; bytes: number; releasedAt: string | null;
  /** null: it goes. */
  why: KeepWhy | null;
  /** With "not due yet" or "release candidate": when it may go. */
  dueAt?: string;
};

export type CheckoutPlan = {
  at: string; cleanup: CheckoutCleanup; manual: boolean;
  go: CheckoutItem[]; stay: CheckoutItem[];
  /** Every checkout on disk. */
  count: number; totalBytes: number; freeBytes: number;
  waitingReview: number; withChanges: number;
};

type Status = { keep: KeepWhy | null; taskId: string; finishedAt: string | null; dueAt?: string };
const STRENGTH: Record<string, number> = { "in use": 5, "task not finished": 4, "waiting for review": 3, "release candidate": 2 };
const strength = (one: Status | undefined) => one === undefined ? -1 : one.keep === null ? 0 : STRENGTH[one.keep] ?? 1;
const stronger = (a: Status | undefined, b: Status | undefined) =>
  strength(b) > strength(a) || (strength(b) === 0 && strength(a) === 0 && (b!.finishedAt ?? "") > (a!.finishedAt ?? "")) ? b : a;

/** Where every task stands for cleanup, by task_ref id and by each branch it or its runs used. */
export function taskStatuses(store: Store, now: Date): { byRef: Map<number, Status>; byBranch: Map<string, Status> } {
  const db = store.handle;
  const refs = db.prepare(`SELECT r.id AS ref, r.external_id AS id, r.revision_of AS revision_of, t.state AS state, t.updated_at AS updated_at,
      EXISTS (SELECT 1 FROM hold h WHERE h.task_ref = r.id) AS held,
      EXISTS (SELECT 1 FROM run live WHERE live.task_ref = r.id AND live.finished_at IS NULL) AS live,
      EXISTS (SELECT 1 FROM task_scope s WHERE s.task_id = r.external_id AND s.candidate IS NOT NULL) AS candidate
    FROM task_ref r LEFT JOIN task t ON t.id = r.external_id AND r.backend = 'built-in'`).all();
  const runs = db.prepare("SELECT id, task_ref, branch FROM run").all();
  const refOfRun = new Map(runs.map(row => [Number(row["id"]), Number(row["task_ref"])]));
  // The completion names its family's root; its run names the result it completes.
  const completed = new Map<string, string>();
  const completedRef = new Map<number, string>();
  for (const row of db.prepare("SELECT task_id, run_id, at FROM action_ledger WHERE action = ?").all(COMPLETION_ACTION)) {
    const at = String(row["at"]);
    if (row["task_id"] !== null) { const id = String(row["task_id"]); if ((completed.get(id) ?? "") < at) completed.set(id, at); }
    const ref = row["run_id"] === null ? undefined : refOfRun.get(Number(row["run_id"]));
    if (ref !== undefined && (completedRef.get(ref) ?? "") < at) completedRef.set(ref, at);
  }
  const byRef = new Map<number, Status>();
  const byId = new Map<string, Status>();
  const parentOf = new Map<string, string>();
  for (const row of refs) {
    const ref = Number(row["ref"]);
    const id = String(row["id"]);
    const state = row["state"] === null ? null : String(row["state"]);
    const updated = row["updated_at"] === null ? null : String(row["updated_at"]);
    let status: Status;
    if (Number(row["live"]) === 1) status = { keep: "in use", taskId: id, finishedAt: null };
    else if (state === null || Number(row["held"]) === 1 || (state !== "done" && state !== "cancelled")) status = { keep: "task not finished", taskId: id, finishedAt: null };
    else if (state === "cancelled") status = { keep: null, taskId: id, finishedAt: updated };
    else {
      const completedAt = [completed.get(id), completedRef.get(ref)].filter((one): one is string => one !== undefined).sort().at(-1) ?? null;
      if (Number(row["candidate"]) === 1) {
        const since = completedAt ?? updated ?? now.toISOString();
        const until = new Date(Date.parse(since) + CANDIDATE_KEEP_MS).toISOString();
        status = until > now.toISOString() ? { keep: "release candidate", taskId: id, finishedAt: since, dueAt: until } : { keep: null, taskId: id, finishedAt: since };
      } else status = completedAt === null ? { keep: "waiting for review", taskId: id, finishedAt: null } : { keep: null, taskId: id, finishedAt: completedAt };
    }
    byRef.set(ref, status);
    byId.set(id, stronger(byId.get(id), status)!);
    if (row["revision_of"] !== null) parentOf.set(id, String(row["revision_of"]));
  }
  // A revision under way keeps what its ancestors worked on: it builds on their branch.
  for (const [id, status] of byId) {
    if (status.keep === null || status.keep === "release candidate") continue;
    const seen = new Set([id]);
    for (let parent = parentOf.get(id); parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      const lifted = { ...status, taskId: parent };
      byId.set(parent, stronger(byId.get(parent), lifted)!);
    }
  }
  for (const row of refs) byRef.set(Number(row["ref"]), stronger(byRef.get(Number(row["ref"])), { ...byId.get(String(row["id"]))!, taskId: String(row["id"]) })!);
  const byBranch = new Map<string, Status>();
  const note = (branch: string, status: Status) => byBranch.set(branch, stronger(byBranch.get(branch), status)!);
  for (const row of refs) for (const branch of taskBranches(String(row["id"]))) note(branch, byRef.get(Number(row["ref"]))!);
  for (const row of runs) {
    if (row["branch"] === null) continue;
    const status = byRef.get(Number(row["task_ref"]));
    if (status !== undefined) note(String(row["branch"]), status);
  }
  return { byRef, byBranch };
}

/** Where one checkout's task stands: by its task, its branch, or (branch unknown) the name a lease of a branch would give it. */
function statusOf(row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>): Status | undefined {
  let found = stronger(row.taskRef === null ? undefined : statuses.byRef.get(row.taskRef), statuses.byBranch.get(row.branch));
  if (found === undefined) {
    const name = basename(row.path);
    for (const [branch, status] of statuses.byBranch) if (basename(worktreePath("/", row.repo, branch)) === name) found = stronger(found, status);
  }
  return found;
}

/** Why a checkout stays before anyone looks at its files, or null: it may go (as far as its task and the setting say). */
function keptFor(pool: WorktreePool, row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>, now: Date, cleanup: CheckoutCleanup | "manual"): { why: KeepWhy | null; dueAt?: string; taskId: string | null } {
  const status = statusOf(row, statuses);
  const taskId = status?.taskId ?? null;
  if (row.releasedAt === null || row.runner !== null || pool.inUse(row.path).held) return { why: "in use", taskId };
  if (status !== undefined && status.keep !== null) return { why: status.keep, taskId, ...(status.dueAt === undefined ? {} : { dueAt: status.dueAt }) };
  if (cleanup === "manual") return { why: null, taskId };
  // A checkout no task names (adopted after a crash, say) has no task to finish: only a clean-up by hand takes it.
  if (status === undefined) return { why: "no task", taskId };
  if (cleanup === "finished") return { why: null, taskId };
  if (cleanup === "never") return { why: "cleanup is off", taskId };
  const days = CLEANUP_CHOICES.find(one => one.value === cleanup)!.days!;
  const since = [status.finishedAt, row.releasedAt].filter((one): one is string => one !== null).sort().at(-1)!;
  const dueAt = new Date(Date.parse(since) + days * DAY_MS).toISOString();
  return dueAt > now.toISOString() ? { why: "not due yet", taskId, dueAt } : { why: null, taskId };
}

async function eachAtMost<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]!); }
  }));
  return out;
}

/**
 * What a clean-up would remove now, how much space it would free, and what stays and why. `manual` is a clean-up by
 * hand (it doesn't wait for the setting); otherwise it is the worker's pass under the setting. Reads only.
 */
export async function checkoutPlan(store: Store, pool: WorktreePool, now: Date, options: { manual: boolean; repo?: string }): Promise<CheckoutPlan> {
  const cleanup = store.checkoutCleanup();
  const rows = store.listWorktrees().filter(row => existsSync(row.path) && (options.repo === undefined || row.repo === options.repo));
  const sizes = diskBytes(rows.map(row => row.path));
  const statuses = taskStatuses(store, now);
  const items = await eachAtMost(rows, INSPECT_AT_ONCE, async (row): Promise<CheckoutItem> => {
    const kept = keptFor(pool, row, statuses, now, options.manual ? "manual" : cleanup);
    let why = kept.why;
    if (why === null) { const found = await pool.inspect(row.path); why = found === "clean" ? null : found; }
    return { path: row.path, repo: row.repo, branch: row.branch, taskId: kept.taskId, bytes: sizes.get(row.path) ?? 0, releasedAt: row.releasedAt, why, ...(kept.dueAt === undefined ? {} : { dueAt: kept.dueAt }) };
  });
  const go = items.filter(one => one.why === null).sort((a, b) => b.bytes - a.bytes);
  const stay = items.filter(one => one.why !== null).sort((a, b) => (a.why ?? "").localeCompare(b.why ?? "") || b.bytes - a.bytes);
  return {
    at: now.toISOString(), cleanup, manual: options.manual, go, stay,
    count: items.length, totalBytes: items.reduce((sum, one) => sum + one.bytes, 0), freeBytes: go.reduce((sum, one) => sum + one.bytes, 0),
    waitingReview: stay.filter(one => one.why === "waiting for review").length, withChanges: stay.filter(one => one.why === "has changes").length,
  };
}

/** Names exactly what a preview would remove, so a confirmation removes that and nothing else. */
export function previewDigest(plan: Pick<CheckoutPlan, "go">): string {
  return createHash("sha256").update(plan.go.map(one => one.path).sort().join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

export type CleanResult = { removed: CheckoutItem[]; kept: { path: string; why: KeepWhy }[]; freed: number };

/**
 * Remove what may go: the worker's pass (`manual` false: under the setting, at most AUTO_MAX, one repository) or a
 * clean-up by hand (no cap, every repository). Each checkout is asked again right before it goes; each removal is in
 * the ledger.
 */
export async function cleanCheckouts(store: Store, pool: WorktreePool, now: () => Date, options: { manual: boolean; actor: string; repo?: string; only?: ReadonlySet<string> }): Promise<CleanResult> {
  const cleanup = store.checkoutCleanup();
  if (!options.manual && cleanup === "never") return { removed: [], kept: [], freed: 0 };
  // `only`: the checkouts a person saw in the preview; nothing they didn't see goes.
  const rows = store.listWorktrees().filter(row => existsSync(row.path) && (options.repo === undefined || row.repo === options.repo) && (options.only === undefined || options.only.has(row.path)));
  let statuses = taskStatuses(store, now());
  const sizes = new Map<string, number>();
  const wanted = (row: WorktreeRow, fresh: boolean): boolean => {
    // Right before a checkout goes, where its task stands is read afresh, and its size taken for the ledger.
    if (fresh) statuses = taskStatuses(store, now());
    const go = keptFor(pool, row, statuses, now(), options.manual ? "manual" : cleanup).why === null;
    if (go && fresh) sizes.set(row.path, diskBytes([row.path]).get(row.path) ?? 0);
    return go;
  };
  const pruned = await pool.prune(rows, wanted, options.manual ? Infinity : AUTO_MAX);
  const removed: CheckoutItem[] = [];
  for (const row of pruned.removed) {
    const taskId = row.taskRef === null ? null : store.externalIdFor(row.taskRef);
    const bytes = sizes.get(row.path) ?? 0;
    removed.push({ path: row.path, repo: row.repo, branch: row.branch, taskId, bytes, releasedAt: row.releasedAt, why: null });
    store.recordAction({ at: now().toISOString(), actor: options.actor, repo: row.repo, taskId, runId: null, action: "checkout removed", outcome: "removed",
      source: options.manual ? "request" : "work", detail: `${basename(row.path)} (released ${row.releasedAt?.slice(0, 10) ?? "?"}, about ${bytesWords(bytes)}); branch ${row.branch} kept` });
  }
  return { removed, kept: pruned.kept, freed: removed.reduce((sum, one) => sum + one.bytes, 0) };
}

/** Throw away a checkout kept for its changes, on purpose; its branch stays. In the ledger. */
export async function discardCheckout(store: Store, pool: WorktreePool, path: string, now: Date, actor: string): Promise<{ ok: true; bytes: number } | { ok: false; message: string }> {
  const bytes = existsSync(path) ? diskBytes([path]).get(path) ?? 0 : 0;
  const done = await pool.discardChanges(path);
  if (!done.ok) return done;
  const taskId = done.row.taskRef === null ? null : store.externalIdFor(done.row.taskRef);
  store.recordAction({ at: now.toISOString(), actor, repo: done.row.repo, taskId, runId: null, action: "checkout discarded", outcome: "removed", source: "request",
    detail: `${basename(path)} and its uncommitted changes (about ${bytesWords(bytes)}); branch ${done.row.branch} kept` });
  return { ok: true, bytes };
}

/** "Waiting for review", "Has changes" … as a sentence fragment for a person. */
export function whyWords(item: Pick<CheckoutItem, "why" | "dueAt">): string {
  switch (item.why) {
    case null: return "goes";
    case "in use": return "in use";
    case "task not finished": return "its task isn't finished";
    case "waiting for review": return "its result is waiting for review";
    case "release candidate": return `release candidate, kept until ${item.dueAt?.slice(0, 10) ?? "a week after"}`;
    case "has changes": return "has changes";
    case "has commits": return "has commits on no branch";
    case "unreadable": return "git couldn't read it";
    case "git refused": return "git wouldn't remove it";
    case "not due yet": return `due ${item.dueAt?.slice(0, 10) ?? "later"}`;
    case "cleanup is off": return "automatic cleanup is off";
    case "no task": return "no task names it; only a clean-up by hand removes it";
  }
}
