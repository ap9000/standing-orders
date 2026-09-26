/**
 * Flow decisions in Slack, Discord and Teams (v88): the Approve / Edit /
 * Send back that Telegram has (telegram-flow.ts), on the notice itself.
 *
 * - The notice carries the draft (split over as many parts as it needs, so
 *   what is approved is what was read) and the buttons on its last part.
 * - Approve decides through the same door as the console (decideFlowCard),
 *   as the paired person, for exactly the visit the notice was about, then
 *   repaints the notice with what happened and no buttons.
 * - Edit and Send back open a prompt: the person's next message in their
 *   chat with Standing Orders is the new draft (which comes back with fresh
 *   buttons) or the note. "cancel" leaves it, and a prompt lapses after
 *   30 minutes. Chat apps can't all name the message a reply answers, so
 *   the prompt says plainly what the next message does.
 *
 * Every button is one opaque token for one visit of one card, on the part it
 * rides: a tap on any other message, from anyone but the paired person, or
 * for a card that moved on, changes nothing.
 */
import { keptDraft } from "./flow-draft.js";
import { decideFlowCard, flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { deciderOf } from "./flows.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { verifyApproverStanding } from "./principal.js";
import type { ChatBinding, ChatContent, ChatEvent, ChatState } from "./chat-delivery-state.js";
import type { Store } from "./store.js";
import { FLOW_DECIDE_KEY, flowDecisionAt } from "./telegram-flow.js";

export type ChatFlowAction = "approve" | "edit" | "send-back";
export const CHAT_FLOW_LABELS: Record<ChatFlowAction, string> = { approve: "Approve", edit: "Edit", "send-back": "Send back" };
const PART_CHARS = 2800;
const PROMPT_MS = 30 * 60_000;
const DRAFT_LIMIT = 4000;

/** Words kept as written, line breaks and all; only control characters go. */
export function chatFlowText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split on line breaks where it can, so a draft reads as written. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PART_CHARS) {
    const cut = rest.lastIndexOf("\n", PART_CHARS);
    let at = cut > PART_CHARS / 2 ? cut : PART_CHARS;
    if (/[\uD800-\uDBFF]/.test(rest[at - 1]!)) at -= 1;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/** The buttons a visit gets: Approve always, Edit when there is a draft, Send back when the zone sends back somewhere. */
function actionsFor(waiting: NonNullable<ReturnType<typeof flowDecisionAt>>): ChatFlowAction[] {
  return ["approve",
    ...(waiting.draft !== null && waiting.card.outputs[waiting.draft.id] !== undefined ? ["edit" as const] : []),
    ...(waiting.stage.onFail !== null ? ["send-back" as const] : [])];
}

function decisionParts(text: string, visit: { card: number; entry: number; actions: ChatFlowAction[] }, link: { label: string; path: string } | null): ChatContent[] {
  const all = pieces(chatFlowText(text));
  return all.map((piece, index): ChatContent => index < all.length - 1 ? { text: piece } : { text: piece, flow: visit, ...(link === null ? {} : { link }) });
}

/**
 * A "flow-decision" notice as chat parts, or null when it isn't one (or the
 * card has already moved on, and there is nothing left to decide).
 */
export function flowDecisionParts(store: Store, notification: { dedupeKey: string; subject: string; body: string; link: string | null }): ChatContent[] | null {
  const visit = FLOW_DECIDE_KEY.exec(notification.dedupeKey);
  const waiting = visit === null ? null : flowDecisionAt(store, Number(visit[1]), Number(visit[2]));
  if (waiting === null) return null;
  return decisionParts(`${notification.subject}\n\n${notification.body}`, { card: waiting.card.id, entry: waiting.card.entry, actions: actionsFor(waiting) },
    notification.link === null ? null : { label: "Open", path: notification.link });
}

/** The live buttons on one part, in the order they were minted. */
export function chatFlowButtons(state: ChatState, part: number, now: Date): Array<{ token: string; action: ChatFlowAction; label: string }> {
  return (state.prepare("SELECT token,action FROM chat_flow_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(part, now.toISOString()) as Array<{ token: string; action: ChatFlowAction }>)
    .map(one => ({ token: String(one.token), action: one.action, label: CHAT_FLOW_LABELS[one.action] }));
}

const retire = (state: ChatState, card: number, entry: number, now: Date): void => {
  state.prepare("UPDATE chat_flow_action SET consumed=? WHERE card=? AND entry=? AND consumed IS NULL").run(now.toISOString(), card, entry);
  state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE card=? AND entry=? AND consumed IS NULL").run(now.toISOString(), card, entry);
};

/** Show the tapped notice again with what happened, and without its buttons. */
function repaint(state: ChatState, part: number, event: ChatEvent, line: string): void {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const before = row === undefined ? { text: "" } : JSON.parse(String(row["payload"])) as ChatContent;
  const content: ChatContent = { text: `${before.text}\n\n${line}`.slice(0, PART_CHARS + 400), edit: event.ts, ...(before.link === undefined ? {} : { link: before.link }), ...(before.channel === undefined ? {} : { channel: before.channel }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?").run(JSON.stringify(content), part);
}

/**
 * A tapped flow button, inside the action's transaction. false when the
 * token isn't a flow button (the caller looks for a proposal's); otherwise
 * the event is finished and anything to say is planned on it.
 */
export function applyChatFlowTap(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, token: string, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  const action = state.prepare("SELECT a.*,p.message,e.binding AS owner,e.channel FROM chat_flow_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE a.token=?").get(token);
  if (action === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, the chat and the exact message the button rode.
  if (Number(action["owner"]) !== binding.id || action["channel"] !== event.channel || action["message"] !== event.ts) { say("That button expired or was already used. Ask for the current state before trying again."); return true; }
  if (action["consumed"] !== null || String(action["expires"]) <= now.toISOString()) { say("That was already decided, or these buttons are too old."); return true; }
  const card = Number(action["card"]), entry = Number(action["entry"]), part = Number(action["part"]);
  const waiting = flowDecisionAt(store, card, entry);
  if (waiting === null) {
    retire(state, card, entry, now);
    repaint(state, part, event, "This card has moved on since; nothing was changed.");
    state.finish(event.id);
    return true;
  }
  const decider = deciderOf(waiting.stage, waiting.flow);
  if (decider !== null && decider !== binding.approver) { say(`Only ${decider} decides here.`); return true; }
  if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) { state.finish(event.id, true); return true; }
  const kind = String(action["action"]) as ChatFlowAction;
  if (kind === "approve") {
    const decided = decideFlowCard(store, { card, decision: "approve", note: null, actor: binding.approver, repos, entry }, now);
    if (!decided.ok) { say(decided.message); return true; }
    retire(state, card, entry, now);
    store.retireTelegramFlowVisit(card, entry, now);
    repaint(state, part, event, `✅ You approved it. ${decided.said}`);
    state.finish(event.id);
    return true;
  }
  // One open prompt per person: the newest question is the one the next message answers.
  state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
  state.prepare("UPDATE chat_question_prompt SET consumed=? WHERE binding=? AND consumed IS NULL").run(now.toISOString(), binding.id);
  state.prepare("INSERT INTO chat_flow_prompt(binding,card,entry,mode,created,expires) VALUES(?,?,?,?,?,?)")
    .run(binding.id, card, entry, kind, now.toISOString(), new Date(now.getTime() + PROMPT_MS).toISOString());
  const back = waiting.stage.onFail === null ? "the zone before" : flowDefinitionOf(waiting.flow)?.stages.find(one => one.id === waiting.stage.onFail)?.title ?? waiting.stage.onFail;
  say(kind === "edit"
    ? `Send your version of the draft for “${waiting.card.title}” as your next message here. It replaces the draft and comes back here for you to approve. Send “cancel” to leave it as it is.`
    : `What should change on “${waiting.card.title}”? Your next message here is the note, and the card goes back to ${back} with it. Send “cancel” to leave it where it is.`);
  return true;
}

/**
 * A message from the person while a prompt is open: the new draft or the
 * note. false when no prompt is open (the message goes on as usual).
 */
export function answerChatFlowPrompt(options: { store: Store; state: ChatState; label: string }, event: ChatEvent, binding: ChatBinding, input: { text: string; originalLength?: number }, repos: readonly string[], now: Date): boolean {
  const { store, state } = options;
  if (event.channel !== binding.channel) return false;
  return store.transact(() => {
    const prompt = state.prepare("SELECT * FROM chat_flow_prompt WHERE binding=? AND consumed IS NULL AND expires>? ORDER BY id DESC LIMIT 1").get(binding.id, now.toISOString());
    if (prompt === undefined) return false;
    const id = Number(prompt["id"]), card = Number(prompt["card"]), entry = Number(prompt["entry"]), mode = String(prompt["mode"]);
    const say = (text: string) => state.plan(event.id, [{ text }], now);
    const close = () => state.prepare("UPDATE chat_flow_prompt SET consumed=? WHERE id=?").run(now.toISOString(), id);
    const said = input.text.trim();
    if (/^cancel\.?$/i.test(said)) { close(); say(mode === "edit" ? "Left the draft as it is. The buttons on the notice still work." : "Left it where it is. The buttons on the notice still work."); return true; }
    const waiting = flowDecisionAt(store, card, entry);
    if (waiting === null) { retire(state, card, entry, now); say("That card has moved on since; nothing was changed."); return true; }
    if (said === "") { say(mode === "edit" ? "Send the text itself, or “cancel”." : "Say what should change, or send “cancel”."); return true; }
    // A long message arrives cut short (the chat keeps its first 2,000 characters): never take part of one as the draft.
    const limit = (input.originalLength ?? 0) > input.text.length ? MATE_MESSAGE_MAX_CHARS : DRAFT_LIMIT;
    if ((input.originalLength ?? 0) > input.text.length || said.length > DRAFT_LIMIT) { say(`That's too long to take from here. Keep it under ${limit.toLocaleString("en-US")} characters, or change it in Standing Orders.`); return true; }
    if (!verifyApproverStanding(store, binding.approver, binding.generation, repos).ok) { close(); state.finish(event.id, true); return true; }
    if (mode === "edit") {
      if (waiting.draft === null) { close(); say("This decision has no draft to edit."); return true; }
      const kept = keptDraft(said);
      store.updateFlowCard(card, { outputs: { ...waiting.card.outputs, [waiting.draft.id]: kept } }, now);
      store.addFlowComment({ card, author: binding.approver, body: `Edited the draft in ${options.label}.`, mentions: [] }, now);
      retire(state, card, entry, now);
      store.retireTelegramFlowVisit(card, entry, now);
      const fresh = flowDecisionAt(store, card, entry)!;
      state.plan(event.id, decisionParts(`${waiting.flow.name}: your version of the draft for “${waiting.card.title}”\n\n${kept}\n\nApprove to send it as written.`,
        { card, entry, actions: actionsFor(fresh) }, { label: "Open", path: flowCardHref(waiting.flow.id, card) }), now);
      return true;
    }
    const decided = decideFlowCard(store, { card, decision: "send-back", note: said.slice(0, 2000), actor: binding.approver, repos, entry }, now);
    if (!decided.ok) { close(); say(decided.message); return true; }
    retire(state, card, entry, now);
    store.retireTelegramFlowVisit(card, entry, now);
    say(`↩️ ${decided.said}`);
    return true;
  });
}
