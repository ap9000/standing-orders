#!/usr/bin/env node
/**
 * The disposable macOS launchd certificate (docs/PROCESS_CONTAINMENT_PLAN.md,
 * acceptance 5). It INSTALLS A DISPOSABLE LaunchAgent under a throwaway
 * label in the current user's gui domain, so it runs only where an operator
 * decided to run it:
 *
 *   npm run certify:launchd -- [--observe-ms 60000] [--output <file>] [--keep]
 *
 * With the shared unit generator (daemon.ts, the same document the CLI
 * daemon and the desktop service use) it proves, against the real launchd:
 *   1. automatic relaunch after an UNEXPECTED CLEAN EXIT (exit 0) — with no
 *      manual kickstart: the certificate only watches;
 *   2. automatic relaunch after SIGKILL;
 *   3. explicit stop (bootout + disable) stays down beyond the throttle, and
 *      a start (enable + bootstrap) comes back with a FRESH incarnation and
 *      exactly one writer at a time — no duplicate;
 *   4. observation beyond ThrottleInterval (at least 60 s in total).
 * It then boots the disposable label out, re-enables it (leaving no
 * disabled record behind) and removes its plist. Nothing here touches an
 * installed Standing Orders service, a database, or another label.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") { console.error("the launchd certificate runs on macOS only; Linux/Windows service behaviour is covered by the generation tests and the restart certificate"); process.exit(2); }
let observeMs = 60_000;
let output = resolve("output/certification/launchd.json");
let keep = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--keep") keep = true;
  else if (arg === "--observe-ms") observeMs = Number(process.argv[++index]);
  else if (arg === "--output") output = resolve(process.argv[++index]);
  else if (arg === "--help") { console.log("npm run certify:launchd -- [--observe-ms 60000] [--output <file>] [--keep]"); process.exit(0); }
  else throw new Error(`unknown argument ${arg}`);
}
if (!Number.isFinite(observeMs) || observeMs < 60_000) throw new Error("--observe-ms must be at least 60000: the throttle is 15 s and the assertion must outlast it");

const { launchdPlist, installLaunchdService, stopLaunchdService, daemonStatus } = await import(pathToFileURL(resolve(root, "dist/daemon.js")));
const { run } = await import(pathToFileURL(resolve(root, "dist/exec.js")));

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const state = realpathSync(await mkdtemp(join(tmpdir(), "so-launchd-cert-")));
const label = `com.standing-orders.certificate.${state.split("-").pop()}`;
const uid = process.getuid();
const service = `gui/${uid}/${label}`;
const home = process.env["HOME"];
const definition = {
  platform: "darwin",
  label,
  unitPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
  unitContent: launchdPlist({ label, command: [process.execPath, resolve(root, "scripts/fixtures/restart-service.mjs")], workingDirectory: state, pathEnv: dirname(process.execPath), logPath: join(state, "service.log"), environment: { SO_CERT_STATE: state } }),
  logPath: join(state, "service.log"),
  bin: process.execPath,
  entry: resolve(root, "scripts/fixtures/restart-service.mjs"),
};
const supervise = (file, args) => run(file, args, { timeoutMs: 30_000 });
const heartbeat = () => { try { return JSON.parse(readFileSync(join(state, "heartbeat.json"), "utf8")); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
/** Writers that beat inside a window: exactly one pid at a time means no duplicate controller. */
const writersWithin = ms => { const now = Date.now(); return readdirSync(join(state, "writers")).filter(name => now - Number(readFileSync(join(state, "writers", name), "utf8")) < ms).map(name => Number(name.split("-")[0])); };

