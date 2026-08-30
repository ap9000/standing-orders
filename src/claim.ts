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
import { attendedLivenessState, type AttendedLiveness } from "./liveness.js";

/** attendedLivenessState over the store's ISO columns. */
function attendedWatchState(lastBeatAt: string | null, now: Date, absoluteExpiry: string): AttendedLiveness {
  return attendedLivenessState(
    lastBeatAt === null ? null : Date.parse(lastBeatAt),
    now.getTime(),
    Date.parse(absoluteExpiry),
  );
}
import {
  BUILT_IN,
  parseCapabilityKey,
  type Store,
  type Mutation,
  type TaskState,
} from "./store.js";
import type { ParsedDecision, Problem } from "./decision.js";
import { digestOf } from "./scope.js";
import type { ParsedPlan } from "./plan.js";


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
  | { ok: true; claim: Claim; reclaimed: boolean; replayed?: boolean }
  | { ok: false; reason: "held"; by: string; until: string }
  | { ok: false; reason: "reserved"; reservedFor: string }
  | { ok: false; reason: "external"; detail: "stale-mirror" | "external-closed" | "dispatch-revoked" | "plane-blocked" }
  /** An attended authorization holds this task for its named runner (v25).
   * Its OWN reason token — never the `reserved` tag, whose reservedFor field
   * is a documented public contract meaning task_ref.assigned_runner. */
  | { ok: false; reason: "attended-held"; runner: string }
  /** The task's only authority is an attended authorization, and the
   * operator is not watching (or the one attempt is spent). Expiry never
   * converts attended work into unattended work. */
  | { ok: false; reason: "attended-only" }
  /** A mode-sealed approval whose signature no longer stands (v29): the
   * approval falls back to a person; nothing dispatches on a dead mode. */
  | { ok: false; reason: "mode-ended"; message: string };

/** `fenced` means the lease was superseded; `unknown` means it never existed. */
export type FenceResult =
  | { ok: true; claim: Claim; duplicate?: boolean }
  | { ok: false; reason: "fenced" | "unknown" };

/**
 * Completion's OWN result (external dispatch, finding 33): `completed` is
 * today's world — the task is done/failed as asked; `disowned` means the
 * tracker closed this mirror while it was being built — the task is
 * cancelled, the branch is kept as evidence, and the caller must never
 * publish. The arm is DURABLE (claim.released_by), so a retried completion
 * returns its original answer forever.
 */
export type CompleteResult =
  | { ok: true; arm: "completed" | "disowned"; claim: Claim; duplicate?: boolean }
  | { ok: false; reason: "fenced" | "unknown" };

/** How stale a mirror's last complete sync may be before admission refuses. */
export const SYNC_MAX_AGE_MS = 15 * 60_000;

export type AcquireOptions = {
  now: Date;
  ttlMs?: number;
  /** Injected in tests so a lease id can be asserted on. */
  newLeaseId?: () => string;
  /** The watch incarnation dispatching this claim, for crash recovery keyed to it. */
  incarnation?: string;
  mutation?: Mutation;
  /** External-mirror freshness bound; defaults to SYNC_MAX_AGE_MS. */
  syncMaxAgeMs?: number;
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
  // Replay detection is ACQUIRE-SPECIFIC (external dispatch, finding 36):
  // the stored payload is untouched — the flag rides only the returned
  // copy, so a second replay cannot double-stamp, and Store.replay's T→T
  // contract holds for every other user.
  const replayed = store.hasMutationRecord(options.mutation ?? {});
  const result = inTransaction(store, () => acquireLocked(store, taskRef, runner, options));
  return replayed && result.ok ? { ...result, replayed: true } : result;
}

/**
 * The body of `acquire`, for callers already holding the transaction.
 * `acquireIfReady` needs its readiness check and the CAS to be one atomic
 * step, and SQLite does not nest transactions.
 */
function acquireLocked(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions,
): AcquireResult {
  const { now, ttlMs = DEFAULT_LEASE_MS, newLeaseId = randomUUID, mutation = {} } = options;
  const db = store.handle;

  // Idempotency wraps the CAS, not the other way round: a retried
  // acquire must hand back the first answer rather than take a second lease.
  return (
    store.replay(mutation, "acquire", () => {
      const stamp = now.toISOString();
      // The reservation gate lives HERE, in the one primitive every
      // acquisition path shares (queue-columns review, finding 1): tick's
      // acquireIfReady, the raw CLI claim, and the tournament resume all
      // pass through this line, so a task reserved for one worker can
      // never be taken by another, whatever the caller's snapshot said.
      // Scheduling, not authority: nothing about WHAT may build changes.
      const reservedFor = store.assignedRunnerOf(taskRef);
      if (reservedFor !== null && reservedFor !== runner) {
        return { ok: false as const, reason: "reserved" as const, reservedFor };
      }
      // The external-mirror gate (dispatch v3 §2): every acquisition path
      // shares this line, so a stale, closed, revoked, or plane-blocked
      // mirror never starts a build — whatever the caller's snapshot said.
      // An ordinary task costs one indexed lookup.
      const mirrorWhy = store.mirrorAdmissionRefusal(taskRef, now, options.syncMaxAgeMs ?? SYNC_MAX_AGE_MS);
      if (mirrorWhy !== null && mirrorWhy !== "not-a-mirror") {
        return { ok: false as const, reason: "external" as const, detail: mirrorWhy };
      }
      // The attended gate (Phase 2, v6 W10/Q4), in the one primitive every
      // acquisition path shares — raw CLI claims included: a task with an
      // OPEN attended authorization dispatches only to its named runner,
      // and a task whose ONLY authority is attended dispatches only while
      // the operator is watching, with the one attempt unspent.
      // An authorization past its absolute expiry gates NOTHING (round-6
      // finding 8): it is a corpse the sweep will close, and letting it
      // keep refusing other runners on an approved task would be a
      // permanent lock nobody signed.
      // THE MODE BELT on the one primitive every claim road shares (Codex
      // people round 2, finding 2): a mode-sealed approval whose signature
      // no longer stands — revoked, expired by clock, or a dead signer —
      // does not dispatch, CLI claim included. Live claims already taken
      // are untouched; this fences only NEW takes.
      if (!store.modeApprovalLive(taskRef, now)) {
        return {
          ok: false as const,
          reason: "mode-ended" as const,
          message: "the operating mode that approved this has ended — the approval falls back to a person",
        };
      }
      const attendedRow = store.openAuthorizationFor(taskRef);
      const attendedOpen =
        attendedRow !== null && Date.parse(attendedRow.absoluteExpiry) > now.getTime() ? attendedRow : null;
      if (attendedOpen !== null) {
        if (attendedOpen.runner !== runner) {
          return { ok: false as const, reason: "attended-held" as const, runner: attendedOpen.runner };
        }
        const scopeApproved = db
          .prepare(
            `SELECT 1 AS hit FROM task_scope
             JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
             WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL AND (COALESCE(task_scope.approval_basis, 'password') <> 'mode'
                OR EXISTS (SELECT 1 FROM operating_mode om
                            JOIN approver signer ON signer.name = om.signed_by
                           WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                             AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                             AND signer.revoked_at IS NULL AND signer.role = 'approver'))`,
          )
          .get(taskRef, now.toISOString());
        if (scopeApproved === undefined) {
          const watching = attendedWatchState(attendedOpen.lastBeatAt, now, attendedOpen.absoluteExpiry);
          if ((watching !== "live" && watching !== "grace") || attendedOpen.attemptRun !== null) {
            return { ok: false as const, reason: "attended-only" as const };
          }
        }
      }
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
             (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, incarnation)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          claim.leaseId,
          taskRef,
          claim.generation,
          runner,
          claim.acquiredAt,
          claim.expiresAt,
          claim.heartbeatAt,
          options.incarnation ?? null,
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
    )
  );
}

/** The newest lease on a task, held or not. */
function latest(db: Store["handle"], taskRef: number): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM claim WHERE task_ref = ? ORDER BY lease_generation DESC LIMIT 1")
    .get(taskRef);
}

