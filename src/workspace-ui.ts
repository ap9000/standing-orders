/**
 * The workspace's ONE display projection (package 1, 2026-09-13): the
 * words, tone, and next action a task or result wears on every surface —
 * Work rows, the task page's status box, the focused chat's journey card,
 * the review cockpit's chip, and the completion receipt's heading. Pure
 * functions over facts the store already records (task state, the dispatch
 * diagnosis, the machine's proof verdict and its reasons, an operator's
 * acceptance, the publication row); nothing here is a second lifecycle,
 * and nothing here reads the agent's narrative as evidence of success.
 *
 * The vocabulary is the truthful-status contract from the workspace plan:
 * a saved result with a failed check says "Changes saved, but checks
 * failed"; a missing proof says "verification needed"; agent-reported
 * checks say so; an accepted exception stays an exception; and nothing
 * local is ever called shipped or deployed — "PR opened" and "Merge
 * observed" name observed publication records, and deployment is never
 * claimed without one.
 */

import type { DispatchDiagnosis } from "./dispatch.js";
import type { ProofVerdict } from "./proof.js";
import type { TaskState } from "./store.js";

/** The Work destination's views — shortcuts over the same rows, never a
 * persisted state. All is the default. */
export type WorkView = "all" | "needs-you" | "running" | "completed";

export const WORK_VIEWS: readonly { key: WorkView; label: string; hint: string; empty: string }[] = [
  { key: "all", label: "All", hint: "Every task in view, most urgent first.", empty: "Nothing is in progress. Describe work in chat or add a task, and it appears here." },
  { key: "needs-you", label: "Needs you", hint: "Tasks waiting on a decision, an approval, a repair, or a review.", empty: "Nothing needs you right now. Queued and running work continues on its own." },
  { key: "running", label: "Running", hint: "Attempts a builder owns right now, and reviews in progress.", empty: "Nothing is building right now. Approved tasks start when a builder with capacity is connected." },
  { key: "completed", label: "Completed", hint: "Finished tasks with their evidence status — problems stay visible here.", empty: "No finished work yet. A task appears here when its build finishes, whatever its evidence says." },
];

export function parseWorkView(raw: string | null): WorkView {
  return raw === "needs-you" || raw === "running" || raw === "completed" ? raw : "all";
}

/** The finished result's recorded facts, as `taskViewData`, dispatch, and
 * the completed-work query already read them. */
export type ResultFacts = {
  runId: number | null;
  /** The result run's role — a scout delivers a report, not a diff. */
  role: string | null;
  outcome: string | null;
  verdict: ProofVerdict | null;
  reasons: readonly string[];
  accepted: boolean;
  /** A no-change conclusion's two presence facts (handoff + sealed diff);
   * undefined when the caller did not read them. */
  recordComplete?: boolean;
};

export type PublicationFacts = {
  state: string;
  prNumber: number | null;
  prUrl: string | null;
  remoteState: string | null;
  lastCheckState: string | null;
} | null;

export type StatusTone = "attention" | "problem" | "live" | "ready" | "done" | "muted" | "neutral";

export type NextAction = {
  label: string;
  /** Where the act lives — the page, not a URL, so every surface can
   * build its own link (a task page anchors, a row links out). */
  kind: "open-result" | "open-review" | "open-task" | "open-run" | "open-pr";
};

export type DisplayStatus = {
  /** The stable `data-work-status` token pages and tests key off. */
  token: string;
  /** The main wording — the same words on every surface. */
  label: string;
  /** One plain sentence: the real reason when one is recorded, never an
   * invented cause, repair, retry time, or percentage. */
  detail: string;
  tone: StatusTone;
  action: NextAction | null;
};

/** What kind of evidence problem a verdict records: a check the machine
 * actually ran and saw fail, evidence that contradicts the sealed record
 * (a mismatched changed-path claim, an altered criterion, a caveat that
 * contradicts a met verdict), or evidence that is simply absent. A generic
 * refuted verdict is NOT a failed test claim — only the verify-command
 * reasons say a check failed. */
export type EvidenceProblem = "checks-failed" | "mismatched" | "missing" | "none";

