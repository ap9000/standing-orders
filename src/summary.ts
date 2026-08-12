/**
 * The overnight, summarized — one arithmetic, shared by the CLI brief and
 * the web console so the two can never disagree about what a night cost.
 *
 * Economics are measured, never asserted: every provider spawn stamps its
 * run before spending, so `invoked` is the complete population; `measured`
 * is the subset whose envelopes actually reported cost, and the gap between
 * them is named by callers instead of summed as zero.
 */

import type { Run } from "./store.js";

export type Overnight<T extends Run> = {
  built: T[];
  failed: T[];
  refused: T[];
  /** Runs that never finished — the process died with them. Also an answer. */
  cutDown: T[];
  invoked: T[];
  measured: T[];
  spend: number;
  tokens: number;
};

export function overnight<T extends Run>(runs: T[]): Overnight<T> {
  const invoked = runs.filter(one => one.providerStartedAt !== null);
  const measured = invoked.filter(one => one.costUsd !== null);
  return {
    built: runs.filter(one => one.outcome === "built" || one.outcome === "no-change"),
    failed: runs.filter(one => one.outcome === "failed"),
    refused: runs.filter(one => one.outcome === "refused"),
    cutDown: runs.filter(one => one.outcome === null),
    invoked,
    measured,
    spend: measured.reduce((sum, one) => sum + (one.costUsd ?? 0), 0),
    tokens: invoked
      .filter(one => one.tokensOut !== null)
      .reduce((sum, one) => sum + (one.tokensOut ?? 0) + (one.tokensIn ?? 0), 0),
  };
}

/** The spend line, one wording everywhere. */
export function spendLine(summary: Overnight<Run>): string {
  if (summary.invoked.length === 0) return "nothing — no provider was invoked";
  const dollars = `$${summary.spend.toFixed(4)}`;
  return summary.measured.length === summary.invoked.length
    ? `${dollars} · ${summary.tokens.toLocaleString()} tokens, measured across all ${summary.invoked.length} invocation(s)`
    : `${dollars} measured across ${summary.measured.length}/${summary.invoked.length} invocation(s) — ${summary.invoked.length - summary.measured.length} unmeasured`;
}
