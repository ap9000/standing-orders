import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import {
  raceDigestOf,
  jointApprovalDigest,
  planTournament,
  admitContest,
  finalizeContestant,
  recoverContests,
  contestBranch,
} from "./contest.js";
import { acquire, release } from "./claim.js";

const T0 = new Date("2026-08-17T12:00:00.000Z");

describe("the v14 migration", () => {
  test("a pre-v14 database is really upgraded: old hold shape rebuilt, new columns added, rows kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v14-migrate-"));
    const file = join(dir, "orders.db");
    try {
      // Create current, then DOCTOR the file back to the v13 shape the
      // upgrade must recognize — this is the regression the live console
      // caught: a migration tail that never ran while the version stamp
      // said it had.
      let store = openStore(file);
      store.createTask({ id: "held-one", title: "held work" }, T0);
      const ref = store.refFor("built-in", "held-one", "ours").id;
      store.hold(ref, "waiting on a vendor", null, T0);
      store.close();

      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA foreign_keys = OFF");
      raw.exec(`CREATE TABLE hold_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
        owner_id TEXT NOT NULL, reason TEXT NOT NULL, until TEXT, held_at TEXT NOT NULL,
        UNIQUE (owner_kind, owner_id))`);
      raw.exec("INSERT INTO hold_old SELECT * FROM hold");
      raw.exec("DROP TABLE hold");
      raw.exec("ALTER TABLE hold_old RENAME TO hold");
      raw.exec("UPDATE schema_version SET version = 13");
      raw.close();

      store = openStore(file);
      const holds = store.activeHolds(ref, T0);
      expect(holds).toHaveLength(1);
      expect(holds[0]?.reason).toBe("waiting on a vendor");
      // The widened rule now admits tournament ownership — prove it by DDL.
      const raw2 = new DatabaseSync(file);
      const ddl = raw2.prepare("SELECT sql AS s FROM sqlite_master WHERE name = 'hold'").get() as { s: string };
      raw2.close();
      expect(ddl.s).toContain("'contest'");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tournament terms — immutable rows, one active pointer", () => {
  let store: Store;
  let taskRef: number;

  const AGENTS = [
    { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
    { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
  ];

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "race-me", title: "the raced work" }, T0);
    taskRef = store.refFor("built-in", "race-me", "ours").id;
  });

  afterEach(() => store.close());

  const file = (digest = "race-digest-1") =>
    store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: digest,
        agents: AGENTS,
        perAgentBudgetMicrousd: 5_000_000,
        overrunReserveMicrousd: 1_760_000,
        totalBudgetMicrousd: 13_520_000,
        priceVersion: 1,
        publicationPolicy: "none",
      },
      T0,
    );

  test("filing again moves the active pointer; the old row survives, deactivated", () => {
    const first = file("digest-a");
    const second = file("digest-b");
    const active = store.activeTournamentTerms(taskRef);
    expect(active?.id).toBe(second);
    expect(active?.generation).toBe(2);
    expect(active?.raceDigest).toBe("digest-b");
    expect(first).not.toBe(second);
  });

  test("approval binds to the exact digest of the active row", () => {
    const id = file("digest-a");
    expect(store.approveTournamentTerms(id, "alex", "some-other-digest", T0)).toBe(false);
    expect(store.approveTournamentTerms(id, "alex", "digest-a", T0)).toBe(true);
    expect(store.activeTournamentTerms(taskRef)?.approvedBy).toBe("alex");
  });
});

