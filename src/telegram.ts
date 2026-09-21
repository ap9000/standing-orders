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

import { acceptanceEvidenceText } from "./chat-acceptance.js";
import { verifyApproverStanding } from "./principal.js";
import { resultImageFileName, resultTaskLabel, verifyResultImage } from "./chat-evidence.js";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { validateNote } from "./decision.js";
import { isLifecycleNotification, isTelegramProgressNotification, TELEGRAM_HOLD_REASONS, type Store, type Decision, type Notification, type TelegramBinding, type TelegramDelivery } from "./store.js";
import { telegramProgressCard, type ProgressEntity } from "./telegram-progress.js";
import { applyTeamInbound, deliverTeamChats, teamCommand } from "./telegram-team.js";
import { phoneCommand, phoneStatus, phoneTaskView, PHONE_CONSOLE_FOOTER, PHONE_HELP, notificationIdentity } from "./telegram-status.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import {
  applyProposalTap,
  processTelegramConversations,
  phoneLinkButton,
  type InlineButton,
  replyContextFor,
  telegramConversationRepos,
  telegramRequestId,
  tooLongText,
  whichTaskText,
  type TelegramConversationOptions,
} from "./telegram-mate.js";

/** Read the enrolled project list on demand. No callback means no task data,
 * never an implicit all-database ceiling. Shared by pass and embedded follower. */
export type TelegramReadProjects = () => Promise<readonly string[]>;

/** The environment name — and therefore the name the builder strips from agents. */
export const TOKEN_ENV = "STANDING_ORDERS_TELEGRAM_TOKEN";

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
  /** v64: one verified file to send as multipart — the ONLY way bytes leave. Absent, the call is JSON exactly as before. */
  upload?: TelegramUpload,
) => Promise<{ ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number }; uncertain?: boolean }>;

/**
 * The one typed shape a file takes onto the wire: bytes the caller already
 * verified, under a name and type the caller chose from the verified
 * kind. There is no path, no URL and no `file_id` form here on purpose —
 * Telegram never fetches anything for us, and nothing on this machine is
 * uploaded by name.
 */
export type TelegramUpload = { field: "document"; fileName: string; contentType: "image/png" | "image/jpeg"; bytes: Buffer };

