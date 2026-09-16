/**
 * The paired phone as one more way to use the same assistant.
 *
 * Transport only. An ordinary private Telegram message becomes a mate turn
 * through `runMateTurn` — the same saved thread, proposal rows, confirm
 * doors and result actions the console and `standing-orders chat` use —
 * and every act is still a card the operator confirms. This module owns
 * what is specific to the wire: proving the pairing (chat AND immutable
 * sender AND approver generation AND the enrolled ceiling) before any
 * model call and again after every wait; the durable inbound row that
 * precedes polling acknowledgement; the request identity the engine
 * receipts a turn under so a replay or a restart never dispatches the
 * provider twice; concise previews with opaque one-tap tokens; and the
 * honest words for what a phone cannot do (a password, a cancel, a
 * console-only control).
 *
 * Nothing here mints authority: the principal comes from
 * `verifyApproverStanding` against the live binding row, the session is
 * the approver's own compatible one (or one minted under the same terms
 * the console and CLI state), and the door re-proves everything again.
 */
import { createHash, randomBytes } from "node:crypto";
import { isDirectChatProvider, subscriptionCredentialKey } from "./converse.js";
import { MATE_MESSAGE_MAX_CHARS, runMateTurn } from "./mate.js";
import { confirmMateProposal, dismissMateProposal, type DoorOptions, type DoorOutcome } from "./mate-doors.js";
import { MATE_TOOL_SCHEMAS } from "./mate-tools.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { canonicalProject } from "./project.js";
import type { ChatConfig, MateProposal, MateSession, MateThread, Store, SubscriptionChatProviderId, TelegramBinding, TelegramConversation } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
import { phoneText, projectLabel } from "./telegram-status.js";
import { CHAT_CONTROLS, isChatControl } from "./chat-controls.js";
import { CHAT_TASK_ACTIONS, isChatTaskAction } from "./chat-task-actions.js";

/** How long one claimed turn may go without a heartbeat before another poller may take it over. */
export const CONVERSATION_CLAIM_MS = 2 * 60_000;
/** A busy engine (one turn at a time) defers a queued message this long, up to the age bound below. */
export const CONVERSATION_RETRY_MS = 5_000;
export const CONVERSATION_MAX_AGE_MS = 10 * 60_000;
/** A card's buttons and an armed irreversible challenge live this long. */
export const CARD_TTL_MS = 24 * 3_600_000;
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** Telegram's own message ceiling, with room for our part headers (the same bound telegram.ts splits at). */
const PART_CAP = 3_900;

export type TelegramConversationOptions = {
  /** Where evidence lives — the same root the console and CLI read results from. */
  evidenceRoot: string;
  /** Injected by tests; production invokes the isolated local harness. */
  subscriptionRunner?: SubscriptionMateRunner;
  /** The held-session supervisor in this process, when there is one (a stop fences through it). */
  held?: DoorOptions["held"];
};

/** One Bot API call, the shape telegram.ts injects. */
export type Transport = (
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }>;

// ---- the ceiling and the principal --------------------------------------------

/**
 * The phone's project ceiling: the enrolled registry, canonicalized and
 * deduplicated IN ORDER exactly as the console's managed list is, then
 * narrowed to what this approver's account may access. Order matters —
 * `r1..rN` is an index and the ceiling digest hashes the order — so a
 * console session over the same enrollment shares its digest here.
 */
export function telegramConversationRepos(store: Store, approver: string, registry: readonly string[]): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const path of registry) {
    const canonical = canonicalProject(path) ?? path;
    if (seen.has(canonical) || !store.accountCanAccess(approver, canonical)) continue;
    seen.add(canonical);
    repos.push(canonical);
  }
  return repos;
}

/** The engine's request identity for one inbound message: exact bot, binding and update, never text. */
export function telegramRequestId(botId: string, bindingId: number, updateId: number): string {
  return createHash("sha256").update(`telegram:${botId}:${bindingId}:${updateId}`).digest("hex").slice(0, 32);
}

/**
 * Is the channel still what a turn opened under? The live binding must be
 * the SAME row and generation, its approver still an approver, and the
 * enrolled ceiling (reloaded now) still the exact list the principal
 * holds. A string names what changed; null means nothing did.
 */
export async function telegramChannelProblem(
  store: Store,
  expected: { botId: string; bindingId: number; approverGeneration: number; repos: readonly string[] },
  readProjects: () => Promise<readonly string[]>,
): Promise<string | null> {
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    return "current project access could not be read";
  }
  const binding = store.liveTelegramBinding(expected.botId);
  if (binding === null || binding.id !== expected.bindingId || binding.approverGeneration !== expected.approverGeneration) return "this chat is no longer paired";
  if (store.accountOf(binding.approver)?.role !== "approver") return "the paired account is no longer an approver";
  const repos = telegramConversationRepos(store, binding.approver, registry);
  if (repos.length !== expected.repos.length || repos.some((one, index) => one !== expected.repos[index])) return "the connected projects changed";
  return null;
}

