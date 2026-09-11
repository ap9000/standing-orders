import { describe, expect, test } from "vitest";
import { assertReviewedCriteria } from "../scripts/canary-assertions.mjs";

describe("real-provider review certification", () => {
  const row = (id: string, judgement = "upholds", author = "reviewer:codex·gpt-5.6-sol") => ({ id, review: { judgement, author, note: "actual sealed evidence" } });
  const check = (matrix: unknown[]) => assertReviewedCriteria(matrix, ["c1", "c2"], "codex", "gpt-5.6-sol");
  test("requires an independent upholding judgement for every signed id", () => {
    expect(() => check([row("c1"), row("c2")])).not.toThrow();
    for (const judgement of ["cannot-tell", "contradicts"]) {
      expect(() => check([row("c1"), row("c2", judgement)])).toThrow(/not independently upheld/);
    }
    expect(() => check([row("c1"), { id: "c2", state: "pass", review: null }])).toThrow(/not independently upheld/);
    expect(() => check([row("c1"), row("c2", "upholds", "reviewer:claude")])).toThrow(/not independently upheld/);
  });
  test("refuses omitted, duplicated, or substituted criterion ids", () => {
    for (const matrix of [[], [row("c1")], [row("c1"), row("c1")], [row("c1"), row("other")]]) {
      expect(() => check(matrix)).toThrow(/signed rubric/);
    }
  });
});
