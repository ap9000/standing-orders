/** Synthetic UI journey; no model, live database, messages, or deployment. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startFixture } from "./ui-polish-fixture.mjs";
import { approve } from "../dist/scope.js";
import {
  freezeSkills,
  importSkill,
  skillsView,
} from "../dist/project-skills.js";
import { storeEvidence } from "../dist/evidence.js";
const out = resolve("output/playwright/project-skills");
mkdirSync(out, { recursive: true });
const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean),
  cache = join(homedir(), ".npm", "_npx");
if (existsSync(cache))
  for (const d of readdirSync(cache))
    candidates.push(join(cache, d, "node_modules/playwright/index.mjs"));
let playwright;
for (const p of candidates)
  if (existsSync(p)) {
    playwright = await import(pathToFileURL(p).href);
    break;
  }
if (!playwright) throw Error("Playwright unavailable");
const browser = await playwright.chromium.launch({ channel: "chrome" }),
  report = {
    fixture: "Synthetic skill test and result. No live agent invoked.",
    checks: [],
    screenshots: [],
  };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok" : "FAIL"} ${name}`);
  if (!ok) throw Error(name);
};
const shot = async (page, name) => {
  const path = join(out, name + ".png");
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(path);
};
const settle = async (page) => {
  await page.waitForLoadState("load");
  await page
    .waitForFunction(
      () => {
        try {
          return !document.documentElement.matches(":active-view-transition");
        } catch {
          return true;
        }
      },
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
};
const click = async (page, locator) => {
  await settle(page);
  await locator.click();
  await settle(page);
};
const fits = async (page, name) => {
  const data = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll(".skills button")]
      .filter((e) => e.checkVisibility())
      .map((e) => ({
        text: e.textContent,
        height: e.getBoundingClientRect().height,
        width: e.getBoundingClientRect().width,
        scroll: e.scrollWidth,
      })),
  }));
  check(
    name,
    data.scroll <= data.width &&
      data.buttons.every((b) => b.height >= 44 && b.scroll <= b.width + 1),
    data,
  );
};
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const fixture = await startFixture({
      sameTaskRevisions: true,
      learning: true,
    });
    const ctx = await browser.newContext({
      viewport,
      isMobile: name === "phone",
      hasTouch: name === "phone",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(fixture.url + "/login");
      await page.locator("[name=name]").fill(fixture.name);
      await page.locator("[name=token]").fill(fixture.password);
      await click(page, page.locator("button[type=submit]"));
      const skillsUrl =
        fixture.url +
        "/settings/skills?repo=" +
        encodeURIComponent(fixture.repos.main);
      await page.goto(skillsUrl);
      await settle(page);
      await fits(page, name + " empty fits");
      await shot(page, name + "-empty");
      await click(
        page,
        page.locator(".skills summary").filter({ hasText: /^Add skill$/ }),
      );
      await page.locator("[name=content]").fill("Preserve my sample draft");
      await click(
        page,
        page.getByRole("button", { name: "Add to library", exact: true }),
      );
      check(
        name + " error retains draft",
        (await page.locator("[name=content]").inputValue()) ===
          "Preserve my sample draft",
      );
      await fits(page, name + " error fits");
      await shot(page, name + "-error");
      const body =
        "---\nname: concise-interface-review\ndescription: Review interface wording and suggest short, specific actions.\ncompatibility: A readable project checkout; browser inspection is optional.\n---\nUse plain English. Identify one confusing button label, suggest a replacement, and explain the user benefit.\n\n" +
        "Prefer a short title, a concise outcome and one primary action. Keep exact approval terms visible.\n".repeat(
          90,
        );
      await page.locator("[name=content]").fill(body);
      await click(
        page,
        page.getByRole("button", { name: "Add to library", exact: true }),
      );
      await fits(page, name + " long skill fits");
      await shot(page, name + "-review-source");
      await click(
        page,
        page.getByRole("button", { name: "Enable skill", exact: true }),
      );
      check(
        name + " enabled exact version",
        Object.values(
          skillsView(fixture.store, fixture.repos.main, fixture.name).selection,
        ).filter((s) => s.enabled).length === 1,
      );
      await fits(page, name + " enabled fits");
      await shot(page, name + "-library");
      await click(
        page,
        page.locator(".skills summary").filter({ hasText: /^Test skill$/ }),
      );
      await page
        .locator("[name=sample]")
        .fill(
          "Suggest a clearer name for the home page action “Proceed”. Explain which user goal the replacement communicates.",
        );
      await click(
        page,
        page.getByRole("button", { name: "Create test", exact: true }),
      );
      const testId = fixture.store.handle
        .prepare(
          "SELECT external_id FROM task_ref JOIN skill_test ON task_ref.id=skill_test.task_ref",
        )
        .get().external_id;
      check(
        name + " normal test awaits approval",
        fixture.store.getScope(testId)?.approvedDigest === null,
      );
      await shot(page, name + "-test-task");
      // Synthetic completion through the regular run/evidence services, labelled as such.
      const store = fixture.store,
        now = new Date(),
        scope = store.getScope(testId);
      const approval = approve(
        store,
        testId,
        fixture.name,
        now,
        scope.digest,
        fixture.password,
      );
      if (!approval.ok)
        throw Error("Fixture approval failed: " + approval.reason);
      const ref = store.lookupRef(testId);
      const authority = store.routeAuthorityFor(ref.id, "scout", null, {
        provider: "codex",
        model: "default",
      });
      if (!authority.ok) throw Error("Fixture route");
      const run = store.startRun({
        taskRef: ref.id,
        leaseId: "synthetic-skill-" + name,
        runner: "night-shift-1",
        role: "scout",
        branch: "standing-orders/" + testId,
        worktree: fixture.repos.main,
        provider: "codex",
        model: "default",
        now,
        route: authority.stamp,
      });
      freezeSkills(store, run);
      const evidenceRoot = join(fixture.repos.main, "..", "evidence");
      const conclusion =
        "Synthetic skill-test result: “Review plan” names the next action more clearly than “Proceed”. Browser-only steps were not tested.";
      storeEvidence(
        store,
        evidenceRoot,
        run,
        "report",
        "report.json",
        Buffer.from(
          JSON.stringify({
            title: "Skill sample — synthetic result",
            summary: conclusion,
            report:
              conclusion +
              "\n\nThis fixture demonstrates the review flow. No model was invoked.",
            followUps: [],
          }),
        ),
        "synthetic UI fixture",
        now,
      );
      // Match native report completion: no builder handoff is produced.
      store.finishRun(run, { outcome: "built", reason: "report-delivered", committed: false, now });
      store.setTaskState(testId, "done", now);
      await page.goto(fixture.url + `/chat?task=${testId}&result=${run}`);
      await settle(page);
      check(
        name + " result includes supplied skills",
        (await page
          .getByText("Skills supplied (1)", { exact: true })
          .count()) === 1,
      );
      await shot(page, name + "-test-result");
      // The same established review surface supports feedback and a scoped revision.
      await page
        .locator("#skill-test-feedback [name=feedback]")
        .fill(
          "Use “Review plan” for this example, and explain how the wording changes when the user is opening a report.",
        );
      await page
        .locator("#skill-test-feedback button")
        .scrollIntoViewIfNeeded();
      const feedbackFits = await page
        .locator("#skill-test-feedback button")
        .evaluate((el) => {
          const r = el.getBoundingClientRect(),
            bar = document.querySelector("nav.tabbar")?.getBoundingClientRect();
          return (
            r.height >= 44 &&
            r.left >= 0 &&
            r.right <= innerWidth &&
            (!bar || r.bottom <= bar.top || r.top >= bar.bottom)
          );
        });
      check(name + " feedback action clears fixed navigation", feedbackFits);
      await shot(page, name + "-feedback");
      await click(page, page.locator("#skill-test-feedback button"));
      const child = store.handle
        .prepare(
          "SELECT external_id FROM task_ref JOIN skill_test ON task_ref.id=skill_test.task_ref WHERE source_run=?",
        )
        .get(run)?.external_id;
      check(
        name + " feedback creates revision awaiting approval",
        !!child && store.getScope(child)?.approvedAt === null,
        { child },
      );
      await shot(page, name + "-revision");
      if (name === "desktop") {
        const folder = join(out, "local-import-sample");
        mkdirSync(join(folder, "references"), { recursive: true });
        writeFileSync(
          join(folder, "SKILL.md"),
          "---\nname: local-copy-review\ndescription: Review button labels using the accompanying checklist.\n---\nRead references/checklist.md and suggest a clearer action label.",
        );
        writeFileSync(
          join(folder, "references/checklist.md"),
          "Name the user’s next action. Preserve important approval terms.",
        );
        await page.goto(skillsUrl);
        await settle(page);
        await click(
          page,
          page.locator(".skills summary").filter({ hasText: /^Add skill$/ }),
        );
        await page.locator("[data-skill-method]").selectOption("folder");
        await page.locator("[data-skill-folder]").setInputFiles(folder);
        await click(
          page,
          page.getByRole("button", { name: "Add to library", exact: true }),
        );
        await page
          .getByRole("heading", { name: "local-copy-review", exact: true })
          .waitFor({ timeout: 10000 });
        const uploaded = skillsView(
          store,
          fixture.repos.main,
          fixture.name,
        ).library.find((s) => s.name === "local-copy-review");
        check(
          "desktop local upload preserves resource file",
          uploaded?.files.some((f) => f.path === "references/checklist.md"),
        );
        for (const [skillName, description] of [
          ["api-review", "Review API responses"],
          ["docs-review", "Clarify documentation"],
          ["release-checks", "Review release readiness"],
          ["accessibility-review", "Review keyboard and screen reader support"],
          ["test-planning", "Plan useful regression checks"],
        ])
          importSkill(
            store,
            fixture.repos.main,
            fixture.name,
            [
              {
                path: "SKILL.md",
                base64: Buffer.from(
                  "---\nname: " +
                    skillName +
                    "\ndescription: " +
                    description +
                    "\n---\nReport concrete findings.",
                ).toString("base64"),
              },
            ],
            "Synthetic library sample",
          );
        await page.goto(skillsUrl);
        await page.locator("[data-skill-search]").fill("keyboard");
        check(
          "desktop library search finds the matching skill",
          (await page.locator("[data-skill-group]:visible").count()) === 1,
        );
        await page.locator("[data-skill-search]").fill("no match here");
        check(
          "desktop search empty state is visible",
          await page.locator("[data-skill-no-matches]").isVisible(),
        );
      }
      check(name + " no browser errors", errors.length === 0, errors);
    } finally {
      await ctx.close();
      await fixture.stop();
    }
  }
} finally {
  await browser.close();
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
}
