import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { run } from "./exec.js";
import { storeEvidence } from "./evidence.js";
import { maybeTriggerRepair } from "./dispose.js";
import { collectObservations, focusedTestCommandSupported, observationBrief, parseObservationCases, readObservationEvidence, OBSERVATION_CAPTURE } from "./observations.js";
import { sealVerificationReceipt, verificationEvidence, reuseObservationVerification } from "./verification-evidence.js";
import type { CriterionMatrixRow } from "./proof.js";
import { runOperate, EXIT } from "./operate.js";

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const T = new Date("2026-09-18T00:00:00Z"), criterion = { id: "c1", statement: "The saved regression fails on the original and passes on the candidate", how: null, evidence: ["check" as const] };
function fixture(auto = true, testNames = ["restored reward opens draft"]) {
  const root = mkdtempSync(join(tmpdir(), "so-observations-")); roots.push(root);
  const repo = join(root, "repo"), evidence = join(root, "evidence"); mkdirSync(repo); mkdirSync(evidence);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "value.ts"), "export const value = 'map';\n");
  git("add", "."); git("commit", "-m", "original"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "value.ts"), "export const value = 'augment_draft';\n");
  writeFileSync(join(repo, "value.test.ts"), "import {describe,test,expect} from 'vitest'; import {value} from './value'; describe('saved reward',()=>{\n" + testNames.map(name => `test(${JSON.stringify(name)},()=>expect(value).toBe('augment_draft'));`).join("\n") + "\n});\n");
  git("add", "."); git("commit", "-m", "fix and regression"); const head = git("rev-parse", "HEAD");
  symlinkSync(resolve("node_modules"), join(repo, "node_modules"), "junction");
  const db = join(root, "queue.db"), store = openStore(db); stores.push(store);
  const person = addApprover(store, "alex", T); if (!person.ok) throw Error("fixture approver");
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T);
  store.createTask({ id: "original", title: "Original" }, T); const ref = store.lookupRef("original")!; store.placeTask(ref.id, repo);
  propose(store, { taskId: "original", goal: "Fix restore", touches: ["value.ts", "value.test.ts"], acceptance: [criterion], now: T });
  expect(approve(store, "original", "alex", T, store.getScope("original")!.digest, person.token).ok).toBe(true);
  const start = (task: string, atBase: string) => {
    const r = store.lookupRef(task)!, route = store.routeAuthorityFor(r.id, "builder", null);
    if (!route?.ok) throw Error("fixture route");
    const id = store.startRun({ taskRef: r.id, leaseId: `fixture-${task}`, runner: "fixture", branch: `standing-orders/${task}`, worktree: repo, now: T, route: route.stamp });
    store.stampRun(id, { scopeDigest: store.getScope(task)!.digest, baseRevision: atBase });
    store.recordOutcomeFacts(id, { headRevision: head, baseRevision: atBase }); return id;
  };
  const source = start("original", base); store.finishRun(source, { outcome: "built", committed: true, now: T });
  const matrix: CriterionMatrixRow[] = [{ id: "c1", statement: criterion.statement, requiredEvidence: ["check"], state: "missing", detail: ["Need original failing regression"], answered: [],
    assessment: { evidenceState: "pass", detail: [] }, review: { judgement: "cannot-tell", note: "Need original failing regression", author: "reviewer" } }];
  store.saveProofVerdict(source, "short", ["Need original failing regression"], T, matrix, "verified");
  store.setVerifyCommand({ repo, command: "npm test -- --reporter=dot && npm run build", timeoutMs: 300000, approvedBy: "alex" }, T);
  storeEvidence(store, evidence, source, "check-log", "check-log.txt", Buffer.from("Original full gate passed\n"), "machine check", T, { captureStatus: "ok" });
  sealVerificationReceipt(store, evidence, source, head, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 0 }, T);
  if (auto) { const terms = { ...presetTerms("standard", new Date(T.getTime() + 86400000).toISOString()), repairAuto: true, repairMaxAttempts: 3 };
    store.signMode({ repo, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T); }
  const trigger = () => {
    expect(verificationEvidence(store, evidence, source)).toMatchObject({ok:true});
    const result = maybeTriggerRepair(store, repo, evidence, source, "short", T);
    return result;
  };
  const draft = () => {
    const made = trigger(); expect(made.kind).toBe("drafted"); if (made.kind !== "drafted") throw Error("no draft");
    if (!made.approved) expect(approve(store, made.draftTaskId, "alex", T, store.getScope(made.draftTaskId)!.digest, person.token).ok).toBe(true);
    const id = start(made.draftTaskId, head), brief = observationBrief(store, evidence, store.getRun(id)!.taskRef)!;
    return { id, task: made.draftTaskId, brief };
  };
  return { root, repo, db, token: person.token, evidence, store, source, base, head, matrix, trigger, draft };
}
const request = { version: 1, observations: [
  { criterion: "c1", at: "base", testPath: "value.test.ts", testName: "restored reward opens draft" },
  { criterion: "c1", at: "head", testPath: "value.test.ts", testName: "restored reward opens draft" },
] };

