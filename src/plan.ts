/**
 * The planner's terminal handoff, parsed with the 422 rule: fail closed,
 * every problem reported at once, stable reasons, caps and control-character
 * rejection on every string — because a plan payload reaches terminals, the
 * approve card, and the builder's brief (Codex planning review, question 2:
 * the scope proposal is authority-bearing, so it gets the park discipline).
 */

import { hasForbiddenControls } from "./decision.js";
import { parseAcceptanceCriteria, type AcceptanceCriterion } from "./scope.js";

export type PlanProblem = { reason: string; message: string };

export type ParsedPlan = {
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** v39: the rubric the planner drafts alongside the goal — mandatory,
   * because the planner is a scope-producing road like any other (the
   * scope text names it explicitly). A malformed or empty rubric fails
   * the whole plan the same way a missing goal always has. */
  acceptance: AcceptanceCriterion[];
  /** The plan document, markdown, rendered fenced-inert everywhere. */
  plan: string;
};

/** A deliberately small execution plan. The signed scope remains the
 * authority; this is the durable road the builder is expected to follow.
 * Fixed sections make the handoff scannable in the console and prevent the
 * planner from hiding the useful parts in a long essay. */
export type ExecutionPlanDocument = {
  approach: string;
  milestones: string[];
  dependencies: string[];
  risks: string[];
  proof: string[];
};

export type ExecutionPlanDocumentResult =
  | { ok: true; document: ExecutionPlanDocument }
  | { ok: false; problems: PlanProblem[] };

const EXECUTION_PLAN_SECTIONS = ["approach", "milestones", "dependencies", "risks", "proof"] as const;
const EXECUTION_PLAN_LIST_CAP = 12;
const EXECUTION_PLAN_ITEM_CAP = 600;

/** Parse the planner's human-readable artifact without executing Markdown.
 * Older free-form plan artifacts remain renderable through the caller's
 * fallback, while every newly accepted planner handoff uses this shape. */
export function parseExecutionPlanDocument(raw: string): ExecutionPlanDocumentResult {
  const problems: PlanProblem[] = [];
  if (Buffer.byteLength(raw, "utf8") > PLAN_LIMITS.document) {
    return { ok: false, problems: [{ reason: "plan-too-long", message: `plan is over ${PLAN_LIMITS.document} bytes` }] };
  }
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (hasForbiddenControls(normalized)) {
    return { ok: false, problems: [{ reason: "plan-controls", message: "plan carries control characters that could become terminal escapes" }] };
  }

  const sections = new Map<string, string[]>();
  let current: string | null = null;
  let lastSection = -1;
  for (const line of normalized.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = (heading[1] ?? "").trim().toLowerCase();
      if (!EXECUTION_PLAN_SECTIONS.includes(name as (typeof EXECUTION_PLAN_SECTIONS)[number])) {
        problems.push({ reason: "plan-unknown-section", message: `plan section \"${heading[1]}\" is not one of Approach, Milestones, Dependencies, Risks, or Proof` });
        current = null;
        continue;
      }
      const position = EXECUTION_PLAN_SECTIONS.indexOf(name as (typeof EXECUTION_PLAN_SECTIONS)[number]);
      if (position < lastSection) {
        problems.push({ reason: "plan-section-order", message: "plan sections must stay in order: Approach, Milestones, Dependencies, Risks, Proof" });
      }
      lastSection = Math.max(lastSection, position);
      if (sections.has(name)) problems.push({ reason: `plan-duplicate-${name}`, message: `plan has more than one ${name} section` });
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null) {
      if (line.trim() !== "") problems.push({ reason: "plan-preamble", message: "plan must start with ## Approach" });
      continue;
    }
    sections.get(current)?.push(line);
  }

  for (const section of EXECUTION_PLAN_SECTIONS) {
    if (!sections.has(section)) problems.push({ reason: `plan-missing-${section}`, message: `plan needs a ## ${section[0]?.toUpperCase()}${section.slice(1)} section` });
  }
  if (problems.length > 0) return { ok: false, problems };

  const approach = (sections.get("approach") ?? []).join("\n").trim();
  if (approach === "") problems.push({ reason: "plan-empty-approach", message: "Approach must say how the work will be done" });
  if (approach.length > 2_000) problems.push({ reason: "plan-approach-too-long", message: "Approach is over 2000 characters" });

  const list = (name: "milestones" | "dependencies" | "risks" | "proof"): string[] => {
    const items: string[] = [];
    for (const line of sections.get(name) ?? []) {
      if (line.trim() === "") continue;
      const item = /^(?:[-*]\s+|\d+[.)]\s+)(.+)$/.exec(line.trim())?.[1]?.trim();
      if (item === undefined || item === "") {
        problems.push({ reason: `plan-bad-${name}-item`, message: `${name} entries must be bullets or numbered items` });
        continue;
      }
      if (item.length > EXECUTION_PLAN_ITEM_CAP) {
        problems.push({ reason: `plan-${name}-item-too-long`, message: `${name} entries are capped at ${EXECUTION_PLAN_ITEM_CAP} characters` });
        continue;
      }
      items.push(item);
    }
    if (items.length === 0) problems.push({ reason: `plan-empty-${name}`, message: `${name} needs at least one item (use \"None found.\" when honest)` });
    if (items.length > EXECUTION_PLAN_LIST_CAP) problems.push({ reason: `plan-too-many-${name}`, message: `${name} is capped at ${EXECUTION_PLAN_LIST_CAP} items` });
    return items;
  };

  const document = {
    approach,
    milestones: list("milestones"),
    dependencies: list("dependencies"),
    risks: list("risks"),
    proof: list("proof"),
  };
  return problems.length === 0 ? { ok: true, document } : { ok: false, problems };
}

