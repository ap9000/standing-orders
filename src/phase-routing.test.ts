/**
 * The phase-routing policy is pure: same inputs, same route, same words.
 * These tests pin the rule table (tiering), the override and pin
 * precedence, the same-provider repair law, strict rehydration, the digest
 * domain, and the one projection every surface prints.
 */
import { describe, expect, test } from "vitest";
import {
  canonicalOverridesJson,
  canonicalRouteJson,
  legOf,
  legacyRouteOf,
  overridesFromJson,
  projectRoute,
  recommendRoute,
  routeDigestOf,
  routeFromJson,
  routeIsSigned,
  routeWords,
  NO_READINESS,
  type RouteCandidates,
  type RouteInput,
  type RiskLevel,
} from "./phase-routing.js";

const candidates = (strong: boolean): RouteCandidates => ({
  plan: { routine: { provider: "claude", model: "sonnet", source: "installation" }, strong: strong ? { provider: "claude", model: "opus", source: "installation (strong)" } : null },
  build: { routine: { provider: "claude", model: "sonnet", source: "installation" }, strong: strong ? { provider: "claude", model: "opus", source: "installation (strong)" } : null },
  repair: { routine: { provider: "claude", model: "haiku", source: "installation" }, strong: strong ? { provider: "claude", model: "opus", source: "installation (strong)" } : null },
  review: { routine: { provider: "codex", model: "gpt-5-codex", source: "installation" }, strong: strong ? { provider: "claude", model: "opus", source: "installation (strong)" } : null },
});

const routine = (over: Partial<RouteInput> = {}): RouteInput => ({
  risk: "routine",
  qualityMode: "default",
  evidence: ["check"],
  publication: "none",
  candidates: candidates(true),
  overrides: [],
  ...over,
});

describe("deterministic", () => {
  test("the same inputs yield byte-identical routes, digests, and reason text", () => {
    const a = recommendRoute(routine({ risk: "high", evidence: ["screenshot", "check"] }));
    const b = recommendRoute(routine({ risk: "high", evidence: ["check", "screenshot"] }));
    expect(canonicalRouteJson(a)).toBe(canonicalRouteJson(b));
    expect(routeDigestOf(a)).toBe(routeDigestOf(b));
    expect(a.legs.map(leg => leg.reasons)).toEqual(b.legs.map(leg => leg.reasons));
    expect(routeWords(projectRoute(a, NO_READINESS))).toEqual(routeWords(projectRoute(b, NO_READINESS)));
  });

  test("the whole input matrix is stable across repeated evaluation", () => {
    const risks: RiskLevel[] = ["routine", "elevated", "high"];
    const qualities = ["default", "strict"] as const;
    const evidences = [["check"], ["screenshot"], ["manual-review"], ["check", "changed-path"]] as const;
    const publications = ["none", "notify", "automerge"] as const;
    let seen = 0;
    for (const risk of risks) for (const qualityMode of qualities) for (const evidence of evidences) for (const publication of publications) for (const strong of [true, false]) {
      const input = routine({ risk, qualityMode, evidence: [...evidence], publication, candidates: candidates(strong) });
      const first = recommendRoute(input);
      const second = recommendRoute(input);
      expect(canonicalRouteJson(second)).toBe(canonicalRouteJson(first));
      expect(first.legs.map(leg => leg.phase)).toEqual(["plan", "build", "repair", "review"]);
      // Every leg names a provider and carries at least one plain reason.
      for (const leg of first.legs) {
        expect(leg.reasons.length).toBeGreaterThan(0);
        expect(leg.reasons.every(reason => reason.length > 10)).toBe(true);
      }
      // Repair NEVER leaves the build provider.
      expect(legOf(first, "repair").provider).toBe(legOf(first, "build").provider);
      seen++;
    }
    expect(seen).toBe(3 * 2 * 4 * 3 * 2);
  });
});

