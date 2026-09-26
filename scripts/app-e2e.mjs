#!/usr/bin/env node
/**
 * Standing Orders, end to end: every main feature a person uses, through
 * the real console, the real worker and real Claude, in a throwaway world
 * (scripts/e2e-kit.mjs). Flows have their own run (scripts/flows-e2e.mjs);
 * this one covers the rest, and the newer flow features on top.
 *
 *   npm run e2e:app      (or: node scripts/app-e2e.mjs [--only <pattern>] [--keep] [--skip-build])
 *
 * Needs: a built dist/, `claude` logged in, git, npm, sqlite3; Docker for the
 * real mail server (the email inbox check is skipped without it); python3
 * for the Python script. Spends a few Claude turns and real builds.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { flag, mailSink, Skip, sleep, world } from "./e2e-kit.mjs";

const skipBuild = flag("--skip-build");

// The real mail server for the email inbox: GreenMail in Docker, over TLS on 127.0.0.1:993 with a
// certificate made for this run (the console and worker trust it, and only it, beside the usual ones).
const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; } })();
let mailCert = null;
const certDir = join(process.env.TMPDIR ?? "/tmp", `so-e2e-mail-${randomBytes(4).toString("hex")}`);
if (docker) {
  mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  execFileSync("openssl", ["pkcs12", "-export", "-in", join(certDir, "cert.pem"), "-inkey", join(certDir, "key.pem"), "-out", join(certDir, "keystore.p12"), "-passout", "pass:e2e-keystore", "-name", "greenmail"], { stdio: "ignore" });
  mailCert = join(certDir, "cert.pem");
}

const w = await world("app", {
  env: mailCert === null ? {} : { NODE_EXTRA_CA_CERTS: mailCert },
  seed: repo => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "size.py"), "import json, sys\ncard = json.load(sys.stdin)['card']\nprint(f\"{card['title']} looks {'big' if 'Acme' in card['title'] else 'small'}\")\nprint('goto: Big' if 'Acme' in card['title'] else 'goto: Small')\n");
    writeFileSync(join(repo, "README.md"), "# Shop\n\nA tiny shop library. `add` lives in src/math.js.\n");
  },
});
const { base, page, cli, rows, until, check, shot, json, signIn, askLead, confirmCard, auth, repo } = w;
const flowView = id => json(`/flows/${id}?format=json`);
const csrfOf = async on => on.locator('input[name="csrf"]').first().inputValue();
const post = async (path, form, on = page) => {
  const answer = await on.request.post(`${base}${path}`, { form: { csrf: await csrfOf(on), ...form }, headers: { accept: "application/json", origin: base }, maxRedirects: 0 });
  return { status: answer.status(), body: await answer.text() };
};
/** A flow drawn from steps the way the canvas saves one. */
async function newFlow(name, stages, start) {
  await page.goto(`${base}/flows`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await page.fill('form[action="/flows/new"] input[name="name"]', name);
  await page.selectOption('form[action="/flows/new"] select[name="template"]', "blank");
  await Promise.all([page.waitForNavigation(), page.click('form[action="/flows/new"] button')]);
  const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
  const view = await flowView(id);
  const saved = await post(`/flows/${id}/save`, { name, owner: "alex", revision: String(view.flow.revision), definition: JSON.stringify({ version: 1, start, stages }) });
  if (saved.status !== 200) throw new Error(`the drawing wasn't saved: ${saved.body}`);
  await page.goto(`${base}/flows/${id}`); await page.waitForSelector("[data-zone]");
  return id;
}
const zone = (x, y = 0) => ({ x, y, w: 260, h: 300, color: "blue" });
const none = { instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null };
async function addCard(title, details) {
  await page.click('button:has-text("New card")');
  await page.fill('input[aria-label="Title"]', title);
  if (details) await page.fill('textarea[aria-label="Details"]', details);
  await page.click('button:has-text("Add card")');
}

// ------------------------------------------------------------------ the console itself

await check("A wrong password is refused, and a signed-out visitor is sent to sign in", [], async () => {
  const wrong = await w.browser.newContext();
  const stranger = await wrong.newPage();
  await stranger.goto(`${base}/login`);
  await stranger.fill('input[name="name"]', "alex"); await stranger.fill('input[name="token"]', "not-the-password");
  await Promise.all([stranger.waitForLoadState("load"), stranger.press('input[name="token"]', "Enter")]);
  if (!stranger.url().includes("/login")) throw new Error(`a wrong password got in: ${stranger.url()}`);
  const text = (await stranger.locator("body").innerText()).toLowerCase();
  if (!/password|sign in|didn't|not/.test(text)) throw new Error(`no refusal shown: ${text.slice(0, 200)}`);
  const locked = await stranger.request.get(`${base}/flows`, { maxRedirects: 0 });
  if (locked.status() !== 303 && locked.status() !== 302 && locked.status() !== 401) throw new Error(`a signed-out visitor got ${locked.status()} for /flows`);
  await wrong.close();
});

await check("Every main page opens without an error, on desktop and on a phone", [], async () => {
  const paths = ["/chat", "/work", "/tasks", "/tasks/new", "/projects", "/flows", `/settings/knowledge?repo=${encodeURIComponent(repo)}`, "/settings", "/settings/models", "/settings/skills", `/settings/tools?repo=${encodeURIComponent(repo)}`, "/routines", "/recipes"];
  const broken = [];
  const phone = await signIn("sam", { width: 390, height: 844 }, "dark");
  for (const path of paths) {
    for (const [who, on] of [["desktop", page], ["phone", phone]]) {
      const answer = await on.goto(`${base}${path}`);
      if (answer === null || answer.status() >= 400) { broken.push(`${who} ${path}: ${answer?.status()}`); continue; }
      // Live pages keep a stream open, so the network never goes quiet: let the page settle instead.
      await on.waitForLoadState("load"); await sleep(700);
      // No page scrolls sideways on a phone.
      if (who === "phone") {
        const wide = await on.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (wide > 2) broken.push(`phone ${path}: scrolls sideways by ${wide}px`);
      }
    }
  }
  await phone.context().close();
  w.openPages.splice(w.openPages.indexOf(phone), 1);
  if (broken.length > 0) throw new Error(broken.join("; "));
  return { pages: paths.length * 2 };
});

await check("The command line answers: the task list, the approvers, the project's check, and help", [], async () => {
  const list = cli(["task", "list"]);
  const people = cli(["approver", "list"]);
  const verify = cli(["verify", "show", "--repo", repo], { json: false });
  const help = execFileSync(process.execPath, [w.bin, "--help"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  if (list === null || typeof list !== "object") throw new Error("task list didn't answer as JSON");
  if (!JSON.stringify(people).includes("sam")) throw new Error(`the approvers: ${JSON.stringify(people).slice(0, 200)}`);
  if (!/npm test/.test(verify)) throw new Error(`the project's check: ${verify.slice(0, 200)}`);
  if (!/task/.test(help)) throw new Error("help doesn't mention tasks");
});

// ------------------------------------------------------------------ a task, from an idea to an accepted result

const refOf = id => rows(`SELECT id, plan FROM task_ref WHERE external_id = '${id}'`)[0];
const latestBuild = id => rows(`SELECT r.id, r.outcome, r.finished_at FROM run r JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND r.role = 'builder' ORDER BY r.id DESC LIMIT 1`)[0];
const taskState = id => rows(`SELECT state FROM task WHERE id = '${id}'`)[0]?.state;
/** Approve a task's scope on its page: open the plan, type the password again, approve. */
async function approveOnPage(id) {
  await page.goto(`${base}/t/${id}`);
  const review = page.locator("summary", { hasText: /Review plan|Updated approval terms/ }).first();
  if (await review.count() > 0) await review.click();
  const form = page.locator("form#approve");
  await form.waitFor({ timeout: 15_000 });
  await form.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), form.locator("button").first().click()]);
  const approved = rows(`SELECT approved_by FROM task_scope WHERE task_id = '${id}'`)[0];
  if (approved?.approved_by !== "alex") throw new Error(`${id} wasn't approved: ${(await page.locator("body").innerText()).slice(0, 300)}`);
}
/** Wait for a task's build to finish with its checks passed; returns the run. */
async function builtAndChecked(id, timeoutMs = 600_000) {
  const run = await until(`${id} to be built`, async () => { const one = latestBuild(id); return one?.finished_at ? one : null; }, { timeoutMs, everyMs: 5000 });
  if (run.outcome !== "built") throw new Error(`${id}'s build ended ${run.outcome}`);
  await until(`${id} to be done`, async () => taskState(id) === "done", { timeoutMs: 180_000, everyMs: 3000 });
  return run;
}

let firstTask = null;
await check("File a task in the console; the planner (Claude) drafts its scope; approve it with your password", [], async () => {
  await page.goto(`${base}/chat`);
  await page.click("a.so-new-task");
  await page.waitForSelector('form[action="/tasks/add"]');
  // Just the words, as a person types them; "plan first" (on by default) has the planner write the scope.
  await page.fill('form[action="/tasks/add"] textarea[name="title"]', "Add a subtract function to src/math.js, with a test");
  await Promise.all([page.waitForNavigation(), page.click('form[action="/tasks/add"] button.task-submit')]);
  firstTask = /\/t\/([^/?#]+)/.exec(page.url())?.[1];
  if (!firstTask) throw new Error(`filing didn't open the task: ${page.url()}`);
  const planned = await until("the planner's scope", async () => { const ref = refOf(firstTask); return ref?.plan === "drafted" && rows(`SELECT 1 FROM task_scope WHERE task_id = '${firstTask}'`).length > 0 ? ref : null; }, { timeoutMs: 420_000, everyMs: 5000 });
  const scope = rows(`SELECT goal FROM task_scope WHERE task_id = '${firstTask}'`)[0];
  if (!/subtract/i.test(scope.goal)) throw new Error(`the planner's goal: ${scope.goal}`);
  await approveOnPage(firstTask);
  await shot("task-approved");
  return { task: firstTask, plan: planned.plan, goal: scope.goal.slice(0, 160) };
});

await check("Claude builds it, the project's checks pass, and the result shows what changed; mark it complete", ["File a task in the console; the planner (Claude) drafts its scope; approve it with your password"], async () => {
  const run = await builtAndChecked(firstTask);
  const diff = execFileSync("git", ["-C", repo, "diff", "main", `refs/heads/${rows(`SELECT branch FROM run WHERE id = ${run.id}`)[0].branch}`, "--", "src/math.js"], { encoding: "utf8" });
  if (!/subtract/.test(diff)) throw new Error(`the build's branch doesn't add subtract: ${diff.slice(0, 300)}`);
  await page.goto(`${base}/review?result=${encodeURIComponent(firstTask)}&run=${run.id}&project=${encodeURIComponent(repo)}`);
  const panel = page.locator("[data-result-panel]").first();
  await panel.waitFor({ timeout: 20_000 });
  // What a person sees: "Checks passed" on the result, and the saved check exited 0.
  const status = await page.locator("[data-result-status]").first().innerText();
  if (!/Checks passed/.test(status)) throw new Error(`the result says: ${status.slice(0, 200)}`);
  const checks = "passed";
  await page.locator('a[data-result-tab="changes"]').click();
  await until("the changed files", async () => /src\/math\.js/.test(await page.locator("body").innerText()), { timeoutMs: 10_000, everyMs: 500 });
  await shot("result-changes");
  await Promise.all([page.waitForNavigation(), page.locator(`form[action="/t/${firstTask}/complete"] button`).click()]);
  await until("the result to read complete", async () => (await page.locator('[data-result-status="assignment-complete"]').count()) > 0, { timeoutMs: 15_000, everyMs: 500 });
  const ledger = rows(`SELECT action, source FROM action_ledger WHERE task_id = '${firstTask}' AND action = 'assignment handoff checked'`);
  if (ledger.length !== 1) throw new Error(`the ledger has ${ledger.length} completion rows`);
  return { run: run.id, checks };
});

/** On a result page, send the work back with a note; returns the new revision's id once the planner has updated its plan. */
async function sendBack(id, note) {
  const run = latestBuild(id);
  await page.goto(`${base}/review?result=${encodeURIComponent(id)}&run=${run.id}&project=${encodeURIComponent(repo)}`);
  await page.locator('a[href="#request-changes"]').first().click();
  const box = page.locator('#comment-form textarea[name="note"]');
  await box.waitFor({ timeout: 10_000 });
  await box.fill(note);
  await Promise.all([page.waitForNavigation(), page.locator("button[data-request-changes]").click()]);
  const child = new URL(page.url()).searchParams.get("version") ?? rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.revision_of IS NOT NULL ORDER BY t.id DESC LIMIT 1`)[0]?.id;
  if (!child || child === id) throw new Error(`no revision was made: ${page.url()}`);
  if (refOf(child)?.plan !== "requested" && refOf(child)?.plan !== "drafted") throw new Error(`the revision wasn't sent to the planner: plan ${refOf(child)?.plan}`);
  if (!/Updating the plan/.test(await page.locator("body").innerText())) throw new Error("the task page doesn't say the plan is being updated");
  await until("the planner's updated plan", async () => refOf(child)?.plan === "drafted", { timeoutMs: 420_000, everyMs: 5000 });
  return child;
}
const branchFile = (runId, file) => execFileSync("git", ["-C", repo, "show", `refs/heads/${rows(`SELECT branch FROM run WHERE id = ${runId}`)[0].branch}:${file}`], { encoding: "utf8" });

await check("Send it back with a note: the revision is approved again and rebuilt with the fix", ["Claude builds it, the project's checks pass, and the result shows what changed; mark it complete"], async () => {
  const revision = await sendBack(firstTask, "The subtract test should also check a negative result: subtract(2, 5) is -3.");
  await approveOnPage(revision);
  const built = await builtAndChecked(revision);
  const test = branchFile(built.id, "test/math.test.js");
  if (!/-3/.test(test)) throw new Error(`the revision's test doesn't check -3: ${test.slice(0, 400)}`);
  return { revision, run: built.id };
});

await check("Send it back asking for more than the plan allows: the planner adds it, you approve the change, and it's built", ["Send it back with a note: the revision is approved again and rebuilt with the fix"], async () => {
  const done = rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.revision_of = '${firstTask}' ORDER BY t.id DESC LIMIT 1`)[0]?.id;
  const child = await sendBack(done, "Also add multiply(a, b), with its own test.");
  const scope = rows(`SELECT goal, acceptance_json FROM task_scope WHERE task_id = '${child}'`)[0];
  if (!/multiply/i.test(`${scope.goal}\n${scope.acceptance_json}`)) throw new Error(`the updated plan leaves multiply out: ${scope.goal.slice(0, 300)}`);
  // What a person reviews: the change to the plan and why, on desktop and on a phone.
  await page.goto(`${base}/t/${child}`);
  const review = page.locator("summary", { hasText: /Review plan|Updated approval terms/ }).first();
  if (await review.count() > 0) await review.click();
  const amended = page.locator("#contract-amendment");
  await amended.waitFor({ timeout: 15_000 });
  const reason = await amended.innerText();
  await amended.scrollIntoViewIfNeeded();
  await shot("plan-amended");
  const phone = await signIn("alex", { width: 390, height: 844 }, "dark");
  await phone.goto(`${base}/t/${child}`);
  const phoneReview = phone.locator("summary", { hasText: /Review plan|Updated approval terms/ }).first();
  if (await phoneReview.count() > 0) await phoneReview.click();
  await phone.locator("#contract-amendment").scrollIntoViewIfNeeded();
  await phone.screenshot({ path: join(w.out, "plan-amended-phone.png") });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await phone.context().close();
  if (wide) throw new Error("the phone page scrolls sideways");
  await approveOnPage(child);
  const built = await builtAndChecked(child);
  const source = branchFile(built.id, "src/math.js");
  if (!/multiply/.test(source) || !/subtract/.test(source)) throw new Error(`the build doesn't keep subtract and add multiply: ${source.slice(0, 300)}`);
  return { revision: child, change: reason.replace(/\s+/g, " ").slice(0, 240), run: built.id };
});

await check("A build stops to ask a question the plan leaves open; you answer on the decision page and it carries on", [], async () => {
  const id = "round";
  cli(["task", "add", "Add a round2 function", "--id", id, "--repo", repo, ...auth]);
  cli(["task", "scope", id, "--goal", "Add round2(x) to src/math.js (round to 2 decimal places) with a test in test/math.test.js. Whether an exact half rounds up or to the nearest even digit is the operator's call and is not decided yet: before writing any code, stop and ask the operator with two options (half up, half to even), then build what they choose.", "--acceptance", "round2 follows the operator's answer, with a test|check", ...auth]);
  const digest = cli(["task", "show", id]).scope.digest;
  cli(["task", "approve", id, "--yes", "--digest", digest, ...auth]);
  const asked = await until("the builder's question", async () => rows(`SELECT d.id, d.question, d.run FROM decision d JOIN run r ON r.id = d.run JOIN task_ref t ON t.id = r.task_ref WHERE t.external_id = '${id}' AND d.state = 'open'`)[0], { timeoutMs: 600_000, everyMs: 5000 });
  await page.goto(`${base}/d/${asked.id}`);
  const options = page.locator(`form.option[action="/d/${asked.id}/answer"]`);
  await options.first().waitFor({ timeout: 15_000 });
  const labels = await options.locator('button[type="submit"]').allInnerTexts();
  const pick = labels.findIndex(one => /even/i.test(one));
  if (pick < 0) throw new Error(`no half-to-even option: ${labels.join(" | ")}`);
  await shot("decision");
  await Promise.all([page.waitForNavigation(), options.nth(pick).locator('button[type="submit"]').click()]);
  const answered = rows(`SELECT state, answered_by, answered_via FROM decision WHERE id = ${asked.id}`)[0];
  if (answered?.state !== "answered" || answered.answered_by !== "alex" || answered.answered_via !== "web") throw new Error(`the answer wasn't recorded: ${JSON.stringify(answered)}`);
  // The answer admits a fresh build; the parked one stays in the history.
  await until("the build after the answer", async () => (latestBuild(id)?.id ?? 0) > asked.run, { timeoutMs: 180_000, everyMs: 3000 });
  const built = await builtAndChecked(id);
  const source = branchFile(built.id, "src/math.js");
  if (!/round2/.test(source)) throw new Error(`the build doesn't add round2: ${source.slice(0, 300)}`);
  return { question: asked.question.slice(0, 160), answer: labels[pick].trim(), run: built.id };
});

await check("Stop a build while it runs, then resume it with your password; it finishes", [], async () => {
  const id = "divide";
  cli(["task", "add", "Add a divide function", "--id", id, "--repo", repo, ...auth]);
  cli(["task", "scope", id, "--goal", "Add divide(a, b) to src/math.js, throwing on division by zero, with tests for both in test/math.test.js.", "--acceptance", "divide works and refuses zero|check", ...auth]);
  const digest = cli(["task", "show", id]).scope.digest;
  cli(["task", "approve", id, "--yes", "--digest", digest, ...auth]);
  const running = await until("the build to start", async () => { const one = latestBuild(id); return one && !one.finished_at ? one : null; }, { timeoutMs: 180_000, everyMs: 1000 });
  await page.goto(`${base}/t/${id}`);
  const stop = page.locator("form.task-stop-form button");
  await stop.waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForNavigation(), stop.click()]);
  await until("the task to be paused", async () => { await page.reload(); return (await page.locator('[data-task-control="paused"]').count()) > 0; }, { timeoutMs: 180_000, everyMs: 3000 });
  const stopped = rows(`SELECT requested_via, settlement FROM run_stop WHERE run = ${running.id}`)[0];
  if (stopped?.requested_via !== "web") throw new Error(`the stop: ${JSON.stringify(stopped)}`);
  await shot("task-paused");
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await Promise.all([page.waitForNavigation(), page.locator("form.task-resume-form button").click()]);
  const confirm = page.locator("form.resume-form");
  await confirm.waitFor({ timeout: 15_000 });
  await confirm.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), confirm.locator("button").first().click()]);
  const resumed = rows(`SELECT resumed_by, resumed_via FROM run_stop WHERE run = ${running.id}`)[0];
  if (resumed?.resumed_by !== "alex") throw new Error(`the resume: ${JSON.stringify(resumed)}`);
  const built = await builtAndChecked(id);
  return { stopped: running.id, finished: built.id, settlement: stopped.settlement };
});

