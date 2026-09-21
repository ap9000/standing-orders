import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { handleTeamHttp, TEAM_REQUEST_BYTES, type TeamHttpOptions } from './team-http.js';
import type { TeamSnapshot } from './team-contract.js';
const snapshot: TeamSnapshot = { leads: [], conversations: [], selected: null, participants: [], messages: [], canManage: false, canSend: false, cursor: 1, truncated: false, projects: [], accounts: [] };
const servers: Server[] = []; const streams = new Set<ServerResponse>();
afterEach(async () => { for (const stream of streams) stream.end(); streams.clear(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function fixture(overrides: Partial<TeamHttpOptions> = {}) {
  const execute = vi.fn(async () => ({ version: 1 as const, ok: true, code: 'ok', message: 'Saved', snapshot }));
  const options: TeamHttpOptions = { authenticate: request => request.headers.authorization === 'Bearer alex:private' ? { name: 'alex', generation: 2 } : null,
    revalidate: () => true, authorizeMutation: request => request.headers['x-csrf-token'] === 'csrf', execute, streamIntervalMs: 10, streams, ...overrides };
  const server = createServer((request, response) => { void handleTeamHttp(request, response, options).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, execute };
}
const headers = { authorization: 'Bearer alex:private', 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
describe('shared team transport', () => {
  test('derives actor from authentication and passes a single operation', async () => {
    const { url, execute } = await fixture();
    const input = { operation: 'send', args: { conversationId: 'room', requestId: 'once', text: 'Keep the settings simple.' } };
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(200); expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'alex', generation: 2 }, input);
  });
  test('rejects client actor impersonation before executing', async () => {
    const { url, execute } = await fixture();
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'send', args: { actor: 'sam' } }) });
    expect(response.status).toBe(400); expect(execute).not.toHaveBeenCalled();
  });
  test('requires sign-in and a current mutation proof', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team')).status).toBe(401);
    expect((await fetch(url + '/api/team', { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
  test('bounds request bodies and refuses query-string credentials', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team?password=private', { headers })).status).toBe(400);
    expect((await fetch(url + '/api/team', { method: 'POST', headers, body: 'x'.repeat(TEAM_REQUEST_BYTES + 1) })).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
  test('GET opens the same conversation without admitting a turn', async () => {
    const { url, execute } = await fixture();
    expect((await fetch(url + '/api/team?conversation=room', { headers })).status).toBe(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'alex', generation: 2 }, { operation: 'show', args: { conversationId: 'room' } });
  });
  test('checks revoked authority again after receiving the body', async () => {
    const { url, execute } = await fixture({ revalidate: () => false });
    expect((await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'list', args: {} }) })).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  test('uncertain delivery does not repeat a mutation', async () => {
    const execute = vi.fn(async () => { throw Error('reply lost'); });
    const { url } = await fixture({ execute });
    const response = await fetch(url + '/api/team', { method: 'POST', headers, body: JSON.stringify({ operation: 'send', args: { conversationId: 'room', requestId: 'one', text: 'Hello' } }) });
    expect(response.status).toBe(502); expect((await response.json()).code).toBe('delivery-unconfirmed'); expect(execute).toHaveBeenCalledTimes(1);
  });
  test('idle streams send no repeated messages and revalidate revoked access', async () => {
    let allowed = true; let cursor = 1;
    const { url, execute } = await fixture({ revalidate: () => allowed, cursor: () => cursor });
    const response = await fetch(url + '/api/team/events?conversation=room', { headers });
    const reader = response.body!.getReader(), decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toContain('id: 1');
    cursor = 2;
    expect(decode.decode((await reader.read()).value)).toContain('id: 2');
    allowed = false;
    expect(decode.decode((await reader.read()).value)).toContain('event: revoked');
    expect((await reader.read()).done).toBe(true); expect(execute).toHaveBeenCalledTimes(1);
  });
});
