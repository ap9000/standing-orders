/** Complete → pull request → merge screenshots against a synthetic fixture: a throwaway database and evidence
 * folder seeded here (never the live control database), served in-process with a scripted git and gh (never
 * GitHub), captured with Playwright at a desk (1440×900) and on a phone (390×844). The journey is driven through
 * the real pages: Complete and open a pull request from the result, the task's pull-request card as CI reports,
 * Merge refused without the password, then Merge with it. Every capture checks for horizontal overflow and that
 * the primary control sits inside the viewport.
 * Build first (the page assets are the built ones), then `HOME=$(mktemp -d) node --import tsx evidence/complete-pr/capture.ts` (HOME only keeps provider files out of it). */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../../dist/store.js";
import { register } from "../../dist/runner.js";
import { addApprover, approve, propose } from "../../dist/scope.js";
import { storeEvidence } from "../../dist/evidence.js";
import { sealVerificationReceipt } from "../../dist/verification-evidence.js";
import { createDecisionServer } from "../../dist/serve.js";
import { savePublishing } from "../../dist/pull-request-flow.js";
import { run as exec } from "../../dist/exec.js";
import type { PublishExec } from "../../dist/publish.js";

const out = "evidence/complete-pr";
const fixture = join(out, ".fixture");
rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
rmSync("/tmp/toolroll-capture", { recursive: true, force: true });
mkdirSync("/tmp/toolroll-capture/storefront", { recursive: true });
const REPO = realpathSync("/tmp/toolroll-capture/storefront");
const HEAD = "4f1c2e9a7b3d5e6f8091a2b3c4d5e6f708192a3b";
const MERGE = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
mkdirSync(REPO, { recursive: true });
await exec("git", ["init", "-q", "-b", "main"], { cwd: REPO });
const now = new Date();
const store = openStore(join(fixture, "orders.db"));
const evidenceRoot = join(fixture, "evidence");
register(store, { name: "builder-1", host: "capture", capacity: 2, repos: [REPO], now, newToken: () => "tok-builder-1" });
for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "capture", now);
const sam = addApprover(store, "sam", now);
if (!sam.ok) throw new Error("approver");
store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, now);

/** A finished, checked result: Ready, waiting for a person. */
function ready(id: string, title: string, goal: string, handoff: string): number {
  store.createTask({ id, title }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, now);
  const proposed = propose(store, { taskId: id, goal, touches: ["src/checkout/"], acceptance: [{ id: "c1", statement: "Order totals include tax exactly once.", how: null, evidence: ["check"] }], now });
  const approved = approve(store, id, "sam", now, proposed.digest, sam.ok ? sam.token : "");
  if (!approved.ok) throw new Error(approved.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: HEAD, handoff });
  store.finishRun(run, { outcome: "built", committed: true, now });
  store.setTaskState(id, "done", now);
  store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", statement: "Order totals include tax exactly once.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  storeEvidence(store, evidenceRoot, run, "terminal-diff", "diff.patch", Buffer.from("diff --git a/src/checkout/total.ts b/src/checkout/total.ts\n--- a/src/checkout/total.ts\n+++ b/src/checkout/total.ts\n@@ -12 +12 @@\n-  return subtotal + tax + tax;\n+  return subtotal + tax;\n"), "git diff (exit 0)", now, { captureStatus: "ok" });
  storeEvidence(store, evidenceRoot, run, "check-log", "checks.txt", Buffer.from("Test Files  48 passed (48)\n     Tests  612 passed (612)\n"), "npm test", now, { captureStatus: "ok" });
  sealVerificationReceipt(store, evidenceRoot, run, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
  return run;
}
const run = ready("fix-checkout-tax", "Stop charging tax twice at checkout", "Order totals include tax exactly once.", "Removed the second tax addition in the checkout total and added a regression test.");
savePublishing(store, { repo: REPO, githubRepo: "sam-shop/storefront", remote: "origin", base: "main", account: "sam" }, "sam", {}, now);

// The scripted GitHub: one pull request whose checks pass on the accepted commit, merged when asked.
let merged = false;
const calls: string[] = [];
const publishExec: PublishExec = async (file, args) => {
  const key = [file, ...args].join(" ");
  calls.push(key);
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  if (key.startsWith("gh pr merge")) { merged = true; return ok; }
  if (key.startsWith("gh pr view")) {
    return { ...ok, stdout: JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: HEAD,
      statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }],
      mergeCommit: merged ? { oid: MERGE } : null }) };
  }
  if (key.startsWith("git remote get-url")) return { ...ok, stdout: "git@github.com:sam-shop/storefront.git\n" };
  if (key.startsWith("gh repo view")) return { ...ok, stdout: JSON.stringify({ nameWithOwner: "sam-shop/storefront", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }) };
  if (key.startsWith("gh api user")) return { ...ok, stdout: "sam\n" };
  return ok;
};

const server = createDecisionServer({ store, evidenceRoot, repo: REPO, publishExec });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address !== "object") throw new Error("listen");
const base = `http://127.0.0.1:${address.port}`;

