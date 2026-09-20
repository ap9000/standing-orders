/** Narrow legacy provenance collection; no exit or database mutation authority.
 * A reviewed profile pins historical bytes, not caller-supplied conclusions.
 * Only this module's live collection can mint an opaque receipt. Serialized
 * reports and the exported document inspection are never accepted as proof. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeBootId } from "./boot-identity.js";
import { collectDarwinServiceAnchor, type DarwinServiceAnchorInput, type DarwinServiceAnchorReceipt, type RecoveryReadDatabase } from "./process-recovery-anchor.js";
import { changedDarwinProcessIdentities, collectDarwinCoalitionSnapshot, prepareDarwinProcessCensus,
  type DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";
import { collectPreexistingAppServices, type PreexistingAppService } from "./process-recovery-services.js";

// Reviewed legacy profile; paths and operator/run identities remain private.
export const LEGACY_PROVENANCE_PROFILE_V1_SHA256 = "80bf37a0ddaf1765cf1f88c0fc37616f92c595f6dc15c1899a6d6cc3e8f2c754";
const APP_MEMBERS = [
  [".vite/build/src-CCXHtyvY.js", "a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40"],
  [".vite/build/main-DaMR-wdT.js", "0765260be74e8843630d5a92e30bca574783892688e67180c119a5c58679bb61"],
];
type Prefix = { path: string; bytes: number; sha256: string };
type FileBinding = { path: string; sha256: string };
export type LegacyProvenanceProfile = {
  schema: 1; kind: "codex-local-prepared-run-provenance-v1"; appSession: string; threadId: string;
  bundle: { asarPath: string; members: { path: string; sha256: string }[]; cliPath: string; cliSha256: string;
    infoPath: string; infoSha256: string; cliVersion: string; appVersion: string };
  startup: Prefix & { spawnLine: number; connectionLine: number; cliVersionLine: number; appVersionLine: number };
  rollout: Prefix & { invocationLine: number; startLine: number; completionLine: number };
  invocation: { callId: string; turnId: string; input: string; sessionId: string; command: string[]; cwd: string };
  source: { desktopPid: number; desktopUniqueId: string; desktopExecutable: string; serverPid: number; serverUniqueId: string };
  target: { runId: number; taskRef: number; base: string; head: string; scopeDigest: string; startedAt: string; finishedAt: string };
  firstPartyAudit: { source: FileBinding; environment: FileBinding; codeEvidence: FileBinding;
    repository: string; candidate: string; tree: string; installedSourceCommit: string; command: string };
  anchor: Omit<DarwinServiceAnchorInput, "native">;
};
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const requireFact = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
function ownedFile(path: string): number {
  requireFact(realpathSync(path) === path, "source-path-not-canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.uid !== process.getuid?.() && stat.uid !== 0) || (stat.mode & 0o022) !== 0) {
    closeSync(fd); throw Error("source-file-not-owned");
  }
  return fd;
}
function prefixBytes(source: Prefix): Buffer {
  requireFact(positive(source.bytes) && source.bytes <= 128 * 1024 * 1024, "source-prefix-size-invalid");
  const fd = ownedFile(source.path);
  try {
    requireFact(fstatSync(fd).size >= source.bytes, "source-prefix-missing");
    const bytes = Buffer.alloc(source.bytes);
    let at = 0;
    while (at < bytes.length) {
      const read = readSync(fd, bytes, at, bytes.length - at, at);
      requireFact(read > 0, "source-prefix-missing"); at += read;
    }
    requireFact(hash(bytes) === source.sha256, "source-prefix-changed");
    return bytes;
  } finally { closeSync(fd); }
}
function completeHash(path: string): string {
  const fd = ownedFile(path);
  try { return hash(readFileSync(fd)); } finally { closeSync(fd); }
}
function asarMember(path: string, member: string): Buffer {
  const fd = ownedFile(path);
  try {
    const prefix = Buffer.alloc(16);
    requireFact(readSync(fd, prefix, 0, 16, 0) === 16 && prefix.readUInt32LE(0) === 4, "app-archive-unreadable");
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    requireFact(jsonSize > 0 && jsonSize <= 16 * 1024 * 1024 && headerSize >= jsonSize + 8 && headerSize <= jsonSize + 16, "app-archive-unreadable");
    const bytes = Buffer.alloc(jsonSize);
    requireFact(readSync(fd, bytes, 0, jsonSize, 16) === jsonSize, "app-archive-unreadable");
    let entry = JSON.parse(bytes.toString("utf8"));
    for (const part of member.split("/")) { requireFact(part && part !== "." && part !== "..", "app-member-unreadable"); entry = entry?.files?.[part]; }
    requireFact(entry && !entry.link && !entry.unpacked && positive(entry.size) && entry.size <= 16 * 1024 * 1024 && /^\d+$/.test(entry.offset), "app-member-unreadable");
    const offset = 8 + headerSize + Number(entry.offset);
    requireFact(Number.isSafeInteger(offset) && offset + entry.size <= fstatSync(fd).size, "app-member-unreadable");
    const result = Buffer.alloc(entry.size);
    requireFact(readSync(fd, result, 0, result.length, offset) === result.length, "app-member-unreadable");
    return result;
  } finally { closeSync(fd); }
}
function auditSources(profile: LegacyProvenanceProfile): void {
  const a = profile.firstPartyAudit;
  const read = (binding: FileBinding) => {
    const fd = ownedFile(binding.path);
    try {
      requireFact(fstatSync(fd).size <= 8 * 1024 * 1024, "audit-too-large");
      const bytes = readFileSync(fd); requireFact(hash(bytes) === binding.sha256, "reviewed-audit-changed");
      return JSON.parse(bytes.toString("utf8"));
    } finally { closeSync(fd); }
  };
  const source = read(a.source), environment = read(a.environment), code = read(a.codeEvidence);
  for (const binding of Object.values(environment.privateEvidenceBindings ?? {}) as FileBinding[]) {
    requireFact(completeHash(binding.path) === binding.sha256, "audited-wrapper-input-changed");
  }
  requireFact(a.candidate === profile.target.head && source.candidate === a.candidate && source.gitTree === a.tree && source.command === a.command &&
    environment.candidate === a.candidate && environment.installedSourceCommit === a.installedSourceCommit && environment.verificationCommand === a.command &&
    code.sourceCommit === a.installedSourceCommit && realpathSync(a.repository) === a.repository, "reviewed-audit-binding-mismatch");
  const git = (args: string[]) => execFileSync("/usr/bin/git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", a.repository, ...args], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
    timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  requireFact(git(["cat-file", "-p", a.candidate]).toString("utf8").startsWith(`tree ${a.tree}\n`), "audited-tree-changed");
  for (const [commit, files] of [[a.candidate, source.source], [a.installedSourceCommit, environment.sources]] as const) {
    requireFact(files && Object.keys(files).length > 0, "audited-source-missing");
    for (const [path, expected] of Object.entries(files)) requireFact(hash(git(["cat-file", "blob", `${commit}:${path}`])) === expected, "audited-source-changed");
  }
}

/** Non-authoritative deterministic inspection for tests and diagnostics. Even
 * successful input inspection cannot mint the opaque live receipt below. */
