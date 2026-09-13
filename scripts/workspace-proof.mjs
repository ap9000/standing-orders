/** Workspace package 1 browser proof (2026-09-13): the Chat / Work /
 * Projects shell and the truthful status projection, exercised against the
 * isolated fixture (`scripts/ui-polish-fixture.mjs` with `secondProject`,
 * so three synthetic projects share one ceiling) in headless Chromium.
 * Captures exact-viewport screenshots and records the measurable facts the
 * result assessment cites: primary destinations per breakpoint, Work view
 * counts and empty states, same-run status agreement across four surfaces,
 * the All-projects run deep link, document overflow at 320/390/1440, the
 * task-list path wrap, and a NEW empty conversation per desktop viewport.
 *
 *   node scripts/workspace-proof.mjs [--out output/playwright/workspace-1/after] [--strict]
 *
 * Playwright is NOT a dependency of this package: the script imports it
 * from `playwright` when installed, else from PLAYWRIGHT_MODULE, else from
 * the npx cache. With --strict any failed check exits 1. Nothing here
 * touches a real database, worker, key, or model. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'output/playwright/workspace-1/after');
const strict = args.includes('--strict');
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, laptop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
const report = { generatedAt: new Date().toISOString(), out, fixture: 'synthetic — scripts/ui-polish-fixture.mjs { secondProject: true }', checks: [], payloads: {}, screenshots: [], statuses: {} };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
const fixture = await startFixture({ secondProject: true, slowMs: 1500 });
const browser = await chromium.launch();
const T = fixture.statusTasks;
const R = fixture.statusRuns;

async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await submit(page, 'button[type="submit"]');
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path, caption });
  return path;
};
/** Click a submit and wait for a NEW document — robust to the chat page's
 * own reload racing the POST redirect (a bare waitForNavigation aborts). */
async function submit(page, selector) {
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
}
/** POST the switcher's own form (the session's csrf) and land on a page. */
async function switchProject(page, action, path, returnTo = '/work') {
  await page.goto(`${fixture.url}/projects`);
  await page.evaluate(([action, path, returnTo]) => {
    window.__staleDocument = true;
    const csrf = document.querySelector('input[name="csrf"]')?.value ?? '';
    const form = document.createElement('form'); form.method = 'post'; form.action = action;
    for (const [name, value] of [['csrf', csrf], ['path', path], ['return', returnTo]]) { const input = document.createElement('input'); input.name = name; input.value = value; form.appendChild(input); }
    document.body.appendChild(form); form.submit();
  }, [action, path, returnTo]);
  // A NEW document, not the already-loaded opener: waitForLoadState alone
  // returns at once and the next goto would abort the switch.
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  if (new URL(page.url()).pathname !== returnTo) throw new Error(`project switch landed on ${page.url()} — ${await page.evaluate(() => document.querySelector('.problem')?.textContent ?? 'no problem text')}`);
}
const openProject = (page, path) => switchProject(page, '/projects/open', path);
const allProjects = page => switchProject(page, '/projects/select', '');
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
const hrefs = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(`${sel} a`)].map(a => a.getAttribute('href')), selector);
const visible = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }, selector);
const statusOf = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const line = el.matches('.status-line') ? el : el.querySelector('.status-line'); return { token: (line ?? el).getAttribute('data-work-status'), label: line?.querySelector('.status-label')?.textContent ?? el.querySelector('.dispatch-copy > strong, h2')?.textContent ?? null }; }, selector);
async function payload(page, path, label) {
  const response = await page.goto(`${fixture.url}${path}`);
  const html = await response.text();
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].reduce((sum, m) => sum + Buffer.byteLength(m[1]), 0);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].reduce((sum, m) => sum + Buffer.byteLength(m[1]), 0);
  report.payloads[label] = { path, htmlBytes: Buffer.byteLength(html), inlineCssBytes: style, inlineJsBytes: script };
  return html;
}
const countsOf = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.work-views a')].map(a => [a.childNodes[0].textContent.trim(), Number(a.querySelector('.count')?.textContent)])));
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll('.work-row')].map(row => ({ id: row.getAttribute('data-task'), token: row.getAttribute('data-work-status'), views: row.getAttribute('data-work-views').split(' '), label: row.querySelector('.status-label')?.textContent ?? null })));

