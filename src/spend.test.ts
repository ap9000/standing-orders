/**
 * Cost guardrails (v105): every run priced (reported, or tokens at the
 * catalogue price, or honestly unpriced), spend attributed to projects,
 * people and teammates, monthly budgets that alert at 50/80/100 % and stop
 * new work at 100 %, and a Spend page with CSV.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { priceFor, spendItems, monthOf } from "./spend.js";
import { budgetAlertPass } from "./budget-alerts.js";
import { teammateReady } from "./teammate-work.js";
import { runOperate } from "./operate.js";

let dir: string, file: string, store: Store;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const REPO = "/repo/shop";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-spend-"));
  file = join(dir, "orders.db");
  store = openStore(file);
  const seen = store.handle.prepare(`INSERT INTO model_seen (source, id, name, input_usd, output_usd, context, tools, released_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`);
  const at = "2026-09-01T00:00:00.000Z";
  seen.run("codex", "gpt-6-astra", "GPT-6 Astra", 10, 50, "2026-08-01T00:00:00.000Z", at, at);
  seen.run("claude", "claude-sonnet-5", "Claude Sonnet 5", 3, 15, "2026-05-01T00:00:00.000Z", at, at);
  seen.run("claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "2026-08-01T00:00:00.000Z", at, at);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };
let serial = 0;
/** A task filed by `filer`, and one finished run of it. */
function work(filer: { name: string | null; kind: "person" | "coordinator" | "teammate" | "automation" }, usage: { provider?: string; model?: string | null; costUsd?: number; tokensIn?: number; tokensOut?: number }, at = NOW): { id: string; run: number } {
  const id = `t-${++serial}`;
  store.createTask({ id, title: id, filedBy: filer }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${serial}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/w/${id}`, route: { ...legacy, provider: usage.provider ?? "claude", model: usage.model ?? null }, now: at });
  if (usage.provider !== undefined || usage.model !== undefined) store.handle.prepare("UPDATE run SET provider = ?, model = ? WHERE id = ?").run(usage.provider ?? "claude", usage.model ?? null, run);
  store.recordUsage(run, { ...(usage.tokensIn === undefined ? {} : { tokensIn: usage.tokensIn }), ...(usage.tokensOut === undefined ? {} : { tokensOut: usage.tokensOut }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) });
  store.finishRun(run, { outcome: "built", now: at });
  return { id, run };
}
const spendOf = (run: number) => store.handle.prepare("SELECT microusd, source, price_model FROM run_spend WHERE run = ?").get(run);

test("every run is priced: what the provider reported, or its tokens at the catalogue price, or honestly unpriced", () => {
  const reported = work({ name: "alex", kind: "person" }, { costUsd: 1.25, tokensIn: 1, tokensOut: 1 });
  expect(spendOf(reported.run)).toMatchObject({ microusd: 1_250_000, source: "reported" });
  // Codex reports no cost: 100k tokens in at $10/M and 10k out at $50/M is $1.50.
  const estimated = work({ name: "alex", kind: "person" }, { provider: "codex", model: "gpt-6-astra", tokensIn: 100_000, tokensOut: 10_000 });
  expect(spendOf(estimated.run)).toMatchObject({ microusd: 1_500_000, source: "estimated", price_model: "gpt-6-astra" });
  // A Claude short name is priced as the newest of its family.
  expect(priceFor(store.handle, "claude", "sonnet")).toMatchObject({ model: "claude-sonnet-5-5", inputUsd: 2 });
  const unknown = work({ name: "alex", kind: "person" }, { provider: "codex", model: "gpt-unlisted", tokensIn: 5, tokensOut: 5 });
  expect(spendOf(unknown.run)).toMatchObject({ microusd: null, source: "unpriced" });
  // A price is frozen when the work is settled: a later price change doesn't rewrite last month's spend.
  store.handle.prepare("UPDATE model_seen SET input_usd = 100 WHERE id = 'gpt-6-astra'").run();
  expect(spendOf(estimated.run)).toMatchObject({ microusd: 1_500_000 });
});

test("spend counts toward the project, the person who filed it (or the person behind a coordinator), and a teammate that filed it", () => {
  store.createTeammate({ repo: REPO, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  const mate = Number(store.handle.prepare("SELECT id FROM teammate WHERE handle = 'maya'").get()!["id"]);
  work({ name: "alex", kind: "person" }, { costUsd: 1 });
  work({ name: "sam", kind: "coordinator" }, { costUsd: 2 });
  work({ name: "maya (AI)", kind: "teammate" }, { costUsd: 4 });
  work({ name: null, kind: "automation" }, { costUsd: 8 });
  store.addTeammateTurn({ teammate: mate, card: null, model: "sonnet", ok: true, ms: 10, costUsd: 0.5 }, NOW);
  store.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, deadline_at, reserved_microusd, settled_microusd) VALUES ('alex', 'k', 'openrouter-api', 'x', 'answered', ?, ?, 300000, 250000)`)
    .run(NOW.toISOString(), NOW.toISOString());
  const month = monthOf(NOW);
  const items = spendItems(store.handle, month.from, month.to);
  const sum = (pick: (item: (typeof items)[number]) => boolean) => items.filter(pick).reduce((total, item) => total + (item.microusd ?? 0), 0);
  expect(sum(item => item.project === REPO)).toBe(15_500_000);
  expect(sum(item => item.person === "alex")).toBe(1_250_000);
  expect(sum(item => item.person === "sam")).toBe(2_000_000);
  expect(sum(item => item.teammate === mate)).toBe(4_500_000);
  expect(sum(() => true)).toBe(15_750_000);
  // Last month's work isn't this month's.
  work({ name: "alex", kind: "person" }, { costUsd: 99 }, new Date("2026-08-31T23:59:59.000Z"));
  expect(spendItems(store.handle, month.from, month.to).reduce((total, item) => total + (item.microusd ?? 0), 0)).toBe(15_750_000);
});

