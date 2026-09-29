/**
 * Monitoring (v104): the audit stream to a signed webhook and a JSON Lines
 * folder, traces to an OpenTelemetry collector, and `/metrics`. Deliveries
 * go in ledger order and at least once (a failure is retried, never
 * skipped); one process sends at a time; settings take a step-up and the
 * ledger keeps each change, never a secret.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { monitoringPass, SIGNATURE_HEADER } from "./monitoring.js";
import { readMonitoring, saveMonitoring, NO_MONITORING, type MonitoringSettings } from "./monitoring-settings.js";
import { mintApiToken } from "./api-tokens.js";
import { COMPLETION_ACTION } from "./result-completion.js";

let dir: string, store: Store;
const received: { headers: IncomingMessage["headers"]; body: string; url: string }[] = [];
let answer = 200, receiver: Server, receiverUrl = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-monitoring-"));
  store = openStore(join(dir, "orders.db"));
  received.length = 0; answer = 200;
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => { received.push({ headers: request.headers, body, url: request.url ?? "" }); response.statusCode = answer; response.end(); });
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  receiverUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => receiver.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const act = (action: string, at = new Date()) => store.recordAction({ at: at.toISOString(), actor: "alex", repo: "/repo/shop", taskId: null, runId: null, action, outcome: "done", source: "policy" });
const deps = (holder = "test-holder", now = () => new Date()) => ({ holder, instance: "test-instance", version: "0.0.0", now });
const webhook = (secret = "whsec_" + "x".repeat(43)): MonitoringSettings => ({ ...NO_MONITORING, webhook: { url: `${receiverUrl}/audit`, secret } });

test("the webhook gets sealed entries in order, signed, with the chain head; the cursor moves only past what landed", async () => {
  const secret = "whsec_" + "s".repeat(43);
  act("one"); act("two"); act("three");
  expect(await monitoringPass(store, webhook(secret), deps())).toEqual({ webhook: 3 });
  const [first] = received;
  const [t, v1] = String(first!.headers[SIGNATURE_HEADER]).split(",").map(part => part.split("=")[1]);
  expect(v1).toBe(createHmac("sha256", secret).update(`${t}.${first!.body}`).digest("hex"));
  const body = JSON.parse(first!.body) as { events: { id: number; action: string; seal: { hash: string }; instance: string }[]; chain: { through: number; head: string } };
  expect(body.events.map(one => one.action)).toEqual(["one", "two", "three"]);
  expect(body.events.every(one => one.seal.hash.length === 64 && one.instance === "test-instance")).toBe(true);
  expect(body.chain).toEqual({ through: body.events[2]!.id, head: body.events[2]!.seal.hash });
  // Nothing new, nothing sent; then only what's new.
  expect(await monitoringPass(store, webhook(secret), deps())).toEqual({ webhook: 0 });
  act("four");
  await monitoringPass(store, webhook(secret), deps());
  expect((JSON.parse(received[1]!.body) as { events: { action: string }[] }).events.map(one => one.action)).toEqual(["four"]);
  expect(store.monitoringStatus("webhook")[0]).toMatchObject({ sent: 4, failures: 0 });
});

test("a failed delivery is retried later from the same place: nothing skipped, nothing twice after it lands", async () => {
  act("one"); act("two");
  answer = 500;
  let clock = new Date("2026-09-28T12:00:00Z");
  const at = () => clock;
  expect(await monitoringPass(store, webhook(), deps("h", at))).toEqual({ webhook: 0 });
  const failing = store.monitoringStatus("webhook")[0]!;
  expect(failing).toMatchObject({ through: 0, failures: 1, lastError: expect.stringContaining("answered 500") });
  // Before the retry time, nothing goes out.
  received.length = 0;
  await monitoringPass(store, webhook(), deps("h", at));
  expect(received).toHaveLength(0);
  answer = 200;
  clock = new Date(Date.parse(failing.nextTryAt!) + 1);
  expect(await monitoringPass(store, webhook(), deps("h", at))).toEqual({ webhook: 2 });
  expect((JSON.parse(received[0]!.body) as { events: { action: string }[] }).events.map(one => one.action)).toEqual(["one", "two"]);
  expect(store.monitoringStatus("webhook")[0]).toMatchObject({ failures: 0, sent: 2 });
});

test("one process sends at a time", async () => {
  act("one");
  const now = new Date();
  expect(store.holdMonitoring("webhook", "other-process", now, new Date(now.getTime() + 60_000))).toBe(true);
  expect(await monitoringPass(store, webhook(), deps("this-process"))).toEqual({ webhook: 0 });
  expect(received).toHaveLength(0);
  // Its hold lapses; this one takes over from the same cursor.
  expect(await monitoringPass(store, webhook(), deps("this-process", () => new Date(now.getTime() + 61_000)))).toEqual({ webhook: 1 });
});

test("the folder gets the same events as JSON Lines, a file per day, readable by its owner only", async () => {
  act("yesterday", new Date("2026-09-27T23:00:00Z")); act("today", new Date("2026-09-28T01:00:00Z"));
  const folder = join(dir, "audit-logs");
  expect(await monitoringPass(store, { ...NO_MONITORING, folder: { path: folder } }, deps())).toEqual({ folder: 2 });
  const files = readdirSync(folder).sort();
  expect(files).toEqual(["standing-orders-audit-2026-09-27.jsonl", "standing-orders-audit-2026-09-28.jsonl"]);
  expect((JSON.parse(readFileSync(join(folder, files[1]!), "utf8").trim()) as { action: string }).action).toBe("today");
  expect(statSync(join(folder, files[0]!)).mode & 0o777).toBe(0o600);
  // A link planted where tomorrow's file goes is never followed.
  const elsewhere = join(dir, "not-an-audit-log.txt");
  writeFileSync(elsewhere, "keep\n");
  symlinkSync(elsewhere, join(folder, "standing-orders-audit-2026-09-29.jsonl"));
  act("tomorrow", new Date("2026-09-29T01:00:00Z"));
  expect(await monitoringPass(store, { ...NO_MONITORING, folder: { path: folder } }, deps())).toEqual({ folder: 0 });
  expect(readFileSync(elsewhere, "utf8")).toBe("keep\n");
  expect(store.monitoringStatus("folder")[0]).toMatchObject({ failures: 1 });
});

test("traces: a finished run is a span under its task's trace, and a completed task is the root; never a prompt or code", async () => {
  store.createTask({ id: "fix-login", title: "Fix the login bug" }, new Date());
  const ref = store.refFor("built-in", "fix-login").id;
  store.placeTask(ref, "/repo/shop");
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date());
  const run = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b1", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  store.recordUsage(run, { tokensIn: 1000, tokensOut: 200, costUsd: 0.25 });
  store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
  store.recordAction({ at: new Date().toISOString(), actor: "operator:alex", repo: "/repo/shop", taskId: "fix-login", runId: run, action: COMPLETION_ACTION, outcome: "checked", source: "work" });
  const settings: MonitoringSettings = { ...NO_MONITORING, traces: { endpoint: receiverUrl, header: { name: "x-honeycomb-team", value: "key-123" } } };
  expect(await monitoringPass(store, settings, deps())).toEqual({ traces: 2 });
  expect(received[0]!.url).toBe("/v1/traces");
  expect(received[0]!.headers["x-honeycomb-team"]).toBe("key-123");
  const body = JSON.parse(received[0]!.body) as { resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: { key: string }[] }[] }[] }[] };
  const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
  const [runSpan, root] = spans;
  expect(runSpan!.name).toBe("builder · claude");
  expect(runSpan!.traceId).toBe(root!.traceId);
  expect(runSpan!.parentSpanId).toBe(root!.spanId);
  expect(runSpan!.attributes.map(one => one.key)).toEqual(expect.arrayContaining(["gen_ai.usage.input_tokens", "standing_orders.cost_usd", "standing_orders.project"]));
  expect(received[0]!.body).not.toContain("Fix the login bug");
});

test("settings: https only (http only to this machine), secrets kept in a 0600 file, a new webhook gets a new secret shown once", () => {
  const bad = saveMonitoring(dir, { webhook: "http://logs.example.com/x", folder: "", tracesEndpoint: "", headerName: "", headerValue: "", rotate: false }, NO_MONITORING);
  expect(bad.ok).toBe(false);
  const saved = saveMonitoring(dir, { webhook: "https://logs.example.com/x", folder: "/var/log/so", tracesEndpoint: "http://127.0.0.1:4318", headerName: "x-key", headerValue: "v", rotate: false }, NO_MONITORING);
  if (!saved.ok) throw new Error(saved.said);
  expect(saved.secret).toMatch(/^whsec_/);
  expect(statSync(join(dir, "monitoring.json")).mode & 0o777).toBe(0o600);
  // The same address keeps its secret; rotate makes a new one; a blank header value keeps the saved one.
  const again = saveMonitoring(dir, { webhook: "https://logs.example.com/x", folder: "/var/log/so", tracesEndpoint: "http://127.0.0.1:4318", headerName: "x-key", headerValue: "", rotate: false }, readMonitoring(dir));
  expect(again).toMatchObject({ ok: true, secret: null });
  expect(readMonitoring(dir).traces?.header?.value).toBe("v");
  const rotated = saveMonitoring(dir, { webhook: "https://logs.example.com/x", folder: "", tracesEndpoint: "", headerName: "", headerValue: "", rotate: true }, readMonitoring(dir));
  expect(rotated.ok && rotated.secret !== null && rotated.secret !== saved.secret).toBe(true);
  expect(saveMonitoring(dir, { webhook: "", folder: "relative/path", tracesEndpoint: "", headerName: "", headerValue: "", rotate: false }, NO_MONITORING).ok).toBe(false);
  expect(saveMonitoring(dir, { webhook: "", folder: "", tracesEndpoint: "https://otel.example.com", headerName: "Host", headerValue: "x", rotate: false }, NO_MONITORING).ok).toBe(false);
});

test("the Monitoring page takes a step-up, shows the secret once, keeps each change in the ledger without secrets; /metrics is an operator's", async () => {
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", ["/repo/shop"], "alex", now)).toEqual({ ok: true });
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/shop", configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = await (await fetch(`${base}/settings/monitoring`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Monitoring</h1>");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetch(`${base}/settings/monitoring`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post({ webhook: "https://logs.example.com/in", password: "wrong" })).status).toBe(303);
    expect(readMonitoring(dir).webhook).toBeNull();
    const shown = await post({ webhook: "https://logs.example.com/in", folder: "", traces: "", "header-name": "", "header-value": "", password: alex.token });
    expect(shown.status).toBe(200);
    const html = await shown.text();
    const secret = readMonitoring(dir).webhook!.secret;
    expect(html).toContain(secret);
    expect(html).not.toMatch(/<script/i);
    const entry = store.actionLedger({ repos: null, instance: true, limit: 5 }).find(one => one.action === "monitoring changed")!;
    expect(entry).toMatchObject({ actor: "alex", source: "policy", detail: "off → webhook https://logs.example.com" });
    expect(JSON.stringify(store.actionLedger({ repos: null, instance: true, limit: 50 }))).not.toContain(secret);
    expect((await fetch(`${base}/settings/monitoring`, { headers: { cookie } })).status).toBe(200);
    // Metrics: an operator's API token reads them; a project-scoped person's doesn't.
    const minted = (account: string) => { const token = mintApiToken(); store.createApiToken({ id: token.id, account, name: `${account}-metrics`, secretHash: token.hash, access: "read", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: account }, now); return token.token; };
    const metrics = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${minted("alex")}` }, redirect: "manual" });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await metrics.text();
    expect(text).toContain("# TYPE standing_orders_runs_total counter");
    expect(text).toContain("standing_orders_ledger_chain_ok 1");
    expect(text).not.toContain("/repo/shop");
    expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${minted("sam")}` }, redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${base}/metrics`, { redirect: "manual" })).status).not.toBe(200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
