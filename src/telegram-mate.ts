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
import { ceilingDigestOf, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { canonicalProject } from "./project.js";
import type { ChatConfig, MateProposal, MateSession, MateThread, Store, SubscriptionChatProviderId, TelegramBinding, TelegramConversation } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
import { phoneText, projectLabel } from "./telegram-status.js";
import { CHAT_CONTROLS, chatControlHref, chatResultHref, isChatControl, type ChatControl } from "./chat-controls.js";
import { CHAT_TASK_ACTIONS, isChatTaskAction } from "./chat-task-actions.js";
import { resultImageFileName, safeResultImageCaption, verifyResultImage } from "./chat-evidence.js";
import type { TelegramTransport, TelegramUpload } from "./telegram.js";

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
  /**
   * The https origin a phone link may open, read again on EVERY call (a
   * card is linked immediately before it is sent or edited, never from a
   * stored URL), or null when no trusted origin is configured. Production
   * wires `phoneOrigin` from webhooks.ts; absent, no card carries a link.
   */
  phoneOrigin?: () => string | null;
};

/** One Bot API call, the shape telegram.ts injects. */
export type Transport = TelegramTransport;

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

/** The one channel problem that is transient: the registry could not be read now. Retried, never a refusal. */
export const UNREADABLE_REGISTRY = "current project access could not be read";

/**
 * Is the channel still what a turn opened under? The live binding must be
 * the SAME row and generation, its approver still an approver, and the
 * enrolled ceiling (reloaded now) still the exact list the principal
 * holds — or, for a reply recovered after a restart, the ceiling digest
 * its session was minted under. A string names what changed; null means
 * nothing did.
 */
export async function telegramChannelProblem(
  store: Store,
  expected: { botId: string; bindingId: number; approverGeneration: number } & ({ repos: readonly string[] } | { ceilingDigest: string }),
  readProjects: () => Promise<readonly string[]>,
): Promise<string | null> {
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    return UNREADABLE_REGISTRY;
  }
  const binding = store.liveTelegramBinding(expected.botId);
  if (binding === null || binding.id !== expected.bindingId || binding.approverGeneration !== expected.approverGeneration) return "this chat is no longer paired";
  if (store.accountOf(binding.approver)?.role !== "approver") return "the paired account is no longer an approver";
  const repos = telegramConversationRepos(store, binding.approver, registry);
  const same = "repos" in expected
    ? repos.length === expected.repos.length && repos.every((one, index) => one === expected.repos[index])
    : ceilingDigestOf(repos) === expected.ceilingDigest;
  if (!same) return "the connected projects changed";
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

/** A step the phone cannot take itself: said once; the button (or its absence) says where. */
const HANDOFF = "This step finishes in Standing Orders.";
/** No trusted https origin is configured: one honest line, no localhost, no promise. */
export const NO_PHONE_LINK = "Phone access isn't configured. Open Standing Orders on your computer.";
/** An origin exists but the card's task is not one this phone may reach now: said as that, never as missing setup. */
export const NO_TASK_LINK = "No phone link: this task is outside your connected projects now, so open Standing Orders on the computer.";

/** A fixed console destination beside its button label. The path is one of chat-controls' own; the origin joins it only at send time. */
export type PhoneLink = { label: string; path: string };

/** Is this task one the phone's ceiling admits right now? A link names a stored identity, never a model's word alone. */
function taskInCeiling(store: Store, taskId: string, repos: readonly string[]): boolean {
  const ref = store.lookupRef(taskId);
  return ref !== null && ref.repo !== null && repos.includes(ref.repo);
}

/** The recorded scope's standing — none filed yet (a planner is drafting), waiting for approval, or approved (by hand or under a signed mode). Read from the row, never from an outcome's words. */
function approvalState(store: Store, taskId: string): "none" | "waiting" | "approved" {
  const scope = store.getScope(taskId);
  if (scope === null) return "none";
  return scope.approvedDigest != null && scope.approvedDigest === scope.digest ? "approved" : "waiting";
}

