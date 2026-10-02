/** The lead's voice: what the person's lead (an agent under their lead token) is doing, in their chat and on the
 * console. `lead say` posts one short message from "Your lead"; several within two minutes are one message, edited
 * in place as it grows. `assignment claim` marks a task the lead's: it reads "Your lead is on it" and leaves Needs
 * you until the lead completes it, hands it to a person, or two hours pass with no lead act on it.
 *
 * Every fact is an append-only ledger row under "lead for <owner>"; no table of its own. The chat message is an
 * ordinary notification addressed to the owner, so every chat delivers it with the usual receipts. */
import { actorLabel, type Actor } from "./actor.js";
import { chatControlHref } from "./chat-controls.js";
import { BATCH_MS, chatText, chatTitle } from "./chat-voice.js";
import { BUILT_IN, type Notification, type Store } from "./store.js";
import { phoneText as plain } from "./telegram-status.js";

/** Who the person's chat says the lead's messages are from. */
export const LEAD_NAME = "Your lead";
export const LEAD_SAY_KIND = "lead-say";
/** Repaints the owner's task card when the lead takes a task on: it never makes a new message in quiet chat. */
export const LEAD_ON_IT_KIND = "lead-on-it";
export const LEAD_SAID = "lead said";
export const LEAD_CLAIMED = "lead is on it";
/** A claim lapses after this long without a lead act on the task. */
export const LEAD_IDLE_MS = 2 * 3_600_000;
/** The lead's acts that hand the task back: done, handed to a person, or cancelled. */
export const LEAD_ENDS = ["task completed", "task handed to a person", "task cancelled"] as const;
export const LEAD_SAY_MAX = 300;
/** Lines one batched message keeps; the oldest go first. */
const BATCH_LINES = 8;

const ENDS_SQL = LEAD_ENDS.map(one => `'${one}'`).join(",");

/** The work index's reading of a claim, per row of its `classified` projection: 0 none, 1 on it, 2 lapsed. */
export const LEAD_CLAIM_SQL = `COALESCE((SELECT CASE
      WHEN EXISTS(SELECT 1 FROM action_ledger e WHERE e.task_id IN (SELECT m.id FROM ordered m WHERE m.root_ref = c.root_ref)
        AND e.id > claim.id AND e.actor = claim.actor AND e.action IN (${ENDS_SQL})) THEN 0
      WHEN (SELECT MAX(a.at) FROM action_ledger a WHERE a.task_id IN (SELECT m.id FROM ordered m WHERE m.root_ref = c.root_ref)
        AND a.id >= claim.id AND a.actor = claim.actor) > $leadIdleSince THEN 1 ELSE 2 END
    FROM action_ledger claim WHERE claim.id = (SELECT MAX(id) FROM action_ledger WHERE task_id = c.root_id AND action = '${LEAD_CLAIMED}')), 0)`;

export type LeadClaim = { state: "on-it" | "lapsed"; owner: string; since: string; lastActedAt: string };
export type LeadActivity = { owner: string; doing: string; at: string; taskId: string | null };

type Failure = { ok: false; reason: "usage" | "unknown-task" | "refused"; message: string };

/** A task family's root and every version, following revisions both ways. */
function familyOf(store: Store, taskId: string): { root: string; ids: string[] } {
  const root = store.handle.prepare(`WITH RECURSIVE up(id, depth) AS (SELECT ?, 0 UNION ALL
      SELECT r.revision_of, up.depth + 1 FROM up JOIN task_ref r ON r.backend = ? AND r.external_id = up.id WHERE r.revision_of IS NOT NULL AND up.depth < 64)
    SELECT id FROM up ORDER BY depth DESC LIMIT 1`).get(taskId, BUILT_IN);
  const top = root === undefined ? taskId : String(root["id"]);
  const ids = store.handle.prepare(`WITH RECURSIVE down(id, depth) AS (SELECT ?, 0 UNION ALL
      SELECT r.external_id, down.depth + 1 FROM down JOIN task_ref r ON r.backend = ? AND r.revision_of = down.id WHERE down.depth < 64)
    SELECT DISTINCT id FROM down`).all(top, BUILT_IN).map(row => String(row["id"]));
  return { root: top, ids };
}

/** One line of the lead's words: plain, short, no control characters. */
export function leadWordsProblem(text: string): string | null {
  const words = text.trim();
  if (words === "") return "Say something: `toolroll lead say \"<what you're doing>\"`.";
  if (words.length > LEAD_SAY_MAX) return `Keep it short: at most ${LEAD_SAY_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(words)) return "One line of plain text.";
  return null;
}

/** The task the lead names, if its owner can see it. */
function admittedTask(store: Store, owner: string, taskId: string): { refId: number; repo: string | null } | Failure {
  const ref = store.lookupRef(taskId);
  if (ref === null || store.getTask(taskId) === null) return { ok: false, reason: "unknown-task", message: `No task \`${taskId}\`.` };
  if (ref.repo !== null && !store.accountCanAccess(owner, ref.repo)) return { ok: false, reason: "unknown-task", message: `No task \`${taskId}\`.` };
  return { refId: ref.id, repo: ref.repo };
}

