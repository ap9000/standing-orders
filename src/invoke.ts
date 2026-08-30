/**
 * The invocation gateway: the only door to any provider binary (§5).
 *
 * "Never let an LLM poll" is only enforceable if there is exactly one place
 * that can start an LLM, and this is it. Every call verifies an open run
 * record WHOSE RECORDED PROVIDER MATCHES the one about to spawn (a repair
 * resumed on the wrong harness is a meaningless session id and a silent
 * fresh spend — refused here, structurally), stamps `provider_started_at`
 * the instant before the process spawns, and parses usage off the envelope
 * of EVERY completed process — nonzero exits included, because a failed
 * turn still spent money and a cost report that skips failures is a
 * smaller number, not a truer one.
 *
 * The architecture test asserts the boundary by imports, not by string
 * scan: only this module imports the registry's spawning surface
 * (`adapterFor`), and only builder/planner import `invokeAgent`.
 */

import { adapterFor, auditOf, type AgentSpec, type Invocation, type ProviderRunner } from "./provider.js";
import { readProviderKey, readAuthMode, PROVIDER_KEY_ENV, OWN_KEY_ENV } from "./keys.js";
import { classifyTerminal } from "./exhaustion.js";
import { attestProvider, type VersionProbe } from "./attest.js";
import { startClaudeHeldSession } from "./exec.js";
import type { Store } from "./store.js";
import type { RunOptions } from "./exec.js";

export type { ProviderRunner } from "./provider.js";

/** The claude binary name — kept for the legacy quota rows and tests that
 * describe history; new code carries a resolved AgentSpec instead. */
export const PROVIDER_BINARY = "claude";

export type ProviderUsage = {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
};

export type AgentOutcome = {
  code: number;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
  /** The harness session, for repair-by-resume on the SAME provider. */
  sessionId: string | null;
  /** The agent's spoken conclusion — diagnostics, never the handoff. */
  finalMessage: string | null;
  usage: ProviderUsage;
  /**
   * The harness never came up: the provider has an init signal, it was not
   * seen, and the turn also has nothing to show. Config, auth, or install —
   * not an agent's attempt, and callers must not treat it as one (M5
   * provider audit: init failure is retryable infrastructure, and its
   * distinct reason keeps a broken environment from reading as three
   * strikes of bad agent work).
   */
  initFailed: boolean;
};

/**
 * The value-shaped gateway result (Phase 3 B5): a refusal is a VALUE, so
 * every caller's try/finally worktree release and disposition run exactly
 * as they do for any other outcome — nothing here throws for these.
 *
 * - `provider-unattested`: the pre-spawn check failed (races past the
 *   tick's pre-claim skip — an executable swap mid-tick). No process
 *   started; the refused version is stamped on the run.
 * - `provider-protocol`: the harness ran and broke its own contract — a
 *   zero exit without the required terminal proof (A4), or an init
 *   identity that does not match the minted one (A5). Spend was recorded;
 *   the handoff must never be ingested.
 */
export type InvokeResult =
  | { kind: "ran"; outcome: AgentOutcome }
  | {
      kind: "refused";
      reason: "provider-unattested" | "provider-protocol" | "chain-credential" | "chain-custody" | "runner-custody";
      providerVersion: string | null;
      diagnostic: string | null;
    };

/**
 * Spend money, on the record. Throws — never refuses quietly — when the run
 * is missing, already finished, or recorded against a different provider:
 * a caller that reaches for a harness without a matching open run is a
 * bug, not a case. Attestation and protocol refusals are VALUES (above),
 * not throws — those are cases, and they must dispose cleanly.
 */
