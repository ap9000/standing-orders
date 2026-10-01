// Synthetic visual proof for the flow gallery (Flows → New) and two template pages (Overnight bug bash, Weekly
// upkeep), at desktop and phone sizes, light and dark. A fresh installation with one project on GitHub; on the
// phone, Create flow is pressed once for real. No network and no model. Build first (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';

const out = resolve('evidence/flow-gallery');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-gallery-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:bookshelf-co/bookshelf.git']);

const store = openStore(':memory:');
const login = addApprover(store, 'alex', new Date());
store.upsertProject(repo, 'bookshelf', new Date());

const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
const measure = async (tab, name) => {
  const facts = await tab.evaluate(() => {
    const taps = [...document.querySelectorAll('.gallery-card .button-link, .gallery-actions button, .gallery-use input:not([type=hidden]), .gallery-use select')].map(one => one.getBoundingClientRect());
    return { overflow: document.documentElement.scrollWidth > innerWidth, smallestTap: taps.length === 0 ? null : Math.min(...taps.map(one => Math.round(one.height))), wrappedButton: [...document.querySelectorAll('.gallery-card .button-link, .gallery-actions button')].some(one => one.getBoundingClientRect().height > 60) };
  });
  checks.push({ name, ...facts });
  return facts;
};
try {
  const runs = [['desktop', { width: 1440, height: 900 }, 'light'], ['phone', { width: 390, height: 844 }, 'light'], ['desktop', { width: 1440, height: 900 }, 'dark'], ['phone', { width: 390, height: 844 }, 'dark']];
  for (const [name, viewport, scheme] of runs) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: scheme });
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(`${url}/chat`);
    await tab.getByLabel('Username').fill('alex');
    await tab.getByLabel('Password').fill(login.token);
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
    const suffix = `${name}${scheme === 'dark' ? '-dark' : ''}`;

    await tab.goto(`${url}/flows/new`);
    const groups = await tab.locator('.gallery h2').allTextContents();
    const cards = await tab.locator('[data-template]').count();
    const facts = await measure(tab, `gallery ${suffix}`);
    if (facts.overflow || (name === 'phone' && facts.smallestTap < 44) || facts.wrappedButton || errors.length > 0 || cards < 20) throw Error(`${suffix} gallery: ${JSON.stringify({ facts, errors, groups, cards })}`);
    await tab.screenshot({ path: join(out, `${suffix}-gallery.png`) });

    for (const template of scheme === 'dark' ? ['weekly-upkeep'] : ['overnight-bug-bash', 'weekly-upkeep']) {
      await tab.goto(`${url}/flows/new/${template}`);
      if (template === 'weekly-upkeep') {
        // Real answers: pip on Monday mornings, previewed before anything is made.
        await tab.selectOption('form[data-gallery-use] select[name="outdated"]', 'pip');
        await tab.fill('form[data-gallery-use] input[name="schedule"]', 'monday 08:30');
        await Promise.all([tab.waitForNavigation(), tab.click('form[data-gallery-use] button[value="preview"]')]);
      }
      await tab.locator('.gallery-preview details').evaluate(one => { one.open = true; });
      const use = await measure(tab, `${template} ${suffix}`);
      if (use.overflow || (name === 'phone' && use.smallestTap < 44) || use.wrappedButton || errors.length > 0) throw Error(`${suffix} ${template}: ${JSON.stringify({ use, errors })}`);
      await tab.locator('.gallery-preview details').evaluate(one => { one.open = false; });
      // The sheet scrolls, not the page: on a phone, show the preview and its buttons.
      if (name === 'phone') await tab.locator('.gallery-preview').evaluate(one => one.scrollIntoView({ block: 'start' }));
      await tab.screenshot({ path: join(out, `${suffix}-${template}.png`) });
    }
    if (name === 'phone' && scheme === 'light') {
      // One Create: the weekly upkeep previewed above becomes a flow with its schedule and its script.
      await Promise.all([tab.waitForNavigation(), tab.click('form[data-gallery-use] button[value="create"]')]);
      if (!/\/flows\/\d+$/.test(tab.url())) throw Error(`create went to ${tab.url()}`);
    }
    await context.close();
  }
  const flows = store.listFlows([repo]).map(one => ({ name: one.name, triggers: store.flowTriggers(one.id).map(t => JSON.parse(t.configJson)), zones: JSON.parse(one.definitionJson).stages.map(s => s.kind), scripts: store.flowScripts(repo).map(s => s.name) }));
  if (flows.length !== 1 || flows[0].name !== 'Weekly upkeep') throw Error(`flows: ${JSON.stringify(flows)}`);
  writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ synthetic: true, checks, flows }, null, 2)}\n`);
  console.log(JSON.stringify({ checks, flows }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