export function createTransport(token: string, timeoutMs = 30_000): TelegramTransport {
  return async (method, params, signal, upload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // A JSON call stays byte for byte what it was. A multipart call lets
      // fetch mint the boundary and the content-type: scalars ride as
      // fields, objects (reply_parameters, reply_markup) as their JSON, and
      // the verified bytes as one Blob under the file name given.
      const request: RequestInit = upload === undefined
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: controller.signal }
        : { method: "POST", body: multipartOf(params, upload), signal: controller.signal };
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, request);
      const body = (await response.json()) as { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } | null;
      // A missing or malformed acknowledgement does not prove a send failed.
      // Only Telegram's explicit rejection is a definite failed delivery.
      if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.ok !== "boolean" || (body.ok && !response.ok)) {
        return { ok: false, description: "Telegram returned an invalid acknowledgement", uncertain: true };
      }
      return {
        ok: body.ok === true,
        result: body.result,
        ...(body.parameters === undefined ? {} : { parameters: body.parameters }),
        // Whatever Telegram said, the token must not be in what we keep.
        ...(typeof body.description !== "string" ? {} : { description: scrub(body.description, token) }),
      };
    } catch (error) {
      return {
        ok: false,
        description: scrub(error instanceof Error ? error.message : String(error), token),
        uncertain: true,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** The multipart body: every param a field (objects as JSON), the file last. Exported for the adapter's own test only. */
export function multipartOf(params: Record<string, unknown>, upload: TelegramUpload): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  form.append(upload.field, new Blob([new Uint8Array(upload.bytes)], { type: upload.contentType }), upload.fileName);
  return form;
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
  /** Free-text notes captured as drafts. */
  noted?: number;
  /** Digests sent this pass (away mode). */
  digests?: number;
  /** Successful replies to read-only phone commands, separate from outbox sends. */
  statusReplies?: number;
  /** Ordinary messages persisted for the shared assistant this pass. */
  chatQueued?: number;
  /** Assistant replies delivered (including a recovered earlier reply). */
  chatAnswered?: number;
  /** Messages settled without a reply from the assistant: refused, failed, unpaired, or answered deterministically. */
  chatRefused?: number;
  /** Proposal cards confirmed by a tap this pass. */
  chatConfirmed?: number;
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
    /** false: inbound only — another channel is primary and carries the
     * pages; taps and replies still land here. */
    deliver?: boolean;
    readProjects?: TelegramReadProjects;
    /** Reload channel configuration before every outbound part. */
    canDeliver?: () => boolean;
    /** Ordinary text talks to the shared assistant. Absent: text that is not a command or a decision note is ignored, as before. */
    conversation?: TelegramConversationOptions;
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
    if (options.deliver !== false) {
      await deliverOutbox(store, botId, transport, owner, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin, options.conversation?.evidenceRoot);
      await deliverTeam(store, botId, transport, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin);
    }
    await drainUpdates(store, botId, transport, owner, lease.generation, lease.cursor, clock, report, 0, undefined, options.readProjects, options.conversation);
    if (options.conversation !== undefined && options.readProjects !== undefined) {
      // The queued turns, outside any transaction. A model turn can outlive
      // the poll lease, so the lease is renewed under the same owner while
      // they run — the follower's own fenced renewal, reused.
      const renew = setInterval(() => { store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock()); }, 30_000);
      renew.unref?.();
      try {
        await processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation);
      } finally {
        clearInterval(renew);
      }
    }
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
  statusReplies?: number;
  chatQueued?: number;
  chatAnswered?: number;
  chatRefused?: number;
  chatConfirmed?: number;
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
    /** false: inbound only; another channel is primary. */
    deliver?: boolean;
    readProjects?: TelegramReadProjects;
    /** Reload channel configuration before every outbound part. */
    canDeliver?: () => boolean;
    /** Ordinary text talks to the shared assistant. */
    conversation?: TelegramConversationOptions;
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
  // Queued turns run BESIDE the poll, never inside a cycle: a long model
  // turn must not stall the long poll, and each cycle's lease re-acquire is
  // the renewal that keeps this the only live poller meanwhile. One
  // processor at a time; its counts land on the totals when it finishes.
  let inFlight: Promise<void> | null = null;
  const kick = (): void => {
    if (inFlight !== null || options.conversation === undefined || options.readProjects === undefined) return;
    const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };
    inFlight = processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation, signal)
      .catch(error => { report.problems.push(`telegram chat: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => {
        inFlight = null;
        if ((report.chatAnswered ?? 0) > 0) total.chatAnswered = (total.chatAnswered ?? 0) + (report.chatAnswered ?? 0);
        if ((report.chatRefused ?? 0) > 0) total.chatRefused = (total.chatRefused ?? 0) + (report.chatRefused ?? 0);
        total.problems.push(...report.problems);
        if ((report.chatAnswered ?? 0) > 0 || (report.chatRefused ?? 0) > 0 || report.problems.length > 0) options.onCycle?.(report);
      });
  };

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
      if (options.deliver !== false) {
        await deliverOutbox(store, botId, transport, owner, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin, options.conversation?.evidenceRoot);
        await deliverTeam(store, botId, transport, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin);
      }
      await drainUpdates(
        store, botId, transport, owner, lease.generation, lease.cursor, clock, report, pollSeconds, signal, options.readProjects, options.conversation,
      );
      kick();

      total.cycles++;
      total.sent += report.sent;
      total.answered += report.answered;
      total.paired += report.paired;
      total.ignored += report.ignored;
      if (report.statusReplies !== undefined) total.statusReplies = (total.statusReplies ?? 0) + report.statusReplies;
      if (report.chatQueued !== undefined) total.chatQueued = (total.chatQueued ?? 0) + report.chatQueued;
      if (report.chatRefused !== undefined) total.chatRefused = (total.chatRefused ?? 0) + report.chatRefused;
      if (report.chatConfirmed !== undefined) total.chatConfirmed = (total.chatConfirmed ?? 0) + report.chatConfirmed;
      total.problems.push(...report.problems);
      if (report.sent > 0 || report.answered > 0 || report.paired > 0 || (report.statusReplies ?? 0) > 0 || (report.chatQueued ?? 0) > 0 || (report.chatRefused ?? 0) > 0 || (report.chatConfirmed ?? 0) > 0 || report.problems.length > 0) {
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
    // A turn in flight finishes on its own bounds (the engine's wall clock);
    // its reply is fenced on the claim and the channel like every other part.
    if (inFlight !== null) await inFlight;
    store.releaseBridgeLease(botId, owner, clock());
  }

  return total;
}

/** The queued turns for one bot, counted onto the pass's report. */
async function processConversations(
  store: Store, botId: string, transport: TelegramTransport, owner: string, clock: () => Date, report: BridgeReport,
  readProjects: TelegramReadProjects, conversation: TelegramConversationOptions, signal?: AbortSignal,
): Promise<void> {
  const chat = { answered: 0, refused: 0, problems: [] as string[] };
  await processTelegramConversations({ store, botId, transport, owner, clock, readProjects, options: conversation, report: chat, ...(signal === undefined ? {} : { signal }) });
  if (chat.answered > 0) report.chatAnswered = (report.chatAnswered ?? 0) + chat.answered;
  if (chat.refused > 0) report.chatRefused = (report.chatRefused ?? 0) + chat.refused;
  report.problems.push(...chat.problems);
}

// ---- outbound --------------------------------------------------------------

type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string; retryAfter?: number };
type OutboundSender = (text: string, keyboard?: InlineButton[][], messageRows?: readonly TelegramDelivery[], entities?: ProgressEntity[]) => Promise<SendResult>;

/** The one button a plain fact may carry: its machine-minted console path
 * under the trusted origin read now — the same road `/task` uses. The label
 * names where the path goes; nothing in it comes from the fact's text. */
function factLinkLabel(path: string): string {
  if (/^\/review\?result=[^&]+&run=\d+&tab=checks$/.test(path)) return "Inspect result";
  if (/^\/chat\?task=[^&]+&result=/.test(path)) return "Open result";
  if (/^\/(?:chat\?task=|t\/)/.test(path)) return "Open task";
  if (/^\/d\//.test(path)) return "Open decision";
  return "Open console";
}

/** Team-conversation traffic to the chats that follow one — after the outbox, under the same delivery switch, never a problem to raise when nothing follows anything. */
async function deliverTeam(
  store: Store, botId: string, transport: TelegramTransport, clock: () => Date, report: BridgeReport,
  readProjects?: TelegramReadProjects, canDeliver?: () => boolean, phoneOrigin?: () => string | null,
): Promise<void> {
  if (store.listTelegramTeamChats(botId).length === 0) return;
  try { if (canDeliver !== undefined && !canDeliver()) return; } catch { return; }
  let projects: readonly string[];
  try { projects = await readProjects?.() ?? []; } catch { report.problems.push("team chats: current project access could not be read"); return; }
  const team = { sent: 0, problems: [] as string[] };
  await deliverTeamChats(store, botId, transport, clock, team, projects, phoneOrigin);
  report.sent += team.sent;
  report.problems.push(...team.problems);
}

async function deliverOutbox(
  store: Store, botId: string, transport: TelegramTransport, owner: string,
  clock: () => Date, report: BridgeReport, readProjects?: TelegramReadProjects,
  canDeliver?: () => boolean, phoneOrigin?: () => string | null, evidenceRoot?: string,
): Promise<void> {
  const bindings = store.liveTelegramBindings(botId);
  if (bindings.length === 0) {
    // Routine progress facts are not a problem to fix: a first pairing
    // starts from now and settles them as history. Anything else pending
    // is named, once per pass, as before.
    if (store.listNotifications("pending").some(row => !isLifecycleNotification(row))) report.problems.push("outbox rows are pending but no chat is paired — `standing-orders bridge telegram pair`");
    return;
  }
  const digest = store.telegramDigest();
  const now = clock();
  const digestDue = digest.everyMs === null || digest.lastSentAt === null || now.getTime() >= new Date(digest.lastSentAt).getTime() + digest.everyMs;
  // Every paired person is a destination of their own: each binding claims
  // and settles its own rows under its own ceiling, in turn.
  for (const binding of bindings) await deliverOutboxTo(store, botId, binding, transport, owner, clock, report, digest, digestDue, readProjects, canDeliver, phoneOrigin, evidenceRoot);
}

async function deliverOutboxTo(
  store: Store, botId: string, binding: TelegramBinding, transport: TelegramTransport, owner: string,
  clock: () => Date, report: BridgeReport, digest: ReturnType<Store["telegramDigest"]>, digestDue: boolean,
  readProjects?: TelegramReadProjects, canDeliver?: () => boolean, phoneOrigin?: () => string | null, evidenceRoot?: string,
): Promise<void> {
  const now = clock();
  const claimed = store.claimTelegramDeliveries(binding, owner, DELIVERY_CLAIM_MS, now, digestDue ? "all" : "urgent");

  // Preserve ID order, flushing earlier routine facts before an urgent task
  // update. An earlier failed/retrying row also fences later rows for that task.
  const groups: TelegramDelivery[][] = [];
  for (const row of claimed) {
    const last = groups[groups.length - 1];
    if (digest.everyMs !== null && !isUrgent(row) && last !== undefined && !isUrgent(last[0]!)) last.push(row);
    else groups.push([row]);
  }
  for (const group of groups) {
    let projects: readonly string[] = [];
    const readAccess = async (): Promise<string | null> => {
      try { projects = await readProjects?.() ?? []; }
      catch { return "Current Telegram delivery access could not be read"; }
      return null;
    };
    const channelProblem = (): string | null => {
      try {
        if (canDeliver !== undefined && !canDeliver()) return TELEGRAM_HOLD_REASONS.disabled;
      } catch { return "Current Telegram delivery access could not be read"; }
      return null;
    };
    const retryAt = (): string => [store.telegramRetryAt(botId), new Date(clock().getTime() + 1_000).toISOString()].sort().at(-1)!;

    // Partition before anything is sent: a row without live authority is
    // retained with its reason, and the rows that ARE eligible go out now
    // rather than waiting on it. Walking in ID order with the eligible set
    // as the batch keeps a task's later facts behind its blocked earlier one.
    const rows: TelegramDelivery[] = [];
    const blocked: { row: TelegramDelivery; error: string }[] = [];
    const preflight = (await readAccess()) ?? channelProblem();
    for (const row of group) {
      const problem = preflight ?? store.telegramDeliveryProblem(row, binding, owner, projects, clock(), [...rows.map(one => one.id), row.id]);
      if (problem === null) rows.push(row);
      else blocked.push({ row, error: problem });
    }
    store.transact(() => {
      for (const { row, error } of blocked) store.finalizeTelegramDelivery(row, binding, owner, { ok: false, error, retryAt: retryAt() }, clock());
    });
    for (const { row, error } of blocked) report.problems.push(`notification ${row.id}: ${error}`);
    if (rows.length === 0) continue;

    const ids = rows.map(row => row.id);
    const fence = (): string | null => {
      const channel = channelProblem();
      if (channel !== null) return channel;
      for (const row of rows) {
        const problem = store.telegramDeliveryProblem(row, binding, owner, projects, clock(), ids);
        if (problem !== null) return problem;
      }
      return null;
    };
    const sender: OutboundSender = async (text, keyboard, messageRows = rows, entities) => {
      // Finish every await before the synchronous fence and transport call.
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const sent = await send(transport, binding.chatId, text, keyboard, entities);
      if (!sent.ok) {
        if (sent.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + sent.retryAfter * 1_000).toISOString());
        return sent;
      }
      if (sent.messageId === null) return { ok: false, error: "Telegram returned no confirmed message identity" };
      for (const row of messageRows) store.recordTelegramMessage(row, binding, sent.messageId, clock());
      // Keep the old message's history but never acknowledge a replaced pairing.
      const after = (await readAccess()) ?? fence();
      return after === null ? sent : { ok: false, error: after };
    };
    const imageSender = async (row: TelegramDelivery): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> => {
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const match = /^life:acceptance-evidence:r(\d+)-a(\d+)-([a-f0-9]{64}):\d+$/.exec(row.dedupeKey);
      if (match === null || row.taskId === null || row.run === null || store.getRun(Number(match[1]))?.parentRun !== row.run) return { ok: false, error: "Screenshot notification does not match its recorded review" };
      const family = store.taskFamilyOf(row.taskId, projects, false);
      const current = family?.current.id === row.taskId && store.runsFor(row.taskRef!).find(one => one.finishedAt !== null && ["builder", "repair", "scout"].includes(one.role))?.id === row.run;
      const skip = store.proofAcceptance(row.run) !== null ? "Acceptance is already recorded; no further acceptance is needed." : !current ? "A newer result is current. Request its evidence before accepting." : null;
      const verified = evidenceRoot === undefined ? { ok: false as const, problem: "the bridge cannot read evidence files" } : verifyResultImage(store, evidenceRoot, telegramConversationRepos(store, binding.approver, projects), { taskId: row.taskId, run: row.run, artifact: Number(match[2]), sha256: match[3]! });
      if (skip !== null) return { ok: true, receipt: store.proofAcceptance(row.run) !== null ? "skipped:already-accepted" : "skipped:newer-result" };
      if (!verified.ok) {
        const sent = await sender(`A screenshot for result #${row.run} could not be sent: ${verified.problem}. Inspect the result before accepting.`);
        return sent.ok ? { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) } : sent;
      }
      // No await between the access fence, file validation and upload.
      let answer: Awaited<ReturnType<TelegramTransport>>;
      try { answer = await transport("sendDocument", { chat_id: binding.chatId, caption: `${resultTaskLabel(row.taskId)} · result #${row.run} · screenshot for acceptance` }, undefined, {
        field: "document", bytes: verified.bytes, contentType: verified.format === "png" ? "image/png" : "image/jpeg", fileName: resultImageFileName(row.taskId, row.run, Number(match[2]), verified.format),
      });
      } catch { return { ok: false, error: "Screenshot delivery is unconfirmed; retry may duplicate it" }; }
      const messageId = (answer.result as { message_id?: number } | undefined)?.message_id;
      if (!answer.ok || !Number.isSafeInteger(messageId)) {
        if (answer.parameters?.retry_after !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + answer.parameters.retry_after * 1000).toISOString());
        return { ok: false, error: answer.uncertain || (answer.ok && messageId == null) ? "Screenshot delivery is unconfirmed; retry may duplicate it" : "Telegram did not accept the screenshot" };
      }
      store.recordTelegramMessage(row, binding, String(messageId), clock());
      const after = (await readAccess()) ?? fence();
      return after === null ? { ok: true, receipt: receiptFor(botId, binding.chatId, String(messageId)) } : { ok: false, error: after };
    };
    const batched = digest.everyMs !== null && !isUrgent(rows[0]!);
    const row = rows[0]!;
    const progressRun = batched ? null : store.telegramProgressRun(row);
    const progress = progressRun !== null && isTelegramProgressNotification(row);
    const updateProgress = async (onlyExisting: boolean): Promise<SendResult | null> => {
      if (progressRun === null || row.taskId === null || row.project === null) return null;
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const messageId = store.telegramProgressMessage(binding, progressRun);
      if (messageId === null && onlyExisting) return null;
      const card = telegramProgressCard(store, store.getRun(progressRun.id)!, row.taskId, row.project, clock(), evidenceRoot);
      let button: InlineButton[] | null = null;
      try { button = phoneLinkButton(phoneOrigin?.() ?? null, card.link); } catch { /* No trusted origin. */ }
      const keyboard = button === null ? [] : [button];
      if (messageId === null) return sender(card.text, keyboard, rows, card.entities);
      const edited = await editProgress(transport, binding.chatId, messageId, card.text, keyboard, card.entities);
      if (!edited.ok) {
        if (edited.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + edited.retryAfter * 1000).toISOString());
        // Only Telegram's definitive missing/uneditable response permits a
        // replacement. Timeouts, rate limits and uncertain edits retry in place.
        if (!onlyExisting && edited.replace) return sender(card.text, keyboard, rows, card.entities);
        return edited;
      }
      if (!onlyExisting) store.recordTelegramMessage(row, binding, messageId, clock());
      const after = (await readAccess()) ?? fence();
      return after === null ? edited : { ok: false, error: after };
    };
    // A failure or decision still gets its own alert. Refresh an existing
    // card first so it does not keep saying the build is running.
    if (!progress && progressRun !== null) await updateProgress(true);
    const updated = progress ? await updateProgress(false) : null;
    const outcome = updated !== null ? updated.ok ? { ok: true as const, receipt: receiptFor(botId, binding.chatId, updated.messageId) } : updated
      : rows[0]!.kind === "acceptance-evidence" ? await imageSender(rows[0]!) : batched
      ? await deliverDigest(botId, binding, sender, rows, digest.lastSentAt, clock)
      : await deliverOne(store, botId, binding, sender, rows[0]!, clock, phoneOrigin, evidenceRoot, projects);
    const finalProblem = outcome.ok ? (await readAccess()) ?? fence() : null;
    const settled = finalProblem === null ? outcome : { ok: false as const, error: finalProblem };
    // A skipped screenshot settles its row but nothing reached the phone.
    const skipped = settled.ok && settled.receipt !== null && settled.receipt.startsWith("skipped:");
    const finalized = store.transact(() => {
      let count = 0;
      for (const row of rows) {
        const result = settled.ok ? settled : { ...settled, retryAt: retryAt() };
        if (store.finalizeTelegramDelivery(row, binding, owner, result, clock()) && settled.ok) count++;
      }
      if (batched && count === rows.length) store.markTelegramDigestSent(clock());
      return count;
    });
    if (!skipped) report.sent += finalized;
    if (batched && finalized === rows.length) report.digests = (report.digests ?? 0) + 1;
    if (!settled.ok) report.problems.push(`${batched ? `digest of ${rows.length} notification(s)` : `notification ${rows[0]!.id}`}: ${settled.error}`);
    else if (finalized !== rows.length) report.problems.push("Telegram delivery claim expired before acknowledgement; retry may duplicate a message");
  }
}