// ------------------------------------------------------------------ the lead

await check("Turn the lead chat on (first-run setup, with your password)", [], async () => {
  await page.goto(`${base}/chat`);
  await page.selectOption('form[action="/chat/config"] select[name="provider"]', "claude-subscription");
  await page.fill('form[action="/chat/config"] input[name="model"]', "sonnet");
  await page.fill('form[action="/chat/config"] input[name="token"]', w.passwords.alex);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/chat/config"] button[type="submit"]')]);
  await page.goto(`${base}/chat`);
  await page.waitForSelector("[data-workspace-composer] textarea", { timeout: 15_000 });
});

await check("The lead answers a question about the project from its files (real Claude turn)", ["Turn the lead chat on (first-run setup, with your password)"], async () => {
  const { text } = await askLead("What does src/math.js export? One line.");
  if (!/add/i.test(text)) throw new Error(`the answer doesn't mention add: ${text.slice(0, 300)}`);
  return { answer: text.slice(0, 200) };
});

await check("The lead files a task from plain words, as a card you confirm (real Claude turn)", ["The lead answers a question about the project from its files (real Claude turn)"], async () => {
  const { reply } = await askLead("File a task in this project to add a short usage section about add() to README.md. Just file it, no need to ask.");
  const card = reply.locator('[data-view="chat-card"][data-card-kind="task"][data-card-state="pending"]').first();
  await card.waitFor({ timeout: 20_000 });
  await card.locator("[data-card-confirm]").click();
  await until("the task card to be confirmed", async () => (await reply.locator('[data-view="chat-card"][data-card-kind="task"][data-card-state="confirmed"]').count()) > 0, { timeoutMs: 30_000 });
  const filed = rows("SELECT external_id AS id FROM task_ref WHERE filed_via = 'mate' ORDER BY id DESC LIMIT 1")[0];
  if (!filed) throw new Error("no task was filed from chat");
  return { task: filed.id };
});

