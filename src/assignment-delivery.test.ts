import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openStore, type Store } from "./store.js";
import { mintCoordinator, revokeCoordinator } from "./coordinator.js";
import { assignmentOf, type AssignmentOwner } from "./assignment.js";
import { ASSIGNMENT_STATUS_ACTION, noteAssignmentStatus } from "./assignment-status.js";
import { assignmentInbox, acknowledgeAssignmentDelivery, type AssignmentDeliveryBatch } from "./assignment-delivery.js";

const NOW = new Date("2026-09-20T22:00:00Z"), REPO = "/repos/inbox";
describe("durable assignment delivery", () => {
  let store: Store, dir: string, db: string, owner: AssignmentOwner;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-assignment-delivery-")); db = join(dir, "orders.db"); store = openStore(db);
    owner = coordinator("lead", [REPO]);
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  function coordinator(name: string, repos: string[]) {
    const result = mintCoordinator(store, { name, repos, by: "operator", now: NOW });
    if (!result.ok) throw Error("credential fixture");
    return { kind: "coordinator" as const, id: result.cid, label: name };
  }
  function event(task = "first", detail = "Plan ready", who = owner, repo = REPO) {
    if (!store.lookupRef(task)) {
      store.createTask({ id: task, title: "Save assignment status" }, NOW);
      store.placeTask(store.lookupRef(task)!.id, repo);
      store.handle.prepare("UPDATE task_ref SET coordinator_cid = ? WHERE id = ?").run(who.id, store.lookupRef(task)!.id);
    }
    const snapshot = assignmentOf(store, task, NOW, { principal: "coordinator", repos: [repo] })!;
    noteAssignmentStatus(store, { ...snapshot, detail }, NOW);
    return Number(store.handle.prepare("SELECT MAX(id) AS id FROM action_ledger WHERE action = ?").get(ASSIGNMENT_STATUS_ACTION)!["id"]);
  }
  function inbox(consumer = "worker", limit = 10, who = owner, connection = store): AssignmentDeliveryBatch {
    const result = assignmentInbox(connection, who, { consumer, limit }, NOW);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw Error(result.message);
    return result.batch;
  }
  const ack = (batch: AssignmentDeliveryBatch, who = owner, connection = store) => acknowledgeAssignmentDelivery(connection, who, { consumer: batch.consumer, batchId: batch.id! }, NOW);
  const cursors = () => store.handle.prepare("SELECT * FROM service_cursor WHERE key LIKE 'assignment-inbox:%' ORDER BY key").all();

  test("a fresh process replays the exact unacknowledged batch without advancing its cursor", () => {
    event(); const batch = inbox();
    store.close();
    const script = `import { openStore } from ${JSON.stringify(pathToFileURL(resolve("src/store.ts")).href)};
      import { assignmentInbox } from ${JSON.stringify(pathToFileURL(resolve("src/assignment-delivery.ts")).href)};
      const s = openStore(process.argv[1]);
      try { console.log(JSON.stringify(assignmentInbox(s,JSON.parse(process.argv[2]),{consumer:'worker',limit:1},new Date(${JSON.stringify(NOW.toISOString())})))); } finally { s.close(); }`;
    let output: string;
    try { output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, db, JSON.stringify(owner)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    finally { store = openStore(db); }
    expect(JSON.parse(output!)).toEqual({ ok: true, batch, replayed: true });
    expect(ack(batch)).toMatchObject({ ok: true, alreadyAcknowledged: false, cursor: batch.nextCursor });
    expect(inbox().events).toEqual([]);
  });

  test("appending between read and ACK waits behind the immutable page", () => {
    const first = event(), page = inbox("worker", 1);
    const second = event("first", "Working");
    expect(inbox("worker", 100)).toEqual(page);
    expect(ack(page)).toMatchObject({ ok: true, cursor: first });
    const next = inbox();
    expect(next.events.map(one => one.id)).toEqual([second]);
    expect(next.after).toBe(first);
    const before = cursors();
    expect(ack(page)).toMatchObject({ ok: true, alreadyAcknowledged: true, cursor: first });
    expect(cursors()).toEqual(before);
    expect(inbox()).toEqual(next);
  });

  test("two connections share one pending consumer while independent consumers keep their own ACKs", () => {
    event(); const a = inbox("alpha");
    const other = openStore(db);
    try {
      expect(inbox("alpha", 1, owner, other)).toEqual(a);
      const b = inbox("beta", 50, owner, other);
      expect(b.events).toEqual(a.events); expect(b.id).not.toBe(a.id);
      expect(ack(a, owner, other)).toMatchObject({ ok: true, alreadyAcknowledged: false });
      expect(ack(a)).toMatchObject({ ok: true, alreadyAcknowledged: true });
      expect(inbox("alpha").events).toEqual([]);
      expect(inbox("beta")).toEqual(b);
    } finally { other.close(); }
  });

  test("unknown batch, wrong consumer and wrong owner cannot skip unseen pages", () => {
    event(); event("second"); const page = inbox("worker", 1), other = coordinator("other", [REPO]);
    const before = cursors();
    expect(ack({ ...page, id: "0".repeat(32) })).toMatchObject({ ok: false, reason: "stale-batch" });
    expect(ack({ ...page, consumer: "different" })).toMatchObject({ ok: false, reason: "stale-batch" });
    expect(ack(page, other)).toMatchObject({ ok: false, reason: "stale-batch" });
    expect(cursors()).toEqual(before); expect(inbox("worker")).toEqual(page);
  });

  test("events are isolated by admitted project and current assignment owner", () => {
    const other = coordinator("other", [REPO]), foreign = coordinator("foreign", ["/repos/private"]);
    const own = event(); event("other", "Working", other); event("private", "Private status", foreign, "/repos/private");
    expect(inbox().events.map(one => one.id)).toEqual([own]);
    expect(inbox("worker", 50, other).events.map(one => "rootId" in one ? one.rootId : null)).toEqual(["other"]);
    expect(inbox("worker", 50, foreign).events.map(one => "rootId" in one ? one.rootId : null)).toEqual(["private"]);
  });

  test("revocation refuses both replay and ACK without consuming the page", () => {
    event(); const page = inbox(), before = cursors();
    revokeCoordinator(store, owner.id, "operator", NOW);
    expect(assignmentInbox(store, owner, { consumer: "worker" }, NOW)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(ack(page)).toMatchObject({ ok: false, reason: "unavailable" }); expect(cursors()).toEqual(before);
  });

  test("access loss redacts only affected messages and ACK cannot wedge remaining admitted work", () => {
    event(); event("second"); const page = inbox();
    const other = coordinator("replacement", [REPO]);
    store.recordAction({ at: NOW.toISOString(), actor: `coordinator:${other.id}`, repo: REPO, taskId: "first", runId: null, action: "assignment claimed", outcome: "claimed", source: "work" });
    expect(inbox()).toEqual({ ...page, events: [{ id: page.events[0]!.id, unavailable: true }, page.events[1]] });
    expect(ack(page)).toMatchObject({ ok: true, cursor: page.nextCursor });
    event("second", "Working"); const next = inbox();
    store.handle.prepare("UPDATE coordinator_credential SET repos = ? WHERE cid = ?").run(JSON.stringify(["/different"]), owner.id);
    expect(inbox()).toEqual({ ...next, events: next.events.map(one => ({ id: one.id, unavailable: true })) });
    expect(ack(next)).toMatchObject({ ok: true, cursor: next.nextCursor });
    expect(inbox().events).toEqual([]);
  });

  test("pagination delivers every event once, and old ACKs cannot consume a newer pending page", () => {
    const ids = Array.from({ length: 8 }, (_, n) => event("first", `Progress ${n}`));
    const pages: AssignmentDeliveryBatch[] = [];
    do { const page = inbox("worker", 3); pages.push(page); expect(ack(page).ok).toBe(true); } while (pages.at(-1)!.hasMore);
    expect(pages.map(page => page.events.length)).toEqual([3, 3, 2]);
    expect(pages.flatMap(page => page.events.map(one => one.id))).toEqual(ids);
    event("first", "Ready"); const pending = inbox(), before = cursors();
    expect(ack(pages[0]!)).toMatchObject({ ok: true, alreadyAcknowledged: true, cursor: ids.at(-1) });
    expect(cursors()).toEqual(before); expect(inbox()).toEqual(pending);
  });

  test("delivery ACK does not complete work, accept proof or mutate human notification delivery", () => {
    event(); store.enqueueNotification({ dedupeKey: "human", kind: "assignment-handoff", subject: "Ready", body: "For the human", source: { taskRef: store.lookupRef("first")!.id } }, NOW);
    const before = { task: store.getTask("first"), scope: store.getScope("first"), notifications: store.listNotifications("all"), assignment: assignmentOf(store, "first", NOW, { principal: "coordinator", repos: [REPO] }) };
    const page = inbox(); expect(ack(page).ok).toBe(true);
    expect({ task: store.getTask("first"), scope: store.getScope("first"), notifications: store.listNotifications("all"), assignment: assignmentOf(store, "first", NOW, { principal: "coordinator", repos: [REPO] }) }).toEqual(before);
    expect(store.actionLedger({ repos: null }).filter(one => one.action === "assignment handoff checked")).toEqual([]);
  });

  test("malformed inputs and empty polling create no delivery state", () => {
    const before = cursors();
    for (const limit of [0, 101, 1.5, NaN]) expect(assignmentInbox(store, owner, { consumer: "worker", limit }, NOW)).toMatchObject({ ok: false, reason: "invalid-input" });
    for (const consumer of ["", "../worker", "Uppercase", "under_score", "x".repeat(65)]) expect(assignmentInbox(store, owner, { consumer }, NOW)).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(acknowledgeAssignmentDelivery(store, owner, { consumer: "worker", batchId: "arbitrary" }, NOW)).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(inbox()).toMatchObject({ id: null, after: 0, nextCursor: 0, hasMore: false, events: [] }); expect(cursors()).toEqual(before);
  });

  test("an invalid next event is reported without skipping to later events", () => {
    event(); const page = inbox(); expect(ack(page).ok).toBe(true);
    store.recordAction({ at: NOW.toISOString(), actor: `coordinator:${owner.id}`, repo: REPO, taskId: "first", runId: null, action: ASSIGNMENT_STATUS_ACTION, outcome: "not-json", source: "work" });
    const before = cursors();
    expect(assignmentInbox(store, owner, { consumer: "worker" }, NOW)).toMatchObject({ ok: false, reason: "unavailable" }); expect(cursors()).toEqual(before);
  });

  test("corrupt pending JSON or content refuses read and ACK without moving the cursor", () => {
    event(); const batch = inbox();
    const pending = store.handle.prepare("SELECT key,value FROM service_cursor WHERE key LIKE 'assignment-inbox:%:pending'").get()!;
    const entry = store.handle.prepare("SELECT actor,action FROM action_ledger WHERE id=?").get(pending["value"]!)!;
    for (const outcome of ["not-json", JSON.stringify({ ...batch, nextCursor: 0 }), JSON.stringify({ ...batch, events: [{ ...batch.events[0], digest: "0".repeat(64) }] })]) {
      const id = store.recordAction({ at: NOW.toISOString(), actor: String(entry["actor"]), repo: null, taskId: null, runId: null, action: String(entry["action"]), outcome, source: "work" });
      store.setServiceCursor(String(pending["key"]), id, NOW);
      const before = cursors();
      expect(assignmentInbox(store, owner, { consumer: "worker" }, NOW)).toMatchObject({ ok: false, reason: "unavailable" });
      expect(ack(batch)).toMatchObject({ ok: false, reason: "unavailable" }); expect(cursors()).toEqual(before);
    }
  });

  test("default pages stay small and the byte limit paginates without dropping long messages", () => {
    for (let n = 0; n < 16; n++) {
      event("first", `Progress ${n}`);
      const snapshot = assignmentOf(store, "first", NOW, { principal: "coordinator", repos: [REPO] })!;
      noteAssignmentStatus(store, { ...snapshot, detail: `${n} ${"x".repeat(995)}`, attention: Array(8).fill("long detail ".repeat(45)) }, NOW);
    }
    expect(assignmentInbox(store, owner, { consumer: "default" }, NOW)).toMatchObject({ ok: true, batch: { hasMore: true, events: expect.any(Array) } });
    expect(inbox("default").events).toHaveLength(10);
    const expected = store.handle.prepare("SELECT id FROM action_ledger WHERE action=? ORDER BY id").all(ASSIGNMENT_STATUS_ACTION).map(row => Number(row["id"]));
    const received: number[] = [];
    let page: AssignmentDeliveryBatch;
    do {
      page = inbox("long", 100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
      received.push(...page.events.map(one => one.id)); expect(ack(page).ok).toBe(true);
    } while (page.hasMore);
    expect(received).toEqual(expected);
  });

  test("a failed ACK rolls back both cursor and acknowledgment before another process retries", () => {
    event(); const page = inbox(), before = cursors();
    const write = store.setServiceCursor.bind(store);
    vi.spyOn(store, "setServiceCursor").mockImplementationOnce(write).mockImplementationOnce(() => { throw Error("write failed"); });
    store.transact(() => { expect(() => ack(page)).toThrow("write failed"); });
    expect(cursors()).toEqual(before); expect(inbox()).toEqual(page);
    expect(store.actionLedger({ repos: null }).filter(one => one.action.startsWith("assignment delivery acknowledged:"))).toEqual([]);
    const other = openStore(db);
    try { expect(ack(page, owner, other)).toMatchObject({ ok: true, alreadyAcknowledged: false }); }
    finally { other.close(); }
  });

  test("a failed staging write rolls back its ledger row even when an outer transaction catches it", () => {
    event(); const before = store.actionLedger({ repos: null }).length;
    vi.spyOn(store, "setServiceCursor").mockImplementationOnce(() => { throw Error("write failed"); });
    store.transact(() => { expect(() => assignmentInbox(store, owner, { consumer: "worker" }, NOW)).toThrow("write failed"); });
    expect(store.actionLedger({ repos: null })).toHaveLength(before); expect(cursors()).toEqual([]);
    expect(inbox().events).toHaveLength(1);
  });
});
