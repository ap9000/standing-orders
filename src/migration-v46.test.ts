/**
 * Schema v46 widens artifact.kind for structured planner/reviewer attempts.
 * The migration is an exact-recognizer copy/rename: historical rows and
 * ids survive byte-for-byte, an almost-v45 schema is refused, and reopening
 * the target shape is a no-op.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, rebuildArtifactForV46, SCHEMA_VERSION, type Store } from "./store.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const V45_ARTIFACT = `CREATE TABLE artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot')),
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

describe("schema v46: structured output attempts are evidence", () => {
  let dir: string | undefined;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a v45 artifact table widens without changing any historical field or id", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v46-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    store.createTask({ id: "t", title: "t" }, new Date("2026-09-10T00:00:00.000Z"));
    const ref = store.refFor("built-in", "t");
    store.placeTask(ref.id, "/repo");
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "l",
      runner: "r",
      branch: "b",
      worktree: "/w",
      ...bareLegacy("build", "claude", null), now: new Date("2026-09-10T00:00:00.000Z"),
    });
    const first = store.saveArtifact(
      {
        run,
        kind: "status",
        key: `${run}/status.txt`,
        bytesOriginal: 11,
        bytesStored: 7,
        truncated: true,
        sha256: "historical-sha",
        capture: "historical capture",
        redacted: true,
        captureStatus: "failed",
      },
      new Date("2026-09-10T00:00:00.000Z"),
    );
    const second = store.saveArtifact(
      {
        run,
        kind: "screenshot",
        key: `${run}/screen.png`,
        bytesOriginal: 20,
        bytesStored: 20,
        truncated: false,
        sha256: "screen-sha",
        capture: "browser screenshot",
        captureStatus: "ok",
      },
      new Date("2026-09-10T00:00:01.000Z"),
    );
    const raw = store.raw();
    raw.exec(`CREATE TABLE artifact_v45_copy AS SELECT * FROM artifact;
      DROP TABLE artifact;
      ${V45_ARTIFACT};
      INSERT INTO artifact SELECT * FROM artifact_v45_copy;
      DROP TABLE artifact_v45_copy;`);
    const before = raw.prepare("SELECT * FROM artifact ORDER BY id").all();
    expect(() =>
      raw.prepare(
        "INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?, 'structured-output', ?, 2, 2, 'x', 'x', ?)",
      ).run(run, `${run}/not-yet.txt`, "2026-09-10T00:00:02.000Z"),
    ).toThrow();
    store.raw().prepare("UPDATE schema_version SET version = 45").run();
    store.close();
    store = null;

    store = openStore(file);
    expect(Number(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(store.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(before);
    expect(store.artifactsFor(run)).toEqual([
      expect.objectContaining({
        id: first,
        kind: "status",
        bytesOriginal: 11,
        bytesStored: 7,
        truncated: true,
        sha256: "historical-sha",
        capture: "historical capture",
        createdAt: "2026-09-10T00:00:00.000Z",
        redacted: true,
        captureStatus: "failed",
      }),
      expect.objectContaining({
        id: second,
        kind: "screenshot",
        truncated: false,
        redacted: false,
        captureStatus: "ok",
      }),
    ]);

    const added = store.saveArtifact(
      {
        run,
        kind: "structured-output",
        key: `${run}/planner-response-1.txt`,
        bytesOriginal: 2,
        bytesStored: 2,
        truncated: false,
        sha256: "new-sha",
        capture: "planner response",
        captureStatus: "failed",
      },
      new Date("2026-09-10T00:01:00.000Z"),
    );
    expect(added).toBe(second + 1);
    expect(store.getArtifact(added)).toMatchObject({ kind: "structured-output", captureStatus: "failed" });

    const ddl = String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact'").get()?.["sql"]);
    const afterFirstOpen = store.raw().prepare("SELECT * FROM artifact ORDER BY id").all();
    store.close();
    store = openStore(file);
    expect(String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifact'").get()?.["sql"])).toBe(ddl);
    expect(store.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(afterFirstOpen);
  });

  test("the exact recognizer refuses a near-v45 table and leaves it untouched", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO run DEFAULT VALUES;");
      db.exec(V45_ARTIFACT.replace("capture_status TEXT", "note TEXT DEFAULT 'unexpected', capture_status TEXT"));
      db.exec(
        "INSERT INTO artifact (id, run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (9, 1, 'plan', '1/plan.json', 3, 3, 'sha', 'capture', '2026-09-10T00:00:00.000Z')",
      );
      const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"]);
      const rows = db.prepare("SELECT * FROM artifact").all();

      expect(() => rebuildArtifactForV46(db)).toThrow(/not a shape this migration knows/);
      expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toBe(ddl);
      expect(db.prepare("SELECT * FROM artifact").all()).toEqual(rows);
      expect(() =>
        db.exec(
          "INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (1, 'structured-output', '1/x', 1, 1, 'x', 'x', 'x')",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
