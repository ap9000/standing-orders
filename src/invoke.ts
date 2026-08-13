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

import { adapterFor, type AgentSpec, type Invocation, type ProviderRunner } from "./provider.js";
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
 * Spend money, on the record. Throws — never refuses quietly — when the run
 * is missing, already finished, or recorded against a different provider:
 * a caller that reaches for a harness without a matching open run is a
 * bug, not a case.
 */
export async function invokeAgent(
  store: Store,
  runId: number,
  spec: AgentSpec,
  invocation: Omit<Invocation, "model">,
  options: RunOptions & { runner?: ProviderRunner; clock?: () => Date },
): Promise<AgentOutcome> {
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

  // The stamp precedes the spawn, so a crash between the two leaves a run
  // that claims spend which never happened — the honest direction. A spawn
  // before the stamp would leave spend no record claims, which is the lie
  // the invariant exists to rule out.
  store.stampProviderStart(runId, clock());

  const { runner, clock: _clock, ...runOptions } = options;
  const spawn = runner ?? adapter.defaultRunner;
  const result = await spawn(adapter.binary, argv, {
    ...runOptions,
    timeoutMs,
    omitEnv: [...(runOptions.omitEnv ?? []), ...adapter.extraOmitEnv],
    // Providers run in their own process group (M6.12): the harness spawns
    // shells and tools of its own, and both the timeout and the watch's
    // hard stop must end the whole tree, not orphan the grandchildren.
    processGroup: true,
  });

  const envelope = adapter.parse(result.stdout);
  store.recordUsage(runId, {
    ...(envelope.tokensIn === null ? {} : { tokensIn: envelope.tokensIn }),
    ...(envelope.tokensOut === null ? {} : { tokensOut: envelope.tokensOut }),
    ...(envelope.costUsd === null ? {} : { costUsd: envelope.costUsd }),
    ...(envelope.usageRaw === null ? {} : { usageJson: envelope.usageRaw }),
  });

  return {
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
    // Gated on the run ALSO having nothing to show: a harness that renamed
    // its init event but completed the turn must not read as broken.
    initFailed:
      envelope.initObserved === false &&
      (result.code !== 0 || envelope.finalMessage === null) &&
      !result.timedOut &&
      !result.notFound,
  };
}
