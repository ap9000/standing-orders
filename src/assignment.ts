/** One assignment follows the existing task family. It owns no execution,
 * approval or proof state. Lead ownership and exact receipt acknowledgments
 * are append-only actions; handoffs use the existing durable outbox. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readSchemaVersion, type Store, type ProofVerdictRow, type ProofAcceptanceRow, type Artifact } from "./store.js";
import { approvalOf } from "./scope.js";
import { openWorkDecisionOf, taskWorkSummaryOf, workDecisionAction, type WorkAction, type WorkSummaryAccess } from "./work-summary.js";
import { evidenceRoot, readVerifiedArtifact, readVerifiedReport } from "./evidence.js";
import { verificationEvidence } from "./verification-evidence.js";
import { reproveApprover, type VerifiedApprover } from "./principal.js";
import { noteAssignmentStatus } from "./assignment-status.js";
import { historicalAssessmentReason } from "./assignment-presentation.js";

export type AssignmentAccess = WorkSummaryAccess;
export type AssignmentOwner = { kind: "coordinator" | "lead"; id: string; label: string };
export type AssignmentChecks = {
  status: "passed" | "failed" | "not-run" | "unavailable";
  exitCode: number | null; command: string | null; logArtifactId: number | null; detail: string;
};
export type AssignmentReceipt = {
  digest: string; rootId: string; taskId: string; runId: number;
  base: string | null; head: string | null; scopeDigest: string | null;
  proof: ProofVerdictRow | null;
  completionKind: "verified-build" | "checked-build" | "finished-build" | "research-report" | "accepted-exception" | null;
  proofAcceptance: ProofAcceptanceRow | null;
  checks: AssignmentChecks;
  artifacts: { id: number; kind: string; sha256: string; bytes: number; complete: boolean }[];
  caveats: string[]; agentReport: string | null; evidence: "recorded";
};
export type AssignmentSnapshot = {
  version: 1; rootId: string; activeTaskId: string; repo: string | null; title: string;
  state: "working" | "checking" | "needs-decision" | "ready-to-check" | "complete" | "cancelled";
  detail: string; primaryAction: WorkAction | null; attention: string[];
  attempts: { taskId: string; runId: number | null; label: string; detail: string }[];
  owner: (AssignmentOwner & { active: boolean }) | null;
  receipt: AssignmentReceipt | null;
  savedContext?: {
    goal: string | null; outOfScope: string | null;
    excerpts: { artifactId: number; runId: number; kind: string; sha256: string; text: string | null; shortened: boolean; problem: string | null }[];
  };
  completion: { actor: string; at: string; digest: string } | null;
  handoff: { kind: "result" | "decision" | "attention"; digest: string; acknowledged: boolean } | null;
  publication: { state: string; prUrl: string | null; remoteState: string | null } | null;
  deployment: { status: "not-recorded" };
};

/** Status-first handoff for routine reads. Fetch get_assignment only when
 * inspecting its exact evidence; do not repeat a full proof in every poll. */
