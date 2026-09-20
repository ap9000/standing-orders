import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { codingWorkspaceHtml, codingWorkspaceScript } from './coding-ui.js';
import type { CodingRequest, CodingSession, CodingSnapshot } from './coding-types.js';

const session: CodingSession = { id: '10101010-2020-3030-4040-505050505050', owner: 'alex', generation: 1, repo: '/repo/game', title: 'Improve tower placement', provider: 'codex', model: null, branch: 'coding/placement', base: 'a'.repeat(40), worktree: '/worktrees/placement', nativeThreadId: 'native-1', turnId: null, status: 'ready', error: null, createdAt: '2026-09-19T10:00:00Z', updatedAt: '2026-09-19T10:00:00Z' };
const snapshot = (patch: Partial<CodingSnapshot> = {}): CodingSnapshot => ({ session: { ...session }, revision: 1, items: [{ id: 'message-1', type: 'userMessage', text: 'Make tower placement easier on mobile.', status: 'completed' }, { id: 'message-2', type: 'agentMessage', text: 'Tap the highlighted spot to place your tower.', status: 'completed' }], requests: [], ...patch });
const request = (patch: Partial<CodingRequest> = {}): CodingRequest => ({ id: 'request-1', kind: 'command', method: 'item/commandExecution/requestApproval', title: 'Allow package download?', detail: 'npm install --ignore-scripts', questions: [], ...patch });
const html = (selected: CodingSnapshot | null = snapshot(), extra = {}) => codingWorkspaceHtml({ projects: [{ path: '/repo/game', name: 'Mayhem Spire' }], sessions: [session], selected, csrf: 'csrf-token', project: '/repo/game', available: true, owner: 'alex', ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('coding workspace HTML', () => {
  test('escapes project, session, conversation, permission and error content', () => {
    const attack = '<img src=x onerror=alert(1)>" &';
    const output = html(snapshot({ session: { ...session, title: attack, worktree: attack }, items: [{ id: attack, type: 'agentMessage', text: attack, status: null }], requests: [request({ id: attack, detail: attack })] }), { error: attack, projects: [{ path: '/repo/game', name: attack }] });
    expect(output).not.toContain('<img');
    expect(output).toContain('&lt;img');
    expect(output).not.toContain('onclick=');
    expect(output).not.toContain('style=');
  });

  test('has truthful start terms, one supported provider, normal form fields and an unavailable state', () => {
    const output = html(null);
    expect(output).toContain('action="/code/start"');
    for (const name of ['repo', 'prompt', 'title', 'model', 'password', 'csrf', 'requestId']) expect(output).toContain(`name="${name}"`);
    expect(output).toContain('Codex uses this installation’s login and edits a separate copy of this project.');
    expect(output).toContain('It can run commands and read files outside the project.');
    expect(output).toContain('Connected tools (MCP servers) keep their own access to this computer and connected services.');
    expect(output.indexOf('Connected tools (MCP servers)')).toBeLessThan(output.indexOf('Password to start'));
    expect(output).toContain('Additional command and file access requires your approval.');
    expect(output).not.toContain('name="provider"');
    expect(html(null, { available: false })).toContain('disabled>Start coding');
    expect(html(null, { projects: [] })).toContain('Add a project to start coding.');
  });

  test('uses one specific state and action, without completion percentages or publishing claims', () => {
    const working = html(snapshot({ session: { ...session, status: 'working', turnId: 'turn-1' } }));
    expect(working).toContain('>Working</p>');
    expect(working).toContain('>Send update</button>');
    expect(working).toContain('/stop"');
    expect(working).not.toMatch(/\d+%|verified|published|checks passed/i);
    const failed = html(snapshot({ session: { ...session, status: 'failed', error: 'The native process exited.' } }));
    expect(failed).toContain('Stopped with an error');
    expect(failed).toContain('Resume session');
    expect(failed).toContain('The native process exited.');
    expect(html(snapshot({ session: { ...session, status: 'uncertain' } }))).toContain('Delivery not confirmed');
    expect(html(snapshot({ session: { ...session, status: 'starting' } }))).not.toContain('/stop"');
  });

  test('keeps approval terms before consent and questions free of password fields', () => {
    const approval = html(snapshot({ requests: [request()] }));
    expect(approval.indexOf('npm install --ignore-scripts')).toBeLessThan(approval.indexOf('Approve access'));
    expect(approval).toContain('name="password"');
    expect(approval).toContain('formnovalidate');
    const question = html(snapshot({ requests: [request({ kind: 'questions', detail: '{"internal":"raw-question-payload"}', questions: [{ id: 'target', header: 'Platform', question: 'Which screen should change?', options: [{ label: 'Mobile', description: 'Prioritize touch controls.' }] }] })] }));
    expect(question).toContain('name="question:target"');
    expect(question).not.toContain('name="password"');
    expect(question).toContain('Send answer');
    expect(question).not.toContain('raw-question-payload');
  });
});

let window: Window;
let scheduled: { id: number; fn: () => void; ms: number }[];
let animationFrames: FrameRequestCallback[];
let calls: { url: string; init?: RequestInit }[];
let respond: (url: string, init?: RequestInit) => Promise<Response>;
const key = `standing-orders:coding-draft:alex:${session.id}`;
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const mount = (value = html()) => { window.document.body.innerHTML = value; window.eval(codingWorkspaceScript()); };
const prompt = () => window.document.querySelector<HTMLTextAreaElement>('[name="prompt"]')!;
const composer = () => window.document.querySelector<HTMLFormElement>('[data-coding-form="send"], [data-coding-form="start"]')!;
const field = (name: string) => composer().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const enter = (text: string) => { prompt().value = text; prompt().dispatchEvent(new window.Event('input')); };
const submit = (form = composer(), button?: HTMLButtonElement) => form.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true, ...(button ? { submitter: button as unknown as HTMLElement } : {}) }));
const nextPoll = async () => { const timer = scheduled.shift(); expect(timer).toBeDefined(); timer!.fn(); await settle(); };
const posts = () => calls.filter(call => call.init?.method === 'POST');
beforeEach(() => {
  window = new Window({ url: `https://standing.test/code/${session.id}` });
  scheduled = []; animationFrames = []; calls = []; let timerId = 0;
  window.setTimeout = ((fn: () => void, ms: number) => { const id = ++timerId; scheduled.push({ id, fn, ms }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { scheduled = scheduled.filter(timer => timer.id !== id); }) as typeof window.clearTimeout;
  window.AbortSignal.timeout = () => new window.AbortController().signal;
  window.requestAnimationFrame = (callback => { animationFrames.push(callback as FrameRequestCallback); return animationFrames.length; }) as typeof window.requestAnimationFrame;
  respond = async () => json(snapshot());
  window.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); return respond(url, init); }) as typeof window.fetch;
});
afterEach(async () => { await window.happyDOM.close(); });

