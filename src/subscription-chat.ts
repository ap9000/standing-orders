/**
 * Subscription-backed transport for the mate.
 *
 * The direct API transport owns dollar reservations and native function
 * calls. A cached Codex or Claude login has neither an API key nor a
 * truthful dollar meter, so this adapter runs the local harness in a clean
 * temporary directory and asks for the same tool-call envelope as strict
 * structured JSON. The harness receives no repository path, no project
 * instructions, no MCP servers, and no executable tool surface. Tool calls
 * are still interpreted and executed by mate.ts, where every act remains a
 * proposal that needs a human confirmation card.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MATE_MAX_CALLS_PER_STEP,
  MATE_STEP_TEXT_CAP_BYTES,
  MATE_TOOL_CALL_CAP_BYTES,
  MATE_TOOL_CALL_ID_CAP_BYTES,
  strictJsonParse,
  tokenCount,
  type MateHistoryMessage,
  type MateProviderAnswer,
  type MateToolCall,
  type MateToolSchema,
} from "./converse.js";
import { run, type ExecResult } from "./exec.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import type { SubscriptionChatProviderId } from "./store.js";

export type SubscriptionMateRequest = {
  provider: SubscriptionChatProviderId;
  /** `default` lets the authenticated harness choose its current default. */
  model: string;
  system: string;
  dataDocument: string;
  history: readonly MateHistoryMessage[];
  tools: readonly MateToolSchema[];
  timeoutMs: number;
};

export type SubscriptionMateRunner = (
  request: SubscriptionMateRequest,
) => Promise<{ ok: true; answer: MateProviderAnswer } | { ok: false; problem: string }>;

type CommandRunner = (file: string, args: readonly string[], options: Parameters<typeof run>[2]) => Promise<ExecResult>;

const RESPONSE_CAP_BYTES = 65_536;

function outputSchema(tools: readonly MateToolSchema[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      text: { type: "string", maxLength: MATE_STEP_TEXT_CAP_BYTES },
      calls: {
        type: "array",
        maxItems: MATE_MAX_CALLS_PER_STEP,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: MATE_TOOL_CALL_ID_CAP_BYTES },
            name: { type: "string", enum: tools.map(tool => tool.name) },
            argumentsJson: { type: "string", maxLength: MATE_TOOL_CALL_CAP_BYTES },
          },
          required: ["id", "name", "argumentsJson"],
          additionalProperties: false,
        },
      },
    },
    required: ["text", "calls"],
    additionalProperties: false,
  };
}

/** The model-visible request. Tool results are already redacted by mateView. */
export function composeSubscriptionMatePrompt(request: Omit<SubscriptionMateRequest, "provider" | "model" | "timeoutMs">): string {
  return [
    request.system,
    "SUBSCRIPTION HARNESS PROTOCOL:",
    "Do not use any harness tools or inspect the computer. The only current state is DATA and TOOL RESULTS below.",
    "Return the required JSON object. To request a host tool, append {id, name, argumentsJson} to calls; argumentsJson is the JSON serialization of that tool's argument object.",
    "The host validates and runs those calls, then gives you another step. When finished, return a non-empty text and an empty calls array.",
    `AVAILABLE HOST TOOLS:\n${JSON.stringify(request.tools)}`,
    `DATA:\n${request.dataDocument}`,
    `CONVERSATION:\n${JSON.stringify(request.history)}`,
  ].join("\n\n");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

/** Strictly turn the harness's structured output into the provider-neutral answer. */
export function parseSubscriptionMateAnswer(
  text: string,
  usage: { tokensIn?: unknown; tokensOut?: unknown } = {},
): { ok: true; answer: MateProviderAnswer } | { ok: false; problem: string } {
  const parsed = strictJsonParse(Buffer.from(text, "utf8"), RESPONSE_CAP_BYTES, 8);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, problem: parsed.ok ? "not-an-object" : parsed.problem };
  }
  const body = parsed.value as Record<string, unknown>;
  if (!exactKeys(body, ["text", "calls"]) || typeof body["text"] !== "string" || !Array.isArray(body["calls"])) {
    return { ok: false, problem: "wrong-shape" };
  }
  if (Buffer.byteLength(body["text"], "utf8") > MATE_STEP_TEXT_CAP_BYTES || body["calls"].length > MATE_MAX_CALLS_PER_STEP) {
    return { ok: false, problem: "over-cap" };
  }
  const calls: MateToolCall[] = [];
  for (const raw of body["calls"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "bad-tool-call" };
    const call = raw as Record<string, unknown>;
    if (!exactKeys(call, ["id", "name", "argumentsJson"])) return { ok: false, problem: "bad-tool-call" };
    if (typeof call["id"] !== "string" || call["id"] === "" || Buffer.byteLength(call["id"], "utf8") > MATE_TOOL_CALL_ID_CAP_BYTES) {
      return { ok: false, problem: "bad-tool-call" };
    }
    if (typeof call["name"] !== "string" || call["name"] === "" || call["name"].length > 64 || typeof call["argumentsJson"] !== "string") {
      return { ok: false, problem: "bad-tool-call" };
    }
    const argumentsBytes = Buffer.from(call["argumentsJson"], "utf8");
    if (argumentsBytes.byteLength > MATE_TOOL_CALL_CAP_BYTES) return { ok: false, problem: "bad-tool-call" };
    const args = strictJsonParse(argumentsBytes, MATE_TOOL_CALL_CAP_BYTES, 6);
    if (!args.ok || typeof args.value !== "object" || args.value === null || Array.isArray(args.value)) return { ok: false, problem: "bad-tool-call" };
    const normalized = { id: call["id"], name: call["name"], args: args.value as Record<string, unknown> };
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MATE_TOOL_CALL_CAP_BYTES) return { ok: false, problem: "bad-tool-call" };
    calls.push(normalized);
  }
  const tokensIn = typeof usage.tokensIn === "number" && tokenCount(usage.tokensIn) ? usage.tokensIn : 0;
  const tokensOut = typeof usage.tokensOut === "number" && tokenCount(usage.tokensOut) ? usage.tokensOut : 0;
  return { ok: true, answer: { text: body["text"], calls, tokensIn, tokensOut, reportedCostMicrousd: null } };
}

