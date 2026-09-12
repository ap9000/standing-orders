import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { disposeBuildOutcome } from "./dispose.js";
import { run, runOwnerTag } from "./exec.js";
import { requestTaskStop, resumeTaskStop, taskControlOf, underStopWatch } from "./task-control.js";
import { witnessedRunner } from "./process-custody.js";
import { WorktreePool } from "./worktree.js";
import { storeEvidence } from "./evidence.js";

const roots: string[] = [];
const stores: Store[] = [];
const children: ChildProcess[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-adversarial-")));
  roots.push(root);
  const store = openStore(join(root, "orders.db"));
  stores.push(store);
  const now = new Date();
  register(store, { name: "worker", host: "fixture", capacity: 2, repos: [root], now, newToken: () => "fixture-only" });
  store.createTask({ id: "draft", title: "Draft" }, now);
  const ref = store.refFor("built-in", "draft").id;
  store.placeTask(ref, root);
  const claim = acquire(store, ref, "worker", { token: "fixture-only", now, incarnation: "dead-watch" });
  if (!claim.ok) throw new Error(JSON.stringify(claim));
  const id = store.startRun({ taskRef: ref, runner: "worker", leaseId: claim.claim.leaseId,
    worktree: root, branch: "draft", now,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
  return { root, store, ref, id, leaseId: claim.claim.leaseId, now };
}

describe("operator review: cancellation cannot cross custody boundaries", () => {
  test("an unrecorded possible spawn stays stopping and cannot resume", () => {
    const f = fixture();
    f.store.raw().prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(f.now.toISOString(), f.id);
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toContain("witness");
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date()).ok).toBe(false);
  });

  test("an earlier completed setup cannot hide a crash before the next spawn witness", () => {
    const f = fixture();
    const earlier = f.store.reserveRunProcess(f.id, new Date());
    f.store.finishUnspawnedProcess(earlier, new Date());
    f.store.reserveRunProcess(f.id, new Date());
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toContain("incomplete spawn witness");
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
  });

  test("a returning transport can close a reserved spawn that created no process", async () => {
    const f = fixture();
    const result = await witnessedRunner(f.store, f.id, () => new Date(), run)(join(f.root, "no-such-executable"), [], { processGroup: true });
    expect(result.notFound).toBe(true);
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
  });

  test("all unspawned transient retries settle when their transport returns", async () => {
    const f = fixture();
    const transport = witnessedRunner(f.store, f.id, () => new Date(), async (_file, _args, options) => {
      options?.beforeSpawn?.();
      options?.beforeSpawn?.();
      return { code: 1, stdout: "", stderr: "no child", timedOut: false, notFound: true };
    });
    await transport("unused", [], { processGroup: true });
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
  });

  test("completion has no unlocked window where an accepted stop can lose", () => {
    const f = fixture();
    const other = openStore(join(f.root, "orders.db"));
    stores.push(other);
    const transact = f.store.transact.bind(f.store);
    let depth = 0, stopAccepted: boolean | null = null;
    // Model a second SQLite writer committing immediately after the first
    // transaction releases its lock. The completion transaction must re-read.
    f.store.transact = ((body: () => unknown) => {
      depth++;
      let value: unknown;
      try { value = transact(body); } finally { depth--; }
      if (depth === 0 && stopAccepted === null) {
        const alreadyEnded = other.getRun(f.id)?.outcome !== null;
        stopAccepted = other.requestRunStop({ runId: f.id, taskRef: f.ref, by: "operator", via: "cli" }, new Date()).ok;
        expect(stopAccepted).toBe(!alreadyEnded);
      }
      return value;
    }) as Store["transact"];
    const disposition = disposeBuildOutcome({ store: f.store, policy: "tick", leaseId: f.leaseId,
      runId: f.id, taskId: "draft", taskRef: f.ref, runner: "worker", repo: f.root,
      branch: "draft", origin: "ours", provider: "claude", model: null,
      worktreePath: f.root, clock: () => new Date() },
    { ok: true, committed: true, branch: "draft", summary: "late success" });
    expect(stopAccepted).not.toBeNull();
    if (stopAccepted) {
      expect(disposition.kind).toBe("stopped");
      expect(f.store.getTask("draft")?.state).toBe("queued");
      expect(f.store.getRun(f.id)).toMatchObject({ outcome: "failed", reason: "interrupted", committed: true });
    } else {
      expect(disposition.kind).toBe("built");
      expect(f.store.getTask("draft")?.state).toBe("done");
      expect(f.store.getRun(f.id)?.outcome).toBe("built");
      expect(f.store.stopOf(f.id)).toBeNull();
    }
    expect(f.store.publicationForRun(f.id)).toBeNull();
  });

  test("equal local run IDs in independent databases do not share process custody", async () => {
    const a = fixture(), b = fixture();
    expect(a.id).toBe(b.id);
    let readyA!: () => void, readyB!: () => void;
    const ready = Promise.all([new Promise<void>(r => { readyA = r; }), new Promise<void>(r => { readyB = r; })]);
    const target = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      owner: runOwnerTag(a.store, a.id), processGroup: true, timeoutMs: 2_000, onSpawn: readyA,
    });
    const independent = run(process.execPath, ["-e", "setTimeout(()=>console.log('independent success'),350)"], {
      owner: runOwnerTag(b.store, b.id), processGroup: true, timeoutMs: 2_000, onSpawn: readyB,
    });
    await ready;
    expect(requestTaskStop(a.store, { taskId: "draft", runId: a.id, by: "operator", via: "web" }, new Date()).ok).toBe(true);
    const [stopped, untouched] = await Promise.all([target, independent]);
    expect(stopped.code).not.toBe(0);
    expect(stopped.timedOut).toBe(false);
    expect(untouched).toMatchObject({ code: 0, timedOut: false, stdout: "independent success\n" });
    expect(b.store.stopOf(b.id)).toBeNull();
  });

  test("a stop observed before an asynchronous spawn still terminates that later child", async () => {
    const f = fixture();
    f.store.requestRunStop({ runId: f.id, taskRef: f.ref, by: "operator", via: "web" }, new Date());
    let notifications = 0;
    const result = await underStopWatch(f.store, f.id, async () => {
      await delay(60);
      return run(process.execPath, ["-e", "setInterval(()=>console.log('still writing'),25)"], {
        owner: runOwnerTag(f.store, f.id), processGroup: true, timeoutMs: 2_000,
      });
    }, { intervalMs: 20, onStop: () => { notifications++; } });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(notifications).toBe(1);
  });

  test("recovering a dead controller keeps stop pending while its orphaned provider writes", async () => {
    const f = fixture();
    const file = join(f.root, "draft.txt");
    const child = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[1], 'draft\n');
      setInterval(() => fs.appendFileSync(process.argv[1], 'still writing\n'), 30);
      process.send('ready');
    `, file], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    f.store.recordRunProcess(f.id, child.pid!, new Date());
    const stamp = f.now.toISOString();
    f.store.saveWorktree({ path: f.root, repo: f.root, branch: "draft", runner: "worker", taskRef: f.ref,
      createdAt: stamp, leasedAt: stamp, releasedAt: null, verified: true });
    writeFileSync(join(f.root, ".standing-orders-lease"), `${child.pid} worker group\n`);
    expect(requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "web" }, new Date()).ok).toBe(true);
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    const before = readFileSync(file, "utf8");
    await delay(100);
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(before.length);
    const pool = new WorktreePool(f.store, { root: join(f.root, "pool") });
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "web", occupied: path => pool.inUse(path) }, new Date()).ok).toBe(false);
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
    expect(f.store.stopOf(f.id)?.resumedAt).toBeNull();
    expect(taskControlOf(f.store, f.ref, new Date()).kind).toBe("stopping");
    // A removed worktree marker cannot erase the database's spawn witness.
    rmSync(join(f.root, ".standing-orders-lease"));
    expect(f.store.settleQuiescentStops(new Date())).toBe(0);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    expect(f.store.settleQuiescentStops(new Date())).toBe(1);
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date()).ok).toBe(true);
  });

  test("review retry waits for an orphan even when that reviewer has no worktree", async () => {
    const f = fixture();
    f.store.finishRun(f.id, { outcome: "built", now: new Date() });
    storeEvidence(f.store, join(f.root, "evidence"), f.id, "terminal-diff", "diff.patch", Buffer.from("diff --git a/a b/a\n"), "fixture", new Date(), { captureStatus: "ok" });
    const inserted = f.store.raw().prepare("INSERT INTO run (task_ref,lease_id,runner,role,provider,parent_run,review_attempt,started_at) VALUES (?, 'review-lease', 'worker', 'reviewer', 'claude', ?, 1, ?)").run(f.ref, f.id, f.now.toISOString());
    const review = Number(inserted.lastInsertRowid);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100);process.send('ready')"], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    f.store.recordRunProcess(review, child.pid!, new Date());
    expect(requestTaskStop(f.store, { taskId: "draft", runId: review, by: "operator", via: "cli" }, new Date()).ok).toBe(true);
    f.store.recoverRunnerWork("worker", new Date());
    expect(f.store.stopOf(review)?.settledAt).toBeNull();
    expect(f.store.requestReview(f.id, "operator", new Date())).toMatchObject({ ok: false, reason: "review-running" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    expect(f.store.settleQuiescentStops(new Date())).toBe(1);
    expect(f.store.requestReview(f.id, "operator", new Date())).toMatchObject({ ok: true, attempt: 2 });
  });
});
