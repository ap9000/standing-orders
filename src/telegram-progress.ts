/** A compact projection of saved work, never a percentage or an ETA. */
import { manualReviewOnly, semanticCoverage } from "./proof.js";
import { chatResultHref } from "./chat-controls.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import type { Run, Store } from "./store.js";

export function telegramProgressCard(store: Store, run: Run, taskId: string, project: string): { text: string; link: PhoneTaskLink } {
  const proof = store.proofVerdictFor(run.id);
  const rows = proof?.matrix ?? [];
  const passed = rows.filter(row => row.state === "pass").length;
  const human = manualReviewOnly(proof);
  const accepted = store.proofAcceptance(run.id) !== null;
  const review = store.reviewRetryStateOf(run.id);
  const coverage = semanticCoverage(rows, run.qualityMode ?? "default");
  const built = run.finishedAt !== null && (run.outcome === "built" || run.outcome === "no-change");
  const concerns = rows.filter(row => row.coverage?.state === "gap" || (row.coverage?.gaps.length ?? 0) > 0 || row.review?.judgement === "contradicts" || row.review?.judgement === "cannot-tell").length;
  let status = "Building";
  let remaining = "";
  let build = built ? "✓" : "running";
  let checks = rows.length ? `${passed}/${rows.length}` : "pending";
  let reviewer = coverage.required ? "not requested" : "optional";
  if (run.outcome === null && run.phase !== null && run.phase !== "agent-running") {
    status = run.phase === "correcting-proof" ? "Fixing evidence" : "Checking the result";
    build = "saved draft";
    checks = "running";
  }
  if (built) {
    status = run.committed === false ? "Finished without a commit" : "Result saved";
    remaining = coverage.required ? "Open the result to request independent review." : "";
    if (!coverage.required && run.committed !== false && (proof?.verdict === "verified" || human)) {
      status = accepted ? "Human acceptance recorded" : "Ready for your review";
      if (human && !accepted) remaining = "Remaining: your acceptance.";
    }
    if (review?.state === "queued" || review?.state === "running") {
      status = review.state === "queued" ? "Waiting for review" : "Independent review running";
      reviewer = review.state === "queued" ? "queued" : "running";
      remaining = "Then: review the result.";
    } else if (review?.state === "retryable" || review?.state === "exhausted") {
      status = "Review did not finish";
      reviewer = "stopped";
      remaining = review.state === "retryable" ? "Open the result to retry review." : "Review attempts are exhausted. Open the result.";
    } else if (review?.state === "succeeded") {
      reviewer = "✓";
      const ready = proof?.verdict === "verified" || human;
      status = concerns > 0 ? "Evidence needs attention" : ready ? accepted ? "Human acceptance recorded" : "Ready for your review" : "Evidence needs attention";
      remaining = concerns > 0 ? `${concerns} requirement${concerns === 1 ? " has" : "s have"} an evidence gap or reviewer concern.` : accepted ? "" : human ? "Remaining: your acceptance." : ready ? "" : "Open the checks to see what needs fixing.";
    }
    if (proof === null) checks = "not recorded";
    if (review?.state === "succeeded" && coverage.required && coverage.satisfied !== true) {
      status = "Independent review incomplete";
      reviewer = "incomplete";
      remaining = `${coverage.upheld.length}/${rows.length} requirements confirmed. Open the review findings.`;
    }
  } else if (run.outcome !== null) {
    status = run.outcome === "parked" ? "Waiting for a decision" : run.outcome === "interrupted" || run.reason === "interrupted" ? "Stopped" : "Build did not finish";
    build = "stopped";
    remaining = "Open the task to see what must happen next.";
  }
  if (built && (concerns > 0 || proof?.verdict === "refuted" || (proof?.verdict === "short" && !human))) {
    status = "Evidence needs attention";
    remaining = concerns > 0 ? `${concerns} requirement${concerns === 1 ? " has" : "s have"} an evidence gap or reviewer concern.` : "Open the checks to see what needs fixing.";
  }
  const stop = store.stopOf(run.id);
  if (run.outcome === null && stop !== null && stop.resumedAt === null) {
    status = stop.settledAt === null ? "Stopping" : "Stopped";
    build = stop.settledAt === null ? "stopping" : "stopped";
    remaining = stop.settledAt === null ? "Waiting for the running process to stop." : "Open the task to resume its saved work.";
  }
  const publication = store.publicationForRun(run.id);
  const delivery = publication?.remoteState === "MERGED" ? "Merged · Installation not confirmed here" : publication?.remoteState === "CLOSED" ? "Pull request closed without merging" : publication?.state === "opened" ? "Pull request open · Not merged" : publication?.state === "pushed" ? "Branch pushed · Pull request not confirmed" : publication?.state === "intended" ? "Publication queued" : publication?.state === "failed" ? "Publication failed · Local result preserved" : built ? "Saved locally · Not published" : null;
  return {
    text: [phoneText(store.getTask(taskId)?.title ?? taskId, 88), `${projectLabel(project)} · Attempt #${run.id}`, "", status,
      `Build ${build} · Checks ${checks} · Review ${reviewer}`, ...(remaining ? [remaining] : []),
      ...(accepted && status !== "Human acceptance recorded" ? [human ? "Human acceptance recorded" : "Accepted with an exception"] : []),
      ...(delivery === null ? [] : [delivery])].join("\n"),
    link: { label: built ? "Review result" : "Open task", path: built ? chatResultHref(taskId, run.id, "checks") : `/chat?task=${encodeURIComponent(taskId)}` },
  };
}