describe("tiering", () => {
  test("routine risk with default quality keeps every economical default and says why", () => {
    const route = recommendRoute(routine());
    expect(route.posture).toBe("economy");
    expect(route.demands).toEqual([]);
    expect(route.legs.map(leg => [leg.phase, leg.provider, leg.model, leg.tier])).toEqual([
      ["plan", "claude", "sonnet", "routine"],
      ["build", "claude", "sonnet", "routine"],
      ["repair", "claude", "haiku", "routine"],
      ["review", "codex", "gpt-5-codex", "routine"],
    ]);
    expect(legOf(route, "build").reasons[0]).toBe("risk is routine, quality is default — the configured builder is economical enough");
    expect(routeIsSigned(route)).toBe(false);
  });

  test("high risk selects the strongest configured agent for every phase", () => {
    const route = recommendRoute(routine({ risk: "high" }));
    expect(route.posture).toBe("strong");
    expect(route.demands).toEqual(["risk is high — every phase uses the strongest configured agent"]);
    expect(route.legs.map(leg => [leg.phase, leg.provider, leg.model, leg.tier])).toEqual([
      ["plan", "claude", "opus", "strong"],
      ["build", "claude", "opus", "strong"],
      ["repair", "claude", "opus", "strong"],
      ["review", "claude", "opus", "strong"],
    ]);
    expect(routeIsSigned(route)).toBe(true);
  });

  test("strict quality reaches for the strong tier even at routine risk", () => {
    const route = recommendRoute(routine({ qualityMode: "strict" }));
    expect(route.legs.every(leg => leg.tier === "strong")).toBe(true);
    expect(legOf(route, "build").reasons).toEqual([
      "quality is strict / release — every phase uses the strongest configured agent",
      "strong builder from installation (strong)",
    ]);
  });

  test("elevated risk strengthens only the review; screenshots strengthen build, repair, and review", () => {
    const elevated = recommendRoute(routine({ risk: "elevated" }));
    expect(elevated.legs.map(leg => leg.tier)).toEqual(["routine", "routine", "routine", "strong"]);
    const visual = recommendRoute(routine({ evidence: ["screenshot"] }));
    expect(visual.legs.map(leg => leg.tier)).toEqual(["routine", "strong", "strong", "strong"]);
    expect(legOf(visual, "build").reasons[0]).toContain("acceptance requires screenshots");
  });

  test("manual review and automerge publication strengthen the reviewer", () => {
    expect(recommendRoute(routine({ evidence: ["manual-review"] })).legs.map(leg => leg.tier)).toEqual(["routine", "routine", "routine", "strong"]);
    const merging = recommendRoute(routine({ publication: "automerge" }));
    expect(merging.legs.map(leg => leg.tier)).toEqual(["routine", "routine", "routine", "strong"]);
    expect(legOf(merging, "review").reasons[0]).toContain("merges by itself");
    // notify publication is economical and is said in the economy reason.
    const notify = recommendRoute(routine({ publication: "notify" }));
    expect(legOf(notify, "review").reasons[0]).toContain("publication waits for a person");
  });

  test("with no strong candidate configured, a demanding task keeps the default and says so — strength is never inferred", () => {
    const route = recommendRoute(routine({ risk: "high", candidates: candidates(false) }));
    expect(route.posture).toBe("strong");
    expect(route.legs.every(leg => leg.tier === "routine")).toBe(true);
    expect(legOf(route, "build").provider).toBe("claude");
    expect(legOf(route, "build").model).toBe("sonnet");
    expect(legOf(route, "build").reasons[1]).toContain("no stronger builder is configured");
    // Legacy-equivalent: the digest bytes of a v46 approval are untouched
    // by risk alone... except that risk itself is a signed term.
    expect(routeIsSigned(route)).toBe(true);
    const strictOnly = recommendRoute(routine({ qualityMode: "strict", candidates: candidates(false) }));
    expect(routeIsSigned(strictOnly)).toBe(false);
  });
});

