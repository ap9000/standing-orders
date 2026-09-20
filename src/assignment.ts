/** One assignment follows the existing task family. It owns no execution,
 * approval or proof state. Lead ownership and exact receipt acknowledgments
 * are append-only actions; handoffs use the existing durable outbox. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Store, ProofVerdictRow, ProofAcceptanceRow } from "./store.js";
import { approvalOf } from "./scope.js";
import { openWorkDecisionOf, taskWorkSummaryOf, workDecisionAction, type WorkAction, type WorkSummaryAccess } from "./work-summary.js";
import { evidenceRoot, readVerifiedArtifact, readVerifiedProofForRun, readVerifiedReport } from "./evidence.js";
import { verificationEvidence } from "./verification-evidence.js";
import { parseReviewContext, reviewContextCustodyProblem } from "./review-context.js";

export type AssignmentAccess = WorkSummaryAccess;
export type AssignmentOwner = { kind: "coordinator"; id: string; label: string };
export type AssignmentReceipt = {
  digest: string; rootId: string; taskId: string; runId: number;
  base: string | null; head: string | null; scopeDigest: string | null;
  proof: ProofVerdictRow | null;
  completionKind: "verified-build" | "checked-build" | "research-report" | "accepted-exception" | null;
  proofAcceptance: ProofAcceptanceRow | null;
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
    attention: assignment.attention, attempts: assignment.attempts.length, handoff: assignment.handoff,
    result: receipt === null ? null : { digest: receipt.digest, taskId: receipt.taskId, runId: receipt.runId,
      base: receipt.base, head: receipt.head, completionKind: receipt.completionKind,
      proofAcceptance: receipt.proofAcceptance, verdict: receipt.proof?.verdict ?? null,
      criteria: { passed: receipt.proof?.matrix.filter(row => row.state === "pass").length ?? 0, total: receipt.proof?.matrix.length ?? 0 }, evidence: receipt.evidence },
    publication: assignment.publication, deployment: assignment.deployment };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const OWNER_ACTION = "assignment claimed";
const CHECK_ACTION = "assignment handoff checked";
const actorOf = (owner: AssignmentOwner) => `coordinator:${owner.id}`;

function ownerOf(store: Store, rootId: string, repo: string | null): AssignmentSnapshot["owner"] {
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
  const review = result === null ? null : store.reviewRetryStateOf(result.id);
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
      store.runsFor(version.refId).some(run => run.outcome === null)));
  const unfinished = store.runsFor(current.refId).find(run => run.outcome === null) ?? null;
  const attempts = family.versions.map(version => {
    const summary = version.id === current.id ? work : taskWorkSummaryOf(store, version.id, now, access);
    return { taskId: version.id, runId: summary?.liveRunId ?? summary?.resultRunId ?? null,
      label: summary?.status.label ?? version.state, detail: summary?.status.detail ?? "Status is unavailable." };
  });
  const artifacts = result === null ? [] : store.artifactsFor(result.id);
  const reports = artifacts.filter(a => a.kind === "report");
  const verifiedBuild = result?.role === "builder" && (result.outcome === "built" || result.outcome === "no-change") &&
    /^[a-f0-9]{40}$/.test(result.headRevision ?? "") && proof?.verdict === "verified" &&
    scope !== null && scope.acceptance.length > 0 && proof.matrix.length === scope.acceptance.length &&
    scope.acceptance.every(criterion => proof.matrix.some(row => row.id === criterion.id && row.statement === criterion.statement)) &&
    proof.matrix.every(row => row.state === "pass" && row.review?.judgement === "upholds") && review?.state === "succeeded";
  // A completed, machine-checked result is ready for its lead's review.
  // Independent semantic review is a separate, optionally requested result;
  // it must not become a prerequisite for showing the work to its owner.
  const checkedBuild = result?.role === "builder" && (result.outcome === "built" || result.outcome === "no-change") &&
    /^[a-f0-9]{40}$/.test(result.headRevision ?? "") && proof?.machineVerdict === "verified" &&
    proof.verdict !== "refuted" && scope?.qualityMode !== "strict";
  const completionKind: AssignmentReceipt["completionKind"] = result?.role === "scout" && result.outcome === "built" &&
      reports.length === 1 && !reports[0]!.truncated && reports[0]!.captureStatus !== "failed" ? "research-report"
    : result?.role === "builder" && (result.outcome === "built" || result.outcome === "no-change") &&
      /^[a-f0-9]{40}$/.test(result.headRevision ?? "") && acceptance !== null ? "accepted-exception"
    : verifiedBuild ? "verified-build" : checkedBuild ? "checked-build" : null;
  const receiptBody = result === null ? null : {
    rootId: family.root.id, taskId: current.id, runId: result.id, base: result.baseRevision,
    head: result.headRevision, scopeDigest: result.scopeDigest ?? null, proof, completionKind, proofAcceptance: acceptance,
    artifacts: artifacts.map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256, bytes: a.bytesStored,
      complete: !a.truncated && a.captureStatus !== "failed" })),
    // Stored verdict limitations are separate from the agent's outcome.
    // Full agent caveats remain in the referenced proof artifact.
    caveats: [...(proof?.reasons ?? []), ...(completionKind === "accepted-exception" && !artifacts.some(a => a.kind === "proof") ? ["No builder proof artifact is recorded."] : []),
      ...(artifacts.some(a => a.kind === "check-log" && a.truncated) ? ["The check log was shortened when stored; only the retained output is available."] : [])],
    agentReport: result.handoff, evidence: "recorded" as const,
  };
  const receipt = receiptBody === null ? null : { ...receiptBody, digest: digest({ receipt: receiptBody,
    scope: scope === null ? null : { digest: scope.digest, approved: approvalOf(scope).approved, termsProblem: scope.termsProblem ?? null },
    versions: family.versions.map(v => ({ id: v.id, state: v.state })), review }) };
  let state: AssignmentSnapshot["state"] = "working";
  let detail = work.status.detail;
  let primaryAction = work.primaryAction;
  const live = work.liveRunId !== null || work.status.token === "running";
  const checking = review?.state === "queued" || review?.state === "running" || work.status.token === "reviewing";
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
  else if (checking && !["review-failed", "stopping", "stopped"].includes(work.status.token)) {
    state = "checking";
    detail = review?.state === "queued" ? "Independent review is queued." : "Independent review is running.";
  }
  else if (ready && receipt !== null) {
    state = "ready-to-check";
    detail = completionKind === "research-report" ? "The research report is ready for the lead to read."
      : completionKind === "accepted-exception" ? "An operator accepted this result with its recorded limitations. The lead can inspect that decision; the recorded checks are unchanged."
      : completionKind === "checked-build" ? "Checks passed. The result is ready for your review."
      : "Checks and independent review passed. The result is ready for your review.";
    primaryAction = { code: "open-result", label: completionKind === "research-report" ? "Read report" : completionKind === "accepted-exception" ? "Review acceptance" : "Review result", target: { taskId: current.id, runId: result!.id, decisionId: null }, access: "read", retry: "read-again" };
    if (owner?.active && store.handle.prepare("SELECT 1 FROM action_ledger WHERE task_id = ? AND run_id = ? AND actor = ? AND action = ? AND outcome = ? AND source = 'work' LIMIT 1")
      .get(family.root.id, result!.id, actorOf(owner), CHECK_ACTION, receipt.digest)) {
      state = "complete";
      detail = completionKind === "research-report" ? `Research report checked by ${owner.label}. No code change or deployment is implied.`
        : completionKind === "accepted-exception" ? `Recorded acceptance checked by ${owner.label}. The recorded checks and limitations are unchanged.`
        : `Reviewed by ${owner.label}. Deployment is tracked separately.`;
    }
  } else if (work.status.rank === 0 || (!live && (current.state === "done" || current.state === "failed" || work.status.views.includes("needs-you")))) {
    state = "needs-decision";
    if (current.state === "done" && work.status.tone !== "attention" && work.status.tone !== "problem") detail = result?.role === "scout"
      ? completionKind === null ? "The research report is missing or incomplete. Inspect the saved report before checking this handoff."
        : "The saved report is awaiting resolution of its current scope or hold."
      : "The saved result still needs complete checks and independent review.";
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
  // A saved verdict/acknowledgment never substitutes for today's saved bytes.
  // Do this before deriving the handoff so all readers and notices agree.
  if ((state === "ready-to-check" || state === "complete") && receipt !== null &&
    (root === undefined || !assignmentEvidenceIntact(store, root, receipt))) {
    state = "needs-decision";
    detail = "The saved evidence no longer verifies. Review its files and recorded limitations before checking this result.";
    primaryAction = { code: "open-result", label: "Review evidence", target: { taskId: current.id, runId: receipt.runId, decisionId: null }, access: "read", retry: "read-again" };
    const attempt = attempts.find(one => one.taskId === current.id && one.runId === receipt.runId);
    if (attempt) { attempt.label = "Evidence unavailable"; attempt.detail = detail; }
  }
  if (state === "needs-decision") attention.push(detail);
  if (completionKind === "checked-build" && proof?.verdict !== "verified") attention.push(...(proof?.reasons ?? []));
  if (current.state !== "cancelled") attention.push(...questions.map(question => question.decision.question));
  if (owner !== null && !owner.active) attention.push("The previous lead no longer has access. Another lead can claim this assignment.");
  const handoff = state === "ready-to-check" || state === "complete" ? { kind: "result" as const, digest: receipt!.digest, acknowledged: state === "complete" }
    : state === "cancelled" ? { kind: "attention" as const, digest: digest({ root: family.root.id, current: current.id, state }), acknowledged: false }
    : state === "needs-decision" ? { kind: primaryAction?.target.decisionId != null ? "decision" as const : "attention" as const,
      digest: digest({ root: family.root.id, current: current.id, detail,
        action: primaryAction === null ? null : { code: primaryAction.code, target: primaryAction.target },
        attention, receipt: receipt?.digest ?? null }), acknowledged: false } : null;
  const publication = result === null ? null : store.publicationForRun(result.id);
  return { version: 1, rootId: family.root.id, activeTaskId: current.id, repo: current.repo, title: family.root.title,
    state, detail, primaryAction, attention: [...new Set(attention)], attempts, owner, receipt, handoff,
    publication: publication === null ? null : { state: publication.state, prUrl: publication.prUrl, remoteState: publication.remoteState },
    deployment: { status: "not-recorded" } };
}

type MutationResult = { ok: true; assignment: AssignmentSnapshot } | { ok: false; reason: string; message: string };
function admittedOwner(store: Store, taskId: string, owner: AssignmentOwner, now: Date, root?: string): AssignmentSnapshot | null {
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
    if (current.owner?.active && current.owner.id !== owner.id) return { ok: false, reason: "owned", message: "Another lead already owns this assignment." };
    if (current.owner?.id !== owner.id) {
      store.recordAction({ at: now.toISOString(), actor: actorOf(owner), repo: current.repo,
        taskId: current.rootId, runId: null, action: OWNER_ACTION, outcome: "owner", source: "work" });
      store.bumpWake();
    }
    const assignment = admittedOwner(store, current.rootId, owner, now, root)!;
    noteAssignmentHandoff(store, assignment, now);
    return { ok: true, assignment };
  });
}

/** Fresh byte checks for the selected handoff kind. A recorded operator
 * exception can acknowledge missing/truncated proof, never altered saved bytes. */