function controlLink(control: ChatControl, taskId: string): PhoneLink {
  return { label: CHAT_CONTROLS[control].label, path: chatControlHref(control, taskId) };
}

/**
 * Where a task's next step lives, from its recorded state: the approval
 * control while its scope waits for one, else the task itself.
 */
function taskLink(store: Store, taskId: string, repos: readonly string[]): PhoneLink | null {
  if (!taskInCeiling(store, taskId, repos)) return null;
  return controlLink(approvalState(store, taskId) === "waiting" ? "approval" : "task", taskId);
}

/**
 * The link a PENDING card carries: only the handoff kinds (cancel, a console
 * control), whose whole point is where to go. Confirmable cards keep their
 * Confirm/Dismiss buttons alone — a second button on a card that acts is a
 * choice the operator did not need.
 */
export function proposalLink(store: Store, proposal: MateProposal, repos: readonly string[]): PhoneLink | null {
  const payload = proposal.payload;
  const task = typeof payload["task"] === "string" ? payload["task"] : "";
  if (proposal.kind === "cancel") return task !== "" && taskInCeiling(store, task, repos) ? controlLink("cancel", task) : null;
  if (proposal.kind === "control") {
    const control = payload["control"];
    if (!isChatControl(control)) return null;
    if ("href" in CHAT_CONTROLS[control]) return controlLink(control, task);
    return task !== "" && taskInCeiling(store, task, repos) ? controlLink(control, task) : null;
  }
  return null;
}

/**
 * The link a CONFIRMED card carries: the exact recorded task the outcome
 * names, where its remaining step lives — the approval control while the
 * scope waits for one (a manual approval), the task otherwise (an
 * automatic approval, a staged resume). Kinds whose outcome is complete
 * carry none.
 */
export function confirmedLink(store: Store, outcome: DoorOutcome, proposal: MateProposal, repos: readonly string[]): PhoneLink | null {
  if (!outcome.ok || outcome.taskId === null) return null;
  const staged = proposal.kind === "task" || proposal.kind === "scope" || proposal.kind === "agents"
    || (proposal.kind === "task_action" && proposal.payload["operation"] === "resume")
    || (proposal.kind === "review" && proposal.payload["operation"] === "revise");
  return staged ? taskLink(store, outcome.taskId, repos) : null;
}

/** One url button: navigation only — it opens the console's own authenticated control and grants nothing. */
export function phoneLinkButton(origin: string | null, link: PhoneLink | null): InlineButton[] | null {
  if (origin === null || link === null) return null;
  return [{ text: link.label, url: `${origin}${link.path}` }];
}

/** Why a card that wanted a link carries none — null when it carries one. */
function linkNote(origin: string | null, link: PhoneLink | null): string | null {
  if (origin === null) return NO_PHONE_LINK;
  return link === null ? NO_TASK_LINK : null;
}