export function assignmentBrief(assignment: AssignmentSnapshot | null) {
  if (assignment === null) return null;
  const receipt = assignment.receipt;
  return { version: assignment.version, rootId: assignment.rootId, activeTaskId: assignment.activeTaskId,
    state: assignment.state, detail: assignment.detail, owner: assignment.owner, primaryAction: assignment.primaryAction,
    attention: assignment.attention, attempts: assignment.attempts.length, handoff: assignment.handoff, completion: assignment.completion,
    result: receipt === null ? null : { digest: receipt.digest, taskId: receipt.taskId, runId: receipt.runId,
      base: receipt.base, head: receipt.head, completionKind: receipt.completionKind,
      checks: receipt.checks, proofAcceptance: receipt.proofAcceptance, verdict: receipt.proof?.verdict ?? null,
      criteria: { passed: receipt.proof?.matrix.filter(row => row.state === "pass").length ?? 0, total: receipt.proof?.matrix.length ?? 0 }, evidence: receipt.evidence },
    publication: assignment.publication, deployment: assignment.deployment };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const OWNER_ACTION = "assignment claimed";
const CHECK_ACTION = "assignment handoff checked";
const actorOf = (owner: AssignmentOwner) => `${owner.kind}:${owner.id}`;

function ownerOf(store: Store, rootId: string, repo: string | null): AssignmentSnapshot["owner"] {
  // The release verifier reads the new projection against the still-running
  // v70 Store before migrating a backup. That read cannot invent team tables.
  const hasTeam = store.handle.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_task_owner'").get() !== undefined;
  if (!hasTeam) {
    const version = readSchemaVersion(store.handle);
    if (!version.ok || version.version !== 70) throw new Error("Team ownership history is missing; refusing to recreate it.");
  }
  const team = hasTeam ? store.handle.prepare("SELECT l.id,l.name,l.status FROM team_task_owner o JOIN team_lead l ON l.id=o.lead JOIN task_ref r ON r.id=o.task_ref WHERE r.backend='built-in' AND r.external_id=? AND r.repo IS ?").get(rootId,repo) : undefined;
  if (team) return { kind: "lead", id: String(team["id"]), label: String(team["name"]), active: team["status"] === "active" };
  const claim = store.handle.prepare("SELECT actor FROM action_ledger WHERE task_id = ? AND action = ? AND source = 'work' ORDER BY id DESC LIMIT 1").get(rootId, OWNER_ACTION);
  const origin = store.lookupRef(rootId)?.coordinatorCid;
  const id = claim === undefined ? origin : String(claim["actor"]).replace(/^coordinator:/, "");
  if (!id) return null;
  const credential = store.handle.prepare("SELECT name,repos,revoked_at FROM coordinator_credential WHERE cid = ?").get(id);
  let repos: unknown = [];
  try { repos = JSON.parse(String(credential?.["repos"] ?? "[]")); } catch { /* unavailable owner stays inactive */ }
  return { kind: "coordinator", id, label: String(credential?.["name"] ?? "Former lead"),
    active: credential !== undefined && credential["revoked_at"] === null && repo !== null && Array.isArray(repos) && repos.includes(repo) };
}

// Report the recorded check outcome, never turn a model verdict into a check.
function nativeChecks(store: Store, root: string | undefined, runId: number): AssignmentChecks {
  const unavailable = (detail: string): AssignmentChecks => ({ status: "unavailable", exitCode: null, command: null, logArtifactId: null, detail });
  if (root === undefined) return unavailable("Saved checks are unavailable.");
  try {
    const gate = verificationEvidence(store, root, runId);
    if (!gate.ok) return unavailable(gate.problem);
    const receipt = gate.bytes === null ? null : JSON.parse(gate.bytes);
    if (receipt === null) return { ...unavailable("No machine check is recorded."), status: "not-run" };
    const ran = receipt.result.ran === true, exitCode = ran ? receipt.result.exitCode : null;
    return { status: ran ? exitCode === 0 ? "passed" : "failed" : "not-run", exitCode,
      command: receipt.command.command, logArtifactId: receipt.log.artifactId,
      detail: ran ? exitCode === 0 ? "Checks passed." : `Checks failed (exit ${exitCode}).` : "Checks did not finish." };
  } catch { return unavailable("Saved checks could not be read."); }
}

export function assignmentOf(store: Store, taskId: string, now: Date, access: AssignmentAccess, root?: string): AssignmentSnapshot | null {
  const family = store.taskFamilyOf(taskId, access.repos, access.principal === "operator" && access.includeUnplaced === true);
  if (family === null) return null;
  const current = family.current;
  const work = taskWorkSummaryOf(store, current.id, now, access);
  if (work === null) return null;
  const result = work.resultRunId === null ? null : store.getRun(work.resultRunId);
  const proof = result === null ? null : store.proofVerdictFor(result.id);
  const acceptance = result === null ? null : store.proofAcceptance(result.id);
  const scope = store.getScope(current.id);
  const owner = ownerOf(store, family.root.id, current.repo);
  const attention: string[] = family.problem === null ? [] : [family.problem];
  // Family admission above precedes question bodies. The newest result
  // does not settle an unanswered question on any earlier version.
  const questions = [current, ...family.versions.filter(version => version.id !== current.id)].flatMap(version => {
    const decision = openWorkDecisionOf(store, version.refId, now);
    return decision === null ? [] : [{ taskId: version.id, decision }];
  });
  // A finished task label cannot hide a lease or an unfinished process record.
  const earlierActive = family.versions.filter(version => version.id !== current.id &&
    (version.state === "queued" || version.state === "running" || store.currentLiveLease(version.refId, now) !== null ||
      store.runsFor(version.refId).some(run => run.outcome === null || store.stopQuiescenceProblem(run.id) !== null)));
  const unfinished = store.runsFor(current.refId).find(run => run.outcome === null) ?? null;
  const attempts = family.versions.map(version => {
    const summary = version.id === current.id ? work : taskWorkSummaryOf(store, version.id, now, access);
    return { taskId: version.id, runId: summary?.liveRunId ?? summary?.resultRunId ?? null,
      label: summary?.status.label ?? version.state, detail: summary?.status.detail ?? "Status is unavailable." };
  });
  const artifacts = result === null ? [] : store.artifactsFor(result.id);
  const reports = artifacts.filter(a => a.kind === "report");
  const unavailable = family.versions.flatMap(version => store.runsFor(version.refId).flatMap(run =>
    store.artifactsFor(run.id).filter(artifact => root === undefined || !readVerifiedArtifact(root, artifact).ok)
      .map(artifact => `Saved ${artifact.kind} #${artifact.id} (run ${run.id}) is unavailable or changed.`)));
  const checks = result === null ? null : nativeChecks(store, root, result.id);
  const finishedBuild = result?.role === "builder" && (result.outcome === "built" || result.outcome === "no-change") &&
    result.finishedAt !== null && /^[a-f0-9]{40}$/.test(result.headRevision ?? "");
  // Finished work returns to its lead or user. Strict terms and previous model
  // judgments stay recorded; neither is a second execution stage for handoff.
  const completionKind: AssignmentReceipt["completionKind"] = result?.role === "scout" && result.outcome === "built" && result.finishedAt !== null ? "research-report"
    : finishedBuild && acceptance !== null ? "accepted-exception"
    : finishedBuild ? checks?.status === "passed" ? "checked-build" : "finished-build" : null;
  const receiptBody = result === null ? null : {
    rootId: family.root.id, taskId: current.id, runId: result.id, base: result.baseRevision,
    head: result.headRevision, scopeDigest: result.scopeDigest ?? null, proof, completionKind, proofAcceptance: acceptance, checks: checks!,
    artifacts: artifacts.map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256, bytes: a.bytesStored,
      complete: !a.truncated && a.captureStatus !== "failed" })),
    // Stored verdict limitations are separate from the agent's outcome.
    // Full agent caveats remain in the referenced proof artifact.
    caveats: [...(proof?.reasons ?? []), ...unavailable,
      ...(completionKind === "research-report" && reports.length !== 1 ? ["The report artifact is missing or ambiguous."] : []), ...(completionKind === "accepted-exception" && !artifacts.some(a => a.kind === "proof") ? ["No builder proof artifact is recorded."] : []),
      ...(artifacts.some(a => a.kind === "check-log" && a.truncated) ? ["The check log was shortened when stored; only the retained output is available."] : []),
      ...artifacts.filter(a => a.kind !== "check-log" && (a.truncated || a.captureStatus === "failed")).map(a => `Saved ${a.kind} #${a.id} is ${a.captureStatus === "failed" ? "a failed capture" : "incomplete"}.`)],
    agentReport: result.handoff, evidence: "recorded" as const,
  };
  const receipt = receiptBody === null ? null : { ...receiptBody, digest: digest({ receipt: receiptBody,
    scope: scope === null ? null : { digest: scope.digest, approved: approvalOf(scope).approved, termsProblem: scope.termsProblem ?? null },
    versions: family.versions.map(v => ({ id: v.id, state: v.state })) }) };
  let completion: AssignmentSnapshot["completion"] = null;
  let state: AssignmentSnapshot["state"] = "working";
  let detail = work.status.detail;
  let primaryAction = work.primaryAction;
  const live = work.liveRunId !== null || work.status.token === "running";
  const processProblem = result === null ? null : store.stopQuiescenceProblem(result.id);
  // The exact completed result, scope, family and custody fences apply to
  // every deliverable. Human acceptance remains its own recorded authority;
  // it never changes a machine verdict or supplies a missing report.
  const ready = current.state === "done" && result !== null && completionKind !== null &&
    scope !== null && scope.termsProblem == null && approvalOf(scope).approved && scope.digest === result.scopeDigest &&
    store.activeHolds(current.refId, now).length === 0 && store.applicableStopFor(result.id) === null &&
    processProblem === null &&
    family.problem === null && earlierActive.length === 0 && unfinished === null && store.currentLiveLease(current.refId, now) === null && questions.length === 0;
  if (family.problem !== null) state = "needs-decision";
  else if (current.state === "cancelled") {
    state = "cancelled";
    detail = "This assignment was cancelled.";
    primaryAction = { code: "inspect-task", label: "View assignment", target: { taskId: current.id, runId: null, decisionId: null }, access: "read", retry: "read-again" };
  }
  else if (!live && processProblem !== null && result !== null) {
    state = "needs-decision";
    detail = processProblem;
    primaryAction = { code: "inspect-run", label: "Inspect run", target: { taskId: current.id, runId: result.id, decisionId: null }, access: "read", retry: "read-again" };
  }
  else if (current.state === "done" && questions.length > 0 && work.status.tone !== "problem" &&
    !["stopping", "stopped", "review-failed", "review-exhausted"].includes(work.status.token) &&
    store.activeHolds(current.refId, now).length === 0 && (result === null || store.applicableStopFor(result.id) === null)) {
    const question = questions[0]!;
    state = "needs-decision";
    detail = question.decision.question;
    primaryAction = workDecisionAction(question.taskId, question.decision, access.principal);
  }
  else if (ready && receipt !== null) {
    state = "ready-to-check";
    detail = completionKind === "research-report" ? "The research report is ready for the lead to read."
      : completionKind === "accepted-exception" ? "An operator accepted this result with its recorded limitations. The lead can inspect that decision; the recorded checks are unchanged."
      : receipt.checks.detail;
    primaryAction = { code: "open-result", label: completionKind === "research-report" ? "Read report" : receipt.checks.status === "failed" ? "Inspect failed check" : completionKind === "accepted-exception" ? "Review acceptance" : "Open result", target: { taskId: current.id, runId: result!.id, decisionId: null }, access: "read", retry: "read-again" };
    const checked = store.handle.prepare("SELECT actor,at FROM action_ledger WHERE task_id = ? AND run_id = ? AND action = ? AND outcome = ? AND source = 'work' ORDER BY id DESC")
      .all(family.root.id, result!.id, CHECK_ACTION, receipt.digest).find(row => /^(operator|coordinator|lead):.+/.test(String(row["actor"])));
    // This ledger fact was authorized when written. Credential rotation,
    // membership changes and ownership transfer cannot revoke past completion.
    // The exact result digest still fences changes to work, scope and history.
    if (checked !== undefined) {
      completion = { actor: String(checked["actor"]), at: String(checked["at"]), digest: receipt.digest };
      state = "complete";
      primaryAction = { ...primaryAction, label: completionKind === "research-report" ? "Read report" : "Open result" };
      const label = completion.actor.startsWith("operator:") ? completion.actor.slice(9) : owner && completion.actor === actorOf(owner) ? owner.label : "the previous lead";
      detail = completionKind === "research-report" ? `Research report checked by ${label}. No deployment is implied.`
        : `Handled by ${label}. ${receipt.checks.detail} Publication and deployment are separate.`;
    }
  } else if (work.status.rank === 0 || (!live && (current.state === "done" || current.state === "failed" || work.status.views.includes("needs-you")))) {
    state = "needs-decision";
    if (current.state === "done" && work.status.tone !== "attention" && work.status.tone !== "problem") detail = result?.role === "scout"
      ? completionKind === null ? "The research report is missing or incomplete. Inspect the saved report before checking this handoff."
        : "The saved report is awaiting resolution of its current scope or hold."
      : "Inspect the saved result and resolve its remaining execution or scope issue.";
  }
  if (earlierActive.length > 0) {
    attention.push(`${earlierActive.length} earlier task version${earlierActive.length === 1 ? " is" : "s are"} still active.`);
    if (state === "ready-to-check" || state === "complete" || current.state === "done") {
      state = "needs-decision";
      detail = "Earlier work is still active. Resolve it before completing this assignment.";
      const earlier = earlierActive[0]!;
      primaryAction = taskWorkSummaryOf(store, earlier.id, now, access)?.primaryAction ?? {
        code: "inspect-task", label: "Review active work", target: { taskId: earlier.id, runId: null, decisionId: null }, access: "read", retry: "read-again",
      };
    }
  }
  if (state === "needs-decision") attention.push(detail);
  if (receipt !== null) {
    if (finishedBuild && receipt.checks.status !== "passed") attention.push(receipt.checks.detail);
    if (proof?.verdict !== "verified") attention.push(...(proof?.reasons ?? []).filter(reason => !historicalAssessmentReason(reason)));
    attention.push(...receipt.caveats.filter(reason => !proof?.reasons.includes(reason)));
  }
  if (state !== "complete") completion = null;
  if (current.state !== "cancelled") attention.push(...questions.map(question => question.decision.question));
  if (owner !== null && !owner.active) attention.push(owner.kind === "lead" ? "This lead is paused. A manager can resume it or transfer responsibility." : "The previous lead no longer has access. Another lead can claim this assignment.");
  const handoff = state === "ready-to-check" || state === "complete" ? { kind: "result" as const, digest: receipt!.digest, acknowledged: state === "complete" }
    : state === "cancelled" ? { kind: "attention" as const, digest: digest({ root: family.root.id, current: current.id, state }), acknowledged: false }
    : state === "needs-decision" ? { kind: primaryAction?.target.decisionId != null ? "decision" as const : "attention" as const,
      digest: digest({ root: family.root.id, current: current.id, detail,
        action: primaryAction === null ? null : { code: primaryAction.code, target: primaryAction.target },
        attention, receipt: receipt?.digest ?? null }), acknowledged: false } : null;
  const publication = result === null ? null : store.publicationForRun(result.id);
  // Existing saved inputs and output, read only after family admission. Keep
  // polling briefs small; full reads disclose exactly which excerpts are shortened.
  const planId = result?.planRevision == null ? null : store.getPlanRevision(result.planRevision)?.artifact;
  const plan = planId == null ? store.latestPlanArtifact(current.refId) : store.getArtifact(planId);
  const selected = [plan, ...["terminal-diff", "check-log", "report", "handoff"].map(kind =>
    artifacts.filter(artifact => artifact.kind === kind).at(-1) ?? null)].filter((one): one is Artifact => one !== null);
  const savedContext = { goal: scope?.goal ?? null, outOfScope: scope?.outOfScope ?? null,
    excerpts: selected.map(artifact => {
      const read = root === undefined ? null : readVerifiedArtifact(root, artifact);
      const text = read?.ok ? read.content.toString("utf8") : null;
      return { artifactId: artifact.id, runId: artifact.run, kind: artifact.kind, sha256: artifact.sha256,
        text: text?.slice(0, 8000) ?? null, shortened: artifact.truncated || (text?.length ?? 0) > 8000,
        problem: read?.ok ? artifact.captureStatus === "failed" ? "The original capture failed." : null : "Saved bytes are unavailable or changed." };
    }) };
  return { version: 1, rootId: family.root.id, activeTaskId: current.id, repo: current.repo, title: family.root.title,
    state, detail, primaryAction, attention: [...new Set(attention)], attempts, owner, receipt, savedContext, completion, handoff,
    publication: publication === null ? null : { state: publication.state, prUrl: publication.prUrl, remoteState: publication.remoteState },
    deployment: { status: "not-recorded" } };
}

