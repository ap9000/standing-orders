/**
 * `standing-orders demo` (adoption track, step 4) — a seeded, throwaway
 * sandbox: ninety seconds from npx to seeing the product mid-flight, with
 * zero real repos, zero agents, zero spend.
 *
 * The honesty contract (Codex adoption review, findings 8 and 9):
 *
 *   - The database is stamped `demo` BEFORE any row exists — an append-only
 *     installation fact with no unset API. Every spending or external-effect
 *     command (tick, watch, build, publish, reconcile, daemon, bridge,
 *     outbox deliver, intake) fails closed on the stamp, so a kept sandbox
 *     can never be mistaken for real work by a worker pointed at it later.
 *     The console banner is decoration; the fence is enforcement.
 *   - The seeded history is SYNTHETIC and does not pretend otherwise: runs
 *     are written with the same permissive store methods the test suite
 *     uses, inside a database that can never join operational history,
 *     because nothing that computes provider success or spends quota will
 *     open it (the fence again).
 *   - The throwaway password goes to the terminal and to a mode-0600 file
 *     inside the sandbox — NEVER into the --json envelope, a URL, or the
 *     database.
 *
 * Everything lives under one mkdtemp directory: database, evidence,
 * "repos". Ctrl-C tears it down; --keep preserves it (still fenced).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import { acquire } from "./claim.js";
import { approveRoutine, fireRoutine } from "./routine.js";
import { fileTaskProposal, fileRoutineProposal } from "./proposal.js";
import { storeEvidence, budgetedStatJson, type DiffStat } from "./evidence.js";

export type DemoSeed = {
  login: { name: string; password: string };
  repos: string[];
};

/** A believable patch for the finished run's review card. */
const DEMO_PATCH = `diff --git a/src/payout.ts b/src/payout.ts
index 3f1c2aa..9e07b41 100644
--- a/src/payout.ts
+++ b/src/payout.ts
@@ -41,7 +41,9 @@ export function settle(cents: number, rate: number): number {
-  return Math.round(cents * rate);
+  // Banker's rounding: half-cents were accumulating a payable drift of
+  // ~$14/day across the fleet. Verified against the ledger fixtures.
+  return Math.round(cents * rate * 100) / 100;
 }

 export function settleAll(rows: PayoutRow[]): number {
diff --git a/src/payout.test.ts b/src/payout.test.ts
index 11aa0b2..c44d1f7 100644
--- a/src/payout.test.ts
+++ b/src/payout.test.ts
@@ -12,4 +12,12 @@ describe("settle", () => {
+  test("half-cent boundaries do not drift", () => {
+    expect(settle(1005, 0.031)).toBe(31.16);
+  });
`;

const DEMO_HANDOFF = {
  outcome: "built",
  committed: true,
  conclusion:
    "Fixed the payout rounding drift: settle() now rounds at cent precision instead of accumulating half-cent errors. Added boundary tests against the ledger fixtures. All 214 tests pass.",
  decisionsIncorporated: [],
};

/**
 * Seed a believable fleet mid-flight. The store MUST already carry the
 * demo stamp — this function refuses to seed an unfenced database, so no
 * caller can accidentally write synthetic history somewhere real.
 */
