/** Task status before/after screenshots against a synthetic fixture: a throwaway database and evidence folder
 * seeded here (never the live control database), served in-process with a scripted gh (never GitHub), captured
 * with Playwright at 1440×900 and 390×844, light and dark. The states are the brief's (docs/design/task-status.md):
 * the reported case (complete, checks passed, the pull request couldn't open), Ready for review, Building, Needs you
 * (approval), Failed (checks failed), Complete with a merged pull request, and the Tasks list showing the mix.
 * Build first (the page assets are the built ones), then
 *   HOME=$(mktemp -d) REAL_HOME=$HOME node --import tsx evidence/task-status/capture.ts <before|after>
 * Every capture checks for horizontal overflow. Sheets combine the before and after rows once both exist. */
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
import { savePublishing, completeAndOpenPullRequest, followPullRequests } from "../../dist/pull-request-flow.js";
import { verifyApproverByPassword } from "../../dist/principal.js";
import { checkAssignmentAsOperator, assignmentOf } from "../../dist/assignment.js";
import { run as exec } from "../../dist/exec.js";
import type { PublishExec } from "../../dist/publish.js";

const phase = process.argv[2] === "before" ? "before" : "after";
const out = "evidence/task-status";
const shots = join(out, phase);
const fixture = join(out, ".fixture");
rmSync(fixture, { recursive: true, force: true });
rmSync(shots, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
mkdirSync(shots, { recursive: true });
rmSync("/tmp/toolroll-status-capture", { recursive: true, force: true });
mkdirSync("/tmp/toolroll-status-capture/storefront", { recursive: true });
const REPO = realpathSync("/tmp/toolroll-status-capture/storefront");
await exec("git", ["init", "-q", "-b", "main"], { cwd: REPO });
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const store = openStore(join(fixture, "orders.db"));
const evidenceRoot = join(fixture, "evidence");
register(store, { name: "builder-1", host: "capture", capacity: 4, repos: [REPO], now, newToken: () => "tok-builder-1" });
for (const p of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", p, "claude", "sonnet", "capture", ago(300));
const sam = addApprover(store, "sam", ago(300));
if (!sam.ok) throw new Error("approver");
const password = sam.token;
store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(300));
savePublishing(store, { repo: REPO, githubRepo: "sam-shop/storefront", remote: "origin", base: "main", account: "sam" }, "sam", {}, ago(300));
const who = verifyApproverByPassword(store, "sam", password, [REPO]);
if (!who.ok) throw new Error("who");

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

/** A finished build: its diff, check log and sealed machine check (passed or failed). */
function built(id: string, title: string, goal: string, handoff: string, at: Date, exitCode = 0): number {
  const ref = filed(id, title, goal, at);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  const sha = head();
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: sha, handoff });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const failed = exitCode !== 0;
  store.saveProofVerdict(run, failed ? "refuted" : "verified", failed ? [`the repository's approved verification command exited ${exitCode}`] : [], at,
    [{ id: "c1", statement: goal, requiredEvidence: ["check"], state: failed ? "fail" : "pass", detail: [], answered: [], review: null }] as never, failed ? "refuted" : "verified");
  storeEvidence(store, evidenceRoot, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -12 +12 @@\n-  return subtotal + tax + tax;\n+  return subtotal + tax;\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  storeEvidence(store, evidenceRoot, run, "check-log", "checks.txt", Buffer.from(failed
    ? " FAIL  src/cart/coupon.test.ts > applies one coupon per order\n Test Files  1 failed | 47 passed (48)\n      Tests  1 failed | 611 passed (612)\n"
    : " Test Files  48 passed (48)\n      Tests  612 passed (612)\n"), "npm test", at, { captureStatus: "ok" });
  sealVerificationReceipt(store, evidenceRoot, run, sha, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode }, at);
  return run;
}

function completeWithPr(id: string, run: number, at: Date) {
  const a = assignmentOf(store, id, at, { principal: "operator", repos: [REPO] }, evidenceRoot)!;
  const opened = completeAndOpenPullRequest(store, { taskId: id, digest: a.receipt!.digest, runId: run, who: who.ok ? who.who : (null as never), root: evidenceRoot }, at);
  if (!opened.ok) throw new Error(`complete ${id}: ${(opened as { message?: string }).message}`);
  return opened.publication;
}

// 1. The reported case: checks passed, marked complete, the pull request couldn't open.
const reportedRun = built("fix-checkout-tax", "Stop charging tax twice at checkout", "Order totals include tax exactly once.",
  "Removed the second tax addition in the checkout total and added a regression test.", ago(95));
const reportedPub = completeWithPr("fix-checkout-tax", reportedRun, ago(80));
store.recordPublicationError(reportedPub.id, "remote: GH006: Protected branch update failed for refs/heads/toolroll/fix-checkout-tax.", ago(79));
store.failPublication(reportedPub.id, ago(78));

// 2. Ready for review: checks passed, waiting for a person.
built("search-typo-tolerance", "Let search tolerate one typo", "A search for 'shoos' finds shoes.",
  "Search now matches terms within one edit and ranks exact matches first.", ago(40));

// 3. Building: a live claim on the connected builder.
{
  const ref = filed("order-history-export", "Export order history as CSV", "Customers can download their orders as a CSV file.", ago(25));
  const claim = acquire(store, ref, "builder-1", { now: ago(12), token: "tok-builder-1", ttlMs: 4 * 3_600_000 });
  if (!claim.ok) throw new Error(`claim: ${claim.reason}`);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "builder-1", branch: "toolroll/order-history-export", worktree: "/pool/order-history-export", route: authority.stamp, now: ago(12) });
  store.stampRun(run, { scopeDigest: store.getScope("order-history-export")!.digest, baseRevision: "1".repeat(40) });
}