/**
 * Why `acquireIfReady` said no before the race was even run. `not-ready` is
 * about the task's own state; `capability` is about the machine's — a gap a
 * person can fill, named so the caller can say which.
 */
export type NotReady = {
  ok: false;
  reason: "not-ready" | "capability" | "attention-budget" | "capacity" | "quota";
  message: string;
};

/** DESIGN §8 gate 6: above this many open decisions, stop dispatching the parkers. */
export const DEFAULT_MAX_OPEN_DECISIONS = 5;

/**
 * Take the task, if it is free *and still worth taking*.
 *
 * `listReady` then `acquire` is two reads of a world that moves between them:
 * a hold placed, a blocker reopened, the task cancelled — and the CAS admits
 * the claim anyway, because the CAS only defends against other claimants. An
 * unattended pass has nobody watching who would notice the stale dispatch, so
 * the readiness conditions are re-proved inside the same transaction as the
 * acquire, against rows the write lock has already pinned.
 *
 * "Not ready" is a different answer from "held": held means somebody else got
 * it, which is a race being won; not-ready means nobody should have it, and
 * says why.
 */
export function acquireIfReady(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions & {
    repo?: string;
    maxOpenDecisions?: number;
    /** The provider this dispatch resolved to — the quota key. */
    provider?: string;
    /** The model this dispatch would run — the quota scope. */
    model?: string;
    /** What this dispatch is FOR. Re-proved inside the transaction — the
     * caller's survey is not trusted (Codex planning review, finding 2). */
    dispatchRole?: "builder" | "planner";
  },
): AcquireResult | NotReady {
  const role = options.dispatchRole ?? "builder";
  return inTransaction(store, () => {
    const why = notReady(store, taskRef, options.now);
    if (why !== null) return { ok: false as const, reason: "not-ready" as const, message: why };

    // The role's own precondition, re-read where the write lock has pinned
    // it — never an early return past the shared gates below. A planner
    // dispatches exactly when the operator asked and no promise exists yet;
    // a builder dispatches exactly when the promise is approved. A
    // mode-sealed approval additionally re-proves its signature is STILL
    // the live mode (belt to the demotion sweep — R-REVOKE's next gate
    // holds even in the window before an expired mode is durably closed).
    const approvedScope = store.handle
      .prepare(
        `SELECT 1 AS hit FROM task_scope
         JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
         WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL AND (COALESCE(task_scope.approval_basis, 'password') <> 'mode'
                OR EXISTS (SELECT 1 FROM operating_mode om
                            JOIN approver signer ON signer.name = om.signed_by
                           WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                             AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                             AND signer.revoked_at IS NULL AND signer.role = 'approver'))`,
      )
      .get(taskRef, options.now.toISOString());
    if (role === "planner") {
      const ref = store.refForId(taskRef);
      if (ref?.plan !== "requested") {
        return { ok: false as const, reason: "not-ready" as const, message: "no plan was requested" };
      }
      if (approvedScope !== undefined) {
        return { ok: false as const, reason: "not-ready" as const, message: "the scope is already approved — nothing left to plan" };
      }
    }
    let attendedAuthority = false;
    if (role !== "planner" && approvedScope === undefined) {
      // The authority union (v6 W1): an unapproved scope still dispatches
      // when a LIVE attended authorization names THIS runner and its one
      // attempt is unspent — the authorization IS the authority. Everything
      // else about readiness still gates below and in acquireLocked.
      const authorization = store.openAuthorizationFor(taskRef);
      const watching =
        authorization === null
          ? null
          : attendedWatchState(authorization.lastBeatAt, options.now, authorization.absoluteExpiry);
      attendedAuthority =
        authorization !== null &&
        authorization.runner === runner &&
        (watching === "live" || watching === "grace") &&
        authorization.attemptRun === null;
      if (!attendedAuthority) {
        return { ok: false as const, reason: "not-ready" as const, message: "the scope is not approved" };
      }
    }
    // Capabilities are re-read inside the same transaction as the CAS, like
    // every other readiness fact: a key that expired between the survey and
    // the take must not be dispatched on the survey's answer.
    const gap = missingCapability(store, taskRef, options.repo ?? null, options.now);
    if (gap !== null) return { ok: false as const, reason: "capability" as const, message: gap };

    // Capacity (§8 gate 3), counted where the claim lands — two overlapping
    // passes cannot both see a free slot that only exists once. Enforced for
    // registered runners; a runner the store has never met is a test driving
    // the API directly, and the CLI always registers.
    const registered = store.getRunner(runner);
    if (registered !== null && !attendedAuthority) {
      // Capacity governs UNATTENDED work (v6 W2 + round-6 finding 7): an
      // attended session's bound is one-held-per-runner, so a full
      // unattended ledger must not refuse the operator who is watching.
      const held = store.liveClaimCount(runner, options.now);
      if (held >= registered.runner.capacity) {
        return {
          ok: false as const,
          reason: "capacity" as const,
          message: `${runner} holds ${held} of ${registered.runner.capacity} slot(s) — a free CPU against a full ledger is not capacity`,
        };
      }
    }

    // Quota, same gate: an exhausted credential refuses; a half-open one
    // admits exactly this dispatch as its probe, consumed here so a racing
    // pass cannot also treat it as open.
    const scope = options.model ?? "";
    // Quota is keyed to the credential that actually exhausts: the RESOLVED
    // provider, never a fixed binary name — codex quota must not collide
    // with claude's, nor bypass it (Codex provider review, high finding 5).
    const quota = store.quotaState(runner, options.provider ?? "claude", scope, options.now);
    if (quota !== null && quota.state === "exhausted") {
      return {
        ok: false as const,
        reason: "quota" as const,
        message: `${runner}'s provider quota is exhausted (${quota.reason})${quota.resetAt === null ? "" : ` until ${quota.resetAt}`} — a free slot against an exhausted quota is not capacity`,
      };
    }
    // The attention budget (§8, gate 6), proved where every other readiness
    // fact is proved. A phone with thirty open questions answers none of
    // them; above the budget, tasks with a *measured* habit of parking step
    // aside so the night keeps building what builds. First-time parkers pass
    // — a rate nobody measured is not a rate.
    const budget = options.maxOpenDecisions ?? DEFAULT_MAX_OPEN_DECISIONS;
    if (store.countUnanswered() >= budget) {
      // A planner exists to generate questions; above the budget it is
      // refused outright — no zero-rate first-timer pass (finding 2).
      if (role === "planner") {
        return {
          ok: false as const,
          reason: "attention-budget" as const,
          message: `${store.countUnanswered()} decisions already wait — a planner would only add more; answer some first`,
        };
      }
      const rate = store.refForId(taskRef)?.parkRate ?? 0;
      if (rate > 0) {
        return {
          ok: false as const,
          reason: "attention-budget" as const,
          message: `${store.countUnanswered()} decisions already wait and this task parks ${Math.round(rate * 100)}% of its attempts — answer some before it may add more`,
        };
      }
    }
    const taken = acquireLocked(store, taskRef, runner, options);
    // The half-open probe slot is consumed only WITH the claim it admits —
    // an attention refusal or a lost CAS must not re-arm the quota as
    // exhausted with no probe in flight (finding 3). Same transaction, so
    // consume-with-claim is all-or-nothing.
    if (taken.ok && quota !== null) {
      store.consumeHalfOpen(runner, options.provider ?? "claude", scope, options.now);
    }
    return taken;
  });
}

