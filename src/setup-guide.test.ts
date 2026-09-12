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
    writeFileSync(join(root,".codex","models_cache.json"),JSON.stringify({models:[{slug:"gpt-6-astra",visibility:"list",display_name:"GPT-6-Astra"}]}));
    expect(modelChoices("codex",null,root)).toContainEqual({value:"gpt-6-astra",label:"GPT-6-Astra"});
    writeFileSync(join(root,".codex","models_cache.json"),JSON.stringify({models:[{slug:"gpt-6-astra",visibility:"hide"}]}));
    expect(modelChoices("codex",null,root)).toEqual([]);
    rmSync(join(root,".codex","models_cache.json"));
    expect(modelChoices("codex",null,root)).toEqual([]);
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


test("guided setup requires a current project, CSRF, password, and unused preview; instructions preserve foreign edits", async () => {
  const root = temporary(); const repo = join(root, "project"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "package.json"), "{}"); writeFileSync(join(repo, "package-lock.json"), "{}");
  const store = openStore(join(root, "orders.db"));
  const added = addApprover(store, "alex", new Date()); if (!added.ok) throw new Error("fixture");
  const server = createDecisionServer({ store, repo, repos: [repo], connectionHome: root, evidenceRoot: root });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const window = new Window();
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
    const setup = values(await get("/control"), 'form[action="/control/setup-preview"]');
    expect(setup.model).toBe("sonnet"); expect(setup.command).toBe("npm ci");
    expect((await post("/control/setup-preview", { ...setup, repo: "/outside" })).status).toBe(409);
    expect((await post("/control/setup-preview", { ...setup, csrf: "wrong" })).status).toBe(403);
    const review = async () => {
      const preview = await post("/control/setup-preview", setup); expect(preview.status).toBe(200);
      return values(await preview.text(), 'form[action="/control/setup-approve"]');
    };
    let confirm = await review();
    expect(store.phaseConfig(repo, "build")).toBeNull(); expect(store.liveWorktreeSetup(repo)).toBeNull();
    expect((await post("/control/setup-approve", { ...confirm, token: "wrong-password" })).status).toBe(409);
    expect(store.phaseConfig(repo, "build")).toBeNull(); expect(store.liveWorktreeSetup(repo)).toBeNull();
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(409);
    confirm = await review();
    store.setPhaseConfig(repo, "build", "claude", "opus", "alex", new Date());
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(409);
    expect(store.phaseConfig(repo, "build")?.model).toBe("opus"); expect(store.liveWorktreeSetup(repo)).toBeNull();
    confirm = await review();
    expect((await post("/control/setup-approve", { ...confirm, model: "opus", token: added.token })).status).toBe(409);
    // Tampering consumes the displayed preview; a new review is needed.
    confirm = await review();
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(303);
    expect(store.liveWorktreeSetup(repo)?.command).toBe("npm ci"); expect(store.phaseConfig(repo, "build")?.model).toBe("sonnet");
    expect((await post("/control/setup-approve", { ...confirm, token: added.token })).status).toBe(409);
    store.clearWorktreeSetup(repo, "alex", new Date());
    expect(values(await get("/control"), 'form[action="/control/setup-preview"]').command).toBe("");
    const instructionFields = values(await get("/control"), 'form[action="/control/instructions-preview"]');
    const instructionPreview = await post("/control/instructions-preview", instructionFields); expect(instructionPreview.status).toBe(200);
    const instructionConfirm = values(await instructionPreview.text(), 'form[action="/control/instructions-approve"]');
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect((await post("/control/instructions-approve", { ...instructionConfirm, csrf: "wrong", token: added.token })).status).toBe(403);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect((await post("/control/instructions-approve", { ...instructionConfirm, token: added.token })).status).toBe(303);
    const installed = previewProjectInstructions(repo); expect(installed).toMatchObject({ ok: true, installed: true });
    expect((await post("/control/instructions-approve", { ...instructionConfirm, token: added.token })).status).toBe(409);
    if (!installed.ok) throw Error("fixture");
    writeFileSync(installed.plan.skillPath, "Custom instructions");
    expect((await post("/control/instructions-preview", instructionFields)).status).toBe(400);
    expect(readFileSync(installed.plan.skillPath, "utf8")).toBe("Custom instructions");
    expect(store.listTasks()).toHaveLength(0);
    const newTask = values(await get("/tasks/new"), 'form[action="/tasks/add"]'); delete newTask.scout; delete newTask["plan-first"];
    const created = await post("/tasks/add", { ...newTask, title: "Make setup easier to follow", goal: "Explain setup", acceptance: "Setup is explained | check" });
    expect(created.status).toBe(303); expect(store.listTasks()).toHaveLength(1);
    expect(store.getScope(store.listTasks()[0]!.id)?.approvedAt).toBeNull();
    expect(store.phaseConfig(repo, "build")?.model).toBe("sonnet");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("changing project defaults does not rewrite an already signed scope", () => {
  const store = openStore(":memory:");
  try {
    const added = addApprover(store, "alex", new Date()); if (!added.ok) throw Error("fixture");
    store.createTask({ id: "existing", title: "Previously signed work" }, new Date());
    store.saveScope({ taskId: "existing", goal: "Keep the signed goal", outOfScope: null, touches: ["src"], acceptance: [], proposedAt: new Date().toISOString(), digest: "a".repeat(64), approvedAt: new Date().toISOString(), approvedBy: "alex", approvedDigest: "a".repeat(64) });
    const before = store.getScope("existing");
    const inputs = { provider: "claude", model: "opus", command: "npm ci", seconds: "300" };
    const preview = previewSetup(store, "/repo", inputs); if (!preview.ok) throw Error(preview.message);
    expect(approveSetup(store, "/repo", inputs, preview.fingerprint, "alex", added.token, new Date()).ok).toBe(true);
    expect(store.getScope("existing")).toEqual(before);
    for (const model of ["__custom__", "--flag"]) expect(previewSetup(store, "/repo", { ...inputs, model }).ok).toBe(false);
    for (const seconds of ["0", "1e3", " 30", "3601"]) expect(previewSetup(store, "/repo", { ...inputs, seconds }).ok).toBe(false);
  } finally { store.close(); }
});
import { previewSetup, approveSetup } from "./control-setup.js";
