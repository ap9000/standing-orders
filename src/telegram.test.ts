/**
 * The Telegram bridge, against a scripted Bot API: decisions out with opaque
 * buttons, taps back through the same authenticated answer path as the CLI
 * and web, and every hostile shape — forged tokens, wrong senders, group
 * chats, replayed updates, racing pollers — refused in silence.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import {
  bridgePass,
  followBridge,
  hashPairingCode,
  loadBotToken,
  mintPairingCode,
  saveBotToken,
  scrub,
  MAX_POLL_SECONDS,
  PAIRING_TTL_MS,
  TOKEN_ENV,
  type TelegramTransport,
} from "./telegram.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;

/** A scripted Bot API: records everything, plays back queued updates. */
function scriptedTransport() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const updates: unknown[][] = [];
  let nextMessageId = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") {
      const offset = Number(params["offset"] ?? 0);
      // Serve only updates at or past the offset, like the real API.
      const batch = (updates.shift() ?? []).filter(
        update => Number((update as { update_id: number }).update_id) >= offset,
      );
      return { ok: true, result: batch };
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: nextMessageId++ } };
    }
    return { ok: true, result: true };
  };
  return { transport, calls, updates };
}

const privatePair = (updateId: number, code: string, over: Record<string, unknown> = {}) => ({
  update_id: updateId,
  message: {
    message_id: 1,
    text: `/pair ${code}`,
    chat: { id: CHAT, type: "private" },
    from: { id: USER },
    ...over,
  },
});

