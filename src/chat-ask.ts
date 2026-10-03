/**
 * The lead's question to its owner (ask_owner) in Slack, Discord and Teams.
 *
 * The reply's last part carries the question with one button per option and
 * one for "Something else", minted when the part is planned (chat_ask_action).
 * A tapped option is sent as the owner's next message in their own chat with
 * Toolroll, so the lead reads it like anything they typed; "Something else"
 * asks them to type it. A button works once, only for the person the lead
 * asked, and only while nobody has written in that thread since.
 */
import type { ChatBinding, ChatContent, ChatEvent, ChatState } from "./chat-delivery-state.js";
import { chatHash } from "./chat-delivery-state.js";
import { MATE_ASK_OTHER, type Store } from "./store.js";

/** The live buttons on one part, in the order they were minted: the options, then "Something else". */
export function chatAskButtons(state: ChatState, part: number, now: Date): Array<{ token: string; label: string; words: boolean }> {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const content = row === undefined ? null : JSON.parse(String(row["payload"])) as ChatContent;
  const options = content?.ask?.options ?? [];
  return (state.prepare("SELECT token,choice FROM chat_ask_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid").all(part, now.toISOString()) as Array<{ token: string; choice: number | null }>)
    .map(one => {
      const label = one.choice === null ? MATE_ASK_OTHER : options[Number(one.choice)] ?? null;
      return label === null ? null : { token: String(one.token), label: label.slice(0, 75), words: one.choice === null };
    })
    .filter((one): one is { token: string; label: string; words: boolean } => one !== null);
}

/** Show the question again with what happened, and without its buttons. */
function repaint(state: ChatState, part: number, event: ChatEvent, line: string): void {
  const row = state.prepare("SELECT payload FROM chat_part WHERE id=?").get(part);
  const before = row === undefined ? { text: "" } : JSON.parse(String(row["payload"])) as ChatContent;
  const content: ChatContent = { text: `${before.text}\n\n${line}`.slice(0, 3400), edit: event.ts, ...(before.channel === undefined ? {} : { channel: before.channel }) };
  state.prepare("UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?").run(JSON.stringify(content), part);
}

/** A tapped ask button, inside the action's transaction; false when the token isn't one. */
export function applyChatAskTap(options: { store: Store; state: ChatState }, event: ChatEvent, binding: ChatBinding, token: string, now: Date): boolean {
  const { store, state } = options;
  const action = state.prepare("SELECT a.*,p.message,e.binding AS owner,e.channel FROM chat_ask_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE a.token=?").get(token);
  if (action === undefined) return false;
  const say = (text: string) => state.plan(event.id, [{ text }], now);
  // Bound to the person, their own chat and the exact message the button rode.
  if (Number(action["owner"]) !== binding.id || action["channel"] !== event.channel || event.channel !== binding.channel || action["message"] !== event.ts) {
    say("That button expired or was already used.");
    return true;
  }
  const turn = Number(action["turn"]), part = Number(action["part"]);
  const ask = store.getMateTurn(turn)?.approver === binding.approver ? store.mateAskOpen(turn) : null;
  if (action["consumed"] !== null || String(action["expires"]) <= now.toISOString() || ask === null) {
    state.prepare("UPDATE chat_ask_action SET consumed=? WHERE part=? AND consumed IS NULL").run(now.toISOString(), part);
    repaint(state, part, event, "This question was already answered.");
    state.finish(event.id);
    return true;
  }
  if (action["choice"] === null) {
    say("Type your answer here as your next message.");
    return true;
  }
  const option = ask.options[Number(action["choice"])];
  if (option === undefined) { say("That option is no longer there."); return true; }
  state.prepare("UPDATE chat_ask_action SET consumed=? WHERE part=? AND consumed IS NULL").run(now.toISOString(), part);
  // The option is the owner's next message, answered like one they typed.
  state.enqueue({
    id: chatHash(`${state.channel}:ask:${event.id}`).slice(0, 32), installation: event.installation, binding: binding.id, kind: "message",
    channel: event.channel, member: event.member, ts: event.ts, thread: event.thread,
    payload: JSON.stringify({ text: option, originalLength: option.length }), created: now.toISOString(),
  });
  repaint(state, part, event, `You chose: ${option}`);
  state.finish(event.id);
  return true;
}