export type ResolvedMate =
  | { ok: true; who: VerifiedApprover; session: MateSession; thread: MateThread; config: ChatConfig & { provider: SubscriptionChatProviderId } }
  | { ok: false; reason: "unpaired" | "unconfigured" | "direct-api" | "no-projects" | "session-mismatch" | "thread-mismatch"; said: string | null };

/**
 * The session and thread a paired phone speaks in: the approver's live
 * session when it is compatible (same generation, same membership
 * credential, same ceiling), else one minted under the very terms the
 * console and CLI state for membership chat (no dollar ceiling, this
 * ceiling digest) — and only when NO session is live, because minting
 * ends the previous one and an unrelated console conversation is not
 * this phone's to end. The same rule for the thread: reused when its
 * ceiling matches, never closed from here.
 */
export function resolveTelegramMate(store: Store, binding: TelegramBinding, repos: readonly string[], now: Date): ResolvedMate {
  const config = store.getChatConfig();
  if (config === null) {
    return { ok: false, reason: "unconfigured", said: "Chat isn't set up yet. Choose a chat provider in Standing Orders settings on the computer, then message again. Nothing was changed." };
  }
  if (isDirectChatProvider(config.provider)) {
    return { ok: false, reason: "direct-api", said: "Chat from this phone uses your membership login. Direct API chat stays on the computer so this chat cannot spend your API budget. Nothing was changed." };
  }
  if (repos.length === 0) {
    return { ok: false, reason: "no-projects", said: "No connected projects are available to this phone. Add a project in Standing Orders on the computer, then message again." };
  }
  const verified = verifyApproverStanding(store, binding.approver, binding.approverGeneration, repos);
  if (!verified.ok) return { ok: false, reason: "unpaired", said: null };
  const who = verified.who;
  const credentialKey = subscriptionCredentialKey(config.provider);
  const mismatch = "Your open chat session on the computer covers different projects or another provider. Finish or end it there, then message here again. Nothing was changed.";
  let session = store.activeMateSession(who.name);
  if (session !== null && (session.approverGeneration !== who.generation || session.credentialKey !== credentialKey || session.ceilingDigest !== who.ceilingDigest)) {
    return { ok: false, reason: "session-mismatch", said: mismatch };
  }
  const liveThread = store.liveMateThreadFor(who.name);
  if (liveThread !== null && liveThread.ceilingDigest !== who.ceilingDigest) return { ok: false, reason: "thread-mismatch", said: mismatch };
  if (session === null) {
    const termsDigest = createHash("sha256").update(`0\n${who.ceilingDigest}`).digest("hex");
    const id = store.mintMateSession(
      { approver: who.name, approverGeneration: who.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest },
      now,
    );
    session = store.getMateSession(id);
    if (session === null) return { ok: false, reason: "session-mismatch", said: mismatch };
  }
  const thread = liveThread ?? store.openMateThread(who.name, who.ceilingDigest, now).thread;
  return { ok: true, who, session, thread, config: config as ChatConfig & { provider: SubscriptionChatProviderId } };
}

// ---- words ---------------------------------------------------------------------

export function tooLongText(length: number): string {
  return `That message is ${length.toLocaleString("en-US")} characters; chat takes up to ${MATE_MESSAGE_MAX_CHARS.toLocaleString("en-US")}. Nothing was sent to the assistant. Send it in shorter parts, or say which part matters most.`;
}

export function whichTaskText(taskIds: readonly string[]): string {
  return [
    "That message mentions more than one task. Reply to a message about the one you mean, or name it:",
    ...taskIds.map(id => `• ${phoneText(id, 64)}`),
  ].join("\n");
}

/** The server-authored context a reply to a result message carries into the turn — the exact execution and run, never a guess. */
export function replyContextFor(taskId: string, run: number | null): string {
  return [
    `Current task: ${taskId}. Read it with get_task before answering or proposing changes. Read its currentExecution next and bind new actions to that exact execution. Never replace the target of a prior proposal with a newer revision. Keep this turn about that task unless the operator explicitly asks to broaden it.`,
    run === null
      ? `The operator is replying to a message about execution ${taskId}.`
      : `The operator is replying to result #${run} from execution ${taskId}. Use get_result for that exact execution and run when responding to feedback; do not substitute another result. If the operator asks for changes, use propose_review revise; use note only when they explicitly ask to save feedback without starting work.`,
  ].join(" ");
}

const HANDOFF = "Open Standing Orders on the computer to finish this step.";

function lines(text: string, cap: number): string[] {
  return phoneText(text, cap).split("\n").map(line => `| ${line}`);
}

