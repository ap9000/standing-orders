/**
 * The provider registry: three ways to spend, one semantic request. The
 * argv dialects are asserted exactly — a drifted flag is a silent behavior
 * change in somebody's repository at 3am — and the OpenRouter overrides are
 * pinned to constants: keys never caller-supplied, values TOML-quoted, the
 * API key excluded from every shell the model itself launches.
 */

import { describe, test, expect } from "vitest";
import { adapterFor, validateSpec, reportsCost, inspectionOf, MODEL_ID, OPENROUTER_ENV_KEY } from "./provider.js";
import { runStreamJsonl } from "./exec.js";

const ASK = {
  phase: "build" as const,
  brief: "do the thing",
  model: null as string | null,
  maxTurns: 40,
  permissionMode: "acceptEdits",
  skipPermissions: false,
  resumeSession: null as string | null,
};

describe("argv dialects", () => {
  test("claude speaks exactly the dialect the suite has always proven", () => {
    expect(adapterFor("claude").argv({ ...ASK, model: "sonnet" })).toEqual([
      "-p", "do the thing",
      "--output-format", "json",
      "--max-turns", "40",
      "--permission-mode", "acceptEdits",
      "--model", "sonnet",
    ]);
    expect(adapterFor("claude").argv({ ...ASK, resumeSession: "s-1" })).toContain("--resume");
  });

  test("codex: exec --json, sandboxed workspace-write, brief positional, resume a subcommand", () => {
    const argv = adapterFor("codex").argv({ ...ASK, model: "gpt-5-codex" });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "-m", "gpt-5-codex"]));
    expect(argv[argv.length - 1]).toBe("do the thing");
    // Never ephemeral: repair resumes persisted sessions.
    expect(argv).not.toContain("--ephemeral");

    const resumed = adapterFor("codex").argv({ ...ASK, resumeSession: "thread-1" });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
  });

  test("openrouter rides codex under a private provider key, TOML-quoted, key shell-excluded", () => {
    const argv = adapterFor("openrouter").argv({ ...ASK, model: "anthropic/claude-sonnet-4.5" });
    expect(adapterFor("openrouter").binary).toBe(adapterFor("codex").binary);
    const joined = argv.join(" ");
    expect(joined).toContain('model_provider="nightorders_openrouter"');
    expect(joined).toContain('base_url="https://openrouter.ai/api/v1"');
    expect(joined).toContain(`env_key="${OPENROUTER_ENV_KEY}"`);
    // The model's own shells never inherit the key — only the transport.
    expect(joined).toContain(`shell_environment_policy.exclude=["${OPENROUTER_ENV_KEY}"]`);
  });
});

describe("spec validation", () => {
  test("model ids: real catalog ids pass, argv- and TOML-hostile ones refuse", () => {
    for (const good of ["opus", "gpt-5-codex", "anthropic/claude-sonnet-4.5", "meta-llama/llama-3.3-70b:free"]) {
      expect(MODEL_ID.test(good)).toBe(true);
    }
    for (const bad of ["-rf", "", "a".repeat(200), 'x"y', "a b", "no\nnewlines"]) {
      expect(MODEL_ID.test(bad)).toBe(false);
    }
  });

  test("openrouter without a model is refused — no default exists across a catalog", () => {
    expect(validateSpec({ provider: "openrouter", model: null })).toMatchObject({ ok: false });
    expect(validateSpec({ provider: "openrouter", model: "qwen/qwen3-coder" })).toEqual({ ok: true });
    expect(validateSpec({ provider: "claude", model: null })).toEqual({ ok: true });
  });

  test("only claude reports dollars; the inspection surface says so", () => {
    expect(reportsCost("claude")).toBe(true);
    expect(reportsCost("codex")).toBe(false);
    expect(reportsCost("openrouter")).toBe(false);
    expect(inspectionOf("codex").identityProbe).toEqual(["login", "status"]);
    expect(inspectionOf("claude").identityProbe).toBeNull();
    expect(inspectionOf("openrouter").requiresEnv).toBe(OPENROUTER_ENV_KEY);
  });
});

describe("the turn bound codex does not have", () => {
  test("codex wall clocks are clamped below claude's — timeout is its only spending bound", () => {
    expect(adapterFor("codex").clampTimeout("build", 30 * 60_000)).toBe(20 * 60_000);
    expect(adapterFor("codex").clampTimeout("plan", 15 * 60_000)).toBe(10 * 60_000);
    expect(adapterFor("codex").clampTimeout("repair", 5 * 60_000)).toBe(5 * 60_000);
    expect(adapterFor("claude").clampTimeout("build", 30 * 60_000)).toBe(30 * 60_000);
  });
});

describe("the streaming JSONL transport", () => {
  test("retains only the load-bearing lines from an arbitrarily long stream", async () => {
    // A child that floods 50k noise events, then says what matters. The
    // buffered runner would overflow at 8 MiB and lose the terminal usage;
    // the stream keeps three lines.
    const script = `
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t-9"})+"\\n");
      for (let i = 0; i < 50000; i++) {
        process.stdout.write(JSON.stringify({type:"item.delta",noise:"x".repeat(200),i})+"\\n");
      }
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"first"}})+"\\n");
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"the last word"}})+"\\n");
      process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:123,output_tokens:45}})+"\\n");
    `;
    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter(one => one !== "");
    expect(lines.length).toBe(3);
    expect(result.stdout).toContain('"t-9"');
    expect(result.stdout).toContain('"input_tokens":123');
    // Only the LAST agent message survives.
    expect(result.stdout).toContain("the last word");
    expect(result.stdout).not.toContain('"first"');
    expect(result.stdout).not.toContain("item.delta");
  });

  test("a missing binary is not-found, not a hang", async () => {
    const result = await runStreamJsonl("definitely-not-a-binary-xyz", [], { timeoutMs: 5_000 });
    expect(result.notFound).toBe(true);
  });

  test("a runaway process is killed at the clock and says timedOut", async () => {
    const result = await runStreamJsonl(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
  });
});
