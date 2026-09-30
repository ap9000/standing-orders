// Synthetic visual proof for the first run: a fresh installation with one
// project, at desktop and phone sizes. (1) No agent signed in: the three steps,
// with the sandbox and the sign-in command side by side. (2) An agent signed
// in: Chat opens with three first tasks read from the project's TODO comments;
// a tap drafts one in the composer and nothing is filed. (3) After the first
// Ready result: Settings shows how long it took. No network and no model: the
// sign-in checks are stubbed and `gh` is refused, so the repository's TODOs
// are the source. Build first (`npm run build`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';
import { run } from '../dist/exec.js';

const out = resolve('evidence/first-run');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-first-run-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
writeFileSync(join(repo, 'src', 'search.ts'), 'export function search(query: string) {\n  // TODO: ignore accents when matching titles\n  return query.trim();\n}\n');
writeFileSync(join(repo, 'src', 'loans.ts'), 'export function dueDate(from: Date) {\n  // FIXME: due dates ignore the library\'s closed days\n  return new Date(from.getTime() + 14 * 864e5);\n}\n');
writeFileSync(join(repo, 'README.md'), '# Bookshelf\n\nA small library catalogue.\n');
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', '.'], { cwd: repo });

const signedOut = async file => ({ code: 1, stdout: file === 'codex' ? 'Not logged in\n' : JSON.stringify({ loggedIn: false }), stderr: '', timedOut: false, notFound: false });
const signedIn = async file => file === 'claude'
  ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }), stderr: '', timedOut: false, notFound: false }
  : { code: 1, stdout: 'Not logged in\n', stderr: '', timedOut: false, notFound: false };
// No GitHub remote in this proof: `gh` is refused, `git grep` runs for real.
const repoReads = (file, args, options) => file === 'gh' ? Promise.resolve({ code: 1, stdout: '', stderr: 'no GitHub remote', timedOut: false, notFound: false }) : run(file, args, options);

const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [], servers = [];
const serve = async (store, extra) => {
  const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base, telegramTokenFile: join(base, 'telegram-token'), firstTaskRunner: repoReads,
    subscriptionChatRunner: async () => ({ ok: true, answer: { text: 'Not used in this proof.', calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } }), ...extra });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};
const signIn = async (page, url, token) => {
  await page.goto(`${url}/chat`);
  await page.getByLabel('Username').fill('alex');
  await page.getByLabel('Password').fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.goto(`${url}/chat`);
  await page.locator('[data-workspace-shell]').waitFor();
};
const inspect = async page => page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--so-signal').trim(),
}));
const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];
try {
  // (1) No agent signed in, no chat set up yet.
  {
    const store = openStore(':memory:');
    const login = addApprover(store, 'alex', new Date());
    const url = await serve(store, { connectionProbe: signedOut });
    for (const [name, viewport] of viewports) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await signIn(page, url, login.token);
      const card = page.locator('[data-first-run]').first();
      await card.waitFor();
      const choices = page.locator('[data-first-run-choices] > div');
      const boxes = [await choices.nth(0).boundingBox(), await choices.nth(1).boundingBox()];
      const sideBySide = boxes[0] !== null && boxes[1] !== null && Math.abs(boxes[0].y - boxes[1].y) < 2 && boxes[1].x > boxes[0].x + boxes[0].width - 1;
      const text = await card.innerText();
      const wanted = ['Get to your first result', 'Agent signed in', 'Project added', 'Your first task', 'Try the sandbox', 'npx toolroll demo', 'Sign in an agent', 'claude auth login', 'New task'];
      const missing = wanted.filter(one => !text.includes(one));
      const facts = await inspect(page);
      if (!sideBySide || missing.length > 0 || facts.overflow || errors.length > 0) throw Error(`${name} signed out: ${JSON.stringify({ sideBySide, boxes, missing, ...facts, errors })}`);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `${name}-no-agent.png`) });
      checks.push({ viewport, shot: `${name}-no-agent`, sideBySide, shown: wanted, ...facts });
      await context.close();
    }
    store.close();
  }

  // (2) An agent signed in and chat set up: Chat opens with three first tasks.
  {
    const store = openStore(':memory:');
    const login = addApprover(store, 'alex', new Date());
    store.setChatConfig({ provider: 'claude-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'alex', new Date());
    const url = await serve(store, { connectionProbe: signedIn });
    for (const [name, viewport] of viewports) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await signIn(page, url, login.token);
      await page.locator('[data-first-tasks]').waitFor();
      const labels = await page.locator('[data-first-tasks] button').allInnerTexts();
      const facts = await inspect(page);
      if (labels.length !== 3 || facts.overflow || errors.length > 0) throw Error(`${name} suggestions: ${JSON.stringify({ labels, ...facts, errors })}`);
      await page.screenshot({ path: join(out, `${name}-first-tasks.png`) });
      await page.locator('[data-first-tasks] button').first().click();
      const drafted = await page.locator('#lead-message').inputValue();
      const filed = store.hasAnyWork();
      if (!drafted.startsWith('Resolve the note in ') || filed) throw Error(`${name} draft: ${JSON.stringify({ drafted, filed })}`);
      await page.screenshot({ path: join(out, `${name}-drafted.png`) });
      checks.push({ viewport, shot: `${name}-first-tasks`, suggestions: labels, drafted, filedAfterTap: filed, ...facts });
      await context.close();
    }
    store.close();
  }

  // (3) After the first Ready result: Settings shows how long it took.
  {
    const store = openStore(':memory:');
    const now = new Date();
    const login = addApprover(store, 'alex', new Date(now.getTime() - 7 * 60_000));
    store.createTask({ id: 'readme-setup', title: 'Improve the README setup section', repo }, now);
    const ref = store.refFor('built-in', 'readme-setup').id;
    const authority = store.routeAuthorityFor(ref, 'builder') ?? store.routeAuthorityFor(ref, 'builder', null, { provider: 'claude', model: null });
    if (authority === null || !authority.ok) throw Error('proof seed: no route');
    const runId = store.startRun({ taskRef: ref, leaseId: 'lease-proof', runner: 'studio-mac', branch: 'toolroll/readme-setup', worktree: join(base, 'wt'), now, route: authority.stamp });
    store.finishRun(runId, { outcome: 'built', committed: true, now });
    const url = await serve(store, { connectionProbe: signedIn });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await signIn(page, url, login.token);
    const gone = await page.locator('[data-first-run]').count();
    await page.goto(`${url}/settings#updates`);
    const fact = page.locator('[data-first-result]').first();
    await fact.waitFor();
    const words = await fact.innerText();
    if (gone !== 0 || words !== 'First result in 7 min') throw Error(`settings: ${JSON.stringify({ gone, words })}`);
    await fact.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, 'desktop-settings-first-result.png') });
    checks.push({ shot: 'desktop-settings-first-result', firstRunShownAfterResult: gone !== 0, words });
    await context.close();
    store.close();
  }
  writeFileSync(join(out, 'ui-report.json'), JSON.stringify({ synthetic: true, network: false, note: 'A fresh installation with one sample project (bookshelf). Sign-in checks are stubbed; gh is refused so the TODO comments are the source; no model is called.', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, out, checks: checks.length }));
} finally {
  await browser.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  rmSync(base, { recursive: true, force: true });
}
