/**
 * `toolroll update`: a verified, drained, undoable update of an npm-installed
 * Toolroll. It reuses the desktop update engine's pieces (desktop-update.ts):
 * the SQLite admission gate that lets running work finish, the verified
 * private backup (the coding catalog's inside the same reservation), the
 * durable journal written before every irreversible step, the OS lock that
 * shows whether an updater is alive, and resume after a crash. What differs
 * is what gets swapped: a staged npm runtime instead of an app bundle.
 *
 *   verify → drain → stop and back up → rehearse → switch → restart → health
 *
 * The new release is installed from the npm registry into a Toolroll-managed
 * runtimes folder (`staged-upgrades/`, as deploy-browser stages), never over
 * the running one. npm's own signature and attestation check covers what it
 * installed, the installed bytes must be the ones downloaded and hashed, and
 * their provenance must name ap9000/toolroll and its publish workflow. The
 * service is stopped, and its processes seen gone, before the final backup,
 * so nothing written before the switch is lost. A failed health check puts
 * back the previous runtime, database and coding catalog on its own, keeping
 * what the new version wrote in a named copy. `--rollback` returns to the
 * previous runtime and its backups. Every update, rollback, refusal and
 * failure is a ledger entry.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { durableJson, lingeringWork, sqliteLock, verifiedDatabaseBackup } from "./desktop-update.js";
import { activeUpdateWork, freezeUpdateGate, installUpdateGate, removeUpdateGate, updateAdmissionPaused, updateGateOwned } from "./desktop-update-gate.js";
import { assertCodingUpdateStopped, backupCodingCatalog, codingCatalogExists, removeCodingUpdateGate } from "./coding-update.js";
import { installLaunchdService, launchdPlist, stopLaunchdService, writeFileDurably, type SupervisorRunner } from "./daemon.js";
import { NAME } from "./names.js";
import { isNewer, REGISTRY } from "./releases.js";

/** Loaded on first use (as backup.ts and store.ts do), so modules that only import this one (the console,
 * and tests that load it in a browser-like environment) never need `node:sqlite` itself. */
function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}


export const PROVENANCE_REPOSITORY = "https://github.com/ap9000/toolroll";
export const PROVENANCE_WORKFLOW = ".github/workflows/publish.yml";
/** The steps a person sees, in order. */
export const UPDATE_STEPS = ["verifying", "draining", "backing-up", "rehearsing", "switching", "restarting", "health"] as const;
export type UpdateStep = typeof UPDATE_STEPS[number];
export type RuntimePhase = "scheduled" | UpdateStep | "complete" | "rolling-back" | "restored" | "refused" | "cancelled" | "needs-attention";
export const STEP_WORDS: Record<UpdateStep, string> = {
  verifying: "Verify the package", draining: "Let running work finish", "backing-up": "Stop and back up",
  rehearsing: "Rehearse the migration", switching: "Switch to the new version", restarting: "Restart", health: "Health check",
};
export type When = "now" | "when-idle" | "at";
export type RuntimeRef = { version: string; dist: string };
/** How many release-* runtimes stay on disk: the running one and the one before it. */
export const KEEP_RUNTIMES = 2;
/** The one-off launchd job the console starts the updater as. */
export const UPDATE_JOB_LABEL = "com.toolroll.update";

export type RuntimeUpdateJournal = {
  version: 1; id: string; kind: "update" | "rollback";
  stateDir: string; databaseFile: string; stageDir: string;
  from: RuntimeRef; to: RuntimeRef;
  when: When; at: string | null; actor: string;
  phase: RuntimePhase; detail: string; error?: string;
  steps: { phase: RuntimePhase; at: string }[];
  startedAt: string; updatedAt: string; finishedAt?: string;
  package?: { sha512: string; repository: string; workflow: string };
  notes?: string[];
  /** This run's own verified copies of the live database and coding catalog: what a failure restores. */
  backupPath?: string; backupHash?: string;
  codingBackupPath?: string; codingBackupHash?: string;
  /** A rollback installs the update's earlier backups (checked against their recorded hashes). */
  restoreFrom?: { path: string; hash: string; updateId: string; codingPath?: string; codingHash?: string };
  rehearsal?: { tables: number; rows: number };
  /** The background service, recorded before it is stopped: its definition and the processes that must be gone. */
  service?: { unit: string; pids: number[] };
  /** Recorded before each change so a resumed or failed run knows what to put back. */
  switched?: { links: { path: string; previous: string }[]; unit: { path: string; saved: string } | null; databaseRestored?: boolean };
  /** What the live database held when a failed run restored its backup: nothing written is lost. */
  keptAside?: string;
  /** The restore put the backup back: a retried restore never puts it back again (what was written since belongs to
   * the restored version and would be lost), and it keeps a fresh copy aside before every attempt until then. */
  restoredDatabase?: boolean;
  seen?: boolean;
};

export type PackageRelease = { version: string; tarball: string; integrity: string; attestations: string | null };
export type UpdateSystem = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  release: (version: string) => Promise<PackageRelease>;
  download: (url: string) => Promise<Uint8Array>;
  attestations: (url: string) => Promise<unknown>;
  /** Installs `release` from the registry into `runtimeDir`, has npm verify its
   * registry signature and attestation there, checks the installed bytes are
   * `release.integrity`, and returns the package's dist. */
  install: (runtimeDir: string, release: PackageRelease) => Promise<string>;
  /** Opens `copy` with the runtime at `dist`, which migrates it as that build would. */
  rehearse: (dist: string, copy: string) => Promise<void>;
  /** Every `toolroll` and `standing-orders` command on PATH: each must be a link into `from` to be switched. */
  commands: (from: RuntimeRef) => string[];
  /** The background service's definition, when one runs `from`. */
  serviceUnit: (from: RuntimeRef) => string | null;
  /** The processes the service runs now. */
  servicePids: (unit: string) => Promise<number[]>;
  /** Unload the service; resolves once launchd no longer has it. */
  stopService: (unit: string) => Promise<void>;
  /** Load and start the service from its definition on disk. */
  restartService: (unit: string) => Promise<void>;
  processAlive: (pid: number) => boolean;
  healthy: (j: RuntimeUpdateJournal) => Promise<boolean>;
  healthTimeoutMs?: number;
  /** How long stopped service processes may take to exit. */
  exitTimeoutMs?: number;
  /** Fault injection for state-machine tests, never selectable by a flag. */
  checkpoint?: (phase: RuntimePhase) => void;
};

