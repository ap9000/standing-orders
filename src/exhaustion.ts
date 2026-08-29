/**
 * The terminal exhaustion taxonomy (fallback chains, R1/C5/C8 of the
 * approved design). A finished attempt is classified into ONE of these,
 * where the evidence still exists — the provider adapter's structural
 * record plus the gateway's authoritative CLI version and auth mode —
 * NEVER in disposal, by which time the structural signal is gone.
 *
 * The whole feature is FAIL CLOSED by construction: a recognizer's
 * eligible-signal set is EMPTY until a versioned fixture, captured from a
 * GENUINELY EXHAUSTED subscription, proves the exact bytes. A build with
 * no fixture for a (provider, version) can therefore NEVER return an
 * eligible class — so it can never authorize a paid fallback. A
 * successful run cannot establish the exhausted shape; only real
 * exhaustion can, and the plane cannot manufacture it.
 *
 * Precedence (C5), applied by the classifier:
 * - A present STRUCTURAL FAILURE terminal blocks success ingestion even
 *   on exit 0 (that is the parser's job; this module reads the record).
 * - Only an ALLOWLISTED, version+auth-specific pattern yields an ELIGIBLE
 *   class. Exit code, bare rate-limit prose, timeout, notFound, stderr,
 *   and zero tokens NEVER independently establish exhaustion.
 * - Everything unmatched is `unknown` — the ordinary failure road.
 */

import type { ProviderId } from "./provider.js";

export type TerminalClass =
  /** The subscription/plan usage cap is spent — FALLBACK-ELIGIBLE. */
  | "usage-exhausted"
  /** An API-key account's paid credits/quota are gone — FALLBACK-ELIGIBLE. */
  | "credits-depleted"
  /** Temporary throttling NOT tied to the usage cap — backoff, NEVER paid fallback. */
  | "transient-throttle"
  /** A definite non-exhaustion terminal (ordinary failure). */
  | "not-exhausted"
  /** No structural signal matched — the ordinary failure/strike road. */
  | "unknown";

/** The two classes that may authorize a fallback advance. */
export const FALLBACK_ELIGIBLE: ReadonlySet<TerminalClass> = new Set<TerminalClass>([
  "usage-exhausted",
  "credits-depleted",
]);

export function isFallbackEligible(cls: TerminalClass): boolean {
  return FALLBACK_ELIGIBLE.has(cls);
}

/**
 * The structural terminal a provider's parser retained — the honest input
 * to classification. `failed` marks a structural FAILURE terminal (codex
 * turn.failed, a gemini error terminal): its presence blocks success
 * ingestion regardless of exit code. `text` is the bounded terminal
 * message; `code` its machine code if the harness typed one.
 */
export type StructuralTerminal = {
  failed: boolean;
  text: string | null;
  code: string | null;
};

/**
 * One provider's recognizers, keyed by the PROVEN CLI version. Each entry
 * maps a structural terminal to a class. The `eligible` matchers are the
 * ONLY road to an eligible class, and they are EMPTY until a real
 * exhausted-subscription fixture is captured and reviewed. `transient`
 * matchers keep a throttle from ever reading as exhaustion.
 */
type VersionRecognizers = {
  /** Patterns whose match means the subscription/credits are truly spent. */
  eligibleUsage: readonly RegExp[];
  eligibleCredits: readonly RegExp[];
  /** Patterns whose match means "throttled, not exhausted" — backoff only. */
  transient: readonly RegExp[];
};

/**
 * The registry. EVERY entry ships empty (fail closed). A real fixture,
 * once captured from a genuinely exhausted subscription and reviewed,
 * adds the exact patterns under that provider+version — and ONLY then can
 * that (provider, version) ever return an eligible class.
 *
 * The outer key is the provider; the inner key is the exact CLI version
 * string the gateway proved at spawn (never a range — a version this
 * build has no fixture for is unrecognized, so fail closed).
 */
const RECOGNIZERS: Record<ProviderId, Record<string, VersionRecognizers>> = {
  claude: {},
  codex: {},
  openrouter: {},
  gemini: {},
};

/** Whether THIS build carries a fixture-backed recognizer for a
 * (provider, version). The C8 gate consults this at every authority
 * point — not only at classification — so a downgrade to an unfixtured
 * build severs any in-flight fallback authority. */
export function hasRecognizer(provider: ProviderId, version: string | null): boolean {
  if (version === null) return false;
  // Object.hasOwn keeps the lookup TOTAL for adversarial version strings
  // (Codex foundation review, finding 3): "__proto__" / "constructor" /
  // "toString" must resolve to "no recognizer", never an inherited property.
  if (!Object.hasOwn(RECOGNIZERS[provider], version)) return false;
  const perVersion = RECOGNIZERS[provider][version];
  if (perVersion === undefined) return false;
  return perVersion.eligibleUsage.length > 0 || perVersion.eligibleCredits.length > 0;
}

/**
 * Classify a finished attempt. Fail closed: no recognizer for this exact
 * (provider, version) => never an eligible class. `authMode` decides which
 * eligible class a match yields — a subscription that hits its cap is
 * `usage-exhausted`; an api-key account out of credits is
 * `credits-depleted`. A structural failure with no eligible/transient
 * match is `not-exhausted`; no structural failure and no match is
 * `unknown`.
 */
export function classifyTerminal(args: {
  provider: ProviderId;
  version: string | null;
  authMode: "subscription" | "api-key";
  terminal: StructuralTerminal | null;
}): TerminalClass {
  const { provider, version, authMode, terminal } = args;
  if (terminal === null) return "unknown";
  // The classifier's contract permits failed:false, but a non-failure
  // terminal is never exhaustion (Codex foundation review, finding 4):
  // only a structural FAILURE terminal is even eligible for matching.
  if (terminal.failed !== true) return "unknown";
  const perVersion =
    version !== null && Object.hasOwn(RECOGNIZERS[provider], version) ? RECOGNIZERS[provider][version] : undefined;
  const haystack = `${terminal.code ?? ""}\n${terminal.text ?? ""}`;
  if (perVersion !== undefined) {
    // Transient throttle is checked FIRST so a throttle can never be read
    // as exhaustion (Claude's "temporarily limiting requests — not your
    // usage limit" family).
    if (perVersion.transient.some(re => re.test(haystack))) return "transient-throttle";
    // Then the eligible sets, gated by auth mode.
    if (authMode === "subscription" && perVersion.eligibleUsage.some(re => re.test(haystack))) {
      return "usage-exhausted";
    }
    if (authMode === "api-key" && perVersion.eligibleCredits.some(re => re.test(haystack))) {
      return "credits-depleted";
    }
  }
  // A structural FAILURE terminal that matched nothing is a definite
  // non-exhaustion terminal (a non-failure terminal already returned
  // unknown above).
  return "not-exhausted";
}
