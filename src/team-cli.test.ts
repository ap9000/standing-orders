import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from './cli.js';
import { maybeRunTeamCommand, type TeamCliOptions } from './team-cli.js';
import type { TeamChatAuthorization, TeamMessage, TeamRequest, TeamResponse, TeamSnapshot } from './team-contract.js';

const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const secret = 'individual-private-sign-in';
const id = 'a'.repeat(32);
const grant: TeamChatAuthorization = { enabled: true, provider: 'configured-provider', model: 'configured-model', dailyTurns: 12, weeklyCeilingUsd: 8, conversationCeilingUsd: 2, termsDigest: 'terms-v1' };
const message = (patch: Partial<TeamMessage> = {}): TeamMessage => ({ id: 1, author: 'alex', role: 'operator', text: 'Please inspect the change.', status: 'queued', revision: 1, createdAt: '2026-09-21T12:00:00Z', requestId: id, turnId: null, error: null, ...patch });
const snapshot = (patch: Partial<TeamSnapshot> = {}): TeamSnapshot => ({ leads: [{ id: 'lead-one', name: 'Release lead', instructions: 'Review changes.', projects: ['/server/repo'], revision: 1, status: 'active', createdBy: 'alex' }], conversations: [], selected: { id: 'room-one', leadId: 'lead-one', title: 'Release planning', visibility: 'private', projects: ['/server/repo'], revision: 2, threadId: 1, createdBy: 'alex', follow: false }, participants: [{ account: 'alex', role: 'manager', active: true }], messages: [], canManage: true, canSend: true, cursor: 1, truncated: false, projects: ['/server/repo'], accounts: ['alex'], chatAuthorization: { ...grant }, ...patch });
const okay = (patch: Partial<TeamResponse> = {}): TeamResponse => ({ version: 1, ok: true, code: 'okay', message: 'Saved.', snapshot: snapshot(), ...patch });
function fixture(connected = true) {
  const directory = mkdtempSync(join(tmpdir(), 'so-team-cli-')); temporary.push(directory);
  const profileFile = join(directory, 'remote', 'profiles.json');
  if (connected) {
    mkdirSync(dirname(profileFile), { mode: 0o700 });
    writeFileSync(profileFile, JSON.stringify({ version: 1, active: 'work', profiles: { work: { origin: 'https://console.example.test', account: 'alex', token: secret } } }), { mode: 0o600 });
  }
  const requests: TeamRequest[] = [], inits: RequestInit[] = [], urls: string[] = [], lines: string[] = [], errors: string[] = [];
  let handle: (request: TeamRequest) => TeamResponse | Response | Promise<TeamResponse | Response> = () => okay();
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(url)); inits.push(init!); const request = JSON.parse(String(init?.body)) as TeamRequest; requests.push(request);
    const result = await handle(request);
    return result instanceof Response ? result : Response.json(result, { status: result.ok ? 200 : 409 });
  });
  const options: TeamCliOptions = { profileFile, fetch: fetcher as typeof fetch, env: { XDG_CONFIG_HOME: join(directory, 'config'), STANDING_ORDERS_DB: join(directory, 'must-not-open.db') }, stderr: line => errors.push(line), isTTY: false };
  return { directory, profileFile, requests, inits, urls, lines, errors, options, fetcher, setHandler: (next: typeof handle) => { handle = next; }, run: (args: string[]) => maybeRunTeamCommand(args, line => lines.push(line), options), result: () => JSON.parse(lines.at(-1)!) as TeamResponse & { command: string } };
}