test('restores a draft and stable request ID only for this session', () => {
  const requestId = '11111111-2222-3333-4444-555555555555';
  window.sessionStorage.setItem(key, JSON.stringify({ text: 'Make the selected tower easier to spot.', requestId, at: Date.now() }));
  window.sessionStorage.setItem('standing-orders:coding-draft:other:other', JSON.stringify({ text: 'Other account draft', requestId, at: Date.now() }));
  mount();
  expect(prompt().value).toBe('Make the selected tower easier to spot.');
  expect(field('requestId').value).toBe(requestId);
  enter('Use a bright outline.');
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: 'Use a bright outline.', requestId });
});

test('mobile session navigation has ordinary links inside a native disclosure without needing JavaScript', () => {
  window.document.body.innerHTML = html();
  const switcher = window.document.querySelector<HTMLDetailsElement>('.coding-mobile-sessions')!;
  expect(switcher.querySelector('summary')!.textContent).toBe('Sessions (1)');
  expect(switcher.querySelector('a')!.getAttribute('href')).toBe(`/code/${session.id}`);
  expect(switcher.querySelector('a')!.textContent).toContain('Improve tower placement');
  expect(window.document.querySelector('[data-coding-session-select]')).toBeNull();
});

test('new-session drafts are separated by account and project', () => {
  const requestId = '11111111-2222-3333-4444-555555555555';
  window.sessionStorage.setItem('standing-orders:coding-draft:someone-else:new:/repo/game', JSON.stringify({ text: 'Private draft', requestId, at: Date.now() }));
  window.sessionStorage.setItem('standing-orders:coding-draft:alex:new:/repo/game', JSON.stringify({ text: 'Change the game menu.', requestId, at: Date.now() }));
  mount(html(null));
  expect(prompt().value).toBe('Change the game menu.');
  expect(field('requestId').value).toBe(requestId);
});

