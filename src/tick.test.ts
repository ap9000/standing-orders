/**
 * The M1 acceptance test, end to end against real git:
 * one task goes queued → branch → commit, with nobody typing the steps.
 *
 * Only the agent is a stub — it stands where `claude` would, writes a real
 * file into the real worktree it was given, and answers in the CLI's output
 * envelope. Everything else is the actual machinery: the store on disk, the
 * claim and its fence, the worktree pool running actual git, the builder's
 * gates, and the commit.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");
const AGENT_SAID = JSON.stringify({ result: "Added the guard and a test for it." });

describe("tick, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  /** Where the stub agent was asked to work, one entry per invocation. */
  let agentRan: string[] = [];

  /** Stands where `claude` would: does real work in the worktree it was given. */
  const agent: Runner = async (_file, _args, options) => {
    const cwd = options?.cwd ?? "";
    agentRan.push(cwd);
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    return { ...OK, stdout: AGENT_SAID };
  };

  const brokenAgent: Runner = async () => ({ ...OK, code: 1, stderr: "the model refused" });

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = agent, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "nightorders-tick-"));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    agentRan = [];

    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Registers the runner and an approver, and returns their tokens. */
  const credentials = async () => {
    await run(["runner", "register", "builder-1", "--json"]);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    return { runnerToken, approverToken };
  };

  const queueApproved = async (id: string, approverToken: string) => {
    await run(["task", "add", "the work", "--id", id]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", id, "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
  };

  const tick = (runnerToken: string, extra: string[] = [], runner: Runner = agent) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json", ...extra],
      runner,
    );

  test("one task goes queued → branch → commit, unattended", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    const code = await tick(runnerToken);

    expect(payload()).toMatchObject({
      ok: true,
      command: "tick",
      considered: 1,
      dispatched: [{ id: "t-1", outcome: "built", committed: true, branch: "nightorders/t-1" }],
    });
    expect(code).toBe(EXIT.ok);
    expect(agentRan).toHaveLength(1);

    // The commit is real, on the task's branch, containing the agent's work…
    const shown = await git(["show", "--stat", "--oneline", "nightorders/t-1"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("guard.ts");
    // …and main never moved.
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);

    // The ledger agrees: done, and the lease is not still held.
    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("done");

    // And the attempt survived as a record, not just as an exit code.
    expect(payload().runs).toHaveLength(1);
    expect(payload().runs[0]).toMatchObject({
      outcome: "built",
      committed: true,
      branch: "nightorders/t-1",
      runner: "builder-1",
    });
    expect(payload().runs[0].finishedAt).not.toBeNull();
  });

  test("an empty queue is exit 3, not an error", async () => {
    const { runnerToken } = await credentials();

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
  });

  test("a ready task nobody approved is reported, not built", async () => {
    const { runnerToken } = await credentials();
    await run(["task", "add", "the work", "--id", "t-1"]);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({
      ok: false,
      reason: "nothing-dispatched",
      dispatched: [{ id: "t-1", outcome: "skipped", reason: "unapproved" }],
    });
    expect(agentRan).toHaveLength(0);
  });

  test("--max 1 builds one of two ready tasks and leaves the other queued", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await queueApproved("t-2", approverToken);

    const code = await tick(runnerToken, ["--max", "1"]);

    expect(code).toBe(EXIT.ok);
    const report = payload();
    expect(report.considered).toBe(2);
    expect(report.dispatched).toHaveLength(1);

    await run(["task", "show", "t-2", "--json"]);
    expect(payload().task.state).toBe("queued");
  });

  test("a broken agent marks the task failed and the pass exits 1", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    const code = await tick(runnerToken, [], brokenAgent);

    expect(code).toBe(EXIT.failed);
    expect(payload()).toMatchObject({
      ok: false,
      reason: "build-failed",
      dispatched: [{ id: "t-1", outcome: "failed", reason: "agent" }],
    });

    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("failed");

    // The broken attempt is on the record too, with its reason.
    expect(payload().runs).toHaveLength(1);
    expect(payload().runs[0]).toMatchObject({ outcome: "failed", reason: "agent" });
  });

  test("a second pass finds nothing left to do", async () => {
    // The fences holding is what makes running this from cron safe: the same
    // command again must converge, not build the same task twice.
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await tick(runnerToken);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
    expect(agentRan).toHaveLength(1);
  });

  test("a task somebody else holds never enters the pass at all", async () => {
    // The ready set already excludes a live claim, so the other runner's task
    // is not even considered — losing a race this early is indistinguishable
    // from an empty queue, and both are exit 3.
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await run(["runner", "register", "builder-2", "--json"]);
    const otherToken = payload().token as string;
    await run(["claim", "t-1", "--runner", "builder-2", "--token", otherToken]);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
    expect(agentRan).toHaveLength(0);
  });
});

