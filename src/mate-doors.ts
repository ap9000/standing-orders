/**
 * The mate's confirm doors (mate arc §2, ruling 7): a pending proposal
 * becomes an act only here, as the operator's own act through the plane's
 * existing primitives, in ONE transaction that re-proves everything the
 * card was rendered under. The console and the CLI both call this; the
 * HTTP edge adds csrf and the cookie, the CLI adds the password — neither
 * adds authority the door does not check itself.
 *
 * The door's answer is typed and rendered on the card: `done` with the
 * plain words of what happened, or `refused` with the reason the primitive
 * gave. A stale proposal (the queue moved, the hold changed hands, the
 * scope was rewritten) is a refusal, never a silent re-read.
 */
import type { MateProposal, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { isVerifiedApprover, reproveApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { proposeGuarded } from "./scope.js";

export type DoorOutcome =
  | { ok: true; kind: MateProposal["kind"]; said: string; taskId: string | null }
  | { ok: false; kind: MateProposal["kind"] | null; reason: DoorRefusal; said: string };

export type DoorRefusal =
  | "standing"
  | "not-yours"
  | "ceiling-changed"
  | "not-pending"
  | "turn-not-answered"
  | "not-confirmable"
  | "stale"
  | "claimed"
  | "not-queued"
  | "contest-open"
  | "unknown-task"
  | "outside-ceiling"
  | "refused";

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
 * Confirm one proposal as `who`. The whole check-and-act is one
 * transaction: brand and standing; the proposal's thread is this
 * approver's; its turn answered; its ceiling is the surface's; `pending →
 * confirming` CAS; the primitive; `confirming → confirmed | refused`.
 */
export function confirmMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): DoorOutcome {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok) {
    return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" };
  }
  return store.transact(() => {
    const proposal = store.getMateProposal(proposalId);
    if (proposal === null) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    const thread = store.getMateThread(proposal.thread);
    if (thread === null || thread.approver !== who.name) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    if (proposal.ceilingDigest !== who.ceilingDigest) {
      return { ok: false, kind: proposal.kind, reason: "ceiling-changed", said: "the admitted projects changed since this was proposed — it cannot be confirmed" } as const;
    }
    const turn = store.getMateTurn(proposal.turn);
    if (turn === null || turn.state !== "answered") {
      return { ok: false, kind: proposal.kind, reason: "turn-not-answered", said: "this proposal's turn did not finish — it cannot be confirmed" } as const;
    }
    if (proposal.kind === "cancel") {
      return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "cancelling is armed on the task itself — open the task" } as const;
    }
    if (!store.casMateProposal(proposalId, "pending", "confirming", who.name, null, now)) {
      return { ok: false, kind: proposal.kind, reason: "not-pending", said: "this proposal was already acted on" } as const;
    }
    const outcome = execute(store, who, proposal, now);
    store.casMateProposal(proposalId, "confirming", outcome.ok ? "confirmed" : "refused", who.name, { ...outcome }, now);
    return outcome;
  });
}

/** The operator declines the card: `pending → dismissed`. */
export function dismissMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): boolean {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok) return false;
  return store.transact(() => {
    const proposal = store.getMateProposal(proposalId);
    const thread = proposal === null ? null : store.getMateThread(proposal.thread);
    if (proposal === null || thread === null || thread.approver !== who.name) return false;
    return store.casMateProposal(proposalId, "pending", "dismissed", who.name, null, now);
  });
}

function execute(store: Store, who: VerifiedApprover, proposal: MateProposal, now: Date): DoorOutcome {
  const kind = proposal.kind;
  const payload = proposal.payload;
  const taskId = payloadString(payload, "task");
  const admitted = (repo: string | null): boolean => repo !== null && who.repos.includes(repo);
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
        admittedRepos: [...who.repos],
      },
      now,
    );
    if (!filed.ok) return refuse("refused", `not filed: ${filed.message}`);
    return { ok: true, kind, said: `filed ${filed.id} — its scope still needs your approval`, taskId: filed.id };
  }

  if (taskId === null) return refuse("unknown-task", "no such task");
  const ref = store.lookupRef(taskId);
  if (ref === null || !admitted(ref.repo)) return refuse("unknown-task", "no such task in your projects");

  if (kind === "next") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    if (sawRevision === null || sawRevision !== store.queueRevision()) return refuse("stale", "the queue moved since this was proposed — look again");
    const moved = store.moveTaskNext(taskId, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: `${taskId} moved to the front of its column`, taskId };
  }

  if (kind === "reserve") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    const worker = payload["worker"];
    if (sawRevision === null || (worker !== null && typeof worker !== "string")) return refuse("stale", "this proposal is missing what it saw");
    const moved = store.moveTask({ taskId, toRunner: worker as string | null, beforeTaskId: null, queueRevision: sawRevision }, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: worker === null ? `${taskId} released to the shared queue` : `${taskId} reserved for ${worker as string}`, taskId };
  }

  if (kind === "hold") {
    const reason = payloadString(payload, "reason");
    if (reason === null) return refuse("refused", "this proposal carries no reason");
    // The hold the mate saw must be the hold that stands now (round-2
    // ruling 10): a hand-placed hold is never overwritten by model text.
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
    const sawDigest = payloadString(payload, "sawDigest");
    const proposed = proposeGuarded(store, {
      taskId,
      goal,
      outOfScope: payloadString(payload, "not"),
      touches: payloadStrings(payload, "touches"),
      sawDigest,
      taskRef: ref.id,
      proposedVia: "mate",
      now,
    });
    if (!proposed.ok) return refuseFromReason(kind, proposed.reason);
    return { ok: true, kind, said: `${taskId}'s scope rewritten — approve it with your password on the task`, taskId };
  }

  return refuse("not-confirmable", "this kind of proposal has no door");
}

function refuseFromReason(kind: MateProposal["kind"], reason: string): DoorOutcome {
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