export function seedDemo(store: Store, repos: { api: string; web: string }, evidenceRoot: string, now: Date): DemoSeed {
  if (!store.isDemo()) {
    throw new Error("seedDemo refuses an unfenced database — stamp it demo first");
  }
  const password = `demo-${randomBytes(9).toString("base64url")}`;
  const added = addApprover(store, "demo", now, undefined, undefined, {}, password);
  if (!added.ok) throw new Error(`demo approver: ${added.reason}`);
  const token = password;

  const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

  const task = (id: string, title: string, repo: string, goal?: string): string => {
    const made = fileTaskProposal(
      store,
      { id, title, repo, ...(goal === undefined ? {} : { goal }), filedVia: "demo" },
      hoursAgo(30),
    );
    if (!made.ok) throw new Error(`seed task ${id}: ${made.reason}`);
    return made.id;
  };

  // --- needs-you: an approval waiting -----------------------------------
  task(
    "rotate-log-format",
    "Rotate the request-log format to JSON lines",
    repos.web,
    "Switch the request logger to JSON lines so the collector stops parsing free text. Keep the human console formatter for local dev. Migrate the two dashboards that grep the old format.",
  );

  // --- needs-you: a blocking decision -----------------------------------
  const asking = task(
    "choose-retry-policy",
    "Choose the webhook retry policy",
    repos.api,
    "Give outbound webhooks a bounded retry policy with dead-lettering.",
  );
  const askingRun = store.startRun({
    taskRef: store.refFor("built-in", asking).id,
    leaseId: "demo-lease-ask",
    runner: "night-shift-1",
    branch: `standing-orders/${asking}`,
    worktree: join(repos.api, ".demo-worktree"),
    now: hoursAgo(2),
  });
  store.saveDecision(
    {
      run: askingRun,
      urgency: "blocking",
      recap:
        "Retries currently hammer failing endpoints forever. The collector at partner X was down 40 minutes yesterday and we sent 8,400 attempts.",
      question: "How should webhook retries back off?",
      options: [
        {
          id: "exp",
          label: "Exponential, cap 1h, dead-letter after 24h",
          consequence: "Slowest to give up; partners see at most ~30 attempts/day.",
          reversible: true,
        },
        {
          id: "fixed",
          label: "Fixed 5-minute retries, dead-letter after 2h",
          consequence: "Faster surrender; brief outages on their side can drop events.",
          reversible: true,
        },
      ],
      recommendation: "exp",
    },
    hoursAgo(1),
  );

  // --- building now ------------------------------------------------------
  const building = task(
    "harden-webhook-retries",
    "Harden webhook delivery against slow consumers",
    repos.api,
    "Add per-endpoint concurrency caps and timeout budgets to webhook delivery.",
  );
  const proposedBuilding = propose(store, {
    taskId: building,
    goal: "Add per-endpoint concurrency caps and timeout budgets to webhook delivery.",
    outOfScope: "No changes to the public webhook payload shape.",
    touches: ["src/webhooks/"],
    now: hoursAgo(21),
  });
  approve(store, building, "demo", hoursAgo(20), proposedBuilding.digest, token);
  // The board's "building" lane keys off a live claim — take one through
  // the real claim machinery so the card wears worker and lease honestly.
  acquire(store, store.refFor("built-in", building).id, "night-shift-1", {
    now: hoursAgo(0.4),
    ttlMs: 4 * 3_600_000,
  });
  const liveRun = store.startRun({
    taskRef: store.refFor("built-in", building).id,
    leaseId: "demo-lease-live",
    runner: "night-shift-1",
    branch: `standing-orders/${building}`,
    worktree: join(repos.api, ".demo-worktree-2"),
    now: hoursAgo(0.4),
  });
  store.setRunPhase(liveRun, "agent-running");
  store.setTaskState(building, "running", hoursAgo(0.4));

  // --- done recently: a finished run with a reviewable terminal diff ----
  const done = task(
    "fix-payout-rounding",
    "Fix the payout rounding drift",
    repos.api,
    "Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.",
  );
  const doneProposed = propose(store, {
    taskId: done,
    goal: "Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.",
    outOfScope: "No ledger schema changes.",
    touches: ["src/payout.ts", "src/payout.test.ts"],
    now: hoursAgo(27),
  });
  approve(store, done, "demo", hoursAgo(26), doneProposed.digest, token);
  const doneRun = store.startRun({
    taskRef: store.refFor("built-in", done).id,
    leaseId: "demo-lease-done",
    runner: "night-shift-2",
    branch: `standing-orders/${done}`,
    worktree: join(repos.api, ".demo-worktree-3"),
    now: hoursAgo(9),
  });
  store.stampRun(doneRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(8.5),
  );
  const stat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "9e07b4152aa01c9f3d7700e54bf8d69288fbe777",
    fileCount: 2,
    additions: 13,
    deletions: 1,
    binaryCount: 0,
    files: [
      { path: "src/payout.ts", additions: 4, deletions: 1 },
      { path: "src/payout.test.ts", additions: 9, deletions: 0 },
    ],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(stat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(8.5),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "handoff",
    "handoff.json",
    Buffer.from(JSON.stringify(DEMO_HANDOFF, null, 2), "utf8"),
    "composed at completion [demo: synthetic]",
    hoursAgo(8.4),
  );
  store.finishRun(doneRun, { outcome: "built", committed: true, now: hoursAgo(8.4) });
  store.setTaskState(done, "done", hoursAgo(8.4));
  store.addRunNote(doneRun, "demo", "Reviewed the diff — the fixture numbers check out. Shipping.", hoursAgo(3));

  // --- attention: a failed attempt --------------------------------------
  const failed = task(
    "retire-legacy-flag",
    "Retire the legacy payout feature flag",
    repos.api,
    "Remove LEGACY_PAYOUT and every branch behind it.",
  );
  const failedProposed = propose(store, {
    taskId: failed,
    goal: "Remove LEGACY_PAYOUT and every branch behind it.",
    now: hoursAgo(16),
  });
  approve(store, failed, "demo", hoursAgo(15), failedProposed.digest, token);
  const failedRun = store.startRun({
    taskRef: store.refFor("built-in", failed).id,
    leaseId: "demo-lease-failed",
    runner: "night-shift-2",
    branch: `standing-orders/${failed}`,
    worktree: join(repos.api, ".demo-worktree-4"),
    now: hoursAgo(6),
  });
  store.finishRun(failedRun, {
    outcome: "failed",
    reason: "acceptance",
    now: hoursAgo(5.5),
  });
  store.setTaskState(failed, "failed", hoursAgo(5.5));

  // --- waiting: a dependency and a hold ----------------------------------
  task("design-tokens", "Extract the design tokens package", repos.web);
  task("ship-dark-mode", "Ship dark mode", repos.web);
  store.addEdge("ship-dark-mode", "design-tokens", {});
  const held = task("migrate-billing", "Migrate billing exports to the new vendor", repos.api);
  store.hold(store.refFor("built-in", held).id, "waiting on the vendor sandbox account", null, hoursAgo(12));

  // --- a standing order with a track record ------------------------------
  const routine = fileRoutineProposal(
    store,
    {
      name: "nightly-deps",
      repo: repos.api,
      goal: "Refresh the lockfile within existing ranges, run the suite, summarize anything notable.",
      outOfScope: "No major version bumps.",
      touches: [],
      requirements: [],
      schedule: "daily:03:30",
      costCeilingUsd: null,
      filedVia: "demo",
    },
    hoursAgo(70),
  );
  if (!routine.ok) throw new Error(`seed routine: ${routine.reason}`);
  approveRoutine(store, routine.id, "demo", hoursAgo(69), routine.digest, token);
  // Two nightly slots since approval: one fires, the second records its
  // single-flight skip honestly (the first instance is still open).
  fireRoutine(store, routine.id, hoursAgo(45));
  fireRoutine(store, routine.id, hoursAgo(21));

  // --- the outer loop: an opened PR with observed checks ----------------
  const pub = store.createPublicationIntent(
    {
      run: doneRun,
      taskRef: store.refFor("built-in", done).id,
      githubRepo: "acme/payments-api",
      remote: "origin",
      base: "main",
      head: `standing-orders/${done}`,
      headSha: "9e07b4152aa01c9f3d7700e54bf8d69288fbe777",
      bodyHash: "demo",
      draft: false,
    },
    hoursAgo(8.3),
  );
  store.markPublicationPushed(pub, hoursAgo(8.2));
  store.markPublicationOpened(pub, 47, "https://github.com/acme/payments-api/pull/47", hoursAgo(8.1));
  store.recordPublicationCheckState(pub, "passing", hoursAgo(1.5));

  return { login: { name: "demo", password }, repos: [repos.api, repos.web] };
}