test('polls one request at a time and preserves composer, approval input and expanded tools', async () => {
  const initial = snapshot({ session: { ...session, status: 'needs-input' }, requests: [request()], items: [{ id: 'tool-1', type: 'commandExecution', text: 'npm test', status: 'running' }] });
  mount(html(initial));
  const input = window.document.querySelector<HTMLInputElement>('[name="password"]')!;
  input.value = 'never-storage'; input.focus();
  const tool = window.document.querySelector<HTMLDetailsElement>('.coding-tool')!; tool.open = true;
  const originalPrompt = prompt(); enter('Keep this while I review.');
  let release!: (response: Response) => void;
  respond = async () => new Promise(resolve => { release = resolve; });
  scheduled.shift()!.fn();
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  expect(calls).toHaveLength(1);
  release(json({ ...initial, revision: 2, items: [{ ...initial.items[0], text: 'All focused tests passed.', status: 'completed' }] }));
  await settle();
  expect(prompt()).toBe(originalPrompt);
  expect(prompt().value).toBe('Keep this while I review.');
  expect(window.document.querySelector('[name="password"]')).toBe(input);
  expect(input.value).toBe('never-storage');
  expect(tool.open).toBe(true);
  expect(tool.textContent).toContain('All focused tests passed.');
  expect(window.sessionStorage.getItem(key)).not.toContain('never-storage');
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.ms).toBe(1000);
});

test('deduplicates submit, reuses the same request after a lost ACK, and never retries automatically', async () => {
  mount(); enter('Add keyboard focus to the tower controls.');
  const requestId = field('requestId').value;
  let reject!: (error: Error) => void;
  respond = async (_url, init) => init?.method === 'POST' ? new Promise((_resolve, fail) => { reject = fail; }) : json(snapshot());
  submit(); submit();
  expect(posts()).toHaveLength(1);
  reject(new Error('Network disconnected')); await settle();
  expect(prompt().readOnly).toBe(true);
  expect(field('requestId').value).toBe(requestId);
  await nextPoll();
  expect(posts()).toHaveLength(1);
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true }) : json(snapshot({ revision: 2, session: { ...session, status: 'working' } }));
  submit(); await settle();
  expect(posts()).toHaveLength(2);
  expect(new URLSearchParams(posts()[1]!.init!.body as string).get('requestId')).toBe(requestId);
  expect(new URLSearchParams(posts()[1]!.init!.body as string).get('prompt')).toBe('Add keyboard focus to the tower controls.');
  expect(field('requestId').value).not.toBe(requestId);
  expect(prompt().value).toBe('');
  expect(prompt().readOnly).toBe(false);
});