/**
 * The FALLBACK-ADMISSION claim (E3d, review finding 4): the one gate a
 * pending-admission chain cycle dispatches through. It enforces everything
 * `acquireIfReady` enforces — task state, holds, blockers, the approved
 * scope + live-mode belt, capability, capacity, and quota — with EXACTLY
 * ONE deliberate difference: a BACKOFF hold does not gate, because the
 * pending admission IS the system's answer to the predecessor's failure
 * (waiting out the exhausted entry's backoff to run a different credential
 * would be waiting for nothing). Quota is keyed by the PINNED entry's
 * provider, model, and auth mode — the credential that would actually
 * spend — so an exhausted fallback credential refuses here, before any
 * claim exists.
 */
export function acquireFallback(
  store: Store,
  taskRef: number,
  runner: string,
  options: AcquireOptions & {
    repo?: string;
    provider: string;
    model: string;
    authMode: "subscription" | "api-key";
    maxOpenDecisions?: number;
  },
): AcquireResult | NotReady {
  return inTransaction(store, () => {
    const db = store.handle;
    const stamp = options.now.toISOString();
    const task = db
      .prepare(
        `SELECT task.id, task.state FROM task
         JOIN task_ref ON task_ref.external_id = task.id AND task_ref.backend = ?
         WHERE task_ref.id = ?`,
      )
      .get(BUILT_IN, taskRef);
    if (task === undefined) return { ok: false as const, reason: "not-ready" as const, message: "no such task" };
    // A task the strikes already ended (state failed) or that concluded is
    // TERMINAL: its pending cycle never spends (the reviewer's third-strike
    // scenario) — the cycle simply waits out as an inert record.
    if (String(task["state"]) !== "queued") {
      return { ok: false as const, reason: "not-ready" as const, message: `state is ${String(task["state"])}, not queued` };
    }
    // Every hold EXCEPT backoff gates: an operator hold, a decision hold,
    // an incident hold all still mean "do not spend".
    const hold = db
      .prepare(
        `SELECT reason FROM hold
         WHERE task_ref = ? AND owner_kind <> 'backoff' AND (until IS NULL OR until > ?) LIMIT 1`,
      )
      .get(taskRef, stamp);
    if (hold !== undefined) return { ok: false as const, reason: "not-ready" as const, message: `held: ${String(hold["reason"])}` };
    const blocker = db
      .prepare(
        `SELECT blocker.id FROM task_edge
         JOIN task AS blocker ON blocker.id = task_edge.blocker
         WHERE task_edge.blocked = ? AND blocker.state <> 'done'
         ORDER BY blocker.id LIMIT 1`,
      )
      .get(String(task["id"]));
    if (blocker !== undefined) return { ok: false as const, reason: "not-ready" as const, message: `waiting on ${String(blocker["id"])}` };
    // The approved scope + live-mode belt, verbatim from acquireIfReady: a
    // chain approval IS a scope approval, and a mode-sealed one must still
    // stand.
    const approvedScope = db
      .prepare(
        `SELECT 1 AS hit FROM task_scope
         JOIN task_ref ON task_ref.id = ? AND task_scope.task_id = task_ref.external_id
         WHERE task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL AND (COALESCE(task_scope.approval_basis, 'password') <> 'mode'
                OR EXISTS (SELECT 1 FROM operating_mode om
                            JOIN approver signer ON signer.name = om.signed_by
                           WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                             AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                             AND signer.revoked_at IS NULL AND signer.role = 'approver'))`,
      )
      .get(taskRef, stamp);
    if (approvedScope === undefined) {
      return { ok: false as const, reason: "not-ready" as const, message: "the scope is not approved" };
    }
    const gap = missingCapability(store, taskRef, options.repo ?? null, options.now);
    if (gap !== null) return { ok: false as const, reason: "capability" as const, message: gap };
    const registered = store.getRunner(runner);
    if (registered !== null) {
      const held = store.liveClaimCount(runner, options.now);
      if (held >= registered.runner.capacity) {
        return {
          ok: false as const,
          reason: "capacity" as const,
          message: `${runner} holds ${held} of ${registered.runner.capacity} slot(s) — a free CPU against a full ledger is not capacity`,
        };
      }
    }
    // Quota, keyed by the PINNED credential that would spend.
    const quota = store.quotaState(runner, options.provider, options.model, options.now, options.authMode);
    if (quota !== null && quota.state === "exhausted") {
      return {
        ok: false as const,
        reason: "quota" as const,
        message: `${runner}'s ${options.provider} quota is exhausted (${quota.reason})${quota.resetAt === null ? "" : ` until ${quota.resetAt}`} — the fallback entry's own credential is spent`,
      };
    }
    // The attention budget, exactly as the ordinary road holds it (E3d
    // verify, R4): a fallback attempt can park and add a decision like any
    // other, so above the budget a task with a measured parking habit steps
    // aside here too — backoff is the ONE exemption, not this.
    const budget = options.maxOpenDecisions ?? DEFAULT_MAX_OPEN_DECISIONS;
    if (store.countUnanswered() >= budget) {
      const rate = store.refForId(taskRef)?.parkRate ?? 0;
      if (rate > 0) {
        return {
          ok: false as const,
          reason: "attention-budget" as const,
          message: `${store.countUnanswered()} decisions already wait and this task parks ${Math.round(rate * 100)}% of its attempts — answer some before it may add more`,
        };
      }
    }
    const taken = acquireLocked(store, taskRef, runner, options);
    if (taken.ok && quota !== null) {
      store.consumeHalfOpen(runner, options.provider, options.model, options.now, options.authMode);
    }
    return taken;
  });
}

