import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createDecisionServer } from './serve.js';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { prepareCodingContext } from './coding-context.js';
import { changeKnowledge, knowledgeView } from './project-knowledge.js';
import { CodingWorkspace } from './coding-workspace.js';
import type { CodingProvider, CodingProviderEvent } from './coding-provider.js';
import type { CodingSnapshot } from './coding-types.js';

/** HTTP tests use a real catalog and isolated Git worktrees. Only the model
 * transport is replaced, so authentication cannot bypass session ownership. */
class FakeCodingProvider implements CodingProvider {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  answers: { id: string | number; result: unknown }[] = [];
  rejects: { id: string | number; code: number; message: string }[] = [];
  listeners = new Set<(event: CodingProviderEvent) => void>();
  closeCalls = 0;
  closeGate: Promise<void> | null = null;
  private threadNumber = 0;
  emit(event: CodingProviderEvent) { for (const listener of this.listeners) listener(event); }
  note(threadId: string, method: string, params: Record<string, unknown>) { this.emit({ kind: 'notification', method, params: { threadId, ...params } }); }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `native-${++this.threadNumber}`, turns: [] } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } };
    if (method === 'turn/start') {
      const threadId = String(params.threadId);
      this.note(threadId, 'turn/started', { turn: { id: `${threadId}-turn` } });
      this.note(threadId, 'item/completed', { item: { id: params.clientUserMessageId, type: 'userMessage', content: params.input } });
      return { turn: { id: `${threadId}-turn` } };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/interrupt') this.note(String(params.threadId), 'turn/completed', { turn: { id: params.turnId, status: 'interrupted' } });
    return {};
  }
  respond(id: string | number, result: unknown) { this.answers.push({ id, result }); }
  reject(id: string | number, code: number, message: string) { this.rejects.push({ id, code, message }); }
  subscribe(listener: (event: CodingProviderEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  processId() { return null; }
  custody() { return { pid: null, group: false, descendants: [], observationUnknown: false, host: '', bootId: null }; }
  async close() { this.closeCalls++; await this.closeGate; this.emit({ kind: 'exit', message: 'Closed fixture transport' }); }
}

describe('coding console HTTP boundaries', () => {
  let root: string, repo: string, otherRepo: string, outsideRepo: string, base: string;
  let store: Store, workspace: CodingWorkspace, provider: FakeCodingProvider, server: Server;
  let providerStarts: number;
  const passwords = new Map<string, string>();
  type Login = { name: string; cookie: string; csrf: string };

  function gitProject(name: string): string {
    const path = join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    execFileSync('git', ['-C', path, 'config', 'user.email', 'http-tests@example.test']);
    execFileSync('git', ['-C', path, 'config', 'user.name', 'HTTP Fixture']);
    writeFileSync(join(path, 'welcome.txt'), 'Welcome\n');
    execFileSync('git', ['-C', path, 'add', 'welcome.txt']);
    execFileSync('git', ['-C', path, 'commit', '-qm', 'Initial']);
    return path;
  }

  async function login(name = 'alex'): Promise<Login> {
    const response = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name, token: passwords.get(name)! }), redirect: 'manual' });
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const screen = await fetch(`${base}${store.isInstanceOperator(name) ? '/code' : '/projects'}`, { headers: { cookie }, redirect: 'manual' });
    expect(screen.status).toBe(200);
    const html = await screen.text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
    if (!csrf) throw Error('No session CSRF token on the rendered page');
    return { name, cookie, csrf };
  }

  function post(path: string, user: Login, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { cookie: user.cookie, accept: 'application/json', ...headers }, body: new URLSearchParams({ csrf: user.csrf, ...fields }), redirect: 'manual' });
  }

  const initial = (user: Login, requestId = 'first-http-request-0001', project = repo) => ({ repo: project, title: 'Improve welcome', prompt: 'Make the welcome clearer.', requestId, password: passwords.get(user.name)! });
  async function start(user: Login, requestId?: string, project?: string): Promise<string> {
    const response = await post('/code/start', user, initial(user, requestId, project));
    const result = await response.json() as { id?: string; error?: string };
    expect(response.status, result.error).toBe(200);
    expect(result.id).toMatch(/^[a-f0-9]{32}$/);
    return result.id!;
  }
  async function state(id: string, user: Login): Promise<CodingSnapshot> {
    const response = await fetch(`${base}/code/${id}/state`, { headers: { cookie: user.cookie }, redirect: 'manual' });
    expect(response.status).toBe(200);
    return response.json() as Promise<CodingSnapshot>;
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'so-coding-http-')));
    repo = gitProject('garden'); otherRepo = gitProject('another'); outsideRepo = gitProject('outside');
    store = openStore(join(root, 'orders.db'));
    const owner = addApprover(store, 'alex', new Date());
    if (!owner.ok) throw Error('Owner fixture could not be created');
    passwords.set('alex', owner.token);
    for (const name of ['bob', 'vera']) {
      const added = addApprover(store, name, new Date(), { name: 'alex', token: owner.token });
      if (!added.ok) throw Error('Account fixture could not be created');
      passwords.set(name, added.token);
    }
    store.raw().prepare("UPDATE approver SET role='viewer' WHERE name='vera'").run();
    expect(store.setAccountProjects('bob', [repo], 'alex', new Date())).toEqual({ ok: true });
    provider = new FakeCodingProvider(); providerStarts = 0;
    workspace = new CodingWorkspace({ database: join(root, 'orders.db.coding.sqlite'), worktreeRoot: join(root, 'worktrees'), provider: () => { providerStarts++; return provider; }, authorize: (actor, project) => { const account = store.accountOf(actor.name); return store.isInstanceOperator(actor.name) && account?.generation === actor.generation && store.accountCanAccess(actor.name, project); }, context: input => prepareCodingContext(store, { ...input, root: join(root, 'context') }) });
    server = createDecisionServer({ store, evidenceRoot: join(root, 'evidence'), repos: [repo, otherRepo], codingWorkspace: workspace });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw Error('No HTTP listener');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    provider.closeGate = null;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    else await workspace.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    passwords.clear();
  });

  test('anonymous and bearer callers cannot open or create coding sessions', async () => {
    const anonymous = await fetch(`${base}/code`, { redirect: 'manual' });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/login');
    const bearer = { authorization: `Bearer alex:${passwords.get('alex')}` };
    expect((await fetch(`${base}/code`, { headers: bearer })).status).toBe(403);
    expect((await fetch(`${base}/code/start`, { method: 'POST', headers: bearer, body: new URLSearchParams({ repo, prompt: 'Change welcome', requestId: 'anonymous-request-0001', password: passwords.get('alex')! }), redirect: 'manual' })).status).toBe(403);
    expect(providerStarts).toBe(0); expect(provider.calls).toEqual([]);
  });

  test('signing in from a coding deep link returns to the same session without restarting it', async () => {
    const user = await login(), id = await start(user), calls = provider.calls.length;
    const saved = await state(id, user);
    provider.note(saved.session.nativeThreadId!, 'turn/completed', { turn: { id: saved.session.turnId, status: 'completed' } });
    writeFileSync(join(saved.session.worktree, 'welcome.txt'), 'Welcome to the garden\n');
    execFileSync('git', ['-C', saved.session.worktree, 'commit', '-am', 'Improve welcome', '-q']);
    for (const destination of ['/code', `/code/${id}`, `/code/${id}/ship`]) {
      const anonymous = await fetch(`${base}${destination}`, { redirect: 'manual' });
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toBe(`/login?return=${encodeURIComponent(destination)}`);
      const signedIn = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: user.name, token: passwords.get(user.name)!, return: destination }), redirect: 'manual' });
      expect(signedIn.status).toBe(303); expect(signedIn.headers.get('location')).toBe(destination);
      const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
      expect((await fetch(`${base}${destination}`, { headers: { cookie } })).status).toBe(200);
    }
    expect(provider.calls).toHaveLength(calls); expect(providerStarts).toBe(1);
  });

  test('opening and polling the workspace do not create sessions or call the agent', async () => {
    const user = await login();
    for (let count = 0; count < 3; count++) expect((await fetch(`${base}/code`, { headers: { cookie: user.cookie } })).status).toBe(200);
    expect(workspace.list({ name: user.name, generation: store.accountOf(user.name)!.generation })).toEqual([]);
    expect(providerStarts).toBe(0);
    const id = await start(user), calls = provider.calls.length;
    const before = await state(id, user);
    for (let count = 0; count < 3; count++) expect(await state(id, user)).toEqual(before);
    expect(providerStarts).toBe(1); expect(provider.calls).toHaveLength(calls);
    expect((await fetch(`${base}/code/${'a'.repeat(32)}/state`, { headers: { cookie: user.cookie } })).status).toBe(409);
    expect(provider.calls).toHaveLength(calls);
  });

  test('start requires password, valid CSRF and origin before touching the project', async () => {
    const user = await login();
    const fields = initial(user);
    const noPassword = { ...fields }; delete (noPassword as Partial<typeof fields>).password;
    expect((await post('/code/start', user, noPassword)).status).toBe(403);
    expect((await post('/code/start', user, { ...fields, password: 'incorrect' })).status).toBe(403);
    expect((await post('/code/start', user, { ...fields, csrf: '0'.repeat(64) })).status).toBe(403);
    expect((await post('/code/start', user, fields, { origin: 'https://outside.example' })).status).toBe(403);
    expect(providerStarts).toBe(0); expect(provider.calls).toEqual([]);
    const duplicated = new URLSearchParams({ csrf: user.csrf, ...fields }); duplicated.append('password', fields.password);
    expect((await fetch(`${base}/code/start`, { method: 'POST', headers: { cookie: user.cookie, accept: 'application/json' }, body: duplicated })).status).toBe(400);
    expect(providerStarts).toBe(0);
    expect((await post('/code/start', user, fields, { origin: base })).status).toBe(200);
    expect(provider.calls.map(call => call.method)).toEqual(['thread/start', 'turn/start']);
  });

  test('a signed-in owner can steer the same authorized session without another password or duplicate turn', async () => {
    const user = await login(), id = await start(user);
    const fields = { prompt: 'Make the heading shorter.', requestId: 'followup-http-request-0001' };
    expect((await post(`/code/${id}/send`, user, fields)).status).toBe(200);
    const latest = provider.calls.at(-1)!;
    expect(latest).toMatchObject({ method: 'turn/steer', params: { threadId: 'native-1', expectedTurnId: 'native-1-turn', clientUserMessageId: fields.requestId } });
    const count = provider.calls.length;
    expect((await post(`/code/${id}/send`, user, fields)).status).toBe(200);
    expect(provider.calls).toHaveLength(count);
    expect((await post(`/code/${id}/send`, user, { ...fields, prompt: 'Different text' })).status).toBe(409);
    expect(provider.calls).toHaveLength(count);
    expect(provider.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
  });

  test('sessions, changes and project choices remain isolated by account and server ceiling', async () => {
    expect(store.setAccountProjects('bob', null, 'alex', new Date()).ok).toBe(true);
    const owner = await login(), limited = await login('bob');
    const id = await start(owner);
    const ownState = await state(id, owner);
    writeFileSync(join(ownState.session.worktree, 'welcome.txt'), 'Private owner revision\n');
    const ownerDiff = await fetch(`${base}/code/${id}/changes`, { headers: { cookie: owner.cookie } });
    expect(ownerDiff.status).toBe(200); expect(await ownerDiff.text()).toContain('Private owner revision');
    const calls = provider.calls.length;
    for (const suffix of ['', '/state', '/changes']) {
      const response = await fetch(`${base}/code/${id}${suffix}`, { headers: { cookie: limited.cookie } });
      expect(response.status).toBe(suffix ? 409 : 404); expect(await response.text()).not.toContain('Private owner revision');
    }
    expect((await post(`/code/${id}/send`, limited, { prompt: 'Edit another account', requestId: 'foreign-send-request-0001' })).status).toBe(409);
    expect((await post('/code/start', limited, initial(limited, 'hidden-repo-request-0001', outsideRepo))).status).toBe(403);
    expect((await post('/code/start', owner, initial(owner, 'outside-repo-request-001', outsideRepo))).status).toBe(403);
    const page = await (await fetch(`${base}/code`, { headers: { cookie: limited.cookie } })).text();
    expect(page).not.toContain('Improve welcome'); expect(page).not.toContain(`value="${outsideRepo}"`);
    expect(provider.calls).toHaveLength(calls);
    expect(await start(limited, 'bob-authorized-request-0001')).not.toBe(id);
  });

  test('project-scoped approvers keep Work but cannot use any coding read or mutation', async () => {
    const owner = await login(), id = await start(owner), scoped = await login('bob');
    const calls = provider.calls.length;
    const work = await fetch(`${base}/work`, { headers: { cookie: scoped.cookie } });
    expect(work.status).toBe(200); const html = await work.text();
    expect(html).toContain('href="/work"'); expect(html).not.toContain('href="/code"');
    for (const suffix of ['', `/${id}`, `/${id}/state`, `/${id}/changes`, `/${id}/ship`]) {
      const response = await fetch(`${base}/code${suffix}`, { headers: { cookie: scoped.cookie } });
      expect(response.status, suffix).toBe(403);
      expect(await response.text()).not.toContain('Make the welcome clearer.');
    }
    for (const path of ['/code', '/code/start', ...['send', 'stop', 'resume', 'recover', 'continue', 'ship', 'answer'].map(action => `/code/${id}/${action}`)]) {
      const response = await post(path, scoped, { ...initial(scoped), decision: 'accept' });
      expect(response.status, path).toBe(403);
    }
    expect(provider.calls).toHaveLength(calls); expect(provider.answers).toEqual([]);
    expect(workspace.list({ name: scoped.name, generation: store.accountOf(scoped.name)!.generation })).toEqual([]);
  });

  test('coding login returns accept only an exact session or shipping page', async () => {
    const id = 'a'.repeat(32);
    for (const destination of [`/code/${id}/send`, `/code/${id}/state`, '/code/ship', `/code/${id}/ship/extra`, `//outside.example/code/${id}/ship`, `/code/${id}%2f%2foutside.example/ship`]) {
      const response = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: 'alex', token: passwords.get('alex')!, return: destination }), redirect: 'manual' });
      expect(response.status).toBe(303); expect(response.headers.get('location'), destination).toBe('/');
    }
  });

  test('viewer credentials cannot read native session history or run coding actions', async () => {
    const owner = await login(), id = await start(owner), viewer = await login('vera');
    const calls = provider.calls.length;
    for (const suffix of ['', `/${id}`, `/${id}/state`, `/${id}/changes`]) expect((await fetch(`${base}/code${suffix}`, { headers: { cookie: viewer.cookie } })).status).toBe(403);
    expect((await post('/code/start', viewer, initial(viewer))).status).toBe(403);
    expect((await post(`/code/${id}/send`, viewer, { prompt: 'Change text', requestId: 'viewer-request-0001' })).status).toBe(403);
    expect(provider.calls).toHaveLength(calls);
  });

  test('additional command access needs an explicit decision and password; decline and stale requests cannot approve', async () => {
    const user = await login(), id = await start(user);
    provider.emit({ kind: 'request', id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-1', turnId: 'native-1-turn', command: 'npm run build', reason: 'Additional access is required.' } });
    const requestId = (await state(id, user)).requests[0]!.id;
    const answer = `/code/${id}/answer`;
    expect((await post(answer, user, { requestId })).status).toBe(400);
    expect((await post(answer, user, { requestId, decision: 'accept' })).status).toBe(403);
    expect((await post(answer, user, { requestId, decision: 'accept', password: 'wrong' })).status).toBe(403);
    expect(provider.answers).toEqual([]);
    expect((await post(answer, user, { requestId, decision: 'accept', password: passwords.get(user.name)! })).status).toBe(200);
    expect(provider.answers).toEqual([{ id: 'approval-1', result: { decision: 'accept' } }]);
    expect((await post(answer, user, { requestId, decision: 'accept', password: passwords.get(user.name)! })).status).toBe(409);
    expect(provider.answers).toHaveLength(1);
    provider.emit({ kind: 'request', id: 'approval-2', method: 'item/fileChange/requestApproval', params: { threadId: 'native-1', turnId: 'native-1-turn' } });
    const next = (await state(id, user)).requests[0]!.id;
    expect((await post(answer, user, { requestId: next, decision: 'decline' })).status).toBe(200);
    expect(provider.answers.at(-1)).toEqual({ id: 'approval-2', result: { decision: 'decline' } });
  });

  test('credential revocation denies future reads, sends and pending approvals', async () => {
    const user = await login(), id = await start(user);
    provider.emit({ kind: 'request', id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: 'native-1' } });
    const requestId = (await state(id, user)).requests[0]!.id;
    const calls = provider.calls.length;
    // Bob is project-scoped; restore an unrestricted administrator before
    // revoking Alex so the normal last-operator safeguard remains intact.
    expect(store.setAccountProjects('bob', null, 'alex', new Date())).toEqual({ ok: true });
    expect(store.revokeAccount('alex', 'bob', new Date()).ok).toBe(true);
    const read = await fetch(`${base}/code/${id}/state`, { headers: { cookie: user.cookie }, redirect: 'manual' });
    expect(read.status).toBe(303);
    expect((await post(`/code/${id}/send`, user, { prompt: 'After revocation', requestId: 'revoked-request-0001' })).status).toBe(401);
    expect((await post(`/code/${id}/answer`, user, { requestId, decision: 'accept', password: passwords.get(user.name)! })).status).toBe(401);
    expect(provider.calls).toHaveLength(calls); expect(provider.answers).toEqual([]);
  });

  test('state polling does not keep an idle browser login alive', async () => {
    let at = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => at);
    const user = await login(), id = await start(user), calls = provider.calls.length;
    at += 11 * 60 * 60_000;
    expect((await fetch(`${base}/code/${id}/state`, { headers: { cookie: user.cookie }, redirect: 'manual' })).status).toBe(200);
    at += 2 * 60 * 60_000;
    const expired = await fetch(`${base}/code/${id}/state`, { headers: { cookie: user.cookie }, redirect: 'manual' });
    expect(expired.status).toBe(303); expect(expired.headers.get('location')).toContain('/login');
    expect(provider.calls).toHaveLength(calls);
  });

  test('HTTP server close waits for verified provider shutdown before completing', async () => {
    const user = await login(); await start(user);
    let release!: () => void;
    provider.closeGate = new Promise<void>(resolve => { release = resolve; });
    let completed = false;
    const closed = new Promise<void>((resolve, reject) => server.close(error => { completed = true; error ? reject(error) : resolve(); }));
    try {
      await vi.waitFor(() => expect(provider.closeCalls).toBe(1));
      expect(completed).toBe(false);
      release();
      await closed;
      expect(completed).toBe(true); expect(server.listening).toBe(false);
    } finally { release(); await closed; }
  });
  test('the browser start freezes admitted project guidance into the native conversation', async () => {
    const view = knowledgeView(store, repo, 'alex');
    changeKnowledge(store, { repo, actor: 'alex', identity: view.identity, revision: view.revision, action: 'instructions', draft: { instructions: 'Keep game labels short and readable.' } });
    const user = await login(), id = await start(user);
    expect(provider.calls.find(call => call.method === 'thread/start')?.params.developerInstructions).toContain('Keep game labels short and readable.');
    const saved = await state(id, user);
    expect(saved.session.context?.metadata.knowledge.revision).toBe(1);
    expect(saved.session.context?.metadata.baseRevision).toBe(saved.session.base);
  });

  test('revocation while native startup is pending prevents the first prompt from dispatching', async () => {
    expect(store.setAccountProjects('bob', null, 'alex', new Date()).ok).toBe(true);
    const user = await login();
    let entered!: () => void, release!: () => void;
    const atNativeStart = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = provider.request.bind(provider);
    vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/start') { entered(); await gate; }
      return original(method, params);
    });
    const sending = post('/code/start', user, initial(user));
    await atNativeStart;
    try { expect(store.revokeAccount('alex', 'bob', new Date()).ok).toBe(true); }
    finally { release(); }
    const response = await sending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(provider.calls.some(call => call.method === 'turn/start')).toBe(false);
  });

  test('losing installation-wide access during native resume prevents a follow-up dispatch even when project access remains', async () => {
    expect(store.setAccountProjects('bob', null, 'alex', new Date()).ok).toBe(true);
    const user = await login('bob'), id = await start(user);
    const nativeThreadId = (await state(id, user)).session.nativeThreadId!;
    provider.note(nativeThreadId, 'turn/completed', { turn: { status: 'completed' } });
    provider.emit({ kind: 'exit', message: 'Fixture connection was closed after completing the turn.' });
    let entered!: () => void, release!: () => void;
    const atNativeResume = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = provider.request.bind(provider), sentBefore = provider.calls.filter(call => call.method === 'turn/start').length;
    vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/resume') { entered(); await gate; }
      return original(method, params);
    });
    const sending = post(`/code/${id}/send`, user, { prompt: 'Follow-up after access changes.', requestId: 'project-revoked-pending-01' });
    await atNativeResume;
    try { expect(store.setAccountProjects('bob', [repo], 'alex', new Date()).ok).toBe(true); }
    finally { release(); }
    const response = await sending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(provider.calls.filter(call => call.method === 'turn/start')).toHaveLength(sentBefore);
  });

  test('a changes response rechecks access after its asynchronous read finishes', async () => {
    expect(store.setAccountProjects('bob', null, 'alex', new Date()).ok).toBe(true);
    const user = await login(), id = await start(user);
    let entered!: () => void, release!: () => void;
    const readFinished = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = workspace.changes.bind(workspace);
    vi.spyOn(workspace, 'changes').mockImplementation(async (...args) => {
      const result = await original(...args); entered(); await gate; return result;
    });
    const reading = fetch(`${base}/code/${id}/changes`, { headers: { cookie: user.cookie, accept: 'application/json' }, redirect: 'manual' });
    await readFinished;
    try { expect(store.revokeAccount('alex', 'bob', new Date()).ok).toBe(true); }
    finally { release(); }
    const response = await reading;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('"head"');
  });

  test.each(['changes', 'send'] as const)('a pending %s response rechecks operator status independently of project access and generation', async action => {
    expect(store.setAccountProjects('bob', null, 'alex', new Date()).ok).toBe(true);
    const user = await login('bob'), id = await start(user), generation = store.accountOf(user.name)!.generation;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (action === 'changes') {
      const original = workspace.changes.bind(workspace);
      vi.spyOn(workspace, 'changes').mockImplementation(async (...args) => { const result = await original(...args); entered(); await gate; return result; });
    } else {
      const original = workspace.send.bind(workspace);
      vi.spyOn(workspace, 'send').mockImplementation(async (...args) => { const result = await original(...args); entered(); await gate; return result; });
    }
    const pending = action === 'changes'
      ? fetch(`${base}/code/${id}/changes`, { headers: { cookie: user.cookie, accept: 'application/json' }, redirect: 'manual' })
      : post(`/code/${id}/send`, user, { prompt: 'Shorten the greeting.', requestId: 'operator-changing-request-01' });
    await waiting;
    try {
      // Hold generation steady to test the operator gate independently of the
      // separate credential-generation check; ordinary access edits bump it.
      store.raw().prepare('UPDATE approver SET projects_json=? WHERE name=?').run(JSON.stringify([repo]), user.name);
      expect(store.accountOf(user.name)!.generation).toBe(generation);
      expect(store.accountCanAccess(user.name, repo)).toBe(true);
      expect(store.isInstanceOperator(user.name)).toBe(false);
    } finally { release(); }
    const response = await pending;
    expect(response.status).toBe(403);
    const result = await response.text(); expect(result).not.toContain('"head"'); expect(result).not.toContain('"ok":true');
    if (action === 'send') expect(JSON.parse(result)).toMatchObject({ delivery: 'unknown', sessionId: id });
  });

  test('shipping hands the exact committed result to an unapproved review task once', async () => {
    for (const phase of ['plan', 'build', 'review'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'alex', new Date());
    const user = await login(), id = await start(user), saved = await state(id, user);
    provider.note(saved.session.nativeThreadId!, 'turn/completed', { turn: { id: saved.session.turnId, status: 'completed' } });
    writeFileSync(join(saved.session.worktree, 'welcome.txt'), 'Welcome to the garden\n');
    const dirty = await fetch(`${base}/code/${id}/ship`, { headers: { cookie: user.cookie } });
    expect(dirty.status).toBe(409); expect(await dirty.text()).toContain('Commit the coding changes');
    execFileSync('git', ['-C', saved.session.worktree, 'add', 'welcome.txt']);
    execFileSync('git', ['-C', saved.session.worktree, 'commit', '-qm', 'Improve welcome']);
    const candidate = execFileSync('git', ['-C', saved.session.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const preview = await fetch(`${base}/code/${id}/ship`, { headers: { cookie: user.cookie } });
    expect(preview.status).toBe(200); const html = await preview.text();
    expect(html).toContain('Create review task'); expect(html).toContain(candidate); expect(html).toContain('welcome.txt');
    expect(html).toContain('placeholder="One observable result per line"></textarea>');
    const fields = { base: saved.session.base, candidate, title: 'Review welcome', goal: 'Make the greeting clear.', acceptance: 'The welcome screen says Welcome to the garden.' };
    expect((await post(`/code/${id}/ship`, user, { ...fields, csrf: 'wrong' })).status).toBe(403);
    const response = await post(`/code/${id}/ship`, user, fields); expect(response.status).toBe(200);
    const result = await response.json() as { taskId: string };
    expect(store.getScope(result.taskId)).toMatchObject({ candidate, approvedAt: null, approvedBy: null });
    const approvalPage = await (await fetch(`${base}/t/${result.taskId}`, { headers: { cookie: user.cookie } })).text();
    expect(approvalPage).toContain(`<p class="approval-label">Saved commit</p><p style="overflow-wrap:anywhere"><code>${candidate}</code></p>`);
    expect(execFileSync('git', ['-C', repo, 'rev-parse', `standing-orders/${result.taskId}`], { encoding: 'utf8' }).trim()).toBe(saved.session.base);
    expect((await post(`/code/${id}/ship`, user, fields)).status).toBe(200);
    expect(store.listTasks()).toHaveLength(1);
    expect((await post(`/code/${id}/ship`, user, { ...fields, candidate: saved.session.base })).status).toBe(409);
  });

});
