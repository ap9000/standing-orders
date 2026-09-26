/**
 * The Teammates pages (v92): who is on the team, and one page per teammate —
 * what it asks you, its soul file, what it did and why, what you told it,
 * and its settings. Server-rendered forms, like the other settings pages.
 */
import type { Store, TeammateRow } from "./store.js";
import { labelOf, nameOf, summaryOf, TEAMMATE_MODELS, zonesOf } from "./teammate-admin.js";
import { TEAMMATE_TEMPLATES } from "./teammates.js";
import { projectToolsOf } from "./project-tools.js";
import { callWords, defaultRule, numberFields, receiptWords } from "./teammate-tools.js";
import { MEMORY_CHARS, searchMemories } from "./teammate-memory.js";

/** v94: the Tools section's rule rows; a limit's fields show only while "Up to a limit" is chosen. */
export const TEAMMATE_CSS = `.teammate-tools .tool-grant{border-top:1px solid var(--so-line);padding-top:12px;margin-top:12px}.teammate-tools .tool-grant:first-of-type{border-top:0;margin-top:0;padding-top:0}.teammate-tools h3{font-size:1rem;margin:0 0 4px}.teammate-tools .tool-rule{display:grid;gap:6px;padding:10px 0;border-bottom:1px solid var(--so-line)}.teammate-tools .tool-rule:last-of-type{border-bottom:0}.teammate-tools .tool-rule .meta{display:block}.teammate-tools select,.teammate-tools input{max-width:100%;box-sizing:border-box}.teammate-tools .tool-limit{display:none;flex-wrap:wrap;align-items:center;gap:6px}.teammate-tools .tool-rule:has(option[value="limit"]:checked) .tool-limit{display:flex}.teammate-tools .tool-rule>select{width:auto;min-width:16em}.teammate-tools .tool-limit select{width:auto}.teammate-tools .tool-limit input{width:7em}.teammate-tools .tool-buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.teammate-tools button{min-height:44px}.teammate-activity li{overflow-wrap:anywhere}.teammate-memory .memory-tell,.teammate-memory .memory-search{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:0 0 12px}.teammate-memory .memory-tell textarea{flex:1 1 280px}.teammate-memory .memory-search input{flex:1 1 220px}.teammate-memory button{min-height:44px}.teammate-memories{list-style:none;padding:0;margin:0}.teammate-memories li{padding:10px 0;border-top:1px solid var(--so-line);overflow-wrap:anywhere}.teammate-memories li:first-child{border-top:0}.teammate-memories .meta{display:block;font-size:.85rem}.teammate-memories details.memory-edit{border:0;padding:0;margin:2px 0 0;background:transparent;box-shadow:none}.memory-edit summary{cursor:pointer;min-height:32px;display:inline-flex;align-items:center;font-size:.85rem;font-weight:400;color:var(--so-muted)}.teammate-actions,.question-options{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.teammate-actions form,.question-options form{margin:0}.memory-edit form{display:grid;gap:8px;margin-top:6px}.memory-buttons{display:flex;flex-wrap:wrap;gap:8px}@media(max-width:600px){.teammate-tools select,.teammate-tools input{font-size:16px}}`;

const USES = [["free", "Do it"], ["limit", "Do it, up to a limit"], ["ask", "Ask first"], ["never", "Never"]] as const;