export function inspectLegacyProvenanceRecords(profile: LegacyProvenanceProfile, startupBytes: Buffer, rolloutBytes: Buffer): void {
  const lines = (bytes: Buffer) => bytes.toString("utf8").split("\n");
  const at = (all: string[], line: number) => { requireFact(positive(line) && line <= all.length, "source-record-missing"); return all[line - 1]!; };
  const startup = lines(startupBytes), rollout = lines(rolloutBytes), source = profile.source, invocation = profile.invocation;
  requireFact(profile.schema === 1 && profile.kind === "codex-local-prepared-run-provenance-v1" &&
    profile.anchor.targetRun === profile.target.runId, "profile-shape-invalid");
  requireFact(profile.startup.path.includes(`codex-desktop-${profile.appSession}-${source.desktopPid}-`), "app-session-mismatch");
  const spawned = at(startup, profile.startup.spawnLine), connected = at(startup, profile.startup.connectionLine);
  requireFact(spawned.includes("[StdioConnection] stdio_transport_spawned ") &&
    spawned.includes(`executablePath=${profile.bundle.cliPath} `) && spawned.includes(` pid=${source.serverPid} `) &&
    spawned.endsWith(`spawnCommand=${profile.bundle.cliPath}`) && connected.endsWith("Transport start success connectionId=1 hostId=local transport=stdio"), "startup-transport-mismatch");
  requireFact(at(startup, profile.startup.cliVersionLine).endsWith(`Current reported app-server version: currentVersion=${profile.bundle.cliVersion} hostId=local`) &&
    at(startup, profile.startup.appVersionLine).includes(`appSessionId=${profile.appSession} `) &&
    at(startup, profile.startup.appVersionLine).includes(` release=${profile.bundle.appVersion} `), "startup-version-mismatch");
  const call = JSON.parse(at(rollout, profile.rollout.invocationLine));
  const start = JSON.parse(at(rollout, profile.rollout.startLine));
  const completion = JSON.parse(at(rollout, profile.rollout.completionLine));
  requireFact(call.type === "response_item" && call.payload?.type === "custom_tool_call" && call.payload.name === "exec" &&
    call.payload.call_id === invocation.callId && call.payload.input === invocation.input &&
    call.payload.internal_chat_message_metadata_passthrough?.turn_id === invocation.turnId, "invocation-record-mismatch");
  requireFact(start.type === "response_item" && start.payload?.type === "custom_tool_call_output" && start.payload.call_id === invocation.callId &&
    start.payload.internal_chat_message_metadata_passthrough?.turn_id === invocation.turnId && Array.isArray(start.payload.output), "invocation-start-mismatch");
  const starts = start.payload.output.flatMap((one: { type?: string; text?: string }) => {
    if (one.type !== "input_text" || typeof one.text !== "string") return [];
    try { const parsed = JSON.parse(one.text); return parsed?.session_id !== undefined ? [parsed] : []; } catch { return []; }
  });
  requireFact(starts.length === 1 && String(starts[0].session_id) === invocation.sessionId, "invocation-session-mismatch");
  const event = completion.payload, item = event?.item;
  requireFact(completion.type === "event_msg" && event.type === "item_completed" && event.thread_id === profile.threadId && event.turn_id === invocation.turnId &&
    item?.type === "CommandExecution" && item.source === "unified_exec_startup" && item.process_id === invocation.sessionId &&
    item.status === "completed" && item.exit_code === 0 && same(item.command, invocation.command) && item.cwd === invocation.cwd, "command-completion-mismatch");
  const returned = JSON.parse(item.stdout);
  requireFact(returned.mode === "build" && returned.status === "tick-returned" && returned.exitCode === 0 && returned.results?.length === 1 &&
    returned.results[0].id === profile.target.runId && returned.results[0].role === "builder" && returned.results[0].parentRun === null &&
    returned.results[0].outcome === "built" && returned.results[0].head === profile.target.head && returned.results[0].finishedAt === profile.target.finishedAt,
  "native-run-return-mismatch");
  const times = [call.timestamp, start.timestamp, profile.target.startedAt, profile.target.finishedAt, completion.timestamp].map(value => Date.parse(value));
  requireFact(times.every(Number.isFinite) && times.every((value, i) => i === 0 || value >= times[i - 1]!), "invocation-order-unproven");
}

