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

describe("fill one gap, three tasks start — the M2 sentence, executable", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let agentRan: string[] = [];

  const agent: Runner = async (_file, _args, options) => {
    const cwd = options?.cwd ?? "";
    agentRan.push(cwd);
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    return { ...OK, stdout: AGENT_SAID };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now: T0,
      agentRunner: agent,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "nightorders-m2-")));
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

  test("three blocked tasks dispatch the moment their one gap is supplied", async () => {
    // -- Setup: a runner, an approver, and one capability the machine lacks.
    await run(["runner", "register", "builder-1", "--json"]);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;

    // The probe is written once and never edited again: supplying the
    // capability, not redefining it, is what must open the gate.
    await run([
      "cap", "add", "granted", "--kind", "other",
      "--probe", "test -f granted.txt", "--repo", repo,
    ]);

    for (const id of ["t-1", "t-2", "t-3"]) {
      await run(["task", "add", "the work", "--id", id, "--repo", repo]);
      await run(["task", "scope", id, "--goal", "add a guard on the payout path"]);
      await run(["task", "approve", id, "--json"]);
      const digest = payload().scope.digest as string;
      await run([
        "task", "approve", id, "--yes",
        "--digest", digest, "--as", "alex", "--token", approverToken,
      ]);
      await run(["task", "require", id, "--cap", "other:granted"]);
    }

    const tick = () =>
      run([
        "tick", "--runner", "builder-1", "--token", runnerToken,
        "--repo", repo, "--pool", pool, "--max", "3", "--json",
      ]);

    // -- Night one: the machine lacks the capability. Nothing runs, nothing
    // is claimed, and every skip names the gap.
    const blocked = await tick();
    expect(blocked).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "nothing-dispatched", considered: 3 });
    expect(payload().dispatched).toEqual([
      { id: "t-1", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
      { id: "t-2", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
      { id: "t-3", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
    ]);
    expect(agentRan).toHaveLength(0);

    // -- The operator fills the gap. The probe is untouched; the world now
    // satisfies it. (In life this is pasting a key; here it is a file.)
    await writeFile(join(repo, "granted.txt"), "supplied\n");

    // -- Night two: tick re-probes at its own checkpoint and all three start.
    const opened = await tick();
    expect(opened).toBe(EXIT.ok);
    const report = payload();
    expect(report.ok).toBe(true);
    expect(report.dispatched).toHaveLength(3);
    for (const entry of report.dispatched) expect(entry.outcome).toBe("built");
    expect(agentRan).toHaveLength(3);

    // Three real branches, three real commits, and main never moved.
    for (const id of ["t-1", "t-2", "t-3"]) {
      const shown = await git(["show", "--stat", "--oneline", `nightorders/${id}`]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("guard.ts");
    }
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("gaps", () => {
  let base: string;
  let repo: string;
  let db: string;
  let lines: string[] = [];

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0 });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "nightorders-gaps-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    await mkdir(repo, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const approvedTask = async (id: string, approverToken: string, caps: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", id, "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    await run(["task", "require", id, "--cap", caps]);
  };

  test("ranks by what filling would actually free, and counts honestly", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["cap", "add", "ALPHA", "--repo", repo]);
    await run(["cap", "add", "BETA", "--repo", repo]);

    // Three tasks held by ALPHA alone; one held by ALPHA and BETA together —
    // that one starts only when both fill, so it must not inflate either.
    await approvedTask("t-1", approverToken, "env:ALPHA");
    await approvedTask("t-2", approverToken, "env:ALPHA");
    await approvedTask("t-3", approverToken, "env:ALPHA");
    await approvedTask("t-4", approverToken, "env:ALPHA,env:BETA");

    const code = await run(["gaps", "--repo", repo, "--json"]);

    expect(code).toBe(EXIT.refused);
    const { gaps } = payload();
    expect(gaps[0]).toMatchObject({
      key: "env:ALPHA",
      unblocks: ["t-1", "t-2", "t-3"],
      alsoBlocks: ["t-4"],
    });
    expect(gaps[1]).toMatchObject({ key: "env:BETA", unblocks: [], alsoBlocks: ["t-4"] });
  });

  test("a requirement nobody recorded is a gap the moment a task names it", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await approvedTask("t-1", approverToken, "mcp:supabase");

    await run(["gaps", "--repo", repo, "--json"]);

    expect(payload().gaps[0]).toMatchObject({
      key: "mcp:supabase",
      state: `unrecorded for ${repo}`,
      unblocks: ["t-1"],
    });
  });

  test("no gaps is exit 0 and says so", async () => {
    const code = await run(["gaps", "--repo", repo, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().gaps).toEqual([]);
  });
});

