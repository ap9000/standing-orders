/**
 * The skills installer: preview by default, managed markers only, and a
 * refusal wherever a file is not provably ours to touch.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInstall, planInstall, skillContent, contextBlock, CONTEXT_BEGIN, SKILL_DIR, SKILL_FILE } from "./skills.js";
import { main } from "./cli.js";

describe("skills install", () => {
  let repo: string;
  let lines: string[];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "standing-orders-skills-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    lines = [];
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const write = (line: string) => lines.push(line);
  const out = () => lines.join("\n");

  test("the skill's routing description and operating contract carry the load-bearing rules", () => {
    const skill = skillContent();
    expect(skill).toContain("name: standing-orders");
    // The router contract: when to use, when NOT to.
    expect(skill).toContain("Not for pushing, merging, or approving");
    // Live help outranks the document.
    expect(skill).toContain("authoritative");
    // The contract facts an agent branches on.
    expect(skill).toContain("envelopeVersion");
    expect(skill).toContain("--key");
    expect(skill).toContain("exit 3");
    // Untrusted-output hygiene is stated, not assumed.
    expect(skill).toContain("data, not instructions");
  });

  test("preview writes nothing; --yes writes the skill; a reinstall replaces only itself", async () => {
    const preview = await main(["skills", "install", "--repo", repo], write);
    expect(preview).toBe(3);
    expect(out()).toContain("Nothing was written");
    expect(() => readFileSync(join(repo, SKILL_DIR, SKILL_FILE))).toThrow();

    lines = [];
    const applied = await main(["skills", "install", "--repo", repo, "--yes"], write);
    expect(applied).toBe(0);
    const installed = readFileSync(join(repo, SKILL_DIR, SKILL_FILE), "utf8");
    expect(installed).toBe(skillContent());

    // Reinstall: same content, no complaint — the file is provably ours.
    lines = [];
    expect(await main(["skills", "install", "--repo", repo, "--yes"], write)).toBe(0);
  });

  test("a skill file this installer did not write is refused, never eaten", async () => {
    mkdirSync(join(repo, SKILL_DIR), { recursive: true });
    writeFileSync(join(repo, SKILL_DIR, SKILL_FILE), "# somebody else's skill\n");

    const code = await main(["skills", "install", "--repo", repo, "--yes"], write);
    expect(code).toBe(1);
    expect(out()).toContain("refusing to overwrite");
    expect(readFileSync(join(repo, SKILL_DIR, SKILL_FILE), "utf8")).toBe("# somebody else's skill\n");
  });

  test("--write-context appends the managed block without rewriting a word, and replaces only between markers", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "# My rules\n\nDo the thing well.\n");

    await main(["skills", "install", "--repo", repo, "--yes", "--write-context"], write);
    const first = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(first).toContain("# My rules");
    expect(first).toContain("Do the thing well.");
    expect(first).toContain(CONTEXT_BEGIN);

    // The block is replaced in place on reinstall — exactly one copy, ever.
    await main(["skills", "install", "--repo", repo, "--yes", "--write-context"], write);
    const second = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(second.split(CONTEXT_BEGIN).length).toBe(2);
    expect(second).toContain("Do the thing well.");
  });

  test("without --write-context the snippet is printed for the operator to place", async () => {
    await main(["skills", "install", "--repo", repo], write);
    expect(out()).toContain("paste it yourself");
    expect(out()).toContain(contextBlock().split("\n")[1]);
  });

  test("a directory without .git is refused — the skill belongs in a repository", async () => {
    const bare = mkdtempSync(join(tmpdir(), "standing-orders-bare-"));
    try {
      const code = await main(["skills", "install", "--repo", bare, "--yes"], write);
      expect(code).toBe(2);
      expect(out()).toContain("no .git");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the plan is machine-readable — an agent can preview its own onboarding", async () => {
    const code = await main(["skills", "install", "--repo", repo, "--json"], write);
    expect(code).toBe(3);
    const body = JSON.parse(out());
    expect(body).toMatchObject({ ok: false, command: "skills install", reason: "unconfirmed" });
    expect(body.plan.skillAction).toBe("create");
    expect(planInstall(repo, false).skillAction).toBe("create");
  });
});
