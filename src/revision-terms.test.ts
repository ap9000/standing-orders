/**
 * Preserve revision terms with explicit approval semantics (contract
 * handoff task 2): ONE field-by-field policy at `Store.sealRevision`,
 * shared by the annotation revision, the CI repair draft, and the
 * criterion repair draft. The source task, run, scope digest, and brief
 * are bound INSIDE the seal; a stale or mismatched source refuses with
 * zero rows; declared risk, quality, posture, budget, exclusions, touches,
 * and the exact rubric survive changed installation defaults; the route
 * and chain are re-resolved for a FRESH approval; nothing that is a grant
 * inherits; repair lineage and remaining automatic bounds survive
 * annotation/CI detours and a restart; concurrent duplicates have one
 * winner. Driven against a real file-backed SQLite store so a restart is a
 * real close and reopen.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, permissionModeOfProfile, revisionTermsOf, type Store } from "./store.js";
import { addApprover, approvalOf, approve, propose, type AcceptanceCriterion } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import { maybeTriggerRepair, maybeSettleRepairChain } from "./dispose.js";
import type { CriterionMatrixRow } from "./proof.js";

/** The exact route authority a fixture PRESENTS at admission (v48). */
const presented = (
  s: Pick<Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role, null) ?? s.routeAuthorityFor(taskRef, role, null, { provider: "claude", model: null });
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-09-11T00:00:00.000Z");
const REPO = "/repos/thing";

const RUBRIC: AcceptanceCriterion[] = [
  { id: "c1", statement: "The payout guard is wired in.", how: null, evidence: ["manual-review"] },
  { id: "c2", statement: "Tests cover the new limiter.", how: null, evidence: ["check"] },
  { id: "c3", statement: "The dashboard shows the new state.", how: null, evidence: ["screenshot"] },
];

function row(id: string, state: CriterionMatrixRow["state"]): CriterionMatrixRow {
  const criterion = RUBRIC.find(c => c.id === id)!;
  return { id, statement: criterion.statement, requiredEvidence: criterion.evidence, state, detail: state === "pass" ? [] : [`criterion "${id}" needs work`], answered: [], review: null };
}

