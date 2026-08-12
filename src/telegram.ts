/**
 * The Telegram bridge: decisions out, answers back, zero tokens spent.
 *
 * This is channel plumbing — no LLM is anywhere in this path, and everything
 * it renders is deterministic. The security model, in one breath: a chat is
 * not a person, so pairing is a local authenticated act that binds one
 * private chat AND one immutable user id to one approver generation; a
 * button is not a command, so callback_data carries only an opaque one-time
 * token whose meaning lives in this database where a stolen bot token
 * cannot read it; and an answer lands in the same transaction that proves
 * the binding is still live and consumes the token — or it does not land.
 *
 * What a stolen bot token CAN do is stated rather than wished away: read
 * the decision text this installation chose to send through Telegram,
 * repaint the bot's keyboards with deceptive labels, and race our poll for
 * updates. It cannot mint an action token, answer as the operator, or make
 * `answered_by` say anything the pairing did not authorize. Rotating the
 * BotFather token plus `bridge telegram unpair` is the recovery, and both
 * are one command.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Store, Decision, Notification, TelegramBinding } from "./store.js";

/** The environment name — and therefore the name the builder strips from agents. */
export const TOKEN_ENV = "NIGHTORDERS_TELEGRAM_TOKEN";

/** BotFather's shape: numeric bot id, colon, secret. */
const TOKEN_SHAPE = /^(\d+):[A-Za-z0-9_-]{20,}$/;

export const PAIRING_TTL_MS = 10 * 60_000;
export const CONFIRM_TTL_MS = 10 * 60_000;
export const BRIDGE_LEASE_MS = 2 * 60_000;
export const DELIVERY_CLAIM_MS = 2 * 60_000;
/** Telegram's own message ceiling, with room for our part headers. */
const PART_CAP = 3_900;
/** Pages of getUpdates one pass will read before reporting a backlog. */
const PAGE_BUDGET = 10;

// ---- the credential --------------------------------------------------------

export type TokenSource = { token: string; botId: string; source: "env" | "file" };

/**
 * Environment wins, the credential file beside the database otherwise.
 * The file is how the CLI and the web settings card set it (0600, owner
 * only); the env var is how people who already run keychain tooling keep
 * it out of files entirely.
 */
