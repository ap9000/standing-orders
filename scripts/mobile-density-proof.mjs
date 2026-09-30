/** Phone density proof (fixture). Chat, Tasks, a task page, Inbox, Flows, Projects, Settings and its
 * Integrations, Notifications and Pull requests sections at 390×844 and 320×740, and the same pages at
 * 1440×900 for the desktop comparison. Measures what fits in the first screen (rows whose top is on
 * screen), horizontal overflow, tap targets under 44px and text inputs under 16px on phones.
 *
 *   npm run build && node scripts/mobile-density-proof.mjs --out evidence/mobile-density/after [--before evidence/mobile-density/before]
 *
 * With --before (the same script run against the base build), it also writes side-by-side comparisons,
 * before on the left and after on the right, into the --out folder's parent.
 *
 * Synthetic data only: the `toolroll demo` sandbox (two projects, tasks in every state, two flows) plus
 * a Telegram bot, a failing audit webhook and an MCP server missing its secret, with every outside answer
 * stubbed as in scripts/integrations-proof.mjs. No network and no model. Playwright comes from `playwright`, PLAYWRIGHT_MODULE, or the
 * npx cache. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = resolve(at >= 0 ? args[at + 1] : 'evidence/mobile-density/after');
const only = args.includes('--desktop-only') ? ['desktop'] : args.includes('--phone-only') ? ['phone'] : null;
const beforeAt = args.indexOf('--before');
const before = beforeAt >= 0 ? resolve(args[beforeAt + 1]) : null;
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) { try { return await import(pathToFileURL(one).href); } catch { /* next */ } }
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

// Integrations: every outside answer stubbed, as in scripts/integrations-proof.mjs.
const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false });
const integrationIo = {
  fetch: async url => String(url).includes('api.telegram.org')
    ? new Response(JSON.stringify({ ok: true, result: { id: 7012345678, is_bot: true, username: 'bookshelf_alerts_bot' } }), { status: 200 })
    : new Response('{}', { status: 404 }),
  gh: async (_file, list) => list[0] === 'api' ? ok('alex-reads\n') : ok(JSON.stringify({ nameWithOwner: 'bookshelf-co/bookshelf', viewerPermission: 'WRITE' })),
  reach: async () => {},
};
const connectionProbe = async file => file === 'claude'
  ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'alex@bookshelf.example' }))
  : { code: 1, stdout: 'Not logged in\n', stderr: '', timedOut: false, notFound: false };

const dist = name => import(pathToFileURL(resolve('dist', name)).href);
const { createDemoSandbox } = await dist('demo.js');
const { createDecisionServer } = await dist('serve.js');
const { addToolTo, validateToolSpec } = await dist('project-tools.js');
const { saveMonitoring, NO_MONITORING } = await dist('monitoring-settings.js');
const { targetOf } = await dist('monitoring.js');
const { sandbox, store, seed, evidenceRoot } = createDemoSandbox(new Date());
const [repo] = seed.repos;
writeFileSync(join(sandbox, 'telegram-token'), `7012345678:${'A'.repeat(20)}bcdefghijklmnopq\n`, { mode: 0o600 });
saveMonitoring(sandbox, { webhook: 'https://logs.bookshelf.example/toolroll', folder: '', tracesEndpoint: '', headerName: '', headerValue: '', rotate: false }, NO_MONITORING);
store.handle.prepare('INSERT INTO monitoring_status (sink, target, through, sent, last_ok_at, last_error, last_error_at, failures) VALUES (?, ?, 40, 40, ?, ?, ?, 3)')
  .run('webhook', targetOf('https://logs.bookshelf.example/toolroll'), new Date(Date.now() - 3 * 3600_000).toISOString(), 'logs.bookshelf.example answered 503 Service Unavailable', new Date(Date.now() - 12 * 60_000).toISOString());
