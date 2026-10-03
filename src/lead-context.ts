/** Bounded DB memory shared by browser and terminal lead turns. No provider,
 * repository scan, mutation, or hidden approval happens while catching up. */
import type { Store } from './store.js';
import { assignmentCatchUp, type AssignmentCatchUp } from './assignment-brief.js';
import { publicChatText } from './chat-display.js';
import { conditionWords, openCommitments } from './lead-commitments.js';

const REMEMBERED = new Set(['decision_record', 'knowledge_instructions']);
/** The lead's own follow-through for one conversation: its open promises, and corrections the operator confirmed
 * since its last reply (with the cards still open in this conversation, which a correction may affect). */
function followThrough(store: Store, owner: string, thread: number) {
  const commitments = openCommitments(store, owner, 10).map(one => ({ id: one.id, what: one.what.slice(0, 160), when: conditionWords(store, one.condition), expires: one.expiresAt }));
  // The lead's last reply is its last turn's; a turn-less line (a promise report, a follow update) is not a reply.
  const last = store.handle.prepare("SELECT MAX(created_at) AS at FROM mate_message WHERE thread=? AND role='assistant' AND turn IS NOT NULL").get(thread)?.['at'];
  const corrections: { proposal: number; change: string }[] = [];
  for (const row of store.handle.prepare("SELECT id,payload_json FROM mate_proposal WHERE thread=? AND kind='action' AND state='confirmed' AND resolved_at>? ORDER BY id DESC LIMIT 20").all(thread, String(last ?? ''))) {
    try {
      const payload = JSON.parse(String(row['payload_json']));
      // A changed instruction is added at the end, so that is the part to show.
      const instructions = payload?.request?.instructions;
      const change = payload?.operation === 'knowledge_instructions' && typeof instructions === 'string'
        ? `Project instructions now end: ${instructions.slice(-240)}` : Array.isArray(payload?.terms) ? payload.terms[0] : null;
      if (REMEMBERED.has(payload?.operation) && typeof change === 'string') corrections.push({ proposal: Number(row['id']), change: change.slice(0, 300) });
    } catch { /* an unreadable card is not a correction */ }
    if (corrections.length === 5) break;
  }
  const openProposals = corrections.length === 0 ? [] : store.listMateProposals(thread, ['pending']).slice(-5).map(one => {
    const payload = one.payload as Record<string, unknown>;
    const title = [payload['title'], payload['taskTitle'], payload['task']].find(value => typeof value === 'string');
    return { proposal: one.id, kind: one.kind, about: typeof title === 'string' ? title.slice(0, 120) : null };
  });
  return { commitments, corrections, openProposals,
    ...(corrections.length === 0 ? {} : { followThrough: 'The operator confirmed these corrections since your last reply. Re-check the open proposals and promises listed here; release or replace any they affect and say in one line what you changed.' }) };
}

