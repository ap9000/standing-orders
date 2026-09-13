import { createHash, randomUUID } from "node:crypto";
import { closeSync, chmodSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { bundleHash, readDesktopBundle, verifyDesktopUpdateBundles, type DesktopBundle } from "./desktop-bundle.js";
import { readDesktopConfig, desktopServiceCommand, desktopServiceDefinition, verifyDesktopLiveness, type DesktopConfig } from "./desktop-host.js";
import { daemonStatus } from "./daemon.js";
import { run } from "./exec.js";
import { readSchemaVersion, SCHEMA_VERSION, Store } from "./store.js";
import { activeUpdateWork, freezeUpdateGate, installUpdateGate, removeUpdateGate, updateAdmissionPaused } from "./desktop-update-gate.js";
import { currentDesktopAccess } from "./desktop-access.js";

type Phase = "prepared" | "draining" | "backing-up" | "stopping" | "installing" | "verifying" | "rolling-back" | "releasing" | "complete" | "restored" | "cancelled" | "needs-attention";
export type UpdateJournal = {
  version: 1; id: string; stateDir: string; workDir: string; label: string; databaseFile: string; configHash: string;
  old: DesktopBundle; next: DesktopBundle; phase: Phase; intended: "install" | "restore";
  startedAt: string; updatedAt: string; wasRunning: boolean; backupHash?: string; backupPath?: string;
  detail: string; error?: string; checkedAt?: string;
  serviceInterrupted?: boolean;
  retryableRecovery?: boolean;
};
type ServiceState = { state: string; stale?: boolean };
export type UpdateHooks = {
  verify?: (old: DesktopBundle, next: DesktopBundle) => Promise<void>;
  serviceStatus?: (bundle: DesktopBundle, journal: Pick<UpdateJournal, "stateDir" | "label">) => Promise<ServiceState>;
  service?: (action: "start" | "stop", bundle: DesktopBundle, journal: UpdateJournal) => Promise<void>;
  healthy?: (bundle: DesktopBundle, journal: UpdateJournal, since: string) => Promise<boolean>;
  swap?: (journal: UpdateJournal) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  /** Fault injection for state-machine tests, never selectable by a CLI flag. */
  checkpoint?: (phase: Phase) => void;
  otherControllers?: (bundle: DesktopBundle, stateDir: string) => Promise<boolean>;
};
export const updateTerminal = (phase: string) => ["complete", "restored", "cancelled"].includes(phase);
const terminal = updateTerminal;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (config: DesktopConfig) => digest(config);
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const journalPath = (state: string) => join(state, "desktop-update.json");
const payload = (j: UpdateJournal) => join(j.workDir, "Updater.app");
const standby = (j: UpdateJournal) => join(j.workDir, "Standby.app");
const atInstalled = (bundle: DesktopBundle, j: UpdateJournal) => ({ ...bundle, path: j.old.path });

/** Durable receipts are private and independent of the app being replaced. */
export function durableJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function save(j: UpdateJournal, phase: Phase, detail: string): void {
  j.phase = phase; j.detail = detail; j.updatedAt = new Date().toISOString();
  durableJson(join(j.workDir, "receipt.json"), j); durableJson(journalPath(j.stateDir), j);
}
function privateFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw Error("The update record must be an owner-only regular file.");
}
export function readUpdateJournal(stateDir: string, retainedReceipt?: string): UpdateJournal | null {
  const file = retainedReceipt ?? journalPath(stateDir);
  if (!existsSync(file)) return null;
  privateFile(file);
  const j = JSON.parse(readFileSync(file, "utf8")) as UpdateJournal;
  if (j.version !== 1 || !/^[a-f0-9-]{36}$/.test(j.id) || j.stateDir !== resolve(stateDir) || !isAbsolute(j.old?.path ?? "") || j.workDir !== join(dirname(j.old.path), ".standing-orders-updates", j.id) || !/^[a-zA-Z0-9.-]+$/.test(j.label) || !["install", "restore"].includes(j.intended) || !["prepared", "draining", "backing-up", "stopping", "installing", "verifying", "rolling-back", "releasing", "complete", "restored", "cancelled", "needs-attention"].includes(j.phase)) throw Error("The saved update record is invalid. Preserve it and the app backups; nothing was changed.");
  if (retainedReceipt && retainedReceipt !== join(j.workDir, "receipt.json")) throw Error("The retained recovery receipt is at the wrong path.");
  const validBundle = (b: DesktopBundle) => b && isAbsolute(b.path) && b.path.endsWith(".app") && /^[a-f0-9]{64}$/.test(b.hash) && /^[a-f0-9-]{36}$/.test(b.buildId) && /^\d+\.\d+\.\d+$/.test(b.version) && b.schemaVersion === SCHEMA_VERSION && b.bundleId === (b.development === true ? "com.standing-orders.desktop.development" : "com.standing-orders.desktop") && typeof b.providerBin === "string";
  if (!validBundle(j.old) || !validBundle(j.next) || j.old.bundleId !== j.next.bundleId || !isAbsolute(j.databaseFile) || !/^[a-f0-9]{64}$/.test(j.configHash) || typeof j.wasRunning !== "boolean" || (j.backupPath && (dirname(j.backupPath) !== j.workDir || !/^orders\.backup(?:\.[a-f0-9-]{36})?\.db$/.test(basename(j.backupPath)))) || (j.backupHash && !/^[a-f0-9]{64}$/.test(j.backupHash))) throw Error("The saved update paths or build identities are invalid. Nothing was changed.");
  for (const directory of [dirname(j.workDir), j.workDir]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw Error("The update folder must be a private, owner-controlled directory.");
  }
  return j;
}
function connect(file: string, readOnly = false): DatabaseSync {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw Error("The task database is missing or linked. It was not recreated.");
  const db = new DatabaseSync(file, { readOnly }); db.exec("PRAGMA busy_timeout=1000");
  const schema = readSchemaVersion(db);
  if (!schema.ok || schema.version !== SCHEMA_VERSION) { db.close(); throw Error("This update needs the current database schema. Use the separate verified migration procedure; the installed app is unchanged."); }
  return db;
}
const resources = (app: DesktopBundle) => join(app.path, "Contents", "Resources");
const serviceArgs = (app: DesktopBundle, j: Pick<UpdateJournal, "label"> & { id?: string }) => ["--node", join(resources(app), "runtime", "node"), "--helper", join(resources(app), "dist", "desktop-host.js"), "--label", j.label, "--bundle-id", app.bundleId, "--provider-bin", app.providerBin, "--build-id", app.buildId, ...(j.id ? ["--update-id", j.id] : [])];
async function serviceState(bundle: DesktopBundle, j: Pick<UpdateJournal, "stateDir" | "label">): Promise<ServiceState> {
  return await desktopServiceCommand("service-status", j.stateDir, readDesktopConfig(j.stateDir), serviceArgs(bundle, j)) as unknown as ServiceState;
}
async function service(action: "start" | "stop", bundle: DesktopBundle, j: UpdateJournal): Promise<void> {
  await desktopServiceCommand(`service-${action}`, j.stateDir, readDesktopConfig(j.stateDir), serviceArgs(bundle, j));
}
async function healthy(bundle: DesktopBundle, j: UpdateJournal, since: string): Promise<boolean> {
  const config = readDesktopConfig(j.stateDir);
  const definition = desktopServiceDefinition(j.stateDir, { node: join(resources(bundle), "runtime", "node"), helper: join(resources(bundle), "dist", "desktop-host.js"), label: j.label, bundleId: bundle.bundleId, buildId: bundle.buildId, providerBin: bundle.providerBin, ...(config.containment ? { containment: config.containment } : {}) });
  const status = await daemonStatus(definition, run);
  if (status.state !== "running" || status.stale || !(await verifyDesktopLiveness(config)).alive) return false;
  try {
    const supervisor = JSON.parse(readFileSync(join(j.stateDir, "controller-supervisor.json"), "utf8"));
    const access = JSON.parse(readFileSync(join(j.stateDir, "project-access.json"), "utf8"));
    if (supervisor.buildId !== bundle.buildId || supervisor.updatedAt < since || access.checkedAt < since || !currentDesktopAccess(access, supervisor, config.repos, readFileSync(join(j.stateDir, "project-access-request"), "utf8")).verified) return false;
    const db = connect(j.databaseFile, true);
    try { return config.repos.length > 0 && config.repos.every(repo => db.prepare("SELECT 1 FROM watch_lease WHERE runner=? AND repo=? AND expires_at>?").get(config.runnerName ?? "", repo, new Date().toISOString())); }
    finally { db.close(); }
  } catch { return false; }
}
async function swap(j: UpdateJournal): Promise<void> {
  const result = await run(join(payload(j), "Contents", "Resources", "runtime", "bundle-swap"), [j.old.path, standby(j)], { timeoutMs: 10_000, maxBuffer: 8192 });
  if (result.code !== 0) throw Error((result.stderr || "The volume refused an atomic app swap. Neither bundle was deleted.").slice(0, 1000));
}
async function otherControllers(app: DesktopBundle, stateDir: string): Promise<boolean> {
  const result = await run("/bin/ps", ["-axo", "command="], { timeoutMs: 5000, maxBuffer: 4_194_304 });
  if (result.code !== 0) throw Error("Other app controllers could not be checked. No app swap was attempted.");
  const command = `${join(resources(app), "runtime", "node")} ${join(resources(app), "dist", "desktop-host.js")} serve --state `;
  return result.stdout.split("\n").some(line => line.trim().startsWith(command) && line.trim() !== command + resolve(stateDir));
}
function lingeringWork(db: DatabaseSync): string | null {
  const store = new Store(db);
  for (const row of db.prepare("SELECT DISTINCT run FROM run_process WHERE exited_at IS NULL").all()) {
    const problem = store.stopQuiescenceProblem(Number(row.run));
    if (problem) return problem;
  }
  return null;
}

