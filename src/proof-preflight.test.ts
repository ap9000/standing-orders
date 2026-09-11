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
  const proofOf = (verdict: "met" | "not-met", caveats?: string[]) =>
    JSON.stringify({
      version: 1,
      criteria: [
        { id: "c1", statement: "Reviewer, contest, attended, base, resume, repair, and no-scope run admission proves its authority in the insert.", verdict, how: "startRun proves in its insert.", evidence: [{ kind: "check", ref: "npx vitest run" }] },
        { id: "c4", statement: "Routine integrity validates exact raw stored terms before consent, approval, and firing.", verdict, how: "readRoutine sets termsProblem.", evidence: [{ kind: "check", ref: "npx vitest run" }] },
      ],
      checks: [{ command: "npx vitest run", exitCode: 0, summary: "all green" }],
      changed: ["src/store.ts"],
      caveats: caveats ?? [
        "c1: A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures).",
        "c4: A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior).",
      ],
      screenshots: [],
    });
  // The EXACT caveats runs 1497 and 1500 stored (final authority closure):
  // none names a criterion id, so the preflight refuses each as unassigned
  // — the synthetic `c1:`/`c4:` prefixes earlier tests added were the only
  // reason a proof shaped like them ever exited 0.
  const run1497Caveats = [
    "A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures); the spend gate refuses such rows. A presented no-scope stamp must be the bare word legacy.",
    "Pre-routing (route_era NULL) chain approvals can no longer run non-primary fallback entries; the tick reports fallback-stale-approval with the reason until the scope is re-filed and approved.",
    "A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior); corrupt raw TERMS write nothing at all, not even a page.",
    "Reviewer proofs use an injected stubbed reviewer agent, not a live provider; migration proofs replay a logical SQL dump of a v47 database, not a binary v47 file.",
  ];
  const run1500Caveats = [
    "Attended launch refusals after admission (stale head, run-held, session-cap) now close the admission-bound authorization as refused:<reason>; the operator re-authorizes instead of an automatic retry.",
    "The blocking-caveat rule is a token contract: a caveat that admits an exception without naming the criterion id is not machine-attributable; the brief tells agents to name it.",
    "Contest lane repair turns on routed tasks were refused before this change too (sealed-route leg vs lane profile); untouched and not covered by tests.",
    "Auth-mode strictness at filing, consent, and seal reads the operator's home through readAuthModeStrict with no keyHome injection; tests point HOME at a temp dir.",
    "Migrated routines with an empty legacy rubric stay refreshable and approvable (storedRubric); the filing door still requires at least one criterion.",
  ];

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

  test.skipIf(!built)("the same caveats against not-met criteria pass: parse-valid, refs resolved, no blocking caveat, every caveat attributed", () => {
    const { status, out } = run(proofOf("not-met"));
    expect(status).toBe(0);
    expect(out).toContain("none blocking");
    expect(out).toContain("every named file parses and resolves");
  });

  for (const [label, caveats] of [
    ["run 1497", run1497Caveats],
    ["run 1500", run1500Caveats],
  ] as const) {
    test.skipIf(!built)(`${label}'s exact stored caveats exit 1: every caveat is unassigned, met or not-met alike`, () => {
      for (const verdict of ["met", "not-met"] as const) {
        const { status, out } = run(proofOf(verdict, [...caveats]));
        expect(status).toBe(1);
        expect(out).toContain(`${caveats.length} problem(s)`);
        caveats.forEach((caveat, index) => {
          expect(out).toContain(`proof: caveat ${index + 1} names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): ${caveat}`);
        });
      }
    });
  }

  test.skipIf(!built)("a proof-authored extra id is no signed authority (final admission closure): under --criteria c1,c4 a caveat tagged with the proof's own c7 exits 1 as unknown; with no rubric named, the answered c7 attributes", () => {
    const extra = "c7: the routine page still renders the old words under the extra criterion.";
    const proof = JSON.stringify({
      ...(JSON.parse(proofOf("not-met", [extra])) as { criteria: unknown[] }),
      criteria: [
        ...(JSON.parse(proofOf("not-met")) as { criteria: unknown[] }).criteria,
        { id: "c7", statement: "An extra criterion the proof recorded on its own.", verdict: "not-met", how: "noted", evidence: [{ kind: "check", ref: "npx vitest run" }] },
      ],
    });
    const refused = run(proof);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`proof: caveat 1 names "c7", a criterion the proof authored for itself that nobody signed — a proof-only id is no signed authority; every caveat names a signed criterion's exact id: ${extra}`);
    expect(refused.out).toContain("1 problem(s)");
    const dir = mkdtempSync(join(tmpdir(), "so-preflight-test-"));
    try {
      const file = join(dir, "PROOF.json");
      writeFileSync(file, proof);
      const result = spawnSync(process.execPath, [script, "--proof", file], { encoding: "utf8" });
      const out = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(out).not.toContain("no signed or answered criterion");
      expect(out).not.toContain("proof-only id is no signed authority");
      expect(out).toContain("every named file parses and resolves");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!built)("a caveat tagged with an id nobody signed exits 1 as unknown; once the signed rubric names that id the tag is known and only the unanswered criterion remains", () => {
    const proof = proofOf("not-met", ["c9: the routine page still renders the old words."]);
    const refused = run(proof);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('proof: caveat 1 names "c9", which is no signed or answered criterion');
    const dir = mkdtempSync(join(tmpdir(), "so-preflight-test-"));
    try {
      const file = join(dir, "PROOF.json");
      writeFileSync(file, proof);
      const result = spawnSync(process.execPath, [script, "--proof", file, "--criteria", "c1,c4,c9"], { encoding: "utf8" });
      const out = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(out).not.toContain("no signed or answered criterion");
      expect(out).toContain("proof: signed criterion c9 is not answered");
      expect(out).toContain("1 problem(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
