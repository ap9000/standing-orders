/** Flows in the console: the list of a person's flows, and one flow's canvas
 * (the React view's data, plus a plain fallback page the view replaces). */
import type { BrowserFlowCard, BrowserFlowTrigger, BrowserFlowView } from "./browser-workspace.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { describeTrigger, triggerHeadline, FLOW_TRIGGER_KINDS, FLOW_TRIGGER_WORDS, githubRepoOf, HOOK_PATH, hookReady, readHooksBase, readLinearKey, takesDeliveries, triggerConfigOf } from "./flow-triggers.js";
import { FLOW_COLORS, FLOW_KIND_WORDS, FLOW_STAGE_KINDS, FLOW_TEMPLATES } from "./flows.js";
import type { FlowCardRow, FlowRow, Store } from "./store.js";

const e = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const projectName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

export const FLOWS_CSS = `.flows{max-width:880px;min-width:0}.flows .card{padding:16px 18px;margin:12px 0}.flows .flow-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.flows .flow-row h2{font-size:1.05rem;margin:0}.flows .flow-counts{font-size:.85rem;color:var(--so-muted)}.flows form{display:grid;gap:10px;margin:0}.flows label{display:grid;gap:6px}.flows input,.flows select{box-sizing:border-box;width:100%;max-width:100%}.flows button{justify-self:start;min-height:44px}.flows .flow-fallback ol{padding-left:20px}.flows summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.flows .flow-buttons{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}@media(max-width:600px){.flows input,.flows select{font-size:16px}}`;

/** The flows a person can open, with how many cards wait in each, and the new-flow form. */
export function flowsListHtml(store: Store, flows: readonly FlowRow[], projects: readonly string[], csrf: string, canCreate: boolean, problem: string | null): string {
  const rows = flows.map(flow => {
    const cards = store.flowCards(flow.id, false);
    const definition = flowDefinitionOf(flow);
    const waiting = cards.filter(card => definition?.stages.find(one => one.id === card.stage)?.kind === "approval").length;
    const buttons = store.flowTriggers(flow.id).filter(one => one.state === "active").flatMap(one => { const config = triggerConfigOf(one); return config?.kind === "button" ? [{ id: one.id, label: config.label }] : []; });
    return `<article class="card"><div class="flow-row"><h2><a href="/flows/${flow.id}">${e(flow.name)}</a></h2><span class="flow-counts">${e(projectName(flow.repo))} · ${cards.length} card${cards.length === 1 ? "" : "s"} in progress${waiting > 0 ? ` · ${waiting} waiting for a decision` : ""}</span></div>` +
      (buttons.length === 0 ? "" : `<p class="flow-buttons">${buttons.map(one => `<a class="button-link" href="/flows/${flow.id}?start=${one.id}">${e(one.label)}</a>`).join(" ")}</p>`) + `</article>`;
  }).join("");
  const create = canCreate && projects.length > 0 ? `<details class="card"${flows.length === 0 ? " open" : ""}><summary>New flow</summary><form method="post" action="/flows/new"><input type="hidden" name="csrf" value="${e(csrf)}"><label>Name<input name="name" required maxlength="80" placeholder="for example: Bug fixes"></label><label>Project<select name="repo">${projects.map(repo => `<option value="${e(repo)}">${e(projectName(repo))}</option>`).join("")}</select></label><label>Start from<select name="template">${FLOW_TEMPLATES.map(one => `<option value="${e(one.id)}">${e(one.label)}: ${e(one.about)}</option>`).join("")}</select></label><button>Create flow</button></form></details>` : "";
  const intro = `<p class="meta">A flow is your process drawn as zones. Cards move through them: agents do the work, people approve, and the team hears about it.</p>` +
    (canCreate && projects.length > 0 ? `<p class="flow-chat">Describe how work should move and your lead drafts the flow for you to confirm, or start from a template below. <a href="/chat?draft=${encodeURIComponent("Make a flow for ")}">Describe it in chat</a></p>` : "");
  return `<section class="flows">${problem === null ? "" : `<p class="problem" role="alert">${e(problem)}</p>`}${intro}${rows || '<p class="meta">No flows yet.</p>'}${create}</section>`;
}

const historyText = (event: { fromStage: string | null; toStage: string; outcome: string; actor: string; note: string | null }, title: (id: string) => string): string => {
  const who = event.actor === "flow" ? "" : ` by ${event.actor}`;
  const note = event.note === null ? "" : `: ${event.note}`;
  switch (event.outcome) {
    case "created": return `Added to ${title(event.toStage)}${who}`;
    case "approved": return `Approved${who}${note}`;
    case "sent-back": return `Sent back to ${title(event.toStage)}${who}${note}`;
    case "fail": return `Moved to ${title(event.toStage)} after a problem${note}`;
    case "cancelled": return `Cancelled${who}`;
    case "ok": return `Moved on to ${title(event.toStage)}`;
    default: return `Moved to ${title(event.toStage)}${who}`;
  }
};

