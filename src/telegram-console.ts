/** Telegram's connection belongs to the service, not to an open settings tab. */
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import { bridgePass, createTransport, loadBotToken, type TelegramTransport } from "./telegram.js";
import { effectivePrimary } from "./webhooks.js";
import { processTelegramChat, type TelegramChatOptions } from "./telegram-chat.js";
import { readTelegramConnection, type TelegramConnection } from "./telegram-connection.js";
import { readTelegramMedia } from "./chat-media.js";

type Connection = TelegramConnection;
export type TelegramConnectionStatus = { enabled: boolean; username: string | null; problem: string | null };

export class TelegramConsole {
  private readonly stateFile: string;
  private connection: Connection | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private chatActive: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private problem: string | null = null;
  private failures = 0;

  constructor(private readonly store: Store, private readonly options: {
    tokenFile: string;
    configDir?: string;
    env?: Record<string, string | undefined>;
    transport?: (token: string) => TelegramTransport;
    intervalMs?: number;
    clock?: () => Date;
    chat?: TelegramChatOptions;
  }) {
    this.stateFile = join(dirname(options.tokenFile), "telegram-connection.json");
    this.connection = readTelegramConnection(options.tokenFile);
  }

  status(): TelegramConnectionStatus {
    const source = loadBotToken(this.options.env ?? process.env, this.options.tokenFile);
    const delivery = source === null ? null : this.store.raw().prepare(`SELECT d.last_problem FROM telegram_chat_detail d
      JOIN telegram_chat_request q ON q.update_id=d.request JOIN telegram_binding b ON b.id=q.binding
      WHERE b.id=? AND q.state!='sent' AND d.last_problem IS NOT NULL ORDER BY q.update_id LIMIT 1`).get(this.store.liveTelegramBinding(source.botId)?.id ?? -1);
    return { enabled: this.connection !== null, username: this.connection?.username ?? null,
      problem: this.connection !== null && source?.botId !== this.connection.botId ? "The saved bot changed. Reconnect Telegram below." : this.problem ?? (delivery ? String(delivery["last_problem"]) : null) };
  }

  start(): void { if (!this.stopped && this.connection !== null) this.schedule(0); }

  async enable(bot: Connection): Promise<void> {
    if (this.stopped) throw new Error("The service is restarting. Try again in a moment.");
    await this.cancelActive();
    if (this.stopped) throw new Error("The service is restarting. Try again in a moment.");
    const temporary = `${this.stateFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(bot) + "\n", { mode: 0o600 });
      renameSync(temporary, this.stateFile);
    } finally { rmSync(temporary, { force: true }); }
    this.connection = bot;
    this.problem = null;
    this.failures = 0;
    this.schedule(0);
  }

  async disable(): Promise<void> {
    this.connection = null;
    rmSync(this.stateFile, { force: true });
    await this.cancelActive();
    this.problem = null;
  }

  async close(): Promise<void> { this.stopped = true; await this.cancelActive(); }

  private async cancelActive(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.active;
    await this.chatActive;
    // A finishing pass may have scheduled its next cycle before it was cancelled.
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped || this.connection === null || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.poll().finally(() => { this.active = undefined; });
    }, ms);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.connection === null) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      const source = loadBotToken(this.options.env ?? process.env, this.options.tokenFile);
      if (source === null || source.botId !== this.connection.botId) {
        this.problem = "The saved bot changed. Reconnect Telegram below.";
        return;
      }
      const transport = (this.options.transport ?? (token => createTransport(token, 10_000)))(source.token);
      const result = await bridgePass(this.store, {
        botId: source.botId,
        transport: (method, params) => transport(method, params, controller.signal),
        ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
        deliver: effectivePrimary(this.options.env ?? process.env, this.options.configDir ?? dirname(this.options.tokenFile), true).channel === "telegram" && this.store.liveTelegramBinding(source.botId) !== null,
        chat: this.options.chat !== undefined,
      });
      if (controller.signal.aborted) return;
      this.problem = result.ok && result.report.problems.length > 0
        ? "Telegram is temporarily unavailable. We'll keep trying. Check that this bot isn't connected to another service."
        : null; // Another local follower's lease is healthy ownership, not a disconnection.
      this.failures = this.problem === null ? 0 : Math.min(this.failures + 1, 4);
      if (this.options.chat !== undefined && this.chatActive === undefined) {
        this.chatActive = processTelegramChat(this.store, { ...this.options.chat, botId: source.botId, transport,
          readMedia: (media, active) => readTelegramMedia(media, { token: source.token, transport, active, configDir: this.options.configDir ?? dirname(this.options.tokenFile) }),
          active: () => !this.stopped && !controller.signal.aborted && this.connection?.botId === source.botId &&
            loadBotToken(this.options.env ?? process.env, this.options.tokenFile)?.token === source.token,
          ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
        }).catch(() => { this.problem = "A chat reply was interrupted. Please send your question again."; })
          .finally(() => { this.chatActive = undefined; });
      }
    } catch {
      if (!controller.signal.aborted) {
        this.problem = "Telegram couldn't connect. We'll keep trying.";
        this.failures = Math.min(this.failures + 1, 4);
      }
    } finally {
      this.controller = undefined;
      if (!controller.signal.aborted) this.schedule(Math.min(30_000, (this.options.intervalMs ?? 2_000) * 2 ** this.failures));
    }
  }
}
