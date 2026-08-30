import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION, type Database } from "./store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => Database };

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

  test("the REAL migrator commits the epoch BEFORE any DDL — the version row is already negative at the first exec", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-"));
    const file = join(dir, "orders.db");
    openStore(file).close();

    // Simulate an older database: the shape is current (every migration
    // step is idempotent, so re-running is the documented resume road), but
    // the version row says a lower POSITIVE version — exactly what the
    // migrator sees when it opens a database from the previous release.
    const back = new DatabaseSync(file);
    back.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION - 1);
    back.close();

    // A connect wrapper whose db proxies exec(): at the FIRST exec — the
    // fresh-SCHEMA exec, the first DDL openStore runs — read the version
    // row through a SECOND, independent connection to the same file. If the
    // epoch stamp were ordered after any DDL (the race the review named), a
    // non-migrating reader at this instant would see new shapes under an
    // old positive version.
    let versionAtFirstExec: number | null = null;
    const connect = (path: string): Database => {
      const real = new DatabaseSync(path);
      return {
        prepare: sql => real.prepare(sql),
        close: () => real.close(),
        exec: sql => {
          if (versionAtFirstExec === null) {
            const peek = new DatabaseSync(path);
            const row = peek.prepare("SELECT version FROM schema_version").get();
            versionAtFirstExec = row === undefined ? Number.NaN : Number(row["version"]);
            peek.close();
          }
          real.exec(sql);
        },
      };
    };

    const store = openStore(file, { connect });
    // The sentinel was COMMITTED before the first DDL: negative, and
    // exactly −(the version being migrated from).
    expect(versionAtFirstExec).toBe(-(SCHEMA_VERSION - 1));
    // ...and the finished migrator cleared it to the target version.
    const finished = store.handle.prepare("SELECT version FROM schema_version").get();
    expect(Number(finished?.["version"])).toBe(SCHEMA_VERSION);
    store.close();
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
