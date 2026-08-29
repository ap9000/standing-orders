/**
 * The terminal exhaustion taxonomy — and its central safety property:
 * with NO fixture-backed recognizer for a (provider, version), no input
 * can ever produce a fallback-eligible class. The feature is inert until
 * a real exhausted-subscription fixture is captured and reviewed.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTerminal, hasRecognizer, isFallbackEligible, FALLBACK_ELIGIBLE, recognizesEligible, classMatchesAuthMode } from "./exhaustion.js";

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

  test("adversarial version strings and non-failure terminals cannot throw or match (findings 3+4)", () => {
    // __proto__/constructor/toString must resolve to NO recognizer, never
    // an inherited property — no throw, always false.
    for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(hasRecognizer("claude", v)).toBe(false);
      expect(
        classifyTerminal({ provider: "claude", version: v, authMode: "subscription", terminal: { failed: true, text: "x", code: null } }),
      ).toBe("not-exhausted");
    }
    // A NON-failure terminal is never exhaustion — unknown before any match.
    expect(
      classifyTerminal({ provider: "codex", version: "1.0.0", authMode: "subscription", terminal: { failed: false, text: "usage limit reached", code: "usage_limit" } }),
    ).toBe("unknown");
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

  test("the module ships NO recognizer-mutation surface — a fixture is a source edit, not a runtime call (finding 1)", () => {
    // The one place fail-closed could be defeated is a runtime installer. The
    // source must carry no such export, and no `let`-bound swappable lookup.
    const source = readFileSync(join(import.meta.dirname, "exhaustion.ts"), "utf8");
    expect(source).not.toMatch(/export\s+(function|const)\s+__/);
    expect(source).not.toMatch(/\binstallRecognizer\b/i);
    expect(source).not.toMatch(/let\s+recognizerLookup/);
    // And the module is byte-clean: no literal NUL that would hide a diff.
    expect(source.includes(String.fromCharCode(0))).toBe(false);
  });

  test("recognizesEligible is exact per (provider, version, auth mode) and fails closed", () => {
    for (const provider of ["claude", "codex", "openrouter", "gemini"] as const) {
      expect(recognizesEligible(provider, "0.57.0", "subscription")).toBe(false);
      expect(recognizesEligible(provider, "0.57.0", "api-key")).toBe(false);
      expect(recognizesEligible(provider, null, "subscription")).toBe(false);
    }
  });

  test("classMatchesAuthMode enforces usage⇔subscription, credits⇔api-key", () => {
    expect(classMatchesAuthMode("usage-exhausted", "subscription")).toBe(true);
    expect(classMatchesAuthMode("usage-exhausted", "api-key")).toBe(false);
    expect(classMatchesAuthMode("credits-depleted", "api-key")).toBe(true);
    expect(classMatchesAuthMode("credits-depleted", "subscription")).toBe(false);
    expect(classMatchesAuthMode("not-exhausted", "subscription")).toBe(false);
    expect(classMatchesAuthMode("unknown", "api-key")).toBe(false);
  });
});
