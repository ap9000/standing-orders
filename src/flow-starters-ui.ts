/**
 * Settings → Flows: the starter flows for a project, each switched on with one yes. A row says what it's for,
 * what it will do and what it never does — the whole of what the yes agrees to — then one button. A starter
 * that's on links to its flow; one that can't run here says why.
 */
import type { StarterView } from "./flow-starters.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const STARTERS_CSS = `.starters{max-width:760px;min-width:0}.starters h2{margin:24px 0 4px;font-size:.9375rem}` +
  `.starter{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:start;padding:14px 0;border-top:1px solid var(--so-line);min-width:0}` +
  `.starter:first-of-type{border-top:0}.starter>:not(.starter-action){grid-column:1}.starter h3{margin:0;font-size:.9375rem;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}` +
  `.starter p,.starter ul{margin:2px 0 0;min-width:0;overflow-wrap:anywhere}.starter ul{padding-left:18px;color:var(--so-muted);font-size:.875rem;line-height:1.5}` +
  `.starter .starter-never{font-size:.875rem;font-weight:500}.starter-action{grid-column:2;grid-row:1 / span 4;align-self:center;margin:0}` +
  `.starter-action button,.starter-action .button-link{min-height:44px;white-space:nowrap}.starter .starter-action button{width:auto}` +
  `.starter .starter-action a.starter-open{background:var(--so-paper);color:var(--so-ink);border:1px solid var(--so-input-line)}` +
  `.starter[data-suggested="true"]{margin:0 -12px;padding:14px 12px;border:1px solid var(--so-accent,var(--so-line));border-radius:10px}` +
  `.starter-on{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;font-weight:500;padding:0 8px;border-radius:5px;line-height:20px;color:var(--so-success);background:var(--so-success-soft)}` +
  `.starter-on i{width:6px;height:6px;border-radius:50%;background:currentColor}.starters .starter-blocked{color:var(--so-muted);font-size:.875rem}` +
  `.starters form.starters-project{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:0 0 8px}.starters form.starters-project label{display:grid;gap:4px}` +
  `@media (max-width:560px){.starter{grid-template-columns:minmax(0,1fr)}.starter .starter-action{grid-column:1;grid-row:auto;margin-top:10px}` +
  `.starter .starter-action button,.starter .starter-action .button-link{width:100%;justify-content:center}.starters select{font-size:16px}}`;

export function startersHtml(input: {
  repo: string; projects: readonly { path: string; name: string }[]; starters: readonly StarterView[]; csrf: string; canSwitch: boolean;
  suggested: string | null; said: string | null; problem: string | null;
}): string {
  const note = input.problem ? `<p class="problem" role="alert">${e(input.problem)}</p>` : input.said ? `<p role="status">${e(input.said)}</p>` : "";
  const selector = input.projects.length > 1
    ? `<form class="starters-project" method="get" action="/settings/flows"><label>Project<select name="repo">${input.projects.map(one => `<option value="${e(one.path)}"${one.path === input.repo ? " selected" : ""}>${e(one.name)}</option>`).join("")}</select></label><button>Show</button></form>` : "";
  // The one asked about ("Do this every time…") comes first, marked.
  const ordered = [...input.starters].sort((a, b) => Number(b.id === input.suggested) - Number(a.id === input.suggested));
  const rows = ordered.map(one => {
    const action = one.on !== null ? `<p class="starter-action"><a class="button-link starter-open" href="/flows/${one.on.flow}">Open flow</a></p>`
      : one.blocked !== null || !input.canSwitch ? ""
      : `<form method="post" action="/settings/flows/on" class="starter-action"><input type="hidden" name="csrf" value="${e(input.csrf)}"><input type="hidden" name="repo" value="${e(input.repo)}">` +
        `<input type="hidden" name="starter" value="${e(one.id)}"><button type="submit">Switch on</button></form>`;
    return `<div class="starter" id="starter-${e(one.id)}" data-starter="${e(one.id)}" data-suggested="${one.id === input.suggested && one.on === null}">` +
      `<h3>${e(one.name)}${one.on === null ? "" : ` <span class="starter-on"><i aria-hidden="true"></i>On</span>`}</h3>` +
      `<p>${e(one.summary)}</p>` +
      // What the yes agrees to, in full, before it; nothing to agree to once it's on or can't be.
      (one.on === null && one.blocked === null ? `<ul>${one.does.map(line => `<li>${e(line)}</li>`).join("")}</ul><p class="starter-never">${e(one.never)}</p>` : "") +
      (one.on === null && one.blocked !== null ? `<p class="starter-blocked">${e(one.blocked)}</p>` : "") + action + `</div>`;
  }).join("");
  const nobody = !input.canSwitch && input.starters.some(one => one.on === null) ? `<p class="meta">An approver switches these on.</p>` : "";
  return `<section class="starters">${note}${selector}<h2>Starter flows</h2>${rows}${nobody}<p class="meta"><a href="/flows">All flows</a></p></section>`;
}