export type PlanParseResult =
  | { ok: true; plan: ParsedPlan }
  | { ok: false; problems: PlanProblem[] };

/** Caps matching the scope ritual's fields, plus the document itself. */
export const PLAN_LIMITS = {
  payload: 64 * 1024,
  goal: 2_000,
  outOfScope: 2_000,
  touch: 200,
  touches: 32,
  document: 16 * 1024,
} as const;

function refuse(reason: string, message: string): PlanParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `a ${value.length}-char string`;
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function prose(
  value: unknown,
  field: string,
  cap: number,
  required: boolean,
  problems: PlanProblem[],
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) problems.push({ reason: `missing-${field}`, message: `${field} is required` });
    return null;
  }
  if (typeof value !== "string") {
    problems.push({ reason: `bad-${field}`, message: `${field} must be a string (got ${describe(value)})` });
    return null;
  }
  if (value.length > cap) {
    problems.push({ reason: `${field}-too-long`, message: `${field} is over ${cap} characters` });
    return null;
  }
  if (hasForbiddenControls(value)) {
    problems.push({ reason: `${field}-controls`, message: `${field} carries control characters that could become terminal escapes` });
    return null;
  }
  return value;
}

export function parsePlan(raw: string): PlanParseResult {
  if (Buffer.byteLength(raw, "utf8") > PLAN_LIMITS.payload) {
    return refuse("too-large", `the payload is over ${PLAN_LIMITS.payload} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("not-an-object", "the payload must be one JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const problems: PlanProblem[] = [];

  const goal = prose(body["goal"], "goal", PLAN_LIMITS.goal, true, problems);
  const outOfScope = prose(body["outOfScope"], "outOfScope", PLAN_LIMITS.outOfScope, false, problems);
  const document = prose(body["plan"], "plan", PLAN_LIMITS.document, true, problems);

  const touches: string[] = [];
  if (body["touches"] !== undefined && body["touches"] !== null) {
    if (!Array.isArray(body["touches"])) {
      problems.push({ reason: "bad-touches", message: `touches must be an array of paths (got ${describe(body["touches"])})` });
    } else if (body["touches"].length > PLAN_LIMITS.touches) {
      problems.push({ reason: "touches-too-many", message: `touches lists ${body["touches"].length} paths — cap is ${PLAN_LIMITS.touches}` });
    } else {
      for (const [index, one] of body["touches"].entries()) {
        const path = prose(one, `touches[${index}]`, PLAN_LIMITS.touch, true, problems);
        if (path !== null) {
          if (/[\n\t]/.test(path)) {
            problems.push({ reason: `touches[${index}]-multiline`, message: `touches[${index}] must be one line` });
          } else {
            touches.push(path);
          }
        }
      }
    }
  }

  const acceptanceParse = parseAcceptanceCriteria(body["acceptance"]);
  for (const problem of acceptanceParse.problems) {
    problems.push({ reason: problem.reason, message: problem.message });
  }
  if (acceptanceParse.problems.length === 0 && acceptanceParse.criteria.length === 0) {
    problems.push({ reason: "missing-acceptance", message: "acceptance is required — at least one signed criterion the build will be judged against" });
  }

  if (document !== null) {
    const execution = parseExecutionPlanDocument(document);
    if (!execution.ok) {
      problems.push(...execution.problems);
    } else if (acceptanceParse.problems.length === 0) {
      const proof = execution.document.proof.join("\n");
      for (const criterion of acceptanceParse.criteria) {
        const mentioned = new RegExp(`(^|[^A-Za-z0-9_-])${criterion.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`).test(proof);
        if (!mentioned) {
          problems.push({ reason: `plan-proof-missing-${criterion.id}`, message: `Proof must name acceptance criterion ${criterion.id}` });
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: { goal: goal as string, outOfScope, touches, acceptance: acceptanceParse.criteria, plan: document as string },
  };
}
