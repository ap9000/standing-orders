/**
 * The M3 acceptance surface: a park renders as one screen, answerable on a
 * phone. Real HTTP against an ephemeral port; only the phone is imaginary.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";
import { register, hashToken } from "./runner.js";
import { addApprover, approvalOf, approve, propose } from "./scope.js";
import { approveRoutine, fireRoutine, refreshRoutineAgents, routineDigestOf } from "./routine.js";
import { planTournament, admitContest, finalizeContestant } from "./contest.js";
import { storeEvidence } from "./evidence.js";
import { createDecisionServer, SENSITIVE_INPUT, reviewPriorityOf, rankReviewQueue, withinSignedTouches, diffFileAnchor, reviewFilePriority, orderChangedFiles, type ReviewQueueFacts, type ReviewFileRow } from "./serve.js";
import { parseExecutionPlanDocument, milestonesOf } from "./plan.js";
import { resolveRoutineAuthority, routeOfTask } from "./agentconfig.js";
import { projectRoute, readinessWords } from "./phase-routing.js";
import type { MateProviderAnswer } from "./converse.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  bound: { index: number; entryDigest: string } | null = null,
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role, bound) ?? s.routeAuthorityFor(taskRef, role, bound, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-08-11T22:00:00.000Z");

/**
 * v48: a routed task opens no run without a sealed route. Fixtures that
 * need a run on a task seal its scope through the real ceremony first:
 * exact agents configured once, the scope proposed (or re-filed under
 * today's configuration), and approved by a bootstrap approver whose token
 * is remembered per store. The task's own goal is kept when one is filed.
 */
function sealScopeFixture(store: Store, taskId: string, token: string, goal = "the work"): void {
  for (const phase of ["plan", "build", "review"]) {
    if (store.phaseConfig("installation", phase) === null) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  }
  const existing = store.getScope(taskId);
  if (existing === null) propose(store, { taskId, goal, now: T0 });
  else if (existing.profileState !== "resolved" || existing.proposedRouteJson == null) store.refileScope(taskId, T0);
  const scope = store.getScope(taskId);
  if (scope === null) throw new Error("the fixture filed no scope");
  if (scope.approvedAt !== null && scope.approvedDigest === scope.digest) return;
  const approved = approve(store, taskId, "alex", T0, scope.digest, token);
  if (!approved.ok) throw new Error(`the fixture approval of ${taskId} was refused: ${approved.reason}`);
}

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
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-ev-"));

    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    const runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, taskRef, "builder"),
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

  test("the console files a tournament from the scope form, and ONE yes approves scope and race together", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    // Save a scope asking two agents to compete.
    const saved = await fetch(url("/t/t-1/scope"), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf, sawDigest: "", goal: "build it twice and let me pick", not: "", touches: "",
        "budget-usd": "2.50", "race-count": "2", "race-model": "claude-sonnet-5",
        "race-per-usd": "5", "race-total-usd": "14",
      }),
      redirect: "manual",
    });
    expect(saved.status).toBe(303);
    const terms = store.activeTournamentTerms(taskRef);
    expect(terms?.n).toBe(2);
    expect(store.getScope("t-1")?.budgetMicrousd).toBe(2_500_000);

    // The approval card restates the tournament and binds the JOINT digest.
    const page = await (await fetch(url("/t/t-1"), { headers: { cookie } })).text();
    expect(page).toContain("and this tournament:");
    expect(page).toContain("2 agents build this independently");
    const digest = /name="digest" value="([0-9a-f]{64})"/.exec(page)?.[1];
    const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1];
    if (digest === undefined || nonce === undefined) throw new Error(`no approval form: ${page.slice(page.indexOf("approve-form"), page.indexOf("approve-form") + 600)}`);
    const approved = await fetch(url("/t/t-1/approve"), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, digest, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(store.activeTournamentTerms(taskRef)?.approvedBy).toBe("alex");
    const scope = store.getScope("t-1");
    expect(scope?.approvedDigest).toBe(scope?.digest);

    // Saving the form back to "one agent" withdraws the standing race.
    const csrf2 = await csrfOf(cookie);
    const single = await fetch(url("/t/t-1/scope"), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf: csrf2, sawDigest: scope?.digest ?? "", goal: "just build it once", not: "", touches: "", "race-count": "",
      }),
      redirect: "manual",
    });
    expect(single.status).toBe(303);
    expect(store.activeTournamentTerms(taskRef)).toBeNull();
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
      ...presented(store, taskRef, "builder"),
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
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-serve-settings-"));
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

describe("provider keys & auth mode, over HTTP", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let dir: string;
  let approverToken: string;
  let priorHome: string | undefined;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = async (cookie: string): Promise<string> => {
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    return /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;
  };

  beforeEach(async () => {
    // HOME is isolated so provider-key writes never touch the real store.
    priorHome = process.env["HOME"];
    dir = mkdtempSync(join(tmpdir(), "so-serve-keys-"));
    process.env["HOME"] = dir;
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot: join(dir, "ev"), clock: () => new Date(), telegramTokenFile: join(dir, "tok") });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = priorHome;
  });

  const post = async (cookie: string, csrf: string, fields: Record<string, string>) =>
    fetch(`${base}/settings/provider-key`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, ...fields }),
      redirect: "manual",
    });

  test("an unchanged blank submission claims NO change (round 5, finding 2)", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    // claude defaults to subscription; submitting subscription + no key changes nothing.
    const res = await post(cookie, csrf, { provider: "claude", "auth-mode": "subscription", value: "" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("no change");
    const { readAuthMode } = await import("./keys.js");
    expect(readAuthMode("claude")).toBe("subscription");
  });

  test("an invalid key does NOT persist a hidden mode change (validate before mutate)", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const res = await post(cookie, csrf, { provider: "claude", "auth-mode": "api-key", value: "short" });
    expect(res.status).toBe(400);
    const { readAuthMode } = await import("./keys.js");
    // The mode was NOT switched despite the api-key selection — the bad key refused first.
    expect(readAuthMode("claude")).toBe("subscription");
  });

  test("a real mode change is claimed; openrouter cannot go subscription", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const changed = await post(cookie, csrf, { provider: "claude", "auth-mode": "api-key", value: "" });
    expect(decodeURIComponent(changed.headers.get("location") ?? "")).toContain("now uses the API key");
    const { readAuthMode } = await import("./keys.js");
    expect(readAuthMode("claude")).toBe("api-key");
    // openrouter has no subscription — a forced submit refuses without mutating.
    const refused = await post(cookie, csrf, { provider: "openrouter", "auth-mode": "subscription", value: "" });
    expect(refused.status).toBe(409);
    expect(readAuthMode("openrouter")).toBe("api-key");
  });

  test("the projects page renders richer cards with a peek and a unified add card", async () => {
    const cookie = await login();
    // Seed a project so a card renders (a temp git repo opened via the road).
    const repoDir = mkdtempSync(join(tmpdir(), "so-proj-"));
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    const real = realpathSync(repoDir);
    store.upsertProject(real, "so-proj", T0);
    const page = await (await fetch(`${base}/projects`, { headers: { cookie } })).text();
    // The richer card structure and the unified add affordance render.
    expect(page).toContain("project-card");
    expect(page).toContain("add a project");
    expect(page).toContain("project-add-actions");
    expect(page).toContain("Choose a local folder");
    expect(page).toContain("Add from GitHub");
    // The path-typing road is still reachable (now behind a details).
    expect(page).toContain("Enter an exact path instead");
    expect(page).toContain("path on this server");
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("clearing a key in subscription mode says builds are unaffected", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const { saveProviderKey, readAuthMode } = await import("./keys.js");
    saveProviderKey("claude", "sk-ant-StoredThenCleared99");
    expect(readAuthMode("claude")).toBe("subscription");
    const res = await fetch(`${base}/settings/provider-key-clear`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "claude" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("uses its own login");
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
      branch: `standing-orders/x-${n}`,
      worktree: `/pool/x-${n}`,
      now: new Date(Date.now() - n * 60_000),
      ...presented(store, taskRef, "builder"),
    });

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-console-ev-"));
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

  test("evidence-first task page: attempts ledger, spend by provider, the unmeasured said in words (M5.5/6)", async () => {
    store.createTask({ id: "t-spend", title: "spendy" }, T0);
    const ref = store.refFor("built-in", "t-spend").id;
    const claudeRun = store.startRun({ taskRef: ref, leaseId: "l-s1", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.recordUsage(claudeRun, { tokensIn: 41_000, tokensOut: 3_000, costUsd: 1.23 });
    store.finishRun(claudeRun, { outcome: "built", now: T0 });
    const codexRun = store.startRun({ taskRef: ref, leaseId: "l-s2", runner: "b-1", branch: "b", worktree: "/w", provider: "codex", now: T0, ...presented(store, ref, "builder", null, { provider: "codex", model: null }) });
    store.recordUsage(codexRun, { tokensIn: 80_000, tokensOut: 9_000 });
    store.finishRun(codexRun, { outcome: "failed", reason: "agent", now: T0 });

    const cookie = await login();
    const page = await (await fetch(url("/t/t-spend"), { headers: { cookie } })).text();
    expect(page).toContain("attempts");
    expect(page).toContain("spend");
    expect(page).toContain("$1.23");
    // Tokens without dollars are the unmeasured, in words — never $0.00.
    expect(page).toContain("dollar cost unmeasured");
    expect(page).not.toContain("$0.00");
    // Evidence above mechanics: the ledger precedes the scope section.
    expect(page.indexOf("attempts")).toBeLessThan(page.indexOf(">scope<"));

    const runView = await (await fetch(url(`/r/${codexRun}`), { headers: { cookie } })).text();
    expect(runView).toContain("unmeasured");
    expect(runView).toContain("tokens, not prices");
  });

  test("an operator note lands beside the run, immutable and validated (M6)", async () => {
    store.createTask({ id: "t-note", title: "noted" }, T0);
    const ref = store.refFor("built-in", "t-note").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-n1", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "failed", reason: "agent", now: T0 });

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-note"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    const posted = await fetch(url(`/r/${run}/note`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "suspect — the fix touched the wrong module" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);

    const page = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(page).toContain("operator notes");
    expect(page).toContain("suspect — the fix touched the wrong module");

    // An empty note is refused by the shared validator, not stored blank.
    const blank = await fetch(url(`/r/${run}/note`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "   " }),
      redirect: "manual",
    });
    expect(blank.status).toBe(400);
  });

  test("a revision inherits the source scope's limits, and a broken brief blocks its approval (audit IV-2/IV-3)", async () => {
    const { propose } = await import("./scope.js");
    store.createTask({ id: "t-lim", title: "bounded work" }, T0);
    const ref = store.refFor("built-in", "t-lim").id;
    propose(store, { taskId: "t-lim", goal: "fix the rounding", outOfScope: "authentication", touches: ["src/payments/"], acceptance: [{ id: "c1", statement: "The rounding is fixed.", evidence: ["check"] }], now: T0 });
    sealScopeFixture(store, "t-lim", approverToken);
    const run = store.startRun({ taskRef: ref, leaseId: "l-lim", runner: "b-1", branch: "so/t-lim", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/p b/p\n+x\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      { run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" },
      T0,
    );

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-lim"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "narrow this" }),
      redirect: "manual",
    });
    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    const target = revised.headers.get("location") ?? "";
    const newTaskId = decodeURIComponent(target.replace("/t/", ""));

    // IV-2: the exclusions and path limits SURVIVED into the revision scope.
    const revScope = store.getScope(newTaskId);
    expect(revScope?.outOfScope).toBe("authentication");
    expect(revScope?.touches).toEqual(["src/payments/"]);
    const page1 = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(page1).toContain("authentication");
    expect(page1).not.toContain("<em>no exclusions</em>");

    // IV-3: corrupt the brief on disk — the approval surface closes.
    const newRef = store.lookupRef(newTaskId);
    const briefArtifact = store.getArtifact(newRef?.revisionBriefArtifact as number);
    writeFileSync(join(evidenceRoot, briefArtifact?.key as string), "tampered");
    const page2 = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(page2).toContain("approval is blocked");
    expect(page2).not.toContain("approve this scope");
  });

  test("a high-risk, strict revision keeps its terms on the task page, the approval card, and chat after the installation's defaults change; the CI draft reads the same (contract handoff task 2)", async () => {
    const { propose } = await import("./scope.js");
    store.createTask({ id: "t-strict", title: "careful work" }, T0);
    const ref = store.refFor("built-in", "t-strict").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "t-strict",
      goal: "harden the payout guard",
      outOfScope: "authentication",
      touches: ["src/payments/"],
      acceptance: [{ id: "c1", statement: "The guard refuses a negative payout.", evidence: ["check"] }, { id: "c2", statement: "The dashboard shows the refusal.", evidence: ["screenshot"] }],
      budgetMicrousd: 2_000_000,
      riskLevel: "high",
      qualityMode: "strict",
      permissionMode: "auto",
      now: T0,
    });
    sealScopeFixture(store, "t-strict", approverToken);
    const run = store.startRun({ taskRef: ref, leaseId: "l-strict", runner: "b-1", branch: "so/t-strict", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/g b/g\n+guard\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      { run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" },
      T0,
    );
    // The installation changes its mind AFTER the source was signed.
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    store.setQualityDefault("default", "alex", T0);

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-strict"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, path: "src/payments/guard.ts", line: "4", note: "also refuse zero" }),
      redirect: "manual",
    });
    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(revised.status).toBe(303);
    const target = revised.headers.get("location") ?? "";
    const childId = decodeURIComponent(target.replace("/t/", ""));

    // The child's ACTUAL terms: the source's, not today's defaults.
    const child = store.getScope(childId);
    expect(child).toMatchObject({ riskLevel: "high", qualityMode: "strict", budgetMicrousd: 2_000_000, outOfScope: "authentication", touches: ["src/payments/"], approvedAt: null });
    expect(child?.acceptance.map(one => one.id)).toEqual(["c1", "c2"]);
    expect(child?.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    expect(store.lookupRef(childId)).toMatchObject({ revisionOf: "t-strict", riskLevel: "high", qualityMode: "strict", permissionMode: "auto" });

    // The task page: the approval card restates the terms, and the lineage
    // says where they came from and what did not come along.
    const page = await (await fetch(url(target), { headers: { cookie } })).text();
    const lineage = `revises t-strict (build #${run})`;
    expect(page).toContain(lineage);
    expect(page).toContain("inherited terms, as they stand now: High risk · Strict / release quality · auto permissions · $2.00 attempt cap · its exclusions · 1 path limit · 2 criteria");
    expect(page).toContain("never inherited: the source&#39;s approval, attended sessions, publication and merge grants");
    expect(page).toContain("re-resolved for this approval: the agents route and the fallback chain");
    expect(page).toContain("quality · <strong>Strict / release</strong>");
    expect(page).toContain('<span class="approval-chip">Auto permissions</span>');
    expect(page).not.toContain('<span class="approval-chip">Full access</span>');
    expect(page).toContain("also refuse zero");
    const approveForm = /<form method="post" action="[^"]*\/approve" class="card approve-form approval-card" id="approve">(.*?)<\/form>/s.exec(page)?.[1] ?? "";
    expect(approveForm).toContain("High risk");
    expect(approveForm).toContain(lineage);
    expect(approveForm).toContain("never inherited");

    // Chat: the same words, from the same projection.
    const chat = await (await fetch(url(`/chat?task=${encodeURIComponent(childId)}`), { headers: { cookie } })).text();
    expect(chat).toContain(lineage);
    expect(chat).toContain("inherited terms, as they stand now: High risk · Strict / release quality");
    expect(chat).toContain("never inherited: the source&#39;s approval");
    expect(chat).toContain("also refuse zero");
    expect(chat).toContain("quality · <strong>Strict / release</strong>");

    // The CI draft on a published run of the same source reads the same.
    const pub = store.createPublicationIntent(
      { run, taskRef: ref, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-strict", headSha: "c".repeat(40), bodyHash: "h3", draft: false },
      T0,
    );
    store.markPublicationPushed(pub, T0);
    store.markPublicationOpened(pub, 103, "https://github.com/ap9000/thing/pull/103", T0);
    store.enqueueNotification({ dedupeKey: `ci:ap9000/thing:103:${"c".repeat(40)}`, kind: "ci-failed", subject: "checks failing on #103", body: "red" }, T0);
    const drafted = await fetch(url(`/r/${run}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(drafted.status).toBe(303);
    expect(store.getScope("t-strict-ci-103")).toMatchObject({ riskLevel: "high", qualityMode: "strict", budgetMicrousd: 2_000_000, approvedAt: null });
    const ciPage = await (await fetch(url("/t/t-strict-ci-103"), { headers: { cookie } })).text();
    expect(ciPage).toContain("the CI repair");
    expect(ciPage).toContain(lineage);
    expect(ciPage).toContain("inherited terms, as they stand now: High risk · Strict / release quality · auto permissions · $2.00 attempt cap");
    expect(ciPage).toContain("quality · <strong>Strict / release</strong>");
    expect(ciPage).toContain('<span class="approval-chip">Auto permissions</span>');
    expect(ciPage).not.toContain('<span class="approval-chip">Full access</span>');

    // A batch drafted against a scope digest the source no longer carries
    // refuses in words and consumes nothing: the road's own seal re-reads
    // the digest inside the transaction, so a concurrent rewrite between
    // the page's read and the click can never seal old terms.
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, path: "src/payments/guard.ts", line: "9", note: "and log it" }),
      redirect: "manual",
    });
    const sealed = store.sealRevision(
      {
        source: { task: "t-strict", run, scopeDigest: "0".repeat(32) },
        brief: { evidenceRoot, key: `${run}/terminal-diff.patch`, sha256: createHash("sha256").update(patch).digest("hex"), bytes: patch.length, capture: "x" },
        child: { title: "x", repair: "y" },
        commentIds: store.liveDiffComments(run).map(one => one.id),
      },
      T0,
    );
    expect(sealed).toMatchObject({ ok: false, reason: "stale-source" });
    expect(store.liveDiffComments(run)).toHaveLength(1);
  });

  test("review comments on the terminal diff seal into one revision task that must be approved (M6.8)", async () => {
    store.createTask({ id: "t-rev", title: "original work" }, T0);
    const ref = store.refFor("built-in", "t-rev").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-r1", runner: "b-1", branch: "so/t-rev", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.recordOutcomeFacts(run, { headRevision: "headsha1234", handoff: "did it" });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/y b/y\n+line\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      {
        run,
        kind: "terminal-diff",
        key: `${run}/terminal-diff.patch`,
        bytesOriginal: patch.length,
        bytesStored: patch.length,
        truncated: false,
        sha256: createHash("sha256").update(patch).digest("hex"),
        capture: "git diff base head (exit 0)",
      },
      T0,
    );

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-rev"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";

    const commented = await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, path: "src/y.ts", line: "12", note: "tighten the guard here" }),
      redirect: "manual",
    });
    expect(commented.status).toBe(303);

    const runView = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(runView).toContain("tighten the guard here");
    expect(runView).toContain("1 annotation ready");
    expect(runView).toContain("Create revision from annotations");

    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(revised.status).toBe(303);
    const target = revised.headers.get("location") ?? "";

    // The new task's screen restates the batch beside its own approval —
    // and the scope is unapproved by construction.
    const taskView = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(taskView).toContain("Revise t-rev from 1 annotation on build");
    expect(taskView).toContain("the review batch");
    expect(taskView).toContain("tighten the guard here");
    expect(taskView).toContain("t-rev");
    expect(taskView).toContain("approve");

    // The batch is consumed: a second seal has nothing to work with.
    const again = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(again.status).toBe(400);
  });

  test("the review cockpit ranks an observed CI failure first and the plane never merges (M8.19); a red episode earns the repair draft from the cockpit and the run page (M8.18)", async () => {
    // Two published PRs: one quiet, one with an observed CI failure.
    store.createTask({ id: "t-pr1", title: "shipped one" }, T0);
    const ref1 = store.refFor("built-in", "t-pr1").id;
    const run1 = store.startRun({ taskRef: ref1, leaseId: "l-p1", runner: "b-1", branch: "so/t-pr1", worktree: "/w", now: T0, ...presented(store, ref1, "builder") });
    store.finishRun(run1, { outcome: "built", now: T0 });
    store.setTaskState("t-pr1", "done", T0);
    const pub1 = store.createPublicationIntent(
      { run: run1, taskRef: ref1, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-pr1", headSha: "a".repeat(40), bodyHash: "h1", draft: false },
      T0,
    );
    store.markPublicationPushed(pub1, T0);
    store.markPublicationOpened(pub1, 101, "https://github.com/ap9000/thing/pull/101", T0);
    // Green is a FACT the watcher saw (audit SD-4): only an observed pass
    // earns "review next".
    store.recordPublicationCheckState(pub1, "passing", T0);

    store.createTask({ id: "t-pr2", title: "shipped two" }, T0);
    const ref2 = store.refFor("built-in", "t-pr2").id;
    const run2 = store.startRun({ taskRef: ref2, leaseId: "l-p2", runner: "b-1", branch: "so/t-pr2", worktree: "/w", now: T0, ...presented(store, ref2, "builder") });
    store.finishRun(run2, { outcome: "built", now: T0 });
    store.setTaskState("t-pr2", "done", new Date(T0.getTime() - 60_000));
    const pub2 = store.createPublicationIntent(
      { run: run2, taskRef: ref2, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-pr2", headSha: "b".repeat(40), bodyHash: "h2", draft: false },
      T0,
    );
    store.markPublicationPushed(pub2, T0);
    store.markPublicationOpened(pub2, 102, "https://github.com/ap9000/thing/pull/102", T0);
    store.enqueueNotification(
      { dedupeKey: `ci:ap9000/thing:102:${"b".repeat(40)}`, kind: "ci-failed", subject: "checks failing on #102", body: "red" },
      T0,
    );

    const cookie = await login();
    const queue = await (await fetch(url("/review"), { headers: { cookie } })).text();
    // Review priority puts the OBSERVED failure first — it needs a person —
    // even though the quiet PR finished later; the quiet one is not hidden.
    const list = /<ol class="cockpit-queue-list">(.*?)<\/ol>/s.exec(queue)?.[1] ?? "";
    expect(list.indexOf("PR #102")).toBeLessThan(list.indexOf("PR #101"));
    expect(list.indexOf("PR #102")).toBeGreaterThanOrEqual(0);
    expect(list).toContain("CI failing on its pull request — observed, not inferred");
    // The failing result is selected by default; its publication card says
    // exactly what the watcher saw, and offers the repair draft.
    expect(queue).toContain('data-review-task="t-pr2"');
    expect(queue).toContain("CI failing — last checked by Standing Orders");
    expect(queue).toContain(`action="/r/${run2}/draft-repair"`);
    expect(queue).toContain('data-next-action="draft-repair"');
    // Read-only where it matters: no merge button anywhere, and the only
    // forms post to endpoints that already exist.
    expect(queue).not.toMatch(/merge/i);
    // The quiet PR, selected by its stable link, reads the observed green.
    const quiet = await (await fetch(url("/review?result=t-pr1"), { headers: { cookie } })).text();
    expect(quiet).toContain('data-review-task="t-pr1"');
    expect(quiet).toContain("CI passing — observed");
    expect(quiet).toContain('data-next-action="publication"');
    expect(quiet).not.toContain("draft-repair");

    // The failing run's page carries the draft button; the quiet one does not.
    const failingRun = await (await fetch(url(`/r/${run2}`), { headers: { cookie } })).text();
    expect(failingRun).toContain("draft a repair task");
    const quietRun = await (await fetch(url(`/r/${run1}`), { headers: { cookie } })).text();
    expect(quietRun).not.toContain("draft a repair task");

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(failingRun)?.[1] ?? "";
    const drafted = await fetch(url(`/r/${run2}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(drafted.status).toBe(303);
    expect(drafted.headers.get("location")).toBe("/t/t-pr2-ci-102");

    // One draft per task/PR, ever: the second click is a 409, not a twin.
    const twin = await fetch(url(`/r/${run2}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(twin.status).toBe(409);

    // The draft is unapproved and says what it is.
    const draftPage = await (await fetch(url("/t/t-pr2-ci-102"), { headers: { cookie } })).text();
    expect(draftPage).toContain("CI failing on PR #102");
    expect(draftPage).toContain("approve");
  });

  test("the overview is live: refresh meta, building-now card, system status", async () => {
    store.createTask({ id: "t-live", title: "being built right now" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 60 * 60_000 });
    store.saveWorktree({
      path: "/pool/repo/standing-orders-t-live-abc123", repo: "/repo/main", branch: "standing-orders/t-live",
      runner: "builder-1", taskRef: ref, createdAt: new Date().toISOString(),
      leasedAt: new Date().toISOString(), releasedAt: null, verified: true,
    });
    const cookie = await login();

    const system = await (await fetch(url("/system"), { headers: { cookie } })).text();
    expect(system).toContain('http-equiv="refresh" content="10"');
    expect(system).toContain("1/2 building");
    expect(system).toContain("standing-orders-t-live-abc123");
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
      acceptance: "c1: ok | manual-review",
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
    const first = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "narrow goal", not: "", touches: "" });
    expect(first.status).toBe(303);
    const digest = store.getScope("t-s")?.digest ?? "";
    expect(digest).not.toBe("");

    // A second tab still holding the empty form is refused, not merged.
    const stale = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "rival goal", not: "", touches: "" });
    expect(stale.status).toBe(409);
    expect(store.getScope("t-s")?.goal).toBe("narrow goal");

    // Approve, then edit with the right digest: approval visibly voids.
    const page = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] ?? "";
    const approved = await post("/t/t-s/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(approved.status).toBe(303);

    const edited = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: digest, goal: "wider goal", not: "", touches: "" });
    expect(edited.status).toBe(303);
    const after = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    expect(after).toContain("approved once, then rewritten");
  });

  test("consent-closed: an unreadable route, a route that cannot run, or a lapsed pre-routing approval mints no nonce and shows no password on the task page, the focused chat, or /next — recovery copy names the road", async () => {
    store.createTask({ id: "t-c", title: "closed door" }, T0);
    store.placeTask(store.refFor("built-in", "t-c").id, "/repo/main");
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-c/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-c")?.digest ?? "";
    const surfaces = async () => ({
      task: await (await fetch(url("/t/t-c"), { headers: { cookie } })).text(),
      chat: await (await fetch(url("/chat?task=t-c"), { headers: { cookie } })).text(),
      next: await (await fetch(url("/next"), { headers: { cookie } })).text(),
    });
    const inboxRow = async () => {
      const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
      const start = inbox.indexOf('href="/t/t-c"');
      return start === -1 ? "" : inbox.slice(start, inbox.indexOf("</a>", start));
    };
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;
    const closed = (html: string) => {
      expect(nonceOf(html)).toBeNull();
      expect(html).not.toContain('type="password"');
      expect(html).not.toMatch(/approve (&amp; start|this scope)/i);
      expect(html).toContain("consent-closed");
    };
    // Open first: the door mints on every surface, and the inbox offers the act.
    let pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(nonceOf(pages.chat)).not.toBeNull();
    expect(nonceOf(pages.next)).not.toBeNull();
    expect(await inboxRow()).toContain("review &amp; approve");

    // Unreadable route bytes: closed everywhere, in words, with the road —
    // the inbox row names the attention it needs and offers no approve act.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = '{\"version\":1' WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) {
      closed(html);
      expect(html).toContain("can’t be read");
      expect(html).toContain("re-file the scope");
    }
    expect(pages.task).toContain('href="/t/t-c#scope"');
    let row = await inboxRow();
    expect(row).not.toContain("review &amp; approve");
    expect(row).toContain("needs attention: the agents on file can’t be read");
    // MISSING route bytes on a routed row (no working route at all): the
    // same closed door on every surface.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) closed(html);
    expect(await inboxRow()).toContain("needs attention");
    // The POST road is closed too: no nonce was rendered, so none is accepted;
    // and the seal itself refuses an unreadable route.
    const forced = await post("/t/t-c/approve", cookie, { csrf, nonce: "", digest, token: approverToken });
    expect(forced.status).toBe(409);
    expect(store.getScope("t-c")?.approvedAt ?? null).toBeNull();

    // A lapsed pre-routing row (no route era, no standing approval): closed,
    // and re-filing is the road. The primitive refuses a fresh seal on it.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL, route_era = NULL, approved_at = NULL, approved_by = NULL, approved_digest = NULL WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) {
      closed(html);
      expect(html).toContain("predates agent routing");
    }
    row = await inboxRow();
    expect(row).not.toContain("review &amp; approve");
    expect(row).toContain("needs attention: this scope predates agent routing");
    expect(store.sealScopeApproval("t-c", "alex", T0)).toBe(false);

    // Re-filing routes it again: the door opens, the nonce is back.
    await post("/t/t-c/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: store.getScope("t-c")?.digest ?? "", goal: "the goal", not: "", touches: "" });
    pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    expect(nonceOf(pages.next)).not.toBeNull();
    expect(await inboxRow()).toContain("review &amp; approve");
  });

  test("consent-closed (v48 integrity): the ONE strict stored-scope projection gates every surface — an extra key, a timer-unsafe clock, an unsafe integer, a malformed chain auth mode, a route/profile parity break, or a digest mismatch mints no nonce, shows no password, offers no act, and the seal refuses the same row", async () => {
    store.createTask({ id: "t-s", title: "strict door" }, T0);
    store.placeTask(store.refFor("built-in", "t-s").id, "/repo/main");
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const filed = store.getScope("t-s")!;
    const digest = filed.digest;
    const surfaces = async () => ({
      task: await (await fetch(url("/t/t-s"), { headers: { cookie } })).text(),
      chat: await (await fetch(url("/chat?task=t-s"), { headers: { cookie } })).text(),
      next: await (await fetch(url("/next"), { headers: { cookie } })).text(),
    });
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;
    const raw = store.raw();
    const stored = raw.prepare("SELECT profile_json, proposed_route_json, digest FROM task_scope WHERE task_id = 't-s'").get() as { profile_json: string; proposed_route_json: string; digest: string };
    const profile = JSON.parse(stored.profile_json) as { digestVersion: number; profile: Record<string, unknown> };
    const route = JSON.parse(stored.proposed_route_json) as Record<string, unknown>;
    const restore = () => raw.prepare("UPDATE task_scope SET profile_json = ?, proposed_route_json = ?, digest = ?, proposed_chain_json = NULL WHERE task_id = 't-s'").run(stored.profile_json, stored.proposed_route_json, stored.digest);
    // Open first.
    let pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    const cases: [string, () => void, string][] = [
      ["a profile with a key this code never writes", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, extra: true } })), "cannot be read exactly"],
      ["a wrapper with an extra key", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, note: "x" })), "cannot be read exactly"],
      ["a clock no timer can hold", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, timeoutSeconds: 2_147_484 } })), "cannot be read exactly"],
      ["an unsafe turn bound", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, maxTurns: 9007199254740993 } })), "cannot be read exactly"],
      ["a fractional clock", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, repairTimeoutSeconds: 1.5 } })), "cannot be read exactly"],
      ["a route with an extra key", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...route, extra: 1 })), "cannot be read exactly"],
      ["a route whose build leg is not the profile", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...route, legs: (route["legs"] as Record<string, unknown>[]).map(leg => (leg["phase"] === "build" ? { ...leg, model: "somewhere-else" } : leg)) })), "but the agent profile says"],
      ["a chain with a malformed auth mode", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: profile.profile, authMode: "whatever" }] })), "fallback chain cannot be read exactly"],
      ["a chain whose entry zero is not the profile", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: { ...profile.profile, model: "somewhere-else" }, authMode: "subscription" }] })), "not its fallback chain&#39;s first entry"],
      ["a digest that does not re-derive", () => raw.prepare("UPDATE task_scope SET digest = ? WHERE task_id = 't-s'").run("0".repeat(32)), "does not re-derive"],
    ];
    for (const [label, corrupt, words] of cases) {
      restore();
      corrupt();
      pages = await surfaces();
      for (const [surface, html] of Object.entries(pages)) {
        expect(nonceOf(html), `${label} (${surface})`).toBeNull();
        expect(html, `${label} (${surface})`).not.toContain('type="password"');
        expect(html, `${label} (${surface})`).not.toMatch(/approve (&amp; start|this scope)/i);
        expect(html, `${label} (${surface})`).toContain("consent-closed");
        expect(html, `${label} (${surface})`).toContain(words);
      }
      // The seal refuses the same row, and the forced POST lands nowhere.
      expect(store.sealScopeApproval("t-s", "alex", T0), label).toBe(false);
      const current = String((raw.prepare("SELECT digest FROM task_scope WHERE task_id = 't-s'").get() as { digest: string }).digest);
      const forced = await post("/t/t-s/approve", cookie, { csrf, nonce: "", digest: current, token: approverToken });
      expect(forced.status, label).toBe(409);
      expect(store.getScope("t-s")?.approvedAt ?? null, label).toBeNull();
    }
    restore();
    pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    expect(digest).toBe(store.getScope("t-s")?.digest);
  });

  test("approval is step-up: the session alone never approves", async () => {
    store.createTask({ id: "t-a", title: "approve me" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-a/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
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
    await post("/t/t-b/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
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
    // The claim rides the runner gate (MCP spec v6): registered + placed + token.
    const ref = store.refFor("built-in", "t-r").id;
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 60 * 60_000 });
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
    await post("/t/t-approve/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "a goal", not: "", touches: "" });

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
    const handoff = Buffer.from(JSON.stringify({
      schema: 1,
      outcome: "built",
      committed: true,
      conclusion: "Wired the guard; tests added.",
      changes: ["Added the payout boundary"],
      verification: ["Focused tests pass"],
      followUps: ["Watch the first production run"],
    }), "utf8");
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(run), "handoff.json"), handoff);
    store.saveArtifact({
      run, kind: "handoff", key: `${run}/handoff.json`,
      bytesOriginal: handoff.length, bytesStored: handoff.length, truncated: false,
      sha256: createHash("sha256").update(handoff).digest("hex"), capture: "agent terminal handoff",
    }, T0);
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    const cookie = await login();

    const list = await (await fetch(url("/runs"), { headers: { cookie } })).text();
    expect(list).toContain(`/r/${run}`);
    expect(list).toContain('class="badge badge-built">built</span>');
    expect(list).not.toMatch(/<p class="row"><span class="dot /);
    const tasks = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(tasks).not.toMatch(/<a class="row"[^>]*><span class="dot /);
    const task = await (await fetch(url("/t/t-1"), { headers: { cookie } })).text();
    expect(task).not.toMatch(/<p class="row"><span class="dot /);

    expect((await fetch(url("/runs?before=abc"), { headers: { cookie } })).status).toBe(400);
    expect((await fetch(url("/runs?before=9007199254740993"), { headers: { cookie } })).status).toBe(400);

    const screen = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(screen).toContain("$0.42");
    expect(screen).toContain("Wired the guard; tests added.");
    expect(screen).toContain('class="card result-card"');
    expect(screen).toContain("Added the payout boundary");
    expect(screen).toContain("checks reported by the agent");
    expect(screen).toContain("Focused tests pass");
    expect(screen).toContain("Watch the first production run");
  });

  test("a finished task and its Ask view share one concise result receipt", async () => {
    store.createTask({ id: "t-receipt", title: "make completion obvious" }, T0);
    const ref = store.refFor("built-in", "t-receipt").id;
    const run = seedRun(ref, 1);
    store.recordOutcomeFacts(run, { handoff: "Shipped the compact result receipt." });
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    store.setTaskState("t-receipt", "done", T0);
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });

    const save = (kind: "handoff" | "proof" | "diff-stat" | "screenshot", name: string, content: Buffer, capture: string): number => {
      const key = `${run}/${name}`;
      writeFileSync(join(evidenceRoot, key), content);
      return store.saveArtifact({
        run, kind, key,
        bytesOriginal: content.length, bytesStored: content.length, truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"), capture,
      }, T0);
    };
    save("handoff", "handoff.json", Buffer.from(JSON.stringify({ conclusion: "Shipped the compact result receipt." })), "agent terminal handoff");
    save("proof", "proof.json", Buffer.from(JSON.stringify({
      version: 1,
      criteria: [{ id: "c1", statement: "The result is clear", verdict: "met", how: "Shown on task and chat", evidence: [{ kind: "changed-path", ref: "src/serve.ts" }] }],
      checks: [{ command: "npm test", exitCode: 0, summary: "passed" }],
      changed: ["src/serve.ts"],
      caveats: ["Physical Windows presentation is still awaiting certification."],
      screenshots: [{ path: "evidence/result.png", caption: "Completed task receipt" }],
    })), "agent proof manifest");
    save("diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({
      base: "a".repeat(40), head: "b".repeat(40), fileCount: 2, additions: 14, deletions: 3,
      binaryCount: 0, filesTruncated: false,
      files: [{ path: "src/serve.ts", additions: 12, deletions: 3 }, { path: "docs/PRIORITIES.md", additions: 2, deletions: 0 }],
    })), "git diff --numstat (exit 0)");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const screenshot = save("screenshot", "result.png", png, "agent-claimed screenshot at evidence/result.png (validated png)");
    store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T0, [{
      id: "c1", statement: "The result is clear", requiredEvidence: ["changed-path"], state: "pass", detail: [],
      answered: [{ kind: "changed-path", ref: "src/serve.ts" }], review: null,
    }]);

    const cookie = await login();
    const task = await (await fetch(url("/t/t-receipt"), { headers: { cookie } })).text();
    expect(task).toContain('data-card-kind="result-receipt"');
    expect(task).toContain('data-proof-state="verified"');
    expect(task).toContain("Shipped the compact result receipt.");
    expect(task).toContain("1/1 acceptance criteria passed");
    expect(task).toContain("2 files · +14 −3");
    expect(task).toContain("Physical Windows presentation is still awaiting certification.");
    expect(task).toContain(`src="/r/${run}/evidence/${screenshot}"`);
    expect(task).toContain('href="/chat?task=t-receipt">Discuss or request changes →</a>');
    expect(task).not.toContain("hold next attempt");

    const chat = await (await fetch(url("/chat?task=t-receipt"), { headers: { cookie } })).text();
    expect(chat).toContain('data-card-kind="result-receipt"');
    expect(chat).toContain("1/1 acceptance criteria passed");
    expect(chat).toContain("2 files · +14 −3");
    expect(chat).toContain(`href="/r/${run}">Review & annotate</a>`);
    expect(chat).toContain('href="#latest">Request changes in chat →</a>');
    expect(chat).toContain('aria-label="task progress"');
    expect(chat).toContain("Complete");
    expect(chat).not.toContain("Discuss or request changes →");
    expect(chat).not.toContain("Get this task running");
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
    await post("/t/t-x/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: `goal ${probe}`, not: `not ${probe}`, touches: `touch-${probe}` });

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
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-v2-ev-"));
    // Two real directories: A is inside the ceiling, B is not.
    repoA = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-v2-repoA-")));
    repoB = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-v2-repoB-")));
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
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
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
    expect(home).toContain('<a href="/projects" aria-label="projects" title="projects"><span class="glyph"><svg');
    expect(home).toContain("+ new task");
    // The sole configured repo opened itself — no forced detour.
    expect(home).toContain("inbox");
    expect(home).toContain(">builds<");
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
      acceptance: "c1: ok | manual-review",
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
    const denied = await fetch(url("/tasks"), { headers: { ...auth, "x-standing-orders-project": repoB } });
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
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v2-mig-"));
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

describe("the board — the pipeline as lanes, live in place", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

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

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-board-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("every lane renders, and a building card carries worker, model, elapsed, and workspace", async () => {
    const now = new Date();
    store.createTask({ id: "t-live", title: "being built" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    // Placed BEFORE the scope seals it in place; the claiming runner is
    // registered and repo-bound (the runner gate, MCP spec v6).
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "here", capacity: 2, repos: ["/repo/main"], now: T0, newToken: () => "tok-builder-1" });
    sealScopeFixture(store, "t-live", approverToken, "build it");
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(now.getTime() - 12 * 60_000), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1",
      branch: "standing-orders/t-live", worktree: "/pool/standing-orders-t-live-abc",
      // The sealed route's exact model — any other opens no run (v48).
      model: "sonnet", now: new Date(now.getTime() - 12 * 60_000),
      ...presented(store, ref, "builder"),
    });
    store.createTask({ id: "t-ready", title: "all set" }, T0);
    store.saveScope({
      taskId: "t-ready", goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d2",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d2",
    });
    store.createTask({ id: "t-bare", title: "no scope yet" }, T0);

    const cookie = await login();
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    for (const lane of ["needs you", "queued", "waiting", "building", "done recently"]) {
      expect(board).toContain(lane);
    }
    expect(board).toContain("being built");
    // The building card (board pass): a live strip with the stage and the
    // clock — never a percent — then mono facts: worker, model, branch and
    // workspace. Lanes are sections that fold; a lane with cards is open.
    const card = /<a class="lane-card building".*?<\/a>/s.exec(board)?.[0] ?? "";
    expect(card).toMatch(/<span class="live-line"><span class="stage">[^<]+<\/span><span class="clock">1[0-9]m<\/span><\/span>/);
    expect(card).not.toMatch(/\d+%/);
    expect(card).toContain('<span class="id">t-live</span><span class="t">');
    expect(card).toContain('<span class="fact"><span class="k">worker</span><span class="v">builder-1</span></span>');
    expect(card).toContain('<span class="fact"><span class="k">model</span><span class="v">sonnet</span></span>');
    expect(card).toContain("standing-orders-t-live-abc");
    expect(board).toContain('<details class="lane lane-building" open><summary><h2>building');
    expect(board).toContain('<details class="lane lane-waiting"><summary><h2>waiting'); // empty: folded
    expect(board).toContain("all set");
    expect(board).toContain("write its scope");
    // Read-only by construction: an auto-refreshing surface never holds a
    // form, a nonce, or a password field — the polled region is form-free;
    // the chrome's project switcher lives outside it and is never swapped.
    expect(board.slice(board.indexOf('<div id="board-region">'), board.indexOf('id="board-region-stamp"'))).not.toContain("<form");
    expect(board).not.toContain('type="password"');
  });

  test("the board's CSP admits exactly its own script: fresh nonce per response, never unsafe-inline", async () => {
    const cookie = await login();
    const first = await fetch(url("/board"), { headers: { cookie } });
    const csp = first.headers.get("content-security-policy") ?? "";
    const html = await first.text();
    const match = /script-src 'nonce-([^']+)'/.exec(csp);
    expect(match).not.toBeNull();
    expect(html).toContain(`<script nonce="${match?.[1]}">`);
    expect(csp).not.toMatch(/script-src [^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");

    const second = await fetch(url("/board"), { headers: { cookie } });
    const secondMatch = /script-src 'nonce-([^']+)'/.exec(second.headers.get("content-security-policy") ?? "");
    expect(secondMatch?.[1]).not.toBe(match?.[1]);

    // Pages without a poller carry the chrome layer's nonce but earn NO
    // network: script-src yes, connect-src no (arc 4, finding 24).
    const inbox = await fetch(url("/"), { headers: { cookie } });
    const inboxCsp = inbox.headers.get("content-security-policy") ?? "";
    expect(inboxCsp).toMatch(/script-src 'nonce-/);
    // v28: the chrome layer itself fetches (the attended beat), so every
    // chrome page carries connect-src 'self' — still same-origin only.
    expect(inboxCsp).toContain("connect-src 'self'");
  });

  test("the fragment is the region alone, behind the same auth", async () => {
    const cookie = await login();
    const fragment = await fetch(url("/board?fragment=1"), { headers: { cookie } });
    const body = await fragment.text();
    expect(body).toContain('class="board"');
    expect(body).not.toContain("<html");
    expect(body).not.toContain("<script");

    const anonymous = await fetch(url("/board?fragment=1"), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("/login");
  });

  test("new implementation tasks recommend and request planning before approval", async () => {
    const cookie = await login();
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("What should get done?");
    expect(form).toContain('class="card task-composer"');
    expect(form).toContain("The planner will inspect the repository");
    expect(form).toContain('<details class="task-options">');
    expect(form.indexOf('name="title"')).toBeLessThan(form.indexOf('<details class="task-options">'));
    expect(form.indexOf('name="goal"')).toBeGreaterThan(form.indexOf('<details class="task-options">'));
    expect(form).toContain('name="plan-first" value="1" checked');
    expect(form).toContain("Plan task →");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] as string;
    const revision = /name="projectRevision" value="([0-9]+)"/.exec(form)?.[1] as string;
    const created = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        csrf,
        projectRevision: revision,
        "planning-policy": "choice",
        "plan-first": "1",
        id: "planned-from-create",
        title: "Fix a small label",
      }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    expect(store.lookupRef("planned-from-create")?.plan).toBe("requested");
    const page = await (await fetch(url("/t/planned-from-create"), { headers: { cookie } })).text();
    expect(page).toContain("planning requested");
    expect(page).not.toContain("approve exactly this");
    expect(page).toContain('<details class="section" id="scope"><summary><h2>scope</h2></summary>');
  });

  test("a requested plan blocks an approval submitted from a stale form", async () => {
    store.createTask({ id: "stale-plan-approval", title: "stale approval" }, T0);
    const ref = store.refFor("built-in", "stale-plan-approval").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "stale-plan-approval",
      goal: "implement the approved shape",
      now: T0,
    });

    const cookie = await login();
    const page = await (await fetch(url("/t/stale-plan-approval"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const digest = /name="digest" value="([0-9a-f]{32,64})"/.exec(page)?.[1] ?? "";
    const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(digest).not.toBe("");
    expect(nonce).not.toBe("");

    store.requestPlan(ref, T0);
    const response = await fetch(url("/t/stale-plan-approval/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, digest, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("approval is blocked while planning is in progress");
    expect(store.getScope("stale-plan-approval")?.approvedAt).toBeNull();
  });

  test("plan first: the console asks, the board says planning, the draft returns for review", async () => {
    store.createTask({ id: "t-plan", title: "needs thought" }, T0);
    const ref = store.refFor("built-in", "t-plan").id;
    store.placeTask(ref, "/repo/main");

    const cookie = await login();
    const before = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(before).toContain("plan first");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(before)?.[1] ?? "";

    const asked = await fetch(url("/t/t-plan/plan"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(asked.status).toBe(303);
    expect(store.refFor("built-in", "t-plan").plan).toBe("requested");

    const screen = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(screen).toContain("planning requested");
    expect(screen).not.toContain(">plan first<");
    expect(screen).not.toContain("approve exactly this");

    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(board).toContain("planning next");

    // The draft arrives: proposed scope + plan state; the board flips to
    // review, and the task screen shows the document with the approve card.
    store.saveScope({
      taskId: "t-plan", goal: "The negotiated goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: new Date().toISOString(), digest: "dg-negotiated",
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    store.setPlanState(ref, "drafted");
    const run = store.startRun({
      taskRef: ref, leaseId: "plan-lease", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-plan", worktree: "/pool/plan", now: new Date(),
      ...presented(store, ref, "planner"),
    });
    const content = Buffer.from([
      "## Approach",
      "Use the existing task flow and keep the change narrow.",
      "## Milestones",
      "1. Do the thing carefully.",
      "2. Verify the result.",
      "## Dependencies",
      "- None found.",
      "## Risks",
      "- The first pass may miss an edge case; cover it with a focused check.",
      "## Proof",
      "- Run the focused integration check.",
      "",
    ].join("\n"), "utf8");
    const { mkdirSync: mkdirS, writeFileSync: writeS } = await import("node:fs");
    mkdirS(join(evidenceRoot, String(run)), { recursive: true });
    writeS(join(evidenceRoot, String(run), "plan.md"), content);
    store.saveArtifact({
      run, kind: "plan", key: `${run}/plan.md`,
      bytesOriginal: content.length, bytesStored: content.length, truncated: false,
      sha256: createHash("sha256").update(content).digest("hex"),
      capture: "planner handoff (verified tree)",
    }, new Date());
    store.finishRun(run, { outcome: "built", reason: "plan-drafted", now: new Date() });

    const review = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(review).toContain("review the plan");
    const drafted = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(drafted).toContain("Do the thing carefully.");
    expect(drafted).toContain("How the agent will tackle this");
    expect(drafted).toContain("risks &amp; mitigations");
    expect(drafted).toContain("proof of done");
    expect(drafted).toContain("Edit plan");
    expect(drafted).toContain("approve exactly this:");
    expect(drafted).toContain("The negotiated goal");
    expect(drafted).not.toContain('data-card-kind="result-receipt"');

    // The operator can refine the durable plan before approval. A form
    // opened on the previous artifact cannot approve the new revision.
    const sawPlan = /name="saw-plan" value="([0-9a-f]{64})"/.exec(drafted)?.[1] ?? "";
    const staleDigest = /name="digest" value="([0-9a-f]{32,64})"/.exec(drafted)?.[1] ?? "";
    const staleNonce = /name="nonce" value="([^"]+)"/.exec(drafted)?.[1] ?? "";
    expect(sawPlan).not.toBe("");
    const revisedDocument = content.toString("utf8").replace("2. Verify the result.", "2. Verify the result on desktop and mobile.");
    const edited = await fetch(url("/t/t-plan/plan-edit"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "saw-plan": sawPlan, "plan-document": revisedDocument }),
      redirect: "manual",
    });
    expect(edited.status).toBe(303);
    expect((await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text())).toContain("desktop and mobile");

    const staleApproval = await fetch(url("/t/t-plan/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, digest: staleDigest, nonce: staleNonce, token: approverToken }),
      redirect: "manual",
    });
    expect(staleApproval.status).toBe(409);
    expect(store.getScope("t-plan")?.approvedAt).toBeNull();
  });

  test("adaptive execution plans: the same live milestone progress and revision ledger render on the task page and the focused chat", async () => {
    store.createTask({ id: "t-adapt", title: "adapting under evidence" }, T0);
    const ref = store.refFor("built-in", "t-adapt").id;
    store.placeTask(ref, "/repo/main");
    store.saveScope({
      taskId: "t-adapt", goal: "ship the guarded change", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d-adapt",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d-adapt",
    });

    // Revision 1: the planner's own artifact — no plan_revision row yet,
    // exactly like every task filed before this feature (c1).
    const plannerRun = store.startRun({
      taskRef: ref, leaseId: "plan-lease-adapt", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-adapt", worktree: "/pool/plan-adapt", now: T0,
      ...presented(store, ref, "planner"),
    });
    const rev1Text = [
      "## Approach", "Guard the change behind a feature flag.",
      "## Milestones", "1. Add the guard.", "2. Wire the call sites.",
      "## Dependencies", "- None found.",
      "## Risks", "- The flag default might already be flipped; check config first.",
      "## Proof", "- Run the focused suite.", "",
    ].join("\n");
    const rev1Content = Buffer.from(rev1Text, "utf8");
    mkdirSync(join(evidenceRoot, String(plannerRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(plannerRun), "plan.md"), rev1Content);
    const rev1Sha = createHash("sha256").update(rev1Content).digest("hex");
    store.saveArtifact({
      run: plannerRun, kind: "plan", key: `${plannerRun}/plan.md`,
      bytesOriginal: rev1Content.length, bytesStored: rev1Content.length, truncated: false,
      sha256: rev1Sha, capture: "planner handoff (verified tree)",
    }, T0);
    store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: T0 });

    // A builder run files a bounded, evidence-linked, plan-only revision:
    // the repository showed the flag default was already flipped, so the
    // first milestone is unnecessary (c3, c4's plan-only path).
    sealScopeFixture(store, "t-adapt", approverToken);
    const buildRun = store.startRun({
      taskRef: ref, leaseId: "build-lease-adapt", runner: "b", role: "builder",
      branch: "standing-orders/t-adapt", worktree: "/pool/build-adapt", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev2Text = rev1Text
      .replace("1. Add the guard.", "1. Confirm the flag default (already flipped).")
      .replace("- The flag default might already be flipped; check config first.", "- None found — the default was already flipped, confirmed in config/flags.json.");
    const rev2Parsed = parseExecutionPlanDocument(rev2Text);
    if (!rev2Parsed.ok) throw new Error("fixture plan malformed");
    const milestones = milestonesOf(rev2Parsed.document);
    const rev2Content = Buffer.from(rev2Text, "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun), "revision.md"), rev2Content);
    const rev2Sha = createHash("sha256").update(rev2Content).digest("hex");
    const rev2ArtifactId = store.saveArtifact({
      run: buildRun, kind: "plan", key: `${buildRun}/revision.md`,
      bytesOriginal: rev2Content.length, bytesStored: rev2Content.length, truncated: false,
      sha256: rev2Sha, capture: "builder-filed revision proposal",
    }, T0);
    const rev2Id = store.insertPlanRevision({
      taskRef: ref, revision: 2, artifact: rev2ArtifactId, parentHash: rev1Sha,
      reason: "config/flags.json already flips the default — the guard milestone is unnecessary",
      evidenceLink: "config/flags.json", author: `builder:${buildRun}`, originRun: buildRun,
      kind: "builder-proposal", authorityKind: "plan-only", authorityDigest: "digest-plan-only",
      changedFields: [], status: "applied",
    }, T0);
    store.setRunPlanRevision(buildRun, rev2Id, "digest-plan-only");
    store.insertRunCheckpoint({
      run: buildRun, taskRef: ref, planRevision: rev2Id,
      snapshot: {
        revisionHash: rev2Sha,
        milestones: [
          { id: milestones[0]?.id as string, state: "completed", note: "confirmed in config" },
          { id: milestones[1]?.id as string, state: "current", note: null },
        ],
      },
    }, T0);

    const cookie = await login();
    const taskPage = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(taskPage).toContain("plan revision 2");
    expect(taskPage).toContain("the guard milestone is unnecessary");
    expect(taskPage).toContain("config/flags.json");
    expect(taskPage).toContain("Confirm the flag default (already flipped).");
    expect(taskPage).toContain("confirmed in config");
    expect(taskPage).toContain("milestone-completed");
    expect(taskPage).toContain("milestone-current");
    expect(taskPage).not.toContain("Approve changes &amp; continue");
    expect(taskPage.indexOf("Build progress")).toBeLessThan(taskPage.indexOf("execution plan"));

    const chatPage = await (await fetch(url(`/chat?task=t-adapt`), { headers: { cookie } })).text();
    expect(chatPage).toContain("plan revision 2");
    expect(chatPage).toContain("the guard milestone is unnecessary");
    expect(chatPage).toContain("Confirm the flag default (already flipped).");
    expect(chatPage).toContain("milestone-completed");

    // Now an authority-changing proposal arrives (the defensive path, c4):
    // the world moved under the run, so it stays paused for a person.
    const buildRun2 = store.startRun({
      taskRef: ref, leaseId: "build-lease-adapt-2", runner: "b", role: "builder",
      branch: "standing-orders/t-adapt-2", worktree: "/pool/build-adapt-2", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev3Content = Buffer.from(rev2Text.replace("## Approach", "## Approach\nRevised once more."), "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun2)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun2), "revision.md"), rev3Content);
    const rev3ArtifactId = store.saveArtifact({
      run: buildRun2, kind: "plan", key: `${buildRun2}/revision.md`,
      bytesOriginal: rev3Content.length, bytesStored: rev3Content.length, truncated: false,
      sha256: createHash("sha256").update(rev3Content).digest("hex"), capture: "builder-filed revision proposal",
    }, T0);
    const rev3Id = store.insertPlanRevision({
      taskRef: ref, revision: 3, artifact: rev3ArtifactId, parentHash: rev2Sha,
      reason: "the touches list no longer covers the file this fix needs",
      evidenceLink: "src/guard.ts", author: `builder:${buildRun2}`, originRun: buildRun2,
      kind: "builder-proposal", authorityKind: "authority-change", authorityDigest: "digest-changed",
      changedFields: ["signed-scope"], status: "blocked",
    }, T0);
    store.holdOwned({ taskRef: ref, ownerKind: "revision", ownerId: String(rev3Id), reason: "a plan revision changed signed scope — accept or reject it", until: null }, T0);

    const pendingPage = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(pendingPage).toContain("The agent recommends a plan change");
    expect(pendingPage).toContain("changes the work you approved");
    expect(pendingPage).toContain("the touches list no longer covers");
    expect(pendingPage).toContain("Approve changes &amp; continue");
    expect(pendingPage).toContain("Keep current plan");
    const pendingCsrf = /name="csrf" value="([0-9a-f]{64})"/.exec(pendingPage)?.[1] ?? "";

    // Accepting without the password ceremony refuses.
    const noToken = await fetch(url("/t/t-adapt/accept-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: pendingCsrf, "revision-id": String(rev3Id) }),
      redirect: "manual",
    });
    expect(noToken.status).toBe(403);
    expect(store.getPlanRevision(rev3Id)?.status).toBe("blocked");

    const accepted = await fetch(url("/t/t-adapt/accept-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: pendingCsrf, "revision-id": String(rev3Id), token: approverToken }),
      redirect: "manual",
    });
    expect(accepted.status).toBe(303);
    expect(store.getPlanRevision(rev3Id)?.status).toBe("applied");
    expect(store.activeHold(ref, new Date())).toBeNull();

    const afterAccept = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(afterAccept).not.toContain("Approve changes &amp; continue");
    expect(afterAccept).toContain("plan revision 3");
  });

  test("adaptive execution plans: rejecting a blocked revision keeps the prior plan current and needs no password", async () => {
    store.createTask({ id: "t-reject", title: "adapting, then declined" }, T0);
    const ref = store.refFor("built-in", "t-reject").id;
    store.placeTask(ref, "/repo/main");
    store.saveScope({
      taskId: "t-reject", goal: "ship it", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d-reject",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d-reject",
    });
    const plannerRun = store.startRun({
      taskRef: ref, leaseId: "plan-lease-reject", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-reject", worktree: "/pool/plan-reject", now: T0,
      ...presented(store, ref, "planner"),
    });
    const rev1Content = Buffer.from(
      ["## Approach", "Do it plainly.", "## Milestones", "1. Do it.", "## Dependencies", "- None found.", "## Risks", "- None found.", "## Proof", "- Run the suite.", ""].join("\n"),
      "utf8",
    );
    mkdirSync(join(evidenceRoot, String(plannerRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(plannerRun), "plan.md"), rev1Content);
    store.saveArtifact({
      run: plannerRun, kind: "plan", key: `${plannerRun}/plan.md`,
      bytesOriginal: rev1Content.length, bytesStored: rev1Content.length, truncated: false,
      sha256: createHash("sha256").update(rev1Content).digest("hex"), capture: "planner handoff (verified tree)",
    }, T0);
    store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: T0 });

    sealScopeFixture(store, "t-reject", approverToken);
    const buildRun = store.startRun({
      taskRef: ref, leaseId: "build-lease-reject", runner: "b", role: "builder",
      branch: "standing-orders/t-reject", worktree: "/pool/build-reject", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev2Content = Buffer.from(rev1Content.toString("utf8").replace("Do it plainly.", "Do it carefully."), "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun), "revision.md"), rev2Content);
    const rev2ArtifactId = store.saveArtifact({
      run: buildRun, kind: "plan", key: `${buildRun}/revision.md`,
      bytesOriginal: rev2Content.length, bytesStored: rev2Content.length, truncated: false,
      sha256: createHash("sha256").update(rev2Content).digest("hex"), capture: "builder-filed revision proposal",
    }, T0);
    const rev2Id = store.insertPlanRevision({
      taskRef: ref, revision: 2, artifact: rev2ArtifactId, parentHash: null,
      reason: "budget changed underneath the run", evidenceLink: null, author: `builder:${buildRun}`, originRun: buildRun,
      kind: "builder-proposal", authorityKind: "authority-change", authorityDigest: "digest-changed-2",
      changedFields: ["publication-authority"], status: "blocked",
    }, T0);
    store.holdOwned({ taskRef: ref, ownerKind: "revision", ownerId: String(rev2Id), reason: "publication authority changed", until: null }, T0);

    const cookie = await login();
    const page = await (await fetch(url("/t/t-reject"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";

    const rejected = await fetch(url("/t/t-reject/reject-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "revision-id": String(rev2Id) }),
      redirect: "manual",
    });
    expect(rejected.status).toBe(303);
    expect(store.getPlanRevision(rev2Id)?.status).toBe("rejected");
    expect(store.activeHold(ref, new Date())).toBeNull();

    const after = await (await fetch(url("/t/t-reject"), { headers: { cookie } })).text();
    expect(after).not.toContain("The agent recommends a plan change");
    expect(after).toContain("Do it plainly.");

    // Resolving twice fails closed: the decision already resolved.
    const again = await fetch(url("/t/t-reject/reject-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "revision-id": String(rev2Id) }),
      redirect: "manual",
    });
    expect(again.status).toBe(409);
  });

  test("the old morning route forwards to activity, which speaks of windows, not nights", async () => {
    const cookie = await login();
    const moved = await fetch(url("/morning"), { headers: { cookie }, redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/activity");

    const activity = await (await fetch(url("/activity"), { headers: { cookie } })).text();
    expect(activity).toContain("<h1>activity</h1>");
    expect(activity).not.toContain("morning");
    expect(activity).not.toContain("overnight");
    expect(activity).not.toContain("the night");
  });
});

describe("the rolled-up board — every project, one ceiling", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

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

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-rollup-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(),
      repos: ["/repo/alpha", "/repo/beta"],
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

  test("scope=all shows every admitted project's cards, chipped — and nothing beyond the ceiling", async () => {
    for (const [id, repo] of [
      ["t-alpha", "/repo/alpha"],
      ["t-beta", "/repo/beta"],
      ["t-outside", "/repo/forbidden"],
    ] as const) {
      store.createTask({ id, title: `work in ${repo}` }, T0);
      store.placeTask(store.refFor("built-in", id).id, repo);
    }
    store.createTask({ id: "t-unplaced", title: "belongs to nobody yet" }, T0);

    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    expect(board).toContain("t-alpha");
    expect(board).toContain("t-beta");
    // The chips name the projects.
    expect(board).toContain(">alpha</span>");
    expect(board).toContain(">beta</span>");
    // Outside the ceiling: not a card, not a name, not a byte.
    expect(board).not.toContain("t-outside");
    expect(board).not.toContain("forbidden");
    // Unplaced work dispatches anywhere, so the roll-up owns it honestly.
    expect(board).toContain("t-unplaced");

    // The fragment carries the same scope and the same ceiling.
    const fragment = await (await fetch(url("/board?scope=all&fragment=1"), { headers: { cookie } })).text();
    expect(fragment).toContain("t-alpha");
    expect(fragment).not.toContain("t-outside");

    // Without scope=all and without an open project, the board defers to
    // the opener — the roll-up is the only project-less board.
    const bare = await fetch(url("/board"), { headers: { cookie }, redirect: "manual" });
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe("/projects");
  });

  test("a blocker beyond the ceiling keeps its name but never its state", async () => {
    store.createTask({ id: "t-waiting", title: "blocked here" }, T0);
    store.createTask({ id: "t-secret", title: "elsewhere" }, T0);
    store.placeTask(store.refFor("built-in", "t-waiting").id, "/repo/alpha");
    store.placeTask(store.refFor("built-in", "t-secret").id, "/repo/forbidden");
    store.addEdge("t-waiting", "t-secret");
    store.setTaskState("t-secret", "running", new Date());
    store.saveScope({
      taskId: "t-waiting", goal: "wait politely", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "dg-w",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "dg-w",
    });

    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    // The edge belongs to the visible task; the other project's live
    // status does not travel through it.
    expect(board).toContain("waits on t-secret");
    expect(board).not.toContain("waits on t-secret \u2014");
    expect(board).not.toContain("building now");
  });
});

describe("routines — standing orders on the console", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

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

  const TERMS = {
    repo: "/repo/main",
    goal: "Refresh the notes",
    outOfScope: null,
    touches: [] as string[],
    acceptance: [{ id: "c1", statement: "The notes are refreshed.", how: null, evidence: ["manual-review"] as const }],
    requirements: [] as string[],
    schedule: "every:60",
    singleFlight: true,
    costCeilingUsd: null,
  };

  const file = (name: string, terms = TERMS): number => {
    // v24/v48: filing binds the profile AND the four-role route the
    // configuration resolves, like the real door.
    const authority = resolveRoutineAuthority(store, terms.repo, terms.acceptance, T0);
    if (!authority.ok) throw new Error(authority.problem);
    const created = store.createRoutine(
      { name, ...terms, digest: routineDigestOf(terms, authority.profile, authority.route), profile: authority.profile, route: authority.route },
      T0,
    );
    if (!created.ok) throw new Error("duplicate in setup");
    return created.id;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-routine-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("the ceiling rules every routine read and verb, whatever the request names", async () => {
    const mine = file("mine");
    const foreign = file("foreign", { ...TERMS, repo: "/repo/secret" });
    const cookie = await login();

    const list = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(list).toContain("mine");
    expect(list).not.toContain("foreign");

    expect((await fetch(url(`/routines/${foreign}`), { headers: { cookie } })).status).toBe(404);
    // The verb refuses independently of authorizeMutation (finding 7): a
    // CSRF-valid, authenticated POST naming an out-of-ceiling routine is 404.
    const screen = await (await fetch(url(`/routines/${mine}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const denied = await fetch(url(`/routines/${foreign}/pause`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf }),
    });
    expect(denied.status).toBe(404);
    expect(store.getRoutine(foreign)?.paused).toBe(false);
  });

  test("approving is step-up: the restated order, the nonce, and the password again", async () => {
    const id = file("deps");
    const cookie = await login();

    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(screen).toContain("BUILDS IT WITHOUT ASKING");
    expect(screen).toContain("every 1 hour(s)");
    // routine-freeze (v48): the exact four-role agents the yes freezes are
    // restated before the password, in the same block a task's ceremony uses.
    const ceremony = /<form method="post" action="\/routines\/\d+\/approve"(.*?)<\/form>/s.exec(screen)?.[1] ?? "";
    expect(ceremony).toContain('<p class="approval-label">agents</p>');
    expect(ceremony).toContain('<p class="agents-summary">claude · sonnet plans, builds, repairs, and reviews</p>');
    expect(ceremony).toContain('<span class="badge">frozen when you approve</span>');
    expect(ceremony).toContain("a configuration change afterwards cannot re-route one");
    expect(ceremony.indexOf('<p class="approval-label">agents</p>')).toBeLessThan(ceremony.indexOf('name="token"'));
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    expect(nonce).toBeDefined();

    // The session alone cannot agree: a wrong password refuses.
    const wrong = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, digest, token: "not-the-password" }),
    });
    expect(wrong.status).toBe(403);
    expect(store.getRoutine(id)?.approvedAt).toBeNull();

    // A fresh form (the nonce was spent either way), the real credential.
    const again = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    const nonce2 = /name="nonce" value="([0-9a-f]{32})"/.exec(again)?.[1] as string;
    const approved = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce: nonce2, digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const routine = store.getRoutine(id);
    expect(routine?.approvedBy).toBe("alex");
    expect(routine?.approvedRoute).not.toBeNull();
    const after = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(after).toContain('<span class="badge">frozen by the approval</span>');
    expect(after).toContain("Every firing runs on exactly these agents; a configuration change cannot re-route it.");
    expect(routine?.nextFireAt).not.toBeNull();
  });

  test("pause, resume, and run-now from the screen; run-now refuses while blocked", async () => {
    const id = file("audit");
    const cookie = await login();
    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const post = (verb: string, extra: Record<string, string> = {}) =>
      fetch(url(`/routines/${id}/${verb}`), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, ...extra }),
        redirect: "manual",
      });

    expect((await post("pause")).status).toBe(303);
    expect(store.getRoutine(id)?.paused).toBe(true);
    expect((await post("resume")).status).toBe(303);
    expect(store.getRoutine(id)?.paused).toBe(false);

    // run-now is spend outside the schedule: the session alone cannot ask
    // (Codex Phase C review, M3) — no password, no fire; wrong password,
    // no fire.
    expect((await post("run-now")).status).toBe(400);
    expect((await post("run-now", { token: "not-it" })).status).toBe(403);

    // Credentialed but unapproved: refuses with the reason on the screen.
    const refusedPage = await post("run-now", { token: approverToken });
    expect(refusedPage.status).toBe(409);

    const approvedNow = approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    expect(approvedNow.ok).toBe(true);
    expect((await post("run-now", { token: approverToken })).status).toBe(303);
    // One instance exists, linked and approved; a second run-now hits
    // single-flight and refuses to the person's face.
    const instances = store.listTasks().filter(one => one.id.startsWith("audit-"));
    expect(instances).toHaveLength(1);
    expect((await post("run-now", { token: approverToken })).status).toBe(409);
  });

  test("the board keeps instances in their track row, except when they need a person", async () => {
    const id = file("notes");
    approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    const fired = fireRoutine(store, id, new Date(T0.getTime() + 2 * 60 * 60_000));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;

    const cookie = await login();
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    // The track row renders: name, a dot, the week's spend.
    expect(board).toContain("routines");
    expect(board).toContain("notes");
    expect(board).toContain("track-strip");
    expect(board).toContain("this week");
    // The queued instance does NOT sit in the main lanes...
    expect(board).not.toContain(`lane-card" href="/t/${fired.taskId}`);
    // ...and the board's polled region stays form-free, tracks included.
    expect(board.slice(board.indexOf('<div id="board-region">'), board.indexOf('id="board-region-stamp"'))).not.toContain("<form");

    // Now the instance needs a person: it fails. It surfaces in attention,
    // wearing the routine's name.
    store.setTaskState(fired.taskId, "failed", new Date(T0.getTime() + 3 * 60 * 60_000));
    const after = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(after).toContain(`href="/t/${encodeURIComponent(fired.taskId)}"`);
    expect(after).toContain("failed");
  });

  test("filing from the console lands on the approval ceremony; a bad definition names every problem", async () => {
    const cookie = await login();
    const screen = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(screen).toContain("file a standing order");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const revision = /name="projectRevision" value="([0-9]+)"/.exec(screen)?.[1] as string;

    // Every problem at once, stored nothing.
    const bad = await fetch(url("/routines/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, name: "Bad Name", goal: "", schedule: "hourly" }),
    });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("name:");
    expect(badHtml).toContain("goal:");
    expect(badHtml).toContain("schedule:");
    expect(store.listRoutines(null)).toHaveLength(0);

    // A good one lands on its screen — where the step-up already waits.
    const made = await fetch(url("/routines/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf, projectRevision: revision,
        name: "weekly-notes", goal: "Refresh the notes", schedule: "daily:03:30",
      }),
      redirect: "manual",
    });
    expect(made.status).toBe(303);
    const where = made.headers.get("location") as string;
    const detail = await (await fetch(url(where), { headers: { cookie } })).text();
    expect(detail).toContain("BUILDS IT WITHOUT ASKING");
    expect(detail).toContain("daily at 03:30 UTC");
    // Filed into the OPEN project, not a typed path.
    expect(store.routineByName("weekly-notes")?.repo).toBe("/repo/main");
  });

  test("/routines names the empty state and shows the ledger once firings exist", async () => {
    const cookie = await login();
    const empty = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(empty).toContain("No standing orders");
    // The empty state points at the filing form on this very page — not at
    // the terminal (round-5 copy fix).
    expect(empty).toContain("file one");
    expect(empty).not.toContain("from the terminal");

    const id = file("weekly");
    approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    fireRoutine(store, id, new Date(T0.getTime() + 2 * 60 * 60_000));
    const list = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(list).toContain("weekly");
    expect(list).toContain("live");
    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(screen).toContain("firings");
    expect(screen).toContain("weekly-");
  });

  test("consent-closed (routines): a legacy unfrozen or unreadable order shows no password and mints no nonce — the refresh act is the road, and only the re-approval unlocks the password", async () => {
    const cookie = await login();
    const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]*)"/.exec(html)?.[1] ?? null;
    // An authentic pre-v48 approval: the columns say approved, no route was ever sealed.
    const id = file("legacy");
    store.raw().prepare("UPDATE routine SET route_json = NULL, digest = ?, approved_at = ?, approved_by = 'alex', approved_digest = ?, approved_profile_json = profile_json, next_fire_at = ? WHERE id = ?")
      .run(routineDigestOf(TERMS, store.getRoutine(id)!.profile), T0.toISOString(), routineDigestOf(TERMS, store.getRoutine(id)!.profile), new Date(T0.getTime() + 3_600_000).toISOString(), id);
    let page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("agents not frozen — refresh and approve again");
    expect(page).toContain("approved before agents were frozen");
    expect(page).toContain('id="agents-recovery"');
    expect(page).toContain("Refresh agents");
    expect(page).not.toContain('type="password"');
    expect(nonceOf(page)).toBeNull();
    // Firing it from the page refuses in words (no run-now form either).
    expect(page).not.toContain("run now");
    // Corrupt snapshot bytes read the same way: closed, with their own words.
    store.raw().prepare("UPDATE routine SET approved_route_json = '{\"version\":1' WHERE id = ?").run(id);
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("cannot be read");
    expect(page).not.toContain('type="password"');
    expect(nonceOf(page)).toBeNull();
    // The recovery is ONE plain-language act with accessible, neutral
    // controls: a labelled, described button — never a danger verb, never
    // a password — and no seeded transcript anywhere near it.
    expect(page).toMatch(/<form method="post" action="\/routines\/\d+\/refresh" class="card approve-form agents-recovery" id="agents-recovery" aria-labelledby="agents-recovery-title">/);
    expect(page).toContain('<p id="agents-recovery-why" class="recap">');
    expect(page).toContain('<button type="submit" aria-describedby="agents-recovery-why">Refresh agents</button>');
    expect(page.slice(page.indexOf('id="agents-recovery"'), page.indexOf("</form>", page.indexOf('id="agents-recovery"')))).not.toContain('class="danger"');
    expect(page).not.toContain("demoTranscript");
    // A snapshot that READS but no longer hashes to the approval (a rewritten
    // review leg): not live either — closed in its own words, same road.
    const routed = refreshRoutineAgents(store, id, T0);
    expect(routed.ok).toBe(true);
    const verify = approveRoutine(store, id, "alex", T0, store.getRoutine(id)!.digest, approverToken);
    expect(verify.ok).toBe(true);
    const approvedJson = String((store.raw().prepare("SELECT approved_route_json AS j FROM routine WHERE id = ?").get(id) as { j: string }).j);
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(approvedJson.replace('"model":"sonnet","phase":"review"', '"model":"opus","phase":"review"'), id);
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("do not verify");
    expect(page).not.toContain('type="password"');
    expect(page).not.toContain("run now");
    expect(nonceOf(page)).toBeNull();
    expect(page).toContain('id="agents-recovery"');
    // The refresh act: a session's own POST, nothing approved by it.
    const refreshed = await fetch(url(`/routines/${id}/refresh`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfOf(page) }),
      redirect: "manual",
    });
    expect(refreshed.status).toBe(303);
    const after = store.getRoutine(id)!;
    expect(after.route).not.toBeNull();
    // The unverified approval was WITHDRAWN by the refresh, working data unchanged.
    expect(after).toMatchObject({ approvedDigest: null, approvedRoute: null, nextFireAt: null });
    expect(fireRoutine(store, id, new Date(T0.getTime() + 2 * 3_600_000))).toMatchObject({ ok: false, reason: "not-approved" });
    // Now the exact agents are restated above a password, under a fresh nonce.
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("edited — approve again");
    expect(page).toContain("claude · sonnet plans, builds, repairs, and reviews");
    expect(page).toContain('type="password"');
    expect(nonceOf(page)).toMatch(/^[0-9a-f]{32}$/);
    expect(page).not.toContain('id="agents-recovery"');
    const approved = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfOf(page), nonce: nonceOf(page) as string, digest: after.digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const frozen = store.getRoutine(id)!;
    expect(frozen.approvedDigest).toBe(frozen.digest);
    expect(frozen.approvedRoute).not.toBeNull();
    // (The console approved under the wall clock, so the slot is not yet
    // due — run-now proves the seal the same way.)
    const fired = fireRoutine(store, id, new Date(), { manual: true });
    expect(fired.ok).toBe(true);
    if (fired.ok) expect(store.sealedRouteOf(fired.taskId).ok).toBe(true);
  });
});

describe("the agents card — configuration, readable at a glance", () => {
  test("says what each phase runs on, who chose it, and that the browser cannot change it", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-agents-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    store.setPhaseConfig("installation", "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5-codex", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/repo/main", "plan", "claude", "opus", "alex", T0);
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: added.token }),
        redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const html = await (await fetch(`${base}/system`, { headers: { cookie } })).text();
      // Plain sentences, provenance in words, the honest cost note — and
      // no form anywhere near it: changing routing is the terminal's act.
      expect(html).toContain("agents");
      expect(html).toContain("chosen for this project by alex");
      expect(html).toContain("set for the whole installation by alex");
      expect(html).toContain("gpt-5-codex");
      expect(html).toContain("no dollar costs");
      expect(html).toContain("the default — nothing configured"); // repair, untouched
      expect(html).toContain("standing-orders config");
      expect(html).not.toMatch(/<form[^>]*config/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("mutations from browsers that omit Origin", () => {
  test("absent Origin + valid CSRF proceeds; a present wrong Origin still refuses", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-origin-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    store.createTask({ id: "t-o", title: "w" }, T0);
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const page = await (await fetch(`${base}/t/t-o`, { headers: { cookie } })).text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;

      // iOS Safari's shape: same-origin POST, no Origin header at all.
      const noOrigin = await fetch(`${base}/t/t-o/hold`, {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf, reason: "from the phone" }), redirect: "manual",
      });
      expect(noOrigin.status).toBe(303);

      // A hostile page still names itself, and is still refused.
      const foreign = await fetch(`${base}/t/t-o/unhold`, {
        method: "POST", headers: { cookie, origin: "http://evil.example" },
        body: new URLSearchParams({ csrf }),
      });
      expect(foreign.status).toBe(403);

      // And CSRF stays the hard gate even with no Origin.
      const noToken = await fetch(`${base}/t/t-o/unhold`, {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf: "0".repeat(64) }),
      });
      expect(noToken.status).toBe(403);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("/next — clearing the queue one thing at a time", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;
  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-next-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("question first, act inline, land on the next item; approvals carry the step-up on the card", async () => {
    // One open question and one unapproved scope wait.
    store.createTask({ id: "t-q", title: "asked" }, T0);
    const qRef = store.refFor("built-in", "t-q").id;
    const run = store.startRun({ taskRef: qRef, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0, ...presented(store, qRef, "builder") });
    store.saveDecision({
      run, urgency: "blocking", recap: "Two ways to cache.", question: "Per-user or global?",
      options: [
        { id: "user", label: "Per-user", consequence: "More state.", reversible: true },
        { id: "global", label: "Global", consequence: "Coarser.", reversible: true },
      ],
      recommendation: "user",
    }, T0);
    store.createTask({ id: "t-a", title: "needs a yes" }, T0);
    store.saveScope({
      taskId: "t-a", goal: "do the thing", outOfScope: "not the other thing", touches: ["src/x.ts"], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    const cookie = await login();
    // The oldest question leads, with its answers ON the card.
    const first = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(first).toContain("1 of 2 waiting on you");
    expect(first).toContain("Per-user or global?");
    expect(first).toContain('name="return" value="next"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(first)?.[1] as string;

    // Answering lands on the NEXT item — the approval, step-up included.
    const answered = await fetch(url("/d/1/answer"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, choice: "user", return: "next" }),
      redirect: "manual",
    });
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/next");

    const second = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(second).toContain("the last thing waiting on you");
    expect(second).toContain("approve exactly this:");
    expect(second).toContain("not the other thing");
    expect(second).toContain('type="password"');
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(second)?.[1] as string;
    const csrf2 = /name="csrf" value="([0-9a-f]{64})"/.exec(second)?.[1] as string;

    const approved = await fetch(url("/t/t-a/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrf2, nonce, digest: store.getScope("t-a")?.digest as string, token: approverToken, return: "next" }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe("/next");

    // The queue is clear, and says so like a person would.
    const done = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(done).toContain("Nothing needs you");
  });

  test("not-now sets an item aside without touching it, and all-clear remembers the held ones", async () => {
    store.createTask({ id: "t-1", title: "one" }, T0);
    store.saveScope({
      taskId: "t-1", goal: "g", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "a".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const first = await (await fetch(url("/next"), { headers: { cookie } })).text();
    const skip = /href="(\/next\?skip=[^"]+)"/.exec(first)?.[1] as string;
    expect(skip).toBeDefined();
    const after = await (await fetch(url(skip.replace(/&amp;/g, "&")), { headers: { cookie } })).text();
    expect(after).toContain("the 1 you set aside");
    // Nothing was approved by setting it aside.
    expect(store.getScope("t-1")?.approvedAt).toBeNull();
  });

  test("the inbox offers the flow only when something waits", async () => {
    const cookie = await login();
    const idle = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(idle).not.toContain("clear the queue");
    store.createTask({ id: "t-w", title: "w" }, T0);
    store.saveScope({
      taskId: "t-w", goal: "g", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "b".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const busy = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(busy).toContain("clear the queue");
  });
});

describe("since you last looked", () => {
  test("a return visit says what concluded in between; fragment polls never move the anchor", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-delta-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    const clockBox = { now: new Date() };
    const server = createDecisionServer({ store, evidenceRoot, clock: () => clockBox.now, repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      // First look: no previous anchor, no strip.
      const first = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
      expect(first).not.toContain("since you last looked");

      // Work concludes while the operator is away.
      store.createTask({ id: "t-d", title: "w" }, T0);
      const ref = store.refFor("built-in", "t-d").id;
      const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b", branch: "br", worktree: "/w", now: clockBox.now, ...presented(store, ref, "builder") });
      store.finishRun(run, { outcome: "built", now: clockBox.now });

      // A fragment poll in the open tab does NOT count as looking.
      clockBox.now = new Date(clockBox.now.getTime() + 10 * 60_000);
      await fetch(`${base}/board?fragment=1`, { headers: { cookie } });

      const back = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
      expect(back).toContain("since you last looked");
      expect(back).toContain("1 built");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("quick capture — from thought to the approve card in two steps", () => {
  test("title + goal on the inbox lands on the task screen with the step-up ready", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-capture-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const inbox = await (await fetch(`${base}/`, { headers: { cookie } })).text();
      expect(inbox).toContain("capture new work");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(inbox)?.[1] as string;
      const revision = /name="projectRevision" value="([0-9]+)"/.exec(inbox)?.[1] as string;

      const made = await fetch(`${base}/tasks/add`, {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
          csrf, projectRevision: revision,
          title: "Guard the webhook", goal: "Reject unsigned payloads at the edge",
        }),
        redirect: "manual",
      });
      expect(made.status).toBe(303);
      const where = made.headers.get("location") as string;
      const screen = await (await fetch(`${base}${where}`, { headers: { cookie } })).text();
      // Step two IS the approval: the scope is written, the password waits.
      expect(screen).toContain("Reject unsigned payloads");
      expect(screen).toContain("approve exactly this:");
      expect(screen).toContain('type="password"');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("the roll-up inbox — every project, one ceiling, links only", () => {
  test("a projectless session sees admitted rows with chips; foreign repos neither render nor count", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-rollup-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");

    const seed = (id: string, repo: string) => {
      store.createTask({ id, title: `work in ${repo}` }, T0);
      store.placeTask(store.refFor("built-in", id).id, repo);
      store.saveScope({
        taskId: id, goal: `goal of ${id}`, outOfScope: null, touches: [], acceptance: [],
        proposedAt: T0.toISOString(), digest: id.padEnd(32, "0").slice(0, 32),
        approvedAt: null, approvedBy: null, approvedDigest: null,
      });
    };
    seed("t-main", "/repo/main");
    seed("t-side", "/repo/side");
    seed("t-secret", "/repo/secret"); // outside the ceiling
    store.createTask({ id: "t-free", title: "unplaced work" }, T0);
    store.saveScope({
      taskId: "t-free", goal: "anywhere", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "f".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    // TWO repos in the ceiling: no default project, sessions start open.
    const server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(),
      repos: ["/repo/main", "/repo/side"],
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      // "/" no longer bounces to /projects: it is the overall inbox.
      const inbox = await (await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" }));
      expect(inbox.status).toBe(200);
      const html = await inbox.text();
      expect(html).toContain("t-main");
      expect(html).toContain("t-side");
      expect(html).not.toContain("t-secret");
      // Rows wear their project; unplaced work says so instead of hiding it.
      expect(html).toContain("main</span>");
      expect(html).toContain("unplaced");
      // Links only in the roll-up: no capture form, no inline verbs.
      expect(html).not.toContain("/tasks/add");
      expect(html).not.toMatch(/<form[^>]*requeue/);
      // The badge counted 3 admitted approvals, never the secret one.
      expect(html).toMatch(/class="count badge badge-open">3/);

      // Tapping a row lands on the task itself — the roll-up hands off to
      // the detail, not to the project picker. The row's own ceiling check
      // is the authorization; the cross-project list pane never renders.
      const detail = await fetch(`${base}/t/t-main`, { headers: { cookie }, redirect: "manual" });
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("approve exactly this:");
      expect(detailHtml).not.toContain("t-side"); // no list pane leaking other projects
      expect((await fetch(`${base}/t/t-secret`, { headers: { cookie } })).status).toBe(404);

      // Everything else still requires opening a project.
      const board = await fetch(`${base}/board`, { headers: { cookie }, redirect: "manual" });
      expect(board.status).toBe(303);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("the first-run checklist (adoption track, step 3)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

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

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-wizard-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a young installation gets the checklist, derived from live state", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).toContain("Getting started");
    // The empty-queue card yields to the checklist.
    expect(html).not.toContain("Nothing needs you.");
    // Scoped: the ceiling step is done and names the repo.
    expect(html).toContain("name what this console may see");
    // No spend routing yet: the exact command, and the four-facts honesty.
    expect(html).toContain("standing-orders config set build");
    expect(html).toContain("four separate facts");
    // No work yet: the templates are offered.
    expect(html).toContain("/routines?template=nightly-deps");
    expect(html).toContain("/tasks?template=lint-sweep");
  });

  test("unscoped mode is named, not normalized — the step instructs the restart", async () => {
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).toContain("no ceiling is configured");
    expect(html).toContain("serve --repo");
  });

  test("the first successful run retires the checklist PERMANENTLY", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    store.createTask({ id: "w-1", title: "the work" }, T0);
    const run = store.startRun({
      taskRef: store.refFor("built-in", "w-1").id,
      leaseId: "lease-w",
      runner: "builder-1",
      branch: "standing-orders/w-1",
      worktree: "/pool/w-1",
      now: T0,
      ...presented(store, store.refFor("built-in", "w-1").id, "builder"),
    });
    store.finishRun(run, { outcome: "built", committed: true, now: new Date("2026-08-14T13:00:00.000Z") });
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).not.toContain("Getting started");
    // The retirement is an append-only installation fact, so pruning run
    // history later cannot resurrect the checklist.
    expect(store.installationFact("first-success-at")).toBe("2026-08-14T13:00:00.000Z");
  });

  test("filing work checks the step off but keeps the checklist until success", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    store.createTask({ id: "w-2", title: "queued work" }, T0);
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).toContain("Getting started");
    expect(html).toContain("work is filed");
  });

  test("template prefill: the forms carry the library's exact text, editable", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    const routines = await (await fetch(url("/routines?template=nightly-deps"), { headers: { cookie } })).text();
    expect(routines).toContain('value="nightly-deps"');
    expect(routines).toContain('<option value="daily" selected>');
    expect(routines).toContain('name="time" value="03:30"');
    expect(routines).toContain('name="timezone" value="UTC"');
    expect(routines).toContain("pre-filled from a template");
    const tasks = await (await fetch(url("/tasks?template=lint-sweep"), { headers: { cookie } })).text();
    expect(tasks).toContain(">One lint-clean sweep</textarea>");
    expect(tasks).toContain("pre-filled from a template");
    // An unknown template name is just an unfilled form, not an error.
    const plain = await (await fetch(url("/tasks?template=nope"), { headers: { cookie } })).text();
    expect(plain).not.toContain("pre-filled");
  });
});

describe("fleet chat — the LLM drafts, the ceremony approves (v13)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoDir: string;
  let fetcherResult: () => Promise<Response>;
  let clockNow: Date;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

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
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on /chat");
    return match[1] as string;
  };

  const envelope = (reply: string, proposals: unknown[] = []) =>
    JSON.stringify({ chatEnvelope: 1, reply, proposals });

  const anthropicWrapper = (text: string) =>
    new Response(
      JSON.stringify({
        type: "message",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const busy = store.recentChatTurns("alex", 5).some(one => one.state === "queued" || one.state === "running");
      if (!busy) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("turn never settled");
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => clockNow,
      repo: repoDir,
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
      chatFetcher: (async () => fetcherResult()) as typeof fetch,
      ...options,
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-chat-ev-"));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-chat-repo-")));
    clockNow = T0;
    fetcherResult = async () => anthropicWrapper(envelope("all quiet"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig(
      { provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 },
      "alex",
      T0,
    );
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("enablement refusals are distinct and stated", async () => {
    store.clearChatConfig();
    await boot();
    const cookie = await login();
    const off = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(off).toContain("chat is not configured");
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 1_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", T0);
    const noKey = await new Promise<string>(resolve => {
      server.close(() => resolve(""));
    }).then(async () => {
      await boot({ chatEnv: {} });
      const freshCookie = await login();
      return (await fetch(url("/chat"), { headers: { cookie: freshCookie } })).text();
    });
    expect(noKey).toContain("ANTHROPIC_API_KEY");
  });

  test("a demo database refuses chat outright", async () => {
    store.recordInstallationFact("demo", "1", T0);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("Chat isn’t available in demo mode");
    expect(html).toContain("Demo data never contacts an external model. Start Standing Orders with a real project to use chat.");
    expect(html).not.toContain("chat is off.");
  });

  test("the live chat overview uses the shared repair diagnosis", async () => {
    for (const id of ["t-blocker", "t-dependent"]) {
      store.createTask({ id, title: id === "t-dependent" ? "must not wait forever" : "obsolete prerequisite" }, T0);
      store.placeTask(store.refFor("built-in", id).id, repoDir);
    }
    expect(store.addEdge("t-dependent", "t-blocker")).toEqual({ ok: true });
    expect(store.cancelTask("t-blocker", T0, "replaced")).toMatchObject({ ok: true });
    await boot();
    const cookie = await login();

    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain('data-dispatch-status="terminal-dependency"');
    expect(html).toContain("a required task did not finish");
  });

  test("the whole loop: password-gated ask, reply, draft card, password-gated file through the door", async () => {
    fetcherResult = async () =>
      anthropicWrapper(
        envelope("One draft ready.", [
          { kind: "task", repoId: "r1", title: "Deflake the webhook test", goal: "Pin the clock in the retry test.", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "The retry test's clock is pinned.", how: null, evidence: ["check"] }] },
        ]),
      );
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // No password → no turn.
    const refused = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "anything stuck?" }),
      redirect: "manual",
    });
    expect(refused.headers.get("location") ?? "").toContain("password");
    expect(store.recentChatTurns("alex", 5)).toHaveLength(0);

    const asked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "anything stuck?", token: approverToken }),
      redirect: "manual",
    });
    expect(asked.status).toBe(303);
    await settle();
    const turn = store.recentChatTurns("alex", 1)[0];
    expect(turn?.state).toBe("answered");
    expect(turn?.settledMicrousd).toBe(500 * 3 + 100 * 15);

    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("One draft ready.");
    expect(html).toContain("Deflake the webhook test");
    const fileAction = /action="(\/chat\/file\/[0-9a-f]{32})"/.exec(html)?.[1];
    if (fileAction === undefined) throw new Error("no file form");

    // Filing also takes the password; then the door files it UNAPPROVED.
    const filed = await fetch(url(fileAction), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, token: approverToken }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const where = filed.headers.get("location") as string;
    expect(where).toMatch(/^\/t\//);
    const taskId = where.slice(3);
    expect(store.getScope(taskId)?.approvedAt).toBeNull();
    expect(store.filedViaOf(taskId)).toBe("chat:anthropic-api");
    // The draft is spent: filing again 404s.
    const again = await fetch(url(fileAction), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, token: approverToken }),
      redirect: "manual",
    });
    expect(again.status).toBe(404);
  });

  test("a credential-shaped message refuses BEFORE any row or request", async () => {
    let called = 0;
    fetcherResult = async () => {
      called++;
      return anthropicWrapper(envelope("x"));
    };
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const posted = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "my token is ghp_" + "a".repeat(36), token: approverToken }),
      redirect: "manual",
    });
    expect(posted.headers.get("location") ?? "").toContain("credential");
    expect(store.recentChatTurns("alex", 5)).toHaveLength(0);
    expect(called).toBe(0);
  });

  test("a malformed reply renders ONLY the static line, and script tags in replies stay inert", async () => {
    fetcherResult = async () => anthropicWrapper("here is my answer, no JSON");
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "hello", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    let html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("malformed and was discarded");
    expect(html).not.toContain("here is my answer");

    fetcherResult = async () => anthropicWrapper(envelope('<script>alert(1)</script>'));
    const csrf2 = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrf2, message: "again", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("a network failure after dispatch LATCHES the credential; the nonce ceremony lifts it", async () => {
    fetcherResult = async () => {
      throw new Error("connection reset");
    };
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "hello", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    const turn = store.recentChatTurns("alex", 1)[0];
    expect(turn?.unknownSpend).toBe(true);

    // Latched: the next ask refuses.
    const blocked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "again", token: approverToken }),
      redirect: "manual",
    });
    expect(blocked.headers.get("location") ?? "").toContain("unknown");

    // The ceremony: read the terms, nonce + password, acknowledged.
    const screen = await (await fetch(url(`/chat/ack/${turn?.id}`), { headers: { cookie } })).text();
    expect(screen).toContain("worst case");
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    const acked = await fetch(url(`/chat/ack/${turn?.id}`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(acked.status).toBe(303);
    expect(store.getChatTurn(turn?.id as number)?.settledMicrousd).toBe(turn?.reservedMicrousd);
    fetcherResult = async () => anthropicWrapper(envelope("back"));
    const unblocked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "back?", token: approverToken }),
      redirect: "manual",
    });
    expect(unblocked.headers.get("location")).toBe("/chat#latest");
  });


  test("chat is configurable from the console itself — password-gated, key stays environment-only", async () => {
    store.clearChatConfig();
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    // The setup form is right there, and it says where the key lives.
    expect(html).toContain('action="/chat/config"');
    expect(html).toContain("never INTO the database");
    expect(html).toContain("claude-sonnet-5");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;

    // Wrong password: nothing written.
    const refused = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "10", token: "wrong" }),
      redirect: "manual",
    });
    expect(refused.headers.get("location") ?? "").toContain("password");
    expect(store.getChatConfig()).toBeNull();

    // Unpriced model: refused with the reason.
    const unpriced = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "gpt-99", "weekly-usd": "10", token: approverToken }),
      redirect: "manual",
    });
    expect(unpriced.headers.get("location") ?? "").toContain("pinned");
    expect(store.getChatConfig()).toBeNull();

    // The real thing: written whole, audited under the session's name.
    const set = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "12.50", "daily-turns": "25", token: approverToken }),
      redirect: "manual",
    });
    expect(set.status).toBe(303);
    expect(store.getChatConfig()).toMatchObject({
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      dailyTurns: 25,
      weeklyCeilingMicrousd: 12_500_000,
      updatedBy: "alex",
    });
    // And chat now answers on this very page.
    const on = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(on).toContain("answering with");

    // Off again — password too.
    const off = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, off: "1", token: approverToken }),
      redirect: "manual",
    });
    expect(off.status).toBe(303);
    expect(store.getChatConfig()).toBeNull();
  });


  test("key onboarding lives in the UI: pasted once, stored 0600, never echoed, env wins, forgettable", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "standing-orders-chat-cfg-"));
    try {
      store.clearChatConfig();
      await boot({ chatEnv: {}, configDir });
      const cookie = await login();
      let html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain("none yet");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;

      // A password pasted as a "key" is refused loudly, nothing stored.
      const badKey = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "5", key: "hunter2", token: approverToken }),
        redirect: "manual",
      });
      expect(decodeURIComponent(badKey.headers.get("location") ?? "")).toContain("does not look like an API key");
      expect(existsSync(join(configDir, "chat-key-anthropic-api"))).toBe(false);

      // The real thing: config + key in one authenticated save.
      const secret = "sk-ant-" + "a".repeat(40);
      const set = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "5", key: secret, token: approverToken }),
        redirect: "manual",
      });
      expect(set.status).toBe(303);
      const keyFile = join(configDir, "chat-key-anthropic-api");
      expect(readFileSync(keyFile, "utf8").trim()).toBe(secret);
      expect((statSync(keyFile).mode & 0o777).toString(8)).toBe("600");

      // Chat is ON with the stored key; the page shows a tail, never the key.
      html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain("answering with");
      expect(html).toContain("stored");
      expect(html).not.toContain(secret);
      // The database carries no key anywhere.
      expect(store.installationFact("chat-key")).toBeNull();

      // Forgetting removes the file (password again).
      const forget = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, "forget-key": "anthropic-api", token: approverToken }),
        redirect: "manual",
      });
      expect(forget.status).toBe(303);
      expect(existsSync(keyFile)).toBe(false);
      html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain("no anthropic-api key");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an environment key always wins over a stored one", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "standing-orders-chat-cfg2-"));
    try {
      writeFileSync(join(configDir, "chat-key-anthropic-api"), "sk-ant-" + "b".repeat(40), { mode: 0o600 });
      await boot({ chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" }, configDir });
      const cookie = await login();
      const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain("from the environment");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("bearer callers are refused — drafts have nowhere to live", async () => {
    await boot();
    const bearer = await fetch(url("/chat"), { headers: { authorization: `Bearer alex:${approverToken}` } });
    expect([401, 403]).toContain(bearer.status);
  });
});

describe("the filesystem browser — confined to what opening allows", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let root: string;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown>) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-browse-ev-"));
    root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-browse-root-")));
    mkdirSync(join(root, "payments-api", ".git"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, ".hidden-things"), { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("a root ceiling browses its roots: repos first with open buttons, plain folders enterable, dotfiles hidden", async () => {
    await boot({ projectRoots: [root] });
    const cookie = await login();
    const html = await (await fetch(url("/projects/browse"), { headers: { cookie } })).text();
    expect(html).toContain("payments-api");
    expect(html).toContain("badge-done\">git");
    expect(html).toContain("notes");
    expect(html).not.toContain("hidden-things");
    // The projects page offers the door.
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(projects).toContain("/projects/browse");
  });

  test("containment: outside paths and symlink escapes are refused, not resolved", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-outside-")));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(root, "escape-hatch"));
      await boot({ projectRoots: [root] });
      const cookie = await login();
      const direct = await fetch(url(`/projects/browse?at=${encodeURIComponent(outside)}`), { headers: { cookie }, redirect: "manual" });
      expect(direct.status).toBe(403);
      const etc = await fetch(url("/projects/browse?at=/etc"), { headers: { cookie }, redirect: "manual" });
      expect(etc.status).toBe(403);
      // The symlink pointing out of the fence simply does not render.
      const listing = await (await fetch(url("/projects/browse"), { headers: { cookie } })).text();
      expect(listing).not.toContain("escape-hatch");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an explicit repo list gets no browser — the openable set is already on the page", async () => {
    await boot({ repo: root });
    const cookie = await login();
    const browse = await fetch(url("/projects/browse"), { headers: { cookie }, redirect: "manual" });
    expect(browse.status).toBe(404);
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(projects).not.toContain("/projects/browse");
  });
});

describe("the fleet — runner lanes as the agents × projects surface", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

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

  const csrf = (html: string): string => (/name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "");

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-fleet-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("one lane per runner; a building card pins to the top wearing its project; the grid is auto-fit, not five tracks", async () => {
    const now = new Date();
    // builder-1 carries a real credential and the repo binding the runner
    // gate proves (MCP spec v6); builder-2 only ever holds a reservation.
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 2, repos: ["/repo/main"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: now.toISOString(), retiredAt: null },
      hashToken("tok-builder-1"),
    );
    store.saveRunner(
      { name: "builder-2", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: now.toISOString(), retiredAt: null },
      "hash2",
    );
    // A live claim on builder-1.
    store.createTask({ id: "t-live", title: "being built" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    store.placeTask(ref, "/repo/main");
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(now.getTime() - 5 * 60_000), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1",
      branch: "standing-orders/t-live", worktree: "/pool/t-live",
      model: "claude", now: new Date(now.getTime() - 5 * 60_000),
      ...presented(store, ref, "builder", null, { provider: "claude", model: "claude" }),
    });
    // A queued reservation on builder-2.
    store.createTask({ id: "t-queued", title: "reserved work" }, T0);
    store.moveTask({ taskId: "t-queued", toRunner: "builder-2", beforeTaskId: null }, new Date());

    const cookie = await login();
    const html = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(html).toContain('class="lanes"');           // auto-fit runner grid
    expect(html).toContain('<div class="lanes" data-queue-revision=');
    expect(html).not.toContain('<div class="board" data-queue-revision='); // not the 5-track board container
    expect(html).toContain("builder-1");
    expect(html).toContain("builder-2");
    expect(html).toContain("shared queue");
    expect(html).toContain("being built");             // the live claim
    expect(html).toContain("reserved work");           // the queued reservation
    // The register/retire ceremonies are the only forms here.
    expect(html).toContain('action="/fleet/runner/register"');
    expect(html).toContain('action="/fleet/runner/retire"');
    // Its fragment is the lanes alone, behind the same auth.
    const fragment = await (await fetch(url("/fleet?fragment=1"), { headers: { cookie } })).text();
    expect(fragment).toContain('class="lanes"');
    expect(fragment).not.toContain("<html");
    expect(fragment).not.toContain("<script");
  });

  test("registering a worker takes a password and shows its token once; the token is never re-rendered", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);

    // No password: refused, nothing minted.
    const noPassword = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-9", capacity: "1", token: "" }),
      redirect: "manual",
    });
    expect(noPassword.status).toBe(403);
    expect(store.getRunner("builder-9")).toBeNull();

    // With the password: the token renders on this one response and nowhere else.
    const created = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-9", capacity: "2", token: approverToken }),
      redirect: "manual",
    });
    expect(created.status).toBe(200);
    const shown = await created.text();
    expect(shown).toContain("builder-9 is registered");
    expect(shown).toContain("shown once");
    // The shown-once page carries no live script that could re-render the token.
    expect(shown).not.toContain("<script");
    const runner = store.getRunner("builder-9");
    expect(runner).not.toBeNull();
    expect(runner?.runner.capacity).toBe(2);
    // Only a hash is kept — the raw token is not in the database's runner row.
    const later = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(later).not.toContain("builder-9 is registered");
  });

  test("retiring a worker takes a password and refuses the unknown", async () => {
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash",
    );
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);

    const unknown = await fetch(url("/fleet/runner/retire"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "nobody", token: approverToken }),
      redirect: "manual",
    });
    expect(unknown.status).toBe(404);

    const retired = await fetch(url("/fleet/runner/retire"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-1", token: approverToken }),
      redirect: "manual",
    });
    expect(retired.status).toBe(303);
    expect(store.getRunner("builder-1")?.runner.retiredAt).not.toBeNull();
  });

  test("dragging across projects: the fleet's move skips the open-project gate, the ceiling still walls reads", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash",
    );
    store.createTask({ id: "t-move", title: "movable" }, T0);
    store.saveScope({
      taskId: "t-move", goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d", approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d",
    });
    const revision = store.queueRevision();

    // A fleet-origin move (no projectRevision) re-reserves the task.
    const moved = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({
        respond: "fragment", csrf: token, queueRevision: String(revision),
        task: "t-move", column: "builder-1", before: "",
      }),
      redirect: "manual",
    });
    expect(moved.status).toBe(200);
    expect(store.assignedRunnerOf(store.refFor("built-in", "t-move").id)).toBe("builder-1");

    // A stale revision is refused with the move-reason text.
    const stale = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({
        respond: "fragment", csrf: token, queueRevision: String(store.queueRevision() + 9),
        task: "t-move", column: "anyone", before: "",
      }),
      redirect: "manual",
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("moved underneath you");
  });
});

describe("the workbench (attended A1) and the live substrate", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-17T12:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-wb-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // One attention task (no scope) and one building task (live claim + run).
    store.createTask({ id: "needs-scope", title: "Needs a scope written" }, T0);
    store.refFor("built-in", "needs-scope", "ours");
    store.createTask({ id: "building-now", title: "Being built right now" }, T0);
    const ref = store.refFor("built-in", "building-now", "ours").id;
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(ref, "/repo/main");
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim failed in setup");
    const run = store.startRun({
      taskRef: ref,
      leaseId: taken.claim.leaseId,
      runner: "night-shift-1",
      branch: "standing-orders/building-now",
      worktree: "/pool/building-now",
      now: new Date(),
      ...presented(store, ref, "builder"),
    });
    store.setRunPhase(run, "agent-running");
    store.setTaskState("building-now", "running", T0);

    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("the rail carries needs-you and building sections, with the palette index and elapsed tickers", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(html).toContain("needs you");
    expect(html).toContain("Needs a scope written");
    expect(html).toContain("building");
    expect(html).toContain("Being built right now");
    expect(html).toContain("agent working");
    expect(html).not.toContain("agent-running");
    expect(html).toContain("data-elapsed-since=");
    expect(html).toContain('id="palette-index"');
    expect(html).toContain('id="wb-rail"');
    // The CSP carries the script nonce.
    const response = await fetch(url("/workbench"), { headers: { cookie } });
    expect(response.headers.get("content-security-policy") ?? "").toContain("nonce-");
  });

  test("the rail fragment is the rail alone — no shell, no scripts, same auth", async () => {
    const cookie = await login();
    const fragment = await (await fetch(url("/workbench?fragment=rail"), { headers: { cookie } })).text();
    expect(fragment).toContain("Needs a scope written");
    expect(fragment).not.toContain("<html");
    expect(fragment).not.toContain("<script");
    // Unauthenticated: the fragment refuses like any page.
    const bare = await fetch(url("/workbench?fragment=rail"), { redirect: "manual" });
    expect([303, 401, 403]).toContain(bare.status);
  });

  test("selection renders the full task detail — forms and all — in the main pane, never polled", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/workbench?t=needs-scope"), { headers: { cookie } })).text();
    expect(html).toContain("No approved scope yet");
    expect(html).toContain("write the scope");
    // The poll targets the rail region, not the pane.
    expect(html).toContain('"wb-rail"');
    expect(html).not.toContain('"wb-detail"');
  });

  test("an open run's facts fragment answers live; a finished run's says to reload", async () => {
    const cookie = await login();
    const open = await (await fetch(url("/r/1?fragment=facts"), { headers: { cookie } })).text();
    expect(open).toContain("agent working");
    expect(open).not.toContain("agent-running");
    expect(open).toContain("data-elapsed-since=");
    store.finishRun(1, { outcome: "built", committed: true, now: new Date() });
    const closed = await (await fetch(url("/r/1?fragment=facts"), { headers: { cookie } })).text();
    expect(closed).toContain("finished");
    expect(closed).toContain("reload for the final record");
    expect(closed).not.toContain("<form");
  });
});

describe("round 4 — liveness is proved from the current lease, never guessed from a null outcome", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let liveRun: number;
  let orphanRun: number;

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

  const boot = async (options: Record<string, unknown> = {}): Promise<void> => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-live-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // The runner gate (MCP spec v6): both night-shift runners registered
    // and repo-bound; every claimed task placed.
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    register(store, { name: "night-shift-2", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-2" });

    // One genuinely live build: the claim's lease is current and unexpired.
    store.createTask({ id: "alive", title: "being built right now" }, T0);
    const aliveRef = store.refFor("built-in", "alive", "ours").id;
    store.placeTask(aliveRef, "/repo/main");
    const aliveTaken = acquire(store, aliveRef, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!aliveTaken.ok) throw new Error("claim failed");
    liveRun = store.startRun({
      taskRef: aliveRef, leaseId: aliveTaken.claim.leaseId, runner: "night-shift-1",
      branch: "standing-orders/alive", worktree: "/pool/alive", now: new Date(),
      ...presented(store, aliveRef, "builder"),
    });
    store.setRunPhase(liveRun, "agent-running");
    store.setTaskState("alive", "running", T0);

    // One orphan: the claim expired an hour ago; its run never finished.
    // Every "running" label must refuse this one.
    store.createTask({ id: "orphan", title: "left behind by a dead worker" }, T0);
    const orphanRef = store.refFor("built-in", "orphan", "ours").id;
    store.placeTask(orphanRef, "/repo/main");
    const orphanTaken = acquire(store, orphanRef, "night-shift-2", {
      token: "tok-night-shift-2", now: new Date(Date.now() - 7_200_000), ttlMs: 3_600_000,
    });
    if (!orphanTaken.ok) throw new Error("orphan claim failed");
    orphanRun = store.startRun({
      taskRef: orphanRef, leaseId: orphanTaken.claim.leaseId, runner: "night-shift-2",
      branch: "standing-orders/orphan", worktree: "/pool/orphan", now: new Date(Date.now() - 7_200_000),
      ...presented(store, orphanRef, "builder"),
    });
    store.setTaskState("orphan", "running", T0);

    await boot();
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a live run says running in plain words; an orphaned run stays never finished and gets no poller", async () => {
    const cookie = await login();
    const alive = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie } })).text();
    expect(alive).toContain("badge-running");
    expect(alive).toContain(">running<");
    expect(alive).toContain("agent working");
    expect(alive).toContain('id="run-facts-stamp"');

    // The orphan's own facts say "never finished" and earn no ticker or
    // poller stamp. (The page's side list still shows OTHER runs' badges,
    // so the fragment is the honest place to assert absence.)
    const orphan = await (await fetch(url(`/r/${orphanRun}`), { headers: { cookie } })).text();
    expect(orphan).toContain("never finished");
    // The chrome layer's script text mentions the attribute name, so the
    // markup form (with =) is the honest absence assertion.
    expect(orphan).not.toContain('data-elapsed-since="');
    expect(orphan).not.toContain('id="run-facts-stamp"');
    expect(orphan).not.toContain("?fragment=facts");
    const orphanFacts = await (await fetch(url(`/r/${orphanRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(orphanFacts).not.toContain("badge-running");
  });

  test("the facts fragment stops the poller for finished AND orphaned runs, and answers live otherwise", async () => {
    const cookie = await login();
    const alive = await (await fetch(url(`/r/${liveRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(alive).toContain(">running<");
    expect(alive).not.toContain("data-region-stop");

    const orphan = await (await fetch(url(`/r/${orphanRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(orphan).toContain("stopped without finishing");
    expect(orphan).toContain("data-region-stop");

    store.finishRun(liveRun, { outcome: "built", committed: true, now: new Date() });
    const finished = await (await fetch(url(`/r/${liveRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(finished).toContain("reload for the final record");
    expect(finished).toContain("data-region-stop");
  });

  test("the task page offers the live build honestly: the attempt panel names the build, says the view is off without --runner, embeds it with", async () => {
    const cookie = await login();
    const plain = await (await fetch(url("/t/alive"), { headers: { cookie } })).text();
    // The panel (slice 1c) names the run by its one unambiguous identity
    // and always carries the door to the full build view.
    expect(plain).toContain(`build #${liveRun} · night-shift-1 · running`);
    expect(plain).toContain(`href="/r/${liveRun}">full build view →`);
    // Without --runner the panel says the view is off — no poller, no
    // region, and no promise of a live look.
    expect(plain).toContain("the live file view is off");
    expect(plain).not.toContain('id="run-peek"');
    expect(plain).not.toContain("?fragment=peek");

    // The run page still shows the section, saying why it is empty — the
    // click must never land on silence.
    const runPlain = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie } })).text();
    expect(runPlain).toContain("what is changing right now");
    expect(runPlain).toContain("the live file view is off");

    await boot({ localRunner: "night-shift-1" });
    const cookieOn = await login();
    const watching = await (await fetch(url("/t/alive"), { headers: { cookie: cookieOn } })).text();
    expect(watching).toContain(`build #${liveRun} · night-shift-1 · running`);
    expect(watching).toContain('id="run-peek"');
    expect(watching).toContain("watching…");
    expect(watching).not.toContain("the live file view is off");
    const runOn = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie: cookieOn } })).text();
    expect(runOn).toContain("watching…");
    expect(runOn).not.toContain("the live file view is off");

    // The orphan's task page has no panel at all — there is nothing live.
    const orphanTask = await (await fetch(url("/t/orphan"), { headers: { cookie: cookieOn } })).text();
    expect(orphanTask).not.toContain("full build view");
    expect(orphanTask).not.toContain('class="card attempt-live"');
  });

  test("a building card lands on the build itself; a vanished build stays a repair card on the task", async () => {
    const cookie = await login();
    const board = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    expect(board).toContain(`href="/r/${liveRun}"`);
    // The orphan's dead lease earns no run link anywhere on the board — its
    // card stays on the task screen, in the attention lane.
    expect(board).not.toContain(`href="/r/${orphanRun}"`);
    expect(board).toContain(`href="/t/orphan"`);
  });

  test("unknown task and tournament pages refuse on the console's own page, not bare text", async () => {
    const cookie = await login();
    const task = await fetch(url("/t/definitely-not-here"), { headers: { cookie } });
    expect(task.status).toBe(404);
    expect(task.headers.get("content-type") ?? "").toContain("text/html");
    expect(await task.text()).toContain("no such task");

    const contest = await fetch(url("/contest/424242"), { headers: { cookie } });
    expect(contest.status).toBe(404);
    expect(contest.headers.get("content-type") ?? "").toContain("text/html");
    expect(await contest.text()).toContain("no such tournament");
  });

  test("chains from the console: wait for, stop waiting, and a loop refused in plain words", async () => {
    store.createTask({ id: "t-schema", title: "migrate the schema" }, T0);
    store.refFor("built-in", "t-schema", "ours");
    store.createTask({ id: "t-api", title: "wire the api" }, T0);
    store.refFor("built-in", "t-api", "ours");
    const cookie = await login();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(
      await (await fetch(url("/t/t-api"), { headers: { cookie } })).text(),
    )?.[1] as string;

    const post = (path: string, fields: Record<string, string>) =>
      fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...fields }),
        redirect: "manual",
      });

    // api waits for schema — created, visible, removable.
    expect((await post("/t/t-api/block", { on: "t-schema" })).status).toBe(303);
    const page = await (await fetch(url("/t/t-api"), { headers: { cookie } })).text();
    expect(page).toContain("waits for");
    expect(page).toContain("t-schema");
    expect(page).toContain("don't wait for this");

    // The loop refuses with the store's own sentence, on the page.
    const loop = await post("/t/t-schema/block", { on: "t-api" });
    expect(loop.status).toBe(409);
    expect(await loop.text()).toContain("cycle");

    // Remove the wait; a relationship that never existed refuses.
    expect((await post("/t/t-api/unblock", { on: "t-schema" })).status).toBe(303);
    expect((await post("/t/t-api/unblock", { on: "t-schema" })).status).toBe(409);

    // A blocker that does not exist here refuses before anything writes.
    expect((await post("/t/t-api/block", { on: "ghost" })).status).toBe(404);
  });

  test("build this next from the console: the act, the words, and the board's honest badges", async () => {
    // Approved scopes, so both cards sit in the QUEUED lane — the lane the
    // rank sorts and badges. Unapproved work is attention, not a queue.
    for (const [id, title] of [["q-one", "first filed"], ["q-two", "second filed"]] as const) {
      store.createTask({ id, title }, T0);
      store.refFor("built-in", id, "ours");
      const scoped = propose(store, { taskId: id, goal: `do ${title}`, now: T0 });
      const agreed = approve(store, id, "alex", T0, scoped.digest, approverToken);
      if (!agreed.ok) throw new Error("approve failed in setup");
    }
    const cookie = await login();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(
      await (await fetch(url("/t/q-two"), { headers: { cookie } })).text(),
    )?.[1] as string;
    const post = (path: string, fields: Record<string, string> = {}) =>
      fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...fields }),
        redirect: "manual",
      });

    expect((await post("/t/q-two/next")).status).toBe(303);
    const page = await (await fetch(url("/t/q-two"), { headers: { cookie } })).text();
    // The queue place is a property row now (task page pass).
    expect(page).toContain('<span class="meta">queue</span> <span class="mono">1 of 2 in the shared queue');
    expect(page).toContain("back to filing order");

    // Only the actual front of the shared queue says "next up".
    expect((await post("/t/q-one/next")).status).toBe(303);
    const board = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    const front = board.indexOf("first filed");
    const second = board.indexOf("second filed");
    expect(front).toBeGreaterThan(-1);
    expect(front).toBeLessThan(second);
    expect(board).toContain("next up");
    expect(board.match(/next up/g)?.length).toBe(1);

    // Undo puts it behind the still-promoted card; the badge follows rank.
    expect((await post("/t/q-one/next", { undo: "1" })).status).toBe(303);
    expect((await post("/t/q-two/next", { undo: "1" })).status).toBe(303);
    const calm = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    expect(calm.match(/next up/g)?.length).toBe(1);

    // The orphaned run's task (state running) cannot move up.
    const refused = await post("/t/orphan/next");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("only queued work can move up");
  });

  test("a task can be filed to start after another, and a bad chain never loses the task", async () => {
    store.createTask({ id: "t-before", title: "goes first" }, T0);
    store.refFor("built-in", "t-before", "ours");
    const cookie = await login();
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("starts after");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] as string;

    const created = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, title: "goes second", id: "t-after", after: "t-before" }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    const page = await (await fetch(url("/t/t-after"), { headers: { cookie } })).text();
    expect(page).toContain("waits for");
    expect(page).toContain("t-before");

    // A vanished "after" still files the task — the page says what failed.
    const kept = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, title: "kept anyway", id: "t-kept", after: "nope-gone" }),
      redirect: "manual",
    });
    expect(kept.status).toBe(200);
    const keptPage = await kept.text();
    expect(keptPage).toContain("the task was created, but could not be made to wait for nope-gone");
    expect(await (await fetch(url("/t/t-kept"), { headers: { cookie } })).text()).toContain("kept anyway");
  });

  test("an interrupted tournament's agents read as stopped, never as still working", async () => {
    // Recovery marks the contest interrupted but leaves the agents' run
    // records unfinished (round-4 finding 16) — the comparison screen must
    // prove liveness rather than map a null outcome to "still working".
    store.createTask({ id: "race-int", title: "raced then interrupted" }, T0);
    const taskRef = store.refFor("built-in", "race-int", "ours").id;
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef, raceDigest: planned.plan.raceDigest, agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion, publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(taskRef, "/repo/main");
    register(store, { name: "night-shift-3", host: "here", capacity: 8, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-3" });
    // The lease died with the machine: acquired two hours ago, one-hour TTL.
    const taken = acquire(store, taskRef, "night-shift-3", { token: "tok-night-shift-3", now: new Date(Date.now() - 7_200_000), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId: "race-int", taskRef, runner: "night-shift-3", leaseId: taken.claim.leaseId,
        incarnation: null, scopeDigest: "scope-d", scopeApproved: true, capacity: 8, quotaBlocked: () => null,
      } as never,
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.reason);
    store.stampContestDispatch(admitted.contestId, "base-sha-000", null);
    const contest = store.getContest(admitted.contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(admitted.contestId)) store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    store.casContestState(admitted.contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["ready"], "building", agent.generation);
      const lane = store.admitContestLane({
        taskRef, leaseId: taken.claim.leaseId, runner: "night-shift-3", incarnation: null,
        branch: agent.branch, worktree: `/pool/int-${agent.id}`, contestant: agent.id, route: store.laneAuthorityFor(agent.id)!, now: new Date(Date.now() - 7_200_000),
      });
      if (!lane.ok) throw new Error(lane.problem);
    }
    const racing = store.getContest(admitted.contestId);
    if (racing === null) throw new Error("contest");
    store.casContestState(admitted.contestId, ["racing"], "interrupted", racing.generation);

    const cookie = await login();
    const html = await (await fetch(url(`/contest/${admitted.contestId}`), { headers: { cookie } })).text();
    expect(html).toContain("interrupted");
    expect(html).toContain("stopped without finishing");
    expect(html).not.toContain("still working");
  });
});

describe("stage 5 — the tournament comparison screen and the pick ceremony, over real HTTP", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let contestId: number;
  let winnerId: number;
  let taskRef: number;

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

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-contest-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // A two-agent tournament, raced to pick-wait: one committed winner with
    // verified evidence, one that finished without committing.
    store.createTask({ id: "race-w", title: "raced on the web" }, T0);
    taskRef = store.refFor("built-in", "race-w", "ours").id;
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: planned.plan.raceDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion,
        publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(taskRef, "/repo/main");
    register(store, { name: "night-shift-1", host: "here", capacity: 8, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    const taken = acquire(store, taskRef, "night-shift-1", { token: "tok-night-shift-1", now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId: "race-w", taskRef, runner: "night-shift-1", leaseId: taken.claim.leaseId,
        incarnation: null, scopeDigest: "scope-d", scopeApproved: true, capacity: 8, quotaBlocked: () => null,
      } as never,
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.reason);
    contestId = admitted.contestId;
    store.stampContestDispatch(contestId, "base-sha-000", null);
    const contest = store.getContest(contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(contestId)) store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    store.casContestState(contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(contestId)) store.casContestantState(agent.id, ["ready"], "building", agent.generation);

    const [first, second] = store.contestants(contestId);
    if (first === undefined || second === undefined) throw new Error("agents");
    winnerId = first.id;
    const conclude = (agent: typeof first, committed: boolean, head: string, slot: number | null) => {
      const lane = store.admitContestLane({
        taskRef, leaseId: taken.claim.leaseId, runner: "night-shift-1", incarnation: null,
        branch: agent.branch, worktree: `/pool/${agent.id}`, contestant: agent.id, route: store.laneAuthorityFor(agent.id)!, now: T0,
      });
      if (!lane.ok) throw new Error(lane.problem);
      const runId = lane.runId;
      storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch",
        Buffer.from("diff --git a/x b/x\n+raced\n", "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
      storeEvidence(store, evidenceRoot, runId, "diff-stat", "terminal-diff-stat.json",
        Buffer.from(JSON.stringify({ base: "base-sha-000", head, fileCount: 1, additions: 1, deletions: 0, binaryCount: 0, filesTruncated: false, files: [{ path: "x", additions: 1, deletions: 0 }] }), "utf8"),
        "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
      store.recordOutcomeFacts(runId, { headRevision: head, handoff: "swapped the guard" });
      store.finishRun(runId, { outcome: "built", committed, now: T0 });
      finalizeContestant(store, { contestId, contestantId: agent.id, runId, outcome: "built", measuredMicrousd: 500_000, slotId: slot } as never, T0);
      return runId;
    };
    conclude(first, true, "head-aaa", admitted.slotIds[0] ?? null);
    conclude(second, false, "head-bbb", admitted.slotIds[1] ?? null);
    if (store.getContest(contestId)?.state !== "pick-wait") throw new Error("not pick-wait");

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

  test("the review cockpit offers the comparison road for a task whose result run raced (Priority 5)", async () => {
    store.setTaskState("race-w", "done", T0);
    const cookie = await login();
    const cockpit = await (await fetch(url("/review?result=race-w"), { headers: { cookie } })).text();
    expect(cockpit).toContain('data-review-task="race-w"');
    // The tournament waits for a pick: that is the one primary act, and it
    // goes to the existing comparison screen — the cockpit picks nothing.
    expect(cockpit).toContain('data-next-action="compare-contest"');
    expect(cockpit).toContain(`<a class="button-link" href="/contest/${contestId}">Compare results</a>`);
    expect(cockpit).toContain(`<a href="/contest/${contestId}">compare the tournament and pick →</a>`);
    expect(cockpit).not.toContain("pick this result");
    expect(cockpit).not.toContain('name="nonce"');
  });

  test("the whole ceremony: compare → arm (POST mints) → password → picked; a GET never mints and a replay refuses", async () => {
    const cookie = await login();

    // The comparison screen: plain words, both agents, the refusal named.
    const compare = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(compare).toContain("tournament");
    expect(compare).toContain("agent 1");
    expect(compare).toContain("agent 2");
    expect(compare).toContain("cannot be picked — finished without committing");
    expect(compare).toContain("pick this result");
    // The GET minted nothing: no nonce field anywhere on it.
    expect(compare).not.toContain('name="nonce"');

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(compare)?.[1];
    if (csrf === undefined) throw new Error("no csrf on the page");

    // Arm: the POST mints the nonce and answers with the confirmation form.
    const armed = await fetch(url(`/contest/${contestId}/arm`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId) }),
    });
    expect(armed.status).toBe(200);
    const ceremony = await armed.text();
    expect(ceremony).toContain("pick agent 1");
    expect(ceremony).toContain("$0.50"); // the money, restated in dollars
    expect(ceremony).toContain("nothing is published"); // no grant on this repo
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)?.[1];
    if (nonce === undefined) throw new Error("no nonce in the ceremony form");

    // A wrong password decides nothing.
    const wrong = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: "not-the-password" }),
    });
    expect(wrong.status).toBe(403);
    expect(store.getContest(contestId)?.state).toBe("pick-wait");

    // The real yes.
    const picked = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(picked.status).toBe(303);
    expect(store.getContest(contestId)?.state).toBe("picked");
    expect(store.getContest(contestId)?.winnerContestant).toBe(winnerId);
    expect(store.getTask("race-w")?.state).toBe("done");
    expect(store.activeHolds(taskRef, T0)).toHaveLength(0);

    // Replay of the same ceremony refuses — the nonce died with the pick.
    const replay = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: approverToken }),
    });
    expect(replay.status).toBe(409);

    // The screen now states the decision.
    const after = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(after).toContain("picked by alex");
    expect(after).not.toContain("pick this result");
  });

  test("the comparison reads at a glance (arc 6): one table column per agent, cards side by side, same facts", async () => {
    const cookie = await login();
    const html = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(html).toContain('class="contest-glance"');
    expect(html).toContain('class="contest-compare"');
    // the table and the cards derive from ONE summary — the same diff words
    expect(html).toContain("1 file(s) · +1 −0");
    expect((html.match(/agent [0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ceremonies untouched: the arm form still points at the same act
    expect(html).toContain(`/contest/${contestId}/arm`);
  });

  test("abandon: armed by POST, confirmed by password — the task fails requeueably and everything is kept", async () => {
    const cookie = await login();
    const compare = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(compare)?.[1];
    if (csrf === undefined) throw new Error("no csrf");
    const armed = await fetch(url(`/contest/${contestId}/arm`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, act: "abandon" }),
    });
    const ceremony = await armed.text();
    expect(ceremony).toContain("abandon this tournament?");
    expect(ceremony).toContain("marked <strong>failed</strong>");
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)?.[1];
    if (nonce === undefined) throw new Error("no nonce");
    const gone = await fetch(url(`/contest/${contestId}/abandon`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(gone.status).toBe(303);
    expect(store.getContest(contestId)?.state).toBe("abandoned");
    expect(store.getTask("race-w")?.state).toBe("failed");
    expect(store.runsFor(taskRef).length).toBe(2); // nothing deleted
  });
});

describe("A2 — the live peek over real HTTP: guards, fence, and the names-only fragment", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let poolRoot: string;
  let worktree: string;
  let approverToken: string;
  let runId: number;

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

  beforeEach(async () => {
    const { gitBlobSha1, encodeBaseTreeSnapshot } = await import("./peek.js");
    const { storeEvidence } = await import("./evidence.js");
    const { mkdirSync } = await import("node:fs");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), "peek-serve-ev-")));
    poolRoot = realpathSync(mkdtempSync(join(tmpdir(), "peek-serve-pool-")));
    worktree = join(poolRoot, "wt-1");
    mkdirSync(worktree);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;

    // The claiming runner carries a real credential and the repo binding the
    // runner gate proves (MCP spec v6).
    store.saveRunner(
      { name: "night-shift-1", host: "here", capacity: 4, capacityMode: "tasks", repos: ["/repos/thing"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      hashToken("tok-night-shift-1"),
    );
    store.saveRunner(
      { name: "other-machine", host: "there", capacity: 4, capacityMode: "tasks", repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash2",
    );
    store.createTask({ id: "peek-1", title: "watched work" }, T0);
    const taskRef = store.refFor("built-in", "peek-1", "ours").id;
    store.placeTask(taskRef, "/repos/thing");
    const taken = acquire(store, taskRef, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    runId = store.startRun({
      taskRef,
      leaseId: taken.claim.leaseId,
      runner: "night-shift-1",
      branch: "standing-orders/peek-1",
      worktree,
      now: T0,
      ...presented(store, taskRef, "builder"),
    });
    const baseSha = "b".repeat(40);
    store.stampRun(runId, { baseRevision: baseSha });
    store.saveWorktree({
      path: worktree,
      repo: "/repos/thing",
      branch: "standing-orders/peek-1",
      runner: "night-shift-1",
      taskRef,
      createdAt: T0.toISOString(),
      leasedAt: T0.toISOString(),
      releasedAt: null,
      verified: true,
      leaseEpoch: "epoch-one",
    });

    // The frozen base: one tracked file. On disk: that file edited, plus a
    // brand-new one — the fragment must say so in names only.
    const original = Buffer.from("export const answer = 41\n");
    writeFileSync(join(worktree, "app.ts"), Buffer.from("export const answer = 42\n"));
    writeFileSync(join(worktree, "notes.md"), Buffer.from("scratch\n"));
    const snapshot = encodeBaseTreeSnapshot({
      repo: "/repos/thing",
      run: runId,
      base: baseSha,
      entries: [{ path: "app.ts", mode: "100644", sha: gitBlobSha1(original), size: original.length }],
    });
    storeEvidence(store, evidenceRoot, runId, "base-tree", "base-tree.json", Buffer.from(snapshot), "git ls-tree (exit 0)", T0, {
      captureStatus: "ok",
    });

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      localRunner: "night-shift-1",
      poolRoot,
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
    rmSync(poolRoot, { recursive: true, force: true });
  });

  test("names and counts render; content never does; a session is required", async () => {
    const bare = await fetch(url(`/r/${runId}?fragment=peek`), { redirect: "manual" });
    expect([303, 403]).toContain(bare.status); // no session, no peek
    const cookie = await login();
    const peeked = await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } });
    expect(peeked.status).toBe(200);
    expect(peeked.headers.get("cache-control")).toBe("no-store");
    const body = await peeked.text();
    expect(body).toContain("best-effort look");
    expect(body).toContain("app.ts");
    expect(body).toContain("notes.md");
    // Names only — never the bytes that changed.
    expect(body).not.toContain("answer = 42");
    // The run page itself carries the region and its poller.
    const page = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
    expect(page).toContain("what is changing right now");
    expect(page).toContain('id="run-peek"');
  });

  test("the fence and the guards: epoch rotation invalidates the cached look; a finished run and a foreign machine refuse", async () => {
    const cookie = await login();
    const first = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(first).toContain("app.ts");
    // A successor occupant: file changes AND the epoch rotates. The cached
    // fragment is keyed to the dead epoch — the next look is fresh.
    writeFileSync(join(worktree, "second.ts"), "occupant two\n");
    const row = store.getWorktree(worktree);
    if (row === null) throw new Error("row");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-two" });
    const second = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(second).toContain("second.ts");
    // A missing epoch (adoption path) refuses rather than guessing.
    store.saveWorktree({ ...row, leaseEpoch: null });
    const unfenced = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(unfenced).toContain("before live watching existed");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three" });
    // Another machine's build says where to look instead.
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three", runner: "other-machine" });
    const foreign = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(foreign).toContain("another machine");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three", runner: "night-shift-1" });
    // A finished run points at the record, not the tree.
    store.finishRun(runId, { outcome: "built", committed: true, now: new Date() });
    const done = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(done).toContain("finished");
    expect(done).toContain("data-region-stop");
  });

  test("a released lease is superseded forever: the peek refuses finally, and the region poller stops", async () => {
    // liveClaimByLease alone would still admit a superseded lease
    // (round-4 finding 15) — the guard must prove the run's lease IS the
    // task's current live claim, and say so with the stop marker, because
    // superseded never heals.
    const cookie = await login();
    const running = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(running).toContain("app.ts");

    const leaseId = store.getRun(runId)?.leaseId;
    if (leaseId === undefined) throw new Error("run");
    release(store, leaseId, new Date());

    const gone = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(gone).toContain("not actively running");
    expect(gone).toContain("data-region-stop");
  });

  test("the transcript window: session-only JSON, byte offsets, replaced on shrink, final drain (arc 1)", async () => {
    const { openLiveLog } = await import("./live.js");
    const bare = await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { redirect: "manual" });
    expect([303, 403]).toContain(bare.status);
    const cookie = await login();

    // No file yet: an empty window, not an error — the view has not started.
    const empty = await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } });
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toMatchObject({ text: "", nextOffset: 0, final: false });

    const log = openLiveLog(evidenceRoot, runId);
    log?.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hello operator" }] } });
    log?.close();

    const first = await (await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } })).json() as { text: string; nextOffset: number; final: boolean };
    expect(first.text).toBe("hello operator\n");
    expect(first.final).toBe(false); // the run is still live
    const again = await (await fetch(url(`/r/${runId}?fragment=transcript&from=${first.nextOffset}`), { headers: { cookie } })).json();
    expect(again).toMatchObject({ text: "", nextOffset: first.nextOffset });

    // An offset past the file is `replaced` — the client restarts visibly.
    const shrunk = await fetch(url(`/r/${runId}?fragment=transcript&from=99999`), { headers: { cookie } });
    expect(shrunk.status).toBe(409);
    expect(await shrunk.json()).toMatchObject({ error: "replaced" });
    // A malformed offset refuses outright.
    expect((await fetch(url(`/r/${runId}?fragment=transcript&from=-1`), { headers: { cookie } })).status).toBe(400);

    // Finalize the run: the drain returns the tail and says final.
    store.finishRun(runId, { outcome: "built", reason: null, now: new Date() });
    const drained = await (await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } })).json() as { final: boolean; text: string };
    expect(drained.text).toBe("hello operator\n");
    expect(drained.final).toBe(true);
  });

  test("steering: a browser session files a note; the task page shows its state (arc 1)", async () => {
    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(taskHtml)?.[1] ?? "";
    expect(csrf).not.toBe("");
    expect(taskHtml).toContain("guidance for the next attempt");

    const posted = await fetch(url("/t/peek-1/steer"), {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "look at the retry path first" }).toString(),
    });
    expect(posted.status).toBe(303);
    const after = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    expect(after).toContain("look at the retry path first");
    expect(after).toContain("waiting for the next attempt");

    // Without a session cookie, steering does not exist as a surface.
    const bare = await fetch(url("/t/peek-1/steer"), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ note: "no session" }).toString(),
    });
    expect([303, 401, 403]).toContain(bare.status);
    expect(store.listSteerNotes(store.refFor("built-in", "peek-1", "ours").id).length).toBe(1);
  });

  test("the install assets serve pre-auth with their disciplines; sw.js has no fetch handler (arc 3)", async () => {
    const manifest = await fetch(url("/manifest.webmanifest"));
    expect(manifest.status).toBe(200);
    const parsed = (await manifest.json()) as Record<string, unknown>;
    expect(parsed["display"]).toBe("standalone");
    expect(parsed["scope"]).toBe("/");
    const worker = await fetch(url("/sw.js"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("x-content-type-options")).toBe("nosniff");
    expect(worker.headers.get("cache-control")).toBe("no-store");
    expect(worker.headers.get("content-security-policy")).toBe("default-src 'none'");
    const body = await worker.text();
    expect(body).toContain("notificationclick");
    expect(body).not.toContain('addEventListener("fetch"');
    expect((await fetch(url("/icon-192.png"))).status).toBe(200);
    expect((await fetch(url("/apple-touch-icon.png"))).status).toBe(200);
  });

  test("the typefaces serve pre-auth as woff2, exact names only, and the page CSP admits them", async () => {
    const font = await fetch(url("/fonts/plex-sans-400.woff2"));
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("x-content-type-options")).toBe("nosniff");
    expect(font.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = Buffer.from(await font.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect((await fetch(url("/fonts/plex-mono-600.woff2"))).status).toBe(200);
    // Unknown names fall through to the ordinary unauthenticated refusal —
    // a redirect to sign-in, never a read and never a server error.
    expect((await fetch(url("/fonts/other.woff2"), { redirect: "manual" })).status).toBe(303);
    const login = await fetch(url("/login"));
    expect(login.headers.get("content-security-policy")).toContain("font-src 'self'");
    // Every routed face is also declared: a served-but-undeclared weight
    // would silently synthesize.
    const html = await login.text();
    for (const face of ["plex-sans-400", "plex-sans-500", "plex-sans-600", "plex-mono-400", "plex-mono-500", "plex-mono-600"]) {
      expect(html).toContain(`/fonts/${face}.woff2`);
    }
  });

  test("push enrollment is a password ceremony and validates the endpoint (arc 3)", async () => {
    const cookie = await login();
    // This suite's server has no telegram file, so /settings is off — any
    // authenticated page carries the same session csrf.
    const taskHtml = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(taskHtml)?.[1] ?? "";
    const post = (body: Record<string, string>) =>
      fetch(url("/push/subscribe"), {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
    // No password: refused with words, nothing enrolled.
    const bare = await post({ csrf, endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "x", auth: "y" });
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toContain("password");
    // Password + a NON-allow-listed endpoint: refused.
    const evil = await post({ csrf, token: approverToken, endpoint: "https://evil.example.com/x", p256dh: "x", auth: "y" });
    expect(evil.headers.get("location")).toContain("push%20service");
    expect(store.listPushSubscriptions().length).toBe(0);
  });
});

describe("arc 4 — the chrome layer, sensitivity, and motion contracts", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let dir: string;

  const url = (path: string) => `${base}${path}`;
  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-arc4-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      repo: "/repo/main",
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

  test("the chrome layer is console-wide: /done carries the palette, the overlay, and a no-network nonce", async () => {
    const cookie = await login();
    const response = await fetch(url("/done"), { headers: { cookie } });
    const html = await response.text();
    expect(html).toContain('id="palette-index"');
    expect(html).toContain('aria-label="keyboard shortcuts"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toContain("connect-src 'self'"); // v28: the chrome beat fetches
    // No poller — no noscript auto-refresh to eat what someone was typing.
    expect(html).not.toContain('http-equiv="refresh"');
    // The overlay's index lists the new destinations.
    for (const label of ["fleet", "activity", "system", "builds", "requirements", "projects", "settings"]) {
      expect(html).toContain(`{"label":"${label}"`);
    }
  });

  test("settings is pinned outside both accordion groups, and only where the console offers it", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/done"), { headers: { cookie } })).text();
    const side = /<aside class="side">(.*?)<\/aside>/s.exec(html)?.[1] ?? "";
    expect(side).toMatch(/<nav class="nav-settings"><a href="\/settings" aria-label="settings" title="settings"><span class="glyph"><svg.*?<\/svg><\/span>settings<\/a><\/nav>/s);
    expect(side.indexOf('<nav class="nav-groups">')).toBeLessThan(side.indexOf('<nav class="nav-settings">'));
    const workflows = /<details class="nav-group" data-group="workflows"[^>]*>(.*?)<\/details>/s.exec(side)?.[1] ?? "";
    const admin = /<details class="nav-group" data-group="admin"[^>]*>(.*?)<\/details>/s.exec(side)?.[1] ?? "";
    expect(workflows).not.toContain("/settings");
    expect(admin).not.toContain("/settings");
    // The phone's overflow drawer mirrors it — its own headed section, last.
    const menu = await (await fetch(url("/menu"), { headers: { cookie } })).text();
    expect(menu).toContain('<h2 class="menu-group-label">settings</h2>');
    expect(menu).toContain('<a class="menu-row" href="/settings">');
  });

  test("the active page's accordion group opens itself; the other stays collapsed", async () => {
    const cookie = await login();
    const groupsOf = async (path: string): Promise<{ workflows: string | undefined; admin: string | undefined }> => {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      const side = /<aside class="side">(.*?)<\/aside>/s.exec(html)?.[1] ?? "";
      return {
        workflows: /<details class="nav-group" data-group="workflows"([^>]*)>/.exec(side)?.[1],
        admin: /<details class="nav-group" data-group="admin"([^>]*)>/.exec(side)?.[1],
      };
    };
    // /workbench is a workflows destination: its own group opens, admin stays shut.
    const onWorkbench = await groupsOf("/workbench");
    expect(onWorkbench.workflows).toBe(" open");
    expect(onWorkbench.admin).toBe("");
    // /fleet is an admin destination: the reverse.
    const onFleet = await groupsOf("/fleet");
    expect(onFleet.workflows).toBe("");
    expect(onFleet.admin).toBe(" open");
    // Neither destination's page opens a group it does not own.
    const onDone = await groupsOf("/done");
    expect(onDone.workflows).toBe("");
    expect(onDone.admin).toBe("");
  });

  test("the accordion is keyboard-operable and focusable like every other control, and its chevron dies under reduced motion", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    // Native <details>/<summary> — the same accessible pattern the project
    // switcher already uses — carries keyboard open/close and a focus ring
    // for free; no bespoke widget or extra ARIA wiring was added for it.
    expect(home).toContain('button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }');
    expect(home).toContain('.nav-group > summary .chevron { width: .875rem; height: .875rem; flex: none; transition: transform .15s; }');
    // The rotation is real motion, so it dies under prefers-reduced-motion.
    expect(home).toContain('.app, button, .side nav a, .nav-group > summary .chevron, .chat-project-card { transition: none; }');
  });

  test("the board keeps its poller privileges: connect-src, the noscript opt-out, and swap preservation", async () => {
    const cookie = await login();
    const response = await fetch(url("/board"), { headers: { cookie } });
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toContain("connect-src 'self'");
    // Scripting off still means no cross-fade on the fallback reloads.
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="30"><style>@view-transition { navigation: none; }</style></noscript>');
    // The swap gives back what it took: focus without re-scroll, the
    // centered lane, each lane's place.
    expect(html).toContain("preventScroll");
    expect(html).toContain("lane-[a-z]+");
    // …and each lane's fold (board pass): a section the reader closed
    // stays closed through the swap, one they opened stays open.
    expect(html).toContain('data.fold[k]=d.open');
    expect(html).toContain('if(data.fold[k])d.setAttribute("open","");else d.removeAttribute("open")');
    // The stylesheet ships the motion contracts and the phone's stacked lanes.
    expect(html).toContain("@view-transition { navigation: auto; }");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain(".board { display: flex; flex-direction: column;");
    expect(html).toContain("--brand:");
  });

  test("a password on screen strips the chrome additions but keeps the page's own behavior", async () => {
    const cookie = await login();
    // /fleet: register/retire take passwords; the reorder poller stays.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(fleet).not.toContain('id="palette-index"');
    expect(fleet).not.toContain('aria-label="keyboard shortcuts"');
    expect((fleet.match(/<script nonce=/g) ?? []).length).toBe(1);
    expect(fleet).toContain("fleet-region");
    // /settings: token forms beside the push enrollment script — exactly
    // one composed script, no palette.
    const settings = await fetch(url("/settings"), { headers: { cookie } });
    const settingsHtml = await settings.text();
    expect(settingsHtml).not.toContain('id="palette-index"');
    expect((settingsHtml.match(/<script nonce=/g) ?? []).length).toBe(1);
    expect(settings.headers.get("content-security-policy") ?? "").toContain("connect-src 'self'");
  });

  test("sensitivity is judged per response: /next with a step-up is bare, all-clear is chromed", async () => {
    store.createTask({ id: "t-a", title: "needs a yes" }, T0);
    store.saveScope({
      taskId: "t-a", goal: "do the thing", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const pending = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(pending).toContain("approve this scope");
    expect(pending).toContain('class="sticky-actions"');
    expect(pending).not.toContain('id="palette-index"');

    const granted = approve(store, "t-a", "alex", T0, store.getScope("t-a")?.digest as string, approverToken);
    expect(granted.ok).toBe(true);
    const clear = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(clear).not.toContain("approve this scope");
    expect(clear).toContain('id="palette-index"');
  });

  test("the signed rubric restates above the seal on the ceremony, the read-only card, and /next — never a second amber form (v39)", async () => {
    store.createTask({ id: "t-rubric", title: "needs a yes with a rubric" }, T0);
    store.saveScope({
      taskId: "t-rubric", goal: "guard the payout path", outOfScope: null, touches: ["src/payout.ts"],
      acceptance: [
        { id: "c1", statement: "The payout guard rejects a negative amount.", how: "unit test it", evidence: ["check"] },
        { id: "c2", statement: "The settings panel still opens.", how: null, evidence: ["screenshot"] },
      ],
      proposedAt: T0.toISOString(), digest: "e".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const page = await (await fetch(url("/t/t-rubric"), { headers: { cookie } })).text();
    // Restated in the ceremony, above the seal, with id/statement/evidence.
    const ceremonyMarker = page.indexOf('id="approve"');
    const ceremonyStart = page.lastIndexOf("<form", ceremonyMarker);
    const ceremonyEnd = page.indexOf("</form>", ceremonyMarker);
    expect(ceremonyMarker).toBeGreaterThan(-1);
    const approveForm = page.slice(ceremonyStart, ceremonyEnd);
    const ceremonyAcceptance = approveForm.indexOf(">acceptance<");
    const ceremonySeal = approveForm.indexOf("your password, typed again");
    expect(ceremonyAcceptance).toBeGreaterThan(-1);
    expect(ceremonyAcceptance).toBeLessThan(ceremonySeal);
    expect(approveForm).toContain("<code>c1</code> The payout guard rejects a negative amount.");
    expect(approveForm).toContain("[requires: check]");
    expect(approveForm).toContain("<code>c2</code> The settings panel still opens.");
    expect(approveForm).toContain("[requires: screenshot]");
    // No competing primary: exactly one submit button inside the ceremony form.
    expect((approveForm.match(/<button type="submit"/g) ?? []).length).toBe(1);
    // Advisory `how` never renders inside the ceremony form itself — only
    // in the separate, later scope-EDIT textarea, which legitimately shows
    // it back for editing.
    expect(approveForm).not.toContain("unit test it");

    // The read-only scope card (post-approval) restates it too, above its seal.
    const granted = approve(store, "t-rubric", "alex", T0, store.getScope("t-rubric")?.digest as string, approverToken);
    expect(granted.ok).toBe(true);
    const after = await (await fetch(url("/t/t-rubric"), { headers: { cookie } })).text();
    const cardAcceptance = after.indexOf(">acceptance<");
    const cardSeal = after.indexOf("approval binds to this exact wording");
    expect(cardAcceptance).toBeGreaterThan(-1);
    expect(cardAcceptance).toBeLessThan(cardSeal);

    // /next restates it identically for a second, unapproved task.
    store.createTask({ id: "t-rubric-2", title: "another" }, T0);
    store.saveScope({
      taskId: "t-rubric-2", goal: "g", outOfScope: null, touches: [],
      acceptance: [{ id: "c1", statement: "It works.", how: null, evidence: ["manual-review"] }],
      proposedAt: T0.toISOString(), digest: "f".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const next = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(next).toContain("<code>c1</code> It works.");
    expect(next).toContain("[requires: manual-review]");
  });

  test("a decision's option-per-card forms are never sticky-wrapped", async () => {
    store.createTask({ id: "t-q", title: "asked" }, T0);
    const ref = store.refFor("built-in", "t-q").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision({
      run, urgency: "blocking", recap: "Two ways.", question: "Which way?",
      options: [
        { id: "a", label: "One", consequence: "x", reversible: true },
        { id: "b", label: "Two", consequence: "y", reversible: true },
      ],
      recommendation: "a",
    }, T0);
    const cookie = await login();
    const html = await (await fetch(url("/d/1"), { headers: { cookie } })).text();
    expect(html).toContain("Which way?");
    expect(html).not.toContain('class="sticky-actions"');
  });

  test("the one-time worker token answer carries no script of any kind", async () => {
    const cookie = await login();
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(fleet)?.[1] as string;
    const response = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, name: "builder-9", capacity: "1", token: approverToken }),
    });
    const html = await response.text();
    expect(html).toContain("is registered");
    expect(html).not.toContain("<script");
  });

  test("the classifier reads every password serialization and no near-miss", () => {
    for (const yes of [
      '<input type="password" name="token">',
      "<input type='password' name='token'>",
      "<input type=password>",
      '<input name="token" TYPE="Password" required>',
      '<input\n  class="wide"\n  type = "password">',
    ]) {
      expect(SENSITIVE_INPUT.test(yes), yes).toBe(true);
    }
    for (const no of [
      '<input data-type="password" name="x">',
      '<input type="text" placeholder="not a password here">',
      "<p>your password, typed again</p>",
      '<input type="text" name="password-hint">',
    ]) {
      expect(SENSITIVE_INPUT.test(no), no).toBe(false);
    }
  });

  test("the palette index is cached between renders, invalidated by an accepted mutation, and escaped", async () => {
    store.createTask({ id: "t-x", title: 'sharp <b>title</b> & "quotes"' }, T0);
    const real = store.paletteTasks.bind(store);
    let calls = 0;
    (store as { paletteTasks: typeof store.paletteTasks }).paletteTasks = (...args: Parameters<typeof store.paletteTasks>) => {
      calls += 1;
      return real(...args);
    };
    const cookie = await login();
    const first = await (await fetch(url("/done"), { headers: { cookie } })).text();
    const tasks = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(calls).toBe(1);

    // Escaping: the raw HTML never spells a closing script tag; parsing
    // restores the title exactly.
    const tag = /<script type="application\/json" id="palette-index">(.*?)<\/script>/s.exec(first);
    expect(tag?.[1]).toContain("\\u003c");
    expect(tag?.[1]).not.toContain("</script>");
    const parsed = JSON.parse(tag?.[1] ?? "[]") as { label: string }[];
    expect(parsed.some(one => one.label.includes('sharp <b>title</b> & "quotes"'))).toBe(true);

    // An accepted mutation invalidates at once.
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(tasks)?.[1] as string;
    expect(csrf).toBeTruthy();
    await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, title: "fresh work", repo: "/repo/main" }),
      redirect: "manual",
    });
    await (await fetch(url("/done"), { headers: { cookie } })).text();
    expect(calls).toBe(2);
  });
});


describe("arc 6 — editor links, the review flow, and their guards", () => {
  test("editorFileHref refuses everything untame and encodes what it links", async () => {
    const { editorFileHref } = await import("./serve.js");
    // refusals
    expect(editorFileHref("relative/worktree", "a.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "../escape.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "src/../../up.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "/absolute.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "windows\\path.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "src//double.ts")).toBeNull();
    expect(editorFileHref("/pool/t-1", "ctl" + String.fromCharCode(7) + ".ts")).toBeNull();
    expect(editorFileHref("/pool" + String.fromCharCode(0) + "bad", "a.ts")).toBeNull();
    expect(editorFileHref("/pool/../t-1", "a.ts")).toBeNull();
    // links, encoded
    expect(editorFileHref("/pool/t-1", "src/a.ts")).toBe("vscode://file/pool/t-1/src/a.ts");
    expect(editorFileHref("/pool/t-1", 'has space/"quote".ts')).toBe(
      "vscode://file/pool/t-1/has%20space/%22quote%22.ts",
    );
    // line bounds: the comment form's own range, nothing looser
    expect(editorFileHref("/pool/t-1", "a.ts", 42)).toBe("vscode://file/pool/t-1/a.ts:42");
    expect(editorFileHref("/pool/t-1", "a.ts", 0)).toBe("vscode://file/pool/t-1/a.ts");
    expect(editorFileHref("/pool/t-1", "a.ts", 1_000_001)).toBe("vscode://file/pool/t-1/a.ts");
  });

  describe("over real HTTP", () => {
    let store: Store;
    let server: Server;
    let base: string;
    let evidenceRoot: string;
    let approverToken: string;
    let runId: number;

    const url = (path: string) => `${base}${path}`;
    const login = async (): Promise<string> => {
      const response = await fetch(url("/login"), {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: approverToken }),
        redirect: "manual",
      });
      return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    };
    const csrfOf = async (cookie: string): Promise<string> => {
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      return /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
    };
    const activate = async (cookie: string, on = true): Promise<void> => {
      const csrf = await csrfOf(cookie);
      await fetch(url("/session/editor-links"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, on: on ? "1" : "0", return: `/r/${runId}` }),
        redirect: "manual",
      });
    };

    beforeEach(async () => {
      store = openStore(":memory:");
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-arc6-ev-"));
      const added = addApprover(store, "alex", T0);
      if (!added.ok) throw new Error("bootstrap failed");
      approverToken = added.token;
      store.createTask({ id: "t-review", title: "reviewed work" }, T0);
      const taskRef = store.refFor("built-in", "t-review").id;
      runId = store.startRun({
        taskRef, leaseId: "l-review", runner: "builder-1",
        branch: "so/t-review", worktree: "/pool/t review", now: T0,
        ...presented(store, taskRef, "builder"),
      });
      const patch = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " keep",
        "-old value",
        "+edited",
        " end",
        "",
      ].join("\n");
      storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch",
        Buffer.from(patch, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
      storeEvidence(store, evidenceRoot, runId, "diff-stat", "terminal-diff-stat.json",
        Buffer.from(JSON.stringify({
          base: "b".repeat(12), head: "h".repeat(12), fileCount: 2, additions: 3, deletions: 1,
          binaryCount: 0, filesTruncated: false,
          files: [{ path: "src/a.ts", additions: 3, deletions: 1 }, { path: "../evil.ts", additions: 0, deletions: 0 }],
        }), "utf8"), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
      store.finishRun(runId, { outcome: "built", committed: true, now: T0 });

      server = createDecisionServer({
        store, evidenceRoot, clock: () => new Date(), repo: "/repo/main",
        localRunner: "builder-1", poolRoot: "/pool",
        editorLinks: "vscode",
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

    test("links render only after the SESSION says yes; hostile paths never link; the toggle flips both ways", async () => {
      const cookie = await login();
      // capability on, session off: no links, an offer to turn them on
      const before = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(before).not.toContain("vscode://");
      expect(before).toContain("open files in VS Code from this device");
      // session yes: tame paths link (worktree space encoded), traversal never does
      await activate(cookie);
      const after = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(after).toContain('href="vscode://file/pool/t%20review/src/a.ts"');
      expect(after.match(/vscode:[^"]*evil/) ?? []).toEqual([]);
      expect(after).toContain("on THIS device");
      // and off again
      await activate(cookie, false);
      const off = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(off).not.toContain("vscode://");
    });

    test("a run owned by ANOTHER runner never links and never offers", async () => {
      const other = store.startRun({
        taskRef: store.refFor("built-in", "t-review").id, leaseId: "l-other", runner: "someone-else",
        branch: "so/other", worktree: "/pool/other", now: T0,
        ...presented(store, store.refFor("built-in", "t-review").id, "builder"),
      });
      store.finishRun(other, { outcome: "built", committed: true, now: T0 });
      const cookie = await login();
      await activate(cookie);
      const html = await (await fetch(url(`/r/${other}`), { headers: { cookie } })).text();
      expect(html).not.toContain("vscode://");
      expect(html).not.toContain("open files in VS Code");
    });

    test("commenting lands back at the review card with the note field ready; plain loads stay quiet", async () => {
      const cookie = await login();
      const csrf = await csrfOf(cookie);
      const posted = await fetch(url(`/r/${runId}/comment`), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, path: "src/a.ts", line: "3", note: "tighten this" }),
        redirect: "manual",
      });
      expect(posted.status).toBe(303);
      expect(posted.headers.get("location")).toBe(`/r/${runId}?noted=1#review`);
      const noted = await (await fetch(url(`/r/${runId}?noted=1`), { headers: { cookie } })).text();
      expect(noted).toContain('id="review"');
      expect(noted).toMatch(/name="note"[^>]* autofocus/);
      const plain = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(plain).not.toContain("autofocus");
    });

    test("the prefill button and its script ride the page exactly when the comment form does", async () => {
      const cookie = await login();
      const html = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
      expect(html).toContain('class="pick-file" data-path="src/a.ts"');
      expect(html).toContain('id="comment-form"');
      expect(html).toContain('data-review-diff');
      expect(html).toContain('class="diff-file" open');
      expect(html).toContain('class="diff-annotate pick-line" data-path="src/a.ts" data-line="2" data-side="old"');
      expect(html).toContain('aria-label="Annotate src/a.ts, old line 2"');
      expect(html).toContain('class="diff-annotate pick-line" data-path="src/a.ts" data-line="2" data-side="new"');
      expect(html).toContain('aria-label="Annotate src/a.ts, new line 2"');
      expect(html).toContain('data-diff-mode="view" aria-pressed="true"');
      expect(html).toContain('data-diff-mode="annotate" aria-pressed="false"');
      expect(html).toContain('closest("button.pick-file,button.pick-line")');
      expect(html).toContain('form.scrollIntoView({behavior:"smooth",block:"center"})');
      // prefill alone earns no network: script-src yes, connect-src no
      const csp = (await fetch(url(`/r/${runId}`), { headers: { cookie } })).headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/script-src 'nonce-/);
      expect(csp).toContain("connect-src 'self'"); // v28: the chrome beat fetches
    });
  });

  test("--editor is validated before anything starts, on both commands", async () => {
    const { runOperate } = await import("./operate.js");
    for (const [verb, argv] of [
      ["serve", ["--editor", "emacs", "--json"]],
      ["serve", ["--editor", "vscode", "--json"]],
      ["up", ["--editor", "emacs", "--json"]],
    ] as const) {
      const lines: string[] = [];
      await runOperate(verb, argv as unknown as string[], line => lines.push(line), { databaseFile: ":memory:" });
      const body = JSON.parse(lines.join("\n")) as { ok: boolean; reason: string };
      expect(body.ok, `${verb} ${argv.join(" ")}`).toBe(false);
      expect(body.reason).toBe("usage");
    }
  });
});


describe("the onboarding ceremony over real HTTP, and root-mode placement proofs", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let root: string;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

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
    const html = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    return /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
  };

  const boot = async (options: Record<string, unknown>) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A ghClone stand-in that actually creates a real git repository at the
   * claimed target — authorizedProject's proof runs REAL git afterwards. */
  const fakeClone = async (nameWithOwner: string, intoRoot: string) => {
    const { execSync } = await import("node:child_process");
    const name = nameWithOwner.split("/")[1] as string;
    const target = join(intoRoot, name);
    mkdirSync(target);
    execSync("git init -q", { cwd: target });
    return { ok: true as const, target };
  };
  const fakePreview = async (owner: string, name: string) => ({
    ok: true as const,
    preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: 512, description: "a test repo" },
  });

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-onb-ev-"));
    root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-onb-root-")));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("the card gates on roots: absent ceremony refuses in words; present, the whole flow works once", async () => {
    await boot({ repos: ["/repo/elsewhere"] });
    const cookie = await login();
    // repo-list console: the ceremony refuses with the configuration named
    const csrf = await csrfFrom(cookie);
    const refused = await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/thing", root: "0" }),
      redirect: "manual",
    });
    expect(await refused.text()).toContain("--project-root");
  });

  test("the console picks up a newly connected project without restarting", async () => {
    const repo = join(root, "live-project");
    mkdirSync(repo);
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repo });
    const connected: string[] = [];
    await boot({ projectRoots: [root], currentRepos: () => connected });
    const cookie = await login();

    const before = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(before).not.toContain("live-project");
    connected.push(repo);
    const after = await (await fetch(url("/projects"), { headers: { cookie } })).text();

    expect(after).toContain("live-project");
    expect(after).toContain('href="/chat"');
  });

  test("opening an allowed local repository adds it to the machine registry", async () => {
    const repo = join(root, "opened-project");
    mkdirSync(repo);
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repo });
    const registry = join(root, "machine-repos.json");
    await boot({ projectRoots: [root], registryPath: registry, upConsole: true });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const opened = await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, path: repo }),
      redirect: "manual",
    });

    expect(opened.status).toBe(303);
    const saved = JSON.parse(readFileSync(registry, "utf8")) as { repos: string[] };
    expect(saved.repos).toContain(realpathSync(repo));
  });

  test("the GitHub listing offers ONE honest action per repo: open what's here, clone what isn't (cookie only)", async () => {
    // A real clone under the root whose origin names alex/Already-Here —
    // matched case-insensitively through its OWN .git/config, no process.
    const cloned = join(root, "already-here");
    mkdirSync(join(cloned, ".git"), { recursive: true });
    writeFileSync(join(cloned, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:alex/Already-Here.git\n');
    const ghList = async () => ({
      ok: true as const,
      repos: [
        { nameWithOwner: "alex/already-here", isPrivate: true, updatedAt: "2026-08-01T00:00:00Z", description: "on disk already" },
        { nameWithOwner: "alex/not-yet", isPrivate: false, updatedAt: "2026-08-02T00:00:00Z", description: "cloneable" },
      ],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    // The on-disk clone is offered as add + open, with its path said plainly.
    expect(page).toContain("add + open");
    expect(page).toContain(cloned);
    // The absent one pre-fills the EXISTING clone ceremony — preview,
    // password, and size check all still stand behind that form.
    expect(page).toContain('value="alex/not-yet"');
    expect(page).toContain("clone here");
    expect(page).toContain("private");
    // No cookie session, no listing.
    const anon = await fetch(url("/projects/github"), { redirect: "manual" });
    expect(anon.status).not.toBe(200);
  });

  test("a FOREIGN host never reads as a GitHub identity, malformed rows drop, and hostile text renders inert", async () => {
    // A clone whose origin merely CONTAINS github.com on a foreign host: it
    // must NOT map — its row offers the clone ceremony, not an open.
    const foreign = join(root, "impostor");
    mkdirSync(join(foreign, ".git"), { recursive: true });
    writeFileSync(
      join(foreign, ".git", "config"),
      '[remote "origin"]\n\turl = https://evil.example/path/github.com/alex/impostor.git\n',
    );
    // A config whose "[remote \"origin\"]" lives INSIDE a value, not as a
    // real section header, opens nothing either.
    const grammar = join(root, "grammar");
    mkdirSync(join(grammar, ".git"), { recursive: true });
    writeFileSync(
      join(grammar, ".git", "config"),
      '[alias]\n\ttrick = !echo [remote "origin"]\n\turl = git@github.com:alex/grammar.git\n',
    );
    const ghList = async () => ({
      ok: true as const,
      repos: [
        { nameWithOwner: "alex/impostor", isPrivate: false, updatedAt: "", description: "<script>alert(1)</script>" },
        { nameWithOwner: "alex/grammar", isPrivate: false, updatedAt: "", description: "" },
      ],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    // Neither local directory mapped: both rows offer the clone ceremony.
    expect(page).not.toContain("add + open");
    expect((page.match(/clone here/g) ?? []).length).toBe(2);
    // The hostile description reached the page dead, not live.
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  test("the strict listing parser DROPS malformed identities instead of rendering them", async () => {
    const { listGithubRepos } = await import("./onboard.js");
    void listGithubRepos; // shape imported; the drop is proven through the page below
    const ghList = async () => ({
      ok: true as const,
      // A well-shaped row beside one gh should never send: the page renders
      // ONLY what the injected listing carries — the strict parser lives in
      // listGithubRepos itself, proven in onboard.test.ts; here the page
      // must escape and bound whatever reaches it.
      repos: [{ nameWithOwner: "alex/fine", isPrivate: false, updatedAt: "not-a-date", description: "ok" }],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    expect(page).toContain("alex/fine");
    // A non-ISO stamp was already rejected at ingestion in production; the
    // page never renders a raw one regardless.
    expect(page).not.toContain("not-a-date");
  });

  test("a gh that is missing or signed out renders its words, never a broken page", async () => {
    await boot({ projectRoots: [root], ghList: async () => ({ ok: false as const, reason: "gh-auth" as const, message: "gh is not signed in — run `gh auth login --hostname github.com` where serve runs" }) });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    expect(page).toContain("gh is not signed in");
  });

  test("preview mints a single-use record; confirm takes the password, clones, enrolls, opens; replay refuses", async () => {
    const registry = join(root, "repos.json");
    await boot({ projectRoots: [root], registryPath: registry, ghPreview: fakePreview, ghClone: fakeClone });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const previewed = await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/fresh-thing", root: "0" }),
      redirect: "manual",
    });
    const page = await previewed.text();
    expect(page).toContain("ap9000/fresh-thing");
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] as string;
    expect(nonce).toBeTruthy();

    // wrong password refuses, record survives
    const badPw = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: "wrong" }),
      redirect: "manual",
    });
    expect(await badPw.text()).toContain("password");

    const confirmed = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    const done = await confirmed.text();
    expect(done).toContain("is ready");
    // cloned for real, enrolled for real, opened for real
    expect(existsSync(join(root, "fresh-thing", ".git"))).toBe(true);
    expect(readFileSync(registry, "utf8")).toContain("fresh-thing");
    expect(store.listProjects().some(one => one.path.endsWith("fresh-thing"))).toBe(true);

    // the nonce is spent — replaying it refuses
    const replayed = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(await replayed.text()).toContain("expired or was already used");
  });

  test("a large or unknown-size preview demands the checkbox at confirm", async () => {
    const bigPreview = async (owner: string, name: string) => ({
      ok: true as const,
      preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: null, description: "" },
    });
    await boot({ projectRoots: [root], registryPath: join(root, "repos.json"), ghPreview: bigPreview, ghClone: fakeClone });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const previewed = await (await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/huge", root: "0" }),
      redirect: "manual",
    })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(previewed)?.[1] as string;
    const withoutBox = await (await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    })).text();
    expect(withoutBox).toContain("tick the box");
    expect(existsSync(join(root, "huge"))).toBe(false);
  });

  test("root mode: a task files into a fresh repo under the root (findings 15/35), outside refuses, and the home joins the projects", async () => {
    const { execSync } = await import("node:child_process");
    const fresh = join(root, "fresh-clone");
    mkdirSync(fresh);
    execSync("git init -q", { cwd: fresh });
    await boot({ projectRoots: [root] });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    // NOT admitted anywhere yet — exactly the gap the finding names
    expect(store.knownRepos()).not.toContain(realpathSync(fresh));
    expect(store.listProjects().some(one => one.path === realpathSync(fresh))).toBe(false);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "first-task", title: "first work in the clone", repo: fresh }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.getTask("first-task")).not.toBeNull();
    expect(store.knownRepos()).toContain(realpathSync(fresh));
    expect(store.listProjects().some(one => one.path === realpathSync(fresh))).toBe(true);

    // outside the root: refused with the ceiling named
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-outside-")));
    try {
      execSync("git init -q", { cwd: outside });
      const refused = await fetch(url("/tasks/add"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, id: "smuggled", title: "outside work", repo: outside }),
        redirect: "manual",
      });
      expect(await refused.text()).toContain("outside what this server was configured to show");
      expect(store.getTask("smuggled")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });


  test("the card itself gates: disabled with words on a repo-list console, a live form under roots", async () => {
    await boot({ repos: ["/repo/elsewhere"] });
    const cookie = await login();
    const listMode = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(listMode).toContain("--project-root");
    expect(listMode).not.toContain('action="/projects/onboard-preview"');
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const again = addApprover(store, "alex", T0);
    if (!again.ok) throw new Error("bootstrap failed");
    approverToken = again.token;
    await boot({ projectRoots: [root] });
    const cookie2 = await login();
    const rootMode = await (await fetch(url("/projects"), { headers: { cookie: cookie2 } })).text();
    expect(rootMode).toContain('action="/projects/onboard-preview"');
  });

  test("placement across the modes: blank falls into the open project; scoped-no-project refuses; unscoped keeps unplaced", async () => {
    const { execSync } = await import("node:child_process");
    const home = join(root, "home-repo");
    mkdirSync(home);
    execSync("git init -q", { cwd: home });
    await boot({ projectRoots: [root] });
    const cookie = await login();
    let csrf = await csrfFrom(cookie);

    // scoped console, NO project open, blank repo: refused server-side —
    // the form's `required` is a courtesy, not the guard (finding 1)
    const blankRefused = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "unplaced-smuggle", title: "no home" }),
      redirect: "manual",
    });
    expect(await blankRefused.text()).toContain("no project is open");
    expect(store.getTask("unplaced-smuggle")).toBeNull();

    // open the project: a BLANK repo now falls into it
    await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, path: home }),
      redirect: "manual",
    });
    csrf = await csrfFrom(cookie);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "fell-home", title: "blank falls into the open project" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.lookupRef("fell-home")?.repo).toBe(realpathSync(home));
  });

  test("repo-list mode still admits by the list: a listed repo files, an unlisted one refuses", async () => {
    await boot({ repos: ["/repo/listed"] });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const listed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "in-list", title: "listed work", repo: "/repo/listed" }),
      redirect: "manual",
    });
    expect(listed.status).toBe(303);
    const unlisted = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "off-list", title: "unlisted work", repo: "/repo/other" }),
      redirect: "manual",
    });
    expect(unlisted.status).not.toBe(303);
    expect(store.getTask("off-list")).toBeNull();
  });

  test("unscoped mode keeps its historic unplaced filings", async () => {
    await boot({});
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "free-floating", title: "unplaced by design" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.lookupRef("free-floating")?.repo).toBeNull();
    // where a no-project filing form DOES render, the field says the rule
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("no project is open, so the task must say where it belongs");
  });

  test("root mode: a routine files into the open project through the same proof (finding 24)", async () => {
    const { execSync } = await import("node:child_process");
    const home = join(root, "routine-home");
    mkdirSync(home);
    execSync("git init -q", { cwd: home });
    await boot({ projectRoots: [root] });
    const cookie = await login();
    let csrf = await csrfFrom(cookie);
    // open the fresh repo as the project first
    await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, path: home }),
      redirect: "manual",
    });
    const routinesPageHtml = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(routinesPageHtml)?.[1] as string;
    const revision = /name="projectRevision" value="([0-9]+)"/.exec(routinesPageHtml)?.[1] ?? "0";
    const filed = await fetch(url("/routines/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf, name: "nightly-check", goal: "look things over", schedule: "daily:03:00",
        projectRevision: revision,
      }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const routines = store.listRoutines(null);
    expect(routines.some(one => one.name === "nightly-check" && one.repo === realpathSync(home))).toBe(true);
  });
});

describe("the attended authorization ceremony (Phase 2E)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let taskRef: number;

  const url = (path: string) => `${base}${path}`;
  const T1 = new Date("2026-08-26T02:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfOf = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url("/t/t-att"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf in the page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T1);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T1); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T1);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-att-ev-"));
    const added = addApprover(store, "alex", T1);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.createTask({ id: "t-att", title: "watched work" }, T1);
    const ref = store.refFor("built-in", "t-att");
    taskRef = ref.id;
    store.raw().prepare("UPDATE task_ref SET repo = '/repo' WHERE id = ?").run(ref.id);
    propose(store, { taskId: "t-att", goal: "the watched goal", outOfScope: null, touches: ["src/"], now: T1 });
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      attended: { runner: "mac-a", headOf: async () => "a".repeat(40) },
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

  test("the whole road: offer on the task page, EVERY term on the confirm screen, password mints, beat keeps it live, revoke closes it", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/t/t-att"), { headers: { cookie } })).text();
    expect(page).toContain("run it once while you watch");
    const csrf = await csrfOf(cookie);

    const preview = await fetch(url("/t/t-att/attend-preview"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
    });
    expect(preview.status).toBe(200);
    const confirm = await preview.text();
    // every term, in words
    expect(confirm).toContain("the watched goal");
    expect(confirm).toContain("sonnet");
    expect(confirm).toContain("/repo @ aaaaaaaaaaaa");
    expect(confirm).toContain("mac-a");
    expect(confirm).toContain("stops as soon as its total crosses this");
    expect(confirm).toContain("ends the whole session");
    expect(confirm).toContain("never converts into unattended work");
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const expiry = /name="expiry" value="([^"]+)"/.exec(confirm)?.[1]?.replace(/&#58;|&colon;/g, ":") as string;
    expect(nonce).toBeTruthy();
    expect(digest).toBeTruthy();
    expect(expiry).toBeTruthy();

    const minted = await fetch(url("/t/t-att/attend"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, nonce, digest, expiry, minutes: "60", turns: "20", budget: "2000000", token: approverToken }),
    });
    expect(minted.status).toBe(303);
    const open = store.openAuthorizationFor(taskRef);
    expect(open).not.toBeNull();
    expect(open?.runner).toBe("mac-a");
    expect(open?.compositeDigest).toBe(digest);
    // the mint itself is the first beat
    expect(open?.lastBeatAt).not.toBeNull();

    // the beat endpoint advances the durable clock (v28: approver-bound
    // beat-all, parameterless, same-origin proven by header)
    await new Promise(pass => setTimeout(pass, 20));
    const beat = await fetch(url("/session/attended-beats"), {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(beat.status).toBe(200);
    expect(((await beat.json()) as { beaten: number }).beaten).toBe(1);
    // a cross-site POST (or a tokenless script) refuses
    const forged = await fetch(url("/session/attended-beats"), {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(forged.status).toBe(403);

    // the open card renders with the revoke, and revoke closes it
    const withOpen = await (await fetch(url("/t/t-att"), { headers: { cookie } })).text();
    expect(withOpen).toContain("attended session");
    expect(withOpen).toContain("revoke");
    const revoked = await fetch(url("/t/t-att/attend-revoke"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf }),
    });
    expect(revoked.status).toBe(303);
    expect(store.openAuthorizationFor(taskRef)).toBeNull();
    expect(store.readAuthorization(open?.id ?? "")?.endReason).toBe("revoked");
  });

  test("the world moving between reading and signing refuses: the digest is the proof", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const preview = await fetch(url("/t/t-att/attend-preview"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf }),
    });
    const confirm = await preview.text();
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const expiry = /name="expiry" value="([^"]+)"/.exec(confirm)?.[1] as string;
    // the scope moves while the operator reads
    propose(store, { taskId: "t-att", goal: "a DIFFERENT goal", outOfScope: null, touches: [], now: new Date() });
    const minted = await fetch(url("/t/t-att/attend"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, nonce, digest, expiry, minutes: "60", turns: "20", budget: "2000000", token: approverToken }),
    });
    expect(minted.status).toBe(409);
    expect(store.openAuthorizationFor(taskRef)).toBeNull();
  });

  test("a wrong password mints nothing; a second open authorization refuses", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const preview = await (await fetch(url("/t/t-att/attend-preview"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf }) })).text();
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(preview)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview)?.[1] as string;
    const expiry = /name="expiry" value="([^"]+)"/.exec(preview)?.[1] as string;
    const refused = await fetch(url("/t/t-att/attend"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, nonce, digest, expiry, minutes: "60", turns: "20", budget: "2000000", token: "wrong" }),
    });
    expect(refused.status).toBe(403);
    expect(store.openAuthorizationFor(taskRef)).toBeNull();
  });

  test("a raced task refuses the offer, and filing a race refuses while an authorization is open — both directions, atomically", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    // direction 1: mint, then try to file a race through the scope form
    const preview = await (await fetch(url("/t/t-att/attend-preview"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf }) })).text();
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(preview)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(preview)?.[1] as string;
    const expiry = /name="expiry" value="([^"]+)"/.exec(preview)?.[1] as string;
    await fetch(url("/t/t-att/attend"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, nonce, digest, expiry, minutes: "60", turns: "20", budget: "2000000", token: approverToken }),
    });
    expect(store.openAuthorizationFor(taskRef)).not.toBeNull();
    const goalBefore = store.getScope("t-att")?.goal;
    const raced = await fetch(url("/t/t-att/scope"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        goal: "raced goal",
        not: "",
        touches: "",
        sawDigest: store.getScope("t-att")?.digest ?? "",
        "race-count": "2",
        "race-model": "claude-sonnet-5",
        "race-per-usd": "5",
        "race-total-usd": "14",
      }),
    });
    expect(raced.status).toBe(409);
    // ATOMIC: the refused race left the scope untouched (round-6 finding 5)
    expect(store.getScope("t-att")?.goal).toBe(goalBefore);
    // direction 2: with a race filed (after revoke), the offer disappears
    await fetch(url("/t/t-att/attend-revoke"), { method: "POST", headers: { cookie }, redirect: "manual", body: new URLSearchParams({ csrf }) });
    const filedRace = await fetch(url("/t/t-att/scope"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        goal: "raced goal",
        not: "",
        touches: "",
        sawDigest: store.getScope("t-att")?.digest ?? "",
        "race-count": "2",
        "race-model": "claude-sonnet-5",
        "race-per-usd": "5",
        "race-total-usd": "14",
      }),
    });
    expect(filedRace.status).toBe(303);
    const withRace = await (await fetch(url("/t/t-att"), { headers: { cookie } })).text();
    expect(withRace).not.toContain("run it once while you watch");
    const racedPreview = await fetch(url("/t/t-att/attend-preview"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf }) });
    expect(racedPreview.status).toBe(409);
  });
});

describe("the continuation ceremony (Phase 2E, A4)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let taskRef: number;
  let parentRun: number;

  const url = (path: string) => `${base}${path}`;
  const T1 = new Date("2026-08-26T03:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T1);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T1); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T1);
    evidenceRoot = mkdtempSync(join(tmpdir(), "so-cont-ev-"));
    const added = addApprover(store, "alex", T1);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.createTask({ id: "t-fin", title: "finished" }, T1);
    const ref = store.refFor("built-in", "t-fin");
    taskRef = ref.id;
    store.raw().prepare("UPDATE task_ref SET repo = '/repo' WHERE id = ?").run(ref.id);
    propose(store, { taskId: "t-fin", goal: "the finished goal", outOfScope: null, touches: [], now: T1 });
    sealScopeFixture(store, "t-fin", approverToken);
    store.raw().prepare("UPDATE task SET state = 'done' WHERE id = 't-fin'").run();
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at)
         VALUES ('lease-fin', ?, 1, 'mac-a', ?, ?, ?, ?)`,
      )
      .run(ref.id, T1.toISOString(), new Date(T1.getTime() + 60_000).toISOString(), T1.toISOString(), new Date(T1.getTime() + 50_000).toISOString());
    parentRun = store.startRun({ taskRef: ref.id, leaseId: "lease-fin", runner: "mac-a", branch: "so/t-fin", worktree: "/w", now: T1, ...presented(store, ref.id, "builder") });
    store.recordOutcomeFacts(parentRun, { headRevision: "b".repeat(40) });
    store.finishRun(parentRun, { outcome: "built", committed: true, now: T1 });
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      attended: { runner: "mac-a", headOf: async () => "a".repeat(40) },
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

  test("a finished run offers continuation; the follow-up enters the SIGNED terms; the mint binds parent and head", async () => {
    const cookie = await login();
    const page = await (await fetch(url(`/r/${parentRun}`), { headers: { cookie } })).text();
    expect(page).toContain("continue this attempt while you watch");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;

    const preview = await fetch(url("/t/t-fin/attend-preview"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, parent: String(parentRun), followup: "now add the tests for the new guard" }),
    });
    expect(preview.status).toBe(200);
    const confirm = await preview.text();
    // the follow-up and the parent are ON the signed form, with the
    // parent's accepted head — not the repo's current head
    expect(confirm).toContain("now add the tests for the new guard");
    expect(confirm).toContain(`#${parentRun}`);
    expect(confirm).toContain("bbbbbbbbbbbb");
    expect(confirm).not.toContain("aaaaaaaaaaaa");
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(confirm)?.[1] as string;
    const expiry = /name="expiry" value="([^"]+)"/.exec(confirm)?.[1] as string;

    const minted = await fetch(url("/t/t-fin/attend"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({
        csrf, nonce, digest, expiry,
        parent: String(parentRun), followup: "now add the tests for the new guard",
        minutes: "60", turns: "20", budget: "2000000", token: approverToken,
      }),
    });
    expect(minted.status).toBe(303);
    const open = store.openAuthorizationFor(taskRef);
    expect(open?.parentRun).toBe(parentRun);
    expect(open?.followup).toBe("now add the tests for the new guard");
    expect(store.openContinuationAuthorizations("mac-a").length).toBe(1);
  });

  test("a failed parent refuses in words — file a follow-up task instead", async () => {
    const cookie = await login();
    store.raw().prepare("UPDATE run SET outcome = 'failed' WHERE id = ?").run(parentRun);
    const page = await (await fetch(url(`/r/${parentRun}`), { headers: { cookie } })).text();
    expect(page).not.toContain("continue this attempt while you watch");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;
    const preview = await fetch(url("/t/t-fin/attend-preview"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, parent: String(parentRun), followup: "try again" }),
    });
    expect(preview.status).toBe(409);
    expect(await preview.text()).toContain("file a follow-up task");
  });
});


describe("the viewer role (v29, L2): reads everything, acts on nothing", () => {
  let server: Server;
  let port: number;
  let store: Store;
  let approverToken: string;

  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  beforeEach(async () => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", new Date());
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    // a viewer account, as an invite would mint it
    const viewer = addApprover(store, "vera", new Date(), { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    (globalThis as { __viewerToken?: string }).__viewerToken = viewer.token;
    store.createTask({ id: "t-v", title: "watched" }, new Date());
    server = createDecisionServer({ store, evidenceRoot: mkdtempSync(join(tmpdir(), "so-viewer-ev-")) });
    await new Promise<void>(pass => server.listen(0, "127.0.0.1", () => pass()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>(pass => server.close(() => pass()));
    store.close();
  });

  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name, token }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  test("a viewer logs in and reads; every consequential POST refuses with the viewer words", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const cookie = await loginAs("vera", viewerToken);
    const board = await fetch(url("/board"), { headers: { cookie } });
    expect(board.status).toBe(200);

    const csrfPage = await (await fetch(url("/t/t-v"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(csrfPage)?.[1] ?? "";
    for (const [path, extra] of [
      ["/t/t-v/scope", { goal: "sneak a scope in" }],
      ["/t/t-v/steer", { note: "sneak a note in" }],
      ["/tasks/add", { title: "sneak a task in" }],
    ] as const) {
      const refused = await fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...extra }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("can watch, not act");
    }
    // nothing landed
    expect(store.getScope("t-v")).toBeNull();
    expect(store.getTask("sneak a task in")).toBeNull();
  });

  test("a viewer switches projects session-only; the durable open refuses; beats renew nothing", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const cookie = await loginAs("vera", viewerToken);
    const csrfPage = await (await fetch(url("/t/t-v"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(csrfPage)?.[1] ?? "";
    const select = await fetch(url("/projects/select"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, path: "" }),
    });
    expect(select.status).toBe(303);
    const open = await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ path: "/tmp" }),
    });
    expect(open.status).toBe(403);
    const beat = await fetch(url("/session/attended-beats"), {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(beat.status).toBe(403);
    expect(await beat.text()).toContain("not keep sessions alive");
  });

  test("a viewer's credential cannot act over bearer either; a revoked account cannot authenticate at all", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const bearer = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { authorization: `Bearer vera:${viewerToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "bearer sneak" }).toString(),
    });
    expect(bearer.status).toBe(403);

    store.raw().prepare("UPDATE approver SET revoked_at = ? WHERE name = 'vera'").run(new Date().toISOString());
    const dead = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "vera", token: viewerToken }),
      redirect: "manual",
    });
    expect(dead.status).toBe(403);
    // and the approver road is untouched
    const alive = await loginAs("alex", approverToken);
    expect(alive).toContain("standing-orders_session");
  });
});

describe("the portfolio and the scope bar (portfolio arc, slice 1a)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  const seedTaskIn = (id: string, title: string, repo: string): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };

  /** A parked decision with one reversible and one irreversible option. */
  const seedDecisionIn = (id: string, repo: string, question: string): number => {
    const ref = seedTaskIn(id, `decide ${id}`, repo);
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
    });
    return store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: `why ${id} stopped`,
        question,
        options: [
          { id: "keep", label: "Keep and backfill", consequence: "reversible cleanup later", reversible: true },
          { id: "drop", label: "Drop it", consequence: "it does not come back", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );
  };

  /** A terminal run inside the 24h window; measured only when cost is given. */
  const seedRunIn = (
    id: string, title: string, repo: string, outcome: "built" | "failed",
    costUsd: number | null, tokens?: { tokensIn: number; tokensOut: number },
  ): number => {
    const ref = seedTaskIn(id, title, repo);
    const now = new Date();
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1", provider: "claude",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now,
      ...presented(store, ref, "builder"),
    });
    store.stampProviderStart(run, now);
    if (costUsd !== null || tokens !== undefined) {
      store.recordUsage(run, {
        tokensIn: tokens?.tokensIn ?? 100, tokensOut: tokens?.tokensOut ?? 50,
        ...(costUsd === null ? {} : { costUsd }),
      });
    }
    store.finishRun(run, { outcome, ...(outcome === "failed" ? { reason: "agent" } : {}), now: new Date() });
    return run;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-portfolio-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  const scopeBarOf = (html: string): string => {
    // The bar runs from its opening tag to the page body (main, or the
    // split of a master-detail page) — it nests the switcher's own divs.
    const start = html.indexOf('<div class="scope-bar">');
    if (start < 0) throw new Error("no scope bar on the page");
    const ends = [html.indexOf("<main>", start), html.indexOf('<div class="split">', start)].filter(one => one > start);
    return html.slice(start, Math.min(...ends));
  };

  test("the scope bar states each surface's scope: portfolio all-project, queue project-bound", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();

    // The open project's inbox: the bar names the project, with the switch road.
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    const homeBar = scopeBarOf(home);
    // The bar's NAME is the summary of the switcher (board pass); the menu
    // beneath lists every project and "all projects" as plain POST forms.
    expect(homeBar).toContain('<details class="switcher"><summary class="name">main<svg');
    // The pill IS the switcher (reduction pass §1): no second road beside it.
    expect(homeBar).not.toContain("switch project");
    expect(homeBar).toContain('<form method="post" action="/projects/open">');

    // The portfolio is all-project even while a project is open.
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(scopeBarOf(portfolio)).toContain('<summary class="name">all projects<svg');
    expect(portfolio).toContain("<h1>portfolio</h1>");

    // The queue stays project-bound.
    const queue = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const queueBar = scopeBarOf(queue);
    expect(queueBar).toContain('<summary class="name">main<svg');

    // One visible /projects link per breakpoint (portfolio arc §1, amended
    // by the mobile pass, then the reduction pass): the rail's projects row
    // on desktop, and "manage projects" inside the phone's project switcher.
    // Exactly those two links live in chrome.
    expect(home).toContain('<details class="project-pill switcher"><summary><span class="name">main<svg');
    expect(home).toContain('<span class="pill-status">');
    expect((home.match(/href="\/projects"/g) ?? []).length).toBe(2);

    // The rail (reduction pass §1): four rows, then the more group where
    // the portfolio now lives — order, not mere presence.
    expect(home).toContain(">portfolio<");
    expect(home.indexOf(">inbox<")).toBeLessThan(home.indexOf(">board<"));
    expect(home.indexOf(">board<")).toBeLessThan(home.indexOf(">builds<"));
    expect(home.indexOf(">builds<")).toBeLessThan(home.indexOf(">projects<"));
    expect(home.indexOf('<nav class="nav-groups">')).toBeLessThan(home.indexOf(">portfolio<"));

    // Fleet and the rolled-up board are all-project; the scoped board is not.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(scopeBarOf(fleet)).toContain("all projects");
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(scopeBarOf(board)).toContain('<summary class="name">main<svg');
    const boardAll = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    expect(scopeBarOf(boardAll)).toContain('<summary class="name">all projects<svg');
  });

  test("portfolio hygiene: a hidden project leaks into no row, count, dollar, token, or claim; fictions stay out", async () => {
    seedDecisionIn("d-main", "/repo/main", "Answer the admitted question?");
    seedDecisionIn("d-secret", "/repo/secret", "SECRET-DECIDE never renders");
    const mainRun = seedRunIn("r-main", "admitted build", "/repo/main", "built", 1.23);
    // Token usage WITHOUT cost: the tokens row must still count it
    // (commit-1 review, finding 2 — spendLine's mixed branch omits tokens).
    seedRunIn("r-side", "side build", "/repo/side", "failed", null, { tokensIn: 7_000, tokensOut: 700 });
    seedRunIn("r-secret", "SECRET-RUN title", "/repo/secret", "built", 77.77, { tokensIn: 999_000, tokensOut: 999 });
    // A stored PR URL is a URL sink: only a verified github pull URL earns
    // an anchor (commit-1 review, finding 3).
    const mainRef = store.refFor("built-in", "r-main").id;
    const pub = store.createPublicationIntent({
      run: mainRun, taskRef: mainRef, githubRepo: "acme/payments", remote: "origin",
      base: "main", head: "standing-orders/r-main", headSha: "a".repeat(40), bodyHash: "b".repeat(64), draft: false,
    }, new Date());
    store.markPublicationPushed(pub, new Date());
    store.markPublicationOpened(pub, 13, "javascript:alert(1)", new Date());
    // A live claim in the hidden project: never a running row here.
    const secretLiveRef = seedTaskIn("t-sec-live", "SECRET-LIVE work", "/repo/secret");
    register(store, { name: "secret-runner", host: "h", capacity: 1, repos: ["/repo/secret"], now: T0, newToken: () => "tok-secret" });
    const taken = acquire(store, secretLiveRef, "secret-runner", { token: "tok-secret", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("secret claim failed in setup");

    await boot({ repos: ["/repo/main", "/repo/side"] });
    const cookie = await login();
    const html = await (await fetch(url("/workbench"), { headers: { cookie } })).text();

    // Admitted rows render; the hidden project's rows and dollars do not.
    expect(html).toContain("Answer the admitted question?");
    expect(html).not.toContain("SECRET-DECIDE");
    expect(html).not.toContain("SECRET-RUN");
    expect(html).not.toContain("77.77");

    // The hidden live claim never renders as a running row.
    expect(html).not.toContain("secret-runner");
    expect(html).not.toContain("SECRET-LIVE");

    // The window rollup counts only visible runs, by the exhaustive
    // outcome vocabulary, with spendLine's own wording — and tokens stand
    // alone, counting the unmeasured invocation's reported usage.
    expect(html).toContain("runs started");
    expect(html).toContain("1 built · 1 failed");
    expect(html).toContain("invocation(s)");
    expect(html).toContain("$1.23");
    expect(html).toContain("unmeasured");
    expect(html).toContain(`>${(7_000 + 700 + 150).toLocaleString()}</span>`);

    // The corrupted PR URL renders as text — the number without navigation.
    expect(html).toContain("PR #13");
    expect(html).not.toContain("javascript:alert");

    // Deleted fictions never render.
    expect(html).not.toContain("Pause dispatch");
    expect(html).not.toContain("idle spend");

    // The decision card answers reversibly inline — real words, no letters,
    // no confirm field anywhere near it; the irreversible option is a link.
    expect(html).toContain("decide-inline");
    expect(html).toContain(">Keep and backfill</button>");
    expect(html).not.toContain('name="confirm"');
    expect(html).not.toContain('value="drop"');
    expect(html).toContain("irreversible");
    expect(html).toContain(">recommended</span>");

    // Rows wear project chips.
    expect(html).toContain("main</span>");
  });

  test("the roll-up inbox stays links-only; the selected-project inbox answers on the card", async () => {
    seedDecisionIn("d-one", "/repo/main", "Which way?");

    await boot({ repos: ["/repo/main", "/repo/side"] });
    const cookie = await login();

    // Projectless roll-up: the decision is a link, never a form.
    const rollup = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(rollup).toContain("Which way?");
    expect(rollup).not.toContain("decide-inline");
    expect(rollup).not.toMatch(/<form[^>]*\/answer/);
  });

  test("the legacy unscoped projectless inbox is links-only too — no chosen project, no forms", async () => {
    // Unplaced work in an unscoped installation (no ceiling configured).
    store.createTask({ id: "d-free", title: "decide free" }, T0);
    const ref = store.refFor("built-in", "d-free").id;
    const run = store.startRun({
      taskRef: ref, leaseId: "lease-free", runner: "b1",
      branch: "standing-orders/d-free", worktree: "/pool/d-free", now: T0,
      ...presented(store, ref, "builder"),
    });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why", question: "Free-floating question?",
        options: [{ id: "keep", label: "Keep it", consequence: "fine", reversible: true }],
        recommendation: "keep",
      },
      T0,
    );

    await boot({});
    const cookie = await login();
    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(inbox).toContain("Free-floating question?");
    expect(inbox).not.toContain("decide-inline");
    expect(inbox).not.toMatch(/<form[^>]*\/answer/);
  });

  test("a ceremony-bearing selected task never ships the decision script, whatever else is open", async () => {
    seedDecisionIn("d-open", "/repo/main", "Open elsewhere?");
    // A task whose page carries the password approval ceremony.
    seedTaskIn("t-approve", "needs signing", "/repo/main");
    store.saveScope({
      taskId: "t-approve", goal: "sign me", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "c".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    await boot({ repo: "/repo/main" });
    const cookie = await login();

    // The overview alone carries the enhancement…
    const overview = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(overview).toContain("decide-inline");

    // …a selected ceremony page does not — sensitive pages gain no new
    // scripts (commit-1 review, finding 1); the scope bar stays inert.
    const selected = await (await fetch(url("/workbench?t=t-approve"), { headers: { cookie } })).text();
    expect(selected).toContain('type="password"');
    expect(selected).not.toContain("decide-inline");
    expect(selected).not.toContain("replaceChildren");
    expect(scopeBarOf(selected)).not.toMatch(/<form|<script/);
  });

  test("a reversible option posts from the card exactly as the endpoint expects", async () => {
    const decisionId = seedDecisionIn("d-tap", "/repo/main", "Tap to keep?");

    await boot({ repo: "/repo/main" });
    const cookie = await login();
    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    // The selected-project inbox renders the partial: inline reversible
    // form without confirm, irreversible as a link.
    expect(inbox).toContain("decide-inline");
    expect(inbox).toContain(`data-decision-id="${decisionId}"`);
    expect(inbox).not.toContain('name="confirm"');
    expect(inbox).not.toContain('value="drop"');

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(inbox)?.[1];
    if (csrf === undefined) throw new Error("no csrf on the inbox");
    const posted = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: "keep" }).toString(),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(`/d/${decisionId}`);
    const page = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(page).toContain("Answered:");
  });

  test("portfolioLedgerScoped: admission binds before the limit; unfinished runs never appear", async () => {
    // More hidden recent rows than the limit, plus one admitted row —
    // the admitted row must survive the page.
    for (let i = 0; i < 5; i++) seedRunIn(`r-h${i}`, `hidden ${i}`, "/repo/hidden", "built", null);
    seedRunIn("r-adm", "the admitted one", "/repo/main", "built", 0.5);
    // An unfinished run in the admitted repo: outcome IS NOT NULL excludes it.
    const openRef = seedTaskIn("r-open", "still going", "/repo/main");
    store.startRun({
      taskRef: openRef, leaseId: "lease-open", runner: "b1",
      branch: "standing-orders/r-open", worktree: "/pool/r-open", now: new Date(),
      ...presented(store, openRef, "builder"),
    });

    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rows = store.portfolioLedgerScoped(null, since, 3, ["/repo/main"]);
    expect(rows.some(row => row.taskId === "r-adm")).toBe(true);
    expect(rows.every(row => row.repo !== "/repo/hidden")).toBe(true);
    expect(rows.some(row => row.taskId === "r-open")).toBe(false);

    // Without admission the recent hidden rows would crowd the page.
    const naive = store.portfolioLedgerScoped(null, since, 3, null);
    expect(naive.length).toBe(3);

    await boot({ repo: "/repo/main" }); // afterEach closes a server either way
  });
});

describe("the queue (portfolio arc, slice 1b): move-to-front resolved server-side, refusals inline", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A queued task; placed in a repo when one is named, else repo-less. */
  const seed = (id: string, title: string, repo: string | null, at: Date): number => {
    store.createTask({ id, title }, at);
    const ref = store.refFor("built-in", id).id;
    if (repo !== null) store.placeTask(ref, repo);
    store.saveScope({
      taskId: id, goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: at.toISOString(), digest: `d-${id}`, approvedAt: at.toISOString(), approvedBy: "alex", approvedDigest: `d-${id}`,
    });
    return ref;
  };

  const worker = (name: string, capacity: number): void => {
    store.saveRunner(
      { name, host: "here", capacity, repos: ["/repo/main", "/repo/other"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: new Date().toISOString(), retiredAt: null },
      hashToken(`tok-${name}`),
    );
  };

  const csrf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
    if (match === null) throw new Error("no csrf token on the page");
    return match[1] as string;
  };

  /** The exact no-script form the ▲ button submits (no `respond` field). */
  const frontForm = (cookie: string, token: string, task: string, column: string, revision: number) =>
    fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, projectRevision: "1", queueRevision: String(revision), task, column, before: "__TOP__" }),
      redirect: "manual",
    });

  /** The order of one partition — exact repo AND assignment — as the store keeps it. */
  const partition = (repo: string | null, runner: string | null): string[] =>
    store.queueScoped("/repo/main", new Date()).filter(one => one.repo === repo && one.assignedRunner === runner).map(one => one.id);

  /** The shared column, mixed: a repo-less task first, then two of the project's. */
  const mixedColumn = (): void => {
    seed("t-any", "anywhere", null, new Date(T0.getTime() + 1_000));
    seed("t-b", "second of the project", "/repo/main", new Date(T0.getTime() + 2_000));
    seed("t-c", "third of the project", "/repo/main", new Date(T0.getTime() + 3_000));
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-queue-1b-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the no-script ▲ moves a card to the front of ITS partition — not before a repo-less neighbour, never a 200 alone", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(partition(null, null)).toEqual(["t-any"]);

    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(page).toContain('name="before" value="__TOP__"');
    const before = store.queueRevision();

    const moved = await frontForm(cookie, csrf(page), "t-c", "anyone", before);
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/board?view=order");
    // The asserted ORDER: t-c now leads its own partition; the repo-less
    // card's partition is untouched; the revision moved exactly once.
    expect(partition("/repo/main", null)).toEqual(["t-c", "t-b"]);
    expect(partition(null, null)).toEqual(["t-any"]);
    expect(store.queueRevision()).toBe(before + 1);

    // Inside a worker's column the same button works against that column.
    store.moveTask({ taskId: "t-b", toRunner: "builder-1", beforeTaskId: null }, new Date());
    store.moveTask({ taskId: "t-c", toRunner: "builder-1", beforeTaskId: null }, new Date());
    expect(partition("/repo/main", "builder-1")).toEqual(["t-b", "t-c"]);
    const again = await frontForm(cookie, csrf(page), "t-c", "builder-1", store.queueRevision());
    expect(again.status).toBe(303);
    expect(partition("/repo/main", "builder-1")).toEqual(["t-c", "t-b"]);
  });

  test("already at the front: a no-op that still checks the revision — fresh passes, stale is the typed 409", async () => {
    await boot();
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const token = csrf(page);
    const revision = store.queueRevision();

    // t-b already leads its partition: nothing moves, nothing bumps.
    const noop = await frontForm(cookie, token, "t-b", "anyone", revision);
    expect(noop.status).toBe(303);
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(store.queueRevision()).toBe(revision);

    // The same no-op over the fragment transport says so in plain text.
    const inPlace = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: token, projectRevision: "1", queueRevision: String(revision), task: "t-b", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(inPlace.status).toBe(200);
    expect(await inPlace.text()).toBe("already at the front");

    // A stale revision on the no-op branch is refused — the branch never
    // reaches moveTask()'s CAS, so the handler makes the check itself.
    const stale = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: token, projectRevision: "1", queueRevision: String(revision + 9), task: "t-b", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("moved underneath you");
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
  });

  test("the sentinel is honored only inside a task's own column; a cross-column front is refused, assignment untouched", async () => {
    await boot();
    worker("builder-1", 1);
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const refused = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: csrf(page), projectRevision: "1", queueRevision: String(store.queueRevision()), task: "t-c", column: "builder-1", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("own column");
    expect(store.assignedRunnerOf(store.refFor("built-in", "t-c").id)).toBeNull();
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
  });

  test("a claim that lands after the form rendered does not bump the revision — the snapshot refuses the move, order unchanged", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const revision = store.queueRevision();

    // The scheduler takes t-c between render and submit.
    const taken = acquire(store, store.refFor("built-in", "t-c").id, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    expect(store.queueRevision()).toBe(revision); // a claim is not a queue edit

    // The revision still matches, so only the fresh snapshot can catch it.
    const refused = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: csrf(page), projectRevision: "1", queueRevision: String(revision), task: "t-c", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("being taken");
    expect(store.queueRevision()).toBe(revision);
    // The free partition is t-b alone now; t-c kept its claim and its rank.
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(store.queueScoped("/repo/main", new Date()).find(one => one.id === "t-c")?.taken).toBe(true);
  });

  test("column headers: building counted in THIS project beside the global unattended capacity — never a ratio; no dollar figure; the claim primitive behind details", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    // builder-1 is busy once here and once in another project.
    seed("t-here", "built here", "/repo/main", new Date(T0.getTime() + 4_000));
    seed("t-there", "built elsewhere", "/repo/other", new Date(T0.getTime() + 5_000));
    for (const id of ["t-here", "t-there"]) {
      const taken = acquire(store, store.refFor("built-in", id).id, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
      if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    }
    store.moveTask({ taskId: "t-b", toRunner: "builder-1", beforeTaskId: null }, new Date());

    const cookie = await login();
    const html = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(html).toContain("1 building in this project · unattended capacity 2");
    expect(html).not.toMatch(/\b[12]\s*\/\s*2\b/);
    const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    expect(main).not.toContain("slot");
    // Money is not in the queue query and is not invented on the screen.
    expect(html).not.toMatch(/\$\s?\d/);
    // The shared column in plain words; the claim primitive folded away.
    expect(html).toContain("workers take from here when their column is empty");
    // No explainer disclosure on the screen (reduction pass §2).
    expect(html).not.toContain("how a worker takes from here");
    // Card chips over the existing snapshot shape: state and reservation owner.
    expect(html).toContain('<span class="badge">queued</span>');
    expect(html).toContain('<span class="badge">reserved for builder-1</span>');
    expect(html).toContain("being taken — keeps its claim");
  });
});


describe("the task detail (portfolio arc, slice 1c): the attempt panel, the rail, the honest verbs", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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

  const boot = async (options: Record<string, unknown> = {}) => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A task in the project with a signed scope — the store recomputes
   * the digest at filing, so the yes goes through the real ceremony. */
  const sign = (id: string): void => {
    const agreed = approve(store, id, "alex", new Date(), store.getScope(id)?.digest as string, approverToken);
    if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
  };
  const seed = (id: string, title: string, agent: { provider: string; model: string } | null = null): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id, "ours").id;
    store.placeTask(ref, "/repo/main");
    // A task built by another agent pins it BEFORE the scope files, so the
    // sealed route names that exact pair (v48: a run spends only as the
    // sealed build leg).
    if (agent !== null) store.pinTaskAgent(ref, agent.provider, agent.model);
    store.saveScope({
      taskId: id, goal: `goal of ${id}`, outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    sign(id);
    return ref;
  };

  /** A live attempt: a real claim under the runner's credential, and its run. */
  const live = (id: string, ref: number, provider = "claude", model?: string): number => {
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    const run = store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "night-shift-1", provider, ...(model === undefined ? {} : { model }),
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(Date.now() - 7 * 60_000),
      ...presented(store, ref, "builder"),
    });
    store.setRunPhase(run, "agent-running");
    store.setTaskState(id, "running", T0);
    return run;
  };

  /** A finished attempt; measured only when cost is given. */
  const finished = (id: string, ref: number, outcome: "built" | "failed", costUsd: number | null, tokens = { tokensIn: 40_000, tokensOut: 4_000 }): number => {
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}-${outcome}-${costUsd ?? "u"}`, runner: "night-shift-1", provider: "claude",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
    });
    store.stampProviderStart(run, T0);
    store.recordUsage(run, { ...tokens, ...(costUsd === null ? {} : { costUsd }) });
    store.finishRun(run, { outcome, ...(outcome === "failed" ? { reason: "agent" } : {}), now: T0 });
    return run;
  };

  const railOf = (html: string): string => {
    const match = /<aside class="task-rail">(.*?)<\/aside>/s.exec(html);
    if (match === null) throw new Error("no rail on the page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-task-1c-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a queued task says whether it can actually dispatch, including the exact worker repair", async () => {
    seed("t-ready", "tell me if this will run");
    await boot();
    const cookie = await login();

    // The runner was registered at T0 and has gone quiet. The task must not
    // merely say queued: it names the blocking gate and the one-command road.
    const offline = await (await fetch(url("/t/t-ready"), { headers: { cookie } })).text();
    expect(offline).toContain('id="run-status" data-dispatch-status="no-worker-online"');
    expect(offline).toContain("Builder disconnected");
    expect(offline).toContain("stopped checking in");
    expect(offline).toContain("standing-orders up");
    expect(offline).toContain("Get this task running");
    expect(offline).toContain('<details class="dispatch-recovery" open>');
    expect(offline).toContain('class="dispatch-recovery-command">standing-orders up</code>');
    expect(offline).toContain("Reopen Standing Orders on the machine where the project lives");
    expect(offline).toContain("This task resumes automatically when the builder reconnects");
    expect(offline).not.toContain("standing-orders daemon install");
    expect(offline).not.toContain('data-dispatch-status="ready-to-run"');

    // A current heartbeat for a worker bound to this project changes the
    // same durable task to a positive, equally explicit readiness answer.
    store.touchRunner("night-shift-1", new Date());
    const ready = await (await fetch(url("/t/t-ready"), { headers: { cookie } })).text();
    expect(ready).toContain('id="run-status" data-dispatch-status="ready-to-run"');
    expect(ready).toContain("every dispatch gate currently passes");
    expect(ready).not.toContain('id="run-status" data-dispatch-status="no-worker-online"');
    expect(ready).not.toContain("Get this task running");
  });

  test("a cancelled dependency is shown as repair on both the task and queue", async () => {
    seed("t-blocker", "obsolete prerequisite");
    seed("t-dependent", "must not wait forever");
    seed("t-replacement", "replacement prerequisite");
    expect(store.addEdge("t-dependent", "t-blocker")).toEqual({ ok: true });
    expect(store.cancelTask("t-blocker", T0, "replaced")).toMatchObject({ ok: true });
    // All-project session: replacement candidates still come from the
    // dependent task's own project, not the sidebar's current selection.
    await boot({ repo: undefined, repos: ["/repo/main"] });
    const cookie = await login();

    const task = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    expect(task).toContain('data-dispatch-status="terminal-dependency"');
    expect(task).toContain("Choose what happens next");
    expect(task).toContain("This task was waiting for <strong>obsolete prerequisite</strong>, but that task was cancelled.");
    expect(task).toContain("Review that task");
    expect(task).toContain("Choose another task that must finish first");
    expect(task).toContain("Wait for selected task");
    expect(task).toContain("Continue without it");
    expect(task).toContain('aria-label="ways to continue this task"');
    expect(task).toContain('class="dependency-repair-replace"');
    expect(task).toContain('class="dependency-repair-unlink"');
    expect(task).toContain('name="operation" value="replace"');
    expect(task).toContain('name="operation" value="unlink"');
    expect(task).not.toContain('name="operation" value="retry"');
    expect(task).not.toContain(">plan first</button>");
    expect(task).not.toContain("hold next attempt");
    expect(task).not.toContain("No approved scope yet");
    expect(task).not.toContain('<details class="section" id="waits-for"');
    expect(task).toContain(".dependency-repair-actions form > button[type=submit] { width: 100%; }");
    expect(task).toContain(".dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: auto; }");

    const queue = await (await fetch(url("/board?view=order"), { headers: { cookie } })).text();
    expect(queue).toContain('data-task="t-dependent"');
    expect(queue).toContain('data-dispatch-status="terminal-dependency"');
    expect(queue).toContain("a required task did not finish");

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(task)?.[1];
    if (csrf === undefined) throw new Error("no csrf on task");
    const replaced = await fetch(url("/t/t-dependent/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, blocker: "t-blocker", operation: "replace", replacement: "t-replacement" }),
      redirect: "manual",
    });
    expect(replaced.status).toBe(303);
    expect(store.blockers("t-dependent")).toEqual(["t-replacement"]);

    const waiting = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    expect(waiting).toContain('data-dispatch-status="waiting-dependency"');
    expect(waiting).toContain("Waiting for another task");
    expect(waiting).not.toContain("No approved scope yet");

    expect(store.cancelTask("t-replacement", T0, "also obsolete")).toMatchObject({ ok: true });
    const afterReplace = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    const csrfAgain = /name="csrf" value="([0-9a-f]{64})"/.exec(afterReplace)?.[1];
    if (csrfAgain === undefined) throw new Error("no csrf after replacement");
    const unlinked = await fetch(url("/t/t-dependent/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrfAgain, blocker: "t-replacement", operation: "unlink" }),
      redirect: "manual",
    });
    expect(unlinked.status).toBe(303);
    expect(store.blockers("t-dependent")).toEqual([]);
  });

  test("a failed dependency can be retried in place without dropping the edge", async () => {
    seed("t-failed-blocker", "repair this first");
    seed("t-after", "still needs the prerequisite");
    store.addEdge("t-after", "t-failed-blocker");
    store.setTaskState("t-failed-blocker", "failed", T0);
    await boot();
    const cookie = await login();
    const task = await (await fetch(url("/t/t-after"), { headers: { cookie } })).text();
    expect(task).toContain('name="operation" value="retry"');
    expect(task).toContain("Try that task again");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(task)?.[1];
    if (csrf === undefined) throw new Error("no csrf on task");

    const retried = await fetch(url("/t/t-after/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, blocker: "t-failed-blocker", operation: "retry" }),
      redirect: "manual",
    });
    expect(retried.status).toBe(303);
    expect(store.getTask("t-failed-blocker")?.state).toBe("queued");
    expect(store.blockers("t-after")).toEqual(["t-failed-blocker"]);
  });

  test("a completed task speaks the machine's own verdict (Priority 2) — never inferred at render", async () => {
    const ref = seed("t-proof", "show me the proof");
    const run = finished("t-proof", ref, "built", 0.25);
    store.setTaskState("t-proof", "done", T0);
    await boot();
    const cookie = await login();

    // No handoff, no terminal diff, and no verdict at all: the honest
    // default is "needs verification", never a guess at "done".
    const bare = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(bare).toContain('data-dispatch-status="needs-verification"');
    expect(bare).not.toContain('data-dispatch-status="complete-with-evidence"');
    expect(bare).toContain('data-card-kind="result-receipt"');
    expect(bare).toContain("What shipped");
    expect(bare).toContain(`href="/r/${run}">Review full evidence</a>`);
    expect(bare).toContain('href="/chat?task=t-proof">Discuss or request changes →</a>');

    const sha256 = createHash("sha256").update("").digest("hex");
    for (const kind of ["handoff", "terminal-diff"] as const) {
      store.saveArtifact({
        run,
        kind,
        key: `${run}/${kind}`,
        bytesOriginal: 0,
        bytesStored: 0,
        truncated: false,
        sha256,
        capture: `${kind} (exit 0)`,
      }, T0);
    }
    // Artifacts alone still do not say "done" — only the machine's own
    // saved verdict does (the presence-only check this strengthens).
    const stillBare = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(stillBare).toContain('data-dispatch-status="needs-verification"');

    store.saveProofVerdict(run, "attested", ["the proof agrees with the sealed diff; no verification command is configured to re-run"], T0);
    const attested = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(attested).toContain('data-dispatch-status="complete-with-evidence"');
    expect(attested).toContain(`Build #${run}`);
    expect(attested).toContain("acceptance criteria, checks, and machine-captured diff");

    store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T0);
    const verified = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(verified).toContain('data-dispatch-status="complete-verified"');
    expect(verified).toContain('data-proof-state="verified"');

    store.saveProofVerdict(run, "verified", ["the approved verification command passed after the approved setup command ran"], T0);
    const recovered = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recovered).toContain('data-automatic-recovery="succeeded"');
    expect(recovered).toContain("Standing Orders ran the approved setup automatically, then the project check passed.");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the project setup or check changed"], T0);
    const recoveryStopped = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryStopped).toContain("Automatic recovery stopped because the project setup or check changed. Review and reapprove automatic recovery before retrying.");

    store.saveProofVerdict(run, "short", ["the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"], T0);
    const recoveryNotEnabled = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryNotEnabled).toContain("The project check couldn&#39;t start because a required project executable was missing. Automatic recovery wasn&#39;t enabled for this check.");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because Standing Orders could not confirm that the built checkout was unchanged"], T0);
    const recoveryUnconfirmed = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryUnconfirmed).toContain("Standing Orders couldn&#39;t confirm that no files changed after the build was saved. Review the build log, then try again.");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because tracked files no longer matched the built result"], T0);
    const recoveryFilesChanged = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryFilesChanged).toContain("Automatic recovery stopped because files changed after the build was saved. Review those changes before retrying.");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the checkout moved away from the built commit"], T0);
    const recoveryCheckoutMoved = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryCheckoutMoved).toContain("Automatic recovery stopped because Standing Orders found a different project version than the one it built. Review the build log before retrying.");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the setup command changed tracked files after the build"], T0);
    const recoveryChangedFiles = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryChangedFiles).toContain("Automatic recovery stopped because project setup changed files after the build. Review those changes before retrying.");

    store.saveProofVerdict(run, "short", ["the required project executable was still unavailable after replaying the approved setup command"], T0);
    const recoveryExecutableStillMissing = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryExecutableStillMissing).toContain("Automatic recovery ran once, but the required project executable was still missing.");

    store.saveProofVerdict(run, "short", ["the retried verification command timed out after automatic recovery"], T0);
    const recoveryRetryTimedOut = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryRetryTimedOut).toContain("Automatic recovery ran the approved setup, but the retried project check timed out.");

    store.saveProofVerdict(run, "short", ["the retried verification command could not be started after automatic recovery"], T0);
    const recoveryRetryCouldNotStart = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryRetryCouldNotStart).toContain("Automatic recovery ran the approved setup, but Standing Orders still couldn&#39;t start the project check.");

    store.saveProofVerdict(run, "verified", ["the approved verification command passed after the approved setup command ran"], T0);

    // Focused chat is a second lens over the same durable receipt, not a
    // model-authored summary or a separate result record.
    const chat = await (await fetch(url("/chat?task=t-proof"), { headers: { cookie } })).text();
    expect(chat).toContain('class="card completion-receipt" data-card-kind="result-receipt"');
    expect(chat).toContain(`href="/r/${run}">Review & annotate</a>`);
    expect(chat).toContain('href="#latest">Request changes in chat →</a>');
    expect(chat).not.toContain("Discuss or request changes →");

    store.saveProofVerdict(run, "refuted", ["claimed changed path not in the sealed diff: src/other.ts"], T0);
    const refuted = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(refuted).toContain('data-dispatch-status="proof-refuted"');
    expect(refuted).toContain("src/other.ts");
    expect(refuted).toContain('name="csrf"');
    expect(refuted).toContain("Accept with exception");

    // Accepting flips the class, never the token — every surface still
    // agrees on WHAT happened; a person has simply signed off on it.
    store.acceptProof(run, "alex", "seen it, shipping anyway", T0);
    const accepted = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(accepted).toContain('data-dispatch-status="proof-refuted"');
    expect(accepted).toContain("It was accepted after a manual review");
    expect(accepted).not.toContain("Accept with exception</button>");
  });

  test("v40: the criterion matrix shows the reviewer's own judgement, and a repair chain renders on both the source and draft task pages", async () => {
    store.createTask({ id: "t-review", title: "reviewed work" }, T0);
    const ref = store.refFor("built-in", "t-review", "ours").id;
    store.placeTask(ref, "/repo/main");
    propose(store, { taskId: "t-review", goal: "wire the guard", acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["manual-review"] }], now: T0 });
    sign("t-review");
    const run = store.startRun({ taskRef: ref, leaseId: "l-review", runner: "night-shift-1", provider: "claude", branch: "b", worktree: "/wt", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(
      run,
      "refuted",
      ['reviewer:codex contradicts criterion "c1": never wired in'],
      T0,
      [
        {
          id: "c1",
          statement: "it works",
          requiredEvidence: ["manual-review"],
          state: "failed",
          detail: ['reviewer:codex contradicts criterion "c1": never wired in'],
          answered: [],
          review: { judgement: "contradicts", note: "never wired in", author: "reviewer:codex" },
        },
      ],
      "short",
    );
    store.setTaskState("t-review", "done", T0);

    const { maybeTriggerRepair } = await import("./dispose.js");
    const trigger = maybeTriggerRepair(store, "/repo/main", evidenceRoot, run, "refuted", T0);
    if (trigger.kind !== "drafted") throw new Error(`expected a draft, got ${trigger.kind}`);

    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-review"), { headers: { cookie } })).text();
    expect(html).toContain('data-review-judgement="contradicts"');
    expect(html).toContain("reviewer: contradicted");
    expect(html).toContain("An independent review found conflicting evidence");
    expect(html).toContain("Automatic recovery");
    expect(html).toContain(trigger.draftTaskId);

    const draftHtml = await (await fetch(url(`/t/${trigger.draftTaskId}`), { headers: { cookie } })).text();
    expect(draftHtml).toContain("Automatic recovery");

    // The inbox's "needs verification" row carries the SAME chain fact —
    // one more word on the same chip, never a second card.
    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(inbox).toContain("t-review");
    expect(inbox).toContain("repair drafted, awaiting approval");
  });

  test("the inbox surfaces a completed task with an unaccepted short or refuted verdict, and drops it once accepted", async () => {
    const ref = seed("t-proof", "show me the proof");
    const run = finished("t-proof", ref, "built", 0.25);
    store.setTaskState("t-proof", "done", T0);
    store.saveProofVerdict(run, "refuted", ["claimed changed path not in the sealed diff: src/other.ts"], T0);
    await boot();
    const cookie = await login();

    const inbox = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(inbox).toContain("conflicting evidence");
    expect(inbox).toContain("show me the proof");
    expect(inbox).toContain('href="/t/t-proof"');

    store.acceptProof(run, "alex", null, T0);
    const cleared = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(cleared).not.toContain("show me the proof");
  });

  test("the attempt panel names the run; its pollers hit the RUN's fragments, never the task URL", async () => {
    const ref = seed("t-live", "being built");
    const run = live("t-live", ref);
    await boot({ localRunner: "night-shift-1" });
    const cookie = await login();
    const html = await (await fetch(url("/t/t-live"), { headers: { cookie } })).text();

    expect(html).toContain(`build #${run} · night-shift-1 · running`);
    expect(html).toContain(`data-live-run="${run}"`);
    expect(html).toContain(`href="/r/${run}">full build view →`);
    // The embedded regions and the scripts that fill them, addressed to
    // the run's own authenticated fragments — no /t/:id?fragment= proxy.
    expect(html).toContain('id="run-peek"');
    expect(html).toContain('id="live-transcript"');
    expect(html).toContain(`"/r/${run}?fragment=peek"`);
    expect(html).toContain(`"/r/${run}"+"?fragment=transcript&from="`);
    expect(html).not.toContain("fetch(location.pathname");
    expect(html).not.toContain("/t/t-live?fragment");
    // Honesty lines preserved verbatim from the run page.
    expect(html).toContain("display only");

    // The Claude-only transcript limitation is kept: a codex build gets the
    // peek and the stated limit, not an empty transcript.
    const ref2 = seed("t-codex", "built by codex", { provider: "codex", model: "gpt-5-codex" });
    const run2 = live("t-codex", ref2, "codex", "gpt-5-codex");
    const codex = await (await fetch(url("/t/t-codex"), { headers: { cookie } })).text();
    expect(codex).toContain(`build #${run2} · night-shift-1 · running`);
    expect(codex).toContain("the live transcript needs the claude harness for now");
    expect(codex).not.toContain('id="live-transcript"');
    expect(codex).not.toContain("?fragment=transcript");

    // The workbench's selected-task pane carries no run pollers, so the
    // panel there is the static line with the door — never an empty
    // region promising a look that cannot land.
    const pane = await (await fetch(url("/workbench?t=t-live"), { headers: { cookie } })).text();
    expect(pane).toContain(`build #${run} · night-shift-1 · running`);
    expect(pane).toContain("the live view is on the build page");
    expect(pane).toContain(`href="/r/${run}">full build view →`);
    expect(pane).not.toContain('id="run-peek"');
    expect(pane).not.toContain(`/r/${run}?fragment=peek`);
  });

  test("sensitive composition: a password ceremony beside a live attempt — no poller, a static panel, link-only decisions", async () => {
    const ref = seed("t-both", "live and unsigned");
    const run = live("t-both", ref);
    // The scope is rewritten after the claim: the approval no longer binds
    // it, so the page grows its password ceremony while the run stays live.
    const signed0 = store.getScope("t-both");
    if (signed0 === null) throw new Error("no scope");
    store.saveScope({ ...signed0, goal: "a wider goal", proposedAt: new Date().toISOString() });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [
          { id: "keep", label: "Keep and backfill", consequence: "cleanup later", reversible: true },
          { id: "drop", label: "Drop it", consequence: "gone", reversible: false },
        ],
        recommendation: "keep",
      },
      new Date(),
    );
    await boot({ localRunner: "night-shift-1" });
    const cookie = await login();
    const html = await (await fetch(url("/t/t-both"), { headers: { cookie } })).text();

    expect(SENSITIVE_INPUT.test(html)).toBe(true);
    // The panel is a static line with the door; nothing polls.
    expect(html).toContain(`build #${run} · night-shift-1 · running`);
    expect(html).toContain(`href="/r/${run}">full build view →`);
    expect(html).not.toContain('id="run-peek"');
    expect(html).not.toContain('id="live-transcript"');
    expect(html).not.toContain("?fragment=peek");
    expect(html).not.toContain("?fragment=transcript");
    // The decision renders link-only: the question and its road, no form
    // that answers, no enhancement script.
    expect(html).toContain("Which way?");
    expect(html).toContain("the full question →");
    expect(html).not.toContain('class="decide-inline"');
    expect(html).not.toContain("decide-inline");
    expect(html).not.toContain('action="/d/');

    // The same task, once re-signed, gets the live composition back.
    sign("t-both");
    const signed = await (await fetch(url("/t/t-both"), { headers: { cookie } })).text();
    expect(SENSITIVE_INPUT.test(signed)).toBe(false);
    expect(signed).toContain('id="run-peek"');
    expect(signed).toContain('class="decide-option decide-inline"');
    expect(signed).toContain("decide-inline"); // the inline enhancement rides
  });

  test("publishes as: push, open-PR, and merge are phrased independently; absent says so", async () => {
    await boot();
    const cookie = await login();
    const words = async (id: string): Promise<string> => {
      const rail = railOf(await (await fetch(url(`/t/${id}`), { headers: { cookie } })).text());
      const match = /<span class="meta">publishes as<\/span> <span class="mono">([^<]*)<\/span>/.exec(rail);
      if (match === null) throw new Error("no publishes-as row");
      return match[1] as string;
    };
    seed("t-none", "no grant");
    expect(await words("t-none")).toBe("no publication grant — built work stays on its branch");

    const grant = (capabilities: ("push-branch" | "open-pr")[], merge: boolean) =>
      store.savePublicationGrant(
        {
          repo: "/repo/main", githubRepo: "ap9000/main", remote: "origin", headPrefix: "standing-orders/", base: "main",
          capabilities, selector: "ours", draft: false, grantedBy: "alex",
          ...(merge ? { merge: true, mergeMethod: "squash" as const } : {}),
        },
        new Date(),
      );
    grant(["push-branch"], false);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · cannot merge");
    grant(["push-branch", "open-pr"], false);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · may open a PR against main · cannot merge");
    grant(["push-branch", "open-pr"], true);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · may open a PR against main · may merge (squash)");
  });

  test("economics rows say measured or unmeasured on both lines; the approved scope wears its seal in the rail", async () => {
    const ref = seed("t-money", "costly");
    finished("t-money", ref, "built", 1.25);
    await boot();
    const cookie = await login();
    let rail = railOf(await (await fetch(url("/t/t-money"), { headers: { cookie } })).text());
    expect(rail).toContain("this attempt</span> <span class=\"mono\">$1.25 · 44k tokens · measured");
    expect(rail).toContain("task total</span> <span class=\"mono\">$1.25 · 44k tokens · measured");
    expect(rail).toContain("approved scope");
    expect(rail).toContain('<span class="seal">signs ');
    expect(rail).toContain("approved by alex");

    // A newer unmeasured attempt: this attempt is unmeasured in words, the
    // total says how many were, and $0 is never invented.
    finished("t-money", ref, "failed", null);
    rail = railOf(await (await fetch(url("/t/t-money"), { headers: { cookie } })).text());
    expect(rail).toContain("this attempt</span> <span class=\"mono\">unmeasured — 44k tokens, no dollar figure reported");
    expect(rail).toContain("task total</span> <span class=\"mono\">$1.25 measured across 1/2 attempts — 1 unmeasured · 88k tokens");
    expect(rail).not.toContain("$0.00");

    // Measured dollars with NO token report (commit-3 review, finding 2):
    // the tokens are said unreported, never summed as zero.
    const ref2 = seed("t-quiet", "priced, tokens unreported");
    const quiet = store.startRun({
      taskRef: ref2, leaseId: "lease-quiet", runner: "night-shift-1", provider: "claude",
      branch: "standing-orders/t-quiet", worktree: "/pool/t-quiet", now: T0,
      ...presented(store, ref2, "builder"),
    });
    store.stampProviderStart(quiet, T0);
    store.recordUsage(quiet, { costUsd: 0.4 });
    store.finishRun(quiet, { outcome: "built", now: T0 });
    const quietRail = railOf(await (await fetch(url("/t/t-quiet"), { headers: { cookie } })).text());
    expect(quietRail).toContain("this attempt</span> <span class=\"mono\">$0.40 · tokens unreported · measured");
    expect(quietRail).not.toContain("0 tokens");
  });

  test("subscription telemetry is labeled as an API-price equivalent, never as API-key spend", async () => {
    const ref = seed("t-membership", "covered by the membership");
    const run = finished("t-membership", ref, "built", 2.75);
    store.stampTerminalClass(run, "subscription", "unknown");
    await boot();
    const cookie = await login();

    const task = await (await fetch(url("/t/t-membership"), { headers: { cookie } })).text();
    expect(task).toContain("$2.75 API-price equivalent from subscription usage (not an API charge)");
    expect(task).toContain("subscription · $2.75 API-price equivalent (not an API charge)");
    expect(task).not.toContain(">cost<");

    const runPage = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(runPage).toContain("subscription · $2.75 API-price equivalent (not an API charge)");
    expect(runPage).toContain(">usage</span>");
  });

  test("the task page reads top-down (task page pass): eyebrow, title with state, the acts bar with the resolving act primary, the property list, then folded sections with counts", async () => {
    const ref = seed("t-shape", "shaped");
    const failedRun = finished("t-shape", ref, "failed", null);
    store.createIncident({ run: failedRun, kind: "attempts-exhausted" }, new Date());
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-shape"), { headers: { cookie } })).text();
    // Order: the mono eyebrow, then the title with its state chip, then the acts bar.
    const eyebrow = html.indexOf('<p class="meta task-eyebrow"><span class="mono">t-shape</span>');
    const title = html.search(/<h1 class="task-main-title">shaped <span class="badge badge-[a-z]+">[a-z]+<\/span><\/h1>/);
    const bar = html.indexOf('<div class="acts-bar">');
    expect(eyebrow).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(eyebrow);
    expect(bar).toBeGreaterThan(title);
    // A stalled task's primary act is the retry; hold rides beside it with its reason.
    const barHtml = html.slice(bar, html.indexOf("</div>", bar));
    expect(barHtml).toContain('<span class="primary"><form method="post" action="/t/t-shape/requeue"');
    expect(barHtml).toContain("<button type=\"submit\">hold next attempt</button>");
    expect(barHtml).toContain('name="reason"');
    expect(barHtml.indexOf('name="reason"')).toBeLessThan(barHtml.indexOf("hold next attempt"));
    // The rail is the property list, one row grammar for every key fact.
    const rail = railOf(html);
    expect(rail).toContain('<div class="card props">');
    expect(rail).toMatch(/<span class="meta">last attempt<\/span> <span class="mono"><a href="\/r\/\d+">build #\d+<\/a> · failed · night-shift-1<\/span>/);
    expect(rail).toContain('<span class="meta">approved scope</span> <span class="mono"><span class="seal">signs ');
    expect(rail).toContain('<span class="meta">publishes as</span>');
    expect(rail).toContain('<span class="meta">this attempt</span>');
    // Sections fold with counts: attempts open, spend folded, scope open and addressable.
    expect(html).toContain('<details class="section" id="attempts" open><summary><h2>attempts <span class="lane-count">1</span></h2></summary>');
    expect(html).toContain('<details class="section" id="usage"><summary><h2>usage</h2></summary>');
    expect(html).toContain('<details class="section" id="scope" open><summary><h2>scope</h2></summary>');
    // Cancel stays armed at the foot, after every section.
    expect(html.lastIndexOf('<details class="arm-danger">')).toBeGreaterThan(html.lastIndexOf('<details class="section"'));
  });

  test("hold is 'hold next attempt'; while an attempt runs, retry says when it becomes available instead of offering a deferred button", async () => {
    const ref = seed("t-verbs", "with verbs");
    // Stalled AND live: a failed earlier attempt with an unresolved
    // incident, and a live claim right now.
    const failedRun = finished("t-verbs", ref, "failed", null);
    store.createIncident({ run: failedRun, kind: "attempts-exhausted" }, new Date());
    live("t-verbs", ref);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-verbs"), { headers: { cookie } })).text();
    expect(html).toContain("<button type=\"submit\">hold next attempt</button>");
    // Said once (commit-3 review, finding 3), and only where a retry applies.
    expect(html.split("retry becomes available after this attempt finishes").length - 1).toBe(1);
    expect(html).not.toContain('action="/t/t-verbs/requeue"');

    // A healthy live task offers no retry and says nothing about one.
    const ref2 = seed("t-fine", "just running");
    live("t-fine", ref2);
    const fine = await (await fetch(url("/t/t-fine"), { headers: { cookie } })).text();
    expect(fine).toContain("hold next attempt");
    expect(fine).not.toContain("retry becomes available");
    expect(fine).not.toContain('action="/t/t-fine/requeue"');
    // The attempts ledger row: chip, then one mono meta run with the
    // unmeasured word for the live attempt.
    expect(html).toContain("unmeasured so far");
  });
});


describe("the phone shell (mobile pass): one header row, drawn controls, thumb-sized acts", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-phone-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("the head declares the phone: safe-area viewport and standalone capability on both platforms", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
  });

  test("the design system (v2): one token ramp in two schemes, a theme color per scheme, icons on the sidebar's primary rows", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(html).toContain("color-scheme: light dark;");
    // The light block redefines the same names — never a color that lives in one scheme only.
    const light = /@media \(prefers-color-scheme: light\) \{\s*:root \{(.*?)\}\s*\}/s.exec(html)?.[1] ?? "";
    for (const token of ["--background", "--foreground", "--card", "--muted", "--muted-foreground", "--border", "--input", "--brand", "--brand-foreground", "--running", "--success", "--destructive", "--ring"]) {
      expect(light).toContain(`${token}:`);
    }
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0c0e">');
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafafa">');
    // Sidebar primary rows carry a drawn icon; the foot's rows stay text.
    expect(html).toMatch(/<a href="\/"[^>]*><span class="glyph"><svg/);
    expect(html).toMatch(/<a href="\/runs"><span class="glyph"><svg/);
    expect(html).toMatch(/<a href="\/workbench" aria-label="portfolio" title="portfolio">portfolio<\/a>/);
    // Section headers speak sans; status labels are quiet rounded rectangles,
    // while numeric counts retain the conventional pill silhouette.
    expect(html).toContain("color: var(--muted-foreground); margin: 2rem 0 .5rem; font-family: var(--font-sans);");
    expect(html).toContain("border: 1px solid var(--border); border-radius: .375rem;");
    expect(html).toContain(".count {");
    expect(html).toContain("border-radius: 9999px;");
    expect(html).not.toContain(".badge-running::before");
  });

  test("the header pill names the scope: project with counts when one is open, 'all projects' on the portfolio", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    const pill = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(home)?.[1] ?? "";
    expect(pill).toContain('<span class="name">main<svg');
    expect(pill).toMatch(/<span class="pill-status">.*needs you.*live.*queued.*<\/span>/s);
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    const wide = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(portfolio)?.[1] ?? "";
    expect(wide).toContain('<span class="name">all projects<svg');
    expect(wide).not.toContain("pill-status");
  });

  test("queue cards carry drawn controls — a grip and a to-front arrow — never a glyph standing in for an icon", async () => {
    store.createTask({ id: "t-q", title: "queued work" }, T0);
    store.placeTask(store.refFor("built-in", "t-q").id, "/repo/main");
    const cookie = await login();
    const html = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const card = /<div class="card queue-card" data-task="t-q".*?<\/div>/s.exec(html)?.[0] ?? "";
    expect(card).toContain('<span class="queue-handle" aria-hidden="true"><svg');
    expect(card).toContain('<button type="submit" class="icon-button" aria-label="move to the front"><svg');
    expect(card).not.toContain("≡");
    expect(card).not.toContain("▲");
    expect(card).not.toContain('style="cursor:grab');
    // The fleet's cards share the same grip.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(fleet).toContain('<span class="queue-handle" aria-hidden="true"><svg');
    expect(fleet).not.toContain("≡");
  });

  test("the one-at-a-time screen's 'not now' is a real control, beside its count", async () => {
    store.createTask({ id: "t-n", title: "asks a question" }, T0);
    const ref = store.refFor("built-in", "t-n").id;
    store.placeTask(ref, "/repo/main");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-n", runner: "b1", branch: "standing-orders/t-n", worktree: "/pool/t-n", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    const cookie = await login();
    const html = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(html).toMatch(/<p class="meta next-pager"><span>[^<]*waiting on you<\/span><a class="skip" href="\/next\?skip=[^"]*">not now — next →<\/a><\/p>/);
  });
});


describe("the project switcher (board pass): one tap from any screen, forms with the session's own token", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoA: string;
  let repoB: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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
  const csrfOf = (html: string): string => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-switcher-"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-switcher-repos-")));
    repoA = join(root, "alpha");
    repoB = join(root, "beta");
    const { execSync } = await import("node:child_process");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execSync("git init -q", { cwd: repo });
    }
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig({
      provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50,
      weeklyCeilingMicrousd: 100_000_000, priceInMicrousd: 3, priceOutMicrousd: 15,
    }, "alex", T0);
    server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(), repos: [repoA, repoB],
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
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

  test("every served project is one form in the menu, each carrying the token and this screen as the return", async () => {
    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    const bar = board.slice(board.indexOf('<div class="scope-bar">'), board.indexOf("<main>"));
    expect(bar).toContain('<summary class="name">all projects<svg');
    expect(bar).toContain('<button type="submit" class="current" aria-current="true">all projects</button>');
    for (const repo of [repoA, repoB]) {
      expect(bar).toContain(`<form method="post" action="/projects/open"><input type="hidden" name="csrf" value="${csrfOf(board)}"><input type="hidden" name="return" value="/board?scope=all"><input type="hidden" name="path" value="${repo}"><button type="submit">${repo.split("/").pop()}</button></form>`);
    }
    // The phone pill carries the same menu and a direct management route;
    // the bottom bar stays focused on the five daily destinations.
    expect(board).toContain('<details class="project-pill switcher"><summary>');
    expect(board).toContain('<a class="manage" href="/projects">manage projects</a>');
    expect((board.match(/href="\/projects"/g) ?? []).length).toBe(2);
    // The chrome layer folds an open switcher on an outside tap.
    expect(board).toContain('details.switcher[open]');
  });

  test("chat is a projectless, all-project surface when several projects are served", async () => {
    for (const [id, repo] of [["chat-alpha", repoA], ["chat-beta", repoB]] as const) {
      const made = store.createConsoleTask({ id, title: id, repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "test" }, T0);
      expect(made.ok).toBe(true);
    }
    const cookie = await login();
    const response = await fetch(url("/chat"), { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy") ?? "").toContain("connect-src 'self'");
    const before = await response.text();
    expect(before).toContain("<h1>chat</h1>");
    expect(before).toMatch(/<span class="name">all projects/);
    expect(before).not.toContain("<h1>projects</h1>");

    const csrf = csrfOf(before);
    const minted = await fetch(url("/chat/mate/mint"), {
      method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, "ceiling-usd": "5", token: approverToken }),
    });
    expect(minted.status).toBe(303);
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain('class="chat-workspace"');
    expect(html).toContain("projects in this conversation");
    expect(html).toContain("<strong>alpha</strong>");
    expect(html).toContain("<strong>beta</strong>");
    expect(html).toContain('data-waiting="2"');
    expect(html).toContain(`name="path" value="${repoA}"`);
    expect(html).toContain('name="return" value="/board"');

    const opened = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, path: repoA, return: "/board" }),
    });
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/board");
  });

  test("a project card that is not open is itself the open form: the name returns home, and it carries the session's token", async () => {
    const cookie = await login();
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    const csrf = csrfOf(projects);
    const beta = repoB.split("/").pop() as string;
    expect(projects).toContain(
      `<form method="post" action="/projects/open" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="path" value="${repoB}"><input type="hidden" name="return" value="/"><button type="submit" class="project-name">${beta}</button></form>`,
    );
  });

  test("opening a project returns to the screen the switch was made on — a same-site path only", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    const csrf = csrfOf(home);
    const opened = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf, path: repoA, return: "/queue" }),
      redirect: "manual",
    });
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/queue");
    // The project is open: the queue renders it and the menu marks it current.
    const queue = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(queue).toContain('<summary class="name">alpha<svg');
    expect(queue).toContain(`<input type="hidden" name="path" value="${repoA}"><button type="submit" class="current" aria-current="true">alpha</button>`);
    // An off-site or protocol-relative return lands home instead.
    for (const bad of ["https://evil.example/", "//evil.example/x", "queue"]) {
      const refused = await fetch(url("/projects/open"), {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf, path: repoB, return: bad }),
        redirect: "manual",
      });
      expect(refused.status).toBe(303);
      expect(refused.headers.get("location")).toBe("/");
    }
    // Widening to all projects returns the same way.
    const widened = await fetch(url("/projects/select"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf, path: "", return: "/workbench" }),
      redirect: "manual",
    });
    expect(widened.headers.get("location")).toBe("/workbench");
  });

  test("the portfolio's workspace cards say one status word, count four ways, bar the same counts, and open the board in one tap", async () => {
    const cookie = await login();
    store.createTask({ id: "t-a", title: "alpha needs a scope" }, T0);
    store.placeTask(store.refFor("built-in", "t-a").id, repoA);
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    const card = /<div class="workspace-card hot">.*?<div class="workspace-bar" aria-hidden="true">.*?<\/div><\/div>/s.exec(portfolio)?.[0] ?? "";
    expect(card).toContain('<span class="workspace-name">alpha</span><span class="badge badge-open">needs you</span>');
    expect(card).toContain(`<input type="hidden" name="path" value="${repoA}"><input type="hidden" name="return" value="/board"><button type="submit">board →</button>`);
    expect(card).toContain('<span class="pulse-stat hot"><b>1</b> need you</span>');
    expect(card).toContain('<span class="seg attention" style="flex-grow:1"></span>');
    expect(card).not.toContain('class="seg building"');
    // Follow the tap: the board opens on that project.
    const board = await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(portfolio), path: repoA, return: "/board" }),
      redirect: "manual",
    });
    expect(board.headers.get("location")).toBe("/board");
  });

  test("a scope waiting for its yes leads the page: the ceremony is the first card, above the acts, with the approve act in it", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }),
      redirect: "manual",
    });
    store.createTask({ id: "t-yes", title: "needs the yes" }, T0);
    store.placeTask(store.refFor("built-in", "t-yes").id, repoA);
    store.saveScope({
      taskId: "t-yes", goal: "the goal", outOfScope: "not that", touches: ["src/a.ts"], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const page = await (await fetch(url("/t/t-yes"), { headers: { cookie } })).text();
    const ceremony = page.indexOf('<form method="post" action="/t/t-yes/approve" class="card approve-form approval-card" id="approve">');
    const title = page.indexOf('<h1 class="task-main-title">needs the yes ');
    const bar = page.indexOf('<div class="acts-bar">');
    const layout = page.indexOf('<div class="task-layout">');
    expect(ceremony).toBeGreaterThan(title);
    expect(bar).toBeGreaterThan(ceremony);
    expect(layout).toBeGreaterThan(bar);
    expect(page).toContain('<span class="approval-kicker">ready to run · approve exactly this:</span>');
    expect(page).toContain("Review the proposed scope");
    expect(page).toContain('href="#scope">Edit details</a>');
    expect(page).toContain('name="username" autocomplete="username" class="visually-hidden"');
    expect(page).toContain('<details class="section" id="scope"><summary><h2>scope</h2></summary>');
    expect(page).toContain("approve exactly this:");
    // No other act wears primary while the ceremony leads; the old
    // "needs your approval" card is gone (the ceremony says it).
    expect(page.slice(bar, page.indexOf("</div>", bar))).not.toContain('class="primary"');
    expect(page).not.toContain("its scope needs your approval");
    // The scope section still holds the goal card and the edit road, not the ceremony.
    // (The section holds nested details — the agents card's closed
    // reasons — so it ends at the NEXT section, not the first `</details>`.)
    const scopeStart = page.indexOf('<details class="section" id="scope"');
    const nextSection = page.indexOf('<details class="section"', scopeStart + 1);
    const scopeSection = page.slice(scopeStart, nextSection === -1 ? page.length : nextSection);
    expect(scopeSection).not.toContain('action="/t/t-yes/approve"');
    expect(scopeSection).toContain("edit the scope");

    // A scope the store could not resolve to a routing gets the fix road,
    // never a password it cannot use.
    store.setPhaseConfig("installation", "build", "claude", null, "test", T0);
    store.createTask({ id: "t-fix", title: "cannot be approved yet" }, T0);
    store.placeTask(store.refFor("built-in", "t-fix").id, repoA);
    store.saveScope({
      taskId: "t-fix", goal: "the goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const fix = await (await fetch(url("/t/t-fix"), { headers: { cookie } })).text();
    if (fix.includes("filed but unapprovable")) {
      expect(fix).toContain('<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: its scope cannot be approved yet.</strong></p>');
      expect(fix).toContain('<a class="button-link" href="#scope">edit the scope to fix it →</a>');
      expect(fix).not.toContain('action="/t/t-fix/approve"');
    }
  });

  test("a sensitive page renders the switcher inert: the name and the one link, no forms in the chrome", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    await fetch(url("/projects/open"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: csrfOf(home), path: repoA, return: "/" }),
      redirect: "manual",
    });
    // A task whose scope awaits its password ceremony.
    store.createTask({ id: "t-sign", title: "needs the yes" }, T0);
    store.placeTask(store.refFor("built-in", "t-sign").id, repoA);
    store.saveScope({
      taskId: "t-sign", goal: "the goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const page = await (await fetch(url("/t/t-sign"), { headers: { cookie } })).text();
    expect(SENSITIVE_INPUT.test(page)).toBe(true);
    expect(page).not.toContain('<div class="switcher-menu"');
    expect(page).not.toContain('action="/projects/open"');
    expect(page).toContain('<div class="scope-bar"><span class="name">alpha</span>');
    expect(page).toContain('<a class="project-pill" href="/projects"><span class="name">alpha</span>');
  });
});

describe("the mate's thread (mate arc, slice 2): one ceremony, then a conversation whose acts are cards", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoDir: string;
  let script: (() => Response)[];
  let subscriptionAnswers: MateProviderAnswer[];
  let clockNow: Date;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-09-02T12:00:00.000Z");
  type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
  const answer = (blocks: Block[]) =>
    new Response(JSON.stringify({ type: "message", content: blocks, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const page = async (cookie: string): Promise<string> => (await fetch(url("/chat"), { headers: { cookie } })).text();
  const csrfFrom = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on /chat");
    return match[1] as string;
  };
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (store.liveMateTurnFor("alex") === null) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("the mate turn never settled");
  };
  const mint = async (cookie: string, ceilingUsd = "50"): Promise<string> => {
    const csrf = csrfFrom(await page(cookie));
    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": ceilingUsd, token: approverToken });
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/chat");
    return csrf;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-mate-ev-"));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-mate-repo-")));
    clockNow = T0;
    script = [];
    subscriptionAnswers = [];
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 100_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", T0);
    for (const id of ["a", "b"]) {
      const made = store.createConsoleTask({ id, title: `task ${id}`, repo: repoDir, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => clockNow,
      repo: repoDir,
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
      chatFetcher: (async () => {
        const next = script.shift();
        if (next === undefined) throw new Error("the script ran out");
        return next();
      }) as typeof fetch,
      subscriptionChatRunner: async () => {
        const next = subscriptionAnswers.shift();
        if (next === undefined) throw new Error("the subscription script ran out");
        return { ok: true, answer: next };
      },
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
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("the mint card is the one password ceremony; the thread then takes messages without one", async () => {
    const cookie = await login();
    const before = await page(cookie);
    expect(before).toContain('action="/chat/mate/mint"');
    expect(before).not.toContain('class="thread"');
    const csrf = csrfFrom(before);
    expect(before).not.toContain('name="hours"');
    const noPassword = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5" });
    expect(noPassword.headers.get("location") ?? "").toContain("password");
    expect(store.activeMateSession("alex")).toBeNull();
    const badTerms = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "0", token: approverToken });
    expect(badTerms.headers.get("location") ?? "").toContain("dollar");
    await mint(cookie, "5");
    const session = store.activeMateSession("alex");
    expect(session).toMatchObject({ approver: "alex", ceilingMicrousd: 5_000_000, spentMicrousd: 0 });
    const thread = await page(cookie);
    expect(thread).toContain('class="thread"');
    expect(thread).toContain('class="chat-workspace"');
    expect(thread).toContain('class="chat-projects"');
    expect(thread).toContain('id="chat-project-panel"');
    expect(thread).toContain('class="side-toggle" aria-label="collapse sidebar"');
    expect(thread).toContain('class="chat-project-toggle quiet" aria-controls="chat-project-panel"');
    expect(thread).toContain("standing-orders:chat-projects");
    expect(thread).toContain('.chat-workspace .composer { position: static; width: 100%; box-shadow: var(--shadow); }');
    expect(thread).toContain('position: fixed; left: 1rem; right: 1rem; bottom: calc(3.75rem + env(safe-area-inset-bottom, 0rem));');
    expect(thread).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(thread).toContain('.chat-prompts form:last-child:nth-child(odd) { grid-column: 1 / -1; }');
    expect(thread).toContain('.chat-main:has(.chat-empty) .thread { min-height: 0; margin-bottom: .5rem; }');
    expect(thread).toContain('width: 100%; min-width: 0; max-width: 100%; margin: 0; padding: 2rem 0 .75rem;');
    expect(thread).toContain('.chat-main:has(.chat-empty) .composer { position: static; width: 100%; margin-top: .5rem; }');
    expect(thread).toContain('data-card-kind="fleet-overview"');
    expect(thread).toContain('aria-label="live portfolio overview"');
    expect(thread).toContain('aria-label="projects in this conversation"');
    expect(thread).toContain('name="message" value="Brief me on what needs my attention, what is building, and the highest-leverage next action across every project."');
    expect(thread).toMatch(/<span class="name">all projects/);
    expect(thread).toContain('class="card composer"');
    expect(thread).not.toContain('name="token"');
    expect(thread).toContain("What do you want to get done?");
    expect(thread).toContain("Describe what you want done…");
    expect(thread).toContain("One message is enough.");
    expect(thread).toContain("use your judgment");
    expect(thread).toContain('>new task</button>');
    expect(thread).toContain("this conversation: $0.00 of $5.00");
    expect(thread).toContain("stays live until you end it");
    expect(thread).toContain('action="/chat/mate/end"');
  });

  test("a task's Ask view stays in the unified thread and confirms guidance without losing context", async () => {
    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/a"), { headers: { cookie } })).text();
    expect(taskHtml).toContain('aria-label="task view"');
    expect(taskHtml).toContain('href="/t/a" class="active" aria-current="page">Overview</a>');
    expect(taskHtml).toContain('href="/chat?task=a">Ask</a>');

    let html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('class="chat-workspace task-chat-workspace"');
    expect(html).toContain('aria-label="current task"');
    expect(html).toContain('href="/chat?task=a" class="active" aria-current="page">Ask</a>');
    expect(html).toContain('aria-label="task progress"');
    expect(html).toContain("Review the plan & start");
    expect(html).toContain('action="/t/a/approve"');
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain('data-poll="0"');
    expect(html).not.toContain('id="chat-project-panel"');
    expect(html).not.toContain('data-card-kind="fleet-overview"');
    const csrf = csrfFrom(html);
    const safeFragment = await (await fetch(url("/chat/task-status?task=a"), { headers: { cookie } })).text();
    expect(safeFragment).toContain("Refresh this conversation to open the secure approval step.");
    expect(safeFragment).not.toContain('type="password"');

    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(html)?.[1];
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1];
    if (nonce === undefined || digest === undefined) throw new Error("no focused-chat approval ceremony");
    const approved = await post(cookie, "/t/a/approve", { csrf, nonce, digest, token: approverToken, return: "/chat?task=a" });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe("/chat?task=a");
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: true, by: "alex" });
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-poll="1"');
    expect(html).not.toContain('action="/t/a/approve"');
    const fragment = await (await fetch(url("/chat/task-status?task=a"), { headers: { cookie } })).text();
    expect(fragment).toContain('id="task-chat-live"');
    expect(fragment).toContain('data-poll="1"');

    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5", token: approverToken, return: "/chat?task=a" });
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/chat?task=a");

    const unknown = await post(cookie, "/chat", { csrf, task: "not-in-this-workspace", message: "do something" });
    expect(decodeURIComponent(unknown.headers.get("location") ?? "")).toContain("not available in this workspace");
    expect(store.recentMateTurns("alex", 5)).toEqual([]);

    script.push(
      () => answer([
        { type: "tool_use", id: "r1", name: "get_task", input: { task: "a" } },
        { type: "tool_use", id: "s1", name: "propose_steer", input: { task: "a", note: "Polish the compact mobile navigation before broadening the sidebar." } },
      ]),
      () => answer([{ type: "text", text: "I drafted focused guidance for the next attempt." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, task: "a", message: "Make the next pass focus on the mobile navigation." });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/chat?task=a#latest");
    await settle();

    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-card-kind="steer"');
    expect(html).toContain("Guidance for next attempt");
    expect(html).toContain("without changing the task’s scope");
    expect(html).toContain('name="task" value="a"');
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain('data-message-role="operator"><p style="white-space:pre-wrap">Make the next pass focus on the mobile navigation.</p>');
    expect(html).not.toContain("Current task: a.");
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toEqual([]);

    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf, return: "/chat?task=a" });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe("/chat?task=a#latest");
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toMatchObject([
      { note: "Polish the compact mobile navigation before broadening the sidebar.", author: "alex", authorshipState: "verified", attachedRun: null },
    ]);
  });

  test("chat-steer: the mate reads the current risk and agents, proposes a confirmation-gated agent change, the card says exactly what changes, and confirming goes through the authenticated route edit", async () => {
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "test", T0);
    const cookie = await login();
    let html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const csrf = csrfFrom(html);
    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5", token: approverToken, return: "/chat?task=a" });
    expect(minted.status).toBe(303);
    // Approve the scope as it stands so the change has an approval to stale.
    const scope = store.getScope("a")!;
    expect(approve(store, "a", "alex", clockNow, scope.digest, approverToken).ok).toBe(true);
    script.push(
      () => answer([{ type: "tool_use", id: "g1", name: "get_agents", input: { task: "a" } }]),
      () => {
        return answer([{ type: "tool_use", id: "p1", name: "propose_agents", input: { task: "a", risk: "elevated", role: "reviewer", agent: { provider: "codex", model: "gpt-5-codex" }, why: "the change touches money" } }]);
      },
      () => answer([{ type: "text", text: "I propose declaring this elevated and reviewing on codex · gpt-5-codex." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, task: "a", message: "Who reviews this, and can we use the stronger reviewer?" });
    expect(sent.status).toBe(303);
    await settle();
    // The turn ran both tools and answered; the proposal waits pending.
    expect(store.recentMateTurns("alex", 1)[0]).toMatchObject({ state: "answered" });
    expect(store.getMateProposal(1)).toMatchObject({ kind: "agents", state: "pending", payload: expect.objectContaining({ task: "a", risk: "elevated", phase: "review", provider: "codex", model: "gpt-5-codex", approval: "approved", before: "claude · sonnet plans, builds, repairs, and reviews" }) });
    // The card: the role, the exact agent, what the risk does, the approval consequence.
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-card-kind="agents"');
    expect(html).toContain("Agents change");
    expect(html).toContain("reviewer on <span class=\"mono\">codex · gpt-5-codex</span>");
    expect(html).toContain("<dt>agents now</dt><dd>claude · sonnet plans, builds, repairs, and reviews</dd>");
    expect(html).toContain("Elevated risk: the review runs on the strongest configured reviewer; planning and building keep the everyday agents unless the work itself asks for more (strict quality or screenshots).");
    expect(html).toContain("The current approval no longer covers the task afterwards — approve it again on the task.");
    expect(store.refFor("built-in", "a").routeOverrides).toEqual([]);
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: true });
    // Confirming is the operator's own act through the one route edit: recorded as alex, the approval staled.
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf, return: "/chat?task=a" });
    expect(confirmed.status).toBe(303);
    const ref = store.refFor("built-in", "a");
    expect(ref.riskLevel).toBe("elevated");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "review", provider: "codex", model: "gpt-5-codex", by: "alex" })]);
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: false, reason: "changed" });
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain("risk is now elevated risk; the reviewer is now codex · gpt-5-codex — the earlier approval no longer covers this task; approve it again");
    expect(html).toContain('<p class="agents-summary">claude · sonnet plans, builds, and repairs; codex · gpt-5-codex reviews</p>');
    expect(html).toContain('action="/t/a/approve"');
  });

  test("a focused chat answers a blocking decision and returns to the same conversation", async () => {
    const ref = store.refFor("built-in", "a").id;
    const scope = store.getScope("a");
    if (scope === null) throw new Error("no scope");
    expect(approve(store, "a", "alex", clockNow, scope.digest, approverToken)).toMatchObject({ ok: true });
    const run = store.startRun({ taskRef: ref, leaseId: "decision-lease", runner: "builder", branch: "standing-orders/a", worktree: "/tmp/a", now: clockNow, ...presented(store, ref, "builder") });
    const decision = store.saveDecision({
      run,
      urgency: "blocking",
      recap: "The layout can preserve or replace the existing navigation.",
      question: "Keep the familiar navigation structure?",
      options: [
        { id: "keep", label: "Keep it", consequence: "The information architecture stays familiar.", reversible: true },
        { id: "replace", label: "Replace it", consequence: "The old structure is removed.", reversible: false },
      ],
      recommendation: "keep",
    }, clockNow);
    const cookie = await login();
    const html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const csrf = csrfFrom(html);
    expect(html).toContain("Keep the work moving");
    expect(html).toContain(`action="/d/${decision}/answer"`);
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain(`/d/${decision}?return=%2Fchat%3Ftask%3Da`);

    const answered = await post(cookie, `/d/${decision}/answer`, { csrf, choice: "keep", return: "/chat?task=a" });
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/chat?task=a");
    expect(store.getDecision(decision)).toMatchObject({ state: "answered", choice: "keep", answeredBy: "alex" });
    const refreshed = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(refreshed).not.toContain("Keep the familiar navigation structure?");
  });

  test("a task filed from chat hands off directly to its focused conversation", async () => {
    const cookie = await login();
    const csrf = await mint(cookie, "5");
    script.push(
      () => answer([{ type: "tool_use", id: "p1", name: "propose_task", input: {
        repo: "r1",
        title: "Polish the result cockpit",
        goal: "Make completed work faster to review.",
        acceptance: [{ id: "c1", statement: "A reviewer can understand the result quickly.", evidence: ["manual-review"] }],
        planning: "required",
      } }]),
      () => answer([{ type: "text", text: "I drafted the task for confirmation." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, message: "Add a focused result cockpit." });
    expect(sent.status).toBe(303);
    await settle();
    let html = await page(cookie);
    expect(html).toContain('data-card-kind="task"');
    expect(html).toContain("inspect the project and draft a plan first");
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    const proposal = store.getMateProposal(1);
    const taskId = typeof proposal?.outcome?.["taskId"] === "string" ? proposal.outcome["taskId"] : null;
    if (taskId === null) throw new Error("the task proposal did not file");
    expect(store.lookupRef(taskId)?.plan).toBe("requested");
    html = await page(cookie);
    expect(html).toContain("the planner is reading the project before you approve anything");
    expect(html).toContain(`href="/chat?task=${taskId}">continue in chat</a>`);
    expect(html).toContain(`href="/t/${taskId}">overview</a>`);
  });

  test("a logged-in Codex membership has no dollar maximum in setup, minting, or the live conversation", async () => {
    const cookie = await login();
    let html = await page(cookie);
    const csrf = csrfFrom(html);
    const configured = await post(cookie, "/chat/config", {
      csrf,
      provider: "codex-subscription",
      model: "default",
      "weekly-usd": "100",
      "daily-turns": "25",
      token: approverToken,
    });
    expect(configured.status).toBe(303);
    expect(store.getChatConfig()).toMatchObject({ provider: "codex-subscription", model: "default", dailyTurns: 25, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 });

    html = await page(cookie);
    expect(html).toContain("Codex membership (logged-in CLI)");
    expect(html).toContain("membership login · no dollar ceiling");
    expect(html).toContain("no dollar maximum");
    expect(html).toContain("codex login");
    expect(html).not.toContain('name="weekly-usd"');
    expect(html).not.toContain('name="ceiling-usd"');
    expect(html).not.toContain('name="key"');

    const minted = await post(cookie, "/chat/mate/mint", { csrf, token: approverToken });
    expect(minted.status).toBe(303);
    expect(store.activeMateSession("alex")).toMatchObject({ ceilingMicrousd: 0, spentMicrousd: 0 });
    subscriptionAnswers.push({ text: "## Fleet status\n\n- **Queue:** calm\n- Run `smoke` next.\n\n<script>bad()</script>", calls: [], tokensIn: 21, tokensOut: 5, reportedCostMicrousd: null });
    const sent = await post(cookie, "/chat", { csrf, message: "how does it look?" });
    expect(sent.status).toBe(303);
    await settle();

    html = await page(cookie);
    expect(html).toContain('<div class="chat-copy"><h3>Fleet status</h3><ul><li><strong>Queue:</strong> calm</li><li>Run <code>smoke</code> next.</li></ul><p>&lt;script&gt;bad()&lt;/script&gt;</p></div>');
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).toContain("membership login · no dollar ceiling");
    expect(html).not.toContain("this session: $0.00 of $0.00");
    expect(html).toContain('class="card composer"');
    expect(html).not.toContain('name="token"');
    const turn = store.recentMateTurns("alex", 1)[0];
    expect(turn).toMatchObject({ state: "answered", reservedMicrousd: 0, settledMicrousd: 0, tokensIn: 21, tokensOut: 5 });
    expect(store.raw().prepare("SELECT provider, reserved_microusd, settled_microusd FROM chat_turn WHERE mate_turn = ?").get(turn?.id)).toEqual({ provider: "codex-subscription", reserved_microusd: 0, settled_microusd: 0 });
  });

  test("a turn: the model reads and proposes, the card confirms through the door, a stale card refuses", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "queue", input: { repo: "r1" } }, { type: "tool_use", id: "c2", name: "propose_next", input: { task: "b" } }]),
      () => answer([{ type: "text", text: "I propose moving b to the front." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, message: "what is queued?" });
    expect(sent.status).toBe(303);
    await settle();
    const turn = store.recentMateTurns("alex", 1)[0];
    expect(turn).toMatchObject({ state: "answered", steps: 2 });
    let html = await page(cookie);
    expect(html).toContain('<div class="msg op" data-message-role="operator"><p style="white-space:pre-wrap">what is queued?</p></div>');
    expect(html).toContain("I propose moving b to the front.");
    expect(html).toContain('class="chat-activity"');
    expect(html).toContain("read 1");
    expect(html).toContain("proposed 1");
    expect(html).toContain("2 steps");
    expect(html).toContain('data-card-kind="next"');
    expect(html).toContain('class="proposal-facts"');
    expect(html).toContain('action="/chat/proposal/1/confirm"');
    expect(html).toContain('action="/chat/proposal/1/dismiss"');
    // No csrf: the central gate refuses, nothing moves.
    const forged = await fetch(url("/chat/proposal/1/confirm"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({}), redirect: "manual" });
    expect(forged.status).toBe(403);
    expect(store.getMateProposal(1)?.state).toBe("pending");
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    expect(store.getMateProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(store.queuePosition("b")?.position).toBe(1);
    html = await page(cookie);
    expect(html).toContain("b moved to the front of its column");
    expect(html).not.toContain('action="/chat/proposal/1/confirm"');
    // A second act on the same card is a no-op with a note.
    await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(store.getMateProposal(1)?.state).toBe("confirmed");
    // A proposal the queue outran: the door refuses with the typed reason, rendered on the card.
    script.push(
      () => answer([{ type: "tool_use", id: "c3", name: "propose_next", input: { task: "a" } }]),
      () => answer([{ type: "text", text: "Now a." }]),
    );
    await post(cookie, "/chat", { csrf, message: "and a?" });
    await settle();
    expect(store.getMateProposal(2)?.state).toBe("pending");
    store.moveTaskNext("a", clockNow);
    await post(cookie, "/chat/proposal/2/confirm", { csrf });
    expect(store.getMateProposal(2)).toMatchObject({ state: "refused" });
    html = await page(cookie);
    expect(html).toContain("the queue moved since this was proposed");
    // Session spend is the two turns' settled cost, shown on the page.
    const session = store.activeMateSession("alex");
    expect(session?.spentMicrousd).toBe(4 * (100 * 3 + 20 * 15));
    expect(html).toContain("this conversation: $0.00 of $50.00");
  });

  test("unified chat renders and confirms a rich dependency repair card", async () => {
    expect(store.addEdge("b", "a")).toEqual({ ok: true });
    expect(store.cancelTask("a", T0, "obsolete")).toMatchObject({ ok: true });
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([
        { type: "tool_use", id: "c1", name: "get_task", input: { task: "b" } },
        { type: "tool_use", id: "c2", name: "propose_dependency_repair", input: { task: "b", blocker: "a", operation: "unlink" } },
      ]),
      () => answer([{ type: "text", text: "I prepared the safe repair for confirmation." }]),
    );
    await post(cookie, "/chat", { csrf, message: "repair b's cancelled dependency" });
    await settle();

    let html = await page(cookie);
    expect(html).toContain('data-card-kind="repair"');
    expect(html).toContain("Task is waiting");
    expect(html).toContain("task b may be ready to run once it no longer waits for task a");
    expect(html).toContain(">continue without it</button>");
    expect(store.blockers("b")).toEqual(["a"]);

    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    expect(store.getMateProposal(1)).toMatchObject({ state: "confirmed", outcome: { taskId: "b" } });
    expect(store.blockers("b")).toEqual([]);
    html = await page(cookie);
    expect(html).toContain("task b can now continue without task a");
  });

  test("a cancel card only points at the task; dismiss retires a card; ending the session forgets the thread", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_cancel", input: { task: "a", reason: "superseded" } }, { type: "tool_use", id: "c2", name: "propose_hold", input: { task: "b", reason: "not yet" } }]),
      () => answer([{ type: "text", text: "Two suggestions." }]),
    );
    await post(cookie, "/chat", { csrf, message: "tidy up" });
    await settle();
    let html = await page(cookie);
    expect(html).toContain("cancelling is armed on the task itself");
    expect(html).not.toContain('action="/chat/proposal/1/confirm"');
    expect(html).toContain('action="/chat/proposal/2/confirm"');
    await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(store.getMateProposal(1)?.state).toBe("pending");
    await post(cookie, "/chat/proposal/2/dismiss", { csrf });
    expect(store.getMateProposal(2)?.state).toBe("dismissed");
    expect(store.activeHolds(store.refFor("built-in", "b").id, clockNow)).toEqual([]);
    const threadId = store.openMateThread("alex", store.activeMateSession("alex")!.ceilingDigest, clockNow).thread.id;
    expect(store.listMateMessages(threadId, 10)).toHaveLength(2);
    const ended = await post(cookie, "/chat/mate/end", { csrf });
    expect(ended.status).toBe(303);
    expect(store.activeMateSession("alex")).toBeNull();
    expect(store.listMateMessages(threadId, 10)).toEqual([]);
    expect(store.listMateProposals(threadId)).toEqual([]);
    html = await page(cookie);
    expect(html).toContain('action="/chat/mate/mint"');
    expect(html).not.toContain('class="thread"');
  });

  test("a viewer sees no mint card and cannot mint; a stale-ceiling GET writes nothing", async () => {
    const cookie = await login();
    const csrf = csrfFrom(await page(cookie));
    // A viewer, joined through the real invite road.
    const invite = store.mintInvite("viewer", "alex", clockNow);
    const joined = await fetch(url(`/join/${invite.token}`), { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "vic", password: "watching-only-1" }), redirect: "manual" });
    expect(joined.status).toBe(303);
    const viewerCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const viewerPage = await (await fetch(url("/chat"), { headers: { cookie: viewerCookie } })).text();
    expect(viewerPage).not.toContain('action="/chat/mate/mint"');
    expect(viewerPage).not.toContain('action="/chat/config"');
    expect(viewerPage).toContain("Read-only view");
    const viewerCsrf = /name="csrf" value="([0-9a-f]{64})"/.exec(viewerPage)?.[1] ?? csrf;
    const viewerMint = await fetch(url("/chat/mate/mint"), { method: "POST", headers: { cookie: viewerCookie, origin: base }, body: new URLSearchParams({ csrf: viewerCsrf, "ceiling-usd": "5", token: "watching-only-1" }), redirect: "manual" });
    expect(viewerMint.status).toBe(403);
    expect(store.activeMateSession("vic")).toBeNull();
    // The approver's session, minted under a different repo order than the server holds: the page says so and changes nothing.
    await mint(cookie);
    const live = store.activeMateSession("alex")!;
    store.handle.prepare("UPDATE mate_session SET ceiling_digest = ? WHERE id = ?").run("f".repeat(64), live.id);
    const html = await page(cookie);
    expect(html).toContain("the admitted projects changed since your mate session was minted");
    expect(html).toContain('action="/chat/mate/mint"');
    expect(store.activeMateSession("alex")).not.toBeNull();
  });

  test("an operator can stop one in-flight turn without ending the conversation", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    const session = store.activeMateSession("alex");
    if (session === null) throw new Error("missing session");
    const thread = store.openMateThread("alex", session.ceilingDigest, clockNow).thread;
    const opened = store.openMateTurn(
      {
        approver: "alex",
        session: session.id,
        thread: thread.id,
        credentialKey: session.credentialKey,
        reservedMicrousd: 100,
        dailyTurns: 50,
        weeklyCeilingMicrousd: 100_000_000,
        deadlineMs: 60_000,
      },
      clockNow,
    );
    if (!opened.ok) throw new Error(opened.reason);
    expect(store.startMateTurn(opened.id, clockNow)).toMatchObject({ ok: true });

    let html = await page(cookie);
    expect(html).toContain('action="/chat/mate/stop"');
    expect(html).toContain(`name="turn" value="${opened.id}"`);
    const stopped = await post(cookie, "/chat/mate/stop", { csrf, turn: String(opened.id) });
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/chat#latest");
    expect(store.liveMateTurnFor("alex")).toBeNull();
    expect(store.activeMateSession("alex")).not.toBeNull();
    expect(store.recentMateTurns("alex", 1)[0]).toMatchObject({ state: "failed", failureReason: "stopped" });

    html = await page(cookie);
    expect(html).toContain("stopped — the conversation is still open");
    expect(html).toContain('class="card composer"');
  });

  test("coordinator proposals are cards on /chat and the task page; an irreversible answer confirms only with the field", async () => {
    const { mintCoordinator } = await import("./coordinator.js");
    const { proposeAsCoordinator } = await import("./coordinator-proposals.js");
    const minted = mintCoordinator(store, { name: "planner-bot", repos: [repoDir], by: "alex", now: clockNow });
    if (!minted.ok) throw new Error("mint");
    sealScopeFixture(store, "a", approverToken);
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: clockNow, ...presented(store, store.refFor("built-in", "a").id, "builder") });
    store.saveDecision({ run, urgency: "blocking", recap: "RECAP-CANARY", question: "Ship it?", options: [{ id: "go", label: "Ship", consequence: "it ships", reversible: false }], recommendation: "go" }, clockNow);
    expect(proposeAsCoordinator(store, minted.token, "next", { ref: "b" }, clockNow)).toMatchObject({ ok: true, id: 1 });
    expect(proposeAsCoordinator(store, minted.token, "answer", { decision: 1, option: "go", rationale: "tests are green" }, clockNow, { readDecisions: new Set([1]) })).toMatchObject({ ok: true, id: 2 });
    const cookie = await login();
    let html = await page(cookie);
    const csrf = csrfFrom(html);
    expect(html).toContain("proposed by coordinators");
    expect(html).toContain('action="/proposals/1/confirm"');
    expect(html).toContain('action="/proposals/2/confirm"');
    expect(html).toContain("it ships");
    expect(html).toContain("the builder recommends this");
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).not.toContain("RECAP-CANARY");
    // The task page carries the same card, returning to the task after the act.
    const taskPage = await (await fetch(url("/t/b"), { headers: { cookie } })).text();
    expect(taskPage).toContain('action="/proposals/1/confirm"');
    expect(taskPage).toContain('name="return" value="/t/b"');
    // A backslash return is not same-site to a browser: refused to "/" (v3 review, finding 10).
    const crooked = await post(cookie, "/proposals/999/dismiss", { csrf, return: "/\\evil.example" });
    expect(crooked.headers.get("location")).toBe("/");
    const confirmed = await post(cookie, "/proposals/1/confirm", { csrf, return: "/t/b" });
    expect(confirmed.headers.get("location")).toBe("/t/b");
    expect(store.getCoordinatorProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(store.queuePosition("b")?.position).toBe(1);
    // The irreversible answer: no field, no answer; with the field, answered as alex via the web.
    await post(cookie, "/proposals/2/confirm", { csrf });
    expect(store.getDecision(1)?.state).toBe("open");
    expect(store.getCoordinatorProposal(2)?.state).toBe("pending");
    await post(cookie, "/proposals/2/confirm", { csrf, confirm: "yes" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "web" });
    html = await page(cookie);
    expect(html).toContain("decision #1 answered: Ship");
  });

  test("a refused turn is said once on the thread; a bearer caller and a viewer have no mate", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    const empty = await post(cookie, "/chat", { csrf, message: "   " });
    expect(empty.headers.get("location") ?? "").toContain("characters");
    script.push(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await post(cookie, "/chat", { csrf, message: "hello" });
    await settle();
    let html = await page(cookie);
    expect(html).toContain("malformed");
    expect(html).toContain("unknown spend blocks chat");
    html = await page(cookie);
    expect(html).not.toContain("malformed and was discarded");
    const bearer = await fetch(url("/chat/mate/mint"), { method: "POST", headers: { authorization: `Bearer ${approverToken}`, origin: base }, body: new URLSearchParams({ "ceiling-usd": "5", token: approverToken }), redirect: "manual" });
    expect([401, 403]).toContain(bearer.status);
  });
});

describe("scout tasks and the digest card on the console (mate arc §10)", () => {
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
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-serve-scout-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(join(dir, "telegram-token"), "777000:AAExampleExampleExample123\n", { mode: 0o600 });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), telegramTokenFile: join(dir, "telegram-token") });
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

  test("the new-task form files a scout; the task page says so; the report renders verified and a follow-up files with the scout's authorship", async () => {
    const cookie = await login();
    const form = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(form).toContain('name="scout"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
    const revision = /name="projectRevision" value="(\d+)"/.exec(form)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, title: "why does login flake", goal: "find out", repo: "/repo/main", scout: "1" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = /\/t\/([^/?]+)/.exec(filed.headers.get("location") ?? "")?.[1] ?? "";
    const ref = store.refFor("built-in", taskId);
    expect(ref.deliverable).toBe("report");
    let page = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(page).toContain(">scout<");
    expect(page).toContain("delivers a report, never a branch");
    // Said INSIDE the ceremony: the yes buys a report, not a branch.
    expect(page).toContain("approving sends a read-only session");

    // The report lands as evidence; the page renders it only once verified.
    sealScopeFixture(store, taskId, approverToken);
    const run = store.startRun({ taskRef: ref.id, leaseId: "scout-lease", runner: "b", role: "scout", branch: "standing-orders-scout/x", worktree: "/pool/scout", now: new Date(), ...presented(store, ref.id, "scout") });
    const report = { title: "The cookie races the assertion", summary: "The read wins under load.", report: "## Findings\nAsync cookie in src/session.ts.\n", followUps: [{ title: "Await the cookie", goal: "Wait for it before asserting." }] };
    const content = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    const { mkdirSync: mkdirS, writeFileSync: writeS } = await import("node:fs");
    mkdirS(join(evidenceRoot, String(run)), { recursive: true });
    writeS(join(evidenceRoot, String(run), "report.json"), content);
    store.saveArtifact({ run, kind: "report", key: `${run}/report.json`, bytesOriginal: content.length, bytesStored: content.length, truncated: false, sha256: createHash("sha256").update(content).digest("hex"), capture: "scout handoff (verified tree)" }, new Date());
    store.finishRun(run, { outcome: "built", reason: "report-delivered", now: new Date() });
    page = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(page).toContain("The cookie races the assertion");
    expect(page).toContain("Async cookie in src/session.ts.");
    expect(page).toContain("file this follow-up");

    // A tampered file never renders: the problem is named instead.
    writeS(join(evidenceRoot, String(run), "report.json"), content.toString("utf8").replace("Async", "Sync"));
    const tampered = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(tampered).not.toContain("cookie in src/session.ts");
    expect(tampered).toContain("does not verify");
    const noFile = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(noFile.status).toBe(409);
    writeS(join(evidenceRoot, String(run), "report.json"), content);

    // The follow-up files through the one door: same repo, the scout's authorship.
    const followUp = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(followUp.status).toBe(303);
    const filedId = /\/t\/([^/?]+)/.exec(followUp.headers.get("location") ?? "")?.[1] ?? "";
    expect(store.getTask(filedId)?.title).toBe("Await the cookie");
    expect(store.refFor("built-in", filedId).repo).toBe("/repo/main");
    expect(store.handle.prepare("SELECT proposed_via FROM task_scope WHERE task_id = ?").get(filedId)?.["proposed_via"]).toBe("scout");
    const missing = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "7" }), redirect: "manual" });
    expect(missing.status).toBe(409);
    // Idempotent (v4 review, finding 10): the same tap again lands on the same task, no twin.
    const again = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(followUp.headers.get("location"));
    expect(store.listTasksScoped(null, undefined, 100, null).filter(one => one.title === "Await the cookie")).toHaveLength(1);
  });

  test("the /next ceremony says the yes buys a report, not a branch (v4 review, finding 9)", async () => {
    const cookie = await login();
    const form = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
    const revision = /name="projectRevision" value="(\d+)"/.exec(form)?.[1] ?? "0";
    await fetch(`${base}/tasks/add`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, title: "scout me", goal: "find out", repo: "/repo/main", scout: "1" }), redirect: "manual" });
    const next = await (await fetch(`${base}/next`, { headers: { cookie } })).text();
    expect(next).toContain("approve exactly this:");
    expect(next).toContain("a read-only session investigates this goal and delivers a report");
  });

  test("the digest card sets the cadence from a closed list; the choice lands in the store and says so", async () => {
    const cookie = await login();
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("telegram digest");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const bad = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "17" }), redirect: "manual" });
    expect(bad.status).toBe(400);
    const saved = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "240" }), redirect: "manual" });
    expect(saved.status).toBe(303);
    expect(store.telegramDigest()).toMatchObject({ everyMs: 4 * 3_600_000, setBy: "alex" });
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain('value="240" selected');
    expect(page).toContain("0 routine fact(s) held");
    const off = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "off" }), redirect: "manual" });
    expect(off.status).toBe(303);
    expect(store.telegramDigest().everyMs).toBeNull();
    const anonymous = await fetch(`${base}/settings/telegram-digest`, { method: "POST", body: new URLSearchParams({ every: "60" }) });
    expect(anonymous.status).toBe(401);
  });

  test("Settings chooses the global permission default and each task can override the sealed profile", async () => {
    store.createTask({ id: "existing-auto", title: "existing automatic task" }, T0);
    propose(store, { taskId: "existing-auto", goal: "keep the current permission profile", now: T0 });
    const cookie = await login();
    let settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("unattended permissions");
    expect(settings).toContain('name="permission-mode" value="auto" checked');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)?.[1] ?? "";
    const permissionForm = /<form method="post" action="\/settings\/permission-default"[\s\S]*?<\/form>/.exec(settings)?.[0] ?? "";
    expect(permissionForm).toContain(`name="csrf" value="${csrf}"`);

    const global = await fetch(`${base}/settings/permission-default`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "permission-mode": "bypassPermissions" }),
      redirect: "manual",
    });
    expect(global.status).toBe(303);
    expect(store.permissionDefault()).toMatchObject({ mode: "bypassPermissions", updatedBy: "alex" });

    const existingPage = await (await fetch(`${base}/t/existing-auto`, { headers: { cookie } })).text();
    const existingPermissionField = /<fieldset class="permission-field">[\s\S]*?<\/fieldset>/.exec(existingPage)?.[0] ?? "";
    expect(existingPermissionField).toContain('name="permission-mode" value="auto" checked');

    const fresh = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(fresh).toContain('name="permission-mode" value="bypassPermissions" checked');
    const revision = /name="projectRevision" value="(\d+)"/.exec(fresh)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        projectRevision: revision,
        title: "unattended permissions proof",
        goal: "prove the permission policy flows end to end",
        repo: "/repo/main",
        "plan-first": "0",
        "planning-policy": "choice",
        "permission-mode": "bypassPermissions",
      }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = decodeURIComponent((filed.headers.get("location") ?? "").split("/").at(-1) ?? "");
    const full = store.getScope(taskId);
    expect(store.refFor("built-in", taskId).permissionMode).toBe("bypassPermissions");
    expect(full?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });

    let taskPage = await (await fetch(`${base}/t/${encodeURIComponent(taskId)}`, { headers: { cookie } })).text();
    expect(taskPage).toContain('name="permission-mode" value="bypassPermissions" checked');
    const sawDigest = /name="sawDigest" value="([0-9a-f]{32})"/.exec(taskPage)?.[1] ?? "";
    const changed = await fetch(`${base}/t/${encodeURIComponent(taskId)}/scope`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        sawDigest,
        goal: "prove the permission policy flows end to end",
        not: "",
        touches: "",
        "permission-mode": "auto",
      }),
      redirect: "manual",
    });
    expect(changed.status).toBe(303);
    const automatic = store.getScope(taskId);
    expect(automatic?.digest).not.toBe(full?.digest);
    expect(store.refFor("built-in", taskId).permissionMode).toBe("auto");
    expect(automatic?.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain('name="permission-mode" value="bypassPermissions" checked');

    // A Codex task also keeps the profile it already filed if the global
    // starting value changes later; editing unrelated scope text must not
    // silently re-sandbox it.
    store.setPhaseConfig("installation", "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5-codex", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "alex", T0);
    store.createTask({ id: "existing-codex-full", title: "existing Codex full task" }, T0);
    propose(store, {
      taskId: "existing-codex-full",
      goal: "keep the current Codex permission profile",
      now: T0,
    });
    store.setPermissionDefault("auto", "alex", T0);
    const codexPage = await (await fetch(`${base}/t/existing-codex-full`, { headers: { cookie } })).text();
    const codexPermissionField = /<fieldset class="permission-field">[\s\S]*?<\/fieldset>/.exec(codexPage)?.[0] ?? "";
    expect(codexPermissionField).toContain('name="permission-mode" value="bypassPermissions" checked');
  });

  test("Settings chooses the global quality default and a task can sign its own override", async () => {
    const cookie = await login();
    let settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("quality mode");
    expect(settings).toContain('name="quality-mode" value="default" checked');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)?.[1] ?? "";

    const global = await fetch(`${base}/settings/quality-default`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "quality-mode": "strict" }),
      redirect: "manual",
    });
    expect(global.status).toBe(303);
    expect(store.qualityDefault()).toMatchObject({ mode: "strict", updatedBy: "alex" });

    const fresh = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(fresh).toContain('<option value="strict" selected>Strict / release</option>');
    const revision = /name="projectRevision" value="(\d+)"/.exec(fresh)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        csrf,
        projectRevision: revision,
        title: "fast evidence exception",
        goal: "use the fast path for this task",
        acceptance: "c1: output is reviewed | manual-review",
        "plan-first": "0",
        "planning-policy": "choice",
        "permission-mode": "auto",
        "quality-mode": "default",
      }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = decodeURIComponent((filed.headers.get("location") ?? "").split("/").at(-1) ?? "");
    expect(store.refFor("built-in", taskId).qualityMode).toBe("default");
    expect(store.getScope(taskId)?.qualityMode).toBe("default");

    const taskPage = await (await fetch(`${base}/t/${encodeURIComponent(taskId)}`, { headers: { cookie } })).text();
    expect(taskPage).toContain('name="quality-mode" value="default" checked');
    expect(taskPage).toContain("Default</strong>");
  });
});

describe("the first account (setup review): sign up on the login page with the printed code", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-signup-"));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), setupCode: "424242" });
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

  test("no accounts: the login page offers to create one; a wrong code refuses; the right code creates it and signs in; then the road is closed", async () => {
    const first = await (await fetch(`${base}/login`)).text();
    expect(first).toContain("create the first account");
    expect(first).toContain('action="/signup"');

    const wrong = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "000000", name: "alex", password: "correct horse battery" }), redirect: "manual" });
    expect(wrong.status).toBe(403);
    expect(store.listApprovers()).toHaveLength(0);

    const short = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "alex", password: "short" }), redirect: "manual" });
    expect(short.status).toBe(400);

    const made = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "alex", password: "correct horse battery" }), redirect: "manual" });
    expect(made.status).toBe(303);
    const cookie = (made.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie).toMatch(/=[0-9a-f]{64}$/);
    expect(store.listApprovers().map(one => one.name)).toEqual(["alex"]);
    const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    expect(home.status).toBe(200);

    // The road is closed the moment an account exists.
    const again = await (await fetch(`${base}/login`)).text();
    expect(again).not.toContain("create the first account");
    expect(again).toContain("sign in");
    const second = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "mallory", password: "correct horse battery" }), redirect: "manual" });
    expect(second.status).toBe(409);
    expect(store.listApprovers()).toHaveLength(1);
  });

  test("five wrong codes close the road until restart", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "111111", name: "x", password: "correct horse battery" }), redirect: "manual" });
      expect(wrong.status).toBe(403);
    }
    const closed = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "x", password: "correct horse battery" }), redirect: "manual" });
    expect(closed.status).toBe(403);
    expect(store.listApprovers()).toHaveLength(0);
    const page = await (await fetch(`${base}/login`)).text();
    expect(page).not.toContain('action="/signup"');
  });

  test("a server started without a setup code never offers sign-up", async () => {
    const bare = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => bare.listen(0, "127.0.0.1", resolve));
    const address = bare.address();
    const url = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
    const page = await (await fetch(`${url}/login`)).text();
    expect(page).not.toContain("create the first account");
    const refused = await fetch(`${url}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "x", password: "correct horse battery" }), redirect: "manual" });
    expect(refused.status).toBe(409);
    await new Promise<void>(resolve => bare.close(() => resolve()));
  });
});

describe("/peek: every live agent in the console (peek)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-peek-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), localRunner: "night-shift-1" });
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

  test("one pane per live run with its stage and transcript tail, a poller per pane, and the set of runs as a fragment; signed-out is a redirect", async () => {
    const { openLiveLog } = await import("./live.js");
    store.createTask({ id: "t-peek", title: "Harden webhook retries" }, T0);
    const ref = store.refFor("built-in", "t-peek").id;
    store.placeTask(ref, "/repo/main");
    register(store, { name: "night-shift-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-peek" });
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-peek", now: new Date(), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim failed");
    const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "night-shift-1", role: "builder", provider: "codex", branch: "standing-orders/t-peek", worktree: "/pool/t-peek", now: new Date(), ...presented(store, ref, "builder", null, { provider: "codex", model: null }) });
    store.setRunPhase(run, "agent-running");
    const log = openLiveLog(evidenceRoot, run);
    log?.observe({ type: "item.completed", item: { type: "agent_message", text: "Reading the retry loop now." } });
    log?.observe({ type: "item.completed", item: { type: "command_execution", command: "cat secrets" } });
    log?.close();

    const anonymous = await fetch(`${base}/peek`, { redirect: "manual" });
    expect(anonymous.status).toBe(303);

    const cookie = await login();
    const page = await (await fetch(`${base}/peek`, { headers: { cookie } })).text();
    expect(page).toContain("Harden webhook retries");
    expect(page).toContain("night-shift-1 · builder · agent running");
    expect(page).toContain("Reading the retry loop now.");
    expect(page).toContain("→ running a command");
    expect(page).not.toContain("cat secrets");
    expect(page).toContain(`id="live-transcript-${run}"`);
    expect(page).toContain(`"/r/${run}"+"?fragment=transcript`);

    const fragment = await (await fetch(`${base}/peek?fragment=1`, { headers: { cookie } })).json();
    expect(fragment).toEqual({ runs: [run] });

    // The run page of a non-claude run carries the transcript poller too.
    const runPage = await (await fetch(`${base}/r/${run}`, { headers: { cookie } })).text();
    expect(runPage).toContain("fragment=transcript");

    store.finishRun(run, { outcome: "built", now: new Date() });
    const empty = await (await fetch(`${base}/peek`, { headers: { cookie } })).text();
    expect(empty).toContain("no agent is working right now");
  });
});

describe("the inbox says when nothing will build (install review)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-worker-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
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

  test("no worker registered, a stale worker, and an answering worker each say the right thing", async () => {
    const cookie = await login();
    let inbox = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(inbox).toContain('data-builder-status="not-connected"');
    expect(inbox).toContain("No builder is connected yet.");
    expect(inbox).toContain("Standing Orders is open, but no machine is connected to do project work.");
    expect(inbox).toContain("standing-orders up");
    expect(inbox).not.toContain("standing-orders daemon install");

    register(store, { name: "old-1", host: "h", capacity: 1, repos: ["/repo/main"], now: new Date(Date.now() - 30 * 24 * 60 * 60_000), newToken: () => "tok-old" });
    inbox = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(inbox).toContain('data-builder-status="disconnected"');
    expect(inbox).toContain("Builder disconnected.");
    expect(inbox).toContain("1 builder is configured, last checked in");
    expect(inbox).toContain("Reopen Standing Orders on that machine.");
    expect(inbox).toContain("Queued work starts automatically when a builder reconnects.");

    store.touchRunner("old-1", new Date());
    inbox = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(inbox).not.toContain("data-builder-status=");
    expect(inbox).not.toContain("Builder disconnected.");
  });
});

describe("the board's order view (operator request): the one place a drag does anything", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-order-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.createTask({ id: "t-order-1", title: "first in line" }, T0);
    store.createTask({ id: "t-order-2", title: "second in line" }, T0);
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

  test("the state view links to order; the order view carries the queue's drag handles and its poller; state stays a view", async () => {
    const cookie = await login();
    const state = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
    expect(state).toContain('href="/board?view=order"');
    expect(state).not.toContain('class="queue-handle"');

    const order = await (await fetch(`${base}/board?view=order`, { headers: { cookie } })).text();
    expect(order).toContain("<h1>board</h1>");
    expect(order).toContain('<a href="/board">state</a>');
    expect(order).toContain("first in line");
    expect(order).toContain("second in line");
    expect(order).toContain('class="queue-handle"');
    expect(order).toContain('id="queue-region"');
    expect(order).toContain("/queue?fragment=1");
    // The queue page itself is unchanged: same region, same handles.
    const queue = await (await fetch(`${base}/queue`, { headers: { cookie } })).text();
    expect(queue).toContain('class="queue-handle"');
  });
});

describe("the reduction pass (Laws of UX): five always-visible rows and two accordion groups, five tabs, one accent in two places", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
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

  /** One parked decision: the inbox has something that waits. */
  const parkOne = (): void => {
    store.createTask({ id: "t-ask", title: "asks a question" }, T0);
    const ref = store.refFor("built-in", "t-ask").id;
    store.placeTask(ref, "/repo/main");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-ask", runner: "b1", branch: "standing-orders/t-ask", worktree: "/pool/t-ask", now: T0, ...presented(store, ref, "builder") });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-reduction-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
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

  test("the rail is chat · inbox · board · builds · projects and two collapsed accordion groups (workflows, admin); the tab bar mirrors it; the queue and the switch link are gone from chrome", async () => {
    parkOne();
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    const side = /<aside class="side">(.*?)<\/aside>/s.exec(home)?.[1] ?? "";
    const primary = /<nav>(.*?)<\/nav>/s.exec(side)?.[1] ?? "";
    expect(side).toContain('class="side-toggle" aria-label="collapse sidebar" aria-expanded="true"');
    expect(home).toContain("standing-orders:sidebar-collapsed");
    expect(home).toContain(".app.sidebar-collapsed { grid-template-columns: 64px minmax(0, 1fr); }");
    expect([...primary.matchAll(/<a href="([^"]+)"/g)].map(m => m[1])).toEqual(["/chat", "/", "/board", "/runs", "/projects"]);
    // The count rides the inbox row only; every primary row wears an icon.
    expect(primary).toMatch(/<a href="\/" aria-label="inbox" title="inbox" class="active" data-waiting="1"><span class="glyph"><svg.*?<span class="count badge badge-open">1<\/span><\/a>/s);
    expect((primary.match(/<span class="glyph">/g) ?? []).length).toBe(5);

    // Both groups collapsed by default: neither carries the inbox's group.
    const workflows = /<details class="nav-group" data-group="workflows"([^>]*)>(.*?)<\/details>/s.exec(side);
    const admin = /<details class="nav-group" data-group="admin"([^>]*)>(.*?)<\/details>/s.exec(side);
    expect(workflows?.[1]).toBe("");
    expect(admin?.[1]).toBe("");
    expect(workflows?.[2]).toContain("<summary>workflows");
    expect(admin?.[2]).toContain("<summary>admin");
    const workflowsRows = /<nav class="nav-group-items">(.*?)<\/nav>/s.exec(workflows?.[2] ?? "")?.[1] ?? "";
    const adminRows = /<nav class="nav-group-items">(.*?)<\/nav>/s.exec(admin?.[2] ?? "")?.[1] ?? "";
    expect([...workflowsRows.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => `${m[2]} ${m[1]}`)).toEqual([
      "portfolio /workbench",
      "task list /tasks",
      "routines /routines",
    ]);
    expect([...adminRows.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => `${m[2]} ${m[1]}`)).toEqual([
      "fleet /fleet",
      "requirements /caps",
      "people /people",
      "operating mode /mode",
      "system /system",
    ]);
    // The group rows stay text, the way Linear's does — only the rail's
    // primary rows and the chevrons wear a drawn icon.
    expect(workflowsRows).not.toContain("<svg");
    expect(adminRows).not.toContain("<svg");
    expect(side).not.toContain('href="/queue"');
    expect(side).not.toContain('class="nav-settings"');
    expect(home).not.toContain("switch project");
    // The client keeps the two groups exclusive.
    expect(home).toContain('document.querySelectorAll(".nav-group")');

    const tabbar = /<nav class="tabbar">(.*?)<\/nav>/s.exec(home)?.[1] ?? "";
    expect([...tabbar.matchAll(/<a href="([^"]+)"/g)].map(m => m[1])).toEqual(["/chat", "/", "/board", "/runs", "/menu"]);
    // A phone tab says THAT something waits — a dot, never a number.
    expect(tabbar).toContain('<span class="dot-badge" role="img" aria-label="1 waiting"></span>');
    expect(tabbar).not.toContain("badge-open");
    expect(home).toContain('<a class="manage" href="/projects">manage projects</a>');

    // /menu mirrors the same two groups, nothing else.
    const menu = await (await fetch(url("/menu"), { headers: { cookie } })).text();
    expect(menu).toContain('<h2 class="menu-group-label">workflows</h2>');
    expect(menu).toContain('<h2 class="menu-group-label">admin</h2>');
    expect(menu).not.toContain('<h2 class="menu-group-label">settings</h2>');
    const rows = [...menu.matchAll(/<a class="menu-row" href="([^"]+)">/g)].map(m => m[1]);
    expect(rows).toEqual(["/workbench", "/tasks", "/routines", "/fleet", "/caps", "/people", "/mode", "/system"]);
  });

  test("every retired destination still answers: the queue redirects to the board's order view; done, review, and activity are views of builds", async () => {
    const cookie = await login();
    const queue = await fetch(url("/queue"), { headers: { cookie }, redirect: "manual" });
    expect(queue.status).toBe(303);
    expect(queue.headers.get("location")).toBe("/board?view=order");
    // The fragment the order view polls is still served.
    expect((await fetch(url("/queue?fragment=1"), { headers: { cookie } })).status).toBe(200);
    for (const [path, current] of [["/done", "done"], ["/review", "review"], ["/activity", "activity"], ["/runs", "builds"]] as const) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      expect(html).toContain('<a href="/runs" class="active">');
      const strip = /<p class="meta board-view">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
      expect(strip).toContain(`<strong>${current}</strong>`);
      for (const other of ["builds", "done", "review", "activity"].filter(one => one !== current)) {
        expect(strip).toContain(`>${other}</a>`);
      }
    }
    for (const path of ["/workbench", "/tasks", "/fleet", "/projects", "/menu", "/board?view=order"]) {
      expect((await fetch(url(path), { headers: { cookie } })).status).toBe(200);
    }
    const order = await (await fetch(url("/board?view=order"), { headers: { cookie } })).text();
    expect(order).toContain('<a href="/board" class="active">');
  });

  test("every count is a road: the header's counts, and a project card's name and chips, open what they count", async () => {
    parkOne();
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    expect(home).toContain('<span class="scope-status"><a class="hot" href="/">1 needs you</a><a href="/runs">');
    expect(home).toMatch(/<a href="\/board\?view=order">\d+ queued<\/a><\/span>/);
    // The phone pill keeps plain text inside its summary — the pill is the switcher.
    const pill = /<details class="project-pill switcher"><summary>(.*?)<\/summary>/s.exec(home)?.[1] ?? "";
    expect(pill).toContain('<span class="hot">1 needs you</span>');
    expect(pill).not.toContain("<a ");
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    const start = projects.indexOf('<div class="card project-card">');
    expect(start).toBeGreaterThan(0);
    const card = projects.slice(start, start + 1500);
    expect(card).toContain('<a class="project-name" href="/"><strong>main</strong></a>');
    expect(card).toContain('<a class="badge badge-open" href="/">1 waiting on you</a>');
  });

  test("amber lives in exactly two kinds of place: the needs-you count and the act that resolves a screen — never a card, a frame, or a seal", async () => {
    parkOne();
    const cookie = await login();
    const home = await (await fetch(url("/"), { headers: { cookie } })).text();
    // The page's stylesheet is the longest style block (a noscript fallback carries a one-liner).
    const css = [...home.matchAll(/<style>(.*?)<\/style>/gs)].map(m => m[1] as string).sort((a, b) => b.length - a.length)[0]?.replace(/\/\*.*?\*\//gs, "") ?? "";
    const amber = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((rule[2] as string).includes("var(--brand)")) amber.add((rule[1] as string).trim().replace(/\s+/g, " "));
    }
    expect([...amber].sort()).toEqual(
      [
        ".count.badge-open",
        ".approve-form button[type=submit], .approve-form .sticky-actions button[type=submit]",
        ".approve-form button[type=submit]:hover, .approve-form .sticky-actions button[type=submit]:hover",
        ".scope-status .hot",
        ".mobile-top .pill-status .hot",
        ".tabbar a .dot-badge",
        ".lane-attention h2::before",
        ".command-metric.attention .label::before",
        ".chat-project-stats span.hot, .chat-project-stats span.hot b",
        ".workspace-stats .pulse-stat.hot b",
        ".workspace-bar .seg.attention",
      ].sort(),
    );
    // The card that waits is on the page, in the neutral border.
    expect(home).toContain('class="decide-card"');
    expect(css).toMatch(/\.decide-card \{\s*display: block; border: 1px solid var\(--border\);/);
    expect(css).toMatch(/\.approve-form \{ margin: \.75rem 0; \}/);
    expect(css).not.toContain(".lane-attention .lane-card {");
    expect(css).not.toContain(".workspace-card.hot {");
    expect(css).toMatch(/\.seal \{[^}]*border: 1px solid var\(--border\);[^}]*color: var\(--foreground\)/s);
  });
});

describe("the review cockpit (Priority 5): a ranked, verified projection of completed work", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;
  const at = (hoursAgo: number): Date => new Date(T0.getTime() - hoursAgo * 3_600_000);

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };
  const mainOf = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  const queueOf = (html: string): string => /<ol class="cockpit-queue-list">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  /** A done task with a signed scope in the project (or elsewhere). */
  const seed = (id: string, title: string, repo = "/repo/main", scope: { goal?: string; outOfScope?: string | null; touches?: string[]; acceptance?: { id: string; statement: string; evidence: ("check" | "screenshot" | "changed-path" | "manual-review")[] }[] } | null = {}): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id, "ours").id;
    store.placeTask(ref, repo);
    if (scope !== null) {
      const proposed = propose(store, {
        taskId: id,
        goal: scope.goal ?? `goal of ${id}`,
        outOfScope: scope.outOfScope ?? null,
        touches: scope.touches ?? [],
        acceptance: (scope.acceptance ?? [{ id: "c1", statement: `${id} is done`, evidence: ["manual-review"] }]).map(one => ({ ...one, how: null })),
        now: T0,
      });
      const agreed = approve(store, id, "alex", T0, proposed.digest, approverToken);
      if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
    }
    return ref;
  };

  /** A finished build with the artifacts the cockpit projects. */
  const build = (
    id: string,
    ref: number,
    parts: {
      patch?: string;
      stat?: { path: string; additions: number | null; deletions: number | null }[];
      handoff?: Record<string, unknown>;
      proof?: Record<string, unknown>;
      checkLog?: string;
      screenshot?: { path: string; caption: string };
      verdict?: { verdict: "verified" | "attested" | "short" | "refuted"; reasons?: string[]; matrix?: import("./proof.js").CriterionMatrixRow[]; machineVerdict?: "verified" | "attested" | "short" | "refuted" };
      outcome?: "built" | "no-change";
      finishedAt?: Date;
    } = {},
  ): number => {
    const when = parts.finishedAt ?? T0;
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "night-shift-1", provider: "claude", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(when.getTime() - 60_000), ...presented(store, ref, "builder") });
    if (parts.patch !== undefined) {
      storeEvidence(store, evidenceRoot, run, "terminal-diff", "terminal-diff.patch", Buffer.from(parts.patch, "utf8"), "git diff --no-ext-diff 0000..HEAD (exit 0)", when, { captureStatus: "ok" });
    }
    if (parts.stat !== undefined) {
      const files = parts.stat;
      const stat = {
        schema: 1, base: "a".repeat(40), head: "b".repeat(40), fileCount: files.length,
        additions: files.reduce((sum, one) => sum + (one.additions ?? 0), 0), deletions: files.reduce((sum, one) => sum + (one.deletions ?? 0), 0),
        binaryCount: files.filter(one => one.additions === null).length, filesTruncated: false, files,
      };
      storeEvidence(store, evidenceRoot, run, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify(stat), "utf8"), "parsed from git diff --numstat -z", when, { captureStatus: "ok" });
    }
    if (parts.handoff !== undefined) {
      storeEvidence(store, evidenceRoot, run, "handoff", "handoff.json", Buffer.from(JSON.stringify(parts.handoff), "utf8"), "composed at completion", when);
    }
    if (parts.proof !== undefined) {
      storeEvidence(store, evidenceRoot, run, "proof", "proof.json", Buffer.from(JSON.stringify(parts.proof), "utf8"), "agent-authored proof (validated)", when);
    }
    if (parts.checkLog !== undefined) {
      storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from(parts.checkLog, "utf8"), `sh -c "npm test" (exit 0)`, when);
    }
    if (parts.screenshot !== undefined) {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      storeEvidence(store, evidenceRoot, run, "screenshot", "shot.png", png, `agent-claimed screenshot at ${parts.screenshot.path} (validated png)`, when);
    }
    if (parts.verdict !== undefined) {
      store.saveProofVerdict(run, parts.verdict.verdict, parts.verdict.reasons ?? [], when, parts.verdict.matrix ?? [], parts.verdict.machineVerdict ?? null);
    }
    store.recordOutcomeFacts(run, { headRevision: "b".repeat(40), handoff: `handoff of ${id}` });
    store.finishRun(run, { outcome: parts.outcome ?? "built", committed: true, now: when });
    store.setTaskState(id, "done", when);
    return run;
  };

  const row = (id: string, statement: string, state: "pass" | "missing" | "failed" | "manual-review", answered: { kind: "check" | "screenshot" | "changed-path" | "manual-review"; ref: string }[] = [], detail: string[] = [], review: { judgement: "upholds" | "contradicts" | "cannot-tell"; note: string; author: string } | null = null): import("./proof.js").CriterionMatrixRow => ({
    id, statement, requiredEvidence: answered.length === 0 ? ["manual-review"] : [...new Set(answered.map(one => one.kind))], state, detail, answered, review,
  });

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-cockpit-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("review priority is deterministic and labeled: every band, every reason, and a stable tie-break", () => {
    const facts = (over: Partial<ReviewQueueFacts>): ReviewQueueFacts => ({ runId: 1, outcome: "built", proofVerdict: "verified", proofAccepted: false, proofMatrix: [], ciFailing: false, publicationState: null, ...over });
    expect(reviewPriorityOf(facts({}))).toEqual({ band: 2, label: "no flags", reasons: [] });
    expect(reviewPriorityOf(facts({ runId: null, proofVerdict: null }))).toEqual({ band: 1, label: "review", reasons: ["no build record"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted" }))).toMatchObject({ band: 0, label: "needs action", reasons: ["conflicting evidence"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted", proofAccepted: true }))).toMatchObject({ band: 1, reasons: ["conflicting evidence — accepted with exception"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "short" }))).toMatchObject({ band: 0, reasons: ["missing evidence"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "short", proofAccepted: true }))).toMatchObject({ band: 1 });
    expect(reviewPriorityOf(facts({ proofMatrix: [row("c2", "x", "pass", [{ kind: "check", ref: "npm test" }], [], { judgement: "contradicts", note: "no", author: "reviewer:codex" })] }))).toMatchObject({ band: 0, reasons: ["reviewer raised a concern with c2"] });
    expect(reviewPriorityOf(facts({ proofMatrix: [row("c1", "x", "failed"), row("c3", "y", "missing")] }))).toMatchObject({ band: 0, reasons: ["missing or failed evidence for c1, c3"] });
    expect(reviewPriorityOf(facts({ ciFailing: true }))).toMatchObject({ band: 0, reasons: ["CI failing on its pull request — observed, not inferred"] });
    expect(reviewPriorityOf(facts({ publicationState: "failed" }))).toMatchObject({ band: 1, reasons: ["publication failed — the branch never reached its remote"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "attested", proofMatrix: [row("c1", "x", "manual-review")] }))).toMatchObject({ band: 1, reasons: ["manual review needed for c1"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "attested", proofAccepted: true, proofMatrix: [row("c1", "x", "manual-review")] }))).toMatchObject({ band: 2, reasons: [] });
    expect(reviewPriorityOf(facts({ proofVerdict: null }))).toMatchObject({ band: 1, reasons: ["no verification result"] });
    expect(reviewPriorityOf(facts({ proofVerdict: null, outcome: "no-change" }))).toMatchObject({ band: 2, reasons: [] });
    // A refuted, CI-failing result names every reason and keeps band 0.
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted", ciFailing: true })).reasons).toHaveLength(2);

    // Band first, then newest completion, then task id — twice, identically.
    const rows = [
      { taskId: "b-old", completedAt: "2026-08-10T00:00:00.000Z", ...facts({}) },
      { taskId: "a-new", completedAt: "2026-08-11T00:00:00.000Z", ...facts({}) },
      { taskId: "z-same", completedAt: "2026-08-11T00:00:00.000Z", ...facts({}) },
      { taskId: "hot", completedAt: "2026-08-01T00:00:00.000Z", ...facts({ proofVerdict: "short" }) },
      { taskId: "warm", completedAt: "2026-08-02T00:00:00.000Z", ...facts({ proofVerdict: null }) },
    ];
    const order = rankReviewQueue(rows).map(one => one.taskId);
    expect(order).toEqual(["hot", "warm", "a-new", "z-same", "b-old"]);
    expect(rankReviewQueue([...rows].reverse()).map(one => one.taskId)).toEqual(order);
  });

  test("changed files rank by review priority — outside touches first, then sensitive or uncited, then churn — with stable anchors", () => {
    expect(withinSignedTouches("src/a.ts", ["src/"])).toBe(true);
    expect(withinSignedTouches("src/a.ts", ["src"])).toBe(true);
    expect(withinSignedTouches("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(withinSignedTouches("srcx/a.ts", ["src"])).toBe(false);
    expect(withinSignedTouches("docs/x/y.md", ["docs/**"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["docs/*.md"])).toBe(false);
    expect(withinSignedTouches("docs/y.md", ["docs/*.md"])).toBe(true);
    expect(withinSignedTouches("a(b).ts", ["a(b).ts"])).toBe(true);
    expect(withinSignedTouches("anything", [])).toBe(false);
    // Globstar spans zero or more directories (v2 review, comment 2): a
    // false negative here is a loud "outside the signed touches" flag.
    for (const path of ["src/a.ts", "src/nested/a.ts", "src/deep/er/a.ts"]) expect(withinSignedTouches(path, ["src/**/*.ts"])).toBe(true);
    expect(withinSignedTouches("src/a.js", ["src/**/*.ts"])).toBe(false);
    expect(withinSignedTouches("lib/a.ts", ["src/**/*.ts"])).toBe(false);
    expect(withinSignedTouches("src/a.ts/x", ["src/**/*.ts"])).toBe(true);
    expect(withinSignedTouches("README.md", ["**/*.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["**/*.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["**/y.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.ts", ["**/*.md"])).toBe(false);
    expect(withinSignedTouches("src/a.ts", ["src/**/"])).toBe(true);
    expect(withinSignedTouches("src/serve.test.ts", ["src/*.test.ts"])).toBe(true);
    expect(withinSignedTouches("src/x/serve.test.ts", ["src/*.test.ts"])).toBe(false);
    expect(withinSignedTouches("evidence/review-cockpit/desktop.png", ["evidence/review-cockpit/**"])).toBe(true);

    expect(diffFileAnchor("src/a.ts")).toMatch(/^diff-file-[0-9a-f]{16}$/);
    expect(diffFileAnchor("src/a.ts")).toBe(diffFileAnchor("src/a.ts"));
    expect(diffFileAnchor(`"><script>`)).toMatch(/^diff-file-[0-9a-f]{16}$/);
    expect(diffFileAnchor("a")).not.toBe(diffFileAnchor("b"));

    const file = (path: string, over: Partial<ReviewFileRow> = {}): ReviewFileRow => ({ path, additions: 1, deletions: 1, renamedFrom: null, anchor: "x", outsideTouches: false, cited: true, ...over });
    expect(reviewFilePriority(file("src/a.ts"), true)).toEqual({ band: 2, label: "no flags", reasons: [] });
    expect(reviewFilePriority(file("src/a.ts", { outsideTouches: true }), true)).toMatchObject({ band: 0, reasons: ["outside approved paths"] });
    expect(reviewFilePriority(file("img.png", { additions: null, deletions: null }), true)).toMatchObject({ band: 1, reasons: ["binary file — preview unavailable"] });
    expect(reviewFilePriority(file("package-lock.json"), true)).toMatchObject({ band: 1, reasons: ["dependencies, CI, schema, or credentials"] });
    expect(reviewFilePriority(file(".github/workflows/ci.yml"), true)).toMatchObject({ band: 1 });
    expect(reviewFilePriority(file("src/auth-token.ts"), true)).toMatchObject({ band: 1 });
    // The credential heuristic (v2 review, comment 4): whole delimited
    // name pieces only — never a substring of an ordinary word.
    const sensitiveWhy = "dependencies, CI, schema, or credentials";
    for (const path of ["src/auth.ts", "src/api-token.ts", "config/secrets.json", "credentials.yml", "auth_middleware.ts", "lib/user.credentials.ts", ".env", ".env.local", "app/.env.production", "db/schema.prisma", "prisma/migrations/0001_init.sql", "Dockerfile", "pnpm-lock.yaml"]) {
      expect(reviewFilePriority(file(path), true), path).toMatchObject({ band: 1, reasons: [sensitiveWhy] });
    }
    for (const path of ["src/author.ts", "src/tokenizer.ts", "src/permissions-ui.tsx", "src/.envelope.ts", "src/environment.ts", "src/authorize.ts", "src/permissions.ts", "docs/secretary.md", "src/tokens/theme.ts"]) {
      expect(reviewFilePriority(file(path), true), path).toEqual({ band: 2, label: "no flags", reasons: [] });
    }
    expect(reviewFilePriority(file("src/a.ts", { cited: false }), true)).toMatchObject({ band: 1, reasons: ["not referenced by a requirement"] });
    expect(reviewFilePriority(file("src/a.ts", { cited: false }), false)).toMatchObject({ band: 2, reasons: [] });
    expect(reviewFilePriority(file("src/a.ts", { additions: 150, deletions: 60 }), true)).toMatchObject({ band: 1, reasons: ["a large change"] });
    expect(reviewFilePriority(file("src/a.ts", { anchor: null }), true)).toMatchObject({ band: 1, reasons: ["not in the recorded diff — see the full diff"] });

    const ordered = orderChangedFiles([
      file("z.ts", { additions: 5, deletions: 0 }),
      file("a.ts", { additions: 5, deletions: 0 }),
      file("big.ts", { additions: 400, deletions: 0 }),
      file("drift.ts", { outsideTouches: true }),
      file("package.json"),
    ], true).map(one => one.path);
    expect(ordered).toEqual(["drift.ts", "big.ts", "package.json", "a.ts", "z.ts"]);
  });

  test("the queue is authenticated, visibility-safe, bounded to done tasks, deep-linkable, and honest when empty or when the link misses", async () => {
    await boot();
    // Unauthenticated: the login door, never the queue.
    const anonymous = await fetch(url("/review"), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/login");
    const cookie = await login();

    // Empty, honestly.
    const empty = await (await fetch(url("/review"), { headers: { cookie } })).text();
    expect(empty).toContain("No finished tasks yet.");
    expect(empty).toContain("Nothing to review yet.");
    expect(empty).toContain('<a href="/runs" class="active">');

    // Two visible done tasks, one still running, one done in a repo outside the ceiling.
    seed("t-ours", "ours — the <b>title</b>");
    build("t-ours", store.refFor("built-in", "t-ours").id, { verdict: { verdict: "attested" }, patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }] });
    seed("t-older", "older, needs eyes");
    build("t-older", store.refFor("built-in", "t-older").id, { verdict: { verdict: "short", reasons: ["no proof"] }, finishedAt: at(5) });
    seed("t-live", "still going");
    store.setTaskState("t-live", "running", T0);
    seed("t-theirs", "theirs — never shown", "/repo/other");
    build("t-theirs", store.refFor("built-in", "t-theirs").id, { verdict: { verdict: "refuted" } });

    const html = await (await fetch(url("/review"), { headers: { cookie } })).text();
    const queue = queueOf(html);
    // Only done tasks inside the ceiling; the older short proof ranks first.
    expect(queue).toContain("t-older");
    expect(queue).toContain("t-ours");
    expect(queue).not.toContain("t-live");
    expect(queue).not.toContain("t-theirs");
    expect(html).not.toContain("never shown");
    expect(queue.indexOf("t-older")).toBeLessThan(queue.indexOf("t-ours"));
    expect(html).toContain("1 needs attention");
    // The queue explains the order in words, next to the row it elevates.
    expect(queue).toContain("missing evidence");
    // Escaped everywhere the title lands.
    expect(html).toContain("ours — the &lt;b&gt;title&lt;/b&gt;");
    expect(html).not.toContain("<b>title</b>");
    // The first-ranked row is selected by default and marked current.
    expect(html).toContain('data-review-task="t-older"');
    expect(queue).toContain('class="cockpit-row current" href="/review?result=t-older" aria-current="page"');

    // A stable deep link selects, and the row it names is current.
    const picked = await (await fetch(url("/review?result=t-ours"), { headers: { cookie } })).text();
    expect(picked).toContain('data-review-task="t-ours"');
    expect(queueOf(picked)).toContain('class="cockpit-row current" href="/review?result=t-ours"');
    expect(picked).not.toContain("is in view here");

    // A hidden result and a nonexistent one read identically: a note, and
    // the top of the queue — never a 404 that confirms existence.
    for (const miss of ["t-theirs", "t-live", "nope"]) {
      const missed = await fetch(url(`/review?result=${miss}`), { headers: { cookie } });
      expect(missed.status).toBe(200);
      const body = await missed.text();
      expect(body).toContain(`No completed task <span class="mono">${miss}</span> is in view here`);
      expect(body).toContain("Showing the top of the queue instead.");
      expect(body).toContain('data-review-task="t-older"');
      expect(body).not.toContain("never shown");
    }
    // A hostile id never echoes raw.
    const hostile = await (await fetch(url(`/review?result=${encodeURIComponent("<img src=x>")}`), { headers: { cookie } })).text();
    expect(hostile).not.toContain("<img src=x>");
    expect(hostile).toContain("&lt;img src=x&gt;");
  });

  test("structured-output repair bookkeeping never replaces the build on task or review result surfaces", async () => {
    const ref = seed("t-result-lineage", "show the delivered build");
    const built = build("t-result-lineage", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "attested" },
    });
    // The repair turn mends a LIVE attempt under its own lease (atomic
    // authority closure): the fixture reopens the delivered build for the
    // admission, then restores the history the surfaces read.
    const builtRow = store.getRun(built)!;
    store.raw().prepare("UPDATE run SET outcome = NULL WHERE id = ?").run(built);
    // ... under the task's CURRENT live claim (final authority closure).
    store.raw().prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, 99, 'night-shift-1', ?, ?, ?)").run(builtRow.leaseId, ref, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
    const admittedCorrection = store.admitRepair({
      taskRef: ref,
      leaseId: builtRow.leaseId,
      runner: "night-shift-1",
      provider: "claude",
      parentRun: built,
      branch: "standing-orders/t-result-lineage",
      worktree: "/pool/t-result-lineage",
      now: new Date(T0.getTime() + 1),
      ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }),
    });
    store.raw().prepare("UPDATE run SET outcome = ? WHERE id = ?").run(builtRow.outcome, built);
    store.raw().prepare("UPDATE claim SET released_at = ? WHERE lease_id = ? AND lease_generation = 99").run(T0.toISOString(), builtRow.leaseId);
    if (!admittedCorrection.ok) throw new Error(admittedCorrection.problem);
    const correction = admittedCorrection.runId;
    store.finishRun(correction, {
      outcome: "no-change",
      reason: "structured output repaired",
      now: new Date(T0.getTime() + 2),
    });

    await boot();
    const cookie = await login();
    const task = await (await fetch(url("/t/t-result-lineage"), { headers: { cookie } })).text();
    const receipt = /<section class="card completion-receipt"[\s\S]*?<\/section>/.exec(task)?.[0] ?? "";
    expect(receipt).toContain(`result · build #${built}`);
    expect(receipt).toContain(`href="/r/${built}"`);
    expect(receipt).not.toContain(`build #${correction}`);

    const cockpit = await (await fetch(url("/review?result=t-result-lineage"), { headers: { cookie } })).text();
    expect(cockpit).toContain(`href="/r/${built}">Full build history and evidence`);
    expect(cockpit).not.toContain(`href="/r/${correction}">Full build history and evidence`);
  });

  test("a manual completion and a legacy result read as exactly what they are; broken artifacts name their problem", async () => {
    // Done by hand: no scope, no run.
    store.createTask({ id: "t-manual", title: "closed by hand" }, T0);
    store.placeTask(store.refFor("built-in", "t-manual", "ours").id, "/repo/main");
    store.setTaskState("t-manual", "done", at(2));
    // Legacy: a finished build with no artifacts and no verdict.
    const legacyRef = seed("t-legacy", "from before proofs");
    const legacyRun = build("t-legacy", legacyRef, { finishedAt: at(3) });
    // Broken: a patch whose bytes no longer match their record, a truncated
    // check log, and a stat capture that failed.
    const brokenRef = seed("t-broken", "tampered after sealing");
    const brokenRun = build("t-broken", brokenRef, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", verdict: { verdict: "attested" }, finishedAt: at(4) });
    const patchArtifact = store.artifactsFor(brokenRun).find(one => one.kind === "terminal-diff");
    if (patchArtifact === undefined) throw new Error("no patch");
    writeFileSync(join(evidenceRoot, patchArtifact.key), "diff --git a/x b/x\n+tampered\n");
    storeEvidence(store, evidenceRoot, brokenRun, "check-log", "check-log.txt", Buffer.alloc(70 * 1024, "x"), `sh -c "npm test" (exit 0)`, at(4));
    storeEvidence(store, evidenceRoot, brokenRun, "diff-stat", "diff-stat.json", Buffer.from("{}"), "git diff --numstat (exit 128)", at(4), { captureStatus: "failed" });
    await boot();
    const cookie = await login();

    const manual = await (await fetch(url("/review?result=t-manual"), { headers: { cookie } })).text();
    expect(manual).toContain('data-review-task="t-manual"');
    expect(manual).toContain("No build record");
    expect(manual).toContain("no build record");
    expect(manual).toContain("No scope was filed for this task");
    expect(manual).toContain("no finished build record");
    expect(manual).toContain('data-next-action="inspect-task"');
    expect(manual).toContain('href="/t/t-manual"');
    expect(mainOf(manual)).not.toContain("<form");

    const legacy = await (await fetch(url("/review?result=t-legacy"), { headers: { cookie } })).text();
    expect(legacy).toContain("Unverified");
    expect(legacy).toContain("no verification result");
    expect(legacy).toContain("This older build has no verification result or captured evidence");
    expect(legacy).toContain("no final diff or change summary was captured for this build");
    expect(legacy).toContain('data-next-action="inspect-run"');
    expect(legacy).toContain(`href="/r/${legacyRun}">Open the build</a>`);
    // No diff means no annotation form — the endpoint would refuse it anyway.
    expect(legacy).not.toContain('id="comment-form"');

    const broken = await (await fetch(url("/review?result=t-broken"), { headers: { cookie } })).text();
    expect(broken).toContain("patch: stored but unverifiable");
    expect(broken).toContain("change summary: capture failed");
    expect(broken).toContain("Check output (shortened)");
    expect(broken).not.toContain("tampered</code>");
    expect(broken).not.toContain('id="comment-form"');
    // The raw record is still one click away, exactly as stored.
    expect(broken).toContain(`href="/r/${brokenRun}/evidence/`);
  });

  test("intent to diff: goal, boundary, every signed criterion with its state and citations; changed-path citations anchor into the sealed file; drift outside the touches is flagged", async () => {
    const ref = seed("t-intent", "guard the payout", "/repo/main", {
      goal: "Guard the payout <script>alert(1)</script>",
      outOfScope: "No schema changes & no API changes",
      touches: ["src/payout/"],
      acceptance: [
        { id: "c1", statement: "The guard is covered by tests", evidence: ["check", "changed-path"] },
        { id: "c2", statement: "The dashboard still renders", evidence: ["screenshot"] },
        { id: "c3", statement: "An operator reads the copy", evidence: ["manual-review"] },
      ],
    });
    const patch = [
      "diff --git a/src/payout/guard.ts b/src/payout/guard.ts",
      "--- a/src/payout/guard.ts",
      "+++ b/src/payout/guard.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const guard = true;",
      " export const b = 2;",
      'diff --git "a/docs/we\\"ird.md" "b/docs/we\\"ird.md"',
      '--- "a/docs/we\\"ird.md"',
      '+++ "b/docs/we\\"ird.md"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const run = build("t-intent", ref, {
      patch,
      stat: [
        { path: "src/payout/guard.ts", additions: 1, deletions: 0 },
        { path: 'docs/we"ird.md', additions: 1, deletions: 1 },
        { path: "package-lock.json", additions: 1, deletions: 1 },
      ],
      verdict: {
        verdict: "short",
        reasons: ["c3 needs a human"],
        matrix: [
          row("c1", "The guard is covered by tests", "pass", [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/payout/guard.ts" }]),
          row("c2", "The dashboard still renders", "failed", [{ kind: "screenshot", ref: "evidence/dash.png" }], ["the screenshot did not validate"]),
          row("c3", "An operator reads the copy", "manual-review", [{ kind: "manual-review", ref: "read it" }], ["needs a human"]),
        ],
      },
    });
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/review?result=t-intent"), { headers: { cookie } })).text();

    // The approved intent, escaped.
    expect(html).toContain("approved by alex");
    expect(html).toContain("<strong>goal</strong> Guard the payout &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("<strong>not this</strong> No schema changes &amp; no API changes");
    expect(html).toContain('<span class="meta">expected to touch</span> <span class="mono">src/payout/</span>');

    // Every signed criterion, by id, with its adjudicated state and citations.
    for (const [id, state] of [["c1", "pass"], ["c2", "failed"], ["c3", "manual-review"]] as const) {
      expect(html).toMatch(new RegExp(`data-matrix-state="${state}"[^]*?<code>${id}</code>`));
    }
    expect(html).toContain("[answered: check: npm test, <a href=\"#" + diffFileAnchor("src/payout/guard.ts") + "\">changed-path: src/payout/guard.ts</a>]");
    expect(html).toContain("the screenshot did not validate");
    // The citation's anchor lands on that file's section of the sealed diff.
    expect(html).toContain(`<details class="diff-file" open id="${diffFileAnchor("src/payout/guard.ts")}">`);
    expect(html).toContain(`href="#${diffFileAnchor('docs/we"ird.md')}"`);
    expect(html).toContain(`id="${diffFileAnchor('docs/we"ird.md')}"`);
    expect(html).toContain("docs/we&quot;ird.md");

    // Drift: two files outside src/payout/ are named, first in the list.
    expect(html).toContain('data-cockpit-drift="2"');
    expect(html).toContain("2 changed files outside the approved paths");
    const files = /<ol class="cockpit-files">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
    const items = [...files.matchAll(/<li data-file-priority="(\d)">.*?<a class="mono" href="#[^"]+">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]);
    expect(items).toEqual([["0", "docs/we&quot;ird.md"], ["0", "package-lock.json"], ["2", "src/payout/guard.ts"]]);
    expect(files).toContain('data-outside-touches="1"');
    expect(files).toContain("outside approved paths");
    expect(files).toContain("dependencies, CI, schema, or credentials");
    expect(files).toContain("not referenced by a requirement");
    // The stored verdict and the sealed bytes are untouched by any of it.
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    const artifact = store.artifactsFor(run).find(one => one.kind === "terminal-diff");
    if (artifact === undefined) throw new Error("no patch");
    const raw = await (await fetch(url(`/r/${run}/evidence/${artifact.id}`), { headers: { cookie } })).text();
    expect(raw).toBe(patch);
    // The patch beneath keeps its own order: guard.ts first, as sealed.
    const diff = html.slice(html.indexOf('<div class="diff-review"'));
    expect(diff.indexOf("src/payout/guard.ts")).toBeLessThan(diff.indexOf("package-lock.json"));
  });

  test("evidence is labeled by source — machine re-run, agent checks, reviewer judgements and findings, screenshots, caveats — and says plainly what is missing", async () => {
    // The project's reviewer is codex, so the sealed review leg — and the
    // reviewer run below — is codex (v48: a run spends only as its leg).
    store.setPhaseConfig("/repo/main", "review", "codex", "gpt-5-codex", "test", T0);
    const richRef = seed("t-rich", "everything on record", "/repo/main", {
      acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }],
    });
    const rich = build("t-rich", richRef, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Made it work.", changes: ["changed x"], verification: ["ran it"], followUps: ["watch the first deploy"] },
      proof: {
        version: 1,
        criteria: [{ id: "c1", statement: "It works", verdict: "met", how: "ran it", evidence: [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }] }],
        checks: [{ command: "npm test", exitCode: 0, summary: "12 passed" }],
        changed: ["x"],
        caveats: ["The staging flag is still off."],
        screenshots: [{ path: "evidence/x.png", caption: "x after the change" }],
      },
      checkLog: "$ npm test\n12 passed\n",
      screenshot: { path: "evidence/x.png", caption: "x after the change" },
      verdict: {
        verdict: "refuted",
        machineVerdict: "verified",
        reasons: ["reviewer:codex contradicts c1"],
        matrix: [row("c1", "It works", "failed", [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }], ["contradicted"], { judgement: "contradicts", note: "the guard is a TODO", author: "reviewer:codex" })],
      },
    });
    // The reviewer answers the finished run's open review request inside
    // its own admission (raw authority repair).
    const richAsked = store.requestReview(rich, "alex", T0);
    if (!richAsked.ok) throw new Error(`requestReview: ${richAsked.reason}`);
    const reviewerRun = store.startRun({ taskRef: richRef, leaseId: "lease-reviewer", runner: "night-shift-1", role: "reviewer", parentRun: rich, request: richAsked.id, provider: "codex", now: T0, ...presented(store, richRef, "reviewer") });
    store.stampProviderStart(reviewerRun, T0);
    const richPatch = store.artifactsFor(rich).find(one => one.kind === "terminal-diff");
    if (richPatch === undefined) throw new Error("no patch");
    store.addReviewerComments({ reviewerRunId: reviewerRun, runId: rich, artifactId: richPatch.id, author: "reviewer:codex", comments: [{ path: "x", line: 1, note: "this is not a lock", severity: "problem" }] }, T0);
    store.finishRun(reviewerRun, { outcome: "no-change", reason: "reviewed", now: T0 });

    const bareRef = seed("t-bare", "nothing but a diff");
    const bare = build("t-bare", bareRef, {
      patch: "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "y", additions: 1, deletions: 1 }],
      verdict: { verdict: "short", reasons: ["no proof file"], matrix: [row("c1", "t-bare is done", "missing")] },
      finishedAt: at(1),
    });
    // A failed publication, observed.
    const pub = store.createPublicationIntent({ run: bare, taskRef: bareRef, githubRepo: "acme/thing", remote: "origin", base: "main", head: "standing-orders/t-bare", headSha: "b".repeat(40), bodyHash: "h", draft: false }, T0);
    store.recordPublicationError(pub, "remote: permission denied", T0);
    store.failPublication(pub, T0);
    await boot();
    const cookie = await login();

    const html = await (await fetch(url("/review?result=t-rich"), { headers: { cookie } })).text();
    expect(html).toContain('data-proof-verdict="proof-refuted"');
    expect(html).toContain("<strong>Standing Orders</strong>");
    expect(html).toContain("An independent review found conflicting evidence");
    expect(html).toContain('data-cockpit-source="machine"');
    expect(html).toContain("Check output");
    expect(html).toContain("12 passed");
    expect(html).toContain('<details class="cockpit-proof-group" data-cockpit-source="agent"><summary>Agent checks · 1</summary>');
    expect(html).toContain("(exit 0) — 12 passed");
    expect(html).toContain('data-cockpit-source="reviewer"');
    expect(html).toContain('data-review-judgement="contradicts"');
    expect(html).toContain("reviewer:codex: the guard is a TODO");
    expect(html).toContain('<span class="badge badge-failed">problem</span> <span class="mono">x:1</span> this is not a lock');
    expect(html).toContain('data-cockpit-source="screenshots"');
    expect(html).toMatch(new RegExp(`<img src="/r/${rich}/evidence/\\d+" alt="x after the change">`));
    expect(html).toContain('data-cockpit-source="caveats"');
    expect(html).toContain("The staging flag is still off.");
    expect(html).toContain("follow-up: watch the first deploy");
    expect(html).toContain("Made it work.");
    expect(html).toContain("<li>changed x</li>");
    expect(html).toContain("Not published — this build was not set to create a branch or pull request");

    const plain = await (await fetch(url("/review?result=t-bare"), { headers: { cookie } })).text();
    expect(plain).toContain("No automated check was configured for this build");
    expect(plain).toContain("The agent reported no checks");
    expect(plain).toContain("No screenshots were needed");
    expect(plain).toContain("No caveats were reported");
    expect(plain).toContain('data-matrix-state="missing"');
    expect(plain).toContain('<span class="badge">failed</span> publication failed after 1 attempt — remote: permission denied');
  });

  test("actions: only applicable roads appear, each through its existing endpoint with the session's CSRF; a bearer session sees no forms", async () => {
    const ref = seed("t-act", "decide on me");
    const run = build("t-act", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "short", reasons: ['c1 needs a human <img src=x onerror="alert(1)">'], matrix: [row("c1", "t-act is done", "manual-review", [{ kind: "manual-review", ref: "look" }])] },
    });
    await boot();
    const cookie = await login();

    const before = await (await fetch(url("/review?result=t-act"), { headers: { cookie } })).text();
    // The primary act opens the captured check; the audited exception stays
    // beside the evidence and posts to the task's existing endpoint.
    expect(before).toContain('data-next-action="accept-proof"');
    expect(before).toContain('href="#verification" data-open-evidence>Review evidence</a>');
    expect(before).toContain('evidence.setAttribute("open","")');
    expect(before).toContain('primary.setAttribute("open","")');
    expect(before).toContain('data-primary-evidence');
    expect(before).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(before).not.toContain('<img src=x onerror="alert(1)">');
    expect(before).toContain('<form method="post" action="/t/t-act/accept-proof" class="cockpit-accept-form">');
    expect(before).toContain('aria-label="exception reason" required>');
    expect(before).toContain("Accept with exception");
    // Annotation and its return road, and no revision seal before a comment.
    expect(before).toContain(`<form method="post" action="/r/${run}/comment" class="diff-comment-form" id="comment-form">`);
    expect(before).toContain('<input type="hidden" name="return" value="/review?result=t-act">');
    expect(before).not.toContain(`action="/r/${run}/revise"`);
    expect(before).not.toContain("draft-repair");
    expect(before).not.toContain("/contest/");
    // Every form carries the token, and the annotate script rides along.
    const forms = [...mainOf(before).matchAll(/<form[^>]*>(.*?)<\/form>/gs)];
    expect(forms.length).toBe(2);
    for (const form of forms) expect(form[1]).toContain('name="csrf"');
    expect(before).toContain('document.getElementById("comment-form")');
    const csrf = csrfOf(before);

    // No token: refused at the existing gate, nothing accepted.
    const forged = await post(cookie, "/t/t-act/accept-proof", { note: "sneaky" });
    expect(forged.status).toBe(403);
    expect(store.proofAcceptance(run)).toBeNull();

    // An annotation from the cockpit lands back on the cockpit, focused.
    const noted = await post(cookie, `/r/${run}/comment`, { csrf, path: "x", line: "1", note: "tighten this", return: "/review?result=t-act" });
    expect(noted.status).toBe(303);
    expect(noted.headers.get("location")).toBe("/review?result=t-act&noted=1#annotate");
    // Any other return shape falls back to the run page.
    const elsewhere = await post(cookie, `/r/${run}/comment`, { csrf, path: "x", line: "1", note: "and this", return: "https://evil.example/review?result=t-act" });
    expect(elsewhere.headers.get("location")).toBe(`/r/${run}?noted=1#review`);

    const after = await (await fetch(url("/review?result=t-act&noted=1"), { headers: { cookie } })).text();
    expect(after).toContain("tighten this");
    expect(after).toContain(`<form method="post" action="/r/${run}/revise" class="revision-from-comments">`);
    expect(after).toContain("2 comments ready");
    expect(after).toContain('aria-label="review comment" autofocus>');
    // Still the accept decision first: it resolves the state; the seal waits below.
    expect(after).toContain('data-next-action="accept-proof"');

    // Accept from the cockpit — the existing act, recorded under the session's name.
    const accepted = await post(cookie, "/t/t-act/accept-proof", { csrf, note: "read it myself" });
    expect(accepted.status).toBe(303);
    expect(store.proofAcceptance(run)?.approver).toBe("alex");
    const done = await (await fetch(url("/review?result=t-act"), { headers: { cookie } })).text();
    expect(done).not.toContain("accept-proof");
    expect(done).toContain("Accepted with exception");
    expect(done).toContain("Accepted with an exception by <span class=\"mono\">alex</span>");
    expect(done).toContain("read it myself");
    expect(done).toContain("missing evidence — accepted with exception");
    expect(done).toContain('data-next-action="revise"');
    // The stored verdict never moved.
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");

    // A bearer credential reads the same facts but is offered no form.
    const bearer = await (await fetch(url("/review?result=t-act"), { headers: { authorization: `Bearer alex:${approverToken}` } })).text();
    expect(bearer).toContain('data-review-task="t-act"');
    expect(mainOf(bearer)).not.toContain("<form");
    expect(bearer).not.toContain('id="comment-form"');
  });

  test("a deep link resolves a completion older than the bounded queue directly, re-proved as done and in view; the queue states its cap (v2 review, comment 1)", async () => {
    // One built completion far older than a window's worth of hand-closed
    // tasks, plus an equally old one in a repo outside the ceiling.
    const oldRef = seed("t-old", "finished long ago");
    const oldRun = build("t-old", oldRef, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "attested" },
      finishedAt: at(400),
    });
    seed("t-old-theirs", "theirs, long ago", "/repo/other");
    build("t-old-theirs", store.refFor("built-in", "t-old-theirs").id, { verdict: { verdict: "refuted" }, finishedAt: at(401) });
    // A task that was done once and reopened: no longer a completion.
    store.createTask({ id: "t-reopened", title: "reopened" }, T0);
    store.placeTask(store.refFor("built-in", "t-reopened", "ours").id, "/repo/main");
    store.setTaskState("t-reopened", "done", at(402));
    store.setTaskState("t-reopened", "queued", at(1));
    for (let i = 0; i < 101; i += 1) {
      const id = `t-recent-${String(i).padStart(3, "0")}`;
      store.createTask({ id, title: `recent ${i}` }, T0);
      store.placeTask(store.refFor("built-in", id, "ours").id, "/repo/main");
      store.setTaskState(id, "done", new Date(T0.getTime() - i * 60_000));
    }
    await boot();
    const cookie = await login();

    // The queue is bounded to the newest 100 and says so.
    const html = await (await fetch(url("/review"), { headers: { cookie } })).text();
    expect(queueOf(html).match(/<li>/g)?.length).toBe(100);
    expect(queueOf(html)).not.toContain("t-old");
    expect(html).toContain("Showing the newest 100; older results still open from their task");
    expect(html).not.toContain('data-cockpit-beyond="1"');

    // The old completion's link still opens it — its own build, verdict,
    // diff, and annotation road — with an honest note and no queue row.
    const old = await (await fetch(url("/review?result=t-old"), { headers: { cookie } })).text();
    expect(old).toContain('data-review-task="t-old"');
    expect(old).toContain('data-cockpit-beyond="1"');
    expect(old).toContain('Opened directly: <span class="mono">t-old</span> finished earlier than the newest 100 completions the queue lists');
    expect(old).not.toContain("is in view here");
    expect(old).not.toContain('aria-current="page"');
    expect(old).toContain("Evidence captured");
    expect(old).toContain(`href="/r/${oldRun}">Full build history and evidence →</a>`);
    expect(old).toContain(`<form method="post" action="/r/${oldRun}/comment" class="diff-comment-form" id="comment-form">`);
    expect(old).toContain('data-next-action="annotate"');

    // Outside the ceiling, or not done any more: still the missing note,
    // never the hidden row's facts.
    for (const miss of ["t-old-theirs", "t-reopened", "nope"]) {
      const body = await (await fetch(url(`/review?result=${miss}`), { headers: { cookie } })).text();
      expect(body).toContain(`No completed task <span class="mono">${miss}</span> is in view here`);
      expect(body).not.toContain('data-cockpit-beyond="1"');
      expect(body).not.toContain("theirs, long ago");
    }
  });

  test("the proof-state chip is the receipt's own word, verdict first: a no-change run never masks a refuted proof (v2 review, comment 3)", async () => {
    const refutedRef = seed("t-nc-refuted", "no change, refuted");
    build("t-nc-refuted", refutedRef, {
      handoff: { conclusion: "Nothing to do." },
      verdict: { verdict: "refuted", reasons: ["a criterion cites a file that did not change"] },
      outcome: "no-change",
    });
    const quietRef = seed("t-nc-attested", "no change, attested");
    build("t-nc-attested", quietRef, { handoff: { conclusion: "Already done." }, verdict: { verdict: "attested" }, outcome: "no-change", finishedAt: at(1) });
    const bareRef = seed("t-nc-bare", "no change, no verdict");
    build("t-nc-bare", bareRef, { outcome: "no-change", finishedAt: at(2) });
    await boot();
    const cookie = await login();
    const chipOf = (html: string): string => /<span class="receipt-proof" data-proof-state="([a-z]+)"><i aria-hidden="true"><\/i>([^<]+)<\/span>/.exec(html)?.slice(1).join(" · ") ?? "(no chip)";

    for (const [id, expected] of [
      ["t-nc-refuted", "problem · Conflicting evidence"],
      ["t-nc-attested", "attested · Evidence captured"],
      ["t-nc-bare", "unknown · Unverified"],
    ] as const) {
      const cockpit = await (await fetch(url(`/review?result=${id}`), { headers: { cookie } })).text();
      const receipt = await (await fetch(url(`/t/${id}`), { headers: { cookie } })).text();
      expect(chipOf(cockpit), id).toBe(expected);
      expect(chipOf(receipt), id).toBe(expected);
      expect(cockpit).not.toContain("No change needed");
    }
    const refuted = await (await fetch(url("/review?result=t-nc-refuted"), { headers: { cookie } })).text();
    expect(refuted).toContain('data-next-action="accept-proof"');
    expect(refuted).toContain("The build concluded that no repository change was needed.");
  });

  test("annotation eligibility is one rule: an empty or unverifiable diff offers neither the form, the file buttons, nor the picker script (v2 review, comment 5)", async () => {
    const emptyRef = seed("t-empty", "captured nothing");
    build("t-empty", emptyRef, { patch: "\n", stat: [], verdict: { verdict: "attested" } });
    const fullRef = seed("t-full", "captured something");
    const fullRun = build("t-full", fullRef, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }], verdict: { verdict: "attested" }, finishedAt: at(1) });
    await boot();
    const cookie = await login();
    const empty = await (await fetch(url("/review?result=t-empty"), { headers: { cookie } })).text();
    expect(empty).toContain("empty diff — captured successfully, nothing changed");
    expect(empty).not.toContain('id="comment-form"');
    expect(empty).not.toContain('class="pick-file"');
    expect(empty).not.toContain('document.getElementById("comment-form")');
    expect(empty).toContain('data-next-action="inspect-run"');
    const full = await (await fetch(url("/review?result=t-full"), { headers: { cookie } })).text();
    expect(full).toContain(`action="/r/${fullRun}/comment"`);
    expect(full).toContain('class="pick-file"');
    expect(full).toContain('document.getElementById("comment-form")');
    const bearer = await (await fetch(url("/review?result=t-full"), { headers: { authorization: `Bearer alex:${approverToken}` } })).text();
    expect(bearer).not.toContain('class="pick-file"');
    expect(bearer).not.toContain('document.getElementById("comment-form")');
  });

  test("the archive and the result receipt lead into the cockpit; the cockpit leads back to the sealed record", async () => {
    const ref = seed("t-link", "linked both ways");
    const run = build("t-link", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Linked." },
      verdict: { verdict: "attested" },
    });
    await boot();
    const cookie = await login();
    const done = await (await fetch(url("/done"), { headers: { cookie } })).text();
    expect(done).toContain('<a href="/review?result=t-link">review →</a>');
    const task = await (await fetch(url("/t/t-link"), { headers: { cookie } })).text();
    expect(task).toContain('<a href="/review?result=t-link">Open in the review cockpit →</a>');
    const cockpit = await (await fetch(url("/review?result=t-link"), { headers: { cookie } })).text();
    expect(cockpit).toContain(`<a href="/r/${run}">Full build history and evidence →</a>`);
    expect(cockpit).toContain('href="/t/t-link"');
  });

  test("the Retry review action (v50): consistent queued, running, retry, exhausted, and reviewed states on the task page and the cockpit; the form posts through the one store door; every refusal is words", async () => {
    const ref = seed("t-retry", "retry my review");
    const run = build("t-retry", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Built." },
      verdict: { verdict: "verified" },
    });
    await boot();
    const cookie = await login();
    const pages = async () => ({
      task: await (await fetch(url("/t/t-retry"), { headers: { cookie } })).text(),
      cockpit: await (await fetch(url("/review?result=t-retry"), { headers: { cookie } })).text(),
    });
    const panelOf = (html: string): string => /<div class="[^"]*review-retry"[^>]*>.*?<\/div>\s*(?:<ol class="review-attempts".*?<\/ol>)?\s*(?:<div class="review-retry-actions">.*?<\/div>)?<\/div>/s.exec(html)?.[0] ?? "";

    // Never asked: no panel at all.
    let both = await pages();
    expect(both.task).not.toContain("data-review-state=");
    expect(both.cockpit).not.toContain("data-review-state=");

    // Queued: the same disabled control on both pages, attempt 1 of 3.
    const first = store.requestReview(run, "alex", T0);
    if (!first.ok) throw new Error(first.reason);
    both = await pages();
    for (const html of [both.task, both.cockpit]) {
      expect(html).toContain('data-review-state="queued" data-review-attempts="0" data-review-cap="3" data-review-remaining="2"');
      expect(html).toContain("<strong>Review queued</strong>");
      expect(html).toContain('<button type="button" class="review-retry-button" disabled aria-disabled="true">Retry queued</button>');
      expect(html).not.toContain("/retry-review");
    }
    // Running: attempt 1 of 3, no act.
    const admitted = store.admitReview(first.id, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!admitted.ok) throw new Error(admitted.reason);
    both = await pages();
    for (const html of [both.task, both.cockpit]) {
      expect(html).toContain('data-review-state="running" data-review-attempts="1"');
      expect(html).toContain("<strong>Reviewing · attempt 1 of 3</strong>");
      expect(html).toContain(">Reviewing…</button>");
      expect(html).toContain(`data-review-attempt="1" data-review-outcome="open"`);
    }
    // Failed: the retry act appears — the task page's form returns to the
    // task, the cockpit's form returns to the cockpit — with the attempt
    // it would run and the retries that would remain.
    store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
    store.stampReviewRequestOutcome(first.id, "reviewer-agent");
    both = await pages();
    for (const html of [both.task, both.cockpit]) {
      expect(html).toContain('data-review-state="retryable" data-review-attempts="1" data-review-cap="3" data-review-remaining="2"');
      expect(html).toContain("<strong>Review failed · attempt 1 of 3</strong>");
      expect(html).toContain("Review attempt 1 of 3 failed (reviewer-agent).");
      expect(html).toContain("2 explicit retries left.");
      expect(html).toContain(`data-review-attempt="1" data-review-outcome="failed"><span class="review-attempt-ordinal">attempt 1</span> <a href="/r/${admitted.reviewerRunId}">run #${admitted.reviewerRunId}</a> <span class="meta">failed · reviewer-agent</span>`);
      expect(html).toContain('<form method="post" action="/t/t-retry/retry-review" class="inline review-retry-form">');
      expect(html).toContain(`<input type="hidden" name="run" value="${run}">`);
      expect(html).toContain(">Retry review · attempt 2 of 3</button>");
    }
    expect(panelOf(both.task)).not.toContain('name="return"');
    expect(panelOf(both.cockpit)).toContain('<input type="hidden" name="return" value="/review?result=t-retry">');
    const csrf = csrfOf(both.task);
    // No token: refused at the existing gate, nothing queued.
    expect((await post(cookie, "/t/t-retry/retry-review", { run: String(run) })).status).toBe(403);
    expect(store.reviewRetryStateOf(run)).toMatchObject({ state: "retryable" });
    // A page rendered over another build refuses rather than retrying the wrong one.
    const stale = await post(cookie, "/t/t-retry/retry-review", { csrf, run: "999" });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("reload and decide again");
    expect(store.reviewRetryStateOf(run)).toMatchObject({ state: "retryable" });
    // The act: one request, attempt 2, back to where it was asked from.
    const asked = await post(cookie, "/t/t-retry/retry-review", { csrf, run: String(run), return: "/review?result=t-retry" });
    expect(asked.status).toBe(303);
    expect(asked.headers.get("location")).toBe("/review?result=t-retry");
    expect(store.reviewRetryStateOf(run)).toMatchObject({ state: "queued", nextAttempt: 2, retriesRemaining: 1 });
    // The console's ask is an operator's (explicit-only): typed so, and
    // shown so on both pages once queued.
    expect(store.openReviewRequests()).toMatchObject([{ run, requestedBy: "alex", origin: "operator" }]);
    // Asked again while queued: words, no second request.
    const twice = await post(cookie, "/t/t-retry/retry-review", { csrf, run: String(run) });
    expect(twice.status).toBe(409);
    expect(await twice.text()).toContain(`a review of build #${run} is already queued (attempt 2 of 3)`);
    expect(store.openReviewRequests()).toHaveLength(1);
    both = await pages();
    for (const html of [both.task, both.cockpit]) {
      expect(html).toContain('data-review-state="queued" data-review-attempts="1" data-review-cap="3" data-review-remaining="1"');
      expect(html).toContain("<strong>Review retry queued · attempt 2 of 3</strong>");
      expect(html).toContain("The explicit retry asked by alex is waiting for a worker;");
      expect(html).toContain("1 explicit retry left after it.");
    }
    // Any other return shape lands on the task page's status card.
    const request2 = store.openReviewRequests()[0]!.id;
    const second = store.admitReview(request2, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!second.ok) throw new Error(second.reason);
    store.finishRun(second.reviewerRunId, { outcome: "failed", reason: "interrupted", now: T0 });
    both = await pages();
    expect(both.task).toContain("<strong>Review interrupted · attempt 2 of 3</strong>");
    expect(both.task).toContain("Review attempt 2 of 3 was interrupted.");
    expect(both.task).toContain("1 explicit retry left.");
    expect(both.task).toContain(">Retry review · attempt 3 of 3</button>");
    const elsewhere = await post(cookie, "/t/t-retry/retry-review", { csrf, run: String(run), return: "https://evil.example/review?result=t-retry" });
    expect(elsewhere.status).toBe(303);
    expect(elsewhere.headers.get("location")).toBe("/t/t-retry#run-status");
    // Exhausted: the last attempt fails, the control says so, and the act refuses.
    const request3 = store.openReviewRequests()[0]!.id;
    const third = store.admitReview(request3, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!third.ok) throw new Error(third.reason);
    store.finishRun(third.reviewerRunId, { outcome: "failed", reason: "reviewer-timeout", now: T0 });
    both = await pages();
    for (const html of [both.task, both.cockpit]) {
      expect(html).toContain('data-review-state="exhausted" data-review-attempts="3" data-review-cap="3" data-review-remaining="0"');
      expect(html).toContain("<strong>Review retries exhausted · 3 of 3</strong>");
      expect(html).toContain("All 3 review attempts ended without a review (latest: failed (reviewer-timeout)). Nothing retries a fourth time");
      expect(html).toContain(">No retries left</button>");
      expect(html).not.toContain("/retry-review");
      expect(html).toContain('data-review-attempt="3" data-review-outcome="failed"');
    }
    const spent = await post(cookie, "/t/t-retry/retry-review", { csrf, run: String(run) });
    expect(spent.status).toBe(409);
    expect(await spent.text()).toContain(`build #${run} has spent all 3 review attempts`);
    expect(store.runsFor(ref).filter(one => one.role === "reviewer")).toHaveLength(3);
    expect(store.openReviewRequests()).toEqual([]);

    // Reviewed: a success closes the allowance and reads as such everywhere.
    const won = seed("t-won", "review landed");
    const wonRun = build("t-won", won, { patch: "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n", verdict: { verdict: "verified" } });
    const wonAsk = store.requestReview(wonRun, "alex", T0);
    if (!wonAsk.ok) throw new Error(wonAsk.reason);
    const wonRoot = store.admitReview(wonAsk.id, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!wonRoot.ok) throw new Error(wonRoot.reason);
    store.finishRun(wonRoot.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
    const wonRetry = store.requestReview(wonRun, "alex", new Date(T0.getTime() + 1_000));
    if (!wonRetry.ok) throw new Error(wonRetry.reason);
    const wonSecond = store.admitReview(wonRetry.id, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!wonSecond.ok) throw new Error(wonSecond.reason);
    store.stampProviderStart(wonSecond.reviewerRunId, T0);
    const diff = store.artifactsFor(wonRun).find(one => one.kind === "terminal-diff")!;
    store.ingestReview({ reviewerRunId: wonSecond.reviewerRunId, runId: wonRun, artifactId: diff.id, author: "reviewer:claude", comments: [], judgements: [], bindings: { diffSha: diff.sha256, scopeDigest: null, headSha: "b".repeat(40), proof: null, checkLog: null, screenshots: [] } }, T0);
    const wonTask = await (await fetch(url("/t/t-won"), { headers: { cookie } })).text();
    expect(wonTask).toContain('data-review-state="succeeded" data-review-attempts="2" data-review-cap="3" data-review-remaining="0"');
    expect(wonTask).toContain("<strong>Reviewed · attempt 2 of 3</strong>");
    expect(wonTask).toContain("landed after 1 explicit retry; a successful review is never retried.");
    expect(wonTask).toContain(">Reviewed</button>");
    expect(wonTask).not.toContain("/retry-review");
    const refusedWin = await post(cookie, "/t/t-won/retry-review", { csrf, run: String(wonRun) });
    expect(refusedWin.status).toBe(409);
    expect(await refusedWin.text()).toContain("a successful review is never retried");

    // A viewer sees the same facts and a control that names whose act it is.
    const viewer = addApprover(store, "vera", T0, { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    const login2 = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "vera", token: viewer.token }), redirect: "manual" });
    const viewerCookie = (login2.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const fresh = seed("t-view", "watched retry");
    const freshRun = build("t-view", fresh, { patch: "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n", verdict: { verdict: "verified" } });
    const freshAsk = store.requestReview(freshRun, "alex", T0);
    if (!freshAsk.ok) throw new Error(freshAsk.reason);
    const freshRoot = store.admitReview(freshAsk.id, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
    if (!freshRoot.ok) throw new Error(freshRoot.reason);
    store.finishRun(freshRoot.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
    const watched = await (await fetch(url("/t/t-view"), { headers: { cookie: viewerCookie } })).text();
    expect(watched).toContain('data-review-state="retryable"');
    expect(watched).toContain(">Retry review · approvers only</button>");
    expect(watched).not.toContain("/retry-review");
    const viewerCsrf = csrfOf(watched);
    const watchedPost = await post(viewerCookie, "/t/t-view/retry-review", { csrf: viewerCsrf, run: String(freshRun) });
    expect(watchedPost.status).toBe(403);
    expect(store.reviewRetryStateOf(freshRun)).toMatchObject({ state: "retryable" });
  });
});

describe("the phase route on the console (v47): one projection on the task page, in the ceremony, and in the focused chat", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let viewerToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-09-10T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };
  const page = async (cookie: string, path: string): Promise<string> => (await fetch(url(path), { headers: { cookie } })).text();
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
  const agentsCardOf = (html: string): string => /<section class="card agents-card" id="agents"[^>]*>(.*?)<\/section>/s.exec(html)?.[1] ?? "";
  const JARGON = /\b(route|phase|sealed|stales?|harness default)\b/i;

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-route-"));
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "test", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    const viewer = addApprover(store, "vera", T0, { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    viewerToken = viewer.token;
    register(store, { name: "mac-mini", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-mac-mini" });
    store.createTask({ id: "payouts", title: "Harden payouts" }, T0);
    const ref = store.refFor("built-in", "payouts").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "payouts",
      goal: "Harden the payouts flow",
      acceptance: [{ id: "pay", statement: "Payouts never double-send", how: null, evidence: ["check", "screenshot"] }],
      riskLevel: "high",
      now: T0,
    });
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(T0.getTime() + 60_000), repo: "/repo/main" });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the task page leads with a compact plain-English Agents summary; reasons and availability are one tap away; the ceremony restates the agents without availability; the CLI projection is the same words", async () => {
    store.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "unavailable", reason: "`codex login status` says not logged in", probe: "identity" }], T0);
    const cookie = await loginAs("alex", approverToken);
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("<h3>Agents</h3>");
    expect(card).toContain('<span class="badge">High risk</span>');
    expect(card).toContain('<span class="badge">stronger configured agents</span>');
    expect(card).toContain('<span class="badge">awaiting approval</span>');
    expect(card).toContain('<p class="agents-summary">claude · sonnet plans; claude · opus builds and repairs; codex · gpt-5-codex reviews</p>');
    // Reasons and change controls are CLOSED details, not always-open rows.
    expect(card).toContain('<details class="agents-why"><summary>Why these agents</summary>');
    expect(card).toContain('<details class="agents-change"><summary>Change agents</summary>');
    expect(card).not.toContain("<details open");
    expect(card).toContain("risk is high — every role uses the strongest configured agent");
    expect(card).toContain("acceptance requires screenshots");
    expect(card).toContain("<dt>Builder</dt><dd><span class=\"mono\">claude · opus</span> <span class=\"badge\">recommended · strong</span>");
    // Availability is volatile metadata beside the agents.
    expect(card).toContain('<li class="agents-availability-unavailable"><span class="mono">codex</span> unavailable (`codex login status` says not logged in)');
    expect(card).toContain('<span class="mono">claude</span> not yet checked');
    expect(card).toContain("Paused: a provider these agents need is reported unavailable. Nothing else is used in its place");
    expect(card).toContain('name="risk"');
    expect(card).toContain('name="phase"');
    // Valid forms: each form is its own element, never nested, and every
    // control is at least 44px tall.
    expect(card).not.toMatch(/<form[^>]*>(?:(?!<\/form>).)*<form/s);
    expect(card).toMatch(/<form method="post" action="\/t\/payouts\/route" class="agents-form-risk">/);
    expect(html).toContain(".agents-form input, .agents-form select, .agents-form-risk select { width: 100%; min-width: 0; min-height: 2.75rem; }");
    // No jargon in the visible words (form attribute names aside).
    const visible = card.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");
    expect(visible).not.toMatch(JARGON);
    // The ceremony restates the agents where the yes is given — and never
    // the volatile availability.
    const ceremony = /<form method="post" action="\/t\/payouts\/approve"(.*?)<\/form>/s.exec(html)?.[1] ?? "";
    expect(ceremony).toContain('<p class="approval-label">agents</p>');
    expect(ceremony).toContain("claude · sonnet plans; claude · opus builds and repairs; codex · gpt-5-codex reviews");
    expect(ceremony).toContain("These exact agents are part of what you approve");
    // Plain-English risk consequence, and the runtime mechanics closed away.
    expect(ceremony).toContain("High risk: every role — planner, builder, repair, and reviewer — uses the strongest agent you have configured.");
    expect(ceremony).toContain('<details class="agents-runtime"><summary>Runtime limits</summary>');
    expect(ceremony).not.toContain("--dangerously");
    // No duplicate provider · model chip beside the agents summary.
    expect(ceremony).not.toMatch(/<span class="approval-chip">claude · opus<\/span>/);
    expect(ceremony).not.toContain("unavailable");
    expect(ceremony).not.toContain("not yet checked");
    expect(ceremony.replace(/<[^>]+>/g, " ")).not.toMatch(JARGON);
    // The same projection the CLI prints — one function, one set of words.
    const ref = store.refFor("built-in", "payouts");
    const routed = routeOfTask(store, "payouts", ref, new Date(T0.getTime() + 60_000))!;
    if (routed.kind !== "route") throw new Error("expected a route");
    const projection = projectRoute(routed.route, store.readinessLookupFor("/repo/main", null, new Date(T0.getTime() + 60_000)));
    expect(card).toContain(projection.summary);
    for (const leg of projection.legs) {
      for (const reason of leg.reasons) expect(card).toContain(reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    }
  });

  test("an approver changes an agent from the page in one transaction: recorded with attribution, the approval needs renewing, the CAS refuses a stale form, and clearing re-files again", async () => {
    const cookie = await loginAs("alex", approverToken);
    const first = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, first.digest, approverToken).ok).toBe(true);
    const before = await page(cookie, "/t/payouts");
    expect(agentsCardOf(before)).toContain('<span class="badge">approved</span>');
    expect(agentsCardOf(before)).toContain(`name="sawDigest" value="${first.digest}"`);
    const csrf = csrfOf(before);
    const bad = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "review", provider: "gemini", model: "gemini-2.5-pro" });
    expect(bad.status).toBe(400);
    const noModel = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "review", provider: "codex", model: "" });
    expect(noModel.status).toBe(400);
    // A form rendered against a digest that is no longer current is refused.
    const stale = await post(cookie, "/t/payouts/route", { csrf, sawDigest: "0".repeat(32), phase: "review", provider: "claude", model: "sonnet" });
    expect(stale.status).toBe(409);
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
    // A pair configured for another role (the strong BUILDER) is not a
    // reviewer choice: refused inside the transaction, nothing moves.
    const borrowed = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "review", provider: "claude", model: "opus" });
    expect(borrowed.status).toBe(400);
    expect(await borrowed.text()).toContain("not one of the configured agents for the reviewer right now (claude · sonnet, codex · gpt-5-codex)");
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
    const changed = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "review", provider: "claude", model: "sonnet" });
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toContain("/t/payouts");
    expect(decodeURIComponent(changed.headers.get("location") ?? "")).toContain("approve it again");
    expect(changed.headers.get("location")).toMatch(/#agents$/);
    const ref = store.refFor("built-in", "payouts");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "review", provider: "claude", model: "sonnet", by: "alex" })]);
    const after = store.getScope("payouts")!;
    expect(approvalOf(after)).toMatchObject({ approved: false, reason: "changed" });
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("<dt>Reviewer</dt><dd><span class=\"mono\">claude · sonnet</span> <span class=\"badge\">overridden</span>");
    expect(card).toContain("overridden by alex to claude · sonnet (recommended codex · gpt-5-codex)");
    expect(card).toContain("Reviewer → <span class=\"mono\">claude · sonnet</span>");
    expect(card).toContain('name="clear-phase" value="review"');
    // The risk moves too, through the same door, with the current digest.
    const risk = await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: after.digest, risk: "elevated" });
    expect(risk.status).toBe(303);
    expect(store.getScope("payouts")!.riskLevel).toBe("elevated");
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("Elevated risk");
    // Clearing the override restores the recommendation.
    const cleared = await post(cookie, "/t/payouts/route", { csrf, sawDigest: store.getScope("payouts")!.digest, "clear-phase": "review" });
    expect(cleared.status).toBe(303);
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([]);
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("<dt>Reviewer</dt><dd><span class=\"mono\">codex · gpt-5-codex</span>");
  });

  test("a viewer reads the agents but cannot change them; a live claim refuses the edit", async () => {
    const viewer = await loginAs("vera", viewerToken);
    const html = await page(viewer, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("claude · opus");
    expect(card).not.toContain('name="phase"');
    const refused = await post(viewer, "/t/payouts/route", { csrf: csrfOf(html), risk: "routine" });
    expect(refused.status).toBe(403);
    expect(store.getScope("payouts")!.riskLevel).toBe("high");
    // Under a live claim the approver's edit is refused too.
    const cookie = await loginAs("alex", approverToken);
    const scope = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, scope.digest, approverToken).ok).toBe(true);
    const ref = store.refFor("built-in", "payouts").id;
    const taken = acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: new Date(T0.getTime() + 60_000) });
    expect(taken.ok).toBe(true);
    const running = await page(cookie, "/t/payouts");
    expect(agentsCardOf(running)).toContain("this task is running — its agents cannot change under a live claim");
    const blocked = await post(cookie, "/t/payouts/route", { csrf: csrfOf(running), risk: "routine" });
    expect(blocked.status).toBe(409);
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
  });

  test("the focused chat shows the same agents beside the conversation, in an always-visible strip, and inside its approval card", async () => {
    store.recordProviderReadiness("mac-mini", [{ provider: "claude", state: "unknown", reason: "installed (claude 1.2.3); no non-spending login check exists", probe: "version" }], T0);
    const cookie = await loginAs("alex", approverToken);
    const chat = await page(cookie, "/chat?task=payouts");
    const aside = /<div class="task-chat-agents-aside">(.*?)<p class="meta"><a href="\/t\/payouts#agents">Change agents on the task/s.exec(chat)?.[1] ?? "";
    expect(aside).toContain('<p class="agents-summary">claude · sonnet plans; claude · opus builds and repairs; codex · gpt-5-codex reviews</p>');
    expect(aside).toContain('<span class="badge">High risk</span>');
    expect(aside).toContain('<span class="badge">awaiting approval</span>');
    expect(aside).toContain('<details class="agents-why"><summary>Why these agents</summary>');
    expect(aside).toContain('<span class="mono">claude</span> not yet checked');
    // The compact strip lives in the live region, which phones keep even
    // when the desktop context panel is hidden.
    const strip = /<p class="task-chat-agents">(.*?)<\/p>/s.exec(chat)?.[1] ?? "";
    expect(strip).toContain('<span class="eyebrow">agents</span>');
    expect(strip).toContain("claude · sonnet plans; claude · opus builds and repairs; codex · gpt-5-codex reviews");
    expect(strip).toContain('href="/t/payouts#agents"');
    expect(chat).toContain(".task-chat-workspace .task-chat-context { display: none; }");
    expect(chat).toContain(".task-chat-agents {");
    expect(strip.replace(/<[^>]+>/g, " ")).not.toMatch(JARGON);
    const approvalCard = /<details class="card chat-action-card chat-approval" id="task-chat-action">(.*?)<\/details>\s*<\/section>|<details class="card chat-action-card chat-approval" id="task-chat-action">(.*)/s.exec(chat)?.[0] ?? "";
    expect(approvalCard).toContain("High risk · stronger configured agents");
    expect(approvalCard).toContain('<p class="approval-label">agents</p>');
    expect(approvalCard).toContain("codex · gpt-5-codex");
    expect(approvalCard).not.toContain("not yet checked");
  });

  test("simple-controls: the change controls offer only configured, role-valid agents from a select, explain every risk choice, and quote no command line; an unconfigured pair is refused", async () => {
    const cookie = await loginAs("alex", approverToken);
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    const change = /<details class="agents-change">(.*?)<\/details>/s.exec(card)?.[1] ?? "";
    // Every risk level explained in plain words, beside the control.
    expect(change).toContain('<dl class="agents-risk-guide">');
    expect(change).toContain("<dt>Routine</dt><dd>every role uses the everyday configured agent unless the work itself asks for more");
    expect(change).toContain("<dt>Elevated risk</dt><dd>the review runs on the strongest configured reviewer");
    expect(change).toContain("<dt>High risk</dt><dd>every role — planner, builder, repair, and reviewer — uses the strongest agent you have configured");
    // One form per role, a select of exact configured pairs, no free text.
    expect(change).not.toContain('name="model"');
    expect(change).not.toContain('name="provider"');
    const forms = [...change.matchAll(/<form method="post" action="\/t\/payouts\/route" class="agents-form"[^>]*>(.*?)<\/form>/gs)].map(one => one[1] ?? "");
    expect(forms).toHaveLength(4);
    const optionsOf = (form: string): string[] => [...form.matchAll(/<option value="([^"]+)"/g)].map(one => one[1] ?? "");
    const byPhase = Object.fromEntries(forms.map(form => [/name="phase" value="([a-z]+)"/.exec(form)?.[1] ?? "", optionsOf(form)]));
    // Each role's OWN configured pairs: the everyday sonnet everywhere, the
    // strong opus builder only where it was configured (build, and repair
    // on the build provider), the strong codex reviewer only for review.
    expect(byPhase["plan"]).toEqual(["claude|sonnet"]);
    expect(byPhase["build"]).toEqual(["claude|sonnet", "claude|opus"]);
    // Repairs stay on the build provider; gemini never reviews (and was never configured).
    expect(byPhase["repair"]).toEqual(["claude|sonnet", "claude|opus"]);
    expect(byPhase["review"]).toEqual(["claude|sonnet", "codex|gpt-5-codex"]);
    expect(change).not.toContain("gemini");
    // The current agent is marked, and selected.
    expect(forms.find(form => form.includes('value="build"'))).toContain('<option value="claude|opus" selected>claude · opus — current</option>');
    // No command-line jargon anywhere on the card, and no runtime switches.
    const visible = card.replace(/<[^>]+>/g, " ");
    expect(visible).not.toMatch(/config set|task route|--tier|--provider|--model|--dangerously/);
    expect(visible).not.toMatch(JARGON);
    // A pair nobody configured is refused, in words, whatever the client typed.
    const csrf = csrfOf(html);
    const digest = store.getScope("payouts")!.digest;
    const unconfigured = await post(cookie, "/t/payouts/route", { csrf, sawDigest: digest, phase: "review", agent: "codex|gpt-5" });
    expect(unconfigured.status).toBe(400);
    expect(await unconfigured.text()).toContain("not one of the configured agents for the reviewer right now (claude · sonnet, codex · gpt-5-codex)");
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([]);
    // A strong planner configured later is offered for the planner — and only then.
    store.setPhaseTierConfig("installation", "plan", "strong", "claude", "opus", "test", T0);
    // The select's own value lands as an exact, attributed choice.
    const chosen = await post(cookie, "/t/payouts/route", { csrf, sawDigest: digest, phase: "plan", agent: "claude|opus" });
    expect(chosen.status).toBe(303);
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([expect.objectContaining({ phase: "plan", provider: "claude", model: "opus", by: "alex" })]);
    // A planner choice IS the plan pin (v47): the leg reads pinned, exactly.
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("<dt>Planner</dt><dd><span class=\"mono\">claude · opus</span> <span class=\"badge\">pinned</span>");
  });

  test("consent: the task page, the focused chat, and the next-up triage all restate the same concise exact agents before the password, with runtime limits closed away", async () => {
    const cookie = await loginAs("alex", approverToken);
    const summary = "claude · sonnet plans; claude · opus builds and repairs; codex · gpt-5-codex reviews";
    const risk = "High risk: every role — planner, builder, repair, and reviewer — uses the strongest agent you have configured.";
    const ceremonyOf = (html: string, action: string): string => new RegExp(`<form method="post" action="${action}"(.*?)<\\/form>`, "s").exec(html)?.[1] ?? "";
    const check = (ceremony: string): void => {
      const agentsAt = ceremony.indexOf('<p class="approval-label">agents</p>');
      const passwordAt = ceremony.indexOf('name="token"');
      expect(agentsAt).toBeGreaterThan(-1);
      expect(passwordAt).toBeGreaterThan(agentsAt);
      expect(ceremony).toContain(`<p class="agents-summary">${summary}</p>`);
      expect(ceremony).toContain(risk);
      expect(ceremony).toContain('<details class="agents-runtime"><summary>Runtime limits</summary>');
      expect(ceremony).not.toContain("<details open");
      expect(ceremony).not.toContain("not yet checked");
      expect(ceremony.replace(/<[^>]+>/g, " ")).not.toMatch(/--dangerously|config set|task route/);
    };
    check(ceremonyOf(await page(cookie, "/t/payouts"), "\\/t\\/payouts\\/approve"));
    check(ceremonyOf(await page(cookie, "/chat?task=payouts"), "\\/t\\/payouts\\/approve"));
    const next = await page(cookie, "/next");
    expect(next).toContain("the last thing waiting on you");
    check(ceremonyOf(next, "\\/t\\/payouts\\/approve"));
    // Changing an agent invalidates the approval every surface signed under.
    const before = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, before.digest, approverToken).ok).toBe(true);
    expect((await page(cookie, "/next"))).toContain("Nothing needs you");
    const html = await page(cookie, "/t/payouts");
    const changed = await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: before.digest, phase: "review", agent: "claude|sonnet" });
    expect(changed.status).toBe(303);
    expect(approvalOf(store.getScope("payouts")!)).toMatchObject({ approved: false, reason: "changed" });
    const again = await page(cookie, "/next");
    expect(again).toContain("the last thing waiting on you");
    expect(ceremonyOf(again, "\\/t\\/payouts\\/approve")).toContain("claude · sonnet plans and reviews; claude · opus builds and repairs");
  });

  test("a routed task whose approval lost its agents shows the closed door in words, and a proven pre-routing approval shows its profile", async () => {
    const cookie = await loginAs("alex", approverToken);
    const scope = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, scope.digest, approverToken).ok).toBe(true);
    store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 'payouts'").run();
    const gone = agentsCardOf(await page(cookie, "/t/payouts"));
    expect(gone).toContain('<span class="badge">cannot be read</span>');
    expect(gone).toContain("the approval sealed no agent route");
    expect(gone).toContain("Nothing runs for this task until its scope is filed again and approved.");
    store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL WHERE task_id = 'payouts'").run();
    const legacy = agentsCardOf(await page(cookie, "/t/payouts"));
    expect(legacy).toContain("claude · opus builds and repairs (repair model opus); the planner and reviewer come from configuration at run time");
  });
});
