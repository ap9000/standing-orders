/**
 * Routines: standing orders that fire on a schedule (Phase C).
 *
 * A routine is a pre-approved template — goal, exclusions, touches,
 * requirements, schedule, budget — whose approval is what makes every
 * instance legitimately automatic. The template's digest covers EVERY term
 * that constrains the standing order, not just the scope trio: a schedule
 * moved from weekly to hourly, or a budget quietly removed, changes what the
 * operator agreed to exactly as much as a rewritten goal would.
 *
 * The schedule algebra lives here, pure, because its two failure modes are
 * subtle enough to deserve names (Codex planning/routines review, finding
 * 10): advancing one interval after downtime leaves the next firing in the
 * past — a catch-up burst; advancing to `now + interval` drifts the cadence
 * forever. The rule is ALIGNED advancement: the next occurrence strictly
 * after now, anchored to the occurrence that just fired (for `every`) or to
 * the clock itself (for `daily`). Missed slots while nothing was running
 * fire ONCE — the overdue occurrence — and are never backfilled.
 */

import { createHash } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import { BUILT_IN, parseCapabilityKey, type Routine, type Store } from "./store.js";
import { authenticateApprover, digestOf, profileDigestOf, parseAcceptanceCriteria, canonicalAcceptance, acceptanceWords, type ExecutionProfile, type AcceptanceCriterion } from "./scope.js";
import { reportsCost } from "./provider.js";
import { agentsSummary, legOf, postureWords, routeDigestOf, routeProblems, type PhaseRoute } from "./phase-routing.js";

export type Schedule =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; hhmm: string };

/** Bounds a person would pick on purpose: 5 minutes to 7 days. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;

/**
 * `every:<minutes>` or `daily:<HH:MM>` (UTC, and every surface says so).
 * No cron expressions in v1 — a schedule the operator cannot read at a
 * glance is a schedule they cannot honestly approve.
 */
export function parseSchedule(text: string): Schedule | null {
  const every = /^every:([0-9]{1,5})$/.exec(text);
  if (every !== null) {
    const minutes = Number(every[1]);
    if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) return null;
    return { kind: "every", minutes };
  }
  const daily = /^daily:([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
  if (daily !== null) {
    return { kind: "daily", hhmm: `${daily[1]}:${daily[2]}` };
  }
  return null;
}

export function scheduleText(schedule: Schedule): string {
  return schedule.kind === "every" ? `every:${schedule.minutes}` : `daily:${schedule.hhmm}`;
}

/** The schedule, in words an operator agrees to. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "daily") return `daily at ${schedule.hhmm} UTC`;
  const { minutes } = schedule;
  if (minutes % (24 * 60) === 0) return `every ${minutes / (24 * 60)} day(s)`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hour(s)`;
  return `every ${minutes} minutes`;
}

/**
 * The first occurrence after approval: the schedule starts counting from the
 * yes, because "approved at 14:07, every 60 minutes" firing instantly would
 * spend before the approver's hand left the keyboard.
 */
export function firstFireAt(schedule: Schedule, now: Date): string {
  if (schedule.kind === "every") {
    return new Date(now.getTime() + schedule.minutes * 60_000).toISOString();
  }
  return nextDaily(schedule.hhmm, now);
}

/**
 * Aligned advancement: the smallest cadence occurrence STRICTLY after now.
 * `anchor` is the occurrence that just fired (or was just skipped) — the
 * cadence grid grows from it, so a pass that ran late does not tilt every
 * later firing by its lateness.
 */
export function nextFireAt(schedule: Schedule, anchorIso: string, now: Date): string {
  if (schedule.kind === "daily") return nextDaily(schedule.hhmm, now);
  const interval = schedule.minutes * 60_000;
  const anchor = new Date(anchorIso).getTime();
  const elapsed = now.getTime() - anchor;
  // Strictly after now: an occurrence landing exactly on now already fired.
  const steps = Math.max(1, Math.floor(elapsed / interval) + 1);
  return new Date(anchor + steps * interval).toISOString();
}

function nextDaily(hhmm: string, now: Date): string {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours ?? 0, minutes ?? 0, 0, 0,
  ));
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

