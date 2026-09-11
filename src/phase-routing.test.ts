/**
 * The phase-routing policy is pure: same inputs, same route, same words.
 * These tests pin the rule table (tiering), the override and pin
 * precedence, the same-provider repair law, strict rehydration, the digest
 * domain, and the one projection every surface prints.
 */
import { describe, expect, test } from "vitest";
import {
  agentsSummary,
  canonicalOverridesJson,
  canonicalRouteJson,
  legOf,
  overridesFromJson,
  postureWords,
  projectRoute,
  recommendRoute,
  routeDigestOf,
  routeFromJson,
  routeProblems,
  routeWords,
  routeStampProblem,
  phaseOfRole,
  riskConsequence,
  RISK_CHOICES,
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
    expect(postureWords(route)).toBe("everyday configured agents");
    expect(agentsSummary(route)).toBe("claude · sonnet plans and builds; claude · haiku repairs; codex · gpt-5-codex reviews");
    expect(routeProblems(route)).toEqual([]);
  });

  test("high risk selects the strongest configured agent for every phase", () => {
    const route = recommendRoute(routine({ risk: "high" }));
    expect(route.posture).toBe("strong");
    expect(route.demands).toEqual(["risk is high — every role uses the strongest configured agent"]);
    expect(route.legs.map(leg => [leg.phase, leg.provider, leg.model, leg.tier])).toEqual([
      ["plan", "claude", "opus", "strong"],
      ["build", "claude", "opus", "strong"],
      ["repair", "claude", "opus", "strong"],
      ["review", "claude", "opus", "strong"],
    ]);
    expect(postureWords(route)).toBe("stronger configured agents");
    expect(agentsSummary(route)).toBe("claude · opus plans, builds, repairs, and reviews");
  });

  test("strict quality reaches for the strong tier even at routine risk", () => {
    const route = recommendRoute(routine({ qualityMode: "strict" }));
    expect(route.legs.every(leg => leg.tier === "strong")).toBe(true);
    expect(legOf(route, "build").reasons).toEqual([
      "quality is strict / release — every role uses the strongest configured agent",
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

  test("with no strong candidate configured, a demanding task keeps the default and says so — strength is never inferred, and the posture never claims stronger agents", () => {
    const route = recommendRoute(routine({ risk: "high", candidates: candidates(false) }));
    // The demand is recorded; the posture is what RUNS — every default.
    expect(route.demands).toEqual(["risk is high — every role uses the strongest configured agent"]);
    expect(route.posture).toBe("economy");
    expect(postureWords(route)).toBe("everyday configured agents");
    expect(route.legs.every(leg => leg.tier === "routine")).toBe(true);
    expect(legOf(route, "build").provider).toBe("claude");
    expect(legOf(route, "build").model).toBe("sonnet");
    expect(legOf(route, "build").reasons[1]).toContain("no stronger builder is configured");
    const strictOnly = recommendRoute(routine({ qualityMode: "strict", candidates: candidates(false) }));
    expect(strictOnly.posture).toBe("economy");
    // One strong leg is enough to say so.
    const partial = candidates(false);
    partial.review.strong = { provider: "claude", model: "opus", source: "installation (strong)" };
    const reviewOnly = recommendRoute(routine({ risk: "high", candidates: partial }));
    expect(reviewOnly.posture).toBe("strong");
    expect(reviewOnly.legs.map(leg => leg.tier)).toEqual(["routine", "routine", "routine", "strong"]);
    // An override runs the person's choice, not a tier: with the one strong
    // leg overridden, nothing stronger is actually selected.
    const overridden = recommendRoute(routine({ risk: "high", candidates: partial, overrides: [{ phase: "review", provider: "claude", model: "haiku", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    expect(overridden.posture).toBe("economy");
    expect(postureWords(overridden)).toBe("everyday configured agents");
  });
});

describe("repair keeps the build provider", () => {
  test("a strong repair candidate on another provider is a stated PROBLEM — the scope files unresolved, nothing is skipped or substituted", () => {
    const mixed = candidates(true);
    mixed.repair.strong = { provider: "codex", model: "gpt-5", source: "installation (strong)" };
    const route = recommendRoute(routine({ risk: "high", candidates: mixed }));
    const repair = legOf(route, "repair");
    expect(repair.provider).toBe("claude");
    expect(repair.problem).toContain("cross-provider repair does not exist");
    expect(routeProblems(route)).toEqual([`repair: ${repair.problem}`]);
  });

  test("a configured repair row on another provider is a stated problem too; with no row, repairs inherit the build's exact model", () => {
    const crossed = candidates(false);
    crossed.repair.routine = { provider: "codex", model: "gpt-5-codex", source: "installation" };
    const route = recommendRoute(routine({ candidates: crossed }));
    expect(legOf(route, "repair").problem).toContain("the repair configuration names codex but the build runs claude");
    const inheriting = candidates(false);
    inheriting.repair.routine = null;
    const inherited = recommendRoute(routine({ risk: "high", candidates: inheriting }));
    expect(legOf(inherited, "repair")).toMatchObject({ provider: "claude", model: "sonnet", problem: null });
    expect(legOf(inherited, "repair").reasons.some(reason => reason.includes("with the build model (sonnet)"))).toBe(true);
  });

  test("an explicit approved profile pins build AND repair exactly", () => {
    const route = recommendRoute(routine({ pins: { build: { provider: "codex", model: "gpt-5" }, repair: { provider: "codex", model: "gpt-5-mini" } } }));
    expect(legOf(route, "build")).toMatchObject({ provider: "codex", model: "gpt-5", chosen: "pinned" });
    expect(legOf(route, "repair")).toMatchObject({ provider: "codex", model: "gpt-5-mini", chosen: "pinned", problem: null });
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

  test("a build override onto another provider makes a same-provider-only repair row a stated problem — never a silent inherit", () => {
    const route = recommendRoute(routine({ overrides: [{ phase: "build", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const repair = legOf(route, "repair");
    expect(repair).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(repair.problem).toContain("the repair configuration names claude but the build runs codex");
    // Overriding the repair onto the build provider clears it.
    const both = recommendRoute(routine({ overrides: [
      { phase: "build", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" },
      { phase: "repair", provider: "codex", model: "gpt-5-mini", by: "alex", at: "2026-09-10T00:00:00.000Z" },
    ] }));
    expect(legOf(both, "repair")).toMatchObject({ provider: "codex", model: "gpt-5-mini", chosen: "override", problem: null });
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

  test("malformed, wrong-version, short, inexact, or posture-lying routes rehydrate to null", () => {
    const route = recommendRoute(routine());
    const json = canonicalRouteJson(route);
    expect(routeFromJson(null)).toBeNull();
    expect(routeFromJson("not json")).toBeNull();
    expect(routeFromJson(json.replace('"version":1', '"version":2'))).toBeNull();
    expect(routeFromJson(json.replace('"provider":"codex"', '"provider":"bard"'))).toBeNull();
    expect(routeFromJson(JSON.stringify({ ...JSON.parse(json), legs: JSON.parse(json).legs.slice(0, 3) }))).toBeNull();
    expect(routeFromJson(json.replace('"risk":"routine"', '"risk":"extreme"'))).toBeNull();
    // A leg with no model id is not a frozen leg.
    expect(routeFromJson(json.replace('"model":"haiku"', '"model":null'))).toBeNull();
    expect(routeFromJson(json.replace('"model":"haiku"', '"model":""'))).toBeNull();
    // A posture the legs do not support.
    expect(routeFromJson(json.replace('"posture":"economy"', '"posture":"strong"'))).toBeNull();
  });

  test("the digest lives in its own domain and moves with every signed term", () => {
    const base = recommendRoute(routine());
    const risk = recommendRoute(routine({ risk: "high" }));
    const over = recommendRoute(routine({ overrides: [{ phase: "build", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" }] }));
    const later = recommendRoute(routine({ overrides: [{ phase: "build", provider: "claude", model: "opus", by: "alex", at: "2026-09-11T00:00:00.000Z" }] }));
    expect(new Set([routeDigestOf(base), routeDigestOf(risk), routeDigestOf(over), routeDigestOf(later)]).size).toBe(4);
    expect(routeDigestOf(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("override lists parse strictly (exact models, one per phase) and canonicalize in phase order; malformed reads as null, never as none", () => {
    const json = canonicalOverridesJson([
      { phase: "review", provider: "claude", model: "opus", by: "alex", at: "2026-09-10T00:00:00.000Z" },
      { phase: "plan", provider: "codex", model: "gpt-5", by: "alex", at: "2026-09-10T00:00:00.000Z" },
    ]);
    expect(overridesFromJson(json)?.map(one => one.phase)).toEqual(["plan", "review"]);
    expect(overridesFromJson(null)).toEqual([]);
    expect(overridesFromJson("[{\"phase\":\"build\"}]")).toBeNull();
    expect(overridesFromJson("not json")).toBeNull();
    expect(overridesFromJson("[{\"phase\":\"build\",\"provider\":\"claude\",\"model\":null,\"by\":\"a\",\"at\":\"t\"}]")).toBeNull();
    expect(overridesFromJson("[{\"phase\":\"build\",\"provider\":\"claude\",\"model\":\"opus\",\"by\":\"a\",\"at\":\"t\"},{\"phase\":\"build\",\"provider\":\"codex\",\"model\":\"gpt-5\",\"by\":\"a\",\"at\":\"t\"}]")).toBeNull();
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
    expect(words[0]).toBe(`  route        high risk · stronger configured agents · ${projection.digest}`);
    expect(words[1]).toBe("               claude · opus plans, builds, and repairs; codex · gpt-5 reviews");
    expect(projection.summary).toBe("claude · opus plans, builds, and repairs; codex · gpt-5 reviews");
    expect(words).toContain("               build  claude · opus  [recommended · strong] — readiness unknown — no non-spending login check exists");
    expect(words).toContain("               review codex · gpt-5  [overridden] — UNAVAILABLE — not logged in");
    expect(words.at(-1)).toContain("HALTED");
    // Same projection, same bytes, every time.
    expect(routeWords(projectRoute(route, NO_READINESS))).toEqual(routeWords(projectRoute(route, NO_READINESS)));
    expect(projectRoute(route, NO_READINESS).legs[0]!.readinessReason).toBe("no runner has reported this provider yet");
  });
});

describe("plain-English risk consequences and route stamp shape (v48)", () => {
  test("every risk level explains itself in one sentence that agrees with the tiering table", () => {
    expect(RISK_CHOICES.map(one => one.risk)).toEqual(["routine", "elevated", "high"]);
    expect(RISK_CHOICES.map(one => one.title)).toEqual(["Routine", "Elevated risk", "High risk"]);
    for (const risk of ["routine", "elevated", "high"] as const) {
      expect(riskConsequence(risk)).toBe(RISK_CHOICES.find(one => one.risk === risk)!.consequence);
      // Never a command line: these words are the console's and the chat's.
      expect(riskConsequence(risk)).not.toMatch(/config set|--tier|task route/);
    }
    // The consequence matches what the policy does with the same inputs.
    const base = { qualityMode: "default" as const, evidence: [] as const, publication: "none" as const, candidates: candidates(true), overrides: [] };
    const high = recommendRoute({ ...base, risk: "high" });
    expect(high.legs.every(leg => leg.tier === "strong")).toBe(true);
    expect(riskConsequence("high")).toContain("every role");
    const elevated = recommendRoute({ ...base, risk: "elevated" });
    expect(elevated.legs.map(leg => leg.tier)).toEqual(["routine", "routine", "routine", "strong"]);
    expect(riskConsequence("elevated")).toContain("the review runs on the strongest configured reviewer");
    const routine = recommendRoute({ ...base, risk: "routine" });
    expect(routine.legs.every(leg => leg.tier === "routine")).toBe(true);
    // The "no stronger agent configured" reason speaks plainly, no CLI quoted.
    const noStrong = recommendRoute({ ...base, risk: "high", candidates: candidates(false) });
    expect(legOf(noStrong, "build").reasons).toContain("no stronger builder is configured — using the configured default from installation");
    expect(legOf(noStrong, "build").reasons.join(" ")).not.toContain("config set");
  });

  test("a route stamp is proved by shape before it is believed: phase, provenance word, provider, digest, exact model", () => {
    const good = { routeDigest: "d".repeat(32), phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" };
    expect(routeStampProblem(good)).toBeNull();
    expect(routeStampProblem({ ...good, model: null, chosen: "legacy", routeDigest: "legacy" })).toBeNull();
    expect(routeStampProblem(null)).toBe("the route stamp is not an object");
    expect(routeStampProblem({ ...good, routeDigest: "" })).toBe("the route stamp names no route digest");
    expect(routeStampProblem({ ...good, phase: "deploy" })).toContain("unknown phase");
    expect(routeStampProblem({ ...good, chosen: "guess" })).toContain("unknown provenance");
    expect(routeStampProblem({ ...good, provider: "gpt" })).toContain("unknown provider");
    expect(routeStampProblem({ ...good, model: null })).toContain("names an exact model — the stamp carries none");
    expect(routeStampProblem({ ...good, model: 7 })).toContain("neither an exact id nor null");
    expect(["builder", "repair", "planner", "reviewer", "scout"].map(role => phaseOfRole(role as "builder"))).toEqual(["build", "repair", "plan", "review", "build"]);
  });
});

describe("no legacy decoder", () => {
  test("a pre-v47 approval is never dressed as a route: there is no decoder to guess plan and review legs from", async () => {
    const module = (await import("./phase-routing.js")) as Record<string, unknown>;
    expect(module["legacyRouteOf"]).toBeUndefined();
    expect(module["routeIsSigned"]).toBeUndefined();
  });
});
