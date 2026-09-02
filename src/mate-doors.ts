/**
 * The confirm doors (mate arc §2, ruling 7; v3 §9): a pending proposal —
 * the mate's, or a coordinator's over the gateway — becomes an act only
 * here, as the operator's own act through the plane's existing
 * primitives, in ONE transaction that re-proves everything the card was
 * rendered under. The console and the CLI both call these; the HTTP edge
 * adds csrf and the cookie, the CLI adds the password — neither adds
 * authority the door does not check itself.
 *
 * The door's answer is typed and rendered on the card: `done` with the
 * plain words of what happened, or `refused` with the reason the primitive
 * gave. A stale proposal (the queue moved, the hold changed hands, the
 * scope was rewritten, the decision answered) is a refusal, never a
 * silent re-read.
 */
import type { CoordinatorProposal, MateProposal, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { isVerifiedApprover, reproveApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { proposeGuarded } from "./scope.js";

export type ProposalKind = MateProposal["kind"];

export type DoorOutcome =
  | { ok: true; kind: ProposalKind; said: string; taskId: string | null }
  | { ok: false; kind: ProposalKind | null; reason: DoorRefusal; said: string };

export type DoorRefusal =
  | "standing"
  | "not-yours"
  | "ceiling-changed"
  | "not-pending"
  | "session-ended"
  | "turn-not-answered"
  | "not-confirmable"
  | "needs-confirm"
  | "stale"
  | "claimed"
  | "not-queued"
  | "contest-open"
  | "unknown-task"
  | "unknown-decision"
  | "already-answered"
  | "expired"
  | "outside-ceiling"
  | "refused";

export type DoorOptions = {
  /** The existing ceremony for an irreversible decision option: `confirm=yes`, typed explicitly (ruling 12). */
  confirm?: boolean;
  /** Which surface answered — recorded on the decision. Named by the caller, never defaulted (v3 review, finding 1). */
  via: "web" | "cli";
};

/** A coordinator proposal lives seven days (§9); the door refuses an older one whatever the sweep did (v3 review, finding 3). */
export const COORDINATOR_PROPOSAL_TTL_MS = 7 * 24 * 3_600_000;

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}
function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function payloadStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

/**
 * Confirm one of the mate's proposals as `who`. The whole check-and-act
 * is one transaction: brand and standing (re-proved inside); the
 * proposal's thread is this approver's; a LIVE session minted by this
 * generation under this ceiling; its turn answered; `pending →
 * confirming` CAS; the primitive; `confirming → confirmed | refused`.
 */
export function confirmMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date, options: DoorOptions): DoorOutcome {
  if (!isVerifiedApprover(who)) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" };
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" } as const;
    const proposal = store.getMateProposal(proposalId);
    if (proposal === null) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    const thread = store.getMateThread(proposal.thread);
    if (thread === null || thread.approver !== who.name) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    const session = store.activeMateSession(who.name, now);
    if (session === null || session.approverGeneration !== who.generation) {
      return { ok: false, kind: proposal.kind, reason: "session-ended", said: "the mate session this was proposed in has ended — its cards cannot be confirmed" } as const;
    }
    if (proposal.ceilingDigest !== who.ceilingDigest || session.ceilingDigest !== who.ceilingDigest) {
      return { ok: false, kind: proposal.kind, reason: "ceiling-changed", said: "the admitted projects changed since this was proposed — it cannot be confirmed" } as const;
    }
    const turn = store.getMateTurn(proposal.turn);
    if (turn === null || turn.state !== "answered") {
      return { ok: false, kind: proposal.kind, reason: "turn-not-answered", said: "this proposal's turn did not finish — it cannot be confirmed" } as const;
    }
    if (proposal.kind === "cancel") {
      return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "cancelling is armed on the task itself — open the task" } as const;
    }
    // An irreversible answer takes the explicit field BEFORE the CAS: a
    // missing confirmation leaves the card pending, not refused.
    const needsConfirm = proposal.kind === "answer" && proposal.payload["reversible"] === false && options.confirm !== true;
    if (needsConfirm) return { ok: false, kind: proposal.kind, reason: "needs-confirm", said: "an irreversible choice must be confirmed explicitly" } as const;
    if (!store.casMateProposal(proposalId, "pending", "confirming", who.name, null, now)) {
      return { ok: false, kind: proposal.kind, reason: "not-pending", said: "this proposal was already acted on" } as const;
    }
    const outcome = executeProposal(store, who, proposal.kind, proposal.payload, now, options);
    store.casMateProposal(proposalId, "confirming", outcome.ok ? "confirmed" : "refused", who.name, { ...outcome }, now);
    return outcome;
  });
}

/** The operator declines the mate's card: `pending → dismissed`. */
export function dismissMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): boolean {
  if (!isVerifiedApprover(who)) return false;
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return false;
    const proposal = store.getMateProposal(proposalId);
    const thread = proposal === null ? null : store.getMateThread(proposal.thread);
    if (proposal === null || thread === null || thread.approver !== who.name) return false;
    return store.casMateProposal(proposalId, "pending", "dismissed", who.name, null, now);
  });
}

