/**
 * Safe task stop and resume (v52), against REAL subprocesses: two attempts
 * run at once, each spawning a real process tree (a node parent and a
 * shell grandchild writing into the worktree). One is stopped through the
 * shared door; the other finishes as built. The stopped attempt's whole
 * tree is dead, its stop settles only at the fenced seal, and nothing in
 * that tree writes a byte after settlement.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Runner } from "./builder.js";
import { run as exec, ownedProcessCount, runOwnerTag } from "./exec.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { disposeBuildOutcome } from "./dispose.js";
import { attemptHasLiveChildren, requestTaskStop, resumeTaskStop, taskControlOf } from "./task-control.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-12T09:00:00.000Z");
const REPO = "/code/stop-process";
const tok = (name: string) => `tok-${name}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const presented = (store: Store, taskRef: number) => {
  const authority = store.routeAuthorityFor(taskRef, "builder", null) ?? store.routeAuthorityFor(taskRef, "builder", null, { provider: "claude", model: null });
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

/** A real process tree: the node parent writes on a timer and spawns a
 * shell grandchild in the same process group that writes on its own. */
const LONG_AGENT = `
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
const cwd = process.cwd();
const child = spawn("sh", ["-c", 'while true; do echo tick >> "' + cwd + '/grandchild.log"; sleep 0.02; done'], { stdio: "ignore" });
writeFileSync(cwd + "/pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => appendFileSync(cwd + "/parent.log", "tick\\n"), 20);
setTimeout(() => process.exit(0), 30000);
`;

/** A real process that does the work and speaks the terminal handoff. */
const SHORT_AGENT = `
import { writeFileSync } from "node:fs";
const cwd = process.cwd();
writeFileSync(cwd + "/guard.ts", "export const guarded = true;\\n");
writeFileSync(cwd + "/" + process.env.SO_TEST_DONE, JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard." }));
process.stdout.write(JSON.stringify({ result: "Added the guard." }));
`;

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

