/**
 * Tournament orchestration (stage 3; the three review rounds' findings are
 * the spec). What lives here and what deliberately does not:
 *
 *   - the race digest and the JOINT approval digest (finding 31): the
 *     approval a person gives covers the scope AND the race terms as one
 *     hash — editing either strands it;
 *   - planning: turning asked-for agents and dollars into approved-terms
 *     rows, refusing anything the money machinery cannot bound (finding
 *     24: eligibility comes from the capability matrix, budgets from the
 *     pinned prices, and every agent carries its own overrun reserve);
 *   - admission: ONE transaction that proves everything or admits nothing
 *     (finding 3/19/22) — the claim, the digests re-derived from stored
 *     rows, worker-process slots, quota by distinct key, the money
 *     arithmetic — then creates the contest skeleton;
 *   - the ready barrier (finding 19): worktrees and setup finish for every
 *     agent before anything spawns; the barrier is a state CAS;
 *   - child finalization (findings 1/17): an agent finishing NEVER touches
 *     the task, the parent claim, or publication — it writes its own row
 *     and asks, inside the same transaction, whether the whole tournament
 *     just reached its boundary (maybeAggregate);
 *   - crash recovery (finding 27): a daemon death mid-dispatch or mid-race
 *     converts the contest to 'interrupted' by the same generation CAS the
 *     finalizers use — whoever wins, wins alone — and never charges an
 *     agent that never started.
 *
 * NOT here: the pick and abandon ceremonies (stage 5), decision-wait
 * re-admission and checkout custody (stage 4), cleanup (stage 6).
 */

import { createHash } from "node:crypto";
import { release } from "./claim.js";
import { buildPriceOf, oneCallTailMicrousd, BUILD_PRICE_VERSION } from "./pricing.js";
import { MONEY_CAPABILITIES } from "./provider.js";
import type { Contest, Contestant, ContestState, Store, TournamentTerms } from "./store.js";

export const MIN_AGENTS = 2;
export const MAX_AGENTS = 4;

export type RaceAgent = { provider: string; model: string; repairModel: string };

// ---------------------------------------------------------------- digests

/** Canonical and order-preserving: the agents race in the order approved. */
export function raceDigestOf(terms: {
  agents: readonly RaceAgent[];
  perAgentBudgetMicrousd: number;
  totalBudgetMicrousd: number;
  priceVersion: number;
  publicationPolicy: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    agents: terms.agents.map(agent => [agent.provider, agent.model, agent.repairModel]),
    per: terms.perAgentBudgetMicrousd,
    total: terms.totalBudgetMicrousd,
    prices: terms.priceVersion,
    retries: 0,
    publication: terms.publicationPolicy,
  });
  return createHash("sha256").update(`race/v1\u0000${canonical}`).digest("hex");
}

/** tournament-approval/v1 (finding 31): one yes covers both documents. */
export function jointApprovalDigest(scopeDigest: string, raceDigest: string): string {
  return createHash("sha256").update(`tournament-approval/v1\u0000${scopeDigest}\u0000${raceDigest}`).digest("hex");
}

// ---------------------------------------------------------------- planning

export type TournamentPlan = {
  agents: RaceAgent[];
  perAgentBudgetMicrousd: number;
  /** The DEAREST agent's one-call overrun — shown on the approval card. */
  overrunReserveMicrousd: number;
  /** Per agent, its own reserve — what its contestant row will carry. */
  perAgentReserveMicrousd: number[];
  totalBudgetMicrousd: number;
  priceVersion: number;
  publicationPolicy: string;
  raceDigest: string;
};

