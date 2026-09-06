import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { detectPreparation, modelChoices, previewProjectInstructions, addProjectInstructions } from "./setup-guide.js";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});

const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), "so-setup-guide-")));
test("preparation uses project lockfiles and never runs project code during detection", () => {
  const root = temporary();
  try {
    expect(detectPreparation(root)).toBeNull();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { preinstall: "touch should-not-exist" } }));
    writeFileSync(join(root, "package-lock.json"), "{}");
    expect(detectPreparation(root)?.command).toBe("npm ci");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
    expect(detectPreparation(root)?.command).toBe("pnpm install --frozen-lockfile");
    expect(existsSync(join(root, "should-not-exist"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model choices retain custom settings and read only visible models from the local Codex catalog", () => {
  const root = temporary();
  try {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "models_cache.json"), JSON.stringify({ models: [
      { slug: "model-a", display_name: "Model A", visibility: "list" },
      { slug: "model-b", visibility: "hide" }, { slug: "--bad", visibility: "list" },
    ] }));
    expect(modelChoices("codex", "custom-model", root)).toEqual([{ value: "custom-model", label: "custom-model — current choice" }, { value: "model-a", label: "Model A" }]);
    expect(modelChoices("claude", null, root)[0]?.value).toBe("sonnet");
    expect(modelChoices("claude", null, root)).toContainEqual({value:"claude-fable-5-1",label:expect.stringContaining("Fable 5.1")});
    writeFileSync(join(root,".codex","models_cache.json"),JSON.stringify({models:[{slug:"gpt-6-astra",visibility:"list",display_name:"GPT-6-Astra"}]}));
    expect(modelChoices("codex",null,root)).toContainEqual({value:"gpt-6-astra",label:expect.stringContaining("GPT-6 Astra")});
    writeFileSync(join(root,".codex","models_cache.json"),JSON.stringify({models:[{slug:"gpt-6-astra",visibility:"hide"}]}));
    expect(modelChoices("codex",null,root)).toEqual([]);
    rmSync(join(root,".codex","models_cache.json"));
    expect(modelChoices("codex",null,root)[0]?.label).toContain("requires account access");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project instruction reviews reject linked paths, foreign files, and stale reviews", () => {
  const root = temporary();
  try {
    const repo = join(root, "repo"); const outside = join(root, "outside"); mkdirSync(repo); mkdirSync(outside);
    expect(previewProjectInstructions(join(root, "unavailable")).ok).toBe(false);
    expect(existsSync(join(root, "unavailable"))).toBe(false);
    symlinkSync(outside, join(repo, ".claude"));
    expect(previewProjectInstructions(repo).ok).toBe(false);
    rmSync(join(repo, ".claude"));
    const preview = previewProjectInstructions(repo); if (!preview.ok) throw new Error(preview.message);
    mkdirSync(join(repo, ".claude", "skills", "standing-orders"), { recursive: true });
    writeFileSync(preview.plan.skillPath, "My custom instructions");
    expect(addProjectInstructions(repo, preview.fingerprint).ok).toBe(false);
    expect(readFileSync(preview.plan.skillPath, "utf8")).toBe("My custom instructions");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guided setup works entirely through forms: save defaults, add instructions, start a worker, and create a task", async () => {
  const root = temporary(); const repo = join(root, "project"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "package.json"), "{}"); writeFileSync(join(repo, "package-lock.json"), "{}");
  const store = openStore(join(root, "orders.db")); const now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw new Error("fixture");
  let running = false; const actions: string[] = [];
  const server = createDecisionServer({ store, repos: [repo], evidenceRoot: join(root, "evidence"), localControl: {
    host: "test-computer", status: () => [{ repo, runner: "worker", state: running ? "running" : "stopped", detail: "" }],
    change: (path, action) => { actions.push(`${action}:${path}`); running = action === "start"; return { ok: true, message: "Worker started." }; },
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
  const base = `http://127.0.0.1:${address.port}`; const window = new Window();
  const values = (html: string, selector: string) => {
    window.document.body.innerHTML = html;
    const form = window.document.querySelector(selector); if (!form) throw new Error(`Missing ${selector}`);
    return Object.fromEntries([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input[name], select[name], textarea[name]")].map(field => [field.name, field.value]));
  };
  try {
    const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).text();
    const post = (path: string, fields: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
    const inbox = await get("/"); expect(inbox).toContain("Set up my project"); expect(inbox).not.toContain("standing-orders config set");
    const page = await get("/control");
    expect(page).toContain('href="/control" class="active"');
    expect(await get("/menu")).toContain('href="/control"');
    expect(page).toContain("Install project dependencies with npm — detected");
    expect(page).toContain("Connect account");
    expect((await fetch(base + "/control/connection?provider=claude", { headers: { cookie } })).status).toBe(200);
    expect((await fetch(base + "/control?repo=%2Foutside", { headers: { cookie } })).status).toBe(404);
    const setup = values(page, 'form[action="/control/setup-preview"]');
    expect(setup.model).toBe("sonnet"); expect(setup.preparation).toBe("auto");
    const preview = await post("/control/setup-preview", setup); expect(preview.status).toBe(200);
    const review = await preview.text(); expect(review).toContain("npm ci");
    expect(store.phaseConfig(repo, "build")).toBeNull(); expect(store.liveWorktreeSetup(repo)).toBeNull();
    const confirm = values(review, 'form[action="/control/setup-approve"]');
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(303);
    expect(store.liveWorktreeSetup(repo)?.command).toBe("npm ci");
    expect(store.phaseConfig(repo, "build")?.model).toBe("sonnet");
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(409);
    const instructionFields = values(await get("/control"), 'form[action="/control/instructions-preview"]');
    const instructionPreview = await post("/control/instructions-preview", instructionFields);
    expect(instructionPreview.status).toBe(200);
    const instructionConfirm = values(await instructionPreview.text(), 'form[action="/control/instructions-approve"]');
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect((await post("/control/instructions-approve", { ...instructionConfirm, csrf: "wrong", token: added.token })).status).toBe(403);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect((await post("/control/instructions-approve", { ...instructionConfirm, token: added.token })).status).toBe(200);
    expect(previewProjectInstructions(repo)).toMatchObject({ ok: true, installed: true });
    expect(actions).toEqual([`start:${repo}`]);
    const newTask = values(await get("/tasks/new"), 'form[action="/tasks/add"]');
    delete newTask.scout;
    const created = await post("/tasks/add", { ...newTask, request: "Make setup easier to follow" });
    expect(created.status).toBe(303); expect(created.headers.get("location")).toMatch(/^\/t\//);
    expect(store.listTasks()).toHaveLength(1);
    const taskScope = store.getScope(store.listTasks()[0]!.id)!;
    expect(taskScope.approvedAt).toBeNull();
    expect(taskScope.profile?.model).toBe("sonnet");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
