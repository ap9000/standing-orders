/** Delivery feedback is durable, but never a prerequisite for answering. */
import type { Store, TelegramBinding } from "./store.js";
import type { TelegramTransport } from "./telegram.js";

export function ensureTelegramDetail(store: Store, request: number): void {
  store.raw().prepare("INSERT OR IGNORE INTO telegram_chat_detail(request) VALUES (?)").run(request);
}

export async function telegramProgress(store: Store, binding: TelegramBinding, request: number,
  transport: TelegramTransport, text = "Message received. I’ll check your projects and reply here."): Promise<void> {
  if (store.liveTelegramBinding(binding.botId)?.id !== binding.id) return;
  const row = store.raw().prepare(`SELECT d.progress_message, q.message_id FROM telegram_chat_request q
    JOIN telegram_chat_detail d ON d.request = q.update_id WHERE q.update_id = ? AND q.binding = ? AND q.state != 'sent'`).get(request, binding.id);
  if (!row) return;
  try {
    const result = await transport(row["progress_message"] === null ? "sendMessage" : "editMessageText", {
      chat_id: binding.chatId, text,
      ...(row["progress_message"] === null
        ? (Number(row["message_id"]) > 0 ? { reply_parameters: { message_id: Number(row["message_id"]), allow_sending_without_reply: true } } : {})
        : { message_id: Number(row["progress_message"]) }),
      link_preview_options: { is_disabled: true },
    });
    const id = (result.result as { message_id?: number } | undefined)?.message_id;
    if (result.ok && Number.isSafeInteger(id) && id! > 0 && store.liveTelegramBinding(binding.botId)?.id === binding.id) {
      store.raw().prepare("UPDATE telegram_chat_detail SET progress_message = ? WHERE request = ?").run(String(id), request);
    }
  } catch { /* Retry when processing; feedback must not suppress the answer. */ }
}

export async function clearTelegramProgress(store: Store, binding: TelegramBinding, request: number, transport: TelegramTransport): Promise<void> {
  const row = store.raw().prepare("SELECT progress_message FROM telegram_chat_detail WHERE request = ?").get(request);
  if (row?.["progress_message"] == null || store.liveTelegramBinding(binding.botId)?.id !== binding.id) return;
  try { await transport("deleteMessage", { chat_id: binding.chatId, message_id: Number(row["progress_message"]) }); } catch { /* Best effort. */ }
}