/** What pages singly whatever the cadence: a decision, or an attention-class fact. */
function isUrgent(notification: Notification): boolean {
  return /^decision:\d+$/.test(notification.dedupeKey) || notification.pushClass === "attention" || notification.kind === "acceptance-evidence" || notification.kind === "acceptance-ready";
}

/** The digest text: a header with the count and the window, then one
 * fact per entry — its subject, then its body's first line, indented.
 * Plain text, no buttons: nothing in a digest is tappable. */
export function digestText(rows: readonly Notification[], since: string | null, now: Date): string {
  const window = since === null ? "" : ` since ${since.slice(0, 16).replace("T", " ")}`;
  const lines = [`digest — ${rows.length} routine fact(s)${window} (as of ${now.toISOString().slice(0, 16).replace("T", " ")})`, ""];
  for (const row of rows) {
    lines.push(digestEntry(row));
  }
  return lines.join("\n");
}

function digestEntry(row: Notification): string {
  const first = row.body.split("\n").map(one => one.trim()).find(one => one !== "");
  const body = first === undefined ? "" : `\n    ${first.length > 200 ? `${first.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "")}…` : first}`;
  return `• ${notificationIdentity(row)}${row.subject}${body}`;
}

async function deliverDigest(
  botId: string, binding: TelegramBinding, sender: OutboundSender,
  rows: readonly TelegramDelivery[], since: string | null, clock: () => Date,
): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> {
  const text = digestText(rows, since, clock());
  // Track the exact rows represented by each text part. A split row may bind
  // several messages; a digest message may bind several rows.
  let offset = text.indexOf("\n\n") + 2;
  const spans = rows.map(row => {
    const length = digestEntry(row).length;
    const span = { row, start: offset, end: offset + length };
    offset += length + 1;
    return span;
  });
  let last: string | null = null;
  let at = 0;
  for (const part of split(text)) {
    const related = spans.filter(span => span.start < at + part.length && span.end > at).map(span => span.row);
    const sent = await sender(part, undefined, related);
    if (!sent.ok) return sent;
    last = sent.messageId;
    at += part.length;
  }
  return { ok: true, receipt: receiptFor(botId, binding.chatId, last) };
}

