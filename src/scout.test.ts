/**
 * Scout tasks (mate arc §10), end to end against real git: a task filed
 * with --report, its scope approved like any other, a scout dispatched on
 * the planner's read-only road, and a report — never a branch — sealed as
 * evidence. Only the agent is a stub. The workspace proof is exercised
 * adversarially exactly as the planner's is: a scout that touches the tree
 * gets nothing ingested.
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
import { fileTaskProposal } from "./proposal.js";
import { parseReport, REPORT_LIMITS } from "./scout-report.js";
import { readVerifiedReport } from "./evidence.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-02T22:00:00.000Z");
const SAID = JSON.stringify({ result: "scouting" });

const REPORT_FILE = /STANDING-ORDERS-REPORT-[0-9a-f]{16}\.json/;
const PARK_FILE = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/;

describe("the report parser (422 rule)", () => {
  test("a well-formed report parses; every problem is reported at once; caps and controls refuse", () => {
    const good = parseReport(JSON.stringify({ title: "Login flakes on CI", summary: "The test races the session cookie.", report: "## Findings\n…", followUps: [{ title: "Await the cookie", goal: "Wait for the cookie before asserting." }] }));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.report.followUps).toHaveLength(1);

    const bad = parseReport(JSON.stringify({ title: "a\nb", summary: "", report: 7, followUps: [{ title: "x" }, "y"] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const reasons = bad.problems.map(one => one.reason);
      expect(reasons).toContain("title-multiline");
      expect(reasons).toContain("missing-summary");
      expect(reasons).toContain("bad-report");
      expect(reasons).toContain("missing-followUps[0].goal");
      expect(reasons).toContain("followUps[1]-shape");
    }
    const tooMany = parseReport(JSON.stringify({ title: "t", summary: "s", report: "r", followUps: Array.from({ length: REPORT_LIMITS.followUps + 1 }, () => ({ title: "t", goal: "g" })) }));
    expect(tooMany.ok).toBe(false);
    const controls = parseReport(JSON.stringify({ title: "t", summary: "s\u001b[31m", report: "r" }));
    expect(controls.ok).toBe(false);
    expect(parseReport("not json").ok).toBe(false);
  });
});

describe("scout tasks, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let prompts: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));

  const run = (argv: string[], runner: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: runner });
  };

  /** A scout that concludes with a well-formed report. */
  const reportingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          title: "Login flakes because the cookie races the assertion",
          summary: "The login test reads the session cookie before the response sets it; under load the read wins.",
          report: "## Findings\nThe cookie is set asynchronously in src/session.ts.\n",
          followUps: [{ title: "Await the session cookie in the login test", goal: "The login test waits for the cookie before asserting; no more flakes in 50 runs." }],
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that needs the operator first. */
  const askingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = PARK_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          urgency: "blocking",
          recap: "Two suites fail differently.",
          question: "Which suite matters?",
          options: [
            { id: "unit", label: "Unit", consequence: "Faster, narrower.", reversible: true },
            { id: "e2e", label: "End to end", consequence: "Slower, the real flake.", reversible: true },
          ],
          recommendation: "e2e",
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that edits the repo — the one thing it must never do. */
  const vandalAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "sneaky.ts"), "export const smuggled = true;\n");
      if (name !== undefined) {
        await writeFile(join(cwd, name), JSON.stringify({ title: "t", summary: "s", report: "r" }));
      }
    }
    return { ...OK, stdout: SAID };
  };

  const malformedAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify({ title: "", report: 42 }));
    return { ...OK, stdout: SAID };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-scout-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    prompts = [];
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
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      store.close();
    }
    await run(["approver", "add", "alex", "--json"], reportingAgent);
    const approverToken = payload().token as string;
    await run(["task", "add", "why does login flake", "--id", "flaky", "--repo", repo, "--report", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    await run(["task", "scope", "flaky", "--goal", "Find out why the login test flakes on CI and say what would fix it", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    const store = openStore(db);
    const digest = store.getScope("flaky")?.digest as string;
    expect(store.refFor("built-in", "flaky").deliverable).toBe("report");
    store.close();
    await run(["task", "approve", "flaky", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], agent, now);

  test("the whole road: filed --report, approved, scouted, reported — a report, never a branch; the follow-up files with the scout's authorship", async () => {
    const { runnerToken } = await setup();

    const reported = await tick(runnerToken, reportingAgent);
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    // The brief carried the goal as data and named the report protocol file.
    expect(prompts.some(one => one.includes("You are a SCOUT") && one.includes("Find out why the login test flakes"))).toBe(true);

    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.getTask("flaky")?.state).toBe("done");
    const runs = store.runsFor(ref.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: "scout", outcome: "built", reason: "report-delivered" });
    expect(store.latestReportArtifact(ref.id)).not.toBeNull();
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view).not.toBeNull();
    if (view !== null && view.ok) {
      expect(view.report.title).toContain("cookie races");
      expect(view.report.followUps[0]?.title).toContain("Await the session cookie");
    }
    // Routine, not urgent: the outbox row carries the summary and no push class.
    const ready = store.listNotifications("all").find(one => one.kind === "report-ready");
    expect(ready).toBeDefined();
    expect(ready?.pushClass).toBeNull();
    expect(ready?.body).toContain("the session cookie");
    // No builder branch was ever created; the scout's disposable one is its own namespace.
    expect((await git(["rev-parse", "--verify", "--quiet", "refs/heads/standing-orders/flaky"])).code).not.toBe(0);
    expect(store.pendingPublications()).toHaveLength(0);

    // The follow-up files through the one door with the scout's authorship — mode coverage never seals it.
    const filed = fileTaskProposal(store, { title: "Await the session cookie", repo, goal: "wait first", filedVia: "console", proposedVia: "scout" }, T0);
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(store.handle.prepare("SELECT proposed_via FROM task_scope WHERE task_id = ?").get(filed.id)?.["proposed_via"]).toBe("scout");
      expect(store.refFor("built-in", filed.id).deliverable).toBe("branch");
    }
    store.close();

    // task show prints the report's title and summary.
    await run(["task", "show", "flaky"], reportingAgent);
    expect(lines.join("\n")).toContain("report: Login flakes because the cookie races the assertion");
    expect(lines.join("\n")).toContain("follow-up 1: Await the session cookie");
  });

  test("a scout that touches the tree gets nothing ingested; the task takes a strike and backs off; the deliverable never changes after filing", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, vandalAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(ref.strikes).toBe(1);
    expect(ref.planStrikes).toBe(0);
    expect(store.getTask("flaky")?.state).toBe("queued");
    expect(store.latestReportArtifact(ref.id)).toBeNull();
    expect(store.activeHolds(ref.id, T0).some(one => one.ownerKind === "backoff")).toBe(true);
    expect(store.setDeliverable(ref.id, "branch", T0)).toEqual({ ok: false, reason: "scoped" });
    store.close();
  });

  test("a malformed report is a durable incident, not a silent retry", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, malformedAgent);
    expect(failed).toBe(EXIT.failed);
    const store = openStore(db);
    expect(store.openIncidents().some(one => one.kind === "malformed-report")).toBe(true);
    expect(store.refFor("built-in", "flaky").strikes).toBe(0);
    store.close();
    const again = await tick(runnerToken, reportingAgent, new Date(T0.getTime() + 60_000));
    expect(again).toBe(EXIT.refused);
  });

  test("a scout may park a question; the answer rides the next brief and the report lands", async () => {
    const { runnerToken, approverToken } = await setup();
    const asked = await tick(runnerToken, askingAgent);
    expect(asked).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "parked" }));
    const store = openStore(db);
    const decision = store.listDecisions("unanswered")[0];
    expect(decision?.question).toBe("Which suite matters?");
    store.close();
    await run(["decide", String(decision?.id), "--choose", "e2e", "--as", "alex", "--token", approverToken, "--json"], reportingAgent, new Date(T0.getTime() + 60_000));
    const reported = await tick(runnerToken, reportingAgent, new Date(T0.getTime() + 2 * 60_000));
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(prompts.some(one => one.includes("Which suite matters?") && one.includes("e2e"))).toBe(true);
    const after = openStore(db);
    expect(after.getTask("flaky")?.state).toBe("done");
    expect(after.runsFor(after.refFor("built-in", "flaky").id).map(one => one.role).sort()).toEqual(["scout", "scout"]);
    after.close();
  });

  test("a builder never takes a report task: the claim gate refuses the role", async () => {
    const { runnerToken } = await setup();
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    const { acquireIfReady } = await import("./claim.js");
    const refused = acquireIfReady(store, ref.id, "builder-1", { now: T0, ttlMs: 60_000, dispatchRole: "builder", token: runnerToken });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("delivers a report");
    store.close();
  });
});
