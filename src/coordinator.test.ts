import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  mintCoordinator,
  authenticateCoordinator,
  revokeCoordinator,
  listCoordinators,
  fileCoordinatorProposal,
  PER_CID_OUTSTANDING,
} from "./coordinator.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";

const T0 = new Date("2026-08-30T12:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/repo/mcp";

describe("the coordinator credential", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => store.close());

  const mint = (over: Partial<Parameters<typeof mintCoordinator>[1]> = {}) =>
    mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0, ...over });

  test("mint validates name, rate, and repos; the token authenticates; the cid is the identity", () => {
    expect(mint({ name: "Bad Name!" })).toMatchObject({ ok: false, reason: "bad-name" });
    expect(mint({ perHour: 0 })).toMatchObject({ ok: false, reason: "bad-rate" });
    expect(mint({ perHour: 61 })).toMatchObject({ ok: false, reason: "bad-rate" });
    expect(mint({ repos: [] })).toMatchObject({ ok: false, reason: "no-repos" });

    const made = mint();
    expect(made).toMatchObject({ ok: true });
    if (!made.ok) throw new Error("unreachable");
    const auth = authenticateCoordinator(store, made.token);
    expect(auth).toMatchObject({ ok: true });
    if (auth.ok) {
      expect(auth.who.cid).toBe(made.cid);
      expect(auth.who.repos).toEqual([REPO]);
    }
    expect(authenticateCoordinator(store, "not-a-token")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("names are unique among the LIVING; revoke-and-remint mints a fresh cid — generations never conflate", () => {
    const first = mint();
    if (!first.ok) throw new Error("mint failed");
    expect(mint()).toMatchObject({ ok: false, reason: "name-taken" });

    expect(revokeCoordinator(store, first.cid, "alex", later(1_000))).toMatchObject({ ok: true });
    expect(revokeCoordinator(store, first.cid, "alex", later(2_000))).toMatchObject({ ok: false, reason: "already-revoked" });
    expect(authenticateCoordinator(store, first.token)).toMatchObject({ ok: false, reason: "revoked" });

    const second = mint();
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error("unreachable");
    expect(second.cid).not.toBe(first.cid);
    const rows = listCoordinators(store);
    expect(rows).toHaveLength(2);
    expect(rows.filter(one => one.revokedAt === null)).toHaveLength(1);
  });

  test("filing is one transaction: door + cid stamp + idempotency + event; replay charges no slot; conflict refuses", () => {
    const made = mint();
    if (!made.ok) throw new Error("mint failed");
    const input = { repo: REPO, title: "Fix flaky auth test", intent: "the test flakes", idempotencyKey: "key-0001" };

    const filed = fileCoordinatorProposal(store, made.token, input, T0);
    expect(filed).toMatchObject({ ok: true, replayed: false });
    if (!filed.ok) throw new Error("unreachable");
    const ref = store.refFor("built-in", filed.id);
    expect(ref.coordinatorCid).toBe(made.cid);
    const via = store.handle.prepare("SELECT filed_via FROM task_ref WHERE id = ?").get(ref.id);
    expect(via?.["filed_via"]).toBe("mcp:planner-bot");

    const again = fileCoordinatorProposal(store, made.token, input, later(1_000));
    expect(again).toMatchObject({ ok: true, replayed: true, id: filed.id });

    const conflicting = fileCoordinatorProposal(
      store,
      made.token,
      { ...input, title: "A DIFFERENT title" },
      later(2_000),
    );
    expect(conflicting).toMatchObject({ ok: false, reason: "idempotency-conflict" });

    // The replay charged no rate slot: with per-hour 6, five more distinct
    // filings still fit.
    for (let i = 1; i <= 5; i++) {
      expect(
        fileCoordinatorProposal(store, made.token, { repo: REPO, title: `task ${i}`, idempotencyKey: `key-000${i + 1}` }, later(3_000 + i)),
      ).toMatchObject({ ok: true });
    }
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "one too many", idempotencyKey: "key-9999" }, later(9_000)),
    ).toMatchObject({ ok: false, reason: "rate-limited" });
  });

  test("the sliding window opens a slot when the oldest filing ages out", () => {
    const made = mint({ perHour: 2 });
    if (!made.ok) throw new Error("mint failed");
    fileCoordinatorProposal(store, made.token, { repo: REPO, title: "a", idempotencyKey: "key-aaaa" }, T0);
    fileCoordinatorProposal(store, made.token, { repo: REPO, title: "b", idempotencyKey: "key-bbbb" }, later(60_000));
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "c", idempotencyKey: "key-cccc" }, later(120_000)),
    ).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "c", idempotencyKey: "key-cccc" }, later(3_600_001)),
    ).toMatchObject({ ok: true });
  });

  test("the ceiling holds at the door: a repo outside the allowlist — or none — refuses", () => {
    const made = mint();
    if (!made.ok) throw new Error("mint failed");
    expect(
      fileCoordinatorProposal(store, made.token, { repo: "/somewhere/else", title: "x", idempotencyKey: "key-else" }, T0),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
    expect(
      fileCoordinatorProposal(store, made.token, { repo: "", title: "x", idempotencyKey: "key-none" }, T0),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
  });

  test("revocation is re-checked inside the filing transaction, and outstanding caps count unsealed non-terminal filings — failed included", () => {
    const made = mint({ perHour: 60 });
    if (!made.ok) throw new Error("mint failed");

    for (let i = 0; i < PER_CID_OUTSTANDING; i++) {
      const one = fileCoordinatorProposal(
        store,
        made.token,
        { repo: REPO, title: `filing ${i}`, idempotencyKey: `key-cap-${String(i).padStart(2, "0")}` },
        later(i),
      );
      expect(one).toMatchObject({ ok: true });
      // A FAILED unsealed filing still counts (spec: dead unsealed filings
      // pressure cleanup) — fail one and the cap must not open.
      if (i === 0 && one.ok) store.setTaskState(one.id, "failed", later(500));
    }
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "over", idempotencyKey: "key-cap-over" }, later(100)),
    ).toMatchObject({ ok: false, reason: "outstanding-cap" });

    revokeCoordinator(store, made.cid, "alex", later(200));
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "post-revoke", idempotencyKey: "key-cap-rev" }, later(300)),
    ).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("the coordinator quarantine", () => {
  let store: Store;
  let cid: string;
  let token: string;
  let taskId: string;
  let taskRef: number;

  beforeEach(() => {
    store = openStore(":memory:");
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    cid = made.cid;
    token = made.token;
    const filed = fileCoordinatorProposal(store, token, { repo: REPO, title: "quarantined", idempotencyKey: "key-quar" }, T0);
    if (!filed.ok) throw new Error("filing failed");
    taskId = filed.id;
    taskRef = store.refFor("built-in", taskId).id;
    register(store, { name: "b-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-b-1" });
    // A concrete scope row to seal — the primitive tests drive
    // sealScopeApproval directly, the way claim.test's approveScopeFor does.
    store.saveScope({
      taskId, goal: "the work", outOfScope: null, touches: [],
      proposedAt: T0.toISOString(), digest: `dg-${taskId}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
  });
  afterEach(() => store.close());

  test("nothing claims a coordinator-filed task before the password seal — and everything does after", () => {
    const refused = acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" });
    expect(refused).toMatchObject({ ok: false, reason: "coordinator-filed" });

    // The password seal (basis undefined = password) admits it.
    expect(store.sealScopeApproval(taskId, "alex", later(1_000))).toBe(true);
    expect(acquire(store, taskRef, "b-1", { now: later(2_000), token: "tok-b-1" })).toMatchObject({ ok: true });
  });

  test("mode coverage cannot seal a coordinator-filed task — the primitive refuses for every caller", () => {
    expect(
      store.sealScopeApproval(taskId, "mode:standard", later(1_000), {}, { kind: "mode", modeDigest: "d1" }),
    ).toBe(false);
    // An ordinary task seals under the same basis just fine — proving the
    // refusal above is the GUARD, not a missing row.
    const ordinary = store.createConsoleTask({ title: "ordinary", repo: REPO, filedVia: "console" }, T0);
    if (!ordinary.ok) throw new Error("filing failed");
    store.saveScope({
      taskId: ordinary.id, goal: "ordinary work", outOfScope: null, touches: [],
      proposedAt: T0.toISOString(), digest: `dg-${ordinary.id}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    expect(
      store.sealScopeApproval(ordinary.id, "mode:standard", later(1_500), {}, { kind: "mode", modeDigest: "d1" }),
    ).toBe(true);
    expect(store.scopeSealed(taskId)).toBe(false);
    void cid;
  });

  test("dismissing a coordinator-filed task writes the durable event in the same transaction", () => {
    const cancelled = store.cancelTask(taskId, later(1_000), "not this week");
    expect(cancelled).toMatchObject({ ok: true });
    const events = store.handle
      .prepare("SELECT kind, task_id, detail FROM coordinator_event WHERE cid = ? ORDER BY id")
      .all(cid);
    expect(events.map(one => one["kind"])).toEqual(["filed", "dismissed"]);
    expect(events[1]?.["detail"]).toBe("not this week");
  });
});