/** v94: which project tools it may use, and its rule for each action. */
function toolsSection(store: Store, mate: TeammateRow, csrf: string, canManage: boolean): string {
  const name = nameOf(mate);
  const tools = projectToolsOf(store, mate.repo);
  const grants = store.teammateGrants(mate.id);
  const toolsPage = `/settings/tools?repo=${encodeURIComponent(mate.repo)}`;
  const granted = grants.map(grant => {
    const gone = !tools.some(one => one.name === grant.tool);
    const rows = grant.actions.map(action => {
      const rule = grant.rules[action.name] ?? defaultRule(action);
      const use = rule.use === "free" && rule.limit !== undefined ? "limit" : rule.use;
      const numbers = numberFields(action);
      const words = rule.use === "never" ? "Never" : rule.use === "ask" ? "Ask first" : rule.limit === undefined ? "Do it" : `Do it up to ${rule.limit.field} ${rule.limit.over}, ask first above`;
      if (!canManage) return `<li class="tool-rule"><span><strong>${e(action.name)}</strong> · ${e(words)}</span>${action.about === "" ? "" : `<span class="meta">${e(action.about)}</span>`}</li>`;
      const field = `${grant.tool}-${action.name}`.replace(/[^A-Za-z0-9_-]/g, "-");
      return `<div class="tool-rule" data-tool-action="${e(action.name)}"><label for="use-${e(field)}"><strong>${e(action.name)}</strong>${action.about === "" ? "" : `<span class="meta">${e(action.about)}</span>`}</label>` +
        `<select id="use-${e(field)}" name="use.${e(action.name)}">${USES.filter(([value]) => value !== "limit" || numbers.length > 0).map(([value, label]) => `<option value="${value}"${value === use ? " selected" : ""}>${label}</option>`).join("")}</select>` +
        (numbers.length === 0 ? "" : `<span class="tool-limit">Ask first when <select name="field.${e(action.name)}" aria-label="The number the limit is on">${numbers.map(one => `<option value="${e(one)}"${rule.limit?.field === one ? " selected" : ""}>${e(one)}</option>`).join("")}</select> is over <input type="number" name="over.${e(action.name)}" min="0" step="any" value="${rule.limit === undefined ? "" : rule.limit.over}" aria-label="The limit"></span>`) +
        `</div>`;
    }).join("");
    const head = `<h3>${e(grant.tool)}</h3>${gone ? `<p class="problem">This project doesn't have ${e(grant.tool)} any more, so ${e(name)} can't use it.</p>` : ""}`;
    return canManage
      ? `<div class="tool-grant" data-tool-grant="${e(grant.tool)}">${head}<form method="post" action="/teammates/${mate.id}/tools">${hidden(csrf)}<input type="hidden" name="tool" value="${e(grant.tool)}">${rows}` +
        `<div class="tool-buttons"><button name="op" value="rules">Save rules</button><button name="op" value="revoke" class="secondary">Stop using ${e(grant.tool)}</button></div></form></div>`
      : `<div class="tool-grant" data-tool-grant="${e(grant.tool)}">${head}<ul>${rows}</ul></div>`;
  }).join("");
  const open = tools.filter(one => !grants.some(grant => grant.tool === one.name));
  const add = !canManage ? "" : tools.length === 0 ? `<p class="meta">This project has no tools yet. <a href="${e(toolsPage)}">Add one</a>, then let ${e(name)} use it here.</p>`
    : open.length === 0 ? "" : `<form method="post" action="/teammates/${mate.id}/tools" class="tool-add">${hidden(csrf)}<input type="hidden" name="op" value="grant"><label>Let ${e(name)} use<select name="tool">${open.map(one => `<option value="${e(one.name)}">${e(one.name)}${one.spec.about === "" ? "" : ` — ${e(one.spec.about.slice(0, 80))}`}</option>`).join("")}</select></label><button>Add tool</button></form>`;
  if (grants.length === 0 && add === "") return "";
  return `<section class="card teammate-tools" id="tools"><h2>Tools</h2>${grants.length === 0 ? `<p class="meta">${e(name)} doesn't use any tools yet. Reading starts as “Do it”; everything else asks you first.</p>` : ""}${granted}${add}</section>`;
}

