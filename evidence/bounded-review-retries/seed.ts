/** Seed an isolated fixture database with the three review-retry states for screenshots. */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "../../src/store.js";
import { storeEvidence } from "../../src/evidence.js";
import { register } from "../../src/runner.js";
import { addApprover, approve, propose } from "../../src/scope.js";

const base = "/tmp/so-retry-capture";
const repo = join(base, "repo");
const evidenceRoot = join(base, "home", ".standing-orders", "evidence");
rmSync(join(base, "orders.db"), { force: true });
rmSync(repo, { recursive: true, force: true });
rmSync(join(base, "home"), { recursive: true, force: true });
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
const alex = addApprover(store, "alex", T(600), undefined, () => "retry-capture-pass");
if (!alex.ok) throw new Error("approver");
register(store, { name: "night-shift-1", host: "studio", capacity: 4, repos: [repoReal], now: T(600), newToken: () => "tok-night" });
const PATCH = "diff --git a/src/payouts.ts b/src/payouts.ts\n--- a/src/payouts.ts\n+++ b/src/payouts.ts\n@@ -1,3 +1,4 @@\n import { limiter } from \"./limiter.js\";\n+const guard = limiter({ perMinute: 30 });\n export function payout(amount: number): void {\n   send(amount);\n";

function task(id: string, title: string, attempts: ("failed" | "interrupted" | "no-change" | "open")[], queued: boolean): void {
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
  if (!approve(store, id, "alex", T(490), proposed.digest, "retry-capture-pass").ok) throw new Error("approve");
  const authority = store.routeAuthorityFor(ref, "builder");
  if (authority === null || !authority.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "night-shift-1", provider: authority.stamp.provider, model: authority.stamp.model ?? "sonnet", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T(120), route: authority.stamp });
  storeEvidence(store, evidenceRoot, run, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff --no-ext-diff (exit 0)", T(100), { captureStatus: "ok" });
  storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from("> vitest run\n\n Test Files  12 passed (12)\n      Tests  148 passed (148)\n", "utf8"), `sh -c "npm test" (exit 0)`, T(100));
  store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T(100), [
    { id: "c1", statement: "Every payout passes through the limiter guard before sending.", requiredEvidence: ["changed-path"], state: "pass", detail: [], answered: [{ kind: "changed-path", ref: "src/payouts.ts" }], review: null },
    { id: "c2", statement: "The approved verification command passes.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "npm test" }], review: null },
  ]);
  store.recordOutcomeFacts(run, { headRevision: "4f1c2e9a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f", handoff: "Added the limiter guard in front of send(); the verification suite passes." });
  store.finishRun(run, { outcome: "built", committed: true, now: T(100) });
  store.setTaskState(id, "done", T(100));
  let minutes = 95;
  for (const outcome of attempts) {
    const asked = store.requestReview(run, "alex", T(minutes));
    if (!asked.ok) throw new Error(`ask: ${asked.reason}`);
    const admitted = store.admitReview(asked.id, { runner: "night-shift-1", token: "tok-night", provider: "codex", model: "gpt-5.6-sol" }, T(minutes - 1));
    if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
    store.stampProviderStart(admitted.reviewerRunId, T(minutes - 1));
    if (outcome === "open") break;
    const reason = outcome === "interrupted" ? "interrupted" : outcome === "failed" ? "reviewer-timeout" : "reviewed — 0 comment(s)";
    store.finishRun(admitted.reviewerRunId, { outcome: outcome === "interrupted" ? "failed" : outcome, reason, now: T(minutes - 20) });
    store.stampReviewRequestOutcome(asked.id, outcome === "no-change" ? "reviewed" : reason);
    minutes -= 25;
  }
  if (queued) {
    const asked = store.requestReview(run, "alex", T(2));
    if (!asked.ok) throw new Error(`queue: ${asked.reason}`);
  }
}

task("rate-limit-payouts", "Rate-limit payouts behind the limiter guard", ["interrupted"], false);
task("rate-limit-payouts-queued", "Rate-limit payouts — retry queued", ["failed"], true);
task("rate-limit-payouts-exhausted", "Rate-limit payouts — every review attempt spent", ["failed", "interrupted", "failed"], false);
task("rate-limit-payouts-reviewed", "Rate-limit payouts — reviewed on the second attempt", ["failed", "no-change"], false);
for (const id of ["rate-limit-payouts", "rate-limit-payouts-queued", "rate-limit-payouts-exhausted", "rate-limit-payouts-reviewed"]) {
  const ref = store.refFor("built-in", id).id;
  const source = store.runsFor(ref).find(one => one.role === "builder")!;
  console.log(id, JSON.stringify({ state: store.reviewRetryStateOf(source.id)?.state, attempts: store.reviewRetryStateOf(source.id)?.attempts.length }));
}
store.close();
console.log("seeded", join(base, "orders.db"));