describe("reconcile, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    // Resolved to its real path up front: git reports real paths, and the
    // assertions compare against what git says.
    base = realpathSync(await mkdtemp(join(tmpdir(), "nightorders-reconcile-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });

    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("an untouched world has nothing to reconcile", async () => {
    const code = await run(["reconcile", "--repo", repo, "--pool", pool, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, recovered: [], reaped: [], adopted: [], forgotten: [] });
  });

  test("a repo that is not a repo fails the sweep instead of emptying it", async () => {
    const notRepo = join(base, "not-a-repo");
    await mkdir(notRepo, { recursive: true });

    const code = await run(["reconcile", "--repo", notRepo, "--pool", pool, "--json"]);

    expect(code).toBe(EXIT.failed);
    expect(payload()).toMatchObject({ ok: false, reason: "git" });
  });

  test("recovers a dead runner's claim and requeues its task", async () => {
    // builder-1 heartbeats at T0, claims t-1, and goes silent. Ten minutes
    // later the claim is unexpired (15-minute lease) but the runner is dead
    // (3-minute liveness) — recovery must requeue the task, not just note it.
    await run(["runner", "register", "builder-1", "--json"]);
    const token = payload().token as string;
    await run(["task", "add", "the work", "--id", "t-1"]);
    await run(["claim", "t-1", "--runner", "builder-1", "--token", token]);

    const tenLater = new Date(T0.getTime() + 10 * 60_000);
    const code = await run(["reconcile", "--repo", repo, "--pool", pool, "--json"], tenLater);

    expect(code).toBe(EXIT.ok);
    expect(payload().recovered).toHaveLength(1);
    expect(payload().recovered[0].runner).toBe("builder-1");
    expect(payload().recovered[0].claims).toHaveLength(1);

    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("queued");
    expect(payload().claim).toBeNull();
  });

  test("forgets a worktree row whose directory is gone", async () => {
    // A real worktree is made, its row recorded — then the machine is
    // "reimaged": the directory vanishes and git is told to forget it too.
    await run(["runner", "register", "builder-1", "--json"]);
    const store = openStore(db);
    const wt = join(pool, "repo", "gone");
    await exec("git", ["worktree", "add", "-b", "nightorders/gone", wt], { cwd: repo });
    store.saveWorktree({
      path: wt,
      repo,
      branch: "nightorders/gone",
      runner: "builder-1",
      taskRef: null,
      createdAt: T0.toISOString(),
      leasedAt: null,
      releasedAt: T0.toISOString(),
      verified: false,
    });
    store.close();
    await rm(wt, { recursive: true, force: true });
    await git(["worktree", "prune"]);

    const code = await run(["reconcile", "--repo", repo, "--pool", pool, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().forgotten).toEqual([wt]);
  });

  test("adopts a worktree the pool made but never recorded", async () => {
    // A crash between `git worktree add` and the row: the directory is real,
    // inside the pool root, and the database has never heard of it.
    const wt = join(pool, "repo", "crashed");
    await exec("git", ["worktree", "add", "-b", "nightorders/crashed", wt], { cwd: repo });

    const code = await run(["reconcile", "--repo", repo, "--pool", pool, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().adopted).toEqual([wt]);

    // Adopted released and unverified: visible, but nothing may build in it
    // until something looks.
    const store = openStore(db);
    const row = store.getWorktree(wt);
    store.close();
    expect(row).toMatchObject({ verified: false });
    expect(row?.releasedAt).not.toBeNull();
  });
});
