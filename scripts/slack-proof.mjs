/** Synthetic Slack-to-console journey. Actual Chrome viewports; scripted Slack and model. */
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { startFixture } from "./ui-polish-fixture.mjs";
import { loadSlackCredentials } from "../dist/slack-api.js";
import { SlackState } from "../dist/slack-state.js";
import {
  receiveSlack,
  processSlackEvent,
  deliverSlackPart,
} from "../dist/slack-chat.js";
// Scripted setup only; never submitted to Slack.
const FIXTURE_BOT_TOKEN = ["xoxb", "fixture", "private", "token"].join("-");
const out = resolve("output/playwright/slack");
mkdirSync(out, { recursive: true });
const report = {
  synthetic: true,
  limitation:
    "Slack and the model are scripted; these images show the real console in Chrome, not the Slack app or a physical phone.",
  checks: [],
  screenshots: [],
  source: {},
};
for (const file of [
  "src/slack-api.ts",
  "src/slack-state.ts",
  "src/slack-chat.ts",
  "src/slack-settings.ts",
  "src/slack.ts",
  "src/chat-channel.ts",
  "src/serve.ts",
  "src/store.ts",
  "scripts/slack-proof.mjs",
  "scripts/ui-polish-fixture.mjs",
])
  report.source[file] = createHash("sha256")
    .update(readFileSync(file))
    .digest("hex");
let pw;
const modules = [process.env.PLAYWRIGHT_MODULE].filter(Boolean),
  cache = join(homedir(), ".npm", "_npx");
if (existsSync(cache))
  for (const d of readdirSync(cache))
    modules.push(join(cache, d, "node_modules/playwright/index.mjs"));
for (const p of modules)
  if (existsSync(p)) {
    pw = await import(pathToFileURL(p));
    break;
  }
