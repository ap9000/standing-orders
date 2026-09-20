import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.js';
import { CodingWorkspace } from './coding-workspace.js';
import { installUpdateGate } from './desktop-update-gate.js';
import { loadCodingDeploymentRuntime, observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped } from '../scripts/deploy-coding.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'so-browser-coding-update-'));
  const database = join(root, 'orders.db'), stage = join(root, 'stage');
  mkdirSync(stage);
  const store = openStore(database);
  const record: { id: string; codingBackupPath?: string; codingBackupHash?: string; codingCatalogExpected?: boolean } = { id: randomUUID() };
  return { root, database, stage, store, record, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('browser deployment permits a legacy runtime only while its coding catalog is absent', async () => {
  const f = fixture();
  try {
    expect(await loadCodingDeploymentRuntime(f.root)).toBeNull();
    await backupCodingDeployment(null, f.database, f.stage, f.record);
    verifyCodingDeploymentBackup(null, f.database, f.stage, f.record);
    assertCodingDeploymentStopped(null, f.database, f.store.raw());
    expect(existsSync(`${f.database}.coding.sqlite`)).toBe(false);
    expect(f.record.codingBackupPath).toBeUndefined();
    expect(f.record.codingCatalogExpected).toBe(false);
    writeFileSync(`${f.database}.coding.sqlite`, 'a catalog from a different runtime');
    await expect(backupCodingDeployment(null, f.database, f.stage, f.record)).rejects.toThrow('installed runtime cannot safely');
    expect(() => assertCodingDeploymentStopped(null, f.database, f.store.raw())).toThrow('installed runtime cannot safely');
  } finally { f.close(); }
});

test('browser deployment uses installed SQLite backup for WAL history and refuses swap until native shutdown is recorded', async () => {
  const f = fixture();
  const coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  const db = new DatabaseSync(file);
  try {
    const session = { id: 'retained-session', owner: 'alex', generation: 1, repo: f.root, status: 'ready', nativeThreadId: 'native-saved', turnId: null };
    db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run(session.id, session.owner, session.generation, session.repo, JSON.stringify(session));
    db.prepare('INSERT INTO coding_item(session,id,payload) VALUES(?,?,?)').run(session.id, 'reply', JSON.stringify({ text: 'Keep this committed WAL reply.' }));
    db.prepare('INSERT INTO coding_custody(singleton,payload) VALUES(1,?)').run(JSON.stringify({ pid: 12345, group: true, descendants: [{ pid: 12346, group: false }], observationUnknown: false }));
    installUpdateGate(f.store.raw(), f.record.id);
    expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw())).toThrow('not verified agent and tool shutdown');
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    expect(f.record.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
    verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record);
    const copied = new DatabaseSync(f.record.codingBackupPath!, { readOnly: true });
    try {
      expect(copied.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL reply');
      expect(copied.prepare('SELECT payload FROM coding_custody').get()?.payload).toContain('12346');
      expect(copied.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*'").get()?.n).toBe(0);
    } finally { copied.close(); }
    expect(statSync(f.record.codingBackupPath!).mode & 0o777).toBe(0o600);
    const originalHash = f.record.codingBackupHash;
    await workspace.close();
    assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record);
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    expect(f.record.codingBackupHash).toBe(originalHash);
    writeFileSync(f.record.codingBackupPath!, 'changed backup');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('not overwritten');
    expect(readFileSync(f.record.codingBackupPath!, 'utf8')).toBe('changed backup');
  } finally { db.close(); await workspace.close(); f.close(); }
});

test('browser deployment refuses an unbacked or disappeared catalog and preserves an existing backup destination', async () => {
  const f = fixture();
  const coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  try {
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('no verified deployment backup');
    const target = join(f.stage, 'coding.backup.sqlite');
    writeFileSync(target, 'retained unfinished attempt');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('already exists');
    expect(readFileSync(target, 'utf8')).toBe('retained unfinished attempt');
    await workspace.close();
    rmSync(file);
    f.record.codingBackupPath = target;
    f.record.codingBackupHash = 'a'.repeat(64);
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('disappeared');
    expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record)).toThrow('disappeared');
  } finally { await workspace.close(); f.close(); }
});

