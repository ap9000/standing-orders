import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckProgressTracker, type CheckProgressSnapshot } from "./check-progress.js";
import { isTelegramProgressNotification, openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { buildPushPayload } from "./push.js";
import { runOperate } from "./operate.js";
import { telegramProgressCard } from "./telegram-progress.js";

const T0 = new Date("2026-09-28T18:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/projects/progress";

function samples(): CheckProgressSnapshot[] {
  const seen: CheckProgressSnapshot[] = [];
  const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
  tracker.feed("\u001b[32m Test Files  191 passed (191)\u001b[39m\n", "stderr");
  tracker.feed("[flows]   1s  PASS  opens the result\n[flows]   2s  PASS  leaves feedback\n");
  tracker.feed("[flows] 2 passed, 0 failed, 0 skipped\n");
  tracker.feed("[app]   3s  PA", "stdout");
  tracker.feed("SS  creates a revision\n[app] 1 passed, 0 failed, 0 skipped\n", "stdout");
  tracker.finish();
  return seen;
}

function fixture(store: Store): number {
  expect(addApprover(store, "alex", T0).ok).toBe(true);
  register(store, { name: "worker", host: "test", capacity: 1, repos: [REPO], now: T0, newToken: () => "runner-token" });
  store.createTask({ id: "progress-1", title: "Show check progress" }, T0);
  const ref = store.refFor("built-in", "progress-1").id;
  store.placeTask(ref, REPO, {}, T0);
  return store.startRun({
    taskRef: ref,
    leaseId: "lease-progress",
    runner: "worker",
    branch: "standing-orders/progress-1",
    worktree: "/work/progress-1",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" },
    now: T0,
  });
}

describe("check output progress", () => {
  test("ignores output from checks that do not expose the three release suites", () => {
    const seen: CheckProgressSnapshot[] = [];
    const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
    tracker.feed("lint passed\ncoverage complete\n");
    expect(tracker.finish()).toBeNull();
    expect(seen).toEqual([]);
  });

  test("reads split Vitest and journey output and gives every suite a final result", () => {
    const seen = samples();
    expect(seen).toContainEqual(expect.objectContaining({
      final: false,
      line: "unit ✓ 191 · flows ✓ 2 · app …",
    }));
    expect(seen.at(-1)).toMatchObject({
      final: true,
      line: "unit ✓ 191 · flows ✓ 2 · app ✓ 1",
      suites: {
        unit: { state: "passed", passed: 191, failed: 0, total: 191 },
        flows: { state: "passed", passed: 2, failed: 0, total: 2 },
        app: { state: "passed", passed: 1, failed: 0, total: 1 },
      },
    });
  });

  test("keeps failures and names missing suite results instead of guessing", () => {
    const seen: CheckProgressSnapshot[] = [];
    const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
    tracker.feed("Test Files  1 failed | 190 passed (191)\n");
    tracker.feed("[flows] FAIL  saves feedback\n[flows] 17 passed, 1 failed, 0 skipped\n");
    expect(tracker.finish()!.line).toBe("unit ✕ 1/191 · flows ✕ 1/18 · app ?");
  });
});

describe("saved and delivered progress", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

  test("saves every line, notifies once a minute, and always sends the final summary", () => {
    const store = openStore(":memory:");
    const run = fixture(store);
    expect(store.enrollPushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/progress",
      p256dh: "B".repeat(87), auth: "a".repeat(22), approver: "alex", approverGeneration: 1,
      uaWords: "phone", vapidFingerprint: "fp-progress",
    }, T0)).toMatchObject({ ok: true });
    const all = samples();
    const unit = all.find(one => one.line === "unit ✓ 191 · flows … · app …")!;
    const flows = all.find(one => one.line === "unit ✓ 191 · flows ✓ 2 · app …")!;
    const final = all.at(-1)!;

    expect(store.saveCheckProgress(run, unit, T0)).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, flows, later(30_000))).toEqual({ changed: true, notified: false });
    expect(store.checkProgress(run)?.line).toBe(flows.line);
    expect(store.saveCheckProgress(run, { ...flows, line: "unit ✓ 191 · flows ✓ 2 · app 1", suites: { ...flows.suites, app: { state: "running", passed: 1, failed: 0, skipped: 0, total: null } } }, later(60_000))).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, final, later(60_001))).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, final, later(120_000))).toEqual({ changed: false, notified: false });

    const notices = store.listNotifications("all").filter(row => row.kind === "check-progress");
    expect(notices.map(row => row.body)).toEqual([unit.line, "unit ✓ 191 · flows ✓ 2 · app 1", final.line]);
    expect(notices.every(row => isTelegramProgressNotification(row))).toBe(true);
    expect(telegramProgressCard(store, store.getRun(run)!, "progress-1", REPO, later(60_001)).text).toContain(final.line);
    expect(store.seedPushPairs(later(120_000))).toBe(3);
    const pairs = store.claimPushPairs("push", 60_000, 10, later(120_000));
    const fenced = pairs.map(pair => store.pushSendFence(pair.id, "push", pair.claimGeneration)?.notificationRow).filter(Boolean);
    expect(fenced).toHaveLength(3);
    expect(fenced.at(-1)?.pushClass).toBe("progress");
    expect(JSON.parse(buildPushPayload(fenced.at(-1)!))).toMatchObject({ body: final.line, url: `/r/${run}`, tag: `so-run-${run}` });
    store.close();
  });

  test("the CLI returns the same saved line", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-check-progress-"));
    const file = join(dir, "orders.db");
    const store = openStore(file);
    const run = fixture(store);
    const final = samples().at(-1)!;
    store.saveCheckProgress(run, final, T0);
    store.close();

    const lines: string[] = [];
    const code = await runOperate("check-progress", [String(run), "--json"], line => lines.push(line), { databaseFile: file, now: T0 });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, command: "check-progress", run, progress: { line: final.line, final: true } });
  });
});
