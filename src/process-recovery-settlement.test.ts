import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { currentBootId } from "./boot-identity.js";
import { storeEvidence, storeHandoffArtifact } from "./evidence.js";
import { addApprover, approve, propose } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { recoverPreparedObserverGap } from "./process-recovery-settlement.js";

// Kernel and legacy-log collection have separate real read-only coverage. This
// boundary mock tests the database operation, including failures AFTER evidence
// collection. Production has no supplied collector or supplied proof parameter.
const collection = vi.hoisted(() => ({ value: null as any, accepted: true, collect: vi.fn() }));
vi.mock("./process-recovery-provenance.js", () => ({
  collectLegacySourceProvenance: collection.collect,
  collectedLegacyProvenanceOf: () => collection.accepted ? collection.value : null,
}));

describe("proved observer recovery records absence atomically", () => {
  let store: Store, dir: string, evidenceRoot: string, runId: number, unknown: number;
  const base = "b".repeat(40), head = "a".repeat(40), candidate = "c".repeat(40);
  let origin: number;
  const stamp = (offset: number) => new Date(origin + offset);
  const rows = () => store.handle.prepare("SELECT * FROM run_process ORDER BY id").all();
  const record = (mode: "inspect" | "record" = "record") => recoverPreparedObserverGap(store, { profilePath: "profile",
    compilationDirectory: dir, evidenceRoot, mode });
  beforeEach(() => {
    origin = Date.now() - 60_000;
    dir = mkdtempSync(join(realpathSync(tmpdir()), "so-recovery-record-")); evidenceRoot = join(dir, "evidence"); mkdirSync(evidenceRoot);
    const worktree = join(dir, "worktree"); mkdirSync(worktree);
    store = openStore(join(dir, "orders.db"));
    const token = addApprover(store, "operator", stamp(0)); if (!token.ok) throw Error("fixture approver");
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", stamp(0));
    store.createTask({ id: "prepared", title: "Check the candidate" }, stamp(0));
    const ref = store.lookupRef("prepared")!; store.placeTask(ref.id, dir);
    propose(store, { taskId: "prepared", goal: "Check the candidate", candidate,
      touches: ["a.txt"], acceptance: [{ id: "c1", statement: "Checks pass", how: null, evidence: ["check"] }], now: stamp(0) });
    expect(approve(store, "prepared", "operator", stamp(1), store.getScope("prepared")!.digest, token.token).ok).toBe(true);
    const route = store.routeAuthorityFor(ref.id, "builder"); if (!route.ok) throw Error("fixture route");
    runId = store.startRun({ taskRef: ref.id, leaseId: "lease", runner: "builder", branch: "so/prepared", worktree, route: route.stamp, now: stamp(10) });
    store.stampRun(runId, { baseRevision: base, scopeDigest: store.getScope("prepared")!.digest });
    const conclusion = `Prepared candidate ${candidate} was checked out by the machine; no agent ran. The sealed diff spans this task's base to that candidate.`;
    store.recordOutcomeFacts(runId, { headRevision: head, handoff: conclusion });
    storeHandoffArtifact(store, evidenceRoot, { schema: 1, taskId: "prepared", runId, provider: store.getRun(runId)!.provider,
      sessionId: null, branch: "so/prepared", worktree, base, head, outcome: "built", committed: true,
      decisionsIncorporated: [], conclusion, changes: ["a.txt"], verification: [], followUps: [],
      freshness: { stampedAt: stamp(20).toISOString(), currentAsOf: head } }, stamp(20));
    const command = store.setVerifyCommand({ repo: dir, command: "npm test", timeoutMs: 10_000, approvedBy: "operator" }, stamp(0));
    store.recordRunProcess(runId, 900001, stamp(30), false);
    store.handle.prepare("UPDATE run_process SET exited_at=? WHERE run=?").run(stamp(40).toISOString(), runId);
    unknown = store.reserveRunProcess(runId, stamp(30), true);
    storeEvidence(store, evidenceRoot, runId, "check-log", "check-log.txt", Buffer.from("passed"), command.command, stamp(50), { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, runId, head, command, { configured: true, ran: true, exitCode: 0 }, stamp(50));
    store.saveProofVerdict(runId, "verified", [], stamp(50), [], "verified");
    store.finishRun(runId, { outcome: "built", committed: true, now: stamp(60) }); store.setTaskState("prepared", "done", stamp(60));
    const process = (pid: number, uniqueId: string) => ({ pid, uniqueId, resourceCoalitionId: "77", traced: false,
      ppid: 1, parentUniqueId: "1", uid: 501, birthMs: 0, executable: "fixture", originalParentVersion: 1 });
    const snapshot = { schema: 1, host: hostname(), bootId: currentBootId(), resourceCoalitionId: "77",
      startedAt: stamp(100).toISOString(), finishedAt: stamp(110).toISOString(), complete: true, stable: true,
      kernelTableRead: true, countersStable: true, unreadableMembershipCount: 0, errors: [], identityChanges: [], anchorIdentityChanges: [],
      counterBefore: { tasksStarted: "3", tasksExited: "0" }, counterAfter: { tasksStarted: "3", tasksExited: "0" },
      processes: [process(10, "10"), process(20, "20"), process(30, "30")],
      anchorPids: [20], anchors: [process(20, "20")], collector: { pid: 30, uniqueId: "30", exited: true },
      nativeSourceSha256: "s", nativeExecutableSha256: "x" };
    collection.value = { snapshot, anchor: { databasePath: join(dir, "orders.db"), nativeSourceSha256: "s", nativeExecutableSha256: "x" },
      receipt: { targetRun: runId, head, scopeDigest: store.getScope("prepared")!.digest, host: hostname(), bootId: currentBootId(),
        resourceCoalitionId: "77", sourceRoot: { pid: 10, uniqueId: "10" }, preRunUpperBound: { pid: 20, uniqueId: "20" },
        snapshotDigest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), preexistingAppServices: [], assumptions: ["Boundary fixture"] } };
    collection.accepted = true; collection.collect.mockReset().mockResolvedValue({ ok: true, proof: {} });
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  test("inspection changes neither witnesses nor action history", async () => {
    const before = rows(), ledger = store.actionLedger({ repos: null });
    expect(await record("inspect")).toMatchObject({ ok: true, recorded: false, witnessIds: [unknown] });
    expect(rows()).toEqual(before); expect(store.actionLedger({ repos: null })).toEqual(ledger);
    expect(readdirSync(dir)).not.toContain("process-recovery");
  });
  test("keeps original rows and saves complete private audit before recording absence", async () => {
    const before = rows(); const result = await record();
    expect(result).toMatchObject({ ok: true, recorded: true, witnessIds: [unknown] });
    if (!result.ok || !result.recorded) throw Error("fixture recovery refused");
    const after = rows();
    expect(after).toEqual(before.map(row => row.id === unknown ? { ...row, exited_at: result.observedAt } : row));
    const bytes = readFileSync(result.certificatePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.certificateDigest);
    expect(statSync(result.certificatePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(bytes.toString()).eligibility.binding.witnesses).toEqual(before);
    expect(store.actionLedger({ repos: null }).find(one => one.id === result.actionId)?.outcome).toBe(result.certificateDigest);
  });
  test("a cloned success cannot substitute for this invocation's collector", async () => {
    collection.accepted = false; const before = rows();
    expect(await record()).toEqual({ ok: false, reason: "uncollected-process-evidence" }); expect(rows()).toEqual(before);
  });
  test("a collection refusal retains its safe phase without reaching custody", async () => {
    const before = rows(), failure = { ok: false, reason: "legacy-source-provenance-unproven", phase: "service-anchor", anchorReason: "native-anchor-unproven" };
    collection.collect.mockResolvedValue(failure);
    expect(await record()).toEqual(failure); expect(rows()).toEqual(before);
    expect(readdirSync(dir)).not.toContain("process-recovery");
  });
  test("a collected service mapping that loses its exact owner cannot settle custody", async () => {
    const before = rows();
    collection.value.receipt.preexistingAppServices = [{ pid: 10, uniqueId: "10", ownerPid: 999, ownerUniqueId: "1" }];
    expect(await record()).toEqual({ ok: false, reason: "surviving-processes-not-excluded" });
    expect(rows()).toEqual(before); expect(readdirSync(dir)).not.toContain("process-recovery");
  });
  test("new custody between collection and transaction prevents settlement", async () => {
    const transact = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementation(fn => { store.reserveRunProcess(runId, stamp(35), true); return transact(fn); });
    expect(await record()).toEqual({ ok: false, reason: "recovery-not-recorded" });
    expect(rows().filter(row => row.pid === null).every(row => row.exited_at === null)).toBe(true);
  });
  test("changed audit bytes cannot authorize the database write", async () => {
    const before = rows(), ledger = store.actionLedger({ repos: null }), transact = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementation(fn => {
      const audit = join(dir, "process-recovery");
      writeFileSync(join(audit, readdirSync(audit)[0]!), "changed observation");
      return transact(fn);
    });
    expect(await record()).toEqual({ ok: false, reason: "recovery-not-recorded" });
    expect(rows()).toEqual(before); expect(store.actionLedger({ repos: null })).toEqual(ledger);
  });
  test("replaying a successful observation cannot add another exit or ledger entry", async () => {
    expect(await record()).toMatchObject({ ok: true, recorded: true });
    const after = rows(), ledger = store.actionLedger({ repos: null });
    expect((await record()).ok).toBe(false);
    expect(rows()).toEqual(after); expect(store.actionLedger({ repos: null })).toEqual(ledger);
    expect(readdirSync(join(dir, "process-recovery"))).toHaveLength(1);
  });
  test.each(["ledger", "workspace"])("a final %s failure rolls back every exit write", async failure => {
    const before = rows(), ledger = store.actionLedger({ repos: null });
    if (failure === "ledger") vi.spyOn(store, "recordAction").mockImplementation(() => { throw Error("fixture ledger failure"); });
    else vi.spyOn(store, "stopQuiescenceProblem").mockReturnValue("Workspace is still held");
    expect(await record()).toEqual({ ok: false, reason: "recovery-not-recorded" });
    expect(rows()).toEqual(before); expect(store.actionLedger({ repos: null })).toEqual(ledger);
    expect(readdirSync(join(dir, "process-recovery"))).toHaveLength(1);
  });
});
