/** Capture the review-retry evidence screenshots against the seeded
 * fixture console: `node evidence/bounded-review-retries/capture.mjs
 * http://127.0.0.1:4996 evidence/bounded-review-retries retry-capture-pass`.
 * Playwright is resolved from PLAYWRIGHT_MODULE, then the `playwright`
 * package if installed, then any npx cache under ~/.npm/_npx — never a
 * path baked in from one machine. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const base = process.argv[2];
const out = process.argv[3];
const password = process.argv[4];
async function loadChromium() {
  const npxCache = join(homedir(), ".npm", "_npx");
  const cached = existsSync(npxCache)
    ? readdirSync(npxCache).map(entry => join(npxCache, entry, "node_modules", "playwright", "index.mjs")).filter(candidate => existsSync(candidate)).map(candidate => pathToFileURL(candidate).href)
    : [];
  const candidates = [process.env.PLAYWRIGHT_MODULE && pathToFileURL(process.env.PLAYWRIGHT_MODULE).href, "playwright", ...cached].filter(Boolean);
  const problems = [];
  for (const candidate of candidates) {
    try {
      return { chromium: (await import(candidate)).chromium, from: candidate };
    } catch (error) {
      problems.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`playwright not found — set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs or install it (npx playwright install chromium)\n${problems.join("\n")}`);
}
const { chromium, from: playwrightFrom } = await loadChromium();
const browser = await chromium.launch();
const report = [];
const captures = [
  { file: "desktop", viewport: { width: 1400, height: 900 }, page: "/t/rate-limit-payouts", state: "retryable" },
  { file: "desktop-cockpit-queued", viewport: { width: 1400, height: 900 }, page: "/review?result=rate-limit-payouts-queued", state: "queued" },
  { file: "desktop-exhausted", viewport: { width: 1400, height: 900 }, page: "/t/rate-limit-payouts-exhausted", state: "exhausted" },
  { file: "mobile", viewport: { width: 390, height: 844 }, page: "/t/rate-limit-payouts", state: "retryable" },
  { file: "mobile-cockpit-queued", viewport: { width: 390, height: 844 }, page: "/review?result=rate-limit-payouts-queued", state: "queued" },
  { file: "mobile-exhausted", viewport: { width: 390, height: 844 }, page: "/t/rate-limit-payouts-exhausted", state: "exhausted" },
];
for (const capture of captures) {
  const context = await browser.newContext({ viewport: capture.viewport, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="name"]', "alex");
  await page.fill('input[name="token"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await page.goto(`${base}${capture.page}`, { waitUntil: "load" });
  const facts = await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    const panel = document.querySelector("[data-review-state]");
    let node = panel;
    while (node) { if (node.tagName === "DETAILS") node.open = true; node = node.parentElement; }
    const rect = panel?.getBoundingClientRect();
    if (rect) window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - 72), behavior: "instant" });
    const button = panel?.querySelector(".review-retry-button");
    const buttonRect = button?.getBoundingClientRect();
    return {
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      state: panel?.getAttribute("data-review-state") ?? null,
      attempts: panel?.getAttribute("data-review-attempts") ?? null,
      remaining: panel?.getAttribute("data-review-remaining") ?? null,
      button: button === null || button === undefined ? null : { text: button.textContent, disabled: button.disabled, width: Math.round(buttonRect.width), height: Math.round(buttonRect.height), right: Math.round(buttonRect.right) },
      form: panel?.querySelector("form.review-retry-form")?.getAttribute("action") ?? null,
      // The sealed patch must resolve from the fixture's evidence root —
      // the page must not say "stored but unverifiable" anywhere.
      patchUnverifiable: document.body.innerText.includes("stored but unverifiable"),
    };
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const panel = document.querySelector("[data-review-state]"); const rect = panel?.getBoundingClientRect(); if (rect) window.scrollTo({ top: rect.top + window.scrollY - 140, behavior: "instant" }); });
  const onScreen = await page.evaluate(() => {
    const panel = document.querySelector("[data-review-state]");
    const rect = panel?.getBoundingClientRect();
    const button = panel?.querySelector(".review-retry-button")?.getBoundingClientRect();
    return { panelTop: rect ? Math.round(rect.top) : null, panelBottom: rect ? Math.round(rect.bottom) : null, buttonBottom: button ? Math.round(button.bottom) : null, innerHeight: window.innerHeight };
  });
  const path = `${out}/${capture.file}.png`;
  await page.screenshot({ path });
  const bytes = readFileSync(path);
  report.push({ file: `${capture.file}.png`, page: capture.page, expectedState: capture.state, viewport: capture.viewport, ...facts, ...onScreen, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  await context.close();
}
await browser.close();
for (const entry of report) {
  if (entry.state !== entry.expectedState) throw new Error(`${entry.file}: expected review state ${entry.expectedState}, saw ${entry.state}`);
  if (entry.scrollWidth > entry.clientWidth) throw new Error(`${entry.file}: horizontal overflow (${entry.scrollWidth} > ${entry.clientWidth})`);
  if (entry.patchUnverifiable) throw new Error(`${entry.file}: the sealed patch did not resolve — serve the fixture with --db so its evidence root is the directory beside it`);
  if (entry.button === null) throw new Error(`${entry.file}: no retry control on the page`);
}
const fixtureBase = process.env.SO_RETRY_CAPTURE_BASE ?? "/tmp/so-retry-capture";
writeFileSync(`${out}/manifest.json`, JSON.stringify({
  evidence: "bounded-review-retries",
  capturedAt: new Date().toISOString(),
  plane: {
    kind: "isolated fixture database seeded by evidence/bounded-review-retries/seed.ts (never the live control database)",
    seed: `node --import tsx evidence/bounded-review-retries/seed.ts ${fixtureBase}`,
    evidenceRoot: `${fixtureBase}/evidence (the console's evidence root is the directory beside --db)`,
    console: `standing-orders serve --db ${fixtureBase}/orders.db --port 4996 --repo ${fixtureBase}/repo`,
    capture: `node evidence/bounded-review-retries/capture.mjs ${base} evidence/bounded-review-retries <password>`,
    playwright: playwrightFrom.replace(homedir(), "~"),
  },
  captures: report,
}, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
