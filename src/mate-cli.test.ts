import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate } from "./operate.js";

const T0 = new Date("2026-09-02T12:00:00.000Z");
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const answer = (blocks: Block[]) =>
  new Response(JSON.stringify({ type: "message", content: blocks, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
const text = (value: string) => answer([{ type: "text", text: value }]);

describe("standing-orders chat (mate arc, slice 3): the thread from a terminal", () => {
  let dir: string;
  let db: string;
  let repo: string;
  let token: string;
  let lines: string[];
  let script: (() => Response)[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standing-orders-mate-cli-"));
    db = join(dir, "orders.db");
    await mkdir(join(dir, "repo"));
    repo = realpathSync(join(dir, "repo"));
    const store = openStore(db);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 100_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", T0);
    for (const id of ["a", "b"]) {
      const made = store.createConsoleTask({ id, title: `task ${id}`, repo, goal: `do ${id}`, filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    store.close();
    lines = [];
    script = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], input: string[] = [], env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-test" }) => {
    lines = [];
    const [command = "", ...rest] = argv;
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now: T0,
      mateSeams: {
        env,
        lines: input,
        fetcher: (async () => {
          const next = script.shift();
          if (next === undefined) throw new Error("the script ran out");
          return next();
        }) as typeof fetch,
      },
    });
  };
  const out = () => lines.join("\n");

  test("refusals are typed and precede any spend: credentials, key, ceiling", async () => {
    expect(await run(["chat", "--json"])).toBe(2);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "usage" });
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--json"], [], {})).toBe(3);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "no-key", message: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(await run(["chat", "--as", "alex", "--token", token, "--json"])).toBe(2);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "empty-ceiling" });
    expect(await run(["chat", "--as", "alex", "--token", "wrong", "--repo", repo, "--json"])).toBe(3);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "unauthenticated" });
    const store = openStore(db);
    expect(store.activeMateSession("alex", T0)).toBeNull();
    store.close();
  });

  test("--say mints the session with the password once, runs one turn, and lists the proposals", async () => {
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_next", input: { task: "b" } }]),
      () => text("I propose moving b to the front."),
    );
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--say", "what should move?"])).toBe(0);
    expect(out()).toContain("mate session minted: up to $5.00 until 2026-09-02 16:00Z over r1 repo");
    expect(out()).toContain("read 0 · proposed 1 · 2 steps");
    expect(out()).toContain("I propose moving b to the front.");
    expect(out()).toContain("1. move b to the front (was 2 of 2)");
    const store = openStore(db);
    expect(store.activeMateSession("alex", T0)).toMatchObject({ approver: "alex", ceilingMicrousd: 5_000_000 });
    expect(store.listMateProposals(1, ["pending"])).toHaveLength(1);
    store.close();
    // The next run finds the session live and the thread intact; --json gives one envelope per turn.
    script.push(() => text("still b."));
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--say", "sure?", "--json"])).toBe(0);
    const envelope = JSON.parse(out()) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ok: true, command: "chat", reply: "still b.", proposals: [{ id: 1, kind: "next" }] });
  });

  test("the REPL: text is a turn, `confirm N` runs the door, `open N` prints the task, `end` forgets the thread", async () => {
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_next", input: { task: "b" } }, { type: "tool_use", id: "c2", name: "propose_hold", input: { task: "a", reason: "later" } }]),
      () => text("Two proposals."),
    );
    const code = await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--ceiling-usd", "20", "--hours", "2"], ["what next?", "proposals", "open 2", "confirm 1", "confirm 1", "dismiss 1", "confirm 9", "confirm 2", "end"]);
    expect(code).toBe(0);
    const printed = out();
    expect(printed).toContain("up to $20.00 until 2026-09-02 14:00Z");
    expect(printed).toContain("Two proposals.");
    expect(printed).toContain("1. move b to the front (was 2 of 2)");
    expect(printed).toContain("2. hold a: later");
    expect(printed).toContain("a · task a · queued");
    expect(printed).toContain("b moved to the front of its column");
    // Ordinals are stable for the run (slice-2 review, finding 4): 1 stays the confirmed move, 2 stays the hold.
    expect(printed).toContain("proposal 1 is confirmed: b moved to the front of its column");
    expect(printed).toContain("no proposal 9");
    expect(printed).toContain("a held: later");
    expect(printed).toContain("the session is over and the thread is forgotten");
    const store = openStore(db);
    expect(store.queuePosition("b")?.position).toBe(1);
    expect(store.activeHolds(store.refFor("built-in", "a").id, T0).map(one => one.reason)).toEqual(["later"]);
    expect(store.activeMateSession("alex", T0)).toBeNull();
    expect(store.listMateMessages(1, 10)).toEqual([]);
    store.close();
  });

  test("without --repo the ceiling is the enrolled registry beside the database, never the opened-project history", async () => {
    const { saveRepos } = await import("./repos.js");
    await saveRepos(join(dir, "repos.json"), [repo]);
    script.push(() => text("all quiet in r1."));
    expect(await run(["chat", "--as", "alex", "--token", token, "--say", "how are things?"])).toBe(0);
    expect(out()).toContain("over r1 repo");
    expect(out()).toContain("all quiet in r1.");
  });

  test("a live session minted under another provider key refuses in words rather than looping", async () => {
    script.push(() => text("hi"));
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--say", "hi"])).toBe(0);
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--say", "hi", "--json"], [], { ANTHROPIC_API_KEY: "sk-other" })).toBe(3);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "key-mismatch" });
  });

  test("an irreversible answer takes `confirm N yes`", async () => {
    const store0 = openStore(db);
    const runId = store0.startRun({ taskRef: store0.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store0.saveDecision({ run: runId, urgency: "blocking", recap: "r", question: "Which?", options: [{ id: "y", label: "Y", consequence: "cy", reversible: false }], recommendation: "y" }, T0);
    store0.close();
    script.push(
      () => answer([{ type: "tool_use", id: "c0", name: "get_decision", input: { decision: 1 } }]),
      () => answer([{ type: "tool_use", id: "c1", name: "propose_answer", input: { decision: 1, option: "y", rationale: "only option" } }]),
      () => text("I propose Y."),
    );
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo], ["decide", "confirm 1", "confirm 1 yes", "quit"])).toBe(0);
    expect(out()).toContain('answer decision #1 on a with "Y" (irreversible — confirm N yes)');
    // The terminal shows the question, the consequence, and the builder's recommendation before any confirm (v3 review, finding 4).
    expect(out()).toContain("     Which?");
    expect(out()).toContain("     → Y (irreversible) — the builder recommends this: cy");
    expect(out()).toContain("an irreversible choice must be confirmed explicitly: confirm 1 yes");
    expect(out()).toContain("decision #1 answered: Y");
    const after = openStore(db);
    expect(after.getDecision(1)).toMatchObject({ state: "answered", answeredVia: "cli" });
    after.close();
  });

  test("--end ends a live session; a stale card refuses in words; a password-class act points at its ceremony", async () => {
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_scope", input: { task: "a", goal: "a better goal" } }, { type: "tool_use", id: "c2", name: "propose_next", input: { task: "b" } }]),
      () => text("Two."),
    );
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--say", "improve a"])).toBe(0);
    expect(out()).toContain("rewrite the scope of a (then approve it: standing-orders task approve a)");
    // The queue moves by hand before the card is confirmed.
    const store = openStore(db);
    store.moveTaskNext("a", T0);
    store.close();
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo], ["confirm 2", "confirm 1", "quit"])).toBe(0);
    expect(out()).toContain("refused: the queue moved since this was proposed");
    expect(out()).toContain("a's scope rewritten — approve it with your password on the task");
    expect(out()).toContain("standing-orders task approve a");
    const after = openStore(db);
    expect(after.getScope("a")).toMatchObject({ goal: "a better goal", approvedAt: null });
    expect(after.sealScopeApproval("a", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    after.close();
    expect(await run(["chat", "--as", "alex", "--token", token, "--repo", repo, "--end", "--json"])).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ ok: true, ended: { sessions: 1 } });
  });
});
