/**
 * Safe task stop and resume (v52), against REAL git: the ordinary
 * authenticated journey. A tick builds a task whose agent — a real
 * subprocess in a real worktree — writes a dirty draft and is stopped from
 * another database connection mid-flight. The draft survives on disk, the
 * branch is created, the default branch never moves, the task waits under
 * the stop's own hold (no strike, no automatic retry), `task resume`
 * lifts exactly that hold, and the next pass takes a fresh claim, inherits
 * the draft through the recovered-draft road, quarantines the old handoff,
 * and produces ONE accepted result with fresh proof.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The agent that gets stopped: a REAL process that writes its draft into
 * the worktree, announces itself, and keeps working until it is ended. */
const DRAFTING_AGENT = `
import { writeFileSync, appendFileSync } from "node:fs";
const cwd = process.cwd();
writeFileSync(cwd + "/draft.ts", "export const draft = 1; // half-written\\n");
writeFileSync(cwd + "/agent-started", String(process.pid));
setInterval(() => appendFileSync(cwd + "/draft.ts", "// still typing\\n"), 25);
setTimeout(() => process.exit(0), 30000);
`;

describe("safe task stop and resume against real git (v52)", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const run = (argv: string[], runner?: Runner) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: new Date(), ...(runner === undefined ? {} : { agentRunner: runner }) });
  };
  const payload = () => JSON.parse(lines.join("\n"));
  /** A pass that stays in flight while other commands run: its own capture. */
  const runApart = async (argv: string[], runner: Runner): Promise<{ code: number; envelope: Record<string, unknown> }> => {
    const [command = "", ...rest] = argv;
    const own: string[] = [];
    const code = await runOperate(command, rest, line => own.push(line), { databaseFile: db, now: new Date(), agentRunner: runner });
    return { code, envelope: JSON.parse(own.join("\n")) as Record<string, unknown> };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "so-stop-git-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    writeFileSync(join(base, "drafting-agent.mjs"), DRAFTING_AGENT);
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

  const credentials = async () => {
    const store = openStore(db);
    const runnerToken = register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: new Date() }).token;
    store.close();
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    for (const phase of ["build", "plan", "review"]) {
      await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    }
    return { runnerToken, approverToken };
  };

  const criterion = "The guard file is committed on the task branch.";
  const queueApproved = async (id: string, approverToken: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", `${criterion}|changed-path`]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);
  };

  const tickArgs = (runnerToken: string) => ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"];

  test("c6: a dirty draft is interrupted, preserved, resumed through the authenticated door, and proved fresh exactly once — main never moves", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    const mainBefore = (await git(["rev-parse", "main"])).stdout.trim();

    // Pass 1: the drafting agent, a real subprocess spawned through the
    // exec transport with the gateway's own options (group + owner tag).
    let draftingWorktree = "";
    const draftingAgent: Runner = async (_file, _args, options) => {
      draftingWorktree = options?.cwd ?? "";
      return exec(process.execPath, [join(base, "drafting-agent.mjs")], {
        cwd: draftingWorktree,
        processGroup: true,
        ...(options?.owner === undefined ? {} : { owner: options.owner }),
        timeoutMs: 60_000,
      });
    };
    const firstPass = runApart(tickArgs(runnerToken), draftingAgent);

    // Wait until the agent is up and has written its draft into the worktree.
    const started = async (): Promise<boolean> => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        if (draftingWorktree !== "" && existsSync(join(draftingWorktree, "agent-started"))) return true;
        await sleep(25);
      }
      return false;
    };
    expect(await started()).toBe(true);

    // The stop, through the CLI on ANOTHER database connection, naming the
    // exact live run: refused without the operator's credential, refused
    // for a run that does not exist, then recorded — durable first; the
    // tick's own process holds the child, and the shared registry ends it.
    const other = openStore(db);
    const ref = other.refFor("built-in", "t-1").id;
    const live = other.runsFor(ref).find(one => one.outcome === null);
    other.close();
    expect(live).toBeDefined();
    const stoppedRun = live!.id;
    expect(await run(["task", "stop", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", "wrong", "--json"])).toBe(EXIT.refused);
    expect(await run(["task", "stop", "t-1", "--run", "999", "--as", "alex", "--token", approverToken, "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "no-run" });
    expect(await run(["task", "stop", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", approverToken, "--json"])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, run: stoppedRun, requested: true, repeated: false, terminated: 1, control: { kind: "stopping", run: stoppedRun } });
    expect(payload().stop).toMatchObject({ requestedBy: "alex", requestedVia: "cli", settledAt: null });
    // Repeated: the same request, nothing new.
    expect(await run(["task", "stop", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", approverToken, "--json"])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, repeated: true });

    // The pass built nothing and broke nothing: it reports the stop and
    // exits as "waiting on a person" — an operator's stop is exactly that.
    const first = await firstPass;
    expect(first.code).toBe(EXIT.refused);
    expect(first.envelope).toMatchObject({ ok: false, reason: "nothing-dispatched" });
    expect((first.envelope["dispatched"] as Record<string, unknown>[])[0]).toMatchObject({ id: "t-1", outcome: "stopped", reason: `stop:${stoppedRun}` });

    // Interrupted, preserved, paused: no strike, no retry, the draft on disk,
    // the branch created, main untouched.
    const after = openStore(db);
    try {
      expect(after.getRun(stoppedRun)).toMatchObject({ outcome: "failed", reason: "interrupted" });
      expect(after.stopOf(stoppedRun)).toMatchObject({ settlement: "interrupted", requestedBy: "alex", resumedAt: null });
      expect(after.getTask("t-1")?.state).toBe("queued");
      expect(after.refForId(ref)?.strikes).toBe(0);
      expect(after.activeHolds(ref, new Date()).map(one => one.ownerKind)).toEqual(["stop"]);
      expect(String(after.raw().prepare("SELECT released_by FROM claim WHERE lease_id = ?").get(live!.leaseId)?.["released_by"])).toBe("interrupted");
    } finally {
      after.close();
    }
    expect(readFileSync(join(draftingWorktree, "draft.ts"), "utf8")).toContain("half-written");
    expect((await git(["rev-parse", "--verify", "--quiet", "refs/heads/standing-orders/t-1"])).code).toBe(0);
    expect((await git(["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
    await run(["task", "show", "t-1", "--json"]);
    expect(payload().control).toMatchObject({ kind: "paused", run: stoppedRun });
    expect(payload().dispatch).toMatchObject({ code: "stopped" });

    // A pass before the resume admits nothing: the stop's hold keeps the queue away.
    const neverAgent: Runner = async () => {
      throw new Error("nothing may spawn while the task is paused");
    };
    expect(await run(tickArgs(runnerToken), neverAgent)).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });

    // The authenticated resume, through the CLI: the wrong password is
    // refused, the right one lifts exactly the stop's hold.
    const wrong = await run(["task", "resume", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", "wrong", "--pool", pool, "--json"]);
    if (wrong !== EXIT.refused) throw new Error(`wrong password exited ${wrong}: ${lines.join("\n")}`);
    expect(await run(["task", "resume", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", approverToken, "--pool", pool, "--json"])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, run: stoppedRun });
    // Replayed: refused, nothing changes.
    expect(await run(["task", "resume", "t-1", "--run", String(stoppedRun), "--as", "alex", "--token", approverToken, "--pool", pool, "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "already-resumed" });

    // Pass 2: the successor inherits the preserved draft in the SAME
    // worktree, finishes it, and proves it fresh.
    let successorSawDraft = false;
    let successorWorktree = "";
    const finishingAgent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      successorWorktree = cwd;
      successorSawDraft = existsSync(join(cwd, "draft.ts")) && readFileSync(join(cwd, "draft.ts"), "utf8").includes("half-written");
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      const proof = /STANDING-ORDERS-PROOF-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (done === undefined || proof === undefined) throw new Error("the brief named no handoff or proof file");
      await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "Finished the interrupted draft and added the guard." }));
      await writeFile(join(cwd, proof), JSON.stringify({
        version: 1,
        criteria: [{ id: "c1", statement: criterion, verdict: "met", how: "guard.ts is in the sealed diff", evidence: [{ kind: "changed-path", ref: "guard.ts" }] }],
        checks: [],
        // Everything the sealed diff carries: the fresh guard plus the
        // preserved draft and the stopped agent's own marker file.
        changed: ["agent-started", "draft.ts", "guard.ts"],
        caveats: [],
        screenshots: [],
      }));
      return { ...OK, stdout: JSON.stringify({ result: "Finished the interrupted draft and added the guard." }) };
    };
    expect(await run(tickArgs(runnerToken), finishingAgent)).toBe(EXIT.ok);
    expect(payload().dispatched[0]).toMatchObject({ id: "t-1", outcome: "built", committed: true });
    expect(successorSawDraft).toBe(true);
    expect(successorWorktree).toBe(draftingWorktree);

    const done = openStore(db);
    try {
      expect(done.getTask("t-1")?.state).toBe("done");
      const runs = done.runsFor(ref);
      expect(runs.map(one => one.outcome).sort()).toEqual(["built", "failed"]);
      const built = runs.find(one => one.outcome === "built")!;
      // The recovered-draft road: the successor names the stopped attempt as its parent, under a fresh lease.
      expect(built.parentRun).toBe(stoppedRun);
      expect(built.leaseId).not.toBe(live!.leaseId);
      // Fresh proof, once: attested on the successor, none accepted on the stopped attempt.
      expect(done.proofVerdictFor(built.id)?.verdict).toBe("attested");
      expect(done.proofVerdictFor(stoppedRun)).toBeNull();
      expect(done.artifactsFor(built.id).map(one => one.kind)).toEqual(expect.arrayContaining(["handoff", "terminal-diff", "diff-stat", "proof"]));
      // Exactly one accepted completion on the claim log.
      const completed = done.raw().prepare("SELECT COUNT(*) AS n FROM claim WHERE task_ref = ? AND released_by = 'completed'").get(ref);
      expect(Number(completed?.["n"])).toBe(1);
      expect(done.activeHolds(ref, new Date())).toEqual([]);
    } finally {
      done.close();
    }
    // The branch carries the draft and the guard; main never moved.
    const branchFiles = (await git(["ls-tree", "--name-only", "standing-orders/t-1"])).stdout.split("\n");
    expect(branchFiles).toEqual(expect.arrayContaining(["draft.ts", "guard.ts"]));
    expect((await git(["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
    // A later pass converges: nothing builds twice.
    expect(await run(tickArgs(runnerToken), finishingAgent)).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
  }, 90_000);
});
