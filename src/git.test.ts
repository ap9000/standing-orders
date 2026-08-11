import { describe, test, expect } from "vitest";
import { parseWorktrees, parseBranches, parseTrack } from "./git.js";

describe("parseWorktrees", () => {
  test("reads path, head, and branch from a checked-out worktree", () => {
    // Arrange
    const porcelain = [
      "worktree /Users/a/proj",
      "HEAD 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      "branch refs/heads/main",
      "",
    ].join("\n");

    // Act
    const result = parseWorktrees(porcelain);

    // Assert
    expect(result).toEqual([
      {
        path: "/Users/a/proj",
        head: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        branch: "main",
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ]);
  });

  test("separates multiple worktrees on blank lines", () => {
    const porcelain = [
      "worktree /Users/a/proj",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /Users/a/.treehouse/proj-1",
      "HEAD bbb",
      "branch refs/heads/feature/onboarding",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);

    expect(result).toHaveLength(2);
    expect(result[1].path).toBe("/Users/a/.treehouse/proj-1");
    expect(result[1].branch).toBe("feature/onboarding");
  });

  test("marks a detached worktree with a null branch", () => {
    // treehouse leases worktrees in detached HEAD, so this is the common case
    const porcelain = ["worktree /Users/a/wt", "HEAD ccc", "detached", ""].join("\n");

    const result = parseWorktrees(porcelain);

    expect(result[0].detached).toBe(true);
    expect(result[0].branch).toBeNull();
  });

  test("flags bare, locked, and prunable worktrees", () => {
    const porcelain = [
      "worktree /Users/a/bare",
      "HEAD ddd",
      "bare",
      "",
      "worktree /Users/a/stale",
      "HEAD eee",
      "detached",
      "locked reason text",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const result = parseWorktrees(porcelain);

    expect(result[0].bare).toBe(true);
    expect(result[1].locked).toBe(true);
    expect(result[1].prunable).toBe(true);
  });

  test("preserves slashes in branch names", () => {
    const porcelain = ["worktree /p", "HEAD f", "branch refs/heads/feat/a/b", ""].join("\n");

    expect(parseWorktrees(porcelain)[0].branch).toBe("feat/a/b");
  });

  test("returns an empty array for empty input", () => {
    expect(parseWorktrees("")).toEqual([]);
    expect(parseWorktrees("\n\n")).toEqual([]);
  });

  test("tolerates a missing trailing blank line", () => {
    // git omits the final separator in some versions
    const porcelain = ["worktree /p", "HEAD f", "branch refs/heads/main"].join("\n");

    expect(parseWorktrees(porcelain)).toHaveLength(1);
  });
});

describe("parseTrack", () => {
  test("reads an upstream that is fully in sync", () => {
    expect(parseTrack("")).toEqual({ ahead: 0, behind: 0, gone: false });
  });

  test("reads ahead-only", () => {
    expect(parseTrack("[ahead 3]")).toEqual({ ahead: 3, behind: 0, gone: false });
  });

  test("reads behind-only", () => {
    expect(parseTrack("[behind 12]")).toEqual({ ahead: 0, behind: 12, gone: false });
  });

  test("reads diverged branches in both directions", () => {
    expect(parseTrack("[ahead 2, behind 5]")).toEqual({ ahead: 2, behind: 5, gone: false });
  });

  test("flags a deleted upstream as gone", () => {
    // the merged-and-deleted case: the single most useful thing to surface
    expect(parseTrack("[gone]")).toEqual({ ahead: 0, behind: 0, gone: true });
  });
});

describe("parseBranches", () => {
  test("reads name, tracking state, and commit date", () => {
    // Arrange — tab-separated so branch names containing spaces survive
    const output = "main\t\t2026-08-10T09:12:00+00:00";

    // Act
    const result = parseBranches(output);

    // Assert
    expect(result).toEqual([
      {
        name: "main",
        track: { ahead: 0, behind: 0, gone: false },
        committedAt: "2026-08-10T09:12:00+00:00",
      },
    ]);
  });

  test("reads several branches with mixed tracking states", () => {
    const output = [
      "main\t\t2026-08-10T09:12:00+00:00",
      "feature/onboarding\t[ahead 4]\t2026-08-09T22:01:00+00:00",
      "fix/lease-race\t[gone]\t2026-08-01T10:00:00+00:00",
    ].join("\n");

    const result = parseBranches(output);

    expect(result).toHaveLength(3);
    expect(result[1].track.ahead).toBe(4);
    expect(result[2].track.gone).toBe(true);
  });

  test("skips blank lines rather than emitting empty branches", () => {
    const output = "main\t\t2026-08-10T09:12:00+00:00\n\n";

    expect(parseBranches(output)).toHaveLength(1);
  });

  test("returns an empty array for a repo with no branches", () => {
    expect(parseBranches("")).toEqual([]);
  });
});
