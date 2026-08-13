/**
 * Routines: the schedule algebra, the template digest, and — the part that
 * matters — the one store-owned fire transaction that re-proves approval,
 * pause, due-ness, single-flight, and budget before any write (Codex
 * planning/routines review, findings 4, 5, 9, 10).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover, approvalOf } from "./scope.js";
import {
  approveRoutine,
  describeSchedule,
  fireRoutine,
  firstFireAt,
  instanceId,
  nextFireAt,
  parseSchedule,
  routineDigestOf,
  validateRoutineTerms,
  type RoutineTerms,
} from "./routine.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("the schedule algebra", () => {
  test("parses the two shapes and refuses everything else", () => {
    expect(parseSchedule("every:60")).toEqual({ kind: "every", minutes: 60 });
    expect(parseSchedule("daily:03:30")).toEqual({ kind: "daily", hhmm: "03:30" });
    expect(parseSchedule("every:4")).toBeNull(); // under the 5-minute floor
    expect(parseSchedule("every:999999")).toBeNull();
    expect(parseSchedule("daily:24:00")).toBeNull();
    expect(parseSchedule("daily:9:30")).toBeNull(); // zero-padded or nothing
    expect(parseSchedule("cron:* * * * *")).toBeNull();
  });

  test("says what it means in words", () => {
    expect(describeSchedule({ kind: "every", minutes: 90 })).toBe("every 90 minutes");
    expect(describeSchedule({ kind: "every", minutes: 120 })).toBe("every 2 hour(s)");
    expect(describeSchedule({ kind: "every", minutes: 2880 })).toBe("every 2 day(s)");
    expect(describeSchedule({ kind: "daily", hhmm: "03:30" })).toBe("daily at 03:30 UTC");
  });

  test("advances aligned: strictly after now, anchored to the fired slot", () => {
    const every = { kind: "every" as const, minutes: 60 };
    const anchor = T0.toISOString();
    // On time: exactly one interval later.
    expect(nextFireAt(every, anchor, T0)).toBe(later(HOUR).toISOString());
    // A pass 10 minutes late does not tilt the grid.
    expect(nextFireAt(every, anchor, later(10 * MINUTE))).toBe(later(HOUR).toISOString());
    // Down for five slots: ONE overdue firing was taken by the caller; the
    // next lands on the grid strictly after now — no backfill burst.
    expect(nextFireAt(every, anchor, later(5 * HOUR + 10 * MINUTE))).toBe(later(6 * HOUR).toISOString());
    // Landing exactly on an occurrence: that one already fired; take the next.
    expect(nextFireAt(every, anchor, later(2 * HOUR))).toBe(later(3 * HOUR).toISOString());
  });

  test("daily aligns to the clock, not to when the pass happened to run", () => {
    const daily = { kind: "daily" as const, hhmm: "03:30" };
    // T0 is 22:00 UTC — the next 03:30 is tomorrow.
    expect(nextFireAt(daily, T0.toISOString(), T0)).toBe("2026-08-14T03:30:00.000Z");
    expect(firstFireAt(daily, new Date("2026-08-13T02:00:00.000Z"))).toBe("2026-08-13T03:30:00.000Z");
    // Exactly at 03:30, that occurrence is past — tomorrow's fires next.
    expect(firstFireAt(daily, new Date("2026-08-13T03:30:00.000Z"))).toBe("2026-08-14T03:30:00.000Z");
  });

  test("the instance id carries the slot it satisfied", () => {
    expect(instanceId("deps", "2026-08-13T22:00:00.000Z")).toBe("deps-20260813-2200");
  });
});

const TERMS: RoutineTerms = {
  repo: "/work/repo",
  goal: "Refresh the dependency lockfile and note anything major",
  outOfScope: "No version bumps beyond patch",
  touches: ["package.json"],
  requirements: [],
  schedule: "every:60",
  singleFlight: true,
  costCeilingUsd: 10,
};

describe("the template digest", () => {
  test("binds every term, not just the scope trio", () => {
    const base = routineDigestOf(TERMS);
    expect(routineDigestOf({ ...TERMS, schedule: "every:30" })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, costCeilingUsd: null })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, repo: "/other" })).not.toBe(base);
    expect(routineDigestOf({ ...TERMS, requirements: ["env:KEY"] })).not.toBe(base);
    // Order of paths is presentation, not meaning.
    expect(
      routineDigestOf({ ...TERMS, touches: ["b", "a"] }),
    ).toBe(routineDigestOf({ ...TERMS, touches: ["a", "b"] }));
  });

  test("validation names every problem at once", () => {
    const problems = validateRoutineTerms({
      ...TERMS,
      goal: "",
      schedule: "hourly",
      requirements: ["not-a-key"],
      costCeilingUsd: -1,
    });
    expect(problems.map(one => one.field).sort()).toEqual([
      "costCeilingUsd", "goal", "requirements", "schedule",
    ]);
  });
});

describe("firing, inside one proving transaction", () => {
  let store: Store;
  let token: string;
  let routineId: number;

  const create = (terms: RoutineTerms = TERMS, name = "deps") => {
    const created = store.createRoutine(
      { name, ...terms, digest: routineDigestOf(terms) },
      T0,
    );
    if (!created.ok) throw new Error("duplicate routine in test setup");
    return created.id;
  };

  const approve = (id: number, at: Date = T0) => {
    const approved = approveRoutine(store, id, "alex", at, store.getRoutine(id)?.digest ?? "", token);
    expect(approved.ok).toBe(true);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver setup failed");
    token = added.token;
    routineId = create();
  });

  afterEach(() => store.close());

  test("nothing fires until a person agrees to the template", () => {
    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(store.routineFires(routineId)).toHaveLength(0);
  });

  test("approval binds the digest and arms the schedule from the yes", () => {
    const stale = approveRoutine(store, routineId, "alex", T0, "wrong-digest", token);
    expect(stale).toMatchObject({ ok: false, reason: "changed" });

    approve(routineId);
    const routine = store.getRoutine(routineId);
    expect(routine?.approvedBy).toBe("alex");
    expect(routine?.nextFireAt).toBe(later(HOUR).toISOString());
  });

  test("an edit after approval strands the yes — the firing refuses", () => {
    approve(routineId);
    const edited = { ...TERMS, goal: "Something the approver never read" };
    store.updateRoutineTerms(routineId, { ...edited, digest: routineDigestOf(edited) }, later(MINUTE));

    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(refused).toMatchObject({ detail: expect.stringContaining("edited") });
  });

  test("a due firing spawns a placed, linked, requirement-carrying, APPROVED instance", () => {
    const terms = { ...TERMS, requirements: ["env:GITHUB_TOKEN"] };
    const withReqs = create(terms, "audit");
    approve(withReqs);

    const fired = fireRoutine(store, withReqs, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    expect(fired.taskId).toBe("audit-20260813-2300");

    const task = store.getTask(fired.taskId);
    expect(task?.state).toBe("queued");
    const ref = store.refFor(BUILT_IN, fired.taskId);
    expect(ref.repo).toBe("/work/repo");
    expect(ref.routineId).toBe(withReqs);
    expect(ref.capabilityRequirements).toEqual(["env:GITHUB_TOKEN"]);
    expect(ref.origin).toBe("ours");

    // The scope is the template's terms byte for byte, and it is APPROVED —
    // by the person who approved the template, not by any caller's say-so.
    const scope = store.getScope(fired.taskId);
    expect(scope?.goal).toBe(terms.goal);
    expect(scope?.outOfScope).toBe(terms.outOfScope);
    expect(approvalOf(scope)).toMatchObject({ approved: true, by: "alex" });

    // The ledger has the slot; the schedule advanced strictly past now.
    const fires = store.routineFires(withReqs);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ outcome: "fired", scheduledFor: later(HOUR).toISOString() });
    expect(store.getRoutine(withReqs)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
  });

  test("early is not due, and a recorded slot cannot fire twice", () => {
    approve(routineId);
    expect(fireRoutine(store, routineId, later(30 * MINUTE))).toMatchObject({ ok: false, reason: "not-due" });

    expect(fireRoutine(store, routineId, later(HOUR)).ok).toBe(true);
    // The same slot again — as if two passes raced: the ledger's unique
    // slot answers, whatever the schedule column says.
    store.setRoutineNextFire(routineId, later(HOUR).toISOString(), later(HOUR));
    expect(fireRoutine(store, routineId, later(HOUR + MINUTE))).toMatchObject({ ok: false, reason: "slot-taken" });
  });

  test("downtime fires ONCE and re-aligns — no backfill burst", () => {
    approve(routineId);
    // The daemon slept through five slots. One overdue firing happens...
    const fired = fireRoutine(store, routineId, later(6 * HOUR + 10 * MINUTE));
    expect(fired.ok).toBe(true);
    // ...for the slot that was due, and the next lands on the grid ahead.
    expect(store.routineFires(routineId)[0]?.scheduledFor).toBe(later(HOUR).toISOString());
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(7 * HOUR).toISOString());
    // Nothing else is due — the missed slots are gone, not queued.
    expect(fireRoutine(store, routineId, later(6 * HOUR + 11 * MINUTE))).toMatchObject({ ok: false, reason: "not-due" });
  });

  test("single-flight: an unfinished instance skips the slot, on the ledger, and pages ONCE", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The instance never finished. The next two slots skip — recorded as
    // hollow dots — and the stuck instance pages exactly once.
    const skipped = fireRoutine(store, routineId, later(2 * HOUR));
    expect(skipped).toMatchObject({ ok: false, reason: "single-flight" });
    const again = fireRoutine(store, routineId, later(3 * HOUR));
    expect(again).toMatchObject({ ok: false, reason: "single-flight" });

    const fires = store.routineFires(routineId);
    expect(fires.map(one => one.outcome)).toEqual(["skipped", "skipped", "fired"]);
    expect(fires[0]?.reason).toContain("single-flight");
    const pages = store.listNotifications("all").filter(one => one.kind === "routine-blocked");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.subject).toContain("stuck");

    // The blocker finishes; the next slot fires and the episode resolves.
    store.setTaskState(first.taskId, "done", later(3 * HOUR + MINUTE));
    const resumed = fireRoutine(store, routineId, later(4 * HOUR));
    expect(resumed.ok).toBe(true);
    const open = store.listNotifications("pending").filter(one => one.kind === "routine-blocked");
    expect(open).toHaveLength(0);
  });

  test("budget fails closed: measured overspend skips, and an unmeasured paid run blocks outright", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // A paid run with no recorded cost: the ceiling cannot be honestly
    // enforced, so the track blocks as UNMEASURED, not as headroom.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run = store.startRun({
      taskRef: ref.id, leaseId: "lease-1", runner: "r1",
      branch: "b", worktree: "w", now: later(HOUR),
    });
    store.stampProviderStart(run, later(HOUR));
    const unmeasured = fireRoutine(store, routineId, later(2 * HOUR));
    expect(unmeasured).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").some(one => one.subject.includes("unmeasured"))).toBe(true);

    // The cost lands, over the ceiling: now it is a plain budget skip.
    store.recordUsage(run, { costUsd: 12.5 });
    const over = fireRoutine(store, routineId, later(3 * HOUR));
    expect(over).toMatchObject({ ok: false, reason: "budget" });
    const fires = store.routineFires(routineId);
    expect(fires.map(one => one.outcome)).toEqual(["skipped", "skipped", "fired"]);
    expect(store.listNotifications("all").some(one => one.subject.includes("budget"))).toBe(true);

    // No ceiling, no budget gate: the same spend fires freely.
    const unbounded = { ...TERMS, costCeilingUsd: null };
    const free = create(unbounded, "free");
    approve(free, later(3 * HOUR));
    expect(fireRoutine(store, free, later(4 * HOUR + MINUTE)).ok).toBe(true);
  });

  test("run-now is a manual fire: same proofs, no ledger noise on refusal, schedule untouched", () => {
    approve(routineId);
    const scheduled = store.getRoutine(routineId)?.nextFireAt;

    const manual = fireRoutine(store, routineId, later(10 * MINUTE), { manual: true });
    expect(manual.ok).toBe(true);
    // The scheduled occurrence still stands — run-now is extra, not instead.
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(scheduled);
    expect(store.routineFires(routineId)[0]?.outcome).toBe("fired");

    // A manual fire against a blocker refuses to the person's face and
    // records nothing — there is no slot to ledger and nobody to page.
    const refused = fireRoutine(store, routineId, later(20 * MINUTE), { manual: true });
    expect(refused).toMatchObject({ ok: false, reason: "single-flight" });
    expect(store.routineFires(routineId)).toHaveLength(1);
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(0);

    // Paused refuses even by hand — pausing means stopped, not "stopped
    // unless somebody clicks harder".
    store.setRoutinePaused(routineId, true, later(21 * MINUTE));
    expect(fireRoutine(store, routineId, later(22 * MINUTE), { manual: true })).toMatchObject({
      ok: false,
      reason: "paused",
    });
  });

  test("two standing orders cannot share a name", () => {
    expect(store.createRoutine({ name: "deps", ...TERMS, digest: routineDigestOf(TERMS) }, T0)).toMatchObject({
      ok: false,
      reason: "duplicate",
    });
  });

  test("dueRoutines nominates only approved, unpaused, due work in this repo", () => {
    approve(routineId);
    const elsewhere = create({ ...TERMS, repo: "/elsewhere" }, "other-repo");
    approve(elsewhere);
    const pausedId = create({ ...TERMS }, "paused-one");
    approve(pausedId);
    store.setRoutinePaused(pausedId, true, later(MINUTE));
    create({ ...TERMS }, "never-approved");

    const due = store.dueRoutines("/work/repo", later(2 * HOUR));
    expect(due.map(one => one.name)).toEqual(["deps"]);
  });
});
