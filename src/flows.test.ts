/**
 * Flows: a canvas of zones that cards move through. The drawing is checked
 * whole; the engine files work through the ordinary task door, follows the
 * task's state, pages the person who decides, posts messages, and records
 * every move — against a real store.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { FLOW_TEMPLATES, fillFlowText, flowDigest, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import { advanceFlows, decideFlowCard } from "./flow-engine.js";

const T0 = new Date("2026-09-24T09:00:00.000Z");
const coding = (): FlowDefinition => structuredClone(FLOW_TEMPLATES.find(one => one.id === "coding")!.definition);

describe("the flow drawing", () => {
  test("templates are valid; broken paths, missing instructions and a done zone that leads on are refused in words", () => {
    for (const template of FLOW_TEMPLATES) expect(validateFlowDefinition(template.definition)).toEqual(template.definition);
    const broken = coding();
    broken.stages[0]!.next = "nowhere";
    expect(() => validateFlowDefinition(broken)).toThrow("Zone Inbox points at a zone that no longer exists.");
    const vague = coding();
    vague.stages.find(one => one.id === "build")!.instructions = "  ";
    expect(() => validateFlowDefinition(vague)).toThrow("Zone Build: say what the agent should do.");
    const endless = coding();
    endless.stages.find(one => one.id === "done")!.next = "inbox";
    expect(() => validateFlowDefinition(endless)).toThrow("Zone Done is the end; it can't lead anywhere.");
    const twins = coding();
    twins.stages[1]!.id = "inbox";
    expect(() => validateFlowDefinition(twins)).toThrow("Two zones are called inbox.");
    // Moving a zone on the canvas doesn't change what the flow does.
    const moved = coding();
    moved.stages[2]!.zone = { ...moved.stages[2]!.zone, x: 5000, y: 900 };
    expect(flowDigest(moved)).toBe(flowDigest(coding()));
    expect(fillFlowText("Do {{card.title}}. Notes: {{stage.triage}} Change: {{note}} {{stage.missing}}", { title: "dark mode", description: null, note: "bigger", outputs: { triage: "small" } })).toBe("Do dark mode. Notes: small Change: bigger");
  });
});

describe("the flow engine", () => {
  let dir: string;
  let repo: string;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flows-")));
    repo = join(dir, "app");
    mkdirSync(repo);
    store = openStore(join(dir, "orders.db"));
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
    if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const flowWith = (definition: FlowDefinition) => store.createFlow({ repo, name: "Bug fixes", definitionJson: JSON.stringify(definition), by: "alex" }, T0);
  const card = (id: number) => store.getFlowCard(id)!;

  test("a card goes the whole coding flow: triage report, a person's go-ahead, the build as a task, review, the team told, done", () => {
    const flow = flowWith(coding());
    const id = store.addFlowCard({ flow, title: "Dark mode toggle", description: "Add it to settings", stage: "inbox", by: "alex" }, T0);
    // Inbox waits for a person.
    expect(advanceFlows(store, repo, T0)).toEqual({ moved: 0, filed: [], problems: [] });
    store.moveFlowCard(id, { to: "triage", outcome: "moved", actor: "alex" }, T0);
    const triage = advanceFlows(store, repo, T0);
    expect(triage.filed).toHaveLength(1);
    const report = card(id).task!;
    expect(store.getTask(report)?.title).toBe("Triage: Dark mode toggle");
    expect(store.lookupRef(report)?.deliverable).toBe("report");
    expect(store.getScope(report)?.goal).toContain("Request: Dark mode toggle\nAdd it to settings");
    // Still working: the card says what the task waits on.
    advanceFlows(store, repo, T0);
    expect(card(id).waiting).not.toBeNull();
    // The report is ready: on to the go-ahead, which pages whoever decides.
    store.setTaskState(report, "done", T0);
    expect(advanceFlows(store, repo, T0).moved).toBe(1);
    expect(card(id)).toMatchObject({ stage: "go-ahead", task: null, outputs: { triage: "The report is ready on its task." } });
    advanceFlows(store, repo, T0);
    // The template's decisions go to the flow's owner: whoever made it.
    expect(card(id).waiting).toBe("Waiting for alex to approve or send it back");
    expect(store.listNotifications("pending").filter(one => one.kind === "flow-decision").map(one => [one.subject, one.recipient])).toEqual([["Bug fixes: Dark mode toggle needs alex's decision", "alex"]]);
    // A decision from outside the project is refused; the approver's moves it on.
    expect(decideFlowCard(store, { card: id, decision: "approve", note: null, actor: "alex", repos: [] }, T0)).toEqual({ ok: false, message: "That card is no longer waiting." });
    expect(decideFlowCard(store, { card: id, decision: "approve", note: null, actor: "alex", repos: [repo] }, T0)).toEqual({ ok: true, said: "Approved. Moved to Build." });
    advanceFlows(store, repo, T0);
    const build = card(id).task!;
    expect(card(id).primaryTask).toBe(build);
    expect(store.getTask(build)?.title).toBe("Dark mode toggle");
    expect(store.getScope(build)?.goal).toContain("Triage notes:\nThe report is ready on its task.");
    store.setTaskState(build, "done", T0);
    advanceFlows(store, repo, T0);
    expect(card(id).stage).toBe("review");
    // Sent back without a finished result to revise: back to Build carrying the note, which the new work reads.
    expect(decideFlowCard(store, { card: id, decision: "send-back", note: null, actor: "alex", repos: [repo] }, T0)).toEqual({ ok: false, message: "Say what should change." });
    expect(decideFlowCard(store, { card: id, decision: "send-back", note: "Also remember the choice", actor: "alex", repos: [repo] }, T0)).toEqual({ ok: true, said: "Sent back to Build with your note." });
    advanceFlows(store, repo, T0);
    const again = card(id).task!;
    expect(again).not.toBe(build);
    expect(store.getScope(again)?.goal).toContain("Requested changes (if any): Also remember the choice");
    store.setTaskState(again, "done", T0);
    advanceFlows(store, repo, T0);
    decideFlowCard(store, { card: id, decision: "approve", note: "Looks good", actor: "alex", repos: [repo] }, T0);
    // Tell the team: a message through the outbox, then done.
    advanceFlows(store, repo, T0);
    expect(store.listNotifications("pending").filter(one => one.kind === "flow-message").map(one => one.subject)).toEqual(["Bug fixes: Shipped: Dark mode toggle"]);
    advanceFlows(store, repo, T0);
    expect(card(id)).toMatchObject({ stage: "done", state: "done" });
    expect(store.flowEvents(id).map(one => [one.outcome, one.toStage])).toEqual([
      ["created", "inbox"], ["moved", "triage"], ["ok", "go-ahead"], ["approved", "build"], ["ok", "review"],
      ["sent-back", "build"], ["ok", "review"], ["approved", "announce"], ["ok", "done"],
    ]);
  });

  test("a named decider, a failed task with and without a failure path, and a card in a removed zone", () => {
    const definition = coding();
    const ahead = definition.stages.find(one => one.id === "go-ahead")!;
    ahead.approver = "sam";
    ahead.toOwner = false;
    definition.stages.find(one => one.id === "build")!.onFail = "inbox";
    const flow = flowWith(definition);
    const id = store.addFlowCard({ flow, title: "Fix login", description: null, stage: "go-ahead", by: "alex" }, T0);
    advanceFlows(store, repo, T0);
    expect(card(id).waiting).toBe("Waiting for sam to approve or send it back");
    expect(decideFlowCard(store, { card: id, decision: "approve", note: null, actor: "alex", repos: [repo] }, T0)).toEqual({ ok: false, message: "Only sam decides here." });
    // A build that fails takes the failure path, saying why.
    store.moveFlowCard(id, { to: "build", outcome: "moved", actor: "alex" }, T0);
    advanceFlows(store, repo, T0);
    store.setTaskState(card(id).task!, "failed", T0);
    advanceFlows(store, repo, T0);
    expect(card(id)).toMatchObject({ stage: "inbox", note: "The build failed." });
    // Without one, the card waits and says so.
    const plain = flowWith(coding());
    const other = store.addFlowCard({ flow: plain, title: "Other", description: null, stage: "build", by: "alex" }, T0);
    advanceFlows(store, repo, T0);
    store.setTaskState(card(other).task!, "failed", T0);
    advanceFlows(store, repo, T0);
    expect(card(other)).toMatchObject({ stage: "build", waiting: "The task failed. Retry it, or move the card." });
    // A zone removed while a card sat in it: the card goes back to the start.
    const trimmed = coding();
    trimmed.stages = trimmed.stages.filter(one => one.id !== "triage").map(one => ({ ...one, next: one.next === "triage" ? "go-ahead" : one.next }));
    const lonely = store.addFlowCard({ flow: plain, title: "Lonely", description: null, stage: "triage", by: "alex" }, T0);
    expect(store.saveFlow(plain, { name: "Bug fixes", definitionJson: JSON.stringify(trimmed), sawRevision: 1, by: "alex" }, T0)).toBe(true);
    expect(store.saveFlow(plain, { name: "Bug fixes", definitionJson: JSON.stringify(trimmed), sawRevision: 1, by: "alex" }, T0)).toBe(false);
    advanceFlows(store, repo, T0);
    expect(card(lonely).stage).toBe("inbox");
  });
});
