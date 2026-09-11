import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProof, proofSubmissionProblems, adjudicate, type ApprovedCriterion } from "./proof.js";

const rubric: ApprovedCriterion[] = [{ id: "c1", statement: "Existing databases can save reviews", evidence: ["check", "changed-path"] }];
const proof = {
  version: 1, criteria: [{ id: "c1", statement: rubric[0]!.statement, verdict: "met", how: "Migration regression passed",
    evidence: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/store.ts" }] }],
  checks: [{ command: "npm test", exitCode: 0, summary: "passed" }], changed: ["src/store.ts"], caveats: [], screenshots: [],
};

describe("canonical signed proof contract", () => {
  test.each(["suffix", "missing-id", "missing-evidence", "failed-check"])("preflight rejects %s with the same facts as adjudication", kind => {
    const payload = structuredClone(proof);
    if (kind === "suffix") payload.criteria[0]!.statement += " (requires evidence: check, changed-path)";
    if (kind === "missing-id") payload.criteria = [];
    if (kind === "missing-evidence") payload.criteria[0]!.evidence = payload.criteria[0]!.evidence.slice(0, 1);
    if (kind === "failed-check") payload.checks[0]!.exitCode = 1;
    const parsed = parseProof(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const problems = proofSubmissionProblems(parsed.proof, rubric);
    expect(problems.length).toBeGreaterThan(0);
    const verdict = adjudicate({
      proofArtifactPresent: true, proofParse: parsed, handoffPresent: true,
      terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths: new Set(payload.changed) },
      screenshots: [], verifyCommand: { configured: true, ran: true, exitCode: 0 }, approvedCriteria: rubric,
    });
    expect(["short", "refuted"]).toContain(verdict.verdict);
    expect(verdict.reasons.join(" ")).toContain(problems[0]);
    const dir = mkdtempSync(join(tmpdir(), "so-canonical-proof-"));
    try {
      writeFileSync(join(dir, "rubric.json"), JSON.stringify(rubric));
      writeFileSync(join(dir, "proof.json"), JSON.stringify(payload));
      const result = spawnSync(process.execPath, [resolve("scripts/proof-preflight.mjs"), "--proof", join(dir, "proof.json"), "--rubric", join(dir, "rubric.json")], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(problems[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