export function loadBotToken(
  env: Record<string, string | undefined>,
  file: string,
): TokenSource | null {
  const fromEnv = env[TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const parsed = TOKEN_SHAPE.exec(fromEnv.trim());
    return parsed === null ? null : { token: fromEnv.trim(), botId: parsed[1] as string, source: "env" };
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  const parsed = TOKEN_SHAPE.exec(raw);
  return parsed === null ? null : { token: raw, botId: parsed[1] as string, source: "file" };
}

/** Write the credential file, owner-only. Refuses a string that is not a bot token. */
export function saveBotToken(file: string, token: string): { ok: true } | { ok: false; message: string } {
  if (!TOKEN_SHAPE.test(token.trim())) {
    return {
      ok: false,
      message: "that does not look like a bot token (expected <digits>:<secret>, from @BotFather)",
    };
  }
  writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  // writeFileSync applies the mode only on creation; an existing file keeps
  // whatever it had, so the permission is asserted rather than assumed.
  chmodSync(file, 0o600);
  return { ok: true };
}

export function clearBotToken(file: string): boolean {
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The last four characters are enough to recognize a token without holding it. */
export function redactToken(token: string): string {
  return `…${token.slice(-4)}`;
}

/** Scrub a token out of any text on its way to a log, an error, or a row. */
export function scrub(text: string, token: string): string {
  return token === "" ? text : text.split(token).join(redactToken(token));
}

// ---- the transport ---------------------------------------------------------

/**
 * One Bot API call. Injectable, so the suite scripts Telegram instead of
 * dialing it. The optional signal lets a follower cancel a long poll the
 * moment it is told to stop, instead of waiting the poll window out.
 */
export type TelegramTransport = (
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; result?: unknown; description?: string }>;

export function createTransport(token: string, timeoutMs = 30_000): TelegramTransport {
  return async (method, params, signal) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const body = (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
      return {
        ok: body.ok === true,
        result: body.result,
        // Whatever Telegram said, the token must not be in what we keep.
        ...(body.description === undefined ? {} : { description: scrub(body.description, token) }),
      };
    } catch (error) {
      return {
        ok: false,
        description: scrub(error instanceof Error ? error.message : String(error), token),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

// ---- pairing ---------------------------------------------------------------

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 128 bits, hex — pasteable, and not guessable inside any code's lifetime. */
export function mintPairingCode(): string {
  return randomBytes(16).toString("hex");
}

// ---- the pass --------------------------------------------------------------

export type BridgeReport = {
  sent: number;
  answered: number;
  paired: number;
  ignored: number;
  /** Updates Telegram still holds beyond this pass's page budget. */
  backlog: boolean;
  problems: string[];
};

type Effect = () => Promise<void>;

/**
 * One bridge pass: claim and send what the outbox holds, then read one
 * budgeted window of updates and apply each in its own transaction. Cron
 * calls this; running it twice concurrently loses the lease race and does
 * nothing, which is the design working.
 */
export async function bridgePass(
  store: Store,
  options: {
    botId: string;
    transport: TelegramTransport;
    clock?: () => Date;
    owner?: string;
  },
): Promise<{ ok: true; report: BridgeReport } | { ok: false; reason: "bridge-busy"; message: string }> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? randomBytes(8).toString("hex");
  const { botId, transport } = options;

  const lease = store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock());
  if (!lease.ok) {
    return {
      ok: false,
      reason: "bridge-busy",
      message: `another bridge holds the poll until ${lease.until} — one poller per bot, or taps get eaten`,
    };
  }

  const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };

  try {
    await deliverOutbox(store, botId, transport, owner, clock, report);
    await drainUpdates(store, botId, transport, owner, lease.generation, lease.cursor, clock, report);
  } finally {
    // Handed back so the next cron firing is not told busy for the rest of
    // this pass's TTL. A crash skips this and the lease expires instead —
    // which is exactly what the TTL is for.
    store.releaseBridgeLease(botId, owner, clock());
  }

  return { ok: true, report };
}

// ---- the follower ----------------------------------------------------------

/**
 * The longest long poll the follower may ask for. `createTransport`'s HTTP
 * timeout is 30s and must outlive the poll window, or the client would abort
 * a poll Telegram is still honestly holding open.
 */
export const MAX_POLL_SECONDS = 25;
/** Reconnect backoff: starts here, doubles per consecutive failure, capped. */
const FOLLOW_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** A cycle that returned instantly with nothing is padded to this — a scripted or broken server must not spin the loop hot. */
const FOLLOW_IDLE_FLOOR_MS = 1_000;

export type FollowReport = {
  cycles: number;
  sent: number;
  answered: number;
  paired: number;
  ignored: number;
  problems: string[];
};

/**
 * The follower (§M4): one actor that holds the poll lease and stays on the
 * wire, so an answer tapped on a phone reaches the store in seconds, not at
 * the next cron firing. `bridge telegram --follow` runs it standalone;
 * watch embeds the same actor — the poll lease guarantees only one is
 * live, and a cron pass overlapping it simply loses the lease race.
 *
 * Each cycle re-acquires the lease under the same owner — that is the
 * fenced renewal: same generation while held, and if the lease lapsed
 * mid-poll (a stall longer than the TTL), the re-acquire takes the next
 * generation and the cursor rides it, so nothing this follower stamped
 * with the old generation can move state afterwards. Transport failures
 * back off exponentially and are counted, not hidden; cancellation aborts
 * the in-flight long poll instead of waiting it out.
 */
export async function followBridge(
  store: Store,
  options: {
    botId: string;
    transport: TelegramTransport;
    signal: AbortSignal;
    clock?: () => Date;
    owner?: string;
    pollSeconds?: number;
    /** One line per cycle that did something — the follower's narration hook. */
    onCycle?: (report: BridgeReport) => void;
    /** Injectable for tests; the default resolves early on abort. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<FollowReport> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? `follow-${randomBytes(8).toString("hex")}`;
  const { botId, transport, signal } = options;
  const pollSeconds = Math.max(1, Math.min(options.pollSeconds ?? MAX_POLL_SECONDS, MAX_POLL_SECONDS));

  const wait =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
      }));

  const total: FollowReport = { cycles: 0, sent: 0, answered: 0, paired: 0, ignored: 0, problems: [] };
  let failures = 0;

  try {
    while (!signal.aborted) {
      const lease = store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock());
      if (!lease.ok) {
        // A cron pass (or a rival follower) holds the poll. Not an error —
        // wait our turn and try again.
        await wait(FOLLOW_BACKOFF_MS[Math.min(failures, FOLLOW_BACKOFF_MS.length - 1)] as number);
        failures = Math.min(failures + 1, FOLLOW_BACKOFF_MS.length - 1);
        continue;
      }

      const startedAt = Date.now();
      const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };
      await deliverOutbox(store, botId, transport, owner, clock, report);
      await drainUpdates(
        store, botId, transport, owner, lease.generation, lease.cursor, clock, report, pollSeconds, signal,
      );

      total.cycles++;
      total.sent += report.sent;
      total.answered += report.answered;
      total.paired += report.paired;
      total.ignored += report.ignored;
      total.problems.push(...report.problems);
      if (report.sent > 0 || report.answered > 0 || report.paired > 0 || report.problems.length > 0) {
        options.onCycle?.(report);
      }

      if (report.problems.length > 0 && report.sent === 0 && report.answered === 0) {
        // The wire is down. Back off; the counter resets on the first clean cycle.
        if (!signal.aborted) {
          await wait(FOLLOW_BACKOFF_MS[Math.min(failures, FOLLOW_BACKOFF_MS.length - 1)] as number);
        }
        failures = Math.min(failures + 1, FOLLOW_BACKOFF_MS.length - 1);
        continue;
      }
      failures = 0;

      // A healthy cycle's wait IS the long poll. A cycle that came back
      // instantly and empty (scripted transport, misbehaving server) gets
      // padded so the loop cannot spin hot.
      const took = Date.now() - startedAt;
      if (!signal.aborted && report.sent === 0 && report.answered === 0 && took < FOLLOW_IDLE_FLOOR_MS) {
        await wait(FOLLOW_IDLE_FLOOR_MS - took);
      }
    }
  } finally {
    store.releaseBridgeLease(botId, owner, clock());
  }

  return total;
}

// ---- outbound --------------------------------------------------------------

async function deliverOutbox(
  store: Store,
  botId: string,
  transport: TelegramTransport,
  owner: string,
  clock: () => Date,
  report: BridgeReport,
): Promise<void> {
  const binding = store.liveTelegramBinding(botId);
  const claimed = store.claimDeliveries(owner, DELIVERY_CLAIM_MS, clock());
  if (claimed.length === 0) return;
  if (binding === null) {
    // Nothing to send to. The rows stay pending (claims lapse), and the
    // problem is said once rather than once per row.
    for (const row of claimed) {
      store.finalizeDelivery(row.id, owner, { ok: false, error: "no paired telegram chat" }, clock());
    }
    report.problems.push("outbox rows are pending but no chat is paired — `nightorders bridge telegram pair`");
    return;
  }

  for (const row of claimed) {
    const outcome = await deliverOne(store, botId, binding, transport, row, clock);
    const finalized = store.finalizeDelivery(row.id, owner, outcome, clock());
    if (outcome.ok && finalized) report.sent++;
    if (!outcome.ok) report.problems.push(`notification ${row.id}: ${outcome.error}`);
  }
}

async function deliverOne(
  store: Store,
  botId: string,
  binding: TelegramBinding,
  transport: TelegramTransport,
  notification: Notification,
  clock: () => Date,
): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> {
  const decisionId = /^decision:(\d+)$/.exec(notification.dedupeKey);
  const decision = decisionId === null ? null : store.getDecision(Number(decisionId[1]));

  if (decision === null || decision.state === "answered") {
    // A plain fact, or a decision settled before the bridge got to it: the
    // text is the message, and there is nothing to press.
    const parts = split(`${notification.subject}\n\n${notification.body}`);
    let last: string | null = null;
    for (const part of parts) {
      const sent = await send(transport, binding.chatId, part);
      if (!sent.ok) return { ok: false, error: sent.error };
      last = sent.messageId;
    }
    return { ok: true, receipt: receiptFor(botId, binding.chatId, last) };
  }

  // A decision. Every safety-bearing word goes out before anything tappable
  // exists: recap, question, and every option's consequence, split across as
  // many plain messages as they need — a button whose warning was truncated
  // away is a trap, so the keyboard rides the LAST part only, and only if
  // every earlier part arrived.
  const taskId = taskOf(store, decision);
  const lines = [
    `${taskId} parked a decision`,
    "",
    decision.recap,
    "",
    `Q: ${decision.question}`,
    "",
    ...decision.options.flatMap(option => [
      `[${option.id}] ${option.label}${option.id === decision.recommendation ? "  (recommended)" : ""}${option.reversible ? "" : "  — IRREVERSIBLE"}`,
      `    ${option.consequence}`,
    ]),
    ...(decision.deadline === null ? [] : ["", `deadline: ${decision.deadline}`]),
  ];
  const parts = split(lines.join("\n"));

  for (const part of parts.slice(0, -1)) {
    const sent = await send(transport, binding.chatId, part);
    if (!sent.ok) return { ok: false, error: sent.error };
  }

  // The buttons: one opaque token per option, minted before the send so a
  // tap can never arrive for a token that does not exist, placed onto the
  // message afterwards so a tap on any OTHER message proves itself stale.
  const tokens = decision.options.map(option => ({
    option,
    token: randomBytes(16).toString("hex"),
  }));
  for (const { option, token } of tokens) {
    store.createTelegramAction(
      {
        token,
        binding: binding.id,
        decision: decision.id,
        optionId: option.id,
        phase: "choose",
        chatId: binding.chatId,
      },
      clock(),
    );
  }
  const keyboard = tokens.map(({ option, token }) => [
    {
      text: `${option.label}${option.id === decision.recommendation ? " ✓" : ""}${option.reversible ? "" : " ⚠"}`,
      callback_data: token,
    },
  ]);
  const last = parts[parts.length - 1] as string;
  const sent = await send(transport, binding.chatId, last, keyboard);
  if (!sent.ok) return { ok: false, error: sent.error };
  if (sent.messageId !== null) {
    store.placeTelegramActions(
      tokens.map(({ token }) => token),
      sent.messageId,
    );
  }
  return { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) };
}

async function send(
  transport: TelegramTransport,
  chatId: string,
  text: string,
  keyboard?: { text: string; callback_data: string }[][],
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  // No parse_mode and no entities, ever: agent text is text. Link previews
  // off: a URL in a recap must not become a fetch.
  const answer = await transport("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
  });
  if (!answer.ok) return { ok: false, error: answer.description ?? "sendMessage failed" };
  const messageId = (answer.result as { message_id?: number } | undefined)?.message_id;
  return { ok: true, messageId: messageId === undefined ? null : String(messageId) };
}

function receiptFor(botId: string, chatId: string, messageId: string | null): string {
  return `telegram:${botId}:${chatId}:${messageId ?? "?"}`;
}

function split(text: string): string[] {
  if (text.length <= PART_CAP) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += PART_CAP) {
    parts.push(text.slice(at, at + PART_CAP));
  }
  return parts;
}

function taskOf(store: Store, decision: Decision): string {
  const run = store.getRun(decision.run);
  return run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
}

// ---- inbound ---------------------------------------------------------------

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number; type?: string };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat?: { id: number } };
  };
};

type Context = {
  store: Store;
  botId: string;
  transport: TelegramTransport;
  clock: () => Date;
  report: BridgeReport;
};

async function drainUpdates(
  store: Store,
  botId: string,
  transport: TelegramTransport,
  owner: string,
  generation: number,
  cursor: number,
  clock: () => Date,
  report: BridgeReport,
  pollSeconds = 0,
  signal?: AbortSignal,
): Promise<void> {
  const context: Context = { store, botId, transport, clock, report };
  let offset = cursor + 1;

  for (let page = 0; page < PAGE_BUDGET; page++) {
    const answer = await transport(
      "getUpdates",
      {
        offset,
        // Only the first page long-polls; a backlog drains at full speed.
        timeout: page === 0 ? pollSeconds : 0,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
    );
    if (!answer.ok) {
      report.problems.push(`getUpdates: ${answer.description ?? "failed"}`);
      return;
    }
    const updates = (answer.result as Update[] | undefined) ?? [];
    if (updates.length === 0) return;

    for (const update of updates) {
      const effects = applyUpdate(context, update);
      // Effects are Telegram-side conveniences — acks, edits, replies. They
      // retry-or-drop; they never decide whether the cursor moves, because
      // an unreachable edit must not make the bridge re-apply an answer.
      for (const effect of effects) {
        try {
          await effect();
        } catch {
          report.problems.push(`a telegram edit/ack failed for update ${update.update_id}`);
        }
      }
      offset = update.update_id + 1;
      store.advanceBridgeCursor(botId, owner, generation, update.update_id, clock());
    }
  }
  // The budget ran out with Telegram still holding pages: said, not hidden.
  report.backlog = true;
}

/**
 * Apply one update in one transaction; return the Telegram-side effects to
 * attempt afterwards. Everything suspicious lands in the same place:
 * `ignored`, silently — an unbound stranger learns nothing, including
 * whether there was anything to learn.
 */
function applyUpdate(context: Context, update: Update): Effect[] {
  const effects: Effect[] = [];
  context.store.transact(() => {
    if (!context.store.markTelegramUpdateApplied(update.update_id, "seen", context.clock())) {
      // Already applied by an earlier pass. The local mutation happened;
      // the edits were attempted then; nothing repeats.
      return;
    }
    if (update.message !== undefined) {
      applyMessage(context, update, effects);
      return;
    }
    if (update.callback_query !== undefined) {
      applyCallback(context, update, effects);
      return;
    }
    context.report.ignored++;
  });
  return effects;
}

function applyMessage(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const pair = /^\/pair\s+([0-9a-f]{32})\s*$/.exec(message.text ?? "");

  // Only /pair, only in a private chat, only with the sender on the record.
  // A group is exactly where "the chat" and "the person" diverge, which is
  // why a group cannot pair at all.
  if (pair === null || chat === undefined || chat.type !== "private" || from === undefined) {
    report.ignored++;
    return;
  }

  const consumed = store.consumeTelegramPairing(
    {
      codeHash: hashPairingCode(pair[1] as string),
      botId,
      chatId: String(chat.id),
      userId: String(from.id),
      updateId: update.update_id,
    },
    clock(),
  );
  if (!consumed.ok) {
    // A wrong code gets the same silence as everything else wrong: replying
    // "no such code" to a guesser is an oracle.
    report.ignored++;
    return;
  }
  report.paired++;
  const chatId = String(chat.id);
  const approver = consumed.binding.approver;
  effects.push(async () => {
    // At-least-once across a crash-after-send window, by design: a repeated
    // "paired" line is annoying; a paired chat that never heard so is worse.
    await transport("sendMessage", {
      chat_id: chatId,
      text: `paired: this chat now answers as ${approver}`,
      link_preview_options: { is_disabled: true },
    });
  });
}

function applyCallback(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const callback = update.callback_query as NonNullable<Update["callback_query"]>;
  const from = callback.from;
  const message = callback.message;
  const token = callback.data ?? "";

  const ack = (text?: string): void => {
    effects.push(async () => {
      await transport("answerCallbackQuery", {
        callback_query_id: callback.id,
        ...(text === undefined ? {} : { text }),
      });
    });
  };
  const editText = (text: string, keyboard?: { text: string; callback_data: string }[][]): void => {
    if (message === undefined) return;
    const chatId = message.chat === undefined ? null : String(message.chat.id);
    const messageId = message.message_id;
    if (chatId === null) return;
    effects.push(async () => {
      await transport("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        link_preview_options: { is_disabled: true },
        ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
      });
    });
  };

  // The person, the chat, and the message must all be the paired ones. A
  // callback with no accessible message (inline mode, too-old messages) is
  // out; so is a tap from anyone but the exact paired user id — usernames
  // change hands, immutable ids do not.
  const binding = store.liveTelegramBinding(botId);
  if (
    binding === null ||
    from === undefined ||
    String(from.id) !== binding.userId ||
    message === undefined ||
    message.chat === undefined ||
    String(message.chat.id) !== binding.chatId
  ) {
    report.ignored++;
    return;
  }

  const action = store.getTelegramAction(token);
  if (
    action === null ||
    action.binding !== binding.id ||
    action.chatId !== binding.chatId ||
    (action.messageId !== null && action.messageId !== String(message.message_id))
  ) {
    // Bound person, dead or foreign button: acknowledged, not acted on.
    ack("that button is stale — nightorders decide shows what still waits");
    report.ignored++;
    return;
  }

  const decision = store.getDecision(action.decision);
  if (decision === null) {
    ack("that decision no longer exists");
    return;
  }
  if (decision.state === "answered") {
    store.consumeTelegramAction(token, clock());
    ack(`already answered: ${decision.choice ?? "?"}`);
    editText(answeredText(store, decision));
    return;
  }

  if (action.phase === "choose") {
    const option = decision.options.find(one => one.id === action.optionId);
    if (option === undefined) {
      ack("that option no longer exists");
      return;
    }
    if (!store.consumeTelegramAction(token, clock())) {
      ack("that button was already used");
      return;
    }

    if (!option.reversible) {
      // The arm. Nothing is answered here: two fresh one-time tokens make a
      // real challenge — a stolen bot token can repaint a keyboard, but it
      // cannot mint a row in this table, so a tap on a forged "confirm"
      // lands in the stale-button branch above.
      const confirm = randomBytes(16).toString("hex");
      const cancel = randomBytes(16).toString("hex");
      const placedOn = String(message.message_id);
      store.createTelegramAction(
        { token: confirm, binding: binding.id, decision: decision.id, optionId: option.id, phase: "confirm", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS },
        clock(),
      );
      store.createTelegramAction(
        { token: cancel, binding: binding.id, decision: decision.id, optionId: option.id, phase: "cancel", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS },
        clock(),
      );
      ack("irreversible — confirm it");
      editText(
        `⚠ ${option.label} is IRREVERSIBLE.\n${option.consequence}\n\nConfirm?`,
        [
          [{ text: `⚠ Yes, ${option.label}`, callback_data: confirm }],
          [{ text: "Cancel", callback_data: cancel }],
        ],
      );
      return;
    }

    answerNow(context, decision, option.id, binding, ack, editText);
    return;
  }

  if (action.phase === "confirm") {
    if (!store.consumeTelegramAction(token, clock())) {
      ack("that confirmation expired — start again from the option");
      return;
    }
    // Re-proved at the moment of commitment, not remembered from the arm.
    const option = decision.options.find(one => one.id === action.optionId);
    if (option === undefined) {
      ack("that option no longer exists");
      return;
    }
    answerNow(context, decision, option.id, binding, ack, editText);
    return;
  }

  // cancel: consume it, kill its sibling confirm, restore the choices.
  store.consumeTelegramAction(token, clock());
  store.consumeTelegramChallenges(decision.id, clock());
  const fresh = decision.options.map(option => ({ option, token: randomBytes(16).toString("hex") }));
  for (const { option, token: choose } of fresh) {
    store.createTelegramAction(
      { token: choose, binding: binding.id, decision: decision.id, optionId: option.id, phase: "choose", chatId: binding.chatId, messageId: String(message.message_id) },
      clock(),
    );
  }
  ack("cancelled");
  editText(
    `Q: ${decision.question}`,
    fresh.map(({ option, token: choose }) => [
      {
        text: `${option.label}${option.id === decision.recommendation ? " ✓" : ""}${option.reversible ? "" : " ⚠"}`,
        callback_data: choose,
      },
    ]),
  );
}

function answerNow(
  context: Context,
  decision: Decision,
  choice: string,
  binding: TelegramBinding,
  ack: (text?: string) => void,
  editText: (text: string, keyboard?: { text: string; callback_data: string }[][]) => void,
): void {
  const { store, clock, report } = context;
  const answered = store.answerDecisionLocked(
    { id: decision.id, choice, by: binding.approver, via: "telegram" },
    clock(),
  );
  if (answered.ok) {
    report.answered++;
    ack(`✓ ${choice}`);
    editText(answeredText(store, answered.decision));
    return;
  }
  if (answered.reason === "already-answered") {
    const settled = store.getDecision(decision.id);
    ack(`already answered: ${settled?.choice ?? "?"} — decided is not negotiable`);
    if (settled !== null) editText(answeredText(store, settled));
    return;
  }
  ack(`could not answer: ${answered.reason}`);
}

function answeredText(store: Store, decision: Decision): string {
  return [
    `✓ ${taskOf(store, decision)} — answered: ${decision.choice ?? "?"}`,
    `by ${decision.answeredBy ?? "?"} via ${decision.answeredVia ?? "?"}`,
    ...(decision.note === null ? [] : [`note: ${decision.note}`]),
  ].join("\n");
}
