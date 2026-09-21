/** A compact projection of saved work, never a percentage or an ETA. The
 * words come from the same assignment record the console and the CLI show:
 * a finished build is Ready once its saved result can be inspected, and
 * Complete once the lead or a person has marked that exact result. No model
 * reviewer is waited for or announced. */
import { manualReviewOnly } from "./proof.js";
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { chatResultHref, chatControlHref } from "./chat-controls.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import type { Run, Store } from "./store.js";

/** Offsets are UTF-16, as required by Telegram. Only our two headings are bold;
 * user text stays literal, including angle brackets and Markdown characters. */
export type ProgressEntity = { type: "bold"; offset: number; length: number };

/** The saved assignment for this exact result, or null when the run is not
 * the family's current result (an older attempt keeps its own plain words). */
function assignmentFor(store: Store, run: Run, taskId: string, project: string, now: Date, root: string | undefined): AssignmentSnapshot | null {
  try {
    const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: [project] }, root);
    return assignment !== null && assignment.receipt?.runId === run.id ? assignment : null;
  } catch {
    return null;
  }
}

export function telegramProgressCard(store: Store, run: Run, taskId: string, project: string, now = new Date(), root?: string): { text: string; entities: ProgressEntity[]; link: PhoneTaskLink } {
  const proof = store.proofVerdictFor(run.id);
  const rows = proof?.matrix ?? [];
  const direct = rows.length > 0 && rows.every(row => row.assessment !== undefined);
  const passed = rows.filter(row => row.state === "pass").length;
  const human = manualReviewOnly(proof);
  const accepted = store.proofAcceptance(run.id) !== null;
  const built = run.finishedAt !== null && (run.outcome === "built" || run.outcome === "no-change");
  const assignment = built ? assignmentFor(store, run, taskId, project, now, root) : null;
  const checksFailed = assignment?.receipt?.checks.status === "failed";
  let status = "Working";
  let icon = "⏳";
  let next = "";
  let build = built ? "✓ Build saved" : "● Build in progress";
  let checks = rows.length ? `${passed === rows.length ? "✓" : "○"} Checks · ${passed}/${rows.length} requirements` : "○ Checks pending";
  if (direct) checks = proof?.machineVerdict === "verified" ? "✓ Checks passed" : proof?.machineVerdict === "attested" ? "○ Checks not configured" : "! Checks need attention";
  let label = built ? "Open result" : "Open task";
  if (run.outcome === null && run.phase !== null && run.phase !== "agent-running") {
    status = "Checking the result";
    build = "✓ Draft prepared";
    checks = "● Checks in progress";
  }
  if (built) {
    status = run.committed === false ? "Finished without a commit" : "Result saved";
    if (proof === null) checks = "○ Checks not recorded";
    const recorded = assignment?.receipt?.checks;
    if (recorded !== undefined && recorded.status !== "unavailable") {
      checks = recorded.status === "passed" ? "✓ Checks passed"
        : recorded.status === "failed" ? `! Checks failed${recorded.exitCode === null ? "" : ` (exit ${recorded.exitCode})`}`
        : "○ Checks did not run";
    }
    if (assignment?.state === "ready-to-check") {
      status = "Ready";
      icon = checksFailed ? "⚠️" : "✅";
      next = checksFailed ? "Next: inspect the failed check, then mark it complete or request changes." : "Next: open the result, then mark it complete or request changes.";
    } else if (assignment?.state === "complete") {
      status = "Complete";
      icon = "✅";
      next = phoneText(assignment.detail, 200);
    } else if (assignment?.state === "needs-decision") {
      status = "Needs your decision";
      icon = "💬";
      next = phoneText(assignment.detail, 200);
    } else if (assignment?.state === "cancelled") {
      status = "Cancelled";
      icon = "⏹";
    } else if (assignment !== null) {
      next = phoneText(assignment.detail, 200);
    } else if (run.committed !== false) {
      next = "Open the task for its current status.";
    }
  } else if (run.outcome !== null) {
    status = run.outcome === "parked" ? "Decision needed" : run.outcome === "interrupted" || run.reason === "interrupted" ? "Stopped" : "Build needs attention";
    icon = run.outcome === "parked" ? "💬" : "⏸";
    build = "! Build unfinished";
    next = "Next: inspect the blocker.";
    label = "Open task";
  }
  const stop = store.stopOf(run.id);
  if (run.outcome === null && stop !== null && stop.resumedAt === null) {
    status = stop.settledAt === null ? "Stopping" : "Stopped";
    icon = "⏸";
    build = stop.settledAt === null ? "● Build stopping" : "! Build stopped";
    next = stop.settledAt === null ? "Waiting for the running process to stop." : "Next: inspect the saved work, then resume.";
  }
  const holds = store.activeHolds(run.taskRef, now);
  const operatorHold = holds.find(hold => hold.ownerKind === "operator");
  const accessBlocked = run.reason === "retryable-infra" && /^could not re-read (?:the branch|HEAD) in /i.test(run.handoff ?? "");
  if (accessBlocked) {
    status = "Worker needs project access";
    icon = "⏸";
    next = "Next: restore the worker’s folder access, then resume.";
    label = "Open task";
  }
  if (operatorHold) {
    icon = "⏸";
    if (!accessBlocked) {
      status = run.outcome === null ? "Working · Next attempt paused" : "Paused";
      next = phoneText(operatorHold.reason, 150);
    }
    label = "Open task";
  } else if (accessBlocked && holds.some(hold => hold.ownerKind === "backoff")) {
    next = "The worker will retry after a short pause. Check its folder access.";
  }
  const publication = store.publicationForRun(run.id);
  const delivery = publication?.remoteState === "MERGED" ? "Merged · Installation not confirmed" : publication?.remoteState === "CLOSED" ? "Pull request closed without merging" : publication?.state === "opened" ? "Pull request open · Not merged" : publication?.state === "pushed" ? "Branch pushed · Pull request pending" : publication?.state === "intended" ? "Publication queued" : publication?.state === "failed" ? "Publication failed · Local result preserved" : built ? "Saved locally · Not published" : null;
  const acceptance = accepted ? (human ? "Accepted by a person · Recorded checks unchanged" : "Accepted with an exception · Recorded checks unchanged") : null;
  const title = phoneText(store.getTask(taskId)?.title ?? taskId, 88);
  const heading = `${icon} ${status}`;
  const text = [title, heading, "", build, checks,
    ...(next ? ["", next] : []),
    ...(acceptance === null ? [] : [acceptance]),
    ...(delivery === null ? [] : ["", delivery]), "", `${projectLabel(project)} · #${run.id}`].join("\n");
  return { text, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
    link: { label, path: operatorHold || accessBlocked || (!built && run.outcome !== null)
      ? chatControlHref("recovery", taskId) : built ? chatResultHref(taskId, run.id, checksFailed ? "checks" : "summary") : chatControlHref("task", taskId) } };
}
