/** Result review browser proof (2026-10-02): reviewing a result shows the
 * change before Accept, and Accept is honest. Driven against the isolated
 * synthetic fixture (`scripts/ui-polish-fixture.mjs`) in headless Chromium;
 * two more synthetic results are seeded here:
 *   - `empty-state-copy`: a requirement only a person can check, citing a
 *     changed file with one very long line and a screenshot; no check ran.
 *   - `csv-header`: every requirement met and the project check passed.
 * Headless Chromium at 390×844 is NOT physical iPhone Safari, and every
 * screenshot is synthetic fixture data.
 *
 *   node scripts/result-review-proof.mjs [--out <dir>]
 *
 * Writes to a fresh temporary directory unless --out names one; never to
 * ./evidence by default. Report paths are under that directory as given.
 *
 * Checks: the item, its evidence and Looks right / Not right come after the
 * Summary / Changes / Checks tabs and before the decision; Accept reads
 * "Accept without your check" with one line naming it and says what
 * accepting does, or "Accept and finish" in ink when all is met; the
 * excerpt and the Changes diff wrap on a phone (no sideways scroll); text is
 * at least 12px; the decision's controls are 44px; Not right opens Request
 * changes quoting the item; on a phone the decision stays in view while the
 * person reads their check; Accept and finish completes it in one request.
 * Build first. Exits 1 when a check fails. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture, encodePng } from './ui-polish-fixture.mjs';
import { approve } from '../dist/scope.js';
import { legOf, routeDigestOf } from '../dist/phase-routing.js';
import { fileTaskProposal } from '../dist/proposal.js';
import { storeEvidence, budgetedStatJson, imageDimensions } from '../dist/evidence.js';
import { parseProof, adjudicate } from '../dist/proof.js';
import { sealVerificationReceipt } from '../dist/verification-evidence.js';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const named = at === -1 ? null : args[at + 1];
if (at !== -1 && (named === undefined || named.startsWith('--'))) { console.error('--out needs a directory'); process.exit(2); }
const shown = named ?? mkdtempSync(join(tmpdir(), 'result-review-'));
const out = resolve(shown);
mkdirSync(out, { recursive: true });

/** Playwright is not a dependency: an installed copy, PLAYWRIGHT_MODULE, or one `npx playwright` left in the npm cache — whichever has its browser downloaded. */
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

const fixture = await startFixture({ secondProject: true });
const { store } = fixture;
const evidenceRoot = join(fixture.configDir, 'evidence');
const now = new Date();
const ago = hours => new Date(now.getTime() - hours * 3_600_000);
const HEAD = '7d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e';
const BASE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LONG_LINE = '      <p className="empty-state-copy">Nothing to review yet. When a build finishes, its result lands here with what changed, what was checked, and anything you still need to look at yourself.</p>';

