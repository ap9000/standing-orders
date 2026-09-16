/**
 * The shared evidence selection every chat surface reads a result's images
 * through: project access and exact task/run/artifact identity, honest
 * report/no-image answers, the unchanged review-snapshot contract beside
 * it, and the send-time proof a channel runs before every upload. Real
 * store, real evidence files, no Telegram: this is the reader, not the wire.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Artifact, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { readChatResult } from "./chat-review.js";
import { createResultRevision } from "./result-actions.js";
import { revisionSourceOf } from "./result-review.js";
import { SCREENSHOT_BYTE_CAP } from "./evidence.js";
import { subscriptionCredentialKey } from "./converse.js";
import { executeMateTool } from "./mate-tools.js";
import { RESULT_IMAGES_PER_TURN_CAP, resultImageCaption, selectResultImages, verifyResultImage } from "./chat-evidence.js";

const T0 = new Date("2026-09-16T09:00:00.000Z");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(90, 3)]);
const TEXT = Buffer.from("not an image at all, whatever the name says", "utf8");

describe("shared result image selection", () => {
  let dir: string;
  let evidenceRoot: string;
  let store: Store;
  let token: string;
  let repos: { a: string; b: string; c: string };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-chat-evidence-")));
    evidenceRoot = join(dir, "evidence");
    repos = { a: join(dir, "alpha-project"), b: join(dir, "beta-project"), c: join(dir, "private-project") };
    for (const path of [evidenceRoot, ...Object.values(repos)]) mkdirSync(path);
    store = openStore(join(dir, "orders.db"));
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const who = (admitted: string[]): VerifiedApprover => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, admitted);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const task = (id: string, repo: string): number => {
    store.createTask({ id, title: `Work ${id}` }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    propose(store, { taskId: id, goal: `do ${id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["manual-review"] }], now: T0 });
    const scope = store.getScope(id)!;
    const approved = approve(store, id, "alex", T0, scope.digest, token);
    if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`);
    return ref;
  };
  /** One finished builder result of a task; artifacts are the caller's. */
  const finished = (id: string, ref: number, lease: string): number => {
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: lease, runner: "builder-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now: T0 });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    store.setTaskState(id, "done", T0);
    return run;
  };
  const artifact = (run: number, kind: Artifact["kind"], name: string, bytes: Buffer, record: Partial<{ truncated: boolean; redacted: boolean; captureStatus: "ok" | "failed"; bytesStored: number; sha256: string; skipFile: boolean }> = {}): number => {
    if (record.skipFile !== true) writeFileSync(join(evidenceRoot, String(run), name), bytes);
    return store.saveArtifact({
      run, kind, key: `${run}/${name}`, bytesOriginal: bytes.length, bytesStored: record.bytesStored ?? bytes.length, truncated: record.truncated ?? false,
      sha256: record.sha256 ?? createHash("sha256").update(bytes).digest("hex"), capture: `${kind} capture (exit 0)`,
      ...(record.redacted === undefined ? {} : { redacted: record.redacted }), ...(record.captureStatus === undefined ? {} : { captureStatus: record.captureStatus }),
    }, T0);
  };
  const diff = (run: number, id: string): number => artifact(run, "terminal-diff", "terminal-diff.patch", Buffer.from(`diff --git a/${id} b/${id}\n+x\n`, "utf8"));

  test("selects the verified images of the exact result across both admitted projects, never the excluded one, and never another task's artifact", () => {
    const alpha = task("alpha", repos.a);
    const alphaRun = finished("alpha", alpha, "l-alpha");
    diff(alphaRun, "alpha");
    const first = artifact(alphaRun, "screenshot", "screenshot-home.png", PNG);
    const second = artifact(alphaRun, "screenshot", "screenshot-form.jpg", JPEG);
    const beta = task("beta", repos.b);
    const betaRun = finished("beta", beta, "l-beta");
    const betaShot = artifact(betaRun, "screenshot", "screenshot-b.png", PNG);
    const gamma = task("gamma", repos.c);
    const gammaRun = finished("gamma", gamma, "l-gamma");
    const gammaShot = artifact(gammaRun, "screenshot", "screenshot-c.png", PNG);
    const me = who([repos.a, repos.b]);

    const selected = selectResultImages(store, me, evidenceRoot, "alpha");
    expect(selected).toMatchObject({ ok: true, selection: { task: "alpha", root: "alpha", currentExecution: "alpha", run: alphaRun, role: "builder", title: "Work alpha", report: false, unavailable: [] } });
    if (!selected.ok) throw new Error(selected.message);
    expect(selected.selection.images).toEqual([
      { artifact: first, sha256: createHash("sha256").update(PNG).digest("hex"), format: "png", bytes: PNG.length, ordinal: 1, total: 2, caption: `alpha · result #${alphaRun} · screenshot 1 of 2`, fileName: `alpha-result-${alphaRun}-${first}.png` },
      { artifact: second, sha256: createHash("sha256").update(JPEG).digest("hex"), format: "jpeg", bytes: JPEG.length, ordinal: 2, total: 2, caption: `alpha · result #${alphaRun} · screenshot 2 of 2`, fileName: `alpha-result-${alphaRun}-${second}.jpg` },
    ]);
    expect(selectResultImages(store, me, evidenceRoot, "beta", betaRun)).toMatchObject({ ok: true, selection: { run: betaRun, images: [expect.objectContaining({ artifact: betaShot, total: 1 })] } });
    // The excluded project: not readable, not named, not even by its exact run.
    expect(selectResultImages(store, me, evidenceRoot, "gamma")).toEqual({ ok: false, message: "That task is not in your projects." });
    expect(selectResultImages(store, me, evidenceRoot, "gamma", gammaRun)).toEqual({ ok: false, message: "That task is not in your projects." });
    // A run of another task, or a fabricated one, never selects that task's images under this task's name.
    expect(selectResultImages(store, me, evidenceRoot, "alpha", gammaRun)).toEqual({ ok: false, message: "There is no finished result for that version yet." });
    expect(selectResultImages(store, me, evidenceRoot, "alpha", 9_999)).toEqual({ ok: false, message: "There is no finished result for that version yet." });
    expect(selectResultImages(store, who([repos.b]), evidenceRoot, "alpha", alphaRun)).toEqual({ ok: false, message: "That task is not in your projects." });
    expect(selectResultImages(store, me, undefined, "alpha", alphaRun)).toEqual({ ok: false, message: "Saved images cannot be read from here." });
    // The send-time proof: the exact bytes come back for the right identity; a swapped artifact id, hash, or project is a refusal, never another image.
    const proven = verifyResultImage(store, evidenceRoot, [repos.a, repos.b], { taskId: "alpha", run: alphaRun, artifact: first, sha256: selected.selection.images[0]!.sha256 });
    expect(proven).toMatchObject({ ok: true, format: "png" });
    if (!proven.ok) throw new Error(proven.problem);
    expect(proven.bytes.equals(PNG)).toBe(true);
    expect(verifyResultImage(store, evidenceRoot, [repos.a, repos.b], { taskId: "alpha", run: alphaRun, artifact: gammaShot, sha256: createHash("sha256").update(PNG).digest("hex") })).toEqual({ ok: false, problem: "the saved file's record changed" });
    expect(verifyResultImage(store, evidenceRoot, [repos.a, repos.b], { taskId: "alpha", run: alphaRun, artifact: first, sha256: "0".repeat(64) })).toEqual({ ok: false, problem: "the saved file's record changed" });
    expect(verifyResultImage(store, evidenceRoot, [repos.a, repos.b], { taskId: "alpha", run: gammaRun, artifact: gammaShot, sha256: createHash("sha256").update(PNG).digest("hex") })).toEqual({ ok: false, problem: "the result is no longer recorded" });
    expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "alpha", run: alphaRun, artifact: first, sha256: selected.selection.images[0]!.sha256 })).toEqual({ ok: false, problem: "the result is outside your connected projects now" });
    expect(verifyResultImage(store, evidenceRoot, [repos.a, repos.b], { taskId: "gamma", run: gammaRun, artifact: gammaShot, sha256: createHash("sha256").update(PNG).digest("hex") })).toEqual({ ok: false, problem: "the result is outside your connected projects now" });
  });

  test("an older result stays exact by run; without a run a newer revision is said, never switched to", () => {
    const alpha = task("alpha", repos.a);
    const older = finished("alpha", alpha, "l-1");
    diff(older, "alpha");
    const olderShot = artifact(older, "screenshot", "screenshot-old.png", PNG);
    const newer = finished("alpha", alpha, "l-2");
    const newerDiff = diff(newer, "alpha");
    const newerShot = artifact(newer, "screenshot", "screenshot-new.jpg", JPEG);
    const me = who([repos.a]);
    expect(selectResultImages(store, me, evidenceRoot, "alpha")).toMatchObject({ ok: true, selection: { run: newer, images: [expect.objectContaining({ artifact: newerShot, format: "jpeg" })] } });
    expect(selectResultImages(store, me, evidenceRoot, "alpha", older)).toMatchObject({ ok: true, selection: { run: older, currentExecution: "alpha", images: [expect.objectContaining({ artifact: olderShot, caption: `alpha · result #${older} · screenshot 1 of 1` })] } });
    // A revision of the same task, through the shared result service the console and chat both call.
    const note = store.addDiffComment({ artifactId: newerDiff, runId: newer, path: null, line: null, note: "Tighten the spacing.", author: "alex" }, T0);
    const revision = createResultRevision(store, evidenceRoot, { run: newer, batch: String(note), source: revisionSourceOf(store.getScope("alpha")!.digest), actor: "alex", repos: [repos.a] }, T0);
    if (!revision.ok) throw new Error(revision.message);
    const child = revision.id;
    expect(store.taskFamilyOf("alpha", [repos.a], false)?.versions.map(one => one.id)).toEqual(["alpha", child]);
    expect(selectResultImages(store, me, evidenceRoot, "alpha")).toEqual({ ok: false, message: "A newer revision of this task is current. Say which result you mean before images are selected: this version or the newer one." });
    const exact = selectResultImages(store, me, evidenceRoot, "alpha", older);
    expect(exact).toMatchObject({ ok: true, selection: { task: "alpha", root: "alpha", currentExecution: child, run: older, images: [expect.objectContaining({ artifact: olderShot, caption: `alpha · result #${older} · screenshot 1 of 1 · older version` })] } });
    expect(resultImageCaption("alpha", older, 1, 1, false)).toBe(`alpha · result #${older} · screenshot 1 of 1 · older version`);
    expect(selectResultImages(store, me, evidenceRoot, child)).toEqual({ ok: false, message: "There is no finished result for that version yet." });
  });

  test("a report or no-image result is answered honestly, and the review snapshot keeps requiring its terminal diff", () => {
    const delta = task("delta", repos.a);
    const deltaRun = finished("delta", delta, "l-delta");
    artifact(deltaRun, "report", "report.json", Buffer.from(JSON.stringify({ title: "Findings", summary: "Nothing to change.", followUps: [] }), "utf8"));
    const epsilon = task("epsilon", repos.a);
    const epsilonRun = finished("epsilon", epsilon, "l-epsilon");
    diff(epsilonRun, "epsilon");
    const me = who([repos.a]);
    expect(selectResultImages(store, me, evidenceRoot, "delta")).toMatchObject({ ok: true, selection: { run: deltaRun, images: [], unavailable: [], report: true } });
    expect(selectResultImages(store, me, evidenceRoot, "epsilon")).toMatchObject({ ok: true, selection: { run: epsilonRun, images: [], unavailable: [], report: false } });
    // Unchanged: feedback and revisions still need the sealed terminal diff; images never loosen that.
    expect(readChatResult(store, me, evidenceRoot, "delta", deltaRun)).toEqual({ ok: false, message: "The saved changes are unavailable. Feedback has not been added." });
    expect(readChatResult(store, me, evidenceRoot, "epsilon", epsilonRun)).toMatchObject({ ok: true, snapshot: { run: epsilonRun, execution: "epsilon" } });
  });

  test("failed, shortened, redacted, oversized, wrong-kind, tampered and missing records are named in plain words and never selected or verified", () => {
    const beta = task("beta", repos.b);
    const run = finished("beta", beta, "l-beta");
    const good = artifact(run, "screenshot", "good.png", PNG);
    const failed = artifact(run, "screenshot", "failed.png", PNG, { captureStatus: "failed" });
    const shortened = artifact(run, "screenshot", "shortened.png", PNG, { truncated: true });
    const redacted = artifact(run, "screenshot", "redacted.png", PNG, { redacted: true });
    const oversized = artifact(run, "screenshot", "oversized.png", PNG, { bytesStored: SCREENSHOT_BYTE_CAP + 1 });
    const wrongKind = artifact(run, "screenshot", "wrong.png", TEXT);
    const tampered = artifact(run, "screenshot", "tampered.png", PNG);
    writeFileSync(join(evidenceRoot, String(run), "tampered.png"), Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([9])]));
    const missing = artifact(run, "screenshot", "missing.png", PNG, { skipFile: true });
    const notShot = artifact(run, "check-log", "check.log", Buffer.from("ok\n", "utf8"));
    const me = who([repos.b]);
    const selected = selectResultImages(store, me, evidenceRoot, "beta", run);
    if (!selected.ok) throw new Error(selected.message);
    expect(selected.selection.images.map(one => one.artifact)).toEqual([good]);
    expect(selected.selection.unavailable).toEqual([
      { artifact: failed, problem: "the capture failed" },
      { artifact: shortened, problem: "the saved file was shortened" },
      { artifact: redacted, problem: "sensitive text was hidden from the saved file" },
      { artifact: oversized, problem: "the saved file is too large to send" },
      { artifact: wrongKind, problem: "the saved file is not a PNG or JPEG" },
      { artifact: tampered, problem: "the saved file is missing or changed" },
      { artifact: missing, problem: "the saved file is missing or changed" },
    ]);
    for (const one of selected.selection.unavailable) expect(one.problem).not.toMatch(/\/|evidence|sha|[0-9a-f]{32}/);
    const sha = createHash("sha256").update(PNG).digest("hex");
    for (const [id, problem] of [[failed, "the capture failed"], [shortened, "the saved file was shortened"], [redacted, "sensitive text was hidden from the saved file"], [tampered, "the saved file is missing or changed"], [missing, "the saved file is missing or changed"]] as const) {
      expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "beta", run, artifact: id, sha256: sha })).toEqual({ ok: false, problem });
    }
    expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "beta", run, artifact: wrongKind, sha256: createHash("sha256").update(TEXT).digest("hex") })).toEqual({ ok: false, problem: "the saved file is not a PNG or JPEG" });
    expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "beta", run, artifact: notShot, sha256: createHash("sha256").update(Buffer.from("ok\n", "utf8")).digest("hex") })).toEqual({ ok: false, problem: "the saved file's record changed" });
    // The good one verifies now — and is refused the moment its bytes change or vanish, on the very next read.
    expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "beta", run, artifact: good, sha256: sha })).toMatchObject({ ok: true });
    unlinkSync(join(evidenceRoot, String(run), "good.png"));
    expect(verifyResultImage(store, evidenceRoot, [repos.b], { taskId: "beta", run, artifact: good, sha256: sha })).toEqual({ ok: false, problem: "the saved file is missing or changed" });
  });

  test("the get_result_images tool records the selection under the running turn, bounded and deduplicated, deleted with a failed turn, and says how this surface delivers", () => {
    const alpha = task("alpha", repos.a);
    const run = finished("alpha", alpha, "l-alpha");
    diff(run, "alpha");
    const shots = Array.from({ length: RESULT_IMAGES_PER_TURN_CAP + 1 }, (_, index) => artifact(run, "screenshot", `screenshot-${index}.png`, Buffer.concat([PNG, Buffer.from([index])])));
    artifact(run, "screenshot", "broken.png", PNG, { captureStatus: "failed" });
    const me = who([repos.a]);
    const credentialKey = subscriptionCredentialKey("claude-subscription");
    const session = store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
    const thread = store.openMateThread("alex", me.ceilingDigest, T0).thread;
    const opened = store.openMateTurn({ approver: "alex", session, thread: thread.id, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, T0);
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, T0);
    if (!started.ok) throw new Error("start");
    const selectEvidence = (rows: Parameters<Store["recordMateTurnEvidence"]>[1]) => store.recordMateTurnEvidence(opened.id, rows, RESULT_IMAGES_PER_TURN_CAP, T0);
    const base = { store, who: me, now: T0, evidenceRoot, step: 1, readDecisions: new Map<number, number>(), draft: () => null };

    const phone = executeMateTool({ ...base, selectEvidence, mediaDelivery: "documents" }, "get_result_images", { task: "alpha", run });
    expect(phone).toMatchObject({ ok: true, body: {
      task: "alpha", root: "alpha", currentExecution: "alpha", isCurrent: true, run, title: "Work alpha", report: false,
      imageCount: RESULT_IMAGES_PER_TURN_CAP + 1,
      unavailable: [{ problem: "the capture failed" }],
      delivery: `${RESULT_IMAGES_PER_TURN_CAP} image file(s) will be sent to this chat after your reply. Say they follow; do not say they were delivered.`,
    } });
    const body = (phone as { body: { images: { id: number; caption: string }[] } }).body;
    expect(body.images.map(one => one.id)).toEqual(shots);
    expect(body.images[0]!.caption).toBe(`alpha · result #${run} · screenshot 1 of ${RESULT_IMAGES_PER_TURN_CAP + 1}`);
    // Bounded: the cap holds, in selection order; a second read of the same result adds nothing twice.
    expect(store.listMateTurnEvidence(opened.id).map(one => [one.ordinal, one.artifact, one.taskId, one.run, one.format])).toEqual(shots.slice(0, RESULT_IMAGES_PER_TURN_CAP).map((id, index) => [index, id, "alpha", run, "png"]));
    expect(executeMateTool({ ...base, selectEvidence, mediaDelivery: "documents" }, "get_result_images", { task: "alpha", run })).toMatchObject({ ok: true });
    expect(store.listMateTurnEvidence(opened.id)).toHaveLength(RESULT_IMAGES_PER_TURN_CAP);
    // The console and the CLI: the same selection and identity, and an honest word that nothing is downloaded from here.
    const console_ = executeMateTool({ ...base, selectEvidence }, "get_result_images", { task: "alpha", run });
    expect(console_).toMatchObject({ ok: true, body: { run, imageCount: RESULT_IMAGES_PER_TURN_CAP + 1, delivery: "This surface does not send image files. Name the result so the operator can open it." } });
    expect(executeMateTool(base, "get_result_images", { task: "alpha" })).toMatchObject({ ok: true, body: { run, delivery: "This surface does not send image files. Name the result so the operator can open it." } });
    expect(executeMateTool(base, "get_result_images", { task: "nope" })).toEqual({ ok: false, message: "That task is not in your projects." });
    expect(executeMateTool(base, "get_result_images", { task: "alpha", run: 0 })).toEqual({ ok: false, message: "Choose a task and valid result number." });
    // A failed turn keeps nothing: the selection is deleted with the drafts, and a turn that is not running records nothing.
    expect(store.finalizeMateTurn(opened.id, started.generation, { state: "failed", settledMicrousd: 0, tokensIn: 1, tokensOut: 1, failureReason: "provider-error" }, T0)).toBe(true);
    expect(store.listMateTurnEvidence(opened.id)).toEqual([]);
    expect(selectEvidence([{ taskId: "alpha", taskRef: alpha, run, artifact: shots[0]!, sha256: "a".repeat(64), format: "png", bytes: 1, caption: "x" }])).toBe(0);
  });
});
