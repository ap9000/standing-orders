/**
 * The bounded repair loop (v40, evidence-review-v1): the trigger that
 * fires after a review pass settles a short/refuted verdict with named
 * unresolved criteria, its four independent stops, and the chain's own
 * happy exit. Tested directly against `maybeTriggerRepair`/
 * `maybeSettleRepairChain` and hand-seeded proof verdicts — the trigger's
 * own contract does not require a real reviewer run, only a stored
 * verdict and matrix, so these tests stay fast and precise about which
 * stop fires and why.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import { maybeTriggerRepair, maybeSettleRepairChain, regateTask } from "./dispose.js";
import type { CriterionMatrixRow, VerifyCommandFacts } from "./proof.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { readVerifiedArtifact, storeEvidence } from "./evidence.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  bound: { index: number; entryDigest: string } | null = null,
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role, bound) ?? s.routeAuthorityFor(taskRef, role, bound, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-09-08T00:00:00.000Z");
const REPO = "/repos/thing";

const CRITERIA = [
  { id: "c1", statement: "The payout guard is wired in.", how: null, evidence: ["manual-review"] as const },
  { id: "c2", statement: "Tests cover the new limiter.", how: null, evidence: ["check"] as const },
  { id: "c3", statement: "The dashboard shows the new state.", how: null, evidence: ["screenshot"] as const },
];

function row(id: string, state: CriterionMatrixRow["state"], extraDetail: string[] = []): CriterionMatrixRow {
  const criterion = CRITERIA.find(c => c.id === id)!;
  return {
    id,
    statement: criterion.statement,
    requiredEvidence: criterion.evidence,
    state,
    detail: state === "pass" ? [] : [`criterion "${id}" needs work`, ...extraDetail],
    answered: [],
    review: null,
  };
}

describe("the bounded repair loop (v40, evidence-review-v1)", () => {
  let store: Store;
  let evidenceRoot: string;
  let alexToken: string;

  beforeEach(() => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "so-repair-evidence-"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    alexToken = alex.token;
    // A default build profile, so a drafted repair's scope RESOLVES —
    // without one, every scope (original and draft alike) is unapprovable
    // for a reason that has nothing to do with the repair loop itself.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  });

  afterEach(() => {
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  /** Seed a task, place it, and sign a rubric — the root of every chain. */
  const seedTask = (taskId: string, criteria = CRITERIA) => {
    store.createTask({ id: taskId, title: taskId }, T0);
    const taskRef = store.refFor(BUILT_IN, taskId).id;
    store.placeTask(taskRef, REPO);
    propose(store, { taskId, goal: `do ${taskId}`, acceptance: criteria, now: T0 });
    // v48: a routed task opens no run without a sealed route — the root
    // of every chain is approved before its first attempt, as it would be.
    const approved = approve(store, taskId, "alex", T0, store.getScope(taskId)!.digest, alexToken);
    if (!approved.ok) throw new Error(`the fixture approval was refused: ${approved.reason}`);
    return taskRef;
  };

  /** One completed run against an EXISTING task (original or drafted),
   * with its proof verdict saved exactly as builder.ts would — including
   * the chain's own happy-exit check, wired the same way. */
  const seedRun = (taskId: string, verdict: "short" | "refuted" | "verified" | "attested", matrix: CriterionMatrixRow[], reasons: string[] = ["needs a look"]) => {
    const taskRef = store.lookupRef(taskId)!.id;
    // v48: an attempt runs under a sealed route — a drafted repair task
    // that waits for a person is approved here before its attempt opens.
    const scope = store.getScope(taskId);
    if (scope !== null && !(scope.approvedAt !== null && scope.approvedDigest === scope.digest)) {
      const approved = approve(store, taskId, "alex", T0, scope.digest, alexToken);
      if (!approved.ok) throw new Error(`the fixture approval was refused: ${approved.reason}`);
    }
    const runId = store.startRun({ taskRef, leaseId: `l-${taskId}-${Math.random().toString(16).slice(2, 8)}`, runner: "builder-1", branch: `b-${taskId}`, worktree: `/pool/${taskId}`, now: T0, ...presented(store, taskRef, "builder") });
    store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(runId, verdict, reasons, T0, matrix);
    maybeSettleRepairChain(store, taskId, verdict, T0);
    return runId;
  };

  const signMode = (terms: Partial<ModeTerms> = {}) => {
    const merged: ModeTerms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), ...terms };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(merged), digest: modeDigestOf(merged), signedBy: "alex", absoluteExpiry: merged.absoluteExpiry, publication: merged.publication },
      T0,
    );
    return merged;
  };

  const failedGate = (taskId = "t-gate", result: VerifyCommandFacts = { configured: true, ran: true, exitCode: 1 }) => {
    if (!store.lookupRef(taskId)) seedTask(taskId);
    if (!store.liveVerifyCommand(REPO)) store.setVerifyCommand({ repo: REPO, command: "npm test && npm run build", timeoutMs: 300_000, approvedBy: "alex" }, T0);
    const run = seedRun(taskId, result.configured && !result.ran ? "short" : "refuted", CRITERIA.map(c => row(c.id, "pass")));
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), baseRevision: "b".repeat(40) });
    storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from("163 passed, 1 timed out: balance probe"), "project check", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, result, T0);
    return run;
  };
  const repairGate = (run: number) => maybeTriggerRepair(store, REPO, evidenceRoot, run, store.proofVerdictFor(run)!.verdict, T0, "verification");

  test("an exit failure repairs even when every criterion passed; replay and review share one draft", () => {
    signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const run = failedGate("t-gate", { configured: true, ran: true, exitCode: 1 });
    expect(repairGate(run)).toMatchObject({ kind: "drafted", approved: true, attempt: 1 });
    expect(store.repairChainFor(run)?.unresolved).toEqual(["project checks"]);
    expect(store.getScope("t-gate-fix-1")?.acceptance).toEqual(store.getScope("t-gate")?.acceptance);
    const source = store.revisionSourceOf(store.lookupRef("t-gate-fix-1")!.id)!;
    const brief = readVerifiedArtifact(evidenceRoot, source.briefArtifact);
    expect(brief.ok && JSON.parse(brief.content.toString("utf8"))).toMatchObject({ sourceRun: run, head: "a".repeat(40), verification: { sourceRun: run, digest: expect.any(String) } });
    expect(repairGate(run)).toEqual({ kind: "none" });
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run, "refuted", T0)).toEqual({ kind: "none" });
  });

  test.each(["no-mode", "disabled", "expired", "hold", "unfinished", "uncommitted", "accepted", "decision", "custody", "stale-setup", "truncated", "redacted", "tampered", "new-command", "moved-head", "moved-scope", "published"])("automatic failed-check repair refuses %s", problem => {
    if (problem !== "no-mode") signMode({ repairAuto: problem !== "disabled", repairMaxAttempts: 3, ...(problem === "expired" ? { absoluteExpiry: new Date(T0.getTime() - 1).toISOString() } : {}) });
    const result: VerifyCommandFacts = problem === "custody" || problem === "stale-setup"
      ? { configured: true, ran: false, attemptFailed: true, failure: problem === "custody" ? "custody-lost" : "setup-stale" }
      : { configured: true, ran: true, exitCode: 1 };
    const run = failedGate("t-gate", result);
    const taskRef = store.lookupRef("t-gate")!.id;
    if (problem === "hold") store.holdOwned({ taskRef, ownerKind: "operator", ownerId: "alex", reason: "wait", until: null }, T0);
    if (problem === "unfinished") store.raw().prepare("UPDATE run SET outcome=NULL,finished_at=NULL WHERE id=?").run(run);
    if (problem === "uncommitted") store.raw().prepare("UPDATE run SET committed=0 WHERE id=?").run(run);
    if (problem === "accepted") store.acceptProof(run, "alex", null, T0);
    if (problem === "decision") store.saveDecision({ run, urgency: "blocking", recap: "r", question: "q", options: [{ id: "a", label: "a", consequence: "c", reversible: true }], recommendation: "a" }, T0);
    if (problem === "truncated" || problem === "redacted") {
      const log = store.artifactsFor(run).find(a => a.kind === "check-log")!;
      store.raw().prepare(`UPDATE artifact SET ${problem}=1 WHERE id=?`).run(log.id);
    }
    if (problem === "tampered") {
      const log = store.artifactsFor(run).find(a => a.kind === "check-log")!;
      writeFileSync(join(evidenceRoot, log.key), "different output");
    }
    if (problem === "new-command") store.setVerifyCommand({ repo: REPO, command: "different-check", timeoutMs: 300_000, approvedBy: "alex" }, new Date(T0.getTime() + 1));
    if (problem === "moved-head") store.recordOutcomeFacts(run, { headRevision: "c".repeat(40) });
    if (problem === "moved-scope") store.raw().prepare("UPDATE run SET scope_digest=? WHERE id=?").run("different", run);
    if (problem === "published") {
      const id = store.createPublicationIntent({ run, taskRef, githubRepo: "a/b", remote: "origin", base: "main", head: "b-t-gate", headSha: "a".repeat(40), bodyHash: "", draft: true }, T0);
      store.markPublicationPushed(id, T0);
      store.markPublicationOpened(id, 1, "https://github.com/a/b/pull/1", T0);
    }
    expect(repairGate(run)).toEqual({ kind: "none" });
    expect(store.repairChainFor(run)).toBeNull();
  });

  const unrelatedNotice = (run: number) => store.raw().prepare("SELECT subject, body, link FROM notification WHERE dedupe_key=?").get(`repair-unrelated:${run}`) as { subject: string; body: string; link: string } | undefined;

  test("a gate that ran out of time reruns once on the same commit instead of drafting a repair", () => {
    signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const run = failedGate("t-gate", { configured: true, ran: false, attemptFailed: true, failure: "timed-out" });
    store.setTaskState("t-gate", "done", T0);
    expect(repairGate(run)).toEqual({ kind: "none" });
    expect(store.repairChainFor(run)).toBeNull();
    expect(store.raw().prepare("SELECT subject, body FROM notification WHERE dedupe_key=?").get(`regate:${run}`)).toEqual({
      subject: "The project check ran out of time; running it once more",
      body: "The project check ran out of time (300 s) before any test failed, so the code was not shown to be wrong. The check runs again once on the same commit aaaaaaa, with no agent. If it fails again, a person decides.",
    });
    expect(store.getScope("t-gate")).toMatchObject({ candidate: "a".repeat(40), approvalBasis: "mode" });
    expect(store.getTask("t-gate")?.state).toBe("queued");
    expect(unrelatedNotice(run)).toBeUndefined();
    expect(repairGate(run)).toEqual({ kind: "none" });
    expect(store.raw().prepare("SELECT count(*) AS n FROM notification WHERE dedupe_key=?").get(`regate:${run}`)).toEqual({ n: 1 });
  });

  /** Run 1784 (mayhem-spire, 2026-09-18): the diff touched run.ts and two
   * tests; the only failure was an untouched balance probe's own timeout. */
  const probeLog = [
    "      Tests  1 failed | 163 passed (164)", "",
    " FAIL  src/core/autobattler.test.ts > balance probe (non-asserting) > win-rate & leak table",
    "Error: Test timed out in 120000ms.",
  ].join("\n");
  const inventory = (files: string[], filesTruncated = false) => JSON.stringify({ schema: 1, base: "b".repeat(40), head: "a".repeat(40), fileCount: files.length, additions: 1, deletions: 0, binaryCount: 0, files: files.map(path => ({ path, additions: 1, deletions: 0 })), filesTruncated });
  const untouchedProbe = (files: string[], options: { filesTruncated?: boolean; log?: string } = {}) => {
    if (!store.lookupRef("t-gate")) seedTask("t-gate");
    if (!store.liveVerifyCommand(REPO)) store.setVerifyCommand({ repo: REPO, command: "npm test && npm run build", timeoutMs: 300_000, approvedBy: "alex" }, T0);
    const run = seedRun("t-gate", "refuted", CRITERIA.map(c => row(c.id, "pass")));
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), baseRevision: "b".repeat(40) });
    storeEvidence(store, evidenceRoot, run, "diff-stat", "terminal-diff-stat.json", Buffer.from(inventory(files, options.filesTruncated)), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from(options.log ?? probeLog), "project check", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 1 }, T0);
    return run;
  };

  test("an unrelated failure reruns the check once on the same commit, automatically, then defers to a person", () => {
    const mode = signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const first = untouchedProbe(["src/core/run.ts", "src/core/run.test.ts"]);
    store.setTaskState("t-gate", "done", T0);
    expect(repairGate(first)).toEqual({ kind: "none" });
    // The rerun: the same scope terms, the last head as the prepared candidate, sealed under the mode, queued.
    const scope = store.getScope("t-gate")!;
    expect(scope.candidate).toBe("a".repeat(40));
    expect(scope.approvedDigest).toBe(scope.digest);
    expect(scope.approvalBasis).toBe("mode");
    expect(scope.modeDigest).toBe(mode.digest ?? modeDigestOf(mode));
    expect(store.getTask("t-gate")?.state).toBe("queued");
    expect(store.raw().prepare("SELECT subject FROM notification WHERE dedupe_key=?").get(`regate:${first}`)).toMatchObject({ subject: "A slow test outside this change failed the check; running it once more" });
    expect(store.raw().prepare("SELECT count(*) AS n FROM notification WHERE dedupe_key=?").get(`repair-unrelated:${first}`)).toEqual({ n: 0 });
    expect(store.repairChainFor(first)).toBeNull();
    // The rerun fails the same way on the same commit: no second rerun, a person is told.
    const second = untouchedProbe(["src/core/run.ts", "src/core/run.test.ts"]);
    store.setTaskState("t-gate", "done", T0);
    expect(repairGate(second)).toEqual({ kind: "none" });
    expect(store.raw().prepare("SELECT count(*) AS n FROM notification WHERE dedupe_key=?").get(`regate:${second}`)).toEqual({ n: 0 });
    expect(store.repairChainFor(second)).toBeNull();
    expect(store.raw().prepare("SELECT body FROM notification WHERE dedupe_key=?").get(`regate-failed:${second}`)).toMatchObject({ body: expect.stringContaining("standing-orders task regate t-gate") });
  });

  test("task regate on an operator's say-so reruns the check on the last commit and refuses an accepted result", () => {
    const run = failedGate("t-gate");
    store.setTaskState("t-gate", "done", T0);
    const rerun = regateTask(store, "t-gate", T0, { kind: "operator", name: "alex", token: alexToken });
    expect(rerun).toEqual({ ok: true, run, head: "a".repeat(40) });
    expect(store.getScope("t-gate")).toMatchObject({ candidate: "a".repeat(40), approvedBy: "alex" });
    expect(store.getTask("t-gate")?.state).toBe("queued");
    expect(store.raw().prepare("SELECT note FROM run_note WHERE run=?").all(run).some(row => String(row["note"]).includes("on alex's say-so"))).toBe(true);
    store.acceptProof(run, "alex", null, T0);
    expect(regateTask(store, "t-gate", T0, { kind: "operator", name: "alex", token: alexToken })).toMatchObject({ ok: false, reason: "accepted-result" });
    expect(regateTask(store, "t-none", T0, { kind: "operator", name: "alex", token: alexToken })).toMatchObject({ ok: false, reason: "no-task" });
  });

  test("a failed rerun on the same commit never drafts a repair, whatever failed the second time", () => {
    signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const first = untouchedProbe(["src/core/run.ts"]);
    store.setTaskState("t-gate", "done", T0);
    expect(repairGate(first)).toEqual({ kind: "none" });
    expect(store.getScope("t-gate")?.candidate).toBe("a".repeat(40));
    // The rerun fails on an ordinary, repairable failure at the same head.
    const rerun = failedGate("t-gate");
    store.setTaskState("t-gate", "done", T0);
    expect(repairGate(rerun)).toEqual({ kind: "none" });
    expect(store.repairChainFor(rerun)).toBeNull();
    expect(store.raw().prepare("SELECT subject, body FROM notification WHERE dedupe_key=?").get(`regate-failed:${rerun}`)).toMatchObject({
      subject: "The project check failed again on the same commit",
      body: expect.stringContaining("standing-orders task regate t-gate"),
    });
  });

  test("task regate refuses a published or claimed result even when the task is already queued", () => {
    const run = failedGate("t-gate");
    const taskRef = store.lookupRef("t-gate")!.id;
    const intent = store.createPublicationIntent({ run, taskRef, githubRepo: "a/b", remote: "origin", base: "main", head: "b-t-gate", headSha: "a".repeat(40), bodyHash: "", draft: true }, T0);
    store.markPublicationPushed(intent, T0);
    expect(store.getTask("t-gate")?.state).toBe("queued");
    expect(regateTask(store, "t-gate", T0, { kind: "operator", name: "alex", token: alexToken })).toMatchObject({ ok: false, reason: "published" });
    expect(store.getScope("t-gate")?.candidate ?? null).toBeNull();
  });

  test.each(["touched", "truncated-inventory", "assertion"])("a failure the change may have caused still repairs (%s)", problem => {
    signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const run = problem === "touched" ? untouchedProbe(["src/core/autobattler.test.ts"])
      : problem === "truncated-inventory" ? untouchedProbe(["src/core/run.ts"], { filesTruncated: true })
      : untouchedProbe(["src/core/run.ts"], { log: "      Tests  1 failed | 163 passed (164)\n FAIL  src/core/autobattler.test.ts > balance probe\nAssertionError: expected 14 to be 15" });
    expect(repairGate(run)).toMatchObject({ kind: "drafted", approved: true, attempt: 1 });
    expect(unrelatedNotice(run)).toBeUndefined();
  });

  test("a publication intent that has never run does not strand failed-check repair", () => {
    signMode({ repairAuto: true, repairMaxAttempts: 3 });
    const run = failedGate();
    store.createPublicationIntent({ run, taskRef: store.lookupRef("t-gate")!.id, githubRepo: "a/b", remote: "origin", base: "main", head: "b-t-gate", headSha: "a".repeat(40), bodyHash: "", draft: true }, T0);
    expect(repairGate(run)).toMatchObject({ kind: "drafted" });
  });

  test.each([1, 3])("failed-check repairs share the existing attempt and no-progress stops (cap %i)", cap => {
    signMode({ repairAuto: true, repairMaxAttempts: cap });
    const first = repairGate(failedGate());
    if (first.kind !== "drafted") throw Error("expected first repair");
    const second = repairGate(failedGate(first.draftTaskId));
    if (cap === 1) expect(second).toEqual({ kind: "stopped", reason: "repair-attempts-spent" });
    else {
      if (second.kind !== "drafted") throw Error("expected second repair");
      expect(repairGate(failedGate(second.draftTaskId))).toEqual({ kind: "stopped", reason: "repair-no-progress" });
    }
  });

  test("short → draft → approve → attempt 2 resolves → chain closes", () => {
    seedTask("t-1");
    const run1 = seedRun("t-1", "short", [row("c1", "missing"), row("c2", "pass"), row("c3", "pass")]);

    const trigger = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (trigger.kind !== "drafted") throw new Error(`expected a draft, got ${trigger.kind}`);
    expect(trigger.attempt).toBe(1);
    expect(trigger.approved).toBe(false); // no mode: waits for a person
    expect(trigger.draftTaskId).toBe("t-1-fix-1");

    const chain = store.repairChainFor(run1);
    expect(chain).toMatchObject({ rootTask: "t-1", sourceRun: run1, attempt: 1, draftTask: "t-1-fix-1", basis: "human", modeDigest: null, unresolved: ["c1"], outcome: "drafted" });

    // The draft inherits the signed rubric verbatim, and is unapproved by default.
    const draftScope = store.getScope("t-1-fix-1");
    expect(draftScope?.acceptance.map(c => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(draftScope?.approvedAt).toBeNull();

    // The operator approves it — the CLI's `task repair --yes` road.
    const approved = approve(store, "t-1-fix-1", "alex", T0, draftScope!.digest, alexToken);
    expect(approved.ok).toBe(true);

    // Attempt 1 resolves clean: the chain closes right there.
    seedRun("t-1-fix-1", "verified", [row("c1", "pass"), row("c2", "pass"), row("c3", "pass")]);
    const settled = store.repairChainForRoot("t-1");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "resolved" });
    expect(settled[0]?.settledAt).not.toBeNull();
  });

  test("a mode-authorized draft auto-approves within its signed cap", () => {
    seedTask("t-2");
    signMode({ repairAuto: true, repairMaxAttempts: 2 });
    const run1 = seedRun("t-2", "short", [row("c1", "missing"), row("c2", "pass"), row("c3", "pass")]);
    const trigger = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (trigger.kind !== "drafted") throw new Error("expected a draft");
    expect(trigger.approved).toBe(true);
    expect(store.getScope("t-2-fix-1")?.approvedAt).not.toBeNull();
    expect(store.repairChainFor(run1)?.basis).toBe("mode");
  });

  test("three attempts exhaust a signed cap of 3 — repair-attempts-spent, no fourth draft", () => {
    seedTask("t-3");
    signMode({ repairAuto: true, repairMaxAttempts: 3 });

    const run1 = seedRun("t-3", "short", [row("c1", "missing"), row("c2", "missing"), row("c3", "missing")]);
    const t1 = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (t1.kind !== "drafted") throw new Error("attempt 1 should draft");
    expect(t1.attempt).toBe(1);

    // Attempt 1's build makes progress (c3 resolved) but still leaves 2 unmet.
    const run2 = seedRun(t1.draftTaskId, "short", [row("c1", "missing"), row("c2", "missing"), row("c3", "pass")]);
    const t2 = maybeTriggerRepair(store, REPO, evidenceRoot, run2, "short", T0);
    if (t2.kind !== "drafted") throw new Error("attempt 2 should draft");
    expect(t2.attempt).toBe(2);

    // Attempt 2 makes progress again (c2 resolved).
    const run3 = seedRun(t2.draftTaskId, "short", [row("c1", "missing"), row("c2", "pass"), row("c3", "pass")]);
    const t3 = maybeTriggerRepair(store, REPO, evidenceRoot, run3, "short", T0);
    if (t3.kind !== "drafted") throw new Error("attempt 3 should draft");
    expect(t3.attempt).toBe(3);

    // Attempt 3 makes NO progress (c1 still unmet, unchanged) — the cap,
    // not no-progress, is what should fire here (only one non-shrinking
    // transition so far).
    const run4 = seedRun(t3.draftTaskId, "short", [row("c1", "missing"), row("c2", "pass"), row("c3", "pass")]);
    const t4 = maybeTriggerRepair(store, REPO, evidenceRoot, run4, "short", T0);
    expect(t4).toEqual({ kind: "stopped", reason: "repair-attempts-spent" });

    // Exactly one chain (one inbox item), three attempts, no fourth draft.
    const chain = store.repairChainForRoot("t-3");
    expect(chain).toHaveLength(3);
    expect(chain[2]).toMatchObject({ attempt: 3, outcome: "attempts-spent" });
    expect(store.getTask("t-3-fix-4")).toBeNull();
    expect(store.repairChainFor(run4)).toBeNull();
  });

  test("no-progress: two consecutive non-shrinking attempts stop the chain early", () => {
    seedTask("t-4");
    const run1 = seedRun("t-4", "short", [row("c1", "missing"), row("c2", "missing")]);
    const t1 = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (t1.kind !== "drafted") throw new Error("attempt 1 should draft");

    // Attempt 1 makes no progress at all.
    const run2 = seedRun(t1.draftTaskId, "short", [row("c1", "missing"), row("c2", "missing")]);
    const t2 = maybeTriggerRepair(store, REPO, evidenceRoot, run2, "short", T0);
    if (t2.kind !== "drafted") throw new Error("attempt 2 should still draft — only one non-shrink so far");

    // Attempt 2 ALSO makes no progress — two consecutive, chain closes.
    const run3 = seedRun(t2.draftTaskId, "short", [row("c1", "missing"), row("c2", "missing")]);
    const t3 = maybeTriggerRepair(store, REPO, evidenceRoot, run3, "short", T0);
    expect(t3).toEqual({ kind: "stopped", reason: "repair-no-progress" });

    const chain = store.repairChainForRoot("t-4");
    expect(chain).toHaveLength(2);
    expect(chain[1]).toMatchObject({ attempt: 2, outcome: "no-progress" });
    expect(store.getTask("t-4-fix-3")).toBeNull();
  });

  test("an integrity refutation never drafts an automatic repair — it parks for a human", () => {
    seedTask("t-5");
    const run1 = seedRun("t-5", "refuted", [row("c1", "failed")], [
      'criterion "c1" was signed as "The payout guard is wired in." and the proof restates it as "something else"',
    ]);
    const trigger = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "refuted", T0);
    expect(trigger).toEqual({ kind: "stopped", reason: "repair-refused-integrity" });

    const chain = store.repairChainFor(run1);
    expect(chain).toMatchObject({ rootTask: "t-5", attempt: 1, draftTask: null, outcome: "integrity-refused" });
    expect(chain?.settledAt).not.toBeNull();
    expect(store.getTask("t-5-fix-1")).toBeNull();
  });

  test("an integrity refutation mid-chain settles the LAST drafted attempt, not a fresh row", () => {
    seedTask("t-6");
    const run1 = seedRun("t-6", "short", [row("c1", "missing"), row("c2", "missing")]);
    const t1 = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (t1.kind !== "drafted") throw new Error("attempt 1 should draft");

    const run2 = seedRun(t1.draftTaskId, "refuted", [row("c1", "failed")], ['claimed changed path not in the sealed diff: src/x.ts']);
    const trigger = maybeTriggerRepair(store, REPO, evidenceRoot, run2, "refuted", T0);
    expect(trigger).toEqual({ kind: "stopped", reason: "repair-refused-integrity" });

    const chain = store.repairChainForRoot("t-6");
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ attempt: 1, outcome: "integrity-refused", draftTask: "t-6-fix-1" });
  });

  test("no mode: the draft waits unapproved, and repeated attempts are never capped", () => {
    seedTask("t-7");
    const run1 = seedRun("t-7", "short", [row("c1", "missing")]);
    const t1 = maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0);
    if (t1.kind !== "drafted") throw new Error("expected a draft");
    expect(t1.approved).toBe(false);
    expect(store.repairChainFor(run1)?.basis).toBe("human");
    expect(store.repairChainFor(run1)?.modeDigest).toBeNull();
  });

  test("verdicts other than short/refuted never trigger — nothing drafted, nothing settled", () => {
    seedTask("t-8");
    const run1 = seedRun("t-8", "attested", [row("c1", "pass")]);
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run1, "attested", T0)).toEqual({ kind: "none" });
    expect(store.repairChainFor(run1)).toBeNull();
  });

  test("a scout task (report deliverable) is never repaired", () => {
    store.createTask({ id: "t-scout", title: "scout" }, T0);
    const ref = store.refFor(BUILT_IN, "t-scout", "ours");
    store.raw().prepare("UPDATE task_ref SET deliverable = 'report' WHERE id = ?").run(ref.id);
    store.placeTask(ref.id, REPO);
    propose(store, { taskId: "t-scout", goal: "scout it", acceptance: CRITERIA, now: T0 });
    const run1 = seedRun("t-scout", "short", [row("c1", "missing")]);
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0)).toEqual({ kind: "none" });
  });

  test("a run whose proof was already accepted is never repaired", () => {
    seedTask("t-9");
    const run1 = seedRun("t-9", "short", [row("c1", "missing")]);
    store.acceptProof(run1, "alex", null, T0);
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0)).toEqual({ kind: "none" });
  });

  test("a task with an open decision is never repaired", () => {
    seedTask("t-10");
    const run1 = seedRun("t-10", "short", [row("c1", "missing")]);
    store.saveDecision(
      { run: run1, urgency: "blocking", recap: "r", question: "q", options: [{ id: "a", label: "a", consequence: "c", reversible: true }], recommendation: "a" },
      T0,
    );
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0)).toEqual({ kind: "none" });
  });

  test("a verdict with no missing/failed rows (manual-review only) never triggers", () => {
    seedTask("t-11");
    const run1 = seedRun("t-11", "short", [row("c1", "manual-review")]);
    expect(maybeTriggerRepair(store, REPO, evidenceRoot, run1, "short", T0)).toEqual({ kind: "none" });
  });
});
