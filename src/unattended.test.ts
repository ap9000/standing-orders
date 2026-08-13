/**
 * The M4 acceptance sentence, executable: queue twelve, sleep, wake to PRs —
 * with near-zero idle spend, every failure typed, and nothing lost between.
 *
 * One fake-clocked unattended stretch against real git: clean builds, a stated
 * no-change, a park answered by a person mid-stretch, three strikes and an
 * authenticated requeue, a transient timeout that backs off and recovers,
 * a dependency chain, a scope approved while the stretch runs, and a
 * duplicate pass that finds nothing to do twice. The zero-token invariant
 * is asserted as arithmetic: provider spawns == runs stamped before
 * spending, exactly.
 *
 * Built-in backend only, stated: external-backend dispatch is deferred in
 * writing (PROGRESS.md), so the twelve live in the built-in queue. The
 * Telegram disconnect path is proved in telegram.test.ts (the follower's
 * backoff); this stretch answers its park through the CLI.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec, type ExecResult, type RunOptions } from "./exec.js";
import { openStore } from "./store.js";

type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<ExecResult>;

const T0 = new Date("2026-08-12T22:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

const TASKS = Array.from({ length: 12 }, (_, index) => `t-${String(index + 1).padStart(2, "0")}`);

describe("the night: twelve tasks, one fake clock", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let spawns = 0;
  const failuresSoFar = new Map<string, number>();

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  /** One agent for the whole fleet, its behavior chosen by the task in its brief. */
  const nightAgent: Runner = async (_file, args, options) => {
    spawns++;
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const taskId = /\bt-\d\d\b/.exec(prompt)?.[0] ?? "?";
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];

    const conclude = async (status: "completed" | "no-change") => {
      if (done !== undefined && cwd !== "") {
        await writeFile(join(cwd, done), JSON.stringify({ version: 1, status, conclusion: `${taskId}: ${status}.` }));
      }
    };

    // t-05 concludes honestly that nothing needed changing.
    if (taskId === "t-05") {
      await conclude("no-change");
      return { ...OK, stdout: "{}" };
    }

    // t-06 parks once — a judgement call for a person — then builds on resume.
    if (taskId === "t-06" && !failuresSoFar.has("t-06-parked")) {
      failuresSoFar.set("t-06-parked", 1);
      if (mailbox !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, mailbox),
          JSON.stringify({
            urgency: "blocking",
            recap: "The cache can be keyed by user or by tenant.",
            question: "Key the cache by user, or by tenant?",
            options: [
              { id: "user", label: "By user", consequence: "More entries, simpler invalidation.", reversible: true },
              { id: "tenant", label: "By tenant", consequence: "Fewer entries, broader invalidation.", reversible: true },
            ],
            recommendation: "tenant",
          }),
        );
      }
      return { ...OK, stdout: "{}" };
    }

    // t-07 reports failure three times before the person intervenes.
    if (taskId === "t-07" && (failuresSoFar.get("t-07") ?? 0) < 3) {
      failuresSoFar.set("t-07", (failuresSoFar.get("t-07") ?? 0) + 1);
      return { ...OK, code: 1, stderr: "the model refused to cooperate" };
    }

    // t-08 times out once — infrastructure, not the work — then recovers.
    if (taskId === "t-08" && !failuresSoFar.has("t-08")) {
      failuresSoFar.set("t-08", 1);
      return { ...OK, code: 124, timedOut: true };
    }

    if (cwd !== "") await writeFile(join(cwd, `${taskId}.ts`), `export const built = "${taskId}";\n`);
    await conclude("completed");
    return { ...OK, stdout: JSON.stringify({ result: `${taskId} built.` }) };
  };

  const run = (argv: string[], now: Date) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: nightAgent,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-night-"));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    spawns = 0;
    failuresSoFar.clear();
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

  test("queue twelve, sleep, wake to PRs", async () => {
    // -- Evening: credentials, twelve tasks, eleven approved scopes, one
    // dependency, one publication grant with its terms agreed to.
    await run(["runner", "register", "builder-1", "--json"], T0);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"], T0);
    const approverToken = payload().token as string;

    for (const id of TASKS) {
      await run(["task", "add", `night work ${id}`, "--id", id], T0);
      await run(["task", "scope", id, "--goal", `do exactly ${id}`], T0);
    }
    // t-10's approval deliberately waits until the night is underway.
    for (const id of TASKS.filter(one => one !== "t-10")) {
      await run(["task", "approve", id, "--json"], T0);
      const digest = payload().scope.digest as string;
      await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken], T0);
    }
    await run(["task", "block", "t-09", "--on", "t-01"], T0);
    await run([
      "publish", "grant", "--github", "alex/thing", "--repo", repo,
      "--yes", "--as", "alex", "--token", approverToken, "--json",
    ], T0);
    expect(payload().granted).toBe(true);

    const tick = (minutes: number) =>
      run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--max", "12", "--json"], at(minutes));

    // -- The night, tick by tick, the clock advancing between.
    await tick(0);      // most build; t-05 no-change; t-06 parks; t-07 and t-08 strike once and back off
    await tick(3);      // backoffs (1m) lapsed: t-08 recovers, t-07 strikes again; t-09 follows t-01
    await run(["decide", "--json"], at(4));
    const decisionId = payload().waiting[0].id as number;
    await run(["decide", String(decisionId), "--choose", "tenant", "--as", "alex", "--token", approverToken], at(4));
    await tick(7);      // t-06 resumes with the answer in its brief; t-07's third strike stalls it
    await tick(12);     // whatever backoff remains lapses; nothing for t-07 — it is held, not looping

    // The stall is a typed incident, not a mystery.
    const mid = openStore(db);
    const stalled = mid.openIncidents().find(one => one.taskId === "t-07");
    expect(stalled?.kind).toBe("attempts-exhausted");
    mid.close();

    // -- The person, briefly awake: requeue the stall, approve the late scope.
    await run(["task", "requeue", "t-07", "--as", "alex", "--token", approverToken, "--json"], at(15));
    expect(payload().ok).toBe(true);
    await run(["task", "approve", "t-10", "--json"], at(15));
    const digest10 = payload().scope.digest as string;
    await run(["task", "approve", "t-10", "--yes", "--digest", digest10, "--as", "alex", "--token", approverToken], at(15));

    await tick(16);     // t-07 (strikes reset) and t-10 build

    // -- Duplicate pass: an empty queue refuses, idempotently — twice.
    expect(await tick(20)).toBe(EXIT.refused);
    expect(payload().reason).toBe("empty");
    expect(await tick(21)).toBe(EXIT.refused);

    // -- Morning. Every task finished; the ledger can say how.
    const store = openStore(db);
    try {
      for (const id of TASKS) {
        expect(store.getTask(id)?.state, id).toBe("done");
      }

      // The zero-token invariant, as arithmetic: every provider spawn was
      // stamped before it spent, and nothing spent unstamped.
      const stamped = store.handle
        .prepare("SELECT COUNT(*) AS n FROM run WHERE provider_started_at IS NOT NULL")
        .get();
      expect(Number(stamped?.["n"])).toBe(spawns);

      // Eleven publications owed — the no-change honestly published nothing.
      const pending = store.pendingPublications();
      expect(pending).toHaveLength(11);
      expect(pending.every(one => one.state === "intended")).toBe(true);
    } finally {
      store.close();
    }

    // -- The PRs, against a scripted gh: push each exact SHA, open each PR.
    let prNumber = 100;
    const publishExec = async (file: string, args: readonly string[]) => {
      if (file === "gh" && args[1] === "list") return { ...OK, stdout: "[]" };
      if (file === "gh" && args[1] === "create") {
        prNumber++;
        return { ...OK, stdout: `https://github.com/alex/thing/pull/${prNumber}\n` };
      }
      return { ...OK };
    };
    lines = [];
    const published = await runOperate(
      "publish",
      ["--repo", repo, "--json"],
      line => lines.push(line),
      { databaseFile: db, now: at(30), publishExec },
    );
    expect(published).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ pushed: 11, opened: 11, failed: 0 });

    // -- The brief tells the same story from the same rows.
    await run(["brief", "--local", "--repo", repo, "--since", T0.toISOString(), "--json"], at(31));
    const brief = payload();
    expect(brief.tally.built).toHaveLength(12); // 11 commits + 1 honest no-change
    expect(brief.decide).toHaveLength(0);
    expect(brief.incidents).toHaveLength(0);
    expect(brief.stranded).toHaveLength(0);
  }, 120_000);
});
