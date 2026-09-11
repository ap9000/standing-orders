import { describe, test, expect } from "vitest";
import {
  parseProof,
  serializeProof,
  adjudicate,
  verdictWords,
  dispatchStatusToken,
  foldReview,
  passFraction,
  blockingCaveats,
  PROOF_LIMITS,
  type AdjudicateInput,
  type AdjudicateResult,
  type CriterionMatrixRow,
  type CriterionJudgement,
} from "./proof.js";

const sound = {
  version: 1,
  criteria: [{ id: "c1", statement: "The button opens the settings panel.", verdict: "met", how: "Clicked it in the demo build." }],
  checks: [{ command: "npm test", exitCode: 0, summary: "1668 tests passed." }],
  changed: ["src/x.ts"],
  caveats: ["The panel does not yet remember scroll position."],
  screenshots: [{ path: "evidence/settings-panel.png", caption: "Settings panel open." }],
};

const parse = (payload: unknown) => parseProof(JSON.stringify(payload));
const problemsOf = (payload: unknown): string[] => {
  const result = parse(payload);
  return result.ok ? [] : result.problems.map(p => p.reason);
};

describe("parseProof", () => {
  test("accepts a sound proof", () => {
    const result = parse(sound);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.criteria).toHaveLength(1);
    expect(result.proof.checks).toHaveLength(1);
    expect(result.proof.changed).toEqual(["src/x.ts"]);
    expect(result.proof.screenshots).toEqual([{ path: "evidence/settings-panel.png", caption: "Settings panel open." }]);
  });

  test("every list is optional except version", () => {
    expect(parse({ version: 1 })).toMatchObject({ ok: true, proof: { criteria: [], checks: [], changed: [], caveats: [], screenshots: [] } });
  });

  test("refuses what is not JSON, and what is JSON but not an object", () => {
    expect(parseProof("not json {")).toMatchObject({ ok: false });
    expect(problemsOf([sound])).toContain("not-an-object");
    expect(parseProof(JSON.stringify("a string"))).toMatchObject({ ok: false });
  });

  test("version must be exactly 1", () => {
    expect(problemsOf({ ...sound, version: 2 })).toContain("bad-version");
    expect(problemsOf({ ...sound, version: undefined })).toContain("bad-version");
  });

  test("the whole payload is capped", () => {
    const bloated = { ...sound, caveats: ["x".repeat(PROOF_LIMITS.payload)] };
    expect(parseProof(JSON.stringify(bloated))).toMatchObject({ ok: false });
  });

  describe("criteria", () => {
    test("must be an array", () => {
      expect(problemsOf({ ...sound, criteria: "nope" })).toContain("bad-criteria");
    });
    test("caps at PROOF_LIMITS.criteria", () => {
      const many = Array.from({ length: PROOF_LIMITS.criteria + 1 }, (_, i) => ({ id: `c${i}`, statement: "s", verdict: "met", how: "h" }));
      expect(problemsOf({ ...sound, criteria: many })).toContain("criteria-too-many");
    });
    test("ids must be unique", () => {
      const dupes = [
        { id: "same", statement: "a", verdict: "met", how: "h" },
        { id: "same", statement: "b", verdict: "met", how: "h" },
      ];
      expect(problemsOf({ ...sound, criteria: dupes })).toContain("criteria[1]-duplicate-id");
    });
    test("verdict must be one of the three words", () => {
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "sort-of", how: "h" }] })).toContain(
        "criteria[0]-bad-verdict",
      );
    });
    test("statement and how are required prose, capped and control-free", () => {
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "", verdict: "met", how: "h" }] })).toContain(
        "missing-criteria[0].statement",
      );
      expect(
        problemsOf({ ...sound, criteria: [{ id: "c1", statement: "x".repeat(PROOF_LIMITS.criterionStatement + 1), verdict: "met", how: "h" }] }),
      ).toContain("criteria[0].statement-too-long");
      expect(
        problemsOf({ ...sound, criteria: [{ id: "c1", statement: "look]0;pwned", verdict: "met", how: "h" }] }),
      ).toContain("criteria[0].statement-controls");
    });
    test("how is capped at PROOF_LIMITS.criterionHow bytes: exact cap accepted, one byte over refused", () => {
      const atCap = "h".repeat(PROOF_LIMITS.criterionHow);
      const atCapResult = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "met", how: atCap }] });
      expect(atCapResult.ok).toBe(true);
      if (atCapResult.ok) expect(atCapResult.proof.criteria[0].how).toBe(atCap);

      const overCap = "h".repeat(PROOF_LIMITS.criterionHow + 1);
      expect(problemsOf({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "met", how: overCap }] })).toContain(
        "criteria[0].how-too-long",
      );
    });
  });

  describe("checks", () => {
    test("must be an array capped at PROOF_LIMITS.checks", () => {
      expect(problemsOf({ ...sound, checks: "nope" })).toContain("bad-checks");
      const many = Array.from({ length: PROOF_LIMITS.checks + 1 }, () => ({ command: "npm test", exitCode: 0, summary: "ok" }));
      expect(problemsOf({ ...sound, checks: many })).toContain("checks-too-many");
    });
    test("exitCode must be an integer 0-255", () => {
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: -1, summary: "s" }] })).toContain("checks[0]-bad-exit-code");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: 256, summary: "s" }] })).toContain("checks[0]-bad-exit-code");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: 1.5, summary: "s" }] })).toContain("checks[0]-bad-exit-code");
      expect(problemsOf({ ...sound, checks: [{ command: "c", exitCode: "0", summary: "s" }] })).toContain("checks[0]-bad-exit-code");
    });
    test("command and summary are required, capped, control-free", () => {
      expect(problemsOf({ ...sound, checks: [{ command: "", exitCode: 0, summary: "s" }] })).toContain("missing-checks[0].command");
    });
  });

  describe("changed and caveats", () => {
    test("changed caps at PROOF_LIMITS.changed entries", () => {
      const many = Array.from({ length: PROOF_LIMITS.changed + 1 }, (_, i) => `src/f${i}.ts`);
      expect(problemsOf({ ...sound, changed: many })).toContain("changed-too-many");
    });
    test("caveats caps at PROOF_LIMITS.caveats entries", () => {
      const many = Array.from({ length: PROOF_LIMITS.caveats + 1 }, (_, i) => `caveat ${i}`);
      expect(problemsOf({ ...sound, caveats: many })).toContain("caveats-too-many");
    });
    test("entries are prose: capped, control-free", () => {
      expect(problemsOf({ ...sound, changed: ["x".repeat(PROOF_LIMITS.changedPath + 1)] })).toContain("changed[0]-too-long");
      expect(problemsOf({ ...sound, caveats: ["look]0;pwned"] })).toContain("caveats[0]-controls");
    });
    test("a caveat is capped at PROOF_LIMITS.caveat bytes UTF-8, not characters: exact cap accepted, one byte over refused", () => {
      // "é" is one character but two UTF-8 bytes — a char-length check would
      // wrongly pass this at half PROOF_LIMITS.caveat characters.
      const atCap = "é".repeat(PROOF_LIMITS.caveat / 2);
      const atCapResult = parse({ ...sound, caveats: [atCap] });
      expect(atCapResult.ok).toBe(true);
      if (atCapResult.ok) expect(atCapResult.proof.caveats[0]).toBe(atCap);

      const overCap = atCap + "x";
      expect(problemsOf({ ...sound, caveats: [overCap] })).toContain("caveats[0]-too-long");
    });
  });

  describe("screenshots", () => {
    test("must be an array capped at PROOF_LIMITS.screenshots", () => {
      expect(problemsOf({ ...sound, screenshots: "nope" })).toContain("bad-screenshots");
      const many = Array.from({ length: PROOF_LIMITS.screenshots + 1 }, (_, i) => ({ path: `e/${i}.png`, caption: "c" }));
      expect(problemsOf({ ...sound, screenshots: many })).toContain("screenshots-too-many");
    });
    test("path must be a normalized repository-relative path", () => {
      expect(problemsOf({ ...sound, screenshots: [{ path: "/etc/passwd", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
      expect(problemsOf({ ...sound, screenshots: [{ path: "../../etc/passwd", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
      expect(problemsOf({ ...sound, screenshots: [{ path: "a\\b.png", caption: "c" }] })).toContain(
        "screenshots[0].path-not-relative",
      );
    });
    test("paths must be unique", () => {
      const dupes = [
        { path: "e/a.png", caption: "a" },
        { path: "e/a.png", caption: "b" },
      ];
      expect(problemsOf({ ...sound, screenshots: dupes })).toContain("screenshots[1]-duplicate-path");
    });
    test("caption is required prose", () => {
      expect(problemsOf({ ...sound, screenshots: [{ path: "e/a.png", caption: "" }] })).toContain(
        "missing-screenshots[0].caption",
      );
    });
  });

  test("re-serializes to the validated shape, not the raw bytes", () => {
    const result = parse({ ...sound, extraField: "ignored", criteria: [{ id: "c1", statement: "s", verdict: "met", how: "h", extra: "x" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = serializeProof(result.proof);
    expect(serialized).not.toContain("extraField");
    expect(serialized).not.toContain("\"extra\"");
    expect(JSON.parse(serialized)).toEqual(result.proof);
  });
});

describe("adjudicate", () => {
  const base: AdjudicateInput = {
    proofArtifactPresent: true,
    proofParse: parse(sound),
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) },
    verifyCommand: { configured: false },
    screenshots: [{ path: "evidence/settings-panel.png", ok: true }],
  };

  test("rule 1: no proof artifact at all -> short", () => {
    expect(adjudicate({ ...base, proofArtifactPresent: false, proofParse: null })).toMatchObject({
      verdict: "short",
      reasons: ["no proof was written"],
    });
  });

  test("rule 2: malformed proof -> short, names the problem", () => {
    const malformed = parseProof("not json {");
    const result = adjudicate({ ...base, proofParse: malformed });
    expect(result.verdict).toBe("short");
    expect(result.reasons[0]).toMatch(/malformed/);
  });

  test("rule 3: missing handoff -> short", () => {
    expect(adjudicate({ ...base, handoffPresent: false })).toMatchObject({ verdict: "short" });
  });

  test("rule 3: missing terminal diff -> short", () => {
    expect(adjudicate({ ...base, terminalDiffPresent: false })).toMatchObject({ verdict: "short" });
  });

  test("rule 3: failed diff capture -> short", () => {
    expect(adjudicate({ ...base, terminalDiffCaptureStatus: "failed" })).toMatchObject({ verdict: "short" });
  });

  test("rule 4: a claimed changed path absent from the sealed, untruncated stat -> refuted", () => {
    const result = adjudicate({ ...base, diffStat: { captured: true, truncated: false, paths: new Set(["src/other.ts"]) } });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons[0]).toContain("src/x.ts");
  });

  test("rule 4 does not fire when the stat is truncated — cannot prove absence", () => {
    const result = adjudicate({ ...base, diffStat: { captured: true, truncated: true, paths: new Set() } });
    expect(result.verdict).not.toBe("refuted");
  });

  test("rule 4 does not fire when the stat failed to capture", () => {
    const result = adjudicate({ ...base, diffStat: { captured: false, truncated: false, paths: new Set() } });
    expect(result.verdict).not.toBe("refuted");
  });

  test("altering a signed criterion remains refuted when verification could not run", () => {
    const signed = "The button opens the settings panel.";
    const restated = "The button closes the settings panel.";
    const altered = parse({
      ...sound,
      criteria: [{ id: "c1", statement: restated, verdict: "met", how: "Clicked it in the demo build." }],
    });
    const result = adjudicate({
      ...base,
      proofParse: altered,
      approvedCriteria: [{ id: "c1", statement: signed, evidence: [] }],
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure: "spawn-failed" },
    });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: [`criterion "c1" was signed as "${signed}" and the proof restates it as "${restated}"`],
    });
  });

  test("rule 5: an approved verification command that exits non-zero -> refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 1 } });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: ["the repository's approved verification command exited 1"],
    });
  });

  test("a check passing after bounded setup replay is verified", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 0, setupReplayed: true } });
    expect(result).toMatchObject({
      verdict: "verified",
      reasons: ["the approved verification command passed after the approved setup command ran"],
    });
  });

  test("a check that starts but fails after setup replay is refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 1, setupReplayed: true } });
    expect(result).toMatchObject({
      verdict: "refuted",
      reasons: ["the repository's approved verification command exited 1 after the approved setup command was replayed"],
    });
  });

  test.each([
    ["spawn-failed", "the approved verification command could not be run"],
    ["dependency-missing", "the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"],
    ["setup-stale", "automatic recovery stopped because the project setup or check changed"],
    ["setup-failed", "the approved setup command failed during automatic recovery"],
    ["tracked-files-changed", "automatic recovery stopped because tracked files no longer matched the built result"],
    ["dependency-still-missing", "the required project executable was still unavailable after replaying the approved setup command"],
    ["setup-changed-files", "automatic recovery stopped because the setup command changed tracked files after the build"],
    ["checkout-moved", "automatic recovery stopped because the checkout moved away from the built commit"],
    ["cleanliness-unavailable", "automatic recovery stopped because Standing Orders could not confirm that the built checkout was unchanged"],
    ["custody-lost", "automatic recovery stopped because this worker no longer owned the build"],
  ] as const)("automatic recovery failure %s stays short", (failure, reason) => {
    const result = adjudicate({
      ...base,
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure },
    });
    expect(result).toMatchObject({ verdict: "short", reasons: [reason] });
  });

  test("rule 6: any criterion not-met or not-checked -> short", () => {
    const notMet = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "not-met", how: "h" }] });
    expect(adjudicate({ ...base, proofParse: notMet })).toMatchObject({ verdict: "short" });
    const notChecked = parse({ ...sound, criteria: [{ id: "c1", statement: "s", verdict: "not-checked", how: "h" }] });
    expect(adjudicate({ ...base, proofParse: notChecked })).toMatchObject({ verdict: "short" });
  });

  test("an unverifiable claimed screenshot -> short", () => {
    const result = adjudicate({ ...base, screenshots: [{ path: "evidence/settings-panel.png", ok: false, problem: "not a PNG or JPEG" }] });
    expect(result.verdict).toBe("short");
    expect(result.reasons[0]).toContain("evidence/settings-panel.png");
  });

  test("rule 7: an approved verification command that passes -> verified", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: true, exitCode: 0 } });
    expect(result.verdict).toBe("verified");
  });

  test("rule 7: no verification command configured -> attested, the honest floor", () => {
    expect(adjudicate(base)).toMatchObject({ verdict: "attested" });
  });

  test("a configured command that could not be run at all -> short, not refuted", () => {
    const result = adjudicate({ ...base, verifyCommand: { configured: true, ran: false, attemptFailed: true } });
    expect(result.verdict).toBe("short");
  });

  // The run 1497 contradictions, pinned (atomic authority closure): that
  // proof marked c1 and c4 met while its own caveats admitted the
  // no-scope unstamped row and the routine edge page. A caveat that names
  // a met criterion's id is a blocking exception — the proof disagrees
  // with itself and is refuted, whether or not a rubric was signed, and
  // even when the approved verification command could not run.
  const run1497 = {
    c1: "Reviewer, contest, attended, base, resume, repair, and no-scope run admission proves its live request, lane or authorization and exact route or custody in the same transaction as insertion, and no generic or post-insert path can bypass it or leave a row.",
    c4: "Routine integrity validates exact raw stored terms and build or repair parity before consent or approval and before firing, and any corruption leaves the routine, slot, ledger, task, notification, and next-fire rows unchanged.",
  };
  const noScopeCaveat = "c1: A task with no scope still opens an unstamped run when nothing is presented (kept to avoid churn across ~250 fixtures); the spend gate refuses such rows.";
  const routinePageCaveat = "c4: A corrupt routine SNAPSHOT still pages once at the edge (pre-existing pinned behavior); corrupt raw TERMS write nothing at all, not even a page.";
  const contradicted = (verdict: "met" | "not-met") =>
    parse({
      ...sound,
      criteria: [
        { id: "c1", statement: run1497.c1, verdict, how: "startRun proves in its insert." },
        { id: "c4", statement: run1497.c4, verdict, how: "readRoutine sets termsProblem." },
      ],
      caveats: [noScopeCaveat, routinePageCaveat, "Reviewer proofs use an injected stubbed reviewer agent, not a live provider."],
    });

  test("run 1497 pinned: a met c1 whose caveat admits the no-scope row, and a met c4 whose caveat admits the routine page, refute the proof", () => {
    const result = adjudicate({ ...base, proofParse: contradicted("met"), diffStat: { captured: true, truncated: false, paths: new Set(["src/x.ts"]) } });
    expect(result.verdict).toBe("refuted");
    expect(result.reasons).toEqual([
      `criterion "c1" is marked met, but caveat 1 admits an exception to it: ${noScopeCaveat}`,
      `criterion "c4" is marked met, but caveat 2 admits an exception to it: ${routinePageCaveat}`,
    ]);
    expect(verdictWords(result.verdict, result.reasons).word).toBe("conflicting evidence");
  });

  test("run 1497 pinned: the same caveats against not-met criteria are honest — short, never refuted", () => {
    const result = adjudicate({ ...base, proofParse: contradicted("not-met") });
    expect(result.verdict).toBe("short");
    expect(result.reasons.every(one => /is not met/.test(one))).toBe(true);
  });

  test("a blocking caveat outranks an unavailable verification command and fails the signed row in the matrix", () => {
    const result = adjudicate({
      ...base,
      proofParse: contradicted("met"),
      approvedCriteria: [
        { id: "c1", statement: run1497.c1, evidence: [] },
        { id: "c4", statement: run1497.c4, evidence: [] },
      ],
      verifyCommand: { configured: true, ran: false, attemptFailed: true, failure: "spawn-failed" },
    });
    expect(result.verdict).toBe("refuted");
    expect(result.matrix.map(row => [row.id, row.state])).toEqual([
      ["c1", "failed"],
      ["c4", "failed"],
    ]);
    expect(result.matrix[0]!.detail[0]).toBe(`criterion "c1" is marked met, but caveat 1 admits an exception to it: ${noScopeCaveat}`);
  });

  test("blockingCaveats names a criterion only by its exact standalone id token", () => {
    const criteria = [
      { id: "c1", statement: "s", verdict: "met" as const, how: "h", evidence: [] },
      { id: "c10", statement: "s", verdict: "met" as const, how: "h", evidence: [] },
      { id: "c2", statement: "s", verdict: "not-met" as const, how: "h", evidence: [] },
    ];
    const named = (caveats: string[]) => blockingCaveats({ criteria, caveats }).map(one => `${one.index}:${one.criterionId}`);
    expect(named(["c10 still pages once"])).toEqual(["0:c10"]);
    expect(named(["(c1) kept for churn", "c1,c10 both"])).toEqual(["0:c1", "1:c1", "1:c10"]);
    expect(named(["c2: honestly not met"])).toEqual([]);
    expect(named(["ac1 and c1x and c1-ish and c1_ are other words", "The panel does not remember scroll position."])).toEqual([]);
  });

  test("a proof with no criteria and no verify command still attests when the diff agrees", () => {
    const empty = parse({ version: 1 });
    expect(adjudicate({ ...base, proofParse: empty, diffStat: { captured: true, truncated: false, paths: new Set() } })).toMatchObject({
      verdict: "attested",
    });
  });
});

