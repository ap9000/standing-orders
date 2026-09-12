/** Capture the exact-run control evidence screenshots (v52 safe task stop
 * and resume) against the seeded fixture console:
 * `node evidence/safe-task-stop-and-resume/capture.mjs http://127.0.0.1:4997
 * evidence/safe-task-stop-and-resume stop-capture-pass`. Playwright is
 * resolved from PLAYWRIGHT_MODULE, then the `playwright` package, then any
 * npx cache under ~/.npm/_npx — never a path baked in from one machine.
 * Every capture proves the control it shows: the expected state, the
 * exact run id, a button fully inside the viewport, and no horizontal
 * overflow — a clipped control fails the capture. */
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
const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 844 };
const captures = [
  { file: "desktop-stop", viewport: DESKTOP, page: "/t/rate-limit-payouts-live", state: "stop" },
  { file: "desktop-stopping", viewport: DESKTOP, page: "/t/rate-limit-payouts-stopping", state: "stopping" },
  { file: "desktop-paused", viewport: DESKTOP, page: "/t/rate-limit-payouts-paused", state: "paused" },
  { file: "desktop-chat-paused", viewport: DESKTOP, page: "/chat?task=rate-limit-payouts-paused", state: "paused" },
  { file: "phone-stopping", viewport: PHONE, page: "/t/rate-limit-payouts-stopping", state: "stopping" },
  { file: "phone-paused", viewport: PHONE, page: "/t/rate-limit-payouts-paused", state: "paused" },
  { file: "phone-chat-stopping", viewport: PHONE, page: "/chat?task=rate-limit-payouts-stopping", state: "stopping" },
  { file: "desktop-resume-ceremony", viewport: DESKTOP, page: "/t/rate-limit-payouts-paused", state: "paused", arm: true },
];
for (const capture of captures) {
  const context = await browser.newContext({ viewport: capture.viewport, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="name"]', "alex");
  await page.fill('input[name="token"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await page.goto(`${base}${capture.page}`, { waitUntil: "load" });
  if (capture.arm === true) {
    // The resume ceremony: the Resume button's own POST, never a GET.
    await Promise.all([page.waitForNavigation(), page.click("#task-control form.task-resume-form button[type=submit]")]);
  }
  const facts = await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    const panel = document.getElementById("task-control") ?? document.querySelector("form.resume-form");
    let node = panel;
    while (node) { if (node.tagName === "DETAILS") node.open = true; node = node.parentElement; }
    const rect = panel?.getBoundingClientRect();
    if (rect) window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - 140), behavior: "instant" });
    return { title: document.title, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  await page.waitForTimeout(300);
  const onScreen = await page.evaluate(() => {
    const control = document.getElementById("task-control");
    const ceremony = document.querySelector("form.resume-form");
    const panel = control ?? ceremony;
    const rect = panel?.getBoundingClientRect();
    const button = panel?.querySelector("button");
    const buttonRect = button?.getBoundingClientRect();
    return {
      state: control?.getAttribute("data-task-control") ?? (ceremony ? "resume-ceremony" : null),
      run: control?.getAttribute("data-control-run") ?? (ceremony?.querySelector('input[name="run"]')?.getAttribute("value") ?? null),
      panelTop: rect ? Math.round(rect.top) : null,
      panelBottom: rect ? Math.round(rect.bottom) : null,
      panelRight: rect ? Math.round(rect.right) : null,
      button: button === null || button === undefined ? null : { text: button.textContent, disabled: button.disabled, top: Math.round(buttonRect.top), bottom: Math.round(buttonRect.bottom), left: Math.round(buttonRect.left), right: Math.round(buttonRect.right), width: Math.round(buttonRect.width), height: Math.round(buttonRect.height) },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      saysStopped: /\bStopped\b/.test(control?.textContent ?? ""),
    };
  });
  const path = `${out}/${capture.file}.png`;
  await page.screenshot({ path });
  const bytes = readFileSync(path);
  report.push({ file: `${capture.file}.png`, page: capture.page, expectedState: capture.arm === true ? "resume-ceremony" : capture.state, viewport: capture.viewport, ...facts, ...onScreen, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  await context.close();
}
await browser.close();
for (const entry of report) {
  if (entry.state !== entry.expectedState) throw new Error(`${entry.file}: expected control state ${entry.expectedState}, saw ${entry.state}`);
  if (entry.scrollWidth > entry.clientWidth) throw new Error(`${entry.file}: horizontal overflow (${entry.scrollWidth} > ${entry.clientWidth})`);
  if (entry.button === null) throw new Error(`${entry.file}: no control button on the page`);
  if (entry.button.left < 0 || entry.button.right > entry.innerWidth || entry.button.top < 0 || entry.button.bottom > entry.innerHeight) throw new Error(`${entry.file}: the control's button is clipped by the viewport (${JSON.stringify(entry.button)})`);
  if (entry.panelRight > entry.innerWidth) throw new Error(`${entry.file}: the control panel overflows the viewport`);
  if (entry.saysStopped) throw new Error(`${entry.file}: the control says "Stopped" — only Stop, Stopping…, and Paused/Resume are honest words`);
  if (entry.expectedState === "stopping" && entry.button.disabled !== true) throw new Error(`${entry.file}: Stopping… must be a disabled control`);
}
const fixtureBase = process.env.SO_STOP_CAPTURE_BASE ?? "/tmp/so-stop-capture";
writeFileSync(`${out}/manifest.json`, JSON.stringify({
  evidence: "safe-task-stop-and-resume",
  capturedAt: new Date().toISOString(),
  plane: {
    kind: "isolated fixture database seeded by evidence/safe-task-stop-and-resume/seed.ts (never the live control database)",
    seed: `node --import tsx evidence/safe-task-stop-and-resume/seed.ts ${fixtureBase}`,
    console: `standing-orders serve --db ${fixtureBase}/orders.db --port 4997 --repo ${fixtureBase}/repo`,
    capture: `node evidence/safe-task-stop-and-resume/capture.mjs ${base} evidence/safe-task-stop-and-resume <password>`,
    playwright: playwrightFrom.replace(homedir(), "~"),
  },
  captures: report,
}, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