export type UpdateOutcome = { ok: boolean; phase: RuntimePhase; message: string; journal: RuntimeUpdateJournal | null };

const TERMINAL: readonly RuntimePhase[] = ["complete", "restored", "refused", "cancelled"];
export const runtimeUpdateTerminal = (phase: RuntimePhase) => TERMINAL.includes(phase);
const journalFile = (stateDir: string) => join(stateDir, "toolroll-update.json");
const cancelFile = (j: RuntimeUpdateJournal) => join(j.stageDir, "cancel-request.json");
const sha = (bytes: Uint8Array | string, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const fileHash = (file: string) => sha(readFileSync(file));
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const codingFile = (databaseFile: string) => `${databaseFile}.coding.sqlite`;
class Refusal extends Error {}

export function readRuntimeUpdate(stateDir: string): RuntimeUpdateJournal | null {
  const file = journalFile(stateDir);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("The saved update record is not a regular file. Nothing was changed.");
  const j = JSON.parse(readFileSync(file, "utf8")) as RuntimeUpdateJournal;
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (j.version !== 1 || !/^[a-f0-9-]{36}$/.test(j.id) || typeof j.stateDir !== "string" || real(j.stateDir) !== real(stateDir) || !isAbsolute(j.stageDir ?? "") || real(dirname(j.stageDir)) !== real(join(stateDir, "staged-upgrades"))) throw Error("The saved update record is invalid. Preserve it and its backups; nothing was changed.");
  return j;
}

function save(j: RuntimeUpdateJournal, phase: RuntimePhase, detail: string, now: Date): void {
  if (j.phase !== phase) j.steps.push({ phase, at: now.toISOString() });
  j.phase = phase; j.detail = detail; j.updatedAt = now.toISOString();
  if (runtimeUpdateTerminal(phase)) j.finishedAt = now.toISOString();
  durableJson(join(j.stageDir, "update.json"), j);
  durableJson(journalFile(j.stateDir), j);
}

/** Every update, rollback, refusal and failure. Plain SQL any build can run,
 * written after any database restore so the restore cannot erase it. */
function ledger(databaseFile: string, now: Date, actor: string, action: string, outcome: string, detail: string): void {
  const db = new (sqlite().DatabaseSync)(databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,NULL,NULL,NULL,?,?,'policy',?)")
      .run(now.toISOString(), actor, action, outcome, detail.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300));
  } finally { db.close(); }
}

/** Running work by name, for a refusal a person can act on. */
export function runningWorkWords(db: DatabaseSync): string | null {
  const active = activeUpdateWork(db);
  if (Object.values(active).every(n => n === 0)) return null;
  const runs = db.prepare("SELECT tr.external_id id, COALESCE(t.title, tr.external_id) title FROM run r JOIN task_ref tr ON tr.id = r.task_ref LEFT JOIN task t ON t.id = tr.external_id WHERE r.outcome IS NULL ORDER BY r.id LIMIT 3").all()
    .map(row => `${String(row["id"])} (${String(row["title"]).slice(0, 60)})`);
  const more = Number(active["runs"] ?? 0) - runs.length;
  const other = Object.entries(active).filter(([key, n]) => key !== "runs" && n > 0).map(([key, n]) => `${n} ${key === "claims" ? "claimed task" : key === "conversations" ? "chat request" : key === "sessions" ? "held session" : key === "stopping" ? "run still stopping" : key === "codingDeliveries" ? "unconfirmed coding message" : "coding session"}${n === 1 ? "" : "s"}`);
  const parts = [...(runs.length ? [`running ${runs.join(", ")}${more > 0 ? ` and ${more} more` : ""}`] : []), ...other];
  return parts.join("; ");
}

/** The npm provenance statement for exactly these bytes must name the
 * Toolroll repository and its publish workflow. Anything else is refused.
 * npm's own check (UpdateSystem.install) verifies the statement's signature. */
export function checkProvenance(attestations: unknown, version: string, sha512Hex: string): { repository: string; workflow: string } {
  const list = (attestations as { attestations?: unknown[] } | null)?.attestations;
  if (!Array.isArray(list) || list.length === 0) throw new Refusal(`Toolroll ${version} has no npm provenance, so it cannot be verified. Nothing was changed.`);
  for (const one of list as { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[]) {
    if (!String(one.predicateType ?? "").startsWith("https://slsa.dev/provenance/")) continue;
    let statement: { subject?: { name?: string; digest?: { sha512?: string } }[]; predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: string; path?: string } } } } };
    try { statement = JSON.parse(Buffer.from(String(one.bundle?.dsseEnvelope?.payload ?? ""), "base64").toString("utf8")); }
    catch { throw new Refusal(`Toolroll ${version}'s provenance could not be read. Nothing was changed.`); }
    const subject = statement.subject?.find(s => s.name === `pkg:npm/${NAME}@${version}`);
    if (!subject || subject.digest?.sha512 !== sha512Hex) throw new Refusal(`Toolroll ${version}'s provenance is for different bytes than the package downloaded. Nothing was changed.`);
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
    const repository = String(workflow?.repository ?? "").replace(/\.git$/, "");
    if (repository !== PROVENANCE_REPOSITORY || workflow?.path !== PROVENANCE_WORKFLOW) throw new Refusal(`Toolroll ${version} was built by ${repository || "an unnamed repository"} (${workflow?.path ?? "no workflow"}), not ${PROVENANCE_REPOSITORY.replace("https://github.com/", "")} (${PROVENANCE_WORKFLOW}). Nothing was changed.`);
    return { repository, workflow: workflow.path };
  }
  throw new Refusal(`Toolroll ${version} has no build provenance statement. Nothing was changed.`);
}

/** Headlines of this version's changelog section: its bold lead phrases. */
export function releaseNotes(changelog: string, version: string): string[] {
  const lines = changelog.split("\n"); const start = lines.findIndex(line => new RegExp(`^## ${version.replaceAll(".", "\\.")}( |$)`).test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1]!.replace(/\.$/, "")).slice(0, 6);
}

// ---- durable files ----------------------------------------------------------

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Every rename here: what is renamed is flushed first (a file itself, a link
 * by its directory), and the directory after, so a crash never leaves a torn
 * database, catalog or command. */