// ------------------------------------------------------------------ projects, knowledge, skills, tools, models

await check("The lead draws a follow-up flow from plain words: it emails, waits for a reply, and nudges when none comes (real Claude turn)", ["The lead answers a question about the project from its files (real Claude turn)"], async () => {
  const before = rows("SELECT COALESCE(MAX(id), 0) AS id FROM flow")[0].id;
  const { reply } = await askLead("Make a flow called Quote follow-up in this project: email the customer our quote, wait 3 days for them to reply, and if they don't, send them a short reminder. Replies go to a holding step called Replied. Just draft it, no need to ask.");
  const card = reply.locator('[data-view="chat-card"][data-card-state="pending"]').first();
  await card.waitFor({ timeout: 30_000 });
  await card.locator("[data-card-confirm]").click();
  const flow = await until("the flow", async () => rows(`SELECT id, definition_json FROM flow WHERE id > ${before} ORDER BY id DESC LIMIT 1`)[0], { timeoutMs: 30_000 });
  const stages = JSON.parse(flow.definition_json).stages;
  const wait = stages.find(one => one.kind === "wait");
  if (wait === undefined || wait.wait?.for !== "reply" || wait.wait.minutes !== 3 * 24 * 60) throw new Error(`the wait step: ${JSON.stringify(wait ?? stages.map(one => one.kind))}`);
  const nudge = stages.find(one => one.id === wait.onFail);
  if (nudge?.kind !== "email") throw new Error(`with no reply it goes to: ${JSON.stringify(nudge)}`);
  if (stages.find(one => one.id === wait.next)?.kind !== "inbox") throw new Error(`a reply goes to: ${wait.next}`);
  return { steps: stages.map(one => `${one.title} (${one.kind})`).join(" → ") };
});

