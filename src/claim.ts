/**
 * The claim, and the fence around it.
 *
 * This is the record §4 calls the one that matters, and the reason is a
 * specific 3am failure. A runner takes a task, starts work, and then stops
 * being reachable — the machine sleeps, the process is OOM-killed, the network
 * partitions. The scheduler cannot tell "dead" from "slow", so it waits for the
 * lease to expire and gives the task to someone else. Then the first runner
 * wakes up, finishes the work it was doing, and reports success for a task that
 * another runner is now halfway through.
 *
 * Both runners are behaving correctly. Without a fence, the control plane
 * believes the last one to speak.
 *
 * So a lease carries two things. `lease_id` is immutable and identifies one
 * grant of one task to one runner. `lease_generation` counts how many times
 * that task has been granted at all, and it only ever goes up. Acquiring is a
 * compare-and-swap on the generation; every later call carries the lease it
 * thinks it holds, and anything whose generation has been superseded is
 * refused. The late completion above is refused not because we detected the
 * crash — we never did — but because the world moved on without it.
 *
 * Losing a race here is ordinary, not an error. Several runners asking for the
 * same task at the same moment is the system working; exactly one wins.
 *
 * Time is a parameter everywhere. Expiry decided by an implicit clock is
 * untestable, and a lease is exactly the kind of thing that has to be provable
 * rather than probable.
 */

import { randomUUID } from "node:crypto";
import type { Store, Mutation } from "./store.js";

export type Claim = {
  taskRef: number;
  /** Immutable. Identifies this grant, and no other. */
  leaseId: string;
  /** Monotonic per task. The fencing token. */
  generation: number;
  runner: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
};

export type AcquireResult =
  | { ok: true; claim: Claim; reclaimed: boolean }
  | { ok: false; reason: "held"; by: string; until: string };

/** `fenced` means the lease was superseded; `unknown` means it never existed. */
export type FenceResult =
  | { ok: true; claim: Claim; duplicate?: boolean }
  | { ok: false; reason: "fenced" | "unknown" };

export type AcquireOptions = {
  now: Date;
  ttlMs?: number;
  /** Injected in tests so a lease id can be asserted on. */
  newLeaseId?: () => string;
  mutation?: Mutation;
};

/**
 * Long enough that an ordinary build does not lose its lease mid-thought,
 * short enough that a dead runner's work is picked up the same night rather
 * than at breakfast.
 */
export const DEFAULT_LEASE_MS = 15 * 60_000;

/**
 * Take the task, if it is free.
 *
 * Free means no claim, or a claim whose lease expired, or one already released.
 * A live lease belonging to somebody else is refused with who holds it and
 * until when, because "no" without a reason is indistinguishable from a bug.
 */
export function acquire(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions,
): AcquireResult {
  const { now, ttlMs = DEFAULT_LEASE_MS, newLeaseId = randomUUID, mutation = {} } = options;
  const db = store.handle;

  // Idempotency wraps the transaction, not the other way round: a retried
  // acquire must hand back the first answer rather than take a second lease.
  return inTransaction(store, () =>
    store.replay(mutation, "acquire", () => {
      const stamp = now.toISOString();
      const existing = latest(db, taskRef);

      if (existing !== undefined && isLive(existing, stamp)) {
        return {
          ok: false as const,
          reason: "held" as const,
          by: String(existing["runner"]),
          until: String(existing["expires_at"]),
        };
      }

      const generation = existing === undefined ? 1 : Number(existing["lease_generation"]) + 1;
      const claim: Claim = {
        taskRef,
        leaseId: newLeaseId(),
        generation,
        runner,
        acquiredAt: stamp,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        heartbeatAt: stamp,
      };

      // The compare-and-swap, enforced by UNIQUE (task_ref, lease_generation)
      // rather than by anything this code does. Two runners that both read the
      // same generation both try to write generation + 1; the database admits
      // one. OR IGNORE turns the loser's constraint violation into a row count
      // of zero, because losing a race is an ordinary outcome and not an error.
      const { changes } = db
        .prepare(
          `INSERT OR IGNORE INTO claim
             (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          claim.leaseId,
          taskRef,
          claim.generation,
          runner,
          claim.acquiredAt,
          claim.expiresAt,
          claim.heartbeatAt,
        );

      if (Number(changes) === 0) {
        const winner = latest(db, taskRef);
        return {
          ok: false as const,
          reason: "held" as const,
          by: winner === undefined ? "unknown" : String(winner["runner"]),
          until: winner === undefined ? stamp : String(winner["expires_at"]),
        };
      }

      return { ok: true as const, claim, reclaimed: existing !== undefined };
    },
    // Only a lease that was actually granted is worth remembering. Recording
    // the refusal would make this key a permanent "no" for a task that is
    // free again five minutes later.
    result => result.ok,
    ),
  );
}

/** The newest lease on a task, held or not. */
function latest(db: Store["handle"], taskRef: number): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM claim WHERE task_ref = ? ORDER BY lease_generation DESC LIMIT 1")
    .get(taskRef);
}


/**
 * "I am still here." Extends the lease, and tells a superseded runner that it
 * has been superseded — which is the cheapest moment for it to find out, well
 * before it has finished work nobody will accept.
 */
export function heartbeat(
  store: Store,
  leaseId: string,
  now: Date,
  ttlMs: number = DEFAULT_LEASE_MS,
): FenceResult {
  const db = store.handle;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  return inTransaction(store, () => {
    const { changes } = db
      .prepare(
        `UPDATE claim SET heartbeat_at = ?, expires_at = ?
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), expiresAt, leaseId);

    if (Number(changes) === 0) return refusal(db, leaseId);

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    return { ok: true as const, claim: readClaim(row as Record<string, unknown>) };
  });
}

