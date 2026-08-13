import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadRepos, saveRepos, addRepos, removeRepos } from "./repos.js";

const HOME = "/Users/someone";

describe("configPath", () => {
  test("honours XDG_CONFIG_HOME", () => {
    const path = configPath({ XDG_CONFIG_HOME: "/xdg" }, HOME);

    expect(path).toBe(join("/xdg", "standing-orders", "repos.json"));
  });

  test("falls back to ~/.config", () => {
    expect(configPath({}, HOME)).toBe(join(HOME, ".config", "standing-orders", "repos.json"));
    expect(configPath({ XDG_CONFIG_HOME: "" }, HOME)).toBe(
      join(HOME, ".config", "standing-orders", "repos.json"),
    );
  });
});

describe("loadRepos", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-repos-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("treats a missing file as nobody having enrolled yet", async () => {
    // First run is the common case and is not an error.
    const result = await loadRepos(join(base, "nope", "repos.json"));

    expect(result).toEqual({ repos: [] });
  });

  test("round-trips through save, creating the directory", async () => {
    const file = join(base, "config", "standing-orders", "repos.json");

    await saveRepos(file, ["/code/b", "/code/a"]);

    expect(await loadRepos(file)).toEqual({ repos: ["/code/a", "/code/b"] });
  });

  test("writes JSON a human can read and edit", async () => {
    const file = join(base, "repos.json");

    await saveRepos(file, ["/code/a"]);

    const text = await readFile(file, "utf8");
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("names the file when its contents are not JSON", async () => {
    // It is a file people are invited to edit, so it will sometimes be broken.
    const file = join(base, "repos.json");
    await writeFile(file, "{ not json");

    const result = await loadRepos(file);

    expect("error" in result && result.error).toContain(file);
  });

  test("rejects a file whose shape is wrong rather than trusting it", async () => {
    const file = join(base, "repos.json");
    await writeFile(file, JSON.stringify({ version: 1, repos: "everything" }));

    const result = await loadRepos(file);

    expect("error" in result).toBe(true);
  });

  test("ignores entries that are not strings", async () => {
    const file = join(base, "repos.json");
    await writeFile(file, JSON.stringify({ version: 1, repos: ["/code/a", 7, null] }));

    const result = await loadRepos(file);

    expect(result).toEqual({ repos: ["/code/a"] });
  });

  test("reads a directory that exists but holds no config", async () => {
    await mkdir(join(base, "empty"), { recursive: true });

    expect(await loadRepos(join(base, "empty", "repos.json"))).toEqual({ repos: [] });
  });
});

describe("addRepos and removeRepos", () => {
  test("adds without duplicating, and keeps the list sorted", () => {
    const result = addRepos(["/code/b"], ["/code/a", "/code/b"]);

    expect(result).toEqual(["/code/a", "/code/b"]);
  });

  test("does not mutate the list it was given", () => {
    const existing = ["/code/b"];

    addRepos(existing, ["/code/a"]);

    expect(existing).toEqual(["/code/b"]);
  });

  test("removes only what was named", () => {
    expect(removeRepos(["/code/a", "/code/b"], ["/code/a"])).toEqual(["/code/b"]);
  });

  test("removing something absent is not an error", () => {
    expect(removeRepos(["/code/a"], ["/code/z"])).toEqual(["/code/a"]);
  });
});
