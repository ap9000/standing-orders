/**
 * A teammate's turn on a card (v92), run by the flow step pass.
 *
 * The turn reads the zone, the card (as data) and what its people told it,
 * and answers with one decision (teammates.ts). This carries the decision
 * out within the zone's own choices, and writes it down — what it did and
 * why — in the card's history and the teammate's log:
 *
 * - "Person decides" zone: approve (the draft as written, or as it rewrote
 *   it), send back with a note, or hand it to the zone's person, whose
 *   decision then arrives in their chat app as always.
 * - "Teammate handles it" zone: pick one of the zone's answers (its text is
 *   kept for the next zones), ask its person a question and wait for the
 *   answer, or say it can't and take the failure path.
 */
import type { FlowCardRow, FlowRow, Store, TeammateRow } from "./store.js";
import type { FlowDefinition, FlowStage } from "./flows.js";
import { decideFlowCard, draftFor, flowCardHref } from "./flow-engine.js";
import { keptDraft } from "./flow-draft.js";
import { notifyPeople } from "./flow-people.js";
import { claudeTurnRunner, parseSoul, readTurn, teammateActor, teammateLabel, TURN_TIMEOUT_MS, turnPrompt, type TurnAnswer, type TurnContext, type TurnRunner } from "./teammates.js";

/** A question waits for its answer this long before the step is due again on its own: never, in practice. */
export const ASKED = "9999-12-31T00:00:00.000Z";
/** What "handle" zones with no answers of their own offer: going on to the next zone. */
const CARRY_ON = "Carry on";

export type TeammateOutcome = { state: "passed" | "failed" | "retry" | "waiting"; said: string; log?: string; decisionJson?: string; nextAt?: string };

const startOfDay = (now: Date) => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.toISOString(); };

/** Whether a teammate can take a turn now: active, readable, and under its daily limit. */
export function teammateReady(store: Store, mate: TeammateRow | null, now: Date): { ok: true } | { ok: false; why: string } {
  if (mate === null) return { ok: false, why: "gone" };
  if (mate.state !== "active") return { ok: false, why: "paused" };
  if (!parseSoul(mate.soul).ok) return { ok: false, why: "its soul file can't be read" };
  if (store.teammateTurnsSince(mate.id, startOfDay(now)) >= mate.dailyTurns) return { ok: false, why: `it reached today's limit of ${mate.dailyTurns} turns` };
  return { ok: true };
}

/** The answers a "Teammate handles it" zone offers, each with the zone it leads to. */
export function handleAnswers(stage: FlowStage): { answer: string; to: string | null }[] {
  return stage.routes !== undefined && stage.routes.length > 0 ? stage.routes : [{ answer: CARRY_ON, to: stage.next }];
}

