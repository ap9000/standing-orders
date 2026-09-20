import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type Store } from './store.js';
import { addApprover, approve, propose, proposeGuarded } from './scope.js';
import { CodingWorkspace } from './coding-workspace.js';
import type { CodingSession } from './coding-types.js';
import { codingHandoffPreview, createCodingHandoff, readCodingHandoff, verifyCodingHandoffBase, type CodingHandoffInput } from './coding-handoff.js';
import { register } from './runner.js';
import { acquire } from './claim.js';
import { WorktreePool } from './worktree.js';
import { build } from './builder.js';
import { run } from './exec.js';
import { learningSha } from './project-learning.js';
import { PREPARED_EVIDENCE_FILE, readPreparedEvidence, writePreparedEvidence } from './prepared-evidence.js';
import { proofFileName, readVerifiedArtifact } from './evidence.js';

const T0 = new Date('2026-09-19T12:00:00Z');
const OK = { code: 0, stdout: '', stderr: '', timedOut: false, notFound: false };
let root: string, repo: string, worktree: string, store: Store, db: DatabaseSync, session: CodingSession, token: string;
const sh = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (path: string, message: string) => { sh(path, 'add', '-A'); sh(path, 'commit', '-qm', message); return sh(path, 'rev-parse', 'HEAD'); };
const saveSession = () => db.prepare('UPDATE coding_session SET document=? WHERE id=?').run(JSON.stringify(session), session.id);
const input = (extra: Partial<CodingHandoffInput> = {}): CodingHandoffInput => ({ sessionId: session.id, repo, base: session.base,
  candidate: sh(worktree, 'rev-parse', 'HEAD'), title: 'Review clearer mobile labels', goal: 'Make mobile controls understandable.',
  acceptance: [{ id: 'c1', statement: 'Mobile controls use short descriptive labels.', evidence: ['check', 'changed-path'] }], actor: 'alex', ...extra });
const visual = [{ id: 'c1', statement: 'The saved controls are readable.', evidence: ['check', 'changed-path', 'screenshot'] }];
// Synthetic parser fixture only; this is not browser evidence of product behavior.
const imageHeader = () => { const bytes = Buffer.alloc(2048); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20); return bytes; };
const inventory = (screenshots: unknown = [{ path: 'screen.png', caption: 'Synthetic screenshot fixture' }], extra = {}) => writeFileSync(join(worktree, PREPARED_EVIDENCE_FILE), JSON.stringify({ version: 1, screenshots, ...extra }));

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-coding-handoff-'))); repo = join(root, 'repo'); worktree = join(root, 'coding-worktree'); mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.name', 'Test'); sh(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'app.txt'), 'Old labels\n'); const base = commit(repo, 'base');
  sh(repo, 'worktree', 'add', '-q', '-b', 'coding/sample', worktree, base);
  writeFileSync(join(worktree, 'app.txt'), 'Clear labels\n'); commit(worktree, 'Clear mobile labels');
  const file = join(root, 'orders.sqlite'); store = openStore(file);
  const account = addApprover(store, 'alex', T0); if (!account.ok) throw Error('fixture account'); token = account.token;
  for (const phase of ['build', 'plan', 'review'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'alex', T0);
  // Synthetic catalog fixture; no coding provider is launched.
  const workspace = new CodingWorkspace({ database: `${file}.coding.sqlite`, worktreeRoot: join(root, 'unused-worktrees') }); await workspace.close();
  db = new DatabaseSync(`${file}.coding.sqlite`);
  session = { id: 'a'.repeat(32), owner: 'alex', generation: 1, repo, base, branch: 'coding/sample', worktree,
    title: 'Clear mobile labels', provider: 'codex', model: null, nativeThreadId: 'native-thread', turnId: null, status: 'ready', error: null,
    createdAt: T0.toISOString(), updatedAt: T0.toISOString() };
  db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run(session.id, 'alex', 1, repo, JSON.stringify(session));
  db.prepare('INSERT INTO coding_item(session,id,payload) VALUES(?,?,?)').run(session.id, 'user-1', JSON.stringify({ id: 'user-1', type: 'userMessage', text: 'Please make the mobile labels easier to follow.', status: null }));
});
afterEach(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

test('captures the exact result and original request, creates an unapproved task and preserves the original Git base', () => {
  const tables = store.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  expect(codingHandoffPreview(store, { sessionId: session.id, actor: 'alex' })).toMatchObject({ base: session.base, candidate: input().candidate, changedPaths: ['app.txt'], originalPrompt: 'Please make the mobile labels easier to follow.' });
  const made = createCodingHandoff(store, input());
  expect(store.getScope(made.taskId)).toMatchObject({ candidate: input().candidate, digest: made.scopeDigest, approvedAt: null, approvedBy: null, approvedDigest: null, acceptance: [{ id: 'c1' }] });
  expect(store.lookupRef(made.taskId)?.plan).not.toBe('requested');
  expect(store.filedViaOf(made.taskId)).toBe(`coding:${made.receipt.id}`);
  expect(sh(repo, 'rev-parse', made.receipt.branch)).toBe(session.base);
  expect(sh(repo, 'rev-parse', 'main')).toBe(session.base);
  expect(sh(worktree, 'rev-parse', 'HEAD')).toBe(input().candidate);
  expect(store.handle.prepare('SELECT count(*) n FROM run').get()?.['n']).toBe(0);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tables);
  expect(readCodingHandoff(store, made.taskId)).toEqual(made);
  expect(() => db.exec("UPDATE coding_handoff SET payload='{}'")).toThrow(/immutable/);
  expect(() => db.exec('DELETE FROM coding_handoff_scope')).toThrow(/immutable/);
});

