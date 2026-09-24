/**
 * The flow engine: moves cards through their flow's zones. Deterministic
 * and model-free — it runs in a worker's pass beside routines, files work
 * through the ordinary task door (so every approval and check a task needs
 * still applies), reads task state, posts messages through the outbox, and
 * waits for people. See flows.ts for what each zone does.
 */
import { assignmentOf } from "./assignment.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { fillFlowText, validateFlowDefinition, type FlowDefinition, type FlowStage } from "./flows.js";
import { reportSummaryFor } from "./report-summary.js";
import { fileTaskProposal } from "./proposal.js";
import { requestResultChanges } from "./result-actions.js";
import { revisionSourceOf } from "./result-review.js";
import { scanForSecrets } from "./evidence.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";
import type { FlowCardRow, FlowRow, Store } from "./store.js";

export type FlowAdvance = { moved: number; filed: string[]; problems: string[] };

/** The flow's drawing, or null when it can't be read (the card then says so and waits). */
export function flowDefinitionOf(flow: FlowRow): FlowDefinition | null {
  try { return validateFlowDefinition(JSON.parse(flow.definitionJson)); } catch { return null; }
}

/** Where a card's link opens: the flow's canvas with the card selected. */
export const flowCardHref = (flow: number, card: number) => `/flows/${flow}?card=${card}`;
/** Where a confirmed flow action may point: a flow's canvas, maybe with one card open. */
export const FLOW_HREF = /^\/flows\/[1-9][0-9]{0,9}(\?card=[1-9][0-9]{0,9})?$/;

const ACCEPTANCE = {
  report: [{ id: "c1", statement: "The report answers the request, citing where in the repository each point comes from", how: null, evidence: ["manual-review"] }],
  task: [{ id: "c1", statement: "The requested change is made and the project's existing checks still pass", how: null, evidence: ["manual-review"] }],
};

function fill(template: string, card: FlowCardRow): string {
  return fillFlowText(template, { title: card.title, description: card.description, note: card.note, outputs: card.outputs });
}

const titleIn = (definition: FlowDefinition, id: string) => definition.stages.find(one => one.id === id)?.title ?? id;

/** Advance every active card in one project's flows. */
export function advanceFlows(store: Store, repo: string, now: Date, options: { evidenceRoot?: string } = {}): FlowAdvance {
  const outcome: FlowAdvance = { moved: 0, filed: [], problems: [] };
  const flows = new Map<number, { flow: FlowRow; definition: FlowDefinition | null }>();
  for (const card of store.activeFlowCards(repo)) {
    let entry = flows.get(card.flow);
    if (entry === undefined) {
      const flow = store.getFlow(card.flow);
      if (flow === null) continue;
      entry = { flow, definition: flowDefinitionOf(flow) };
      flows.set(card.flow, entry);
    }
    try {
      advanceCard(store, entry.flow, entry.definition, card, now, options, outcome);
    } catch (error) {
      outcome.problems.push(`flow card ${card.id}: ${error instanceof Error ? error.message : "could not advance"}`);
    }
  }
  return outcome;
}

