import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { guideNamed } from "./guides.js";
import {
  applyClaudeCodeInstall,
  CLAUDE_CODE_MANAGED_MARK,
  claudeCodeGuideContent,
  defaultClaudeCodeSkillDir,
  planClaudeCodeInstall,
} from "./skills.js";

describe("Claude Code skill install", () => {
  const roots: string[] = [];
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), "standing-orders-claude-skill-"));
    roots.push(root);
    return join(root, "standing-orders");
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("uses Claude Code's user skill location by default", () => {
    expect(defaultClaudeCodeSkillDir("/home/alex")).toBe(join("/home/alex", ".claude", "skills", "standing-orders"));
  });

  test("publishes the Claude Code mode in help and the command contract", async () => {
    let lines: string[] = [];
    expect(await main(["--help"], line => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("skills install --claude-code [--dir <path>]");

    lines = [];
    expect(await main(["contract", "--commands", "--json"], line => lines.push(line))).toBe(0);
    const row = JSON.parse(lines.join("\n")).commands.find((command: { invocation: string }) => command.invocation === "skills install");
    expect(row).toMatchObject({
      mutation: "identity-idempotent",
      flags: expect.arrayContaining([
        { name: "claude-code", takesValue: false, meaning: expect.any(String) },
        { name: "dir", takesValue: true, meaning: expect.any(String) },
      ]),
    });
  });

  test("previews every file without creating the directory", async () => {
    const directory = fresh();
    const lines: string[] = [];

    const code = await main(["skills", "install", "--claude-code", "--dir", directory, "--json"], line => lines.push(line));

    expect(code).toBe(3);
    expect(existsSync(directory)).toBe(false);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: false,
      command: "skills install",
      reason: "unconfirmed",
      plan: {
        directory,
        files: [
          { name: "SKILL.md", action: "create" },
          { name: "console.md", action: "create" },
          { name: "operating.md", action: "create" },
          { name: "runner.md", action: "create" },
        ],
      },
    });
  });

  test("--yes writes SKILL.md and the three guides embedded in the binary", async () => {
    const directory = fresh();
    const lines: string[] = [];

    const code = await main(["skills", "install", "--claude-code", "--dir", directory, "--yes", "--json"], line => lines.push(line));

    expect(code).toBe(0);
    const skill = readFileSync(join(directory, "SKILL.md"), "utf8");
    expect(skill).toContain("name: standing-orders");
    for (const name of ["console", "operating", "runner"] as const) {
      expect(skill).toContain(`(${name}.md)`);
      expect(readFileSync(join(directory, `${name}.md`), "utf8")).toBe(claudeCodeGuideContent(name));
      expect(readFileSync(join(directory, `${name}.md`), "utf8")).toContain(guideNamed(name)?.content);
    }
  });

  test("re-running refreshes every managed file", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    writeFileSync(join(directory, "operating.md"), `${CLAUDE_CODE_MANAGED_MARK}\n\nstale copy\n`);

    const refreshed = applyClaudeCodeInstall(directory);

    expect(refreshed.ok).toBe(true);
    expect(readFileSync(join(directory, "operating.md"), "utf8")).toBe(claudeCodeGuideContent("operating"));
    expect(planClaudeCodeInstall(directory).files.every(file => file.action === "replace")).toBe(true);
  });

  test("re-running leaves unrelated files untouched", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    const notes = join(directory, "my-notes.md");
    writeFileSync(notes, "keep my notes\n");

    expect(applyClaudeCodeInstall(directory).ok).toBe(true);

    expect(readFileSync(notes, "utf8")).toBe("keep my notes\n");
  });

  test("a foreign target refuses the whole refresh", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    const operating = join(directory, "operating.md");
    writeFileSync(operating, `${CLAUDE_CODE_MANAGED_MARK}\n\nstale but still managed\n`);
    writeFileSync(join(directory, "console.md"), "my custom guide\n");

    const result = applyClaudeCodeInstall(directory);

    expect(result).toMatchObject({ ok: false, reason: "foreign-file" });
    expect(readFileSync(join(directory, "console.md"), "utf8")).toBe("my custom guide\n");
    expect(readFileSync(operating, "utf8")).toContain("stale but still managed");
  });

  test("a preview names a foreign target without suggesting --yes", async () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    writeFileSync(join(directory, "console.md"), "my custom guide\n");
    const lines: string[] = [];

    expect(await main(["skills", "install", "--claude-code", "--dir", directory, "--json"], line => lines.push(line))).toBe(3);

    const answer = JSON.parse(lines.join("\n"));
    expect(answer.message).toContain("choose another --dir");
    expect(answer.message).not.toContain("Re-run with --yes");
  });

  test("--dir is specific to the Claude Code install", async () => {
    const lines: string[] = [];
    const code = await main(["skills", "install", "--dir", fresh(), "--json"], line => lines.push(line));
    expect(code).toBe(2);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "usage" });
  });
});