export function leadContext(store: Store, repos: readonly string[], now: Date, evidenceRoot?: string, lead?: { owner: string; thread: number }) {
  const brief = assignmentCatchUp(store, now, { principal: 'operator', repos }, { limit: 8 }, evidenceRoot);
  const tasks = brief.assignments.map(one => ({
    repo: `r${repos.indexOf(one.repo ?? '') + 1}`, id: one.rootId, currentExecution: one.taskId,
    title: one.title, state: one.state, goal: one.goal, outcome: one.outcome,
    checks: one.checks?.status ?? null, next: one.nextAction?.label ?? null,
    decisions: one.decisions.filter(decision => decision.state !== 'answered').map(decision => ({ id: decision.id, question: decision.question })),
  }));
  const projects = brief.projects.map(one => ({ repo: `r${repos.indexOf(one.repo) + 1}`,
    knowledge: one.knowledge.status, revision: one.knowledge.revision, instructions: one.knowledge.instructions,
    sources: one.knowledge.sources.map(source => ({ id: source.id, title: source.title })), decisions: one.knowledge.decisions }));
  const data = { snapshotVersion: 2, source: 'local-database', repos: repos.map((_, index) => ({ id: `r${index + 1}` })), tasks, projects,
    ...(lead === undefined ? {} : followThrough(store, lead.owner, lead.thread)),
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
const STATE_WORDS: Record<string, string> = { 'needs-decision': 'Needs you', 'ready-to-check': 'Ready', working: 'Working', checking: 'Checking', complete: 'Complete', cancelled: 'Cancelled' };
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
    // Finished work is a title and its state; a sentence is kept only where
    // it says what the person or the crew is doing next.
    const quiet = group.title === 'Finished';
    // A state chip that repeats its group's heading says nothing new.
    const stateChip = (state: string, detail?: string) => {
      // Replaced, never "Cancelled".
      const words = state === 'cancelled' && /^Replaced by \S+/.test(detail ?? '') ? detail!.replace(/\.$/, '') : STATE_WORDS[state] ?? state;
      return words === group.title ? '' : `<span class="lead-brief-state lead-brief-state--${state}">${escape(words)}</span>`;
    };
    return [`<section><h3>${group.title}</h3><ul>${entries.map(one => `<li><a href="/chat?task=${encodeURIComponent(one.rootId)}">${escape(one.title)}</a>` +
      stateChip(one.state, one.detail) +
      (quiet ? '' : `<span class="lead-brief-detail">${escape(publicChatText(one.detail || one.outcome || '', 160))}</span>`) +
      // Needs you: the one action that resolves it, under its sentence.
      (one.state === 'needs-decision' && one.nextAction !== null && one.nextHref ? `<a class="lead-brief-act button-link" href="${escape(one.nextHref)}" data-catch-up-action>${escape(one.nextAction.label)}</a>` : '') + `</li>`).join('')}</ul></section>`];
  });
  return `<section class="lead-brief" aria-label="Project catch-up"><h2>Catch up</h2>${sections.length ? sections.join('') : '<p class="meta">Nothing needs you right now.</p>'}${brief.assignments.length > 3 || brief.omissions.candidateScanLimited || brief.omissions.assignments > 0 ? '<a href="/work">See all tasks</a>' : ''}</section>`;
}

export const LEAD_CONTEXT_CSS = '.lead-promise-list{list-style:none;margin:0;padding:0}.lead-promise-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--border);min-width:0}.lead-promise-list li:last-child{border-bottom:0}.lead-promise-list p{margin:0;overflow-wrap:anywhere}.lead-promise-list form{grid-column:2;grid-row:1/span 2;margin:0}.lead-promise-list button{min-height:44px;width:auto;white-space:nowrap}.lead-promise-list .nowrap{white-space:nowrap}.lead-brief{margin:1rem 0;min-width:0}.lead-brief h2{font-size:1.1rem;margin:0 0 .8rem}.repository-context input[name=q]{display:block;box-sizing:border-box;min-height:44px;width:100%;margin:.4rem 0 .75rem;padding:.6rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit;font:inherit}.repository-context form{margin:.5rem 0 1rem}.repository-context summary{min-height:44px;padding:.75rem 0;overflow-wrap:anywhere}.lead-brief h3{font-size:.85rem;margin:1rem 0 .4rem;color:var(--muted-foreground)}.lead-brief ul{list-style:none;margin:0;padding:0}.lead-brief li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;align-items:center;padding:.35rem 0;border-bottom:1px solid var(--border);min-width:0}.lead-brief li a{display:flex;min-height:44px;align-items:center;font-weight:500;overflow-wrap:anywhere;text-decoration:none}.lead-brief li a:hover{text-decoration:underline}.lead-brief-state{font-size:.75rem;font-weight:600;padding:.15rem .5rem;border-radius:.375rem;background:var(--so-neutral-soft);color:var(--so-neutral-ink);white-space:nowrap}.lead-brief-state--needs-decision,.lead-brief-state--ready-to-check{background:var(--so-attention-soft);color:var(--so-attention)}.lead-brief-state--working,.lead-brief-state--checking{background:var(--so-info-soft);color:var(--so-info)}.lead-brief-state--complete{background:var(--so-success-soft);color:var(--so-success)}.lead-brief li a.lead-brief-act{grid-column:1/-1;justify-self:start;display:inline-flex;min-height:40px;margin:.15rem 0 .4rem;font-weight:600}@media(max-width:760px){.lead-brief li a.lead-brief-act{justify-self:stretch;justify-content:center;min-height:44px}}.lead-brief-detail{grid-column:1/-1;font-size:.85rem;color:var(--muted-foreground);overflow-wrap:anywhere;padding-bottom:.35rem}@media(max-width:760px){.lead-brief{margin:.5rem 0}.lead-brief h2{margin:0 0 .25rem}.lead-brief h3{margin:.5rem 0 0}.lead-brief li{padding:0 0 .375rem}.lead-brief-detail{margin-top:-.375rem;padding-bottom:0;line-height:1.35;pointer-events:none}}';
