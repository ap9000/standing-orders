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
 *   - workspace package 1 (2026-09-13): one task per status the Work
 *     views and the shared status projection must tell apart — queued
 *     without a builder, waiting on another task, on hold, paused by a
 *     stop, running under a live claim, failed, cancelled, and finished
 *     builds whose proof was verified, agent-attested, missing, refuted
 *     by a failed check, refuted by mismatched evidence, accepted with an
 *     exception, or published as a PR / observed merged. With
 *     `{ secondProject: true }` the last two live in a second repository
 *     under a long path, so All-projects rows carry project labels and
 *     the phone task list has a raw path to wrap.
 *   - review fixes (2026-09-13): three verified results whose independent
 *     review is queued, running under a live reviewer, or failed with a
 *     retry left — through the store's own request/admit doors, so every
 *     surface projects the same review facts.
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
import { register } from '../dist/runner.js';
import { acquire, release } from '../dist/claim.js';

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

function seedRepo(path, name) {
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, private: true }, null, 2));
  writeFileSync(join(path, 'src', 'payout.ts'), 'export function settle(cents: number, rate: number): number {\n  return Math.round(cents * rate * 100) / 100;\n}\n');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: path, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=fixture@localhost', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'seed'], { cwd: path, stdio: 'ignore' });
  } catch { /* a plain directory still serves the fixture */ }
}

