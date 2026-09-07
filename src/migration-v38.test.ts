import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildArtifactForV38, rebuildIncidentForV38 } from "./store.js";

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
const V34_ARTIFACT = `CREATE TABLE artifact (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report')),
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
const V34_INCIDENT = `CREATE TABLE incident (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted','malformed-report')),
    created_at  TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  )`;

const fresh = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT)");
  db.exec("INSERT INTO run DEFAULT VALUES");
  return db;
};

describe("schema v38: artifact.kind and incident.kind widen by EXACT recognizers, from either predecessor shape", () => {
  test("artifact from the v17 shape: rows kept, 'proof'/'check-log'/'screenshot' admitted, idempotent", () => {
    const db = fresh();
    db.exec(V17_ARTIFACT);
    db.exec(
      "INSERT INTO artifact (id, run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at, capture_status) VALUES (4, 1, 'plan', 'k', 1, 1, 's', 'c', 'x', 'ok')",
    );
    expect(() =>
      db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'proof', 'k', 1, 1, 's', 'c', 'x')"),
    ).toThrow();

    rebuildArtifactForV38(db);

    expect(db.prepare("SELECT id, kind, capture_status FROM artifact").all()).toEqual([{ id: 4, kind: "plan", capture_status: "ok" }]);
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'proof', 'k', 1, 1, 's', 'c', 'x')");
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'check-log', 'k', 1, 1, 's', 'c', 'x')");
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'screenshot', 'k', 1, 1, 's', 'c', 'x')");
    // 'report' (v34) survives too — a v17 file may still be mid-upgrade elsewhere.
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'report', 'k', 1, 1, 's', 'c', 'x')");

    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"]);
    rebuildArtifactForV38(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toBe(ddl);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact").get()?.["n"]).toBe(5);
  });

  test("artifact from the v34 shape: rows kept, new kinds admitted, idempotent", () => {
    const db = fresh();
    db.exec(V34_ARTIFACT);
    db.exec("INSERT INTO artifact (id, run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (9, 1, 'report', 'k', 1, 1, 's', 'c', 'x')");
    expect(() =>
      db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'check-log', 'k', 1, 1, 's', 'c', 'x')"),
    ).toThrow();

    rebuildArtifactForV38(db);

    expect(db.prepare("SELECT id, kind FROM artifact").all()).toEqual([{ id: 9, kind: "report" }]);
    db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'check-log', 'k', 1, 1, 's', 'c', 'x')");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"]);
    rebuildArtifactForV38(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toBe(ddl);
  });

  test("a shape this migration does not know refuses rather than guessing, and leaves the table untouched", () => {
    const db = fresh();
    db.exec(V34_ARTIFACT.replace("capture_status TEXT", "note TEXT DEFAULT 'proof', capture_status TEXT"));
    expect(() => rebuildArtifactForV38(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact'").get()).toBeDefined();
  });

  test("incident from the v7 shape: rows kept, 'malformed-proof' admitted, idempotent", () => {
    const db = fresh();
    db.exec(V7_INCIDENT);
    db.exec("INSERT INTO incident (id, run, kind, created_at) VALUES (2, 1, 'malformed-plan', 'x')");
    db.exec("INSERT INTO run DEFAULT VALUES");
    db.exec("INSERT INTO run DEFAULT VALUES");
    expect(() => db.exec("INSERT INTO incident (run, kind, created_at) VALUES (2, 'malformed-proof', 'x')")).toThrow();

    rebuildIncidentForV38(db);

    expect(db.prepare("SELECT id, kind FROM incident").all()).toEqual([{ id: 2, kind: "malformed-plan" }]);
    db.exec("INSERT INTO incident (run, kind, created_at) VALUES (2, 'malformed-proof', 'x')");
    db.exec("INSERT INTO incident (run, kind, created_at) VALUES (3, 'malformed-report', 'x')");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"]);
    rebuildIncidentForV38(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"])).toBe(ddl);
  });

  test("incident from the v34 shape: rows kept, 'malformed-proof' admitted, idempotent", () => {
    const db = fresh();
    db.exec(V34_INCIDENT);
    db.exec("INSERT INTO incident (id, run, kind, created_at) VALUES (3, 1, 'malformed-report', 'x')");
    db.exec("INSERT INTO run DEFAULT VALUES");
    expect(() => db.exec("INSERT INTO incident (run, kind, created_at) VALUES (2, 'malformed-proof', 'x')")).toThrow();

    rebuildIncidentForV38(db);

    expect(db.prepare("SELECT id, kind FROM incident").all()).toEqual([{ id: 3, kind: "malformed-report" }]);
    db.exec("INSERT INTO incident (run, kind, created_at) VALUES (2, 'malformed-proof', 'x')");
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"]);
    rebuildIncidentForV38(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'incident'").get()?.["sql"])).toBe(ddl);
  });

  test("a lookalike incident table refuses rather than guessing", () => {
    const db = fresh();
    db.exec(V34_INCIDENT.replace("resolved_by TEXT", "resolved_by TEXT, note TEXT DEFAULT 'malformed-proof'"));
    expect(() => rebuildIncidentForV38(db)).toThrow(/not a shape this migration knows/);
  });
});