test('replays one handoff while newer work on main does not change its preserved base', () => {
  const args = input(), made = createCodingHandoff(store, args);
  writeFileSync(join(repo, 'other.txt'), 'Other project work\n'); const newer = commit(repo, 'Other work');
  expect(createCodingHandoff(store, args)).toEqual(made);
  expect(store.listTasks()).toHaveLength(1);
  expect(sh(repo, 'rev-parse', made.receipt.branch)).toBe(session.base);
  expect(sh(repo, 'rev-parse', 'main')).toBe(newer);
});

test('refuses active, unresolved, dirty, stale and foreign results before creating any review branch', () => {
  const args = input();
  expect(() => createCodingHandoff(store, { ...args, actor: 'stranger' })).toThrow(/account/);
  session.status = 'working'; saveSession(); expect(() => createCodingHandoff(store, args)).toThrow(/current coding action/);
  session.status = 'ready'; saveSession();
  db.prepare("INSERT INTO coding_submission VALUES(?,?,?,'uncertain',NULL)").run(session.id, 'send-1', 'digest');
  expect(() => createCodingHandoff(store, args)).toThrow(/uncertain delivery/); db.exec('DELETE FROM coding_submission');
  writeFileSync(join(worktree, 'new.txt'), 'Uncommitted\n'); expect(() => createCodingHandoff(store, args)).toThrow(/Commit the coding changes/); rmSync(join(worktree, 'new.txt'));
  expect(() => createCodingHandoff(store, { ...args, candidate: session.base })).toThrow(/result changed/);
  expect(() => createCodingHandoff(store, { ...args, acceptance: [] })).toThrow(/acceptance criterion/);
  expect(store.listTasks()).toEqual([]);
  expect(sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/standing-orders/')).toBe('');
  store.handle.exec("UPDATE approver SET generation=generation+1 WHERE name='alex'");
  expect(() => createCodingHandoff(store, args)).toThrow(/no longer matches/);
});

test('sidecar seal failure rolls back the task but keeps the receipt and reserved branch for an exact replay', () => {
  createCodingHandoff(store, input()); // initialize the receipt tables using the real path
  db.exec("CREATE TRIGGER test_seal_failure BEFORE INSERT ON coding_handoff_scope BEGIN SELECT RAISE(ABORT,'test seal failure'); END");
  const args = input({ title: 'Review mobile navigation', goal: 'Improve mobile navigation labels.' });
  expect(() => createCodingHandoff(store, args)).toThrow(/test seal failure/);
  const row = db.prepare('SELECT payload FROM coding_handoff ORDER BY rowid DESC LIMIT 1').get()!;
  const receipt = JSON.parse(String(row['payload']));
  expect(store.lookupRef(receipt.taskId)).toBeNull();
  expect(sh(repo, 'rev-parse', receipt.branch)).toBe(session.base);
  db.exec('DROP TRIGGER test_seal_failure');
  expect(createCodingHandoff(store, args).taskId).toBe(receipt.taskId);
  expect(store.listTasks()).toHaveLength(2);
});

test('a saved owner who loses installation authority cannot preview or file a coding review', () => {
  store.handle.prepare("UPDATE approver SET projects_json=? WHERE name='alex'").run(JSON.stringify([repo]));
  expect(() => codingHandoffPreview(store, { sessionId: session.id, actor: 'alex' })).toThrow(/installation operator/);
  expect(() => createCodingHandoff(store, input())).toThrow(/installation operator/);
  expect(store.listTasks()).toEqual([]);
  expect(sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/standing-orders/')).toBe('');
});

test('a moved reserved branch is never reset or adopted on retry', () => {
  createCodingHandoff(store, input());
  db.exec("CREATE TRIGGER test_seal_failure BEFORE INSERT ON coding_handoff_scope BEGIN SELECT RAISE(ABORT,'test seal failure'); END");
  const args = input({ goal: 'Check the final mobile labels.' });
  expect(() => createCodingHandoff(store, args)).toThrow();
  const receipt = JSON.parse(String(db.prepare('SELECT payload FROM coding_handoff ORDER BY rowid DESC LIMIT 1').get()!['payload']));
  sh(repo, 'update-ref', `refs/heads/${receipt.branch}`, args.candidate, session.base);
  db.exec('DROP TRIGGER test_seal_failure');
  expect(() => createCodingHandoff(store, args)).toThrow(/reserved review branch changed/);
  expect(sh(repo, 'rev-parse', receipt.branch)).toBe(args.candidate);
  expect(store.lookupRef(receipt.taskId)).toBeNull();
});

test('a coding marker cannot fall back when its receipt, seal or scope is changed', () => {
  const made = createCodingHandoff(store, input()), ref = store.lookupRef(made.taskId)!;
  expect(readCodingHandoff(store, 'ordinary-task')).toBeNull();
  db.exec('DROP TRIGGER coding_handoff_scope_no_update'); db.exec("UPDATE coding_handoff_scope SET sha='wrong'");
  expect(() => readCodingHandoff(store, made.taskId)).toThrow(/receipt is missing/);
  const seal = db.prepare('SELECT payload FROM coding_handoff_scope').get()!;
  db.prepare('UPDATE coding_handoff_scope SET sha=?').run(learningSha(String(seal['payload'])));
  const saved = proposeGuarded(store, { taskId: made.taskId, taskRef: ref.id, sawDigest: made.scopeDigest, goal: 'Changed review outcome.', acceptance: input().acceptance, candidate: made.receipt.candidate, now: T0 });
  expect(saved.ok).toBe(true);
  expect(() => readCodingHandoff(store, made.taskId)).toThrow(/scope changed/);
  db.exec('DROP TRIGGER coding_handoff_scope_no_delete'); db.exec('DELETE FROM coding_handoff_scope');
  db.exec('DROP TRIGGER coding_handoff_no_delete'); db.exec('DELETE FROM coding_handoff');
  expect(() => readCodingHandoff(store, made.taskId)).toThrow(/receipt is missing/);
});

async function dispatchFixture(made: { taskId: string; scopeDigest: string; receipt: { branch: string } }) {
  const ref = store.lookupRef(made.taskId)!;
  expect(approve(store, made.taskId, 'alex', T0, made.scopeDigest, token).ok).toBe(true);
  register(store, { name: 'runner', host: 'test', capacity: 1, repos: [repo], now: T0, newToken: () => 'runner-token' });
  const claim = acquire(store, ref.id, 'runner', { token: 'runner-token', now: T0, ttlMs: 3600_000, newLeaseId: () => 'lease' });
  if (!claim.ok) throw Error('fixture claim');
  const pool = new WorktreePool(store, { root: join(root, 'review-worktrees') });
  const leased = await pool.lease({ repo, branch: made.receipt.branch, runner: 'runner', taskRef: ref.id, now: T0 });
  if (!leased.ok) throw Error(leased.message);
  const route = store.routeAuthorityFor(ref.id, 'builder'); if (!route?.ok) throw Error('fixture route');
  const runId = store.startRun({ taskRef: ref.id, leaseId: 'lease', runner: 'runner', branch: made.receipt.branch, worktree: leased.worktree.path, now: T0, route: route.stamp });
  return { ref, runId, path: leased.worktree.path, request: { taskId: made.taskId, taskRef: ref.id, runner: 'runner', runnerToken: 'runner-token', leaseId: 'lease', runId,
    worktree: leased.worktree.path, branch: made.receipt.branch, evidenceRoot: join(root, 'evidence'), now: T0, clock: () => T0, git: run } };
}

test.each(['before setup', 'during setup'])('builder rejects a changed original base %s without stamping it or running an agent', async when => {
  const made = createCodingHandoff(store, input()), fixture = await dispatchFixture(made);
  expect(sh(fixture.path, 'rev-parse', 'HEAD')).toBe(session.base); // existing branch defeats a newer tick default
  const move = () => sh(repo, 'update-ref', `refs/heads/${made.receipt.branch}`, made.receipt.candidate, session.base);
  if (when === 'before setup') move();
  store.setWorktreeSetup({ repo, command: 'test-only-setup', timeoutMs: 5000, approvedBy: 'alex' }, T0);
  const setup = vi.fn(async () => { if (when === 'during setup') move(); return OK; });
  const agent = vi.fn(async () => OK);
  const result = await build(store, { ...fixture.request, setup, agent });
  expect(result).toMatchObject({ ok: false, reason: 'no-op', message: expect.stringContaining('original commit') });
  expect(setup).toHaveBeenCalledTimes(when === 'before setup' ? 0 : 1);
  expect(agent).not.toHaveBeenCalled();
  expect(store.getRun(fixture.runId)?.baseRevision).toBeNull();
  expect(sh(repo, 'rev-parse', made.receipt.branch)).toBe(made.receipt.candidate);
});

test('retries retain the first recorded base while later attempt HEADs may advance', async () => {
  const made = createCodingHandoff(store, input()), fixture = await dispatchFixture(made);
  const check = () => verifyCodingHandoffBase(store, { taskId: made.taskId, taskRef: fixture.ref.id, repo, branch: made.receipt.branch, head: made.receipt.candidate });
  expect(check).toThrow(/original commit/);
  store.stampRun(fixture.runId, { baseRevision: session.base });
  expect(check).not.toThrow();
  store.handle.prepare('UPDATE run SET base_revision=? WHERE id=?').run(made.receipt.candidate, fixture.runId);
  expect(check).toThrow(/original commit/);
});

test('prepared screenshots use the worker receipt and existing capture with one final gate and no agent claims', async () => {
  const bytes = imageHeader(); writeFileSync(join(worktree, 'screen.png'), bytes); inventory(); commit(worktree, 'Synthetic visual inventory');
  const made = createCodingHandoff(store, input({ acceptance: visual }));
  writeFileSync(join(repo, 'other.txt'), 'New work on main\n'); const newerMain = commit(repo, 'Later main');
  const fixture = await dispatchFixture(made);
  writeFileSync(join(fixture.path, 'STANDING-ORDERS-PROOF-1234567890123456.json'), JSON.stringify({ version: 1, checks: [{ command: 'stale-check', exitCode: 0, summary: 'claimed pass' }] }));
  store.setVerifyCommand({ repo, command: 'test-only-final-check', timeoutMs: 5000, approvedBy: 'alex' }, T0);
  const agent = vi.fn(async () => OK), verify = vi.fn(async () => ({ ...OK, stdout: 'The prepared labels pass their check.' }));
  expect(await build(store, { ...fixture.request, agent, verify })).toMatchObject({ ok: true, committed: true });
  expect(agent).not.toHaveBeenCalled(); expect(verify).toHaveBeenCalledTimes(1);
  expect(store.getRun(fixture.runId)?.baseRevision).toBe(session.base);
  expect(sh(fixture.path, 'rev-parse', 'HEAD^{tree}')).toBe(sh(repo, 'rev-parse', `${made.receipt.candidate}^{tree}`));
  expect(sh(repo, 'rev-parse', 'main')).toBe(newerMain);
  expect(store.proofVerdictFor(fixture.runId)).toMatchObject({ verdict: 'short', machineVerdict: 'verified' });
  expect(store.proofVerdictFor(fixture.runId)?.reasons.join(' ')).toContain('independent goal assessment');
  const artifacts = store.artifactsFor(fixture.runId);
  const proof = readVerifiedArtifact(join(root, 'evidence'), artifacts.find(artifact => artifact.kind === 'proof')!);
  expect(proof.ok).toBe(true);
  if (proof.ok) expect(JSON.parse(proof.content.toString('utf8'))).toEqual({ version: 1, criteria: [], checks: [], changed: [], caveats: [], screenshots: [{ path: 'screen.png', caption: 'Synthetic screenshot fixture' }] });
  const image = readVerifiedArtifact(join(root, 'evidence'), artifacts.find(artifact => artifact.kind === 'screenshot')!);
  expect(image.ok).toBe(true); if (image.ok) expect(image.content).toEqual(bytes);
  expect(store.proofVerdictFor(fixture.runId)?.matrix[0]?.assessment?.evidenceState).toBe('pass');
});

test('visual handoff asks for committed screenshots before creating a task or branch', () => {
  writeFileSync(join(worktree, 'screen.png'), imageHeader()); commit(worktree, 'Unlisted synthetic image');
  expect(() => createCodingHandoff(store, input({ acceptance: visual }))).toThrow(/Ask Codex to prepare review screenshots and commit them/);
  expect(store.listTasks()).toHaveLength(0);
  expect(sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/standing-orders/')).toBe('');
  inventory(); commit(worktree, 'List screenshot');
  const made = createCodingHandoff(store, input({ acceptance: visual }));
  expect(store.getScope(made.taskId)?.approvedAt).toBeNull();
  expect(createCodingHandoff(store, input({ acceptance: visual }))).toEqual(made);
});

test('committed inventory refuses claims, stale protocol paths, unsafe paths, missing images and linked blobs', () => {
  writeFileSync(join(worktree, 'screen.png'), imageHeader());
  inventory(undefined, { checks: [{ command: 'pretend check', exitCode: 0 }] });
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Claimed check'), true)).toThrow(/only version 1/);
  inventory([{ path: '../screen.png', caption: 'Outside' }]);
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Unsafe path'), true)).toThrow(/repository-relative/);
  inventory([{ path: 'STANDING-ORDERS-PROOF-1234567890123456.json', caption: 'Old receipt' }]);
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Old receipt path'), true)).toThrow(/prior attempt/);
  inventory([{ path: 'uncommitted.png', caption: 'Missing at this commit' }]); const candidate = commit(worktree, 'Missing image');
  writeFileSync(join(worktree, 'uncommitted.png'), imageHeader());
  expect(() => readPreparedEvidence(repo, candidate, true)).toThrow(/not committed in this result/);
  rmSync(join(worktree, 'uncommitted.png')); symlinkSync('screen.png', join(worktree, 'linked.png'));
  inventory([{ path: 'linked.png', caption: 'Linked image' }]);
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Linked image'), true)).toThrow(/regular file/);
  inventory(); writeFileSync(join(worktree, 'screen.png'), 'not an image');
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Invalid image'), true)).toThrow(/PNG or JPEG/);
  writeFileSync(join(worktree, 'screen.png'), imageHeader().subarray(0, 26));
  expect(() => readPreparedEvidence(repo, commit(worktree, 'Placeholder image'), true)).toThrow(/at least 1024 bytes/);
});

test('the worker refuses substituted checkout bytes before writing its fresh receipt', () => {
  writeFileSync(join(worktree, 'screen.png'), imageHeader()); inventory();
  const saved = readPreparedEvidence(repo, commit(worktree, 'Saved inventory'), true)!;
  const nonce = proofFileName();
  writeFileSync(join(worktree, 'screen.png'), Buffer.alloc(2048, 1));
  expect(() => writePreparedEvidence(worktree, nonce, saved)).toThrow(/no longer matches/);
  expect(existsSync(join(worktree, nonce))).toBe(false);
});

test('ordinary prepared visual tasks refuse missing screenshots before setup or the full gate', async () => {
  store.createTask({ id: 'prepared-visual', title: 'Review saved result' }, T0);
  store.placeTask(store.refFor('built-in', 'prepared-visual').id, repo);
  propose(store, { taskId: 'prepared-visual', goal: 'Review saved controls', candidate: input().candidate, acceptance: visual, now: T0 });
  sh(repo, 'branch', 'standing-orders/prepared-visual', session.base);
  const fixture = await dispatchFixture({ taskId: 'prepared-visual', scopeDigest: store.getScope('prepared-visual')!.digest, receipt: { branch: 'standing-orders/prepared-visual' } });
  store.setWorktreeSetup({ repo, command: 'test-only-setup', timeoutMs: 5000, approvedBy: 'alex' }, T0);
  store.setVerifyCommand({ repo, command: 'test-only-gate', timeoutMs: 5000, approvedBy: 'alex' }, T0);
  const setup = vi.fn(async () => OK), verify = vi.fn(async () => OK), agent = vi.fn(async () => OK);
  expect(await build(store, { ...fixture.request, setup, verify, agent })).toMatchObject({ ok: false, reason: 'no-op', message: expect.stringContaining('Ask Codex to prepare review screenshots') });
  expect(setup).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(agent).not.toHaveBeenCalled();
  expect(store.getRun(fixture.runId)?.baseRevision).toBeNull();
});