/** Every term the digest must bind — a change to any is a different order. */
export type RoutineTerms = {
  repo: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** v39: the signed rubric every instance's scope copies forward, byte
   * for byte, at fire time — never re-authored per firing. */
  acceptance: AcceptanceCriterion[];
  requirements: string[];
  schedule: string;
  singleFlight: boolean;
  costCeilingUsd: number | null;
  /** Per-instance dollar cap in micro-USD (v16); null = only the backstop. */
  budgetPerRunMicrousd?: number | null;
};

/**
 * The exact standing order an operator agreed to, as 128 bits. Same shape
 * and length as a scope digest, and for the same reason: approval binds to
 * this value, and editing any term strands the old yes.
 */
export function routineDigestOf(terms: RoutineTerms, profile?: ExecutionProfile | null, route?: PhaseRoute | null): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: terms.repo,
        goal: terms.goal.trim(),
        outOfScope: terms.outOfScope?.trim() ?? null,
        touches: [...terms.touches].sort(),
        // v39: the same absent/[] equivalence a scope digest gives its
        // rubric — a routine created before this migration, or one whose
        // stored acceptance somehow reads back empty, digests unchanged.
        ...(terms.acceptance.length === 0 ? {} : { acceptance: canonicalAcceptance(terms.acceptance) }),
        requirements: [...terms.requirements].sort(),
        schedule: terms.schedule,
        singleFlight: terms.singleFlight,
        costCeilingUsd: terms.costCeilingUsd,
        ...(terms.budgetPerRunMicrousd == null ? {} : { budgetPerRun: terms.budgetPerRunMicrousd }),
        // v24: absent and null identical — legacy routine digests keep
        // their bytes; profile-bearing routines bind their routing.
        ...(profile == null ? {} : { profileDigest: profileDigestOf(profile) }),
        // v48: the four-role agent route, under its own key — absent on a
        // routine filed before routing froze (its digest bytes stand; it
        // can no longer be approved or fired until filed again).
        ...(route == null ? {} : { route: routeDigestOf(route) }),
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export type RoutineProblem = { field: string; problem: string };

/** Instance ids are `<name>-YYYYMMDD-HHMM`, so the name must be an id stem. */
export const ROUTINE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Fail closed on every field at once, like plan parsing: an operator fixing
 * a routine definition should learn everything wrong in one round.
 */
export function validateRoutineTerms(terms: RoutineTerms): RoutineProblem[] {
  const problems: RoutineProblem[] = [];
  if (terms.goal.trim() === "" || terms.goal.length > 2_000 || hasForbiddenControls(terms.goal)) {
    problems.push({ field: "goal", problem: "required, at most 2000 characters, no control characters" });
  }
  if (terms.outOfScope !== null && (terms.outOfScope.length > 2_000 || hasForbiddenControls(terms.outOfScope))) {
    problems.push({ field: "outOfScope", problem: "at most 2000 characters, no control characters" });
  }
  if (terms.touches.length > 50 || terms.touches.some(one => one.trim() === "" || one.length > 200 || hasForbiddenControls(one))) {
    problems.push({ field: "touches", problem: "at most 50 paths, each non-empty and under 200 characters" });
  }
  if (terms.requirements.length > 20 || terms.requirements.some(one => parseCapabilityKey(one) === null)) {
    problems.push({ field: "requirements", problem: "capability keys, `kind:name`, at most 20" });
  }
  // v39: this is the ONLY place a routine's rubric is authored — every
  // firing copies it forward unchanged, never re-asks. A track that never
  // gains one never gets past this validation, so `fireRoutine` can trust
  // a stored routine's acceptance is non-empty without re-checking it.
  const acceptanceParse = parseAcceptanceCriteria(terms.acceptance);
  if (acceptanceParse.problems.length > 0) {
    problems.push({ field: "acceptance", problem: acceptanceParse.problems.map(p => p.message).join("; ") });
  } else if (acceptanceParse.criteria.length === 0) {
    problems.push({ field: "acceptance", problem: "a standing order needs at least one signed acceptance criterion" });
  }
  if (parseSchedule(terms.schedule) === null) {
    problems.push({
      field: "schedule",
      problem: `\`every:<minutes>\` (${MIN_EVERY_MINUTES}–${MAX_EVERY_MINUTES}) or \`daily:<HH:MM>\` (UTC)`,
    });
  }
  if (terms.costCeilingUsd !== null && (!Number.isFinite(terms.costCeilingUsd) || terms.costCeilingUsd <= 0)) {
    problems.push({ field: "costCeilingUsd", problem: "a positive dollar amount, or absent for no ceiling" });
  }
  // v1 is one-at-a-time, period: every approval surface SAYS so, and a
  // stored false would make the ceremony describe behavior the firing does
  // not have (Codex Phase C review, M4). The column stays for a future that
  // designs the concurrent case; until then it is not accepted.
  if (terms.singleFlight !== true) {
    problems.push({ field: "singleFlight", problem: "v1 routines run one instance at a time — singleFlight must be true" });
  }
  return problems;
}

