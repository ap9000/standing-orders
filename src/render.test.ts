import { describe, test, expect } from "vitest";
import { formatAge, formatTrack, renderReport, renderGraph } from "./render.js";
import type { RepoSnapshot } from "./discover.js";
import type { Detection } from "./graph.js";

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

  test("summarises instead of listing when every branch is old", () => {
    // One repo full of abandoned backup/* branches should not bury the report
    const branches = Array.from({ length: 18 }, (_, index) =>
      branch(`backup/2026-03-0${index % 9}`, {}, 150 * DAY),
    );

    const output = renderReport([repo({ hasTracking: false, branches })], { now: NOW });

    expect(output).toContain("18 branches, none touched in 30 days");
    expect(output).not.toContain("backup/");
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

/** Detections are verbose; build them from a sensible default. */
const detection = (over: Partial<Detection> & Pick<Detection, "kind">): Detection => ({
  label: over.kind,
  repos: ["/code/thing"],
  count: { of: "ready", value: 4 },
  deps: "native",
  runtime: { state: "ok", version: "1.0.0" },
  dispatchable: true,
  problems: [],
  ...over,
});

describe("renderGraph", () => {
  test("marks only the suggested backend, and says nothing is enrolled", () => {
    // The one thing this report must never read as is a list of things
    // already switched on.
    const output = renderGraph([
      detection({ kind: "beads", label: "beads" }),
      detection({
        kind: "github-issues",
        label: "GitHub Issues",
        count: { of: "open", value: 112 },
        dispatchable: false,
      }),
    ]);

    expect(output).toContain("▸ beads");
    expect(output).not.toContain("▸ GitHub Issues");
    expect(output).toContain("Nothing is enrolled, and detection grants nothing.");
  });

  test("says a recommended backend is not schedulable when it is not", () => {
    const output = renderGraph([
      detection({
        kind: "beads",
        label: "beads",
        count: null,
        dispatchable: false,
        runtime: { state: "missing", binary: "bd" },
      }),
    ]);

    expect(output).toContain("bd not installed");
    expect(output).toContain("Nothing here could be scheduled from it as it stands");
    // It cannot be read either, so it must not claim otherwise.
    expect(output).not.toContain("It can be read");
  });

  test("says a count is unknown rather than leaving the column blank", () => {
    // An empty space where a number goes reads as zero, which is a different
    // and much more confident claim than "we could not count".
    const output = renderGraph([detection({ kind: "beads", label: "beads", count: null })]);

    expect(output).toContain("count unknown");
  });

  test("names both trackers rather than picking one", () => {
    const output = renderGraph([
      detection({ kind: "beads", label: "beads" }),
      detection({
        kind: "backlog-md",
        label: "Backlog.md",
        deps: "unverified",
        dispatchable: false,
      }),
    ]);

    expect(output).toContain("beads and Backlog.md are both populated");
    expect(output).not.toContain("▸");
  });

  test("reports an outdated gh as a version problem, not a missing one", () => {
    const output = renderGraph([
      detection({
        kind: "github-issues",
        label: "GitHub Issues",
        count: { of: "open", value: 3 },
        dispatchable: false,
        runtime: { state: "outdated", version: "2.67.0", needs: "2.94.0" },
      }),
    ]);

    expect(output).toContain("2.67.0 too old, needs 2.94.0");
  });

  test("prints the setup commands, and their side effects, when nothing is set up", () => {
    // The empty case used to be a dead end. §4: print the upstream command
    // *and* a summary of what it does, then let the operator run it.
    const output = renderGraph([
      detection({ kind: "github-issues", label: "GitHub Issues", count: null, repos: [] }),
    ]);

    expect(output).toContain("bd init");
    expect(output).toContain("brew install beads");
    // the side effect is the part someone would be angry to discover later
    expect(output).toContain("AGENTS.md");
    expect(output).toContain("Night Orders runs none of these");
  });

  test("does not offer setup commands when a backend was found", () => {
    // Someone who already has beads does not need to be sold beads.
    const output = renderGraph([detection({ kind: "beads", label: "beads" })]);

    expect(output).not.toContain("brew install");
  });

  test("says what it looked for when it found nothing", () => {
    // An empty result has to be distinguishable from not having looked.
    const output = renderGraph([]);

    expect(output).toContain(".beads/");
    expect(output).toContain("Nothing was installed or created");
  });

  test("surfaces problems instead of dropping them", () => {
    const output = renderGraph([
      detection({ kind: "beads", label: "beads", problems: ["/code/thing: database is locked"] }),
    ]);

    expect(output).toContain("! /code/thing: database is locked");
  });
});

/** Remote state keyed the way the report expects it. */
const remoteFor = (
  entries: Record<string, Partial<import("./remote.js").RemoteState>>,
): Map<string, import("./remote.js").RemoteState> =>
  new Map(
    Object.entries(entries).map(([path, state]) => [
      path,
      {
        pulls: [],
        issues: [],
        pullsRead: true,
        issuesRead: true,
        problems: [],
        skipped: false,
        ...state,
      },
    ]),
  );

const pull = (number: number, over: Partial<import("./pulls.js").Pull> = {}) => ({
  number,
  title: `pull ${number}`,
  branch: `feat/${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  mergeable: "MERGEABLE" as const,
  checks: "passing" as const,
  createdAt: ago(2 * DAY),
  updatedAt: ago(2 * DAY),
  ...over,
});

const issue = (id: string) => ({ id, title: `issue ${id}`, state: "queued" as const });

describe("renderReport with pull requests and issues", () => {
  test("counts all three in one headline", () => {
    // The milestone's actual sentence: one command, every branch, pull
    // request and issue in flight.
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const remote = remoteFor({
      "/code/nightorders": { pulls: [pull(45)], issues: [issue("1"), issue("2")] },
    });

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("1 branch, 1 pull request and 2 issues in flight");
  });

  test("leaves out what is zero rather than reporting zeroes", () => {
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];

    const output = renderReport(snapshots, {
      now: NOW,
      remote: remoteFor({ "/code/nightorders": {} }),
    });

    expect(output).toContain("1 branch in flight");
    expect(output).not.toContain("0 pull requests");
  });

  test("says nothing about pull requests when it never looked", () => {
    // A zero nobody looked for is a different claim from a zero that was
    // measured, so an unread remote produces no count at all.
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];

    const output = renderReport(snapshots, { now: NOW });

    expect(output).not.toContain("pull request");
  });

  test("gives each waiting pull request its own line, under its repository", () => {
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const remote = remoteFor({ "/code/nightorders": { pulls: [pull(45), pull(46)] } });

    const output = renderReport(snapshots, { now: NOW, remote });
    const lines = output.split("\n");
    const repoLine = lines.findIndex(line => line.startsWith("nightorders"));
    const pullLine = lines.findIndex(line => line.includes("#45"));

    expect(pullLine).toBeGreaterThan(repoLine);
    expect(output).toContain("#46");
    expect(output).toContain("ready to merge");
  });

  test("does not list a pull request that is waiting on CI", () => {
    // A machine still working is not waiting on anybody, and a report that
    // lists it is asking for attention nothing needs.
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const remote = remoteFor({
      "/code/nightorders": { pulls: [pull(45, { checks: "running" })] },
    });

    expect(renderReport(snapshots, { now: NOW, remote })).not.toContain("#45");
  });

  test("counts issues rather than listing them", () => {
    // A hundred open issues is context, not a to-do list; printing them all
    // would bury everything above.
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const issues = Array.from({ length: 40 }, (_, index) => issue(String(index)));

    const output = renderReport(snapshots, {
      now: NOW,
      remote: remoteFor({ "/code/nightorders": { issues } }),
    });

    expect(output).toContain("40 issues open");
    expect(output).not.toContain("issue 12");
  });

  test("gives a repository a heading when its only news is a pull request", () => {
    // Otherwise the pull request appears under whichever repo happens to be
    // above it, which is worse than not showing it.
    const snapshots = [repo({ branches: [] })];
    const remote = remoteFor({ "/code/nightorders": { pulls: [pull(45)] } });

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("nightorders");
    expect(output.indexOf("nightorders")).toBeLessThan(output.indexOf("#45"));
  });

  test("names the repositories the budget did not reach", () => {
    // Counted rather than named leaves an operator to work out which ones, and
    // the whole reason the line exists is that a repository nobody looked at
    // must not be mistaken for one with nothing in it.
    const snapshots = [
      repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] }),
      repo({ name: "oddcircle", path: "/code/oddcircle" }),
    ];
    const remote = remoteFor({
      "/code/nightorders": {},
      "/code/oddcircle": { skipped: true },
    });

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("Not checked for pull requests or issues: oddcircle.");
    expect(output).toContain("nightorders pulls");
  });

  test("does not claim nothing is in flight when it did not look", () => {
    // The false statement this prevents: every repository quiet locally, every
    // remote read skipped, and a report that says "nothing in flight" about
    // work it never asked about.
    const snapshots = [repo({ branches: [] })];
    const remote = remoteFor({ "/code/nightorders": { skipped: true } });

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("that were checked");
    expect(output).toContain("Not checked for pull requests or issues: nightorders.");
  });

  test("truncates a long list of skipped repositories", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) =>
      repo({ name: `repo-${index}`, path: `/code/${index}`, branches: [branch("x", { ahead: 1 }, DAY)] }),
    );
    const remote = remoteFor(
      Object.fromEntries(snapshots.map(snapshot => [snapshot.path, { skipped: true }])),
    );

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("and 3 more");
  });

  test("does not report a failed issue read as an empty tracker", () => {
    // `issues: []` with issuesRead false is "we could not look", and the
    // problem line is the only thing standing between that and "there is
    // nothing there".
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const remote = remoteFor({
      "/code/nightorders": {
        issuesRead: false,
        problems: ["could not read issues: gh auth login required"],
      },
    });

    const output = renderReport(snapshots, { now: NOW, remote });

    expect(output).toContain("auth login required");
    expect(output).not.toContain("0 issues");
  });

  test("surfaces a remote problem rather than dropping it", () => {
    const snapshots = [repo({ branches: [branch("feat/a", { ahead: 1 }, DAY)] })];
    const remote = remoteFor({
      "/code/nightorders": { problems: ["could not read pull requests: timed out"] },
    });

    expect(renderReport(snapshots, { now: NOW, remote })).toContain("timed out");
  });

  test("tells an operator who stayed local what they are not seeing", () => {
    const output = renderReport([repo({ branches: [branch("main", {}, DAY)] })], { now: NOW });

    expect(output).toContain("--local");
  });
});
