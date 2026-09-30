// Synthetic visual proof for the update notice: a cached daily check that found
// a newer (security) Toolroll, two workers on different versions, then the
// actual `status` output and the console at desktop and phone sizes — the
// quiet notice, Settings → Updates, and dismissing the notice. No network: the
// release is written into the cache the daily check keeps beside the database.
// Build first (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOperate } from '../dist/operate.js';
import { openStore } from '../dist/store.js';
import { register } from '../dist/runner.js';
import { createDecisionServer } from '../dist/serve.js';
import { recordRunnerVersion, RELEASE_CACHE_FILE } from '../dist/releases.js';
import { PACKAGE_VERSION } from '../dist/version.js';

delete process.env.TOOLROLL_NO_UPDATE_CHECK;
const out = resolve('evidence/update-notice');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-update-proof-')));
const repo = join(base, 'payments'), db = join(base, 'orders.db'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
const T0 = new Date();
const [major, minor] = PACKAGE_VERSION.split('.').map(Number);
const latest = `${major}.${minor + 1}.0`;
const notes = [
  `## ${latest}`,
  '',
  '### Security',
  '- A task branch name can no longer point a worktree outside the checkout pool.',
  '',
  '### Improvements',
  '- Settings → Updates shows this version, the latest one and how to update.',
  '- Workers say which Toolroll they run, so an older one is easy to spot.',
  '- Faster start-up when many projects are enrolled.',
  '',
  '### Fixes',
  '- The Tasks list keeps its scroll position after a refresh.',
].join('\n');
writeFileSync(join(base, RELEASE_CACHE_FILE), JSON.stringify({ checkedAt: T0.toISOString(), release: { version: latest, notes, url: '', security: true } }));

let lines = [];
const cli = argv => { lines = []; return runOperate(argv[0], argv.slice(1), line => lines.push(line), { databaseFile: db, now: T0, evidenceRoot, installBin: '/opt/homebrew/Cellar/toolroll/0.6.0/libexec/lib/node_modules/toolroll/dist/bin.js' }); };
await cli(['approver', 'add', 'alex', '--json']);
const token = JSON.parse(lines.join('\n')).token;
const seed = openStore(db);
register(seed, { name: 'studio-mac', host: 'proof', capacity: 3, repos: [repo], now: T0 });
register(seed, { name: 'build-box', host: 'proof', capacity: 2, repos: [repo], now: T0 });
seed.close();
recordRunnerVersion(base, 'studio-mac', PACKAGE_VERSION, T0);
recordRunnerVersion(base, 'build-box', `${major}.${Math.max(0, minor - 1)}.2`, T0);

await cli(['status']);
const transcript = ['$ toolroll status', ...lines.join('\n').split('\n'), ''];
writeFileSync(join(out, 'cli-status.txt'), transcript.join('\n'));
if (!transcript.some(line => line.startsWith(`${latest} is available — toolroll update · brew upgrade ap9000/toolroll/toolroll · https://github.com/ap9000/toolroll/releases/tag/v${latest}`))) throw Error(`status line missing: ${transcript.join('\n')}`);

const store = openStore(db);
const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base, telegramTokenFile: join(base, 'telegram-token'),
  installBin: '/opt/homebrew/Cellar/toolroll/0.6.0/libexec/lib/node_modules/toolroll/dist/bin.js' });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
try {
  const escape = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const terminal = await browser.newContext({ viewport: { width: 1200, height: 520 } });
  const shell = await terminal.newPage();
  await shell.setContent(`<html><body style="margin:0;background:#101114;color:#e8e8ea;font:14px/1.5 ui-monospace,Menlo,monospace"><pre style="margin:0;padding:24px;white-space:pre-wrap">${escape(transcript.join('\n'))}</pre></body></html>`);
  await shell.screenshot({ path: join(out, 'cli-status.png'), fullPage: true });
  await terminal.close();

  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${url}/work`);
    await page.getByLabel('Username').fill('alex');
    await page.getByLabel('Password').fill(token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.goto(`${url}/work`);
    const notice = page.locator(`[data-update="${latest}"]`).first();
    await notice.waitFor();
    const noticeStyle = await notice.evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, color: style.color }; });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const dismiss = await page.getByRole('button', { name: `Dismiss the notice about ${latest}` }).boundingBox();
    if (overflow || errors.length > 0) throw Error(`${name} notice: ${JSON.stringify({ overflow, errors })}`);
    await page.screenshot({ path: join(out, `${name}-notice.png`) });
    checks.push({ viewport, shot: 'notice', noticeStyle, dismissButton: dismiss, overflow, errors: [...errors] });

    await page.goto(`${url}/settings#updates`);
    const section = page.locator('#updates');
    await section.waitFor();
    await page.getByRole('button', { name: `What's new in ${latest}` }).click();
    await page.locator('[data-update-notes]').waitFor();
    // The link lands on the section by itself; the frame must not move with it.
    const shifted = await page.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) + (document.body?.scrollTop ?? 0));
    if (shifted !== 0) throw Error(`${name}: the page frame scrolled by ${shifted}px`);
    const text = await section.innerText();
    const wanted = [`This version ${PACKAGE_VERSION}`, `${latest} is available`, 'Security fixes', 'brew upgrade ap9000/toolroll/toolroll', 'Check for a newer version once a day', 'build-box', 'Older'];
    const missing = wanted.filter(one => !text.includes(one));
    const overflowSettings = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (missing.length > 0 || overflowSettings || errors.length > 0) throw Error(`${name} settings: ${JSON.stringify({ missing, overflowSettings, errors })}`);
    await page.screenshot({ path: join(out, `${name}-settings-updates.png`) });
    checks.push({ viewport, shot: 'settings-updates', shown: wanted, overflow: overflowSettings });

    // Dismissed: gone now, and still gone after a reload, for this version.
    await page.goto(`${url}/work`);
    await page.getByRole('button', { name: `Dismiss the notice about ${latest}` }).click();
    await page.locator(`[data-update="${latest}"]`).waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    await page.reload();
    await page.locator('[data-workspace-shell]').waitFor();
    const stillThere = await page.locator(`[data-update="${latest}"]`).count();
    if (stillThere !== 0) throw Error(`${name}: the notice came back after dismissal`);
    if (name === 'desktop') await page.screenshot({ path: join(out, 'desktop-dismissed.png') });
    checks.push({ viewport, shot: 'dismissed', noticeAfterReload: stillThere });
    await context.close();
  }
  writeFileSync(join(out, 'ui-report.json'), JSON.stringify({ synthetic: true, network: false, note: `A cached daily check that found ${latest} (a security release; sample notes written for this proof), two registered workers with reported versions, the real CLI status and console. No request reaches npm or GitHub.`, checks }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, out, checks: checks.length }));
} finally {
  await browser.close();
  server.closeAllConnections(); server.close(); store.close();
  rmSync(base, { recursive: true, force: true });
}
