/** Seed an isolated fixture database with the exact-run control states for
 * screenshots (v52 safe task stop and resume): `node --import tsx
 * evidence/safe-task-stop-and-resume/seed.ts [base-dir]` (default
 * /tmp/so-stop-capture), never the live control database. Serve it with
 * `standing-orders serve --db <base>/orders.db --repo <realpath of base>/repo
 * --port 4997`. The runner's heartbeat is fresh, so the live attempt reads
 * as running; the stopped attempts were sealed through the real fenced
 * interruption seal, so what the pages show is exactly what the worker
 * writes. */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "../../src/store.js";
import { register } from "../../src/runner.js";
import { acquire, finalizeInterruptedFenced } from "../../src/claim.js";
import { addApprover, approve, propose } from "../../src/scope.js";
import { requestTaskStop } from "../../src/task-control.js";

const base = process.argv[2] ?? "/tmp/so-stop-capture";
const repo = join(base, "repo");
const evidenceRoot = join(base, "evidence");
rmSync(join(base, "orders.db"), { force: true });
rmSync(join(base, "orders.db-wal"), { force: true });
rmSync(join(base, "orders.db-shm"), { force: true });
rmSync(repo, { recursive: true, force: true });
rmSync(evidenceRoot, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", "add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", "commit", "-qm", "seed"], { cwd: repo });

const store = openStore(join(base, "orders.db"));
const repoReal = realpathSync(repo);
const T = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T(600));
store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T(600));
store.setPhaseConfig("installation", "review", "codex", "gpt-5.6-sol", "alex", T(600));
const alex = addApprover(store, "alex", T(600), undefined, () => "stop-capture-pass");
if (!alex.ok) throw new Error("approver");
register(store, { name: "night-shift-1", host: "studio", capacity: 4, repos: [repoReal], now: new Date(), newToken: () => "tok-night" });

function task(id: string, title: string, state: "live" | "stopping" | "paused"): void {
  store.createTask({ id, title }, T(500));
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repoReal);
  const proposed = propose(store, {
    taskId: id,
    goal: "Add a rate limiter guard in front of every payout so a runaway loop cannot drain the float.",
    outOfScope: "Do not change payout amounts or the ledger schema.",
    touches: ["src/payouts.ts"],
    acceptance: [
      { id: "c1", statement: "Every payout passes through the limiter guard before sending.", how: null, evidence: ["changed-path"] },
      { id: "c2", statement: "The approved verification command passes.", how: null, evidence: ["check"] },
    ],
    now: T(500),
  });
  if (!approve(store, id, "alex", T(490), proposed.digest, "stop-capture-pass").ok) throw new Error("approve");
  const authority = store.routeAuthorityFor(ref, "builder");
  if (authority === null || !authority.ok) throw new Error("route");
  const claimed = acquire(store, ref, "night-shift-1", { token: "tok-night", now: T(12), ttlMs: 6 * 3_600_000, newLeaseId: () => `lease-${id}` });
  if (!claimed.ok) throw new Error(`claim ${claimed.reason}`);
  const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "night-shift-1", provider: authority.stamp.provider, model: authority.stamp.model ?? "sonnet", branch: `standing-orders/${id}`, worktree: join(base, "worktrees", id), now: T(11), route: authority.stamp });
  store.stampProviderStart(run, T(11));
  store.setRunPhase(run, "agent-running");
  store.setTaskState(id, "running", T(11));
  if (state === "live") return;
  const asked = requestTaskStop(store, { taskId: id, runId: run, by: "alex", via: "web" }, T(3));
  if (!asked.ok) throw new Error(`stop ${asked.reason}`);
  if (state === "stopping") return;
  store.recordOutcomeFacts(run, { headRevision: "4f1c2e9a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f" });
  const sealed = finalizeInterruptedFenced(store, { leaseId: `lease-${id}`, runId: run, taskId: id, stopRun: run, committed: true, now: T(2) });
  if (!sealed.ok) throw new Error("seal");
}

task("rate-limit-payouts-live", "Rate-limit payouts behind the limiter guard", "live");
task("rate-limit-payouts-stopping", "Rate-limit payouts — stop requested", "stopping");
task("rate-limit-payouts-paused", "Rate-limit payouts — paused after a stop", "paused");
store.close();
console.log("seeded", join(base, "orders.db"));