if (!pw) throw Error("Playwright unavailable");
const browser = await pw.chromium.launch({ channel: "chrome" });
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok" : "FAIL"} ${name}`);
  if (!ok) throw Error(name);
}
async function settled(page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(() => {
    try {
      return !document.documentElement.matches(":active-view-transition");
    } catch {
      return true;
    }
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
}
async function shot(page, name) {
  await settled(page);
  await page.evaluate(() => scrollTo(0, 0));
  const path = join(out, name + ".png");
  await page.screenshot({ path });
  report.screenshots.push(path);
}
async function click(page, locator) {
  await settled(page);
  await locator.click();
  await settled(page);
}
async function fits(page, name) {
  await settled(page);
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    buttons: [
      ...document.querySelectorAll(
        "main > section button,main > section .button-link,.shared-action button,.shared-action .arm,#comment-form button[data-request-changes]",
      ),
    ]
      .filter((e) => e.checkVisibility())
      .map((e) => ({
        text: e.textContent.trim(),
        width: e.getBoundingClientRect().width,
        height: e.getBoundingClientRect().height,
        scroll: e.scrollWidth,
      })),
  }));
  check(
    name,
    dims.width <= dims.viewport &&
      dims.buttons.every((b) => b.height >= 44 && b.scroll <= b.width + 1),
    dims,
  );
}
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    let answers = [],
      messageId = 100;
    const sent = [];
    const runner = async () => {
      const answer = answers.shift();
      if (!answer) throw Error("Missing scripted response");
      return {
        ok: true,
        answer: {
          text: answer.text,
          calls: answer.calls ?? [],
          tokensIn: 20,
          tokensOut: 10,
          reportedCostMicrousd: null,
        },
      };
    };
    const fetcher = async (url) => {
      const method = new URL(url).pathname.split("/").at(-1);
      const result =
        method === "auth.test"
          ? {
              team_id: "TFIXTURE",
              user_id: "UBOT",
              bot_id: "BBOT",
              team: "Portfolio team — international products and customer operations",
            }
          : method === "bots.info"
            ? { bot: { app_id: "AFIXTURE" } }
            : {};
      return new Response(JSON.stringify({ ok: true, ...result }));
    };
    const f = await startFixture({
      sameTaskRevisions: true,
      secondProject: true,
      runner,
      slack: { fetcher },
    });
    const context = await browser.newContext({
        viewport,
        isMobile: name === "phone",
        hasTouch: name === "phone",
        reducedMotion: "reduce",
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(f.url + "/login");
      await page.locator("[name=name]").fill(f.name);
      await page.locator("[name=token]").fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "sign in", exact: true }),
      );
      await page.goto(f.url + "/settings/slack");
      await fits(page, name + " empty setup fits");
      await shot(page, name + "-setup");
      await page.locator('[name="app-token"]').fill("wrong");
      await page.locator('[name="bot-token"]').fill("wrong");
      await page.locator('[name="password"]').fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "Connect Slack", exact: true }),
      );
      check(
        name + " setup failure stays on a recoverable form",
        await page.getByRole("alert").isVisible(),
      );
      await fits(page, name + " error fits");
      await shot(page, name + "-error");
      await page
        .locator('[name="app-token"]')
        .fill("xapp-fixture-private-token");
      await page
        .locator('[name="bot-token"]')
        .fill(FIXTURE_BOT_TOKEN);
      await page.locator('[name="password"]').fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "Connect Slack", exact: true }),
      );
      check(
        name + " tokens never echo back",
        !(await page.content()).includes("fixture-private-token"),
      );
      await page
        .locator('form[action$="/pair"] [name="password"]')
        .fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "Create pairing code", exact: true }),
      );
      const pairMessage = await page.getByLabel("Pairing message").inputValue();
      await fits(page, name + " pairing and long workspace fit");
      await shot(page, name + "-pairing");
      const identity = loadSlackCredentials(f.configDir),
        state = new SlackState(f.store),
        owner = "synthetic",
        ts = "1789700000.000001";
      state.lease(identity.installation, owner, new Date());
      const api = async (method, args = {}) => {
        if (method === "users.info")
          return { user: { id: "UPERSON", team_id: identity.team } };
        if (method === "conversations.info")
          return { channel: { id: "DPRIVATE", is_im: true, user: "UPERSON" } };
        sent.push({ method, args });
        return {
          ts: args.ts ?? `1789700000.${String(messageId++).padStart(6, "0")}`,
        };
      };
      const options = {
        store: f.store,
        identity,
        owner,
        api,
        current: () => true,
        readProjects: async () => Object.values(f.repos).filter(Boolean),
        evidenceRoot: join(f.configDir, "evidence"),
        origin: () => "https://console.example",
        subscriptionRunner: runner,
      };
      const incoming = (id, text) => ({
        api_app_id: identity.app,
        team_id: identity.team,
        event_id: id,
        event: {
          type: "message",
          channel_type: "im",
          channel: "DPRIVATE",
          user: "UPERSON",
          ts,
          text,
        },
      });
      receiveSlack(
        state,
        identity,
        "events_api",
        incoming("EvPair", pairMessage),
        new Date(),
      );
      await processSlackEvent(options);
      await deliverSlackPart(options);
      state.db
        .prepare(
          "UPDATE slack_runtime SET connected=?,problem=NULL WHERE installation=?",
        )
        .run(new Date().toISOString(), identity.installation);
      await page.goto(f.url + "/settings/slack");
      check(
        name + " pairing is visible",
        (await page.locator("main").innerText()).includes(
          "Paired to " + f.name,
        ),
      );
      await fits(page, name + " connected status fits");
      await page
        .getByRole("button", { name: "Send task updates here", exact: true })
        .focus();
      check(
        name + " primary action supports keyboard",
        await page
          .getByRole("button", { name: "Send task updates here", exact: true })
          .evaluate((e) => e === document.activeElement),
      );
      answers.push(
        {
          text: "Review the exact saved result.",
          calls: [
            {
              id: "accept",
              name: "propose_action",
              args: {
                operation: "result_accept",
                task: f.tasks.done,
                run: f.runId,
                note: "The payout rounding looks correct. Keep the next action clear on small screens.",
              },
            },
          ],
        },
        { text: "Open the saved acceptance details before confirming." },
      );
      receiveSlack(
        state,
        identity,
        "events_api",
        incoming(
          "EvAccept",
          "I reviewed the payout result. Record my acceptance.",
        ),
        new Date(),
      );
      await processSlackEvent(options);
      for (let i = 0; i < 10 && (await deliverSlackPart(options)); i++);
      const actions = sent.flatMap((s) =>
          (s.args.blocks ?? []).flatMap((b) => b.elements ?? []),
        ),
        link = actions.find((a) => a.url?.includes("/chat/action/"));
      check(name + " Slack uses the saved secure acceptance link", !!link);
      await page.goto(f.url + new URL(link.url).pathname);
      await fits(page, name + " exact result review fits");
      check(
        name + " exact saved result remains visible",
        (await page.locator("main").innerText()).includes("Result #" + f.runId),
      );
      await shot(page, name + "-review");
      await page.locator('[name="confirm"]').check();
      await click(
        page,
        page.getByRole("button", { name: "Accept result", exact: true }),
      );
      check(
        name + " acceptance recorded without changing machine checks",
        f.store.proofAcceptance(f.runId) !== null,
      );
      await page.goto(f.url + `/chat?task=${f.tasks.done}&result=${f.runId}`);
      await page
        .locator('#comment-form [name="note"]')
        .fill(
          "Please rename the rounding helper so its purpose is clear when reviewing the changes.",
        );
      await click(
        page,
        page.locator("#comment-form button[data-request-changes]"),
      );
      check(
        name + " feedback creates one unapproved revision",
        f.store.revisionsFromRun(f.runId).length === 1 &&
          f.store.getScope(f.store.revisionsFromRun(f.runId)[0].id)
            ?.approvedDigest === null,
      );
      await fits(page, name + " revision fits");
      await shot(page, name + "-revision");
      check(name + " browser errors", errors.length === 0, errors);
    } finally {
      await context.close();
      await f.stop();
    }
  }
} finally {
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
