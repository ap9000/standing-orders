import { describe, test, expect } from "vitest";
import { formatAge, formatTrack, renderReport } from "./render.js";
import type { RepoSnapshot } from "./discover.js";

const NOW = new Date("2026-08-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const repo = (overrides: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  path: "/code/nightorders",
  name: "nightorders",
  head: "main",
  remoteUrl: "git@github.com:ap9000/nightorders.git",
  branches: [],
  worktrees: [],
  dirtyFiles: 0,
  hasTracking: true,
  problems: [],
  ...overrides,
});

const branch = (
  name: string,
  track: Partial<{ ahead: number; behind: number; gone: boolean }>,
  age: number,
) => ({
  name,
  track: { ahead: 0, behind: 0, gone: false, ...track },
  committedAt: ago(age),
});

describe("formatAge", () => {
  test("reads anything under a minute as just now", () => {
    expect(formatAge(ago(30_000), NOW)).toBe("just now");
  });

  test("reads minutes, hours, and days", () => {
    expect(formatAge(ago(5 * MINUTE), NOW)).toBe("5m ago");
    expect(formatAge(ago(3 * HOUR), NOW)).toBe("3h ago");
    expect(formatAge(ago(2 * DAY), NOW)).toBe("2d ago");
  });

  test("collapses long gaps into months and years", () => {
    expect(formatAge(ago(45 * DAY), NOW)).toBe("1mo ago");
    expect(formatAge(ago(400 * DAY), NOW)).toBe("1y ago");
  });

  test("treats a future timestamp as just now rather than negative time", () => {
    // clock skew between machines is ordinary and must not render as "-3h ago"
    expect(formatAge(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe("just now");
  });

  test("says so when a timestamp cannot be read", () => {
    expect(formatAge("not-a-date", NOW)).toBe("unknown");
    expect(formatAge("", NOW)).toBe("unknown");
  });
});

describe("formatTrack", () => {
  test("says nothing about a branch in sync with its upstream", () => {
    expect(formatTrack({ ahead: 0, behind: 0, gone: false })).toBe("");
  });

  test("names ahead, behind, and diverged states", () => {
    expect(formatTrack({ ahead: 4, behind: 0, gone: false })).toBe("ahead 4");
    expect(formatTrack({ ahead: 0, behind: 2, gone: false })).toBe("behind 2");
    expect(formatTrack({ ahead: 2, behind: 5, gone: false })).toBe("ahead 2, behind 5");
  });

  test("names a deleted upstream", () => {
    expect(formatTrack({ ahead: 0, behind: 0, gone: true })).toBe("upstream gone");
  });
});

describe("renderReport", () => {
  test("tells an operator with no repos what to do next", () => {
    // The empty result is the most important string in the tool: it is what a
    // first-time user sees when they point it at the wrong directory.
    const output = renderReport([], { now: NOW, roots: ["/tmp/empty"] });

    expect(output).toContain("No git repositories found");
    expect(output).toContain("/tmp/empty");
    expect(output).toContain("nightorders");
  });

  test("counts the branches in flight in its header", () => {
    const snapshots = [
      repo({ branches: [branch("main", {}, DAY), branch("feature/a", { ahead: 4 }, DAY)] }),
      repo({
        name: "oddcircle",
        path: "/code/oddcircle",
        branches: [branch("fix/b", { gone: true }, DAY)],
      }),
    ];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("2 branches in flight");
    expect(output).toContain("2 repositories");
  });

  test("lists only branches with something happening", () => {
    const snapshots = [
      repo({
        branches: [branch("main", {}, DAY), branch("feature/onboarding", { ahead: 4 }, 2 * DAY)],
      }),
    ];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("feature/onboarding");
    expect(output).toContain("ahead 4");
    // a branch level with its upstream is not in flight and is not noise here
    expect(output).not.toMatch(/^\s+main\b/m);
  });

  test("orders branches by recency", () => {
    const snapshots = [
      repo({
        branches: [branch("older", { ahead: 1 }, 9 * DAY), branch("newer", { ahead: 1 }, HOUR)],
      }),
    ];

    const output = renderReport(snapshots, { now: NOW });

    expect(output.indexOf("newer")).toBeLessThan(output.indexOf("older"));
  });

  test("caps the branch list and says how many it withheld", () => {
    const branches = Array.from({ length: 7 }, (_, index) =>
      branch(`feature/${index}`, { ahead: 1 }, index * HOUR),
    );

    const output = renderReport([repo({ branches })], { now: NOW, maxBranches: 3 });

    expect(output).toContain("4 more");
  });

  test("shows uncommitted work and detached heads", () => {
    const snapshots = [repo({ dirtyFiles: 3, head: null })];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("3 uncommitted");
    expect(output).toContain("detached");
  });

  test("says so plainly when repos were found but nothing is in flight", () => {
    // Otherwise this is a header with silence underneath, which reads as a bug
    const snapshots = [repo({ branches: [branch("main", {}, DAY)] }), repo({ name: "other" })];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("Nothing in flight");
    expect(output).toContain("2 repositories");
    // --dirty is off by default, so say where uncommitted work went
    expect(output).toContain("--dirty");
  });

  test("falls back to recent branches when ahead/behind is unavailable", () => {
    // Without tracking there is nothing for the in-flight filter to match, so
    // filtering would hide every branch and leave only a complaint on screen.
    const snapshots = [
      repo({
        hasTracking: false,
        problems: ["ahead/behind skipped: it took over 5s to compute here"],
        branches: [branch("main", {}, DAY), branch("feature/onboarding", {}, 2 * DAY)],
      }),
    ];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("feature/onboarding");
    expect(output).toContain("2d ago");
  });

  test("says when a repository is shown by recency rather than by state", () => {
    const snapshots = [
      repo({ hasTracking: false, branches: [branch("main", {}, DAY)] }),
    ];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("recency");
  });

  test("surfaces problems rather than hiding them", () => {
    const snapshots = [repo({ problems: ["could not read branches: fatal: bad object"] })];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).toContain("could not read branches");
  });
});
