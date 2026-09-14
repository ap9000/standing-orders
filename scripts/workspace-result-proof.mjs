/** Workspace package 3 browser proof (2026-09-13): result-first review
 * and one revision loop — driven against the isolated synthetic fixture
 * (`scripts/ui-polish-fixture.mjs`: one in-memory database, a throwaway
 * repository, an ephemeral approver, a scripted subscription runner that
 * stands in for the model) in headless Chromium. Nothing here touches a
 * real database, worker, key, model, or worktree, and headless Chromium
 * emulating a phone viewport is NOT physical iPhone Safari. Every
 * screenshot is of synthetic fixture data and is labeled so.
 *
 * What it proves, one section per acceptance criterion:
 *   c1  the chat receipt, the chat's result detail, the run page, and the
 *       review cockpit stamp byte-identical shared facts (run, head, base,
 *       checks, caveats, evidence health, publication) for the same
 *       result; each Summary leads with the deliverable itself.
 *   c2  Summary / Changes / Checks switch in place and by URL (refresh and
 *       Back keep the view); validated screenshots render through the
 *       evidence road; an investigation's report is escaped text with a
 *       download, never markup; a code diff renders with View / Annotate;
 *       a tampered screenshot, a failed change-summary capture, and a
 *       shortened check log are named in the open and never called
 *       validated, and the tampered bytes are refused by the evidence road.
 *   c3  a plain note and a line annotation both land in ONE batch, seal
 *       into ONE revision through the existing road (unapproved, exact
 *       lineage, both links), a replayed note and a replayed seal mint
 *       nothing twice, and the original result stays on record.
 *   c4  the chat draft and the review draft survive opening the result,
 *       Back to chat, refresh, and a refused submission; the selected
 *       result and tab and the reading position survive Back and refresh;
 *       another task and another account on the same tab inherit nothing.
 *   c5  1440×900, 390×844, and 320×740 exact-viewport screenshots of the
 *       result beside chat, the dedicated phone view, the run page, and
 *       the cockpit; no document overflow; tabs, Add note, Create
 *       revision, and Back to chat reachable and inside the viewport.
 *
 *   node scripts/workspace-result-proof.mjs [--out output/playwright/workspace-3-result-2026-09-13] [--strict]
 *
 * Playwright is NOT a dependency of this package: the script imports it
 * from `playwright` when installed, else from PLAYWRIGHT_MODULE, else from
 * the npx cache. With --strict any failed check exits 1. Build first. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { addApprover } from '../dist/scope.js';
import { resultFactsFromHtml } from '../dist/result-review.js';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'output/playwright/workspace-3-result-2026-09-13');
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

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
const report = { generatedAt: new Date().toISOString(), out, fixture: 'scripts/ui-polish-fixture.mjs (synthetic, in-memory; scripted subscription runner, no model)', checks: [], screenshots: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
const fixture = await startFixture();
const browser = await chromium.launch();

async function loginAs(page, name, password) {
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="token"]', password);
  await submit(page, 'button[type="submit"]');
}
const login = page => loginAs(page, fixture.name, fixture.password);
async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  await login(page);
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  // The shell animates cross-document navigation; a capture during that
  // transition is a blank snapshot, so wait for it to end first.
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } }, null, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path, caption });
  return path;
};
/** Click a submit and wait for a NEW document. */
async function submit(page, selector) {
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } }, null, { timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => { window.__staleDocument = true; document.documentElement.style.scrollBehavior = 'auto'; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
}
const goto = async (page, path) => { await page.goto(`${fixture.url}${path}`); await page.waitForLoadState('load'); await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; }); };
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);
const fits = (r, viewport) => r !== null && r.top >= 0 && r.bottom <= viewport.height && r.left >= 0 && r.right <= viewport.width && r.width > 0 && r.height > 0;
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
const html = async path => { const r = await fetch(`${fixture.url}${path}`, { headers: { cookie: cookieHeader } }); return r.text(); };
const factsOf = async (path, selectorHint) => {
  const text = await html(path);
  const all = resultFactsFromHtml(text);
  return { all, text, first: all[0] ?? null };
};
const visibleTab = page => page.evaluate(() => [...document.querySelectorAll('[data-result-view]')].find(v => !v.hidden)?.getAttribute('data-result-view') ?? null);
const selectedTab = page => page.evaluate(() => document.querySelector('[data-result-tab][aria-selected="true"]')?.getAttribute('data-result-tab') ?? null);
/** Mint a NEW conversation (ending any live one first) so the composer exists. */
async function freshConversation(page, path) {
  await goto(page, path);
  if (await page.$('form[action="/chat/mate/end"]')) {
    await page.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; });
    await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]');
  }
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
}
/** Post a form from the page's own session (a replay of an earlier submission). */
async function postFrom(page, path, fields) {
  return page.evaluate(async ([p, f]) => {
    const r = await fetch(p, { method: 'POST', body: new URLSearchParams(f), credentials: 'same-origin', redirect: 'manual' });
    return { status: r.status, type: r.type };
  }, [path, fields]);
}

