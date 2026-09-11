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
import { register } from "./runner.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-12T22:00:00.000Z");
const SAID = JSON.stringify({ result: "planning" });
const saidInSession = (sessionId: string) => JSON.stringify({ result: "planning", session_id: sessionId });

const PLAN_FILE = /STANDING-ORDERS-PLAN-[0-9a-f]{16}\.json/;
const PARK_FILE = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/;

describe("planning mode, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let prompts: string[] = [];
  let plannerArgv: string[][] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const payload = () => JSON.parse(lines.join("\n"));

  const validPlanPayload = () => ({
    goal: "Guard the payout endpoint with a rate limiter",
    outOfScope: "No schema changes",
    touches: ["src/payouts.ts"],
    acceptance: [{ id: "c1", statement: "The payout endpoint is rate limited.", evidence: ["check"] }],
    plan: [
      "## Approach",
      "Wrap the existing handler in a sliding-window limiter.",
      "## Milestones",
      "1. Add the limiter at the payout boundary.",
      "2. Cover allowed and rejected requests.",
      "## Dependencies",
      "- The existing payout handler remains the request boundary.",
      "## Risks",
      "- Shared state may leak across tenants; key the limiter by tenant.",
      "## Proof",
      "- c1 — run the payout endpoint checks and capture their passing output.",
    ].join("\n"),
  });

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
    plannerArgv.push([...args]);
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = PLAN_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify(validPlanPayload()),
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
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
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
    plannerArgv = [];
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
    // CLI runner register is now a password ceremony (MCP spec v6) — the
    // fixture mints at store level below with a fixed token instead.
    const runnerToken = "tok-builder-1";
    // The runner gate (MCP spec v6): authority derives from the runner's
    // REGISTERED repos, not the --repo flag — bind this repo to the same
    // name and token the CLI just minted.
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      store.close();
    }
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

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
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
    expect(
      prompts.some(one =>
        one.includes("Each id is capped at 40 UTF-8 bytes, each statement at 300,") &&
        one.includes("each non-null how at 500") &&
        one.includes("Validate those byte limits"),
      ),
    ).toBe(true);
    expect(plannerArgv.some(args => args[args.indexOf("--permission-mode") + 1] === "acceptEdits")).toBe(true);

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

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
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

  test("a malformed plan is corrected in the same session with frozen authority and a truthful child run", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    let calls = 0;
    const seen: { args: string[]; timeoutMs: number | undefined }[] = [];
    const repairingAgent: Runner = async (_file, args, options) => {
      calls += 1;
      seen.push({ args: [...args], timeoutMs: options?.timeoutMs });
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        if (calls === 1) {
          await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
        } else {
          expect(prompt).toContain('"reason": "plan-preamble"');
          expect(prompt).toContain("goal, outOfScope, touches, and acceptance values are");
          await writeFile(join(cwd, name), JSON.stringify(validPlanPayload()));
        }
      }
      return { ...OK, stdout: saidInSession("planner-session-1") };
    };

    const planned = await tick(runnerToken, repairingAgent);
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    expect(calls).toBe(2);
    expect(seen[0]?.args).not.toContain("--resume");
    expect(seen[1]?.args).toEqual(
      expect.arrayContaining(["--resume", "planner-session-1", "--max-turns", "4"]),
    );
    expect(seen[1]?.timeoutMs).toBe(5 * 60_000);

    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ role: "planner", outcome: "built", reason: "plan-drafted", sessionId: "planner-session-1" });
    expect(runs[1]).toMatchObject({
      role: "planner",
      parentRun: runs[0]?.id,
      outcome: "no-change",
      reason: "structured planner output repaired",
      sessionId: "planner-session-1",
    });
    expect(runs[1]?.baseRevision).toBe(runs[0]?.baseRevision);
    const initialEvidence = store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output");
    const repairEvidence = store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(initialEvidence).toHaveLength(1);
    expect(initialEvidence[0]?.capture).toContain("not accepted");
    expect(repairEvidence).toHaveLength(1);
    expect(repairEvidence[0]?.capture).toContain("accepted");
    expect(store.getScope("limiter")).toMatchObject({
      goal: validPlanPayload().goal,
      outOfScope: validPlanPayload().outOfScope,
      touches: validPlanPayload().touches,
    });
    store.close();
  });

  test("two malformed corrections exhaust the fixed bound and form one linear causal trail", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    let calls = 0;
    const prompts: string[] = [];
    const brokenAgent: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      prompts.push(prompt);
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        const body = validPlanPayload();
        await writeFile(
          join(cwd, name),
          JSON.stringify({
            ...body,
            plan: calls === 1 ? "not a sectioned plan" : "## Approach\nStill missing the required sections.",
          }),
        );
      }
      if (calls > 1) {
        expect(args).toEqual(expect.arrayContaining(["--max-turns", "4"]));
        expect(options?.timeoutMs).toBe(5 * 60_000);
      }
      return { ...OK, stdout: saidInSession("broken-session-1") };
    };

    const failed = await tick(runnerToken, brokenAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(3);
    expect(prompts[1]).toContain('"reason": "plan-preamble"');
    expect(prompts[2]).toContain('"reason": "plan-missing-milestones"');

    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs).toHaveLength(3);
    expect(runs.map(one => one.parentRun)).toEqual([null, runs[0]?.id, runs[1]?.id]);
    expect(runs.map(one => one.outcome)).toEqual(["failed", "failed", "failed"]);
    expect(runs.map(one => store.artifactsFor(one.id).filter(artifact => artifact.kind === "structured-output").length)).toEqual([1, 1, 1]);
    store.close();
  });

  test("a correction that emits no bytes stops instead of spending a second repair turn", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const silentCorrection: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (calls === 1 && name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
      }
      return { ...OK, stdout: saidInSession("silent-repair-session") };
    };

    expect(await tick(runnerToken, silentCorrection)).toBe(EXIT.failed);
    expect(calls).toBe(2);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
    store.close();
  });

  test("repair cannot rewrite a parseable plan's authority fields", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const authorityProbe: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (calls === 3) expect(prompt).toContain('"reason": "authority-changed"');
      if (name !== undefined && cwd !== "") {
        const body = validPlanPayload();
        await writeFile(
          join(cwd, name),
          JSON.stringify(
            calls === 1
              ? { ...body, plan: "bad plan shape" }
              : calls === 2
                ? { ...body, goal: "A broader replacement goal" }
                : body,
          ),
        );
      }
      return { ...OK, stdout: saidInSession("authority-session-1") };
    };

    expect(await tick(runnerToken, authorityProbe)).toBe(EXIT.ok);
    expect(calls).toBe(3);
    const store = openStore(db);
    expect(store.getScope("limiter")?.goal).toBe(validPlanPayload().goal);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs.map(one => one.parentRun)).toEqual([null, runs[0]?.id, runs[1]?.id]);
    expect(runs[1]).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
    expect(runs[2]).toMatchObject({ outcome: "no-change", reason: "structured planner output repaired" });
    store.close();
  });

  test("a correction that does not re-announce the exact session is rejected but its payload is still sealed", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const switchedSession: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, name),
          JSON.stringify(calls === 1 ? { ...validPlanPayload(), plan: "not a sectioned plan" } : validPlanPayload()),
        );
      }
      return { ...OK, stdout: calls === 1 ? saidInSession("original-session") : SAID };
    };

    expect(await tick(runnerToken, switchedSession)).toBe(EXIT.failed);
    expect(calls).toBe(2);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "provider-protocol" }),
    );
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[1]).toMatchObject({ role: "planner", outcome: "refused", reason: "provider-protocol" });
    const rejected = store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.capture).toContain("not accepted");
    expect(store.getScope("limiter")).toBeNull();
    store.close();
  });

  test("a malformed planner reply without a session id does not start a fresh correction", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const noSession: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
      }
      return { ...OK, stdout: SAID };
    };

    expect(await tick(runnerToken, noSession)).toBe(EXIT.failed);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    expect(store.runsFor(ref.id).filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(store.runsFor(ref.id)[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test("an unparseable plan is preserved but never reconstructed as a formatting correction", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const unparseable: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), "{ definitely not JSON");
      return { ...OK, stdout: saidInSession("unparseable-session") };
    };

    expect(await tick(runnerToken, unparseable)).toBe(EXIT.failed);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test.each([
    ["an invalid goal", (body: ReturnType<typeof validPlanPayload>) => ({ ...body, goal: 42 })],
    ["an empty acceptance rubric", (body: ReturnType<typeof validPlanPayload>) => ({ ...body, acceptance: [] })],
  ])("%s is authority failure and never enters structured repair", async (_label, malformed) => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const invalidAuthority: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify(malformed(validPlanPayload())));
      }
      return { ...OK, stdout: saidInSession("invalid-authority-session") };
    };

    expect(await tick(runnerToken, invalidAuthority)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner");
    expect(runs).toHaveLength(1);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    expect(store.getScope("limiter")).toBeNull();
    store.close();
  });

  test("pathologically deep authority is a typed malformed plan, never a planner crash", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const hostileShape: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        // This remains under the mailbox byte cap, but recursive authority
        // canonicalization would overflow the JS stack without its boundary.
        const nested = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
        await writeFile(
          join(cwd, name),
          `{"goal":${nested},"outOfScope":null,"touches":[],"acceptance":[],"plan":"bad"}`,
        );
      }
      return { ...OK, stdout: saidInSession("deep-authority-session") };
    };

    expect(await tick(runnerToken, hostileShape)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test("invalid UTF-8 is preserved as evidence and is never repaired as invented text", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const invalidUtf8: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
      return { ...OK, stdout: saidInSession("invalid-utf8-session") };
    };

    expect(await tick(runnerToken, invalidUtf8)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).find(one => one.kind === "structured-output")).toMatchObject({
      bytesOriginal: 5,
      bytesStored: 5,
      captureStatus: "failed",
    });
    store.close();
  });

  test("a non-file decision path fails closed without asking the session to invent a question", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const nonFileDecision: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PARK_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await mkdir(join(cwd, name));
      return { ...OK, stdout: saidInSession("non-file-decision-session") };
    };

    expect(await tick(runnerToken, nonFileDecision)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-decision" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(0);
    store.close();
  });

  test("an oversized plan keeps a bounded evidence prefix and its true byte count", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const bytes = 64 * 1024 + 137;
    const oversized: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), "x".repeat(bytes));
      return { ...OK, stdout: saidInSession("oversized-session") };
    };

    expect(await tick(runnerToken, oversized)).toBe(EXIT.failed);
    const store = openStore(db);
    const plannerRun = store.runsFor(store.refFor("built-in", "limiter").id)[0];
    const attempt = store.artifactsFor(plannerRun?.id ?? -1).find(one => one.kind === "structured-output");
    expect(attempt).toMatchObject({ bytesOriginal: bytes, bytesStored: 64 * 1024, truncated: true, captureStatus: "failed" });
    store.close();
  });

  test("a whole-payload JSON fence is normalized without spending a correction turn", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const fenced: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), `\uFEFF\`\`\`json\n${JSON.stringify(validPlanPayload())}\n\`\`\``);
      }
      return { ...OK, stdout: SAID };
    };

    expect(await tick(runnerToken, fenced)).toBe(EXIT.ok);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    const structured = store.artifactsFor(runs.find(one => one.role === "planner")?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(structured).toHaveLength(1);
    expect(structured[0]?.capture).toContain("accepted, syntax normalized");
    store.close();
  });

  test("a malformed decision repairs in-session and links a canonical parent payload", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const decision = {
      urgency: "blocking",
      recap: "The repository supports two safe limiter keys.",
      question: "Which key should the limiter use?",
      options: [
        { id: "user", label: "Per user", consequence: "Finer fairness.", reversible: true },
        { id: "tenant", label: "Per tenant", consequence: "Less state.", reversible: true },
      ],
      recommendation: "user",
    };
    const agentWithRepair: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PARK_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, name),
          JSON.stringify(calls === 1 ? { ...decision, options: decision.options.slice(0, 1) } : decision),
        );
      }
      return { ...OK, stdout: saidInSession("decision-session-1") };
    };

    expect(await tick(runnerToken, agentWithRepair)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));
    expect(calls).toBe(2);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[1]).toMatchObject({
      role: "planner",
      parentRun: runs[0]?.id,
      outcome: "no-change",
      reason: "structured planner output repaired",
    });
    const parentPayload = store.artifactsFor(runs[0]?.id ?? -1).find(one => one.kind === "park-payload");
    expect(parentPayload?.capture).toContain(`canonical validated planner decision repaired by run ${runs[1]?.id}`);
    expect(store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "park-payload")).toHaveLength(0);
    expect(store.listDecisions("unanswered")[0]?.question).toBe(decision.question);
    store.close();
  });

  test("writing both a question and a plan is malformed instead of silently prioritizing either", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const both: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const planName = PLAN_FILE.exec(prompt)?.[0];
      const parkName = PARK_FILE.exec(prompt)?.[0];
      if (cwd !== "" && planName !== undefined && parkName !== undefined) {
        await writeFile(join(cwd, planName), JSON.stringify(validPlanPayload()));
        await writeFile(
          join(cwd, parkName),
          JSON.stringify({
            urgency: "blocking",
            recap: "There is a choice.",
            question: "Proceed?",
            options: [
              { id: "yes", label: "Yes", consequence: "Continue.", reversible: true },
              { id: "no", label: "No", consequence: "Stop.", reversible: true },
            ],
            recommendation: "yes",
          }),
        );
      }
      return { ...OK, stdout: saidInSession("ambiguous-session") };
    };

    expect(await tick(runnerToken, both)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    expect(store.getScope("limiter")).toBeNull();
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    const plannerRun = store.runsFor(store.refFor("built-in", "limiter").id).find(one => one.role === "planner");
    expect(store.artifactsFor(plannerRun?.id ?? -1).find(one => one.kind === "structured-output")?.capture).toContain("not accepted");
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

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
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
