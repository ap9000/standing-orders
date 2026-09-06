/** Proposal cards use the app's confirmation doors. Pollers only queue taps;
 * the console re-proves its current project ceiling before executing them. */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Store, TelegramBinding, MateProposal } from "./store.js";
import type { TelegramTransport } from "./telegram.js";
import { verifyApproverStanding } from "./principal.js";
import { confirmMateProposal, dismissMateProposal } from "./mate-doors.js";
import { scanForSecrets } from "./evidence.js";

const ALLOWED = new Set(["task", "next", "hold", "unhold"]);

function cardText(store: Store, proposal: MateProposal): { text: string; label: string } {
  const payload = proposal.payload;
  const taskId = typeof payload["task"] === "string" ? payload["task"] : null;
  const task = taskId === null ? null : store.getTask(taskId);
  const title = task?.title ?? String(payload["title"] ?? "Task");
  const repo = typeof payload["repo"] === "string" ? payload["repo"] : taskId === null ? null : store.lookupRef(taskId)?.repo;
  const project = repo ? basename(repo) : String(payload["repoId"] ?? "Project");
  const heading = `${project} · ${title}`;
  if (proposal.kind === "task") return { label: "Create task", text: `Create this task?\n${heading}\n\n${String(payload["goal"] ?? "")}\n${payload["not"] ? `\nOutside scope: ${String(payload["not"])}\n` : ""}${Array.isArray(payload["touches"]) && payload["touches"].length ? `\nFiles: ${payload["touches"].join(", ")}\n` : ""}\nThis creates a draft. Review and approve its scope in the app before it runs.` };
  if (proposal.kind === "next") return { label: "Prioritize task", text: `Prioritize this task?\n${heading}\n\nMove it to the front of its queue. Existing approvals and blockers still apply.` };
  if (proposal.kind === "hold") return typeof payload["stopRun"] === "number"
    ? { label: "Stop and pause", text: `Stop this build and pause?\n${heading}\n\n${String(payload["reason"] ?? "")}\n\nRequest a stop for build #${payload["stopRun"]}. Work will be preserved and the task will remain paused until you resume it.` }
    : { label: "Pause future attempts", text: `Pause future attempts?\n${heading}\n\n${String(payload["reason"] ?? "")}\n\nA current run will finish; this prevents the next attempt from starting.` };
  return { label: "Resume task", text: `Resume this task?\n${heading}\n\nRemove your pause. The next attempt can start when approvals, other blockers, and worker availability allow.` };
}

export async function deliverTelegramCards(store: Store, binding: TelegramBinding, turn: number, repos: readonly string[],
  transport: TelegramTransport, active: () => boolean, now: Date): Promise<boolean> {
  const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, repos);
  const found = store.getMateTurn(turn);
  if (!principal.ok || found?.state !== "answered") return true;
  const thread = store.getMateThread(found.thread);
  if (thread?.approver !== binding.approver || thread.closedAt !== null || thread.ceilingDigest !== principal.who.ceilingDigest) return true;
  for (const proposal of store.listMateProposals(found.thread, ["pending"]).filter(one => one.turn === turn && ALLOWED.has(one.kind))) {
    if (!active() || store.liveTelegramBinding(binding.botId)?.id !== binding.id) return false;
    const card = cardText(store, proposal);
    for (const operation of ["confirm", "dismiss"]) {
      store.raw().prepare(`INSERT OR IGNORE INTO telegram_chat_card(token,binding,proposal,operation,created_at,expires_at)
        VALUES (?,?,?,?,?,?)`).run("cp:" + randomBytes(16).toString("hex"), binding.id, proposal.id, operation, now.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString());
    }
    const rows = store.raw().prepare("SELECT * FROM telegram_chat_card WHERE binding = ? AND proposal = ? ORDER BY operation").all(binding.id, proposal.id);
    if (rows.every(row => row["message_id"] !== null)) continue;
    // Preserve full authorization terms. A permanently unsuitable or expired
    // card gets a useful fallback, rather than keeping its answer unsent forever.
    const expired = rows.some(row => String(row["expires_at"]) <= now.toISOString());
    const needsApp = card.text.length > 3900 || scanForSecrets(card.text).length > 0;
    const text = expired ? "This proposal’s confirmation window expired while delivery was delayed. Ask me for a fresh proposal."
      : needsApp ? "This proposal needs a fuller review. Open Chat in Standing Orders to review its complete terms. No change has been applied." : card.text;
    const result = await transport("sendMessage", { chat_id: binding.chatId, text,
      reply_markup: { inline_keyboard: expired || needsApp ? [] : [rows.map(row => ({ text: row["operation"] === "confirm" ? card.label : "Dismiss", callback_data: String(row["token"]) }))] },
      link_preview_options: { is_disabled: true } });
    const messageId = (result.result as { message_id?: number } | undefined)?.message_id;
    if (!result.ok || !Number.isSafeInteger(messageId) || messageId! <= 0) return false;
    store.raw().prepare("UPDATE telegram_chat_card SET message_id = ? WHERE binding = ? AND proposal = ?")
      .run(String(messageId), binding.id, proposal.id);
    if (expired || needsApp) store.raw().prepare("UPDATE telegram_chat_card SET consumed_at = ? WHERE binding = ? AND proposal = ?")
      .run(now.toISOString(), binding.id, proposal.id);
  }
  return true;
}