/**
 * The first requirement this task fails, in words, or null. A requirement
 * whose capability was never recorded fails too — fail closed is the only
 * honest reading of "a task whose capabilities are not verified does not
 * dispatch" when nobody has even written the capability down.
 */
export function missingCapability(
  store: Store,
  taskRef: number,
  dispatchRepo: string | null,
  now: Date,
): string | null {
  const db = store.handle;
  const row = db
    .prepare("SELECT repo, capability_requirements FROM task_ref WHERE id = ?")
    .get(taskRef);
  if (row === undefined) return "no such task reference";

  let keys: string[];
  try {
    keys = JSON.parse(String(row["capability_requirements"] ?? "[]")) as string[];
  } catch {
    keys = [];
  }
  if (keys.length === 0) return null;

  // The task's own placement wins; a task placed nowhere is judged against
  // the repo this dispatch is for.
  const repo = row["repo"] === null || row["repo"] === undefined ? dispatchRepo : String(row["repo"]);
  if (repo === null) return `requires ${keys[0]} but is placed in no repository`;

  const stamp = now.toISOString();
  for (const key of keys) {
    const parsed = parseCapabilityKey(key);
    if (parsed === null) return `requirement \`${key}\` is not a capability key`;
    const found = db
      .prepare(
        `SELECT status, expires_at FROM capability
          WHERE repo = ? AND kind = ? AND name = ?`,
      )
      .get(repo, parsed.kind, parsed.name);
    if (found === undefined) return `needs ${key} — unrecorded for ${repo}`;
    if (String(found["status"]) !== "verified") return `needs ${key} — not verified`;
    const expires = found["expires_at"];
    if (expires !== null && String(expires) <= stamp) return `needs ${key} — verification expired`;
  }
  return null;
}

