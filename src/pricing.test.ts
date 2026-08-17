import { describe, test, expect } from "vitest";
import {
  buildPriceOf,
  oneCallTailMicrousd,
  settleBuildMicrousd,
  PRICED_BUILD_MODELS,
  BUILD_PRICE_VERSION,
} from "./pricing.js";
import { MONEY_CAPABILITIES, probeBudgetCap } from "./provider.js";

describe("pinned build prices (tournament stage 1)", () => {
  test("every priced model carries positive integer rates AND quantity bounds", () => {
    expect(BUILD_PRICE_VERSION).toBe(1);
    expect(PRICED_BUILD_MODELS.length).toBeGreaterThanOrEqual(3);
    for (const model of PRICED_BUILD_MODELS) {
      const price = buildPriceOf(model);
      if (price === null) throw new Error(model);
      for (const value of Object.values(price)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      // Rates alone bound nothing — the envelope's quantities must exist.
      expect(price.contextTokens).toBeGreaterThanOrEqual(100_000);
      expect(price.maxOutputTokens).toBeGreaterThanOrEqual(8_000);
    }
    expect(buildPriceOf("mystery-model")).toBeNull();
  });

  test("the one-call tail is the worst LEGAL call: dearest input class times the whole window", () => {
    const tail = oneCallTailMicrousd("claude-sonnet-5");
    // 200k tokens at the dearest class (cache write, 4) + 64k out at 15.
    expect(tail).toBe(200_000 * 4 + 64_000 * 15);
    expect(oneCallTailMicrousd("mystery-model")).toBeNull();
  });

  test("settlement itemizes cache classes and fails closed on missing totals", () => {
    expect(
      settleBuildMicrousd("claude-sonnet-5", { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 5_000 }),
    ).toBe(1_000 * 3 + 100 * 15 + 5_000 * 1);
    // Missing totals: null, never a guess — the caller latches.
    expect(settleBuildMicrousd("claude-sonnet-5", { outputTokens: 100 })).toBeNull();
    expect(settleBuildMicrousd("claude-sonnet-5", { inputTokens: -1, outputTokens: 1 })).toBeNull();
  });
});

describe("the money capability matrix", () => {
  test("eligibility is derived from a native cap, and refusals carry words", () => {
    expect(MONEY_CAPABILITIES.claude.tournamentEligible).toBe(true);
    expect(MONEY_CAPABILITIES.claude.nativeDollarCapFlag).toBe("--max-budget-usd");
    for (const provider of ["codex", "openrouter"] as const) {
      expect(MONEY_CAPABILITIES[provider].tournamentEligible).toBe(false);
      expect(MONEY_CAPABILITIES[provider].nativeDollarCapFlag).toBeNull();
      expect(MONEY_CAPABILITIES[provider].whyIneligible).toContain("turn");
    }
  });

  test("the probe proves the flag in the RESOLVED binary's own help, fail closed", async () => {
    const script: Record<string, { code: number; stdout: string }> = {
      "which claude": { code: 0, stdout: "/usr/local/bin/claude\n" },
      "/usr/local/bin/claude --version": { code: 0, stdout: "2.1.229\n" },
      "/usr/local/bin/claude --help": { code: 0, stdout: "…  --max-budget-usd <n>  stop when spend reaches n\n" },
    };
    const runner = async (command: string, argv: readonly string[]) => {
      const key = `${command} ${argv.join(" ")}`;
      const found = script[key] ?? { code: 1, stdout: "" };
      return { ...found, stderr: "", timedOut: false, notFound: found.code !== 0 };
    };
    const proved = await probeBudgetCap("claude", runner);
    expect(proved).toMatchObject({ ok: true, executable: "/usr/local/bin/claude", version: "2.1.229" });

    // The flag missing from help: refused with the reason, never assumed.
    script["/usr/local/bin/claude --help"] = { code: 0, stdout: "no such flag here" };
    expect(await probeBudgetCap("claude", runner)).toMatchObject({ ok: false });
    // A provider with no cap flag never probes to true.
    expect(await probeBudgetCap("codex", runner)).toMatchObject({ ok: false });
  });
});
