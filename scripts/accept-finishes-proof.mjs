/** Accept and finish browser proof (2026-10-02): accepting a result finishes
 * the task in one request, after the evidence. Driven against the isolated
 * synthetic fixture (`scripts/ui-polish-fixture.mjs`) in headless Chromium,
 * with two more synthetic results seeded here:
 *   - `empty-state-copy`: one requirement only a person can check, no check ran.
 *   - `csv-header`: every requirement met and the project check passed.
 * The fixture's `range-filter` result claims a file its saved diff doesn't have.
 * Headless Chromium at 390×844 is NOT physical iPhone Safari, and every
 * screenshot is synthetic fixture data.
 *
 *   node scripts/accept-finishes-proof.mjs [--out <dir>]
 *
 * Writes to a fresh temporary directory unless --out names one. Build first.
 *
 * Checks: on desk the decision comes after Summary / Changes / Checks and the
 * person's checks; Looks right and Not right update the Requirements count and
 * the acts at once; until the check is answered the ink act is the next check
 * and Accept reads "Accept without your check" in outline with one line naming
 * it; Accept and finish is one request that records the acceptance and the
 * completion; on a phone the dock starts as one row (ink act and More) and
 * never covers the status card or a fact (each status fact, the first Summary
 * fact) on load. Exits 1 when a check fails. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { assignmentOf } from '../dist/assignment.js';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const named = at === -1 ? null : args[at + 1];
if (at !== -1 && (named === undefined || named.startsWith('--'))) { console.error('--out needs a directory'); process.exit(2); }
const shown = named ?? mkdtempSync(join(tmpdir(), 'accept-finishes-'));
const out = resolve(shown);
mkdirSync(out, { recursive: true });

/** Playwright is not a dependency: an installed copy, PLAYWRIGHT_MODULE, or one `npx playwright` left in the npm cache. */
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
const HEAD = '7d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e';
const BASE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

const STATEMENT = 'The empty Results page tells a first-time user where results come from, readable on a phone.';
const pendingRun = seedResult({
  id: 'empty-state-copy', title: 'Clarify the Results empty state',
  acceptance: [{ id: 'c1', statement: STATEMENT, how: null, evidence: ['manual-review'] }],
  patch: 'diff --git a/src/ui/results-empty.tsx b/src/ui/results-empty.tsx\n--- a/src/ui/results-empty.tsx\n+++ b/src/ui/results-empty.tsx\n@@ -8,3 +8,3 @@ export function ResultsEmpty() {\n     <section className="empty-state">\n-      <p className="empty-state-copy">No results.</p>\n+      <p className="empty-state-copy">Nothing to review yet. When a build finishes, its result lands here.</p>\n     </section>\n',
  files: [{ path: 'src/ui/results-empty.tsx', additions: 1, deletions: 1 }],
  handoff: { conclusion: 'Rewrote the empty Results copy so a first-time user knows results arrive when a build finishes.', changes: ['Replaced "No results." with a sentence that says where results come from.'], verification: ['Read it at 390px in the dev server.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: STATEMENT, verdict: 'not-checked', how: 'Rewrote the copy; a person reads it.', evidence: [{ kind: 'manual-review', ref: 'Open Results with nothing in it at phone width and read the sentence.' }, { kind: 'changed-path', ref: 'src/ui/results-empty.tsx' }, { kind: 'screenshot', ref: 'evidence/results-empty-phone.png' }] }], checks: [], changed: ['src/ui/results-empty.tsx'], caveats: [], screenshots: [{ path: 'evidence/results-empty-phone.png', caption: 'Empty Results at 390px (synthetic)' }] },
  shot: 'evidence/results-empty-phone.png', checks: false,
});
const metRun = seedResult({
  id: 'csv-header', title: 'Add a header row to the CSV export',
  acceptance: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', how: null, evidence: ['check', 'changed-path'] }],
  patch: 'diff --git a/src/export/csv.ts b/src/export/csv.ts\n--- a/src/export/csv.ts\n+++ b/src/export/csv.ts\n@@ -3,4 +3,5 @@ export function toCsv(rows: Row[]): string {\n-  return rows.map(line).join("\\n");\n+  const header = COLUMNS.map(column => column.title).join(",");\n+  return [header, ...rows.map(line)].join("\\n");\n }\n',
  files: [{ path: 'src/export/csv.ts', additions: 2, deletions: 1 }],
  handoff: { conclusion: 'Every CSV export now starts with a header row naming each column, in the existing order.', changes: ['Added the header row in src/export/csv.ts.'], verification: ['npm test: 48 passed.'] },
  proof: { version: 1, criteria: [{ id: 'c1', statement: 'Every exported CSV begins with one header row naming each column.', verdict: 'met', how: 'Added a header and a test.', evidence: [{ kind: 'check', ref: 'npm test' }, { kind: 'changed-path', ref: 'src/export/csv.ts' }] }], checks: [{ command: 'npm test', exitCode: 0, summary: '48 tests passed' }], changed: ['src/export/csv.ts'], caveats: [], screenshots: [] },
  checks: true,
});
const mismatchRun = store.runsFor(store.lookupRef('range-filter').id).find(one => one.role === 'builder').id;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
async function open(viewport, colorScheme, task, run) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await page.goto(`${fixture.url}/review?result=${task}&run=${run}`);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts?.ready);
  return { ctx, page };
}
const shots = new Map();
async function capture(page, key) {
  const path = join(out, `${key}.png`);
  await page.screenshot({ path });
  shots.set(key, path);
}

