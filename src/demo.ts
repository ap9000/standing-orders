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
import { addApprover, propose, approve, type AcceptanceCriterion } from "./scope.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { approveRoutine, fireRoutine } from "./routine.js";
import { fileTaskProposal, fileRoutineProposal } from "./proposal.js";
import { storeEvidence, budgetedStatJson, imageDimensions, type DiffStat } from "./evidence.js";
import { parseProof, adjudicate } from "./proof.js";
import { maybeTriggerRepair } from "./dispose.js";
import { deflateSync } from "node:zlib";

// The demo demonstrates a CONFIGURED install: routing is named once, the
// way `config set build` would, so approvals bind it like production.
const DEMO_PROFILE = {
  provider: "claude" as const,
  model: "sonnet",
  permissionArgv: "auto" as const,
  maxTurns: 1_000, repairMaxTurns: 4, timeoutSeconds: 1_200, timeoutKind: "idle" as const, repairTimeoutSeconds: 300,
  repairModel: "inherit",
};

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
  schema: 1,
  outcome: "built",
  committed: true,
  conclusion:
    "Fixed the payout rounding drift: settle() now rounds at cent precision instead of accumulating half-cent errors. Added boundary tests against the ledger fixtures. All 214 tests pass.",
  changes: [
    "Rounded settlement values at cent precision in src/payout.ts.",
    "Added ledger-fixture coverage for half-cent boundaries.",
  ],
  verification: ["All 214 tests pass, including the new rounding boundary cases."],
  followUps: [],
  decisionsIncorporated: [],
};

/** The evidence bundle's own manifest (Acceptance Contract v2 demo): the
 * seeded sandbox answers its OWN signed rubric by exact id, with typed
 * evidence references — the same shape a real builder writes — so a
 * fresh install sees the finished feature end to end, not a stub. */
const DEMO_PROOF = {
  version: 1 as const,
  criteria: [
    {
      id: "c1",
      statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.",
      verdict: "met" as const,
      how: "Added and ran boundary tests against the ledger fixtures.",
      evidence: [
        { kind: "check" as const, ref: "npm test" },
        { kind: "changed-path" as const, ref: "src/payout.ts" },
        { kind: "changed-path" as const, ref: "src/payout.test.ts" },
      ],
    },
    {
      id: "c2",
      statement: "The human console formatter still renders payout dashboards.",
      verdict: "met" as const,
      how: "Ran the dashboard's own snapshot tests.",
      evidence: [{ kind: "screenshot" as const, ref: "evidence/payout-dashboard.png" }],
    },
  ],
  checks: [{ command: "npm test", exitCode: 0, summary: "214 tests passed, including the new rounding boundary cases." }],
  changed: ["src/payout.ts", "src/payout.test.ts"],
  caveats: [],
  screenshots: [{ path: "evidence/payout-dashboard.png", caption: "Payout dashboard after the fix — totals match the ledger." }],
};

const DEMO_COPY_PATCH = `diff --git a/src/inbox-copy.ts b/src/inbox-copy.ts
index a1b2c3d..d4e5f6a 100644
--- a/src/inbox-copy.ts
+++ b/src/inbox-copy.ts
@@ -8,5 +8,7 @@ export const EMPTY_STATE = {
-  body: "Nothing here.",
+  body: "Nothing needs you right now — approvals, decisions, and proofs waiting on a human all land in this list.",
 };
+
+export const EMPTY_STATE_ILLUSTRATION = "quiet-inbox";
`;

const DEMO_COPY_HANDOFF = {
  schema: 1,
  outcome: "built",
  committed: true,
  conclusion: "Rewrote the inbox's empty-state copy so it explains why the list is empty instead of just saying so.",
  changes: ["Replaced the empty-state body copy in src/inbox-copy.ts."],
  verification: ["Opened the inbox pane with zero items and read the new copy."],
  followUps: [],
  decisionsIncorporated: [],
};

