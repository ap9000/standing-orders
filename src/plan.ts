/**
 * The planner's terminal handoff, parsed with the 422 rule: fail closed,
 * every problem reported at once, stable reasons, caps and control-character
 * rejection on every string — because a plan payload reaches terminals, the
 * approve card, and the builder's brief (Codex planning review, question 2:
 * the scope proposal is authority-bearing, so it gets the park discipline).
 */

import { hasForbiddenControls } from "./decision.js";

export type PlanProblem = { reason: string; message: string };

export type ParsedPlan = {
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** The plan document, markdown, rendered fenced-inert everywhere. */
  plan: string;
};

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

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: { goal: goal as string, outOfScope, touches, plan: document as string },
  };
}
