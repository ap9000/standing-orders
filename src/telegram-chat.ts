/** Durable Telegram questions, answered by the same conversation engine as Chat. */
import { createHash, randomBytes } from "node:crypto";
import type { Store, TelegramBinding } from "./store.js";
import type { TelegramTransport } from "./telegram.js";
import { scanForSecrets } from "./evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { runLocalChatTurn } from "./chat-session.js";
import { decodeProjectMentions } from "./chat-projects.js";
import { LOCAL_CREDENTIAL_KEY, LOCAL_SESSION_CEILING_MICROUSD, LOCAL_SESSION_HOURS, type LocalRunner } from "./chat-assistant.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { ensureTelegramDetail, telegramProgress, clearTelegramProgress } from "./telegram-progress.js";
import { deliverTelegramCards, processTelegramConfirmations } from "./telegram-chat-actions.js";
import { focusFromMessage } from "./chat-context.js";
import type { ChatMedia, MediaResult } from "./chat-media.js";

const LEASE_MS = 180_000;
const INTERRUPTED = "My reply was interrupted. Please send your question again; you can also continue in Chat in Standing Orders.";

/** Called inside the transaction that consumes the Telegram update. */
export function enqueueTelegramQuestion(store: Store, binding: TelegramBinding, input: {
  updateId: number; messageId: string | null; replyTo: string | null; message: string;
}, now: Date): string | null {
  const message = input.message.trim();
  if (!message || message.length > MATE_MESSAGE_MAX_CHARS) return `Please send a text question of up to ${MATE_MESSAGE_MAX_CHARS} characters.`;
  if (scanForSecrets(message).length) return "That looks like a password or API key. Please ask again without the credential.";
  const count = store.raw().prepare("SELECT count(*) AS n FROM telegram_chat_request WHERE binding = ? AND state != 'sent'").get(binding.id);
  if (Number(count?.["n"]) >= 8) return "I have several messages waiting. Please let me finish answering, then send this again.";
  store.raw().prepare(`INSERT OR IGNORE INTO telegram_chat_request(update_id, binding, message_id, reply_to, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.updateId, binding.id, input.messageId ?? "", input.replyTo, message, now.toISOString());
  ensureTelegramDetail(store, input.updateId);
  return null;
}

export function recordTelegramNotification(store: Store, binding: TelegramBinding, messageId: string | null, notification: number): void {
  if (messageId !== null) store.raw().prepare("INSERT OR IGNORE INTO telegram_notification_message VALUES (?, ?, ?)").run(binding.id, messageId, notification);
}

/** Select only our own delivered alerts, then prove each one's project membership.
 * Incoming reply text and Telegram's copy of a bot message are never evidence. */
export function telegramQuestionContext(store: Store, binding: TelegramBinding, replyTo: string | null, repos: readonly string[], at: string): string {
  const receiptPrefix = `telegram:${binding.botId}:${binding.chatId}:`;
  const rows = store.raw().prepare(`SELECT n.* FROM notification n
    WHERE n.delivered_at >= ? AND n.delivered_at <= ? AND
      (n.receipt LIKE ? OR EXISTS (SELECT 1 FROM telegram_notification_message m WHERE m.notification = n.id AND m.binding = ?))
      AND (? IS NULL OR n.receipt = ? OR EXISTS (SELECT 1 FROM telegram_notification_message m WHERE m.notification = n.id AND m.binding = ? AND m.message_id = ?))
    ORDER BY n.delivered_at DESC, n.id DESC LIMIT 20`).all(binding.pairedAt, at, receiptPrefix + "%", binding.id,
      replyTo, receiptPrefix + replyTo, binding.id, replyTo);
  const alerts: object[] = [];
  for (const row of rows) {
    const link = String(row["link"] ?? "");
    const decisionId = /^decision:(\d+)$/.exec(String(row["dedupe_key"]))?.[1];
    const decision = decisionId ? store.getDecision(Number(decisionId)) : null;
    const runId = decision?.run ?? Number(/^\/r\/(\d+)$/.exec(link)?.[1] ?? /^secret:(\d+)$/.exec(String(row["dedupe_key"]))?.[1]);
    const run = Number.isSafeInteger(runId) ? store.getRun(runId) : null;
    let taskId: string | null = null;
    if (run !== null) taskId = store.externalIdFor(run.taskRef);
    else if (link.startsWith("/t/")) { try { taskId = decodeURIComponent(link.slice(3)); } catch { /* Ignore malformed links. */ } }
    const ref = taskId === null ? null : store.lookupRef(taskId);
    if (ref?.repo === null || ref?.repo === undefined || !repos.includes(ref.repo)) continue;
    const publication = run === null ? null : store.publicationForRun(run.id);
    alerts.push({ subject: String(row["subject"]).slice(0, 500), body: String(row["body"]).slice(0, 3000),
      deliveredAt: row["delivered_at"], resolved: row["resolved_at"] !== null,
      task: store.getTask(taskId!)?.title ?? taskId, project: `r${repos.indexOf(ref.repo) + 1}`,
      current: run === null ? null : { run: run.id, outcome: run.outcome, committedLocally: run.committed,
        publicationBlockedBySecretScan: store.hasRedactedTerminalDiff(run.id),
        recordedPublication: publication === null ? "No publication recorded by Standing Orders" : publication.state,
        pullRequest: publication?.prNumber ?? null },
    });
    if (alerts.length === 3) break;
  }
  return JSON.stringify({ channel: "Telegram", relation: replyTo === null ? "Recent alerts, possible context only" : "Direct reply to a recorded alert; empty means no matching alert in current projects", alerts });
}

export type TelegramChatOptions = {
  repos: () => readonly string[];
  /** null means ready; failures are concise, credential-free copy. */
  unavailable: () => Promise<string | null>;
  recheckAccount: () => Promise<boolean>;
  cwd: () => string;
  evidenceRoot?: string;
  readMedia?: (media: ChatMedia, active: () => boolean) => Promise<MediaResult>;
  runner?: LocalRunner;
};

/** One queued question or unsent reply; runs independently of polling/approvals.
 * A crashed model turn is never retried automatically. A finished answer is
 * retried by part, without spending again (send/crash can repeat the last part). */
export async function processTelegramChat(store: Store, input: TelegramChatOptions & {
  botId: string; transport: TelegramTransport; active: () => boolean; clock?: () => Date;
}): Promise<void> {
  const clock = input.clock ?? (() => new Date());
  const binding = store.liveTelegramBinding(input.botId);
  if (binding === null || !input.active()) return;
  const stillBound = () => input.active() && store.liveTelegramBinding(input.botId)?.id === binding.id;
  const db = store.raw();
  const now = clock();
  const actionRepos = [...input.repos()];
  await processTelegramConfirmations(store, binding, actionRepos, input.transport,
    () => stillBound() && input.repos().join("\n") === actionRepos.join("\n"), now);
  if (!stillBound()) return;
  // An old unanswered question gets a visible expiry, never silent deletion.
  db.prepare("UPDATE telegram_chat_request SET state = 'ready', reply = ? WHERE binding = ? AND state = 'queued' AND created_at < ?")
    .run("This question waited too long while I was unavailable. Please send it again so I can check the current state.", binding.id, new Date(now.getTime() - 86_400_000).toISOString());
  const owner = randomBytes(16).toString("hex");
  const request = store.transact(() => {
    const row = db.prepare("SELECT * FROM telegram_chat_request WHERE binding = ? AND state != 'sent' ORDER BY update_id LIMIT 1").get(binding.id);
    if (row === undefined || (row["lease_until"] !== null && String(row["lease_until"]) > now.toISOString())) return null;
    ensureTelegramDetail(store, Number(row["update_id"]));
    const detail = db.prepare("SELECT * FROM telegram_chat_detail WHERE request = ?").get(row["update_id"]!);
    if (detail?.["next_attempt_at"] != null && String(detail["next_attempt_at"]) > now.toISOString()) return null;
    // App and Telegram serialize through the shared mate ledger, too.
    store.sweepStaleMateTurns(now);
    if (row["state"] === "queued" && store.liveMateTurnFor(binding.approver) !== null) return null;
    if (row["state"] === "running") {
      db.prepare("UPDATE telegram_chat_request SET state = 'ready', reply = ? WHERE update_id = ?").run(INTERRUPTED, row["update_id"]!);
      row["state"] = "ready"; row["reply"] = INTERRUPTED;
    }
    db.prepare("UPDATE telegram_chat_request SET owner = ?, lease_until = ?, state = ? WHERE update_id = ?")
      .run(owner, new Date(now.getTime() + LEASE_MS).toISOString(), row["state"] === "queued" ? "running" : "ready", row["update_id"]!);
    return row;
  });
  if (request === null) return;
  const id = Number(request["update_id"]);
  const owns = () => stillBound() && db.prepare("SELECT 1 FROM telegram_chat_request WHERE update_id = ? AND owner = ? AND lease_until > ?")
    .get(id, owner, clock().toISOString()) !== undefined;
  let progressBusy = false;
  const progressJobs = new Set<Promise<void>>();
  const updateProgress = (text: string) => {
    if (progressBusy || !owns()) return;
    progressBusy = true;
    const job = telegramProgress(store, binding, id, input.transport, text).catch(() => {}).finally(() => {
      progressBusy = false; progressJobs.delete(job);
    });
    progressJobs.add(job);
  };
  const heartbeat = setInterval(() => {
    if (!owns()) return;
    db.prepare("UPDATE telegram_chat_request SET lease_until = ? WHERE update_id = ? AND owner = ?")
      .run(new Date(clock().getTime() + LEASE_MS).toISOString(), id, owner);
    updateProgress("I’m still working on your question. I’ll post the answer here.");
  }, 20_000);
  heartbeat.unref();
  const sendFailed = () => {
    const count = Number(db.prepare("SELECT attempts FROM telegram_chat_detail WHERE request = ?").get(id)?.["attempts"] ?? 0) + 1;
    db.prepare("UPDATE telegram_chat_detail SET attempts = ?, next_attempt_at = ?, last_problem = ? WHERE request = ?")
      .run(count, new Date(clock().getTime() + Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6))).toISOString(),
        "Your answer is saved. Telegram delivery failed; retrying automatically.", id);
  };
  try {
    if (request["state"] === "queued") {
      await telegramProgress(store, binding, id, input.transport, "I’m checking your projects and recent activity…");
      if (!owns()) return;
      // A best-effort typing indicator does not delay or decide the answer.
      void input.transport("sendChatAction", { chat_id: binding.chatId, action: "typing" }).catch(() => {});
      let reply: string;
      const unavailable = await input.unavailable();
      if (!owns()) return;
      const repos = [...input.repos()];
      const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, repos);
      if (!principal.ok) return;
      db.prepare("UPDATE telegram_chat_request SET ceiling_digest = ? WHERE update_id = ? AND owner = ?").run(principal.who.ceilingDigest, id, owner);
      if (unavailable !== null) reply = unavailable;
      else if (repos.length === 0) reply = "Add a project in Standing Orders first, then ask me here.";
      else {
        let session = store.activeMateSession(binding.approver, clock());
        if (session === null && !store.approvalPasswordRequired(binding.approver)) {
          const expiresAt = new Date(clock().getTime() + LOCAL_SESSION_HOURS * 3_600_000);
          store.mintMateSession({ approver: binding.approver, approverGeneration: principal.who.generation,
            credentialKey: LOCAL_CREDENTIAL_KEY, ceilingMicrousd: LOCAL_SESSION_CEILING_MICROUSD,
            ceilingDigest: principal.who.ceilingDigest,
            termsDigest: createHash("sha256").update(`local\n${LOCAL_SESSION_CEILING_MICROUSD}\n${expiresAt.toISOString()}\n${principal.who.ceilingDigest}`).digest("hex"), expiresAt }, clock());
          session = store.activeMateSession(binding.approver, clock());
        }
        if (session === null) reply = "Open Chat in Standing Orders and confirm the conversation once, then ask me here. Don't send your password in Telegram.";
        else if (session.credentialKey !== LOCAL_CREDENTIAL_KEY) reply = "This conversation uses an API assistant. Continue it in Chat in Standing Orders; Telegram chat currently uses the connected Claude Code account.";
        else if (session.ceilingDigest !== principal.who.ceilingDigest) reply = "Your project list changed. Start a new conversation in Chat in Standing Orders, then continue here.";
        else {
          const { thread } = store.openMateThread(binding.approver, principal.who.ceilingDigest, clock());
          db.prepare("UPDATE telegram_chat_request SET thread = ? WHERE update_id = ? AND owner = ?").run(thread.id, id, owner);
          const mediaJson = db.prepare("SELECT attachment_json FROM telegram_chat_detail WHERE request = ?").get(id)?.["attachment_json"];
          const mediaActive = () => owns() && input.repos().join("\n") === principal.who.repos.join("\n") &&
            verifyApproverStanding(store, binding.approver, binding.approverGeneration, input.repos()).ok &&
            store.getMateThread(thread.id)?.closedAt === null;
          const media = mediaJson == null ? null : input.readMedia === undefined ? { ok: false as const, message: "Attachment reading is unavailable. Please update Standing Orders or send your question as text." } : await input.readMedia(JSON.parse(String(mediaJson)) as ChatMedia, mediaActive);
          if (!owns() || input.repos().join("\n") !== principal.who.repos.join("\n")) return;
          const focusRepo = focusFromMessage(store, binding.approver, String(request["message"]), repos);
          db.prepare("UPDATE telegram_chat_detail SET focus_repo = ? WHERE request = ?").run(focusRepo, id);
          if (media !== null && !media.ok) reply = media.message;
          else {
          const outcome = await runLocalChatTurn({ store, who: principal.who, session, thread,
            message: String(request["message"]), focusRepo, cwd: input.cwd(), clock,
            ...(media?.ok ? { attachmentText: media.text, attachments: media.content } : {}),
            channelContext: telegramQuestionContext(store, binding, request["reply_to"] === null ? null : String(request["reply_to"]), repos, String(request["created_at"])),
            ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }),
            onProgress: updateProgress,
            recheckAccount: async () => (await input.recheckAccount()) && owns() &&
              input.repos().join("\n") === principal.who.repos.join("\n"),
            ...(input.runner === undefined ? {} : { runner: input.runner }),
          });
          if (!owns()) return;
          if ("turn" in outcome) db.prepare("UPDATE telegram_chat_detail SET turn = ? WHERE request = ?").run(outcome.turn, id);
          reply = outcome.ok ? decodeProjectMentions(outcome.reply, repos) +
            (outcome.proposals > 0 ? "\n\nReview the proposed changes using the buttons below." : "") : outcome.message;
          }
        }
      }
      if (!owns()) return;
      if (scanForSecrets(reply).length) reply = "I couldn't safely deliver that reply. Please check Chat in Standing Orders.";
      db.prepare("UPDATE telegram_chat_request SET state = 'ready', reply = ? WHERE update_id = ? AND owner = ?").run(reply, id, owner);
    }
    const ready = db.prepare("SELECT * FROM telegram_chat_request WHERE update_id = ? AND owner = ?").get(id, owner);
    if (!ready || !owns()) return;
    const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, input.repos());
    // Revoke/forget/change of project access also invalidates a delayed reply.
    if (!principal.ok || (ready["ceiling_digest"] !== null && ready["ceiling_digest"] !== principal.who.ceilingDigest) ||
      (ready["thread"] !== null && store.getMateThread(Number(ready["thread"]))?.closedAt !== null)) {
      db.prepare("UPDATE telegram_chat_request SET state = 'sent', message = '', reply = NULL WHERE update_id = ? AND owner = ?").run(id, owner);
      return;
    }
    const parts = splitTelegramReply(String(ready["reply"]));
    for (let part = Number(ready["parts_sent"]); part < parts.length; part++) {
      if (!owns()) return;
      if (input.repos().join("\n") !== principal.who.repos.join("\n") ||
        (ready["thread"] !== null && store.getMateThread(Number(ready["thread"]))?.closedAt !== null)) {
        db.prepare("UPDATE telegram_chat_request SET state = 'sent', message = '', reply = NULL WHERE update_id = ? AND owner = ?").run(id, owner);
        return;
      }
      const result = await input.transport("sendMessage", { chat_id: binding.chatId, text: parts[part],
        // A question recovered from an operator's report may have no original
        // Telegram message id. Deliver it normally instead of fabricating one.
        ...(Number.isSafeInteger(Number(request["message_id"])) && Number(request["message_id"]) > 0
          ? { reply_parameters: { message_id: Number(request["message_id"]), allow_sending_without_reply: true } } : {}),
        link_preview_options: { is_disabled: true } });
      if (!result.ok) { sendFailed(); return; }
      db.prepare("UPDATE telegram_chat_request SET parts_sent = ? WHERE update_id = ? AND owner = ?").run(part + 1, id, owner);
    }
    const turn = db.prepare("SELECT turn FROM telegram_chat_detail WHERE request = ?").get(id)?.["turn"];
    if (turn != null && !(await deliverTelegramCards(store, binding, Number(turn), principal.who.repos, input.transport,
      () => owns() && input.repos().join("\n") === principal.who.repos.join("\n"), clock()))) { sendFailed(); return; }
    db.prepare("UPDATE telegram_chat_request SET state = 'sent', message = '', reply = NULL WHERE update_id = ? AND owner = ?").run(id, owner);
    db.prepare("UPDATE telegram_chat_detail SET last_problem = NULL, next_attempt_at = NULL, attachment_json = NULL WHERE request = ?").run(id);
    clearInterval(heartbeat);
    await Promise.allSettled([...progressJobs]);
    await clearTelegramProgress(store, binding, id, input.transport);
  } catch {
    // Preserve a send failure's ready answer. Unexpected turn failures get a
    // useful response on the next pass, never raw provider/transport errors.
    db.prepare("UPDATE telegram_chat_request SET state = 'ready', reply = ? WHERE update_id = ? AND owner = ? AND state = 'running'").run(INTERRUPTED, id, owner);
    sendFailed();
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled([...progressJobs]);
    db.prepare("UPDATE telegram_chat_request SET owner = NULL, lease_until = NULL WHERE update_id = ? AND owner = ?").run(id, owner);
  }
}

export function splitTelegramReply(text: string): string[] {
  const chars = Array.from(text); const parts: string[] = [];
  for (let at = 0; at < chars.length; at += 1900) parts.push(chars.slice(at, at + 1900).join(""));
  return parts;
}