await check("Projects: the project is listed and opens", [], async () => {
  await page.goto(`${base}/projects`);
  const row = page.locator(`li[data-project="${repo}"]`);
  await row.waitFor({ timeout: 10_000 });
  // The project a person works in reads "Open now"; any other has an Open button.
  if (!/Open now/.test(await row.innerText())) await Promise.all([page.waitForNavigation(), row.locator('form[action="/projects/open"] button').click()]);
  await page.goto(`${base}/projects`);
  if (!/Open now/.test(await page.locator(`li[data-project="${repo}"]`).innerText())) throw new Error("the project isn't the open one");
});

await check("Knowledge: instructions saved for a project are kept for future tasks", [], async () => {
  await page.goto(`${base}/settings/knowledge?repo=${encodeURIComponent(repo)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await page.fill('textarea[name="instructions"]', "Use plain ES modules. Every function gets a test.");
  await Promise.all([page.waitForNavigation(), page.click('button:has-text("Save instructions")')]);
  const said = await page.locator('p[role="status"]').first().innerText().catch(() => "");
  if (!/Saved for future tasks/.test(said)) throw new Error(`saving said: ${said}`);
  if (!/Every function gets a test/.test(await page.locator("body").innerText())) throw new Error("the instructions aren't shown back");
});

await check("Skills: a pasted skill joins the library and can be turned on", [], async () => {
  await page.goto(`${base}/settings/skills?repo=${encodeURIComponent(repo)}`);
  await page.getByText("Add skill", { exact: true }).first().click();
  const form = page.locator("form[data-skill-import]");
  await form.waitFor({ timeout: 10_000 });
  await form.locator('select[name="method"]').selectOption("paste").catch(() => undefined);
  await form.locator('textarea[name="content"]').fill("---\nname: small-commits\ndescription: Keep each commit small and focused on one change.\n---\n\n# Small commits\n\nMake one small commit per change, with a clear message.\n");
  await Promise.all([page.waitForNavigation(), form.locator("button").first().click()]);
  const skill = page.locator("article[id^='skill-']").first();
  await skill.waitFor({ timeout: 10_000 });
  if (!/In library/.test(await skill.innerText())) throw new Error(`the skill reads: ${(await skill.innerText()).slice(0, 200)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  await Promise.all([page.waitForNavigation(), page.locator('form[action="/settings/skills/change"] button:has-text("Enable skill")').first().click()]);
  if (!/Enabled/.test(await page.locator("article[id^='skill-']").first().innerText())) throw new Error("the skill didn't turn on");
});

await check("Tools: a project's own MCP tool is added (with your password) and tested", [], async () => {
  const echo = join(w.root, "echo-mcp.mjs");
  writeFileSync(echo, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "say", inputSchema: { type: "object" } }] });
});
`);
  await page.goto(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`);
  await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
  const custom = page.locator('form:has(input[name="target"])').first();
  await custom.locator('input[name="name"]').fill("echo");
  await custom.locator('select[name="transport"]').selectOption("stdio");
  await custom.locator('input[name="target"]').fill(`${process.execPath} ${echo}`);
  await custom.locator('input[name="password"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), custom.locator("button").last().click()]);
  const added = await page.locator('p[role="status"], p.problem').first().innerText().catch(() => "");
  if (!/Added/.test(added)) throw new Error(`adding said: ${added}`);
  await Promise.all([page.waitForNavigation(), page.locator('#tool-echo form button:has-text("Test")').click()]);
  const tested = await page.locator('p[role="status"], p.problem').first().innerText().catch(() => "");
  if (!/echo works: 1 tool/.test(tested)) throw new Error(`testing said: ${tested}`);
});

