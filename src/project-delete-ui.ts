/**
 * Settings → Project: what Standing Orders holds for a project, and deleting
 * it. An instance operator deletes in two steps: type the project's name,
 * then read exactly what goes and confirm with their password (or a fresh
 * sign-in with the identity provider). The repository itself stays.
 */
import { holdingsWords, type ProjectHoldings } from "./project-delete.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PROJECT_DELETE_CSS = `.project-settings,.project-delete{max-width:720px;min-width:0}.project-settings .path,.project-delete .path{font-family:var(--font-mono);font-size:.8125rem;overflow-wrap:anywhere;word-break:break-all}` +
  `.project-settings details.danger-zone{margin-top:24px;border:1px solid var(--border);border-radius:10px;padding:0 14px}.project-settings details.danger-zone summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:500;color:var(--danger)}` +
  `.project-settings details.danger-zone[open]{padding-bottom:14px}.project-settings form,.project-delete form{display:grid;gap:12px;margin-top:12px}.project-settings label,.project-delete label{display:grid;gap:4px;font-size:.8125rem;font-weight:500}` +
  `.project-settings input,.project-delete input{max-width:100%;min-height:36px}.project-delete .removes{margin:12px 0;padding-left:20px}.project-delete .removes li{margin:2px 0}` +
  `.project-delete .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.project-delete button.danger,.project-settings button.danger{background:var(--danger);color:#fff;border-color:var(--danger);white-space:nowrap}` +
  `.project-settings button,.project-delete button{justify-self:start;min-height:36px;white-space:nowrap}.project-delete .actions a{min-height:36px;display:inline-flex;align-items:center}`;

export type ProjectSettingsView = { repo: string; name: string; holdings: ProjectHoldings; running: string[]; canDelete: boolean };

const note = (notice: { said?: string | null; problem?: string | null }) =>
  notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";

/** The project's page: its path, what Standing Orders holds for it, and (for an instance operator) Delete project. */
export function projectSettingsHtml(view: ProjectSettingsView, csrf: string, notice: { said?: string | null; problem?: string | null }): string {
  const held = `<p>Standing Orders holds ${e(holdingsWords(view.holdings))} for <strong>${e(view.name)}</strong>.</p>`;
  const head = `<section class="project-settings">${note(notice)}<p class="path">${e(view.repo)}</p>${held}`;
  if (!view.canDelete) return `${head}<p class="meta">An instance operator can delete a project.</p></section>`;
  const body = view.running.length > 0
    ? `<p class="problem">Its work is running: ${e(view.running.join(", "))}. Stop it before deleting the project.</p>`
    : `<p>Removes everything Standing Orders holds for ${e(view.name)}. The repository and its own branches stay. There's no undo.</p>` +
      `<form method="post" action="/settings/project/delete"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}">` +
      `<label><span>Type <strong>${e(view.name)}</strong> to continue</span><input name="name" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>` +
      `<button type="submit">Continue</button></form>`;
  return `${head}<details class="danger-zone"${notice.problem ? " open" : ""}><summary>Delete project</summary>${body}</details></section>`;
}

/** The second step: exactly what goes, and the password. */
export function projectDeleteConfirmHtml(view: ProjectSettingsView, csrf: string, problem: string | null): string {
  const h = view.holdings;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const items = [
    `${count(h.tasks, "task")}${h.versions > 0 ? ` and ${count(h.versions, "version")}` : ""}, with ${count(h.runs, "run")} and their evidence`,
    "The checkouts and branches Standing Orders made",
    ...(h.chats > 0 ? [count(h.chats, "chat")] : []),
    ...(h.flows > 0 ? [`${count(h.flows, "flow")} and ${count(h.cards, "card")}`] : []),
    ...(h.teammates > 0 ? [count(h.teammates, "teammate")] : []),
    "Its budgets, settings and knowledge",
  ];
  return `<section class="project-delete">${problem === null ? "" : `<p class="problem" role="alert">${e(problem)}</p>`}` +
    `<p>This removes:</p><ul class="removes">${items.map(one => `<li>${e(one)}</li>`).join("")}</ul>` +
    `<p>The repository at <span class="path">${e(view.repo)}</span> and its own branches stay. The ledger keeps its history. There's no undo.</p>` +
    `<form method="post" action="/settings/project/delete"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="repo" value="${e(view.repo)}"><input type="hidden" name="name" value="${e(view.name)}"><input type="hidden" name="step" value="delete">` +
    `<label>Your Standing Orders password<input type="password" name="password" autocomplete="current-password"></label>` +
    `<div class="actions"><button type="submit" class="danger">Delete project</button><a href="/settings/project?repo=${e(encodeURIComponent(view.repo))}">Cancel</a></div></form></section>`;
}
