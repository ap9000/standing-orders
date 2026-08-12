/**
 * The invocation gateway: the only door to the provider, and the anchor of
 * the zero-token invariant — provider spawns == runs stamped before the
 * spawn, and every completed process's usage is read, exit code be damned.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { invokeAgent, PROVIDER_BINARY } from "./invoke.js";

const T0 = new Date("2026-08-12T06:00:00.000Z");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

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
      invokeAgent(store, 999, ["-p", "hi"], { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);

    store.finishRun(runId, { outcome: "built", now: T0 });
    await expect(
      invokeAgent(store, runId, ["-p", "hi"], { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);
  });

  test("the stamp precedes the spawn — a crash between the two lies in the honest direction", async () => {
    let stampAtSpawn: string | null = null;
    await invokeAgent(store, runId, ["-p", "hi"], {
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
    const result = await invokeAgent(store, runId, ["-p", "hi"], {
      runner: async () => ({ ...OK, code: 1, stdout: envelope, stderr: "boom" }),
    });

    expect(result.code).toBe(1);
    expect(result.usage).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
  });

  test("what was not measured stays NULL — never a fabricated zero", async () => {
    await invokeAgent(store, runId, ["-p", "hi"], {
      runner: async () => ({ ...OK, stdout: "not json at all" }),
    });

    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
    // But the spawn itself is on the record regardless.
    expect(store.getRun(runId)?.providerStartedAt).not.toBeNull();
  });

  test("negative or non-numeric usage is a lie, not a measurement", async () => {
    await invokeAgent(store, runId, ["-p", "hi"], {
      runner: async () => ({
        ...OK,
        stdout: JSON.stringify({ usage: { input_tokens: -5, output_tokens: "many" }, total_cost_usd: "cheap" }),
      }),
    });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
  });
});

describe("the architecture rule", () => {
  test("no production module but the gateway names the provider binary", () => {
    // The zero-token invariant is only enforceable if there is exactly one
    // place that can start an LLM. A new direct call would pass every other
    // test in this suite; this one is here to fail it.
    const src = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "invoke.ts") continue;
      const text = readFileSync(join(src, name), "utf8");
      if (text.includes(`"${PROVIDER_BINARY}"`) || text.includes(`'${PROVIDER_BINARY}'`)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