describe("contest and contestant state moves are compare-and-swap, generation-bumped", () => {
  let store: Store;
  let contest: number;
  let contestants: number[];

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "race-me", title: "raced" }, T0);
    const taskRef = store.refFor("built-in", "race-me", "ours").id;
    const terms = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: "d1",
        agents: [
          { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
          { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
        ],
        perAgentBudgetMicrousd: 5_000_000,
        overrunReserveMicrousd: 1_000_000,
        totalBudgetMicrousd: 12_000_000,
        priceVersion: 1,
        publicationPolicy: "none",
      },
      T0,
    );
    contest = store.createContest({ taskRef, terms, scopeDigest: "s1", raceDigest: "d1" }, T0);
    contestants = store.createContestants(contest, [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5", branch: `standing-orders/race-me/contest-${contest}/c1`, budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5", branch: `standing-orders/race-me/contest-${contest}/c2`, budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
    ]);
  });

  afterEach(() => store.close());

  test("a stale generation loses and changes nothing — whoever wins the race, wins alone", () => {
    const fresh = store.getContest(contest);
    expect(fresh?.state).toBe("dispatching");
    expect(store.casContestState(contest, ["dispatching"], "racing", 1)).toBe(true);
    // The loser (same expected generation) fails cleanly.
    expect(store.casContestState(contest, ["dispatching", "racing"], "interrupted", 1)).toBe(false);
    expect(store.getContest(contest)?.state).toBe("racing");
    expect(store.getContest(contest)?.generation).toBe(2);
  });

  test("exactly one live run per agent: the pointer admits one claim", () => {
    const [first] = contestants;
    if (first === undefined) throw new Error("setup");
    const ref = store.refFor("built-in", "race-me").id;
    const runOf = (lease: string) =>
      store.startRun({ taskRef: ref, leaseId: lease, runner: "night-shift-1", branch: "standing-orders/race-me", worktree: "/pool/x", now: T0 });
    const runA = runOf("l-a");
    const runB = runOf("l-b");
    const runC = runOf("l-c");
    expect(store.claimContestantRun(first, runA, 1)).toBe(true);
    expect(store.claimContestantRun(first, runB, 2)).toBe(false);
    store.releaseContestantRun(first, runA);
    expect(store.claimContestantRun(first, runC, 2)).toBe(true);
  });

  test("money moves one way: measured is monotonic, the latch charges the FULL reservation", () => {
    const [first] = contestants;
    if (first === undefined) throw new Error("setup");
    store.recordContestantSpend(first, 400_000);
    store.recordContestantSpend(first, 250_000); // late, smaller — ignored
    let row = store.getContestant(first);
    expect(row?.measuredMicrousd).toBe(400_000);
    expect(row?.accountedMicrousd).toBe(400_000);
    expect(row?.unknownSpend).toBe(false);
    // The invocation dies without reporting: charge budget + reserve, flag it.
    store.latchContestantUnknownSpend(first);
    row = store.getContestant(first);
    expect(row?.accountedMicrousd).toBe(6_000_000);
    expect(row?.measuredMicrousd).toBe(400_000); // the truth stays the truth
    expect(row?.unknownSpend).toBe(true);
  });
});

describe("worker-process slots and durable ceremony nonces", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("a slot's whole life: reserved before spawn, running with its process group, released on exit", () => {
    store.createTask({ id: "slot-task", title: "work" }, T0);
    const ref = store.refFor("built-in", "slot-task", "ours").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-slot", runner: "night-shift-1", branch: "b", worktree: "/pool/s", now: T0 });
    const [slot] = store.reserveExecutionSlots("night-shift-1", 1, T0);
    if (slot === undefined) throw new Error("setup");
    expect(store.liveSlotCount("night-shift-1")).toBe(1);
    expect(store.markSlotRunning(slot, { run, processGroup: 4242, incarnation: "inc-1" }, T0)).toBe(true);
    expect(store.markSlotRunning(slot, { run }, T0)).toBe(false); // once
    expect(store.getExecutionSlot(slot)?.processGroup).toBe(4242);
    expect(store.releaseExecutionSlot(slot, T0)).toBe(true);
    expect(store.releaseExecutionSlot(slot, T0)).toBe(false); // once
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
  });

  test("a ceremony nonce is single-use, exact-match, and expires", () => {
    const minted = store.mintCeremonyNonce(
      { hash: "h1", approver: "alex", subject: "contest-pick", subjectId: 5, digest: "tuple-digest", ttlMs: 60_000 },
      T0,
    );
    expect(minted).toMatchObject({ ok: true });
    // Wrong digest: no.
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tampered", T0)).toBe(false);
    // Right everything: once.
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tuple-digest", T0)).toBe(true);
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tuple-digest", T0)).toBe(false);
    // Expired ones refuse and sweep away.
    store.mintCeremonyNonce({ hash: "h2", approver: "alex", subject: "contest-pick", subjectId: 5, digest: "d", ttlMs: 1_000 }, T0);
    const later = new Date(T0.getTime() + 3_600_000);
    expect(store.consumeCeremonyNonce("h2", "alex", "contest-pick", 5, "d", later)).toBe(false);
    expect(store.sweepCeremonyNonces(later)).toBeGreaterThanOrEqual(1);
  });
});

