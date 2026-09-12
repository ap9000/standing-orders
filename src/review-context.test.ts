/**
 * Inherited review context (v51, contract handoff task 3), end to end
 * against a REAL git repository and a fresh store: a small revision to a
 * larger feature seals bounded source context for the criteria the
 * earlier build implemented, every item bound to source run, commit,
 * path, and digest; changed criteria, changed code, stale ancestry,
 * tampered ancestors, byte limits, binaries, and secrets all read as
 * named gaps or invalid support; both subscription reviewers receive the
 * identical sealed bytes; and judgements on inherited criteria must cite
 * supplied provenance. Nothing here reads a working tree as evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { run as exec } from "./exec.js";
import { budgetedStatJson, parseNumstat, readVerifiedArtifact, storeEvidence, writeEvidenceFile } from "./evidence.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { adjudicate, coverageWords, foldReview, matrixWords, semanticCoverage, type CriterionMatrixRow } from "./proof.js";
import {
  captureReviewContext,
  citesSuppliedProvenance,
  deriveReviewContext,
  parseReviewContext,
  REVIEW_CONTEXT_LIMITS,
  reviewContextRules,
  serializeReviewContext,
  type ReviewContextInventory,
} from "./review-context.js";
import { parseReview, reviewPass, REVIEW_CONTEXT_NAME, REVIEW_PATCH_NAME, REVIEW_RUBRIC_NAME, REVIEW_PROOF_NAME } from "./reviewer.js";
import type { Runner } from "./builder.js";

const T0 = new Date("2026-09-11T12:00:00.000Z");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const spoken = (payload: unknown): string => JSON.stringify({ result: JSON.stringify(payload) });
const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-09-11T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-11T12:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commitFiles = (cwd: string, files: Record<string, string | Buffer>, message: string): string => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** The exact route authority a fixture PRESENTS at admission (v48). */
const presented = (
  s: Pick<Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: "sonnet" },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role, null) ?? s.routeAuthorityFor(taskRef, role, null, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const LIMIT_TS = "export function limiter(): number {\n  return 3;\n}\n";
const GUARD_TS = "export function guard(n: number): boolean {\n  return n < 3;\n}\n";
const REPORT_TS = "export function report(): string {\n  return 'ok';\n}\n";
const REPORT_TS_V2 = "export function report(): string {\n  return 'ok, revised';\n}\n";

const RUBRIC = [
  { id: "c1", statement: "The limiter caps retries at three.", how: null, evidence: ["check"] as const },
  { id: "c2", statement: "The guard refuses a fourth attempt.", how: null, evidence: ["check"] as const },
  { id: "c3", statement: "The report names the outcome.", how: null, evidence: ["changed-path"] as const },
  { id: "c4", statement: "The whole gate passes.", how: null, evidence: ["check"] as const },
];

type Fixture = {
  repo: string;
  store: Store;
  evidenceRoot: string;
  approverToken: string;
  sourceTaskRef: number;
  sourceRun: number;
  sourceDiffArtifact: number;
  sourceProofArtifact: number;
  revisionTaskId: string;
  revisionTaskRef: number;
  revisionRun: number;
  shas: { base: string; source: string; revision: string };
};

describe("inherited review context (v51)", () => {
  let dirs: string[] = [];
  let stores: Store[] = [];
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /**
   * One feature built in the source run (commit `source` over `base`),
   * reviewed on the source by an earlier reviewer, then a small revision
   * that changes only src/report.ts (commit `revision`). Extra files and a
   * changed rubric for the revision are options so each test names its
   * own deviation from this baseline.
   */
  const seed = async (options: {
    provider?: "claude" | "codex";
    extraSourceFiles?: Record<string, string | Buffer>;
    guardSource?: string;
    revisionFiles?: Record<string, string>;
    revisionRubric?: typeof RUBRIC;
    revisionBaseSha?: "base";
    priorJudgements?: { id: string; judgement: "upholds" | "contradicts" | "cannot-tell"; note: string }[];
    strict?: boolean;
  } = {}): Promise<Fixture> => {
    // realpath: runner repo membership is compared against the placed
    // path, and macOS's tmpdir is a symlink into /private.
    const repo = realpathSync(temp("so-ctx-repo-"));
    git(repo, "init", "-q", "-b", "main");
    const base = commitFiles(repo, { "README.md": "# fixture\n" }, "base");
    const source = commitFiles(
      repo,
      { "src/limit.ts": LIMIT_TS, "src/guard.ts": options.guardSource ?? GUARD_TS, "src/report.ts": REPORT_TS, ...(options.extraSourceFiles ?? {}) },
      "feature",
    );
    if (options.revisionBaseSha === "base") git(repo, "checkout", "-q", base);
    const revision = commitFiles(repo, options.revisionFiles ?? { "src/report.ts": REPORT_TS_V2 }, "revision");

    const store = openStore(":memory:");
    stores.push(store);
    const evidenceRoot = temp("so-ctx-evidence-");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    const provider = options.provider ?? "claude";
    const model = provider === "claude" ? "sonnet" : "gpt-5.6-sol";
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "repair", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", provider, model, "alex", T0);
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok-builder-1" });

    // The source task: signed rubric, approved, built at `source`.
    store.createTask({ id: "feat", title: "retry limiter" }, T0);
    const sourceTaskRef = store.refFor("built-in", "feat").id;
    store.placeTask(sourceTaskRef, repo);
    const sourceScope = propose(store, { taskId: "feat", goal: "cap retries", acceptance: RUBRIC, now: T0, ...(options.strict === true ? { qualityMode: "strict" as const } : {}) });
    const sourceSealed = approve(store, "feat", "alex", T0, sourceScope.digest, alex.token);
    if (!sourceSealed.ok) throw new Error(`approve feat: ${sourceSealed.reason}`);
    const sourceRun = store.startRun({ taskRef: sourceTaskRef, leaseId: "lease-src", runner: "builder-1", branch: "standing-orders/feat", worktree: repo, provider: "claude", model: "sonnet", now: T0, ...presented(store, sourceTaskRef) });
    store.stampRun(sourceRun, { scopeDigest: sourceSealed.scope.digest, baseRevision: base });
    const sourcePatch = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, source);
    const sourceDiffArtifact = storeEvidence(store, evidenceRoot, sourceRun, "terminal-diff", "terminal-diff.patch", Buffer.from(`${sourcePatch}\n`, "utf8"), `git diff ${base} ${source} (exit 0)`, T0, { captureStatus: "ok" });
    const numstat = execFileSync("git", ["diff", "--numstat", "-z", base, source], { cwd: repo, encoding: "utf8", env: GIT_ENV });
    storeEvidence(store, evidenceRoot, sourceRun, "diff-stat", "terminal-diff-stat.json", budgetedStatJson(parseNumstat(numstat, base, source)), `git diff --numstat -z ${base} ${source} (exit 0)`, T0, { captureStatus: "ok" });
    const sourceChanged = git(repo, "diff", "--name-only", base, source).split("\n").filter(one => one !== "");
    const sourceProof = {
      version: 1,
      criteria: [
        { id: "c1", statement: RUBRIC[0]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/limit.ts" }] },
        { id: "c2", statement: RUBRIC[1]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/guard.ts" }] },
        { id: "c3", statement: RUBRIC[2]!.statement, verdict: "met", how: "wrote it", evidence: [{ kind: "changed-path", ref: "src/report.ts" }] },
        { id: "c4", statement: RUBRIC[3]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }] },
      ],
      checks: [{ command: "npm test", exitCode: 0, summary: "all green" }],
      changed: sourceChanged,
      caveats: [],
      screenshots: [],
    };
    const sourceProofArtifact = storeEvidence(store, evidenceRoot, sourceRun, "proof", "proof.json", Buffer.from(JSON.stringify(sourceProof), "utf8"), "agent-authored proof (validated, re-serialized)", T0);
    store.recordOutcomeFacts(sourceRun, { headRevision: source, handoff: "capped retries" });
    store.finishRun(sourceRun, { outcome: "built", committed: true, now: T0 });

    // An earlier reviewer's judgements on the SOURCE run, bound exactly as
    // ingestReview binds them (head, scope, diff, proof).
    const prior = options.priorJudgements ?? [
      { id: "c1", judgement: "upholds", note: "limiter returns 3" },
      { id: "c2", judgement: "upholds", note: "guard refuses n >= 3" },
    ];
    if (prior.length > 0) {
      const asked = store.requestReview(sourceRun, "alex", T0);
      if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
      const priorReviewer = store.startRun({ taskRef: sourceTaskRef, leaseId: "review:prior", runner: "builder-1", role: "reviewer", parentRun: sourceRun, provider, model, now: T0, ...presented(store, sourceTaskRef, "reviewer", { provider, model }), request: asked.id });
      const diffRow = store.getArtifact(sourceDiffArtifact)!;
      const proofRow = store.getArtifact(sourceProofArtifact)!;
      for (const one of prior) {
        store.raw().prepare(
          `INSERT INTO criterion_review (reviewer_run, source_run, criterion_id, judgement, note, artifact, artifact_sha, author, created_at,
             scope_digest, head_sha, proof_artifact, proof_sha, check_log_artifact, check_log_sha, screenshots_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewer:claude·sonnet', ?, ?, ?, ?, ?, NULL, NULL, '[]')`,
        ).run(priorReviewer, sourceRun, one.id, one.judgement, one.note, diffRow.id, diffRow.sha256, T0.toISOString(), sourceSealed.scope.digest, source, proofRow.id, proofRow.sha256);
      }
      store.finishRun(priorReviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s), 2 judgement(s)", now: T0 });
    }

    // The revision: sealed through the real road with the source scope's
    // rubric (or a deliberately changed one), then approved and built at
    // `revision`.
    const brief = { schema: 1, sourceTask: "feat", sourceRun, sourceScopeDigest: store.getScope("feat")!.digest, head: source, diffArtifactSha: store.getArtifact(sourceDiffArtifact)!.sha256, comments: [] };
    const briefBytes = Buffer.from(JSON.stringify(brief), "utf8");
    const key = writeEvidenceFile(evidenceRoot, sourceRun, "revision-brief-fixture.json", briefBytes);
    const sealed = store.sealRevision(
      {
        source: { task: "feat", run: sourceRun, scopeDigest: store.getScope("feat")!.digest },
        brief: { evidenceRoot, key, bytes: briefBytes.length, sha256: createHash("sha256").update(briefBytes).digest("hex"), capture: "machine-authored revision brief (exit 0)" },
        child: { id: "feat-rev", title: "Revise feat", repair: "apply the annotations" },
        commentIds: null,
      },
      T0,
    );
    if (!sealed.ok) throw new Error(`sealRevision: ${sealed.reason}`);
    const revisionTaskId = sealed.id;
    const revisionTaskRef = store.refFor("built-in", revisionTaskId).id;
    if (options.strict === true || options.revisionRubric !== undefined) {
      const drafted = store.getScope(revisionTaskId)!;
      propose(store, { taskId: revisionTaskId, goal: drafted.goal, acceptance: options.revisionRubric ?? drafted.acceptance, qualityMode: options.strict ? "strict" : "default", now: T0 });
    }
    const revisionScope = store.getScope(revisionTaskId)!;
    const revisionSealed = approve(store, revisionTaskId, "alex", T0, revisionScope.digest, alex.token);
    if (!revisionSealed.ok) throw new Error(`approve revision: ${revisionSealed.reason}`);
    const revisionRun = store.startRun({ taskRef: revisionTaskRef, leaseId: "lease-rev", runner: "builder-1", branch: `standing-orders/${revisionTaskId}`, worktree: repo, provider: "claude", model: "sonnet", now: T0, ...presented(store, revisionTaskRef) });
    const revisionBase = options.revisionBaseSha === "base" ? base : source;
    store.stampRun(revisionRun, { scopeDigest: revisionSealed.scope.digest, baseRevision: revisionBase });
    const revisionPatch = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", revisionBase, revision);
    storeEvidence(store, evidenceRoot, revisionRun, "terminal-diff", "terminal-diff.patch", Buffer.from(`${revisionPatch}\n`, "utf8"), `git diff ${revisionBase} ${revision} (exit 0)`, T0, { captureStatus: "ok" });
    const revisionNumstat = execFileSync("git", ["diff", "--numstat", "-z", revisionBase, revision], { cwd: repo, encoding: "utf8", env: GIT_ENV });
    storeEvidence(store, evidenceRoot, revisionRun, "diff-stat", "terminal-diff-stat.json", budgetedStatJson(parseNumstat(revisionNumstat, revisionBase, revision)), `git diff --numstat -z ${revisionBase} ${revision} (exit 0)`, T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(revisionRun, { headRevision: revision, handoff: "revised the report" });
    store.finishRun(revisionRun, { outcome: "built", committed: true, now: T0 });

    return { repo, store, evidenceRoot, approverToken: alex.token, sourceTaskRef, sourceRun, sourceDiffArtifact, sourceProofArtifact, revisionTaskId, revisionTaskRef, revisionRun, shas: { base, source, revision } };
  };

  const patchPathsOf = (repo: string, from: string, to: string): Set<string> => new Set(git(repo, "diff", "--name-only", from, to).split("\n").filter(one => one !== ""));

  const capture = (f: Fixture, rubric = RUBRIC) =>
    captureReviewContext(f.store, exec, {
      runId: f.revisionRun,
      taskRef: f.revisionTaskRef,
      head: f.shas.revision,
      base: f.store.getRun(f.revisionRun)!.baseRevision,
      rubric: rubric.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      patchPaths: patchPathsOf(f.repo, f.store.getRun(f.revisionRun)!.baseRevision!, f.shas.revision),
      worktree: f.repo,
      root: f.evidenceRoot,
      now: () => T0,
    });

  /** Store the matrix a builder would save for the revision run, coverage attached. */
  const adjudicateRevision = (f: Fixture, inventory: ReviewContextInventory, rubric = RUBRIC): CriterionMatrixRow[] => {
    const proof = {
      version: 1,
      criteria: rubric.map(one => ({ id: one.id, statement: one.statement, verdict: "met", how: "see the revision", evidence: one.evidence.map(kind => ({ kind, ref: kind === "check" ? "npm test" : "src/report.ts" })) })),
      checks: [{ command: "npm test", exitCode: 0, summary: "green" }],
      changed: ["src/report.ts"],
      caveats: [],
      screenshots: [],
    };
    const { verdict, reasons, matrix } = adjudicate({
      proofArtifactPresent: true,
      proofParse: { ok: true, proof: proof as never },
      handoffPresent: true,
      terminalDiffPresent: true,
      terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths: new Set(["src/report.ts"]) },
      verifyCommand: { configured: false },
      screenshots: [],
      approvedCriteria: rubric.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      reviewContext: inventory.coverage,
    });
    f.store.saveProofVerdict(f.revisionRun, verdict, reasons, T0, matrix);
    return matrix;
  };

  test("c1: a small revision seals bounded source context for inherited criteria outside its patch, each item bound to source run, commit, path, and digest", async () => {
    const f = await seed();
    const captured = await capture(f);
    if (captured === null) throw new Error("expected an inventory for a revision");
    const { inventory, artifactId } = captured;

    expect(inventory.run).toBe(f.revisionRun);
    expect(inventory.head).toBe(f.shas.revision);
    expect(inventory.source).toMatchObject({ task: "feat", run: f.sourceRun, head: f.shas.source, verified: true, problems: [] });
    expect(inventory.ancestry.verified).toBe(true);

    // Every relevant source path is sealed at the EXACT revision head, with
    // git's own blob id and a SHA-256 of the stored bytes.
    const byPath = new Map(inventory.items.map(one => [one.path, one]));
    expect([...byPath.keys()].sort()).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
    for (const item of inventory.items) {
      expect(item.commit).toBe(f.shas.revision);
      expect(item.blob).toBe(git(f.repo, "rev-parse", `${f.shas.revision}:${item.path}`));
      expect(item.sha256).toBe(sha256(item.content));
      expect(item.bytes).toBe(Buffer.byteLength(item.content, "utf8"));
      expect(item.sourceRun).toBe(f.sourceRun);
      expect(item.redacted).toBe(false);
    }
    expect(byPath.get("src/limit.ts")).toMatchObject({ content: LIMIT_TS, criteria: ["c1", "c4"], why: ["source-changed-path", "source-criterion-evidence"], unchangedSinceSource: true });
    expect(byPath.get("src/guard.ts")).toMatchObject({ content: GUARD_TS, criteria: ["c2", "c4"], unchangedSinceSource: true });
    expect(byPath.get("src/report.ts")).toMatchObject({ content: REPORT_TS_V2, criteria: ["c3", "c4"], unchangedSinceSource: false });
    expect(inventory.gaps).toEqual([]);

    // Coverage: c1/c2 inherited from sealed context; c3 is in the patch;
    // c4 covers every changed path of the source build.
    const coverage = new Map(inventory.coverage.map(one => [one.id, one]));
    expect(coverage.get("c1")).toMatchObject({ state: "context", inherited: true, paths: ["src/limit.ts"], items: [byPath.get("src/limit.ts")!.id], gaps: [], priorSupport: "eligible" });
    expect(coverage.get("c2")).toMatchObject({ state: "context", inherited: true, paths: ["src/guard.ts"], priorSupport: "eligible" });
    expect(coverage.get("c3")).toMatchObject({ state: "patch", inherited: true, priorSupport: "none" });
    expect(coverage.get("c4")).toMatchObject({ state: "context", inherited: true, paths: ["src/guard.ts", "src/limit.ts", "src/report.ts"], priorSupport: "none" });

    // Prior review provenance is carried with its proof, never as a verdict.
    expect(inventory.priorReview.map(one => [one.criterionId, one.support, one.judgement])).toEqual([["c1", "eligible", "upholds"], ["c2", "eligible", "upholds"]]);
    expect(inventory.priorReview[0]).toMatchObject({ sourceRun: f.sourceRun, statementMatches: true, ancestryVerified: true, relevantUnchanged: true, bindingsVerified: true, reasons: [] });

    // The stored artifact verifies and round-trips through the strict reader.
    const artifact = f.store.getArtifact(artifactId)!;
    expect(artifact).toMatchObject({ kind: "review-context", truncated: false, captureStatus: "ok", redacted: false });
    const verified = readVerifiedArtifact(f.evidenceRoot, artifact);
    if (!verified.ok) throw new Error(verified.problem);
    const parsed = parseReviewContext(verified.content.toString("utf8"));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.inventory).toEqual(inventory);
    expect(serializeReviewContext(parsed.inventory)).toBe(verified.content.toString("utf8"));
    expect(f.store.revisionSourceOf(f.revisionTaskRef)).toMatchObject({ sourceTask: "feat", sourceRun: f.sourceRun });

    // The matrix rows carry the coverage; nothing about the verdict moved.
    const matrix = adjudicateRevision(f, inventory);
    expect(matrix.map(row => row.coverage?.state)).toEqual(["context", "context", "patch", "context"]);
    expect(matrix.find(row => row.id === "c1")?.coverage?.items).toEqual([byPath.get("src/limit.ts")!.id]);
  });

  test("an ordinary (non-revision) run captures no inventory and adjudicates exactly as before", async () => {
    const f = await seed();
    const captured = await captureReviewContext(f.store, exec, {
      runId: f.sourceRun, taskRef: f.sourceTaskRef, head: f.shas.source, base: f.shas.base,
      rubric: RUBRIC.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      patchPaths: new Set(), worktree: f.repo, root: f.evidenceRoot, now: () => T0,
    });
    expect(captured).toBeNull();
    expect(f.store.artifactsFor(f.sourceRun).some(one => one.kind === "review-context")).toBe(false);
    const { matrix } = adjudicate({ proofArtifactPresent: false, proofParse: null, handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok", diffStat: null, verifyCommand: { configured: false }, screenshots: [], approvedCriteria: [{ id: "c1", statement: "x", evidence: ["check"] }] });
    expect(matrix[0]).not.toHaveProperty("coverage");
  });

  describe("c2: invalidation and explicit gaps", () => {
    test("changed criterion text invalidates prior support and is a named gap — never an inherited verdict", async () => {
      const changed = RUBRIC.map(one => (one.id === "c2" ? { ...one, statement: "The guard refuses a THIRD attempt." } : one));
      const f = await seed({ revisionRubric: changed });
      const inventory = (await capture(f, changed))!.inventory;
      const c2 = inventory.coverage.find(one => one.id === "c2")!;
      expect(c2).toMatchObject({ inherited: false, state: "gap", priorSupport: "invalid" });
      expect(c2.gaps.join(" ")).toMatch(/reads differently now/);
      expect(inventory.gaps.some(one => one.reason === "criterion-changed" && one.criteria.includes("c2"))).toBe(true);
      const prior = inventory.priorReview.find(one => one.criterionId === "c2")!;
      expect(prior).toMatchObject({ support: "invalid", statementMatches: false });
      expect(prior.reasons).toContain("the criterion's signed text changed since the source review");
      // c1 is untouched by the change and still fully supported.
      expect(inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", priorSupport: "eligible" });
    });

    test("changed relevant code moves the criterion into the patch and invalidates the earlier judgement", async () => {
      const f = await seed({ revisionFiles: { "src/report.ts": REPORT_TS_V2, "src/guard.ts": "export function guard(n: number): boolean {\n  return n < 2;\n}\n" } });
      const inventory = (await capture(f))!.inventory;
      const guard = inventory.items.find(one => one.path === "src/guard.ts")!;
      expect(guard.unchangedSinceSource).toBe(false);
      expect(guard.commit).toBe(f.shas.revision);
      expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "patch", inherited: true, priorSupport: "invalid" });
      const prior = inventory.priorReview.find(one => one.criterionId === "c2")!;
      expect(prior.support).toBe("invalid");
      expect(prior.reasons.join(" ")).toMatch(/not byte-identical/);
      expect(inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", priorSupport: "eligible" });
    });

    test("stale ancestry: a head that does not descend from the source head invalidates every inherited support and gaps every inherited criterion", async () => {
      const f = await seed({ revisionBaseSha: "base", revisionFiles: { "src/report.ts": REPORT_TS_V2 } });
      const inventory = (await capture(f))!.inventory;
      expect(inventory.ancestry.verified).toBe(false);
      expect(inventory.ancestry.detail).toMatch(/not an ancestor/);
      expect(inventory.gaps.some(one => one.reason === "stale-ancestry")).toBe(true);
      for (const id of ["c1", "c2"]) {
        expect(inventory.coverage.find(one => one.id === id)).toMatchObject({ state: "gap", priorSupport: "invalid" });
      }
      for (const prior of inventory.priorReview) {
        expect(prior).toMatchObject({ support: "invalid", ancestryVerified: false });
      }
      // Items that do not exist at this head are gaps, never guesses.
      expect(inventory.gaps.some(one => one.reason === "missing-at-head" && one.path === "src/limit.ts")).toBe(true);
      expect(inventory.items.every(one => one.unchangedSinceSource === null)).toBe(true);
    });

    test("a tampered ancestor proof is unverified: the source is not trusted, prior support is invalid, and inherited criteria are gaps", async () => {
      const f = await seed();
      const proof = f.store.getArtifact(f.sourceProofArtifact)!;
      writeFileSync(join(f.evidenceRoot, proof.key), JSON.stringify({ version: 1, criteria: [], changed: ["src/evil.ts"] }));
      const inventory = (await capture(f))!.inventory;
      expect(inventory.source.verified).toBe(false);
      expect(inventory.source.problems.join(" ")).toMatch(/proof no longer verifies/);
      expect(inventory.gaps.some(one => one.reason === "source-proof-missing")).toBe(true);
      // The verified diff-stat still names the source's changed paths, so
      // items are sealed — but without the proof nothing binds a path to a
      // criterion, and every inherited criterion is a gap, not context.
      expect(inventory.items.every(one => one.why.includes("source-changed-path") && !one.why.includes("source-criterion-evidence"))).toBe(true);
      for (const id of ["c1", "c2"]) expect(inventory.coverage.find(one => one.id === id)?.state).toBe("gap");
      expect(inventory.coverage.find(one => one.id === "c1")?.gaps.join(" ")).toMatch(/proof no longer verifies/);
      expect(inventory.priorReview.every(one => one.support === "invalid" && one.reasons.includes("the source run's sealed artifacts do not all verify"))).toBe(true);
    });

    test("an unproven ancestor (no sealed head) supplies no ancestry and no eligible support", async () => {
      const f = await seed();
      f.store.raw().prepare("UPDATE run SET head_revision = NULL WHERE id = ?").run(f.sourceRun);
      const inventory = (await capture(f))!.inventory;
      expect(inventory.source.head).toBeNull();
      expect(inventory.ancestry.verified).toBe(false);
      expect(inventory.priorReview.every(one => one.support === "invalid")).toBe(true);
      for (const id of ["c1", "c2"]) expect(inventory.coverage.find(one => one.id === id)?.state).toBe("gap");
      // Touching one path cannot hide missing ancestry for the others.
      expect(inventory.coverage.find(one => one.id === "c4")).toMatchObject({ state: "gap", gaps: expect.arrayContaining([expect.stringMatching(/no sealed head/)]) });
    });

    test("byte limits, binaries, and secrets are honest gaps: oversized and binary paths are never truncated, and a redacted item cannot support its criterion", async () => {
      const big = `// big\n${"x".repeat(REVIEW_CONTEXT_LIMITS.itemBytes + 1)}\n`;
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const f = await seed({
        extraSourceFiles: { "src/big.ts": big, "assets/dot.png": png },
        guardSource: `${GUARD_TS}// token: AKIAABCDEFGHIJKLMNOP\n`,
      });
      const inventory = (await capture(f))!.inventory;
      const reasons = new Map(inventory.gaps.map(one => [`${one.reason}:${one.path}`, one]));
      expect(reasons.get("over-limit:src/big.ts")?.detail).toMatch(/exceeds the .*item limit/);
      expect(reasons.get("binary:assets/dot.png")?.detail).toMatch(/not UTF-8 text/);
      expect(reasons.get("secret-redacted:src/guard.ts")?.criteria).toEqual(["c2", "c4"]);
      expect(inventory.items.some(one => one.path === "src/big.ts" || one.path === "assets/dot.png")).toBe(false);
      const guard = inventory.items.find(one => one.path === "src/guard.ts")!;
      expect(guard.redacted).toBe(true);
      expect(guard.content).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(guard.content).toContain("[redacted: aws-access-key");
      expect(guard.sha256).toBe(sha256(guard.content));
      expect(inventory.items.reduce((sum, one) => sum + one.bytes, 0)).toBeLessThanOrEqual(REVIEW_CONTEXT_LIMITS.aggregateBytes);
      // c2's only relevant path is redacted — a gap; c4 spans the oversized
      // and binary paths (named on its row even though the patch touches
      // one of its paths); c1 is untouched — still sealed context.
      expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "gap", items: [guard.id] });
      expect(inventory.coverage.find(one => one.id === "c4")?.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/src\/big\.ts: .*item limit/), expect.stringMatching(/assets\/dot\.png: not UTF-8/)]));
      expect(inventory.coverage.find(one => one.id === "c1")?.state).toBe("context");
      const artifact = f.store.artifactsFor(f.revisionRun).find(one => one.kind === "review-context")!;
      expect(artifact.redacted).toBe(true);
    });

    test("the strict reader refuses an inventory whose item bytes no longer hash, and one that claims eligibility without proof", async () => {
      const f = await seed();
      const inventory = (await capture(f))!.inventory;
      const forged = JSON.parse(serializeReviewContext(inventory)) as { items: { content: string; bytes: number }[]; priorReview: Record<string, unknown>[] };
      forged.items[0]!.content += "\n// edited after sealing";
      expect(parseReviewContext(JSON.stringify(forged))).toMatchObject({ ok: false, problem: expect.stringMatching(/bytes must equal/) });
      forged.items[0]!.bytes = Buffer.byteLength(forged.items[0]!.content, "utf8");
      expect(parseReviewContext(JSON.stringify(forged))).toMatchObject({ ok: false, problem: expect.stringMatching(/sha256 does not match/) });
      const liar = JSON.parse(serializeReviewContext(inventory)) as { priorReview: Record<string, unknown>[] };
      liar.priorReview[0]!["ancestryVerified"] = false;
      expect(parseReviewContext(JSON.stringify(liar))).toMatchObject({ ok: false, problem: expect.stringMatching(/claims eligibility/) });
      expect(parseReviewContext("nope")).toMatchObject({ ok: false });
    });
  });

  test("a second revision retains grandparent paths and re-captures them at its own head", async () => {
    const f = await seed();
    await capture(f);
    const proof = JSON.parse(readFileSync(join(f.evidenceRoot, f.store.getArtifact(f.sourceProofArtifact)!.key), "utf8"));
    proof.changed = ["src/report.ts"];
    for (const criterion of proof.criteria) criterion.evidence = [{ kind: "check", ref: "npm test" }];
    storeEvidence(f.store, f.evidenceRoot, f.revisionRun, "proof", "proof.json", Buffer.from(JSON.stringify(proof)), "proof", T0);
    const brief = Buffer.from(JSON.stringify({ schema: 1, sourceTask: f.revisionTaskId, sourceRun: f.revisionRun, sourceScopeDigest: f.store.getScope(f.revisionTaskId)!.digest, head: f.shas.revision, comments: [] }));
    const key = writeEvidenceFile(f.evidenceRoot, f.revisionRun, "next-brief.json", brief);
    const child = f.store.sealRevision({ source: { task: f.revisionTaskId, run: f.revisionRun, scopeDigest: f.store.getScope(f.revisionTaskId)!.digest }, brief: { evidenceRoot: f.evidenceRoot, key, bytes: brief.length, sha256: sha256(brief), capture: "revision brief" }, child: { id: "second-revision", title: "Next report", repair: "rename report" }, commentIds: null }, T0);
    if (!child.ok) throw new Error(child.reason);
    const ref = f.store.refFor("built-in", child.id).id;
    const scope = approve(f.store, child.id, "alex", T0, f.store.getScope(child.id)!.digest, f.approverToken);
    if (!scope.ok) throw new Error(scope.reason);
    const head = commitFiles(f.repo, { "src/report.ts": REPORT_TS_V2 + "// next revision\n" }, "next revision");
    const run = f.store.startRun({ taskRef: ref, leaseId: "next", runner: "builder-1", branch: "next", worktree: f.repo, provider: "claude", model: "sonnet", now: T0, ...presented(f.store, ref) });
    f.store.stampRun(run, { scopeDigest: scope.scope.digest, baseRevision: f.shas.revision });
    f.store.recordOutcomeFacts(run, { headRevision: head });
    f.store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    const captured = await captureReviewContext(f.store, exec, { runId: run, taskRef: ref, head, base: f.shas.revision, rubric: RUBRIC, patchPaths: new Set(["src/report.ts"]), worktree: f.repo, root: f.evidenceRoot, now: () => T0 });
    expect(captured?.inventory.bindings?.map(one => one.run)).toEqual([f.sourceRun, f.revisionRun]);
    expect(captured?.inventory.items.find(one => one.path === "src/limit.ts")).toMatchObject({ commit: head, content: LIMIT_TS, criteria: expect.arrayContaining(["c1"]) });
    expect(captured?.inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", paths: ["src/limit.ts"], gaps: [] });
  });

  test("a changed evidence requirement invalidates a previous judgement even with identical criterion text", async () => {
    const rubric = RUBRIC.map(one => one.id === "c1" ? { ...one, evidence: ["manual-review"] as never } : one);
    const f = await seed({ revisionRubric: rubric });
    const captured = await capture(f, rubric);
    expect(captured?.inventory.priorReview.find(one => one.criterionId === "c1")).toMatchObject({ statementMatches: false, support: "invalid" });
  });

  test("context paths are literal and blob bytes must agree with their Git identity", async () => {
    const f = await seed({ extraSourceFiles: { "src/a[1].ts": "literal\n", "src/a1.ts": "pattern\n" } });
    const good = await capture(f);
    expect(good?.inventory.items.find(one => one.path === "src/a[1].ts")?.content).toBe("literal\n");
    const forged = structuredClone(good!.inventory);
    const item = forged.items[0]!;
    item.blob = "a".repeat(40);
    expect(parseReviewContext(serializeReviewContext(forged))).toMatchObject({ ok: false, problem: expect.stringContaining("blob identity") });
  });

  describe("c3 and c4: the reviewer pass over a revision", () => {
    let scratchRoot: string;
    beforeEach(() => {
      scratchRoot = temp("so-ctx-scratch-");
    });

    /** Seal the inventory and the matrix the builder would have stored, then ask for a review. */
    const readyForReview = async (options: Parameters<typeof seed>[0] = {}) => {
      const f = await seed(options);
      const captured = (await capture(f))!;
      adjudicateRevision(f, captured.inventory);
      const asked = f.store.requestReview(f.revisionRun, "alex", T0);
      if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
      return { ...f, inventory: captured.inventory, contextArtifact: captured.artifactId };
    };
    const passOnce = (f: Fixture, agent: Runner) =>
      reviewPass(f.store, { runner: "builder-1", token: "tok-builder-1", now: T0, evidenceRoot: f.evidenceRoot, scratchRoot, agent });
    const judgements = (c1: { judgement: string; note: string }, rest: { judgement: string; note: string } = { judgement: "cannot-tell", note: "not settled by the sealed files" }) => [
      { id: "c1", ...c1 },
      { id: "c2", ...rest },
      { id: "c3", judgement: "upholds", note: "src/report.ts now names the outcome" },
      { id: "c4", ...rest },
    ];

    test("Claude reads REVIEW-CONTEXT.json from the sealed scratch, cites ctx-<n> provenance for an inherited criterion, and the judgement binds the context artifact at ingestion", async () => {
      const f = await readyForReview();
      let sealedBytes: Buffer | null = null;
      let prompt = "";
      const agent: Runner = async (_file, args, options) => {
        const cwd = options?.cwd ?? "";
        sealedBytes = readFileSync(join(cwd, REVIEW_CONTEXT_NAME));
        prompt = String(args[args.indexOf("-p") + 1] ?? "");
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: `${f.inventory.items.find(one => one.path === "src/limit.ts")!.id} (src/limit.ts at the sealed head) returns 3` }) }) };
      };
      const reports = await passOnce(f, agent);
      expect(reports[0]).toMatchObject({ outcome: "reviewed", attempt: 1, detail: "0 comment(s), 4 judgement(s)" });
      expect(sealedBytes).not.toBeNull();
      const artifact = f.store.getArtifact(f.contextArtifact)!;
      expect(sha256(sealedBytes!)).toBe(artifact.sha256);
      expect(prompt).toContain("REVISES an earlier build");
      expect(prompt).toContain(`c1: inherited — sealed context ${f.inventory.items.find(one => one.path === "src/limit.ts")!.id}`);
      expect(prompt).toContain("context, never your answer");
      expect(prompt).toContain("MUST cite the provenance");
      const saved = f.store.criterionReviewsFor(f.revisionRun);
      expect(saved).toHaveLength(4);
      for (const row of saved) expect(row.context).toEqual({ artifact: artifact.id, sha256: artifact.sha256 });
      // The fold keeps the coverage on every row; the verdict never rises.
      const verdict = f.store.proofVerdictFor(f.revisionRun)!;
      expect(verdict.matrix.find(row => row.id === "c1")).toMatchObject({ review: { judgement: "upholds" }, coverage: { state: "context", items: [f.inventory.items.find(one => one.path === "src/limit.ts")!.id] } });
      expect(verdict.matrix.find(row => row.id === "c2")).toMatchObject({ review: { judgement: "cannot-tell" }, coverage: { state: "context" } });
    });

    test("c4: Codex receives byte-identical sealed context inline, with the same provenance, under the same aggregate limit", async () => {
      const f = await readyForReview({ provider: "codex" });
      let inlineContext: { name: string; sha256: string; content: string } | undefined;
      const agent: Runner = async (_file, args, options) => {
        expect(args).toEqual(expect.arrayContaining(["features.shell_tool=false", "features.unified_exec=false"]));
        const promptText = options?.stdin ?? "";
        const encoded = promptText.split("\n").find(line => line.startsWith('[{"name":"REVIEW-DIFF.patch"'));
        const bundle = JSON.parse(encoded!) as { name: string; sha256: string; content: string }[];
        expect(bundle.map(one => one.name)).toEqual([REVIEW_PATCH_NAME, REVIEW_RUBRIC_NAME, REVIEW_CONTEXT_NAME]);
        inlineContext = bundle.find(one => one.name === REVIEW_CONTEXT_NAME);
        for (const one of bundle) expect(one.content).toBe(readFileSync(join(options!.cwd!, one.name), "utf8"));
        expect(promptText).toContain("MUST cite the provenance");
        const answer = JSON.stringify({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: `${f.inventory.items.find(one => one.path === "src/limit.ts")!.id} shows limiter() returning 3` }) });
        return { ...OK, stdout: [
          { type: "thread.started", thread_id: "codex-ctx-fixture" },
          { type: "item.completed", item: { type: "agent_message", text: answer } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } },
        ].map(one => JSON.stringify(one)).join("\n") };
      };
      const reports = await passOnce(f, agent);
      expect(reports[0]?.outcome).toBe("reviewed");
      const artifact = f.store.getArtifact(f.contextArtifact)!;
      // The inline bytes ARE the artifact bytes — the same content and the
      // same provenance a file-reading reviewer is sealed.
      expect(inlineContext?.sha256).toBe(artifact.sha256);
      expect(sha256(inlineContext!.content)).toBe(artifact.sha256);
      expect(parseReviewContext(inlineContext!.content)).toMatchObject({ ok: true, inventory: f.inventory });
      expect(f.store.criterionReviewsFor(f.revisionRun).every(row => row.context?.sha256 === artifact.sha256)).toBe(true);
      expect(f.store.criterionReviewsFor(f.revisionRun)[0]?.author).toBe("reviewer:codex·gpt-5.6-sol");
    });

    test("an upholds on an inherited criterion that cites no supplied provenance is refused, the attempt is preserved as failed, and explicit retries remain", async () => {
      const f = await readyForReview();
      const reports = await passOnce(f, async () => ({ ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: "looks fine to me" }) }) }));
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "malformed-review", attempt: 1, retriesRemaining: 2 });
      expect(f.store.criterionReviewsFor(f.revisionRun)).toEqual([]);
      const retry = f.store.reviewRetryStateOf(f.revisionRun)!;
      expect(retry.state).toBe("retryable");
      expect(retry.attempts[0]).toMatchObject({ attempt: 1, outcome: "failed", reason: expect.stringMatching(/must cite supplied provenance/) });
      // The failed root is on record; a second explicit ask opens attempt 2.
      const again = f.store.requestReview(f.revisionRun, "alex", T0);
      expect(again).toMatchObject({ ok: true, attempt: 2 });
    });

    test("the parser rules: a contradicts may cite a patch path or a sealed file, cannot-tell needs nothing, and a patch criterion is unchanged", async () => {
      const f = await readyForReview();
      const rules = { ...reviewContextRules(f.inventory), sealedFiles: new Set(["REVIEW-CHECK-LOG.txt"]) };
      const patchPaths = new Set(["src/report.ts"]);
      const ids = new Set(["c1", "c2", "c3", "c4"]);
      expect(rules.provenanceRequired).toEqual(new Set(["c1", "c2", "c4"]));
      const parse = (criteria: { id: string; judgement: string; note: string }[]) => parseReview(JSON.stringify({ version: 1, comments: [], criteria }), patchPaths, ids, rules);
      expect(parse(judgements({ judgement: "contradicts", note: "src/report.ts drops the cap" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "contradicts", note: "REVIEW-CHECK-LOG.txt shows the retry test failing" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "cannot-tell", note: "nothing sealed settles it" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "upholds", note: "ctx-9 says so" })).ok).toBe(false);
      expect(parse(judgements({ judgement: "upholds", note: "ctx-1 says so" })).ok).toBe(true);
      // Only c3 is fully represented by the patch.
      expect(parse([{ id: "c1", judgement: "cannot-tell", note: "unsettled" }, { id: "c2", judgement: "cannot-tell", note: "unsettled" }, { id: "c3", judgement: "upholds", note: "fine" }, { id: "c4", judgement: "contradicts", note: "REVIEW-CHECK-LOG.txt shows the gate is red" }]).ok).toBe(true);
      expect(parse([{ id: "c1", judgement: "cannot-tell", note: "unsettled" }, { id: "c2", judgement: "upholds", note: "fine" }, { id: "c3", judgement: "upholds", note: "fine" }, { id: "c4", judgement: "upholds", note: "fine" }])).toMatchObject({ ok: false, problems: expect.arrayContaining([{ reason: expect.stringMatching(/"c2" is outside the reviewed patch/) }]) });
      expect(citesSuppliedProvenance("see ctx-12", { itemIds: new Set(["ctx-1"]), patchPaths: new Set(), sealedFiles: new Set() })).toBe(false);
    });

    test("c3: scratch tamper of the sealed context after the agent ran refuses the whole pass and preserves the failed attempt", async () => {
      const f = await readyForReview();
      const reports = await passOnce(f, async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        const forged = JSON.parse(readFileSync(join(cwd, REVIEW_CONTEXT_NAME), "utf8"));
        forged.items[0].content += "\n// planted";
        writeFileSync(join(cwd, REVIEW_CONTEXT_NAME), JSON.stringify(forged, null, 1));
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: "ctx-2 returns 3" }) }) };
      });
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "dirty-scratch", attempt: 1 });
      expect(f.store.criterionReviewsFor(f.revisionRun)).toEqual([]);
      expect(f.store.reviewRetryStateOf(f.revisionRun)?.attempts[0]).toMatchObject({ outcome: "failed", reason: "reviewer-dirty-scratch" });
    });

    test("c3: the inventory is re-verified before spend — a tampered artifact file refuses before any agent runs", async () => {
      const f = await readyForReview();
      const artifact = f.store.getArtifact(f.contextArtifact)!;
      writeFileSync(join(f.evidenceRoot, artifact.key), serializeReviewContext({ ...f.inventory, items: [] }));
      let calls = 0;
      const reports = await passOnce(f, async () => { calls++; return { ...OK, stdout: spoken({ version: 1, comments: [] }) }; });
      expect(calls).toBe(0);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "evidence", attempt: 1, retriesRemaining: 2 });
      expect(f.store.reviewRetryStateOf(f.revisionRun)?.attempts[0]).toMatchObject({ outcome: "failed", reason: "reviewer-evidence" });
    });

    test("c3: missing revision context refuses before spend, and removed context refuses at ingestion", async () => {
      const added = await readyForReview();
      added.store.raw().prepare("DELETE FROM artifact WHERE id = ?").run(added.contextArtifact);
      let calls = 0;
      const addedReports = await passOnce(added, async () => {
        calls++;
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      });
      expect(calls).toBe(0);
      expect(addedReports[0]).toMatchObject({ outcome: "failed", detail: "evidence" });
      expect(added.store.criterionReviewsFor(added.revisionRun)).toEqual([]);

      // Removed: the inventory the reviewer was sealed disappears before ingest.
      const removed = await readyForReview();
      const removedReports = await passOnce(removed, async () => {
        removed.store.raw().prepare("DELETE FROM artifact WHERE id = ?").run(removed.contextArtifact);
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: "ctx-2 returns 3" }) }) };
      });
      expect(removedReports[0]).toMatchObject({ outcome: "failed", detail: "stale-evidence", attempt: 1, retriesRemaining: 2 });
      expect(removed.store.criterionReviewsFor(removed.revisionRun)).toEqual([]);
      expect(removed.store.getRun(removed.store.reviewRetryStateOf(removed.revisionRun)!.attempts[0]!.runId)?.outcome).toBe("failed");
    });

    test("an unrelated context item cannot justify an inherited criterion", async () => {
      const f = await readyForReview();
      const guard = f.inventory.items.find(one => one.path === "src/guard.ts")!;
      const reports = await passOnce(f, async () => ({ ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: `${guard.id} proves the limiter` }) }) }));
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "malformed-review" });
      expect(f.store.criterionReviewsFor(f.revisionRun)).toEqual([]);
    });

    test.each(["check-log", "screenshot", "proof-bytes", "reviewer-lineage"] as const)("source %s changes while the reviewer runs refuse atomic ingestion", async kind => {
      const f = await readyForReview();
      const reports = await passOnce(f, async () => {
        if (kind === "proof-bytes") writeFileSync(join(f.evidenceRoot, f.store.getArtifact(f.sourceProofArtifact)!.key), "tampered");
        else if (kind === "reviewer-lineage") {
          const reviewer = f.store.criterionReviewsFor(f.sourceRun)[0]!.reviewerRun;
          f.store.raw().prepare("UPDATE run SET parent_run = NULL WHERE id = ?").run(reviewer);
        } else storeEvidence(f.store, f.evidenceRoot, f.sourceRun, kind, `late-${kind}`, Buffer.from("late evidence"), "late", T0, { captureStatus: "ok" });
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: judgements({ judgement: "upholds", note: `${f.inventory.items.find(one => one.path === "src/limit.ts")!.id} returns 3` }) }) };
      });
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "stale-evidence" });
      expect(f.store.criterionReviewsFor(f.revisionRun)).toEqual([]);
    });

    test("source evidence drift after capture refuses before provider spend", async () => {
      const f = await readyForReview();
      storeEvidence(f.store, f.evidenceRoot, f.sourceRun, "check-log", "late-log", Buffer.from("late"), "late", T0);
      let calls = 0;
      const reports = await passOnce(f, async () => { calls++; return OK; });
      expect(calls).toBe(0);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "evidence" });
    });

    test("c4: reviewer isolation and retry bounds are untouched — a second inventory is ambiguous and refused, and three failed roots exhaust the allowance", async () => {
      const f = await readyForReview();
      storeEvidence(f.store, f.evidenceRoot, f.revisionRun, "review-context", "review-context-2.json", Buffer.from(serializeReviewContext(f.inventory), "utf8"), "dup", T0, { captureStatus: "ok" });
      let calls = 0;
      const first = await passOnce(f, async () => { calls++; return { ...OK, stdout: spoken({ version: 1, comments: [] }) }; });
      expect(calls).toBe(0);
      expect(first[0]).toMatchObject({ outcome: "failed", detail: "evidence", attempt: 1, retriesRemaining: 2 });
      for (const attempt of [2, 3]) {
        expect(f.store.requestReview(f.revisionRun, "alex", T0)).toMatchObject({ ok: true, attempt });
        const again = await passOnce(f, async () => ({ ...OK, stdout: spoken({ version: 1, comments: [] }) }));
        expect(again[0]).toMatchObject({ outcome: "failed", attempt, retriesRemaining: 3 - attempt });
      }
      expect(f.store.requestReview(f.revisionRun, "alex", T0)).toMatchObject({ ok: false, reason: "retries-exhausted" });
      expect(f.store.reviewRetryStateOf(f.revisionRun)?.state).toBe("exhausted");
      expect(f.store.reviewRetryStateOf(f.revisionRun)?.attempts.map(one => one.outcome)).toEqual(["failed", "failed", "failed"]);
    });
  });

  describe("c5: semantic coverage on every surface", () => {
    const rows = (judged: Record<string, "upholds" | "contradicts" | "cannot-tell" | null>, coverageOf: Record<string, "patch" | "context" | "gap">): CriterionMatrixRow[] =>
      Object.keys(coverageOf).map(id => ({
        id,
        statement: `criterion ${id}`,
        requiredEvidence: ["check"],
        state: "pass",
        detail: [],
        answered: [{ kind: "check", ref: "npm test" }],
        review: judged[id] === null || judged[id] === undefined ? null : { judgement: judged[id]!, note: `note ${id}`, author: "reviewer:claude" },
        coverage: { state: coverageOf[id]!, inherited: coverageOf[id] !== "patch", items: coverageOf[id] === "context" ? ["ctx-1"] : [], gaps: coverageOf[id] === "gap" ? ["src/limit.ts: 60000 bytes exceeds the item limit"] : [], priorSupport: "none" },
      }));

    test("cannot-tell never satisfies required coverage under strict; under default the same review is optional and says so", () => {
      const matrix = rows({ c1: "upholds", c2: "cannot-tell", c3: "upholds" }, { c1: "context", c2: "gap", c3: "patch" });
      const strict = semanticCoverage(matrix, "strict");
      expect(strict).toMatchObject({ policy: "strict", required: true, upheld: ["c1", "c3"], uncertain: ["c2"], satisfied: false, contextGaps: [{ id: "c2", gaps: ["src/limit.ts: 60000 bytes exceeds the item limit"] }] });
      expect(coverageWords(strict)[0]).toMatch(/2\/3 upheld .* required under strict quality — NOT satisfied \(cannot-tell never counts: c2\)/);
      expect(coverageWords(strict)[1]).toBe("context gap c2: src/limit.ts: 60000 bytes exceeds the item limit");
      const lax = semanticCoverage(matrix, "default");
      expect(lax).toMatchObject({ policy: "default", required: false, satisfied: false });
      expect(coverageWords(lax)[0]).toMatch(/optional under default quality — 2\/3 upheld, cannot-tell: c2/);
      // All upheld satisfies both; nothing reviewed is unsettled, not satisfied.
      expect(semanticCoverage(rows({ c1: "upholds" }, { c1: "context" }), "strict")).toMatchObject({ satisfied: true });
      expect(semanticCoverage(rows({ c1: null }, { c1: "context" }), "strict")).toMatchObject({ satisfied: null, unreviewed: ["c1"] });
      expect(coverageWords(semanticCoverage(rows({ c1: null }, { c1: "context" }), "strict"))[0]).toMatch(/no independent review has settled yet/);
      expect(coverageWords(semanticCoverage([], "strict"))).toEqual([]);
      // The fold preserves coverage rows and still never raises a verdict.
      const folded = foldReview({ verdict: "short", reasons: ["x"], matrix: rows({ c1: null }, { c1: "gap" }) }, [{ id: "c1", judgement: "upholds", note: "ctx-1", author: "reviewer:codex" }]);
      expect(folded.verdict).toBe("short");
      expect(folded.matrix[0]?.coverage?.state).toBe("gap");
    });

    test("the CLI matrix words name each criterion's context standing, including gaps", () => {
      const lines = matrixWords(rows({ c1: "upholds", c2: "cannot-tell" }, { c1: "context", c2: "gap" }));
      expect(lines).toContain("      context: inherited — sealed context ctx-1");
      expect(lines.some(line => line.startsWith("      context: GAP — inherited context is missing: src/limit.ts: 60000 bytes"))).toBe(true);
    });
  });

  test("schema v51: a v50 file widens artifact.kind for review-context and adds the criterion_review binding columns without touching a historical row", () => {
    const dir = temp("so-ctx-v51-");
    const file = join(dir, "orders.db");
    const store = openStore(file);
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t");
    store.placeTask(ref.id, "/repo");
    const run = store.startRun({ taskRef: ref.id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const first = store.saveArtifact({ run, kind: "proof", key: `${run}/proof.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "historical", capture: "historical", captureStatus: "ok" }, T0);
    const raw = store.raw();
    const V50_ARTIFACT = `CREATE TABLE artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot','structured-output')),
  key TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  capture TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
)`;
    const V50_CRITERION_REVIEW = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'criterion_review'").get()?.["sql"])
      .replace(/,\s*(--[^\n]*\n\s*)*context_artifact\s+INTEGER,\s*context_sha\s+TEXT/s, "");
    expect(V50_CRITERION_REVIEW).not.toContain("context_");
    raw.exec(`PRAGMA foreign_keys = OFF; CREATE TABLE artifact_copy AS SELECT * FROM artifact; DROP TABLE artifact; ${V50_ARTIFACT}; INSERT INTO artifact SELECT * FROM artifact_copy; DROP TABLE artifact_copy;
      DROP TABLE criterion_review; ${V50_CRITERION_REVIEW}; PRAGMA foreign_keys = ON;`);
    const before = raw.prepare("SELECT * FROM artifact ORDER BY id").all();
    expect(() => raw.prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?, 'review-context', ?, 1, 1, 'x', 'x', ?)").run(run, `${run}/rc.json`, T0.toISOString())).toThrow();
    raw.prepare("UPDATE schema_version SET version = 50").run();
    store.close();

    const upgraded = openStore(file);
    stores.push(upgraded);
    expect(Number(upgraded.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(upgraded.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(before);
    expect(upgraded.getArtifact(first)).toMatchObject({ kind: "proof", sha256: "historical" });
    const added = upgraded.saveArtifact({ run, kind: "review-context", key: `${run}/review-context.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "ctx", capture: "machine-captured review context", captureStatus: "ok" }, T0);
    expect(upgraded.getArtifact(added)).toMatchObject({ kind: "review-context" });
    const columns = (upgraded.raw().prepare("PRAGMA table_info(criterion_review)").all() as { name: string }[]).map(one => one.name);
    expect(columns).toEqual(expect.arrayContaining(["context_artifact", "context_sha"]));
    upgraded.close();
    stores.pop();
    const reopened = new DatabaseSync(file, { readOnly: true });
    expect(String(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toContain("'review-context'");
    reopened.close();
  });
});