export async function invokeAgent(
  store: Store,
  runId: number,
  spec: AgentSpec,
  invocation: Omit<Invocation, "model">,
  options: RunOptions & { runner?: ProviderRunner; clock?: () => Date; versionProbe?: VersionProbe; keyHome?: string },
): Promise<InvokeResult> {
  const clock = options.clock ?? (() => new Date());
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null) {
    throw new Error(
      `run ${runId} is not an open attempt — nothing spends without a run record that will outlive it`,
    );
  }
  if (run.provider !== spec.provider) {
    throw new Error(
      `run ${runId} was opened for ${run.provider} but ${spec.provider} is about to spawn — a session resumed across harnesses is not a session`,
    );
  }

  const adapter = adapterFor(spec.provider);
  const argv = adapter.argv({ ...invocation, model: spec.model });
  const timeoutMs = adapter.clampTimeout(
    invocation.phase,
    options.timeoutMs ?? 30 * 60_000,
  );

  // The spawn leg of the runner gate (MCP spec v6): the tuple re-proven
  // against LIVE rows immediately before any provider process exists —
  // retirement, takeover, re-binding, or re-placement between the claim
  // and this instant refuses here, on every road through this gateway.
  if (!store.proveRunnerCustodyForSpawn(runId, clock())) {
    return {
      kind: "refused",
      reason: "runner-custody",
      providerVersion: null,
      diagnostic: "the run's runner custody lapsed before spawn — the lease, the runner, or its repo binding no longer stands",
    };
  }

  // Tier-2 attestation (A2/B3): the authoritative check, immediately
  // before the spawn it authorizes. Tier-1 providers return null here and
  // keep their road byte-identical.
  const attested = await attestProvider(spec.provider, adapter.binary, options.versionProbe);
  if (attested !== null && !attested.ok) {
    if (attested.version !== null) store.stampProviderVersion(runId, attested.version);
    return {
      kind: "refused",
      reason: "provider-unattested",
      providerVersion: attested.version,
      diagnostic: attested.problem,
    };
  }

  // Auth mode decides how the credential reaches the process (the operator
  // keeps BOTH and prefers the subscription): in "api-key" mode the
  // managed file wins, the ambient env is a real fallback (explicit
  // re-supply survives resolveChildEnv's chat-key strip); in
  // "subscription" mode the key is STRIPPED from the child so the CLI's
  // own login is used — its key is retained, just not handed over.
  // A CHAIN-BOUND run carries a PINNED mode sealed into its approved entry
  // (E3d, review finding 5): the pin IS the authority — a per-provider
  // mode-file flip between admission and spawn must never move the spend
  // onto a credential the operator didn't approve for this entry. Every
  // other run reads the operator's live setting, as always.
  const { runner, clock: _clock, versionProbe: _probe, keyHome, ...runOptions } = options;
  const authMode =
    run.chainCycle != null && run.authMode != null ? run.authMode : readAuthMode(spec.provider, keyHome);
  const ownKeyEnv = OWN_KEY_ENV[spec.provider];
  const managedKey =
    authMode === "api-key"
      ? readProviderKey(spec.provider, keyHome) ?? (process.env[PROVIDER_KEY_ENV[spec.provider]] || null)
      : null;
  // A pinned api-key entry with NO key is REFUSED, not spawned (Codex E3d
  // review, finding 1): with nothing to inject, the provider CLI would
  // quietly fall back to its cached subscription login — spend on a
  // credential the entry never approved. A value-shaped refusal before any
  // stamp: no process, no spend, no strike.
  if (run.chainCycle != null && authMode === "api-key" && managedKey === null) {
    return {
      kind: "refused",
      reason: "chain-credential",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: `the approved entry is pinned to a ${spec.provider} API key, and no managed or ambient key exists — add one on the keys screen`,
    };
  }

  // Resume XOR mint, enforced at the GATEWAY (Codex gemini verify round 2,
  // finding 3): a resume and a minted start id are mutually exclusive —
  // geminiArgv silently prefers --resume, so a minted id that rides
  // alongside a resume would be stamped and later enforced against an
  // envelope that never carried it, a paid protocol refusal. When resuming,
  // the minted id is dropped here, before it is ever stamped.
  const startSessionId = invocation.resumeSession !== null ? undefined : invocation.startSessionId;
  // The minted session identity (A5): stamped durably BEFORE the start
  // stamp — intent precedes the process, and the envelope must later
  // MATCH this id or the run fails typed.
  if (startSessionId !== undefined) {
    store.stampRun(runId, { sessionId: startSessionId });
  }

  // The stamp precedes the spawn, so a crash between the two leaves a run
  // that claims spend which never happened — the honest direction. A spawn
  // before the stamp would leave spend no record claims, which is the lie
  // the invariant exists to rule out. For attested providers the probed
  // version rides the SAME durable write (B2). A CHAIN-BOUND run's stamp is
  // the PRE-SPAWN CUSTODY PROOF (Codex E3d review, finding 3): one
  // transaction re-derives the approval, cycle, entry, pin, and (past the
  // base) the live paid-fallback grant, and stamps ONLY if all still stand
  // — a grant revoked between admission and this instant refuses here.
  if (run.chainCycle != null) {
    const custody =
      attested !== null
        ? store.proveChainCustodyForSpawn(runId, clock(), attested.version)
        : store.proveChainCustodyForSpawn(runId, clock());
    if (!custody) {
      return {
        kind: "refused",
        reason: "chain-custody",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: "the run's chain custody lapsed before spawn — the approval, cycle, entry pin, or paid-fallback grant no longer stands",
      };
    }
  } else if (attested !== null) store.stampProviderStart(runId, clock(), attested.version);
  else store.stampProviderStart(runId, clock());

  const spawn = runner ?? adapter.defaultRunner;
  // B3: the attested executable IS the spawned executable — one resolution.
  // A MANAGED key reaches exactly its own provider's child environment
  // (keys.ts): the foreign-credential strip already shed everybody
  // else's, and the plane's own env never needed to carry it. A key
  // already ambient in the environment keeps working; the managed file,
  // being deliberate, wins.
  const result = await spawn(attested !== null ? attested.executable : adapter.binary, argv, {
    ...runOptions,
    timeoutMs,
    ...(managedKey === null
      ? {}
      : { env: { ...(runOptions.env ?? {}), [PROVIDER_KEY_ENV[spec.provider]]: managedKey } }),
    omitEnv: [
      ...(runOptions.omitEnv ?? []),
      ...adapter.extraOmitEnv,
      // Subscription mode: shed this provider's OWN key too, so an ambient
      // one cannot force API billing over the login the operator prefers.
      // Api-key mode: shed every OTHER own-key alias (finding 1) — gemini
      // reads GOOGLE_API_KEY as well as GEMINI_API_KEY, and a stray alias
      // must not override the ONE canonical key this mode injected.
      ...(authMode === "subscription"
        ? ownKeyEnv
        : ownKeyEnv.filter(name => name !== PROVIDER_KEY_ENV[spec.provider])),
    ],
    // Providers run in their own process group (M6.12): the harness spawns
    // shells and tools of its own, and both the timeout and the watch's
    // hard stop must end the whole tree, not orphan the grandchildren.
    processGroup: true,
    // The session registry's crash guarantee (M6.9): the id is stamped the
    // moment the stream announces it, first write wins — a daemon that
    // dies mid-turn still knows which session to offer the successor.
    onSessionId: id => store.stampRun(runId, { sessionId: id }),
  });

  const envelope = adapter.parse(result.stdout);
  store.recordUsage(runId, {
    ...(envelope.tokensIn === null ? {} : { tokensIn: envelope.tokensIn }),
    ...(envelope.tokensOut === null ? {} : { tokensOut: envelope.tokensOut }),
    ...(envelope.costUsd === null ? {} : { costUsd: envelope.costUsd }),
    ...(envelope.usageRaw === null ? {} : { usageJson: envelope.usageRaw }),
  });

  // The fallback taxonomy stamp (E2): classify HERE, where the evidence
  // still exists — the structural terminal off this exact envelope, the
  // AUTHORITATIVE version the gateway proved at spawn, and the auth mode
  // that spawned it. `classifyTerminal` is fail-closed: with no
  // fixture-backed recognizer for this (provider, version) — the state
  // every build ships in — it can only ever return a non-eligible class,
  // so this stamp authorizes nothing. It is the honest disposal record the
  // dispatch's C8 gate later re-checks against `hasRecognizer` before it
  // reads the class as anything more than history. Tier-1 providers prove
  // no version here yet (attested === null), so they classify fail-closed
  // until their exhaustion fixture — and the version proving it needs — is
  // captured and reviewed.
  const terminalClass = classifyTerminal({
    provider: spec.provider,
    version: attested === null ? null : attested.version,
    authMode,
    terminal: envelope.structuralTerminal,
  });
  store.stampTerminalClass(runId, authMode, terminalClass);

  // The minted-identity proof (A5): once the harness initialized, the id
  // it announced must be the id the plane minted — anything else means
  // the session on disk is not the session on record, and repair must
  // never resume it. Usage above is already recorded: the spend happened.
  if (
    startSessionId !== undefined &&
    envelope.initObserved === true &&
    envelope.sessionId !== startSessionId
  ) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic:
        envelope.sessionId === null
          ? "the harness initialized without announcing its session id"
          : "the harness announced a session id different from the one it was started under",
    };
  }

  // The terminal contract (A4): when the audit requires it, a zero exit is
  // believed ONLY with initialization observed and the structural success
  // terminal present. A missing, truncated, or error-status terminal on
  // exit 0 is the harness breaking its own protocol — never a completed
  // build, and the handoff is never ingested.
  if (
    auditOf(spec.provider).terminalContract === "required" &&
    result.code === 0 &&
    !(envelope.initObserved === true && envelope.promptConsumed === true)
  ) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic:
        envelope.diagnostic ??
        (envelope.initObserved === true
          ? "the harness exited 0 without its success terminal — the stream ended mid-protocol"
          : "the harness exited 0 without ever initializing"),
    };
  }

  return {
    kind: "ran",
    outcome: {
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
      notFound: result.notFound,
      sessionId: envelope.sessionId,
      finalMessage: envelope.finalMessage,
      usage: {
        tokensIn: envelope.tokensIn,
        tokensOut: envelope.tokensOut,
        costUsd: envelope.costUsd,
      },
      // Gated on the run having NOTHING to show (Codex M5-M8 audit, C-8),
      // where "nothing to show" is STRUCTURAL when the transport can say so
      // (arc 1 finding 15): a retained error result carries diagnostic text
      // in finalMessage, and that prose must not read as an agent's attempt.
      // Transports without the consumption signal keep the historical
      // no-final-message rule. A nonzero exit WITH a consumed prompt is a
      // failed agent turn — the agent ran, spoke, and failed — and must be
      // classified as that, never as the harness failing to come up.
      initFailed:
        envelope.initObserved === false &&
        (envelope.promptConsumed === null
          ? envelope.finalMessage === null
          : envelope.promptConsumed === false) &&
        !result.timedOut &&
        !result.notFound,
    },
  };
}

