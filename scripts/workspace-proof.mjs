/** Workspace package 1 browser proof (2026-09-13): the Chat / Work /
 * Projects shell and the truthful status projection, exercised against the
 * isolated fixture (`scripts/ui-polish-fixture.mjs` with `secondProject`,
 * so three synthetic projects share one ceiling) in headless Chromium.
 * Captures exact-viewport screenshots and records the measurable facts the
 * result assessment cites: primary destinations per breakpoint, Work view
 * counts and empty states, same-run status agreement across four surfaces,
 * the All-projects run deep link, document overflow at 320/390/1440, the
 * task-list path wrap, and a NEW empty conversation per desktop viewport.
 * Review fixes (2026-09-13): the Add project control is proved visible by
 * its own positive size, computed visibility, and full viewport bounds;
 * every Work filter's bounds are asserted at 320 and 390 px; a queued,
 * running, and failed review reads the same on all six result surfaces;
 * and no surface makes a negative claim about checks or merges it cannot
 * see.
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
/** One element's real visibility (review fixes): its rect, computed
 * visibility/display, and whether the WHOLE box sits inside the viewport
 * — a zero-sized rectangle at 0,0 never reads as visible again. */
const boxOf = (page, selector, viewport) => page.evaluate(([sel, vw, vh]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const box = { selector: sel, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, display: style.display, visibility: style.visibility, opacity: style.opacity, text: (el.textContent ?? '').trim().slice(0, 40) };
  box.positiveSize = r.width > 0 && r.height > 0;
  box.computedVisible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && el.checkVisibility?.({ visibilityProperty: true }) !== false;
  box.insideViewport = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
  box.ok = box.positiveSize && box.computedVisible && box.insideViewport;
  return box;
}, [selector, viewport.width, viewport.height]);
/** Every Work filter's own bounds (review fixes): inside the viewport and
 * its strip, a usable target, legible type, no clipped words. */
