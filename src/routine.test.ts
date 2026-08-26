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

const V24_PROFILE = {
  provider: "claude" as const,
  model: "sonnet",
  permissionArgv: "acceptEdits" as const,
  maxTurns: 40, repairMaxTurns: 4, timeoutSeconds: 1800, repairTimeoutSeconds: 300,
  repairModel: "inherit",
};

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
      { name, ...terms, digest: routineDigestOf(terms, V24_PROFILE), profile: V24_PROFILE },
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
    expect(store.createRoutine({ name: "deps", ...TERMS, digest: routineDigestOf(TERMS, V24_PROFILE), profile: V24_PROFILE }, T0)).toMatchObject({
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

describe("the review's regressions (Codex Phase C findings)", () => {
  let store: Store;
  let token: string;
  let routineId: number;

  const create = (terms: RoutineTerms = TERMS, name = "deps") => {
    const created = store.createRoutine({ name, ...terms, digest: routineDigestOf(terms, V24_PROFILE), profile: V24_PROFILE }, T0);
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

  test("H1: terms edited under a REUSED digest fire nothing — the digest is re-derived, not trusted", () => {
    approve(routineId);
    // A store-API caller smuggles new terms while presenting the digest the
    // operator approved. The columns now agree with each other and lie
    // about the terms.
    const smuggled = { ...TERMS, goal: "Wire the money elsewhere", schedule: "every:5" };
    store.updateRoutineTerms(routineId, { ...smuggled, digest: routineDigestOf(TERMS) }, later(MINUTE));

    const refused = fireRoutine(store, routineId, later(2 * HOUR));
    expect(refused).toMatchObject({ ok: false, reason: "not-approved" });
    expect(store.listTasks()).toHaveLength(0);

    // Approval over a lying row refuses the same way.
    const reapprove = approveRoutine(store, routineId, "alex", later(MINUTE), routineDigestOf(TERMS), token);
    expect(reapprove).toMatchObject({ ok: false, reason: "changed" });
  });

  test("H2: a live claim blocks single-flight whatever the task's state string says", async () => {
    const { acquire } = await import("./claim.js");
    approve(routineId);
    const fired = fireRoutine(store, routineId, later(HOUR));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;

    // A runner takes the instance; the provider is live.
    const ref = store.refFor(BUILT_IN, fired.taskId);
    const taken = acquire(store, ref.id, "builder-1", { now: later(HOUR + MINUTE), ttlMs: 60 * MINUTE });
    expect(taken.ok).toBe(true);

    // Somebody writes 'done' over it with the generic state command,
    // bypassing the guarded cancel. The claim is still live — no twin.
    store.setTaskState(fired.taskId, "done", later(HOUR + 2 * MINUTE));
    const skipped = fireRoutine(store, routineId, later(2 * HOUR));
    expect(skipped).toMatchObject({ ok: false, reason: "single-flight" });
  });

  test("M1: run-now landing exactly on the due instant cannot strand the schedule", () => {
    approve(routineId);
    const due = store.getRoutine(routineId)?.nextFireAt as string;

    // The manual fire at the exact due moment takes a MANUAL ledger key.
    const manual = fireRoutine(store, routineId, new Date(due), { manual: true });
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;
    store.setTaskState(manual.taskId, "done", later(HOUR + MINUTE));

    // The scheduled slot is still open: the pass fires it and advances.
    const scheduled = fireRoutine(store, routineId, later(HOUR + 2 * MINUTE));
    expect(scheduled.ok).toBe(true);
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
  });

  test("M1: a stale scheduled pointer heals — slot-taken advances past the recorded slot", () => {
    approve(routineId);
    const due = store.getRoutine(routineId)?.nextFireAt as string;
    // The slot is already on the ledger (a crash between insert and
    // advance, or an older bug): the refusal must move the pointer.
    store.recordRoutineFire(
      { routineId, scheduledFor: due, outcome: "fired", reason: null, instanceTaskRef: null },
      later(HOUR),
    );
    const refused = fireRoutine(store, routineId, later(HOUR + MINUTE));
    expect(refused).toMatchObject({ ok: false, reason: "slot-taken" });
    expect(store.getRoutine(routineId)?.nextFireAt).toBe(later(2 * HOUR).toISOString());
    // And the next pass is back on the grid.
    expect(fireRoutine(store, routineId, later(2 * HOUR)).ok).toBe(true);
  });

  test("M2: the budget window anchors to when money could move, not when the run row opened", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // The run row was opened EIGHT days before this firing's window, but
    // its provider started inside the window and never recorded a cost:
    // it is unmeasured spend inside the window, and it blocks.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run = store.startRun({
      taskRef: ref.id, leaseId: "old-lease", runner: "r1",
      branch: "b", worktree: "w", now: new Date(T0.getTime() - 8 * DAY),
    });
    store.stampProviderStart(run, later(HOUR));
    const blocked = fireRoutine(store, routineId, later(2 * HOUR));
    expect(blocked).toMatchObject({ ok: false, reason: "unmeasured" });
  });

  test("L1: a recurrence AFTER recovery pages again — resolved history does not gag the pager", () => {
    approve(routineId);
    const first = fireRoutine(store, routineId, later(HOUR));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.setTaskState(first.taskId, "done", later(HOUR + MINUTE));

    // Episode one: an unmeasured paid run blocks and pages.
    const ref = store.refFor(BUILT_IN, first.taskId);
    const run1 = store.startRun({ taskRef: ref.id, leaseId: "l1", runner: "r1", branch: "b", worktree: "w", now: later(HOUR) });
    store.stampProviderStart(run1, later(HOUR));
    expect(fireRoutine(store, routineId, later(2 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    // Still episode one: a second blocked slot does not page twice.
    expect(fireRoutine(store, routineId, later(3 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(1);

    // Recovery: the cost lands small, the next slot fires, episodes resolve.
    store.recordUsage(run1, { costUsd: 0.1 });
    const recovered = fireRoutine(store, routineId, later(4 * HOUR));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    store.setTaskState(recovered.taskId, "done", later(4 * HOUR + MINUTE));

    // Episode two: a NEW unmeasured run blocks again — and pages again.
    const ref2 = store.refFor(BUILT_IN, recovered.taskId);
    const run2 = store.startRun({ taskRef: ref2.id, leaseId: "l2", runner: "r1", branch: "b", worktree: "w", now: later(4 * HOUR) });
    store.stampProviderStart(run2, later(4 * HOUR));
    expect(fireRoutine(store, routineId, later(5 * HOUR))).toMatchObject({ ok: false, reason: "unmeasured" });
    expect(store.listNotifications("all").filter(one => one.kind === "routine-blocked")).toHaveLength(2);
  });

  test("M4: a template that asks for concurrent instances is refused at validation", () => {
    const problems = validateRoutineTerms({ ...TERMS, singleFlight: false });
    expect(problems.map(one => one.field)).toContain("singleFlight");
  });
});
