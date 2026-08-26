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

import { type ExecResult, type RunOptions } from "./exec.js";
import { runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl } from "./exec.js";
import { scanForSecrets } from "./evidence.js";

export type ProviderId = "claude" | "codex" | "openrouter" | "gemini";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "openrouter", "gemini"];

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
  /** Claude's native dollar cap (tournament stage 3b) — the harness stops
   * itself when spend reaches this. Ignored by providers without one. */
  maxBudgetUsd?: number;
  /** A plane-minted session identity, for providers that can START under a
   * caller-chosen id (gemini `--session-id`). The gateway stamps it
   * durably BEFORE spawn and requires the envelope's init id to EQUAL it
   * (Phase 3 A5) — a mismatch is a provider-protocol failure, never a
   * silent survivor. */
  startSessionId?: string;
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
  /**
   * Whether the provider was seen to initialize (codex: thread.started;
   * claude streaming: system/init). null = this transport carries no init
   * signal (legacy buffered fixtures), so absence proves nothing. A `false`
   * here on a failed run means the harness never came up — config, auth,
   * or install — and the turn must not be treated as an agent's attempt
   * (M5 provider audit).
   */
  initObserved: boolean | null;
  /**
   * Structural proof the MAIN QUERY consumed the prompt (arc 1 finding 15):
   * true only when the primary result is a success. null = this transport
   * carries no such signal, and the gateway falls back to its historical
   * nothing-to-show rule. Never derived from result PROSE — an error
   * result's diagnostic text must not read as an agent's attempt.
   */
  promptConsumed: boolean | null;
  /**
   * The harness's own first error message, bounded (2 KiB UTF-8), kept for
   * refusal words and evidence — DIAGNOSTICS ONLY, control-normalized and
   * secret-scanned at render, never classification (Phase 3 B6). null =
   * the transport carries none or none was seen.
   */
  diagnostic: string | null;
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

/**
 * The held-session argv (Parity II Phase 2): the same family as
 * claudeArgv MINUS the positional prompt — every turn, the brief
 * included, rides stdin as stream-json — plus the input format flag.
 * maxBudgetUsd is the Probe-6 backstop: the CLI's cap is cumulative
 * across the whole process, so the remaining authorization budget rides
 * the argv and later turns cannot spend past it.
 */
export const claudeHeldArgv = (invocation: Omit<Invocation, "brief">): string[] => [
  "-p",
  ...(invocation.resumeSession === null ? [] : ["--resume", invocation.resumeSession]),
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  String(invocation.maxTurns),
  ...(invocation.skipPermissions
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", invocation.permissionMode]),
  ...(invocation.model === null ? [] : ["--model", invocation.model]),
  ...(invocation.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(invocation.maxBudgetUsd)]),
];

const claudeArgv = (invocation: Invocation): string[] => [
  "-p",
  invocation.brief,
  ...(invocation.resumeSession === null ? [] : ["--resume", invocation.resumeSession]),
  // stream-json (arc 1): the terminal result event IS the old buffered
  // envelope, now arriving as one line of many — the streaming transport
  // retains it structurally instead of buffering the whole session into
  // an 8 MiB kill. --verbose is required by the harness for stream-json
  // with -p and changes nothing else.
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  String(invocation.maxTurns),
  ...(invocation.skipPermissions
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", invocation.permissionMode]),
  ...(invocation.model === null ? [] : ["--model", invocation.model]),
  ...(invocation.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(invocation.maxBudgetUsd)]),
];

/** A claude envelope object, whichever line carried it. */
type ClaudeResultShape = {
  result?: unknown;
  session_id?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  total_cost_usd?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  origin?: unknown;
};

/**
 * The primary-result allowlist (arc 1 finding 10): only an absent origin or
 * an explicit human origin can be the main query's accounting envelope.
 * Every other kind — task-notification, channel, peer, coordinator, and
 * anything the SDK grows later — fails closed as a non-primary result.
 */
function claudePrimaryOrigin(event: ClaudeResultShape): boolean {
  if (event.origin === undefined || event.origin === null) return true;
  return typeof event.origin === "object" && String((event.origin as Record<string, unknown>)["kind"] ?? "") === "human";
}