async function deliverOne(
  store: Store,
  botId: string,
  binding: TelegramBinding,
  sender: OutboundSender,
  notification: TelegramDelivery,
  clock: () => Date,
  phoneOrigin?: () => string | null,
  evidenceRoot?: string,
  projects: readonly string[] = [],
): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> {
  const decisionId = /^decision:(\d+)$/.exec(notification.dedupeKey);
  const decision = decisionId === null ? null : store.getDecision(Number(decisionId[1]));

  if (decision !== null && (notification.taskRef === null || store.getRun(decision.run)?.taskRef !== notification.taskRef || (notification.run !== null && notification.run !== decision.run))) {
    return { ok: false, error: "Decision does not match notification provenance" };
  }

  if (decision === null || decision.state === "answered") {
    // A plain fact, or a decision settled before the bridge got to it: the
    // text is the message. Its one next-action button — the fact's
    // machine-minted link under the trusted origin read now, never a token
    // and never persisted — rides the LAST part only, exactly as `/task`'s
    // does; with no trusted origin the words stand alone.
    const alreadyAccepted = notification.kind === "acceptance-ready" && notification.run !== null && store.proofAcceptance(notification.run) !== null;
    let body = alreadyAccepted ? "This result already has recorded human acceptance. No further acceptance is needed." : notification.body;
    let current = true;
    if (notification.kind === "acceptance-ready" && !alreadyAccepted && notification.taskId !== null && notification.run !== null) {
      const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, telegramConversationRepos(store, binding.approver, projects));
      if (!principal.ok) return { ok: false, error: "Current acceptance evidence access could not be verified" };
      const packet = acceptanceEvidenceText(store, principal.who, evidenceRoot, notification.taskId, notification.run);
      if (!packet.ok) { body = `Acceptance evidence unavailable: ${packet.message}`; current = false; }
      else if (!packet.isCurrent) { body = "A newer result is current. Request its evidence before accepting."; current = false; }
      else body = `${packet.text}\n\n${notification.body}`;
    }
    const parts = split(`${notificationIdentity(notification)}${alreadyAccepted ? "Acceptance recorded" : notification.subject}\n\n${body}`);
    let button: InlineButton[] | null = null;
    if (notification.link !== null && !alreadyAccepted && current) {
      try { button = phoneLinkButton(phoneOrigin?.() ?? null, { label: factLinkLabel(notification.link), path: notification.link }); }
      catch { button = null; }
    }
    let last: string | null = null;
    for (const [index, part] of parts.entries()) {
      const sent = await sender(part, index === parts.length - 1 && button !== null ? [button] : undefined);
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
  const lines = [
    `${notificationIdentity(notification)}Decision needed`,
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
    const sent = await sender(part);
    if (!sent.ok) return { ok: false, error: sent.error };
    // Every part is a message somebody may REPLY to with a note: each id
    // routes to this decision, exactly (Codex free-text review, finding 1).
    if (sent.messageId !== null) {
      store.recordTelegramDecisionMessage(binding.id, binding.chatId, sent.messageId, decision.id, clock());
    }
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
  const sent = await sender(last, keyboard);
  if (!sent.ok) return { ok: false, error: sent.error };
  if (sent.messageId !== null) {
    store.placeTelegramActions(
      tokens.map(({ token }) => token),
      sent.messageId,
    );
    store.recordTelegramDecisionMessage(binding.id, binding.chatId, sent.messageId, decision.id, clock());
  }
  return { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) };
}

async function send(
  transport: TelegramTransport,
  chatId: string,
  text: string,
  keyboard?: InlineButton[][],
  entities?: ProgressEntity[],
): Promise<SendResult> {
  // No markup parsing. Only machine-selected heading ranges may be bold;
  // agent text remains literal and URLs never trigger link previews.
  let answer: Awaited<ReturnType<TelegramTransport>>;
  try {
    answer = await transport("sendMessage", {
      chat_id: chatId,
      text,
      ...(entities === undefined ? {} : { entities }),
      link_preview_options: { is_disabled: true },
      ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
    });
  } catch { return { ok: false, error: "Telegram transport failed; delivery may be uncertain" }; }
  if (!answer.ok) {
    const retry = answer.parameters?.retry_after;
    return { ok: false, error: answer.description ?? "sendMessage failed", ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? { retryAfter: Math.ceil(retry) } : {}) };
  }
  const messageId = (answer.result as { message_id?: number } | undefined)?.message_id;
  return { ok: true, messageId: Number.isSafeInteger(messageId) && messageId! > 0 ? String(messageId) : null };
}

