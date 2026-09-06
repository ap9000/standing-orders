import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover } from "./scope.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-chat-journey-")));
  const repos = ["Website", "Mobile app"].map(name => { const repo = join(root, name); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); return repo; });
  const store = openStore(":memory:"); const account = addApprover(store, "tester", new Date()); if (!account.ok) throw Error("fixture");
  store.setApprovalPasswordRequired("tester", false, new Date());
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "fixture", new Date());
  let connected = true; let answer = { chatEnvelope: 1, reply: "Which project should I use: r1 or r2?", proposals: [] as object[] };
  const prompts: string[] = []; let onRecheck: (() => void) | undefined; let replied = false;
  const server = createDecisionServer({ store, repos, evidenceRoot: root, connectionHome: root, chatEnv: {},
    connectionProbe: async () => { if (replied) onRecheck?.(); return { code: connected ? 0 : 1, stdout: JSON.stringify({ loggedIn: connected, authMethod: "claude.ai" }), stderr: "", notFound: false, timedOut: false }; },
    chatRunner: async (_file, _args, options) => { prompts.push(options?.input ?? ""); replied = true; return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(answer), total_cost_usd: .01, usage: { input_tokens: 20, output_tokens: 10 } }), stderr: "", timedOut: false, notFound: false }; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "tester", token: account.token }), redirect: "manual" }); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const window = new Window(); const parse = (html: string) => { window.document.body.innerHTML = html; return window.document; };
  const get = async (path = "/chat") => fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const post = async (path: string, data: Record<string,string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(data), redirect: "manual" });
  const fields = (html: string, action: string) => { const form = parse(html).querySelector(`form[action="${action}"]`); if (!form) throw Error(`Missing ${action}`); return Object.fromEntries([...form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>("input[name],textarea[name]")].map(one => [one.name, one.value])); };
  const settled = async () => { for (let i=0;i<50;i++) { if (store.liveMateTurnFor("tester") === null) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error("turn did not settle"); };
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, repos, get, post, parse, fields, settled, close, prompts, token: account.token, setRecheck: (fn: () => void) => { onRecheck = fn; }, setConnected: (value: boolean) => { connected = value; }, setAnswer: (value: typeof answer) => { answer = value; } };
}

test("all-project chat opens directly and the first message uses the connected account without a separate start ceremony", async () => {
  const f = await fixture(); try {
    const response = await f.get(); expect(response.status).toBe(200); const html = await response.text();
    expect(f.parse(html).querySelector('textarea[name="message"]')).not.toBeNull();
    expect(f.parse(html).querySelector('input[name="token"]:not([type="hidden"])')?.closest("details")).not.toBeNull();
    const fields = f.fields(html, "/chat");
    expect((await f.post("/chat", { ...fields, csrf: "forged", message: "Hello" })).status).toBe(403); expect(f.prompts).toHaveLength(0);
    expect((await f.post("/chat", { ...fields, message: "Add a contact form" })).status).toBe(303); await f.settled();
    const replied = await (await f.get()).text(); expect(replied).toContain("Which project should I use: Website or Mobile app?");
    expect(f.store.listTasks()).toHaveLength(0);
    const csrf = f.fields(replied, "/chat").csrf!;
    expect((await f.post("/chat/focus", { csrf, repo: f.repos[0]! })).status).toBe(303);
    const focused = await (await f.get()).text(); expect(focused).toContain("Add a contact form");
    expect(f.parse(focused).querySelector('.chat-chip[aria-current="true"]')?.textContent).toBe("Website");
    expect((await f.post("/chat/focus", { csrf, repo: "/outside" })).status).toBe(400);
    f.setConnected(false); const offline = await (await f.get("/chat?check-connection=1")).text(); expect(offline).toContain("Add a contact form"); expect(offline).toContain("Check again"); expect(f.parse(offline).querySelector('textarea[name="message"]')).toBeNull();
    f.setConnected(true); expect((await (await f.get("/chat?check-connection=1")).text())).toContain("Add a contact form");
  } finally { await f.close(); }
});

