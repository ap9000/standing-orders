import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { CodingWorkspace } from './coding-workspace.js';
import type { CodingProvider, CodingProviderEvent } from './coding-provider.js';
import { createSessionEndpoint } from './session-server.js';
import { runSessionCommand } from './session-cli.js';

class Provider implements CodingProvider {
  listeners = new Set<(event: CodingProviderEvent) => void>();
  calls: string[] = [];
  emit(event: CodingProviderEvent) { for (const listener of this.listeners) listener(event); }
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push(method);
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'saved-thread', turns: [] } };
    if (method === 'turn/start' || method === 'turn/steer') {
      this.emit({ kind: 'notification', method: 'turn/started', params: { threadId: 'saved-thread', turn: { id: 'saved-turn' } } });
      this.emit({ kind: 'notification', method: 'item/completed', params: { threadId: 'saved-thread', item: { id: params['clientUserMessageId'], type: 'userMessage', content: params['input'], clientUserMessageId: params['clientUserMessageId'] } } });
      return { turn: { id: 'saved-turn' }, turnId: 'saved-turn' };
    }
    if (method === 'turn/interrupt') this.emit({ kind: 'notification', method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'saved-turn', status: 'interrupted' } } });
    return {};
  }
  respond() {} reject() {} processId() { return null; }
  custody() { return { pid: null, group: false, descendants: [], observationUnknown: false, host: '', bootId: null }; }
  subscribe(listener: (event: CodingProviderEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() { this.emit({ kind: 'exit', message: 'closed' }); }
}

let dir: string, repo: string, url: string, token: string, store: Store, owner: CodingWorkspace, provider: Provider, server: Server;
let endpoint: ReturnType<typeof createSessionEndpoint>;
let admitted: string[];
const actor = { name: 'operator', generation: 1 };
const connect = (workspace: CodingWorkspace | null) => createSessionEndpoint({ store, workspace, projects: () => admitted, projectAllowed: project => project === repo });
const open = () => new CodingWorkspace({ database: join(dir, 'coding.sqlite'), worktreeRoot: join(dir, 'worktrees'), provider: () => provider,
  authorize: (who, project) => store.isInstanceOperator(who.name) && store.accountOf(who.name)?.generation === who.generation && admitted.includes(project) });
async function cli(args: string[], name = actor.name, secret = token) {
  const lines: string[] = [];
  const code = await runSessionCommand([...args, '--url', url, '--as', name, '--token-env', 'SESSION_TEST_TOKEN', '--json'], line => lines.push(line), { env: { SESSION_TEST_TOKEN: secret }, readStdin: async () => 'Improve the welcome message.' });
  return { code, body: JSON.parse(lines.join('\n')) };
}
const controls = (session: { id: string; revision: number; nativeThreadId: string | null; turnId: string | null }, key: string) => [session.id, '--key', key, '--revision', String(session.revision), '--thread', session.nativeThreadId ?? 'none', '--turn', session.turnId ?? 'none'];

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-session-owner-'))); repo = join(dir, 'repo');
  admitted = [repo];
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.test']); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'welcome.txt'), 'Welcome\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'Initial']);
  store = openStore(':memory:'); const account = addApprover(store, actor.name, new Date()); if (!account.ok) throw Error('fixture'); token = account.token;
  provider = new Provider(); owner = open(); endpoint = connect(owner);
  server = createServer((request, response) => { void endpoint(request, response).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw Error('listen fixture'); url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await owner.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

test('CLI and direct workspace controls share one thread, saved activity and receipts through cold reconnect', async () => {
  const start = ['start', '--project', repo, '--title', 'Improve welcome', '--stdin', '--key', 'create-session-0001'];
  const first = await cli(start); expect(first.code).toBe(0);
  let session = first.body.result.session;
  expect(owner.get(session.id, actor).nativeThreadId).toBe(session.nativeThreadId);
  expect((await cli(start)).body.result.session.id).toBe(session.id);
  expect(provider.calls.filter(one => one === 'thread/start')).toHaveLength(1);
  await owner.send(session.id, actor, 'Make the title shorter.', 'browser-followup-001');
  const brief = await cli(['show', session.id]); expect(brief.code).toBe(0);
  expect(brief.body.result.items).toBeUndefined();
  expect(brief.body.result.brief.summary).toContain('Make the title shorter.');
  expect(brief.body.result.brief.sourceRevision).toBe(brief.body.result.session.revision);
  const shown = await cli(['show', session.id, '--view', 'activity']); expect(shown.code).toBe(0); session = shown.body.result.session;
  expect(shown.body.result.items.at(-1).text).toBe('Make the title shorter.');
  const follow = await cli(['send', ...controls(session, 'cli-followup-000001'), '--stdin']); expect(follow.code).toBe(0); session = follow.body.result.session;
  expect(follow.body.result.receipt.status).toBe('accepted');
  expect((await cli(['stop', ...controls(session, 'stop-session-00001')])).code).toBe(0);
  await owner.close(); owner = open(); endpoint = connect(owner);
  session = (await cli(['show', session.id])).body.result.session;
  const resumed = await cli(['resume', ...controls(session, 'resume-session-001')]); expect(resumed.code).toBe(0);
  expect(resumed.body.result.session.nativeThreadId).toBe('saved-thread');
  expect(provider.calls.filter(one => one === 'thread/start')).toHaveLength(1);
  expect(provider.calls.filter(one => one === 'thread/resume')).toHaveLength(1);
  const changes = await cli(['changes', session.id]); expect(changes.code).toBe(0); expect(changes.body.result.changes.diff).toBe('');
});

test('operator authentication, project authority and unavailable-owner refusals stay structured', async () => {
  expect((await cli(['list'], actor.name, 'invalid')).body).toMatchObject({ status: 'rejected', delivery: 'not-sent' });
  const second = addApprover(store, 'project-member', new Date(), { name: actor.name, token }); if (!second.ok) throw Error('fixture');
  expect(store.setAccountProjects('project-member', [repo], actor.name, new Date()).ok).toBe(true);
  expect((await cli(['list'], 'project-member', second.token)).body).toMatchObject({ status: 'rejected', delivery: 'not-sent' });
  const foreign = await cli(['start', '--project', dir, '--title', 'Foreign project', '--stdin', '--key', 'foreign-start-00001']);
  expect(foreign.body).toMatchObject({ status: 'rejected', delivery: 'not-sent' }); expect(provider.calls).toHaveLength(0);
  endpoint = connect(null);
  const missing = await cli(['start', '--project', repo, '--title', 'Unavailable owner', '--stdin', '--key', 'missing-owner-00001']);
  expect(missing.body).toMatchObject({ status: 'rejected', delivery: 'not-sent', reason: 'session-unavailable' });
});

test('removing an admitted project blocks reads and controls of its existing session', async () => {
  const started = await cli(['start', '--project', repo, '--title', 'Improve welcome', '--stdin', '--key', 'admission-start-001']);
  const session = started.body.result.session, count = provider.calls.length;
  admitted = [];
  expect((await cli(['show', session.id])).body).toMatchObject({ status: 'rejected', delivery: 'not-sent' });
  expect((await cli(['send', ...controls(session, 'removed-send-000001'), '--stdin'])).body).toMatchObject({ status: 'rejected', delivery: 'not-sent' });
  expect((await cli(['list'])).body.result.sessions).toEqual([]);
  expect(provider.calls).toHaveLength(count);
});

test('credential rotation during cold reconnect prevents the CLI instruction reaching the native turn', async () => {
  const started = await cli(['start', '--project', repo, '--title', 'Improve welcome', '--stdin', '--key', 'rotation-start-001']);
  await owner.close(); owner = open(); endpoint = connect(owner);
  const session = (await cli(['show', started.body.result.session.id])).body.result.session;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const request = provider.request.bind(provider);
  provider.request = async (method, params) => { if (method === 'thread/resume') { entered(); await hold; } return request(method, params); };
  const count = provider.calls.filter(one => one === 'turn/start' || one === 'turn/steer').length;
  const sending = cli(['send', ...controls(session, 'rotation-send-0001'), '--stdin']);
  await loading;
  try { expect(addApprover(store, actor.name, new Date(), { name: actor.name, token }).ok).toBe(true); }
  finally { release(); }
  const response = await sending;
  expect(response.body.ok).toBe(false);
  expect(response.body.result).toBeUndefined();
  expect(provider.calls.filter(one => one === 'turn/start' || one === 'turn/steer')).toHaveLength(count);
});
