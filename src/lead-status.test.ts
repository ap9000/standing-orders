import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTaskWait, taskWaitSnapshot } from "./lead-status.js";
import { runOperate } from "./operate.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const NOW = new Date("2026-09-28T18:00:00.000Z");
const LATER = new Date("2026-09-28T18:05:00.000Z");

describe("lead status commands", () => {
  let dir: string;
  let db: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standing-orders-lead-status-"));
    db = join(dir, "orders.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = (store: Store, id: string, state: "queued" | "running" | "done" | "failed" = "queued"): number => {
    store.createTask({ id, title: id }, NOW);
    if (state !== "queued") expect(store.setTaskState(id, state, NOW)).toEqual({ ok: true });
    return store.refFor(BUILT_IN, id).id;
  };

  const run = (store: Store, taskRef: number, options: {
    lease?: string;
    phase?: string;
    outcome?: "built" | "failed" | null;
    quality?: "default" | "strict";
    finished?: boolean;
  } = {}): number => {
    const outcome = options.outcome ?? null;
    const finished = options.finished ?? outcome !== null;
    return Number(store.handle.prepare(`INSERT INTO run
      (task_ref, lease_id, runner, branch, worktree, role, quality_mode, phase, outcome, reason, started_at, finished_at)
      VALUES (?, ?, 'worker-1', 'standing-orders/test', '/tmp/status-test', 'builder', ?, ?, ?, ?, ?, ?)`)
      .run(taskRef, options.lease ?? `lease-${taskRef}`, options.quality ?? "default", options.phase ?? null,
        outcome, outcome === "failed" ? "agent-failed" : null, NOW.toISOString(), finished ? LATER.toISOString() : null).lastInsertRowid);
  };

  test("task wait returns 0 after the attempt it observed becomes ready", async () => {
    const seed = openStore(db);
    const ref = create(seed, "ready-after-wait", "running");
    const runId = run(seed, ref, { phase: "verifying-proof" });
    seed.close();

    const lines: string[] = [];
    let settled = false;
    const code = await runOperate("task", ["wait", "ready-after-wait", "--timeout", "1"], line => lines.push(line), {
      databaseFile: db,
      waitSleep: async () => {
        if (settled) return;
        settled = true;
        const update = openStore(db);
        update.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [{ name: "Tests", status: "passed", exitCode: 0 }] });
        update.handle.prepare("UPDATE run SET outcome = 'built', committed = 1, reason = 'built', finished_at = ? WHERE id = ?").run(LATER.toISOString(), runId);
        expect(update.setTaskState("ready-after-wait", "done", LATER)).toEqual({ ok: true });
        update.close();
      },
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Ready | run #${runId} | checks passed (exit 0) | next: Review result`);
  });

  test("task wait follows a retry that lands between polls and reports the retry's own outcome", async () => {
    const seed = openStore(db);
    const ref = create(seed, "retried-while-waiting", "running");
    const firstRun = run(seed, ref, { phase: "agent-running" });
    seed.close();

    let retryRun = 0;
    let settled = false;
    const lines: string[] = [];
    const code = await runOperate("task", ["wait", "retried-while-waiting", "--timeout", "1", "--json"], line => lines.push(line), {
      databaseFile: db,
      waitSleep: async () => {
        if (settled) return;
        settled = true;
        const update = openStore(db);
        update.handle.prepare("UPDATE run SET outcome = 'failed', reason = 'agent-failed', finished_at = ? WHERE id = ?").run(LATER.toISOString(), firstRun);
        retryRun = run(update, ref, { outcome: "built" });
        update.recordRunCheck(retryRun, { status: "passed", exitCode: 0, suites: [{ name: "Tests", status: "passed", exitCode: 0 }] });
        expect(update.setTaskState("retried-while-waiting", "done", LATER)).toEqual({ ok: true });
        update.close();
      },
    });

    expect(code).toBe(0);
    expect(retryRun).toBeGreaterThan(firstRun);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, outcome: "Ready", run: retryRun, replacedRun: firstRun, check: { status: "passed" } });

    const reader = openStore(db);
    try {
      const snapshot = taskWaitSnapshot(reader, "retried-while-waiting", LATER, firstRun);
      expect(snapshot).not.toBeNull();
      expect(renderTaskWait(snapshot!)).toBe(`Ready | run #${retryRun}, a retry that replaced run #${firstRun} | checks passed (exit 0) | next: Review result`);
    } finally {
      reader.close();
    }
  });

  test("task wait reports a failed retry as failed even when the task has moved on", async () => {
    const seed = openStore(db);
    const ref = create(seed, "retry-failed", "running");
    const firstRun = run(seed, ref, { outcome: "built" });
    const retryRun = run(seed, ref, { outcome: "failed" });
    seed.close();

    const reader = openStore(db);
    try {
      const snapshot = taskWaitSnapshot(reader, "retry-failed", LATER, firstRun);
      expect(snapshot).toMatchObject({ outcome: "Failed", run: retryRun, replacedRun: firstRun, exitCode: 1, terminal: true });
      const same = taskWaitSnapshot(reader, "retry-failed", LATER, retryRun);
      expect(same).toMatchObject({ outcome: "Failed", run: retryRun, replacedRun: null, exitCode: 1 });
    } finally {
      reader.close();
    }
  });

  test("task wait returns 1 for failure and when a person is needed", async () => {
    const seed = openStore(db);
    const failedRef = create(seed, "failed-task", "failed");
    const failedRun = run(seed, failedRef, { outcome: "failed" });
    seed.recordRunCheck(failedRun, { status: "failed", exitCode: 1, suites: [{ name: "Tests", status: "failed", exitCode: 1 }] });
    create(seed, "needs-scope");
    seed.close();

    const failed: string[] = [];
    expect(await runOperate("task", ["wait", "failed-task"], line => failed.push(line), { databaseFile: db, now: NOW })).toBe(1);
    expect(failed).toEqual([`Failed | run #${failedRun} | checks failed (exit 1) | next: Inspect failure`]);

    const needsPerson: string[] = [];
    expect(await runOperate("task", ["wait", "needs-scope"], line => needsPerson.push(line), { databaseFile: db, now: NOW })).toBe(1);
    expect(needsPerson).toEqual(["Needs a person | no run | checks unknown | next: Add scope"]);
  });

  test("task wait keeps a failed check visible while a ready result still exits 0", async () => {
    const seed = openStore(db);
    const ref = create(seed, "ready-with-failed-check");
    const runId = run(seed, ref, { outcome: "built", quality: "strict" });
    seed.recordRunCheck(runId, {
      status: "failed",
      exitCode: 1,
      suites: [{ name: "Tests", status: "failed", exitCode: 1 }],
    });
    expect(seed.setTaskState("ready-with-failed-check", "done", LATER)).toEqual({ ok: true });
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("task", ["wait", "ready-with-failed-check"], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    expect(lines).toEqual([`Ready | run #${runId} | checks failed (exit 1) | next: Review result`]);
  });

  test("task wait returns 2 with one status line on timeout", async () => {
    const seed = openStore(db);
    const ref = create(seed, "still-running", "running");
    const runId = run(seed, ref, { phase: "agent-running" });
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("task", ["wait", "still-running", "--timeout", "0"], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(2);
    expect(lines).toEqual([`Timed out | run #${runId} | checks unknown | next: Wait — agent working`]);
  });

  test("check summaries live in run_check, first write wins, and only Strict runs are release checks", async () => {
    const seed = openStore(db);
    const columns = (seed.handle.prepare("SELECT name FROM pragma_table_info('run')").all() as { name: string }[]).map(one => one.name);
    expect(columns.filter(name => name.startsWith("check_"))).toEqual([]);

    const ref = create(seed, "ordinary-build", "done");
    const ordinary = run(seed, ref, { outcome: "built" });
    seed.recordRunCheck(ordinary, { status: "passed", exitCode: 0, suites: [] });
    seed.recordRunCheck(ordinary, { status: "failed", exitCode: 1, suites: [] });
    expect(seed.runCheckFor(ordinary)).toEqual({ status: "passed", exitCode: 0, suites: [] });
    expect(seed.handle.prepare("SELECT release FROM run_check WHERE run = ?").get(ordinary)).toEqual({ release: 0 });
    expect(seed.runCheckFor(ordinary + 1)).toBeNull();
    expect(() => seed.recordRunCheck(ordinary, { status: "passed", exitCode: -1, suites: [] })).toThrow("non-negative");
    seed.close();

    const lines: string[] = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    expect(lines.join("\n").split("\n")).toContain("Release check: none recorded");
  });

  test("status includes running phases, queued reasons, review results, the release suites and plan windows", async () => {
    const seed = openStore(db);
    const runningRef = create(seed, "running-check", "running");
    const runningRun = run(seed, runningRef, { lease: "lease-live", phase: "verifying-proof" });
    seed.handle.prepare(`INSERT INTO claim
      (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
      VALUES ('lease-live', ?, 1, 'worker-1', ?, ?, ?)`)
      .run(runningRef, NOW.toISOString(), new Date(NOW.getTime() + 60 * 60_000).toISOString(), NOW.toISOString());

    create(seed, "needs-scope");
    const heldRef = create(seed, "held-task");
    seed.hold(heldRef, "Waiting for the operator", null, NOW);

    const readyRef = create(seed, "ready-result");
    const releaseRun = run(seed, readyRef, { outcome: "built", quality: "strict" });
    seed.recordRunCheck(releaseRun, {
      status: "passed",
      exitCode: 0,
      suites: [
        { name: "Typecheck", status: "passed", exitCode: 0 },
        { name: "Tests", status: "passed", exitCode: 0 },
      ],
    });
    expect(seed.setTaskState("ready-result", "done", LATER)).toEqual({ ok: true });
    seed.recordProviderLimits({
      provider: "codex",
      plan: "team",
      windows: [{ window: "five_hour", usedPercent: 42, windowMinutes: 300, resetsAt: null, reached: false }],
    }, NOW);
    seed.close();

    const jsonLines: string[] = [];
    expect(await runOperate("status", ["--json"], line => jsonLines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    const body = JSON.parse(jsonLines.join("\n")) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.running).toMatchObject({ count: 1, phases: [{ phase: "running checks", count: 1 }] });
    expect(body.running.tasks).toEqual([{ task: "running-check", run: runningRun, phase: "running checks" }]);
    expect(body.queued).toMatchObject({ count: 2 });
    expect(body.queued.tasks).toEqual(expect.arrayContaining([
      { task: "needs-scope", reason: "needs a scope" },
      { task: "held-task", reason: "on hold" },
    ]));
    expect(body.queued.reasons).toEqual(expect.arrayContaining([
      { reason: "needs a scope", count: 1 },
      { reason: "on hold", count: 1 },
    ]));
    expect(body.waitingForReview).toMatchObject({ count: 1, results: [{ task: "ready-result", run: releaseRun }] });
    expect(body.releaseCheck).toMatchObject({ task: "ready-result", run: releaseRun, check: { status: "passed", exitCode: 0 } });
    expect(body.releaseCheck.check.suites).toEqual([
      { name: "Typecheck", status: "passed", exitCode: 0 },
      { name: "Tests", status: "passed", exitCode: 0 },
    ]);
    expect(body.planWindows).toMatchObject([{ provider: "codex", plan: "team", window: "five_hour", usedPercent: 42 }]);

    const textLines: string[] = [];
    expect(await runOperate("status", [], line => textLines.push(line), { databaseFile: db, now: NOW })).toBe(0);
    const report = textLines.join("\n").split("\n");
    expect(report.length).toBeLessThanOrEqual(12);
    expect(report).toEqual(expect.arrayContaining([
      `Running: 1 — running-check (#${runningRun}, running checks)`,
      `Ready for review: 1 — ready-result (#${releaseRun})`,
      `Release check: ready-result #${releaseRun} — passed (exit 0)`,
      "  Suites: Typecheck passed (exit 0); Tests passed (exit 0)",
      "Plan windows: codex team — 5-hour 42%",
    ]));
    expect(report.find(line => line.startsWith("Queued: 2 —"))).toContain("held-task (on hold)");
    expect(report.find(line => line.startsWith("Queued: 2 —"))).toContain("needs-scope (needs a scope)");
  });
});
