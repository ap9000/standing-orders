import { test, expect } from "vitest";
import { mkdtempSync, rmSync, realpathSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDesktopConfig, writeDesktopConfig, loadOrCreateDesktopConfig, openDesktopStore, pairDesktopLogin, addDesktopProjects } from "./desktop-host.js";

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
