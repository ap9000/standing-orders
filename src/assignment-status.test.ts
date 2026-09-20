import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { mintCoordinator, revokeCoordinator } from "./coordinator.js";
import { register } from "./runner.js";
import { assignmentOf, checkAssignment, claimAssignment, syncAssignmentHandoffs, type AssignmentOwner } from "./assignment.js";
import { ASSIGNMENT_STATUS_ACTION, assignmentStatusBrief, noteAssignmentStatus, parseAssignmentStatusEvent, syncAssignmentStatuses } from "./assignment-status.js";

const NOW = new Date("2026-09-20T10:00:00Z"), REPO = "/repos/status";
describe("private observed assignment status stream", () => {
  let store: Store, dir: string, token: string, owner: AssignmentOwner;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-assignment-status-"));
    store = openStore(join(dir, "orders.db"));
    const approver = addApprover(store, "operator", NOW);
    if (!approver.ok) throw Error("approver fixture");
    token = approver.token;
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "operator", NOW);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "operator", NOW);
    register(store, { name: "worker", host: "here", repos: [REPO], capacity: 100, now: NOW, newToken: () => "worker-token" });
    const lead = mintCoordinator(store, { name: "lead", repos: [REPO], by: "operator", now: NOW });
    if (!lead.ok) throw Error("lead fixture");
    owner = { kind: "coordinator", id: lead.cid, label: "lead" };
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function task(id = "one", owned = true) {
    store.createTask({ id, title: "Keep the result available" }, NOW);
    const ref = store.lookupRef(id)!;
    store.placeTask(ref.id, REPO);
    propose(store, { taskId: id, goal: "Keep the result available", acceptance: [{ id: "c1", statement: "The exact saved result is available", how: null, evidence: ["manual-review"] }], now: NOW });
    expect(approve(store, id, "operator", NOW, store.getScope(id)!.digest, token).ok).toBe(true);
    if (owned) expect(claimAssignment(store, id, owner, NOW, dir).ok).toBe(true);
    return ref.id;
  }
  const snapshot = (id = "one") => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, dir)!;
  const events = (id = "one") => store.actionLedger({ repos: [REPO], taskId: id, limit: 100 }).filter(row => row.action === ASSIGNMENT_STATUS_ACTION).reverse();
  const payloads = (id = "one") => events(id).map(row => parseAssignmentStatusEvent(row.outcome)!);

  test("claim records Working once; reads and restarted scans do not dispatch or page people", () => {
    const ref = task();
    expect(payloads().map(one => one.assignment.state)).toEqual(["working"]);
    const notifications = store.listNotifications("all");
    for (let i = 0; i < 3; i++) {
      snapshot(); syncAssignmentHandoffs(store, new Date(NOW.getTime() + i * 1_000), [REPO], dir);
      store.close(); store = openStore(join(dir, "orders.db"));
    }
    expect(events()).toHaveLength(1);
    expect(store.runsFor(ref)).toEqual([]);
    expect(store.listNotifications("all")).toEqual(notifications);
  });

  test("A → B → A creates distinct ordered events even under the same clock", () => {
    task();
    store.setTaskState("one", "cancelled", NOW); syncAssignmentStatuses(store, NOW, [REPO], dir);
    store.setTaskState("one", "queued", NOW); syncAssignmentStatuses(store, NOW, [REPO], dir);
    const seen = payloads();
    expect(seen.map(one => one.assignment.state)).toEqual(["working", "cancelled", "working"]);
    expect(seen[0]!.stateDigest).toBe(seen[2]!.stateDigest);
    expect(new Set(seen.map(one => one.digest)).size).toBe(3);
    expect(events().map(one => one.id)).toEqual(events().map(one => one.id).sort((a, b) => a - b));
  });

  test("exact result acknowledgment records Complete immediately without changing checks or starting work", () => {
    const ref = task();
    const route = store.routeAuthorityFor(ref, "builder");
    if (!route?.ok) throw Error("route fixture");
    const run = store.startRun({ taskRef: ref, runner: "worker", leaseId: "sample", branch: "so/one", worktree: "/pool/one", route: route.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope("one")!.digest });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Saved the requested result." });
    store.finishRun(run, { outcome: "built", committed: true, now: NOW }); store.setTaskState("one", "done", NOW);
    syncAssignmentStatuses(store, NOW, [REPO], dir);
    const ready = snapshot();
    expect(ready.state).toBe("ready-to-check");
    expect(checkAssignment(store, "one", ready.receipt!.digest, owner, NOW, dir).ok).toBe(true);
    expect(payloads().map(one => one.assignment.state)).toEqual(["working", "ready-to-check", "complete"]);
    const complete = payloads().at(-1)!;
    expect(complete.assignment.completion).toEqual({ actor: `coordinator:${owner.id}`, digest: ready.receipt!.digest });
    expect(complete.assignment.result?.checks.status).toBe("not-run");
    expect(checkAssignment(store, "one", ready.receipt!.digest, owner, NOW, dir).ok).toBe(true);
    expect(events()).toHaveLength(3);
    expect(store.runsFor(ref)).toHaveLength(1);
    expect(store.proofAcceptance(run)).toBeNull();
  });

  test("owner changes create a fresh event; revoked or stale snapshots cannot append", () => {
    task(); const stale = snapshot();
    revokeCoordinator(store, owner.id, "operator", NOW);
    expect(noteAssignmentStatus(store, stale, NOW)).toBeNull();
    const lead = mintCoordinator(store, { name: "next-lead", repos: [REPO], by: "operator", now: NOW });
    if (!lead.ok) throw Error("second owner");
    const next = { kind: "coordinator" as const, id: lead.cid, label: "new lead" };
    expect(claimAssignment(store, "one", next, NOW, dir).ok).toBe(true);
    expect(payloads().map(one => one.assignment.owner?.id)).toEqual([owner.id, next.id]);
    expect(noteAssignmentStatus(store, stale, NOW)).toBeNull();
    expect(events()).toHaveLength(2);
  });

  test("bounded fifty-root scans reach later roots across restarts and cycle back", () => {
    for (let i = 0; i < 51; i++) task(`item-${i}`);
    for (let i = 0; i < 51; i++) store.setTaskState(`item-${i}`, "cancelled", NOW);
    syncAssignmentStatuses(store, NOW, [REPO], dir);
    expect(payloads("item-49").at(-1)?.assignment.state).toBe("cancelled");
    expect(payloads("item-50").at(-1)?.assignment.state).toBe("working");
    store.close(); store = openStore(join(dir, "orders.db"));
    syncAssignmentStatuses(store, NOW, [REPO], dir);
    expect(payloads("item-50").at(-1)?.assignment.state).toBe("cancelled");
    store.setTaskState("item-0", "queued", NOW); syncAssignmentStatuses(store, NOW, [REPO], dir);
    expect(payloads("item-0").at(-1)?.assignment.state).toBe("working");
  });

  test("unclaimed and out-of-scope assignments produce no private lead events", () => {
    task("unclaimed", false); task();
    store.setTaskState("one", "cancelled", NOW);
    syncAssignmentStatuses(store, NOW, ["/other"], dir);
    expect(events("unclaimed")).toEqual([]);
    expect(payloads().at(-1)?.assignment.state).toBe("working");
  });

  test("stored brief is bounded, excludes saved context and polling times, and malformed rows refuse parsing", () => {
    task(); const current = snapshot();
    const brief = assignmentStatusBrief({ ...current, detail: "x".repeat(20_000), attention: Array(50).fill("y".repeat(2_000)),
      savedContext: { goal: "Private full goal", outOfScope: null, excerpts: [] } });
    expect(brief.detail.length).toBeLessThanOrEqual(1_000);
    expect(brief.attention).toHaveLength(8);
    expect(brief.attention.every(one => one.length <= 500)).toBe(true);
    expect(JSON.stringify(brief)).not.toContain("Private full goal");
    const redacted = assignmentStatusBrief({ ...current, detail: `A token: 123456789:${"a".repeat(30)}` });
    expect(redacted.detail).toBe("[sensitive text hidden]");
    expect(redacted.primaryAction).not.toHaveProperty("access");
    const raw = events()[0]!.outcome;
    expect(parseAssignmentStatusEvent(raw)).not.toBeNull();
    expect(parseAssignmentStatusEvent("{")).toBeNull();
    expect(parseAssignmentStatusEvent("x".repeat(32_769))).toBeNull();
    const corrupt = JSON.parse(raw); corrupt.assignment.state = "complete";
    expect(parseAssignmentStatusEvent(JSON.stringify(corrupt))).toBeNull();
    corrupt.assignment.attention = "not an array";
    expect(parseAssignmentStatusEvent(JSON.stringify(corrupt))).toBeNull();
  });
});
