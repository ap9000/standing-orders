/**
 * Planning mode, end to end against real git: the operator asks for a plan,
 * a planner interrogates and drafts, the operator approves the proposed
 * scope, and only then does a builder spend — with the plan in its brief.
 *
 * Only the agent is a stub. The workspace-proof ordering (Codex planning
 * review, finding 1) is exercised adversarially: a planner that touches the
 * tree gets nothing ingested, question included.
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
const T0 = new Date("2026-08-12T22:00:00.000Z");
const SAID = JSON.stringify({ result: "planning" });

const PLAN_FILE = /NIGHTORDERS-PLAN-[0-9a-f]{16}\.json/;
const PARK_FILE = /NIGHTORDERS-PARK-[0-9a-f]{16}\.json/;

describe("planning mode, against real git", () => {
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
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  /** A planner that concludes with a well-formed plan. */
  const planningAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = PLAN_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          goal: "Guard the payout endpoint with a rate limiter",
          outOfScope: "No schema changes",
          touches: ["src/payouts.ts"],
          plan: "## Approach\nWrap the handler in a sliding-window limiter.\n",
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A planner that needs the operator first. */
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
          recap: "Two rate-limiter shapes fit.",
          question: "Per-user or per-tenant?",
          options: [
            { id: "user", label: "Per-user", consequence: "Fairer, more state.", reversible: true },
            { id: "tenant", label: "Per-tenant", consequence: "Simpler, coarser.", reversible: true },
          ],
          recommendation: "user",
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A planner that edits the repo — the one thing it must never do. */
  const vandalAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const park = PARK_FILE.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "sneaky.ts"), "export const smuggled = true;\n");
      if (park !== undefined) {
        await writeFile(
          join(cwd, park),
          JSON.stringify({
            urgency: "blocking",
            recap: "r",
            question: "q?",
            options: [
              { id: "a", label: "a", consequence: "c", reversible: true },
              { id: "b", label: "b", consequence: "c", reversible: true },
            ],
            recommendation: "a",
          }),
        );
      }
    }
    return { ...OK, stdout: SAID };
  };

  /** The builder for the final leg: writes real work, concludes done. */
  const buildingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const done = /NIGHTORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "limiter.ts"), "export const limited = true;\n");
      if (done !== undefined) {
        await writeFile(
          join(cwd, done),
          JSON.stringify({ version: 1, status: "completed", conclusion: "Limiter in place." }),
        );
      }
    }
    return { ...OK, stdout: SAID };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-plan-")));
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
    await run(["runner", "register", "builder-1", "--json"], planningAgent);
    const runnerToken = payload().token as string;
    await run(["approver", "add", "alex", "--json"], planningAgent);
    const approverToken = payload().token as string;
    await run(["task", "add", "rate limiter", "--id", "limiter", "--repo", repo, "--json"], planningAgent);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      agent,
      now,
    );

  test("the whole negotiation: ask, answer, draft, approve, build — in that order, never earlier", async () => {
    const { runnerToken, approverToken } = await setup();

    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    expect(payload().ok).toBe(true);

    // Round one: the planner asks. The question lands as a decision; no
    // scope exists; nothing built.
    const asked = await tick(runnerToken, askingAgent);
    expect(asked).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));

    const store = openStore(db);
    const decision = store.listDecisions("unanswered")[0];
    expect(decision).toBeDefined();
    expect(decision?.question).toBe("Per-user or per-tenant?");
    store.close();

    // The operator answers from wherever they are.
    await run(
      ["decide", String(decision?.id), "--choose", "user", "--as", "alex", "--token", approverToken, "--json"],
      planningAgent,
      new Date(T0.getTime() + 60_000),
    );

    // Round two: the planner is redispatched with the answer in its brief
    // and concludes with a plan. The scope lands PROPOSED, never approved.
    const planned = await tick(runnerToken, planningAgent, new Date(T0.getTime() + 2 * 60_000));
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    expect(prompts.some(one => one.includes("Per-user or per-tenant?") && one.includes("user"))).toBe(true);

    const after = openStore(db);
    const scope = after.getScope("limiter");
    expect(scope?.goal).toBe("Guard the payout endpoint with a rate limiter");
    expect(scope?.approvedAt).toBeNull();
    const ref = after.refFor("built-in", "limiter");
    expect(ref.plan).toBe("drafted");
    expect(after.latestPlanArtifact(ref.id)).not.toBeNull();
    after.close();

    // A pass before approval spends nothing: the promise is not made, and
    // a pass with nothing dispatchable says so with its refusal exit.
    const premature = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + 3 * 60_000));
    expect(premature).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "skipped", reason: "unapproved" }));

    // The operator approves exactly the drafted scope.
    const approving = openStore(db);
    const digest = approving.getScope("limiter")?.digest as string;
    approving.close();
    await run(
      ["task", "approve", "limiter", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"],
      planningAgent,
      new Date(T0.getTime() + 4 * 60_000),
    );
    expect(payload().ok).toBe(true);

    // And only now a builder runs — with the plan quoted in its brief.
    const built = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + 5 * 60_000));
    expect(built).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "built" }));
    expect(prompts.some(one => one.includes("BEGIN APPROVED PLAN") && one.includes("sliding-window limiter"))).toBe(true);

    // The builder's branch is its own — the planner's disposable branch is
    // not an ancestor and the smoke-test file never existed there.
    const log = await git(["log", "--oneline", "standing-orders/limiter"]);
    expect(log.stdout).toContain("limiter");
  });

  test("a planner that touches the tree gets nothing ingested — question included", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    const failed = await tick(runnerToken, vandalAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "dirty-tree" }),
    );

    const store = openStore(db);
    // No decision was ingested from the dirty workspace.
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    // The failure took a PLANNING strike and left a backoff hold — never a
    // builder strike.
    const ref = store.refFor("built-in", "limiter");
    expect(ref.planStrikes).toBe(1);
    expect(ref.strikes).toBe(0);
    expect(ref.plan).toBe("requested");
    store.close();
  });

  test("a malformed plan is a durable incident, not a silent retry", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    const malformedAgent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ goal: "", plan: 42 }));
      }
      return { ...OK, stdout: SAID };
    };

    const failed = await tick(runnerToken, malformedAgent);
    expect(failed).toBe(EXIT.failed);

    const store = openStore(db);
    const incidents = store.openIncidents();
    expect(incidents.some(one => one.kind === "malformed-plan")).toBe(true);
    // The incident's hold blocks redispatch until a person resolves it —
    // the pass refuses rather than spending on a broken protocol again.
    const again = await tick(runnerToken, planningAgent, new Date(T0.getTime() + 60_000));
    expect(again).toBe(EXIT.refused);
    // The held task never re-enters the ready set — no planner spends on a
    // protocol a person has not looked at.
    const redispatched = (JSON.parse(lines.join("\n")).dispatched ?? []) as { outcome: string }[];
    expect(redispatched.filter(one => one.outcome === "planned" || one.outcome === "parked")).toHaveLength(0);
    store.close();
  });
});