/** Non-authoritative OS-fact inspection. The upper bound must come from the
 * internally collected watch continuity, never a caller's calendar estimate. */
export function inspectLegacyExecutionAncestry(profile: LegacyProvenanceProfile, snapshot: DarwinCoalitionRecoverySnapshot, ownPid: number, upperBound: string): void {
  requireFact(snapshot.complete && snapshot.stable && snapshot.countersStable && snapshot.kernelTableRead && !snapshot.errors.length &&
    !snapshot.identityChanges.length && !snapshot.anchorIdentityChanges.length && snapshot.host === profile.anchor.host &&
    normalizeBootId(snapshot.bootId ?? "") === profile.anchor.bootId && snapshot.resourceCoalitionId === profile.anchor.resourceCoalitionId, "current-execution-census-unproven");
  const rows = new Map(snapshot.processes.map(row => [row.pid, row]));
  const source = rows.get(profile.source.serverPid), desktop = rows.get(profile.source.desktopPid);
  requireFact(source?.uniqueId === profile.source.serverUniqueId && desktop?.uniqueId === profile.source.desktopUniqueId &&
    source?.traced === false && desktop?.traced === false && source.ppid === desktop.pid && source.parentUniqueId === desktop.uniqueId &&
    source.uid === desktop.uid && source.executable === profile.bundle.cliPath && desktop.executable === profile.source.desktopExecutable &&
    /^[1-9][0-9]*$/.test(upperBound) && BigInt(source.uniqueId!) <= BigInt(upperBound) && BigInt(desktop.uniqueId!) < BigInt(source.uniqueId!), "historical-source-identity-unproven");
  const seen = new Set<number>();
  let row = rows.get(ownPid);
  while (row && row.pid !== source!.pid) {
    requireFact(!seen.has(row.pid) && row.traced === false && row.uid === source!.uid && row.uniqueId && row.ppid && row.ppid > 1, "current-execution-ancestry-unproven");
    seen.add(row.pid);
    const parent = rows.get(row.ppid!);
    requireFact(parent?.uniqueId && row.parentUniqueId === parent.uniqueId && BigInt(parent.uniqueId) < BigInt(row.uniqueId!), "current-execution-ancestry-unproven");
    row = parent;
  }
  requireFact(row?.pid === source!.pid, "current-execution-ancestry-unproven");
  const collector = snapshot.collector, probe = collector && rows.get(collector.pid);
  requireFact(collector?.exited === true && probe?.uniqueId === collector.uniqueId && probe.ppid === ownPid &&
    probe.parentUniqueId === rows.get(ownPid)?.uniqueId && probe.traced === false, "owned-collector-exit-unproven");
}