export function durableRename(temp: string, target: string): void {
  fsyncPath(lstatSync(temp).isSymbolicLink() ? dirname(temp) : temp);
  renameSync(temp, target);
  if (process.platform !== "win32") fsyncPath(dirname(target));
}

// ---- database: snapshot, rehearse, restore --------------------------------

type TableDigest = { name: string; columns: string[]; count: number; hash: string };
function tableDigest(db: DatabaseSync, name: string, columns: string[]): { count: number; hash: string } {
  const rows = db.prepare("SELECT " + columns.map(quote).join(",") + " FROM " + quote(name)).all().map(r => JSON.stringify(r)).sort();
  return { count: rows.length, hash: sha(rows.join("\n")) };
}
/** Every historical row, table by table (deploy-browser's rehearsal check). */
export function historySnapshot(db: DatabaseSync): TableDigest[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' ORDER BY name").all()
    .map(row => String(row["name"])).map(name => {
      const columns = db.prepare("PRAGMA table_info(" + quote(name) + ")").all().map(r => String(r["name"]));
      return { name, columns, ...tableDigest(db, name, columns) };
    });
}
export function changedHistory(db: DatabaseSync, before: TableDigest[]): string[] {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r["name"])));
  return before.filter(t => {
    if (!tables.has(t.name)) return true;
    const present = new Set(db.prepare("PRAGMA table_info(" + quote(t.name) + ")").all().map(r => String(r["name"])));
    if (t.columns.some(c => !present.has(c))) return true;
    const after = tableDigest(db, t.name, t.columns);
    return after.count !== t.count || after.hash !== t.hash;
  }).map(t => t.name);
}

async function rehearse(j: RuntimeUpdateJournal, system: UpdateSystem, source: string): Promise<{ tables: number; rows: number }> {
  const copy = join(j.stageDir, `rehearsal.${randomUUID()}.db`);
  copyFileSync(source, copy); chmodSync(copy, 0o600);
  try {
    let db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    const before = historySnapshot(db); db.close();
    await system.rehearse(j.to.dist, copy);
    db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    try {
      const changed = changedHistory(db, before);
      if (changed.length > 0) throw new Refusal(`Toolroll ${j.to.version} would change saved history in ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ` and ${changed.length - 4} more` : ""}. Nothing was changed.`);
      if (db.prepare("PRAGMA integrity_check").get()?.["integrity_check"] !== "ok") throw new Refusal(`The rehearsed database failed its integrity check under ${j.to.version}. Nothing was changed.`);
    } finally { db.close(); }
    return { tables: before.length, rows: before.reduce((n, t) => n + t.count, 0) };
  } finally { for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true }); }
}

/** Put a verified backup in place of a live SQLite file. Only once the service's processes are gone. */
function restoreFile(live: string, backup: string, hash: string, what: string): void {
  if (fileHash(backup) !== hash) throw Error(`The retained ${what} backup changed. It was not put back.`);
  const temp = `${live}.${randomUUID()}.restore`;
  copyFileSync(backup, temp); chmodSync(temp, 0o600);
  for (const suffix of ["-wal", "-shm"]) rmSync(live + suffix, { force: true });
  durableRename(temp, live);
}

/** The database and, when one was backed up, the coding catalog, then this run's coding gate lifted. */
function restoreDatabase(j: RuntimeUpdateJournal, from: { path: string; hash: string; codingPath?: string; codingHash?: string }): void {
  restoreFile(j.databaseFile, from.path, from.hash, "database");
  if (from.codingPath && from.codingHash) restoreFile(codingFile(j.databaseFile), from.codingPath, from.codingHash, "coding catalog");
  ungateCoding(j);
}

/** A private copy of the live database before a restore replaces it: what the new version wrote is kept, and named. */
async function keepAside(j: RuntimeUpdateJournal): Promise<string> {
  const kept = join(j.stageDir, `orders.kept.${randomUUID().slice(0, 8)}.db`);
  const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
  try { await sqlite().backup(db, kept); } finally { db.close(); }
  chmodSync(kept, 0o600); fsyncPath(kept);
  return kept;
}

// ---- the service: stop, and see it gone -------------------------------------

/** Stop the service and wait until every process it ran has exited: only then may a file it writes be replaced. */
async function stopService(j: RuntimeUpdateJournal, system: UpdateSystem, unit: string): Promise<void> {
  const pids = [...new Set([...(j.service?.unit === unit ? j.service.pids : []), ...await system.servicePids(unit)])];
  j.service = { unit, pids }; save(j, j.phase, j.detail, system.now());
  await system.stopService(unit);
  const deadline = system.now().getTime() + (system.exitTimeoutMs ?? 60_000);
  for (;;) {
    const alive = pids.filter(pid => system.processAlive(pid));
    if (alive.length === 0) return;
    if (system.now().getTime() >= deadline) throw Error(`The background service is still running (process ${alive.join(", ")}) after it was stopped. Nothing was replaced.`);
    await system.sleep(250);
  }
}

// ---- runtime switch: service definition and commands ----------------------

