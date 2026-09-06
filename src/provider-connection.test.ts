import { test, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { createConnectionChecker, signInFacts } from "./provider-connection.js";
import { setAuthMode, saveProviderKey } from "./keys.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import type { ExecResult } from "./exec.js";

const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const signedIn = { ...OK, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "alex@example.com", subscriptionType: "max", accessToken: "PRIVATE_TOKEN", orgName: "<script>private</script>" }) };

test("identity output is normalized, bounded, and never turns an unknown status into Connected", () => {
  expect(signInFacts("claude", signedIn)).toMatchObject({ state: "connected", email: "alex@example.com", plan: "Max", method: "Claude account" });
  expect(JSON.stringify(signInFacts("claude", signedIn))).not.toMatch(/PRIVATE_TOKEN|<script/);
  expect(signInFacts("claude", { ...OK, stdout: '{"loggedIn":false}', code: 1 }).state).toBe("signed-out");
  for (const result of [ { ...OK, stdout: "Usage: claude auth" }, { ...OK, stdout: "null" }, { ...OK, stdout: '{"loggedIn":"true"}' }, { ...signedIn, timedOut: true }, { ...signedIn, code: 1 } ]) {
    expect(signInFacts("claude", result).state).toBe("unverified");
  }
  expect(signInFacts("claude", { ...OK, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "__proto__", authMethod: "toString", email: "bad\u202e@example.com" }) })).not.toHaveProperty("plan");
  expect(signInFacts("claude", { ...OK, notFound: true }).state).toBe("not-installed");
  expect(signInFacts("codex", { ...OK, stderr: "Logged in using ChatGPT" })).toMatchObject({ state: "connected", method: "ChatGPT account" });
  expect(signInFacts("codex", { ...OK, stderr: "logged in perhaps" }).state).toBe("unverified");
  expect(signInFacts("codex", { ...OK, stderr: "Not logged in", code: 1 }).state).toBe("signed-out");
});

test("checks use only identity commands, strip keys, coalesce, refresh, and respect a change of auth mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "so-connection-")); let count = 0; let now = new Date(); let result = signedIn;
  const check = createConnectionChecker({ home, env: {}, clock: () => now, probe: async (file, args, options) => {
    count++; expect(file).toBe("claude"); expect(args).toEqual(["auth", "status", "--json"]);
    expect(options).toMatchObject({ cwd: home, timeoutMs: 5000, maxBuffer: 32768, omitEnv: ALL_CREDENTIAL_ENV });
    await Promise.resolve(); return result;
  } });
  try {
    const states = await Promise.all([check("claude"), check("claude"), check("claude", true)]);
    expect(states.every(one => one.state === "connected")).toBe(true); expect(count).toBe(1);
    result = { ...OK, code: 1, stdout: '{"loggedIn":false}' };
    expect((await check("claude")).state).toBe("connected"); expect(count).toBe(1);
    expect((await check("claude", true)).state).toBe("signed-out"); expect(count).toBe(2);
    now = new Date(now.getTime() + 31_000); await check("claude"); expect(count).toBe(3);
    setAuthMode("claude", "api-key", home);
    expect((await check("claude")).state).toBe("missing-key");
    saveProviderKey("claude", "test-key-value", home);
    expect((await check("claude")).state).toBe("key-present"); expect(count).toBe(3);
    setAuthMode("claude", "subscription", home);
    expect((await check("claude")).state).toBe("signed-out"); expect(count).toBe(4);
    expect((await createConnectionChecker({ home, env: {}, probe: async () => { throw Error("private stderr"); } })("claude")).state).toBe("unverified");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("setup, connection settings, and settings agree on real probe facts; refresh detects sign-out without exposing raw output", async () => {
  const root = mkdtempSync(join(tmpdir(), "so-connection-http-")); const repo = join(root, "repo"); mkdirSync(repo);
  const store = openStore(":memory:"); const op = addApprover(store, "tester", new Date()); if (!op.ok) throw Error("fixture");
  let result = signedIn; let probes = 0;
  const server = createDecisionServer({ store, repo, repos: [repo], evidenceRoot: root, telegramTokenFile: join(root, "absent-token"), connectionProbe: async () => { probes++; return result; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const window = new Window(); const parse = (html: string) => { window.document.body.innerHTML = html; return window.document; };
  try {
    expect((await fetch(base + "/control?check-connection=1", { redirect: "manual" })).status).toBe(303); expect(probes).toBe(0);
    const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "tester", token: op.token }), redirect: "manual" }); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).text();
    const setup = await get("/control?provider=claude&task=saved-task");
    expect(parse(setup).querySelector(".assistant-account")?.textContent).toContain("Connected");
    expect(parse(setup).querySelector(".assistant-account")?.textContent).toContain("alex@example.com · Max");
    expect(parse(setup).querySelector(".assistant-account")?.textContent).not.toContain("Connect account");
    expect(setup).not.toMatch(/PRIVATE_TOKEN|<script>private/);
    const connectionHref = parse(setup).querySelector('.assistant-account a.button-link')!.getAttribute("href")!;
    const connection = await get(connectionHref);
    expect(parse(connection).querySelector("h1")?.textContent).toBe("Claude is connected");
    expect(parse(connection).querySelector('input[name="resume-task"]')?.getAttribute("value")).toBe("saved-task");
    const settings = await get("/settings");
    expect(parse(settings).querySelector('form:has(input[name="provider"][value="claude"]) summary')?.textContent).toContain("Connected");
    result = { ...OK, code: 1, stdout: '{"loggedIn":false}' };
    const signedOut = await get("/control?provider=claude&check-connection=1");
    expect(parse(signedOut).querySelector(".assistant-account")?.textContent).toContain("Not signed in");
    expect(parse(signedOut).querySelector(".assistant-account")?.textContent).toContain("Connect account");
    result = { ...OK, timedOut: true };
    const unknown = await get("/settings?check-connection=claude");
    expect(parse(unknown).querySelector('form:has(input[name="provider"][value="claude"]) summary')?.textContent).toContain("Not verified");
    expect(store.listTasks()).toHaveLength(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