test("a hard-stop budget used up holds new work (tasks, teammates, chats); an alerts-only one never does; the ledger keeps every change", () => {
  const alexTask = work({ name: "alex", kind: "person" }, { costUsd: 6 });
  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 10_000_000, hardStop: true }, "alex", NOW);
  const subject = store.budgetSubject(store.lookupRef(alexTask.id)!.id);
  expect(subject).toEqual({ project: REPO, person: "alex", teammate: null });
  expect(store.budgetGate(NOW)(subject)).toMatchObject({ over: null, remainingMicrousd: 4_000_000 });
  work({ name: "sam", kind: "person" }, { costUsd: 5 });
  expect(store.budgetGate(NOW)(subject).over).toMatchObject({ scope: "project", percent: 110 });
  // A teammate in the project can't take a turn; a chat about the project can't start.
  store.createTeammate({ repo: REPO, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  const mate = store.teammates([REPO])[0]!;
  expect(teammateReady(store, mate, NOW)).toEqual({ ok: false, why: "a monthly budget its work counts toward is used up" });
  // Alerts only: work carries on.
  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 10_000_000, hardStop: false }, "alex", NOW);
  expect(store.budgetGate(NOW)(subject).over).toBeNull();
  // A person's budget binds their own chats.
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 1_000_000, hardStop: true }, "alex", NOW);
  expect(store.openChatTurn({ approver: "alex", credentialKey: "k", provider: "openrouter", model: "m", reservedMicrousd: 1, dailyTurns: 99, weeklyCeilingMicrousd: 99_000_000, deadlineMs: 1000 }, NOW))
    .toEqual({ ok: false, reason: "monthly-budget" });
  const changes = store.actionLedger({ repos: null, instance: true, limit: 20 }).filter(one => one.action.startsWith("budget set")).map(one => one.detail);
  expect(changes).toEqual(expect.arrayContaining(["none → $10 a month, stops new work", "$10 a month, stops new work → $10 a month, alerts only"]));
  expect(store.removeBudget(store.budgets().find(one => one.scope === "person")!.id, "alex", NOW)).toBe(true);
  expect(store.budgets().map(one => one.scope)).toEqual(["project"]);
});

