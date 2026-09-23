import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { parseOpenRouterModels } from "./openrouter-models.js";
import { aliasTarget, catalogRows, checkModels, claudeIdOf, livePin, modelOptions, modelWatchPass, modelWords, recordCatalog, runtimeStates, setWatch, updateRuntime, type VersionRunner } from "./model-catalog.js";
import { runModelsCommand } from "./models-cli.js";

const t0 = new Date("2026-09-22T12:00:00Z");
const created = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const row = (id: string, name: string, prompt: string, completion: string, at: string, tools = true) =>
  ({ id, name, created: created(at), context_length: 200_000, pricing: { prompt, completion }, supported_parameters: tools ? ["tools"] : [], architecture: { output_modalities: ["text"] } });
const BASE = [
  row("anthropic/claude-opus-5", "Anthropic: Claude Opus 5", "0.000005", "0.000025", "2026-07-24T00:00:00Z"),
  row("anthropic/claude-opus-5:batch", "Anthropic: Claude Opus 5 (batch)", "0.0000025", "0.0000125", "2026-07-24T00:00:00Z"),
  row("anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5", "0.000002", "0.00001", "2026-07-01T00:00:00Z"),
  row("anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5", "0.000001", "0.000005", "2025-10-01T00:00:00Z"),
  row("google/gemini-3.8-flash", "Google: Gemini 3.8 Flash", "0.00000075", "0.00000375", "2026-09-01T00:00:00Z"),
  row("google/gemini-3-pro-image", "Google: Nano Banana Pro", "0.000002", "0.000012", "2026-06-01T00:00:00Z"),
  row("openai/gpt-6-astra", "OpenAI: GPT-6 Astra", "0.00001", "0.00005", "2026-09-05T00:00:00Z"),
  row("meta/llama-5", "Meta: Llama 5", "0.0000003", "0.0000006", "2026-05-01T00:00:00Z", false),
];
const OPUS_55 = row("anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", "0.000004", "0.00002", "2026-09-22T09:00:00Z");