/** A criterion whose only required evidence is `manual-review` (Acceptance
 * Contract v2, review finding): no check, no screenshot, nothing a machine
 * can resolve on its own — a human has to read the copy and say it is
 * good. The seeded verdict below is computed by the REAL adjudicate(),
 * so the sandbox proves the fix live: this build reads "needs
 * verification", never "verified" or "attested", until an operator uses
 * the same "accept anyway" act a short/refuted proof already offers. */
const DEMO_COPY_PROOF = {
  version: 1 as const,
  criteria: [
    {
      id: "c1",
      statement: "An operator confirms the new empty-state copy reads clearly.",
      verdict: "met" as const,
      how: "Opened the inbox pane with zero items and read the new copy aloud.",
      evidence: [{ kind: "manual-review" as const, ref: "read the new copy in src/inbox-copy.ts" }],
    },
  ],
  checks: [],
  changed: ["src/inbox-copy.ts"],
  caveats: [],
  screenshots: [],
};

const DEMO_EXECUTION_PLAN = [
  "## Approach",
  "Move the request logger to structured JSON lines at the existing boundary, then update only the dashboards that still parse the legacy text format.",
  "## Milestones",
  "1. Trace the logger and the two dashboard consumers.",
  "2. Add the JSON-line formatter without changing local human-readable output.",
  "3. Migrate both dashboard parsers and cover the compatibility boundary.",
  "## Dependencies",
  "- The collector accepts one JSON object per line.",
  "- Local development keeps the existing console formatter.",
  "## Risks",
  "- A partial rollout could mix formats; keep parsing compatibility at the collector boundary during the change.",
  "- Dashboard field names could drift; lock them with fixture-based checks.",
  "## Proof",
  "- c1 — run the logger and dashboard fixture checks and review the rendered JSON lines.",
  "",
].join("\n");

/**
 * A minimal, real, uncompressed-per-scanline PNG encoder — no image
 * library, just IHDR + one zlib-deflated IDAT + IEND. Used only to give
 * the demo's screenshot evidence REAL, non-placeholder dimensions and
 * byte size (Acceptance Contract v2: a screenshot criterion needs a real
 * file of at least 320×200 and meaningful bytes to verify) without
 * shipping a binary asset for a run nobody actually captured.
 */
function encodeDemoPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  // A faint vertical gradient so the file is not one repeated byte —
  // "meaningful", not merely large.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    const shade = Math.round((y / Math.max(1, height - 1)) * 40);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = Math.min(255, rgb[0] + shade);
      raw[p + 1] = Math.min(255, rgb[1] + shade);
      raw[p + 2] = Math.min(255, rgb[2] + shade);
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A real 640×400 PNG — comfortably past the 320×200 / meaningful-byte-size
 * floor a screenshot criterion needs to verify. */
