/**
 * The mate's turn engine (mate arc §3): one reservation for the whole
 * loop, one `chat_turn` step per provider request, tools executed
 * in-process under the branded approver, results through `mateView`, and
 * only operator text and assistant text kept (ruling 11). The console
 * and the CLI drive this and render from the rows it writes.
 */
import { Buffer } from "node:buffer";
import type { ChatProviderId, MateProposalKind, MateSession, MateThread, Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { reproveApprover } from "./principal.js";
import {
  MATE_MAX_CALLS_PER_STEP,
  MATE_MAX_STEPS,
  MATE_TOOL_RESULT_CAP_BYTES,
  TURN_WALL_CLOCK_MS,
  buildDataDocument,
  composeMateRequest,
  mateWorstCaseForPrice,
  performMateRequest,
  settleForPrice,
  type MateHistoryMessage,
  type ModelPrice,
} from "./converse.js";
import { scanForSecrets } from "./evidence.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { MATE_MAX_PROPOSALS_PER_TURN, MATE_TOOL_SCHEMAS, executeMateTool } from "./mate-tools.js";

export const MATE_MESSAGE_MAX_CHARS = 2_000;
/** The thread's recent history the model sees, most recent first until the cap. */
export const MATE_HISTORY_CAP_BYTES = 16_384;
export const MATE_HISTORY_MAX_MESSAGES = 40;

export type MateTurnInput = {
  store: Store;
  who: VerifiedApprover;
  session: MateSession;
  thread: MateThread;
  provider: ChatProviderId;
  model: string;
  key: string;
  price: ModelPrice;
  credentialKey: string;
  weeklyCeilingMicrousd: number;
  message: string;
  fetcher?: typeof fetch;
  clock?: () => Date;
};

export type MateRefusal =
  | "empty-message"
  | "secret-in-message"
  | "secret-in-context"
  | "standing"
  | "ceiling-changed"
  | "latched"
  | "concurrent"
  | "session-exhausted"
  | "session-ended"
  | "over-budget";

export type MateFailure = "provider-error" | "timeout" | "malformed-reply" | "secret-refused";

export type MateTurnOutcome =
  | { ok: true; turn: number; reply: string; activity: string; proposals: number; steps: number; stoppedAtCap: boolean; settledMicrousd: number }
  | { ok: false; refused: MateRefusal; message: string }
  | { ok: false; turn: number; failed: MateFailure; message: string; unknownSpend: boolean };

export const MATE_REFUSAL_COPY: Record<MateRefusal, string> = {
  "empty-message": `a message is 1 to ${MATE_MESSAGE_MAX_CHARS} characters`,
  "secret-in-message": "that looks like a credential — the mate never forwards or stores those",
  "secret-in-context": "fleet context contains something credential-shaped — the mate refuses to send it; find and remove it first",
  standing: "your approver standing changed — sign in again",
  "ceiling-changed": "the admitted projects changed since this session was minted — mint a new one",
  latched: "a turn with unknown cost blocks this credential — acknowledge it first",
  concurrent: "one turn at a time — the last one is still running",
  "session-exhausted": "this mate session's spend ceiling would be exceeded — mint a new one to continue",
  "session-ended": "this mate session has ended — mint a new one to continue",
  "over-budget": "the weekly chat spend ceiling would be exceeded",
};

const READ_TOOLS = new Set(["recap", "list_repos", "list_tasks", "get_task", "list_decisions", "queue"]);

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
  const parts = [`read ${reads}`, `proposed ${proposals}`, `${steps} step${steps === 1 ? "" : "s"}`];
  return parts.join(" · ");
}

function capped(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= MATE_TOOL_RESULT_CAP_BYTES) return text;
  return JSON.stringify({ ok: false, message: "that result is over the size cap — ask for less: one project, one state, or a smaller limit" });
}

