/**
 * Inherited review context END TO END through the real tick (v51): a
 * feature is built by a stubbed builder in a real repository, its result
 * is revised by a second build that touches one file, the revision's
 * settlement seals the source context from git objects at its exact head,
 * an independent reviewer judges the inherited criteria by citing that
 * sealed provenance, and `task show` reports semantic coverage and every
 * context gap in the same words the console prints. No agent here ever
 * reads a checkout as evidence; the stubs only write what a builder writes.
 */

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
import { parseReviewContext } from "./review-context.js";
import { REVIEW_CONTEXT_NAME } from "./reviewer.js";
import type { Runner } from "./builder.js";
import { createHash } from "node:crypto";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-11T22:00:00.000Z");

const LIMIT_TS = "export function limiter(): number {\n  return 3;\n}\n";
const GUARD_TS = "export function guard(n: number): boolean {\n  return n < 3;\n}\n";
const REPORT_TS = "export function report(): string {\n  return 'ok';\n}\n";
const REPORT_TS_V2 = "export function report(): string {\n  return 'ok, revised';\n}\n";
const STATEMENTS = ["The limiter caps retries at three.", "The guard refuses a fourth attempt.", "The report names the outcome."];

describe("inherited review context through the tick (v51)", () => {
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

  test("build → revise → build → review: the revision seals source context at its head, the reviewer cites it, and task show reports coverage", async () => {
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
      expect(store.artifactsFor(sourceRun).some(one => one.kind === "review-context")).toBe(false);
      store.close();
    }
    // The operator lands the feature on main before revising it — the
    // revision's branch grows from main, and the source head must be in
    // its history for inherited context to verify.
    await git(["merge", "-q", "--ff-only", "standing-orders/feat"]);
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(sourceHead);

    // 2. The revision, sealed through the store's one revision road with
    // the source rubric inherited, then approved like any task.
    let revisionId: string;
    {
      const store = openStore(db);
      const evidenceRoot = join(base, "evidence");
      const scope = store.getScope("feat")!;
      const diff = store.artifactsFor(sourceRun).find(one => one.kind === "terminal-diff")!;
      const briefBytes = Buffer.from(JSON.stringify({ schema: 1, sourceTask: "feat", sourceRun, head: sourceHead, diffArtifactSha: diff.sha256, comments: [] }), "utf8");
      const key = writeEvidenceFile(evidenceRoot, sourceRun, "revision-brief-e2e.json", briefBytes);
      const sealed = store.sealRevision(
        {
          task: { id: "feat-rev", title: "Revise feat from 1 annotation on build #1", repo, goal: `${scope.goal} — apply the annotations`, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance },
          artifact: { run: sourceRun, kind: "revision-brief", key, bytesOriginal: briefBytes.length, bytesStored: briefBytes.length, truncated: false, sha256: createHash("sha256").update(briefBytes).digest("hex"), capture: "machine-authored revision brief (exit 0)" },
          revisionOf: "feat",
          commentIds: null,
          sourceRun,
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

    // 4. The independent review: asked explicitly, run by the tick, judged
    // by citing the sealed provenance — and bound to it at ingestion.
    await run(["task", "review", String(revisionRun), "--as", "alex", "--token", approverToken, "--json"], none);
    let sawContextFile = false;
    let reviewPrompt = "";
    const reviewer: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      sawContextFile = createHash("sha256").update(readFileSync(join(cwd, REVIEW_CONTEXT_NAME))).digest("hex") === contextSha;
      reviewPrompt = args[args.indexOf("-p") + 1] ?? "";
      const review = {
        version: 1,
        comments: [],
        criteria: [
          { id: "c1", judgement: "upholds", note: `${itemIdFor("src/limit.ts")}: limiter() returns 3 at the sealed head` },
          { id: "c2", judgement: "cannot-tell", note: "the sealed guard shows n < 3 but nothing shows a fourth attempt being made" },
          { id: "c3", judgement: "upholds", note: "src/report.ts names the outcome in the patch" },
        ],
      };
      return { ...OK, stdout: JSON.stringify({ result: JSON.stringify(review), session_id: "review-session" }) };
    };
    await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], reviewer);
    expect(payload().dispatched).toEqual(expect.arrayContaining([expect.objectContaining({ id: `review of run ${revisionRun}`, outcome: "reviewed" })]));
    expect(sawContextFile).toBe(true);
    expect(reviewPrompt).toContain("REVISES an earlier build");
    expect(reviewPrompt).toContain(`c1: inherited — sealed context ${itemIdFor!("src/limit.ts")}`);
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