/**
 * Confirm a coordinator's proposal (v3 §9) as `who`: any approver whose
 * ceiling admits the row's repo. One transaction: standing re-proved
 * inside; the repo inside this ceiling; `pending → confirming`; the shared
 * executor; `confirming → confirmed | refused`. No mate session is
 * involved — nothing here spends.
 */
export function confirmCoordinatorProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date, options: DoorOptions): DoorOutcome {
  if (!isVerifiedApprover(who)) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" };
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" } as const;
    const proposal = store.getCoordinatorProposal(proposalId);
    if (proposal === null || !who.repos.includes(proposal.repo)) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal in your projects" } as const;
    if (Date.parse(proposal.createdAt) + COORDINATOR_PROPOSAL_TTL_MS <= now.getTime()) {
      store.casCoordinatorProposal(proposalId, "pending", "expired", null, null, now);
      return { ok: false, kind: proposal.kind, reason: "expired", said: "this proposal is older than seven days — it expired" } as const;
    }
    if (proposal.kind === "cancel") {
      return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "cancelling is armed on the task itself — open the task" } as const;
    }
    const needsConfirm = proposal.kind === "answer" && proposal.payload["reversible"] === false && options.confirm !== true;
    if (needsConfirm) return { ok: false, kind: proposal.kind, reason: "needs-confirm", said: "an irreversible choice must be confirmed explicitly" } as const;
    if (!store.casCoordinatorProposal(proposalId, "pending", "confirming", who.name, null, now)) {
      return { ok: false, kind: proposal.kind, reason: "not-pending", said: "this proposal was already acted on" } as const;
    }
    const outcome = executeProposal(store, who, proposal.kind, proposal.payload, now, { ...options, scopeAuthor: "coordinator" });
    store.casCoordinatorProposal(proposalId, "confirming", outcome.ok ? "confirmed" : "refused", who.name, { ...outcome }, now);
    return outcome;
  });
}

export function dismissCoordinatorProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): boolean {
  if (!isVerifiedApprover(who)) return false;
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return false;
    const proposal = store.getCoordinatorProposal(proposalId);
    if (proposal === null || !who.repos.includes(proposal.repo)) return false;
    return store.casCoordinatorProposal(proposalId, "pending", "dismissed", who.name, null, now);
  });
}

/** Which door renders a coordinator proposal for this reader: the repo must be admitted. */
export function coordinatorProposalVisible(who: { repos: readonly string[] }, proposal: CoordinatorProposal): boolean {
  return who.repos.includes(proposal.repo);
}

/**
 * The shared executor: one kind, one payload, the operator's own act
 * through the primitive that owns it. Module-private (v3 review, finding
 * 1): only the two doors above reach it, and it re-proves the brand and
 * the standing itself — a structural caller executes nothing.
 */