try {
  // ---- c1: the shell, per breakpoint --------------------------------------
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    const { ctx, page } = await context(viewport);
    // A fresh session with three served projects has none open: the run
    // deep link must open anyway, re-proved by the run's own visibility.
    const deep = await page.goto(`${fixture.url}/r/${R.failedChecks}`);
    check(`c1 ${name}: /r/${R.failedChecks} from All projects opens the run page (no redirect to /projects)`, deep.status() === 200 && new URL(page.url()).pathname === `/r/${R.failedChecks}`, `status=${deep.status()} url=${page.url()}`);
    if (name === 'desktop') await shot(page, 'desktop-run-deep-link-all-projects', `Build #${R.failedChecks} opened directly from All projects at 1440×900 (fixture)`);
    await openProject(page, fixture.repos.main);
    await page.goto(`${fixture.url}/work`);
    const side = await hrefs(page, 'aside.side > nav:first-of-type');
    const tabs = await hrefs(page, 'nav.tabbar');
    check(`c1 ${name}: primary rail is chat · work · projects`, JSON.stringify(side) === JSON.stringify(['/chat', '/work', '/projects']), JSON.stringify(side));
    check(`c1 ${name}: phone tab bar is chat · work · projects`, JSON.stringify(tabs) === JSON.stringify(['/chat', '/work', '/projects']), JSON.stringify(tabs));
    const sideShown = await visible(page, 'aside.side');
    const tabsShown = await visible(page, 'nav.tabbar');
    const moreShown = await visible(page, '.mobile-top .mobile-more');
    check(`c1 ${name}: ${name === 'desktop' ? 'sidebar shown, tab bar hidden' : 'tab bar shown, sidebar hidden, tools/settings behind the header action'}`, name === 'desktop' ? sideShown && !tabsShown : !sideShown && tabsShown && moreShown, JSON.stringify({ sideShown, tabsShown, moreShown }));
    if (name === 'desktop') {
      // The rail retracts and comes back, by its own control.
      await page.click('.side-toggle');
      const collapsed = await page.evaluate(() => document.querySelector('.app')?.classList.contains('sidebar-collapsed'));
      await page.click('.side-toggle');
      const restored = await page.evaluate(() => !document.querySelector('.app')?.classList.contains('sidebar-collapsed'));
      check('c1 desktop: the sidebar retracts and restores from its toggle', collapsed && restored, `collapsed=${collapsed} restored=${restored}`);
      // Exactly one project selector in the desktop chrome.
      const selectors = await page.evaluate(() => document.querySelectorAll('details.switcher').length);
      check('c1 desktop: one project selector in the chrome', (await page.evaluate(() => [...document.querySelectorAll('details.switcher')].filter(d => d.getBoundingClientRect().width > 0).length)) === 1, `switchers rendered=${selectors}`);
      const addProject = await page.goto(`${fixture.url}/projects`).then(() => rect(page, '.project-add-card, form[action="/projects/open"] button[type="submit"]'));
      check('c1 desktop: Add project stays prominent on /projects (inside the first viewport)', addProject !== null && addProject.top >= 0 && addProject.top < VIEWPORTS.desktop.height, JSON.stringify(addProject));
      await page.goto(`${fixture.url}/work`);
    }
    // Secondary tools stay reachable under Work tools; settings under Settings.
    await page.goto(`${fixture.url}/work`);
    await page.click('.work-tools > summary');
    await page.waitForTimeout(150);
    const tools = await hrefs(page, '.work-tools-menu');
    check(`c1 ${name}: Work tools menu carries inbox, board, order, task list, recipes, routines, portfolio, ledger`, JSON.stringify(tools) === JSON.stringify(['/', '/board', '/board?view=order', '/tasks', '/recipes', '/routines', '/workbench', '/ledger']), JSON.stringify(tools));
    await shot(page, `${name}-work-tools-open`, `Work with the tools menu open at ${viewport.width}×${viewport.height} (fixture)`);
    for (const path of ['/', '/tasks', '/board', '/board?view=order', '/runs', '/done', '/review', '/activity', '/recipes', '/routines', '/workbench', '/ledger', '/fleet', '/caps', '/people', '/system', '/menu', `/t/${T.failedChecks}`, `/chat?task=${T.failedChecks}`, `/review?result=${T.failedChecks}`, `/r/${R.failedChecks}`]) {
      const response = await page.goto(`${fixture.url}${path}`);
      const active = await page.evaluate(() => document.querySelector('aside.side > nav:first-of-type a.active')?.getAttribute('href') ?? null);
      const expected = path.startsWith('/chat') ? '/chat' : ['/fleet', '/caps', '/people', '/system', '/menu'].includes(path) ? null : '/work';
      check(`c1 ${name}: ${path} answers 200 and lights ${expected ?? 'no primary (settings/menu)'}`, response.status() === 200 && active === expected, `status=${response.status()} active=${active}`);
    }
    if (name === 'phone') {
      await page.goto(`${fixture.url}/menu`);
      await shot(page, 'phone-menu', 'Tools and settings behind the phone header action at 390×844 (fixture)');
      check('c1 phone: /menu lists work tools then settings', (await page.evaluate(() => [...document.querySelectorAll('.menu-group-label')].map(h => h.textContent))).join('|') === 'work tools|settings');
    }
    await ctx.close();
  }

  // ---- c2: Work views, counts, empty states ------------------------------
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    const { ctx, page } = await context(viewport);
    await openProject(page, fixture.repos.main);
    await payload(page, '/work', `work-${name}`);
    const counts = await countsOf(page);
    const rows = await rowsOf(page);
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    report.statuses[`work-${name}`] = byId;
    const expect = {
      [T.waitingForBuilder]: ['no-worker-online', 'all needs-you'], [T.chained]: ['waiting-dependency', 'all'], [T.held]: ['held', 'all needs-you'], [T.paused]: ['stopped', 'all needs-you'],
      [T.failed]: ['failed', 'all needs-you'], [T.cancelled]: ['cancelled', 'all'], [T.running]: ['running', 'all running'],
      [T.failedChecks]: ['checks-failed', 'all needs-you completed'], [T.mismatched]: ['evidence-mismatch', 'all needs-you completed'], [T.missingProof]: ['verification-needed', 'all needs-you completed'],
      [T.attested]: ['agent-attested', 'all completed'], [T.accepted]: ['accepted-exception', 'all completed'],
    };
    const mismatches = Object.entries(expect).filter(([id, [token, views]]) => byId[id]?.token !== token || byId[id]?.views.join(' ') !== views).map(([id, want]) => `${id}: want ${want.join('/')} got ${byId[id]?.token}/${byId[id]?.views.join(' ')}`);
    check(`c2 ${name}: every seeded state wears its token and view membership (queued, waiting, held, paused, failed, cancelled, running, failed checks, mismatched, missing, agent-attested, accepted exception)`, mismatches.length === 0, mismatches.join('; ') || `${rows.length} rows`);
    const tally = { All: rows.length, 'Needs you': rows.filter(r => r.views.includes('needs-you')).length, Running: rows.filter(r => r.views.includes('running')).length, Completed: rows.filter(r => r.views.includes('completed')).length };
    check(`c2 ${name}: the view counts are the rows' own memberships`, JSON.stringify(counts) === JSON.stringify(tally), `${JSON.stringify(counts)} vs rows ${JSON.stringify(tally)}`);
    check(`c2 ${name}: no row wears a bare done badge or says shipped/deployed`, !(await page.evaluate(() => { const list = document.querySelector('.work-list'); return list !== null && (/badge-done">done/.test(list.innerHTML) || /\bshipped\b/i.test(list.textContent) || /\bDeployed\b/.test(list.textContent)); })));
    await shot(page, `${name}-work-all`, `Work · All with ${rows.length} synthetic rows at ${viewport.width}×${viewport.height} (fixture)`);
    for (const view of ['needs-you', 'running', 'completed']) {
      await page.goto(`${fixture.url}/work?view=${view}`);
      const listed = await rowsOf(page);
      check(`c2 ${name}: /work?view=${view} lists exactly its members and marks the tab active`, listed.every(r => r.views.includes(view)) && listed.length === tally[view === 'needs-you' ? 'Needs you' : view === 'running' ? 'Running' : 'Completed'] && (await page.evaluate(v => document.querySelector(`.work-views a[href="/work?view=${v}"]`)?.classList.contains('active'), view)), `${listed.length} rows`);
      if (view === 'needs-you') await shot(page, `${name}-work-needs-you`, `Work · Needs you at ${viewport.width}×${viewport.height} (fixture)`);
      if (view === 'completed') await shot(page, `${name}-work-completed`, `Work · Completed — problems and exceptions stay visible at ${viewport.width}×${viewport.height} (fixture)`);
    }
    // The empty project: All and every shortcut view say what they mean.
    await openProject(page, fixture.repos.empty);
    await page.goto(`${fixture.url}/work`);
    const emptyAll = await page.evaluate(() => document.querySelector('[data-work-empty="all"] p')?.textContent ?? null);
    check(`c2 ${name}: an empty project's Work says so and offers a way in`, emptyAll !== null && /Nothing is in progress/.test(emptyAll) && (await page.$('.work-empty a.button-link')) !== null, emptyAll);
    await shot(page, `${name}-work-empty`, `Work · All on an empty project at ${viewport.width}×${viewport.height} (fixture)`);
    for (const view of ['needs-you', 'running', 'completed']) {
      await page.goto(`${fixture.url}/work?view=${view}`);
      check(`c2 ${name}: empty ${view} view has its own honest copy`, (await page.$(`[data-work-empty="${view}"]`)) !== null && (await page.$('a[href="/work"]')) !== null);
    }
    if (name === 'phone') { await page.goto(`${fixture.url}/work?view=needs-you`); await shot(page, 'phone-work-empty-needs-you', 'Work · Needs you on an empty project at 390×844 (fixture)'); }
    // All projects: rows span projects and wear their labels; visibility unchanged.
    await allProjects(page);
    await page.goto(`${fixture.url}/work`);
    const labels = await page.evaluate(() => [...new Set([...document.querySelectorAll('.work-row .project-label')].map(l => l.textContent))]);
    const rollup = await rowsOf(page);
    check(`c2 ${name}: All projects rolls up both projects with labels on every row`, labels.includes('portfolio-console') && labels.includes('ops-console-with-a-very-long-repository-name-for-overflow-checks') && rollup.some(r => r.id === T.published) && rollup.some(r => r.id === T.failedChecks), JSON.stringify(labels));
    if (name === 'desktop') await shot(page, 'desktop-work-all-projects', 'Work · All projects with project labels at 1440×900 (fixture)');
    await ctx.close();
  }

  // ---- c3: same-run status across four surfaces --------------------------
  {
    const { ctx, page } = await context(VIEWPORTS.desktop);
    await openProject(page, fixture.repos.main);
    const cases = {
      [T.failedChecks]: ['checks-failed', 'Changes saved, but checks failed'],
      [T.mismatched]: ['evidence-mismatch', 'Result saved, but its evidence does not match'],
      [T.missingProof]: ['verification-needed', 'Result saved — verification needed'],
      [T.attested]: ['agent-attested', 'Result saved — checks reported by the agent'],
      [T.accepted]: ['accepted-exception', 'Accepted with an exception'],
      done: ['ready-to-review', 'Ready to review'],
    };
    await page.goto(`${fixture.url}/work`);
    const work = Object.fromEntries((await rowsOf(page)).map(r => [r.id, r]));
    for (const [key, [token, label]] of Object.entries(cases)) {
      const id = key === 'done' ? fixture.tasks.done : key;
      const seen = { work: { token: work[id]?.token, label: work[id]?.label } };
      await page.goto(`${fixture.url}/t/${id}`);
      seen.task = await statusOf(page, '#run-status');
      seen.taskTitle = await statusOf(page, '.task-main-title .status-line');
      seen.receipt = await statusOf(page, '.completion-receipt .status-line');
      await page.goto(`${fixture.url}/chat?task=${id}`);
      seen.chat = await statusOf(page, '.task-journey');
      await page.goto(`${fixture.url}/review?result=${id}`);
      seen.review = await statusOf(page, '.cockpit-head .status-line');
      report.statuses[id] = seen;
      const agree = Object.values(seen).every(one => one !== null && one.token === token && one.label === label);
      check(`c3 ${id}: Work, task status, task title, receipt, chat, and review all say "${label}" (${token})`, agree, JSON.stringify(seen));
      const words = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
      check(`c3 ${id}: nothing calls it shipped or deployed`, !/What shipped|\bshipped\b/i.test(words) && !/\bDeployed\b/.test(words));
      if (key !== 'done') check(`c3 ${id}: a weak result is never "Ready to review"`, !/Ready to review/.test(words) && token !== 'ready-to-review');
    }
    // The failed-check result: the task page names the exit code; the
    // mismatch never claims a check failed; the accepted exception never
    // becomes "Checks passed"; the published result names the PR only.
    await page.goto(`${fixture.url}/t/${T.failedChecks}`);
    check('c3 failed check names the exit code and keeps the failed-check action', (await page.evaluate(() => document.querySelector('#run-status')?.textContent ?? '')).includes('The project check failed (exit 1).') && (await page.$('a.button-link[href^="/review?result="]')) !== null);
    await shot(page, 'desktop-task-failed-checks', `Task page for a saved result whose project check failed, at 1440×900 (fixture)`);
    await page.goto(`${fixture.url}/chat?task=${T.failedChecks}`);
    await scrollTo(page, '.task-journey');
    await shot(page, 'desktop-chat-failed-checks', 'The same run in task chat: the journey headline and receipt agree (fixture)');
    await page.goto(`${fixture.url}/review?result=${T.failedChecks}`);
    await shot(page, 'desktop-review-failed-checks', 'The same run in the review cockpit: the same status line leads (fixture)');
    await page.goto(`${fixture.url}/t/${T.mismatched}`);
    check('c3 mismatched evidence never says checks failed', !/checks failed/i.test(await page.evaluate(() => document.querySelector('#run-status')?.textContent ?? '')));
    await page.goto(`${fixture.url}/t/${T.accepted}`);
    const acceptedWords = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
    check('c3 accepted exception is never "Checks passed" and keeps the original missing-evidence fact', /Accepted with an exception/.test(acceptedWords) && !/Checks passed/.test(acceptedWords) && /not passed by the machine/.test(acceptedWords));
    await allProjects(page);
    await page.goto(`${fixture.url}/t/${T.published}`);
    const publishedWords = await page.evaluate(() => document.querySelector('.completion-receipt')?.textContent ?? '');
    check('c3 an opened PR reads "PR opened" — not merged, not deployed', /PR opened/.test(publishedWords) && /Merging stays a person/.test(publishedWords) && !/Merge observed|Deployed/.test(publishedWords));
    await page.goto(`${fixture.url}/t/${T.merged}`);
    const mergedWords = await page.evaluate(() => document.querySelector('.completion-receipt')?.textContent ?? '');
    check('c3 an observed merge reads "Merge observed" with deployment unconfirmed', /Merge observed/.test(mergedWords) && /Deployment is not confirmed/.test(mergedWords));
    await page.goto(`${fixture.url}/t/${fixture.tasks.done}`);
    check('c3 a verified local result reads "Changes saved" and "Ready to review", never shipped', /Changes saved/.test(await page.evaluate(() => document.querySelector('.completion-receipt h2')?.textContent ?? '')) && /Saved on the build branch/.test(await page.evaluate(() => document.querySelector('.receipt-publication')?.textContent ?? '')));
    await ctx.close();
  }

  // ---- c5: exact viewports, overflow, the phone task list --------------
  {
    const { ctx, page } = await context(VIEWPORTS.phone);
    await openProject(page, fixture.repos.main);
    await page.goto(`${fixture.url}/t/${T.failedChecks}`);
    await shot(page, 'phone-task-failed-checks', 'Task page for the failed-check result at 390×844 (fixture)');
    check('c5 phone: task page with a failed check has no horizontal overflow', (await noOverflow(page)).ok, JSON.stringify(await noOverflow(page)));
    await page.goto(`${fixture.url}/work`);
    const tabsRect = await rect(page, '.work-views');
    const firstRow = await rect(page, '.work-row');
    check('c5 phone: Work view tabs and the first row sit inside the first 390×844 viewport', tabsRect !== null && tabsRect.bottom <= 844 && firstRow !== null && firstRow.top < 844 && firstRow.right <= 390, JSON.stringify({ tabsRect, firstRow }));
    const tabHeights = await page.evaluate(() => [...document.querySelectorAll('.work-views a, .tabbar a, .mobile-top .mobile-new, .mobile-top .mobile-more, .mobile-top .project-pill > summary')].map(el => el.getBoundingClientRect().height));
    check('c5 phone: view tabs, header controls, and tab-bar targets are at least 40px tall', tabHeights.length > 0 && tabHeights.every(h => h >= 40), JSON.stringify(tabHeights.map(Math.round)));
    // The second project's long path: the task-list intro wraps, the page never widens.
    await openProject(page, fixture.repos.second);
    await page.goto(`${fixture.url}/tasks`);
    const flow = await noOverflow(page);
    check('c5 phone: the task list with a long repository path has no horizontal overflow (was 522px wide before)', flow.ok, JSON.stringify(flow));
    check('c5 phone: the task-list intro leads with the project label and wraps the raw path', (await page.evaluate(() => document.querySelector('main p.meta > strong')?.textContent ?? null)) === 'ops-console-with-a-very-long-repository-name-for-overflow-checks' && (await page.evaluate(() => getComputedStyle(document.querySelector('.path-words')).overflowWrap)) === 'anywhere');
    await shot(page, 'phone-tasks-long-path', 'The task list on the long-path project at 390×844: the label leads, the path wraps (fixture)');
    await ctx.close();
  }
  for (const [name, viewport] of [['narrow', VIEWPORTS.narrow], ['phone', VIEWPORTS.phone], ['desktop', VIEWPORTS.desktop]]) {
    const { ctx, page } = await context(viewport);
    await openProject(page, fixture.repos.second);
    for (const path of ['/work', '/work?view=needs-you', '/tasks', `/t/${T.published}`, `/r/${R.published}`, '/chat', '/menu', '/projects']) {
      await page.goto(`${fixture.url}${path}`);
      const flow = await noOverflow(page);
      check(`c5 no document horizontal overflow at ${viewport.width}px on ${path}`, flow.ok, JSON.stringify(flow));
    }
    if (name === 'narrow') {
      await page.goto(`${fixture.url}/work`);
      await shot(page, 'narrow-work-320', 'Work · All at 320×740 (fixture)');
      await page.goto(`${fixture.url}/tasks`);
      await shot(page, 'narrow-tasks-320', 'The long-path task list at 320×740 (fixture)');
      const header = await page.evaluate(() => [...document.querySelectorAll('.mobile-top > *')].map(el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; }));
      check('c5 320px: every header control fits inside the viewport', header.every(one => one.left >= 0 && one.right <= 320), JSON.stringify(header));
    }
    await ctx.close();
  }

  // ---- c4/c5: a NEW empty conversation per desktop viewport ------------
  for (const [name, viewport] of Object.entries({ '1440x900': VIEWPORTS.desktop, '1280x800': VIEWPORTS.laptop })) {
    const fresh = await context(viewport);
    const p = fresh.page;
    await openProject(p, fixture.repos.main);
    await p.goto(`${fixture.url}/chat`);
    if (await p.$('form[action="/chat/mate/end"]')) {
      await p.evaluate(() => { const details = document.querySelector('.chat-session-details'); if (details) details.open = true; });
      await submit(p, 'form[action="/chat/mate/end"] button[type="submit"]');
    }
    check(`c5 ${name} starts from no conversation`, (await p.$('form[action="/chat/mate/mint"]')) !== null && (await p.$('.composer')) === null);
    await p.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
    await submit(p, 'form[action="/chat/mate/mint"] button[type="submit"]');
    const state = await p.evaluate(() => ({ messages: document.querySelectorAll('.msg').length, empty: document.querySelector('.chat-empty') !== null, scrollY: window.scrollY }));
    check(`c5 ${name} conversation is new and empty`, state.messages === 0 && state.empty && state.scrollY === 0, JSON.stringify(state));
    await shot(p, `chat-fresh-${name}`, `A NEW empty conversation at ${viewport.width}×${viewport.height}: composer and send inside the first viewport, chat · work · projects in the rail (fixture)`);
    const box = await rect(p, '.composer textarea');
    const sendButton = await rect(p, '.composer button[type="submit"]');
    const fits = one => one !== null && one.top >= 0 && one.bottom <= viewport.height && one.left >= 0 && one.right <= viewport.width;
    check(`c5 ${name} the ENTIRE textarea and send button are inside the first viewport`, fits(box) && fits(sendButton), JSON.stringify({ box, sendButton }));
    check(`c5 ${name} no horizontal overflow`, (await noOverflow(p)).ok);
    check(`c1 ${name} the rail on the fresh chat is chat · work · projects with chat active`, JSON.stringify(await hrefs(p, 'aside.side > nav:first-of-type')) === JSON.stringify(['/chat', '/work', '/projects']) && (await p.evaluate(() => document.querySelector('aside.side > nav:first-of-type a.active')?.getAttribute('href'))) === '/chat');
    await fresh.ctx.close();
  }
} finally {
  await browser.close();
  await fixture.stop();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed · ${report.screenshots.length} screenshots · payloads: ${Object.entries(report.payloads).map(([k, v]) => `${k}=${v.htmlBytes}B`).join(' ')}`);
if (strict && failed.length > 0) process.exit(1);
