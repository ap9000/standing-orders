/** The lead checks before it speaks: reply rules, a memory search before a proposal on a project with decisions,
 * integration status, questions with options, and refusal copy in plain words. */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeMateTool, type MateToolContext } from "./mate-tools.js";
import { recordDecision } from "./project-memory.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { MATE_REFUSAL_COPY } from "./mate.js";
import { CHAT_CONTROLS } from "./chat-controls.js";
import type { Integration } from "./integrations.js";

const T0 = new Date("2026-10-02T12:00:00.000Z");
const TASK_ARGS = { title: "Add a refund page", goal: "People can ask for a refund.", acceptance: [{ id: "c1", statement: "A refund can be requested.", evidence: ["manual-review"] }] };

describe("the lead checks before it speaks", () => {
  let store: Store;
  let who: VerifiedApprover;
  let drafted: number;
  let dir: string, SETTLED: string, OPEN: string;
  const ctx = (step: number, extra: Partial<MateToolContext> = {}): MateToolContext => ({ store, who, now: T0, step, readDecisions: new Map(), draft: () => ++drafted, ...extra });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-lead-checks-")));
    SETTLED = join(dir, "settled"); OPEN = join(dir, "open");
    for (const repo of [SETTLED, OPEN]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [SETTLED, OPEN]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    drafted = 0;
    for (const [id, repo] of [["s1", SETTLED], ["o1", OPEN]] as const) {
      const filed = fileTaskProposal(store, { id, title: `task ${id}`, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    }
    recordDecision(store, { repo: SETTLED, actor: "alex", draft: { claim: "Refunds go through Stripe only", why: "One ledger." } }, T0);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("c1: a proposal on a project with recorded decisions needs a memory search in an earlier step of the turn", () => {
    const searched = new Map<string, number>();
    // No search: refused, in plain words, before anything is drafted.
    const refused = executeMateTool(ctx(1, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("search_project_memory first") });
    expect(drafted).toBe(0);
    // The same for a proposal named by its task, not its project.
    expect(executeMateTool(ctx(1, { searchedMemory: searched }), "propose_steer", { task: "s1", note: "Start with the form." })).toMatchObject({ ok: false });
    // A search in the same step does not count: its results were not read yet.
    expect(executeMateTool(ctx(2, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r1" })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx(2, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: false });
    // In a later step it does.
    expect(executeMateTool(ctx(3, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx(3, { searchedMemory: searched }), "propose_steer", { task: "s1", note: "Start with the form." })).toMatchObject({ ok: true });
  });

  test("c1: a search over another project does not count; a search over every project does; a project without decisions needs none", () => {
    const searched = new Map<string, number>();
    executeMateTool(ctx(1, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r2" });
    expect(executeMateTool(ctx(2, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: false });
    // The project without recorded decisions is unaffected, searched or not.
    expect(executeMateTool(ctx(2), "propose_task", { repo: "r2", ...TASK_ARGS })).toMatchObject({ ok: true });
    executeMateTool(ctx(3, { searchedMemory: searched }), "search_project_memory", { query: "refunds" });
    expect(executeMateTool(ctx(4, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: true });
  });

  test("c2: the lead reads integration status, and Settings → Integrations is a fixed control", () => {
    const list: Integration[] = [
      { key: "telegram", group: "chat", name: "Telegram", state: "connected", account: "@toolroll_bot", detail: null, checked: true, checkedAt: null, lastSuccessAt: "2026-10-02T11:00:00.000Z", lastError: null, lastErrorAt: null, usedBy: ["Chat"], action: { kind: "test", label: "Send test" } },
      { key: "slack", group: "chat", name: "Slack", state: "not-set-up", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, usedBy: [], action: { kind: "setup", label: "Set up", href: "/settings/slack", command: null } },
      { key: "email", group: "mail", name: "Email", state: "broken", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: "Sign-in refused", lastErrorAt: null, usedBy: ["Flows"], action: { kind: "fix", label: "Fix", words: "Sign in to the mailbox again.", href: "/settings/email", command: null } },
    ];
    const read = executeMateTool(ctx(1, { integrations: () => list }), "get_integrations", {});
    expect(read).toMatchObject({ ok: true, body: { integrations: [
      { name: "Telegram", state: "Connected", account: "@toolroll_bot", next: null },
      { name: "Slack", state: "Not set up", next: expect.stringContaining("Settings → Integrations") },
      { name: "Email", state: "Broken", next: "Fix: Sign in to the mailbox again.", lastError: "Sign-in refused" },
    ] } });
    // Without a surface's list it reads the same saved state: nothing set up in a fresh database.
    const fresh = executeMateTool(ctx(1), "get_integrations", {});
    expect(fresh.ok && (fresh.body as { integrations: { name: string; state: string }[] }).integrations.find(one => one.name === "Slack")?.state).toBe("Not set up");
    expect(CHAT_CONTROLS.integrations).toEqual({ label: "Set up integrations", href: "/settings/integrations" });
    expect(executeMateTool(ctx(1), "show_control", { control: "integrations" })).toMatchObject({ ok: true, body: { label: "Set up integrations" } });
  });

  test("c2: ask_owner takes one question with 2-4 short distinct options, adds Something else, and asks once per reply", () => {
    const asked: { question: string; options: readonly string[] }[] = [];
    const ask = (question: string, options: readonly string[]) => asked.length === 0 && asked.push({ question, options }) === 1;
    const call = (args: Record<string, unknown>) => executeMateTool(ctx(1, { ask }), "ask_owner", args);
    expect(call({ question: "Which page first?", options: ["Login"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["A", "B", "C", "D", "E"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "login"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "Something else"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "x".repeat(41)] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "Signup"] })).toMatchObject({ ok: true, body: { options: ["Login", "Signup", "Something else"] } });
    expect(asked).toEqual([{ question: "Which page first?", options: ["Login", "Signup"] }]);
    expect(call({ question: "And then?", options: ["Yes", "No"] })).toMatchObject({ ok: false, message: expect.stringContaining("one at a time") });
    // A surface that cannot draw buttons says so instead of pretending.
    expect(executeMateTool(ctx(1), "ask_owner", { question: "Which page first?", options: ["Login", "Signup"] })).toMatchObject({ ok: false });
  });

  test("c2: a question belongs to its answered turn, closes once the owner writes again, and a failed turn keeps none", () => {
    const thread = store.openMateThread("alex", who.ceilingDigest, T0).thread;
    store.mintMateSession({ approver: "alex", approverGeneration: who.generation, credentialKey: "k", ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
    const session = store.activeMateSession("alex")!;
    const turn = (answered: boolean): number => {
      const opened = store.openMateTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey: "k", reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, T0);
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startMateTurn(opened.id, T0);
      if (!started.ok) throw new Error("start");
      store.appendMateMessage({ thread: thread.id, turn: opened.id, role: "operator", text: "Plan the refunds" }, T0);
      expect(store.recordMateAsk({ turn: opened.id, thread: thread.id, question: "Which first?", options: ["Login", "Signup"] }, T0)).toBe(true);
      expect(store.recordMateAsk({ turn: opened.id, thread: thread.id, question: "Again?", options: ["Yes", "No"] }, T0)).toBe(false);
      // Not shown while the turn runs.
      expect(store.mateAsk(opened.id)).toBeNull();
      if (answered) store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1, message: { text: "One choice first.", activity: "" } }, T0);
      else { store.finalizeMateTurn(opened.id, started.generation, { state: "failed", settledMicrousd: 0, unknownSpend: false, tokensIn: 0, tokensOut: 0, failureReason: "provider-error" }, T0); store.dropMateAsk(opened.id); }
      return opened.id;
    };
    const first = turn(true);
    expect(store.mateAskOpen(first)).toMatchObject({ question: "Which first?", options: ["Login", "Signup"] });
    store.appendMateMessage({ thread: thread.id, turn: null, role: "operator", text: "Login" }, T0);
    expect(store.mateAskOpen(first)).toBeNull();
    expect(store.mateAsk(first)).not.toBeNull();
    const failed = turn(false);
    expect(store.mateAsk(failed)).toBeNull();
  });

  test("c3: the contract carries the reply rules, the memory, integration and asking rules", () => {
    for (const rule of [
      "lead with the answer",
      "a status or a yes/no is 1-3 sentences",
      "Plain text, no headers",
      "Say what you checked this turn",
      "I checked the run log:",
      "Mark anything you did not check this turn as a guess",
      "I haven't checked",
      "say 'I don't know', then check with a tool",
      "never make up an answer, and never present a guess as something you remember",
      "call search_project_memory for it this turn",
      "read get_integrations",
      "show_control integrations",
      "use ask_owner: one question, 2-4 short options",
      "only when the answer changes the work",
    ]) expect(MATE_CONTRACT).toContain(rule);
  });

  test("c3: refusal copy is plain words — what happened, then one next step — with no internal terms", () => {
    for (const [reason, copy] of Object.entries(MATE_REFUSAL_COPY)) {
      expect(copy, reason).not.toMatch(/\b(mint|minted|latch|latched|credential|ceiling|session|admitted|turn cap|pinned)\b/i);
      expect(copy, reason).toMatch(/^[A-Z]/);
      expect(copy, reason).toMatch(/\.$/);
      // At least two sentences: what happened and what it means, then the step to take.
      expect(copy.split(/(?<=\.)\s+/).length, reason).toBeGreaterThanOrEqual(2);
    }
    expect(MATE_REFUSAL_COPY["ceiling-changed"]).toBe("Your projects changed since this chat started, so it can't go on. Start a new chat.");
    expect(MATE_REFUSAL_COPY.latched).toBe("An earlier reply stopped before its cost was known, so chat is paused. Acknowledge that reply on the Chat page, then send again.");
  });
});