await check("Models: Check now reads the live model lists", [], async () => {
  await page.goto(`${base}/settings/models`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/models/check"] button')]);
  const said = await page.locator('p[role="status"]').first().innerText().catch(() => "");
  if (!/^Checked\./.test(said)) throw new Error(`checking said: ${said}`);
  return { said };
});

// ------------------------------------------------------------------ routines, settings, search, signing out

await check("Routines: a standing order is filed, approved with your password, and run now files its task", [], async () => {
  await page.goto(`${base}/routines`);
  const form = page.locator('form[action="/routines/add"]');
  await form.waitFor({ timeout: 10_000 });
  await form.locator('input[name="name"]').fill("weekly-deps");
  await form.locator('textarea[name="goal"]').fill("Check the project's dependencies and report any that are out of date.");
  await form.locator('textarea[name="acceptance"]').fill("A short report lists outdated dependencies | manual-review");
  await form.locator('select[name="repeat"]').selectOption("weekly").catch(() => undefined);
  await Promise.all([page.waitForNavigation(), form.locator("button").last().click()]);
  const approve = page.locator('form[action$="/approve"]').first();
  await approve.waitFor({ timeout: 10_000 });
  await approve.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), approve.locator("button").first().click()]);
  const routine = rows("SELECT id, approved_at FROM routine WHERE name = 'weekly-deps'")[0];
  if (!routine?.approved_at) throw new Error(`the routine wasn't approved: ${(await page.locator("body").innerText()).slice(0, 300)}`);
  const now = page.locator('form[action$="/run-now"]').first();
  await now.locator('input[name="token"]').fill(w.passwords.alex);
  await Promise.all([page.waitForNavigation(), now.locator("button").first().click()]);
  const fired = await until("the routine's task", async () => rows(`SELECT t.external_id AS id FROM task_ref t WHERE t.routine_id = ${routine.id}`)[0], { timeoutMs: 60_000, everyMs: 2000 });
  return { routine: routine.id, task: fired.id };
});