function pointLink(path: string, target: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}`);
  symlinkSync(target, temp); durableRename(temp, path);
}

/** What runs the current version: its service definition and every command on PATH. */
function switchable(j: RuntimeUpdateJournal, system: UpdateSystem): { unit: string | null; links: string[] } {
  const unit = system.serviceUnit(j.from), links = system.commands(j.from);
  if (!unit && links.length === 0) throw new Refusal(`No background service or toolroll command runs ${j.from.version} from ${j.from.dist}, so there is nothing to switch. Nothing was changed.`);
  const real = (path: string) => { try { return realpathSync(path); } catch { return null; } };
  const root = real(dirname(j.from.dist)) ?? dirname(j.from.dist);
  for (const link of links) {
    if (!lstatSync(link).isSymbolicLink()) throw new Refusal(`${link} is not a link Toolroll can switch (a shim or a copy), so it would keep running ${j.from.version}. Remove it or reinstall with npm, then update again. Nothing was changed.`);
    const target = real(link);
    if (target === null || !target.startsWith(root + sep)) throw new Refusal(`${link} runs a different Toolroll (${target ?? "a missing file"}), not ${j.from.version}, so it cannot be switched. Remove it, then update again. Nothing was changed.`);
  }
  if (unit && !readFileSync(unit, "utf8").includes(j.from.dist)) throw new Refusal("The service definition does not name the current runtime. Nothing was changed.");
  return { unit, links };
}

/** Every change is recorded before it is made; `revert` undoes exactly those.
 * A rollback puts the earlier database back only once the service is gone. */
async function switchRuntime(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  // A resumed switch keeps what it first recorded, so a revert still reaches the original.
  if (!j.switched) {
    const { unit, links } = switchable(j, system);
    j.switched = { links: links.map(path => ({ path, previous: readlinkSync(path) })), unit: null };
    if (unit) { const saved = join(j.stageDir, "service.saved.plist"); writeFileDurably(saved, readFileSync(unit)); j.switched.unit = { path: unit, saved }; }
    save(j, "switching", `Pointing ${unit ? "the service and " : ""}the toolroll and standing-orders commands at ${j.to.version}.`, system.now());
  }
  const unit = j.switched.unit?.path ?? null;
  if (j.restoreFrom && !j.switched.databaseRestored) {
    if (unit) await stopService(j, system, unit);
    restoreDatabase(j, j.restoreFrom); gate(j);
    j.switched.databaseRestored = true; save(j, "switching", j.detail, system.now());
  }
  if (unit) writeFileDurably(unit, readFileSync(j.switched.unit!.saved, "utf8").replaceAll(j.from.dist, j.to.dist), 0o644);
  for (const link of j.switched.links) pointLink(link.path, join(j.to.dist, "bin.js"));
}

function revertSwitch(j: RuntimeUpdateJournal): void {
  if (j.switched?.unit && existsSync(j.switched.unit.saved)) writeFileDurably(j.switched.unit.path, readFileSync(j.switched.unit.saved), 0o644);
  for (const link of j.switched?.links ?? []) pointLink(link.path, link.previous);
}

function gate(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); installUpdateGate(db, j.id); freezeUpdateGate(db, j.id); } finally { db.close(); }
}
/** Lift this run's admission pause, in the database and the coding catalog. A restored database has no pause of
 * its own (its backup dropped it), so the catalog's is lifted on its own. */
function ungate(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); if (updateGateOwned(db, j.id)) removeUpdateGate(db, j.id); else removeCodingUpdateGate(db, j.id); } finally { db.close(); }
}
function ungateCoding(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); removeCodingUpdateGate(db, j.id); } finally { db.close(); }
}

/** A foreground `toolroll up` holds a live watch lease; the runtime under it must not be replaced. */
function refuseWhileWatching(j: RuntimeUpdateJournal, system: UpdateSystem): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT runner, repo FROM watch_lease WHERE expires_at > ? LIMIT 1").get(system.now().toISOString());
    if (row) throw new Refusal(`toolroll up is running for ${String(row["repo"])} (${String(row["runner"])}). Stop it first; ${j.kind === "update" ? "an update replaces the version it runs" : "a rollback replaces the database"}. Nothing was changed.`);
  } finally { db.close(); }
}

// ---- the journaled run ----------------------------------------------------

export type StartOptions = {
  stateDir: string; databaseFile: string; current: RuntimeRef; actor: string;
  version: string; when: When; at?: string | null;
  /** An older version replaces the current one only when asked for by name. */
  allowDowngrade?: boolean;
};

function nextAt(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const at = new Date(now); at.setHours(h!, m!, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

function newJournal(kind: "update" | "rollback", o: { stateDir: string; databaseFile: string; from: RuntimeRef; to: RuntimeRef; when: When; at: string | null; actor: string }, now: Date): RuntimeUpdateJournal {
  const id = randomUUID(), stageDir = join(resolve(o.stateDir), "staged-upgrades", `${kind === "update" ? "release" : "rollback"}-${o.to.version}-${id.slice(0, 8)}`);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 }); chmodSync(stageDir, 0o700);
  return { version: 1, id, kind, stateDir: resolve(o.stateDir), databaseFile: o.databaseFile, stageDir, from: o.from, to: o.to, when: o.when, at: o.at, actor: o.actor, phase: "scheduled", detail: "", steps: [], startedAt: now.toISOString(), updatedAt: now.toISOString() };
}

function assertNoneActive(stateDir: string): void {
  const existing = readRuntimeUpdate(stateDir);
  if (existing && !runtimeUpdateTerminal(existing.phase)) throw new Refusal(`An update to ${existing.to.version} is already ${existing.phase === "scheduled" ? "scheduled" : "under way"} (${existing.detail}) Cancel it with toolroll update --cancel, or resume it with toolroll update --resume.`);
}

/** Record an update without running it: the console's job resumes exactly this journal id. */
export function prepareRuntimeUpdate(o: StartOptions, now: Date): RuntimeUpdateJournal | { refused: string } {
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) return { refused: `${o.version} is not a release version (x.y.z).` };
  if (!o.allowDowngrade && !isNewer(o.version, o.current.version)) return { refused: `Toolroll ${o.version} is not newer than ${o.current.version}. To go back to an older release, run toolroll update --version ${o.version} --allow-downgrade.` };
  try { assertNoneActive(o.stateDir); } catch (error) { return { refused: (error as Error).message }; }
  const at = o.when === "at" ? nextAt(o.at ?? "03:00", now).toISOString() : null;
  const j = newJournal("update", { stateDir: o.stateDir, databaseFile: o.databaseFile, from: o.current, to: { version: o.version, dist: "" }, when: o.when, at, actor: o.actor }, now);
  save(j, "scheduled", at ? `Scheduled for ${at}.` : "Starting.", now);
  if (at) ledger(j.databaseFile, now, j.actor, "toolroll update scheduled", "scheduled", `${j.from.version} → ${j.to.version} at ${at}`);
  return j;
}

/** Start an update: stage, verify, then run the journaled steps. */
export async function startRuntimeUpdate(o: StartOptions, system: UpdateSystem): Promise<UpdateOutcome> {
  if (o.version === o.current.version) return { ok: true, phase: "complete", message: `Toolroll ${o.version} is current.`, journal: null };
  const j = prepareRuntimeUpdate(o, system.now());
  if ("refused" in j) return { ok: false, phase: "refused", message: j.refused, journal: null };
  return driveRuntimeUpdate(j, system);
}

/** Return to the runtime and database backup an update replaced. */
export async function startRuntimeRollback(o: { stateDir: string; databaseFile: string; current: RuntimeRef; actor: string; when: When }, system: UpdateSystem): Promise<UpdateOutcome> {
  let last: RuntimeUpdateJournal | null;
  try { assertNoneActive(o.stateDir); last = readRuntimeUpdate(o.stateDir); } catch (error) { return { ok: false, phase: "refused", message: (error as Error).message, journal: null }; }
  if (!last || last.kind !== "update" || last.phase !== "complete" || !last.backupPath || !last.backupHash) return { ok: false, phase: "refused", message: "There is no completed update to roll back.", journal: null };
  if (!existsSync(join(last.from.dist, "bin.js")) || !existsSync(last.backupPath) || (last.codingBackupPath && !existsSync(last.codingBackupPath))) return { ok: false, phase: "refused", message: `The previous runtime (${last.from.version}) or its backup is no longer on this machine. Nothing was changed.`, journal: null };
  const now = system.now();
  const j = newJournal("rollback", { stateDir: o.stateDir, databaseFile: o.databaseFile, from: last.to, to: last.from, when: o.when, at: null, actor: o.actor }, now);
  j.restoreFrom = { path: last.backupPath, hash: last.backupHash, updateId: last.id, ...(last.codingBackupPath && last.codingBackupHash ? { codingPath: last.codingBackupPath, codingHash: last.codingBackupHash } : {}) };
  return driveRuntimeUpdate(j, system);
}

/** Continue a saved update after a crash, where it left off. With `id` (the console's job), only that update:
 * a job never starts a fresh one, and a finished, replaced or rolled-back one is left alone. */
export async function resumeRuntimeUpdate(stateDir: string, system: UpdateSystem, id?: string): Promise<UpdateOutcome> {
  const j = readRuntimeUpdate(stateDir);
  if (id !== undefined && j?.id !== id) return { ok: true, phase: j?.phase ?? "complete", message: "The update this job was started for is no longer the saved one. Nothing was changed.", journal: j };
  if (!j || runtimeUpdateTerminal(j.phase)) return { ok: true, phase: j?.phase ?? "complete", message: "No update is in progress.", journal: j };
  return driveRuntimeUpdate(j, system);
}

/** A prepared update whose job could not start. */
export function abandonRuntimeUpdate(stateDir: string, id: string, why: string, now: Date): void {
  const j = readRuntimeUpdate(stateDir);
  if (j?.id === id && j.phase === "scheduled") save(j, "refused", why, now);
}

export function requestRuntimeUpdateCancel(stateDir: string): string {
  const j = readRuntimeUpdate(stateDir);
  if (!j || runtimeUpdateTerminal(j.phase)) return "No update is in progress.";
  if (!["scheduled", "verifying", "draining"].includes(j.phase)) return `The update to ${j.to.version} is past the point it can be cancelled (${j.phase}); it will finish or restore on its own.`;
  durableJson(cancelFile(j), { id: j.id, action: "cancel" });
  return `Cancelling the update to ${j.to.version}. Nothing is switched; new work resumes.`;
}
const cancelRequested = (j: RuntimeUpdateJournal) => existsSync(cancelFile(j));

async function driveRuntimeUpdate(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<UpdateOutcome> {
  const lock = sqliteLock(join(j.stageDir, "worker.sqlite"), 1000);
  if (!lock) return { ok: false, phase: j.phase, message: `An updater is already working on the update to ${j.to.version}.`, journal: j };
  const at = (phase: RuntimePhase) => UPDATE_STEPS.indexOf(phase as UpdateStep);
  const step = (phase: RuntimePhase, detail: string) => { save(j, phase, detail, system.now()); system.checkpoint?.(phase); };
  const noun = j.kind === "update" ? "update" : "rollback";
  const verb = j.kind === "update" ? `${j.from.version} → ${j.to.version}` : `${j.from.version} → ${j.to.version} (back)`;
  const finish = (ok: boolean, phase: RuntimePhase, message: string, action: string, outcome: string, detail: string): UpdateOutcome => {
    save(j, phase, message, system.now());
    try { ledger(j.databaseFile, system.now(), j.actor, action, outcome, detail); } catch { /* the journal still says what happened */ }
    return { ok, phase, message, journal: j };
  };
  try {
    // Scheduled: wait for the time, still cancellable.
    if (j.phase === "scheduled" && j.at) {
      while (system.now() < new Date(j.at)) {
        if (cancelRequested(j)) return finish(true, "cancelled", `The ${noun} to ${j.to.version} was cancelled before it started. Nothing changed.`, `toolroll ${noun} cancelled`, "cancelled", verb);
        await system.sleep(Math.min(60_000, new Date(j.at).getTime() - system.now().getTime()));
      }
    }
    // Resumed past the switch: the only question left is whether the new runtime is healthy.
    const resumedAt = at(j.phase);
    if (j.phase === "rolling-back" || j.phase === "needs-attention") return await restore(j, system, finish, verb, j.error ?? "An earlier attempt stopped.");
    if (resumedAt < at("switching")) {
      if (resumedAt <= at("verifying")) {
        step("verifying", j.kind === "update" ? `Downloading and verifying Toolroll ${j.to.version}.` : `Checking the previous runtime (${j.to.version}) and its backup.`);
        if (j.kind === "update") await verify(j, system);
        else if (fileHash(j.restoreFrom!.path) !== j.restoreFrom!.hash || (j.restoreFrom!.codingPath && fileHash(j.restoreFrom!.codingPath) !== j.restoreFrom!.codingHash)) throw new Refusal("The update's backup changed since it was made. Nothing was changed.");
      }
      const unit = switchable(j, system).unit;
      if (!unit) refuseWhileWatching(j, system);
      if (resumedAt <= at("draining")) {
        step("draining", j.when === "now" ? "Checking that no work is running, then pausing new work." : "Pausing new work and letting running work finish. Nothing is being cancelled.");
        await drain(j, system);
        if (cancelRequested(j)) { ungate(j); return finish(true, "cancelled", `The ${noun} to ${j.to.version} was cancelled. Nothing changed; new work resumed.`, `toolroll ${noun} cancelled`, "cancelled", verb); }
      }
      // The service stops before the backup, so nothing it writes afterwards can be lost by a restore.
      step("backing-up", unit ? "Stopping the background service, then backing up the database." : "Backing up the database.");
      if (unit) await stopService(j, system, unit);
      refuseWhileWatching(j, system);
      const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
      try { assertCodingUpdateStopped(db); } finally { db.close(); }
      const backup = join(j.stageDir, existsSync(join(j.stageDir, "orders.backup.db")) ? `orders.backup.${randomUUID()}.db` : "orders.backup.db");
      j.backupHash = await verifiedDatabaseBackup(j.databaseFile, backup, j.id, async () => { await codingBackup(j); }); j.backupPath = backup;
      save(j, "backing-up", "Database and coding catalog backed up.", system.now());
      step("rehearsing", `Rehearsing ${j.to.version} on a copy of the database.`);
      j.rehearsal = await rehearse(j, system, j.restoreFrom?.path ?? j.backupPath);
    }
    if (resumedAt <= at("switching")) {
      step("switching", `Switching to ${j.to.version}.`);
      await switchRuntime(j, system);
    }
    if (resumedAt <= at("restarting")) {
      const unit = j.switched?.unit?.path ?? null;
      step("restarting", unit ? "Restarting the background service." : "No background service runs here; the commands now start the new version.");
      if (unit) await system.restartService(unit);
    }
    step("health", `Checking that ${j.to.version} is running and healthy.`);
    const deadline = system.now().getTime() + (system.healthTimeoutMs ?? 90_000);
    let healthy = false;
    do {
      healthy = await system.healthy(j);
      if (!healthy) await system.sleep(1000);
    } while (!healthy && system.now().getTime() < deadline);
    if (!healthy) throw Error(`Toolroll ${j.to.version} did not pass its health check.`);
    ungate(j);
    const done = j.kind === "update"
      ? finish(true, "complete", `Toolroll ${j.to.version} is running. Your previous version (${j.from.version}) and its backup are kept; toolroll update --rollback returns to them.`, "toolroll updated", "complete", verb)
      : finish(true, "complete", `Back on Toolroll ${j.to.version} with the database from before the update. The records made since are kept in ${basename(j.backupPath ?? "")}.`, "toolroll rolled back", "complete", verb);
    try { pruneRuntimes(j.stateDir, [j.to.dist, j.from.dist]); } catch { /* an old runtime left on disk is harmless */ }
    return done;
  } catch (error) {
    if ((error as { simulatedCrash?: boolean }).simulatedCrash) throw error;
    const message = error instanceof Error ? error.message : String(error);
    j.error = message.slice(0, 1500);
    if (!j.switched) {
      try { ungate(j); } catch { /* no gate yet, or the database is unreadable */ }
      // Nothing uses a refused download; the database backup is kept.
      if (j.kind === "update") rmSync(join(j.stageDir, "runtime"), { recursive: true, force: true });
      // A service stopped for the backup starts again, unchanged.
      let restarted = "";
      if (j.service) { try { await system.restartService(j.service.unit); } catch (again) { restarted = ` The background service did not start again: ${(again as Error).message}`; } }
      const refused = error instanceof Refusal;
      return finish(false, "refused", (refused ? message : `The ${noun} stopped before anything was switched: ${message} Nothing changed; new work resumed.`) + restarted, refused ? `toolroll ${noun} refused` : `toolroll ${noun} failed`, refused ? "refused" : "failed", `${verb}: ${message}`);
    }
    return await restore(j, system, finish, verb, message);
  } finally { lock.close(); }
}

/** The coding catalog, backed up inside the database's write reservation (as the desktop update does). */
async function codingBackup(j: RuntimeUpdateJournal): Promise<void> {
  const source = codingFile(j.databaseFile);
  if (!codingCatalogExists(source)) return;
  const target = join(j.stageDir, existsSync(join(j.stageDir, "coding.backup.sqlite")) ? `coding.backup.${randomUUID()}.sqlite` : "coding.backup.sqlite");
  await backupCodingCatalog(source, target, j.id);
  j.codingBackupPath = target; j.codingBackupHash = fileHash(target);
}

type Finish = (ok: boolean, phase: RuntimePhase, message: string, action: string, outcome: string, detail: string) => UpdateOutcome;
/** Put back the previous runtime, then this run's own backups of the database and coding catalog, keeping what
 * was written since in a named copy. */
async function restore(j: RuntimeUpdateJournal, system: UpdateSystem, finish: Finish, verb: string, why: string): Promise<UpdateOutcome> {
  const noun = j.kind === "update" ? "update" : "rollback";
  try {
    save(j, "rolling-back", `${why} Restoring ${j.from.version} and the database backup.`, system.now());
    system.checkpoint?.("rolling-back");
    const unit = j.switched?.unit?.path ?? j.service?.unit ?? null;
    if (unit) await stopService(j, system, unit);
    revertSwitch(j);
    if (!j.backupPath || !j.backupHash) throw Error("No verified backup was recorded.");
    if (!j.restoredDatabase) {
      // A fresh copy before EVERY attempt that is about to replace the database, not only the first: a retry
      // after a failure earlier in the restore must not overwrite writes made since without keeping them.
      j.keptAside = await keepAside(j); save(j, "rolling-back", j.detail, system.now());
      restoreDatabase(j, { path: j.backupPath, hash: j.backupHash, ...(j.codingBackupPath && j.codingBackupHash ? { codingPath: j.codingBackupPath, codingHash: j.codingBackupHash } : {}) });
      j.restoredDatabase = true; save(j, "rolling-back", j.detail, system.now());
    }
    if (unit) await system.restartService(unit);
    return finish(false, "restored", `${why} Toolroll ${j.from.version} and its database were restored. Anything written since the backup is kept in ${j.keptAside}.`, `toolroll ${noun} failed`, "restored", `${verb}: ${why}`.slice(0, 300));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(false, "needs-attention", `${why} Restoring the previous version also failed: ${message} Run toolroll update --resume to try again; the backup is kept at ${j.backupPath ?? "(none)"}.`, `toolroll ${noun} failed`, "needs attention", `${verb}: ${why} / ${message}`.slice(0, 300));
  }
}

async function verify(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  const release = await system.release(j.to.version);
  if (release.version !== j.to.version) throw new Refusal(`The registry answered with ${release.version}, not ${j.to.version}. Nothing was changed.`);
  if (!release.attestations) throw new Refusal(`Toolroll ${j.to.version} has no npm provenance, so it cannot be verified. Nothing was changed.`);
  const bytes = await system.download(release.tarball);
  const sha512 = createHash("sha512").update(bytes).digest();
  if (release.integrity !== `sha512-${sha512.toString("base64")}`) throw new Refusal(`The downloaded package does not match the registry's checksum. Nothing was changed.`);
  const provenance = checkProvenance(await system.attestations(release.attestations), j.to.version, sha512.toString("hex"));
  const runtime = join(j.stageDir, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  j.to.dist = await system.install(runtime, release);
  if (!j.to.dist.startsWith(runtime + sep) || !existsSync(join(j.to.dist, "bin.js"))) throw new Refusal("The staged runtime has no Toolroll command. Nothing was changed.");
  j.package = { sha512: sha512.toString("hex"), ...provenance };
  try { j.notes = releaseNotes(readFileSync(join(dirname(j.to.dist), "CHANGELOG.md"), "utf8"), j.to.version); } catch { j.notes = []; }
}

