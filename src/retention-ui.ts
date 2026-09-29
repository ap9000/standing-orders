/**
 * Settings → Retention (v105): how long each kind of data is kept, and what
 * the next daily sweep would remove. An instance operator's page; changes
 * take a step-up.
 */
import { bytesWords } from "./storage.js";
import { PERIOD_CHOICES, RETENTION_KINDS, countWords, periodWords, type RetentionCount, type RetentionPeriods } from "./retention.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const RETENTION_CSS = `.retention{max-width:720px;min-width:0}.retention-next{margin:0 0 16px}` +
  `.retention form{display:grid;gap:0}.retention .kind{display:grid;grid-template-columns:minmax(0,1fr) 11rem;gap:4px 16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}` +
  `.retention .kind .name{font-weight:500;font-size:.875rem}.retention .kind .meta{grid-column:1;margin:0}.retention .kind select{grid-column:2;grid-row:1/span 2;width:100%;min-height:44px}` +
  `.retention .step-up{display:grid;gap:4px;font-size:.8125rem;margin:16px 0 8px;max-width:20rem}.retention .step-up input{min-height:44px}.retention button{justify-self:start;min-height:44px}` +
  `@media (max-width:560px){.retention .kind{grid-template-columns:minmax(0,1fr)}.retention .kind select{grid-column:1;grid-row:auto}}`;

export type RetentionView = { periods: RetentionPeriods; next: RetentionCount[]; lastSweep: string | null; csrf: string };

const listWords = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The next sweep in a line: what goes and about how much space, or that nothing is due. */
function nextWords(view: RetentionView): string {
  if (RETENTION_KINDS.every(({ kind }) => view.periods[kind] === null)) return "Everything is kept forever.";
  const due = view.next.filter(one => one.count > 0);
  if (due.length === 0) return "Nothing is old enough to remove yet.";
  const bytes = due.reduce((sum, one) => sum + one.bytes, 0);
  return `The next daily sweep removes ${listWords(due.map(countWords))} (about ${bytesWords(bytes)}).`;
}

export function retentionHtml(view: RetentionView, notice: { said?: string | null; problem?: string | null }): string {
  const note = notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";
  const rows = RETENTION_KINDS.map(({ kind, label, detail }) => {
    const current = view.periods[kind];
    const choices = PERIOD_CHOICES.includes(current) ? PERIOD_CHOICES : [...PERIOD_CHOICES.slice(0, -1), current, null].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
    const options = choices.map(days => `<option value="${days === null ? "forever" : days}"${days === current ? " selected" : ""}>${days === null ? "Forever" : `${periodWords(days)[0]!.toUpperCase()}${periodWords(days).slice(1)}`}</option>`).join("");
    return `<div class="kind" data-kind="${kind}"><label class="name" for="keep-${kind}">${e(label)}</label><p class="meta">${e(detail)}</p><select id="keep-${kind}" name="${kind}">${options}</select></div>`;
  }).join("");
  const last = view.lastSweep === null ? "" : ` Last sweep ${e(view.lastSweep.slice(0, 10))}.`;
  return `<article class="retention">${note}<p class="retention-next" data-retention-next>${e(nextWords(view))}${last}</p>` +
    `<form method="post" action="/settings/retention"><input type="hidden" name="csrf" value="${e(view.csrf)}">${rows}` +
    `<label class="step-up">Your Standing Orders password<input type="password" name="password" autocomplete="current-password" required></label>` +
    `<button type="submit">Save</button></form>` +
    `<p class="meta">Never removed: the action ledger, and anything a task still needs (unfinished tasks, results not yet completed, anything on hold).</p></article>`;
}
