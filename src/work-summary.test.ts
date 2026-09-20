import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover, approve } from "./scope.js";
import { register } from "./runner.js";
import { authenticateCoordinator, mintCoordinator, taskDetailFor } from "./coordinator.js";
import { openWorkDecisionOf, taskWorkSummaryOf, workSummaryOf } from "./work-summary.js";
import type { WorkFacts } from "./workspace-ui.js";

const T0 = new Date("2026-09-19T12:00:00.000Z");
const NOW = new Date(T0.getTime() + 3_600_000);
const REPO = "/repo/work-summary";
const operator = { principal: "operator" as const, repos: null, includeUnplaced: true };

describe("shared task work summaries", () => {
  let store: Store;
  beforeEach(() => { store = openStore(":memory:"); });
  afterEach(() => store.close());

  function questionTask(id = "retry-policy", repo: string | null = REPO) {
    store.createTask({ id, title: "Choose a retry policy" }, T0);
    const ref = store.refFor("built-in", id).id;
    if (repo !== null) store.placeTask(ref, repo);
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "worker", branch: `task/${id}`, worktree: "/pool/private",
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
    const decision = store.saveDecision({ run, urgency: "blocking", recap: "private recap", question: "Should failed webhooks retry three times?",
      options: [{ id: "three", label: "Three retries", consequence: "Retries keep the existing idempotency key.", reversible: true }],
      recommendation: "three", deadline: new Date(T0.getTime() + 60_000).toISOString() }, T0);
    store.finishRun(run, { outcome: "parked", now: T0 });
    return { ref, run, decision, id };
  }

  function approveTask(id: string) {
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "operator", T0);
    if (!added.ok) throw new Error("approval fixture");
    store.saveScope({ taskId: id, goal: "Choose the retry policy", outOfScope: null, touches: [], acceptance: [], proposedAt: T0.toISOString(), digest: `digest-${id}`, approvedAt: null, approvedBy: null, approvedDigest: null });
    expect(approve(store, id, "operator", T0, store.getScope(id)!.digest, added.token).ok).toBe(true);
    register(store, { name: "worker", host: "test", repos: [REPO], capacity: 1, now: T0 });
  }

  test("operator and coordinator share the exact question and worker diagnosis without sharing mutation authority", () => {
    const { id, run, decision } = questionTask();
    approveTask(id);
    const human = taskWorkSummaryOf(store, id, NOW, operator)!;
    const agent = taskWorkSummaryOf(store, id, NOW, { principal: "coordinator", repos: [REPO] })!;
    expect(human).toMatchObject({ taskId: id, liveRunId: null, status: { token: "waiting-decision", action: { label: "Answer question" } },
      primaryAction: { code: "answer-decision", target: { taskId: id, runId: run, decisionId: decision }, access: "operator-control", retry: "refresh-before-acting" },
      diagnostics: [{ token: "no-worker-online", label: "Builder disconnected" }] });
    expect(agent.status).toEqual(human.status);
    expect(agent.primaryAction).toEqual({ ...human.primaryAction, access: "proposal-only" });
    expect(JSON.stringify(agent)).not.toMatch(/private recap|private|recommendation|consequence/);
    const minted = mintCoordinator(store, { name: "reader", repos: [REPO], by: "operator", now: NOW });
    if (!minted.ok) throw new Error("mint fixture");
    const auth = authenticateCoordinator(store, minted.token);
    if (!auth.ok) throw new Error("auth fixture");
    expect(taskDetailFor(store, auth.who, id, undefined, NOW)?.work).toEqual(agent);
  });

  test("each read drops answered questions; an elapsed deadline stays actionable under the existing decision policy", () => {
    const { ref, id, run, decision } = questionTask();
    approveTask(id);
    expect(openWorkDecisionOf(store, ref, NOW)).toMatchObject({ id: decision, runId: run, overdue: true });
    store.expireOverdueDecisions(NOW);
    expect(taskWorkSummaryOf(store, id, NOW, operator)?.primaryAction?.code).toBe("answer-decision");
    expect(store.answerDecision({ id: decision, choice: "three", by: "operator", via: "cli" }, NOW).ok).toBe(true);
    expect(openWorkDecisionOf(store, ref, NOW)).toBeNull();
    expect(taskWorkSummaryOf(store, id, NOW, operator)).toMatchObject({ status: { token: "no-worker-online" }, primaryAction: { code: "start-worker", target: { decisionId: null } } });
  });

  test("foreign, unplaced, absent and colliding backend tasks stay outside a scoped read", () => {
    questionTask("foreign", "/repo/private");
    questionTask("unplaced", null);
    store.raw().prepare("INSERT INTO task_ref (backend, external_id, repo) VALUES ('github-issues', 'foreign', ?)").run(REPO);
    for (const id of ["foreign", "unplaced", "absent"]) expect(taskWorkSummaryOf(store, id, NOW, { principal: "coordinator", repos: [REPO] })).toBeNull();
    expect(taskWorkSummaryOf(store, "unplaced", NOW, operator)).not.toBeNull();
    expect(taskWorkSummaryOf(store, "foreign", NOW, { principal: "operator", repos: [REPO] })).toBeNull();
  });

  test("exact result and uncertain attempt identities never become a generic retry or another task version", () => {
    const facts: WorkFacts = { id: "exact-version", title: "Retry policy", repo: REPO, updatedAt: T0.toISOString(), state: "running", liveRunId: null, unfinishedRunId: 42, publication: null, result: null,
      dispatch: { condition: "waiting", code: "vanished-run", summary: "Build vanished", detail: "Reconcile before retrying.", action: "retry-task", nextAt: null, role: "builder", blockerTaskId: null, review: null },
      openDecision: { id: 12, runId: 41, question: "Retry?", overdue: false } };
    expect(workSummaryOf(facts, "coordinator")).toMatchObject({ status: { token: "vanished-run" }, primaryAction: { code: "reconcile-run", target: { taskId: "exact-version", runId: 42 }, access: "operator-handoff", retry: "reconcile-before-retry" }, nextActions: [{ code: "reconcile-run" }, { code: "answer-decision", target: { runId: 41, decisionId: 12 } }] });
    const finished: WorkFacts = { ...facts, state: "done", dispatch: null, result: { runId: 7, role: "builder", outcome: "built", verdict: "refuted", reasons: ["the repository's approved verification command exited 1"], accepted: false } };
    expect(workSummaryOf(finished, "coordinator")).toMatchObject({ status: { token: "checks-failed" }, primaryAction: { code: "open-result", target: { taskId: "exact-version", runId: 7 }, access: "read" }, evidence: "recorded" });
    expect(workSummaryOf(finished, "coordinator").nextActions).toMatchObject([
      { code: "open-result" }, { code: "answer-decision", target: { taskId: "exact-version", runId: 41, decisionId: 12 }, access: "proposal-only" },
    ]);
    expect(workSummaryOf({ ...facts, state: "queued", openDecision: null, dispatch: { ...facts.dispatch!, code: "waiting-decision", action: "answer-decision" } }, "coordinator")).toMatchObject({ primaryAction: { code: "inspect-decisions", access: "read", target: { decisionId: null } } });
  });
});