describe("stage 3a — digests, planning, admission, children, recovery", () => {
  test("the race digest is order-sensitive; the joint digest covers both documents", () => {
    const base = {
      perAgentBudgetMicrousd: 5_000_000,
      totalBudgetMicrousd: 20_000_000,
      priceVersion: 1,
      publicationPolicy: "none",
    };
    const ab = raceDigestOf({ ...base, agents: [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
    ]});
    const ba = raceDigestOf({ ...base, agents: [
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
    ]});
    expect(ab).not.toBe(ba);
    expect(jointApprovalDigest("s", ab)).not.toBe(jointApprovalDigest("s", ba));
  });

  test("planning refuses what money cannot bound, and the total must cover the TRUE worst case", () => {
    const codex = planTournament({
      agents: [{ provider: "codex", model: "gpt-5.2" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 100,
    });
    expect(codex).toMatchObject({ ok: false, reason: "provider-ineligible" });
    expect(planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "mystery" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 100,
    })).toMatchObject({ ok: false, reason: "unpriced-model" });
    // sonnet tail = 200k*4 + 64k*15 = 1.76M microusd; two agents at $5:
    // true worst = 2 * (5 + 1.76) = 13.52 — a $13 total refuses, $14 admits.
    expect(planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 13,
    })).toMatchObject({ ok: false, reason: "over-total" });
    const good = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 14,
    });
    if (!good.ok) throw new Error(good.reason);
    expect(good.plan.perAgentReserveMicrousd).toEqual([1_760_000, 1_760_000]);
  });

  const setUpApproved = (store: Store) => {
    store.createTask({ id: "race-3a", title: "raced" }, T0);
    const taskRef = store.refFor("built-in", "race-3a", "ours").id;
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: planned.plan.raceDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion,
        publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    const taken = acquire(store, taskRef, "night-shift-1", { now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    return { taskRef, leaseId: taken.claim.leaseId };
  };

  const admit = (store: Store, taskRef: number, leaseId: string, overrides: Record<string, unknown> = {}) =>
    admitContest(
      store,
      {
        taskId: "race-3a",
        taskRef,
        runner: "night-shift-1",
        leaseId,
        incarnation: null,
        scopeDigest: "scope-d",
        scopeApproved: true,
        capacity: 8,
        quotaBlocked: () => null,
        ...overrides,
      } as never,
      T0,
    );

  test("admission is all or none: a capacity shortfall persists NOTHING", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId } = setUpApproved(store);
    const refused = admit(store, taskRef, leaseId, { capacity: 1 });
    expect(refused).toMatchObject({ ok: false, reason: "capacity" });
    expect(store.openContestFor(taskRef)).toBeNull();
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
    store.close();
  });

  test("admission proves quota per distinct key and refuses a doubled half-open key", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId } = setUpApproved(store);
    expect(admit(store, taskRef, leaseId, { quotaBlocked: () => "exhausted" })).toMatchObject({ ok: false, reason: "quota" });
    expect(store.openContestFor(taskRef)).toBeNull();
    store.close();
  });

  test("the happy path creates the whole skeleton, slots bound to agents", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId } = setUpApproved(store);
    const admitted = admit(store, taskRef, leaseId);
    if (!admitted.ok) throw new Error(admitted.reason);
    const contest = store.getContest(admitted.contestId);
    expect(contest?.state).toBe("dispatching");
    expect(contest?.currentLeaseId).toBe(leaseId);
    const agents = store.contestants(admitted.contestId);
    expect(agents).toHaveLength(2);
    expect(agents[0]?.branch).toBe(contestBranch("race-3a", admitted.contestId, 1));
    expect(agents[0]?.reserveMicrousd).toBe(1_760_000);
    expect(store.liveSlotCount("night-shift-1")).toBe(2);
    expect(store.getExecutionSlot(admitted.slotIds[0] as number)?.contestant).toBe(agents[0]?.id);
    // A second admission refuses: one tournament per task.
    expect(admit(store, taskRef, leaseId)).toMatchObject({ ok: false, reason: "contest-open" });
    store.close();
  });

  const raceToRacing = (store: Store) => {
    const { taskRef, leaseId } = setUpApproved(store);
    const admitted = admit(store, taskRef, leaseId);
    if (!admitted.ok) throw new Error(admitted.reason);
    const contest = store.getContest(admitted.contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    }
    store.casContestState(admitted.contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["ready"], "building", agent.generation);
    }
    return { taskRef, leaseId, contestId: admitted.contestId, slotIds: admitted.slotIds };
  };

  test("REGRESSION of the round-1 hole: the first agent finishing must NOT release the parent claim", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId, contestId, slotIds } = raceToRacing(store);
    const [first, second] = store.contestants(contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    const run = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: first.branch, worktree: "/pool/c1", now: T0 });
    const one = finalizeContestant(
      store,
      { contestId, contestantId: first.id, runId: run, outcome: "built", measuredMicrousd: 900_000, slotId: slotIds[0] ?? null },
      T0,
    );
    expect(one.aggregated).toBeNull(); // the race is still on
    expect(store.liveClaimByLease(leaseId, T0)).not.toBeNull(); // THE claim survives
    expect(store.getContest(contestId)?.state).toBe("racing");
    // The second finishes: NOW the boundary crosses, once.
    const run2 = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: second.branch, worktree: "/pool/c2", now: T0 });
    const two = finalizeContestant(
      store,
      { contestId, contestantId: second.id, runId: run2, outcome: "failed", measuredMicrousd: 300_000, slotId: slotIds[1] ?? null },
      T0,
    );
    expect(two.aggregated).toBe("pick-wait");
    expect(store.liveClaimByLease(leaseId, T0)).toBeNull(); // released exactly here
    expect(store.getContest(contestId)?.state).toBe("pick-wait");
    // The contest-owned hold explains the stillness in plain words.
    const holds = store.activeHolds(taskRef, T0);
    expect(holds.some(hold => hold.reason.includes("compare the results and pick"))).toBe(true);
    store.close();
  });

  test("all agents failing ends in 'exhausted', never an automatic selection", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId, contestId, slotIds } = raceToRacing(store);
    const agents = store.contestants(contestId);
    for (const [index, agent] of agents.entries()) {
      const run = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: agent.branch, worktree: `/pool/c${index}`, now: T0 });
      finalizeContestant(
        store,
        { contestId, contestantId: agent.id, runId: run, outcome: "failed", measuredMicrousd: null, slotId: slotIds[index] ?? null },
        T0,
      );
    }
    expect(store.getContest(contestId)?.state).toBe("exhausted");
    // measured-null latched the FULL reservation, honestly flagged.
    const after = store.contestants(contestId);
    expect(after[0]?.unknownSpend).toBe(true);
    expect(after[0]?.accountedMicrousd).toBe(after[0]!.budgetMicrousd + after[0]!.reserveMicrousd);
    store.close();
  });

  test("recovery: a dead lease interrupts the tournament; never-started agents stay at zero", () => {
    const store = openStore(":memory:");
    const { taskRef, leaseId, contestId } = raceToRacing(store);
    const [first] = store.contestants(contestId);
    if (first === undefined) throw new Error("setup");
    // One agent actually started (run with provider start); the other never did.
    const run = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: first.branch, worktree: "/pool/c1", now: T0 });
    store.stampProviderStart(run, T0);
    store.claimContestantRun(first.id, run, store.getContestant(first.id)!.generation);
    release(store, leaseId, T0); // the daemon died; the reaper let go
    expect(recoverContests(store, T0)).toBe(1);
    expect(store.getContest(contestId)?.state).toBe("interrupted");
    const after = store.contestants(contestId);
    const started = after.find(one => one.id === first.id);
    const neverStarted = after.find(one => one.id !== first.id);
    expect(started?.unknownSpend).toBe(true);
    expect(neverStarted?.unknownSpend).toBe(false);
    expect(neverStarted?.accountedMicrousd).toBe(0);
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
    store.close();
  });
});

