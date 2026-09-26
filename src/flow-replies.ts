/**
 * Replies to a card's email (v91).
 *
 * A Send email step keeps the Message-ID of what it sent and whom it went
 * to. An email that names one of those (In-Reply-To or References) and comes
 * from someone the card wrote to is a reply to that card: it joins the card's
 * discussion, and a card waiting for it in a Wait zone moves on, the reply
 * kept as that zone's output ({{stage.<wait zone>}}). Anyone can copy a
 * Message-ID into a header, so a message from anyone else is never taken as a
 * reply; neither is a machine's (out of office, bounces).
 *
 * The mailbox is read for replies only while some card is in an email
 * conversation, about once a minute, read-only like Inbox triggers. An Inbox
 * trigger reading the same mailbox hands replies here instead of making a new
 * card, and a reply both see is taken once.
 */
import type { FlowCardRow, Store } from "./store.js";
import { validateFlowDefinition, type FlowDefinition } from "./flows.js";
import { mailboxAccess, mailCursorOf, mailCursorText, readThroughImap, type InboundMail, type MailReader } from "./mailbox.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";

const WATCH_EVERY_MS = 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** A first read (or one after a long pause) looks this many messages back, so a reply that came just before isn't missed. */
const LOOK_BACK = 50;
const PER_READ = 50;
const REPLY_CHARS = 4000;

const definitionOf = (store: Store, flow: number): FlowDefinition | null => {
  const row = store.getFlow(flow);
  try { return row === null ? null : validateFlowDefinition(JSON.parse(row.definitionJson)); } catch { return null; }
};

/** Everyone a card's conversation is with: whom it wrote to, who wrote back, and who sent the email it came from. */
function peopleOf(store: Store, card: FlowCardRow): Set<string> {
  const people = new Set(store.flowMailOf(card.id).flatMap(one => one.address.split(",")).filter(one => one !== ""));
  if (card.source?.mail?.from) people.add(card.source.mail.from.toLowerCase());
  return people;
}

/** Where the next email to this card's conversation goes in the thread: its latest message, and the chain before it. */
export function threadOf(store: Store, card: FlowCardRow): { inReplyTo: string; references: string[]; people: Set<string> } | null {
  const source = card.source?.mail;
  const ids = [...(source?.references ?? []), ...(source?.id ? [source.id] : []), ...store.flowMailOf(card.id).map(one => one.messageId)];
  const chain = [...new Set(ids)];
  const latest = chain.at(-1);
  return latest === undefined ? null : { inReplyTo: latest, references: chain.slice(-20), people: peopleOf(store, card) };
}

/** What a Send email step sent, kept so a reply can find the card (and the email the card came from, which a reply may name). */
export function recordSent(store: Store, card: FlowCardRow, sent: { id: string; to: string[] }, now: Date): void {
  if (!/^<[^<>\s]{3,250}>$/.test(sent.id)) return;
  store.recordFlowMail({ messageId: sent.id, card: card.id, direction: "sent", address: sent.to.map(one => one.toLowerCase()).join(",") }, now);
  const source = card.source?.mail;
  if (source?.id) store.recordFlowMail({ messageId: source.id, card: card.id, direction: "received", address: source.from }, now);
}

export type Replied = { card: FlowCardRow; moved: boolean; again: boolean };