export async function runMateTurn(input: MateTurnInput): Promise<MateTurnOutcome> {
  const { store, who, session, thread } = input;
  const clock = input.clock ?? (() => new Date());
  const fetcher = input.fetcher ?? fetch;
  const refuse = (refused: MateRefusal): MateTurnOutcome => ({ ok: false, refused, message: MATE_REFUSAL_COPY[refused] });

  const message = input.message.trim();
  if (message === "" || message.length > MATE_MESSAGE_MAX_CHARS) return refuse("empty-message");
  // Secrets refuse BEFORE any row or request exists — nothing stored, nothing sent.
  if (scanForSecrets(message).length > 0) return refuse("secret-in-message");
  // Ruling 10: every turn re-proves the approver against the current row.
  if (!reproveApprover(store, who).ok || who.generation !== session.approverGeneration) return refuse("standing");
  // Ruling 9: the session and the thread are bound to the ceiling this surface holds.
  if (session.ceilingDigest !== who.ceilingDigest || thread.ceilingDigest !== who.ceilingDigest) return refuse("ceiling-changed");

  let now = clock();
  store.sweepStaleChatTurns(now);
  store.sweepStaleMateTurns(now);

  const snapshot = store.chatSnapshot(who.repos, now);
  const { document } = buildDataDocument(snapshot);
  const history: MateHistoryMessage[] = [...historyFor(store, thread.id), { role: "operator", text: message }];
  const compose = (): { url: string; headers: Record<string, string>; body: string } =>
    composeMateRequest({ provider: input.provider, model: input.model, key: input.key, system: MATE_CONTRACT, dataDocument: document, history, tools: MATE_TOOL_SCHEMAS });
  // The base body is scanned whole (v2 ruling 4) and measured for the reservation with the key blanked.
  const base = composeMateRequest({ provider: input.provider, model: input.model, key: "", system: MATE_CONTRACT, dataDocument: document, history, tools: MATE_TOOL_SCHEMAS });
  if (scanForSecrets(base.body).length > 0) return refuse("secret-in-context");
  const reserved = mateWorstCaseForPrice(input.price, Buffer.byteLength(base.body, "utf8"));

  const opened = store.openMateTurn(
    {
      approver: who.name,
      session: session.id,
      thread: thread.id,
      credentialKey: input.credentialKey,
      reservedMicrousd: reserved,
      weeklyCeilingMicrousd: input.weeklyCeilingMicrousd,
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
  let tokensIn = 0;
  let tokensOut = 0;
  let settled = 0;
  const draft = (kind: MateProposalKind, payload: Record<string, unknown>): number | null => {
    if (proposals >= MATE_MAX_PROPOSALS_PER_TURN) return null;
    proposals++;
    return store.draftMateProposal({ thread: thread.id, turn: turnId, kind, payload, ceilingDigest: who.ceilingDigest }, clock());
  };

  const fail = (failed: MateFailure, message: string, unknownSpend: boolean): MateTurnOutcome => {
    now = clock();
    store.discardMateProposals(turnId, now);
    store.finalizeMateTurn(turnId, started.generation, { state: "failed", settledMicrousd: settled, tokensIn, tokensOut, failureReason: failed }, now);
    return { ok: false, turn: turnId, failed, message, unknownSpend };
  };

  let reply: string | null = null;
  let stoppedAtCap = false;
  let lastText = "";
  while (steps < MATE_MAX_STEPS) {
    now = clock();
    const remainingMs = TURN_WALL_CLOCK_MS - (now.getTime() - turnStartedAt);
    if (remainingMs <= 0) return fail("timeout", "the turn ran out of time before the model finished", false);
    const request = compose();
    // Tool results join the outbound body: scanned again before every dispatch.
    if (scanForSecrets(request.body).length > 0) {
      return fail("secret-refused", "a tool result contained something credential-shaped — the turn stopped before sending it", false);
    }
    const stepId = store.openMateStep(
      { mateTurn: turnId, approver: who.name, credentialKey: input.credentialKey, provider: input.provider, model: input.model, deadlineMs: remainingMs + 10_000 },
      now,
    );
    const stepStarted = store.startChatTurn(stepId, now);
    if (!stepStarted.ok) return fail("provider-error", "the step could not be dispatched", false);
    steps++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let result: Awaited<ReturnType<typeof performMateRequest>>;
    try {
      result = await performMateRequest(request, input.provider, controller.signal, fetcher);
    } catch {
      result = { ok: false, problem: "network" };
    } finally {
      clearTimeout(timer);
    }
    now = clock();
    const finishStep = (outcome: Parameters<Store["finalizeChatTurn"]>[2]): boolean => store.finalizeChatTurn(stepId, stepStarted.generation, outcome, now);
    if (!result.ok) {
      if (result.problem.startsWith("status-")) {
        // The provider ANSWERED with an error: nothing billed for this step.
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: 0 });
        return fail("provider-error", "the provider refused the request — nothing was billed for that step", false);
      }
      if (result.problem === "timeout") {
        finishStep({ state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true });
        return fail("timeout", "the turn timed out; that step's cost is unknown and the credential is blocked until you acknowledge it", true);
      }
      if (result.problem === "network") {
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: null, unknownSpend: true });
        return fail("provider-error", "the provider could not be reached after dispatch; cost unknown — acknowledge to re-enable chat", true);
      }
      finishStep({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
      return fail("malformed-reply", "the provider's response was malformed and was discarded; cost unknown — acknowledge to re-enable chat", true);
    }
    // The pinned math, or the provider's own reported charge when HIGHER.
    const answer = result.answer;
    const stepSettled = Math.max(settleForPrice(input.price, answer.tokensIn, answer.tokensOut), answer.reportedCostMicrousd ?? 0);
    finishStep({ state: "answered", tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, settledMicrousd: stepSettled, replyBytes: Buffer.byteLength(answer.text, "utf8") });
    tokensIn += answer.tokensIn;
    tokensOut += answer.tokensOut;
    settled += stepSettled;
    lastText = answer.text;

    if (answer.calls.length === 0) {
      if (answer.text.trim() === "") return fail("malformed-reply", "the model answered with nothing", false);
      reply = answer.text;
      break;
    }
    if (answer.calls.length > MATE_MAX_CALLS_PER_STEP) return fail("malformed-reply", "the model asked for more tool calls than one step allows", false);
    history.push({ role: "assistant", text: answer.text, calls: answer.calls });
    for (const call of answer.calls) {
      if (!MATE_TOOL_SCHEMAS.some(one => one.name === call.name)) return fail("malformed-reply", `the model called a tool that does not exist (${call.name})`, false);
      const outcome = executeMateTool({ store, who, now: clock(), draft }, call.name, call.args);
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
  const finalized = store.finalizeMateTurn(turnId, started.generation, { state: "answered", settledMicrousd: settled, tokensIn, tokensOut }, now);
  if (!finalized) {
    // The sweep judged this turn first: its proposals are already expired; the reply is not durable.
    return { ok: false, turn: turnId, failed: "timeout", message: "the turn was swept as stale before it finished", unknownSpend: false };
  }
  store.promoteMateProposals(turnId);
  store.appendMateMessage({ thread: thread.id, turn: turnId, role: "assistant", text: reply, activity }, now);
  return { ok: true, turn: turnId, reply, activity, proposals, steps, stoppedAtCap, settledMicrousd: settled };
}