export function planTournament(input: {
  agents: { provider: string; model: string; repairModel?: string }[];
  perAgentBudgetUsd: number;
  totalBudgetUsd: number;
  publicationPolicy?: string;
}): { ok: true; plan: TournamentPlan } | { ok: false; reason: string; message: string } {
  if (input.agents.length < MIN_AGENTS || input.agents.length > MAX_AGENTS) {
    return { ok: false, reason: "bad-count", message: `a tournament races ${MIN_AGENTS} to ${MAX_AGENTS} agents` };
  }
  if (!Number.isFinite(input.perAgentBudgetUsd) || input.perAgentBudgetUsd <= 0) {
    return { ok: false, reason: "bad-budget", message: "each agent needs a positive dollar budget" };
  }
  if (!Number.isFinite(input.totalBudgetUsd) || input.totalBudgetUsd <= 0) {
    return { ok: false, reason: "bad-budget", message: "the tournament needs a positive total dollar budget" };
  }
  const agents: RaceAgent[] = [];
  const reserves: number[] = [];
  for (const asked of input.agents) {
    const capability = MONEY_CAPABILITIES[asked.provider as keyof typeof MONEY_CAPABILITIES];
    if (capability === undefined || !capability.tournamentEligible) {
      return {
        ok: false,
        reason: "provider-ineligible",
        message: capability?.whyIneligible ?? `${asked.provider} cannot hold a dollar cap, so it cannot race`,
      };
    }
    const model = asked.model;
    const repairModel = asked.repairModel ?? model;
    for (const candidate of [model, repairModel]) {
      if (buildPriceOf(candidate) === null) {
        return {
          ok: false,
          reason: "unpriced-model",
          message: `${candidate} has no pinned price — a budget nobody can compute is not a budget`,
        };
      }
    }
    const tail = oneCallTailMicrousd(model);
    const repairTail = oneCallTailMicrousd(repairModel);
    if (tail === null || repairTail === null) {
      return { ok: false, reason: "unpriced-model", message: `${model} has no pinned overrun price` };
    }
    agents.push({ provider: asked.provider, model, repairModel });
    reserves.push(Math.max(tail, repairTail));
  }
  const perAgentBudgetMicrousd = Math.round(input.perAgentBudgetUsd * 1_000_000);
  const totalBudgetMicrousd = Math.round(input.totalBudgetUsd * 1_000_000);
  const committed = reserves.reduce((sum, reserve) => sum + perAgentBudgetMicrousd + reserve, 0);
  if (committed > totalBudgetMicrousd) {
    return {
      ok: false,
      reason: "over-total",
      message:
        `the true worst case is $${(committed / 1_000_000).toFixed(2)} ` +
        `(each agent's budget plus its overrun reserve) — the total must cover it`,
    };
  }
  const plan: TournamentPlan = {
    agents,
    perAgentBudgetMicrousd,
    overrunReserveMicrousd: Math.max(...reserves),
    perAgentReserveMicrousd: reserves,
    totalBudgetMicrousd,
    priceVersion: BUILD_PRICE_VERSION,
    publicationPolicy: input.publicationPolicy ?? "none",
    raceDigest: "",
  };
  plan.raceDigest = raceDigestOf(plan);
  return { ok: true, plan };
}

/** Unique per tournament — retained loser branches never collide. */
export function contestBranch(taskId: string, contestId: number, ordinal: number): string {
  return `standing-orders/${taskId}/contest-${contestId}/c${ordinal}`;
}

// ---------------------------------------------------------------- admission

export type AdmissionRefusal = {
  ok: false;
  reason:
    | "no-terms"
    | "not-approved"
    | "digest-drift"
    | "duplicate-provider-model"
    | "quota"
    | "capacity"
    | "contest-open";
  message: string;
};

/**
 * All or none (finding 3): every check inside one reentrant transaction
 * with the claim acquisition the caller already made — the caller passes
 * its live claim, and a refusal here obliges the caller to release it.
 */