export function startFixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standing-orders-ui-polish-')));
  const repo = join(root, 'portfolio-console');
  seedRepo(repo, 'portfolio-console');
  // The second project (workspace package 1): a deliberately long path so
  // a phone task list has something to wrap, and so All-projects rows
  // span two projects and must wear their labels.
  const repo2 = options.secondProject === true
    ? join(root, 'clients', 'northwind-operations', 'ops-console-with-a-very-long-repository-name-for-overflow-checks')
    : null;
  if (repo2 !== null) seedRepo(repo2, 'ops-console');
  // An enrolled project with no tasks at all, for the empty Work views.
  const repo3 = options.secondProject === true ? join(root, 'clients', 'empty-sandbox') : null;
  if (repo3 !== null) seedRepo(repo3, 'empty-sandbox');
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
  storeEvidence(store, evidenceRoot, run, 'terminal-diff', 'terminal-diff.patch', Buffer.from(PATCH, 'utf8'), 'git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [fixture: synthetic]', hoursAgo(8.5), { captureStatus: 'ok' });
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

  // --- workspace package 1: one task per status ------------------------------
  // Every result below reuses the payout diff, handoff, and proof bytes;
  // only the adjudication facts differ, exactly as the plane records them.
  const finished = (id, title, at, facts) => {
    const where = facts.repo ?? repo;
    const filed = fileTaskProposal(store, {
      id, title, repo: where,
      goal: facts.goal ?? `Fix ${title.toLowerCase()} and prove it with the ledger fixtures.`,
      outOfScope: 'No ledger schema changes.', touches: ['src/payout.ts', 'src/payout.test.ts'],
      acceptance: [
        { id: 'c1', statement: 'Ledger-fixture tests demonstrate the half-cent drift is gone.', how: null, evidence: ['check', 'changed-path'] },
        { id: 'c2', statement: 'The console formatter still renders payout dashboards.', how: null, evidence: ['screenshot'] },
      ],
      filedVia: 'console', planning: 'skip',
    }, hoursAgo(at + 2));
    if (!filed.ok) throw new Error(`fixture ${id}: ${filed.reason}`);
    const scope = store.getScope(id);
    approve(store, id, 'polish-fixture', hoursAgo(at + 1.5), scope.digest, login.token);
    const route = store.approvedRouteOf(id);
    const ref = store.refFor('built-in', id).id;
    const runId = store.startRun({
      taskRef: ref, leaseId: `fixture-lease-${id}`, runner: 'night-shift-2',
      branch: `standing-orders/${id}`, worktree: join(where, `.fixture-worktree-${id}`), now: hoursAgo(at + 1),
      provider: 'codex', model: 'default',
      ...(route === null ? {} : { route: { routeDigest: routeDigestOf(route), phase: 'build', provider: legOf(route, 'build').provider, model: legOf(route, 'build').model, chosen: legOf(route, 'build').chosen } }),
    });
    store.stampRun(runId, { baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', scopeDigest: scope.digest });
    const proof = facts.overclaim === true ? { ...PROOF, changed: [...PROOF.changed, 'src/ledger.ts'] } : PROOF;
    // The capture status is the plane's own (exit 0): a review request
    // reads it before it spends the run's bounded review allowance.
    storeEvidence(store, evidenceRoot, runId, 'terminal-diff', 'terminal-diff.patch', Buffer.from(PATCH, 'utf8'), 'git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [fixture: synthetic]', hoursAgo(at + 0.2), { captureStatus: 'ok' });
    storeEvidence(store, evidenceRoot, runId, 'diff-stat', 'diff-stat.json', budgetedStatJson(stat), 'parsed from git diff --numstat -z [fixture: synthetic]', hoursAgo(at + 0.2));
    storeEvidence(store, evidenceRoot, runId, 'handoff', 'handoff.json', Buffer.from(JSON.stringify(HANDOFF, null, 2), 'utf8'), 'composed at completion [fixture: synthetic]', hoursAgo(at + 0.1));
    if (facts.noProof !== true) {
      storeEvidence(store, evidenceRoot, runId, 'proof', 'proof.json', Buffer.from(JSON.stringify(proof, null, 2), 'utf8'), 'agent-authored proof (validated) [fixture: synthetic]', hoursAgo(at + 0.1));
      storeEvidence(store, evidenceRoot, runId, 'screenshot', 'screenshot-fixture.png', png, 'agent-claimed screenshot at evidence/payout-dashboard.png (validated png) [fixture: synthetic]', hoursAgo(at + 0.1));
    }
    const verify = facts.verify ?? { configured: true, ran: true, exitCode: 0 };
    if (verify.configured && verify.ran) {
      storeEvidence(store, evidenceRoot, runId, 'check-log', 'check-log.txt', Buffer.from(`$ npm test\n(exit ${verify.exitCode})\n\n--- stdout ---\n${verify.exitCode === 0 ? '214 tests passed.' : '213 passed, 1 failed: settle rounds half-cents up (expected 31.16, got 31.15).'}\n\n--- stderr ---\n`, 'utf8'), `sh -c "npm test" (exit ${verify.exitCode}) [fixture: synthetic]`, hoursAgo(at + 0.1));
    }
    const verdict = adjudicate({
      proofArtifactPresent: facts.noProof !== true, proofParse: facts.noProof === true ? null : parseProof(JSON.stringify(proof)),
      handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: 'ok',
      diffStat: { captured: true, truncated: false, paths: new Set(stat.files.map(one => one.path)) },
      verifyCommand: verify,
      screenshots: facts.noProof === true ? [] : [{ path: 'evidence/payout-dashboard.png', ok: true, bytes: png.length, dims: imageDimensions(png, 'png') }],
      approvedCriteria: scope.acceptance,
    });
    store.saveProofVerdict(runId, verdict.verdict, verdict.reasons, hoursAgo(at), verdict.matrix);
    store.finishRun(runId, { outcome: 'built', committed: true, now: hoursAgo(at) });
    store.setTaskState(id, 'done', hoursAgo(at));
    if (facts.accept !== undefined) store.acceptProof(runId, 'polish-fixture', facts.accept, hoursAgo(at - 0.1));
    if (facts.publication !== undefined) {
      const publicationId = store.createPublicationIntent({
        run: runId, taskRef: ref, githubRepo: 'northwind/ops-console', remote: 'origin', base: 'main', head: `standing-orders/${id}`,
        headSha: '9e07b4152aa01c9f3d7700e54bf8d69288fbe777', bodyHash: 'fixture', draft: false,
      }, hoursAgo(at - 0.05));
      store.markPublicationPushed(publicationId, hoursAgo(at - 0.06));
      store.markPublicationOpened(publicationId, facts.publication.pr, `https://github.com/northwind/ops-console/pull/${facts.publication.pr}`, hoursAgo(at - 0.07));
      if (facts.publication.checks) store.recordPublicationCheckState(publicationId, facts.publication.checks, hoursAgo(at - 0.08));
      if (facts.publication.remote) store.recordPublicationRemoteState(publicationId, facts.publication.remote, hoursAgo(at - 0.09));
    }
    return { taskId: id, runId, ref };
  };
  const queued = (id, title, at, facts = {}) => {
    const where = facts.repo ?? repo;
    const filed = fileTaskProposal(store, {
      id, title, repo: where,
      goal: facts.goal ?? `${title}. Keep every current column name so downstream spreadsheets keep working.`,
      outOfScope: 'No settlement engine changes.', touches: ['src/export/csv.ts', 'src/export/csv.test.ts'],
      acceptance: [{ id: 'c1', statement: 'The exported CSV parses with a standard CSV reader.', how: null, evidence: ['check'] }],
      filedVia: 'console', planning: 'skip',
    }, hoursAgo(at));
    if (!filed.ok) throw new Error(`fixture ${id}: ${filed.reason}`);
    const scope = store.getScope(id);
    if (facts.approve !== false) approve(store, id, 'polish-fixture', hoursAgo(at - 0.1), scope.digest, login.token);
    return { taskId: id, ref: store.refFor('built-in', id).id, scope: store.getScope(id) };
  };
  const results = {};
  results.failedChecks = finished('csv-quoting', 'Escape quotes in the CSV writer', 6, { verify: { configured: true, ran: true, exitCode: 1 } });
  results.mismatched = finished('range-filter', 'Make the date-range filter inclusive', 7, { overclaim: true });
  results.missingProof = finished('subtotal-rows', 'Add per-currency subtotal rows', 8, { noProof: true });
  results.attested = finished('excel-bom', 'Emit a UTF-8 BOM for Excel exports', 9, { verify: { configured: false } });
  results.accepted = finished('export-button', 'Keep the export button keyboard reachable', 10, { noProof: true, accept: 'Checked the export button by hand on two browsers; the proof file was lost when the worktree was cleaned.' });
  results.published = finished('settlement-rounding', 'Round settlement totals at cent precision', 11, { repo: repo2 ?? repo, publication: { pr: 482, checks: 'passing' } });
  results.merged = finished('timezone-boundaries', 'Handle DST boundaries in the range filter', 12, { repo: repo2 ?? repo, publication: { pr: 479, checks: 'passing', remote: 'MERGED' } });

  // Queued without a builder: approved, and no runner covers the project.
  const waitingForBuilder = queued('csv-streaming', 'Stream the CSV writer instead of buffering rows', 1.5);
  // Waiting on another task: approved, but chained behind the writer.
  const chained = queued('csv-progress', 'Show export progress for large files', 1.4);
  store.addEdge(chained.taskId, waitingForBuilder.taskId);
  // On hold by the operator.
  const held = queued('csv-docs', 'Document the export columns', 1.3);
  store.hold(held.ref, 'Wait for the column names to settle before documenting them.', null, hoursAgo(1.2));
  // Failed after its last attempt, and cancelled cleanup work.
  const failed = queued('csv-benchmark', 'Benchmark the export against ten thousand rows', 1.1);
  store.setTaskState(failed.taskId, 'failed', hoursAgo(1));
  const cancelled = queued('csv-cleanup', 'Remove the legacy string-concatenation exporter', 0.9, { approve: false });
  store.cancelTask(cancelled.taskId, hoursAgo(0.8), 'Superseded by the streaming writer.');

  // A builder that answers, so one task can run live and another can be
  // paused by an operator stop: register, claim, start.
  register(store, { name: 'night-shift-1', host: 'fixture-host', capacity: 2, repos: [repo, ...(repo2 === null ? [] : [repo2])], now: hoursAgo(0.5), newToken: () => 'fixture-runner-token' });
  const liveRoute = (id, phase) => {
    const route = store.approvedRouteOf(id);
    return route === null ? {} : { route: { routeDigest: routeDigestOf(route), phase, provider: legOf(route, phase).provider, model: legOf(route, phase).model, chosen: legOf(route, phase).chosen } };
  };
  const running = queued('csv-range-tests', 'Prove the date range at a DST boundary', 0.7);
  const claim = acquire(store, running.ref, 'night-shift-1', { token: 'fixture-runner-token', now: hoursAgo(0.4), ttlMs: 6 * 3_600_000 });
  if (!claim.ok) throw new Error(`fixture live claim: ${claim.reason}`);
  const liveRun = store.startRun({
    taskRef: running.ref, leaseId: claim.claim.leaseId, runner: 'night-shift-1', branch: 'standing-orders/csv-range-tests',
    worktree: join(repo, '.fixture-worktree-live'), now: hoursAgo(0.4), provider: 'codex', model: 'default', ...liveRoute(running.taskId, 'build'),
  });
  store.setTaskState(running.taskId, 'running', hoursAgo(0.4));
  const paused = queued('csv-parser-matrix', 'Round-trip the CSV through three parsers', 0.6);
  const pausedClaim = acquire(store, paused.ref, 'night-shift-1', { token: 'fixture-runner-token', now: hoursAgo(0.35), ttlMs: 6 * 3_600_000 });
  if (!pausedClaim.ok) throw new Error(`fixture paused claim: ${pausedClaim.reason}`);
  const pausedRun = store.startRun({
    taskRef: paused.ref, leaseId: pausedClaim.claim.leaseId, runner: 'night-shift-1', branch: 'standing-orders/csv-parser-matrix',
    worktree: join(repo, '.fixture-worktree-paused'), now: hoursAgo(0.35), provider: 'codex', model: 'default', ...liveRoute(paused.taskId, 'build'),
  });
  const stopped = store.requestRunStop({ runId: pausedRun, taskRef: paused.ref, by: 'polish-fixture', via: 'web' }, hoursAgo(0.3));
  if (!stopped.ok) throw new Error(`fixture stop: ${stopped.reason}`);
  store.finishRun(pausedRun, { outcome: 'interrupted', reason: 'stopped', now: hoursAgo(0.29), stopSettlement: 'interrupted' });
  release(store, pausedClaim.claim.leaseId, hoursAgo(0.28));
  store.setTaskState(paused.taskId, 'queued', hoursAgo(0.28));
  // --- review fixes: a review queued, running, and failed ------------------
  // A reviewer worker that answers, covering only the empty project so no
  // builder-coverage status above changes; its heartbeat sits an hour
  // ahead so it stays alive for the whole proof run (fixture only).
  register(store, { name: 'reviewer-1', host: 'fixture-host', capacity: 1, repos: [repo3 ?? repo], now: new Date(now.getTime() + 3_600_000), newToken: () => 'fixture-reviewer-token' });
  const reviewed = (id, title, at, settle) => {
    const built = finished(id, title, at, {});
    const asked = store.requestReview(built.runId, 'polish-fixture', hoursAgo(at - 0.1));
    if (!asked.ok) throw new Error(`fixture review request ${id}: ${asked.reason}`);
    const reviewer = settle === 'queued' ? null : store.admitReview(asked.id, { runner: 'reviewer-1', token: 'fixture-reviewer-token', provider: 'codex', model: 'default' }, hoursAgo(at - 0.2));
    if (reviewer !== null && !reviewer.ok) throw new Error(`fixture review admission ${id}: ${reviewer.reason}`);
    if (settle === 'failed' && reviewer !== null) {
      store.finishRun(reviewer.reviewerRunId, { outcome: 'failed', reason: 'reviewer-agent', now: hoursAgo(at - 0.3) });
      store.stampReviewRequestOutcome(asked.id, 'reviewer-agent');
    }
    return { ...built, reviewerRunId: reviewer?.reviewerRunId ?? null };
  };
  results.pendingReview = reviewed('csv-header-row', 'Add a header row to the CSV export', 13, 'queued');
  results.reviewing = reviewed('csv-null-cells', 'Render empty cells as empty strings', 14, 'running');
  results.reviewFailed = reviewed('csv-large-file', 'Stream files over ten thousand rows', 15, 'failed');

  const statusTasks = {
    failedChecks: results.failedChecks.taskId, mismatched: results.mismatched.taskId, missingProof: results.missingProof.taskId,
    attested: results.attested.taskId, accepted: results.accepted.taskId, published: results.published.taskId, merged: results.merged.taskId,
    waitingForBuilder: waitingForBuilder.taskId, chained: chained.taskId, held: held.taskId, failed: failed.taskId, cancelled: cancelled.taskId,
    running: running.taskId, paused: paused.taskId,
    pendingReview: results.pendingReview.taskId, reviewing: results.reviewing.taskId, reviewFailed: results.reviewFailed.taskId,
  };
  const statusRuns = {
    failedChecks: results.failedChecks.runId, mismatched: results.mismatched.runId, missingProof: results.missingProof.runId, attested: results.attested.runId, accepted: results.accepted.runId, published: results.published.runId, merged: results.merged.runId, running: liveRun, paused: pausedRun,
    pendingReview: results.pendingReview.runId, reviewing: results.reviewing.runId, reviewFailed: results.reviewFailed.runId,
  };

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
  const server = createDecisionServer({ store, evidenceRoot, ...(repo2 === null ? { repo } : { repos: [repo, repo2, repo3] }), chatEnv: {}, subscriptionChatRunner: runner });
  const stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => { store.close(); rmSync(root, { recursive: true, force: true }); resolve(); }); });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, name: 'polish-fixture', password: login.token, runId: run, tasks: { long: 'ledger-export', done: 'payout-rounding' }, statusTasks, statusRuns, repos: { main: repo, second: repo2, empty: repo3 }, stop, store });
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fixture = await startFixture();
  console.log(JSON.stringify({ fixture: true, url: `${fixture.url}/chat`, name: fixture.name, password: fixture.password, runId: fixture.runId, tasks: fixture.tasks }));
  const stop = () => fixture.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