test('a definitive rejected follow-up keeps editable text and uses a new ID only on explicit retry', async () => {
  mount(); enter('Rejected revision');
  const originalId = field('requestId').value;
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: false, error: 'The agent rejected this input.', delivery: 'rejected' }, 409) : json(snapshot({ revision: 2, session: { ...session, status: 'failed' } }));
  submit(); await settle();
  expect(posts()).toHaveLength(1);
  expect(prompt().value).toBe('Rejected revision'); expect(prompt().readOnly).toBe(false);
  const newId = field('requestId').value; expect(newId).not.toBe(originalId);
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: 'Rejected revision', requestId: newId, pending: null });
  await nextPoll(); expect(composer().querySelector('button')!.disabled).toBe(false);
  enter('Edited revision');
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true }) : json(snapshot({ revision: 3 }));
  submit(); await settle();
  expect(posts()).toHaveLength(2);
  expect(new URLSearchParams(posts()[1]!.init!.body as string).get('requestId')).toBe(newId);
  expect(new URLSearchParams(posts()[1]!.init!.body as string).get('prompt')).toBe('Edited revision');
});

test('rejected startup preserves the prompt and links to its saved session without pretending it was delivered', async () => {
  mount(html(null)); enter('Please improve the inventory.'); field('password').value = 'fixture-password';
  const originalId = field('requestId').value;
  respond = async () => json({ ok: false, error: 'Startup was rejected.', delivery: 'rejected', sessionId: 'a'.repeat(32) }, 409);
  submit(); await settle();
  expect(posts()).toHaveLength(1);
  expect(prompt().value).toBe('Please improve the inventory.'); expect(prompt().readOnly).toBe(false);
  expect(field('requestId').value).not.toBe(originalId);
  expect(window.document.querySelector('#coding-error a')!.getAttribute('href')).toBe(`/code/${'a'.repeat(32)}`);
  expect(field('password').value).toBe('');
});

test.each(['pending', 'unknown', undefined])('a %s server response preserves the exact draft and receipt without retrying', async delivery => {
  mount(); enter('Keep this exact request.');
  const originalId = field('requestId').value;
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: false, error: 'Delivery is not established.', ...(delivery ? { delivery } : {}) }, 409) : json(snapshot());
  submit(); await settle();
  expect(posts()).toHaveLength(1);
  expect(prompt().value).toBe('Keep this exact request.'); expect(prompt().readOnly).toBe(true);
  expect(field('requestId').value).toBe(originalId);
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: 'Keep this exact request.', requestId: originalId, pending: { prompt: 'Keep this exact request.', requestId: originalId } });
  await nextPoll(); expect(posts()).toHaveLength(1);
});

test('failed startup shows the preserved original request in details without a delivered-message item', () => {
  const initialRequest = { requestId: 'initial-request-01', prompt: 'Add a readable <inventory> screen.' };
  mount(html(snapshot({ session: { ...session, status: 'failed', nativeThreadId: null, initialRequest }, items: [] })));
  const detail = window.document.querySelector('.coding-session-detail')!;
  expect(detail.textContent).toContain(initialRequest.prompt);
  expect(detail.querySelector('inventory')).toBeNull();
  expect(window.document.querySelectorAll('[data-coding-item]')).toHaveLength(0);
  expect(composer().querySelector('button')!.disabled).toBe(true);
});

test('uncertain native state blocks resend while keeping the exact unsent receipt and draft', async () => {
  window.sessionStorage.setItem(key, JSON.stringify({ text: 'Fix placement', requestId: '11111111-2222-3333-4444-555555555555', pending: { prompt: 'Fix placement', requestId: '11111111-2222-3333-4444-555555555555' }, at: Date.now() }));
  mount(html(snapshot({ session: { ...session, status: 'uncertain', error: 'Native delivery could not be confirmed.' } })));
  expect(composer().querySelector('button')!.disabled).toBe(true);
  submit(); await settle();
  expect(posts()).toHaveLength(0);
  expect(prompt().value).toBe('Fix placement');
  expect(window.document.querySelector('#coding-error')!.textContent).toContain('Inspect the session');
});