// 4. Needs you: a plan waiting for approval.
filed("gift-card-balance", "Show gift card balance at checkout", "Checkout shows the remaining gift card balance before payment.", ago(18), false);

// 5. Failed: the project's checks failed on the result.
built("coupon-stacking", "Stop coupons stacking on sale items", "Only one coupon applies to an order with sale items.",
  "Coupons are now rejected on orders that already have a sale discount.", ago(60), 1);

// 6. Complete with a merged pull request.
const mergedRun = built("faster-product-images", "Serve smaller product images", "Product images load at the size they are shown.",
  "Product images now use responsive sizes and modern formats.", ago(300));
const mergedPub = completeWithPr("faster-product-images", mergedRun, ago(280));
store.markPublicationPushed(mergedPub.id, ago(279));
store.markPublicationOpened(mergedPub.id, 41, "https://github.com/sam-shop/storefront/pull/41", ago(279));
store.recordPublicationCheckState(mergedPub.id, "passing", ago(270));
store.recordPublicationRemoteState(mergedPub.id, "MERGED", ago(200));
await followPullRequests(store, [{ publication: store.publicationForRun(mergedRun)!, headOid: store.getRun(mergedRun)!.headRevision!, state: "passing", remoteState: "MERGED", rollup: [], mergeCommit: "9d8c7b6a5f4e3d2c1b0a99887766554433221100" } as never],
  { evidenceRoot, clock: () => ago(200) });

// The Tasks list mix also holds a queued task.
filed("wishlist-share-link", "Share a wishlist by link", "A wishlist can be shared with a read-only link.", ago(5));
void checkAssignmentAsOperator;

const publishExec: PublishExec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false });
const server = createDecisionServer({ store, evidenceRoot, repo: REPO, publishExec });
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
export const STATES = [
  { key: "reported", path: "/t/fix-checkout-tax", caption: "Complete, checks passed, pull request couldn't open" },
  { key: "ready", path: "/t/search-typo-tolerance", caption: "Ready for review" },
  { key: "building", path: "/t/order-history-export", caption: "Building" },
  { key: "needs-you", path: "/t/gift-card-balance", caption: "Needs you (approval)" },
  { key: "failed", path: "/t/coupon-stacking", caption: "Failed (checks failed)" },
  { key: "merged", path: "/t/faster-product-images", caption: "Complete with a merged pull request" },
  { key: "tasks", path: "/work", caption: "Tasks list with a mix" },
  { key: "reported-result", path: `/chat?task=fix-checkout-tax&result=${reportedRun}`, caption: "The reported case in the Chat result" },
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
      for (const state of STATES) {
        await page.goto(`${base}${state.path}`, { waitUntil: "load" });
        await page.waitForTimeout(700);
        await page.evaluate(() => { window.scrollTo(0, 0); for (const one of document.querySelectorAll("*")) if (one.scrollTop > 0) one.scrollTop = 0; });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const file = join(shots, `${state.key}-${size}-${scheme}.png`);
        await page.screenshot({ path: file });
        const red = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(one => {
          const style = getComputedStyle(one);
          return (one as HTMLElement).offsetParent !== null && one.children.length === 0 && (one.textContent ?? "").trim() !== "" &&
            /^rgb\((196, 50, 10|255, 151, 125)\)$/.test(style.color);
        }).map(one => (one.textContent ?? "").trim().slice(0, 80)));
        report.push({ file, size, scheme, state: state.key, overflow, redText: red });
        if (overflow > 0) console.warn(`${file}: ${overflow}px horizontal overflow`);
      }
      await context.close();
    }
  }
  // Sheets: before above after, one per viewport and scheme, once both rows exist.
  if (existsSync(join(out, "before")) && existsSync(join(out, "after"))) {
    const sheet = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await sheet.newPage();
    const listed = STATES.filter(one => one.key !== "reported-result");
    for (const size of ["desktop", "phone"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const cell = size === "desktop" ? 460 : 260;
        const rows = (["before", "after"] as const).map(which => `<h2>${which === "before" ? "Before" : "After"}</h2><div class="row">` +
          listed.map(state => `<figure><img src="${pathToFileURL(resolve(out, which, `${state.key}-${size}-${scheme}.png`)).href}" width="${cell}"><figcaption>${state.caption}</figcaption></figure>`).join("") + `</div>`).join("");
        const html = `<!doctype html><html><head><style>body{margin:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;background:${scheme === "dark" ? "#000" : "#fff"};color:${scheme === "dark" ? "#eee" : "#111"}}h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:16px 0 8px}.row{display:grid;grid-template-columns:repeat(${size === "desktop" ? 4 : 7},${cell}px);gap:16px}figure{margin:0}img{display:block;border:1px solid #8884;border-radius:6px}figcaption{margin-top:6px;font-size:13px}</style></head><body><h1>Task status · ${size === "desktop" ? "1440×900" : "390×844"} · ${scheme}</h1>${rows}</body></html>`;
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
  rmSync("/tmp/toolroll-status-capture", { recursive: true, force: true });
}
writeFileSync(join(shots, "report.json"), JSON.stringify({ synthetic: true, note: "Synthetic fixture seeded by capture.ts; not the live plane and not GitHub.", captures: report }, null, 1) + "\n");
console.log(JSON.stringify(report.map(one => { const r = one as { state: string; size: string; scheme: string; overflow: number; redText: string[] }; return `${r.state} ${r.size} ${r.scheme} overflow=${r.overflow} red=${JSON.stringify(r.redText)}`; }), null, 1));