describe("the outbox", () => {
  let base: string;
  let repo: string;
  let db: string;
  let lines: string[] = [];

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0 });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "nightorders-outbox-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    await mkdir(repo, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("a gap nags once per episode, and again after it recurs", async () => {
    const store = openStore(db);
    const enqueue = () =>
      store.enqueueNotification(
        { dedupeKey: `gap:${repo}:env:KEY`, kind: "gap", subject: "env:KEY blocks work", body: "…" },
        T0,
      );

    expect(enqueue()).toBe(true);
    expect(enqueue()).toBe(false); // same episode: the cron firing again is not news

    // The gap fills — verification closes the episode…
    store.saveCapability({
      repo, kind: "env", name: "KEY", probe: 'test -n "$KEY"', status: "unprobed",
      addedBy: "alex", createdAt: T0.toISOString(), lastVerifiedAt: null,
      verifiedBy: null, lastResult: null, expiresAt: null,
    });
    store.markCapability(repo, "env", "KEY", { status: "verified", by: "b1" }, T0);

    // …so a recurrence is a new fact, allowed to say so.
    expect(enqueue()).toBe(true);
    store.close();
  });

  test("deliver hands the text over as environment, records a receipt, and keeps failures pending", async () => {
    const store = openStore(db);
    store.enqueueNotification(
      { dedupeKey: "n-1", kind: "build-failed", subject: 'subject with "quotes" and $DOLLARS', body: "line one\nline two" },
      T0,
    );
    store.enqueueNotification(
      { dedupeKey: "n-2", kind: "gap", subject: "second", body: "…" },
      T0,
    );
    store.close();

    // The command reads env — nothing from the notification touches the
    // command line itself. It fails once for n-2 via a marker file trick:
    // first invocation writes the marker and succeeds; second sees it and fails.
    const marker = join(base, "seen");
    const cmd = `if [ -f "${marker}" ]; then echo "already: $NIGHTORDERS_DEDUPE_KEY" >&2; exit 7; fi; touch "${marker}"; echo "receipt for $NIGHTORDERS_SUBJECT"`;

    const code = await run(["outbox", "deliver", "--cmd", cmd, "--json"]);

    expect(code).toBe(EXIT.failed);
    expect(payload()).toMatchObject({ ok: false, delivered: 1, failed: 1 });

    const after = openStore(db);
    const all = after.listNotifications("all");
    after.close();
    expect(all[0]).toMatchObject({
      dedupeKey: "n-1",
      receipt: 'receipt for subject with "quotes" and $DOLLARS',
    });
    expect(all[0]?.deliveredAt).not.toBeNull();
    expect(all[1]).toMatchObject({ dedupeKey: "n-2", deliveredAt: null, attempts: 1, lastError: "already: n-2" });
  });

  test("a failing build leaves a durable notification with the canonical reason", async () => {
    // Wire the whole path: tick fails a build, the outbox holds the fact.
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "T"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "x\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-qm", "first"], { cwd: repo });

    const broken: Runner = async () => ({ ...OK, code: 1, stderr: "the model refused" });
    const runWith = (argv: string[]) => {
      const [command = "", ...rest] = argv;
      lines = [];
      return runOperate(command, rest, line => lines.push(line), {
        databaseFile: db,
        now: T0,
        agentRunner: broken,
      });
    };

    await runWith(["runner", "register", "builder-1", "--json"]);
    const token = payload().token as string;
    await runWith(["approver", "add", "alex", "--json"]);
    const approver = payload().token as string;
    await runWith(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await runWith(["task", "scope", "t-1", "--goal", "add a guard"]);
    await runWith(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await runWith(["task", "approve", "t-1", "--yes", "--digest", digest, "--as", "alex", "--token", approver]);
    await runWith(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", join(base, "pool"), "--json"]);

    await run(["outbox", "list", "--json"]);
    expect(payload().notifications).toHaveLength(1);
    expect(payload().notifications[0]).toMatchObject({
      kind: "build-failed",
      subject: "t-1: build failed (agent)",
    });
  });
});