test('authentication expiry preserves the draft and stops polling instead of treating login HTML as state', async () => {
  mount(); enter('Check the phone menu.');
  respond = async () => json({ error: 'Sign in' }, 401);
  await nextPoll();
  expect(window.document.querySelector('#coding-connection')!.textContent).toContain('Sign in again');
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: 'Check the phone menu.' });
  expect(scheduled).toHaveLength(0);
  expect(composer().querySelector('button')!.disabled).toBe(true);
  expect(window.document.querySelector('#coding-connection a')?.getAttribute('href')).toBe('/login?return=' + encodeURIComponent(window.location.pathname + window.location.search));
});

test('conditional polling sends the last revision and leaves unchanged content alone', async () => {
  mount(); enter('Keep this draft while I inspect.');
  const original = window.document.querySelector('#coding-conversation')!.firstElementChild;
  respond = async () => json({ unchanged: true });
  await nextPoll();
  expect(calls[0]!.url).toBe(`/code/${session.id}/state?revision=1`);
  expect(window.document.querySelector('#coding-conversation')!.firstElementChild).toBe(original);
  expect(prompt().value).toBe('Keep this draft while I inspect.');
  expect(scheduled[0]!.ms).toBe(5000);
});

test('the selected session status updates in both navigation views with the main status', async () => {
  const working = { ...session, status: 'working' as const, turnId: 'turn-1' };
  mount(html(snapshot({ session: working }), { sessions: [working] }));
  expect(Array.from(window.document.querySelectorAll('[data-coding-status-for]')).map(node => node.textContent)).toEqual(['Working', 'Working']);
  respond = async () => json(snapshot({ revision: 2 }));
  await nextPoll();
  expect(window.document.querySelector('#coding-state')!.textContent).toBe('Ready');
  expect(Array.from(window.document.querySelectorAll('[data-coding-status-for]')).map(node => node.textContent)).toEqual(['Ready', 'Ready']);
});

test('opens at the latest reply, preserves reading position on passive updates, and follows an explicit send', async () => {
  window.document.body.innerHTML = html();
  const conversation = window.document.querySelector<HTMLDivElement>('#coding-conversation')!;
  let height = 1600, replyTop = 600;
  Object.defineProperties(conversation, { scrollHeight: { get: () => height }, clientHeight: { get: () => 200 } });
  conversation.getBoundingClientRect = () => ({ top: 40 }) as DOMRect;
  const reply = conversation.querySelector<HTMLElement>('.coding-message:not(.coding-user)')!;
  reply.getBoundingClientRect = () => ({ top: 40 + replyTop - conversation.scrollTop }) as DOMRect;
  window.eval(codingWorkspaceScript());
  expect(animationFrames).toHaveLength(1);
  animationFrames.shift()!(0);
  expect(conversation.scrollTop).toBe(600);
  // Aligning a tall completed reply fires a native scroll event. That event
  // must not be mistaken for the reader moving away from the latest reply.
  conversation.dispatchEvent(new window.Event('scroll'));
  respond = async () => json(snapshot({ revision: 2 }));
  await nextPoll();
  expect(conversation.scrollTop).toBe(600);
  expect(window.document.querySelector<HTMLButtonElement>('#coding-latest')!.hidden).toBe(true);
  conversation.scrollTop = 100;
  conversation.dispatchEvent(new window.Event('scroll'));
  height = 1800;
  respond = async () => json(snapshot({ revision: 3 }));
  await nextPoll();
  expect(conversation.scrollTop).toBe(100);
  expect(window.document.querySelector<HTMLButtonElement>('#coding-latest')!.hidden).toBe(false);
  enter('Make the cart count clearer.');
  height = 2200; replyTop = 1200;
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true }) : json(snapshot({ revision: 4 }));
  submit(); await settle();
  expect(conversation.scrollTop).toBe(1200);
  expect(window.document.querySelector<HTMLButtonElement>('#coding-latest')!.hidden).toBe(true);
});

test('Stop appears only after an actual native turn exists, even when the status remains working', async () => {
  mount(html(snapshot({ session: { ...session, status: 'working' } })));
  expect(window.document.querySelector('[data-coding-form="stop"]')).toBeNull();
  respond = async () => json(snapshot({ revision: 2, session: { ...session, status: 'working', turnId: 'turn-1' } }));
  await nextPoll();
  expect(window.document.querySelector('[data-coding-form="stop"]')).not.toBeNull();
});

