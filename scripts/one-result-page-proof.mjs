/** One result page browser proof (2026-10-02): a builder result has one page
 * titled with the task, /r/<id> redirects to it and its run record sits under
 * Details; every result state shows exactly one ink act that resolves it, never
 * navigation, and a result that can't be accepted says why in one line; phone
 * meta links are 44px, the page gutter is 16px, the decision is a full-width
 * dock that starts compact (More opens ink over outline), and the Tasks tab
 * strip shows that it scrolls. Accept reads "Accept and finish".
 *
 * Driven against the isolated synthetic fixture (`scripts/ui-polish-fixture.mjs`)
 * in headless Chromium. Its `range-filter` result claims a changed file its
 * saved diff doesn't have (report and saved changes disagree); two more
 * results are seeded here: `rounding-check` (the project has a check, none
 * ran on this result) and `csv-header` (everything met, checks passed).
 * Headless Chromium at 390×844 is NOT physical iPhone Safari, and every
 * screenshot is synthetic fixture data.
 *
 *   node scripts/one-result-page-proof.mjs [--out <dir>]
 *
 * Writes to a fresh temporary directory unless --out names one. Build first.
 * Exits 1 when a check fails. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { approve } from '../dist/scope.js';
import { legOf, routeDigestOf } from '../dist/phase-routing.js';
import { fileTaskProposal } from '../dist/proposal.js';
import { storeEvidence, budgetedStatJson } from '../dist/evidence.js';
import { parseProof, adjudicate } from '../dist/proof.js';
import { sealVerificationReceipt } from '../dist/verification-evidence.js';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const named = at === -1 ? null : args[at + 1];
if (at !== -1 && (named === undefined || named.startsWith('--'))) { console.error('--out needs a directory'); process.exit(2); }
const shown = named ?? mkdtempSync(join(tmpdir(), 'one-result-page-'));
const out = resolve(shown);
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  const npx = join(homedir(), '.npm', '_npx');
  const candidates = ['playwright', ...[process.env.PLAYWRIGHT_MODULE].filter(Boolean).map(one => pathToFileURL(one).href),
    ...(existsSync(npx) ? readdirSync(npx).map(dir => join(npx, dir, 'node_modules', 'playwright', 'index.mjs')).filter(one => existsSync(one)).map(one => pathToFileURL(one).href) : [])];
  for (const one of candidates) {
    const loaded = await import(one).catch(() => null);
    if (loaded?.chromium !== undefined && existsSync(loaded.chromium.executablePath())) return loaded;
  }
  throw new Error('Needs Playwright and its browser: npx playwright install chromium, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const report = { generatedAt: new Date().toISOString(), fixture: 'synthetic, in-memory (scripts/ui-polish-fixture.mjs + two seeded results)', checks: [], screenshots: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const fixture = await startFixture({ secondProject: true, assignmentPresentation: true });
const { store } = fixture;
const evidenceRoot = join(fixture.configDir, 'evidence');
const now = new Date();
const ago = hours => new Date(now.getTime() - hours * 3_600_000);
const BASE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function seedResult({ id, title, acceptance, patch, files, handoff, proof, ran }) {
  const repo = fixture.repos.second;
  const filed = fileTaskProposal(store, { id, title, repo, goal: `${title}.`, outOfScope: 'No settlement engine changes.', touches: files.map(one => one.path), acceptance, filedVia: 'console', planning: 'skip' }, ago(3));
  if (!filed.ok) throw new Error(`seed ${id}: ${filed.reason}`);
  const scope = store.getScope(id);
  approve(store, id, fixture.name, ago(2.9), scope.digest, fixture.password);
  const ref = store.refFor('built-in', id).id;
  const route = store.approvedRouteOf(id);
  const run = store.startRun({ taskRef: ref, leaseId: `proof-lease-${id}`, runner: 'night-shift-2', branch: `standing-orders/${id}`, worktree: join(repo, `.proof-${id}`), now: ago(2), provider: 'codex', model: 'default',
    ...(route === null ? {} : { route: { routeDigest: routeDigestOf(route), phase: 'build', provider: legOf(route, 'build').provider, model: legOf(route, 'build').model, chosen: legOf(route, 'build').chosen } }) });
  store.stampRun(run, { baseRevision: BASE, scopeDigest: scope.digest });
  const head = `${id.length.toString(16)}d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e`.slice(0, 40);
  const stat = { schema: 1, base: BASE, head, fileCount: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), binaryCount: 0, files, filesTruncated: false };
  storeEvidence(store, evidenceRoot, run, 'terminal-diff', 'terminal-diff.patch', Buffer.from(patch, 'utf8'), 'git diff (exit 0) [fixture: synthetic]', ago(1.5), { captureStatus: 'ok' });
  storeEvidence(store, evidenceRoot, run, 'diff-stat', 'diff-stat.json', budgetedStatJson(stat), 'git diff --numstat [fixture: synthetic]', ago(1.5));
  storeEvidence(store, evidenceRoot, run, 'handoff', 'handoff.json', Buffer.from(JSON.stringify({ schema: 1, outcome: 'built', committed: true, followUps: [], decisionsIncorporated: [], ...handoff }), 'utf8'), 'composed at completion [fixture: synthetic]', ago(1.4));
  storeEvidence(store, evidenceRoot, run, 'proof', 'proof.json', Buffer.from(JSON.stringify(proof), 'utf8'), 'agent-authored proof (validated) [fixture: synthetic]', ago(1.4));
  const verify = ran ? { configured: true, ran: true, exitCode: 0 } : { configured: false, ran: false, exitCode: null };
  if (ran) storeEvidence(store, evidenceRoot, run, 'check-log', 'check-log.txt', Buffer.from('$ npm test\n(exit 0)\n\n--- stdout ---\n48 tests passed.\n', 'utf8'), 'sh -c "npm test" (exit 0) [fixture: synthetic]', ago(1.4));
  const verdict = adjudicate({
    proofArtifactPresent: true, proofParse: parseProof(JSON.stringify(proof)), handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: 'ok',
    diffStat: { captured: true, truncated: false, paths: new Set(files.map(one => one.path)) }, verifyCommand: verify, screenshots: [], approvedCriteria: scope.acceptance,
  });
  store.recordOutcomeFacts(run, { headRevision: head });
  if (ran) sealVerificationReceipt(store, evidenceRoot, run, head, store.liveVerifyCommand(repo), verify, ago(1.3));
  store.saveProofVerdict(run, verdict.verdict, verdict.reasons, ago(1.3), verdict.matrix);
  store.finishRun(run, { outcome: 'built', committed: true, now: ago(1.3) });
  store.setTaskState(id, 'done', ago(1.3));
  return run;
}

const roundingPatch = 'diff --git a/src/payout.ts b/src/payout.ts\n--- a/src/payout.ts\n+++ b/src/payout.ts\n@@ -12,3 +12,3 @@ export function settle(lines: Line[]): number {\n-  return lines.reduce((sum, line) => sum + line.amount, 0);\n+  return Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;\n }\n';
const checkRun = seedResult({
  id: 'rounding-check', title: 'Round settlement totals at cent precision',
  acceptance: [{ id: 'c1', statement: 'Settlement totals are rounded to the cent.', how: null, evidence: ['check', 'changed-path'] }],
  patch: roundingPatch, files: [{ path: 'src/payout.ts', additions: 1, deletions: 1 }],
  handoff: { conclusion: 'settle() now rounds the total to the cent once, after summing.', changes: ['Rounded the settlement total in src/payout.ts.'], verification: ['Read the change.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: 'Settlement totals are rounded to the cent.', verdict: 'met', how: 'Rounded once after summing.', evidence: [{ kind: 'check', ref: 'npm test' }, { kind: 'changed-path', ref: 'src/payout.ts' }] }], checks: [], changed: ['src/payout.ts'], caveats: [], screenshots: [] },
  ran: false,
});
const csvRun = seedResult({
  id: 'csv-header', title: 'Add a header row to the CSV export',
  acceptance: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', how: null, evidence: ['check', 'changed-path'] }],
  patch: 'diff --git a/src/export/csv.ts b/src/export/csv.ts\n--- a/src/export/csv.ts\n+++ b/src/export/csv.ts\n@@ -3,4 +3,5 @@ export function toCsv(rows: Row[]): string {\n-  return rows.map(line).join("\\n");\n+  const header = COLUMNS.map(column => column.title).join(",");\n+  return [header, ...rows.map(line)].join("\\n");\n }\n',
  files: [{ path: 'src/export/csv.ts', additions: 2, deletions: 1 }],
  handoff: { conclusion: 'Every CSV export now starts with a header row naming each column, in the existing order.', changes: ['Added the header row in src/export/csv.ts.'], verification: ['npm test: 48 passed.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', verdict: 'met', how: 'Added a header and a test.', evidence: [{ kind: 'check', ref: 'npm test' }, { kind: 'changed-path', ref: 'src/export/csv.ts' }] }], checks: [{ command: 'npm test', exitCode: 0, summary: '48 tests passed' }], changed: ['src/export/csv.ts'], caveats: [], screenshots: [] },
  ran: true,
});
const mismatchRun = store.runsFor(store.lookupRef('range-filter').id).find(one => one.role === 'builder').id;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
async function signedIn(viewport, colorScheme) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return { ctx, page };
}
async function openResult(page, path) {
  await page.goto(`${fixture.url}${path}`);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts?.ready);
}
async function shot(page, name, caption, full = false) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  report.screenshots.push({ path: join(shown, `${name}.png`), caption });
}
/** The acts as the page shows them: the ink ones, every act in the row, and where they sit. */
const actsOf = page => page.evaluate(() => {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ink = [...document.querySelectorAll('[data-ink-act]')].filter(visible);
  const row = [...document.querySelectorAll('[data-result-acts] [data-act], [data-result-acts] .so-result-next button')].filter(visible);
  const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const dock = document.querySelector('[data-result-decision]');
  return {
    ink: ink.map(el => ({ act: el.getAttribute('data-ink-act'), tag: el.tagName, href: el.getAttribute('href'), text: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor })),
    row: row.map(el => ({ act: el.getAttribute('data-act'), text: el.textContent.trim(), ...box(el) })),
    primaries: [...document.querySelectorAll('[data-primary-action]')].filter(visible).length,
    // A mismatch's "Accepting needs a reason" is the label over the reason field when that field is here.
    line: document.querySelector('[data-decision-why]')?.textContent.trim() ?? document.querySelector('[data-accept-needs-reason]')?.textContent.trim() ?? null,
    cantAccept: document.querySelector('[data-cant-accept], [data-accept-needs-reason]') !== null,
    sentence: document.querySelector('[data-result-sentence]')?.textContent.trim() ?? null,
    statusButtons: document.querySelectorAll('[data-result-status] button, [data-result-status] .ui-button, [data-result-status] a[data-primary-action]').length,
    title: document.querySelector('h1')?.textContent.trim() ?? null,
    dock: dock === null ? null : { ...box(dock), position: getComputedStyle(dock).position },
    wide: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

const STATES = [
  { key: 'mismatch', task: 'range-filter', run: mismatchRun, ink: 'request-changes', line: "Accepting needs a reason", second: 'accept', secondText: 'Accept and finish', reason: true },
  { key: 'run-checks', task: 'rounding-check', run: checkRun, ink: 'run-checks', line: null, second: 'accept', secondText: 'Accept without checks' },
  { key: 'accept', task: 'csv-header', run: csvRun, ink: 'accept', line: null, second: 'request-changes' },
];

for (const state of STATES) {
  for (const [where, viewport] of [['desk', DESK], ['phone', PHONE]]) {
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await signedIn(viewport, scheme);
      await openResult(page, `/review?result=${state.task}&run=${state.run}`);
      // A phone's dock starts compact (the ink act and More): More opens the outline act beside it.
      const compact = where === 'phone' ? await actsOf(page) : null;
      if (where === 'phone') await page.locator('[data-dock-more]').click();
      const f = await actsOf(page);
      const label = `${state.key} ${where} ${scheme}`;
      if (scheme === 'light') {
        if (compact !== null) check(`${label}: the dock starts compact, the ink act alone in its row`, compact.row.length === 1 && compact.row[0].act === state.ink, compact.row.map(one => one.act).join(','));
        check(`${label}: exactly one ink act, ${state.ink}, never navigation`, f.ink.length === 1 && f.ink[0].act === state.ink && f.primaries === 1 && (f.ink[0].tag !== 'A' || f.ink[0].href === '#request-changes'), JSON.stringify(f.ink));
        check(`${label}: the outline act beside it is ${state.second}`, f.row.length === 2 && f.row[1].act === state.second && (state.secondText === undefined || f.row[1].text === state.secondText), f.row.map(one => `${one.act} "${one.text}"`).join(','));
        check(`${label}: ${state.line === null ? 'no can\'t-accept line' : 'one line says why first'}`, state.line === null ? !f.cantAccept : f.cantAccept && f.line === state.line, f.line ?? '');
        check(`${label}: the status card holds no acts, one bounded sentence`, f.statusButtons === 0 && f.sentence !== null && f.sentence.length <= 141 && !/[.!?]\s+\S/.test(f.sentence.replace(/\b(e\.g|i\.e)\./g, '')), f.sentence ?? '');
        check(`${label}: titled with the task; no sideways scroll`, f.title !== null && !/^Build #/.test(f.title) && !f.wide, f.title ?? '');
        if (where === 'desk') {
          const [a, b] = f.row;
          // An Accept that takes a reason stacks under its field; otherwise the acts share one row.
          if (state.reason) check(`${label}: the reason field sits directly above Accept`, await page.locator('[data-accept-with-reason] #accept-reason').count() === 1 && b.top > a.top, `${a.top}→${b.top}`);
          else check(`${label}: acts in one row, 8px apart`, a.top === b.top && b.left - a.right === 8, `${a.right}→${b.left}`);
        } else {
          const [a, b] = f.row;
          // Opened, the ink act keeps its row beside Less and the outline act takes the full row under it.
          check(`${label}: full-width dock, ink over outline`, f.dock.width === PHONE.width && f.dock.left === 0 && f.dock.position === 'sticky' && a.bottom <= b.top && a.left === b.left && b.width === PHONE.width - 32, JSON.stringify({ dock: f.dock, a, b }));
        }
      }
      if (where === 'phone') await page.locator('[data-result-decision]').scrollIntoViewIfNeeded();
      await shot(page, `${state.key}-${where}-${scheme}`, `${where === 'desk' ? 'Desktop' : 'Phone'} ${scheme}, ${state.key}: one ink act (${state.ink})${state.line === null ? '' : ' after the can\'t-accept line'} (synthetic)`);
      await ctx.close();
    }
  }
}

// ---- Run checks: back on an anchor that exists; while they run, no Accept is ink --
{
  const { ctx, page } = await signedIn(DESK, 'light');
  await openResult(page, `/review?result=rounding-check&run=${checkRun}`);
  await Promise.all([page.waitForNavigation(), page.locator('[data-ink-act="run-checks"]').click()]);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  const landed = new URL(page.url());
  const anchor = await page.evaluate(() => { const el = document.getElementById(location.hash.slice(1)); return el === null ? null : { visible: el.getClientRects().length > 0, top: Math.round(el.getBoundingClientRect().top) }; });
  check('Run checks returns to an anchor that exists and shows', landed.hash !== '' && anchor !== null && anchor.visible && landed.searchParams.get('tab') === 'checks', `${landed.pathname}${landed.search}${landed.hash} ${JSON.stringify(anchor)}`);
  await ctx.close();
  for (const [where, viewport] of [['desk', DESK], ['phone', PHONE]]) {
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await signedIn(viewport, scheme);
      await openResult(page, `/review?result=rounding-check&run=${checkRun}`);
      if (where === 'phone') await page.locator('[data-dock-more]').click();
      const f = await actsOf(page);
      const label = `checks-running ${where} ${scheme}`;
      if (scheme === 'light') {
        const disabled = await page.locator('[data-ink-act="checks-running"]').isDisabled().catch(() => false);
        check(`${label}: no Accept is ink; a disabled Checks running leads`, f.ink.length === 1 && f.ink[0].act === 'checks-running' && f.ink[0].text === 'Checks running' && disabled, JSON.stringify(f.ink));
        check(`${label}: Accept without checks sits beside it, in outline`, f.row.length === 2 && f.row[1].act === 'accept' && f.row[1].text === 'Accept without checks', f.row.map(one => `${one.act} "${one.text}"`).join(','));
      }
      if (where === 'phone') await page.locator('[data-result-decision]').scrollIntoViewIfNeeded();
      await shot(page, `checks-running-${where}-${scheme}`, `${where === 'desk' ? 'Desktop' : 'Phone'} ${scheme}, checks running: disabled Checks running ink, Accept without checks outline (synthetic)`);
      await ctx.close();
    }
  }
}

// ---- /r/<id> opens the one result page; the run record is under Details -----
{
  const { ctx, page } = await signedIn(DESK, 'light');
  await page.goto(`${fixture.url}/r/${mismatchRun}`);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  const landed = new URL(page.url());
  check('c1 /r/<id> redirects to the one result page, no path in the URL', landed.pathname === '/review' && landed.searchParams.get('result') === 'range-filter' && landed.searchParams.get('run') === String(mismatchRun) && !landed.search.includes('project'), page.url());
  check('c1 the page is titled with the task', (await page.locator('h1').first().innerText()).trim() === 'Make the date-range filter inclusive');
  await page.locator('[data-result-meta] a', { hasText: `Build #${mismatchRun}` }).click();
  const record = page.locator('details#run-record');
  await record.waitFor({ timeout: 5_000 });
  const opened = await record.evaluate(one => one.open);
  const text = await record.innerText();
  check('c1 Build # opens the run record under Details', opened && /Run record/.test(text) && /Worker/.test(text) && /Full run record/.test(text), text.slice(0, 120));
  await record.scrollIntoViewIfNeeded();
  await shot(page, 'run-record-desk-light', 'Desktop light: Build # opened the Run record under Details on the one result page (synthetic)');
  await page.locator('details#run-record a', { hasText: 'Full run record' }).click();
  await page.waitForLoadState('domcontentloaded');
  check('c1 the full run record still opens at ?record=1', new URL(page.url()).searchParams.get('record') === '1' && /\/r\//.test(page.url()), page.url());
  await ctx.close();
}

// ---- phone: meta links 44px, page gutter 16px, Tasks tabs show they scroll --
{
  const { ctx, page } = await signedIn(PHONE, 'light');
  await openResult(page, `/review?result=range-filter&run=${mismatchRun}`);
  const meta = await page.evaluate(() => [...document.querySelectorAll('[data-result-meta] a')].map(one => ({ text: one.textContent.trim(), height: Math.round(one.getBoundingClientRect().height) })));
  check('c3 phone meta links (Build #, Open task, Discuss) are 44px targets', meta.length === 3 && meta.every(one => one.height >= 44), JSON.stringify(meta));
  const gutter = await page.evaluate(() => { const h1 = document.querySelector('h1'); const r = h1.getBoundingClientRect(); return { left: Math.round(r.left), status: Math.round(document.querySelector('[data-result-status]').getBoundingClientRect().left) }; });
  check('c3 phone page side padding is 16px', gutter.left === 16 && gutter.status === 16, JSON.stringify(gutter));
  await page.goto(`${fixture.url}/work`);
  const strip = page.locator('nav[aria-label="Task views"]');
  await strip.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(100);
  const tabs = await strip.evaluate(nav => ({ overflow: nav.scrollWidth > nav.clientWidth + 1, scrolls: nav.getAttribute('data-scrolls'), mask: getComputedStyle(nav).maskImage || getComputedStyle(nav).webkitMaskImage }));
  check('phone Tasks tab strip shows it scrolls instead of clipping', !tabs.overflow || (tabs.scrolls === 'more' && /gradient/.test(tabs.mask)), JSON.stringify(tabs));
  await shot(page, 'tasks-tabs-phone-light', 'Phone light: the Tasks view tabs fade at the right edge, showing they scroll (synthetic)');
  if (tabs.overflow) {
    await strip.evaluate(nav => nav.scrollTo({ left: nav.scrollWidth, behavior: 'instant' }));
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Task views"]')?.getAttribute('data-scrolls') === 'end', null, { timeout: 3_000 }).catch(() => {});
    const end = await strip.evaluate(nav => nav.getAttribute('data-scrolls'));
    check('phone Tasks tab strip: scrolled to the end, Complete shows whole', end === 'end' && await page.locator('nav[aria-label="Task views"] a', { hasText: 'Complete' }).evaluate(a => { const r = a.getBoundingClientRect(); return r.right <= window.innerWidth; }), end);
  }
  await ctx.close();
}

// ---- Accept semantics unchanged: the ink Accept completes the exact receipt --
{
  const { ctx, page } = await signedIn(DESK, 'light');
  await openResult(page, `/review?result=csv-header&run=${csvRun}`);
  const verdict = JSON.stringify(store.proofVerdictFor(csvRun));
  await Promise.all([page.waitForNavigation(), page.locator('[data-ink-act="accept"]').click()]);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 10_000 });
  check('c3 Accept marks the exact result complete and leaves the verdict unchanged', /Complete/.test(await page.locator('[data-result-status]').first().innerText()) && JSON.stringify(store.proofVerdictFor(csvRun)) === verdict);
  check('c3 Accept publishes nothing', store.publicationForRun(csvRun) === null);
  const after = await actsOf(page);
  check('complete: nothing waits, so no ink act', after.ink.length === 0, JSON.stringify(after.ink));
  await ctx.close();
}

await browser.close();
await fixture.stop();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed; screenshots in ${out}`);
process.exit(failed.length === 0 ? 0 : 1);
