/**
 * `toolroll onboard`: the agent that installed Toolroll becomes its lead.
 *
 * Run inside a repository, it adds that repository as a project (the same
 * registry and project row Projects → add writes), reports which agent
 * CLIs are signed in (the checks Settings → AI providers makes), installs
 * a thin operator skill for the person's own agent, prints the MCP line
 * without running it, and ends with a handoff the agent can relay.
 *
 * The skill is the only write outside Toolroll's own state, so it needs
 * --yes or a yes typed at a terminal. It is marked as Toolroll's, replaced
 * by the next onboard, and deleted by `onboard --remove`; a file of the
 * same name that is not ours is never touched.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_GUIDES, CLAUDE_CODE_MANAGED_MARK, MANAGED_MARK, OPERATOR_SKILL_MARK } from "./skills.js";
import type { ProviderConnection } from "./provider-connection.js";
import { connectionWords } from "./control-ui.js";
import { envelopeJson } from "./envelope.js";

export type OnboardAgent = "claude" | "codex";
export const ONBOARD_AGENTS: readonly OnboardAgent[] = ["claude", "codex"];
export const AGENT_NAMES: Record<OnboardAgent, string> = { claude: "Claude Code", codex: "Codex" };

/** Each agent's user-level home: where its skills folder lives. */
export function agentHome(agent: OnboardAgent, home: string, env: Record<string, string | undefined>): string {
  if (agent === "codex") return env["CODEX_HOME"] !== undefined && env["CODEX_HOME"] !== "" ? env["CODEX_HOME"] : join(home, ".codex");
  return join(home, ".claude");
}

export function operatorSkillPath(agent: OnboardAgent, home: string, env: Record<string, string | undefined>): string {
  return join(agentHome(agent, home, env), "skills", "toolroll", "SKILL.md");
}

/** The agents this person uses: those whose home folder exists, else Claude Code. */
export function detectAgents(home: string, env: Record<string, string | undefined>): OnboardAgent[] {
  const found = ONBOARD_AGENTS.filter(agent => existsSync(agentHome(agent, home, env)));
  return found.length > 0 ? found : ["claude"];
}

/** The line that adds Toolroll as tools. Printed, never run. */
export function mcpLine(agent: OnboardAgent): string {
  return `${agent} mcp add toolroll -- toolroll mcp`;
}

/** The thin skill: when to reach for Toolroll, and where the real guides are. */
export function operatorSkillContent(version: string): string {
  return `---
name: toolroll
description: Hand coding work to this machine's Toolroll and see it through. Use when the person wants work done unattended ("queue these bugs overnight"), asks what needs them, wants to wait on or review a result, or wants finished work released.
---

${OPERATOR_SKILL_MARK} · written by toolroll ${version}. \`toolroll onboard --yes\` replaces this file; \`toolroll onboard --remove --yes\` deletes it. -->

# Toolroll

You lead this person's Toolroll. Its agents build; the person approves.

- **Hand off** work that can run without anyone watching: a batch of bugs, a refactor, anything overnight.
- **Wait** on handed-off work with Toolroll instead of checking by hand.
- **Review**: say what needs the person, and open finished results.
- **Release** a result the person accepted through Toolroll's own publishing, never by pushing it yourself.

Read the guides from the installed binary. They match its version, so do not copy them:

- \`toolroll skills get operating\`: the commands, their JSON answers, and what you must never do.
- \`toolroll skills get console\`: which screen does what, for the person.
- \`toolroll skills list\`: every other guide.

Approving work and answering decisions belong to the person. Never read out or repeat their password.
`;
}

/** A regular file of ours: our frontmatter and one of our marks. */
function ownSkill(path: string): boolean {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 2_000_000) return false;
  const content = readFileSync(path, "utf8");
  return content.startsWith("---\nname: toolroll\n") && [OPERATOR_SKILL_MARK, CLAUDE_CODE_MANAGED_MARK, MANAGED_MARK].some(mark => content.includes(mark));
}

/** Guide copies an older `skills install --claude-code` left beside SKILL.md. */
function oldGuideCopies(folder: string): string[] {
  return CLAUDE_CODE_GUIDES.map(name => join(folder, `${name}.md`)).filter(path => {
    try {
      const entry = lstatSync(path);
      return !entry.isSymbolicLink() && entry.isFile() && entry.size <= 2_000_000 && readFileSync(path, "utf8").startsWith(`${CLAUDE_CODE_MANAGED_MARK}\n\n`);
    } catch {
      return false;
    }
  });
}

export type SkillStep = {
  agent: OnboardAgent;
  path: string;
  /** create/replace/remove change the file; current and absent change nothing; not-ours refuses. */
  action: "create" | "replace" | "current" | "remove" | "absent" | "not-ours";
  /** Old guide copies of ours that go with it. */
  alsoRemove: string[];
};

