// Synthetic visual proof for sign-in pauses: one Claude run fails with the
// 2026-09-29 words, through the real tick, gateway and failure seal (scripted
// agent, real git, no model call). Then the actual `status`, `ready` and
// `task show` output, and the console at desktop and phone sizes.
// Build first (`npm run build`); run with an isolated HOME.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOperate } from '../dist/operate.js';
import { openStore } from '../dist/store.js';
import { register } from '../dist/runner.js';
import { createDecisionServer } from '../dist/serve.js';
import { run } from '../dist/exec.js';

const out = resolve('evidence/auth-expired-pause');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-auth-proof-')));
const repo = join(base, 'payments'), db = join(base, 'toolroll.db'), pool = join(base, 'pool'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'proof@example.com']); git(['config', 'user.name', 'Proof']);
writeFileSync(join(repo, 'README.md'), 'payments\n'); git(['add', '.']); git(['commit', '-qm', 'first']);

let lines = [];
const T0 = new Date();
const cli = (argv, agentRunner) => { lines = []; return runOperate(argv[0], argv.slice(1), line => lines.push(line), { databaseFile: db, now: T0, evidenceRoot, ...(agentRunner ? { agentRunner } : {}) }); };
const json = () => JSON.parse(lines.join('\n'));
await cli(['approver', 'add', 'alex', '--json']);
const token = json().token;
for (const phase of ['build', 'plan', 'review']) await cli(['config', 'set', phase, '--provider', 'claude', '--model', 'sonnet', '--as', 'alex', '--token', token, '--json']);
const seed = openStore(db);
const runnerToken = register(seed, { name: 'builder-1', host: 'proof', capacity: 4, repos: [repo], now: T0 }).token;
seed.close();
for (const [id, title, goal] of [
  ['payout-rounding', 'Fix the payout rounding drift', 'Round each payout line at cent precision before totalling'],
  ['csv-header', 'Add a header row to every CSV export', 'Emit one header row naming every column'],
]) {
  await cli(['task', 'add', title, '--id', id, '--repo', repo]);
  await cli(['task', 'scope', id, '--goal', goal, '--acceptance', 'It is fixed and verified.|check']);
  await cli(['task', 'approve', id, '--json']);
  await cli(['task', 'approve', id, '--yes', '--digest', json().scope.digest, '--as', 'alex', '--token', token]);
}
// A real short-lived process stands where `claude` would, so the run's process
// custody is recorded exactly as for a real spawn; it prints the incident's stream.
const stream = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
].join('\n');
// (Without the agent fence's sandbox wrapper, which cannot nest inside the proof's own sandbox.)
const signedOut = (_file, _args, { fence: _fence, ...options } = {}) => run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stream)}); process.exit(1)`], options);
await cli(['tick', '--runner', 'builder-1', '--token', runnerToken, '--repo', repo, '--pool', pool, '--json'], signedOut);
const tick = json();
const failed = tick.dispatched.find(one => one.outcome === 'failed');
if (failed?.reason !== 'auth-expired — requeued, sign-in needed') throw Error(`unexpected tick: ${JSON.stringify(tick.dispatched)}`);

const transcript = [];
for (const argv of [['status'], ['ready'], ['task', 'show', failed.id]]) {
  await cli(argv);
  transcript.push(`$ toolroll ${argv.join(' ')}`, ...lines.join('\n').split('\n'), '');
}
writeFileSync(join(out, 'cli-output.txt'), transcript.join('\n'));

const store = openStore(db);
const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {} });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
try {
  const escape = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const terminal = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const shell = await terminal.newPage();
  await shell.setContent(`<html><body style="margin:0;background:#101114;color:#e8e8ea;font:14px/1.5 ui-monospace,Menlo,monospace"><pre style="margin:0;padding:24px;white-space:pre-wrap">${escape(transcript.join('\n'))}</pre></body></html>`);
  await shell.screenshot({ path: join(out, 'cli-status-ready-task-show.png'), fullPage: true });
  await terminal.close();

  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${url}/work`);
    await page.getByLabel('Username').fill('alex');
    await page.getByLabel('Password').fill(token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    for (const [shot, path] of [['work', '/work'], ['task', `/t/${failed.id}`]]) {
      await page.goto(`${url}${path}`);
      const alert = page.locator('[data-sign-in="claude"]').first();
      await alert.waitFor();
      const body = await page.locator('body').innerText();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const button = await page.getByRole('button', { name: 'Resume Claude' }).first().boundingBox();
      if (!body.includes('Claude needs you to sign in again') || !body.includes('claude /login') || overflow || errors.length > 0) throw Error(`${name} ${shot}: ${JSON.stringify({ overflow, errors })}`);
      await page.screenshot({ path: join(out, `${name}-${shot}.png`) });
      checks.push({ viewport, shot, path, signInShown: true, resumeButton: button, overflow, errors });
    }
    await context.close();
  }
  // The one action works: a person resumes, the banner goes, the tasks are ready again.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${url}/work`);
  await page.getByLabel('Username').fill('alex');
  await page.getByLabel('Password').fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.goto(`${url}/work`);
  await page.getByRole('button', { name: 'Resume Claude' }).first().click();
  await page.waitForURL(`${url}/work`);
  const after = await page.locator('body').innerText();
  if (after.includes('Claude needs you to sign in again')) throw Error('resume did not lift the pause');
  await page.screenshot({ path: join(out, 'desktop-after-resume.png') });
  checks.push({ shot: 'after-resume', signInShown: false, resumedMessage: store.handle.prepare("SELECT subject FROM notification WHERE kind = 'auth-restored'").get()?.subject ?? null });
  await context.close();
  writeFileSync(join(out, 'ui-report.json'), JSON.stringify({ synthetic: true, modelCalls: 0, note: 'Scripted Claude agent that fails with the 2026-09-29 sign-in error; real tick, gateway, failure seal, CLI and console. Not a live-provider or physical-device proof.', tick: tick.dispatched, checks }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, out, checks: checks.length }));
} finally {
  await browser.close();
  server.closeAllConnections(); server.close(); store.close();
  rmSync(base, { recursive: true, force: true });
}
