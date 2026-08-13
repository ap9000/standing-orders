/**
 * Turning snapshots into something worth reading.
 *
 * Pure string building. The clock is a parameter rather than a call, so the
 * output is deterministic under test and the same report can be re-rendered
 * later against the time it was taken.
 */

import type { RepoSnapshot } from "./discover.js";
import type { Branch, TrackingState } from "./git.js";
import {
  chooseBackend,
  setupOptions,
  LABELS as GRAPH_LABELS,
  type BackendKind,
  type Detection,
} from "./graph.js";
import {
  classify,
  describe as describePull,
  idleDays,
  DEFAULT_STALE_DAYS,
  type Attention,
  type Pull,
} from "./pulls.js";
import type { RemoteState } from "./remote.js";

export type ReportOptions = {
  now: Date;
  /** Where the scan looked, used only to make the empty result actionable. */
  roots?: readonly string[];
  maxBranches?: number;
  /**
   * Pull requests and issues per repository path. Undefined means they were
   * never read — which the report says out loud rather than showing zeroes,
   * because "none" and "did not look" are different answers.
   */
  remote?: RemoteMap;
};

export type RemoteMap = ReadonlyMap<string, RemoteState>;

export const DEFAULT_MAX_BRANCHES = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const INDENT = "  ";
const GUTTER = 2;

/**
 * Columns size themselves to the content, within bounds. Fixed widths either
 * waste half the terminal on short names or let one long branch name shove
 * every other column out of alignment — and truncating is not an option when
 * the name is the thing you are about to type.
 */
const MIN_NAME_WIDTH = 20;
const MAX_NAME_WIDTH = 44;
const MIN_STATE_WIDTH = 12;
const MAX_STATE_WIDTH = 20;

/** One line of the report, before its columns have been sized. */
type Row = { indent: string; name: string; state: string; tail: string };

