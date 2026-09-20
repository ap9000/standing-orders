import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { normalizeBootId } from "./boot-identity.js";
import { changedDarwinProcessIdentities, collectDarwinCoalitionSnapshot, DARWIN_PROCESS_CENSUS_SOURCE } from "./process-recovery-native.js";
import type { DarwinCoalitionProcessIdentity, DarwinCoalitionRecoverySnapshot, PreparedDarwinProcessCensus } from "./process-recovery-native.js";

/** This version's causal argument was audited against these installed bytes:
 * up registers a fresh token BEFORE listening; every watch creates a fresh UUID;
 * heartbeat authenticates that closure's token and exact owner transactionally.
 * A new runtime needs its own audit, not a caller assertion of equivalent code. */
export const SERVICE_ANCHOR_RUNTIME_V1_SHA256 = "9641efcb3b46717a7f122aa025e3945a08fa55ca046605276825a9d69eefd01d";
export type DarwinServiceAnchorInput = {
  databasePath: string; targetRun: number; anchorReviewerRun: number;
  runtime: string; runtimeSha256: string; runner: string; repo: string;
  host: string; bootId: string; resourceCoalitionId: string;
  service: string; supervisorPid: number; workerPid: number; port: number;
  /** Full expected arrays; compared privately, never included in a receipt. */
  supervisorArgv: string[]; workerArgv: string[];
  /** Recovery must prepare this helper itself from the known embedded source;
   * never accept an executable or this result receipt from a client request. */
  native: PreparedDarwinProcessCensus; maxWaitMs?: number;
};
export type DarwinServiceAnchorReceipt = {
  schema: 1; kind: "authenticated-watch-continuity"; targetRun: number; anchorReviewerRun: number;
  host: string; bootId: string; observedAt: string; runtimeSha256: string;
  databasePath: string; runner: string; repo: string; owner: string; generation: number;
  episode: number; registeredAt: string; heartbeatBefore: string; heartbeatAfter: string;
  service: string; listener: string; worker: DarwinCoalitionProcessIdentity; supervisor: DarwinCoalitionProcessIdentity;
  nativeSourceSha256: string; nativeExecutableSha256: string;
};
export type DarwinServiceAnchorResult = { ok: true; receipt: DarwinServiceAnchorReceipt } | { ok: false; reason: string };
export type RecoveryReadDatabase = { prepare(sql: string): {
  get(...parameters: SQLInputValue[]): Record<string, unknown> | undefined;
  all(...parameters: SQLInputValue[]): Record<string, unknown>[];
} };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === "string" && normalizeBootId(value) === value;
const uint64 = (value: string) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" };

function runtimeFingerprint(root: string): string {
  const files: [string, string][] = [];
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error("runtime-unreadable");
      if (stat.isDirectory()) walk(path, relative + "/");
      else if (stat.isFile()) files.push([relative, hash(readFileSync(path))]);
      else throw Error("runtime-unreadable");
    }
  };
  walk(root);
  if (!files.length) throw Error("runtime-unreadable");
  return hash(JSON.stringify(files));
}
const readCommand = (file: string, argv: string[]): string => execFileSync(file, argv, {
  encoding: "utf8", env: environment, timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});

function observeService(input: DarwinServiceAnchorInput): void {
  if (runtimeFingerprint(input.runtime) !== input.runtimeSha256) throw Error("runtime-changed");
  const job = readCommand("/bin/launchctl", ["print", input.service]);
  // Only direct job fields count. Nested environment and diagnostic sections
  // can contain arbitrary similarly named strings and are never returned.
  if (job.match(/^\tpid = (\d+)$/m)?.[1] !== String(input.supervisorPid) || !/^\tstate = running$/m.test(job)) throw Error("managed-service-changed");
  for (const [pid, expected] of [[input.supervisorPid, input.supervisorArgv], [input.workerPid, input.workerArgv]] as const) {
    if (readCommand("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="]).trim() !== expected.join(" ")) throw Error("service-command-changed");
  }
  const listener = readCommand("/usr/sbin/lsof", ["-nP", "-iTCP:" + input.port, "-sTCP:LISTEN", "-Fpn"]);
  const pids = [...listener.matchAll(/^p(\d+)$/gm)].map(one => Number(one[1]));
  const names = [...listener.matchAll(/^n(.+)$/gm)].map(one => one[1]);
  if (!pids.length || pids.some(pid => pid !== input.workerPid) || !names.length || names.some(name => name !== `127.0.0.1:${input.port}`)) throw Error("listener-owner-changed");
}