type MutationResult = { ok: true; assignment: AssignmentSnapshot } | { ok: false; reason: string; message: string };
function admittedOwner(store: Store, taskId: string, owner: AssignmentOwner, now: Date, root?: string): AssignmentSnapshot | null {
  if (owner.kind !== "coordinator") return null; // A stable lead is identity, not a bearer credential.
  const row = store.handle.prepare("SELECT repos, revoked_at FROM coordinator_credential WHERE cid = ?").get(owner.id);
  if (row === undefined || row["revoked_at"] !== null) return null;
  let repos: unknown;
  try { repos = JSON.parse(String(row["repos"])); } catch { return null; }
  if (!Array.isArray(repos) || repos.some(r => typeof r !== "string")) return null;
  return assignmentOf(store, taskId, now, { principal: "coordinator", repos }, root);
}
export function claimAssignment(store: Store, taskId: string, owner: AssignmentOwner, now: Date, root?: string): MutationResult {
  return store.transact(() => {
    const current = admittedOwner(store, taskId, owner, now, root);
    if (current === null) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    if (current.owner?.kind === "lead" || current.owner?.active && current.owner.id !== owner.id) return { ok: false, reason: "owned", message: "Another lead already owns this assignment." };
    if (current.owner?.id !== owner.id) {
      store.recordAction({ at: now.toISOString(), actor: actorOf(owner), repo: current.repo,
        taskId: current.rootId, runId: null, action: OWNER_ACTION, outcome: "owner", source: "work" });
      store.bumpWake();
    }
    const assignment = admittedOwner(store, current.rootId, owner, now, root)!;
    noteAssignmentHandoff(store, assignment, now);
    noteAssignmentStatus(store, assignment, now);
    return { ok: true, assignment };
  });
}

