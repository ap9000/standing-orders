// Synthetic visual proof for Settings → Integrations, at desktop and phone
// sizes. A fresh installation with one project and a mix of states: Telegram
// connected, Slack, Discord and Teams not set up, GitHub signed in with push
// rights, a Linear key that Linear refuses, email reachable, one MCP server
// that starts and one missing its secret, a failing audit webhook, Claude
// signed in and Codex signed out. No network and no model: every outside
// answer is stubbed. The first render answers at once (checks still running);
// the page is then reloaded once the background checks are in. Build first
// (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';
import { addToolTo, validateToolSpec } from '../dist/project-tools.js';
import { saveEmailSettings } from '../dist/email-settings.js';
import { saveMonitoring, NO_MONITORING } from '../dist/monitoring-settings.js';
import { targetOf } from '../dist/monitoring.js';

const out = resolve('evidence/integrations-health');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-integrations-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });

// The installation's own settings files, as the setup pages write them.
writeFileSync(join(base, 'telegram-token'), `7012345678:${'A'.repeat(20)}bcdefghijklmnopq\n`, { mode: 0o600 });
writeFileSync(join(base, 'linear-key'), `lin_api_${'r'.repeat(32)}\n`, { mode: 0o600 });
const email = saveEmailSettings(base, { host: 'smtp.fastmail.com', port: '587', secure: '', user: 'alex@bookshelf.example', from: 'alex@bookshelf.example', password: 'app-password-123', imapHost: 'imap.fastmail.com', imapPort: '993' });
if (!email.ok) throw Error(`email: ${email.message}`);
saveMonitoring(base, { webhook: 'https://logs.bookshelf.example/toolroll', folder: '', tracesEndpoint: '', headerName: '', headerValue: '', rotate: false }, NO_MONITORING);

// A small stdio MCP server that starts and lists two tools.
const serverFile = join(base, 'catalog-mcp.mjs');
writeFileSync(serverFile, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "catalog", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "find_book", inputSchema: { type: "object" } }, { name: "list_loans", inputSchema: { type: "object" } }] });
});
`);

const store = openStore(':memory:');
const login = addApprover(store, 'alex', new Date());
store.upsertProject(repo, 'bookshelf', new Date());
if (!addToolTo(store, repo, validateToolSpec({ name: 'catalog', command: process.execPath, args: [serverFile], secrets: [], about: 'The library catalogue' }), 'proof', 'alex', new Date(), { home: base }).ok) throw Error('catalog tool');
if (!addToolTo(store, repo, validateToolSpec({ name: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], secrets: [{ name: 'SENTRY_TOKEN', optional: false }], about: 'Errors from Sentry' }), 'proof', 'alex', new Date(), { home: base }).ok) throw Error('sentry tool');
// The audit webhook has been failing for a while.
const failedAt = new Date(Date.now() - 12 * 60_000).toISOString(), okAt = new Date(Date.now() - 3 * 3600_000).toISOString();
store.handle.prepare('INSERT INTO monitoring_status (sink, target, through, sent, last_ok_at, last_error, last_error_at, failures) VALUES (?, ?, 40, 40, ?, ?, ?, 3)')
  .run('webhook', targetOf('https://logs.bookshelf.example/toolroll'), okAt, 'logs.bookshelf.example answered 503 Service Unavailable', failedAt);

const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false });
const gh = async (_file, args) => args[0] === 'api' ? ok('alex-reads\n') : ok(JSON.stringify({ nameWithOwner: 'bookshelf-co/bookshelf', viewerPermission: 'WRITE' }));
const fetcher = async (url) => String(url).includes('api.telegram.org')
  ? new Response(JSON.stringify({ ok: true, result: { id: 7012345678, is_bot: true, username: 'bookshelf_alerts_bot' } }), { status: 200 })
  : String(url).includes('linear') ? new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), { status: 401 })
  : new Response('{}', { status: 404 });
const probe = async file => file === 'claude'
  ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'alex@bookshelf.example' }))
  : { code: 1, stdout: 'Not logged in\n', stderr: '', timedOut: false, notFound: false };

const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base, telegramTokenFile: join(base, 'telegram-token'), toolHome: base,
  connectionProbe: probe, integrationIo: { fetch: fetcher, gh, reach: async () => {} } });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
try {
  const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];
  for (const [name, viewport] of viewports) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${url}/chat`);
    await page.getByLabel('Username').fill('alex');
    await page.getByLabel('Password').fill(login.token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.goto(`${url}/settings/integrations`);
    for (let tries = 0; tries < 40 && (await page.locator('.integration-state--checking').count()) > 0; tries += 1) {
      await new Promise(done => setTimeout(done, 250));
      await page.reload();
    }
    const rows = await page.locator('[data-integration]').evaluateAll(list => list.map(one => ({ key: one.dataset.integration, state: one.dataset.state, action: one.querySelector('.integration-action button, .integration-action a')?.textContent ?? null })));
    const facts = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth }));
    const text = await page.locator('.integrations').innerText();
    if (facts.overflow || errors.length > 0 || rows.length < 10 || /lin_api_|AAAAAAAA|app-password/.test(await page.content())) throw Error(`${name}: ${JSON.stringify({ facts, errors, rows })}`);
    await page.screenshot({ path: join(out, `${name}-integrations.png`) });
    // The rest of the list: the page scrolls inside the workspace, so a second shot at the end.
    await page.locator('[data-integration="agent:codex"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${name}-integrations-end.png`) });
    if (name === 'desktop') {
      // Send test on a connected integration: a harmless read-only check, then the answer at the top.
      await page.locator('[data-integration="telegram"] button', { hasText: 'Send test' }).click();
      await page.locator('.integrations [role="status"]').first().waitFor();
      await page.screenshot({ path: join(out, 'desktop-send-test.png') });
      await page.goto(`${url}/settings`);
      await page.screenshot({ path: join(out, 'desktop-settings-tile.png') });
    }
    checks.push({ viewport, rows, text: text.slice(0, 400), ...facts });
    await context.close();
  }
  writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ synthetic: true, checks }, null, 2)}\n`);
  console.log(JSON.stringify(checks.map(one => ({ viewport: one.viewport, rows: one.rows })), null, 2));
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