/** What the page shows: the acts, the decision's words, the Requirements row, where the parts sit. */
const factsOf = page => page.evaluate(() => {
  const visible = el => el !== null && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const box = el => { if (!visible(el)) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }; };
  const dock = document.querySelector('[data-result-decision]');
  const tabs = document.querySelector('[role="tablist"][aria-label="Result views"]');
  return {
    ink: [...document.querySelectorAll('[data-ink-act]')].filter(visible).map(el => ({ act: el.getAttribute('data-ink-act'), text: el.textContent.trim() })),
    acts: [...document.querySelectorAll('[data-result-acts] [data-act]')].filter(visible).map(el => ({ act: el.getAttribute('data-act'), text: el.textContent.trim(), ink: el.hasAttribute('data-ink-act') })),
    more: visible(document.querySelector('[data-dock-more]')),
    line: [...document.querySelectorAll('[data-decision-why]')].filter(visible).map(el => el.textContent.trim())[0] ?? null,
    effect: [...document.querySelectorAll('[data-decision-effect]')].filter(visible).map(el => el.textContent.trim())[0] ?? null,
    reason: visible(document.querySelector('#accept-reason')),
    requirements: document.querySelector('[data-result-status] [data-status-detail="requirements"]')?.textContent.trim() ?? null,
    status: box(document.querySelector('[data-result-status]')),
    // The facts as they load: each status fact row, then the first thing the Summary tab says.
    facts: [...document.querySelectorAll('[data-result-status] [data-status-detail]'), document.querySelector('[data-result-view="summary"]:not([hidden]) .so-result-view > *')]
      .map(box).filter(one => one !== null && one.top < innerHeight),
    statusDoc: (() => { const r = document.querySelector('[data-result-status]').getBoundingClientRect(); return Math.round(r.bottom + scrollY); })(),
    tabs: tabs === null ? null : Math.round(tabs.getBoundingClientRect().top + scrollY),
    checks: (() => { const el = document.querySelector('[data-result-you-check]'); return el === null ? null : Math.round(el.getBoundingClientRect().top + scrollY); })(),
    decisionDoc: dock === null ? null : Math.round(dock.getBoundingClientRect().top + scrollY),
    dock: box(dock),
    dockState: dock?.getAttribute('data-dock') ?? null,
    position: dock === null ? null : getComputedStyle(dock).position,
    wide: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

const STATES = [
  { key: 'all-met', task: 'csv-header', run: metRun, ink: 'accept', inkText: 'Accept and finish', second: 'request-changes' },
  { key: 'check-pending', task: 'empty-state-copy', run: pendingRun, ink: 'next-check', inkText: 'Go to your check', second: 'accept', secondText: 'Accept without your check', line: `Not checked yet: “${STATEMENT.replace(/\.$/, '')}”.` },
  { key: 'mismatch', task: 'range-filter', run: mismatchRun, ink: 'request-changes', inkText: 'Request changes', second: 'accept', secondText: 'Accept and finish', reason: true },
];

for (const state of STATES) {
  for (const [where, viewport] of [['desk', DESK], ['phone', PHONE]]) {
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await open(viewport, scheme, state.task, state.run);
      const f = await factsOf(page);
      const label = `${state.key} ${where} ${scheme}`;
      if (scheme === 'light') {
        check(`${label}: one ink act, ${state.inkText}`, f.ink.length === 1 && f.ink[0].act === state.ink && f.ink[0].text === state.inkText, JSON.stringify(f.ink));
        check(`${label}: no sideways scroll`, !f.wide);
        if (where === 'desk') {
          check(`${label}: the decision comes after the evidence (status, Summary/Changes/Checks, your checks, then the decision)`,
            f.decisionDoc > f.statusDoc && f.tabs !== null && f.decisionDoc > f.tabs && (f.checks === null || (f.checks > f.tabs && f.decisionDoc > f.checks)), JSON.stringify({ status: f.statusDoc, tabs: f.tabs, checks: f.checks, decision: f.decisionDoc }));
          check(`${label}: the outline act beside it is ${state.second}`, f.acts.length === 2 && f.acts[1].act === state.second && (state.secondText === undefined || f.acts[1].text === state.secondText), f.acts.map(one => `${one.act} "${one.text}"`).join(', '));
          if (state.line) check(`${label}: one line says which check is unanswered`, f.line === state.line, f.line ?? '');
          if (state.ink === 'accept' || state.second === 'accept') check(`${label}: the line under Accept says it finishes the task`, /^Finishes the task\./.test(f.effect ?? ''), f.effect ?? '');
          if (state.reason) check(`${label}: accepting asks for a reason, above Accept`, f.reason);
        } else {
          check(`${label}: the dock starts compact — one row, the ink act and More`, f.dockState === 'compact' && f.acts.length === 1 && f.acts[0].ink && f.more && f.position === 'sticky' && f.dock.height <= 90 && f.line === null && !f.reason,
            JSON.stringify({ acts: f.acts, more: f.more, dock: f.dock, line: f.line, reason: f.reason }));
          check(`${label}: the dock never covers the status card on load`, f.dock === null || f.status === null || f.dock.top >= f.status.bottom, JSON.stringify({ dock: f.dock, status: f.status }));
          check(`${label}: the dock never covers a fact on load (each status fact, then the first Summary fact)`, f.facts.length > 0 && (f.dock === null || f.facts.every(one => one.bottom <= f.dock.top || one.top >= f.dock.bottom)),
            JSON.stringify({ dock: f.dock, facts: f.facts }));
        }
      }
      // On desk the decision sits after the evidence: the capture scrolls to it; on a phone it is the page as it loads.
      if (where === 'desk') await page.locator('[data-result-decision]').evaluate(el => el.scrollIntoView({ block: 'end' }));
      await capture(page, `${state.key}-${where}-${scheme}`);
      if (where === 'phone' && scheme === 'light' && state.key === 'check-pending') {
        // Reading the check, the compact dock stays pinned under it.
        await page.locator('[data-result-you-check]').evaluate(el => el.scrollIntoView({ block: 'start' }));
        const reading = await factsOf(page);
        check(`${label}: reading the check, the compact dock stays in view`, reading.dock !== null && reading.dock.top < PHONE.height && reading.dock.bottom <= PHONE.height + 20 && reading.dockState === 'compact', JSON.stringify(reading.dock));
        await capture(page, `${state.key}-phone-reading`);
      }
      if (where === 'phone' && scheme === 'light') {
        await page.locator('[data-dock-more]').click();
        const opened = await factsOf(page);
        check(`${label}: More opens the rest (the outline act${state.reason ? ', the reason field' : ''} and what accepting does)`,
          opened.dockState === 'open' && opened.acts.length === 2 && (state.reason ? opened.reason : true) && (opened.effect !== null || state.ink === 'request-changes' && !state.reason), JSON.stringify({ acts: opened.acts, effect: opened.effect, reason: opened.reason }));
        if (state.key === 'mismatch') await capture(page, `${state.key}-phone-more`);
      }
      await ctx.close();
    }
  }
}

// ---- answering a check: the count and the acts follow at once; Accept and finish is one request -----------
{
  const { ctx, page } = await open(DESK, 'light', 'empty-state-copy', pendingRun);
  const before = await factsOf(page);
  check('pending: Requirements reads 0 of 1 met · You check 1', before.requirements?.includes('0 of 1 met · You check 1'), before.requirements ?? '');
  await page.locator('[data-ink-act="next-check"]').click();
  const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-looks-right') === true);
  check('Go to your check brings the check into view, its Looks right focused', focused);
  await page.locator('[data-check-item] button[data-looks-right]').click();
  const looked = await factsOf(page);
  check('Looks right: Requirements reads 1 of 1 met at once', looked.requirements?.includes('1 of 1 met') && !looked.requirements.includes('You check'), looked.requirements ?? '');
  // The project has a check none ran on this result: once the person's check is answered, Run checks leads and Accept says why it isn't plain.
  check('Looks right: the next check gives way at once (Run checks leads; Accept without checks says why)', looked.ink.length === 1 && looked.ink[0].act === 'run-checks'
    && looked.acts.find(one => one.act === 'accept')?.text === 'Accept without checks' && looked.line !== null && !looked.line.startsWith('Not checked yet'), JSON.stringify({ ink: looked.ink, acts: looked.acts, line: looked.line }));
  await page.locator('[data-check-item] button[data-looks-right]').click();
  const undone = await factsOf(page);
  check('pressing Looks right again takes it back', undone.ink[0]?.act === 'next-check' && undone.requirements?.includes('You check 1'), JSON.stringify({ ink: undone.ink, req: undone.requirements }));
  await page.locator('[data-check-item] button[data-not-right]').click();
  const wrong = await factsOf(page);
  const quoted = await page.locator('#comment-form textarea[name="note"]').inputValue().catch(() => '');
  check('Not right: Request changes is ink, Accept reads Accept anyway, the count stays 0 of 1, the note quotes the item',
    wrong.ink[0]?.act === 'request-changes' && wrong.acts.find(one => one.act === 'accept')?.text === 'Accept anyway' && wrong.requirements?.startsWith('Requirements0 of 1 met') && !wrong.requirements.includes('You check') && quoted.includes(STATEMENT),
    JSON.stringify({ ink: wrong.ink, acts: wrong.acts, req: wrong.requirements, line: wrong.line }));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  const pressed = await page.locator('[data-check-item] button[data-not-right]').evaluate(el => ({ pressed: el.getAttribute('aria-pressed'), bg: getComputedStyle(el).backgroundColor }));
  check('Not right shows it is pressed', pressed.pressed === 'true' && !/rgba\(0, 0, 0, 0\)|transparent/.test(pressed.bg), JSON.stringify(pressed));
  await page.mouse.move(0, 0);
  await page.locator('[data-result-decision]').scrollIntoViewIfNeeded();
  await capture(page, 'check-not-right-desk-light');
  await page.locator('[data-check-item] button[data-looks-right]').click();
  const posts = [];
  // The session's own heartbeat isn't an act.
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname !== '/session/attended-beats') posts.push(new URL(request.url()).pathname); });
  await Promise.all([page.waitForNavigation(), page.locator('[data-result-acts] button[data-act="accept"]').click()]);
  await page.locator('[data-result-status]').first().waitFor({ timeout: 15_000 });
  const done = assignmentOf(store, 'empty-state-copy', new Date(), { principal: 'operator', repos: null }, evidenceRoot);
  const ledger = store.handle.prepare("SELECT action, outcome, source FROM action_ledger WHERE task_id = 'empty-state-copy' AND action IN ('task accept-proof', 'assignment handoff checked') ORDER BY id").all();
  check('Accept and finish is one request to /complete', posts.length === 1 && posts[0] === '/t/empty-state-copy/complete', posts.join(', '));
  check('it records the acceptance and completes the task', store.proofAcceptance(pendingRun)?.approver === fixture.name && done.state === 'complete' && done.receipt.completionKind === 'accepted-exception', `${done.state} ${done.receipt.completionKind}`);
  check('both ledger acts, the completion under the accepted receipt\'s digest', ledger.length === 2 && ledger[0].action === 'task accept-proof' && ledger[1].outcome === done.receipt.digest && done.completion?.digest === done.receipt.digest, JSON.stringify(ledger));
  const after = await factsOf(page);
  check('after: no second Mark complete, nothing left to accept', after.acts.every(one => one.act !== 'accept') && !(await page.locator('text=Mark complete').count()), JSON.stringify(after.acts));
  await ctx.close();
}
await browser.close();

