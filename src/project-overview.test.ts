import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});
import { addDesktopProjects, readDesktopConfig, writeDesktopConfig } from "./desktop-host.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";

const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), "so-projects-")));
const git = (root: string, name: string) => { const repo = join(root, name); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); return repo; };

test("project counts use live attempts, including queued records, and exclude expired or finished attempts", () => {
  const store = openStore(":memory:"); const now = new Date("2026-09-06T00:00:00Z");
  try {
    register(store, { name: "worker", host: "here", capacity: 3, repos: ["/alpha", "/beta"], now, newToken: () => "worker-token" });
    const runs: number[] = [];
    for (const [id, repo] of [["active", "/alpha"], ["waiting", "/alpha"], ["other", "/beta"]]) {
      store.createTask({ id: id!, title: id! }, now);
      const ref = store.refFor("built-in", id!).id; store.placeTask(ref, repo!);
      if (id === "waiting") continue;
      const held = acquire(store, ref, "worker", { token: "worker-token", now, ttlMs: 60_000 });
      if (!held.ok) throw new Error("fixture claim");
      runs.push(store.startRun({ taskRef: ref, leaseId: held.claim.leaseId, runner: "worker", branch: id!, worktree: "/pool/" + id, now }));
    }
    expect(store.projectPeek("/alpha", now)).toMatchObject({ running: 1, queued: 1 });
    expect(store.projectPeek("/beta", now)).toMatchObject({ running: 1, queued: 0 });
    expect(store.projectPeek("/alpha", new Date(now.getTime() + 60_001))).toMatchObject({ running: 0, queued: 2 });
    store.finishRun(runs[0]!, { outcome: "built", committed: true, now });
    store.setTaskState("active", "done", now);
    expect(store.projectPeek("/alpha", now)).toMatchObject({ running: 0, queued: 1, doneRecently: 1 });
  } finally { store.close(); }
});

