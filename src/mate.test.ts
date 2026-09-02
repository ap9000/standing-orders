import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type ChatConfig, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { propose } from "./scope.js";
import { ceilingDigestOf, isVerifiedApprover, reproveApprover, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { MATE_MAX_STEPS, MATE_STEP_TEXT_CAP_BYTES, MATE_TOOL_CALL_CAP_BYTES, MATE_TOOL_RESULT_CAP_BYTES, MAX_OUTPUT_TOKENS, credentialKeyOf, mateWorstCaseForPrice, parseMateProviderWrapper } from "./converse.js";
import { runMateTurn, historyFor, MATE_REFUSAL_COPY } from "./mate.js";
import { MATE_MAX_PROPOSALS_PER_TURN, executeMateTool, redactForMate } from "./mate-tools.js";

const T0 = new Date("2026-09-02T12:00:00.000Z");
const INSIDE = "/repo/inside-PATH-CANARY";
const OTHER = "/repo/other-PATH-CANARY";
const OUTSIDE = "/repo/outside-SECRET-PATH";
const KEY = "sk-ant-test-key";
const CREDENTIAL = credentialKeyOf("anthropic-api", KEY);
const CONFIG: ChatConfig = {
  provider: "anthropic-api",
  model: "claude-sonnet-5",
  dailyTurns: 50,
  weeklyCeilingMicrousd: 25_000_000,
  priceInMicrousd: 3,
  priceOutMicrousd: 15,
  updatedAt: T0.toISOString(),
  updatedBy: "alex",
};
const PRICE = { inMicrousd: 3, outMicrousd: 15 };
const PER_STEP = 100 * PRICE.inMicrousd + 20 * PRICE.outMicrousd;

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (blocks: Block[], usage: unknown = { input_tokens: 100, output_tokens: 20 }) => json({ type: "message", content: blocks, usage });
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

  const principal = (name: string, repos: string[]): VerifiedApprover => {
    const generation = store.accountOf(name)?.generation ?? -1;
    const verified = verifyApproverStanding(store, name, generation, repos);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    clockAt = T0.getTime();
    store.saveApprover("root", "r".repeat(64), T0);
    store.saveApprover("alex", "h".repeat(64), T0);
    who = principal("alex", [INSIDE, OTHER]);
    const mk = (id: string, repo: string, title: string) => {
      const filed = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    };
    mk("in-1", INSIDE, "tighten the payout guard");
    mk("in-2", INSIDE, "rotate the webhook secret");
    mk("in-3", INSIDE, `see ${INSIDE}/notes by alex, digest ${"d".repeat(64)}`);
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
          { id: "closed", label: "Fail closed", consequence: "CONSEQUENCE-CANARY-2", reversible: false },
        ],
        recommendation: "closed",
      },
      T0,
    );
  });

  afterEach(() => store.close());

  const session = (ceilingMicrousd = 5_000_000, expiresInMs = 3_600_000, approver = "alex", credentialKey = CREDENTIAL) => {
    const id = store.mintMateSession(
      { approver, approverGeneration: who.generation, credentialKey, ceilingMicrousd, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64), expiresAt: new Date(clockAt + expiresInMs) },
      clock(),
    );
    const row = store.getMateSession(id);
    if (row === null) throw new Error("no session");
    return row;
  };
  const thread = (approver = "alex") => store.openMateThread(approver, who.ceilingDigest, clock()).thread;
  const turn = (message: string, fetcher: typeof fetch, overrides: Partial<Parameters<typeof runMateTurn>[0]> = {}) =>
    runMateTurn({
      store,
      who,
      session: overrides.session ?? session(),
      thread: overrides.thread ?? thread(),
      config: CONFIG,
      key: KEY,
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
    expect(outcome.settledMicrousd).toBe(3 * PER_STEP);
    expect(store.getMateTurn(outcome.turn)).toMatchObject({ state: "answered", steps: 3, settledMicrousd: 3 * PER_STEP, tokensIn: 300, tokensOut: 60 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(3 * PER_STEP);
    // The weekly ledger sees the mate's settled turn once, not its zero-reserved steps twice.
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(3 * PER_STEP);
    // Ruling 11: the thread holds operator text and assistant text only.
    const messages = store.listMateMessages(thread().id, 10);
    expect(messages.map(one => one.role)).toEqual(["operator", "assistant"]);
    expect(messages[1]?.activity).toBe("read 3 · proposed 0 · 3 steps");
    expect(JSON.stringify(messages)).not.toContain("tighten the payout guard");
    expect(script.bodies[1]).toContain("tool_result");
    expect(script.bodies[1]).toContain("\"queued\"");
    // The key rides in the header, never the body.
    expect(script.bodies[0]).not.toContain(KEY);
  });

  test("canary: nothing sent to the provider names a path, an approver, a digest, or a consequence — free text included", async () => {
    store.hold(store.refFor("built-in", "in-3").id, `blocked on ${OTHER} per alex`, null, T0);
    const script = scripted([
      answer([call("recap"), call("list_repos"), call("list_decisions"), call("queue", { repo: "r1" })]),
      answer([call("get_task", { task: "in-3" }), call("list_tasks", {}), call("propose_next", { task: "in-2" }), call("propose_task", { repo: "r2", title: "a new one", goal: "do the thing", touches: ["src/a.ts"] })]),
      text("done looking"),
    ]);
    const outcome = await turn("look at everything", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 2 });
    const sent = script.bodies.join("\n");
    for (const canary of [INSIDE, OTHER, OUTSIDE, "PATH-CANARY", "alex", "RECAP-CANARY", "CONSEQUENCE-CANARY", "confidential acquisition", who.ceilingDigest, "d".repeat(64)]) {
      expect(sent).not.toContain(canary);
    }
    expect(sent).not.toMatch(/[0-9a-f]{32}/);
    // The redactions are visible where the text was — the title and the hold reason.
    expect(sent).toContain("[path]");
    expect(sent).toContain("[approver]");
    expect(sent).toContain("[digest]");
    // The task outside the ceiling is unreachable even by id.
    const outside = executeMateTool({ store, who, now: clock(), draft: () => null }, "get_task", { task: "out-1" });
    expect(outside).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
  });

  test("redactForMate scrubs paths, basenames, digests, and names but leaves relative paths and ids", () => {
    const view = { repos: [INSIDE], names: ["alex", "root"] };
    expect(redactForMate(`edit ${INSIDE}/src/a.ts and src/b.ts for alex (Alex) in inside-PATH-CANARY`, view)).toBe("edit [path]/src/a.ts and src/b.ts for [approver] ([approver]) in [path]");
    expect(redactForMate(`digest ${"a".repeat(32)} and task in-1 at /Users/someone/private`, view)).toBe("digest [digest] and task in-1 at [path]");
    expect(redactForMate("alexander is not alex", view)).toBe("alexander is not [approver]");
  });

  test("proposals draft under the turn and go pending only when it answers, carrying their CAS material", async () => {
    store.hold(store.refFor("built-in", "in-2").id, "wait for the key rotation", null, T0);
    const script = scripted([
      answer([call("propose_next", { task: "in-2" }), call("propose_unhold", { task: "in-2" }), call("propose_hold", { task: "other-1", reason: "not this week" }), call("propose_reserve", { task: "in-2", worker: null })]),
      () => {
        // Mid-turn: every row is still `drafting` — inert.
        expect(store.listMateProposals(thread().id).map(one => one.state)).toEqual(["drafting", "drafting", "drafting"]);
        return text("I propose three things; confirm the ones you want.");
      },
    ]);
    const outcome = await turn("tidy the queue", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 3, activity: "read 0 · proposed 3 · 2 steps" });
    // The fourth call was refused (already in the shared column) and drafted nothing.
    expect(script.bodies[1]).toContain("already in that column");
    const rows = store.listMateProposals(thread().id, ["pending"]);
    expect(rows.map(one => one.kind)).toEqual(["next", "unhold", "hold"]);
    expect(rows[0]?.payload).toMatchObject({ task: "in-2", repoId: "r1", queueRevision: store.queueRevision(), position: 2, of: 3, column: null });
    expect(rows[1]?.payload).toMatchObject({ task: "in-2", holdId: expect.any(Number) });
    expect(rows[2]?.payload).toMatchObject({ task: "other-1", repoId: "r2", reason: "not this week", sawHold: null });
    expect(rows.every(one => one.ceilingDigest === who.ceilingDigest)).toBe(true);
    // A hold proposed over an existing operator hold carries that hold's id.
    const seen = executeMateTool({ store, who, now: clock(), draft: (_kind, payload) => (payload["sawHold"] === rows[1]?.payload["holdId"] ? 99 : null) }, "propose_hold", { task: "in-2", reason: "again" });
    expect(seen).toMatchObject({ ok: true, body: { proposal: 99 } });
  });

  test("a turn holds at most five proposals; the sixth is a typed refusal to the model", async () => {
    const holds = Array.from({ length: 6 }, (_, index) => call("propose_hold", { task: index % 2 === 0 ? "in-1" : "in-2", reason: `reason ${index}` }, `h${index}`));
    const script = scripted([answer(holds.slice(0, 4)), answer(holds.slice(4)), text("proposed what I could")]);
    const outcome = await turn("hold everything", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: MATE_MAX_PROPOSALS_PER_TURN });
    expect(script.bodies[2]).toContain(`already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals`);
    expect(store.listMateProposals(thread().id, ["pending"])).toHaveLength(MATE_MAX_PROPOSALS_PER_TURN);
  });

  test("a proposal field that looks like a credential is refused before it is drafted, and the call never goes back out", async () => {
    const ctx = { store, who, now: clock(), draft: () => 1 };
    expect(executeMateTool(ctx, "propose_hold", { task: "in-1", reason: "use AKIAABCDEFGHIJKLMNOP" })).toMatchObject({ ok: false, message: expect.stringContaining("plain text") });
    expect(executeMateTool(ctx, "propose_task", { repo: "r1", title: "t", goal: "token xoxb-1234567890-abcdef" })).toMatchObject({ ok: false });
    // In a turn, the model's own call carried the credential: the next body would repeat it, so the turn stops there.
    const script = scripted([answer([call("propose_hold", { task: "in-1", reason: "use AKIAABCDEFGHIJKLMNOP" })]), text("ok")]);
    const outcome = await turn("hold it", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "secret-refused", unknownSpend: false });
    expect(store.listMateProposals(thread().id)).toHaveLength(0);
    expect(script.bodies).toHaveLength(1);
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

  test("a malformed reply mid-loop charges the WHOLE reservation to both ledgers, latches, and acknowledging refunds nothing", async () => {
    const script = scripted([answer([call("recap")]), new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const live = session(50_000_000);
    const outcome = await turn("hello", script.fetcher, { session: live });
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: true });
    if (outcome.ok || !("turn" in outcome)) throw new Error("unreachable");
    const row = store.getMateTurn(outcome.turn);
    expect(row).toMatchObject({ state: "failed", failureReason: "malformed-reply", steps: 2 });
    expect(row?.settledMicrousd).toBe(row?.reservedMicrousd);
    expect(row!.reservedMicrousd).toBeGreaterThan(PER_STEP);
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(row?.reservedMicrousd);
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(row?.reservedMicrousd);
    const again = await turn("hello again", scripted([text("hi")]).fetcher, { session: live });
    expect(again).toMatchObject({ ok: false, refused: "latched", message: MATE_REFUSAL_COPY.latched });
    // Acknowledging the unknown step re-enables the credential and changes no ledger.
    const latched = store.recentChatTurns("alex", 5).find(one => one.unknownSpend);
    expect(latched).toBeDefined();
    expect(store.acknowledgeChatTurn(latched!.id, "alex", clock())).toBe(true);
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(row?.reservedMicrousd);
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(row?.reservedMicrousd);
    expect(await turn("hello again", scripted([text("hi")]).fetcher, { session: live })).toMatchObject({ ok: true });
    // No assistant row for the failed turn; the operator's text stays.
    expect(store.listMateMessages(thread().id, 10).map(one => one.role)).toEqual(["operator", "operator", "assistant"]);
  });

  test("a provider error answers with nothing billed and no latch", async () => {
    const script = scripted([json({}, 529)]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "provider-error", unknownSpend: false });
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("a call to a tool that does not exist ends the turn as malformed with its cost known — and its drafts deleted", async () => {
    const script = scripted([answer([call("propose_hold", { task: "in-1", reason: "x" }), call("delete_everything", {})])]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: false });
    expect(store.listMateProposals(thread().id)).toEqual([]);
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("usage that cannot be true is malformed, never a discount: coerced counts, output over the allowance, input over the bytes sent", async () => {
    for (const usage of [{ input_tokens: null, output_tokens: false }, { input_tokens: "100", output_tokens: 20 }, { input_tokens: 100, output_tokens: MAX_OUTPUT_TOKENS + 1 }, undefined]) {
      const parsed = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }], usage })));
      expect(parsed).toMatchObject({ ok: false, problem: "no-usage" });
    }
    const outcome = await turn("hello", scripted([answer([{ type: "text", text: "hi" }], { input_tokens: 10_000_000, output_tokens: 1 })]).fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: true });
    // OpenRouter: a cost that is present must be a finite non-negative number.
    for (const cost of ["0.01", -1, 1e300]) {
      const parsed = parseMateProviderWrapper("openrouter-api", Buffer.from(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost } })));
      expect(parsed).toMatchObject({ ok: false, problem: "bad-cost" });
    }
  });

  test("a tool call is bounded whole — a long id or oversized text is malformed", () => {
    const big = (id: string) => parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "tool_use", id, name: "recap", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(big("x".repeat(65))).toMatchObject({ ok: false, problem: "bad-tool-call" });
    expect(big("x".repeat(64))).toMatchObject({ ok: true });
    const wide = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "tool_use", id: "a", name: "recap", input: { pad: "p".repeat(MATE_TOOL_CALL_CAP_BYTES) } }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(wide).toMatchObject({ ok: false, problem: "bad-tool-call" });
    const chatty = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "t".repeat(MATE_STEP_TEXT_CAP_BYTES + 1) }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(chatty).toMatchObject({ ok: false, problem: "text-over-cap" });
  });

  test("the reservation covers the worst history the caps allow, escaped once more on the wire", () => {
    const worst = mateWorstCaseForPrice(PRICE, 1_000);
    let expected = 0;
    for (let s = 1; s <= MATE_MAX_STEPS; s++) {
      expected += Math.ceil((1_000 + (s - 1) * (4 * 2 * (MATE_TOOL_RESULT_CAP_BYTES + MATE_TOOL_CALL_CAP_BYTES) + 2 * MATE_STEP_TEXT_CAP_BYTES)) / 3) * PRICE.inMicrousd;
    }
    expected += MATE_MAX_STEPS * MAX_OUTPUT_TOKENS * PRICE.outMicrousd;
    expect(worst).toBe(expected);
    // The pathological result — every byte escapes — still fits twice its cap.
    const escaped = JSON.stringify("\"".repeat(MATE_TOOL_RESULT_CAP_BYTES / 2));
    expect(Buffer.byteLength(escaped, "utf8")).toBeLessThanOrEqual(2 * MATE_TOOL_RESULT_CAP_BYTES);
  });

  test("a crash mid-loop: the sweep charges the whole reservation when a step is unproven, deletes the drafts, and latches", () => {
    const live = session();
    const t = thread();
    const opened = store.openMateTurn(
      { approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10_000, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 130_000 },
      T0,
    );
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, T0);
    if (!started.ok) throw new Error("start");
    store.draftMateProposal({ thread: t.id, turn: opened.id, kind: "hold", payload: { task: "in-1" }, ceilingDigest: who.ceilingDigest }, T0);
    const step = () =>
      store.openMateStep({ mateTurn: opened.id, generation: started.generation, approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", deadlineMs: 130_000 }, T0);
    const first = step();
    if (!first.ok) throw new Error(first.reason);
    const firstStarted = store.startChatTurn(first.id, T0);
    if (!firstStarted.ok) throw new Error("start");
    store.finalizeChatTurn(first.id, firstStarted.generation, { state: "answered", settledMicrousd: 700, tokensIn: 10, tokensOut: 10 }, T0);
    const second = step();
    if (!second.ok) throw new Error(second.reason);
    store.startChatTurn(second.id, T0);
    // The process dies here. Later, the sweep runs.
    const later = new Date(T0.getTime() + 200_000);
    store.sweepStaleMateTurns(later);
    expect(store.getMateTurn(opened.id)).toMatchObject({ state: "failed", failureReason: "crashed", settledMicrousd: 10_000, steps: 2 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(10_000);
    expect(store.listMateProposals(t.id)).toEqual([]);
    expect(store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, later)).toMatchObject({ ok: false, reason: "latched" });
  });

  test("the latch is re-checked before every step: another approver's unknown-cost turn stops this loop between steps", async () => {
    const script = scripted([
      answer([call("recap")]),
      () => {
        // Between steps, someone else's turn on the shared credential latches it.
        const other = store.openChatTurn({ approver: "root", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, clock());
        if (!other.ok) throw new Error(other.reason);
        const startedOther = store.startChatTurn(other.id, clock());
        if (!startedOther.ok) throw new Error("start");
        store.finalizeChatTurn(other.id, startedOther.generation, { state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true }, clock());
        return answer([call("recap")]);
      },
      text("never reached"),
    ]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "latched", unknownSpend: false });
    expect(script.bodies).toHaveLength(2);
  });

  test("the reservation is triangular and refuses before any dispatch against the session, the week, and the day", async () => {
    const script = scripted([text("hi")]);
    expect(await turn("hello", script.fetcher, { session: session(10) })).toMatchObject({ ok: false, refused: "session-exhausted" });
    expect(await turn("hello", script.fetcher, { config: { ...CONFIG, weeklyCeilingMicrousd: 10 } })).toMatchObject({ ok: false, refused: "over-budget" });
    const ended = session();
    store.endMateSession(ended.id, "alex", clock());
    expect(await turn("hello", script.fetcher, { session: ended })).toMatchObject({ ok: false, refused: "session-ended" });
    const expiring = session(5_000_000, 1_000);
    clockAt += 5_000;
    expect(await turn("hello", script.fetcher, { session: expiring })).toMatchObject({ ok: false, refused: "session-ended" });
    expect(await turn("hello", script.fetcher, { config: { ...CONFIG, priceInMicrousd: null, priceOutMicrousd: null, model: "no-such-model" } })).toMatchObject({ ok: false, refused: "unpriced" });
    expect(script.bodies).toHaveLength(0);
    const live = session();
    const good = await turn("hello", script.fetcher, { session: live });
    expect(good).toMatchObject({ ok: true });
    if (!good.ok) throw new Error("unreachable");
    expect(store.getMateTurn(good.turn)?.reservedMicrousd).toBe(mateWorstCaseForPrice(PRICE, Buffer.byteLength(script.bodies[0]!, "utf8")));
    // The day counts mate turns as one turn each, and closes chat and mate alike.
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live, config: { ...CONFIG, dailyTurns: 1 } })).toMatchObject({ ok: false, refused: "daily-cap" });
    expect(store.chatTurnsToday("alex", clock())).toBe(1);
  });

  test("admission binds the session and the thread to the approver and the credential", async () => {
    const bobs = session(5_000_000, 3_600_000, "root");
    const bobsThread = thread("root");
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: bobs })).toMatchObject({ ok: false, refused: "not-yours" });
    expect(await turn("hello", scripted([text("hi")]).fetcher, { thread: bobsThread })).toMatchObject({ ok: false, refused: "not-yours" });
    expect(store.listMateMessages(bobsThread.id, 10)).toEqual([]);
    // A session minted under another credential cannot be spent by this key.
    const otherKey = session(5_000_000, 3_600_000, "alex", credentialKeyOf("anthropic-api", "sk-ant-other"));
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: otherKey })).toMatchObject({ ok: false, refused: "not-yours" });
    // A closed thread cannot be continued.
    const live = session();
    const t = thread();
    store.closeMateThreadsFor("alex", clock());
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live, thread: t })).toMatchObject({ ok: false, refused: "thread-closed" });
  });

  test("the brand is runtime: a structural copy or a mutated principal is refused", async () => {
    expect(isVerifiedApprover(who)).toBe(true);
    const copy = { ...who, repos: [...who.repos] } as unknown as VerifiedApprover;
    expect(isVerifiedApprover(copy)).toBe(false);
    expect(reproveApprover(store, copy)).toMatchObject({ ok: false, reason: "forged" });
    expect(await turn("hello", scripted([text("hi")]).fetcher, { who: copy })).toMatchObject({ ok: false, refused: "standing" });
    expect(() => {
      (who.repos as string[])[0] = OUTSIDE;
    }).toThrow();
    expect(() => {
      (who as { name: string }).name = "root";
    }).toThrow();
    expect(who.repos[0]).toBe(INSIDE);
    // Minting takes the generation the session holds; a stale one refuses.
    expect(verifyApproverStanding(store, "alex", who.generation + 1, [INSIDE])).toMatchObject({ ok: false, reason: "generation" });
  });

  test("the ceiling binds: a surface under other repos cannot continue the session or the thread", async () => {
    const live = session();
    const narrowed = principal("alex", [INSIDE]);
    expect(narrowed.ceilingDigest).not.toBe(who.ceilingDigest);
    // Order is part of the ceiling: rN is an index (slice-2 review, finding 3).
    expect(ceilingDigestOf([OTHER, INSIDE])).not.toBe(who.ceilingDigest);
    expect(ceilingDigestOf([INSIDE, OTHER])).toBe(who.ceilingDigest);
    expect(await turn("hello", scripted([text("hi")]).fetcher, { who: narrowed, session: live })).toMatchObject({ ok: false, refused: "ceiling-changed" });
    // The thread under the old ceiling closes when a new ceiling opens one, and its pending proposals expire.
    const old = thread();
    const drafted = store.draftMateProposal({ thread: old.id, turn: 0, kind: "hold", payload: {}, ceilingDigest: who.ceilingDigest }, clock());
    expect(store.promoteMateProposals(0)).toBe(0); // no answered turn 0: nothing promotes
    expect(store.casMateProposal(drafted, "drafting", "pending", null, null, clock())).toBe(true);
    const reopened = store.openMateThread("alex", narrowed.ceilingDigest, clock());
    expect(reopened.ceilingChanged).toBe(true);
    expect(reopened.thread.id).not.toBe(old.id);
    expect(store.getMateThread(old.id)?.closedAt).not.toBeNull();
    expect(store.listMateProposals(old.id).map(one => one.state)).toEqual(["expired"]);
  });

  test("revocation DURING the model's answer ends the turn with nothing kept and the reservation charged; afterwards the principal is dead", async () => {
    const live = session();
    const t = thread();
    const script = scripted([
      answer([call("propose_hold", { task: "in-1", reason: "x" })]),
      () => {
        store.revokeAccount("alex", "root", clock());
        return text("here is what I propose");
      },
    ]);
    const outcome = await turn("hello", script.fetcher, { session: live, thread: t });
    expect(outcome).toMatchObject({ ok: false, failed: "superseded" });
    const row = store.getMateTurn((outcome as { turn: number }).turn);
    expect(row).toMatchObject({ state: "failed", failureReason: "revoked" });
    expect(row?.settledMicrousd).toBe(row?.reservedMicrousd);
    expect(store.getMateSession(live.id)).toMatchObject({ endedAt: expect.any(String), spentMicrousd: row?.reservedMicrousd });
    expect(store.listMateProposals(t.id)).toEqual([]);
    expect(store.listMateMessages(t.id, 10)).toEqual([]);
    expect(store.getMateThread(t.id)?.closedAt).not.toBeNull();
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live })).toMatchObject({ ok: false, refused: "standing" });
  });

  test("a mate-written scope never seals under mode coverage; a human rewrite clears the mark; filing carries it", () => {
    propose(store, { taskId: "in-2", goal: "the mate's goal", now: T0, proposedVia: "mate" });
    expect(store.sealScopeApproval("in-2", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    propose(store, { taskId: "in-2", goal: "the operator's goal", now: T0 });
    expect(store.sealScopeApproval("in-2", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(true);
    const filed = fileTaskProposal(store, { id: "mate-1", title: "filed by the mate", repo: INSIDE, goal: "g", filedVia: "mate", proposedVia: "mate" }, T0);
    expect(filed).toMatchObject({ ok: true });
    expect(store.sealScopeApproval("mate-1", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
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

  test("one live turn per approver across chat and mate, and the history the next turn sees is text only, operator first", async () => {
    const first = await turn("first question", scripted([text("first answer")]).fetcher);
    expect(first).toMatchObject({ ok: true });
    expect(historyFor(store, thread().id)).toEqual([
      { role: "operator", text: "first question" },
      { role: "assistant", text: "first answer", calls: [] },
    ]);
    const live = session();
    const t = thread();
    const blocking = store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    expect(blocking).toMatchObject({ ok: true });
    expect(await turn("second", scripted([text("x")]).fetcher, { session: live, thread: t })).toMatchObject({ ok: false, refused: "concurrent" });
    // Fleet chat sees the live mate turn too.
    expect(store.openChatTurn({ approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, clock())).toMatchObject({ ok: false, reason: "concurrent" });
  });

  test("the OpenRouter loop: tool_calls in, tool messages out, the same ledger", async () => {
    const or = (message: Record<string, unknown>) => json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0009 } });
    const script = scripted([
      or({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: JSON.stringify({ repo: "r1" }) } }] }),
      or({ content: "two tasks are queued in r1" }),
    ]);
    const live = session(5_000_000, 3_600_000, "alex", credentialKeyOf("openrouter-api", "or-key"));
    const outcome = await turn("what is queued?", script.fetcher, { session: live, config: { ...CONFIG, provider: "openrouter-api", model: "openai/gpt-5" }, key: "or-key" });
    expect(outcome).toMatchObject({ ok: true, steps: 2, activity: "read 1 · proposed 0 · 2 steps" });
    if (!outcome.ok) throw new Error("unreachable");
    // The reported cost ($0.0009 = 900 µ$) is higher than the pinned 360 and wins, per step.
    expect(outcome.settledMicrousd).toBe(2 * 900);
    const second = JSON.parse(script.bodies[1]!) as { messages: { role: string; tool_call_id?: string; content?: unknown }[] };
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(second.messages.at(-1)?.content)).toContain("\"queued\"");
  });

  test("the tools refuse bad arguments with typed messages, count decisions per task, and place the queue by column", () => {
    const ctx = { store, who, now: clock(), draft: () => 1 };
    expect(executeMateTool(ctx, "queue", { repo: "r9" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "list_tasks", { repo: INSIDE })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_task", { repo: "r1", title: "x", goal: "<script>alert(1)</script>" })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx, "propose_unhold", { task: "in-1" })).toMatchObject({ ok: false, message: expect.stringContaining("no hold") });
    expect(executeMateTool(ctx, "propose_reserve", { task: "in-1", worker: "nobody" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_cancel", { task: "out-1", reason: "r" })).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
    expect(executeMateTool(ctx, "recap", { since: "yesterday" })).toMatchObject({ ok: false });
    // Decisions are the task's own: in-2 shares the repo with in-1's decision and reports none.
    expect(executeMateTool(ctx, "get_task", { task: "in-1" })).toMatchObject({ ok: true, body: { repo: "r1", scope: "none", decisionsOpen: 1 } });
    expect(executeMateTool(ctx, "get_task", { task: "in-2" })).toMatchObject({ ok: true, body: { decisionsOpen: 0 } });
    const decisions = executeMateTool(ctx, "list_decisions", {});
    expect(decisions).toMatchObject({ ok: true, body: { decisions: [{ decision: 1, task: "in-1", options: [{ id: "open", reversible: true }, { id: "closed", reversible: false }], ageHours: 0 }] } });
    expect(JSON.stringify(decisions)).not.toContain("CONSEQUENCE");
    const queue = executeMateTool(ctx, "queue", { repo: "r1" });
    expect(queue).toMatchObject({ ok: true, body: { columns: [{ column: "shared", tasks: [{ position: 1 }, { position: 2 }, { position: 3 }] }] } });
    const recap = executeMateTool(ctx, "recap", { since: new Date(clockAt - 3_600_000).toISOString() });
    expect(recap).toMatchObject({ ok: true, body: { waitsOnYou: { decisions: [{ decision: 1, task: "in-1" }] }, repos: [{ repo: "r1", queued: 3 }, { repo: "r2", queued: 1 }] } });
    expect(JSON.stringify(executeMateTool(ctx, "get_task", { task: "in-3" }))).not.toContain("PATH");
  });
});
