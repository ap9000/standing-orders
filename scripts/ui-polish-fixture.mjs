/** Isolated UI-polish fixture (2026-09-13). One in-memory database, one
 * throwaway git repository, an ephemeral approver, and a scripted
 * subscription chat runner. No live database, worker, key, or model call.
 *
 * States it seeds, honestly labeled as synthetic:
 *   - `ledger-export`: a long unapproved scope (goal, exclusions, eight
 *     paths, six criteria) — the approval ceremony on /t and in chat.
 *   - `payout-rounding`: a finished build with a sealed diff, handoff,
 *     proof, screenshot, and machine verdict — result, annotate, revision.
 *   - chat: the mint card before a conversation; a scripted runner that
 *     answers "pause" with a hold card, "tighter" with a scope-revision
 *     card, and "slowly" after a delay (the reply-in-progress state).
 *
 * Build first (`npm run build`), then `node scripts/ui-polish-fixture.mjs`
 * prints one JSON line with the URL and login. `scripts/ui-polish-proof.mjs`
 * imports `startFixture` directly. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openStore } from '../dist/store.js';
import { addApprover, approve } from '../dist/scope.js';
import { fileTaskProposal } from '../dist/proposal.js';
import { legOf, routeDigestOf } from '../dist/phase-routing.js';
import { storeEvidence, budgetedStatJson, imageDimensions } from '../dist/evidence.js';
import { parseProof, adjudicate } from '../dist/proof.js';
import { createDecisionServer } from '../dist/serve.js';

const LONG_GOAL =
  'Rework the portfolio ledger export so an operator can download one CSV per project that reconciles with the settlement ledger to the cent. ' +
  'Replace the ad-hoc string concatenation in src/export/csv.ts with a streaming writer that escapes quotes, commas and newlines per RFC 4180, ' +
  'emits a UTF-8 BOM only when the operator asks for Excel compatibility, and never buffers more than one thousand rows in memory. ' +
  'Add a date-range filter that is inclusive on both ends in the project timezone, and a per-currency subtotal row at the foot of each file. ' +
  'The export button on the project page must show progress for files over ten thousand rows and must stay keyboard reachable while the download prepares. ' +
  'Keep the existing JSON export untouched and keep every current column name so downstream spreadsheets keep working.';
const LONG_NOT =
  'No changes to the settlement engine, the ledger schema, or the nightly reconciliation job. No new export formats beyond CSV. ' +
  'Do not add a background queue or a new dependency for streaming; the standard library stream is enough. Do not touch authentication or project admission.';
const TOUCHES = [
  'src/export/csv.ts', 'src/export/csv.test.ts', 'src/export/range.ts', 'src/export/range.test.ts',
  'src/ui/project-export.ts', 'src/ui/project-export.test.ts', 'docs/exports.md', 'fixtures/ledger-sample.csv',
];
const ACCEPTANCE = [
  { id: 'c1', statement: 'Each exported CSV reconciles with the settlement ledger to the cent for the fixture projects.', how: null, evidence: ['check'] },
  { id: 'c2', statement: 'Fields containing quotes, commas or newlines round-trip through a standard CSV parser unchanged.', how: null, evidence: ['check', 'changed-path'] },
  { id: 'c3', statement: 'The date-range filter is inclusive on both ends in the project timezone, proven at a DST boundary.', how: null, evidence: ['check'] },
  { id: 'c4', statement: 'A per-currency subtotal row appears at the foot of every file and sums the rows above it.', how: null, evidence: ['check'] },
  { id: 'c5', statement: 'The export control shows progress for large files and stays reachable by keyboard while preparing.', how: null, evidence: ['screenshot', 'check'] },
  { id: 'c6', statement: 'Existing column names and the JSON export are unchanged.', how: null, evidence: ['check', 'changed-path'] },
];

const PATCH = `diff --git a/src/payout.ts b/src/payout.ts
index 3f1c2aa..9e07b41 100644
--- a/src/payout.ts
+++ b/src/payout.ts
@@ -41,7 +41,9 @@ export function settle(cents: number, rate: number): number {
-  return Math.round(cents * rate);
+  // Round at cent precision: half-cents were accumulating a payable drift
+  // of roughly $14 a day across the fleet. Verified against the fixtures.
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
const HANDOFF = {
  schema: 1, outcome: 'built', committed: true,
  conclusion: 'Fixed the payout rounding drift: settle() now rounds at cent precision instead of accumulating half-cent errors. Added boundary tests against the ledger fixtures. All 214 tests pass.',
  changes: ['Rounded settlement values at cent precision in src/payout.ts.', 'Added ledger-fixture coverage for half-cent boundaries.'],
  verification: ['All 214 tests pass, including the new rounding boundary cases.'],
  followUps: [], decisionsIncorporated: [],
};
const PROOF = {
  version: 1,
  criteria: [
    { id: 'c1', statement: 'Ledger-fixture tests demonstrate the half-cent drift is gone.', verdict: 'met', how: 'Added and ran boundary tests against the ledger fixtures.',
      evidence: [{ kind: 'check', ref: 'npm test' }, { kind: 'changed-path', ref: 'src/payout.ts' }, { kind: 'changed-path', ref: 'src/payout.test.ts' }] },
    { id: 'c2', statement: 'The console formatter still renders payout dashboards.', verdict: 'met', how: 'Captured the dashboard after the change.',
      evidence: [{ kind: 'screenshot', ref: 'evidence/payout-dashboard.png' }] },
  ],
  checks: [{ command: 'npm test', exitCode: 0, summary: '214 tests passed' }],
  changed: ['src/payout.ts', 'src/payout.test.ts'],
  caveats: [],
  screenshots: [{ path: 'evidence/payout-dashboard.png', caption: 'Payout dashboard after the rounding fix (fixture image)' }],
};

/** A real RGB PNG with a faint gradient — past the 320×200 floor. */
function encodePng(width, height, rgb) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  const crc32 = buf => { let c = -1; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3; const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1); raw[row] = 0; const shade = Math.round((y / Math.max(1, height - 1)) * 40);
    for (let x = 0; x < width; x++) { const p = row + 1 + x * 3; raw[p] = Math.min(255, rgb[0] + shade); raw[p + 1] = Math.min(255, rgb[1] + shade); raw[p + 2] = Math.min(255, rgb[2] + shade); }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function startFixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standing-orders-ui-polish-')));
  const repo = join(root, 'portfolio-console');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'portfolio-console', private: true }, null, 2));
  writeFileSync(join(repo, 'src', 'payout.ts'), 'export function settle(cents: number, rate: number): number {\n  return Math.round(cents * rate * 100) / 100;\n}\n');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=fixture@localhost', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'seed'], { cwd: repo, stdio: 'ignore' });
  } catch { /* a plain directory still serves the fixture */ }
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true });

  const store = openStore(':memory:');
  const now = options.now ?? new Date();
  const hoursAgo = hours => new Date(now.getTime() - hours * 3_600_000);
  const login = addApprover(store, 'polish-fixture', now);
  if (!login.ok) throw new Error('fixture login failed');
  store.setChatConfig({ provider: 'codex-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'polish-fixture', now);
  for (const phase of ['plan', 'build', 'review']) store.setPhaseConfig('installation', phase, 'codex', 'default', 'fixture', now);

  // --- the long unapproved scope ------------------------------------------
  const long = fileTaskProposal(store, {
    id: 'ledger-export', title: 'Rework the portfolio ledger export', repo,
    goal: LONG_GOAL, outOfScope: LONG_NOT, touches: TOUCHES, acceptance: ACCEPTANCE, filedVia: 'console', planning: 'skip',
  }, hoursAgo(2));
  if (!long.ok) throw new Error(`fixture long task: ${long.reason}`);

  // --- the finished build with a sealed result ------------------------------
  const done = fileTaskProposal(store, {
    id: 'payout-rounding', title: 'Fix the payout rounding drift', repo,
    goal: 'Find and fix the half-cent drift in payout settlement; prove it with ledger-fixture tests.',
    outOfScope: 'No ledger schema changes.', touches: ['src/payout.ts', 'src/payout.test.ts'],
    acceptance: [
      { id: 'c1', statement: 'Ledger-fixture tests demonstrate the half-cent drift is gone.', how: null, evidence: ['check', 'changed-path'] },
      { id: 'c2', statement: 'The console formatter still renders payout dashboards.', how: null, evidence: ['screenshot'] },
    ],
    filedVia: 'console', planning: 'skip',
  }, hoursAgo(27));
  if (!done.ok) throw new Error(`fixture done task: ${done.reason}`);
  const doneScope = store.getScope('payout-rounding');
  approve(store, 'payout-rounding', 'polish-fixture', hoursAgo(26), doneScope.digest, login.token);
  const doneRoute = store.approvedRouteOf('payout-rounding');
  const run = store.startRun({
    taskRef: store.refFor('built-in', 'payout-rounding').id, leaseId: 'fixture-lease-done', runner: 'night-shift-2',
    branch: 'standing-orders/payout-rounding', worktree: join(repo, '.fixture-worktree'), now: hoursAgo(9),
    provider: 'codex', model: 'default',
    ...(doneRoute === null ? {} : { route: { routeDigest: routeDigestOf(doneRoute), phase: 'build', provider: legOf(doneRoute, 'build').provider, model: legOf(doneRoute, 'build').model, chosen: legOf(doneRoute, 'build').chosen } }),
  });
  store.stampRun(run, { baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', scopeDigest: doneScope.digest });
  const stat = {
    schema: 1, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', head: '9e07b4152aa01c9f3d7700e54bf8d69288fbe777',
    fileCount: 2, additions: 13, deletions: 1, binaryCount: 0,
    files: [{ path: 'src/payout.ts', additions: 4, deletions: 1 }, { path: 'src/payout.test.ts', additions: 9, deletions: 0 }], filesTruncated: false,
  };
  const png = encodePng(640, 400, [16, 24, 32]);
  storeEvidence(store, evidenceRoot, run, 'terminal-diff', 'terminal-diff.patch', Buffer.from(PATCH, 'utf8'), 'git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [fixture: synthetic]', hoursAgo(8.5));
  storeEvidence(store, evidenceRoot, run, 'diff-stat', 'diff-stat.json', budgetedStatJson(stat), 'parsed from git diff --numstat -z [fixture: synthetic]', hoursAgo(8.5));
  storeEvidence(store, evidenceRoot, run, 'handoff', 'handoff.json', Buffer.from(JSON.stringify(HANDOFF, null, 2), 'utf8'), 'composed at completion [fixture: synthetic]', hoursAgo(8.4));
  storeEvidence(store, evidenceRoot, run, 'proof', 'proof.json', Buffer.from(JSON.stringify(PROOF, null, 2), 'utf8'), 'agent-authored proof (validated) [fixture: synthetic]', hoursAgo(8.4));
  storeEvidence(store, evidenceRoot, run, 'screenshot', 'screenshot-fixture.png', png, 'agent-claimed screenshot at evidence/payout-dashboard.png (validated png) [fixture: synthetic]', hoursAgo(8.4));
  storeEvidence(store, evidenceRoot, run, 'check-log', 'check-log.txt', Buffer.from('$ npm test\n(exit 0)\n\n--- stdout ---\n214 tests passed.\n\n--- stderr ---\n', 'utf8'), 'sh -c "npm test" (exit 0) [fixture: synthetic]', hoursAgo(8.4));
  const adjudicated = adjudicate({
    proofArtifactPresent: true, proofParse: parseProof(JSON.stringify(PROOF)), handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: 'ok',
    diffStat: { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) },
    verifyCommand: { configured: true, ran: true, exitCode: 0 },
    screenshots: [{ path: 'evidence/payout-dashboard.png', ok: true, bytes: png.length, dims: imageDimensions(png, 'png') }],
    approvedCriteria: doneScope.acceptance,
  });
  store.saveProofVerdict(run, adjudicated.verdict, adjudicated.reasons, hoursAgo(8.4), adjudicated.matrix);
  store.finishRun(run, { outcome: 'built', committed: true, now: hoursAgo(8.4) });
  store.setTaskState('payout-rounding', 'done', hoursAgo(8.4));

  // --- the scripted conversation ------------------------------------------
  const runner = async request => {
    // The operator's latest message is the last operator turn in history;
    // a tool result step (after a proposal call) answers with plain text.
    const last = [...request.history].reverse().find(one => one.role === 'operator' || one.role === 'tool');
    if (last?.role === 'tool') return { ok: true, answer: { text: 'Confirm the card below when you are ready; nothing changes until you do.', calls: [], tokensIn: 40, tokensOut: 20, reportedCostMicrousd: null } };
    const text = String(last?.text ?? '').toLowerCase();
    if (text.includes('slowly')) await new Promise(resolve => setTimeout(resolve, options.slowMs ?? 20_000));
    if (text.includes('pause')) {
      return { ok: true, answer: { text: 'I’ll pause **Rework the portfolio ledger export** so nothing starts before you review it. Confirm the card below.', calls: [{ id: 'hold-1', name: 'propose_hold', args: { task: 'ledger-export', reason: 'Review the export scope before the first attempt.' } }], tokensIn: 120, tokensOut: 30, reportedCostMicrousd: null } };
    }
    if (text.includes('tighter') || text.includes('revise')) {
      return { ok: true, answer: { text: 'Here is a tighter scope for **Rework the portfolio ledger export**: the CSV writer and range filter only, with the progress control deferred. Confirm it, then approve it with your password on the task.', calls: [{ id: 'scope-1', name: 'propose_scope', args: { task: 'ledger-export', goal: 'Replace the ad-hoc CSV writer with a streaming RFC 4180 writer and add an inclusive date-range filter. Keep every current column name.', not: 'No progress control this time; no settlement, schema or reconciliation changes.', touches: ['src/export/csv.ts', 'src/export/csv.test.ts', 'src/export/range.ts', 'src/export/range.test.ts'], acceptance: [{ id: 'c1', statement: 'Quoted, comma and newline fields round-trip through a standard CSV parser.', evidence: ['check'] }, { id: 'c2', statement: 'The date range is inclusive on both ends in the project timezone.', evidence: ['check'] }] } }], tokensIn: 140, tokensOut: 60, reportedCostMicrousd: null } };
    }
    return { ok: true, answer: { text: 'One task is waiting for your approval (**Rework the portfolio ledger export**) and one finished with verified evidence (**Fix the payout rounding drift**). Nothing is building right now.', calls: [], tokensIn: 100, tokensOut: 40, reportedCostMicrousd: null } };
  };
  const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, subscriptionChatRunner: runner });
  const stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => { store.close(); rmSync(root, { recursive: true, force: true }); resolve(); }); });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, name: 'polish-fixture', password: login.token, runId: run, tasks: { long: 'ledger-export', done: 'payout-rounding' }, stop, store });
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fixture = await startFixture();
  console.log(JSON.stringify({ fixture: true, url: `${fixture.url}/chat`, name: fixture.name, password: fixture.password, runId: fixture.runId, tasks: fixture.tasks }));
  const stop = () => fixture.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
