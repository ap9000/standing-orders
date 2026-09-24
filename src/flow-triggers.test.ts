/**
 * Flow triggers: what starts cards on its own — a button, a schedule,
 * GitHub, Linear, another flow, a webhook — against a real store, with
 * GitHub's `gh` and Linear's HTTPS answered by scripts. One outside thing
 * makes at most one card; outside text is checked before it becomes one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding } from "./principal.js";
import { FLOW_TEMPLATES } from "./flows.js";
import type { Runner } from "./backend.js";
import type { ExecResult } from "./exec.js";
import {
  addFlowTriggerTo, checkFlowTriggerNow, githubRepoOf, LINEAR_ENV, pressFlowButton, readHookSecret, receiveFlowHook, renewFlowHook,
  runFlowTriggers, saveHooksBase, saveLinearKey, saveLinearSigningSecret, scheduleFromWords, type TriggerIo,
} from "./flow-triggers.js";
import { createDecisionServer } from "./serve.js";
import { executeMateTool } from "./mate-tools.js";
import { confirmMateProposal } from "./mate-doors.js";
import { sharedActionPayload } from "./chat-actions.js";

const T0 = new Date("2026-09-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ok = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false, notFound: false });

let dir: string, repo: string, store: Store, password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-triggers-")));
  repo = join(dir, "shop");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  password = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const coding = () => store.createFlow({ repo, name: "Bug fixes", definitionJson: JSON.stringify(FLOW_TEMPLATES[0]!.definition), by: "alex" }, T0);
const add = (flow: number, settings: Record<string, unknown>, now = T0) => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, settings, "alex", now, dir);
  if (!made.ok) throw new Error(made.message);
  return made;
};
const cards = (flow: number) => store.flowCards(flow, true).map(card => ({ title: card.title, stage: card.stage, by: card.createdBy, source: card.source?.label ?? null })).reverse();

describe("setting up", () => {
  test("schedules in words, the project's GitHub repository, and settings refused in plain words", () => {
    expect(["every 2 hours", "every 30 minutes", "daily 09:00 Europe/London", "every day at 7:30", "monday 09:00", "weekly on friday 17:00 UTC", "daily:08:00"].map(scheduleFromWords))
      .toEqual(["every:120", "every:30", "daily:09:00@Europe/London", "daily:07:30", "weekly:1:09:00", "weekly:5:17:00", "daily:08:00"]);
    expect(scheduleFromWords("whenever")).toBeNull();
    expect(scheduleFromWords("every 2 minutes")).toBeNull();
    expect(githubRepoOf(repo)).toBe("acme/shop");
    const flow = coding();
    const refused = (settings: Record<string, unknown>) => { const made = addFlowTriggerTo(store, store.getFlow(flow)!, settings, "alex", T0, dir); return made.ok ? "added" : made.message; };
    expect(refused({ kind: "sometimes" })).toBe("Choose what starts cards: a button, a schedule, GitHub, Linear, another flow or a webhook.");
    expect(refused({ kind: "schedule", schedule: "now and then", title: "Check" })).toBe("Say the schedule like “every 2 hours”, “daily 09:00 Europe/London” or “monday 09:00”.");
    expect(refused({ kind: "linear" })).toBe("Name a Linear team or a label, so the trigger doesn't take every issue in the workspace.");
    expect(refused({ kind: "button", label: "Report", zone: "Nowhere" })).toBe("This flow has no zone called Nowhere.");
    expect(refused({ kind: "flow", flow })).toBe("A flow can't start cards in itself; move them with a zone's next step instead.");
    expect(refused({ kind: "schedule", schedule: "daily 09:00", title: `token ${["ghp", "y".repeat(36)].join("_")}` })).toBe("That looks like a key or password. Keys never go in a trigger's settings.");
    // GitHub defaults to this project's repository, people with write access, and checking every 2 minutes.
    add(flow, { kind: "github", watch: "issues" });
    expect(JSON.parse(store.flowTriggers(flow)[0]!.configJson)).toEqual({ kind: "github", repo: "acme/shop", watch: "issues", label: null, branch: null, from: "team", delivery: "poll", zone: null });
  });
});

describe("the worker's pass", () => {
  const io = (gh: Runner, fetcher: typeof fetch = vi.fn()): TriggerIo => ({ gh, fetch: fetcher, dir });

  test("a button makes a card from its answers; a schedule adds one card per slot, never piling up untouched ones", async () => {
    const flow = coding();
    add(flow, { kind: "button", label: "Report a bug", questions: ["What happened?", "Steps to reproduce", "How bad is it?"] });
    const button = store.flowTriggers(flow)[0]!;
    expect(pressFlowButton(store, button, ["", "x"], "alex", T0)).toEqual({ ok: false, message: "Answer “What happened?”." });
    expect(pressFlowButton(store, button, ["Checkout crashes", "Add two items", ""], "alex", T0)).toMatchObject({ ok: true, said: "Card added." });
    expect(store.getFlowCard(1)).toMatchObject({ title: "Checkout crashes", description: "Steps to reproduce\nAdd two items", stage: "inbox", createdBy: "alex", source: { kind: "button", label: "Report a bug" } });

    add(flow, { kind: "schedule", schedule: "daily 10:00", title: "Dependency check", zone: "Triage" });
    const gh = vi.fn<Runner>();
    expect(await runFlowTriggers(store, repo, at(30), io(gh))).toEqual({ added: 0, checked: 0, problems: [] });
    expect(await runFlowTriggers(store, repo, at(61), io(gh))).toMatchObject({ added: 1 });
    expect(cards(flow).at(-1)).toEqual({ title: "Dependency check — Sep 24", stage: "triage", by: "Schedule", source: "Schedule" });
    // Next day: the one from yesterday was picked up, so another comes.
    store.moveFlowCard(2, { to: "go-ahead", outcome: "moved", actor: "alex" }, at(120));
    expect(await runFlowTriggers(store, repo, at(24 * 60 + 61), io(gh))).toMatchObject({ added: 1 });
    // A day later the newest still sits untouched where it started: the slot is skipped, not piled up.
    expect(await runFlowTriggers(store, repo, at(2 * 24 * 60 + 61), io(gh))).toMatchObject({ added: 0 });
    expect(store.flowTriggers(flow)[1]).toMatchObject({ lastOutcome: "Skipped: the last card hasn't been picked up yet.", nextAt: "2026-09-27T10:00:00.000Z" });
    expect(gh).not.toHaveBeenCalled();
  });

  test("GitHub: new issues from the team, a label being added, failed checks — each once; outsiders and keys are left out; failures back off in words", async () => {
    const flow = coding();
    add(flow, { kind: "github", watch: "issues" });
    const later = new Date(T0.getTime() + 1000).toISOString();
    const issue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `Issue ${number}`, body: "It breaks", html_url: `https://github.com/acme/shop/issues/${number}`, user: { login: "sam" }, author_association: "MEMBER", created_at: later, updated_at: later, labels: [], ...extra });
    // gh answers by what it is asked: the newest scripted answer for that path, then an empty list.
    const scripted = new Map<string, ExecResult>();
    const gh = vi.fn<Runner>(async (_file, args) => {
      const path = String(args.at(-1));
      const key = [...scripted.keys()].find(one => path.includes(one));
      if (key === undefined) return ok(path.includes("actions/runs") ? { workflow_runs: [] } : []);
      const answer = scripted.get(key)!;
      scripted.delete(key);
      return answer;
    });
    scripted.set("/issues?", ok([
      issue(1, { created_at: "2026-09-01T00:00:00Z" }), issue(2, { pull_request: {} }), issue(3), issue(4, { author_association: "NONE" }),
      issue(5, { body: `use ${["ghp", "z".repeat(36)].join("_")}` }),
    ]));
    expect(await runFlowTriggers(store, repo, at(1), io(gh))).toMatchObject({ added: 1, checked: 1 });
    expect(gh.mock.calls[0]![1]).toEqual(["api", "-H", "Accept: application/vnd.github+json", "repos/acme/shop/issues?state=open&sort=created&direction=desc&per_page=30"]);
    expect(cards(flow)).toEqual([{ title: "Issue 3", stage: "inbox", by: "GitHub", source: "GitHub issue #3" }]);
    expect(store.getFlowCard(1)!.description).toBe("From GitHub issue #3 by @sam:\n\nIt breaks");
    expect(store.flowTriggers(flow)[0]!.lastOutcome).toBe("Added 1 card. Left out 2 items: GitHub issue #5: it looked like it held a key or password, and others.");
    // Not due yet; then due again, and the same issues make nothing new.
    expect(await runFlowTriggers(store, repo, at(2), io(gh))).toMatchObject({ checked: 0 });
    scripted.set("/issues?", ok([issue(3), issue(4, { author_association: "NONE" })]));
    expect(await runFlowTriggers(store, repo, at(4), io(gh))).toMatchObject({ added: 0, checked: 1 });
    expect(store.flowTriggers(flow)[0]!.lastOutcome).toBe("Nothing new.");

    // A label trigger follows the moment the label is added, even on an old issue.
    add(flow, { kind: "github", watch: "issues", label: "flow" }, at(10));
    scripted.set("/issues/events", ok([
      { event: "labeled", label: { name: "other" }, created_at: at(11).toISOString(), issue: issue(7) },
      { event: "labeled", label: { name: "Flow" }, created_at: at(12).toISOString(), issue: issue(8, { created_at: "2026-01-01T00:00:00Z", labels: [{ name: "flow" }] }) },
      { event: "labeled", label: { name: "flow" }, created_at: at(5).toISOString(), issue: issue(9, { labels: [{ name: "flow" }] }) },
    ]));
    await runFlowTriggers(store, repo, at(13), io(gh));
    expect(gh.mock.calls.map(call => call[1].at(-1))).toContain("repos/acme/shop/issues/events?per_page=50");
    expect(cards(flow).map(one => one.title)).toEqual(["Issue 3", "Issue 8"]);

    // Failed checks on main: one card per failing commit.
    add(flow, { kind: "github", watch: "checks" }, at(20));
    const run = (id: number, sha: string, extra: Record<string, unknown> = {}) => ({ id, name: "CI", head_sha: sha, head_branch: "main", conclusion: "failure", created_at: at(21).toISOString(), html_url: `https://github.com/acme/shop/actions/runs/${id}`, display_title: "Fix totals", ...extra });
    scripted.set("/actions/runs", ok({ workflow_runs: [run(3, "abcdef1234"), run(2, "abcdef1234", { name: "Lint" }), run(1, "0123456789", { created_at: at(19).toISOString() })] }));
    await runFlowTriggers(store, repo, at(22), io(gh));
    expect(cards(flow).at(-1)).toEqual({ title: "Checks failed on main: Lint", stage: "inbox", by: "GitHub", source: "Failed check on main" });
    expect(cards(flow)).toHaveLength(3);

    // GitHub can't be reached: the trigger says so in words and waits longer before trying again.
    const broken = store.flowTriggers(flow)[2]!;
    const failing = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)", timedOut: false, notFound: false }));
    expect(await checkFlowTriggerNow(store, broken, at(30), io(failing))).toEqual({ ok: false, said: "GitHub can't find acme/shop, or your GitHub login can't see it." });
    expect(store.getFlowTrigger(broken.id)).toMatchObject({ failures: 1, nextAt: at(35).toISOString() });
  });

  test("Linear: needs a key, asks with the trigger's filters, and makes one card per issue", async () => {
    const flow = coding();
    add(flow, { kind: "linear", team: "eng", state: "Todo" });
    const trigger = store.flowTriggers(flow)[0]!;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { issues: { nodes: [
      { identifier: "ENG-2", title: "Totals", description: "Off by a cent", url: "https://linear.app/acme/issue/ENG-2", updatedAt: at(3).toISOString(), state: { name: "Todo" }, team: { key: "ENG" }, labels: { nodes: [] } },
      { identifier: "ENG-1", title: "Wrong team", url: "u", updatedAt: at(2).toISOString(), state: { name: "Todo" }, team: { key: "OPS" }, labels: { nodes: [] } },
    ] } } }), { status: 200 }));
    expect(await checkFlowTriggerNow(store, trigger, at(1), io(vi.fn(), fetcher as unknown as typeof fetch))).toEqual({ ok: false, said: "Needs a Linear API key. Add it on this flow's Triggers panel." });
    expect(saveLinearKey(dir, "not-a-key")).toMatchObject({ ok: false });
    const key = ["lin", "api", "k".repeat(40)].join("_");
    expect(saveLinearKey(dir, key)).toEqual({ ok: true });
    expect(statSync(join(dir, "linear-key")).mode & 0o777).toBe(0o600);
    expect(await checkFlowTriggerNow(store, store.getFlowTrigger(trigger.id)!, at(10), io(vi.fn(), fetcher as unknown as typeof fetch))).toEqual({ ok: true, said: "Added 1 card." });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(key);
    expect(JSON.parse(String(init.body)).variables.filter).toEqual({ updatedAt: { gt: T0.toISOString() }, team: { key: { eqIgnoreCase: "ENG" } }, state: { name: { eqIgnoreCase: "Todo" } } });
    expect(cards(flow)).toEqual([{ title: "Totals", stage: "inbox", by: "Linear", source: "Linear ENG-2" }]);
    expect(store.getFlowTrigger(trigger.id)!.cursor).toBe(at(3).toISOString());
    const refused = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Authentication required, not authenticated" }] }), { status: 400 }));
    expect(await checkFlowTriggerNow(store, store.getFlowTrigger(trigger.id)!, at(20), io(vi.fn(), refused as unknown as typeof fetch))).toEqual({ ok: false, said: "Linear didn't accept the key. Add a new one on this flow's Triggers panel." });
  });

  test("another flow: cards reaching its zone start here, from the moment the trigger was added", async () => {
    const research = store.createFlow({ repo, name: "Research", definitionJson: JSON.stringify(FLOW_TEMPLATES[1]!.definition), by: "alex" }, T0);
    const build = coding();
    const early = store.addFlowCard({ flow: research, title: "Old answer", description: null, stage: "done", by: "alex" }, T0);
    add(build, { kind: "flow", flow: research, when: "Check" });
    expect(await runFlowTriggers(store, repo, at(1), io(vi.fn()))).toMatchObject({ added: 0 });
    const card = store.addFlowCard({ flow: research, title: "Which payment provider?", description: "Compare two", stage: "research", by: "alex" }, at(2));
    store.moveFlowCard(card, { to: "check", outcome: "ok", actor: "flow" }, at(3));
    store.moveFlowCard(early, { to: "check", outcome: "moved", actor: "alex" }, at(3));
    expect(await runFlowTriggers(store, repo, at(4), io(vi.fn()))).toMatchObject({ added: 2 });
    expect(cards(build)).toEqual([
      { title: "Which payment provider?", stage: "inbox", by: "the Research flow", source: "Research: Which payment provider?" },
      { title: "Old answer", stage: "inbox", by: "the Research flow", source: "Research: Old answer" },
    ]);
    expect(store.flowCards(build, true).find(one => one.title === "Old answer")!.source?.url).toBe(`/flows/${research}?card=${early}`);
    // Sent back and arriving again: still one card each.
    store.moveFlowCard(card, { to: "research", outcome: "sent-back", actor: "alex" }, at(5));
    store.moveFlowCard(card, { to: "check", outcome: "ok", actor: "flow" }, at(6));
    expect(await runFlowTriggers(store, repo, at(7), io(vi.fn()))).toMatchObject({ added: 0 });
  });
});

describe("webhooks", () => {
  test("GitHub's signature, Linear's signature and age, and any service's JSON — each proved, each once; a new address retires the old", () => {
    const flow = coding();
    expect(saveHooksBase(dir, "http://insecure.example")).toMatchObject({ ok: false });
    expect(saveHooksBase(dir, "https://hooks.example.com/")).toEqual({ ok: true, base: "https://hooks.example.com" });
    const github = add(flow, { kind: "github", watch: "issues", delivery: "webhook" });
    expect(github.reveal).toMatchObject({ address: expect.stringMatching(/^https:\/\/hooks\.example\.com\/hooks\/flow\/[A-Za-z0-9_-]{32}$/), secret: expect.stringMatching(/^[a-f0-9]{48}$/) });
    expect(readHookSecret(dir, github.id)).toBe(github.reveal!.secret);
    const token = github.reveal!.path.split("/").at(-1)!;
    const body = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "acme/shop" }, issue: { number: 12, title: "Crash on save", body: "Steps…", html_url: "https://github.com/acme/shop/issues/12", user: { login: "sam" }, author_association: "OWNER", labels: [] } }));
    const signed = (secret: string, raw: Buffer) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const deliver = (headers: Record<string, string>, raw: Buffer = body, address = token) => receiveFlowHook(store, address, { headers, body: raw }, dir, at(1));
    expect(deliver({ "x-github-event": "issues", "x-hub-signature-256": signed("wrong", body) })).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(deliver({ "x-github-event": "ping", "x-hub-signature-256": signed(github.reveal!.secret!, Buffer.from("{}")) }, Buffer.from("{}"))).toEqual({ status: 200, said: "Connected." });
    expect(deliver({ "x-github-event": "issues", "x-hub-signature-256": signed(github.reveal!.secret!, body) })).toEqual({ status: 202, said: "Added 1 card." });
    expect(deliver({ "x-github-event": "issues", "x-hub-signature-256": signed(github.reveal!.secret!, body) })).toEqual({ status: 202, said: "Nothing new." });
    expect(cards(flow)).toEqual([{ title: "Crash on save", stage: "inbox", by: "GitHub", source: "GitHub issue #12" }]);
    // A new address: the old one stops working at once.
    const renewed = renewFlowHook(store, store.getFlowTrigger(github.id)!, at(2), dir);
    expect(renewed).toMatchObject({ ok: true });
    expect(deliver({ "x-github-event": "ping" }, Buffer.from("{}"))).toEqual({ status: 404, said: "No such address." });

    // Linear: its own secret, pasted on the panel; stale deliveries refused.
    const linear = add(flow, { kind: "linear", team: "ENG", delivery: "webhook" });
    const linearToken = linear.reveal!.path.split("/").at(-1)!;
    const issue = (sent: number) => Buffer.from(JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: sent, data: { identifier: "ENG-9", title: "Refunds", description: "…", url: "https://linear.app/x", team: { key: "ENG" }, state: { name: "Todo" }, labels: [] } }));
    expect(receiveFlowHook(store, linearToken, { headers: {}, body: issue(at(1).getTime()) }, dir, at(1))).toEqual({ status: 401, said: "Paste Linear's signing secret on the flow's Triggers panel first." });
    expect(saveLinearSigningSecret(store.getFlowTrigger(linear.id)!, "lin_wh_secretsecretsecret", dir)).toEqual({ ok: true });
    const sign = (raw: Buffer) => createHmac("sha256", "lin_wh_secretsecretsecret").update(raw).digest("hex");
    const stale = issue(at(-10).getTime());
    expect(receiveFlowHook(store, linearToken, { headers: { "linear-signature": sign(stale) }, body: stale }, dir, at(1))).toEqual({ status: 401, said: "Too old." });
    const fresh = issue(at(1).getTime());
    expect(receiveFlowHook(store, linearToken, { headers: { "linear-signature": sign(fresh) }, body: fresh }, dir, at(1))).toEqual({ status: 202, said: "Added 1 card." });

    // Any service: the secret address is the proof; the title comes from the field named.
    const any = add(flow, { kind: "webhook", title: "Alert", titleField: "data.summary" });
    const anyToken = any.reveal!.path.split("/").at(-1)!;
    expect(receiveFlowHook(store, anyToken, { headers: { "x-request-id": "r1" }, body: Buffer.from(JSON.stringify({ data: { summary: "Error rate up" } })) }, dir, at(1))).toEqual({ status: 202, said: "Added 1 card." });
    expect(receiveFlowHook(store, anyToken, { headers: { "x-request-id": "r1" }, body: Buffer.from("{}") }, dir, at(1))).toEqual({ status: 202, said: "Nothing new." });
    expect(receiveFlowHook(store, anyToken, { headers: {}, body: Buffer.from("not json") }, dir, at(1))).toEqual({ status: 400, said: "Send JSON." });
    expect(cards(flow).map(one => [one.title, one.by])).toEqual([["Crash on save", "GitHub"], ["Refunds", "Linear"], ["Error rate up", "Webhook"]]);
  });

  test("through the console: the public address needs no sign-in, adding a trigger shows its address once, and a button starts a card", async () => {
    const flow = coding();
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const html = await (await fetch(`${base}/flows`, { headers: { cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const post = async (path: string, fields: Record<string, string>) => {
        const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf, ...fields }) });
        return { status: response.status, body: await response.json() as { ok: boolean; said: string; reveal?: { path: string; address: string | null; secret: string | null }; view?: { triggers: { id: number; words: string }[] } } };
      };
      const hook = await post(`/flows/${flow}/triggers`, { trigger: JSON.stringify({ kind: "webhook", title: "Deploy failed" }) });
      expect(hook).toMatchObject({ status: 200, body: { ok: true, said: "Trigger added. Copy its address now; it isn't shown again.", reveal: { address: null, secret: null } } });
      expect(JSON.stringify(hook.body.view)).not.toContain(hook.body.reveal!.path.split("/").at(-1)!);
      // Posted without any sign-in, as a service would.
      const delivered = await fetch(`${base}${hook.body.reveal!.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Deploy failed on web-2" }) });
      expect(delivered.status).toBe(202);
      expect(await (await fetch(`${base}/hooks/flow/${"x".repeat(32)}`, { method: "POST", body: "{}" })).json()).toEqual({ said: "No such address." });
      const button = await post(`/flows/${flow}/triggers`, { trigger: JSON.stringify({ kind: "button", label: "Report a bug", questions: ["What happened?"] }) });
      const id = button.body.view!.triggers.find(one => one.words.startsWith("The “Report a bug”"))!.id;
      expect(await post(`/flows/${flow}/triggers/${id}/press`, { answers: JSON.stringify(["Search is slow"]) })).toMatchObject({ status: 200, body: { said: "Card added." } });
      expect(await post(`/flows/${flow}/linear-key`, { key: ["lin", "api", "k".repeat(40)].join("_"), password: "wrong" })).toMatchObject({ status: 403 });
      expect(cards(flow).map(one => one.title)).toEqual(["Deploy failed on web-2", "Search is slow"]);
      expect(await (await fetch(`${base}/flows`, { headers: { cookie } })).text()).toContain(`href="/flows/${flow}?start=${id}">Report a bug</a>`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("from chat", () => {
  test("the lead adds a checked trigger as a card the operator confirms; webhook addresses stay on the panel", () => {
    const flow = coding();
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
    if (!verified.ok) throw new Error("identity");
    const who = verified.who;
    const session = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "flows", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, T0);
    const thread = store.openMateThread(who.name, who.ceilingDigest, T0).thread.id;
    const lead = (args: Record<string, unknown>) => {
      const turn = store.openMateTurn({ approver: who.name, session, thread, credentialKey: "flows", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, T0);
      if (!turn.ok) throw Error(turn.reason);
      const started = store.startMateTurn(turn.id, T0);
      if (!started.ok) throw Error("start");
      const result = executeMateTool({ store, who, now: T0, step: 1, readDecisions: new Map(), evidenceRoot: dir,
        draft: (kind, payload) => store.draftMateProposal({ thread, turn: turn.id, kind, payload, ceilingDigest: who.ceilingDigest }, T0) }, "propose_flow", args);
      store.finalizeMateTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here.", activity: "" } }, T0);
      return result;
    };
    const drafted = lead({ operation: "add_trigger", flow, settings: { kind: "github", watch: "issues", label: "bug" } });
    if (!drafted.ok) throw new Error(drafted.message);
    const proposal = (drafted.body as { proposal: number }).proposal;
    expect(sharedActionPayload(store.getMateProposal(proposal)!.payload)!.terms).toEqual([
      "GitHub issues in acme/shop labeled bug, from people with write access (checked every 2 minutes)", "Cards start in Inbox.",
      "Only what happens from now on counts; nothing already there is added.", "Work a card starts still waits for your usual approvals.",
    ]);
    expect(store.flowTriggers(flow)).toEqual([]);
    expect(confirmMateProposal(store, who, proposal, T0, { via: "telegram", evidenceRoot: dir })).toMatchObject({ ok: true, said: "Trigger added.", href: `/flows/${flow}` });
    expect(store.flowTriggers(flow)).toHaveLength(1);
    expect(lead({ operation: "add_trigger", flow, settings: { kind: "github", watch: "issues", delivery: "webhook" } })).toMatchObject({ ok: false });
    const paused = lead({ operation: "pause_trigger", trigger: store.flowTriggers(flow)[0]!.id });
    if (!paused.ok) throw new Error(paused.message);
    expect(confirmMateProposal(store, who, (paused.body as { proposal: number }).proposal, T0, { via: "telegram", evidenceRoot: dir })).toMatchObject({ ok: true, said: "Trigger paused." });
    expect(store.flowTriggers(flow)[0]!.state).toBe("paused");
  });
});

test("the Linear key can also come from the environment", async () => {
  vi.stubEnv(LINEAR_ENV, ["lin", "api", "e".repeat(40)].join("_"));
  const flow = coding();
  add(flow, { kind: "linear", label: "flow" });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200 }));
  expect(await checkFlowTriggerNow(store, store.flowTriggers(flow)[0]!, at(1), { gh: vi.fn(), fetch: fetcher as unknown as typeof fetch, dir })).toEqual({ ok: true, said: "Nothing new." });
});