async function drain(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (j.when === "now") {
      const running = runningWorkWords(db) ?? lingeringWork(db);
      if (running) throw new Refusal(`Work is running: ${running}. Nothing was changed. Use When idle to wait for it.`);
      if (updateAdmissionPaused(db) && !updateGateOwned(db, j.id)) throw new Refusal("Another update owns the admission pause. Nothing was changed.");
      installUpdateGate(db, j.id);
      if (!freezeUpdateGate(db, j.id)) { removeUpdateGate(db, j.id); throw new Refusal(`Work started just now: ${runningWorkWords(db) ?? "a new run"}. Nothing was changed.`); }
      return;
    }
    installUpdateGate(db, j.id);
    for (;;) {
      if (cancelRequested(j)) return;
      const lingering = Object.values(activeUpdateWork(db)).every(n => n === 0) ? lingeringWork(db) : null;
      if (!lingering && freezeUpdateGate(db, j.id)) return;
      save(j, "draining", `New work is paused. Waiting for ${lingering ?? runningWorkWords(db) ?? "running work"} to finish. Nothing is being cancelled.`, system.now());
      await system.sleep(2000);
    }
  } finally { db.close(); }
}

/** Keep the newest release-* runtimes (and any in `keep`), at most KEEP_RUNTIMES; deploy-browser's browser-* and
 * the rollback-* records are not this updater's to remove. */
