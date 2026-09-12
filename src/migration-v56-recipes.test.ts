import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION } from "./store.js";
import { addApprover } from "./scope.js";

test("v55 migration preserves every historical row and refuses missing authority or launch history", () => {
  const root = mkdtempSync(join(tmpdir(), "so-v56-")); const file = join(root, "orders.db");
  try {
    const store = openStore(file); const now = new Date("2026-09-12T22:00:00Z"); addApprover(store, "owner", now);
    store.createTask({ id: "retained", title: "Keep this task" }, now); store.placeTask(store.lookupRef("retained")!.id, root); store.close();
    const old = new DatabaseSync(file); old.exec("DROP TABLE workflow_preview; DROP TABLE workflow_recipe; UPDATE schema_version SET version=55;");
    const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version','sqlite_sequence') ORDER BY name").all().map(row => String(row.name));
    const before = tables.map(table => old.prepare(`SELECT * FROM "${table}"`).all()); old.close();
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version" });
    const upgraded = openStore(file); expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
    expect(tables.map(table => upgraded.handle.prepare(`SELECT * FROM "${table}"`).all())).toEqual(before);
    expect(upgraded.handle.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok"); expect(upgraded.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    upgraded.close(); const stable = readFileSync(file); openStore(file).close(); expect(readFileSync(file)).toEqual(stable);
    const broken = new DatabaseSync(file); broken.exec("DROP TABLE workflow_preview"); broken.close(); const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow("refusing to recreate launch history"); expect(readFileSync(file)).toEqual(bytes);
    const missing = new DatabaseSync(file); missing.exec("UPDATE schema_version SET version=55; DROP TABLE plan_authorization"); missing.close(); const missingBytes = readFileSync(file);
    expect(() => openStore(file)).toThrow("refusing to recreate authority"); expect(readFileSync(file)).toEqual(missingBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