export function formatAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  // Clocks disagree across machines; a branch from the future is just recent.
  const elapsed = Math.max(0, now.getTime() - then);

  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo ago`;
  return `${Math.floor(elapsed / YEAR)}y ago`;
}

export function formatTrack(track: TrackingState): string {
  if (track.gone) return "upstream gone";

  const parts: string[] = [];
  if (track.ahead > 0) parts.push(`ahead ${track.ahead}`);
  if (track.behind > 0) parts.push(`behind ${track.behind}`);
  return parts.join(", ");
}

/** A branch is in flight when it has diverged from its upstream or lost it. */
function isInFlight(branch: Branch): boolean {
  return branch.track.ahead > 0 || branch.track.behind > 0 || branch.track.gone;
}

export function renderReport(snapshots: readonly RepoSnapshot[], options: ReportOptions): string {
  const { now, roots = [], maxBranches = DEFAULT_MAX_BRANCHES, remote } = options;

  if (snapshots.length === 0) return renderEmpty(roots);

  const sections = [...snapshots]
    .sort(byRecency)
    .map(snapshot => composeSection(snapshot, now, maxBranches, remote))
    .filter(rows => rows.length > 0);

  const totals = countInFlight(snapshots, remote);
  const withheld = renderWithheld(snapshots, remote);

  // "Nothing in flight" is a claim about what was looked at. If the budget ran
  // out before some repositories were asked, saying it flatly would be the
  // silence this tool exists to break — so the withheld line goes here too,
  // and it is the whole point of this branch rather than a footnote.
  if (sections.length === 0) {
    return [...renderNothingInFlight(snapshots.length, remote, withheld.length > 0), ...withheld]
      .join("\n")
      .trimEnd();
  }

  const rows = sections.flat();
  const nameWidth = widthOf(rows, row => row.indent.length + row.name.length, MIN_NAME_WIDTH, MAX_NAME_WIDTH);
  const stateWidth = widthOf(rows, row => row.state.length, MIN_STATE_WIDTH, MAX_STATE_WIDTH);

  const unmeasured = snapshots.filter(snapshot => !snapshot.hasTracking).length;

  const body = sections.map(section =>
    section.map(row => renderRow(row, nameWidth, stateWidth)).join("\n"),
  );

  return [renderHeader(totals, snapshots.length, unmeasured), "", ...body, ...withheld]
    .join("\n")
    .trimEnd();
}

/**
 * One repository's block, from both halves.
 *
 * The local rows already end in a blank separator, so remote rows are spliced
 * in ahead of it rather than appended after — otherwise a repository's pull
 * requests would appear under the gap, reading as though they belonged to the
 * repository below.
 */
function composeSection(
  snapshot: RepoSnapshot,
  now: Date,
  maxBranches: number,
  remote: RemoteMap | undefined,
): Row[] {
  const local = collectRows(snapshot, now, maxBranches);
  const fromRemote = collectRemoteRows(snapshot, remote, now);
  if (fromRemote.length === 0) return local;

  if (local.length === 0) {
    // Nothing local to say, but a pull request waiting is still news, and the
    // repository needs a heading of its own to be attributed to.
    return [
      { indent: "", name: snapshot.name, state: snapshot.head ?? "detached", tail: "" },
      ...fromRemote,
      { indent: "", name: "", state: "", tail: "" },
    ];
  }

  return [...local.slice(0, -1), ...fromRemote, local[local.length - 1] as Row];
}

type Totals = { branches: number; pulls: number; issues: number; remoteRead: boolean };

function countInFlight(
  snapshots: readonly RepoSnapshot[],
  remote: RemoteMap | undefined,
): Totals {
  const branches = snapshots.reduce(
    (total, snapshot) => total + (snapshot.hasTracking ? snapshot.branches.filter(isInFlight).length : 0),
    0,
  );

  let pulls = 0;
  let issues = 0;
  for (const snapshot of snapshots) {
    const state = remote?.get(snapshot.path);
    if (state === undefined) continue;
    pulls += state.pulls.length;
    issues += state.issues.length;
  }

  return { branches, pulls, issues, remoteRead: remote !== undefined };
}

/**
 * Pull requests waiting on somebody, and a count of open issues.
 *
 * Pull requests get a row each because a pull request that nobody has looked at
 * is the single most actionable thing this report can surface — the case that
 * motivated the tool was two of them sitting green and ignored for two months.
 * Issues get a count: a hundred open issues is context, not a to-do list, and
 * printing all of them would bury everything above.
 */
function collectRemoteRows(
  snapshot: RepoSnapshot,
  remote: RemoteMap | undefined,
  now: Date,
): Row[] {
  const state = remote?.get(snapshot.path);
  if (state === undefined || state.skipped) return [];

  const rows: Row[] = [];

  const waiting = state.pulls.filter(pull => {
    const attention = classify(pull);
    return attention === "human" || attention === "agent";
  });

  for (const pull of waiting) {
    rows.push({
      indent: INDENT,
      name: `#${pull.number} ${pull.branch}`,
      state: describePull(pull),
      tail: formatIdle(pull.updatedAt, now),
    });
  }

  if (state.issues.length > 0) {
    rows.push({
      indent: INDENT,
      name: `${plural(state.issues.length, "issue", "issues")} open`,
      state: "",
      tail: "",
    });
  }

  for (const problem of state.problems) {
    rows.push({ indent: INDENT, name: `! ${problem}`, state: "", tail: "" });
  }

  return rows;
}

/** What the budget did not reach, named rather than silently missing. */
function renderWithheld(
  snapshots: readonly RepoSnapshot[],
  remote: RemoteMap | undefined,
): string[] {
  if (remote === undefined) return [];
  const skipped = snapshots.filter(snapshot => remote.get(snapshot.path)?.skipped === true);
  if (skipped.length === 0) return [];

  // Named, not counted. "3 repositories were not checked" leaves an operator
  // to work out which three, and the whole reason this line exists is that a
  // repository nobody looked at must not be mistaken for one with nothing in
  // it. Long lists are truncated, because at that point the budget is the
  // story rather than the names.
  const shown = skipped.slice(0, MAX_SKIPPED_NAMED).map(snapshot => snapshot.name);
  const rest = skipped.length - shown.length;
  const names = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");

  return [
    "",
    `Not checked for pull requests or issues: ${names}.`,
    "The network budget ran out. `nightorders pulls` reads them without one.",
  ];
}

function renderRow(row: Row, nameWidth: number, stateWidth: number): string {
  const name = pad(`${row.indent}${row.name}`, nameWidth);
  return `${name}${pad(row.state, stateWidth)}${row.tail}`.trimEnd();
}