function advanceCard(store: Store, flow: FlowRow, definition: FlowDefinition | null, card: FlowCardRow, now: Date, options: { evidenceRoot?: string }, outcome: FlowAdvance): void {
  if (definition === null) { store.updateFlowCard(card.id, { waiting: "This flow's drawing can't be read. Open the flow and save it again." }, now); return; }
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined) {
    // The zone was removed while the card sat in it: back to the start.
    if (store.moveFlowCard(card.id, { to: definition.start, outcome: "moved", actor: "flow", note: null, expectEntry: card.entry }, now)) outcome.moved++;
    return;
  }
  const onward = (result: "ok" | "fail", note?: string | null, task?: string | null): void => {
    const to = result === "ok" ? stage.next : stage.onFail;
    if (to === null) {
      if (result === "ok" && stage.next === null) store.updateFlowCard(card.id, { waiting: "Finished here. Move the card on when you're ready." }, now);
      return;
    }
    if (store.moveFlowCard(card.id, { to, outcome: result, actor: "flow", ...(note === undefined ? {} : { note }), ...(task === undefined ? {} : { task }), expectEntry: card.entry }, now)) {
      outcome.moved++;
      if (result === "fail" && card.owner !== null) notifyPeople(store, card, [card.owner], null, { key: `failed:${card.entry}`, subject: `“${card.title}” went back to ${titleIn(definition, to)}`, body: `${note ?? "Its step didn't finish."} It's in ${titleIn(definition, to)} now.`, attention: true }, now);
    }
  };
  switch (stage.kind) {
    case "inbox":
      if (card.waiting !== null) store.updateFlowCard(card.id, { waiting: null }, now);
      return;
    case "done":
      store.updateFlowCard(card.id, { state: "done", waiting: null }, now);
      notifyPeople(store, card, cardFollowers(store, card), null, { key: `done:${card.entry}`, subject: `Done: “${card.title}”`, body: `“${card.title}” reached ${stage.title} in ${flow.name}.` }, now);
      return;
    case "notify": {
      const message = fill(stage.message ?? card.title, card);
      store.enqueueNotification({
        dedupeKey: `flow:${card.id}:${card.entry}`, kind: "flow-message",
        subject: `${flow.name}: ${message}`.slice(0, 200), body: `${message}\n\nCard: ${card.title}`.slice(0, 2000),
        link: flowCardHref(flow.id, card.id), source: { project: flow.repo },
      }, now);
      onward("ok");
      return;
    }
    case "approval": {
      const who = stage.approver ?? "an approver";
      if (card.waiting === null) {
        // A named decider hears it alone; "anyone who approves" pages everyone who can.
        store.enqueueNotification({
          dedupeKey: `flow-decide:${card.id}:${card.entry}`, kind: "flow-decision", pushClass: "attention", ...(stage.approver === null ? {} : { recipient: stage.approver }),
          subject: `${flow.name}: ${card.title} needs ${stage.approver === null ? "a decision" : `${stage.approver}'s decision`}`.slice(0, 200),
          body: `${stage.title}: approve it, or send it back with a note.`, link: flowCardHref(flow.id, card.id), source: { project: flow.repo },
        }, now);
        store.updateFlowCard(card.id, { waiting: `Waiting for ${who} to approve or send it back` }, now);
      }
      return;
    }
    case "task":
    case "report":
      workStage(store, flow, stage, card, now, options, outcome, onward);
      return;
  }
}

function workStage(store: Store, flow: FlowRow, stage: FlowStage, card: FlowCardRow, now: Date, options: { evidenceRoot?: string }, outcome: FlowAdvance, onward: (result: "ok" | "fail", note?: string | null, task?: string | null) => void): void {
  if (card.task === null) {
    const report = stage.kind === "report";
    const filed = fileTaskProposal(store, {
      title: (report ? `${stage.title}: ${card.title}` : card.title).slice(0, 200),
      repo: flow.repo,
      goal: fill(stage.instructions ?? card.title, card).slice(0, 8000),
      filedVia: `flow:${flow.id}`,
      deliverable: report ? "report" : "branch",
      planning: report ? "skip" : stage.planning ?? "auto",
      acceptance: report ? ACCEPTANCE.report : ACCEPTANCE.task,
      admittedRepos: [flow.repo],
    }, now);
    if (!filed.ok) { store.updateFlowCard(card.id, { waiting: `Couldn't file the work: ${filed.message}` }, now); return; }
    store.updateFlowCard(card.id, { task: filed.id, ...(report || card.primaryTask !== null ? {} : { primaryTask: filed.id }), waiting: "Filed as a task" }, now);
    outcome.filed.push(filed.id);
    return;
  }
  // A send back may have made a revision: follow the task's current version.
  const family = store.taskFamilyOf(card.task, [flow.repo], false);
  const current = family?.current.id ?? card.task;
  const task = store.getTask(current);
  if (task === null) { store.updateFlowCard(card.id, { waiting: "Its task is gone. Move the card to try again." }, now); return; }
  if (task.state === "done") {
    const outputs = { ...card.outputs };
    if (stage.kind === "report") {
      const ref = store.lookupRef(current);
      const summary = ref === null ? null : reportSummaryFor(store, options.evidenceRoot, ref.id);
      outputs[stage.id] = summary !== null && "summary" in summary ? summary.summary.slice(0, 6000) : "The report is ready on its task.";
    } else {
      outputs[stage.id] = `Result ready on task ${current}.`;
    }
    store.updateFlowCard(card.id, { outputs, ...(stage.kind === "task" ? { primaryTask: current } : {}), waiting: null }, now);
    onward("ok");
    return;
  }
  if (task.state === "failed" || task.state === "cancelled") {
    if (stage.onFail !== null) onward("fail", `The ${stage.kind === "report" ? "research" : "build"} ${task.state === "failed" ? "failed" : "was cancelled"}.`);
    else {
      const waiting = `The task ${task.state === "failed" ? "failed" : "was cancelled"}. Retry it, or move the card.`;
      if (card.waiting !== waiting && card.owner !== null) notifyPeople(store, card, [card.owner], null, { key: `stuck:${card.entry}`, subject: `“${card.title}” is stuck in ${stage.title}`, body: waiting, attention: true }, now);
      store.updateFlowCard(card.id, { waiting }, now);
    }
    return;
  }
  const diagnosis = diagnoseTaskDispatch(store, current, now);
  const waiting = diagnosis?.summary ?? "Working on it";
  if (waiting !== card.waiting) store.updateFlowCard(card.id, { waiting }, now);
}