/** `lead say`: record the words as the lead's act, and post them in the owner's chat. Within two minutes of the
 * first, a later say joins it: the new row carries every line, and the earlier one stops waiting to be sent (a
 * chat that already showed it edits that message in place). */
export function leadSay(store: Store, actor: Actor, text: string, taskId: string | null, now: Date): { ok: true; joined: boolean; notification: number | null } | Failure {
  if (!actor.lead) return { ok: false, reason: "refused", message: "Only the lead speaks as the lead: pass its lead token." };
  const problem = leadWordsProblem(text);
  if (problem !== null) return { ok: false, reason: "usage", message: problem };
  const task = taskId === null ? null : admittedTask(store, actor.account, taskId);
  if (task !== null && "ok" in task) return task;
  // The task's own id never reaches a chat: it reads as the task's short title (chat-voice.ts).
  const said = taskId === null ? text.trim() : chatText(text.trim(), [{ id: taskId, title: chatTitle(store, taskId) }]);
  return store.transact(() => {
    const stamp = now.toISOString();
    const ledger = store.recordAction({ at: stamp, actor: actorLabel(actor), repo: task?.repo ?? null, taskId, runId: null,
      action: LEAD_SAID, outcome: "recorded", source: "work", detail: text.trim() });
    const open = store.handle.prepare(`SELECT id, dedupe_key, body FROM notification WHERE kind = ? AND recipient = ? ORDER BY id DESC LIMIT 1`)
      .get(LEAD_SAY_KIND, actor.account);
    const opened = open === undefined ? null : /^lead-say:(.+):\d+$/.exec(String(open["dedupe_key"]))?.[1] ?? null;
    const joined = open !== undefined && opened !== null && Date.parse(opened) > now.getTime() - BATCH_MS && Date.parse(opened) <= now.getTime();
    const lines = [...(joined ? String(open!["body"]).split("\n") : []), said].slice(-BATCH_LINES);
    if (joined) store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(stamp, Number(open!["id"]));
    const key = `lead-say:${joined ? opened : stamp}:${ledger}`;
    store.enqueueNotification({ dedupeKey: key, kind: LEAD_SAY_KIND, subject: LEAD_NAME, body: lines.join("\n"),
      recipient: actor.account, source: { installation: true }, ...(taskId === null ? {} : { link: chatControlHref("task", taskId) }) }, now);
    const row = store.handle.prepare("SELECT id FROM notification WHERE dedupe_key = ?").get(key);
    return { ok: true as const, joined, notification: row === undefined ? null : Number(row["id"]) };
  });
}

/** The words a chat shows for a lead-say row: "Your lead", then each line, plain, with no task id. */
export function leadSayText(row: Pick<Notification, "subject" | "body">): string {
  return chatText([plain(row.subject, 60), "", ...row.body.split("\n").map(line => plain(line, LEAD_SAY_MAX)).filter(line => line !== "")].join("\n"));
}

/** The earlier rows of a lead-say message (newest first): a chat that showed one edits it rather than sending again. */
export function leadSayEarlier(store: Store, row: Pick<Notification, "id" | "kind" | "dedupeKey" | "recipient">): number[] {
  if (row.kind !== LEAD_SAY_KIND || row.recipient === null) return [];
  const opened = /^(lead-say:.+:)\d+$/.exec(row.dedupeKey)?.[1];
  if (opened === undefined) return [];
  return store.handle.prepare(`SELECT id FROM notification WHERE kind = ? AND recipient = ? AND id < ? AND substr(dedupe_key, 1, ?) = ? ORDER BY id DESC`)
    .all(LEAD_SAY_KIND, row.recipient, row.id, opened.length, opened).map(one => Number(one["id"]));
}

/** `assignment claim` under the lead token: the task is the lead's until it completes it, hands it on, or goes
 * quiet on it for two hours. Repeating a claim is safe and counts as a lead act. */
