import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "proof-preflight.mjs");
const built = existsSync(join(root, "dist", "proof.js")) && existsSync(join(root, "dist", "decision.js"));

/** The exit preflight, run as the agent runs it, over the run 1497
 * contradictions (atomic authority closure): a criterion marked met while a
 * caveat names it is a blocking caveat the preflight refuses BEFORE the
 * attempt ends; the same caveats against not-met criteria pass. Runs
 * against dist/ — `npm run build` first; skipped, in words, when there is
 * no build to run against. */
describe("scripts/proof-preflight.mjs refuses a met criterion a caveat admits an exception to", () => {
  const proofOf = (verdict: "met" | "not-met") =>
    JSON.stringify({
      version: 1,
      criteria: [
        { id: "c1", statement: "Reviewer, contest, attended, base, resume, repair, and no-scope run admission proves its authority in the insert.", verdict, how: "startRun proves in its insert.", evidence: [{ kind: "check", ref: "npx vitest run" }] },
        { id: "c4", statement: "Routine integrity validates exact raw stored terms before consent, approval, and firing.", verdict, how: "readRoutine sets termsProblem.", evidence: [{ kind: "check", ref: "npx vitest run" }] },
      ],
      checks: [{ command: "npx vitest run", exitCode: 0, summary: "all green" }],
      changed: ["src/store.ts"],
      caveats: [
        "c1: A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures).",
        "c4: A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior).",
        "Reviewer proofs use an injected stubbed reviewer agent, not a live provider.",
      ],
      screenshots: [],
    });

  const run = (proof: string): { status: number | null; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "so-preflight-test-"));
    try {
      const file = join(dir, "PROOF.json");
      writeFileSync(file, proof);
      const result = spawnSync(process.execPath, [script, "--proof", file, "--criteria", "c1,c4"], { encoding: "utf8" });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.skipIf(!built)("run 1497 pinned: met c1 and c4 beside caveats naming them exit 1 with both contradictions named", () => {
    const { status, out } = run(proofOf("met"));
    expect(status).toBe(1);
    expect(out).toContain("criterion c1 is marked met, but caveat 1 admits an exception to it");
    expect(out).toContain("criterion c4 is marked met, but caveat 2 admits an exception to it");
    expect(out).toContain("2 problem(s)");
  });

  test.skipIf(!built)("the same caveats against not-met criteria pass: parse-valid, refs resolved, no blocking caveat", () => {
    const { status, out } = run(proofOf("not-met"));
    expect(status).toBe(0);
    expect(out).toContain("none blocking");
    expect(out).toContain("every named file parses and resolves");
  });
});
