import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildRunForV34 } from "./store.js";

/** The v29 run shape after v30's ALTER ADD COLUMNs — exactly what every
 * v30..v33 database carries (SQLite appends the columns before the CHECK). */
const V29_PLUS_V30 = `CREATE TABLE run (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    lease_id      TEXT NOT NULL,
    runner        TEXT NOT NULL,
    scope_digest     TEXT,
    profile_digest   TEXT,
    provider_version TEXT,
    role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner','reviewer')),
    provider      TEXT NOT NULL DEFAULT 'claude',
    parent_run    INTEGER REFERENCES run(id),
    session_id    TEXT,
    base_revision TEXT,
    branch        TEXT,
    worktree      TEXT,
    model         TEXT,
    phase         TEXT,
    contestant    INTEGER REFERENCES contestant(id),
    outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
    reason        TEXT,
    committed     INTEGER,
    attended_authorization TEXT REFERENCES attended_authorization(id),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    provider_started_at TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    usage_json    TEXT,
    head_revision TEXT,
    handoff       TEXT, chain_cycle INTEGER REFERENCES fallback_cycle(id), chain_index INTEGER, entry_digest TEXT, auth_mode TEXT, terminal_class TEXT,
    CHECK ((role = 'reviewer' AND branch IS NULL AND worktree IS NULL)
        OR (role <> 'reviewer' AND branch IS NOT NULL AND worktree IS NOT NULL))
  )`;

describe("schema v34: 'scout' joins run.role by an exact copy-rename", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE task_ref (id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL)");
    db.exec("CREATE TABLE contestant (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE attended_authorization (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE fallback_cycle (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("INSERT INTO task_ref (external_id) VALUES ('t-1')");
    return db;
  };

  test("a v29+v30 table with rows is rebuilt in place: ids and rows kept, 'scout' admitted, idempotent", () => {
    const db = fresh();
    db.exec(V29_PLUS_V30);
    db.exec("INSERT INTO run (id, task_ref, lease_id, runner, role, branch, worktree, started_at, chain_index) VALUES (9, 1, 'l', 'b', 'planner', 'br', '/wt', '2026-09-02T00:00:00.000Z', 3)");
    expect(() => db.exec("INSERT INTO run (task_ref, lease_id, runner, role, branch, worktree, started_at) VALUES (1, 'l2', 'b', 'scout', 'br', '/wt', 'x')")).toThrow();
    rebuildRunForV34(db);
    expect(db.prepare("SELECT id, role, chain_index FROM run").all()).toEqual([{ id: 9, role: "planner", chain_index: 3 }]);
    db.exec("INSERT INTO run (task_ref, lease_id, runner, role, branch, worktree, started_at) VALUES (1, 'l2', 'b', 'scout', 'br', '/wt', 'x')");
    // The exclusive workspace CHECK survives: a scout carries a workspace, a reviewer never.
    expect(() => db.exec("INSERT INTO run (task_ref, lease_id, runner, role, started_at) VALUES (1, 'l3', 'b', 'scout', 'x')")).toThrow();
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'run'").get()?.["sql"]);
    rebuildRunForV34(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'run'").get()?.["sql"])).toBe(ddl);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run").get()?.["n"]).toBe(2);
  });

  test("a shape this migration does not know refuses rather than guessing", () => {
    const db = fresh();
    db.exec(V29_PLUS_V30.replace("handoff       TEXT,", "handoff       TEXT, extra TEXT,"));
    expect(() => rebuildRunForV34(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'run'").get()).toBeDefined();
  });
});
