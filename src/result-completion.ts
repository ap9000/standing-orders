/**
 * v102: what a result actually changed, read from the build's sealed diff
 * inventory, and whether a result that changed protected files may go out.
 * Completion and publication share this so neither can be the gap.
 */
import type { Store } from "./store.js";
import { readVerifiedArtifact } from "./evidence.js";

/** The ledger action a person's (or lead's) completion of a result writes. */
export const COMPLETION_ACTION = "assignment handoff checked";

/** The files a build changed, renames on both sides; null when the inventory can't be read whole. */
export function changedFilesOf(store: Store, runId: number, root: string): string[] | null {
  const stat = store.artifactsFor(runId).find(one => one.kind === "diff-stat");
  if (stat === undefined || stat.truncated || stat.captureStatus !== "ok") return null;
  const read = readVerifiedArtifact(root, stat);
  if (!read.ok) return null;
  try {
    const inventory = JSON.parse(read.content.toString("utf8")) as { filesTruncated?: boolean; files?: { path?: unknown; renamedFrom?: unknown }[] };
    if (inventory.filesTruncated !== false || !Array.isArray(inventory.files)) return null;
    // A rename changes both places: moving a protected file out of its folder touches it.
    return inventory.files.flatMap(one => [one.path, one.renamedFrom]).filter((path): path is string => typeof path === "string" && path !== "");
  } catch { return null; }
}

/** Everything a result's branch carries: this build's changes and every build of every task it revises (a
 * revision builds on its source's head, so its branch holds the source's commits too). null when any of
 * them can't be read whole. */
export function familyChangedFiles(store: Store, taskId: string, runId: number, root: string): string[] | null {
  const files = new Set<string>();
  const runs = new Set<number>([runId]);
  const chain = store.revisionAncestryStatus(taskId).chain;
  for (const id of chain.length === 0 ? [taskId] : chain) {
    const ref = store.lookupRef(id);
    if (ref === null) continue;
    for (const run of store.runsFor(ref.id)) if ((run.role === "builder" || run.role === "repair") && (id !== taskId || run.id === runId)) runs.add(run.id);
  }
  for (const id of runs) {
    // A build that never recorded a diff contributed nothing to the branch; one whose diff can't be read counts as protected.
    if (!store.artifactsFor(id).some(one => one.kind === "diff-stat") && id !== runId) continue;
    const changed = changedFilesOf(store, id, root);
    if (changed === null) return null;
    for (const file of changed) files.add(file);
  }
  return [...files];
}

/** Why a build's branch must wait before it's pushed (and so before any PR or merge): it (or a task it
 * revises) changed protected files on a one-person approval, and nobody but its approver and requesters
 * has marked it complete. */
export function protectedPublicationHold(store: Store, runId: number, root: string): string | null {
  const run = store.getRun(runId);
  const taskId = run === null ? null : store.externalIdFor(run.taskRef);
  if (taskId === null) return null;
  const changed = familyChangedFiles(store, taskId, runId, root);
  if (store.protectedResultProblem(taskId, changed, null) === null) return null;
  const completers = store.handle.prepare("SELECT DISTINCT actor FROM action_ledger WHERE run_id = ? AND action = ?").all(runId, COMPLETION_ACTION)
    .map(row => String(row["actor"])).filter(actor => actor.startsWith("operator:")).map(actor => actor.slice("operator:".length));
  if (completers.some(name => store.protectedResultProblem(taskId, changed, name) === null)) return null;
  return "held: it changed protected files on a one-person approval, so it publishes once someone other than its approver marks it complete";
}
