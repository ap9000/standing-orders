/** A compact projection of saved work, never a percentage or an ETA. */
import { manualReviewOnly, semanticCoverage } from "./proof.js";
import { modeTermsFromJson } from "./modes.js";
import { chatResultHref, chatControlHref } from "./chat-controls.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import type { Run, Store } from "./store.js";

/** Offsets are UTF-16, as required by Telegram. Only our two headings are bold;
 * user text stays literal, including angle brackets and Markdown characters. */
export type ProgressEntity = { type: "bold"; offset: number; length: number };

export function telegramProgressCard(store: Store, run: Run, taskId: string, project: string, now = new Date()): { text: string; entities: ProgressEntity[]; link: PhoneTaskLink } {
  const proof = store.proofVerdictFor(run.id);
  const rows = proof?.matrix ?? [];
  const passed = rows.filter(row => row.state === "pass").length;
  const human = manualReviewOnly(proof);
  const accepted = store.proofAcceptance(run.id) !== null;
  const review = store.reviewRetryStateOf(run.id);
  const coverage = semanticCoverage(rows, run.qualityMode ?? "default");
  const mode = store.activeMode(project, now);
  const reviewPlanned = coverage.required || (mode !== null && modeTermsFromJson(mode.termsJson)?.reviewAuto === true) ||
    (review !== null && review.state !== "unrequested");
  const built = run.finishedAt !== null && (run.outcome === "built" || run.outcome === "no-change");
  const concerns = rows.filter(row => row.coverage?.state === "gap" || (row.coverage?.gaps.length ?? 0) > 0 || row.review?.judgement === "contradicts" || row.review?.judgement === "cannot-tell").length;
  let status = "Working";
  let icon = "⏳";
  let next = "";
  let build = built ? "✓ Build saved" : "● Build in progress";
  let checks = rows.length ? `${passed === rows.length ? "✓" : "○"} Checks · ${passed}/${rows.length} requirements` : "○ Checks pending";
  let reviewer = "○ Review pending";
  let label = built ? "Review result" : "Open task";
  if (run.outcome === null && run.phase !== null && run.phase !== "agent-running") {
    status = run.phase === "correcting-proof" ? "Preparing review evidence" : "Checking the result";
    build = "✓ Draft prepared";
    checks = "● Checks in progress";
  }
  if (built) {
    status = run.committed === false ? "Finished without a commit" : "Result saved";
    next = reviewPlanned ? "Next: independent review." : "";
    if (!reviewPlanned && run.committed !== false && (proof?.verdict === "verified" || human)) {
      status = accepted ? "Human acceptance recorded" : "Ready for your review";
      icon = "✅";
      if (human && !accepted) next = "Next: your acceptance.";
    }
    if (review?.state === "queued" || review?.state === "running") {
      status = review.state === "queued" ? "Waiting for review" : "Reviewing";
      reviewer = review.state === "queued" ? "○ Review queued" : "● Review in progress";
      next = "";
    } else if (review?.state === "retryable" || review?.state === "exhausted") {
      status = "Review needs attention";
      icon = "⚠️";
      reviewer = "! Review did not finish";
      next = review.state === "retryable" ? "Next: inspect the blocker before retrying review." : "Review attempts are exhausted. Inspect the result.";
      label = "Review blocker";
    } else if (review?.state === "succeeded") {
      reviewer = "✓ Review complete";
      const ready = proof?.verdict === "verified" || human;
      status = ready ? accepted ? "Human acceptance recorded" : "Ready for your review" : "Evidence needs attention";
      icon = ready ? "✅" : "⚠️";
      next = !accepted && human ? "Next: your acceptance." : "";
    }
    if (proof === null) checks = "○ Checks not recorded";
    if (review?.state === "succeeded" && coverage.required && coverage.satisfied !== true) {
      status = "Review incomplete";
      icon = "⚠️";
      reviewer = `! Review · ${coverage.upheld.length}/${rows.length} requirements confirmed`;
      next = "Next: address the review findings.";
    }
  } else if (run.outcome !== null) {
    status = run.outcome === "parked" ? "Decision needed" : run.outcome === "interrupted" || run.reason === "interrupted" ? "Stopped" : "Build needs attention";
    icon = run.outcome === "parked" ? "💬" : "⏸";
    build = "! Build unfinished";
    next = "Next: inspect the blocker.";
    label = "Review blocker";
  }
  if (built && (concerns > 0 || proof?.verdict === "refuted" || (proof?.verdict === "short" && !human))) {
    status = "Evidence needs attention";
    icon = "⚠️";
    next = concerns > 0 ? `${concerns} requirement${concerns === 1 ? " needs" : "s need"} better evidence. Review the findings.` : "Next: fix the failed or missing checks.";
    label = "Review checks";
  }
  const stop = store.stopOf(run.id);
  if (run.outcome === null && stop !== null && stop.resumedAt === null) {
    status = stop.settledAt === null ? "Stopping" : "Stopped";
    icon = "⏸";
    build = stop.settledAt === null ? "● Build stopping" : "! Build stopped";
    next = stop.settledAt === null ? "Waiting for the running process to stop." : "Next: review and resume the saved work.";
  }
  const holds = store.activeHolds(run.taskRef, now);
  const operatorHold = holds.find(hold => hold.ownerKind === "operator");
  const accessBlocked = run.reason === "retryable-infra" && /^could not re-read (?:the branch|HEAD) in /i.test(run.handoff ?? "");
  if (accessBlocked) {
    status = "Worker needs project access";
    icon = "⏸";
    next = "Next: restore the worker’s folder access, then resume.";
    label = "Review blocker";
  }
  if (operatorHold) {
    icon = "⏸";
    if (!accessBlocked) {
      status = run.outcome === null ? "Working · Next attempt paused" : "Paused";
      next = phoneText(operatorHold.reason, 150);
    }
    label = "Review hold";
  } else if (accessBlocked && holds.some(hold => hold.ownerKind === "backoff")) {
    next = "The worker will retry after a short pause. Check its folder access.";
  }
  const publication = store.publicationForRun(run.id);
  const delivery = publication?.remoteState === "MERGED" ? "Merged · Installation not confirmed" : publication?.remoteState === "CLOSED" ? "Pull request closed without merging" : publication?.state === "opened" ? "Pull request open · Not merged" : publication?.state === "pushed" ? "Branch pushed · Pull request pending" : publication?.state === "intended" ? "Publication queued" : publication?.state === "failed" ? "Publication failed · Local result preserved" : built ? "Saved locally · Not published" : null;
  const title = phoneText(store.getTask(taskId)?.title ?? taskId, 88);
  const heading = `${icon} ${status}`;
  const text = [title, heading, "", build, checks, ...(reviewPlanned ? [reviewer] : []),
    ...(next ? ["", next] : []),
    ...(accepted && status !== "Human acceptance recorded" ? [human ? "Human acceptance recorded" : "Accepted with an exception"] : []),
    ...(delivery === null ? [] : ["", delivery]), "", `${projectLabel(project)} · #${run.id}`].join("\n");
  return { text, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
    link: { label, path: operatorHold || accessBlocked || (!built && run.outcome !== null)
      ? chatControlHref("recovery", taskId) : built ? chatResultHref(taskId, run.id, "checks") : chatControlHref("task", taskId) } };
}