/** The card: plain words for what confirming does, the exact terms it binds to, and whether a button belongs on it. */
export function proposalPreview(store: Store, proposal: MateProposal, repos: readonly string[]): { text: string; buttons: boolean } {
  const payload = proposal.payload;
  const t = (key: string, cap = 200): string => (typeof payload[key] === "string" ? phoneText(payload[key] as string, cap) : "");
  const task = t("task", 64);
  const taskName = t("taskTitle", 120) || task;
  const repoLabel = (() => {
    const id = t("repoId", 8);
    const path = /^r[0-9]+$/.test(id) ? repos[Number(id.slice(1)) - 1] : undefined;
    return path === undefined ? id : projectLabel(path);
  })();
  const card = (headline: string, body: string[] = [], consequence: string | null = null): { text: string; buttons: boolean } => ({
    text: [headline, ...body, ...(consequence === null ? [] : ["", consequence]), "", "Confirm or Dismiss below. Nothing changes until you confirm."].join("\n"),
    buttons: true,
  });
  const handoff = (headline: string, body: string[] = []): { text: string; buttons: boolean } => ({ text: [headline, ...body, "", HANDOFF].join("\n"), buttons: false });

  switch (proposal.kind) {
    case "task":
      return card(
        `Create task in ${repoLabel || "the project"}: ${t("title", 120)}`,
        [`Goal: ${t("goal", 600)}`, ...(t("not") === "" ? [] : [`Not: ${t("not", 300)}`]), ...(payload["report"] === true ? ["A scout task: it delivers a report, never a branch."] : [])],
        payload["report"] === true ? "Confirm files it; a scout needs no approval." : "Confirm files it. You still approve its scope before work starts.",
      );
    case "next":
      return card(`Move ${taskName} to the front of its queue (now ${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")}).`);
    case "reserve":
      return card(payload["worker"] === null ? `Release ${taskName} to the shared queue.` : `Reserve ${taskName} for ${t("worker", 80)}.`);
    case "hold":
      return card(`Hold ${taskName}: ${t("reason", 300)}`, [], "The task waits until the hold is released.");
    case "unhold":
      return card(`Release ${taskName} from its hold.`);
    case "steer":
      return card(`Guide ${taskName}'s next attempt:`, lines(t("note", 1_000), 1_000), "Scope stays the same; active work is not interrupted.");
    case "repair": {
      const blocker = t("blockerTitle", 120) || t("blocker", 64);
      const operation = t("operation", 16);
      const headline =
        operation === "retry" ? `Queue ${blocker} again; ${taskName} follows when it finishes.`
        : operation === "unlink" ? `Let ${taskName} continue without ${blocker}.`
        : `Make ${taskName} wait for ${t("replacementTitle", 120) || t("replacement", 64)} instead of ${blocker}.`;
      return card(headline);
    }
    case "agents": {
      const parts = [
        ...(t("risk") === "" ? [] : [`risk ${t("risk", 32)}`]),
        ...(t("role") === "" ? [] : [payload["clear"] === true ? `${t("role", 32)}: back to the recommendation` : `${t("role", 32)}: ${t("provider", 40)} ${t("model", 80)}`]),
      ];
      return card(`Change agents for ${taskName}: ${parts.join("; ")}`, [], "Changing agents or risk needs renewed approval on the computer before work starts.");
    }
    case "scope":
      return card(`Rewrite the scope of ${taskName}:`, [`Goal: ${t("goal", 600)}`, ...(t("not") === "" ? [] : [`Not: ${t("not", 300)}`])], "After confirming, approve the new scope with your password on the computer.");
    case "answer": {
      const id = typeof payload["decision"] === "number" ? payload["decision"] : null;
      const decision = id === null ? null : store.getDecision(id);
      const pick = t("option", 64);
      const irreversible = payload["reversible"] === false;
      const body = decision === null
        ? ["(the decision is gone)"]
        : [
            `Q: ${phoneText(decision.question, 400)}`,
            ...decision.options.map(one => `${one.id === pick ? "→" : " "} ${phoneText(one.label, 120)}${one.reversible ? "" : " — IRREVERSIBLE"}${one.id === decision.recommendation ? " (the builder recommends this)" : ""}: ${phoneText(one.consequence, 300)}`),
            ...(t("rationale") === "" ? [] : [`Why: ${t("rationale", 300)}`]),
          ];
      return card(`Answer decision #${String(id ?? "?")} on ${taskName} with "${t("optionLabel", 120) || pick}"`, body, irreversible ? "⚠ This choice is irreversible. Confirming asks you once more." : null);
    }
    case "task_action": {
      const operation = payload["operation"];
      const action = isChatTaskAction(operation) ? CHAT_TASK_ACTIONS[operation] : null;
      const dependency = t("dependencyTitle", 120) || t("dependency", 64);
      if (action === null) return handoff(`An unavailable action was proposed for ${taskName}.`);
      return card(`${action.label}: ${taskName}${dependency === "" ? "" : ` · ${dependency}`}`, [action.detail], operation === "resume" ? "Confirming opens the password step on the computer; it does not resume work from here." : null);
    }
    case "review": {
      const revise = payload["operation"] === "revise";
      const snapshot = payload["snapshot"] as { notes?: { id: number; note: string; path: string | null; line: number | null }[] } | undefined;
      const selected = Array.isArray(payload["notes"]) ? (payload["notes"] as number[]) : [];
      const saved = (snapshot?.notes ?? []).filter(one => selected.includes(one.id));
      const note = t("note", 1_000);
      const path = t("path", 300);
      return card(
        `${revise ? "Request changes to" : "Save feedback on"} result #${String(payload["run"] ?? "?")} of ${taskName}`,
        [
          ...(note === "" ? [] : [`Your feedback${path === "" ? "" : ` (${path}${typeof payload["line"] === "number" ? `:${payload["line"]}` : ""})`}:`, ...lines(note, 1_000)]),
          ...(saved.length === 0 ? [] : ["Saved notes included:", ...saved.map(one => `• ${one.path === null ? "" : `${phoneText(one.path, 120)}${one.line === null ? "" : `:${one.line}`}: `}${phoneText(one.note, 300)}`)]),
        ],
        revise ? "Creates a revision of the same task. Its approval follows your settings." : "Saves feedback; no work starts.",
      );
    }
    case "cancel":
      return handoff(`Cancel ${taskName}: ${t("reason", 300)}`, ["Cancelling is armed on the task itself, never from a card."]);
    case "control": {
      const control = payload["control"];
      const label = isChatControl(control) ? CHAT_CONTROLS[control].label : "A console control";
      return handoff(`${label}${taskName === "" ? "" : ` for ${taskName}`}`, ["This opens an existing control; nothing changes from here."]);
    }
    default:
      return handoff("This kind of proposal cannot be confirmed from the phone.");
  }
}

