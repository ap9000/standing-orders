/** Presentation only. Assignment state and retry authority belong to their
 * existing projections and signed operating-mode terms, never this renderer. */
import type { AssignmentSnapshot } from './assignment.js';
import type { DisplayStatus, WorkStatus } from './workspace-ui.js';
import { assignmentPresentationOf, shortenedMaterialReason, type AssignmentWorkStatus } from './assignment-presentation.js';

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The existing verified receipt reader may discover damage after a verdict
 * was saved. Keep the limitation visible without inventing another work stage. */
export function assignmentWithEvidence(assignment: AssignmentSnapshot, resultStatus: DisplayStatus | null, resultRunId: number | null = assignment.receipt?.runId ?? null): AssignmentSnapshot {
  if (resultStatus?.token !== 'evidence-damaged') return assignment;
  return { ...assignment,
    attempts: assignment.attempts.map(attempt => attempt.taskId === assignment.activeTaskId && resultRunId !== null && attempt.runId === resultRunId ? { ...attempt, detail: resultStatus.detail } : attempt),
    attention: [...new Set([...assignment.attention, resultStatus.detail])],
  };
}

export function assignmentStatusOf(assignment: AssignmentSnapshot, workStatus?: AssignmentWorkStatus): WorkStatus {
  return assignmentPresentationOf(assignment, workStatus === undefined ? {} : { workStatus }).status;
}

const taskHref = (assignment: AssignmentSnapshot, taskId: string): string => `/t/${encodeURIComponent(assignment.rootId)}?version=${encodeURIComponent(taskId)}`;

/** Navigation only. A control action still opens its existing exact ceremony. */
export function assignmentActionHref(assignment: AssignmentSnapshot): string | null {
  const action = assignment.primaryAction;
  if (action === null) return null;
  const { taskId, runId, decisionId } = action.target;
  if (decisionId !== null) return `/d/${decisionId}`;
  if (action.code === 'inspect-decisions') return '/';
  if (action.code === 'open-pr' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(assignment.publication?.prUrl ?? '')) return assignment.publication!.prUrl;
  if (runId !== null && (action.code === 'open-result' || action.code === 'open-pr' || action.code === 'retry-review')) {
    return `/review?result=${encodeURIComponent(taskId)}&run=${runId}${assignment.repo === null ? '' : '&project=' + encodeURIComponent(assignment.repo)}`;
  }
  if (runId !== null && (action.code === 'inspect-run' || action.code === 'reconcile-run')) return `/r/${runId}`;
  const anchor = action.code === 'approve-scope' ? '#approve'
    : action.code === 'inspect-stop' || action.code === 'resume-run' ? '#task-control'
    : action.code === 'unhold' || action.code === 'retry-task' ? '#task-actions'
    : action.code === 'write-scope' || action.code === 'select-agent' ? '#scope'
    : action.code === 'inspect-hold' ? '#holds'
    : action.code === 'start-worker' || action.code === 'repair-dependency' ? '#run-status' : '';
  return taskHref(assignment, taskId) + anchor;
}

export function assignmentAttemptsHtml(assignment: AssignmentSnapshot): string {
  if (assignment.attempts.length === 0) return '';
  return `<details class="assignment-attempts"><summary>Attempts <span class="meta">${assignment.attempts.length}</span></summary><ol>` + assignment.attempts.map((attempt, index) =>
    `<li data-attempt-task="${escape(attempt.taskId)}" data-history-version="${escape(attempt.taskId)}"><a href="${escape(taskHref(assignment, attempt.taskId))}">${index === 0 ? 'Original' : `Correction ${index}`} · ${escape(attempt.label)}</a>${attempt.runId === null ? '' : ` <a href="/r/${attempt.runId}">Run #${attempt.runId}</a>`}${(assignment.state === 'checking' && attempt.taskId === assignment.activeTaskId) || attempt.detail === assignment.detail ? '' : `<p class="meta">${escape(attempt.detail)}</p>`}</li>`
  ).join('') + `</ol>${assignment.owner === null ? '' : `<p class="meta">Lead: ${escape(assignment.owner.label)}${assignment.owner.active ? '' : ' · access ended'}</p>`}<p class="work-meta work-id">Task <span class="mono">${escape(assignment.rootId)}</span></p></details>`;
}

/** Only recognized storage limits and explicitly identified older records are
 * secondary. Unknown findings and damaged current material stay in view. */
function savedMaterialNotice(detail: string, assignment: AssignmentSnapshot): 'partial' | 'history' | null {
  if (shortenedMaterialReason(detail)) return 'partial';
  const earlier = /^Saved [\w-]+ #(\d+) \(run (\d+)\) is unavailable or changed\.$/.exec(detail);
  return earlier !== null && assignment.receipt !== null && Number(earlier[2]) < assignment.receipt.runId &&
    !assignment.receipt.artifacts.some(one => one.id === Number(earlier[1])) ? 'history' : null;
}

