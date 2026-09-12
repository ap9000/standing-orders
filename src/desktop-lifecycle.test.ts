import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { updateRepos, addRepos } from "./repos.js";
import { loadOrCreateDesktopConfig, writeDesktopConfig, openDesktopStore, pairDesktopLogin, addDesktopProjects } from "./desktop-host.js";

test("the built desktop helper starts the existing controller, enrolls only selected projects, and stops cleanly", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-desktop-lifecycle-")));
  const config = loadOrCreateDesktopConfig(root, true);
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
  config.port = (reservation.address() as { port: number }).port;
  await new Promise<void>(done => reservation.close(() => done())); writeDesktopConfig(root, config);
  const store = openDesktopStore(config.databaseFile);
  const login = { name: "desktop-fixture", password: "desktop-fixture-password" };
  const createRepo = (name: string) => {
    const repo = join(root, name); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Desktop fixture\n"); execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    return repo;
  };
  pairDesktopLogin(store, join(root, "up-login.txt"), login);
  const repo = createRepo("selected"); await addDesktopProjects(root, store, [repo]); store.close();
  // cwd is this source checkout: it must not be implicitly added by `up`.
  const child = spawn(process.execPath, [resolve("dist/desktop-host.js"), "serve", "--state", root], { cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-500_000); });
  const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
  const base = `http://127.0.0.1:${config.port}`;
  const poll = async (fn: () => Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error("Desktop exited: " + output);
      try { if (await fn()) return; } catch {}
      await new Promise(done => setTimeout(done, 100));
    }
    throw Error("Desktop did not become ready: " + output);
  };
  try {
    await poll(async () => (await fetch(base + "/desktop/health?challenge=" + "b".repeat(64))).status === 200);
    const response = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: login.name, token: login.password }), redirect: "manual" });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await fetch(base + "/projects", { headers: { cookie } })).text();
    expect(page).toContain(repo); expect(page).not.toContain(process.cwd());
    const unselected = createRepo("unselected");
    await updateRepos(join(root, "repos.json"), existing => addRepos(existing, [unselected]));
    const second = createRepo("added-later"); const running = openDesktopStore(config.databaseFile);
    try { await addDesktopProjects(root, running, [second]); } finally { running.close(); }
    await poll(async () => (await (await fetch(base + "/projects", { headers: { cookie } })).text()).includes(second));
    expect(await (await fetch(base + "/projects", { headers: { cookie } })).text()).not.toContain(unselected);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(output).toContain("stopped cleanly"); expect(output).not.toContain(login.password);
    const after = openDesktopStore(config.databaseFile);
    try { expect(after.listTasks()).toHaveLength(0); expect(after.listRunners()).toHaveLength(1); expect(after.listRunners()[0]?.retiredAt).toEqual(expect.any(String)); }
    finally { after.close(); }
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
