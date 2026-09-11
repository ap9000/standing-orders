/**
 * Explainable, risk-aware phase routing (v47).
 *
 * WHICH agent plans, builds, repairs, and reviews a task is decided here,
 * once, from signed facts — never guessed from a model's name and never
 * re-decided behind an approval's back. The policy is a small table over
 * explicit inputs:
 *
 *   risk         — the task's declared risk (routine / elevated / high)
 *   quality      — the evidence policy the scope signs (default / strict)
 *   evidence     — what the acceptance rubric demands (screenshots, …)
 *   publication  — how far the plane may carry the result unattended
 *   candidates   — the operator's CONFIGURED routine and strong agents
 *   overrides    — an approver's explicit per-phase choice, recorded
 *   pins         — a routine firing's or plan request's pinned pair
 *
 * and its output is one canonical ROUTE: four legs, each with an exact
 * provider and model, which tier it came from, whether a person overrode
 * it, and plain-English reasons. The same inputs always yield the same
 * route and the same words — `recommendRoute` is pure, so the surfaces
 * (CLI, task page, chat) render one projection rather than three.
 *
 * Strength is never inferred: "strong" means the operator named a strong
 * candidate for that phase (`config set <phase> --tier strong …`). With
 * none configured, a demanding task still routes to the configured
 * default and SAYS so. Provider readiness is a runner's observation, not
 * a term — it rides beside the route (ready / unavailable / unknown), it
 * is stated wherever the route is shown, and an unavailable provider is
 * never substituted: admission halts with the reason, and only the
 * already-approved explicit fallback chain may ever switch.
 *
 * Approval seals the route (`approvedRouteJson`); its digest folds into
 * the scope digest whenever the route carries anything beyond the legacy
 * resolution (a non-routine risk, an override, a strong-tier leg), so a
 * task-level route edit stales the approval exactly as a goal edit does,
 * while a global configuration change can never rewrite a sealed route.
 */

import { createHash } from "node:crypto";
import type { AgentSpec, Phase, ProviderId } from "./provider.js";
import type { QualityMode } from "./quality.js";

// Type-only imports above: provider.ts sits under evidence.ts and scope.ts
// in the module graph, and this policy is imported by scope.ts — a value
// import would be a cycle at load time. The id list is restated here and
// pinned to provider.ts's by the test suite.
const PROVIDER_ID_LIST: readonly ProviderId[] = ["claude", "codex", "openrouter", "gemini"];
function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_ID_LIST as readonly string[]).includes(value);
}

export const ROUTE_VERSION = 1;
export const PHASES: readonly Phase[] = ["plan", "build", "repair", "review"];

export type RiskLevel = "routine" | "elevated" | "high";
export const RISK_LEVELS: readonly RiskLevel[] = ["routine", "elevated", "high"];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "routine" || value === "elevated" || value === "high";
}

export function riskTitle(risk: RiskLevel): string {
  return risk === "high" ? "High risk" : risk === "elevated" ? "Elevated risk" : "Routine";
}

/** A runner's non-spending observation of one provider. `unknown` is a
 * real answer (claude has no login probe that does not spend) and is never
 * upgraded to ready. */
export type ReadinessState = "ready" | "unavailable" | "unknown";

export type ReadinessObservation = {
  provider: ProviderId;
  state: ReadinessState;
  /** The probe's own words: "not logged in", "`codex` is not installed"… */
  reason: string;
  /** Which non-spending check produced this: version, identity, key, none. */
  probe: string;
  observedAt: string;
  runner: string;
};

export type CandidateTier = "routine" | "strong";

export type RouteCandidate = {
  provider: ProviderId;
  model: string | null;
  /** Where the candidate was read from — provenance words, never a term. */
  source: string;
};

export type PhaseCandidates = {
  routine: RouteCandidate;
  /** The operator's named strong agent for this phase, or null when none
   * is configured. Never inferred. */
  strong: RouteCandidate | null;
};

export type RouteCandidates = Record<Phase, PhaseCandidates>;

/** An approver's explicit per-phase choice, recorded with attribution. */
export type RouteOverride = {
  phase: Phase;
  provider: ProviderId;
  model: string | null;
  by: string;
  at: string;
};

/** The evidence kinds an acceptance rubric demands — `scope.ts` owns the
 * full type; the policy only needs the names. */
export type RouteEvidenceKind = "check" | "screenshot" | "changed-path" | "manual-review";