/**
 * Only rows that carry a later column get a vote on how wide the earlier ones
 * are. A free-text problem line has nothing to its right, so letting it size
 * the table would push every real column off to the horizon.
 */
function widthOf(
  rows: readonly Row[],
  measure: (row: Row) => number,
  min: number,
  max: number,
): number {
  const widest = rows
    .filter(row => row.state !== "" || row.tail !== "")
    .reduce((longest, row) => Math.max(longest, measure(row)), 0);
  return Math.min(max, Math.max(min, widest + GUTTER));
}

/**
 * The one line the milestone is actually about: every branch, pull request and
 * issue in flight, counted together.
 *
 * Zeroes are dropped rather than printed. "3 branches, 0 pull requests, 0
 * issues" reads as a system reporting on itself; "3 branches" reads as an
 * answer. But a zero that was never *looked* for is different from one that
 * was, which is why the remote counts only appear when the remote read
 * actually happened.
 */
function renderHeader(totals: Totals, repoCount: number, unmeasured: number): string {
  const parts = [plural(totals.branches, "branch", "branches")];
  if (totals.remoteRead && totals.pulls > 0) {
    parts.push(plural(totals.pulls, "pull request", "pull requests"));
  }
  if (totals.remoteRead && totals.issues > 0) {
    parts.push(plural(totals.issues, "issue", "issues"));
  }

  const repos = plural(repoCount, "repository", "repositories");
  const headline = `${joinWords(parts)} in flight across ${repos}`;

  // A count that quietly excludes repositories it could not measure is a lie
  // of omission. The remedy is named once here rather than on every repo — and
  // it is printed, never run, because it writes to someone else's .git.
  if (unmeasured === 0) return headline;
  const which = unmeasured === 1 ? "1 repository is" : `${unmeasured} repositories are`;
  return [
    headline,
    `${which} listed by recency: ahead/behind was too slow to compute.`,
    "`git commit-graph write --reachable` in it makes this permanent —",
    "it writes to .git, so run it yourself.",
  ].join("\n");
}

/** Repositories were found and read; none of them had anything outstanding. */
function renderNothingInFlight(
  repoCount: number,
  remote: RemoteMap | undefined,
  anyWithheld: boolean,
): string[] {
  return [
    anyWithheld
      ? `Nothing in flight across the ${plural(repoCount, "repository", "repositories")} that were checked.`
      : `Nothing in flight across ${plural(repoCount, "repository", "repositories")}.`,
    remote === undefined
      ? "Every branch is level with its upstream."
      : "Every branch is level with its upstream, and nothing is waiting on a person.",
    "",
    "Uncommitted work is not counted here — add --dirty to read working trees.",
    // Said in addition to, not instead of: an operator who ran --local has two
    // things missing from this answer, and hearing about one of them would
    // leave them believing the other was checked.
    ...(remote === undefined
      ? ["Pull requests and issues were not read — drop --local to include them."]
      : []),
  ];
}

/** "a, b and c" — the report is prose at this point, not a field list. */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function renderEmpty(roots: readonly string[]): string {
  const where = roots.length > 0 ? ` under ${roots.join(", ")}` : "";
  return [
    `No git repositories found${where}.`,
    "",
    "Point it somewhere else with `nightorders <path>`, or go deeper with",
    "`nightorders --depth 8`. Nothing has been written or configured.",
  ].join("\n");
}

/** Past this, the budget is the story rather than which repositories missed out. */
const MAX_SKIPPED_NAMED = 6;

/** Long enough to catch work you have put down, short enough to exclude archaeology. */
const RECENT_WINDOW = 30 * DAY;

/**
 * Which branches to show. With tracking, the ones that have diverged. Without
 * it, recency is the only signal left — filtering on ahead/behind that was
 * never computed would discard every branch and leave the repository
 * represented by a complaint, and listing all of them buries the report under
 * whichever repo happens to have the most abandoned branches.
 */
function selectBranches(snapshot: RepoSnapshot, now: Date): { shown: Branch[]; note: string | null } {
  const byRecent = [...snapshot.branches].sort(byCommittedAtDesc);
  if (snapshot.hasTracking) return { shown: byRecent.filter(isInFlight), note: null };

  const recent = byRecent.filter(branch => isWithinWindow(branch.committedAt, now));
  if (recent.length > 0) return { shown: recent, note: null };

  const count = plural(snapshot.branches.length, "branch", "branches");
  return { shown: [], note: `${count}, none touched in 30 days` };
}