export type CollectedLegacyProvenance = Readonly<{ kind: "collected-legacy-source-provenance"; profileSha256: string; digest: string }>;
export type LegacyProvenanceReceipt = { schema: 1; profileSha256: string; targetRun: number; head: string; scopeDigest: string; observedAt: string;
  host: string; bootId: string; resourceCoalitionId: string; sourceRoot: { pid: number; uniqueId: string };
  preRunUpperBound: { pid: number; uniqueId: string }; snapshotDigest: string; sourcePrefixes: string[]; appSourceHashes: string[];
  firstPartyAudit: { candidate: string; tree: string; reportHashes: string[] }; preexistingAppServices: PreexistingAppService[];
  descendantScope: "direct-and-ordinary-fork-only"; assumptions: string[] };
export type CollectedLegacyFacts = Readonly<{ receipt: LegacyProvenanceReceipt; snapshot: DarwinCoalitionRecoverySnapshot; anchor: DarwinServiceAnchorReceipt }>;
const minted = new WeakMap<CollectedLegacyProvenance, CollectedLegacyFacts>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** A parsed/copied/serialized certificate has no entry. A settlement caller must
 * obtain this from the live collector in the SAME process and recheck custody. */
export function collectedLegacyProvenanceOf(proof: CollectedLegacyProvenance): CollectedLegacyFacts | null { return minted.get(proof) ?? null; }
export async function collectLegacySourceProvenance(db: RecoveryReadDatabase, input: { profilePath: string; compilationDirectory: string }) {
  let native: ReturnType<typeof prepareDarwinProcessCensus> | undefined;
  let phase = "reviewed-profile";
  try {
    const fd = ownedFile(input.profilePath);
    let profile: LegacyProvenanceProfile;
    try {
      requireFact(fstatSync(fd).size <= 32 * 1024, "profile-too-large");
      const bytes = readFileSync(fd);
      requireFact(hash(bytes) === LEGACY_PROVENANCE_PROFILE_V1_SHA256, "unreviewed-provenance-profile");
      profile = JSON.parse(bytes.toString("utf8"));
    } finally { closeSync(fd); }
    const revalidate = () => {
      requireFact(completeHash(input.profilePath) === LEGACY_PROVENANCE_PROFILE_V1_SHA256 &&
        same(profile.bundle.members.map(member => [member.path, member.sha256]), APP_MEMBERS), "unreviewed-provenance-profile");
      for (const member of profile.bundle.members) requireFact(hash(asarMember(profile.bundle.asarPath, member.path)) === member.sha256, "loaded-app-source-changed");
      requireFact(completeHash(profile.bundle.cliPath) === profile.bundle.cliSha256 && completeHash(profile.bundle.infoPath) === profile.bundle.infoSha256, "installed-app-changed");
      inspectLegacyProvenanceRecords(profile, prefixBytes(profile.startup), prefixBytes(profile.rollout));
      auditSources(profile);
      requireFact(process.env.CODEX_THREAD_ID === profile.threadId, "current-thread-mismatch");
      const r = db.prepare("SELECT id,task_ref,base_revision,head_revision,scope_digest,started_at,finished_at FROM run WHERE id=?").get(profile.target.runId);
      const t = profile.target;
      requireFact(r && same([r.id, r.task_ref, r.base_revision, r.head_revision, r.scope_digest, r.started_at, r.finished_at],
        [t.runId, t.taskRef, t.base, t.head, t.scopeDigest, t.startedAt, t.finishedAt]), "target-run-changed");
    };
    phase = "historical-source-revalidation"; revalidate();
    phase = "native-preparation";
    native = prepareDarwinProcessCensus(input.compilationDirectory);
    phase = "service-anchor";
    const anchor = await collectDarwinServiceAnchor(db, { ...profile.anchor, native });
    if (!anchor.ok) return { ok: false as const, reason: "legacy-source-provenance-unproven", phase, anchorReason: anchor.reason };
    phase = "current-execution-census";
    const anchorPids = [profile.source.desktopPid, profile.source.serverPid, profile.anchor.workerPid, process.pid];
    const initial = await collectDarwinCoalitionSnapshot({ native, resourceCoalitionId: profile.anchor.resourceCoalitionId,
      anchorPids, maxAttempts: 3 });
    phase = "pre-existing-app-services";
    const services = await collectPreexistingAppServices({ snapshot: initial, native, anchorPids,
      upperBound: { pid: anchor.receipt.worker.pid, uniqueId: anchor.receipt.worker.uniqueId! } });
    if (!services.ok) return { ok: false as const, reason: "legacy-source-provenance-unproven", phase, detail: services.reason,
      ...(services.diagnostic ? { servicePhase: services.diagnostic.phase } : {}) };
    const snapshot = services.snapshot;
    const worker = snapshot.anchors.find(row => row.pid === profile.anchor.workerPid);
    requireFact(worker && !changedDarwinProcessIdentities([anchor.receipt.worker], [worker]).length &&
      worker.resourceCoalitionId === anchor.receipt.worker.resourceCoalitionId, "pre-run-anchor-changed");
    phase = "current-execution-ancestry";
    inspectLegacyExecutionAncestry(profile, snapshot, process.pid, anchor.receipt.worker.uniqueId!);
    phase = "historical-source-recheck"; revalidate();
    const receipt: LegacyProvenanceReceipt = { schema: 1, profileSha256: LEGACY_PROVENANCE_PROFILE_V1_SHA256, targetRun: profile.target.runId,
      head: profile.target.head, scopeDigest: profile.target.scopeDigest, observedAt: snapshot.finishedAt,
      host: profile.anchor.host, bootId: profile.anchor.bootId, resourceCoalitionId: profile.anchor.resourceCoalitionId,
      sourceRoot: { pid: profile.source.serverPid, uniqueId: profile.source.serverUniqueId },
      preRunUpperBound: { pid: worker!.pid, uniqueId: worker!.uniqueId! }, snapshotDigest: hash(JSON.stringify(snapshot)),
      sourcePrefixes: [profile.startup.sha256, profile.rollout.sha256], appSourceHashes: profile.bundle.members.map(one => one.sha256),
      firstPartyAudit: { candidate: profile.firstPartyAudit.candidate, tree: profile.firstPartyAudit.tree,
        reportHashes: [profile.firstPartyAudit.source.sha256, profile.firstPartyAudit.environment.sha256, profile.firstPartyAudit.codeEvidence.sha256] },
      preexistingAppServices: services.services,
      descendantScope: "direct-and-ordinary-fork-only",
      assumptions: ["Trusted installed app, OS, compiler, credential and append-only local-log model; current verified app bytes are the startup version's bytes.",
        "Prepared run uses the audited ordinary local execution path. Historical HOME, PATH, npmrc, npm lifecycle and Git configuration were not sealed; no historical no-delegation attestation is created.",
        "The pinned Apple Application-type speech service and launchd implementation bind each service to its exact pre-existing Chrome owner; this relies on trusted OS service creation and does not infer ownership from a name or launchd parent.",
        "This proves source continuity conditionally; separate spawn-provenance eligibility, complete survivor assessment and exact custody recheck remain required."] };
    const facts = freeze({ receipt, snapshot, anchor: anchor.receipt });
    const proof: CollectedLegacyProvenance = Object.freeze({ kind: "collected-legacy-source-provenance", profileSha256: receipt.profileSha256, digest: hash(JSON.stringify(receipt)) });
    minted.set(proof, facts);
    return { ok: true as const, proof, ...facts };
  } catch (error) {
    // No source logs, paths, argv, environment or subprocess errors escape.
    const safe = new Set(["current-thread-mismatch", "target-run-changed", "pre-run-anchor-changed", "current-execution-census-unproven",
      "historical-source-identity-unproven", "current-execution-ancestry-unproven", "owned-collector-exit-unproven"]);
    return { ok: false as const, reason: "legacy-source-provenance-unproven", phase,
      ...(error instanceof Error && safe.has(error.message) ? { detail: error.message } : {}) };
  } finally {
    if (native) { try { rmSync(dirname(native.executablePath), { recursive: true, force: true }); } catch { /* No custody is settled by temporary-file cleanup. */ } }
  }
}