/** Diagnostic only: artifact availability does not authorize or block a human
 * handoff. Deployment independently validates its actual native check. */
export function assignmentEvidenceIntact(store: Store, root: string, receipt: AssignmentReceipt): boolean {
  try {
    const family = store.taskFamilyOf(receipt.taskId, null, true);
    if (family === null || family.problem !== null || family.root.id !== receipt.rootId ||
      !family.versions.every(version => store.runsFor(version.refId).every(run =>
        store.artifactsFor(run.id).every(artifact => readVerifiedArtifact(root, artifact).ok)))) return false;
    if (receipt.completionKind === "research-report") {
      const report = readVerifiedReport(store, root, store.lookupRef(receipt.taskId)!.id);
      return report?.ok === true && report.run === receipt.runId;
    }
    return receipt.completionKind !== null;
  } catch { return false; }
}

function acknowledgeCurrent(store: Store, current: AssignmentSnapshot, receiptDigest: string, actor: string, now: Date, root: string, access: AssignmentAccess): MutationResult {
  if (!/^[a-f0-9]{64}$/.test(receiptDigest) || current.receipt?.digest !== receiptDigest) return { ok: false, reason: "stale", message: "The result changed. Read the current assignment before checking it." };
  const receipt = current.receipt;
  if (current.state !== "ready-to-check" && current.state !== "complete") return { ok: false, reason: "not-ready", message: "This assignment still has unresolved execution, scope or decisions." };
  if (current.state !== "complete") {
    store.recordAction({ at: now.toISOString(), actor, repo: current.repo,
      taskId: current.rootId, runId: receipt.runId, action: CHECK_ACTION, outcome: receiptDigest, source: "work" });
    store.bumpWake();
  }
  const assignment = assignmentOf(store, current.rootId, now, access, root)!;
  noteAssignmentStatus(store, assignment, now);
  return { ok: true, assignment };
}