function seedResult({ id, title, acceptance, patch, files, handoff, proof, shot, checks }) {
  // The project check lives on the second project, so the first records none (no check ran).
  const repo = checks ? fixture.repos.second : fixture.repos.main;
  const filed = fileTaskProposal(store, { id, title, repo, goal: `${title}.`, outOfScope: 'No changes outside the results page.', touches: files.map(one => one.path), acceptance, filedVia: 'console', planning: 'skip' }, ago(3));
  if (!filed.ok) throw new Error(`seed ${id}: ${filed.reason}`);
  const scope = store.getScope(id);
  approve(store, id, fixture.name, ago(2.9), scope.digest, fixture.password);
  const ref = store.refFor('built-in', id).id;
  const route = store.approvedRouteOf(id);
  const run = store.startRun({ taskRef: ref, leaseId: `proof-lease-${id}`, runner: 'night-shift-2', branch: `standing-orders/${id}`, worktree: join(repo, `.proof-${id}`), now: ago(2), provider: 'codex', model: 'default',
    ...(route === null ? {} : { route: { routeDigest: routeDigestOf(route), phase: 'build', provider: legOf(route, 'build').provider, model: legOf(route, 'build').model, chosen: legOf(route, 'build').chosen } }) });
  store.stampRun(run, { baseRevision: BASE, scopeDigest: scope.digest });
  const stat = { schema: 1, base: BASE, head: HEAD, fileCount: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), binaryCount: 0, files, filesTruncated: false };
  const png = encodePng(780, 1688, [52, 84, 128]);
  storeEvidence(store, evidenceRoot, run, 'terminal-diff', 'terminal-diff.patch', Buffer.from(patch, 'utf8'), 'git diff (exit 0) [fixture: synthetic]', ago(1.5), { captureStatus: 'ok' });
  storeEvidence(store, evidenceRoot, run, 'diff-stat', 'diff-stat.json', budgetedStatJson(stat), 'git diff --numstat [fixture: synthetic]', ago(1.5));
  storeEvidence(store, evidenceRoot, run, 'handoff', 'handoff.json', Buffer.from(JSON.stringify({ schema: 1, outcome: 'built', committed: true, followUps: [], decisionsIncorporated: [], ...handoff }), 'utf8'), 'composed at completion [fixture: synthetic]', ago(1.4));
  storeEvidence(store, evidenceRoot, run, 'proof', 'proof.json', Buffer.from(JSON.stringify(proof), 'utf8'), 'agent-authored proof (validated) [fixture: synthetic]', ago(1.4));
  if (shot) storeEvidence(store, evidenceRoot, run, 'screenshot', 'screenshot.png', png, `agent-claimed screenshot at ${shot} (validated png) [fixture: synthetic]`, ago(1.4));
  const verify = checks ? { configured: true, ran: true, exitCode: 0 } : { configured: false, ran: false, exitCode: null };
  if (checks) {
    store.setVerifyCommand({ repo, command: 'npm test', timeoutMs: 60000, approvedBy: fixture.name }, ago(4));
    storeEvidence(store, evidenceRoot, run, 'check-log', 'check-log.txt', Buffer.from('$ npm test\n(exit 0)\n\n--- stdout ---\n48 tests passed.\n', 'utf8'), 'sh -c "npm test" (exit 0) [fixture: synthetic]', ago(1.4));
  }
  const verdict = adjudicate({
    proofArtifactPresent: true, proofParse: parseProof(JSON.stringify(proof)), handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: 'ok',
    diffStat: { captured: true, truncated: false, paths: new Set(files.map(one => one.path)) }, verifyCommand: verify,
    screenshots: shot ? [{ path: shot, ok: true, bytes: png.length, dims: imageDimensions(png, 'png') }] : [], approvedCriteria: scope.acceptance,
  });
  store.recordOutcomeFacts(run, { headRevision: HEAD });
  if (checks) sealVerificationReceipt(store, evidenceRoot, run, HEAD, store.liveVerifyCommand(repo), verify, ago(1.3));
  store.saveProofVerdict(run, verdict.verdict, verdict.reasons, ago(1.3), verdict.matrix);
  store.finishRun(run, { outcome: 'built', committed: true, now: ago(1.3) });
  store.setTaskState(id, 'done', ago(1.3));
  return run;
}