function isWithinWindow(iso: string, now: Date): boolean {
  const then = Date.parse(iso);
  return !Number.isNaN(then) && now.getTime() - then < RECENT_WINDOW;
}

function collectRows(snapshot: RepoSnapshot, now: Date, maxBranches: number): Row[] {
  const { shown: selected, note } = selectBranches(snapshot, now);

  // A quiet, clean repo with nothing outstanding is not worth a line.
  if (
    selected.length === 0 &&
    note === null &&
    !snapshot.dirtyFiles &&
    snapshot.problems.length === 0
  ) {
    return [];
  }

  const shown = selected.slice(0, maxBranches);
  const withheld = selected.length - shown.length;

  const rows: Row[] = [
    {
      indent: "",
      name: snapshot.name,
      state: snapshot.head ?? "detached",
      tail: renderDirty(snapshot.dirtyFiles),
    },
    ...shown.map(branch => ({
      indent: INDENT,
      name: branch.name,
      state: formatTrack(branch.track),
      tail: formatAge(branch.committedAt, now),
    })),
  ];

  if (note !== null) rows.push({ indent: INDENT, name: note, state: "", tail: "" });
  if (withheld > 0) {
    rows.push({ indent: INDENT, name: `… and ${withheld} more`, state: "", tail: "" });
  }
  for (const problem of snapshot.problems) {
    rows.push({ indent: INDENT, name: `! ${problem}`, state: "", tail: "" });
  }
  rows.push({ indent: "", name: "", state: "", tail: "" });

  return rows;
}

/** null means the working tree was not read, which is silence rather than "clean". */
function renderDirty(count: number | null): string {
  return count === null || count === 0 ? "" : `${count} uncommitted`;
}

/** Most recently touched repository first — recency is what "in flight" means. */
function byRecency(a: RepoSnapshot, b: RepoSnapshot): number {
  const difference = latestCommit(b) - latestCommit(a);
  return difference !== 0 ? difference : a.name.localeCompare(b.name);
}

