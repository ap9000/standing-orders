/** Current assignment presentation shared by summaries and result views.
 * Saved assessments remain history; this projection never changes receipts,
 * checks, approvals, ownership, or the exact completion identity. */
import type { AssignmentSnapshot } from './assignment.js';
import { GOAL_ASSESSMENT_PENDING, manualReviewCriterionOf } from './proof.js';
import { failedCheckExit, type DisplayStatus, type WorkStatus } from './workspace-ui.js';
import { assignmentStatusFacts, taskStatusOf, workToneOf, type PullRequestFact, type StatusAction, type TaskStatus, type TaskStatusFacts } from './task-status.js';

export type AssignmentWorkStatus = DisplayStatus & Partial<Pick<WorkStatus, 'views' | 'rank'>>;
export type AssignmentAttention = { id: string; detail: string; tone: 'problem' | 'attention' };

/** Only the retired assessment requirement is history-only. Specific missing
 * material, defects and failed checks remain visible, including reviewer findings. */
export function historicalAssessmentReason(reason: string): boolean {
  return reason === GOAL_ASSESSMENT_PENDING || reason === 'no proof was written' || reason === 'No builder proof artifact is recorded.' || /^criterion "[^"]+" awaits independent goal assessment\.?$/.test(reason) ||
    /^semantic coverage: .* — (?:required .*|independent review is optional .*)$/.test(reason);
}

/** Known storage-cap notices do not mean the retained bytes are damaged. */
export function shortenedMaterialReason(detail: string): boolean {
  return detail === 'The check output was shortened when it was stored; its download holds only the stored part.' ||
    detail === 'The sealed diff was shortened when it was stored; its download holds only the stored part, not the full change.' ||
    detail === 'The report was shortened when it was stored; its download holds only the stored part.' ||
    detail === 'The check log was shortened when stored; only the retained output is available.' ||
    detail === 'The changed-file list was cut short; the counts are complete.' ||
    /^Saved (?:terminal-diff|report) #\d+ is incomplete\.$/.test(detail);
}

export type AssignmentStatusOptions = {
  workStatus?: AssignmentWorkStatus; diagnostics?: WorkStatus['diagnostics']; additionalAttention?: readonly string[];
  /** A live planner rather than a builder holds the work. */
  planning?: boolean;
  pullRequest?: PullRequestFact | null; action?: StatusAction | null; links?: TaskStatusFacts['links']; evidence?: TaskStatusFacts['evidence'];
};

/** The one shared status (task-status.ts) for this assignment. */
export function assignmentTaskStatusOf(assignment: AssignmentSnapshot, options: AssignmentStatusOptions = {}): TaskStatus {
  const work = options.workStatus;
  return taskStatusOf(assignmentStatusFacts(assignment, {
    work: work === undefined ? null : { token: work.token, ...(work.views === undefined ? {} : { views: work.views }), detail: work.detail },
    ...(options.planning === undefined ? {} : { planning: options.planning }),
    ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }),
    ...(options.action === undefined ? {} : { action: options.action }),
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  }));
}

export function assignmentPresentationOf(assignment: AssignmentSnapshot, options: AssignmentStatusOptions = {}) {
  const { state } = assignment, work = options.workStatus;
  const taskStatus = assignmentTaskStatusOf(assignment, options);
  // The headline and its sentence are the shared words; the token, views and
  // rank stay the existing projection's (pages and tests key off them).
  const shared = { label: taskStatus.headline, tone: workToneOf(taskStatus.headline), detail: taskStatus.sentence, action: null };
  const needsYou = taskStatus.headline === 'Needs you';
  const status: WorkStatus = state === 'working'
    ? { ...shared, token: `assignment-${state}`,
      views: [...new Set([...(work?.views?.filter(view => view !== 'completed') ?? ['all' as const]), ...(needsYou ? ['needs-you' as const] : [])])], rank: needsYou ? 0 : work?.rank ?? 2 }
    : { ...shared, token: `assignment-${state}`,
      views: state === 'ready-to-check' || state === 'needs-decision' ? ['all', 'needs-you'] : state === 'complete' ? ['all', 'completed']
        : state === 'checking' && work?.views?.includes('running') ? ['all', 'running'] : ['all'],
      rank: state === 'needs-decision' || state === 'ready-to-check' ? 0 : state === 'checking' ? 1 : state === 'complete' ? 3 : 4 };
  const ready = state === 'ready-to-check' || state === 'complete';
  const checks = assignment.receipt?.checks;
  const checkReason = (detail: string) => detail === checks?.detail || /^Checks (?:failed|passed|did not finish)/.test(detail) ||
    failedCheckExit([detail]) !== null;
  const materialReason = (detail: string): string | null => {
    const saved = /^Saved (check-log|terminal-diff|report) #(\d+)/.exec(detail);
    if (saved) {
      const current = assignment.receipt?.artifacts.filter(one => one.kind === saved[1]) ?? [];
      // An older attempt's missing file is a distinct limitation. Only the
      // one exact current file can share its detailed reader's explanation.
      return current.length === 1 && current[0]!.id === Number(saved[2]) ? saved[1] === 'terminal-diff' ? 'diff' : saved[1]! : `artifact:${saved[2]}`;
    }
    if (/^The (?:retained verification log|check log|check output) /.test(detail)) return 'check-log';
    if (/^The sealed diff /.test(detail)) return 'diff';
    if (/^The report (?:was |is |cannot |no longer )/.test(detail)) return 'report';
    return null;
  };
  const attention = new Map<string, AssignmentAttention>();
  for (const detail of [...assignment.attention, ...(options.additionalAttention ?? [])]) {
    // A requirement only a person can confirm is not a problem: the result
    // names it in plain words beside its Accept action.
    if (historicalAssessmentReason(detail) || detail === assignment.detail || manualReviewCriterionOf(detail) !== null) continue;
    const material = materialReason(detail);
    const id = checks !== undefined && checkReason(detail) ? 'checks' : material === null ? `detail:${detail}` : `material:${material}`;
    // A read of the exact machine record owns the check outcome. A legacy
    // assessment cannot claim failure after the actual check passed.
    if (id === 'checks' && (checks?.status === 'passed' || assignment.detail.includes(checks!.detail))) continue;
    if ([...attention.values()].some(one => one.detail.includes(detail))) continue;
    const previous = attention.get(id);
    // Damage to the retained bytes outranks their earlier storage limit.
    if (previous !== undefined && shortenedMaterialReason(detail) && !shortenedMaterialReason(previous.detail)) continue;
    attention.set(id, { id, detail: id === 'checks' ? checks!.detail : detail, tone: 'problem' });
  }
  const diagnostics = (options.diagnostics ?? []).filter(one => {
    if (historicalAssessmentReason(one.detail) || one.detail === assignment.detail || attention.has(`detail:${one.detail}`)) return false;
    if (ready && (one.token === 'verification-needed' || one.token.startsWith('review-'))) return false;
    if (checks !== undefined && (one.token === 'checks-failed' || checkReason(one.detail))) return false;
    return true;
  });
  return { status, taskStatus, primaryAction: assignment.primaryAction, attention: [...attention.values()], diagnostics };
}
