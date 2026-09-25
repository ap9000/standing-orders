/**
 * The shared world for end-to-end runs: a throwaway Standing Orders — the
 * real CLI, the real console (`serve`) and the real worker loop (`watch`) —
 * against a real git repository, driven through a real browser. Nothing is
 * stubbed; the database is read only as the oracle.
 *
 * A run makes a world, runs named checks (each may need earlier ones), and
 * writes a report: `output/e2e/<name>-<time>/report.md`, with a screenshot of
 * every open page when a check fails. Its workspace is removed when every
 * check passed, unless --keep.
 *
 * Options every run takes: --only <pattern> (just the checks whose names
 * match), --keep, --playwright <index.mjs>, --output <dir>.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
export const flag = name => args.includes(name);
export const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
export const sleep = ms => new Promise(done => setTimeout(done, ms));
export const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); }); });

/** Playwright is not a dependency: --playwright <index.mjs>, else a copy `npx playwright` left in the npm cache whose browser is downloaded, else an installed one. */
export async function loadPlaywright() {
  const given = option("--playwright", null);
  const cache = join(homedir(), ".npm/_npx");
  const cached = existsSync(cache) ? readdirSync(cache).map(one => join(cache, one, "node_modules/playwright/index.mjs")).filter(one => existsSync(one)) : [];
  for (const candidate of given === null ? [...cached, "playwright"] : [given]) {
    const loaded = await import(candidate).catch(() => null);
    if (loaded?.chromium !== undefined && existsSync(loaded.chromium.executablePath())) return loaded;
  }
  throw new Error("Needs Playwright and its browser: npx playwright install chromium, or pass --playwright <path to playwright/index.mjs>");
}

/** A check that can't run here (no Docker, say): skipped with the reason, never passed. */
export class Skip extends Error {}

/**
 * Make the world: a repository with a passing test, two approvers (alex and
 * sam), a registered runner, Claude as every phase, `npm test` as the
 * project's check; the console and the worker started; alex signed in.
 */
