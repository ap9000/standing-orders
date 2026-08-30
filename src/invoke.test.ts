/**
 * The invocation gateway: the only door to any provider, and the anchor of
 * the zero-token invariant — provider spawns == runs stamped before the
 * spawn, and every completed process's usage is read, exit code be damned.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resetAttestationCache } from "./attest.js";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { invokeAgent, type InvokeResult } from "./invoke.js";

/** Most of this suite exercises the RAN arm; the union's refusal arms have
 * their own describe below. */
async function invokeRan(...args: Parameters<typeof invokeAgent>) {
  const result: InvokeResult = await invokeAgent(...args);
  if (result.kind !== "ran") throw new Error(`expected a ran outcome, got refused: ${result.reason}`);
  return result.outcome;
}

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
      invokeRan(store, 999, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);

    store.finishRun(runId, { outcome: "built", now: T0 });
    await expect(
      invokeRan(store, runId, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);
  });

  test("a run opened for one provider refuses to spawn another", async () => {
    // The run row says claude (the default); codex about to spawn against
    // it is a session id that means nothing — refused structurally.
    await expect(
      invokeRan(store, runId, { provider: "codex", model: null }, ASK, {
        runner: async () => OK,
      }),
    ).rejects.toThrow(/about to spawn/);
    // Nothing was stamped: the refusal precedes the spend.
    expect(store.getRun(runId)?.providerStartedAt).toBeNull();
  });

  test("the stamp precedes the spawn — a crash between the two lies in the honest direction", async () => {
    let stampAtSpawn: string | null = null;
    await invokeRan(store, runId, CLAUDE, ASK, {
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
    const result = await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: envelope, stderr: "boom" }),
    });

    expect(result.code).toBe(1);
    expect(result.finalMessage).toBe("half done, then it broke");
    expect(result.usage).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
  });

  test("what was not measured stays NULL — never a fabricated zero", async () => {
    await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, stdout: "not json at all" }),
    });

    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
    // But the spawn itself is on the record regardless.
    expect(store.getRun(runId)?.providerStartedAt).not.toBeNull();
  });

  test("negative or non-numeric usage is a lie, not a measurement", async () => {
    await invokeRan(store, runId, CLAUDE, ASK, {
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
    const result = await invokeRan(
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
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", stderr: "error: bad config.toml" }),
    });
    expect(result.initFailed).toBe(true);
  });

  test("a completed turn without the init event is NOT an init failure — a renamed event must not read as broken", async () => {
    const id = codexRunFor("t-init-2");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } });
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, stdout: jsonl }),
    });
    expect(result.initFailed).toBe(false);
  });

  test("a nonzero exit WITH an agent message is a failed turn, never an init failure (audit C-8)", async () => {
    const id = codexRunFor("t-init-4");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I tried and failed" } });
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: jsonl, stderr: "turn failed" }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.finalMessage).toBe("I tried and failed");
  });

  test("a timeout is a timeout, not an init failure — even with no init event seen", async () => {
    const id = codexRunFor("t-init-3");
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", timedOut: true }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test("claude gained the init signal with the streaming transport — an empty failed stream is an init failure", async () => {
    const result = await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stderr: "exploded before the harness" }),
    });
    expect(result.initFailed).toBe(true);
  });

  test("an error result's prose never suppresses provider-init (arc 1 finding 15)", async () => {
    // A startup death that still emitted an origin-less error result: the
    // diagnostic text lands in finalMessage, but text is not an attempt.
    store.createTask({ id: "t-err", title: "w" }, T0);
    const errRun = store.startRun({
      taskRef: store.refFor("built-in", "t-err").id, leaseId: "lease-err", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "claude", now: T0,
    });
    const stream = JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true,
      result: "credential rejected before any turn", session_id: "s-dead",
    });
    const result = await invokeRan(store, errRun, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: stream, stderr: "" }),
    });
    expect(result.finalMessage).toBe("credential rejected before any turn");
    expect(result.initFailed).toBe(true);
  });

  test("an observed init is never an init failure, whatever else went wrong", async () => {
    store.createTask({ id: "t-init-ok", title: "w" }, T0);
    const okRun = store.startRun({
      taskRef: store.refFor("built-in", "t-init-ok").id, leaseId: "lease-io", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "claude", now: T0,
    });
    const stream = JSON.stringify({ type: "system", subtype: "init", session_id: "s-up" });
    const result = await invokeRan(store, okRun, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: stream, stderr: "died mid-turn" }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.sessionId).toBe("s-up");
  });
});

