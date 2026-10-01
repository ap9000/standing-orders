/** Console v2 before/after screenshots against a synthetic fixture: a throwaway database and evidence folder seeded
 * here (never the live control database), served in-process with a scripted lead (never a model) and no GitHub,
 * captured with Playwright at 1440×900 and 390×844, light and dark. The states are the brief's: a task mid-build,
 * a Ready result with a revision in its thread, and home with three agents working. After the change, phones also
 * capture the task's Details sheet open.
 * Build first (the page assets are the built ones), then
 *   HOME=$(mktemp -d) REAL_HOME=$HOME node --import tsx evidence/console-v2/capture.ts <before|after>
 * Every capture checks for horizontal overflow. */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../../dist/store.js";
import { register } from "../../dist/runner.js";
import { acquire } from "../../dist/claim.js";
import { addApprover, approve, propose } from "../../dist/scope.js";
import { storeEvidence } from "../../dist/evidence.js";
import { sealVerificationReceipt } from "../../dist/verification-evidence.js";
import { createDecisionServer } from "../../dist/serve.js";
import { requestResultChanges } from "../../dist/result-actions.js";
import { revisionSourceOf } from "../../dist/result-review.js";
import { run as exec } from "../../dist/exec.js";
import { verifyApproverByPassword } from "../../dist/principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "../../dist/assignment.js";

const phase = process.argv[2] === "before" ? "before" : "after";
const out = "evidence/console-v2";
const shots = join(out, phase);
const fixture = join(out, ".fixture");
rmSync(fixture, { recursive: true, force: true });
rmSync(shots, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
mkdirSync(shots, { recursive: true });
rmSync("/tmp/toolroll-console-capture", { recursive: true, force: true });
mkdirSync("/tmp/toolroll-console-capture/storefront", { recursive: true });
const REPO = realpathSync("/tmp/toolroll-console-capture/storefront");
await exec("git", ["init", "-q", "-b", "main"], { cwd: REPO });
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const store = openStore(join(fixture, "orders.db"));
const evidenceRoot = join(fixture, "evidence");
for (const name of ["builder-1", "builder-2", "builder-3"]) {
  register(store, { name, host: "capture", capacity: 2, repos: [REPO], now, newToken: () => `tok-${name}` });
}
for (const p of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", p, "claude", "sonnet", "capture", ago(600));
const sam = addApprover(store, "sam", ago(600));
if (!sam.ok) throw new Error("approver");
const password = sam.token;
store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(600));
store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 } as never, "sam", ago(600));
store.recordProviderLimits({ provider: "claude", plan: "max", windows: [
  { window: "five_hour", usedPercent: 38, windowMinutes: 300, resetsAt: new Date(now.getTime() + 140 * 60_000).toISOString(), reached: false },
  { window: "seven_day", usedPercent: 61, windowMinutes: 10_080, resetsAt: new Date(now.getTime() + 3 * 86_400_000).toISOString(), reached: false },
] }, ago(4));

let headCount = 0;
const head = () => (++headCount).toString(16).padStart(2, "0").repeat(20);

function filed(id: string, title: string, goal: string, at: Date, approved = true): number {
  store.createTask({ id, title }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  const proposed = propose(store, { taskId: id, goal, touches: ["src/"], acceptance: [
    { id: "c1", statement: goal, how: null, evidence: ["check"] },
  ], now: at });
  if (approved) {
    const ok = approve(store, id, "sam", at, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
  }
  return ref;
}

/** A finished, passing build of an already-filed task: its diff, check log and sealed machine check. */
function finish(id: string, ref: number, handoff: string, at: Date, diff: string): number {
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: new Date(at.getTime() - 9 * 60_000) });
  const sha = head();
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: sha, handoff });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const goal = store.getScope(id)!.goal;
  store.saveProofVerdict(run, "verified", [], at,
    [{ id: "c1", statement: goal, requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  storeEvidence(store, evidenceRoot, run, "terminal-diff", "diff.patch", Buffer.from(diff), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, evidenceRoot, run, "check-log", "checks.txt", Buffer.from(" Test Files  48 passed (48)\n      Tests  614 passed (614)\n"), "npm test", at, { captureStatus: "ok" });
  sealVerificationReceipt(store, evidenceRoot, run, sha, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, at);
  return run;
}

/** A live build on one builder, at a machine phase. */
function building(id: string, title: string, goal: string, runner: string, filedAt: Date, startedAt: Date, runPhase: "agent-running" | "capturing-evidence" | "validating-handoff"): number {
  const ref = filed(id, title, goal, filedAt);
  const claim = acquire(store, ref, runner, { now: startedAt, token: `tok-${runner}`, ttlMs: 4 * 3_600_000 });
  if (!claim.ok) throw new Error(`claim: ${claim.reason}`);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner, branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: startedAt });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.setRunPhase(run, runPhase, startedAt);
  return run;
}

