import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import {
  acquire,
  acquireIfReady,
  completeFenced,
  finalizeFailureFenced,
  finalizeMalformedFenced,
  finalizeParkFenced,
  type FailureClass,
  heartbeat,
  release,
  reap,
  currentClaim,
  DEFAULT_LEASE_MS,
} from "./claim.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");

/** acquireIfReady now re-proves the approved scope for builder dispatches
 * (Codex planning review, finding 2) — these tests approve by hand. */
function approveScopeFor(store: Store, taskId: string): void {
  store.saveScope({
    taskId, goal: "the work", outOfScope: null, touches: [],
    proposedAt: "2026-08-11T00:00:00.000Z", digest: `dg-${taskId}`,
    approvedAt: "2026-08-11T00:00:00.000Z", approvedBy: "alex", approvedDigest: `dg-${taskId}`,
  });
}
const later = (ms: number) => new Date(T0.getTime() + ms);

/** Lease ids are opaque; naming them makes a fencing failure readable. */
const ids = (...names: string[]) => {
  let index = 0;
  return () => names[index++] ?? `extra-${index}`;
};

describe("claim", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => {
    store.close();
  });

  test("takes a free task, at generation 1", () => {
    const result = acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true, reclaimed: false });
    if (result.ok) {
      expect(result.claim.generation).toBe(1);
      expect(result.claim.leaseId).toBe("lease-a");
      expect(result.claim.expiresAt).toBe(new Date(T0.getTime() + DEFAULT_LEASE_MS).toISOString());
    }
  });

  test("refuses a task somebody else holds, and says who", () => {
    // Losing is ordinary. What is not acceptable is a "no" that reads like a
    // bug, so the refusal carries the holder and the expiry.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    const second = acquire(store, task, "runner-b", { now: later(60_000) });

    expect(second).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });

  test("lets the next runner in once the lease has run out", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    const second = acquire(store, task, "runner-b", {
      now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(second).toMatchObject({ ok: true, reclaimed: true });
    if (second.ok) {
      expect(second.claim.generation).toBe(2);
      expect(second.claim.leaseId).toBe("lease-b");
    }
  });

  test("fences out a completion from the runner that was superseded", () => {
    // The failure this module exists for. Runner A stops being reachable, its
    // lease expires, B picks the task up — and then A wakes up and finishes.
    // Nobody detected A's crash; the refusal comes from the world having moved.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    const late = release(store, "lease-a", later(DEFAULT_LEASE_MS + 30_000));

    expect(late).toEqual({ ok: false, reason: "fenced" });
  });

  test("still accepts the completion from the runner that actually holds it", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    const accepted = release(store, "lease-b", later(DEFAULT_LEASE_MS + 30_000));

    expect(accepted.ok).toBe(true);
  });

  test("tells a superseded runner at its next heartbeat, not at the end", () => {
    // The cheapest moment to learn you have been fenced is before you have
    // spent another twenty minutes on work nobody will accept.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(heartbeat(store, "lease-a", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "fenced",
    });
  });

  test("a heartbeat keeps the task from being taken away", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    // Well past the original expiry, but it has been checking in.
    heartbeat(store, "lease-a", later(DEFAULT_LEASE_MS - 1_000));
    const stolen = acquire(store, task, "runner-b", { now: later(DEFAULT_LEASE_MS + 1) });

    expect(stolen).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });

  test("does not know a lease it never issued", () => {
    expect(heartbeat(store, "never-issued", T0)).toEqual({ ok: false, reason: "unknown" });
    expect(release(store, "never-issued", T0)).toEqual({ ok: false, reason: "unknown" });
  });

  test("tells a superseded lease apart from one that never existed", () => {
    // These are different situations and want different responses. Being
    // superseded is nobody's fault and means stop. Being unknown means you are
    // talking to the wrong database, or a lease id got mangled in transit —
    // and an earlier version of this could not distinguish them, because
    // reclaiming overwrote the row and erased the evidence.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    acquire(store, task, "runner-b", {
      now: later(DEFAULT_LEASE_MS + 1),
      newLeaseId: ids("lease-b"),
    });

    expect(release(store, "lease-a", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(release(store, "lease-typo", later(DEFAULT_LEASE_MS + 2))).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("refuses a release that raced a reclaim and lost", () => {
    // The interleaving that matters cannot be produced in one process with a
    // synchronous driver, so the state it *leaves behind* is built directly:
    // runner A holds a live, unexpired, unreleased lease, and a newer
    // generation exists anyway — exactly what A would see on waking after a
    // reclaim committed between its fence check and its write.
    //
    // With the fence outside the UPDATE this passes; it is why the fence is
    // now a predicate on the write.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    store.handle
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at)
         VALUES ('lease-b', ?, 2, 'runner-b', ?, ?, ?, NULL)`,
      )
      .run(task, T0.toISOString(), later(9e6).toISOString(), T0.toISOString());

    expect(release(store, "lease-a", later(1_000))).toEqual({ ok: false, reason: "fenced" });
    expect(heartbeat(store, "lease-a", later(1_000))).toEqual({ ok: false, reason: "fenced" });
  });

  test("a superseded lease cannot extend its own expiry", () => {
    // If it could, a fenced runner would keep the task off the ready set for
    // as long as it kept heartbeating at a task it no longer holds.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { now: later(61_000), newLeaseId: ids("lease-b") });

    heartbeat(store, "lease-a", later(62_000));

    const row = store.handle.prepare("SELECT expires_at FROM claim WHERE lease_id = 'lease-a'").get();
    expect(String(row?.["expires_at"])).toBe(new Date(T0.getTime() + 60_000).toISOString());
  });

  test("does not turn a refusal into a permanent no", () => {
    // A refusal changes nothing, so it is not a mutation to be replayed. A
    // dispatcher told "busy" and retrying the same key an hour later must not
    // be handed the hour-old no about a task that has since been free.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });

    const refused = acquire(store, task, "runner-b", {
      now: later(1_000),
      mutation: { idempotencyKey: "dispatch-9", at: T0 },
    });
    expect(refused.ok).toBe(false);

    const afterwards = acquire(store, task, "runner-b", {
      now: later(120_000),
      mutation: { idempotencyKey: "dispatch-9", at: T0 },
    });

    expect(afterwards.ok).toBe(true);
  });

  test("keeps every lease on the record, not just the current one", () => {
    // The claim log is append-only. Superseded leases are the evidence that
    // makes a fencing decision explicable after the fact.
    for (let round = 0; round < 3; round++) {
      acquire(store, task, `runner-${round}`, {
        now: later(round * (DEFAULT_LEASE_MS + 1)),
      });
    }

    const rows = store.handle
      .prepare("SELECT * FROM claim WHERE task_ref = ? ORDER BY lease_generation")
      .all(task);

    expect(rows).toHaveLength(3);
    expect(rows.map(row => Number(row["lease_generation"]))).toEqual([1, 2, 3]);
  });

  test("treats a second completion on the same lease as the same completion", () => {
    // Reported twice because the first acknowledgement was lost, not because
    // anything changed hands. M1 asks for duplicate completion to be
    // reconciled rather than refused — see the `duplicate completion` suite
    // below for the line between this and a genuine fence.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const again = release(store, "lease-a", later(2_000));

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.duplicate).toBe(true);
  });

  test("frees the task as soon as it is released, without waiting for expiry", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const second = acquire(store, task, "runner-b", { now: later(2_000) });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.claim.generation).toBe(2);
  });

  test("counts generations up and never back down", () => {
    // The fencing token is only a fence while it is monotonic. Reuse would let
    // a stale lease match a live one.
    const seen: number[] = [];
    for (let round = 0; round < 4; round++) {
      const at = later(round * (DEFAULT_LEASE_MS + 1));
      const result = acquire(store, task, `runner-${round}`, { now: at });
      if (result.ok) seen.push(result.claim.generation);
    }

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test("hands a retried acquire the same lease instead of a second one", () => {
    // A dropped acknowledgement must not cost a generation, or a runner that
    // never heard "yes" fences out the copy of itself that did.
    const first = acquire(store, task, "runner-a", {
      now: T0,
      newLeaseId: ids("lease-a", "lease-b"),
      mutation: { idempotencyKey: "dispatch-1", at: T0 },
    });
    const retry = acquire(store, task, "runner-a", {
      now: later(1_000),
      newLeaseId: ids("lease-b"),
      mutation: { idempotencyKey: "dispatch-1", at: T0 },
    });

    expect(retry).toEqual(first);
    if (retry.ok) expect(retry.claim.generation).toBe(1);
  });

  test("reports the live claim, and stops reporting it once it lapses", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    expect(currentClaim(store, task, later(1_000))?.runner).toBe("runner-a");
    expect(currentClaim(store, task, later(DEFAULT_LEASE_MS + 1))).toBeNull();
  });
});

describe("reap", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("releases what has run out and leaves what has not", () => {
    store.createTask({ id: "a", title: "a" }, T0);
    approveScopeFor(store, "a");
    store.createTask({ id: "b", title: "b" }, T0);
    approveScopeFor(store, "b");
    const a = store.refFor("built-in", "a").id;
    const b = store.refFor("built-in", "b").id;

    acquire(store, a, "runner-a", { now: T0, ttlMs: 60_000 });
    acquire(store, b, "runner-b", { now: T0, ttlMs: 600_000 });

    const reaped = reap(store, later(120_000));

    expect(reaped.map(claim => claim.runner)).toEqual(["runner-a"]);
    expect(currentClaim(store, b, later(120_000))?.runner).toBe("runner-b");
  });

  test("is quiet when there is nothing to reap", () => {
    expect(reap(store, T0)).toEqual([]);
  });

  test("does not reap the same lease twice", () => {
    store.createTask({ id: "a", title: "a" }, T0);
    approveScopeFor(store, "a");
    const a = store.refFor("built-in", "a").id;
    acquire(store, a, "runner-a", { now: T0, ttlMs: 60_000 });

    reap(store, later(120_000));

    expect(reap(store, later(180_000))).toEqual([]);
  });
});

describe("duplicate completion", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("accepts the same lease reporting done twice", () => {
    // Nobody took the task away; the runner said so twice because its first
    // acknowledgement was lost. Telling it "superseded" would send an honest
    // runner off to stop when it should carry on.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    const first = release(store, "lease-a", later(1_000));
    const again = release(store, "lease-a", later(2_000));

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.duplicate).toBe(true);
  });

  test("still fences a lease that never finished", () => {
    // The distinction that makes the above safe. A repeat of a completion is
    // idempotent; a lease that was taken away before it ever completed is
    // refused. What separates them is whether it released, not whether the
    // world moved on afterwards — see the suite below.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { now: later(61_000), newLeaseId: ids("lease-b") });

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });
});

describe("a completion that happened, retried late", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("is still a duplicate after somebody else has taken the task", () => {
    // It completed; its work was accepted at the time. Answering "fenced"
    // would tell an honest runner its work never counted, which is a
    // different and false claim. Fencing is for a lease that never finished.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    release(store, "lease-a", later(1_000));
    acquire(store, task, "runner-b", { now: later(2_000), newLeaseId: ids("lease-b") });

    const retry = release(store, "lease-a", later(3_000));

    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.duplicate).toBe(true);
  });

  test("but a lease that never finished is still fenced", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { now: later(61_000), newLeaseId: ids("lease-b") });

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });
});

describe("acquireIfReady", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("takes a task that is genuinely ready", () => {
    const result = acquireIfReady(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true, reclaimed: false });
  });

  test("refuses a task that left the queued state, and says which", () => {
    // listReady saw it queued; by claim time it is cancelled. The CAS alone
    // would admit this — the whole point of re-proving readiness inside the
    // transaction is that it does not.
    store.setTaskState("t-1", "cancelled", later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { now: later(2_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "state is cancelled, not queued" });
  });

  test("refuses a task under an active hold, with the hold's reason", () => {
    store.hold(task, "waiting on legal", null, later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { now: later(2_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "held: waiting on legal" });
  });

  test("a hold that has expired is not a hold", () => {
    store.hold(task, "overnight only", later(5_000), later(1_000));

    const result = acquireIfReady(store, task, "runner-a", { now: later(6_000), newLeaseId: ids("lease-a") });

    expect(result).toMatchObject({ ok: true });
  });

  test("refuses a task whose blocker is not done, and names the blocker", () => {
    store.createTask({ id: "t-0", title: "first" }, T0);
    approveScopeFor(store, "t-0");
    store.addEdge("t-1", "t-0");

    const result = acquireIfReady(store, task, "runner-a", { now: later(1_000) });

    expect(result).toEqual({ ok: false, reason: "not-ready", message: "waiting on t-0" });
  });

  test("still loses an ordinary race, as a race", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    const result = acquireIfReady(store, task, "runner-b", { now: later(1_000) });

    expect(result).toMatchObject({ ok: false, reason: "held", by: "runner-a" });
  });
});

describe("completeFenced", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("releases the lease and writes the terminal state together", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });

    const result = completeFenced(store, "lease-a", "done", later(1_000));

    expect(result).toMatchObject({ ok: true });
    expect(store.getTask("t-1")?.state).toBe("done");
    expect(currentClaim(store, task, later(2_000))).toBeNull();
  });

  test("a fenced lease writes nothing", () => {
    // Runner-a slept through its lease; runner-b holds the task now. Runner-a
    // waking up must not get to say how the task ended.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    acquire(store, task, "runner-b", { now: later(61_000), newLeaseId: ids("lease-b") });

    const result = completeFenced(store, "lease-a", "failed", later(62_000));

    expect(result).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a duplicate completion reports duplicate and does not change the answer", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    completeFenced(store, "lease-a", "done", later(1_000));

    const retry = completeFenced(store, "lease-a", "failed", later(2_000));

    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(store.getTask("t-1")?.state).toBe("done");
  });

  test("closes the release-then-mark window: a freed task is never unfinished", () => {
    // The race this exists for: with release and setTaskState apart, another
    // pass claims the freed task before the terminal state lands. Here the
    // task is done the same instant the lease lets go, so a later claim finds
    // it not-ready rather than dispatching a second builder.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    completeFenced(store, "lease-a", "done", later(1_000));

    const second = acquireIfReady(store, task, "runner-b", { now: later(2_000) });

    expect(second).toEqual({ ok: false, reason: "not-ready", message: "state is done, not queued" });
  });
});

describe("release provenance", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("a completion arriving after the reaper took the lease is fenced", () => {
    // The stale-commit case: the machine slept, the lease expired, the reaper
    // released it. The build finishing afterwards was never accepted, and
    // answering "duplicate" here would let its commit pass as success.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    reap(store, later(61_000));

    const late = completeFenced(store, "lease-a", "done", later(120_000));

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a completion arriving after dead-runner recovery is fenced", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    store.releaseClaimsOf("runner-a", later(1_000));

    const late = completeFenced(store, "lease-a", "done", later(2_000));

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });

  test("a release retried after the reaper took the lease is fenced, not duplicate", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    reap(store, later(61_000));

    expect(release(store, "lease-a", later(62_000))).toEqual({ ok: false, reason: "fenced" });
  });

  test("a completion retried after a genuine completion is still a duplicate", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    completeFenced(store, "lease-a", "done", later(1_000));

    const retry = completeFenced(store, "lease-a", "done", later(2_000));

    expect(retry).toMatchObject({ ok: true, duplicate: true });
  });

  test("a plain release does not let a later completion claim acceptance", () => {
    // Handing a task back and having a completion accepted are different
    // events. A runner that released and then tries to complete is reporting
    // work on a lease it already gave up.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    const late = completeFenced(store, "lease-a", "done", later(2_000));

    expect(late).toEqual({ ok: false, reason: "fenced" });
    expect(store.getTask("t-1")?.state).toBe("queued");
  });
});

describe("the capability gate in acquireIfReady", () => {
  let store: Store;
  let task: number;

  const cap = (over: Record<string, unknown> = {}) => ({
    repo: "/code/thing",
    kind: "env" as const,
    name: "SUPABASE_KEY",
    probe: 'test -n "$SUPABASE_KEY"',
    status: "unprobed" as const,
    addedBy: "alex",
    createdAt: T0.toISOString(),
    lastVerifiedAt: null,
    verifiedBy: null,
    lastResult: null,
    expiresAt: null,
    ...over,
  });

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
    store.setRequirements(task, ["env:SUPABASE_KEY"]);
  });

  afterEach(() => store.close());

  test("an unrecorded requirement fails closed, and says so", () => {
    const result = acquireIfReady(store, task, "runner-a", { now: T0, repo: "/code/thing" });

    expect(result).toEqual({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — unrecorded for /code/thing",
    });
  });

  test("a recorded but unverified requirement does not dispatch", () => {
    store.saveCapability(cap({ status: "failed" }));

    const result = acquireIfReady(store, task, "runner-a", { now: T0, repo: "/code/thing" });

    expect(result).toMatchObject({ ok: false, reason: "capability" });
  });

  test("a verified requirement lets the claim through", () => {
    store.saveCapability(cap({ status: "verified" }));

    const result = acquireIfReady(store, task, "runner-a", {
      now: T0,
      repo: "/code/thing",
      newLeaseId: ids("lease-a"),
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("a verification that expired stopped counting", () => {
    store.saveCapability(
      cap({ status: "verified", expiresAt: new Date(T0.getTime() - 1_000).toISOString() }),
    );

    const result = acquireIfReady(store, task, "runner-a", { now: T0, repo: "/code/thing" });

    expect(result).toMatchObject({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — verification expired",
    });
  });

  test("the task's own placement outranks the dispatcher's repo", () => {
    // Verified where the dispatch is running, but the task lives elsewhere,
    // and elsewhere has nothing recorded — the task's placement is the truth.
    // Placement must precede the scope row: placeTask refuses to re-aim an
    // already-scoped task.
    store.createTask({ id: "t-placed", title: "placed" }, later(1))
    const placed = store.refFor("built-in", "t-placed").id;
    store.setRequirements(placed, ["env:SUPABASE_KEY"]);
    store.saveCapability(cap({ status: "verified" }));
    store.placeTask(placed, "/code/other");
    approveScopeFor(store, "t-placed");
    const task = placed;

    const result = acquireIfReady(store, task, "runner-a", { now: T0, repo: "/code/thing" });

    expect(result).toEqual({
      ok: false,
      reason: "capability",
      message: "needs env:SUPABASE_KEY — unrecorded for /code/other",
    });
  });

  test("a task requiring nothing is untouched by all of this", () => {
    store.createTask({ id: "t-2", title: "free" }, T0);
    approveScopeFor(store, "t-2");
    const free = store.refFor("built-in", "t-2").id;

    const result = acquireIfReady(store, free, "runner-a", { now: T0, newLeaseId: ids("lease-f") });

    expect(result).toMatchObject({ ok: true });
  });
});

describe("sealing a park", () => {
  let store: Store;
  let task: number;

  const decision = {
    urgency: "blocking" as const,
    recap: "The payout guard can fail open or fail closed on timeout.",
    question: "Fail open or fail closed?",
    options: [
      { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
      { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
    ],
    recommendation: "closed",
    assignee: null,
    deadline: null,
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const openRun = (leaseId: string) =>
    store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });

  test("one transaction: decision, hold, run outcome, outbox — or none of it", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");

    const sealed = finalizeParkFenced(store, {
      leaseId: "lease-a",
      runId,
      taskId: "t-1",
      decision,
      artifactIds: [],
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true });
    if (!sealed.ok) return;

    // The decision exists, open, owned by exactly this run.
    expect(store.getDecision(sealed.decisionId)).toMatchObject({ run: runId, state: "open" });
    // Its hold keeps the task out of every ready set, indefinitely.
    const holds = store.activeHolds(task, later(9e8));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ ownerKind: "decision", ownerId: String(sealed.decisionId) });
    expect(store.listReady(later(9e8))).toHaveLength(0);
    // The run says parked, canonically.
    expect(store.getRun(runId)).toMatchObject({ outcome: "parked", reason: `decision:${sealed.decisionId}` });
    // The outbox knows, in the same transaction.
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`decision:${sealed.decisionId}`);
    // And the lease's provenance says a person owns the task now.
    expect(currentClaim(store, task, later(2_000))).toBeNull();
  });

  test("a superseded lease seals nothing — no decision, no hold, no page", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const runId = openRun("lease-a");
    // The lease expires and the task is retaken: the world moved on.
    acquire(store, task, "runner-b", { now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalizeParkFenced(store, {
      leaseId: "lease-a",
      runId,
      taskId: "t-1",
      decision,
      artifactIds: [],
      now: later(121_000),
    });

    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.listDecisions("all")).toHaveLength(0);
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
    expect(store.listNotifications("pending")).toHaveLength(0);
    // The run records the refusal it was.
    expect(store.getRun(runId)).toMatchObject({ outcome: "refused", reason: "fenced" });
    // And runner-b's live claim was never touched.
    expect(currentClaim(store, task, later(121_000))?.leaseId).toBe("lease-b");
  });

  test("a park's late release retry is fenced, never a duplicate", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");
    finalizeParkFenced(store, {
      leaseId: "lease-a", runId, taskId: "t-1", decision, artifactIds: [], now: later(1_000),
    });

    // The runner retries its release after the park already sealed. The task
    // is a person's now; nothing the runner says afterwards is theirs to say.
    expect(release(store, "lease-a", later(2_000))).toMatchObject({ ok: false, reason: "fenced" });
  });

  test("a run that names another lease cannot be sealed", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("some-other-lease");

    expect(() =>
      finalizeParkFenced(store, {
        leaseId: "lease-a", runId, taskId: "t-1", decision, artifactIds: [], now: later(1_000),
      }),
    ).toThrow(/open attempt/);
  });

  test("exhausted repair seals an incident the same fenced way", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60 * 60_000 });
    const runId = openRun("lease-a");

    const sealed = finalizeMalformedFenced(store, {
      leaseId: "lease-a",
      runId,
      taskId: "t-1",
      problems: [{ reason: "missing-recap", message: "recap is required" }],
      now: later(1_000),
    });

    expect(sealed).toMatchObject({ ok: true });
    if (!sealed.ok) return;
    expect(store.openIncidents()[0]).toMatchObject({ id: sealed.incidentId, taskId: "t-1" });
    expect(store.activeHolds(task, later(9e8))[0]).toMatchObject({
      ownerKind: "incident",
      ownerId: String(sealed.incidentId),
    });
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "malformed-decision" });
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`malformed:${runId}`);
    // Resolving the incident is what frees the task — nothing else does.
    expect(store.listReady(later(9e8))).toHaveLength(0);
    store.resolveIncident(sealed.incidentId, "alex", later(2_000));
    expect(store.listReady(later(9e8)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("a superseded lease's malformed park also seals nothing", () => {
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a"), ttlMs: 60_000 });
    const runId = openRun("lease-a");
    acquire(store, task, "runner-b", { now: later(120_000), newLeaseId: ids("lease-b") });

    const sealed = finalizeMalformedFenced(store, {
      leaseId: "lease-a",
      runId,
      taskId: "t-1",
      problems: [],
      now: later(121_000),
    });

    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.activeHolds(task, later(9e8))).toHaveLength(0);
  });
});

describe("the resume and the attention budget", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const openRun = (leaseId: string, at: Date = T0) =>
    store.startRun({
      taskRef: task,
      leaseId,
      runner: "runner-a",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: at,
    });

  const parkAndAnswer = (choice = "closed") => {
    acquire(store, task, "runner-a", {
      now: T0,
      ttlMs: 60 * 60_000,
      newLeaseId: ids("lease-park"),
    });
    const runId = openRun("lease-park");
    const sealed = finalizeParkFenced(store, {
      leaseId: currentClaim(store, task, T0)!.leaseId,
      runId,
      taskId: "t-1",
      decision: {
        urgency: "blocking",
        recap: "r",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "slips", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "pauses", reversible: true },
        ],
        recommendation: "closed",
        assignee: null,
        deadline: null,
      },
      artifactIds: [],
      now: later(1_000),
    });
    if (!sealed.ok) throw new Error("seal failed");
    store.answerDecision({ id: sealed.decisionId, choice, by: "alex", via: "cli", note: "go" }, later(2_000));
    return sealed.decisionId;
  };

  test("answers attach to the resume causally, and a built run is the terminus", () => {
    const decisionId = parkAndAnswer();

    // First resume: the answer is attached, snapshot and all.
    const resume1 = openRun("lease-resume-1", later(3_000));
    const attached = store.attachAnswers(resume1, task);
    expect(attached.map(one => one.id)).toEqual([decisionId]);
    expect(store.answersFor(resume1)).toMatchObject([{ choice: "closed", note: "go" }]);

    // The resume fails; a second resume is handed the same answer again.
    store.finishRun(resume1, { outcome: "failed", reason: "agent", now: later(4_000) });
    const resume2 = openRun("lease-resume-2", later(5_000));
    expect(store.attachAnswers(resume2, task).map(one => one.id)).toEqual([decisionId]);

    // The second resume builds: delivered. A third run gets nothing.
    store.finishRun(resume2, { outcome: "built", committed: true, now: later(6_000) });
    const later3 = openRun("lease-later", later(7_000));
    expect(store.attachAnswers(later3, task)).toEqual([]);
  });

  test("attaching twice is once — the relation is idempotent", () => {
    parkAndAnswer();
    const resume = openRun("lease-resume", later(3_000));
    store.attachAnswers(resume, task);
    store.attachAnswers(resume, task);
    expect(store.answersFor(resume)).toHaveLength(1);
  });

  test("above the budget, a measured parker steps aside; a first-timer does not", () => {
    // Five open decisions on five other tasks fill the budget.
    for (let i = 0; i < 5; i++) {
      store.createTask({ id: `other-${i}`, title: "x" }, T0);
      const ref = store.refFor("built-in", `other-${i}`).id;
      const run = store.startRun({
        taskRef: ref, leaseId: `l-${i}`, runner: "r", branch: "b", worktree: "/w", now: T0,
      });
      store.saveDecision(
        {
          run,
          urgency: "blocking",
          recap: "r",
          question: "q",
          options: [
            { id: "a", label: "a", consequence: "c", reversible: true },
            { id: "b", label: "b", consequence: "c", reversible: true },
          ],
          recommendation: "a",
        },
        T0,
      );
    }
    expect(store.countUnanswered()).toBe(5);

    // t-1 has a parking history: one parked, zero built → rate 1.
    const history = openRun("lease-history");
    store.finishRun(history, { outcome: "parked", reason: "decision:x", now: later(1_000) });
    expect(store.refForId(task)?.parkRate).toBe(1);

    const refused = acquireIfReady(store, task, "runner-a", { now: later(2_000) });
    expect(refused).toMatchObject({ ok: false, reason: "attention-budget" });

    // A task that has never parked is not punished for the backlog.
    store.createTask({ id: "fresh", title: "x" }, T0);
    approveScopeFor(store, "fresh");
    const fresh = store.refFor("built-in", "fresh").id;
    const taken = acquireIfReady(store, fresh, "runner-a", { now: later(2_000) });
    expect(taken).toMatchObject({ ok: true });

    // And under the budget, the parker dispatches again.
    const generous = acquireIfReady(store, task, "runner-a", {
      now: later(3_000),
      maxOpenDecisions: 50,
    });
    expect(generous).toMatchObject({ ok: true });
  });

  test("the park rate is measured from concluded builder attempts", () => {
    const first = openRun("lease-1");
    store.finishRun(first, { outcome: "parked", reason: "decision:1", now: later(1_000) });
    expect(store.refForId(task)?.parkRate).toBe(1);

    const second = openRun("lease-2", later(2_000));
    store.finishRun(second, { outcome: "built", committed: true, now: later(3_000) });
    expect(store.refForId(task)?.parkRate).toBe(0.5);

    // Refusals and repair children do not move it: they are not concluded builds.
    const third = openRun("lease-3", later(4_000));
    store.finishRun(third, { outcome: "refused", reason: "fenced", now: later(5_000) });
    expect(store.refForId(task)?.parkRate).toBe(0.5);
  });
});

describe("the failure taxonomy, fenced", () => {
  let store: Store;
  let task: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    approveScopeFor(store, "t-1");
    task = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  const attempt = (leaseId: string, at: Date) => {
    acquire(store, task, "runner-a", { now: at, ttlMs: 60 * 60_000, newLeaseId: () => leaseId });
    return store.startRun({
      taskRef: task, leaseId, runner: "runner-a", branch: "b", worktree: "/w", now: at,
    });
  };

  const failIt = (leaseId: string, runId: number, at: Date, failureClass: FailureClass = "unknown") =>
    finalizeFailureFenced(store, {
      leaseId, runId, taskId: "t-1", failureClass, message: "boom", worktree: "/w", now: at,
    });

  test("one failure: a strike, a doubling backoff, the task still queued", () => {
    const run = attempt("lease-1", T0);
    const sealed = failIt("lease-1", run, later(1_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "backoff", strikes: 1 });
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.getRun(run)).toMatchObject({ outcome: "failed", reason: "unknown" });
    const hold = store.activeHolds(task, later(2_000))[0];
    expect(hold).toMatchObject({ ownerKind: "backoff" });
    // One minute, then eligible again.
    expect(store.listReady(later(30_000))).toHaveLength(0);
    expect(store.listReady(later(62_000)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("the second backoff doubles", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    const second = attempt("lease-2", later(70_000));
    const sealed = failIt("lease-2", second, later(71_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "backoff", strikes: 2 });
    if (!sealed.ok || sealed.disposition !== "backoff") return;
    expect(Date.parse(sealed.until) - later(71_000).getTime()).toBe(120_000);
  });

  test("three strikes stall: incident, failed, held, paged once — and requeue undoes it all", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    const second = attempt("lease-2", later(70_000));
    failIt("lease-2", second, later(71_000));
    const third = attempt("lease-3", later(200_000));
    const sealed = failIt("lease-3", third, later(201_000));

    expect(sealed).toMatchObject({ ok: true, disposition: "stalled", strikes: 3 });
    expect(store.getTask("t-1")?.state).toBe("failed");
    expect(store.openIncidents()).toMatchObject([{ kind: "attempts-exhausted", taskId: "t-1" }]);
    expect(store.listNotifications("pending").map(n => n.dedupeKey)).toContain(`stalled:${task}`);

    const back = store.requeueTask("t-1", "alex", later(300_000));
    expect(back).toMatchObject({ ok: true, resolvedIncidents: 1 });
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.openIncidents()).toHaveLength(0);
    expect(store.listReady(later(301_000)).map(r => r.externalId)).toEqual(["t-1"]);
  });

  test("a success resets the streak", () => {
    const first = attempt("lease-1", T0);
    failIt("lease-1", first, later(1_000));
    expect(store.refForId(task)?.strikes).toBe(1);

    store.resetStrikes(task);
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.activeHolds(task, later(2_000))).toHaveLength(0);
  });

  test("a commit failure takes neither road: an incident guards the worktree, no strike", () => {
    const run = attempt("lease-1", T0);
    const sealed = failIt("lease-1", run, later(1_000), "commit-failure");

    expect(sealed).toMatchObject({ ok: true, disposition: "commit-incident" });
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.openIncidents()).toMatchObject([{ kind: "commit-failure" }]);
    const note = store.listNotifications("pending").find(n => n.dedupeKey === `commit-failure:${run}`);
    expect(note?.body).toContain("/w");
  });

  test("a superseded lease's failure seals nothing but the fenced run", () => {
    acquire(store, task, "runner-a", { now: T0, ttlMs: 60_000, newLeaseId: () => "lease-1" });
    const run = store.startRun({
      taskRef: task, leaseId: "lease-1", runner: "runner-a", branch: "b", worktree: "/w", now: T0,
    });
    acquire(store, task, "runner-b", { now: later(120_000) });

    const sealed = failIt("lease-1", run, later(121_000));
    expect(sealed).toMatchObject({ ok: false, reason: "fenced" });
    expect(store.refForId(task)?.strikes).toBe(0);
    expect(store.activeHolds(task, later(122_000))).toHaveLength(0);
    expect(store.getRun(run)).toMatchObject({ outcome: "refused", reason: "fenced" });
  });

  test("stranded work is derived, named, and freed by requeueing the blocker", () => {
    store.createTask({ id: "t-2", title: "dependent" }, T0);
    approveScopeFor(store, "t-2");
    store.addEdge("t-2", "t-1");
    store.setTaskState("t-1", "failed", later(1_000));

    expect(store.strandedTasks()).toEqual([{ id: "t-2", blockedBy: ["t-1"] }]);

    store.requeueTask("t-1", "alex", later(2_000));
    expect(store.strandedTasks()).toEqual([]);
  });
});

describe("capacity and quota, at the claim", () => {
  let store: Store;
  let a: number;
  let b: number;

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-a", title: "a" }, T0);
    approveScopeFor(store, "t-a");
    store.createTask({ id: "t-b", title: "b" }, T0);
    approveScopeFor(store, "t-b");
    a = store.refFor("built-in", "t-a").id;
    b = store.refFor("built-in", "t-b").id;
  });

  afterEach(() => store.close());

  test("a full runner is refused its second claim, and freed by releasing", () => {
    register(store, { name: "small", host: "h", now: T0, capacity: 1 });

    const first = acquireIfReady(store, a, "small", { now: T0, newLeaseId: ids("lease-a") });
    expect(first).toMatchObject({ ok: true });

    const second = acquireIfReady(store, b, "small", { now: later(1_000) });
    expect(second).toMatchObject({ ok: false, reason: "capacity" });

    release(store, "lease-a", later(2_000));
    expect(acquireIfReady(store, b, "small", { now: later(3_000) })).toMatchObject({ ok: true });
  });

  test("an unregistered runner is not capacity-gated — the CLI always registers", () => {
    expect(acquireIfReady(store, a, "ghost", { now: T0 })).toMatchObject({ ok: true });
  });

  test("an exhausted quota refuses dispatch until its reset, then admits one probe", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4 });
    store.stampQuota(
      { runner: "r", provider: "claude", reason: "credit exhausted", resetAt: later(60_000) },
      T0,
    );

    const refused = acquireIfReady(store, a, "r", { now: later(1_000) });
    expect(refused).toMatchObject({ ok: false, reason: "quota" });
    if (refused.ok === false && refused.reason === "quota") {
      expect(refused.message).toContain("credit exhausted");
    }

    // Past the reset: half-open admits exactly one dispatch as the probe…
    const probe = acquireIfReady(store, a, "r", { now: later(61_000) });
    expect(probe).toMatchObject({ ok: true });
    // …and re-arms while the probe flies, so a racing pass stays out.
    const racing = acquireIfReady(store, b, "r", { now: later(61_500) });
    expect(racing).toMatchObject({ ok: false, reason: "quota" });

    // The probe's success clears the stamp; everything flows again.
    store.clearQuota("r", "claude", "");
    expect(acquireIfReady(store, b, "r", { now: later(62_000) })).toMatchObject({ ok: true });
  });

  test("quota is scoped: another model's credential is not this one's exhaustion", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4 });
    store.stampQuota({ runner: "r", provider: "claude", scope: "opus", reason: "quota" }, T0);

    expect(acquireIfReady(store, a, "r", { now: later(1_000), model: "opus" })).toMatchObject({
      ok: false,
      reason: "quota",
    });
    expect(acquireIfReady(store, a, "r", { now: later(2_000), model: "haiku" })).toMatchObject({
      ok: true,
    });
  });

  test("no reset time means exhausted until somebody says otherwise", () => {
    register(store, { name: "r", host: "h", now: T0, capacity: 4 });
    store.stampQuota({ runner: "r", provider: "claude", reason: "auth revoked" }, T0);

    expect(acquireIfReady(store, a, "r", { now: later(9e9) })).toMatchObject({ ok: false, reason: "quota" });
    store.clearQuota("r", "claude", "");
    expect(acquireIfReady(store, a, "r", { now: later(9e9 + 1_000) })).toMatchObject({ ok: true });
  });
});
