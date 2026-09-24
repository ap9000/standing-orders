/**
 * Sort steps (v85): Jev through OpenRouter picks where a card goes. The
 * store, the engine's step pass and the canvas projection are real; only
 * OpenRouter is a fake, answering in the documented Decisions API shape.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import type { Runner } from "./backend.js";
import { FLOW_TEMPLATES, flowFromSteps, flowTerms, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { flowInsights } from "./flow-insights.js";
import { flowView } from "./flows-ui.js";
import { JEV_URL } from "./flow-sort.js";

const T0 = new Date("2026-09-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
// Key-shaped values are made when the test runs, never written out.
const KEY = ["sk", "or", "v1", "f".repeat(64)].join("-");

let dir: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-sort-")));
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const template = (id: string): FlowDefinition => structuredClone(FLOW_TEMPLATES.find(one => one.id === id)!.definition);
const flowFrom = (definition: FlowDefinition) => store.createFlow({ repo: join(dir, "shop"), name: "Support", definitionJson: JSON.stringify(definition), by: "alex" }, T0);

type Answers = Record<string, Record<string, unknown>>;
/** OpenRouter's Decisions API, answering each call with the next of `replies` (a status, or Jev's answers). */
function openRouter(...replies: (Answers | number)[]) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = replies[Math.min(calls.length, replies.length) - 1]!;
    return typeof reply === "number"
      ? new Response(JSON.stringify({ error: { message: "No auth credentials found", code: reply } }), { status: reply, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: reply, usage: { input_tokens: 420, output_tokens: 40, cost: 0.0000176 }, id: "gen-dec-1", provider: "TypeSafe" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}
const io = (fetcher: typeof fetch, key: string | null = KEY): StepIo => ({ gh: vi.fn<Runner>(), git: exec, shell: exec, fetch: fetcher, dir, scratch: join(dir, "scratch"), base: "main", openRouterKey: () => key });
const invoice = (confidence: number, choice = "invoice-problem"): Answers => ({
  route: { type: "choice", choice, probabilities: { "order-change": 0.02, "invoice-problem": confidence, "delivery-problem": 0.02, "something-else": 1 - confidence - 0.04 }, confidence },
  note_urgency: { type: "score", score: 1.8, legend: { 0: "Routine: no deadline", 1: "Soon", 2: "Now" }, probabilities: { 0: 0, 1: 0.2, 2: 0.8 }, confidence: 0.77 },
  note_refund: { type: "noul", noul: 0.82 },
});

describe("the drawing", () => {
  test("every template is a valid flow, and the five sorting templates send each answer to one of their own zones", () => {
    for (const one of FLOW_TEMPLATES) expect(() => validateFlowDefinition(one.definition)).not.toThrow();
    const sorting = FLOW_TEMPLATES.filter(one => one.definition.stages.some(stage => stage.kind === "sort")).map(one => one.id);
    expect(sorting).toEqual(["triage", "spam-filter", "lead-routing", "effort-routing", "exception-routing"]);
    for (const id of sorting) {
      const definition = template(id);
      for (const stage of definition.stages.filter(one => one.kind === "sort")) {
        expect(stage.next).toBeNull();
        for (const answer of stage.sort!.answers) expect(definition.stages.some(one => one.id === answer.to && one.id !== stage.id)).toBe(true);
      }
    }
  });

  test("a sort zone needs a question, 2 to 12 answers each going somewhere else, and levels for a score", () => {
    const base = template("exception-routing");
    const withSort = (change: Record<string, unknown>) => ({ ...base, stages: base.stages.map(one => one.kind === "sort" ? { ...one, sort: { ...one.sort, ...change } } : one) });
    expect(() => validateFlowDefinition(withSort({ question: "" }))).toThrow("Zone Sort: write the question it sorts by.");
    expect(() => validateFlowDefinition(withSort({ answers: [{ answer: "Only", means: "one", to: "orders" }] }))).toThrow("Zone Sort: give it 2 to 12 answers.");
    expect(() => validateFlowDefinition(withSort({ answers: [{ answer: "Loop", to: "sort" }, { answer: "Orders", to: "orders" }] }))).toThrow("Zone Sort: an answer can't send cards back into the same zone.");
    expect(() => validateFlowDefinition(withSort({ answers: [{ answer: "Orders", to: "orders" }, { answer: "orders!", to: "billing" }] }))).toThrow("Zone Sort: two answers are called orders!.");
    expect(() => validateFlowDefinition(withSort({ answers: [{ answer: "Orders", to: "orders" }, { answer: "Gone", to: "nowhere" }] }))).toThrow("Zone Sort points at a zone that no longer exists.");
    expect(() => validateFlowDefinition(withSort({ notes: [{ kind: "score", question: "How big?", levels: ["Only one"] }] }))).toThrow("Zone Sort: a score needs 2 to 10 levels, lowest first.");
    // How sure it must be stays between 50% and 99%; a sort leads only where its answers say.
    const clamped = validateFlowDefinition({ ...withSort({ sureAt: 0.2 }), stages: withSort({ sureAt: 0.2 }).stages.map(one => one.kind === "sort" ? { ...one, next: "done" } : one) });
    expect(clamped.stages.find(one => one.kind === "sort")).toMatchObject({ next: null, sort: { sureAt: 0.5 } });
  });

  test("the lead's steps: answers name the steps they go to, a percentage, the not-sure step, and what the card is told", () => {
    const flow = flowFromSteps([
      { title: "Tickets", kind: "inbox" },
      { title: "Sort", kind: "sort", question: "Which team owns this?", sureAt: 85, ifNotSure: "Sort by hand",
        answers: [{ answer: "Billing", means: "Charges, invoices and refunds", goesTo: "Billing team" }, { answer: "Technical", means: "Bugs and outages", goesTo: "tech" }],
        alsoNote: [{ question: "Is the customer asking for money back?", kind: "yes-no" }] },
      { id: "tech", title: "Tech team", kind: "inbox", next: "Done" },
      { title: "Billing team", kind: "inbox", next: "Done" },
      { title: "Sort by hand", kind: "inbox", next: "Done" },
    ], null);
    const sort = flow.stages.find(one => one.kind === "sort")!;
    expect(sort).toMatchObject({ next: null, onFail: "sort-by-hand", sort: { question: "Which team owns this?", sureAt: 0.85,
      answers: [{ answer: "Billing", to: "billing-team" }, { answer: "Technical", to: "tech" }], notes: [{ kind: "yes-no", levels: null }] } });
    const terms = flowTerms(flow, null);
    expect(terms[1]).toBe("2. Sort — Sort\nJev asks: Which team owns this?\nBilling → Billing team.\nTechnical → Tech team.\nLess than 85% sure → Sort by hand.\nAlso notes: Is the customer asking for money back? (yes or no)");
    expect(terms.at(-1)).toBe("Sort steps send each card's title, details and earlier notes to Jev through your OpenRouter account.");
    expect(() => flowFromSteps([{ title: "Sort", kind: "sort", question: "Which?", answers: [{ answer: "A", goesTo: "Nowhere" }, { answer: "B", goesTo: "Done" }] }], null)).toThrow("Step Sort: there's no step called Nowhere.");
    // Found end to end: the lead put a holding step first, so new cards would wait unsorted. The confirm card says so.
    expect(terms.join("\n")).toContain("New cards wait in Tickets, so Sort only sorts the cards someone moves there.");
    // Found end to end: the lead wrote an id with underscores; every way of writing it names the same step.
    const written = flowFromSteps([
      { id: "sort", title: "Sort ticket", kind: "sort", question: "Which?", ifNotSure: "sort_by_hand", answers: [{ answer: "Billing", goesTo: "Billing_Team" }, { answer: "Other", goesTo: "SORT-BY-HAND" }] },
      { id: "billing_team", title: "Billing", kind: "inbox" }, { id: "sort_by_hand", title: "Sort by hand", kind: "inbox" },
    ], null);
    expect(written.start).toBe("sort");
    expect(written.stages.map(one => one.id)).toEqual(["sort", "billing-team", "sort-by-hand", "done"]);
    expect(written.stages[0]).toMatchObject({ onFail: "sort-by-hand", sort: { answers: [{ to: "billing-team" }, { to: "sort-by-hand" }] } });
    const sortFirst = flowFromSteps([{ title: "Sort", kind: "sort", question: "Which?", answers: [{ answer: "A", goesTo: "Done" }, { answer: "B", goesTo: "Done" }] }], null);
    expect(flowTerms(sortFirst, null).join("\n")).not.toContain("New cards wait");
  });
});

describe("sorting a card", () => {
  test("Jev's answer sends the card on; the card keeps what it decided, and its key-shaped lines never leave", async () => {
    const flow = flowFrom(template("exception-routing"));
    const token = ["ghp", "q".repeat(36)].join("_");
    const card = store.addFlowCard({ flow, title: "Charged twice on invoice INV-889", description: `Please refund the duplicate.\nmy token ${token}`, stage: "sort", by: "alex" }, T0);
    const jev = openRouter(invoice(0.94));
    expect(await runFlowSteps(store, join(dir, "shop"), at(1), io(jev.fetcher))).toEqual({ ran: 1, problems: [] });
    // One request, in OpenRouter's shape, with the operator's key.
    expect(jev.calls).toHaveLength(1);
    const [call] = jev.calls;
    expect(call).toMatchObject({ url: JEV_URL, auth: `Bearer ${KEY}`, body: { model: "~typesafe/jev-latest", state: { title: "Charged twice on invoice INV-889" } } });
    expect((call!.body["state"] as Record<string, string>)["details"]).toBe("Please refund the duplicate.\n[redacted: github-token detected on this line]");
    expect(JSON.stringify(call!.body)).not.toContain(token);
    expect(call!.body["questions"]).toEqual({
      route: { type: "choice", instructions: "What kind of problem is this? Read the card's title and details.", criteria: {
        "order-change": "The customer wants to change, cancel or add to an order", "invoice-problem": "A wrong amount, a duplicate charge, missing details or a disputed invoice",
        "delivery-problem": "An order that is late, lost, damaged or wrong", "something-else": "Anything that isn't about an order, an invoice or a delivery" } },
      note_urgency: { type: "score", instructions: "How urgent is it?", criteria: ["Routine: no deadline", "Soon: the customer is waiting on it", "Now: money is at stake or a deadline is named"] },
      note_refund: { type: "noul", instructions: "Is the customer asking for money back?" },
    });
    // It went where the answer leads, and says why.
    expect(store.getFlowCard(card)).toMatchObject({ stage: "billing", waiting: null, outputs: { sort: "Invoice problem, 94% sure. How urgent is it? Now. Is the customer asking for money back? Yes." } });
    const run = store.flowStepRun(card, 1)!;
    expect(run).toMatchObject({ kind: "sort", state: "passed", result: "Invoice problem, 94% sure. How urgent is it? Now. Is the customer asking for money back? Yes." });
    expect(JSON.parse(run.decisionJson!)).toMatchObject({ model: "typesafe/jev-1.13-20260917", answer: "Invoice problem", sure: 0.94, sureAt: 0.8, confident: true, to: "billing", cost: 0.0000176,
      notes: [{ id: "urgency", answer: "Now: money is at stake or a deadline is named", sure: 0.77 }, { id: "refund", answer: "yes", sure: 0.82 }] });
    expect(run.log).toContain("What kind of problem is this?\n  Invoice problem           94%  ← picked\n  Order change               2%");
    // The canvas shows it on the card, and the history says it was sorted.
    const view = flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null);
    expect(view.cards.find(one => one.id === card)).toMatchObject({ sorted: { chip: "Invoice problem · 94% · Now", confident: true } });
    expect(view.cards.find(one => one.id === card)!.history.map(one => one.text)).toContain("Sorted into Billing team");
    // A card is sorted once per visit: the next pass leaves it be.
    expect(await runFlowSteps(store, join(dir, "shop"), at(2), io(jev.fetcher))).toEqual({ ran: 0, problems: [] });
  });

  test("when Jev isn't sure enough, the card goes to the not-sure zone and its owner hears; with no such zone it waits", async () => {
    const flow = flowFrom(template("exception-routing"));
    const card = store.addFlowCard({ flow, title: "Something about my order and my bill", description: null, stage: "sort", by: "alex" }, T0);
    store.setFlowCardOwner(card, "alex", "alex", T0);
    await runFlowSteps(store, join(dir, "shop"), at(1), io(openRouter(invoice(0.62)).fetcher));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "by-hand", outputs: { sort: "Not sure: 62% Invoice problem. How urgent is it? Now. Is the customer asking for money back? Yes." } });
    expect(store.listNotifications("all").filter(one => one.kind === "flow-card").map(one => [one.recipient, one.subject])).toEqual([["alex", "Support: Sort wasn't sure about “Something about my order and my bill”"]]);
    expect(flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null).cards[0]!.sorted).toEqual({ chip: "Invoice problem · 62% · Now", confident: false });

    const alone = template("exception-routing");
    alone.stages = alone.stages.map(one => one.kind === "sort" ? { ...one, onFail: null } : one);
    const waits = store.addFlowCard({ flow: flowFrom(alone), title: "Unclear", description: null, stage: "sort", by: "alex" }, T0);
    await runFlowSteps(store, join(dir, "shop"), at(2), io(openRouter(invoice(0.55)).fetcher));
    expect(store.getFlowCard(waits)).toMatchObject({ stage: "sort", waiting: "Not sure: 55% Invoice problem. How urgent is it? Now. Is the customer asking for money back? Yes. Move it to the right zone." });
  });

  test("no key: the card waits and says where to add one; a refused key or a strange answer is tried again, then takes the not-sure path", async () => {
    const flow = flowFrom(template("exception-routing"));
    const card = store.addFlowCard({ flow, title: "Cancel my order", description: null, stage: "sort", by: "alex" }, T0);
    const none = openRouter(invoice(0.9));
    await runFlowSteps(store, join(dir, "shop"), at(1), io(none.fetcher, null));
    expect(none.calls).toHaveLength(0);
    expect(store.getFlowCard(card)!.waiting).toBe("Sorting needs an OpenRouter key. Add one in Settings → AI providers.");

    const refused = openRouter(401, invoice(0.9, "refund-please"), 401);
    expect((await runFlowSteps(store, join(dir, "shop"), at(2), io(refused.fetcher))).problems).toEqual([`flow card ${card}: OpenRouter didn't accept the key. Check it in Settings → AI providers. It said: No auth credentials found`]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "sort", waiting: "OpenRouter didn't accept the key. Check it in Settings → AI providers. It said: No auth credentials found Trying again in 5 minutes." });
    await runFlowSteps(store, join(dir, "shop"), at(8), io(refused.fetcher));
    expect(store.getFlowCard(card)!.waiting).toBe("Jev picked an answer this zone doesn't have. Trying again in 15 minutes.");
    await runFlowSteps(store, join(dir, "shop"), at(24), io(refused.fetcher));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "by-hand" });
    expect(store.flowStepRun(card, 1)).toMatchObject({ state: "failed", attempts: 3, decisionJson: null });
  });
});