/** Take one email as a reply to the card whose conversation it answers; null when it answers none that is active. */
export function takeReply(store: Store, mail: InboundMail, own: string, now: Date): Replied | null {
  if (mail.automatic || mail.messageId === null || mail.from === "" || mail.from === own.toLowerCase()) return null;
  const named = [...new Set([mail.inReplyTo, ...[...mail.references].reverse()].filter((one): one is string => one !== null))];
  const seen = new Set<number>();
  for (const known of store.flowMailAmong(named)) {
    if (seen.has(known.card)) continue;
    seen.add(known.card);
    const card = store.getFlowCard(known.card);
    if (card === null || card.state !== "active" || !peopleOf(store, card).has(mail.from)) continue;
    // A trigger and the watcher can both read it: it is taken once.
    if (!store.recordFlowMail({ messageId: mail.messageId, card: card.id, direction: "received", address: mail.from }, now)) return { card, moved: false, again: true };
    const text = mail.text.length > REPLY_CHARS ? `${mail.text.slice(0, REPLY_CHARS).trimEnd()}…` : mail.text;
    const who = mail.fromName === null ? mail.from : `${mail.fromName} <${mail.from}>`;
    store.addFlowComment({ card: card.id, author: mail.from, body: `Replied by email${mail.subject === "" ? "" : ` (“${mail.subject}”)`}:\n\n${text || "(no text)"}`, mentions: [] }, now);
    const definition = definitionOf(store, card.flow);
    const stage = definition?.stages.find(one => one.id === card.stage);
    const waiting = stage?.kind === "wait" && stage.wait?.for === "reply" && stage.next !== null;
    // The people on the card hear about it; it needs them only when the flow wasn't waiting for it.
    const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
    notifyPeople(store, card, people, null, { key: `reply:${mail.messageId}`, subject: `${mail.fromName ?? mail.from} replied to “${card.title}”`, body: text || "(no text)", attention: !waiting }, now);
    if (waiting) {
      store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: `From: ${who}\n\n${text}` } }, now);
      const moved = store.moveFlowCard(card.id, { to: stage.next!, outcome: "ok", actor: "flow", historyNote: `${mail.from} replied`, expectEntry: card.entry }, now);
      return { card, moved, again: false };
    }
    return { card, moved: false, again: false };
  }
  return null;
}

export type ReplyWatchIo = { dir: string | null; fetch: typeof fetch; mail?: MailReader };
export type ReplyWatch = { read: number; taken: number; problem: string | null };

/** Read the mailbox for replies to cards in an email conversation, when it is due. */
export async function watchFlowReplies(store: Store, now: Date, io: ReplyWatchIo): Promise<ReplyWatch> {
  const quiet: ReplyWatch = { read: 0, taken: 0, problem: null };
  const watch = store.flowMailWatch();
  if (watch.nextAt !== null && Date.parse(watch.nextAt) > now.getTime()) return quiet;
  if (!store.flowConversationsOpen()) return quiet;
  const failed = (said: string): ReplyWatch => {
    const failures = watch.failures + 1;
    store.setFlowMailWatch({ cursor: watch.cursor, nextAt: new Date(now.getTime() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!).toISOString(), failures, lastOutcome: said }, now);
    return { read: 0, taken: 0, problem: said };
  };
  const signed = await mailboxAccess(io.dir, io.fetch);
  if (!signed.ok) return failed(signed.said);
  const reader = io.mail ?? readThroughImap;
  // After a long pause the mailbox may hold a lot: start again from now, looking a little way back.
  const stale = watch.nextAt === null || now.getTime() - Date.parse(watch.nextAt) > 24 * 60 * 60_000;
  let after = stale ? null : mailCursorOf(watch.cursor);
  if (after === null) {
    const where = await reader(signed.access, "INBOX", null, 0);
    if (!where.ok) return failed(where.said);
    after = { validity: where.at.validity, uid: Math.max(0, where.at.uid - LOOK_BACK) };
  }
  const read = await reader(signed.access, "INBOX", after, PER_READ);
  if (!read.ok) return failed(read.said);
  let taken = 0;
  for (const mail of read.mails) if (takeReply(store, mail, signed.address, now)?.again === false) taken++;
  store.setFlowMailWatch({ cursor: mailCursorText(read.at), nextAt: new Date(now.getTime() + (read.more ? 0 : WATCH_EVERY_MS)).toISOString(), failures: 0,
    lastOutcome: taken === 0 ? "No new replies." : `${taken} ${taken === 1 ? "reply" : "replies"} taken.` }, now);
  return { read: read.mails.length, taken, problem: null };
}
