import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});
import { saveBotToken } from "./telegram.js";
import { saveWebhook, loadPrimary } from "./webhooks.js";

test("Settings has working section links, honest connection status, and a usable multiple-service choice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "so-ui-settings-"));
  const store = openStore(":memory:"); const now = new Date();
  const account = addApprover(store, "reviewer", now); if (!account.ok) throw new Error("fixture");
  const tokenFile = join(dir, "telegram-token"); saveBotToken(tokenFile, "777000:AAExampleExampleExample123");
  let networkCalls = 0;
  const server = createDecisionServer({ store, evidenceRoot: dir, configDir: dir, telegramTokenFile: tokenFile, telegramTransport: () => async () => { networkCalls++; return { ok: true, result: [] }; } });
  const window = new Window();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "reviewer", token: account.token }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const read = async (path = "/settings") => { const response = await fetch(base + path, { headers: { cookie } }); expect(response.status).toBe(200); window.document.body.innerHTML = await response.text(); return window.document; };
  try {
    let doc = await read();
    for (const link of doc.querySelectorAll<HTMLAnchorElement>(".settings-nav a")) expect(doc.querySelector(link.getAttribute("href")!)).not.toBeNull();
    expect(doc.querySelectorAll("#approval-preferences")).toHaveLength(1);
    expect(doc.querySelector("#notifications")?.textContent).toContain("Finish connecting Telegram");
    expect(doc.querySelector('#notifications form[action="/settings/messaging"]')).toBeNull();
    expect(doc.querySelector("#notifications")?.textContent).not.toContain("Alerts enabled");
    for (const form of doc.querySelectorAll('form[action="/settings/provider-key"]')) {
      expect(form.querySelector("details")?.open).toBe(false);
      expect(form.querySelector('input[name="csrf"]')).not.toBeNull();
      expect(form.querySelector('details input[name="value"]')).not.toBeNull();
      expect(form.querySelector('details button[type="submit"]')).not.toBeNull();
    }
    store.createTelegramPairing({ codeHash: "test-pairing", approver: "reviewer", by: "test", ttlMs: 60_000 }, now);
    expect(store.consumeTelegramPairing({ codeHash: "test-pairing", botId: "777000", chatId: "42", userId: "42", updateId: 1 }, now).ok).toBe(true);
    doc = await read();
    expect(doc.querySelector("#telegram")?.textContent).toContain("Connected as reviewer");
    expect(doc.querySelector("#notifications")?.textContent).toContain("Alerts enabled");
    expect(doc.querySelector('form[action="/settings/messaging"]')).toBeNull();
    expect(saveWebhook(dir, "slack", "https://hooks.slack.com/services/test-only").ok).toBe(true);
    doc = await read();
    const choices = doc.querySelectorAll<HTMLInputElement>('.channel-choice input[type="radio"]');
    expect([...choices].map(input => input.value)).toEqual(["telegram", "slack"]);
    expect([...choices].filter(input => input.checked)).toHaveLength(1);
    const csrf = doc.querySelector<HTMLInputElement>('.channel-form input[name="csrf"]')!.value;
    const save = (csrf: string) => fetch(base + "/settings/messaging", { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, primary: "slack" }), redirect: "manual" });
    expect((await save("invalid")).status).toBe(403);
    expect((await save(csrf)).status).toBe(303);
    expect(loadPrimary({}, dir)).toBe("slack");
    doc = await read();
    expect(doc.querySelector<HTMLInputElement>('.channel-choice input[value="slack"]')?.checked).toBe(true);
    expect(networkCalls).toBe(0);
    doc = await read("/workbench");
    expect(doc.querySelector<HTMLDetailsElement>(".nav-more")?.open).toBe(false);
    expect(doc.querySelector('.side a[aria-current="page"]')?.textContent).toBe("Overview");
    expect(doc.querySelector("#main-content")).not.toBeNull();
    doc = await read("/system");
    expect(doc.querySelector<HTMLDetailsElement>(".nav-more")?.open).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