async function editProgress(transport: TelegramTransport, chatId: string, messageId: string, text: string, keyboard: InlineButton[][], entities?: ProgressEntity[]): Promise<SendResult & { replace?: boolean }> {
  let answer: Awaited<ReturnType<TelegramTransport>>;
  try {
    answer = await transport("editMessageText", { chat_id: chatId, message_id: Number(messageId), text, ...(entities === undefined ? {} : { entities }),
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } });
  } catch { return { ok: false, error: "Telegram progress update is unconfirmed; it will retry in place" }; }
  // The retry may be repainting the same bytes after an acknowledgement was
  // lost. Telegram's explicit unchanged response confirms this target state.
  if (!answer.ok && !answer.uncertain && /^Bad Request: message is not modified\b/i.test(answer.description ?? "")) return { ok: true, messageId };
  if (!answer.ok) {
    const retry = answer.parameters?.retry_after;
    return { ok: false, error: answer.description ?? "Telegram progress update failed",
      ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? { retryAfter: Math.ceil(retry) } : {}),
      replace: !answer.uncertain && /^Bad Request: message (?:to edit not found|can't be edited)$/i.test(answer.description ?? "") };
  }
  const confirmed = (answer.result as { message_id?: number } | undefined)?.message_id;
  return String(confirmed) === messageId ? { ok: true, messageId } : { ok: false, error: "Telegram did not confirm the progress message identity" };
}

function receiptFor(botId: string, chatId: string, messageId: string | null): string {
  return `telegram:${botId}:${chatId}:${messageId ?? "?"}`;
}