/** The keyboard as sent: the persisted callback rows, then the link row minted now. */
function keyboardWith(callbacks: CallbackKeyboard | null, link: InlineButton[] | null): Keyboard | undefined {
  const rows: Keyboard = [...(callbacks ?? []), ...(link === null ? [] : [link])];
  return rows.length === 0 ? undefined : rows;
}

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
  // A handoff's text is origin-free on purpose: it is persisted before the
  // send, and the button or the missing-setup line joins it at send time.
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
      return card(`Change agents for ${taskName}: ${parts.join("; ")}`, [], "Changing agents or risk needs renewed approval before work starts.");
    }
    case "scope":
      return card(`Rewrite the scope of ${taskName}:`, [`Goal: ${t("goal", 600)}`, ...(t("not") === "" ? [] : [`Not: ${t("not", 300)}`])], "After confirming, the new scope still needs your password approval before work starts.");
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
      return card(`${action.label}: ${taskName}${dependency === "" ? "" : ` · ${dependency}`}`, [action.detail], operation === "resume" ? "Confirming only requests the resume. Work resumes after the password step on the task, not from here." : null);
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
  get_result: { support: "direct", how: "Read during a turn; the phone card shows the verification verdict, never a local link.", gap: "Secure remote evidence links are not delivered to the phone; a result's screenshots travel through get_result_images." },
  get_result_images: { support: "direct", how: "Read during a turn; every verified original PNG/JPEG the turn selected (at most 8 per reply, the rest by offset or image id) is sent as a document with a short safe caption after the reply, re-verified before each upload, and a reply to an image binds that exact task and run.", gap: "An image whose record or bytes fail verification, or one Telegram refuses, is named in the chat rather than sent, through the same durable retried part; the operator opens the exact result in the console. Fixture proof only, no physical-phone rendering." },
  get_controls: { support: "direct", how: "Read during a turn.", gap: null },
  show_control: { support: "handoff", how: "The card names the control and the task, with one url button to that exact console control when a trusted https console-url is configured; the button opens the signed-in console and acts on nothing.", gap: "Incomplete phone action: the control itself runs in the console, after sign-in." },
  propose_task: { support: "direct", how: "Card with Confirm/Dismiss through confirmMateProposal (filed as a mate proposal, via telegram). The confirmed card links Review & start for the filed task while its scope waits; under a signed automatic mode it says the scope is approved and links the task.", gap: "Under manual approval the password step happens in the console, reached from the card's button." },
  propose_scope: { support: "direct", how: "Confirm rewrites the scope through the shared door; the confirmed card links Review & start for the exact task.", gap: "Approving the rewritten scope needs the password, in the console." },
  propose_next: { support: "direct", how: "Confirm through the shared door with the queue revision it saw.", gap: null },
  propose_reserve: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_agents: { support: "direct", how: "Confirm through the shared route-edit door; when the change stales the approval, the confirmed card links Review & start for the exact task.", gap: "Renewed approval after the route change happens in the console." },
  propose_hold: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_unhold: { support: "direct", how: "Confirm through the shared door.", gap: null },
  propose_steer: { support: "direct", how: "Confirm through the shared door; the guidance is shown verbatim on the card.", gap: null },
  propose_dependency_repair: { support: "direct", how: "Confirm retry/unlink/replace through the shared door with both projects re-checked.", gap: null },
  propose_task_action: { support: "direct", how: "stop, retry, plan, wait_for and stop_waiting confirm through the shared door (a stop is audited via telegram); resume confirms only the request, says nothing has resumed, and links the task where the password step lives.", gap: "resume completes in the console (incomplete phone action)." },
  propose_answer: { support: "direct", how: "Confirm answers through the shared door, audited via telegram; an irreversible option arms a second tap first.", gap: null },
  propose_review: { support: "direct", how: "note saves feedback; revise creates the same-family revision through the shared result service, honouring automatic approval settings; the confirmed card links Review & start for the revision while it waits, or the task once approved.", gap: "Under manual approval the revision is approved in the console, reached from the card's button; under a signed automatic-approval mode it runs unattended." },
  propose_cancel: { support: "handoff", how: "The door refuses cancel from any card; the card links the exact task's Cancel control when a trusted https console-url is configured, and the cancel is armed there.", gap: "Incomplete phone action: no phone path to cancel by design; the button only opens the task." },
};

/** Every tool the model can call, mapped; a new tool must name its phone road. */
export function parityGaps(): string[] {
  return MATE_TOOL_SCHEMAS.map(tool => tool.name).filter(name => TELEGRAM_ACTION_PARITY[name] === undefined);
}

// ---- proposal cards on the wire ------------------------------------------------------

/** One inline button: an opaque callback token (a real in-chat act) or a url (navigation, never authority). */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
type Keyboard = InlineButton[][];
/** What a part persists: callback tokens only. A url is minted at send time, never stored. */
type CallbackKeyboard = { text: string; callback_data: string }[][];