test.each(['backup', 'verify', 'stop'])('browser %s refuses a catalog lost after its presence was saved but before backup', async action => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const file = `${f.database}.coding.sqlite`;
  const workspace = new CodingWorkspace({ database: file, worktreeRoot: join(f.root, 'worktrees') });
  try {
    expect(observeCodingDeployment(coding, f.database, f.record)).toBe(file);
    expect(f.record.codingCatalogExpected).toBe(true);
    const saved = JSON.parse(JSON.stringify(f.record));
    await workspace.close(); rmSync(file);
    if (action === 'backup') await expect(backupCodingDeployment(coding, f.database, f.stage, saved)).rejects.toThrow('disappeared');
    if (action === 'verify') expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, saved)).toThrow('disappeared');
    if (action === 'stop') expect(() => assertCodingDeploymentStopped(coding, f.database, f.store.raw(), saved)).toThrow('disappeared');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(f.stage, 'coding.backup.sqlite'))).toBe(false);
    expect(saved.codingCatalogExpected).toBe(true);
  } finally { await workspace.close(); f.close(); }
});

test('browser presence is retained across a failed backup and rejects malformed or forgotten custody', async () => {
  const f = fixture();
  const file = `${f.database}.coding.sqlite`;
  writeFileSync(file, 'observed catalog');
  const runtime = { backupCodingCatalog: async () => { rmSync(file); } };
  try {
    await expect(backupCodingDeployment(runtime, f.database, f.stage, f.record)).rejects.toThrow('disappeared');
    expect(f.record.codingCatalogExpected).toBe(true);
    expect(f.record.codingBackupPath).toBeUndefined();
    expect(() => observeCodingDeployment(runtime, f.database, { codingCatalogExpected: 'false' })).toThrow('presence is invalid');
    expect(() => observeCodingDeployment(runtime, f.database, { codingBackupHash: 'a'.repeat(64) })).toThrow('disappeared');
  } finally { f.close(); }
});

test('a first browser catalog appearing after prepare or startup gets a verified late backup', async () => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  try {
    await backupCodingDeployment(null, f.database, f.stage, f.record);
    const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees') });
    await workspace.close();
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('no verified deployment backup');
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record);
    expect(f.record.codingCatalogExpected).toBe(true);
    expect(f.record.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
    assertCodingDeploymentStopped(coding, f.database, f.store.raw(), f.record);
  } finally { f.close(); }
});

test.each(['missing', 'changed', 'linked'])('browser final backup checks reject %s retained bytes without overwriting', async damage => {
  const f = fixture(), coding = await loadCodingDeploymentRuntime(resolve('dist'));
  const workspace = new CodingWorkspace({ database: `${f.database}.coding.sqlite`, worktreeRoot: join(f.root, 'worktrees') });
  await workspace.close();
  try {
    await backupCodingDeployment(coding, f.database, f.stage, f.record);
    const target = f.record.codingBackupPath!;
    if (damage === 'changed') writeFileSync(target, 'changed retained bytes');
    else { renameSync(target, target + '.preserved'); if (damage === 'linked') symlinkSync(target + '.preserved', target); }
    expect(() => verifyCodingDeploymentBackup(coding, f.database, f.stage, f.record)).toThrow('missing, linked or changed');
    await expect(backupCodingDeployment(coding, f.database, f.stage, f.record)).rejects.toThrow('not overwritten');
    if (damage === 'changed') expect(readFileSync(target, 'utf8')).toBe('changed retained bytes');
  } finally { f.close(); }
});

test('a broken installed coding module is not silently treated as a legacy runtime', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'coding-update.js'), "import './missing-installed-dependency.js';\n");
    await expect(loadCodingDeploymentRuntime(f.root)).rejects.toThrow();
  } finally { f.close(); }
});