export async function previewDesktopUpdate(stateDir: string, installed: string, candidate: string, label: string, hooks: UpdateHooks = {}) {
  const config = readDesktopConfig(stateDir), old = readDesktopBundle(resolve(installed)), next = readDesktopBundle(resolve(candidate));
  if (!/^[a-zA-Z0-9.-]+$/.test(label)) throw Error("Invalid service label.");
  const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (inside(old.path, next.path) || inside(next.path, old.path) || [old.path, next.path].some(app => inside(app, resolve(stateDir)) || inside(app, resolve(config.databaseFile)))) throw Error("The installed app, candidate and saved state must be separate paths.");
  if (old.buildId === next.buildId || old.hash === next.hash) throw Error("This build is already installed.");
  if (old.bundleId !== next.bundleId) throw Error("A development preview cannot replace a release identity.");
  if (old.schemaVersion !== SCHEMA_VERSION || next.schemaVersion !== SCHEMA_VERSION) throw Error("This release needs a database migration. Use the separate verified migration procedure; the installed app is unchanged.");
  if (next.recoveryProtocol !== 1) throw Error("This candidate predates automatic update recovery. Choose a current build; the installed app is unchanged.");
  const db = connect(config.databaseFile, true); let active;
  try { if (updateAdmissionPaused(db)) throw Error("An update still owns the admission pause. Open Update status to recover it before starting another update."); active = activeUpdateWork(db); } finally { db.close(); }
  const existing = readUpdateJournal(stateDir);
  if (existing && !terminal(existing.phase)) throw Error("An update is already recorded. Open Update status to continue or cancel it.");
  await (hooks.verify ?? verifyDesktopUpdateBundles)(old, next);
  if (await (hooks.otherControllers ?? otherControllers)(old, stateDir)) throw Error("Another installation is using this app. Stop its background service before updating this shared app.");
  const status = await (hooks.serviceStatus ?? serviceState)(old, { stateDir, label });
  if (status.stale && ["running", "loaded"].includes(status.state)) throw Error("The service does not match the installed app. Reconnect it with Start background service before updating.");
  const plan = { old, next, configHash: fingerprint(config), label, stateDir: resolve(stateDir), databaseFile: config.databaseFile, wasRunning: ["running", "loaded"].includes(status.state) };
  return { ...plan, digest: digest(plan), active, message: "New work will wait while current work finishes. A verified private backup and the previous app will be kept. The database will not be migrated or restored automatically." };
}