test('loads diffs on demand, escapes their contents, and discloses truncation', async () => {
  mount();
  expect(calls).toHaveLength(0);
  respond = async url => url.endsWith('/changes') ? json({ head: 'b'.repeat(40), status: ' M src/game.ts', diff: '<script>danger()</script>', truncated: true }) : json(snapshot());
  window.document.querySelector<HTMLButtonElement>('#coding-refresh-changes')!.click(); await settle();
  const area = window.document.querySelector('#coding-change-content')!;
  expect(area.querySelector('script')).toBeNull();
  expect(area.textContent).toContain('<script>danger()</script>');
  expect(area.textContent).toContain('This diff is shortened.');
  expect(area.textContent).toContain('Modified: src/game.ts');
  expect(window.document.querySelector<HTMLElement>('#coding-shipping')!.hidden).toBe(false);
  expect(calls.map(call => call.url)).toEqual([`/code/${session.id}/changes`]);
});

test('a clean working tree does not hide committed changes made during the session', async () => {
  mount();
  respond = async () => json({ head: 'b'.repeat(40), status: '', diff: '+ Improve the placement controls', truncated: false });
  window.document.querySelector<HTMLButtonElement>('#coding-refresh-changes')!.click(); await settle();
  const area = window.document.querySelector('#coding-change-content')!;
  expect(area.textContent).toContain('Changes since this session started.');
  expect(area.textContent).not.toContain('No file changes.');
  expect(window.document.querySelector<HTMLElement>('#coding-shipping')!.hidden).toBe(false);
});

test('shipping stays hidden for empty changes and uncertain sessions while saved changes remain readable', async () => {
  mount();
  let changes = { head: session.base, status: '', diff: '', truncated: false };
  let latest = snapshot();
  respond = async url => url.endsWith('/changes') ? json(changes) : json(latest);
  const shipping = window.document.querySelector<HTMLElement>('#coding-shipping')!;
  const refresh = window.document.querySelector<HTMLButtonElement>('#coding-refresh-changes')!;
  refresh.click(); await settle();
  expect(window.document.querySelector('#coding-change-content')!.textContent).toBe('No file changes.');
  expect(shipping.hidden).toBe(true);
  changes = { ...changes, status: '?? src/tower.ts', diff: '+ Preserved placement change' };
  refresh.click(); await settle();
  expect(shipping.hidden).toBe(false);
  latest = snapshot({ session: { ...session, status: 'uncertain' }, revision: 2 });
  await nextPoll();
  expect(shipping.hidden).toBe(true);
  refresh.click(); await settle();
  expect(shipping.hidden).toBe(true);
  expect(window.document.querySelector('#coding-change-content')!.textContent).toContain('+ Preserved placement change');
  latest = snapshot({ session: { ...session, status: 'closed', nativeThreadId: null }, revision: 3 });
  await nextPoll();
  expect(shipping.hidden).toBe(true);
  expect(composer().hidden).toBe(true);
  expect(window.document.querySelector<HTMLElement>('#coding-conversation')!.hidden).toBe(false);
  expect(window.document.querySelector('#coding-conversation')!.textContent).toContain('Tap the highlighted spot');
  expect(window.document.querySelector('#coding-change-content')!.textContent).toContain('+ Preserved placement change');
});

