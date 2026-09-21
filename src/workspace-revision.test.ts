import { afterEach, beforeEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { prepareWorkspaceRevision, type WorkspaceRevision } from './workspace-revision.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
let store: Store, revision: WorkspaceRevision, directory: string, file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'so-workspace-revision-')); file = join(directory, 'orders.db');
  store = openStore(file); revision = prepareWorkspaceRevision(store);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

function task() { store.createTask({ id: 'task', title: 'Original title' }, NOW); return store.lookupRef('task')!.id; }
function runner(heartbeat = at(0)) {
  store.raw().prepare(`INSERT INTO runner(name,host,credential_hash,capacity,registered_at,heartbeat_at) VALUES ('worker','host','hash',1,?,?)`).run(at(0), heartbeat);
}

test('source writes, external writers and deletes invalidate; no-op updates and rolled-back writes do not', () => {
  const initial = revision.current(); task();
  expect(revision.current()).not.toBe(initial);
  const written = revision.current();
  const writer = new DatabaseSync(file);
  try {
    writer.exec("UPDATE task SET title=title"); expect(revision.current()).toBe(written);
    writer.exec("BEGIN; UPDATE task SET title='Rolled back'; ROLLBACK;"); expect(revision.current()).toBe(written);
    writer.exec("UPDATE task SET title='Changed by another writer'"); expect(revision.current()).not.toBe(written);
    const changed = revision.current();
    writer.exec("DELETE FROM task WHERE id='task'"); expect(revision.current()).not.toBe(changed);
  } finally { writer.close(); }
});

test('revision and triggers survive closing every process and preparation is idempotent', () => {
  task(); const before = revision.current();
  const count = () => Number(store.raw().prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'workspace_revision_%'").get()!['n']);
  const triggers = count();
  expect(prepareWorkspaceRevision(store).current()).toBe(before); expect(count()).toBe(triggers);
  store.close();
  const writer = new DatabaseSync(file);
  writer.exec("UPDATE task SET title='Changed while browser was stopped'"); writer.close();
  store = openStore(file); revision = prepareWorkspaceRevision(store);
  expect(revision.current()).not.toBe(before); expect(count()).toBe(triggers);
});

test('cursor, wake and ordinary heartbeats stay quiet; real runner changes and revival invalidate', () => {
  runner(at(-160_000)); const before = revision.current();
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 20_000);
  expect(revision.expiresAt(new Date(at(20_000)))).toBe(NOW.getTime() + 20_000);
  store.setServiceCursor('other-maintenance', 4, NOW);
  store.raw().exec('UPDATE wake SET seq=seq+1');
  store.raw().prepare("INSERT INTO telegram_retry(bot_id,next_attempt_at) VALUES ('bot',?)").run(at(5_000));
  store.raw().prepare('UPDATE telegram_retry SET next_attempt_at=?').run(at(10_000));
  store.raw().exec('DELETE FROM telegram_retry');
  store.raw().prepare("UPDATE runner SET heartbeat_at=?").run(at(-150_000));
  expect(revision.current()).toBe(before);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 30_000);
  // Keep the original response's deadline: renewing a beat never extends a
  // representation already cached by the HTTP layer.
  store.raw().exec('UPDATE runner SET capacity=2');
  expect(revision.current()).not.toBe(before);
  const changed = revision.current();
  store.raw().prepare('UPDATE runner SET heartbeat_at=?').run(at(40_000));
  expect(revision.current()).not.toBe(changed);
});

test('claim renewals are quiet but release invalidates and lease/hold boundaries expire the view', () => {
  const ref = task();
  store.raw().prepare(`INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at) VALUES ('lease',?,1,'worker',?,?,?)`).run(ref, at(0), at(12_000), at(0));
  const before = revision.current();
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 12_000);
  store.raw().prepare('UPDATE claim SET heartbeat_at=?,expires_at=?').run(at(1_000), at(30_000));
  expect(revision.current()).toBe(before);
  store.hold(ref, 'Wait', new Date(at(15_000)), NOW);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 15_000);
  const held = revision.current();
  store.raw().prepare('UPDATE claim SET released_at=?').run(at(2_000));
  expect(revision.current()).not.toBe(held);
  expect(revision.expiresAt(new Date(at(15_000)))).toBe(NOW.getTime() + 75_000);
});

test('mode and provider boundaries cap freshness and the fallback never exceeds sixty seconds', () => {
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 60_000);
  expect(addApprover(store, 'owner', NOW).ok).toBe(true);
  store.raw().prepare(`INSERT INTO operating_mode(repo,name,terms_json,digest,signed_by,signed_at,absolute_expiry) VALUES ('/repo','standard','{}','digest','owner',?,?)`).run(at(0), at(25_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 25_000);
  store.raw().prepare(`INSERT INTO capability(repo,kind,name,added_by,created_at,expires_at) VALUES ('/repo','cli','codex','owner',?,?)`).run(at(0), at(9_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 9_000);
  store.raw().prepare(`INSERT INTO quota(runner,provider,state,reason,observed_at,reset_at) VALUES ('worker','codex','exhausted','limit',?,?)`).run(at(0), at(5_000));
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 5_000);
});

test('provider observation renewals and watch tick/lease renewal are quiet but changed facts invalidate', () => {
  runner();
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'ready', reason: 'ready', probe: 'identity' }], NOW);
  const before = revision.current();
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'ready', reason: 'ready', probe: 'identity' }], new Date(at(1_000)));
  expect(revision.current()).toBe(before);
  store.recordProviderReadiness('worker', [{ provider: 'codex', state: 'unavailable', reason: 'signed out', probe: 'identity' }], new Date(at(2_000)));
  expect(revision.current()).not.toBe(before);
  store.raw().prepare(`INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES ('worker','/repo','owner',1,?,?,?)`).run(at(0), at(20_000), at(0));
  store.raw().prepare(`INSERT INTO watch_episode(repo,runner,incarnation,started_at) VALUES ('/repo','worker','incarnation',?)`).run(at(0));
  const watch = revision.current();
  store.raw().exec('UPDATE watch_episode SET ticks=ticks+1');
  store.raw().prepare('UPDATE watch_lease SET heartbeat_at=?,expires_at=?').run(at(1_000), at(30_000));
  expect(revision.current()).toBe(watch);
  expect(revision.expiresAt(NOW)).toBe(NOW.getTime() + 30_000);
  store.raw().exec('UPDATE watch_episode SET built=built+1');
  expect(revision.current()).not.toBe(watch);
});
