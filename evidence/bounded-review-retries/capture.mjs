import { chromium } from "/Users/alekseypelletier/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const base = process.argv[2];
const out = process.argv[3];
const password = process.argv[4];
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
writeFileSync(`${out}/manifest.json`, JSON.stringify({ evidence: "bounded-review-retries", capturedAt: new Date().toISOString(), plane: { kind: "isolated fixture database seeded by /tmp/so-retry-capture/seed.ts (never the live control database)", console: "standing-orders serve --db /tmp/so-retry-capture/orders.db --port 4996 --repo /tmp/so-retry-capture/repo" }, captures: report }, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
