/** Synthetic Discord-to-console journey. Actual Chrome viewports; scripted Discord and model. */
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
import { loadDiscordCredentials } from "../dist/discord-api.js";
import { ChatState } from "../dist/chat-delivery-state.js";
import {
  receiveDiscord,
  processDiscordEvent,
  deliverDiscordPart,
} from "../dist/discord-chat.js";
// Scripted setup only; never submitted to Discord.
const FIXTURE_BOT_TOKEN = [
  "synthetic",
  "discord",
  "fixture",
  "token",
  "never-sent",
].join("-");
const out = resolve("output/playwright/discord");
mkdirSync(out, { recursive: true });
const report = {
  synthetic: true,
  limitation:
    "Discord and the model are scripted; these images show the real console in Chrome, not the Discord app or a physical phone.",
  checks: [],
  screenshots: [],
  source: {},
};
for (const file of [
  "src/discord-api.ts",
  "src/chat-delivery-state.ts",
  "src/chat-delivery.ts",
  "src/discord-chat.ts",
  "src/discord-settings.ts",
  "src/discord.ts",
  "src/chat-channel.ts",
  "src/serve.ts",
  "src/store.ts",
  "scripts/discord-proof.mjs",
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
    const bot = "100000000000000001",
      app = bot,
      member = "100000000000000002",
      channel = "100000000000000003";
    const fetcher = async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/users/@me")
            ? { id: bot, bot: true }
            : {
                id: app,
                bot: { id: bot },
                name: "Portfolio team — international products and customer operations",
              },
        ),
      );
    const f = await startFixture({
      sameTaskRevisions: true,
      secondProject: true,
      runner,
      discord: { fetcher },
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
      await page.goto(f.url + "/settings/discord");
      await fits(page, name + " empty setup fits");
      await shot(page, name + "-setup");
      await page.locator('[name="bot-token"]').fill("wrong");
      await page.locator('[name="password"]').fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "Connect Discord", exact: true }),
      );
      check(
        name + " setup failure stays on a recoverable form",
        await page.getByRole("alert").isVisible(),
      );
      await fits(page, name + " error fits");
      await shot(page, name + "-error");
      await page.locator('[name="bot-token"]').fill(FIXTURE_BOT_TOKEN);
      await page.locator('[name="password"]').fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "Connect Discord", exact: true }),
      );
      check(
        name + " tokens never echo back",
        !(await page.content()).includes(FIXTURE_BOT_TOKEN),
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
      const identity = loadDiscordCredentials(f.configDir),
        state = new ChatState(f.store, "discord"),
        owner = "synthetic",
        ts = "100000000000000004";
      state.lease(identity.installation, owner, new Date());
      const api = async (method, path, args = {}) => {
        if (path === `/users/${member}`) return { id: member };
        if (path === `/channels/${channel}`)
          return { id: channel, type: 1, recipients: [{ id: member }] };
        sent.push({ method, path, args });
        return {
          id:
            method === "PATCH"
              ? path.split("/").at(-1)
              : String(100000000000000100n + BigInt(messageId++)),
          channel_id: channel,
          author: { id: bot, bot: true },
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
      const incoming = (_id, text) => ({
        id: String(100000000000001000n + BigInt(messageId++)),
        channel_id: channel,
        author: { id: member },
        type: 0,
        content: text,
      });
      receiveDiscord(
        state,
        identity,
        "MESSAGE_CREATE",
        incoming("EvPair", pairMessage),
        new Date(),
      );
      await processDiscordEvent(options);
      await deliverDiscordPart(options);
      state.db
        .prepare(
          "UPDATE discord_runtime SET connected=?,problem=NULL WHERE installation=?",
        )
        .run(new Date().toISOString(), identity.installation);
      await page.goto(f.url + "/settings/discord");
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
      receiveDiscord(
        state,
        identity,
        "MESSAGE_CREATE",
        incoming(
          "EvAccept",
          "I reviewed the payout result. Record my acceptance.",
        ),
        new Date(),
      );
      await processDiscordEvent(options);
      for (let i = 0; i < 10 && (await deliverDiscordPart(options)); i++);
      const actions = sent.flatMap((s) =>
          (s.args.components ?? []).flatMap((b) => b.components ?? []),
        ),
        link = actions.find((a) => a.url?.includes("/chat/action/"));
      check(name + " Discord uses the saved secure acceptance link", !!link);
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