const FAILED_CHECK = /^the repository's approved verification command exited (-?[0-9]+)/;

export function evidenceProblemOf(verdict: ProofVerdict | null, reasons: readonly string[]): EvidenceProblem {
  if (verdict === "verified" || verdict === "attested") return "none";
  if (verdict === "refuted") return reasons.some(reason => FAILED_CHECK.test(reason)) ? "checks-failed" : "mismatched";
  return "missing";
}

/** The exit code of the failed check, when the recorded reason names one. */
export function failedCheckExit(reasons: readonly string[]): number | null {
  for (const reason of reasons) {
    const found = FAILED_CHECK.exec(reason);
    if (found !== null) return Number(found[1]);
  }
  return null;
}

/** The observed publication record in words. Each state is a distinct
 * fact: a pushed branch is not a PR, an open PR is not a merge, and a
 * merge is not a deployment — no record here ever says "deployed". */
export function publicationStatusOf(publication: PublicationFacts): { token: string; label: string; detail: string } | null {
  if (publication === null) return null;
  const pr = publication.prNumber === null ? "the pull request" : `PR #${publication.prNumber}`;
  const ci = publication.lastCheckState === null || publication.lastCheckState === "none" ? "" : ` CI was last seen ${publication.lastCheckState}.`;
  if (publication.remoteState === "MERGED") {
    return { token: "merge-observed", label: "Merge observed", detail: `GitHub reports ${pr} merged. Deployment is not confirmed by any record here.` };
  }
  if (publication.remoteState === "CLOSED") {
    return { token: "pr-closed", label: "PR closed without merging", detail: `GitHub reports ${pr} closed. Nothing was merged or deployed.` };
  }
  if (publication.state === "opened") {
    return { token: "pr-opened", label: "PR opened", detail: `${pr} is open on GitHub. Merging stays a person's act; nothing is merged or deployed yet.${ci}` };
  }
  if (publication.state === "pushed") {
    return { token: "branch-pushed", label: "Branch pushed", detail: "The branch reached the remote; no pull request is open yet." };
  }
  if (publication.state === "failed") {
    return { token: "publication-failed", label: "Publication failed", detail: "Standing Orders could not publish this result; the changes stay on the build branch." };
  }
  return { token: "publication-pending", label: "Publication requested", detail: "Publishing was authorized and has not completed; the changes stay on the build branch until it does." };
}

/**
 * The finished result's status — the one place the done words are chosen.
 * Precedence: no record → scout report → operator acceptance → the machine
 * verdict's problems (a refuted or short verdict is never masked by a
 * no-change outcome) → a no-change conclusion, which owes no proof beyond
 * its handoff and sealed diff → agent-attested → verified, where an
 * observed publication names itself (a published but unverified result
 * keeps its evidence problem as the main wording; the publication rides
 * the detail).
 */
