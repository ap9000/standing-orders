import { test, expect } from "vitest";
import { Window } from "happy-dom";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fetchOpenRouterModels, parseOpenRouterModels, modelDollars, openRouterModelsCache, openRouterPicker, openRouterPickerScript } from "./openrouter-models.js";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { saveProviderKey } from "./keys.js";
import { createDecisionServer } from "./serve.js";

const row = { id: "sample/precise", name: "Precise", context_length: 200000, supported_parameters: ["tools"], pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000015", overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000003" }] } };
const response = (data: unknown = [row]) => new Response(JSON.stringify({ data }));

test("catalog display keeps sub-dollar rates exact and unknown prices distinct from free", () => {
  const models = parseOpenRouterModels([row,
    { id: "sample/free", pricing: { prompt: "0", completion: 0 } },
    { id: "sample/unknown", pricing: { prompt: null, completion: "" } },
    { id: "sample/dynamic", pricing: { prompt: "-1", completion: Infinity } },
    { id: "sample/audio", architecture: { output_modalities: ["audio"] } },
    { id: "--invalid" },
  ])!;
  expect(models.find(one => one.id === row.id)).toMatchObject({ input: 0.15, output: 0.6, cachedInput: 0.015, conditionalPricing: true });
  expect(models.find(one => one.id === "sample/free")).toMatchObject({ input: 0, output: 0 });
  for (const id of ["sample/unknown", "sample/dynamic"]) expect(models.find(one => one.id === id)).toMatchObject({ input: null, output: null });
  expect(models).toHaveLength(4);
  expect(modelDollars(null)).toBe("Not reported"); expect(modelDollars(0)).toBe("$0"); expect(modelDollars(0.15)).toBe("$0.15");
  expect(modelDollars(0.000000001)).toBe("<$0.00000001");
});

test("public browsing is key-free; account browsing uses a fixed authenticated endpoint and never falls back", async () => {
  const calls: { url: string; headers: Headers; redirect: unknown; signal: unknown }[] = [];
  const fetcher: typeof fetch = async (url, options) => { calls.push({ url: String(url), headers: new Headers(options?.headers), redirect: options?.redirect, signal: options?.signal }); return response(); };
  expect(await fetchOpenRouterModels(null, fetcher)).toMatchObject({ ok: true, source: "public" });
  expect(await fetchOpenRouterModels("fixture-key", fetcher)).toMatchObject({ ok: true, source: "account" });
  expect(calls.map(one => one.url)).toEqual(["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/models/user"]);
  expect(calls[0]!.headers.has("authorization")).toBe(false);
  expect(calls[1]!.headers.get("authorization")).toBe("Bearer fixture-key");
  expect(calls.every(one => one.redirect === "error" && one.signal instanceof AbortSignal)).toBe(true);
  let failedCalls = 0;
  const failure = await fetchOpenRouterModels("fixture-key", async () => { failedCalls++; return new Response("echoed fixture-key", { status: 401 }); });
  expect(failedCalls).toBe(1); expect(failure).toMatchObject({ ok: false, problem: expect.stringContaining("rejected") });
  expect(JSON.stringify(failure)).not.toContain("fixture-key");
});

test("bad and oversized responses are bounded failures; an empty account catalog remains empty", async () => {
  expect(await fetchOpenRouterModels(null, async () => response([]))).toMatchObject({ ok: true, models: [] });
  for (const fetcher of [async () => response(null), async () => new Response("bad json"), async () => new Response(new Uint8Array(8_388_609)), async () => { throw new Error("private details"); }]) {
    const result = await fetchOpenRouterModels(null, fetcher);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("private details");
  }
});

test("discovery caches only the same credential and coalesces refreshes without cross-account reuse", async () => {
  const keys: (string | null)[] = [];
  const load = openRouterModelsCache(async (_, options) => { keys.push(new Headers(options?.headers).get("authorization")); return response(); });
  await Promise.all([load(null), load(null)]); await load(null);
  await load("first-key"); await load("second-key"); await load(null); await load(null, true);
  expect(keys).toEqual([null, "Bearer first-key", "Bearer second-key", null, null]);
});

