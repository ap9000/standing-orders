/**
 * Publication: the grant is the whole permission, the intent survives every
 * crash, and the PR worker adopts before it creates — proved against a
 * scripted git and gh, never the network.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  bodyHashOf,
  observeChecks,
  publicationBody,
  permitsPublication,
  publishPass,
  MAX_PUBLISH_ATTEMPTS,
  type PublishExec,
} from "./publish.js";

const T0 = new Date("2026-08-12T06:00:00.000Z");
const REPO = "/repo/main";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

function scripted(answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: PublishExec = async (file, args) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.slice(0, 2).join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
  return { exec, calls };
}

describe("publication", () => {
  let store: Store;
  let taskRef: number;
  let runId: number;

  const grantIt = (over: Record<string, unknown> = {}) =>
    store.savePublicationGrant(
      {
        repo: REPO,
        githubRepo: "alex/thing",
        remote: "origin",
        headPrefix: "standing-orders/",
        base: "main",
        capabilities: ["push-branch", "open-pr"],
        selector: "all",
        draft: true,
        grantedBy: "alex",
        ...over,
      } as Parameters<Store["savePublicationGrant"]>[0],
      T0,
    );

  const intendIt = () =>
    store.createPublicationIntent(
      {
        run: runId,
        taskRef,
        githubRepo: "alex/thing",
        remote: "origin",
        base: "main",
        head: "standing-orders/t-1",
        headSha: "abc123def",
        bodyHash: "x",
        draft: true,
      },
      T0,
    );

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    store.stampRun(runId, { baseRevision: "base999" });
    store.recordOutcomeFacts(runId, {
      headRevision: "abc123def",
      handoff: "Added the guard. Fixes #1 should stay prose.",
    });
  });

  afterEach(() => store.close());

  test("the grant is checked whole: repo, remote, base, prefix, capability", () => {
    const shape = { githubRepo: "alex/thing", remote: "origin", base: "main", head: "standing-orders/t-1", state: "intended" as const };

    expect(permitsPublication(null, shape)).toMatchObject({ ok: false });

    grantIt();
    const grant = store.publicationGrantFor(REPO);
    expect(permitsPublication(grant, shape)).toMatchObject({ ok: true });
    expect(permitsPublication(grant, { ...shape, head: "main" })).toMatchObject({ ok: false });
    expect(permitsPublication(grant, { ...shape, base: "release" })).toMatchObject({ ok: false });
    expect(permitsPublication(grant, { ...shape, githubRepo: "other/repo" })).toMatchObject({ ok: false });

    grantIt({ capabilities: ["push-branch"] });
    const pushOnly = store.publicationGrantFor(REPO);
    expect(permitsPublication(pushOnly, shape)).toMatchObject({ ok: true });
    expect(permitsPublication(pushOnly, { ...shape, state: "pushed" as const })).toMatchObject({ ok: false });
  });

  test("the body is reproducible from rows alone, and quotes the agent inertly", () => {
    intendIt();
    const publication = store.publicationForRun(runId)!;

    const body = publicationBody(store, publication);
    expect(body).toContain("wire the payout guard");
    expect(body).toContain("abc123def");
    expect(body).toContain("base999");
    // The agent's words are inside a fence — never bare markdown semantics.
    // Indented, not fenced (audit IV-9): no agent text can terminate indentation.
    expect(body).toContain("    Added the guard. Fixes #1 should stay prose.");
    expect(body).not.toContain("```");

    expect(publicationBody(store, publication)).toBe(body);
    expect(bodyHashOf(body)).toBe(bodyHashOf(publicationBody(store, publication)));
  });

  test("push names the exact SHA, then the PR opens — each phase durable", async () => {
    grantIt();
    intendIt();

    // First pass crashes conceptually after the push: script the PR listing
    // to fail so the row stays 'pushed'.
    const first = scripted({ "gh pr": { code: 1, stderr: "network is down" } });
    const one = await publishPass(store, { repo: REPO, clock: () => T0, exec: first.exec });

    expect(one.pushed).toBe(1);
    expect(first.calls[0]).toMatchObject({
      file: "git",
      args: ["push", "origin", "abc123def:refs/heads/standing-orders/t-1"],
    });
    expect(store.publicationForRun(runId)?.state).toBe("pushed");

    // The next pass resumes exactly where the last stopped: no second push.
    const second = scripted({
      "gh pr": { code: 0, stdout: "[]" },
    });
    // pr create answers with the URL on stdout.
    const answers: Record<string, { code?: number; stdout?: string }> = {
      "gh pr list": { code: 0, stdout: "[]" },
      "gh pr create": { code: 0, stdout: "https://github.com/alex/thing/pull/7\n" },
    };
    const resumed = scripted(answers);
    const two = await publishPass(store, { repo: REPO, clock: () => T0, exec: resumed.exec });
    void second;

    expect(two.opened).toBe(1);
    expect(resumed.calls.some(call => call.file === "git")).toBe(false);
    const created = resumed.calls.find(call => call.args[1] === "create");
    expect(created?.args).toContain("--draft");
    expect(created?.args).toContain("--body-file");
    expect(created?.args).not.toContain("--body");

    const done = store.publicationForRun(runId);
    expect(done).toMatchObject({ state: "opened", prNumber: 7, prUrl: "https://github.com/alex/thing/pull/7" });
    // The morning hears about it.
    expect(store.listNotifications("pending").some(one_ => one_.kind === "publication-opened")).toBe(true);
  });

  test("an existing PR on the head is adopted, never twinned", async () => {
    grantIt();
    intendIt();
    store.markPublicationPushed(store.publicationForRun(runId)!.id, T0);

    const script = scripted({
      "gh pr list": { code: 0, stdout: JSON.stringify([{ number: 4, url: "https://github.com/alex/thing/pull/4" }]) },
    });
    const report = await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });

    expect(report.adopted).toBe(1);
    expect(script.calls.some(call => call.args[1] === "create")).toBe(false);
    expect(store.publicationForRun(runId)).toMatchObject({ state: "opened", prNumber: 4 });
  });

  test("a revoked grant stops the morning's pushes, immediately", async () => {
    grantIt();
    intendIt();
    store.revokePublicationGrant(REPO, "alex", T0);

    const script = scripted();
    const report = await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });

    expect(script.calls).toHaveLength(0);
    expect(report.problems[0]).toContain("no live publication grant");
    expect(store.publicationForRun(runId)?.state).toBe("intended");
  });

  test("retries end in a durable failure that pages a person, and the commit stays safe", async () => {
    grantIt();
    intendIt();

    const script = scripted({ git: { code: 1, stderr: "remote: permission denied" } });
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });
    }

    const failed = store.publicationForRun(runId);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).toContain("permission denied");
    const page = store.listNotifications("pending").find(one => one.kind === "publication-failed");
    expect(page?.body).toContain("abc123def");

    // And a later pass owes nothing — failed is terminal, not a loop.
    const idle = scripted();
    await publishPass(store, { repo: REPO, clock: () => T0, exec: idle.exec });
    expect(idle.calls).toHaveLength(0);
  });
});

describe("watching CI on opened PRs", () => {
  let store: Store;
  let taskRef: number;
  let runId: number;

  const opened = () => {
    const id = store.createPublicationIntent(
      {
        run: runId,
        taskRef,
        githubRepo: "alex/thing",
        remote: "origin",
        base: "main",
        head: "standing-orders/t-1",
        headSha: "abc123",
        bodyHash: "x",
        draft: true,
      },
      T0,
    );
    store.markPublicationPushed(id, T0);
    store.markPublicationOpened(id, 9, "https://github.com/alex/thing/pull/9", T0);
    return id;
  };

  const ghSaying = (payload: unknown) =>
    scripted({ "gh pr": { code: 0, stdout: JSON.stringify(payload) } });

  const ciRows = () =>
    store
      .listNotifications("all")
      .filter(one => one.dedupeKey.startsWith("ci:"))
      .map(one => ({ key: one.dedupeKey, resolved: one.resolvedAt !== null }));

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    opened();
  });

  afterEach(() => store.close());

  test("a red head pages once, keyed by PR and exact commit", async () => {
    const red = ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] });

    await observeChecks(store, { clock: () => T0, exec: red.exec });
    await observeChecks(store, { clock: () => T0, exec: red.exec });

    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: false }]);
    const page = store.listNotifications("pending").find(one => one.kind === "ci-failing");
    expect(page?.subject).toContain("t-1");
    expect(page?.body).toContain("oid-1");
  });

  test("the same head turning green resolves the episode; a new head buries the old one", async () => {
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });

    // Someone pushed a fix: the failing commit is gone, its page resolves
    // even though the new head is still running — running is not green.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ status: "IN_PROGRESS" }] }).exec,
    });
    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: true }]);

    // The new head fails too: a fresh page, its own key.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });
    expect(ciRows()).toEqual([
      { key: "ci:alex/thing:9:oid-1", resolved: true },
      { key: "ci:alex/thing:9:oid-2", resolved: false },
    ]);

    // And green closes it.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ conclusion: "SUCCESS" }] }).exec,
    });
    expect(ciRows().every(row => row.resolved)).toBe(true);
  });

  test("a rollup that could not be read neither pages nor resolves — and says so", async () => {
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });

    const dead = scripted({ "gh pr": { code: 1, stderr: "api.github.com refused" } });
    const report = await observeChecks(store, { clock: () => T0, exec: dead.exec });

    expect(report.problems[0]).toContain("not read");
    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: false }]);
  });
});