/** What install (or --remove) would do, without writing anything. */
export function planOperatorSkill(agents: readonly OnboardAgent[], options: { home: string; env: Record<string, string | undefined>; version: string; remove: boolean }): SkillStep[] {
  return agents.map(agent => {
    const path = operatorSkillPath(agent, options.home, options.env);
    const folder = join(path, "..");
    let folderIsReal = true;
    try {
      const entry = lstatSync(folder);
      folderIsReal = entry.isDirectory() && !entry.isSymbolicLink();
    } catch {
      return { agent, path, action: options.remove ? "absent" : "create", alsoRemove: [] };
    }
    if (!folderIsReal) return { agent, path, action: "not-ours", alsoRemove: [] };
    const alsoRemove = oldGuideCopies(folder);
    if (!lstatExists(path)) {
      return { agent, path, action: options.remove ? (alsoRemove.length > 0 ? "remove" : "absent") : "create", alsoRemove };
    }
    if (!ownSkill(path)) return { agent, path, action: "not-ours", alsoRemove: [] };
    if (options.remove) return { agent, path, action: "remove", alsoRemove };
    const current = readFileSync(path, "utf8") === operatorSkillContent(options.version);
    return { agent, path, action: current && alsoRemove.length === 0 ? "current" : "replace", alsoRemove };
  });
}

function lstatExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** Carry out a plan. Steps that are not ours, current, or absent change nothing. */
export function applyOperatorSkill(steps: readonly SkillStep[], version: string): { wrote: string[]; removed: string[] } {
  const wrote: string[] = [];
  const removed: string[] = [];
  for (const step of steps) {
    const folder = join(step.path, "..");
    if (step.action === "create" || step.action === "replace") {
      mkdirSync(folder, { recursive: true });
      writeFileSync(step.path, operatorSkillContent(version));
      wrote.push(step.path);
    }
    if (step.action === "create" || step.action === "replace" || step.action === "remove") {
      for (const path of step.alsoRemove) {
        unlinkSync(path);
        removed.push(path);
      }
    }
    if (step.action === "remove") {
      if (lstatExists(step.path)) {
        unlinkSync(step.path);
        removed.push(step.path);
      }
      if (readdirSync(folder).length === 0) rmdirSync(folder);
    }
  }
  return { wrote, removed };
}

export type Handoff = {
  console: string;
  /** How to start the console when it is not running. */
  start: string;
  /** The saved login: the account and the file. Never the password. */
  login: { account: string | null; file: string } | null;
  phone: string;
  next: readonly string[];
};

export const NEXT_THINGS = ["queue these bugs overnight", "what needs me?", "open the result"] as const;

export function buildHandoff(input: { url: string; loginFile: string | null; account: string | null }): Handoff {
  return {
    console: input.url,
    start: "toolroll up",
    login: input.loginFile === null ? null : { account: input.account, file: input.loginFile },
    phone: "Open the console on your phone over your tailnet, or pair Telegram in Settings → Telegram with the /pair code it shows.",
    next: NEXT_THINGS,
  };
}

export function handoffLines(handoff: Handoff): string[] {
  const login = handoff.login === null
    ? "no saved login yet; `toolroll up` creates one"
    : `${handoff.login.account === null ? "the account" : handoff.login.account} — the password is in ${handoff.login.file}`;
  return [
    "Toolroll is ready.",
    `  console   ${handoff.console}`,
    `  login     ${login}`,
    `  phone     ${handoff.phone}`,
    `  say next  ${handoff.next.map(one => `"${one}"`).join(" · ")}`,
  ];
}

/** The account name from a saved login file, never its password. */
export function loginAccount(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const cut = raw.indexOf(" ");
    return cut > 0 ? raw.slice(0, cut) : null;
  } catch {
    return null;
  }
}

export type AgentReport = { agent: OnboardAgent; name: string; state: ProviderConnection["state"]; words: string; plan?: string };

export function agentReport(agent: OnboardAgent, connection: ProviderConnection): AgentReport {
  return { agent, name: AGENT_NAMES[agent], state: connection.state, words: connectionWords(connection), ...(connection.plan === undefined ? {} : { plan: connection.plan }) };
}

export type OnboardIo = {
  write: (line: string) => void;
  json: boolean;
  yes: boolean;
  remove: boolean;
  /** --agent, as typed: a comma list of claude and codex. */
  agentFlag: string | undefined;
  url: string;
  loginFile: string;
  home: string;
  env: Record<string, string | undefined>;
  version: string;
  cwd: string;
  /** A person at a terminal who can be asked y/N. */
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** The repository top folder containing cwd, or null outside one. */
  findRepo: (cwd: string) => Promise<string | null>;
  /** Add a repository as a project, as Projects → add does. */
  enroll: (repo: string) => Promise<{ ok: true; added: boolean } | { ok: false; message: string }>;
  checkConnection: (agent: OnboardAgent) => Promise<ProviderConnection>;
};

type SkillAnswer = { state: "written" | "current" | "needs-yes" | "declined" | "not-ours" | "removed" | "absent"; files: SkillStep[]; wrote: string[]; removed: string[] };

