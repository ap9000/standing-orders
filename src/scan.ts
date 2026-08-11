/**
 * Finding git repositories on disk.
 *
 * This is the first thing Night Orders does and the only thing it does before
 * the operator has configured anything, so it has to be fast, total, and
 * strictly read-only. It reads directory entries. It never opens a file, never
 * follows a symlink, and never descends into a repository it has found.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type ScanOptions = {
  /** Directory levels below each root to examine. A root itself is depth 0. */
  maxDepth?: number;
  /** Directory names never descended into. */
  skip?: ReadonlySet<string>;
  /** Dot-directories are skipped by default; worktrees come from git, not the walk. */
  includeHidden?: boolean;
};

/**
 * Directories that hold other people's code, build output, or caches. Skipping
 * these is most of the difference between a scan that takes a second and one
 * that takes a minute — a single checkout's `node_modules` can hold thousands
 * of vendored repositories, none of which are yours.
 */
export const DEFAULT_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  "Pods",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "venv",
  "__pycache__",
  "Library",
  "Applications",
  "System",
]);

export const DEFAULT_MAX_DEPTH = 6;

const GIT_DIR = ".git";

type Frame = { path: string; depth: number };

/**
 * Every repository at or below `roots`, sorted and deduplicated.
 *
 * Unreadable directories are skipped rather than raised: a scan of a home
 * directory will always meet something it cannot open, and that must not be
 * the reason the operator sees nothing.
 */
export async function findRepos(
  roots: readonly string[],
  options: ScanOptions = {},
): Promise<string[]> {
  const { maxDepth = DEFAULT_MAX_DEPTH, skip = DEFAULT_SKIP, includeHidden = false } = options;

  const found = new Set<string>();
  const visited = new Set<string>();
  const stack: Frame[] = roots.map(path => ({ path, depth: 0 }));

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (visited.has(frame.path)) continue;
    visited.add(frame.path);

    const entries = await readEntries(frame.path);
    if (entries === null) continue;

    if (entries.some(entry => entry.name === GIT_DIR)) {
      found.add(frame.path);
      continue;
    }
    if (frame.depth >= maxDepth) continue;

    for (const entry of entries) {
      if (!isDescendable(entry, { skip, includeHidden })) continue;
      stack.push({ path: join(frame.path, entry.name), depth: frame.depth + 1 });
    }
  }

  return [...found].sort();
}

type Entry = { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean };

async function readEntries(path: string): Promise<Entry[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    // Missing, unreadable, or not a directory. All three mean "nothing here".
    return null;
  }
}

/**
 * Symlinks are never followed. A link pointing at an ancestor would otherwise
 * make the walk unbounded, and one pointing outside the scanned roots would
 * quietly widen the scan past what the operator asked for.
 */
function isDescendable(
  entry: Entry,
  options: { skip: ReadonlySet<string>; includeHidden: boolean },
): boolean {
  if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  if (options.skip.has(entry.name)) return false;
  return options.includeHidden || !entry.name.startsWith(".");
}
