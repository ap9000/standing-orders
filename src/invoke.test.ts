/**
 * The invocation gateway: the only door to any provider, and the anchor of
 * the zero-token invariant — provider spawns == runs stamped before the
 * spawn, and every completed process's usage is read, exit code be damned.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { invokeAgent } from "./invoke.js";

const T0 = new Date("2026-08-12T06:00:00.000Z");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const CLAUDE = { provider: "claude" as const, model: null };
const ASK = {
  phase: "build" as const,
  brief: "hi",
  maxTurns: 10,
  permissionMode: "acceptEdits",
  skipPermissions: false,
  resumeSession: null,
};

describe("the invocation gateway", () => {
  let store: Store;
  let runId: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    runId = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      now: T0,
    });
  });

  afterEach(() => store.close());

  test("nothing spends without an open run", async () => {
    await expect(
      invokeAgent(store, 999, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);

    store.finishRun(runId, { outcome: "built", now: T0 });
    await expect(
      invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);
  });

  test("a run opened for one provider refuses to spawn another", async () => {
    // The run row says claude (the default); codex about to spawn against
    // it is a session id that means nothing — refused structurally.
    await expect(
      invokeAgent(store, runId, { provider: "codex", model: null }, ASK, {
        runner: async () => OK,
      }),
    ).rejects.toThrow(/about to spawn/);
    // Nothing was stamped: the refusal precedes the spend.
    expect(store.getRun(runId)?.providerStartedAt).toBeNull();
  });

  test("the stamp precedes the spawn — a crash between the two lies in the honest direction", async () => {
    let stampAtSpawn: string | null = null;
    await invokeAgent(store, runId, CLAUDE, ASK, {
      clock: () => T0,
      runner: async () => {
        stampAtSpawn = store.getRun(runId)?.providerStartedAt ?? null;
        return OK;
      },
    });

    expect(stampAtSpawn).toBe(T0.toISOString());
  });

  test("usage is read off every completed process, nonzero exits included", async () => {
    const envelope = JSON.stringify({
      result: "half done, then it broke",
      usage: { input_tokens: 41_000, output_tokens: 2_500 },
      total_cost_usd: 0.4321,
    });
    const result = await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: envelope, stderr: "boom" }),
    });

    expect(result.code).toBe(1);
    expect(result.finalMessage).toBe("half done, then it broke");
    expect(result.usage).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
  });

  test("what was not measured stays NULL — never a fabricated zero", async () => {
    await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, stdout: "not json at all" }),
    });

    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
    // But the spawn itself is on the record regardless.
    expect(store.getRun(runId)?.providerStartedAt).not.toBeNull();
  });

  test("negative or non-numeric usage is a lie, not a measurement", async () => {
    await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => ({
        ...OK,
        stdout: JSON.stringify({ usage: { input_tokens: -5, output_tokens: "many" }, total_cost_usd: "cheap" }),
      }),
    });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
  });

  test("a codex run parses the retained JSONL — tokens measured, dollars honestly NULL", async () => {
    store.createTask({ id: "t-2", title: "w2" }, T0);
    const ref2 = store.refFor("built-in", "t-2").id;
    const codexRun = store.startRun({
      taskRef: ref2, leaseId: "lease-2", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", now: T0,
    });
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done and dusted" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9_000, output_tokens: 800, cached_input_tokens: 5_000 } }),
    ].join("\n");
    const result = await invokeAgent(
      store, codexRun, { provider: "codex", model: "gpt-5-codex" }, ASK,
      { runner: async () => ({ ...OK, stdout: jsonl }) },
    );
    expect(result.sessionId).toBe("thread-abc");
    expect(result.finalMessage).toBe("done and dusted");
    expect(result.initFailed).toBe(false);
    // cached tokens ride the raw record only — input is input.
    expect(store.getRun(codexRun)).toMatchObject({ tokensIn: 9_000, tokensOut: 800, costUsd: null });
  });

  /** M5 provider audit: init failure is observed structurally, never guessed. */
  const codexRunFor = (id: string) => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: store.refFor("built-in", id).id, leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", now: T0,
    });
  };

  test("a codex turn with no thread.started and nothing to show is an init failure", async () => {
    const id = codexRunFor("t-init-1");
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", stderr: "error: bad config.toml" }),
    });
    expect(result.initFailed).toBe(true);
  });

  test("a completed turn without the init event is NOT an init failure — a renamed event must not read as broken", async () => {
    const id = codexRunFor("t-init-2");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } });
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, stdout: jsonl }),
    });
    expect(result.initFailed).toBe(false);
  });

  test("a nonzero exit WITH an agent message is a failed turn, never an init failure (audit C-8)", async () => {
    const id = codexRunFor("t-init-4");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I tried and failed" } });
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: jsonl, stderr: "turn failed" }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.finalMessage).toBe("I tried and failed");
  });

  test("a timeout is a timeout, not an init failure — even with no init event seen", async () => {
    const id = codexRunFor("t-init-3");
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", timedOut: true }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test("claude's buffered transport proves nothing about initialization — never flagged", async () => {
    const result = await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stderr: "exploded before the harness" }),
    });
    expect(result.initFailed).toBe(false);
  });
});

describe("the architecture rule", () => {
  /**
   * The zero-token invariant is only enforceable if there is exactly one
   * place that can start an LLM. Provider IDS are ordinary words that
   * legitimately appear in config, schema, and UI — so the boundary is
   * asserted on IMPORTS, not string literals (Codex provider review, Q1):
   * only invoke.ts may import the registry's spawning surface, and only
   * builder/planner may import the gateway itself.
   */
  test("only the gateway imports the spawning surface; only builder and planner spend", () => {
    const src = join(process.cwd(), "src");
    const spawners: string[] = [];
    const invokers: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      if (name !== "invoke.ts" && name !== "provider.ts" && /\badapterFor\b/.test(text)) {
        spawners.push(name);
      }
      if (name !== "invoke.ts" && /\binvokeAgent\b/.test(text)) {
        invokers.push(name);
      }
    }
    expect(spawners).toEqual([]);
    expect(invokers.sort()).toEqual(["builder.ts", "planner.ts"]);
  });
});
