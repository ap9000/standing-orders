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
    /** Which harness is spending — worn on the card when it is not claude. */
    provider: string | null;
    /** The machine's own phase (M5.4) — stamped at state-machine boundaries,
     * never parsed from a provider stream. Null before the first boundary. */
    phase: string | null;
  } | null;
  /** The newest unfinished run under the live claim — where a building card
   * links, so a glance lands on the build itself. Null before the run
   * starts (the card falls back to the task screen). */
  liveRunId?: number | null;
  /** The top-precedence live hold: operator > backoff > decision > incident. */
  hold: { ownerKind: "operator" | "decision" | "incident" | "backoff" | "contest"; until: string | null } | null;
  /** The task's open tournament, when agents raced (v14). Optional so
   * callers that predate tournaments stay valid; absent reads as none. */
  contest?: { id: number; state: string; agents: number; kind?: "race" | "comparison" } | null;
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
  /** Queue rank — 0 is filing order. Scheduling only; ranks compare
   * within one column, never across columns. */
  priority?: number;
  /** The worker this task is reserved for; null = the shared queue. */
  assignedRunner?: string | null;
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
  /** The task's queue rank, carried for the queued lane's sort and badge. */
  priority: number;
  /** The worker this card is reserved for; null = the shared queue. */
  assignedRunner: string | null;
};

/** ISO to the minute for chip text — "retrying 14:32". */
function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * Plain words for every hold owner — shared with the task page so "who is
 * holding this" reads the same everywhere. The internal owner tokens
 * ("contest") never reach a page; an unknown future owner degrades to the
 * generic word, never to its raw name.
 */
export const HOLD_OWNER_WORDS: Record<string, string> = {
  operator: "held by you",
  decision: "waiting on a question",
  incident: "stopped by an incident",
  backoff: "backing off after a failure",
  contest: "held by a tournament",
};

export function holdOwnerWords(ownerKind: string): string {
  return HOLD_OWNER_WORDS[ownerKind] ?? "held";
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
    priority: facts.priority ?? 0,
    assignedRunner: facts.assignedRunner ?? null,
  };

  const contest = facts.contest ?? null;
  if (facts.claim !== null) {
    const doing = facts.claim.role === "planner" ? "planning — " : facts.claim.role === "scout" ? "scouting — " : "";
    // A racing tournament wears its own chip: the operator should read
    // "several agents on this" where a lone build would name its runner.
    if (contest !== null && (contest.state === "dispatching" || contest.state === "racing")) {
      return {
        ...base,
        lane: "building",
        attempt: null,
        reason:
          contest.kind === "comparison"
            ? `comparison — ${contest.agents} agents building side by side`
            : `tournament — ${contest.agents} agents racing`,
      };
    }
    // A building card lands on the build itself when one exists — the
    // pop-in glance should reach the live page in one click. Before the
    // run starts (or for a tournament, which has no single run) the task
    // screen remains the destination.
    const liveRunId = facts.liveRunId ?? null;
    return {
      ...base,
      lane: "building",
      href: liveRunId === null ? base.href : `/r/${liveRunId}`,
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
  // A finished tournament outranks every generic reading of the same rows
  // (design round 2, finding 6): the claim is gone and the task still says
  // running, which the generic branches would misread as a vanished build.
  if (contest !== null) {
    const link = `/contest/${contest.id}`;
    if (contest.state === "pick-wait") {
      return { ...base, lane: "attention", href: link, reason: `${(contest.kind === "comparison" ? "comparison" : "tournament")} finished — ${contest.agents} results to compare`, stalledSince: facts.updatedAt };
    }
    if (contest.state === "exhausted") {
      return { ...base, lane: "attention", href: link, reason: `${(contest.kind === "comparison" ? "comparison" : "tournament")} ended with nothing to pick`, stalledSince: facts.updatedAt };
    }
    if (contest.state === "interrupted") {
      return { ...base, lane: "attention", href: link, reason: `${(contest.kind === "comparison" ? "comparison" : "tournament")} was interrupted — decide what happens next`, stalledSince: facts.updatedAt };
    }
    if (contest.state === "decision-wait") {
      // The open question already classified above; reaching here means it
      // was answered and an agent resumes on the next pass.
      return { ...base, lane: "building", reason: `${(contest.kind === "comparison" ? "comparison" : "tournament")} — an agent is resuming` };
    }
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
          : // A decision, incident, or tournament hold with no open item
            // above it is an orphan — say who holds it in plain words,
            // never the internal owner token.
            holdOwnerWords(facts.hold.ownerKind);
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
