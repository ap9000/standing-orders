/**
 * The M1 acceptance test, reconcile: an interrupted run is settled against
 * real git, never guessed.
 *
 * End to end against real git: the store on disk, the claim and its fence,
 * the worktree pool running actual git, the builder's gates and the commit.
 * Only the agent is a stub — it writes a real file into the real worktree it
 * was given and answers in the CLI's output envelope.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { T0, registerRunner } from "../test/tick-kit.js";

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
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-reconcile-")));
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
    const token = registerRunner(db, "builder-1", repo);
    await run(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
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
    const store = openStore(db);
    // CLI runner register is now a password ceremony (MCP spec v6) — this
    // fixture only needs the runner ROW (reconcile never claims).
    register(store, { name: "builder-1", host: "test", repos: [repo], now: new Date("2026-08-11T00:00:00.000Z"), newToken: () => "tok-builder-1" });
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const wt = join(pool, "repo", "gone");
    await exec("git", ["worktree", "add", "-b", "standing-orders/gone", wt], { cwd: repo });
    store.saveWorktree({
      path: wt,
      repo,
      branch: "standing-orders/gone",
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
    await exec("git", ["worktree", "add", "-b", "standing-orders/crashed", wt], { cwd: repo });

    const code = await run(["reconcile", "--repo", repo, "--pool", pool, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().adopted).toEqual([wt]);

    // Adopted released and unverified: visible, but nothing may build in it
    // until something looks.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const row = store.getWorktree(wt);
    store.close();
    expect(row).toMatchObject({ verified: false });
    expect(row?.releasedAt).not.toBeNull();
  });
});