test('browser phase wiring verifies the coding backup before stop and custody before swap or restore', () => {
  // The deployment CLI has real launchd effects; verify its orchestration here
  // without executing it. Catalog behavior above uses real SQLite databases.
  const source = readFileSync(resolve('scripts/deploy-browser.mjs'), 'utf8');
  const prepare = source.slice(source.indexOf('async function prepare('), source.indexOf('async function rehearse('));
  const frozen = prepare.indexOf('save(r, "frozen")');
  expect(prepare.lastIndexOf('observeCodingDeployment(', frozen)).toBeGreaterThan(prepare.indexOf('freezeUpdateGate('));
  expect(frozen).toBeLessThan(prepare.indexOf('await backup(original'));
  expect(prepare.indexOf('await ensureCodingBackup(')).toBeGreaterThan(prepare.indexOf('await backup(original'));
  expect(prepare.indexOf('await ensureCodingBackup(')).toBeLessThan(prepare.indexOf('db.exec("COMMIT")'));
  const swap = source.slice(source.indexOf('async function swap('), source.indexOf('async function finish('));
  expect(swap.indexOf('await ensureCodingBackup(')).toBeLessThan(swap.indexOf('save(r, "stopping")'));
  expect(swap.indexOf('r.stoppingService = service(priorDist)')).toBeLessThan(swap.indexOf('save(r, "stopping")'));
  expect(swap).toContain('r.oldService.supervisor, ...r.oldService.children, r.stoppingService.supervisor, ...r.stoppingService.children');
  expect(swap.lastIndexOf('await verifyServiceStopped(oldPids)')).toBeGreaterThan(swap.indexOf('(await load(nextDist, "store.js"))'));
  expect(swap.lastIndexOf('await verifyServiceStopped(oldPids)')).toBeLessThan(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding'));
  expect(swap.indexOf('await verifyServiceStopped(oldPids)')).toBeLessThan(swap.indexOf('assertCodingDeploymentStopped(oldRt.coding'));
  expect(swap.indexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeLessThan(swap.indexOf('save(r, "migrating")'));
  expect(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeGreaterThan(swap.indexOf('(await load(nextDist, "store.js"))'));
  expect(swap.lastIndexOf('assertCodingDeploymentStopped(oldRt.coding')).toBeLessThan(swap.indexOf('writeFileSync(plist, nextPlist)'));
  const rollback = swap.slice(swap.indexOf('if (live === null)'));
  expect(rollback.indexOf('await verifyServiceStopped(failedPids)')).toBeLessThan(rollback.indexOf('assertCodingDeploymentStopped(coding'));
  expect(rollback.lastIndexOf('await verifyServiceStopped(failedPids)')).toBeGreaterThan(rollback.indexOf('await loadCodingDeploymentRuntime(nextDist)'));
  expect(rollback.lastIndexOf('await verifyServiceStopped(failedPids)')).toBeLessThan(rollback.indexOf('assertCodingDeploymentStopped(coding'));
  expect(rollback.indexOf('assertCodingDeploymentStopped(coding')).toBeLessThan(rollback.indexOf('writeFileSync(plist, livePlist)'));
  const finish = source.slice(source.indexOf('async function finish('));
  expect(finish.indexOf('await ensureCodingBackup(coding')).toBeLessThan(finish.indexOf('await fetch('));
  expect(finish.lastIndexOf('await ensureCodingBackup(coding')).toBeGreaterThan(finish.indexOf('await sleep('));
  expect(finish.lastIndexOf('verifyCodingBackup(coding')).toBeGreaterThan(finish.lastIndexOf('await ensureCodingBackup(coding'));
  expect(finish.lastIndexOf('verifyCodingBackup(coding')).toBeLessThan(finish.indexOf('removeUpdateGate('));
  const ensure = source.slice(source.indexOf('async function ensureCodingBackup('), source.indexOf('async function prepare('));
  expect(ensure.indexOf('save(r, r.phase)')).toBeLessThan(ensure.indexOf('await backupCodingDeployment('));
  const replace = swap.slice(swap.indexOf('// Migration loads asynchronously'), swap.indexOf('writeFileSync(plist, nextPlist)'));
  expect(replace.indexOf('await ensureCodingBackup(')).toBeLessThan(replace.indexOf('await verifyServiceStopped('));
  expect(replace.indexOf('verifyCodingBackup(')).toBeGreaterThan(replace.lastIndexOf('await '));
  const restore = rollback.slice(0, rollback.indexOf('writeFileSync(plist, livePlist)'));
  expect(restore.indexOf('await ensureCodingBackup(')).toBeLessThan(restore.lastIndexOf('await verifyServiceStopped('));
  expect(restore.indexOf('verifyCodingBackup(')).toBeGreaterThan(restore.lastIndexOf('await '));
  expect(swap.lastIndexOf('await ensureCodingBackup(await loadCodingDeploymentRuntime(nextDist), r)')).toBeGreaterThan(swap.indexOf('save(r, "started")'));
});
