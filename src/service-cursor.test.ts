import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION } from "./store.js";

describe("restart-safe service progress", () => {
  let dir: string;
  const now = new Date("2026-09-20T10:00:00Z");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-service-cursor-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an authentic v69 database gains empty progress without changing existing work", () => {
    const file = join(dir, "orders.db");
    let store = openStore(file);
    store.createTask({ id: "existing", title: "Preserve current work" }, now);
    store.raw().exec("DROP TABLE service_cursor; UPDATE schema_version SET version = 69");
    store.close();
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version" });
    store = openStore(file);
    expect(store.getTask("existing")?.title).toBe("Preserve current work");
    expect(store.serviceCursor("review-retry-scan")).toBe(0);
    expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    store.setServiceCursor("review-retry-scan", 50, now);
    expect(() => store.transact(() => { store.setServiceCursor("review-retry-scan", 100, now); throw new Error("rollback"); })).toThrow("rollback");
    store.close();
    store = openStore(file);
    expect(store.serviceCursor("review-retry-scan")).toBe(50);
    expect(() => store.setServiceCursor("review-retry-scan", -1, now)).toThrow("invalid");
    expect(() => store.setServiceCursor("review-retry-scan", Number.MAX_SAFE_INTEGER + 1, now)).toThrow("invalid");
    store.close();
  });

  test("a current database with lost progress is refused before migration writes", () => {
    const file = join(dir, "damaged.db");
    const store = openStore(file);
    store.raw().exec("DROP TABLE service_cursor");
    store.close();
    expect(() => openStore(file)).toThrow("service progress is missing");
  });
});