await check("Settings: the theme switches to dark and stays", [], async () => {
  await page.goto(`${base}/settings`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/appearance"] button[value="dark"]')]);
  await page.goto(`${base}/chat`);
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark") throw new Error("the theme didn't stay dark");
  await page.goto(`${base}/settings`);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/settings/appearance"] button[value="system"]')]);
});

await check("Search finds the project and a task", [], async () => {
  // Search is left off pages that show a password field; Flows has none.
  await page.goto(`${base}/flows`);
  await page.click("button.so-command-trigger");
  const box = page.locator('[data-workspace-command] input[type="search"]');
  await box.waitFor({ timeout: 5000 });
  await box.fill("shop");
  await until("a result", async () => (await page.locator(".so-command-results li a").count()) > 0, { timeoutMs: 5000, everyMs: 300 });
  await page.keyboard.press("Escape");
});

// ------------------------------------------------------------------ code in flows

let codeFlow = null;
await check("Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret", [], async () => {
  codeFlow = await newFlow("Leads", [
    { ...none, id: "size", title: "Size it up", kind: "check", script: "size", runIn: "folder", routes: [{ answer: "Big", to: "call" }, { answer: "Small", to: "note" }], zone: zone(0), next: null, onFail: "inbox" },
    { ...none, id: "call", title: "Call them", kind: "inbox", zone: zone(360), next: null, onFail: null },
    { ...none, id: "note", title: "Write it down", kind: "check", script: "note", runIn: "folder", secrets: ["CRM_KEY"], zone: zone(360, 380), next: "done", onFail: "inbox" },
    { ...none, id: "inbox", title: "Inbox", kind: "inbox", zone: zone(0, 380), next: null, onFail: null },
    { ...none, id: "done", title: "Done", kind: "done", zone: zone(720, 380), next: null, onFail: null },
  ], "size");
  // The two scripts, made on the Scripts panel: a Python file already in the project, and a Node script written there.
  const saveScript = async ({ name, about, language, file, body }) => {
    await page.click("[data-open-scripts]");
    // With no scripts yet the panel opens on a new one; otherwise "New script" does.
    if (!(await page.locator("[data-script-form]").isVisible())) await page.click('[data-flow-scripts] button:has-text("New script")');
    const form = page.locator("[data-script-form]");
    await form.locator("label").filter({ hasText: /^Name/ }).locator("input").fill(name);
    await form.locator("label").filter({ hasText: "What it checks or does" }).locator("input").fill(about);
    await form.locator('select[aria-label="Language"]').selectOption(language);
    if (file !== undefined) {
      await form.locator('select[aria-label="Runs"]').selectOption("file");
      await form.locator("label").filter({ hasText: /^File/ }).locator("input").fill(file);
    } else {
      await form.locator('select[aria-label="Runs"]').selectOption("here");
      await form.locator("label").filter({ hasText: /^Script/ }).locator("textarea").fill(body);
    }
    await form.locator('button:has-text("Save script")').click();
    await until(`the ${name} script to be saved`, async () => (await flowView(codeFlow)).scripts.some(one => one.name === name), { timeoutMs: 15_000, everyMs: 500 });
  };
  await saveScript({ name: "size", about: "Sizes up a lead", language: "python", file: "scripts/size.py" });
  await saveScript({ name: "note", about: "Writes the lead down", language: "node", body: "import { readFileSync } from 'node:fs';\nconst { card, outputs } = JSON.parse(readFileSync(0, 'utf8'));\nconsole.log(`Noted ${card.title} (${outputs.size.text}) with ${process.env.CRM_KEY}`);" });
  // A card before the secret is saved: it waits, saying which.
  await addCard("Bakery down the road", "Two people");
  const waiting = await until("the card to wait for its secret", async () => (await flowView(codeFlow)).cards.find(one => one.title === "Bakery down the road" && one.stage === "note" && /CRM_KEY/.test(one.waiting ?? "")), { timeoutMs: 90_000, everyMs: 2000 });
  // The secret, saved on the zone's Secrets box (a value made now, never written out).
  const secret = `crm-${randomBytes(8).toString("hex")}`;
  const kept = await post(`/flows/${codeFlow}/secrets`, { name: "CRM_KEY", value: secret });
  if (kept.status !== 200) throw new Error(`the secret wasn't saved: ${kept.body}`);
  const small = await until("the small lead to be written down", async () => (await flowView(codeFlow)).cards.find(one => one.title === "Bakery down the road" && one.state === "done"), { timeoutMs: 90_000, everyMs: 2000 });
  // Text that would do something if it were ever part of a command.
  const marker = join(w.root, "pwned");
  await addCard(`Acme wants a demo $(touch ${marker})`, null);
  const big = await until("the big lead to reach Call them", async () => (await flowView(codeFlow)).cards.find(one => one.title.startsWith("Acme") && one.stage === "call"), { timeoutMs: 90_000, everyMs: 2000 });
  const problems = [];
  const said = id => small.outputs.find(one => one.stage === id)?.text ?? "";
  if (said("size") !== "Bakery down the road looks small") problems.push(`size printed ${said("size")}`);
  if (said("note") !== "Noted Bakery down the road (Bakery down the road looks small) with [secret]") problems.push(`note printed ${said("note")}`);
  if (big.outputs.find(one => one.stage === "size")?.text !== `Acme wants a demo $(touch ${marker}) looks big`) problems.push("the big lead's size wasn't passed on");
  if (existsSync(marker)) problems.push("card text ran as a command");
  const logs = rows(`SELECT log FROM flow_step_run r JOIN flow_card c ON c.id = r.card WHERE c.flow = ${codeFlow}`).map(one => one.log ?? "").join("\n");
  if (logs.includes(secret) || JSON.stringify(await flowView(codeFlow)).includes(secret)) problems.push("the secret reached a log or the page");
  if (problems.length > 0) throw new Error(problems.join("; "));
  await page.reload(); await page.waitForSelector("[data-zone]");
  await shot("code-steps");
  return { waited: waiting.waiting, small: said("note"), big: big.stage };
});

await check("A schedule runs a script and makes a card of each item it prints, once (Run now)", ["Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret"], async () => {
  await page.click("[data-open-scripts]");
  if (!(await page.locator("[data-script-form]").isVisible())) await page.click('[data-flow-scripts] button:has-text("New script")');
  const form = page.locator("[data-script-form]");
  await form.locator("label").filter({ hasText: /^Name/ }).locator("input").fill("new-leads");
  await form.locator("label").filter({ hasText: "What it checks or does" }).locator("input").fill("Lists new leads");
  await form.locator('select[aria-label="Language"]').selectOption("python");
  await form.locator("label").filter({ hasText: /^Script/ }).locator("textarea").fill("import json\nfor n in (1, 2):\n    print(json.dumps({'title': f'Lead {n} from the CRM', 'key': n}))");
  await form.locator('button:has-text("Save script")').click();
  await until("the new-leads script", async () => (await flowView(codeFlow)).scripts.some(one => one.name === "new-leads"), { timeoutMs: 15_000, everyMs: 500 });
  // The trigger, through the Triggers panel: a schedule that makes a card for each item the script prints.
  await page.click("[data-open-triggers]");
  if (!(await page.locator("[data-add-trigger] select").first().isVisible())) await page.getByText("Add a trigger", { exact: true }).click();
  await page.locator("[data-add-trigger] select").first().selectOption("schedule");
  await page.locator("[data-add-trigger] label").filter({ hasText: /^When/ }).locator("input").fill("every 6 hours");
  await page.locator('select[aria-label="Makes"]').selectOption("script");
  await page.locator('[data-add-trigger] select[aria-label="Script"]').selectOption("new-leads");
  await page.locator('[data-add-trigger] button:has-text("Add trigger")').click();
  const trigger = await until("the trigger", async () => (await flowView(codeFlow)).triggers.find(one => one.kind === "schedule" && one.state === "active"), { timeoutMs: 15_000, everyMs: 500 });
  for (let round = 0; round < 2; round++) {
    await page.locator(`[data-flow-drawer] button:has-text("Run now")`).first().click();
    await sleep(3000);
  }
  const made = await until("two cards from the script", async () => { const cards = (await flowView(codeFlow)).cards.filter(one => /from the CRM/.test(one.title)); return cards.length >= 2 ? cards : null; }, { timeoutMs: 60_000, everyMs: 2000 });
  if (made.length !== 2) throw new Error(`the script made ${made.length} cards, not 2`);
  return { trigger: trigger.id, cards: made.map(one => one.title) };
});

// ------------------------------------------------------------------ email in, and a reply out

/** A real mail server (GreenMail in Docker) for one check: SMTP to write in with, IMAP to read anyone's inbox. support@shop.example is Settings → Email's. */
async function mailServer() {
  if (!docker) throw new Skip("Docker isn't running here, so there's no real mail server to read");
  const name = `so-e2e-greenmail-${randomBytes(3).toString("hex")}`;
  try {
    execFileSync("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1:993:3993", "-p", "127.0.0.1:3025:3025", "-v", `${join(certDir, "keystore.p12")}:/keystore.p12:ro`, "-e",
      "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=support:mail-pass@shop.example -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/keystore.p12 -Dgreenmail.tls.keystore.password=e2e-keystore",
      "greenmail/standalone:2.1.3"], { stdio: "ignore", timeout: 120_000 });
  } catch { throw new Skip("the mail server container couldn't start (is port 993 or 3025 taken?)"); }
  const nodemailer = (await import(join(w.bin, "../../node_modules/nodemailer/dist/cjs/nodemailer.js"))).default;
  const { ImapFlow } = await import(join(w.bin, "../../node_modules/imapflow/dist/cjs/imap-flow.js"));
  const { simpleParser } = await import(join(w.bin, "../../node_modules/mailparser/index.js"));
  const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 3025, secure: false, ignoreTLS: true });
  const stop = () => { smtp.close(); execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); };
  try { await until("the mail server", async () => { await smtp.verify(); return true; }, { timeoutMs: 60_000, everyMs: 2000 }); } catch (error) { stop(); throw error; }
  /** Everything in someone's inbox (GreenMail signs a person in with their address as the password). */
  const inbox = async user => {
    const box = new ImapFlow({ host: "127.0.0.1", port: 993, secure: true, auth: { user, pass: user }, logger: false, tls: { ca: readFileSync(mailCert) } });
    await box.connect();
    await box.mailboxOpen("INBOX");
    const got = [];
    for await (const message of box.fetch("1:*", { envelope: true, headers: ["in-reply-to", "references"], source: true })) {
      const parsed = await simpleParser(message.source);
      got.push({ subject: message.envelope.subject, headers: message.headers.toString(), body: parsed.text ?? "", messageId: parsed.messageId ?? null });
    }
    await box.logout();
    return got;
  };
  return { smtp, inbox, stop };
}

