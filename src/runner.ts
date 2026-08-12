/**
 * A machine that may be given work.
 *
 * Auth is here from the first commit, and that is a deliberate ordering rather
 * than diligence for its own sake. A control plane that dispatches work to
 * unauthenticated runners for six months grows six months of code that assumes
 * the caller is whoever it says it is, and retrofitting identity into that is
 * how the retrofit gets a hole in it. It costs almost nothing to do now.
 *
 * **The token is never stored.** Registration mints one, prints it once, and
 * keeps only a hash. There is no command that recovers it, because a control
 * plane able to hand back a runner's credential is one whose database is worth
 * stealing — and because the same rule governs secrets everywhere else in this
 * design: the control plane holds metadata, the runner holds values.
 *
 * Liveness is separate from a lease expiring, and the distinction matters at
 * 3am. A lease expires because time passed; a runner is dead because it
 * stopped saying otherwise. Reaping on the first tells you a task is free
 * again. Reaping on the second tells you a *machine* is gone, and everything
 * it was holding — claims and worktrees alike — needs recovering together.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store, Mutation } from "./store.js";

export type Runner = {
  name: string;
  host: string;
  /** How many tasks it will hold at once. */
  capacity: number;
  repos: string[];
  agents: string[];
  registeredAt: string;
  heartbeatAt: string;
  retiredAt: string | null;
};

export type Registration = {
  runner: Runner;
  token: string;
  /** What the previous holder of this name was still holding, taken back. */
  reclaimed: Recovery | null;
};

export type AuthResult =
  | { ok: true; runner: Runner }
  | { ok: false; reason: "unknown" | "bad-token" | "retired" };

/**
 * How long a runner may go quiet before it is presumed gone.
 *
 * Comfortably more than any sensible heartbeat interval: declaring a busy
 * machine dead because one check-in was slow costs more than waiting another
 * minute for a machine that really is.
 */
export const DEFAULT_LIVENESS_MS = 3 * 60_000;

export type RegisterOptions = {
  name: string;
  host: string;
  capacity?: number;
  repos?: readonly string[];
  agents?: readonly string[];
  now: Date;
  /** Injected so a test can assert on a token it chose. */
  newToken?: () => string;
  mutation?: Mutation;
};

export function register(store: Store, options: RegisterOptions): Registration {
  const {
    name,
    host,
    capacity = 1,
    repos = [],
    agents = [],
    now,
    newToken = mintToken,
    mutation = {},
  } = options;

  const token = newToken();

  /**
   * Anything the previous holder of this name still had is taken back first.
   *
   * Registering under a name is a new process saying it exists; whatever the
   * last one was holding, it is not holding now. Skipping this is worse than
   * it sounds: the fresh `heartbeat_at` makes the old identity look alive
   * again, so the reaper walks straight past its abandoned claims and
   * worktrees and they are stranded for good.
   */
  const previous = store.getRunner(name);
  const reclaimed: Recovery | null =
    previous === null
      ? null
      : {
          runner: name,
          claims: store.releaseClaimsOf(name, now),
          worktrees: store.releaseWorktreesOf(name, now),
        };

  const runner: Runner = {
    name,
    host,
    capacity,
    repos: [...repos],
    agents: [...agents],
    registeredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    retiredAt: null,
  };

  store.saveRunner(runner, hashToken(token), mutation);
  return {
    runner,
    token,
    reclaimed:
      reclaimed !== null && (reclaimed.claims.length > 0 || reclaimed.worktrees.length > 0)
        ? reclaimed
        : null,
  };
}

/**
 * Whether this caller is who it says it is.
 *
 * Compared in constant time. The comparison is between hashes rather than
 * secrets, so the practical risk is slight — but a timing-variable equality on
 * a credential path is the kind of thing that gets copied into somewhere it
 * matters, and there is no reason to leave the example lying around.
 */
export function authenticate(store: Store, name: string, token: string): AuthResult {
  const found = store.getRunner(name);
  if (found === null) return { ok: false, reason: "unknown" };
  if (found.runner.retiredAt !== null) return { ok: false, reason: "retired" };

  return sameDigest(found.credentialHash, hashToken(token))
    ? { ok: true, runner: found.runner }
    : { ok: false, reason: "bad-token" };
}

/** "I am still here." Authenticated, because otherwise anyone could say it. */
export function heartbeat(store: Store, name: string, token: string, now: Date): AuthResult {
  const auth = authenticate(store, name, token);
  if (!auth.ok) return auth;

  store.touchRunner(name, now);
  return { ok: true, runner: { ...auth.runner, heartbeatAt: now.toISOString() } };
}

export function isAlive(runner: Runner, now: Date, livenessMs = DEFAULT_LIVENESS_MS): boolean {
  if (runner.retiredAt !== null) return false;
  const last = Date.parse(runner.heartbeatAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < livenessMs;
}

/** Runners that have stopped saying they are there. */
export function deadRunners(store: Store, now: Date, livenessMs = DEFAULT_LIVENESS_MS): Runner[] {
  return store.listRunners().filter(runner => !isAlive(runner, now, livenessMs));
}

export type Recovery = {
  runner: string;
  /** Lease ids released because the machine holding them is gone. */
  claims: string[];
  /** Worktree paths handed back to the pool. */
  worktrees: string[];
};

/**
 * Take back everything a dead runner was holding.
 *
 * Claims and worktrees together, in one pass, because they are two halves of
 * the same fact: the machine is gone. Recovering one and not the other leaves
 * a task dispatchable with its working copy still checked out to a process
 * that no longer exists — which fails later, further away, and looks like a
 * git problem rather than a scheduling one.
 *
 * Worktrees are handed back **unverified**. Nobody watched what the dead
 * process was doing when it stopped, so the directory on disk is a claim about
 * the past rather than a description of the present, and something has to look
 * before it is reused.
 */
export function recoverDead(
  store: Store,
  now: Date,
  livenessMs = DEFAULT_LIVENESS_MS,
): Recovery[] {
  return deadRunners(store, now, livenessMs).map(runner => ({
    runner: runner.name,
    claims: store.releaseClaimsOf(runner.name, now),
    worktrees: store.releaseWorktreesOf(runner.name, now),
  }));
}

/** 32 bytes of randomness, urlsafe, so it survives being pasted anywhere. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // sorts; equal-length hex digests make that unreachable in practice, and the
  // guard keeps it from throwing if one is ever malformed.
  return a.length === b.length && timingSafeEqual(a, b);
}