function latestCommit(snapshot: RepoSnapshot): number {
  return snapshot.branches.reduce((latest, branch) => {
    const at = Date.parse(branch.committedAt);
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, 0);
}

function byCommittedAtDesc(a: Branch, b: Branch): number {
  return (Date.parse(b.committedAt) || 0) - (Date.parse(a.committedAt) || 0);
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One repository's open pull requests, as read. */
export type PullGroup = {
  repo: string;
  pulls: readonly Pull[];
  problems: readonly string[];
};

export type PullsOptions = {
  now: Date;
  staleDays?: number;
};

/**
 * How long since anything happened. Phrased as idleness rather than age
 * because a pull request opened in May and discussed yesterday is not old in
 * any sense the operator cares about.
 */
export function formatIdle(iso: string, now: Date): string {
  const age = formatAge(iso, now);
  if (age === "unknown") return "";
  if (age === "just now") return "just now";
  return `${age.replace(" ago", "")} idle`;
}

/**
 * Grouped by whose move it is, because that is the only question being asked.
 * Drafts and running builds are counted but not listed — nobody is blocked on
 * them, and a report that lists everything is the attention problem it was
 * written to solve.
 */
export function renderPulls(
  groups: readonly PullGroup[],
  options: PullsOptions,
): string {
  const { now, staleDays = DEFAULT_STALE_DAYS } = options;

  const entries = groups.flatMap(group =>
    group.pulls.map(pull => ({ repo: group.repo, pull, attention: classify(pull) })),
  );
  const problems = groups.flatMap(group =>
    group.problems.map(problem => `${group.repo}: ${problem}`),
  );

  const blocking: readonly Attention[] = ["human", "agent"];
  const sections = blocking
    .map(attention => renderAttention(attention, entries, now))
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return [renderNothingWaiting(entries, problems), ...renderProblems(problems)]
      .join("\n")
      .trimEnd();
  }

  const waiting = entries.filter(entry => blocking.includes(entry.attention));
  const stalled = waiting.filter(entry => (idleDays(entry.pull, now) ?? 0) >= staleDays);

  return [
    renderPullsHeader(waiting.length, stalled.length, staleDays),
    "",
    ...sections,
    ...renderProblems(problems),
    ...renderQuiet(entries),
  ]
    .join("\n")
    .trimEnd();
}

type PullEntry = { repo: string; pull: Pull; attention: Attention };

const ATTENTION_HEADINGS: Record<Attention, string> = {
  human: "Waiting on you",
  agent: "Waiting on an agent",
  machine: "Waiting on CI",
  none: "In progress",
};

/**
 * Longest-idle first. The one that has been ignored the longest is the one
 * most likely to have been forgotten rather than deferred.
 */
function renderAttention(
  attention: Attention,
  entries: readonly PullEntry[],
  now: Date,
): string | null {
  const mine = entries
    .filter(entry => entry.attention === attention)
    .sort((a, b) => (idleDays(b.pull, now) ?? 0) - (idleDays(a.pull, now) ?? 0));

  if (mine.length === 0) return null;

  const rows: Row[] = mine.map(entry => ({
    indent: INDENT,
    name: `${entry.repo} #${entry.pull.number}`,
    state: describePull(entry.pull),
    tail: formatIdle(entry.pull.updatedAt, now),
  }));

  const nameWidth = widthOf(
    rows,
    row => row.indent.length + row.name.length,
    MIN_NAME_WIDTH,
    MAX_NAME_WIDTH,
  );
  const stateWidth = widthOf(rows, row => row.state.length, MIN_STATE_WIDTH, MAX_STATE_WIDTH);

  return [
    ATTENTION_HEADINGS[attention],
    ...rows.map(row => renderRow(row, nameWidth, stateWidth)),
    "",
  ].join("\n");
}

function renderPullsHeader(waiting: number, stalled: number, staleDays: number): string {
  const headline = `${plural(waiting, "pull request", "pull requests")} waiting.`;
  if (stalled === 0) return headline;

  const which = stalled === 1 ? "1 has" : `${stalled} have`;
  return `${headline} ${which} been waiting more than ${plural(staleDays, "day", "days")}.`;
}

/**
 * Nothing waiting is only good news if we managed to look. A repository whose
 * pull requests could not be read has told us nothing, and saying "nothing is
 * waiting" about it would be the silence this tool exists to break.
 */
function renderNothingWaiting(
  entries: readonly PullEntry[],
  problems: readonly string[],
): string {
  if (problems.length > 0 && entries.length === 0) return "No pull requests were read.";

  const quiet = renderQuiet(entries);
  return ["Nothing is waiting on you.", ...quiet].join("\n");
}

/** Drafts and running builds: counted, so their absence above is not a mystery. */
function renderQuiet(entries: readonly PullEntry[]): string[] {
  const drafts = entries.filter(entry => entry.attention === "none").length;
  const running = entries.filter(entry => entry.attention === "machine").length;

  const parts = [
    drafts > 0 ? `${plural(drafts, "draft", "drafts")} in progress` : null,
    running > 0 ? `${running} waiting on CI` : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? [] : ["", `${parts.join(", ")}.`];
}

function renderProblems(problems: readonly string[]): string[] {
  return problems.length === 0 ? [] : ["", ...problems.map(problem => `! ${problem}`)];
}

/**
 * What work graph is already here.
 *
 * The recommended backend is marked with a pointer and nothing else is, because
 * the one thing this report must not read as is a menu of things already
 * switched on. Every line ends by saying what is *not* authorized, since
 * detection is not authorization and a report that omitted that would be
 * inviting exactly the wrong conclusion.
 */
export function renderGraph(
  detections: readonly Detection[],
  options: { enrolled?: BackendKind } = {},
): string {
  if (detections.length === 0) {
    return [
      "No work graph found in your repositories.",
      "",
      "Night Orders looked for `.beads/`, `backlog.md`, and open GitHub Issues.",
      "Nothing was installed or created — a tracker is yours to set up.",
    ].join("\n");
  }

  const choice = chooseBackend(
    detections,
    options.enrolled === undefined ? {} : { enrolled: options.enrolled },
  );
  const chosen = choice.action === "recommend" ? choice.kind : null;

  const rows = detections.map(detection => ({
    marker: detection.kind === chosen ? "▸ " : "  ",
    label: detection.label,
    facts: describeDetection(detection),
  }));
  const labelWidth = Math.max(...rows.map(row => row.label.length));

  const problems = detections.flatMap(detection => detection.problems);

  return [
    "Work graph — detected in your repos",
    "",
    ...rows.map(row => `${row.marker}${row.label.padEnd(labelWidth)}  ${row.facts}`),
    "",
    ...describeChoice(choice),
    ...(choice.action === "built-in" ? renderSetup() : []),
    ...renderProblems(problems),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * The way forward when nothing is set up.
 *
 * Without this the empty case is a dead end — "no tracker found, and the
 * fallback does not exist yet" — which tells an operator nothing they can act
 * on. §4 requires the opposite: print the upstream command *and* what it will
 * do, and let them run it.
 *
 * The side effects are not a footnote. `bd init` rewrites AGENTS.md and
 * installs agent integrations, and somebody who ran it because a tool
 * suggested it and only found that out afterwards would be right to be angry.
 */
function renderSetup(): string[] {
  const lines: string[] = ["", "Setting one up — commands to run yourself, in your own shell:"];

  for (const option of setupOptions()) {
    lines.push("");
    lines.push(`  ${option.label}${option.note === null ? "" : ` — ${option.note}`}`);
    if (option.install !== null) lines.push(`      ${option.install}`);
    if (option.init !== null) lines.push(`      ${option.init}`);
    if (option.sideEffects !== null) lines.push(`      → ${option.sideEffects}`);
  }

  lines.push("");
  lines.push("Night Orders runs none of these. Re-run `nightorders graph` afterwards.");
  return lines;
}

/** The middle column: where it is, how much is in it, and whether it could run. */
function describeDetection(detection: Detection): string {
  const parts: string[] = [];

  if (detection.repos.length > 0) {
    parts.push(`${plural(detection.repos.length, "repo", "repos")}`);
  }
  // A row with no number at all reads as zero. Absence of a count is its own
  // fact and has to be said out loud.
  parts.push(
    detection.count === null
      ? "count unknown"
      : `${detection.count.value} ${detection.count.of}`,
  );
  parts.push(describeDeps(detection.deps));
  parts.push(describeRuntime(detection));

  return parts.join(" · ");
}

function describeDeps(deps: Detection["deps"]): string {
  if (deps === "native") return "native deps";
  if (deps === "none") return "no deps";
  return "deps unverified";
}

function describeRuntime(detection: Detection): string {
  const { runtime } = detection;
  if (runtime.state === "missing") return `${runtime.binary} not installed`;
  if (runtime.state === "outdated") return `${runtime.version} too old, needs ${runtime.needs}`;
  if (runtime.state === "unreadable") return "runtime would not answer";
  return runtime.version === null ? "runtime ok" : `runtime ok (${runtime.version})`;
}

/**
 * The closing line always says nothing is enrolled, including when a backend
 * is recommended. A recommendation that read as an activation would be the one
 * misunderstanding this whole module is written to prevent.
 */
function describeChoice(choice: ReturnType<typeof chooseBackend>): string[] {
  const lines: string[] = [];

  if (choice.action === "recommend" && choice.why === "already enrolled") {
    // An enrolled backend is not a suggestion, and must not read like one.
    lines.push(`Enrolled: ${GRAPH_LABELS[choice.kind]}. Write access has been granted.`);
    lines.push("`nightorders grants` shows exactly what, and `revoke` takes it back.");
    return lines;
  }

  if (choice.action === "recommend") {
    lines.push(`Suggested: ${GRAPH_LABELS[choice.kind]} — ${choice.why}.`);
    if (!choice.dispatchable) {
      // Deliberately not "it can be read, but…": when the runtime is missing
      // it cannot be read either, and the sentence would contradict the row
      // directly above it.
      lines.push("Nothing here could be scheduled from it as it stands.");
    }
  } else if (choice.action === "ambiguous") {
    const names = choice.kinds.map(kind => GRAPH_LABELS[kind]).join(" and ");
    lines.push(`${names} are both populated — ${choice.why}.`);
  } else {
    lines.push(choice.why.charAt(0).toUpperCase() + choice.why.slice(1) + ".");
  }

  lines.push("Nothing is enrolled, and detection grants nothing.");
  return lines;
}