function executeProposal(
  store: Store,
  actor: VerifiedApprover,
  kind: ProposalKind,
  payload: Record<string, unknown>,
  now: Date,
  options: DoorOptions & { scopeAuthor?: "mate" | "coordinator" },
): DoorOutcome {
  if (!isVerifiedApprover(actor) || !reproveApprover(store, actor).ok) return { ok: false, kind, reason: "standing", said: "your approver standing changed — sign in again" };
  const taskId = payloadString(payload, "task");
  const admitted = (repo: string | null): boolean => repo !== null && actor.repos.includes(repo);
  const refuse = (reason: DoorRefusal, said: string): DoorOutcome => ({ ok: false, kind, reason, said });

  if (kind === "task") {
    const repo = payloadString(payload, "repo");
    const title = payloadString(payload, "title");
    const goal = payloadString(payload, "goal");
    if (!admitted(repo) || title === null || goal === null) return refuse("outside-ceiling", "that project is not one of yours");
    const filed = fileTaskProposal(
      store,
      {
        title,
        repo: repo as string,
        goal,
        outOfScope: payloadString(payload, "not"),
        touches: payloadStrings(payload, "touches"),
        filedVia: "mate",
        proposedVia: "mate",
        admittedRepos: [...actor.repos],
      },
      now,
    );
    if (!filed.ok) return refuse("refused", `not filed: ${filed.message}`);
    return { ok: true, kind, said: `filed ${filed.id} — its scope still needs your approval`, taskId: filed.id };
  }

  if (kind === "answer") {
    const decisionId = payloadNumber(payload, "decision");
    const option = payloadString(payload, "option");
    const decision = decisionId === null ? null : store.getDecision(decisionId);
    if (decision === null || option === null) return refuse("unknown-decision", "no such decision");
    const run = store.getRun(decision.run);
    const ref = run === null ? null : store.refById(run.taskRef);
    if (ref === null || !admitted(ref.repo)) return refuse("unknown-decision", "no such decision in your projects");
    const chosen = decision.options.find(one => one.id === option);
    if (chosen === undefined) return refuse("stale", "that option no longer exists on the decision");
    // The proposal contract is "open": a decision past its deadline — swept
    // or not — is not answered through a card (v3 review, finding 7).
    if (decision.state === "answered") return refuse("already-answered", "already answered — somebody got there first");
    if (decision.state !== "open" || (decision.deadline !== null && Date.parse(decision.deadline) <= now.getTime())) {
      return refuse("stale", "this decision is no longer open — answer it on its own page if you still mean to");
    }
    if (!chosen.reversible && options.confirm !== true) return refuse("needs-confirm", "an irreversible choice must be confirmed explicitly");
    const answered = store.answerDecision({ id: decision.id, choice: chosen.id, by: actor.name, via: options.via }, now);
    // The same choice landed first from somewhere else: the decision keeps
    // its first answerer, and this card did not answer it (finding 5).
    if (!answered.ok || answered.duplicate === true) {
      return !answered.ok && answered.reason !== "already-answered"
        ? refuse("refused", `not answered: ${answered.reason}`)
        : refuse("already-answered", "already answered — somebody got there first");
    }
    return { ok: true, kind, said: `decision #${decision.id} answered: ${chosen.label}`, taskId: ref.externalId };
  }

  if (taskId === null) return refuse("unknown-task", "no such task");
  const ref = store.lookupRef(taskId);
  if (ref === null || !admitted(ref.repo)) return refuse("unknown-task", "no such task in your projects");

  // The place the proposer saw must be the place the task holds now
  // (round-2 ruling 10; round-3 ruling 6): the revision alone misses a
  // neighbour leaving the queue by a state change.
  const placeUnchanged = (): boolean => {
    const here = store.queuePosition(taskId);
    const sawPosition = payloadNumber(payload, "position");
    const sawColumn = payload["column"];
    return here !== null && here.position === sawPosition && (here.column ?? null) === (typeof sawColumn === "string" ? sawColumn : null);
  };

  if (kind === "next") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    if (sawRevision === null || sawRevision !== store.queueRevision() || !placeUnchanged()) return refuse("stale", "the queue moved since this was proposed — look again");
    const moved = store.moveTaskNext(taskId, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: `${taskId} moved to the front of its column`, taskId };
  }

  if (kind === "reserve") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    const worker = payload["worker"];
    if (sawRevision === null || (worker !== null && typeof worker !== "string")) return refuse("stale", "this proposal is missing what it saw");
    if (!placeUnchanged()) return refuse("stale", "the queue moved since this was proposed — look again");
    const moved = store.moveTask({ taskId, toRunner: worker as string | null, beforeTaskId: null, queueRevision: sawRevision }, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: worker === null ? `${taskId} released to the shared queue` : `${taskId} reserved for ${worker as string}`, taskId };
  }

  if (kind === "hold") {
    const reason = payloadString(payload, "reason");
    if (reason === null) return refuse("refused", "this proposal carries no reason");
    const standing = store.activeHolds(ref.id, now).find(one => one.ownerKind === "operator") ?? null;
    const sawHold = payload["sawHold"];
    if ((standing?.id ?? null) !== (typeof sawHold === "number" ? sawHold : null)) {
      return refuse("stale", "the hold on this task changed since this was proposed — look again");
    }
    store.hold(ref.id, reason, null, now);
    return { ok: true, kind, said: `${taskId} held: ${reason}`, taskId };
  }

  if (kind === "unhold") {
    const holdId = payloadNumber(payload, "holdId");
    const standing = store.activeHolds(ref.id, now).find(one => one.ownerKind === "operator") ?? null;
    if (standing === null || standing.id !== holdId) return refuse("stale", "that hold is no longer the one standing — look again");
    store.unhold(ref.id);
    return { ok: true, kind, said: `${taskId} released from its hold`, taskId };
  }

  if (kind === "scope") {
    const goal = payloadString(payload, "goal");
    if (goal === null) return refuse("refused", "this proposal carries no goal");
    const proposed = proposeGuarded(store, {
      taskId,
      goal,
      outOfScope: payloadString(payload, "not"),
      touches: payloadStrings(payload, "touches"),
      sawDigest: payloadString(payload, "sawDigest"),
      taskRef: ref.id,
      proposedVia: options.scopeAuthor ?? "mate",
      now,
    });
    if (!proposed.ok) return refuseFromReason(kind, proposed.reason);
    return { ok: true, kind, said: `${taskId}'s scope rewritten — approve it with your password on the task`, taskId };
  }

  return refuse("not-confirmable", "this kind of proposal has no door");
}

function refuseFromReason(kind: ProposalKind, reason: string): DoorOutcome {
  const known: Record<string, { reason: DoorRefusal; said: string }> = {
    stale: { reason: "stale", said: "the queue moved since this was proposed — look again" },
    changed: { reason: "stale", said: "the scope was rewritten since this was proposed — look again" },
    claimed: { reason: "claimed", said: "this task is being built right now" },
    "not-queued": { reason: "not-queued", said: "only queued work can move — this task is not waiting in the queue" },
    "contest-open": { reason: "contest-open", said: "a tournament is running on this task — let it finish first" },
    "unknown-task": { reason: "unknown-task", said: "no such task" },
  };
  const typed = known[reason];
  return typed === undefined ? { ok: false, kind, reason: "refused", said: `refused: ${reason}` } : { ok: false, kind, ...typed };
}