export function pruneRuntimes(stateDir: string, keep: readonly string[]): string[] {
  const root = join(stateDir, "staged-upgrades");
  const started = (dir: string) => { try { return String((JSON.parse(readFileSync(join(dir, "update.json"), "utf8")) as { startedAt?: string }).startedAt ?? ""); } catch { return statSync(dir).mtime.toISOString(); } };
  const releases = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("release-"))
    .map(entry => join(root, entry.name)).sort((a, b) => started(b).localeCompare(started(a)));
  const kept = new Set(releases.filter(dir => keep.some(dist => dist !== "" && dist.startsWith(dir + sep))));
  for (const dir of releases) if (kept.size < KEEP_RUNTIMES) kept.add(dir);
  const removed = releases.filter(dir => !kept.has(dir));
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
  return removed;
}

// ---- status for the console -----------------------------------------------

export type RuntimeUpdateStatus = {
  journal: RuntimeUpdateJournal | null;
  running: boolean;
  /** A completed update whose What's new card has not been dismissed. */
  whatsNew: { version: string; notes: string[] } | null;
};
export function runtimeUpdateStatus(stateDir: string): RuntimeUpdateStatus {
  let j: RuntimeUpdateJournal | null = null;
  try { j = readRuntimeUpdate(stateDir); } catch { j = null; }
  let running = false;
  if (j && !runtimeUpdateTerminal(j.phase)) { const lock = sqliteLock(join(j.stageDir, "worker.sqlite")); running = lock === null; lock?.close(); }
  const whatsNew = j && j.kind === "update" && j.phase === "complete" && !j.seen ? { version: j.to.version, notes: j.notes ?? [] } : null;
  return { journal: j, running, whatsNew };
}
export function markWhatsNewSeen(stateDir: string): void {
  const j = readRuntimeUpdate(stateDir);
  if (!j || j.seen || j.phase !== "complete") return;
  j.seen = true; durableJson(journalFile(stateDir), j); durableJson(join(j.stageDir, "update.json"), j);
}

