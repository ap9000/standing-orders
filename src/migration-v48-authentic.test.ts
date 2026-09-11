/**
 * The v47 → v48 upgrade against an AUTHENTIC v47 database — one the v47
 * build's own code wrote (src/fixtures/v47-authentic.sql, derived by
 * scripts/derive-v47-fixture.mjs from commit 1d0fc900) — and against the
 * same file with the v48 migration half-applied under the −47 epoch
 * sentinel. Every pre-existing row survives byte for byte, the two routine
 * columns arrive NULL, nothing is backfilled or auto-approved, and a second
 * open changes nothing: the full row and schema snapshots are compared.
 * The schema-version preflight is proved here too: exactly one safe,
 * supported integer is read BEFORE any DDL, and anything else refuses with
 * the file untouched.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, SCHEMA_VERSION, schemaVersionPreflight, type Store } from "./store.js";
import { routineAgentsState } from "./routine.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v47-authentic.sql");
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Snapshot = { schema: { name: string; type: string; sql: string }[]; rows: Record<string, Record<string, unknown>[]> };

/** Every table's DDL and every row, in rowid order — the whole file. */
function snapshot(file: string): Snapshot {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const schema = (db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as { name: string; type: string; sql: string }[]).map(one => ({ ...one }));
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of schema.filter(one => one.type === "table")) {
    const statement = db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    rows[table.name] = (statement.all() as Record<string, unknown>[]).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v])));
  }
  db.close();
  return { schema, rows };
}

/** A fresh file loaded from the authentic v47 SQL. */
function loadFixture(dir: string, name = "orders.db"): string {
  const file = join(dir, name);
  const db = new sqlite.DatabaseSync(file);
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.close();
  return file;
}

function rawVersion(file: string): unknown {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT CAST(version AS TEXT) AS version FROM schema_version").all() as { version: string }[];
  db.close();
  return rows.length === 1 ? Number(rows[0]?.version) : rows.map(one => one.version);
}

/** The v48 migration's additive columns, projected out of an upgraded row. */
const V48_ROUTINE_COLUMNS = ["route_json", "approved_route_json"];
function withoutNew(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table !== "routine") return row;
  const copy = { ...row };
  for (const column of V48_ROUTINE_COLUMNS) delete copy[column];
  return copy;
}

describe("the authentic v47 database upgrades to v48 and stays put", () => {
  let dir: string | undefined;
  let store: Store | null = null;
  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("the fixture is what v47 wrote: version 47, the v47 shapes, the seeded facts", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
    const file = loadFixture(dir);
    expect(rawVersion(file)).toBe(47);
    const before = snapshot(file);
    const routineDdl = before.schema.find(one => one.type === "table" && one.name === "routine")!.sql;
    expect(routineDdl).not.toContain("route_json");
    const proposalDdl = before.schema.find(one => one.type === "table" && one.name === "mate_proposal")!.sql;
    expect(proposalDdl).not.toContain("'agents'");
    expect(before.rows["task_scope"]!.map(one => one["task_id"])).toEqual(["t-routed", "t-pending", "t-legacy", "t-chain"]);
    expect(before.rows["run_route"]).toHaveLength(1);
    expect(before.rows["review_request"]).toHaveLength(1);
    expect(before.rows["routine"]).toHaveLength(1);
    expect(before.rows["mate_proposal"]).toHaveLength(1);
    expect(before.rows["task_steer"]).toHaveLength(1);
  });

  for (const [label, prepare] of [
    ["an authentic v47 file", (_file: string): void => undefined],
    [
      "a −47 epoch with the v48 migration half-applied (one routine column already added)",
      (file: string): void => {
        const db = new sqlite.DatabaseSync(file);
        db.exec("ALTER TABLE routine ADD COLUMN route_json TEXT");
        db.exec("UPDATE schema_version SET version = -47");
        db.close();
      },
    ],
  ] as const) {
    test(`${label} upgrades in place: every row survives, the new columns arrive NULL, nothing is backfilled or auto-approved, and a second open is a byte-for-byte no-op`, () => {
      dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
      const file = loadFixture(dir);
      const authentic = snapshot(file);
      prepare(file);
      // The first open migrates.
      store = openStore(file);
      store.close();
      store = null;
      expect(rawVersion(file)).toBe(SCHEMA_VERSION);
      const upgraded = snapshot(file);
      // Every table v47 had is still there; every row is byte for byte the
      // row v47 wrote, plus the two NULL routine columns — no other table
      // gained or lost a row, no id moved, no digest changed.
      for (const table of authentic.schema.filter(one => one.type === "table" && one.name !== "schema_version")) {
        expect(upgraded.rows[table.name], table.name).toBeDefined();
        expect(upgraded.rows[table.name]!.map(row => withoutNew(table.name, row)), table.name).toEqual(authentic.rows[table.name]);
      }
      for (const row of upgraded.rows["routine"]!) expect(row).toMatchObject({ route_json: null, approved_route_json: null });
      const routineDdl = upgraded.schema.find(one => one.type === "table" && one.name === "routine")!.sql;
      expect(routineDdl).toContain("route_json");
      expect(routineDdl).toContain("approved_route_json");
      expect(upgraded.schema.find(one => one.type === "table" && one.name === "mate_proposal")!.sql).toContain("'agents'");
      // The upgraded facts read back exactly: the routed approval still
      // seals its route, the pre-routing row is legacy (never backfilled),
      // the chain approval stands, the review request is still pending,
      // the run keeps its provenance, and the routine — approved under
      // v47 with no route — is unfrozen: approved but unfireable until a
      // person refreshes and approves it again.
      store = openStore(file);
      expect(store.sealedRouteOf("t-routed")).toMatchObject({ ok: true });
      expect(store.getScope("t-legacy")).toMatchObject({ routeEra: null, approvedRouteJson: null });
      expect(store.sealedRouteOf("t-legacy")).toMatchObject({ ok: false, reason: "legacy" });
      expect(store.getScope("t-pending")?.approvedAt).toBeNull();
      expect(store.approvedChainOf("t-chain")).not.toBeNull();
      expect(store.runRoute(1)).toMatchObject({ phase: "build", chosen: "recommended" });
      expect(upgraded.rows["review_request"]![0]).toMatchObject({ consumed_at: null });
      const routine = store.getRoutine(1)!;
      expect(routine).toMatchObject({ approvedRoute: null, route: null, approvedProfile: expect.any(Object) });
      expect(routineAgentsState(routine)).toMatchObject({ state: "unfrozen", approvable: false, refresh: true });
      store.close();
      store = null;
      // The second open is a no-op: the full row AND schema snapshots are identical.
      store = openStore(file);
      store.close();
      store = null;
      expect(rawVersion(file)).toBe(SCHEMA_VERSION);
      expect(snapshot(file)).toEqual(upgraded);
    });
  }

  test("the half-applied −47 file and the authentic v47 file upgrade to the SAME rows and schema", () => {
    dir = mkdtempSync(join(tmpdir(), "so-v47-auth-"));
    const whole = loadFixture(dir, "whole.db");
    const partial = loadFixture(dir, "partial.db");
    {
      const db = new sqlite.DatabaseSync(partial);
      db.exec("ALTER TABLE routine ADD COLUMN route_json TEXT");
      db.exec("UPDATE schema_version SET version = -47");
      db.close();
    }
    openStore(whole).close();
    openStore(partial).close();
    expect(snapshot(partial)).toEqual(snapshot(whole));
  });
});

