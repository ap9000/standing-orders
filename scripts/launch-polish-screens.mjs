/** Launch polish screenshots (demo sandbox, synthetic data): a Ready result
 * opened in Chat at 1440×900 and 390×844, and the text a person reads in it.
 *
 *   npm run build && node scripts/launch-polish-screens.mjs [--out evidence/launch-polish] [--name after] [--task confirm-empty-state-copy]
 *
 * Playwright is not a dependency: imported from `playwright`, PLAYWRIGHT_MODULE, or the npx cache. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const out = resolve(flag('--out', 'evidence/launch-polish'));
const name = flag('--name', 'after');
const only = flag('--task', null);
mkdirSync(out, { recursive: true });
const load = file => import(pathToFileURL(join(resolve('dist'), file)).href);
const { createDemoSandbox } = await load('demo.js');
const { createDecisionServer } = await load('serve.js');

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [];
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) { try { return await import(pathToFileURL(one).href); } catch { /* next */ } }
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const { store, seed, evidenceRoot } = createDemoSandbox(new Date());
const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repos: seed.repos });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
// Every finished build of a task: the results a person can open in Chat.
const results = [];
for (let id = 1, misses = 0; misses < 20; id++) {
  const run = store.getRun(id);
  if (run === null) { misses++; continue; }
  misses = 0;
  if (run.outcome === 'built' || run.outcome === 'no-change') results.push({ run: id, task: store.refForId(run.taskRef).externalId });
}
results.splice(0, results.length, ...results.filter(one => only === null || one.task === only));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const text = [];
try {
  for (const [label, viewport] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]]) {
    const phone = viewport.width < 760;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', seed.login.name);
    await page.fill('input[name="token"]', seed.login.password);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    for (const one of results) {
      await page.goto(`${base}/chat?task=${encodeURIComponent(one.task)}&result=${one.run}`);
      const panel = page.locator('[data-result-panel]').first();
      await panel.waitFor();
      const file = `${name}-${one.task}-${one.run}-${label}.png`;
      await page.screenshot({ path: join(out, file), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      text.push(`== ${one.task} run ${one.run} at ${label}${overflow ? ' (document overflows)' : ''}\n${(await page.locator("main, body").first().innerText()).trim()}\n`);
      console.log(join(out, file));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  store.close();
}
writeFileSync(join(out, `${name}-text.txt`), text.join('\n'));