/**
 * The fence, as a predicate on the write rather than a check before it.
 *
 * Checking first and updating second leaves a window: a reclaim committing
 * between the two makes the check's answer stale, and the update — matching on
 * lease id alone — succeeds anyway. Both runners then believe they hold the
 * task, which is the precise failure this module was written to make
 * impossible. Putting the condition inside the statement closes it, because
 * SQLite evaluates it against the row it is about to write.
 */
const NOT_SUPERSEDED = `NOT EXISTS (
  SELECT 1 FROM claim AS newer
   WHERE newer.task_ref = claim.task_ref
     AND newer.lease_generation > claim.lease_generation
)`;

/**
 * Why a fenced write matched nothing. Worth the extra read: "you were
 * superseded" and "I have never heard of this lease" send a runner to very
 * different places.
 */
function refusal(db: Store["handle"], leaseId: string): { ok: false; reason: "fenced" | "unknown" } {
  const row = db.prepare("SELECT 1 AS hit FROM claim WHERE lease_id = ?").get(leaseId);
  return { ok: false, reason: row === undefined ? "unknown" : "fenced" };
}

/**
 * Hand the task back.
 *
 * Accepted only from the lease that currently holds it. A completion arriving
 * on a superseded lease is the failure this whole module exists for, and it is
 * rejected without touching anything — the work is not lost, it is simply not
 * this runner's to report, and the record says so rather than overwriting a
 * live claim with a dead runner's opinion.
 */
export function release(store: Store, leaseId: string, now: Date): FenceResult {
  const db = store.handle;

  return inTransaction(store, () => {
    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);

    if (Number(changes) === 0) {
      // A repeat of a completion this same lease already made is not a fence —
      // nobody took the task away, the runner simply said so twice because its
      // first acknowledgement was lost. M1 asks for duplicate completion to be
      // reconciled rather than refused, and telling an honest runner it was
      // superseded would send it to stop when it should carry on.
      //
      // Deliberately not filtered by supersession. A lease that released and
      // was then reacquired by somebody else still *completed*: its work was
      // accepted at the time, and the honest answer to a late retry is "you
      // already did this", not "you were fenced" — which would say its work
      // never counted. Fencing is for a lease that never finished.
      const duplicate = db
        .prepare("SELECT * FROM claim WHERE lease_id = ? AND released_at IS NOT NULL")
        .get(leaseId);
      if (duplicate !== undefined) {
        return { ok: true as const, claim: readClaim(duplicate), duplicate: true };
      }
      return refusal(db, leaseId);
    }

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    return { ok: true as const, claim: readClaim(row as Record<string, unknown>) };
  });
}

/** The live claim on a task, if there is one. */
export function currentClaim(store: Store, taskRef: number, now: Date): Claim | null {
  const row = latest(store.handle, taskRef);
  if (row === undefined || !isLive(row, now.toISOString())) return null;
  return readClaim(row);
}

/**
 * Release every lease that has run out.
 *
 * Expiry alone already frees a task for acquisition, so this is not what makes
 * reclaim work — it is what makes it *visible*. A daemon reaping on a tick
 * turns "this lease is being ignored because its timestamp is in the past" into
 * a released row somebody can read, which is the difference between a system
 * that recovers and a system that appears to have lost the work.
 */
export function reap(store: Store, now: Date): Claim[] {
  const stamp = now.toISOString();
  const db = store.handle;

  const expired = db
    .prepare("SELECT * FROM claim WHERE released_at IS NULL AND expires_at <= ?")
    .all(stamp);
  if (expired.length === 0) return [];

  db.prepare("UPDATE claim SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?").run(
    stamp,
    stamp,
  );
  return expired.map(readClaim);
}

function isLive(row: Record<string, unknown>, stamp: string): boolean {
  return row["released_at"] === null && String(row["expires_at"]) > stamp;
}

function readClaim(row: Record<string, unknown>): Claim {
  return {
    taskRef: Number(row["task_ref"]),
    leaseId: String(row["lease_id"]),
    generation: Number(row["lease_generation"]),
    runner: String(row["runner"]),
    acquiredAt: String(row["acquired_at"]),
    expiresAt: String(row["expires_at"]),
    heartbeatAt: String(row["heartbeat_at"]),
  };
}

/**
 * IMMEDIATE rather than DEFERRED: the write lock is taken up front, so two
 * processes racing for the same task queue behind one another instead of both
 * reading, both deciding they won, and one failing at commit time.
 */
function inTransaction<T>(store: Store, body: () => T): T {
  const db = store.handle;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