// 1. Mid-build: three agents are working.
building("order-history-export", "Export order history as CSV", "Customers can download their orders as a CSV file from the account page.", "builder-1", ago(32), ago(14), "agent-running");
building("saved-addresses", "Remember shipping addresses", "Returning customers can pick a saved shipping address at checkout.", "builder-2", ago(50), ago(26), "capturing-evidence");
building("low-stock-alert", "Email the shop when stock runs low", "The shop gets one email when an item drops below five in stock.", "builder-3", ago(20), ago(6), "agent-running");

// 2. A Ready result with a revision: the first build, a change asked for on it, and the revision's build.
const searchRef = filed("search-typo-tolerance", "Let search tolerate one typo", "A search for 'shoos' finds shoes.", ago(240));
const firstRun = finish("search-typo-tolerance", searchRef, "Search now matches terms within one edit.", ago(200),
  "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -3 +3 @@\n-  return exact(terms);\n+  return withinOneEdit(terms);\n");
const revision = requestResultChanges(store, evidenceRoot, {
  run: firstRun, batch: "", source: revisionSourceOf(store.getScope("search-typo-tolerance")!.digest), actor: "sam", repos: [REPO],
  note: "Exact matches should still rank first. Right now 'shoe' shows 'shoes' above 'shoe'.", path: "", line: "", request: "a".repeat(32),
}, ago(150));
if (!revision.ok) throw new Error(`revision: ${revision.message}`);
const revisionScope = store.getScope(revision.id);
if (revisionScope !== null) {
  const ok = approve(store, revision.id, "sam", ago(149), revisionScope.digest, password);
  if (!ok.ok) console.warn(`revision approval: ${ok.reason}`);
}
store.setPlanState(store.refFor("built-in", revision.id).id, null);
finish(revision.id, store.refFor("built-in", revision.id).id, "Exact matches rank first; typo matches follow, ordered by edit distance.", ago(95),
  "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -3 +3,3 @@\n-  return exact(terms);\n+  const hits = withinOneEdit(terms);\n+  return hits.sort(byExactThenDistance);\n");

// 3. The rest of the week: one waits on a person, two finished.
filed("gift-card-balance", "Show gift card balance at checkout", "Checkout shows the remaining gift card balance before payment.", ago(18), false);
const doneRef = filed("faster-product-images", "Serve smaller product images", "Product images load at the size they are shown.", ago(2_000));
finish("faster-product-images", doneRef, "Product images now use responsive sizes.", ago(1_900), "diff --git a/src/img.ts b/src/img.ts\n");
{
  const who = verifyApproverByPassword(store, "sam", password, [REPO]);
  if (!who.ok) throw new Error("who");
  const a = assignmentOf(store, "faster-product-images", ago(1_890), { principal: "operator", repos: [REPO] }, evidenceRoot)!;
  const done = checkAssignmentAsOperator(store, "faster-product-images", a.receipt!.digest, who.who, ago(1_890), evidenceRoot);
  if (!done.ok) throw new Error(`complete: ${done.message}`);
}

const REPLIES = [
  "It's past the export itself and writing the download link on the account page now. Tests for the CSV columns pass; the link test is next.",
  "Yes. Dates use ISO 8601 in UTC, so a spreadsheet sorts them correctly in any time zone.",
  "Exact matches now rank first and typo matches follow by edit distance. Checks passed on the revision, so it's ready for you to review.",
];
let replies = 0;
const server = createDecisionServer({ store, evidenceRoot, repo: REPO, chatEnv: {},
  subscriptionChatRunner: async () => ({ ok: true, answer: { text: REPLIES[Math.min(replies++, REPLIES.length - 1)]!, calls: [], tokensIn: 100, tokensOut: 60, reportedCostMicrousd: null } }) } as never);
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (address === null || typeof address !== "object") throw new Error("listen");
const base = `http://127.0.0.1:${address.port}`;

