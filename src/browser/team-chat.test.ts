// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TeamChat } from './team-chat.js';
import type { TeamSnapshot } from '../team-contract.js';
const fixture = (): TeamSnapshot => ({ leads: [{ id: 'lead', name: 'Team lead', instructions: '', projects: ['/project'], revision: 1, status: 'active', createdBy: 'alex' }], conversations: [], selected: { id: 'room', leadId: 'lead', title: 'Settings page', visibility: 'team', projects: ['/project'], revision: 1, threadId: 1, createdBy: 'alex', follow: false }, participants: [{ account: 'alex', role: 'manager', active: true }], messages: [], canManage: true, canSend: true, canCreateLead: true, cursor: 1, truncated: false, projects: ['/project'], accounts: ['alex', 'sam'], chatAuthorization: { enabled: true, provider: 'codex-app', model: 'configured-model', dailyTurns: 20, weeklyCeilingUsd: null, conversationCeilingUsd: null, termsDigest: 'terms' } });
class Events extends EventTarget { static latest: Events; onerror: (() => void) | null = null; close = vi.fn(); constructor(_url: string) { super(); Events.latest = this; } }
const json = (snapshot: TeamSnapshot) => new Response(JSON.stringify({ version: 1, ok: true, code: 'ok', message: 'Saved', snapshot }), { headers: { 'content-type': 'application/json' } });
let root: Root | null = null;
beforeEach(() => { document.body.innerHTML = ''; sessionStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', Events); HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(snapshot = fixture()) { const element = document.createElement('div'); document.body.append(element); root = createRoot(element); await act(async () => root!.render(createElement(TeamChat, { initial: snapshot, user: 'alex', csrf: 'csrf' }))); }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
test('idle room opens a stream and never sends a model request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await mount(); expect(fetcher).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Team'); expect(document.body.textContent).toContain('What would you like to work on?');
  await act(async () => root!.unmount()); root = null; expect(Events.latest.close).toHaveBeenCalled();
});
test('lost message response preserves exact request identity and does not resend on reconnect', async () => {
  const snapshot = fixture(), text = 'Keep the email field optional.';
  sessionStorage.setItem('standing-orders:team-draft:alex:room', JSON.stringify({ text, requestId: 'request-one', uncertain: false }));
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.body && JSON.parse(String(options.body)).operation === 'send') throw Error('lost response');
    return json(snapshot);
  }); vi.stubGlobal('fetch', fetcher);
  await mount(snapshot);
  await act(async () => button('Send').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(document.body.textContent).toContain('response was not confirmed'); expect(button('Send')).toBeUndefined(); expect(button('Check messages')).toBeDefined();
  await act(async () => Events.latest.dispatchEvent(new Event('change')));
  expect(fetcher.mock.calls.filter(([, options]) => options?.body && JSON.parse(String(options.body)).operation === 'send')).toHaveLength(1);
  expect(JSON.parse(sessionStorage.getItem('standing-orders:team-draft:alex:room')!).requestId).toBe('request-one');
});
test('author attribution, queued edit controls and revoked access stay explicit', async () => {
  const snapshot = fixture(); snapshot.messages = [{ id: 1, author: 'sam', role: 'operator', text: 'Also support a long project name.', status: 'queued', revision: 3, createdAt: '', requestId: 'sam-one', turnId: null, error: null }];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot)));
  await mount(snapshot); expect(document.body.textContent).toContain('sam'); expect(document.body.textContent).toContain('Queued'); expect(button('Withdraw')).toBeUndefined();
  await act(async () => Events.latest.dispatchEvent(new Event('revoked')));
  expect(document.body.textContent).toContain('Your access changed'); expect(button('Send')).toBeUndefined(); expect(Events.latest.close).toHaveBeenCalled();
});
test('provider spend terms appear before enabling replies and Send stays disabled', async () => {
  const snapshot = fixture(); snapshot.chatAuthorization = { enabled: false, provider: 'openrouter-api', model: 'configured-model', dailyTurns: 20, weeklyCeilingUsd: 10, conversationCeilingUsd: 2, termsDigest: 'terms-v1' };
  const fetcher = vi.fn(async () => json(snapshot)); vi.stubGlobal('fetch', fetcher);
  sessionStorage.setItem('standing-orders:team-draft:alex:room', JSON.stringify({ text: 'Plan the work', requestId: 'one', uncertain: false }));
  await mount(snapshot); expect(button('Send').disabled).toBe(true); expect(document.body.textContent).toContain('$10 per week and $2 for this conversation');
  await act(async () => button('Enable chat').click());
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: 'authorize', args: { conversationId: 'room', termsDigest: 'terms-v1', ceilingUsd: 2 } });
});
test('sentence punctuation does not corrupt the exact saved result link', async () => {
  const snapshot = fixture(); snapshot.messages = [{ id: 1, author: 'Team lead', role: 'assistant', text: 'Result: /chat?task=payout-rounding&result=1. Inspect the changes.', status: 'answered', revision: 1, createdAt: '', requestId: null, turnId: null, error: null }];
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.querySelector<HTMLAnchorElement>('.so-team-message a')?.getAttribute('href')).toBe('/chat?task=payout-rounding&result=1&conversation=room');
  expect(document.querySelector('.so-team-message-text')?.textContent).toContain('Open result. Inspect');
});

test('an enabled chat shows why saved messages are waiting without asking for consent again', async () => {
  const snapshot = fixture(); snapshot.chatAuthorization!.waitingReason = 'Your daily chat limit is reached. Saved messages will wait until tomorrow.';
  vi.stubGlobal('fetch', vi.fn(async () => json(snapshot))); await mount(snapshot);
  expect(document.body.textContent).toContain('Saved messages will wait until tomorrow.');
  expect(button('Enable chat')).toBeUndefined();
});
