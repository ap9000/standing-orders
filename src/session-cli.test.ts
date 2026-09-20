import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { main } from './cli.js';
import { runSessionCommand, sessionServiceOrigin } from './session-cli.js';
import { SESSION_DESCRIPTORS, SESSION_PROMPT_BYTES, SESSION_RESPONSE_BYTES, isSessionResponse, validateSessionRequest, type SessionOperation, type SessionResponse } from './session-contract.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = (): string => { const dir = mkdtempSync(join(tmpdir(), 'so-session-cli-')); dirs.push(dir); return dir; };
const key = 'request_0123456789';
const credentials = ['--url', 'http://127.0.0.1:7788', '--as', 'alice', '--token-env', 'SESSION_TEST_TOKEN'];
const expected = ['--key', key, '--revision', '4', '--thread', 'native-1', '--turn', 'none'];
const session = { id: 'session-1', title: 'Improve session continuity', repo: '/project', status: 'ready', nativeThreadId: 'native-1', turnId: null, revision: 5 };
const response = (operation: SessionOperation): SessionResponse => ({
  version: 1, operation, ok: true, status: 'succeeded', delivery: 'confirmed', retry: operation === 'list' || operation === 'show' || operation === 'changes' ? 'safe-read' : 'inspect-first', message: 'Session ready.', nextActions: [{ operation: 'show', label: 'Inspect session', sessionId: session.id }],
  result: operation === 'list' ? { sessions: [session] } : { session, ...(operation === 'changes' ? { changes: { head: 'abc123', status: '', diff: '', truncated: false } } : {}), receipt: { key, status: 'accepted' } },
});
const asFetch = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch => fn as typeof fetch;
async function invoke(argv: string[], payload: unknown = response(argv[0] as SessionOperation), status = 200) {
  const lines: string[] = [], errors: string[] = [];
  const fetch = vi.fn(asFetch(async () => new Response(JSON.stringify(payload), { status })));
  const code = await runSessionCommand([...argv, ...credentials, '--json'], line => lines.push(line), { fetch, env: { SESSION_TEST_TOKEN: 'secret-test-token' }, stderr: line => errors.push(line), readStdin: async () => 'Preserve the full request.\nKeep its final newline.\n' });
  return { code, body: JSON.parse(lines.join('\n')), errors, fetch };
}

