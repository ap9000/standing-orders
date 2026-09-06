/** Shared by the console and every process that can receive Telegram updates. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TelegramConnection = { botId: string; username: string };

export function readTelegramConnection(tokenFile: string): TelegramConnection | null {
  try {
    const saved = JSON.parse(readFileSync(join(dirname(tokenFile), "telegram-connection.json"), "utf8")) as Partial<TelegramConnection>;
    return typeof saved.botId === "string" && /^\d+$/.test(saved.botId) &&
      typeof saved.username === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(saved.username)
      ? { botId: saved.botId, username: saved.username } : null;
  } catch { return null; }
}

/** A configured console owns answering. Other pollers must enqueue for it,
 * even while it is restarting; they must never consume questions as notes. */
export function consoleTelegramChatEnabled(tokenFile: string, botId: string): boolean {
  return readTelegramConnection(tokenFile)?.botId === botId;
}