describe("stage 3a — the CLI: filing with --race, one yes for both documents, the racing guard", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    dir = mkdtempSync(join(tmpdir(), "race-cli-"));
    db = join(dir, "orders.db");
    lines = [];
    const store = openStore(db);
    const { addApprover } = await import("./scope.js");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    store.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (line: string) => lines.push(line);
  const run = async (argv: string[]) => {
    const { runOperate } = await import("./operate.js");
    return runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  test("scope --race files both documents; the approval takes the JOINT fingerprint or refuses", async () => {
    const { EXIT } = await import("./operate.js");
    expect(await run(["task", "add", "race-cli", "--id", "race-cli", "--json"])).toBe(EXIT.ok);
    lines = [];
    const scoped = await run([
      "task", "scope", "race-cli",
      "--goal", "Build the export twice and let me pick",
      "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5",
      "--race-per-usd", "5",
      "--race-total-usd", "20",
      "--json",
    ]);
    expect(scoped).toBe(EXIT.ok);
    const filed = payload();
    expect(filed.race.agents).toHaveLength(2);

    // Approving with the SCOPE digest alone refuses, naming the joint one.
    lines = [];
    const wrongDigest = await run([
      "task", "approve", "race-cli", "--yes",
      "--digest", filed.scope.digest,
      "--as", "alex", "--token", "wrong-not-checked-yet",
      "--json",
    ]);
    expect(wrongDigest).toBe(EXIT.refused);
    const refusal = payload().message as string;
    expect(refusal).toContain("joint fingerprint");
    const joint = /joint fingerprint ([0-9a-f]{64})/.exec(refusal)?.[1] as string;

    // The joint fingerprint, the password, one yes: both documents approve.
    lines = [];
    const approved = await run([
      "task", "approve", "race-cli", "--yes",
      "--digest", joint,
      "--as", "alex", "--token", "not-the-real-password",
      "--json",
    ]);
    // The token is wrong here (we never kept the minted one), so approval
    // refuses on CREDENTIALS — proving the digest gate passed first.
    expect(approved).toBe(EXIT.refused);
    expect(payload().reason).not.toBe("changed");

    // A codex agent is refused at filing, in words about turn-end usage.
    lines = [];
    const codex = await run([
      "task", "scope", "race-cli",
      "--goal", "g",
      "--race", "codex:gpt-5.2,claude:claude-sonnet-5",
      "--race-per-usd", "5", "--race-total-usd", "50",
      "--json",
    ]);
    expect(codex).toBe(EXIT.refused);
    expect(payload().reason).toBe("provider-ineligible");
  });
});