const filterBoxes = (page, viewport) => page.evaluate(([vw]) => {
  const strip = document.querySelector('.work-views');
  const stripRect = strip?.getBoundingClientRect() ?? null;
  return [...document.querySelectorAll('.work-views a')].map(a => {
    const r = a.getBoundingClientRect();
    const style = getComputedStyle(a);
    const label = a.childNodes[0]?.textContent?.trim() ?? '';
    return {
      label, count: a.querySelector('.count')?.textContent ?? null,
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height),
      fontPx: parseFloat(style.fontSize), clipped: a.scrollWidth > a.clientWidth + 1,
      insideViewport: r.left >= 0 && r.right <= vw,
      insideStrip: stripRect !== null && r.left >= stripRect.left - 0.5 && r.right <= stripRect.right + 0.5,
      stripScrolls: strip !== null && strip.scrollWidth > strip.clientWidth + 1,
    };
  });
}, [viewport.width]);
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
      // The Add project card AND its first real control, each proved by its
      // own positive size, computed visibility, and full viewport bounds —
      // scoped to the card, so the chrome's hidden switcher forms (zero
      // rectangles at 0,0) can never stand in for the CTA (review fixes).
      await page.goto(`${fixture.url}/projects`);
      const addSelector = '.project-add-card .project-add-action, .project-add-card details.project-add-more > summary, .project-add-card form[action="/projects/open"] button[type="submit"]';
      const addCardUnscrolled = await boxOf(page, '.project-add-card', VIEWPORTS.desktop);
      // The honest first-viewport fact, recorded — never asserted from a
      // zero rectangle: with three enrolled projects the card follows them.
      report.addProjectFirstViewport = addCardUnscrolled === null ? null : { top: Math.round(addCardUnscrolled.top), insideFirstViewport: addCardUnscrolled.insideViewport };
      check('c1 desktop: the Add project card exists with positive size and computed visibility', addCardUnscrolled !== null && addCardUnscrolled.positiveSize && addCardUnscrolled.computedVisible && addCardUnscrolled.height >= 80, JSON.stringify(addCardUnscrolled));
      await scrollTo(page, '.project-add-card', 24);
      const addCard = await boxOf(page, '.project-add-card', VIEWPORTS.desktop);
      const addControl = await boxOf(page, addSelector, VIEWPORTS.desktop);
      check('c1 desktop: scrolled to, the Add project card sits wholly inside the 1440×900 viewport', addCard !== null && addCard.ok, JSON.stringify(addCard));
      check('c1 desktop: the Add project control itself has positive size, is computed visible, sits wholly inside the viewport, and is a usable target', addControl !== null && addControl.ok && addControl.height >= 32 && addControl.width >= 120, JSON.stringify(addControl));
      const bogus = await boxOf(page, 'aside.side form[action="/projects/open"] button[type="submit"]', VIEWPORTS.desktop);
      check('c1 desktop: the visibility probe rejects a hidden zero-size control (the rail switcher form) — negative control', bogus === null || !bogus.ok, JSON.stringify(bogus));
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
      [T.pendingReview]: ['review-pending', 'all needs-you completed'], [T.reviewing]: ['reviewing', 'all running completed'], [T.reviewFailed]: ['review-failed', 'all needs-you completed'],
    };
    const mismatches = Object.entries(expect).filter(([id, [token, views]]) => byId[id]?.token !== token || byId[id]?.views.join(' ') !== views).map(([id, want]) => `${id}: want ${want.join('/')} got ${byId[id]?.token}/${byId[id]?.views.join(' ')}`);
    check(`c2 ${name}: every seeded state wears its token and view membership (queued, waiting, held, paused, failed, cancelled, running, failed checks, mismatched, missing, agent-attested, accepted exception, review queued/running/failed)`, mismatches.length === 0, mismatches.join('; ') || `${rows.length} rows`);
    check(`c2 ${name}: no row makes a negative claim it cannot see (nothing merged, manual-only merge, checks not passed)`, !(await page.evaluate(() => /nothing (is|was) merged|not published, merged, or deployed|stays a person|person's act|not passed by the machine|no check is recorded as failed/i.test(document.querySelector('.work-list')?.textContent ?? ''))));
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
      [T.pendingReview]: ['review-pending', 'Waiting for review'],
      [T.reviewing]: ['reviewing', 'Reviewing'],
      [T.reviewFailed]: ['review-failed', 'Review failed — retry available'],
      done: ['ready-to-review', 'Ready to review'],
    };
    const REVIEW_TOKENS = new Set(['review-pending', 'reviewing', 'review-failed', 'review-exhausted']);
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
      // The run page (Details): the same status line beside the evidence.
      const runId = R[key] ?? (key === 'done' ? fixture.runId : null);
      if (runId !== null) { await page.goto(`${fixture.url}/r/${runId}`); seen.run = await statusOf(page, '[data-proof-verdict] .status-line'); }
      report.statuses[id] = seen;
      const agree = Object.values(seen).every(one => one !== null && one.token === token && one.label === label);
      check(`c3 ${id}: Work, task status, task title, receipt, chat, review, and the run page all say "${label}" (${token})`, agree, JSON.stringify(seen));
      const words = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
      check(`c3 ${id}: nothing calls it shipped or deployed`, !/What shipped|\bshipped\b/i.test(words) && !/\bDeployed\b/.test(words));
      if (REVIEW_TOKENS.has(token)) {
        // A review in flight is primary; the earlier verdict is history in
        // the receipt's own words — on the task page and in chat alike.
        await page.goto(`${fixture.url}/t/${id}`);
        const receiptReview = await page.evaluate(() => document.querySelector('.completion-receipt .receipt-review')?.textContent ?? null);
        const lead = await page.evaluate(() => document.querySelector('#run-status [data-review-lead]')?.textContent ?? null);
        const boxClass = await page.evaluate(() => document.querySelector('#run-status')?.className ?? null);
        await page.goto(`${fixture.url}/chat?task=${id}`);
        const chatReview = await page.evaluate(() => document.querySelector('.completion-receipt .receipt-review')?.textContent ?? null);
        const history = 'Until the review settles, the earlier verdict — "Ready to review" — stays on record as history.';
        check(`c3 ${id}: the receipt (task and chat) and the status box carry the review as primary and the earlier verdict as history`, receiptReview !== null && receiptReview.includes(history) && chatReview === receiptReview && lead !== null && lead.includes(history) && boxClass === 'answered dispatch-status', JSON.stringify({ receiptReview, chatReview, lead, boxClass }));
        check(`c3 ${id}: the primary status is never "Ready to review" while the review is open`, token !== 'ready-to-review' && Object.values(seen).every(one => one?.label !== 'Ready to review'));
      } else if (key !== 'done') {
        check(`c3 ${id}: a weak result is never "Ready to review"`, !/Ready to review/.test(words) && token !== 'ready-to-review');
      }
    }
    // The review-in-flight surfaces, captured: task page, then chat.
    await page.goto(`${fixture.url}/t/${T.reviewFailed}`);
    await shot(page, 'desktop-task-review-failed', 'Task page for a verified result whose independent review failed with a retry left: the review leads, the earlier verdict is history (fixture)');
    await page.goto(`${fixture.url}/chat?task=${T.reviewing}`);
    await scrollTo(page, '.task-journey');
    await shot(page, 'desktop-chat-reviewing', 'The same projection in task chat while a live reviewer works: journey headline and receipt agree (fixture)');
    // An older result is never masked by a newer run's review: the run
    // page of the plain verified result keeps its own words while three
    // other results are under review.
    await page.goto(`${fixture.url}/r/${fixture.runId}`);
    const olderRun = await statusOf(page, '[data-proof-verdict] .status-line');
    check('c3 an older selected result keeps its own verdict (no review masks it)', olderRun !== null && olderRun.token === 'ready-to-review', JSON.stringify(olderRun));
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
    check('c3 accepted exception is never "Checks passed", never claims the checks failed on its own, and keeps the machine verdict on record', /Accepted with an exception/.test(acceptedWords) && !/Checks passed/.test(acceptedWords) && !/not passed by the machine/.test(acceptedWords) && /leaves the machine's verdict above unchanged/.test(acceptedWords));
    await allProjects(page);
    await page.goto(`${fixture.url}/t/${T.published}`);
    const publishedWords = await page.evaluate(() => document.querySelector('.completion-receipt')?.textContent ?? '');
    check('c3 an opened PR reads "PR opened" as last observed — no merge or deployment recorded, no manual-only merge claim', /PR opened/.test(publishedWords) && /was last seen open on GitHub\. No merge or deployment is recorded here\./.test(publishedWords) && !/Merge observed|Deployed|Merging stays a person|nothing is merged/.test(publishedWords));
    for (const [where, path] of [['review', `/review?result=${T.published}`], ['chat', `/chat?task=${T.published}`], ['run', `/r/${R.published}`]]) {
      await page.goto(`${fixture.url}${path}`);
      const text = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
      check(`c3 the ${where} surface of the published result claims only recorded or last-observed publication facts`, !/nothing (is|was) merged|not published, merged, or deployed|stays a person|person's act/i.test(text), where);
    }
    await page.goto(`${fixture.url}/t/${T.merged}`);
    const mergedWords = await page.evaluate(() => document.querySelector('.completion-receipt')?.textContent ?? '');
    check('c3 an observed merge reads "Merge observed" with deployment unconfirmed', /Merge observed/.test(mergedWords) && /Deployment is not confirmed/.test(mergedWords));
    await page.goto(`${fixture.url}/t/${fixture.tasks.done}`);
    check('c3 a verified local result reads "Changes saved" and "Ready to review", never shipped, and never denies a publication it cannot see', /Changes saved/.test(await page.evaluate(() => document.querySelector('.completion-receipt h2')?.textContent ?? '')) && (await page.evaluate(() => document.querySelector('.receipt-publication')?.textContent ?? '')) === 'Saved on the build branch. No publication, merge, or deployment is recorded here.');
    await page.goto(`${fixture.url}/t/${T.mismatched}`);
    const mismatchWords = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
    check('c3 a mismatched result never claims that no check failed', !/no check is recorded as failed/i.test(mismatchWords));
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
    const filters390 = await filterBoxes(page, VIEWPORTS.phone);
    report.filters390 = filters390;
    check('c5 390px: all four Work filters (All, Needs you, Running, Completed) sit inside the viewport and their strip, unclipped, at least 40px tall and 12px type, with no scrolling strip', filters390.map(f => f.label).join('|') === 'All|Needs you|Running|Completed' && filters390.every(f => f.insideViewport && f.insideStrip && !f.clipped && !f.stripScrolls && f.height >= 40 && f.fontPx >= 12 && f.width >= 44), JSON.stringify(filters390));
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
      await openProject(page, fixture.repos.main);
      await page.goto(`${fixture.url}/work`);
      await shot(page, 'narrow-work-320', 'Work · All at 320×740 with all four filters wholly visible in two rows of two (fixture)');
      const filters320 = await filterBoxes(page, VIEWPORTS.narrow);
      report.filters320 = filters320;
      check('c5 320px: all four Work filters sit inside the viewport and their strip, unclipped, at least 40px tall and 12px type, with no scrolling strip', filters320.map(f => f.label).join('|') === 'All|Needs you|Running|Completed' && filters320.every(f => f.insideViewport && f.insideStrip && !f.clipped && !f.stripScrolls && f.height >= 40 && f.fontPx >= 12 && f.width >= 44), JSON.stringify(filters320));
      const completed320 = filters320.find(f => f.label === 'Completed');
      check('c5 320px: the Completed filter is wholly visible with its count', completed320 !== undefined && completed320.right <= 320 && completed320.count !== null && /^\d+\+?$/.test(completed320.count), JSON.stringify(completed320));
      const rowPad = await page.evaluate(() => { const row = document.querySelector('.work-row'); return row ? parseFloat(getComputedStyle(row).paddingTop) : null; });
      check('c5 320px: rows keep compact phone spacing (≤ 12px vertical padding)', rowPad !== null && rowPad <= 12, `paddingTop=${rowPad}`);
      await openProject(page, fixture.repos.second);
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