test("a slow request cannot overwrite the newer account catalog", async () => {
  let finish!: (response: Response) => void;
  const load = openRouterModelsCache(async (_, options) => new Headers(options?.headers).get("authorization") === "Bearer slow"
    ? new Promise<Response>(resolve => { finish = resolve; }) : response([{ ...row, id: "sample/new" }]));
  const older = load("slow"); await load("new"); finish(response()); await older;
  expect(await load("new")).toMatchObject({ ok: true, models: [{ id: "sample/new" }] });
});

test("search preserves an explicit selection and renders catalog text without executable markup", async () => {
  const window = new Window();
  try {
    const models = parseOpenRouterModels([row, { ...row, id: "another/model", name: '<img src=x onerror="attack()">' }])!;
    window.document.body.innerHTML = `<form>${openRouterPicker({ ok: true, models, source: "public", checkedAt: "2026-09-06T12:00:00Z" }, null, "/control?provider=openrouter&refresh-models=1")}</form>`;
    window.eval(openRouterPickerScript());
    expect(window.document.querySelector("img")).toBeNull();
    const select = window.document.querySelector("select")!, search = window.document.querySelector("input")!;
    expect(select.value).toBe("__custom__");
    search.value = "precise"; search.dispatchEvent(new window.Event("input"));
    expect(select.options.length).toBe(2); expect(select.value).toBe("__custom__");
    select.value = row.id; select.dispatchEvent(new window.Event("change"));
    expect(window.document.querySelector("#openrouter-price")!.textContent).toContain("Input $0.15 · Output $0.6 · Cached input $0.015 per 1M tokens");
    search.value = "no results"; search.dispatchEvent(new window.Event("input"));
    expect(select.value).toBe(row.id); expect(window.document.querySelector("[data-model-count]")!.textContent).toContain("0 matches · your selection is kept");
    search.value = ""; search.dispatchEvent(new window.Event("input")); expect(select.options.length).toBe(3);
  } finally { await window.happyDOM.close(); }
});

test("shared setup loads prices, previews the exact model, and saves through the existing approval", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-openrouter-models-")));
  execFileSync("git", ["init", "-q", root]);
  const store = openStore(join(root, "orders.db"));
  const added = addApprover(store, "alex", new Date()); if (!added.ok) throw Error("fixture");
  const calls: string[] = [];
  const server = createDecisionServer({ store, repos: [root], evidenceRoot: join(root, "evidence"), connectionHome: root,
    connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }),
    modelCatalogFetcher: async url => { calls.push(String(url)); return response(); },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("address");
  const base = `http://127.0.0.1:${address.port}`, window = new Window();
  try {
    const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async () => (await fetch(base + "/control?provider=openrouter", { headers: { cookie } })).text();
    const fields = (html: string, action: string) => {
      window.document.body.innerHTML = html;
      return Object.fromEntries([...window.document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`form[action="${action}"] [name]`)].map(one => [one.name, one.value]));
    };
    const html = await get(); expect(html).toContain("$0.15 in / $0.6 out per 1M"); expect(html).toContain("Public catalog");
    const values = { ...fields(html, "/control/setup-preview"), model: row.id, "after-setup": "settings" };
    expect(store.phaseConfig(root, "build")).toBeNull();
    const post = (path: string, data: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(data), redirect: "manual" });
    const review = await post("/control/setup-preview", values); expect(review.status).toBe(200);
    const confirmation = fields(await review.text(), "/control/setup-approve");
    expect(confirmation.model).toBe(row.id); expect(store.phaseConfig(root, "build")).toBeNull();
    expect((await post("/control/setup-approve", { ...confirmation, token: added.token })).status).toBe(200);
    expect(store.phaseConfig(root, "build")?.model).toBe(row.id);
    saveProviderKey("openrouter", "fixture-api-key", root);
    const accountHtml = await get(); expect(accountHtml).toContain("Filtered for your OpenRouter account"); expect(accountHtml).not.toContain("fixture-api-key");
    expect(calls).toEqual(["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/models/user"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await window.happyDOM.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
