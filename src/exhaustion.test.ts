/**
 * The terminal exhaustion taxonomy — and its central safety property:
 * with NO fixture-backed recognizer for a (provider, version), no input
 * can ever produce a fallback-eligible class. The feature is inert until
 * a real exhausted-subscription fixture is captured and reviewed.
 */

import { describe, test, expect } from "vitest";
import { classifyTerminal, hasRecognizer, isFallbackEligible, FALLBACK_ELIGIBLE } from "./exhaustion.js";

describe("the exhaustion taxonomy is fail-closed by construction", () => {
  test("no build ships a recognizer yet — every provider/version is unfixtured", () => {
    for (const provider of ["claude", "codex", "openrouter", "gemini"] as const) {
      expect(hasRecognizer(provider, "0.57.0")).toBe(false);
      expect(hasRecognizer(provider, "any-version")).toBe(false);
      expect(hasRecognizer(provider, null)).toBe(false);
    }
  });

  test("with no recognizer, even a usage-limit-shaped terminal is NOT eligible", () => {
    // The exact shape a real exhaustion might carry — but no fixture proves
    // it for this version, so it must NOT authorize a paid fallback.
    const cls = classifyTerminal({
      provider: "codex",
      version: "1.0.0",
      authMode: "subscription",
      terminal: { failed: true, text: "You've hit your usage limit. Try again later.", code: "usage_limit_reached" },
    });
    expect(cls).toBe("not-exhausted"); // a definite failure, but NOT eligible
    expect(isFallbackEligible(cls)).toBe(false);
  });

  test("a null terminal is unknown; a failed terminal with no match is not-exhausted", () => {
    expect(classifyTerminal({ provider: "claude", version: "1.0.0", authMode: "subscription", terminal: null })).toBe("unknown");
    expect(
      classifyTerminal({
        provider: "claude",
        version: "1.0.0",
        authMode: "subscription",
        terminal: { failed: false, text: "some prose", code: null },
      }),
    ).toBe("unknown");
    expect(
      classifyTerminal({
        provider: "claude",
        version: "1.0.0",
        authMode: "subscription",
        terminal: { failed: true, text: "an ordinary agent error", code: "error" },
      }),
    ).toBe("not-exhausted");
  });

  test("the eligible set is exactly the two paid-fallback classes", () => {
    expect([...FALLBACK_ELIGIBLE].sort()).toEqual(["credits-depleted", "usage-exhausted"]);
    expect(isFallbackEligible("usage-exhausted")).toBe(true);
    expect(isFallbackEligible("credits-depleted")).toBe(true);
    expect(isFallbackEligible("transient-throttle")).toBe(false);
    expect(isFallbackEligible("not-exhausted")).toBe(false);
    expect(isFallbackEligible("unknown")).toBe(false);
  });
});
