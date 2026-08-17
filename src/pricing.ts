/**
 * Pinned build-model prices (tournament design v3, stage 1; the round-3
 * findings are the spec). Integer micro-dollars per SINGLE token, rounded
 * UP from list prices, with the cache token classes priced separately —
 * finding 24: a "one call" tail computed from rates alone bounds nothing;
 * quantity must be pinned too, so every model row carries its context
 * window and maximum output, and the tail is the worst legal call:
 * every context token at the DEAREST input class plus every output token.
 *
 * Conservative by construction: reservations overcharge, never under.
 * PRICE_VERSION is stamped into approved tournament terms — a price table
 * edit never silently reprices an existing approval.
 */

export const BUILD_PRICE_VERSION = 1;

export type BuildModelPrice = {
  /** Micro-dollars per token, ceil'd from list. */
  inMicrousd: number;
  outMicrousd: number;
  cacheWriteMicrousd: number;
  cacheReadMicrousd: number;
  /** The pinned request envelope's quantity bounds (finding 24). */
  contextTokens: number;
  maxOutputTokens: number;
};

const PRICES: Record<string, BuildModelPrice> = {
  "claude-sonnet-5": {
    inMicrousd: 3,
    outMicrousd: 15,
    cacheWriteMicrousd: 4, // 1.25x input, ceil'd
    cacheReadMicrousd: 1, // 0.1x input, ceil'd up
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
  },
  "claude-opus-5": {
    inMicrousd: 15,
    outMicrousd: 75,
    cacheWriteMicrousd: 19,
    cacheReadMicrousd: 2,
    contextTokens: 200_000,
    maxOutputTokens: 32_000,
  },
  "claude-haiku-4-5": {
    inMicrousd: 1,
    outMicrousd: 5,
    cacheWriteMicrousd: 2,
    cacheReadMicrousd: 1,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
  },
};

export function buildPriceOf(model: string): BuildModelPrice | null {
  return PRICES[model] ?? null;
}

export const PRICED_BUILD_MODELS: readonly string[] = Object.keys(PRICES);

/**
 * The non-spendable overrun reserve: the worst one API call the pinned
 * envelope permits. Claude's native cap checks the budget AFTER each
 * call, so the true maximum is budget + one full call — this is that
 * call, priced at the dearest input class (finding 24's arithmetic).
 * Held apart from the spendable budget and NEVER granted to a later
 * invocation: each lineage invocation's native cap derives from
 * max(spendable − accounted, 0) alone.
 */
export function oneCallTailMicrousd(model: string): number | null {
  const price = buildPriceOf(model);
  if (price === null) return null;
  const dearestInput = Math.max(price.inMicrousd, price.cacheWriteMicrousd, price.cacheReadMicrousd);
  return price.contextTokens * dearestInput + price.maxOutputTokens * price.outMicrousd;
}

/** Settlement at pinned rates from a usage report that itemizes cache
 * classes; absent classes count as zero, absent totals fail closed by
 * returning null (the caller latches unknown spend, never guesses). */
export function settleBuildMicrousd(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number },
): number | null {
  const price = buildPriceOf(model);
  if (price === null) return null;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return null;
  return (
    inputTokens * price.inMicrousd +
    outputTokens * price.outMicrousd +
    (usage.cacheWriteTokens ?? 0) * price.cacheWriteMicrousd +
    (usage.cacheReadTokens ?? 0) * price.cacheReadMicrousd
  );
}
