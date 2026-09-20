#!/usr/bin/env node
// One-action deployment of a verified candidate into the browser installation.
//
//   node scripts/deploy-browser.mjs --run <builder run id> [--yes] [--phase <name>]
//
// Run it from the candidate's own checkout (the builder's worktree). It stages
// the packed runtime beside the installed ones, proves the candidate against
// the plane's own records — verified machine proof, a settled independent
// review that upheld every signed criterion, the exact approved command — and
// then drains, backs up, rehearses, swaps the launchd service, migrates, and
// re-opens admission, journaling every phase so a crash resumes or restores.
//
// Phases: stage → prepare → rehearse → swap → finish (default: all). A journal
// in the staging directory records progress; rerun with --stage <dir> and
// --phase <name> to resume one. Nothing here weakens an approval: the candidate
// must already read verified and reviewed, or the script stops before touching
// the service.
import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, openSync, closeSync, fsyncSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadCodingDeploymentRuntime, observeCodingDeployment, backupCodingDeployment, verifyCodingDeploymentBackup, assertCodingDeploymentStopped } from "./deploy-coding.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const has = name => args.includes(`--${name}`);
const runId = Number(flag("run"));
const phaseWanted = flag("phase", "all");
const stateDir = flag("state", join(homedir(), ".config", "standing-orders"));
const database = flag("db", join(stateDir, "orders.db"));
const label = flag("label", "com.standing-orders.browser");
const plist = flag("plist", join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
const source = resolve(flag("source", dirname(dirname(fileURLToPath(import.meta.url)))));
const uid = userInfo().uid;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = s => '"' + s.replaceAll('"', '""') + '"';
const say = (...parts) => console.log(parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" "));
function requireTrue(value, message) { if (!value) { console.error(`✗ ${message}`); process.exit(1); } }
if (!Number.isInteger(runId) || runId < 1) requireTrue(false, "Name the verified builder run: --run <id>.");

