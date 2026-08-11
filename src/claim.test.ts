import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  acquire,
  heartbeat,
  release,
  reap,
  currentClaim,
  DEFAULT_LEASE_MS,
} from "./claim.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");
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

  test("refuses a second completion on the same lease", () => {
    // A retry without an idempotency key must not read as a fresh completion.
    acquire(store, task, "runner-a", { now: T0, newLeaseId: ids("lease-a") });
    release(store, "lease-a", later(1_000));

    expect(release(store, "lease-a", later(2_000))).toEqual({ ok: false, reason: "fenced" });
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
    store.createTask({ id: "b", title: "b" }, T0);
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
    const a = store.refFor("built-in", "a").id;
    acquire(store, a, "runner-a", { now: T0, ttlMs: 60_000 });

    reap(store, later(120_000));

    expect(reap(store, later(180_000))).toEqual([]);
  });
});
