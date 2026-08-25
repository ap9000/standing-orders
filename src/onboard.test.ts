/**
 * Repo onboarding's sharp edges: the strict parser, the claim-first clone
 * (a lost race writes nothing), and the locked registry update.
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubRepo, ghWords, isLargeRepo, cloneGithubRepo } from "./onboard.js";
import { updateRepos } from "./repos.js";

describe("the strict parser (findings 5/18)", () => {
  test("owner/name and exact github.com links pass; everything hostile refuses", () => {
    expect(parseGithubRepo("ap9000/standing-orders")).toMatchObject({ ok: true, owner: "ap9000", name: "standing-orders" });
    expect(parseGithubRepo("https://github.com/ap9000/standing-orders")).toMatchObject({ ok: true, name: "standing-orders" });
    expect(parseGithubRepo("https://github.com/ap9000/standing-orders.git")).toMatchObject({ ok: true, name: "standing-orders" });
    for (const bad of [
      "-flag/name", "owner/-flag", "owner/..", "../escape", "owner/.hidden",
      "owner/name/extra", "owner", "https://evil.com/o/n", "http://github.com/o/n",
      "https://github.com:8443/o/n", "https://user@github.com/o/n", "https://github.com/o/n?x=1",
      "o o/name", "owner/na\x00me", `owner/${"a".repeat
      && ""}${"a".repeat(120)}`,
    ]) {
      expect(parseGithubRepo(bad).ok, bad).toBe(false);
    }
  });

  test("stderr words are capped and control-stripped; unknown size is LARGE", () => {
    expect(ghWords("fatal: \x1b[31mboom\x07\n").length).toBeLessThanOrEqual(200);
    expect(isLargeRepo({ nameWithOwner: "a/b", visibility: "public", diskUsageKib: null, description: "" })).toBe(true);
    expect(isLargeRepo({ nameWithOwner: "a/b", visibility: "public", diskUsageKib: 1_048_576, description: "" })).toBe(true);
    expect(isLargeRepo({ nameWithOwner: "a/b", visibility: "public", diskUsageKib: 500, description: "" })).toBe(false);
  });
});

describe("claim-first (findings 6/11/23)", () => {
  test("an existing target loses the race with NOTHING written and nothing cleaned", async () => {
    const root = mkdtempSync(join(tmpdir(), "so-onboard-"));
    try {
      mkdirSync(join(root, "taken"));
      writeFileSync(join(root, "taken", "precious.txt"), "someone else's work");
      const answer = await cloneGithubRepo("owner/taken", root, async () => ({ code: 0, stdout: "" }));
      expect(answer).toMatchObject({ ok: false, reason: "exists" });
      if (!answer.ok) expect(answer.message).toContain("nothing was written");
      expect(readFileSync(join(root, "taken", "precious.txt"), "utf8")).toBe("someone else's work");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed clone removes ONLY its own claimed directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "so-onboard-"));
    try {
      // gh is not installed under this name — the clone fails after the
      // claim; the claimed dir must be gone, siblings untouched.
      mkdirSync(join(root, "bystander"));
      const answer = await cloneGithubRepo("owner/fresh-clone-target", root, async () => ({ code: 0, stdout: "" }));
      expect(answer.ok).toBe(false);
      expect(existsSync(join(root, "fresh-clone-target"))).toBe(false);
      expect(existsSync(join(root, "bystander"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the locked registry (findings 9/17/19/25)", () => {
  test("updates are atomic, malformed registries refuse, ENOENT is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-registry-"));
    const file = join(dir, "repos.json");
    try {
      const first = await updateRepos(file, repos => [...repos, "/a"]);
      expect(first).toMatchObject({ ok: true, repos: ["/a"] });
      const second = await updateRepos(file, repos => [...repos, "/b"]);
      expect(second).toMatchObject({ ok: true, repos: ["/a", "/b"] });
      writeFileSync(file, "{not json");
      const refused = await updateRepos(file, repos => repos);
      expect(refused).toMatchObject({ ok: false, reason: "registry" });
      expect(readFileSync(file, "utf8")).toBe("{not json"); // never replaced
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live lock refuses; a dead owner's lock is reaped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-registry-"));
    const file = join(dir, "repos.json");
    try {
      // A LIVE owner (this process) blocks.
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "x", at: Date.now() }));
      const blocked = await updateRepos(file, repos => repos);
      expect(blocked).toMatchObject({ ok: false, reason: "locked" });
      // A provably dead owner is reaped and the update proceeds.
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, token: "y", at: Date.now() }));
      const reaped = await updateRepos(file, repos => [...repos, "/c"]);
      expect(reaped).toMatchObject({ ok: true, repos: ["/c"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