export function leadClaim(store: Store, actor: Actor, taskId: string, now: Date): { ok: true; root: string; claim: LeadClaim } | Failure {
  if (!actor.lead) return { ok: false, reason: "refused", message: "Only the lead takes a task on as the lead: pass its lead token." };
  const task = admittedTask(store, actor.account, taskId);
  if ("ok" in task) return task;
  const { root } = familyOf(store, taskId);
  store.transact(() => {
    const ledger = store.recordAction({ at: now.toISOString(), actor: actorLabel(actor), repo: task.repo, taskId: root, runId: null,
      action: LEAD_CLAIMED, outcome: "recorded", source: "work" });
    // The owner's card for this task repaints to "Your lead is on it"; quiet chat sends nothing new.
    store.enqueueNotification({ dedupeKey: `lead-on-it:${ledger}`, kind: LEAD_ON_IT_KIND, subject: "Your lead is on it", body: "",
      link: chatControlHref("task", taskId), source: { taskRef: task.refId } }, now);
  });
  return { ok: true, root, claim: leadClaimOf(store, taskId, now)! };
}

/** Whether the lead has this task now: on it, lapsed after two quiet hours (it says so), or null (never claimed,
 * or the lead completed it, handed it on or cancelled it since). */
export function leadClaimOf(store: Store, taskId: string, now: Date): LeadClaim | null {
  try {
    const { root, ids } = familyOf(store, taskId);
    const claim = store.handle.prepare("SELECT id, at, actor FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(root, LEAD_CLAIMED);
    if (claim === undefined) return null;
    const family = `task_id IN (${ids.map(() => "?").join(",")}) AND id >= ? AND actor = ?`;
    const args = [...ids, Number(claim["id"]), String(claim["actor"])];
    // Completed, handed on or cancelled by the lead since its claim: the claim is over.
    if (store.handle.prepare(`SELECT 1 AS hit FROM action_ledger WHERE ${family} AND action IN (${ENDS_SQL}) LIMIT 1`).get(...args) !== undefined) return null;
    const latest = store.handle.prepare(`SELECT MAX(at) AS at FROM action_ledger WHERE ${family}`).get(...args);
    const lastActedAt = String(latest?.["at"] ?? claim["at"]);
    return { state: Date.parse(lastActedAt) > now.getTime() - LEAD_IDLE_MS ? "on-it" : "lapsed",
      owner: String(claim["actor"]).replace(/^lead for /, ""), since: String(claim["at"]), lastActedAt };
  } catch {
    // An older store being read by a newer build: no claim is the safe reading.
    return null;
  }
}

/** The lead's act on a task that a claim counts (a retry, a state change, a steer): one ledger row as the lead. */
export function noteLeadWork(store: Store, actor: Actor, taskId: string, what: string, now: Date): void {
  if (!actor.lead) return;
  const ref = store.lookupRef(taskId);
  if (ref === null) return;
  store.recordAction({ at: now.toISOString(), actor: actorLabel(actor), repo: ref.repo, taskId, runId: null, action: `lead ${what}`, outcome: "recorded", source: "work" });
}

const ACT_WORDS: Readonly<Record<string, string>> = {
  "task filed": "filed", "task approved": "approved", "task cancelled": "cancelled", "task completed": "completed",
  "task handed to a person": "handed on", [LEAD_CLAIMED]: "working on",
};

/** What the lead is doing now and when it last acted: its newest words (a say), else its newest act in words. `owner`
 * null reads the newest lead of any person. */
export function leadActivity(store: Store, owner: string | null): LeadActivity | null {
  try {
    const who = owner === null ? "actor GLOB 'lead for ?*'" : "actor = ?";
    const args = owner === null ? [] : [`lead for ${owner}`];
    const last = store.handle.prepare(`SELECT id, at, actor, task_id, action, detail FROM action_ledger WHERE ${who} ORDER BY id DESC LIMIT 1`).get(...args);
    if (last === undefined) return null;
    const actor = String(last["actor"]);
    const told = store.handle.prepare(`SELECT at, task_id, action, detail FROM action_ledger WHERE actor = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1`).get(actor, LEAD_SAID, LEAD_CLAIMED);
    const shown = told ?? last;
    const task = shown["task_id"] == null ? null : String(shown["task_id"]);
    const title = task === null ? "" : (() => { try { return ` ${chatTitle(store, task)}`; } catch { return ""; } })();
    const doing = shown["action"] === LEAD_SAID && shown["detail"] != null ? chatText(String(shown["detail"]), task === null ? [] : [{ id: task, title: title.trim() }])
      : `${ACT_WORDS[String(shown["action"])] ?? String(shown["action"]).replace(/^lead /, "")}${title}`;
    return { owner: actor.replace(/^lead for /, ""), doing: doing.replace(/[.\s]+$/u, ""), at: String(last["at"]), taskId: task };
  } catch {
    return null;
  }
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago". */
export function agoWords(at: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The one line `toolroll status` and the console say: "Your lead: fixing 0.9.12's release check · 3 min ago". */
export function leadActivityLine(activity: LeadActivity, now: Date): string {
  return `${LEAD_NAME}: ${activity.doing} · ${agoWords(activity.at, now)}`;
}
