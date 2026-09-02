import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildMateProposalForV33 } from "./store.js";

const V32 = `CREATE TABLE mate_proposal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','scope','cancel')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
)`;

describe("schema v33: `answer` joins mate_proposal by an exact copy-rename", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE mate_thread (id INTEGER PRIMARY KEY AUTOINCREMENT, approver TEXT NOT NULL)");
    db.exec("INSERT INTO mate_thread (approver) VALUES ('alex')");
    return db;
  };

  test("a v32 table with rows is rebuilt in place: ids and rows kept, the index back, `answer` admitted, idempotent", () => {
    const db = fresh();
    db.exec(V32);
    db.exec("CREATE INDEX IF NOT EXISTS mate_proposal_thread ON mate_proposal (thread, state)");
    db.exec("INSERT INTO mate_proposal (id, thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (7, 1, 1, 'hold', '{}', 'd', 'pending', '2026-09-02T00:00:00.000Z')");
    expect(() => db.exec("INSERT INTO mate_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (1, 1, 'answer', '{}', 'd', 'pending', 'x')")).toThrow();
    rebuildMateProposalForV33(db);
    expect(db.prepare("SELECT id, kind FROM mate_proposal").all()).toEqual([{ id: 7, kind: "hold" }]);
    db.exec("INSERT INTO mate_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (1, 1, 'answer', '{}', 'd', 'pending', 'x')");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mate_proposal_thread'").get()).toBeDefined();
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mate_proposal'").get()?.["sql"]);
    rebuildMateProposalForV33(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mate_proposal'").get()?.["sql"])).toBe(ddl);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mate_proposal").get()?.["n"]).toBe(2);
  });

  test("a shape this migration does not know refuses rather than guessing", () => {
    const db = fresh();
    db.exec(V32.replace("outcome_json   TEXT", "outcome_json   TEXT,\n  extra TEXT DEFAULT 'answer'"));
    expect(() => rebuildMateProposalForV33(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mate_proposal'").get()).toBeDefined();
  });
});