export function checkAssignment(store: Store, taskId: string, receiptDigest: string, owner: AssignmentOwner, now: Date, root = evidenceRoot(homedir())): MutationResult {
  return store.transact(() => {
    const current = admittedOwner(store, taskId, owner, now, root);
    if (current === null) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    if (current.owner?.kind !== owner.kind || current.owner.id !== owner.id || !current.owner.active) return { ok: false, reason: "not-owner", message: "Claim this assignment before checking its handoff." };
    return acknowledgeCurrent(store, current, receiptDigest, actorOf(owner), now, root, { principal: "coordinator", repos: [current.repo!] });
  });
}

/** The signed-in user can mark the same exact receipt handled without taking
 * lead ownership. This records review, never check success or new authority. */
export function checkAssignmentAsOperator(store: Store, taskId: string, receiptDigest: string, who: VerifiedApprover, now: Date, root = evidenceRoot(homedir())): MutationResult {
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, reason: "unauthenticated", message: "Sign in again before marking this result complete." };
    const access: AssignmentAccess = { principal: "operator", repos: who.repos };
    const current = assignmentOf(store, taskId, now, access, root);
    if (current === null || !store.accountCanAccess(who.name, current.repo)) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    return acknowledgeCurrent(store, current, receiptDigest, `operator:${who.name}`, now, root, access);
  });
}