describe("safe task stop against real subprocesses (v52)", () => {
  let store: Store;
  let base: string;
  let approverToken: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "so-stop-proc-"));
    writeFileSync(join(base, "long-agent.mjs"), LONG_AGENT);
    writeFileSync(join(base, "short-agent.mjs"), SHORT_AGENT);
    store = openStore(":memory:");
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap refused");
    approverToken = added.token;
    register(store, { name: "builder-1", host: "h", capacity: 9, repos: [REPO], now: T0, newToken: () => tok("builder-1") });
  });

  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  /** A placed, approved, claimed task with its own leased worktree and open run. */
  function attempt(taskId: string, lease: string): { taskRef: number; runId: number; worktree: string; leaseId: string } {
    store.createTask({ id: taskId, title: taskId }, T0);
    const taskRef = store.refFor("built-in", taskId).id;
    store.placeTask(taskRef, REPO);
    propose(store, { taskId, goal: `guard ${taskId}`, now: T0 });
    approve(store, taskId, "alex", T0, store.getScope(taskId)!.digest, approverToken);
    const worktree = mkdtempSync(join(base, `wt-${taskId}-`));
    store.saveWorktree({ path: worktree, repo: REPO, branch: `feat/${taskId}`, runner: "builder-1", taskRef, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
    const claimed = acquire(store, taskRef, "builder-1", { token: tok("builder-1"), now: T0, ttlMs: 60 * 60_000, newLeaseId: () => lease });
    if (!claimed.ok) throw new Error(`claim refused: ${claimed.reason}`);
    const runId = store.startRun({ taskRef, leaseId: lease, runner: "builder-1", branch: `feat/${taskId}`, worktree, now: T0, ...presented(store, taskRef) });
    return { taskRef, runId, worktree, leaseId: lease };
  }

  /** The fake git every builder test uses: the leased branch, one modified file, a happy commit. */
  const git = (branch: string): Runner => async (_file, args) => {
    if (args.includes("rev-parse")) return { ...OK, stdout: `${branch}\n` };
    if (args.includes("symbolic-ref")) return args.includes("refs/remotes/origin/HEAD") ? { ...OK, code: 1 } : { ...OK, stdout: "main\n" };
    return args.includes("status") ? { ...OK, stdout: " M guard.ts\n" } : { ...OK };
  };

  /** Stands where `claude` would, but spawns a REAL process through the
   * exec transport with exactly the options the gateway passed — process
   * group and owner tag included — so the stop's handle reaches it. */
  const realAgent = (script: string): Runner => async (_file, args, options) => {
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0] ?? "";
    return exec(process.execPath, [join(base, script)], {
      cwd: options?.cwd ?? base,
      processGroup: true,
      ...(options?.owner === undefined ? {} : { owner: options.owner }),
      timeoutMs: 60_000,
      env: { SO_TEST_DONE: done },
    });
  };

  test("c6: stopping one of two simultaneous attempts ends exactly its process tree; the other finishes built; nothing writes after settlement", async () => {
    const a = attempt("t-long", "lease-long");
    const b = attempt("t-short", "lease-short");
    const clock = () => new Date();
    const request = (x: typeof a, taskId: string, script: string) => ({
      taskId,
      taskRef: x.taskRef,
      runner: "builder-1",
      leaseId: x.leaseId,
      runnerToken: tok("builder-1"),
      runId: x.runId,
      worktree: x.worktree,
      branch: `feat/${taskId}`,
      evidenceRoot: join(base, "evidence"),
      now: T0,
      clock,
      agent: realAgent(script),
      git: git(`feat/${taskId}`),
      pulseMs: 0,
    });

    const longBuild = build(store, request(a, "t-long", "long-agent.mjs"));
    const shortBuild = build(store, request(b, "t-short", "short-agent.mjs"));

    // The long attempt's tree is up: parent and grandchild both alive and writing.
    expect(await waitFor(() => existsSync(join(a.worktree, "pids.json")) && existsSync(join(a.worktree, "grandchild.log")), 10_000)).toBe(true);
    const pids = JSON.parse(readFileSync(join(a.worktree, "pids.json"), "utf8")) as { parent: number; child: number };
    expect(alive(pids.parent)).toBe(true);
    expect(alive(pids.child)).toBe(true);
    expect(ownedProcessCount(runOwnerTag(a.runId))).toBe(1);

    // The stop: durable first, then the owned tree — and only that tree.
    const asked = requestTaskStop(store, { taskId: "t-long", runId: a.runId, by: "alex", via: "cli" }, clock());
    expect(asked).toMatchObject({ ok: true, repeated: false, terminated: 1 });
    expect(store.stopOf(a.runId)?.settledAt).toBeNull();
    expect(taskControlOf(store, a.taskRef, clock())).toMatchObject({ kind: "stopping", run: a.runId });

    const [stopped, built] = await Promise.all([longBuild, shortBuild]);
    // The independent attempt survived the neighbour's stop and finished.
    expect(built).toMatchObject({ ok: true, committed: true });
    expect(existsSync(join(b.worktree, "guard.ts"))).toBe(true);
    // The stopped attempt says so in its own words — not timeout, not agent failure.
    expect(stopped).toMatchObject({ ok: false, reason: "stopped" });
    if (!stopped.ok) expect(stopped.message).toContain("stopped by alex");

    // The whole tree is gone: parent and the shell grandchild it spawned.
    expect(await waitFor(() => !alive(pids.parent) && !alive(pids.child), 5_000)).toBe(true);
    expect(attemptHasLiveChildren(store, a.runId)).toBe(false);
    // Resume refuses while the seal has not landed: the stop is unsettled.
    expect(resumeTaskStop(store, { taskId: "t-long", runId: a.runId, by: "alex", via: "cli" }, clock())).toMatchObject({ ok: false, reason: "stopping" });

    // Settlement: the fenced seal, interrupted, no strike; the other task done.
    const sealed = disposeBuildOutcome({ store, policy: "tick", leaseId: a.leaseId, runId: a.runId, taskId: "t-long", taskRef: a.taskRef, runner: "builder-1", repo: REPO, branch: "feat/t-long", origin: "ours", provider: "claude", model: "sonnet", worktreePath: a.worktree, clock }, stopped);
    expect(sealed).toMatchObject({ kind: "stopped", stopRun: a.runId });
    const finished = disposeBuildOutcome({ store, policy: "tick", leaseId: b.leaseId, runId: b.runId, taskId: "t-short", taskRef: b.taskRef, runner: "builder-1", repo: REPO, branch: "feat/t-short", origin: "ours", provider: "claude", model: "sonnet", worktreePath: b.worktree, clock }, built);
    expect(finished).toMatchObject({ kind: "built" });
    expect(store.getTask("t-short")?.state).toBe("done");
    expect(store.getTask("t-long")?.state).toBe("queued");
    expect(store.getRun(a.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.stopOf(a.runId)).toMatchObject({ settlement: "interrupted" });
    expect(store.refForId(a.taskRef)?.strikes).toBe(0);
    expect(store.activeHolds(a.taskRef, clock()).map(one => one.ownerKind)).toEqual(["stop"]);
    expect(taskControlOf(store, a.taskRef, clock())).toMatchObject({ kind: "paused", run: a.runId });

    // No descendant writes after settlement: the logs are frozen.
    const sizeOf = (name: string) => (existsSync(join(a.worktree, name)) ? statSync(join(a.worktree, name)).size : -1);
    const grandchildAt = sizeOf("grandchild.log");
    const parentAt = sizeOf("parent.log");
    await sleep(400);
    expect(sizeOf("grandchild.log")).toBe(grandchildAt);
    expect(sizeOf("parent.log")).toBe(parentAt);
    // The dirty work is preserved, not cleaned.
    expect(grandchildAt).toBeGreaterThan(0);

    // Now quiescent: the exact attempt resumes, and only its hold lifts.
    expect(resumeTaskStop(store, { taskId: "t-long", runId: a.runId, by: "alex", via: "cli" }, clock())).toMatchObject({ ok: true });
    expect(store.activeHolds(a.taskRef, clock())).toEqual([]);
  }, 60_000);

  test("c3: a stop recorded before the provider spawns spends nothing — the gateway refuses in the stop's words", async () => {
    const a = attempt("t-prespawn", "lease-prespawn");
    let spawned = 0;
    const agent: Runner = async () => {
      spawned += 1;
      return { ...OK, stdout: JSON.stringify({ result: "never" }) };
    };
    expect(requestTaskStop(store, { taskId: "t-prespawn", runId: a.runId, by: "alex", via: "web" }, T0).ok).toBe(true);
    const result = await build(store, {
      taskId: "t-prespawn", taskRef: a.taskRef, runner: "builder-1", leaseId: a.leaseId, runnerToken: tok("builder-1"), runId: a.runId,
      worktree: a.worktree, branch: "feat/t-prespawn", evidenceRoot: join(base, "evidence"), now: T0, agent, git: git("feat/t-prespawn"), pulseMs: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: "stopped" });
    expect(spawned).toBe(0);
    expect(store.getRun(a.runId)?.providerStartedAt).toBeNull();
  });
});