export function resultStatusOf(result: ResultFacts | null, publication: PublicationFacts = null): DisplayStatus {
  if (result === null || result.runId === null) {
    return {
      token: "no-build-record",
      label: "Marked done without a build record",
      detail: "The task is done, but no finished attempt is recorded, so there is nothing to verify.",
      tone: "problem",
      action: { label: "Open the task", kind: "open-task" },
    };
  }
  if (result.role === "scout") {
    return { token: "report-ready", label: "Report ready", detail: "The research report is ready to read.", tone: "ready", action: { label: "Read the report", kind: "open-result" } };
  }
  const published = publicationStatusOf(publication);
  const withPublication = (detail: string): string => (published === null ? detail : `${detail} ${published.detail}`);
  if (result.accepted) {
    return {
      token: "accepted-exception",
      label: "Accepted with an exception",
      detail: withPublication("An approver accepted this result by hand. Its checks were not passed by the machine, and the recorded exception says why."),
      tone: "done",
      action: { label: "Review the recorded exception", kind: "open-review" },
    };
  }
  const problem = evidenceProblemOf(result.verdict, result.reasons);
  if (problem === "checks-failed") {
    const exit = failedCheckExit(result.reasons);
    return {
      token: "checks-failed",
      label: "Changes saved, but checks failed",
      detail: withPublication(`The repository's approved check failed against this build${exit === null ? "" : ` (exit ${exit})`}, so the result is not verified.`),
      tone: "problem",
      action: { label: "Review the failed check", kind: "open-review" },
    };
  }
  if (problem === "mismatched") {
    return {
      token: "evidence-mismatch",
      label: "Result saved, but its evidence does not match",
      detail: withPublication("The proof's claims disagree with the sealed record; no check is recorded as failed."),
      tone: "problem",
      action: { label: "Review the evidence", kind: "open-review" },
    };
  }
  if (result.verdict === "short") {
    return {
      token: "verification-needed",
      label: "Result saved — verification needed",
      detail: withPublication("Required evidence is missing, so this result is not verified."),
      tone: "problem",
      action: { label: "Review the missing evidence", kind: "open-review" },
    };
  }
  if (result.outcome === "no-change") {
    // A machine verdict (attested or verified) already proved the record
    // at adjudication; only a verdict-less no-change reads its two
    // presence facts here.
    return result.recordComplete === false && result.verdict === null
      ? { token: "record-incomplete", label: "No-change result, record incomplete", detail: "The build concluded nothing needed to change, but its handoff or sealed diff is missing.", tone: "problem", action: { label: "Review the record", kind: "open-run" } }
      : { token: "no-change", label: "No changes were needed", detail: withPublication("The build concluded nothing needed to change; its handoff and sealed diff are on record."), tone: "done", action: { label: "Review the result", kind: "open-result" } };
  }
  if (result.verdict === null) {
    return {
      token: "verification-needed",
      label: "Result saved — verification needed",
      detail: withPublication("No verification result is recorded for this build."),
      tone: "problem",
      action: { label: "Review the missing evidence", kind: "open-review" },
    };
  }
  if (result.verdict === "attested") {
    return {
      token: "agent-attested",
      label: "Result saved — checks reported by the agent",
      detail: withPublication("No independent project check ran; the checks listed are the agent's own report."),
      tone: "neutral",
      action: { label: "Review the result", kind: "open-result" },
    };
  }
  if (published !== null && (published.token === "merge-observed" || published.token === "pr-opened" || published.token === "pr-closed")) {
    return {
      token: published.token,
      label: published.label,
      detail: `Standing Orders independently verified this result. ${published.detail}`,
      tone: published.token === "pr-closed" ? "muted" : "done",
      action: published.token === "merge-observed" ? { label: "Review the result", kind: "open-result" } : { label: "Open the pull request", kind: "open-pr" },
    };
  }
  return {
    token: "ready-to-review",
    label: "Ready to review",
    detail: withPublication("Standing Orders independently verified this result."),
    tone: "ready",
    action: { label: "Review the result", kind: "open-result" },
  };
}

/** The completion receipt's heading: what the record actually supports.
 * Never "shipped" — local changes are saved; a PR or merge is named only
 * from its observed record. */
export function receiptHeadingOf(outcome: string | null, publication: PublicationFacts): string {
  const published = publicationStatusOf(publication);
  if (published !== null && (published.token === "merge-observed" || published.token === "pr-opened")) return published.label;
  if (outcome === "no-change") return "No changes were needed";
  return "Changes saved";
}

/** The receipt's one-line publication fact under the heading. */
export function receiptPublicationWords(publication: PublicationFacts): string {
  const published = publicationStatusOf(publication);
  return published === null ? "Saved on the build branch — not published, merged, or deployed." : published.detail;
}

/** Everything one Work row needs, gathered by the server from records it
 * already reads elsewhere. */
export type WorkFacts = {
  id: string;
  title: string;
  repo: string | null;
  state: TaskState;
  updatedAt: string;
  dispatch: DispatchDiagnosis | null;
  result: ResultFacts | null;
  publication: PublicationFacts;
  liveRunId: number | null;
};

export type WorkStatus = DisplayStatus & {
  /** Which shortcut views list this row; `all` always does. */
  views: readonly WorkView[];
  /** The rank All sorts by: what needs a person first, then live work,
   * then queued and waiting, then finished, then cancelled. */
  rank: number;
};

