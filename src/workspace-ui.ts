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

import type { DispatchAction, DispatchDiagnosis } from "./dispatch.js";
import { manualReviewOnly, type ProofVerdict } from "./proof.js";
import type { ReviewRetryState, TaskState } from "./store.js";
import type { TaskControlView } from "./task-control.js";

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
  /** This exact run's independent review (v50 retry projection), read
   * per run so an older selected result keeps its own words; undefined
   * when the caller did not read it, null when never requested. */
  review?: ReviewFacts | null;
};

/** The result's review facts as `reviewRetryStateOf` records them, plus
 * the one liveness fact the words depend on. */
export type ReviewFacts = {
  state: ReviewRetryState["state"];
  /** The attempt in play: the next ordinal while queued, else the live or
   * latest attempt's. */
  attempt: number | null;
  cap: number;
  attempts: number;
  retriesRemaining: number;
  latestReason: string | null;
  interrupted: boolean;
  /** Who asked for the open (queued) request, when one is open. */
  queuedBy: string | null;
  /** Whether the live attempt's reviewer worker is answering. */
  reviewerAlive: boolean;
};

/** The review facts from the store's bounded retry projection — the same
 * reading `diagnoseTaskDispatch` makes, so every surface starts from one
 * record. `reviewerAlive` answers for the live attempt's runner. */
export function reviewFactsOf(retry: ReviewRetryState | null, reviewerAlive: (runner: string) => boolean): ReviewFacts | null {
  if (retry === null || retry.state === "unrequested") return null;
  const current = retry.live ?? (retry.state === "queued" ? null : retry.latest);
  return {
    state: retry.state,
    attempt: retry.state === "queued" ? retry.nextAttempt : current?.attempt ?? null,
    cap: retry.cap,
    attempts: retry.attempts.length,
    retriesRemaining: retry.retriesRemaining,
    latestReason: retry.latest?.reason ?? null,
    interrupted: retry.latest !== null && (retry.latest.outcome === "interrupted" || retry.latest.reason === "interrupted"),
    queuedBy: retry.openRequest?.requestedBy ?? null,
    reviewerAlive: retry.live !== null && reviewerAlive(retry.live.runner),
  };
}

/** The tokens a review in flight wears — the dispatch codes, unchanged. */
export const REVIEW_TOKENS: ReadonlySet<string> = new Set(["reviewing", "review-pending", "review-failed", "review-exhausted"]);

const retriesLeft = (count: number): string => (count === 1 ? "1 explicit retry" : `${count} explicit retries`);

/**
 * A review that is queued, running, failed with a retry left, or
 * exhausted is the result's PRIMARY status — the machine is still
 * deciding, and every surface must say so with the same words. A review
 * never requested, or one that succeeded, adds nothing: the stored verdict
 * (folded by the review where one landed) speaks. Words and tokens are
 * the v50 dispatch contract; nothing here changes the lifecycle.
 */
