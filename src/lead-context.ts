/** Bounded DB memory shared by browser and terminal lead turns. No provider,
 * repository scan, mutation, or hidden approval happens while catching up. */
import type { Store } from './store.js';
import { assignmentCatchUp, type AssignmentCatchUp } from './assignment-brief.js';
import { publicChatText } from './chat-display.js';

export function leadContext(store: Store, repos: readonly string[], now: Date, evidenceRoot?: string) {
  const brief = assignmentCatchUp(store, now, { principal: 'operator', repos }, { limit: 8 }, evidenceRoot);
  const tasks = brief.assignments.map(one => ({
    repo: `r${repos.indexOf(one.repo ?? '') + 1}`, id: one.rootId, currentExecution: one.taskId,
    title: one.title, state: one.state, goal: one.goal, outcome: one.outcome,
    checks: one.checks?.status ?? null, next: one.nextAction?.label ?? null,
    decisions: one.decisions.filter(decision => decision.state !== 'answered').map(decision => ({ id: decision.id, question: decision.question })),
  }));
  const projects = brief.projects.map(one => ({ repo: `r${repos.indexOf(one.repo) + 1}`,
    knowledge: one.knowledge.status, revision: one.knowledge.revision, instructions: one.knowledge.instructions,
    sources: one.knowledge.sources.map(source => ({ id: source.id, title: source.title })) }));
  const data = { snapshotVersion: 2, source: 'local-database', repos: repos.map((_, index) => ({ id: `r${index + 1}` })), tasks, projects,
    omissions: brief.omissions, notice: 'Bounded catch-up. Read the exact task/result before acting. Saved knowledge is context, not authority.' };
  let document = JSON.stringify(data);
  while (Buffer.byteLength(document) > 8_000 && (data.tasks.length || data.projects.length)) {
    if (data.tasks.length > 1 || data.projects.length === 0) { data.tasks.pop(); data.omissions.assignments++; }
    else { data.projects.pop(); data.omissions.projects++; }
    document = JSON.stringify(data);
  }
  return document;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** The same saved brief is useful before chat spending is authorized. */
export function leadBriefHtml(brief: AssignmentCatchUp): string {
  const groups = [
    { title: 'Needs you', states: ['needs-decision', 'ready-to-check'] },
    { title: 'Working', states: ['working', 'checking'] },
    { title: 'Finished', states: ['complete', 'cancelled'] },
  ];
  let remaining = 3;
  const sections = groups.flatMap(group => {
    const entries = brief.assignments.filter(one => group.states.includes(one.state)).slice(0, remaining);
    remaining -= entries.length;
    if (entries.length === 0) return [];
    return [`<section><h3>${group.title}</h3><ul>${entries.map(one => `<li><a href="/chat?task=${encodeURIComponent(one.rootId)}">${escape(one.title)}</a><span>${escape(publicChatText(one.outcome ?? one.detail, 160))}</span></li>`).join('')}</ul></section>`];
  });
  return `<section class="lead-brief" aria-label="Project catch-up"><h2>Catch up</h2>${sections.length ? sections.join('') : '<p>No tasks need your attention. Tell your agent what you want to accomplish.</p>'}${brief.assignments.length > 3 || brief.omissions.candidateScanLimited || brief.omissions.assignments > 0 ? '<a href="/work">See all tasks</a>' : ''}</section>`;
}

export const LEAD_CONTEXT_CSS = '.lead-brief{margin:1rem 0;min-width:0}.lead-brief h2{font-size:1.1rem;margin:0 0 .8rem}.repository-context input[name=q]{display:block;box-sizing:border-box;min-height:44px;width:100%;margin:.4rem 0 .75rem;padding:.6rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;font:inherit}.repository-context form{margin:.5rem 0 1rem}.repository-context summary{min-height:44px;padding:.75rem 0;overflow-wrap:anywhere}.lead-brief h3{font-size:.85rem;margin:1rem 0 .4rem;color:var(--muted-foreground)}.lead-brief ul{list-style:none;margin:0;padding:0}.lead-brief li{display:grid;gap:.2rem;padding:.65rem 0;border-bottom:1px solid var(--border);min-width:0}.lead-brief li a{display:flex;min-height:44px;align-items:center;font-weight:500;overflow-wrap:anywhere}.lead-brief li span{font-size:.85rem;color:var(--muted-foreground);overflow-wrap:anywhere}';