/** Everything the turn is told. */
function contextOf(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow): TurnContext {
  const soul = parseSoul(mate.soul);
  if (!soul.ok) throw new Error(soul.problem);
  const title = (id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
  const draft = stage.kind === "approval" ? draftFor(definition, stage) : null;
  const question = store.teammateQuestionFor(card.id, card.entry);
  const notes = store.teammateEvents(mate.id, 40).filter(one => one.kind === "note").slice(0, 10).reverse();
  return {
    soul: mate.soul, name: soul.soul.name, role: soul.soul.role, flow: flow.name, zone: stage.title, kind: stage.kind === "approval" ? "decide" : "handle",
    instructions: stage.instructions, draft: draft === null ? null : card.outputs[draft.id] ?? null, canSendBack: stage.onFail !== null,
    person: stage.kind === "approval" ? (stage.toOwner === true ? flow.owner : stage.approver ?? flow.owner) : flow.owner,
    answers: handleAnswers(stage).map(one => one.answer),
    card: {
      title: card.title, description: card.description, source: card.source?.label ?? null,
      earlier: definition.stages.filter(one => one.id !== stage.id && card.outputs[one.id] !== undefined).map(one => ({ zone: one.title, text: card.outputs[one.id]! })),
      discussion: store.flowComments(card.id).filter(one => one.kind === "comment").slice(-10).map(one => ({ by: one.author.includes("@") ? `${one.author} (by email)` : one.author, text: one.body })),
      history: store.flowEvents(card.id).slice(-8).map(one => `${one.outcome} → ${title(one.toStage)}${one.note === null ? "" : `: ${one.note}`}`),
    },
    asked: question !== null && question.state === "answered" ? [{ question: question.question, answer: [question.choice === null ? null : question.options.find(one => one.id === question.choice)?.label ?? question.choice, question.answer].filter(Boolean).join(" — ") }] : [],
    notes: notes.map(one => ({ by: one.by ?? "your manager", text: one.said })),
  };
}

/** Run one teammate turn on a card and carry out what it decided. */
export async function teammateTurn(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, now: Date,
  io: { turn?: TurnRunner; evidenceRoot?: string }): Promise<TeammateOutcome> {
  const context = contextOf(store, flow, definition, stage, card, mate);
  const config = store.getChatConfig();
  const model = mate.model ?? (config?.provider === "claude-subscription" ? config.model : "default");
  const reply = await (io.turn ?? claudeTurnRunner())({ model, prompt: turnPrompt(context), timeoutMs: TURN_TIMEOUT_MS });
  if (!reply.ok) return { state: "retry", said: reply.said };
  const answer = readTurn(reply.value, context);
  if (answer === null) return { state: "retry", said: `${context.name}'s answer wasn't one this zone allows.`, log: JSON.stringify(reply.value).slice(0, 4000) };
  return carryOut(store, flow, definition, stage, card, mate, context, answer, now, io, `${context.name} (${model}) · ${(reply.ms / 1000).toFixed(1)} s`);
}

function carryOut(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, context: TurnContext, answer: TurnAnswer, now: Date,
  io: { evidenceRoot?: string }, header: string): TeammateOutcome {
  const soul = { name: context.name, role: context.role };
  const actor = teammateActor(soul), label = teammateLabel(soul);
  const decisionJson = JSON.stringify(answer);
  const log = `${header}\n\n${decisionJson}`;
  const event = (kind: "decided" | "handled" | "handed" | "asked", said: string) =>
    store.addTeammateEvent({ teammate: mate.id, card: card.id, entry: card.entry, kind, said, detail: { flow: flow.id, zone: stage.id, action: answer.action, reason: answer.reason } }, now);
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "the next zone";
  const repos = [flow.repo];
  if (answer.action === "approve" || answer.action === "send_back") {
    const draft = draftFor(definition, stage);
    const decided = decideFlowCard(store, {
      card: card.id, decision: answer.action === "approve" ? "approve" : "send-back", note: answer.action === "approve" ? answer.reason || null : answer.note, actor, repos, teammate: mate.handle, entry: card.entry,
      ...(answer.action === "approve" && draft !== null && answer.text !== "" ? { draft: keptDraft(answer.text) } : {}),
      ...(io.evidenceRoot === undefined ? {} : { evidenceRoot: io.evidenceRoot }),
    }, now);
    if (!decided.ok) return { state: "failed", said: decided.message, log, decisionJson };
    const said = answer.action === "approve" ? `Approved “${card.title}”${answer.reason === "" ? "" : `: ${answer.reason}`}` : `Sent “${card.title}” back: ${answer.note}`;
    event("decided", said);
    return { state: "passed", said, log, decisionJson };
  }
  if (answer.action === "hand_off") {
    event("handed", `Handed “${card.title}” to ${context.person}${answer.note === "" ? "" : `: ${answer.note}`}`);
    // The engine sees the hand-off (a passed turn in the same visit) and asks the person, with this note.
    return { state: "passed", said: `Handed to ${context.person}`, log, decisionJson };
  }
  if (answer.action === "ask") {
    const options = answer.options.map((label, at) => ({ id: `o${at + 1}`, label }));
    const opened = store.openTeammateQuestion({ teammate: mate.id, card: card.id, entry: card.entry, question: answer.question, options, askedOf: context.person }, now);
    if (opened === null) return { state: "failed", said: "It asked twice about the same visit.", log, decisionJson };
    event("asked", `Asked ${context.person} about “${card.title}”: ${answer.question}`);
    notifyPeople(store, card, [context.person], null, { key: `teammate-q:${opened}`, attention: true, subject: `${label} asks about “${card.title}”`,
      body: `${answer.question}${options.length === 0 ? "" : `\n\n${options.map(one => `• ${one.label}`).join("\n")}`}${answer.reason === "" ? "" : `\n\n(${answer.reason})`}\n\nOpen the card to answer, or tell your lead in chat.`,
    }, now);
    store.updateFlowCard(card.id, { waiting: `${context.name} asked ${context.person}: ${answer.question}`.slice(0, 300) }, now);
    return { state: "waiting", said: `Asked ${context.person}`, log, decisionJson, nextAt: ASKED };
  }
  if (answer.action === "cant") {
    event("handled", `Couldn't handle “${card.title}”: ${answer.note}`);
    if (stage.onFail !== null) store.moveFlowCard(card.id, { to: stage.onFail, outcome: "fail", actor, note: answer.note || null, expectEntry: card.entry }, now);
    else store.updateFlowCard(card.id, { waiting: `${context.name} couldn't handle it: ${answer.note}`.slice(0, 300) }, now);
    return { state: "failed", said: answer.note || "It couldn't handle this card.", log, decisionJson };
  }
  // route: the answer names where the card goes; its text is what the next zones use.
  const picked = handleAnswers(stage).find(one => one.answer.toLowerCase() === answer.answer.toLowerCase())!;
  if (answer.text !== "") store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: keptDraft(answer.text) } }, now);
  const said = `Sent “${card.title}” to ${titleOf(picked.to)}${picked.answer === CARRY_ON ? "" : ` (${picked.answer})`}${answer.reason === "" ? "" : `: ${answer.reason}`}`;
  event("handled", said);
  if (picked.to === null) store.updateFlowCard(card.id, { waiting: "Finished here. Move the card on when you're ready." }, now);
  else store.moveFlowCard(card.id, { to: picked.to, outcome: "ok", actor, historyNote: `${actor}: ${picked.answer === CARRY_ON ? "" : `${picked.answer}. `}${answer.reason}`.trim(), expectEntry: card.entry }, now);
  return { state: "passed", said, log, decisionJson };
}

