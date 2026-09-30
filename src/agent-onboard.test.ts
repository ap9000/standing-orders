/**
 * `toolroll onboard`, over a temp HOME and a temp database: the project,
 * the sign-in report, the operator skill's whole life (preview, write,
 * current, upgrade, foreign, remove), consent, and the handoff.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runOperate, type OnboardSeams } from "./operate.js";
import { openStore } from "./store.js";
import { loadProjectRegistry } from "./repos.js";
import { operatorSkillContent } from "./agent-onboard.js";
import { CLAUDE_CODE_MANAGED_MARK, planClaudeCodeInstall } from "./skills.js";
import type { ProviderConnection } from "./provider-connection.js";
import { PACKAGE_VERSION } from "./version.js";

let base: string;
let home: string;
let repo: string;
let elsewhere: string;
let db: string;
let lines: string[];
let asked: string[];

const connections: Record<string, ProviderConnection> = {
  claude: { state: "connected", mode: "subscription", plan: "Max", checkedAt: "2026-09-29T00:00:00.000Z" },
  codex: { state: "signed-out", mode: "subscription", checkedAt: "2026-09-29T00:00:00.000Z" },
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-onboard-")));
  home = join(base, "home");
  repo = join(base, "project");
  elsewhere = join(base, "not-a-repo");
  db = join(base, "config", "orders.db");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(base, "config"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  lines = [];
  asked = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const onboard = (argv: string[], seams: OnboardSeams = {}) =>
  runOperate("onboard", argv, line => lines.push(line), {
    databaseFile: db,
    onboardSeams: {
      home,
      env: {},
      cwd: repo,
      interactive: false,
      checkConnection: async agent => connections[agent] as ProviderConnection,
      ...seams,
    },
  });
const envelope = () => JSON.parse(lines.join("\n")) as Record<string, any>;
const claudeSkill = () => join(home, ".claude", "skills", "toolroll", "SKILL.md");
const codexSkill = () => join(home, ".codex", "skills", "toolroll", "SKILL.md");

describe("toolroll onboard", () => {
  test("adds the current repository as a project and reports who is signed in", async () => {
    expect(await onboard(["--json"])).toBe(0);
    const answer = envelope();
    expect(answer).toMatchObject({ ok: true, command: "onboard", project: { path: repo, added: true } });
    expect(answer.agents).toEqual([
      { agent: "claude", name: "Claude Code", state: "connected", words: "Connected", plan: "Max" },
      { agent: "codex", name: "Codex", state: "signed-out", words: "Not signed in" },
    ]);
    const registry = await loadProjectRegistry(join(base, "config", "repos.json"));
    expect(registry).toMatchObject({ repos: [repo] });
    const store = openStore(db);
    try {
      expect(store.listProjects().map(one => one.path)).toContain(repo);
    } finally {
      store.close();
    }

    lines = [];
    await onboard(["--json"]);
    expect(envelope().project).toEqual({ path: repo, added: false });
  });

  test("outside a repository nothing is added and the rest still answers", async () => {
    expect(await onboard(["--json"], { cwd: elsewhere })).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, project: null, projectProblem: "not inside a git repository" });
    lines = [];
    await onboard([], { cwd: elsewhere });
    expect(lines.join("\n")).toContain("project   none added: run onboard inside the repository you want to hand off");
  });

  test("without --yes and no terminal, nothing is written outside the repository", async () => {
    expect(await onboard(["--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "needs-yes", files: [{ agent: "claude", path: claudeSkill(), action: "create" }], wrote: [] });
    expect(existsSync(join(home, ".claude"))).toBe(false);
    lines = [];
    await onboard([]);
    expect(lines.join("\n")).toContain(`skill     not written yet: run again with --yes to write ${claudeSkill()}`);
  });

  test("--yes installs the marked skill for each agent found, and a second run changes nothing", async () => {
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "written", wrote: [claudeSkill(), codexSkill()] });
    const content = readFileSync(claudeSkill(), "utf8");
    expect(content).toBe(operatorSkillContent(PACKAGE_VERSION));
    expect(content).toContain("toolroll:operator-skill");
    expect(content).toContain("`toolroll skills get operating`");
    for (const word of ["Hand off", "Wait", "Review", "Release"]) expect(content).toContain(word);
    expect(readFileSync(codexSkill(), "utf8")).toBe(content);
    expect(envelope().mcp).toEqual([
      { agent: "claude", command: "claude mcp add toolroll -- toolroll mcp" },
      { agent: "codex", command: "codex mcp add toolroll -- toolroll mcp" },
    ]);

    lines = [];
    await onboard(["--yes", "--json"]);
    expect(envelope().skill).toMatchObject({ state: "current", wrote: [], removed: [] });
  });

  test("CODEX_HOME and --agent choose where the skill goes", async () => {
    const codexHome = join(base, "codex-home");
    expect(await onboard(["--agent", "codex", "--yes", "--json"], { env: { CODEX_HOME: codexHome } })).toBe(0);
    expect(envelope().skill.wrote).toEqual([join(codexHome, "skills", "toolroll", "SKILL.md")]);
    expect(existsSync(claudeSkill())).toBe(false);
    lines = [];
    expect(await onboard(["--agent", "cursor", "--json"])).toBe(2);
    expect(envelope()).toMatchObject({ ok: false, reason: "usage" });
  });

  test("an older skill of ours is replaced, and its old guide copies go with it", async () => {
    const folder = join(home, ".claude", "skills", "toolroll");
    mkdirSync(folder, { recursive: true });
    writeFileSync(claudeSkill(), operatorSkillContent("0.1.0"));
    writeFileSync(join(folder, "console.md"), `${CLAUDE_CODE_MANAGED_MARK}\n\n# old\n`);
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "written", files: [{ action: "replace" }], removed: [join(folder, "console.md")] });
    expect(readFileSync(claudeSkill(), "utf8")).toBe(operatorSkillContent(PACKAGE_VERSION));
    expect(existsSync(join(folder, "console.md"))).toBe(false);
  });

  test("`skills install --claude-code` recognizes the operator skill as Toolroll's", async () => {
    await onboard(["--yes"]);
    const plan = planClaudeCodeInstall(join(home, ".claude", "skills", "toolroll"), null);
    expect(plan.files.find(file => file.name === "SKILL.md")?.action).toBe("replace");
  });

  test("a SKILL.md that is not Toolroll's is never overwritten or removed", async () => {
    mkdirSync(join(home, ".claude", "skills", "toolroll"), { recursive: true });
    writeFileSync(claudeSkill(), "---\nname: toolroll\n---\nmine\n");
    expect(await onboard(["--yes", "--json"])).toBe(0);
    expect(envelope().skill).toMatchObject({ state: "not-ours", wrote: [] });
    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "not-ours" });
    expect(readFileSync(claudeSkill(), "utf8")).toBe("---\nname: toolroll\n---\nmine\n");
  });

  test("--remove deletes only with a yes, and then there is nothing left to remove", async () => {
    await onboard(["--yes"]);
    lines = [];
    expect(await onboard(["--remove", "--json"])).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "unconfirmed" });
    expect(existsSync(claudeSkill())).toBe(true);

    lines = [];
    expect(await onboard(["--remove", "--yes", "--json"])).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, skill: { state: "removed", removed: [claudeSkill()] } });
    expect(existsSync(join(home, ".claude", "skills", "toolroll"))).toBe(false);

    lines = [];
    expect(await onboard(["--remove", "--yes"])).toBe(0);
    expect(lines.join("\n")).toBe("skill     not installed; nothing to remove");
  });

  test("at a terminal it asks once: yes writes, anything else writes nothing", async () => {
    const seams = (answer: boolean): OnboardSeams => ({ interactive: true, confirm: async question => { asked.push(question); return answer; } });
    expect(await onboard([], seams(false))).toBe(0);
    expect(asked).toEqual([`Write ${claudeSkill()}? [y/N]`]);
    expect(lines.join("\n")).toContain("skill     nothing written");
    expect(existsSync(claudeSkill())).toBe(false);

    lines = [];
    expect(await onboard([], seams(true))).toBe(0);
    expect(lines.join("\n")).toContain(`skill     wrote ${claudeSkill()}`);
    expect(existsSync(claudeSkill())).toBe(true);
  });
});

describe("the handoff", () => {
  const saveLogin = () => writeFileSync(join(base, "config", "up-login.txt"), "alex s3cret-pass-phrase\n", { mode: 0o600 });

  test("as text: console, the login file (never the password), phone pairing and three next things", async () => {
    saveLogin();
    await onboard(["--port", "4190"]);
    const text = lines.join("\n");
    expect(text).toContain("tools     claude mcp add toolroll -- toolroll mcp   (add Toolroll as tools; not run)");
    expect(text).toContain("Toolroll is ready.\n  console   http://127.0.0.1:4190");
    expect(text).toContain(`  login     alex — the password is in ${join(base, "config", "up-login.txt")}`);
    expect(text).toContain("  phone     Open the console on your phone over your tailnet, or pair Telegram in Settings → Telegram");
    expect(text).toContain('  say next  "queue these bugs overnight" · "what needs me?" · "open the result"');
    expect(text).not.toContain("s3cret-pass-phrase");
  });

  test("as --json: the same facts as data", async () => {
    saveLogin();
    await onboard(["--json"]);
    expect(envelope().handoff).toEqual({
      console: "http://127.0.0.1:4180",
      start: "toolroll up",
      login: { account: "alex", file: join(base, "config", "up-login.txt") },
      phone: "Open the console on your phone over your tailnet, or pair Telegram in Settings → Telegram with the /pair code it shows.",
      next: ["queue these bugs overnight", "what needs me?", "open the result"],
    });
    expect(lines.join("\n")).not.toContain("s3cret-pass-phrase");
  });

  test("with no saved login yet it says how to get one", async () => {
    await onboard(["--json"]);
    expect(envelope().handoff.login).toBeNull();
    lines = [];
    await onboard([]);
    expect(lines.join("\n")).toContain("  login     no saved login yet; `toolroll up` creates one");
  });
});