// One SELECT is a consistent read snapshot. No credential leaves this module;
// its hash is used only to reject a registration/authority change while waiting.
const stateSql = `SELECT t.id target_id, t.started_at target_started, t.finished_at target_finished, t.outcome target_outcome,
 a.id anchor_id, a.role anchor_role, a.runner anchor_runner, a.watch_incarnation anchor_owner,
 a.started_at anchor_started, a.finished_at anchor_finished, a.outcome anchor_outcome,
 ar.repo anchor_repo, a.parent_run source_run, p.verdict source_verdict,
 (SELECT count(*) FROM criterion_review c WHERE c.reviewer_run=a.id AND c.source_run=a.parent_run) review_count,
 (SELECT count(*) FROM criterion_review c WHERE c.reviewer_run=a.id AND (c.source_run<>a.parent_run OR c.judgement<>'upholds')) bad_reviews,
 w.owner, w.generation, w.heartbeat_at heartbeat, w.expires_at expires,
 e.id episode, e.started_at episode_started, e.ended_at episode_ended,
 n.registered_at registered, n.credential_hash credential, n.retired_at retired, n.host runner_host, n.repos runner_repos
 FROM run t JOIN run a ON a.id=? JOIN task_ref ar ON ar.id=a.task_ref
 JOIN watch_lease w ON w.runner=a.runner AND w.repo=ar.repo
 JOIN watch_episode e ON e.incarnation=w.owner AND e.runner=w.runner AND e.repo=w.repo
 JOIN runner n ON n.name=w.runner LEFT JOIN proof_verdict p ON p.run=a.parent_run WHERE t.id=?`;
type State = Record<string, unknown> & { owner: string; generation: number; episode: number; registered: string; credential: string; heartbeat: string; expires: string };
// Saved history alone is not a live anchor: collection also requires an unchanged
// credential epoch/incarnation across an authenticated heartbeat and native identities.
function readState(db: RecoveryReadDatabase, input: DarwinServiceAnchorInput, now: number): State {
  const row = db.prepare(stateSql).get(input.anchorReviewerRun, input.targetRun);
  if (!row || row["target_id"] !== input.targetRun || row["anchor_id"] !== input.anchorReviewerRun ||
      input.anchorReviewerRun >= input.targetRun || row["anchor_role"] !== "reviewer" || row["anchor_outcome"] !== "no-change" ||
      row["anchor_runner"] !== input.runner || row["anchor_repo"] !== input.repo || row["runner_host"] !== input.host ||
      !uuid(row["owner"]) || row["anchor_owner"] !== row["owner"] || !positive(row["generation"]) || !positive(row["episode"]) ||
      row["episode_ended"] !== null || row["retired"] !== null || row["source_verdict"] !== "verified" ||
      !positive(row["review_count"]) || row["bad_reviews"] !== 0 || !text(row["credential"]) ||
      !["registered", "episode_started", "anchor_started", "anchor_finished", "target_started", "target_finished", "heartbeat", "expires"].every(key => instant(row[key])) ||
      !["built", "no-change"].includes(String(row["target_outcome"]))) throw Error("watch-history-unproven");
  const r = row as State;
  const times = [r.registered, r["episode_started"], r["anchor_started"], r["anchor_finished"], r["target_started"], r["target_finished"], r.heartbeat].map(value => Date.parse(String(value)));
  if (times.some((time, i) => i > 0 && time < times[i - 1]!) || Date.parse(r.heartbeat) > now || Date.parse(r.expires) <= now || Date.parse(r.expires) <= Date.parse(r.heartbeat)) throw Error("watch-history-unproven");
  const repos: unknown = JSON.parse(String(r["runner_repos"]));
  if (!Array.isArray(repos) || !repos.includes(input.repo)) throw Error("watch-history-unproven");
  return r;
}
const staticState = ({ heartbeat: _heartbeat, expires: _expires, ...row }: State) => JSON.stringify(row);

