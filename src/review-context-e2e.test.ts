/** Historical review-context compatibility: builds/revisions still retain
 * exact source context. Direct legacy review ingestion below exercises saved
 * records; the production tick no longer schedules this retired phase. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOperate } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { readVerifiedArtifact, writeEvidenceFile } from "./evidence.js";
import { parseReviewContext, reviewContextManifest, reviewContextFileName } from "./review-context.js";
import type { Runner } from "./builder.js";
import { createHash } from "node:crypto";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-11T22:00:00.000Z");

const LIMIT_TS = "export function limiter(): number {\n  return 3;\n}\n";
const GUARD_TS = "export function guard(n: number): boolean {\n  return n < 3;\n}\n";
const REPORT_TS = "export function report(): string {\n  return 'ok';\n}\n";
const REPORT_TS_V2 = "export function report(): string {\n  return 'ok, revised';\n}\n";
const STATEMENTS = ["The limiter caps retries at three.", "The guard refuses a fourth attempt.", "The report names the outcome."];

describe("inherited review context and historical ingestion (v51)", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const run = (argv: string[], runner: Runner) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0, agentRunner: runner });
  };
  const payload = () => JSON.parse(lines.join("\n"));
  const nameIn = (args: readonly string[], prefix: string): string | undefined => {
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    return new RegExp(`${prefix}[0-9a-f]{16}\\.json`).exec(prompt)?.[0];
  };

  /** A builder that writes the given files, a handoff, and a proof whose
   * changed paths and per-criterion changed-path evidence match them. */
  const builder = (files: Record<string, string>, evidencePaths: Record<string, string>, conclusion: string): Runner =>
    async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(cwd, path, ".."), { recursive: true });
        await writeFile(join(cwd, path), content);
      }
      const done = nameIn(args, "STANDING-ORDERS-DONE-");
      const proof = nameIn(args, "STANDING-ORDERS-PROOF-");
      if (done !== undefined) await writeFile(join(cwd, done), JSON.stringify({ version: 2, status: "completed", conclusion, changes: Object.keys(files), verification: ["none"] }));
      if (proof !== undefined) {
        await writeFile(
          join(cwd, proof),
          JSON.stringify({
            version: 1,
            criteria: STATEMENTS.map((statement, index) => ({
              id: `c${index + 1}`,
              statement,
              verdict: "met",
              how: "wrote it",
              evidence: [{ kind: "changed-path", ref: evidencePaths[`c${index + 1}`] }],
            })),
            checks: [],
            changed: Object.keys(files),
            caveats: [],
            screenshots: [],
          }),
        );
      }
      return { ...OK, stdout: JSON.stringify({ result: conclusion, session_id: "build-session" }) };
    };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-ctx-e2e-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("build and revision retain exact context readable by historical review records", async () => {
    const runnerToken = "tok-builder-1";
    const none: Runner = async () => ({ ...OK, code: 1, stderr: "no agent should run here" });
    await run(["approver", "add", "alex", "--json"], none);
    const approverToken = payload().token as string;
    for (const phase of ["build", "plan", "repair", "review"]) {
      await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], none);
    }
    await run(["task", "add", "retry limiter", "--id", "feat"], none);
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      expect(store.placeTask(store.refFor("built-in", "feat").id, repo)).toBe(true);
      store.close();
    }
    await run(["task", "scope", "feat", "--goal", "cap retries at three", "--acceptance", STATEMENTS.map(one => `${one}|changed-path`).join(";")], none);
    await run(["task", "approve", "feat", "--json"], none);
    await run(["task", "approve", "feat", "--yes", "--digest", payload().scope.digest as string, "--as", "alex", "--token", approverToken], none);

    // 1. The feature build: three files, one proof, the whole rubric.
    await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      builder({ "src/limit.ts": LIMIT_TS, "src/guard.ts": GUARD_TS, "src/report.ts": REPORT_TS }, { c1: "src/limit.ts", c2: "src/guard.ts", c3: "src/report.ts" }, "capped retries"),
    );
    expect(payload().dispatched).toEqual(expect.arrayContaining([expect.objectContaining({ id: "feat", outcome: "built" })]));
    let sourceRun: number;
    let sourceHead: string;
    {
      const store = openStore(db);
      const built = store.runsFor(store.refFor("built-in", "feat").id).find(one => one.role === "builder")!;
      expect(built).toMatchObject({ outcome: "built" });
      sourceRun = built.id;
      sourceHead = built.headRevision!;
      expect(store.proofVerdictFor(sourceRun)?.matrix.map(row => row.state)).toEqual(["pass", "pass", "pass"]);
      const context = store.artifactsFor(sourceRun).find(one => one.kind === "review-context")!;
      const sealed = readVerifiedArtifact(join(base, "evidence"), context);
      expect(sealed.ok).toBe(true);
      const parsed = parseReviewContext(sealed.ok ? sealed.content.toString("utf8") : "");
      expect(parsed.ok && parsed.inventory.items.map(item => item.path)).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
      expect(parsed.ok && parsed.inventory.coverage.every(row => !row.inherited)).toBe(true);
      store.close();
    }
    // Retired commands cannot create another provider run from this saved result.
    expect(await run(["task", "review", String(sourceRun), "--as", "alex", "--token", approverToken, "--json"], none)).not.toBe(0);
    expect(payload().reason).toBe("model-review-retired");

    // A revision starts from its recorded source without landing that
    // feature on main or overriding the dispatcher's base manually.
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe(sourceHead);

    // 2. The revision, sealed through the store's one revision road with
    // the source rubric inherited, then approved like any task.
    let revisionId: string;
    {
      const store = openStore(db);
      const evidenceRoot = join(base, "evidence");
      const scope = store.getScope("feat")!;
      const diff = store.artifactsFor(sourceRun).find(one => one.kind === "terminal-diff")!;
      const briefBytes = Buffer.from(JSON.stringify({ schema: 1, sourceTask: "feat", sourceRun, sourceScopeDigest: store.getScope("feat")!.digest, head: sourceHead, diffArtifactSha: diff.sha256, comments: [] }), "utf8");
      const key = writeEvidenceFile(evidenceRoot, sourceRun, "revision-brief-e2e.json", briefBytes);
      const sealed = store.sealRevision(
        {
          source: { task: "feat", run: sourceRun, scopeDigest: scope.digest },
          brief: { evidenceRoot, key, bytes: briefBytes.length, sha256: createHash("sha256").update(briefBytes).digest("hex"), capture: "machine-authored revision brief (exit 0)" },
          child: { id: "feat-rev", title: "Revise feat", repair: "apply the annotations" },
          commentIds: null,
        },
        T0,
      );
      if (!sealed.ok) throw new Error(sealed.reason);
      revisionId = sealed.id;
      store.close();
    }
    await run(["task", "approve", revisionId, "--json"], none);
    await run(["task", "approve", revisionId, "--yes", "--digest", payload().scope.digest as string, "--as", "alex", "--token", approverToken], none);

    // 3. The revision build touches ONLY src/report.ts. Settlement seals the
    // source context from git objects at the revision's sealed head.
    await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      builder({ "src/report.ts": REPORT_TS_V2 }, { c1: "src/report.ts", c2: "src/report.ts", c3: "src/report.ts" }, "revised the report"),
    );
    expect(payload().dispatched).toEqual(expect.arrayContaining([expect.objectContaining({ id: revisionId, outcome: "built" })]));
    let revisionRun: number;
    let contextSha: string;
    let manifest: string;
    let itemIdFor: (path: string) => string;
    {
      const store = openStore(db);
      const built = store.runsFor(store.refFor("built-in", revisionId).id).find(one => one.role === "builder")!;
      expect(built).toMatchObject({ outcome: "built" });
      revisionRun = built.id;
      const context = store.artifactsFor(revisionRun).filter(one => one.kind === "review-context");
      expect(context).toHaveLength(1);
      contextSha = context[0]!.sha256;
      const read = readVerifiedArtifact(join(base, "evidence"), context[0]!);
      if (!read.ok) throw new Error(read.problem);
      const parsed = parseReviewContext(read.content.toString("utf8"));
      if (!parsed.ok) throw new Error(parsed.problem);
      const inventory = parsed.inventory;
      manifest = reviewContextManifest(inventory);
      expect(inventory).toMatchObject({ run: revisionRun, head: built.headRevision, source: { task: "feat", run: sourceRun, head: sourceHead, verified: true }, ancestry: { verified: true } });
      const byPath = new Map(inventory.items.map(one => [one.path, one]));
      itemIdFor = path => byPath.get(path)!.id;
      expect([...byPath.keys()].sort()).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
      for (const item of inventory.items) {
        expect(item.commit).toBe(built.headRevision);
        expect(item.sourceRun).toBe(sourceRun);
        expect(item.blob).toBe((await git(["rev-parse", `${built.headRevision}:${item.path}`])).stdout.trim());
      }
      expect(byPath.get("src/limit.ts")).toMatchObject({ content: LIMIT_TS, criteria: ["c1"], unchangedSinceSource: true });
      expect(byPath.get("src/report.ts")).toMatchObject({ content: REPORT_TS_V2, criteria: ["c3"], unchangedSinceSource: false });
      expect(inventory.coverage.map(one => [one.id, one.state])).toEqual([["c1", "context"], ["c2", "context"], ["c3", "patch"]]);
      // The stored matrix carries the same coverage — one projection.
      const verdict = store.proofVerdictFor(revisionRun)!;
      expect(verdict.matrix.map(row => row.coverage?.state)).toEqual(["context", "context", "patch"]);
      store.close();
    }
    // The CLI: context standing per criterion, coverage under the policy.
    await run(["task", "show", revisionId], none);
    expect(lines.join("\n")).toContain(`context: inherited — sealed context ${itemIdFor!("src/limit.ts")}`);
    expect(lines.join("\n")).toContain("context: judged from this run's own patch");
    expect(lines.join("\n")).toMatch(/semantic coverage: 0\/3 upheld by an independent reviewer — independent review is optional under default quality — none has settled/);

    // 4. Retained historical judgements still bind to the exact source context.
    // Seed through the store boundary; the retired model runner is not executable.
    {
      const store = openStore(db);
      const requested = store.requestReview(revisionRun, "alex", T0);
      if (!requested.ok) throw new Error(requested.reason);
      const admitted = store.admitReview(requested.id, { runner: "builder-1", token: runnerToken, provider: "claude", model: "sonnet" }, T0);
      if (!admitted.ok) throw new Error(admitted.reason);
      store.stampProviderStart(admitted.reviewerRunId, T0);
      const run = store.getRun(revisionRun)!;
      const artifacts = store.artifactsFor(revisionRun);
      const diff = artifacts.find(one => one.kind === "terminal-diff")!;
      const proof = artifacts.find(one => one.kind === "proof")!;
      const context = artifacts.find(one => one.kind === "review-context")!;
      store.ingestReview({ reviewerRunId: admitted.reviewerRunId, runId: revisionRun, artifactId: diff.id, evidenceRoot: join(base, "evidence"), author: "reviewer:claude·sonnet", comments: [],
        judgements: [{ id: "c1", judgement: "upholds", note: itemIdFor("src/limit.ts") + ": limiter() returns 3 at the sealed head" },
          { id: "c2", judgement: "cannot-tell", note: "The guard is retained; runtime behavior remains unverified." },
          { id: "c3", judgement: "upholds", note: "src/report.ts names the outcome in the patch" }],
        bindings: { diffSha: diff.sha256, scopeDigest: run.scopeDigest, headSha: run.headRevision, proof: { artifactId: proof.id, sha256: proof.sha256 }, checkLog: null, screenshots: [], context: { artifactId: context.id, sha256: context.sha256 } } }, T0);
      store.close();
    }
    {
      const store = openStore(db);
      const judged = store.criterionReviewsFor(revisionRun);
      expect(judged.map(one => [one.criterionId, one.judgement])).toEqual([["c1", "upholds"], ["c2", "cannot-tell"], ["c3", "upholds"]]);
      expect(judged.every(one => one.context?.sha256 === contextSha)).toBe(true);
      const verdict = store.proofVerdictFor(revisionRun)!;
      expect(verdict.matrix.find(row => row.id === "c1")).toMatchObject({ review: { judgement: "upholds" }, coverage: { state: "context" } });
      store.close();
    }
    await run(["task", "show", revisionId], none);
    expect(lines.join("\n")).toMatch(/semantic coverage: 2\/3 upheld by an independent reviewer — optional under default quality — 2\/3 upheld, cannot-tell: c2/);
    expect(lines.join("\n")).toContain("review (reviewer:claude·sonnet): upholds");
    // The JSON projection is the same object the console reads.
    await run(["task", "show", revisionId, "--json"], none);
    expect(payload().semanticCoverage).toMatchObject({ policy: "default", required: false, upheld: ["c1", "c3"], uncertain: ["c2"], satisfied: false });
  });
});