/** The card after it resolves, from the recorded outcome — the same words every surface shows. */
export function proposalOutcomeText(proposal: MateProposal): string {
  const outcome = proposal.outcome as { said?: unknown; via?: unknown } | null;
  const said = outcome !== null && typeof outcome.said === "string" ? phoneText(outcome.said, 600) : "";
  const via = outcome !== null && typeof outcome.via === "string" ? ` (from ${outcome.via})` : "";
  switch (proposal.state) {
    case "confirmed": return `✓ Done${via}${said === "" ? "" : `: ${said}`}`;
    case "refused": return `✗ Not done${via}${said === "" ? "" : `: ${said}`}`;
    case "dismissed": return "Dismissed.";
    case "expired": return "This card expired.";
    case "confirming": return "Being confirmed elsewhere right now.";
    default: return "Still waiting for your confirmation.";
  }
}

// ---- the parity matrix -----------------------------------------------------------

export type ParitySupport = "direct" | "handoff" | "missing";

/**
 * One row per mate tool: how the paired phone reaches it. `direct` means
 * the same engine tool or the same confirm door runs from Telegram;
 * `handoff` means the phone shows where the existing authenticated
 * control lives and does nothing itself; `missing` means no phone path
 * yet. The test suite refuses a tool this table does not name, and the
 * committed matrix document must agree with it line for line.
 */
export const TELEGRAM_ACTION_PARITY: Record<string, { support: ParitySupport; how: string; gap: string | null }> = {
  recap: { support: "direct", how: "Read by the model during a phone turn over the enrolled ceiling.", gap: null },
  list_repos: { support: "direct", how: "Read during a turn; projects are r1..rN in enrollment order, as on the console.", gap: null },
  get_project_knowledge: { support: "direct", how: "Read during a turn.", gap: null },
  list_tasks: { support: "direct", how: "Read during a turn.", gap: null },
  get_task: { support: "direct", how: "Read during a turn; a reply to a result message pins the exact execution.", gap: null },
  get_agents: { support: "direct", how: "Read during a turn.", gap: null },
  list_decisions: { support: "direct", how: "Read during a turn.", gap: null },
  get_decision: { support: "direct", how: "Read during a turn.", gap: null },
  queue: { support: "direct", how: "Read during a turn.", gap: null },
  get_result: { support: "direct", how: "Read during a turn; the phone card shows the verification verdict, never a local link.", gap: "Screenshots and secure remote evidence links are not delivered to the phone yet." },
  get_controls: { support: "direct", how: "Read during a turn.", gap: null },
  show_control: { support: "handoff", how: "The card names the control and the task; the operator opens it on the computer. No link is sent.", gap: null },
  propose_task: { support: "direct", how: "Card with Confirm/Dismiss through confirmMateProposal (filed as a mate proposal, via telegram). Scope approval stays on the computer.", gap: null },
  propose_scope: { support: "direct", how: "Confirm rewrites the scope through the shared door; the password approval that follows is a handoff.", gap: null },
  propose_next: { support: "direct", how: "Confirm through the shared door with the queue revision it saw.", gap: null },
  propose_reserve: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_agents: { support: "direct", how: "Confirm through the shared route-edit door; renewed approval stays on the computer.", gap: null },
  propose_hold: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_unhold: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_steer: { support: "direct", how: "Confirm through the shared door; the guidance is shown verbatim on the card.", gap: null },
  propose_dependency_repair: { support: "direct", how: "Confirm retry/unlink/replace through the shared door with both projects re-checked.", gap: null },
  propose_task_action: { support: "direct", how: "stop, retry, plan, wait_for and stop_waiting confirm through the shared door (a stop is audited via telegram); resume confirms only the request and hands off to the password step.", gap: "resume completes on the computer." },
  propose_answer: { support: "direct", how: "Confirm answers through the shared door, audited via telegram; an irreversible option arms a second tap first.", gap: null },
  propose_review: { support: "direct", how: "note saves feedback; revise creates the same-family revision through the shared result service, honouring automatic approval settings.", gap: null },
  propose_cancel: { support: "handoff", how: "The door refuses cancel from any card; the phone says to arm it on the task itself.", gap: "No phone path to cancel by design." },
};

