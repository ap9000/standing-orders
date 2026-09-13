#!/usr/bin/env node
/** Real, disposable macOS update. Never opens UI or touches the installed app. */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0 || !args[at + 1] || args[at + 1].startsWith("--")) throw Error(`${name} requires a value`); return resolve(args[at + 1]); };
if (process.platform !== "darwin") throw Error("This check exercises the macOS updater.");
const previous = option("--previous"), candidate = option("--candidate"), output = option("--output");
const guardianFault = args.includes("--interrupt-guardian"), swapFault = args.includes("--interrupt-after-swap"), cancelFault = args.includes("--cancel-draining"), stopFault = args.includes("--stop-after-swap");
const interrupt = args.includes("--interrupt-worker") || guardianFault || swapFault, rejectHealth = args.includes("--reject-health");
assert.ok([args.includes("--interrupt-worker"), guardianFault, swapFault, cancelFault, stopFault, rejectHealth].filter(Boolean).length <= 1, "Choose one fault per disposable installation");
const drainingFault = (interrupt && !swapFault) || cancelFault;
const { readDesktopBundle, bundleHash } = await import(pathToFileURL(join(source, "dist/desktop-bundle.js")));
const { loadOrCreateDesktopConfig, writeDesktopConfig, readDesktopConfig, openConfiguredDesktopStore, pairDesktopLogin, addDesktopProjects } = await import(pathToFileURL(join(source, "dist/desktop-host.js")));
const { updateAdmissionPaused } = await import(pathToFileURL(join(source, "dist/desktop-update-gate.js")));
const { authenticateApprover } = await import(pathToFileURL(join(source, "dist/scope.js")));
const old = readDesktopBundle(previous), next = readDesktopBundle(candidate);
assert.equal(old.development, true); assert.equal(next.development, true);
assert.notEqual(old.buildId, next.buildId);
const root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-update-cert-")));
const installed = join(root, "Installed.app"), state = join(root, "state"), repo = join(root, "repo");
cpSync(previous, installed, { recursive: true, errorOnExist: true, force: false });
mkdirSync(state, { mode: 0o700 }); mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "README.md"), "Disposable update fixture.\n");
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
const initial = loadOrCreateDesktopConfig(state, true);
initial.containment = "observed";
const port = createServer(); await new Promise(done => port.listen(0, "127.0.0.1", done)); initial.port = port.address().port; await new Promise(done => port.close(done));
writeDesktopConfig(state, initial);
const login = { name: "update-fixture", password: randomBytes(24).toString("hex") };
const store = openConfiguredDesktopStore(state);
pairDesktopLogin(store, join(state, "up-login.txt"), login); await addDesktopProjects(state, store, [repo]);
const now = new Date().toISOString();
store.raw().prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('retained','Retained unsigned work','queued',?,?)").run(now, now);
store.close();
const config = readDesktopConfig(state);
const loginHash = createHash("sha256").update(readFileSync(join(state, "up-login.txt"))).digest("hex");
const label = `com.standing-orders.update-cert.${randomBytes(8).toString("hex")}`;
const target = `gui/${process.getuid()}/${label}`, plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
assert.equal(existsSync(plist), false);
const resource = app => join(app, "Contents/Resources");
const command = (app, verb, extra = []) => JSON.parse(execFileSync(join(resource(app), "runtime/node"), [join(resource(app), "dist/desktop-host.js"), verb, "--state", state, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 150000, maxBuffer: 1024 * 1024 }));
const serviceArgs = app => { const b = readDesktopBundle(app); return ["--node", join(resource(app), "runtime/node"), "--helper", join(resource(app), "dist/desktop-host.js"), "--label", label, "--bundle-id", b.bundleId, "--provider-bin", b.providerBin, "--build-id", b.buildId]; };
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check, duration = 30000) {
  const end = Date.now() + duration; let last;
  while (Date.now() < end) { try { const result = await check(); if (result) return result; } catch (error) { last = error; } await sleep(400); }
  throw Error(`Fixture deadline exceeded${last ? `: ${last.message}` : ""}`);
}
const report = { version: 1, root, state, label, oldBuildId: old.buildId, nextBuildId: next.buildId, oldHash: old.hash, nextHash: next.hash, startedAt: now, scriptHash: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), manualRescues: 0, cases: [], limits: ["Disposable ad-hoc-signed development apps, not a production installation.", "No provider work, Keychain changes, privacy approval, logout or physical reboot.", "Actual launchd lifecycle, detached updater, native atomic swap and fresh worker health are exercised."] };
let started = false;
try {
  command(installed, "service-start", serviceArgs(installed)); started = true;
  await waitFor(() => command(installed, "access-status").ready);
  const at = Date.now();
  const extra = ["--installed", installed, "--candidate", candidate, "--label", label];
  const preview = command(candidate, "update-preview", extra);
  let expectedTitle = "Retained unsigned work";
  if (rejectHealth) {
    const { prepareDesktopUpdate, runDesktopUpdate } = await import(pathToFileURL(join(source, "dist/desktop-update.js")));
    const journal = await prepareDesktopUpdate(state, installed, candidate, label, preview.digest);
    await runDesktopUpdate(state, { healthTimeoutMs: 5000, healthy: async app => {
      if (app.buildId === journal.next.buildId) {
        // Fault injection at the health boundary only. Actual service stop,
        // startup, signatures, backup, atomic swap and restoration are real.
        const db = new DatabaseSync(config.databaseFile);
        expectedTitle = "Newer work survives app recovery";
        db.prepare("UPDATE task SET title=? WHERE id='retained'").run(expectedTitle); db.close();
        return false;
      }
      const supervisor = JSON.parse(readFileSync(join(state, "controller-supervisor.json"), "utf8"));
      return supervisor.buildId === old.buildId && command(installed, "access-status").ready;
    } });
    report.limits.push("Candidate health was deliberately rejected at an internal test seam; no operator recovery was used.");
  } else {
    if (drainingFault) {
      const db = new DatabaseSync(config.databaseFile);
      db.exec("INSERT INTO task_ref(backend,external_id) VALUES('builtin','retained')");
      const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='retained'").get().id;
      db.prepare("INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at) VALUES('fixture-drain',?,1,'update-fixture',?,?,?)").run(ref, now, new Date(Date.now() + 180000).toISOString(), now); db.close();
    }
    command(candidate, "update-start", [...extra, "--digest", preview.digest]);
    if (interrupt || cancelFault || stopFault) {
      const wantedPhase = swapFault || stopFault ? "verifying" : "draining";
      const until = Date.now() + 30000;
      while (JSON.parse(readFileSync(join(state, "desktop-update.json"), "utf8")).phase !== wantedPhase) { assert.ok(Date.now() < until, "Did not reach the fault boundary"); await sleep(20); }
      const receipt = JSON.parse(readFileSync(join(state, "desktop-update.json"), "utf8"));
      const staged = join(receipt.workDir, "Updater.app");
      const recoveryFile = join(receipt.workDir, "recovery.json");
      const recovery = JSON.parse(readFileSync(recoveryFile, "utf8"));
      const verb = guardianFault ? "update-supervise" : "update-run";
      const exact = `${join(resource(staged), "runtime/node")} ${join(resource(staged), "dist/desktop-host.js")} ${verb} --state ${state} --update-id ${receipt.id}`;
      const matching = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(match => match?.[2] === exact);
      if (interrupt) {
        assert.equal(matching.length, 1, "Only the exact disposable updater may be interrupted");
        assert.equal(Number(matching[0][1]), guardianFault ? recovery.guardianPid : recovery.workerPid);
        if (!guardianFault) assert.equal(Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", matching[0][1]], { encoding: "utf8" }).trim()), recovery.guardianPid);
        process.kill(Number(matching[0][1]), "SIGKILL");
      } else if (cancelFault) command(candidate, "update-cancel");
      else if (stopFault) command(candidate, "service-stop", serviceArgs(installed));
      const db = new DatabaseSync(config.databaseFile);
      if (interrupt) assert.equal(updateAdmissionPaused(db), true);
      // The fixture's pre-existing work finishes; the updater never kills it.
      if (drainingFault) db.prepare("UPDATE claim SET released_at=? WHERE lease_id='fixture-drain'").run(new Date().toISOString()); db.close();
      report.cases.push({ name: guardianFault ? "guardian-sigkill" : swapFault ? "updater-sigkill-after-swap" : cancelFault ? "cancel-during-drain" : stopFault ? "explicit-stop-after-swap" : "updater-sigkill-during-drain", noWindow: true, explicitResume: false, ...(interrupt ? { admissionPauseSurvived: true, faultPid: Number(matching[0][1]) } : {}) });
      report.limits.push("No Resume, app reopening, or extra kickstart follows fault injection. Physical logout/reboot is a separate acceptance check.");
    }
  }
  let seen;
  const done = await waitFor(() => {
    const status = command(candidate, "update-status");
    if (status.phase !== seen) { seen = status.phase; console.log(JSON.stringify({ phase: status.phase, detail: status.detail })); }
    if (status.active && status.canResume && Date.now() - at > 20000) return { phase: "needs-attention", detail: `Updater exited before completion: ${status.detail}` };
    return ["complete", "restored", "cancelled"].includes(status.phase) || (status.phase === "needs-attention" && !status.automaticRecovery) ? status : null;
  }, 180000);
  const oldExpected = rejectHealth || stopFault || cancelFault;
  assert.equal(done.phase, cancelFault ? "cancelled" : oldExpected ? "restored" : "complete", done.detail);
  const receipt = JSON.parse(readFileSync(join(state, "desktop-update.json"), "utf8"));
  assert.equal(bundleHash(installed), oldExpected ? old.hash : next.hash);
  assert.equal(bundleHash(join(receipt.workDir, "Standby.app")), oldExpected ? next.hash : old.hash);
  if (stopFault) assert.equal(command(candidate, "service-status", serviceArgs(installed)).state, "disabled");
  else assert.equal(command(installed, "access-status").ready, true);
  const supervisor = JSON.parse(readFileSync(join(state, "controller-supervisor.json"), "utf8"));
  if (!stopFault) assert.equal(supervisor.buildId, oldExpected ? old.buildId : next.buildId);
  const db = openConfiguredDesktopStore(state);
  try {
    assert.equal(db.raw().prepare("SELECT title FROM task WHERE id='retained'").get().title, expectedTitle);
    assert.equal(db.raw().prepare("SELECT count(*) n FROM run").get().n, 0);
    assert.equal(authenticateApprover(db, login.name, login.password).ok, true);
    assert.equal(updateAdmissionPaused(db.raw()), false);
  } finally { db.close(); }
  assert.equal(createHash("sha256").update(readFileSync(join(state, "up-login.txt"))).digest("hex"), loginHash);
  if (!cancelFault) {
    const backup = new DatabaseSync(receipt.backupPath, { readOnly: true });
    try { assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); assert.equal(backup.prepare("SELECT count(*) n FROM task WHERE id='retained'").get().n, 1); assert.equal(updateAdmissionPaused(backup), false); } finally { backup.close(); }
  }
  report.cases.push({ name: rejectHealth ? "failed-health-app-recovery" : "real-controlled-update", elapsedMs: Date.now() - at, phase: done.phase, backupVerified: !cancelFault, loginRetained: true, workerBuildVerified: !stopFault, projectAccessVerified: !stopFault, serviceKeptStopped: stopFault, admissionResumed: true, installedPathPreserved: true, ...(rejectHealth ? { newerTaskDataRetained: true } : {}) });
  report.receipt = join(state, "desktop-update.json");
  if (!rejectHealth) {
    const recoveryTarget = target + ".update", recoveryPlist = join(homedir(), "Library/LaunchAgents", `${label}.update.plist`);
    await waitFor(() => { try { execFileSync("/bin/launchctl", ["print", recoveryTarget], { stdio: "pipe" }); return false; } catch { return !existsSync(recoveryPlist); } }, 30000);
    report.automaticJobRemoved = true;
    report.recovery = JSON.parse(readFileSync(join(receipt.workDir, "recovery.json"), "utf8"));
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  try {
    if (!report.passed) {
      const status = command(candidate, "update-status");
      if (status.active) {
        command(candidate, "update-cancel");
        // Cleanup uses a foreground worker as well, so even a failed launch
        // cannot leave the disposable admission pause behind.
        command(candidate, "update-run");
        assert.equal(command(candidate, "update-status").active, false, "Fixture recovery still needs attention; preserve its files");
      }
    }
    if (started) command(installed, "service-stop", serviceArgs(installed));
    const stopped = command(installed, "service-status", serviceArgs(installed));
    assert.equal(["running", "loaded"].includes(stopped.state), false);
    if (existsSync(plist)) unlinkSync(plist);
    // Exceptional cleanup is scoped to this test's exact auxiliary job.
    try { execFileSync("/bin/launchctl", ["bootout", target + ".update"], { stdio: "pipe", timeout: 5000 }); } catch {}
    const recoveryPlist = join(homedir(), "Library/LaunchAgents", `${label}.update.plist`);
    if (existsSync(recoveryPlist)) unlinkSync(recoveryPlist);
    // Remove only this fixture's disabled override; there is no unit left to run.
    execFileSync("/bin/launchctl", ["enable", target], { stdio: "pipe", timeout: 5000 });
    report.fixtureServiceRemoved = true;
  } catch (error) { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; }
  assert.equal(bundleHash(previous), old.hash); assert.equal(bundleHash(candidate), next.hash);
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, output, root, error: report.error, cleanupError: report.cleanupError }));
}