describe("focused evidence follow-ups", () => {
  test("test authority comes from a simple approved command, never quoted shell text", () => {
    expect(focusedTestCommandSupported("npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build")).toBe(true);
    expect(focusedTestCommandSupported("npm test && node gate-count.cjs")).toBe(true);
    for (const command of ["echo 'before && npm test && after'", 'printf "before && npm test && after"', "echo $(npm test)", "npm test; echo done", "npm test && $(echo true)", "npm test || true", "npm test > /tmp/output", "npm test &&"]) expect(focusedTestCommandSupported(command), command).toBe(false);
  });

  test("historical missing evidence uses authenticated existing repair approval with the exact repo", async () => {
    const f = fixture(false);
    const call = (token: string, repo: string) => runOperate("task", ["repair", String(f.source), "--yes", "--repo", repo, "--as", "alex", "--token", token, "--json"], () => {}, { databaseFile: f.db, evidenceRoot: f.evidence, now: T });
    expect(await call("wrong-token", f.repo)).toBe(EXIT.refused);
    expect(f.store.repairChainFor(f.source)).toBeNull();
    expect(await call(f.token, f.root)).toBe(EXIT.refused);
    expect(f.store.repairChainFor(f.source)).toBeNull();
    expect(await call(f.token, f.repo)).toBe(EXIT.ok);
    const chain = f.store.repairChainFor(f.source)!;
    expect(chain.draftTask).toBe("original-evidence-1");
    expect(f.store.getScope(chain.draftTask!)?.approvedBy).toBe("alex");
    expect(await call(f.token, f.repo)).toBe(EXIT.ok);
    expect(f.store.repairChainForRoot("original")).toHaveLength(1);
  });

  test.each([true, false])("drafts once under existing authority, automatic=%s", auto => {
    const f = fixture(auto); const made = f.trigger(); expect(made).toMatchObject({ kind: "drafted", approved: auto, attempt: 1 });
    expect(f.trigger()).toEqual({ kind: "none" });
    expect(f.store.repairChainFor(f.source)?.draftTask).toBe("original-evidence-1");
    expect(f.store.getScope("original-evidence-1")?.acceptance).toEqual(f.store.getScope("original")?.acceptance);
    expect(f.store.raw().prepare("SELECT count(*) AS n FROM notification WHERE dedupe_key=?").get(`assessment-evidence:${f.source}`)?.n).toBe(auto ? 0 : 1);
  });

  test.each(["command", "revision", "traversal", "foreign", "too-many", "duplicate", "no-test-name"])("rejects %s in agent-proposed observations", problem => {
    const value: any = structuredClone(request);
    if (problem === "command") value.observations[0].command = "echo unsafe";
    if (problem === "revision") value.observations[0].at = "a".repeat(40);
    if (problem === "traversal") value.observations[0].testPath = "../outside.test.ts";
    if (problem === "foreign") value.observations[0].criterion = "not-signed";
    if (problem === "too-many") value.observations = Array(5).fill(value.observations[0]);
    if (problem === "duplicate") value.observations[1] = value.observations[0];
    if (problem === "no-test-name") value.observations[0].testName = "";
    expect(() => parseObservationCases(JSON.stringify(value), ["c1"])).toThrow();
  });

  test.each([false, true])("captures a real baseline failure and candidate pass, reuses the exact gate and refuses later tampering (color=%s)", async color => {
    const f = fixture(), child = f.draft();
    const original = f.store.artifactsFor(f.source).map(a => ({ id: a.id, sha: a.sha256 }));
    const commands: string[] = [];
    await collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(request), ["c1"]), async (file, args, options) => {
      commands.push([file, ...args].join(" "));
      const result = await run(file, args, options);
      // Retain a colored reporter stream verbatim, like the installed worker's
      // full gate; color controls between summary words must not hide a test.
      return color && args.some(a => a.endsWith("vitest.mjs")) ? { ...result, stdout: result.stdout.replace(/Tests/g, "\u001b[2mTests\u001b[22m") } : result;
    }, () => T);
    const evidence = readObservationEvidence(f.store, f.evidence, child.id)!;
    const receipt = JSON.parse(evidence.content);
    if (color) expect(receipt.observations[0].stdout).toContain("\u001b[2mTests\u001b[22m");
    expect(receipt.observations.map((o: any) => o.exitCode)).toEqual([1, 0]);
    expect(receipt.observations[0].stdout).toContain("expected 'map' to be 'augment_draft'");
    expect(receipt.observations[0].testSha256).toBe(receipt.observations[1].testSha256);
    expect(receipt.observations[0].revision).toBe(f.base);
    expect(receipt.observations[1].revision).toBe(f.head);
    expect(reuseObservationVerification(f.store, f.evidence, child.id, T)).toMatchObject({ exitCode: 0 });
    const gate = verificationEvidence(f.store, f.evidence, child.id); expect(gate.ok).toBe(true);
    expect(gate.ok && JSON.parse(gate.bytes!).reusedFrom.run).toBe(f.source);
    expect(gate.ok && JSON.parse(gate.bytes!).executedHere).toBe(false);
    expect(commands.filter(c => c.includes("vitest.mjs"))).toHaveLength(2);
    expect(commands.some(c => c.includes("npm test") || c.includes("npm run build"))).toBe(false);
    expect(f.store.artifactsFor(f.source).map(a => ({ id: a.id, sha: a.sha256 }))).toEqual(original);
    expect(f.store.proofAcceptance(child.id)).toBeNull();
    expect(() => reuseObservationVerification(f.store, f.evidence, child.id, T)).toThrow("already has a gate");
    const artifact = f.store.artifactsFor(child.id).find(a => a.capture === OBSERVATION_CAPTURE)!;
    writeFileSync(join(f.evidence, artifact.key), "tampered");
    expect(verificationEvidence(f.store, f.evidence, child.id).ok).toBe(false);
  });

  test("changed source gate cannot authorize reuse", () => {
    const f = fixture(), child = f.draft();
    f.store.setVerifyCommand({ repo: f.repo, command: "npm test", timeoutMs: 300000, approvedBy: "alex" }, new Date(T.getTime() + 1));
    expect(() => reuseObservationVerification(f.store, f.evidence, child.id, T)).toThrow();
    expect(f.store.artifactsFor(child.id).some(a => a.kind === "check-log")).toBe(false);
  });

  test("unapproved commands cannot execute", async () => {
    const f = fixture(), child = f.draft();
    f.store.setVerifyCommand({ repo: f.repo, command: "node check.cjs", timeoutMs: 300000, approvedBy: "alex" }, T);
    let calls = 0;
    await expect(collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(request), ["c1"]), async () => { calls++; throw Error("must not execute"); }, () => T)).rejects.toThrow("already approved npm test");
    expect(calls).toBe(0);
  });

  test("a test that mutates its source snapshot cannot produce evidence", async () => {
    const f = fixture(), child = f.draft();
    await expect(collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(request), ["c1"]), async (file, args, options) => {
      const result = await run(file, args, options);
      if (args.some(a => a.endsWith("vitest.mjs"))) writeFileSync(join(options!.cwd!, "value.ts"), "mutated");
      return result;
    }, () => T)).rejects.toThrow("changed or lost a source file");
    expect(f.store.artifactsFor(child.id).some(a => a.capture === OBSERVATION_CAPTURE)).toBe(false);
    expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toContain("augment_draft");
  });

  test("no matching test is missing evidence, never an observation pass", async () => {
    const f = fixture(), child = f.draft(), manifest = structuredClone(request);
    manifest.observations.forEach(o => o.testName = "not a real test");
    await expect(collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(manifest), ["c1"]), run, () => T)).rejects.toThrow("did not execute a test");
    expect(f.store.artifactsFor(child.id).some(a => a.capture === OBSERVATION_CAPTURE)).toBe(false);
  });

  test("literal punctuation selects the requested nested test at both revisions", async () => {
    const name = "reward.v2 (restored) [draft]+?", f = fixture(true, [name, "rewardXv2 restored draft"]), child = f.draft();
    const manifest = structuredClone(request); manifest.observations.forEach(o => o.testName = name);
    await collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(manifest), ["c1"]), run, () => T);
    const receipt = JSON.parse(readObservationEvidence(f.store, f.evidence, child.id)!.content);
    expect(receipt.observations.map((o: any) => o.exitCode)).toEqual([1, 0]);
    expect(receipt.observations.every((o: any) => o.selectedTest.title === name && o.selectedTest.fullName === `saved reward ${name}` && o.selectedTest.path === "value.test.ts")).toBe(true);
  });

  test.each([
    { names: ["rewardXv2"], requested: "reward.v2" },
    { names: ["not the requested reward"], requested: "requested reward" },
    { names: ["same reward", "same reward"], requested: "same reward" },
  ])("another or ambiguous test never supplies the requested observation: $requested", async ({ names, requested }) => {
    const f = fixture(true, names), child = f.draft(), manifest = structuredClone(request);
    manifest.observations.forEach(o => o.testName = requested);
    await expect(collectObservations(f.store, f.evidence, child.id, f.repo, child.brief, parseObservationCases(JSON.stringify(manifest), ["c1"]), run, () => T)).rejects.toThrow(/did not execute/);
    expect(f.store.artifactsFor(child.id).some(a => a.capture === OBSERVATION_CAPTURE)).toBe(false);
  });

  test("human observations remain an explicit request instead of another agent attempt", () => {
    const f = fixture();
    f.store.saveProofVerdict(f.source, "short", ["Need phone screenshot"], T, f.matrix.map(row => ({ ...row, requiredEvidence: ["check", "screenshot"], detail: ["Need phone screenshot"] })), "verified");
    expect(f.trigger()).toEqual({ kind: "none" });
    expect(f.store.repairChainFor(f.source)).toBeNull();
    expect(f.store.raw().prepare("SELECT body FROM notification WHERE dedupe_key=?").get(`assessment-evidence:${f.source}`)?.body).toBe("Need phone screenshot");
  });
});