function codexOutput(stdout: string): { text: string | null; tokensIn: number; tokensOut: number } {
  let text: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event["type"] === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "agent_message" && typeof item["text"] === "string") text = item["text"];
    } else if (event["type"] === "turn.completed") {
      const usage = event["usage"] as Record<string, unknown> | undefined;
      if (typeof usage?.["input_tokens"] === "number" && tokenCount(usage["input_tokens"])) tokensIn = usage["input_tokens"];
      if (typeof usage?.["output_tokens"] === "number" && tokenCount(usage["output_tokens"])) tokensOut = usage["output_tokens"];
    }
  }
  return { text, tokensIn, tokensOut };
}

function claudeOutput(stdout: string): { text: string | null; tokensIn: number; tokensOut: number } {
  const parsed = strictJsonParse(Buffer.from(stdout, "utf8"), RESPONSE_CAP_BYTES, 12);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return { text: null, tokensIn: 0, tokensOut: 0 };
  const body = parsed.value as Record<string, unknown>;
  const usage = body["usage"] as Record<string, unknown> | undefined;
  const tokensIn = typeof usage?.["input_tokens"] === "number" && tokenCount(usage["input_tokens"]) ? usage["input_tokens"] : 0;
  const tokensOut = typeof usage?.["output_tokens"] === "number" && tokenCount(usage["output_tokens"]) ? usage["output_tokens"] : 0;
  const structured = body["structured_output"];
  if (typeof structured === "object" && structured !== null) return { text: JSON.stringify(structured), tokensIn, tokensOut };
  return { text: typeof body["result"] === "string" ? body["result"] : null, tokensIn, tokensOut };
}

/** Production runner; injectable so tests never consume a subscription turn. */
export async function performSubscriptionMateRequest(
  request: SubscriptionMateRequest,
  runner: CommandRunner = run,
): Promise<{ ok: true; answer: MateProviderAnswer } | { ok: false; problem: string }> {
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-mate-"));
  try {
    const prompt = composeSubscriptionMatePrompt(request);
    const schema = outputSchema(request.tools);
    let command: string;
    let args: string[];
    if (request.provider === "codex-subscription") {
      const schemaFile = join(dir, "response-schema.json");
      writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
      command = "codex";
      args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", "read-only", "--output-schema", schemaFile,
        "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
        "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
        "-c", "features.multi_agent=false", "-c", "features.skill_mcp_dependency_install=false",
        "-c", "apps._default.enabled=false",
        ...(request.model === "default" ? [] : ["--model", request.model]),
        prompt,
      ];
    } else {
      command = "claude";
      args = [
        "-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema),
        "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
        "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        ...(request.model === "default" ? [] : ["--model", request.model]),
      ];
    }
    const result = await runner(command, args, {
      cwd: dir,
      timeoutMs: request.timeoutMs,
      maxBuffer: RESPONSE_CAP_BYTES,
      omitEnv: ALL_CREDENTIAL_ENV,
      processGroup: true,
    });
    if (result.timedOut) return { ok: false, problem: "timeout" };
    if (result.notFound) return { ok: false, problem: "not-found" };
    if (result.code !== 0) return { ok: false, problem: `status-${result.code}` };
    const output = request.provider === "codex-subscription" ? codexOutput(result.stdout) : claudeOutput(result.stdout);
    if (output.text === null) return { ok: false, problem: "malformed-reply" };
    return parseSubscriptionMateAnswer(output.text, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