async function loadChromium() {
  const npxCache = join(homedir(), ".npm", "_npx");
  const realCache = join(process.env["REAL_HOME"] ?? "", ".npm", "_npx");
  const cached = [npxCache, realCache].filter(one => existsSync(one)).flatMap(dir => readdirSync(dir).map(one => join(dir, one, "node_modules", "playwright", "index.mjs"))).filter(one => existsSync(one)).map(one => pathToFileURL(one).href);
  for (const candidate of [process.env["PLAYWRIGHT_MODULE"] && pathToFileURL(process.env["PLAYWRIGHT_MODULE"]).href, "playwright", ...cached].filter(Boolean) as string[]) {
    try { return await (await import(candidate)).chromium.launch(); } catch { /* next */ }
  }
  throw new Error("playwright not found — set PLAYWRIGHT_MODULE");
}
const browser = await loadChromium();
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const report: unknown[] = [];

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof browser.newContext>>["newPage"]>>;
async function signedIn(viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="name"]', "sam");
  await page.fill('input[name="token"]', sam.ok ? sam.token : "");
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return page;
}
/** A fresh load (never a same-document hash jump), settled. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(400);
}
async function shoot(page: Page, file: string, viewport: { width: number; height: number }, primary: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(600); // let the page's entry transition settle
  const control = page.locator(primary).first();
  try { await control.waitFor({ timeout: 5000 }); } catch (error) { await page.screenshot({ path: join(out, `debug-${file}.png`), fullPage: true }); throw error; }
  // From the top (title and status in view); scroll only as far as the control needs.
  await page.evaluate(() => { window.scrollTo(0, 0); for (const one of document.querySelectorAll("*")) if (one.scrollTop > 0) one.scrollTop = 0; });
  let box = await control.boundingBox();
  if (box !== null && box.y + box.height > viewport.height) {
    await control.evaluate(node => node.scrollIntoView({ block: "end" }));
    box = await control.boundingBox();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (box === null || box.x < 0 || box.x + box.width > viewport.width) throw new Error(`${file}: ${primary} is outside the viewport`);
  if (overflow > 0) throw new Error(`${file}: ${overflow}px horizontal overflow`);
  await page.screenshot({ path: join(out, `${file}.png`), fullPage });
  report.push({ file: `${file}.png`, viewport, primary, box: { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height) }, overflow });
}

try {
  // 1. The result: Complete and open a pull request beside Complete only (desktop).
  const desk = await signedIn(DESKTOP);
  await open(desk, `/chat?task=fix-checkout-tax&result=${run}`);
  await shoot(desk, "desktop-complete-choice", DESKTOP, 'button[name="publish"][value="1"]');
  await Promise.all([desk.waitForNavigation(), desk.locator('button[name="publish"][value="1"]').first().click()]);

  // The watch process pushed the exact commit and opened PR #41; CI then reported green on that commit.
  const publication = store.publicationForRun(run)!;
  store.markPublicationPushed(publication.id, new Date());
  store.markPublicationOpened(publication.id, 41, "https://github.com/sam-shop/storefront/pull/41", new Date());
  store.recordPublicationCheckState(publication.id, "running", new Date());
  await open(desk, `/t/fix-checkout-tax`);
  await shoot(desk, "desktop-checks-running", DESKTOP, '[data-pull-request="running"]');
  store.recordPublicationCheckState(publication.id, "passing", new Date());
  await open(desk, `/t/fix-checkout-tax`);
  await shoot(desk, "desktop-ready-to-merge", DESKTOP, "[data-merge-form] button");

  // 2. Phone: Ready to merge, then Merge without the password is refused, then with it.
  const phone = await signedIn(PHONE);
  await open(phone, `/t/fix-checkout-tax`);
  await shoot(phone, "phone-ready-to-merge", PHONE, "[data-merge-form] button");
  await phone.locator("[data-merge-form] input[name=token]").evaluate(input => input.removeAttribute("required"));
  await Promise.all([phone.waitForNavigation(), phone.locator("[data-merge-form] button").click()]);
  const refusedText = await phone.locator("body").innerText();
  if (!refusedText.includes("Enter your password to merge.") || calls.some(one => one.startsWith("gh pr merge"))) throw new Error("merge without a password was not refused");
  await shoot(phone, "phone-merge-needs-password", PHONE, "[data-merge-form] button");
  await phone.fill("[data-merge-form] input[name=token]", sam.ok ? sam.token : "");
  await Promise.all([phone.waitForNavigation(), phone.locator("[data-merge-form] button").click()]);
  await shoot(phone, "phone-merged", PHONE, '[data-pull-request="merged"]');
  await open(desk, `/t/fix-checkout-tax`);
  await shoot(desk, "desktop-merged", DESKTOP, '[data-pull-request="merged"]');

  // 3. Settings → Projects → Pull requests, as a second project would see it before turning on.
  store.revokePublicationGrant(REPO, "sam", new Date());
  await open(desk, `/settings/pull-requests?repo=${encodeURIComponent(REPO)}`);
  await shoot(desk, "desktop-settings-turn-on", DESKTOP, ".pr-settings button");
  await open(phone, `/settings/pull-requests?repo=${encodeURIComponent(REPO)}`);
  await shoot(phone, "phone-settings-turn-on", PHONE, ".pr-settings button");
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(fixture, { recursive: true, force: true });
  rmSync("/tmp/toolroll-capture", { recursive: true, force: true });
}
writeFileSync(join(out, "report.json"), JSON.stringify({ synthetic: true, note: "Synthetic fixture: a throwaway database and a scripted git/gh seeded by capture.ts; not the live plane and not GitHub.", merges: calls.filter(one => one.startsWith("gh pr merge")), captures: report }, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