function claudeEnvelopeOf(
  result: ClaudeResultShape | null,
  sessionFromInit: string | null,
  initObserved: boolean | null,
): ParsedEnvelope {
  const input = result?.usage?.input_tokens;
  const output = result?.usage?.output_tokens;
  const cost = result?.total_cost_usd;
  return {
    sessionId:
      typeof result?.session_id === "string" ? result.session_id : sessionFromInit,
    finalMessage: typeof result?.result === "string" ? result.result : null,
    tokensIn: typeof input === "number" && input >= 0 ? input : null,
    tokensOut: typeof output === "number" && output >= 0 ? output : null,
    costUsd: typeof cost === "number" && cost >= 0 ? cost : null,
    usageRaw: result?.usage === undefined ? null : JSON.stringify(result.usage).slice(0, USAGE_JSON_CAP),
    initObserved,
    // Structural, never prose (finding 15): consumed means the primary
    // result says SUCCESS. An error result keeps its text as diagnostics
    // while proving nothing about delivery; when the transport carries no
    // signal (legacy buffered), null defers to the gateway's old rule.
    promptConsumed:
      initObserved === null
        ? null
        : result !== null && result.is_error !== true && String(result.subtype ?? "") === "success",
    diagnostic: null,
  };
}

/**
 * Reads the streaming runner's retained lines: at most one `system`/`init`
 * and one primary `result`, re-proved here (the parser trusts no transport
 * to have selected correctly). A single objet without a `type` field is the
 * legacy buffered envelope — kept for recorded fixtures, carrying no init
 * signal, exactly as before the transport switch.
 */
function claudeParse(stdout: string): ParsedEnvelope {
  let initSeen = false;
  let sessionFromInit: string | null = null;
  let primary: ClaudeResultShape | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const type = event["type"];
    if (type === undefined) {
      // Legacy buffered envelope: one JSON object, no event framing.
      return claudeEnvelopeOf(event as ClaudeResultShape, null, null);
    }
    if (String(type) === "system" && String(event["subtype"] ?? "") === "init") {
      initSeen = true;
      const id = event["session_id"];
      if (typeof id === "string" && id !== "") sessionFromInit = id;
    } else if (String(type) === "result" && primary === null && claudePrimaryOrigin(event as ClaudeResultShape)) {
      primary = event as ClaudeResultShape;
    }
  }
  return claudeEnvelopeOf(primary, sessionFromInit, initSeen);
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
  let initObserved = false;
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
      // The init signal, id or no id: the harness came up. A malformed
      // thread_id loses the session, not the fact of initialization.
      initObserved = true;
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
  // promptConsumed stays null: codex carries no structural consumption
  // signal, and the gateway keeps its historical rule for it.
  return { sessionId, finalMessage, tokensIn, tokensOut, costUsd: null, usageRaw, initObserved, promptConsumed: null, diagnostic: null };
}

/** Codex wall-clock caps, phase by phase — the turn bound it does not have. */
const CODEX_TIMEOUT_CAP_MS: Record<Phase, number> = {
  build: 20 * 60_000,
  plan: 10 * 60_000,
  repair: 5 * 60_000,
};

/**
 * Gemini argv (Phase 3, v0.57.0 audit). The brief is `-p` (headless);
 * `--approval-mode` is the ONE sealed autonomy dial — skipPermissions
 * maps to yolo exactly where claude maps it to bypass, anything else is
 * auto_edit (fail-closed: never `default`, whose headless behavior is
 * tool failure, and never `plan`, which cannot write the mailbox).
 * Session identity is minted by the plane (`--session-id`) or resumed
 * (`--resume`) — never both. No turn bound and no dollar cap exist to
 * render (the audit and money capabilities say so instead).
 */
const geminiArgv = (invocation: Invocation): string[] => [
  "-p",
  invocation.brief,
  "--output-format",
  "stream-json",
  "--approval-mode",
  invocation.skipPermissions ? "yolo" : "auto_edit",
  ...(invocation.resumeSession !== null
    ? ["--resume", invocation.resumeSession]
    : invocation.startSessionId !== undefined
      ? ["--session-id", invocation.startSessionId]
      : []),
  ...(invocation.model === null ? [] : ["-m", invocation.model]),
];

