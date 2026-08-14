import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { buildDataDocument } from "./converse.js";
import { fileTaskProposal, fileRoutineProposal } from "./proposal.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");
const INSIDE = "/repo/inside";
const OUTSIDE = "/repo/outside-SECRET-PATH";

describe("the chat snapshot", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  const seed = () => {
    const mk = (id: string, repo: string, title = `work ${id}`) => {
      const made = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    };
    mk("in-1", INSIDE, "tighten the payout guard");
    mk("in-2", INSIDE);
    mk("out-1", OUTSIDE, "the confidential acquisition plan");
    // A repo-null task: excluded from chat entirely.
    const madeNull = fileTaskProposal(store, { id: "unplaced-1", title: "floating work" }, T0);
    if (!madeNull.ok) throw new Error(madeNull.reason);
    // A decision inside and one outside.
    const run = (task: string, lease: string) =>
      store.startRun({
        taskRef: store.refFor("built-in", task).id,
        leaseId: lease,
        runner: "runner-1",
        branch: `standing-orders/${task}`,
        worktree: `/pool/${task}`,
        now: T0,
      });
    const inRun = run("in-1", "l-in");
    store.saveDecision(
      {
        run: inRun,
        urgency: "blocking",
        recap: "SENSITIVE-RECAP-CANARY must never reach the model",
        question: "Fail open or closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "CONSEQUENCE-CANARY", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "CONSEQUENCE-CANARY-2", reversible: true },
        ],
        recommendation: "closed",
      },
      T0,
    );
    const outRun = run("out-1", "l-out");
    store.saveDecision(
      {
        run: outRun,
        urgency: "blocking",
        recap: "outside recap",
        question: "OUTSIDE-QUESTION-CANARY?",
        options: [{ id: "a", label: "OUTSIDE-LABEL-CANARY", consequence: "x", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    const routine = fileRoutineProposal(
      store,
      {
        name: "nightly-deps",
        repo: INSIDE,
        goal: "refresh",
        outOfScope: null,
        touches: [],
        requirements: [],
        schedule: "daily:03:30",
        costCeilingUsd: null,
        filedVia: "cli",
      },
      T0,
    );
    if (!routine.ok) throw new Error(routine.reason);
  };

  test("an empty admission list is refused, not defaulted", () => {
    expect(() => store.chatSnapshot([], T0)).toThrow(/non-empty/);
  });

  test("admission binds every list: outside and repo-null rows do not exist here", () => {
    seed();
    const snapshot = store.chatSnapshot([INSIDE], T0);
    expect(snapshot.tasks.map(one => one.id).sort()).toEqual(["in-1", "in-2"]);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.decisions[0]?.question).toBe("Fail open or closed?");
  });

  test("the serialized document carries opaque ids and NONE of the excluded content", () => {
    seed();
    const snapshot = store.chatSnapshot([INSIDE], T0);
    const { document } = buildDataDocument(snapshot);
    // Opaque repo ids only — no paths, no basenames.
    expect(document).toContain('"id":"r1"');
    expect(document).not.toContain(INSIDE);
    expect(document).not.toContain("inside");
    // Ceiling: nothing from the outside repo, canaried.
    expect(document).not.toContain("OUTSIDE");
    expect(document).not.toContain("SECRET-PATH");
    expect(document).not.toContain("confidential");
    // Decision recap/consequence/recommendation excluded (ruling 4).
    expect(document).not.toContain("SENSITIVE-RECAP-CANARY");
    expect(document).not.toContain("CONSEQUENCE-CANARY");
    expect(document).not.toContain("recommendation");
    // No worktrees, branches, runners, or URLs.
    expect(document).not.toContain("/pool/");
    expect(document).not.toContain("standing-orders/in-1");
    expect(document).not.toContain("runner-1");
    // What IS there: option labels and the operator's own titles.
    expect(document).toContain("Fail open");
    expect(document).toContain("tighten the payout guard");
    expect(document).toContain("nightly-deps");
  });

  test("the byte budget sheds whole items and says so", () => {
    seed();
    for (let i = 0; i < 50; i++) {
      const made = fileTaskProposal(store, { id: `bulk-${i}`, title: `bulk item ${i} ${"x".repeat(150)}`, repo: INSIDE, filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    const snapshot = store.chatSnapshot([INSIDE], T0);
    const { document, shed } = buildDataDocument(snapshot, 4_096);
    expect(Buffer.byteLength(document, "utf8")).toBeLessThanOrEqual(4_096);
    expect(shed).toBeGreaterThan(0);
    expect(JSON.parse(document).shedForSize).toBe(shed);
  });

  test("crowding: 60 outside tasks cannot displace inside rows, because they are not queried at all", () => {
    seed();
    for (let i = 0; i < 60; i++) {
      const made = fileTaskProposal(store, { id: `crowd-${i}`, title: `crowd ${i}`, repo: OUTSIDE, filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    const snapshot = store.chatSnapshot([INSIDE], T0);
    expect(snapshot.tasks.map(one => one.id).sort()).toEqual(["in-1", "in-2"]);
    expect(snapshot.tasksSaturated).toBe(false);
  });
});