/** The first readiness condition this reference fails, in words, or null. */
function notReady(store: Store, taskRef: number, now: Date): string | null {
  const db = store.handle;
  const stamp = now.toISOString();

  const task = db
    .prepare(
      `SELECT task.id, task.state FROM task
       JOIN task_ref ON task_ref.external_id = task.id AND task_ref.backend = ?
       WHERE task_ref.id = ?`,
    )
    .get(BUILT_IN, taskRef);
  if (task === undefined) return "no such task";
  if (String(task["state"]) !== "queued") return `state is ${String(task["state"])}, not queued`;

  const hold = db
    .prepare(
      `SELECT reason FROM hold
       WHERE task_ref = ? AND (until IS NULL OR until > ?) LIMIT 1`,
    )
    .get(taskRef, stamp);
  if (hold !== undefined) return `held: ${String(hold["reason"])}`;

  const blocker = db
    .prepare(
      `SELECT blocker.id FROM task_edge
       JOIN task AS blocker ON blocker.id = task_edge.blocker
       WHERE task_edge.blocked = ? AND blocker.state <> 'done'
       ORDER BY blocker.id LIMIT 1`,
    )
    .get(String(task["id"]));
  if (blocker !== undefined) return `waiting on ${String(blocker["id"])}`;

  return null;
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
        `UPDATE claim SET released_at = ?, released_by = 'released'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);

    if (Number(changes) === 0) {
      // A repeat of a hand-back this same lease already made is not a fence —
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
      //
      // But *how* the lease came to be released decides everything. Only a
      // release the runner itself made counts as "you already did this". A
      // lease the reaper or dead-runner recovery took back was never handed
      // in by anybody — the world moved on without it, and the answer to its
      // late retry is the fence.
      return duplicateOrRefusal(db, leaseId, ["released", "completed"]);
    }

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    store.bumpWake();
    return { ok: true as const, claim: readClaim(row as Record<string, unknown>) };
  });
}

/**
 * Whether an already-released lease was released in a way the caller may
 * treat as its own doing. Anything else — reaped, recovered, or provenance
 * unknown — is the fence, because accepting it would let a reclaimed lease's
 * late retry pass as an ordinary duplicate.
 */
function duplicateOrRefusal(
  db: Store["handle"],
  leaseId: string,
  own: readonly string[],
): FenceResult {
  const released = db
    .prepare("SELECT * FROM claim WHERE lease_id = ? AND released_at IS NOT NULL")
    .get(leaseId);
  if (released !== undefined && own.includes(String(released["released_by"] ?? ""))) {
    return { ok: true as const, claim: readClaim(released), duplicate: true };
  }
  if (released !== undefined) return { ok: false as const, reason: "fenced" as const };
  return refusal(db, leaseId);
}

/**
 * Release the lease and write the task's terminal state, as one step.
 *
 * Release-then-mark is a window: between the two, the freed task is back in
 * the ready set, and another pass can claim it before the terminal state
 * lands — two builders for one task, the second dispatched by our own
 * bookkeeping. Here the state is written inside the same transaction as the
 * fenced release, so a task is never simultaneously free and unfinished.
 *
 * A fenced or unknown lease writes nothing: a runner the world moved past
 * does not get to say how the task ended. A duplicate release reports
 * `duplicate` and also writes nothing — the first completion already said,
 * and a retry changing the answer would make "done" negotiable.
 */
export function completeFenced(
  store: Store,
  leaseId: string,
  state: Extract<TaskState, "done" | "failed">,
  now: Date,
  mutation: Mutation = {},
): CompleteResult {
  const db = store.handle;

  return inTransaction(store, () => {
    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'completed'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);

    if (Number(changes) === 0) {
      // Only a completion this same lease already made reads as a duplicate.
      // The DURABLE disposition (released_by) reproduces the original arm —
      // whatever the task or the tracker did since (finding 33). A lease
      // the reaper or recovery released was never *accepted*; a late
      // completion after that is exactly the stale commit the fence keeps
      // out.
      const released = db
        .prepare("SELECT * FROM claim WHERE lease_id = ? AND released_at IS NOT NULL")
        .get(leaseId);
      if (released !== undefined) {
        const by = String(released["released_by"] ?? "");
        if (by === "completed" || by === "disowned") {
          return {
            ok: true as const,
            arm: by === "disowned" ? ("disowned" as const) : ("completed" as const),
            claim: readClaim(released),
            duplicate: true,
          };
        }
        return { ok: false as const, reason: "fenced" as const };
      }
      return refusal(db, leaseId) as CompleteResult;
    }

    const row = db.prepare("SELECT * FROM claim WHERE lease_id = ?").get(leaseId);
    const claim = readClaim(row as Record<string, unknown>);

    const taskId = db
      .prepare("SELECT external_id FROM task_ref WHERE id = ? AND backend = ?")
      .get(claim.taskRef, BUILT_IN);

    // The completion gate (external dispatch, v4 §24): the latch is read
    // INSIDE this transaction, on a FRESH win only. A latched mirror's
    // completion is DISOWNED — the task is cancelled, the disposition is
    // written durably, and the caller never sees the completed arm, so
    // publication is impossible by construction.
    const disowned = taskId !== undefined && !store.mirrorAllowsCompletion(String(taskId["external_id"]));
    if (disowned) {
      db.prepare("UPDATE claim SET released_by = 'disowned' WHERE lease_id = ?").run(leaseId);
    }

    if (taskId !== undefined) {
      store.replay(mutation, "completeFenced", () => {
        db.prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?").run(
          disowned ? "cancelled" : state,
          now.toISOString(),
          String(taskId["external_id"]),
        );
        return true;
      });
    }

    store.bumpWake();
    return { ok: true as const, arm: disowned ? ("disowned" as const) : ("completed" as const), claim };
  });
}

/**
 * Seal a park, fenced at the write (§7).
 *
 * The builder proved its lease after the agent ran; this transaction proves
 * it again *in the same statement that releases it*, because everything a
 * park creates — the decision, its hold, the outbox row — is only true if
 * this lease still spoke for the task at the moment of sealing. A superseded
 * lease creates none of it: no decision, no hold, no notification, and the
 * run is finalized as the fenced refusal it was. A crash anywhere inside
 * rolls all of it back together; there is no instant at which a decision
 * exists without its hold.
 *
 * `released_by = 'parked'` so a late retry from this lease is answered with
 * the fence, not "duplicate": a park hands the task to a person, and nothing
 * the runner says afterwards is that person's answer.
 */
/**
 * Continuation admission (Phase 2E, A4 / v3 R7): the AUTHORIZATION is the
 * claimable unit — the finished parent task is never re-queued, its state,
 * strikes, holds, and dependents untouched. Every shared gate still runs
 * (acquireLocked: reservation, external mirror, the attended gates, the
 * lease CAS); the queued-state readiness gate alone is replaced by
 * construction. Liveness, the named runner, and the unspent attempt are
 * re-proved HERE at claim time and again at the final dispatch proof.
 */
export function acquireContinuation(
  store: Store,
  authorization: import("./store.js").AttendedAuthorization,
  runner: string,
  options: AcquireOptions,
): AcquireResult | { ok: false; reason: "attended-only" | "contest-open" | "continuation-blocked"; message: string } {
  const live = store.readAuthorization(authorization.id);
  if (
    live === null ||
    live.closedAt !== null ||
    live.attemptRun !== null ||
    live.parentRun === null ||
    live.runner !== runner
  ) {
    return { ok: false, reason: "attended-only", message: "the authorization is not an open continuation for this runner" };
  }
  const watching = attendedWatchState(live.lastBeatAt, options.now, live.absoluteExpiry);
  if (watching !== "live" && watching !== "grace") {
    return { ok: false, reason: "attended-only", message: "the operator is not watching" };
  }
  if (store.activeTournamentTerms(live.taskRef) !== null) {
    return { ok: false, reason: "contest-open", message: "a tournament raced onto this task — continuation waits" };
  }
  const blocked = store.continuationBlockOf(live.parentRun);
  if (blocked !== null) {
    return { ok: false, reason: "continuation-blocked", message: blocked };
  }
  return acquire(store, live.taskRef, runner, options);
}

/**
 * The HELD park (Phase 2E, v2 S1f): the decision is recorded, paged, and
 * causally linked to the session turn that produced it — and NOTHING else
 * ends. The lease stays; the run stays open; the process stays held. The
 * conversation continues when the answer is injected as the next turn.
 * The one-unresolved-per-run partial unique refuses a second open park.
 */
export function finalizeParkHeld(
  store: Store,
  args: {
    runId: number;
    taskId: string;
    decision: ParsedDecision;
    artifactIds: readonly number[];
    sessionTurn: number;
    now: Date;
  },
): { ok: true; decisionId: number } | { ok: false; reason: "decision-open" | "not-held" } {
  const { runId, taskId, decision, artifactIds, sessionTurn, now } = args;
  return inTransaction(store, () => {
    const held = store.heldSessionOf(runId);
    if (held === null || held.endedAt !== null || held.state !== "open") {
      return { ok: false as const, reason: "not-held" as const };
    }
    const run = store.getRun(runId);
    if (run === null || run.outcome !== null) return { ok: false as const, reason: "not-held" as const };
    let decisionId: number;
    try {
      decisionId = store.saveDecision(
        {
          run: runId,
          urgency: decision.urgency,
          recap: decision.recap,
          question: decision.question,
          options: decision.options,
          recommendation: decision.recommendation,
          ...(decision.assignee === null ? {} : { assignee: decision.assignee }),
          ...(decision.deadline === null ? {} : { deadline: decision.deadline }),
        },
        now,
      );
    } catch {
      // The partial unique: one unresolved question per run at a time.
      return { ok: false as const, reason: "decision-open" as const };
    }
    store.handle.prepare("UPDATE decision SET session_turn = ? WHERE id = ?").run(sessionTurn, decisionId);
    for (const artifact of artifactIds) store.linkEvidence(decisionId, artifact);
    store.enqueueNotification(
      {
        dedupeKey: `decision:${decisionId}`,
        kind: "decision",
        subject: `${taskId} asked a question mid-session`,
        body: `${oneLine(decision.question, 200)}\n\`standing-orders decide ${decisionId}\``,
        pushClass: "decision",
        link: `/d/${decisionId}`,
      },
      now,
    );
    return { ok: true as const, decisionId };
  });
}