/** The stored row's terms, for re-proving the digest against what is actually there. */
export function termsOf(routine: Routine): RoutineTerms {
  return {
    repo: routine.repo,
    goal: routine.goal,
    outOfScope: routine.outOfScope,
    touches: routine.touches,
    acceptance: routine.acceptance,
    requirements: routine.requirements,
    schedule: routine.schedule,
    singleFlight: routine.singleFlight,
    costCeilingUsd: routine.costCeilingUsd,
    budgetPerRunMicrousd: routine.budgetPerRunMicrousd,
  };
}

/** The instance task id: the routine's name stamped with its scheduled slot. */
export function instanceId(name: string, scheduledForIso: string): string {
  const stamp = scheduledForIso.replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  return `${name}-${stamp}`;
}

/** The rolling budget window: seven days, and every surface says so. */
export const BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type ApproveRoutineResult =
  | { ok: true; routine: Routine }
  | { ok: false; reason: "no-such-routine" | "profile-unresolved" | "changed" | "no-approvers" | "not-an-approver" };

/**
 * A person agrees to the standing order — schedule, budget, and "each
 * firing builds without asking" included, because the digest binds them.
 * Same ceremony as a scope approval: credential re-proved inside the same
 * transaction as the write, digest named rather than assumed.
 */
export function approveRoutine(
  store: Store,
  routineId: number,
  by: string,
  now: Date,
  sawDigest: string,
  token: string,
): ApproveRoutineResult {
  return store.transact(() => {
    const authenticated = authenticateApprover(store, by, token);
    if (!authenticated.ok) return authenticated;

    const routine = store.getRoutine(routineId);
    if (routine === null) return { ok: false as const, reason: "no-such-routine" as const };
    if (sawDigest !== routine.digest) return { ok: false as const, reason: "changed" as const };
    // A routine that cannot say exactly what would run is unapprovable
    // (v24, same rule as scopes) — restatement is the road. Since v48 that
    // means all four roles: a routine with no frozen route (filed before
    // routing froze, or under a configuration that could not make one
    // exact) cannot be agreed to until it is filed again.
    if (routine.profile === null || routine.profile === undefined || routine.route === null || routine.route === undefined || routeProblems(routine.route).length > 0) {
      return { ok: false as const, reason: "profile-unresolved" as const };
    }
    // The digest is re-derived from the stored terms, never trusted as a
    // column (Codex Phase C review, H1): a row whose digest does not match
    // its own terms is not something a person can meaningfully agree to.
    if (routineDigestOf(termsOf(routine), routine.profile, routine.route) !== routine.digest) {
      return { ok: false as const, reason: "changed" as const };
    }

    const schedule = parseSchedule(routine.schedule);
    if (schedule === null) return { ok: false as const, reason: "changed" as const };

    // The schedule starts counting from the yes — never retroactively.
    store.stampRoutineApproval(routineId, by, routine.digest, firstFireAt(schedule, now), now);
    return { ok: true as const, routine: store.getRoutine(routineId) as Routine };
  });
}