describe("the morning briefing", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const agent: Runner = async (_file, _args, options) => {
    await writeFile(join(options?.cwd ?? "", "guard.ts"), "export const guarded = true;\n");
    return { ...OK, stdout: AGENT_SAID };
  };
  const broken: Runner = async () => ({ ...OK, code: 1, stderr: "the model refused" });

  const run = (argv: string[], runner: Runner = agent) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now: T0,
      agentRunner: runner,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "nightorders-brief-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "T"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "x\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-qm", "first"], { cwd: repo });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const setup = async () => {
    await run(["runner", "register", "builder-1", "--json"]);
    const token = payload().token as string;
    await run(["approver", "add", "alex", "--json"]);
    const approver = payload().token as string;
    return { token, approver };
  };

  const approvedTask = async (id: string, approver: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approver]);
  };

  test("reports the overnight from the run table, offline, honestly", async () => {
    const { token, approver } = await setup();
    await approvedTask("t-good", approver);
    await approvedTask("t-bad", approver);

    // t-good builds; t-bad fails — two ticks so each outcome lands.
    await run(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"]);
    await run(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"], broken);

    const code = await run(["brief", "--repo", repo, "--local", "--json"]);

    expect(code).toBe(EXIT.ok);
    const report = payload();
    // Both tasks share a frozen creation instant, so which ran first is not
    // promised — one built, one failed, and both are on the record.
    expect(report.overnight.built).toHaveLength(1);
    expect(report.overnight.built[0]).toMatchObject({ committed: true });
    expect(report.overnight.failed).toHaveLength(1);
    expect(report.overnight.failed[0]).toMatchObject({ reason: "agent" });
    const seen = [report.overnight.built[0].taskId, report.overnight.failed[0].taskId].sort();
    expect(seen).toEqual(["t-bad", "t-good"]);
    // REVIEW was not read, and says so — not "zero PRs".
    expect(report.review).toEqual({ state: "not-read", why: "--local, the network was not asked" });
    // The failed build's notification is waiting.
    expect(report.outboxPending).toBe(1);
  });

  test("the blocked section is the gaps view, ranked", async () => {
    const { approver } = await setup();
    await run(["cap", "add", "MISSING_KEY", "--repo", repo]);
    await approvedTask("t-1", approver);
    await run(["task", "require", "t-1", "--cap", "env:MISSING_KEY"]);

    await run(["brief", "--repo", repo, "--local", "--json"]);

    expect(payload().gaps).toHaveLength(1);
    expect(payload().gaps[0]).toMatchObject({ key: "env:MISSING_KEY", unblocks: ["t-1"] });
  });
});