const REVIEW_CODES = new Set(["reviewing", "review-pending", "review-failed", "review-exhausted"]);

/** Needs you: the existing diagnosis semantics — waiting on a person with a
 * concrete act — never every queued task indiscriminately. */
export function needsPerson(dispatch: DispatchDiagnosis | null): boolean {
  if (dispatch === null || dispatch.action === null) return false;
  // A failed task is terminal for the scheduler and still a person's act
  // (retry); every other terminal answer (complete, cancelled) is not.
  return dispatch.condition === "waiting" || dispatch.code === "failed";
}

export function workStatusOf(facts: WorkFacts): WorkStatus {
  const dispatch = facts.dispatch;
  const running = facts.liveRunId !== null || dispatch?.condition === "running";
  const needs = needsPerson(dispatch);
  const views: WorkView[] = ["all"];
  if (needs) views.push("needs-you");
  if (running) views.push("running");
  if (facts.state === "done") views.push("completed");

  const dispatchWords = (tone: StatusTone, rank: number, action: NextAction | null): WorkStatus => ({
    token: dispatch?.code ?? "unknown",
    label: dispatch?.summary ?? "Status unknown",
    detail: dispatch?.detail ?? "Refresh this task before relying on its status.",
    tone,
    action,
    views,
    rank,
  });

  if (facts.state === "done") {
    // A review in flight or waiting outranks the stored verdict: the
    // machine is still deciding, and the row must say so.
    if (dispatch !== null && REVIEW_CODES.has(dispatch.code)) {
      return dispatchWords(dispatch.condition === "running" ? "live" : "attention", needs ? 0 : running ? 1 : 3, { label: "Open the result", kind: "open-result" });
    }
    const status = resultStatusOf(facts.result, facts.publication);
    return { ...status, views, rank: needs ? 0 : 3 };
  }
  if (facts.state === "cancelled") {
    return { token: "cancelled", label: "Cancelled", detail: dispatch?.detail ?? "Nothing else will run for this task.", tone: "muted", action: null, views, rank: 4 };
  }
  if (running) {
    return dispatchWords("live", 1, { label: "Watch the build", kind: facts.liveRunId === null ? "open-task" : "open-run" });
  }
  if (facts.state === "failed") {
    return dispatchWords("problem", 0, { label: "Review and retry", kind: "open-task" });
  }
  if (needs) {
    return dispatchWords("attention", 0, { label: dispatch?.action === "answer-decision" ? "Answer the question" : dispatch?.action === "approve-scope" ? "Review and approve" : "Open the next step", kind: "open-task" });
  }
  if (dispatch === null) return dispatchWords("neutral", 2, null);
  return dispatchWords(dispatch.condition === "retrying" ? "neutral" : "muted", 2, null);
}

/** The counts each view tab wears — from the same rows the page lists. */
export function workCounts(rows: readonly { views: readonly WorkView[] }[]): Record<WorkView, number> {
  const counts: Record<WorkView, number> = { all: 0, "needs-you": 0, running: 0, completed: 0 };
  for (const row of rows) for (const view of row.views) counts[view] += 1;
  return counts;
}

/** All's order: rank, then most recently updated. */
export function compareWorkRows(a: { rank: number; updatedAt: string }, b: { rank: number; updatedAt: string }): number {
  return a.rank - b.rank || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
}

/** The shell's three primary destinations, from the page's own active
 * key: every old page keeps its key and lights the destination it now
 * lives under. */
export type PrimaryDestination = "chat" | "work" | "projects" | "settings" | null;

const WORK_KEYS = new Set(["inbox", "board", "queue", "work", "done", "activity", "review", "tasks", "runs", "workbench", "routines", "recipes", "ledger"]);
const SETTINGS_KEYS = new Set(["fleet", "caps", "people", "mode", "system", "settings"]);

export function primaryDestinationOf(active: string): PrimaryDestination {
  if (active === "chat") return "chat";
  if (active === "projects") return "projects";
  if (WORK_KEYS.has(active)) return "work";
  if (SETTINGS_KEYS.has(active)) return "settings";
  return null;
}