export type FireOutcome =
  | { ok: true; taskId: string; scheduledFor: string }
  | {
      ok: false;
      reason:
        | "no-such-routine"
        | "not-approved"
        | "paused"
        | "not-due"
        | "bad-schedule"
        | "slot-taken"
        | "single-flight"
        | "budget"
        | "unmeasured"
        | "route-unfrozen";
      detail?: string;
    };

/**
 * Fire one routine — or record, durably, why it did not.
 *
 * One store-owned transaction re-proves EVERYTHING before any write (Codex
 * planning/routines review, finding 4): approval-digest equality, unpaused,
 * due, single-flight, and budget are read inside the same BEGIN IMMEDIATE
 * that creates the instance, so a template edited between an eligibility
 * scan and this call simply refuses — the scan only nominates.
 *
 * The instance's scope is copied from the row proven approved HERE, and its
 * approval identity is the template's: approvedBy/At come from the template
 * stamp, and approvedDigest is the digest of the very terms copied in this
 * transaction. No caller supplies approval fields; there is nothing to
 * manufacture.
 *
 * A scheduled slot that cannot fire is SKIPPED ON THE LEDGER and the
 * schedule advances past it (finding 10 — no backfill, no silent gap);
 * blocked tracks page once per blocking fact (finding 9), and the episode
 * resolves when a later firing succeeds. A manual run-now is different on
 * exactly those points: it refuses to the person's face, records nothing,
 * advances nothing, and pages nobody.
 */
