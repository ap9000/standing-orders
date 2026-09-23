/** Settings → Models: the CLIs on this computer, the default agent for each
 * role picked from live lists, and the models that just arrived. */
import type { ModelOption, RuntimeState, SeenModel, WatchState } from "./model-catalog.js";
import { priceWords } from "./model-catalog.js";

const e = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const hidden = (data: Record<string, string>) => Object.entries(data).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join("");
const when = (iso: string | null) => iso === null ? "never" : `${iso.slice(0, 16).replace("T", " ")} UTC`;

export const MODELS_CSS = `.models{max-width:780px;min-width:0;overflow-wrap:anywhere}.models .card{padding:16px 20px;margin:12px 0;min-width:0}.models h2{margin:24px 0 8px}.models form{margin:0}.models label{display:grid;gap:6px}.models select,.models input[type=search]{box-sizing:border-box;width:100%;max-width:100%;min-width:0}.models button,.models summary,.models .button-link{min-height:44px}.models button{white-space:nowrap}.models summary{padding:12px 0;cursor:pointer}.models .tool{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.models .role{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}.models .role-row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.models .role-row select{flex:1 1 240px;width:auto;min-width:0}.models .role-name{font-weight:600}.models .new{font-weight:600}.models ul{padding-left:20px}.models .meta{font-size:.86rem}@media(max-width:600px){.models .card{padding:14px}}`;

export type RoleView = {
  phase: "plan" | "build" | "review" | "repair";
  label: string;
  /** "provider|model", or "inherit" for a repair that follows the builder. */
  current: string;
  words: string;
  groups: { label: string; provider: string; options: ModelOption[] }[];
  /** Repair only: offer "Same as the builder". */
  inherit?: boolean;
};

export type ModelsView = {
  runtimes: RuntimeState[];
  watch: WatchState;
  roles: RoleView[];
  chat: { words: string } | null;
  fresh: SeenModel[];
  csrf: string;
  canManage: boolean;
  said: string | null;
  problem: string | null;
};

function toolRow(one: RuntimeState, manage: boolean, csrf: string): string {
  const state = one.installed === null ? "Version unknown"
    : one.behind ? `${e(one.installed)} · <strong>${e(one.latest)} available</strong>`
    : `${e(one.installed)} · Up to date`;
  const action = manage && one.behind && one.updateCommand !== null
    ? `<form method="post" action="/settings/models/update">${hidden({ csrf, tool: one.tool })}<button type="submit">Update ${e(one.name)}</button></form>`
    : one.behind ? `<span class="meta">Update it the way you installed it</span>` : "";
  return `<div class="card tool"><span><strong>${e(one.name)}</strong> ${state}${one.problem === null ? "" : `<br><span class="meta">${e(one.problem)}</span>`}</span>${action}</div>`;
}

function roleForm(role: RoleView, manage: boolean, csrf: string): string {
  if (!manage) return `<div class="card role"><strong>${e(role.label)}</strong><span>${e(role.words)}</span></div>`;
  const known = role.groups.some(group => group.options.some(option => `${group.provider}|${option.value}` === role.current));
  const saved = !known && role.current !== "inherit" && role.current !== "" ? `<option value="${e(role.current)}" selected>${e(role.words)} · current</option>` : "";
  const groups = role.groups.map(group => `<optgroup label="${e(group.label)}">${group.options.map(option => {
    const value = `${group.provider}|${option.value}`;
    return `<option value="${e(value)}"${value === role.current ? " selected" : ""}>${e(option.label)}</option>`;
  }).join("")}</optgroup>`).join("");
  const inherit = role.inherit ? `<option value="inherit"${role.current === "inherit" ? " selected" : ""}>Same as the builder</option>` : "";
  const long = role.groups.reduce((sum, group) => sum + group.options.length, 0) > 40;
  const count = role.groups.reduce((sum, group) => sum + group.options.length, 0);
  const id = `role-${role.phase}`;
  return `<form method="post" action="/settings/models/agent" class="card role">${hidden({ csrf, phase: role.phase })}` +
    `<label class="role-name" for="${id}">${e(role.label)}</label>` +
    (long ? `<input type="search" data-model-filter hidden aria-label="Search ${e(role.label.toLowerCase())} models" placeholder="Search ${count} models" autocomplete="off">` : "") +
    `<div class="role-row"><select id="${id}" name="agent">${inherit}${saved}${groups}</select><button type="submit" class="secondary">Save</button></div></form>`;
}

export function modelsHtml(view: ModelsView): string {
  const manage = view.canManage && view.csrf !== "";
  const status = view.said === null ? "" : `<p role="status">${e(view.said)}</p>`;
  const problem = view.problem === null ? "" : `<p class="problem" role="alert">${e(view.problem)}</p>`;
  const tools = view.runtimes.length === 0
    ? `<p class="meta">No Claude, Codex or Gemini CLI found on this computer yet.</p>`
    : view.runtimes.map(one => toolRow(one, manage, view.csrf)).join("");
  const check = manage
    ? `<form method="post" action="/settings/models/check" class="inline">${hidden({ csrf: view.csrf })}<button type="submit" class="secondary">Check now</button></form>`
    : "";
  const fresh = view.fresh.length === 0 ? "" :
    `<h2>New models</h2><ul>${view.fresh.map(model => `<li><span class="new">${e(model.name)}</span> <span class="meta">${e(priceWords(model))}${model.releasedAt === null ? "" : ` · released ${e(model.releasedAt.slice(0, 10))}`}</span></li>`).join("")}</ul>`;
  const watch = manage
    ? `<details><summary>Automatic checks · ${view.watch.enabled ? "On" : "Off"}</summary><form method="post" action="/settings/models/watch">${hidden({ csrf: view.csrf, enabled: view.watch.enabled ? "0" : "1" })}` +
      `<p>Check every 6 hours and send a message when a new model or CLI update appears. It uses public lists and sends nothing about you or your projects.</p>` +
      `<button type="submit" class="secondary">${view.watch.enabled ? "Turn off" : "Turn on"}</button></form></details>`
    : "";
  return `<section class="models">${status}${problem}` +
    `<h2>AI tools</h2>${tools}<p class="meta">Checked ${e(when(view.watch.checkedAt))} ${check}</p>` +
    fresh +
    `<h2>Default agents</h2><p class="meta">New tasks use these. Approved tasks keep the agents they were approved with.</p>` +
    view.roles.map(role => roleForm(role, manage, view.csrf)).join("") +
    (view.chat === null ? "" : `<h2>Chat</h2><p>${e(view.chat.words)} · <a href="/chat#chat-settings">Change in chat</a></p>`) +
    watch + `</section>`;
}

/** Filters one long picker as you type; the saved choice always stays listed. */
export function modelsScript(): string {
  return `(function(){document.querySelectorAll('.models form.role').forEach(function(form){
    var search=form.querySelector('[data-model-filter]'),select=form.querySelector('select');
    if(!search||!select)return;search.hidden=false;
    var groups=Array.from(select.querySelectorAll('optgroup')).map(function(g){return{g:g,options:Array.from(g.children)}});
    search.addEventListener('input',function(){var q=search.value.trim().toLowerCase(),chosen=select.value;
      groups.forEach(function(entry){entry.g.replaceChildren();entry.options.forEach(function(o){if(!q||o.value===chosen||(o.textContent+' '+o.value).toLowerCase().includes(q))entry.g.appendChild(o)})});
      select.value=chosen;});
  })})();`;
}
