import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, openStoreNoMigrate, openStoreReadOnly, type Database, type Store } from "./store.js";
import { writeStoreSeed } from "../test/store-seed.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
let templateRoot: string | undefined;
let templateFile: string;
beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "so-contention-template-"));
  templateFile = join(templateRoot, "orders.db");
  await writeStoreSeed(templateFile, store => {
    store.createTask({ id: "shared", title: "Before writer" }, new Date());
  });
});
afterAll(() => { if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true }); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Elapsed time of one synchronous call on both clocks, and what it threw. */
function timedRefusal(call: () => void): { error: unknown; elapsed: { monotonicMs: number; wallMs: number } } {
  const monotonic = performance.now();
  const wall = Date.now();
  let error: unknown;
  try { call(); } catch (thrown) { error = thrown; }
  return { error, elapsed: { monotonicMs: Math.round(performance.now() - monotonic), wallMs: Date.now() - wall } };
}

function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How far this process's scheduling tier stretches a blocking 25 ms sleep.
 * macOS background timer coalescing (every launchd job that does not say
 * ProcessType=Interactive, the desktop host's included) adds up to ~100 ms
 * to each one; SQLite's busy handler counts only what it asked for. */
function sleepCalibration(): string {
  const before = performance.now();
  for (let i = 0; i < 4; i++) blockFor(25);
  return `a 25ms sleep takes ${Math.round((performance.now() - before) / 4)}ms in this process`;
}

/** A connection whose BEGIN IMMEDIATE is stretched and refused by the
 * test, standing in for a busy handler whose sleeps the OS lengthens:
 * every attempt costs `attemptMs` of real time whatever slice SQLite was
 * asked for, and ends in the given SQLite error. Everything else reaches
 * the real file. */
function stretchedWriter(attemptMs: number, errcode: number): { connect: (path: string) => Database; attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    connect: (path: string): Database => {
      const real = new DatabaseSync(path);
      return {
        prepare: sql => real.prepare(sql),
        close: () => real.close(),
        exec: sql => {
          if (sql.trim() === "BEGIN IMMEDIATE") {
            attempts++;
            blockFor(attemptMs);
            throw Object.assign(new Error(errcode === 5 ? "database is locked" : "attempt to write a readonly database"), { code: "ERR_SQLITE_ERROR", errcode, errstr: "" });
          }
          real.exec(sql);
        },
      };
    },
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "so-contention-"));
  roots.push(root);
  const file = join(root, "orders.db");
  copyFileSync(templateFile, file);
  return file;
}