function noteAssignmentHandoff(store: Store, assignment: AssignmentSnapshot, now: Date): void {
  if (!assignment.owner?.active || assignment.handoff === null || assignment.handoff.acknowledged) return;
  const ref = store.lookupRef(assignment.rootId);
  if (!ref || !ref.repo) return;
  store.enqueueNotification({ dedupeKey: `assignment:${ref.id}:${assignment.owner.id}:${assignment.handoff.digest}`,
    kind: "assignment-handoff", source: { taskRef: ref.id }, subject: assignment.state === "cancelled" ? "Assignment cancelled" : assignment.state === "ready-to-check" ? "Ready" : "Assignment needs a decision",
    body: assignment.detail, link: `/t/${encodeURIComponent(assignment.rootId)}` }, now);
}

/** The ordinary worker reconciles at most 50 owned roots per pass. A lost
 * wakeup is recovered after restart; immutable notification keys dedupe it. */
export function syncAssignmentHandoffs(store: Store, now: Date, repos: readonly string[], root?: string): void {
  if (repos.length === 0) return;
  store.transact(() => {
  const key = `assignment-handoff:${digest([...new Set(repos)].sort())}`;
  const cursor = store.serviceCursor(key);
  const rows = store.handle.prepare(`SELECT t.id,t.external_id FROM task_ref t WHERE t.backend = 'built-in' AND t.revision_of IS NULL
    AND t.repo IN (SELECT value FROM json_each(?)) AND t.id > ?
    AND (t.coordinator_cid IS NOT NULL OR EXISTS(SELECT 1 FROM team_task_owner o WHERE o.task_ref=t.id) OR EXISTS (SELECT 1 FROM action_ledger a WHERE a.task_id = t.external_id AND a.action = ?))
    ORDER BY t.id LIMIT 50`).all(JSON.stringify(repos), cursor, OWNER_ACTION);
  for (const row of rows) {
    const assignment = assignmentOf(store, String(row["external_id"]), now, { principal: "operator", repos }, root);
    if (assignment !== null) {
      noteAssignmentHandoff(store, assignment, now);
      noteAssignmentStatus(store, assignment, now);
    }
  }
  store.setServiceCursor(key, rows.length < 50 ? 0 : Number(rows.at(-1)!["id"]), now);
  });
}

