/**
 * The reviewer role (v29, R1–R4 + D5/D8), end to end with a stubbed
 * agent: the artifact-only discipline (truncated diff refused before any
 * money, scratch hygiene as the law, patch-locality proven at parse), the
 * proving ingestion transaction, the one-review-per-run invariant, the
 * request roads (manual + reviewAuto), and the workspace-consumer guard
 * that a reviewer run's missing worktree is a typed fact, not a "null".
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { storeEvidence } from "./evidence.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { routeDigestOf } from "./phase-routing.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "./modes.js";
import { maybeRequestAutoReview } from "./dispose.js";
import {
  diffPathsOf,
  parseReview,
  review,
  reviewPass,
  REVIEW_LIMITS,
  REVIEW_PATCH_NAME,
  REVIEW_RUBRIC_NAME,
  REVIEW_PROOF_NAME,
  REVIEW_CHECK_LOG_NAME,
  reviewScreenshotName,
} from "./reviewer.js";
import type { Runner } from "./builder.js";
import type { CriterionMatrixRow } from "./proof.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  bound: { index: number; entryDigest: string } | null = null,
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role, bound);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-08-27T12:00:00.000Z");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
/** The reviewer's answer now rides the provider's own final message — the
 * buffered claude envelope's `result` field — never a file written to
 * disk. Every stubbed agent below "speaks" its review through this. */
const spoken = (payload: unknown): string => JSON.stringify({ result: JSON.stringify(payload) });
/** Run 1467's fix: the shape a claude turn actually carries under
 * `--json-schema` — the review-phase-only structured-output field
 * `claudeEnvelopeOf` now prefers over the plain `result` string. */
const spokenStructured = (payload: unknown): string => JSON.stringify({ structured_output: payload });
const spokenInSession = (payload: unknown, sessionId = "review-session-1"): string =>
  JSON.stringify({ result: typeof payload === "string" ? payload : JSON.stringify(payload), session_id: sessionId });
/** A harmless spoken reply for fixtures where the content never matters
 * (the pass returns before it would be read). */
const SAID = spoken({ version: 1, comments: [] });
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

  describe("v40: criteria judgements", () => {
    const paths = diffPathsOf(PATCH);
    const rubricIds = new Set(["c1", "c2"]);

    test("absent criteria still parses when NO rubric was signed — every task with no signed rubric, and every grandfathered review", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), paths, new Set());
      if (!parsed.ok) throw new Error("expected ok");
      expect(parsed.criteria).toEqual([]);
    });

    test("audit hardening: absent criteria against a SIGNED rubric refuses the whole payload — full coverage is required", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), paths, rubricIds);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/missing judgement.*c1.*c2|missing judgement.*c2.*c1/);
    });

    test("audit hardening: a PARTIAL judgement set (some signed ids uncovered) refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "contradicts", note: "never implemented" }] }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/missing judgement.*c2/);
    });

    test("a well-formed judgement covering every signed id parses", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: [
            { id: "c1", judgement: "contradicts", note: "  never implemented  " },
            { id: "c2", judgement: "upholds", note: "this one is fine" },
          ],
        }),
        paths,
        rubricIds,
      );
      if (!parsed.ok) throw new Error("expected ok");
      expect(parsed.criteria).toEqual([
        { id: "c1", judgement: "contradicts", note: "never implemented" },
        { id: "c2", judgement: "upholds", note: "this one is fine" },
      ]);
    });

    test("a judgement for an id absent from the signed rubric refuses the WHOLE payload, comments included", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [{ path: "src/payouts.ts", line: 1, note: "fine" }],
          criteria: [{ id: "not-signed", judgement: "upholds", note: "x" }],
        }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/not a signed criterion/);
    });

    test("a duplicate id in one payload refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: [
            { id: "c1", judgement: "upholds", note: "fine" },
            { id: "c1", judgement: "contradicts", note: "actually not" },
          ],
        }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/more than once/);
    });

    test("an unknown judgement word refuses the whole payload", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "maybe", note: "x" }] }), paths, rubricIds);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/judgement must be/);
    });

    test("an oversize note refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "x".repeat(REVIEW_LIMITS.note + 1) }] }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/note/);
    });

    test("more than REVIEW_LIMITS.criteria judgements refuses the whole payload", () => {
      const many = new Set(Array.from({ length: REVIEW_LIMITS.criteria + 1 }, (_, i) => `c${i}`));
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: Array.from({ length: REVIEW_LIMITS.criteria + 1 }, (_, i) => ({ id: `c${i}`, judgement: "upholds", note: "x" })),
        }),
        paths,
        many,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/at most 12/);
    });
  });
});