describe('session transport contract', () => {
  test('descriptors reject stale-contract shapes, missing exact identities and unknown fields', () => {
    const request = { version: 1, sessionId: 'session-1', key, expectedRevision: 4, expectedThreadId: 'native-1', expectedTurnId: null, prompt: 'Continue the same work.' };
    expect(validateSessionRequest('send', request).ok).toBe(true);
    for (const changed of [{ ...request, version: 2 }, { ...request, expectedRevision: -1 }, { ...request, expectedRevision: 0.5 }, { ...request, expectedTurnId: '' }, { ...request, actor: 'bob' }, { ...request, toString: 'extra' }]) expect(validateSessionRequest('send', changed).ok).toBe(false);
    const { expectedTurnId: _, ...missing } = request;
    expect(validateSessionRequest('send', missing).ok).toBe(false);
    expect(validateSessionRequest('send', { ...request, prompt: '🙂'.repeat(SESSION_PROMPT_BYTES / 4 + 1) }).ok).toBe(false);
    expect(validateSessionRequest('list', { version: 1, limit: 101 }).ok).toBe(false);
    const start = { version: 1, project: '/project', title: 'Session', prompt: 'Continue the work.', key };
    expect(validateSessionRequest('start', { ...start, model: 'openai/codex:latest' }).ok).toBe(true);
    for (const model of ['has spaces', '-starts-with-dash', 'x'.repeat(129)]) expect(validateSessionRequest('start', { ...start, model }).ok).toBe(false);
    expect(validateSessionRequest('stop', { version: 1, ...request }).ok).toBe(false);
  });

  test('response status, delivery, operation and exact result shape must agree', () => {
    expect(isSessionResponse(response('show'), 'show')).toBe(true);
    for (const payload of [
      { ...response('show'), operation: 'send' }, { ...response('show'), version: 2 },
      { ...response('show'), status: 'uncertain' }, { ...response('show'), delivery: 'unknown' },
      { ...response('show'), result: { session: { ...session, revision: -1 } } },
      { ...response('show'), result: { session, items: ['invalid'] } },
      { ...response('show'), nextActions: [{ operation: 'approve', label: 'Approve work' }] },
    ]) expect(isSessionResponse(payload, 'show')).toBe(false);
  });

  test('capabilities describe operator restrictions without using credentials or a service', async () => {
    const fetch = vi.fn(); const lines: string[] = [];
    expect(await main(['session', 'capabilities', '--json'], line => lines.push(line), { session: { fetch } })).toBe(0);
    const body = JSON.parse(lines.join('\n'));
    expect(body.envelopeVersion).toBe(1);
    expect(body.operations).toEqual(SESSION_DESCRIPTORS);
    expect(body.operations.every((operation: { audience: string; agentMayInvoke: boolean }) => operation.audience === 'operator' && !operation.agentMayInvoke)).toBe(true);
    expect(body.brief).toMatchObject({ supported: true, operation: 'show', defaultView: 'brief' });
    expect(body.unsupported).toContain('review');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('native session CLI', () => {
  test.each(['list', 'show', 'changes', 'start', 'send', 'stop', 'resume', 'recover'] as const)('%s calls only its owner endpoint with typed input and one envelope', async operation => {
    const args = [operation, ...(['list', 'start'].includes(operation) ? [] : ['session-1']), ...(['send', 'stop', 'resume', 'recover'].includes(operation) ? expected : [])];
    if (operation === 'start') args.push('--project', '/project', '--title', 'Session continuity', '--key', key, '--stdin');
    if (operation === 'send') args.push('--stdin');
    const result = await invoke(args);
    expect(result.code).toBe(0);
    expect(result.body.envelopeVersion).toBe(1);
    expect(result.body.command).toBe(`session ${operation}`);
    expect(result.errors).toEqual([]);
    expect(result.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = result.fetch.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:7788/api/sessions/${operation}`);
    expect(options?.redirect).toBe('manual');
    expect(options?.credentials).toBe('omit');
    expect(options?.headers).toMatchObject({ authorization: 'Bearer alice:secret-test-token' });
    const request = JSON.parse(options?.body as string);
    expect(validateSessionRequest(operation, request).ok).toBe(true);
    if (operation === 'start' || operation === 'send') expect(request.prompt).toBe('Preserve the full request.\nKeep its final newline.\n');
    expect(JSON.stringify(result.body)).not.toContain('secret-test-token');
  });

  test('reads an explicit token file and prompt file and preserves exact text', async () => {
    const dir = temporary(); const token = join(dir, 'token'), prompt = join(dir, 'prompt.txt');
    writeFileSync(token, 'file-token\n', { mode: 0o600 }); writeFileSync(prompt, 'First line\n\n最後の行\n');
    const fetch = vi.fn(asFetch(async () => new Response(JSON.stringify(response('start')))));
    const lines: string[] = [];
    const code = await runSessionCommand(['start', '--url', 'https://console.example.test', '--as', 'alice', '--token-file', token, '--project', '/project', '--title', 'Session continuity', '--key', key, '--file', prompt, '--json'], line => lines.push(line), { fetch });
    expect(code).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).prompt).toBe(readFileSync(prompt, 'utf8'));
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer alice:file-token' });
    expect(lines).toHaveLength(1);
  });

  test('rejects missing credentials, ambiguous prompts, invalid flags and invalid identities before networking', async () => {
    const fetch = vi.fn();
    for (const args of [
      ['list', '--url', 'http://127.0.0.1:7788', '--as', 'alice'],
      ['list', ...credentials, '--token-file', '/unused'],
      ['list', ...credentials, '--unknown'],
      ['list', ...credentials, '--limit', '1.5'],
      ['list', ...credentials, '--limit', '2', '--limit', '3'],
      ['send', 'session-1', ...credentials, ...expected, '--file', '/unused', '--stdin'],
      ['send', 'session-1', ...credentials, '--key', key, '--stdin'],
      ['stop', 'session-1', ...credentials, ...expected, '--stdin'],
      ['show', 'session-1', 'session-2', ...credentials],
      ['list', ...credentials, '--token', 'unsafe-command-secret'],
    ]) {
      const lines: string[] = [];
      const code = await runSessionCommand([...args, '--json'], line => lines.push(line), { fetch, env: { SESSION_TEST_TOKEN: 'secret-test-token' }, readStdin: async () => 'request' });
      expect(code, args.join(' ')).toBe(2);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).delivery).toBe('not-sent');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('missing environment credentials never fall back to discovered installation secrets', async () => {
    const fetch = vi.fn(); const lines: string[] = [];
    expect(await runSessionCommand(['list', ...credentials, '--json'], line => lines.push(line), { fetch, env: {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['http://remote.example.test', 'ftp://127.0.0.1', 'https://alice:password@example.test', 'https://example.test/api', 'https://example.test/?token=secret', 'https://example.test/#secret', 'http://127.0.0.1.example.test'])('rejects credential destination %s', url => {
    expect(() => sessionServiceOrigin(url)).toThrow();
  });
  test.each(['http://127.0.0.1:7788', 'http://[::1]:7788', 'http://localhost:7788', 'https://console.example.test'])('accepts explicit safe destination %s', url => expect(sessionServiceOrigin(url)).toBe(url));

  test('unknown mutation delivery preserves key and recommends inspection without retry', async () => {
    const fetch = vi.fn(asFetch(async () => { throw new Error('secret-test-token in a transport failure'); }));
    const lines: string[] = [];
    const code = await runSessionCommand(['send', 'session-1', ...credentials, ...expected, '--stdin', '--json'], line => lines.push(line), { fetch, env: { SESSION_TEST_TOKEN: 'secret-test-token' }, readStdin: async () => 'Continue.' });
    expect(code).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', key, nextActions: [{ operation: 'show', sessionId: 'session-1' }] });
    expect(lines.join('\n')).not.toContain('secret-test-token');
  });

  test('authoritative rejection differs from broken replies and mismatched receipts', async () => {
    const rejection: SessionResponse = { version: 1, operation: 'send', ok: false, status: 'rejected', delivery: 'not-sent', retry: 'never', reason: 'stale-session', message: 'Inspect the newer session before sending.', nextActions: [{ operation: 'show', label: 'Inspect session', sessionId: session.id }] };
    const rejected = await invoke(['send', 'session-1', ...expected, '--stdin'], rejection, 409);
    expect(rejected.code).toBe(3); expect(rejected.body.reason).toBe('stale-session');
    for (const payload of [{ error: 'gateway failure' }, { ...response('send'), result: { session } }, { ...response('send'), result: { session: { ...session, id: 'different-session' }, receipt: { key, status: 'accepted' } } }, { ...response('send'), result: { session, receipt: { key: 'different-request', status: 'accepted' } } }]) {
      const result = await invoke(['send', 'session-1', ...expected, '--stdin'], payload);
      expect(result.code).toBe(1); expect(result.body.delivery).toBe('unknown');
    }
  });

  test.each([401, 403, 404, 503])('HTTP %s without owner rejection marker cannot falsely reject an accepted mutation', async status => {
    const result = await invoke(['send', 'session-1', ...expected, '--stdin'], { error: 'unavailable' }, status);
    expect(result.body.delivery).toBe('unknown');
    const lines: string[] = [];
    const fetch = asFetch(async () => new Response('Rejected by the owner.', { status, headers: { 'x-standing-orders-session-delivery': 'not-sent' } }));
    expect(await runSessionCommand(['send', 'session-1', ...credentials, ...expected, '--stdin', '--json'], line => lines.push(line), { fetch, env: { SESSION_TEST_TOKEN: 'secret-test-token' }, readStdin: async () => 'Continue.' })).toBe(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: 'rejected', delivery: 'not-sent' });
  });

  test('broken and oversized mutation responses are bounded unknown outcomes', async () => {
    for (const body of ['{"version":1,', 'x'.repeat(SESSION_RESPONSE_BYTES + 1)]) {
      const lines: string[] = []; const fetch = vi.fn(asFetch(async () => new Response(body)));
      expect(await runSessionCommand(['stop', 'session-1', ...credentials, ...expected, '--json'], line => lines.push(line), { fetch, env: { SESSION_TEST_TOKEN: 'secret-test-token' } })).toBe(1);
      expect(JSON.parse(lines[0]!).delivery).toBe('unknown');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  test('real HTTP redirects never forward an operator credential to the next endpoint', async () => {
    let initial = 0, redirected = 0; let auth = '';
    const server = createServer((request, response) => {
      if (request.url === '/api/sessions/list') { initial++; auth = request.headers.authorization ?? ''; response.writeHead(302, { location: '/steal' }); response.end(); }
      else { redirected++; response.end('should not be called'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
      const lines: string[] = [];
      expect(await runSessionCommand(['list', '--url', `http://127.0.0.1:${address.port}`, '--as', 'alice', '--token-env', 'SESSION_TEST_TOKEN', '--json'], line => lines.push(line), { env: { SESSION_TEST_TOKEN: 'secret-test-token' } })).toBe(1);
      expect(initial).toBe(1); expect(redirected).toBe(0); expect(auth).toBe('Bearer alice:secret-test-token');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  test('plain errors go to stderr and top-level JSON output files retain the envelope', async () => {
    const lines: string[] = [], errors: string[] = [];
    expect(await runSessionCommand(['send'], line => lines.push(line), { stderr: line => errors.push(line) })).toBe(2);
    expect(lines).toEqual([]); expect(errors).toHaveLength(1);
    const output = join(temporary(), 'answer.json');
    expect(await main(['session', 'show', 'session-1', ...credentials, '--json', '-o', output], line => lines.push(line), { session: { env: { SESSION_TEST_TOKEN: 'secret-test-token' }, fetch: asFetch(async () => new Response(JSON.stringify(response('show')))) } })).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ command: 'session show', envelopeVersion: 1, result: { session } });
  });
});
