/**
 * Who may widen a revision's contract at planning: a person's send-back
 * notes may become an amendment they approve; a repair draft's brief never.
 */
import { describe, expect, test } from "vitest";
import { PLANNER_SOURCE_VERSION, plannerSourceBlock, type PlannerSource } from "./planner-source.js";

const sourceWith = (brief: Record<string, unknown>): PlannerSource => ({
  version: PLANNER_SOURCE_VERSION,
  taskId: "t-rev",
  title: "Add subtract — revision",
  contract: { scope: null, revision: { of: "t", briefArtifact: 1, briefSha256: "0".repeat(64) } } as unknown as PlannerSource["contract"],
  sourceDigest: "d".repeat(64),
  revisionBrief: JSON.stringify(brief),
  answers: [],
});

describe("planning a revision", () => {
  test("a send-back's notes may amend the copied contract, for the person to approve", () => {
    const block = plannerSourceBlock(sourceWith({ schema: 1, sourceTask: "t", sourceRun: 3, comments: [{ id: 1, note: "Also add multiply(a, b)." }] })).join("\n");
    expect(block).toContain("amend the contract to include it");
    expect(block).toContain("The operator approves every change before anything builds.");
    expect(block).not.toContain("cannot widen");
  });

  test("a repair draft's brief never widens it", () => {
    for (const kind of ["ci-repair", "criterion-repair", "evidence-observation"]) {
      const block = plannerSourceBlock(sourceWith({ schema: 1, kind, sourceTask: "t", sourceRun: 3, comments: [{ id: 1, note: "Also add multiply(a, b)." }] })).join("\n");
      expect(block).toContain("the brief\ncannot widen it.");
      expect(block).not.toContain("amend the contract to include it");
    }
  });
});
