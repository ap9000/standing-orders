/**
 * A flow never fails to file its work because a step's output is long: the goal keeps the zone's words whole and
 * cuts only the filled-in values, the agent is given them in full, instructions that can't fit are refused when the
 * flow is saved, and a card that couldn't file tries again once the cause is gone.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { FLOW_CUT, FLOW_GOAL_LIMIT, fitFlowText, flowFromSteps, validateFlowDefinition } from "./flows.js";
import { advanceFlows, flowGoalCuts } from "./flow-engine.js";

let dir: string, repo: string, store: Store;
const now = new Date("2026-09-30T23:00:00Z");
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "flow-goal-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "operator", now).ok) throw Error("account");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const ASK = "Read tonight's journey results and write up what broke, with the likeliest cause for each failure.\n\nResults:\n{{stage.nightly-journeys}}";
const drawing = (instructions: string) => ({ version: 1, start: "nightly-journeys", stages: [
  { id: "nightly-journeys", title: "Nightly journeys", kind: "inbox", next: "research" },
  { id: "research", title: "Research", kind: "report", instructions, next: "done" },
  { id: "done", title: "Done", kind: "done" },
] });
/** A script's output: 20,000 characters, with a recognisable start and end. */
const output = `START journeys run 2026-09-30\r\n${Array.from({ length: 400 }, (_, i) => `journey ${i}: checkout ${i % 7 === 0 ? "FAILED" : "ok"}`).join("\n")}`.padEnd(19_976, ".") + "\nEND 57 passed, 3 failed";

function cardInResearch(flow: number): number {
  const card = store.addFlowCard({ flow, title: "Nightly journeys, 30 September", description: null, stage: "research", by: "operator" }, now);
  store.updateFlowCard(card, { outputs: { "nightly-journeys": output } }, now);
  return card;
}

test("a 20,000-character script result files a goal under 2000 characters with its start and end kept, and the agent gets it whole", () => {
  expect(output.length).toBe(20_000);
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(ASK))), by: "operator" }, now);
  const card = cardInResearch(flow);
  expect(advanceFlows(store, repo, now).filed).toHaveLength(1);
  const filed = store.getFlowCard(card)!;
  expect(filed.waiting).toBe("Filed as a task");
  const goal = store.getScope(filed.task!)!.goal;
  expect(goal.length).toBeLessThan(FLOW_GOAL_LIMIT);
  expect(goal.length).toBeGreaterThan(FLOW_GOAL_LIMIT - 60); // the room is used, not wasted
  // The zone's own words whole; the value's start and end, the cut mark between.
  expect(goal.startsWith("Read tonight's journey results and write up what broke, with the likeliest cause for each failure.\n\nResults:\nSTART journeys run 2026-09-30\njourney 0")).toBe(true);
  expect(goal.endsWith("...\nEND 57 passed, 3 failed\n\nThe card: Nightly journeys, 30 September")).toBe(true);
  expect(goal.split(FLOW_CUT)).toHaveLength(2);
  // The research agent is given the untrimmed result (fenced as untrusted by the brief).
  expect(flowGoalCuts(store, filed.task!, goal)).toEqual([{ label: "What Nightly journeys found", text: output }]);
});

test("only the long values are cut: short ones and the instructions stay whole, and a goal that fits is untouched", () => {
  const card = { title: "Checkout rounding", description: "Totals are off by a cent", note: null, outputs: { a: "x".repeat(5000), b: "short notes" } };
  const goal = fitFlowText("Fix {{card.title}}.\n{{card.description}}\n{{stage.a}}\n{{stage.b}}\nKeep the tests.", card)!;
  expect(goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
  expect(goal).toMatch(/^Fix Checkout rounding\.\nTotals are off by a cent\nx+… \(cut; the full text is on the card\)x+\nshort notes\nKeep the tests\.$/);
  expect(fitFlowText("Fix {{card.title}}.", card)).toBe("Fix Checkout rounding.");
});

test("instructions that can't fit are refused when the flow is saved, not when a card arrives", () => {
  const long = `Investigate this carefully. ${"Check every page and every form. ".repeat(60)}\n\n{{stage.nightly-journeys}}`;
  expect(() => validateFlowDefinition(drawing(long))).toThrow(/^Zone Research: its instructions leave no room for the card's details\. Shorten them by \d+ characters\.$/);
  expect(() => flowFromSteps([{ title: "Research", kind: "report", instructions: long }], null)).toThrow("Zone Research: its instructions leave no room");
  // Just under the line is accepted, and every card it files then fits.
  const fits = validateFlowDefinition(drawing(`${"a".repeat(1650)}\n{{stage.nightly-journeys}}`));
  expect(fitFlowText(`${fits.stages[1]!.instructions}\n\nThe card: {{card.title}}\n\n{{card.description}}\n\nChanges asked for: {{note}}`,
    { title: "t".repeat(200), description: "d".repeat(2000), note: "n".repeat(2000), outputs: { "nightly-journeys": output } })!.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
  // A flow saved before the rule is still read.
  expect(validateFlowDefinition(drawing(long), { stored: true }).stages[1]!.instructions).toBe(long);
});

test("a card that couldn't file its work says why, and files on a later pass once the cause is gone", () => {
  const long = `Investigate this carefully. ${"Check every page and every form. ".repeat(60)}\n\n{{stage.nightly-journeys}}`;
  // Saved before the rule: its instructions alone are over the limit.
  const flow = store.createFlow({ repo, name: "Nightly journeys", definitionJson: JSON.stringify(drawing(long)), by: "operator" }, now);
  const card = cardInResearch(flow);
  expect(advanceFlows(store, repo, now).filed).toEqual([]);
  const stuck = store.getFlowCard(card)!;
  expect(stuck.task).toBeNull();
  expect(stuck.waiting).toBe("Couldn't file the work: Research's instructions are too long for a task. Open the flow and shorten them. It tries again on the next pass.");
  // Still stuck on the next pass, without churn.
  advanceFlows(store, repo, new Date(now.getTime() + 60_000));
  expect(store.getFlowCard(card)).toMatchObject({ task: null, updatedAt: stuck.updatedAt });
  // Someone shortens the zone; the next pass files the work.
  expect(store.saveFlow(flow, { name: "Nightly journeys", definitionJson: JSON.stringify(validateFlowDefinition(drawing(ASK))), sawRevision: 1, by: "operator" }, now)).toBe(true);
  const later = new Date(now.getTime() + 120_000);
  expect(advanceFlows(store, repo, later).filed).toHaveLength(1);
  const filed = store.getFlowCard(card)!;
  expect(filed.waiting).toBe("Filed as a task");
  expect(store.getScope(filed.task!)!.goal.length).toBeLessThanOrEqual(FLOW_GOAL_LIMIT);
});
