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
import { resolveRoutineAuthority } from "./agentconfig.js";

export type Schedule =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; hhmm: string; timezone?: string }
  | { kind: "weekly"; day: number; hhmm: string; timezone?: string };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function validTimezone(value: string): boolean {
  if (value.trim() !== value) return false;
  if (!/^[A-Za-z0-9_+/-]{1,80}$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

/** Bounds a person would pick on purpose: 5 minutes to 7 days. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;

/**
 * Existing daily schedules remain UTC. Calendar schedules may name an IANA
 * timezone, whose wall-clock time stays fixed across daylight saving changes.
 * No cron expressions in v1 — a schedule the operator cannot read at a
 * glance is a schedule they cannot honestly approve.
 */
export function parseSchedule(text: string): Schedule | null {
  if (text.trim() !== text) return null;
  const every = /^every:([0-9]{1,5})$/.exec(text);
  if (every !== null) {
    const minutes = Number(every[1]);
    if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) return null;
    return { kind: "every", minutes };
  }
  const calendar = /^(daily|weekly:[0-6]):([01][0-9]|2[0-3]):([0-5][0-9])(?:@([A-Za-z0-9_+/-]{1,80}))?$/.exec(text);
  if (calendar !== null) {
    const timezone = calendar[4];
    if (timezone !== undefined && !validTimezone(timezone)) return null;
    const time = { hhmm: `${calendar[2]}:${calendar[3]}`, ...(timezone === undefined ? {} : { timezone }) };
    return calendar[1] === "daily" ? { kind: "daily", ...time } : { kind: "weekly", day: Number(calendar[1]!.slice(-1)), ...time };
  }
  return null;
}

export function scheduleText(schedule: Schedule): string {
  return schedule.kind === "every" ? `every:${schedule.minutes}` : `${schedule.kind === "weekly" ? `weekly:${schedule.day}` : "daily"}:${schedule.hhmm}${schedule.timezone === undefined ? "" : `@${schedule.timezone}`}`;
}

/** The schedule, in words an operator agrees to. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind !== "every") return `${schedule.kind === "daily" ? "daily" : `every ${WEEKDAYS[schedule.day]}`} at ${schedule.hhmm} ${schedule.timezone ?? "UTC"}`;
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
  return nextCalendar(schedule, now);
}

/**
 * Aligned advancement: the smallest cadence occurrence STRICTLY after now.
 * `anchor` is the occurrence that just fired (or was just skipped) — the
 * cadence grid grows from it, so a pass that ran late does not tilt every
 * later firing by its lateness.
 */
export function nextFireAt(schedule: Schedule, anchorIso: string, now: Date): string {
  if (schedule.kind !== "every") return nextCalendar(schedule, now);
  const interval = schedule.minutes * 60_000;
  const anchor = new Date(anchorIso).getTime();
  const elapsed = now.getTime() - anchor;
  // Strictly after now: an occurrence landing exactly on now already fired.
  const steps = Math.max(1, Math.floor(elapsed / interval) + 1);
  return new Date(anchor + steps * interval).toISOString();
}

function nextCalendar(schedule: Exclude<Schedule, { kind: "every" }>, now: Date): string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Represent wall-clock components as a UTC number solely for arithmetic.
  const wall = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const localNow = new Date(wall(now.getTime()));
  const [hour, minute] = schedule.hhmm.split(":").map(Number);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute);
  for (let days = 0; days <= 15; days++) {
    const target = today + days * 86_400_000;
    if (schedule.kind === "weekly" && new Date(target).getUTCDay() !== schedule.day) continue;
    // Nearby dates expose both offsets around a daylight-saving transition.
    // A missing clock time skips its slot. An ambiguous time uses the first
    // occurrence only, even if the scheduler advances during the repeated hour.
    const offsets = [...new Set([-36, 0, 36].map(hours => { const sample = target + hours * 3_600_000; return wall(sample) - sample; }))];
    const matches = offsets.map(offset => target - offset).filter(instant => wall(instant) === target);
    if (matches.length > 0) {
      const first = Math.min(...matches);
      if (first > now.getTime()) return new Date(first).toISOString();
    }
  }
  throw new Error("No calendar occurrence within the next fifteen days");
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
export function validateRoutineTerms(
  terms: RoutineTerms,
  options: {
    /** The STORED row's name (final authority closure): validated with the
     * terms wherever a stored routine is read back, so a raw name this
     * code never files — one no instance id could be stamped from — is
     * as invalid as an empty rubric, and no door moves on it. */
    name?: string;
  } = {},
): RoutineProblem[] {
  const problems: RoutineProblem[] = [];
  if (options.name !== undefined && !ROUTINE_NAME.test(options.name)) {
    problems.push({ field: "name", problem: "a lowercase id stem — letters, digits, and dashes, at most 41 characters" });
  }
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
  // gains one never gets past this validation — filed, migrated, or
  // corrupted alike (final authority closure): an empty rubric is invalid
  // wherever a stored row is read back, so a routine that predates
  // rubrics (a migrated NULL acceptance_json) cannot refresh, take a yes,
  // or fire `acceptance: []` until valid terms are filed again.
  const acceptanceParse = parseAcceptanceCriteria(terms.acceptance);
  if (acceptanceParse.problems.length > 0) {
    problems.push({ field: "acceptance", problem: acceptanceParse.problems.map(p => p.message).join("; ") });
  } else if (acceptanceParse.criteria.length === 0) {
    problems.push({ field: "acceptance", problem: "a standing order needs at least one signed acceptance criterion" });
  }
  if (parseSchedule(terms.schedule) === null) {
    problems.push({
      field: "schedule",
      problem: `\`every:<minutes>\` (${MIN_EVERY_MINUTES}–${MAX_EVERY_MINUTES}), \`daily:<HH:MM>\`, or \`weekly:<0–6>:<HH:MM>\`, with an optional @IANA/timezone`,
    });
  }
  if (terms.costCeilingUsd !== null && (!Number.isFinite(terms.costCeilingUsd) || terms.costCeilingUsd <= 0)) {
    problems.push({ field: "costCeilingUsd", problem: "a positive dollar amount, or absent for no ceiling" });
  }
  if (terms.budgetPerRunMicrousd != null && (!Number.isSafeInteger(terms.budgetPerRunMicrousd) || terms.budgetPerRunMicrousd <= 0)) {
    problems.push({ field: "budgetPerRunMicrousd", problem: "a positive whole micro-dollar amount, or absent for no per-run cap" });
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
    // ONE projection gates the yes (v48 authority repair): a routine that cannot say exactly
    // what would run is unapprovable (v24, same rule as scopes) —
    // restatement is the road. Since v48 that means all four roles: a
    // routine with no frozen route (filed before routing froze, or under a
    // configuration that could not make one exact) cannot be agreed to
    // until it is filed again. The digest is re-derived from the stored
    // terms inside the projection, never trusted as a column (Codex Phase
    // C review, H1): a row whose digest does not match its own terms is
    // not something a person can meaningfully agree to.
    const integrity = routineIntegrity(routine);
    if (!integrity.agents.approvable) {
      return { ok: false as const, reason: integrity.agents.state === "unverified" ? ("changed" as const) : ("profile-unresolved" as const) };
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
/** A firing that must not stand: thrown INSIDE the fire transaction so
 * every row it wrote rolls back, caught at the edge and returned as the
 * outcome it names. Nothing half-fired survives. */
class FiringRolledBack extends Error {
  constructor(readonly outcome: FireOutcome & { ok: false }, readonly page: { subject: string; body: string } | null) {
    super(outcome.detail ?? outcome.reason);
  }
}

export function fireRoutine(
  store: Store,
  routineId: number,
  now: Date,
  options: { manual?: boolean } = {},
): FireOutcome {
  const manual = options.manual === true;
  try {
    return fireRoutineInTransaction(store, routineId, now, manual);
  } catch (error) {
    if (!(error instanceof FiringRolledBack)) throw error;
    // The instance is gone with the transaction; the slot stays due. A
    // scheduled firing pages once per blocking fact (its episode keys on
    // the routine, so a later successful firing resolves it).
    if (!manual && error.page !== null) {
      store.enqueueRoutineEpisode(
        `routine-route:${routineId}`,
        { kind: "routine-blocked", pushClass: "attention", link: `/routines/${routineId}`, subject: error.page.subject, body: error.page.body },
        now.toISOString(),
        now,
      );
    }
    return error.outcome;
  }
}

function fireRoutineInTransaction(store: Store, routineId: number, now: Date, manual: boolean): FireOutcome {
  return store.transact(() => {
    const routine = store.getRoutine(routineId);
    if (routine === null) return { ok: false as const, reason: "no-such-routine" as const };

    // Approval is proved THREE ways: a stamp exists, it matches the stored
    // digest, and — because a digest column can be written by any store
    // caller — the digest is re-derived from the stored terms themselves
    // (Codex Phase C review, H1). Terms edited under a reused digest fire
    // nothing, whatever the columns claim. ONE projection answers (v48 authority repair),
    // read here before anything is written.
    const integrity = routineIntegrity(routine);
    if (!integrity.approved) {
      // Not approved is a plain read: nothing is written, nothing is
      // paged — terms that cannot be read exactly (raw authority repair)
      // refuse here too, leaving the routine, its slots, ledger, tasks,
      // notifications, and next-fire time exactly as they were.
      return {
        ok: false as const,
        reason: "not-approved" as const,
        detail:
          routine.termsProblem != null
            ? `the stored terms cannot be read exactly (${routine.termsProblem}) — file this standing order again`
            : integrity.agents.state === "unverified" && integrity.agents.problem !== null && integrity.agents.problem.startsWith("the stored terms are not ones this code files")
              ? integrity.agents.problem
              : routine.approvedAt === null
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
    // THE FROZEN ROUTE (v48): the instance runs on exactly the four agents
    // the approval sealed — planner, builder, repair, reviewer — copied
    // from the approved snapshot, never recommended afresh. A routine whose
    // approval predates routing (no sealed route) fires nothing: the slot
    // stays due, the operator is paged once, and approving the standing
    // order again — under agents it now names — is the road. No later
    // `config set` can reach a firing.
    // THE FROZEN SNAPSHOT IS RE-HASHED (v48, authority repair) by the same projection: the
    // approved profile and the approved four-role route must read back,
    // hash with the stored terms to the very digest the approver signed —
    // a snapshot column rewritten after the yes fires nothing — carry no
    // stated leg problem, agree with the sealed profile's build and
    // repair pairs, and BE the working pair. Anything short of live
    // refuses HERE — before the slot is read, before a stale pointer is
    // healed, before a blocker is ledgered, before any instance, page, or
    // next-fire time is written (v48 integrity): the refusal rides out of
    // the transaction as a rollback, so the only thing a not-live firing
    // leaves behind is the once-per-episode page at the edge. Two facts
    // are said apart on the page: a snapshot never taken (approved before
    // routing froze) and one whose bytes cannot be read (corrupt). The
    // road is the same — refresh the agents, read them, approve again.
    if (!integrity.live) {
      const state = integrity.agents.state;
      const subject =
        state === "unreadable"
          ? `${routine.name} needs filing again: its frozen agents cannot be read`
          : state === "unfrozen"
            ? `${routine.name} needs approving again: its agents were never frozen`
            : `${routine.name} needs approving again: its frozen agents do not verify`;
      const body =
        state === "unreadable"
          ? `The agents this standing order's approval froze cannot be read back. Open it, refresh its agents from today's configuration, read them, and approve it again; until then its firings wait.`
          : state === "unfrozen"
            ? `This standing order was approved before Standing Orders froze which agents plan, build, repair, and review each firing. Open it, refresh its agents, read the agents it now names, and approve it again; until then its firings wait.`
            : `The agents this standing order's approval froze do not verify (${integrity.liveProblem ?? "the frozen snapshot is not whole"}). Open it, refresh its agents from today's configuration, read them, and approve it again; until then its firings wait.`;
      // A snapshot never taken (approved before routing froze) is a real
      // state a person must act on, and it pages once at the edge. A
      // snapshot whose bytes cannot be read or do not verify is CORRUPTION
      // (atomic authority closure): scheduled or manual, it writes nothing
      // at all — not a page — and the routine page says so in its words.
      throw new FiringRolledBack(
        {
          ok: false,
          reason: "route-unfrozen",
          detail:
            state === "unreadable"
              ? "the agents this standing order's approval froze cannot be read — refresh its agents and approve it again to fire it"
              : state === "unfrozen"
                ? "this standing order was approved before its agents were frozen — refresh its agents and approve it again to fire it"
                : `${integrity.liveProblem ?? "the approved agents do not verify"} — refresh its agents and approve it again to fire it`,
        },
        state === "unfrozen" ? { subject, body } : null,
      );
    }
    const frozenRoute = routine.approvedRoute as PhaseRoute;
    const frozenProfile = routine.approvedProfile as ExecutionProfile;

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

    const frozenBuild = legOf(frozenRoute, "build");
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
    // THE SEAL, OR NOTHING (v48): the instance's approval is real only once
    // the seal copies the frozen route and profile into the approved
    // snapshot and that snapshot reads back as the sealed route. A seal the
    // store refuses (an unreadable route, a profile that disagrees) rolls
    // the whole firing back — no instance, no ledger row, no advanced slot
    // — and says why.
    const sealed = store.sealScopeApproval(taskId, routine.approvedBy ?? "routine", now);
    const sealedRoute = sealed ? store.sealedRouteOf(taskId) : null;
    if (!sealed || sealedRoute === null || !sealedRoute.ok || routeDigestOf(sealedRoute.route) !== routeDigestOf(frozenRoute)) {
      const why = !sealed ? "the store refused to seal the instance's approval" : sealedRoute !== null && !sealedRoute.ok ? sealedRoute.detail : "the sealed route is not the frozen route";
      throw new FiringRolledBack(
        { ok: false, reason: "route-unfrozen", detail: `the instance could not be sealed under the frozen agents (${why}) — nothing fired; file the standing order again` },
        { subject: `${routine.name} could not fire: its frozen agents did not seal`, body: `The firing was rolled back because ${why}. Open the standing order, refresh its agents, and approve it again; until then its firings wait.` },
      );
    }

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

/**
 * THE AGENTS A STANDING ORDER HOLDS (v48), as one honest word per state,
 * read by every surface — the routine page, the CLI, the firing:
 *
 *   frozen      — approved, and the approval's snapshot reads back exact;
 *   pending     — filed with an exact route, awaiting the yes (or the yes
 *                 went stale on an edit);
 *   unfrozen    — approved BEFORE agents were frozen: the approval stands
 *                 on its terms but no firing can run until the agents are
 *                 refreshed and the order approved again;
 *   unreadable  — the row carries route or profile bytes that do not read
 *                 back (corrupt): nothing approves or fires;
 *   unresolved  — filed under a configuration that could not name an
 *                 exact agent for every role (or whose route carries a
 *                 stated problem): refresh once the agents are configured.
 *
 * `refresh` says whether the one recovery road — re-resolve the agents
 * from today's configuration and approve again — applies.
 */
export type RoutineAgentsState = { state: "frozen" | "pending" | "unfrozen" | "unreadable" | "unverified" | "unresolved"; approvable: boolean; refresh: boolean; problem: string | null };

/**
 * THE ONE INTEGRITY PROJECTION (v48 authority repair): every question about a standing
 * order's agents — what the page says, whether a yes may be minted,
 * whether an approval may land, whether a firing may proceed — is answered
 * from this one reading of the row, computed BEFORE any mutation and never
 * from a column alone.
 *
 *   approved  the stamp exists, the digest column matches the stored terms'
 *             digest, and that digest re-derives from the stored terms,
 *             working profile, and working route (a column rewritten under
 *             a reused digest is not an approval).
 *   live      the approval stands AND its frozen snapshot is whole: both
 *             snapshot columns read back, they hash with the stored terms to
 *             the very digest the approver signed, no leg states a problem,
 *             and the build and repair legs are the sealed profile's exact
 *             pairs. Only a live approval fires; nothing else does.
 *   agents    the word every surface uses, with whether a yes could bind
 *             (`approvable`) and whether the one recovery road applies
 *             (`refresh`).
 */
export type RoutineIntegrity = {
  approved: boolean;
  live: boolean;
  /** Why the approval is not live, when it is not — in words a page can show. */
  liveProblem: string | null;
  agents: RoutineAgentsState;
};

/** The FULL row (v48 integrity): every term the digest binds, both
 * snapshot pairs, and the unreadable flags. There is no partial
 * projection — a reading that skipped the re-derivation could call a
 * rewritten row approved. */
type IntegrityRow = Routine;

export function routineIntegrity(routine: IntegrityRow): RoutineIntegrity {
  // THE RAW TERMS FIRST (raw authority repair): a row whose stored terms
  // do not read back exactly — a touch or requirement that is not a
  // string, a rubric entry with a key this code never writes or one that
  // does not parse, a flag or ceiling that is not the shape it was written
  // as — is NOT approved, not live, not approvable, and not refreshable,
  // whatever its columns say: the filtered reading of it must never hash,
  // fire, or be re-filed as if it were the terms the approver read.
  if (routine.termsProblem != null) {
    const problem = `the stored terms cannot be read exactly (${routine.termsProblem}) — file this standing order again`;
    return { approved: false, live: false, liveProblem: null, agents: { state: "unverified", approvable: false, refresh: false, problem } };
  }
  const terms = termsOf(routine);
  // THE SEMANTIC TERMS NEXT (atomic authority closure): terms that read
  // back exactly can still say something this code never files — a
  // single-flight flag of 0, a cost ceiling of −1, a schedule no parser
  // holds, an empty rubric. Every filing door validates these; the
  // projection validates them AGAIN so a rehashed row is never approvable
  // or live on terms the filing door would have refused.
  const semantic = validateRoutineTerms(terms, { name: routine.name });
  if (semantic.length > 0) {
    const problem = `the stored terms are not ones this code files (${semantic.map(one => `${one.field}: ${one.problem}`).join("; ")}) — file this standing order again`;
    return { approved: false, live: false, liveProblem: null, agents: { state: "unverified", approvable: false, refresh: false, problem } };
  }
  const stamped = routine.approvedAt !== null && routine.approvedDigest !== null && routine.approvedDigest === routine.digest;
  const workingRehashes = routineDigestOf(terms, routine.profile ?? null, routine.route ?? null) === routine.digest;
  const approved = stamped && workingRehashes;
  const closed = (state: RoutineAgentsState["state"], problem: string, refresh = true): RoutineIntegrity => ({
    approved,
    live: false,
    liveProblem: approved ? problem : null,
    agents: { state, approvable: false, refresh, problem },
  });
  if (approved) {
    if (routine.approvedRouteUnreadable === true || routine.approvedProfileUnreadable === true) {
      return closed("unreadable", "the agents this approval froze cannot be read back");
    }
    const route = routine.approvedRoute ?? null;
    const profile = routine.approvedProfile ?? null;
    if (route === null || profile === null) return closed("unfrozen", "approved before agents were frozen");
    if (routineDigestOf(terms, profile, route) !== routine.approvedDigest) {
      return closed("unverified", "the approved agents do not hash to the approval this standing order carries");
    }
    // WORKING/APPROVED PARITY (v48 integrity): the approval stands on the
    // stored digest, and that digest binds the WORKING route and profile —
    // so the frozen snapshot must BE the working one, byte for byte. A
    // frozen pair that hashes to the approval while the working pair says
    // something else is a row two authorities wrote; nothing fires on it.
    if (routine.routeUnreadable === true || routine.route == null || routine.profile == null) {
      return closed("unverified", "the approved agents are frozen but the working agents cannot be read back");
    }
    if (routeDigestOf(routine.route) !== routeDigestOf(route) || profileDigestOf(routine.profile) !== profileDigestOf(profile)) {
      return closed("unverified", "the approved agents are not the working agents this standing order files");
    }
    const problems = routeProblems(route);
    if (problems.length > 0) return closed("unresolved", problems.join("; "));
    const build = legOf(route, "build");
    const repair = legOf(route, "repair");
    const repairModel = profile.repairModel === "inherit" ? profile.model : profile.repairModel;
    if (build.provider !== profile.provider || build.model !== profile.model || repair.provider !== profile.provider || repair.model !== repairModel) {
      return closed(
        "unverified",
        `the approved agents (${profile.provider} · ${profile.model}, repair ${profile.provider} · ${repairModel}) disagree with the approved route (${build.provider} · ${build.model}, repair ${repair.provider} · ${repair.model})`,
      );
    }
    return { approved: true, live: true, liveProblem: null, agents: { state: "frozen", approvable: false, refresh: false, problem: null } };
  }
  if (routine.routeUnreadable === true) return closed("unreadable", "the filed agents cannot be read back");
  const route = routine.route ?? null;
  const profile = routine.profile ?? null;
  if (route === null || profile === null) return closed("unresolved", "this standing order does not name an exact agent for every role");
  const problems = routeProblems(route);
  if (problems.length > 0) return closed("unresolved", problems.join("; "));
  if (!workingRehashes) return closed("unverified", "the filed terms do not hash to this standing order's reference — file it again");
  // BUILD/REPAIR PARITY BEFORE THE YES (atomic authority closure): the
  // pending pair must agree exactly as the approved pair must — a working
  // profile of claude · sonnet beside a rehashed route that builds on
  // codex is a row two authorities wrote, and no yes lands on it.
  const build = legOf(route, "build");
  const repair = legOf(route, "repair");
  const repairModel = profile.repairModel === "inherit" ? profile.model : profile.repairModel;
  if (build.provider !== profile.provider || build.model !== profile.model || repair.provider !== profile.provider || repair.model !== repairModel) {
    return closed(
      "unverified",
      `the filed agents (${profile.provider} · ${profile.model}, repair ${profile.provider} · ${repairModel}) disagree with the filed route (${build.provider} · ${build.model}, repair ${repair.provider} · ${repair.model}) — refresh the agents and file again`,
    );
  }
  return { approved: false, live: false, liveProblem: null, agents: { state: "pending", approvable: true, refresh: false, problem: null } };
}

/** The agents word every surface uses — one reading of the projection. */
export function routineAgentsState(routine: IntegrityRow): RoutineAgentsState {
  return routineIntegrity(routine).agents;
}

export type RefreshRoutineResult =
  | { ok: true; routine: Routine; changed: boolean }
  | { ok: false; reason: "no-such-routine" | "unresolved"; problem: string };

/**
 * THE RECOVERY ROAD (v48): re-resolve a standing order's agents — the
 * four-role route and the profile that restates its build and repair legs
 * — from today's configuration, and file them as the order's WORKING
 * agents under a digest that binds them. Nothing is approved here: a
 * refreshed order reads "edited — approve again", the approver reads the
 * exact agents it now names and agrees to them with the password, and
 * only that yes freezes the snapshot a firing copies. A routine whose
 * terms already bind these exact agents is left byte-for-byte alone.
 * A configuration that still cannot name an exact, runnable agent for
 * every role answers with the words and changes nothing.
 */
export function refreshRoutineAgents(store: Store, routineId: number, now: Date): RefreshRoutineResult {
  return store.transact(() => {
    const routine = store.getRoutine(routineId);
    if (routine === null) return { ok: false as const, reason: "no-such-routine" as const, problem: "no such routine" };
    // Terms that do not read back exactly are never re-filed from their
    // filtered reading (raw authority repair): the refresh refuses in
    // words and writes nothing.
    if (routine.termsProblem != null) {
      return { ok: false as const, reason: "unresolved" as const, problem: `the stored terms cannot be read exactly (${routine.termsProblem}) — file this standing order again` };
    }
    // Terms this code never files (a single-flight flag of 0, a negative
    // ceiling) are not re-filed either (atomic authority closure): the
    // refresh cannot mend terms, and rehashing them would only launder
    // the corruption into a digest a person could sign.
    const semantic = validateRoutineTerms(termsOf(routine), { name: routine.name });
    if (semantic.length > 0) {
      return { ok: false as const, reason: "unresolved" as const, problem: `the stored terms are not ones this code files (${semantic.map(one => `${one.field}: ${one.problem}`).join("; ")}) — file this standing order again` };
    }
    const authority = resolveRoutineAuthority(store, routine.repo, routine.acceptance, now);
    if (!authority.ok) return { ok: false as const, reason: "unresolved" as const, problem: authority.problem };
    const terms = termsOf(routine);
    const digest = routineDigestOf(terms, authority.profile, authority.route);
    // The projection is read BEFORE any write (v48 authority repair): an approval that is
    // not live — never frozen, unreadable, or a snapshot that no longer
    // verifies — is WITHDRAWN here, even when the working agents already
    // bind these exact terms, so a corrupt frozen snapshot can never keep
    // reading as approved. A live approval under unchanged terms is left
    // byte-for-byte alone.
    const integrity = routineIntegrity(routine);
    const unchanged = digest === routine.digest && routine.route != null && routine.profile != null && !routine.routeUnreadable;
    if (unchanged && (integrity.live || !integrity.approved) && integrity.agents.state !== "unverified") {
      return { ok: true as const, routine, changed: false };
    }
    if (integrity.approved && !integrity.live) store.withdrawRoutineApproval(routineId, now);
    if (!unchanged || integrity.agents.state === "unverified") {
      store.updateRoutineTerms(routineId, { ...terms, digest, profile: authority.profile, route: authority.route }, now);
    }
    return { ok: true as const, routine: store.getRoutine(routineId) as Routine, changed: true };
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
export function routineAgentsWords(routine: Routine): string[] {
  const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
  const agents = routineAgentsState(routine);
  const route = approved ? routine.approvedRoute ?? null : routine.route ?? null;
  if (route === null || agents.state === "unreadable" || agents.state === "unresolved" || agents.state === "unverified") {
    return [
      `  agents       ${agents.state === "unreadable" ? "cannot be read" : agents.state === "unfrozen" ? "not frozen" : agents.state === "unverified" ? "do not verify" : "not resolved"} — ${agents.problem ?? "this standing order does not name an exact agent for every role"}`,
      `               refresh them with \`routine refresh <name>\`, read the agents it then names, and approve it again`,
    ];
  }
  return [
    `  agents       ${agentsSummary(route)} — ${postureWords(route)}`,
    ...(approved ? [`               frozen by the approval: a configuration change cannot re-route a firing`] : [`               frozen when you approve: a configuration change cannot re-route a firing`]),
  ];
}
