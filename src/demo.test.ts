import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { seedDemo, makeDemoRepos, createDemoSandbox } from "./demo.js";
import { runOperate, EXIT } from "./operate.js";
import { classify } from "./board.js";
import { readVerifiedArtifact } from "./evidence.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");

describe("the demo sandbox", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("seeding refuses an unfenced database — the stamp precedes every row", () => {
    const store = openStore(":memory:");
    const repos = makeDemoRepos(dir);
    expect(() => seedDemo(store, repos, join(dir, "ev"), T0)).toThrow(/unfenced/);
    store.close();
  });

  test("the sandbox is stamped, seeded across every lane, and its evidence verifies", () => {
    const { sandbox, store, seed, evidenceRoot } = createDemoSandbox(T0);
    try {
      expect(store.isDemo()).toBe(true);
      expect(seed.login.name).toBe("demo");
      // Every board lane has something to show.
      const tasks = store.listTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(8);
      const states = new Set(tasks.map(one => one.state));
      expect(states.has("queued")).toBe(true);
      expect(states.has("done")).toBe(true);
      expect(states.has("failed")).toBe(true);
      expect(states.has("running")).toBe(true);
      // A decision waits.
      expect(store.listDecisionsScoped(null).length).toBeGreaterThanOrEqual(1);
      // The finished run's terminal diff verifies byte-for-byte.
      const done = store.listTasks().find(one => one.id === "fix-payout-rounding");
      expect(done?.state).toBe("done");
      const runs = store.runsFor(store.refFor("built-in", "fix-payout-rounding").id);
      const artifacts = store.artifactsFor((runs[0] ?? { id: -1 }).id);
      const diff = artifacts.find(one => one.kind === "terminal-diff");
      expect(diff).toBeDefined();
      if (diff === undefined) throw new Error("unreachable");
      const proven = readVerifiedArtifact(evidenceRoot, diff);
      if (!proven.ok) throw new Error(proven.problem);
      expect(proven.content.toString("utf8")).toContain("payout.ts");
      // The synthetic capture says so.
      expect(diff.capture).toContain("demo: synthetic");
      // A standing order fired and recorded its single-flight skip honestly.
      const routine = store.routineByName("nightly-deps");
      expect(routine).not.toBeNull();
      if (routine === null) throw new Error("unreachable");
      const fires = store.routineFires(routine.id, 14);
      expect(fires.some(one => one.outcome === "fired")).toBe(true);
      // The password never lands in the database.
      expect(store.installationFact("demo")).toBe("1");
      const login = readFileSync(join(sandbox, "demo-login.txt"), "utf8");
      expect(login).toContain(seed.login.password);
      expect((statSync(join(sandbox, "demo-login.txt")).mode & 0o777).toString(8)).toBe("600");
    } finally {
      store.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("the board classifier sees a full house", () => {
    const { sandbox, store } = createDemoSandbox(T0);
    try {
      const snapshot = store.boardScoped(null, new Date(T0.getTime() + 60_000), 200, null);
      const lanes = new Set(snapshot.tasks.map(card => classify(card, new Date(T0.getTime() + 60_000)).lane));
      expect(lanes.has("attention")).toBe(true);
      expect(lanes.has("building")).toBe(true);
      // Completed work rides the snapshot's own done list, not the lanes.
      expect(snapshot.done.length).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("the demo fence — spending commands fail closed", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "demo-fence-"));
    db = join(dir, "orders.db");
    const store = openStore(db);
    store.recordInstallationFact("demo", "1", T0);
    store.close();
    lines = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (line: string) => lines.push(line);
  const payload = () => JSON.parse(lines.join("\n"));

  test.each([
    ["tick", ["--runner", "r", "--token", "t", "--json"]],
    ["watch", ["--runner", "r", "--token", "t", "--json"]],
    ["build", ["some-task", "--runner", "r", "--token", "t", "--json"]],
    ["publish", ["status", "--json"]],
    ["reconcile", ["--json"]],
    ["daemon", ["status", "--json"]],
    ["bridge", ["telegram", "status", "--json"]],
    ["outbox", ["deliver", "--cmd", "true", "--json"]],
    ["intake", ["run", "--repo", "/anywhere", "--json"]],
    ["intake", ["pr-comments", "--repo", "/anywhere", "--json"]],
  ])("%s %j refuses a demo database", async (command, argv) => {
    lines = [];
    const code = await runOperate(command as string, argv as string[], write, { databaseFile: db, now: T0 });
    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "demo-database" });
  });

  test("reads still work — the console is the point of the sandbox", async () => {
    lines = [];
    const code = await runOperate("task", ["list", "--json"], write, { databaseFile: db, now: T0 });
    expect(code).toBe(EXIT.ok);
    expect(payload().ok).toBe(true);
  });
});
