/**
 * Parsers for git plumbing output.
 *
 * Pure functions over strings — no child_process, no fs. Shelling out lives in
 * the caller, so the part most worth testing needs no fixture repo. This is also
 * why discovery can claim to be read-only: nothing here can reach a repository.
 */

export type Worktree = {
  path: string;
  head: string;
  /** null when in detached HEAD — which is how treehouse leases worktrees. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

export type TrackingState = {
  ahead: number;
  behind: number;
  /** Upstream existed and was deleted — the merged-and-cleaned-up case. */
  gone: boolean;
};

export type Branch = {
  name: string;
  track: TrackingState;
  /** Opaque ISO-8601 from git, passed through untouched. Never reformatted here. */
  committedAt: string;
};

const HEADS_PREFIX = "refs/heads/";

const emptyTrack = (): TrackingState => ({ ahead: 0, behind: 0, gone: false });

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are separated by blank lines; each is a sequence of `key value` lines
 * where `detached`, `bare`, `locked` and `prunable` are bare flags that may carry
 * a trailing reason we deliberately discard.
 */
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(parseWorktreeBlock)
    .filter((wt): wt is Worktree => wt !== null);
}

function parseWorktreeBlock(block: string): Worktree | null {
  const lines = block.split("\n");
  const path = readValue(lines, "worktree");
  if (path === null) return null;

  const branchRef = readValue(lines, "branch");

  return {
    path,
    head: readValue(lines, "HEAD") ?? "",
    branch: branchRef === null ? null : stripHeadsPrefix(branchRef),
    detached: hasFlag(lines, "detached"),
    bare: hasFlag(lines, "bare"),
    locked: hasFlag(lines, "locked"),
    prunable: hasFlag(lines, "prunable"),
  };
}

/** First value for `key`, or null when absent. Values may contain spaces. */
function readValue(lines: string[], key: string): string | null {
  const prefix = `${key} `;
  const line = lines.find(l => l.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

/** Flags appear bare (`detached`) or with a trailing reason (`locked why`). */
function hasFlag(lines: string[], flag: string): boolean {
  return lines.some(l => l === flag || l.startsWith(`${flag} `));
}

function stripHeadsPrefix(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

/**
 * Parse the `%(upstream:track)` field: `""`, `"[gone]"`, `"[ahead 2]"`,
 * `"[behind 5]"`, or `"[ahead 2, behind 5]"`.
 *
 * Unrecognized input yields a zeroed state rather than throwing — a tracking
 * field we cannot read must never take down discovery of the repo around it.
 */
export function parseTrack(field: string): TrackingState {
  const trimmed = field.trim();
  if (trimmed === "") return emptyTrack();
  if (trimmed === "[gone]") return { ahead: 0, behind: 0, gone: true };

  return {
    ahead: readCount(trimmed, "ahead"),
    behind: readCount(trimmed, "behind"),
    gone: false,
  };
}

function readCount(field: string, key: "ahead" | "behind"): number {
  const match = field.match(new RegExp(`${key} (\\d+)`));
  return match === null ? 0 : Number(match[1]);
}

/**
 * Parse tab-separated `git for-each-ref` output:
 *
 *   %(refname:short)\t%(upstream:track)\t%(committerdate:iso8601-strict)
 *
 * Tabs rather than spaces because a ref name may not contain a tab, but the
 * tracking field always does.
 */
export function parseBranches(output: string): Branch[] {
  return output
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(parseBranchLine);
}

function parseBranchLine(line: string): Branch {
  const [name = "", track = "", committedAt = ""] = line.split("\t");
  return { name: name.trim(), track: parseTrack(track), committedAt: committedAt.trim() };
}