/** One flow's canvas for one person. */
export function flowView(store: Store, flow: FlowRow, viewer: { name: string; approver: boolean }, selectedCard: number | null, setup: { dir: string | null; repos: readonly string[]; startTrigger?: number | null } = { dir: null, repos: [] }): BrowserFlowView {
  const definition = flowDefinitionOf(flow);
  const stages = definition?.stages ?? [];
  const title = (id: string) => stages.find(one => one.id === id)?.title ?? id;
  const cards: BrowserFlowCard[] = store.flowCards(flow.id, true).filter(card => card.state === "active" || Date.now() - Date.parse(card.updatedAt) < 7 * 86_400_000).map((card: FlowCardRow) => {
    const stage = stages.find(one => one.id === card.stage);
    const task = card.task ?? card.primaryTask;
    const discussion = store.flowComments(card.id);
    const watchers = store.flowCardWatchers(card.id);
    const canDecide = viewer.approver && card.state === "active" && stage?.kind === "approval" && (stage.approver === null || stage.approver === viewer.name);
    // History reads moves and ownership together, newest first.
    const owned = discussion.filter(one => one.kind === "owner").map(one => ({ text: one.body === "" ? `${one.author} left it without an owner` : one.body === one.author ? `${one.author} took it on` : `${one.author} made ${one.body} the owner`, at: one.at }));
    const moves = store.flowEvents(card.id).map(event => ({ text: historyText(event, title), at: event.at }));
    return {
      id: card.id, title: card.title, description: card.description, stage: card.stage, state: card.state, waiting: card.waiting,
      task: task === null ? null : { id: task, href: `/t/${encodeURIComponent(task)}` },
      createdBy: card.createdBy, updatedAt: card.updatedAt,
      canDecide,
      outputs: Object.entries(card.outputs).map(([id, text]) => ({ stage: id, title: title(id), text })),
      history: [...moves, ...owned].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
      source: card.source,
      owner: card.owner, watchers, watching: watchers.includes(viewer.name),
      mine: card.owner === viewer.name || watchers.includes(viewer.name) || canDecide,
      comments: discussion.filter(one => one.kind === "comment").map(one => ({ id: one.id, author: one.author, body: one.body, mentions: one.mentions, at: one.at })),
    };
  });
  const triggers: BrowserFlowTrigger[] = store.flowTriggers(flow.id).map(trigger => {
    const config = triggerConfigOf(trigger);
    return {
      id: trigger.id, kind: trigger.kind, words: config === null ? "This trigger can't be read." : describeTrigger(config, store),
      ...(config === null ? { name: "Trigger", detail: "Can't be read" } : triggerHeadline(config, store)),
      zone: title(config?.zone ?? definition?.start ?? ""), zoneId: config?.zone ?? definition?.start ?? "", state: trigger.state, status: trigger.lastOutcome, statusAt: trigger.lastAt, failing: trigger.failures > 0,
      button: config?.kind === "button" ? { label: config.label, questions: config.questions } : null,
      hook: config !== null && takesDeliveries(config) ? { ready: hookReady(trigger, setup.dir), needsSecret: config.kind === "linear" } : null,
      checkable: (config?.kind === "github" || config?.kind === "linear") && config.delivery === "poll",
    };
  });
  return {
    kind: "flow",
    flow: { id: flow.id, name: flow.name, project: projectName(flow.repo), revision: flow.revision, href: `/flows/${flow.id}` },
    chatHref: `/chat?draft=${encodeURIComponent(`In the ${flow.name} flow, `)}`,
    triggers,
    triggerSetup: {
      kinds: FLOW_TRIGGER_KINDS.map(kind => ({ kind, label: FLOW_TRIGGER_WORDS[kind] })),
      githubRepo: githubRepoOf(flow.repo), linearKey: readLinearKey(setup.dir) !== null, hooksBase: readHooksBase(setup.dir), hooksPath: HOOK_PATH,
      otherFlows: store.listFlows(setup.repos).filter(one => one.id !== flow.id).map(one => ({ id: one.id, name: one.name, zones: (flowDefinitionOf(one)?.stages ?? []).map(stage => ({ id: stage.id, title: stage.title })) })),
    },
    startTrigger: setup.startTrigger ?? null,
    me: viewer.name,
    start: definition?.start ?? stages[0]?.id ?? "",
    stages,
    cards,
    selectedCard,
    canEdit: viewer.approver,
    approvers: store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, flow.repo)),
    kinds: FLOW_STAGE_KINDS.map(kind => ({ kind, label: FLOW_KIND_WORDS[kind].label, about: FLOW_KIND_WORDS[kind].about })),
    colors: [...FLOW_COLORS],
  };
}

/** The page the canvas replaces when scripts can't run: each zone and its cards, in order. */
export function flowFallbackHtml(view: BrowserFlowView): string {
  return `<section class="flows flow-fallback"><p class="meta">${e(view.flow.project)}</p><ol>${view.stages.map(stage => {
    const cards = view.cards.filter(card => card.stage === stage.id && card.state === "active");
    return `<li><strong>${e(stage.title)}</strong> · ${e(FLOW_KIND_WORDS[stage.kind].label)}${cards.length === 0 ? "" : `<ul>${cards.map(card => `<li>${e(card.title)}${card.waiting === null ? "" : ` — ${e(card.waiting)}`}</li>`).join("")}</ul>`}</li>`;
  }).join("")}</ol></section>`;
}