test('makes preview links usable while escaping HTML and leaving unsafe protocols inert', async () => {
  const text = 'Open [Game preview](https://preview.example.test/game)\n<script>bad()</script> [unsafe](javascript:alert(1))';
  mount(html(snapshot({ items: [{ id: 'preview', type: 'agentMessage', text, status: 'completed' }] })));
  const conversation = window.document.querySelector('#coding-conversation')!;
  expect(conversation.querySelector('a')!.textContent).toBe('Game preview');
  expect(conversation.querySelector('a')!.getAttribute('href')).toBe('https://preview.example.test/game');
  expect(conversation.querySelector('script')).toBeNull();
  expect(conversation.querySelectorAll('a')).toHaveLength(1);
  respond = async () => json(snapshot({ revision: 2, items: [{ id: 'preview', type: 'agentMessage', text: 'Try https://preview.example.test/new.', status: 'completed' }] }));
  await nextPoll();
  expect(conversation.querySelector('a')!.getAttribute('href')).toBe('https://preview.example.test/new');
  expect(conversation.textContent).toContain('Try https://preview.example.test/new.');
});

test('formats inline code and bold without interpreting HTML inside either token', async () => {
  const text = 'Fixed `cartLabel` and **checked** `<script>bad()</script>`.';
  mount(html(snapshot({ items: [{ id: 'reply', type: 'agentMessage', text, status: 'completed' }] })));
  const body = window.document.querySelector('.coding-text')!;
  expect(Array.from(body.querySelectorAll('code')).map(node => node.textContent)).toEqual(['cartLabel', '<script>bad()</script>']);
  expect(body.querySelector('strong')!.textContent).toBe('checked');
  expect(body.querySelector('script')).toBeNull();
  respond = async () => json(snapshot({ revision: 2, items: [{ id: 'reply', type: 'agentMessage', text: '**<img src=x onerror=bad()>** and `npm test`', status: 'completed' }] }));
  await nextPoll();
  expect(body.querySelector('img')).toBeNull();
  expect(body.querySelector('strong')!.textContent).toBe('<img src=x onerror=bad()>');
  expect(body.querySelector('code')!.textContent).toBe('npm test');
});

test('answers native questions without a password and retires a resolved request without repainting others', async () => {
  const q = request({ kind: 'questions', title: 'Choose a screen', detail: '', questions: [{ id: 'screen', header: 'Screen', question: 'Which screen?', options: [] }] });
  mount(html(snapshot({ session: { ...session, status: 'needs-input' }, requests: [q] })));
  const form = window.document.querySelector<HTMLFormElement>('[data-coding-form="answer"]')!;
  const answer = form.querySelector<HTMLInputElement>('[name="question:screen"]')!; answer.value = 'Phone settings';
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true }) : json(snapshot({ revision: 2 }));
  submit(form); await settle();
  const data = new URLSearchParams(posts()[0]!.init!.body as string);
  expect(data.get('requestId')).toBe(q.id);
  expect(JSON.parse(data.get('answers')!)).toEqual({ screen: { answers: ['Phone settings'] } });
  expect(data.has('password')).toBe(false);
  expect(window.document.querySelector('[data-coding-request]')).toBeNull();
});

test('a declined approval can submit without a password and duplicate approval submits are latched', async () => {
  mount(html(snapshot({ session: { ...session, status: 'needs-input' }, requests: [request()] })));
  const form = window.document.querySelector<HTMLFormElement>('[data-coding-form="answer"]')!;
  const decline = form.querySelector<HTMLButtonElement>('[value="decline"]')!;
  let release!: (response: Response) => void;
  respond = async (_url, init) => init?.method === 'POST' ? new Promise(resolve => { release = resolve; }) : json(snapshot());
  submit(form, decline); submit(form, decline);
  expect(posts()).toHaveLength(1);
  expect(new URLSearchParams(posts()[0]!.init!.body as string).get('decision')).toBe('decline');
  release(json({ ok: true })); await settle();
});


test('uncertain delivery offers recovery, then explicit continuation without a send', async () => {
  mount(html(snapshot({ session: { ...session, status: 'uncertain', error: 'Delivery could not be confirmed.' } })));
  expect(window.document.querySelector('[data-coding-form="recover"]')?.textContent).toContain('Check saved session');
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true, id: session.id }) : json(snapshot({ revision: 2, session: { ...session, status: 'uncertain', deliveryReviewRequired: true } }));
  submit(window.document.querySelector('[data-coding-form="recover"]')!); await settle();
  expect(window.document.querySelector('[data-coding-form="recover"]')?.textContent).toContain('Continue with saved work');
  expect(posts().map(call => call.url)).toEqual([`/code/${session.id}/recover`]);
  expect(posts().some(call => call.url.endsWith('/send'))).toBe(false);
});