describe("the live model catalog", () => {
  let root: string, home: string, bin: string, store: Store, catalog: unknown[], registry: Record<string, string>;
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response(JSON.stringify({ data: catalog }), { status: 200 });
    const pkg = /registry\.npmjs\.org\/(.+)\/latest$/.exec(url)?.[1];
    if (pkg !== undefined && registry[pkg] !== undefined) return new Response(JSON.stringify({ version: registry[pkg] }), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  let versions: Record<string, string>, calls: string[][];
  const runner: VersionRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return { code: 0, stdout: `${versions[command]} (${command})\n`, stderr: "" };
    if (command === "claude" && args[0] === "update") { versions["claude"] = registry["@anthropic-ai/claude-code"]!; return { code: 0, stdout: "updated", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const seams = () => ({ fetcher, runner, home, path: bin });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "model-catalog-")));
    home = join(root, "home"); bin = join(root, "bin");
    mkdirSync(join(home, ".codex"), { recursive: true }); mkdirSync(bin);
    writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" }, { slug: "hidden", visibility: "hide" }] }));
    // The Claude CLI installed the native way; Codex through npm.
    const native = join(home, ".local", "share", "claude", "versions"); mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "2.1.270"), "#!/bin/sh\n"); chmodSync(join(native, "2.1.270"), 0o755); symlinkSync(join(native, "2.1.270"), join(bin, "claude"));
    const npm = join(root, "lib", "node_modules", "@openai", "codex", "bin"); mkdirSync(npm, { recursive: true });
    writeFileSync(join(npm, "codex.js"), "#!/bin/sh\n"); chmodSync(join(npm, "codex.js"), 0o755); symlinkSync(join(npm, "codex.js"), join(bin, "codex"));
    store = openStore(join(root, "orders.db"));
    catalog = [...BASE];
    registry = { "@anthropic-ai/claude-code": "2.1.280", "@openai/codex": "0.156.0" };
    versions = { claude: "2.1.270", codex: "0.156.0" };
    calls = [];
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  test("maps vendor models to the ids each CLI runs, with prices", () => {
    expect(claudeIdOf("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(claudeIdOf("anthropic/claude-opus-5.5:batch")).toBeNull();
    const rows = catalogRows(parseOpenRouterModels(BASE)!, [{ id: "gpt-6-astra", name: "GPT-6 Astra" }]);
    expect(rows.filter(one => one.source === "claude").map(one => one.id).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(rows.filter(one => one.source === "gemini").map(one => one.id)).toEqual(["gemini-3.8-flash"]);
    expect(rows.find(one => one.source === "codex")).toMatchObject({ id: "gpt-6-astra", inputUsd: 10, outputUsd: 50 });
    expect(rows.some(one => one.id.includes(":"))).toBe(false);
  });

  test("a new release is announced once, moves the alias, and prices chat from the live list", async () => {
    const first = await checkModels(store, t0, seams());
    expect(first.ok).toBe(true);
    expect(first.added).toEqual([]); // the first fetch is the baseline, not a flood of notices
    expect(aliasTarget(store, "opus")?.id).toBe("claude-opus-5");
    expect(store.listNotifications("all").filter(one => one.kind === "model-available")).toHaveLength(0);

    catalog = [...BASE, OPUS_55];
    const later = new Date(t0.getTime() + 3_600_000);
    const second = await checkModels(store, later, seams());
    expect(second.added.map(one => `${one.source}:${one.id}`)).toEqual(["openrouter:anthropic/claude-opus-5.5", "claude:claude-opus-5-5"]);
    expect(aliasTarget(store, "opus")?.id).toBe("claude-opus-5-5");
    expect(modelWords(store, "claude", "opus")).toBe("Opus (now Claude Opus 5.5)");
    const notices = store.listNotifications("all").filter(one => one.kind === "model-available");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe("New model: Claude Opus 5.5");
    expect(notices[0]!.body).toContain('Agents set to "opus" use it from now on.');
    await checkModels(store, new Date(later.getTime() + 60_000), seams());
    expect(store.listNotifications("all").filter(one => one.kind === "model-available")).toHaveLength(1);

    const claude = modelOptions(store, "claude", later, home);
    expect(claude[1]).toMatchObject({ value: "opus", label: "Opus · latest (Opus 5.5)" });
    expect(claude.find(one => one.value === "claude-opus-5-5")?.label).toBe("Claude Opus 5.5 · $4 / $20 per 1M tokens · New");
    expect(modelOptions(store, "codex", later, home).map(one => one.value)).toEqual(["gpt-6-astra"]);
    expect(modelOptions(store, "openrouter", later, home).map(one => one.value)).not.toContain("meta/llama-5"); // agents need tool calling
    expect(livePin(store, "anthropic-api", "claude-opus-5-5")).toEqual({ inMicrousd: 4, outMicrousd: 20 });
    expect(livePin(store, "openrouter-api", "google/gemini-3.8-flash")).toEqual({ inMicrousd: 1, outMicrousd: 4 });
    expect(livePin(store, "anthropic-api", "claude-unknown-9")).toBeNull();
  });

  test("CLI versions: an update is offered, announced once, and runs only while nothing is running", async () => {
    await checkModels(store, t0, seams());
    const states = runtimeStates(store);
    expect(states.map(one => [one.tool, one.installed, one.latest, one.behind])).toEqual([["claude", "2.1.270", "2.1.280", true], ["codex", "0.156.0", "0.156.0", false]]);
    expect(states[0]!.updateCommand).toEqual(["claude", "update"]);
    const notices = () => store.listNotifications("all").filter(one => one.kind === "runtime-update");
    expect(notices().map(one => one.subject)).toEqual(["Claude Code 2.1.280 is available"]);
    await checkModels(store, t0, seams());
    expect(notices()).toHaveLength(1);

    store.handle.exec("PRAGMA foreign_keys=OFF");
    store.handle.prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) VALUES (1, 1, 'alex', 'cli', ?)").run(t0.toISOString());
    const busy = await updateRuntime(store, "claude", "alex", t0, seams());
    expect(busy).toEqual({ ok: false, message: "Work is running (1 item). Update Claude Code when it finishes." });
    expect(calls.some(one => one[1] === "update")).toBe(false);
    store.handle.exec("DELETE FROM run_stop");

    const done = await updateRuntime(store, "claude", "alex", t0, seams());
    expect(done).toEqual({ ok: true, message: "Claude Code updated to 2.1.280. New work uses it; nothing running was touched." });
    expect(runtimeStates(store)[0]).toMatchObject({ installed: "2.1.280", behind: false, updatedBy: "alex" });
    expect((await updateRuntime(store, "gemini", "alex", t0, seams())).message).toBe("Gemini CLI is not installed on this computer.");
  });

  test("the background check runs only when turned on, at most every 6 hours", async () => {
    expect(await modelWatchPass(store, t0, seams())).toBe(false);
    expect(calls).toHaveLength(0);
    setWatch(store, true, "alex", t0);
    expect(await modelWatchPass(store, t0, seams())).toBe(true);
    expect(await modelWatchPass(store, new Date(t0.getTime() + 3_600_000), seams())).toBe(false);
    expect(await modelWatchPass(store, new Date(t0.getTime() + 7 * 3_600_000), seams())).toBe(true);
  });

  test("models CLI reads and changes the same saved state", async () => {
    const lines: string[] = [];
    const context = { store, write: (line: string) => lines.push(line), json: false, now: t0, actor: "alex", seams: seams() };
    expect(await runModelsCommand(["check"], new Map(), context)).toBe(0);
    expect(lines.join("\n")).toContain("Claude Code 2.1.280 is available (you have 2.1.270).");
    lines.length = 0;
    expect(await runModelsCommand(["list"], new Map([["provider", "claude"]]), context)).toBe(0);
    expect(lines[0]).toContain("sonnet  Sonnet · latest (Sonnet 5)");
    expect(await runModelsCommand(["watch", "on"], new Map(), context)).toBe(0);
    expect(await runModelsCommand(["status"], new Map(), { ...context, actor: null })).toBe(1);
  });

  test("Settings → Models shows tools and saves a default agent picked from the live list", async () => {
    const user = addApprover(store, "alex", t0); if (!user.ok) throw Error("fixture");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", t0);
    store.setPhaseConfig("installation", "repair", "claude", "sonnet", "alex", t0);
    const server = createDecisionServer({ store, evidenceRoot: join(root, "evidence"), connectionHome: home, modelCatalogFetcher: fetcher, modelRunner: runner, modelPath: bin, clock: () => t0 });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("server");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(url + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: user.token }), redirect: "manual" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const page = await (await fetch(url + "/settings/models", { headers: { cookie } })).text();
      expect(page).toContain("<strong>Claude Code</strong> 2.1.270 · <strong>2.1.280 available</strong>");
      expect(page).toContain("Update Claude Code");
      expect(page).toContain("<strong>Codex</strong> 0.156.0 · Up to date");
      expect(page).toContain("Opus · latest (Opus 5)");
      expect(page).toContain('<option value="claude|sonnet" selected>Sonnet · latest (Sonnet 5)</option>');
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const post = (path: string, data: Record<string, string>) => fetch(url + path, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...data }), redirect: "manual" });
      const saved = await post("/settings/models/agent", { phase: "build", agent: "codex|gpt-6-astra" });
      expect(decodeURIComponent(saved.headers.get("location")!)).toBe("/settings/models?said=Builder now uses GPT-6 Astra for new tasks. Repairs now follow the builder.");
      expect(store.phaseConfig("installation", "build")).toMatchObject({ provider: "codex", model: "gpt-6-astra", updatedBy: "alex" });
      expect(store.phaseConfig("installation", "repair")).toBeNull();
      const bad = await post("/settings/models/agent", { phase: "review", agent: "gemini|gemini-3.8-flash" });
      expect(bad.headers.get("location")).toContain("problem=");
      const repair = await post("/settings/models/agent", { phase: "repair", agent: "claude|opus" });
      expect(decodeURIComponent(repair.headers.get("location")!)).toContain("Repairs must use the builder's provider (codex).");
      const forged = await fetch(url + "/settings/models/agent", { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: "wrong", phase: "plan", agent: "claude|opus" }), redirect: "manual" });
      expect(forged.status).toBeGreaterThanOrEqual(400);
      expect(store.phaseConfig("installation", "plan")).toBeNull();
      const on = await post("/settings/models/watch", { enabled: "1" });
      expect(decodeURIComponent(on.headers.get("location")!)).toContain("Automatic checks are on.");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
