/**
 * The mate's turn engine (mate arc §3): one reservation for the whole
 * loop, one `chat_turn` step per provider request, tools executed
 * in-process under the branded approver, results through `mateView`, and
 * only operator text and assistant text kept (ruling 11). The console
 * and the CLI drive this and render from the rows it writes.
 *
 * Slice-1 review, folded in: the session, thread, and credential are
 * bound to the principal inside the store's admission (finding 2); the
 * principal is re-proved after every network wait and the turn's own
 * row is re-read, so a revocation mid-flight ends the loop before any
 * tool runs (finding 5); a step whose cost is unknown charges the whole
 * reservation (finding 1); the latch is re-checked before every dispatch
 * (finding 11); usage that cannot be true is malformed, never a discount
 * (finding 8); and everything the model sees passed `mateView` (finding 9).
 */
import { Buffer } from "node:buffer";
import type { ChatConfig, MateProposalKind, MateSession, MateThread, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { isVerifiedApprover, reproveApprover } from "./principal.js";
import {
  MATE_MAX_CALLS_PER_STEP,
  MATE_MAX_STEPS,
  MATE_TOOL_RESULT_CAP_BYTES,
  TURN_WALL_CLOCK_MS,
  buildDataDocument,
  composeMateRequest,
  credentialKeyOf,
  mateWorstCaseForPrice,
  performMateRequest,
  priceForConfig,
  settleForPrice,
  type MateHistoryMessage,
} from "./converse.js";
import { scanForSecrets } from "./evidence.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { MATE_MAX_PROPOSALS_PER_TURN, MATE_TOOL_SCHEMAS, executeMateTool, isMateTool, mateViewContextFor, redactForMate, toolResultBytes } from "./mate-tools.js";

export const MATE_MESSAGE_MAX_CHARS = 2_000;
/** The thread's recent history the model sees, most recent first until the cap. */
export const MATE_HISTORY_CAP_BYTES = 16_384;
export const MATE_HISTORY_MAX_MESSAGES = 40;

export type MateTurnInput = {
  store: Store;
  who: VerifiedApprover;
  session: MateSession;
  thread: MateThread;
  /** The installation's chat configuration: provider, model, pinned price, caps. */
  config: ChatConfig;
  /** The provider key; the credential identity is derived from it, never supplied. */
  key: string;
  message: string;
  fetcher?: typeof fetch;
  clock?: () => Date;
  /** Where evidence lives — get_task reads a scout's report from here. */
  evidenceRoot?: string;
};

export type MateRefusal =
  | "empty-message"
  | "secret-in-message"
  | "secret-in-context"
  | "standing"
  | "unpriced"
  | "ceiling-changed"
  | "not-yours"
  | "thread-closed"
  | "latched"
  | "concurrent"
  | "daily-cap"
  | "session-exhausted"
  | "session-ended"
  | "over-budget";

export type MateFailure = "provider-error" | "timeout" | "malformed-reply" | "secret-refused" | "latched" | "revoked" | "superseded";

export type MateTurnOutcome =
  | { ok: true; turn: number; reply: string; activity: string; proposals: number; steps: number; stoppedAtCap: boolean; settledMicrousd: number }
  | { ok: false; refused: MateRefusal; message: string }
  | { ok: false; turn: number; failed: MateFailure; message: string; unknownSpend: boolean };

export const MATE_REFUSAL_COPY: Record<MateRefusal, string> = {
  "empty-message": `a message is 1 to ${MATE_MESSAGE_MAX_CHARS} characters`,
  "secret-in-message": "that looks like a credential — the mate never forwards or stores those",
  "secret-in-context": "fleet context contains something credential-shaped — the mate refuses to send it; find and remove it first",
  standing: "your approver standing changed — sign in again",
  unpriced: "no pinned price for the chat model — re-save the chat configuration to pin one",
  "ceiling-changed": "the admitted projects changed since this session was minted — mint a new one",
  "not-yours": "that mate session is not yours to continue",
  "thread-closed": "that thread is closed — start a new one",
  latched: "a turn with unknown cost blocks this credential — acknowledge it first",
  concurrent: "one turn at a time — the last one is still running",
  "daily-cap": "the daily turn cap is reached",
  "session-exhausted": "this mate session's spend ceiling would be exceeded — mint a new one to continue",
  "session-ended": "this mate session has ended — mint a new one to continue",
  "over-budget": "the weekly chat spend ceiling would be exceeded",
};

const READ_TOOLS = new Set(["recap", "list_repos", "list_tasks", "get_task", "list_decisions", "get_decision", "queue"]);

/** The last messages of the thread as provider-neutral history, newest kept first until the byte cap. */
export function historyFor(store: Store, thread: number): MateHistoryMessage[] {
  const rows = store.listMateMessages(thread, MATE_HISTORY_MAX_MESSAGES);
  const kept: MateHistoryMessage[] = [];
  let bytes = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    bytes += Buffer.byteLength(row.text, "utf8");
    if (bytes > MATE_HISTORY_CAP_BYTES) break;
    kept.unshift(row.role === "operator" ? { role: "operator", text: row.text } : { role: "assistant", text: row.text, calls: [] });
  }
  // A history must open with the operator: a leading assistant reply without its question is dropped.
  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

/** "read 3 · proposed 1 · 2 steps" — counts only, never results (ruling 11). */
export function activitySummary(reads: number, proposals: number, steps: number): string {
  return [`read ${reads}`, `proposed ${proposals}`, `${steps} step${steps === 1 ? "" : "s"}`].join(" · ");
}

/** A tool result as the model sees it, measured as embedded; over the cap it becomes a typed refusal. */
function capped(value: unknown): string {
  const text = JSON.stringify(value);
  if (toolResultBytes(text) <= MATE_TOOL_RESULT_CAP_BYTES) return text;
  return JSON.stringify({ ok: false, message: "that result is over the size cap — ask for less: one project, one state, or a smaller limit" });
}

export async function runMateTurn(input: MateTurnInput): Promise<MateTurnOutcome> {
  const { store, who, session, thread, config } = input;
  const clock = input.clock ?? (() => new Date());
  const fetcher = input.fetcher ?? fetch;
  const refuse = (refused: MateRefusal): MateTurnOutcome => ({ ok: false, refused, message: MATE_REFUSAL_COPY[refused] });

  const message = input.message.trim();
  if (message === "" || message.length > MATE_MESSAGE_MAX_CHARS) return refuse("empty-message");
  // Secrets refuse BEFORE any row or request exists — nothing stored, nothing sent.
  if (scanForSecrets(message).length > 0) return refuse("secret-in-message");
  // Ruling 3 + 10: a minted, intact principal, re-proved against the current row.
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok || who.generation !== session.approverGeneration) return refuse("standing");
  // Ruling 9: the session and the thread are bound to the ceiling this surface holds.
  if (session.ceilingDigest !== who.ceilingDigest || thread.ceilingDigest !== who.ceilingDigest) return refuse("ceiling-changed");
  const price = priceForConfig(config);
  if (price === null) return refuse("unpriced");
  // The credential identity is DERIVED from the key (finding 2): the ledger
  // and the latch it binds to cannot be renamed away by a caller.
  const credentialKey = credentialKeyOf(config.provider, input.key);

  let now = clock();
  store.sweepStaleMateTurns(now);

  const view = mateViewContextFor(store, who);
  const snapshot = store.chatSnapshot(who.repos, now);
  const document = redactForMate(buildDataDocument(snapshot).document, view);
  const history: MateHistoryMessage[] = [...historyFor(store, thread.id), { role: "operator", text: message }];
  const compose = (key: string): { url: string; headers: Record<string, string>; body: string } =>
    composeMateRequest({ provider: config.provider, model: config.model, key, system: MATE_CONTRACT, dataDocument: document, history, tools: MATE_TOOL_SCHEMAS });
  // The base body is scanned whole (v2 ruling 4) and measured for the reservation.
  const base = compose("");
  if (scanForSecrets(base.body).length > 0) return refuse("secret-in-context");
  const reserved = mateWorstCaseForPrice(price, Buffer.byteLength(base.body, "utf8"));

  const opened = store.openMateTurn(
    {
      approver: who.name,
      session: session.id,
      thread: thread.id,
      credentialKey,
      reservedMicrousd: reserved,
      dailyTurns: config.dailyTurns,
      weeklyCeilingMicrousd: config.weeklyCeilingMicrousd,
      deadlineMs: TURN_WALL_CLOCK_MS + 10_000,
    },
    now,
  );
  if (!opened.ok) return refuse(opened.reason);
  const turnId = opened.id;
  const started = store.startMateTurn(turnId, now);
  if (!started.ok) return refuse("concurrent");
  const turnStartedAt = now.getTime();
  store.appendMateMessage({ thread: thread.id, turn: turnId, role: "operator", text: message }, now);

  let proposals = 0;
  let reads = 0;
  let steps = 0;
  const readDecisions = new Map<number, number>();
  let tokensIn = 0;
  let tokensOut = 0;
  let settled = 0;
  const draft = (kind: MateProposalKind, payload: Record<string, unknown>): number | null => {
    if (proposals >= MATE_MAX_PROPOSALS_PER_TURN) return null;
    proposals++;
    return store.draftMateProposal({ thread: thread.id, turn: turnId, kind, payload, ceilingDigest: who.ceilingDigest }, clock());
  };

  /** The turn ends failed: its drafts are deleted, its cost settled — the whole reservation when any of it is unknown. */
  const fail = (failed: MateFailure, message: string, unknownSpend: boolean): MateTurnOutcome => {
    now = clock();
    store.finalizeMateTurn(turnId, started.generation, { state: "failed", settledMicrousd: settled, unknownSpend, tokensIn, tokensOut, failureReason: failed }, now);
    return { ok: false, turn: turnId, failed, message, unknownSpend };
  };
  /** The turn's own row, re-read: still running under our generation, or someone ended it under us. */
  const stillOurs = (): boolean => {
    const row = store.getMateTurn(turnId);
    return row !== null && row.state === "running" && row.generation === started.generation;
  };

  let reply: string | null = null;
  let stoppedAtCap = false;
  let lastText = "";
  while (steps < MATE_MAX_STEPS) {
    now = clock();
    const remainingMs = TURN_WALL_CLOCK_MS - (now.getTime() - turnStartedAt);
    if (remainingMs <= 0) return fail("timeout", "the turn ran out of time before the model finished", false);
    const request = compose(input.key);
    // Tool results join the outbound body: scanned again before every dispatch.
    if (scanForSecrets(request.body).length > 0) {
      return fail("secret-refused", "a tool result contained something credential-shaped — the turn stopped before sending it", false);
    }
    const step = store.openMateStep(
      { mateTurn: turnId, generation: started.generation, approver: who.name, credentialKey, provider: config.provider, model: config.model, deadlineMs: remainingMs + 10_000 },
      now,
    );
    if (!step.ok) {
      if (step.reason === "latched") return fail("latched", "a turn with unknown cost latched this credential mid-conversation — acknowledge it first", false);
      return { ok: false, turn: turnId, failed: "superseded", message: "this turn was ended before its next step", unknownSpend: false };
    }
    const stepStarted = store.startChatTurn(step.id, now);
    if (!stepStarted.ok) return fail("provider-error", "the step could not be dispatched", false);
    steps++;
    const requestBytes = Buffer.byteLength(request.body, "utf8");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let result: Awaited<ReturnType<typeof performMateRequest>>;
    try {
      result = await performMateRequest(request, config.provider, controller.signal, fetcher);
    } catch {
      result = { ok: false, problem: "network" };
    } finally {
      clearTimeout(timer);
    }
    now = clock();
    const finishStep = (outcome: Parameters<Store["finalizeChatTurn"]>[2]): boolean => store.finalizeChatTurn(step.id, stepStarted.generation, outcome, now);
    if (!result.ok) {
      if (result.problem.startsWith("status-")) {
        // The provider ANSWERED with an error: nothing billed for this step.
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: 0 });
        return fail("provider-error", "the provider refused the request — nothing was billed for that step", false);
      }
      if (result.problem === "timeout") {
        finishStep({ state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true });
        return fail("timeout", "the turn timed out; that step's cost is unknown — the whole reservation is charged and the credential is blocked until you acknowledge it", true);
      }
      if (result.problem === "network") {
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: null, unknownSpend: true });
        return fail("provider-error", "the provider could not be reached after dispatch; cost unknown — the whole reservation is charged; acknowledge to re-enable chat", true);
      }
      finishStep({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
      return fail("malformed-reply", "the provider's response was malformed and was discarded; cost unknown — the whole reservation is charged; acknowledge to re-enable chat", true);
    }
    const answer = result.answer;
    // Usage that cannot be true — more input tokens than bytes sent — is a
    // malformed reply with unknown cost, never a number to settle by.
    if (answer.tokensIn > requestBytes) {
      finishStep({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
      return fail("malformed-reply", "the provider reported usage that cannot be true; cost unknown — the whole reservation is charged; acknowledge to re-enable chat", true);
    }
    // The pinned math, or the provider's own reported charge when HIGHER.
    const stepSettled = Math.max(settleForPrice(price, answer.tokensIn, answer.tokensOut), answer.reportedCostMicrousd ?? 0);
    finishStep({ state: "answered", tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, settledMicrousd: stepSettled, replyBytes: Buffer.byteLength(answer.text, "utf8") });
    tokensIn += answer.tokensIn;
    tokensOut += answer.tokensOut;
    settled += stepSettled;
    lastText = answer.text;

    // After the wait (finding 5): the row may have been failed under us by
    // a revocation or the sweep — then nothing the model said runs; and the
    // approver must still stand before any tool runs as them.
    if (!stillOurs()) return { ok: false, turn: turnId, failed: "superseded", message: "this turn was ended while the model was answering", unknownSpend: false };
    const standing = reproveApprover(store, who);
    const liveSession = store.getMateSession(session.id);
    if (!standing.ok || liveSession === null || liveSession.endedAt !== null || liveSession.expiresAt <= now.toISOString()) {
      return fail("revoked", "your standing or this session ended while the model was answering — nothing it proposed was kept", false);
    }

    if (answer.calls.length === 0) {
      if (answer.text.trim() === "") return fail("malformed-reply", "the model answered with nothing", false);
      reply = answer.text;
      break;
    }
    if (answer.calls.length > MATE_MAX_CALLS_PER_STEP) return fail("malformed-reply", "the model asked for more tool calls than one step allows", false);
    for (const call of answer.calls) {
      if (!isMateTool(call.name)) return fail("malformed-reply", "the model called a tool that does not exist", false);
    }
    history.push({ role: "assistant", text: answer.text, calls: answer.calls });
    for (const call of answer.calls) {
      const outcome = executeMateTool({ store, who, now: clock(), draft, step: steps, readDecisions, ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }) }, call.name, call.args, view);
      if (READ_TOOLS.has(call.name)) reads++;
      history.push({ role: "tool", callId: call.id, name: call.name, result: capped(outcome.ok ? outcome.body : { ok: false, message: outcome.message }) });
    }
  }
  if (reply === null) {
    stoppedAtCap = true;
    reply = `${lastText.trim() === "" ? "" : `${lastText.trim()}\n\n`}(stopped after ${MATE_MAX_STEPS} steps)`;
  }
  // Ruling 11: model text is scanned before it becomes durable.
  if (scanForSecrets(reply).length > 0) return fail("secret-refused", "the model's reply contained something credential-shaped and was discarded", false);

  now = clock();
  const activity = activitySummary(reads, proposals, steps);
  // One write (finding 12): settle, debit, promote the drafts, append the assistant text.
  const finalized = store.finalizeMateTurn(turnId, started.generation, { state: "answered", settledMicrousd: settled, tokensIn, tokensOut, message: { text: reply, activity } }, now);
  if (!finalized) return { ok: false, turn: turnId, failed: "superseded", message: "this turn was ended before it could be kept", unknownSpend: false };
  return { ok: true, turn: turnId, reply, activity, proposals, steps, stoppedAtCap, settledMicrousd: settled };
}