export type FlowAct = { ok: true; said: string; card: number } | { ok: false; message: string };

const zoneWords = (title: string) => `${title}${/[.?!]$/.test(title) ? "" : "."}`;

/** A card's words, checked once for every door: a title, an optional description, and no keys, because cards become agent instructions. */
export function flowCardText(title: unknown, description: unknown): { title: string; description: string | null } | { problem: string } {
  const cleanTitle = (typeof title === "string" ? title : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  const cleanDescription = (typeof description === "string" ? description : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000) || null;
  if (cleanTitle === "") return { problem: "Give the card a title." };
  if (scanForSecrets(`${cleanTitle}\n${cleanDescription ?? ""}`).length > 0) return { problem: "That looks like a key or password. Cards become agent instructions; keep secrets out of them." };
  return { title: cleanTitle, description: cleanDescription };
}

/** Add a card to a flow, in its start zone unless a zone is named. */
export function addCardToFlow(store: Store, flow: FlowRow, input: { title: unknown; description: unknown; stage: string | null }, actor: string, now: Date): FlowAct {
  const definition = flowDefinitionOf(flow);
  if (definition === null || flow.state !== "active") return { ok: false, message: "This flow can't take cards right now." };
  const text = flowCardText(input.title, input.description);
  if ("problem" in text) return { ok: false, message: text.problem };
  const stage = definition.stages.find(one => one.id === input.stage) ?? definition.stages.find(one => one.id === definition.start)!;
  const card = store.addFlowCard({ flow: flow.id, title: text.title, description: text.description, stage: stage.id, by: actor }, now);
  // Whoever adds a card follows it; owning it is a separate, deliberate step.
  store.setFlowCardWatcher(card, actor, true, now);
  return { ok: true, said: `Card added to ${zoneWords(stage.title)}`, card };
}

/** Move a card to another zone of its flow by hand; the zone's step runs on the next pass. */
export function moveCardInFlow(store: Store, card: FlowCardRow, to: string, actor: string, now: Date): FlowAct {
  const flow = store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  const stage = definition?.stages.find(one => one.id === to);
  if (stage === undefined) return { ok: false, message: "Choose a zone in this flow." };
  if (card.state !== "active") return { ok: false, message: "That card is finished." };
  if (to === card.stage) return { ok: true, said: "Already there.", card: card.id };
  if (!store.moveFlowCard(card.id, { to, outcome: "moved", actor, expectEntry: card.entry }, now)) return { ok: false, message: "That card just moved. Look again." };
  if (card.owner !== null) notifyPeople(store, card, [card.owner], actor, { key: `moved:${card.entry}`, subject: `${actor} moved “${card.title}” to ${stage.title}`, body: `It was in ${definition!.stages.find(one => one.id === card.stage)?.title ?? "another zone"}.` }, now);
  return { ok: true, said: `Moved to ${zoneWords(stage.title)}`, card: card.id };
}

/** Take a card out of its flow; the tasks it filed are left as they are. */
export function cancelFlowCard(store: Store, card: FlowCardRow, actor: string, now: Date): FlowAct {
  if (card.state !== "active") return { ok: false, message: "That card is already finished." };
  store.moveFlowCard(card.id, { to: card.stage, outcome: "cancelled", actor }, now);
  store.updateFlowCard(card.id, { state: "cancelled", waiting: null }, now);
  return { ok: true, said: "Card cancelled. Its tasks are unchanged.", card: card.id };
}

export type FlowDecision = { ok: true; said: string } | { ok: false; message: string };

/** A person's decision on a card waiting in an approval zone. A send back to a build zone whose work has a result becomes a revision of that work. */
export function decideFlowCard(store: Store, input: { card: number; decision: "approve" | "send-back"; note: string | null; actor: string; repos: readonly string[]; evidenceRoot?: string }, now: Date): FlowDecision {
  const card = store.getFlowCard(input.card);
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (card === null || flow === null || definition === null || card.state !== "active" || !input.repos.includes(flow.repo)) return { ok: false, message: "That card is no longer waiting." };
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined || stage.kind !== "approval") return { ok: false, message: "That card isn't waiting for a decision." };
  if (stage.approver !== null && stage.approver !== input.actor) return { ok: false, message: `Only ${stage.approver} decides here.` };
  if (input.decision === "approve") {
    if (stage.next === null) {
      store.updateFlowCard(card.id, { state: "done", waiting: null }, now);
      return { ok: true, said: "Approved. The card is done." };
    }
    store.moveFlowCard(card.id, { to: stage.next, outcome: "approved", actor: input.actor, note: input.note, expectEntry: card.entry }, now);
    const title = definition.stages.find(one => one.id === stage.next)?.title ?? stage.next;
    if (card.owner !== null) notifyPeople(store, card, [card.owner], input.actor, { key: `approved:${card.entry}`, subject: `${input.actor} approved “${card.title}”`, body: `${stage.title}: approved. It moves to ${title}.${input.note === null || input.note.trim() === "" ? "" : `\n\n${input.note.trim()}`}` }, now);
    return { ok: true, said: `Approved. Moved to ${title}${/[.?!]$/.test(title) ? "" : "."}` };
  }
  if (stage.onFail === null) return { ok: false, message: "This zone has nowhere to send work back to." };
  if (input.note === null || input.note.trim() === "") return { ok: false, message: "Say what should change." };
  const target = definition.stages.find(one => one.id === stage.onFail);
  // Back to a build zone with a finished result: a revision of that same work, carrying the note.
  let revision: string | null = null;
  if (target?.kind === "task" && card.primaryTask !== null && input.evidenceRoot !== undefined) {
    const snapshot = assignmentOf(store, card.primaryTask, now, { principal: "operator", repos: input.repos });
    const runId = snapshot?.receipt?.runId;
    const runTask = runId === undefined ? null : store.externalIdFor(store.getRun(runId)?.taskRef ?? -1);
    if (runId !== undefined && runTask !== null) {
      const revised = requestResultChanges(store, input.evidenceRoot, {
        run: runId, source: revisionSourceOf(store.getScope(runTask)?.digest ?? null), actor: input.actor, repos: input.repos,
        batch: "", note: input.note.trim(), path: "", line: "", request: `flow-${card.id}-${card.entry}`, allowMode: true,
      }, now);
      if (revised.ok) revision = revised.id;
    }
  }
  store.moveFlowCard(card.id, { to: stage.onFail, outcome: "sent-back", actor: input.actor, note: input.note.trim(), ...(revision === null ? {} : { task: revision }), expectEntry: card.entry }, now);
  if (card.owner !== null) notifyPeople(store, card, [card.owner], input.actor, { key: `sent-back:${card.entry}`, subject: `${input.actor} sent “${card.title}” back`, body: `Sent back to ${target?.title ?? stage.onFail}:\n\n${input.note.trim()}`, attention: true }, now);
  return { ok: true, said: revision === null ? `Sent back to ${target?.title ?? stage.onFail} with your note.` : `Sent back to ${target?.title ?? stage.onFail}: a revision was made with your note.` };
}