/** Returns the exit code: 0 done, 2 usage, 3 a refusal to answer. */
export async function runOnboard(io: OnboardIo): Promise<number> {
  const command = "onboard";
  const refuse = (reason: string, message: string, code: number, extra: Record<string, unknown> = {}): number => {
    io.write(io.json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
    return code;
  };

  let agents: OnboardAgent[];
  if (io.agentFlag !== undefined) {
    const asked = io.agentFlag.split(",").map(one => one.trim()).filter(one => one !== "");
    const unknown = asked.filter(one => !(ONBOARD_AGENTS as readonly string[]).includes(one));
    if (asked.length === 0 || unknown.length > 0) return refuse("usage", "--agent takes claude, codex, or claude,codex", 2);
    agents = [...new Set(asked as OnboardAgent[])];
  } else {
    agents = detectAgents(io.home, io.env);
  }

  // The skill: validate every file first, then ask once, then write.
  const steps = planOperatorSkill(agents, { home: io.home, env: io.env, version: io.version, remove: io.remove });
  const changes = steps.filter(step => step.action === "create" || step.action === "replace" || step.action === "remove");
  const foreign = steps.filter(step => step.action === "not-ours");
  let skill: SkillAnswer;
  if (foreign.length > 0) {
    skill = { state: "not-ours", files: steps, wrote: [], removed: [] };
  } else if (changes.length === 0) {
    skill = { state: io.remove ? "absent" : "current", files: steps, wrote: [], removed: [] };
  } else {
    const paths = changes.map(step => step.path);
    const consent = io.yes || (io.interactive && !io.json && (await io.confirm(`${io.remove ? "Remove" : "Write"} ${paths.join(" and ")}? [y/N]`)));
    if (!consent) {
      skill = { state: io.interactive && !io.json && !io.yes ? "declined" : "needs-yes", files: steps, wrote: [], removed: [] };
    } else {
      const done = applyOperatorSkill(steps, io.version);
      skill = { state: io.remove ? "removed" : "written", files: steps, ...done };
    }
  }
  const skillLine = (): string => {
    const where = (list: readonly SkillStep[]) => list.map(step => step.path).join(", ");
    switch (skill.state) {
      case "written": return `skill     wrote ${skill.wrote.join(", ")}`;
      case "removed": return `skill     removed ${skill.removed.join(", ")}`;
      case "current": return `skill     up to date: ${where(steps)}`;
      case "absent": return "skill     not installed; nothing to remove";
      case "not-ours": return `skill     ${where(foreign)} ${foreign.length === 1 ? "is" : "are"} not Toolroll's, so nothing was ${io.remove ? "removed" : "written"}`;
      case "declined": return `skill     nothing ${io.remove ? "removed" : "written"}`;
      case "needs-yes": return `skill     not ${io.remove ? "removed" : "written"} yet: run again with --yes to ${io.remove ? "remove" : "write"} ${where(changes)}`;
    }
  };
  const skillData = { state: skill.state, files: skill.files.map(step => ({ agent: step.agent, path: step.path, action: step.action })), wrote: skill.wrote, removed: skill.removed };

  if (io.remove) {
    if (skill.state === "not-ours") return refuse("not-ours", skillLine().replace(/^skill\s+/, ""), 3, { skill: skillData });
    if (skill.state === "needs-yes" || skill.state === "declined") {
      return refuse("unconfirmed", skillLine().replace(/^skill\s+/, ""), 3, { skill: skillData });
    }
    io.write(io.json ? envelopeJson({ ok: true, command, skill: skillData }) : skillLine());
    return 0;
  }

  // The project, then who is signed in.
  const repo = await io.findRepo(io.cwd);
  let project: { path: string; added: boolean } | null = null;
  let projectProblem: string | null = null;
  if (repo !== null) {
    const enrolled = await io.enroll(repo);
    if (enrolled.ok) project = { path: repo, added: enrolled.added };
    else projectProblem = enrolled.message;
  }
  const reports = await Promise.all(ONBOARD_AGENTS.map(async agent => agentReport(agent, await io.checkConnection(agent))));
  const handoff = buildHandoff({ url: io.url, loginFile: existsSync(io.loginFile) ? io.loginFile : null, account: loginAccount(io.loginFile) });
  const mcp = agents.map(agent => ({ agent, command: mcpLine(agent) }));

  if (io.json) {
    io.write(envelopeJson({
      ok: true,
      command,
      project,
      ...(repo === null ? { projectProblem: "not inside a git repository" } : projectProblem === null ? {} : { projectProblem }),
      agents: reports,
      skill: skillData,
      mcp,
      handoff,
    }));
    return 0;
  }
  const projectLine = project !== null
    ? `project   ${project.path} — ${project.added ? "added" : "already added"}`
    : repo === null ? "project   none added: run onboard inside the repository you want to hand off" : `project   ${repo} could not be added — ${projectProblem}`;
  io.write([
    projectLine,
    `agents    ${reports.map(one => `${one.name}: ${[one.words, one.plan].filter(Boolean).join(" · ")}`).join("; ")}`,
    skillLine(),
    ...mcp.map((one, index) => `${index === 0 ? "tools    " : "         "} ${one.command}   (add Toolroll as tools; not run)`),
    "",
    ...handoffLines(handoff),
  ].join("\n"));
  return 0;
}