export async function world(name, { seed, env = {} } = {}) {
  const BIN = join(here, "dist/bin.js");
  if (!existsSync(BIN)) throw new Error("Build first: npm run build");
  const { chromium } = await loadPlaywright();
  const only = option("--only", null) === null ? null : new RegExp(option("--only", ""), "i");
  const root = realpathSync(mkdtempSync(join(tmpdir(), `so-${name}-e2e-`)));
  const out = resolve(option("--output", join(here, "output/e2e", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
  mkdirSync(out, { recursive: true });
  const repo = join(root, "shop"), state = join(root, "state"), db = join(state, "orders.db");
  mkdirSync(repo); mkdirSync(state);
  const started = Date.now();
  const say = line => { const stamp = `${Math.round((Date.now() - started) / 1000)}s`.padStart(6); console.log(`${stamp}  ${line}`); };

  const cli = (argv, { ok = [0], json = true, env = {} } = {}) => {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...argv, "--db", db, ...(json ? ["--json"] : [])], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
      return json ? JSON.parse(stdout) : stdout;
    } catch (error) {
      if (ok.includes(error.status)) return json ? JSON.parse(error.stdout) : error.stdout;
      throw new Error(`standing-orders ${argv.join(" ")}: ${(error.stdout ?? "") + (error.stderr ?? "")}`.slice(0, 2000));
    }
  };
  const sql = query => execFileSync("sqlite3", ["-json", db, query], { encoding: "utf8" }).trim() || "[]";
  const rows = query => JSON.parse(sql(query));
  async function until(what, test, { timeoutMs = 120_000, everyMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await test(); if (last) return last; } catch (error) { last = error; }
      await sleep(everyMs);
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
  }

  const results = [];
  const failed = new Set();
  const openPages = [];
  async function check(title, needs, body) {
    const at = Date.now();
    if (only !== null && !only.test(title)) { results.push({ name: title, state: "not selected" }); return null; }
    const missing = needs.filter(one => failed.has(one));
    if (missing.length > 0) { results.push({ name: title, state: "skipped", because: missing }); say(`SKIP  ${title} (needs ${missing.join(", ")})`); failed.add(title); return null; }
    say(`...   ${title}`);
    try {
      const detail = await body();
      results.push({ name: title, state: "passed", seconds: Math.round((Date.now() - at) / 100) / 10, ...(detail === undefined ? {} : { detail }) });
      say(`PASS  ${title} (${Math.round((Date.now() - at) / 1000)} s)`);
      return detail ?? true;
    } catch (error) {
      failed.add(title);
      if (error instanceof Skip) { results.push({ name: title, state: "skipped", because: [error.message] }); say(`SKIP  ${title} (${error.message})`); return null; }
      const file = join(out, `${results.length + 1}-failed.png`);
      for (const one of openPages) await one.screenshot({ path: file.replace(".png", `-${openPages.indexOf(one)}.png`) }).catch(() => undefined);
      results.push({ name: title, state: "failed", seconds: Math.round((Date.now() - at) / 100) / 10, error: error instanceof Error ? error.message : String(error) });
      say(`FAIL  ${title}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      return null;
    }
  }

  say(`workspace ${root}`);
  const git = (...rest) => execFileSync("git", ["-C", repo, ...rest], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src/math.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(repo, "test/math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  seed?.(repo);
  git("add", "."); git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "seed");

  const passwords = { alex: `alex-${randomBytes(8).toString("hex")}`, sam: `sam-${randomBytes(8).toString("hex")}` };
  const auth = ["--as", "alex", "--token", passwords.alex];
  cli(["approver", "add", "alex", "--password", passwords.alex]);
  cli(["approver", "add", "sam", "--password", passwords.sam, ...auth]);
  const runner = cli(["runner", "register", "worker", "--repo", repo, ...auth]);
  writeFileSync(join(state, "runner-token"), runner.token, { mode: 0o600 });
  for (const phase of ["plan", "build", "repair", "review"]) cli(["config", "set", phase, "--provider", "claude", "--model", "sonnet", ...auth]);
  cli(["verify", "set", "--repo", repo, "--command", "npm test", "--timeout-seconds", "120", "--yes", ...auth]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = { serve: createWriteStream(join(out, "serve.log")), watch: createWriteStream(join(out, "watch.log")) };
  const children = [];
  process.on("exit", () => { for (const child of children) child.kill("SIGTERM"); });
  process.on("SIGINT", () => process.exit(130));
  const start = (label, argv) => {
    const child = spawn(process.execPath, [BIN, ...argv, "--db", db], { env: { ...process.env, NODE_OPTIONS: "", STANDING_ORDERS_MATE_TRACE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(logs[label]); child.stderr.pipe(logs[label]);
    children.push(child);
    return child;
  };
  start("serve", ["serve", "--repo", repo, "--port", String(port)]);
  start("watch", ["watch", "--runner", "worker", "--token-file", join(state, "runner-token"), "--repo", repo, "--pool", join(root, "worktrees"),
    "--for", String(120 * 60_000), "--tick-every", "2000", "--reconcile-every", "5000", "--bridge-every", "3600000"]);
  await until("the console to answer", async () => (await fetch(`${base}/login`)).ok, { timeoutMs: 30_000, everyMs: 500 });
  say(`console ${base}, worker running`);

  const browser = await chromium.launch();
  const problems = [];
  /** A person at a browser, signed in; everything that goes wrong in their pages is kept. */
  async function signIn(who, viewport = { width: 1440, height: 900 }, colorScheme = "light") {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme });
    const page = await context.newPage();
    const where = () => { try { return new URL(page.url()).pathname; } catch { return page.url(); } };
    page.on("pageerror", error => problems.push(`${who} on ${where()}: ${String(error)}`));
    page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) problems.push(`${who} on ${where()}: ${message.text()}`); });
    await page.goto(`${base}/login`);
    await page.fill('input[name="name"]', who);
    await page.fill('input[name="token"]', passwords[who]);
    await Promise.all([page.waitForNavigation(), page.press('input[name="token"]', "Enter")]);
    openPages.push(page);
    return page;
  }
  const page = await signIn("alex");
  const json = async path => { const response = await page.request.get(`${base}${path}`, { headers: { accept: "application/json" } }); if (!response.ok()) throw new Error(`${path} answered ${response.status()}`); return response.json(); };
  const shot = name => page.screenshot({ path: join(out, `${name}.png`) });

  /** Send the lead a message and wait for its reply; returns the reply element and its text. */
  async function askLead(message, on = page) {
    if (!on.url().endsWith("/chat")) await on.goto(`${base}/chat`);
    await on.waitForSelector("[data-workspace-composer] textarea");
    const before = await on.locator("[data-workspace-chat] [data-message-id]").count();
    await on.fill("[data-workspace-composer] textarea", message);
    await on.click('[data-workspace-composer] button[type="submit"]');
    await until("the lead's reply", async () => (await on.locator("[data-workspace-chat] [data-message-id]").count()) >= before + 2, { timeoutMs: 300_000, everyMs: 2000 });
    await sleep(1000);
    const reply = on.locator("[data-workspace-chat] [data-message-id]").last();
    return { reply, text: (await reply.innerText()).replace(/\s+/g, " ") };
  }
  async function confirmCard(reply, label) {
    const card = reply.locator('[data-view="chat-card"][data-card-state="pending"]').filter({ hasText: label }).first();
    await card.waitFor({ timeout: 10_000 });
    await card.locator("[data-card-confirm]").click();
    await until(`the “${label}” card to be confirmed`, async () => (await reply.locator('[data-view="chat-card"][data-card-state="confirmed"]').filter({ hasText: label }).count()) > 0, { timeoutMs: 30_000 });
    return reply.locator('[data-view="chat-card"][data-card-state="confirmed"]').filter({ hasText: label }).first();
  }

  async function finish(title) {
    await check("No browser errors on any page", [], async () => { if (problems.length > 0) throw new Error(problems.slice(0, 5).join(" | ")); });
    await browser.close();
    for (const child of children) child.kill("SIGTERM");
    await sleep(1500);
    results.splice(0, results.length, ...results.filter(one => one.state !== "not selected"));
    const passed = results.filter(one => one.state === "passed").length, bad = results.filter(one => one.state === "failed").length, skipped = results.filter(one => one.state === "skipped").length;
    const report = { startedAt: new Date(started).toISOString(), minutes: Math.round((Date.now() - started) / 6000) / 10, workspace: root, passed, failed: bad, skipped, results };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(out, "report.md"), [`# ${title} — ${passed} passed, ${bad} failed, ${skipped} skipped (${report.minutes} min)`, "",
      ...results.map(one => `- ${one.state === "passed" ? "✅" : one.state === "failed" ? "❌" : "⏭️"} ${one.name}${one.seconds === undefined ? "" : ` — ${one.seconds} s`}${one.error ? `\n  - ${one.error.split("\n")[0]}` : ""}${one.state === "skipped" ? `\n  - skipped: ${one.because.join(", ")}` : ""}`),
      "", `Workspace: ${root}`, `Logs and screenshots: ${out}`, ""].join("\n"));
    say(`${passed} passed, ${bad} failed, ${skipped} skipped — ${join(out, "report.md")}`);
    if (!flag("--keep") && bad === 0) rmSync(root, { recursive: true, force: true });
    process.exitCode = bad === 0 ? 0 : 1;
  }

  return { root, repo, state, db, out, base, port, passwords, auth, cli, sql, rows, until, check, say, git, browser, signIn, page, json, shot, askLead, confirmCard, problems, openPages, start, finish, bin: BIN };
}

/** A mail server that keeps what it's sent (SMTP, no TLS, no sign-in): the oracle for emails. */
export function mailSink() {
  const received = [];
  const server = createServer(socket => {
    let buffer = "", reading = false, current = { to: [], data: "" };
    socket.write("220 e2e ESMTP\r\n");
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (reading) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end); buffer = buffer.slice(end + 5); reading = false;
          received.push(current); current = { to: [], data: "" }; socket.write("250 queued\r\n"); continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 2);
        if (/^EHLO/i.test(line)) socket.write("250-e2e\r\n250 SIZE 10000000\r\n");
        else if (/^RCPT TO:/i.test(line)) { current.to.push(line.slice(8)); socket.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { reading = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise(done => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port, received })));
}