/** Release runs in another process even while DatabaseSync blocks this one. */
async function holdWriter(file: string, releaseAfterMs: number | null): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE task SET title = 'Writer committed' WHERE id = 'shared'").run();
    process.send('locked');
    const release = () => { db.exec('COMMIT'); db.close(); process.disconnect(); };
    const delay = JSON.parse(process.argv[2]);
    if (delay === null) process.once('message', release);
    else setTimeout(release, delay);
  `, file, JSON.stringify(releaseAfterMs)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", chunk => { err += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`writer exited before ready: ${code}: ${err}`)));
    child.once("message", message => message === "locked" ? resolve() : reject(new Error("unexpected writer message")));
  });
  return child;
}

describe("brief concurrent database writers do not disconnect the controller", () => {
  test("CLI opening while another process writes waits and observes its committed data", async () => {
    const file = fixture();
    await holdWriter(file, 300);
    let store: Store | undefined;
    try {
      store = openStore(file);
      expect(store.getTask("shared")?.title).toBe("Writer committed");
      expect(store.raw().prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { store?.close(); }
  });

  test("the non-migrating desktop connection waits at BEGIN without replaying the body", async () => {
    const file = fixture();
    const opened = openStoreNoMigrate(file);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      await holdWriter(file, 300);
      let calls = 0;
      store.transact(() => {
        calls++;
        expect(store.getTask("shared")?.title).toBe("Writer committed");
        store.createTask({ id: "once", title: "Executed once" }, new Date());
      });
      expect(calls).toBe(1);
      expect(store.getTask("once")?.title).toBe("Executed once");
    } finally { store.close(); }
  });

  test("a persistent lock refuses in finite time before the body, without partial writes", async () => {
    const file = fixture();
    const opened = openStoreNoMigrate(file);
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      const child = await holdWriter(file, null);
      let calls = 0;
      // Time the SQLite call alone — the matcher runs afterwards, outside
      // the clocks — on the monotonic and the wall clock, so a future
      // overrun says which of them moved and by how much.
      const tier = sleepCalibration();
      const timed = timedRefusal(() => store.transact(() => {
        calls++;
        store.createTask({ id: "must-not-exist", title: "No partial write" }, new Date());
      }));
      expect(timed.error).toBeInstanceOf(Error);
      expect((timed.error as Error).message).toMatch(/database is locked/);
      const diagnosis = `BEGIN IMMEDIATE refused after ${JSON.stringify(timed.elapsed)}; ${tier}`;
      // The five-second budget is spent in full before refusing — never
      // less — and the refusal lands within the ten-second bound on BOTH
      // clocks, whatever this process's scheduling tier does to sleeps.
      expect(timed.elapsed.monotonicMs, diagnosis).toBeGreaterThanOrEqual(5_000);
      expect(timed.elapsed.monotonicMs, diagnosis).toBeLessThan(10_000);
      expect(timed.elapsed.wallMs, diagnosis).toBeLessThan(10_000);
      expect(calls).toBe(0);
      expect(store.getTask("must-not-exist")).toBeNull();
      // The connection's own busy wait is back where every statement expects it.
      expect(store.raw().prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      child.send("release");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
      store.transact(() => store.createTask({ id: "recovered", title: "Writer recovered" }, new Date()));
      expect(store.getTask("recovered")).not.toBeNull();
    } finally { store.close(); }
  });

  test("WAL reporting can read the last committed view during a writer and stays read-only", async () => {
    const file = fixture();
    const child = await holdWriter(file, null);
    const reporting = openStoreReadOnly(file);
    try {
      expect(reporting?.getTask("shared")?.title).toBe("Before writer");
      expect(() => reporting!.createTask({ id: "forbidden", title: "No writes" }, new Date())).toThrow(/readonly/i);
    } finally { reporting?.close(); child.send("release"); }
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
  });
});

describe("the write wait is charged by the clock, not by the sleep SQLite asked for", () => {
  test("stretched busy attempts still refuse within the budget plus one attempt, never a multiple of it", () => {
    const file = fixture();
    // Each attempt costs 400 ms real time against a 100 ms nominal slice —
    // the 4× stretch of builds 1540/1541 in miniature. Nominal accounting
    // (the old busy handler alone) would have run 5000 ms of slices for
    // ~20 s; clock accounting refuses after ~5 s and at most 14 attempts.
    const writer = stretchedWriter(400, 5);
    const opened = openStoreNoMigrate(file, { connect: writer.connect });
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      let calls = 0;
      const timed = timedRefusal(() => store.transact(() => { calls++; }));
      const diagnosis = `refused after ${JSON.stringify(timed.elapsed)} and ${writer.attempts()} attempts; ${sleepCalibration()}`;
      expect((timed.error as Error)?.message, diagnosis).toMatch(/database is locked/);
      expect(timed.elapsed.monotonicMs, diagnosis).toBeGreaterThanOrEqual(5_000);
      expect(timed.elapsed.monotonicMs, diagnosis).toBeLessThan(10_000);
      expect(writer.attempts(), diagnosis).toBeLessThanOrEqual(14);
      expect(calls).toBe(0);
      expect(store.raw().prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally { store.close(); }
  });

  test("an error that is not SQLITE_BUSY is not retried, and the connection's wait is restored", () => {
    const file = fixture();
    const writer = stretchedWriter(10, 8); // SQLITE_READONLY
    const opened = openStoreNoMigrate(file, { connect: writer.connect });
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      const timed = timedRefusal(() => store.transact(() => {}));
      expect((timed.error as Error)?.message).toMatch(/readonly/);
      expect(writer.attempts()).toBe(1);
      expect(timed.elapsed.monotonicMs).toBeLessThan(1_000);
      expect(store.raw().prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally { store.close(); }
  });
});
