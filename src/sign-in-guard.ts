/**
 * Password guessing (v99). Five wrong passwords in a row lock that account
 * for 15 minutes, doubling with each further lock up to a day; a right one
 * clears the count. Every password check counts: signing in, a request that
 * carries a password, and each step-up inside the console. Unknown names
 * count too, so guessing names gains nothing.
 *
 * Kept in memory, per database: a restart forgives, which someone locked out
 * by another's guessing may need. The console reports each lock to the
 * action ledger through onLock.
 */
export type GuardPolicy = { failuresBeforeLock: number; firstLockMs: number; maxLockMs: number };
export const DEFAULT_GUARD_POLICY: GuardPolicy = { failuresBeforeLock: 5, firstLockMs: 15 * 60_000, maxLockMs: 24 * 60 * 60_000 };
const TRACKED = 10_000;

export class PasswordGuard {
  private readonly accounts = new Map<string, { failures: number; lockedUntil: number; locks: number }>();
  /** Told once per lock: the account (as typed), and for how long. */
  onLock: ((account: string, lockMs: number) => void) | null = null;
  constructor(readonly policy: GuardPolicy = DEFAULT_GUARD_POLICY) {}

  private static key(account: string): string { return account.trim().toLowerCase().slice(0, 64); }

  /** Milliseconds this account stays locked (0: it may try). */
  lockedFor(account: string, now: number): number {
    const state = this.accounts.get(PasswordGuard.key(account));
    return state === undefined ? 0 : Math.max(0, state.lockedUntil - now);
  }

  failed(account: string, now: number): void {
    const key = PasswordGuard.key(account);
    const state = this.accounts.get(key) ?? { failures: 0, lockedUntil: 0, locks: 0 };
    this.accounts.delete(key);
    state.failures += 1;
    if (state.failures >= this.policy.failuresBeforeLock) {
      const lockMs = Math.min(this.policy.maxLockMs, this.policy.firstLockMs * 2 ** state.locks);
      state.lockedUntil = now + lockMs;
      state.locks += 1;
      state.failures = 0;
      this.onLock?.(account.trim().slice(0, 64), lockMs);
    }
    this.accounts.set(key, state);
    // Bounded: the oldest tracked names go first.
    while (this.accounts.size > TRACKED) this.accounts.delete(this.accounts.keys().next().value!);
  }

  succeeded(account: string): void {
    this.accounts.delete(PasswordGuard.key(account));
  }
}

const guards = new WeakMap<object, PasswordGuard>();
/** The guard for one database (a store): every password check against it counts. */
export function passwordGuardOf(owner: object): PasswordGuard {
  let guard = guards.get(owner);
  if (guard === undefined) { guard = new PasswordGuard(); guards.set(owner, guard); }
  return guard;
}

/**
 * Wrong passwords from one address, across every account: at most `tries`
 * in `windowMs`. What a lockout per account can't see (one address trying
 * many names) this does.
 */
export class SourceBudget {
  private readonly sources = new Map<string, number[]>();
  constructor(readonly tries = 20, readonly windowMs = 10 * 60_000) {}

  /** Milliseconds until this address may try again (0: it may). */
  waitFor(source: string, now: number): number {
    const recent = (this.sources.get(source) ?? []).filter(at => now - at < this.windowMs);
    return recent.length < this.tries ? 0 : this.windowMs - (now - recent[0]!);
  }

  failed(source: string, now: number): void {
    const recent = (this.sources.get(source) ?? []).filter(at => now - at < this.windowMs);
    recent.push(now);
    this.sources.delete(source);
    this.sources.set(source, recent.slice(-this.tries));
    while (this.sources.size > TRACKED) this.sources.delete(this.sources.keys().next().value!);
  }
}