test('an unknown startup checks custody, then closes explicitly and offers a new session without Resume', async () => {
  const unknown = { ...session, nativeThreadId: null, status: 'uncertain' as const, initialRequest: { requestId: 'unknown-startup-01', prompt: 'Keep the original request.' } };
  mount(html(snapshot({ session: unknown, items: [] })));
  expect(window.document.querySelector('.coding-no-messages')?.textContent).toBe('No messages yet.');
  expect(window.document.querySelector<HTMLElement>('#coding-shipping')!.hidden).toBe(true);
  let latest = snapshot({ session: { ...unknown, deliveryReviewRequired: true }, items: [], revision: 2 });
  respond = async (_url, init) => init?.method === 'POST' ? json({ ok: true, id: session.id }) : json(latest);
  submit(window.document.querySelector('[data-coding-form="recover"]')!); await settle();
  expect(window.document.querySelector('[data-coding-form="recover"]')?.textContent).toContain('Keep work and close session');
  expect(window.document.querySelector('#coding-changes')).not.toBeNull();
  latest = snapshot({ session: { ...unknown, status: 'closed', deliveryReviewRequired: false }, items: [], revision: 3 });
  submit(window.document.querySelector('[data-coding-form="recover"]')!); await settle();
  expect(window.document.querySelector('#coding-state')?.textContent).toBe('Session closed');
  expect(window.document.querySelector('#coding-controls a')?.textContent).toBe('New session');
  expect(window.document.querySelector('[data-coding-form="resume"]')).toBeNull();
  expect(window.document.querySelector<HTMLButtonElement>('[data-coding-form="send"] button')?.disabled).toBe(true);
  expect(composer().hidden).toBe(true);
  expect(window.document.querySelector<HTMLElement>('#coding-conversation')!.hidden).toBe(true);
  expect(window.document.querySelector<HTMLButtonElement>('#coding-latest')!.hidden).toBe(true);
  expect(window.document.querySelector<HTMLElement>('#coding-shipping')!.hidden).toBe(true);
  expect(window.document.querySelector('.coding-session-detail')?.textContent).toContain('Keep the original request.');
  expect(posts().map(call => call.url)).toEqual([`/code/${session.id}/recover`, `/code/${session.id}/continue`]);
  const rendered = html(latest);
  expect(rendered).toContain('Session closed'); expect(rendered).not.toContain('Resume session');
  window.document.body.innerHTML = rendered;
  expect(composer().hidden).toBe(true);
  expect(window.document.querySelector<HTMLElement>('#coding-conversation')!.hidden).toBe(true);
  expect(window.document.querySelector<HTMLElement>('#coding-shipping')!.hidden).toBe(true);
  expect(window.document.querySelector('#coding-controls a')?.textContent).toBe('New session');
  expect(window.document.querySelector('#coding-changes')).not.toBeNull();
});


test('explains an owned-writer conflict and keeps exact diagnostics without replaying', async () => {
  const error = 'thread native-1 already has an active writer <unsafe>';
  mount(html(snapshot({ session: { ...session, status: 'failed', error } })));
  const box = window.document.querySelector('#coding-error')!;
  expect(box.firstChild!.textContent).toContain('Close it there, then resume here.');
  expect(box.querySelector('details pre')?.textContent).toBe(error);
  expect(box.querySelector('unsafe')).toBeNull();
  respond = async () => json(snapshot({ session: { ...session, status: 'failed', error }, revision: 2 }));
  await nextPoll();
  expect(box.firstChild!.textContent).toContain('This conversation is open in another Codex app.');
  expect(box.querySelector('details pre')?.textContent).toBe(error);
  expect(posts()).toHaveLength(0);
});