/** Every tool the model can call, mapped; a new tool must name its phone road. */
export function parityGaps(): string[] {
  return MATE_TOOL_SCHEMAS.map(tool => tool.name).filter(name => TELEGRAM_ACTION_PARITY[name] === undefined);
}

// ---- proposal cards on the wire ------------------------------------------------------

type Keyboard = { text: string; callback_data: string }[][];

/** Mint the card's tokens before the send, so a tap can never name a token that does not exist. */
export function mintCardTokens(store: Store, binding: TelegramBinding, proposal: number, now: Date, messageId?: string): { keyboard: Keyboard; tokens: string[] } {
  const confirm = randomBytes(16).toString("hex");
  const dismiss = randomBytes(16).toString("hex");
  for (const [token, phase] of [[confirm, "confirm"], [dismiss, "dismiss"]] as const) {
    store.createTelegramProposalAction({ token, binding: binding.id, proposal, phase, chatId: binding.chatId, ttlMs: CARD_TTL_MS, ...(messageId === undefined ? {} : { messageId }) }, now);
  }
  return { keyboard: [[{ text: "Confirm", callback_data: confirm }, { text: "Dismiss", callback_data: dismiss }]], tokens: [confirm, dismiss] };
}

export type CardEffect =
  | { kind: "ack"; text: string }
  | { kind: "edit"; text: string; keyboard?: Keyboard }
  | { kind: "signal"; run: () => void };

/**
 * One tap on a proposal card, applied inside the update's own transaction
 * by the bridge (which already proved the live binding, the exact sender
 * and the exact chat). Returns what to tell Telegram afterwards. The
 * principal is minted from the binding row against the CURRENT enrolled
 * ceiling; the door re-proves standing, ceiling, session and the
 * proposal's own terms again inside its transaction.
 */
