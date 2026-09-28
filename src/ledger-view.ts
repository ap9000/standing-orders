import type { LedgerEntry } from "./action-ledger.js";
import { projectName } from "./project.js";

const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** The ledger's kinds of event, as the filter names them. */
const EVENT_KINDS = [["work", "Work"], ["request", "Requests"], ["access", "Access"], ["sign-in", "Sign-ins"], ["policy", "Policy changes"]] as const;

/** v103: the chain's state in one line, and (for an instance operator) a checkpoint to copy off the machine. */
export type LedgerChainView = {
  ok: boolean; entries: number; through: number | null; head: string; unsealed: number;
  problem: { id: number | null; what: string } | null;
  latest: { through: number; hash: string; at: string } | null;
  csrf: string | null;
  /** Today (UTC, YYYY-MM-DD): the audit export's default range ends here. */
  today: string;
};
function chainHtml(chain: LedgerChainView): string {
  const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const status = chain.ok
    ? `<p class="ledger-chain ok" data-ledger-chain="ok"><strong>Chain verified</strong> · ${chain.entries} entries through #${chain.through ?? 0} · head <code>${html(chain.head.slice(0, 16))}…</code></p>`
    : `<p class="ledger-chain problem" role="alert" data-ledger-chain="broken"><strong>Chain broken</strong> · ${html(chain.problem?.what ?? "the chain doesn't verify")}</p>`;
  const latest = chain.latest === null ? "" : `<p class="meta ledger-checkpoint">Latest checkpoint (${html(chain.latest.at.slice(0, 16).replace("T", " "))} UTC), copy it somewhere outside this machine: <code class="ledger-checkpoint-value">${chain.latest.through}:${html(chain.latest.hash)}</code></p>`;
  const make = chain.csrf === null ? "" : `<form method="post" action="/ledger/checkpoint" class="ledger-checkpoint-form"><input type="hidden" name="csrf" value="${html(chain.csrf)}"><button type="submit">Make a checkpoint</button></form>`;
  const start = new Date(Date.parse(`${chain.today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const exportForm = `<details class="ledger-filter-panel"><summary>Audit export</summary><form method="get" action="/ledger/export" class="ledger-filters ledger-export" aria-label="Audit export">` +
    `<label>From<input type="date" name="from" value="${html(start)}" required></label><label>To<input type="date" name="to" value="${html(chain.today)}" required></label>` +
    `<button type="submit">Download</button></form><p class="meta">Every entry in the range with its seal, and an evidence pack for each task it names. JSON.</p></details>`;
  return `<section class="ledger-chain-panel" aria-label="Ledger integrity">${status}${latest}${make}${exportForm}</section>`;
}

export function ledgerBody(rows: LedgerEntry[], projects: readonly string[], params: URLSearchParams, chain?: LedgerChainView): string {
  const selected = (key: string, value: string) => params.get(key) === value ? " selected" : "";
  const more = rows.length > 50;
  const shown = rows.slice(0, 50);
  const fresh = new URLSearchParams();
  for (const key of ["project", "actor", "source", "outcome", "task"]) {
    const value = params.get(key); if (value) fresh.set(key, value);
  }
  const next = new URLSearchParams(fresh);
  if (shown.length) next.set("before", String(shown.at(-1)!.id));
  const csv = new URLSearchParams(fresh); csv.set("format", "csv");
  return `<style>
.ledger-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.ledger-heading h1{margin:0}.ledger-caption{margin:8px 0 12px}
.ledger-filter-panel{margin-bottom:12px}.ledger-filter-panel summary{font-size:13px;padding:6px 0;cursor:pointer}.ledger-filters{display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) auto auto;gap:8px;align-items:end;margin:0 0 12px}.ledger-filters label{display:grid;gap:3px;min-width:0;font-size:12px}.ledger-filters input,.ledger-filters select{width:100%;min-width:0;box-sizing:border-box;margin:0;padding:6px 8px;font-size:13px}.ledger-filters button{padding:7px 12px}.ledger-filters>a{padding:8px 0;font-size:13px}
.ledger-detail{display:block;color:var(--muted-foreground);font-size:12px}.ledger-list{border:1px solid var(--border);border-radius:8px;overflow:hidden}.ledger-event{display:grid;grid-template-columns:140px minmax(90px,1fr) minmax(160px,2fr) minmax(100px,1fr) minmax(100px,1fr);gap:8px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--border);font-size:13px;line-height:1.4;overflow-wrap:anywhere}.ledger-event:last-child{border-bottom:0}.ledger-event .actor{color:inherit;font-weight:600;text-decoration:none}.ledger-time,.ledger-place,.ledger-result small{font-size:11px;color:var(--muted-foreground)}.ledger-time time{font-variant-numeric:tabular-nums}.ledger-place a{display:block}.ledger-result small{display:block}.ledger-labels{font-size:11px;color:var(--muted-foreground);font-weight:600}.ledger-empty{padding:12px}
@media(max-width:1000px){.ledger-filters{grid-template-columns:repeat(3,minmax(0,1fr)) auto}.ledger-event{grid-template-columns:122px minmax(80px,1fr) minmax(130px,2fr) minmax(85px,1fr)}.ledger-place{grid-column:2/4}.ledger-result{grid-column:4;grid-row:1/3}.ledger-labels{display:none}}
@media(max-width:600px){.ledger-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.ledger-event{grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:8px 10px}.ledger-actor{grid-column:1;grid-row:1}.ledger-action{grid-column:1;grid-row:2}.ledger-result{grid-column:2;grid-row:1/3;text-align:right}.ledger-time{grid-column:1;grid-row:3}.ledger-place{grid-column:2;grid-row:3;text-align:right}.ledger-place a{display:inline}.ledger-heading>a{font-size:13px}}
.ledger-chain-panel{margin:0 0 12px}.ledger-chain{margin:0 0 4px;font-size:13px}.ledger-chain.ok strong{color:var(--success)}.ledger-checkpoint code{overflow-wrap:anywhere;user-select:all}.ledger-checkpoint-form{margin:6px 0 0}.ledger-export{grid-template-columns:repeat(2,minmax(0,180px)) auto;margin-bottom:4px}
</style><div class="ledger-heading"><h1>Action ledger</h1><a href="/ledger?${html(csv.toString())}" download>Export CSV</a></div>${chain === undefined ? "" : chainHtml(chain)}
<p class="meta ledger-caption">${shown.length} actions on this page · CSV includes all matching actions · Times in UTC</p>
<details class="ledger-filter-panel"><summary>Filters · ${fresh.size === 0 ? "all actions" : `${fresh.size} active`}</summary>
<form method="get" action="/ledger" class="ledger-filters" aria-label="Filter action ledger">
<label>Project<select name="project"><option value="">All accessible projects</option>${projects.map(repo => `<option value="${html(repo)}"${selected("project", repo)}>${html(projectName(repo))}</option>`).join("")}</select></label>
<label>Person or worker<input type="text" name="actor" value="${html(params.get("actor") ?? "")}" placeholder="Any actor"></label>
<label>Events<select name="source"><option value="">All events</option>${EVENT_KINDS.map(([value, label]) => `<option value="${value}"${selected("source", value)}>${label}</option>`).join("")}</select></label>
<label>Outcome<input type="text" name="outcome" value="${html(params.get("outcome") ?? "")}" placeholder="Any outcome"></label>
<label>Task<input type="text" name="task" value="${html(params.get("task") ?? "")}" placeholder="Any task"></label>
<button type="submit">Filter</button><a href="/ledger">Clear</a></form></details>
<div class="ledger-list" aria-label="Action history"><div class="ledger-event ledger-labels" aria-hidden="true"><span>Time (UTC)</span><span>Actor</span><span>Action</span><span>Project / work</span><span>Outcome / event</span></div>${shown.length === 0 ? `<p class="ledger-empty">No actions match these filters yet.</p>` : shown.map(row => {
    const subject = row.runId !== null ? `<a href="/r/${row.runId}">Run #${row.runId}</a>` : row.taskId !== null ? `<a href="/t/${encodeURIComponent(row.taskId)}">${html(row.taskId)}</a>` : "";
    const byActor = new URLSearchParams(fresh); byActor.set("actor", row.actor);
    return `<article class="ledger-event" data-ledger-id="${row.id}"><div class="ledger-time"><time datetime="${html(row.at)}" title="${html(row.at)}">${html(row.at.slice(0, 19).replace("T", " "))}</time></div><div class="ledger-actor"><a class="actor" href="/ledger?${html(byActor.toString())}" title="Filter by this actor">${html(row.actor)}</a></div><div class="ledger-action">${html(row.action)}${row.detail === null ? "" : `<small class="ledger-detail">${html(row.detail)}</small>`}</div><div class="ledger-place">${row.repo === null ? "Instance" : html(projectName(row.repo))} ${subject}</div><div class="ledger-result">${html(row.outcome)}<small>${html(row.source)}</small></div></article>`;
  }).join("")}</div>
<p class="row"><a href="/ledger?${html(fresh.toString())}">Newest actions</a>${more ? `<a rel="next" href="/ledger?${html(next.toString())}">Older actions</a>` : ""}</p>
<p class="meta">Accepted requests record acceptance; worker events record results. History starts from this upgrade. Review evidence is on each task or run.</p>`;
}