const emptyRun = seedResult({
  id: 'empty-state-copy', title: 'Clarify the Results empty state',
  acceptance: [{ id: 'c1', statement: 'The empty Results page tells a first-time user where results come from, readable on a phone.', how: null, evidence: ['manual-review'] }],
  patch: `diff --git a/src/ui/results-empty.tsx b/src/ui/results-empty.tsx\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/ui/results-empty.tsx\n+++ b/src/ui/results-empty.tsx\n@@ -8,7 +8,7 @@ export function ResultsEmpty() {\n   return (\n     <section className="empty-state">\n-      <p className="empty-state-copy">No results.</p>\n+${LONG_LINE}\n       <a href="/work">Open tasks</a>\n     </section>\n   );\n`,
  files: [{ path: 'src/ui/results-empty.tsx', additions: 1, deletions: 1 }],
  handoff: { conclusion: 'Rewrote the empty Results copy so a first-time user knows results arrive when a build finishes. The link to tasks is unchanged.', changes: ['Replaced "No results." with a sentence that says where results come from.'], verification: ['Read it at 390px in the dev server.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: 'The empty Results page tells a first-time user where results come from, readable on a phone.', verdict: 'not-checked', how: 'Rewrote the copy; a person reads it.', evidence: [{ kind: 'manual-review', ref: 'Open Results with nothing in it at phone width and read the sentence.' }, { kind: 'changed-path', ref: 'src/ui/results-empty.tsx' }, { kind: 'screenshot', ref: 'evidence/results-empty-phone.png' }] }], checks: [], changed: ['src/ui/results-empty.tsx'], caveats: [], screenshots: [{ path: 'evidence/results-empty-phone.png', caption: 'Empty Results at 390px (synthetic)' }] },
  shot: 'evidence/results-empty-phone.png', checks: false,
});
const csvRun = seedResult({
  id: 'csv-header', title: 'Add a header row to the CSV export',
  acceptance: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', how: null, evidence: ['check', 'changed-path'] }],
  patch: `diff --git a/src/export/csv.ts b/src/export/csv.ts\nindex 2b3c4d5..6e7f8a9 100644\n--- a/src/export/csv.ts\n+++ b/src/export/csv.ts\n@@ -3,4 +3,5 @@ export function toCsv(rows: Row[]): string {\n-  return rows.map(line).join("\\n");\n+  const header = COLUMNS.map(column => column.title).join(",");\n+  return [header, ...rows.map(line)].join("\\n");\n }\n`,
  files: [{ path: 'src/export/csv.ts', additions: 2, deletions: 1 }],
  handoff: { conclusion: 'Every CSV export now starts with a header row naming each column, in the existing order.', changes: ['Added the header row in src/export/csv.ts.'], verification: ['npm test: 48 passed.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', verdict: 'met', how: 'Added a header and a test.', evidence: [{ kind: 'check', ref: 'npm test' }, { kind: 'changed-path', ref: 'src/export/csv.ts' }] }], checks: [{ command: 'npm test', exitCode: 0, summary: '48 tests passed' }], changed: ['src/export/csv.ts'], caveats: [], screenshots: [] },
  checks: true,
});

const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
async function open(viewport, colorScheme, task, run, tab = null) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await page.goto(`${fixture.url}/review?result=${task}&run=${run}${tab === null ? '' : `&tab=${tab}`}`);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts?.ready);
  return { ctx, page };
}
async function shot(page, name, caption) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push({ path: join(shown, `${name}.png`), caption });
}
/** Layout facts in the page: order, overflow, sizes. */
const facts = page => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const status = q('[data-result-status]'), items = q('[data-result-you-check]'), decision = q('[data-result-decision]'), tabs = q('[role="tablist"]');
  const before = (a, b) => a !== null && b !== null && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const wide = [...document.querySelectorAll('[data-check-excerpt], .diff-lines, .diff-line, [data-result-decision]')].filter(one => one.scrollWidth > one.clientWidth + 1).map(one => one.className || one.getAttribute('data-check-excerpt'));
  const panes = [...document.querySelectorAll('*')].filter(one => { const s = getComputedStyle(one); return (s.overflowX === 'auto' || s.overflowX === 'scroll') && one.scrollWidth > one.clientWidth + 1 && one.closest('[data-result-status], [data-result-you-check], [data-result-decision], #result'); }).map(one => one.className);
  const small = [...document.querySelectorAll('[data-result-status] *, [data-result-you-check] *, [data-result-decision] *, [data-result-view] *')]
    .filter(one => one.childNodes.length > 0 && [...one.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() !== '') && one.getClientRects().length > 0 && parseFloat(getComputedStyle(one).fontSize) < 12)
    .map(one => `${one.tagName.toLowerCase()}.${one.className} "${one.textContent.trim().slice(0, 24)}":${getComputedStyle(one).fontSize}`);
  const targets = [...document.querySelectorAll('[data-result-decision] button, [data-result-decision] a, [data-looks-right], [data-not-right]')].filter(one => one.getClientRects().length > 0).map(one => Math.round(one.getBoundingClientRect().height));
  return {
    order: before(status, tabs) && before(tabs, items) && before(items, decision), orderNoItems: before(status, tabs) && before(tabs, decision),
    doc: document.documentElement.scrollWidth <= window.innerWidth + 1, wide, panes, small: [...new Set(small)].slice(0, 8), targets,
    label: decision?.querySelector('button[type="submit"]')?.textContent?.trim() ?? null, why: q('[data-decision-why]')?.textContent?.trim() ?? null,
    effect: q('[data-decision-effect]')?.textContent?.trim() ?? null, sentence: q('[data-result-sentence]')?.textContent?.trim() ?? null,
    ink: decision ? getComputedStyle(decision.querySelector('button[type="submit"]')).backgroundColor : null,
    excerpt: q('[data-check-excerpt]')?.textContent ?? '',
    shots: document.querySelectorAll('[data-result-you-check] img').length,
  };
});

