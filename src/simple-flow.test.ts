import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});

async function fixture(options: { local?: boolean; multipleProjects?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-simple-flow-")));
  const repo = join(root, "website"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "package.json"), "{}"); writeFileSync(join(repo, "package-lock.json"), "{}");
  const store = openStore(":memory:"); const account = addApprover(store, "alex", new Date());
  if (!account.ok) throw new Error("fixture account");
  const secondRepo = join(root, "another-project");
  if (options.multipleProjects) { mkdirSync(secondRepo); execFileSync("git", ["init", "-q", secondRepo]); }
  let running = false; let failStart = false; const actions: string[] = [];
  const repos = options.multipleProjects ? [repo, secondRepo] : [repo];
  const server = createDecisionServer({ store, repos, evidenceRoot: join(root, "evidence"), ...(options.local === false ? {} : { localControl: {
    host: "This Mac", status: () => [{ repo, runner: "fixture", state: running ? "running" : "stopped", detail: "" }],
    change: (_repo, action) => { actions.push(action); if (action === "start" && failStart) return { ok: false, message: "Try starting it again." }; running = action === "start"; return { ok: true, message: "Session updated." }; },
  } }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: account.token }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const window = new Window();
  const parse = (html: string) => { window.document.body.innerHTML = html; return window.document; };
  const fields = (html: string, action: string, container = "") => {
    const form = parse(html).querySelector(`${container} form[action="${action}"]`); if (!form) throw new Error(`Missing ${action}`);
    return Object.fromEntries([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input[name], select[name], textarea[name]")]
      .filter(field => !field.disabled && (field.type !== "checkbox" || (field as HTMLInputElement).checked))
      .map(field => [field.name, field.value]));
  };
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).text();
  const post = (path: string, data: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(data), redirect: "manual" });
  const saveSetup = async (page: string) => {
    const preview = await post("/control/setup-preview", fields(page, "/control/setup-preview")); expect(preview.status).toBe(200);
    return post("/control/setup-approve", { ...fields(await preview.text(), "/control/setup-approve"), token: account.token });
  };
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, repo, secondRepo, actions, get, post, parse, fields, saveSetup, token: account.token, setStartFailure: (value: boolean) => { failStart = value; }, close };
}

test("first setup starts the session and opens one description leading to exact review", async () => {
  const f = await fixture();
  try {
    const overview = f.parse(await f.get("/workbench"));
    const card = overview.querySelector(".workspace-card")!;
    expect(card.querySelector(".primary")?.textContent).toBe("Set up session");
    expect(card.querySelectorAll(".setup-actions a, .setup-actions button")).toHaveLength(1);
    expect(card.querySelector(".project-count-summary")).toBeNull();
    expect(card.querySelector(".project-details")?.hasAttribute("open")).toBe(false);
    const setup = await f.get(card.querySelector("a.primary")!.getAttribute("href")!);
    expect(f.parse(setup).querySelector(".setup-advanced")?.hasAttribute("open")).toBe(false);
    expect(f.parse(setup).querySelector('form[action="/control/worker"]')).toBeNull();
    expect(f.actions).toEqual([]); // Reading setup never starts a session.
    const saved = await f.saveSetup(setup); expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/tasks/new");
    expect(f.actions).toEqual(["start"]); expect(f.store.listTasks()).toHaveLength(0);
    const composer = await f.get("/tasks/new");
    expect(f.parse(composer).querySelectorAll(".task-composer textarea[required]")).toHaveLength(1);
    expect(f.parse(composer).querySelector(".composer-options")?.hasAttribute("open")).toBe(false);
    const request = "Add a contact form\nInclude name, email and message.\nShow a confirmation after submission.";
    const made = await f.post("/tasks/add", { ...f.fields(composer, "/tasks/add"), request: request.replace(/\n/g, "\r\n") }); expect(made.status).toBe(303);
    const path = made.headers.get("location")!; const id = decodeURIComponent(path.slice(3));
    expect(f.store.getTask(id)?.title).toBe("Add a contact form");
    expect(f.store.getScope(id)).toMatchObject({ goal: request, approvedAt: null, profile: { provider: "claude", model: "sonnet" } });
    const review = await f.get(path); expect(f.parse(review).querySelector(".task-review")).not.toBeNull();
    expect(f.parse(review).querySelector(".task-layout")).toBeNull();
    const approval = f.fields(review, path + "/approve");
    expect(approval.nonce).toMatch(/^[a-f0-9]{32}$/); expect(approval.digest).toBe(f.store.getScope(id)?.digest);
    expect((await f.post(path + "/approve", { ...approval, csrf: "forged", token: f.token })).status).toBe(403);
    const edit = f.fields(review, path + "/scope");
    const updated = request + "\nKeep the existing navigation.";
    expect((await f.post(path + "/scope", { ...edit, goal: updated.replace(/\n/g, "\r\n") })).status).toBe(303);
    expect((await f.post(path + "/approve", { ...approval, token: f.token })).status).toBe(409);
    expect(f.store.getScope(id)?.approvedAt).toBeNull();
    const fresh = f.fields(await f.get(path), path + "/approve");
    expect((await f.post(path + "/approve", { ...fresh, token: f.token })).status).toBe(303);
    expect(f.store.getScope(id)).toMatchObject({ goal: updated, approvedDigest: fresh.digest });
    expect(f.store.liveRuns(new Date())).toHaveLength(0);
  } finally { await f.close(); }
});

