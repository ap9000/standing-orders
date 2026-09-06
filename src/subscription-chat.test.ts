import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import {
  composeSubscriptionMatePrompt,
  parseSubscriptionMateAnswer,
  performSubscriptionMateRequest,
  type SubscriptionMateRequest,
} from "./subscription-chat.js";

const TOOLS = [{ name: "recap", description: "summarize", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] as const;

const request = (provider: SubscriptionMateRequest["provider"]): SubscriptionMateRequest => ({
  provider,
  model: "default",
  system: "SYSTEM-CANARY",
  dataDocument: "DATA-CANARY",
  history: [{ role: "operator", text: "hello" }],
  tools: TOOLS,
  timeoutMs: 12_345,
});

describe("subscription chat's isolated harness adapter", () => {
  test("the prompt gives the harness no ambient-state authority", () => {
    const prompt = composeSubscriptionMatePrompt(request("codex-subscription"));
    expect(prompt).toContain("Do not use any harness tools or inspect the computer");
    expect(prompt).toContain("SYSTEM-CANARY");
    expect(prompt).toContain("DATA-CANARY");
    expect(prompt).toContain('"name":"recap"');
  });

  test("strict output accepts bounded calls and refuses smuggled or duplicate fields", () => {
    const valid = parseSubscriptionMateAnswer(JSON.stringify({
      text: "Let me recap.",
      calls: [{ id: "c1", name: "recap", argumentsJson: "{}" }],
    }), { tokensIn: 11, tokensOut: 7 });
    expect(valid).toMatchObject({ ok: true, answer: { text: "Let me recap.", tokensIn: 11, tokensOut: 7, reportedCostMicrousd: null } });
    if (valid.ok) expect(valid.answer.calls).toEqual([{ id: "c1", name: "recap", args: {} }]);
    expect(parseSubscriptionMateAnswer('{"text":"a","text":"b","calls":[]}')).toMatchObject({ ok: false, problem: "duplicate-key" });
    expect(parseSubscriptionMateAnswer('{"text":"a","calls":[],"extra":true}')).toMatchObject({ ok: false, problem: "wrong-shape" });
    expect(parseSubscriptionMateAnswer(JSON.stringify({ text: "a", calls: [{ id: "c", name: "recap", argumentsJson: "[]" }] }))).toMatchObject({ ok: false, problem: "bad-tool-call" });
  });

  test("Codex runs ephemerally in a deleted empty directory with tools, web, apps, rules, and credential env disabled", async () => {
    let seen: { file: string; args: readonly string[]; cwd: string; omitEnv: readonly string[]; timeoutMs: number | undefined } | null = null;
    const result = await performSubscriptionMateRequest(request("codex-subscription"), async (file, args, options) => {
      seen = { file, args, cwd: options?.cwd ?? "", omitEnv: options?.omitEnv ?? [], timeoutMs: options?.timeoutMs };
      const answer = JSON.stringify({ text: "All quiet.", calls: [] });
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        notFound: false,
      };
    });
    expect(result).toMatchObject({ ok: true, answer: { text: "All quiet.", tokensIn: 12, tokensOut: 4 } });
    expect(seen).not.toBeNull();
    const call = seen!;
    expect(call.file).toBe("codex");
    expect(call.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only", 'web_search="disabled"', "features.shell_tool=false", "features.multi_agent=false", "apps._default.enabled=false"]));
    expect(call.args).not.toContain("--model");
    expect(call.omitEnv).toEqual(ALL_CREDENTIAL_ENV);
    expect(call.timeoutMs).toBe(12_345);
    expect(existsSync(call.cwd)).toBe(false);
  });

  test("Claude runs in safe print mode with an empty tool and MCP surface", async () => {
    let seen: { args: readonly string[]; cwd: string } | null = null;
    const result = await performSubscriptionMateRequest(request("claude-subscription"), async (_file, args, options) => {
      seen = { args, cwd: options?.cwd ?? "" };
      return {
        code: 0,
        stdout: JSON.stringify({ structured_output: { text: "Ready.", calls: [] }, usage: { input_tokens: 8, output_tokens: 2 } }),
        stderr: "",
        timedOut: false,
        notFound: false,
      };
    });
    expect(result).toMatchObject({ ok: true, answer: { text: "Ready.", tokensIn: 8, tokensOut: 2 } });
    expect(seen?.args).toEqual(expect.arrayContaining(["-p", "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", '{"mcpServers":{}}']));
    expect(existsSync(seen?.cwd ?? "missing")).toBe(false);
  });
});
