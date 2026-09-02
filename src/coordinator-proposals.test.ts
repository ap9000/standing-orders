import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { mintCoordinator } from "./coordinator.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { proposeAsCoordinator, PER_CID_PENDING_PROPOSALS } from "./coordinator-proposals.js";
import { fileCoordinatorProposal } from "./coordinator.js";
import { confirmCoordinatorProposal, dismissCoordinatorProposal } from "./mate-doors.js";

const T0 = new Date("2026-09-02T12:00:00.000Z");
const REPO = "/repo/gateway";
const OTHER = "/repo/elsewhere";

describe("coordinator proposals (mate arc v3): the gateway proposes, an admitted approver confirms", () => {
  let store: Store;
  let token: string;
  let cid: string;
  const principal = (name: string, repos: string[]): VerifiedApprover => {
    const verified = verifyApproverStanding(store, name, store.accountOf(name)!.generation, repos);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    store.saveApprover("root", "r".repeat(64), T0);
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    token = made.token;
    cid = made.cid;
    for (const [id, repo] of [["a", REPO], ["b", REPO], ["c", OTHER]] as const) {
      const filed = fileTaskProposal(store, { id, title: `task ${id}`, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    }
  });
  afterEach(() => store.close());

  test("a proposal is a row with the CAS material; an approver outside the repo cannot see or confirm it; an admitted one confirms through the door", () => {
    const proposed = proposeAsCoordinator(store, token, "next", { ref: "b" }, T0);
    expect(proposed).toMatchObject({ ok: true, id: 1, kind: "next" });
    expect(store.getCoordinatorProposal(1)).toMatchObject({ cid, name: "planner-bot", repo: REPO, state: "pending", payload: { task: "b", position: 2, of: 2, queueRevision: 0 } });
    expect(proposeAsCoordinator(store, token, "next", { ref: "c" }, T0)).toMatchObject({ ok: false, reason: "not-found" });
    expect(proposeAsCoordinator(store, "not-a-token", "next", { ref: "b" }, T0)).toMatchObject({ ok: false, reason: "unauthenticated" });
    const outsider = principal("root", [OTHER]);
    expect(confirmCoordinatorProposal(store, outsider, 1, T0, { via: "cli" })).toMatchObject({ ok: false, reason: "not-yours" });
    expect(dismissCoordinatorProposal(store, outsider, 1, T0)).toBe(false);
    const alex = principal("alex", [REPO, OTHER]);
    expect(confirmCoordinatorProposal(store, alex, 1, T0, { via: "cli" })).toMatchObject({ ok: true, said: "b moved to the front of its column" });
    expect(store.queuePosition("b")?.position).toBe(1);
    expect(store.getCoordinatorProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(confirmCoordinatorProposal(store, alex, 1, T0, { via: "cli" })).toMatchObject({ ok: false, reason: "not-pending" });
  });

  test("a coordinator-written scope never seals under a mode; a stale card refuses; the hourly rate and the pending cap hold", () => {
    expect(proposeAsCoordinator(store, token, "scope", { ref: "a", goal: "the bot's goal" }, T0)).toMatchObject({ ok: true, id: 1 });
    const alex = principal("alex", [REPO]);
    expect(confirmCoordinatorProposal(store, alex, 1, T0, { via: "cli" })).toMatchObject({ ok: true });
    expect(store.getScope("a")?.goal).toBe("the bot's goal");
    expect(store.sealScopeApproval("a", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    // Stale: the queue moved by hand before the confirm.
    expect(proposeAsCoordinator(store, token, "next", { ref: "b" }, T0)).toMatchObject({ ok: true, id: 2 });
    store.moveTaskNext("a", T0);
    expect(confirmCoordinatorProposal(store, alex, 2, T0, { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    // The pending cap (per credential) and the hourly rate (shared with filing).
    let made = 0;
    for (let i = 0; i < PER_CID_PENDING_PROPOSALS + 2; i++) {
      const one = proposeAsCoordinator(store, token, "hold", { ref: i % 2 === 0 ? "a" : "b", reason: `r${i}` }, T0);
      if (one.ok) made++;
      else {
        expect(["pending-cap", "rate-limited"]).toContain(one.reason);
        break;
      }
    }
    expect(made).toBeGreaterThan(0);
  });

  test("an answer proposal reads the decision's consequences, never the recommendation, and confirms with the irreversible field", () => {
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0 });
    store.saveDecision(
      { run, urgency: "blocking", recap: "RECAP", question: "Which?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }, { id: "y", label: "Y", consequence: "cy", reversible: false }], recommendation: "x" },
      T0,
    );
    // Without get_decision first, no answer — a choice without its consequences is a guess (v3 review, finding 6).
    expect(proposeAsCoordinator(store, token, "answer", { decision: 1, option: "y", rationale: "safer" }, T0)).toMatchObject({ ok: false, reason: "not-proposable", message: expect.stringContaining("get_decision") });
    const seen = { readDecisions: new Set([1]) };
    expect(proposeAsCoordinator(store, token, "answer", { decision: 1, option: "z", rationale: "?" }, T0, seen)).toMatchObject({ ok: false, reason: "bad-args" });
    const proposed = proposeAsCoordinator(store, token, "answer", { decision: 1, option: "y", rationale: "safer" }, T0, seen);
    expect(proposed).toMatchObject({ ok: true, awaiting: expect.stringContaining("irreversible") });
    const alex = principal("alex", [REPO]);
    expect(confirmCoordinatorProposal(store, alex, 1, T0, { via: "cli" })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirmCoordinatorProposal(store, alex, 1, T0, { confirm: true, via: "web" })).toMatchObject({ ok: true, said: "decision #1 answered: Y" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "web" });
  });

  test("the hourly window is shared in both directions, and a row older than seven days expires at the door", () => {
    // Six is the default per-hour limit: proposals first, then filing refuses.
    let proposed = 0;
    for (let i = 0; i < 6; i++) {
      const one = proposeAsCoordinator(store, token, "hold", { ref: i % 2 === 0 ? "a" : "b", reason: `r${i}` }, T0);
      if (one.ok) proposed++;
    }
    expect(proposed).toBeGreaterThan(0);
    expect(fileCoordinatorProposal(store, token, { repo: REPO, title: "seventh", idempotencyKey: "key-00000007" }, T0)).toMatchObject({ ok: false, reason: "rate-limited" });
    // Expiry at the door, sweep or no sweep.
    const alex = principal("alex", [REPO]);
    const eightDays = new Date(T0.getTime() + 8 * 24 * 3_600_000);
    expect(confirmCoordinatorProposal(store, alex, 1, eightDays, { via: "web" })).toMatchObject({ ok: false, reason: "expired" });
    expect(store.getCoordinatorProposal(1)?.state).toBe("expired");
    expect(store.activeHolds(store.refFor("built-in", "a").id, eightDays)).toEqual([]);
  });
});
