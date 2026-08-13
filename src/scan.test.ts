import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepos } from "./scan.js";

/**
 * A real directory tree, because the bugs worth catching here — symlink cycles,
 * skip rules, depth cutoffs — are properties of a filesystem, not of a mock.
 */
let base: string;
let root: string;
let outside: string;

const makeRepo = (path: string) => mkdir(join(path, ".git"), { recursive: true });

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "standing-orders-scan-"));
  root = join(base, "root");
  outside = join(base, "outside");

  await makeRepo(join(root, "alpha"));
  await makeRepo(join(root, "nested", "beta"));
  await makeRepo(join(root, "deep", "a", "b", "repo"));
  await makeRepo(join(root, "vendored", "node_modules", "pkg"));
  await makeRepo(join(root, ".hidden", "repo"));
  await makeRepo(join(outside, "gamma"));
  await mkdir(join(root, "plain", "sub"), { recursive: true });

  // git writes a `.git` *file* for linked worktrees and submodules
  await mkdir(join(root, "pointer"), { recursive: true });
  await writeFile(join(root, "pointer", ".git"), "gitdir: /elsewhere/.git/worktrees/pointer\n");

  await symlink(outside, join(root, "link"), "dir");
  await symlink(root, join(root, "loop"), "dir");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("findRepos", () => {
  test("finds every repo in the tree, skipping vendored and hidden directories", async () => {
    // Act
    const result = await findRepos([root]);

    // Assert — an exact set, so a new escape hatch cannot slip in unnoticed
    expect(result).toEqual([
      join(root, "alpha"),
      join(root, "deep", "a", "b", "repo"),
      join(root, "nested", "beta"),
      join(root, "pointer"),
    ]);
  });

  test("treats a .git file as a repo, not only a .git directory", async () => {
    const result = await findRepos([root]);

    expect(result).toContain(join(root, "pointer"));
  });

  test("does not descend through symlinks, so a cycle cannot hang the scan", async () => {
    // root/loop points at root and root/link points outside the scanned tree
    const result = await findRepos([root]);

    expect(result.some(path => path.includes("loop"))).toBe(false);
    expect(result.some(path => path.includes("link"))).toBe(false);
  });

  test("stops at a repo rather than descending into it", async () => {
    // a checkout's own node_modules can hold thousands of vendored repos
    const result = await findRepos([root]);

    expect(result).not.toContain(join(root, "vendored", "node_modules", "pkg"));
  });

  test("honours maxDepth", async () => {
    const result = await findRepos([root], { maxDepth: 2 });

    expect(result).toEqual([
      join(root, "alpha"),
      join(root, "nested", "beta"),
      join(root, "pointer"),
    ]);
  });

  test("includes dot-directories only when asked", async () => {
    const result = await findRepos([root], { includeHidden: true });

    expect(result).toContain(join(root, ".hidden", "repo"));
  });

  test("returns an empty array for a root that does not exist", async () => {
    // an unreadable or missing directory must not end discovery of the others
    const result = await findRepos([join(base, "nope")]);

    expect(result).toEqual([]);
  });

  test("deduplicates repos reachable from overlapping roots", async () => {
    const result = await findRepos([root, join(root, "nested")]);

    expect(result.filter(path => path === join(root, "nested", "beta"))).toHaveLength(1);
  });
});
