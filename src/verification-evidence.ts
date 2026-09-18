/** Machine verification receipts use the existing sealed artifact store (schema
 * 60). Verbose output is independently bounded; no agent-authored check claim
 * can create or replace this receipt. */
import { createHash } from "node:crypto";
import type { Artifact, Store, VerifyCommand } from "./store.js";
import type { VerifyCommandFacts } from "./proof.js";
import { adjudicate, type AdjudicateResult } from "./proof.js";
import { parseReviewContext, reviewContextCustodyProblem } from "./review-context.js";
import { readVerifiedArtifact, storeEvidence, scanForSecrets, redactSecretLines } from "./evidence.js";

export const VERIFICATION_RECEIPT_CAPTURE = "machine verification receipt v1";
export const REVIEW_GATE_NAME = "REVIEW-VERIFICATION.json";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (a: Artifact) => ({ artifactId: a.id, sha256: a.sha256, bytesStored: a.bytesStored, bytesOriginal: a.bytesOriginal, truncated: a.truncated, redacted: a.redacted, captureStatus: a.captureStatus });
export const isVerificationReceipt = (a: Artifact) => a.kind === "structured-output" && a.capture === VERIFICATION_RECEIPT_CAPTURE;

export function sealVerificationReceipt(store: Store, root: string, runId: number, head: string, command: VerifyCommand, result: VerifyCommandFacts, now: Date): void {
  const source = store.getRun(runId)!;
  const log = store.artifactsFor(runId).find(a => a.kind === "check-log");
  if (!log) throw new Error("Verification receipt requires its retained log");
  const raw = JSON.stringify({
    version: 1, run: runId, head, base: source.baseRevision, scopeDigest: source.scopeDigest,
    command, result, log: binding(log),
  }, null, 1);
  const hits = scanForSecrets(raw);
  storeEvidence(store, root, runId, "structured-output", "verification-receipt.json", Buffer.from(hits.length ? redactSecretLines(raw, hits) : raw), VERIFICATION_RECEIPT_CAPTURE, now, { captureStatus: "ok", redacted: hits.length > 0 });
}

/** Read and bind existing evidence, never backfill historical receipts. A legacy
 * single-attempt machine header is sufficient only with its exact approved grant
 * and sealed candidate endpoints. Recovery logs without a receipt stay explicit. */
export function verificationEvidence(store: Store, root: string, runId: number):
  { ok: true; bytes: string | null; digest: string } | { ok: false; problem: string } {
  const fail = (problem: string) => ({ ok: false as const, problem });
  const source = store.getRun(runId);
  if (!source) return fail("The verification source run is missing.");
  const repo = store.refById(source.taskRef)?.repo;
  const command = repo ? store.liveVerifyCommand(repo) : null;
  const artifacts = store.artifactsFor(runId);
  const receipts = artifacts.filter(isVerificationReceipt);
  const machine = store.proofVerdictFor(runId);
  const verified = (machine?.machineVerdict ?? machine?.verdict) === "verified";
  if (!command && !receipts.length && !verified) return { ok: true, bytes: null, digest: hash(null) };
  if (!command || command.approvedAt > source.startedAt) return fail("The original approved verification command is missing or changed.");
  if (receipts.length > 1) return fail("The verification receipt is ambiguous.");
  const logs = artifacts.filter(a => a.kind === "check-log");
  if (logs.length !== 1 || logs[0]!.captureStatus === "failed") return fail("One readable machine verification log is required.");
  const log = logs[0]!;
  const read = readVerifiedArtifact(root, log);
  if (!read.ok) return fail("The retained verification log no longer verifies.");
  let receipt;
  if (receipts.length) {
    const artifact = receipts[0]!;
    if (artifact.truncated || artifact.redacted || artifact.captureStatus === "failed") return fail("The verification receipt is incomplete.");
    const sealed = readVerifiedArtifact(root, artifact);
    if (!sealed.ok) return fail("The verification receipt no longer verifies.");
    try { receipt = JSON.parse(sealed.content.toString("utf8")); } catch { return fail("The verification receipt cannot be read."); }
    if (receipt?.version !== 1 || receipt.run !== runId || receipt.head !== source.headRevision || receipt.base !== source.baseRevision || receipt.scopeDigest !== source.scopeDigest || JSON.stringify(receipt.command) !== JSON.stringify(command) || JSON.stringify(receipt.log) !== JSON.stringify(binding(log))) return fail("The candidate, approved command or retained log changed since verification.");
    const result = receipt.result;
    if (result?.configured !== true || typeof result.ran !== "boolean" || (result.ran ? !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 : result.attemptFailed !== true)) return fail("The machine verification result is malformed.");
    if (verified && (!result.ran || result.exitCode !== 0)) return fail("The passing machine verdict disagrees with its verification receipt.");
  } else {
    const stat = artifacts.filter(a => a.kind === "diff-stat");
    if (stat.length !== 1 || stat[0]!.truncated || stat[0]!.captureStatus === "failed") return fail("Legacy verification has no exact candidate inventory.");
    const readStat = readVerifiedArtifact(root, stat[0]!);
    if (!readStat.ok) return fail("Legacy candidate inventory no longer verifies.");
    let endpoints;
    try { endpoints = JSON.parse(readStat.content.toString("utf8")); } catch { return fail("Legacy candidate inventory is unreadable."); }
    if (!source.headRevision || endpoints.head !== source.headRevision || endpoints.base !== source.baseRevision || endpoints.filesTruncated !== false) return fail("Legacy verification candidate endpoints do not match.");
    const text = read.content.toString("utf8");
    const header = /^=== Attempt summary ===\n- Project check · attempt 1: \(exit (\d+)\)\n\n=== Project check · attempt 1 ===\n/.exec(text);
    const exitCode = header ? Number(header[1]) : -1;
    if (!header || exitCode > 255 || !text.startsWith(`${header[0]}$ ${command.command}\n(exit ${exitCode})\n\n--- stdout ---\n`)) return fail("The original log lacks an unambiguous machine gate receipt; historical output was not reconstructed.");
    if (verified && exitCode !== 0) return fail("The passing machine verdict disagrees with the original failed check.");
    receipt = { version: 1, source: "legacy machine log header", run: runId, head: source.headRevision, base: source.baseRevision, scopeDigest: source.scopeDigest, command, result: { configured: true, ran: true, exitCode }, log: binding(log), candidate: binding(stat[0]!) };
  }
  // The view preserves shortened/redacted status and does not claim the omitted
  // output exists. Its fingerprint is re-proved before every turn and ingestion.
  const bytes = JSON.stringify(receipt);
  return { ok: true, bytes, digest: hash({ receipt, receipts }) };
}