// ---- installed runtime (old) and candidate runtime (new) ---------------------
const livePlist = readFileSync(plist, "utf8");
const priorDist = (livePlist.match(/<string>([^<]*\/dist)\/cli\.js<\/string>/) ?? [])[1];
requireTrue(priorDist && existsSync(priorDist), `The live service definition at ${plist} names no installed runtime.`);
const publicUrl = (livePlist.match(/<string>--public-url<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1] ?? null;
const load = async (root, name) => import(pathToFileURL(join(root, name)).href);
const oldRt = { store: await load(priorDist, "store.js"), gate: await load(priorDist, "desktop-update-gate.js"), evidence: await load(priorDist, "verification-evidence.js"), update: await load(priorDist, "desktop-update.js") };
oldRt.coding = await loadCodingDeploymentRuntime(priorDist);
const candidateHead = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const short = candidateHead.slice(0, 7);
const stageDir = flag("stage") ?? join(stateDir, "staged-upgrades", `browser-${short}-${randomUUID().slice(0, 6)}`);
const journalFile = join(stageDir, "deployment.json");
const nextDist = join(stageDir, "runtime", "node_modules", "standing-orders", "dist");
const evidenceRoot = join(dirname(database), "evidence");
const readJournal = () => JSON.parse(readFileSync(journalFile, "utf8"));
const save = (r, phase) => { r.phase = phase; r.updatedAt = new Date().toISOString(); oldRt.update.durableJson(journalFile, r); say(`• ${phase}`); };
const loadPhase = phase => {
  // The plane's records are re-read before every phase, not only at entry:
  // a revoked approval or a changed command between phases stops the swap.
  { const db = new DatabaseSync(database, { readOnly: true }); try { facts(db); } finally { db.close(); } }
  const r = readJournal();
  requireTrue(r.phase === phase && r.candidate === candidateHead && r.database === database, `Journal is at ${r.phase} for ${r.candidate?.slice(0, 7)}, expected ${phase} for ${short}.`);
  requireTrue(r.builder === runId && r.nextRuntime === nextDist, "The journal belongs to a different run or staging directory.");
  const packed = readdirSync(stageDir).find(f => f.endsWith(".tgz"));
  requireTrue(packed && sha(readFileSync(join(stageDir, packed))) === r.packageSha256, "The staged package changed since it was proved.");
  proveStaged();
  return r;
};

// ---- the plane's own records for this candidate -----------------------------
function facts(db) {
  const store = new oldRt.store.Store(db);
  const run = store.getRun(runId);
  requireTrue(run && run.outcome === "built" && run.headRevision === candidateHead, `Run ${runId} is not a built attempt at ${short}.`);
  const ref = store.refById(run.taskRef);
  const taskId = ref.externalId;
  const scope = store.getScope(taskId);
  requireTrue(scope && scope.approvedDigest === scope.digest && scope.digest === run.scopeDigest, "The run's signed scope is no longer the approved one.");
  const proof = store.proofVerdictFor(runId);
  const criteria = scope.acceptance.length;
  requireTrue(proof && (proof.machineVerdict ?? proof.verdict) === "verified", `Run ${runId} does not read verified (${proof?.verdict ?? "no verdict"}).`);
  const reviewId = store.reviewRetryStateOf(runId)?.succeeded?.runId ?? null;
  const review = reviewId ? store.getRun(reviewId) : null;
  requireTrue(review && review.parentRun === runId && review.outcome === "no-change", "No settled independent review for this run.");
  const judged = store.criterionReviewsFor(runId);
  requireTrue(judged.length === criteria && new Set(judged.map(c => c.criterionId)).size === criteria && judged.every(c => c.judgement === "upholds" && c.headSha === candidateHead && c.scopeDigest === scope.digest), "The review did not uphold every signed criterion on this exact candidate.");
  const evidence = oldRt.evidence.verificationEvidence(store, evidenceRoot, runId);
  requireTrue(evidence.ok && evidence.bytes, `Native gate evidence unavailable: ${evidence.problem ?? "no receipt"}.`);
  const gate = JSON.parse(evidence.bytes);
  const live = store.liveVerifyCommand(ref.repo);
  requireTrue(gate.head === candidateHead && gate.result.exitCode === 0 && live && gate.command.command === live.command, "The native gate did not pass this candidate under the currently approved command.");
  requireTrue(resolve(run.worktree) === source || execFileSync("git", ["-C", run.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === candidateHead, "Run this from the builder's worktree for this run.");
  return { taskId, repo: ref.repo, scopeDigest: scope.digest, reviewer: reviewId, proofVerdict: proof.verdict, acceptance: store.proofAcceptance(runId), criteria, worktree: run.worktree, gate };
}
function quiet(db) {
  const work = oldRt.gate.activeUpdateWork(db);
  requireTrue(Object.values(work).every(n => n === 0), `Current work must finish first: ${JSON.stringify(work)}.`);
  const store = new oldRt.store.Store(db);
  for (const row of db.prepare("SELECT DISTINCT run FROM run_process WHERE exited_at IS NULL").all()) {
    const problem = store.stopQuiescenceProblem(row.run);
    requireTrue(!problem, problem);
  }
}
function service(dist) {
  const launch = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  const pid = Number(launch.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
  if (!(pid > 1) || !launch.stdout.includes("state = running")) return null;
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (!command.includes(`${dist}/controller-service.js`)) return null;
  const children = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  const commands = children.map(p => spawnSync("/bin/ps", ["-p", String(p), "-o", "command="], { encoding: "utf8" }).stdout);
  return commands.some(c => c.includes(`${dist}/cli.js up --db ${database}`)) ? { supervisor: pid, children, command, commands } : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function verifyServiceStopped(pids) {
  for (let i = 0; i < 60; i++) { if (pids.every(pid => spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status === 1)) break; await sleep(1000); }
  for (const pid of pids) requireTrue(spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).status === 1, `Service process has not exited: ${pid}`);
  requireTrue(spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status !== 0, "The service is still loaded.");
}
function digest(db, name, columns) {
  const rows = db.prepare("SELECT " + columns.map(quote).join(",") + " FROM " + quote(name)).all().map(r => JSON.stringify(r)).sort();
  return { count: rows.length, hash: sha(rows.join("\n")) };
}
function snapshot(db, includeVersion = false) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all()
    .filter(t => includeVersion || t.name !== "schema_version")
    .map(({ name }) => { const columns = db.prepare("PRAGMA table_info(" + quote(name) + ")").all().map(r => r.name); return { name, columns, ...digest(db, name, columns) }; });
}
function assertPreserved(db, before) {
  for (const table of before) { const after = digest(db, table.name, table.columns); requireTrue(after.count === table.count && after.hash === table.hash, `Historical rows changed: ${table.name}`); }
  requireTrue(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok" && db.prepare("PRAGMA foreign_key_check").all().length === 0, "Database integrity or foreign-key failure.");
}
const schemaDigest = db => sha(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()));
const list = (root, prefix = "") => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(root, join(prefix, e.name)) : [join(prefix, e.name)]).sort();

// ---- phases ------------------------------------------------------------------
function stage() {
  requireTrue(!execFileSync("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "The candidate checkout has tracked changes.");
  requireTrue(existsSync(join(source, "dist")), "The candidate has no dist; the native gate builds it.");
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  // The runtime is the packed package plus every production dependency of a
  // clean, lockfile-verified install of the candidate commit — nothing from
  // the worktree's mutable node_modules.
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", stageDir], { cwd: source, encoding: "utf8" }).trim().split("\n").pop();
  const runtime = join(stageDir, "runtime");
  const self = join(runtime, "node_modules", "standing-orders");
  mkdirSync(self, { recursive: true });
  execFileSync("tar", ["-xzf", join(stageDir, packed), "--strip-components=1", "-C", self]);
  // npm pack normalises package.json; the runtime carries the checkout's exact bytes.
  copyFileSync(join(source, "package.json"), join(self, "package.json"));
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "standing-orders-installed", private: true, candidate: candidateHead, dependencies: { "standing-orders": `file:../${packed}` } }, null, 2));
  const built = cleanBuildOf(candidateHead);
  for (const dep of built.dependencies) cpSync(join(built.scratch, dep), join(runtime, dep), { recursive: true, dereference: true, errorOnExist: false });
  const proof = proveStaged();
  return { packed, packageSha256: sha(readFileSync(join(stageDir, packed))), distFiles: proof.distFiles };
}

/** Relative paths of every production dependency the checkout resolved. */
const productionDependencies = root => execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  .filter(p => p.startsWith(join(root, "node_modules") + "/")).map(p => p.slice(root.length + 1)).sort();

/** The staged runtime is the verified candidate COMMIT, byte for byte — not
 * the worktree, which is mutable after the gate. dist is rebuilt from a clean
 * archive of the commit (tsc output is deterministic) and compared; every
 * other packed file is compared to the commit's blob; every production
 * dependency is checked against the commit's lockfile. Proved when staged and
 * again before every later phase, once per process. */
let cleanBuild = null;
process.on("exit", () => { if (cleanBuild?.scratch) rmSync(cleanBuild.scratch, { recursive: true, force: true }); });
/** A clean checkout of the commit, its dependencies installed from the
 * committed lockfile (npm verifies every package against the lockfile's
 * integrity hash), and dist built there. Nothing from the worktree's
 * mutable node_modules is used; the compiler itself comes from the lockfile. */
function cleanBuildOf(commit) {
  if (cleanBuild?.commit === commit) return cleanBuild;
  const scratch = mkdtempSync(join(tmpdir(), "so-deploy-"));
  execFileSync("sh", ["-c", `git -C "${source}" archive --format=tar ${commit} | tar -x -C "${scratch}"`]);
  const env = { ...process.env, NODE_OPTIONS: "" };
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  execFileSync("npm", ["run", "build", "--silent"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"], env });
  const files = list(join(scratch, "dist"));
  const bytes = new Map(files.map(f => [f, readFileSync(join(scratch, "dist", f))]));
  const dependencies = productionDependencies(scratch);
  cleanBuild = { commit, scratch, files, bytes, dependencies };
  return cleanBuild;
}
/** Package roots under a node_modules directory: scoped or not, and the
 * nested node_modules a package carries — never the package.json files
 * inside a package's own subdirectories. */
function stagedPackages(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) { out.push(...stagedPackages(join(dir, entry.name), `${prefix}/${entry.name}`)); continue; }
    const root = join(dir, entry.name);
    if (!existsSync(join(root, "package.json"))) continue;
    out.push(`${prefix}/${entry.name}`);
    if (existsSync(join(root, "node_modules"))) out.push(...stagedPackages(join(root, "node_modules"), `${prefix}/${entry.name}/node_modules`));
  }
  return out;
}
/** The staged runtime is the verified candidate COMMIT, byte for byte: dist
 * equals a clean build of the commit, every other packed file equals the
 * commit's blob, and every production dependency equals the clean install
 * from the commit's lockfile. Proved when staged and again before every
 * later phase (once per process). */
function proveStaged() {
  requireTrue(existsSync(nextDist), `No staged runtime at ${nextDist}.`);
  const runtime = join(stageDir, "runtime"), self = join(runtime, "node_modules", "standing-orders");
  requireTrue(JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).candidate === candidateHead, "The staged runtime was built for a different candidate.");
  const built = cleanBuildOf(candidateHead);
  requireTrue(JSON.stringify(built.files) === JSON.stringify(list(nextDist)), "Staged dist inventory differs from a clean build of the candidate commit.");
  for (const f of built.files) requireTrue(built.bytes.get(f).equals(readFileSync(join(nextDist, f))), `Staged file differs from a clean build of the candidate commit: ${f}`);
  for (const f of list(self).filter(f => !f.startsWith("dist/"))) {
    const blob = spawnSync("git", ["-C", source, "show", `${candidateHead}:${f}`], { maxBuffer: 64 * 1024 * 1024 });
    requireTrue(blob.status === 0 && blob.stdout.equals(readFileSync(join(self, f))), `Packed file differs from the candidate commit: ${f}`);
  }
  const staged = stagedPackages(join(runtime, "node_modules"), "node_modules").filter(dep => dep !== "node_modules/standing-orders").sort();
  requireTrue(JSON.stringify(staged) === JSON.stringify(built.dependencies), `Staged dependency inventory differs from the lockfile install: ${JSON.stringify({ staged: staged.length, lockfile: built.dependencies.length })}`);
  for (const dep of staged) {
    const clean = join(built.scratch, dep), installed = join(runtime, dep), depFiles = list(clean);
    requireTrue(JSON.stringify(depFiles) === JSON.stringify(list(installed)), `Dependency file inventory differs from the lockfile install: ${dep}`);
    for (const f of depFiles) requireTrue(readFileSync(join(clean, f)).equals(readFileSync(join(installed, f))), `Dependency bytes differ from the lockfile install: ${dep}/${f}`);
  }
  return { distFiles: built.files.length, dependencies: staged.length };
}

