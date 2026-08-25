/**
 * The skills installer: preview by default, managed markers only, and a
 * refusal wherever a file is not provably ours to touch.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("binary-served guides (arc 5)", () => {
  let lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const out = () => lines.join("\n");
  beforeEach(() => { lines = []; });

  test("skills list names every guide, text and envelope alike", async () => {
    expect(await main(["skills", "list"], write)).toBe(0);
    for (const name of ["operating", "runner", "steering", "external-work", "tournaments"]) {
      expect(out()).toContain(name);
    }
    lines = [];
    expect(await main(["skills", "list", "--json"], write)).toBe(0);
    const body = JSON.parse(out()) as { ok: boolean; guides: { name: string; content?: string }[] };
    expect(body.ok).toBe(true);
    expect(body.guides.map(one => one.name)).toContain("steering");
    // metadata only — no guide bodies ride the list (finding 8)
    expect(body.guides.every(one => one.content === undefined)).toBe(true);
  });

  test("skills get prints raw markdown; --json wraps exactly one guide", async () => {
    expect(await main(["skills", "get", "runner"], write)).toBe(0);
    expect(out()).toContain("# Working as a runner");
    expect(out()).toContain("authoritative");
    lines = [];
    expect(await main(["skills", "get", "runner", "--json"], write)).toBe(0);
    const body = JSON.parse(out()) as { ok: boolean; name: string; content: string };
    expect(body.name).toBe("runner");
    expect(body.content).toContain("fenced");
  });

  test("an unknown guide is exit 3 with the names listed; malformed invocations are usage", async () => {
    expect(await main(["skills", "get", "nope", "--json"], write)).toBe(3);
    expect(JSON.parse(out())).toMatchObject({ ok: false, reason: "unknown-skill" });
    expect(out()).toContain("operating");
    lines = [];
    expect(await main(["skills", "get"], write)).toBe(2);
    lines = [];
    expect(await main(["skills", "get", "runner", "--frobnicate"], write)).toBe(2);
    expect(out()).toContain("--frobnicate");
    lines = [];
    expect(await main(["skills", "list", "extra-word"], write)).toBe(2);
  });

  test("the installed SKILL.md body IS the operating guide — one source, no drift", async () => {
    const { GUIDES } = await import("./guides.js");
    const operating = GUIDES.find(one => one.name === "operating");
    expect(operating).toBeDefined();
    expect(skillContent()).toContain(operating?.content as string);
  });

  test("a SKILL.md written by an OLDER version is still ours to replace (finding 6)", () => {
    // A hard-coded legacy shape: the ownership signature (frontmatter
    // prefix + managed mark) around a body no current version generates.
    const legacy = [
      "---",
      "name: standing-orders",
      "description: Operate this repository's unattended work queue.",
      "---",
      "",
      "<!-- managed by standing-orders — edits outside the markers survive reinstalls -->",
      "",
      "# standing-orders (an old body from three versions ago)",
      "",
      "<!-- end managed by standing-orders — edits outside the markers survive reinstalls -->",
    ].join("\n");
    const repo = mkdtempSync(join(tmpdir(), "standing-orders-legacy-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, SKILL_DIR), { recursive: true });
      writeFileSync(join(repo, SKILL_DIR, SKILL_FILE), legacy);
      expect(planInstall(repo, false).skillAction).toBe("replace");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("damaged AGENTS.md markers refuse BEFORE anything is written (finding 6)", () => {
    const repo = mkdtempSync(join(tmpdir(), "standing-orders-preflight-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "AGENTS.md"), `${CONTEXT_BEGIN}\nno end marker anywhere`);
      const result = applyInstall(repo, true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("broken-markers");
      // the message says nothing was written — and it must be TRUE
      expect(existsSync(join(repo, SKILL_DIR, SKILL_FILE))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