/** Gemini wall-clock caps: the codex posture — no turn bound exists, so
 * the clock is the spending bound and it is SHORTENED, never equated. */
const GEMINI_TIMEOUT_CAP_MS: Record<Phase, number> = {
  build: 20 * 60_000,
  plan: 10 * 60_000,
  repair: 5 * 60_000,
};

const DIAGNOSTIC_CAP = 2 * 1024;

/**
 * Reads the gemini retention runner's synthetic stdout (Phase 3 D2/A7):
 * at most one `init` (the init signal + session id — result events carry
 * no id, so identity is init-or-nothing), one `synthetic_message` (the
 * runner-assembled assistant text; a type the real CLI cannot emit, so
 * fixtures and transport share an unambiguous contract), the LAST
 * `result` (tokens + structural status), and the first error line
 * (diagnostics only). No legacy branch: the attestation floor is the
 * only dialect this parser has ever had to honor.
 */
function geminiParse(stdout: string): ParsedEnvelope {
  let initSeen = false;
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let usageRaw: string | null = null;
  let resultStatus: string | null = null;
  let diagnostic: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const type = String(event["type"] ?? "");
    if (type === "init") {
      if (!initSeen) {
        initSeen = true;
        const id = event["session_id"];
        if (typeof id === "string" && id !== "") sessionId = id;
      }
    } else if (type === "synthetic_message") {
      const content = event["content"];
      if (typeof content === "string") finalMessage = content;
    } else if (type === "result") {
      resultStatus = String(event["status"] ?? "");
      const stats = event["stats"] as Record<string, unknown> | undefined;
      const input = stats?.["input_tokens"];
      const output = stats?.["output_tokens"];
      if (typeof input === "number" && input >= 0) tokensIn = input;
      if (typeof output === "number" && output >= 0) tokensOut = output;
      if (stats !== undefined) usageRaw = JSON.stringify(stats).slice(0, USAGE_JSON_CAP);
      const resultError = event["error"] as Record<string, unknown> | undefined;
      const message = resultError?.["message"];
      if (diagnostic === null && typeof message === "string" && message !== "") {
        diagnostic = safeDiagnostic(message);
      }
    } else if (type === "error") {
      const message = event["message"];
      if (diagnostic === null && String(event["severity"] ?? "") === "error" && typeof message === "string" && message !== "") {
        diagnostic = safeDiagnostic(message);
      }
    }
  }
  return {
    sessionId,
    finalMessage,
    tokensIn,
    tokensOut,
    // Gemini reports tokens, never dollars. NULL is the honest cost.
    costUsd: null,
    usageRaw,
    initObserved: initSeen,
    // Structural, never prose: consumed means the terminal result said
    // SUCCESS. Missing or error results prove nothing about delivery —
    // and for this provider the gateway's terminal contract REQUIRES the
    // proof before exit 0 is believed (Phase 3 A4).
    promptConsumed: resultStatus === "success",
    diagnostic,
  };
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function capUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  // The ellipsis lives INSIDE the byte budget, not on top of it.
  const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, bytes - 3));
  return buffer.toString("utf8").replace(/�+$/, "") + "…";
}

/**
 * The diagnostic discipline (Phase 3 B6/C6): the harness's own words are
 * untrusted bytes headed for refusal screens and notifications — controls
 * and line separators collapse to spaces (the fence's character class),
 * and a line that trips the secret scanner is REPLACED, never quoted.
 */
function safeDiagnostic(text: string): string | null {
  const normalized = text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").trim();
  if (normalized === "") return null;
  if (scanForSecrets(normalized).length > 0) return "the harness's error text was withheld — it matched a secret pattern";
  return capUtf8(normalized, DIAGNOSTIC_CAP);
}

