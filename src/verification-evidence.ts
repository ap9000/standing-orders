/** Machine verification receipts use the existing sealed artifact store (schema
 * 60). Verbose output is independently bounded; no agent-authored check claim
 * can create or replace this receipt. */
import { createHash } from "node:crypto";
import type { Artifact, Store, VerifyCommand } from "./store.js";
import type { VerifyCommandFacts } from "./proof.js";
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
