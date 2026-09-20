import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentCatchUp } from "./assignment-brief.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";

const NOW = new Date("2026-09-20T19:00:00Z");
const REPO = "/repo/catch-up", FOREIGN = "/repo/private";
const access = { principal: "coordinator" as const, repos: [REPO] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe("database assignment catch-up", () => {
  let store: Store, directory: string, database: string, token: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "so-catch-up-")); database = join(directory, "orders.db"); store = openStore(database);
    const bootstrap = new Date(NOW.getTime() - 20 * 24 * 60 * 60_000);
    const operator = addApprover(store, "operator", bootstrap); if (!operator.ok) throw Error("fixture"); token = operator.token;
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", bootstrap);
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  function task(id: string, repo = REPO, at = NOW) {
    store.createTask({ id, title: `Work ${id}` }, at); store.placeTask(store.lookupRef(id)!.id, repo);
    propose(store, { taskId: id, goal: `Deliver ${id} safely`, acceptance: [], now: at });
    expect(approve(store, id, "operator", at, store.getScope(id)!.digest, token).ok).toBe(true);
  }
  function finished(id: string, options: { repo?: string; question?: boolean; at?: Date } = {}) {
    const at = options.at ?? NOW; if (!store.getTask(id)) task(id, options.repo, at);
    const ref = store.lookupRef(id)!, route = store.routeAuthorityFor(ref.id, "builder"); if (!route?.ok) throw Error("fixture route");
    const run = store.startRun({ taskRef: ref.id, runner: "builder", leaseId: `lease-${id}`, branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now: at });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: `Saved outcome for ${id}` });
    if (options.question) store.saveDecision({ run, urgency: "blocking", recap: "Choose the request policy.", question: "Should retries keep the original key?", options: [{ id: "keep", label: "Keep", consequence: "Stable identity", reversible: true }], recommendation: "keep", deadline: new Date(at.getTime() - 1).toISOString() }, at);
    store.finishRun(run, { outcome: "built", committed: true, now: at }); store.setTaskState(id, "done", at);
    return run;
  }
  function complete(id: string, at = NOW) {
    const who = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [REPO]); if (!who.ok) throw Error("principal");
    const value = assignmentOf(store, id, at, access, directory)!;
    expect(checkAssignmentAsOperator(store, id, value.receipt!.digest, who.who, at, directory)).toMatchObject({ ok: true });
  }
  function knowledge(repo = REPO, revision = 1, instructions = "Keep request keys stable.", references: unknown[] = []) {
    const identity = "b".repeat(64), payload = JSON.stringify({ instructions, references }), sha = hash(payload);
    store.handle.prepare('INSERT INTO knowledge_change(repo,identity,revision,actor,at,payload,sha) VALUES (?,?,?,?,?,?,?)').run(repo, identity, revision, "operator", NOW.toISOString(), payload, sha);
    store.handle.prepare('INSERT INTO project_knowledge VALUES (?,?,?,?,?) ON CONFLICT(repo) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,sha=excluded.sha').run(repo, identity, revision, payload, sha);
  }
  const read = (limit = 10) => assignmentCatchUp(store, NOW, access, { limit }, directory);

  test("restart preserves goals, outcomes, decisions and recent completion without writes", () => {
    finished("ready"); finished("question", { question: true }); finished("complete"); complete("complete");
    knowledge(REPO, 1, "Keep labels short.", [{ id: "source-1", title: "Request policy", content: "Full reference is read separately.", path: "docs/requests.md", sourceRevision: "c".repeat(40), sourceSha: "d".repeat(40) }]);
    store.handle.exec('PRAGMA query_only=ON');
    const before = read();
    expect(before.assignments.map(one => one.state)).toEqual(["needs-decision", "ready-to-check", "complete"]);
    expect(before.assignments[0]).toMatchObject({ goal: "Deliver question safely", outcome: "Saved outcome for question", decisions: [{ state: "open", overdue: true, question: "Should retries keep the original key?" }] });
    expect(before.assignments[0]?.nextAction).toEqual(assignmentOf(store, "question", NOW, access, directory)?.primaryAction);
    expect(before.assignments[0]?.nextAction?.access).not.toBe("operator-control");
    expect(before.projects[0]?.knowledge).toMatchObject({ status: "stored", revision: 1, instructions: "Keep labels short.", sources: [{ id: "source-1", sourceRevision: "c".repeat(40) }] });
    expect(JSON.stringify(before)).not.toContain("Full reference is read separately.");
    expect(JSON.stringify(before)).not.toContain("receipt");
    store.close(); store = openStore(database); store.handle.exec('PRAGMA query_only=ON');
    expect(read()).toEqual(before);
  });

  test("project admission precedes assignment and knowledge hydration", () => {
    finished("mine"); finished("private-sentinel", { repo: FOREIGN }); knowledge(REPO); knowledge(FOREIGN, 1, "PRIVATE KNOWLEDGE SENTINEL");
    const family = vi.spyOn(store, "taskFamilyOf");
    const result = read();
    expect(result.assignments.map(one => one.taskId)).toEqual(["mine"]);
    expect(result.projects.map(one => one.repo)).toEqual([REPO]);
    expect(JSON.stringify(result)).not.toMatch(/private-sentinel|PRIVATE KNOWLEDGE/);
    expect(family.mock.calls.every(call => call[0] !== "private-sentinel")).toBe(true);
    const hidden = assignmentCatchUp(store, NOW, access, { repo: FOREIGN }, directory);
    const absent = assignmentCatchUp(store, NOW, access, { repo: "/repo/absent" }, directory);
    expect(hidden).toEqual(absent); expect(hidden.assignments).toEqual([]); expect(hidden.projects).toEqual([]);
    expect(assignmentCatchUp(store, NOW, { principal: "operator", repos: [] }, {}, directory).projects).toEqual([]);
  });

  test("reads latest answer, outcome and knowledge; a stale payload is never replayed", () => {
    const run = finished("request", { question: true }); knowledge();
    const first = read(); const decision = store.decisionForRun(run)!;
    expect(store.answerDecision({ id: decision.id, choice: "keep", by: "operator", via: "cli" }, NOW).ok).toBe(true);
    store.recordOutcomeFacts(run, { handoff: "The saved result now retains the key." }); knowledge(REPO, 2, "Use the recorded request key.");
    const current = read();
    expect(first.assignments[0]?.state).toBe("needs-decision");
    expect(current.assignments[0]).toMatchObject({ state: "ready-to-check", outcome: "The saved result now retains the key.", decisions: [{ state: "answered", choice: "keep", overdue: false }] });
    expect(current.projects[0]?.knowledge).toMatchObject({ revision: 2, instructions: "Use the recorded request key." });
    store.handle.prepare('UPDATE project_knowledge SET payload=? WHERE repo=?').run('{}', REPO);
    expect(read().projects[0]?.knowledge).toMatchObject({ status: "unavailable", instructions: "", sources: [] });
  });

  test("bounded candidates and output disclose omissions and redact sensitive saved text", () => {
    for (let i = 0; i < 9; i++) task(`item-${i}`);
    knowledge(REPO, 1, "sk-ant-api03-" + "A".repeat(60));
    const result = read(1);
    expect(result.assignments).toHaveLength(1);
    expect(result.omissions).toMatchObject({ candidateScanLimited: true, assignments: 2 });
    expect(result.projects[0]?.knowledge.instructions).toBe("[sensitive text hidden]");
    expect(result.omissions.textFields).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("A".repeat(60));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_000);
    expect(result.omissions.notes.join(" ")).toContain("lower bounds");
  });

  test("byte and decision limits retain exact targets and disclose omitted content", () => {
    for (let i = 0; i < 20; i++) {
      for (let n = 0; n < 4; n++) {
        const run = finished(`long-${i}`, { question: true });
        store.recordOutcomeFacts(run, { handoff: "Retained outcome ".repeat(80) });
        if (n < 3) expect(store.answerDecision({ id: store.decisionForRun(run)!.id, choice: "keep", by: "operator", via: "cli" }, NOW).ok).toBe(true);
      }
    }
    const result = read(25);
    expect(result.assignments.length).toBeGreaterThan(0);
    expect(result.omissions.assignments).toBeGreaterThan(0);
    expect(result.omissions.decisions).toBe(result.assignments.length);
    expect(result.omissions.textFields).toBeGreaterThan(0);
    expect(result.assignments.every(one => one.decisions.length === 3 && one.decisions[0]?.runId === one.runId)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_000);
  });

  test("old completion is omitted, but handling an old result today is recent", () => {
    const old = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000);
    finished("old", { at: old }); complete("old", old);
    finished("handled-today", { at: old }); complete("handled-today");
    expect(read().assignments.map(one => one.taskId)).toEqual(["handled-today"]);
  });

  test("a new active attempt stays distinct from the saved outcome of its earlier result", () => {
    const resultRunId = finished("continuing");
    store.setTaskState("continuing", "queued", NOW);
    const ref = store.lookupRef("continuing")!, route = store.routeAuthorityFor(ref.id, "builder"); if (!route?.ok) throw Error("route");
    const live = store.startRun({ taskRef: ref.id, runner: "builder", leaseId: "live-attempt", branch: "so/continuing", worktree: "/pool/continuing", route: route.stamp, now: NOW });
    store.setTaskState("continuing", "running", NOW);
    expect(read().assignments[0]).toMatchObject({ taskId: "continuing", runId: live, resultRunId, outcome: "Saved outcome for continuing" });
  });

  test("without evidence root the brief labels checks uninspected and returns no saved artifact bytes", () => {
    finished("ready");
    const result = assignmentCatchUp(store, NOW, access, {});
    expect(result.assignments[0]?.checks).toMatchObject({ status: "not-read", exitCode: null });
    expect(result.omissions.notes.join(" ")).toContain("availability was not read");
    expect(result.assignments[0]).not.toHaveProperty("savedContext");
  });
});