/** Mint the card's tokens before the send, so a tap can never name a token that does not exist. */
export function mintCardTokens(store: Store, binding: TelegramBinding, proposal: number, now: Date, messageId?: string): { keyboard: CallbackKeyboard; tokens: string[] } {
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
  const origin = options.phoneOrigin?.() ?? null;

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
    // A forged keyboard on a handoff card: nothing acts; the card is
    // repainted with its current link (or the honest absence of one).
    store.consumeTelegramProposalActions(proposal.id, now);
    const wanted = proposalLink(store, proposal, repos);
    const link = phoneLinkButton(origin, wanted);
    ack(link === null ? "this step finishes on the computer" : "open the button below to finish this step");
    edit(handoffCardText(preview.text, linkNote(origin, wanted)), keyboardWith(null, link));
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
  const wanted = confirmedLink(store, outcome, proposal, repos);
  const link = phoneLinkButton(origin, wanted);
  edit(confirmedCardText(store, outcome, proposal, linkNote(origin, wanted)), keyboardWith(null, link));
  return { effects, confirmed: outcome.ok, ignored: false };
}

/** A handoff card as sent or repainted: its persisted words, plus the one line saying why no link rides it. */
export function handoffCardText(text: string, note: string | null): string {
  return note === null ? text : `${text}\n\n${note}`;
}

/**
 * The resolved card, from what is RECORDED about the task the outcome
 * names — never from a word search over the door's sentence. A scope that
 * still waits for approval has one next action: approve it (the button, or
 * the console on the computer when no link exists). A scope approved under
 * a signed mode asks for nothing more. A staged resume says what remains.
 */
export function confirmedCardText(store: Store, outcome: DoorOutcome, proposal: MateProposal, note: string | null): string {
  const said = phoneText(outcome.said, 600);
  if (!outcome.ok) return `✗ Not done: ${said}`;
  const taskId = outcome.taskId;
  const resume = proposal.kind === "task_action" && proposal.payload["operation"] === "resume";
  const revise = proposal.kind === "review" && proposal.payload["operation"] === "revise";
  const staged = proposal.kind === "task" || proposal.kind === "scope" || proposal.kind === "agents" || resume || revise;
  if (!staged || taskId === null) return `✓ ${said}`;
  const state = approvalState(store, taskId);
  const approval = state === "waiting";
  // The door's sentence carries an approval instruction for a filed task or
  // a revision; under a signed automatic mode the recorded scope is already
  // approved, and the card says that instead of asking again.
  const words =
    proposal.kind === "task" && state === "approved" ? `${said.split(" — ")[0]} — approved under your automatic approval settings; nothing more is needed from you.`
    : revise && state === "approved" ? "Revision created under your automatic approval settings."
    : said;
  const next = resume ? "Nothing has resumed yet: the password step on the task finishes it."
    : approval && note !== null ? "Approve it in Standing Orders on the computer."
    : "";
  const setup = (approval || resume) && note !== null ? note : "";
  return [`✓ ${words}`, ...[next, setup].filter(one => one !== "")].join("\n\n");
}

// ---- the queued turn ---------------------------------------------------------------

export type ConversationReport = { answered: number; refused: number; problems: string[] };

