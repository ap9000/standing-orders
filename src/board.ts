/**
 * The board's lane classifier — one exhaustive precedence order, applied to
 * one database snapshot (Codex board review, findings 1 and 2).
 *
 * Lanes are the pipeline read left to right: attention → queued → waiting →
 * building, with completed work joining from its own query. The chain below
 * is total (the final else is queued) and disjoint (it is an if/else chain),
 * so a task appears on the board exactly once — a parked task is attention,
 * never also "waiting" through the hold its own decision placed.
 */

export type BoardLane = "attention" | "queued" | "waiting" | "building";

/** Everything one task contributes to the board, fetched in one snapshot. */
export type BoardFacts = {
  taskId: string;
  title: string;
  /** Where the task is placed — null for work nobody has placed yet. */
  repo: string | null;
  state: "queued" | "running" | "failed";
  updatedAt: string;
  strikes: number;
  hasScope: boolean;
  approved: boolean;
  /** An unanswered decision's id — open or expired; expiry never answers. */
  openDecisionId: number | null;
  openIncidents: number;
  /** The newest live claim, with its run's provenance when a run exists. A
   * claim legitimately precedes its run (finding 7) — every run field is
   * nullable and the card says "preparing" until they arrive. */
  claim: {
    runner: string;
    claimedAt: string;
    model: string | null;
    branch: string | null;
    worktree: string | null;
  } | null;
  /** The top-precedence live hold: operator > backoff > decision > incident. */
  hold: { ownerKind: "operator" | "decision" | "incident" | "backoff"; until: string | null } | null;
  /** The first blocker that is not done, when one exists. */
  unmetDependency: string | null;
  /** The first required capability not currently verified, as "kind:name". */
  missingRequirement: string | null;
};

export type BoardCard = {
  lane: BoardLane;
  taskId: string;
  title: string;
  repo: string | null;
  /** One honest phrase for the card's chip — why it sits in this lane. */
  reason: string;
  /** Where the card's link should land. */
  href: string;
  claim: BoardFacts["claim"];
  overdue: boolean;
};

/** ISO to the minute for chip text — "retrying 14:32". */
function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

export function classify(facts: BoardFacts, now: Date): BoardCard {
  const base = {
    taskId: facts.taskId,
    title: facts.title,
    repo: facts.repo,
    href: `/t/${encodeURIComponent(facts.taskId)}`,
    claim: facts.claim,
    overdue: false,
  };

  if (facts.claim !== null) {
    return {
      ...base,
      lane: "building",
      reason:
        facts.claim.model === null && facts.claim.branch === null
          ? `${facts.claim.runner} · preparing workspace`
          : facts.claim.runner,
    };
  }
  if (facts.openDecisionId !== null) {
    return { ...base, lane: "attention", reason: "answer a question", href: `/d/${facts.openDecisionId}` };
  }
  if (facts.state === "failed" || facts.openIncidents > 0) {
    return {
      ...base,
      lane: "attention",
      reason:
        facts.openIncidents > 0
          ? `stopped — ${facts.openIncidents} incident${facts.openIncidents > 1 ? "s" : ""}`
          : `failed${facts.strikes > 0 ? ` after ${facts.strikes} attempt${facts.strikes > 1 ? "s" : ""}` : ""}`,
    };
  }
  if (!facts.hasScope) {
    return { ...base, lane: "attention", reason: "write its scope" };
  }
  if (!facts.approved) {
    return { ...base, lane: "attention", reason: "approve its scope" };
  }
  if (facts.state === "running") {
    // Running with no live claim: the build vanished out from under the
    // state machine (reaped, or the claim expired mid-flight). A repair
    // card, not a silent omission (finding 1).
    return { ...base, lane: "attention", reason: "build vanished — needs repair" };
  }
  if (facts.hold !== null) {
    const until = facts.hold.until;
    const reason =
      facts.hold.ownerKind === "operator"
        ? "held by you"
        : facts.hold.ownerKind === "backoff"
          ? until === null
            ? "backing off"
            : until <= now.toISOString()
              ? "retrying now"
              : `retrying ${clockOf(until)}`
          : // A decision or incident hold with no open decision or incident
            // above it is an orphan — name the owner rather than guess.
            `held (${facts.hold.ownerKind})`;
    return { ...base, lane: "waiting", reason };
  }
  if (facts.unmetDependency !== null) {
    return { ...base, lane: "waiting", reason: `waits on ${facts.unmetDependency}` };
  }
  if (facts.missingRequirement !== null) {
    return { ...base, lane: "waiting", reason: `needs ${facts.missingRequirement}` };
  }
  // Task-local prerequisites all satisfied. Fleet-wide constraints (worker
  // capacity, provider quota, the attention budget) are deliberately not
  // per-card claims — the board cannot know which runner would take this
  // task, so the queued lane's header speaks for the fleet (finding 6).
  return { ...base, lane: "queued", reason: "ready" };
}