describe("the attested gateway (Phase 3): gemini refusals are values", () => {
  let store: Store;
  let dir: string;
  let savedPath: string | undefined;

  const fakeGemini = (version: string): void => {
    const path = join(dir, "gemini");
    writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
    chmodSync(path, 0o755);
  };

  const geminiRun = (id: string): number => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: store.refFor("built-in", id).id, leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "gemini", now: T0,
    });
  };

  const GEMINI = { provider: "gemini" as const, model: "gemini-2.5-pro" };

  beforeEach(() => {
    store = openStore(":memory:");
    dir = mkdtempSync(join(tmpdir(), "invoke-attest-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:${savedPath ?? ""}`;
    resetAttestationCache();
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    rmSync(dir, { recursive: true, force: true });
    resetAttestationCache();
    store.close();
  });

  test("out of range: refused as a VALUE, version stamped, provider_started_at honestly NULL", async () => {
    fakeGemini("0.58.9");
    const runId = geminiRun("g-1");
    const result = await invokeAgent(store, runId, GEMINI, ASK, { runner: async () => OK });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", providerVersion: "0.58.9" });
    const run = store.getRun(runId);
    expect(run?.providerVersion).toBe("0.58.9");
    expect(run?.providerStartedAt).toBeNull();
  });

  test("in range: the version rides the SAME pre-spawn durable write as the start stamp", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-2");
    let stampedAtSpawn: { version: string | null; started: string | null } | null = null;
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 5 } }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, ASK, {
      runner: async () => {
        const run = store.getRun(runId);
        stampedAtSpawn = { version: run?.providerVersion ?? null, started: run?.providerStartedAt ?? null };
        return { ...OK, stdout: stream };
      },
    });
    expect(result.kind).toBe("ran");
    expect(stampedAtSpawn).toMatchObject({ version: "0.57.0" });
    expect((stampedAtSpawn as unknown as { started: string | null }).started).not.toBeNull();
  });

  test("the terminal contract: exit 0 without the success terminal is provider-protocol, never a build", async () => {
    fakeGemini("0.57.0");
    const truncated = geminiRun("g-3");
    const initOnly = JSON.stringify({ type: "init", session_id: "s-1", model: "m" });
    const result = await invokeAgent(store, truncated, GEMINI, ASK, {
      runner: async () => ({ ...OK, stdout: initOnly }),
    });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((result as { diagnostic: string }).diagnostic).toContain("success terminal");

    const dead = geminiRun("g-4");
    const noInit = await invokeAgent(store, dead, GEMINI, ASK, { runner: async () => OK });
    expect(noInit).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((noInit as { diagnostic: string }).diagnostic).toContain("initializing");
  });

  test("exit 0 with an error-status terminal: refused, and the spend was still recorded", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-5");
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "error", error: { type: "X", message: "invalid stream" }, stats: { input_tokens: 7, output_tokens: 3 } }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, ASK, { runner: async () => ({ ...OK, stdout: stream }) });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 7, tokensOut: 3 });
  });

  test("a nonzero exit keeps today's classification road — the contract gates only believed successes", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-6");
    const result = await invokeAgent(store, runId, GEMINI, ASK, {
      runner: async () => ({ ...OK, code: 41, stderr: "set an auth method" }),
    });
    expect(result.kind).toBe("ran");
    expect((result as { outcome: { initFailed: boolean } }).outcome.initFailed).toBe(true);
  });

  test("minted identity: stamped before spawn, and the init echo must MATCH it", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-7");
    const minted = "11111111-2222-4333-8444-555555555555";
    let sessionAtSpawn: string | null = null;
    const wrong = [
      JSON.stringify({ type: "init", session_id: "not-the-minted-one", model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => {
        sessionAtSpawn = store.getRun(runId)?.sessionId ?? null;
        return { ...OK, stdout: wrong };
      },
    });
    expect(sessionAtSpawn).toBe(minted);
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((result as { diagnostic: string }).diagnostic).toContain("different");

    const silent = geminiRun("g-8");
    const noId = [
      JSON.stringify({ type: "init", model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const absent = await invokeAgent(store, silent, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => ({ ...OK, stdout: noId }),
    });
    expect(absent).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((absent as { diagnostic: string }).diagnostic).toContain("without announcing");

    const honest = geminiRun("g-9");
    const echoed = [
      JSON.stringify({ type: "init", session_id: minted, model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const good = await invokeAgent(store, honest, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => ({ ...OK, stdout: echoed }),
    });
    expect(good.kind).toBe("ran");
  });

  test("tier-1 spawns never probe: claude runs with NO gemini on PATH at all", async () => {
    process.env["PATH"] = dir; // gemini absent, everything absent
    store.createTask({ id: "c-1", title: "w" }, T0);
    const runId = store.startRun({
      taskRef: store.refFor("built-in", "c-1").id, leaseId: "lease-c1", runner: "builder-1",
      branch: "b", worktree: "/w", now: T0,
    });
    const result = await invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK });
    expect(result.kind).toBe("ran");
  });
});

