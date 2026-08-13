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
  /** Planning mode: requested = a planner will run; drafted = review it. */
  plan: "requested" | "drafted" | null;
  /** First line of the scope's goal — the promise a queued card shows. */
  goal: string | null;
  /** An unanswered decision's id — open or expired; expiry never answers. */
  openDecisionId: number | null;
  /** The same decision's question and birth — fetched together with the
   * id so all three name one decision (Codex round 2, finding 13). */
  question: string | null;
  decisionCreatedAt: string | null;
  openIncidents: number;
  /** Oldest unresolved incident — the honest stall anchor for stopped work. */
  oldestIncidentAt: string | null;
  /** The newest live claim, with its run's provenance when a run exists. A
   * claim legitimately precedes its run (finding 7) — every run field is
   * nullable and the card says "preparing" until they arrive. */
  claim: {
    runner: string;
    claimedAt: string;
    model: string | null;
    branch: string | null;
    worktree: string | null;
    /** The run's role when one exists — a planning session reads differently. */
    role: string | null;
  } | null;
  /** The top-precedence live hold: operator > backoff > decision > incident. */
  hold: { ownerKind: "operator" | "decision" | "incident" | "backoff"; until: string | null } | null;
  /** The first blocker that is not done, when one exists. */
  unmetDependency: string | null;
  /** That blocker's state — pre-redacted by the caller to null when the
   * blocker's repo is outside the ceiling (Codex round 2, finding 12);
   * the classifier never learns what it must not say. */
  blockerState: string | null;
  /** The first required capability not currently verified, as "kind:name". */
  missingRequirement: string | null;
  /** The standing order this task is an instance of, when it is one. The
   * board keeps instances in their track row — they enter the main lanes
   * only when they need a person, wearing the routine's name. */
  routineId: number | null;
  routineName: string | null;
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
  /** When this stall began — attention cards only; the lane sorts by it. */
  stalledSince: string | null;
  /** The live attempt's ordinal when earlier ones failed — building only. */
  attempt: number | null;
  overdue: boolean;
  /** The routine this card is an instance of — the chip it wears in lanes. */
  routineName: string | null;
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
    stalledSince: null as string | null,
    attempt: null as number | null,
    overdue: false,
    routineName: facts.routineName,
  };

  if (facts.claim !== null) {
    const doing = facts.claim.role === "planner" ? "planning — " : "";
    return {
      ...base,
      lane: "building",
      attempt: facts.strikes > 0 ? facts.strikes + 1 : null,
      reason:
        facts.claim.model === null && facts.claim.branch === null
          ? `${doing}${facts.claim.runner} · preparing workspace`
          : `${doing}${facts.claim.runner}`,
    };
  }
  if (facts.openDecisionId !== null) {
    // The question is the content — the generic verb only when the
    // snapshot could not carry it.
    return {
      ...base,
      lane: "attention",
      reason: facts.question ?? "answer a question",
      href: `/d/${facts.openDecisionId}`,
      stalledSince: facts.decisionCreatedAt ?? facts.updatedAt,
    };
  }
  if (facts.state === "failed" || facts.openIncidents > 0) {
    return {
      ...base,
      lane: "attention",
      stalledSince: facts.oldestIncidentAt ?? facts.updatedAt,
      reason:
        facts.openIncidents > 0
          ? `stopped — ${facts.openIncidents} incident${facts.openIncidents > 1 ? "s" : ""}`
          : `failed${facts.strikes > 0 ? ` after ${facts.strikes} attempt${facts.strikes > 1 ? "s" : ""}` : ""}`,
    };
  }
  if (facts.plan === "drafted" && !facts.approved) {
    // The planner concluded; the negotiation waits on the operator.
    return { ...base, lane: "attention", reason: "review the plan", stalledSince: facts.updatedAt };
  }
  if (facts.plan !== "requested") {
    if (!facts.hasScope) {
      return { ...base, lane: "attention", reason: "write its scope", stalledSince: facts.updatedAt };
    }
    if (!facts.approved) {
      return { ...base, lane: "attention", reason: "approve its scope", stalledSince: facts.updatedAt };
    }
  }
  if (facts.state === "running") {
    // Running with no live claim: the build vanished out from under the
    // state machine (reaped, or the claim expired mid-flight). A repair
    // card, not a silent omission (finding 1).
    return { ...base, lane: "attention", reason: "build vanished — needs repair", stalledSince: facts.updatedAt };
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
    // The blocker's own state changes what waiting means: behind a build
    // that is running, this is patience; behind one that failed, it is a
    // problem wearing a calm lane.
    const doing =
      facts.blockerState === null
        ? ""
        : facts.blockerState === "running"
          ? " — building now"
          : ` — ${facts.blockerState}`;
    return { ...base, lane: "waiting", reason: `waits on ${facts.unmetDependency}${doing}` };
  }
  if (facts.missingRequirement !== null) {
    return { ...base, lane: "waiting", reason: `needs ${facts.missingRequirement}` };
  }
  // Task-local prerequisites all satisfied. Fleet-wide constraints (worker
  // capacity, provider quota, the attention budget) are deliberately not
  // per-card claims — the board cannot know which runner would take this
  // task, so the queued lane's header speaks for the fleet (finding 6).
  // The card at this stage IS the promise: show the goal, not "ready" —
  // unless the promise is still being negotiated, in which case say so.
  if (facts.plan === "requested") {
    return { ...base, lane: "queued", reason: "planning next" };
  }
  return { ...base, lane: "queued", reason: facts.goal ?? "ready" };
}