// Persist newly observed custody before the async SQLite snapshot. Every final
// boundary verifies the retained bytes again after any intervening await.
function verifyCodingBackup(runtime, r) {
  try { verifyCodingDeploymentBackup(runtime, database, stageDir, r); }
  finally { save(r, r.phase); }
}
async function ensureCodingBackup(runtime, r) {
  try { observeCodingDeployment(runtime, database, r); }
  finally { save(r, r.phase); }
  try { await backupCodingDeployment(runtime, database, stageDir, r); }
  finally { save(r, r.phase); }
  verifyCodingBackup(runtime, r);
}

async function prepare(staged) {
  requireTrue(!existsSync(journalFile), "This staging directory already has a deployment; resume it with --phase.");
  requireTrue(lstatSync(database).isFile() && !lstatSync(database).isSymbolicLink(), "Unexpected database path.");
  staged = { ...staged, distFiles: proveStaged().distFiles };
  const db = new DatabaseSync(database); db.exec("PRAGMA busy_timeout=1000");
  try {
    const schema = db.prepare("SELECT version FROM schema_version").get().version;
    const nextSchema = (await load(nextDist, "store.js")).SCHEMA_VERSION;
    const f = facts(db);
    writeFileSync(join(stageDir, "release.json"), JSON.stringify({ ...f, run: runId, head: candidateHead, at: new Date().toISOString(), ...staged }, null, 1));
    const r = { id: randomUUID(), candidate: candidateHead, database, phase: "preparing", schema, nextSchema, createdAt: new Date().toISOString(), backup: join(stageDir, "orders.backup.db"), priorRuntime: priorDist, nextRuntime: nextDist, builder: runId, reviewer: f.reviewer, task: f.taskId, repo: f.repo, scopeDigest: f.scopeDigest, ...staged, proofVerdict: f.proofVerdict, manualAcceptance: f.acceptance, publicUrl };
    observeCodingDeployment(oldRt.coding, database, r);
    quiet(db);
    r.oldService = service(priorDist);
    requireTrue(r.oldService, "The installed service is not running from the runtime its definition names.");
    save(r, "preparing");
    for (const [input, output] of [[plist, "browser.saved.plist"], [join(stateDir, "repos.json"), "repos.saved.json"], [join(stateDir, "up-login.txt"), "up-login.saved.txt"], [join(stateDir, "console-url"), "console-url.saved.txt"]]) {
      if (!existsSync(input)) continue;
      requireTrue(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink(), `Unexpected configuration path: ${input}`);
      copyFileSync(input, join(stageDir, output)); chmodSync(join(stageDir, output), 0o600);
    }
    oldRt.gate.installUpdateGate(db, r.id); save(r, "admission-paused");
    requireTrue(oldRt.gate.freezeUpdateGate(db, r.id), "Work raced admission; let it finish and rerun.");
    quiet(db); observeCodingDeployment(oldRt.coding, database, r); save(r, "frozen");
    db.exec("BEGIN IMMEDIATE");
    const original = new DatabaseSync(database, { readOnly: true });
    let before;
    try { before = snapshot(original, true); await backup(original, r.backup); } finally { original.close(); }
    chmodSync(r.backup, 0o600);
    const copied = new DatabaseSync(r.backup, { readOnly: true });
    try { assertPreserved(copied, before); } finally { copied.close(); }
    await ensureCodingBackup(oldRt.coding, r);
    db.exec("COMMIT");
    const fd = openSync(r.backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    r.backupSha256 = sha(readFileSync(r.backup)); r.snapshotSha256 = sha(JSON.stringify(before));
    save(r, "backup-verified");
  } finally { db.close(); }
}

async function rehearse() {
  const r = loadPhase("backup-verified"), target = join(stageDir, "rehearsal.db");
  requireTrue(!existsSync(target) && sha(readFileSync(r.backup)) === r.backupSha256, "Rehearsal exists or the backup changed.");
  await ensureCodingBackup(oldRt.coding, r);
  copyFileSync(r.backup, target); chmodSync(target, 0o600);
  const next = await load(nextDist, "store.js");
  let db = new DatabaseSync(target, { readOnly: true });
  const before = snapshot(db); db.close();
  next.openStore(target).close(); next.openStore(target).close();
  db = new DatabaseSync(target, { readOnly: true });
  let upgraded, upgradedSchema;
  try {
    requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Rehearsal schema or gate mismatch.");
    assertPreserved(db, before); upgraded = snapshot(db, true); upgradedSchema = schemaDigest(db);
  } finally { db.close(); }
  if (r.schema === r.nextSchema) {
    oldRt.store.openStore(target).close();
    db = new DatabaseSync(target, { readOnly: true });
    try { assertPreserved(db, upgraded); requireTrue(schemaDigest(db) === upgradedSchema && oldRt.gate.updateGateOwned(db, r.id), "The previous runtime changed the compatible copy."); } finally { db.close(); }
  }
  r.rehearsal = { from: r.schema, to: r.nextSchema, preservedTables: before.length, preservedRows: before.reduce((n, t) => n + t.count, 0), integrity: "ok", previousRuntimeCompatible: r.schema === r.nextSchema };
  save(r, "rehearsed");
}

async function swap() {
  const r = loadPhase("rehearsed");
  requireTrue(sha(readFileSync(r.backup)) === r.backupSha256 && r.rehearsal.integrity === "ok", "The verified backup or rehearsal changed.");
  await ensureCodingBackup(oldRt.coding, r);
  // Stop the installed service and prove every old process is gone.
  r.stoppingService = service(priorDist);
  requireTrue(r.stoppingService, "The current service identity could not be verified before shutdown. No runtime was replaced.");
  save(r, "stopping");
  spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
  const oldPids = [...new Set([r.oldService.supervisor, ...r.oldService.children, r.stoppingService.supervisor, ...r.stoppingService.children])];
  await verifyServiceStopped(oldPids);
  await ensureCodingBackup(oldRt.coding, r);
  save(r, "stopped");
  // Migrate the live database with the new runtime (a no-op for a same-schema build).
  let db = new DatabaseSync(database); db.exec("PRAGMA busy_timeout=1000");
  let before;
  try { requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.schema && oldRt.gate.updateGateOwned(db, r.id), "Expected the owned gate on the live database."); quiet(db); assertCodingDeploymentStopped(oldRt.coding, database, db, r); before = snapshot(db); } finally { db.close(); }
  save(r, "migrating");
  (await load(nextDist, "store.js")).openStore(database).close();
  db = new DatabaseSync(database, { readOnly: true });
  try { requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Migration or gate mismatch."); assertPreserved(db, before); } finally { db.close(); }
  r.migration = { from: r.schema, to: r.nextSchema, preservedTables: before.length, preservedRows: before.reduce((n, t) => n + t.count, 0) };
  save(r, "migrated");
  // Install the new service definition: same arguments, new runtime and log home.
  const nextPlist = livePlist.replaceAll(priorDist, nextDist).replace(/<key>WorkingDirectory<\/key>\s*<string>[^<]*<\/string>/, `<key>WorkingDirectory</key>\n\t<string>${stageDir}</string>`)
    .replace(/(<key>Standard(?:Out|Error)Path<\/key>\s*<string>)[^<]*(<\/string>)/g, `$1${join(stageDir, "service.log")}$2`);
  requireTrue(nextPlist.includes(`${nextDist}/cli.js`) && !nextPlist.includes(priorDist), "The new service definition does not name the new runtime.");
  writeFileSync(join(stageDir, "browser.next.plist"), nextPlist, { mode: 0o600 });
  writeFileSync(join(stageDir, "service.log"), "", { mode: 0o600, flag: "a" });
  // Migration loads asynchronously; backup, service and native custody must still hold.
  await ensureCodingBackup(oldRt.coding, r);
  await verifyServiceStopped(oldPids);
  verifyCodingBackup(oldRt.coding, r);
  const beforeReplace = new DatabaseSync(database, { readOnly: true });
  try { assertCodingDeploymentStopped(oldRt.coding, database, beforeReplace, r); } finally { beforeReplace.close(); }
  writeFileSync(plist, nextPlist);
  const booted = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
  requireTrue(booted.status === 0, `launchctl bootstrap failed: ${booted.stderr}`);
  save(r, "starting");
  let live = null;
  for (let i = 0; i < 90 && live === null; i++) { await sleep(1000); live = service(nextDist); }
  if (live === null) {
    // A failed health check does not establish process exit. Capture the
    // service's remaining processes before stopping it, and check native
    // custody with the new runtime before restoring the previous definition.
    const launch = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
    const failedPid = Number(launch.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
    requireTrue(launch.status !== 0 || failedPid > 1, "The failed service's process identity is unknown. The previous runtime was not restored.");
    const failedChildren = failedPid > 1 ? spawnSync("/usr/bin/pgrep", ["-P", String(failedPid)], { encoding: "utf8" }) : null;
    requireTrue(!failedChildren || failedChildren.status === 0 || failedChildren.status === 1, "The failed service's child processes could not be checked. The previous runtime was not restored.");
    const failedPids = failedPid > 1 ? [failedPid, ...failedChildren.stdout.trim().split(/\s+/).filter(Boolean).map(Number)] : [];
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
    await verifyServiceStopped(failedPids);
    const coding = await loadCodingDeploymentRuntime(nextDist);
    await ensureCodingBackup(coding, r);
    await verifyServiceStopped(failedPids);
    verifyCodingBackup(coding, r);
    const stopped = new DatabaseSync(database, { readOnly: true });
    try { assertCodingDeploymentStopped(coding, database, stopped, r); } finally { stopped.close(); }
    writeFileSync(plist, livePlist);
    spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    save(r, "restored");
    requireTrue(false, "The new service did not come up; the previous definition was restored. The update gate is still installed — inspect and rerun --phase finish or remove it.");
  }
  r.newService = live;
  save(r, "started");
  await ensureCodingBackup(await loadCodingDeploymentRuntime(nextDist), r);
}

async function finish() {
  const phase = readJournal().phase;
  requireTrue(["started", "healthy"].includes(phase), `Unexpected finish phase: ${phase}.`);
  const r = loadPhase(phase);
  const coding = await loadCodingDeploymentRuntime(nextDist);
  await ensureCodingBackup(coding, r);
  const live = service(nextDist);
  requireTrue(live, "The new service is not running from the new runtime.");
  requireTrue(live.commands.some(c => c.includes("--host 127.0.0.1 --port 4180")) || !livePlist.includes("--host 127.0.0.1"), "The backend must remain on its configured loopback address.");
  const local = await fetch(`http://127.0.0.1:4180/t/${encodeURIComponent(r.task)}`, { redirect: "manual" }).catch(() => null);
  requireTrue(local && (local.ok || local.status === 303 || local.status === 302), "The local console does not answer.");
  let remote = "not configured";
  if (r.publicUrl) {
    const response = await fetch(`${r.publicUrl}/t/${encodeURIComponent(r.task)}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    requireTrue(response && (response.ok || response.status === 303 || response.status === 302), "The configured HTTPS console is unavailable.");
    remote = `${r.publicUrl} answered ${response.status}`;
  }
  const repos = JSON.parse(readFileSync(join(stateDir, "repos.json"), "utf8")).repos ?? [];
  const runner = (livePlist.match(/<string>--runner<\/string>\s*<string>([^<]+)<\/string>/) ?? [])[1];
  const db = new DatabaseSync(database); db.exec("PRAGMA busy_timeout=10000");
  try {
    requireTrue(db.prepare("SELECT version FROM schema_version").get().version === r.nextSchema && oldRt.gate.updateGateOwned(db, r.id), "Unexpected live schema or update owner.");
    let leases = [];
    for (let i = 0; i < 90; i++) {
      leases = repos.map(repo => db.prepare("SELECT repo,heartbeat_at,expires_at FROM watch_lease WHERE runner=? AND repo=?").get(runner, repo));
      if (leases.every(l => l && Date.parse(l.expires_at) > Date.now() && Date.parse(l.heartbeat_at) > Date.now() - 60_000)) break;
      await sleep(1000);
    }
    requireTrue(leases.every(l => l && Date.parse(l.expires_at) > Date.now()), "Project worker leases did not come up fresh.");
    assertPreserved(db, []);
    r.leases = leases; r.remote = remote;
    r.uiCheck = `Machine checks only: local console answered, ${remote}, ${leases.length} project lease(s) fresh. Open the console and inspect a result page yourself.`;
    await ensureCodingBackup(coding, r);
    verifyCodingBackup(coding, r);
    save(r, "healthy"); oldRt.gate.removeUpdateGate(db, r.id); r.deployedAt = new Date().toISOString(); save(r, "deployed");
  } finally { db.close(); }
  say({ deployed: candidateHead, runtime: nextDist, at: r.deployedAt, projects: r.leases.length, remote });
}

// Every entry point — the whole run or one resumed phase — proves the
// candidate against the plane's records first. Nothing is staged, and no
// service is touched, for a run that does not read verified and reviewed.
const phases = { stage, prepare, rehearse, swap, finish };
requireTrue(phaseWanted === "all" || phases[phaseWanted], "Use --phase stage|prepare|rehearse|swap|finish, or omit it for all.");
const proven = (() => { const db = new DatabaseSync(database, { readOnly: true }); try { return facts(db); } finally { db.close(); } })();
say(`Candidate ${short} — task ${proven.taskId}, run ${runId}, review ${proven.reviewer}, proof ${proven.proofVerdict}, ${proven.criteria} criteria upheld.`);
say(`Installed runtime: ${priorDist}`);
say(`Staging directory: ${stageDir}`);
if (phaseWanted === "all") {
  if (!has("yes")) { say("Add --yes to drain the plane, back up the database, and swap the service."); process.exit(0); }
  const staged = stage(); await prepare(staged); await rehearse(); await swap(); await finish();
} else {
  if (phaseWanted !== "stage") requireTrue(flag("stage"), `--phase ${phaseWanted} resumes a staging directory: pass --stage <dir>.`);
  if (phaseWanted === "stage") say(stage());
  else if (phaseWanted === "prepare") await prepare({ packageSha256: sha(readFileSync(join(stageDir, readdirSync(stageDir).find(f => f.endsWith(".tgz"))))) });
  else await phases[phaseWanted]();
}