export function reviewStatusOf(review: ReviewFacts | null): DisplayStatus | null {
  if (review === null || review.state === "unrequested" || review.state === "succeeded") return null;
  const ordinal = `attempt ${review.attempt ?? review.attempts} of ${review.cap}`;
  const open: NextAction = { label: "Open the result", kind: "open-result" };
  if (review.state === "running") {
    return review.reviewerAlive
      ? { token: "reviewing", label: review.attempt === 1 ? "Reviewing" : `Reviewing (retry ${(review.attempt ?? 1) - 1} of ${review.cap - 1})`, detail: `The build is preserved while an independent reviewer checks its sealed evidence (${ordinal}).`, tone: "live", action: open }
      : { token: "review-failed", label: "Review interrupted", detail: `The reviewer has no live worker; recovery must settle the interrupted attempt (${ordinal}) before it can be retried.`, tone: "attention", action: open };
  }
  if (review.state === "queued") {
    return review.attempt === 1
      ? { token: "review-pending", label: "Waiting for review", detail: "The build finished and its requested independent review is waiting for a worker.", tone: "attention", action: open }
      : { token: "review-pending", label: `Review retry queued (${ordinal})`, detail: `The explicit review retry${review.queuedBy === null ? "" : `, asked by ${review.queuedBy},`} is waiting for a worker; ${retriesLeft(review.retriesRemaining)} would remain after it.`, tone: "attention", action: open };
  }
  if (review.state === "retryable") {
    const what = review.interrupted ? "was interrupted" : "failed";
    return {
      token: "review-failed",
      label: review.interrupted ? "Review interrupted — retry available" : "Review failed — retry available",
      detail: `Review ${ordinal} ${what}${review.latestReason === null ? "" : ` (${review.latestReason})`}. The build is preserved; ask for an explicit retry — ${retriesLeft(review.retriesRemaining)} left.`,
      tone: "attention",
      action: { label: "Retry the review", kind: "open-review" },
    };
  }
  return {
    token: "review-exhausted",
    label: "Review retries exhausted",
    detail: `All ${review.cap} review attempts ended without a review${review.latestReason === null ? "" : ` (latest: ${review.latestReason})`}. Nothing retries a fourth time; open the result to accept it with an exception or file a revision.`,
    tone: "attention",
    action: open,
  };
}

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
 * merge is not a deployment — no record here ever says "deployed". The
 * words name what was recorded or last observed and what stays
 * unconfirmed; a missing or stale observation never proves that nothing
 * merged or deployed, and merging is never called manual-only — an
 * authorized mode may merge on green. */
export function publicationStatusOf(publication: PublicationFacts): { token: string; label: string; detail: string } | null {
  if (publication === null) return null;
  const pr = publication.prNumber === null ? "the pull request" : `PR #${publication.prNumber}`;
  const ci = publication.lastCheckState === null || publication.lastCheckState === "none" ? "" : ` CI was last seen ${publication.lastCheckState}.`;
  if (publication.remoteState === "MERGED") {
    return { token: "merge-observed", label: "Merge observed", detail: `GitHub reports ${pr} merged. Deployment is not confirmed by any record here.` };
  }
  if (publication.remoteState === "CLOSED") {
    return { token: "pr-closed", label: "PR closed without merging", detail: `GitHub last reported ${pr} closed without a merge. No merge or deployment is recorded here.` };
  }
  if (publication.state === "opened") {
    return { token: "pr-opened", label: "PR opened", detail: `${pr} was last seen open on GitHub. No merge or deployment is recorded here.${ci}` };
  }
  if (publication.state === "pushed") {
    return { token: "branch-pushed", label: "Branch pushed", detail: "The branch reached the remote; no pull request is recorded yet." };
  }
  if (publication.state === "failed") {
    return { token: "publication-failed", label: "Publication failed", detail: "The last publication attempt failed; no pull request or merge is recorded here." };
  }
  return { token: "publication-pending", label: "Publication requested", detail: "Publishing was authorized and has not completed; no pull request or merge is recorded yet." };
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
  const stored = storedResultStatusOf(result, publication);
  // A review in flight (queued, running, failed with a retry, exhausted)
  // leads on every surface; an operator's acceptance closes the matter,
  // and a scout's report is never reviewed. The earlier verdict stays in
  // the detail as history, never as the main wording.
  if (result === null || result.runId === null || result.role === "scout" || result.accepted) return stored;
  const review = reviewStatusOf(result.review ?? null);
  if (review === null) return stored;
  return { ...review, detail: `${review.detail} ${priorVerdictWords(stored)}` };
}

/** The earlier verdict as history under a review in flight. */
function priorVerdictWords(stored: DisplayStatus): string {
  return `Until the review settles, the earlier verdict — "${stored.label}" — stays on record as history.`;
}

