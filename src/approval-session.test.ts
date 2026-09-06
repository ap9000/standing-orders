import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { addApprover, authenticateApprover, authenticateAccount, approve, hashPassword } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { sessionApprovalAllowed, withSessionApproval } from "./approval-session.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});

test("session confirmations are bounded to a real principal, account generation, preference, store, and request lifetime", async () => {
  const store = openStore(":memory:"); const other = openStore(":memory:"); const now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw new Error("fixture");
  const actor = verifyApproverStanding(store, "alex", 1, []); if (!actor.ok) throw new Error("principal");
  try {
    expect(store.approvalPasswordRequired("alex")).toBe(true);
    await expect(withSessionApproval(store, actor.who, async () => true)).rejects.toThrow();
    store.setApprovalPasswordRequired("alex", false, now);
    await expect(withSessionApproval(store, { ...actor.who } as VerifiedApprover, async () => true)).rejects.toThrow();
    expect(authenticateApprover(store, "alex", "").ok).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let detached!: Promise<boolean>;
    await withSessionApproval(store, actor.who, async () => {
      detached = gate.then(() => sessionApprovalAllowed(store, "alex"));
    });
    release();
    expect(await detached).toBe(false); // The inherited async context cannot outlive its request.
    await withSessionApproval(store, actor.who, async () => {
      expect(authenticateApprover(store, "alex", "").ok).toBe(true);
      expect(authenticateAccount(store, "alex", "").ok).toBe(false); // Sign-in never borrows confirmation authority.
      expect(authenticateApprover(store, "alex", "wrong").ok).toBe(false);
      expect(sessionApprovalAllowed(store, "someone-else")).toBe(false);
      expect(sessionApprovalAllowed(other, "alex")).toBe(false);
      store.setApprovalPasswordRequired("alex", true, now);
      expect(authenticateApprover(store, "alex", "").ok).toBe(false);
      store.setApprovalPasswordRequired("alex", false, now);
      store.saveApprover("alex", hashPassword("a new password"), now);
      expect(authenticateApprover(store, "alex", "").ok).toBe(false);
    });
    expect(sessionApprovalAllowed(store, "alex")).toBe(false);
  } finally { store.close(); other.close(); }
});