/** How far the plane may carry a result without a person: no publication
 * grant at all, a grant whose merges wait for a human (notify), or a live
 * mode that merges by itself (automerge). */
export type PublicationAuthority = "none" | "notify" | "automerge";

export type RouteInput = {
  risk: RiskLevel;
  qualityMode: QualityMode;
  evidence: readonly RouteEvidenceKind[];
  publication: PublicationAuthority;
  candidates: RouteCandidates;
  overrides: readonly RouteOverride[];
  /** Pinned pairs beat everything: a routine firing's build pin, a plan
   * request's plan pin. */
  pins?: { plan?: AgentSpec | null; build?: AgentSpec | null };
};

export type RouteLeg = {
  phase: Phase;
  provider: ProviderId;
  model: string | null;
  /** The tier the recommendation drew from; an override or pin still
   * records what tier the policy would have used. */
  tier: CandidateTier;
  chosen: "recommended" | "override" | "pinned";
  /** What the policy recommended before any override or pin — shown so an
   * overridden leg can say what it replaced. */
  recommended: { provider: ProviderId; model: string | null; tier: CandidateTier };
  /** Plain-English, ordered, deterministic. */
  reasons: string[];
  /** A configuration that cannot run this leg at all (gemini on review,
   * cross-provider repair) — stated, never repaired by substitution. */
  problem: string | null;
};

export type PhaseRoute = {
  version: typeof ROUTE_VERSION;
  risk: RiskLevel;
  qualityMode: QualityMode;
  publication: PublicationAuthority;
  evidence: RouteEvidenceKind[];
  /** The posture the whole route runs under: "economy" keeps the
   * configured defaults; "strong" reaches for the named strong agents. */
  posture: "economy" | "strong";
  /** Why the posture is what it is, in order. */
  demands: string[];
  legs: RouteLeg[];
  overrides: RouteOverride[];
};

const PHASE_NOUN: Record<Phase, string> = { plan: "planner", build: "builder", repair: "repair", review: "reviewer" };

function specWords(spec: { provider: string; model: string | null }): string {
  return spec.model === null ? `${spec.provider} (harness default model)` : `${spec.provider} · ${spec.model}`;
}

/**
 * THE TIERING TABLE. Each row is one signed fact and the phases it pushes
 * to the strong tier, with the sentence the route says for it. Order is
 * the order the reasons print in — stable by construction.
 */
type Demand = { when: (input: RouteInput) => boolean; phases: readonly Phase[]; reason: string };

const DEMANDS: readonly Demand[] = [
  {
    when: input => input.risk === "high",
    phases: ["plan", "build", "repair", "review"],
    reason: "risk is high — every phase uses the strongest configured agent",
  },
  {
    when: input => input.risk === "elevated",
    phases: ["review"],
    reason: "risk is elevated — the review runs on the strongest configured reviewer",
  },
  {
    when: input => input.qualityMode === "strict",
    phases: ["plan", "build", "repair", "review"],
    reason: "quality is strict / release — every phase uses the strongest configured agent",
  },
  {
    when: input => input.evidence.includes("screenshot"),
    phases: ["build", "repair", "review"],
    reason: "acceptance requires screenshots — visual proof gets the strongest configured builder and reviewer",
  },
  {
    when: input => input.evidence.includes("manual-review"),
    phases: ["review"],
    reason: "acceptance asks for manual review — the strongest configured reviewer prepares it",
  },
  {
    when: input => input.publication === "automerge",
    phases: ["review"],
    reason: "a live mode merges by itself — the review is the last gate, so it runs on the strongest configured reviewer",
  },
];

function demandedTier(input: RouteInput, phase: Phase): { tier: CandidateTier; reasons: string[] } {
  const reasons = DEMANDS.filter(one => one.when(input) && one.phases.includes(phase)).map(one => one.reason);
  return reasons.length === 0 ? { tier: "routine", reasons: [] } : { tier: "strong", reasons };
}

function economyReason(input: RouteInput, phase: Phase): string {
  const facts = [
    `risk is ${input.risk}`,
    `quality is ${input.qualityMode === "strict" ? "strict" : "default"}`,
    ...(input.publication === "notify" ? ["publication waits for a person"] : []),
  ];
  return `${facts.join(", ")} — the configured ${PHASE_NOUN[phase]} is economical enough`;
}

function reviewProblem(spec: { provider: string }): string | null {
  return spec.provider === "gemini"
    ? "gemini has no isolation posture for the review phase yet — configure or override the reviewer to claude or codex"
    : null;
}

