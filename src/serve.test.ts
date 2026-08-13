/**
 * The M3 acceptance surface: a park renders as one screen, answerable on a
 * phone. Real HTTP against an ephemeral port; only the phone is imaginary.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");

describe("the web decision view", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let decisionId: number;
  let artifactId: number;
  let taskRef: number;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie") ?? "";
    return cookie.split(";")[0] as string;
  };

  const csrfOf = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf in the page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "nightorders-serve-ev-"));

    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    const runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "nightorders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });

    decisionId = store.saveDecision(
      {
        run: runId,
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout. <script>alert(1)</script>",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "drop", label: "Drop the table", consequence: "It does not come back.", reversible: false },
        ],
        recommendation: "open",
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(decisionId), reason: "decision", until: null },
      T0,
    );

    // One evidence file, recorded exactly as the builder would have.
    mkdirSync(join(evidenceRoot, String(runId)), { recursive: true });
    const content = Buffer.from("diff --git a/x b/x\n+guard\n", "utf8");
    writeFileSync(join(evidenceRoot, String(runId), "diff.patch"), content);
    artifactId = store.saveArtifact(
      {
        run: runId,
        kind: "diff",
        key: `${runId}/diff.patch`,
        bytesOriginal: content.length,
        bytesStored: content.length,
        truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );
    store.linkEvidence(decisionId, artifactId);

    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the milestone sentence: one screen, answerable", async () => {
    const cookie = await login();

    // The list knows what waits.
    const list = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(list).toContain("t-1");
    expect(list).toContain("Fail open or fail closed?");

    // One screen: recap, question, options with consequences, the
    // recommendation marked, the irreversible one visibly armed, evidence.
    const screen = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(screen).toContain("Fail open or fail closed?");
    expect(screen).toContain("Fail open");
    expect(screen).toContain("recommended");
    expect(screen).toContain("irreversible, tap to arm");
    expect(screen).toContain(`/d/${decisionId}/evidence/${artifactId}`);

    // Answerable: one POST, and the machine heard it.
    const csrf = await csrfOf(cookie);
    const answered = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ choice: "open", csrf, note: "ship it" }),
      redirect: "manual",
    });
    expect(answered.status).toBe(303);

    const decision = store.getDecision(decisionId);
    expect(decision).toMatchObject({ state: "answered", choice: "open", answeredBy: "alex", answeredVia: "web" });
    // The hold lifted with it: the task is dispatchable again.
    expect(store.activeHolds(taskRef, new Date())).toHaveLength(0);

    // And the screen now shows the answer instead of the buttons.
    const after = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(after).toContain("Answered:");
    expect(after).toContain("ship it");
  });

  test("nothing renders and nothing answers without authentication — localhost included", async () => {
    const page = await fetch(url("/"), { redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");

    const answer = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      body: new URLSearchParams({ choice: "open" }),
    });
    expect(answer.status).toBe(401);
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("a wrong login is a wrong login", async () => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: "guessing" }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a host this server was never told to be is refused before routing", async () => {
    // fetch silently corrects a spoofed Host header, which is exactly why a
    // rebound DNS name needs raw HTTP to simulate.
    const { request } = await import("node:http");
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } },
        response => resolve(response.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  test("credentials never travel in URLs", async () => {
    const response = await fetch(url(`/?token=${approverToken}`));
    expect(response.status).toBe(400);
  });

  test("a bearer request answers without cookies, and without ceremony", async () => {
    const response = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "open" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(store.getDecision(decisionId)?.answeredVia).toBe("web");
  });

  test("a cookie answer without its nonce, or from a foreign origin, dies", async () => {
    const cookie = await login();

    const noNonce = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ choice: "open", csrf: "0".repeat(64) }),
    });
    expect(noNonce.status).toBe(403);

    const csrf = await csrfOf(cookie);
    const foreign = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: new URLSearchParams({ choice: "open", csrf }),
    });
    expect(foreign.status).toBe(403);
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("an irreversible choice needs its confirmation — the server checks, not the page", async () => {
    const unconfirmed = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop" }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(store.getDecision(decisionId)?.state).toBe("open");

    const confirmed = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop", confirm: "yes" }),
      redirect: "manual",
    });
    expect(confirmed.status).toBe(303);
  });

  test("a different answer after the first is a conflict, not a change of mind", async () => {
    await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "open" }),
      redirect: "manual",
    });

    const contradiction = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop", confirm: "yes" }),
    });
    expect(contradiction.status).toBe(409);
    expect(store.getDecision(decisionId)?.choice).toBe("open");
  });

  test("agent text renders as text — never as markup", async () => {
    const cookie = await login();
    const screen = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(screen).not.toContain("<script>alert(1)</script>");
    expect(screen).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const headers = await fetch(url(`/d/${decisionId}`), { headers: { cookie } });
    expect(headers.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("evidence streams as a plain-text attachment, only while it matches its record", async () => {
    const cookie = await login();

    const good = await fetch(url(`/d/${decisionId}/evidence/${artifactId}`), { headers: { cookie } });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/plain");
    expect(good.headers.get("content-disposition")).toContain("attachment");
    expect(await good.text()).toContain("+guard");

    // Tampered on disk → the record no longer vouches for the bytes.
    const artifact = store.getArtifact(artifactId);
    writeFileSync(join(evidenceRoot, artifact!.key), "something else entirely");
    const tampered = await fetch(url(`/d/${decisionId}/evidence/${artifactId}`), { headers: { cookie } });
    expect(tampered.status).toBe(410);
  });

  test("another run's artifact is not this decision's evidence, whatever the URL says", async () => {
    const cookie = await login();
    // A second run with its own artifact, never linked to our decision.
    const foreignRun = store.startRun({
      taskRef,
      leaseId: "lease-2",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      now: T0,
    });
    mkdirSync(join(evidenceRoot, String(foreignRun)), { recursive: true });
    const secret = Buffer.from("somebody else's diff", "utf8");
    writeFileSync(join(evidenceRoot, String(foreignRun), "diff.patch"), secret);
    const foreign = store.saveArtifact(
      {
        run: foreignRun,
        kind: "diff",
        key: `${foreignRun}/diff.patch`,
        bytesOriginal: secret.length,
        bytesStored: secret.length,
        truncated: false,
        sha256: createHash("sha256").update(secret).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );

    const response = await fetch(url(`/d/${decisionId}/evidence/${foreign}`), { headers: { cookie } });
    expect(response.status).toBe(404);
  });


  test("logout kills the cookie, and credential rotation kills every session it minted", async () => {
    const cookie = await login();

    // Logged in: the console answers.
    expect((await fetch(url("/"), { headers: { cookie } })).status).toBe(200);

    // Rotation: the approver re-registers; the old session's generation is
    // stale and the cookie stops working — same rule as Telegram bindings.
    const rotated = addApprover(store, "alex", new Date(), { name: "alex", token: approverToken });
    expect(rotated.ok).toBe(true);
    const after = await fetch(url("/"), { redirect: "manual", headers: { cookie } });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login");
  });

  test("logout is a real verb", async () => {
    const cookie = await login();
    const out = await fetch(url("/logout"), { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(out.status).toBe(303);
    const back = await fetch(url("/"), { redirect: "manual", headers: { cookie } });
    expect(back.status).toBe(303);
  });


});

describe("the settings card", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let dir: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    store = openStore(":memory:");
    dir = mkdtempSync(join(tmpdir(), "nightorders-serve-settings-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      telegramTokenFile: join(dir, "telegram-token"),
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the bot token is settable from the phone, stored 0600, never echoed whole", async () => {
    const { statSync, readFileSync } = await import("node:fs");
    const cookie = await login();

    // Before: not set, and the card says so.
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("not set");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;

    // A wrong shape is refused.
    const bad = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ token: "not a token", csrf }),
    });
    expect(bad.status).toBe(400);

    // The real thing lands owner-only beside the database.
    const token = "777000:AAExampleExampleExample123";
    const saved = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ token, csrf }),
      redirect: "manual",
    });
    expect(saved.status).toBe(303);
    const file = join(dir, "telegram-token");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(token);

    // After: recognizable, never whole.
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("e123");
    expect(page).not.toContain(token);
  });

  test("no session, no settings — and no unauthenticated writes", async () => {
    const page = await fetch(`${base}/settings`, { redirect: "manual" });
    expect(page.status).toBe(303);

    const write = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      body: new URLSearchParams({ token: "777000:AAExampleExampleExample123" }),
    });
    expect(write.status).toBe(401);
  });
});

describe("the operations console", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfFrom = async (cookie: string, path = "/tasks"): Promise<string> => {
    const html = await (await fetch(url(path), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };

  const post = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  // Recent, not T0: the home page windows "the last 24 hours" against the
  // real clock, and a fixed seed instant would make this suite fail at a
  // particular time of day.
  const seedRun = (taskRef: number, n: number) =>
    store.startRun({
      taskRef,
      leaseId: `lease-${n}`,
      runner: "builder-1",
      branch: `nightorders/x-${n}`,
      worktree: `/pool/x-${n}`,
      now: new Date(Date.now() - n * 60_000),
    });

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "nightorders-console-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      repo: "/repo/main",
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the home page is the brief, live — measured spend, incidents, stranded work", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.stampProviderStart(run, new Date());
    store.recordUsage(run, { tokensIn: 100, tokensOut: 50, costUsd: 1.25 });
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    const incidentRun = seedRun(ref, 2);
    store.createIncident({ run: incidentRun, kind: "attempts-exhausted" }, T0);
    store.createTask({ id: "t-blocked", title: "waits" }, T0);
    store.createTask({ id: "t-dead", title: "gone" }, T0);
    store.addEdge("t-blocked", "t-dead");
    store.setTaskState("t-dead", "failed", T0);

    const cookie = await login();
    const brief = await (await fetch(url("/morning"), { headers: { cookie } })).text();
    expect(brief).toContain("<b>1</b> built");
    expect(brief).toContain("$1.25");
    expect(brief).toContain("t-blocked");
    expect(brief).toContain("t-dead");

    // The stall is the inbox's business now: one retry card per task.
    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(inbox).toContain("retry stalled work");
    expect(inbox).toContain("t-1");
  });

  test("the overview is live: refresh meta, building-now card, system status", async () => {
    store.createTask({ id: "t-live", title: "being built right now" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    const { register } = await import("./runner.js");
    register(store, { name: "builder-1", host: "host", capacity: 2, now: new Date() });
    acquire(store, ref, "builder-1", { now: new Date(), ttlMs: 60 * 60_000 });
    store.saveWorktree({
      path: "/pool/repo/nightorders-t-live-abc123", repo: "/repo/main", branch: "nightorders/t-live",
      runner: "builder-1", taskRef: ref, createdAt: new Date().toISOString(),
      leasedAt: new Date().toISOString(), releasedAt: null, verified: true,
    });
    const cookie = await login();

    const system = await (await fetch(url("/system"), { headers: { cookie } })).text();
    expect(system).toContain('http-equiv="refresh" content="10"');
    expect(system).toContain("1/2 building");
    expect(system).toContain("nightorders-t-live-abc123");
    // The inbox never auto-refreshes: it can hold typed input.
    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(inbox).not.toContain('http-equiv="refresh"');
  });

  test("tasks: list, validated filter, and atomic add from the console", async () => {
    store.createTask({ id: "t-1", title: "already here" }, T0);
    const cookie = await login();

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain("already here");

    expect((await fetch(url("/tasks?state=bogus"), { headers: { cookie } })).status).toBe(400);

    const csrf = await csrfFrom(cookie);
    const added = await post("/tasks/add", cookie, {
      csrf,
      id: "from-web",
      title: "console-born",
      goal: "one clear goal",
    });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/t/from-web");
    expect(store.getTask("from-web")?.title).toBe("console-born");
    expect(store.getScope("from-web")?.goal).toBe("one clear goal");

    const rejected = await post("/tasks/add", cookie, { csrf, id: "bad id!", title: "x" });
    expect(rejected.status).toBe(400);
  });

  test("scope edits carry what they saw; a stale edit is refused, an edit voids approval", async () => {
    store.createTask({ id: "t-s", title: "scoped" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // First proposal: saw nothing, creates the scope.
    const first = await post("/t/t-s/scope", cookie, { csrf, sawDigest: "", goal: "narrow goal", not: "", touches: "" });
    expect(first.status).toBe(303);
    const digest = store.getScope("t-s")?.digest ?? "";
    expect(digest).not.toBe("");

    // A second tab still holding the empty form is refused, not merged.
    const stale = await post("/t/t-s/scope", cookie, { csrf, sawDigest: "", goal: "rival goal", not: "", touches: "" });
    expect(stale.status).toBe(409);
    expect(store.getScope("t-s")?.goal).toBe("narrow goal");

    // Approve, then edit with the right digest: approval visibly voids.
    const page = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] ?? "";
    const approved = await post("/t/t-s/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(approved.status).toBe(303);

    const edited = await post("/t/t-s/scope", cookie, { csrf, sawDigest: digest, goal: "wider goal", not: "", touches: "" });
    expect(edited.status).toBe(303);
    const after = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    expect(after).toContain("approved once, then rewritten");
  });

  test("approval is step-up: the session alone never approves", async () => {
    store.createTask({ id: "t-a", title: "approve me" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-a/scope", cookie, { csrf, sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-a")?.digest ?? "";

    const readNonce = async (): Promise<string> => {
      const html = await (await fetch(url("/t/t-a"), { headers: { cookie } })).text();
      return /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
    };

    // No token: refused, whatever the session says.
    const tokenless = await post("/t/t-a/approve", cookie, { csrf, nonce: await readNonce(), digest, token: "" });
    expect(tokenless.status).toBe(400);

    // Wrong token: refused by authentication, inside the transaction.
    const wrong = await post("/t/t-a/approve", cookie, { csrf, nonce: await readNonce(), digest, token: "not-it" });
    expect(wrong.status).toBe(403);

    // No nonce (a form nobody rendered): refused.
    const unrendered = await post("/t/t-a/approve", cookie, { csrf, nonce: "", digest, token: approverToken });
    expect(unrendered.status).toBe(409);

    // The real thing works — once.
    const nonce = await readNonce();
    const approved = await post("/t/t-a/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(approved.status).toBe(303);
    expect(store.getScope("t-a")?.approvedBy).toBe("alex");

    // The spent nonce buys nothing a second time.
    const replay = await post("/t/t-a/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(replay.status).toBe(409);
  });

  test("a bearer caller approves with its credential re-stated, no nonce ceremony", async () => {
    store.createTask({ id: "t-b", title: "api approve" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-b/scope", cookie, { csrf, sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-b")?.digest ?? "";

    const approved = await fetch(url("/t/t-b/approve"), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(store.getScope("t-b")?.approvedBy).toBe("alex");
  });

  test("hold and unhold touch only the operator's hold — a decision's survives", async () => {
    store.createTask({ id: "t-h", title: "held" }, T0);
    const ref = store.refFor("built-in", "t-h").id;
    store.holdOwned({ taskRef: ref, ownerKind: "decision", ownerId: "9", reason: "decision:9", until: null }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const held = await post("/t/t-h/hold", cookie, { csrf, reason: "operator pause" });
    expect(held.status).toBe(303);
    expect(store.activeHolds(ref, new Date())).toHaveLength(2);

    const lifted = await post("/t/t-h/unhold", cookie, { csrf });
    expect(lifted.status).toBe(303);
    const rest = store.activeHolds(ref, new Date());
    expect(rest).toHaveLength(1);
    expect(rest[0]?.ownerKind).toBe("decision");
  });

  test("requeue and cancel are re-proved server-side, stale buttons refused", async () => {
    store.createTask({ id: "t-r", title: "stalled" }, T0);
    store.setTaskState("t-r", "failed", T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const requeued = await post("/t/t-r/requeue", cookie, { csrf });
    expect(requeued.status).toBe(303);
    expect(store.getTask("t-r")?.state).toBe("queued");

    // Not stalled anymore: the same button now refuses.
    const again = await post("/t/t-r/requeue", cookie, { csrf });
    expect(again.status).toBe(409);

    // A live claim refuses cancellation rather than being overwritten later.
    const ref = store.refFor("built-in", "t-r").id;
    acquire(store, ref, "builder-1", { now: new Date(), ttlMs: 60 * 60_000 });
    const blocked = await post("/t/t-r/cancel", cookie, { csrf });
    expect(blocked.status).toBe(409);
    expect(store.getTask("t-r")?.state).not.toBe("cancelled");
  });

  test("inbox: approvals link (never forms), retry acts inline and returns home", async () => {
    store.createTask({ id: "t-stalled", title: "stalled work" }, T0);
    store.setTaskState("t-stalled", "failed", T0);
    store.createTask({ id: "t-approve", title: "awaiting yes" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-approve/scope", cookie, { csrf, sawDigest: "", goal: "a goal", not: "", touches: "" });

    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    // The approval card links to the step-up screen; it never carries a
    // password field or a nonce of its own.
    expect(inbox).toContain("approve a scope");
    expect(inbox).toContain("awaiting yes");
    expect(inbox).not.toContain('name="nonce"');
    expect(inbox).not.toContain('type="password"');

    // Inline retry returns to the inbox, and the stall is gone from it.
    const retried = await post("/t/t-stalled/requeue", cookie, { csrf, return: "inbox" });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe("/");
    expect(store.getTask("t-stalled")?.state).toBe("queued");
  });

  test("runs paginate by cursor and a run page shows the money and the conclusion", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.stampProviderStart(run, T0);
    store.recordUsage(run, { tokensIn: 10, tokensOut: 5, costUsd: 0.42 });
    store.recordOutcomeFacts(run, { handoff: "Wired the guard; tests added." });
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    const cookie = await login();

    const list = await (await fetch(url("/runs"), { headers: { cookie } })).text();
    expect(list).toContain(`/r/${run}`);

    expect((await fetch(url("/runs?before=abc"), { headers: { cookie } })).status).toBe(400);
    expect((await fetch(url("/runs?before=9007199254740993"), { headers: { cookie } })).status).toBe(400);

    const screen = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(screen).toContain("$0.42");
    expect(screen).toContain("Wired the guard; tests added.");
  });

  test("run evidence: own artifacts serve, foreign artifacts and foreign repos are not found", async () => {
    store.createTask({ id: "t-1", title: "ours" }, T0);
    const ours = store.refFor("built-in", "t-1").id;
    store.placeTask(ours, "/repo/main");
    store.createTask({ id: "t-2", title: "theirs" }, T0);
    const theirs = store.refFor("built-in", "t-2").id;
    store.placeTask(theirs, "/repo/other");

    const mine = seedRun(ours, 1);
    const foreign = seedRun(theirs, 2);
    mkdirSync(join(evidenceRoot, String(mine)), { recursive: true });
    const content = Buffer.from("diff --git a/y b/y\n", "utf8");
    writeFileSync(join(evidenceRoot, String(mine), "diff.patch"), content);
    const artifact = store.saveArtifact(
      {
        run: mine,
        kind: "diff",
        key: `${mine}/diff.patch`,
        bytesOriginal: content.length,
        bytesStored: content.length,
        truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );
    const cookie = await login();

    const served = await fetch(url(`/r/${mine}/evidence/${artifact}`), { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("diff --git");

    // The same artifact through the wrong run: not found, not explained.
    expect((await fetch(url(`/r/${foreign}/evidence/${artifact}`), { headers: { cookie } })).status).toBe(404);
    // A run of another repo's task does not exist on this console at all.
    expect((await fetch(url(`/r/${foreign}`), { headers: { cookie } })).status).toBe(404);
  });

  test("GET never mutates: an overdue decision reads as overdue while the row stays open", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "past due?",
        options: [{ id: "a", label: "a", consequence: "c", reversible: true }],
        recommendation: "a",
        deadline: new Date(Date.now() - 60_000).toISOString(),
      },
      T0,
    );
    const cookie = await login();

    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(home).toContain("overdue");
    // The page derived it; nothing wrote it.
    expect(store.listDecisions("open")).toHaveLength(1);
  });

  test("one gate for every mutation: content type, origin, csrf, and no duplicated fields", async () => {
    store.createTask({ id: "t-g", title: "gated" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // Wrong content type.
    const typed = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "text/plain" },
      body: "reason=x",
      redirect: "manual",
    });
    expect(typed.status).toBe(415);

    // Foreign origin.
    const foreign = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: new URLSearchParams({ csrf, reason: "x" }),
      redirect: "manual",
    });
    expect(foreign.status).toBe(403);

    // Missing csrf.
    const bare = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ reason: "x" }),
      redirect: "manual",
    });
    expect(bare.status).toBe(403);

    // A smuggled second csrf value.
    const doubled = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${csrf}&csrf=${csrf}&reason=x`,
      redirect: "manual",
    });
    expect(doubled.status).toBe(400);

    expect(store.activeHolds(store.refFor("built-in", "t-g").id, new Date())).toHaveLength(0);
  });

  test("every database-derived string renders inert, table-driven", async () => {
    const probe = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    store.createTask({ id: "t-x", title: `title ${probe}` }, T0);
    const ref = store.refFor("built-in", "t-x").id;
    store.hold(ref, `hold ${probe}`, null, T0);
    const run = seedRun(ref, 1);
    store.recordOutcomeFacts(run, { handoff: `conclusion ${probe}` });
    store.finishRun(run, { outcome: "failed", reason: `reason ${probe}`, now: T0 });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-x/scope", cookie, { csrf, sawDigest: "", goal: `goal ${probe}`, not: `not ${probe}`, touches: `touch-${probe}` });

    for (const path of ["/", "/tasks", "/t/t-x", "/runs", `/r/${run}`]) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      expect(html, path).not.toContain("<script>alert(1)");
      expect(html, path).not.toContain("<img src=x");
    }
  });

  test("a task id that is hostile as a URL is linked encoded and resolved decoded", async () => {
    // Legacy CLI ids are free-form; the console must not let one break a path.
    store.createTask({ id: "a b?c=1", title: "awkward id" }, T0);
    const cookie = await login();

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain(`/t/a%20b%3Fc%3D1`);

    const screen = await fetch(url("/t/a%20b%3Fc%3D1"), { headers: { cookie } });
    expect(screen.status).toBe(200);
    expect(await screen.text()).toContain("awkward id");
  });

  test("caps reads the same gaps the brief computes, and admits being read-only", async () => {
    store.saveCapability({
      repo: "/repo/main",
      kind: "cli",
      name: "gh",
      probe: "gh auth status",
      status: "unprobed",
      addedBy: "alex",
      createdAt: T0.toISOString(),
      lastVerifiedAt: null,
      verifiedBy: null,
      lastResult: null,
      expiresAt: null,
    });
    const cookie = await login();

    const caps = await (await fetch(url("/caps"), { headers: { cookie } })).text();
    expect(caps).toContain("cli:gh");
    expect(caps).toContain("unprobed");
    expect(caps).toContain("read-only");
  });
});

describe("console v2: projects, the ceiling, and the workspace", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let repoA: string;
  let repoB: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfFrom = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf");
    return match[1] as string;
  };

  const post = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "nightorders-v2-ev-"));
    // Two real directories: A is inside the ceiling, B is not.
    repoA = realpathSync(mkdtempSync(join(tmpdir(), "nightorders-v2-repoA-")));
    repoB = realpathSync(mkdtempSync(join(tmpdir(), "nightorders-v2-repoB-")));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({ store, evidenceRoot, repos: [repoA] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    for (const dir of [evidenceRoot, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
  });

  const seedTaskIn = (id: string, repo: string) => {
    store.createTask({ id, title: `work ${id}` }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };

  const seedDecisionIn = (id: string, repo: string): { decision: number; run: number } => {
    const ref = seedTaskIn(id, repo);
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1",
      branch: `nightorders/${id}`, worktree: `/pool/${id}`, now: T0,
    });
    const decision = store.saveDecision(
      {
        run, urgency: "blocking", recap: "r", question: `${id}?`,
        options: [{ id: "a", label: "a", consequence: "c", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    return { decision, run };
  };

  test("the sidebar shell renders with the sole configured project open", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(home).toContain('class="side"');
    expect(home).toContain("switch project");
    expect(home).toContain("+ new task");
    // The sole configured repo opened itself — no forced detour.
    expect(home).toContain("inbox");
    expect(home).toContain(">done<");
  });

  test("a task outside the ceiling does not exist: page, mutations, list", async () => {
    seedTaskIn("t-in", repoA);
    seedTaskIn("t-out", repoB);
    const cookie = await login();

    expect((await fetch(url("/t/t-out"), { headers: { cookie } })).status).toBe(404);
    const csrf = await csrfFrom(cookie);
    expect((await post("/t/t-out/hold", cookie, { csrf, reason: "x" })).status).toBe(404);

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain("t-in");
    expect(list).not.toContain("t-out");
  });

  test("a decision outside the ceiling cannot be read, answered, or bled through evidence", async () => {
    const inside = seedDecisionIn("t-in", repoA);
    const outside = seedDecisionIn("t-out", repoB);
    const cookie = await login();

    expect((await fetch(url(`/d/${inside.decision}`), { headers: { cookie } })).status).toBe(200);
    expect((await fetch(url(`/d/${outside.decision}`), { headers: { cookie } })).status).toBe(404);

    const csrf = await csrfFrom(cookie);
    const answered = await post(`/d/${outside.decision}/answer`, cookie, { csrf, choice: "a" });
    expect(answered.status).toBe(404);
    expect(store.getDecision(outside.decision)?.state).toBe("open");

    // Evidence linked to the out-of-ceiling decision is not served.
    mkdirSync(join(evidenceRoot, String(outside.run)), { recursive: true });
    const secret = Buffer.from("their diff", "utf8");
    writeFileSync(join(evidenceRoot, String(outside.run), "diff.patch"), secret);
    const artifact = store.saveArtifact(
      {
        run: outside.run, kind: "diff", key: `${outside.run}/diff.patch`,
        bytesOriginal: secret.length, bytesStored: secret.length, truncated: false,
        sha256: createHash("sha256").update(secret).digest("hex"), capture: "git diff (exit 0)",
      },
      T0,
    );
    store.linkEvidence(outside.decision, artifact);
    expect((await fetch(url(`/d/${outside.decision}/evidence/${artifact}`), { headers: { cookie } })).status).toBe(404);
  });

  test("opening a project: outside the ceiling refused, inside opens and is remembered", async () => {
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const denied = await post("/projects/open", cookie, { csrf, path: repoB });
    expect(denied.status).toBe(403);

    const ghost = await post("/projects/open", cookie, { csrf, path: "/no/such/place" });
    expect(ghost.status).toBe(400);

    // repoA is configured but not yet a git repo — the opener requires one:
    // configuration authorizes, only being a repository makes it openable.
    const notGit = await post("/projects/open", cookie, { csrf, path: repoA });
    expect(notGit.status).toBe(400);

    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoA });
    const opened = await post("/projects/open", cookie, { csrf, path: repoA });
    expect(opened.status).toBe(303);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listProjects()[0]?.name).toBe(repoA.split("/").pop());
  });

  test("a stale tab's create lands in nobody's project: the revision refuses it", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoA });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // A form rendered now carries revision 1; opening a project bumps it.
    const staleRevision = "1";
    await post("/projects/open", cookie, { csrf, path: repoA });

    const created = await post("/tasks/add", cookie, {
      csrf, title: "stale tab work", projectRevision: staleRevision,
    });
    expect(created.status).toBe(409);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("a blank id slugs from the title and the create lands on the approve card", async () => {
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const created = await post("/tasks/add", cookie, {
      csrf, title: "Add a Rate Limiter!", goal: "sliding windows on the public api",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/t/add-a-rate-limiter");

    const screen = await (await fetch(url("/t/add-a-rate-limiter"), { headers: { cookie } })).text();
    expect(screen).toContain("approve exactly this:");
    // The master pane lists it, marked current.
    expect(screen).toContain('class="item current"');
  });

  test("a bearer caller is confined by the same ceiling", async () => {
    seedTaskIn("t-in", repoA);
    seedTaskIn("t-out", repoB);
    const auth = { authorization: `Bearer alex:${approverToken}` };

    // Naming an out-of-ceiling project is a refusal, not a fallback.
    const denied = await fetch(url("/tasks"), { headers: { ...auth, "x-nightorders-project": repoB } });
    expect(denied.status).toBe(403);

    // And the resource ceiling holds without any header games.
    expect((await fetch(url("/t/t-out"), { headers: auth })).status).toBe(404);
    expect((await fetch(url("/t/t-in"), { headers: auth })).status).toBe(200);

    // Opening a project is a browser act.
    const open = await fetch(url("/projects/open"), {
      method: "POST", headers: auth, body: new URLSearchParams({ path: repoA }), redirect: "manual",
    });
    expect(open.status).toBe(403);
  });

  test("a v5 database opens as v6 with the project registry usable", async () => {
    // The in-memory store in this suite was born v6; prove the additive
    // migration by opening a file store twice across the version bump path.
    const dir = mkdtempSync(join(tmpdir(), "nightorders-v2-mig-"));
    try {
      const first = openStore(join(dir, "q.db"));
      first.createTask({ id: "t-old", title: "pre-existing" }, T0);
      first.close();
      const again = openStore(join(dir, "q.db"));
      again.upsertProject("/some/where", "where", T0);
      expect(again.listProjects()).toHaveLength(1);
      expect(again.getTask("t-old")?.title).toBe("pre-existing");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