test("an approved task follows its live attempt and completion without another setup step", async () => {
  const f = await fixture();
  try {
    f.store.setApprovalPasswordRequired("alex", false, new Date());
    const saved = await f.saveSetup(await f.get("/control"));
    expect(saved.status).toBe(303);
    const made = await f.post("/tasks/add", { ...f.fields(await f.get("/tasks/new"), "/tasks/add"), request: "Build a project chat" });
    const path = made.headers.get("location")!;
    const id = decodeURIComponent(path.slice(3));
    const review = await f.get(path);
    expect(f.parse(review).querySelector('input[type="password"]')).toBeNull();
    expect((await f.post(path + "/approve", f.fields(review, path + "/approve"))).status).toBe(303);
    const queued = await f.get(path);
    expect(queued).toContain("?fragment=task-status");
    const before = await f.get(path + "?fragment=task-status");
    register(f.store, { name: "fixture", host: "here", repos: [f.repo], now: new Date(), newToken: () => "fixture-token" });
    const ref = f.store.lookupRef(id)!;
    const claim = acquire(f.store, ref.id, "fixture", { token: "fixture-token", now: new Date(), ttlMs: 3_600_000 });
    if (!claim.ok) throw new Error("fixture claim");
    const run = f.store.startRun({ taskRef: ref.id, leaseId: claim.claim.leaseId, runner: "fixture", branch: "standing-orders/chat", worktree: join(f.repo, "test-worktree"), now: new Date() });
    expect(await f.get(path + "?fragment=task-status")).not.toBe(before);
    const active = await f.get(path);
    expect(f.parse(active).querySelector("h1 .badge")?.textContent).toBe("Running");
    expect(active).not.toContain("Ready for your assistant");
    f.store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
    f.store.setTaskState(id, "done", new Date());
    const completed = await f.get(path);
    expect(f.parse(completed).querySelector("h1 .badge")?.textContent).toBe("Built locally");
    expect(completed).toContain("Review changes");
    expect(f.actions).toEqual(["start"]);
  } finally { await f.close(); }
});

