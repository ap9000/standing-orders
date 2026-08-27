/**
 * The reviewer role (v29, R1–R4 + D5/D8), end to end with a stubbed
 * agent: the artifact-only discipline (truncated diff refused before any
 * money, scratch hygiene as the law, patch-locality proven at parse), the
 * proving ingestion transaction, the one-review-per-run invariant, the
 * request roads (manual + reviewAuto), and the workspace-consumer guard
 * that a reviewer run's missing worktree is a typed fact, not a "null".
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { storeEvidence } from "./evidence.js";
import { addApprover } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "./modes.js";
import { maybeRequestAutoReview } from "./dispose.js";
import { diffPathsOf, parseReview, review, reviewPass, REVIEW_LIMITS, REVIEW_PATCH_NAME } from "./reviewer.js";
import type { Runner } from "./builder.js";

const T0 = new Date("2026-08-27T12:00:00.000Z");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const SAID = JSON.stringify({ result: "reviewing" });
const REVIEW_FILE = /STANDING-ORDERS-REVIEW-[0-9a-f]{16}\.json/;
const REPO = "/repos/thing";

const PATCH = [
  "diff --git a/src/payouts.ts b/src/payouts.ts",
  "--- a/src/payouts.ts",
  "+++ b/src/payouts.ts",
  "@@ -1,2 +1,3 @@",
  "+const guard = limiter();",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "",
].join("\n");

describe("diff paths and the strict parser", () => {
  test("diffPathsOf collects both sides and both rename halves", () => {
    const paths = diffPathsOf(PATCH);
    expect(paths.has("src/payouts.ts")).toBe(true);
    expect(paths.has("src/old-name.ts")).toBe(true);
    expect(paths.has("src/new-name.ts")).toBe(true);
    expect(paths.has("")).toBe(false);
  });

  test("a well-formed payload parses; severity defaults to note; notes trim", () => {
    const parsed = parseReview(
      JSON.stringify({
        version: 1,
        comments: [
          { path: "src/payouts.ts", line: 2, note: "  the limiter is never awaited  ", severity: "problem" },
          { path: "src/new-name.ts", line: null, note: "rename looks right" },
        ],
      }),
      diffPathsOf(PATCH),
    );
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.comments).toEqual([
      { path: "src/payouts.ts", line: 2, note: "the limiter is never awaited", severity: "problem" },
      { path: "src/new-name.ts", line: null, note: "rename looks right", severity: "note" },
    ]);
  });

  test("an empty comments array is a valid review", () => {
    const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), diffPathsOf(PATCH));
    expect(parsed.ok).toBe(true);
  });

  test("wholesale strictness: any invalid comment refuses the payload", () => {
    const paths = diffPathsOf(PATCH);
    const refuse = (payload: unknown, why: RegExp) => {
      const parsed = parseReview(JSON.stringify(payload), paths);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(why);
    };
    refuse({ version: 2, comments: [] }, /version/);
    refuse({ version: 1, comments: [{ path: "src/elsewhere.ts", line: 1, note: "x" }] }, /not in the reviewed patch/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 0, note: "x" }] }, /positive integer/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 1, note: "x".repeat(REVIEW_LIMITS.note + 1) }] }, /note/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 1, note: "x", severity: "nit" }] }, /severity/);
    refuse(
      { version: 1, comments: Array.from({ length: REVIEW_LIMITS.comments + 1 }, () => ({ path: "src/payouts.ts", line: 1, note: "x" })) },
      /at most 40/,
    );
    const notJson = parseReview("not json at all", paths);
    expect(notJson.ok).toBe(false);
  });
});

describe("the reviewer role in the store", () => {
  let store: Store;
  let evidenceRoot: string;
  let taskRef: number;
  let builtRun: number;
  let diffArtifact: number;

  const seedBuilt = (patch: string = PATCH, opts: { truncated?: boolean } = {}) => {
    const runId = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random().toString(16).slice(2, 8)}`,
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    // Truncation is forced the honest way: content past the kind's cap.
    const content = opts.truncated === true ? Buffer.alloc(300 * 1024, 0x61) : Buffer.from(patch, "utf8");
    const artifactId = storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch", content, "git diff (exit 0)", T0, {
      captureStatus: "ok",
    });
    store.recordOutcomeFacts(runId, { headRevision: "head-aaa", handoff: "guarded the payout" });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    return { runId, artifactId };
  };

  beforeEach(() => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "so-review-evidence-"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    const seeded = seedBuilt();
    builtRun = seeded.runId;
    diffArtifact = seeded.artifactId;
  });

  afterEach(() => {
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("startRun's reviewer arm opens without a workspace; the CHECK refuses every mixed shape", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0 });
    const row = store.getRun(reviewer);
    expect(row?.role).toBe("reviewer");
    expect(row?.branch).toBeNull();
    expect(row?.worktree).toBeNull();
    // A reviewer WITH a workspace, refused by the exclusive CHECK.
    expect(() =>
      store
        .raw()
        .prepare(
          "INSERT INTO run (task_ref, lease_id, runner, branch, worktree, role, provider, parent_run, started_at) VALUES (?, 'x', 'r', 'b', '/w', 'reviewer', 'claude', ?, ?)",
        )
        .run(taskRef, builtRun, T0.toISOString()),
    ).toThrow();
    // A builder WITHOUT one, equally refused.
    expect(() =>
      store
        .raw()
        .prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, started_at) VALUES (?, 'x', 'r', 'builder', 'claude', ?)")
        .run(taskRef, T0.toISOString()),
    ).toThrow();
  });

  test("one review per source run, ever — the partial unique holds", () => {
    store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0 });
    expect(() =>
      store.startRun({ taskRef, leaseId: "review:2", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0 }),
    ).toThrow();
  });

  test("requestReview: every refusal road is typed", () => {
    expect(store.requestReview(9999, "alex", T0)).toEqual({ ok: false, reason: "no-run" });

    const open = store.startRun({ taskRef, leaseId: "lease-x", runner: "builder-1", branch: "b", worktree: "/w", now: T0 });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "unfinished" });
    store.finishRun(open, { outcome: "built", committed: true, now: T0 });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "no-diff" });

    const truncated = seedBuilt(PATCH, { truncated: true });
    expect(store.requestReview(truncated.runId, "alex", T0)).toEqual({ ok: false, reason: "diff-truncated" });

    const first = store.requestReview(builtRun, "alex", T0);
    expect(first.ok).toBe(true);
    expect(store.requestReview(builtRun, "alex", T0)).toEqual({ ok: false, reason: "already-requested" });

    // A run that already HAS its review refuses a fresh ask.
    const other = seedBuilt();
    const reviewer = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "review:3", runner: "builder-1", role: "reviewer", parentRun: other.runId, now: T0 });
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s)", now: T0 });
    expect(store.requestReview(other.runId, "alex", T0)).toEqual({ ok: false, reason: "already-reviewed" });

    // And a review itself is not reviewable.
    expect(store.requestReview(reviewer, "alex", T0)).toEqual({ ok: false, reason: "not-reviewable" });
  });

  test("addReviewerComments proves role, parentage, task, and artifact binding", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0 });
    const comment = { path: "src/payouts.ts", line: 2, note: "the limiter is never awaited", severity: "problem" as const };

    // A non-reviewer cannot author.
    expect(() =>
      store.addReviewerComments({ reviewerRunId: builtRun, runId: builtRun, artifactId: diffArtifact, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/not a reviewer/);

    // Wrong parentage: a second built run this reviewer was never minted for.
    const other = seedBuilt();
    expect(() =>
      store.addReviewerComments({ reviewerRunId: reviewer, runId: other.runId, artifactId: other.artifactId, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/reviews run/);

    // The right run, somebody else's artifact.
    expect(() =>
      store.addReviewerComments({ reviewerRunId: reviewer, runId: builtRun, artifactId: other.artifactId, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/terminal diff/);

    const ids = store.addReviewerComments(
      { reviewerRunId: reviewer, runId: builtRun, artifactId: diffArtifact, author: "reviewer:claude·opus", comments: [comment] },
      T0,
    );
    expect(ids).toHaveLength(1);
    const live = store.liveDiffComments(builtRun);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      run: builtRun,
      artifact: diffArtifact,
      path: "src/payouts.ts",
      line: 2,
      author: "reviewer:claude·opus",
      reviewerRun: reviewer,
      severity: "problem",
    });
    // The human road's comments stay severity-free.
    const human = store.addDiffComment({ artifactId: diffArtifact, runId: builtRun, path: null, line: null, note: "looks fine", author: "alex" }, T0);
    expect(human).not.toBeNull();
    const all = store.liveDiffComments(builtRun);
    expect(all[1]?.reviewerRun).toBeNull();
    expect(all[1]?.severity).toBeNull();
  });

  describe("the pass itself", () => {
    let scratchRoot: string;
    beforeEach(() => {
      scratchRoot = mkdtempSync(join(tmpdir(), "so-review-scratch-"));
    });
    afterEach(() => {
      rmSync(scratchRoot, { recursive: true, force: true });
    });

    const reviewingAgent =
      (payload: unknown, extraFile: string | null = null): Runner =>
      async (_file, args, options) => {
        const cwd = options?.cwd ?? "";
        const prompt = String(args[args.indexOf("-p") + 1] ?? "");
        const name = REVIEW_FILE.exec(prompt)?.[0];
        if (name !== undefined && cwd !== "") {
          writeFileSync(join(cwd, name), JSON.stringify(payload));
          if (extraFile !== null) writeFileSync(join(cwd, extraFile), "sneaky");
        }
        return { ...OK, stdout: SAID };
      };

    const passOnce = (agent: Runner) =>
      reviewPass(store, { runner: "builder-1", now: T0, evidenceRoot, scratchRoot, agent });

    test("manual road end to end: request → pass → comments land, run closes, request consumed", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      expect(asked.ok).toBe(true);
      const reports = await passOnce(
        reviewingAgent({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "never awaited", severity: "question" }] }),
      );
      expect(reports).toEqual([{ requestId: (asked as { id: number }).id, run: builtRun, outcome: "reviewed", detail: "1 comment(s)" }]);
      const comments = store.liveDiffComments(builtRun);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.author).toBe("reviewer:claude");
      const reviewer = store.getRun(comments[0]?.reviewerRun ?? -1);
      expect(reviewer?.role).toBe("reviewer");
      expect(reviewer?.outcome).toBe("no-change");
      expect(reviewer?.reason).toBe("reviewed — 1 comment(s)");
      expect(store.openReviewRequests()).toHaveLength(0);
      // The scratch directory is gone — nothing to leak.
      expect(readdirSync(scratchRoot)).toHaveLength(0);
    });

    test("scratch hygiene: an extra file refuses the whole pass, nothing ingested, the attempt is spent", async () => {
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(
        reviewingAgent({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "x" }] }, "EXTRA.txt"),
      );
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("dirty-scratch");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      // One attempt (R4): spent, not retried.
      expect(store.openReviewRequests()).toHaveLength(0);
      const reviewerRow = store.raw().prepare("SELECT outcome, reason FROM run WHERE role = 'reviewer'").get();
      expect(reviewerRow).toMatchObject({ outcome: "failed", reason: "reviewer-dirty-scratch" });
    });

    test("a malformed payload is a typed failure, and patch-locality is enforced at the seam", async () => {
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(
        reviewingAgent({ version: 1, comments: [{ path: "src/never-in-patch.ts", line: 1, note: "ghost" }] }),
      );
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("malformed-review");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    });

    test("a truncated diff never spawns an agent", async () => {
      const truncated = seedBuilt(PATCH, { truncated: true });
      const reviewer = store.startRun({ taskRef, leaseId: "review:t", runner: "builder-1", role: "reviewer", parentRun: truncated.runId, now: T0 });
      let spawned = false;
      const spy: Runner = async () => {
        spawned = true;
        return { ...OK, stdout: SAID };
      };
      const result = await review(store, {
        sourceRunId: truncated.runId,
        reviewerRunId: reviewer,
        taskId: "t-1",
        taskTitle: "wire the payout guard",
        provider: "claude",
        model: null,
        now: T0,
        evidenceRoot,
        scratchRoot,
        agent: spy,
      });
      expect(result).toMatchObject({ ok: false, reason: "diff-truncated" });
      expect(spawned).toBe(false);
    });

    test("a mode-derived request re-proves its authority at dispatch (R-REVOKE)", async () => {
      // Queue as a mode would, then let the mode die: the request is spent
      // unrun and review falls back to the human ask.
      const asked = store.requestReview(builtRun, "mode:deadbeefdeadbeefdeadbeefdeadbeef", T0);
      expect(asked.ok).toBe(true);
      let spawned = false;
      const spy: Runner = async () => {
        spawned = true;
        return { ...OK, stdout: SAID };
      };
      const reports = await passOnce(spy);
      expect(reports).toEqual([{ requestId: (asked as { id: number }).id, run: builtRun, outcome: "skipped", detail: "mode-ended" }]);
      expect(spawned).toBe(false);
      expect(store.openReviewRequests()).toHaveLength(0);
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'reviewer'").get()?.["n"]).toBe(0);
      // The human road is untouched: a fresh manual ask still works.
      expect(store.requestReview(builtRun, "alex", T0).ok).toBe(true);
    });

    test("a mode-derived request under a live reviewAuto mode runs", async () => {
      const terms = presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
        T0,
      );
      store.requestReview(builtRun, `mode:${modeDigestOf(terms)}`, T0);
      const reports = await passOnce(reviewingAgent({ version: 1, comments: [] }));
      expect(reports[0]?.outcome).toBe("reviewed");
      expect(reports[0]?.detail).toBe("0 comment(s)");
    });
  });

  test("maybeRequestAutoReview: a live reviewAuto mode queues built-with-changes, and only that", () => {
    // No mode: nothing queued.
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    const terms = presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    // No-change and uncommitted outcomes stay quiet.
    maybeRequestAutoReview(store, REPO, builtRun, true, true, T0);
    maybeRequestAutoReview(store, REPO, builtRun, false, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    const open = store.openReviewRequests();
    expect(open).toHaveLength(1);
    expect(open[0]?.requestedBy).toBe(`mode:${modeDigestOf(terms)}`);

    // hands-off says reviewAuto: false — a renewal to it queues nothing new.
    store.consumeReviewRequest(open[0]?.id ?? -1, "test", T0);
    const handsOff = presetTerms("hands-off", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
    store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(handsOff), digest: modeDigestOf(handsOff), signedBy: "alex", absoluteExpiry: handsOff.absoluteExpiry, publication: handsOff.publication },
      T0,
    );
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);
  });

  test("workspace consumers see a reviewer run's missing worktree as null, never \"null\"", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0 });
    const row = store.getRun(reviewer);
    if (row === null) throw new Error("row");
    // The typed fact every guard keys on (D5): consumers switch on null,
    // and the string "null" — the classic String(null) bug — never forms.
    expect(row.worktree).toBeNull();
    expect(row.branch).toBeNull();
    for (const run of store.runsFor(taskRef)) {
      expect(run.worktree === null || typeof run.worktree === "string").toBe(true);
      expect(run.worktree).not.toBe("null");
      expect(run.branch).not.toBe("null");
    }
  });
});
