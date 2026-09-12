import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, openStoreNoMigrate, openStoreReadOnly, type Store } from "./store.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "so-contention-"));
  roots.push(root);
  const file = join(root, "orders.db");
  const store = openStore(file);
  store.createTask({ id: "shared", title: "Before writer" }, new Date());
  store.close();
  return file;
}

/** Release runs in another process even while DatabaseSync blocks this one. */
async function holdWriter(file: string, releaseAfterMs: number | null): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE task SET title = 'Writer committed' WHERE id = 'shared'").run();
    process.send('locked');
    const release = () => { db.exec('COMMIT'); db.close(); process.disconnect(); };
    const delay = JSON.parse(process.argv[2]);
    if (delay === null) process.once('message', release);
    else setTimeout(release, delay);
  `, file, JSON.stringify(releaseAfterMs)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", chunk => { err += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`writer exited before ready: ${code}: ${err}`)));
    child.once("message", message => message === "locked" ? resolve() : reject(new Error("unexpected writer message")));
  });
  return child;
}

describe("brief concurrent database writers do not disconnect the controller", () => {
  test("CLI opening while another process writes waits and observes its committed data", async () => {
    const file = fixture();
    await holdWriter(file, 300);
    let store: Store | undefined;
    try {
      store = openStore(file);
      expect(store.getTask("shared")?.title).toBe("Writer committed");
      expect(store.raw().prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { store?.close(); }
  });

  test("the non-migrating desktop connection waits at BEGIN without replaying the body", async () => {
    const file = fixture();
    const opened = openStoreNoMigrate(file);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      await holdWriter(file, 300);
      let calls = 0;
      store.transact(() => {
        calls++;
        expect(store.getTask("shared")?.title).toBe("Writer committed");
        store.createTask({ id: "once", title: "Executed once" }, new Date());
      });
      expect(calls).toBe(1);
      expect(store.getTask("once")?.title).toBe("Executed once");
    } finally { store.close(); }
  });

  test("a persistent lock refuses in finite time before the body, without partial writes", async () => {
    const file = fixture();
    const opened = openStoreNoMigrate(file);
    if (!opened.ok) throw new Error(opened.message);
    const { store } = opened;
    try {
      const child = await holdWriter(file, null);
      let calls = 0;
      const started = Date.now();
      expect(() => store.transact(() => {
        calls++;
        store.createTask({ id: "must-not-exist", title: "No partial write" }, new Date());
      })).toThrow(/database is locked/);
      // Allow scheduling tolerance around the configured five-second wait.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(calls).toBe(0);
      expect(store.getTask("must-not-exist")).toBeNull();
      child.send("release");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
      store.transact(() => store.createTask({ id: "recovered", title: "Writer recovered" }, new Date()));
      expect(store.getTask("recovered")).not.toBeNull();
    } finally { store.close(); }
  });

  test("WAL reporting can read the last committed view during a writer and stays read-only", async () => {
    const file = fixture();
    const child = await holdWriter(file, null);
    const reporting = openStoreReadOnly(file);
    try {
      expect(reporting?.getTask("shared")?.title).toBe("Before writer");
      expect(() => reporting!.createTask({ id: "forbidden", title: "No writes" }, new Date())).toThrow(/readonly/i);
    } finally { reporting?.close(); child.send("release"); }
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
  });
});