describe("the park, end to end — a judgement call survives the night", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  /** Parks instead of guessing: reads its mailbox's name from its own brief. */
  const parkingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /NIGHTORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox === undefined) throw new Error("the brief named no mailbox");
    // Work in progress first — the park must preserve it, uncommitted.
    await writeFile(join(cwd, "half-done.ts"), "// the part before the question\n");
    await writeFile(
      join(cwd, mailbox),
      JSON.stringify({
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout, and the scope does not say.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "Payouts pause until retried.", reversible: true },
        ],
        recommendation: "closed",
      }),
    );
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };

  /** Tries to park and cannot say what, in exactly the same words twice. */
  const babblingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /NIGHTORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox !== undefined) {
      await writeFile(join(cwd, mailbox), JSON.stringify({ urgency: "blocking", recap: "er" }));
    }
    return { ...OK, stdout: JSON.stringify({ result: "tried" }) };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = parkingAgent, now: Date = T0) => {
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
    base = await mkdtemp(join(tmpdir(), "nightorders-park-e2e-"));
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

  const setup = async () => {
    await run(["runner", "register", "builder-1", "--json"]);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["task", "add", "the work", "--id", "t-1"]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", "t-1", "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, runner: Runner = parkingAgent) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      runner,
    );

  test("a park is a pass that exits 0, holds the task, and pages once", async () => {
    const { runnerToken } = await setup();

    const code = await tick(runnerToken);

    // The pass succeeded: nothing broke, the question is where it belongs.
    expect(code).toBe(EXIT.ok);
    expect(payload()).toMatchObject({
      ok: true,
      command: "tick",
      dispatched: [{ id: "t-1", outcome: "parked", reason: "decision:1" }],
    });

    // The decision is real, open, and carries the machine's own evidence.
    const store = openStore(db);
    try {
      const decision = store.getDecision(1);
      expect(decision).toMatchObject({ state: "open", recommendation: "closed" });
      const evidence = store.evidenceFor(1);
      expect(evidence.map(artifact => artifact.kind).sort()).toEqual(["diff", "park-payload", "status"]);
      // The task is held by the decision, out of every ready set.
      const holds = store.activeHolds(store.refFor("built-in", "t-1").id, new Date(T0.getTime() + 9e8));
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ ownerKind: "decision" });
      // The run record is canonical: parked, not built, not failed.
      expect(store.getRun(1)).toMatchObject({ outcome: "parked", reason: "decision:1", role: "builder" });
      // Exactly one page, episode-keyed to the decision.
      const pending = store.listNotifications("pending");
      expect(pending.map(notification => notification.dedupeKey)).toEqual(["decision:1"]);
    } finally {
      store.close();
    }

    // main never moved, and no commit landed on the task branch.
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);
    const branch = await git(["log", "--oneline", "nightorders/t-1"]);
    expect(branch.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("the work in progress survives the park, uncommitted, where the resume will find it", async () => {
    const { runnerToken } = await setup();
    await tick(runnerToken);

    const store = openStore(db);
    const worktree = store.getRun(1)?.worktree;
    store.close();
    expect(worktree).toBeDefined();

    const status = await exec("git", ["status", "--porcelain"], { cwd: worktree as string });
    expect(status.stdout).toContain("half-done.ts");
    // And the mailbox is gone — ingested once, not left to confuse anyone.
    expect(status.stdout).not.toContain("NIGHTORDERS-PARK-");
  });

  test("a second pass does not double-park: the held task is simply not ready", async () => {
    const { runnerToken } = await setup();
    await tick(runnerToken);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });

    const store = openStore(db);
    try {
      expect(store.listDecisions("all")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a payload that never becomes a decision becomes an incident, holding the task", async () => {
    const { runnerToken } = await setup();

    const code = await tick(runnerToken, babblingAgent);

    // The attempt broke and the pass says so.
    expect(code).toBe(EXIT.failed);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "failed", reason: "malformed-decision" }]);

    const store = openStore(db);
    try {
      // No decision — an incident, held by it, paged once.
      expect(store.listDecisions("all")).toHaveLength(0);
      expect(store.openIncidents()).toMatchObject([{ kind: "malformed-decision", taskId: "t-1" }]);
      const holds = store.activeHolds(store.refFor("built-in", "t-1").id, new Date(T0.getTime() + 9e8));
      expect(holds[0]).toMatchObject({ ownerKind: "incident" });
      expect(store.getRun(1)).toMatchObject({ outcome: "failed", reason: "malformed-decision" });
      expect(store.listNotifications("pending").map(notification => notification.dedupeKey)).toEqual([
        "malformed:1",
      ]);
      // The malformed payload is preserved for a person to read.
      expect(store.artifactsFor(1).map(artifact => artifact.kind)).toContain("park-payload");
    } finally {
      store.close();
    }
  });
});