/** Only a sealed failed check can start unattended diagnosis. Lost custody,
 * changed approvals/trees and incomplete evidence still need attention; they
 * must not become another code-writing attempt. Keep the log out of the small
 * revision artifact and re-read it when the repair builder starts. */
export function failedVerificationEvidence(store: Store, root: string, runId: number):
  | { kind: "none" }
  | { kind: "unavailable"; problem: string }
  | { kind: "failed"; digest: string; receipt: string; log: string } {
  if (!store.artifactsFor(runId).some(isVerificationReceipt)) return { kind: "none" };
  const verified = verificationEvidence(store, root, runId);
  if (!verified.ok) return { kind: "unavailable", problem: verified.problem };
  if (verified.bytes === null) return { kind: "none" };
  const receipt = JSON.parse(verified.bytes) as { result: VerifyCommandFacts; log: { artifactId: number } };
  const result = receipt.result;
  if (!result.configured || (result.ran ? result.exitCode === 0 :
    result.failure !== "timed-out" && result.failure !== "retry-timed-out")) return { kind: "none" };
  const artifact = store.getArtifact(receipt.log.artifactId);
  if (!artifact || artifact.truncated || artifact.redacted || artifact.captureStatus !== "ok") {
    return { kind: "unavailable", problem: "Automatic repair needs the complete, unredacted failed-check log." };
  }
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return { kind: "unavailable", problem: "The failed-check log no longer verifies." };
  return { kind: "failed", digest: verified.digest, receipt: verified.bytes, log: read.content.toString("utf8") };
}

/** A fresh review may assess a pre-upgrade result which stopped solely because
 * no builder proof was written. Read original sealed facts; never run checks,
 * backfill receipts, rewrite artifacts, or reuse a different candidate's gate.
 * Called inside review ingestion, after its exact bindings have been proved. */
export function assessmentFromSavedEvidence(store: Store, root: string, runId: number): AdjudicateResult | null {
  const previous = store.proofVerdictFor(runId);
  if (previous?.verdict !== "short" || previous.reasons.length !== 1 || previous.reasons[0] !== "no proof was written" ||
    previous.matrix.some(row => row.review !== null || row.assessment !== undefined)) return null;
  const source = store.getRun(runId);
  if (!source?.headRevision || !source.baseRevision) return null;
  const task = store.externalIdFor(source.taskRef);
  const scope = task === null ? null : store.getScope(task);
  if (!scope || scope.digest !== source.scopeDigest || scope.acceptance.length === 0) return null;
  const artifacts = store.artifactsFor(runId);
  if (artifacts.some(one => one.kind === "proof")) return null;
  const readOne = (kind: Artifact["kind"]) => {
    const found = artifacts.filter(one => one.kind === kind);
    if (found.length !== 1 || found[0]!.truncated || found[0]!.redacted || found[0]!.captureStatus === "failed") return null;
    const read = readVerifiedArtifact(root, found[0]!);
    return read.ok ? read.content.toString("utf8") : null;
  };
  const diff = readOne("terminal-diff"), stat = readOne("diff-stat"), handoff = readOne("handoff"), context = readOne("review-context");
  if (diff === null || stat === null || handoff === null || context === null) return null;
  const parsedContext = parseReviewContext(context);
  if (!parsedContext.ok || parsedContext.inventory.run !== runId || reviewContextCustodyProblem(store, root, parsedContext.inventory) !== null) return null;
  const gate = verificationEvidence(store, root, runId);
  if (!gate.ok || gate.bytes === null) return null;
  try {
    const inventory = JSON.parse(stat), receipt = JSON.parse(gate.bytes);
    const base = source.branch ? store.firstBuilderBase(source.taskRef, source.branch) ?? source.baseRevision : source.baseRevision;
    if (inventory.schema !== 1 || inventory.head !== source.headRevision || inventory.base !== base || inventory.filesTruncated !== false ||
      !Array.isArray(inventory.files) || inventory.fileCount !== inventory.files.length || !inventory.files.every((one: { path?: unknown }) => typeof one?.path === "string") ||
      new Set(inventory.files.map((one: { path: string }) => one.path)).size !== inventory.files.length) return null;
    return adjudicate({ directAssessment: true, proofArtifactPresent: false, proofParse: null,
      handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths: new Set(inventory.files.map((one: { path: string }) => one.path)) },
      verifyCommand: receipt.result, verificationCommand: receipt.command.command, screenshots: [],
      approvedCriteria: scope.acceptance, reviewContext: parsedContext.inventory.coverage });
  } catch { return null; }
}