export function finalizeParkFenced(
  store: Store,
  args: {
    leaseId: string;
    runId: number;
    taskId: string;
    decision: ParsedDecision;
    artifactIds: readonly number[];
    now: Date;
  },
): { ok: true; decisionId: number } | { ok: false; reason: "fenced" | "unknown" } {
  const { leaseId, runId, taskId, decision, artifactIds, now } = args;
  const db = store.handle;

  return inTransaction(store, () => {
    const run = store.getRun(runId);
    if (run === null || run.leaseId !== leaseId || run.outcome !== null) {
      // A run that names another lease or is already finished cannot be
      // sealed by this call — that is a caller defect, not a race to absorb.
      throw new Error(`run ${runId} is not ${leaseId}'s open attempt — a park seals exactly one`);
    }

    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'parked'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);
    if (Number(changes) === 0) {
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
      return refusal(db, leaseId);
    }

    const decisionId = store.saveDecision(
      {
        run: runId,
        urgency: decision.urgency,
        recap: decision.recap,
        question: decision.question,
        options: decision.options,
        recommendation: decision.recommendation,
        ...(decision.assignee === null ? {} : { assignee: decision.assignee }),
        ...(decision.deadline === null ? {} : { deadline: decision.deadline }),
      },
      now,
    );
    for (const artifact of artifactIds) store.linkEvidence(decisionId, artifact);

    // The hold is indefinite by construction. The decision's deadline is
    // attention metadata; wiring it into `until` would dispatch the task,
    // unanswered, the moment the deadline passed — expiry never chooses.
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "decision",
        ownerId: String(decisionId),
        reason: `decision:${decisionId} — ${oneLine(decision.question, 80)}`,
        until: null,
      },
      now,
    );
    store.finishRun(runId, { outcome: "parked", reason: `decision:${decisionId}`, now });
    store.enqueueNotification(
      {
        dedupeKey: `decision:${decisionId}`,
        kind: "decision",
        subject: `${taskId} parked a decision`,
        body: `${oneLine(decision.question, 200)}\n\`standing-orders decide ${decisionId}\``,
        // The push stamp (arc 3): class + machine-minted link, at enqueue
        // or never. Fixed phrases ride the push service; this subject does not.
        pushClass: "decision",
        link: `/d/${decisionId}`,
      },
      now,
    );
    return { ok: true as const, decisionId };
  });
}

/**
 * Seal a park whose payload never became a decision (§6's bounded repair ran
 * out). Same fence, same atomicity, different record: an incident that stays
 * in every brief until a person resolves it, holding the task so the next
 * pass does not spend the same tokens hitting the same wall nightly. The
 * malformed payload is preserved as evidence — a person may still be able to
 * read what the agent meant.
 */
export function finalizeMalformedFenced(
  store: Store,
  args: {
    leaseId: string;
    runId: number;
    taskId: string;
    problems: readonly Problem[];
    now: Date;
  },
): { ok: true; incidentId: number } | { ok: false; reason: "fenced" | "unknown" } {
  const { leaseId, runId, taskId, problems, now } = args;
  const db = store.handle;

  return inTransaction(store, () => {
    const run = store.getRun(runId);
    if (run === null || run.leaseId !== leaseId || run.outcome !== null) {
      throw new Error(`run ${runId} is not ${leaseId}'s open attempt — a park seals exactly one`);
    }

    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'parked'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);
    if (Number(changes) === 0) {
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
      return refusal(db, leaseId);
    }

    const incidentId = store.createIncident({ run: runId, kind: "malformed-decision" }, now);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "incident",
        ownerId: String(incidentId),
        reason: `malformed-decision — the agent tried to park ${taskId} and could not say what`,
        until: null,
      },
      now,
    );
    store.finishRun(runId, { outcome: "failed", reason: "malformed-decision", now });
    store.enqueueNotification(
      {
        dedupeKey: `malformed:${runId}`,
        kind: "malformed-decision",
        pushClass: "attention",
        link: `/r/${runId}`,
        subject: `${taskId}: the agent parked but could not say what`,
        body: [
          `Repair ran out. The task is held until somebody looks.`,
          ...problems.slice(0, 5).map(problem => `- ${oneLine(problem.message, 120)}`),
          `The raw payload is preserved in run ${runId}'s evidence.`,
        ].join("\n"),
      },
      now,
    );
    return { ok: true as const, incidentId };
  });
}

/** How a failed attempt is classified, per gnhf. Decides retry, backoff, or stall. */
export type FailureClass =
  | "agent-reported"
  | "retryable-infra"
  | "no-op"
  | "commit-failure"
  | "unknown";

/** 1m, 2m, 4m, 8m, 16m — doubling, capped. Indexed by strikes-1. */
const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000];
export const MAX_STRIKES = 3;

export type FailureDisposition =
  | { ok: true; disposition: "backoff"; strikes: number; until: string }
  | { ok: true; disposition: "stalled"; strikes: number; incidentId: number }
  | { ok: true; disposition: "commit-incident"; incidentId: number }
  | { ok: false; reason: "fenced" | "unknown" };

/**
 * Seal a failed attempt: one fenced transaction for the release, the run,
 * the strike, the hold, and the page (§6, gnhf adopted rather than
 * reinvented).
 *
 * Strikes count only top-level builder attempts; built, no-change, and
 * parked reset them elsewhere; refusals, fenced attempts, and repair
 * children never reach this function. Under three strikes the task
 * requeues behind a doubling backoff hold the failure owns; at three it
 * stalls — an 'attempts-exhausted' incident, the task marked failed, held,
 * and paged once — because a fourth identical attempt at 3am is a token
 * bonfire, not persistence. A commit-stage failure takes neither road: the
 * worktree holds unpreserved work, ordinary re-pooling would refuse it as
 * dirty forever, so it is an immediate incident naming the checkout.
 */
