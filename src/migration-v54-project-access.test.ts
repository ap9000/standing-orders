import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { addApprover } from "./scope.js";

test("v53 upgrades with unchanged account and invite authority; reopening is byte-identical", () => {
  const root = mkdtempSync(join(tmpdir(), "so-v54-migration-"));
  const file = join(root, "state.sqlite");
  try {
    const initial = openStore(file);
    const now = new Date("2026-09-12T10:00:00Z");
    addApprover(initial, "owner", now);
    initial.mintInvite("viewer", "owner", now);
    initial.createTask({ id: "existing-work", title: "Keep historical work" }, now);
    initial.close();
    // Reconstruct the immediately preceding schema, removing only v54's
    // additions. Account credentials, invite hashes, IDs, and work survive.
    const old = new DatabaseSync(file);
    for (const row of old.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'ledger_%' OR name LIKE 'action_ledger_%')").all()) old.exec(`DROP TRIGGER "${String(row.name)}"`);
    old.exec("DROP TABLE plan_authorization; DROP TABLE action_ledger; ALTER TABLE approver DROP COLUMN projects_json; ALTER TABLE invite DROP COLUMN projects_json; UPDATE schema_version SET version=53;");
    const accounts = old.prepare("SELECT * FROM approver").all();
    const invites = old.prepare("SELECT * FROM invite").all();
    const tasks = old.prepare("SELECT * FROM task").all();
    old.close();
    const upgraded = openStore(file);
    expect(upgraded.raw().prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
    const withoutScope = (rows: Record<string, unknown>[]) => rows.map(row => { const copy = { ...row }; expect(copy.projects_json).toBeNull(); delete copy.projects_json; return copy; });
    expect(withoutScope(upgraded.raw().prepare("SELECT * FROM approver").all())).toEqual(accounts);
    expect(withoutScope(upgraded.raw().prepare("SELECT * FROM invite").all())).toEqual(invites);
    expect(upgraded.raw().prepare("SELECT * FROM task").all()).toEqual(tasks);
    expect(upgraded.isInstanceOperator("owner")).toBe(true);
    expect(upgraded.actionLedger({ repos: null })).toEqual([]);
    upgraded.close();
    const before = readFileSync(file);
    openStore(file).close();
    expect(readFileSync(file)).toEqual(before);
    const damaged = new DatabaseSync(file);
    damaged.exec("ALTER TABLE approver DROP COLUMN projects_json");
    damaged.close();
    const damagedBytes = readFileSync(file);
    expect(() => openStore(file)).toThrow("refusing to widen access");
    expect(readFileSync(file)).toEqual(damagedBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