describe("the schema-version preflight reads exactly one safe supported integer before any DDL", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const corrupt = (file: string, sql: string): void => {
    const db = new sqlite.DatabaseSync(file);
    db.exec(sql);
    db.close();
  };

  for (const [label, sql, words] of [
    ["a fractional version", "UPDATE schema_version SET version = 47.5", /47\.5 \(real\), not a safe integer/],
    ["a text version", "UPDATE schema_version SET version = 'forty-seven'", /"forty-seven" \(text\), not a safe integer/],
    ["a version past the safe range", "UPDATE schema_version SET version = 9223372036854775807", /9223372036854775807 \(integer\), not a safe integer/],
    ["a version one past the safe range", "UPDATE schema_version SET version = 9007199254740993", /not a safe integer/],
    ["a zero version", "UPDATE schema_version SET version = 0", /is 0, which no build ever wrote/],
    ["a newer build's version", `UPDATE schema_version SET version = ${SCHEMA_VERSION + 1}`, /written by a newer build/],
    ["a newer build's mid-flight epoch", `UPDATE schema_version SET version = ${-(SCHEMA_VERSION + 1)}`, /written by a newer build/],
    ["two version rows", "INSERT INTO schema_version (version) VALUES (47)", /carries 2 rows, not one/],
    ["no version row", "DELETE FROM schema_version", /carries no row/],
  ] as const) {
    test(`${label} refuses before DDL — the file is untouched`, () => {
      dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
      const file = loadFixture(dir);
      corrupt(file, sql);
      const before = snapshot(file);
      expect(() => openStore(file)).toThrow(words);
      expect(() => openStore(file)).toThrow(/alters nothing it cannot name/);
      // Nothing moved: not the version, not one table's DDL, not one row.
      expect(snapshot(file)).toEqual(before);
      expect(before.schema.find(one => one.type === "table" && one.name === "routine")!.sql).not.toContain("route_json");
    });
  }

  test("the preflight itself: a fresh file answers null, a supported version answers itself, a mid-flight epoch answers its negative", () => {
    dir = mkdtempSync(join(tmpdir(), "so-preflight-"));
    const fresh = new sqlite.DatabaseSync(join(dir, "fresh.db"));
    expect(schemaVersionPreflight(fresh as never, "fresh.db")).toBeNull();
    fresh.close();
    const file = loadFixture(dir);
    const db = new sqlite.DatabaseSync(file);
    expect(schemaVersionPreflight(db as never, file)).toBe(47);
    db.exec("UPDATE schema_version SET version = -47");
    expect(schemaVersionPreflight(db as never, file)).toBe(-47);
    db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION}`);
    expect(schemaVersionPreflight(db as never, file)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