/** Called only after the Telegram edge proves the private chat and sender. */
export function queueTelegramConfirmation(store: Store, binding: TelegramBinding, update: number, token: string, message: string, now: Date): boolean {
  const card = store.raw().prepare("SELECT * FROM telegram_chat_card WHERE token = ? AND binding = ? AND message_id = ? AND expires_at > ?")
    .get(token, binding.id, message, now.toISOString());
  if (!card) return false;
  store.raw().prepare("INSERT OR IGNORE INTO telegram_chat_confirmation(update_id,token,binding,message_id,created_at) VALUES (?,?,?,?,?)")
    .run(update, token, binding.id, message, now.toISOString());
  return true;
}

export async function processTelegramConfirmations(store: Store, binding: TelegramBinding, repos: readonly string[], transport: TelegramTransport,
  active: () => boolean, now: Date): Promise<void> {
  const pending = store.raw().prepare("SELECT * FROM telegram_chat_confirmation WHERE binding = ? AND delivered = 0 ORDER BY update_id LIMIT 8").all(binding.id);
  for (const row of pending) {
    if (!active() || store.liveTelegramBinding(binding.botId)?.id !== binding.id) return;
    const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, repos);
    if (!principal.ok) return;
    const text = store.transact(() => {
      const fresh = store.raw().prepare("SELECT * FROM telegram_chat_confirmation WHERE update_id = ?").get(row["update_id"]!);
      const card = store.raw().prepare("SELECT * FROM telegram_chat_card WHERE token = ?").get(row["token"]!);
      const proposal = card ? store.getMateProposal(Number(card["proposal"])) : null;
      const thread = proposal ? store.getMateThread(proposal.thread) : null;
      if (!thread || thread.approver !== binding.approver || thread.closedAt !== null || thread.ceilingDigest !== principal.who.ceilingDigest) {
        store.raw().prepare("UPDATE telegram_chat_confirmation SET result=? WHERE update_id=?").run("This conversation’s project access changed. Ask for a fresh proposal.", row["update_id"]!);
        return "This conversation’s project access changed. Ask for a fresh proposal.";
      }
      if (fresh?.["result"] != null) return String(fresh["result"]);
      let answer = "This card is no longer available. Ask me for a fresh proposal.";
      if (card && proposal && ALLOWED.has(proposal.kind) && card["binding"] === binding.id && card["message_id"] === row["message_id"] &&
        String(card["expires_at"]) > now.toISOString()) {
        if (card["consumed_at"] !== null || proposal.state !== "pending") answer = "This proposal was already handled. No change was repeated.";
        else {
          if (card["operation"] === "dismiss") answer = dismissMateProposal(store, principal.who, proposal.id, now) ? "Proposal dismissed." : "This proposal is no longer available.";
          else {
            const outcome = confirmMateProposal(store, principal.who, proposal.id, now, { via: "telegram" });
            answer = outcome.ok ? outcome.said : `Couldn’t apply this change: ${outcome.said}`;
          }
          store.raw().prepare("UPDATE telegram_chat_card SET consumed_at = ? WHERE binding = ? AND proposal = ?")
            .run(now.toISOString(), binding.id, proposal.id);
          const thread = store.getMateThread(proposal.thread);
          if (thread?.approver === binding.approver && thread.ceilingDigest === principal.who.ceilingDigest && thread.closedAt === null) {
            store.appendMateMessage({ thread: proposal.thread, turn: null, role: "assistant", text: answer, activity: "Confirmed in Telegram" }, now);
          }
        }
      }
      store.raw().prepare("UPDATE telegram_chat_confirmation SET result = ? WHERE update_id = ?").run(answer, row["update_id"]!);
      return answer;
    });
    let result = await transport("editMessageText", { chat_id: binding.chatId, message_id: Number(row["message_id"]), text,
      reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } });
    if (!result.ok && /message (?:can't be edited|to edit not found)/i.test(result.description ?? "")) {
      result = await transport("sendMessage", { chat_id: binding.chatId, text, link_preview_options: { is_disabled: true } });
    }
    // Telegram may report "not modified" after an edit succeeded but its receipt was lost.
    if (result.ok || result.description?.includes("message is not modified")) {
      store.raw().prepare("UPDATE telegram_chat_confirmation SET delivered = 1 WHERE update_id = ?").run(row["update_id"]!);
    }
  }
}