export async function prepareDesktopUpdate(stateDir: string, installed: string, candidate: string, label: string, expected: string, hooks: UpdateHooks = {}): Promise<UpdateJournal> {
  const plan = await previewDesktopUpdate(stateDir, installed, candidate, label, hooks);
  if (plan.digest !== expected) throw Error("The app, configuration or update changed since preview. Review the update again.");
  const id = randomUUID(), workDir = join(dirname(plan.old.path), ".standing-orders-updates", id);
  mkdirSync(workDir, { recursive: true, mode: 0o700 }); chmodSync(dirname(workDir), 0o700); chmodSync(workDir, 0o700);
  // The staged updater stays put while Standby and the installation exchange.
  cpSync(plan.next.path, join(workDir, "Updater.app"), { recursive: true, errorOnExist: true, force: false });
  cpSync(plan.next.path, join(workDir, "Standby.app"), { recursive: true, errorOnExist: true, force: false });
  if (bundleHash(join(workDir, "Updater.app")) !== plan.next.hash || bundleHash(join(workDir, "Standby.app")) !== plan.next.hash) throw Error("The staged update changed during copying. The installed app is unchanged.");
  const journal: UpdateJournal = { version: 1, id, workDir, ...plan, phase: "prepared", intended: "install", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: "Update prepared; waiting to pause new work." };
  // Two starts may finish copying together. Reserve the installation's one
  // active journal atomically; never replace another pending update.
  const reservation = installationLock(journal);
  if (!reservation) throw Error("This app is already being updated. Open Update status in its controlling installation.");
  try {
    reservation.exec("CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), state TEXT NOT NULL)");
    const owner = reservation.prepare("SELECT state FROM owner WHERE slot=1").get();
    const pending = owner ? readUpdateJournal(String(owner.state)) : null;
    if (pending && !terminal(pending.phase)) throw Error("Another installation already has an update prepared for this app. Continue or cancel it there first.");
    const existing = readUpdateJournal(stateDir);
    if (existing && !terminal(existing.phase)) throw Error("Another update was started. Its record was not replaced.");
    reservation.prepare("INSERT INTO owner(slot,state) VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET state=excluded.state").run(resolve(stateDir));
    save(journal, "prepared", journal.detail);
    reservation.exec("COMMIT");
  } finally { reservation.close(); }
  return journal;
}

