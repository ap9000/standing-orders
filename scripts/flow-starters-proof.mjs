// Synthetic visual proof for Settings → Flows (the starter flows), at desktop and phone sizes. A fresh
// installation with one project on GitHub: one starter already on (Fix failing CI), the overnight queue marked
// as the one a task's "Do this every time…" asked about, and Switch on pressed once for real (on the phone). No network and no
// model. Build first (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';
import { starterOf, switchOnStarter } from '../dist/flow-starters.js';

const out = resolve('evidence/flow-starters');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-starters-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:bookshelf-co/bookshelf.git']);

const store = openStore(':memory:');
const login = addApprover(store, 'alex', new Date());
store.upsertProject(repo, 'bookshelf', new Date());
const on = switchOnStarter(store, starterOf('ci-fix'), repo, 'alex', new Date(), base);
if (!on.ok) throw Error(on.said);

const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const page = (repo, starter) => `${url}/settings/flows?repo=${encodeURIComponent(repo)}${starter ? `&starter=${starter}` : ''}`;

const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
try {
  // Phone last: it presses Switch on once the offers are captured at both sizes.
  const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];
  for (const [name, viewport] of viewports) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(`${url}/chat`);
    await tab.getByLabel('Username').fill('alex');
    await tab.getByLabel('Password').fill(login.token);
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
    await tab.goto(page(repo, 'overnight'));
    const rows = await tab.locator('[data-starter]').evaluateAll(list => list.map(one => ({ id: one.dataset.starter, suggested: one.dataset.suggested, action: one.querySelector('.starter-action button, .starter-action a')?.textContent ?? null })));
    const facts = await tab.evaluate(() => {
      const buttons = [...document.querySelectorAll('.starter-action button, .starter-action a')].map(one => one.getBoundingClientRect());
      return { overflow: document.documentElement.scrollWidth > innerWidth, smallestTap: Math.min(...buttons.map(one => one.height)), wrappedButton: buttons.some(one => one.height > 60) };
    });
    if (facts.overflow || facts.smallestTap < 44 || facts.wrappedButton || errors.length > 0 || rows.length !== 3) throw Error(`${name}: ${JSON.stringify({ facts, errors, rows })}`);
    await tab.screenshot({ path: join(out, `${name}-settings-flows.png`), fullPage: name === 'phone' });
    if (name === 'phone') {
      // One yes: Switch on the suggested starter, then the page says so and links its flow.
      await tab.locator('[data-starter="overnight"] button', { hasText: 'Switch on' }).click();
      await tab.locator('.starters [role="status"]').first().waitFor();
      await tab.screenshot({ path: join(out, 'phone-switched-on.png') });
    }
    checks.push({ viewport, rows, ...facts });
    await context.close();
  }
  const flows = store.listFlows([repo]).map(one => ({ name: one.name, triggers: store.flowTriggers(one.id).map(t => t.kind), zones: JSON.parse(one.definitionJson).stages.map(s => s.kind) }));
  writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ synthetic: true, checks, flows }, null, 2)}\n`);
  console.log(JSON.stringify({ checks, flows }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
