/**
 * Checkout cleanup (Settings → Storage, `toolroll storage`): a finished task's clean checkout goes as the setting
 * says (by default when its task is complete or cancelled), its branch stays, Toolroll's own files don't count as a
 * person's work, a clean-up by hand previews first, and every removal is in the ledger.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { run } from "./exec.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { WorktreePool } from "./worktree.js";
import { checkoutPlan, cleanCheckouts, taskStatuses } from "./checkout-cleanup.js";
import { parseCleanup } from "./storage.js";

const DAY = 86_400_000;
let dir: string, file: string, repo: string, store: Store, pool: WorktreePool;
const T0 = new Date(Date.now() - 60_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-cleanup-"));
  file = join(dir, "orders.db");
  repo = join(dir, "repo");
  mkdirSync(repo);
  store = openStore(file);
  register(store, { name: "builder-1", host: "test", now: T0 });
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "first"]);
  pool = new WorktreePool(store, { root: join(dir, "worktrees") });
});
afterEach(() => { try { store.close(); } catch { /* closed by the test */ } rmSync(dir, { recursive: true, force: true }); });

type Finish = "completed" | "ready" | "cancelled" | "queued";
/** A task whose build left a let-go checkout on `toolroll/<id>`, then finished as `finish` says. */
async function task(id: string, finish: Finish, when = T0): Promise<string> {
  store.createTask({ id, title: id }, when);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: `toolroll/${id}`, base: "main", runner: "builder-1", taskRef: ref, now: when });
  if (!leased.ok) throw new Error(leased.message);
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: when });
  store.finishRun(runId, { outcome: "built", now: when });
  expect((await pool.release(leased.worktree.path, when)).ok).toBe(true);
  if (finish === "completed" || finish === "ready") store.setTaskState(id, "done", when);
  if (finish === "cancelled") store.setTaskState(id, "cancelled", when);
  if (finish === "completed") store.recordAction({ at: when.toISOString(), actor: "operator:alex", repo, taskId: id, runId, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  return leased.worktree.path;
}
const branchExists = async (branch: string) => (await run("git", ["branch", "--list", branch], { cwd: repo })).stdout.includes(branch);
const removals = () => store.actionLedger({ repos: null }).filter(one => one.action === "checkout removed");

test("a finished task's clean checkout holding only Toolroll's own progress file is removed, and one with a person's change is kept", async () => {
  const own = await task("progress-only", "completed");
  const person = await task("person-edit", "completed");
  const edited = await task("person-tracked", "completed");
  writeFileSync(join(own, "STANDING-ORDERS-PROGRESS-0123456789abcdef.json"), '{"step":"done"}\n');
  writeFileSync(join(person, "STANDING-ORDERS-PROGRESS-fedcba9876543210.json"), "{}\n");
  writeFileSync(join(person, "notes.txt"), "a person's note\n");
  writeFileSync(join(edited, "README.md"), "changed by hand\n");

  const done = await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo });
  expect(done.removed.map(one => one.path)).toEqual([own]);
  expect(done.kept.map(one => [one.path, one.why]).sort()).toEqual([[edited, "has changes"], [person, "has changes"]].sort());
  expect(existsSync(own)).toBe(false);
  expect(existsSync(join(person, "notes.txt"))).toBe(true);
  expect(existsSync(edited)).toBe(true);
  expect(removals()).toHaveLength(1);
  expect(removals()[0]).toMatchObject({ actor: "worker", taskId: "progress-only", source: "work", repo });
});

test("with the default setting a checkout goes when its task is complete or cancelled, and its branch stays", async () => {
  expect(store.checkoutCleanup()).toBe("finished");
  const completed = await task("shipped", "completed");
  const cancelled = await task("dropped", "cancelled");
  const ready = await task("in-review", "ready");
  const queued = await task("again", "queued");

  const plan = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(plan.go.map(one => one.path).sort()).toEqual([cancelled, completed].sort());
  expect(Object.fromEntries(plan.stay.map(one => [one.path, one.why]))).toEqual({ [ready]: "waiting for review", [queued]: "task not finished" });
  expect(plan.waitingReview).toBe(1);

  const done = await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo });
  expect(done.removed.map(one => one.path).sort()).toEqual([cancelled, completed].sort());
  for (const path of [completed, cancelled]) { expect(existsSync(path)).toBe(false); expect(store.getWorktree(path)).toBeNull(); }
  for (const path of [ready, queued]) expect(existsSync(path)).toBe(true);
  expect(await branchExists("toolroll/shipped")).toBe(true);
  expect(await branchExists("toolroll/dropped")).toBe(true);
  // A later lease of the branch makes a new checkout of it, as it stands.
  expect(await pool.lease({ repo, branch: "toolroll/shipped", base: "main", reuseBranch: true, runner: "builder-1", now: at(2000) })).toMatchObject({ ok: true, created: true });
});