/** What the machine itself recorded about a result, in a clause. */
function machineVerdictWords(result: ResultFacts): string {
  if (result.verdict === "verified") return "it verified the result before the acceptance";
  if (result.verdict === "attested") return "the checks on record are the agent's own report";
  const problem = evidenceProblemOf(result.verdict, result.reasons);
  if (problem === "checks-failed") {
    const exit = failedCheckExit(result.reasons);
    return `the approved check failed against it${exit === null ? "" : ` (exit ${exit})`}`;
  }
  if (problem === "mismatched") return "its evidence did not match the sealed record";
  return "its required evidence was missing";
}

function storedResultStatusOf(result: ResultFacts | null, publication: PublicationFacts): DisplayStatus {
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
  const humanReview = manualReviewOnly({ verdict: result.verdict ?? "", reasons: result.reasons });
  if (result.accepted && humanReview) {
    return { token: "accepted-exception", label: "Accepted after human review", detail: withPublication("Human acceptance is recorded for this result. The machine verdict remains unchanged."), tone: "done", action: { label: "Review acceptance", kind: "open-review" } };
  }
  if (result.accepted) {
    return {
      token: "accepted-exception",
      label: "Accepted with an exception",
      // Acceptance records a person's decision; it neither proves nor
      // disproves anything about the checks. The machine's own verdict is
      // restated as recorded.
      detail: withPublication(`An approver accepted this result by hand, and the recorded exception says why. The machine's verdict is unchanged: ${machineVerdictWords(result)}.`),
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
      // A structural refutation is settled before the approved check is
      // weighed, so it says nothing about whether that check passed.
      detail: withPublication("The proof's claims disagree with the sealed record. Whether the approved check passed is not settled by this verdict."),
      tone: "problem",
      action: { label: "Review the evidence", kind: "open-review" },
    };
  }
  if (result.verdict === "short" && humanReview) {
    return { token: "verification-needed", label: "Ready for your review", detail: withPublication("The remaining requirements need human review. Inspect the evidence and record your decision."), tone: "attention", action: { label: "Review for acceptance", kind: "open-review" } };
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
export function receiptHeadingOf(outcome: string | null, publication: PublicationFacts, role?: string | null): string {
  const published = publicationStatusOf(publication);
  if (published !== null && (published.token === "merge-observed" || published.token === "pr-opened")) return published.label;
  if (role === "scout" && (outcome === "built" || outcome === "no-change")) return "Report saved";
  if (outcome === "no-change") return "No changes were needed";
  return "Changes saved";
}

/** The receipt's one-line publication fact under the heading. */
export function receiptPublicationWords(publication: PublicationFacts): string {
  const published = publicationStatusOf(publication);
  return published === null ? "Saved on the build branch. No publication, merge, or deployment is recorded here." : published.detail;
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
  control?: TaskControlView;
};

export type WorkStatus = DisplayStatus & {
  /** Which shortcut views list this row; `all` always does. */
  views: readonly WorkView[];
  /** The rank All sorts by: what needs a person first, then live work,
   * then queued and waiting, then finished, then cancelled. */
  rank: number;
};

/** Needs you: the existing diagnosis semantics — waiting on a person with a
 * concrete act — never every queued task indiscriminately. */
export function needsPerson(dispatch: DispatchDiagnosis | null): boolean {
  if (dispatch === null || dispatch.action === null) return false;
  // A failed task is terminal for the scheduler and still a person's act
  // (retry); every other terminal answer (complete, cancelled) is not.
  return dispatch.condition === "waiting" || dispatch.code === "failed";
}

/** Navigation labels describe the available help, not a mutation: opening
 * a hold or pause must never promise that the task has already resumed. */
const DISPATCH_ACTION_LABELS: Record<DispatchAction, string> = {
  "open-result": "Review the result",
  "retry-task": "Review and retry",
  "place-task": "Choose a project",
  "write-scope": "Define the task",
  "select-agent": "Choose an agent",
  "approve-scope": "Review plan",
  "answer-decision": "Answer the question",
  unhold: "Review hold",
  "inspect-hold": "Review hold",
  "repair-dependency": "Review required task",
  "repair-capability": "Review missing requirement",
  "start-worker": "Check connection",
  "retry-review": "Review retry options",
  "resume-run": "Review pause",
};

export function dispatchActionLabel(dispatch: DispatchDiagnosis | null): string {
  return dispatch?.action == null ? "View task details" : DISPATCH_ACTION_LABELS[dispatch.action];
}

export function workStatusOf(facts: WorkFacts, resultDisplay?: DisplayStatus): WorkStatus {
  const dispatch = facts.dispatch;
  const result = facts.state === "done" ? resultDisplay ?? resultStatusOf(facts.result, facts.publication) : null;
  const running = facts.liveRunId !== null || dispatch?.condition === "running" || result?.token === "reviewing";
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

  // The control projection knows whether a stop has actually settled.
  // A still-live claim alone cannot distinguish Running from Stopping.
  if (facts.control?.kind === "stopping") {
    return { token: "stopping", label: "Stopping…", detail: facts.control.detail ?? "The attempt is ending. Its work is preserved; resume becomes available after its processes exit.", tone: "attention", action: { label: "View stop details", kind: "open-task" }, views, rank: 0 };
  }
  if (facts.control?.kind === "paused") {
    return { token: "stopped", label: "Paused", detail: "The stopped attempt's work is preserved. Resuming requires confirmation and checks the current approval again.", tone: "attention", action: { label: "Review pause", kind: "open-task" }, views, rank: 0 };
  }

  if (facts.state === "done" && result !== null) {
    // A review in flight or waiting outranks the stored verdict: the
    // machine is still deciding, and the row says so in the projection's
    // own words. A caller that never read the review facts still gets
    // the dispatch diagnosis's words for the same codes.
    if (REVIEW_TOKENS.has(result.token)) return { ...result, views, rank: needs ? 0 : running ? 1 : 3 };
    if (facts.result?.review === undefined && dispatch !== null && REVIEW_TOKENS.has(dispatch.code)) {
      return dispatchWords(dispatch.condition === "running" ? "live" : "attention", needs ? 0 : running ? 1 : 3, { label: "Open the result", kind: "open-result" });
    }
    return { ...result, views, rank: needs ? 0 : 3 };
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
    return dispatchWords("attention", 0, { label: dispatchActionLabel(dispatch), kind: "open-task" });
  }
  const details: NextAction = { label: "View task details", kind: "open-task" };
  if (dispatch === null) return dispatchWords("neutral", 2, details);
  return dispatchWords(dispatch.condition === "retrying" ? "neutral" : "muted", 2, details);
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

/** Learning stays in Settings and a useful, closed result disclosure. */
export function learningHtml(view: import('./project-learning.js').LearningView, csrf: string, canManage: boolean, source?: number): string {
  const e = (x: unknown) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const fields = (values: Record<string, unknown>) => Object.entries(values).map(([k,v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('');
  const base = { csrf, repo: view.repo, identity: view.identity, revision: view.revision };
  const act = (action: string, label: string, lesson?: import('./project-learning.js').Lesson) => canManage && csrf ? `<form method="post" action="/settings/learning/change">${fields({ ...base, action, ...(lesson ? { lesson: lesson.id, version: lesson.version, sha: lesson.sha } : {}) })}<button type="submit">${label}</button></form>` : '';
  const evidence = (list: import('./project-learning.js').LearningEvidence[], run: number | null) => list.map(one => `<li><a href="/r/${one.runId ?? run}/evidence/${one.artifactId}">Source #${one.artifactId}</a><blockquote>${e(one.excerpt)}</blockquote><code>${e(one.sha256)}</code></li>`).join('');
  const lessons = view.lessons.filter(l => source === undefined || l.source === source);
  const cards = lessons.map(l => `<article class="card" data-lesson="${l.id}"><p><strong>${e(l.payload.observation)}</strong></p><p>${e(l.payload.action)}</p><p class="meta">${l.payload.kind === 'system' ? 'System suggestion · No change applied' : e(l.status === 'adopted' ? 'Adopted advice' : l.status === 'disabled' ? 'Disabled' : 'Proposed lesson')}</p><details><summary>Source and use</summary><p><a href="/r/${l.source}">Result #${l.source}</a> · <a href="/r/${l.reviewer}">Review #${l.reviewer}</a></p><p>${e(l.payload.paths.join(', '))} · ${e(l.payload.phases.join(', '))} · ${e(({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string,string>)[l.payload.platform] ?? l.payload.platform)}</p><ul>${evidence(l.payload.evidence, l.source)}</ul>${l.payload.kind !== 'project' ? '' : `<p class="meta">${l.status === 'proposed' ? 'Save permits advisory reuse when enabled and applicable. It does not prove a remedy works.' : 'Disabling affects future runs. Active snapshots, code and approvals stay unchanged.'}</p>${l.status === 'proposed' ? act('adopt', 'Save lesson', l) : ''}`}</details>${l.payload.kind === 'project' && l.status === 'adopted' ? act('disable', 'Disable lesson', l) : ''}</article>`).join('');
  if (source !== undefined) return lessons.length ? `<details class="learning result-learning"><summary>Learned from this task</summary>${cards}<a href="/settings/learning?repo=${encodeURIComponent(view.repo)}">Learning settings</a></details>` : '';
  const history = view.events.map(ev => `<article class="card" data-learning-event="${e(ev.action)}"><p><strong>${e(({ assessment: ({ propose: 'Learning suggested', none: 'No lesson needed', unassessed: 'Learning not assessed', invalid: 'Learning assessment invalid' } as Record<string,string>)[ev.after] ?? 'Learning not assessed', proposal: 'Suggestion recorded', adopt: 'Lesson adopted', disable: 'Lesson disabled', reset: 'Learning reset', enable: 'Reuse enabled', pause: 'Reuse paused', reuse: 'Run context saved', failure: 'Learning issue', capture: 'Capture finished' } as Record<string,string>)[ev.action] ?? ev.action)}</strong>${ev.action === "reuse" ? ` · ${e(ev.after)}` : ""}</p><p class="meta"><time datetime="${e(ev.at)}">${e(ev.at.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</time> · ${e(ev.actor)}${ev.run === null ? '' : ` · <a href="/r/${ev.run}">Run #${ev.run}</a>${ev.outcome === null ? "" : ` · ${e(ev.outcome)}`}`}</p><details><summary>Details</summary><p>${e(ev.before)} → ${e(ev.after)}</p><p>${e(ev.reason)}</p>${ev.lesson === null ? '' : `<p>Lesson #${ev.lesson}</p>`}<ul>${evidence(ev.evidence, ev.run)}</ul>${ev.snapshot === null ? "" : `<details><summary>Exact context</summary><pre>${e(ev.snapshot)}</pre></details>`}</details></article>`).join('');
  return `<section class="learning">${view.damaged ? '<p class="problem" role="alert">Some lessons no longer verify and are excluded from reuse.</p>' : ''}<p>${view.enabled ? 'Use adopted lessons: on' : 'Use adopted lessons: off'}</p>${act(view.enabled ? 'pause' : 'enable', view.enabled ? 'Pause reuse' : 'Enable reuse')}${cards || '<p>No lessons yet. Reviews may suggest useful advice here.</p>'}<details><summary>Reset learning</summary><p>Disable all adopted lessons and future reuse. Keep history, code, approvals and active run snapshots.</p>${act('reset', 'Reset learning')}</details><h2>Changes</h2>${history || '<p>No learning changes yet.</p>'}${view.next === null ? '' : `<a class="button-link" href="/settings/learning?repo=${encodeURIComponent(view.repo)}&before=${view.next}">Older changes</a>`}</section>`;
}