await check("Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, and it arrives in the sender's thread", [], async () => {
  const mail = await mailServer();
  const smtp = mail.smtp;
  try {
    // Settings → Email: the mail server, and where to read mail; "Check the inbox" signs in.
    await page.goto(`${base}/settings#email`);
    await page.waitForSelector("[data-email-settings]");
    await page.fill("#email-host", "127.0.0.1"); await page.fill("#email-port", "3025"); await page.fill("#email-from", "support@shop.example");
    await page.fill("#email-password", "mail-pass"); await page.fill("#email-imap", "127.0.0.1"); await page.fill("#email-imap-port", "993");
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Save email")')]);
    await page.click('#email button:has-text("Change")');
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Check the inbox")')]);
    // What it said comes back on the page's address (and as a toast).
    const told = new URL(page.url()).searchParams.get("said") ?? "";
    if (told !== "Reading works: signed in to the inbox of support@shop.example.") throw new Error(`Check the inbox said: ${told}`);
    // A Customer replies flow (the template) with an Email inbox trigger added on its Triggers panel.
    await page.goto(`${base}/flows`);
    await page.evaluate(() => { for (const one of document.querySelectorAll("details")) one.open = true; });
    await page.fill('form[action="/flows/new"] input[name="name"]', "Support inbox");
    await page.selectOption('form[action="/flows/new"] select[name="template"]', "email-replies");
    await Promise.all([page.waitForNavigation(), page.click('form[action="/flows/new"] button')]);
    const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
    await page.waitForSelector("[data-zone]");
    await page.click("[data-open-triggers]");
    if (!(await page.locator("[data-add-trigger] select").first().isVisible())) await page.getByText("Add a trigger", { exact: true }).click();
    await page.locator("[data-add-trigger] select").first().selectOption("email");
    await page.locator('[data-add-trigger] button:has-text("Add trigger")').click();
    await until("the email trigger", async () => (await flowView(id)).triggers.some(one => one.kind === "email"), { timeoutMs: 15_000, everyMs: 500 });
    const checkNow = () => page.locator('[data-flow-drawer] button:has-text("Check now")').first().click();
    await checkNow();
    await until("the trigger to note where the inbox stands", async () => /Watching the inbox/.test((await flowView(id)).triggers.find(one => one.kind === "email")?.status ?? ""), { timeoutMs: 30_000, everyMs: 1000 });
    // Priya writes in, and so does her out-of-office.
    await smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Refund for order 42?", messageId: "<m42@example.com>",
      text: "Hi,\n\nI was charged twice for order 42. Can you refund the second charge?\n\nThanks,\nPriya\n\nOn Tue, Support <support@shop.example> wrote:\n> Thanks for your order." });
    await smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Automatic reply: away", text: "Away until Monday.", headers: { "Auto-Submitted": "auto-replied" } });
    await checkNow();
    const card = await until("Priya's card", async () => (await flowView(id)).cards.find(one => one.title === "Refund for order 42?"), { timeoutMs: 60_000, everyMs: 2000 });
    if ((await flowView(id)).cards.some(one => /Automatic reply/.test(one.title))) throw new Error("the out-of-office became a card");
    if (!/^From: Priya Shah <priya@example.com>\n\nHi,/.test(card.description ?? "") || /Thanks for your order/.test(card.description ?? "")) throw new Error(`the card's details: ${card.description}`);
    // Claude drafts; the owner approves in the card's panel; the reply goes out.
    const drafted = await until("Claude's draft", async () => { const one = (await flowView(id)).cards.find(c => c.id === card.id); return one?.draft !== null && one?.draft !== undefined ? one : null; }, { timeoutMs: 300_000, everyMs: 3000 });
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.locator(`[data-card="${card.id}"]`).click();
    await page.click('[data-flow-card-panel] button:has-text("Approve")');
    await until("the card to be done", async () => (await flowView(id)).cards.find(one => one.id === card.id)?.state === "done", { timeoutMs: 120_000, everyMs: 2000 });
    // Read Priya's mailbox: the reply is there, in her thread.
    const got = await mail.inbox("priya@example.com");
    const reply = got.find(one => one.subject === "Re: Refund for order 42?");
    if (reply === undefined) throw new Error(`Priya's mailbox has: ${got.map(one => one.subject).join(", ")}`);
    if (!/In-Reply-To: <m42@example.com>/i.test(reply.headers)) throw new Error(`the reply isn't in her thread: ${reply.headers}`);
    const flat = text => text.replace(/\s+/g, " ").trim();
    if (!flat(reply.body).includes(flat(drafted.draft.text).slice(0, 60))) throw new Error(`the reply isn't the approved draft: ${flat(reply.body).slice(0, 120)} vs ${flat(drafted.draft.text).slice(0, 120)}`);
    await shot("email-inbox");
    return { draft: drafted.draft.text.slice(0, 160) };
  } finally {
    mail.stop();
  }
});

