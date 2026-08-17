import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";

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
