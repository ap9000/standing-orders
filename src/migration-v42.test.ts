import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildMateProposalForV42 } from "./store.js";

const V33 = `CREATE TABLE mate_proposal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','scope','cancel','answer')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
)`;

describe("schema v42: dependency repair joins mate proposals", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE mate_thread (id INTEGER PRIMARY KEY AUTOINCREMENT, approver TEXT NOT NULL)");
    db.exec("INSERT INTO mate_thread (approver) VALUES ('alex')");
    return db;
  };

  test("keeps existing rows and ids, admits repair, restores the index, and is idempotent", () => {
    const db = fresh();
    db.exec(V33);
    db.exec("CREATE INDEX mate_proposal_thread ON mate_proposal (thread, state)");
    db.exec("INSERT INTO mate_proposal (id, thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (7, 1, 1, 'answer', '{}', 'd', 'pending', 'x')");

    rebuildMateProposalForV42(db);

    expect(db.prepare("SELECT id, kind FROM mate_proposal").all()).toEqual([{ id: 7, kind: "answer" }]);
    db.exec("INSERT INTO mate_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at) VALUES (1, 2, 'repair', '{}', 'd', 'pending', 'y')");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mate_proposal_thread'").get()).toBeDefined();
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mate_proposal'").get()?.["sql"]);
    rebuildMateProposalForV42(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mate_proposal'").get()?.["sql"])).toBe(ddl);
  });

  test("refuses an unknown predecessor shape without dropping it", () => {
    const db = fresh();
    db.exec(V33.replace("outcome_json   TEXT", "outcome_json   TEXT, extra TEXT"));
    expect(() => rebuildMateProposalForV42(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mate_proposal'").get()).toBeDefined();
  });
});
