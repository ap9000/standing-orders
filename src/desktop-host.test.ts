import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDesktopConfig, writeDesktopConfig, loadOrCreateDesktopConfig, openDesktopStore, openConfiguredDesktopStore, pairDesktopLogin, addDesktopProjects, desktopMain, desktopDatabaseStatus, desktopServiceDefinition } from "./desktop-host.js";

test("first setup creates one database; a disappeared established database never becomes an empty replacement queue", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-missing-database-"));
  try {
    const config = loadOrCreateDesktopConfig(root, true);
    expect(config.databaseInitialized).toBe(false);
    const store = openConfiguredDesktopStore(root);
    pairDesktopLogin(store, join(root, "up-login.txt"), { name: "fixture", password: "retained-password" }); store.close();
    expect(readDesktopConfig(root).databaseInitialized).toBe(true);
    const saved = join(root, "retained.db"); renameSync(config.databaseFile, saved);
    expect(() => openConfiguredDesktopStore(root)).toThrow(/cannot be read/);
    expect(existsSync(config.databaseFile)).toBe(false);
    // An older installation has no setup marker. It must not assume missing
    // data means the user wanted to create a different queue.
    const legacy = readDesktopConfig(root); delete legacy.databaseInitialized; writeDesktopConfig(root, legacy);
    expect(() => openConfiguredDesktopStore(root)).toThrow(/cannot be read/);
    expect(existsSync(config.databaseFile)).toBe(false);
    renameSync(saved, config.databaseFile);
    const reopened = openConfiguredDesktopStore(root);
    expect(authenticateApprover(reopened, "fixture", "retained-password").ok).toBe(true); reopened.close();
    expect(readDesktopConfig(root).databaseInitialized).toBe(true);
    expect(readDesktopConfig(root).identity).toBe(config.identity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate-build database preflight never bootstraps missing desktop state", async () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-preflight-"));
  const capture = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const missing = join(root, "not-set-up");
    await expect(desktopMain(["database-status", "--state", missing])).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    const config = loadOrCreateDesktopConfig(root, true);
    const before = readFileSync(join(root, "desktop.json"));
    await desktopMain(["database-status", "--state", root]);
    expect(JSON.parse(String(capture.mock.calls.at(-1)?.[0])).ready).toBe(false);
    expect(existsSync(config.databaseFile)).toBe(false);
    expect(readFileSync(join(root, "desktop.json"))).toEqual(before);
  } finally { capture.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["missing", "older", "newer", "interrupted", "damaged"])("Stop and Status remain available with a %s database; Start refuses incompatible data", async kind => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-recovery-controls-"));
  const capture = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const config = loadOrCreateDesktopConfig(root, true);
    config.repos = [join(root, "disconnected-project")]; writeDesktopConfig(root, config);
    if (kind === "damaged") writeFileSync(config.databaseFile, "not a database; preserve me");
    else if (kind !== "missing") {
      const store = openDesktopStore(config.databaseFile); store.close();
      const db = new DatabaseSync(config.databaseFile);
      db.exec(`UPDATE schema_version SET version = ${kind === "older" ? SCHEMA_VERSION - 1 : kind === "newer" ? SCHEMA_VERSION + 1 : -(SCHEMA_VERSION - 1)}`); db.close();
    }
    const before = existsSync(config.databaseFile) ? readFileSync(config.databaseFile) : null;
    const configBefore = readFileSync(join(root, "desktop.json"));
    const calls: string[][] = [];
    const supervise = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { code: args[0] === "print" ? 113 : 0, stdout: args[0] === "print-disabled" ? '"com.standing-orders.test.recovery" => true' : "", stderr: "", timedOut: false, notFound: false };
    };
    const args = ["--state", root, "--node", process.execPath, "--helper", join(root, "missing-helper.js"), "--label", "com.standing-orders.test.recovery"];
    await desktopMain(["service-stop", ...args], supervise);
    expect(calls.map(args => args[0])).toEqual(["disable", "bootout", "print"]);
    expect(JSON.parse(String(capture.mock.calls.at(-1)?.[0])).ok).toBe(true);
    calls.length = 0;
    await desktopMain(["service-status", ...args], supervise);
    const status = JSON.parse(String(capture.mock.calls.at(-1)?.[0]));
    expect(status).toMatchObject({ ok: true, state: "disabled", database: { ready: false, expectedSchema: SCHEMA_VERSION } });
    expect(JSON.stringify(status)).not.toContain(config.identity);
    expect(calls.map(args => args[0])).toEqual(["print", "print-disabled"]);
    calls.length = 0;
    await expect(desktopMain(["service-start", ...args], supervise)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(existsSync(config.databaseFile) ? readFileSync(config.databaseFile) : null).toEqual(before);
    expect(readFileSync(join(root, "desktop.json"))).toEqual(configBefore);
  } finally { capture.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("database diagnostics are read-only, recognize a compatible database, and do not initialize an empty file", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-database-status-"));
  try {
    const file = join(root, "orders.db");
    expect(desktopDatabaseStatus(file).ready).toBe(false); expect(existsSync(file)).toBe(false);
    writeFileSync(file, ""); expect(desktopDatabaseStatus(file).ready).toBe(false); expect(statSync(file).size).toBe(0);
    const store = openStore(file); store.close();
    const before = readFileSync(file);
    expect(desktopDatabaseStatus(file)).toMatchObject({ ready: true, expectedSchema: SCHEMA_VERSION });
    expect(readFileSync(file)).toEqual(before);
    expect(desktopDatabaseStatus(root).ready).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a new desktop build at the same path has a new service definition, while reopening the same build is stable", () => {
  const args = { node: process.execPath, helper: "/fixture/desktop-host.js", label: "com.standing-orders.test.build", home: "/fixture", buildId: "build-a" };
  const first = desktopServiceDefinition("/fixture/state", args);
  expect(first.unitContent).toContain("STANDING_ORDERS_DESKTOP_BUILD");
  expect(desktopServiceDefinition("/fixture/state", args).unitContent).toBe(first.unitContent);
  expect(desktopServiceDefinition("/fixture/state", { ...args, buildId: "build-b" }).unitContent).not.toBe(first.unitContent);
});

test("repository aliases resolve together and missing checkouts retain the installation identity", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-config-"));
  try {
    const repo = join(root, "repo"); mkdirSync(repo);
    const alias = join(root, "alias"); symlinkSync(repo, alias);
    const missing = join(root, "moved-repo");
    const config = { version: 1 as const, databaseFile: join(root, "existing.db"), repos: [repo, alias, missing], port: 14187, identity: "a".repeat(64) };
    writeDesktopConfig(root, config);
    expect(readDesktopConfig(root)).toEqual({ ...config, repos: [realpathSync(repo), missing] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom state owns its database and refuses schema upgrades without modifying the file", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-isolated-"));
  try {
    const config = loadOrCreateDesktopConfig(root, true);
    expect(config.databaseFile).toBe(join(root, "orders.db"));
    const fresh = openDesktopStore(config.databaseFile); fresh.close();
    const db = new DatabaseSync(config.databaseFile);
    db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION - 1}`); db.close();
    const before = readFileSync(config.databaseFile);
    expect(() => openDesktopStore(config.databaseFile)).toThrow(/upgrade/);
    expect(readFileSync(config.databaseFile)).toEqual(before);
    expect(loadOrCreateDesktopConfig(root, true)).toEqual(config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing persists a private restart credential and preserves existing valid operator logins", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-pair-")); const store = openDesktopStore(join(root, "orders.db"));
  const file = join(root, "up-login.txt"); const login = { name: "alex", password: "fixture-password" };
  try {
    pairDesktopLogin(store, file, login);
    expect(authenticateApprover(store, login.name, login.password).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("alex fixture-password\n"); expect(statSync(file).mode & 0o777).toBe(0o600);
    pairDesktopLogin(store, file, login);
    expect(() => pairDesktopLogin(store, file, { ...login, password: "wrong-password" })).toThrow(/match/);
    const second = addApprover(store, "second", new Date(), { name: login.name, token: login.password }); if (!second.ok) throw Error("fixture");
    pairDesktopLogin(store, file, { name: "second", password: second.token });
    expect(readFileSync(file, "utf8")).toBe("alex fixture-password\n");
    writeFileSync(file, "alex obsolete-password\n");
    expect(() => pairDesktopLogin(store, file, login)).toThrow(/stale/);
    expect(readFileSync(file, "utf8")).toBe("alex obsolete-password\n");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop health proves a fresh challenge without exposing its identity or creating a login", async () => {
  const store = openStore(":memory:"); const identity = "a".repeat(64);
  const server = createDecisionServer({ store, desktopIdentity: identity });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(base + "/desktop/health")).status).toBe(400);
    for (const challenge of ["b".repeat(64), "c".repeat(64)]) {
      const response = await fetch(base + "/desktop/health?challenge=" + challenge);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await response.text(); expect(body).not.toContain(identity);
      expect(JSON.parse(body)).toEqual({ proof: createHmac("sha256", Buffer.from(identity, "hex")).update(challenge).digest("hex") });
    }
    expect((await fetch(base + "/control", { redirect: "manual" })).status).toBe(303);
    expect(store.listApprovers()).toHaveLength(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test("project enrollment validates the entire selection and resolves aliases before writing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-desktop-projects-"))); const config = loadOrCreateDesktopConfig(root, true);
  const store = openDesktopStore(config.databaseFile);
  try {
    const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    const sub = join(repo, "sub"); mkdirSync(sub); const alias = join(root, "alias"); symlinkSync(repo, alias);
    await expect(addDesktopProjects(root, store, [repo, join(root, "missing")])).rejects.toThrow(/unavailable/);
    expect(readDesktopConfig(root).repos).toEqual([]); expect(existsSync(join(root, "repos.json"))).toBe(false);
    expect((await addDesktopProjects(root, store, [sub, alias])).repos).toEqual([repo]);
    expect(resolveCeiling([repo, alias, join(root, "missing")], []).ceiling.repos).toEqual([repo, join(root, "missing")]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { authenticateApprover, addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { resolveCeiling } from "./project.js";