function split(text: string): string[] {
  if (text.length <= PART_CAP) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + PART_CAP, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
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
    reply_to_message?: { message_id: number };
    /** Presence of any of these disqualifies a note: only direct, initial,
     * plain text counts as authored-and-confirmed by the paired operator. */
    forward_origin?: unknown;
    forward_date?: unknown;
    via_bot?: unknown;
    sender_chat?: unknown;
    caption?: string;
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
  readProjects?: TelegramReadProjects | undefined;
  conversation?: TelegramConversationOptions | undefined;
  /** The enrolled ceiling read for THIS update, when a proposal tap needs it; null when it could not be read. */
  projects: readonly string[] | null;
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
  readProjects?: TelegramReadProjects,
  conversation?: TelegramConversationOptions,
): Promise<void> {
  const context: Context = { store, botId, transport, clock, report, readProjects, conversation, projects: null };
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
      // A proposal tap confirms as a principal minted against the CURRENT
      // enrolled ceiling, and the registry is a file read: it happens
      // before the update's transaction, and only once the envelope has
      // proved the exact paired sender and chat — a stranger reads nothing.
      context.projects = update.message !== undefined ? await enrolledForMessage(context, update) : await projectsForTap(context, update);
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

/** The enrolled registry, read before a message is applied: the team layer
 * scopes leads and conversations to it (each person's own access is checked
 * inside the domain). Unreadable reads as null, and the personal paths stay
 * exactly as they were. */
async function enrolledForMessage(context: Context, update: Update): Promise<readonly string[] | null> {
  const message = update.message;
  if (message?.chat === undefined || message.from === undefined || message.text === undefined || context.readProjects === undefined) return null;
  // An untrusted envelope reads nothing: the sender must be paired, the
  // text plain and direct, and the chat either that person's own private
  // chat or a group that follows (or is being pointed at) a conversation.
  if (message.forward_origin !== undefined || message.forward_date !== undefined || message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined) return null;
  const binding = context.store.liveTelegramBindingFor(context.botId, String(message.from.id));
  if (binding === null) return null;
  const chatId = String(message.chat.id);
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  const trusted = isGroup
    ? context.store.telegramTeamChat(context.botId, chatId)?.kind === "group" || teamCommand(message.text) !== null
    : message.chat.type === "private" && chatId === binding.chatId;
  if (!trusted) return null;
  try { return await context.readProjects(); } catch { return null; }
}

async function projectsForTap(context: Context, update: Update): Promise<readonly string[] | null> {
  const callback = update.callback_query;
  if (callback === undefined || context.conversation === undefined || context.readProjects === undefined) return null;
  const binding = callback.from === undefined ? null : context.store.liveTelegramBindingFor(context.botId, String(callback.from.id));
  if (
    binding === null || callback.from === undefined ||
    callback.message?.chat === undefined || String(callback.message.chat.id) !== binding.chatId ||
    context.store.getTelegramProposalAction(callback.data ?? "") === null
  ) return null;
  try {
    return telegramConversationRepos(context.store, binding.approver, await context.readProjects());
  } catch {
    return null;
  }
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

  if (pair === null && chat !== undefined && from !== undefined) {
    // The team layer first: `/team` anywhere, everything in a followed
    // group, and a private chat that chose a conversation. Its replies ride
    // the same post-commit effects as every other answer.
    const consumed = applyTeamInbound({
      store, botId, now: clock(), report, projects: context.projects, phoneOrigin: context.conversation?.phoneOrigin, updateId: update.update_id, message,
      say: (chatId, text, keyboard) => {
        effects.push(async () => {
          await transport("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id },
            ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }) });
        });
      },
    });
    if (consumed) return;
    // Replies to decisions retain their existing note meaning, even if the
    // note starts with a slash. New read commands are direct messages only.
    if (message.reply_to_message === undefined && applyPhoneRead(context, update, effects)) return;
    // A reply to a decision message this bot sent is a note, exactly as
    // before. Everything else that is ordinary text talks to the shared
    // assistant when a conversation is configured; otherwise silence.
    const binding = store.liveTelegramBindingFor(botId, String(from.id));
    const repliedDecision = binding !== null && message.reply_to_message !== undefined
      ? store.decisionForTelegramMessage(binding.id, binding.chatId, String(message.reply_to_message.message_id))
      : null;
    if (repliedDecision === null && context.conversation !== undefined && context.readProjects !== undefined) {
      applyConversation(context, update, effects);
      return;
    }
    applyNote(context, update, effects);
    return;
  }

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
      text: `paired: this chat now answers as ${approver}\n\nSend /status to check recent work, /task <id> for one task, or /help for your options.`,
      link_preview_options: { is_disabled: true },
    });
  });
}

/**
 * An ordinary message from the paired person: persisted for the shared
 * assistant in THIS transaction — before the cursor moves — with the exact
 * binding, sender, update, message and the request identity the engine
 * receipts its turn under. Two things are answered here and now without a
 * model: text over the engine's bound (never truncated), and a reply to a
 * message that carried several tasks (never guessed). Everything hostile is
 * silence, as for every other inbound shape.
 */
function applyConversation(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));
  if (
    binding === null || store.accountOf(binding.approver)?.role !== "approver" ||
    chat === undefined || chat.type !== "private" || String(chat.id) !== binding.chatId ||
    from === undefined ||
    message.text === undefined ||
    message.forward_origin !== undefined || message.forward_date !== undefined ||
    message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined
  ) {
    report.ignored++;
    return;
  }
  const say = (text: string): void => {
    effects.push(async () => {
      await transport("sendMessage", {
        chat_id: binding.chatId,
        text,
        reply_parameters: { message_id: message.message_id },
        link_preview_options: { is_disabled: true },
      });
    });
  };
  const text = message.text.trim();
  if (text === "") {
    report.ignored++;
    return;
  }
  if (text.length > MATE_MESSAGE_MAX_CHARS) {
    say(tooLongText(text.length));
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return;
  }
  // A reply binds to what the replied-to message carried: exactly one task
  // (and its run) pins the turn; several ask which; none is a plain turn.
  let context_: string | null = null;
  let taskId: string | null = null;
  let sourceRun: number | null = null;
  const replyTo = message.reply_to_message === undefined ? null : String(message.reply_to_message.message_id);
  if (replyTo !== null) {
    const bindings = store.telegramMessageBindings(binding, replyTo).filter(one => one.taskId !== null);
    const tasks = [...new Set(bindings.map(one => one.taskId as string))];
    if (tasks.length > 1) {
      say(whichTaskText(tasks));
      report.chatRefused = (report.chatRefused ?? 0) + 1;
      return;
    }
    if (tasks.length === 1) {
      taskId = tasks[0] as string;
      sourceRun = bindings.find(one => one.run !== null)?.run ?? null;
      context_ = replyContextFor(taskId, sourceRun);
    }
  }
  store.enqueueTelegramConversation(
    {
      binding, updateId: update.update_id, messageId: String(message.message_id), replyTo,
      request: telegramRequestId(botId, binding.id, update.update_id), text, context: context_, taskId, sourceRun,
    },
    clock(),
  );
  report.chatQueued = (report.chatQueued ?? 0) + 1;
}