// ---- the result with a person's check, no checks run ----------------------
for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await open(DESK, scheme, 'empty-state-copy', emptyRun);
  const f = await facts(page);
  if (scheme === 'light') {
    check('c1 desk: status, then the tabs, then the item with its evidence and Looks right / Not right, then the decision', f.order);
    check('c1 desk: the item shows its changed lines and screenshot', f.excerpt.includes('Nothing to review yet') && f.shots === 1, `shots ${f.shots}`);
    check('c1 desk: Looks right and Not right are on the item', await page.locator('[data-check-item="c1"] [data-looks-right]').count() === 1 && await page.locator('[data-check-item="c1"] [data-not-right]').count() === 1);
    check('c2 desk: Accept without your check, naming which', f.label === 'Accept without your check' && f.why === 'Not checked yet: “The empty Results page tells a first-time user where results come from, readable on a phone”.', `${f.label} / ${f.why}`);
    check('c2 desk: says what accepting does', f.effect === "Finishes the task. The branch stays; publishing isn't set up.", f.effect);
    check('the status card says what happened in one sentence', f.sentence === 'Rewrote the empty Results copy so a first-time user knows results arrive when a build finishes.', f.sentence);
    check('desk: no text under 12px in the result', f.small.length === 0, f.small.join(', '));
    check('desk: decision and item controls are 44px', f.targets.every(h => h >= 44), f.targets.join(','));
  }
  await shot(page, `desk-${scheme}-you-check`, `Desktop ${scheme}: the item to check with its changed lines and screenshot, then Accept without your check and what it does (synthetic)`);
  await ctx.close();
}
for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await open(PHONE, scheme, 'empty-state-copy', emptyRun);
  await page.locator('[data-check-excerpt]').first().scrollIntoViewIfNeeded();
  const f = await facts(page);
  if (scheme === 'light') {
    check('c3 phone: the cited changed line wraps (no sideways scroll)', f.doc && f.wide.length === 0 && f.panes.length === 0, `wide: ${f.wide.join(',')} panes: ${f.panes.join(',')}`);
    // Reading the person's check, the decision stays in view: it sticks within the checks and the decision, never over the facts above.
    const sticky = await page.evaluate(() => { const d = document.querySelector('[data-result-decision]'); const r = d.getBoundingClientRect(); return { position: getComputedStyle(d).position, top: Math.round(r.top), bottom: Math.round(r.bottom), height: window.innerHeight }; });
    check('phone: the decision stays in view while reading the check', sticky.position === 'sticky' && sticky.top >= 0 && sticky.bottom <= sticky.height, JSON.stringify(sticky));
    check('phone: no text under 12px; controls 44px', f.small.length === 0 && f.targets.every(h => h >= 44), `${f.small.join(', ')} ${f.targets.join(',')}`);
  }
  await shot(page, `phone-${scheme}-you-check`, `Phone ${scheme}: the long changed line wrapped beside the item, the decision pinned at the bottom (synthetic)`);
  if (scheme === 'light') {
    await page.locator('[data-check-item="c1"] [data-not-right]').click();
    const box = page.locator('#comment-form textarea[name="note"]');
    await box.waitFor({ state: 'visible', timeout: 5_000 });
    const value = await box.inputValue();
    check('c1 phone: Not right opens Request changes quoting the item', value.startsWith('Not right: “The empty Results page tells a first-time user') && await box.evaluate(one => one === document.activeElement), value.slice(0, 80));
    await shot(page, 'phone-light-not-right', 'Phone light: Not right opened Request changes with the item quoted (synthetic)');
  }
  await ctx.close();
}
{
  const { ctx, page } = await open(PHONE, 'light', 'empty-state-copy', emptyRun, 'changes');
  await page.locator('.diff-line').first().scrollIntoViewIfNeeded();
  const f = await facts(page);
  const line = await page.evaluate(() => { const code = [...document.querySelectorAll('.diff-line code')].find(one => one.textContent.includes('Nothing to review yet')); const r = code.getBoundingClientRect(); return { right: Math.round(r.right), height: Math.round(r.height), white: getComputedStyle(code).whiteSpace }; });
  check('c3 phone: the Changes tab wraps the long line inside the screen', f.doc && f.panes.length === 0 && line.right <= 390 && line.white === 'pre-wrap' && line.height > 30, JSON.stringify(line));
  await shot(page, 'phone-light-changes', 'Phone light: the full diff in Changes with the long line wrapped (synthetic)');
  await ctx.close();
}

