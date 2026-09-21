import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReadyAssignment, createFixtureLead, completeFixtureAssignment } from "../scripts/canary-assertions.mjs";
import { main } from "./cli.js";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";

const NOW = new Date("2026-09-20T23:00:00Z"), HEAD = "a".repeat(40), REPO = "/repos/certification";
describe("certification follows the public Ready → Complete contract", () => {
  let store: Store, dir: string, db: string, token: string, run: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-certification-")); db = join(dir, "orders.db"); store = openStore(db);
    const operator = addApprover(store, "operator", NOW); if (!operator.ok) throw Error("fixture operator"); token = operator.token;
    for (const phase of ["plan", "build"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", NOW);
    store.createTask({ id: "work", title: "Verify the retained result" }, NOW); const task = store.lookupRef("work")!; store.placeTask(task.id, REPO);
    propose(store, { taskId: "work", goal: "Save the verified result", acceptance: [], now: NOW });
    expect(approve(store, "work", "operator", NOW, store.getScope("work")!.digest, token).ok).toBe(true);
    const authority = store.routeAuthorityFor(task.id, "builder"); if (!authority?.ok) throw Error("fixture route");
    run = store.startRun({ taskRef: task.id, leaseId: "fixture", runner: "builder", branch: "so/work", worktree: "/pool/work", route: authority.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope("work")!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: "Saved the verified output." });
    store.finishRun(run, { outcome: "built", committed: true, now: NOW }); store.setTaskState("work", "done", NOW);
    store.saveProofVerdict(run, "short", ["Historical optional proof is absent."], NOW, [], "short");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60000, approvedBy: "operator" }, NOW);
    storeEvidence(store, join(dir, "evidence"), run, "check-log", "check.txt", Buffer.from("1 passed"), "npm test", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, join(dir, "evidence"), run, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, NOW);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  async function cli(args: string[]) {
    const lines: string[] = [];
    const code = await main([...args, "--json"], line => lines.push(line), { operate: { databaseFile: db, now: NOW } });
    expect(code, lines.join("\n")).toBe(0); return JSON.parse(lines.join("\n"));
  }
  test("scoped lead inspects and completes exact checked output without a reviewer or changed history", async () => {
    const tokenFile = await createFixtureLead(cli, { repo: REPO, auth: ["--as", "operator", "--token", token], tokenFile: join(dir, "lead.token") });
    if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const completed = await completeFixtureAssignment(cli, "work", tokenFile, { head: HEAD, runId: run });
    expect(completed).toMatchObject({ state: "complete", head: HEAD, runId: run, checks: { status: "passed", exitCode: 0 } });
    expect(store.runsFor(store.lookupRef("work")!.id)).toHaveLength(1);
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    expect(store.openReviewRequests()).toEqual([]);
  });
  test("certification rejects a wrong result or failed check even when a task is called finished", async () => {
    const ready = (await cli(["assignment", "show", "work"])).result;
    expect(() => assertReadyAssignment(ready, { head: "c".repeat(40) })).toThrow("wrong candidate");
    expect(() => assertReadyAssignment(ready, { runId: run + 1 })).toThrow("wrong result");
    expect(() => assertReadyAssignment({ ...ready, state: "complete" })).toThrow("Ready");
    expect(() => assertReadyAssignment({ ...ready, receipt: { ...ready.receipt, checks: { status: "failed", exitCode: 1 } } })).toThrow("did not pass");
  });
});
