/**
 * The provider registry: every way this plane can spend money on an agent,
 * in one file (§5's "one door", widened to three harness shapes).
 *
 * A provider here is how to SPAWN a harness and how to READ its envelope —
 * argv dialect, transport, session identity, usage. The briefs, the mailbox
 * protocol, and every custody proof are provider-neutral and live where
 * they always did; this module owns only the dialect differences.
 *
 * Boundary (the architecture test enforces it): only `invoke.ts` may import
 * the spawning surface (`adapterFor`); everything else that needs provider
 * facts uses the non-spending inspection surface (`PROVIDERS`,
 * `inspectionOf`) — identification must never be a way to start an LLM.
 *
 * `openrouter` is deliberately not a fourth transport: it is the codex
 * harness pointed at OpenRouter through `-c` overrides whose keys and
 * values are CONSTANTS below — no caller-supplied dotted keys, values
 * TOML-quoted deterministically, and the API key excluded from every
 * shell the model itself launches (Codex provider review, Q5).
 */

import { run, type ExecResult, type RunOptions } from "./exec.js";
import { runStreamJsonl } from "./exec.js";

export type ProviderId = "claude" | "codex" | "openrouter";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "openrouter"];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Which harness runs, on which model. model null = the harness's default. */
export type AgentSpec = { provider: ProviderId; model: string | null };

export type Phase = "plan" | "build" | "repair";

/**
 * Model ids cross providers ("anthropic/claude-sonnet-4.5", "gpt-5-codex",
 * "opus"). Bounded and printable, never leading-dash (argv safety), and no
 * TOML-hostile characters — but NOT alphanumeric-only, which would refuse
 * real ids carrying `/ . : -` (Codex provider review, Q5).
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function validModelId(model: string | null): boolean {
  return model === null || MODEL_ID.test(model);
}

/** The one semantic request every provider renders into its own argv. */
export type Invocation = {
  phase: Phase;
  brief: string;
  model: string | null;
  /** Claude's turn bound. Codex has no equivalent — see `clampTimeout`. */
  maxTurns: number;
  permissionMode: string;
  skipPermissions: boolean;
  /** Resume this session (repair). Meaningless across providers. */
  resumeSession: string | null;
};

export type ProviderRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** What every envelope normalizes to, whatever dialect produced it. */
export type ParsedEnvelope = {
  sessionId: string | null;
  /** The agent's spoken conclusion — diagnostics only, never the handoff. */
  finalMessage: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  usageRaw: string | null;
};

type Adapter = {
  binary: string;
  argv(invocation: Invocation): string[];
  parse(stdout: string): ParsedEnvelope;
  /** The production transport when no runner was injected. */
  defaultRunner: ProviderRunner;
  /** Secrets the model's OWN shells must never inherit (spawn env is separate). */
  extraOmitEnv: readonly string[];
  /**
   * Codex has no --max-turns: without a turn bound the wall clock is the
   * only spending bound, so it is shortened rather than silently equated
   * with claude's economics (Codex provider review, high finding 1).
   */
  clampTimeout(phase: Phase, requestedMs: number): number;
};

const USAGE_JSON_CAP = 8 * 1024;

/** Deterministic TOML basic-string quoting for -c values — never the CLI's raw fallback. */
function toml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** OpenRouter rides codex under a PRIVATE provider key, isolated from user config. */
const OPENROUTER_PROVIDER_KEY = "standing-orders_openrouter";
export const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const claudeArgv = (invocation: Invocation): string[] => [
  "-p",
  invocation.brief,
  ...(invocation.resumeSession === null ? [] : ["--resume", invocation.resumeSession]),
  "--output-format",
  "json",
  "--max-turns",
  String(invocation.maxTurns),
  ...(invocation.skipPermissions
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", invocation.permissionMode]),
  ...(invocation.model === null ? [] : ["--model", invocation.model]),
];

function claudeParse(stdout: string): ParsedEnvelope {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      session_id?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      total_cost_usd?: unknown;
    };
    const input = parsed.usage?.input_tokens;
    const output = parsed.usage?.output_tokens;
    const cost = parsed.total_cost_usd;
    return {
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
      finalMessage: typeof parsed.result === "string" ? parsed.result : null,
      tokensIn: typeof input === "number" && input >= 0 ? input : null,
      tokensOut: typeof output === "number" && output >= 0 ? output : null,
      costUsd: typeof cost === "number" && cost >= 0 ? cost : null,
      usageRaw: parsed.usage === undefined ? null : JSON.stringify(parsed.usage).slice(0, USAGE_JSON_CAP),
    };
  } catch {
    return { sessionId: null, finalMessage: null, tokensIn: null, tokensOut: null, costUsd: null, usageRaw: null };
  }
}

/**
 * Codex argv. The brief is the positional prompt; resume is a subcommand.
 * `workspace-write` because the protocol REQUIRES workspace writes (the
 * mailbox, the handoff) — unwanted commits are caught by the same
 * post-agent proofs that gate claude. Never `--ephemeral`: repair resumes.
 */
const codexArgv = (extra: readonly string[]) => (invocation: Invocation): string[] => [
  "exec",
  ...(invocation.resumeSession === null ? [] : ["resume", invocation.resumeSession]),
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  ...(invocation.model === null ? [] : ["-m", invocation.model]),
  ...extra,
  invocation.brief,
];

