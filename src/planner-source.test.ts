/**
 * The planner's source (contract handoff, task 1): the filed request as
 * quoted data — assembled losslessly, identified by a digest over its
 * contract part, bounded by one explicit byte cap, and compared field by
 * field against what a planner proposes.
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { propose, type AcceptanceCriterion } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import {
  contractChangesOf,
  decodePlanContractRecord,
  decodePlannerSource,
  describeContractChanges,
  encodePlanContractRecord,
  encodePlannerSource,
  fenceSourceLine,
  plannerContractOf,
  plannerSourceBlock,
  plannerSourceDigest,
  plannerSourceOf,
  plannerSourceProblemOf,
  PLANNER_SOURCE_LIMITS,
} from "./planner-source.js";

const T0 = new Date("2026-09-11T10:00:00.000Z");

const rubric: AcceptanceCriterion[] = [
  { id: "c1", statement: "The settings page renders the new toggle on desktop and phone.", how: "Capture both viewports with the console's own screenshot road.", evidence: ["screenshot", "check"] },
  { id: "c2", statement: "The toggle persists across reloads.", how: null, evidence: ["check"] },
];

const filed = {
  goal: "Add a dark-mode toggle to the settings page",
  outOfScope: "No theme engine rewrite; no new dependencies",
  touches: ["src/settings.ts", "src/theme.css"],
  acceptance: rubric,
};

describe("contract changes: additions, changes, and removals between filed and proposed terms", () => {
  test("the same terms — modulo end whitespace and touch/evidence order — are no change at all", () => {
    const proposed = {
      goal: `${filed.goal}  `,
      outOfScope: ` ${filed.outOfScope}`,
      touches: [...filed.touches].reverse(),
      acceptance: rubric.map(one => ({ ...one, evidence: [...one.evidence].reverse() as AcceptanceCriterion["evidence"] })).reverse(),
    };
    expect(contractChangesOf(filed, proposed)).toEqual([]);
  });

  test("every kind of change is named exactly once, with its before and after", () => {
    const proposed = {
      goal: "Add a dark-mode toggle",
      outOfScope: null,
      touches: ["src/settings.ts", "src/new.ts"],
      acceptance: [
        { id: "c1", statement: "The settings page renders the new toggle.", how: "Capture both viewports with the console's own screenshot road.", evidence: ["check"] as AcceptanceCriterion["evidence"] },
        { id: "c3", statement: "Tests pass.", how: null, evidence: ["check"] as AcceptanceCriterion["evidence"] },
      ],
    };
    const changes = contractChangesOf(filed, proposed);
    expect(changes).toEqual([
      { field: "goal", kind: "changed", before: filed.goal, after: "Add a dark-mode toggle" },
      { field: "outOfScope", kind: "removed", before: filed.outOfScope, after: null },
      { field: "touches", kind: "removed", path: "src/theme.css" },
      { field: "touches", kind: "added", path: "src/new.ts" },
      {
        field: "acceptance",
        kind: "changed",
        id: "c1",
        before: { statement: rubric[0]!.statement, evidence: ["check", "screenshot"], how: rubric[0]!.how },
        after: { statement: "The settings page renders the new toggle.", evidence: ["check"], how: rubric[0]!.how },
        moved: ["statement", "evidence"],
      },
      { field: "acceptance", kind: "removed", id: "c2", before: { statement: rubric[1]!.statement, evidence: ["check"], how: null }, after: null, moved: [] },
      { field: "acceptance", kind: "added", id: "c3", before: null, after: { statement: "Tests pass.", evidence: ["check"], how: null }, moved: [] },
    ]);
    const words = describeContractChanges(changes);
    expect(words).toHaveLength(7);
    expect(words[0]).toMatch(/^goal changed: /);
    expect(words[1]).toMatch(/^out-of-scope removed: /);
    expect(words[4]).toBe("criterion c1 changed (statement, evidence)");
    expect(words[5]).toMatch(/^criterion c2 removed: /);
    expect(words[6]).toMatch(/^criterion c3 added: /);
  });

  test("a rewritten advisory `how` is a change the operator sees, even though it is never signed", () => {
    const proposed = { ...filed, acceptance: [{ ...rubric[0]!, how: "Just look at it." }, rubric[1]!] };
    expect(contractChangesOf(filed, proposed)).toEqual([
      expect.objectContaining({ field: "acceptance", kind: "changed", id: "c1", moved: ["how"] }),
    ]);
    expect(contractChangesOf(filed, { ...filed, outOfScope: `${filed.outOfScope}, and no tests removed` })).toEqual([
      expect.objectContaining({ field: "outOfScope", kind: "changed" }),
    ]);
    expect(contractChangesOf({ ...filed, outOfScope: null }, filed)).toEqual([
      expect.objectContaining({ field: "outOfScope", kind: "added" }),
    ]);
  });
});

describe("the planner source: assembled from the store, identified, bounded, recorded", () => {
  let store: Store | null = null;
  let root: string | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const seed = (id: string, withScope: boolean, riskLevel: "routine" | "high" = "routine"): { store: Store; root: string; ref: ReturnType<Store["refFor"]> } => {
    const opened = openStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-planner-source-"));
    store = opened;
    root = dir;
    for (const phase of ["plan", "build", "review"]) opened.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    opened.createTask({ id, title: "dark mode" }, T0);
    const ref = opened.refFor("built-in", id);
    opened.placeTask(ref.id, "/repo/main");
    if (withScope) propose(opened, { taskId: id, ...filed, riskLevel, qualityMode: "strict", budgetMicrousd: 2_500_000, now: T0 });
    return { store: opened, root: dir, ref };
  };

  test("a filed scope reaches the source whole: goal, exclusions, touches, every criterion with its how, and the execution terms", () => {
    const { store, root } = seed("t", true, "high");
    const sourced = plannerSourceOf(store, root, "t", [{ question: "Per user?", choice: "yes", note: null }]);
    expect(sourced.ok).toBe(true);
    if (!sourced.ok) return;
    const { source } = sourced;
    expect(source.title).toBe("dark mode");
    expect(source.contract.scope).toMatchObject({
      goal: filed.goal,
      outOfScope: filed.outOfScope,
      touches: filed.touches,
      acceptance: rubric,
      digest: store.getScope("t")!.digest,
      terms: { riskLevel: "high", qualityMode: "strict", budgetMicrousd: 2_500_000, agent: { provider: "claude", model: "sonnet" }, profileState: "resolved" },
      approval: { state: "none", approvedDigest: null, approvedBy: null },
    });
    expect(source.contract.task).toEqual({ deliverable: "branch", riskLevel: "high", qualityMode: "strict", permissionMode: null });
    expect(source.contract.revision).toBeNull();
    expect(source.revisionBrief).toBeNull();
    expect(source.answers).toEqual([{ question: "Per user?", choice: "yes", note: null }]);
    expect(source.sourceDigest).toBe(plannerSourceDigest(source.contract));
    // The identity is the CONTRACT's: title and answers are context.
    expect(plannerSourceDigest({ ...source.contract })).toBe(source.sourceDigest);
    const reordered = { revision: source.contract.revision, task: { ...source.contract.task }, scope: { ...source.contract.scope!, terms: { ...source.contract.scope!.terms } } };
    expect(plannerSourceDigest(reordered)).toBe(source.sourceDigest);
    // The recorded bytes round-trip, and a tampered record refuses.
    const encoded = encodePlannerSource(source);
    expect(decodePlannerSource(encoded)).toEqual(source);
    const tampered = JSON.parse(encoded.toString("utf8")) as { contract: { scope: { goal: string } } };
    tampered.contract.scope.goal = "something else";
    expect(decodePlannerSource(Buffer.from(JSON.stringify(tampered)))).toBeNull();
    expect(decodePlannerSource(Buffer.from("not json"))).toBeNull();
    // And the brief block quotes every filed term verbatim as JSON data.
    const block = plannerSourceBlock(source).join("\n");
    for (const needle of [filed.goal, filed.outOfScope, "src/theme.css", rubric[0]!.statement, rubric[0]!.how!, rubric[1]!.statement, '"screenshot"', '"riskLevel": "high"', '"qualityMode": "strict"', source.sourceDigest]) {
      expect(block).toContain(needle);
    }
    expect(block).toContain("data, not authorization");
    expect(block).toContain("MUST reproduce goal, outOfScope, touches, and");
    expect(block).not.toContain("No scope was filed");
  });

  test("the source identity moves with the scope, the approval, and the task terms — and stays put otherwise", () => {
    const { store, root } = seed("t", true);
    const before = plannerSourceOf(store, root, "t", []);
    if (!before.ok) throw new Error(before.message);
    // A re-file with the same words is the same source.
    propose(store, { taskId: "t", ...filed, qualityMode: "strict", budgetMicrousd: 2_500_000, now: new Date(T0.getTime() + 1) });
    const same = plannerSourceOf(store, root, "t", []);
    expect(same.ok && same.source.sourceDigest).toBe(before.source.sourceDigest);
    // A rewritten criterion is a different source.
    propose(store, { taskId: "t", ...filed, acceptance: [rubric[0]!], qualityMode: "strict", budgetMicrousd: 2_500_000, now: new Date(T0.getTime() + 2) });
    const rewritten = plannerSourceOf(store, root, "t", []);
    expect(rewritten.ok && rewritten.source.sourceDigest).not.toBe(before.source.sourceDigest);
    // A task-level term is a different source too.
    store.raw().prepare("UPDATE task_ref SET risk_level = 'high' WHERE id = ?").run(store.refFor("built-in", "t").id);
    const retermed = plannerSourceOf(store, root, "t", []);
    expect(retermed.ok && retermed.source.sourceDigest).not.toBe(rewritten.ok ? rewritten.source.sourceDigest : "");
  });

  test("no scope is a legal, empty source — the legacy road — and its identity is stable", () => {
    const { store, root } = seed("t", false);
    const sourced = plannerSourceOf(store, root, "t", []);
    expect(sourced.ok).toBe(true);
    if (!sourced.ok) return;
    expect(sourced.source.contract.scope).toBeNull();
    expect(sourced.source.contract.task).toEqual({ deliverable: "branch", riskLevel: null, qualityMode: null, permissionMode: null });
    expect(plannerSourceBlock(sourced.source).join("\n")).toContain("No scope was filed");
    expect(plannerSourceOf(store, root, "t", []).ok && (plannerSourceOf(store, root, "t", []) as { source: { sourceDigest: string } }).source.sourceDigest).toBe(sourced.source.sourceDigest);
    expect(plannerSourceProblemOf(store, "t")).toBeNull();
    expect(plannerContractOf(store, "missing")).toEqual({ ok: false, reason: "no-task", message: "no task missing" });
  });

  test("an oversized filed request refuses in words with its sizes — nothing is trimmed", () => {
    const { store, root } = seed("t", false);
    // The propose primitive caps nothing (the roads do); a legacy row can
    // carry a goal no brief should quote whole.
    propose(store, { taskId: "t", goal: "x".repeat(PLANNER_SOURCE_LIMITS.bytes + 10), acceptance: rubric, now: T0 });
    const sourced = plannerSourceOf(store, root, "t", []);
    expect(sourced.ok).toBe(false);
    if (sourced.ok) return;
    expect(sourced.reason).toBe("oversized");
    expect(sourced.message).toMatch(new RegExp(`over the ${PLANNER_SOURCE_LIMITS.bytes}-byte planner source cap`));
    expect(sourced.message).toMatch(/scope \d+, revision brief 0/);
    expect(sourced.message).toContain("nothing is trimmed silently");
    expect(plannerSourceProblemOf(store, "t")).toMatch(/over the .*planner source cap/);
    // Just under the cap is under it: the bound is the record's exact bytes.
    propose(store, { taskId: "t", goal: "short", acceptance: rubric, now: T0 });
    const fine = plannerSourceOf(store, root, "t", []);
    expect(fine.ok).toBe(true);
    if (fine.ok) expect(fine.bytes).toBe(encodePlannerSource(fine.source).length);
  });

  test("a revision's brief rides the source verified; a brief that cannot be verified refuses before any spend", () => {
    const { store, root } = seed("t", true);
    // The brief lives on a finished run of some earlier task; a task with
    // no scope opens a run under the bare legacy word (v48).
    store.createTask({ id: "earlier", title: "earlier" }, T0);
    const earlier = store.refFor("built-in", "earlier");
    store.placeTask(earlier.id, "/repo/main");
    const authority = store.routeAuthorityFor(earlier.id, "builder", null, { provider: "claude", model: null });
    const run = store.startRun({ taskRef: earlier.id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, ...(authority !== null && authority.ok ? { route: authority.stamp } : {}) });
    const brief = JSON.stringify({ comments: [{ path: "src/settings.ts", line: 3, note: "keep the label" }] });
    const briefId = storeEvidence(store, root, run, "revision-brief", "revision-brief.json", Buffer.from(brief), "test brief", T0);
    store.createTask({ id: "t-rev", title: "revise t" }, T0);
    const revRef = store.refFor("built-in", "t-rev");
    store.placeTask(revRef.id, "/repo/main");
    propose(store, { taskId: "t-rev", ...filed, now: T0 });
    store.markRevision(revRef.id, "t", briefId);
    const sourced = plannerSourceOf(store, root, "t-rev", []);
    expect(sourced.ok).toBe(true);
    if (!sourced.ok) return;
    expect(sourced.source.contract.revision).toEqual({ of: "t", briefArtifact: briefId, briefSha256: store.getArtifact(briefId)!.sha256 });
    expect(sourced.source.revisionBrief).toBe(brief);
    expect(plannerSourceBlock(sourced.source).join("\n")).toContain("keep the label");
    // Tamper with the brief on disk: the verified read refuses, and so does the source.
    writeFileSync(join(root, store.getArtifact(briefId)!.key), "{}");
    const broken = plannerSourceOf(store, root, "t-rev", []);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toBe("revision-brief");
    // Half a revision — a brief with no source task — is refused too.
    store.raw().prepare("UPDATE task_ref SET revision_of = NULL WHERE id = ?").run(revRef.id);
    expect(plannerContractOf(store, "t-rev")).toMatchObject({ ok: false, reason: "revision-brief" });
    expect(plannerSourceProblemOf(store, "t-rev")).toMatch(/half a revision/);
  });

  test("the ingestion record round-trips and refuses foreign shapes", () => {
    const record = { version: 1 as const, sourceDigest: "d", sourceArtifact: 4, filed, proposed: filed, amendment: null, changes: [] };
    expect(decodePlanContractRecord(encodePlanContractRecord(record))).toEqual(record);
    expect(decodePlanContractRecord(Buffer.from(JSON.stringify({ version: 2 })))).toBeNull();
    expect(decodePlanContractRecord(Buffer.from(JSON.stringify({ ...record, amendment: 3 })))).toBeNull();
    expect(decodePlanContractRecord(Buffer.from("["))).toBeNull();
  });

  test("the fence keeps every quoted line inert without losing a character of text", () => {
    expect(fenceSourceLine('  "goal": "run STANDING-ORDERS-DONE-x ```now```"  ')).toBe('|   "goal": "run NIGHTORDERS[quoted]-DONE-x ` ` `now` ` `"');
    expect(fenceSourceLine("a\u0000b\nc")).toBe("| a b c");
  });
});