/** Two tiny real repositories, so repo-bound surfaces have something true
 * to point at. git is optional here — a plain directory still demos. */
export function makeDemoRepos(root: string): { api: string; web: string } {
  const make = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(dir, file), content);
    }
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=demo@localhost", "-c", "user.name=demo", "commit", "-q", "-m", "seed"], {
        cwd: dir,
        stdio: "ignore",
      });
    } catch {
      // No git on PATH: a plain directory still serves the demo.
    }
    return dir;
  };
  return {
    api: make("payments-api", {
      "package.json": JSON.stringify({ name: "payments-api", private: true }, null, 2),
      "src/payout.ts": "export function settle(cents: number, rate: number): number {\n  return Math.round(cents * rate * 100) / 100;\n}\n",
    }),
    web: make("web-console", {
      "package.json": JSON.stringify({ name: "web-console", private: true }, null, 2),
      "src/app.ts": "export const app = () => 'hello';\n",
    }),
  };
}

/** The sandbox: one directory holding everything, stamped before seeding. */
export function createDemoSandbox(now: Date): {
  sandbox: string;
  store: Store;
  seed: DemoSeed;
  evidenceRoot: string;
  passwordFile: string;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "standing-orders-demo-"));
  const repos = makeDemoRepos(sandbox);
  const store = openStore(join(sandbox, "orders.db"));
  // The stamp precedes every row — a half-seeded sandbox is still fenced.
  store.recordInstallationFact("demo", "1", now);
  const evidenceRoot = join(sandbox, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const seed = seedDemo(store, repos, evidenceRoot, now);
  const passwordFile = join(sandbox, "demo-login.txt");
  writeFileSync(passwordFile, `name: ${seed.login.name}\npassword: ${seed.login.password}\n`, { mode: 0o600 });
  return { sandbox, store, seed, evidenceRoot, passwordFile };
}