describe("foldReview (v40, evidence-review-v1)", () => {
  const row = (id: string, state: CriterionMatrixRow["state"] = "pass"): CriterionMatrixRow => ({
    id,
    statement: `statement ${id}`,
    requiredEvidence: ["manual-review"],
    state,
    detail: [],
    answered: [],
    review: null,
  });

  const judgement = (id: string, word: CriterionJudgement["judgement"], note = "note"): CriterionJudgement => ({
    id,
    judgement: word,
    note,
    author: "reviewer:codex",
  });

  test("identity fold: no judgements leaves the result untouched, even against an empty rubric", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["r"], matrix: [] };
    expect(foldReview(base, [])).toEqual(base);
    const withRows: AdjudicateResult = { verdict: "short", reasons: ["r"], matrix: [row("c1", "missing")] };
    expect(foldReview(withRows, [])).toEqual(withRows);
  });

  test("contradicts refutes: a signed criterion a second reader says is unmet fails the whole proof", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["fine"], matrix: [row("c1"), row("c2")] };
    const result = foldReview(base, [judgement("c1", "contradicts", "never implemented")]);
    expect(result.verdict).toBe("refuted");
    const failed = result.matrix.find(r => r.id === "c1");
    expect(failed?.state).toBe("failed");
    expect(failed?.detail.join(" ")).toContain("never implemented");
    expect(failed?.review).toEqual({ judgement: "contradicts", note: "never implemented", author: "reviewer:codex" });
    // an untouched row keeps its own state and gets no review
    expect(result.matrix.find(r => r.id === "c2")).toMatchObject({ state: "pass", review: null });
  });

  test("cannot-tell changes nothing: recorded, never moves the verdict", () => {
    const base: AdjudicateResult = { verdict: "short", reasons: ["gap"], matrix: [row("c1", "missing")] };
    const result = foldReview(base, [judgement("c1", "cannot-tell", "the patch alone cannot settle this")]);
    expect(result.verdict).toBe("short");
    expect(result.reasons).toEqual(base.reasons);
    expect(result.matrix[0]?.state).toBe("missing");
    expect(result.matrix[0]?.review).toEqual({ judgement: "cannot-tell", note: "the patch alone cannot settle this", author: "reviewer:codex" });
  });

  test("upholds never upgrades: a short run stays short", () => {
    const base: AdjudicateResult = { verdict: "short", reasons: ["gap"], matrix: [row("c1", "missing")] };
    const result = foldReview(base, [judgement("c1", "upholds", "looks right to me")]);
    expect(result.verdict).toBe("short");
    expect(result.matrix[0]?.state).toBe("missing");
    expect(result.matrix[0]?.review?.judgement).toBe("upholds");
  });

  test("upholds never upgrades: an attested run stays attested, never verified", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["clean"], matrix: [row("c1")] };
    const result = foldReview(base, [judgement("c1", "upholds")]);
    expect(result.verdict).toBe("attested");
  });

  test("a judgement naming an id absent from the matrix is ignored", () => {
    const base: AdjudicateResult = { verdict: "attested", reasons: ["clean"], matrix: [row("c1")] };
    const result = foldReview(base, [judgement("unsigned-id", "contradicts", "n/a")]);
    expect(result).toEqual(base);
  });
});

describe("passFraction", () => {
  test("counts pass rows against the total", () => {
    const matrix: CriterionMatrixRow[] = [
      { id: "c1", statement: "s", requiredEvidence: [], state: "pass", detail: [], answered: [], review: null },
      { id: "c2", statement: "s", requiredEvidence: [], state: "missing", detail: [], answered: [], review: null },
    ];
    expect(passFraction(matrix)).toEqual({ passed: 1, total: 2 });
  });

  test("an empty matrix is 0/0", () => {
    expect(passFraction([])).toEqual({ passed: 0, total: 0 });
  });
});

describe("verdictWords and dispatchStatusToken", () => {
  test("cover every verdict with distinct words and tokens", () => {
    const verdicts = ["verified", "attested", "short", "refuted"] as const;
    const words = verdicts.map(v => verdictWords(v, ["a reason"]).word);
    expect(new Set(words).size).toBe(verdicts.length);
    const tokens = verdicts.map(dispatchStatusToken);
    expect(tokens).toEqual(["complete-verified", "complete-with-evidence", "needs-verification", "proof-refuted"]);
  });
});