describe("the fallback taxonomy stamp (E2): honest disposal, fail closed", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  const codexRunFor = (id: string) => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: store.refFor("built-in", id).id, leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", now: T0,
    });
  };

  test("EVERY ran attempt is stamped with an auth mode and a terminal class", async () => {
    const id = codexRunFor("e2-ok");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } });
    await invokeRan(store, id, { provider: "codex", model: null }, ASK, { runner: async () => ({ ...OK, stdout: jsonl }) });
    // Codex defaults to the subscription; a clean turn carries NO structural
    // failure terminal, so it classifies 'unknown' — never eligible.
    expect(store.getRun(id)).toMatchObject({ authMode: "subscription", terminalClass: "unknown" });
  });

  test("a codex FAILED turn stamps not-exhausted — a definite failure, but no fixture makes it eligible", async () => {
    const id = codexRunFor("e2-fail");
    // A structural failure terminal (turn.failed) shaped exactly like a real
    // usage-limit message — but with the recognizers empty, it is NOT eligible.
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "You've hit your usage limit." } }),
      JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }),
    ].join("\n");
    await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: jsonl, stderr: "usage limit" }),
    });
    const run = store.getRun(id);
    expect(run?.terminalClass).toBe("not-exhausted");
    // The safety property spelled out: a definite failure never authorizes a paid fallback.
    expect(run?.terminalClass).not.toBe("usage-exhausted");
    expect(run?.terminalClass).not.toBe("credits-depleted");
  });

  test("a refused-before-spawn attempt is NEVER classified — no process ran, terminal_class stays NULL", async () => {
    // A gemini out-of-range attestation refuses before any spawn: no
    // envelope, so no honest classification is possible.
    const dir = mkdtempSync(join(tmpdir(), "e2-attest-"));
    writeFileSync(join(dir, "gemini"), "#!/bin/sh\necho 0.1.0\n");
    chmodSync(join(dir, "gemini"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    resetAttestationCache();
    try {
      store.createTask({ id: "e2-refused", title: "w" }, T0);
      const id = store.startRun({
        taskRef: store.refFor("built-in", "e2-refused").id, leaseId: "lease-e2r", runner: "builder-1",
        branch: "b", worktree: "/w", provider: "gemini", now: T0,
      });
      const result = await invokeAgent(store, id, { provider: "gemini" as const, model: null }, ASK, { runner: async () => OK });
      expect(result.kind).toBe("refused");
      expect(store.getRun(id)?.terminalClass ?? null).toBeNull();
    } finally {
      process.env["PATH"] = savedPath;
      resetAttestationCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the chain-bound gateway (E3d review findings 1/3)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  /** A run bound to a chain entry, with a REAL cycle row backing the FK. */
  const chainBoundRun = (authMode: "subscription" | "api-key") => {
    store.createTask({ id: "t-chain", title: "w" }, T0);
    const ref = store.refFor("built-in", "t-chain").id;
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-ch", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "claude", now: T0,
    });
    const opened = store.openFallbackCycle(ref, "digest-x", runId, T0) as { ok: true; id: number };
    store
      .raw()
      .prepare("UPDATE run SET chain_cycle = ?, chain_index = 0, entry_digest = 'e0', auth_mode = ? WHERE id = ?")
      .run(opened.id, authMode, runId);
    return runId;
  };

  test("a pinned api-key entry with NO key anywhere is REFUSED before any stamp — never the cached login (finding 1)", async () => {
    const runId = chainBoundRun("api-key");
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const result = await invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK, keyHome: "/nonexistent-keyhome" });
      expect(result).toMatchObject({ kind: "refused", reason: "chain-credential" });
      // No spend was implied: the start stamp never landed.
      expect(store.getRun(runId)?.providerStartedAt ?? null).toBeNull();
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  test("a chain-bound run whose custody no longer proves is REFUSED at the spawn stamp (finding 3)", async () => {
    // The run carries a binding, but the task has NO chain approval to
    // re-derive — the pre-spawn custody proof must refuse, stamping nothing.
    const runId = chainBoundRun("subscription");
    const result = await invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK });
    expect(result).toMatchObject({ kind: "refused", reason: "chain-custody" });
    expect(store.getRun(runId)?.providerStartedAt ?? null).toBeNull();
  });
});

describe("the architecture rule", () => {
  /**
   * The zero-token invariant is only enforceable if there is exactly one
   * place that can start an LLM. Provider IDS are ordinary words that
   * legitimately appear in config, schema, and UI — so the boundary is
   * asserted on IMPORTS, not string literals (Codex provider review, Q1):
   * only invoke.ts may import the registry's spawning surface, and only
   * builder/planner/reviewer may import the gateway itself.
   */
  test("only the gateway imports the spawning surface; only builder, planner, and reviewer spend", () => {
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
    expect(invokers.sort()).toEqual(["builder.ts", "planner.ts", "reviewer.ts"]);
  });
});
