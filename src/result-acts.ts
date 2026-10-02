/** The result page's acts (2026-10-02), chosen in one place: exactly one ink
 * act, the one that resolves the result's state, and never navigation; at
 * most one outline act beside it. A result that can't be accepted says why
 * in one line before them.
 *
 *   everything met                      → Accept
 *   checks queued or running            → Checks running (disabled), then Accept without checks
 *   checks didn't run, a check exists   → Run checks, then Accept without checks
 *   report and changes disagree,
 *   or the proof is refuted             → Request changes, then Accept (as allowed);
 *                                         never Accept as ink, even with no form here
 *   a Needs you form resolves it        → that form (Build again, Confirm it stopped)
 *   saved notes or a failing PR         → Revise / Draft a repair task
 *   a failed build                      → Retry (its note starts with what to change), then Run checks when they
 *                                         didn't run; never Accept: a failed build is not a result to accept
 *
 * Accepting means what it always meant: the same forms post to the same
 * endpoints. This only decides which one is ink. */

/** The words over the reason field an Accept of a refuted result requires. */
export const ACCEPT_NEEDS_REASON = "Accepting needs a reason";

export type ResultActKind = "retry" | "accept" | "checks-running" | "run-checks" | "request-changes" | "rebuild" | "confirm-stopped" | "revise" | "draft-repair";

export type ResultActFacts = {
  /** An Accept this page can post (Mark complete, or the person's acceptance); `ready`: every requirement met and checks passed. */
  accept: { ready: boolean } | null;
  /** The checks didn't run, the project has one, and this person may run it. */
  runChecks: boolean;
  /** Checks on this result are queued or running. */
  checksRunning: boolean;
  /** Why it can't be accepted yet (cantAcceptYetOf), or null. */
  blocked: string | null;
  /** The feedback form is on this page. */
  canRequest: boolean;
  /** A Needs you form that resolves it here. */
  need: "rebuild" | "confirm-stopped" | null;
  /** Saved notes ready to become a revision, or a failing pull request's repair. */
  next: "revise" | "draft-repair" | null;
  /** A failed build: `retry` when the task can be retried from here. */
  failed?: { retry: boolean } | null;
};

export type ResultActs = {
  /** The one ink act, or null when nothing waits on the person. */
  primary: ResultActKind | null;
  /** The one outline act beside it. */
  secondary: ResultActKind | null;
  /** The one line before the acts: why it can't be accepted yet. */
  line: string | null;
};

export function resultActsOf(facts: ResultActFacts): ResultActs {
  const request = facts.canRequest ? "request-changes" as const : null;
  const accept = facts.accept === null ? null : "accept" as const;
  if (facts.failed != null) {
    const checks = facts.runChecks && !facts.checksRunning ? "run-checks" as const : facts.checksRunning ? "checks-running" as const : null;
    return facts.failed.retry ? { primary: "retry", secondary: checks, line: null } : { primary: checks, secondary: null, line: null };
  }
  if (facts.need !== null) return { primary: facts.need, secondary: request, line: null };
  if (facts.next !== null) return { primary: facts.next, secondary: accept ?? request, line: null };
  // Can't be accepted yet: Accept is never the ink act, even when the feedback form isn't here.
  if (facts.blocked !== null) return { primary: request, secondary: accept, line: facts.blocked };
  if (facts.checksRunning) return { primary: "checks-running", secondary: accept ?? request, line: null };
  if (facts.accept === null) return { primary: null, secondary: request, line: null };
  if (facts.accept.ready) return { primary: "accept", secondary: request, line: null };
  if (facts.runChecks) return { primary: "run-checks", secondary: "accept", line: null };
  return { primary: "accept", secondary: request, line: null };
}
