import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { ceilingDigestOf, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { MATE_MAX_STEPS, mateWorstCaseForPrice } from "./converse.js";
import { runMateTurn, historyFor, MATE_REFUSAL_COPY } from "./mate.js";
import { MATE_MAX_PROPOSALS_PER_TURN, executeMateTool } from "./mate-tools.js";

const T0 = new Date("2026-09-02T12:00:00.000Z");
const INSIDE = "/repo/inside-PATH-CANARY";
const OTHER = "/repo/other-PATH-CANARY";
const OUTSIDE = "/repo/outside-SECRET-PATH";
const PRICE = { inMicrousd: 3, outMicrousd: 15 };
const CREDENTIAL = "c".repeat(64);

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const answer = (blocks: Block[], usage = { input_tokens: 100, output_tokens: 20 }) =>
  new Response(JSON.stringify({ type: "message", content: blocks, usage }), { status: 200, headers: { "content-type": "application/json" } });
const text = (value: string) => answer([{ type: "text", text: value }]);
const call = (name: string, input: Record<string, unknown> = {}, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): Block => ({ type: "tool_use", id, name, input });

/** A scripted provider: each request pops the next response; every outbound body is kept for the canary. */
function scripted(responses: (Response | (() => Response))[]) {
  const bodies: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = responses.shift();
    if (next === undefined) throw new Error("the script ran out of responses");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

describe("the mate's turn", () => {
  let store: Store;
  let who: VerifiedApprover;
  let clockAt = T0.getTime();
  const clock = () => new Date(clockAt);

  beforeEach(() => {
    store = openStore(":memory:");
    clockAt = T0.getTime();
    store.saveApprover("root", "r".repeat(64), T0);
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", [INSIDE, OTHER]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    const mk = (id: string, repo: string, title: string) => {
      const filed = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    };
    mk("in-1", INSIDE, "tighten the payout guard");
    mk("in-2", INSIDE, "rotate the webhook secret");
    mk("other-1", OTHER, "wire the nightly digest");
    mk("out-1", OUTSIDE, "the confidential acquisition plan");
    const run = store.startRun({ taskRef: store.refFor("built-in", "in-1").id, leaseId: "l-in", runner: "runner-1", branch: "standing-orders/in-1", worktree: "/pool/in-1", now: T0 });
    store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "RECAP-CANARY must never reach the model",
        question: "Fail open or closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "CONSEQUENCE-CANARY", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "CONSEQUENCE-CANARY-2", reversible: true },
        ],
        recommendation: "closed",
      },
      T0,
    );
  });

  afterEach(() => store.close());

  const session = (ceilingMicrousd = 5_000_000, expiresInMs = 3_600_000) => {
    const id = store.mintMateSession(
      { approver: "alex", approverGeneration: who.generation, credentialKey: CREDENTIAL, ceilingMicrousd, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64), expiresAt: new Date(clockAt + expiresInMs) },
      clock(),
    );
    const row = store.getMateSession(id);
    if (row === null) throw new Error("no session");
    return row;
  };
  const thread = () => store.openMateThread("alex", who.ceilingDigest, clock()).thread;
  const turn = (message: string, fetcher: typeof fetch, overrides: Partial<Parameters<typeof runMateTurn>[0]> = {}) =>
    runMateTurn({
      store,
      who,
      session: overrides.session ?? session(),
      thread: overrides.thread ?? thread(),
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      key: "sk-test",
      price: PRICE,
      credentialKey: CREDENTIAL,
      weeklyCeilingMicrousd: 25_000_000,
      message,
      fetcher,
      clock,
      ...overrides,
    });

  test("a loop: two tool steps, then text — steps ledgered, session debited, only text kept", async () => {
    const script = scripted([
      answer([{ type: "text", text: "Let me look." }, call("recap"), call("list_tasks", { repo: "r1" })]),
      answer([call("get_task", { task: "in-1" })]),
      text("One decision waits on you in r1 (task in-1). Two tasks are queued there."),
    ]);
    const live = session();
    const outcome = await turn("how do things stand?", script.fetcher, { session: live });
    expect(outcome).toMatchObject({ ok: true, steps: 3, proposals: 0, stoppedAtCap: false, activity: "read 3 · proposed 0 · 3 steps" });
    if (!outcome.ok) throw new Error("unreachable");
    // Three provider requests, three step rows under the one turn, each settled by the pinned price.
    const perStep = 100 * PRICE.inMicrousd + 20 * PRICE.outMicrousd;
    expect(outcome.settledMicrousd).toBe(3 * perStep);
    const mateTurn = store.getMateTurn(outcome.turn);
    expect(mateTurn).toMatchObject({ state: "answered", steps: 3, settledMicrousd: 3 * perStep, tokensIn: 300, tokensOut: 60 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(3 * perStep);
    // The weekly ledger sees the mate's settled turn, not its zero-reserved steps twice.
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(3 * perStep);
    // Ruling 11: the thread holds operator text and assistant text only.
    const messages = store.listMateMessages(thread().id, 10);
    expect(messages.map(one => one.role)).toEqual(["operator", "assistant"]);
    expect(messages[1]?.activity).toBe("read 3 · proposed 0 · 3 steps");
    expect(JSON.stringify(messages)).not.toContain("tighten the payout guard");
    // The second request carried the tool results and the first assistant block.
    expect(script.bodies[1]).toContain("tool_result");
    expect(script.bodies[1]).toContain("\"queued\"");
  });

  test("canary: nothing sent to the provider names a path, an approver, a digest, or a consequence", async () => {
    const script = scripted([
      answer([call("recap"), call("list_repos"), call("list_decisions"), call("queue", { repo: "r1" })]),
      answer([call("get_task", { task: "in-1" }), call("list_tasks", {}), call("propose_next", { task: "in-2" }), call("propose_task", { repo: "r2", title: "a new one", goal: "do the thing", touches: ["src/a.ts"] })]),
      text("done looking"),
    ]);
    const outcome = await turn("look at everything", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 2 });
    const sent = script.bodies.join("\n");
    for (const canary of [INSIDE, OTHER, OUTSIDE, "PATH-CANARY", "alex", "RECAP-CANARY", "CONSEQUENCE-CANARY", "confidential acquisition", who.ceilingDigest]) {
      expect(sent).not.toContain(canary);
    }
    expect(sent).not.toMatch(/[0-9a-f]{64}/);
    // The task outside the ceiling is unreachable even by id.
    const outside = executeMateTool({ store, who, now: clock(), draft: () => null }, "get_task", { task: "out-1" });
    expect(outside).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
  });

  test("proposals draft under the turn and go pending only when it answers, carrying their CAS material", async () => {
    store.hold(store.refFor("built-in", "in-2").id, "wait for the key rotation", null, T0);
    const script = scripted([
      answer([call("propose_next", { task: "in-2" }), call("propose_unhold", { task: "in-2" }), call("propose_hold", { task: "other-1", reason: "not this week" })]),
      () => {
        // Mid-turn: every row is still `drafting` — inert.
        expect(store.listMateProposals(thread().id).map(one => one.state)).toEqual(["drafting", "drafting", "drafting"]);
        return text("I propose three things; confirm the ones you want.");
      },
    ]);
    const outcome = await turn("tidy the queue", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 3, activity: "read 0 · proposed 3 · 2 steps" });
    const rows = store.listMateProposals(thread().id, ["pending"]);
    expect(rows.map(one => one.kind)).toEqual(["next", "unhold", "hold"]);
    expect(rows[0]?.payload).toMatchObject({ task: "in-2", repoId: "r1", queueRevision: store.queueRevision(), position: 2, of: 2 });
    expect(rows[1]?.payload).toMatchObject({ task: "in-2", holdId: expect.any(Number) });
    expect(rows[2]?.payload).toMatchObject({ task: "other-1", repoId: "r2", reason: "not this week" });
    expect(rows.every(one => one.ceilingDigest === who.ceilingDigest)).toBe(true);
  });

  test("a turn holds at most five proposals; the sixth is a typed refusal to the model", async () => {
    const holds = Array.from({ length: 6 }, (_, index) => call("propose_hold", { task: index % 2 === 0 ? "in-1" : "in-2", reason: `reason ${index}` }, `h${index}`));
    const script = scripted([answer(holds.slice(0, 4)), answer(holds.slice(4)), text("proposed what I could")]);
    const outcome = await turn("hold everything", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: MATE_MAX_PROPOSALS_PER_TURN });
    expect(script.bodies[2]).toContain(`already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals`);
    expect(store.listMateProposals(thread().id, ["pending"])).toHaveLength(MATE_MAX_PROPOSALS_PER_TURN);
  });

  test("the step cap: a model that never stops is stopped after the eighth step, its text kept", async () => {
    const responses = Array.from({ length: MATE_MAX_STEPS + 2 }, (_, index) => answer([{ type: "text", text: `step ${index + 1}` }, call("recap")]));
    const script = scripted(responses);
    const outcome = await turn("keep looking", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, steps: MATE_MAX_STEPS, stoppedAtCap: true });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.reply).toBe(`step ${MATE_MAX_STEPS}\n\n(stopped after ${MATE_MAX_STEPS} steps)`);
    expect(script.bodies).toHaveLength(MATE_MAX_STEPS);
  });

  test("a malformed reply mid-loop latches the credential: earlier steps settled, the turn failed, the next turn refused", async () => {
    const script = scripted([
      answer([call("recap")]),
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    const live = session();
    const outcome = await turn("hello", script.fetcher, { session: live });
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: true });
    if (outcome.ok || !("turn" in outcome)) throw new Error("unreachable");
    const perStep = 100 * PRICE.inMicrousd + 20 * PRICE.outMicrousd;
    expect(store.getMateTurn(outcome.turn)).toMatchObject({ state: "failed", failureReason: "malformed-reply", settledMicrousd: perStep, steps: 2 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(perStep);
    const again = await turn("hello again", scripted([text("hi")]).fetcher, { session: live });
    expect(again).toMatchObject({ ok: false, refused: "latched", message: MATE_REFUSAL_COPY.latched });
    // No assistant row for the failed turn; the operator's text stays.
    expect(store.listMateMessages(thread().id, 10).map(one => one.role)).toEqual(["operator"]);
  });

  test("a provider error answers with nothing billed and no latch", async () => {
    const script = scripted([new Response("{}", { status: 529, headers: { "content-type": "application/json" } })]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "provider-error", unknownSpend: false });
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("a call to a tool that does not exist ends the turn as malformed with its cost known — and its drafts discarded", async () => {
    const script = scripted([answer([call("propose_hold", { task: "in-1", reason: "x" }), call("delete_everything", {})])]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: false });
    expect(store.listMateProposals(thread().id).map(one => one.state)).toEqual(["expired"]);
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("a crash mid-loop: the sweep settles the finished steps, latches the one in flight, expires the drafts", () => {
    const live = session();
    const t = thread();
    const opened = store.openMateTurn(
      { approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10_000, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 130_000 },
      T0,
    );
    if (!opened.ok) throw new Error(opened.reason);
    store.startMateTurn(opened.id, T0);
    store.draftMateProposal({ thread: t.id, turn: opened.id, kind: "hold", payload: { task: "in-1" }, ceilingDigest: who.ceilingDigest }, T0);
    const first = store.openMateStep({ mateTurn: opened.id, approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", deadlineMs: 130_000 }, T0);
    const started = store.startChatTurn(first, T0);
    if (!started.ok) throw new Error("start");
    store.finalizeChatTurn(first, started.generation, { state: "answered", settledMicrousd: 700, tokensIn: 10, tokensOut: 10 }, T0);
    const second = store.openMateStep({ mateTurn: opened.id, approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", deadlineMs: 130_000 }, T0);
    store.startChatTurn(second, T0);
    // The process dies here. Later, the sweeps run.
    const later = new Date(T0.getTime() + 200_000);
    store.sweepStaleChatTurns(later);
    store.sweepStaleMateTurns(later);
    expect(store.getMateTurn(opened.id)).toMatchObject({ state: "failed", failureReason: "crashed", settledMicrousd: 700, steps: 2 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(700);
    expect(store.listMateProposals(t.id).map(one => one.state)).toEqual(["expired"]);
    expect(store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, later)).toMatchObject({ ok: false, reason: "latched" });
  });

  test("the reservation is triangular and refuses before any dispatch against the session and the week", async () => {
    const script = scripted([text("hi")]);
    expect(await turn("hello", script.fetcher, { session: session(10) })).toMatchObject({ ok: false, refused: "session-exhausted" });
    expect(await turn("hello", script.fetcher, { weeklyCeilingMicrousd: 10 })).toMatchObject({ ok: false, refused: "over-budget" });
    const ended = session();
    store.endMateSession(ended.id, "alex", clock());
    expect(await turn("hello", script.fetcher, { session: ended })).toMatchObject({ ok: false, refused: "session-ended" });
    const expiring = session(5_000_000, 1_000);
    clockAt += 5_000;
    expect(await turn("hello", script.fetcher, { session: expiring })).toMatchObject({ ok: false, refused: "session-ended" });
    expect(script.bodies).toHaveLength(0);
    // The reserved figure is the triangular worst case, larger than the single-request one.
    const single = Math.ceil(1_000 / 3) * PRICE.inMicrousd + 2_048 * PRICE.outMicrousd;
    expect(mateWorstCaseForPrice(PRICE, 1_000)).toBeGreaterThan(single * MATE_MAX_STEPS);
    const live = session();
    const good = await turn("hello", script.fetcher, { session: live });
    expect(good).toMatchObject({ ok: true });
    if (!good.ok) throw new Error("unreachable");
    expect(store.getMateTurn(good.turn)?.reservedMicrousd).toBeGreaterThan(single * MATE_MAX_STEPS);
  });

  test("the ceiling binds: a surface under other repos cannot continue the session or the thread", async () => {
    const live = session();
    const narrowed = verifyApproverStanding(store, "alex", [INSIDE]);
    if (!narrowed.ok) throw new Error(narrowed.reason);
    expect(narrowed.who.ceilingDigest).not.toBe(who.ceilingDigest);
    expect(ceilingDigestOf([OTHER, INSIDE])).toBe(who.ceilingDigest);
    const outcome = await turn("hello", scripted([text("hi")]).fetcher, { who: narrowed.who, session: live });
    expect(outcome).toMatchObject({ ok: false, refused: "ceiling-changed" });
    // The thread under the old ceiling closes when a new ceiling opens one, and its proposals expire.
    const old = thread();
    store.draftMateProposal({ thread: old.id, turn: 0, kind: "hold", payload: {}, ceilingDigest: who.ceilingDigest }, clock());
    store.promoteMateProposals(0);
    const reopened = store.openMateThread("alex", narrowed.who.ceilingDigest, clock());
    expect(reopened.ceilingChanged).toBe(true);
    expect(reopened.thread.id).not.toBe(old.id);
    expect(store.getMateThread(old.id)?.closedAt).not.toBeNull();
    expect(store.listMateProposals(old.id).map(one => one.state)).toEqual(["expired"]);
  });

  test("standing is re-proved every turn: a revoked approver's session is dead", async () => {
    const live = session();
    store.revokeAccount("alex", "root", clock());
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live })).toMatchObject({ ok: false, refused: "standing" });
  });

  test("secrets refuse before any row exists, in the message and in the reply", async () => {
    const script = scripted([text("hi")]);
    expect(await turn("use AKIAABCDEFGHIJKLMNOP please", script.fetcher)).toMatchObject({ ok: false, refused: "secret-in-message" });
    expect(store.listMateMessages(thread().id, 10)).toHaveLength(0);
    expect(script.bodies).toHaveLength(0);
    const leaky = await turn("hello", scripted([text("the key is AKIAABCDEFGHIJKLMNOP")]).fetcher);
    expect(leaky).toMatchObject({ ok: false, failed: "secret-refused", unknownSpend: false });
    expect(store.listMateMessages(thread().id, 10).map(one => one.role)).toEqual(["operator"]);
  });

  test("one live turn per approver, and the history the next turn sees is text only, operator first", async () => {
    const first = await turn("first question", scripted([text("first answer")]).fetcher);
    expect(first).toMatchObject({ ok: true });
    const history = historyFor(store, thread().id);
    expect(history).toEqual([
      { role: "operator", text: "first question" },
      { role: "assistant", text: "first answer", calls: [] },
    ]);
    const live = session();
    const t = thread();
    const blocking = store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 1, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    expect(blocking).toMatchObject({ ok: true });
    expect(await turn("second", scripted([text("x")]).fetcher, { session: live, thread: t })).toMatchObject({ ok: false, refused: "concurrent" });
  });

  test("the tools refuse bad arguments with typed messages and never throw", () => {
    const ctx = { store, who, now: clock(), draft: () => 1 };
    expect(executeMateTool(ctx, "queue", { repo: "r9" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "list_tasks", { repo: INSIDE })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_task", { repo: "r1", title: "x", goal: "<script>alert(1)</script>" })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx, "propose_unhold", { task: "in-1" })).toMatchObject({ ok: false, message: expect.stringContaining("no hold") });
    expect(executeMateTool(ctx, "propose_reserve", { task: "in-1", worker: "nobody" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_cancel", { task: "out-1", reason: "r" })).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
    const got = executeMateTool(ctx, "get_task", { task: "in-1" });
    expect(got).toMatchObject({ ok: true, body: { repo: "r1", scope: "none", decisionsOpen: 1 } });
    expect(JSON.stringify(got)).not.toContain("PATH");
  });
});
