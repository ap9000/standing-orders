/**
 * Routines end to end, against real git: a person approves the standing
 * order once, and from then on the pass fires instances that build
 * unattended — each an ordinary task with an ordinary approved scope,
 * strikes, and evidence. Only the agent is a stub.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { approveRoutine, routineDigestOf, type RoutineTerms } from "./routine.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-13T22:00:00.000Z");
const HOUR = 60 * 60_000;
const SAID = JSON.stringify({ result: "done" });

describe("routines, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));

  const run = (argv: string[], runner: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  /** A builder that writes real work and concludes done. */
  const buildingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const done = /NIGHTORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, `work-${Date.now()}.md`), "refreshed\n");
      if (done !== undefined) {
        await writeFile(
          join(cwd, done),
          JSON.stringify({ version: 1, status: "completed", conclusion: "Routine work done." }),
        );
      }
    }
    return { ...OK, stdout: SAID };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-routine-")));
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

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      agent,
      now,
    );

  test("approve once; the pass fires, the instance builds, the track repeats on schedule", async () => {
    await run(["runner", "register", "builder-1", "--json"], buildingAgent);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"], buildingAgent);
    const approverToken = payload().token as string;

    // The standing order, filed and approved directly against the store —
    // the CLI ceremony has its own tests; this one is about the loop.
    const terms: RoutineTerms = {
      repo,
      goal: "Refresh the notes file and record anything odd",
      outOfScope: "Nothing outside the repo",
      touches: [],
      requirements: [],
      schedule: "every:60",
      singleFlight: true,
      costCeilingUsd: null,
    };
    const store = openStore(db);
    const created = store.createRoutine(
      { name: "notes", ...terms, digest: routineDigestOf(terms) },
      T0,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const approved = approveRoutine(store, created.id, "alex", T0, routineDigestOf(terms), approverToken);
    expect(approved.ok).toBe(true);
    store.close();

    // Before the first slot: the pass has nothing — no routine fires early.
    const early = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + HOUR / 2));
    expect(early).toBe(EXIT.refused);
    expect(payload().routines).toEqual([]);

    // The slot arrives: the SAME pass fires the instance and builds it,
    // no human hand anywhere — that is what the template approval bought.
    const fired = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + HOUR + 60_000));
    expect(fired).toBe(EXIT.ok);
    const first = payload();
    expect(first.routines).toContainEqual(
      expect.objectContaining({ routine: "notes", outcome: "fired", taskId: "notes-20260813-2300" }),
    );
    expect(first.dispatched).toContainEqual(
      expect.objectContaining({ id: "notes-20260813-2300", outcome: "built" }),
    );

    // The instance is an ordinary task: done, on its own branch.
    const after = openStore(db);
    expect(after.getTask("notes-20260813-2300")?.state).toBe("done");
    expect(after.refFor("built-in", "notes-20260813-2300").routineId).toBe(created.id);
    after.close();
    const log = await git(["log", "--oneline", "standing-orders/notes-20260813-2300"]);
    expect(log.stdout).toContain("notes");

    // Next slot: the track repeats — a second instance, same terms.
    const again = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + 2 * HOUR + 60_000));
    expect(again).toBe(EXIT.ok);
    expect(payload().routines).toContainEqual(
      expect.objectContaining({ routine: "notes", outcome: "fired" }),
    );

    // The ledger holds both firings, newest first, both green.
    const ledger = openStore(db);
    const fires = ledger.routineFires(created.id);
    expect(fires.map(one => one.outcome)).toEqual(["fired", "fired"]);
    expect(fires.every(one => one.instanceTaskRef !== null)).toBe(true);
    ledger.close();
  });

  test("a stuck instance stops the track and pages, instead of stacking twins", async () => {
    await run(["runner", "register", "builder-1", "--json"], buildingAgent);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"], buildingAgent);
    const approverToken = payload().token as string;

    const terms: RoutineTerms = {
      repo,
      goal: "Try the flaky thing",
      outOfScope: null,
      touches: [],
      requirements: [],
      schedule: "every:60",
      singleFlight: true,
      costCeilingUsd: null,
    };
    const store = openStore(db);
    const created = store.createRoutine(
      { name: "flaky", ...terms, digest: routineDigestOf(terms) },
      T0,
    );
    if (!created.ok) throw new Error("setup");
    approveRoutine(store, created.id, "alex", T0, routineDigestOf(terms), approverToken);
    store.close();

    // A builder that always breaks: the instance fails and stays unfinished.
    const breakingAgent: Runner = async () => ({ ...OK, code: 1, stderr: "boom" });
    const fired = await tick(runnerToken, breakingAgent, new Date(T0.getTime() + HOUR + 60_000));
    expect(fired).toBe(EXIT.failed);

    // The next slot does not spawn a twin beside the wreck: the slot skips
    // on the ledger and the stuck instance pages once.
    const skipped = await tick(runnerToken, breakingAgent, new Date(T0.getTime() + 2 * HOUR + 60_000));
    void skipped; // exit code belongs to the retry story, not the track's
    const after = openStore(db);
    const fires = after.routineFires(created.id);
    expect(fires[0]).toMatchObject({ outcome: "skipped" });
    expect(fires[0]?.reason).toContain("single-flight");
    const pages = after.listNotifications("all").filter(one => one.kind === "routine-blocked");
    expect(pages).toHaveLength(1);
    after.close();
  });
});
