import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { verifyApproverStanding } from "./principal.js";
import { subscriptionCredentialKey } from "./converse.js";
import { runMateTurn, type MateTurnInput } from "./mate.js";

let dir: string, store: Store, input: MateTurnInput, calls: number;
const now = new Date("2026-09-13T00:00:00Z");
const requestId = "a".repeat(32);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mate-continuity-"));
  store = openStore(join(dir, "orders.db"));
  store.saveApprover("alex", "h".repeat(64), now);
  const principal = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [dir]);
  if (!principal.ok) throw new Error(principal.reason);
  const who = principal.who;
  const id = store.mintMateSession({ approver: "alex", approverGeneration: who.generation, credentialKey: subscriptionCredentialKey("codex-subscription"), ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, now);
  calls = 0;
  input = { store, who, session: store.getMateSession(id)!, thread: store.openMateThread("alex", who.ceilingDigest, now).thread,
    config: { provider: "codex-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0, updatedAt: now.toISOString(), updatedBy: "alex" },
    key: null, message: "What needs me?", requestId, clock: () => now,
    subscriptionRunner: async () => { calls++; return { ok: true, answer: { text: "Nothing needs you.", calls: [], tokensIn: 10, tokensOut: 10, reportedCostMicrousd: null } }; },
  };
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("retry after completion and database reopen returns the original turn without spend or another message", async () => {
  const first = await runMateTurn(input);
  expect(first.ok).toBe(true);
  store.close(); store = openStore(join(dir, "orders.db")); input.store = store;
  const retry = await runMateTurn(input);
  expect(retry).toEqual({ ok: true, replayed: true, turn: first.ok ? first.turn : -1 });
  expect(calls).toBe(1);
  expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
  expect(store.listMateMessages(input.thread.id, 40)).toHaveLength(2);
  expect(store.mateRequestReceipt(input.session.id, requestId)).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), turn: first.ok ? first.turn : -1 });
});

test("a duplicate while the provider is running is a receipt, not a second call or a busy error", async () => {
  let finish!: () => void;
  const runner = input.subscriptionRunner!;
  input.subscriptionRunner = async args => { await new Promise<void>(resolve => { finish = resolve; }); return runner(args); };
  const first = runMateTurn(input);
  const retry = await runMateTurn(input);
  expect(retry).toMatchObject({ ok: true, replayed: true });
  expect(store.listMateMessages(input.thread.id, 40)).toHaveLength(1);
  finish(); await first; expect(calls).toBe(1);
});

test("a reused send identity cannot change the message or task lens", async () => {
  await runMateTurn(input);
  for (const changes of [{ message: "Cancel everything" }, { context: "Current task: other" }]) {
    expect(await runMateTurn({ ...input, ...changes })).toMatchObject({ ok: false, refused: "request-changed" });
  }
  expect(calls).toBe(1);
});

test("a refusal does not consume the identity; fixing readiness permits an explicit retry", async () => {
  expect(await runMateTurn({ ...input, config: { ...input.config, dailyTurns: 0 } })).toMatchObject({ ok: false, refused: "daily-cap" });
  expect(store.mateRequestReceipt(input.session.id, requestId)).toBeNull();
  expect((await runMateTurn(input)).ok).toBe(true);
  expect(calls).toBe(1);
});

test("a failed provider turn is not silently restarted on retry", async () => {
  input.subscriptionRunner = async () => { calls++; return { ok: false, problem: "offline" }; };
  expect(await runMateTurn(input)).toMatchObject({ ok: false });
  expect(await runMateTurn(input)).toMatchObject({ ok: true, replayed: true });
  expect(calls).toBe(1);
});

test("ended sessions and revoked credentials cannot use a receipt to bypass standing", async () => {
  await runMateTurn(input);
  store.endMateSessionsFor("alex", "alex", now);
  expect(await runMateTurn(input)).toMatchObject({ ok: false, refused: "session-ended" });
  store.saveApprover("alex", "x".repeat(64), now);
  expect(await runMateTurn(input)).toMatchObject({ ok: false, refused: "standing" });
});

test("invalid IDs and secret-shaped messages write no receipt and make no provider call", async () => {
  for (const changes of [{ requestId: "bad" }, { message: "use AKIAABCDEFGHIJKLMNOP" }]) {
    expect((await runMateTurn({ ...input, ...changes })).ok).toBe(false);
  }
  expect(store.mateRequestReceipt(input.session.id, requestId)).toBeNull();
  expect(store.recentMateTurns("alex", 10)).toHaveLength(0);
  expect(calls).toBe(0);
});