async function loadPlaywright() {
  const dirs = [join(homedir(), ".npm", "_npx"), join(process.env["REAL_HOME"] ?? "", ".npm", "_npx")].filter(one => existsSync(one));
  const cached = dirs.flatMap(dir => readdirSync(dir).map(one => join(dir, one, "node_modules", "playwright", "index.mjs"))).filter(one => existsSync(one)).map(one => pathToFileURL(one).href);
  for (const candidate of [process.env["PLAYWRIGHT_MODULE"] && pathToFileURL(process.env["PLAYWRIGHT_MODULE"]).href, "playwright", ...cached].filter(Boolean) as string[]) {
    try { const mod = await import(candidate); const browser = await mod.chromium.launch(); return browser; } catch { /* next */ }
  }
  throw new Error("playwright not found — set PLAYWRIGHT_MODULE");
}
const browser = await loadPlaywright();
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

type Page = { goto: (url: string, options?: unknown) => Promise<unknown>; evaluate: <T>(fn: (arg: never) => T, arg?: unknown) => Promise<T>; waitForTimeout: (ms: number) => Promise<void> };
/** One message to a task's lead, through the same /chat road the composer uses; waits for the scripted answer. */
async function say(page: Page, task: string, message: string) {
  await page.goto(`${base}/t/${task}`, { waitUntil: "load" });
  const sent = await page.evaluate(async (arg: never) => {
    const { task, message } = arg as { task: string; message: string };
    const data = JSON.parse(document.getElementById("standing-orders-workspace-data")?.textContent ?? "null");
    const chat = data?.conversation;
    if (!chat) return "no conversation";
    const body = new URLSearchParams({ csrf: data.csrf, message, request: chat.requestId, "request-session": String(chat.sessionId), task });
    const response = await fetch("/chat", { method: "POST", body, headers: { accept: "application/json" } });
    return String(response.status);
  }, { task, message });
  if (sent !== "202") throw new Error(`send to ${task}: ${sent}`);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const done = await page.evaluate(async (arg: never) => {
      const response = await fetch(`/t/${arg as string}?format=workspace`, { headers: { accept: "application/json" } });
      const data = await response.json();
      return data?.conversation?.pendingTurnId === null;
    }, task);
    if (done) return;
  }
  throw new Error(`no answer on ${task}`);
}