describe("how well it sorts", () => {
  test("people's moves say when Jev was right, by how sure it was, and the insights suggest a better threshold", async () => {
    const flow = flowFrom(template("exception-routing"));
    const repo = join(dir, "shop");
    // Six not-sure cards (70–80% sure) that people then placed; five where Jev's pick was right.
    for (let n = 0; n < 6; n++) {
      const card = store.addFlowCard({ flow, title: `Unclear ${n}`, description: null, stage: "sort", by: "alex" }, T0);
      await runFlowSteps(store, repo, at(1 + n), io(openRouter(invoice(0.75)).fetcher));
      store.moveFlowCard(card, { to: n === 5 ? "orders" : "billing", outcome: "moved", actor: "alex" }, at(10 + n));
    }
    // Two sure ones: one moved on (right), one a person moved to another answer's zone (wrong).
    const right = store.addFlowCard({ flow, title: "Sure and right", description: null, stage: "sort", by: "alex" }, T0);
    const wrong = store.addFlowCard({ flow, title: "Sure and wrong", description: null, stage: "sort", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(20), io(openRouter(invoice(0.93)).fetcher));
    store.moveFlowCard(right, { to: "done", outcome: "moved", actor: "alex" }, at(30));
    store.moveFlowCard(wrong, { to: "delivery", outcome: "moved", actor: "alex" }, at(31));

    const sort = flowInsights(store, store.getFlow(flow)!, at(60), 30).sorts[0]!;
    expect(sort).toMatchObject({ zone: "sort", title: "Sort", sorted: 8, alone: 2, notSure: 6, corrected: 1, costUsd: 0.000141 });
    expect(sort.bands.filter(one => one.of > 0)).toEqual([{ from: 90, to: 100, right: 1, of: 2 }, { from: 70, to: 80, right: 5, of: 6 }]);
    // 5 of 6 isn't 90%: no suggestion to trust it more yet.
    expect(sort.suggestion).toBeNull();
  });
});

describe("schema v85", () => {
  test("a v84 database keeps its script and update runs and can then record sorts", () => {
    const file = join(dir, "old.db");
    const old = openStore(file);
    const flow = old.createFlow({ repo: join(dir, "shop"), name: "Old", definitionJson: JSON.stringify(template("blank")), by: "alex" }, T0);
    const card = old.addFlowCard({ flow, title: "Checked", description: null, stage: "inbox", by: "alex" }, T0);
    old.close();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF; DROP TABLE flow_step_run;");
    db.exec(`CREATE TABLE flow_step_run (
  card           INTEGER NOT NULL REFERENCES flow_card(id),
  entry          INTEGER NOT NULL,
  stage          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('check','update')),
  script         TEXT,
  script_version INTEGER,
  state          TEXT NOT NULL CHECK (state IN ('running','passed','failed','waiting')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_at        TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  duration_ms    INTEGER,
  exit_code      INTEGER,
  result         TEXT,
  log            TEXT,
  PRIMARY KEY (card, entry)
);
CREATE INDEX IF NOT EXISTS flow_step_run_recent ON flow_step_run (started_at);`);
    db.prepare("INSERT INTO flow_step_run (card, entry, stage, kind, script, script_version, state, attempts, started_at, finished_at, exit_code, result, log) VALUES (?, 1, 'check', 'check', 'lint', 2, 'passed', 1, ?, ?, 0, 'lint passed on main.', 'ok')").run(card, T0.toISOString(), T0.toISOString());
    db.prepare("UPDATE schema_version SET version = 84").run();
    db.close();
    const upgraded = openStore(file);
    try {
      expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
      expect(upgraded.flowStepRun(card, 1)).toMatchObject({ kind: "check", script: "lint", scriptVersion: 2, state: "passed", result: "lint passed on main.", log: "ok", decisionJson: null });
      expect(upgraded.claimFlowStep({ card, entry: 2, stage: "sort", kind: "sort", script: null, scriptVersion: null }, T0)).toBe(true);
      upgraded.finishFlowStep(card, 2, { state: "passed", result: "Bug, 90% sure.", decisionJson: "{}" }, T0);
      expect(upgraded.flowStepRun(card, 2)).toMatchObject({ kind: "sort", decisionJson: "{}" });
      expect(upgraded.handle.prepare("SELECT name FROM sqlite_master WHERE name = 'flow_step_run_recent'").get()).toBeDefined();
    } finally { upgraded.close(); }
  });
});
