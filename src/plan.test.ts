import { describe, expect, test } from "vitest";
import { parseExecutionPlanDocument, parsePlan } from "./plan.js";

const DOCUMENT = [
  "## Approach",
  "Follow the existing request path and keep the durable task as the source of truth.",
  "",
  "## Milestones",
  "1. Extend the existing planner contract.",
  "2. Render the result in the review surface.",
  "",
  "## Dependencies",
  "- Existing task and artifact records remain available.",
  "",
  "## Risks",
  "- A stale approval could authorize another revision; bind approval to the artifact hash.",
  "",
  "## Proof",
  "- c1 — run the parser and HTTP integration tests.",
].join("\n");

describe("structured execution plans", () => {
  test("parses the concise plan sections used by the UI and builder", () => {
    // Browsers submit textarea newlines as CRLF; the same document must not
    // become a control-character refusal merely because it came from the UI.
    const parsed = parseExecutionPlanDocument(DOCUMENT.replace(/\n/g, "\r\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.milestones).toEqual([
      "Extend the existing planner contract.",
      "Render the result in the review surface.",
    ]);
    expect(parsed.document.risks[0]).toContain("artifact hash");
  });

  test("a planner handoff fails closed when structure or acceptance proof is missing", () => {
    const missingSections = parsePlan(JSON.stringify({
      goal: "Ship it",
      outOfScope: null,
      touches: [],
      acceptance: [{ id: "c1", statement: "It works.", evidence: ["check"] }],
      plan: "## Approach\nJust do it.",
    }));
    expect(missingSections.ok).toBe(false);
    if (!missingSections.ok) expect(missingSections.problems.map(one => one.reason)).toContain("plan-missing-milestones");

    const missingProof = parsePlan(JSON.stringify({
      goal: "Ship it",
      outOfScope: null,
      touches: [],
      acceptance: [{ id: "c2", statement: "It works.", evidence: ["check"] }],
      plan: DOCUMENT,
    }));
    expect(missingProof.ok).toBe(false);
    if (!missingProof.ok) expect(missingProof.problems.map(one => one.reason)).toContain("plan-proof-missing-c2");
  });
});
