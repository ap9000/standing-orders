/**
 * The paired phone as one more way to use the same assistant, against a
 * scripted Bot API and a scripted membership harness: ordinary text runs
 * the shared engine on the shared thread, cards confirm through the shared
 * doors with the phone named as the source, a reply to a result binds the
 * exact run, and every hostile or unlucky shape — wrong sender, stale
 * button, revoked pairing mid-turn, a crash between admission and reply,
 * a console confirmation racing a tap — ends with nothing done twice.
 *
 * Fixture transport, not a phone: nothing here is a live Telegram proof.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type TelegramBinding } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { bridgePass, followBridge, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, saveBotToken, TOKEN_ENV, type TelegramTransport } from "./telegram.js";
import { ceilingDigestOf, verifyApproverStanding } from "./principal.js";
import { subscriptionCredentialKey } from "./converse.js";
import { confirmMateProposal } from "./mate-doors.js";
import { MATE_TOOL_SCHEMAS, executeMateTool } from "./mate-tools.js";
import { runMateCli } from "./mate-cli.js";
import { readChatResult } from "./chat-review.js";
import { chatTaskStamp } from "./chat-task-actions.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { runOperate, EXIT } from "./operate.js";
import { saveRepos } from "./repos.js";
import { run as exec } from "./exec.js";
import { CONVERSATION_CLAIM_MS, TELEGRAM_ACTION_PARITY, mintCardTokens, parityGaps, proposalPreview, telegramRequestId } from "./telegram-mate.js";
import type { SubscriptionMateRequest, SubscriptionMateRunner } from "./subscription-chat.js";
import { TURN_WALL_CLOCK_MS } from "./converse.js";

const T0 = new Date("2026-09-16T09:00:00.000Z");
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;

type Call = { id: string; name: string; args: Record<string, unknown> };
type Answer = { text: string; calls?: Call[]; before?: () => void | Promise<void> };

function scriptedTransport() {
  const calls: { method: string; params: Record<string, unknown>; messageId: number | null }[] = [];
  const updates: unknown[][] = [];
  let nextMessageId = 100;
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") {
      calls.push({ method, params, messageId: null });
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(update => Number((update as { update_id: number }).update_id) >= offset) };
    }
    if (method === "sendMessage") {
      const messageId = nextMessageId++;
      calls.push({ method, params, messageId });
      return { ok: true, result: { message_id: messageId } };
    }
    calls.push({ method, params, messageId: null });
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const texts = () => sends().map(call => String(call.params["text"]));
  const edits = () => calls.filter(call => call.method === "editMessageText").map(call => String(call.params["text"]));
  const acks = () => calls.filter(call => call.method === "answerCallbackQuery").map(call => String(call.params["text"] ?? ""));
  /** The card: the last send carrying a keyboard, with its opaque tokens. */
  const card = () => {
    const sent = [...sends()].reverse().find(call => call.params["reply_markup"] !== undefined);
    if (sent === undefined) throw new Error("no card was sent");
    const rows = (sent.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    const button = (label: RegExp): string => {
      const found = rows.flat().find(one => label.test(one.text));
      if (found === undefined) throw new Error(`no ${label} button on the card`);
      return found.callback_data;
    };
    return { messageId: sent.messageId as number, text: String(sent.params["text"]), rows, button };
  };
  return { transport, calls, updates, sends, texts, edits, acks, card };
}

const textUpdate = (id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: { message_id: 1000 + id, chat: { id: CHAT, type: "private" }, from: { id: USER }, text, ...extra },
});
const tap = (id: number, data: string, messageId: number, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  callback_query: { id: `cb-${id}`, data, from: { id: USER }, message: { message_id: messageId, chat: { id: CHAT } }, ...extra },
});