export function sqliteLock(file: string, busyTimeoutMs = 0): DatabaseSync | null {
  if (existsSync(file)) privateFile(file);
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  try { db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; BEGIN EXCLUSIVE`); return db; }
  catch (error) { db.close(); if (String(error).includes("locked") || [5, 6].includes((error as { errcode?: number }).errcode ?? 0)) return null; throw error; }
}
const workerLock = (j: UpdateJournal, busyTimeoutMs = 0) => sqliteLock(join(j.workDir, "worker.sqlite"), busyTimeoutMs);
export const installationLock = (j: UpdateJournal) => sqliteLock(join(dirname(j.workDir), `installation-${digest(j.old.path).slice(0, 24)}.sqlite`));
export function desktopUpdateStatus(stateDir: string) {
  const j = readUpdateJournal(stateDir);
  if (!j) return { active: false, phase: "none", detail: "No update is in progress.", running: false, canResume: false, canCancel: false };
  const lock = workerLock(j), running = lock === null; lock?.close();
  let recovery: { id?: string; state?: string; detail?: string; attempts?: number; repairs?: number; updatedAt?: string } | null = null;
  try { privateFile(join(j.workDir, "recovery.json")); recovery = JSON.parse(readFileSync(join(j.workDir, "recovery.json"), "utf8")); } catch { /* A legacy/manual update has no guardian. */ }
  const wantsAutomatic = recovery?.id === j.id && ["armed", "running", "backoff"].includes(recovery.state ?? "") && !terminal(j.phase);
  const guardianLock = wantsAutomatic ? sqliteLock(join(j.workDir, "guardian.sqlite")) : undefined;
  const automatic = wantsAutomatic && (guardianLock === null || Date.now() - Date.parse(recovery?.updatedAt ?? "") < 45_000); guardianLock?.close();
  const detail = wantsAutomatic && !automatic ? "Automatic recovery has not restarted. Work remains paused; use Retry safely in Update status." : recovery?.state === "attention" || (automatic && (!running || j.phase === "needs-attention")) ? recovery?.detail ?? j.detail : j.detail;
  return { active: !terminal(j.phase), phase: j.phase, detail, error: j.error ?? null, running, automaticRecovery: automatic, recoveryAttempts: recovery?.attempts ?? 0, recoveryRepairs: recovery?.repairs ?? 0, canResume: !running && !automatic && !terminal(j.phase), canCancel: !terminal(j.phase), wasRunning: j.wasRunning && !updateStopRequested(j), backupPath: j.backupPath ?? null, updateId: j.id, version: j.next.version, buildId: j.next.buildId, workDir: j.workDir };
}
export function updateStopRequested(j: UpdateJournal): boolean {
  const file = join(j.workDir, "stop-request.json");
  if (!existsSync(file)) return false;
  privateFile(file);
  const request = JSON.parse(readFileSync(file, "utf8"));
  if (request.id !== j.id || request.action !== "stop") throw Error("The saved stop request is invalid. Automatic starts are refused.");
  return true;
}
export function requestUpdateStop(stateDir: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) return;
  durableJson(join(j.workDir, "stop-request.json"), { id: j.id, action: "stop" });
  requestUpdateRestore(stateDir);
}
export function requestUpdateRestore(stateDir: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) throw Error("There is no pending update to cancel.");
  durableJson(join(j.workDir, "request.json"), { id: j.id, action: "restore" });
}
function restoreRequested(j: UpdateJournal): boolean {
  try { const request = JSON.parse(readFileSync(join(j.workDir, "request.json"), "utf8")); return request.id === j.id && request.action === "restore"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function launchDesktopUpdate(stateDir: string, retry = false): Promise<void> {
  const { armUpdateRecovery } = await import("./desktop-update-recovery.js");
  await armUpdateRecovery(stateDir, retry);
}

export function pauseUpdateRecovery(stateDir: string, id: string, detail: string): void {
  const j = readUpdateJournal(stateDir);
  if (!j || j.id !== id || terminal(j.phase)) return;
  const lock = workerLock(j, 1000); if (!lock) throw Error("An updater still owns this operation; its state was not replaced.");
  try { j.retryableRecovery = false; save(j, "needs-attention", detail); } finally { lock.close(); }
}
class RetryableUpdateError extends Error {}

function assertConfig(j: UpdateJournal): void {
  const config = readDesktopConfig(j.stateDir);
  if (config.databaseFile !== j.databaseFile || fingerprint(config) !== j.configHash) throw Error("Project or installation settings changed during the update. Keep the current app and review a fresh update.");
}
function snapshot(db: DatabaseSync): string {
  const result: Record<string, unknown> = {};
  for (const table of ["task", "task_scope", "approver", "run", "artifact", "mate_message", "project"]) {
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    result[table] = rows;
  }
  return digest(result);
}
async function verifiedBackup(j: UpdateJournal): Promise<void> {
  const file = join(j.workDir, "orders.backup.db");
  if (j.backupHash) { if (!j.backupPath || fileHash(j.backupPath) !== j.backupHash) throw Error("The retained backup changed. It was not overwritten."); return; }
  // A crashed partial attempt gets a fresh filename; no backup is overwritten.
  const backupPath = existsSync(file) ? join(j.workDir, `orders.backup.${randomUUID()}.db`) : file;
  const db = connect(j.databaseFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    // The write reservation prevents a concurrent writer; a separate read
    // connection is required because SQLite cannot back up a write transaction.
    const source = connect(j.databaseFile, true);
    let before: string;
    try { before = snapshot(source); await backup(source, backupPath); } finally { source.close(); }
    chmodSync(backupPath, 0o600);
    const copied = connect(backupPath);
    try {
      if (copied.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || copied.prepare("PRAGMA foreign_key_check").all().length !== 0 || snapshot(copied) !== before) throw Error("Backup verification failed. The installed app is unchanged.");
      removeUpdateGate(copied, j.id);
    } finally { copied.close(); }
    db.exec("COMMIT");
    for (const [source, name] of [[join(j.stateDir, "desktop.json"), "desktop.json"], [join(dirname(j.databaseFile), "repos.json"), "repos.json"], [join(dirname(j.databaseFile), "up-login.txt"), "up-login.txt"]]) {
      if (source && name && existsSync(source)) {
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw Error("A saved configuration file is linked or not a regular file. Nothing was replaced.");
        if (name === "up-login.txt") privateFile(source);
        copyFileSync(source, join(j.workDir, name)); chmodSync(join(j.workDir, name), 0o600);
      }
    }
    const fd = openSync(backupPath, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    j.backupPath = backupPath; j.backupHash = fileHash(backupPath);
    save(j, "backing-up", "Private database backup verified; saved tasks and evidence match.");
  } finally { db.close(); }
}

/** A SQLite OS lock releases on updater death. Each irreversible step has a
 * preceding durable intent; recovery determines the actual side by hashes. */
export async function runDesktopUpdate(stateDir: string, hooks: UpdateHooks = {}): Promise<void> {
  let j = readUpdateJournal(stateDir);
  if (!j || terminal(j.phase)) return;
  // A status probe briefly tries this same lock. Give it time to finish;
  // treating its millisecond lock as a live updater stranded resume/start.
  const lock = workerLock(j, 1000); if (!lock) return;
  const latest = readUpdateJournal(stateDir);
  if (!latest || latest.id !== j.id || terminal(latest.phase)) { lock.close(); return; }
  j = latest;
  let installation: DatabaseSync | null;
  try { installation = installationLock(j); } catch (error) { lock.close(); throw error; }
  if (!installation) { lock.close(); throw Error("Another updater is working on this app. Its operation was not interrupted."); }
  const sleep = hooks.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const control = async (action: "start" | "stop", bundle: DesktopBundle, journal: UpdateJournal) => {
    if (action === "start" && updateStopRequested(journal)) throw Error("You stopped the background service. Automatic restart is disabled for this update.");
    try { await (hooks.service ?? service)(action, bundle, journal); }
    catch (error) { throw new RetryableUpdateError(error instanceof Error ? error.message : String(error)); }
  };
  const status = hooks.serviceStatus ?? serviceState;
  const checkpoint = (phase: Phase, text: string) => { save(j, phase, text); hooks.checkpoint?.(phase); };
  const waitHealthy = async (bundle: DesktopBundle) => {
    const since = new Date().toISOString();
    writeFileSync(join(j.stateDir, "project-access-request"), randomUUID(), { mode: 0o600 });
    await control("start", bundle, j);
    const deadline = Date.now() + (hooks.healthTimeoutMs ?? 60_000);
    do {
      if (updateStopRequested(j) || (j.intended === "install" && restoreRequested(j))) throw Error("The operator requested the previous app or stopped the service.");
      if (await (hooks.healthy ?? healthy)(bundle, j, since)) { j.checkedAt = new Date().toISOString(); return; }
      await sleep(500);
    } while (Date.now() < deadline);
    throw new RetryableUpdateError("The worker did not confirm its build, project access and console connection. The update cannot be marked complete.");
  };
  const release = (phase: "complete" | "restored" | "cancelled", message: string) => {
    checkpoint("releasing", message);
    const db = connect(j.databaseFile); try { removeUpdateGate(db, j.id); } finally { db.close(); }
    checkpoint(phase, message);
  };
  const restore = async () => {
    j.intended = "restore";
    checkpoint("rolling-back", "Restoring the previous app. The current task database will be kept.");
    assertConfig(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop that service before resuming recovery.");
    const db = connect(j.databaseFile);
    try { installUpdateGate(db, j.id); if (!freezeUpdateGate(db, j.id)) throw Error("Work is still active. The app will not be swapped until it finishes."); } finally { db.close(); }
    const actual = bundleHash(j.old.path);
    if (actual === j.next.hash) {
      await control("stop", atInstalled(j.next, j), j);
      if (["running", "loaded"].includes((await status(atInstalled(j.next, j), j)).state)) throw Error("The candidate service is still running. The previous app was not swapped in.");
      const checking = connect(j.databaseFile, true);
      try { const problem = lingeringWork(checking); if (problem) throw Error(problem); } finally { checking.close(); }
      if (bundleHash(standby(j)) !== j.old.hash) throw Error("The previous app backup changed. Nothing was replaced.");
      await (hooks.swap ?? swap)(j);
    } else if (actual !== j.old.hash) throw Error("The installed app no longer matches either recorded build. Nothing was replaced.");
    if (j.wasRunning && !updateStopRequested(j)) await waitHealthy(j.old); else await control("stop", j.old, j);
    release("restored", "Previous app restored. Your current tasks and evidence were preserved." + (j.error ? ` Update stopped because: ${j.error}` : ""));
  };
  const cancel = async () => {
    // A resumed operation may already have swapped or stopped the service,
    // even though its new drain pass is now showing "draining".
    if (bundleHash(j.old.path) === j.old.hash && !j.serviceInterrupted) release("cancelled", "Update cancelled. The installed app and current work are unchanged; any verified backup was kept.");
    else await restore();
  };
  try {
    const owner = installation.prepare("SELECT state FROM owner WHERE slot=1").get();
    if (owner?.state !== j.stateDir) throw Error("Another installation owns this app update. Its work was not interrupted.");
    assertConfig(j);
    if (bundleHash(payload(j)) !== j.next.hash) throw Error("The staged updater changed. Preserve the update folder and recover with a verified release.");
    if (j.intended === "restore" || restoreRequested(j) || updateStopRequested(j)) {
      if (j.intended !== "restore") { await cancel(); return; }
      await restore(); return;
    }
    const db = connect(j.databaseFile);
    try { installUpdateGate(db, j.id); } finally { db.close(); }
    checkpoint("draining", "Waiting for current work to finish. New work is paused; no task will be killed for this update.");
    for (;;) {
      if (restoreRequested(j) || updateStopRequested(j)) { await cancel(); return; }
      assertConfig(j);
      const checking = connect(j.databaseFile);
      try {
        const active = activeUpdateWork(checking);
        const lingering = Object.values(active).every(n => n === 0) ? lingeringWork(checking) : null;
        if (!lingering && Object.values(active).every(n => n === 0) && freezeUpdateGate(checking, j.id)) break;
        save(j, "draining", lingering ? `Waiting for a worker to finish shutdown: ${lingering}. No process is being killed.` : `Waiting for current work: ${active.runs} runs, ${active.claims} leases, ${active.conversations} chat requests, ${active.sessions} sessions, ${active.stopping} shutdowns. Nothing is being cancelled.`);
      } finally { checking.close(); }
      await sleep(1000);
    }
    checkpoint("backing-up", "Creating and verifying a private backup of tasks, approvals and evidence.");
    await verifiedBackup(j);
    if (restoreRequested(j)) { await cancel(); return; }
    assertConfig(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop its background service before continuing.");
    if (restoreRequested(j)) { await cancel(); return; }
    const actual = bundleHash(j.old.path);
    if (actual !== j.old.hash && actual !== j.next.hash) throw Error("The installed app changed after preview. Nothing was replaced.");
    const current = actual === j.old.hash ? j.old : atInstalled(j.next, j);
    j.serviceInterrupted = true;
    checkpoint("stopping", "Current work is finished. Stopping the background service for the update.");
    await control("stop", current, j);
    const stopped = await status(current, j);
    if (["running", "loaded"].includes(stopped.state)) throw Error("The background service did not stop. No app swap was attempted.");
    const afterStop = connect(j.databaseFile, true);
    try {
      if (Object.values(activeUpdateWork(afterStop)).some(n => n !== 0) || afterStop.prepare("SELECT 1 FROM watch_lease WHERE expires_at>? LIMIT 1").get(new Date().toISOString())) throw Error("A worker or active operation still uses this database. Stop the other controller before continuing the update.");
    } finally { afterStop.close(); }
    assertConfig(j);
    if (await (hooks.otherControllers ?? otherControllers)(j.old, j.stateDir)) throw Error("Another installation is using this app. Stop its background service before continuing.");
    if (restoreRequested(j)) { await restore(); return; }
    checkpoint("installing", "Installing the verified app with an atomic swap. The previous app will be retained.");
    if (actual === j.old.hash) {
      const next = readDesktopBundle(standby(j));
      if (next.hash !== j.next.hash) throw Error("The staged app changed. The installed app was not replaced.");
      await (hooks.verify ?? verifyDesktopUpdateBundles)(j.old, next);
      await (hooks.swap ?? swap)(j);
    } else if (bundleHash(standby(j)) !== j.old.hash) throw Error("The retained previous app no longer matches the update record.");
    if (bundleHash(j.old.path) !== j.next.hash) throw Error("The installed app did not match the approved update.");
    checkpoint("verifying", "Checking the new worker, project access and console connection. New work remains paused.");
    await waitHealthy(atInstalled(j.next, j));
    if (!j.wasRunning) await control("stop", atInstalled(j.next, j), j);
    release("complete", j.wasRunning ? "Update complete. The new worker is verified and queued work can resume." : "Update complete and verified. The service remains stopped, as it was before the update.");
  } catch (error) {
    if ((error as { simulatedCrash?: boolean }).simulatedCrash) throw error;
    j.error = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
    const sqliteCode = Number((error as { errcode?: number }).errcode) & 255;
    if ([5, 6].includes(sqliteCode)) {
      j.retryableRecovery = true;
      save(j, "needs-attention", "The task database is temporarily busy. Automatic recovery will retry the saved operation; no app or database was overwritten.");
      return;
    }
    try {
      if (j.phase === "releasing") throw Error("Finishing the update record was interrupted. Resume to verify the installed app; no database rollback was attempted.");
      if (j.serviceInterrupted || bundleHash(j.old.path) === j.next.hash || ["stopping", "installing", "verifying", "rolling-back"].includes(j.phase)) await restore();
      else {
        const db = connect(j.databaseFile); try { removeUpdateGate(db, j.id); } finally { db.close(); }
        checkpoint("cancelled", "The update stopped before installation. The previous app and task database are unchanged. " + j.error);
      }
    } catch (recoveryError) {
      if ((recoveryError as { simulatedCrash?: boolean }).simulatedCrash) throw recoveryError;
      j.retryableRecovery = recoveryError instanceof RetryableUpdateError;
      save(j, "needs-attention", `${j.error} Recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)} Open Update status to retry recovery. The database and app backups were kept.`);
    }
  } finally { installation.close(); lock.close(); }
}