test("first setup and settings share a durable per-account choice; approvals still require a live session and exact review", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-approval-preference-"))); const repo = join(root, "project"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  const file = join(root, "orders.db"); const store = openStore(file); const now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw new Error("fixture");
  addApprover(store, "other-person", now, { name: "alex", token: added.token });
  const server = createDecisionServer({ store, repos: [repo], evidenceRoot: join(root, "evidence") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const window = new Window();
  const parse = (html: string) => { window.document.body.innerHTML = html; return window.document; };
  const fields = (html: string, selector: string) => {
    const form = parse(html).querySelector(selector); if (!form) throw new Error(`Missing ${selector}`);
    return new URLSearchParams([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name], select[name]")]
      .filter(field => field.type !== "checkbox" || (field as HTMLInputElement).checked).map(field => [field.name, field.value]));
  };
  try {
    const login = async () => {
      const response = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual" });
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookie = await login(); const secondCookie = await login();
    const get = async (path: string, who = cookie) => (await fetch(base + path, { headers: { cookie: who } })).text();
    const post = (path: string, body: URLSearchParams, who = cookie) => fetch(base + path, { method: "POST", body, headers: { cookie: who, origin: base }, redirect: "manual" });
    const setupPage = await get("/control"); expect(parse(setupPage).querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
    const setup = fields(setupPage, 'form[action="/control/setup-preview"]'); setup.delete("approval-password");
    const preview = await post("/control/setup-preview", setup); expect(preview.status).toBe(200);
    const review = await preview.text(); expect(review).toContain("Approval passwords: Off"); expect(review).toContain("Confirm once with your password");
    const confirm = fields(review, 'form[action="/control/setup-approve"]');
    expect(store.approvalPasswordRequired("alex")).toBe(true);
    const tampered = new URLSearchParams(confirm); tampered.set("approval-password-mode", "required"); tampered.set("token", added.token);
    expect((await post("/control/setup-approve", tampered)).status).toBe(409);
    const reviewedAgain = await (await post("/control/setup-preview", setup)).text();
    const confirmed = fields(reviewedAgain, 'form[action="/control/setup-approve"]'); confirmed.set("token", added.token);
    expect((await post("/control/setup-approve", confirmed)).status).toBe(303);
    expect(store.approvalPasswordRequired("alex")).toBe(false);
    expect(store.approvalPasswordRequired("other-person")).toBe(true);
    const persisted = openStore(file); expect(persisted.approvalPasswordRequired("alex")).toBe(false); persisted.close();
    const settings = await get("/settings", secondCookie);
    expect(parse(settings).querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(false);
    const repeatSetup = await (await post("/control/setup-preview", fields(await get("/control"), 'form[action="/control/setup-preview"]'))).text();
    expect(parse(repeatSetup).querySelector('form[action="/control/setup-approve"] input[type="password"]')).toBeNull();
    expect((await post("/control/setup-approve", fields(repeatSetup, 'form[action="/control/setup-approve"]'))).status).toBe(200);
    const taskFields = fields(await get("/tasks/new"), 'form[action="/tasks/add"]'); taskFields.set("title", "A task to approve"); taskFields.set("request", "An explicit outcome");
    const created = await post("/tasks/add", taskFields); const taskPath = created.headers.get("location")!;
    let taskPage = await get(taskPath); const taskId = decodeURIComponent(taskPath.split("/").pop()!);
    const approval = fields(taskPage, `form[action="${taskPath}/approve"]`);
    expect(parse(taskPage).querySelector(`form[action="${taskPath}/approve"] input[type="password"]`)).toBeNull();
    expect(approve(store, taskId, "alex", now, approval.get("digest")!, "").ok).toBe(false);
    const brokenCsrf = new URLSearchParams(approval); brokenCsrf.set("csrf", "wrong");
    expect((await post(taskPath + "/approve", brokenCsrf)).status).toBe(403); expect(store.getScope(taskId)?.approvedAt).toBeNull();
    const changedDigest = new URLSearchParams(approval); changedDigest.set("digest", "stale");
    expect((await post(taskPath + "/approve", changedDigest)).status).toBe(409); expect(store.getScope(taskId)?.approvedAt).toBeNull();
    taskPage = await get(taskPath);
    const fresh = fields(taskPage, `form[action="${taskPath}/approve"]`);
    expect((await post(taskPath + "/approve", fresh)).status).toBe(303);
    expect(store.getScope(taskId)?.approvalBasis).toBe("session");
    expect((await post(taskPath + "/approve", fresh)).status).toBe(409);
    const newRoutine = fields(await get("/routines"), 'form[action="/tasks/add"]');
    newRoutine.set("request", "Refresh the notes"); newRoutine.set("repeat", "daily"); newRoutine.set("time", "03:30"); newRoutine.set("timezone", "UTC");
    const routineMade = await post("/tasks/add", newRoutine); expect(routineMade.status).toBe(303);
    const routinePath = routineMade.headers.get("location")!;
    const routineReview = await get(routinePath);
    expect(parse(routineReview).querySelector('input[name="token"][type="password"]')).toBeNull();
    expect((await post(routinePath + "/approve", fields(routineReview, `form[action="${routinePath}/approve"]`))).status).toBe(303);
    const runNowPage = await get(routinePath);
    expect(parse(runNowPage).querySelector('input[name="token"][type="password"]')).toBeNull();
    const runNow = fields(runNowPage, `form[action="${routinePath}/run-now"]`);
    expect((await post(routinePath + "/run-now", runNow)).status).toBe(303);
    // Another signed-in browser can turn it back on; stale passwordless forms stop working immediately.
    const on = fields(settings, 'form[action="/settings/approval-password"]'); on.set("approval-password", "required");
    expect((await post("/settings/approval-password", on, secondCookie)).status).toBe(303);
    expect(store.approvalPasswordRequired("alex")).toBe(true);
    expect((await post(routinePath + "/run-now", runNow)).status).toBe(400);
    expect(parse(await get("/control")).querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
    const unauthorizedOff = fields(await get("/settings"), 'form[action="/settings/approval-password"]'); unauthorizedOff.delete("approval-password");
    expect((await post("/settings/approval-password", unauthorizedOff)).status).toBe(403); expect(store.approvalPasswordRequired("alex")).toBe(true);
    unauthorizedOff.set("token", added.token);
    const saved = await post("/settings/approval-password", unauthorizedOff); expect(saved.status).toBe(303);
    expect(await get(saved.headers.get("location")!)).toContain("Approval preference saved.");
    expect(store.approvalPasswordRequired("alex")).toBe(false);
    // A preference does not make a revoked or signed-out browser an approver.
    const before = store.listTasks().length;
    expect(store.revokeAccount("alex", "other-person", now).ok).toBe(true);
    const revoked = await post(routinePath + "/run-now", runNow);
    expect([302, 303, 401, 403]).toContain(revoked.status);
    expect(store.listTasks()).toHaveLength(before);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("upgrading a database adds approval preferences without changing existing accounts", () => {
  const root = mkdtempSync(join(tmpdir(), "so-approval-upgrade-")); const file = join(root, "orders.db");
  try {
    const before = openStore(file); const now = new Date();
    const added = addApprover(before, "alex", now); if (!added.ok) throw new Error("fixture");
    before.raw().exec("DROP TABLE approval_preference");
    before.raw().prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION - 1);
    before.close();
    const after = openStore(file);
    try {
      expect(after.approvalPasswordRequired("alex")).toBe(true);
      expect(authenticateApprover(after, "alex", added.token).ok).toBe(true);
      after.setApprovalPasswordRequired("alex", false, now);
      expect(after.approvalPasswordRequired("alex")).toBe(false);
      expect(after.schemaCurrent()).toBe(true);
    } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