const STATES = [
  { key: "building", path: "/t/order-history-export", caption: "A task mid-build, with a question to its agent" },
  { key: "ready-revision", path: "/t/search-typo-tolerance", caption: "A Ready result with a revision in the thread" },
  { key: "home", path: "/chat", caption: "Home with three agents working" },
  { key: "inbox", path: "/inbox?tab=needs-you", caption: "Inbox tabs (after only)" },
] as const;
const report: unknown[] = [];
try {
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme, isMobile: size === "phone", hasTouch: size === "phone" });
      const page = await context.newPage();
      await page.goto(`${base}/login`);
      await page.fill('input[name="name"]', "sam");
      await page.fill('input[name="token"]', password);
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      if (size === "desktop" && scheme === "light") {
        await say(page, "order-history-export", "Where is it now?");
        await say(page, "order-history-export", "Will the dates sort correctly in a spreadsheet?");
        // The composer itself: type, choose a mode, send, and wait for the lead's answer in the thread.
        if (phase === "after") {
          await page.goto(`${base}/t/search-typo-tolerance`, { waitUntil: "load" });
          await page.waitForSelector("#task-message");
          await page.fill("#task-message", "Did the revision fix the ranking?");
          await page.click('[data-mode="answer"]');
          await page.click('[data-task-composer] button[type="submit"]');
          await page.waitForFunction(() => document.querySelectorAll("[data-task-thread] [data-message-id]").length >= 2, undefined, { timeout: 20_000 });
        } else await say(page, "search-typo-tolerance", "Did the revision fix the ranking?");
      }
      for (const state of STATES) {
        if (state.key === "inbox" && phase === "before") continue;
        await page.goto(`${base}${state.path}`, { waitUntil: "load" });
        await page.waitForTimeout(800);
        await page.evaluate(() => { window.scrollTo(0, 0); for (const one of document.querySelectorAll("*")) if (one.scrollTop > 0) one.scrollTop = 0; });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const file = join(shots, `${state.key}-${size}-${scheme}.png`);
        await page.screenshot({ path: file });
        report.push({ file, size, scheme, state: state.key, overflow });
        if (overflow > 0) console.warn(`${file}: ${overflow}px horizontal overflow`);
        // The thread's end, where the composer sits.
        if (state.key !== "home" && state.key !== "inbox") {
          const scrolled = await page.evaluate(() => {
            const thread = document.querySelector("[data-task-thread]") ?? document.querySelector("[data-workspace-chat]");
            if (thread === null) return false;
            thread.scrollIntoView({ block: "end" });
            return true;
          });
          if (scrolled) {
            await page.waitForTimeout(300);
            await page.screenshot({ path: join(shots, `${state.key}-thread-${size}-${scheme}.png`) });
          }
        }
        // Phones: the Details sheet.
        if (size === "phone" && state.key !== "home" && state.key !== "inbox" && phase === "after") {
          const opened = await page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>("[data-open-details]");
            button?.click();
            return button !== null;
          });
          if (opened) {
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(shots, `${state.key}-details-${size}-${scheme}.png`) });
          }
        }
      }
      // A link to a fold in Details (#scope) opens the Details sheet on a phone, with the fold open.
      if (phase === "after") {
        await page.goto(`${base}/t/gift-card-balance#scope`, { waitUntil: "load" });
        await page.waitForTimeout(600);
        const reveal = await page.evaluate(() => {
          const scope = document.getElementById("scope") as HTMLDetailsElement | null;
          const box = scope?.getBoundingClientRect();
          return { view: document.querySelector("[data-workspace-shell]")?.getAttribute("data-workspace-phone-view"), open: scope?.open ?? false, visible: box !== undefined && box.width > 0 && box.height > 0 };
        });
        report.push({ check: "hash-to-details", size, scheme, ...reveal });
        if (!reveal.open || !reveal.visible || (size === "phone" && reveal.view !== "work")) throw new Error(`#scope did not open Details: ${JSON.stringify(reveal)}`);
      }
      await context.close();
    }
  }
  // Sheets: before above after, one per viewport and scheme, once both rows exist.
  if (existsSync(join(out, "before")) && phase === "after") {
    const sheet = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await sheet.newPage();
    const listed = STATES.filter(one => one.key !== "inbox");
    for (const size of ["desktop", "phone"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const cell = size === "desktop" ? 500 : 250;
        const rows = (["before", "after"] as const).map(which => `<h2>${which === "before" ? "Before" : "After"}</h2><div class="row">` +
          listed.map(state => `<figure><img src="${pathToFileURL(resolve(out, which, `${state.key}-${size}-${scheme}.png`)).href}" width="${cell}"><figcaption>${state.caption}</figcaption></figure>`).join("") +
          (size === "phone" && which === "after" ? listed.filter(one => one.key !== "home").map(state => `<figure><img src="${pathToFileURL(resolve(out, which, `${state.key}-details-${size}-${scheme}.png`)).href}" width="${cell}"><figcaption>Details sheet</figcaption></figure>`).join("") : "") +
          `</div>`).join("");
        const html = `<!doctype html><html><head><style>body{margin:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;background:${scheme === "dark" ? "#000" : "#fff"};color:${scheme === "dark" ? "#eee" : "#111"}}h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:16px 0 8px}.row{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}img{display:block;border:1px solid #8884;border-radius:6px}figcaption{margin-top:6px;font-size:13px}</style></head><body><h1>Console v2 · ${size === "desktop" ? "1440×900" : "390×844"} · ${scheme} · synthetic fixture</h1>${rows}</body></html>`;
        const file = join(out, `sheet-${size}-${scheme}.html`);
        writeFileSync(file, html);
        await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: "load" });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(out, `sheet-${size === "desktop" ? 1440 : 390}-${scheme}.png`), fullPage: true });
        rmSync(file);
      }
    }
    await sheet.close();
  }
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(fixture, { recursive: true, force: true });
  rmSync("/tmp/toolroll-console-capture", { recursive: true, force: true });
}
writeFileSync(join(shots, "report.json"), JSON.stringify({ synthetic: true, note: "Synthetic fixture seeded by capture.ts; not the live plane, no model, no GitHub.", captures: report }, null, 1) + "\n");
console.log(report.map(one => JSON.stringify(one)).join("\n"));
