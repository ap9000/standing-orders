import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});
import { bridgePass, hashTelegramStartCode, PAIRING_TTL_MS, saveBotToken, type TelegramTransport } from "./telegram.js";
import { TelegramConsole } from "./telegram-console.js";

const BOT = "777000:AAExampleExampleExample123";
const botInfo = { id: 777000, username: "standing_orders_test_bot", is_bot: true };

test("a demo never starts Telegram, even when an enabled connection file exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-telegram-demo-")); const file = join(dir, "telegram-token");
  saveBotToken(file, BOT); writeFileSync(join(dir, "telegram-connection.json"), JSON.stringify({ botId: "777000", username: botInfo.username }));
  const store = openStore(":memory:"); store.recordInstallationFact("demo", "test", new Date());
  let calls = 0;
  const server = createDecisionServer({ store, evidenceRoot: dir, telegramTokenFile: file, telegramTransport: () => async () => { calls++; return { ok: true, result: [] }; } });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(calls).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Telegram settings connect without a command, survive a restart, and disconnect the chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-telegram-settings-")); const file = join(dir, "telegram-token");
  const store = openStore(":memory:"); let now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw new Error("fixture");
  let updates: unknown[] = []; const calls: string[] = [];
  const transport: TelegramTransport = async (method, params) => {
    calls.push(method);
    if (method === "getMe") return { ok: true, result: botInfo };
    if (method === "getUpdates") { const batch = updates; updates = []; return { ok: true, result: batch }; }
    return { ok: true, result: { message_id: 1 } };
  };
  const makeServer = () => createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), telegramTokenFile: file, configDir: dir, telegramTransport: () => transport, telegramIntervalMs: 10, clock: () => now });
  let server = makeServer();
  const listen = async () => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
  let base = await listen(); const window = new Window(); let cookie = "";
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie }, redirect: "manual" })).text();
  const post = (path: string, body: URLSearchParams, who = cookie) => fetch(base + path, { method: "POST", body, headers: { cookie: who, origin: base }, redirect: "manual" });
  const login = async () => { const result = await post("/login", new URLSearchParams({ name: "alex", token: added.token })); cookie = result.headers.get("set-cookie")!.split(";")[0]!; };
  const fields = (html: string, action: string) => {
    window.document.body.innerHTML = html;
    const form = window.document.querySelector(`form[action="${action}"]`); if (!form) throw new Error("form missing: " + action);
    return new URLSearchParams([...form.querySelectorAll<HTMLInputElement>("input[name]")].map(input => [input.name, input.value]));
  };
  const codeFrom = (html: string) => {
    window.document.body.innerHTML = html;
    const link = window.document.querySelector<HTMLAnchorElement>('a[href^="https://t.me/standing_orders_test_bot?start="]');
    if (!link) throw new Error("Start link missing"); return new URL(link.href).searchParams.get("start")!;
  };
  try {
    await login();
    const settings = await get("/settings");
    expect(settings).toContain("Connect Telegram"); expect(settings).not.toContain("standing-orders bridge telegram pair");
    expect(calls).toEqual([]); // Merely visiting Settings never dials Telegram.
    const connect = fields(settings, "/settings/telegram-connect"); connect.set("bot-token", BOT);
    expect((await post("/settings/telegram-connect", connect)).status).toBe(403);
    expect(calls).toEqual([]);
    connect.set("token", added.token);
    const csrfBad = new URLSearchParams(connect); csrfBad.set("csrf", "bad");
    expect((await post("/settings/telegram-connect", csrfBad)).status).toBe(403);
    expect((await post("/settings/telegram-connect", connect, "")).status).toBe(401);
    const connected = await post("/settings/telegram-connect", connect);
    expect(connected.status).toBe(303); expect(connected.headers.get("location")).toBe("/settings/telegram");
    expect(readFileSync(file, "utf8").trim()).toBe(BOT); expect(statSync(file).mode & 0o777).toBe(0o600);
    const pendingPage = await get("/settings/telegram"); const first = codeFrom(pendingPage);
    expect(pendingPage).not.toContain(BOT); expect(pendingPage).not.toContain("<script");
    expect(pendingPage).toContain('http-equiv="refresh"'); expect(pendingPage).toContain("Waiting for you to tap Start");
    expect(store.telegramPairingPending(hashTelegramStartCode("777000", first), now)).toBe(true);
    expect(JSON.stringify(store.raw().prepare("SELECT * FROM telegram_pairing").all())).not.toContain(first);
    expect(codeFrom(await get("/settings/telegram"))).toBe(first); // Read-only refresh keeps the same link.
    now = new Date(now.getTime() + PAIRING_TTL_MS + 1);
    expect(await get("/settings/telegram")).toContain("link expired");
    expect((await post("/settings/telegram-connect", connect)).status).toBe(303);
    const code = codeFrom(await get("/settings/telegram")); expect(code).not.toBe(first);
    expect(store.telegramPairingPending(hashTelegramStartCode("777000", first), now)).toBe(false);
    // The same link is useless to a different bot, and group chats cannot pair.
    const wrongBot = await bridgePass(store, { botId: "888000", deliver: false, clock: () => now, transport: async method => ({ ok: true, result: method === "getUpdates" ? [{ update_id: 11, message: { chat: { id: 1, type: "private" }, from: { id: 1 }, text: `/start ${code}` } }] : {} }) });
    expect(wrongBot.ok && wrongBot.report.paired).toBe(0);
    updates.push({ update_id: 12, message: { chat: { id: -1, type: "group" }, from: { id: 1 }, text: `/start ${code}` } });
    await vi.waitFor(() => expect(updates).toHaveLength(0));
    expect(store.liveTelegramBinding("777000")).toBeNull();
    updates.push({ update_id: 13, message: { chat: { id: 42, type: "private" }, from: { id: 42 }, text: `/start ${code}` } });
    await vi.waitFor(() => expect(store.liveTelegramBinding("777000")?.approver).toBe("alex"));
    const complete = await get("/settings/telegram"); expect(complete).toContain("Telegram is connected"); expect(complete).not.toContain('http-equiv="refresh"');
    await new Promise<void>(resolve => server.close(() => resolve()));
    const before = calls.length; server = makeServer(); base = await listen(); await login();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    const restored = await get("/settings"); expect(restored).toContain("Connected as alex");
    const disconnect = fields(restored, "/settings/telegram-disconnect"); disconnect.set("token", added.token);
    expect((await post("/settings/telegram-disconnect", disconnect)).status).toBe(303);
    expect(store.liveTelegramBinding("777000")).toBeNull(); expect(existsSync(join(dir, "telegram-connection.json"))).toBe(false);
    expect(await get("/settings")).toContain("Connect Telegram");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed bot verification or a credential rotation during it creates no connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-telegram-verification-")); const file = join(dir, "telegram-token");
  const store = openStore(":memory:"); const now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw new Error("fixture");
  let rotate = false;
  const server = createDecisionServer({ store, evidenceRoot: dir, telegramTokenFile: file, telegramTransport: () => async () => {
    if (rotate) { store.saveApprover("alex", hashPassword("changed"), now); return { ok: true, result: botInfo }; }
    return { ok: false, description: BOT };
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const logged = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual" });
    const cookie = logged.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await fetch(base + "/settings", { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const send = () => fetch(base + "/settings/telegram-connect", { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, token: added.token, "bot-token": BOT }), redirect: "manual" });
    const failed = await send(); expect(failed.status).toBe(400); expect(await failed.text()).not.toContain(BOT);
    expect(existsSync(file)).toBe(false);
    rotate = true; expect((await send()).status).toBe(403);
    expect(existsSync(file)).toBe(false); expect(existsSync(join(dir, "telegram-connection.json"))).toBe(false);
    expect(store.raw().prepare("SELECT * FROM telegram_pairing").all()).toHaveLength(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("closing the service aborts its pending Telegram request before releasing the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-telegram-close-")); const file = join(dir, "telegram-token");
  saveBotToken(file, BOT); const store = openStore(":memory:"); let started = false; let aborted = false;
  const connection = new TelegramConsole(store, { tokenFile: file, env: {}, transport: () => async (_method, _params, signal) => {
    started = true;
    return new Promise(resolve => signal!.addEventListener("abort", () => { aborted = true; resolve({ ok: false }); }, { once: true }));
  } });
  try {
    connection.start(); expect(started).toBe(false);
    await connection.enable({ botId: "777000", username: botInfo.username });
    await vi.waitFor(() => expect(started).toBe(true));
    await connection.close(); expect(aborted).toBe(true);
    expect(store.acquireBridgeLease("777000", "next", 1000, new Date()).ok).toBe(true);
  } finally { await connection.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