/** A part's next attempt after a failed send: bounded backoff by attempt, or Telegram's own retry_after when it named a longer one. */
export const PART_RETRY_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** Unsent parts are retried this long after the message arrived (the card's own lifetime); then the row fails, explicitly unsent. */
export const DELIVERY_MAX_AGE_MS = CARD_TTL_MS;

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
      // The claim lapses on its own; the receipt and the persisted parts make the retry safe.
      args.report.problems.push(`telegram chat for update ${row.updateId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

class PlanRefused extends Error {}

type TurnArgs = { store: Store; botId: string; transport: Transport; owner: string; clock: () => Date; readProjects: () => Promise<readonly string[]>; options: TelegramConversationOptions; report: ConversationReport };

/**
 * One claimed message, in order of what is already known about it:
 *
 * 1. Unsent parts exist — the turn already answered; send what remains.
 *    No registry resolution beyond the fence, no model, no proposal.
 * 2. A session was bound before a dispatch — read the engine's receipt
 *    THERE. A receipt names the original turn: recover its outcome, even
 *    if that session has since been ended and replaced from the console.
 * 3. Otherwise resolve the session and thread, bind the session to the
 *    row BEFORE dispatching, run the turn, persist its reply and cards
 *    as parts in one transaction, then send them.
 *
 * Every outgoing part is fenced on the row's claim, the live pairing and
 * the ceiling the turn opened under; only a confirmed message id counts.
 */
async function runTelegramConversation(row: TelegramConversation, args: TurnArgs): Promise<void> {
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
  const pairingProblem = (): string | null => {
    const live = store.liveTelegramBinding(botId);
    if (live === null || live.id !== binding.id || live.approverGeneration !== binding.approverGeneration) return "this chat is no longer paired";
    if (store.accountOf(live.approver)?.role !== "approver") return "the paired account is no longer an approver";
    return null;
  };
  /** A notice that carries no project data — "this changed, nothing happened" — sent once, best effort, under the pairing fence alone. */
  const notify = async (text: string, keyboard?: Keyboard): Promise<void> => {
    if (pairingProblem() !== null || !held()) return;
    try {
      const answer = await transport("sendMessage", {
        chat_id: chatId, text, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: Number(row.messageId) },
        ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
      });
      if (!answer.ok) report.problems.push(`telegram chat notice for update ${row.updateId} could not be sent: ${answer.description ?? "sendMessage failed"}`);
    } catch {
      report.problems.push(`telegram chat notice for update ${row.updateId} could not be sent: Telegram transport failed`);
    }
  };

  /** The outbound half: send every pending part in order, each fenced; done only when every part is sent or moot. */
  const deliver = async (outcomeWord: string): Promise<void> => {
    // The row as it is NOW: the session was bound after this claim read it.
    const bound = store.getTelegramConversation(row.id)?.session ?? null;
    const session = bound === null ? null : store.getMateSession(bound);
    if (session === null) { finish({ state: "failed", outcome: "unsent:no-session" }); report.refused++; return; }
    const defer = (until: Date, why: string): void => {
      report.problems.push(`telegram chat reply for update ${row.updateId} is waiting to be sent: ${why}`);
      finish({ state: "queued", outcome: "delivering", nextAttemptAt: until.toISOString() });
    };
    for (const part of store.listTelegramConversationParts(row.id)) {
      if (part.state !== "pending") continue;
      const now = clock();
      if (part.kind === "card") {
        const proposal = part.proposal === null ? null : store.getMateProposal(part.proposal);
        if (proposal === null || proposal.state !== "pending") {
          // Confirmed or dismissed from the console or the terminal before the card went out: moot, not lost.
          if (!store.dropTelegramConversationPart(row.id, part.ordinal, owner, proposal === null ? "the proposal is gone" : `the proposal was already ${proposal.state}`, now)) return;
          continue;
        }
      }
      if (now.getTime() - Date.parse(row.createdAt) > DELIVERY_MAX_AGE_MS) {
        report.problems.push(`telegram chat reply for update ${row.updateId} was not sent within a day: ${part.lastError ?? "unsent"}`);
        finish({ state: "failed", outcome: `unsent:gave-up:${part.lastError ?? "unsent"}` });
        report.refused++;
        return;
      }
      // Telegram's own retry_after, shared with the outbox: nothing goes out while it holds.
      const limitedUntil = store.telegramRetryAt(botId);
      if (limitedUntil > now.toISOString()) { defer(new Date(limitedUntil), "Telegram asked for a pause"); return; }
      // The channel the reply was composed under, re-proved after ONE registry read; then the claim.
      let registry: readonly string[] | null = null;
      try { registry = await readProjects(); } catch { registry = null; }
      const read = registry;
      const problem = read === null ? UNREADABLE_REGISTRY : await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, ceilingDigest: session.ceilingDigest }, async () => read);
      if (problem === UNREADABLE_REGISTRY) { defer(new Date(clock().getTime() + PART_RETRY_MS[0]), problem); return; }
      if (problem !== null) {
        report.problems.push(`telegram chat reply for update ${row.updateId} was not sent: ${problem}`);
        await notify(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}, so the assistant's reply was not sent. Nothing was changed. Send your message again if you still want it.`);
        finish({ state: "failed", outcome: `unsent:${problem}` });
        report.refused++;
        return;
      }
      if (!held()) return;
      const repos = telegramConversationRepos(store, binding.approver, read ?? []);
      const backoff = new Date(clock().getTime() + PART_RETRY_MS[Math.min(part.attempts, PART_RETRY_MS.length - 1)]!);
      let send: () => ReturnType<Transport>;
      let method: "sendMessage" | "sendDocument";
      /** What Telegram's confirmed message id makes of the part: sent (the reply, a card, an image), or dropped (an image whose refusal notice is now confirmed). */
      let confirm: (messageId: string) => boolean = messageId => store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: true, messageId }, clock());
      if (part.kind === "image") {
        // The image, re-proved NOW — after the registry await, under the
        // held claim, immediately before the upload, on every attempt: the
        // task still in this phone's projects, the run still its own, the
        // artifact row still the one planned from, the bytes read again and
        // still a bounded PNG/JPEG. Anything less is refused in plain words
        // and never sent; the exact result is one button away when a
        // trusted origin can carry it. The original bytes travel untouched.
        const image = part.taskId === null || part.run === null || part.artifact === null || part.sha256 === null
          ? { ok: false as const, problem: "the saved file's record changed" }
          : verifyResultImage(store, options.evidenceRoot, repos, { taskId: part.taskId, run: part.run, artifact: part.artifact, sha256: part.sha256 });
        // The caption as persisted, checked again on every attempt: a row
        // that carries a credential-shaped task id is rebuilt from its typed
        // identity before a word of it reaches Telegram.
        const caption = safeResultImageCaption(part.text, part.taskId ?? "", part.run ?? 0);
        if (!image.ok) {
          // The refusal is the part's own message now: it rides the same
          // pending row, retry schedule and uncertain count as the upload
          // it replaces, and the part is dropped only once Telegram confirms
          // the notice. A lost or failed notice is retried after a restart
          // like any part; the image is re-verified first each time, so a
          // file repaired meanwhile is sent and one still wrong is refused
          // again. The row is never done while the notice is unconfirmed.
          report.problems.push(`telegram chat image for update ${row.updateId} was not sent: ${image.problem}`);
          const link = part.taskId !== null && part.run !== null && taskInCeiling(store, part.taskId, repos) ? { label: "Review result", path: chatResultHref(part.taskId, part.run) } : null;
          const button = phoneLinkButton(options.phoneOrigin?.() ?? null, link);
          const problem = image.problem;
          method = "sendMessage";
          send = () => transport("sendMessage", {
            chat_id: chatId,
            text: phoneText(`${caption} was not sent: ${problem}. Open the result to view it.`, 1_000),
            link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: Number(row.messageId) },
            ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }),
          });
          confirm = () => store.dropTelegramConversationPart(row.id, part.ordinal, owner, problem, clock());
        } else {
          const upload: TelegramUpload = {
            field: "document",
            fileName: resultImageFileName(part.taskId as string, part.run as number, part.artifact as number, image.format),
            contentType: image.format === "png" ? "image/png" : "image/jpeg",
            bytes: image.bytes,
          };
          method = "sendDocument";
          send = () => transport("sendDocument", { chat_id: chatId, caption }, undefined, upload);
        }
      } else {
        // A card's link is minted NOW, from the persisted proposal and the
        // origin configured at this moment: a retry after the setting changed
        // or went away carries the current truth, never a stored URL.
        const proposal = part.kind === "card" && part.proposal !== null ? store.getMateProposal(part.proposal) : null;
        const origin = proposal === null ? null : options.phoneOrigin?.() ?? null;
        const wanted = proposal === null ? null : proposalLink(store, proposal, repos);
        const keyboard = keyboardWith(part.keyboard, phoneLinkButton(origin, wanted));
        const text = proposal !== null && part.keyboard === null ? handoffCardText(part.text, linkNote(origin, wanted)) : part.text;
        method = "sendMessage";
        send = () => transport("sendMessage", {
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
          ...(part.replyTo === null ? {} : { reply_parameters: { message_id: Number(part.replyTo) } }),
          ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
        });
      }
      let answer: Awaited<ReturnType<Transport>>;
      try {
        answer = await send();
      } catch {
        // The answer was lost: Telegram may or may not have the message. Said so, retried, counted.
        const error = "Telegram transport failed; delivery may be uncertain";
        if (store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: false, error, uncertain: true, retryAt: backoff.toISOString() }, clock())) defer(backoff, error);
        return;
      }
      if (!answer.ok) {
        const retry = answer.parameters?.retry_after;
        const retryAfter = typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : null;
        const uncertain = answer.uncertain === true;
        const error = `${answer.description ?? `${method} failed`}${uncertain ? "; delivery may be uncertain" : ""}${retryAfter === null ? "" : ` (retry after ${retryAfter}s)`}`;
        let until = backoff;
        if (retryAfter !== null) {
          const paused = new Date(clock().getTime() + retryAfter * 1_000);
          store.deferTelegram(botId, paused.toISOString());
          if (paused > until) until = paused;
        }
        if (store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: false, error, uncertain, retryAt: until.toISOString() }, clock())) defer(until, error);
        return;
      }
      const id = (answer.result as { message_id?: number } | undefined)?.message_id;
      if (!Number.isSafeInteger(id) || id! <= 0) {
        const error = "Telegram returned no confirmed message identity";
        if (store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: false, error, uncertain: true, retryAt: backoff.toISOString() }, clock())) defer(backoff, error);
        return;
      }
      const messageId = String(id);
      if (!confirm(messageId)) return;
      // Placement names the persisted callback tokens only; a url row is not a token.
      if (part.keyboard !== null) store.placeTelegramProposalActions(part.keyboard.flat().map(one => one.callback_data), messageId);
    }
    if (finish({ state: "done", outcome: outcomeWord })) report.answered++;
  };

  /** The reply, one image per screenshot the ANSWERED turn selected (typed identity only — bytes are read and re-verified at send time), and one card per pending proposal, persisted with the cards' tokens in ONE transaction before any send. */
  const plan = (session: number, turn: number, reply: string, proposals: readonly MateProposal[], repos: readonly string[]): boolean => {
    try {
      return store.transact(() => {
        const now = clock();
        const parts: Parameters<Store["planTelegramConversationParts"]>[3][number][] = splitParts(reply).map((text, index) => ({ kind: "reply", text, replyTo: index === 0 ? row.messageId : null }));
        // Only a turn that answered may have its selection sent: a failed or revoked turn's rows were deleted with its drafts, and the state is read again here.
        const selected = store.getMateTurn(turn)?.state === "answered" ? store.listMateTurnEvidence(turn) : [];
        for (const image of selected) parts.push({ kind: "image", text: image.caption, taskId: image.taskId, run: image.run, artifact: image.artifact, sha256: image.sha256 });
        for (const proposal of proposals) {
          const preview = proposalPreview(store, proposal, repos);
          const keyboard = preview.buttons ? mintCardTokens(store, binding, proposal.id, now).keyboard : null;
          parts.push({ kind: "card", text: preview.text, proposal: proposal.id, keyboard });
        }
        // A lapsed claim (or parts already planned by another claimant) keeps nothing minted here.
        if (!store.planTelegramConversationParts(row.id, owner, { session, turn }, parts, now)) throw new PlanRefused();
        return true;
      });
    } catch (error) {
      if (error instanceof PlanRefused) return false;
      throw error;
    }
  };

  /** The recorded turn's outcome — nothing dispatched — from the session it was receipted under. */
  const recover = async (session: number, turnId: number, repos: readonly string[]): Promise<void> => {
    // A turn that died past its deadline is swept to failed first, so a
    // restart reports the truth instead of waiting on a ghost.
    store.sweepStaleMateTurns(clock());
    const turn = store.getMateTurn(turnId);
    if (turn === null) { finish({ state: "failed", outcome: "replayed:missing" }); report.refused++; return; }
    store.bindTelegramConversationTurn(row.id, owner, session, turnId);
    if (turn.state === "queued" || turn.state === "running") { requeue("replayed:running"); return; }
    if (turn.state !== "answered") {
      await notify(`Your earlier message was received, but the assistant's reply did not complete (${phoneText(turn.failureReason ?? "unknown", 40)}). Nothing was changed. Send it again if you still want it.`);
      finish({ state: "failed", outcome: `replayed:${turn.failureReason ?? "failed"}` });
      report.refused++;
      return;
    }
    const reply = store.listMateMessages(turn.thread, 200).find(one => one.turn === turn.id && one.role === "assistant")?.text ?? "(the reply text is no longer in the thread)";
    const proposals = store.listMateProposals(turn.thread, ["pending"]).filter(one => one.turn === turn.id);
    if (!plan(session, turnId, reply, proposals, repos) && store.listTelegramConversationParts(row.id).length === 0) return;
    await deliver("replayed");
  };

  // 2. Parts already planned: the turn answered; only the sending remains.
  if (store.listTelegramConversationParts(row.id).length > 0) { await deliver("replayed"); return; }

  // 3. The ceiling, reloaded now.
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    report.problems.push("telegram chat could not read the current project records");
    requeue("registry-unavailable");
    return;
  }
  const repos = telegramConversationRepos(store, binding.approver, registry);

  // 4. A session bound before an earlier dispatch: the receipt lives there,
  // whatever session is live today.
  if (row.session !== null) {
    const receipt = store.mateRequestReceipt(row.session, row.request);
    if (receipt !== null) { await recover(row.session, receipt.turn, repos); return; }
  }

  // 5. The session and thread — shared with the console and the CLI.
  const resolved = resolveTelegramMate(store, binding, repos, clock());
  if (!resolved.ok) {
    if (resolved.said !== null) await notify(resolved.said);
    finish({ state: "failed", outcome: `refused:${resolved.reason}` });
    report.refused++;
    return;
  }
  const { who, session, thread, config } = resolved;
  const revalidate = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const problem = await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, repos: who.repos }, readProjects);
    return problem === null ? { ok: true } : { ok: false, reason: problem };
  };
  // Bound BEFORE the dispatch, under the claim: a crash from here on finds
  // the receipt in this session, not in whichever session is live later.
  if (!store.bindTelegramConversationSession(row.id, owner, session.id)) return;

  // 6. The turn. The claim is renewed while the model works; the poll lease
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
      clock, evidenceRoot: options.evidenceRoot, revalidate, mediaDelivery: "documents",
    });
  } finally {
    clearInterval(heartbeat);
  }
  const receipt = store.mateRequestReceipt(session.id, row.request);
  if (receipt !== null) store.bindTelegramConversationTurn(row.id, owner, session.id, receipt.turn);

  if (!outcome.ok && "refused" in outcome) {
    if (outcome.refused === "concurrent") { requeue("busy"); return; }
    await notify(`${outcome.message.charAt(0).toUpperCase()}${outcome.message.slice(1)}. Nothing was changed.`);
    finish({ state: "failed", outcome: `refused:${outcome.refused}` });
    report.refused++;
    return;
  }
  if (!outcome.ok) {
    // Truthful: what failed, that nothing was kept, and that a new message
    // is a new turn. A failed turn's drafts are already gone.
    const words = outcome.failed === "revoked" ? `${outcome.message.charAt(0).toUpperCase()}${outcome.message.slice(1)}.` : `The assistant's reply did not complete: ${outcome.message}. Nothing it proposed was kept. Send your message again if you still want it.`;
    await notify(phoneText(words, 1_000));
    finish({ state: "failed", outcome: `failed:${outcome.failed}` });
    report.refused++;
    return;
  }
  if (outcome.replayed) { await recover(session.id, outcome.turn, who.repos); return; }

  // 7. The reply and its cards: durable first, then sent.
  const proposals = store.listMateProposals(thread.id, ["pending"]).filter(one => one.turn === outcome.turn);
  if (!plan(session.id, outcome.turn, outcome.reply, proposals, who.repos) && store.listTelegramConversationParts(row.id).length === 0) return;
  await deliver("answered");
}