export function fireRoutine(
  store: Store,
  routineId: number,
  now: Date,
  options: { manual?: boolean } = {},
): FireOutcome {
  const manual = options.manual === true;
  return store.transact(() => {
    const routine = store.getRoutine(routineId);
    if (routine === null) return { ok: false as const, reason: "no-such-routine" as const };

    // Approval is proved THREE ways: a stamp exists, it matches the stored
    // digest, and — because a digest column can be written by any store
    // caller — the digest is re-derived from the stored terms themselves
    // (Codex Phase C review, H1). Terms edited under a reused digest fire
    // nothing, whatever the columns claim.
    if (
      routine.approvedAt === null ||
      routine.approvedDigest !== routine.digest ||
      routineDigestOf(termsOf(routine), routine.profile ?? null, routine.route ?? null) !== routine.digest
    ) {
      return {
        ok: false as const,
        reason: "not-approved" as const,
        detail:
          routine.approvedAt === null
            ? "nobody has agreed to this standing order"
            : "the template was edited after approval — approve it again",
      };
    }
    if (routine.paused) return { ok: false as const, reason: "paused" as const };

    const schedule = parseSchedule(routine.schedule);
    if (schedule === null) return { ok: false as const, reason: "bad-schedule" as const };

    const occurredAt = manual ? now.toISOString() : routine.nextFireAt;
    if (occurredAt === null || (!manual && occurredAt > now.toISOString())) {
      return { ok: false as const, reason: "not-due" as const };
    }
    // A manual firing has its own ledger identity: it must never claim a
    // scheduled slot's key, or a run-now landing exactly on the due instant
    // would strand the schedule on that slot forever (Codex review, M1).
    const slotKey = manual ? `manual:${occurredAt}` : occurredAt;
    const scheduledFor = occurredAt;

    // The slot check is a plain read because the whole function is one
    // IMMEDIATE transaction — two passes finding the same due slot queue on
    // the lock, and the second sees the first's row.
    if (!store.routineSlotOpen(routineId, slotKey)) {
      // A scheduled pointer aimed at an already-recorded slot is stale —
      // heal it by advancing past the slot, or this refusal repeats forever.
      if (!manual) {
        store.setRoutineNextFire(routineId, nextFireAt(schedule, occurredAt, now), now);
      }
      return { ok: false as const, reason: "slot-taken" as const };
    }

    /** A due slot that cannot fire: ledger the skip, advance, page once. */
    const skip = (
      reason: "single-flight" | "budget" | "unmeasured",
      ledgerReason: string,
      page: { prefix: string; subject: string; body: string } | null,
      detail: string,
    ): FireOutcome => {
      if (manual) return { ok: false, reason, detail };
      store.recordRoutineFire(
        { routineId, scheduledFor: slotKey, outcome: "skipped", reason: ledgerReason, instanceTaskRef: null },
        now,
      );
      store.setRoutineNextFire(routineId, nextFireAt(schedule, scheduledFor, now), now);
      if (page !== null) {
        // One page per blocking EPISODE: an open episode nags nobody twice,
        // and a resolved one is history that must not suppress the next
        // recurrence (Codex review, L1) — the slot stamp keys each afresh.
        store.enqueueRoutineEpisode(
          page.prefix,
          { kind: "routine-blocked", subject: page.subject, body: page.body, pushClass: "attention", link: `/routines/${routineId}` },
          scheduledFor,
          now,
        );
      }
      return { ok: false, reason, detail };
    };

    // Single-flight is unconditional in v1 (Codex review, M4) — and a live
    // claim blocks REGARDLESS of task state, so a state string written over
    // a running build cannot conjure a twin beside it (H2).
    const blocker = store.routineBlocker(routineId, now);
    if (blocker !== null) {
      return skip(
        "single-flight",
        `single-flight:${blocker.taskId}`,
        {
          prefix: `routine-singleflight:${routineId}:${blocker.taskId}`,
          subject: `${routine.name} has stopped: ${blocker.taskId} is stuck`,
          body: `The ${routine.name} track skipped its scheduled run because its last instance (${blocker.taskId}, ${blocker.state}) has not finished. The track stays stopped until that instance completes or is cancelled.`,
        },
        `instance ${blocker.taskId} (${blocker.state}) has not finished`,
      );
    }

    // THE FROZEN ROUTE (v48): the instance runs on exactly the four agents
    // the approval sealed — planner, builder, repair, reviewer — copied
    // from the approved snapshot, never recommended afresh. A routine whose
    // approval predates routing (no sealed route) fires nothing: the slot
    // stays due, the operator is paged once, and approving the standing
    // order again — under agents it now names — is the road. No later
    // `config set` can reach a firing.
    const frozenRoute = routine.approvedRoute ?? null;
    const frozenProfile = routine.approvedProfile ?? null;
    if (frozenRoute === null || frozenProfile === null) {
      if (!manual) {
        store.enqueueRoutineEpisode(
          `routine-route:${routineId}`,
          {
            kind: "routine-blocked",
            pushClass: "attention",
            link: `/routines/${routineId}`,
            subject: `${routine.name} needs approving again: its agents were never frozen`,
            body: `This standing order was approved before Standing Orders froze which agents plan, build, repair, and review each firing. Open it, read the agents it now names, and approve it again; until then its firings wait.`,
          },
          scheduledFor,
          now,
        );
      }
      return { ok: false as const, reason: "route-unfrozen" as const, detail: "this standing order was approved before its agents were frozen — approve it again to fire it" };
    }
    // The build leg is the pin and the profile is its exact restatement —
    // proved here, inside the transaction, before anything is written.
    const frozenBuild = legOf(frozenRoute, "build");
    const frozenRepair = legOf(frozenRoute, "repair");
    const frozenRepairModel = frozenProfile.repairModel === "inherit" ? frozenProfile.model : frozenProfile.repairModel;
    if (frozenBuild.provider !== frozenProfile.provider || frozenBuild.model !== frozenProfile.model || frozenRepair.model !== frozenRepairModel) {
      return { ok: false as const, reason: "route-unfrozen" as const, detail: `the approved agents (${frozenProfile.provider} · ${frozenProfile.model}, repair ${frozenRepairModel}) disagree with the approved route (${frozenBuild.provider} · ${frozenBuild.model}, repair ${frozenRepair.model}) — file the standing order again` };
    }
    // The instance's agent IS the frozen build leg — never resolved from
    // flags or configuration at fire time (Codex provider review, critical
    // finding; v48 makes the whole route the pin).
    const agentProvider = frozenBuild.provider;
    // A ceiling against a provider that reports no dollars would fail
    // closed on the SECOND firing anyway — refuse the first, say why, and
    // skip the slot honestly (Codex provider review, Q6: re-proved at
    // dispatch, not only at approval).
    if (routine.costCeilingUsd !== null && !reportsCost(agentProvider)) {
      return skip(
        "unmeasured",
        `unmeasured-provider:${agentProvider}`,
        {
          prefix: `routine-unmeasured:${routineId}`,
          subject: `${routine.name} is blocked: ${agentProvider} cannot honor a cost ceiling`,
          body: `The track's $${routine.costCeilingUsd.toFixed(2)} ceiling needs a provider that reports dollar cost, and ${agentProvider} does not. Drop the ceiling, or run the track on claude.`,
        },
        `${agentProvider} reports no dollar cost against a $${routine.costCeilingUsd.toFixed(2)} ceiling`,
      );
    }

    if (routine.costCeilingUsd !== null) {
      const spend = store.routineSpend(
        routineId,
        new Date(now.getTime() - BUDGET_WINDOW_MS).toISOString(),
      );
      // Fail closed (finding 5): a paid run whose cost never landed is not
      // headroom — it is an unknown liability, and it blocks the track.
      if (spend.unmeasuredRuns > 0) {
        return skip(
          "unmeasured",
          "unmeasured",
          {
            prefix: `routine-unmeasured:${routineId}`,
            subject: `${routine.name} is blocked: spend is unmeasured`,
            body: `${spend.unmeasuredRuns} paid run(s) in the last 7 days recorded no cost, so the $${routine.costCeilingUsd.toFixed(2)} ceiling cannot be honestly enforced. The track skips its firings until the window rolls past them.`,
          },
          `${spend.unmeasuredRuns} paid run(s) with no recorded cost`,
        );
      }
      if (spend.costUsd >= routine.costCeilingUsd) {
        return skip(
          "budget",
          "budget",
          {
            prefix: `routine-budget:${routineId}`,
            subject: `${routine.name} hit its budget`,
            body: `Instances spent $${spend.costUsd.toFixed(2)} of the $${routine.costCeilingUsd.toFixed(2)} ceiling in the last 7 days. Firings skip until the window rolls; raise the ceiling to resume sooner (that edit voids the approval, on purpose).`,
          },
          `$${spend.costUsd.toFixed(2)} spent of $${routine.costCeilingUsd.toFixed(2)}`,
        );
      }
    }

    // All proofs held: spawn the instance. Uniquified inside this same
    // transaction; the ledger row makes a same-slot twin impossible anyway.
    let taskId = instanceId(routine.name, scheduledFor);
    for (let n = 2; store.getTask(taskId) !== null; n++) {
      taskId = `${instanceId(routine.name, scheduledFor)}-${n}`;
    }
    const title = `${routine.name} · ${scheduledFor.slice(0, 16).replace("T", " ")} UTC`;

    store.createTask({ id: taskId, title }, now);
    const ref = store.refFor(BUILT_IN, taskId, "ours");
    // Placement BEFORE the scope exists — placeTask refuses to move scoped
    // work, and this ordering is what keeps that guard out of the way here.
    store.placeTask(ref.id, routine.repo);
    store.linkRoutineInstance(ref.id, routine.id);
    // The pin: this instance builds on exactly this agent, whatever flags a
    // later pass carries — the routine's APPROVED profile when one was
    // sealed (v47: the pin and the profile are one exact authority), else
    // the resolved agent.
    store.pinTaskAgent(ref.id, frozenProfile.provider, frozenProfile.model);
    if (routine.requirements.length > 0) {
      store.setRequirements(ref.id, routine.requirements);
    }

    // The instance scope: the template's terms, byte for byte, stamped
    // approved by the person who approved the template (finding 4). The
    // digest is computed from the copied terms IN this transaction, so the
    // approval can only ever cover exactly what was proven approved above.
    const draft = {
      goal: routine.goal,
      outOfScope: routine.outOfScope,
      touches: [...routine.touches],
      acceptance: [...routine.acceptance],
      ...(routine.budgetPerRunMicrousd == null ? {} : { budgetMicrousd: routine.budgetPerRunMicrousd }),
    };
    // v24 (foundations 3d): the instance's profile is the routine's
    // APPROVED snapshot — never fresh resolution. The instance digest
    // binds it, the approval stamp covers it, and saveScope is handed the
    // profile EXPLICITLY so its own resolution never runs here.
    // v48: the frozen ROUTE rides beside it, verbatim — saveScope files it
    // instead of recommending one from today's configuration, and the
    // instance digest binds both, so the seal below covers exactly the
    // four agents the routine's approver agreed to.
    const instanceProfile = frozenProfile;
    const instanceDigest = digestOf(draft, instanceProfile, frozenRoute);
    store.saveScope(
      {
        taskId,
        ...draft,
        proposedAt: now.toISOString(),
        digest: instanceDigest,
        budgetMicrousd: routine.budgetPerRunMicrousd ?? null,
        approvedAt: routine.approvedAt,
        approvedBy: routine.approvedBy,
        approvedDigest: instanceDigest,
      },
      {},
      { profile: instanceProfile, route: frozenRoute },
    );
    store.sealScopeApproval(taskId, routine.approvedBy ?? "routine", now);

    store.recordRoutineFire(
      { routineId, scheduledFor: slotKey, outcome: "fired", reason: manual ? "manual" : null, instanceTaskRef: ref.id },
      now,
    );
    if (!manual) {
      store.setRoutineNextFire(routineId, nextFireAt(schedule, scheduledFor, now), now);
    }
    // Success is the proof the blockers are gone; their episodes resolve.
    store.resolveRoutineEpisodes(routineId, now);

    return { ok: true as const, taskId, scheduledFor };
  });
}