export function admitContest(
  store: Store,
  args: {
    taskId: string;
    taskRef: number;
    runner: string;
    leaseId: string;
    incarnation: string | null;
    scopeDigest: string;
    scopeApproved: boolean;
    /** slots-based capacity, enforced only in 'processes' mode (finding 26). */
    capacity: number | null;
    /** 'exhausted'/'cooling' answers per (provider, model) — the caller reads
     * quota state; grouping and multiplicity rules live here (finding 22). */
    quotaBlocked: (provider: string, model: string) => string | null;
  },
  now: Date,
): { ok: true; contestId: number; contestantIds: number[]; slotIds: number[] } | AdmissionRefusal {
  return store.transact(() => {
    if (store.openContestFor(args.taskRef) !== null) {
      return { ok: false as const, reason: "contest-open" as const, message: "a tournament is already running on this task" };
    }
    const terms = store.activeTournamentTerms(args.taskRef);
    if (terms === null) {
      return { ok: false as const, reason: "no-terms" as const, message: "no tournament terms are filed for this task" };
    }
    // Re-derive, never trust columns (the H1 precedent): the stored digest
    // must equal the digest of the stored terms, and the approval must
    // bind exactly that digest — plus the scope's own approval.
    const derived = raceDigestOf(terms);
    if (derived !== terms.raceDigest) {
      return { ok: false as const, reason: "digest-drift" as const, message: "the stored race terms do not match their own fingerprint" };
    }
    if (!args.scopeApproved || terms.approvedDigest !== terms.raceDigest) {
      return { ok: false as const, reason: "not-approved" as const, message: "the tournament terms await approval" };
    }
    // Quota, grouped by distinct key; a half-open key may appear ONCE.
    const seen = new Map<string, number>();
    for (const agent of terms.agents) {
      const key = `${agent.provider}\u0000${agent.model}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      const [provider = "", model = ""] = key.split("\u0000");
      const blocked = args.quotaBlocked(provider, model);
      if (blocked === "half-open" && count > 1) {
        return {
          ok: false as const,
          reason: "duplicate-provider-model" as const,
          message: `${provider} · ${model} is easing back from a limit — one probe exists, and this tournament asks for ${count}`,
        };
      }
      if (blocked !== null && blocked !== "half-open") {
        return { ok: false as const, reason: "quota" as const, message: `${provider} · ${model} is ${blocked} — nothing was started` };
      }
    }
    // Worker-process capacity (processes mode only; 'tasks' mode keeps the
    // claim-counted contract untouched).
    if (args.capacity !== null && store.liveSlotCount(args.runner) + terms.n > args.capacity) {
      return {
        ok: false as const,
        reason: "capacity" as const,
        message: `this machine runs ${args.capacity} worker processes at most — ${terms.n} more will not fit right now`,
      };
    }
    const contestId = store.createContest(
      { taskRef: args.taskRef, terms: terms.id, scopeDigest: args.scopeDigest, raceDigest: terms.raceDigest },
      now,
    );
    store.stampContestLease(contestId, args.leaseId, args.runner, args.incarnation);
    const reserves = perAgentReserves(terms);
    const contestantIds = store.createContestants(
      contestId,
      terms.agents.map((agent, index) => ({
        provider: agent.provider,
        model: agent.model,
        repairModel: agent.repairModel,
        branch: contestBranch(args.taskId, contestId, index + 1),
        budgetMicrousd: terms.perAgentBudgetMicrousd,
        reserveMicrousd: reserves[index] ?? terms.overrunReserveMicrousd,
      })),
    );
    const slotIds = store.reserveExecutionSlots(args.runner, terms.n, now);
    slotIds.forEach((slot, index) => {
      const contestant = contestantIds[index];
      if (contestant !== undefined) store.assignSlotContestant(slot, contestant);
    });
    return { ok: true as const, contestId, contestantIds, slotIds };
  });
}

function perAgentReserves(terms: TournamentTerms): number[] {
  return terms.agents.map(agent => {
    const tail = oneCallTailMicrousd(agent.model);
    const repairTail = oneCallTailMicrousd(agent.repairModel);
    return Math.max(tail ?? terms.overrunReserveMicrousd, repairTail ?? terms.overrunReserveMicrousd);
  });
}

// ---------------------------------------------------------------- barrier

/** Everything prepared, nothing spawned: pending→ready per agent, then one
 * dispatching→racing CAS. Any failure leaves the contest for recovery. */
export function crossReadyBarrier(
  store: Store,
  contest: Contest,
  contestantIds: readonly number[],
): boolean {
  return store.transact(() => {
    for (const id of contestantIds) {
      const row = store.getContestant(id);
      if (row === null || !store.casContestantState(id, ["pending"], "ready", row.generation)) return false;
    }
    return store.casContestState(contest.id, ["dispatching"], "racing", contest.generation);
  });
}

// ---------------------------------------------------------------- children

export type ContestantOutcome = "built" | "failed" | "parked" | "stopped";

/**
 * The child finalizer (findings 1/17): writes the agent's own row, frees
 * its worker-process slot, and — inside this same transaction — asks
 * whether the tournament just reached its boundary. The parent claim and
 * the task are NEVER touched here; only the aggregate boundary releases
 * the claim, exactly once, by CAS.
 */
export function finalizeContestant(
  store: Store,
  args: {
    contestId: number;
    contestantId: number;
    runId: number;
    outcome: ContestantOutcome;
    /** Micro-dollars the provider reported for this invocation; null latches. */
    measuredMicrousd: number | null;
    slotId: number | null;
  },
  now: Date,
): { aggregated: ContestState | null } {
  return store.transact(() => {
    const contestant = store.getContestant(args.contestantId);
    if (contestant === null) return { aggregated: null };
    store.casContestantState(args.contestantId, ["building", "ready"], args.outcome, contestant.generation);
    store.releaseContestantRun(args.contestantId, args.runId);
    if (args.slotId !== null) store.releaseExecutionSlot(args.slotId, now);
    if (args.measuredMicrousd !== null) store.recordContestantSpend(args.contestantId, args.measuredMicrousd);
    else store.latchContestantUnknownSpend(args.contestantId);
    return { aggregated: maybeAggregate(store, args.contestId, now) };
  });
}

/**
 * The aggregate boundary — runs INSIDE a child/recovery transaction. When
 * no agent remains active: parked-with-open-question → 'decision-wait';
 * at least one 'built' → 'pick-wait'; none → 'exhausted'. The parent
 * claim releases conditionally; the contest-owned hold takes over the
 * task's stillness so the board says "compare and pick", not "vanished".
 */
export function maybeAggregate(store: Store, contestId: number, now: Date): ContestState | null {
  const contest = store.getContest(contestId);
  if (contest === null || contest.state !== "racing") return null;
  const all = store.contestants(contestId);
  const active = all.filter(one => one.state === "pending" || one.state === "ready" || one.state === "building");
  if (active.length > 0) return null;
  const parkedWaiting = all.filter(
    one => one.state === "parked" && store.openDecisionForContestant(one.id) !== null,
  );
  const target: ContestState =
    parkedWaiting.length > 0 ? "decision-wait" : all.some(one => one.state === "built") ? "pick-wait" : "exhausted";
  if (!store.casContestState(contestId, ["racing"], target, contest.generation)) return null;
  if (contest.currentLeaseId !== null) release(store, contest.currentLeaseId, now);
  store.holdOwned(
    {
      taskRef: contest.taskRef,
      ownerKind: "contest",
      ownerId: String(contestId),
      reason:
        target === "pick-wait"
          ? "tournament finished — compare the results and pick one"
          : target === "decision-wait"
            ? "a racing agent is waiting on your answer"
            : "tournament finished with nothing to pick — decide what happens next",
      until: null,
    },
    now,
  );
  // The boundary pages once (dedupe-keyed): a tournament that finished is
  // exactly the "needs me" moment connected messaging exists for. The
  // decision-wait case stays quiet here — the question itself already pages.
  if (target !== "decision-wait") {
    const taskId = store.externalIdFor(contest.taskRef) ?? `ref ${contest.taskRef}`;
    store.enqueueNotification(
      {
        dedupeKey: `contest-${target}:${contestId}`,
        kind: "contest-finished",
        subject:
          target === "pick-wait"
            ? `tournament finished: ${taskId} — compare and pick`
            : `tournament finished with nothing to pick: ${taskId}`,
        body:
          target === "pick-wait"
            ? `All ${all.length} agents finished. Compare the results and pick one at /contest/${contestId} — nothing continues until you do.`
            : `All ${all.length} agents finished without a pickable result. Decide what happens next at /contest/${contestId}.`,
      },
      now,
    );
  }
  return target;
}

// ---------------------------------------------------------------- recovery

/**
 * Crash and reap recovery (finding 27): both CAS on the same generations
 * the finalizers use. An agent that never crossed provider start settles
 * at ZERO; only a started-and-silent one latches its full reservation.
 */
export function recoverContests(store: Store, now: Date): number {
  let recovered = 0;
  for (const contest of store.contestsInStates(["dispatching", "racing"])) {
    const lease = contest.currentLeaseId === null ? null : store.liveClaimByLease(contest.currentLeaseId, now);
    if (lease !== null) continue; // still honestly owned
    const fresh = store.getContest(contest.id);
    if (fresh === null) continue;
    const moved = store.transact(() => {
      if (!store.casContestState(contest.id, ["dispatching", "racing"], "interrupted", fresh.generation)) return false;
      for (const contestant of store.contestants(contest.id)) {
        if (contestant.state === "pending" || contestant.state === "ready" || contestant.state === "building") {
          store.casContestantState(contestant.id, [contestant.state], "stopped", contestant.generation);
          const started =
            contestant.activeRun !== null && store.getRun(contestant.activeRun)?.providerStartedAt != null;
          if (started) store.latchContestantUnknownSpend(contestant.id);
          // Never started: accounted stays where it is (zero when untouched).
          if (contestant.activeRun !== null) store.releaseContestantRun(contestant.id, contestant.activeRun);
        }
      }
      store.releaseSlotsForContest(contest.id, now);
      store.holdOwned(
        {
          taskRef: contest.taskRef,
          ownerKind: "contest",
          ownerId: String(contest.id),
          reason: "the tournament was interrupted — review it, then abandon or start it again",
          until: null,
        },
        now,
      );
      return true;
    });
    if (moved) recovered++;
  }
  return recovered;
}

// ---------------------------------------------------------------- the pick

import { readVerifiedArtifact } from "./evidence.js";
import type { Artifact, PublicationGrant, Run } from "./store.js";

export type AgentView = {
  contestant: Contestant;
  run: Run | null;
  diff: Artifact | null;
  stat: Artifact | null;
  pickable: boolean;
  /** Plain words when it cannot be picked. */
  unpickableReason: string | null;
};

/**
 * Pickability, exactly as ruled (round-3 finding 20): a real result with
 * verified, unredacted, untruncated evidence whose typed capture verdict
 * says ok — never a prose parse, never an automatic selection.
 */
export function buildPickView(store: Store, evidenceRoot: string, contestId: number): {
  contest: Contest;
  agents: AgentView[];
} | null {
  const contest = store.getContest(contestId);
  if (contest === null) return null;
  const agents: AgentView[] = store.contestants(contestId).map(contestant => {
    // The lineage's final run: the newest run carrying this agent.
    const runs = store
      .runsFor(contest.taskRef)
      .filter(one => one.contestant === contestant.id)
      .sort((a, b) => b.id - a.id);
    const run = runs[0] ?? null;
    const artifacts = run === null ? [] : store.artifactsFor(run.id);
    const diff = artifacts.find(one => one.kind === "terminal-diff") ?? null;
    const stat = artifacts.find(one => one.kind === "diff-stat") ?? null;
    let reason: string | null = null;
    if (contestant.state !== "built") reason = `did not finish (${contestant.state})`;
    else if (run === null || run.outcome === null) reason = "no finished attempt";
    else if (run.outcome === "built" && run.committed !== true) reason = "finished without committing";
    else if (run.outcome === "no-change" && run.headRevision !== null && contest.baseSha !== null && run.headRevision !== contest.baseSha)
      reason = "claims no change but the branch moved";
    else if (run.outcome !== "built" && run.outcome !== "no-change") reason = `outcome ${run.outcome}`;
    else if (diff === null || stat === null) reason = "evidence was not captured";
    else if (diff.captureStatus !== "ok" || stat.captureStatus !== "ok") reason = "evidence capture did not verify";
    else if (diff.redacted) reason = "the diff was redacted (something credential-shaped) — unpickable, like unpublishable";
    else if (diff.truncated) reason = "the diff was cut to fit — the comparison here would be partial";
    else {
      const provenDiff = readVerifiedArtifact(evidenceRoot, diff);
      const provenStat = readVerifiedArtifact(evidenceRoot, stat);
      if (!provenDiff.ok || !provenStat.ok) reason = "the evidence bytes no longer verify";
    }
    return { contestant, run, diff, stat, pickable: reason === null, unpickableReason: reason };
  });
  return { contest, agents };
}

/**
 * contest-pick/v1 — the canonical tuple the ceremony's nonce binds
 * (round-1 finding 8 as amended): everything the password authorizes,
 * rebuilt from live state on the POST, never accepted from a client.
 */
export function pickTupleDigest(
  view: { contest: Contest; agents: AgentView[] },
  selection: { contestantId: number } | { abandon: true },
  publication: { grant: PublicationGrant | null; head: string | null },
): string {
  const tuple = {
    v: "contest-pick/v1",
    contest: view.contest.id,
    generation: view.contest.generation,
    taskRef: view.contest.taskRef,
    scope: view.contest.scopeDigest,
    race: view.contest.raceDigest,
    base: view.contest.baseSha,
    setup: view.contest.setupDigest,
    agents: view.agents.map(agent => ({
      id: agent.contestant.id,
      ordinal: agent.contestant.ordinal,
      provider: agent.contestant.provider,
      model: agent.contestant.model,
      state: agent.contestant.state,
      run: agent.run?.id ?? null,
      outcome: agent.run?.outcome ?? null,
      committed: agent.run?.committed ?? null,
      head: agent.run?.headRevision ?? null,
      diff: agent.diff === null ? null : { id: agent.diff.id, sha: agent.diff.sha256, bytes: agent.diff.bytesStored, capture: agent.diff.captureStatus, redacted: agent.diff.redacted, truncated: agent.diff.truncated },
      stat: agent.stat === null ? null : { id: agent.stat.id, sha: agent.stat.sha256, bytes: agent.stat.bytesStored, capture: agent.stat.captureStatus, redacted: agent.stat.redacted, truncated: agent.stat.truncated },
      accountedMicrousd: agent.contestant.accountedMicrousd,
      unknownSpend: agent.contestant.unknownSpend,
    })),
    selection,
    publication:
      publication.grant === null
        ? "none"
        : {
            grant: publication.grant.id,
            githubRepo: publication.grant.githubRepo,
            remote: publication.grant.remote,
            base: publication.grant.base,
            headPrefix: publication.grant.headPrefix,
            selector: publication.grant.selector,
            draft: publication.grant.draft,
            head: publication.head,
          },
  };
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

/**
 * One derivation for both moments — the POST that mints the nonce and the
 * POST that consumes it. Publishability is decided here with exactly the
 * tick path's predicate: committed real change, live grant, branch under
 * the grant's prefix, selector satisfied.
 */
export function computePickPlan(
  store: Store,
  view: { contest: Contest; agents: AgentView[] },
  contestantId: number,
  repo: string | null,
  refOrigin: string,
):
  | { ok: false; message: string }
  | { ok: true; chosen: AgentView & { run: Run }; grant: PublicationGrant | null; publishable: boolean; digest: string } {
  const chosen = view.agents.find(agent => agent.contestant.id === contestantId);
  if (chosen === undefined || !chosen.pickable || chosen.run === null) {
    return { ok: false, message: chosen?.unpickableReason ?? "that agent cannot be picked" };
  }
  const run = chosen.run;
  const grant = repo === null ? null : store.publicationGrantFor(repo);
  const committed = run.outcome === "built" && run.committed === true;
  const publishable =
    committed &&
    grant !== null &&
    run.headRevision !== null &&
    run.branch.startsWith(grant.headPrefix) &&
    (grant.selector === "all" || refOrigin === "ours");
  const digest = pickTupleDigest(
    view,
    { contestantId },
    { grant: publishable ? grant : null, head: publishable ? run.branch : null },
  );
  return { ok: true, chosen: { ...chosen, run }, grant, publishable, digest };
}

export type PickArgs = {
  contestId: number;
  contestantId: number;
  approver: string;
  /** The submitted nonce VALUE; its hash must match a live ceremony row. */
  nonceValue: string;
  evidenceRoot: string;
  repo: string | null;
  taskId: string;
  refOrigin: string;
};

export function nonceHashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The pick, one transaction (round-1 finding 5 + round-3 findings 8/21):
 * nonce consumed conditionally against the REBUILT tuple digest, contest
 * CAS'd, winner proven again byte-for-byte, losers marked for cleanup,
 * the hold lifted, the task done, and the publication intent created —
 * now and only now — under exactly the tick's own predicate.
 */
export function finalizeContestPick(
  store: Store,
  args: PickArgs,
  now: Date,
): { ok: true; state: "picked"; publicationIntent: number | null } | { ok: false; reason: string; message: string } {
  return store.transact(() => {
    const view = buildPickView(store, args.evidenceRoot, args.contestId);
    if (view === null || view.contest.state !== "pick-wait") {
      return { ok: false as const, reason: "not-waiting", message: "this tournament is not waiting for a pick" };
    }
    const plan = computePickPlan(store, view, args.contestantId, args.repo, args.refOrigin);
    if (!plan.ok) {
      return { ok: false as const, reason: "unpickable", message: plan.message };
    }
    const { chosen, grant, publishable, digest } = plan;
    if (!store.consumeCeremonyNonce(nonceHashOf(args.nonceValue), args.approver, "contest-pick", args.contestId, digest, now)) {
      return { ok: false as const, reason: "stale", message: "the evidence changed since you read it, or this screen was already used — look again" };
    }
    // The winner's evidence, proved AGAIN inside the transaction: the nonce
    // said "these bytes"; the pick lands only if they are still those bytes.
    if (chosen.diff === null || !readVerifiedArtifact(args.evidenceRoot, chosen.diff).ok) {
      return { ok: false as const, reason: "evidence", message: "the winner's evidence no longer verifies" };
    }
    if (!store.casContestState(args.contestId, ["pick-wait"], "picked", view.contest.generation)) {
      return { ok: false as const, reason: "raced", message: "somebody else picked first" };
    }
    store.setContestWinner(args.contestId, args.contestantId, args.approver, now);
    for (const agent of view.agents) store.setContestantCleanup(agent.contestant.id, "pending");
    store.releaseOwnedHold("contest", String(args.contestId));
    store.setTaskState(args.taskId, "done", now);
    let intent: number | null = null;
    if (publishable && grant !== null && chosen.run.headRevision !== null) {
      intent = store.createPublicationIntent(
        {
          run: chosen.run.id,
          taskRef: view.contest.taskRef,
          githubRepo: grant.githubRepo,
          remote: grant.remote,
          base: grant.base,
          head: chosen.run.branch,
          headSha: chosen.run.headRevision,
          bodyHash: "",
          draft: grant.draft,
        },
        now,
      );
    }
    return { ok: true as const, state: "picked" as const, publicationIntent: intent };
  });
}

/** Abandon: password + nonce like the pick (it cancels paid-for work and
 * re-opens the task), everything retained, nothing published. */
export function abandonContest(
  store: Store,
  args: { contestId: number; approver: string; nonceValue: string; evidenceRoot: string; taskId: string },
  now: Date,
): { ok: true } | { ok: false; reason: string; message: string } {
  return store.transact(() => {
    const view = buildPickView(store, args.evidenceRoot, args.contestId);
    if (view === null || !["pick-wait", "exhausted", "interrupted", "decision-wait"].includes(view.contest.state)) {
      return { ok: false as const, reason: "not-open", message: "this tournament is not in a state an operator can abandon" };
    }
    const digest = pickTupleDigest(view, { abandon: true }, { grant: null, head: null });
    if (!store.consumeCeremonyNonce(nonceHashOf(args.nonceValue), args.approver, "contest-abandon", args.contestId, digest, now)) {
      return { ok: false as const, reason: "stale", message: "the tournament changed since you read it — look again" };
    }
    if (!store.casContestState(args.contestId, [view.contest.state as ContestState], "abandoned", view.contest.generation)) {
      return { ok: false as const, reason: "raced", message: "the tournament moved first" };
    }
    for (const agent of view.agents) store.setContestantCleanup(agent.contestant.id, "pending");
    store.releaseOwnedHold("contest", String(args.contestId));
    store.setTaskState(args.taskId, "failed", now);
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------- stage 6

/** Fourteen days: the escalation threshold for an undecided tournament. */
export const CONTEST_OVERDUE_MS = 14 * 24 * 60 * 60_000;

/**
 * The cleanup pass (stage 6): once a tournament is DECIDED — picked or
 * abandoned — every agent's checkout goes back to the pool, winners and
 * losers alike (branches and evidence survive; a checkout is only a
 * checkout). Custody holds: only the runner that owns a checkout releases
 * it, and one that will not release cleanly (dirty, uninspectable) is
 * marked for attention and paged once rather than cleaned by force.
 */
export async function sweepContestCleanup(
  store: Store,
  releaseWorktree: (path: string) => Promise<{ ok: boolean; reason?: string; message?: string }>,
  runner: string,
  now: Date,
): Promise<{ released: number; attention: number }> {
  let released = 0;
  let attention = 0;
  for (const contestant of store.contestantsForCleanup()) {
    if (contestant.worktree === null) {
      store.setContestantCleanup(contestant.id, "done");
      continue;
    }
    const row = store.getWorktree(contestant.worktree);
    if (row === null) {
      // The pool never knew it, or the row is gone (reimage): nothing to
      // release, nothing to keep waiting on.
      store.setContestantCleanup(contestant.id, "done");
      continue;
    }
    if (row.runner !== null && row.runner !== runner) continue; // another machine's custody
    const freed = await releaseWorktree(contestant.worktree);
    if (freed.ok) {
      store.setContestantCleanup(contestant.id, "done");
      released += 1;
      continue;
    }
    store.setContestantCleanup(contestant.id, "attention");
    attention += 1;
    store.enqueueNotification(
      {
        dedupeKey: `contest-cleanup:${contestant.id}`,
        kind: "contest-cleanup",
        subject: `a tournament checkout needs a look: agent ${contestant.ordinal}`,
        body:
          `The checkout at ${contestant.worktree} would not go back to the pool` +
          ` (${freed.message ?? freed.reason ?? "unknown"}). It was kept, not cleaned — look before anything is removed.`,
      },
      now,
    );
  }
  return { released, attention };
}

/**
 * Overdue escalation (stage 6): a tournament waiting on a person for
 * fourteen days pages ONCE more — never auto-abandons, never re-pages.
 * The age is derived from the moment the contest-owned hold took the
 * task's stillness, which is exactly when the waiting began.
 */
export function escalateOverdueContests(store: Store, now: Date): number {
  let paged = 0;
  for (const contest of store.contestsInStates(["pick-wait", "exhausted", "interrupted"])) {
    if (contest.overduePaged) continue;
    const hold = store
      .activeHolds(contest.taskRef, now)
      .find(one => one.ownerKind === "contest" && one.ownerId === String(contest.id));
    const since = hold?.heldAt ?? contest.createdAt;
    if (now.getTime() - new Date(since).getTime() < CONTEST_OVERDUE_MS) continue;
    if (!store.markContestOverduePaged(contest.id)) continue; // someone else paged first
    const taskId = store.externalIdFor(contest.taskRef) ?? `ref ${contest.taskRef}`;
    const days = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
    store.enqueueNotification(
      {
        dedupeKey: `contest-overdue:${contest.id}`,
        kind: "contest-overdue",
        subject: `a tournament has waited ${days} days: ${taskId}`,
        body:
          `The tournament on ${taskId} has been waiting for your decision for ${days} days. ` +
          `Nothing happens on its own — compare and decide at /contest/${contest.id}, or abandon it there.`,
      },
      now,
    );
    paged += 1;
  }
  return paged;
}
