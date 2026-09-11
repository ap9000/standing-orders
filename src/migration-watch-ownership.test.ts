import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";

describe("v49 review watch ownership migration", () => {
  for (const epoch of [48, -48]) test(`v${epoch} upgrades without inventing historical ownership, and reopens unchanged`, () => {
    const dir = mkdtempSync(join(tmpdir(), "so-watch-migration-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      const now = new Date("2026-09-11T12:00:00Z");
      store.createTask({ id: "history", title: "Historical work" }, now);
      const taskRef = store.refFor("built-in", "history").id;
      store.startRun({ taskRef, runner: "historical", leaseId: "past", branch: "history", worktree: "/past", now,
        route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
      store.close();
      const raw = new DatabaseSync(file);
      raw.exec("ALTER TABLE run DROP COLUMN watch_incarnation");
      raw.prepare("UPDATE schema_version SET version = ?").run(epoch);
      const before = raw.prepare("SELECT * FROM run").all();
      raw.close();
      const upgraded = openStore(file);
      expect(upgraded.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
      expect(upgraded.getRun(1)?.watchIncarnation).toBeNull();
      const after = upgraded.raw().prepare("SELECT * FROM run").all();
      expect(after.map(({ watch_incarnation: _binding, ...row }) => row)).toEqual(before);
      upgraded.close();
      const again = openStore(file);
      expect(again.raw().prepare("SELECT * FROM run").all()).toEqual(after);
      expect(again.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      again.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