export function assignmentUpdates(store: Store, now: Date, access: AssignmentAccess, query: { after: number; limit: number }, root?: string) {
  const after = Number.isSafeInteger(query.after) && query.after >= 0 ? query.after : 0;
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit) || 50));
  const rows = store.handle.prepare(`SELECT n.id,n.task_id,n.dedupe_key,n.created_at FROM notification n
    JOIN task_ref t ON t.id = n.task_ref AND t.backend = 'built-in' AND t.external_id = n.task_id AND t.repo = n.project
    WHERE n.id > ? AND n.kind = 'assignment-handoff' AND n.provenance_scope = 'task'
      AND (? = 1 OR n.project IN (SELECT value FROM json_each(?))) ORDER BY n.id LIMIT ?`)
    .all(after, access.repos === null ? 1 : 0, JSON.stringify(access.repos ?? []), limit + 1);
  const page = rows.slice(0, limit);
  const events = page.flatMap(row => {
    const assignment = assignmentOf(store, String(row["task_id"]), now, access, root);
    if (assignment === null) return [];
    const parts = String(row["dedupe_key"]).split(":");
    const receiptDigest = parts.at(-1)!;
    return [{ id: Number(row["id"]), createdAt: String(row["created_at"]), rootId: assignment.rootId, digest: receiptDigest,
      superseded: assignment.handoff?.digest !== receiptDigest || assignment.owner?.id !== parts.at(-2), assignment: assignmentBrief(assignment)! }];
  });
  return { events, nextCursor: page.length === 0 ? after : Number(page.at(-1)!["id"]), hasMore: rows.length > limit };
}
