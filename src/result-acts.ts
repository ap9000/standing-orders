/** The result page's acts (2026-10-02), chosen in one place: exactly one ink
 * act, the one that resolves the result's state, and never navigation; at
 * most one outline act beside it. A result that can't be accepted says why
 * in one line before them.
 *
 *   everything met                      → Accept
 *   checks didn't run, a check exists   → Run checks, then Accept without checks
 *   report and changes disagree,
 *   or the proof is refuted             → Request changes, then Accept (as allowed)
 *   a Needs you form resolves it        → that form (Build again, Confirm it stopped)
 *   saved notes or a failing PR         → Revise / Draft a repair task
 *
 * Accepting means what it always meant: the same forms post to the same
 * endpoints. This only decides which one is ink. */

export type ResultActKind = "accept" | "run-checks" | "request-changes" | "rebuild" | "confirm-stopped" | "revise" | "draft-repair";

export type ResultActFacts = {
  /** An Accept this page can post (Mark complete, or the person's acceptance); `ready`: every requirement met and checks passed. */
  accept: { ready: boolean } | null;
  /** The checks didn't run, the project has one, and this person may run it. */
  runChecks: boolean;
  /** Why it can't be accepted yet (cantAcceptYetOf), or null. */
  blocked: string | null;
  /** The feedback form is on this page. */
  canRequest: boolean;
  /** A Needs you form that resolves it here. */
  need: "rebuild" | "confirm-stopped" | null;
  /** Saved notes ready to become a revision, or a failing pull request's repair. */
  next: "revise" | "draft-repair" | null;
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
  if (facts.need !== null) return { primary: facts.need, secondary: request, line: null };
  if (facts.next !== null) return { primary: facts.next, secondary: accept ?? request, line: null };
  if (facts.blocked !== null) {
    return request !== null ? { primary: request, secondary: accept, line: facts.blocked } : { primary: accept, secondary: null, line: facts.blocked };
  }
  if (facts.accept === null) return { primary: null, secondary: request, line: null };
  if (facts.accept.ready) return { primary: "accept", secondary: request, line: null };
  if (facts.runChecks) return { primary: "run-checks", secondary: "accept", line: null };
  return { primary: "accept", secondary: request, line: null };
}