describe("repair keeps the build provider", () => {
  test("a strong repair candidate on another provider is refused with a reason, not substituted", () => {
    const mixed = candidates(true);
    mixed.repair.strong = { provider: "codex", model: "gpt-5", source: "installation (strong)" };
    const route = recommendRoute(routine({ risk: "high", candidates: mixed }));
    const repair = legOf(route, "repair");
    expect(repair.provider).toBe("claude");
    expect(repair.model).toBe("haiku");
    expect(repair.tier).toBe("routine");
    expect(repair.reasons.some(reason => reason.includes("cross-provider repair does not exist"))).toBe(true);
    expect(repair.problem).toBeNull();
  });

  test("a repair override to a different provider is ignored and named as a problem", () => {
    const route = recommendRoute(routine({ overrides: [{ phase: "repair", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const repair = legOf(route, "repair");
    expect(repair.provider).toBe("claude");
    expect(repair.chosen).toBe("recommended");
    expect(repair.problem).toContain("cross-provider repair does not exist");
  });

  test("a same-provider repair override routes the model", () => {
    const route = recommendRoute(routine({ overrides: [{ phase: "repair", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const repair = legOf(route, "repair");
    expect(repair).toMatchObject({ provider: "claude", model: "opus", chosen: "override" });
    expect(repair.reasons[0]).toBe("overridden by alex to claude · opus (recommended claude · haiku)");
  });

  test("when the build provider has no repair candidate, repairs inherit the build model on the build provider", () => {
    const route = recommendRoute(routine({ overrides: [{ phase: "build", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const repair = legOf(route, "repair");
    expect(repair).toMatchObject({ provider: "codex", model: null });
    expect(repair.reasons.some(reason => reason.includes("resume the builder's session on codex with the build model"))).toBe(true);
  });
});

describe("override and pin precedence", () => {
  test("an override replaces the recommendation, records who, and keeps what was recommended", () => {
    const route = recommendRoute(routine({ risk: "high", overrides: [{ phase: "build", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const build = legOf(route, "build");
    expect(build).toMatchObject({ provider: "codex", model: "gpt-5", chosen: "override", tier: "strong" });
    expect(build.recommended).toEqual({ provider: "claude", model: "opus", tier: "strong" });
    expect(build.reasons).toEqual(["overridden by alex to codex · gpt-5 (recommended claude · opus)"]);
    expect(route.overrides).toHaveLength(1);
    expect(routeIsSigned(route)).toBe(true);
  });

  test("a pin beats an override", () => {
    const route = recommendRoute(
      routine({
        pins: { plan: { provider: "gemini", model: "gemini-2.5-pro" }, build: { provider: "codex", model: "gpt-5" } },
        overrides: [
          { phase: "plan", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" },
          { phase: "build", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" },
        ],
      }),
    );
    expect(legOf(route, "plan")).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro", chosen: "pinned" });
    expect(legOf(route, "build")).toMatchObject({ provider: "codex", model: "gpt-5", chosen: "pinned" });
    expect(legOf(route, "repair").provider).toBe("codex");
  });

  test("gemini on the review leg is a stated problem, never silently rerouted", () => {
    const route = recommendRoute(routine({ overrides: [{ phase: "review", provider: "gemini", model: "gemini-2.5-pro", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const review = legOf(route, "review");
    expect(review.provider).toBe("gemini");
    expect(review.problem).toContain("no isolation posture");
  });
});

describe("canonical bytes and rehydration", () => {
  test("a route round-trips through its canonical JSON exactly", () => {
    const route = recommendRoute(routine({ risk: "elevated", evidence: ["screenshot", "check"], overrides: [{ phase: "review", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const json = canonicalRouteJson(route);
    const back = routeFromJson(json);
    expect(back).not.toBeNull();
    expect(canonicalRouteJson(back!)).toBe(json);
    expect(routeDigestOf(back!)).toBe(routeDigestOf(route));
  });

  test("malformed, wrong-version, or short routes rehydrate to null", () => {
    const route = recommendRoute(routine());
    const json = canonicalRouteJson(route);
    expect(routeFromJson(null)).toBeNull();
    expect(routeFromJson("not json")).toBeNull();
    expect(routeFromJson(json.replace('"version":1', '"version":2'))).toBeNull();
    expect(routeFromJson(json.replace('"provider":"codex"', '"provider":"bard"'))).toBeNull();
    expect(routeFromJson(JSON.stringify({ ...JSON.parse(json), legs: JSON.parse(json).legs.slice(0, 3) }))).toBeNull();
    expect(routeFromJson(json.replace('"risk":"routine"', '"risk":"extreme"'))).toBeNull();
  });

  test("the digest lives in its own domain and moves with every signed term", () => {
    const base = recommendRoute(routine());
    const risk = recommendRoute(routine({ risk: "high" }));
    const over = recommendRoute(routine({ overrides: [{ phase: "build", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const later = recommendRoute(routine({ overrides: [{ phase: "build", provider: "claude", model: "opus", by: "alex", at: "2026-09-11T00:00:00.000Z" }] }));
    expect(new Set([routeDigestOf(base), routeDigestOf(risk), routeDigestOf(over), routeDigestOf(later)]).size).toBe(4);
    expect(routeDigestOf(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("override lists parse strictly and canonicalize in phase order", () => {
    const json = canonicalOverridesJson([
      { phase: "review", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" },
      { phase: "plan", provider: "codex", model: null, by: "alex", at: "2026-09-10T00:00:00.000Z" },
    ]);
    expect(overridesFromJson(json).map(one => one.phase)).toEqual(["plan", "review"]);
    expect(overridesFromJson(null)).toEqual([]);
    expect(overridesFromJson("[{\"phase\":\"build\"}]")).toEqual([]);
    expect(overridesFromJson("[{\"phase\":\"build\",\"provider\":\"claude\",\"model\":null,\"by\":\"a\",\"at\":\"t\"},{\"phase\":\"build\",\"provider\":\"codex\",\"model\":null,\"by\":\"a\",\"at\":\"t\"}]")).toEqual([]);
    expect(canonicalOverridesJson([])).toBeNull();
  });
});

describe("the shared projection", () => {
  test("distinguishes recommended, overridden, unavailable, and unknown readiness in one line per leg", () => {
    const route = recommendRoute(routine({ risk: "high", overrides: [{ phase: "review", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const projection = projectRoute(route, provider =>
      provider === "codex"
        ? { state: "unavailable", reason: "not logged in", runner: "mac-mini", observedAt: "2026-09-10T00:00:00.000Z" }
        : provider === "claude"
          ? { state: "unknown", reason: "no non-spending login check exists", runner: "mac-mini", observedAt: "2026-09-10T00:00:00.000Z" }
          : null,
    );
    expect(projection.halted).toBe(true);
    expect(projection.legs.map(leg => leg.readiness)).toEqual(["unknown", "unknown", "unknown", "unavailable"]);
    const words = routeWords(projection);
    expect(words[0]).toBe(`  route        high risk · strongest configured agents · ${projection.digest}`);
    expect(words).toContain("               build  claude · opus  [recommended · strong] — readiness unknown — no non-spending login check exists");
    expect(words).toContain("               review codex · gpt-5  [overridden] — UNAVAILABLE — not logged in");
    expect(words.at(-1)).toContain("HALTED");
    // Same projection, same bytes, every time.
    expect(routeWords(projectRoute(route, NO_READINESS))).toEqual(routeWords(projectRoute(route, NO_READINESS)));
    expect(projectRoute(route, NO_READINESS).legs[0]!.readinessReason).toBe("no runner has reported this provider yet");
  });
});

describe("the compatibility decoder", () => {
  test("a pre-v47 profile decodes to legacy legs that say the plan and review resolve at run time", () => {
    const route = legacyRouteOf({ provider: "codex", model: "gpt-5", repairModel: "inherit" }, { plan: { provider: "claude", model: null }, review: { provider: "claude", model: null } });
    expect(route).not.toBeNull();
    expect(legOf(route!, "build")).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(legOf(route!, "repair")).toMatchObject({ provider: "codex", model: null });
    expect(legOf(route!, "plan").reasons[0]).toContain("resolves from configuration at run time");
    expect(routeIsSigned(route!)).toBe(false);
    expect(legacyRouteOf(null, { plan: { provider: "claude", model: null }, review: { provider: "claude", model: null } })).toBeNull();
  });
});