describe("the revision boundary: one policy for annotation, CI, and criterion repair drafts", () => {
  let dir: string;
  let dbPath: string;
  let store: Store;
  let evidenceRoot: string;
  let alexToken: string;

  const configure = (s: Store) => {
    for (const phase of ["plan", "build", "review"]) s.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-revision-terms-"));
    dbPath = join(dir, "orders.db");
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    store = openStore(dbPath);
    configure(store);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    alexToken = alex.token;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A HIGH-RISK, STRICT, budgeted, bounded source: approved, built once,
   * with a sealed terminal diff to annotate. */
  const seedSource = (
    taskId: string,
    terms: { risk?: "routine" | "elevated" | "high"; quality?: "default" | "strict"; budget?: number | null; permission?: "auto" | "bypassPermissions"; goal?: string; reviewOverride?: boolean } = {},
  ) => {
    store.createTask({ id: taskId, title: `${taskId} title` }, T0);
    const taskRef = store.refFor(BUILT_IN, taskId).id;
    store.placeTask(taskRef, REPO);
    propose(store, {
      taskId,
      goal: terms.goal ?? `do ${taskId} carefully`,
      outOfScope: "authentication and billing",
      touches: ["src/payments/", "src/limits/"],
      acceptance: RUBRIC,
      budgetMicrousd: terms.budget === undefined ? 5_000_000 : terms.budget,
      riskLevel: terms.risk ?? "high",
      qualityMode: terms.quality ?? "strict",
      ...(terms.permission === undefined ? {} : { permissionMode: terms.permission }),
      now: T0,
    });
    if (terms.reviewOverride) {
      const edited = store.editTaskRoute(taskRef, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "opus" } }, T0);
      if (!edited.ok) throw new Error(`fixture override refused: ${edited.reason}`);
    }
    const scope = store.getScope(taskId)!;
    const approved = approve(store, taskId, "alex", T0, scope.digest, alexToken);
    if (!approved.ok) throw new Error(`fixture approval refused: ${approved.reason}`);
    const run = store.startRun({ taskRef, leaseId: `l-${taskId}-${Math.random().toString(16).slice(2, 8)}`, runner: "builder-1", branch: `so/${taskId}`, worktree: `/pool/${taskId}`, now: T0, ...presented(store, taskRef, "builder") });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from(`diff --git a/${taskId} b/${taskId}\n+x\n`, "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    const artifactId = store.saveArtifact(
      { run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" },
      T0,
    );
    return { taskRef, run, artifactId, digest: store.getScope(taskId)!.digest };
  };

  /** Write a brief file under the evidence root the way every caller does
   * BEFORE its seal, and describe it the way the seal wants it. */
  const writeBrief = (s: Store, run: number, body: Record<string, unknown>, name = `brief-${Math.random().toString(16).slice(2, 8)}.json`) => {
    const source = s.getRun(run);
    const bytes = Buffer.from(JSON.stringify({ sourceScopeDigest: source?.scopeDigest ?? null, head: source?.headRevision ?? null, ...body }, null, 2), "utf8");
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(run), name), bytes);
    return { evidenceRoot, key: `${run}/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, capture: "machine-authored brief (exit 0)" };
  };

  const annotate = (run: number, artifactId: number, note = "tighten this") =>
    store.addDiffComment({ artifactId, runId: run, path: "src/payments/guard.ts", line: 3, note, author: "alex" }, T0)!;

  const briefComments = (s: Store, run: number, ids: readonly number[]) => s.liveDiffComments(run)
    .filter(one => ids.includes(one.id))
    .map(({ id, path, line, note, author, createdAt }) => ({ id, path, line, note, author, createdAt }));

  /** The annotation road's seal, exactly as serve.ts drives it. */
  const sealAnnotation = (s: Store, taskId: string, run: number, commentIds: number[], scopeDigest: string | null, coverage: { defaultBudgetMicrousd: number | null; escalated: boolean } | null = null) =>
    s.sealRevision(
      {
        source: { task: taskId, run, scopeDigest },
        brief: writeBrief(s, run, { schema: 1, sourceTask: taskId, sourceRun: run, comments: briefComments(s, run, commentIds) }),
        child: { title: `Revise ${taskId} from ${commentIds.length} annotation on build #${run}`, repair: `apply the annotations recorded on build #${run}; the revision brief carries the exact batch` },
        commentIds,
        coverage,
      },
      T0,
    );

  /** The CI road's seal, exactly as serve.ts drives it: deterministic id, no batch. */
  const sealCi = (s: Store, taskId: string, run: number, scopeDigest: string | null, pr = 7) =>
    s.sealRevision(
      {
        source: { task: taskId, run, scopeDigest },
        brief: writeBrief(s, run, { schema: 1, kind: "ci-repair", sourceTask: taskId, sourceRun: run, pr }),
        child: { id: `${taskId}-ci-${pr}`, title: `repair ${taskId}: CI failing on PR #${pr}`, repair: `repair the failing CI on PR #${pr}` },
        commentIds: null,
      },
      T0,
    );

  /** A built run whose proof verdict is SHORT on c1 — the criterion repair's trigger. */
  const shortRun = (taskId: string, unresolved: string[] = ["c1"]) => {
    const taskRef = store.lookupRef(taskId)!.id;
    const scope = store.getScope(taskId)!;
    if (!(scope.approvedAt !== null && scope.approvedDigest === scope.digest)) {
      const approved = approve(store, taskId, "alex", T0, scope.digest, alexToken);
      if (!approved.ok) throw new Error(`fixture approval refused: ${approved.reason}`);
    }
    const run = store.startRun({ taskRef, leaseId: `l-${taskId}-${Math.random().toString(16).slice(2, 8)}`, runner: "builder-1", branch: `so/${taskId}`, worktree: `/pool/${taskId}`, now: T0, ...presented(store, taskRef, "builder") });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(run, "short", ["needs a look"], T0, RUBRIC.map(one => row(one.id, unresolved.includes(one.id) ? "missing" : "pass")));
    maybeSettleRepairChain(store, taskId, "short", T0);
    return run;
  };

  const signMode = (terms: Partial<ModeTerms> = {}) => {
    const merged: ModeTerms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), ...terms };
    store.signMode({ repo: REPO, name: "standard", termsJson: modeTermsJson(merged), digest: modeDigestOf(merged), signedBy: "alex", absoluteExpiry: merged.absoluteExpiry, publication: merged.publication }, T0);
    return merged;
  };

  const taskCount = () => Number(store.raw().prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"] ?? 0);
  const briefRows = (run: number) => store.artifactsFor(run).filter(one => one.kind === "revision-brief").length;

  /** The inherited-terms assertions every child must satisfy against its
   * high/strict/bounded source, whatever the installation says today. */
  const expectInherited = (childId: string, sourceId: string, budget: number | null = 5_000_000) => {
    const child = store.getScope(childId)!;
    const childRef = store.lookupRef(childId)!;
    const source = store.getScope(sourceId)!;
    expect(child.riskLevel).toBe("high");
    expect(childRef.riskLevel).toBe("high");
    expect(child.qualityMode).toBe("strict");
    expect(childRef.qualityMode).toBe("strict");
    expect(childRef.permissionMode).toBe("auto");
    expect(permissionModeOfProfile(child.profile ?? null)).toBe("auto");
    expect(child.budgetMicrousd).toBe(budget);
    expect(child.outOfScope).toBe("authentication and billing");
    expect(child.touches).toEqual(["src/payments/", "src/limits/"]);
    expect(child.acceptance).toEqual(RUBRIC);
    expect(child.goal.startsWith(`${source.goal} — `)).toBe(true);
    // Never an approval, never a grant: the child waits for its own yes.
    expect(child.approvedAt).toBeNull();
    expect(child.approvedDigest).toBeNull();
    expect(child.approvalBasis).toBeNull();
    expect(approvalOf(child).approved).toBe(false);
    expect(child.approvedRouteJson).toBeNull();
    expect(child.approvedChainJson).toBeNull();
    // Re-resolved, not copied: the child has its own working route.
    expect(child.proposedRouteJson).not.toBeNull();
    expect(child.profileState).toBe("resolved");
    expect(childRef.revisionOf).toBe(sourceId);
    expect(childRef.plan).toBeNull();
    expect(store.listPlanRevisions(childRef.id)).toEqual([]);
    expect(Number(store.raw().prepare("SELECT COUNT(*) AS n FROM attended_authorization WHERE task_ref = ?").get(childRef.id)?.["n"])).toBe(0);
    expect(Number(store.raw().prepare("SELECT COUNT(*) AS n FROM publication WHERE task_ref = ?").get(childRef.id)?.["n"])).toBe(0);
  };

  test("c1: all three draft paths inherit high risk, strict quality, the budget, the boundaries and the exact rubric after the installation's defaults are downgraded and widened", () => {
    // Route choices belong to the source contract BEFORE its built run.
    const source = seedSource("t-high", { reviewOverride: true });
    const digest = store.getScope("t-high")!.digest;
    // The installation changes its mind AFTER the source was signed: wider
    // permissions by default, and a different agent for every phase.
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    store.setQualityDefault("default", "alex", T0);
    store.setPhaseConfig("installation", "build", "codex", "gpt-5", "alex", T0);
    store.setPhaseConfig("installation", "review", "codex", "gpt-5", "alex", T0);

    // Path 1: annotation revision.
    const comment = annotate(source.run, source.artifactId);
    const annotated = sealAnnotation(store, "t-high", source.run, [comment], digest);
    if (!annotated.ok) throw new Error(annotated.detail);
    expectInherited(annotated.id, "t-high");
    expect(annotated.terms).toMatchObject({ riskLevel: "high", qualityMode: "strict", permissionMode: "auto", budgetMicrousd: 5_000_000, fromScope: true });
    expect(store.lookupRef(annotated.id)!.routeOverrides).toMatchObject([{ phase: "review", provider: "claude", model: "opus" }]);
    expect(store.lookupRef(annotated.id)!.planProvider).toBe(store.lookupRef("t-high")!.planProvider);
    // The child's route is recommended over the inherited override and
    // risk, under TODAY's configuration — the build leg is today's codex,
    // the review leg the inherited override — and it awaits its own yes.
    const route = JSON.parse(store.getScope(annotated.id)!.proposedRouteJson!) as { risk: string; legs: { phase: string; provider: string; model: string; chosen: string }[] };
    expect(route.risk).toBe("high");
    expect(route.legs.find(one => one.phase === "review")).toMatchObject({ provider: "claude", model: "opus", chosen: "override" });
    expect(route.legs.find(one => one.phase === "build")).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(store.getScope(annotated.id)!.profile).toMatchObject({ provider: "codex", sandboxMode: "workspace-write" });
    // The comment batch is consumed by exactly this child.
    expect(store.liveDiffComments(source.run)).toEqual([]);
    expect(store.allDiffComments(source.run)[0]?.consumedBy).toBe(annotated.id);

    // Path 2: CI repair draft.
    const ci = sealCi(store, "t-high", source.run, digest);
    if (!ci.ok) throw new Error(ci.detail);
    expect(ci.id).toBe("t-high-ci-7");
    expectInherited(ci.id, "t-high");
    expect(store.getScope(ci.id)!.profile).toMatchObject({ provider: "codex", sandboxMode: "workspace-write" });

    // Path 3: criterion repair draft, through the repair loop's trigger.
    const short = shortRun("t-high");
    const trigger = maybeTriggerRepair(store, REPO, evidenceRoot, short, "short", T0);
    if (trigger.kind !== "drafted") throw new Error(`expected a draft, got ${trigger.kind}`);
    expectInherited(trigger.draftTaskId, "t-high");
    expect(store.getScope(trigger.draftTaskId)!.goal).toContain("Unmet: c1");
    expect(store.repairChainFor(short)).toMatchObject({ rootTask: "t-high", attempt: 1, draftTask: trigger.draftTaskId, outcome: "drafted" });
  });

  test("c1: a policy computed from the source rows — never below the source's signed risk, never wider than its posture, budget only tightened", () => {
    const strictHigh = revisionTermsOf(
      { riskLevel: "elevated", qualityMode: null, permissionMode: null, routeOverrides: [], agentProvider: null, agentModel: null, planProvider: null, planModel: null },
      {
        taskId: "s",
        goal: "g",
        outOfScope: "x",
        touches: ["a/"],
        acceptance: RUBRIC,
        budgetMicrousd: 4_000_000,
        proposedAt: T0.toISOString(),
        digest: "d",
        approvedAt: null,
        approvedBy: null,
        approvedDigest: null,
        riskLevel: "high",
        qualityMode: "strict",
        profile: { provider: "claude", model: "sonnet", permissionArgv: "auto", maxTurns: 1, repairMaxTurns: 1, timeoutSeconds: 1, repairTimeoutSeconds: 1, repairModel: "inherit" },
      },
      { defaultBudgetMicrousd: 9_000_000, escalated: false },
      "bypassPermissions",
      "default",
    );
    expect(strictHigh).toMatchObject({ riskLevel: "high", qualityMode: "strict", permissionMode: "auto", budgetMicrousd: 4_000_000, outOfScope: "x", touches: ["a/"], fromScope: true });
    // The durable task choice wins over the scope's signed level when it is stricter; a tighter mode default wins over the source budget.
    const durableHigh = revisionTermsOf(
      { riskLevel: "high", qualityMode: "strict", permissionMode: "bypassPermissions", routeOverrides: null, agentProvider: "claude", agentModel: "opus", planProvider: null, planModel: null },
      { taskId: "s", goal: "g", outOfScope: null, touches: [], acceptance: [], budgetMicrousd: null, proposedAt: T0.toISOString(), digest: "d", approvedAt: null, approvedBy: null, approvedDigest: null, riskLevel: "routine", qualityMode: "default" },
      { defaultBudgetMicrousd: 3_000_000, escalated: true },
      "auto",
      "default",
    );
    expect(durableHigh).toMatchObject({ riskLevel: "high", qualityMode: "strict", permissionMode: "bypassPermissions", budgetMicrousd: 3_000_000, escalated: true, agentPin: { provider: "claude", model: "opus" } });
    expect(durableHigh.acceptance.map(one => one.id)).toEqual(["c1"]); // the placeholder, when the source signed no rubric
    // No scope at all: nothing inherits, today's defaults and the placeholder rubric.
    const legacy = revisionTermsOf({ riskLevel: null, qualityMode: null, permissionMode: null, routeOverrides: [], agentProvider: null, agentModel: null, planProvider: null, planModel: null }, null, null, "auto", "strict");
    expect(legacy).toMatchObject({ riskLevel: "routine", qualityMode: "strict", permissionMode: "auto", budgetMicrousd: null, fromScope: false, goal: "" });
  });

  test("a fresh caller digest cannot relabel an older run's contract", () => {
    const source = seedSource("t-old-run");
    const comment = annotate(source.run, source.artifactId);
    const count = taskCount();
    propose(store, { taskId: "t-old-run", goal: "a different request", acceptance: RUBRIC, now: T0 });
    const current = store.getScope("t-old-run")!.digest;
    expect(current).not.toBe(source.digest);
    expect(sealAnnotation(store, "t-old-run", source.run, [comment], current)).toMatchObject({ ok: false, reason: "stale-source" });
    expect(taskCount()).toBe(count);
    expect(store.liveDiffComments(source.run)).toHaveLength(1);
    expect(briefRows(source.run)).toBe(0);
  });

  test.each(["scope", "head", "comments"])("a revision brief binds the actual source %s, not just its task/run names", (field) => {
    const source = seedSource("t-brief-binding");
    const comment = annotate(source.run, source.artifactId);
    const count = taskCount();
    const body = { schema: 1, sourceTask: "t-brief-binding", sourceRun: source.run, comments: briefComments(store, source.run, [comment]),
      ...(field === "scope" ? { sourceScopeDigest: "another scope" } : {}),
      ...(field === "head" ? { head: "a".repeat(40) } : {}),
    };
    if (field === "comments") body.comments[0]!.note = "a different instruction";
    const result = store.sealRevision({ source: { task: "t-brief-binding", run: source.run, scopeDigest: source.digest },
      brief: writeBrief(store, source.run, body), child: { title: "a revision", repair: "apply the batch" }, commentIds: [comment] }, T0);
    expect(result).toMatchObject({ ok: false, reason: "brief-custody" });
    expect(taskCount()).toBe(count);
    expect(store.liveDiffComments(source.run)).toHaveLength(1);
    expect(briefRows(source.run)).toBe(0);
  });

  test("c2: the seal proves task, run, scope digest, stored terms and brief custody first — a stale or mismatched source refuses with zero rows, nested or not", () => {
    const source = seedSource("t-bind");
    const other = seedSource("t-other");
    const comment = annotate(source.run, source.artifactId);
    const before = taskCount();

    // Stale scope digest: the source was rewritten after the brief was drafted.
    propose(store, { taskId: "t-bind", goal: "do t-bind carefully — rewritten", outOfScope: "authentication and billing", touches: ["src/payments/", "src/limits/"], acceptance: RUBRIC, budgetMicrousd: 5_000_000, riskLevel: "high", qualityMode: "strict", now: T0 });
    const stale = sealAnnotation(store, "t-bind", source.run, [comment], source.digest);
    expect(stale).toMatchObject({ ok: false, reason: "stale-source" });
    let current = store.getScope("t-bind")!.digest;
    expect(current).not.toBe(source.digest);

    // Wrong run: another task's attempt.
    expect(sealAnnotation(store, "t-bind", other.run, [comment], current)).toMatchObject({ ok: false, reason: "source-run" });
    // No such task.
    expect(sealAnnotation(store, "t-nowhere", source.run, [comment], current)).toMatchObject({ ok: false, reason: "source-task" });
    // A caller that saw no scope, on a task that has one.
    expect(sealAnnotation(store, "t-bind", source.run, [comment], null)).toMatchObject({ ok: false, reason: "stale-source" });

    // Restore the run's original terms before checking independent custody
    // failures. A fresh caller digest cannot make the old run current.
    propose(store, { taskId: "t-bind", goal: "do t-bind carefully", outOfScope: "authentication and billing", touches: ["src/payments/", "src/limits/"], acceptance: RUBRIC, budgetMicrousd: 5_000_000, riskLevel: "high", qualityMode: "strict", now: T0 });
    current = store.getScope("t-bind")!.digest;
    expect(current).toBe(source.digest);

    // A brief that names another source, a tampered brief, a missing brief.
    const wrongBrief = writeBrief(store, source.run, { schema: 1, sourceTask: "t-other", sourceRun: other.run, comments: [] });
    expect(store.sealRevision({ source: { task: "t-bind", run: source.run, scopeDigest: current }, brief: wrongBrief, child: { title: "x", repair: "y" }, commentIds: [comment] }, T0)).toMatchObject({ ok: false, reason: "brief-custody" });
    const tampered = writeBrief(store, source.run, { schema: 1, sourceTask: "t-bind", sourceRun: source.run, comments: [] }, "tampered.json");
    writeFileSync(join(evidenceRoot, tampered.key), "{}");
    expect(store.sealRevision({ source: { task: "t-bind", run: source.run, scopeDigest: current }, brief: tampered, child: { title: "x", repair: "y" }, commentIds: [comment] }, T0)).toMatchObject({ ok: false, reason: "brief-custody" });
    const missing = writeBrief(store, source.run, { schema: 1, sourceTask: "t-bind", sourceRun: source.run, comments: [] }, "gone.json");
    rmSync(join(evidenceRoot, missing.key));
    expect(store.sealRevision({ source: { task: "t-bind", run: source.run, scopeDigest: current }, brief: missing, child: { title: "x", repair: "y" }, commentIds: [comment] }, T0)).toMatchObject({ ok: false, reason: "brief-custody" });

    // Stored terms that do not read back exactly are not authority.
    store.raw().prepare("UPDATE task_scope SET touches = 'not json' WHERE task_id = 't-bind'").run();
    expect(sealAnnotation(store, "t-bind", source.run, [comment], current)).toMatchObject({ ok: false, reason: "source-terms" });
    store.raw().prepare("UPDATE task_scope SET touches = ? WHERE task_id = 't-bind'").run(JSON.stringify(["src/payments/", "src/limits/"]));

    // Nothing partial from any refusal: no task, no artifact row, the batch still live.
    expect(taskCount()).toBe(before);
    expect(briefRows(source.run)).toBe(0);
    expect(store.liveDiffComments(source.run).map(one => one.id)).toEqual([comment]);

    // The comment race INSIDE an enclosing transaction (the annotation
    // road's own shape): the seal rolls back wholesale under its savepoint,
    // and the enclosing commit carries none of it.
    store.consumeDiffComments(source.run, [comment], "someone-else");
    const raced = store.transact(() => sealAnnotation(store, "t-bind", source.run, [comment], current));
    expect(raced).toMatchObject({ ok: false, reason: "comments-taken" });
    expect(taskCount()).toBe(before);
    expect(briefRows(source.run)).toBe(0);

    // Change the source again before independently exercising stale CI.
    propose(store, { taskId: "t-bind", goal: "new CI terms", acceptance: RUBRIC, now: T0 });
    // And the CI road refuses the same stale source the same way.
    expect(sealCi(store, "t-bind", source.run, source.digest)).toMatchObject({ ok: false, reason: "stale-source" });
    expect(store.getTask("t-bind-ci-7")).toBeNull();
    // The criterion repair binds the digest it read, too: a source
    // rewritten between the verdict and the trigger drafts nothing.
    const short = shortRun("t-bind");
    const drafted = store.openRepairDraft(
      {
        source: { task: "t-bind", run: short, scopeDigest: source.digest },
        brief: writeBrief(store, short, { schema: 1, kind: "criterion-repair", sourceTask: "t-bind", sourceRun: short }),
        child: { id: "t-bind-fix-1", title: "repair", repair: "repair c1" },
        rootTask: "t-bind",
        attempt: 1,
        basis: "human",
        modeDigest: null,
        unresolved: ["c1"],
      },
      T0,
    );
    expect(drafted).toMatchObject({ ok: false, reason: "stale-source" });
    expect(store.getTask("t-bind-fix-1")).toBeNull();
    expect(store.repairChainFor(short)).toBeNull();
  });

  test("c3: permission never widens, budget never lifts, routes and chain re-resolve for a fresh yes, the plan is not inherited, and no grant comes along", () => {
    // A source filed under a durable AUTO choice while the installation
    // default is auto; the default then widens to full access.
    const source = seedSource("t-perm", { permission: "auto", budget: 5_000_000 });
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    // A fake approved chain and a drafted plan on the source: neither may be copied.
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = '{\"fake\":true}' WHERE task_id = 't-perm'").run();
    store.raw().prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(source.taskRef);
    const digest = store.getScope("t-perm")!.digest;

    // Budget: the mode's filing default may only tighten the inherited ceiling.
    const c1 = annotate(source.run, source.artifactId, "one");
    const tightened = sealAnnotation(store, "t-perm", source.run, [c1], digest, { defaultBudgetMicrousd: 3_000_000, escalated: false });
    if (!tightened.ok) throw new Error(tightened.detail);
    expect(store.getScope(tightened.id)!.budgetMicrousd).toBe(3_000_000);
    const c2 = annotate(source.run, source.artifactId, "two");
    const kept = sealAnnotation(store, "t-perm", source.run, [c2], digest, { defaultBudgetMicrousd: 8_000_000, escalated: true });
    if (!kept.ok) throw new Error(kept.detail);
    expect(store.getScope(kept.id)!.budgetMicrousd).toBe(5_000_000);
    const c3 = annotate(source.run, source.artifactId, "three");
    const uncovered = sealAnnotation(store, "t-perm", source.run, [c3], digest, null);
    if (!uncovered.ok) throw new Error(uncovered.detail);
    expect(store.getScope(uncovered.id)!.budgetMicrousd).toBe(5_000_000);

    for (const id of [tightened.id, kept.id, uncovered.id]) {
      const child = store.getScope(id)!;
      const ref = store.lookupRef(id)!;
      // Permission: the source's auto, not today's wider default.
      expect(ref.permissionMode).toBe("auto");
      expect(child.profile).toMatchObject({ permissionArgv: "auto" });
      // Chain and route: re-resolved from configuration, unapproved.
      expect(child.proposedChainJson).toBeNull();
      expect(child.approvedChainJson).toBeNull();
      expect(child.approvedRouteJson).toBeNull();
      expect(child.approvedAt).toBeNull();
      expect(approvalOf(child).approved).toBe(false);
      // Plan ancestry: none.
      expect(ref.plan).toBeNull();
      expect(store.listPlanRevisions(ref.id)).toEqual([]);
      // A fresh, appropriate approval is the only road that approves it.
      const yes = approve(store, id, "alex", T0, child.digest, alexToken);
      expect(yes.ok).toBe(true);
      expect(approvalOf(store.getScope(id)!).approved).toBe(true);
    }

    // A source approved by a MODE (its stamp and basis) hands nothing down:
    // the child is unapproved, with no basis, and a live mode approves it
    // only through the normal mode road's own checks.
    const covered = seedSource("t-mode");
    signMode({ autoApproveFiling: true, repairAuto: true, repairMaxAttempts: 2 });
    store.raw().prepare("UPDATE task_scope SET approval_basis = 'mode', mode_digest = 'stamp' WHERE task_id = 't-mode'").run();
    const c4 = annotate(covered.run, covered.artifactId);
    const child = sealAnnotation(store, "t-mode", covered.run, [c4], store.getScope("t-mode")!.digest);
    if (!child.ok) throw new Error(child.detail);
    expect(store.getScope(child.id)).toMatchObject({ approvedAt: null, approvedBy: null, approvedDigest: null, approvalBasis: null, modeDigest: null });
    // The mode road stays the mode road: a child whose text a mate wrote
    // is refused by the quarantine exactly as any other filing would be,
    // and the normal mode seal is what approves an ordinary child.
    store.raw().prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = ?").run(child.id);
    expect(store.sealScopeApproval(child.id, "alex", T0, {}, { kind: "mode", modeDigest: store.activeMode(REPO, T0)!.digest })).toBe(false);
    expect(store.getScope(child.id)!.approvedAt).toBeNull();
    store.raw().prepare("UPDATE task_scope SET proposed_via = NULL WHERE task_id = ?").run(child.id);
    expect(store.sealScopeApproval(child.id, "alex", T0, {}, { kind: "mode", modeDigest: store.activeMode(REPO, T0)!.digest })).toBe(true);
    expect(store.getScope(child.id)).toMatchObject({ approvalBasis: "mode", approvedBy: "alex" });
  });

  test("c4: an annotation detour and a CI detour between repair attempts keep the chain's root and remaining bound, across a restart; concurrent duplicates have one winner", () => {
    seedSource("t-chain", { quality: "default", risk: "routine" });
    signMode({ repairAuto: true, repairMaxAttempts: 2 });

    // Attempt 1 drafts from the root's short verdict (auto-approved by the
    // mode). Each later verdict strictly shrinks the unmet set, so the
    // no-progress stop stays quiet and only the attempt cap can end this.
    const run1 = shortRun("t-chain", ["c1", "c2", "c3"]);
    const t1 = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (t1.kind !== "drafted") throw new Error(`attempt 1 should draft, got ${t1.kind}`);
    expect(t1).toMatchObject({ attempt: 1, draftTaskId: "t-chain-fix-1", approved: true });

    // The draft builds; a person annotates its diff and seals a revision —
    // a detour that is NOT a repair draft.
    const fixRef = store.lookupRef("t-chain-fix-1")!.id;
    const fixRun = store.startRun({ taskRef: fixRef, leaseId: "l-fix-1", runner: "builder-1", branch: "so/fix-1", worktree: "/pool/fix-1", now: T0, ...presented(store, fixRef, "builder") });
    store.stampRun(fixRun, { scopeDigest: store.getScope("t-chain-fix-1")!.digest });
    store.finishRun(fixRun, { outcome: "built", committed: true, now: T0 });
    mkdirSync(join(evidenceRoot, String(fixRun)), { recursive: true });
    const patch = Buffer.from("diff --git a/f b/f\n+y\n", "utf8");
    writeFileSync(join(evidenceRoot, String(fixRun), "terminal-diff.patch"), patch);
    const fixArtifact = store.saveArtifact({ run: fixRun, kind: "terminal-diff", key: `${fixRun}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, T0);
    const note = annotate(fixRun, fixArtifact);
    const detour = sealAnnotation(store, "t-chain-fix-1", fixRun, [note], store.getScope("t-chain-fix-1")!.digest);
    if (!detour.ok) throw new Error(detour.detail);
    // The detour continues the chain: root t-chain, one attempt used of two.
    expect(store.repairLineageOf(detour.id)).toMatchObject({ rootTask: "t-chain", via: "t-chain-fix-1", continues: { attempt: 1, draftTask: "t-chain-fix-1" } });
    expect(store.revisionLineageOf(detour.id, T0)).toMatchObject({ sourceTask: "t-chain-fix-1", sourceRun: fixRun, root: "t-chain", ancestors: ["t-chain-fix-1", "t-chain"], repair: { rootTask: "t-chain", attemptsUsed: 1, cap: 2, remaining: 1, thisAttempt: null, via: "t-chain-fix-1" } });

    // A CI detour on top of the annotation detour, then a RESTART.
    const detourRef = store.lookupRef(detour.id)!.id;
    const detourRun = store.startRun({ taskRef: detourRef, leaseId: "l-detour", runner: "builder-1", branch: "so/detour", worktree: "/pool/detour", now: T0, ...(approve(store, detour.id, "alex", T0, store.getScope(detour.id)!.digest, alexToken).ok ? presented(store, detourRef, "builder") : {}) });
    store.stampRun(detourRun, { scopeDigest: store.getScope(detour.id)!.digest });
    store.finishRun(detourRun, { outcome: "built", committed: true, now: T0 });
    const ci = sealCi(store, detour.id, detourRun, store.getScope(detour.id)!.digest, 9);
    if (!ci.ok) throw new Error(ci.detail);
    store.close();
    store = openStore(dbPath);

    // After the restart, the lineage still reads through both detours.
    expect(store.revisionAncestryOf(ci.id)).toEqual([ci.id, detour.id, "t-chain-fix-1", "t-chain"]);
    expect(store.repairLineageOf(ci.id)).toMatchObject({ rootTask: "t-chain", via: "t-chain-fix-1" });
    expect(store.revisionLineageOf(ci.id, T0)?.repair).toMatchObject({ rootTask: "t-chain", attemptsUsed: 1, cap: 2, remaining: 1 });
    expect(store.revisionLineageOf(ci.id, T0)?.terms).toMatchObject({ riskLevel: "routine", qualityMode: "default", exclusions: true, touches: 2, criteria: 3 });

    // The CI detour's build comes back short: attempt 2 of the SAME chain,
    // not attempt 1 of a new one — and it is the last automatic one.
    const ciRun = shortRun(ci.id, ["c1", "c2"]);
    const t2 = maybeTriggerRepair(store, REPO, evidenceRoot, ciRun, "short", T0);
    if (t2.kind !== "drafted") throw new Error(`attempt 2 should draft, got ${t2.kind}`);
    expect(t2).toMatchObject({ attempt: 2, draftTaskId: "t-chain-fix-2" });
    expect(store.repairChainFor(ciRun)).toMatchObject({ rootTask: "t-chain", attempt: 2, draftTask: "t-chain-fix-2" });
    expect(store.lookupRef("t-chain-fix-2")!.revisionOf).toBe(ci.id);
    expect(store.revisionLineageOf("t-chain-fix-2", T0)?.repair).toMatchObject({ rootTask: "t-chain", attemptsUsed: 2, cap: 2, remaining: 0, thisAttempt: 2 });
    // The bound is spent: a third short verdict stops the chain instead of drafting.
    const run3 = shortRun("t-chain-fix-2", ["c1"]);
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run3, "short", T0)).toEqual({ kind: "stopped", reason: "repair-attempts-spent" });
    expect(store.repairChainForRoot("t-chain").map(one => [one.attempt, one.outcome])).toEqual([[1, "drafted"], [2, "attempts-spent"]]);
    expect(store.getTask("t-chain-fix-3")).toBeNull();

    // REPLAYED DUPLICATES, through a second connection to the same file:
    // both read the same live batch; one seal wins, the other refuses with
    // zero rows. The deterministic CI id and the chain's source_run UNIQUE
    // are the same story on the other two roads.
    const twin = openStore(dbPath);
    try {
      const dupSource = seedSource("t-dup", { quality: "default", risk: "routine" });
      const batch = annotate(dupSource.run, dupSource.artifactId);
      const digest = store.getScope("t-dup")!.digest;
      const tasksBefore = taskCount();
      const first = sealAnnotation(store, "t-dup", dupSource.run, [batch], digest);
      expect(first.ok).toBe(true);
      const second = sealAnnotation(twin, "t-dup", dupSource.run, [batch], digest);
      expect(second).toMatchObject({ ok: false, reason: "comments-taken" });
      expect(taskCount()).toBe(tasksBefore + 1);
      expect(briefRows(dupSource.run)).toBe(1);

      expect(sealCi(store, "t-dup", dupSource.run, digest, 11).ok).toBe(true);
      expect(sealCi(twin, "t-dup", dupSource.run, digest, 11)).toMatchObject({ ok: false, reason: "duplicate" });
      expect(taskCount()).toBe(tasksBefore + 2);

      const dupShort = shortRun("t-dup");
      const draftArgs = (s: Store, id: string) => ({
        source: { task: "t-dup", run: dupShort, scopeDigest: store.getScope("t-dup")!.digest },
        brief: writeBrief(s, dupShort, { schema: 1, kind: "criterion-repair", sourceTask: "t-dup", sourceRun: dupShort }),
        child: { id, title: "repair", repair: "repair c1" },
        rootTask: "t-dup",
        attempt: 1,
        basis: "human" as const,
        modeDigest: null,
        unresolved: ["c1"],
      });
      expect(store.openRepairDraft(draftArgs(store, "t-dup-fix-1"), T0).ok).toBe(true);
      // A different child id cannot slip past: the chain's source_run
      // UNIQUE refuses, and the loser's task rolls back with it.
      expect(twin.openRepairDraft(draftArgs(twin, "t-dup-fix-1b"), T0)).toMatchObject({ ok: false, reason: "duplicate" });
      expect(store.getTask("t-dup-fix-1b")).toBeNull();
      expect(taskCount()).toBe(tasksBefore + 3);
      expect(store.repairChainFor(dupShort)).toMatchObject({ draftTask: "t-dup-fix-1" });
    } finally {
      twin.close();
    }
  });

  test.each(["cycle", "missing", "bound"])("incomplete %s ancestry cannot open a fresh revision or repair allowance", (kind) => {
    const source = seedSource("t-gap");
    if (kind === "cycle") store.raw().prepare("UPDATE task_ref SET revision_of = 't-gap' WHERE id = ?").run(source.taskRef);
    if (kind === "missing") store.raw().prepare("UPDATE task_ref SET revision_of = 'gone' WHERE id = ?").run(source.taskRef);
    if (kind === "bound") {
      for (let i = 0; i < 64; i++) {
        store.createTask({ id: `ancestor-${i}`, title: "ancestor" }, T0);
        const id = i === 0 ? source.taskRef : store.lookupRef(`ancestor-${i - 1}`)!.id;
        store.raw().prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(`ancestor-${i}`, id);
      }
    }
    expect(store.repairLineageOf("t-gap").problem).toBeTruthy();
    expect(store.revisionLineageOf("t-gap", T0)?.problem).toBeTruthy();
    const count = taskCount();
    const comment = annotate(source.run, source.artifactId);
    expect(sealAnnotation(store, "t-gap", source.run, [comment], source.digest)).toMatchObject({ ok: false, reason: "source-terms" });
    expect(taskCount()).toBe(count);
    expect(store.liveDiffComments(source.run)).toHaveLength(1);
  });

  test("the repair seal derives its root, ordinal and automatic allowance inside the transaction", () => {
    const source = seedSource("t-ledger");
    const base = {
      source: { task: "t-ledger", run: source.run, scopeDigest: source.digest },
      brief: writeBrief(store, source.run, { sourceTask: "t-ledger", sourceRun: source.run }),
      child: { id: "t-ledger-fix-1", title: "repair", repair: "repair c1" },
      rootTask: "t-ledger", attempt: 1, basis: "human" as const, modeDigest: null, unresolved: ["c1"],
    };
    const count = taskCount();
    for (const override of [{ rootTask: "invented-root" }, { attempt: 0 }, { attempt: 8 }, { basis: "mode" as const, modeDigest: "ungranted" }]) {
      expect(store.openRepairDraft({ ...base, ...override }, T0)).toMatchObject({ ok: false, reason: "source-terms" });
      expect(taskCount()).toBe(count);
      expect(store.repairChainFor(source.run)).toBeNull();
    }
  });

  test("two processes released together seal exactly one annotation batch", async () => {
    const source = seedSource("t-race");
    const comment = annotate(source.run, source.artifactId);
    const count = taskCount();
    const args = {
      source: { task: "t-race", run: source.run, scopeDigest: source.digest },
      brief: writeBrief(store, source.run, { sourceTask: "t-race", sourceRun: source.run, comments: briefComments(store, source.run, [comment]) }),
      child: { title: "a raced revision", repair: "apply the comment" }, commentIds: [comment],
    };
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/store.ts")).href;
    const code = `import { openStore } from ${JSON.stringify(moduleUrl)};
      const store = openStore(process.argv[1]);
      process.send({ready:true});
      process.once('message', args => {
        const result = store.sealRevision(args, new Date(${JSON.stringify(T0.toISOString())}));
        store.close(); process.send({result}, () => process.disconnect());
      });`;
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dbPath], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    try {
      const results = children.map(child => new Promise<ReturnType<Store["sealRevision"]>>((resolve, reject) => {
        child.on("message", message => { const data = message as { result?: ReturnType<Store["sealRevision"]> }; if (data.result !== undefined) resolve(data.result); });
        child.on("error", reject);
        child.on("exit", code => { if (code !== 0) reject(new Error(`race process exited ${code}`)); });
      }));
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.on("message", message => { if ((message as { ready?: boolean }).ready) resolve(); });
        child.on("error", reject);
        child.on("exit", code => reject(new Error(`race process exited before ready: ${code}`)));
      })));
      for (const child of children) child.send(args);
      const answers = await Promise.all(results);
      expect(answers.filter(one => one.ok)).toHaveLength(1);
      const loser = answers.find(one => !one.ok);
      expect(loser && !loser.ok && ["comments-taken", "busy"].includes(loser.reason)).toBe(true);
      expect(taskCount()).toBe(count + 1);
      expect(briefRows(source.run)).toBe(1);
      expect(store.liveDiffComments(source.run)).toHaveLength(0);
    } finally { for (const child of children) child.kill(); }
  }, 15_000);

  test("c5: the lineage projection reads the child's ACTUAL terms and names what re-resolves and what never inherits", () => {
    const source = seedSource("t-view");
    store.setQualityDefault("default", "alex", T0);
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    const comment = annotate(source.run, source.artifactId);
    const sealed = sealAnnotation(store, "t-view", source.run, [comment], source.digest);
    if (!sealed.ok) throw new Error(sealed.detail);
    const view = store.revisionLineageOf(sealed.id, T0);
    expect(view).toMatchObject({
      sourceTask: "t-view",
      sourceRun: source.run,
      ancestors: ["t-view"],
      root: "t-view",
      sourceHadScope: true,
      terms: { riskLevel: "high", qualityMode: "strict", permissionMode: "auto", budgetMicrousd: 5_000_000, exclusions: true, touches: 2, criteria: 3, routeOverrides: 0 },
      repair: null,
    });
    // A task that revises nothing has no lineage to show.
    expect(store.revisionLineageOf("t-view", T0)).toBeNull();
  });
});
