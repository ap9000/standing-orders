/**
 * `standing-orders skills install` (M7.13) — how a repository tells its
 * agents this queue exists.
 *
 * Two artifacts, both operator-invoked, previewed by default, and marked
 * as managed so nothing here ever overwrites a file it does not own:
 *
 *   - `.claude/skills/standing-orders/SKILL.md` — the Agent Skills entry
 *     (the cross-vendor layout Claude Code, Codex, Gemini CLI, and
 *     opencode all read). Router-style: the description says when to
 *     reach for the CLI; the body carries the operating contract and
 *     defers to live `--help` for everything else, because a skill that
 *     duplicates the manual drifts from it.
 *   - a managed AGENTS.md block (CLAUDE.md-compatible), written only
 *     with --write-context, replaced only between its own markers.
 *
 * DESIGN's "nothing is ever installed for you" holds: this command runs
 * when the operator runs it, shows exactly what it would write, and
 * touches nothing without --yes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { guideNamed } from "./guides.js";

export const SKILL_DIR = join(".claude", "skills", "standing-orders");
export const SKILL_FILE = "SKILL.md";
export const MANAGED_MARK = "managed by standing-orders — edits outside the markers survive reinstalls";
export const CONTEXT_BEGIN = "<!-- standing-orders:begin -->";
export const CONTEXT_END = "<!-- standing-orders:end -->";

/** The skill, complete. The description is the routing contract. The body
 * is the binary-served `operating` guide (guides.ts) — ONE source, so the
 * installed snapshot and `skills get operating` cannot drift apart within
 * a version. The frontmatter prefix and the managed mark are the ownership
 * signature planInstall checks — do not reword them. */
export function skillContent(): string {
  const operating = guideNamed("operating");
  if (operating === null) throw new Error("the operating guide is missing from the build");
  return `---
name: standing-orders
description: Operate this repository's unattended work queue via the standing-orders CLI, and explain its console. Use when asked to file or inspect tasks (including scout tasks that deliver a report), check what is ready or blocked, peek at live agents, read run results and briefs, see what awaits a human decision, or tell the operator which screen or command does what. Not for pushing, merging, or approving anything — approvals are the operator's, always.
---

<!-- ${MANAGED_MARK} -->

${operating.content}
<!-- end ${MANAGED_MARK} -->
`;
}

/** The AGENTS.md block, marker-fenced so reinstalls replace only themselves. */
export function contextBlock(): string {
  return `${CONTEXT_BEGIN}
This repository's unattended work runs through the \`standing-orders\` CLI
(work queue, decisions, runs). Machine answers: add \`--json\` — one
envelope per command, stable \`reason\` tokens, exit 3 means "no" not
"broken", every mutation takes an idempotency \`--key\`. Refusals like
\`held\`, \`fenced\`, \`reserved\`, \`unapproved\`, and \`external\` are
answers to branch on, not errors to retry. Details:
\`.claude/skills/standing-orders/SKILL.md\`, or \`standing-orders --help\`,
which is authoritative — and \`standing-orders skills get <name>\` serves
version-matched guides straight from the binary (\`skills list\` names
them). Never approve, push, or merge anything yourself.
${CONTEXT_END}`;
}

export type InstallPlan = {
  skillPath: string;
  skillAction: "create" | "replace" | "refuse-foreign";
  contextPath: string | null;
  contextAction: "create" | "insert" | "replace" | "skip";
};

export type InstallResult =
  | { ok: true; plan: InstallPlan; wrote: string[] }
  | { ok: false; reason: "foreign-skill" | "broken-markers"; message: string };

/** What install would do, computed without writing anything. */
export function planInstall(repo: string, writeContext: boolean): InstallPlan {
  const skillPath = join(repo, SKILL_DIR, SKILL_FILE);
  let skillAction: InstallPlan["skillAction"] = "create";
  if (existsSync(skillPath)) {
    const current = readFileSync(skillPath, "utf8");
    // Ownership is the exact header AND the managed mark — a foreign file
    // that merely quotes the mark somewhere is not ours (audit C-10).
    const ours = current.startsWith("---\nname: standing-orders\n") && current.includes(MANAGED_MARK);
    skillAction = ours ? "replace" : "refuse-foreign";
  }

  const contextPath = writeContext ? join(repo, "AGENTS.md") : null;
  let contextAction: InstallPlan["contextAction"] = "skip";
  if (contextPath !== null) {
    if (!existsSync(contextPath)) contextAction = "create";
    else {
      const current = readFileSync(contextPath, "utf8");
      contextAction = current.includes(CONTEXT_BEGIN) ? "replace" : "insert";
    }
  }
  return { skillPath, skillAction, contextPath, contextAction };
}

/** Apply the plan. Refuses a foreign skill file rather than eating it. */
export function applyInstall(repo: string, writeContext: boolean): InstallResult {
  const plan = planInstall(repo, writeContext);
  if (plan.skillAction === "refuse-foreign") {
    return {
      ok: false,
      reason: "foreign-skill",
      message: `${plan.skillPath} exists and was not written by this installer — refusing to overwrite a file that is not mine`,
    };
  }
  // EVERY validation happens before EITHER file is touched — "nothing was
  // written" must be true when it is said (arc-5 review, finding 6; the
  // old order wrote the skill first and then refused on damaged markers).
  let contextNext: string | null = null;
  if (plan.contextPath !== null && plan.contextAction !== "create") {
    const current = readFileSync(plan.contextPath, "utf8");
    if (plan.contextAction === "replace") {
      // Exactly one well-ordered pair, or a typed refusal — a half block
      // must never produce a silent false success (audit C-10).
      const begins = current.split(CONTEXT_BEGIN).length - 1;
      const ends = current.split(CONTEXT_END).length - 1;
      const begin = current.indexOf(CONTEXT_BEGIN);
      const end = current.indexOf(CONTEXT_END);
      if (begins !== 1 || ends !== 1 || end <= begin) {
        return {
          ok: false,
          reason: "broken-markers",
          message: `${plan.contextPath} carries a damaged managed block (${begins} begin, ${ends} end marker(s)) — repair or remove it by hand; nothing was written`,
        };
      }
      contextNext = current.slice(0, begin) + contextBlock() + current.slice(end + CONTEXT_END.length);
    } else {
      // insert: append after existing content, never rewriting a word of it.
      contextNext = `${current.replace(/\n*$/, "\n\n")}${contextBlock()}\n`;
    }
  }

  const wrote: string[] = [];
  mkdirSync(dirname(plan.skillPath), { recursive: true });
  writeFileSync(plan.skillPath, skillContent());
  wrote.push(plan.skillPath);

  if (plan.contextPath !== null) {
    writeFileSync(plan.contextPath, contextNext ?? `${contextBlock()}\n`);
    wrote.push(plan.contextPath);
  }
  return { ok: true, plan, wrote };
}