export function assignmentSummaryHtml(assignment: AssignmentSnapshot, options: { compact?: boolean; hideAction?: boolean; problem?: boolean; diagnostics?: WorkStatus['diagnostics']; workStatus?: AssignmentWorkStatus; resultHref?: string } = {}): string {
  const presentation = assignmentPresentationOf(assignment, options);
  const { status, diagnostics } = presentation;
  const href = assignment.primaryAction?.code === 'open-result' && options.resultHref !== undefined ? options.resultHref : assignmentActionHref(assignment);
  const attention = presentation.attention.map(one => one.detail);
  const notices = [...attention, ...diagnostics.map(one => one.detail)].filter(one => savedMaterialNotice(one, assignment) !== null);
  const partial = notices.some(one => savedMaterialNotice(one, assignment) === 'partial');
  const history = notices.some(one => savedMaterialNotice(one, assignment) === 'history');
  const noticeSummary = [partial ? 'Saved output is partial' : '', history ? 'Earlier material unavailable' : ''].filter(Boolean).join(' · ');
  const ready = assignment.state === "ready-to-check" || assignment.state === "complete";
  const checkProblem = ready && assignment.receipt !== null && assignment.receipt.completionKind !== 'research-report' && assignment.receipt.checks.status !== 'passed';
  return `<section class="${options.compact ? 'assignment-summary' : 'card assignment-summary'}" aria-label="assignment progress" data-assignment="${escape(assignment.rootId)}" data-work-status="${status.token}" data-tone="${status.tone}"${options.compact ? '' : ' data-task-status'}>` +
    (options.compact ? `<span class="status-line" data-work-status="${status.token}" data-tone="${status.tone}"><i class="status-dot" aria-hidden="true"></i><span class="status-label">${status.label}</span></span>` : `<h2 class="assignment-state">${status.label}</h2>`) +
    (options.hideAction || href === null ? '' : `<a class="${options.compact ? 'work-action' : 'button-link'}" href="${escape(href)}"${options.resultHref === undefined ? '' : ' data-open-result'}${options.compact ? '' : ' data-primary-action'}>${escape(assignment.primaryAction!.label)}${options.compact ? ' →' : ''}</a>`) +
    (!options.compact && ready && !checkProblem && assignment.receipt !== null && assignment.receipt.checks.status === 'passed'
      // A good outcome at a glance; the same words stay in the result.
      ? `<p class="meta assignment-detail assignment-verdict"><span class="verdict-chip verdict-chip--success">Checks passed</span>${assignment.completion === null ? '' : ` Completed by ${escape(assignment.completion.actor.replace(/^(?:operator|coordinator|lead):/, ''))}`}</p>`
      : `<p class="${checkProblem || options.problem && !ready ? 'problem' : 'meta'} assignment-detail">${escape(assignment.detail)}</p>`) +
    attention.filter(one => savedMaterialNotice(one, assignment) === null).map(one => `<p class="problem">${escape(one)}</p>`).join('') +
    diagnostics.filter(one => savedMaterialNotice(one.detail, assignment) === null).map(one => `<p class="${one.tone === 'problem' || one.tone === 'attention' ? 'problem' : 'meta'}" data-work-diagnostic="${escape(one.token)}">${escape(one.label)} · ${escape(one.detail)}</p>`).join('') +
    (notices.length === 0 ? '' : `<details class="assignment-notices"><summary>${noticeSummary}</summary>${[...new Set(notices)].map(one => `<p class="meta">${escape(one)}</p>`).join('')}</details>`) +
    assignmentAttemptsHtml(assignment) + `</section>`;
}

/** Shared assignment layout; actions remain comfortable on touch screens. */
export const ASSIGNMENT_CSS = `.assignment-summary{min-width:0;overflow-wrap:anywhere}.assignment-summary .assignment-state{font-weight:600;margin:0}.assignment-summary h2.assignment-state{font-size:1.125rem;color:var(--foreground)}.assignment-summary>.assignment-attempts,.assignment-summary>.assignment-notices{border:0;box-shadow:none;padding:0;margin:.25rem 0 0;background:transparent}.assignment-summary>.button-link{margin-top:.7rem;min-height:44px}.assignment-summary>.work-action{display:inline-flex;margin-inline-start:.6rem;min-height:44px;align-items:center}.assignment-detail{margin:.55rem 0}.assignment-attempts summary,.assignment-notices summary{min-height:44px;display:list-item;align-content:center;cursor:pointer}.assignment-notices summary{font-size:.8125rem;color:var(--foreground)}.assignment-notices p{margin:.25rem 0 .5rem}.assignment-attempts ol{padding-left:1.4rem}.assignment-attempts li{margin:.4rem 0}.assignment-attempts li a{display:inline-flex;align-items:center;min-height:44px;margin-right:.7rem}.assignment-attempts li p{margin:0 0 .4rem}`;