export function assignmentEvidenceIntact(store: Store, root: string, receipt: AssignmentReceipt): boolean {
  const artifacts = store.artifactsFor(receipt.runId);
  try {
    const savedBytesIntact = artifacts.every(a => readVerifiedArtifact(root, a).ok);
    if (receipt.completionKind === "research-report") {
      const report = readVerifiedReport(store, root, store.lookupRef(receipt.taskId)!.id);
      const reportArtifact = artifacts.find(a => a.kind === "report");
      return savedBytesIntact && report?.ok === true && report.run === receipt.runId && reportArtifact !== undefined &&
        !reportArtifact.truncated && reportArtifact.captureStatus !== "failed";
    } else if (receipt.completionKind === "accepted-exception") {
      // Existing operator acceptance is bound into the digest above. Missing
      // proof and shortened captures stay visible; no new acceptance or
      // passing gate is manufactured by the lead's acknowledgment.
      return savedBytesIntact && receipt.proofAcceptance !== null;
    } else if (receipt.completionKind === "checked-build" || receipt.completionKind === "verified-build") {
      const gate = verificationEvidence(store, root, receipt.runId);
      const verification = gate.ok && gate.bytes !== null ? JSON.parse(gate.bytes) : null;
      const result = verification?.result;
      const readOne = (kind: typeof artifacts[number]["kind"]) => {
        const found = artifacts.filter(a => a.kind === kind);
        if (found.length !== 1 || found[0]!.truncated || (found[0]!.redacted && kind !== "review-context") || found[0]!.captureStatus === "failed") return null;
        const read = readVerifiedArtifact(root, found[0]!);
        return read.ok ? read.content.toString("utf8") : null;
      };
      const source = store.getRun(receipt.runId)!;
      const context = readOne("review-context");
      const parsed = context === null ? null : parseReviewContext(context);
      // A current proof covers its own saved bytes. A revision also retains
      // its ancestors' sealed evidence; recheck that custody before handoff.
      const needsContext = store.revisionSourceOf(source.taskRef) !== null || artifacts.some(a => a.kind === "review-context");
      const contextIntact = parsed?.ok === true && parsed.inventory.run === receipt.runId &&
        reviewContextCustodyProblem(store, root, parsed.inventory) === null;
      if (needsContext && !contextIntact) return false;
      if (receipt.completionKind === "checked-build") {
        // A lead review preserves semantic verdicts and release authority.
        // Both handoff paths retain the exact native check and ancestor custody.
        return savedBytesIntact && verification?.head === receipt.head && result?.ran === true &&
          result.exitCode === 0 && receipt.proof?.machineVerdict === "verified";
      }
      const proof = readVerifiedProofForRun(store, root, receipt.runId);
      let goalEvidence = proof?.ok === true;
      if (proof === null && receipt.proof!.matrix.length > 0 && receipt.proof!.matrix.every(row =>
        row.assessment?.evidenceState === "pass" && row.state === "pass" && row.review?.judgement === "upholds")) {
        // Native direct assessments have no builder proof. Re-prove their
        // original complete inputs and existing context custody instead.
        const stat = readOne("diff-stat");
        const base = source.branch ? store.firstBuilderBase(source.taskRef, source.branch) ?? source.baseRevision : source.baseRevision;
        const inventory = stat === null ? null : JSON.parse(stat);
        goalEvidence = readOne("terminal-diff") !== null && readOne("handoff") !== null && parsed?.ok === true &&
          contextIntact &&
          (parsed.inventory.source.run !== parsed.inventory.run || parsed.inventory.ancestry.verified) &&
          inventory?.schema === 1 && inventory.head === source.headRevision && inventory.base === base && inventory.filesTruncated === false &&
          Array.isArray(inventory.files) && inventory.fileCount === inventory.files.length &&
          inventory.files.every((one: { path?: unknown }) => typeof one?.path === "string") &&
          new Set(inventory.files.map((one: { path: string }) => one.path)).size === inventory.files.length;
      }
      // Native proof correction retains rejected/raw response diagnostics.
      // Their failure or truncation is history, not the final proof's status.
      // Unknown structured artifacts and every required evidence kind stay strict.
      const diagnostic = (a: typeof artifacts[number]) => a.kind === "status" ||
        (a.kind === "structured-output" && /^(builder-proof|planner|reviewer) response \d+ from run \d+ \(/.test(a.capture));
      // The gate above binds the exact retained log and successful exit;
      // native verification deliberately permits a shortened log.
      return goalEvidence && result?.ran === true && result.exitCode === 0 && artifacts.length > 0 &&
        savedBytesIntact && artifacts.every(a => diagnostic(a) || ((!a.truncated || a.kind === "check-log") && a.captureStatus !== "failed"));
    }
    return false;
  } catch { return false; }
}

export function checkAssignment(store: Store, taskId: string, receiptDigest: string, owner: AssignmentOwner, now: Date, root = evidenceRoot(homedir())): MutationResult {
  return store.transact(() => {
    const current = admittedOwner(store, taskId, owner, now, root);
    if (current === null) return { ok: false, reason: "not-found", message: "No assignment is available in your projects." };
    if (current.owner?.id !== owner.id || !current.owner.active) return { ok: false, reason: "not-owner", message: "Claim this assignment before checking its handoff." };
    if (!/^[a-f0-9]{64}$/.test(receiptDigest) || current.receipt?.digest !== receiptDigest) return { ok: false, reason: "stale", message: "The result changed. Read the current assignment before checking it." };
    const receipt = current.receipt;
    const intact = assignmentEvidenceIntact(store, root, receipt);
    if (!intact) {
      return { ok: false, reason: "evidence-unavailable", message: "The saved evidence no longer verifies. Restore or refresh it before checking this handoff." };
    }
    if (current.state !== "ready-to-check" && current.state !== "complete") return { ok: false, reason: "not-ready", message: "This assignment still has unresolved work or verification." };
    if (current.state !== "complete") {
      store.recordAction({ at: now.toISOString(), actor: actorOf(owner), repo: current.repo,
        taskId: current.rootId, runId: receipt.runId, action: CHECK_ACTION, outcome: receiptDigest, source: "work" });
      store.bumpWake();
    }
    return { ok: true, assignment: admittedOwner(store, current.rootId, owner, now, root)! };
  });
}

function noteAssignmentHandoff(store: Store, assignment: AssignmentSnapshot, now: Date): void {
  if (!assignment.owner?.active || assignment.handoff === null || assignment.handoff.acknowledged) return;
  const ref = store.lookupRef(assignment.rootId);
  if (!ref || !ref.repo) return;
  store.enqueueNotification({ dedupeKey: `assignment:${ref.id}:${assignment.owner.id}:${assignment.handoff.digest}`,
    kind: "assignment-handoff", source: { taskRef: ref.id }, subject: assignment.state === "cancelled" ? "Assignment cancelled" : assignment.state === "ready-to-check" ? "Ready for review" : "Assignment needs a decision",
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
    AND (t.coordinator_cid IS NOT NULL OR EXISTS (SELECT 1 FROM action_ledger a WHERE a.task_id = t.external_id AND a.action = ?))
    ORDER BY t.id LIMIT 50`).all(JSON.stringify(repos), cursor, OWNER_ACTION);
  for (const row of rows) {
    const assignment = assignmentOf(store, String(row["external_id"]), now, { principal: "operator", repos }, root);
    if (assignment !== null) noteAssignmentHandoff(store, assignment, now);
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