test("a description saved before setup returns to the same task and preserves its boundaries when session settings are applied", async () => {
  const f = await fixture();
  try {
    const request = "Improve the docs\nKeep the examples accurate.";
    const made = await f.post("/tasks/add", { ...f.fields(await f.get("/tasks/new"), "/tasks/add"), request, not: "Public API", touches: "README.md, docs/" });
    expect(made.status).toBe(303); const path = made.headers.get("location")!; const id = decodeURIComponent(path.slice(3));
    expect(f.store.getScope(id)?.profileState).toBe("unresolved");
    const edit = f.fields(await f.get(path), path + "/scope");
    expect((await f.post(path + "/scope", { ...edit, "budget-usd": "3" })).status).toBe(303);
    const before = f.store.getScope(id)!;
    const setupLink = f.parse(await f.get(path)).querySelector(".task-setup-needed a.primary")!.getAttribute("href")!;
    const setup = await f.get(setupLink);
    const providerLink = f.parse(setup).querySelector('.assistant-picker a[aria-current="page"]')!.getAttribute("href")!;
    expect(new URL(providerLink, "http://test").searchParams.get("task")).toBe(id);
    const saved = await f.saveSetup(await f.get(providerLink)); expect(saved.status).toBe(303); expect(saved.headers.get("location")).toBe(path);
    expect(f.store.getScope(id)?.digest).toBe(before.digest);
    expect(f.actions).toEqual(["start"]);
    const review = await f.get(path);
    const adopt = f.fields(review, path + "/scope");
    expect((await f.post(path + "/scope", adopt)).status).toBe(303);
    expect(f.store.getScope(id)).toMatchObject({ goal: before.goal, outOfScope: before.outOfScope, touches: before.touches, budgetMicrousd: before.budgetMicrousd, approvedAt: null, profileState: "resolved", profile: { model: "sonnet" } });
    expect(f.store.getScope(id)?.digest).not.toBe(before.digest);
    expect(f.parse(await f.get(path)).querySelector('button.primary')?.textContent).toBe("Approve task");
  } finally { await f.close(); }
});

test("invalid and stale task submissions preserve the description and options without filing work", async () => {
  const f = await fixture();
  try {
    const form = f.fields(await f.get("/tasks/new"), "/tasks/add");
    const draft = { ...form, request: "A detailed request <keep this text>", title: "x".repeat(201), not: "Auth & billing", touches: "src/", scout: "1" };
    const invalid = await f.post("/tasks/add", draft); expect(invalid.status).toBe(400);
    const recovered = f.fields(await invalid.text(), "/tasks/add");
    expect(recovered).toMatchObject(draft); expect(f.store.listTasks()).toHaveLength(0);
    const stale = await f.post("/tasks/add", { ...draft, title: "", projectRevision: "999" }); expect(stale.status).toBe(409);
    const kept = f.fields(await stale.text(), "/tasks/add");
    expect(kept.request).toBe(draft.request); expect(kept.repo).toBe(f.repo); expect(kept.projectRevision).toBe(form.projectRevision);
    expect(f.store.listTasks()).toHaveLength(0);
    const made = await f.post("/tasks/add", kept); expect(made.status).toBe(303);
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.store.getScope(f.store.listTasks()[0]!.id)?.approvedAt).toBeNull();
  } finally { await f.close(); }
});

test("setup enters the chosen project and invalidates an older composer without starting twice", async () => {
  const f = await fixture({ multipleProjects: true });
  try {
    const oldComposer = f.fields(await f.get("/tasks/new"), "/tasks/add");
    await f.post("/projects/select", { csrf: oldComposer.csrf!, path: f.secondRepo });
    const setup = f.fields(await f.get(`/control?repo=${encodeURIComponent(f.repo)}`), "/control/setup-preview");
    const preview = await f.post("/control/setup-preview", setup);
    const confirm = { ...f.fields(await preview.text(), "/control/setup-approve"), token: f.token };
    expect((await f.post("/control/setup-approve", confirm)).headers.get("location")).toBe("/tasks/new");
    expect(f.fields(await f.get("/tasks/new"), "/tasks/add").repo).toBe(f.repo);
    expect(f.store.listProjects().some(project => project.path === f.repo)).toBe(true);
    expect((await f.post("/control/setup-approve", confirm)).status).toBe(409);
    expect(f.actions).toEqual(["start"]);
    const stale = await f.post("/tasks/add", { ...oldComposer, request: "Keep this draft" });
    expect(stale.status).toBe(409);
    expect(f.fields(await stale.text(), "/tasks/add").request).toBe("Keep this draft");
    expect(f.store.listTasks()).toHaveLength(0);
  } finally { await f.close(); }
});

