import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { confirmMateProposal } from "./mate-doors.js";
import { executeMateTool, type MateToolContext } from "./mate-tools.js";
import { runLeadFollowPass } from "./lead-follow.js";
import { leadContext } from "./lead-context.js";
import { knowledgeView } from "./project-knowledge.js";
import { getCommitment, openCommitments } from "./lead-commitments.js";

describe("the lead keeps its promises and remembers corrections", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, session: number, thread: number;
  const t0 = new Date("2026-10-02T12:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lead-promises-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Promises\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    store = openStore(join(root, "state.db"));
    if (!addApprover(store, "operator", t0).ok) throw Error("account");
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "fixture", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, t0);
    thread = store.openMateThread(who.name, who.ceilingDigest, t0).thread.id;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** One lead turn: the tools run inside it, then it is answered (or fails) with its reply. */
  function turn(now: Date, calls: (ctx: MateToolContext) => void, state: "answered" | "failed" = "answered") {
    const opened = store.openMateTurn({ approver: who.name, session, thread, credentialKey: "fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw Error(opened.reason);
    const started = store.startMateTurn(opened.id, now);
    if (!started.ok) throw Error("start");
    const ctx: MateToolContext = { store, who, now, step: 1, readDecisions: new Map(), thread, turn: opened.id, evidenceRoot: root,
      draft: (kind, payload) => store.draftMateProposal({ thread, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, now) };
    calls(ctx);
    store.finalizeMateTurn(opened.id, started.generation, state === "answered"
      ? { state, settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "I'll tell you.", activity: "" } }
      : { state, settledMicrousd: 0, tokensIn: 0, tokensOut: 0, failureReason: "provider-error" }, now);
    return opened.id;
  }
  const call = (ctx: MateToolContext, name: string, args: Record<string, unknown>) => {
    const result = executeMateTool(ctx, name, args);
    if (!result.ok) throw Error(result.message);
    return result.body as Record<string, unknown>;
  };
  const pass = (now: Date) => runLeadFollowPass({ store, repos: () => [repo], evidenceRoot: root, clock: () => now, provider: () => null });
  const said = () => store.listMateMessages(thread, 50).filter(one => one.role === "assistant" && one.turn === null).map(one => one.text);
  function builtRun(id: string) {
    const made = fileTaskProposal(store, { id, title: "Fix the login page", repo, filedVia: "cli", planning: "skip" }, t0);
    if (!made.ok) throw Error(made.message);
    return store.startRun({ taskRef: store.refFor("built-in", id).id, leaseId: "l", runner: "b1", branch: "b", worktree: "/w",
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: t0 });
  }

  test("c1: a promise records what, its condition, check time, channel and expiry, and is reported once when met", async () => {
    const run = builtRun("login");
    let made: Record<string, unknown> = {};
    turn(t0, ctx => { made = call(ctx, "commit_to", { what: "Tell you when the release check passes", when: "check", run, result: "passed" }); });
    const saved = getCommitment(store, Number(made["commitment"]))!;
    expect(saved).toMatchObject({ owner: "operator", repo, thread, channel: "chat", state: "open", what: "Tell you when the release check passes",
      condition: { kind: "check", run, result: "passed" }, checkAt: t0.toISOString(), expiresAt: "2026-10-09T12:00:00.000Z" });
    expect(made["condition"]).toBe("when the checks on “Fix the login page” pass");

    // Not met yet: nothing is said, and the next look is scheduled.
    await pass(at(1));
    expect(said()).toEqual([]);
    expect(getCommitment(store, saved.id)).toMatchObject({ state: "open", checkedAt: at(1).toISOString() });

    store.finishRun(run, { outcome: "built", now: at(2) });
    store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, at(2));
    await pass(at(3));
    expect(said()).toEqual(["The checks on “Fix the login page” passed. (I said I would tell you when the release check passes.)"]);
    expect(getCommitment(store, saved.id)).toMatchObject({ state: "done", closedBy: "lead" });
    // Once: later passes say nothing more.
    await pass(at(10));
    await pass(at(20));
    expect(said()).toHaveLength(1);
    expect(openCommitments(store, "operator")).toEqual([]);
  });

  test("c1: a task state and a time each complete a promise; one never met expires after 7 days without a message", async () => {
    builtRun("payout");
    turn(t0, ctx => {
      call(ctx, "commit_to", { what: "Tell you when payouts is complete", when: "task", task: "payout", states: ["complete"] });
      call(ctx, "commit_to", { what: "Check back with you this afternoon", when: "time", at: at(120).toISOString() });
    });
    const [task, time] = openCommitments(store, "operator");
    expect(time).toMatchObject({ condition: { kind: "time" }, checkAt: at(120).toISOString() });
    await pass(at(60));
    expect(said()).toEqual([]);
    await pass(at(121));
    expect(said()).toEqual(["It is time. (I said I would check back with you this afternoon.)"]);
    await pass(at(7 * 24 * 60 + 1));
    expect(getCommitment(store, task!.id)).toMatchObject({ state: "expired" });
    expect(said()).toHaveLength(1);
  });

  test("c1: a promise from a reply that failed is dropped; the owner can cancel one (as Settings → Lead does); the lead can release one", async () => {
    turn(t0, ctx => { call(ctx, "commit_to", { what: "Tell you tomorrow", when: "time", at: at(60).toISOString() }); }, "failed");
    await pass(at(61));
    expect(said()).toEqual([]);
    expect(store.handle.prepare("SELECT state, outcome FROM lead_commitment").get()).toMatchObject({ state: "cancelled", outcome: "The reply that made this promise did not finish." });

    let ids: number[] = [];
    turn(at(70), ctx => {
      ids = [call(ctx, "commit_to", { what: "Ping you at five", when: "time", at: at(300).toISOString() }),
        call(ctx, "commit_to", { what: "Ping you at six", when: "time", at: at(360).toISOString() })].map(one => Number(one["commitment"]));
      expect(executeMateTool(ctx, "commit_to", { what: "Ping you next month", when: "time", at: at(8 * 24 * 60).toISOString() })).toMatchObject({ ok: false });
      expect(executeMateTool(ctx, "commit_to", { what: "Watch someone else's task", when: "task", task: "nope" })).toMatchObject({ ok: false });
    });
    const { cancelCommitment } = await import("./lead-commitments.js");
    expect(cancelCommitment(store, "someone-else", ids[0]!, "someone-else", "no", at(80))).toBe(false);
    expect(cancelCommitment(store, "operator", ids[0]!, "operator", "Cancelled in Settings.", at(80))).toBe(true);
    turn(at(90), ctx => { expect(call(ctx, "release_commitment", { commitment: ids[1], reason: "You said not to ping after five." })).toMatchObject({ state: "cancelled" }); });
    await pass(at(400));
    expect(said()).toEqual([]);
  });

  test("c2: a correction becomes a confirmable decision card at once, and once confirmed it is in the next turn's bundle with the follow-through", () => {
    let card = 0, promise = 0;
    turn(t0, ctx => {
      promise = Number(call(ctx, "commit_to", { what: "Tell you when the full checks pass", when: "time", at: at(60).toISOString() })["commitment"]);
      const body = call(ctx, "remember", { repo: "r1", kind: "decision", text: "Don't run full checks on this project", why: "The operator said full checks are too slow here; quick checks are enough." });
      card = Number(body["proposal"]);
      expect(body).toMatchObject({ awaiting: "confirmation", executed: false });
    });
    const proposal = store.getMateProposal(card)!;
    expect(proposal).toMatchObject({ kind: "action", state: "pending", payload: { operation: "decision_record" } });
    let bundle = JSON.parse(leadContext(store, who.repos, at(1), root, { owner: who.name, thread }));
    expect(bundle.projects).toEqual([]);
    expect(bundle.corrections).toEqual([]);
    expect(bundle.commitments).toMatchObject([{ id: promise, what: "Tell you when the full checks pass" }]);

    const confirmed = confirmMateProposal(store, who, card, at(2), { via: "telegram", evidenceRoot: root });
    expect(confirmed).toMatchObject({ ok: true });
    bundle = JSON.parse(leadContext(store, who.repos, at(3), root, { owner: who.name, thread }));
    expect(bundle.projects).toMatchObject([{ repo: "r1", decisions: [{ claim: "Don't run full checks on this project" }] }]);
    expect(bundle.corrections).toEqual([{ proposal: card, change: expect.stringContaining("Don't run full checks on this project") }]);
    expect(bundle.followThrough).toMatch(/Re-check the open proposals and promises/);
    // After the lead's next reply the correction is no longer new; the decision stays in the bundle.
    turn(at(4), () => {});
    bundle = JSON.parse(leadContext(store, who.repos, at(5), root, { owner: who.name, thread }));
    expect(bundle.corrections).toEqual([]);
    expect(bundle.projects[0].decisions).toHaveLength(1);
  });

  test("c2: a lasting preference becomes an instruction card added to the project's instructions, in the next bundle once confirmed", () => {
    let card = 0;
    turn(t0, ctx => {
      card = Number(call(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies to two sentences." })["proposal"]);
      expect(executeMateTool(ctx, "remember", { repo: "r1", kind: "decision", text: "No reason given" })).toMatchObject({ ok: false });
    });
    expect(store.getMateProposal(card)!.payload).toMatchObject({ operation: "knowledge_instructions" });
    expect(confirmMateProposal(store, who, card, at(1), { via: "telegram", evidenceRoot: root })).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe("Keep replies to two sentences.");
    const bundle = JSON.parse(leadContext(store, who.repos, at(2), root, { owner: who.name, thread }));
    expect(bundle.projects).toMatchObject([{ repo: "r1", instructions: "Keep replies to two sentences." }]);
    expect(bundle.corrections).toEqual([{ proposal: card, change: "Project instructions now end: Keep replies to two sentences." }]);
    // Saying it again adds nothing.
    turn(at(3), ctx => { expect(executeMateTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies to two sentences." })).toMatchObject({ ok: false }); });
  });
});