/** The standing order, in the words an operator has to agree to. */
export function describeRoutine(routine: Routine): string[] {
  const schedule = parseSchedule(routine.schedule);
  return [
    `  goal         ${routine.goal}`,
    ...(routine.outOfScope === null ? [] : [`  not this     ${routine.outOfScope}`]),
    ...(routine.touches.length === 0 ? [] : [`  touches      ${routine.touches.join(", ")}`]),
    ...acceptanceWords(routine.acceptance),
    ...(routine.requirements.length === 0 ? [] : [`  needs        ${routine.requirements.join(", ")}`]),
    `  project      ${routine.repo}`,
    ...routineAgentsWords(routine),
    `  schedule     ${schedule === null ? routine.schedule : describeSchedule(schedule)}`,
    `  budget       ${routine.costCeilingUsd === null ? "no ceiling" : `$${routine.costCeilingUsd.toFixed(2)} per rolling 7 days`}`,
    `  one at a time — a firing skips while the previous instance is unfinished`,
    `  reference    ${routine.digest}`,
    `  approving this means EACH FIRING BUILDS WITHOUT ASKING, inside exactly these terms`,
  ];
}

/** The agents a standing order's approval freezes, in the same words the
 * task page and chat use — or why it cannot say. */
export function routineAgentsWords(routine: Pick<Routine, "route" | "approvedRoute" | "approvedAt" | "approvedDigest" | "digest">): string[] {
  const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
  const route = approved ? routine.approvedRoute ?? null : routine.route ?? null;
  if (route === null) {
    return [`  agents       not frozen — ${approved ? "approved before agent routing; approve the standing order again" : "file the standing order again under a configuration that names an exact agent for every role"}`];
  }
  return [
    `  agents       ${agentsSummary(route)} — ${postureWords(route)}`,
    ...(approved ? [`               frozen by the approval: a configuration change cannot re-route a firing`] : [`               frozen when you approve: a configuration change cannot re-route a firing`]),
  ];
}
