/**
 * Putting the command on PATH, as an explicit act.
 *
 * Night Orders refuses to install things on an operator's behalf — it prints
 * the command and its side effects and lets them run it. A tool that applied
 * that rule to `bd init` and then quietly edited PATH during its own install
 * would not deserve to be believed, so this is a command you run, it shows
 * you what it will do before it does it, and `unlink` undoes it exactly.
 *
 * Three rules hold throughout: never sudo, never a directory outside the home
 * directory unless explicitly named, and never delete anything that is not a
 * symlink we put there.
 */

import { chmod, mkdir, lstat, readlink, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const BIN_NAME = "nightorders";

/** Owner, group, and other execute — the same bits npm sets on a package bin. */
const EXECUTABLE_BITS = 0o111;

export type TargetChoice = { dir: string; onPath: boolean };

export type LinkPlan =
  | { action: "create"; source: string; target: string }
  | { action: "already"; source: string; target: string }
  | { action: "replace"; source: string; target: string; current: string }
  | { action: "conflict"; source: string; target: string; reason: string };

export type UnlinkPlan =
  | { action: "remove"; target: string; current: string }
  | { action: "absent"; target: string }
  | { action: "foreign"; target: string; reason: string };

/**
 * Where the link should go. Only directories inside the home directory are
 * ever proposed: everything else needs sudo, and needing sudo to read your own
 * git repositories would be absurd.
 */
export function chooseTarget(options: {
  pathEntries: readonly string[];
  home: string;
  override?: string;
}): TargetChoice {
  const { pathEntries, home, override } = options;
  const isOnPath = (dir: string) => pathEntries.includes(dir);

  if (override !== undefined) {
    const dir = resolve(override);
    return { dir, onPath: isOnPath(dir) };
  }

  const conventional = [join(home, ".local", "bin"), join(home, "bin")];
  const preferred = conventional.find(isOnPath);
  if (preferred !== undefined) return { dir: preferred, onPath: true };

  const homeOwned = pathEntries.find(entry => entry.startsWith(`${home}/`));
  if (homeOwned !== undefined) return { dir: homeOwned, onPath: true };

  // Nothing usable on PATH. Propose the conventional location and say so.
  return { dir: conventional[0] as string, onPath: false };
}

export async function planLink(source: string, dir: string): Promise<LinkPlan> {
  const target = join(dir, BIN_NAME);
  const existing = await describeExisting(target);

  if (existing === null) return { action: "create", source, target };
  if (existing.symlinkTo === null) {
    return {
      action: "conflict",
      source,
      target,
      reason: "something that is not a link is already there",
    };
  }
  if (existing.symlinkTo === source) return { action: "already", source, target };
  return { action: "replace", source, target, current: existing.symlinkTo };
}

export async function applyLink(plan: LinkPlan): Promise<void> {
  if (plan.action === "conflict") {
    throw new Error(`${plan.target}: ${plan.reason} — remove it yourself if you want it gone`);
  }
  if (plan.action === "already") return;

  await mkdir(dirname(plan.target), { recursive: true });
  // Only ever removing a symlink we recognise, never a real file.
  if (plan.action === "replace") await unlink(plan.target);
  await symlink(plan.source, plan.target);
  await ensureExecutable(plan.source);
}

/**
 * tsc emits a file with the shebang intact but without the execute bit, so a
 * symlink to it fails with "permission denied" the first time it is typed.
 */
async function ensureExecutable(source: string): Promise<void> {
  const stats = await stat(source);
  const wanted = stats.mode | EXECUTABLE_BITS;
  if (wanted !== stats.mode) await chmod(source, wanted);
}

export async function planUnlink(dir: string): Promise<UnlinkPlan> {
  const target = join(dir, BIN_NAME);
  const existing = await describeExisting(target);

  if (existing === null) return { action: "absent", target };
  if (existing.symlinkTo === null) {
    return { action: "foreign", target, reason: "it is a real file, not a link we made" };
  }
  return { action: "remove", target, current: existing.symlinkTo };
}

export async function applyUnlink(plan: UnlinkPlan): Promise<void> {
  if (plan.action === "foreign") {
    throw new Error(`${plan.target}: ${plan.reason} — leaving it alone`);
  }
  if (plan.action === "absent") return;
  await unlink(plan.target);
}

/** null when nothing is there; symlinkTo is null when it is not a symlink. */
async function describeExisting(target: string): Promise<{ symlinkTo: string | null } | null> {
  try {
    const stats = await lstat(target);
    if (!stats.isSymbolicLink()) return { symlinkTo: null };
    return { symlinkTo: await readlink(target) };
  } catch {
    return null;
  }
}