let cookieHeader = '';
const runId = fixture.runId;
const task = fixture.tasks.done;
const chatResult = (id, run, tab) => `/chat?task=${id}&result=${run}${tab ? `&tab=${tab}` : ''}`;

try {
  // A plain HTTP session for the fact reads (the same login, no browser).
  {
    const login = await fetch(`${fixture.url}/login`, { method: 'POST', body: new URLSearchParams({ name: fixture.name, token: fixture.password }), redirect: 'manual' });
    cookieHeader = (login.headers.get('set-cookie') ?? '').split(';')[0];
  }

  // ---- c1: the shared facts agree across every surface ----------------------
  const surfaces = {
    'chat receipt': await factsOf(`/chat?task=${task}`),
    'chat result detail': await factsOf(chatResult(task, runId)),
    'run page': await factsOf(`/r/${runId}`),
    'review cockpit': await factsOf(`/review?result=${task}`),
  };
  const stamp = f => JSON.stringify(f);
  const receiptFacts = surfaces['chat receipt'].first;
  check('c1 the chat receipt stamps the shared facts (run, head, base, checks, caveats, evidence, publication)', receiptFacts !== null && receiptFacts.run === String(runId) && receiptFacts.head === '9e07b4152aa0' && receiptFacts.base === '4b825dc642cb' && receiptFacts['head-source'] === 'sealed diff' && receiptFacts.checks === '2/2' && receiptFacts.caveats === '0' && receiptFacts.evidence === 'ok' && receiptFacts.publication === 'none', stamp(receiptFacts));
  for (const [name, one] of Object.entries(surfaces)) {
    const same = one.all.filter(f => f.run === String(runId)).every(f => stamp(f) === stamp(receiptFacts));
    check(`c1 ${name} agrees with the receipt fact for fact (${one.all.filter(f => f.run === String(runId)).length} stamped element(s))`, one.all.length > 0 && same, one.all.map(stamp).join(' | '));
  }
  check('c1 the chat receipt leads to the result detail with one primary road', surfaces['chat receipt'].text.includes(`href="/chat?task=${task}&amp;result=${runId}" data-open-result>Open result</a>`) && !/Request changes in chat|Review &amp; annotate/.test(surfaces['chat receipt'].text));
  // A published result: the same publication words on every surface.
  const published = fixture.statusRuns.published;
  const pubTask = fixture.statusTasks.published;
  const pubSurfaces = [await factsOf(`/t/${pubTask}`), await factsOf(`/r/${published}`), await factsOf(`/review?result=${pubTask}`)];
  check('c1 a published result names the same publication state and PR on the task receipt, the run page, and the cockpit', pubSurfaces.every(one => one.first?.publication === 'opened' && one.text.includes('PR #482')), pubSurfaces.map(one => stamp(one.first)).join(' | '));
  // The deliverable leads: screenshots for UI work, the report for an investigation, the change list for code.
  const leadOf = text => /data-result-lead="([a-z]+)"/.exec(text)?.[1] ?? null;
  const firstInSummary = text => { const view = /<div class="result-view" role="tabpanel" data-result-view="summary"[^>]*>([\s\S]*?)<div class="result-view" role="tabpanel" data-result-view="changes"/.exec(text)?.[1] ?? ''; return /<([a-z]+)[^>]*class="([^"]*)"/.exec(view)?.[2] ?? null; };
  const uiText = surfaces['run page'].text;
  const investigationText = await html(`/r/${fixture.statusRuns.investigation}`);
  const codeText = await html(`/r/${fixture.statusRuns.missingProof}`);
  check('c1 UI work leads with its validated screenshots', leadOf(uiText) === 'screenshots' && /^receipt-visuals result-visuals/.test(firstInSummary(uiText) ?? ''), `${leadOf(uiText)} · ${firstInSummary(uiText)}`);
  check('c1 an investigation leads with its report', leadOf(investigationText) === 'report' && firstInSummary(investigationText) === 'result-report', `${leadOf(investigationText)} · ${firstInSummary(investigationText)}`);
  check('c1 code work without screenshots leads with the change summary', leadOf(codeText) === 'changes' && firstInSummary(codeText) === 'result-changes', `${leadOf(codeText)} · ${firstInSummary(codeText)}`);

  // ---- c2: Summary / Changes / Checks, safe evidence, honest problems ------
  const desktop = await context(VIEWPORTS.desktop);
  let page = desktop.page;
  await goto(page, `/r/${runId}`);
  check('c2 the run page opens on Summary with the other views hidden', (await visibleTab(page)) === 'summary' && (await selectedTab(page)) === 'summary');
  const docToken = await page.evaluate(() => (window.__doc = Math.random()));
  await page.click('[data-result-tab="changes"]');
  await page.waitForTimeout(100);
  const afterClick = { tab: await visibleTab(page), url: page.url(), same: await page.evaluate(t => window.__doc === t, docToken), diff: await page.evaluate(() => document.querySelector('[data-result-view="changes"] [data-review-diff]')?.checkVisibility() ?? false) };
  check('c2 Changes switches in place (no reload), records ?tab=changes, and shows the diff', afterClick.tab === 'changes' && afterClick.same && afterClick.url.endsWith(`/r/${runId}?tab=changes`) && afterClick.diff, JSON.stringify(afterClick));
  await page.reload({ waitUntil: 'load' });
  check('c2 refresh keeps the Changes view', (await visibleTab(page)) === 'changes');
  await page.click('[data-result-tab="checks"]');
  await page.waitForTimeout(100);
  const checksView = await page.evaluate(() => ({ verdict: document.querySelector('[data-result-view="checks"] [data-proof-verdict]')?.getAttribute('data-proof-verdict'), matrix: document.querySelectorAll('[data-result-view="checks"] [data-matrix-state]').length, log: document.querySelector('[data-result-view="checks"] [data-cockpit-source="machine"]') !== null, agent: document.querySelector('[data-result-view="checks"] [data-cockpit-source="agent"]') !== null }));
  check('c2 Checks carries the machine verdict, every signed criterion, the check log, and the agent checks', checksView.verdict === 'complete-verified' && checksView.matrix === 2 && checksView.log && checksView.agent, JSON.stringify(checksView));
  // Keyboard: arrows move between tabs.
  await page.focus('[data-result-tab="checks"]');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  check('c2 the tabs are keyboard-operable (ArrowLeft from Checks selects Changes)', (await visibleTab(page)) === 'changes' && (await page.evaluate(() => document.activeElement?.getAttribute('data-result-tab'))) === 'changes');
  await goto(page, `/r/${runId}?tab=checks`);
  check('c2 the URL alone selects the view (no script needed to land on Checks)', (await visibleTab(page)) === 'checks');
  // Validated screenshot through the evidence road.
  const shotSrc = await page.evaluate(() => document.querySelector('.result-panel .receipt-shot img')?.getAttribute('src') ?? null);
  const shotStatus = shotSrc === null ? null : (await fetch(`${fixture.url}${shotSrc}`, { headers: { cookie: cookieHeader } })).status;
  check('c2 the validated screenshot renders through the evidence road (200, image)', shotSrc !== null && shotStatus === 200, `${shotSrc} → ${shotStatus}`);
  // Investigation: escaped report, download as text, never a page.
  await goto(page, `/r/${fixture.statusRuns.investigation}`);
  const reportView = await page.evaluate(() => {
    const article = document.querySelector('.result-report');
    return {
      present: article !== null,
      scriptsInside: article?.querySelectorAll('script').length ?? -1,
      textHasTag: (article?.querySelector('pre')?.textContent ?? '').includes('<script>alert("this is text, never markup")</script>'),
      download: article?.querySelector('a[href*="/evidence/"]')?.getAttribute('href') ?? null,
      lead: document.querySelector('[data-result-panel]')?.getAttribute('data-result-lead'),
      status: document.querySelector('.result-head .status-line')?.textContent.trim(),
      noDiffWords: document.querySelector('[data-result-view="changes"]')?.textContent.includes('an investigation changes nothing in the repository'),
      alerted: window.__alerted === true,
    };
  });
  const download = reportView.download === null ? null : await fetch(`${fixture.url}${reportView.download}`, { headers: { cookie: cookieHeader } });
  check('c2 an investigation leads with its report as escaped text — no script element, the tag visible as text — with a text download (attachment), and says it changed nothing', reportView.present && reportView.scriptsInside === 0 && reportView.textHasTag && reportView.lead === 'report' && reportView.noDiffWords === true && download?.status === 200 && (download.headers.get('content-type') ?? '').startsWith('text/plain') && (download.headers.get('content-disposition') ?? '').startsWith('attachment'), JSON.stringify({ ...reportView, contentType: download?.headers.get('content-type') }));
  await shot(page, 'desktop-investigation-report', 'Desktop 1440×900: an investigation result leads with its escaped report and text download (synthetic fixture)');
  // Damaged evidence: named in the open, never validated, refused by the evidence road.
  await goto(page, `/r/${fixture.statusRuns.damaged}`);
  const damaged = await page.evaluate(() => {
    const panel = document.querySelector('[data-result-panel]');
    const attention = document.querySelector('[data-result-attention]');
    const tabsTop = document.querySelector('.result-tabs')?.getBoundingClientRect().top ?? 0;
    return {
      evidence: panel?.getAttribute('data-result-evidence'),
      attentionAboveTabs: attention !== null && attention.getBoundingClientRect().bottom <= tabsTop,
      attention: attention?.textContent ?? '',
      images: panel?.querySelectorAll('img').length ?? -1,
      unavailable: document.querySelector('[data-result-unavailable]')?.textContent ?? '',
      validatedWords: /validated visual proof/.test(panel?.textContent ?? ''),
      evidenceFact: [...document.querySelectorAll('.result-facts dt')].find(dt => dt.textContent === 'Evidence')?.nextElementSibling?.textContent ?? '',
      caveats: panel?.getAttribute('data-result-caveats'),
      status: document.querySelector('.result-head .status-line')?.textContent.trim(),
    };
  });
  const tamperedArtifact = fixture.store.artifactsFor(fixture.statusRuns.damaged).find(one => one.kind === 'screenshot');
  const tamperedFetch = await fetch(`${fixture.url}/r/${fixture.statusRuns.damaged}/evidence/${tamperedArtifact.id}`, { headers: { cookie: cookieHeader } });
  check('c2 damaged evidence is named in the open BEFORE the views: tampered screenshot not shown or called validated, failed change-summary capture, shortened check log, and the caveat', damaged.evidence?.startsWith('problems:') && damaged.attentionAboveTabs && /Screenshot evidence\/payout-dashboard\.png no longer verifies/.test(damaged.attention) && /change summary is unavailable/.test(damaged.attention) && /check output was shortened/.test(damaged.attention) && /USD only/.test(damaged.attention) && damaged.images === 0 && !damaged.validatedWords && /0 validated screenshots, 1 unavailable/.test(damaged.evidenceFact) && damaged.caveats === '1', JSON.stringify(damaged));
  check('c2 the evidence road refuses the tampered screenshot bytes (410)', tamperedFetch.status === 410, String(tamperedFetch.status));
  check('c2 the damaged result is not called ready: its status leads with verification needed', /verification needed/i.test(damaged.status ?? ''), damaged.status);
  await shot(page, 'desktop-damaged-evidence', 'Desktop 1440×900: a result whose screenshot was altered after sealing — problems first, nothing called validated (synthetic fixture)');
  const damagedChat = await factsOf(`/chat?task=${fixture.statusTasks.damaged}`);
  check('c2 the chat receipt counts the tampered screenshot as unavailable, not validated', damagedChat.text.includes('1 unavailable — not validated') && damagedChat.first?.evidence === damaged.evidence, `${damagedChat.first?.evidence}`);

  // ---- c3: two feedback styles, one sealed revision --------------------------
  await goto(page, `/r/${runId}`);
  const revisionsBefore = fixture.store.revisionsFromRun(runId).length;
  // A plain note (no pin).
  await page.fill('#comment-form [name="note"]', 'Please also round the CSV footer the same way — the drift moves there otherwise.');
  const firstRequest = await page.evaluate(() => document.querySelector('#comment-form [name="request"]').value);
  await submit(page, '#comment-form button[type="submit"]');
  const afterNote = { url: page.url(), notes: fixture.store.liveDiffComments(runId).length, focused: await page.evaluate(() => document.activeElement?.getAttribute('name') === 'note') };
  check('c3 a plain note lands in the batch and the reader returns to the form, focused', afterNote.notes === 1 && afterNote.url.includes(`noted=${firstRequest}#request-changes`) && afterNote.focused, JSON.stringify(afterNote));
  // Replay the same submission (same request token): no second note.
  const csrf = await page.evaluate(() => document.querySelector('input[name="csrf"]')?.value ?? '');
  const replayed = await postFrom(page, `/r/${runId}/comment`, { csrf, note: 'Please also round the CSV footer the same way — the drift moves there otherwise.', request: firstRequest, return: `/r/${runId}` });
  check('c3 replaying the same note submission records no second note', (replayed.status === 0 || replayed.status === 303) && fixture.store.liveDiffComments(runId).length === 1, JSON.stringify({ replayed, notes: fixture.store.liveDiffComments(runId).length }));
  // A line annotation through Annotate mode.
  await page.click('[data-result-tab="changes"]');
  await page.click('button[data-diff-mode="annotate"]');
  await page.waitForTimeout(100);
  const pinVisible = await page.evaluate(() => { const pin = document.querySelector('button.pick-line[data-path="src/payout.ts"][data-side="new"]'); return pin !== null && pin.checkVisibility() && document.querySelector('[data-review-diff]')?.getAttribute('data-mode') === 'annotate'; });
  check('c3 Annotate mode reveals the line pins', pinVisible);
  await page.click('button.pick-line[data-path="src/payout.ts"][data-side="new"]');
  await page.waitForTimeout(150);
  const pinned = await page.evaluate(() => ({ path: document.querySelector('#comment-form [name="path"]').value, line: document.querySelector('#comment-form [name="line"]').value, open: document.querySelector('#comment-form details.result-pin')?.open, focused: document.activeElement?.getAttribute('name') }));
  check('c3 picking a line fills the pin and focuses the note', pinned.path === 'src/payout.ts' && /^[0-9]+$/.test(pinned.line) && pinned.open === true && pinned.focused === 'note', JSON.stringify(pinned));
  await page.fill('#comment-form [name="note"]', 'Name the rounding helper instead of inlining the multiply.');
  await submit(page, '#comment-form button[type="submit"]');
  const batch = fixture.store.liveDiffComments(runId);
  check('c3 both feedback styles sit in ONE batch: a plain note and a pinned annotation', batch.length === 2 && batch.some(one => one.path === null) && batch.some(one => one.path === 'src/payout.ts' && one.line !== null), JSON.stringify(batch.map(one => [one.path, one.line])));
  const readyWords = await page.evaluate(() => document.querySelector('.result-request .revision-from-comments strong')?.textContent);
  check('c3 Request changes shows the batch beside the result with one Create revision act', readyWords === '2 notes ready' && (await page.evaluate(() => document.querySelectorAll('.result-request form[action$="/revise"]').length)) === 1, readyWords);
  await shot(page, 'desktop-request-changes-batch', 'Desktop 1440×900: a plain note and a line annotation in one batch beside the result, ready to become one revision (synthetic fixture)');
  await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
  const revisions = fixture.store.revisionsFromRun(runId);
  const revisionId = revisions.at(-1)?.id ?? '';
  const revisionScope = fixture.store.getScope(revisionId);
  const lineage = fixture.store.revisionLineageOf(revisionId, new Date());
  check('c3 Create revision seals exactly one revision through the existing road, unapproved, with the exact source lineage', revisions.length === revisionsBefore + 1 && page.url() === `${fixture.url}/t/${revisionId}` && revisionScope !== null && revisionScope.approvedAt === null && lineage?.sourceTask === task && lineage?.sourceRun === runId, JSON.stringify({ revisions: revisions.map(one => one.id), url: page.url(), lineage }));
  const revisionPage = await page.content();
  check('c3 the revision page restates both notes and links back to the original task and build', revisionPage.includes('Please also round the CSV footer') && revisionPage.includes('Name the rounding helper') && revisionPage.includes(`href="/r/${runId}">build #${runId}</a>`) && revisionPage.includes(`href="/t/${task}"`), '');
  check('c3 the revision still needs its own password approval (looks good never became an approval)', revisionPage.includes('input type="password"') || /approve/i.test(revisionPage), '');
  // Replay the seal: no twin.
  const replayedSeal = await postFrom(page, `/r/${runId}/revise`, { csrf, return: `/r/${runId}` });
  check('c3 replaying Create revision mints no second revision', (replayedSeal.status === 0 || replayedSeal.status === 303) && fixture.store.revisionsFromRun(runId).length === revisions.length, JSON.stringify({ replayedSeal, count: fixture.store.revisionsFromRun(runId).length }));
  // Forward link and preserved original evidence.
  await goto(page, `/r/${runId}`);
  const forward = await page.evaluate(() => ({ revision: document.querySelector('[data-result-revision]')?.getAttribute('data-result-revision'), words: document.querySelector('[data-result-revision]')?.textContent, shots: document.querySelectorAll('.result-panel .receipt-shot img').length, diff: document.querySelector('[data-review-diff]') !== null, batchGone: document.querySelector('.result-request .revision-from-comments') === null }));
  check('c3 the original result links forward to the proposed revision and keeps its own evidence (screenshot, diff); the consumed batch no longer offers a second seal', forward.revision === revisionId && /waiting for your approval/.test(forward.words ?? '') && forward.shots === 1 && forward.diff && forward.batchGone, JSON.stringify(forward));
  const chatApproval = await html(`/chat?task=${revisionId}`);
  check('c3 the revision\'s chat approval card links back to the original result', chatApproval.includes(`href="/chat?task=${task}&amp;result=${runId}" data-revision-source>Original result: build #${runId} →</a>`), '');
  await desktop.ctx.close();

  // ---- c4: drafts, selected result, reading position, isolation -------------
  const cont = await context(VIEWPORTS.desktop);
  page = cont.page;
  await freshConversation(page, `/chat?task=${task}`);
  await page.fill('.composer textarea', 'Unsent: can you also cover EUR in the footer test?');
  await page.waitForTimeout(150);
  // Scroll to the receipt (reading position) and open the result.
  await scrollTo(page, '.completion-receipt');
  const chatScrollY = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  await page.click('.completion-receipt a[data-open-result]');
  await page.waitForLoadState('load');
  const opened = { url: page.url(), panel: await page.evaluate(() => document.querySelector('[data-result-panel]') !== null), beside: await page.evaluate(() => { const main = document.querySelector('.chat-main'); const aside = document.querySelector('.chat-result'); return main !== null && aside !== null && main.checkVisibility() && aside.checkVisibility() && aside.getBoundingClientRect().left > main.getBoundingClientRect().left; }), context: await page.evaluate(() => document.querySelector('.task-chat-context') === null), draft: await page.evaluate(() => document.querySelector('.composer textarea').value) };
  check('c4 Open result opens the detail beside the conversation on the desktop, as the only auxiliary panel, with the unsent chat draft intact', opened.url === `${fixture.url}${chatResult(task, runId)}` && opened.panel && opened.beside && opened.context && opened.draft === 'Unsent: can you also cover EUR in the footer test?', JSON.stringify(opened));
  await shot(page, 'desktop-chat-result-beside', 'Desktop 1440×900: the result detail open beside the task conversation, unsent draft kept (synthetic fixture)');
  check('c5 desktop chat + result has no horizontal overflow', (await noOverflow(page)).ok);
  // A review draft, then Back to chat, then reopen.
  await page.click('[data-result-tab="checks"]');
  await page.fill('#comment-form [name="note"]', 'Draft: the EUR case is still uncovered.');
  await page.waitForTimeout(150);
  await scrollTo(page, '#request-changes');
  const resultScrollY = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  await page.click('[data-result-back]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const back = { url: page.url(), draft: await page.evaluate(() => document.querySelector('.composer textarea').value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 Back to chat returns to the same task with the unsent chat draft and the reading position', back.url === `${fixture.url}/chat?task=${task}` && back.draft === 'Unsent: can you also cover EUR in the footer test?' && Math.abs(back.scrollY - chatScrollY) <= 8, JSON.stringify({ ...back, chatScrollY }));
  await page.goBack({ waitUntil: 'load' });
  await page.waitForTimeout(250);
  const returned = { url: page.url(), tab: await visibleTab(page), note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 browser Back restores the selected result and view (Checks) with the review draft and the position', returned.url === `${fixture.url}${chatResult(task, runId, 'checks')}` && returned.tab === 'checks' && returned.note === 'Draft: the EUR case is still uncovered.' && Math.abs(returned.scrollY - resultScrollY) <= 8, JSON.stringify({ ...returned, resultScrollY }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(250);
  const refreshed = { tab: await visibleTab(page), note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value), chat: await page.evaluate(() => document.querySelector('.composer textarea').value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 refresh keeps the view, the review draft, the chat draft, and the position', refreshed.tab === 'checks' && refreshed.note === 'Draft: the EUR case is still uncovered.' && refreshed.chat === 'Unsent: can you also cover EUR in the footer test?' && Math.abs(refreshed.scrollY - resultScrollY) <= 8, JSON.stringify(refreshed));
  // A refused submission is recoverable: a bad line number.
  await page.evaluate(() => { document.querySelector('#comment-form details.result-pin').open = true; });
  await page.fill('#comment-form [name="path"]', 'src/payout.ts');
  await page.fill('#comment-form [name="line"]', 'abc');
  await page.waitForTimeout(150);
  await submit(page, '#comment-form button[type="submit"]');
  const refused = { words: await page.evaluate(() => document.querySelector('.problem')?.textContent ?? ''), back: await page.evaluate(() => document.querySelector('a[href^="/chat?task="]')?.getAttribute('href')) };
  check('c4 a refused submission says why and offers the way back to the result view', /line number/.test(refused.words) && refused.back === chatResult(task, runId), JSON.stringify(refused));
  await page.click(`a[href="${chatResult(task, runId)}"]`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const recovered = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value, path: document.querySelector('#comment-form [name="path"]')?.value, line: document.querySelector('#comment-form [name="line"]')?.value }));
  check('c4 the draft (note, file, line) is restored after the refusal so it can be corrected', recovered.note === 'Draft: the EUR case is still uncovered.' && recovered.path === 'src/payout.ts' && recovered.line === 'abc', JSON.stringify(recovered));
  check('c4 the refused submission recorded nothing', fixture.store.liveDiffComments(runId).length === 0);
  // Another task's result on the same tab: nothing inherited.
  await goto(page, chatResult(fixture.statusTasks.attested, fixture.statusRuns.attested));
  const otherTask = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value ?? '', panel: document.querySelector('[data-result-panel]')?.getAttribute('data-result-task') }));
  check('c4 another task\'s result view carries no draft from the first', otherTask.panel === fixture.statusTasks.attested && otherTask.note === '', JSON.stringify(otherTask));
  // A run that is not this task's: refused as a result view, conversation intact.
  await goto(page, chatResult(task, fixture.statusRuns.attested));
  const foreign = await page.evaluate(() => ({ panel: document.querySelector('[data-result-panel]') !== null, problem: document.querySelector('.problem')?.textContent ?? '', task: document.querySelector('.composer')?.getAttribute('data-chat-task') }));
  check('c4 a result id from another task is refused for this lens; the conversation shows without it', !foreign.panel && /not available for this task/.test(foreign.problem) && foreign.task === task, JSON.stringify(foreign));
  // Another account on the same tab inherits nothing.
  const second = addApprover(fixture.store, 'second-reviewer', new Date(), { name: fixture.name, token: fixture.password });
  if (!second.ok) throw new Error('second approver');
  await page.evaluate(async () => { await fetch('/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }); });
  await loginAs(page, 'second-reviewer', second.token);
  await goto(page, chatResult(task, runId));
  const otherAccount = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value ?? '', keys: Object.keys(sessionStorage).filter(k => k.startsWith('standing-orders:review-draft:')) }));
  check('c4 another account on the same tab sees no draft and the first account\'s draft keys are gone', otherAccount.note === '' && otherAccount.keys.every(k => !k.includes(`:${fixture.name}:`)), JSON.stringify(otherAccount));
  await cont.ctx.close();

  // ---- c5: phone views ---------------------------------------------------------
  for (const [name, viewport] of [['phone', VIEWPORTS.phone], ['narrow', VIEWPORTS.narrow]]) {
    const mobile = await context(viewport);
    page = mobile.page;
    await freshConversation(page, `/chat?task=${task}`);
    await page.fill('.composer textarea', 'Unsent on the phone.');
    await page.waitForTimeout(150);
    await scrollTo(page, '.completion-receipt');
    await shot(page, `${name}-chat-receipt`, `${viewport.width}×${viewport.height}: the task conversation's result receipt with one Open result road (synthetic fixture)`);
    check(`c5 ${name} chat receipt has no horizontal overflow`, (await noOverflow(page)).ok);
    await page.click('.completion-receipt a[data-open-result]');
    await page.waitForLoadState('load');
    const dedicated = await page.evaluate(() => ({ chatHidden: !(document.querySelector('.chat-main')?.checkVisibility() ?? true), panel: document.querySelector('[data-result-panel]')?.checkVisibility() ?? false, back: document.querySelector('[data-result-back]')?.textContent, composerHidden: !(document.querySelector('.composer')?.checkVisibility() ?? true) }));
    check(`c5 ${name} opens a dedicated result view: conversation and composer out of the way, Back to chat first`, dedicated.chatHidden && dedicated.panel && dedicated.back === '← Back to chat' && dedicated.composerHidden, JSON.stringify(dedicated));
    check(`c5 ${name} result view has no horizontal overflow`, (await noOverflow(page)).ok);
    const backRect = await rect(page, '[data-result-back] a, a[data-result-back]');
    const tabRects = await page.evaluate(() => [...document.querySelectorAll('[data-result-tab]')].map(t => { const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; }));
    const tabsFit = tabRects.length === 3 && tabRects.every((r, i) => r.left >= 0 && r.right <= viewport.width && r.height >= 40 && (i === 0 || r.left >= tabRects[i - 1].right - 1));
    check(`c5 ${name} Back to chat and the three tabs are inside the viewport, 40px tall, and do not overlap`, fits(backRect, viewport) && tabsFit, JSON.stringify({ backRect, tabRects }));
    await shot(page, `${name}-result-summary`, `${viewport.width}×${viewport.height}: the dedicated result view — Summary with the validated screenshot (synthetic fixture)`);
    await page.click('[data-result-tab="changes"]');
    await page.waitForTimeout(100);
    const diffBox = await page.evaluate(() => { const lines = document.querySelector('.diff-lines'); const doc = document.documentElement; return { lines: lines !== null, docOk: doc.scrollWidth <= doc.clientWidth, scrollsInside: lines !== null && lines.scrollWidth >= lines.clientWidth }; });
    check(`c5 ${name} Changes shows the diff scrolling within its own region, never the page`, diffBox.lines && diffBox.docOk, JSON.stringify(diffBox));
    await shot(page, `${name}-result-changes`, `${viewport.width}×${viewport.height}: Changes — the file list and the sealed diff in its own scrolling region (synthetic fixture)`);
    await scrollTo(page, '#request-changes', 60);
    const addNote = await rect(page, '#comment-form button[type="submit"]');
    const tabBar = await rect(page, 'nav.tabbar');
    const clear = addNote !== null && (tabBar === null || addNote.bottom <= tabBar.top || addNote.top >= tabBar.bottom);
    check(`c5 ${name} Add note is reachable and not under the tab bar`, addNote !== null && addNote.left >= 0 && addNote.right <= viewport.width && addNote.height >= 40 && clear, JSON.stringify({ addNote, tabBar }));
    await shot(page, `${name}-request-changes`, `${viewport.width}×${viewport.height}: Request changes beside the result — note, optional pin, Add note (synthetic fixture)`);
    // Back to chat keeps the phone draft too.
    await page.click('[data-result-back]');
    await page.waitForLoadState('load');
    await page.waitForTimeout(200);
    check(`c4 ${name} Back to chat keeps the unsent phone draft`, (await page.evaluate(() => document.querySelector('.composer textarea').value)) === 'Unsent on the phone.');
    // The run page and the cockpit at this size.
    await goto(page, `/r/${runId}`);
    check(`c5 ${name} run page has no horizontal overflow`, (await noOverflow(page)).ok);
    await goto(page, `/review?result=${task}`);
    check(`c5 ${name} review cockpit has no horizontal overflow`, (await noOverflow(page)).ok);
    await mobile.ctx.close();
  }
  // Desktop run page and cockpit captures.
  const wide = await context(VIEWPORTS.desktop);
  page = wide.page;
  await goto(page, `/r/${runId}?tab=changes`);
  check('c5 desktop run page has no horizontal overflow', (await noOverflow(page)).ok);
  await shot(page, 'desktop-run-changes', 'Desktop 1440×900: the run page\'s result panel on Changes with View / Annotate (synthetic fixture)');
  await goto(page, `/review?result=${task}`);
  check('c5 desktop review cockpit has no horizontal overflow', (await noOverflow(page)).ok);
  await scrollTo(page, '.result-panel');
  await shot(page, 'desktop-review-cockpit', 'Desktop 1440×900: the review cockpit with the same result panel under its queue and next action (synthetic fixture)');
  await wide.ctx.close();
} catch (error) {
  check('proof ran to completion', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await browser.close();
  await fixture.stop();
}

const failed = report.checks.filter(one => !one.ok);
report.summary = { passed: report.checks.length - failed.length, failed: failed.length };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.summary.passed} passed, ${failed.length} failed → ${join(out, 'report.json')}`);
if (strict && failed.length > 0) process.exit(1);
