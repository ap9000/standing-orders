/**
 * Turning snapshots into something worth reading.
 *
 * Pure string building. The clock is a parameter rather than a call, so the
 * output is deterministic under test and the same report can be re-rendered
 * later against the time it was taken.
 */

import type { RepoSnapshot } from "./discover.js";
import type { Branch, TrackingState } from "./git.js";

export type ReportOptions = {
  now: Date;
  /** Where the scan looked, used only to make the empty result actionable. */
  roots?: readonly string[];
  maxBranches?: number;
};

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
  const { now, roots = [], maxBranches = DEFAULT_MAX_BRANCHES } = options;

  if (snapshots.length === 0) return renderEmpty(roots);

  const sections = [...snapshots]
    .sort(byRecency)
    .map(snapshot => collectRows(snapshot, now, maxBranches))
    .filter(rows => rows.length > 0);

  if (sections.length === 0) return renderNothingInFlight(snapshots.length);

  const rows = sections.flat();
  const nameWidth = widthOf(rows, row => row.indent.length + row.name.length, MIN_NAME_WIDTH, MAX_NAME_WIDTH);
  const stateWidth = widthOf(rows, row => row.state.length, MIN_STATE_WIDTH, MAX_STATE_WIDTH);

  const inFlight = snapshots.reduce(
    (total, snapshot) => total + (snapshot.hasTracking ? snapshot.branches.filter(isInFlight).length : 0),
    0,
  );
  const unmeasured = snapshots.filter(snapshot => !snapshot.hasTracking).length;

  const body = sections.map(section =>
    section.map(row => renderRow(row, nameWidth, stateWidth)).join("\n"),
  );

  return [renderHeader(inFlight, snapshots.length, unmeasured), "", ...body]
    .join("\n")
    .trimEnd();
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

function renderHeader(inFlight: number, repoCount: number, unmeasured: number): string {
  const branches = plural(inFlight, "branch", "branches");
  const repos = plural(repoCount, "repository", "repositories");
  const headline = `${branches} in flight across ${repos}`;

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
function renderNothingInFlight(repoCount: number): string {
  return [
    `Nothing in flight across ${plural(repoCount, "repository", "repositories")}.`,
    "Every branch is level with its upstream.",
    "",
    "Uncommitted work is not counted here — add --dirty to read working trees.",
  ].join("\n");
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