const ADAPTERS: Record<ProviderId, Adapter> = {
  claude: {
    binary: "claude",
    argv: claudeArgv,
    parse: claudeParse,
    defaultRunner: runClaudeStreamJsonl,
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
  gemini: {
    binary: "gemini",
    argv: geminiArgv,
    parse: geminiParse,
    defaultRunner: runGeminiStreamJsonl,
    extraOmitEnv: [],
    clampTimeout: (phase, requested) => Math.min(requested, GEMINI_TIMEOUT_CAP_MS[phase]),
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
 * The provider audit: what each harness supports, what we actually pass,
 * and what user-global configuration can leak into an unattended run.
 * REPORT BEFORE ENFORCEMENT (Codex roadmap review, item 10): none of this
 * changes an invocation — it states facts an operator reads on `providers`,
 * so hermetic mode can later be turned on per provider from evidence
 * instead of hope. `enforced` is a literal false until that day.
 */
export type ProviderAudit = {
  /** How output reaches us — and therefore which signals can exist at all. */
  transport: "buffered-json" | "streaming-jsonl";
  /** Whether a later invocation can resume this provider's session. */
  resume: "native" | "none";
  /** The event whose absence on a failed run means "never initialized".
   * CAPABILITY metadata, not a per-run observation (arc 1 finding 16):
   * whether a given run actually saw it lives in ParsedEnvelope.initObserved. */
  initSignal: "thread.started" | "system-init" | "init-event" | "none";
  /** How session identity is established: "announced" = read back from the
   * harness's own stream; "minted" = the PLANE chooses the id pre-spawn
   * (gemini --session-id) and the envelope must echo it (Phase 3 A5). */
  sessionIdentity: "announced" | "minted";
  /**
   * Whether exit 0 is believed on its own (Phase 3 A4). "required" =
   * the transport carries a structural terminal signal and the gateway
   * accepts a zero exit ONLY with init observed AND promptConsumed true —
   * a missing, truncated, or error-status terminal is a provider-protocol
   * failure BEFORE handoff ingestion. "none" = today's exit-code
   * discipline, byte-identical for tier-1 providers.
   */
  terminalContract: "required" | "none";
  isolation: {
    /** The harness's hermetic flag, if it has one. We do not pass it. */
    flag: string | null;
    /** Whether that flag preserves resume. false = documented conflict. */
    resumeSafe: boolean | null;
    enforced: false;
  };
  /** User-global surfaces that can reach an invocation today. */
  configSurface: readonly string[];
};

const AUDITS: Record<ProviderId, ProviderAudit> = {
  claude: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "system-init",
    sessionIdentity: "announced",
    terminalContract: "none",
    isolation: { flag: "--bare", resumeSafe: null, enforced: false },
    configSurface: [
      "~/.claude/CLAUDE.md and settings (hooks, MCP servers, plugins)",
      "repository CLAUDE.md / .claude directory",
    ],
  },
  codex: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "thread.started",
    sessionIdentity: "announced",
    terminalContract: "none",
    // --ephemeral exists and is deliberately not passed: repair resumes
    // sessions, and ephemeral runs have none to resume.
    isolation: { flag: "--ephemeral", resumeSafe: false, enforced: false },
    configSurface: ["~/.codex/config.toml", "repository AGENTS.md"],
  },
  openrouter: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "thread.started",
    sessionIdentity: "announced",
    terminalContract: "none",
    isolation: { flag: "--ephemeral", resumeSafe: false, enforced: false },
    // The constant -c overrides pin the model provider per invocation, so
    // user config cannot reroute the spend — but the file still loads.
    configSurface: ["~/.codex/config.toml (model_provider pinned per invocation)", "repository AGENTS.md"],
  },
  gemini: {
    transport: "streaming-jsonl",
    resume: "none",
    // "none" until the live S1 probe proves headless persistence AND
    // resume-by-uuid; the repair road's fresh-session branch keys on this
    // (Phase 3 A8). Flipping it is a re-attestation commit, not a hope.
    initSignal: "init-event",
    sessionIdentity: "minted",
    terminalContract: "required",
    isolation: { flag: "--sandbox", resumeSafe: null, enforced: false },
    configSurface: [
      "~/.gemini/settings.json (HOOKS — BeforeAgent/AfterTool commands run inside every invocation — plus MCP servers and model settings)",
      "project .gemini/settings.json",
      "GEMINI.md (global and repository)",
      "extensions, skills, and policy files",
      "GEMINI_API_KEY / GOOGLE_GENAI_USE_* environment (an API key in env is visible to shells the agent runs — prefer cached login or ADC for unattended work)",
    ],
  },
};

