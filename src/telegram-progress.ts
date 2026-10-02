/** A compact projection of saved work, never a percentage or an ETA. The
 * headline, sentence and detail rows come from the shared task status
 * (task-status.ts), read from the same assignment record the console and the
 * CLI show: Ready for review once the saved result can be inspected, Complete
 * once the lead or a person has marked that exact result. Slack, Discord and
 * Teams send this same card. */
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { chatResultHref, chatControlHref } from "./chat-controls.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import type { Run, Store } from "./store.js";
import { assignmentStatusFacts, headlineEmoji, pullRequestFactOf, requirementsOf, statusDetailLines, taskStatusOf, type ChecksFact, type TaskStatusFacts } from "./task-status.js";
import { manualReviewOnly } from "./proof.js";
import { failedCheckExit } from "./workspace-ui.js";

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

export function telegramProgressCard(store: Store, run: Run, taskId: string, project: string, now = new Date(), root?: string): { text: string; entities: ProgressEntity[]; link: PhoneTaskLink; next: string } {
  const built = run.finishedAt !== null && (run.outcome === "built" || run.outcome === "no-change");
  const assignment = built ? assignmentFor(store, run, taskId, project, now, root) : null;
  const publication = store.publicationForRun(run.id);
  const pullRequest = publication === null ? undefined : pullRequestFactOf(publication);
  const stop = store.stopOf(run.id);
  const holds = store.activeHolds(run.taskRef, now);
  const operatorHold = holds.find(hold => hold.ownerKind === "operator");
  const accessBlocked = run.reason === "retryable-infra" && /^could not re-read (?:the branch|HEAD) in /i.test(run.handoff ?? "");
  // The one shared status: the same headline, sentence and rows as the console.
  let facts: TaskStatusFacts;
  if (assignment !== null && assignment.state !== "working" && assignment.state !== "checking") {
    facts = assignmentStatusFacts(assignment, pullRequest === undefined ? {} : { pullRequest });
  } else if (built) {
    // A saved result is Ready even in the moment before its worker lets go of
    // the task. Without its receipt yet, the stored machine verdict speaks.
    const recorded = assignment?.receipt?.checks ?? null;
    const proof = store.proofVerdictFor(run.id);
    const machine = proof?.machineVerdict ?? proof?.verdict ?? null;
    const exit = failedCheckExit(proof?.reasons ?? []);
    const checks: ChecksFact | null = recorded !== null ? { status: recorded.status, exitCode: recorded.exitCode, head: run.headRevision }
      : exit !== null ? { status: "failed", exitCode: exit, head: run.headRevision }
      : machine === "verified" ? { status: "passed", exitCode: null, head: run.headRevision }
      : machine === "attested" ? { status: "not-run", exitCode: null, head: null } : null;
    facts = { stage: "finished", report: run.role === "scout", checks, requirements: requirementsOf(proof?.matrix),
      ...(pullRequest === undefined ? {} : { pullRequest }) };
  } else if (accessBlocked) {
    facts = { stage: "needs-you", need: "other", reason: holds.some(hold => hold.ownerKind === "backoff")
      ? "The worker can't read the project folder. It retries after a short pause; check its folder access."
      : "The worker can't read the project folder. Restore its access, then resume." };
  } else if (run.outcome === null && stop !== null && stop.resumedAt === null) {
    facts = { stage: "stopped", reason: stop.settledAt === null ? "Stopping. Waiting for the running process to end." : "Paused by a person. Inspect the saved work, then resume." };
  } else if (operatorHold) {
    facts = { stage: "stopped", reason: `On hold: ${phoneText(operatorHold.reason, 150)}` };
  } else if (run.outcome === null) {
    facts = { stage: run.phase !== null && run.phase !== "agent-running" ? "checking" : run.role === "planner" ? "planning" : "building" };
  } else if (run.outcome === "parked") {
    facts = { stage: "needs-you", need: "answer" };
  } else if (run.outcome === "interrupted" || run.reason === "interrupted") {
    facts = { stage: "stopped", reason: "The attempt was interrupted. Inspect the saved work, then resume." };
  } else {
    facts = { stage: "failed", reason: "The build stopped before it finished. Inspect the blocker, then retry." };
  }
  const status = taskStatusOf(facts);
  const checkProgress = store.checkProgress(run.id);
  const progress = status.headline === "Building" && checkProgress !== null ? [`● ${checkProgress.line}`] : [];
  const title = phoneText(store.getTask(taskId)?.title ?? taskId, 88);
  const heading = `${headlineEmoji(status.headline)} ${status.headline}`;
  const next = phoneText(status.sentence, 200);
  // A person's acceptance is its own recorded decision; it never changes a check.
  const acceptance = store.proofAcceptance(run.id) === null ? [] : [manualReviewOnly(store.proofVerdictFor(run.id))
    ? "Accepted by a person · Recorded checks unchanged" : "Accepted with an exception · Recorded checks unchanged"];
  const rows = [...statusDetailLines(status), ...progress, ...acceptance];
  const text = [title, heading, next, ...(rows.length === 0 ? [] : ["", ...rows]), "", `${projectLabel(project)} · #${run.id}`].join("\n");
  const failedChecks = status.details.some(one => one.key === "checks" && (one.mark === "failed" || one.mark === "note"));
  const recovery = operatorHold !== undefined || accessBlocked || (!built && run.outcome !== null);
  return { text, next, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
    // Needs you: the button names the action that resolves it.
    link: { label: status.need != null && status.need.key !== "other" && status.need.key !== "review-result" ? status.need.action.label : built ? "Open result" : "Open task", path: recovery
      ? chatControlHref("recovery", taskId) : built ? chatResultHref(taskId, run.id, failedChecks ? "checks" : "summary") : chatControlHref("task", taskId) } };
}
