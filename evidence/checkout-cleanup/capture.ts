/** Settings → Storage screenshots (checkout cleanup) against a synthetic fixture: a throwaway database, a git
 * repository and task checkouts seeded here (never the live control database), served in-process, captured with
 * Playwright at a desk and on a phone. `node --import tsx evidence/checkout-cleanup/capture.ts`. Playwright is
 * resolved from PLAYWRIGHT_MODULE, then the `playwright` package, then any npx cache under ~/.npm/_npx.
 * Every capture checks there is no horizontal overflow and the Clean up control sits inside the viewport. */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../../src/store.js";
import { register } from "../../src/runner.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer } from "../../src/serve.js";
import { run } from "../../src/exec.js";
import { COMPLETION_ACTION } from "../../src/result-completion.js";
import { WorktreePool } from "../../src/worktree.js";

const out = "evidence/checkout-cleanup";
const fixture = join(out, ".fixture");
rmSync(fixture, { recursive: true, force: true });
const repo = join(process.cwd(), fixture, "shop");
mkdirSync(repo, { recursive: true });
const now = new Date();
const store = openStore(join(fixture, "orders.db"));
register(store, { name: "builder-1", host: "capture", now });
const alex = addApprover(store, "alex", now);
if (!alex.ok) throw new Error("approver");
const git = (args: string[], cwd = repo) => run("git", args, { cwd });
await git(["init", "-q", "-b", "main"]);
await git(["config", "user.email", "capture@example.com"]);
await git(["config", "user.name", "Capture"]);
writeFileSync(join(repo, "README.md"), "# shop\n");
writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
await git(["add", "."]);
await git(["commit", "-qm", "first"]);
const pool = new WorktreePool(store, { root: join(process.cwd(), fixture, "worktrees") });

async function task(id: string, finish: "completed" | "ready" | "cancelled" | "queued", megabytes: number): Promise<string> {
  store.createTask({ id, title: id.replace(/-/g, " ") }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: `toolroll/${id}`, base: "main", runner: "builder-1", taskRef: ref, now });
  if (!leased.ok) throw new Error(leased.message);
  // Installed dependencies: ignored by git, most of a real checkout's size.
  mkdirSync(join(leased.worktree.path, "node_modules"), { recursive: true });
  writeFileSync(join(leased.worktree.path, "node_modules", "deps.bin"), Buffer.alloc(megabytes * 1024 * 1024, 1));
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now });
  store.finishRun(runId, { outcome: "built", now });
  await pool.release(leased.worktree.path, now);
  if (finish !== "queued" && finish !== "cancelled") store.setTaskState(id, "done", now);
  if (finish === "cancelled") store.setTaskState(id, "cancelled", now);
  if (finish === "completed") store.recordAction({ at: now.toISOString(), actor: "alex", repo, taskId: id, runId, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  return leased.worktree.path;
}
await task("fix-login-redirect", "completed", 42);
await task("add-csv-export-to-orders", "completed", 38);
await task("drop-legacy-billing-endpoint", "cancelled", 35);
// Toolroll's own progress note doesn't keep a finished checkout.
const noted = await task("rename-coupon-fields", "completed", 30);
writeFileSync(join(noted, "STANDING-ORDERS-PROGRESS-0123456789abcdef.json"), '{"step":"handoff written"}\n');
await task("tighten-checkout-rate-limits", "ready", 40);
const edited = await task("refactor-search-index", "completed", 36);
writeFileSync(join(edited, "notes-on-ranking.md"), "Try boosting exact SKU matches before fuzzy titles.\n");
await task("upgrade-to-node-22", "queued", 33);

const server = createDecisionServer({ store, evidenceRoot: join(fixture, "evidence"), repo, poolRoot: join(process.cwd(), fixture, "worktrees") });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address !== "object") throw new Error("listen");
const base = `http://127.0.0.1:${address.port}`;

async function loadChromium() {
  const npxCache = join(homedir(), ".npm", "_npx");
  const cached = existsSync(npxCache) ? readdirSync(npxCache).map(one => join(npxCache, one, "node_modules", "playwright", "index.mjs")).filter(one => existsSync(one)).map(one => pathToFileURL(one).href) : [];
  for (const candidate of [process.env["PLAYWRIGHT_MODULE"] && pathToFileURL(process.env["PLAYWRIGHT_MODULE"]).href, "playwright", ...cached].filter(Boolean) as string[]) {
    // The first Playwright whose browser is installed here.
    try { return await (await import(candidate)).chromium.launch(); } catch { /* next */ }
  }
  throw new Error("playwright not found — set PLAYWRIGHT_MODULE");
}
const browser = await loadChromium();
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const report: unknown[] = [];
try {
  for (const capture of [
    { file: "desktop-storage", viewport: DESKTOP, open: false, scheme: "light" },
    // Tall enough that the whole preview, the password and Remove sit on one screen (the sheet scrolls, not the page).
    { file: "desktop-clean-up-preview", viewport: { width: 1440, height: 1600 }, open: true, scheme: "light" },
    { file: "phone-storage", viewport: PHONE, open: false, scheme: "light" },
    { file: "phone-clean-up-preview", viewport: { width: 390, height: 2700 }, open: true, scheme: "dark" },
  ]) {
    const context = await browser.newContext({ viewport: capture.viewport, deviceScaleFactor: 1, colorScheme: capture.scheme });
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', "alex");
    await page.fill('input[name="token"]', alex.token);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    await page.goto(`${base}/settings/storage`, { waitUntil: "load" });
    const summary = page.locator("details.clean-up > summary");
    if (capture.open) await summary.click();
    const box = await summary.boundingBox();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (box === null || box.x < 0 || box.x + box.width > capture.viewport.width) throw new Error(`${capture.file}: Clean up is outside the viewport`);
    if (overflow > 0) throw new Error(`${capture.file}: ${overflow}px horizontal overflow`);
    const text = await page.locator(".storage").innerText();
    await page.screenshot({ path: join(out, `${capture.file}.png`) });
    report.push({ file: `${capture.file}.png`, viewport: capture.viewport, colorScheme: capture.scheme, cleanUpOpen: capture.open, overflow, text: text.split("\n").slice(0, 4) });
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(fixture, { recursive: true, force: true });
}
writeFileSync(join(out, "report.json"), JSON.stringify({ synthetic: true, note: "Synthetic fixture: a throwaway database, repository and seven task checkouts seeded by capture.ts; not the live plane.", captures: report }, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
