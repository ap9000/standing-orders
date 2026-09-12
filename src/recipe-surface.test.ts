import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Window } from "happy-dom";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { createWorkflowPreview, exportRecipe, saveWorkflowRecipe, starterRecipes } from "./recipes.js";
import { recipeFromForm, recipeScript } from "./recipe-ui.js";

const now = new Date("2026-09-12T22:00:00Z");
function fields(html: string, selector: string): URLSearchParams {
  const window = new Window();
  window.document.body.innerHTML = html;
  const form = window.document.querySelector(selector);
  if (form === null) throw Error(`Missing form ${selector}`);
  const body = new URLSearchParams();
  for (const node of form.querySelectorAll("input,textarea,select")) {
    const field = node as import("happy-dom").HTMLInputElement;
    if (!field.name || field.disabled || (["checkbox", "radio"].includes(field.type) && !field.checked)) continue;
    // Read the declared selected option: happy-dom's fragment parser can
    // incorrectly leave a preceding option selected while parsing <select>.
    const option = field.tagName === "SELECT" ? field.querySelector("option[selected]") ?? field.querySelector("option") : null;
    body.append(field.name, option === null ? field.value : option.getAttribute("value") ?? option.textContent);
  }
  window.happyDOM.abort();
  return body;
}

describe("recipe onboarding through authenticated HTTP", () => {
  let root: string, alpha: string, beta: string, base: string, cookie: string, store: Store, server: Server;
  const password = "recipe-test-password";
  async function get(path: string, as = cookie) { return fetch(base + path, { headers: { cookie: as }, redirect: "manual" }); }
  async function post(path: string, body: URLSearchParams, as = cookie) { return fetch(base + path, { method: "POST", headers: { cookie: as }, body, redirect: "manual" }); }
  async function login(name: string) {
    const response = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
    expect(response.status).toBe(303); return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-recipe-http-"))); alpha = join(root, "alpha"); beta = join(root, "beta"); mkdirSync(alpha); mkdirSync(beta);
    store = openStore(":memory:"); addApprover(store, "owner", now);
    for (const [name, role, projects] of [["member", "approver", [alpha]], ["other", "approver", [alpha]], ["viewer", "viewer", [alpha]]] as const) {
      const invite = store.mintInvite(role, "owner", now, undefined, [...projects]);
      store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name, credentialHash: hashPassword(password) }, now);
    }
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", now);
    server = createDecisionServer({ store, evidenceRoot: root, repos: [alpha, beta], clock: () => now });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cookie = await login("member");
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); });

  async function makePreview(recipe = "lint-sweep") {
    const page = await get(`/recipes/start?recipe=${recipe}&revision=1`); expect(page.status).toBe(200);
    const form = fields(await page.text(), ".recipe-editor");
    const response = await post("/recipes/preview", form);
    expect(response.status, response.status === 303 ? "" : (await response.text()).match(/role="alert"[^>]*>(.*?)<\/p>/s)?.[1]).toBe(303);
    const path = response.headers.get("location")!;
    const preview = await get(path); expect(preview.status).toBe(200);
    return { path, html: await preview.text(), form };
  }

  test("choose, customize, preview, save, export and launch; retry opens the same task", async () => {
    const library = await (await get("/recipes")).text();
    expect(library).toContain("Good work, on repeat."); expect(library).toContain("Understand this project");
    expect(library).not.toContain(beta);
    const { path, html } = await makePreview();
    expect(store.listTasks()).toHaveLength(0);
    expect(html).toContain("Worker needed"); expect(html).toContain("Success checks");
    const save = fields(html, 'form[action="/recipes/save"]');
    expect((await post("/recipes/save", save)).status).toBe(303);
    expect(store.listTasks()).toHaveLength(0);
    const downloaded = await get(path.replace("/preview?", "/export?"));
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
    const document = await downloaded.json(); expect(document.name).toBe("Clean up lint and types"); expect(document.repo).toBeUndefined();
    const launch = fields(html, 'form[action="/recipes/launch"]'); launch.set("goal", "A forged late edit must not replace the preview");
    const first = await post("/recipes/launch", launch), repeat = await post("/recipes/launch", launch);
    expect(first.status).toBe(303); expect(repeat.headers.get("location")).toBe(first.headers.get("location"));
    const task = store.listTasks()[0]!;
    expect(store.listTasks()).toHaveLength(1); expect(store.getScope(task.id)?.approvedAt).toBeNull();
    expect(store.getScope(task.id)?.goal).not.toContain("forged late edit");
    const history = await (await get("/recipes")).text(); expect(history).toContain(first.headers.get("location")!); expect(history).toContain("queued");
    const copied = await get(`/recipes/from-task?task=${task.id}`); expect(copied.status).toBe(200);
    expect(fields(await copied.text(), ".recipe-editor").get("goal")).toBe(store.getScope(task.id)?.goal);
    expect(store.actionLedger({ repos: [alpha] }).filter(one => one.action === "workflow created")).toHaveLength(1);
  });

  test("run-once and repeating choices preserve their different approval boundaries", async () => {
    const { html } = await makePreview("docs-drift");
    expect(html).toContain("Create scheduled workflow");
    const response = await post("/recipes/launch", fields(html, 'form[action="/recipes/launch"]'));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toMatch(/^\/routines\//);
    expect(store.listTasks()).toHaveLength(0);
    expect(store.listRoutines(alpha)).toHaveLength(1); expect(store.listRoutines(alpha)[0]?.approvedAt).toBeNull();
  });

  test("a feature starter requires a real outcome and preserves it through editing", async () => {
    const page = await (await get("/recipes/start?recipe=small-feature")).text();
    const form = fields(page, ".recipe-editor");
    expect(form.get("goal")).toBe("");
    expect((await post("/recipes/preview", form)).status).toBe(400);
    form.set("goal", "Let people export the current filtered task list as CSV.");
    const response = await post("/recipes/preview", form); expect(response.status).toBe(303);
    const edited = await get(response.headers.get("location")!.replace("/preview?", "/edit?"));
    expect(fields(await edited.text(), ".recipe-editor").get("goal")).toBe(form.get("goal"));
    expect(store.listTasks()).toHaveLength(0);
  });

  test("private previews, foreign recipes, viewers, stale projects and CSRF all refuse", async () => {
    const { path, html, form } = await makePreview();
    const launch = fields(html, 'form[action="/recipes/launch"]');
    expect((await get(path, await login("other"))).status).toBe(404);
    expect((await post("/recipes/launch", launch, await login("viewer"))).status).toBe(403);
    const stale = new URLSearchParams(launch); stale.set("projectRevision", "500");
    expect((await post("/recipes/launch", stale)).status).toBe(409);
    const csrf = new URLSearchParams(launch); csrf.delete("csrf"); expect((await post("/recipes/launch", csrf)).status).toBe(403);
    const foreign = new URLSearchParams(form); foreign.set("repo", beta); expect((await post("/recipes/preview", foreign)).status).toBe(403);
    const saved = saveWorkflowRecipe(store, "owner", beta, createWorkflowPreview(store, "owner", beta, { ...starterRecipes()[0]!.document, name: "PRIVATE BETA RECIPE" }, "custom", now).token, now);
    expect((await get(`/recipes/start?recipe=${saved.id}`)).status).toBe(404);
    expect((await get(`/recipes/export?recipe=${saved.id}`)).status).toBe(404);
    expect(await (await get("/recipes")).text()).not.toContain("PRIVATE BETA RECIPE");
    store.setAccountProjects("member", [], "owner", now);
    expect((await post("/recipes/launch", launch)).status).not.toBe(303);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("import is editable without work; malformed/privileged imports and duplicated fields refuse", async () => {
    const library = await (await get("/recipes")).text(); const form = fields(library, 'form[action="/recipes/import"]');
    const d = { ...starterRecipes().find(one => one.id === "lint-sweep")!.document, name: '<img src=x onerror="alert(1)">' };
    form.set("document", exportRecipe(d));
    const imported = await post("/recipes/import", form); expect(imported.status).toBe(200);
    const text = await imported.text(); expect(text).not.toContain('<img src=x onerror="alert(1)">');
    expect(fields(text, ".recipe-editor").get("name")).toBe(d.name);
    expect(store.listTasks()).toHaveLength(0);
    form.set("document", JSON.stringify({ ...d, autoApprove: true })); expect((await post("/recipes/import", form)).status).toBe(400);
    form.set("document", "{bad"); expect((await post("/recipes/import", form)).status).toBe(400);
    const editor = fields(text, ".recipe-editor"); editor.append("source", "custom"); expect((await post("/recipes/preview", editor)).status).toBe(400);
    editor.delete("source"); editor.set("source", "custom"); editor.set("criterion-12-statement", "This must not disappear");
    expect((await post("/recipes/preview", editor)).status).toBe(400);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("invalid submissions retain the person's edits; progressive controls preserve check evidence", async () => {
    const initial = await (await get("/recipes/start?recipe=lint-sweep")).text();
    const form = fields(initial, ".recipe-editor"); form.set("name", "My edited workflow"); form.delete("criterion-0-evidence");
    const invalid = await post("/recipes/preview", form); expect(invalid.status).toBe(400);
    const returned = fields(await invalid.text(), ".recipe-editor"); expect(returned.get("name")).toBe("My edited workflow");
    expect(returned.getAll("criterion-0-evidence")).toEqual([]);
    const window = new Window(); window.document.body.innerHTML = initial; window.eval(recipeScript());
    const cadence = window.document.querySelector('[name="cadence"]')!;
    expect(window.document.querySelector('[data-recipe-recurring]')!.hasAttribute("hidden")).toBe(true);
    (cadence as import("happy-dom").HTMLSelectElement).value = "repeat"; cadence.dispatchEvent(new window.Event("change"));
    expect(window.document.querySelector('[data-recipe-recurring]')!.hasAttribute("hidden")).toBe(false);
    (window.document.querySelector('[data-add-criterion]') as import("happy-dom").HTMLButtonElement).click();
    expect(window.document.querySelectorAll(".recipe-criterion")).toHaveLength(3);
    window.happyDOM.abort();
    const one = fields(initial, ".recipe-editor"); expect(recipeFromForm(one).acceptance[0]?.evidence).toEqual(["check"]);
  });
});
