import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";

test("v59 chat migration preserves cards, sequence and foreign keys, and reopens cleanly", () => {
  const root = mkdtempSync(join(tmpdir(), "so-chat-migration-"));
  const file = join(root, "fixture.db"), now = new Date();
  try {
    let store = openStore(file);
    const thread = store.openMateThread("test", "ceiling", now).thread;
    const id = store.draftMateProposal({ thread: thread.id, turn: 1, kind: "hold", payload: { task: "a", reason: "keep" }, ceilingDigest: "ceiling" }, now);
    store.close();
    const db = new DatabaseSync(file);
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='mate_proposal'").get()!.sql);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    db.exec(ddl.replace("mate_proposal", "old_proposal").replace(",'review','control','task_action','action'", ""));
    db.exec("INSERT INTO old_proposal SELECT * FROM mate_proposal; DROP TABLE mate_proposal; ALTER TABLE old_proposal RENAME TO mate_proposal");
    db.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='mate_proposal'").run();
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='mate_proposal'").get()!.sql)).not.toContain("'action'");
    db.exec("UPDATE schema_version SET version=59; COMMIT");
    db.close();
    store = openStore(file);
    expect(store.getMateProposal(id)).toMatchObject({ kind: "hold", state: "drafting", payload: { task: "a", reason: "keep" } });
    expect(store.draftMateProposal({ thread: thread.id, turn: 2, kind: "review", payload: {}, ceilingDigest: "ceiling" }, now)).toBe(101);
    expect(store.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
    store.close();
    store = openStore(file);
    expect(store.getMateProposal(101)?.kind).toBe("review");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