function anchored(snapshot: DarwinCoalitionRecoverySnapshot, input: DarwinServiceAnchorInput): [DarwinCoalitionProcessIdentity, DarwinCoalitionProcessIdentity] {
  if (!snapshot.complete || !snapshot.stable || snapshot.errors.length || snapshot.anchorIdentityChanges.length ||
      snapshot.host !== input.host || normalizeBootId(snapshot.bootId ?? "") !== input.bootId || snapshot.resourceCoalitionId !== input.resourceCoalitionId ||
      snapshot.nativeSourceSha256 !== input.native.sourceSha256 || snapshot.nativeExecutableSha256 !== input.native.executableSha256 ||
      snapshot.anchorPids.length !== 2 || !snapshot.anchorPids.includes(input.workerPid) || !snapshot.anchorPids.includes(input.supervisorPid)) throw Error("native-anchor-unproven");
  const worker = snapshot.anchors.find(row => row.pid === input.workerPid), supervisor = snapshot.anchors.find(row => row.pid === input.supervisorPid);
  if (!worker?.uniqueId || !supervisor?.uniqueId || worker.traced !== false || supervisor.traced !== false ||
      worker.ppid !== supervisor.pid || worker.parentUniqueId !== supervisor.uniqueId || BigInt(supervisor.uniqueId) >= BigInt(worker.uniqueId) || worker.uid !== supervisor.uid ||
      worker.executable !== input.workerArgv[0] || supervisor.executable !== input.supervisorArgv[0]) throw Error("native-anchor-unproven");
  return [worker, supervisor];
}

/** Trusted read-only collection, not exit evidence. Reads an existing connection
 * (including a schema69 Store.handle), never opens/migrates or writes a database.
 * Under the trusted installed-code/credential model, renewing a saved pre-run
 * UUID while registration stays fixed establishes a pre-run live service bound.
 * It does NOT establish coalition inheritance, survivor exclusion, or authority
 * to clear process custody. Every incomplete observation returns a refusal. */