const started = Date.now();
const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, detail, at: new Date().toISOString() }); console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`); if (!ok) throw new Error(`${name}: ${detail}`); };
let installed = false;
try {
  mkdirSync(join(state, "writers"), { recursive: true });
  const first = await installLaunchdService(definition, supervise);
  installed = true;
  step("install", first.ok, first.ok ? `${first.action} ${label}` : first.message);
  const beat1 = await until(() => heartbeat(), 20_000, "the first heartbeat");
  step("first-incarnation", alive(beat1.pid), `pid ${beat1.pid} incarnation ${beat1.incarnation}`);

  // 1. Unexpected clean exit: the fixture exits 0 on request. NO kickstart
  //    from here — launchd alone must bring it back (KeepAlive=true, after
  //    ThrottleInterval).
  writeFileSync(join(state, "exit-now"), "");
  await until(() => !alive(beat1.pid), 10_000, "the clean exit");
  const beat2 = await until(() => { const b = heartbeat(); return b !== null && b.incarnation !== beat1.incarnation && alive(b.pid) ? b : null; }, 45_000, "the relaunch after exit 0");
  step("relaunch-after-clean-exit", beat2.pid !== beat1.pid, `launchd relaunched after exit 0 without a kickstart: pid ${beat1.pid} → ${beat2.pid}, incarnation ${beat2.incarnation}`);

  // 2. Crash: SIGKILL the running incarnation.
  process.kill(beat2.pid, "SIGKILL");
  await until(() => !alive(beat2.pid), 10_000, "the kill");
  const beat3 = await until(() => { const b = heartbeat(); return b !== null && b.incarnation !== beat2.incarnation && alive(b.pid) ? b : null; }, 45_000, "the relaunch after SIGKILL");
  step("relaunch-after-sigkill", beat3.pid !== beat2.pid, `launchd relaunched after SIGKILL: pid ${beat2.pid} → ${beat3.pid}`);

  // 3. Explicit stop stays down beyond the throttle; start brings a fresh
  //    incarnation with exactly one writer.
  const stopped = await stopLaunchdService(definition, supervise);
  step("explicit-stop", stopped.wasLoaded, "bootout + disable");
  await until(() => !alive(beat3.pid), 10_000, "the stop to end the process");
  await sleep(20_000);
  const afterStop = heartbeat();
  step("stays-down", afterStop !== null && afterStop.incarnation === beat3.incarnation && !alive(afterStop.pid), `no relaunch 20 s after an explicit stop (last incarnation ${afterStop?.incarnation})`);
  const status = await daemonStatus(definition, supervise);
  step("status-disabled", status.state === "disabled", `status reads ${status.state}: ${status.detail}`);
  const again = await installLaunchdService(definition, supervise);
  step("start-again", again.ok, again.ok ? `${again.action} (changed=${again.changed})` : again.message);
  const beat4 = await until(() => { const b = heartbeat(); return b !== null && b.incarnation !== beat3.incarnation && alive(b.pid) ? b : null; }, 30_000, "the fresh incarnation after start");
  await sleep(1_500);
  const writers = [...new Set(writersWithin(1_000))];
  step("one-writer", writers.length === 1 && writers[0] === beat4.pid, `writers beating in the last second: ${writers.join(", ") || "none"} (fresh incarnation ${beat4.incarnation})`);
  const idempotent = await installLaunchdService(definition, supervise);
  await sleep(1_500);
  step("idempotent-start", idempotent.ok && idempotent.action === "started" && heartbeat().incarnation === beat4.incarnation, `a second start on a running unchanged definition left pid ${beat4.pid} alone (${idempotent.ok ? idempotent.action : idempotent.message})`);

  // 4. Observe beyond the throttle.
  const remaining = observeMs - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  const final = heartbeat();
  step("observed-beyond-throttle", final !== null && alive(final.pid) && Date.now() - started >= observeMs, `observed ${Math.round((Date.now() - started) / 1000)} s (throttle 15 s); live pid ${final?.pid}`);
} catch (error) {
  steps.push({ name: "error", ok: false, detail: String(error), at: new Date().toISOString() });
  console.error(String(error));
} finally {
  if (installed && !keep) {
    await stopLaunchdService(definition, supervise);
    // Leave no disabled record for a label that no longer exists.
    await supervise("launchctl", ["enable", service]);
    try { rmSync(definition.unitPath); } catch { /* already gone */ }
  }
  const ok = steps.every(one => one.ok);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ ok, label, state: keep ? state : null, node: process.version, observedMs: Date.now() - started, steps, limits: [
    "this certifies launchd's automatic relaunch and the shared unit's lifecycle for a disposable label in this user's gui domain",
    "it does not reboot; LaunchAgents resume at user login after a reboot, not before FileVault unlock/login",
  ] }, null, 2)}\n`);
  if (!keep) rmSync(state, { recursive: true, force: true });
  console.log(`${ok ? "PASS" : "FAIL"} — launchd certificate written to ${output}`);
  process.exit(ok ? 0 : 1);
}
