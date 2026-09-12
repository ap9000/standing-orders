/**
 * Schema v51 widens artifact.kind for the planner's recorded source and its
 * plan-contract ingestion record (contract handoff, task 1). The migration
 * is the v46 recipe again: an exact-recognizer copy/rename that preserves
 * every historical row and id, refuses a near-v50 shape, and is a no-op on
 * the target shape. A v45 file still climbs the whole ladder.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, rebuildArtifactForV51, SCHEMA_VERSION, type Store } from "./store.js";

const bareLegacy = (phase: "build" | "plan", provider = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const V50_ARTIFACT = `CREATE TABLE artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot','structured-output')),
  key TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  capture TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
)`;

const V45_ARTIFACT = V50_ARTIFACT.replace(",'structured-output'", "");

describe("schema v51: the planner's source and plan-contract record are evidence", () => {
  let dir: string | undefined;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const wind = (shape: string, version: number): { file: string; run: number; before: unknown[] } => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v51-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    store.createTask({ id: "t", title: "t" }, new Date("2026-09-11T00:00:00.000Z"));
    const ref = store.refFor("built-in", "t");
    store.placeTask(ref.id, "/repo");
    const run = store.startRun({ taskRef: ref.id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", role: "planner", ...bareLegacy("plan"), now: new Date("2026-09-11T00:00:00.000Z") });
    store.saveArtifact(
      { run, kind: "structured-output", key: `${run}/planner-response-1.txt`, bytesOriginal: 3, bytesStored: 3, truncated: false, sha256: "h", capture: "planner response 1", captureStatus: "failed", redacted: true },
      new Date("2026-09-11T00:00:01.000Z"),
    );
    const raw = store.raw();
    if (shape === V45_ARTIFACT) raw.exec("DELETE FROM artifact WHERE kind = 'structured-output'");
    raw.exec(`CREATE TABLE artifact_copy AS SELECT * FROM artifact;
      DROP TABLE artifact;
      ${shape};
      INSERT INTO artifact SELECT * FROM artifact_copy;
      DROP TABLE artifact_copy;`);
    const before = raw.prepare("SELECT * FROM artifact ORDER BY id").all();
    expect(() =>
      raw.prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?, 'plan-contract', ?, 2, 2, 'x', 'x', ?)").run(run, `${run}/planner-source.json`, "2026-09-11T00:00:02.000Z"),
    ).toThrow();
    raw.prepare("UPDATE schema_version SET version = ?").run(version);
    store.close();
    store = null;
    return { file, run, before };
  };

  test.each([
    ["a v50 file", V50_ARTIFACT, 50],
    ["a v45 file (the whole ladder)", V45_ARTIFACT, 45],
  ])("%s widens to v51 without changing any historical field or id, then reopens as a no-op", (_label, shape, version) => {
    const { file, run, before } = wind(shape, version);
    store = openStore(file);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(store.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(before);
    const added = store.saveArtifact(
      { run, kind: "plan-contract", key: `${run}/planner-source.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "s", capture: "planner source", captureStatus: "ok" },
      new Date("2026-09-11T00:01:00.000Z"),
    );
    expect(store.getArtifact(added)).toMatchObject({ kind: "plan-contract", key: `${run}/planner-source.json` });
    expect(store.plannerSourceArtifactFor(run)?.id).toBe(added);
    expect(store.latestPlanContractArtifact(store.refFor("built-in", "t").id)).toBeNull();
    const contract = store.saveArtifact(
      { run, kind: "plan-contract", key: `${run}/plan-contract.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "c", capture: "plan ingestion", captureStatus: "ok" },
      new Date("2026-09-11T00:02:00.000Z"),
    );
    expect(store.latestPlanContractArtifact(store.refFor("built-in", "t").id)?.id).toBe(contract);
    expect(store.plannerSourceArtifactFor(run)?.id).toBe(added);

    const ddl = String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact'").get()?.["sql"]);
    expect(ddl).toContain("'structured-output','plan-contract'");
    const rows = store.raw().prepare("SELECT * FROM artifact ORDER BY id").all();
    store.close();
    store = openStore(file);
    expect(String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact'").get()?.["sql"])).toBe(ddl);
    expect(store.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(rows);
  });

  test("a fresh file is born at v51 and admits the kind at once", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v51-"));
    store = openStore(join(dir, "fresh.db"));
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(51);
    store.createTask({ id: "t", title: "t" }, new Date("2026-09-11T00:00:00.000Z"));
    const ref = store.refFor("built-in", "t");
    const run = store.startRun({ taskRef: ref.id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", role: "planner", ...bareLegacy("plan"), now: new Date("2026-09-11T00:00:00.000Z") });
    expect(() =>
      store!.saveArtifact({ run, kind: "plan-contract", key: `${run}/planner-source.json`, bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "s", capture: "c" }, new Date()),
    ).not.toThrow();
  });

  test("the exact recognizer refuses a near-v50 table and leaves it untouched", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO run DEFAULT VALUES;");
      db.exec(V50_ARTIFACT.replace("capture_status TEXT", "note TEXT DEFAULT 'unexpected', capture_status TEXT"));
      db.exec("INSERT INTO artifact (id, run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (9, 1, 'plan', '1/plan.md', 3, 3, 'sha', 'capture', '2026-09-11T00:00:00.000Z')");
      const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"]);
      const rows = db.prepare("SELECT * FROM artifact").all();
      expect(() => rebuildArtifactForV51(db)).toThrow(/not a shape this migration knows/);
      expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toBe(ddl);
      expect(db.prepare("SELECT * FROM artifact").all()).toEqual(rows);
      expect(() =>
        db.exec("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'plan-contract', '1/x', 1, 1, 'x', 'x', 'x')"),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
