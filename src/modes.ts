/**
 * Operating modes (v29, the modes chain v1–v7): a per-repository,
 * password-signed, expiring envelope that pre-authorizes the SIGNER'S OWN
 * future acts. The absence of a mode is 'locked' — every act keeps its
 * own ceremony, today's world, the default forever.
 *
 * The doctrine (v4 ruling): RAISING authority is a password ceremony;
 * LOWERING it is one click for any approver; on revocation or expiry
 * every mode-derived flow falls back to the human ceremony at its next
 * gate, and running work is never fenced.
 *
 * This module owns the terms shape, the digest, and the words. The store
 * owns the transactions; the tick owns the rails; serve owns the
 * ceremony screens.
 */

import { createHash } from "node:crypto";

export type ModeName = "standard" | "hands-off";

export type ModeTerms = {
  name: ModeName;
  /** The filing default per provider (C7 matrix): "safe" = acceptEdits /
   * auto_edit; "escalated" = bypassPermissions / yolo. Codex-shaped
   * providers have one posture and the ceremony words say escalation
   * changes nothing for them. */
  permissionDefault: "safe" | "escalated";
  /** Auto-approve the SIGNER'S OWN credentialed filings (C1's predicate
   * and road table). */
  autoApproveFiling: boolean;
  /** Attended mint without the per-mint password — signer only (D8). */
  quickMint: boolean;
  /** The reviewer runs on every built-with-changes outcome (R3). */
  reviewAuto: boolean;
  /** Stamped into filings that name no budget of their own. */
  perAttemptBudgetMicrousd: number | null;
  /** SOFT rail: new admissions stop once the day's MEASURED spend has
   * reached this; running work may finish past it (D4). */
  dailyMeasuredCapMicrousd: number | null;
  /** HARD rail: reservation-counted admissions per UTC day, covering
   * unmeasured providers too (D4). */
  dailyRunCap: number | null;
  /** "notify" = merges wait for a human even under a merge grant;
   * "automerge" = the mode's signature substitutes for the per-merge
   * human authorization, through the grant machinery only (D1/E1). */
  publication: "notify" | "automerge";
  /** Whether this mode AUTHORIZES automatic PAID fallback (a
   * subscription->api-key or api-key->api-key switch that spends). v30,
   * fallback chains R8: legacy modes default FALSE — a paid substitution
   * must be an explicit, freshly-signed grant. A subscription->subscription
   * fallback is not "paid" and needs no grant. */
  allowPaidFallback: boolean;
  absoluteExpiry: string;
};

export const MODE_MAX_DAYS = 7;

/** The presets are STARTING POINTS the ceremony renders in full — the
 * signature always covers the resolved terms, never a label. */