function applyPhoneRead(context: Context, update: Update, effects: Effect[]): boolean {
  const { store, botId, transport, clock, report } = context;
  const message = update.message!;
  const command = phoneCommand(message.text ?? "");
  if (command === null) return false;
  const binding = message.from === undefined ? null : store.liveTelegramBindingFor(botId, String(message.from.id));
  if (
    binding === null || store.accountOf(binding.approver)?.role !== "approver" ||
    message.chat?.type !== "private" || String(message.chat.id) !== binding.chatId ||
    message.from === undefined ||
    message.forward_origin !== undefined || message.forward_date !== undefined ||
    message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined
  ) {
    report.ignored++;
    return true;
  }
  // Like decision-message edits, a read reply is best-effort after the update
  // was consumed. A crash or send failure cannot turn replay into a new action.
  effects.push(async () => {
    const stillPaired = (): boolean => {
      const live = store.liveTelegramBindingById(binding.id);
      return live !== null && live.approverGeneration === binding.approverGeneration && store.accountOf(binding.approver)?.role === "approver";
    };
    if (!stillPaired()) return;
    let response = PHONE_HELP;
    // `/task` may carry ONE url button to the exact recorded task or result:
    // minted from the trusted origin read now, never persisted, never a token.
    let button: InlineButton[] | null = null;
    if (command.kind !== "help") {
      try {
        // The registry, then — after the await — the pairing again and the
        // account's OWN ceiling over it: a project this approver was never
        // given, or lost since, is not read, named or linked from here.
        const registry = await context.readProjects?.() ?? [];
        if (!stillPaired()) return;
        const repos = telegramConversationRepos(store, binding.approver, registry);
        if (command.kind === "status") response = phoneStatus(store, repos, clock());
        else {
          const view = phoneTaskView(store, repos, command.id, clock());
          button = phoneLinkButton(context.conversation?.phoneOrigin?.() ?? null, view.link);
          // A destination with no trusted origin to carry it: the words say where instead.
          response = button === null && view.link !== null ? `${view.text}\n\n${PHONE_CONSOLE_FOOTER}` : view.text;
        }
      } catch {
        // No registry paths, SQLite errors, credentials, or stale snapshots
        // leave on the failure road. A new request can try again.
        response = "I couldn't read the current project status. No tasks were changed. Try /status again; if it persists, check Standing Orders on the computer.";
        report.problems.push("phone status could not read the current project records");
      }
    }
    if (!stillPaired()) return;
    // Each view fits one message. Fail visibly if a future change violates
    // that contract, rather than cutting off the important next action.
    if (response.length > PART_CAP) {
      response = "This status is too large for one phone message. Open the console for the full view, or send /task <id> for one task.";
      report.problems.push("phone status exceeded its message bound");
    }
    const sent = await transport("sendMessage", {
      chat_id: binding.chatId,
      text: response,
      reply_parameters: { message_id: message.message_id },
      link_preview_options: { is_disabled: true },
      ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }),
    });
    if (sent.ok) report.statusReplies = (report.statusReplies ?? 0) + 1;
    else report.problems.push(`phone status reply failed for update ${update.update_id}; send a new command to retry`);
  });
  return true;
}

/**
 * A free-text note, accepted only as an AUTHENTICATED REPLY to a recorded
 * decision message (Codex free-text review, prescribed design): live
 * binding, private chat, exact chat AND user, a reply_to that maps to
 * exactly one decision this bot sent, the decision still unanswered, and
 * direct initial plain text — no forwards, media, captions, bots, or
 * channel identities. Everything else is silence: a reply naming what was
 * wrong is an oracle. Choice stays TAP-ONLY; prose never selects an option.
 */
