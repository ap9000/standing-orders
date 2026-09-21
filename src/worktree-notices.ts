import { createHash } from "node:crypto";

/** One announcement for a reconciliation batch. The complete path inventory
 * stays in worktree rows and reconcile's result; this grants no reuse/deletion
 * authority and performs no filesystem or database changes. */
export function worktreeAdoptionNotice(repo: string, adopted: readonly string[], now: Date) {
  const paths = [...new Set(adopted)].sort();
  if (paths.length === 0) return null;
  const count = paths.length, plural = count !== 1;
  const digest = createHash("sha256").update(JSON.stringify([repo, paths, now.toISOString()])).digest("hex");
  return {
    source: { project: repo }, dedupeKey: `worktree-adoption:${digest}`, kind: "worktree-adopted",
    subject: `${count} worktree${plural ? "s" : ""} need${plural ? "" : "s"} review`,
    body: `${count} existing worktree${plural ? "s were" : " was"} added to the inventory as released and unverified. Review before reusing or deleting ${plural ? "them" : "it"}.`,
    link: `/system?project=${encodeURIComponent(repo)}`,
  };
}