const e = (text: string) => text.replace(/[&<>"']/g, one => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
const when = (at: string) => new Date(at).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${e(csrf)}">`;
const startOfDay = () => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.toISOString(); };

/** A blank soul file: the sections a teammate reads, to fill in. */
export const BLANK_SOUL = `---\nname: \nrole: \n---\n\n## Who you are\n\n\n## How you write\n\n\n## What you know\n\n\n## Decide on your own\n- \n\n## Ask first\n- \n\n## Never\n- \n`;

export function teammatesListHtml(store: Store, mates: readonly TeammateRow[], projects: readonly string[], projectName: (repo: string) => string, csrf: string, canCreate: boolean, notice: { said?: string | null; problem?: string | null }): string {
  const rows = mates.map(mate => {
    const today = store.teammateTurnsSince(mate.id, startOfDay());
    const open = store.openTeammateQuestions([mate.id]).length;
    return `<article class="card" data-teammate="${e(mate.handle)}"><div class="flow-row"><h2><a href="/teammates/${mate.id}">${e(labelOf(mate))}</a></h2><span class="flow-counts">${e(projectName(mate.repo))} · ${mate.state === "active" ? "Working" : "Paused"} · ${today} today${open > 0 ? ` · ${open} question${open === 1 ? "" : "s"} for you` : ""}</span></div></article>`;
  }).join("");
  const create = canCreate && projects.length > 0
    ? `<details class="card"${mates.length === 0 ? " open" : ""}><summary>New teammate</summary><form method="post" action="/teammates/new" data-new-teammate>${hidden(csrf)}` +
      `<label>Start from<select name="template">${TEAMMATE_TEMPLATES.map(one => `<option value="${e(one.id)}">${e(one.label)}: ${e(one.about)}</option>`).join("")}<option value="blank">Blank: write its soul file yourself</option></select></label>` +
      `<label>Name<input name="name" maxlength="40" placeholder="keep the template's name"></label>` +
      (projects.length === 1 ? `<input type="hidden" name="repo" value="${e(projects[0]!)}">` : `<label>Project<select name="repo">${projects.map(repo => `<option value="${e(repo)}">${e(projectName(repo))}</option>`).join("")}</select></label>`) +
      `<button>Add teammate</button></form></details>`
    : "";
  const intro = `<p class="meta">AI teammates work your flows' cards within rules you write: they decide, reply and move cards on, and ask you when their rules say to.</p>`;
  return `<section class="teammates">${notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : ""}${notice.said ? `<p class="said" role="status">${e(notice.said)}</p>` : ""}${intro}${rows || '<p class="meta">No teammates yet.</p>'}${create}</section>`;
}

/** v95: what it remembers — what its people told it, and what it kept from cards — to search, edit and forget. */
function memorySection(store: Store, mate: TeammateRow, csrf: string, canManage: boolean, query: string | null): string {
  const name = nameOf(mate);
  const all = store.teammateMemories(mate.id, { limit: 500 });
  const shown = query === null || query.trim() === "" ? all.slice(0, 30) : searchMemories(store, mate, query);
  const tell = canManage ? `<form method="post" action="/teammates/${mate.id}/note" class="memory-tell">${hidden(csrf)}<label class="sr-only" for="teammate-note">Tell ${e(name)} something</label><textarea id="teammate-note" name="note" rows="2" maxlength="${MEMORY_CHARS}" placeholder="For example: this week, offer free shipping instead of a refund when you can."></textarea><button>Tell ${e(name)}</button></form>` : "";
  const search = all.length > 8 || (query ?? "") !== "" ? `<form method="get" action="/teammates/${mate.id}#memory" class="memory-search" role="search"><label class="sr-only" for="memory-q">Search what ${e(name)} remembers</label><input id="memory-q" type="search" name="q" value="${e(query ?? "")}" placeholder="Search what ${e(name)} remembers"><button class="secondary">Search</button></form>` : "";
  const items = shown.map(one => {
    const card = one.card === null ? null : store.getFlowCard(one.card);
    const whence = one.source === "person" ? `${e(one.createdBy)} told it` : card === null ? "it kept this" : `it kept this from <a href="/flows/${card.flow}?card=${card.id}">${e(card.title.slice(0, 60))}</a>`;
    const edit = canManage ? `<details class="memory-edit"><summary>Edit</summary><form method="post" action="/teammates/${mate.id}/memory">${hidden(csrf)}<input type="hidden" name="id" value="${one.id}"><label class="sr-only" for="memory-${one.id}">Memory</label><textarea id="memory-${one.id}" name="text" rows="2" maxlength="${MEMORY_CHARS}">${e(one.text)}</textarea><div class="memory-buttons"><button name="op" value="edit">Save</button><button name="op" value="forget" class="secondary">Forget</button></div></form></details>` : "";
    return `<li data-memory="${one.id}" data-source="${one.source}"><span>${e(one.text)}</span> <span class="meta">${whence} · ${when(one.updatedAt)}</span>${edit}</li>`;
  }).join("");
  const empty = (query ?? "") !== "" ? `<p class="meta">Nothing ${e(name)} remembers matches that.</p>` : `<p class="meta">Nothing yet. What you tell ${e(name)} is kept here, and it keeps short facts from the cards it works.</p>`;
  return `<section class="card teammate-memory" id="memory"><h2>Memory</h2>${tell}${search}${shown.length === 0 ? empty : `<ul class="teammate-memories">${items}</ul>`}${query === null && all.length > shown.length ? `<p class="meta">${all.length - shown.length} older ${all.length - shown.length === 1 ? "memory" : "memories"}: search to find them.</p>` : ""}</section>`;
}

export function teammatePageHtml(store: Store, mate: TeammateRow, viewer: string, projectName: (repo: string) => string, csrf: string, canManage: boolean, approvers: readonly string[], notice: { said?: string | null; problem?: string | null; soulDraft?: string | null; query?: string | null }): string {
  const name = nameOf(mate);
  const questions = store.openTeammateQuestions([mate.id]);
  const asked = questions.map(question => {
    const card = store.getFlowCard(question.card);
    const flow = card === null ? null : store.getFlow(card.flow);
    const mine = question.askedOf === viewer;
    const cardLink = card === null || flow === null ? "a card" : `<a href="/flows/${flow.id}?card=${card.id}">${e(card.title)}</a>`;
    return `<article class="card teammate-question" data-question="${question.id}"${question.suggestion === null ? "" : " data-suggestion"}><p class="meta">${question.suggestion === null ? `About ${cardLink}` : "Suggests a rule change"} · ${when(question.createdAt)}${mine ? "" : ` · for ${e(question.askedOf)}`}</p><p><strong>${e(question.question)}</strong></p>` +
      (mine ? `<div class="question-options">${question.options.map(one => `<form method="post" action="/teammates/questions/${question.id}/answer">${hidden(csrf)}<input type="hidden" name="choice" value="${e(one.id)}"><button>${e(one.label)}</button></form>`).join("")}</div>` +
        `<form method="post" action="/teammates/questions/${question.id}/answer" class="question-reply">${hidden(csrf)}<label>Or answer in your words<textarea name="text" rows="2" maxlength="2000"></textarea></label><button>Answer</button></form>` : "") +
      `</article>`;
  }).join("");
  const zones = zonesOf(store, mate);
  const where = zones.length === 0
    ? `<p class="meta">Not on any zone yet. In a flow, choose ${e(name)} under “Who decides” on a “Person decides” zone, or add a “Teammate handles it” zone.</p>`
    : `<ul>${zones.map(one => `<li><a href="/flows/${one.flow}">${e(one.flowName)}</a> · ${one.kind === "decides" ? "decides" : "handles"} ${e(one.title)}</li>`).join("")}</ul>`;
  // What it did and why, with every tool call it made or asked to make (v94), newest first.
  const events = [
    ...store.teammateEvents(mate.id, 40).filter(one => one.kind !== "note").map(one => ({ kind: one.kind as string, said: one.said, card: one.card, at: one.at })),
    ...store.teammateCallsOf(mate.id, 40).map(one => ({ kind: "call", said: `Used ${callWords(one.tool, one.action, one.input, 200)} · ${receiptWords(store, one)}`, card: one.card as number | null, at: one.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  const activity = events.length === 0 ? `<p class="meta">Nothing yet.</p>` : `<ul class="teammate-activity">${events.map(one => {
    const card = one.card === null ? null : store.getFlowCard(one.card);
    return `<li data-event="${one.kind}">${e(one.said)}${card === null ? "" : ` · <a href="/flows/${card.flow}?card=${card.id}">open</a>`} <span class="meta">${when(one.at)}</span></li>`;
  }).join("")}</ul>`;
  const versions = store.teammateVersions(mate.id);
  const latest = versions[0];
  const manage = canManage ? `<div class="teammate-actions">` +
    `<form method="post" action="/teammates/${mate.id}/state">${hidden(csrf)}<input type="hidden" name="state" value="${mate.state === "active" ? "paused" : "active"}"><button${mate.state === "active" ? ' class="secondary"' : ""}>${mate.state === "active" ? `Pause ${e(name)}` : `Resume ${e(name)}`}</button></form>` +
    `<form method="post" action="/teammates/${mate.id}/summary">${hidden(csrf)}<button class="secondary">Send today's summary</button></form></div>` : "";
  return [
    notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : "",
    notice.said ? `<p class="said" role="status">${e(notice.said)}</p>` : "",
    `<p class="meta">${e(projectName(mate.repo))} · ${mate.state === "active" ? "Working" : "Paused: its decisions go to people"} · reports to ${e(mate.manager)}</p>`,
    manage,
    questions.length === 0 ? "" : `<section><h2>Questions</h2>${asked}</section>`,
    `<section class="card"><h2>Today</h2><p class="teammate-summary">${e(summaryOf(store, mate, startOfDay()).said).replace(/\n/g, "<br>")}</p></section>`,
    `<section class="card"><h2>Works on</h2>${where}</section>`,
    toolsSection(store, mate, csrf, canManage),
    memorySection(store, mate, csrf, canManage, notice.query ?? null),
    `<details class="card"${canManage ? " open" : ""}><summary>Soul file</summary><p class="meta">Who ${e(name)} is and its rules, read every turn. Version ${mate.version}${latest === undefined ? "" : ` · saved by ${e(latest.savedBy)}, ${when(latest.savedAt)}`} · <a href="/teammates/${mate.id}/soul.md" download>Download</a></p>` +
      (canManage ? `<form method="post" action="/teammates/${mate.id}/soul" data-soul-form>${hidden(csrf)}<label class="sr-only" for="teammate-soul">Soul file</label><textarea id="teammate-soul" name="soul" rows="24" class="mono" maxlength="12000" spellcheck="false">${e(notice.soulDraft ?? mate.soul)}</textarea><button>Save</button></form>` : `<pre class="mono">${e(mate.soul)}</pre>`) + `</details>`,
    `<details class="card"><summary>What ${e(name)} did</summary>${activity}</details>`,
    canManage ? `<details class="card"><summary>Settings</summary><form method="post" action="/teammates/${mate.id}/settings">${hidden(csrf)}` +
      `<label>Model<select name="model">${TEAMMATE_MODELS.map(one => `<option value="${one}"${(mate.model ?? "default") === one ? " selected" : ""}>${one === "default" ? "The lead chat's model" : one[0]!.toUpperCase() + one.slice(1)}</option>`).join("")}</select></label>` +
      `<label>Turns a day, at most<input type="number" name="dailyTurns" min="1" max="2000" value="${mate.dailyTurns}"></label>` +
      `<label>Reports to<select name="manager">${[...new Set([mate.manager, ...approvers])].map(one => `<option value="${e(one)}"${one === mate.manager ? " selected" : ""}>${e(one)}</option>`).join("")}</select></label><button>Save settings</button></form>` +
      `<form method="post" action="/teammates/${mate.id}/state" class="danger-zone">${hidden(csrf)}<input type="hidden" name="state" value="removed"><button class="danger">Remove ${e(name)} from the team</button></form></details>` : "",
  ].join("");
}
