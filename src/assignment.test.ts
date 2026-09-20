import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type RunStop } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { mintCoordinator, revokeCoordinator, authenticateCoordinator, taskDetailFor } from "./coordinator.js";
import { assignmentForCoordinator, runAssignmentCommand } from "./assignment-adapters.js";
import { executeMateTool } from "./mate-tools.js";
import { verifyApproverStanding } from "./principal.js";
import { serveMcp, MODERN } from "./mcp.js";
import { storeEvidence, readVerifiedArtifact } from "./evidence.js";
import { storeStructuredAttempt } from "./structured-output.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { reviewContextBindingOf, parseReviewContext, reviewContextCustodyProblem } from "./review-context.js";
import { maybeTriggerRepair } from "./dispose.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { taskWorkSummaryOf } from "./work-summary.js";
import { requestResultChanges } from "./result-actions.js";
import * as taskControl from "./task-control.js";
import { assignmentOf, assignmentBrief, assignmentEvidenceIntact, assignmentUpdates, checkAssignment, claimAssignment, syncAssignmentHandoffs, type AssignmentOwner } from "./assignment.js";

const NOW = new Date("2026-09-20T10:00:00Z");
const REPO = "/repos/assignment";
const access = { principal: "operator" as const, repos: null, includeUnplaced: true };
const rubric = [{ id: "c1", statement: "A retry keeps the same request key.", how: null, evidence: ["check"] as const }];

