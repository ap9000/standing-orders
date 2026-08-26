/**
 * The provider registry: three ways to spend, one semantic request. The
 * argv dialects are asserted exactly — a drifted flag is a silent behavior
 * change in somebody's repository at 3am — and the OpenRouter overrides are
 * pinned to constants: keys never caller-supplied, values TOML-quoted, the
 * API key excluded from every shell the model itself launches.
 */

import { describe, test, expect } from "vitest";
import { adapterFor, auditOf, validateSpec, reportsCost, inspectionOf, MODEL_ID, OPENROUTER_ENV_KEY, PROVIDER_IDS, MONEY_CAPABILITIES } from "./provider.js";
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
    // stream-json since arc 1: the terminal result event is the old
    // buffered envelope; only the output format (and its required
    // --verbose) changed — every other flag is byte-identical.
    expect(adapterFor("claude").argv({ ...ASK, model: "sonnet" })).toEqual([
      "-p", "do the thing",
      "--output-format", "stream-json",
      "--verbose",
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
    expect(joined).toContain('model_provider="standing-orders_openrouter"');
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

describe("the claude streaming transport", () => {
  const line = (event: Record<string, unknown>): string => `process.stdout.write(${JSON.stringify(JSON.stringify(event))}+"\\n");`;

  test("a flood past the old 8 MiB kill still lands the accounting envelope", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-big" })}
      for (let i = 0; i < 50000; i++) {
        process.stdout.write(JSON.stringify({type:"assistant",message:{content:"x".repeat(200)},parent_tool_use_id:null,i})+"\\n");
      }
      ${line({ type: "result", subtype: "success", is_error: false, result: "survived", session_id: "s-big", usage: { input_tokens: 7, output_tokens: 8 }, total_cost_usd: 0.05 })}
    `;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter(one => one !== "");
    expect(lines.length).toBe(2); // init + primary result, nothing else retained
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed.costUsd).toBe(0.05);
    expect(parsed.initObserved).toBe(true);
    expect(parsed.promptConsumed).toBe(true);
  });

  test("the receipt fires once at the first top-level assistant event — child events never fire it", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: "tool-1" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "result", subtype: "success", is_error: false })}
    `;
    let receipts = 0;
    await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 30_000,
      onReceipt: () => {
        receipts += 1;
      },
    });
    expect(receipts).toBe(1);
  });

  test("a success result is the fallback receipt; an error result never is", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const success = `${line({ type: "result", subtype: "success", is_error: false })}`;
    const failure = `${line({ type: "result", subtype: "error_during_execution", is_error: true, result: "died at startup" })}`;
    let onSuccess = 0;
    let onFailure = 0;
    await runClaudeStreamJsonl(process.execPath, ["-e", success], { timeoutMs: 30_000, onReceipt: () => void (onSuccess += 1) });
    await runClaudeStreamJsonl(process.execPath, ["-e", failure], { timeoutMs: 30_000, onReceipt: () => void (onFailure += 1) });
    expect(onSuccess).toBe(1);
    expect(onFailure).toBe(0);
  });

  test("throwing listeners are latched and isolated — the run is unharmed (finding 13)", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-iso" })}
      ${line({ type: "assistant", message: {}, parent_tool_use_id: null })}
      ${line({ type: "result", subtype: "success", is_error: false, result: "fine" })}
    `;
    let receiptCalls = 0;
    let eventCalls = 0;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 30_000,
      onReceipt: () => {
        receiptCalls += 1;
        throw new Error("recorder down");
      },
      onStreamEvent: () => {
        eventCalls += 1;
        throw new Error("renderer down");
      },
    });
    expect(result.code).toBe(0);
    expect(receiptCalls).toBe(1); // latched: one firing, even though it threw
    expect(eventCalls).toBe(3);
    expect(adapterFor("claude").parse(result.stdout).finalMessage).toBe("fine");
  });

  test("the session id is stamped from the init event, the moment it arrives", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    const script = `
      ${line({ type: "system", subtype: "init", session_id: "s-early" })}
      setInterval(()=>{}, 1000); // hang: the id must not wait for exit
    `;
    let seen: string | null = null;
    await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 1_500,
      onSessionId: id => {
        seen = id;
      },
    });
    expect(seen).toBe("s-early");
  });

  test("split chunks and a task-notification result first — retention is structural, not positional", async () => {
    const { runClaudeStreamJsonl } = await import("./exec.js");
    // Write the stream in awkward pieces: a line split mid-JSON across
    // writes, and a background result BEFORE the real one.
    const script = `
      const a = JSON.stringify({type:"result",subtype:"success",is_error:false,origin:{kind:"task-notification"},total_cost_usd:9.9});
      const b = JSON.stringify({type:"result",subtype:"success",is_error:false,result:"the real one",total_cost_usd:0.1});
      process.stdout.write(a.slice(0, 10));
      setTimeout(() => {
        process.stdout.write(a.slice(10) + "\\n" + b.slice(0, 4));
        setTimeout(() => process.stdout.write(b.slice(4) + "\\n"), 20);
      }, 20);
    `;
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 30_000 });
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed.finalMessage).toBe("the real one");
    expect(parsed.costUsd).toBe(0.1);
  });
});

describe("the provider audit — report before enforcement", () => {
  test("facts are stated and nothing is enforced", () => {
    const codex = auditOf("codex");
    expect(codex.transport).toBe("streaming-jsonl");
    expect(codex.initSignal).toBe("thread.started");
    // --ephemeral exists and is deliberately not passed: it breaks resume,
    // and the audit says so instead of silently choosing.
    expect(codex.isolation.flag).toBe("--ephemeral");
    expect(codex.isolation.resumeSafe).toBe(false);
    expect(codex.isolation.enforced).toBe(false);

    const claude = auditOf("claude");
    expect(claude.transport).toBe("streaming-jsonl");
    // The init signal claude gained with the streaming transport (arc 1).
    // This is CAPABILITY metadata — whether a given run saw it lives in
    // the envelope's initObserved, never here (finding 16).
    expect(claude.initSignal).toBe("system-init");

    for (const id of PROVIDER_IDS) {
      const audit = auditOf(id);
      expect(audit.configSurface.length).toBeGreaterThan(0);
      expect(audit.isolation.enforced).toBe(false);
    }
  });

  test("codexParse observes initialization; claudeParse now does too", () => {
    const codex = adapterFor("codex");
    const started = codex.parse(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    expect(started.initObserved).toBe(true);
    const silent = codex.parse("");
    expect(silent.initObserved).toBe(false);

    const claude = adapterFor("claude");
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" });
    expect(claude.parse(init).initObserved).toBe(true);
    expect(claude.parse(init).sessionId).toBe("s-1");
    // No events at all: the transport HAS an init signal, it was not seen.
    expect(claude.parse("").initObserved).toBe(false);
    expect(claude.parse("not json").initObserved).toBe(false);
    // The legacy buffered envelope (recorded fixtures) still carries none.
    expect(claude.parse("{}").initObserved).toBe(null);
  });
});

describe("claudeParse — the streaming envelope", () => {
  const claude = adapterFor("claude");
  const result = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done it",
      session_id: "s-7",
      usage: { input_tokens: 100, output_tokens: 20 },
      total_cost_usd: 0.42,
      ...extra,
    });

  test("the first primary result is the envelope — identical facts to the buffered format", () => {
    const parsed = claude.parse(
      [JSON.stringify({ type: "system", subtype: "init", session_id: "s-7" }), result({})].join("\n"),
    );
    expect(parsed.sessionId).toBe("s-7");
    expect(parsed.finalMessage).toBe("done it");
    expect(parsed.tokensIn).toBe(100);
    expect(parsed.tokensOut).toBe(20);
    expect(parsed.costUsd).toBe(0.42);
    expect(parsed.initObserved).toBe(true);
    expect(parsed.promptConsumed).toBe(true);
  });

  test("origin allowlist (finding 10): only absent or human origins are primary", () => {
    // A task-notification result FIRST must not steal the envelope.
    const stolen = claude.parse(
      [
        result({ origin: { kind: "task-notification" }, total_cost_usd: 9.99, result: "background noise" }),
        result({}),
      ].join("\n"),
    );
    expect(stolen.costUsd).toBe(0.42);
    expect(stolen.finalMessage).toBe("done it");

    // Explicit human origin qualifies.
    expect(claude.parse(result({ origin: { kind: "human" } })).costUsd).toBe(0.42);

    // Every other kind — including ones the SDK has not invented yet —
    // fails closed as non-primary.
    for (const kind of ["channel", "peer", "coordinator", "somewhere-new"]) {
      const parsed = claude.parse(result({ origin: { kind } }));
      expect(parsed.costUsd).toBe(null);
      expect(parsed.finalMessage).toBe(null);
      expect(parsed.promptConsumed).toBe(false);
    }
  });

  test("error results keep their diagnostics but never prove consumption (finding 15)", () => {
    const errored = claude.parse(
      result({ subtype: "error_during_execution", is_error: true, result: "auth token expired" }),
    );
    expect(errored.finalMessage).toBe("auth token expired"); // diagnostics survive
    expect(errored.promptConsumed).toBe(false); // prose is not proof
    expect(errored.initObserved).toBe(false); // no init event in this stream
  });

  test("a stream with no primary result gives the same nulls as an unparseable envelope", () => {
    const parsed = claude.parse(JSON.stringify({ type: "assistant", message: {} }));
    expect(parsed.sessionId).toBe(null);
    expect(parsed.tokensIn).toBe(null);
    expect(parsed.costUsd).toBe(null);
    expect(parsed.usageRaw).toBe(null);
  });

  test("the legacy buffered envelope still parses, with no init or consumption signal", () => {
    const parsed = claude.parse(
      JSON.stringify({ result: "old shape", session_id: "s-0", usage: { input_tokens: 5, output_tokens: 6 }, total_cost_usd: 0.01 }),
    );
    expect(parsed.finalMessage).toBe("old shape");
    expect(parsed.tokensIn).toBe(5);
    expect(parsed.initObserved).toBe(null);
    expect(parsed.promptConsumed).toBe(null);
  });
});


describe("the gemini dialect (Phase 3, attested at 0.57.0)", () => {
  const ASK = {
    phase: "build" as const,
    brief: "do the thing",
    model: "gemini-2.5-pro" as string | null,
    maxTurns: 40,
    permissionMode: "acceptEdits",
    skipPermissions: false,
    resumeSession: null as string | null,
  };

  test("headless stream-json with the ONE sealed autonomy dial", () => {
    const argv = adapterFor("gemini").argv({ ...ASK });
    expect(argv).toEqual([
      "-p", "do the thing",
      "--output-format", "stream-json",
      "--approval-mode", "auto_edit",
      "-m", "gemini-2.5-pro",
    ]);
  });

  test("skipPermissions maps to yolo exactly where claude maps it to bypass", () => {
    expect(adapterFor("gemini").argv({ ...ASK, skipPermissions: true })).toContain("yolo");
    expect(adapterFor("gemini").argv({ ...ASK, skipPermissions: true })).not.toContain("auto_edit");
  });

  test("session identity: minted on start, resumed on repair, never both", () => {
    const started = adapterFor("gemini").argv({ ...ASK, startSessionId: "aaaa-bbbb" });
    expect(started).toContain("--session-id");
    expect(started).toContain("aaaa-bbbb");
    expect(started).not.toContain("--resume");
    const resumed = adapterFor("gemini").argv({ ...ASK, resumeSession: "cccc-dddd", startSessionId: "aaaa-bbbb" });
    expect(resumed).toContain("--resume");
    expect(resumed).not.toContain("--session-id");
  });

  test("no turn bound and no dollar cap exist to render", () => {
    const argv = adapterFor("gemini").argv({ ...ASK, maxBudgetUsd: 3 });
    expect(argv.join(" ")).not.toContain("--max-turns");
    expect(argv.join(" ")).not.toContain("--max-budget-usd");
  });

  test("the wall clock is shortened, never equated (codex posture)", () => {
    expect(adapterFor("gemini").clampTimeout("build", 30 * 60_000)).toBe(20 * 60_000);
    expect(adapterFor("gemini").clampTimeout("plan", 15 * 60_000)).toBe(10 * 60_000);
    expect(adapterFor("gemini").clampTimeout("repair", 9 * 60_000)).toBe(5 * 60_000);
  });

  test("a full stream parses: init identity, assembled message, tokens, structural success", () => {
    const stream = [
      "Loaded cached credentials.", // startup prose: dropped, not fatal
      JSON.stringify({ type: "init", timestamp: "t", session_id: "s-1", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "synthetic_message", content: "all done" }),
      JSON.stringify({ type: "not-a-real-event", whatever: true }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 900, output_tokens: 88, total_tokens: 988 } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope).toMatchObject({
      sessionId: "s-1",
      finalMessage: "all done",
      tokensIn: 900,
      tokensOut: 88,
      costUsd: null,
      initObserved: true,
      promptConsumed: true,
    });
  });

  test("an error-status result is NOT consumption — and its message is diagnostics", () => {
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "error", error: { type: "X", message: "the model refused" } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope.promptConsumed).toBe(false);
    expect(envelope.diagnostic).toBe("the model refused");
  });

  test("a dead-at-startup stream: no init, nothing consumed, malformed lines skipped", () => {
    const envelope = adapterFor("gemini").parse("please set an auth method\n{truncated js");
    expect(envelope).toMatchObject({ sessionId: null, initObserved: false, promptConsumed: false, tokensIn: null });
  });

  test("first init and last result win; a severity-error line feeds the bounded diagnostic", () => {
    const stream = [
      JSON.stringify({ type: "init", session_id: "first", model: "m" }),
      JSON.stringify({ type: "init", session_id: "second", model: "m" }),
      JSON.stringify({ type: "error", severity: "warning", message: "loop detected" }),
      JSON.stringify({ type: "error", severity: "error", message: "x".repeat(5000) }),
      JSON.stringify({ type: "result", status: "error", stats: { input_tokens: 1, output_tokens: 1 } }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 6 } }),
    ].join("\n");
    const envelope = adapterFor("gemini").parse(stream);
    expect(envelope.sessionId).toBe("first");
    expect(envelope.tokensIn).toBe(5);
    expect(envelope.promptConsumed).toBe(true);
    expect(Buffer.byteLength(envelope.diagnostic ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024 + 4);
  });

  test("a diagnostic that trips the secret scanner is withheld, and controls collapse", () => {
    const leaky = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "error", severity: "error", message: "auth failed for AKIAABCDEFGHIJKLMNOP" }),
      JSON.stringify({ type: "result", status: "error" }),
    ].join("\n");
    expect(adapterFor("gemini").parse(leaky).diagnostic).toContain("withheld");

    const controlly = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "error", severity: "error", message: "line one\u0007\u001b[31mline two" }),
      JSON.stringify({ type: "result", status: "error" }),
    ].join("\n");
    const diagnostic = adapterFor("gemini").parse(controlly).diagnostic ?? "";
    expect(diagnostic).not.toMatch(/[\u0000-\u001f]/);
    expect(diagnostic).toContain("line one");
  });

  test("gemini needs an explicit model — the harness default drifts", () => {
    expect(validateSpec({ provider: "gemini", model: null }).ok).toBe(false);
    expect(validateSpec({ provider: "gemini", model: "gemini-2.5-flash" }).ok).toBe(true);
  });

  test("money honesty: tokens only, no cap to hold, never in a tournament", () => {
    expect(reportsCost("gemini")).toBe(false);
    expect(MONEY_CAPABILITIES.gemini).toMatchObject({
      nativeDollarCapFlag: null,
      usageSemantics: "per-invocation",
      tournamentEligible: false,
    });
    expect(MONEY_CAPABILITIES.gemini.whyIneligible).toContain("tokens");
  });

  test("the audit states the posture: init event, unproven resume, required terminal, minted identity", () => {
    expect(auditOf("gemini")).toMatchObject({
      transport: "streaming-jsonl",
      resume: "none",
      initSignal: "init-event",
      sessionIdentity: "minted",
      terminalContract: "required",
    });
    // Tier-1 settlement is untouched by construction.
    expect(auditOf("claude").terminalContract).toBe("none");
    expect(auditOf("codex").terminalContract).toBe("none");
    // The hooks surface is NAMED — the config-leak class the audit exists for.
    expect(auditOf("gemini").configSurface.join(" ")).toContain("HOOKS");
  });
});