export function presetTerms(name: ModeName, absoluteExpiry: string): ModeTerms {
  return name === "standard"
    ? {
        name,
        permissionDefault: "safe",
        autoApproveFiling: false,
        quickMint: true,
        reviewAuto: true,
        perAttemptBudgetMicrousd: null,
        dailyMeasuredCapMicrousd: null,
        dailyRunCap: null,
        publication: "notify",
        allowPaidFallback: false,
        absoluteExpiry,
      }
    : {
        name,
        permissionDefault: "escalated",
        autoApproveFiling: true,
        quickMint: true,
        reviewAuto: false,
        perAttemptBudgetMicrousd: null,
        dailyMeasuredCapMicrousd: null,
        dailyRunCap: null,
        publication: "notify",
        allowPaidFallback: false,
        absoluteExpiry,
      };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function modeTermsJson(terms: ModeTerms): string {
  return canonicalJson(terms);
}

/** sha256 over a domain-separated canonical encoding, 32 hex like every
 * other safety digest here. */
export function modeDigestOf(terms: ModeTerms): string {
  return createHash("sha256")
    .update(`standing-orders:mode:${modeTermsJson(terms)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Strict rehydration — anything unexpected is null, never a guess. */
export function modeTermsFromJson(json: string | null): ModeTerms | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const t = parsed as Record<string, unknown>;
  const optMoney = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  const budget = optMoney(t["perAttemptBudgetMicrousd"]);
  const measured = optMoney(t["dailyMeasuredCapMicrousd"]);
  const runs = optMoney(t["dailyRunCap"]);
  if (
    (t["name"] === "standard" || t["name"] === "hands-off") &&
    (t["permissionDefault"] === "safe" || t["permissionDefault"] === "escalated") &&
    typeof t["autoApproveFiling"] === "boolean" &&
    typeof t["quickMint"] === "boolean" &&
    typeof t["reviewAuto"] === "boolean" &&
    budget !== undefined &&
    measured !== undefined &&
    runs !== undefined &&
    (t["publication"] === "notify" || t["publication"] === "automerge") &&
    // allowPaidFallback: a legacy mode has NO such field — that MUST read
    // as false (R8: a paid substitution is only ever an explicit,
    // freshly-signed grant). A present value must be a strict boolean;
    // anything else is a bad envelope, null.
    (t["allowPaidFallback"] === undefined || typeof t["allowPaidFallback"] === "boolean") &&
    typeof t["absoluteExpiry"] === "string" &&
    !Number.isNaN(Date.parse(t["absoluteExpiry"]))
  ) {
    return {
      name: t["name"],
      permissionDefault: t["permissionDefault"],
      autoApproveFiling: t["autoApproveFiling"],
      quickMint: t["quickMint"],
      reviewAuto: t["reviewAuto"],
      perAttemptBudgetMicrousd: budget,
      dailyMeasuredCapMicrousd: measured,
      dailyRunCap: runs,
      publication: t["publication"],
      allowPaidFallback: t["allowPaidFallback"] === true,
      absoluteExpiry: t["absoluteExpiry"],
    };
  }
  return null;
}

/** Every term in words — what the ceremony renders and the password
 * signs. The reversal sentence is verbatim from the chain (C1). */
export function modeWords(terms: ModeTerms): string[] {
  return [
    terms.permissionDefault === "escalated"
      ? "new filings default to FULL permissions: claude runs with --dangerously-skip-permissions, gemini with --approval-mode yolo (codex-shaped lanes have one posture; this changes nothing for them)"
      : "new filings keep the safe permission defaults (edits auto-approved, everything else asks)",
    terms.autoApproveFiling
      ? "every scope YOU file — signed-in console or credentialed CLI — is approved the moment you file it; while this mode is active, your signed-in browser session becomes a spend credential for this repository"
      : "filings still wait for their own approval ceremony",
    terms.quickMint
      ? "you start watched sessions without re-typing your password — the confirm screen still shows every term"
      : "watched sessions keep the per-session password",
    terms.reviewAuto
      ? "every finished build gets an agent review; the comments land for you to seal"
      : "reviews run only when you ask",
    terms.perAttemptBudgetMicrousd === null
      ? "filings carry no default dollar cap"
      : `filings that name no budget get a $${(terms.perAttemptBudgetMicrousd / 1_000_000).toFixed(2)} per-attempt cap`,
    terms.dailyMeasuredCapMicrousd === null
      ? "no daily dollar rail"
      : `new admissions stop once the day's MEASURED spend reaches $${(terms.dailyMeasuredCapMicrousd / 1_000_000).toFixed(2)} — running work may finish past it, and unmeasured providers ride outside this number`,
    terms.dailyRunCap === null
      ? "no daily run rail"
      : `at most ${terms.dailyRunCap} agent starts per UTC day, every provider counted, reserved at admission`,
    terms.publication === "automerge"
      ? "pull requests merge THEMSELVES when CI is seen green on the exact commit — you are told afterwards (requires a merge-capable publication grant)"
      : "merges wait for you — even where a grant could merge on its own, while this mode is active",
    terms.allowPaidFallback
      ? "when a subscription is exhausted mid-build, an approved fallback that spends (an API key) may run automatically — spend moves to that account"
      : "automatic fallback never switches to a paid API key on its own; a subscription that runs out stops and waits for you",
    `everything above ends at ${terms.absoluteExpiry.slice(0, 16).replace("T", " ")} — revoking it earlier is one click, and every act it covered falls back to its own ceremony`,
  ];
}