/** Read-only facts about a provider — safe anywhere, spawns nothing. */

/**
 * The tournament capability matrix (design v3 finding 14): what each
 * harness can PROVE about money, stated as data. Eligibility is derived,
 * never asserted: a provider races only when its own machinery can hold
 * a dollar cap. Codex and OpenRouter report billable usage only at turn
 * end (cumulative across resumed sessions), so no mid-run cap exists to
 * hold — ineligible until their harnesses grow one.
 */
export type ProviderMoneyCapabilities = {
  /** Usage events arrive during the run, not only at the end. */
  incrementalUsage: boolean;
  /** The harness's own dollar-cap flag, when one exists. */
  nativeDollarCapFlag: string | null;
  usageSemantics: "per-invocation" | "cumulative-session";
  /** Whether this harness may race in a dollar-capped tournament. */
  tournamentEligible: boolean;
  /** Said in words on refusal screens. */
  whyIneligible: string | null;
};

export const MONEY_CAPABILITIES: Record<ProviderId, ProviderMoneyCapabilities> = {
  claude: {
    incrementalUsage: true,
    nativeDollarCapFlag: "--max-budget-usd",
    usageSemantics: "per-invocation",
    tournamentEligible: true,
    whyIneligible: null,
  },
  codex: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    usageSemantics: "cumulative-session",
    tournamentEligible: false,
    whyIneligible: "codex reports billable usage only when a turn completes — no mid-run dollar cap exists to enforce",
  },
  openrouter: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    usageSemantics: "cumulative-session",
    tournamentEligible: false,
    whyIneligible: "openrouter rides the codex harness here and shares its turn-end-only usage reporting",
  },
  gemini: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    // Stats come from a per-process telemetry service: an invocation's
    // numbers cover that invocation only (conformance fixture j).
    usageSemantics: "per-invocation",
    tournamentEligible: false,
    whyIneligible: "gemini reports tokens, never dollars — no native cap exists to hold",
  },
};

/**
 * The fail-closed budget-flag probe (finding 24's amendment): resolve
 * the EXACT executable that will spawn, read its version, and prove the
 * flag exists in that binary's own help — presence is a feature check
 * and nothing more; pricing and semantics stay pinned in pricing.ts.
 */
export async function probeBudgetCap(
  provider: ProviderId,
  runner: (command: string, argv: readonly string[], options: { timeoutMs?: number }) => Promise<ExecResult>,
): Promise<{ ok: true; executable: string; version: string } | { ok: false; problem: string }> {
  const flag = MONEY_CAPABILITIES[provider].nativeDollarCapFlag;
  if (flag === null) return { ok: false, problem: `${provider} has no native dollar cap` };
  const binary = provider === "claude" ? "claude" : provider;
  const where = await runner("which", [binary], { timeoutMs: 5_000 });
  if (where.code !== 0) return { ok: false, problem: `${binary} is not on PATH` };
  const executable = where.stdout.trim().split("\n")[0] ?? "";
  const version = await runner(executable, ["--version"], { timeoutMs: 10_000 });
  if (version.code !== 0) return { ok: false, problem: `${executable} did not answer --version` };
  const help = await runner(executable, ["--help"], { timeoutMs: 10_000 });
  if (help.code !== 0 || !help.stdout.includes(flag)) {
    return { ok: false, problem: `${executable} does not advertise ${flag} — the dollar cap cannot be enforced` };
  }
  return { ok: true, executable, version: version.stdout.trim() };
}

export function auditOf(provider: ProviderId): ProviderAudit {
  return AUDITS[provider];
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
  if (spec.provider === "gemini" && spec.model === null) {
    return { ok: false, problem: "gemini needs an explicit model — the harness default drifts with its releases" };
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
