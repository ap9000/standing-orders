/**
 * The Teammates pages (v92): who is on the team, and one page per teammate —
 * what it asks you, its soul file, what it did and why, what you told it,
 * and its settings. Server-rendered forms, like the other settings pages.
 */
import type { Store, TeammateRow } from "./store.js";
import { labelOf, nameOf, summaryOf, TEAMMATE_MODELS, zonesOf } from "./teammate-admin.js";
import { TEAMMATE_TEMPLATES } from "./teammates.js";

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

export function teammatePageHtml(store: Store, mate: TeammateRow, viewer: string, projectName: (repo: string) => string, csrf: string, canManage: boolean, approvers: readonly string[], notice: { said?: string | null; problem?: string | null; soulDraft?: string | null }): string {
  const name = nameOf(mate);
  const questions = store.openTeammateQuestions([mate.id]);
  const asked = questions.map(question => {
    const card = store.getFlowCard(question.card);
    const flow = card === null ? null : store.getFlow(card.flow);
    const mine = question.askedOf === viewer;
    const cardLink = card === null || flow === null ? "a card" : `<a href="/flows/${flow.id}?card=${card.id}">${e(card.title)}</a>`;
    return `<article class="card teammate-question" data-question="${question.id}"><p class="meta">About ${cardLink} · ${when(question.createdAt)}${mine ? "" : ` · for ${e(question.askedOf)}`}</p><p><strong>${e(question.question)}</strong></p>` +
      (mine ? `<div class="question-options">${question.options.map(one => `<form method="post" action="/teammates/questions/${question.id}/answer">${hidden(csrf)}<input type="hidden" name="choice" value="${e(one.id)}"><button>${e(one.label)}</button></form>`).join("")}</div>` +
        `<form method="post" action="/teammates/questions/${question.id}/answer" class="question-reply">${hidden(csrf)}<label>Or answer in your words<textarea name="text" rows="2" maxlength="2000"></textarea></label><button>Answer</button></form>` : "") +
      `</article>`;
  }).join("");
  const zones = zonesOf(store, mate);
  const where = zones.length === 0
    ? `<p class="meta">Not on any zone yet. In a flow, choose ${e(name)} under “Who decides” on a “Person decides” zone, or add a “Teammate handles it” zone.</p>`
    : `<ul>${zones.map(one => `<li><a href="/flows/${one.flow}">${e(one.flowName)}</a> · ${one.kind === "decides" ? "decides" : "handles"} ${e(one.title)}</li>`).join("")}</ul>`;
  const events = store.teammateEvents(mate.id, 40).filter(one => one.kind !== "note");
  const activity = events.length === 0 ? `<p class="meta">Nothing yet.</p>` : `<ul class="teammate-activity">${events.map(one => {
    const card = one.card === null ? null : store.getFlowCard(one.card);
    return `<li data-event="${one.kind}">${e(one.said)}${card === null ? "" : ` · <a href="/flows/${card.flow}?card=${card.id}">open</a>`} <span class="meta">${when(one.at)}</span></li>`;
  }).join("")}</ul>`;
  const notes = store.teammateEvents(mate.id, 60).filter(one => one.kind === "note").slice(0, 10);
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
    canManage ? `<section class="card"><h2>Tell ${e(name)} something</h2><form method="post" action="/teammates/${mate.id}/note">${hidden(csrf)}<label class="sr-only" for="teammate-note">Note</label><textarea id="teammate-note" name="note" rows="2" maxlength="1000" placeholder="For example: this week, offer free shipping instead of a refund when you can."></textarea><button>Tell ${e(name)}</button></form>` +
      (notes.length === 0 ? "" : `<ul class="teammate-notes">${notes.map(one => `<li>${e(one.said)} <span class="meta">${e(one.by ?? "")} · ${when(one.at)}</span></li>`).join("")}</ul>`) + `</section>` : "",
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
