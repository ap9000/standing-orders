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
 * - A sign-in that no longer works (`auth-expired`) is recognized FIRST,
 *   for every provider and version: an expired or revoked login is not a
 *   property of a CLI version, and retrying it only burns attempts. It is
 *   never fallback-eligible — a lapsed login must not reach a paid key.
 */

import type { ProviderId } from "./provider.js";

export type TerminalClass =
  /** The subscription/plan usage cap is spent — FALLBACK-ELIGIBLE. */
  | "usage-exhausted"
  /** An API-key account's paid credits/quota are gone — FALLBACK-ELIGIBLE. */
  | "credits-depleted"
  /** Temporary throttling NOT tied to the usage cap — backoff, NEVER paid fallback. */
  | "transient-throttle"
  /** The provider's sign-in or API key no longer works — NO retry, NO
   * fallback: dispatch for that provider pauses until someone signs in. */
  | "auth-expired"
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

/**
 * The recognizer lookup. Reads ONLY the module-level RECOGNIZERS registry —
 * there is NO mutation surface, so no build (production or otherwise) can
 * install a recognizer at runtime; a real fixture arrives as a source edit,
 * reviewed in a text diff (Codex E2/E3 review, finding 1). The suite proves
 * the eligible path by MOCKING this module, never by a shipped seam.
 * Object.hasOwn keeps the lookup TOTAL for adversarial version strings
 * (foundation review, finding 3): "__proto__" / "constructor" / "toString"
 * resolve to "no recognizer", never an inherited property.
 */
function recognizersFromRegistry(provider: ProviderId, version: string): VersionRecognizers | undefined {
  if (!Object.hasOwn(RECOGNIZERS[provider], version)) return undefined;
  return RECOGNIZERS[provider][version];
}

/** Whether THIS build carries a fixture-backed recognizer for a
 * (provider, version). The C8 gate consults this at every authority
 * point — not only at classification — so a downgrade to an unfixtured
 * build severs any in-flight fallback authority. */
export function hasRecognizer(provider: ProviderId, version: string | null): boolean {
  if (version === null) return false;
  const perVersion = recognizersFromRegistry(provider, version);
  if (perVersion === undefined) return false;
  return perVersion.eligibleUsage.length > 0 || perVersion.eligibleCredits.length > 0;
}

/**
 * The EXACT C8 capability check (Codex E2/E3 review, finding 8): whether
 * this build can recognize the specific eligible class an AUTH MODE would
 * produce — a subscription's `usage-exhausted` needs a nonempty
 * eligibleUsage set; an api-key account's `credits-depleted` needs a
 * nonempty eligibleCredits set. `hasRecognizer` (any-eligible) is too coarse
 * at the authority point: a version fixtured for usage only must NOT
 * authorize a credits-depleted advance.
 */
export function recognizesEligible(
  provider: ProviderId,
  version: string | null,
  authMode: "subscription" | "api-key",
): boolean {
  if (version === null) return false;
  const perVersion = recognizersFromRegistry(provider, version);
  if (perVersion === undefined) return false;
  return authMode === "subscription" ? perVersion.eligibleUsage.length > 0 : perVersion.eligibleCredits.length > 0;
}

/** The eligible class an auth mode can legitimately carry — the C8
 * consistency invariant: `usage-exhausted` iff subscription,
 * `credits-depleted` iff api-key. A stamp that violates this pairing is a
 * bad/overwritten record and must never advance. */
export function classMatchesAuthMode(cls: TerminalClass, authMode: "subscription" | "api-key"): boolean {
  if (cls === "usage-exhausted") return authMode === "subscription";
  if (cls === "credits-depleted") return authMode === "api-key";
  return false;
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
  /** What a run that failed within seconds, having produced nothing, said
   * on its way out (stderr and unstructured stdout) — read ONLY for the
   * sign-in signal: a CLI that is not logged in often exits before its
   * structured stream begins. */
  earlyExit?: string | null;
}): TerminalClass {
  const { provider, version, authMode, terminal } = args;
  // A sign-in that no longer works, before anything else and for any
  // provider or version: no fixture is needed to know a login is gone.
  if (terminal !== null && terminal.failed === true && isAuthFailure(`${terminal.code ?? ""}\n${terminal.text ?? ""}`)) return "auth-expired";
  if (typeof args.earlyExit === "string" && isAuthFailure(args.earlyExit)) return "auth-expired";
  if (terminal === null) return "unknown";
  // The classifier's contract permits failed:false, but a non-failure
  // terminal is never exhaustion (Codex foundation review, finding 4):
  // only a structural FAILURE terminal is even eligible for matching.
  if (terminal.failed !== true) return "unknown";
  const perVersion = version === null ? undefined : recognizersFromRegistry(provider, version);
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

/**
 * The sign-in signals, provider-neutral: Claude's expired or unrefreshable
 * OAuth session and its "Please run /login", an API key the provider calls
 * invalid or revoked, Codex's and Gemini's "not logged in", and an HTTP 401
 * the harness reports as its terminal. Ordinary failures (a test that
 * failed, a timeout, a usage limit) match none of these.
 */
const AUTH_FAILURE: readonly RegExp[] = [
  // Provider-specific phrasings only: a build's own output (a login feature's
  // tests, an HTTP 401 in a log) must never read as the agent's sign-in.
  /\bOAuth (?:session|token)\b[^\n]{0,80}\b(?:expired|could not be refreshed|revoked|invalid)/i,
  /\bFailed to authenticate\b[^\n]{0,40}\b(?:OAuth|token|session|credentials|API key)/i,
  /\bPlease run \/login\b/i,
  /\binvalid[ _-](?:x-)?api[ _-]?key\b/i,
  /\binvalid bearer token\b/i,
  /\bapi[ _-]?key\b[^\n]{0,40}\b(?:is )?(?:invalid|revoked|expired|not valid)\b/i,
  /"type"\s*:\s*"authentication_error"/i,
  /\bMissing bearer (?:or basic )?authentication\b/i,
  /^Not logged in\b/m,
];

/** Whether a provider's own words say its sign-in or key no longer works. */
export function isAuthFailure(text: string): boolean {
  const bounded = text.slice(0, 8192);
  return AUTH_FAILURE.some(re => re.test(bounded));
}
