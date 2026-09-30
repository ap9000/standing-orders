/** Settings → Updates screenshots (fixture): update checks off (Check now), the three update buttons, the
 * live steps mid-update, and the one-time What's new card, at 1440×900 and
 * 390×844. Runs the built console against a throwaway database; nothing is
 * downloaded or installed.
 *
 *   npm run build && node scripts/update-screens.mjs [--out evidence/toolroll-update]
 *
 * Playwright is not a dependency: imported from `playwright`, PLAYWRIGHT_MODULE, or the npx cache. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = resolve(at >= 0 ? args[at + 1] : 'evidence/toolroll-update');
mkdirSync(out, { recursive: true });
const dist = resolve('dist');
const load = name => import(pathToFileURL(join(dist, name)).href);
const { openStore } = await load('store.js');
const { addApprover } = await load('scope.js');
const { createDecisionServer } = await load('serve.js');
const { durableJson, sqliteLock } = await load('desktop-update.js');
const { setUpdateChecks } = await load('releases.js');

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const root = mkdtempSync(join(tmpdir(), 'toolroll-update-screens-'));
const stateDir = join(root, 'state'); mkdirSync(stateDir);
const store = openStore(join(stateDir, 'orders.db'));
const alex = addApprover(store, 'alex', new Date());
let installed = '0.6.0';
const server = createDecisionServer({ store, evidenceRoot: join(root, 'evidence'), updates: { latest: async () => ({ version: '0.7.0' }), method: 'global', get current() { return installed; }, launch: async () => {} } });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const id = '6f1c2d3e-4a5b-4c6d-8e7f-901234567890';
const stageDir = join(stateDir, 'staged-upgrades', `release-0.7.0-${id.slice(0, 8)}`);
mkdirSync(stageDir, { recursive: true, mode: 0o700 });
const t = minutes => new Date(Date.parse('2026-09-30T02:59:00Z') + minutes * 60_000).toISOString();
const journal = (phase, steps, detail, extra = {}) => {
  const j = { version: 1, id, kind: 'update', stateDir, databaseFile: join(stateDir, 'orders.db'), stageDir, from: { version: '0.6.0', dist: '/opt/homebrew/lib/node_modules/toolroll/dist' }, to: { version: '0.7.0', dist: join(stageDir, 'runtime/node_modules/toolroll/dist') },
    when: 'when-idle', at: null, actor: 'alex', phase, detail, steps: steps.map((p, i) => ({ phase: p, at: t(i) })), startedAt: t(0), updatedAt: t(steps.length), ...extra };
  durableJson(join(stateDir, 'toolroll-update.json'), j);
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const shots = [];
try {
  for (const [label, viewport] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]]) {
    const phone = viewport.width < 760;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', 'alex');
    await page.fill('input[name="token"]', alex.token);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    const shot = async (name, caption) => { const path = join(out, `${name}-${label}.png`); await page.screenshot({ path }); shots.push({ path, caption: `${caption} at ${label}px (fixture)` }); };

    rmSync(join(stateDir, 'toolroll-update.json'), { force: true }); installed = '0.6.0';
    setUpdateChecks(stateDir, false);
    await page.goto(`${base}/settings/updates`);
    await shot('updates-checks-off', 'Settings → Updates with update checks off: nothing is asked of npm until Check now');
    setUpdateChecks(stateDir, true);
    await page.goto(`${base}/settings/updates`);
    await shot('updates-buttons', 'Settings → Updates: 0.7.0 available, password step-up, Update now / When idle / Tonight (03:00)');

    journal('backing-up', ['verifying', 'draining', 'backing-up'], 'Backing up the database.');
    const lock = sqliteLock(join(stageDir, 'worker.sqlite'));
    await page.goto(`${base}/settings/updates`);
    await shot('updates-live', 'Live steps while updating: package verified, running work finished, backing up now');
    lock.close();

    journal('complete', ['verifying', 'draining', 'backing-up', 'rehearsing', 'switching', 'restarting', 'health', 'complete'], 'Toolroll 0.7.0 is running.', { finishedAt: t(9),
      notes: ['Update from the console', 'Undo an update with toolroll update --rollback', 'Scheduled updates run tonight at 03:00'] });
    installed = '0.7.0';
    await page.goto(`${base}/settings/updates`);
    await shot('updates-whats-new', "One-time What's new in 0.7.0 card after the update");
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  store.close();
  rmSync(root, { recursive: true, force: true });
}
for (const one of shots) console.log(`${one.path} — ${one.caption}`);