/**
 * The retained JSONL lines (the streaming transport keeps only these):
 * thread.started (session), turn.completed (usage), the last agent_message.
 * Unknown events were dropped at the transport; unknown here are ignored
 * too. Missing terminal usage stays NULL — unmeasured, and said so.
 */
function codexParse(stdout: string): ParsedEnvelope {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let usageRaw: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event["type"] ?? "");
    if (type === "thread.started") {
      const id = event["thread_id"];
      if (typeof id === "string") sessionId = id;
    } else if (type === "turn.completed") {
      const usage = event["usage"] as Record<string, unknown> | undefined;
      const input = usage?.["input_tokens"];
      const output = usage?.["output_tokens"];
      // cached_input_tokens deliberately NOT summed into input — it rides
      // only in the raw record (Codex provider review, Q2).
      if (typeof input === "number" && input >= 0) tokensIn = input;
      if (typeof output === "number" && output >= 0) tokensOut = output;
      if (usage !== undefined) usageRaw = JSON.stringify(usage).slice(0, USAGE_JSON_CAP);
    } else if (type === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item !== undefined && String(item["type"] ?? "") === "agent_message") {
        const text = item["text"];
        if (typeof text === "string") finalMessage = text;
      }
    }
  }
  // Codex reports no dollars. NULL is the honest cost — unmeasured — and
  // every surface downstream already says so instead of summing a lie.
  return { sessionId, finalMessage, tokensIn, tokensOut, costUsd: null, usageRaw };
}

/** Codex wall-clock caps, phase by phase — the turn bound it does not have. */
const CODEX_TIMEOUT_CAP_MS: Record<Phase, number> = {
  build: 20 * 60_000,
  plan: 10 * 60_000,
  repair: 5 * 60_000,
};

const ADAPTERS: Record<ProviderId, Adapter> = {
  claude: {
    binary: "claude",
    argv: claudeArgv,
    parse: claudeParse,
    defaultRunner: run,
    extraOmitEnv: [],
    clampTimeout: (_phase, requested) => requested,
  },
  codex: {
    binary: "codex",
    argv: codexArgv([]),
    parse: codexParse,
    defaultRunner: runStreamJsonl,
    extraOmitEnv: [],
    clampTimeout: (phase, requested) => Math.min(requested, CODEX_TIMEOUT_CAP_MS[phase]),
  },
  openrouter: {
    binary: "codex",
    argv: codexArgv([
      "-c",
      `model_provider=${toml(OPENROUTER_PROVIDER_KEY)}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.name=${toml("OpenRouter")}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.base_url=${toml(OPENROUTER_BASE_URL)}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.env_key=${toml(OPENROUTER_ENV_KEY)}`,
      // The key rides to the trusted transport and NOWHERE the model can
      // reach: shells, hooks, and tools the agent launches never inherit it.
      "-c",
      `shell_environment_policy.exclude=[${toml(OPENROUTER_ENV_KEY)}]`,
    ]),
    parse: codexParse,
    defaultRunner: runStreamJsonl,
    extraOmitEnv: [],
    clampTimeout: (phase, requested) => Math.min(requested, CODEX_TIMEOUT_CAP_MS[phase]),
  },
};

/**
 * The spawning surface. Imported by invoke.ts and NOWHERE else — the
 * architecture test reads imports, not string literals, because provider
 * ids and binary names are legitimately the same words elsewhere.
 */
export function adapterFor(provider: ProviderId): Adapter {
  return ADAPTERS[provider];
}

/**
 * A spec a person or a config row proposed, validated to a complete pair.
 * openrouter REQUIRES a model: there is no meaningful harness default
 * across a 300-model catalog.
 */
export function validateSpec(spec: AgentSpec): { ok: true } | { ok: false; problem: string } {
  if (!isProviderId(spec.provider)) {
    return { ok: false, problem: `unknown provider \`${String(spec.provider)}\` — one of ${PROVIDER_IDS.join(", ")}` };
  }
  if (!validModelId(spec.model)) {
    return { ok: false, problem: "a model id is 1–128 characters of letters, digits, and . _ : / - (never leading with a dash)" };
  }
  if (spec.provider === "openrouter" && spec.model === null) {
    return { ok: false, problem: "openrouter needs an explicit model — there is no default across its catalog" };
  }
  return { ok: true };
}

/**
 * Whether this provider reports dollar cost. The routine budget interacts:
 * a ceiling against an unmeasured provider fails closed by design, so the
 * approval surfaces refuse the combination outright.
 */
export function reportsCost(provider: ProviderId): boolean {
  return provider === "claude";
}

/** The non-spending inspection surface: what `standing-orders providers` reports. */
export type ProviderInspection = {
  id: ProviderId;
  binary: string;
  /** argv of a CHEAP identity probe, or null when none exists without spend. */
  identityProbe: readonly string[] | null;
  /** Env var whose PRESENCE matters (never its value). */
  requiresEnv: string | null;
  measuresCost: boolean;
};

export function inspectionOf(provider: ProviderId): ProviderInspection {
  const adapter = ADAPTERS[provider];
  return {
    id: provider,
    binary: adapter.binary,
    identityProbe:
      provider === "codex" || provider === "openrouter" ? ["login", "status"] : null,
    requiresEnv: provider === "openrouter" ? OPENROUTER_ENV_KEY : null,
    measuresCost: reportsCost(provider),
  };
}