describe("continuous assignments over existing task families", () => {
  let store: Store;
  let dir: string;
  let token: string, leadToken: string;
  let lead: AssignmentOwner;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-assignment-"));
    store = openStore(join(dir, "orders.db"));
    const operator = addApprover(store, "operator", NOW);
    if (!operator.ok) throw new Error("operator fixture");
    token = operator.token;
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", NOW);
    const coordinator = mintCoordinator(store, { name: "lead", repos: [REPO], by: "operator", now: NOW });
    if (!coordinator.ok) throw new Error("coordinator fixture");
    leadToken = coordinator.token;
    lead = { kind: "coordinator", id: coordinator.cid, label: "lead" };
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  function task(id = "retry", repo = REPO) {
    store.createTask({ id, title: "Keep retry requests safe" }, NOW);
    const ref = store.lookupRef(id)!;
    store.placeTask(ref.id, repo);
    propose(store, { taskId: id, goal: "Keep retry requests safe", touches: ["src/retry.ts"], acceptance: rubric, now: NOW });
    expect(approve(store, id, "operator", NOW, store.getScope(id)!.digest, token).ok).toBe(true);
    return id;
  }
  function question(run: number) {
    return store.saveDecision({ run, urgency: "blocking", recap: "Keep the request policy explicit.", question: "Should retries keep the original request key?",
      options: [{ id: "keep", label: "Keep the key", consequence: "Retries preserve request identity.", reversible: true }],
      recommendation: "keep", deadline: new Date(NOW.getTime() - 1).toISOString() }, NOW);
  }
  function built(id = task(), verified = true, shortenedChecks = false, withQuestion = false, checkExitCode = 0) {
    const ref = store.lookupRef(id)!;
    const authority = store.routeAuthorityFor(ref.id, "builder");
    if (!authority?.ok) throw new Error("route fixture");
    const run = store.startRun({ taskRef: ref.id, leaseId: `lease-${id}`, runner: "builder", branch: `so/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The retry preserves the request key." });
    if (withQuestion) question(run);
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    store.setTaskState(id, "done", NOW);
    store.saveProofVerdict(run, verified ? "verified" : "short", verified ? [] : ["The retry evidence is missing."], NOW,
      [{ id: "c1", statement: rubric[0]!.statement, requiredEvidence: ["check"], state: verified ? "pass" : "missing",
        detail: verified ? [] : ["Missing retry test."], answered: [], review: verified ? { judgement: "upholds", note: "The check covers request identity." } : null }], verified ? "verified" : "short");
    store.setVerifyCommand({ repo: ref.repo!, command: "npm test", timeoutMs: 300_000, approvedBy: "operator" }, NOW);
    storeEvidence(store, dir, run, "check-log", "checks.txt", shortenedChecks ? Buffer.alloc(200_000, 120) : Buffer.from("1 retry test passed"), "npm test", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(ref.repo!)!, { configured: true, ran: true, exitCode: checkExitCode }, NOW);
    storeEvidence(store, dir, run, "proof", "proof.json", Buffer.from(JSON.stringify({ version: 1,
      criteria: [{ id: "c1", statement: rubric[0]!.statement, verdict: "met", how: "The retry assertion passed.", evidence: [{ kind: "check", ref: "npm test" }] }],
      checks: [{ command: "npm test", exitCode: 0, summary: "1 passed" }], changed: ["src/retry.ts"], caveats: [], screenshots: [] })), "builder proof", NOW, { captureStatus: "ok" });
    return run;
  }
  function reviewed(run: number) {
    const actual = store.reviewRetryStateOf.bind(store);
    vi.spyOn(store, "reviewRetryStateOf").mockImplementation(id => id === run ? {
      ...actual(id)!, state: "succeeded", succeeded: { runId: run + 100, requestId: 1, attempt: 1, runner: "reviewer", outcome: "no-change", reason: null, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() },
    } : actual(id));
  }
  function research(withQuestion = false) {
    store.createTask({ id: "research", title: "Explain retry behavior", deliverable: "report" }, NOW);
    const ref = store.lookupRef("research")!; store.placeTask(ref.id, REPO);
    propose(store, { taskId: "research", goal: "Explain retry behavior", acceptance: rubric, now: NOW });
    expect(approve(store, "research", "operator", NOW, store.getScope("research")!.digest, token).ok).toBe(true);
    const route = store.routeAuthorityFor(ref.id, "scout"); if (!route?.ok) throw Error("scout route");
    const run = store.startRun({ taskRef: ref.id, runner: "scout", leaseId: "research", branch: "so/research", worktree: "/pool/research", role: "scout", provider: "claude", model: "sonnet", route: route.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope("research")!.digest });
    if (withQuestion) question(run);
    store.finishRun(run, { outcome: "built", reason: "report-delivered", now: NOW }); store.setTaskState("research", "done", NOW);
    return { ref, run };
  }

  test("claim is durable, project scoped and exclusive; revoked identities cannot inherit or check", () => {
    task();
    const before = store.actionLedger({ repos: null }).length;
    assignmentOf(store, "retry", NOW, access, dir);
    expect(store.actionLedger({ repos: null })).toHaveLength(before);
    expect(claimAssignment(store, "retry", lead, NOW, dir)).toMatchObject({ ok: true, assignment: { owner: { id: lead.id, active: true } } });
    expect(claimAssignment(store, "retry", lead, NOW, dir).ok).toBe(true);
    expect(store.actionLedger({ repos: null }).filter(a => a.action === "assignment claimed")).toHaveLength(1);
    const second = mintCoordinator(store, { name: "second", repos: [REPO], by: "operator", now: NOW });
    if (!second.ok) throw new Error("second fixture");
    const other = { kind: "coordinator" as const, id: second.cid, label: "second" };
    expect(claimAssignment(store, "retry", other, NOW, dir)).toMatchObject({ ok: false, reason: "owned" });
    revokeCoordinator(store, lead.id, "operator", NOW);
    expect(claimAssignment(store, "retry", lead, NOW, dir)).toMatchObject({ ok: false, reason: "not-found" });
    expect(claimAssignment(store, "retry", other, NOW, dir).ok).toBe(true);
    expect(assignmentOf(store, "retry", NOW, { principal: "coordinator", repos: ["/private"] }, dir)).toBeNull();
  });

  test("the root follows an automatically approved correction without losing the original owner", () => {
    const run = built(task(), false);
    claimAssignment(store, "retry", lead, NOW, dir);
    const terms = { ...presetTerms("standard", "2026-09-21T10:00:00Z"), repairAuto: true, repairMaxAttempts: 2 };
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "operator", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, NOW);
    const trigger = maybeTriggerRepair(store, REPO, dir, run, "short", NOW);
    expect(trigger).toMatchObject({ kind: "drafted", approved: true });
    if (trigger.kind !== "drafted") throw new Error("repair fixture");
    const root = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(root).toMatchObject({ rootId: "retry", activeTaskId: trigger.draftTaskId, owner: { id: lead.id } });
    expect(root.attempts.map(a => a.taskId)).toEqual(["retry", trigger.draftTaskId]);
    expect(assignmentOf(store, trigger.draftTaskId, NOW, access, dir)?.rootId).toBe("retry");
    expect(root.state).not.toBe("complete");
    expect(store.getScope(trigger.draftTaskId)?.approvedAt).not.toBeNull();
  });

  test("a checked result reaches its lead before independent review; acknowledgment changes no authority", () => {
    const run = built();
    expect(assignmentOf(store, "retry", NOW, access, dir)).toMatchObject({ state: "ready-to-check", receipt: { completionKind: "checked-build" } });
    claimAssignment(store, "retry", lead, NOW, dir);
    const before = store.getScope("retry");
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready.state).toBe("ready-to-check");
    expect(checkAssignment(store, "retry", "f".repeat(64), lead, NOW, dir)).toMatchObject({ ok: false, reason: "stale" });
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete", deployment: { status: "not-recorded" } } });
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir).ok).toBe(true);
    expect(store.actionLedger({ repos: null }).filter(a => a.action === "assignment handoff checked")).toHaveLength(1);
    expect(store.getScope("retry")).toEqual(before);
    expect(store.proofAcceptance(run)).toBeNull();
    expect(store.publicationForRun(run)).toBeNull();
    expect(store.reviewRetryStateOf(run)?.state).toBe("unrequested");
    store.recordOutcomeFacts(run, { headRevision: "c".repeat(40) });
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision"); // Gate still binds the old head.
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "stale" });
  });

  test("semantic evidence gaps reach the lead once without changing checks or the review verdict", () => {
    const run = built();
    store.saveProofVerdict(run, "short", ["The reviewer could not inspect the runtime reference."], NOW,
      [{ id: "c1", statement: rubric[0]!.statement, requiredEvidence: ["check"], state: "missing", detail: ["Missing runtime reference."], answered: [],
        review: { judgement: "cannot-tell", note: "Missing runtime reference." } }], "verified");
    claimAssignment(store, "retry", lead, NOW, dir);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready).toMatchObject({ state: "ready-to-check", attention: ["The reviewer could not inspect the runtime reference."], receipt: { completionKind: "checked-build" } });
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    expect(store.proofAcceptance(run)).toBeNull();
    expect(store.repairChainFor(run)).toBeNull();
  });

  test.each(["short", "refuted"] as const)("a %s goal-review record cannot force another build when the native check passed", verdict => {
    const run = built(task(), false);
    store.saveProofVerdict(run, verdict, ["The saved source inventory is truncated; a screenshot is missing."], NOW,
      [{ id: "c1", statement: rubric[0]!.statement, requiredEvidence: ["check"], state: "missing", detail: ["Source inventory and screenshot unavailable."],
        answered: [], review: null }], verdict);
    claimAssignment(store, "retry", lead, NOW, dir);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready).toMatchObject({ state: "ready-to-check", attention: ["The saved source inventory is truncated; a screenshot is missing."], receipt: { completionKind: "checked-build" } });
    const before = store.proofVerdictFor(run), runs = store.runsFor(store.lookupRef("retry")!.id);
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.proofVerdictFor(run)).toEqual(before);
    expect(store.runsFor(store.lookupRef("retry")!.id)).toEqual(runs);
    expect(store.reviewRetryStateOf(run)?.state).toBe("unrequested");
    expect(store.repairChainFor(run)).toBeNull();
    expect(store.proofAcceptance(run)).toBeNull();
  });

  test("failed machine checks cannot become a completed lead review", () => {
    built(task(), false, false, false, 1);
    claimAssignment(store, "retry", lead, NOW, dir);
    const result = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(result.state).toBe("needs-decision");
    expect(result.receipt?.completionKind).toBeNull();
    expect(checkAssignment(store, "retry", result.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    expect(store.actionLedger({ repos: null }).filter(a => a.action === "assignment handoff checked")).toHaveLength(0);
  });

  test("strict release keeps its requested independent review", () => {
    store.setQualityDefault("strict", "operator", NOW);
    const run = built();
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
    reviewed(run);
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("ready-to-check");
  });

  test("passing checks do not hide unresolved process custody", () => {
    const run = built();
    vi.spyOn(store, "stopQuiescenceProblem").mockReturnValue("A process exit has not been observed.");
    expect(assignmentOf(store, "retry", NOW, access, dir)).toMatchObject({ state: "needs-decision", detail: "A process exit has not been observed.",
      primaryAction: { code: "inspect-run", target: { runId: run } } });
  });

  test("missing artifact bytes refuse acknowledgment, including replay of an earlier checked receipt", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    const receipt = assignmentOf(store, "retry", NOW, access, dir)!.receipt!;
    expect(checkAssignment(store, "retry", receipt.digest, lead, NOW, dir).ok).toBe(true);
    const coordinator = authenticateCoordinator(store, leadToken), operator = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [REPO]);
    if (!coordinator.ok || !operator.ok) throw Error("read principals");
    const lines: string[] = []; let receive = (_line: string) => {};
    serveMcp(store, leadToken, { onLine: fn => { receive = fn; }, onEof: () => {}, write: line => lines.push(line), log: () => {}, exit: () => {} }, () => NOW, [REPO], dir);
    const read = () => {
      runAssignmentCommand(["show", "retry"], new Map(), { store, now: NOW, json: true, evidenceRoot: dir, write: line => lines.push(line) });
      const cli = JSON.parse(lines.at(-1)!).result;
      receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_assignment", arguments: { ref: "retry" }, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } }));
      const mcp = JSON.parse(JSON.parse(lines.at(-1)!).result.content[0].text);
      const chat = executeMateTool({ store, who: operator.who, now: NOW, evidenceRoot: dir, draft: () => null, step: 1, readDecisions: new Map() }, "get_task", { task: "retry" });
      expect(chat.ok).toBe(true);
      return [cli, mcp, taskDetailFor(store, coordinator.who, "retry", dir, NOW)?.assignment, chat.ok ? (chat.body as { assignment: unknown }).assignment : null];
    };
    for (const one of read()) expect(one).toMatchObject({ state: "complete" });
    const artifact = store.artifactsFor(run).find(a => a.kind === "check-log")!;
    const original = readVerifiedArtifact(dir, artifact); if (!original.ok) throw Error("fixture bytes");
    writeFileSync(join(dir, artifact.key), "changed check output");
    const before = store.actionLedger({ repos: null });
    for (const one of read()) expect(one).toMatchObject({ state: "needs-decision", handoff: { kind: "attention", acknowledged: false }, primaryAction: { label: "Review evidence", target: { runId: run } } });
    expect(store.actionLedger({ repos: null })).toEqual(before);
    expect(assignmentForCoordinator(store, leadToken, "show", { ref: "retry" }, NOW)).toMatchObject({ ok: true, body: { state: "needs-decision" } });
    syncAssignmentHandoffs(store, NOW, [REPO], dir); syncAssignmentHandoffs(store, NOW, [REPO], dir);
    const updates = assignmentUpdates(store, NOW, access, { after: 0, limit: 50 }, dir).events;
    expect(updates).toHaveLength(2); expect(updates[0]?.superseded).toBe(true);
    expect(updates[1]).toMatchObject({ superseded: false, assignment: { state: "needs-decision" } });
    writeFileSync(join(dir, artifact.key), original.content);
    for (const one of read()) expect(one).toMatchObject({ state: "complete" });
    writeFileSync(join(dir, artifact.key), "changed check output");
    expect(checkAssignment(store, "retry", receipt.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    expect(store.proofAcceptance(run)).toBeNull();
  });

  test("a scoped research report can be checked without inventing a commit, proof or independent review", () => {
    const { ref, run } = research();
    const missing = assignmentOf(store, "research", NOW, access, dir)!;
    expect(missing.state).toBe("needs-decision"); expect(missing.detail).toContain("report is missing or incomplete");
    const artifact = storeEvidence(store, dir, run, "report", "report.json", Buffer.from(JSON.stringify({ title: "Retries", summary: "Retries preserve identity.", report: "The request key remains unchanged.", followUps: [] })), "scout report", NOW, { captureStatus: "ok" });
    claimAssignment(store, "research", lead, NOW, dir);
    const ready = assignmentOf(store, "research", NOW, access, dir)!;
    expect(assignmentBrief(ready)?.result).toMatchObject({ completionKind: "research-report", head: null, verdict: null });
    expect(ready.state).toBe("ready-to-check");
    store.hold(ref.id, "Pause the handoff", null, NOW);
    expect(checkAssignment(store, "research", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "not-ready" });
    store.unhold(ref.id, {}, NOW);
    expect(checkAssignment(store, "research", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.proofAcceptance(run)).toBeNull(); expect(store.proofVerdictFor(run)).toBeNull();
    writeFileSync(join(dir, store.getArtifact(artifact)!.key), "changed report");
    expect(assignmentOf(store, "research", NOW, access, dir)?.state).toBe("needs-decision");
    expect(assignmentEvidenceIntact(store, dir, ready.receipt!)).toBe(false);
    expect(checkAssignment(store, "research", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
  });

  test.each(["verified-build", "research-report", "accepted-exception"] as const)("an unresolved question blocks a completed %s until its normal answer", kind => {
    const id = kind === "research-report" ? "research" : "retry";
    const run = kind === "research-report" ? research(true).run : built(task(), kind === "verified-build", false, true);
    if (kind === "research-report") storeEvidence(store, dir, run, "report", "report.json", Buffer.from(JSON.stringify({ title: "Retries", summary: "Keep request identity.", report: "The request key remains unchanged.", followUps: [] })), "scout report", NOW, { captureStatus: "ok" });
    else if (kind === "verified-build") reviewed(run);
    else store.acceptProof(run, "operator", "Inspected the recorded limitations", NOW);
    claimAssignment(store, id, lead, NOW, dir);
    const decision = store.decisionForRun(run)!;
    const scope = store.getScope(id), acceptance = store.proofAcceptance(run);
    for (const state of ["open", "expired"]) {
      if (state === "expired") store.expireOverdueDecisions(NOW);
      expect(store.getDecision(decision.id)?.state).toBe(state);
      const current = assignmentOf(store, id, NOW, access, dir)!;
      expect(current).toMatchObject({ state: "needs-decision", detail: decision.question,
        receipt: { completionKind: kind }, handoff: { kind: "decision", acknowledged: false },
        primaryAction: { code: "answer-decision", target: { taskId: id, runId: run, decisionId: decision.id }, access: "operator-control" } });
      expect(assignmentOf(store, id, NOW, { principal: "coordinator", repos: [REPO] }, dir)?.primaryAction).toEqual({ ...current.primaryAction, access: "proposal-only" });
      expect(taskWorkSummaryOf(store, id, NOW, access)?.primaryAction).toEqual(current.primaryAction);
      expect(checkAssignment(store, id, current.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "not-ready" });
    }
    if (kind === "verified-build") {
      const completed = store.reviewRetryStateOf(run)!;
      const review = vi.spyOn(store, "reviewRetryStateOf").mockReturnValue({ ...completed, state: "queued" });
      expect(assignmentOf(store, id, NOW, access, dir)).toMatchObject({ state: "needs-decision", primaryAction: { code: "answer-decision" } });
      expect(taskWorkSummaryOf(store, id, NOW, access)?.primaryAction?.code).toBe("answer-decision");
      vi.spyOn(taskControl, "taskControlOf").mockReturnValueOnce({ kind: "paused", run, role: "builder", stop: {} as RunStop, outcome: "interrupted", committed: false, worktree: null });
      expect(assignmentOf(store, id, NOW, access, dir)).toMatchObject({ state: "needs-decision", primaryAction: { code: "resume-run" }, attention: [expect.stringContaining("stopped attempt"), decision.question] });
      review.mockReturnValue(completed);
    }
    expect(store.actionLedger({ repos: null }).some(a => a.action === "assignment handoff checked")).toBe(false);
    expect(store.answerDecision({ id: decision.id, choice: "keep", by: "operator", via: "cli" }, NOW).ok).toBe(true);
    const ready = assignmentOf(store, id, NOW, access, dir)!;
    expect(ready.state).toBe("ready-to-check");
    expect(taskWorkSummaryOf(store, id, NOW, access)?.nextActions.some(a => a.code === "answer-decision")).toBe(false);
    expect(checkAssignment(store, id, ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.getScope(id)).toEqual(scope); expect(store.proofAcceptance(run)).toEqual(acceptance);
  });

  test("an earlier version's overdue question blocks its completed correction and keeps the original answer target", () => {
    const original = built(task(), false, false, true);
    expect(taskWorkSummaryOf(store, "retry", NOW, access)?.primaryAction).toEqual(assignmentOf(store, "retry", NOW, access, dir)?.primaryAction);
    store.saveProofVerdict(original, "short", ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'], NOW,
      store.proofVerdictFor(original)!.matrix.map(row => ({ ...row, state: "manual-review" })), "short");
    expect(taskWorkSummaryOf(store, "retry", NOW, access)?.primaryAction?.code).toBe("answer-decision");
    expect(taskWorkSummaryOf(store, "retry", NOW, access)?.primaryAction).toEqual(assignmentOf(store, "retry", NOW, access, dir)?.primaryAction);
    storeEvidence(store, dir, original, "terminal-diff", "changes.patch", Buffer.from("diff --git a/src/retry.ts b/src/retry.ts\n"), "saved changes", NOW);
    const revision = requestResultChanges(store, dir, { run: original, batch: "", source: store.getScope("retry")!.digest,
      actor: "operator", repos: [REPO], note: "Keep the request key stable when retrying.", path: "", line: "", request: "a".repeat(32) }, NOW);
    expect(revision.ok).toBe(true); if (!revision.ok) throw Error(revision.message);
    expect(approve(store, revision.id, "operator", NOW, store.getScope(revision.id)!.digest, token).ok).toBe(true);
    const result = built(revision.id); reviewed(result); claimAssignment(store, "retry", lead, NOW, dir);
    revisionContext(result, original);
    store.expireOverdueDecisions(NOW);
    const decision = store.decisionForRun(original)!;
    const current = assignmentOf(store, revision.id, NOW, access, dir)!;
    expect(current).toMatchObject({ activeTaskId: revision.id, state: "needs-decision", detail: decision.question,
      receipt: { taskId: revision.id, runId: result },
      primaryAction: { code: "answer-decision", target: { taskId: "retry", runId: original, decisionId: decision.id } } });
    expect(checkAssignment(store, "retry", current.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "not-ready" });
    expect(store.answerDecision({ id: decision.id, choice: "keep", by: "operator", via: "web" }, NOW).ok).toBe(true);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
  });

  test.each(["missing", "truncated"])("an existing operator exception can be checked with %s proof, without accepting or verifying it again", missing => {
    const run = built(task(), false);
    store.raw().prepare("DELETE FROM artifact WHERE run = ? AND kind = 'proof'").run(run);
    if (missing === "truncated") storeEvidence(store, dir, run, "proof", "shortened-proof.json", Buffer.alloc(200_000, 120), "incomplete proof", NOW, { captureStatus: "ok" });
    const before = assignmentOf(store, "retry", NOW, access, dir)!.receipt!.digest;
    store.acceptProof(run, "operator", "Inspected the recorded limitations", NOW); claimAssignment(store, "retry", lead, NOW, dir);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready.state).toBe("ready-to-check"); expect(ready.receipt!.digest).not.toBe(before);
    expect(assignmentBrief(ready)?.result).toMatchObject({ completionKind: "accepted-exception", verdict: "short", proofAcceptance: { approver: "operator" } });
    if (missing === "missing") expect(ready.receipt!.caveats).toContain("No builder proof artifact is recorded.");
    else expect(ready.receipt!.artifacts.find(a => a.kind === "proof")?.complete).toBe(false);
    const acceptance = store.proofAcceptance(run);
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.proofAcceptance(run)).toEqual(acceptance); expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    store.acceptProof(run, "operator", "Updated exception limits", new Date(NOW.getTime() + 1));
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "stale" });
    const current = assignmentOf(store, "retry", NOW, access, dir)!;
    const saved = store.artifactsFor(run)[0]!; writeFileSync(join(dir, saved.key), "changed saved bytes");
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
    expect(assignmentEvidenceIntact(store, dir, current.receipt!)).toBe(false);
    expect(checkAssignment(store, "retry", current.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
  });

  test("acceptance cannot legitimize a failed or candidate-less builder result", () => {
    const run = built(task(), false); store.acceptProof(run, "operator", "Recorded exception", NOW);
    store.recordOutcomeFacts(run, { headRevision: "" });
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40) });
    store.raw().prepare("UPDATE run SET outcome = 'failed' WHERE id = ?").run(run);
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
  });

  test("rejected shortened native response diagnostics do not invalidate the final verified proof", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    const diagnostic = storeStructuredAttempt(store, dir, run, { phase: "builder-proof", attempt: 0, authoredRunId: run, raw: Buffer.alloc(80_000, 120), accepted: false, normalized: false, now: NOW });
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready.receipt!.artifacts.find(a => a.id === diagnostic)?.complete).toBe(false);
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    writeFileSync(join(dir, store.getArtifact(diagnostic)!.key), "changed diagnostic");
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
  });

  test("a shortened check log retains its limitation without invalidating its sealed passing gate", () => {
    const run = built(task(), true, true); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    const receipt = assignmentOf(store, "retry", NOW, access, dir)!.receipt!;
    expect(receipt.artifacts.find(a => a.kind === "check-log")?.complete).toBe(false);
    expect(receipt.caveats).toContain("The check log was shortened when stored; only the retained output is available.");
    expect(checkAssignment(store, "retry", receipt.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    const log = store.artifactsFor(run).find(a => a.kind === "check-log")!;
    writeFileSync(join(dir, log.key), "changed retained output");
    expect(checkAssignment(store, "retry", receipt.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
  });

  test("a recorded direct assessment uses its bound context, exact diff and gate without inventing builder proof", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    store.raw().prepare("DELETE FROM artifact WHERE run = ? AND kind = 'proof'").run(run);
    const previous = store.proofVerdictFor(run)!;
    const current = () => assignmentOf(store, "retry", NOW, access, dir)!.receipt!;
    // An ordinary verified matrix cannot use absence as substitute proof.
    expect(checkAssignment(store, "retry", current().digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    store.saveProofVerdict(run, "verified", [], NOW, previous.matrix.map(row => ({ ...row, assessment: { evidenceState: "pass", detail: [] } })), "verified");
    storeEvidence(store, dir, run, "terminal-diff", "diff.txt", Buffer.from("diff --git a/src/retry.ts b/src/retry.ts\n+keep(request.key)\n"), "git diff", NOW, { captureStatus: "ok" });
    storeEvidence(store, dir, run, "diff-stat", "stat.json", Buffer.from(JSON.stringify({ schema: 1, head: "a".repeat(40), base: "b".repeat(40), filesTruncated: false, files: [{ path: "src/retry.ts" }], fileCount: 1 })), "git diff stat", NOW, { captureStatus: "ok" });
    const handoff = storeEvidence(store, dir, run, "handoff", "handoff.txt", Buffer.from("The retry keeps the request key."), "builder handoff", NOW, { captureStatus: "ok" });
    expect(checkAssignment(store, "retry", current().digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    const context = storeEvidence(store, dir, run, "review-context", "context.json", Buffer.from(JSON.stringify({ schema: 3, identities: [],
      bindings: [reviewContextBindingOf(store, run, true)], run, head: "a".repeat(40), base: "b".repeat(40),
      handoff: { artifact: handoff, sha256: store.getArtifact(handoff)!.sha256, content: "The retry keeps the request key." },
      source: { task: "retry", run, head: "a".repeat(40), scopeDigest: store.getScope("retry")!.digest, verified: true, problems: [] },
      ancestry: { verified: true, detail: "same run" }, items: [], gaps: [], priorReview: [],
      coverage: [{ id: "c1", state: "patch", inherited: false, paths: ["src/retry.ts"], items: [], gaps: [], priorSupport: "none" }],
      limits: { itemBytes: 1024, aggregateBytes: 1024, items: 1 } })), "machine-captured review context", NOW, { captureStatus: "ok", redacted: true });
    const ready = current();
    const bytes = readVerifiedArtifact(dir, store.getArtifact(context)!);
    const parsed = bytes.ok ? parseReviewContext(bytes.content.toString("utf8")) : null;
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed?.ok && reviewContextCustodyProblem(store, dir, parsed.inventory)).toBeNull();
    expect(checkAssignment(store, "retry", ready.digest, lead, NOW, dir)).toMatchObject({ ok: true, assignment: { state: "complete" } });
    expect(store.artifactsFor(run).some(a => a.kind === "proof")).toBe(false);
    writeFileSync(join(dir, store.getArtifact(context)!.key), "changed context");
    expect(checkAssignment(store, "retry", ready.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
  });

  function revisionContext(run: number, original: number) {
    return storeEvidence(store, dir, run, "review-context", "context.json", Buffer.from(JSON.stringify({ schema: 3, identities: [],
      bindings: [reviewContextBindingOf(store, original)], run, head: "a".repeat(40), base: "b".repeat(40),
      source: { task: "retry", run: original, head: "a".repeat(40), scopeDigest: store.getScope("retry")!.digest, verified: true, problems: [] },
      ancestry: { verified: true, detail: "same repository revision" }, items: [], gaps: [], priorReview: [],
      coverage: [{ id: "c1", state: "patch", inherited: false, paths: ["src/retry.ts"], items: [], gaps: [], priorSupport: "none" }],
      limits: { itemBytes: 1024, aggregateBytes: 1024, items: 1 } })), "machine-captured review context", NOW, { captureStatus: "ok" });
  }

  test.each(["verified-build", "checked-build"] as const)("a %s revision refuses damaged ancestor evidence before handoff acknowledgment", kind => {
    const original = built();
    storeEvidence(store, dir, original, "terminal-diff", "changes.patch", Buffer.from("diff --git a/src/retry.ts b/src/retry.ts\n"), "saved changes", NOW);
    const revision = requestResultChanges(store, dir, { run: original, batch: "", source: store.getScope("retry")!.digest,
      actor: "operator", repos: [REPO], note: "Keep the same key through one more retry.", path: "", line: "", request: "b".repeat(32) }, NOW);
    expect(revision.ok).toBe(true); if (!revision.ok) throw Error(revision.message);
    expect(approve(store, revision.id, "operator", NOW, store.getScope(revision.id)!.digest, token).ok).toBe(true);
    const run = built(revision.id); if (kind === "verified-build") reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe(kind === "verified-build" ? "needs-decision" : "ready-to-check");
    if (kind === "verified-build") revisionContext(run, original);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(ready).toMatchObject({ state: "ready-to-check", receipt: { runId: run, completionKind: kind } });
    const ancestorProof = store.artifactsFor(original).find(one => one.kind === "proof")!;
    writeFileSync(join(dir, ancestorProof.key), "changed ancestor proof");
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    expect(store.actionLedger({ repos: null }).filter(a => a.action === "assignment handoff checked")).toEqual([]);
  });

  test("cancellation sends one durable terminal handoff without a result acknowledgment", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir); store.setTaskState("retry", "cancelled", NOW);
    syncAssignmentHandoffs(store, NOW, [REPO], dir);
    store.recordOutcomeFacts(run, { handoff: "Late worker diagnostics" }); syncAssignmentHandoffs(store, NOW, [REPO], dir);
    const assignment = assignmentOf(store, "retry", NOW, access, dir)!;
    expect(assignment).toMatchObject({ state: "cancelled", handoff: { kind: "attention", acknowledged: false } });
    expect(checkAssignment(store, "retry", assignment.receipt!.digest, lead, NOW, dir)).toMatchObject({ ok: false, reason: "not-ready" });
    expect(store.listNotifications("all").filter(n => n.subject === "Assignment cancelled")).toHaveLength(1);
    expect(assignmentUpdates(store, NOW, access, { after: 0, limit: 100 }, dir).events.at(-1)).toMatchObject({ superseded: false, assignment: { state: "cancelled" } });
    expect(store.actionLedger({ repos: null }).filter(a => a.action === "assignment handoff checked")).toEqual([]);
  });

  test("failed proof and an active earlier version never inherit an acknowledgment", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    const ready = assignmentOf(store, "retry", NOW, access, dir)!;
    store.saveProofVerdict(run, "refuted", ["The retry can be sent twice."], NOW, store.proofVerdictFor(run)!.matrix, "verified");
    expect(assignmentOf(store, "retry", NOW, access, dir)?.state).toBe("needs-decision");
    expect(checkAssignment(store, "retry", ready.receipt!.digest, lead, NOW, dir).ok).toBe(false);
  });

  test("handoffs dedupe after restart; scoped cursors exclude foreign events and stale notices stay explicit", () => {
    const run = built(); reviewed(run); claimAssignment(store, "retry", lead, NOW, dir);
    syncAssignmentHandoffs(store, NOW, [REPO], dir); syncAssignmentHandoffs(store, NOW, [REPO], dir);
    const page = assignmentUpdates(store, NOW, { principal: "coordinator", repos: [REPO] }, { after: 0, limit: 1 }, dir);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ superseded: false, rootId: "retry" });
    expect(page.hasMore).toBe(false);
    expect(assignmentUpdates(store, NOW, { principal: "coordinator", repos: ["/private"] }, { after: 0, limit: 50 }, dir)).toEqual({ events: [], nextCursor: 0, hasMore: false });
    expect(assignmentUpdates(store, NOW, access, { after: page.nextCursor, limit: 50 }, dir).events).toEqual([]);
    // A reopened store loses no claim or notification dedupe state.
    vi.restoreAllMocks(); store.close(); store = openStore(join(dir, "orders.db")); reviewed(run);
    syncAssignmentHandoffs(store, NOW, [REPO], dir);
    expect(assignmentUpdates(store, NOW, access, { after: 0, limit: 50 }, dir).events).toHaveLength(1);
    store.saveProofVerdict(run, "short", ["More evidence is needed."], NOW, [], "verified");
    syncAssignmentHandoffs(store, NOW, [REPO], dir);
    const changed = assignmentUpdates(store, NOW, access, { after: 0, limit: 50 }, dir);
    expect(changed.events).toHaveLength(2);
    expect(changed.events[0]?.superseded).toBe(true);
    expect(changed.events[1]?.assignment).toMatchObject({ state: "ready-to-check", attention: ["More evidence is needed."] });
  });
});

// Independent audit reproductions, retained with the assignment regressions.
describe("assignment handoff audit regressions", () => {
  const NOW = new Date("2026-09-20T14:00:00Z"), REPO = "/repo/assignment-audit";
  const operator = { principal: "operator" as const, repos: [REPO] };
  const coordinator = { principal: "coordinator" as const, repos: [REPO] };
  let store: Store, dir: string, owner: AssignmentOwner, approverToken: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-assignment-audit-"));
    store = openStore(join(dir, "orders.db"));
    const made = mintCoordinator(store, { name: "audit-lead", repos: [REPO], by: "operator", now: NOW });
    const person = addApprover(store, "operator", NOW);
    if (!made.ok || !person.ok) throw Error("fixture principal");
    owner = { kind: "coordinator", id: made.cid, label: "audit-lead" };
    approverToken = person.token;
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", NOW);
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  function task(id: string, sealed = false) {
    store.createTask({ id, title: "Preserve request identity" }, NOW);
    const ref = store.lookupRef(id)!;
    store.placeTask(ref.id, REPO);
    if (sealed) {
      propose(store, { taskId: id, goal: "Preserve request identity", touches: ["src/request.ts"], acceptance: [{ id: "c1", statement: "Retries preserve request identity.", how: null, evidence: ["check"] }], now: NOW });
      expect(approve(store, id, "operator", NOW, store.getScope(id)!.digest, approverToken).ok).toBe(true);
    }
    expect(claimAssignment(store, id, owner, NOW, dir).ok).toBe(true);
    return ref;
  }

  test("a decision handoff keeps the same identity for its producer and admitted lead", () => {
    task("needs-plan");
    const before = assignmentOf(store, "needs-plan", NOW, coordinator, dir)!;
    expect(before.state).toBe("needs-decision");
    const produced = assignmentOf(store, "needs-plan", NOW, operator, dir)!;
    // Action authority differs, but the underlying handoff did not change.
    expect(produced.primaryAction?.access).not.toBe(before.primaryAction?.access);
    expect(produced.handoff?.digest).toBe(before.handoff?.digest);
    syncAssignmentHandoffs(store, NOW, [REPO], dir);
    const page = assignmentUpdates(store, NOW, coordinator, { after: 0, limit: 100 }, dir);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.superseded).toBe(false);
  });

  test("bounded handoff scans eventually visit later roots across fresh cron processes", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `request-${i}`);
    for (const id of ids) task(id, true);
    const previous = new Map(ids.map(id => [id, assignmentOf(store, id, NOW, coordinator, dir)!.handoff?.digest]));
    for (const id of ids) store.setTaskState(id, "failed", NOW);
    for (const id of ids) expect(assignmentOf(store, id, NOW, coordinator, dir)!.handoff?.digest).not.toBe(previous.get(id));
    // A normal one-shot tick opens/closes its Store each time.
    for (let pass = 0; pass < 3; pass++) {
      syncAssignmentHandoffs(store, NOW, [REPO], dir);
      store.close(); store = openStore(join(dir, "orders.db"));
    }
    const tail = assignmentOf(store, ids.at(-1)!, NOW, operator, dir)!;
    const emitted = store.listNotifications("all").filter(one => one.kind === "assignment-handoff" && one.taskId === tail.rootId);
    expect(emitted.some(one => one.dedupeKey.endsWith(`:${tail.handoff!.digest}`))).toBe(true);
  });

  function readyResult() {
    const ref = task("checked-result", true);
    const route = store.routeAuthorityFor(ref.id, "builder");
    if (!route?.ok) throw Error("fixture route");
    const run = store.startRun({ taskRef: ref.id, runner: "worker", leaseId: "audit-lease", branch: "so/request", worktree: "/pool/request", route: route.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope("checked-result")!.digest });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), baseRevision: "b".repeat(40), handoff: "Retries preserve the same request identity." });
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    store.setTaskState("checked-result", "done", NOW);
    store.saveProofVerdict(run, "verified", [], NOW, [{ id: "c1", statement: "Retries preserve request identity.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: { judgement: "upholds", note: "Identity assertions cover retries." } }], "verified");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "operator" }, NOW);
    storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("One test passed"), "npm test", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, NOW);
    storeEvidence(store, dir, run, "proof", "proof.json", Buffer.from(JSON.stringify({ version: 1,
      criteria: [{ id: "c1", statement: "Retries preserve request identity.", verdict: "met", how: "Test passed.", evidence: [{ kind: "check", ref: "npm test" }] }],
      checks: [{ command: "npm test", exitCode: 0, summary: "One passed" }], changed: ["src/request.ts"], caveats: [], screenshots: [] })), "builder proof", NOW, { captureStatus: "ok" });
    const actual = store.reviewRetryStateOf.bind(store);
    vi.spyOn(store, "reviewRetryStateOf").mockImplementation(id => id === run ? { ...actual(id)!, state: "succeeded", succeeded: { runId: run + 100, requestId: 1, attempt: 1, runner: "reviewer", outcome: "no-change", reason: null, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() } } : actual(id));
    expect(assignmentOf(store, "checked-result", NOW, operator, dir)?.state).toBe("ready-to-check");
    return run;
  }

  test("a hash-valid failed evidence capture cannot be acknowledged as complete", () => {
    const run = readyResult();
    storeEvidence(store, dir, run, "screenshot", "phone.png", Buffer.from("Screenshot capture failed: browser disconnected"), "phone capture", NOW, { captureStatus: "failed" });
    const current = assignmentOf(store, "checked-result", NOW, coordinator, dir)!;
    expect(current.receipt?.artifacts.some(one => !one.complete)).toBe(true);
    const checked = checkAssignment(store, "checked-result", current.receipt!.digest, owner, NOW, dir);
    expect(checked).toMatchObject({ ok: false, reason: "evidence-unavailable" });
    expect(store.actionLedger({ repos: null }).filter(one => one.action === "assignment handoff checked")).toHaveLength(0);
  });
});