const DEMO_SCREENSHOT_PNG = encodeDemoPng(640, 400, [16, 24, 32]);

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

  // Configure the install before filing any task, exactly as a normal first
  // run does. Every seeded scope can then be approved from the demo instead
  // of inheriting an artificial "model not set" blocker.
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "demo", now);

  // The demo's builder goes through the REAL claim machinery, and the claim
  // primitive proves identity and repo binding in-transaction — so the demo
  // runner is registered like a real one, bound to both demo repos.
  const nightShift = register(store, {
    name: "night-shift-1",
    host: "demo",
    capacity: 2,
    repos: [repos.api, repos.web],
    now: hoursAgo(30),
  });

  const genericAcceptance: AcceptanceCriterion[] = [
    { id: "c1", statement: "The described change is made and verified.", how: null, evidence: ["manual-review"] },
  ];
  const task = (id: string, title: string, repo: string, goal?: string, acceptance: AcceptanceCriterion[] = genericAcceptance): string => {
    const made = fileTaskProposal(
      store,
      { id, title, repo, ...(goal === undefined ? {} : { goal, acceptance }), filedVia: "demo" },
      hoursAgo(30),
    );
    if (!made.ok) throw new Error(`seed task ${id}: ${made.reason}`);
    return made.id;
  };

  // --- needs-you: an approval waiting -----------------------------------
  const planned = task(
    "rotate-log-format",
    "Rotate the request-log format to JSON lines",
    repos.web,
    "Switch the request logger to JSON lines so the collector stops parsing free text. Keep the human console formatter for local dev. Migrate the two dashboards that grep the old format.",
  );
  const plannedRef = store.refFor("built-in", planned).id;
  store.setPlanState(plannedRef, "drafted");
  const plannerRun = store.startRun({
    taskRef: plannedRef,
    leaseId: "demo-lease-plan",
    runner: "night-shift-1",
    role: "planner",
    branch: `standing-orders-plan/${planned}`,
    worktree: join(repos.web, ".demo-worktree-plan"),
    now: hoursAgo(3),
  });
  storeEvidence(
    store,
    evidenceRoot,
    plannerRun,
    "plan",
    "plan.md",
    Buffer.from(DEMO_EXECUTION_PLAN, "utf8"),
    "planner handoff (verified tree) [demo: synthetic]",
    hoursAgo(2.8),
  );
  store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: hoursAgo(2.8) });

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
    profile: DEMO_PROFILE,
    taskId: building,
    goal: "Add per-endpoint concurrency caps and timeout budgets to webhook delivery.",
    outOfScope: "No changes to the public webhook payload shape.",
    touches: ["src/webhooks/"],
    acceptance: [
      { id: "c1", statement: "Slow consumers cannot starve other endpoints' delivery.", how: "Load-test one slow and one healthy endpoint together.", evidence: ["check"] },
    ],
    now: hoursAgo(21),
  });
  approve(store, building, "demo", hoursAgo(20), proposedBuilding.digest, token);
  // The board's "building" lane keys off a live claim — take one through
  // the real claim machinery so the card wears worker and lease honestly.
  acquire(store, store.refFor("built-in", building).id, "night-shift-1", {
    now: hoursAgo(0.4),
    token: nightShift.token,
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
    profile: DEMO_PROFILE,
    taskId: done,
    goal: "Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.",
    outOfScope: "No ledger schema changes.",
    touches: ["src/payout.ts", "src/payout.test.ts"],
    acceptance: [
      { id: "c1", statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.", how: null, evidence: ["check", "changed-path"] },
      { id: "c2", statement: "The human console formatter still renders payout dashboards.", how: null, evidence: ["screenshot"] },
    ],
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
  // The evidence bundle (Priority 2): a validated proof, its claimed
  // screenshot stored as immutable image evidence, the plane's own re-run
  // check, and the closed verdict — computed once, exactly as the real
  // builder would leave it, so a fresh install sees the finished feature.
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(8.4),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "screenshot",
    "screenshot-demo.png",
    DEMO_SCREENSHOT_PNG,
    "agent-claimed screenshot at evidence/payout-dashboard.png (validated png) [demo: synthetic]",
    hoursAgo(8.4),
  );
  storeEvidence(
    store,
    evidenceRoot,
    doneRun,
    "check-log",
    "check-log.txt",
    Buffer.from(`$ npm test\n(exit 0)\n\n--- stdout ---\n214 tests passed.\n\n--- stderr ---\n`, "utf8"),
    `sh -c "npm test" (exit 0) [demo: synthetic]`,
    hoursAgo(8.4),
  );
  // The verdict AND the criterion-to-evidence matrix are computed by the
  // real adjudicate() — same function, same rules the builder runs —
  // never hand-authored, so the seeded sandbox shows exactly what the
  // feature actually renders, dimensions read from the real PNG above.
  const demoProofParse = parseProof(JSON.stringify(DEMO_PROOF));
  const demoPngDims = imageDimensions(DEMO_SCREENSHOT_PNG, "png");
  const demoAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: demoProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
    screenshots: [{ path: "evidence/payout-dashboard.png", ok: true, bytes: DEMO_SCREENSHOT_PNG.length, dims: demoPngDims }],
    approvedCriteria: doneProposed.acceptance,
  });
  store.saveProofVerdict(doneRun, demoAdjudicated.verdict, demoAdjudicated.reasons, hoursAgo(8.4), demoAdjudicated.matrix);
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
    profile: DEMO_PROFILE,
    taskId: failed,
    goal: "Remove LEGACY_PAYOUT and every branch behind it.",
    acceptance: [
      { id: "c1", statement: "No reference to LEGACY_PAYOUT remains in the codebase.", how: null, evidence: ["changed-path"] },
    ],
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

  // --- attention: needs verification (manual-review, unaccepted) --------
  // Acceptance Contract v2's own review finding, made visible: a signed
  // rubric can require a human's eyes ("manual-review" evidence), and
  // that alone must cap the build below verified/attested until an
  // operator explicitly accepts it — the SAME "accept anyway" act a
  // short/refuted proof already uses, never a new mechanism.
  const copyReview = task(
    "confirm-empty-state-copy",
    "Confirm the new inbox empty-state copy reads well",
    repos.web,
    "Rewrite the inbox's empty-state copy so it explains why nothing is there yet.",
  );
  const copyReviewProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: copyReview,
    goal: "Rewrite the inbox's empty-state copy so it explains why nothing is there yet.",
    acceptance: [
      {
        id: "c1",
        statement: "An operator confirms the new empty-state copy reads clearly.",
        how: "Open the inbox pane with zero items and read it.",
        evidence: ["manual-review"],
      },
    ],
    now: hoursAgo(10),
  });
  approve(store, copyReview, "demo", hoursAgo(9), copyReviewProposed.digest, token);
  const copyReviewRun = store.startRun({
    taskRef: store.refFor("built-in", copyReview).id,
    leaseId: "demo-lease-copy",
    runner: "night-shift-1",
    branch: `standing-orders/${copyReview}`,
    worktree: join(repos.web, ".demo-worktree-5"),
    now: hoursAgo(4),
  });
  store.stampRun(copyReviewRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_COPY_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(3.6),
  );
  const copyStat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "1c2d3e4f52aa01c9f3d7700e54bf8d69288fbe999",
    fileCount: 1,
    additions: 3,
    deletions: 1,
    binaryCount: 0,
    files: [{ path: "src/inbox-copy.ts", additions: 3, deletions: 1 }],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(copyStat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(3.6),
  );
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "handoff",
    "handoff.json",
    Buffer.from(JSON.stringify(DEMO_COPY_HANDOFF, null, 2), "utf8"),
    "composed at completion [demo: synthetic]",
    hoursAgo(3.5),
  );
  storeEvidence(
    store,
    evidenceRoot,
    copyReviewRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_COPY_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(3.5),
  );
  const copyReviewProofParse = parseProof(JSON.stringify(DEMO_COPY_PROOF));
  const copyReviewAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: copyReviewProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(copyStat.files.map(one => one.path)) },
    verifyCommand: { configured: false },
    screenshots: [],
    approvedCriteria: copyReviewProposed.acceptance,
  });
  store.saveProofVerdict(copyReviewRun, copyReviewAdjudicated.verdict, copyReviewAdjudicated.reasons, hoursAgo(3.5), copyReviewAdjudicated.matrix);
  store.finishRun(copyReviewRun, { outcome: "built", committed: true, now: hoursAgo(3.5) });
  store.setTaskState(copyReview, "done", hoursAgo(3.5));

  // --- reviewed + repaired: an independent reviewer contradicts a signed
  // criterion, and the bounded repair loop drafts one unapproved fix
  // (evidence-review-v1) — every step through the REAL functions the tick
  // itself runs: adjudicate(), addReviewerComments/ingestCriterionReviews
  // (the same fold reviewPass performs), and maybeTriggerRepair. Nothing
  // here hand-authors a verdict or a chain row.
  const reviewed = task(
    "guard-payout-limiter",
    "Guard the payout limiter against concurrent settlement",
    repos.api,
    "Add a per-account concurrency guard so two settlements never race the same payout limiter.",
  );
  const reviewedProposed = propose(store, {
    profile: DEMO_PROFILE,
    taskId: reviewed,
    goal: "Add a per-account concurrency guard so two settlements never race the same payout limiter.",
    outOfScope: "No changes to the limiter's public API.",
    touches: ["src/payout-limiter.ts"],
    acceptance: [
      {
        id: "c1",
        statement: "Two concurrent settlements for the same account cannot both pass the limiter.",
        how: "Read the guard; an independent reviewer confirms it actually locks.",
        evidence: ["manual-review"],
      },
      { id: "c2", statement: "The existing limiter tests still pass.", how: null, evidence: ["check"] },
    ],
    now: hoursAgo(6),
  });
  approve(store, reviewed, "demo", hoursAgo(5.8), reviewedProposed.digest, token);
  const reviewedRun = store.startRun({
    taskRef: store.refFor("built-in", reviewed).id,
    leaseId: "demo-lease-reviewed",
    runner: "night-shift-1",
    branch: `standing-orders/${reviewed}`,
    worktree: join(repos.api, ".demo-worktree-4"),
    now: hoursAgo(5),
  });
  store.stampRun(reviewedRun, { baseRevision: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  const DEMO_REPAIR_PATCH = `diff --git a/src/payout-limiter.ts b/src/payout-limiter.ts
--- a/src/payout-limiter.ts
+++ b/src/payout-limiter.ts
@@ -1,3 +1,4 @@
+// TODO: lock per account
 export function settleWithLimiter(accountId: string, cents: number): number {
   return settle(cents, currentRate(accountId));
 }
`;
  const reviewedDiffArtifact = storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "terminal-diff",
    "terminal-diff.patch",
    Buffer.from(DEMO_REPAIR_PATCH, "utf8"),
    "git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [demo: synthetic]",
    hoursAgo(4.6),
  );
  const reviewedStat: DiffStat = {
    schema: 1,
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "aa11bb22cc33dd44ee55ff6600112233445566aa",
    fileCount: 1,
    additions: 1,
    deletions: 0,
    binaryCount: 0,
    files: [{ path: "src/payout-limiter.ts", additions: 1, deletions: 0 }],
    filesTruncated: false,
  };
  storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "diff-stat",
    "diff-stat.json",
    budgetedStatJson(reviewedStat),
    "parsed from git diff --numstat -z [demo: synthetic]",
    hoursAgo(4.6),
  );
  const DEMO_REPAIR_HANDOFF = {
    summary: "Added a TODO comment marking the per-account lock — ran out of turns before wiring the actual guard.",
    filesTouched: ["src/payout-limiter.ts"],
  };
  storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "handoff",
    "handoff.json",
    Buffer.from(JSON.stringify(DEMO_REPAIR_HANDOFF, null, 2), "utf8"),
    "composed at completion [demo: synthetic]",
    hoursAgo(4.5),
  );
  const DEMO_REPAIR_PROOF = {
    version: 1,
    criteria: [
      {
        id: "c1",
        statement: "Two concurrent settlements for the same account cannot both pass the limiter.",
        verdict: "met",
        how: "Added the lock.",
        evidence: [{ kind: "manual-review", ref: "see src/payout-limiter.ts" }],
      },
      { id: "c2", statement: "The existing limiter tests still pass.", verdict: "met", how: "npm test", evidence: [{ kind: "check", ref: "npm test" }] },
    ],
    checks: [{ command: "npm test", exitCode: 0, summary: "214 tests passed." }],
    changed: ["src/payout-limiter.ts"],
    caveats: [],
    screenshots: [],
  };
  const reviewedProofArtifact = storeEvidence(
    store,
    evidenceRoot,
    reviewedRun,
    "proof",
    "proof.json",
    Buffer.from(JSON.stringify(DEMO_REPAIR_PROOF, null, 2), "utf8"),
    "agent-authored proof (validated, re-serialized) [demo: synthetic]",
    hoursAgo(4.5),
  );
  // The verdict, computed by the real adjudicate() — the proof's OWN
  // self-declared "met" reads clean until the independent reviewer looks.
  const reviewedProofParse = parseProof(JSON.stringify(DEMO_REPAIR_PROOF));
  const reviewedAdjudicated = adjudicate({
    proofArtifactPresent: true,
    proofParse: reviewedProofParse,
    handoffPresent: true,
    terminalDiffPresent: true,
    terminalDiffCaptureStatus: "ok",
    diffStat: { captured: true, truncated: false, paths: new Set(reviewedStat.files.map(one => one.path)) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
    screenshots: [],
    approvedCriteria: reviewedProposed.acceptance,
  });
  store.saveProofVerdict(reviewedRun, reviewedAdjudicated.verdict, reviewedAdjudicated.reasons, hoursAgo(4.4), reviewedAdjudicated.matrix);
  store.finishRun(reviewedRun, { outcome: "built", committed: true, now: hoursAgo(4.4) });
  store.setTaskState(reviewed, "done", hoursAgo(4.4));

  // The independent reviewer: a real reviewer run, its comments AND its
  // criterion judgement ingested through the SAME atomic store method
  // reviewPass itself calls (ingestReview) — the fold is the real
  // foldReview, never a hand-authored verdict, and the bindings are the
  // real scope digest and proof artifact this run actually carries.
  const reviewerRun = store.startRun({
    taskRef: store.refFor("built-in", reviewed).id,
    leaseId: "demo-lease-reviewer",
    runner: "night-shift-1",
    role: "reviewer",
    parentRun: reviewedRun,
    provider: "codex",
    now: hoursAgo(3.9),
  });
  const reviewedProofSha = store.getArtifact(reviewedProofArtifact)?.sha256 ?? null;
  const { folded } = store.ingestReview(
    {
      reviewerRunId: reviewerRun,
      runId: reviewedRun,
      artifactId: reviewedDiffArtifact,
      author: "reviewer:codex",
      comments: [
        {
          path: "src/payout-limiter.ts",
          line: 1,
          note: "This is a TODO, not a lock — two concurrent calls both still read the same rate before either settles.",
          severity: "problem",
        },
      ],
      judgements: [
        {
          id: "c1",
          judgement: "contradicts",
          note: "The diff adds a TODO comment, not an actual lock — two concurrent settlements still race the limiter.",
        },
      ],
      bindings: {
        scopeDigest: reviewedProposed.digest,
        headSha: store.getRun(reviewedRun)?.headRevision ?? store.getRun(reviewedRun)?.baseRevision ?? null,
        proof: reviewedProofSha === null ? null : { artifactId: reviewedProofArtifact, sha256: reviewedProofSha },
        checkLog: null,
        screenshots: [],
      },
    },
    hoursAgo(3.9),
  );
  if (folded === null) throw new Error("seed reviewed+repaired: the fold produced nothing");
  store.finishRun(reviewerRun, { outcome: "no-change", reason: `reviewed — 1 comment(s), 1 judgement(s) (${"review-contradicted"})`, now: hoursAgo(3.9) });

  // The bounded repair loop's own trigger — the SAME function the tick
  // calls after a review pass settles a verdict. No mode is signed, so
  // the draft it composes waits unapproved, exactly as the default road
  // promises.
  const repairTrigger = maybeTriggerRepair(store, repos.api, evidenceRoot, reviewedRun, folded.verdict, hoursAgo(3.9));
  if (repairTrigger.kind !== "drafted") {
    throw new Error(`seed reviewed+repaired: expected a draft, got ${repairTrigger.kind}`);
  }

  // --- waiting: a repairable terminal dependency and a hold ---------------
  task("design-tokens", "Extract the design tokens package", repos.web);
  task("ship-dark-mode", "Ship dark mode", repos.web);
  store.addEdge("ship-dark-mode", "design-tokens", {});
  store.cancelTask("design-tokens", hoursAgo(10), "the token package was superseded");
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
      acceptance: [
        { id: "c1", statement: "The full test suite passes against the refreshed lockfile.", how: null, evidence: ["check"] },
      ],
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