// ---- everything met, checks passed: Accept and finish in ink ----------------
{
  const { ctx, page } = await open(DESK, 'light', 'csv-header', csvRun);
  const f = await facts(page);
  check('c2 desk: Accept and finish in ink when everything is met and checks passed', f.label === 'Accept and finish' && f.why === null && f.orderNoItems && f.ink !== 'rgb(255, 255, 255)', `${f.label} ${f.ink}`);
  await shot(page, 'desk-light-accept', 'Desktop light: all met and checks passed, so Accept and finish in ink with what it does (synthetic)');
  await ctx.close();
}

// ---- semantics: Looks right counts at once; Accept and finish accepts and completes the exact receipt --
{
  const { ctx, page } = await open(DESK, 'light', 'empty-state-copy', emptyRun);
  await page.locator('[data-check-item="c1"] [data-looks-right]').click();
  const f = await facts(page);
  check('Looks right records nothing yet; Accept without checks then names only the checks', store.proofAcceptance(emptyRun) === null && f.why === "Checks didn't run.", f.why);
  const verdict = JSON.stringify(store.proofVerdictFor(emptyRun));
  await Promise.all([page.waitForNavigation(), page.locator('[data-result-decision] button[type="submit"][data-accept-result]').click()]);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  check('c3 Accept and finish records the acceptance and completes the exact result, the verdict unchanged', store.proofAcceptance(emptyRun)?.approver === fixture.name && /Complete/.test(await page.locator('[data-result-status]').first().innerText()) && JSON.stringify(store.proofVerdictFor(emptyRun)) === verdict);
  check('c3 Accept and finish publishes nothing: no pull request is started', store.publicationForRun(emptyRun) === null);
  await ctx.close();
}

await browser.close();
await fixture.stop();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed; screenshots in ${out}`);
process.exit(failed.length === 0 ? 0 : 1);
