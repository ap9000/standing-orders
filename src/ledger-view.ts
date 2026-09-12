import type { LedgerEntry } from "./action-ledger.js";
import { projectName } from "./project.js";

const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function ledgerBody(rows: LedgerEntry[], projects: readonly string[], params: URLSearchParams): string {
  const selected = (key: string, value: string) => params.get(key) === value ? " selected" : "";
  const options = (key: string, values: readonly string[]) => values.map(value => `<option value="${html(value)}"${selected(key, value)}>${html(value)}</option>`).join("");
  const more = rows.length > 50;
  const shown = rows.slice(0, 50);
  const next = new URLSearchParams(params);
  next.delete("format");
  if (shown.length) next.set("before", String(shown.at(-1)!.id));
  const fresh = new URLSearchParams(params);
  fresh.delete("before"); fresh.delete("format");
  return `<style>.ledger-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end}.ledger-filters label{display:grid;gap:6px;min-width:0}.ledger-filters input,.ledger-filters select{width:100%;min-width:0;box-sizing:border-box}.ledger-event{overflow-wrap:anywhere}.ledger-event .meta{margin-bottom:0}.ledger-event .actor{color:inherit;text-decoration:none}</style><h1>Action ledger</h1>
<p>Who acted, what happened, and where the work stands. History is recorded from this upgrade onward.</p>
<form method="get" action="/ledger" class="card ledger-filters" aria-label="Filter action ledger">
<label>Project<select name="project"><option value="">All accessible projects</option>${projects.map(repo => `<option value="${html(repo)}"${selected("project", repo)}>${html(projectName(repo))}</option>`).join("")}</select></label>
<label>Person or worker<input type="text" name="actor" value="${html(params.get("actor") ?? "")}" placeholder="Any actor"></label>
<label>Events<select name="source"><option value="">All events</option>${options("source", ["work", "request", "access"])}</select></label>
<label>Outcome<input type="text" name="outcome" value="${html(params.get("outcome") ?? "")}" placeholder="Any outcome"></label>
<label>Task<input type="text" name="task" value="${html(params.get("task") ?? "")}" placeholder="Any task"></label>
<button type="submit">Filter</button><a href="/ledger">Clear</a></form>
<p class="meta">Accepted requests are separate from completed work. Worker events show the recorded result; review evidence remains on the task or run.</p>
<div aria-label="Action history">${shown.length === 0 ? `<p class="card">No actions match these filters yet.</p>` : shown.map(row => {
    const subject = row.runId !== null ? `<a href="/r/${row.runId}">Run #${row.runId}</a>` : row.taskId !== null ? `<a href="/t/${encodeURIComponent(row.taskId)}">${html(row.taskId)}</a>` : "";
    const byActor = new URLSearchParams(fresh); byActor.set("actor", row.actor);
    return `<article class="card ledger-event" data-ledger-id="${row.id}"><div class="row"><strong><a class="actor" href="/ledger?${html(byActor.toString())}" title="Filter by this actor">${html(row.actor)}</a></strong><span>${html(row.action)}</span><span class="badge">${html(row.outcome)}</span></div><p class="meta"><time datetime="${html(row.at)}">${html(row.at.slice(0, 19).replace("T", " ") + " UTC")}</time> · ${row.repo === null ? "Instance" : html(projectName(row.repo))}${subject ? ` · ${subject}` : ""} · ${html(row.source)}</p></article>`;
  }).join("")}</div>
<p class="row"><a href="/ledger?${html(fresh.toString())}">Newest actions</a>${more ? `<a rel="next" href="/ledger?${html(next.toString())}">Older actions</a>` : ""}</p>`;
}