test("a chat suggestion becomes one unapproved task, returns its review, and preserves the conversation", async () => {
  const f = await fixture(); try {
    f.setAnswer({ chatEnvelope: 1, reply: "Review this task for r1.", proposals: [{ kind: "task", repoId: "r1", title: "Add a contact form", goal: "Add name, email and message fields.", outOfScope: "Keep navigation unchanged.", touches: [] }] });
    const fields = f.fields(await (await f.get()).text(), "/chat"); await f.post("/chat", { ...fields, message: "Add a contact form to Website" }); await f.settled();
    const page = await (await f.get()).text(); expect(f.store.listTasks()).toHaveLength(0);
    const action = f.parse(page).querySelector('form[action$="/confirm"]')!.getAttribute("action")!;
    const confirmation = f.fields(page, action); expect((await f.post(action, confirmation)).status).toBe(303); expect(f.store.listTasks()).toHaveLength(1);
    await f.post(action, confirmation); expect(f.store.listTasks()).toHaveLength(1);
    const task = f.store.listTasks()[0]!; const scope = f.store.getScope(task.id)!; expect(scope).toMatchObject({ approvedAt: null, outOfScope: "Keep navigation unchanged." });
    const reviewPath = `/t/${task.id}`; const review = await (await f.get(reviewPath)).text(); const approval = f.fields(review, reviewPath + "/approve");
    expect((await f.post(reviewPath + "/approve", approval)).status).toBe(303); expect(f.store.getScope(task.id)?.approvedAt).not.toBeNull();
    const returned = await (await f.get()).text(); expect(returned).toContain("Add a contact form to Website"); expect(returned).not.toContain("still needs your approval");
    const statusBefore = await (await f.get("/chat?fragment=chat-status")).text();
    register(f.store, { name: "fixture", host: "here", repos: f.repos, now: new Date(), newToken: () => "fixture-token" });
    const ref = f.store.lookupRef(task.id)!;
    const claim = acquire(f.store, ref.id, "fixture", { token: "fixture-token", now: new Date(), ttlMs: 3_600_000 });
    if (!claim.ok) throw Error("fixture claim");
    const run = f.store.startRun({ taskRef: ref.id, leaseId: claim.claim.leaseId, runner: "fixture", branch: "standing-orders/chat", worktree: join(f.repos[0]!, "test-worktree"), now: new Date() });
    expect(await (await f.get("/chat?fragment=chat-status")).text()).not.toBe(statusBefore);
    expect(f.parse(await (await f.get()).text()).querySelector('.chat-progress')?.textContent).toContain("Running");
    f.store.finishRun(run, { outcome: "built", committed: true, now: new Date() }); f.store.setTaskState(task.id, "done", new Date());
    const completed = f.parse(await (await f.get()).text()).querySelector('.chat-progress')?.textContent;
    expect(completed).toContain("Built locally"); expect(completed).toContain("Review result");
    expect(f.prompts[0]).toContain("r1"); expect(f.prompts[0]).not.toContain(f.repos[0]);
  } finally { await f.close(); }
});


test("revocation during the post-answer account check discards the answer", async () => {
  const f = await fixture(); try {
    expect(addApprover(f.store, "backup", new Date(), { name: "tester", token: f.token }).ok).toBe(true);
    f.setRecheck(() => { f.store.revokeAccount("tester", "backup", new Date()); });
    const fields = f.fields(await (await f.get()).text(), "/chat");
    await f.post("/chat", { ...fields, message: "Summarize my projects" }); await f.settled();
    const turn = f.store.recentMateTurns("tester", 1)[0]!;
    expect(turn.state).toBe("failed"); expect(f.store.listTasks()).toHaveLength(0);
    expect(f.store.listMateMessages(turn.thread, 40).some(message => message.role === "assistant")).toBe(false);
  } finally { await f.close(); }
});