export function applyProposalTap(
  store: Store,
  binding: TelegramBinding,
  token: string,
  message: { message_id: number },
  repos: readonly string[] | null,
  options: TelegramConversationOptions,
  now: Date,
): { effects: CardEffect[]; confirmed: boolean; ignored: boolean } {
  const effects: CardEffect[] = [];
  const ack = (text: string): void => { effects.push({ kind: "ack", text }); };
  const edit = (text: string, keyboard?: Keyboard): void => { effects.push({ kind: "edit", text, ...(keyboard === undefined ? {} : { keyboard }) }); };
  const action = store.getTelegramProposalAction(token);
  if (action === null || action.binding !== binding.id || action.chatId !== binding.chatId || (action.messageId !== null && action.messageId !== String(message.message_id))) {
    ack("that button is stale — send /status to see what still waits");
    return { effects, confirmed: false, ignored: true };
  }
  const proposal = store.getMateProposal(action.proposal);
  if (proposal === null) {
    store.consumeTelegramProposalAction(token, now);
    ack("that card no longer exists");
    edit("This card no longer exists.");
    return { effects, confirmed: false, ignored: true };
  }
  if (proposal.state !== "pending") {
    // Already acted on — here, on the console, or from the terminal. The
    // card shows the recorded outcome; nothing runs twice.
    store.consumeTelegramProposalActions(proposal.id, now);
    ack(proposal.state === "confirmed" ? "already done" : proposal.state === "dismissed" ? "already dismissed" : "already acted on");
    edit(proposalOutcomeText(proposal));
    return { effects, confirmed: false, ignored: true };
  }
  if (repos === null) {
    // The registry could not be read: the token stays live for a retry.
    ack("project access could not be read — tap again in a moment");
    return { effects, confirmed: false, ignored: true };
  }
  const verified = verifyApproverStanding(store, binding.approver, binding.approverGeneration, repos);
  if (!verified.ok) {
    ack("this chat no longer answers as an approver");
    return { effects, confirmed: false, ignored: true };
  }
  const who = verified.who;
  const preview = proposalPreview(store, proposal, repos);

  if (action.phase === "dismiss") {
    if (!store.consumeTelegramProposalAction(token, now)) { ack("that button was already used"); return { effects, confirmed: false, ignored: true }; }
    const done = dismissMateProposal(store, who, proposal.id, now);
    store.consumeTelegramProposalActions(proposal.id, now);
    ack(done ? "dismissed" : "that proposal was already acted on");
    edit(done ? "Dismissed." : proposalOutcomeText(store.getMateProposal(proposal.id) ?? proposal));
    return { effects, confirmed: false, ignored: !done };
  }
  if (action.phase === "cancel") {
    // Cancel means cancelled: the armed yes dies with it and the card is restored.
    store.consumeTelegramProposalAction(token, now);
    store.consumeTelegramProposalActions(proposal.id, now, ["yes", "cancel"]);
    const fresh = mintCardTokens(store, binding, proposal.id, now, String(message.message_id));
    ack("cancelled");
    edit(preview.text, fresh.keyboard);
    return { effects, confirmed: false, ignored: false };
  }
  if (!preview.buttons) {
    store.consumeTelegramProposalActions(proposal.id, now);
    ack("this step finishes on the computer");
    edit(preview.text);
    return { effects, confirmed: false, ignored: true };
  }
  const irreversible = proposal.kind === "answer" && proposal.payload["reversible"] === false;
  if (action.phase === "confirm" && irreversible) {
    // The arm: two fresh one-time tokens make a real challenge, exactly as
    // a decision button does. Nothing is answered here.
    if (!store.consumeTelegramProposalAction(token, now)) { ack("that button was already used"); return { effects, confirmed: false, ignored: true }; }
    store.consumeTelegramProposalActions(proposal.id, now, ["yes", "cancel"]);
    const yes = randomBytes(16).toString("hex");
    const cancel = randomBytes(16).toString("hex");
    const placedOn = String(message.message_id);
    store.createTelegramProposalAction({ token: yes, binding: binding.id, proposal: proposal.id, phase: "yes", chatId: binding.chatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    store.createTelegramProposalAction({ token: cancel, binding: binding.id, proposal: proposal.id, phase: "cancel", chatId: binding.chatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    ack("irreversible — confirm it");
    edit(`⚠ This answer is IRREVERSIBLE.\n\n${preview.text.split("\n\nConfirm or Dismiss below")[0]}\n\nConfirm?`, [
      [{ text: "⚠ Yes, answer it", callback_data: yes }],
      [{ text: "Cancel", callback_data: cancel }],
    ]);
    return { effects, confirmed: false, ignored: false };
  }
  if (!store.consumeTelegramProposalAction(token, now)) {
    ack(action.phase === "yes" ? "that confirmation expired — start again from Confirm" : "that button was already used");
    return { effects, confirmed: false, ignored: true };
  }
  const outcome = confirmMateProposal(store, who, proposal.id, now, {
    via: "telegram",
    evidenceRoot: options.evidenceRoot,
    confirm: action.phase === "yes",
    ...(options.held === undefined ? {} : { held: options.held }),
    deferSignal: signal => effects.push({ kind: "signal", run: signal }),
  });
  if (!outcome.ok && outcome.reason === "needs-confirm") {
    // Not armed yet (a card drafted without the reversible mark): arm now, the tap is not lost.
    const yes = randomBytes(16).toString("hex");
    const cancel = randomBytes(16).toString("hex");
    const placedOn = String(message.message_id);
    store.createTelegramProposalAction({ token: yes, binding: binding.id, proposal: proposal.id, phase: "yes", chatId: binding.chatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    store.createTelegramProposalAction({ token: cancel, binding: binding.id, proposal: proposal.id, phase: "cancel", chatId: binding.chatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    ack("irreversible — confirm it");
    edit(`⚠ This answer is IRREVERSIBLE.\n\n${preview.text.split("\n\nConfirm or Dismiss below")[0]}\n\nConfirm?`, [
      [{ text: "⚠ Yes, answer it", callback_data: yes }],
      [{ text: "Cancel", callback_data: cancel }],
    ]);
    return { effects, confirmed: false, ignored: false };
  }
  store.consumeTelegramProposalActions(proposal.id, now);
  ack(outcome.ok ? "✓ done" : "not done");
  edit(confirmedCardText(outcome, proposal));
  return { effects, confirmed: outcome.ok, ignored: false };
}

/** The resolved card, with the honest remaining step where one exists. */
export function confirmedCardText(outcome: DoorOutcome, proposal: MateProposal): string {
  const said = phoneText(outcome.said, 600);
  if (!outcome.ok) return `✗ Not done: ${said}`;
  const next =
    proposal.kind === "task" ? "\n\nApprove its scope in Standing Orders on the computer before work starts."
    : proposal.kind === "scope" || proposal.kind === "agents" ? `\n\n${HANDOFF}`
    : proposal.kind === "task_action" && proposal.payload["operation"] === "resume" ? `\n\n${HANDOFF}`
    : proposal.kind === "review" && proposal.payload["operation"] === "revise" && /approve/i.test(outcome.said) ? "\n\nApprove the revision in Standing Orders on the computer, or ask here for its status with /task." : "";
  return `✓ ${said}${next}`;
}

// ---- the queued turn ---------------------------------------------------------------

export type ConversationReport = { answered: number; refused: number; problems: string[] };

function splitParts(text: string): string[] {
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

/**
 * Run every claimable queued message for this bot, one at a time, each
 * outside any SQLite transaction. The caller holds the poll lease and
 * renews it; the row's own claim is renewed here. Bounded per call so a
 * flood cannot pin one pass forever.
 */
export async function processTelegramConversations(args: {
  store: Store;
  botId: string;
  transport: Transport;
  owner: string;
  clock: () => Date;
  readProjects: () => Promise<readonly string[]>;
  options: TelegramConversationOptions;
  report: ConversationReport;
  signal?: AbortSignal;
  limit?: number;
}): Promise<void> {
  const limit = args.limit ?? 20;
  for (let count = 0; count < limit && args.signal?.aborted !== true; count++) {
    const row = args.store.claimTelegramConversation(args.botId, args.owner, CONVERSATION_CLAIM_MS, args.clock());
    if (row === null) return;
    try {
      await runTelegramConversation(row, args);
    } catch (error) {
      // The claim lapses on its own; the receipt makes the retry safe.
      args.report.problems.push(`telegram chat for update ${row.updateId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

async function runTelegramConversation(
  row: TelegramConversation,
  args: { store: Store; botId: string; transport: Transport; owner: string; clock: () => Date; readProjects: () => Promise<readonly string[]>; options: TelegramConversationOptions; report: ConversationReport },
): Promise<void> {
  const { store, botId, transport, owner, clock, readProjects, options, report } = args;
  const finish = (result: Parameters<Store["finishTelegramConversation"]>[2]): boolean => store.finishTelegramConversation(row.id, owner, result, clock());
  const held = (): boolean => store.renewTelegramConversation(row.id, owner, CONVERSATION_CLAIM_MS, clock());
  const ageMs = clock().getTime() - Date.parse(row.createdAt);
  const requeue = (outcome: string): void => {
    if (ageMs > CONVERSATION_MAX_AGE_MS) {
      finish({ state: "failed", outcome: `${outcome}:gave-up` });
      report.refused++;
      return;
    }
    finish({ state: "queued", outcome, nextAttemptAt: new Date(clock().getTime() + CONVERSATION_RETRY_MS).toISOString() });
  };

  // 1. The exact binding the message arrived under must still be the live one.
  const binding = store.liveTelegramBinding(botId);
  if (binding === null || binding.id !== row.binding || binding.approverGeneration !== row.approverGeneration || store.accountOf(binding.approver)?.role !== "approver") {
    finish({ state: "failed", outcome: "unpaired" });
    report.refused++;
    return;
  }
  const chatId = binding.chatId;
  let replyMessageId: string | null = null;
  /** One outbound part: fenced on the claim AND the channel right before
   * the transport call. Model text and cards need the whole channel (the
   * pairing and the exact ceiling they were composed under); a notice that
   * says only "this changed, nothing happened" needs the pairing alone. */
  const say = async (text: string, keyboard?: Keyboard, replyTo: number | null = null, fence: "channel" | "pairing" = "channel"): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> => {
    const problem = fence === "channel"
      ? await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, repos: expectedRepos }, readProjects)
      : pairingProblem();
    if (problem !== null) return { ok: false, error: problem };
    if (!held()) return { ok: false, error: "the claim on this message lapsed" };
    let answer: Awaited<ReturnType<Transport>>;
    try {
      answer = await transport("sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(replyTo === null ? {} : { reply_parameters: { message_id: replyTo } }),
        ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
      });
    } catch {
      return { ok: false, error: "Telegram transport failed" };
    }
    if (!answer.ok) return { ok: false, error: answer.description ?? "sendMessage failed" };
    const id = (answer.result as { message_id?: number } | undefined)?.message_id;
    const messageId = Number.isSafeInteger(id) && id! > 0 ? String(id) : null;
    if (messageId !== null) replyMessageId = messageId;
    return { ok: true, messageId };
  };
  let expectedRepos: readonly string[] = [];
  const pairingProblem = (): string | null => {
    const live = store.liveTelegramBinding(botId);
    if (live === null || live.id !== binding.id || live.approverGeneration !== binding.approverGeneration) return "this chat is no longer paired";
    if (store.accountOf(live.approver)?.role !== "approver") return "the paired account is no longer an approver";
    return null;
  };

  // 2. The ceiling, reloaded now.
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    report.problems.push("telegram chat could not read the current project records");
    requeue("registry-unavailable");
    return;
  }
  const repos = telegramConversationRepos(store, binding.approver, registry);
  expectedRepos = repos;

  // 3. The session and thread — shared with the console and the CLI.
  const resolved = resolveTelegramMate(store, binding, repos, clock());
  if (!resolved.ok) {
    if (resolved.said !== null) await say(resolved.said, undefined, Number(row.messageId), "pairing");
    finish({ state: "failed", outcome: `refused:${resolved.reason}` });
    report.refused++;
    return;
  }
  const { who, session, thread, config } = resolved;
  const revalidate = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const problem = await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, repos: who.repos }, readProjects);
    return problem === null ? { ok: true } : { ok: false, reason: problem };
  };

  // 4. The turn. The claim is renewed while the model works; the poll lease
  // is the caller's. The request id is the receipt: a second pass after a
  // crash gets the original turn back, never a second dispatch.
  const heartbeat = setInterval(() => { held(); }, 30_000);
  heartbeat.unref?.();
  let outcome: Awaited<ReturnType<typeof runMateTurn>>;
  try {
    outcome = await runMateTurn({
      store, who, session, thread, config, key: null, message: row.text, requestId: row.request,
      ...(row.context === null ? {} : { context: row.context }),
      ...(options.subscriptionRunner === undefined ? {} : { subscriptionRunner: options.subscriptionRunner }),
      clock, evidenceRoot: options.evidenceRoot, revalidate,
    });
  } finally {
    clearInterval(heartbeat);
  }
  const receipt = store.mateRequestReceipt(session.id, row.request);
  if (receipt !== null) store.bindTelegramConversationTurn(row.id, owner, session.id, receipt.turn);

  if (!outcome.ok && "refused" in outcome) {
    if (outcome.refused === "concurrent") { requeue("busy"); return; }
    await say(`${outcome.message.charAt(0).toUpperCase()}${outcome.message.slice(1)}. Nothing was changed.`, undefined, Number(row.messageId), "pairing");
    finish({ state: "failed", outcome: `refused:${outcome.refused}` });
    report.refused++;
    return;
  }
  if (!outcome.ok) {
    // Truthful: what failed, that nothing was kept, and that a new message
    // is a new turn. A failed turn's drafts are already gone.
    const words = outcome.failed === "revoked" ? `${outcome.message.charAt(0).toUpperCase()}${outcome.message.slice(1)}.` : `The assistant's reply did not complete: ${outcome.message}. Nothing it proposed was kept. Send your message again if you still want it.`;
    await say(phoneText(words, 1_000), undefined, Number(row.messageId), "pairing");
    finish({ state: "failed", outcome: `failed:${outcome.failed}` });
    report.refused++;
    return;
  }

  let reply: string;
  let proposals: MateProposal[];
  let outcomeWord: string;
  if (outcome.replayed) {
    // The receipt named an earlier turn: recover ITS outcome, dispatch
    // nothing. A turn that died past its deadline is swept to failed first,
    // so a restart reports the truth instead of waiting on a ghost.
    store.sweepStaleMateTurns(clock());
    const turn = store.getMateTurn(outcome.turn);
    if (turn === null) { finish({ state: "failed", outcome: "replayed:missing" }); report.refused++; return; }
    if (turn.state === "queued" || turn.state === "running") { requeue("replayed:running"); return; }
    if (turn.state !== "answered") {
      await say(`Your earlier message was received, but the assistant's reply did not complete (${phoneText(turn.failureReason ?? "unknown", 40)}). Nothing was changed. Send it again if you still want it.`, undefined, Number(row.messageId), "pairing");
      finish({ state: "failed", outcome: `replayed:${turn.failureReason ?? "failed"}` });
      report.refused++;
      return;
    }
    reply = store.listMateMessages(thread.id, 200).find(one => one.turn === turn.id && one.role === "assistant")?.text ?? "(the reply text is no longer in the thread)";
    proposals = store.listMateProposals(thread.id, ["pending"]).filter(one => one.turn === turn.id);
    outcomeWord = "replayed";
  } else {
    reply = outcome.reply;
    proposals = store.listMateProposals(thread.id, ["pending"]).filter(one => one.turn === outcome.turn);
    outcomeWord = "answered";
  }

  // 5. The reply, then one card per proposal, each part fenced.
  const parts = splitParts(reply);
  for (const [index, part] of parts.entries()) {
    const sent = await say(part, undefined, index === 0 ? Number(row.messageId) : null);
    if (!sent.ok) {
      report.problems.push(`telegram chat reply for update ${row.updateId} could not be sent: ${sent.error}`);
      finish({ state: "failed", outcome: `unsent:${sent.error}`, replyMessageId });
      report.refused++;
      return;
    }
  }
  for (const proposal of proposals) {
    const preview = proposalPreview(store, proposal, who.repos);
    if (!preview.buttons) {
      const sent = await say(preview.text);
      if (!sent.ok) { report.problems.push(`telegram chat card for proposal ${proposal.id} could not be sent: ${sent.error}`); break; }
      continue;
    }
    const minted = mintCardTokens(store, binding, proposal.id, clock());
    const sent = await say(preview.text, minted.keyboard);
    if (!sent.ok) {
      store.consumeTelegramProposalActions(proposal.id, clock());
      report.problems.push(`telegram chat card for proposal ${proposal.id} could not be sent: ${sent.error}`);
      break;
    }
    if (sent.messageId !== null) store.placeTelegramProposalActions(minted.tokens, sent.messageId);
  }
  finish({ state: "done", outcome: outcomeWord, replyMessageId });
  report.answered++;
}
