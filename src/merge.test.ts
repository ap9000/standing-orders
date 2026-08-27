/**
 * The merge grant (v21): four review rounds' findings, each pinned.
 * Scripted gh; the network is never touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { sweepMerges, mergeTermsHash, type PublishExec } from "./publish.js";

const T0 = new Date("2026-08-21T06:00:00.000Z");
const REPO = "/repo/main";
const HEAD = "abc123def4567890";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

/** A scripted gh: keyed by command prefix, recorded for assertions. */
function gh(answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: PublishExec = async (file, args) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.includes(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
  return { exec, calls };
}

const GREEN_VIEW = JSON.stringify({
  statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
  headRefOid: HEAD,
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
});
const NO_RULES = { stdout: "[[]]" };
const NO_CLASSIC = { code: 1, stderr: "HTTP 404: Branch not protected" };

/** The healthy world: green on the exact head, no queue, no protection. */
const HEALTHY = {
  "rules/branches": NO_RULES,
  "branches/main/protection": NO_CLASSIC,
  "pr view": { stdout: GREEN_VIEW },
  "pr merge": {},
};

describe("the merge grant", () => {
  let store: Store;
  let publicationId: number;

  const grantIt = (over: Record<string, unknown> = {}) =>
    store.savePublicationGrant(
      {
        repo: REPO,
        githubRepo: "alex/thing",
        remote: "origin",
        headPrefix: "standing-orders/",
        base: "main",
        capabilities: ["push-branch", "open-pr"],
        selector: "ours",
        draft: false,
        grantedBy: "alex",
        merge: true,
        mergeMethod: "squash",
        mergeDeleteBranch: false,
        ...over,
      } as Parameters<Store["savePublicationGrant"]>[0],
      T0,
    );

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    const taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    const runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    publicationId = store.createPublicationIntent(
      {
        run: runId,
        taskRef,
        githubRepo: "alex/thing",
        remote: "origin",
        base: "main",
        head: "standing-orders/t-1",
        headSha: HEAD,
        bodyHash: "x",
        draft: false,
      },
      T0,
    );
    store.markPublicationPushed(publicationId, T0);
    store.markPublicationOpened(publicationId, 7, "https://github.com/alex/thing/pull/7", T0);
  });

  afterEach(() => store.close());

  test("a merge grant names its method, always", () => {
    expect(() => grantIt({ mergeMethod: null })).toThrow(/merge-method/);
  });

  test("green on the exact head merges — pinned to the commit, under the granted method", async () => {
    grantIt();
    const world = gh(HEALTHY);
    const report = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: world.exec });

    expect(report.merged).toBe(1);
    const merge = world.calls.find(call => call.args[0] === "pr" && call.args[1] === "merge");
    expect(merge?.args).toContain("--squash");
    expect(merge?.args).toContain("--match-head-commit");
    expect(merge?.args).toContain(HEAD);
    expect(merge?.args).not.toContain("--delete-branch");
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "merged" });
    // Merged is durable: a second sweep issues no second call.
    const again = gh(HEALTHY);
    await sweepMerges(store, { repo: REPO, clock: () => T0, exec: again.exec });
    expect(again.calls.filter(call => call.args[1] === "merge")).toHaveLength(0);
  });

  test("no grant, no merge; a revoked or de-merged grant supersedes rather than merges", async () => {
    const world = gh(HEALTHY);
    expect((await sweepMerges(store, { repo: REPO, clock: () => T0, exec: world.exec })).merged).toBe(0);
    expect(world.calls).toHaveLength(0);
  });

  test("a draft refuses, typed, with the rearm path paged", async () => {
    grantIt();
    const world = gh({
      ...HEALTHY,
      "pr view": { stdout: GREEN_VIEW.replace('"isDraft":false', '"isDraft":true') },
    });
    const report = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: world.exec });
    expect(report.refused).toBe(1);
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "refused", lastError: "draft" });
    expect(world.calls.filter(call => call.args[1] === "merge")).toHaveLength(0);
  });

  test("a merge-queue rule refuses; unreadable protection refuses harder — fail closed either way", async () => {
    grantIt();
    const queued = gh({ ...HEALTHY, "rules/branches": { stdout: '[[{"type":"merge_queue"}]]' } });
    const first = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: queued.exec });
    expect(first.refused).toBe(1);
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "refused", lastError: "merge-queue" });
    expect(queued.calls.filter(call => call.args[1] === "merge")).toHaveLength(0);

    // Classic protection present (200): the endpoint cannot PROVE queue
    // absence, so auto-merge pauses rather than guessing.
    expect(store.rearmMergeIntent(publicationId)).toBe(true);
    const classic = gh({ ...HEALTHY, "branches/main/protection": { stdout: "HTTP/2.0 200 OK\n\n{}" } });
    const second = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: classic.exec });
    expect(second.refused).toBe(1);
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "refused", lastError: "merge-queue-unknown" });
  });

  test("red, running, or a moved head never merges; the moved head supersedes", async () => {
    grantIt();
    const red = gh({
      ...HEALTHY,
      "pr view": { stdout: GREEN_VIEW.replace('"SUCCESS"', '"FAILURE"') },
    });
    await sweepMerges(store, { repo: REPO, clock: () => T0, exec: red.exec });
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "pending" });
    expect(red.calls.filter(call => call.args[1] === "merge")).toHaveLength(0);

    const moved = gh({
      ...HEALTHY,
      "pr view": { stdout: GREEN_VIEW.replace(HEAD, "f".repeat(16)) },
    });
    await sweepMerges(store, { repo: REPO, clock: () => T0, exec: moved.exec });
    expect(store.mergeIntentFor(publicationId)).toMatchObject({ state: "superseded" });
  });

  test("a repair blocker holds the merge, sticky, until the unblock act lifts it", async () => {
    grantIt();
    store.createMergeBlocker(publicationId, "t-1-ci-7", T0);
    const world = gh(HEALTHY);
    const held = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: world.exec });
    expect(held.skipped).toBe(1);
    expect(world.calls).toHaveLength(0);

    expect(store.liftMergeBlocker(publicationId, "alex", T0)).toBe(true);
    const after = await sweepMerges(store, { repo: REPO, clock: () => T0, exec: gh(HEALTHY).exec });
    expect(after.merged).toBe(1);
  });

  test("a losing observation can never authorize: the stalled green is discarded", () => {
    // Generation 1 reserved (stalls), generation 2 observes failing and
    // settles; generation 1's late green settle LOSES and has no effect.
    const gen1 = store.reserveObservation("alex/thing", 7);
    const gen2 = store.reserveObservation("alex/thing", 7);
    const newer = store.settleObservation(
      { githubRepo: "alex/thing", prNumber: 7, headSha: HEAD, state: "failing", generation: gen2 },
      T0,
    );
    expect(newer.won).toBe(true);
    const stale = store.settleObservation(
      { githubRepo: "alex/thing", prNumber: 7, headSha: HEAD, state: "passing", generation: gen1 },
      new Date(T0.getTime() + 1_000),
    );
    expect(stale.won).toBe(false);
    expect(store.latestObservation("alex/thing", 7)).toMatchObject({ state: "failing", generation: gen2 });
  });

  test("claims are leases: an unexpired claim is untouchable, an expired one reclaims by generation", () => {
    grantIt();
    const grant = store.publicationGrantFor(REPO);
    if (grant === null) throw new Error("grant");
    store.createMergeIntent(
      { publication: publicationId, repo: REPO, grantTermsHash: mergeTermsHash(grant), headSha: HEAD, method: "squash", deleteBranch: false },
      T0,
    );
    const intent = store.mergeIntentFor(publicationId);
    if (intent === null) throw new Error("intent");

    const first = store.claimMergeIntent(intent.id, "watch", 5 * 60_000, T0);
    expect(first).not.toBeNull();
    // Live claim: a second claimer is refused.
    expect(store.claimMergeIntent(intent.id, "publish", 5 * 60_000, new Date(T0.getTime() + 1_000))).toBeNull();
    // Expired: reclaimable, and the OLD generation loses every write.
    const later = new Date(T0.getTime() + 6 * 60_000);
    const second = store.claimMergeIntent(intent.id, "publish", 5 * 60_000, later);
    expect(second).not.toBeNull();
    expect(store.settleMergeIntent(intent.id, (first as { generation: number }).generation, "merged", later)).toBe(false);
    expect(store.settleMergeIntent(intent.id, (second as { generation: number }).generation, "pending", later)).toBe(true);
  });

  test("a v20 database gains the v21 shape and a merge grant round-trips", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v21-"));
    const file = join(dir, "orders.db");
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (20);
        CREATE TABLE publication_grant (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          repo       TEXT NOT NULL,
          github_repo TEXT NOT NULL,
          remote     TEXT NOT NULL,
          head_prefix TEXT NOT NULL,
          base       TEXT NOT NULL,
          capabilities TEXT NOT NULL,
          selector   TEXT NOT NULL,
          draft      INTEGER NOT NULL,
          granted_by TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          revoked_by TEXT,
          revoked_at TEXT
        );
      `);
      old.close();
      // Reopened TWICE — the same-day upgrade rule.
      openStore(file).close();
      const migrated = openStore(file);
      try {
        grantIt.call(null);
        migrated.savePublicationGrant(
          {
            repo: REPO, githubRepo: "alex/thing", remote: "origin", headPrefix: "standing-orders/",
            base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: false,
            grantedBy: "alex", merge: true, mergeMethod: "squash", mergeDeleteBranch: true,
          },
          T0,
        );
        expect(migrated.publicationGrantFor(REPO)).toMatchObject({ merge: true, mergeMethod: "squash", mergeDeleteBranch: true });
        expect(migrated.reserveObservation("alex/thing", 1)).toBe(1);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
