import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run } from "./exec.js";
import { CHILD_DATABASE_ENV, runWithIsolatedDatabase } from "./child-database.js";
import { databasePath, openStore, openStoreReadOnly } from "./store.js";
import { main } from "./cli.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-sentinel-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("self-hosted commands cannot migrate the supervising store", () => {
  test.each([0, 1])("a real command exiting %s uses disposable state and preserves HOME", async exitCode => {
    const fixtureHome = temp();
    const sentinel = databasePath({}, fixtureHome);
    mkdirSync(dirname(sentinel), { recursive: true });
    const db = new DatabaseSync(sentinel);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep');");
    db.close();
    const before = readFileSync(sentinel);
    const entries = readdirSync(dirname(sentinel));
    const result = await runWithIsolatedDatabase(run, process.execPath, ["-e", `
      const { DatabaseSync } = require('node:sqlite');
      const file = process.env.STANDING_ORDERS_DB;
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE child_only (id INTEGER)');
      db.close();
      console.log(JSON.stringify({file, home: process.env.HOME}));
      process.exit(${exitCode});
    `], {
      env: { [CHILD_DATABASE_ENV]: sentinel },
      envAllowlist: ["PATH", "HOME", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"],
    });
    expect(result.code).toBe(exitCode);
    const child = JSON.parse(result.stdout);
    expect(child.file).not.toBe(sentinel);
    expect(child.home).toBe(process.env.HOME);
    expect(existsSync(dirname(child.file))).toBe(false);
    expect(readFileSync(sentinel)).toEqual(before);
    expect(readdirSync(dirname(sentinel))).toEqual(entries);
  });

  test("concurrent commands have distinct state, and a thrown spawn cleans up", async () => {
    const seen: string[] = [];
    const runner = async (_file: string, _args: readonly string[], options: import("./exec.js").RunOptions) => {
      const file = options.env![CHILD_DATABASE_ENV]!;
      seen.push(file);
      expect(existsSync(dirname(file))).toBe(true);
      await Promise.resolve();
      throw new Error("spawn failed");
    };
    const results = await Promise.allSettled([1, 2].map(() => runWithIsolatedDatabase(runner, "missing", [], {})));
    expect(results.every(one => one.status === "rejected")).toBe(true);
    expect(new Set(seen).size).toBe(2);
    expect(seen.every(file => !existsSync(dirname(file)))).toBe(true);
  });

  test("graph reporting leaves an old database's schema, bytes and directory untouched", async () => {
    const dir = temp();
    const file = join(dir, "orders.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1); CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep');");
    db.close();
    const bytes = readFileSync(file);
    const files = readdirSync(dir);
    const previous = process.env[CHILD_DATABASE_ENV];
    process.env[CHILD_DATABASE_ENV] = file;
    try {
      expect(await main(["graph", dir, "--json"], () => {})).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[CHILD_DATABASE_ENV];
      else process.env[CHILD_DATABASE_ENV] = previous;
    }
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(files);
  });

  test("read-only opening cannot create a missing store or write a current one", () => {
    const dir = temp();
    const file = join(dir, "missing", "orders.db");
    expect(openStoreReadOnly(file)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const present = join(dir, "orders.db");
    openStore(present).close();
    const store = openStoreReadOnly(present);
    expect(store).not.toBeNull();
    try {
      expect(() => store!.raw().exec("CREATE TABLE forbidden (id INTEGER)")).toThrow(/readonly/i);
    } finally {
      store?.close();
    }
  });
});
