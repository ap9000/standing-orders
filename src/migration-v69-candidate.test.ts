import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { propose } from "./scope.js";

describe("v69 prepared candidate on the scope", () => {
  let dir: string, store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });
  function fixture(version: number) {
    dir = mkdtempSync(join(tmpdir(), "so-v69-"));
    const file = join(dir, "state.db");
    store = openStore(file);
    const at = new Date("2026-09-18T00:00:00.000Z");
    store.createTask({ id: "older", title: "Filed before v69" }, at);
    const older = propose(store, { taskId: "older", goal: "Keep every filed term", touches: ["src/a.ts"], now: at });
    store.close(); store = undefined;
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("ALTER TABLE task_scope DROP COLUMN candidate");
    db.prepare("UPDATE schema_version SET version=?").run(version);
    const rows = db.prepare("SELECT task_id, goal, digest FROM task_scope").all();
    db.close();
    return { file, older, rows };
  }
  test.each([68, -68])("upgrades v%s: the column appears, older rows keep their bytes and digest, a candidate can be filed", version => {
    const f = fixture(version);
    store = openStore(f.file);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.handle.prepare("SELECT task_id, goal, digest FROM task_scope").all()).toEqual(f.rows);
    const older = store.getScope("older")!;
    expect(older.candidate).toBeNull();
    expect(older.digest).toBe(f.older.digest);
    store.createTask({ id: "newer", title: "Filed after v69" }, new Date());
    const newer = propose(store, { taskId: "newer", goal: "Install it", candidate: "d".repeat(40), now: new Date() });
    expect(store.getScope("newer")?.candidate).toBe("d".repeat(40));
    expect(newer.digest).not.toBe(propose(store, { taskId: "newer", goal: "Install it", now: new Date() }).digest);
  });
});