// ---- the real machine -------------------------------------------------------

type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => { status: number | null; stdout: string; stderr: string };
const exec: Exec = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 300_000, maxBuffer: 16 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}) });
const LABELS = ["com.toolroll.browser", "com.standing-orders.browser"];

export function currentRuntime(version: string): RuntimeRef {
  return { version, dist: dirname(fileURLToPath(import.meta.url)) };
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Refusal(`${url} answered ${response.status}. Nothing was changed.`);
  return response.json();
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Seams for tests: npm and ps (`exec`), launchctl (`run`), and process liveness. */
export type MachineSeams = { exec?: Exec; run?: SupervisorRunner; alive?: (pid: number) => boolean };

export function machineSystem(home = homedir(), env: Record<string, string | undefined> = process.env, seams: MachineSeams = {}): UpdateSystem {
  const sh = seams.exec ?? exec;
  const supervise = seams.run ?? (async (file, args, options) => (await import("./exec.js")).run(file, args, options));
  const unitFor = (from: RuntimeRef) => {
    for (const label of LABELS) {
      const unit = join(home, "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(unit) && readFileSync(unit, "utf8").includes(from.dist)) return unit;
    }
    return null;
  };
  const labelOf = (unit: string) => basename(unit, ".plist");
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : userInfo().uid}`;
  const definition = (unit: string) => {
    const content = readFileSync(unit, "utf8");
    const logPath = content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? join(dirname(unit), `${labelOf(unit)}.log`);
    return { platform: "darwin" as const, label: labelOf(unit), unitPath: unit, unitContent: content, logPath, bin: process.execPath, entry: null };
  };
  return {
    now: () => new Date(),
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    release: async version => {
      const body = await json(`${REGISTRY}/${NAME}/${version}`) as { version?: string; dist?: { tarball?: string; integrity?: string; attestations?: { url?: string } } };
      return { version: String(body.version ?? ""), tarball: String(body.dist?.tarball ?? ""), integrity: String(body.dist?.integrity ?? ""), attestations: body.dist?.attestations?.url ?? null };
    },
    download: async url => {
      if (!url.startsWith(`${REGISTRY}/`)) throw new Refusal("The package is not hosted on the npm registry. Nothing was changed.");
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Refusal(`The package download answered ${response.status}. Nothing was changed.`);
      return new Uint8Array(await response.arrayBuffer());
    },
    attestations: url => json(url),
    install: async (runtime, release) => {
      // From the registry by name, so npm's signature and attestation check covers the package itself (a local
      // tarball is not checked), and the lockfile records exactly which bytes were installed.
      writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: `${NAME}-runtime`, private: true, dependencies: { [NAME]: release.version } }, null, 2));
      const registry = `--registry=${REGISTRY}/`;
      const installed = sh("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", registry], { cwd: runtime });
      if (installed.status !== 0) throw new Refusal(`npm could not install Toolroll ${release.version}: ${(installed.stderr || installed.stdout).trim().slice(-400)} Nothing was changed.`);
      let locked: { integrity?: string; resolved?: string; version?: string } | undefined;
      try { locked = (JSON.parse(readFileSync(join(runtime, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string; resolved?: string; version?: string }> }).packages?.[`node_modules/${NAME}`]; } catch { locked = undefined; }
      if (locked?.version !== release.version || locked.integrity !== release.integrity || !String(locked.resolved ?? "").startsWith(`${REGISTRY}/`)) throw new Refusal(`npm installed different bytes than the verified Toolroll ${release.version}. Nothing was changed.`);
      const signatures = sh("npm", ["audit", "signatures", registry], { cwd: runtime });
      const output = `${signatures.stdout}\n${signatures.stderr}`;
      if (signatures.status !== 0) throw new Refusal(`npm could not verify the package signatures: ${output.trim().slice(-400)} Nothing was changed.`);
      if (!/\b[1-9]\d* packages? ha(?:s|ve) (?:a )?verified attestations?\b/.test(output)) throw new Refusal(`npm did not verify Toolroll ${release.version}'s provenance attestation. Nothing was changed.`);
      return join(runtime, "node_modules", NAME, "dist");
    },
    rehearse: async (dist, copy) => {
      const script = `import(${JSON.stringify(pathToFileURL(join(dist, "store.js")).href)}).then(m => { m.openStore(${JSON.stringify(copy)}).close(); })`;
      const done = sh(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { timeout: 600_000 });
      if (done.status !== 0) throw new Refusal(`The new version could not open a copy of the database: ${(done.stderr || "").trim().slice(-400)} Nothing was changed.`);
    },
    commands: () => {
      const found = new Set<string>();
      for (const dir of (env["PATH"] ?? "").split(":").filter(Boolean)) {
        for (const name of [NAME, "standing-orders"]) {
          const path = join(dir, name);
          try { lstatSync(path); found.add(path); } catch { /* not here */ }
        }
      }
      return [...found];
    },
    serviceUnit: from => unitFor(from),
    servicePids: async unit => {
      const printed = await supervise("launchctl", ["print", `${domain}/${labelOf(unit)}`]);
      const pid = Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      return printed.code === 0 && pid > 1 ? [pid] : [];
    },
    stopService: async unit => {
      const stopped = await stopLaunchdService(definition(unit), supervise);
      if (!stopped.ok) throw Error(`${stopped.message}. Nothing was replaced.`);
    },
    restartService: async unit => {
      const started = await installLaunchdService(definition(unit), supervise);
      if (!started.ok) throw Error(`launchctl could not start the service: ${started.message}`);
    },
    processAlive: seams.alive ?? processAlive,
    healthy: async j => {
      const version = sh(process.execPath, [join(j.to.dist, "bin.js"), "--version"], { timeout: 30_000 });
      if (version.status !== 0 || version.stdout.trim() !== j.to.version) return false;
      for (const link of j.switched?.links ?? []) { try { if (realpathSync(link.path) !== realpathSync(join(j.to.dist, "bin.js"))) return false; } catch { return false; } }
      const unit = j.switched?.unit?.path;
      if (!unit) return true;
      const printed = await supervise("launchctl", ["print", `${domain}/${labelOf(unit)}`]);
      const pid = Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      if (!(pid > 1) || !printed.stdout.includes("state = running")) return false;
      if (!sh("/bin/ps", ["-p", String(pid), "-o", "command="]).stdout.includes(j.to.dist)) return false;
      const port = readFileSync(unit, "utf8").match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/)?.[1];
      if (!port) return true;
      const answered = await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => null);
      return answered !== null && answered.status < 500;
    },
  };
}