describe("Telegram conversation: the same chat, from the phone", () => {
  let dir: string;
  let file: string;
  let evidenceRoot: string;
  let repo: string;
  let store: Store;
  let now: Date;
  let projects: string[];
  let token: string;
  let answers: Answer[];
  let requests: SubscriptionMateRequest[];
  let script: ReturnType<typeof scriptedTransport>;

  const runner: SubscriptionMateRunner = async request => {
    requests.push(request);
    const next = answers.shift();
    if (next === undefined) throw new Error("the harness script ran out of answers");
    await next.before?.();
    return { ok: true, answer: { text: next.text, calls: next.calls ?? [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
  };
  const readProjects = vi.fn(async () => projects);
  const binding = (): TelegramBinding => store.liveTelegramBinding(BOT)!;
  const pair = () => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(USER), updateId: 1 }, now).ok).toBe(true);
  };
  const pass = (extra: Partial<Parameters<typeof bridgePass>[1]> = {}) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, deliver: false, readProjects, conversation: { evidenceRoot, subscriptionRunner: runner }, ...extra });
  const who = () => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const task = (id: string, title = `work ${id}`) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };
  /** An approved, built source with a sealed terminal diff to annotate — the result a phone can reply to. */
  const seedSource = (id: string) => {
    const ref = task(id, `Guard the payout path (${id})`);
    propose(store, { taskId: id, goal: `do ${id} carefully`, touches: ["src/payments/"], acceptance: [{ id: "c1", statement: "The guard holds", how: null, evidence: ["manual-review"] }], now });
    const scope = store.getScope(id)!;
    const approved = approve(store, id, "alex", now, scope.digest, token);
    if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`);
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from(`diff --git a/${id} b/${id}\n+x\n`, "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    const artifact = store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, now);
    store.setTaskState(id, "done", now);
    return { ref, run, artifact };
  };
  /** A pending card of one kind on the phone's own session and thread, its tokens placed on a synthetic message. */
  const card = (kind: Parameters<Store["draftMateProposal"]>[0]["kind"], payload: Record<string, unknown>, messageId = 77) => {
    const me = who();
    const credentialKey = subscriptionCredentialKey("claude-subscription");
    let session = store.activeMateSession("alex");
    if (session === null) {
      store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
      session = store.activeMateSession("alex")!;
    }
    const thread = store.openMateThread("alex", me.ceilingDigest, now).thread;
    const opened = store.openMateTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, now);
    if (!started.ok) throw new Error("start");
    const id = store.draftMateProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: me.ceilingDigest }, now);
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now);
    const minted = mintCardTokens(store, binding(), id, now, String(messageId));
    return { id, confirm: minted.tokens[0]!, dismiss: minted.tokens[1]!, messageId, preview: proposalPreview(store, store.getMateProposal(id)!, [repo]) };
  };
  let nextUpdate = 10;
  const tapPass = async (data: string, messageId: number) => {
    script.updates.push([tap(nextUpdate++, data, messageId)]);
    return pass();
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-telegram-mate-")));
    file = join(dir, "orders.db");
    evidenceRoot = join(dir, "evidence");
    repo = join(dir, "repo");
    mkdirSync(evidenceRoot); mkdirSync(repo);
    now = T0;
    projects = [repo];
    answers = [];
    requests = [];
    nextUpdate = 10;
    readProjects.mockClear();
    script = scriptedTransport();
    store = openStore(file);
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", now);
    const added = addApprover(store, "alex", now);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
    pair();
  });
  afterEach(() => { try { store.close(); } catch { /* a production-wiring test closed it */ } rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  test("ordinary text runs the shared engine on the shared thread; the card confirms through the shared door as telegram; web and CLI read the same rows; a replay does nothing twice", async () => {
    answers.push(
      { text: "Let me draft that.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Tighten the payout guard", goal: "Refuse a payout over the limit.", acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed a task to tighten the payout guard. Confirm it to file it." },
    );
    // Durable before acknowledged: when the cursor moves past the update, its row already exists.
    const cursorMoves = vi.spyOn(store, "advanceBridgeCursor");
    script.updates.push([textUpdate(2, "Please tighten the payout guard so an over-limit payout is refused")]);
    const first = await pass();
    expect(first).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, ignored: 0, problems: [] } });
    expect(cursorMoves).toHaveBeenCalledTimes(1);
    const rows = store.listTelegramConversations(BOT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ updateId: 2, messageId: "1002", state: "done", outcome: "answered", request: telegramRequestId(BOT, binding().id, 2), approver: "alex", text: "Please tighten the payout guard so an over-limit payout is refused" });
    expect(rows[0]!.turn).not.toBeNull();
    expect(Number(store.handle.prepare("SELECT cursor FROM bridge_lease WHERE bot_id = ?").get(BOT)?.["cursor"])).toBe(2);
    // The engine ran twice (a tool step, then text); the session is a membership session over the enrolled ceiling.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.history.filter(one => one.role === "operator").at(-1)).toMatchObject({ role: "operator", text: "Please tighten the payout guard so an over-limit payout is refused" });
    const session = store.activeMateSession("alex")!;
    expect(session).toMatchObject({ credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo]), approverGeneration: who().generation });
    expect(rows[0]!.session).toBe(session.id);
    // The reply, then the card, both to this chat; the reply answers the operator's message.
    expect(script.texts()[0]).toBe("Proposed a task to tighten the payout guard. Confirm it to file it.");
    expect(script.sends()[0]!.params["reply_parameters"]).toEqual({ message_id: 1002 });
    const sent = script.card();
    expect(sent.text).toContain("Create task in repo: Tighten the payout guard");
    expect(sent.text).toContain("Goal: Refuse a payout over the limit.");
    expect(sent.text).toContain("You still approve its scope before work starts.");
    expect(sent.rows[0]!.map(one => one.text)).toEqual(["Confirm", "Dismiss"]);
    // The console's view: the same live thread under the same ceiling, its messages and pending card.
    const me = who();
    const opened = store.openMateThread(me.name, me.ceilingDigest, now);
    expect(opened.ceilingChanged).toBe(false);
    expect(store.listMateMessages(opened.thread.id, 10).map(one => [one.role, one.text])).toEqual([
      ["operator", "Please tighten the payout guard so an over-limit payout is refused"],
      ["assistant", "Proposed a task to tighten the payout guard. Confirm it to file it."],
    ]);
    const pending = store.listMateProposals(opened.thread.id, ["pending"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "task", state: "pending" });
    // The terminal's view: `standing-orders chat` lists the phone's card on the same session (no new mint).
    const lines: string[] = [];
    const cli = await runMateCli({ store, databaseFile: file, write: line => lines.push(line), json: false, credentials: { name: "alex", token }, repos: [repo], say: undefined, end: false, ceilingUsd: undefined, seams: { lines: ["proposals", "quit"], clock: () => now } });
    expect(cli.code).toBe(0);
    expect(lines.join("\n")).toContain("mate conversation live");
    expect(lines.join("\n")).toContain('file "Tighten the payout guard"');
    expect(store.activeMateSession("alex")?.id).toBe(session.id);
    // Confirm from the phone: the shared door files the task and records the phone as the source.
    const confirmed = await tapPass(sent.button(/^Confirm$/), sent.messageId);
    expect(confirmed).toMatchObject({ ok: true, report: { chatConfirmed: 1, ignored: 0 } });
    const proposal = store.getMateProposal(pending[0]!.id)!;
    expect(proposal.state).toBe("confirmed");
    expect(proposal.outcome).toMatchObject({ ok: true, kind: "task", via: "telegram" });
    const filed = (proposal.outcome as { taskId: string }).taskId;
    expect(store.getTask(filed)).toMatchObject({ title: "Tighten the payout guard" });
    expect(store.lookupRef(filed)?.repo).toBe(repo);
    expect(script.acks().at(-1)).toBe("✓ done");
    expect(script.edits().at(-1)).toMatch(/^✓ filed .*\n\nApprove its scope in Standing Orders on the computer before work starts\.$/s);
    // /task reads the filed task on the same view.
    script.updates.push([textUpdate(nextUpdate++, `/task ${filed}`)]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(script.texts().at(-1)).toContain("Tighten the payout guard");
    // Replay of both updates: nothing runs, nothing files, nothing is sent.
    const sendsBefore = script.sends().length;
    const tasksBefore = store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    script.updates.push([textUpdate(2, "Please tighten the payout guard so an over-limit payout is refused"), tap(10, sent.button(/^Confirm$/), sent.messageId)]);
    const replayed = await pass();
    expect(replayed.ok && replayed.report.chatQueued).toBeFalsy();
    expect(replayed.ok && replayed.report.chatConfirmed).toBeFalsy();
    expect(requests).toHaveLength(2);
    expect(script.sends()).toHaveLength(sendsBefore);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(tasksBefore);
    expect(store.listTelegramConversations(BOT)).toHaveLength(1);
  });

  test("a reply to a result message binds that exact run; confirming creates the same-family revision, audited as telegram", async () => {
    const { run } = seedSource("payout");
    // The result reaches the phone through the outbox with its exact task/run provenance.
    store.enqueueNotification({ dedupeKey: `result:${run}`, kind: "report-ready", subject: "Result ready", body: "Built and verified.", source: { run } }, now);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    const resultMessage = script.sends()[0]!.messageId as number;
    expect(store.telegramMessageBindings(binding(), String(resultMessage))).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
    answers.push(
      { text: "Reading the result.", calls: [{ id: "r1", name: "get_result", args: { task: "payout", run } }] },
      { text: "Proposing the change.", calls: [{ id: "r2", name: "propose_review", args: { run, operation: "revise", note: "Rename the guard and add a test for the over-limit case." } }] },
      { text: "I proposed a revision of payout with your feedback. Confirm it to create the revision." },
    );
    script.updates.push([textUpdate(5, "Rename the guard and add a test for the over-limit case.", { reply_to_message: { message_id: resultMessage } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
    const row = store.listTelegramConversations(BOT)[0]!;
    expect(row).toMatchObject({ replyTo: String(resultMessage), taskId: "payout", sourceRun: run, state: "done" });
    const asked = requests[0]!.history.filter(one => one.role === "operator").at(-1) as { text: string };
    expect(asked.text).toContain(`replying to result #${run} from execution payout`);
    expect(asked.text).not.toMatch(/\/pool|evidence/);
    const sent = script.card();
    expect(sent.text).toContain(`Request changes to result #${run} of Guard the payout path (payout)`);
    expect(sent.text).toContain("| Rename the guard and add a test for the over-limit case.");
    expect(sent.text).toContain("Creates a revision of the same task.");
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id)[0]!;
    expect(proposal).toMatchObject({ kind: "review", state: "confirmed" });
    expect(proposal.outcome).toMatchObject({ ok: true, via: "telegram" });
    const child = (proposal.outcome as { taskId: string }).taskId;
    const family = store.taskFamilyOf("payout", [repo], false)!;
    expect(family.problem).toBeNull();
    expect(family.versions.map(one => one.id)).toEqual(["payout", child]);
    expect(store.getTask(child)?.title).toBe("Guard the payout path (payout) — revision");
    expect(store.revisionSourceOf(store.lookupRef(child)!.id)).toMatchObject({ sourceRun: run, sourceTask: "payout" });
    expect(store.allDiffComments(run).map(one => [one.author, one.note, one.consumedBy])).toEqual([["alex", "Rename the guard and add a test for the over-limit case.", child]]);
    expect(script.edits().at(-1)).toContain("✓ Revision created. Review and approve it to start.");
    expect(script.edits().at(-1)).toContain("Approve the revision in Standing Orders on the computer");
    // The revision's own status reads from the phone, on the same records.
    script.updates.push([textUpdate(nextUpdate++, `/task ${child}`)]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(script.texts().at(-1)).toContain("— revision");
  });

  test.each([
    { from: { id: USER + 1 } }, { chat: { id: CHAT + 1, type: "private" } }, { chat: { id: CHAT, type: "group" } },
    { forward_origin: {} }, { forward_date: 1 }, { via_bot: {} }, { sender_chat: {} }, { caption: "photo" },
  ])("an untrusted envelope %j never queues a turn, reads projects, or reaches the harness", async extra => {
    script.updates.push([textUpdate(2, "cancel everything", extra)]);
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(readProjects).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(script.sends()).toEqual([]);
  });

  test("an unpaired, rotated, or downgraded identity gets silence; a message queued before revocation runs nothing afterwards", async () => {
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
    script.updates.push([textUpdate(2, "hello")]);
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    store.handle.prepare("UPDATE approver SET generation = generation - 1 WHERE name = 'alex'").run();
    // Queued under a live pairing, revoked before the turn started: no harness call, no reply, the row says why.
    const queueOnly = vi.spyOn(store, "claimTelegramConversation").mockReturnValueOnce(null);
    script.updates.push([textUpdate(3, "hello again")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    queueOnly.mockRestore();
    expect(store.listTelegramConversations(BOT)[0]?.state).toBe("queued");
    store.unpairTelegram(BOT, "alex", now);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "unpaired" });
    expect(requests).toEqual([]);
    expect(script.sends()).toEqual([]);
  });

  test.each(["unpair", "unenroll", "viewer"])("%s while the harness is answering ends the turn before any tool runs: nothing proposed, nothing sent, the failure named", async change => {
    answers.push({
      text: "Holding it.",
      calls: [{ id: "h1", name: "propose_hold", args: { task: "a", reason: "wait" } }],
      before: () => {
        if (change === "unpair") store.unpairTelegram(BOT, "alex", now);
        else if (change === "unenroll") projects = [];
        else store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run();
      },
    });
    task("a");
    script.updates.push([textUpdate(2, "hold task a")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatRefused: 1 } });
    expect(requests).toHaveLength(1);
    const row = store.listTelegramConversations(BOT)[0]!;
    expect(row).toMatchObject({ state: "failed", outcome: expect.stringMatching(/^failed:revoked|^failed:superseded/) });
    expect(store.getMateTurn(row.turn!)).toMatchObject({ state: "failed" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_proposal").get()?.["n"]).toBe(0);
    expect(store.activeHolds(store.lookupRef("a")!.id, now)).toEqual([]);
    // Unenrolled: the pairing still stands, so the truth is said; unpaired or downgraded: nothing may be sent at all.
    if (change === "unenroll") {
      expect(script.texts()).toHaveLength(1);
      expect(script.texts()[0]).toContain("the connected projects changed");
    } else {
      expect(script.sends()).toEqual([]);
    }
  });

  test("long text is refused whole with no model call; a reply to a digest naming two tasks asks which", async () => {
    const long = "x".repeat(2_001);
    script.updates.push([textUpdate(2, long)]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts()[0]).toContain("2,001 characters; chat takes up to 2,000");
    expect(script.texts()[0]).toContain("Nothing was sent to the assistant");
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(requests).toEqual([]);
    // Two routine facts about two tasks in one digest part: a reply to it is ambiguous, never guessed.
    const a = task("a"), b = task("b");
    store.enqueueNotification({ dedupeKey: "a-fact", kind: "report-ready", subject: "a moved", body: "a", source: { taskRef: a } }, now);
    store.enqueueNotification({ dedupeKey: "b-fact", kind: "report-ready", subject: "b moved", body: "b", source: { taskRef: b } }, now);
    store.setTelegramDigest(60_000, "alex", now);
    now = new Date(T0.getTime() + 61_000);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 2, digests: 1 } });
    const digest = script.sends().at(-1)!;
    expect(String(digest.params["text"])).toContain("digest — 2 routine fact(s)");
    script.updates.push([textUpdate(3, "approve it", { reply_to_message: { message_id: digest.messageId } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts().at(-1)).toContain("mentions more than one task");
    expect(script.texts().at(-1)).toContain("• a");
    expect(script.texts().at(-1)).toContain("• b");
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a crash between the engine's receipt and the reply is recovered after restart from the receipt — no second dispatch", async () => {
    answers.push({ text: "Nothing waits on you right now." });
    // The process dies right after the turn answered, before its row settles.
    const dying = vi.spyOn(store, "bindTelegramConversationTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
    script.updates.push([textUpdate(2, "what needs me?")]);
    const crashed = await pass();
    expect(crashed).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("power cut")] } });
    dying.mockRestore();
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "running", outcome: null });
    expect(store.handle.prepare("SELECT state FROM mate_turn").all().map(row => row["state"])).toEqual(["answered"]);
    expect(script.sends()).toEqual([]);
    // Restart: a new process, the claim lapsed, the same update never re-read.
    store.close(); store = openStore(file);
    now = new Date(T0.getTime() + CONVERSATION_CLAIM_MS + 1_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
    expect(requests).toHaveLength(1);
    expect(script.texts()).toEqual(["Nothing waits on you right now."]);
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "done", outcome: "replayed", attempts: 2 });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]).toBe(1);
  });

  test("a crash while the harness was answering is reported truthfully after restart, never restarted silently", async () => {
    answers.push({ text: "Still thinking." });
    const dying = vi.spyOn(store, "finalizeChatTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
    script.updates.push([textUpdate(2, "what needs me?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("power cut")] } });
    dying.mockRestore();
    store.close(); store = openStore(file);
    now = new Date(T0.getTime() + TURN_WALL_CLOCK_MS + CONVERSATION_CLAIM_MS + 60_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(requests).toHaveLength(1);
    expect(script.texts()).toEqual([expect.stringContaining("the assistant's reply did not complete (crashed). Nothing was changed.")]);
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "replayed:crashed" });
  });

  test("a console confirmation racing the tap wins once: the tap shows the recorded outcome and files nothing", async () => {
    answers.push(
      { text: "Drafting.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Add the limit", goal: "Add a payout limit.", acceptance: [{ id: "c1", statement: "The limit holds.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed. Confirm to file." },
    );
    script.updates.push([textUpdate(2, "add a payout limit")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    const sent = script.card();
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"])[0]!;
    expect(confirmMateProposal(store, who(), proposal.id, now, { via: "web" })).toMatchObject({ ok: true, kind: "task" });
    const tasks = () => store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    const before = tasks();
    const raced = await tapPass(sent.button(/^Confirm$/), sent.messageId);
    expect(raced).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(raced.ok && raced.report.chatConfirmed).toBeFalsy();
    expect(tasks()).toBe(before);
    expect(script.acks().at(-1)).toBe("already done");
    expect(script.edits().at(-1)).toMatch(/^✓ Done \(from web\): filed /);
    // A stale button — the same token again, or the token on another message — does nothing more.
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(await tapPass(sent.button(/^Dismiss$/), sent.messageId + 1)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.acks().at(-1)).toContain("that button is stale");
    // The wrong person's tap is silence, not even an acknowledgement.
    script.updates.push([tap(nextUpdate++, sent.button(/^Dismiss$/), sent.messageId, { from: { id: USER + 1 } })]);
    const acksBefore = script.acks().length;
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.acks()).toHaveLength(acksBefore);
    expect(tasks()).toBe(before);
  });

  test("a busy engine defers the phone's message instead of failing it; an incompatible console session is never ended from the phone", async () => {
    // A console session over a narrower ceiling is live: the phone refuses, the session stands.
    const me = who();
    store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo, "/elsewhere"]), termsDigest: "t".repeat(64) }, now);
    const foreign = store.activeMateSession("alex")!;
    script.updates.push([textUpdate(2, "hello")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts()[0]).toContain("covers different projects or another provider");
    expect(store.activeMateSession("alex")?.id).toBe(foreign.id);
    expect(store.getMateSession(foreign.id)?.endedAt).toBeNull();
    expect(requests).toEqual([]);
    store.endMateSession(foreign.id, "alex", now);
    // A turn already running on the console: the phone's message waits its turn.
    answers.push({ text: "Hi." });
    const session = store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
    const thread = store.openMateThread("alex", me.ceilingDigest, now).thread;
    const running = store.openMateTurn({ approver: "alex", session, thread: thread.id, credentialKey: subscriptionCredentialKey("claude-subscription"), reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!running.ok) throw new Error(running.reason);
    const startedRunning = store.startMateTurn(running.id, now);
    if (!startedRunning.ok) throw new Error("start");
    script.updates.push([textUpdate(3, "hello?")]);
    const deferred = await pass();
    expect(deferred).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(deferred.ok && deferred.report.chatAnswered).toBeFalsy();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "queued", outcome: "busy" });
    expect(store.getMateTurn(running.id)?.state).toBe("running");
    // The console turn ends; the deferred message runs on the next pass on the same thread.
    expect(store.finalizeMateTurn(running.id, startedRunning.generation, { state: "failed", settledMicrousd: 0, unknownSpend: false, tokensIn: 0, tokensOut: 0, failureReason: "ended" }, now)).toBe(true);
    now = new Date(now.getTime() + 6_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    expect(script.texts().at(-1)).toBe("Hi.");
    expect(store.listMateMessages(thread.id, 10).map(one => one.role)).toEqual(["operator", "assistant"]);
  });

  test("a direct-API configuration is never spent from the phone", async () => {
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 10_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", now);
    script.updates.push([textUpdate(2, "hello")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts()[0]).toContain("Direct API chat stays on the computer");
    expect(requests).toEqual([]);
    expect(store.activeMateSession("alex")).toBeNull();
  });

  describe("every confirmable kind through the phone's card", () => {
    const outcome = (id: number) => store.getMateProposal(id)!;

    test("next, reserve, hold, unhold and steer confirm through the shared door as telegram", async () => {
      task("a"); task("b");
      const place = store.queuePosition("a")!;
      const next = card("next", { task: "a", taskTitle: "work a", position: place.position, column: place.column ?? null, of: 2, queueRevision: store.queueRevision() });
      expect(next.preview.text).toContain("Move work a to the front of its queue");
      expect(await tapPass(next.confirm, next.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(next.id)).toMatchObject({ state: "confirmed", outcome: { ok: true, via: "telegram" } });
      const after = store.queuePosition("b")!;
      const reserve = card("reserve", { task: "b", taskTitle: "work b", worker: null, position: after.position, column: after.column ?? null, queueRevision: store.queueRevision() });
      expect(reserve.preview.text).toContain("Release work b to the shared queue.");
      expect(await tapPass(reserve.confirm, reserve.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(reserve.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      const hold = card("hold", { task: "a", taskTitle: "work a", reason: "wait for the audit", sawHold: null });
      expect(hold.preview.text).toContain("Hold work a: wait for the audit");
      expect(await tapPass(hold.confirm, hold.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      const standing = store.activeHolds(store.lookupRef("a")!.id, now).find(one => one.ownerKind === "operator")!;
      expect(standing.reason).toBe("wait for the audit");
      const unhold = card("unhold", { task: "a", taskTitle: "work a", holdId: standing.id });
      expect(await tapPass(unhold.confirm, unhold.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.activeHolds(store.lookupRef("a")!.id, now)).toEqual([]);
      const steer = card("steer", { task: "b", taskTitle: "work b", note: "Prefer the smaller diff." });
      expect(steer.preview.text).toContain("| Prefer the smaller diff.");
      expect(await tapPass(steer.confirm, steer.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(steer.id)).toMatchObject({ state: "confirmed", outcome: { said: "Guidance saved for work b's next attempt", via: "telegram" } });
      expect(script.edits().at(-1)).toBe("✓ Guidance saved for work b's next attempt");
      // Dismiss is the same door's decline, recorded once.
      const dismissed = card("hold", { task: "b", taskTitle: "work b", reason: "no", sawHold: null });
      const declined = await tapPass(dismissed.dismiss, dismissed.messageId);
      expect(declined.ok && declined.report.chatConfirmed).toBeFalsy();
      expect(outcome(dismissed.id).state).toBe("dismissed");
      expect(script.edits().at(-1)).toBe("Dismissed.");
      expect(await tapPass(dismissed.confirm, dismissed.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(script.acks().at(-1)).toBe("already dismissed");
    });

    test("dependency repair, agents and scope confirm through their shared doors; scope and agents hand the approval back to the computer", async () => {
      task("d"); task("e");
      expect(store.addEdge("d", "e").ok).toBe(true);
      store.setTaskState("e", "failed", now);
      const repair = card("repair", { task: "d", taskTitle: "work d", blocker: "e", blockerTitle: "work e", operation: "retry", sawBlockerState: "failed" });
      expect(repair.preview.text).toContain("Queue work e again; work d follows when it finishes.");
      expect(await tapPass(repair.confirm, repair.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getTask("e")?.state).toBe("queued");
      expect(outcome(repair.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      // Agents: a configured, role-valid choice drafted by the real tool, confirmed through the authenticated route edit.
      store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "ops", now);
      task("f");
      propose(store, { taskId: "f", goal: "Harden the flow", acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["check"] }], now });
      let drafted: Record<string, unknown> | null = null;
      const ctx = { store, who: who(), now, step: 2, readDecisions: new Map<number, number>(), draft: (_kind: string, payload: Record<string, unknown>) => { drafted = payload; return 1; } };
      expect(executeMateTool({ ...ctx, step: 1 }, "get_agents", { task: "f" })).toMatchObject({ ok: true });
      expect(executeMateTool(ctx, "propose_agents", { task: "f", role: "reviewer", agent: { provider: "codex", model: "gpt-5-codex" } })).toMatchObject({ ok: true });
      const agents = card("agents", drafted!);
      expect(agents.preview.text).toContain("Change agents for work f: reviewer: codex gpt-5-codex");
      expect(agents.preview.text).toContain("renewed approval on the computer");
      expect(await tapPass(agents.confirm, agents.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.refForId(store.lookupRef("f")!.id)?.routeOverrides).toEqual([expect.objectContaining({ phase: "review", provider: "codex", model: "gpt-5-codex" })]);
      expect(script.edits().at(-1)).toContain("Open Standing Orders on the computer to finish this step.");
      // Scope: rewritten through the guarded proposal; approval is the password ceremony, named as the next step.
      const scope = card("scope", { task: "d", taskTitle: "work d", goal: "Do d with a smaller blast radius", acceptance: [{ id: "c1", statement: "d is smaller", evidence: ["manual-review"] }], sawDigest: store.getScope("d")?.digest ?? null });
      expect(scope.preview.text).toContain("approve the new scope with your password on the computer");
      expect(await tapPass(scope.confirm, scope.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(scope.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      expect(store.getScope("d")).toMatchObject({ goal: "Do d with a smaller blast radius", proposedVia: "mate" });
      expect(script.edits().at(-1)).toMatch(/^✓ d's scope rewritten — approve it with your password on the task\n\nOpen Standing Orders/);
    });

    test("answers: a reversible option answers on the first confirm; an irreversible one arms a yes/cancel pair, and cancel restores the card", async () => {
      const ref = task("q");
      const route = store.routeAuthorityFor(ref, "builder", null);
      const run = store.startRun({ taskRef: ref, leaseId: "l-q", runner: "r", branch: "b", worktree: "/w", ...(route?.ok ? { route: route.stamp } : { route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" as const } }), now });
      const options = [{ id: "open", label: "Fail open", consequence: "Requests pass while the check is down", reversible: true }, { id: "closed", label: "Fail closed", consequence: "Requests are refused; a rollback restores them", reversible: false }];
      const first = store.saveDecision({ run, urgency: "blocking", recap: "The check can fail", question: "Fail open or closed?", options, recommendation: "closed" }, now);
      const easy = card("answer", { decision: first, task: "q", taskTitle: "work q", option: "open", optionLabel: "Fail open", reversible: true, rationale: "Keep traffic flowing" });
      expect(easy.preview.text).toContain("Q: Fail open or closed?");
      expect(easy.preview.text).toContain("→ Fail open: Requests pass while the check is down");
      expect(easy.preview.text).toContain("Fail closed — IRREVERSIBLE (the builder recommends this)");
      expect(await tapPass(easy.confirm, easy.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getDecision(first)).toMatchObject({ state: "answered", choice: "open", answeredBy: "alex", answeredVia: "telegram" });
      const second = store.saveDecision({ run, urgency: "blocking", recap: "Again", question: "Fail open or closed?", options, recommendation: "closed" }, now);
      const hard = card("answer", { decision: second, task: "q", taskTitle: "work q", option: "closed", optionLabel: "Fail closed", reversible: false, rationale: "Safer" });
      expect(hard.preview.text).toContain("⚠ This choice is irreversible. Confirming asks you once more.");
      const armedPass = await tapPass(hard.confirm, hard.messageId);
      expect(armedPass).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(armedPass.ok && armedPass.report.chatConfirmed).toBeFalsy();
      expect(store.getDecision(second)?.state).toBe("open");
      expect(script.acks().at(-1)).toBe("irreversible — confirm it");
      const armed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const keyboard = (armed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      const yes = keyboard.find(one => one.text.startsWith("⚠ Yes"))!.callback_data;
      const cancel = keyboard.find(one => one.text === "Cancel")!.callback_data;
      // Cancel: the yes dies, the card comes back with fresh buttons; the old yes is stale.
      expect(await tapPass(cancel, hard.messageId)).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(script.acks().at(-1)).toBe("cancelled");
      const restored = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      expect(await tapPass(yes, hard.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(store.getDecision(second)?.state).toBe("open");
      const again = (restored.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      expect(await tapPass(again.find(one => one.text === "Confirm")!.callback_data, hard.messageId)).toMatchObject({ ok: true });
      const rearmed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const yes2 = (rearmed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find(one => one.text.startsWith("⚠ Yes"))!.callback_data;
      expect(await tapPass(yes2, hard.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getDecision(second)).toMatchObject({ state: "answered", choice: "closed", answeredVia: "telegram" });
      expect(outcome(hard.id).outcome).toMatchObject({ ok: true, via: "telegram" });
    });

    test("task actions: retry, plan, dependencies and a stop confirm through the shared door — the stop is audited as telegram; resume only opens the password step", async () => {
      task("r"); task("s");
      store.setTaskState("r", "failed", now);
      const stamp = (id: string) => chatTaskStamp(store, who(), id)!;
      const retry = card("task_action", { task: "r", taskTitle: "work r", operation: "retry", stamp: stamp("r") });
      expect(retry.preview.text).toContain("Try again: work r");
      expect(await tapPass(retry.confirm, retry.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getTask("r")?.state).toBe("queued");
      const plan = card("task_action", { task: "s", taskTitle: "work s", operation: "plan", stamp: stamp("s") });
      expect(await tapPass(plan.confirm, plan.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.lookupRef("s")?.plan).toBe("requested");
      const wait = card("task_action", { task: "r", taskTitle: "work r", operation: "wait_for", dependency: "s", dependencyTitle: "work s", stamp: stamp("r") });
      expect(wait.preview.text).toContain("Add dependency: work r · work s");
      expect(await tapPass(wait.confirm, wait.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.blockers("r")).toEqual(["s"]);
      const unwait = card("task_action", { task: "r", taskTitle: "work r", operation: "stop_waiting", dependency: "s", dependencyTitle: "work s", stamp: stamp("r") });
      expect(await tapPass(unwait.confirm, unwait.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.blockers("r")).toEqual([]);
      // A stale card (the task moved on) refuses through the same door.
      const stale = card("task_action", { task: "s", taskTitle: "work s", operation: "retry", stamp: stamp("s") });
      store.setTaskState("s", "done", now);
      const refused = await tapPass(stale.confirm, stale.messageId);
      expect(refused.ok && refused.report.chatConfirmed).toBeFalsy();
      expect(outcome(stale.id)).toMatchObject({ state: "refused", outcome: { reason: "stale", via: "telegram" } });
      expect(script.edits().at(-1)).toMatch(/^✗ Not done: This task changed/);
      // The stop: a live claimed attempt, requested from the phone, audited as such, its process signal deferred past commit.
      const ref = task("t");
      propose(store, { taskId: "t", goal: "Keep the saved work", acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["manual-review"] }], now });
      expect(approve(store, "t", "alex", now, store.getScope("t")!.digest, token).ok).toBe(true);
      register(store, { name: "worker", host: "test", capacity: 1, repos: [repo], now, newToken: () => "worker-token" });
      const claim = acquire(store, ref, "worker", { token: "worker-token", now });
      if (!claim.ok) throw new Error(claim.reason);
      const route = store.routeAuthorityFor(ref, "builder", null);
      if (!route?.ok) throw new Error("route");
      const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "worker", branch: "b", worktree: "/pool/t", route: route.stamp, now });
      const stop = card("task_action", { task: "t", taskTitle: "work t", operation: "stop", run, stamp: stamp("t") });
      expect(stop.preview.text).toContain("Stop task: work t");
      expect(await tapPass(stop.confirm, stop.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.stopOf(run)).toMatchObject({ requestedBy: "alex", requestedVia: "telegram", settledAt: null });
      expect(outcome(stop.id).outcome).toMatchObject({ ok: true, said: `Stop requested for t, run #${run}.`, via: "telegram" });
      // Resume is a password ceremony: the card says so before and after.
      const resume = card("task_action", { task: "t", taskTitle: "work t", operation: "resume", run, stamp: stamp("t") });
      expect(resume.preview.text).toContain("Confirming opens the password step on the computer; it does not resume work from here.");
      expect(TELEGRAM_ACTION_PARITY["propose_task_action"]?.gap).toContain("resume completes on the computer");
    });

    test("review note saves feedback without a revision; cancel and console controls are handoffs with no button", async () => {
      const { run } = seedSource("n");
      const snapshot = readChatResult(store, who(), evidenceRoot, "n", run);
      if (!snapshot.ok) throw new Error(snapshot.message);
      const note = card("review", { task: "n", taskTitle: "Guard the payout path (n)", run, snapshot: snapshot.snapshot, operation: "note", note: "Looks right; keep the early return.", path: null, line: null, notes: [] });
      expect(note.preview.text).toContain(`Save feedback on result #${run} of Guard the payout path (n)`);
      expect(note.preview.text).toContain("Saves feedback; no work starts.");
      expect(await tapPass(note.confirm, note.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.allDiffComments(run).map(one => [one.author, one.note, one.consumedBy])).toEqual([["alex", "Looks right; keep the early return.", null]]);
      expect(store.taskFamilyOf("n", [repo], false)?.versions).toHaveLength(1);
      expect(script.edits().at(-1)).toBe("✓ Feedback saved. No work started.");
      task("z");
      const cancel = card("cancel", { task: "z", taskTitle: "work z", reason: "no longer needed" });
      expect(cancel.preview).toMatchObject({ buttons: false });
      expect(cancel.preview.text).toContain("Cancelling is armed on the task itself, never from a card.");
      expect(cancel.preview.text).toContain("Open Standing Orders on the computer to finish this step.");
      expect(cancel.preview.text).not.toMatch(/http|localhost|\//);
      const control = card("control", { control: "publish", task: "z", taskTitle: "work z" });
      expect(control.preview).toMatchObject({ buttons: false });
      expect(control.preview.text).toContain("Review publication for work z");
      expect(control.preview.text).not.toMatch(/http|localhost|\//);
      // A tap on a handoff card (a forged keyboard) changes nothing.
      expect(await tapPass(cancel.confirm, cancel.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(store.getTask("z")?.state).not.toBe("cancelled");
      expect(outcome(cancel.id).state).toBe("pending");
    });

    test("previews never carry paths, secrets or digests a person typed into a title or a note", () => {
      task("p", `see /Users/private/notes and token sk-${"X".repeat(40)}`);
      const steer = card("steer", { task: "p", taskTitle: `see /Users/private/notes and token sk-${"X".repeat(40)}`, note: `look in C:\\Users\\me and ${"d".repeat(64)}` });
      expect(steer.preview.text).not.toMatch(/\/Users|C:\\|X{40}|d{64}/);
    });
  });

  test("every mate tool has a phone road, and the committed matrix agrees with the code line for line", () => {
    expect(parityGaps()).toEqual([]);
    expect(Object.keys(TELEGRAM_ACTION_PARITY).sort()).toEqual(MATE_TOOL_SCHEMAS.map(tool => tool.name).sort());
    const doc = readFileSync(join(__dirname, "..", "docs", "TELEGRAM_ACTION_PARITY_2026-09-16.md"), "utf8");
    for (const tool of MATE_TOOL_SCHEMAS) {
      const row = TELEGRAM_ACTION_PARITY[tool.name]!;
      expect(doc, `matrix row for ${tool.name}`).toContain(`| \`${tool.name}\` | ${row.support} |`);
      if (row.gap !== null) expect(doc, `gap for ${tool.name}`).toContain(row.gap);
    }
    expect(doc).toContain("not a live Telegram");
  });

  describe("production wiring", () => {
    const stub = () => {
      vi.stubEnv(TOKEN_ENV, "");
      saveBotToken(join(dir, "telegram-token"), `${BOT}:${"x".repeat(25)}`);
    };
    const operate = (argv: string[], lines: string[]) =>
      runOperate(argv[0]!, argv.slice(1), line => lines.push(line), { databaseFile: file, now, telegramTransport: script.transport, mateSeams: { subscriptionRunner: runner, clock: () => now } });

    test("`bridge telegram` (the cron pass) answers ordinary text through the shared engine and reports it", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      store.close();
      answers.push({ text: "Two tasks are queued; nothing waits on you." });
      script.updates.push([textUpdate(2, "how do things stand?")]);
      const lines: string[] = [];
      expect(await operate(["bridge", "telegram", "--inbound-only", "--json"], lines)).toBe(EXIT.ok);
      const report = JSON.parse(lines.join("\n")).report;
      expect(report).toMatchObject({ chatQueued: 1, chatAnswered: 1, problems: [] });
      expect(script.texts()).toEqual(["Two tasks are queued; nothing waits on you."]);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "done", outcome: "answered" });
      expect(store.activeMateSession("alex")).toMatchObject({ ceilingDigest: ceilingDigestOf([repo]) });
    });

    test("`bridge telegram --follow` answers while it stays on the wire, and a watch's embedded follower does the same for the normal worker", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      // The follower: one long-poll actor, the reply arrives without a second invocation.
      answers.push({ text: "Nothing is waiting on you." });
      script.updates.push([textUpdate(2, "anything waiting?")]);
      const controller = new AbortController();
      const report = await followBridge(store, {
        botId: BOT, transport: script.transport, signal: controller.signal, clock: () => new Date(), deliver: false,
        readProjects, conversation: { evidenceRoot, subscriptionRunner: runner },
        onCycle: cycle => { if ((cycle.chatAnswered ?? 0) > 0) controller.abort(); },
        sleep: async () => {},
      });
      expect(report).toMatchObject({ chatQueued: 1, chatAnswered: 1 });
      expect(script.texts()).toEqual(["Nothing is waiting on you."]);
      // The watch (what `up` runs per project): its embedded follower carries the conversation too.
      await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await exec("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
      const runnerToken = register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: new Date() }).token;
      store.close();
      answers.push({ text: "Still nothing waiting." });
      script.updates.push([textUpdate(3, "and now?")]);
      const lines: string[] = [];
      const code = await runOperate("watch", ["--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", join(dir, "pool"), "--for", "1500", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000"],
        line => lines.push(line), { databaseFile: file, now: new Date(), telegramTransport: script.transport, mateSeams: { subscriptionRunner: runner } });
      expect(code, lines.join("\n")).toBe(EXIT.ok);
      expect(script.texts(), lines.join("\n")).toEqual(["Nothing is waiting on you.", "Still nothing waiting."]);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT).map(one => one.state)).toEqual(["done", "done"]);
    });
  });
});