await check("Follow-ups: a card emails someone and waits; their reply moves it on (a stranger's doesn't), one nobody answers gets a nudge in the same thread, and a stalled decision reminds its owner and moves on", ["Email inbox: a real email becomes a card, Claude drafts a reply, the owner approves it, and it arrives in the sender's thread"], async () => {
  const mail = await mailServer();
  try {
    const WAIT = 3;
    const at = (id, title, kind, x, y, rest) => ({ id, title, kind, zone: zone(x, y), ...none, next: null, onFail: null, ...rest });
    // A decision that stalls: after a minute its owner is reminded and it's anyone's to decide.
    const decisions = await newFlow("Decisions", [
      at("decide", "Owner decides", "approval", 0, 0, { toOwner: true, next: "done", limit: { minutes: 1, to: "anyone" } }),
      at("anyone", "Anyone decides", "approval", 360, 0, { next: "done" }),
      at("done", "Done", "done", 720, 0, {}),
    ], "decide");
    await addCard("Buy a second monitor", "For the design desk.");
    const id = await newFlow("Follow-ups", [
      at("ask", "Ask them", "email", 0, 0, { email: { to: "{{card.email}}", subject: "Question about {{card.title}}", body: "Hi, can we go ahead with {{card.title}}?" }, next: "wait", onFail: "stuck" }),
      at("wait", "Wait for an answer", "wait", 360, 0, { wait: { for: "reply", minutes: WAIT }, next: "answered", onFail: "nudge" }),
      at("answered", "They replied", "inbox", 720, 0, {}),
      at("nudge", "Nudge", "email", 360, 380, { email: { to: "{{card.email}}", subject: "Re: Question about {{card.title}}", body: "Just checking in about {{card.title}}." }, next: "gave-up", onFail: "stuck" }),
      at("gave-up", "Gave up", "done", 720, 380, {}),
      at("stuck", "Couldn't email", "inbox", 0, 380, {}),
    ], "ask");
    await addCard("order 42", "Priya <priya@example.com> asked about a refund.");
    await addCard("order 43", "Sam <sam@example.com> asked about a refund.");
    const cardOf = async title => (await flowView(id)).cards.find(one => one.title === title);
    await until("both emails out and both cards waiting", async () => (await cardOf("order 42"))?.stage === "wait" && (await cardOf("order 43"))?.stage === "wait", { timeoutMs: 120_000, everyMs: 2000 });
    // Each waiting card says until when, in the viewer's own time.
    await page.reload(); await page.waitForSelector("[data-zone]");
    const until42 = await page.locator("[data-card-deadline]").first().innerText();
    if (!/^No reply by /.test(until42)) throw new Error(`the card says: ${until42}`);
    await shot("follow-ups-waiting");
    const asked = await until("Priya's email", async () => (await mail.inbox("priya@example.com")).find(one => one.subject === "Question about order 42"), { timeoutMs: 60_000, everyMs: 2000 });
    const asked43 = await until("Sam's email", async () => (await mail.inbox("sam@example.com")).find(one => one.subject === "Question about order 43"), { timeoutMs: 60_000, everyMs: 2000 });
    // A stranger names Sam's email as if replying: it isn't Sam, so it isn't a reply.
    await mail.smtp.sendMail({ from: "Mallory <mallory@example.com>", to: "support@shop.example", subject: "Re: Question about order 43", inReplyTo: asked43.messageId, references: [asked43.messageId], text: "Yes, go ahead." });
    await mail.smtp.sendMail({ from: "Priya Shah <priya@example.com>", to: "support@shop.example", subject: "Re: Question about order 42", inReplyTo: asked.messageId, references: [asked.messageId],
      text: "Yes, please go ahead with order 42.\n\nOn Tue, Support <support@shop.example> wrote:\n> Hi, can we go ahead with order 42?" });
    const answered = await until("Priya's reply to move her card on", async () => { const one = await cardOf("order 42"); return one?.stage === "answered" ? one : null; }, { timeoutMs: 150_000, everyMs: 3000 });
    const kept = answered.outputs.find(one => one.stage === "wait")?.text ?? "";
    if (!/Yes, please go ahead with order 42/.test(kept) || /can we go ahead/.test(kept)) throw new Error(`the reply kept on the card: ${kept}`);
    if (!answered.comments.some(one => one.author === "priya@example.com")) throw new Error("the reply isn't in the card's discussion");
    // Nobody answers Sam: after the wait, a nudge goes out in the same thread and the card finishes.
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.click('button:has-text("Edit flow")');
    await page.locator('[data-zone="wait"]').click({ position: { x: 24, y: 14 } });
    await page.waitForSelector('[data-flow-zone-panel="wait"]');
    await shot("wait-zone-settings");
    await page.click('button:has-text("Discard")');
    const gave = await until("Sam's card to finish without a reply", async () => { const one = await cardOf("order 43"); return one?.state === "done" ? one : null; }, { timeoutMs: (WAIT + 3) * 60_000, everyMs: 5000 });
    if (gave.comments.length > 0) throw new Error("the stranger's message was taken as Sam's reply");
    if (!gave.history.some(one => one.text.includes(`No reply after ${WAIT} minutes`))) throw new Error(`its history: ${gave.history.map(one => one.text).join(" | ")}`);
    const nudge = (await mail.inbox("sam@example.com")).find(one => one.subject === "Re: Question about order 43");
    if (nudge === undefined) throw new Error("the nudge didn't reach Sam");
    if (!nudge.headers.toLowerCase().includes(`in-reply-to: ${asked43.messageId}`.toLowerCase())) throw new Error(`the nudge isn't in the thread: ${nudge.headers}`);
    // The decision nobody made: its owner was reminded once, and it's anyone's to decide now.
    const stalled = (await flowView(decisions)).cards.find(one => one.title === "Buy a second monitor");
    if (stalled?.stage !== "anyone") throw new Error(`the stalled decision is in ${stalled?.stage}`);
    const reminded = rows(`SELECT subject FROM notification WHERE recipient = 'alex' AND subject LIKE '%has waited 1 minute in Owner decides%'`);
    if (reminded.length !== 1) throw new Error(`the owner got ${reminded.length} reminders`);
    // On a phone: the flow's cards, with what they wait on.
    const phone = await signIn("alex", { width: 390, height: 844 }, "dark");
    await phone.goto(`${base}/flows/${id}`); await phone.waitForLoadState("load"); await sleep(700);
    await phone.screenshot({ path: join(w.out, "follow-ups-phone.png") });
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await phone.context().close();
    if (wide) throw new Error("the flow scrolls sideways on a phone");
    return { reply: kept.slice(0, 120), nudge: nudge.subject, reminder: reminded[0].subject };
  } finally {
    mail.stop();
  }
});

// ------------------------------------------------------------------ two people on one flow

await check("Live canvas: a teammate sees who's here and a card move without reloading", ["Code steps: a Python file and a Node script get the card, pass on what they print, pick the next zone, and get a secret"], async () => {
  const sam = await signIn("sam");
  try {
    await sam.goto(`${base}/flows/${codeFlow}`); await sam.waitForSelector("[data-zone]");
    const lead = (await flowView(codeFlow)).cards.find(one => one.stage === "call");
    await page.goto(`${base}/flows/${codeFlow}?card=${lead.id}`); await page.waitForSelector("[data-zone]");
    await until("sam to see alex", async () => /alex is looking at/.test(await sam.locator("[data-also-here]").getAttribute("aria-label") ?? ""), { timeoutMs: 15_000, everyMs: 500 });
    await until("alex's face on the card", async () => (await sam.locator(`[data-card="${lead.id}"] [data-card-lookers]`).count()) === 1, { timeoutMs: 10_000, everyMs: 500 });
    // alex moves the card; sam's canvas follows by itself.
    await page.selectOption("#flow-move", "inbox");
    await until("the card to move on sam's screen", async () => (await sam.locator(`[data-zone="inbox"] [data-card="${lead.id}"]`).count()) === 1, { timeoutMs: 15_000, everyMs: 500 });
    await sam.screenshot({ path: join(w.out, "live-canvas.png") });
  } finally {
    w.openPages.splice(w.openPages.indexOf(sam), 1);
    await sam.context().close();
  }
});

// ------------------------------------------------------------------ the demo

await check("The demo starts with flows already moving, and opens in a browser", [], async () => {
  const demo = spawn(process.execPath, [w.bin, "demo", "--json"], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await new Promise((done, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`the demo didn't start: ${text.slice(0, 300)}`)), 60_000);
      demo.stdout.on("data", chunk => { text += chunk; try { const value = JSON.parse(text.slice(text.indexOf("{"))); clearTimeout(timer); done(value.url === undefined ? value.result ?? value : value); } catch { /* more to come */ } });
    });
    const password = /password: (.*)/.exec(readFileSync(started.login.passwordFile, "utf8"))[1].trim();
    const context = await w.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitor = await context.newPage();
    await visitor.goto(`${started.url}/login`);
    await visitor.fill('input[name="name"]', started.login.name); await visitor.fill('input[name="token"]', password);
    await Promise.all([visitor.waitForNavigation(), visitor.press('input[name="token"]', "Enter")]);
    await visitor.goto(`${started.url}/flows`);
    const text = await visitor.locator("body").innerText();
    await context.close();
    if (!/Customer replies/.test(text) || !/Support desk/.test(text)) throw new Error(`the demo's flows: ${text.slice(0, 300)}`);
  } finally { demo.kill("SIGINT"); }
});

await check("Signing out ends the session: pages ask to sign in again", [], async () => {
  const sam = await signIn("sam");
  await sam.goto(`${base}/chat`);
  await Promise.all([sam.waitForNavigation(), sam.locator('.so-account form[action="/logout"] button').click()]);
  if (!sam.url().includes("/login")) throw new Error(`signing out went to ${sam.url()}`);
  const answer = await sam.request.get(`${base}/flows`, { maxRedirects: 0 });
  w.openPages.splice(w.openPages.indexOf(sam), 1);
  await sam.context().close();
  if (answer.status() < 300 || answer.status() >= 400) throw new Error(`after signing out, /flows answered ${answer.status()}`);
});

await w.finish("Standing Orders end to end");