const jobUnit = (home: string) => join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`);

/** The console starts the updater for one prepared journal as its own one-off
 * launchd job, so the service it restarts is not its parent. The job resumes
 * that id only; it does not run at login (no RunAtLoad: launchd starts it
 * with a kickstart) and removes its definition when it finishes. Elsewhere it
 * is a detached process. */
export async function launchRuntimeUpdate(args: { databaseFile: string; id: string; dist?: string }, seams: { home?: string; run?: SupervisorRunner; platform?: NodeJS.Platform } = {}): Promise<void> {
  const dist = args.dist ?? dirname(fileURLToPath(import.meta.url));
  const command = [process.execPath, join(dist, "bin.js"), "update", "--resume", "--id", args.id, "--db", args.databaseFile];
  const stateDir = dirname(args.databaseFile);
  const log = join(stateDir, "toolroll-update.log");
  if ((seams.platform ?? process.platform) === "darwin") {
    const home = seams.home ?? homedir();
    const run = seams.run ?? (await import("./exec.js")).run;
    const unit = launchdPlist({ label: UPDATE_JOB_LABEL, command, workingDirectory: stateDir, logPath: log, pathEnv: [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), keepAlive: false, runAtLoad: false });
    const started = await installLaunchdService({ platform: "darwin", label: UPDATE_JOB_LABEL, bin: process.execPath, entry: join(dist, "bin.js"), logPath: log, unitPath: jobUnit(home), unitContent: unit }, run);
    if (!started.ok) throw Error(started.message);
    return;
  }
  const { spawn } = await import("node:child_process");
  const out = openSync(log, "a", 0o600);
  spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", out, out], cwd: stateDir }).unref();
}

/** The job's last act: its definition goes, so nothing can start it again. Only the definition for this id. */
export function retireUpdateJob(id: string, home = homedir()): void {
  const unit = jobUnit(home);
  try { if (readFileSync(unit, "utf8").includes(`<string>${id}</string>`)) rmSync(unit, { force: true }); } catch { /* none */ }
}

export const nextScheduledAt = nextAt;
