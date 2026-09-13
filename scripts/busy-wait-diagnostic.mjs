#!/usr/bin/env node
// Bounded diagnostic for the SQLite write wait (WORKSPACE_0_RESULT_2026-09-13).
// Against a writer held open in another process it reports, for THIS
// process's scheduling tier:
//   1. how far the OS stretches a blocking 25 ms sleep (macOS background
//      timer coalescing adds up to ~100 ms to each one for every launchd
//      job without ProcessType=Interactive — the desktop host's included);
//   2. how long SQLite's own busy handler takes for a 1000 ms busy_timeout
//      (it counts the sleep it asked for, never a clock);
//   3. how long Store.transact takes to refuse with its 5000 ms budget
//      charged by the monotonic clock (needs dist/ — run `npm run build`).
// Every phase is bounded; the whole run is under ~15 s. Exit 0 whenever the
// held writer releases and a write recovers afterwards; the numbers are the
// report. Nothing outside a fresh temporary directory is touched.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "store.js");
if (!existsSync(dist)) {
  console.error(`${dist} is missing — run \`npm run build\` first`);
  process.exit(2);
}
const { openStore, openStoreNoMigrate } = await import(pathToFileURL(dist).href);

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const timed = call => {
  const monotonic = performance.now();
  const wall = Date.now();
  let error;
  try { call(); } catch (thrown) { error = thrown; }
  return { monotonicMs: Math.round(performance.now() - monotonic), wallMs: Date.now() - wall, error: error?.message ?? null };
};

const dir = mkdtempSync(join(tmpdir(), "so-busy-wait-"));
const file = join(dir, "orders.db");
const children = [];
const holdWriter = () => new Promise((ok, fail) => {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE task SET title = 'Writer committed' WHERE id = 'shared'").run();
    process.send('locked');
    process.once('message', () => { db.exec('COMMIT'); db.close(); process.disconnect(); });
  `, file], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  children.push(child);
  child.once("error", fail);
  child.once("exit", code => fail(new Error(`writer exited before ready: ${code}`)));
  child.once("message", () => ok(child));
});
const release = child => new Promise(ok => { child.once("exit", ok); child.send("release"); });

try {
  const seed = openStore(file);
  seed.createTask({ id: "shared", title: "Before writer" }, new Date());
  seed.close();

  const calibration = timed(() => { for (let i = 0; i < 4; i++) wait(25); });
  console.log(JSON.stringify({ phase: "sleep calibration", nominalMs: 25, observedMs: Math.round(calibration.monotonicMs / 4) }));

  let child = await holdWriter();
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA busy_timeout = 1000");
  const handler = timed(() => raw.exec("BEGIN IMMEDIATE"));
  raw.close();
  console.log(JSON.stringify({ phase: "SQLite busy handler alone", busyTimeoutMs: 1000, ...handler, ratio: +(handler.monotonicMs / 1000).toFixed(2) }));
  await release(child);

  child = await holdWriter();
  const opened = openStoreNoMigrate(file);
  if (!opened.ok) throw new Error(opened.message);
  let calls = 0;
  const transact = timed(() => opened.store.transact(() => { calls++; }));
  console.log(JSON.stringify({ phase: "Store.transact, clock-bounded", budgetMs: 5000, ...transact, bodyCalls: calls, busyTimeoutAfter: opened.store.raw().prepare("PRAGMA busy_timeout").get().timeout }));
  await release(child);
  opened.store.transact(() => opened.store.createTask({ id: "recovered", title: "Writer recovered" }, new Date()));
  const recovered = opened.store.getTask("recovered") !== null;
  opened.store.close();
  console.log(JSON.stringify({ phase: "recovery after release", recovered }));
  if (!recovered || calls !== 0 || transact.error === null) process.exit(1);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  rmSync(dir, { recursive: true, force: true });
}