test("settings-only reviews cannot be changed into a session start and editing settings leaves a paused session paused", async () => {
  const f = await fixture();
  try {
    const setup = f.fields(await f.get("/control"), "/control/setup-preview");
    const preview = await f.post("/control/setup-preview", { ...setup, "after-setup": "settings" });
    const html = await preview.text(); expect(html).toContain("Save settings");
    const confirm = { ...f.fields(html, "/control/setup-approve"), token: f.token };
    expect((await f.post("/control/setup-approve", { ...confirm, "after-setup": "session" })).status).toBe(409);
    expect(f.actions).toEqual([]); expect(f.store.phaseConfig(f.repo, "build")).toBeNull();
    const saveOnly = await f.post("/control/setup-preview", { ...setup, "after-setup": "settings" });
    expect((await f.post("/control/setup-approve", { ...f.fields(await saveOnly.text(), "/control/setup-approve"), token: f.token })).status).toBe(200);
    const settings = await f.get("/control");
    expect(f.fields(settings, "/control/setup-preview")["after-setup"]).toBe("settings");
    expect((await f.saveSetup(settings)).status).toBe(200);
    expect(f.actions).toEqual([]);
    expect((await f.post("/control/worker", f.fields(settings, "/control/worker"))).headers.get("location")).toBe("/tasks/new");
    expect(f.actions).toEqual(["start"]);
  } finally { await f.close(); }
});

test("a failed start keeps saved settings and the exact task return for a direct retry", async () => {
  const f = await fixture();
  try {
    const made = await f.post("/tasks/add", { ...f.fields(await f.get("/tasks/new"), "/tasks/add"), request: "A task to resume after setup" });
    const path = made.headers.get("location")!; const id = decodeURIComponent(path.slice(3));
    const goal = f.store.getScope(id)!.goal;
    const setupLink = f.parse(await f.get(path)).querySelector(".task-setup-needed a.primary")!.getAttribute("href")!;
    f.setStartFailure(true);
    const saved = await f.saveSetup(await f.get(setupLink)); expect(saved.status).toBe(409);
    const retryPage = await saved.text(); expect(retryPage).toContain("Settings saved, but your session could not start.");
    expect(retryPage).not.toContain("Your session is ready");
    expect(f.store.phaseConfig(f.repo, "build")?.model).toBe("sonnet");
    f.setStartFailure(false);
    const retry = await f.post("/control/worker", f.fields(retryPage, "/control/worker"));
    expect(retry.headers.get("location")).toBe(path);
    expect(f.actions).toEqual(["start", "start"]);
    expect(f.store.getScope(id)).toMatchObject({ goal, approvedAt: null });
    expect(f.store.liveRuns(new Date())).toHaveLength(0);
  } finally { await f.close(); }
});

test.each(["local", "remote", "web-only"] as const)("setup continues to the task with an existing %s connection without launching another worker", async kind => {
  const f = await fixture({ local: kind !== "web-only" });
  try {
    if (kind === "local") {
      const setup = f.fields(await f.get("/control"), "/control/setup-preview");
      await f.post("/control/worker", { csrf: setup.csrf!, repo: f.repo, action: "start" });
    } else if (kind === "remote") register(f.store, { name: "remote", host: "Other computer", repos: [f.repo], now: new Date(), newToken: () => "remote-token" });
    const priorActions = [...f.actions];
    const preview = await f.post("/control/setup-preview", f.fields(await f.get("/control"), "/control/setup-preview"));
    const html = await preview.text(); expect(html).toContain("Continue to task →");
    const saved = await f.post("/control/setup-approve", { ...f.fields(html, "/control/setup-approve"), token: f.token });
    expect(saved.headers.get("location")).toBe("/tasks/new");
    expect(f.actions).toEqual(priorActions); expect(f.store.listTasks()).toHaveLength(0);
  } finally { await f.close(); }
});
