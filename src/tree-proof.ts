/**
 * The read-only roles' clean-tree proof (planner, scout — mate arc §10,
 * v4 review finding 4). `git status --porcelain` alone is not a proof: it
 * omits IGNORED paths, so an agent could leave a generated file behind
 * and pass; and a pathname filter that exempts the protocol files
 * regardless of index status would let an agent `git add` its own
 * handoff and pass with a dirty index. So: ignored paths are snapshotted
 * BEFORE the agent runs and any new one afterwards is foreign; and a
 * protocol file is admitted only as plain untracked (`??`) — staged is
 * foreign. Ignored directories are collapsed by git (`!! build/`), so a
 * write INTO a directory that was already ignored before the agent ran
 * (a dependency tree the setup command produced) is not detected — that
 * residual is stated here rather than wished away.
 */

import type { Runner } from "./builder.js";

const GIT = "git";
const STATUS_ARGS = ["--no-optional-locks", "-c", "core.quotePath=false", "status", "--porcelain", "--ignored"] as const;

/** The ignored paths git reports right now — the "before" of a proof. */
export async function snapshotIgnored(git: Runner, cwd: string): Promise<Set<string> | null> {
  const status = await git(GIT, [...STATUS_ARGS], { cwd });
  if (status.code !== 0) return null;
  const ignored = new Set<string>();
  for (const line of status.stdout.split("\n")) {
    if (line.startsWith("!! ")) ignored.add(line.slice(3));
  }
  return ignored;
}

export type TreeProof =
  | { ok: true }
  | { ok: false; reason: "git" | "dirty-tree"; foreign: string[] };

/**
 * Everything in the tree that is not (a) an ignored path that was already
 * ignored before, (b) one of this attempt's own protocol files as PLAIN
 * untracked, or (c) the pool's untracked lease marker.
 */
export async function proveTreeUntouched(
  git: Runner,
  cwd: string,
  args: { ignoredBefore: ReadonlySet<string>; protocolFiles: readonly string[]; marker: string },
): Promise<TreeProof> {
  const status = await git(GIT, [...STATUS_ARGS], { cwd });
  if (status.code !== 0) return { ok: false, reason: "git", foreign: [] };
  const foreign: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === "!!") {
      if (!args.ignoredBefore.has(path)) foreign.push(path);
      continue;
    }
    const own = args.protocolFiles.includes(path) || path === args.marker;
    // Untracked is the only admissible state for a protocol file: a staged
    // one would survive cleanup in the index and ride into somebody's
    // commit.
    if (own && code === "??") continue;
    foreign.push(own ? `${path} (staged)` : path);
  }
  return foreign.length === 0 ? { ok: true } : { ok: false, reason: "dirty-tree", foreign };
}
