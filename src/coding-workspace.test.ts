import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activeCodingUpdateWork } from './coding-update.js';
import { CodingActionError, CodingWorkspace } from './coding-workspace.js';
import { CodingProviderDisconnectedError, CodingProviderRequestError, type CodingProvider, type CodingProviderEvent } from './coding-provider.js';

class FakeProvider implements CodingProvider {
  listeners = new Set<(event: CodingProviderEvent) => void>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  answers: unknown[] = [];
  rejects: unknown[] = [];
  failure: Error | null = null;
  closeFailure: Error | null = null;
  thread = 'native-thread';
  emit(event: CodingProviderEvent) { for (const listener of this.listeners) listener(event); }
  note(method: string, params: Record<string, unknown> = {}) { this.emit({ kind: 'notification', method, params: { threadId: this.thread, ...params } }); }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.failure) { const error = this.failure; this.failure = null; throw error; }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: this.thread, turns: [] } };
    if (method === 'turn/start') {
      this.note('turn/started', { turn: { id: 'turn-1' } });
      this.note('item/completed', { item: { id: params['clientUserMessageId'], type: 'userMessage', content: params['input'] } });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/steer') return { turnId: 'turn-1' };
    if (method === 'turn/interrupt') this.note('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    return {};
  }
  respond(id: string | number, result: unknown) { this.answers.push({ id, result }); }
  reject(id: string | number, code: number, message: string) { this.rejects.push({ id, code, message }); }
  processId() { return null; }
  custody() { return { pid: null, group: false, descendants: [], observationUnknown: false, host: '', bootId: null }; }
  subscribe(listener: (event: CodingProviderEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() { if (this.closeFailure) throw this.closeFailure; this.emit({ kind: 'exit', message: 'closed' }); }
}

describe('native coding workspace', () => {
  let dir: string, repo: string, db: string, workspace: CodingWorkspace, provider: FakeProvider;
  let expectedCloseFailure: string | null = null;
  const actor = { name: 'alex', generation: 1 };
  const key = 'initial-request-0001';
  const open = () => new CodingWorkspace({ database: db, worktreeRoot: join(dir, 'worktrees'), provider: () => provider });
  const start = () => workspace.start(actor, { repo, title: 'Improve the welcome screen', model: null, prompt: 'Make the welcome screen clearer.', requestId: key });
  beforeEach(() => {
    expectedCloseFailure = null;
    dir = mkdtempSync(join(tmpdir(), 'so-coding-')); repo = join(dir, 'repo'); db = join(dir, 'orders.db.coding.sqlite');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'welcome.txt'), 'Welcome\n');
    execFileSync('git', ['-C', repo, 'add', 'welcome.txt']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'Initial']);
    provider = new FakeProvider(); workspace = open();
  });
  afterEach(async () => {
    provider.closeFailure = null;
    if (expectedCloseFailure !== null) {
      await expect(workspace.close()).rejects.toThrow(expectedCloseFailure);
      provider.listeners.clear();
      // This fixture intentionally leaves its catalog fenced after a failed
      // save. Close only its test handle; do not manufacture a clean receipt.
      (workspace as unknown as { db: DatabaseSync }).db.close();
    } else await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates an isolated checkout at the exact current commit and keeps native tools enabled', async () => {
    const session = await start();
    expect(session.base).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    expect(session.worktree).not.toBe(repo); expect(session.nativeThreadId).toBe('native-thread');
    writeFileSync(join(session.worktree, 'welcome.txt'), 'Hello, player\n');
    expect(readFileSync(join(repo, 'welcome.txt'), 'utf8')).toBe('Welcome\n');
    expect(provider.calls[0]).toMatchObject({ method: 'thread/start', params: { cwd: session.worktree, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' } });
    expect(workspace.snapshot(session.id, actor).items[0]?.text).toBe('Make the welcome screen clearer.');
    expect((await workspace.changes(session.id, actor)).diff).toContain('+Hello, player');
  });

  test('steers the live turn and resumes the same conversation for subsequent revisions', async () => {
    const session = await start();
    await workspace.send(session.id, actor, 'Use a shorter heading.', 'revision-request-001');
    expect(provider.calls.at(-1)).toMatchObject({ method: 'turn/steer', params: { threadId: 'native-thread', expectedTurnId: 'turn-1' } });
    provider.note('turn/completed', { turn: { status: 'completed' } });
    await workspace.send(session.id, actor, 'Increase the button size.', 'revision-request-002');
    expect(provider.calls.at(-1)?.method).toBe('turn/start');
    expect(provider.calls.filter(c => c.method === 'thread/start')).toHaveLength(1);
  });

  test('a duplicate browser send cannot create another turn, and changed text cannot reuse its key', async () => {
    const session = await start(); const count = provider.calls.length;
    await workspace.send(session.id, actor, 'Make the welcome screen clearer.', key);
    expect(provider.calls).toHaveLength(count);
    await expect(workspace.send(session.id, actor, 'Different request', key)).rejects.toThrow('different text');
    expect((await start()).id).toBe(session.id); expect(provider.calls).toHaveLength(count);
  });

  test('ambiguous first delivery remains fenced and is never silently resubmitted', async () => {
    const original = provider.request.bind(provider);
    provider.request = async (method, params) => { if (method === 'turn/start') throw new CodingProviderDisconnectedError('unknown'); return original(method, params); };
    await expect(start()).rejects.toThrow('may have reached');
    const session = workspace.list(actor)[0]!;
    expect(session.status).toBe('uncertain');
    await expect(workspace.resume(session.id, actor)).rejects.toThrow('may have reached');
    await expect(workspace.send(session.id, actor, 'Again', 'another-request-0001')).rejects.toThrow('may have reached');
  });

  test('a rejected steering request does not hide the still-running turn or its Stop action', async () => {
    const session = await start(); provider.failure = new CodingProviderRequestError(-1, 'Turn changed');
    await expect(workspace.send(session.id, actor, 'Shorter', 'revision-request-003')).rejects.toThrow('Turn changed');
    expect(workspace.get(session.id, actor)).toMatchObject({ status: 'working', turnId: 'turn-1' });
    await workspace.stop(session.id, actor); expect(workspace.get(session.id, actor).status).toBe('interrupted');
  });

  test('Stop cancels a pending approval and stale approval cards cannot execute', async () => {
    const session = await start();
    provider.emit({ kind: 'request', id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: provider.thread, turnId: 'turn-1', command: 'npm test' } });
    const request = workspace.snapshot(session.id, actor).requests[0]!;
    expect(request.kind).toBe('command'); expect(request.detail).toContain('npm test');
    await workspace.stop(session.id, actor);
    expect(provider.answers).toEqual([{ id: 9, result: { decision: 'cancel' } }]);
    expect(() => workspace.answer(session.id, actor, request.id, 'accept', {})).toThrow('no longer waiting');
  });

  test('answers native questions and rejects unsupported request protocols without bogus approval replies', async () => {
    const session = await start();
    provider.emit({ kind: 'request', id: 10, method: 'item/tool/requestUserInput', params: { threadId: provider.thread, questions: [{ id: 'style', header: 'Style', question: 'Choose a style', options: [] }] } });
    const token = workspace.snapshot(session.id, actor).requests[0]!.id;
    expect(() => workspace.answer(session.id, actor, token, 'accept', {})).toThrow('Answer each');
    workspace.answer(session.id, actor, token, 'accept', { style: { answers: ['Clockwork Gardens'] } });
    expect(provider.answers.at(-1)).toEqual({ id: 10, result: { answers: { style: { answers: ['Clockwork Gardens'] } } } });
    provider.emit({ kind: 'request', id: 11, method: 'unknown/interaction', params: { threadId: provider.thread } });
    expect(provider.rejects).toHaveLength(1); expect(provider.answers).toHaveLength(1);
  });

  test('ownership and credential generation isolate sessions and history', async () => {
    const session = await start();
    expect(workspace.list({ name: 'other', generation: 1 })).toEqual([]);
    expect(() => workspace.snapshot(session.id, { name: 'alex', generation: 2 })).toThrow('not available');
    await expect(workspace.changes(session.id, { name: 'other', generation: 1 })).rejects.toThrow('not available');
  });

  test('verified shutdown permits cold resume without a new native thread or lost work', async () => {
    const session = await start(); writeFileSync(join(session.worktree, 'welcome.txt'), 'Saved revision\n');
    await workspace.close(); provider = new FakeProvider(); workspace = open();
    expect(workspace.get(session.id, actor).status).toBe('interrupted');
    await workspace.resume(session.id, actor);
    expect(provider.calls[0]).toMatchObject({ method: 'thread/resume', params: { threadId: 'native-thread', cwd: session.worktree } });
    expect(readFileSync(join(session.worktree, 'welcome.txt'), 'utf8')).toBe('Saved revision\n');
    expect(workspace.get(session.id, actor).status).toBe('ready');
  });

  test('an unclean prior runtime fences new starts and cannot be cleared by closing an empty server', async () => {
    await start(); await workspace.close();
    const raw = new DatabaseSync(db); raw.prepare("UPDATE coding_owner SET clean=0, native_pid=2147483647, token='',pid=0").run(); raw.close();
    provider = new FakeProvider(); workspace = open();
    await expect(workspace.start(actor, { repo, title: 'New work', model: null, prompt: 'Start another change.', requestId: 'new-start-after-crash' })).rejects.toThrow('needs recovery'); expect(provider.calls).toEqual([]);
    // Reading the already accepted initial receipt does not start new work.
    expect((await start()).status).toBe('uncertain'); expect(provider.calls).toEqual([]);
    await workspace.close();
    const check = new DatabaseSync(db); expect(check.prepare('SELECT clean,native_pid FROM coding_owner').get()).toMatchObject({ clean: 0, native_pid: 2147483647 }); check.close();
  });

  test('a second server cannot acquire a live coding catalog', () => { expect(() => open()).toThrow('Another Standing Orders server'); });

  test('new files appear in the diff without following symlinks outside the checkout', async () => {
    const session = await start();
    writeFileSync(join(session.worktree, 'new.txt'), 'New feature\n');
    writeFileSync(join(dir, 'private.txt'), 'DO-NOT-READ-OUTSIDE-TARGET\n');
    symlinkSync(join(dir, 'private.txt'), join(session.worktree, 'link.txt'));
    const changes = await workspace.changes(session.id, actor);
    expect(changes.diff).toContain('+New feature');
    expect(changes.diff).toContain('new file mode 120000');
    expect(changes.diff).not.toContain('DO-NOT-READ-OUTSIDE-TARGET');
  });

  test('native request resolution withdraws only the exact card and cannot be approved later', async () => {
    const session = await start();
    provider.emit({ kind: 'request', id: 14, method: 'item/fileChange/requestApproval', params: { threadId: provider.thread, turnId: 'turn-1' } });
    const token = workspace.snapshot(session.id, actor).requests[0]!.id;
    provider.note('serverRequest/resolved', { requestId: 14 });
    expect(workspace.snapshot(session.id, actor).requests).toEqual([]);
    expect(workspace.get(session.id, actor).status).toBe('working');
    expect(() => workspace.answer(session.id, actor, token, 'accept', {})).toThrow('no longer waiting');
  });
  test('recovery matches native client receipts without replaying an acknowledged message', async () => {
    const original = provider.request.bind(provider);
    provider.request = async (method, params) => {
      if (method === 'turn/start') throw new CodingProviderDisconnectedError('acknowledgement lost');
      if (method === 'thread/read') return { thread: { id: provider.thread, turns: [{ items: [{ id: 'different-native-id', type: 'userMessage', clientId: key, content: [{ type: 'text', text: 'Make the welcome screen clearer.' }] }] }] } };
      return original(method, params);
    };
    await expect(start()).rejects.toThrow('may have reached');
    const session = workspace.list(actor)[0]!;
    await workspace.recover(session.id, actor);
    expect(workspace.get(session.id, actor)).toMatchObject({ status: 'interrupted', deliveryReviewRequired: false });
    await workspace.resume(session.id, actor);
    await workspace.send(session.id, actor, 'Make the welcome screen clearer.', key);
    expect(provider.calls.filter(c => c.method === 'thread/start')).toHaveLength(1);
    expect(provider.calls.filter(c => c.method === 'turn/start')).toHaveLength(0);
  });

  test('missing delivery evidence needs explicit review and continuation never resends it', async () => {
    const original = provider.request.bind(provider);
    let sends = 0;
    provider.request = async (method, params) => {
      if (method === 'turn/start') { sends++; throw new CodingProviderDisconnectedError('lost'); }
      if (method === 'thread/read') return { thread: { id: provider.thread, turns: [] } };
      return original(method, params);
    };
    await expect(start()).rejects.toThrow('may have reached');
    const session = workspace.list(actor)[0]!;
    await expect(workspace.continueSaved(session.id, actor)).rejects.toThrow('Check the saved');
    await workspace.recover(session.id, actor);
    expect(workspace.get(session.id, actor)).toMatchObject({ status: 'uncertain', deliveryReviewRequired: true });
    await workspace.continueSaved(session.id, actor);
    expect(workspace.get(session.id, actor).status).toBe('ready'); expect(sends).toBe(1);
  });

  test('cold recovery retains descendant witnesses and never signals them', async () => {
    const session = await start(); await workspace.close();
    const raw = new DatabaseSync(db);
    raw.prepare("UPDATE coding_owner SET clean=0,token='',pid=0,native_pid=2147483647").run();
    const witness = { pid: 2147483647, group: false, descendants: [{ pid: process.pid, group: false }], observationUnknown: false, host: hostname(), bootId: null };
    raw.prepare('INSERT OR REPLACE INTO coding_custody VALUES(1,?)').run(JSON.stringify(witness));
    provider = new FakeProvider(); workspace = open();
    await expect(workspace.recover(session.id, actor)).rejects.toThrow('may still be running');
    expect(provider.calls).toEqual([]);
    witness.descendants = []; witness.observationUnknown = true;
    raw.prepare('UPDATE coding_custody SET payload=?').run(JSON.stringify(witness));
    await expect(workspace.recover(session.id, actor)).rejects.toThrow('may still be running');
    witness.observationUnknown = false;
    raw.prepare('UPDATE coding_custody SET payload=?').run(JSON.stringify(witness)); raw.close();
    const original = provider.request.bind(provider);
    provider.request = (method, params) => method === 'thread/read' ? Promise.resolve({ thread: { id: provider.thread, turns: [] } }) : original(method, params);
    await workspace.recover(session.id, actor);
    expect(workspace.get(session.id, actor).status).toBe('interrupted');
  });

  test('cold resume rejects a changed worktree branch before contacting the model', async () => {
    const session = await start(); await workspace.close();
    execFileSync('git', ['-C', session.worktree, 'checkout', '-qb', 'another-branch']);
    provider = new FakeProvider(); workspace = open();
    await expect(workspace.resume(session.id, actor)).rejects.toThrow('no longer matches');
    expect(provider.calls).toEqual([]);
  });

  test('update drain blocks new turns while keeping Stop available', async () => {
    await workspace.close(); let paused = false;
    workspace = new CodingWorkspace({ database: db, worktreeRoot: join(dir, 'worktrees'), provider: () => provider, admissionPaused: () => paused });
    const session = await start(); paused = true;
    await expect(workspace.send(session.id, actor, 'Change heading', 'drain-revision-0001')).rejects.toThrow('preparing an update');
    await workspace.stop(session.id, actor); expect(workspace.get(session.id, actor).status).toBe('interrupted');
    await expect(workspace.resume(session.id, actor)).rejects.toThrow('preparing an update');
  });

  test('shutdown waits for in-flight startup to settle before closing its catalog', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = provider.request.bind(provider);
    let entered!: () => void;
    const enteredStart = new Promise<void>(resolve => { entered = resolve; });
    provider.request = async (method, params) => { if (method === 'thread/start') { entered(); await gate; } return original(method, params); };
    const starting = start().catch(error => error);
    await enteredStart;
    let closed = false; const closing = workspace.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
    release(); expect(await starting).toBeInstanceOf(Error); await closing;
    expect(provider.calls.some(c => c.method === 'turn/start')).toBe(false);
    const raw = new DatabaseSync(db); expect(raw.prepare('SELECT clean FROM coding_owner').get()?.clean).toBe(1); raw.close();
    provider = new FakeProvider(); workspace = open();
  });

  test('a final transcript save failure still closes the native provider and preserves unclean custody', async () => {
    await start();
    provider.note('item/agentMessage/delta', { itemId: 'pending-output', delta: 'The final output is pending.' });
    const raw = new DatabaseSync(db);
    let cleanupAttempted = false;
    provider.close = async () => { cleanupAttempted = true; };
    try {
      raw.exec("CREATE TRIGGER fixture_write_failure BEFORE INSERT ON coding_item BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END");
      expectedCloseFailure = 'Coding activity could not be saved';
      await expect(workspace.close()).rejects.toThrow(expectedCloseFailure);
      expect(cleanupAttempted).toBe(true);
      expect(raw.prepare('SELECT clean,pid FROM coding_owner').get()).toMatchObject({ clean: 0, pid: process.pid });
    } finally { raw.close(); }
  });

  test('a rejected initial prompt stays inspectable and duplicate startup never reports it delivered', async () => {
    const original = provider.request.bind(provider);
    let starts = 0;
    provider.request = async (method, params) => {
      if (method === 'thread/start') {
        starts++;
        expect(workspace.list(actor).at(0)?.initialRequest).toEqual({ requestId: starts === 1 ? key : 'explicit-retry-0001', prompt: 'Make the welcome screen clearer.' });
        expect(workspace.snapshot(workspace.list(actor)[0]!.id, actor).items).toEqual([]);
      }
      if (method === 'turn/start' && starts === 1) throw new CodingProviderRequestError(-32602, 'The native input was rejected.');
      return original(method, params);
    };
    await expect(start()).rejects.toMatchObject({ delivery: 'rejected' });
    const saved = workspace.list(actor)[0]!;
    expect(saved.initialRequest?.prompt).toBe('Make the welcome screen clearer.');
    expect(workspace.snapshot(saved.id, actor).items).toEqual([]);
    await expect(start()).rejects.toMatchObject({ delivery: 'rejected', sessionId: saved.id });
    expect(starts).toBe(1);
    provider.thread = 'native-retried-thread';
    const retried = await workspace.start(actor, { repo, title: 'Retry the saved request', model: null, prompt: 'Make the welcome screen clearer.', requestId: 'explicit-retry-0001' });
    expect(retried.id).not.toBe(saved.id);
    expect(starts).toBe(2);
  });

  test('an in-flight initial request stays pending until its first prompt is accepted', async () => {
    let entered!: () => void, release!: () => void;
    const atStart = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const original = provider.request.bind(provider);
    provider.request = async (method, params) => { if (method === 'thread/start') { entered(); await gate; } return original(method, params); };
    const running = start();
    await atStart;
    try { await expect(start()).rejects.toMatchObject({ delivery: 'pending' }); }
    finally { release(); }
    const accepted = await running;
    expect((await start()).id).toBe(accepted.id);
    expect(provider.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    expect(provider.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });

  test('unknown native startup preserves its original request across restart without creating another thread', async () => {
    provider.failure = new CodingProviderDisconnectedError('The startup response was lost.');
    await expect(start()).rejects.toMatchObject({ delivery: 'unknown' });
    const saved = workspace.list(actor)[0]!;
    expect(saved).toMatchObject({ status: 'uncertain', nativeThreadId: null, initialRequest: { requestId: key, prompt: 'Make the welcome screen clearer.' } });
    await expect(start()).rejects.toMatchObject({ delivery: 'unknown', sessionId: saved.id });
    expect(provider.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    await workspace.close(); provider = new FakeProvider(); workspace = open();
    await expect(start()).rejects.toMatchObject({ delivery: 'unknown', sessionId: saved.id });
    expect(provider.calls).toEqual([]);
  });

  test('unknown startup after restart needs verified process exit and explicit closure before update drain clears', async () => {
    provider.failure = new CodingProviderDisconnectedError('The startup response was lost.');
    await expect(start()).rejects.toMatchObject({ delivery: 'unknown' });
    const saved = workspace.list(actor)[0]!;
    writeFileSync(join(saved.worktree, 'kept.txt'), 'Keep this inspected work.\n');
    await workspace.close();
    const raw = new DatabaseSync(db), orders = new DatabaseSync(join(dir, 'orders.db'));
    try {
      raw.prepare("UPDATE coding_owner SET clean=0,token='',pid=0,native_pid=2147483647").run();
      const witness = { pid: 2147483647, group: false, descendants: [{ pid: process.pid, group: false }], observationUnknown: false, host: hostname(), bootId: null };
      raw.prepare('INSERT OR REPLACE INTO coding_custody VALUES(1,?)').run(JSON.stringify(witness));
      provider = new FakeProvider(); workspace = open();
      await expect(workspace.start(actor, { repo, title: 'Another change', model: null, prompt: 'Start a new session.', requestId: 'after-startup-crash-01' })).rejects.toThrow('needs recovery');
      await expect(workspace.recover(saved.id, actor)).rejects.toThrow('may still be running');
      await expect(workspace.continueSaved(saved.id, actor)).rejects.toThrow('Check the saved conversation');
      expect(activeCodingUpdateWork(orders)).toEqual({ coding: 1, codingDeliveries: 1 });
      expect(provider.calls).toEqual([]);
      witness.descendants = [];
      raw.prepare('UPDATE coding_custody SET payload=?').run(JSON.stringify(witness));
      await workspace.recover(saved.id, actor);
      expect(workspace.get(saved.id, actor)).toMatchObject({ status: 'uncertain', nativeThreadId: null, deliveryReviewRequired: true });
      expect(activeCodingUpdateWork(orders)).toEqual({ coding: 1, codingDeliveries: 1 });
      expect(provider.calls).toEqual([]);
      await workspace.continueSaved(saved.id, actor);
      expect(workspace.get(saved.id, actor)).toMatchObject({ status: 'closed', nativeThreadId: null, deliveryReviewRequired: false, initialRequest: saved.initialRequest });
      expect(raw.prepare('SELECT status FROM coding_submission WHERE session=?').get(saved.id)?.status).toBe('not-retried');
      expect(activeCodingUpdateWork(orders)).toEqual({ coding: 0, codingDeliveries: 0 });
      expect(readFileSync(join(saved.worktree, 'kept.txt'), 'utf8')).toBe('Keep this inspected work.\n');
      expect(provider.calls).toEqual([]);
      await expect(workspace.resume(saved.id, actor)).rejects.toThrow('session is closed');
      await expect(workspace.send(saved.id, actor, 'Do not replay this.', 'closed-session-send-01')).rejects.toThrow('session is closed');
      await workspace.close(); workspace = open();
      expect(workspace.get(saved.id, actor).status).toBe('closed');
      await workspace.start(actor, { repo, title: 'Another change', model: null, prompt: 'Start a new session.', requestId: 'after-startup-crash-01' });
      expect(provider.calls.map(call => call.method)).toEqual(['thread/start', 'turn/start']);
    } finally { raw.close(); orders.close(); }
  });

  test('a crash before sending the prepared initial prompt still requires delivery review and never replays it', async () => {
    const saved = await start(); await workspace.close();
    const raw = new DatabaseSync(db), orders = new DatabaseSync(join(dir, 'orders.db'));
    try {
      // The thread identity was saved, but no initial turn was dispatched.
      raw.prepare("UPDATE coding_submission SET status='preparing' WHERE session=?").run(saved.id);
      raw.prepare('DELETE FROM coding_item WHERE session=?').run(saved.id);
      raw.prepare("UPDATE coding_session SET document=json_set(document,'$.status','uncertain','$.turnId',NULL) WHERE id=?").run(saved.id);
      provider = new FakeProvider(); workspace = open();
      const original = provider.request.bind(provider);
      provider.request = async (method, params) => method === 'thread/read' ? { thread: { id: saved.nativeThreadId, turns: [] } } : original(method, params);
      await workspace.recover(saved.id, actor);
      expect(workspace.get(saved.id, actor)).toMatchObject({ status: 'uncertain', deliveryReviewRequired: true });
      expect(activeCodingUpdateWork(orders)).toEqual({ coding: 1, codingDeliveries: 1 });
      await workspace.continueSaved(saved.id, actor);
      expect(workspace.get(saved.id, actor).status).toBe('ready');
      expect(activeCodingUpdateWork(orders)).toEqual({ coding: 0, codingDeliveries: 0 });
      expect(provider.calls.map(call => call.method)).toEqual(['thread/resume']);
      expect(workspace.get(saved.id, actor).initialRequest).toEqual(saved.initialRequest);
      expect(workspace.snapshot(saved.id, actor).items).toEqual([]);
    } finally { raw.close(); orders.close(); }
  });

  test('a rejected follow-up can be edited and explicitly retried with a new receipt', async () => {
    const saved = await start();
    provider.failure = new CodingProviderRequestError(-32602, 'The update was rejected.');
    await expect(workspace.send(saved.id, actor, 'First revision', 'rejected-revision-001')).rejects.toMatchObject({ delivery: 'rejected' });
    const before = provider.calls.length;
    await expect(workspace.send(saved.id, actor, 'First revision', 'rejected-revision-001')).rejects.toMatchObject({ delivery: 'rejected' });
    expect(provider.calls).toHaveLength(before);
    await workspace.send(saved.id, actor, 'Edited revision', 'explicit-revision-002');
    expect(provider.calls).toHaveLength(before + 1);
  });

  test('pending and unknown follow-up receipts never return a false success or replay a message', async () => {
    const saved = await start();
    let entered!: () => void, release!: () => void;
    const atSend = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const original = provider.request.bind(provider);
    provider.request = async (method, params) => { if (method === 'turn/steer') { entered(); await gate; } return original(method, params); };
    const sending = workspace.send(saved.id, actor, 'Pending update', 'pending-revision-001');
    await atSend;
    try { await expect(workspace.send(saved.id, actor, 'Pending update', 'pending-revision-001')).rejects.toMatchObject({ delivery: 'pending' }); }
    finally { release(); }
    await sending;
    provider.request = original;
    provider.failure = new CodingProviderDisconnectedError('Acknowledgement lost');
    await expect(workspace.send(saved.id, actor, 'Unknown update', 'unknown-revision-001')).rejects.toMatchObject({ delivery: 'unknown' });
    const before = provider.calls.length;
    await expect(workspace.send(saved.id, actor, 'Unknown update', 'unknown-revision-001')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(provider.calls).toHaveLength(before);
  });

  test('access revoked after an accepted native response keeps its receipt instead of inviting a resend', async () => {
    await workspace.close();
    let authorized = true;
    workspace = new CodingWorkspace({ database: db, worktreeRoot: join(dir, 'worktrees'), provider: () => provider, authorize: () => authorized });
    const original = provider.request.bind(provider);
    provider.request = async (method, params) => { const result = await original(method, params); if (method === 'turn/start') authorized = false; return result; };
    const failure = await start().catch(error => error);
    expect(failure).toBeInstanceOf(CodingActionError);
    expect(failure.delivery).toBe('unknown');
    const before = provider.calls.length;
    authorized = true;
    expect((await start()).initialRequest?.requestId).toBe(key);
    expect(provider.calls).toHaveLength(before);
  });

});