test("after 2 days, after a week, or never: the setting delays or stops the worker's pass, never a clean-up by hand", async () => {
  expect(["finished", "2d", "week", "never", "soon"].map(parseCleanup)).toEqual(["finished", "2d", "7d", "never", undefined]);
  const path = await task("waits", "completed");
  store.setCheckoutCleanup("2d", "alex", T0);
  expect(store.actionLedger({ repos: null }).find(one => one.action === "checkout cleanup changed")).toMatchObject({ source: "policy", actor: "alex",
    detail: "when its task is complete or cancelled → 2 days after its task is complete or cancelled" });
  expect((await checkoutPlan(store, pool, at(DAY), { manual: false })).stay).toMatchObject([{ path, why: "not due yet" }]);
  expect((await cleanCheckouts(store, pool, () => at(DAY), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  store.setCheckoutCleanup("never", "alex", T0);
  expect((await cleanCheckouts(store, pool, () => at(30 * DAY), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  expect((await checkoutPlan(store, pool, at(DAY), { manual: true })).go.map(one => one.path)).toEqual([path]);
  store.setCheckoutCleanup("2d", "alex", T0);
  expect((await cleanCheckouts(store, pool, () => at(2 * DAY + 1000), { manual: false, actor: "worker", repo })).removed.map(one => one.path)).toEqual([path]);
});

test("a checkout with commits on no branch, one in use, and a revision's ancestors under way are kept", async () => {
  const detached = await task("detached", "completed");
  await run("git", ["checkout", "-q", "--detach"], { cwd: detached });
  writeFileSync(join(detached, "late.txt"), "committed after detaching\n");
  await run("git", ["add", "late.txt"], { cwd: detached });
  await run("git", ["commit", "-qm", "detached work"], { cwd: detached });
  const parent = await task("parent", "completed");
  await task("child", "ready");
  store.handle.prepare("UPDATE task_ref SET revision_of = 'parent' WHERE external_id = 'child'").run();
  const busy = await task("busy", "completed");
  const leased = await pool.lease({ repo, branch: "toolroll/busy", runner: "builder-1", now: at(500) });
  expect(leased.ok).toBe(true);

  const plan = await checkoutPlan(store, pool, at(1000), { manual: true });
  expect(Object.fromEntries(plan.stay.map(one => [one.path, one.why]))).toMatchObject({ [detached]: "has commits", [parent]: "waiting for review", [busy]: "in use" });
  expect(plan.go).toEqual([]);
  expect(taskStatuses(store, at(1000)).byBranch.get("toolroll/parent")?.keep).toBe("waiting for review");
});

test("a checkout no task names waits for a clean-up by hand; one whose name an unfinished task's branch would give it stays", async () => {
  const adopt = async (branch: string) => {
    const leased = await pool.lease({ repo, branch, base: "main", runner: "builder-1", now: T0 });
    if (!leased.ok) throw new Error(leased.message);
    expect((await pool.release(leased.worktree.path, T0)).ok).toBe(true);
    // Adopted after a crash: the branch unknown, no task recorded.
    store.saveWorktree({ ...store.getWorktree(leased.worktree.path)!, branch: "unknown", taskRef: null });
    return leased.worktree.path;
  };
  const orphan = await adopt("scratch/orphan");
  store.createTask({ id: "comes-back", title: "queued again" }, T0);
  store.placeTask(store.refFor("built-in", "comes-back").id, repo);
  const returning = await adopt("toolroll/comes-back");

  const auto = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(Object.fromEntries(auto.stay.map(one => [one.path, one.why]))).toEqual({ [orphan]: "no task", [returning]: "task not finished" });
  expect((await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  const manual = await cleanCheckouts(store, pool, () => at(1000), { manual: true, actor: "alex" });
  expect(manual.removed.map(one => one.path)).toEqual([orphan]);
  expect(existsSync(returning)).toBe(true);
});

test("toolroll storage clean previews without removing anything, and --yes removes and records each removal in the ledger", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  const first = await task("one", "completed");
  const second = await task("two", "cancelled");
  const kept = await task("three", "completed");
  writeFileSync(join(kept, "draft.md"), "unfinished thought\n");
  store.setCheckoutCleanup("never", "alex", T0);
  store.close();
  let lines: string[] = [];
  const cli = async (argv: string[]) => { lines = []; const code = await runOperate("storage", argv, line => { lines.push(line); }, { databaseFile: file, evidenceRoot: join(dir, "evidence") }); return { code, out: lines.join("\n") }; };
  try {
    const preview = await cli(["clean"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("Would remove 2 checkouts");
    expect(preview.out).toContain(first);
    expect(preview.out).toContain(second);
    expect(preview.out).toContain(`${kept}  (has changes)`);
    expect(preview.out).toContain("Nothing was removed.");
    for (const path of [first, second, kept]) expect(existsSync(path)).toBe(true);
    expect(JSON.parse((await cli(["clean", "--json"])).out)).toMatchObject({ ok: true, preview: true, go: [{}, {}], stay: [{ path: kept, why: "has changes" }] });
    const summary = await cli([]);
    expect(summary.out).toContain("1 kept because they have changes");
    expect(summary.out).toMatch(/A clean up now would free about .+ \(2 checkouts\)/);

    expect((await cli(["clean", "--yes"])).code).toBe(3);
    for (const path of [first, second]) expect(existsSync(path)).toBe(true);
    const removed = await cli(["clean", "--yes", "--as", "alex", "--token", alex.token]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("Removed 2 checkouts");
    for (const path of [first, second]) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(kept, "draft.md"))).toBe(true);

    expect((await cli(["cleanup", "7d", "--as", "alex", "--token", alex.token])).out).toContain("a week after its task is complete or cancelled");
    expect((await cli(["discard", kept])).code).toBe(2);
    expect((await cli(["discard", kept, "--yes", "--as", "alex", "--token", alex.token])).out).toContain("its branch stays");
    expect(existsSync(kept)).toBe(false);
  } finally {
    store = openStore(file);
  }
  expect(removals().map(one => [one.taskId, one.actor, one.source]).sort()).toEqual([["one", "alex", "request"], ["two", "alex", "request"]]);
  expect(store.actionLedger({ repos: null }).filter(one => one.action === "checkout discarded").map(one => one.taskId)).toEqual(["three"]);
  expect(store.checkoutCleanup()).toBe("7d");
  expect(await branchExists("toolroll/three")).toBe(true);
});

test("a checkout in use can't be discarded", async () => {
  const path = await task("live", "queued");
  writeFileSync(join(path, "draft.md"), "x\n");
  expect((await pool.lease({ repo, branch: "toolroll/live", runner: "builder-1", now: at(500), taskRef: store.refFor("built-in", "live").id, reclaim: { evidenceRoot: join(dir, "evidence") } })).ok).toBe(true);
  expect(await pool.discardChanges(path)).toMatchObject({ ok: false });
  expect(existsSync(path)).toBe(true);
});

test("Settings → Storage shows checkout space and what a clean-up frees; Clean up removes what the preview showed behind the password", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  const goes = await task("gone", "completed");
  const stays = await task("edited", "completed");
  writeFileSync(join(stays, "notes.txt"), "keep\n");
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, poolRoot: join(dir, "worktrees") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const page = await (await fetch(`${base}/settings/storage`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Storage</h1>");
    expect(page).toMatch(/Checkouts use \d/);
    expect(page).toContain("1 kept for their changes");
    expect(page).toMatch(/Cleaning up now frees about/);
    expect(page).toContain("<summary>Clean up</summary>");
    expect(page).toContain(goes);
    expect(page).toContain("Remove 1 checkout");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const preview = /name="preview" value="([0-9a-f]+)"/.exec(page)![1]!;
    const post = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post("/settings/storage/clean", { preview, password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(existsSync(goes)).toBe(true);
    expect((await post("/settings/storage/clean", { preview: "0".repeat(32), password: alex.token })).headers.get("location")).toContain("problem=");
    expect((await post("/settings/storage/clean", { preview, password: alex.token })).headers.get("location")).toContain("said=Removed%201%20checkout");
    expect(existsSync(goes)).toBe(false);
    expect(existsSync(stays)).toBe(true);
    expect(removals()).toMatchObject([{ actor: "alex", taskId: "gone" }]);
    expect((await post("/settings/storage", { cleanup: "never", password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.checkoutCleanup()).toBe("never");
    expect((await post("/settings/storage/discard", { path: stays, password: alex.token })).headers.get("location")).toContain("said=Discarded");
    expect(existsSync(stays)).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
