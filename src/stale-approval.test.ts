/**
 * A stale approval is a deterministic refusal (setup review): the first
 * real install retried one every pass and wrote a thousand refused runs in
 * minutes. Now the task is HELD under a backoff the approval door lifts,
 * the operator is paged once per approval, and the next pass leaves it
 * alone.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-03T00:00:00.000Z");

describe("a stale approval holds the task instead of retrying every pass", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));
  const neverCalled: Runner = async () => {
    throw new Error("no agent should ever spawn on a stale approval");
  };
  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: neverCalled });
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-stale-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("refused once, held, paged once; a fresh approval lifts the hold and closes the page", async () => {
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      store.close();
    }
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["task", "add", "dedupe listings", "--id", "dedupe", "--repo", repo, "--json"]);
    await run(["task", "scope", "dedupe", "--goal", "Dedupe the listings", "--json"]);
    const before = openStore(db);
    const digest = before.getScope("dedupe")?.digest as string;
    before.close();
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"]);
    expect(payload().ok).toBe(true);

    // The routing moves under the approval: what was signed no longer matches.
    {
      const store = openStore(db);
      store.setPhaseConfig("installation", "build", "claude", "opus", "test", new Date("2026-09-02T00:00:00.000Z"));
      store.close();
    }
    const tick = (now: Date) => run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], now);

    const first = await tick(new Date(T0.getTime() + 60_000));
    expect(first).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dedupe", outcome: "skipped", reason: "stale-approval" }));

    const store = openStore(db);
    const ref = store.refFor("built-in", "dedupe");
    const runs = store.runsFor(ref.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "refused", reason: "stale-approval" });
    const held = store.activeHolds(ref.id, new Date(T0.getTime() + 60_000));
    expect(held.some(one => one.ownerKind === "backoff" && one.reason.startsWith("stale-approval"))).toBe(true);
    const paged = store.listNotifications("pending").filter(one => one.kind === "stale-approval");
    expect(paged).toHaveLength(1);
    expect(paged[0]?.pushClass).toBe("attention");
    store.close();

    // The next pass leaves it alone: no second run, no second page.
    const second = await tick(new Date(T0.getTime() + 120_000));
    expect(second).toBe(EXIT.refused);
    const again = openStore(db);
    expect(again.runsFor(ref.id)).toHaveLength(1);
    expect(again.listNotifications("all").filter(one => one.kind === "stale-approval")).toHaveLength(1);
    again.close();

    // A fresh approval lifts the hold and resolves the page.
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"], new Date(T0.getTime() + 180_000));
    expect(payload().ok).toBe(true);
    const after = openStore(db);
    expect(after.activeHolds(ref.id, new Date(T0.getTime() + 180_000)).some(one => one.reason.startsWith("stale-approval"))).toBe(false);
    expect(after.listNotifications("pending").filter(one => one.kind === "stale-approval")).toHaveLength(0);
    after.close();
  });
});
