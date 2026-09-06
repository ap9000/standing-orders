import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, canonicalProfileJson, profileFromJson, propose } from "./scope.js";
import { previewExecutionChange, approveExecutionChange } from "./control-terms.js";
import { previewDelivery, approveDelivery } from "./delivery.js";
import { invokeAgent } from "./invoke.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";

const now = new Date("2026-09-05T12:00:00Z");
let store: Store;
let token: string;
beforeEach(() => {
  store = openStore(":memory:");
  const operator = addApprover(store, "alex", now);
  if (!operator.ok) throw new Error("fixture");
  token = operator.token;
  store.createTask({ id: "task", title: "Ship the fix" }, now);
  store.placeTask(store.refFor("built-in", "task").id, "/repo");
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", now);
  const scope = propose(store, { taskId: "task", goal: "Fix the bug", touches: ["src"], now });
  approve(store, "task", "alex", now, scope.digest, token);
});
afterEach(() => store.close());
const inputs = { model: "sonnet", turns: "350", minutes: "45", posture: "safe", tools: "Bash(npm test:*)\nBash(git status:*)" };

test("settings preview is read-only; invalid credentials leave the prior approval intact", () => {
  const before = store.getScope("task");
  const preview = previewExecutionChange(store, "task", inputs, now);
  if (!preview.ok) throw new Error(preview.message);
  expect(store.getScope("task")).toEqual(before);
  const changed = approveExecutionChange(store, { taskId: "task", inputs, fingerprint: preview.fingerprint, by: "alex", token: "wrong", resume: true, now });
  expect(changed.ok).toBe(false);
  expect(store.getScope("task")).toEqual(before);
});

test("approving settings binds exact tool rules and limits without enabling automatic scope approval", () => {
  const preview = previewExecutionChange(store, "task", inputs, now);
  if (!preview.ok) throw new Error(preview.message);
  store.hold(store.refFor("built-in", "task").id, "Paused", null, now);
  expect(approveExecutionChange(store, { taskId: "task", inputs, fingerprint: preview.fingerprint, by: "alex", token, resume: true, now })).toEqual({ ok: true });
  const scope = store.getScope("task")!;
  expect(scope.approvedDigest).toBe(preview.digest);
  expect(scope.approvedProfile).toMatchObject({ maxTurns: 350, timeoutSeconds: 2700, permissionArgv: "acceptEdits", allowedTools: ["Bash(npm test:*)", "Bash(git status:*)"] });
  expect(profileFromJson(canonicalProfileJson(scope.approvedProfile!))).toEqual(scope.approvedProfile);
  expect(store.activeMode("/repo", now)).toBeNull();
  expect(store.activeHolds(store.refFor("built-in", "task").id, now)).toHaveLength(0);
});

test("an altered setting cannot use an earlier approval preview", () => {
  const preview = previewExecutionChange(store, "task", inputs, now);
  if (!preview.ok) throw new Error(preview.message);
  const before = store.getScope("task");
  expect(approveExecutionChange(store, { taskId: "task", inputs: { ...inputs, posture: "escalated" }, fingerprint: preview.fingerprint, by: "alex", token, resume: false, now }).ok).toBe(false);
  expect(store.getScope("task")).toEqual(before);
});

test("settings can repair an unresolved model and cannot silently ignore expanded permissions", () => {
  store.setPhaseConfig("installation", "build", "claude", null, "alex", now);
  propose(store, { taskId: "task", goal: "Fix the bug", touches: ["src"], now });
  expect(store.getScope("task")?.profile).toBeNull();
  const repaired = previewExecutionChange(store, "task", inputs, now);
  expect(repaired.ok).toBe(true);
  if (repaired.ok) expect(repaired.profile.model).toBe(inputs.model);
  store.setPhaseConfig("installation", "build", "codex", "gpt-5.4", "alex", now);
  propose(store, { taskId: "task", goal: "Fix the bug", touches: ["src"], now });
  expect(store.getScope("task")?.profile?.provider).toBe("codex");
  const changed = previewExecutionChange(store, "task", { ...inputs, model: "gpt-5.4", tools: "", posture: "escalated" }, now);
  expect(changed.ok).toBe(false);
  expect(previewExecutionChange(store, "task", { ...inputs, model: "gpt-5.4", tools: "" }, now).ok).toBe(true);
});

test("approved named tools reach the Claude invocation as individual argv entries", async () => {
  const ref = store.refFor("built-in", "task").id;
  register(store, { name: "worker", host: "test", capacity: 1, repos: ["/repo"], now, newToken: () => "worker-token" });
  const claim = acquire(store, ref, "worker", { now, token: "worker-token" });
  if (!claim.ok) throw new Error(claim.reason);
  const runId = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "worker", branch: "standing-orders/task", worktree: "/work", now });
  let seen: readonly string[] = [];
  await invokeAgent(store, runId, { provider: "claude", model: "sonnet" }, { phase: "build", brief: "fixture", maxTurns: 350, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null, allowedTools: ["Bash(npm test:*)", "Bash(git status:*)"] },
    { clock: () => now, runner: async (_file, args) => { seen = args; return { code: 0, stdout: JSON.stringify({ result: "done" }), stderr: "", timedOut: false, notFound: false }; } });
  const index = seen.indexOf("--allowedTools");
  expect(seen.slice(index, index + 3)).toEqual(["--allowedTools", "Bash(npm test:*)", "Bash(git status:*)"]);
  expect(seen).not.toContain("--dangerously-skip-permissions");
});

test("publication is prepared for the accepted commit and requires the exact reviewed terms", () => {
  const ref = store.refFor("built-in", "task").id;
  const runId = store.startRun({ taskRef: ref, leaseId: "finished", runner: "worker", branch: "standing-orders/task", worktree: "/work", now });
  store.recordOutcomeFacts(runId, { headRevision: "a".repeat(40), handoff: "Fixed" });
  store.finishRun(runId, { outcome: "built", committed: true, now });
  const terms = { githubRepo: "owner/project", remote: "origin", base: "main", headPrefix: "standing-orders/" };
  const preview = previewDelivery(store, "task", runId, terms);
  if (!preview.ok) throw new Error(preview.message);
  expect(store.publicationForRun(runId)).toBeNull();
  expect(approveDelivery(store, { taskId: "task", runId, terms: { ...terms, githubRepo: "wrong/project" }, fingerprint: preview.fingerprint, by: "alex", token, now }).ok).toBe(false);
  expect(store.publicationGrantFor("/repo")).toBeNull();
  expect(approveDelivery(store, { taskId: "task", runId, terms, fingerprint: preview.fingerprint, by: "alex", token, now }).ok).toBe(true);
  expect(store.publicationForRun(runId)).toMatchObject({ headSha: "a".repeat(40), githubRepo: "owner/project", state: "intended" });
  expect(store.publicationGrantFor("/repo")).toMatchObject({ merge: false, draft: true });
});