describe("the reviewer role in the store", () => {
  let store: Store;
  let evidenceRoot: string;
  let taskRef: number;
  let builtRun: number;
  let diffArtifact: number;
  let approverToken: string;

  const seedBuilt = (patch: string = PATCH, opts: { truncated?: boolean; captureStatus?: "ok" | "failed" } = {}) => {
    const runId = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random().toString(16).slice(2, 8)}`,
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, taskRef, "builder"),
    });
    // Truncation is forced the honest way: content past the kind's cap.
    const content = opts.truncated === true ? Buffer.alloc(300 * 1024, 0x61) : Buffer.from(patch, "utf8");
    const artifactId = storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch", content, "git diff (exit 0)", T0, {
      captureStatus: opts.captureStatus ?? "ok",
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
    approverToken = alex.token;
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    // admitReview authenticates inside its transaction (review finding 4).
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
    register(store, { name: "builder-2", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-2" });
    const seeded = seedBuilt();
    builtRun = seeded.runId;
    diffArtifact = seeded.artifactId;
  });

  afterEach(() => {
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a rotation AFTER admission fences the reviewer spawn — the runner row is younger than the run", () => {
    // Round-2 finding 3: admitReview authenticates in its transaction,
    // but the run keeps only the runner NAME — so custody at spawn must
    // notice that the name changed hands since. Rotation re-registers,
    // which stamps a newer registered_at than the run's start.
    const asked = store.requestReview(builtRun, "alex", T0);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null },
      T0,
    );
    if (!admitted.ok) throw new Error("admission failed");
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, new Date(T0.getTime() + 5_000))).toBe(true);
    register(store, { name: "builder-1", host: "elsewhere", repos: [REPO], now: new Date(T0.getTime() + 1_000), newToken: () => "tok-rotated" });
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, new Date(T0.getTime() + 5_000))).toBe(false);
  });

  test("a same-millisecond runner replacement still fences an admitted reviewer", () => {
    // The original runner is older than the reviewer. The replacement lands
    // in the reviewer's exact millisecond, so simply maxing wall time against
    // the prior registration would make both incarnations look identical.
    const admissionTime = new Date(T0.getTime() + 1_000);
    const asked = store.requestReview(builtRun, "alex", admissionTime);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null },
      admissionTime,
    );
    if (!admitted.ok) throw new Error("admission failed");

    register(store, {
      name: "builder-1",
      host: "replacement",
      repos: [REPO],
      now: admissionTime,
      newToken: () => "tok-replaced-in-the-same-millisecond",
    });

    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, admissionTime)).toBe(false);
  });

  test("a reviewer admitted after a logical same-millisecond replacement belongs to the new incarnation", () => {
    const replacement = register(store, {
      name: "builder-1",
      host: "replacement",
      repos: [REPO],
      now: T0,
      newToken: () => "tok-current-same-millisecond",
    });
    // Its atomically assigned generation is one logical millisecond ahead
    // of T0. Admission at the same coarse wall time must bind to that current
    // generation, not falsely reject it as a future replacement.
    expect(Date.parse(replacement.runner.registeredAt)).toBe(T0.getTime() + 1);
    const asked = store.requestReview(builtRun, "alex", T0);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: replacement.token, provider: "claude", model: null },
      T0,
    );
    if (!admitted.ok) throw new Error("admission failed");

    expect(store.getRun(admitted.reviewerRunId)?.startedAt).toBe(replacement.runner.registeredAt);
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, T0)).toBe(true);
  });

  test("startRun's reviewer arm opens without a workspace; the CHECK refuses every mixed shape", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer") });
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
    store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer") });
    expect(() =>
      store.startRun({ taskRef, leaseId: "review:2", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer") }),
    ).toThrow();
  });

  test("requestReview: every refusal road is typed", () => {
    expect(store.requestReview(9999, "alex", T0)).toEqual({ ok: false, reason: "no-run" });

    const open = store.startRun({ taskRef, leaseId: "lease-x", runner: "builder-1", branch: "b", worktree: "/w", now: T0, ...presented(store, taskRef, "builder") });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "unfinished" });
    store.finishRun(open, { outcome: "built", committed: true, now: T0 });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "no-diff" });

    const truncated = seedBuilt(PATCH, { truncated: true });
    expect(store.requestReview(truncated.runId, "alex", T0)).toEqual({ ok: false, reason: "diff-truncated" });

    // A failed capture stored the failure's words AS the artifact —
    // reviewing an error message is refused, and the run's one review
    // allowance survives for a recapture (round-1 finding 5a).
    const broken = seedBuilt(PATCH, { captureStatus: "failed" });
    expect(store.requestReview(broken.runId, "alex", T0)).toEqual({ ok: false, reason: "diff-capture-failed" });

    const first = store.requestReview(builtRun, "alex", T0);
    expect(first.ok).toBe(true);
    expect(store.requestReview(builtRun, "alex", T0)).toEqual({ ok: false, reason: "already-requested" });

    // A run that already HAS its review refuses a fresh ask.
    const other = seedBuilt();
    const reviewer = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "review:3", runner: "builder-1", role: "reviewer", parentRun: other.runId, now: T0, ...presented(store, store.refFor("built-in", "t-1").id, "reviewer") });
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s)", now: T0 });
    expect(store.requestReview(other.runId, "alex", T0)).toEqual({ ok: false, reason: "already-reviewed" });

    // And a review itself is not reviewable.
    expect(store.requestReview(reviewer, "alex", T0)).toEqual({ ok: false, reason: "not-reviewable" });
  });

  test("addReviewerComments proves role, parentage, task, and artifact binding", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer") });
    store.stampProviderStart(reviewer, T0);
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

  test("a correction child cannot borrow another runner or lease", () => {
    const rootReviewer = store.startRun({
      taskRef,
      leaseId: "review:root",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    store.stampProviderStart(rootReviewer, T0);
    const child = store.startRun({
      taskRef,
      leaseId: "review:root",
      runner: "builder-1",
      role: "reviewer",
      parentRun: rootReviewer,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    store.stampProviderStart(child, T0);
    store.raw().prepare("UPDATE run SET runner = ?, lease_id = ? WHERE id = ?").run("builder-2", "borrowed", child);

    expect(() =>
      store.addReviewerComments(
        {
          reviewerRunId: child,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "borrowed", severity: "problem" }],
        },
        T0,
      ),
    ).toThrow(/bounded lineage/);
  });

  test("a later correction cannot ingest until every superseded correction is terminal failed", () => {
    const root = store.startRun({
      taskRef,
      leaseId: "review:linear",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    const firstCorrection = store.startRun({
      taskRef,
      leaseId: "review:linear",
      runner: "builder-1",
      role: "reviewer",
      parentRun: root,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    const acceptedLeaf = store.startRun({
      taskRef,
      leaseId: "review:linear",
      runner: "builder-1",
      role: "reviewer",
      parentRun: firstCorrection,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    for (const run of [root, firstCorrection, acceptedLeaf]) store.stampProviderStart(run, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const review = {
      reviewerRunId: acceptedLeaf,
      runId: builtRun,
      artifactId: diffArtifact,
      author: "reviewer:claude",
      comments: [{ path: "src/payouts.ts", line: 2, note: "only the accepted leaf may land", severity: "problem" as const }],
      judgements: [],
      bindings: {
        diffSha,
        scopeDigest: null,
        headSha: "head-aaa",
        proof: null,
        checkLog: null,
        screenshots: [],
      },
    };

    // root(open) -> correction(open) -> accepted leaf(open) is not a valid
    // correction history. The proving transaction refuses it before the
    // comment insert, and leaves every run unchanged.
    expect(() => store.ingestReview(review, T0)).toThrow(/nothing is ingested/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect([root, firstCorrection, acceptedLeaf].map(run => store.getRun(run)?.outcome)).toEqual([null, null, null]);

    // Once the superseded attempt is truthfully terminal failed, the exact
    // same leaf is a valid lineage and root + leaf finalize atomically.
    store.finishRun(firstCorrection, { outcome: "failed", reason: "reviewer-malformed-review", now: T0 });
    expect(store.proveRunnerCustodyForSpawn(acceptedLeaf, T0)).toBe(true);
    expect(store.ingestReview(review, T0).commentIds).toHaveLength(1);
    expect(store.getRun(root)).toMatchObject({ outcome: "no-change", reason: "reviewed — 1 comment(s)" });
    expect(store.getRun(firstCorrection)).toMatchObject({ outcome: "failed", reason: "reviewer-malformed-review" });
    expect(store.getRun(acceptedLeaf)).toMatchObject({ outcome: "no-change", reason: "structured review repaired" });
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);
  });

  test("ingest closes a root-authored review atomically and refuses a crash replay", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:atomic-root",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const review = {
      reviewerRunId: reviewer,
      runId: builtRun,
      artifactId: diffArtifact,
      author: "reviewer:claude",
      comments: [{ path: "src/payouts.ts", line: 2, note: "atomic", severity: "problem" as const }],
      judgements: [],
      bindings: {
        diffSha,
        scopeDigest: null,
        headSha: "head-aaa",
        proof: null,
        checkLog: null,
        screenshots: [],
      },
    };

    expect(store.ingestReview(review, T0).commentIds).toHaveLength(1);
    expect(store.getRun(reviewer)).toMatchObject({ outcome: "no-change", reason: "reviewed — 1 comment(s)" });
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);

    // Simulate the process returning after the commit without observing its
    // result. The closed root is part of that same commit, so replay cannot
    // duplicate the review even though the caller submits identical bytes.
    expect(() => store.ingestReview(review, T0)).toThrow(/nothing is ingested/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);
  });

  test("a root finalization failure rolls the entire review ingest back", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:atomic-rollback",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    store.raw().exec(
      `CREATE TRIGGER refuse_reviewer_finish
         BEFORE UPDATE OF outcome ON run
         WHEN OLD.id = ${reviewer}
         BEGIN
           SELECT RAISE(ABORT, 'simulated finalization crash');
         END`,
    );

    expect(() =>
      store.ingestReview(
        {
          reviewerRunId: reviewer,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "must roll back", severity: "problem" }],
          judgements: [],
          bindings: {
            diffSha,
            scopeDigest: null,
            headSha: "head-aaa",
            proof: null,
            checkLog: null,
            screenshots: [],
          },
        },
        T0,
      ),
    ).toThrow(/simulated finalization crash/);
    expect(store.getRun(reviewer)?.outcome).toBeNull();
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
  });

  test("criterion ingest requires one judgement for every stored matrix id and rolls malformed sets back", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:criterion-set",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const bindings = {
      diffSha,
      scopeDigest: null,
      headSha: "head-aaa",
      proof: null,
      checkLog: null,
      screenshots: [],
    };
    const comment = { path: "src/payouts.ts", line: 2, note: "must be atomic", severity: "problem" as const };
    const ingest = (judgements: readonly { id: string; judgement: "upholds"; note: string }[]) =>
      store.ingestReview(
        {
          reviewerRunId: reviewer,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [comment],
          judgements,
          bindings,
        },
        T0,
      );

    expect(() => ingest([{ id: "c1", judgement: "upholds", note: "looks right" }])).toThrow(/no proof verdict/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    const matrix: CriterionMatrixRow[] = ["c1", "c2"].map(id => ({
      id,
      statement: `criterion ${id}`,
      requiredEvidence: ["manual-review"],
      state: "manual-review",
      detail: [],
      answered: [],
      review: null,
    }));
    store.saveProofVerdict(builtRun, "short", ["needs review"], T0, matrix);

    // An empty caller array is not proof that no rubric exists. The store
    // re-derives the matrix before its comments-only fast path, so a direct
    // or replayed caller cannot spend the one review without judging c1/c2.
    expect(() => ingest([])).toThrow(/exact stored criterion set/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    expect(() =>
      ingest([
        { id: "c1", judgement: "upholds", note: "first" },
        { id: "c1", judgement: "upholds", note: "duplicate" },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      ingest([
        { id: "c1", judgement: "upholds", note: "present" },
        { id: "c3", judgement: "upholds", note: "not signed" },
      ]),
    ).toThrow(/exact stored criterion set/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    expect(store.proofVerdictFor(builtRun)).toMatchObject({ verdict: "short", machineVerdict: null });
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    expect(
      ingest([
        { id: "c1", judgement: "upholds", note: "covered" },
        { id: "c2", judgement: "upholds", note: "covered" },
      ]).commentIds,
    ).toHaveLength(1);
    expect(store.criterionReviewsFor(builtRun).map(row => row.criterionId)).toEqual(["c1", "c2"]);
    expect(store.getRun(reviewer)?.outcome).toBe("no-change");
  });

  describe("the pass itself", () => {
    let scratchRoot: string;
    beforeEach(() => {
      scratchRoot = mkdtempSync(join(tmpdir(), "so-review-scratch-"));
      // The runner gate's spawn leg (MCP spec v6): reviewer runs are the
      // ONE role that holds no task claim — admitReview's synthetic lease
      // id is a marker, and the custody proof's reviewer arm checks
      // identity, liveness, and repo membership WITHOUT lease currency.
      // The outer fixture already registered builder-1. Registering the same
      // name again would truthfully be a new runner incarnation and must
      // fence a review admitted under the old one.
    });
    afterEach(() => {
      rmSync(scratchRoot, { recursive: true, force: true });
    });

    const reviewingAgent =
      (payload: unknown, extraFile: string | null = null): Runner =>
      async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        if (extraFile !== null && cwd !== "") writeFileSync(join(cwd, extraFile), "sneaky");
        return { ...OK, stdout: spoken(payload) };
      };

    const passOnce = (agent: Runner) =>
      reviewPass(store, { runner: "builder-1", token: "tok-builder-1", now: T0, evidenceRoot, scratchRoot, agent });

    test("the sealed route's review leg governs the reviewer — never today's configuration — and the run names its route (v47)", async () => {
      // The task's scope seals an overridden reviewer; the installation's
      // review row says something else and later changes again.
      store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "claude-sonnet-4", "alex", T0); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "claude-haiku", "alex", T0);
      propose(store, { taskId: "t-1", goal: "guard the payouts", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0 });
      const edited = store.editTaskRoute(taskRef, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "claude-opus-4-1" } }, T0);
      if (!edited.ok) throw new Error(edited.detail);
      const refiled = edited.scope!;
      expect(approve(store, "t-1", "alex", T0, refiled.digest, approverToken).ok).toBe(true);
      store.setPhaseConfig("installation", "review", "claude", "claude-sonnet-4", "alex", T0);

      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      expect(store.raw().prepare("SELECT route_digest FROM review_request WHERE id = ?").get(asked.id)?.["route_digest"]).toBe(routeDigestOf(store.approvedRouteOf("t-1")!));
      const seen: string[][] = [];
      const reports = await passOnce(async (_file, args, options) => {
        seen.push([...args]);
        return reviewingAgent({ version: 1, comments: [] })(_file, args, options);
      });
      expect(reports[0]).toMatchObject({ outcome: "reviewed" });
      expect(seen[0]).toContain("--model");
      expect(seen[0]?.[seen[0].indexOf("--model") + 1]).toBe("claude-opus-4-1");
      const reviewer = store.runsFor(taskRef).find(run => run.role === "reviewer")!;
      expect(reviewer.model).toBe("claude-opus-4-1");
      expect(store.runRoute(reviewer.id)).toMatchObject({ phase: "review", provider: "claude", model: "claude-opus-4-1", chosen: "override", routeDigest: routeDigestOf(store.approvedRouteOf("t-1")!) });
    });

    test("requestReview → admitReview → a REAL spawn: the reviewer row and its review-leg provenance land in one admission, the agent is invoked as exactly that leg, and a reviewer after a chain-bound build never inherits the builder's custody (v48 integrity)", async () => {
      // A chain approval: the build takes the chain's custody in its insert.
      store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "claude-opus-4-1", "alex", T0);
      store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
      propose(store, { taskId: "t-1", goal: "guard the payouts", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0 });
      expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, approverToken).ok).toBe(true);
      expect(store.approvedChainOf("t-1")).not.toBeNull();
      const chainBuild = store.startRun({ taskRef, leaseId: "lease-chain", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", provider: "claude", now: T0, ...presented(store, taskRef, "builder"), custody: { kind: "base" } });
      const cycle = store.fallbackCycleFor(taskRef)!;
      expect(cycle).toMatchObject({ state: "open", cursor: 0, tailRun: chainBuild });
      storeEvidence(store, evidenceRoot, chainBuild, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
      store.recordOutcomeFacts(chainBuild, { headRevision: "head-bbb", handoff: "guarded the payout" });
      store.finishRun(chainBuild, { outcome: "built", committed: true, now: T0 });

      // requestReview queues under the sealed route; nothing is spawned yet.
      const asked = store.requestReview(chainBuild, "alex", T0);
      if (!asked.ok) throw new Error(`request failed: ${asked.reason}`);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
      // admitReview opens the reviewer row WITH its review-leg provenance in
      // one transaction — and the pass then actually invokes the agent.
      const spawned: { args: string[]; cwd: string }[] = [];
      const reports = await passOnce(async (_file, args, options) => {
        spawned.push({ args: [...args], cwd: options?.cwd ?? "" });
        return reviewingAgent({ version: 1, comments: [] })(_file, args, options);
      });
      expect(reports[0]).toMatchObject({ outcome: "reviewed" });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.args[spawned[0].args.indexOf("--model") + 1]).toBe("claude-opus-4-1");
      const reviewer = store.runsFor(taskRef).find(run => run.role === "reviewer")!;
      expect(reviewer).toMatchObject({ parentRun: chainBuild, provider: "claude", model: "claude-opus-4-1", outcome: "no-change", chainCycle: null, chainIndex: null, entryDigest: null });
      expect(store.runRoute(reviewer.id)).toMatchObject({ phase: "review", provider: "claude", model: "claude-opus-4-1", chosen: "recommended", routeDigest: routeDigestOf(store.approvedRouteOf("t-1")!) });
      expect(reviewer.providerStartedAt).not.toBeNull();
      // The chain's custody never moved to the reviewer.
      expect(store.fallbackCycleFor(taskRef)?.tailRun ?? chainBuild).toBe(chainBuild);
      expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.id)).toMatchObject({ consumed_reason: "reviewed" });
      // Exactly one review per source: a second request refuses, a second pass spawns nothing.
      expect(store.requestReview(chainBuild, "alex", T0)).toMatchObject({ ok: false, reason: "already-reviewed" });
      const again = await passOnce(async () => { spawned.push({ args: [], cwd: "" }); return { ...OK, stdout: SAID }; });
      expect(again).toHaveLength(0);
      expect(spawned).toHaveLength(1);
    });

    test("a reviewer this runner reports unavailable is never substituted: the request stays open, the pass says why (v47)", async () => {
      store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "alex", T0);
      store.recordProviderReadiness("builder-1", [{ provider: "codex", state: "unavailable", reason: "`codex login status` says not logged in", probe: "identity" }], T0);
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      let calls = 0;
      const reports = await passOnce(async () => {
        calls += 1;
        return { ...OK, stdout: SAID };
      });
      expect(calls).toBe(0);
      expect(reports[0]).toMatchObject({ outcome: "skipped" });
      expect(reports[0]?.detail).toContain("codex is reported unavailable on builder-1");
      expect(reports[0]?.detail).toContain("nothing substitutes");
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
      // Another runner that never reported codex admits it (unknown is not
      // unavailable) and spends the attempt on the routed provider.
      let otherCalls = 0;
      const other = await reviewPass(store, { runner: "builder-2", token: "tok-builder-2", now: T0, evidenceRoot, scratchRoot, agent: async () => { otherCalls += 1; return { ...OK, stdout: SAID }; } });
      expect(other[0]?.outcome).not.toBe("skipped");
      expect(otherCalls).toBe(1);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(1);
      expect(store.runsFor(taskRef).find(run => run.role === "reviewer")?.provider).toBe("codex");
    });

    test("admission re-proves the review leg INSIDE its transaction: a provider/model mismatch, a null model, an unavailable provider, and an unreadable route all refuse before any run exists (v47)", async () => {
      store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "claude-sonnet-4", "alex", T0);
      propose(store, { taskId: "t-1", goal: "guard the payouts", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0 });
      expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, approverToken).ok).toBe(true);
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      const admit = (spec: { provider: string; model: string | null }, runner = "builder-1", token = "tok-builder-1") =>
        store.admitReview(asked.id, { runner, token, ...spec }, T0);
      // Another provider, another model, no model: refused, request still open.
      expect(admit({ provider: "codex", model: "gpt-5-codex" })).toMatchObject({ ok: false, reason: "route-mismatch" });
      expect(admit({ provider: "claude", model: "claude-opus-4-1" })).toMatchObject({ ok: false, reason: "route-mismatch" });
      const nullModel = admit({ provider: "claude", model: null });
      expect(nullModel).toMatchObject({ ok: false, reason: "route-mismatch" });
      if (!nullModel.ok) expect(nullModel.detail).toContain("with no model");
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
      // The exact leg, but the provider is reported unavailable on this runner.
      store.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unavailable", reason: "not installed", probe: "version" }], T0);
      expect(admit({ provider: "claude", model: "claude-sonnet-4" })).toMatchObject({ ok: false, reason: "provider-unavailable" });
      expect(store.openReviewRequests()).toHaveLength(1);
      // Route data removed from the routed row: the request is spent, unrun, in words.
      const kept = store.getScope("t-1")!.approvedRouteJson;
      store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 't-1'").run();
      expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "route-unreadable" });
      const unreadable = admit({ provider: "claude", model: "claude-sonnet-4" }, "builder-2", "tok-builder-2");
      expect(unreadable).toMatchObject({ ok: false, reason: "route-changed" });
      if (!unreadable.ok) expect(unreadable.detail).toContain("sealed no agent route");
      expect(store.openReviewRequests()).toHaveLength(0);
      expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "route-unreadable" });
      // Restored: the exact leg admits, and the run carries its provenance.
      store.raw().prepare("UPDATE task_scope SET approved_route_json = ? WHERE task_id = 't-1'").run(kept);
      const again = store.requestReview(builtRun, "alex", new Date(T0.getTime() + 1_000));
      if (!again.ok) throw new Error("request failed");
      const admitted = store.admitReview(again.id, { runner: "builder-2", token: "tok-builder-2", provider: "claude", model: "claude-sonnet-4" }, T0);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expect(store.runRoute(admitted.reviewerRunId)).toMatchObject({ phase: "review", provider: "claude", model: "claude-sonnet-4", chosen: "recommended", routeDigest: routeDigestOf(store.approvedRouteOf("t-1")!) });
    });

    test("a request queued under one sealed route is spent unrun when the task is re-approved under another (v47)", async () => {
      store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "claude-sonnet-4", "alex", T0); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "claude-sonnet-4", "alex", T0);
      propose(store, { taskId: "t-1", goal: "guard the payouts", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0, riskLevel: "high" });
      const first = store.getScope("t-1")!;
      expect(approve(store, "t-1", "alex", T0, first.digest, approverToken).ok).toBe(true);
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      // The route changes and is re-approved: the old request no longer
      // names the sealed route.
      const edited = store.editTaskRoute(taskRef, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "claude-opus-4-1" } }, T0);
      if (!edited.ok) throw new Error(edited.detail);
      expect(approve(store, "t-1", "alex", T0, edited.scope!.digest, approverToken).ok).toBe(true);
      let calls = 0;
      const reports = await passOnce(async () => {
        calls += 1;
        return { ...OK, stdout: SAID };
      });
      expect(calls).toBe(0);
      expect(reports).toEqual([{ requestId: asked.id, run: builtRun, outcome: "skipped", detail: "route-changed: the task was approved again under a different route" }]);
      expect(store.openReviewRequests()).toHaveLength(0);
      expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.id)?.["consumed_reason"]).toBe("route-changed");
      // A fresh request under the new seal reviews normally.
      expect(store.requestReview(builtRun, "alex", new Date(T0.getTime() + 1_000)).ok).toBe(true);
      const again = await passOnce(reviewingAgent({ version: 1, comments: [] }));
      expect(again[0]).toMatchObject({ outcome: "reviewed" });
    });

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

    test("a mutable caller cannot reroute a durably admitted reviewer", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      const admitted = store.admitReview(
        asked.id,
        { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: "claude-opus-4-1" },
        T0,
      );
      if (!admitted.ok) throw new Error("admission failed");
      let calls = 0;
      const result = await review(store, {
        sourceRunId: builtRun,
        reviewerRunId: admitted.reviewerRunId,
        taskId: "t-1",
        taskTitle: "wire the payout guard",
        provider: "codex",
        model: null,
        now: T0,
        evidenceRoot,
        scratchRoot,
        agent: async () => {
          calls += 1;
          return { ...OK, stdout: SAID };
        },
      });

      expect(result).toMatchObject({ ok: false, reason: "review-admission" });
      expect(calls).toBe(0);
      expect(store.getRun(admitted.reviewerRunId)?.providerStartedAt).toBeNull();
    });

    test("accepted correction and its admitted root both close atomically with ingest", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      const admitted = store.admitReview(
        asked.id,
        { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null },
        T0,
      );
      if (!admitted.ok) throw new Error("admission failed");
      let calls = 0;
      const result = await review(store, {
        sourceRunId: builtRun,
        reviewerRunId: admitted.reviewerRunId,
        taskId: "t-1",
        taskTitle: "wire the payout guard",
        provider: "claude",
        model: null,
        now: T0,
        evidenceRoot,
        scratchRoot,
        agent: async () => {
          calls += 1;
          return {
            ...OK,
            stdout:
              calls === 1
                ? spokenInSession("not json")
                : spokenInSession({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "fixed" }] }),
          };
        },
      });

      expect(result).toMatchObject({ ok: true, commentCount: 1 });
      const reviews = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviews[0]).toMatchObject({
        id: admitted.reviewerRunId,
        outcome: "no-change",
        reason: "reviewed — 1 comment(s)",
      });
      expect(reviews[1]).toMatchObject({ outcome: "no-change", reason: "structured review repaired" });
      expect(store.liveDiffComments(builtRun)[0]?.reviewerRun).toBe(reviews[1]?.id);
    });

    test("a malformed reply is corrected in the same session and the child reviewer authors the one ingest", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("ask failed");
      let calls = 0;
      const argvSeen: string[][] = [];
      const timeouts: (number | undefined)[] = [];
      const repairingAgent: Runner = async (_file, args, options) => {
        calls += 1;
        argvSeen.push([...args]);
        timeouts.push(options?.timeoutMs);
        if (calls === 1) {
          return { ...OK, stdout: spokenInSession({ version: 1, comments: "not-an-array" }) };
        }
        const prompt = String(args[args.indexOf("-p") + 1] ?? "");
        expect(prompt).toContain("comments must be an array");
        expect(prompt).toContain("complete signed criterion-id set");
        expect(prompt).toContain("cannot-tell");
        return {
          ...OK,
          stdout: spokenInSession({
            version: 1,
            comments: [{ path: "src/payouts.ts", line: 2, note: "the limiter is never awaited", severity: "problem" }],
          }),
        };
      };

      const reports = await passOnce(repairingAgent);
      expect(reports).toEqual([{ requestId: asked.id, run: builtRun, outcome: "reviewed", detail: "1 comment(s)" }]);
      expect(calls).toBe(2);
      expect(argvSeen[0]).not.toContain("--resume");
      expect(argvSeen[1]).toEqual(expect.arrayContaining(["--resume", "review-session-1", "--max-turns", "4"]));
      expect(timeouts).toEqual([undefined, 5 * 60_000]);

      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns).toHaveLength(2);
      const rootReview = reviewRuns[0];
      const correction = reviewRuns[1];
      expect(rootReview).toMatchObject({ parentRun: builtRun, outcome: "no-change", sessionId: "review-session-1" });
      expect(correction).toMatchObject({ parentRun: rootReview?.id, outcome: "no-change", reason: "structured review repaired", sessionId: "review-session-1" });
      const comments = store.liveDiffComments(builtRun);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.reviewerRun).toBe(correction?.id);

      const firstEvidence = store.artifactsFor(rootReview?.id ?? -1).filter(one => one.kind === "structured-output");
      const repairedEvidence = store.artifactsFor(correction?.id ?? -1).filter(one => one.kind === "structured-output");
      expect(firstEvidence).toHaveLength(1);
      expect(firstEvidence[0]?.capture).toContain("not accepted");
      expect(repairedEvidence).toHaveLength(1);
      expect(repairedEvidence[0]?.capture).toContain("accepted");
    });

    test("syntax-only wrappers normalize without spending a correction turn", async () => {
      store.requestReview(builtRun, "alex", T0);
      let calls = 0;
      const wrapped: Runner = async () => {
        calls += 1;
        return {
          ...OK,
          stdout: spokenInSession('```json\n{"version":1,"comments":[]}\n```'),
        };
      };
      const reports = await passOnce(wrapped);
      expect(reports[0]?.outcome).toBe("reviewed");
      expect(calls).toBe(1);
      const reviewerRun = store.runsFor(taskRef).find(run => run.role === "reviewer");
      const attempts = store.artifactsFor(reviewerRun?.id ?? -1).filter(one => one.kind === "structured-output");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.capture).toContain("accepted, syntax normalized");
    });

    test("two malformed corrections exhaust the bound and leave a truthful linear run/evidence trail", async () => {
      store.requestReview(builtRun, "alex", T0);
      let calls = 0;
      const prompts: string[] = [];
      const broken: Runner = async (_file, args, options) => {
        calls += 1;
        prompts.push(String(args[args.indexOf("-p") + 1] ?? ""));
        if (calls > 1) {
          expect(args).toEqual(expect.arrayContaining(["--resume", "review-session-1", "--max-turns", "4"]));
          expect(options?.timeoutMs).toBe(5 * 60_000);
        }
        if (calls === 1) return { ...OK, stdout: spokenInSession("not json") };
        if (calls === 2) return { ...OK, stdout: spokenInSession({ version: 2, comments: [] }) };
        return { ...OK, stdout: spokenInSession({ version: 1, comments: [{ path: "outside.ts", note: "guess" }] }) };
      };

      const reports = await passOnce(broken);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "malformed-review" });
      expect(calls).toBe(3);
      expect(prompts[1]).toContain("not JSON");
      expect(prompts[2]).toContain("version must be 1");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);

      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns).toHaveLength(3);
      expect(reviewRuns.map(run => run.parentRun)).toEqual([builtRun, reviewRuns[0]?.id, reviewRuns[1]?.id]);
      expect(reviewRuns.map(run => run.outcome)).toEqual(["failed", "failed", "failed"]);
      expect(reviewRuns.map(run => store.artifactsFor(run.id).filter(one => one.kind === "structured-output").length)).toEqual([1, 1, 1]);
    });

    test("provider failure with a session id is not repaired", async () => {
      store.requestReview(builtRun, "alex", T0);
      let calls = 0;
      const failedProviderTurn: Runner = async () => {
        calls += 1;
        return { ...OK, code: 1, stdout: spokenInSession("not json") };
      };
      const reports = await passOnce(failedProviderTurn);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "agent" });
      expect(calls).toBe(1);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(1);
    });

    test.each([
      ["does not announce a session", null],
      ["announces a different session", "review-session-2"],
    ])("a correction that %s is rejected before review ingestion", async (_label, returnedSession) => {
      store.requestReview(builtRun, "alex", T0);
      let calls = 0;
      const wrongSession: Runner = async () => {
        calls += 1;
        if (calls === 1) return { ...OK, stdout: spokenInSession("not json") };
        const reply = { version: 1, comments: [] };
        return {
          ...OK,
          stdout: returnedSession === null ? spoken(reply) : spokenInSession(reply, returnedSession),
        };
      };

      const reports = await passOnce(wrongSession);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "provider-protocol" });
      expect(calls).toBe(2);
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns).toHaveLength(2);
      expect(reviewRuns[1]).toMatchObject({ outcome: "refused", reason: "provider-protocol" });
      expect(store.artifactsFor(reviewRuns[1]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    });

    test("a correction refused by the provider protocol still seals its exact reply", async () => {
      store.requestReview(builtRun, "alex", T0);
      let calls = 0;
      const conflictingSession: Runner = async () => {
        calls += 1;
        if (calls === 1) return { ...OK, stdout: spokenInSession("not json") };
        return {
          ...OK,
          stdout: [
            JSON.stringify({ type: "system", subtype: "init", session_id: "review-session-1" }),
            JSON.stringify({ type: "system", subtype: "init", session_id: "review-session-2" }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "review-session-1",
              result: JSON.stringify({ version: 1, comments: [] }),
            }),
          ].join("\n"),
        };
      };

      const reports = await passOnce(conflictingSession);
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "provider-protocol" });
      expect(calls).toBe(2);
      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns[1]).toMatchObject({ outcome: "refused", reason: "provider-protocol" });
      const evidence = store.artifactsFor(reviewRuns[1]?.id ?? -1).filter(one => one.kind === "structured-output");
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.capture).toContain("not accepted");
    });

    test("a runner rotation during the root turn is caught before a correction run is opened", async () => {
      store.requestReview(builtRun, "alex", T0);
      let now = T0;
      let calls = 0;
      const rotatingAgent: Runner = async () => {
        calls += 1;
        register(store, {
          name: "builder-1",
          host: "rotated-host",
          capacity: 9,
          repos: [REPO],
          now: new Date(T0.getTime() + 1_000),
          newToken: () => "tok-rotated",
        });
        // The correction row is newer than the rotation. Custody must still
        // bind to the admitted root reviewer's earlier incarnation.
        now = new Date(T0.getTime() + 2_000);
        return { ...OK, stdout: spokenInSession("not json") };
      };
      const reports = await reviewPass(store, {
        runner: "builder-1",
        token: "tok-builder-1",
        now: T0,
        clock: () => now,
        evidenceRoot,
        scratchRoot,
        agent: rotatingAgent,
      });
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "runner-custody" });
      expect(calls).toBe(1);
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns).toHaveLength(1);
      expect(reviewRuns[0]).toMatchObject({ parentRun: builtRun, outcome: "failed", reason: "reviewer-runner-custody" });
    });

    test("a runner rotation during a valid correction is caught before review ingestion", async () => {
      store.requestReview(builtRun, "alex", T0);
      let now = T0;
      let calls = 0;
      const rotatingCorrection: Runner = async () => {
        calls += 1;
        if (calls === 1) return { ...OK, stdout: spokenInSession("not json") };
        register(store, {
          name: "builder-1",
          host: "rotated-host",
          capacity: 9,
          repos: [REPO],
          now: new Date(T0.getTime() + 1_000),
          newToken: () => "tok-rotated",
        });
        now = new Date(T0.getTime() + 2_000);
        return { ...OK, stdout: spokenInSession({ version: 1, comments: [] }) };
      };

      const reports = await reviewPass(store, {
        runner: "builder-1",
        token: "tok-builder-1",
        now: T0,
        clock: () => now,
        evidenceRoot,
        scratchRoot,
        agent: rotatingCorrection,
      });
      expect(reports[0]).toMatchObject({ outcome: "failed", detail: "runner-custody" });
      expect(calls).toBe(2);
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      const reviewRuns = store.runsFor(taskRef).filter(run => run.role === "reviewer").sort((a, b) => a.id - b.id);
      expect(reviewRuns).toHaveLength(2);
      expect(reviewRuns[1]).toMatchObject({ parentRun: reviewRuns[0]?.id, outcome: "refused", reason: "runner-custody" });
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
      const reviewerRow = store.raw().prepare("SELECT id, outcome, reason FROM run WHERE role = 'reviewer'").get() as
        | { id: number; outcome: string; reason: string }
        | undefined;
      expect(reviewerRow).toMatchObject({ outcome: "failed", reason: "reviewer-dirty-scratch" });
      const attempts = store.artifactsFor(reviewerRow?.id ?? -1).filter(one => one.kind === "structured-output");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.capture).toContain("not accepted");
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

    test("run 1467's fix: a malformed-review failure persists a bounded, sanitized parse diagnostic explaining WHY", async () => {
      store.requestReview(builtRun, "alex", T0);
      const brokenAgent: Runner = async () => ({ ...OK, stdout: JSON.stringify({ result: "not json at all ```" }) });
      const reports = await passOnce(brokenAgent);
      expect(reports[0]?.detail).toBe("malformed-review");
      const reviewerRow = store.raw().prepare("SELECT outcome, reason FROM run WHERE role = 'reviewer'").get() as
        | { outcome: string; reason: string }
        | undefined;
      expect(reviewerRow?.outcome).toBe("failed");
      // The stored reason explains itself: the short code, the structural
      // problem, AND (best-effort) what the agent actually said — a future
      // reader never needs a live repro to see why this one failed.
      expect(reviewerRow?.reason.startsWith("reviewer-malformed-review: ")).toBe(true);
      expect(reviewerRow?.reason).toContain("not JSON");
      expect(reviewerRow?.reason).toContain("not json at all");
      // Bounded: even an adversarial reply cannot grow the stored row past
      // the shared diagnostic cap plus the short prefix.
      expect(Buffer.byteLength(reviewerRow?.reason ?? "", "utf8")).toBeLessThan(2200);
      const request = store.raw().prepare("SELECT consumed_reason FROM review_request").get() as
        | { consumed_reason: string }
        | undefined;
      expect(request?.consumed_reason).toBe(reviewerRow?.reason);
    });

    test("run 1467's fix: an adversarial spoken reply with a secret-shaped string withholds the diagnostic, never quotes it", async () => {
      store.requestReview(builtRun, "alex", T0);
      // Not valid review JSON (so parseReview refuses it) AND shaped like a
      // credential — the diagnostic path must refuse to persist it intact.
      const leaking: Runner = async () => ({
        ...OK,
        stdout: JSON.stringify({ result: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      });
      const reports = await passOnce(leaking);
      expect(reports[0]?.detail).toBe("malformed-review");
      const reviewerRow = store.raw().prepare("SELECT reason FROM run WHERE role = 'reviewer'").get() as { reason: string } | undefined;
      expect(reviewerRow?.reason).not.toContain("sk-ant-api03");
      expect(reviewerRow?.reason).toContain("withheld");
    });

    test("run 1467's fix: a structured_output reply (the --json-schema turn) parses exactly like a plain result string", async () => {
      store.requestReview(builtRun, "alex", T0);
      const structuredAgent: Runner = async () => ({
        ...OK,
        stdout: spokenStructured({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "structured reply" }] }),
      });
      const reports = await passOnce(structuredAgent);
      expect(reports[0]?.outcome).toBe("reviewed");
      const comments = store.liveDiffComments(builtRun);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.note).toBe("structured reply");
    });

    test("a truncated diff never spawns an agent", async () => {
      const truncated = seedBuilt(PATCH, { truncated: true });
      const reviewer = store.startRun({ taskRef, leaseId: "review:t", runner: "builder-1", role: "reviewer", parentRun: truncated.runId, now: T0, ...presented(store, taskRef, "reviewer") });
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
      const asked = store.requestReview(builtRun, "mode standard", T0, { kind: "mode", digest: "deadbeefdeadbeefdeadbeefdeadbeef" });
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

    test("the digest binding is EXACT: a renewal does not inherit its predecessor's queued asks", async () => {
      const termsA = presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(termsA), digest: modeDigestOf(termsA), signedBy: "alex", absoluteExpiry: termsA.absoluteExpiry, publication: termsA.publication },
        T0,
      );
      store.requestReview(builtRun, "mode standard", T0, { kind: "mode", digest: modeDigestOf(termsA) });
      // Renew: same name, different expiry — a NEW signature with a new
      // digest, reviewAuto still true. The old mode's ask must die.
      const termsB = presetTerms("standard", new Date(T0.getTime() + 48 * 60 * 60_000).toISOString());
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(termsB), digest: modeDigestOf(termsB), signedBy: "alex", absoluteExpiry: termsB.absoluteExpiry, publication: termsB.publication },
        T0,
      );
      expect(modeDigestOf(termsB)).not.toBe(modeDigestOf(termsA));
      const reports = await passOnce(reviewingAgent({ version: 1, comments: [] }));
      expect(reports[0]?.outcome).toBe("skipped");
      expect(reports[0]?.detail).toBe("mode-ended");
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'reviewer'").get()?.["n"]).toBe(0);
    });

    test("authority is the typed basis, never the display string: a person named 'mode:…' runs as human", async () => {
      const asked = store.requestReview(builtRun, "mode:evil-imposter", T0);
      expect(asked.ok).toBe(true);
      const reports = await passOnce(reviewingAgent({ version: 1, comments: [] }));
      expect(reports[0]?.outcome).toBe("reviewed");
    });

    test("admission is one winner: a second admit finds the request gone, and a crash leaves a spent request + open run", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("ask");
      const first = store.admitReview(asked.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      if (!first.ok) throw new Error("admit");
      expect(store.admitReview(asked.id, { runner: "builder-2", token: "tok-builder-2", provider: "claude", model: null }, T0)).toEqual({ ok: false, reason: "gone" });
      // The crash shape: request spent 'dispatched', run open with outcome
      // NULL — a visible cut-down attempt, not a stuck queue.
      const request = store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.id);
      expect(request).toMatchObject({ consumed_reason: "dispatched" });
      expect(store.getRun(first.reviewerRunId)?.outcome).toBeNull();
      expect(store.openReviewRequests()).toHaveLength(0);
    });

    test("a rotated credential cannot admit: the stale token refuses in-txn and the request stays OPEN for the fresh one (review finding 4)", () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("ask");
      // The takeover: the same name re-registers, rotating the credential.
      // Reviewer runs hold no task claim, so this txn-time identity proof is
      // the ONLY thing standing between a stale process and an admission.
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-rotated" });

      const stale = store.admitReview(asked.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(stale).toMatchObject({ ok: false, reason: "unauthenticated", detail: "bad-token" });

      // Nothing was spent: the request is unconsumed, no reviewer run exists.
      expect(store.raw().prepare("SELECT consumed_at FROM review_request WHERE id = ?").get(asked.id)).toMatchObject({ consumed_at: null });
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'reviewer'").get()?.["n"]).toBe(0);

      // The fresh credential admits the SAME request — the refusal cost nothing.
      const fresh = store.admitReview(asked.id, { runner: "builder-1", token: "tok-rotated", provider: "claude", model: null }, T0);
      expect(fresh).toMatchObject({ ok: true, sourceRun: builtRun });
    });

    test("the daily run rail refuses admission atomically and leaves the request OPEN", async () => {
      const terms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), dailyRunCap: 1 };
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
        T0,
      );
      const second = seedBuilt();
      const askedA = store.requestReview(builtRun, "alex", T0);
      const askedB = store.requestReview(second.runId, "alex", T0);
      if (!askedA.ok || !askedB.ok) throw new Error("asks");
      const admitA = store.admitReview(askedA.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(admitA.ok).toBe(true);
      const admitB = store.admitReview(askedB.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(admitB).toMatchObject({ ok: false, reason: "railed", rail: "daily-runs" });
      // Open for a later pass — the rail spends no request.
      expect(store.openReviewRequests()).toHaveLength(1);
    });

    test("an overwritten patch is dirty scratch: comments must bind to the sealed bytes", async () => {
      store.requestReview(builtRun, "alex", T0);
      const tamperingAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        if (cwd !== "") writeFileSync(join(cwd, REVIEW_PATCH_NAME), PATCH + "+tampered\n");
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      };
      const reports = await passOnce(tamperingAgent);
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("dirty-scratch");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    });

    test("a written file — even the old mailbox convention's exact name — is not read back: the answer must ride the final message", async () => {
      store.requestReview(builtRun, "alex", T0);
      const oldStyleAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        if (cwd !== "") {
          writeFileSync(
            join(cwd, "STANDING-ORDERS-REVIEW-0123456789abcdef.json"),
            JSON.stringify({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "should never be read" }] }),
          );
        }
        // No finalMessage at all: an agent reverting to the old
        // write-a-file habit says nothing the new protocol listens for.
        return { ...OK, stdout: JSON.stringify({}) };
      };
      const reports = await passOnce(oldStyleAgent);
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("dirty-scratch");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    });

    test("a normal review writes nothing to the scratch at all — the whole answer is the final message", async () => {
      store.requestReview(builtRun, "alex", T0);
      let sawFiles: string[] = [];
      const inspectingAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        sawFiles = cwd === "" ? [] : readdirSync(cwd);
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      };
      const reports = await passOnce(inspectingAgent);
      expect(sawFiles).toEqual([REVIEW_PATCH_NAME]);
      expect(reports[0]?.outcome).toBe("reviewed");
    });

    test("a mode-derived request under a live reviewAuto mode runs", async () => {
      const terms = presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
        T0,
      );
      store.requestReview(builtRun, "mode standard", T0, { kind: "mode", digest: modeDigestOf(terms) });
      const reports = await passOnce(reviewingAgent({ version: 1, comments: [] }));
      expect(reports[0]?.outcome).toBe("reviewed");
      expect(reports[0]?.detail).toBe("0 comment(s)");
    });
  });

  describe("v40: evidence-review-v1 end to end", () => {
    let scratchRoot: string;
    beforeEach(() => {
      scratchRoot = mkdtempSync(join(tmpdir(), "so-review-scratch-"));
    });
    afterEach(() => {
      rmSync(scratchRoot, { recursive: true, force: true });
    });

    const CRITERION = { id: "c1", statement: "The payout guard is wired in.", how: null, evidence: ["manual-review"] as const };
    // v47: a routed scope reviews only under a STANDING approval — the
    // rubric fixture files exact agents and approves, as a real task would.
    const seedRubric = () => {
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
      const scope = propose(store, { taskId: "t-1", goal: "wire the payout guard", acceptance: [CRITERION], now: T0 });
      const sealed = approve(store, "t-1", "alex", T0, scope.digest, approverToken);
      if (!sealed.ok) throw new Error(`seedRubric: ${sealed.reason}`);
      store.stampRun(builtRun, { scopeDigest: sealed.scope.digest });
    };
    const seedProofArtifact = (runId: number) => {
      const proof = {
        version: 1,
        criteria: [{ id: "c1", statement: CRITERION.statement, verdict: "met", how: "eyeballed the diff", evidence: [{ kind: "manual-review", ref: "looked at it" }] }],
      };
      storeEvidence(store, evidenceRoot, runId, "proof", "proof.json", Buffer.from(JSON.stringify(proof), "utf8"), "agent-authored", T0);
    };
    const CHECK_LOG_TEXT = "$ npm test\n(exit 0)\n\n--- stdout ---\n214 tests passed.\n\n--- stderr ---\n";
    const seedCheckLog = (runId: number): number =>
      storeEvidence(store, evidenceRoot, runId, "check-log", "check-log.txt", Buffer.from(CHECK_LOG_TEXT, "utf8"), 'sh -c "npm test" (exit 0)', T0);
    // A real, tiny (1x1) PNG — the same fixture proof.ts's own screenshot
    // tests use: a valid signature and header, never a placeholder.
    const ONE_BY_ONE_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const seedScreenshot = (runId: number): number =>
      storeEvidence(store, evidenceRoot, runId, "screenshot", "screenshot-abc.png", ONE_BY_ONE_PNG, "agent-claimed screenshot at docs/before.png (validated png)", T0);

    const seedVerdict = (runId: number, verdict: "short" | "attested" = "short") => {
      const row: CriterionMatrixRow = {
        id: "c1",
        statement: CRITERION.statement,
        requiredEvidence: ["manual-review"],
        state: "manual-review",
        detail: ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'],
        answered: [{ kind: "manual-review", ref: "looked at it" }],
        review: null,
      };
      store.saveProofVerdict(runId, verdict, ["needs a human look"], T0, [row]);
    };

    const criteriaAgent =
      (criteria: readonly { id: string; judgement: string; note: string }[], extra: Record<string, string> = {}): Runner =>
      async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        for (const [file, content] of Object.entries(extra)) {
          if (cwd !== "") writeFileSync(join(cwd, file), content);
        }
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria }) };
      };

    const passOnce = (agent: Runner) => reviewPass(store, { runner: "builder-1", token: "tok-builder-1", now: T0, evidenceRoot, scratchRoot, agent });

    test("a rubric-bearing run materializes REVIEW-RUBRIC.json and REVIEW-PROOF.json for the agent to read", async () => {
      seedRubric();
      seedProofArtifact(builtRun);
      seedVerdict(builtRun);
      store.requestReview(builtRun, "alex", T0);
      let sawRubric = false;
      let sawProof = false;
      const inspectingAgent: Runner = async (_file, args, options) => {
        const cwd = options?.cwd ?? "";
        sawRubric = existsSync(join(cwd, REVIEW_RUBRIC_NAME));
        sawProof = existsSync(join(cwd, REVIEW_PROOF_NAME));
        const prompt = String(args[args.indexOf("-p") + 1] ?? "");
        expect(prompt).toContain(CRITERION.statement);
        return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "cannot-tell", note: "the patch alone does not show this" }] }) };
      };
      const reports = await passOnce(inspectingAgent);
      expect(sawRubric).toBe(true);
      expect(sawProof).toBe(true);
      expect(reports[0]?.outcome).toBe("reviewed");
    });

    test("a run with no signed rubric writes no rubric or proof file — byte-identical grandfathering", async () => {
      // No propose() call: t-1 has no acceptance rubric at all.
      store.requestReview(builtRun, "alex", T0);
      let sawRubric = false;
      let sawProof = false;
      const inspectingAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        sawRubric = existsSync(join(cwd, REVIEW_RUBRIC_NAME));
        sawProof = existsSync(join(cwd, REVIEW_PROOF_NAME));
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      };
      const reports = await passOnce(inspectingAgent);
      expect(sawRubric).toBe(false);
      expect(sawProof).toBe(false);
      expect(reports[0]?.outcome).toBe("reviewed");
    });

    test("a result built under an earlier scope is refused before the reviewer runs", async () => {
      seedRubric();
      seedVerdict(builtRun, "short");
      // A review asked for under a scope that is then rewritten (v47): the
      // request cannot even be filed once the approval no longer stands…
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      propose(store, {
        taskId: "t-1",
        goal: "wire and alarm the payout guard",
        acceptance: [{ ...CRITERION, id: "new", statement: "The payout guard is wired in and alarmed." }],
        now: new Date(T0.getTime() + 1_000),
      });
      expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "route-unapproved" });
      let calls = 0;

      // …and the queued one is skipped in words, unspent, until a person
      // approves the current scope — nothing reviews under agents nobody
      // approved.
      const reports = await passOnce(async () => {
        calls += 1;
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      });

      expect(reports[0]).toMatchObject({ outcome: "skipped" });
      expect(reports[0]?.detail).toContain("approved and then changed");
      expect(calls).toBe(0);
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
      expect(store.proofVerdictFor(builtRun)?.verdict).toBe("short");
    });

    test("a judgement for an id absent from the signed rubric refuses the whole pass — nothing ingested", async () => {
      seedRubric();
      seedVerdict(builtRun);
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(criteriaAgent([{ id: "not-signed", judgement: "upholds", note: "x" }]));
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("malformed-review");
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
      expect(store.proofVerdictFor(builtRun)?.verdict).toBe("short");
    });

    test("tampering with REVIEW-RUBRIC.json refuses the whole pass", async () => {
      seedRubric();
      seedVerdict(builtRun);
      store.requestReview(builtRun, "alex", T0);
      const tamperingAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        if (cwd !== "") writeFileSync(join(cwd, REVIEW_RUBRIC_NAME), "[]");
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      };
      const reports = await passOnce(tamperingAgent);
      expect(reports[0]?.detail).toBe("dirty-scratch");
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    });

    test("tampering with REVIEW-PROOF.json refuses the whole pass", async () => {
      seedRubric();
      seedProofArtifact(builtRun);
      seedVerdict(builtRun);
      store.requestReview(builtRun, "alex", T0);
      const tamperingAgent: Runner = async (_file, _args, options) => {
        const cwd = options?.cwd ?? "";
        if (cwd !== "") writeFileSync(join(cwd, REVIEW_PROOF_NAME), '{"version":1}');
        return { ...OK, stdout: spoken({ version: 1, comments: [] }) };
      };
      const reports = await passOnce(tamperingAgent);
      expect(reports[0]?.detail).toBe("dirty-scratch");
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    });

    test("contradicts refutes: the proof verdict moves and the pre-fold verdict is preserved as machine_verdict", async () => {
      seedRubric();
      seedVerdict(builtRun, "short");
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(criteriaAgent([{ id: "c1", judgement: "contradicts", note: "never actually wired in" }]));
      expect(reports[0]?.outcome).toBe("reviewed");
      expect(reports[0]?.verdict).toBe("refuted");
      const stored = store.proofVerdictFor(builtRun);
      expect(stored?.verdict).toBe("refuted");
      expect(stored?.machineVerdict).toBe("short");
      const row = stored?.matrix.find(one => one.id === "c1");
      expect(row?.state).toBe("failed");
      expect(row?.review).toMatchObject({ judgement: "contradicts", note: "never actually wired in" });
      const saved = store.criterionReviewsFor(builtRun);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ criterionId: "c1", judgement: "contradicts", author: "reviewer:claude·sonnet" });
    });

    test("cannot-tell changes nothing: the verdict stays short, and the judgement is recorded", async () => {
      seedRubric();
      seedVerdict(builtRun, "short");
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(criteriaAgent([{ id: "c1", judgement: "cannot-tell", note: "the patch alone cannot settle this" }]));
      expect(reports[0]?.verdict).toBe("short");
      const stored = store.proofVerdictFor(builtRun);
      expect(stored?.verdict).toBe("short");
      expect(stored?.matrix.find(one => one.id === "c1")?.review?.judgement).toBe("cannot-tell");
    });

    test("upholds never upgrades: a short run's verdict stays short even when the reviewer agrees", async () => {
      seedRubric();
      seedVerdict(builtRun, "short");
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(criteriaAgent([{ id: "c1", judgement: "upholds", note: "looks right" }]));
      expect(reports[0]?.verdict).toBe("short");
      expect(store.proofVerdictFor(builtRun)?.verdict).toBe("short");
    });

    test("a review with no criteria field against a signed rubric is refused wholesale — full coverage is required, comments included", async () => {
      seedRubric();
      seedVerdict(builtRun);
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(reviewingAgentFactory({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "looks fine" }] }));
      expect(reports[0]?.outcome).toBe("failed");
      expect(reports[0]?.detail).toBe("malformed-review");
      expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
      // Nothing folded: the verdict is untouched.
      expect(store.proofVerdictFor(builtRun)?.verdict).toBe("short");
      expect(store.proofVerdictFor(builtRun)?.machineVerdict).toBeNull();
    });

    test("a review against a task with NO signed rubric still ingests comments exactly as before — grandfathering holds", async () => {
      // No propose() call at all: t-1 carries no acceptance rubric.
      store.requestReview(builtRun, "alex", T0);
      const reports = await passOnce(reviewingAgentFactory({ version: 1, comments: [{ path: "src/payouts.ts", line: 2, note: "looks fine" }] }));
      expect(reports[0]?.outcome).toBe("reviewed");
      expect(store.liveDiffComments(builtRun)).toHaveLength(1);
      expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    });

    describe("audit hardening: check log, screenshots, and hash-bound bindings", () => {
      test("omission: no check log or screenshot artifacts exist — neither file is materialized, and the review still succeeds", async () => {
        seedRubric();
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        let sawCheckLog = false;
        let sawScreenshot = false;
        const inspectingAgent: Runner = async (_file, _args, options) => {
          const cwd = options?.cwd ?? "";
          sawCheckLog = existsSync(join(cwd, REVIEW_CHECK_LOG_NAME));
          sawScreenshot = readdirSync(cwd).some(one => one.startsWith("REVIEW-SCREENSHOT-"));
          return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "cannot-tell", note: "no log or screenshot exists" }] }) };
        };
        const reports = await passOnce(inspectingAgent);
        expect(sawCheckLog).toBe(false);
        expect(sawScreenshot).toBe(false);
        expect(reports[0]?.outcome).toBe("reviewed");
        const saved = store.criterionReviewsFor(builtRun);
        expect(saved).toHaveLength(1);
        expect(saved[0]?.checkLog).toBeNull();
        expect(saved[0]?.screenshots).toEqual([]);
      });

      test("materialization: an existing check log and screenshot are written into the scratch with their real bytes, and bound at ingest", async () => {
        seedRubric();
        seedCheckLog(builtRun);
        const shotArtifactId = seedScreenshot(builtRun);
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        let checkLogBytes: Buffer | null = null;
        let screenshotBytes: Buffer | null = null;
        const inspectingAgent: Runner = async (_file, args, options) => {
          const cwd = options?.cwd ?? "";
          if (existsSync(join(cwd, REVIEW_CHECK_LOG_NAME))) checkLogBytes = readFileSync(join(cwd, REVIEW_CHECK_LOG_NAME));
          const shotName = reviewScreenshotName(shotArtifactId, "png");
          if (existsSync(join(cwd, shotName))) screenshotBytes = readFileSync(join(cwd, shotName));
          const prompt = String(args[args.indexOf("-p") + 1] ?? "");
          expect(prompt).toContain(REVIEW_CHECK_LOG_NAME);
          expect(prompt).toContain(shotName);
          return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "checked the log and the screenshot" }] }) };
        };
        const reports = await passOnce(inspectingAgent);
        expect(checkLogBytes).toEqual(Buffer.from(CHECK_LOG_TEXT, "utf8"));
        expect(screenshotBytes).toEqual(ONE_BY_ONE_PNG);
        expect(reports[0]?.outcome).toBe("reviewed");
        const saved = store.criterionReviewsFor(builtRun);
        expect(saved).toHaveLength(1);
        expect(saved[0]?.checkLog?.artifact).toBe(store.artifactsFor(builtRun).find(a => a.kind === "check-log")?.id);
        expect(saved[0]?.screenshots).toEqual([{ artifact: shotArtifactId, sha256: expect.any(String), path: expect.any(String) }]);
        expect(saved[0]?.scopeDigest).toBe(store.getScope("t-1")?.digest ?? null);
        expect(saved[0]?.headSha).toBe("head-aaa");
      });

      test("the durable seam refuses omitted proof, check-log, or screenshot inputs and accepts only the exact inventory", () => {
        seedRubric();
        seedProofArtifact(builtRun);
        const checkLogId = seedCheckLog(builtRun);
        const screenshotId = seedScreenshot(builtRun);
        seedVerdict(builtRun);
        const reviewerRun = store.startRun({
          taskRef,
          leaseId: "review:exact-inventory",
          runner: "builder-1",
          role: "reviewer",
          parentRun: builtRun,
          provider: "claude",
          now: T0,
          ...presented(store, taskRef, "reviewer"),
        });
        store.stampProviderStart(reviewerRun, T0);

        const artifacts = store.artifactsFor(builtRun);
        const diff = artifacts.find(one => one.id === diffArtifact);
        const proof = artifacts.find(one => one.kind === "proof");
        const checkLog = artifacts.find(one => one.id === checkLogId);
        const screenshot = artifacts.find(one => one.id === screenshotId);
        const scope = store.getScope("t-1");
        if (diff === undefined || proof === undefined || checkLog === undefined || screenshot === undefined || scope === null) {
          throw new Error("incomplete exact-inventory fixture");
        }
        const base = {
          reviewerRunId: reviewerRun,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "the whole review is atomic", severity: "problem" as const }],
          judgements: [{ id: "c1", judgement: "upholds" as const, note: "the complete sealed evidence supports it" }],
        };
        const bindingBase = {
          diffSha: diff.sha256,
          scopeDigest: scope.digest,
          headSha: "head-aaa",
        };

        expect(() =>
          store.ingestReview(
            { ...base, bindings: { ...bindingBase, proof: null, checkLog: null, screenshots: [] } },
            T0,
          ),
        ).toThrow(/proof inventory/);
        expect(() =>
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: null,
                screenshots: [],
              },
            },
            T0,
          ),
        ).toThrow(/check-log inventory/);
        expect(() =>
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: { artifactId: checkLog.id, sha256: checkLog.sha256 },
                screenshots: [],
              },
            },
            T0,
          ),
        ).toThrow(/screenshot inventory/);
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.getRun(reviewerRun)?.outcome).toBeNull();

        expect(
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: { artifactId: checkLog.id, sha256: checkLog.sha256 },
                screenshots: [{ artifactId: screenshot.id, sha256: screenshot.sha256, path: screenshot.capture }],
              },
            },
            T0,
          ).commentIds,
        ).toHaveLength(1);
        expect(store.criterionReviewsFor(builtRun)).toHaveLength(1);
        expect(store.getRun(reviewerRun)?.outcome).toBe("no-change");
      });

      test("tamper: overwriting REVIEW-CHECK-LOG.txt refuses the whole pass — nothing ingested", async () => {
        seedRubric();
        seedCheckLog(builtRun);
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const tamperingAgent: Runner = async (_file, _args, options) => {
          const cwd = options?.cwd ?? "";
          if (cwd !== "") writeFileSync(join(cwd, REVIEW_CHECK_LOG_NAME), "forged: everything passed");
          return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "looks fine" }] }) };
        };
        const reports = await passOnce(tamperingAgent);
        expect(reports[0]?.detail).toBe("dirty-scratch");
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      });

      test("tamper: overwriting a screenshot's bytes refuses the whole pass — nothing ingested", async () => {
        seedRubric();
        const shotArtifactId = seedScreenshot(builtRun);
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const tamperingAgent: Runner = async (_file, _args, options) => {
          const cwd = options?.cwd ?? "";
          if (cwd !== "") writeFileSync(join(cwd, reviewScreenshotName(shotArtifactId, "png")), Buffer.from([0x00, 0x01, 0x02]));
          return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "looks fine" }] }) };
        };
        const reports = await passOnce(tamperingAgent);
        expect(reports[0]?.detail).toBe("dirty-scratch");
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
      });

      test("stale: a proof artifact rotted between materialization and ingestion refuses ingestion — rollback leaves neither comments nor judgements", async () => {
        seedRubric();
        seedProofArtifact(builtRun);
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const proofArtifactId = store.artifactsFor(builtRun).find(a => a.kind === "proof")?.id;
        if (proofArtifactId === undefined) throw new Error("seed");
        const staleAgent: Runner = async () => {
          // Simulate the proof artifact's stored bytes rotting AFTER the
          // reviewer was shown it but BEFORE ingestion — the exact race
          // ingestReview's re-validation exists to refuse.
          store.raw().prepare("UPDATE artifact SET sha256 = ? WHERE id = ?").run("f".repeat(64), proofArtifactId);
          return {
            ...OK,
            stdout: spoken({
              version: 1,
              comments: [{ path: "src/payouts.ts", line: 2, note: "fine" }],
              criteria: [{ id: "c1", judgement: "contradicts", note: "not actually wired in" }],
            }),
          };
        };
        const reports = await passOnce(staleAgent);
        expect(reports[0]?.outcome).toBe("failed");
        expect(reports[0]?.detail).toBe("stale-evidence");
        // Rollback (atomicity): neither the comment nor the judgement
        // landed — a partial ingest would be worse than none.
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.proofVerdictFor(builtRun)?.verdict).toBe("short");
        expect(store.proofVerdictFor(builtRun)?.machineVerdict).toBeNull();
      });

      test("stale: the terminal diff row changing after materialization refuses the whole ingest", async () => {
        seedRubric();
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const staleAgent: Runner = async () => {
          store.raw().prepare("UPDATE artifact SET sha256 = ? WHERE id = ?").run("e".repeat(64), diffArtifact);
          return {
            ...OK,
            stdout: spoken({
              version: 1,
              comments: [{ path: "src/payouts.ts", line: 2, note: "fine" }],
              criteria: [{ id: "c1", judgement: "upholds", note: "looks fine" }],
            }),
          };
        };

        const reports = await passOnce(staleAgent);
        expect(reports[0]).toMatchObject({ outcome: "failed", detail: "stale-evidence" });
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
      });

      test("stale: a scope revised between materialization and ingestion refuses ingestion", async () => {
        seedRubric();
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const revisingAgent: Runner = async () => {
          // The scope moves mid-review — a different signed rubric than
          // the one this reviewer was actually shown.
          propose(store, { taskId: "t-1", goal: "wire the payout guard", acceptance: [{ ...CRITERION, statement: "The payout guard is wired in AND alarmed." }], now: T0 });
          return { ...OK, stdout: spoken({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "looks fine" }] }) };
        };
        const reports = await passOnce(revisingAgent);
        expect(reports[0]?.outcome).toBe("failed");
        expect(reports[0]?.detail).toBe("stale-evidence");
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
      });

      test("stale: evidence added after materialization refuses the whole ingest", async () => {
        seedRubric();
        seedVerdict(builtRun);
        store.requestReview(builtRun, "alex", T0);
        const addingAgent: Runner = async () => {
          // Materialization saw no screenshots. A late artifact must not be
          // silently omitted from the durable inventory this review claims
          // it was shown.
          seedScreenshot(builtRun);
          return {
            ...OK,
            stdout: spoken({
              version: 1,
              comments: [{ path: "src/payouts.ts", line: 2, note: "must roll back with the stale review" }],
              criteria: [{ id: "c1", judgement: "cannot-tell", note: "the materialized inputs did not include a screenshot" }],
            }),
          };
        };

        const reports = await passOnce(addingAgent);
        expect(reports[0]).toMatchObject({ outcome: "failed", detail: "stale-evidence" });
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.proofVerdictFor(builtRun)?.machineVerdict).toBeNull();
      });
    });

    function reviewingAgentFactory(payload: unknown): Runner {
      return async () => ({ ...OK, stdout: spoken(payload) });
    }
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
    expect(open[0]?.basis).toBe("mode");
    expect(open[0]?.modeDigest).toBe(modeDigestOf(terms));

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

  test("Strict / release queues its isolated reviewer from the signed scope; Default stays on the fast path", () => {
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.createTask({ id: "t-strict", title: "release the payout guard" }, T0);
    const strictRef = store.refFor("built-in", "t-strict");
    store.placeTask(strictRef.id, REPO);
    const scope = propose(store, {
      taskId: "t-strict",
      goal: "release the guarded payout path",
      qualityMode: "strict",
      acceptance: [{ id: "c1", statement: "the payout path is guarded", how: null, evidence: ["changed-path"] }],
      now: T0,
    });
    const approved = approve(store, "t-strict", "alex", T0, scope.digest, approverToken);
    expect(approved.ok).toBe(true);

    const strictRun = store.startRun({
      taskRef: strictRef.id,
      leaseId: "lease-strict",
      runner: "builder-1",
      branch: "standing-orders/t-strict",
      worktree: "/pool/t-strict",
      now: T0,
      ...presented(store, strictRef.id, "builder"),
    });
    expect(store.getRun(strictRun)?.qualityMode).toBe("strict");
    store.stampRun(strictRun, { scopeDigest: scope.digest });
    storeEvidence(store, evidenceRoot, strictRun, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH), "git diff (exit 0)", T0, { captureStatus: "ok" });
    store.finishRun(strictRun, { outcome: "built", committed: true, now: T0 });

    maybeRequestAutoReview(store, REPO, strictRun, true, false, T0);
    expect(store.openReviewRequests()).toMatchObject([
      { run: strictRun, requestedBy: "alex", basis: "human", modeDigest: null },
    ]);
  });

  test("the pre-typed upgrade fails closed: open requests from before basis existed are spent as legacy-untyped", () => {
    // Simulate the bc8b3bd shape exactly: the table without its typed
    // authority columns, holding one open mode-queued request in the old
    // display-string format and one already-spent row.
    const file = join(evidenceRoot, "legacy.db");
    {
      const old = openStore(file);
      const t = old.refFor("built-in", "t-1");
      void t; // the store exists; we only need the file's schema
      old.close();
    }
    {
      const legacy = openStore(file);
      legacy.createTask({ id: "t-legacy", title: "old work" }, T0);
      const ref = legacy.refFor("built-in", "t-legacy").id;
      legacy.placeTask(ref, REPO);
      const run = legacy.startRun({ taskRef: ref, leaseId: "l-old", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(legacy, ref, "builder") });
      legacy.finishRun(run, { outcome: "built", committed: true, now: T0 });
      legacy.raw().prepare("INSERT INTO review_request (run, requested_by, requested_at) VALUES (?, 'mode:deadbeef', ?)").run(run, T0.toISOString());
      legacy.raw().prepare("INSERT INTO review_request (run, requested_by, requested_at, consumed_at, consumed_reason) VALUES (?, 'alex', ?, ?, 'reviewed')").run(run, T0.toISOString(), T0.toISOString());
      legacy.raw().exec("ALTER TABLE review_request DROP COLUMN mode_digest");
      legacy.raw().exec("ALTER TABLE review_request DROP COLUMN basis");
      legacy.close();
    }
    const upgraded = openStore(file);
    // The open pre-typed request was spent, not granted human authority.
    expect(upgraded.openReviewRequests()).toHaveLength(0);
    const rows = upgraded
      .raw()
      .prepare("SELECT requested_by, basis, consumed_reason FROM review_request ORDER BY id")
      .all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ requested_by: "mode:deadbeef", basis: "human", consumed_reason: "legacy-untyped" });
    // Already-spent history keeps its own words.
    expect(rows[1]).toMatchObject({ consumed_reason: "reviewed" });
    // A reopen does not re-sweep: fresh typed requests survive restarts.
    const run2 = upgraded.startRun({ taskRef: upgraded.refFor("built-in", "t-legacy").id, leaseId: "l-new", runner: "b-1", branch: "b2", worktree: "/w2", now: T0, ...presented(upgraded, upgraded.refFor("built-in", "t-legacy").id, "builder") });
    storeEvidence(upgraded, evidenceRoot, run2, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    upgraded.finishRun(run2, { outcome: "built", committed: true, now: T0 });
    expect(upgraded.requestReview(run2, "alex", T0).ok).toBe(true);
    upgraded.close();
    const reopened = openStore(file);
    expect(reopened.openReviewRequests()).toHaveLength(1);
    reopened.close();
  });

  test("workspace consumers see a reviewer run's missing worktree as null, never \"null\"", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer") });
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