/**
 * The recommendation: pure, deterministic, table-driven. Same inputs,
 * same route, same words.
 */
export function recommendRoute(input: RouteInput): PhaseRoute {
  const demands = DEMANDS.filter(one => one.when(input)).map(one => one.reason);
  const posture: PhaseRoute["posture"] = demands.length === 0 ? "economy" : "strong";
  const overrides = [...input.overrides]
    .filter(one => PHASES.includes(one.phase))
    .sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
  const overrideFor = (phase: Phase): RouteOverride | null => overrides.find(one => one.phase === phase) ?? null;

  const legs: RouteLeg[] = [];
  const pick = (phase: Phase): { spec: RouteCandidate; tier: CandidateTier; reasons: string[] } => {
    const demanded = demandedTier(input, phase);
    const candidates = input.candidates[phase];
    if (demanded.tier === "strong") {
      if (candidates.strong !== null) {
        return { spec: candidates.strong, tier: "strong", reasons: [...demanded.reasons, `strong ${PHASE_NOUN[phase]} from ${candidates.strong.source}`] };
      }
      return {
        spec: candidates.routine,
        tier: "routine",
        reasons: [
          ...demanded.reasons,
          `no stronger ${PHASE_NOUN[phase]} is configured — \`config set ${phase} --tier strong --provider … --model …\` names one; using the configured default from ${candidates.routine.source}`,
        ],
      };
    }
    return { spec: candidates.routine, tier: "routine", reasons: [economyReason(input, phase), `configured ${PHASE_NOUN[phase]} from ${candidates.routine.source}`] };
  };

  // plan — pin > override > recommendation.
  {
    const rec = pick("plan");
    const pin = input.pins?.plan ?? null;
    const override = overrideFor("plan");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    if (pin !== null) {
      legs.push({ phase: "plan", provider: pin.provider, model: pin.model, tier: rec.tier, chosen: "pinned", recommended, reasons: [`pinned to ${specWords(pin)} by the plan request — nothing overrides a pin`], problem: null });
    } else if (override !== null) {
      legs.push({ phase: "plan", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: null });
    } else {
      legs.push({ phase: "plan", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: null });
    }
  }

  // build — pin > override > recommendation.
  const build = (() => {
    const rec = pick("build");
    const pin = input.pins?.build ?? null;
    const override = overrideFor("build");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    const leg: RouteLeg =
      pin !== null
        ? { phase: "build", provider: pin.provider, model: pin.model, tier: rec.tier, chosen: "pinned", recommended, reasons: [`pinned to ${specWords(pin)} by the firing that filed this task — nothing overrides a pin`], problem: null }
        : override !== null
          ? { phase: "build", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: null }
          : { phase: "build", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: null };
    legs.push(leg);
    return leg;
  })();

  // repair — ALWAYS the build provider (repair resumes the builder's
  // session; cross-provider repair does not exist). Only the model routes.
  {
    const demanded = demandedTier(input, "repair");
    const candidates = input.candidates.repair;
    const override = overrideFor("repair");
    const sameProvider = (one: RouteCandidate | null): one is RouteCandidate => one !== null && one.provider === build.provider;
    let model: string | null;
    let tier: CandidateTier;
    let reasons: string[];
    if (demanded.tier === "strong" && sameProvider(candidates.strong)) {
      model = candidates.strong.model;
      tier = "strong";
      reasons = [...demanded.reasons, `strong repair model from ${candidates.strong.source}`];
    } else if (sameProvider(candidates.routine)) {
      model = candidates.routine.model;
      tier = "routine";
      reasons =
        demanded.tier === "strong"
          ? [...demanded.reasons, candidates.strong === null ? "no stronger repair model is configured — using the configured repair default" : `the strong repair candidate runs ${candidates.strong.provider}, not the build's ${build.provider} — cross-provider repair does not exist; using the configured repair default`]
          : [economyReason(input, "repair"), `configured repair model from ${candidates.routine.source}`];
    } else {
      model = null;
      tier = demanded.tier === "strong" && candidates.strong === null ? "routine" : demanded.tier;
      reasons = [
        ...(demanded.tier === "strong" ? demanded.reasons : [economyReason(input, "repair")]),
        `repairs resume the builder's session on ${build.provider} with the build model — no same-provider repair model is configured`,
      ];
    }
    const recommended = { provider: build.provider, model, tier };
    if (override !== null && override.provider === build.provider) {
      legs.push({ phase: "repair", provider: build.provider, model: override.model, tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords({ provider: build.provider, model })})`], problem: null });
    } else if (override !== null) {
      legs.push({ phase: "repair", provider: build.provider, model, tier, chosen: "recommended", recommended, reasons: [...reasons, `the repair override to ${override.provider} was ignored — repairs stay on the build provider (${build.provider})`], problem: `the repair override names ${override.provider} but the build runs ${build.provider} — cross-provider repair does not exist; clear or change the override` });
    } else {
      legs.push({ phase: "repair", provider: build.provider, model, tier, chosen: "recommended", recommended, reasons: [...reasons, `same provider as the build (${build.provider}) — repairs resume the builder's session`], problem: null });
    }
  }

  // review — override > recommendation; gemini cannot run it at all.
  {
    const rec = pick("review");
    const override = overrideFor("review");
    const recommended = { provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier };
    if (override !== null) {
      legs.push({ phase: "review", provider: override.provider, model: override.model, tier: rec.tier, chosen: "override", recommended, reasons: [`overridden by ${override.by} to ${specWords(override)} (recommended ${specWords(rec.spec)})`], problem: reviewProblem(override) });
    } else {
      legs.push({ phase: "review", provider: rec.spec.provider, model: rec.spec.model, tier: rec.tier, chosen: "recommended", recommended, reasons: rec.reasons, problem: reviewProblem(rec.spec) });
    }
  }

  return {
    version: ROUTE_VERSION,
    risk: input.risk,
    qualityMode: input.qualityMode,
    publication: input.publication,
    evidence: [...new Set(input.evidence)].sort(),
    posture,
    demands,
    legs,
    overrides,
  };
}

