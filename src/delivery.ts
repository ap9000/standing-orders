import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { authenticateApprover } from "./scope.js";
import { bodyHashOf, publicationBody } from "./publish.js";

export type DeliveryTerms = { githubRepo: string; remote: string; base: string; headPrefix: string };

export function previewDelivery(store: Store, taskId: string, runId: number, terms: DeliveryTerms) {
  const ref = store.lookupRef(taskId);
  const run = store.getRun(runId);
  if (ref?.repo == null || run === null || run.taskRef !== ref.id || run.outcome !== "built" || !run.committed || run.headRevision === null || run.branch === null) {
    return { ok: false as const, message: "Choose a completed build with a recorded commit." };
  }
  if (store.hasRedactedTerminalDiff(runId)) return { ok: false as const, message: "The diff contains a detected secret. Review and repair it before publishing." };
  const existing = store.publicationGrantFor(ref.repo);
  const grant = existing ?? { repo: ref.repo, ...terms, capabilities: ["push-branch", "open-pr"] as ("push-branch" | "open-pr")[], selector: "ours" as const, draft: true, merge: false };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(grant.githubRepo) || !/^[A-Za-z0-9_.-]+$/.test(grant.remote) || grant.remote.startsWith("-") ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(grant.base) || grant.base.includes("..") || grant.base.endsWith(".lock") ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*\/$/.test(grant.headPrefix) || grant.headPrefix.includes("..")) {
    return { ok: false as const, message: "Name a GitHub owner/repository, remote, base branch, and branch prefix ending in /." };
  }
  if (!run.branch.startsWith(grant.headPrefix) || !grant.capabilities.includes("push-branch") || !grant.capabilities.includes("open-pr") || (grant.selector === "ours" && ref.origin !== "ours")) {
    return { ok: false as const, message: "The current publication grant does not cover this build and opening a PR. Update the repository's grant first." };
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ taskId, runId, head: run.headRevision, branch: run.branch, grant,
    scope: store.getScope(taskId)?.digest, title: store.getTask(taskId)?.title, handoff: run.handoff })).digest("hex");
  return { ok: true as const, ref, run, grant, newGrant: existing === null, fingerprint };
}

export function approveDelivery(store: Store, input: { taskId: string; runId: number; terms: DeliveryTerms; fingerprint: string; by: string; token: string; now: Date }) {
  return store.transact(() => {
    if (!authenticateApprover(store, input.by, input.token).ok) return { ok: false as const, message: "Publishing requires your operator credential." };
    const preview = previewDelivery(store, input.taskId, input.runId, input.terms);
    if (!preview.ok) return preview;
    if (preview.fingerprint !== input.fingerprint) return { ok: false as const, message: "The build or grant changed. Review publication again." };
    if (preview.newGrant) store.savePublicationGrant({ ...preview.grant, grantedBy: input.by }, input.now);
    let publication = store.publicationForRun(input.runId);
    if (publication === null) {
      store.createPublicationIntent({ run: input.runId, taskRef: preview.ref.id, githubRepo: preview.grant.githubRepo,
        remote: preview.grant.remote, base: preview.grant.base, head: preview.run.branch!, headSha: preview.run.headRevision!,
        bodyHash: "", draft: preview.grant.draft }, input.now);
      publication = store.publicationForRun(input.runId)!;
      store.handle.prepare("UPDATE publication SET body_hash = ? WHERE id = ?").run(bodyHashOf(publicationBody(store, publication)), publication.id);
      store.addRunNote(input.runId, input.by, "Approved publication of the recorded commit as a pull request.", input.now);
    }
    return { ok: true as const, repo: preview.ref.repo!, publication };
  });
}