const tap = (
  updateId: number,
  token: string,
  messageId = 100,
  over: Record<string, unknown> = {},
) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`,
    data: token,
    from: { id: USER },
    message: { message_id: messageId, chat: { id: CHAT } },
    ...over,
  },
});

describe("the telegram bridge", () => {
  let store: Store;
  let approverToken: string;
  let taskRef: number;

  const decisionWith = (
    options: { id: string; label: string; consequence: string; reversible: boolean }[],
    recommendation: string,
  ): number => {
    const run = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random()}`,
      runner: "builder-1",
      branch: "nightorders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The payout guard needs a policy call.",
        question: "Fail open or fail closed?",
        options,
        recommendation,
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(id), reason: `decision:${id}`, until: null },
      T0,
    );
    store.enqueueNotification(
      { dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked a decision", body: "q" },
      T0,
    );
    return id;
  };

  const plainOptions = [
    { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
    { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
  ];

  const pairChat = async (script: ReturnType<typeof scriptedTransport>) => {
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(1_000) });
    expect(passed).toMatchObject({ ok: true });
    return code;
  };

  /** Where a token's keyboard actually landed — taps must come from there. */
  const placedOn = (token: string): number => Number(store.getTelegramAction(token)?.messageId ?? 0);

  /** The opaque tokens the last keyboard carried, freshest send first. */
  const keyboardTokens = (script: ReturnType<typeof scriptedTransport>): string[] => {
    const withKeyboards = script.calls.filter(
      call =>
        (call.method === "sendMessage" || call.method === "editMessageText") &&
        call.params["reply_markup"] !== undefined,
    );
    const last = withKeyboards[withKeyboards.length - 1];
    if (last === undefined) return [];
    const keyboard = (last.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    return keyboard.flat().map(button => button.callback_data);
  };

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    void approverToken;
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  test("pairing: a private chat with the code becomes the approver's chat, once", async () => {
    const script = scriptedTransport();
    await pairChat(script);

    const binding = store.liveTelegramBinding(BOT);
    expect(binding).toMatchObject({ chatId: String(CHAT), userId: String(USER), approver: "alex" });
    // The confirmation names the approver, so a hijacked code is visible.
    const reply = script.calls.find(call => call.method === "sendMessage");
    expect(String(reply?.params["text"])).toContain("answers as alex");
  });

  test("a wrong code, a group chat, and a second pairing all get silence", async () => {
    const script = scriptedTransport();
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([
      privatePair(1, mintPairingCode()), // wrong code
      privatePair(2, code, { chat: { id: CHAT, type: "group" } }), // group
    ]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(1_000) });

    expect(passed).toMatchObject({ ok: true, report: { paired: 0, ignored: 2 } });
    expect(store.liveTelegramBinding(BOT)).toBeNull();
    // No replies to anybody: a guesser learns nothing, including "wrong".
    expect(script.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);

    // The real code from the private chat still works…
    script.updates.push([privatePair(3, code)]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(2_000) });
    expect(store.liveTelegramBinding(BOT)).not.toBeNull();

    // …and a second code cannot bind a second chat while the first lives.
    const second = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(second), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      later(2_000),
    );
    script.updates.push([privatePair(4, second, { chat: { id: 999, type: "private" }, from: { id: 999 } })]);
    const third = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(3_000) });
    expect(third).toMatchObject({ ok: true, report: { paired: 0 } });
    expect(store.liveTelegramBinding(BOT)?.chatId).toBe(String(CHAT));
  });

  test("an expired code is a wrong code", async () => {
    const script = scriptedTransport();
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, {
      botId: BOT,
      transport: script.transport,
      clock: () => later(PAIRING_TTL_MS + 1_000),
    });
    expect(passed).toMatchObject({ ok: true, report: { paired: 0 } });
    expect(store.liveTelegramBinding(BOT)).toBeNull();
  });

  test("a decision goes out whole, and the buttons carry only opaque tokens", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    decisionWith(plainOptions, "closed");

    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    expect(passed).toMatchObject({ ok: true, report: { sent: 1 } });

    // Every safety-bearing word went out: recap, question, consequences.
    const texts = script.calls
      .filter(call => call.method === "sendMessage")
      .map(call => String(call.params["text"]))
      .join("\n");
    expect(texts).toContain("policy call");
    expect(texts).toContain("Fail open or fail closed?");
    expect(texts).toContain("Payouts pause.");
    // Nothing is parsed, nothing previews.
    for (const call of script.calls.filter(one => one.method === "sendMessage")) {
      expect(call.params["parse_mode"]).toBeUndefined();
      expect(call.params["entities"]).toBeUndefined();
    }

    // The buttons say nothing about what they do.
    const tokens = keyboardTokens(script);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).not.toContain("open");
    }

    // Delivered with a receipt that names bot, chat, and message.
    const [row] = store.listNotifications("all");
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.receipt).toMatch(new RegExp(`^telegram:${BOT}:${CHAT}:\\d+$`));
  });

  test("a tap answers as the paired approver, and the hold lifts", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });

    const [openToken] = keyboardTokens(script);
    const action = store.getTelegramAction(openToken as string);
    expect(action?.optionId).toBe("open");

    script.updates.push([tap(10, openToken as string, placedOn(openToken as string))]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 1 } });

    expect(store.getDecision(decisionId)).toMatchObject({
      state: "answered",
      choice: "open",
      answeredBy: "alex",
      answeredVia: "telegram",
    });
    expect(store.activeHolds(taskRef, later(11_000))).toHaveLength(0);
    // The message was edited to the answered state and the tap acknowledged.
    expect(script.calls.some(call => call.method === "answerCallbackQuery")).toBe(true);
    const edit = script.calls.find(call => call.method === "editMessageText");
    expect(String(edit?.params["text"])).toContain("answered: open");
  });

  test("a tap from anyone but the paired person is nothing", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    script.updates.push([tap(10, token as string, placedOn(token as string), { from: { id: 666 } })]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(passed).toMatchObject({ ok: true, report: { answered: 0, ignored: 1 } });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    // Not even an acknowledgement: a stranger's tap does not exist.
    expect(script.calls.filter(call => call.method === "answerCallbackQuery")).toHaveLength(0);
  });

  test("a forged callback token is stale, not a command", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });

    script.updates.push([tap(10, "f".repeat(32))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });

    expect(store.getDecision(decisionId)?.state).toBe("open");
    const ack = script.calls.find(call => call.method === "answerCallbackQuery");
    expect(String(ack?.params["text"])).toContain("stale");
  });

  test("irreversible: one tap arms, only the minted confirm answers", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(
      [
        { id: "keep", label: "Keep it", consequence: "fine", reversible: true },
        { id: "drop", label: "Drop the table", consequence: "It does not come back.", reversible: false },
      ],
      "keep",
    );
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const dropToken = keyboardTokens(script).find(
      token => store.getTelegramAction(token)?.optionId === "drop",
    ) as string;

    // The arm: nothing answers yet.
    script.updates.push([tap(10, dropToken, placedOn(dropToken))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");

    const challenge = keyboardTokens(script);
    expect(challenge).toHaveLength(2);
    const confirm = challenge.find(token => store.getTelegramAction(token)?.phase === "confirm") as string;
    const cancel = challenge.find(token => store.getTelegramAction(token)?.phase === "cancel") as string;
    expect(confirm).toBeDefined();
    expect(cancel).toBeDefined();

    // The confirm answers — through the same one-time-token discipline.
    script.updates.push([tap(11, confirm, placedOn(confirm))]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(15_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 1 } });
    expect(store.getDecision(decisionId)).toMatchObject({ state: "answered", choice: "drop" });
  });

  test("cancel restores the choices and kills the challenge", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(
      [
        { id: "keep", label: "Keep it", consequence: "fine", reversible: true },
        { id: "drop", label: "Drop the table", consequence: "gone", reversible: false },
      ],
      "keep",
    );
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const dropToken = keyboardTokens(script).find(
      token => store.getTelegramAction(token)?.optionId === "drop",
    ) as string;

    script.updates.push([tap(10, dropToken, placedOn(dropToken))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });
    const challenge = keyboardTokens(script);
    const confirm = challenge.find(token => store.getTelegramAction(token)?.phase === "confirm") as string;
    const cancel = challenge.find(token => store.getTelegramAction(token)?.phase === "cancel") as string;

    script.updates.push([tap(11, cancel, placedOn(cancel))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(12_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");
    // The restored keyboard carries fresh choose tokens.
    const restored = keyboardTokens(script);
    expect(restored).toHaveLength(2);
    expect(restored.every(token => store.getTelegramAction(token)?.phase === "choose")).toBe(true);

    // The dead confirm no longer answers anything.
    script.updates.push([tap(12, confirm, placedOn(confirm))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(13_000) });
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("a replayed update applies once, and the cursor moves past it", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    decisionWith(plainOptions, "closed");
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    // The same update twice in one batch, then again next pass.
    script.updates.push([tap(10, token as string, placedOn(token as string)), tap(10, token as string, placedOn(token as string))]);
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });
    script.updates.push([tap(10, token as string, placedOn(token as string))]);
    const third = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(15_000) });

    expect(third).toMatchObject({ ok: true, report: { answered: 0 } });
    // The next poll asks past the applied update — nothing is re-read.
    const polls = script.calls.filter(call => call.method === "getUpdates");
    expect(Number(polls[polls.length - 1]?.params["offset"])).toBeGreaterThan(10);
  });

  test("two pollers cannot both hold the bridge", async () => {
    const script = scriptedTransport();
    // Owner A takes the lease and, mid-pass, owner B tries.
    const a = store.acquireBridgeLease(BOT, "owner-a", 60_000, T0);
    expect(a).toMatchObject({ ok: true });

    const b = await bridgePass(store, {
      botId: BOT,
      transport: script.transport,
      clock: () => later(1_000),
      owner: "owner-b",
    });
    expect(b).toMatchObject({ ok: false, reason: "bridge-busy" });

    // Expiry hands it over — at the next generation, so A's stale writes die.
    const c = await bridgePass(store, {
      botId: BOT,
      transport: script.transport,
      clock: () => later(120_000),
      owner: "owner-b",
    });
    expect(c).toMatchObject({ ok: true });
    expect(store.advanceBridgeCursor(BOT, "owner-a", 1, 99, later(121_000))).toBe(false);
  });

  test("credential rotation strands the paired chat and its buttons", async () => {
    const script = scriptedTransport();
    await pairChat(script);
    const decisionId = decisionWith(plainOptions, "closed");
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(5_000) });
    const [token] = keyboardTokens(script);

    // The approver's credential rotates: everything derived dies with it.
    const rotated = addApprover(store, "alex", later(6_000), {
      name: "alex",
      token: approverToken,
    });
    expect(rotated.ok).toBe(true);
    expect(store.liveTelegramBinding(BOT)).toBeNull();

    script.updates.push([tap(10, token as string, placedOn(token as string))]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(10_000) });
    expect(passed).toMatchObject({ ok: true, report: { answered: 0, ignored: 1 } });
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("with nothing paired, pending rows wait and the problem is named once", async () => {
    const script = scriptedTransport();
    decisionWith(plainOptions, "closed");

    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(1_000) });

    expect(passed).toMatchObject({ ok: true, report: { sent: 0 } });
    if (!passed.ok) return;
    expect(passed.report.problems.join(" ")).toContain("no chat is paired");
    // The row is still pending for whenever pairing happens.
    expect(store.listNotifications("pending")).toHaveLength(1);
  });
});