describe('central team CLI', () => {
  it('connects with stdin credentials, stores only a private profile, and never puts secrets in URLs or output', async () => {
    const f = fixture(false); f.options.readStdin = async () => `${secret}\n`;
    expect(await f.run(['connect', 'https://console.example.test', '--as', 'alex', '--token-stdin', '--profile', 'work', '--json'])).toBe(0);
    expect(f.requests).toEqual([{ operation: 'list', args: {} }]);
    expect(f.urls).toEqual(['https://console.example.test/api/team']);
    expect(f.inits[0]).toMatchObject({ redirect: 'manual', credentials: 'omit', headers: { authorization: `Bearer alex:${secret}` } });
    expect(statSync(f.profileFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(f.profileFile)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(f.profileFile, 'utf8')).profiles.work.token).toBe(secret);
    expect(f.lines.join('\n')).not.toContain(secret);
    expect(existsSync(f.options.env!.STANDING_ORDERS_DB!)).toBe(false);
  });

  it('accepts an explicitly selected local login without opening the local database', async () => {
    const f = fixture(false), login = join(f.directory, 'up-login.txt');
    writeFileSync(login, `alex ${secret}\n`, { mode: 0o600 });
    expect(await f.run(['connect', 'http://127.0.0.1:4180', '--local-login', '--login-file', login, '--json'])).toBe(0);
    expect(f.inits[0]!.headers).toMatchObject({ authorization: `Bearer alex:${secret}` });
    expect(existsSync(f.options.env!.STANDING_ORDERS_DB!)).toBe(false);
    expect(await f.run(['connect', 'http://127.0.0.1:4180', '--as', 'other', '--local-login', '--login-file', login, '--json'])).toBe(2);
    expect(f.requests).toHaveLength(1);
  });

  it.each(['http://console.example.test', 'https://alex:secret@console.example.test', 'https://console.example.test/?token=secret', 'https://console.example.test/path'])('rejects unsafe origin %s before reading or sending credentials', async origin => {
    const f = fixture(false); const stdin = vi.fn(async () => secret); f.options.readStdin = stdin;
    expect(await f.run(['connect', origin, '--as', 'alex', '--token-stdin', '--json'])).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(stdin).not.toHaveBeenCalled(); expect(existsSync(f.profileFile)).toBe(false);
  });

  it('refuses public and symlink credential files and does not save credentials after a redirect', async () => {
    const f = fixture(false), token = join(f.directory, 'token'), link = join(f.directory, 'link');
    writeFileSync(token, secret, { mode: 0o644 });
    const args = ['connect', 'https://console.example.test', '--as', 'alex', '--token-file'];
    expect(await f.run([...args, token, '--json'])).toBe(2); chmodSync(token, 0o600); symlinkSync(token, link);
    expect(await f.run([...args, link, '--json'])).toBe(2); expect(f.fetcher).not.toHaveBeenCalled();
    f.setHandler(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.test' } }));
    expect(await f.run([...args, token, '--json'])).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(existsSync(f.profileFile)).toBe(false);
    expect(f.lines.join('\n')).not.toContain(secret);
  });

  it('dispatches an active profile before local DB access while preserving local commands without a profile', async () => {
    const f = fixture();
    expect(await main(['brief', '--lead', 'lead-one', '--conversation', 'room-one', '--json'], line => f.lines.push(line), { team: f.options, operate: { databaseFile: f.options.env!.STANDING_ORDERS_DB! } })).toBe(0);
    expect(f.requests).toEqual([{ operation: 'show', args: { conversationId: 'room-one' } }]);
    expect(existsSync(f.options.env!.STANDING_ORDERS_DB!)).toBe(false);
    expect(await f.run(['brief', '--local'])).toBeNull();
    const empty = fixture(false); expect(await empty.run(['brief', '--json'])).toBeNull();
    expect(await empty.run(['chat', '--lead', 'lead-one', '--conversation', 'room-one', '--json'])).toBe(2);
    expect(empty.fetcher).not.toHaveBeenCalled();
    expect(await f.run(['chat', '--local', '--conversation', 'room-one', '--json'])).toBe(2);
    expect(await main(['task', 'list', '--profile', 'work', '--json'], line => f.lines.push(line), { team: f.options, operate: { databaseFile: f.options.env!.STANDING_ORDERS_DB! } })).toBe(2);
    expect(existsSync(f.options.env!.STANDING_ORDERS_DB!)).toBe(false);
  });

  it('sends exact lead, conversation and membership args, never client actor authority', async () => {
    const f = fixture();
    expect(await f.run(['lead', 'create', '--name', 'Release', '--instructions', 'Inspect changes.', '--project', '/server/a', '--project', '/server/b', '--json'])).toBe(0);
    expect(await f.run(['conversation', 'create', '--lead', 'lead-one', '--title', 'Release planning', '--visibility', 'team', '--project', '/server/a', '--json'])).toBe(0);
    expect(await f.run(['lead', 'member', '--lead', 'lead-one', '--account', 'sam', '--role', 'contributor', '--active', 'true', '--revision', '2', '--json'])).toBe(0);
    expect(await f.run(['conversation', 'member', '--conversation', 'room-one', '--account', 'sam', '--role', 'contributor', '--active', 'true', '--revision', '2', '--json'])).toBe(0);
    expect(f.requests).toEqual([
      { operation: 'create-lead', args: { name: 'Release', instructions: 'Inspect changes.', projects: ['/server/a', '/server/b'] } },
      { operation: 'create-conversation', args: { leadId: 'lead-one', title: 'Release planning', visibility: 'team', projects: ['/server/a'] } },
      { operation: 'member', args: { leadId: 'lead-one', account: 'sam', role: 'contributor', active: true, expectedRevision: 2 } },
      { operation: 'member', args: { conversationId: 'room-one', account: 'sam', role: 'contributor', active: true, expectedRevision: 2 } },
    ]);
  });

  it('prints list identities and revisions even when the server also selects a conversation', async () => {
    const f = fixture(); f.setHandler(() => okay({ snapshot: snapshot({ conversations: [snapshot().selected!], messages: [message()] }) }));
    expect(await f.run(['lead', 'list'])).toBe(0);
    expect(f.lines.at(-1)).toContain('lead-one  Release lead · active · revision 1');
    expect(f.lines.at(-1)).not.toContain('Please inspect the change.');
    expect(await f.run(['conversation', 'list', '--lead', 'lead-one'])).toBe(0);
    expect(f.lines.at(-1)).toContain('room-one  Release planning · lead lead-one · private · revision 2');
    expect(f.lines.at(-1)).not.toContain('Please inspect the change.');
    f.setHandler(() => okay({ result: { leadId: 'new-lead' } }));
    expect(await f.run(['lead', 'create', '--name', 'New lead', '--instructions', 'Inspect.', '--project', '/server/repo'])).toBe(0);
    expect(f.lines.at(-1)).toContain('Lead: new-lead');
  });

  it('returns current paid terms without buying chat and rejects stale authorization terms', async () => {
    const f = fixture(); f.setHandler(() => okay({ snapshot: snapshot({ canSend: false, chatAuthorization: { ...grant, enabled: false } }) }));
    const args = ['chat', '--lead', 'lead-one', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--json'];
    expect(await f.run(args)).toBe(1); expect(f.result().code).toBe('grant-needed'); expect(f.result().snapshot!.chatAuthorization).toEqual({ ...grant, enabled: false });
    expect(await f.run([...args, '--authorize', '--terms-digest', 'old-terms'])).toBe(1);
    expect(f.requests.every(request => request.operation === 'show')).toBe(true);
  });

  it('authorizes only the displayed exact terms and submits one attributed request', async () => {
    const f = fixture(); let enabled = false;
    f.setHandler(request => {
      if (request.operation === 'authorize') enabled = true;
      return okay({ snapshot: snapshot({ canSend: enabled, chatAuthorization: { ...grant, enabled }, messages: request.operation === 'send' ? [message()] : [] }) });
    });
    expect(await f.run(['chat', '--lead', 'lead-one', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--request-id', id, '--authorize', '--terms-digest', grant.termsDigest, '--json'])).toBe(0);
    expect(f.requests.filter(request => request.operation !== 'show')).toEqual([{ operation: 'authorize', args: { conversationId: 'room-one', termsDigest: grant.termsDigest } }, { operation: 'send', args: { conversationId: 'room-one', requestId: id, text: 'Please inspect the change.' } }]);
    expect(f.result().snapshot!.messages[0]!.requestId).toBe(id);
  });

  it('reports the confirmed new authorization when enabling without submitting a message', async () => {
    const f = fixture(); f.setHandler(request => okay({ snapshot: snapshot({ chatAuthorization: { ...grant, enabled: request.operation === 'authorize' } }) }));
    expect(await f.run(['chat', '--conversation', 'room-one', '--authorize', '--terms-digest', grant.termsDigest, '--json'])).toBe(0);
    expect(f.result().snapshot!.chatAuthorization!.enabled).toBe(true); expect(f.lines).toHaveLength(1);
    expect(f.requests.map(request => request.operation)).toEqual(['show', 'authorize']);
  });

  it('matches the server’s trimmed message receipt and accepts a confirmed self-removal receipt without a snapshot', async () => {
    const f = fixture(); f.setHandler(request => request.operation === 'member' ? { version: 1, ok: true, code: 'ok', message: 'Access removed.' } : okay({ snapshot: snapshot({ messages: request.operation === 'send' ? [message()] : [] }) }));
    expect(await f.run(['chat', '--conversation', 'room-one', '--say', '  Please inspect the change.\n', '--request-id', id, '--json'])).toBe(0);
    expect(f.requests.at(-1)!.args.text).toBe('Please inspect the change.');
    expect(await f.run(['conversation', 'member', '--conversation', 'room-one', '--account', 'alex', '--role', 'viewer', '--active', 'false', '--revision', '2', '--json'])).toBe(0);
    expect(f.result().message).toBe('Access removed.');
  });

  it('shows interactive terms, sends after consent, and makes no idle model requests', async () => {
    const f = fixture(); let enabled = false; const prompts: string[] = [], input = ['Please inspect the change.', 'y', '/quit'];
    f.options.isTTY = true;
    f.options.readLine = async prompt => { prompts.push(prompt); return input.shift() ?? null; };
    f.options.sleep = async (_ms, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); };
    f.setHandler(request => {
      if (request.operation === 'authorize') enabled = true;
      return okay({ snapshot: snapshot({ chatAuthorization: { ...grant, enabled }, messages: request.operation === 'send' ? [message({ requestId: String(request.args.requestId) })] : [] }) });
    });
    expect(await f.run(['chat', '--lead', 'lead-one', '--conversation', 'room-one'])).toBe(0);
    expect(f.requests.map(request => request.operation)).toEqual(['show', 'show', 'authorize', 'send']);
    expect(prompts).toContain('Enable paid chat with these terms? [y/N] ');
    expect(f.errors.join('\n')).toContain('Weekly ceiling: $8'); expect(f.errors.join('\n')).toContain('Conversation ceiling: $2');
  });

  it('reports uncertain delivery after a dropped send and inspects its receipt without resending', async () => {
    const f = fixture();
    f.setHandler(request => { if (request.operation === 'send') throw new Error(`network failed ${secret}`); return okay(); });
    expect(await f.run(['chat', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--request-id', id, '--json'])).toBe(1);
    expect(f.result()).toMatchObject({ code: 'delivery-unconfirmed', result: { requestId: id, conversationId: 'room-one' } });
    f.setHandler(() => okay({ snapshot: snapshot({ messages: [message()] }) }));
    expect(await f.run(['brief', '--conversation', 'room-one', '--request-id', id, '--json'])).toBe(0);
    expect(f.result()).toMatchObject({ result: { receiptStatus: 'recorded', receipt: { id: 1, requestId: id } } });
    expect(f.requests.filter(request => request.operation === 'send')).toHaveLength(1);
    expect(f.lines.join('\n')).not.toContain(secret);
  });

  it('retains the client request identity when the service itself reports unconfirmed delivery', async () => {
    const f = fixture(); f.setHandler(request => request.operation === 'send' ? Response.json({ version: 1, ok: false, code: 'delivery-unconfirmed', message: 'Inspect saved messages.' }, { status: 502 }) : okay());
    expect(await f.run(['chat', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--request-id', id, '--json'])).toBe(1);
    expect(f.result()).toMatchObject({ code: 'delivery-unconfirmed', result: { requestId: id, conversationId: 'room-one' } });
    expect(f.requests.filter(request => request.operation === 'send')).toHaveLength(1);
  });

  it('rejects mismatched conversation and receipt identities and malformed snapshots', async () => {
    const f = fixture(); f.setHandler(() => okay({ snapshot: snapshot({ selected: { ...snapshot().selected!, leadId: 'another-lead' } }) }));
    expect(await f.run(['chat', '--lead', 'lead-one', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--json'])).toBe(1);
    expect(f.result().code).toBe('conversation-mismatch'); expect(f.requests.every(request => request.operation === 'show')).toBe(true);
    f.setHandler(request => okay({ snapshot: snapshot({ messages: request.operation === 'send' ? [message({ requestId: 'b'.repeat(32) })] : [] }) }));
    expect(await f.run(['chat', '--conversation', 'room-one', '--say', 'Please inspect the change.', '--request-id', id, '--json'])).toBe(1);
    expect(f.result().code).toBe('delivery-unconfirmed');
    f.setHandler(() => Response.json({ ...okay(), snapshot: { ...snapshot(), messages: [{ id: 1, text: 'partial' }] } }));
    expect(await f.run(['brief', '--conversation', 'room-one', '--json'])).toBe(1);
    expect(f.result().code).toBe('service-unavailable');
  });

  it('never claims another participant’s request as this account’s receipt', async () => {
    const f = fixture(); f.setHandler(() => okay({ snapshot: snapshot({ messages: [message({ author: 'sam' })] }) }));
    expect(await f.run(['brief', '--conversation', 'room-one', '--request-id', id, '--json'])).toBe(0);
    expect(f.result()).toMatchObject({ result: { receiptStatus: 'not-in-current-page', receipt: null } });
    expect(f.requests).toEqual([{ operation: 'show', args: { conversationId: 'room-one' } }]);
  });

  it('includes saved lead work and pending proposals in a read-only brief', async () => {
    const f = fixture(); f.setHandler(() => Response.json({ ...okay(), snapshot: { ...snapshot(), tasks: { items: [{ rootId: 'task-one', activeTaskId: 'task-revision', title: 'Inspect release', status: { label: 'Ready' } }], totals: { all: 1, 'needs-you': 1, running: 0, completed: 0 }, nextCursor: null }, proposals: [{ id: 4, turnId: 1, title: 'Review release plan', state: 'proposed', href: '/chat?conversation=room-one&proposal=4' }] } }));
    expect(await f.run(['brief', '--conversation', 'room-one'])).toBe(0);
    expect(f.lines[0]).toContain('task-revision  Ready  Inspect release'); expect(f.lines[0]).toContain('Proposal 4 · proposed: Review release plan');
    expect(f.requests).toEqual([{ operation: 'show', args: { conversationId: 'room-one' } }]);
  });

  it('polls only read operations, prints changed messages once, and stops on revoked access', async () => {
    const f = fixture(); let calls = 0;
    f.options.sleep = async () => {};
    f.setHandler(() => {
      calls++;
      if (calls === 4) return { version: 1, ok: false, code: 'forbidden', message: 'Access removed.' };
      return okay({ snapshot: snapshot({ messages: [message({ status: calls < 3 ? 'queued' : 'running', revision: calls < 3 ? 1 : 2 })] }) });
    });
    expect(await f.run(['chat', '--conversation', 'room-one', '--follow', '--json'])).toBe(1);
    expect(f.requests).toHaveLength(4); expect(f.requests.every(request => request.operation === 'show')).toBe(true);
    expect(f.lines).toHaveLength(3); expect(JSON.parse(f.lines[1]!).snapshot.messages[0].status).toBe('running'); expect(f.result().code).toBe('forbidden');
  });

  it('does not expose server-echoed credentials or terminal escapes', async () => {
    const f = fixture(); f.setHandler(() => okay({ message: `Unexpected ${secret}\x1b[2J` }));
    expect(await f.run(['lead', 'list'])).toBe(0);
    expect(f.lines.join('')).not.toContain(secret); expect(f.lines.join('')).not.toContain('\x1b');
  });
});
