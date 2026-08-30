import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION } from "./store.js";

/**
 * The migration epoch + the non-migrating door (MCP gateway spec v6,
 * Codex rounds 3/5): the MCP server never creates or migrates, and a
 * migration mid-flight is VISIBLE (negative version) rather than a
 * silently half-shaped database a version re-read would bless.
 */
describe("the non-migrating door", () => {
  test("an absent database refuses in words — it never creates one", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-"));
    const answer = openStoreNoMigrate(join(dir, "never-made.db"));
    expect(answer).toMatchObject({ ok: false, reason: "missing" });
  });

  test("a current database opens; a mid-flight epoch refuses with the sentinel named", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-"));
    const file = join(dir, "orders.db");
    openStore(file).close();

    const opened = openStoreNoMigrate(file);
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.store.schemaCurrent()).toBe(true);

    // A migrator that died after its epoch stamp, before the version bump:
    // the sentinel is a NEGATIVE version, and both the door and the
    // per-call check refuse — this is exactly the mid-DDL window a plain
    // version re-read would have blessed.
    opened.store.handle.prepare("UPDATE schema_version SET version = ?").run(-(SCHEMA_VERSION - 1));
    expect(opened.store.schemaCurrent()).toBe(false);
    opened.store.close();

    const refused = openStoreNoMigrate(file);
    expect(refused).toMatchObject({ ok: false, reason: "version" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("mid-flight");

    // The real migrator resumes and clears the sentinel; the door opens.
    openStore(file).close();
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: true });
  });

  test("a version this build does not speak refuses without touching it", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-"));
    const file = join(dir, "orders.db");
    openStore(file).close();
    const opened = openStoreNoMigrate(file);
    if (!opened.ok) throw new Error("setup failed");
    opened.store.handle.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 5);
    opened.store.close();
    const refused = openStoreNoMigrate(file);
    expect(refused).toMatchObject({ ok: false, reason: "version" });
  });
});