function applyNote(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));

  const say = (text: string): void => {
    effects.push(async () => {
      await transport("sendMessage", {
        chat_id: String(chat?.id ?? ""),
        text,
        reply_parameters: { message_id: message.message_id },
        link_preview_options: { is_disabled: true },
      });
    });
  };

  if (
    binding === null ||
    chat === undefined || chat.type !== "private" ||
    from === undefined ||
    String(chat.id) !== binding.chatId ||
    message.reply_to_message === undefined ||
    message.text === undefined ||
    message.forward_origin !== undefined ||
    message.forward_date !== undefined ||
    message.via_bot !== undefined ||
    message.sender_chat !== undefined ||
    message.caption !== undefined
  ) {
    report.ignored++;
    return;
  }

  const decisionId = store.decisionForTelegramMessage(
    binding.id,
    binding.chatId,
    String(message.reply_to_message.message_id),
  );
  if (decisionId === null) {
    // A reply to something that never carried a decision — including a
    // send whose record was lost: fail closed, never guess by recency.
    report.ignored++;
    return;
  }
  const decision = store.getDecision(decisionId);
  if (decision === null) {
    report.ignored++;
    return;
  }
  if (decision.state === "answered") {
    say(`already answered: ${decision.choice ?? "?"} — this note did not travel`);
    report.ignored++;
    return;
  }

  const valid = validateNote(message.text);
  if (!valid.ok) {
    say(`that note cannot travel: ${valid.problem}`);
    report.ignored++;
    return;
  }

  const saved = store.saveNoteDraft(
    {
      binding: binding.id,
      decision: decision.id,
      updateId: update.update_id,
      messageId: String(message.message_id),
      replyTo: String(message.reply_to_message.message_id),
      note: valid.note,
    },
    clock(),
  );
  if (!saved) {
    // An older or equal update raced in late: the newer note stands.
    report.ignored++;
    return;
  }
  // A new note voids any ARMED irreversible confirmation: what it showed
  // is no longer what would travel (Codex free-text review, finding 3).
  store.consumeTelegramChallenges(decision.id, clock());
  report.noted = (report.noted ?? 0) + 1;
  // The echo IS the ceremony: the exact captured text, line-prefixed, so a
  // later edit of the operator's own message cannot rewrite the audit.
  say(
    [
      `noted for ${taskOf(store, decision)}:`,
      ...valid.note.split("\n").map((line: string) => `| ${line}`),
      "",
      "Tap an option on the decision to answer WITH this note. It expires in 10 minutes; a new reply replaces it.",
    ].join("\n"),
  );
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
  const editText = (text: string, keyboard?: InlineButton[][]): void => {
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
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));
  const tapChat = message?.chat === undefined ? null : String(message.chat.id);
  const followedGroup = tapChat !== null && binding !== null && tapChat !== binding.chatId && store.telegramTeamChat(botId, tapChat)?.kind === "group";
  if (
    binding === null ||
    from === undefined ||
    message === undefined ||
    message.chat === undefined ||
    (tapChat !== binding.chatId && !followedGroup)
  ) {
    report.ignored++;
    return;
  }

  const action = store.getTelegramAction(token);
  if (action === null && context.conversation !== undefined && store.getTelegramProposalAction(token) !== null) {
    // A proposal card's button: the shared confirm door, inside this
    // update's transaction, with the stop's process signal deferred to
    // after its commit (the door's own ordering, preserved from here).
    const tapped = applyProposalTap(store, binding, token, message, context.projects, context.conversation, clock());
    for (const effect of tapped.effects) {
      if (effect.kind === "ack") ack(effect.text);
      else if (effect.kind === "edit") editText(effect.text, effect.keyboard);
      else effects.push(async () => { effect.run(); });
    }
    if (tapped.confirmed) report.chatConfirmed = (report.chatConfirmed ?? 0) + 1;
    if (tapped.ignored) report.ignored++;
    return;
  }
  if (
    action === null ||
    action.binding !== binding.id ||
    action.chatId !== binding.chatId ||
    (action.messageId !== null && action.messageId !== String(message.message_id))
  ) {
    // Bound person, dead or foreign button: acknowledged, not acted on.
    ack("that button is stale — standing-orders decide shows what still waits");
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
    if (expiredDraftGuard(store, binding, decision.id, clock())) {
      // The token is NOT consumed: the same button answers on the next tap,
      // now that the operator knows the note is gone.
      ack("your note expired — tap again to answer without it, or reply with a fresh note first");
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
      // The confirmation binds the EXACT answer tuple: option AND the note
      // it displays (its digest; null when none). A note that changes,
      // expires, or is cancelled strands this challenge (finding 3).
      const draft = store.liveNoteDraft(binding.id, decision.id, clock());
      const digest = draft === null ? undefined : noteDigestOf(draft.note);
      if (draft !== null) store.setNoteDraftState(draft.id, "armed");
      store.createTelegramAction(
        { token: confirm, binding: binding.id, decision: decision.id, optionId: option.id, phase: "confirm", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS, ...(digest === undefined ? {} : { noteDigest: digest }) },
        clock(),
      );
      store.createTelegramAction(
        { token: cancel, binding: binding.id, decision: decision.id, optionId: option.id, phase: "cancel", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS },
        clock(),
      );
      ack("irreversible — confirm it");
      editText(
        `⚠ ${option.label} is IRREVERSIBLE.\n${option.consequence}\n${
          draft === null ? "" : `\nWith your note:\n${draft.note.split("\n").map(line => `| ${line}`).join("\n")}\n`
        }\nConfirm?`,
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
    // The tuple the challenge displayed must still be the tuple that
    // travels: the CURRENT live draft's digest (or none) must equal what
    // was armed. Anything else strands the yes (finding 3).
    const current = store.liveNoteDraft(binding.id, decision.id, clock());
    const currentDigest = current === null ? null : noteDigestOf(current.note);
    if ((action.noteDigest ?? null) !== currentDigest) {
      store.consumeTelegramChallenges(decision.id, clock());
      ack("the note changed since this confirmation — read it again and re-arm");
      return;
    }
    answerNow(context, decision, option.id, binding, ack, editText);
    return;
  }

  // cancel: consume it, kill its sibling confirm, discard the note draft
  // (cancel means cancelled — the note it displayed dies with it), and
  // restore the choices.
  store.consumeTelegramAction(token, clock());
  store.consumeTelegramChallenges(decision.id, clock());
  {
    const draft = store.liveNoteDraft(binding.id, decision.id, clock());
    if (draft !== null) store.setNoteDraftState(draft.id, "discarded");
  }
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
  editText: (text: string, keyboard?: InlineButton[][]) => void,
): void {
  const { store, clock, report } = context;
  // The live draft is the note that travels — consumed WITH the answer in
  // the same transaction the whole update already holds; a CAS loss
  // discards it (Codex free-text review, finding 4: never choose-then-note).
  const draft = store.liveNoteDraft(binding.id, decision.id, clock());
  const answered = store.answerDecisionLocked(
    { id: decision.id, choice, by: binding.approver, via: "telegram", ...(draft === null ? {} : { note: draft.note }) },
    clock(),
  );
  if (answered.ok) {
    if (draft !== null) store.setNoteDraftState(draft.id, "consumed");
    report.answered++;
    ack(`✓ ${choice}${draft === null ? "" : " — with your note"}`);
    editText(answeredText(store, answered.decision));
    return;
  }
  if (answered.reason === "already-answered") {
    if (draft !== null) store.setNoteDraftState(draft.id, "discarded");
    const settled = store.getDecision(decision.id);
    ack(`already answered: ${settled?.choice ?? "?"}${draft === null ? "" : " — your note did NOT travel"}`);
    if (settled !== null) editText(answeredText(store, settled));
    return;
  }
  ack(`could not answer: ${answered.reason}`);
}

function answeredText(store: Store, decision: Decision): string {
  return [
    `✓ ${taskOf(store, decision)} — answered: ${decision.choice ?? "?"}`,
    `by ${decision.answeredBy ?? "?"} via ${decision.answeredVia ?? "?"}`,
    // Line-prefixed, never inline: a multiline note must not be able to
    // draw fake status lines (Codex free-text review, finding 7).
    ...(decision.note === null ? [] : ["with note:", ...decision.note.split("\n").map(line => `| ${line}`)]),
  ].join("\n");
}

function noteDigestOf(note: string): string {
  return createHash("sha256").update(note, "utf8").digest("hex").slice(0, 32);
}

/**
 * A pending draft that ALREADY EXPIRED must never silently drop: the tap
 * proceeds only after the operator is told (Codex free-text review, state
 * machine — "never silently answer without the expected note").
 */
function expiredDraftGuard(store: Store, binding: TelegramBinding, decisionId: number, now: Date): boolean {
  const expired = store.handle
    .prepare(
      `SELECT id FROM telegram_note_draft
        WHERE binding = ? AND decision = ? AND state IN ('pending','armed') AND expires_at <= ?`,
    )
    .get(binding.id, decisionId, now.toISOString());
  if (expired === undefined) return false;
  store.setNoteDraftState(Number(expired["id"]), "discarded");
  return true;
}