// ---- light and dark side by side, one image per state and device ----------------------------------------
{
  const page = await (await chromium.launch()).newPage();
  const pairs = [...new Set([...shots.keys()].filter(key => /-(light|dark)$/.test(key)).map(key => key.replace(/-(light|dark)$/, '')))].filter(pair => shots.has(`${pair}-light`) && shots.has(`${pair}-dark`));
  for (const pair of pairs) {
    const [light, dark] = ['light', 'dark'].map(scheme => `data:image/png;base64,${readFileSync(shots.get(`${pair}-${scheme}`)).toString('base64')}`);
    const width = pair.includes('phone') ? PHONE.width : DESK.width;
    await page.setViewportSize({ width: width * 2 + 24, height: pair.includes('phone') ? PHONE.height : DESK.height });
    await page.setContent(`<body style="margin:0;display:flex;gap:24px;background:#888"><img src="${light}" width="${width}"><img src="${dark}" width="${width}"></body>`);
    await page.waitForLoadState('load');
    const path = join(out, `${pair}-light-dark.png`);
    await page.screenshot({ path, fullPage: true });
    report.screenshots.push({ path: join(shown, `${pair}-light-dark.png`), caption: `${pair.replace('-', ' ')}: light and dark, ${pair.includes('phone') ? 'on load' : 'scrolled to the decision'} (synthetic)` });
  }
  for (const extra of ['check-pending-phone-reading', 'mismatch-phone-more', 'check-not-right-desk-light']) report.screenshots.push({ path: join(shown, `${extra}.png`), caption: extra });
  await page.context().browser().close();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
await fixture.close?.();
const failed = report.checks.filter(one => !one.ok);
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed; screenshots in ${shown}`);
process.exit(failed.length === 0 ? 0 : 1);