addToolTo(store, repo, validateToolSpec({ name: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], secrets: [{ name: 'SENTRY_TOKEN', optional: false }], about: 'Errors from Sentry' }), 'proof', seed.login.name, new Date(), { home: sandbox });
const server = createDecisionServer({ store, evidenceRoot, repos: seed.repos, chatEnv: {}, configDir: sandbox, toolHome: sandbox,
  telegramTokenFile: join(sandbox, 'telegram-token'), connectionProbe, integrationIo });
await new Promise(done => server.listen(0, '127.0.0.1', done));
// Chat: the demo never contacts a model, so a second, ordinary installation answers from a script.
const { openStore } = await dist('store.js');
const { addApprover } = await dist('scope.js');
const chatStore = openStore(':memory:');
const chatLogin = addApprover(chatStore, 'alex', new Date());
chatStore.setChatConfig({ provider: 'codex-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'alex', new Date());
for (const phase of ['plan', 'build', 'review']) chatStore.setPhaseConfig('installation', phase, 'codex', 'default', 'alex', new Date());
const REPLIES = [
  'Two things wait on you. **Fix the payout rounding drift** finished and is ready to check: the settlement now rounds at cent precision, and 214 tests pass. **Guard the payout limiter** has a plan waiting for your approval.\n\nNothing is building right now.',
  'The drift came from rounding each payout before summing. The fix rounds once, at the cent, and adds boundary tests for half-cent values.\n\nOpen the result to see the diff, then mark it complete or ask for changes.',
];
let replies = 0;
const chatServer = createDecisionServer({ store: chatStore, evidenceRoot: join(sandbox, 'chat-evidence'), repo: seed.repos[0], chatEnv: {},
  subscriptionChatRunner: async () => ({ ok: true, answer: { text: REPLIES[replies++ % REPLIES.length], calls: [], tokensIn: 100, tokensOut: 60, reportedCostMicrousd: null } }) });
await new Promise(done => chatServer.listen(0, '127.0.0.1', done));
const chatUrl = `http://127.0.0.1:${chatServer.address().port}`;

const task = store.handle.prepare("SELECT external_id AS id FROM task_ref ORDER BY id LIMIT 1").get()?.id;
const fixture = { url: `http://127.0.0.1:${server.address().port}`, name: seed.login.name, password: seed.login.password };
const { chromium } = await loadPlaywright();
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const report = { synthetic: true, viewports: {} };
const problems = [];

const pages = [
  ['chat', '/chat'],
  ['catch-up', '/chat'],
  ['tasks', '/work'],
  ['task', `/t/${task}`],
  ['inbox', '/inbox'],
  ['flows', '/flows'],
  ['projects', '/projects'],
  ['settings', '/settings'],
  ['integrations', '/settings/integrations'],
  ['notifications', '/settings#notifications'],
  ['pull-requests', `/settings/pull-requests?repo=${encodeURIComponent(repo)}`],
];

// What fits: rows (list items, cards, integration rows, messages) whose top edge is inside the first screen.
const measure = () => {
  const vw = innerWidth, vh = innerHeight;
  const rows = [...document.querySelectorAll('[data-integration], [data-task], li, .card, [data-slot="card"], .so-message, [data-message], details > summary')]
    .filter(el => { const box = el.getBoundingClientRect(); return box.height > 0 && box.width > 0 && getComputedStyle(el).visibility !== 'hidden'; });
  const onScreen = rows.filter(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.top < vh; }).length;
  const scrollers = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  const content = Math.max(document.documentElement.scrollHeight, ...scrollers.map(el => el.scrollHeight));
  // The main scroller (the page, or the conversation): what share of its content the first screen shows.
  const main = scrollers.sort((x, y) => y.scrollHeight - x.scrollHeight)[0] ?? document.documentElement;
  const shown = Math.min(1, main.clientHeight / main.scrollHeight);
  const overflow = document.documentElement.scrollWidth > vw + 1;
  return { onScreen, content, shown: Math.round(shown * 1000) / 1000, overflow };
};

// Tap targets on a phone, measured as a finger meets them: each control is scrolled to the middle of the screen
// and hit-tested 21.5px above, below, left and right of its centre; each point must land on the control, inside
// it, or on its label. Text fields must be 16px. Inline links inside a sentence are not targets of their own.
const taps = () => {
  const small = [];
  const controls = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="combobox"]');
  for (const el of controls) {
    const style = getComputedStyle(el), box0 = el.getBoundingClientRect();
    if (el.disabled || el.matches(':disabled') || box0.width === 0 || box0.height === 0 || !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true }) || el.closest('[hidden], [aria-hidden="true"], .sr-only, [inert], details:not([open]) > :not(summary)')) continue;
    if (el.tagName === 'A' && style.display === 'inline' && el.parentElement.closest('p, li, dd, span, .ui-message-content') && el.parentElement.textContent.trim() !== el.textContent.trim()) continue;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = el.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue; // off screen until focused (a skip link)
    const owners = [el, el.closest('label'), el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null].filter(Boolean);
    const lands = (x, y) => { const hit = document.elementFromPoint(x, y); return hit !== null && owners.some(one => one === hit || one.contains(hit)); };
    const tall = lands(cx, cy - 21.5) && lands(cx, cy + 21.5), wide = lands(cx - 21.5, cy) && lands(cx + 21.5, cy);
    const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!tall || !wide) small.push({ tag: el.tagName.toLowerCase(), text, height: Math.round(box.height), width: Math.round(box.width), tall, wide, at: [document.elementFromPoint(cx, cy - 21.5)?.className?.toString().slice(0, 40), document.elementFromPoint(cx - 21.5, cy)?.tagName] });
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/checkbox|radio|range|color|file|submit|button/.test(el.type) && parseFloat(style.fontSize) < 16) small.push({ tag: el.tagName.toLowerCase(), text, font: style.fontSize });
  }
  return small;
};