export function finalizeFailureFenced(
  store: Store,
  args: {
    leaseId: string;
    runId: number;
    taskId: string;
    failureClass: FailureClass;
    message: string;
    worktree: string;
    now: Date;
  },
): FailureDisposition {
  const { leaseId, runId, taskId, failureClass, message, now } = args;
  const db = store.handle;

  return inTransaction(store, () => {
    const run = store.getRun(runId);
    if (run === null || run.leaseId !== leaseId || run.outcome !== null) {
      throw new Error(`run ${runId} is not ${leaseId}'s open attempt — a failure seals exactly one`);
    }
    if (run.role !== "builder") {
      throw new Error(`run ${runId} is a ${run.role} run — only top-level builder attempts take strikes`);
    }

    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'released'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);
    if (Number(changes) === 0) {
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
      return refusal(db, leaseId);
    }

    store.finishRun(runId, { outcome: "failed", reason: failureClass, now });

    if (failureClass === "commit-failure") {
      // The work exists and is uncommitted; nothing times its way out of
      // that. A person (or an explicit repair) proves the checkout.
      const incidentId = store.createIncident({ run: runId, kind: "commit-failure" }, now);
      store.holdOwned(
        {
          taskRef: run.taskRef,
          ownerKind: "incident",
          ownerId: String(incidentId),
          reason: `commit-failure — uncommitted work preserved in ${args.worktree}`,
          until: null,
        },
        now,
      );
      store.enqueueNotification(
        {
          dedupeKey: `commit-failure:${runId}`,
          kind: "commit-failure",
          pushClass: "attention",
          link: `/r/${runId}`,
          subject: `${taskId}: the commit itself failed`,
          body: `${oneLine(message, 200)}\nThe work is preserved, uncommitted, in ${args.worktree}. Prove it and \`standing-orders task requeue ${taskId}\`.`,
        },
        now,
      );
      return { ok: true as const, disposition: "commit-incident" as const, incidentId };
    }

    const strikes = store.addStrike(run.taskRef);

    if (strikes >= MAX_STRIKES) {
      const incidentId = store.createIncident({ run: runId, kind: "attempts-exhausted" }, now);
      store.holdOwned(
        {
          taskRef: run.taskRef,
          ownerKind: "incident",
          ownerId: String(incidentId),
          reason: `attempts-exhausted — ${strikes} consecutive failures, last: ${failureClass}`,
          until: null,
        },
        now,
      );
      db.prepare("UPDATE task SET state = 'failed', updated_at = ? WHERE id = ?").run(
        now.toISOString(),
        taskId,
      );
      store.enqueueNotification(
        {
          dedupeKey: `stalled:${run.taskRef}`,
          kind: "attempts-exhausted",
          pushClass: "attention",
          link: `/r/${runId}`,
          subject: `${taskId} stalled after ${strikes} straight failures`,
          body: `Last failure (${failureClass}): ${oneLine(message, 200)}\nIt will not be retried. Read the runs, then \`standing-orders task requeue ${taskId}\`.`,
        },
        now,
      );
      return { ok: true as const, disposition: "stalled" as const, strikes, incidentId };
    }

    // Under the limit: requeue behind a doubling pause the failure owns.
    // Replacing the previous backoff hold is correct — this attempt's strike
    // already reflects the whole streak.
    const wait = BACKOFF_MS[Math.min(strikes, BACKOFF_MS.length) - 1] as number;
    const until = new Date(now.getTime() + wait);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        ownerKind: "backoff",
        ownerId: String(run.taskRef),
        reason: `retry ${strikes}/${MAX_STRIKES} after ${failureClass} — backing off ${Math.round(wait / 60_000)}m`,
        until,
      },
      now,
    );
    store.enqueueNotification(
      {
        dedupeKey: `run:${runId}:failed`,
        kind: "build-failed",
        subject: `${taskId}: attempt failed (${failureClass}), retry ${strikes}/${MAX_STRIKES}`,
        body: `${oneLine(message, 200)}\nNext attempt no earlier than ${until.toISOString()}.`,
      },
      now,
    );
    return { ok: true as const, disposition: "backoff" as const, strikes, until: until.toISOString() };
  });
}

/** Untrusted text on its way into a subject line: one line, bounded. */
function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/** The live claim on a task, if there is one. */
export const MAX_PLAN_STRIKES = 3;

/** Backoff for planner retries: shorter than the builder's — a planner that
 * cannot start is usually a transient, and nothing downstream is waiting on
 * a workspace. */
const PLAN_BACKOFF_MS = [60_000, 2 * 60_000, 4 * 60_000] as const;

export type PlanFinalize =
  | { ok: true }
  | { ok: false; reason: "fenced" | "unknown" };

/**
 * Seal a successful planning run: the proposed scope, the plan document
 * artifact, the drafted state, the run outcome, and the page to the
 * operator exist together or — if the lease was superseded — not at all.
 * The scope proposal is authority-bearing (it is what the approve card
 * will restate), which is why this is the park discipline, not the DONE
 * one (Codex planning review, question 2).
 */
export function finalizePlanFenced(
  store: Store,
  args: {
    leaseId: string;
    runId: number;
    taskId: string;
    plan: ParsedPlan;
    /** The already-captured plan document file, described; null when the
     * capture itself failed (the plan still lands as scope + handoff). */
    artifact: {
      key: string;
      bytesOriginal: number;
      bytesStored: number;
      truncated: boolean;
      sha256: string;
      capture: string;
    } | null;
    now: Date;
  },
): PlanFinalize {
  const { leaseId, runId, taskId, plan, now } = args;
  const db = store.handle;
  return inTransaction(store, () => {
    const run = store.getRun(runId);
    if (run === null || run.leaseId !== leaseId || run.outcome !== null) {
      throw new Error(`run ${runId} is not ${leaseId}'s open attempt — a plan seals exactly one`);
    }
    if (run.role !== "planner") {
      throw new Error(`run ${runId} is a ${run.role} run — only planner runs draft plans`);
    }
    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'completed'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);
    if (Number(changes) === 0) {
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
      return refusal(db, leaseId);
    }

    store.saveScope({
      taskId,
      goal: plan.goal,
      outOfScope: plan.outOfScope,
      touches: plan.touches,
      proposedAt: now.toISOString(),
      digest: digestOf({ goal: plan.goal, outOfScope: plan.outOfScope, touches: plan.touches }),
      budgetMicrousd: null,
      approvedAt: null,
      approvedBy: null,
      approvedDigest: null,
    });
    if (args.artifact !== null) {
      store.saveArtifact({ run: runId, kind: "plan", ...args.artifact }, now);
    }
    store.setPlanState(run.taskRef, "drafted");
    store.resetPlanStrikes(run.taskRef);
    store.finishRun(runId, { outcome: "built", reason: "plan-drafted", now });
    store.enqueueNotification(
      {
        dedupeKey: `plan:${run.taskRef}:${runId}`,
        kind: "plan-ready",
        subject: `${taskId}: plan ready for review`,
        body: `The planner proposes: ${oneLine(plan.goal, 200)}\nReview, edit, and approve the scope — nothing builds until you do.`,
      },
      now,
    );
    return { ok: true as const };
  });
}