export async function collectDarwinServiceAnchor(db: RecoveryReadDatabase, input: DarwinServiceAnchorInput): Promise<DarwinServiceAnchorResult> {
  let phase = "invalid-anchor-input";
  try {
    const wait = input.maxWaitMs ?? 60_000;
    if (process.platform !== "darwin" || input.runtimeSha256 !== SERVICE_ANCHOR_RUNTIME_V1_SHA256 || input.native.sourceSha256 !== hash(DARWIN_PROCESS_CENSUS_SOURCE) ||
        ![input.targetRun, input.anchorReviewerRun, input.supervisorPid, input.workerPid, input.port].every(positive) ||
        input.workerPid === input.supervisorPid || input.port > 65535 || !uuid(input.bootId) || !uint64(input.resourceCoalitionId) ||
        ![input.databasePath, input.runtime, input.runner, input.repo, input.host].every(text) ||
        !/^(system|gui\/[0-9]+)\/[A-Za-z0-9._-]+$/.test(input.service) || !Number.isSafeInteger(wait) || wait < 0 || wait > 60_000 ||
        [input.runtime, input.databasePath, input.repo].some(path => realpathSync(path) !== path) ||
        ![input.workerArgv, input.supervisorArgv].every(args => Array.isArray(args) && args.length > 2 && args.every(arg => text(arg) && !/\s/.test(arg)))) return { ok: false, reason: phase };
    const args = input.workerArgv;
    const flag = (name: string, value: string) => args.filter(arg => arg === name).length === 1 && args[args.indexOf(name) + 1] === value;
    if (args[1] !== join(input.runtime, "cli.js") || args[2] !== "up" ||
        !flag("--db", input.databasePath) || !flag("--repo", input.repo) || !flag("--runner", input.runner) ||
        !flag("--port", String(input.port)) || !flag("--host", "127.0.0.1") ||
        input.supervisorArgv[1] !== join(input.runtime, "controller-service.js") ||
        JSON.stringify(input.supervisorArgv.slice(2)) !== JSON.stringify(args)) return { ok: false, reason: phase };
    phase = "database-binding-unproven";
    const main = db.prepare("PRAGMA database_list").all().filter(row => row["name"] === "main");
    if (main.length !== 1 || main[0]?.["file"] !== input.databasePath) throw Error(phase);
    const witnesses = db.prepare("SELECT DISTINCT host, boot_id FROM run_process WHERE run=?").all(input.targetRun);
    if (!witnesses.length || witnesses.some(row => row["host"] !== input.host || typeof row["boot_id"] !== "string" || normalizeBootId(row["boot_id"]) !== input.bootId)) throw Error(phase);
    phase = "watch-history-unproven";
    const initial = readState(db, input, Date.now()), fixed = staticState(initial);
    phase = "native-anchor-unproven";
    const capture = () => collectDarwinCoalitionSnapshot({ native: input.native, resourceCoalitionId: input.resourceCoalitionId, anchorPids: [input.workerPid, input.supervisorPid], maxAttempts: 3 });
    const before = anchored(await capture(), input);
    phase = "service-observation-unproven";
    observeService(input);
    phase = "watch-renewal-unproven";
    const deadline = performance.now() + wait;
    let advanced: State;
    for (;;) {
      advanced = readState(db, input, Date.now());
      if (staticState(advanced) !== fixed || Date.parse(advanced.heartbeat) < Date.parse(initial.heartbeat)) throw Error("watch-incarnation-changed");
      if (Date.parse(advanced.heartbeat) > Date.parse(initial.heartbeat)) break;
      const left = deadline - performance.now();
      if (left <= 0) throw Error("watch-renewal-not-observed");
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, left)));
    }
    phase = "service-observation-unproven";
    observeService(input);
    phase = "native-anchor-unproven";
    const after = anchored(await capture(), input);
    if (changedDarwinProcessIdentities(before, after).length || before.some((row, i) => row.resourceCoalitionId !== after[i]?.resourceCoalitionId)) throw Error("service-identity-changed");
    phase = "watch-renewal-unproven";
    const final = readState(db, input, Date.now());
    if (staticState(final) !== fixed || Date.parse(final.heartbeat) < Date.parse(advanced.heartbeat)) throw Error("watch-incarnation-changed");
    return { ok: true, receipt: { schema: 1, kind: "authenticated-watch-continuity", targetRun: input.targetRun,
      anchorReviewerRun: input.anchorReviewerRun, host: input.host, bootId: input.bootId, observedAt: new Date().toISOString(),
      runtimeSha256: input.runtimeSha256, databasePath: input.databasePath, runner: input.runner, repo: input.repo,
      owner: initial.owner, generation: initial.generation, episode: initial.episode, registeredAt: initial.registered,
      heartbeatBefore: initial.heartbeat, heartbeatAfter: final.heartbeat, service: input.service, listener: `127.0.0.1:${input.port}`,
      worker: after[0], supervisor: after[1], nativeSourceSha256: input.native.sourceSha256, nativeExecutableSha256: input.native.executableSha256 } };
  } catch (error) {
    // Never forward subprocess/SQLite error objects: they may retain argv,
    // launchd environment text, paths or credential-bearing row values.
    const known = new Set(["runtime-changed", "managed-service-changed", "service-command-changed", "listener-owner-changed", "watch-history-unproven", "native-anchor-unproven", "watch-incarnation-changed", "watch-renewal-not-observed", "service-identity-changed"]);
    return { ok: false, reason: error instanceof Error && known.has(error.message) ? error.message : phase };
  }
}