export function legOf(route: PhaseRoute, phase: Phase): RouteLeg {
  const leg = route.legs.find(one => one.phase === phase);
  if (leg === undefined) throw new Error(`route has no ${phase} leg`);
  return leg;
}

// ---- canonical bytes, digest, strict rehydration ---------------------------

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
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

/** The stored snapshot bytes: the version rides IN the snapshot. */
export function canonicalRouteJson(route: PhaseRoute): string {
  return canonicalJson({
    version: route.version,
    risk: route.risk,
    qualityMode: route.qualityMode,
    publication: route.publication,
    evidence: [...route.evidence].sort(),
    posture: route.posture,
    demands: route.demands,
    legs: route.legs.map(leg => ({
      phase: leg.phase,
      provider: leg.provider,
      model: leg.model,
      tier: leg.tier,
      chosen: leg.chosen,
      recommended: leg.recommended,
      reasons: leg.reasons,
      problem: leg.problem,
    })),
    overrides: route.overrides.map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
  });
}

/** sha256 over a domain-separated canonical encoding, truncated to the
 * same 128 bits every other safety digest here uses. Its own domain, so a
 * route digest can never collide with a profile or chain digest. */
export function routeDigestOf(route: PhaseRoute): string {
  return createHash("sha256")
    .update(`standing-orders:route:v${ROUTE_VERSION}:${canonicalRouteJson(route)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Whether the route carries anything beyond what the legacy resolution
 * already binds (the build profile is in the digest on its own). A
 * routine-risk route with no override and every leg on the routine tier
 * is the legacy resolution restated — it digests exactly as before, so no
 * approval sealed before v47 changes meaning. Anything else is a signed
 * term and folds into the scope digest.
 */
export function routeIsSigned(route: PhaseRoute): boolean {
  return (
    route.risk !== "routine" ||
    route.overrides.length > 0 ||
    route.legs.some(leg => leg.tier === "strong" || leg.chosen === "override")
  );
}

function str(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}
function strOrNull(v: unknown): v is string | null {
  return v === null || str(v);
}
function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(one => typeof one === "string");
}

/** Strict rehydration of a stored route — every field type-proved;
 * anything unexpected is null, never a guess. */
export function routeFromJson(json: string | null): PhaseRoute | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (r["version"] !== ROUTE_VERSION) return null;
  if (!isRiskLevel(r["risk"])) return null;
  if (r["qualityMode"] !== "default" && r["qualityMode"] !== "strict") return null;
  if (r["publication"] !== "none" && r["publication"] !== "notify" && r["publication"] !== "automerge") return null;
  if (r["posture"] !== "economy" && r["posture"] !== "strong") return null;
  if (!stringList(r["demands"])) return null;
  const evidence = r["evidence"];
  if (!Array.isArray(evidence) || !evidence.every(one => one === "check" || one === "screenshot" || one === "changed-path" || one === "manual-review")) return null;
  if (!Array.isArray(r["legs"]) || r["legs"].length !== PHASES.length) return null;
  const legs: RouteLeg[] = [];
  for (const [index, raw] of (r["legs"] as unknown[]).entries()) {
    if (raw === null || typeof raw !== "object") return null;
    const leg = raw as Record<string, unknown>;
    if (leg["phase"] !== PHASES[index]) return null;
    if (!str(leg["provider"]) || !isProviderId(leg["provider"])) return null;
    if (!strOrNull(leg["model"])) return null;
    if (leg["tier"] !== "routine" && leg["tier"] !== "strong") return null;
    if (leg["chosen"] !== "recommended" && leg["chosen"] !== "override" && leg["chosen"] !== "pinned") return null;
    const rec = leg["recommended"];
    if (rec === null || typeof rec !== "object") return null;
    const recommended = rec as Record<string, unknown>;
    if (!str(recommended["provider"]) || !isProviderId(recommended["provider"])) return null;
    if (!strOrNull(recommended["model"])) return null;
    if (recommended["tier"] !== "routine" && recommended["tier"] !== "strong") return null;
    if (!stringList(leg["reasons"])) return null;
    if (!strOrNull(leg["problem"])) return null;
    legs.push({
      phase: PHASES[index] as Phase,
      provider: leg["provider"],
      model: leg["model"],
      tier: leg["tier"],
      chosen: leg["chosen"],
      recommended: { provider: recommended["provider"], model: recommended["model"], tier: recommended["tier"] },
      reasons: [...leg["reasons"]],
      problem: leg["problem"],
    });
  }
  const overrides = parseOverrides(r["overrides"]);
  if (overrides === null) return null;
  return {
    version: ROUTE_VERSION,
    risk: r["risk"],
    qualityMode: r["qualityMode"],
    publication: r["publication"],
    evidence: [...(evidence as RouteEvidenceKind[])].sort(),
    posture: r["posture"],
    demands: [...r["demands"]],
    legs,
    overrides,
  };
}

/** Strict parse of an override list: one per phase, every field proved. */
export function parseOverrides(raw: unknown): RouteOverride[] | null {
  if (!Array.isArray(raw)) return null;
  const overrides: RouteOverride[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const o = entry as Record<string, unknown>;
    if (!str(o["phase"]) || !PHASES.includes(o["phase"] as Phase)) return null;
    if (seen.has(o["phase"])) return null;
    seen.add(o["phase"]);
    if (!str(o["provider"]) || !isProviderId(o["provider"])) return null;
    if (!strOrNull(o["model"])) return null;
    if (!str(o["by"]) || !str(o["at"])) return null;
    overrides.push({ phase: o["phase"] as Phase, provider: o["provider"], model: o["model"], by: o["by"], at: o["at"] });
  }
  return overrides.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
}

/** The stored override list (a task-level column): malformed reads as none. */
export function overridesFromJson(json: string | null): RouteOverride[] {
  if (json === null) return [];
  try {
    return parseOverrides(JSON.parse(json)) ?? [];
  } catch {
    return [];
  }
}

export function canonicalOverridesJson(overrides: readonly RouteOverride[]): string | null {
  if (overrides.length === 0) return null;
  return canonicalJson(
    [...overrides]
      .sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase))
      .map(one => ({ phase: one.phase, provider: one.provider, model: one.model, by: one.by, at: one.at })),
  );
}

// ---- the shared projection -----------------------------------------------

export type ReadinessLookup = (provider: ProviderId) => Pick<ReadinessObservation, "state" | "reason" | "runner" | "observedAt"> | null;

export type RouteLegProjection = RouteLeg & {
  readiness: ReadinessState;
  readinessReason: string | null;
  readinessRunner: string | null;
  observedAt: string | null;
  /** One line every surface prints for this leg. */
  words: string;
};

export type RouteProjection = {
  digest: string;
  signed: boolean;
  risk: RiskLevel;
  riskTitle: string;
  posture: PhaseRoute["posture"];
  postureWords: string;
  demands: string[];
  legs: RouteLegProjection[];
  /** True when any leg is known-unavailable — admission halts, nothing
   * substitutes. */
  halted: boolean;
};

export function postureWords(route: PhaseRoute): string {
  return route.posture === "economy" ? "economical defaults" : "strongest configured agents";
}

export function readinessWords(state: ReadinessState, reason: string | null): string {
  if (state === "ready") return "ready";
  if (state === "unavailable") return `UNAVAILABLE${reason === null ? "" : ` — ${reason}`}`;
  return `readiness unknown${reason === null ? "" : ` — ${reason}`}`;
}

export function chosenWords(leg: Pick<RouteLeg, "chosen" | "tier">): string {
  return leg.chosen === "override" ? "overridden" : leg.chosen === "pinned" ? "pinned" : leg.tier === "strong" ? "recommended · strong" : "recommended";
}

export function legLine(leg: RouteLegProjection): string {
  return `${leg.phase.padEnd(7)}${specWords(leg)}  [${chosenWords(leg)}] — ${readinessWords(leg.readiness, leg.readinessReason)}${leg.problem === null ? "" : ` — ${leg.problem}`}`;
}

/** The one projection CLI, task page, and chat all render from. */
export function projectRoute(route: PhaseRoute, readiness: ReadinessLookup): RouteProjection {
  const legs = route.legs.map(leg => {
    const seen = readiness(leg.provider);
    const state: ReadinessState = seen === null ? "unknown" : seen.state;
    const projected: RouteLegProjection = {
      ...leg,
      readiness: state,
      readinessReason: seen === null ? "no runner has reported this provider yet" : seen.reason,
      readinessRunner: seen === null ? null : seen.runner,
      observedAt: seen === null ? null : seen.observedAt,
      words: "",
    };
    projected.words = legLine(projected);
    return projected;
  });
  return {
    digest: routeDigestOf(route),
    signed: routeIsSigned(route),
    risk: route.risk,
    riskTitle: riskTitle(route.risk),
    posture: route.posture,
    postureWords: postureWords(route),
    demands: route.demands,
    legs,
    halted: legs.some(leg => leg.readiness === "unavailable"),
  };
}

/** The approval-card lines: one route header, one line per leg, then the
 * reasons indented — identical bytes on every text surface. */
export function routeWords(projection: RouteProjection, indent = "  "): string[] {
  const pad = `${indent}             `;
  return [
    `${indent}route        ${projection.riskTitle.toLowerCase()} · ${projection.postureWords}${projection.signed ? "" : " (legacy-equivalent)"} · ${projection.digest}`,
    ...projection.legs.flatMap(leg => [`${pad}${leg.words}`, ...leg.reasons.map(reason => `${pad}    ${reason}`)]),
    ...(projection.halted ? [`${pad}HALTED: a provider on this route is reported unavailable — nothing substitutes; override the phase or restore the provider`] : []),
  ];
}

// ---- the compatibility decoder ---------------------------------------------

/**
 * A scope approved before v47 carries no route. Its build and repair legs
 * are exactly what its sealed profile says; its plan and review legs were
 * never sealed and resolve from configuration at run time — the decoder
 * SAYS so rather than inventing a sealed leg.
 */
export function legacyRouteOf(profile: { provider: ProviderId; model: string; repairModel: string } | null, fallback: { plan: AgentSpec; review: AgentSpec }): PhaseRoute | null {
  if (profile === null) return null;
  const legacy = (phase: Phase, spec: AgentSpec, reason: string): RouteLeg => ({
    phase,
    provider: spec.provider,
    model: spec.model,
    tier: "routine",
    chosen: "recommended",
    recommended: { provider: spec.provider, model: spec.model, tier: "routine" },
    reasons: [reason],
    problem: phase === "review" ? reviewProblem(spec) : null,
  });
  return {
    version: ROUTE_VERSION,
    risk: "routine",
    qualityMode: "default",
    publication: "none",
    evidence: [],
    posture: "economy",
    demands: [],
    legs: [
      legacy("plan", fallback.plan, "approved before routing was sealed — the planner resolves from configuration at run time"),
      legacy("build", { provider: profile.provider, model: profile.model }, "the sealed execution profile — approved before routing was sealed"),
      legacy("repair", { provider: profile.provider, model: profile.repairModel === "inherit" ? null : profile.repairModel }, "the sealed execution profile's repair model — same provider as the build"),
      legacy("review", fallback.review, "approved before routing was sealed — the reviewer resolves from configuration at run time"),
    ],
    overrides: [],
  };
}

/** The empty readiness lookup: every provider unknown. */
export const NO_READINESS: ReadinessLookup = () => null;
