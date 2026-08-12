/**
 * The invocation gateway: the only door to the provider binary (§5).
 *
 * "Never let an LLM poll" is only enforceable if there is exactly one place
 * that can start an LLM, and this is it. Every call verifies an open run
 * record, stamps `provider_started_at` the instant before the process
 * spawns, and parses usage off the envelope of EVERY completed process —
 * nonzero exits included, because a failed turn still spent money and a
 * cost report that skips failures is a smaller number, not a truer one.
 *
 * An architecture test asserts no other production module names the
 * provider binary. The zero-token invariant this makes real: provider
 * spawns == runs carrying provider_started_at, and each stamp precedes its
 * spawn.
 */

import type { Store } from "./store.js";
import type { ExecResult, RunOptions } from "./exec.js";

/** The provider binary. Referenced here and nowhere else in production code. */
export const PROVIDER_BINARY = "claude";

/** How the caller actually spawns — injectable so tests script the provider. */
export type ProviderRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

const USAGE_JSON_CAP = 8 * 1024;

export type ProviderUsage = {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
};

/**
 * Spend money, on the record. Throws — never refuses quietly — when the run
 * is missing or already finished: a caller that reaches for the provider
 * without an open run is a bug, not a case.
 */
export async function invokeAgent(
  store: Store,
  runId: number,
  args: readonly string[],
  options: RunOptions & { runner: ProviderRunner; clock?: () => Date },
): Promise<ExecResult & { usage: ProviderUsage }> {
  const clock = options.clock ?? (() => new Date());
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null) {
    throw new Error(
      `run ${runId} is not an open attempt — nothing spends without a run record that will outlive it`,
    );
  }

  // The stamp precedes the spawn, so a crash between the two leaves a run
  // that claims spend which never happened — the honest direction. A spawn
  // before the stamp would leave spend no record claims, which is the lie
  // the invariant exists to rule out.
  store.stampProviderStart(runId, clock());

  const { runner, clock: _clock, ...runOptions } = options;
  const result = await runner(PROVIDER_BINARY, args, runOptions);

  const usage = parseUsage(result.stdout);
  store.recordUsage(runId, {
    ...(usage.tokensIn === null ? {} : { tokensIn: usage.tokensIn }),
    ...(usage.tokensOut === null ? {} : { tokensOut: usage.tokensOut }),
    ...(usage.costUsd === null ? {} : { costUsd: usage.costUsd }),
    ...(usage.raw === null ? {} : { usageJson: usage.raw }),
  });

  return { ...result, usage };
}

/**
 * The envelope's usage block, taken from any process that produced one —
 * exit code notwithstanding. Absent or malformed stays null: the brief
 * reports "measured across X of Y invocations", never a sum that quietly
 * skipped the expensive failures.
 */
function parseUsage(stdout: string): ProviderUsage & { raw: string | null } {
  try {
    const parsed = JSON.parse(stdout) as {
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      total_cost_usd?: unknown;
    };
    const input = parsed.usage?.input_tokens;
    const output = parsed.usage?.output_tokens;
    const cost = parsed.total_cost_usd;
    const raw =
      parsed.usage === undefined ? null : JSON.stringify(parsed.usage).slice(0, USAGE_JSON_CAP);
    return {
      tokensIn: typeof input === "number" && input >= 0 ? input : null,
      tokensOut: typeof output === "number" && output >= 0 ? output : null,
      costUsd: typeof cost === "number" && cost >= 0 ? cost : null,
      raw,
    };
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: null };
  }
}