export type PlanFailureDisposition =
  | { ok: true; disposition: "malformed-incident"; incidentId: number }
  | { ok: true; disposition: "backoff"; strikes: number }
  | { ok: true; disposition: "exhausted"; incidentId: number; strikes: number }
  | { ok: false; reason: "fenced" | "unknown" };

/**
 * The planner's own fenced failure finalizer (Codex planning review,
 * finding 6): releases exactly the planner claim, finishes the run,
 * counts a SEPARATE planning strike — a planner that cannot finish must
 * never spend the builder's three attempts — and eventually leaves a
 * durable incident + hold + page. It never marks the task done, never
 * touches builder strikes, never commits, never publishes.
 *
 * A malformed payload goes straight to its incident with no strike: the
 * protocol failed, not the weather, and retrying the same session buys
 * nothing without the repair machinery (deliberately not wired for
 * planners in v1).
 */
export function finalizePlanFailureFenced(
  store: Store,
  args: {
    leaseId: string;
    runId: number;
    taskId: string;
    kind: "malformed" | "failure";
    message: string;
    now: Date;
  },
): PlanFailureDisposition {
  const { leaseId, runId, taskId, kind, message, now } = args;
  const db = store.handle;
  return inTransaction(store, () => {
    const run = store.getRun(runId);
    if (run === null || run.leaseId !== leaseId || run.outcome !== null) {
      throw new Error(`run ${runId} is not ${leaseId}'s open attempt — a failure seals exactly one`);
    }
    if (run.role !== "planner") {
      throw new Error(`run ${runId} is a ${run.role} run — this finalizer seals planner attempts only`);
    }
    const { changes } = db
      .prepare(
        `UPDATE claim SET released_at = ?, released_by = 'released'
          WHERE lease_id = ? AND released_at IS NULL AND ${NOT_SUPERSEDED}`,
      )
      .run(now.toISOString(), leaseId);
    if (Number(changes) === 0) {
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now });
      return refusal(db, leaseId);
    }
    store.finishRun(runId, { outcome: "failed", reason: kind === "malformed" ? "malformed-plan" : oneLine(message, 120), now });

    if (kind === "malformed") {
      const incidentId = store.createIncident({ run: runId, kind: "malformed-plan" }, now);
      store.holdOwned(
        {
          taskRef: run.taskRef,
          ownerKind: "incident",
          ownerId: String(incidentId),
          reason: "malformed-plan — the planner's payload failed validation",
          until: null,
        },
        now,
      );
      store.enqueueNotification(
        {
          dedupeKey: `malformed-plan:${runId}`,
          kind: "malformed-plan",
          pushClass: "attention",
          link: `/r/${runId}`,
          subject: `${taskId}: the planner's plan failed validation`,
          body: `${oneLine(message, 300)}\nResolve the incident to let planning retry.`,
        },
        now,
      );
      return { ok: true as const, disposition: "malformed-incident" as const, incidentId };
    }

    const strikes = store.addPlanStrike(run.taskRef);
    if (strikes >= MAX_PLAN_STRIKES) {
      const incidentId = store.createIncident({ run: runId, kind: "plan-attempts-exhausted" }, now);
      store.holdOwned(
        {
          taskRef: run.taskRef,
          ownerKind: "incident",
          ownerId: String(incidentId),
          reason: `plan-attempts-exhausted — ${strikes} straight planning failures`,
          until: null,
        },
        now,
      );
      store.enqueueNotification(
        {
          dedupeKey: `plan-stalled:${run.taskRef}`,
          kind: "plan-attempts-exhausted",
          pushClass: "attention",
          link: `/r/${runId}`,
          subject: `${taskId}: planning stalled after ${strikes} straight failures`,
          body: `Last failure: ${oneLine(message, 200)}\nResolve the incident to let planning retry, or write the scope yourself.`,
        },
        now,
      );
      return { ok: true as const, disposition: "exhausted" as const, incidentId, strikes };
    }

    const wait = PLAN_BACKOFF_MS[Math.min(strikes, PLAN_BACKOFF_MS.length) - 1] as number;
    const until = new Date(now.getTime() + wait);
    store.holdOwned(
      {
        taskRef: run.taskRef,
        // Its own owner id: a planning pause must never displace the
        // builder's backoff for the same task, or vice versa.
        ownerKind: "backoff",
        ownerId: `plan:${run.taskRef}`,
        reason: `plan retry ${strikes}/${MAX_PLAN_STRIKES} — backing off ${Math.round(wait / 60_000)}m`,
        until,
      },
      now,
    );
    store.enqueueNotification(
      {
        dedupeKey: `plan-run:${runId}:failed`,
        kind: "plan-failed",
        subject: `${taskId}: planning attempt failed, retry ${strikes}/${MAX_PLAN_STRIKES}`,
        body: `${oneLine(message, 200)}\nNext attempt no earlier than ${until.toISOString()}.`,
      },
      now,
    );
    return { ok: true as const, disposition: "backoff" as const, strikes };
  });
}

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

  // One transaction, so the list returned is exactly the list released — a
  // lease expiring between the read and the write belongs to the next reap.
  return inTransaction(store, () => {
    const expired = db
      .prepare("SELECT * FROM claim WHERE released_at IS NULL AND expires_at <= ?")
      .all(stamp);
    if (expired.length === 0) return [];

    db.prepare(
      "UPDATE claim SET released_at = ?, released_by = 'reaped' WHERE released_at IS NULL AND expires_at <= ?",
    ).run(stamp, stamp);
    return expired.map(readClaim);
  });
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
  // The store's transact: same BEGIN IMMEDIATE, plus reentrancy — a caller
  // composing a fenced finalizer with more writes (completion + publication
  // intent) joins one transaction instead of dying on a nested BEGIN.
  return store.transact(body);
}
