import { describe, expect, test } from "vitest";
import { parseExecutionPlanDocument, parsePlan, renderExecutionPlanDocument } from "./plan.js";

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

describe("rendering an execution plan back to markdown", () => {
  test("render is the parser's inverse: what a revision stores re-parses identically", () => {
    // The round trip is the whole contract. A builder's revision proposal is
    // stored RE-SERIALIZED from the validated shape rather than as the
    // agent's raw bytes, so the next brief quotes — and the next parse
    // admits — exactly what this parser already agreed to.
    const first = parseExecutionPlanDocument(DOCUMENT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rendered = renderExecutionPlanDocument(first.document);
    const second = parseExecutionPlanDocument(rendered);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.document).toEqual(first.document);
    // And it is idempotent: rendering the re-parse changes nothing further.
    expect(renderExecutionPlanDocument(second.document)).toBe(rendered);
  });

  test("numbered lists and multi-line approaches survive the round trip", () => {
    // The parser accepts "1." and "-" alike and keeps neither; the renderer
    // emits one canonical bullet form, and that must still re-parse to the
    // same items rather than to a bullet character glued onto the text.
    const parsed = parseExecutionPlanDocument(DOCUMENT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rendered = renderExecutionPlanDocument(parsed.document);
    expect(rendered).toContain("- Extend the existing planner contract.");
    expect(rendered.startsWith("## Approach\n")).toBe(true);

    const again = parseExecutionPlanDocument(rendered);
    expect(again.ok && again.document.milestones).toEqual([
      "Extend the existing planner contract.",
      "Render the result in the review surface.",
    ]);
  });
});