try {
  const viewports = [['phone', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }], ['desktop', { width: 1440, height: 900 }]]
    .filter(([name]) => only === null || only.includes(name));
  for (const [name, viewport] of viewports) {
    const phone = viewport.width <= 760;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${fixture.url}/login`);
    await page.fill('input[name="name"]', fixture.name);
    await page.fill('input[name="token"]', fixture.password);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    report.viewports[name] = {};
    // Chat, with a two-question conversation (scripted answers).
    const chatContext = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    const chat = await chatContext.newPage();
    chat.on('pageerror', e => errors.push(e.message));
    await chat.goto(`${chatUrl}/login`);
    await chat.fill('input[name="name"]', 'alex');
    await chat.fill('input[name="token"]', chatLogin.token);
    await Promise.all([chat.waitForNavigation(), chat.click('button[type="submit"]')]);
    await chat.goto(`${chatUrl}/chat`);
    for (const [i, question] of ['What needs me today?', 'Why was the payout drifting?'].entries()) {
      const box = chat.locator('form[data-workspace-composer] textarea, form textarea[name="message"]').first();
      await box.fill(question);
      await box.press('Enter');
      await chat.getByText(i === 0 ? 'Nothing is building right now.' : 'mark it complete or ask for changes', { exact: false }).first().waitFor({ timeout: 20000 });
    }
    // The first-run checks and the catch-up arrive after the replies: measure once the height holds still.
    for (let last = -1, tries = 0; tries < 20; tries += 1) {
      await chat.waitForTimeout(400);
      const height = await chat.evaluate(() => document.querySelector('.ui-conversation > div')?.scrollHeight ?? 0);
      if (height === last) break;
      last = height;
    }
    report.viewports[name].chat = await chat.evaluate(measure);
    if (report.viewports[name].chat.overflow) problems.push(`${name} chat: horizontal scroll`);
    await chat.screenshot({ path: join(out, `${name}-chat.png`) });
    if (phone) report.viewports[name].chat.small = await chat.evaluate(taps);
    if (process.env.DEBUG_CHAT) { await chat.evaluate(() => document.querySelector('.ui-conversation > div').scrollTo(0, 0)); await chat.waitForTimeout(200); await chat.screenshot({ path: join(out, `${name}-chat-top.png`) }); }
    if (process.env.DEBUG_CHAT) console.log(await chat.evaluate(() => { const sc = document.querySelector('.ui-conversation > div'); return JSON.stringify({ top: sc.scrollTop, client: sc.clientHeight, scroll: sc.scrollHeight, kids: [...sc.querySelectorAll(':scope > * > *')].map(e => [e.className.toString().slice(0, 40), Math.round(e.getBoundingClientRect().height)]) }); }));
    await chatContext.close();
    for (const [key, path] of pages) {
      if (key === 'chat') continue;
      if (name === 'narrow' && !['tasks', 'task', 'integrations', 'notifications'].includes(key)) continue;
      await page.goto(`${fixture.url}${path}`);
      if (key === 'integrations') {
        for (let tries = 0; tries < 40 && (await page.locator('.integration-state--checking').count()) > 0; tries += 1) {
          await new Promise(done => setTimeout(done, 250));
          await page.reload();
        }
      }
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready);
      if (key === 'notifications') await page.locator('#notifications').scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);
      const facts = await page.evaluate(measure);
      report.viewports[name][key] = facts;
      if (facts.overflow) problems.push(`${name} ${key}: horizontal scroll`);
      await page.screenshot({ path: join(out, `${name}-${key}.png`) });
      if (phone) facts.small = await page.evaluate(taps);
      if (key === 'catch-up' && name === 'phone') {
        // The Crew view, reached from the header.
        await page.evaluate(() => document.querySelector('.so-page-content')?.scrollTo(0, 0));
        await page.getByRole('button', { name: 'Crew' }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, `${name}-crew.png`) });
        report.viewports[name].crew = await page.evaluate(measure);
        report.viewports[name].crew.small = await page.evaluate(taps);
      }
    }
    if (errors.length) problems.push(`${name}: ${errors.join('; ')}`);
    await ctx.close();
  }
  writeFileSync(join(out, 'measure.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (before !== null) {
    // Before | after, one image per page, labelled, with what the first screen shows.
    const was = JSON.parse(readFileSync(join(before, 'measure.json'), 'utf8')).viewports;
    const pairs = [['phone', 'chat'], ['phone', 'tasks'], ['phone', 'task'], ['phone', 'integrations'], ['phone', 'notifications'], ['narrow', 'tasks'], ['desktop', 'integrations']];
    const compose = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    const sheet = await compose.newPage();
    for (const [name, key] of pairs) {
      const img = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
      const label = (words, facts) => `${words}${facts?.shown === undefined ? '' : ` · first screen shows ${Math.round(facts.shown * 100)}% of the page`}`;
      await sheet.setContent(`<body style="margin:0;background:#efefef;font:600 28px/1.3 system-ui,sans-serif;color:#171717"><div id="c" style="display:inline-flex;gap:32px;padding:24px">` +
        `<figure style="margin:0"><figcaption style="margin:0 0 12px">${label('Before', was[name]?.[key])}</figcaption><img src="${img(join(before, `${name}-${key}.png`))}" style="display:block;border:1px solid #d4d4d4"></figure>` +
        `<figure style="margin:0"><figcaption style="margin:0 0 12px">${label('After', report.viewports[name]?.[key])}</figcaption><img src="${img(join(out, `${name}-${key}.png`))}" style="display:block;border:1px solid #d4d4d4"></figure></div></body>`);
      await sheet.locator('#c').screenshot({ path: join(dirname(out), `compare-${name}-${key}.png`) });
    }
    await compose.close();
  }
  for (const [name, list] of Object.entries(report.viewports)) {
    for (const [key, facts] of Object.entries(list)) console.log(`${name.padEnd(8)} ${key.padEnd(14)} rows ${String(facts.onScreen).padStart(3)}  content ${String(facts.content).padStart(5)}px  shown ${String(Math.round(facts.shown * 100)).padStart(3)}%  small ${facts.small?.length ?? '-'}${facts.overflow ? '  OVERFLOW' : ''}`);
  }
} finally {
  await browser.close();
  for (const one of [server, chatServer]) { one.closeAllConnections?.(); one.close(); }
  store.close();
  chatStore.close();
  rmSync(sandbox, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