describe("decide, end to end — the morning answers and the machine hears it", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const parkingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /NIGHTORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox === undefined) throw new Error("the brief named no mailbox");
    await writeFile(
      join(cwd, mailbox),
      JSON.stringify({
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
        ],
        recommendation: "closed",
      }),
    );
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };

  const buildingAgent: Runner = async (_file, _args, options) => {
    const cwd = options?.cwd ?? "";
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    return { ...OK, stdout: AGENT_SAID };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = parkingAgent, now: Date = T0) => {
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
    base = await mkdtemp(join(tmpdir(), "nightorders-decide-e2e-"));
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

  const setup = async () => {
    await run(["runner", "register", "builder-1", "--json"]);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["task", "add", "the work", "--id", "t-1"]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", "t-1", "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, runner: Runner) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      runner,
    );

  test("park → decide → the task is ready again, and the answer is on the record", async () => {
    const { runnerToken, approverToken } = await setup();
    await tick(runnerToken, parkingAgent);

    // The list shows the question; exit 3 says attention is wanted.
    let code = await run(["decide", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().waiting).toMatchObject([{ id: 1, taskId: "t-1", question: "Fail open or fail closed?" }]);

    // The single view carries the whole screen: recap, options, evidence.
    await run(["decide", "1", "--json"]);
    expect(payload().decision).toMatchObject({ recommendation: "closed", state: "open" });
    expect(payload().evidence.map((a: { kind: string }) => a.kind).sort()).toEqual(["diff", "park-payload", "status"]);

    // Answering without authority is refused — an agent cannot decide for you.
    code = await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", "not-the-token", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("not-an-approver");

    // Answering with authority works once.
    code = await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().decision).toMatchObject({ state: "answered", choice: "closed", answeredBy: "alex" });

    // A different answer afterwards is refused — decided is not negotiable.
    code = await run(["decide", "1", "--choose", "open", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("already-answered");

    // The hold is gone: the next pass takes the task again.
    code = await tick(runnerToken, buildingAgent);
    expect(code).toBe(EXIT.ok);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
  });

  test("the brief carries DECIDE while a decision waits, and stops when it is answered", async () => {
    const { runnerToken, approverToken } = await setup();
    await tick(runnerToken, parkingAgent);

    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().decide).toMatchObject([{ id: 1, taskId: "t-1" }]);

    await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approverToken]);
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().decide).toEqual([]);
    // The outbox no longer pages about it either: resolved, receipts kept.
    expect(payload().outboxPending).toBe(0);
  });

  test("an incident outlives the briefing window and only an authenticated resolve frees the task", async () => {
    const { runnerToken, approverToken } = await setup();
    const babbling: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      const mailbox = /NIGHTORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (mailbox !== undefined) await writeFile(join(cwd, mailbox), "not even json");
      return { ...OK, stdout: JSON.stringify({ result: "tried" }) };
    };
    await tick(runnerToken, babbling);

    // A week later, the incident is still in the brief — no window hides it.
    const aWeekOn = new Date(T0.getTime() + 7 * 24 * 60 * 60_000);
    await run(["brief", "--repo", repo, "--local", "--json"], parkingAgent, aWeekOn);
    expect(payload().incidents).toMatchObject([{ id: 1, taskId: "t-1", kind: "malformed-decision" }]);

    // task unhold cannot lift it: the hold belongs to the incident.
    await run(["task", "unhold", "t-1", "--json"]);
    await run(["ready", "--json"]);
    expect(payload().tasks ?? []).toEqual([]);

    // An authenticated resolve can.
    const code = await run(["incident", "resolve", "1", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.ok);
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().incidents).toEqual([]);
    await run(["ready", "--json"]);
    expect((payload().tasks ?? []).map((t: { id: string }) => t.id)).toEqual(["t-1"]);
  });
});