describe("the bot token's homes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nightorders-tg-token-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the file is owner-only, the shape is checked, and env wins", () => {
    const file = join(dir, "telegram-token");
    expect(saveBotToken(file, "not a token")).toMatchObject({ ok: false });

    const token = "777000:AAExampleExampleExample123";
    expect(saveBotToken(file, token)).toMatchObject({ ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(token);

    expect(loadBotToken({}, file)).toMatchObject({ source: "file", botId: "777000" });
    expect(
      loadBotToken({ [TOKEN_ENV]: "888000:BBOtherOtherOtherOther456" }, file),
    ).toMatchObject({ source: "env", botId: "888000" });
  });

  test("scrub keeps a token out of anything persisted", () => {
    const token = "777000:AAExampleExampleExample123";
    const error = `getUpdates https://api.telegram.org/bot${token}/getUpdates timed out`;
    expect(scrub(error, token)).not.toContain(token);
    expect(scrub(error, token)).toContain("…e123");
  });
});

describe("the follower — on the wire until told to stop", () => {
  let store: Store;
  let taskRef: number;

  beforeEach(() => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
  });

  afterEach(() => store.close());

  /** The opaque tokens the last keyboard carried. */
  const keyboardTokensOf = (script: ReturnType<typeof scriptedTransport>): string[] => {
    const withKeyboards = script.calls.filter(
      call =>
        (call.method === "sendMessage" || call.method === "editMessageText") &&
        call.params["reply_markup"] !== undefined,
    );
    const last = withKeyboards[withKeyboards.length - 1];
    if (last === undefined) return [];
    const keyboard = (last.params["reply_markup"] as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    return keyboard.flat().map(button => button.callback_data);
  };

  const pairDirectly = async (script: ReturnType<typeof scriptedTransport>) => {
    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS },
      T0,
    );
    script.updates.push([privatePair(1, code)]);
    const passed = await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => later(1_000) });
    expect(passed).toMatchObject({ ok: true, report: { paired: 1 } });
  };

  const parkedDecision = (): number => {
    const run = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random()}`,
      runner: "builder-1",
      branch: "nightorders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    const id = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "The payout guard needs a policy call.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "slips", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "pauses", reversible: true },
        ],
        recommendation: "closed",
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(id), reason: `decision:${id}`, until: null },
      T0,
    );
    store.enqueueNotification(
      { dedupeKey: `decision:${id}`, kind: "decision", subject: "t-1 parked a decision", body: "q" },
      T0,
    );
    return id;
  };

  test("delivers, long-polls, applies the tap that arrives, and stops on abort", async () => {
    const script = scriptedTransport();
    await pairDirectly(script);
    const decision = parkedDecision();

    const controller = new AbortController();
    const report = await followBridge(store, {
      botId: BOT,
      transport: script.transport,
      signal: controller.signal,
      clock: () => later(5_000),
      sleep: () => Promise.resolve(),
      onCycle: cycle => {
        if (cycle.sent > 0) {
          // The keyboard just went out — the phone taps back for the next poll.
          const token = keyboardTokensOf(script)[0] ?? "";
          const messageId = Number(store.getTelegramAction(token)?.messageId ?? 0);
          script.updates.push([tap(10, token, messageId)]);
        }
        if (cycle.answered > 0) controller.abort();
      },
    });

    expect(report.sent).toBe(1);
    expect(report.answered).toBe(1);
    expect(store.getDecision(decision)?.state).toBe("answered");
    expect(store.getDecision(decision)?.answeredVia).toBe("telegram");
    // The task is dispatchable again — the loop's wake was bumped by the answer.
    expect(store.activeHolds(taskRef, later(10_000))).toHaveLength(0);

    // The follower's polls asked Telegram to hold the line (the pairing
    // pass's earlier getUpdates used 0 — that is the cron shape).
    const polls = script.calls.filter(call => call.method === "getUpdates");
    expect(polls.some(call => call.params["timeout"] === MAX_POLL_SECONDS)).toBe(true);
  });

  test("a held poll lease is waited out, never raced", async () => {
    const script = scriptedTransport();
    store.acquireBridgeLease(BOT, "cron-pass", 60_000, later(0));

    const controller = new AbortController();
    const sleeps: number[] = [];
    const report = await followBridge(store, {
      botId: BOT,
      transport: script.transport,
      signal: controller.signal,
      clock: () => later(1_000),
      sleep: ms => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
        return Promise.resolve();
      },
    });

    expect(report.cycles).toBe(0);
    expect(script.calls).toHaveLength(0);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
  });

  test("a dead wire backs off exponentially instead of spinning", async () => {
    const failing: TelegramTransport = async method => {
      if (method === "getUpdates") return { ok: false, description: "connect ETIMEDOUT" };
      return { ok: true, result: true };
    };

    const controller = new AbortController();
    const sleeps: number[] = [];
    const report = await followBridge(store, {
      botId: BOT,
      transport: failing,
      signal: controller.signal,
      clock: () => later(1_000),
      sleep: ms => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
        return Promise.resolve();
      },
    });

    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(report.problems.length).toBeGreaterThanOrEqual(3);
    // The lease went back on the way out; a cron pass can take over now.
    const lease = store.acquireBridgeLease(BOT, "cron-pass", 60_000, later(2_000));
    expect(lease).toMatchObject({ ok: true });
  });
});