test("native batch enrollment is all-or-nothing on invalid selections and merges concurrent additions", async () => {
  const root = temporary(); const a = git(root, "a"), b = git(root, "b"), c = git(root, "c");
  const alias = join(root, "alias"); symlinkSync(b, alias);
  const store = openStore(join(root, "orders.db"));
  writeDesktopConfig(root, { version: 1, databaseFile: join(root, "orders.db"), repos: [a], port: 14187, identity: "a".repeat(64) });
  try {
    await expect(addDesktopProjects(root, store, [b, join(root, "missing")])).rejects.toThrow();
    expect(readDesktopConfig(root).repos).toEqual([a]);
    await Promise.all([addDesktopProjects(root, store, [b, alias]), addDesktopProjects(root, store, [c])]);
    expect(readDesktopConfig(root).repos.sort()).toEqual([a, b, c].sort());
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("shared project journey: multi-select, review, persist without losing sessions, run workers independently, and file into an explicit project", async () => {
  const root = temporary(); const a = git(root, "alpha"), b = git(root, "beta"), c = git(root, "empty-project");
  const outsideRoot = temporary(); const outside = git(outsideRoot, "private-project");
  const alias = join(root, "linked-outside"); symlinkSync(outside, alias);
  const store = openStore(join(root, "orders.db")); const now = new Date();
  const op = addApprover(store, "alex", now); if (!op.ok) throw new Error("fixture");
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", now);
  store.createTask({ id: "hidden", title: "Hidden outside task" }, now); store.placeTask(store.refFor("built-in", "hidden").id, outside);
  let repos = [a]; let additions = 0; const running = new Set<string>(); const changes: string[] = [];
  const server = createDecisionServer({ store, repos, evidenceRoot: join(root, "evidence"), projectManager: {
    browseRoots: [root], repos: () => repos, add: async paths => { additions++; repos = [...new Set([...repos, ...paths])]; },
  }, localControl: {
    host: "test-computer", status: () => repos.map(repo => ({ repo, runner: repo, state: running.has(repo) ? "running" : "stopped", detail: "" })),
    change: (repo, action) => { changes.push(`${repo}:${action}`); if (action === "start") running.add(repo); else running.delete(repo); return { ok: true, message: "Updated." }; },
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
  const base = `http://127.0.0.1:${address.port}`; const window = new Window();
  const parse = (html: string) => { window.document.body.innerHTML = html; return window.document; };
  const formData = (html: string, selector: string): URLSearchParams => {
    const form = parse(html).querySelector(selector); if (!form) throw new Error(`Missing ${selector}`);
    return new URLSearchParams([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name], select[name]")]
      .filter(field => field.type !== "checkbox" || (field as HTMLInputElement).checked).map(field => [field.name, field.value]));
  };
  try {
    const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: op.token }), redirect: "manual" });
    expect(login.headers.get("location")).toBe("/workbench");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (path: string) => (await fetch(base + path, { headers: { cookie }, redirect: "manual" })).text();
    const post = (path: string, body: URLSearchParams) => fetch(base + path, { method: "POST", body, headers: { cookie, origin: base }, redirect: "manual" });
    const overviewBefore = parse(await get("/workbench"));
    const switchers = [...overviewBefore.querySelectorAll(".switcher-menu")];
    expect(switchers).toHaveLength(2); // Desktop and phone share the same actions.
    for (const menu of switchers) {
      expect(menu.querySelector('.add-projects')?.getAttribute("href")).toBe("/projects/browse");
      expect(menu.querySelector('.manage')?.getAttribute("href")).toBe("/projects");
      expect(menu.querySelector('.switcher-projects')?.textContent).toContain("alpha");
    }
    expect(overviewBefore.querySelector('.control-room-head')?.textContent).not.toContain("Add projects");
    const pickerHref = switchers[0]!.querySelector('.add-projects')!.getAttribute("href")!;
    const picker = await get(pickerHref);
    const doc = parse(picker); expect(doc.querySelectorAll('input[type="checkbox"][name="paths"]')).toHaveLength(3);
    expect(doc.querySelector('input[value="' + alias + '"]')).toBeNull();
    const selection = formData(picker, "#project-selection"); selection.append("paths", b); selection.append("paths", c);
    const bad = new URLSearchParams(selection); bad.set("csrf", "wrong");
    expect((await post("/projects/add-preview", bad)).status).toBe(403); expect(additions).toBe(0);
    const invalid = new URLSearchParams(selection); invalid.append("paths", outside);
    expect((await post("/projects/add-preview", invalid)).status).toBe(400); expect(repos).toEqual([a]);
    const reviewed = await post("/projects/add-preview", selection); expect(reviewed.status).toBe(200);
    const confirm = formData(await reviewed.text(), 'form[action="/projects/add-confirm"]');
    expect(additions).toBe(0); expect(store.listProjects()).toHaveLength(0);
    confirm.set("token", op.token);
    const saved = await post("/projects/add-confirm", confirm); expect(saved.status).toBe(303); expect(saved.headers.get("location")).toBe("/workbench");
    expect(additions).toBe(1); expect(store.listProjects()).toHaveLength(2);
    expect((await post("/projects/add-confirm", confirm)).status).toBe(409);
    const overview = await get("/workbench"); expect(overview).toContain("empty-project"); expect(overview).not.toContain("Hidden outside task"); expect(overview).not.toContain(outside);
    const enrolled = parse(overview).querySelector('.switcher-projects')!;
    expect([...enrolled.querySelectorAll('input[name="path"]')].map(input => input.getAttribute("value"))).toEqual(expect.arrayContaining([a, b, c]));
    const worker = formData(overview, '.workspace-card form[action="/control/worker"]'); worker.set("repo", a);
    expect((await post("/control/worker", worker)).headers.get("location")).toBe("/tasks/new");
    expect(formData(await get("/tasks/new"), 'form[action="/tasks/add"]').get("repo")).toBe(a); worker.set("repo", b);
    expect((await post("/control/worker", worker)).status).toBe(303); expect(running).toEqual(new Set([a, b]));
    expect(formData(await get("/tasks/new"), 'form[action="/tasks/add"]').get("repo")).toBe(b);
    worker.set("repo", a); worker.set("action", "stop"); expect((await post("/control/worker", worker)).headers.get("location")).toBe("/workbench"); expect(running).toEqual(new Set([b]));
    // The original cookie still works, and selecting a card changes only the view.
    const open = formData(await get("/workbench"), '.workspace-card form[action="/projects/select"]'); open.set("path", b);
    expect((await post("/projects/select", open)).status).toBe(303); expect(running).toEqual(new Set([b]));
    const taskPage = await get("/tasks/new");
    expect(parse(taskPage).querySelectorAll('select[name="repo"] option')).toHaveLength(3);
    const task = formData(taskPage, 'form[action="/tasks/add"]'); task.set("repo", c); task.set("title", "A feature in the third project"); task.set("request", "A clear outcome");
    expect((await post("/tasks/add", task)).status).toBe(303);
    const created = store.listTasks().find(one => one.title === "A feature in the third project")!;
    expect(store.lookupRef(created.id)?.repo).toBe(c); expect(store.getScope(created.id)?.approvedAt).toBeNull();
    const refreshed = await get("/workbench?fragment=projects"); expect(refreshed).toContain("A feature in the third project"); expect(refreshed).toContain("Needs you"); expect(refreshed).not.toContain("<html");
    expect(changes).toHaveLength(3);
    // Ordinary root-scoped web connections can use the same multi-select UI without desktop enrollment authority.
    const scoped = createDecisionServer({ store, projectRoots: [root], evidenceRoot: join(root, "evidence") });
    await new Promise<void>(resolve => scoped.listen(0, "127.0.0.1", resolve));
    try {
      const port = (scoped.address() as { port: number }).port;
      const signed = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: op.token }), redirect: "manual" });
      const page = await fetch(`http://127.0.0.1:${port}/projects/browse`, { headers: { cookie: signed.headers.get("set-cookie")!.split(";")[0]! } });
      expect(await page.text()).toContain("Review selected projects");
    } finally { await new Promise<void>(resolve => scoped.close(() => resolve())); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(outsideRoot, { recursive: true, force: true }); }
});

test("a project without a chosen model offers setup instead of claiming it is ready to run", async () => {
  const root = temporary(); const repo = git(root, "new-project"); const store = openStore(":memory:");
  const op = addApprover(store, "alex", new Date()); if (!op.ok) throw new Error("fixture");
  const server = createDecisionServer({ store, repos: [repo], evidenceRoot: root, localControl: {
    host: "test-computer", status: () => [{ repo, runner: "local", state: "stopped", detail: "" }],
    change: () => { throw new Error("Must not start while rendering"); },
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/workbench?fragment=projects`, { headers: { authorization: `Bearer alex:${op.token}` } });
    const html = await response.text(); expect(response.status).toBe(200);
    expect(html).toContain("Setup needed"); expect(html).toContain("Set up session");
    expect(html).not.toContain("Ready for a task"); expect(html).not.toContain('action="/control/worker"');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
