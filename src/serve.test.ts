/**
 * The M3 acceptance surface: a park renders as one screen, answerable on a
 * phone. Real HTTP against an ephemeral port; only the phone is imaginary.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
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
});
