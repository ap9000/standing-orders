import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");
const BASE = {
  approver: "alex",
  credentialKey: "a".repeat(64),
  provider: "anthropic-api" as const,
  model: "claude-sonnet-5",
  reservedMicrousd: 100_000, // $0.10 worst case
  dailyTurns: 3,
  weeklyCeilingMicrousd: 250_000, // $0.25
  deadlineMs: 120_000,
};

describe("the chat turn ledger", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("config is an installation singleton, written whole", () => {
    expect(store.getChatConfig()).toBeNull();
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000 }, "alex", T0);
    expect(store.getChatConfig()).toMatchObject({ provider: "anthropic-api", dailyTurns: 50 });
    store.setChatConfig({ provider: "openrouter-api", model: "x", dailyTurns: 10, weeklyCeilingMicrousd: 1_000_000 }, "alex", T0);
    expect(store.getChatConfig()?.provider).toBe("openrouter-api");
    store.clearChatConfig();
    expect(store.getChatConfig()).toBeNull();
  });

  test("one live turn per approver — the second post refuses", () => {
    const first = store.openChatTurn(BASE, T0);
    expect(first).toMatchObject({ ok: true });
    expect(store.openChatTurn(BASE, T0)).toMatchObject({ ok: false, reason: "concurrent" });
  });

  test("the daily cap counts turns, the ceiling counts micro-dollars — both fail closed", () => {
    for (let i = 0; i < 2; i++) {
      const turn = store.openChatTurn({ ...BASE, reservedMicrousd: 100_000 }, new Date(T0.getTime() + i * 60_000));
      if (!turn.ok) throw new Error(turn.reason);
      const started = store.startChatTurn(turn.id, T0);
      if (!started.ok) throw new Error("start");
      store.finalizeChatTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 100_000 }, T0);
    }
    // $0.20 settled of a $0.25 ceiling: a $0.10 reservation would breach.
    expect(store.openChatTurn(BASE, new Date(T0.getTime() + 300_000))).toMatchObject({ ok: false, reason: "over-budget" });
    // A cheaper turn fits — and then the daily cap (3) closes the day.
    const third = store.openChatTurn({ ...BASE, reservedMicrousd: 10_000 }, new Date(T0.getTime() + 300_000));
    expect(third).toMatchObject({ ok: true });
    if (!third.ok) throw new Error("unreachable");
    const started = store.startChatTurn(third.id, T0);
    if (!started.ok) throw new Error("start");
    store.finalizeChatTurn(third.id, started.generation, { state: "answered", settledMicrousd: 1_000 }, T0);
    expect(store.openChatTurn({ ...BASE, reservedMicrousd: 1_000 }, new Date(T0.getTime() + 400_000))).toMatchObject({
      ok: false,
      reason: "daily-cap",
    });
  });

  test("a pre-dispatch failure settles at zero and frees its reservation", () => {
    const turn = store.openChatTurn(BASE, T0);
    if (!turn.ok) throw new Error(turn.reason);
    // Refused before any network call (e.g. a secret in the prompt):
    // finalized from 'queued', settled 0 — the ceiling gets it all back.
    expect(
      store.finalizeChatTurn(turn.id, 1, { state: "failed", failureReason: "secret-refused", settledMicrousd: 0 }, T0),
    ).toBe(true);
    const again = store.openChatTurn({ ...BASE, reservedMicrousd: 250_000 }, new Date(T0.getTime() + 60_000));
    expect(again).toMatchObject({ ok: true });
  });

  test("dispatch is exactly-once: the CAS admits one start", () => {
    const turn = store.openChatTurn(BASE, T0);
    if (!turn.ok) throw new Error(turn.reason);
    expect(store.startChatTurn(turn.id, T0)).toMatchObject({ ok: true, generation: 2 });
    expect(store.startChatTurn(turn.id, T0)).toMatchObject({ ok: false });
  });

  test("the sweep latches a STARTED turn as unknown spend; a queued one settles free", () => {
    const started = store.openChatTurn(BASE, T0);
    if (!started.ok) throw new Error(started.reason);
    store.startChatTurn(started.id, T0);
    const queued = store.openChatTurn({ ...BASE, approver: "sam" }, T0);
    if (!queued.ok) throw new Error(queued.reason);
    const later = new Date(T0.getTime() + 200_000); // past both deadlines
    expect(store.sweepStaleChatTurns(later)).toBe(2);
    const sweptStarted = store.getChatTurn(started.id);
    expect(sweptStarted?.state).toBe("failed");
    expect(sweptStarted?.unknownSpend).toBe(true);
    expect(sweptStarted?.settledMicrousd).toBeNull(); // unknown, not free
    const sweptQueued = store.getChatTurn(queued.id);
    expect(sweptQueued?.unknownSpend).toBe(false);
    expect(sweptQueued?.settledMicrousd).toBe(0);
    // The credential is latched; the other approver's was too (same key).
    expect(store.latchedChatTurns(BASE.credentialKey)).toHaveLength(1);
    expect(store.openChatTurn(BASE, later)).toMatchObject({ ok: false, reason: "latched" });
  });

  test("a late response cannot resurrect a swept row (generation CAS)", () => {
    const turn = store.openChatTurn(BASE, T0);
    if (!turn.ok) throw new Error(turn.reason);
    const started = store.startChatTurn(turn.id, T0);
    if (!started.ok) throw new Error("start");
    store.sweepStaleChatTurns(new Date(T0.getTime() + 200_000));
    // The fetch finally answers — with the pre-sweep generation. It loses.
    expect(
      store.finalizeChatTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 5_000 }, new Date(T0.getTime() + 201_000)),
    ).toBe(false);
    expect(store.getChatTurn(turn.id)?.state).toBe("failed");
  });

  test("acknowledgement is append-once and charges the worst case", () => {
    const turn = store.openChatTurn(BASE, T0);
    if (!turn.ok) throw new Error(turn.reason);
    store.startChatTurn(turn.id, T0);
    store.sweepStaleChatTurns(new Date(T0.getTime() + 200_000));
    expect(store.acknowledgeChatTurn(turn.id, "alex", new Date(T0.getTime() + 300_000))).toBe(true);
    const acked = store.getChatTurn(turn.id);
    expect(acked?.settledMicrousd).toBe(BASE.reservedMicrousd);
    expect(acked?.acknowledgedBy).toBe("alex");
    // Once: a second acknowledgement changes nothing.
    expect(store.acknowledgeChatTurn(turn.id, "sam", new Date(T0.getTime() + 400_000))).toBe(false);
    // The latch lifts.
    expect(store.openChatTurn(BASE, new Date(T0.getTime() + 400_000))).toMatchObject({ ok: true });
  });
});
