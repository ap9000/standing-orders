import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildArtifactForV34, rebuildIncidentForV34, rebuildRunForV34 } from "./store.js";

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

const V17_ARTIFACT = `CREATE TABLE artifact (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree')),
    key            TEXT NOT NULL,
    bytes_original INTEGER NOT NULL,
    bytes_stored   INTEGER NOT NULL,
    truncated      INTEGER NOT NULL DEFAULT 0,
    sha256         TEXT NOT NULL,
    capture        TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    redacted       INTEGER NOT NULL DEFAULT 0,
    capture_status TEXT CHECK (capture_status IN ('ok','failed'))
  )`;
const V7_INCIDENT = `CREATE TABLE incident (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted')),
    created_at  TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  )`;

describe("schema v34: artifact.kind and incident.kind widen by EXACT recognizers (v4 review, finding 7)", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("INSERT INTO run DEFAULT VALUES");
    return db;
  };

  test("artifact: rows kept, 'report' admitted, idempotent; a lookalike shape refuses", () => {
    const db = fresh();
    db.exec(V17_ARTIFACT);
    db.exec("INSERT INTO artifact (id, run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at, capture_status) VALUES (4, 1, 'plan', 'k', 1, 1, 's', 'c', 'x', 'ok')");
    expect(() => db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'report', 'k', 1, 1, 's', 'c', 'x')")).toThrow();
    rebuildArtifactForV34(db);
    expect(db.prepare("SELECT id, kind, capture_status FROM artifact").all()).toEqual([{ id: 4, kind: "plan", capture_status: "ok" }]);
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'report', 'k', 1, 1, 's', 'c', 'x')");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"]);
    rebuildArtifactForV34(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toBe(ddl);

    // A table that merely CONTAINS the word 'report' in an unrelated column
    // is not the target shape — and not the old one either: refuse.
    const other = fresh();
    other.exec(V17_ARTIFACT.replace("capture_status TEXT", "note TEXT DEFAULT 'report', capture_status TEXT"));
    expect(() => rebuildArtifactForV34(other)).toThrow(/not a shape this migration knows/);
  });

  test("incident: rows kept, 'malformed-report' admitted, idempotent; a lookalike shape refuses", () => {
    const db = fresh();
    db.exec(V7_INCIDENT);
    db.exec("INSERT INTO incident (id, run, kind, created_at) VALUES (2, 1, 'malformed-plan', 'x')");
    rebuildIncidentForV34(db);
    expect(db.prepare("SELECT id, kind FROM incident").all()).toEqual([{ id: 2, kind: "malformed-plan" }]);
    db.exec("INSERT INTO run DEFAULT VALUES");
    db.exec("INSERT INTO incident (run, kind, created_at) VALUES (2, 'malformed-report', 'x')");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"]);
    rebuildIncidentForV34(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"])).toBe(ddl);
    const other = fresh();
    other.exec(V7_INCIDENT.replace("resolved_by TEXT", "resolved_by TEXT, note TEXT DEFAULT 'malformed-report'"));
    expect(() => rebuildIncidentForV34(other)).toThrow(/not a shape this migration knows/);
  });
});