/** A person answers a teammate's question: once, by the person it was asked of; the card's turn is due again. */
export function answerTeammateQuestion(store: Store, id: number, answer: { choice: string | null; text: string | null; by: string; via: string }, now: Date): { ok: true; said: string } | { ok: false; said: string } {
  return store.transact(() => {
    const question = store.teammateQuestion(id);
    if (question === null || question.state !== "open") return { ok: false as const, said: "That question was already answered." };
    if (question.askedOf !== answer.by) return { ok: false as const, said: `Only ${question.askedOf} can answer this one.` };
    const choice = answer.choice === null ? null : question.options.find(one => one.id === answer.choice) ?? null;
    const text = answer.text?.trim().slice(0, 2000) || null;
    if (choice === null && text === null) return { ok: false as const, said: "Pick an answer or write one." };
    store.answerTeammateQuestion(id, { choice: choice?.id ?? null, text, by: answer.by, via: answer.via }, now);
    const card = store.getFlowCard(question.card);
    store.addTeammateEvent({ teammate: question.teammate, card: question.card, entry: question.entry, kind: "answered", said: `${answer.by}: ${[choice?.label, text].filter(Boolean).join(" — ")}`, by: answer.by }, now);
    if (card !== null && card.state === "active" && card.entry === question.entry) {
      store.updateFlowCard(card.id, { waiting: null }, now);
      store.wakeFlowStep(card.id, card.entry, now);
    }
    return { ok: true as const, said: "Answered. It picks the card up again now." };
  });
}

/** A card's link, for messages about it. */
export const teammateCardHref = (flow: number, card: number) => flowCardHref(flow, card);