test("alerts go out at 50, 80 and 100 %, once each a month, only the highest mark newly reached; a person's to that person", () => {
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 10_000_000, hardStop: true }, "alex", NOW);
  work({ name: "alex", kind: "person" }, { costUsd: 4 });
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  work({ name: "alex", kind: "person" }, { costUsd: 2 });
  expect(budgetAlertPass(store, NOW).sent.map(one => one.mark)).toEqual([50]);
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  // A jump past both remaining marks says so once.
  work({ name: "alex", kind: "person" }, { costUsd: 5 });
  expect(budgetAlertPass(store, NOW).sent.map(one => one.mark)).toEqual([100]);
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  const sent = store.handle.prepare("SELECT subject, recipient, push_class FROM notification WHERE kind = 'budget-alert' ORDER BY id").all();
  expect(sent).toEqual([
    { subject: "alex's budget: 50% used", recipient: "alex", push_class: "attention" },
    { subject: "alex's budget: 100% used", recipient: "alex", push_class: "attention" },
  ]);
  expect(store.actionLedger({ repos: null, instance: true, limit: 20 }).find(one => one.action === "budget 100% used: alex")).toMatchObject({ outcome: "stopped", detail: "$11 of $10 in 2026-09" });
});

test("the Spend page, its CSV and budgets are an instance operator's; the task page says when a budget holds a task", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [REPO], "alex", NOW)).toEqual({ ok: true });
  work({ name: "alex", kind: "person" }, { costUsd: 3 }, new Date());
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = await (await fetch(`${base}/spend`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Spend</h1>");
    expect(page).toContain('data-spend-total="3000000"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetch(`${base}/spend/budget`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post({ target: `project:${REPO}`, usd: "2", stop: "1", action: "save", password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(store.budgets()).toEqual([]);
    expect((await post({ target: `project:${REPO}`, usd: "2", stop: "1", action: "save", password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.budgets()).toMatchObject([{ scope: "project", key: REPO, limitMicrousd: 2_000_000, hardStop: true }]);
    expect((await post({ target: "project:/somewhere/else", usd: "2", action: "save", password: alex.token })).headers.get("location")).toContain("problem=");
    const csv = await fetch(`${base}/spend?format=csv`, { headers: { cookie } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("time_utc,kind,project,person");
    // A queued task under the used-up budget says why it waits.
    store.createTask({ id: "waiting", title: "waiting", filedBy: { name: "alex", kind: "person" } }, new Date());
    store.placeTask(store.refFor("built-in", "waiting").id, REPO);
    expect(await (await fetch(`${base}/t/waiting`, { headers: { cookie } })).text()).toContain("monthly budget is used up");
    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/spend`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("the command line shows the month and sets budgets for an instance operator", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  work({ name: "alex", kind: "person" }, { costUsd: 2 }, new Date());
  store.close();
  let lines: string[] = [];
  const run = async (command: string, argv: string[]) => { lines = []; const code = await runOperate(command, argv, line => { lines.push(line); }, { databaseFile: file }); return { code, out: lines.join("\n") }; };
  try {
    expect(JSON.parse((await run("spend", ["--json"])).out)).toMatchObject({ ok: true, totalMicrousd: 2_000_000 });
    expect((await run("budget", ["set", "--person", "alex", "--usd", "50", "--json"])).code).toBe(3);
    expect((await run("budget", ["set", "--person", "alex", "--usd", "50", "--as", "alex", "--token", alex.token])).out).toContain("alex: $50 a month, new work stops at 100%.");
    expect((await run("budget", ["list"])).out).toContain("alex: $2.00 of $50 this month (4%)");
    expect((await run("spend", ["--csv"])).out.split(/\r?\n/)[0]).toBe("time_utc,kind,project,person,teammate,task,run,provider,model,tokens_in,tokens_out,cost_usd,priced_by,billing");
  } finally {
    store = openStore(file);
  }
});