/**
 * The HELD invocation gateway (Parity II Phase 2, spec v2 S0b): the only
 * door to the held-session transport, symmetric with invokeAgent — same
 * open-run verification, same provider-match rule (claude only in Phase
 * 2: nothing else can hold), same stamp-before-spawn honesty. It returns
 * the live handle rather than awaiting session end: ownership of the
 * hold belongs to the coordinator, never to a promise chain that would
 * stall the watch.
 */
export async function invokeHeldAgent(
  store: Store,
  runId: number,
  spec: AgentSpec,
  argv: readonly string[],
  options: import("./exec.js").RunOptions & {
    socketPath: string;
    cookie: string;
    graceMs?: number;
    events?: import("./exec.js").HeldSessionEvents;
    readyTimeoutMs?: number;
    clock?: () => Date;
    starter?: typeof startClaudeHeldSession;
    keyHome?: string;
  },
): Promise<import("./exec.js").HeldSessionStart> {
  const clock = options.clock ?? (() => new Date());
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null) {
    throw new Error(
      `run ${runId} is not an open attempt — nothing spends without a run record that will outlive it`,
    );
  }
  if (spec.provider !== "claude" || run.provider !== "claude") {
    throw new Error(
      `run ${runId}: only claude can hold a session in Phase 2 — ${run.provider}/${spec.provider} cannot`,
    );
  }

  const adapter = adapterFor("claude");
  const { clock: _clock, starter, socketPath, cookie, graceMs, events, readyTimeoutMs, keyHome, ...runOptions } = options;

  // The spawn leg of the runner gate (MCP spec v6) — held sessions are a
  // provider spawn like any other; a lapsed custody throws, because the
  // held road's contract is exceptions, not refusal values.
  if (!store.proveRunnerCustodyForSpawn(runId, clock())) {
    throw new Error(
      `run ${runId}: runner custody lapsed before the held spawn — the lease, the runner, or its repo binding no longer stands`,
    );
  }

  // The stamp precedes the spawn — same direction as the one-shot gateway.
  store.stampProviderStart(runId, clock());

  const heldMode = readAuthMode("claude", keyHome);
  const heldKey =
    heldMode === "api-key" ? readProviderKey("claude", keyHome) ?? (process.env[PROVIDER_KEY_ENV.claude] || null) : null;
  const start = starter ?? startClaudeHeldSession;
  return start(adapter.binary, argv, {
    ...runOptions,
    ...(heldKey === null ? {} : { env: { ...(runOptions.env ?? {}), [PROVIDER_KEY_ENV.claude]: heldKey } }),
    omitEnv: [
      ...(runOptions.omitEnv ?? []),
      ...adapter.extraOmitEnv,
      ...(heldMode === "subscription" ? OWN_KEY_ENV.claude : []),
    ],
    socketPath,
    cookie,
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    events: {
      ...events,
      onSessionId: id => {
        store.stampRun(runId, { sessionId: id });
        try {
          events?.onSessionId?.(id);
        } catch {
          // Observational.
        }
      },
    },
  });
}
