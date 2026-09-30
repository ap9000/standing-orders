/** Settings → Notifications screenshots (fixture): Only when I'm needed (the default), Every step, and the evening
 * digest, at 1440×900 and 390×844. Runs the built console against a throwaway database and really submits each
 * choice, then reads it back from the database; no chat is contacted.
 *
 *   npm run build && node scripts/quiet-chat-screens.mjs [--out evidence/quiet-chat]
 *
 * Playwright is not a dependency: imported from `playwright`, PLAYWRIGHT_MODULE, or the npx cache. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = resolve(at >= 0 ? args[at + 1] : 'evidence/quiet-chat');
mkdirSync(out, { recursive: true });
const dist = resolve('dist');
const load = name => import(pathToFileURL(join(dist, name)).href);
const { openStore } = await load('store.js');
const { addApprover } = await load('scope.js');
const { createDecisionServer } = await load('serve.js');

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) { try { return await import(pathToFileURL(one).href); } catch { /* next */ } }
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const root = mkdtempSync(join(tmpdir(), 'toolroll-quiet-chat-screens-'));
const stateDir = join(root, 'state'); mkdirSync(stateDir);
const store = openStore(join(stateDir, 'orders.db'));
const alex = addApprover(store, 'alex', new Date());
const server = createDecisionServer({ store, evidenceRoot: join(root, 'evidence'), telegramTokenFile: join(stateDir, 'telegram-token'), configDir: stateDir });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const shots = [];
const problems = [];
try {
  for (const [label, viewport] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]]) {
    const phone = viewport.width < 760;
    store.setNotificationPreference('alex', { mode: 'quiet', digestAt: null }, 'alex', new Date());
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', 'alex');
    await page.fill('input[name="token"]', alex.token);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    const section = page.locator('#notifications');
    const shot = async (name, caption) => {
      await section.scrollIntoViewIfNeeded();
      const path = join(out, `${name}-${label}.png`);
      await page.screenshot({ path });
      shots.push({ path: `evidence/quiet-chat/${name}-${label}.png`, caption: `${caption} at ${label}px (fixture)` });
    };

    await page.goto(`${base}/settings`);
    await section.waitFor();
    const box = await section.boundingBox();
    if (box === null || box.x < 0 || box.x + box.width > viewport.width + 1) problems.push(`${label}: the Notifications card overflows the viewport`);
    await shot('notifications-default', "Settings → Notifications: Only when I'm needed (default), Every step, Evening digest off");

    // Every step, really submitted: the page reloads with the saved choice.
    await Promise.all([page.waitForNavigation(), section.getByText('Every step', { exact: true }).click()]);
    await section.waitFor();
    if (store.notificationPreference('alex').mode !== 'all') problems.push(`${label}: Every step did not save`);

    // The evening digest's choices, then 19:00 saved.
    await section.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'At 19:00' }).waitFor();
    await shot('notifications-digest-times', 'Evening digest choices open after choosing Every step');
    await Promise.all([page.waitForNavigation(), page.getByRole('option', { name: 'At 19:00' }).click()]);
    await section.waitFor();
    const saved = store.notificationPreference('alex');
    if (saved.mode !== 'all' || saved.digestAt !== '19:00') problems.push(`${label}: evening digest did not save (${JSON.stringify(saved)})`);
    await shot('notifications-saved', 'Every step and an evening digest at 19:00, saved');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  store.close();
}
for (const one of shots) console.log(`${one.path}\t${one.caption}`);
if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1); }
