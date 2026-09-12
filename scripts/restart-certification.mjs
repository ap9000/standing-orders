#!/usr/bin/env node
/**
 * Restart certification (docs/PROCESS_CONTAINMENT_PLAN.md, acceptance 7).
 *
 *   npm run certify:restart -- baseline --db <orders.db> [--label <service label>] [--output <file>]
 *   npm run certify:restart -- verify   --db <orders.db> --baseline <file> [--label <label>] [--expect reboot|login|either] [--output <file>]
 *
 * `baseline` records the OS boot identity, the runtime, the installed
 * service's state, the containment status and the database's live custody
 * (pending stops, open runs, running tasks, open witnesses) — names and
 * timestamps only, never a credential. A person then logs out and in, or
 * reboots, THEMSELVES: this tool never does, and never restarts a service.
 * `verify` compares the same database afterwards: whether the boot really
 * changed (the kernel's own token), whether the service is a working
 * controller (running AND a fresh heartbeat), whether what the old boot
 * left pending settled by the controller's own rules, and whether the
 * tasks that were running moved on. Its exit code is the verdict; its
 * output carries the exact limits of what a pass proves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "npm run certify:restart -- baseline|verify --db <file> [--label <label>] [--baseline <file>] [--expect reboot|login|either] [--output <file>] [--no-recover]";
const [mode, ...rest] = process.argv.slice(2);
if (mode === undefined || mode === "--help" || (mode !== "baseline" && mode !== "verify")) { console.log(usage); process.exit(mode === "--help" ? 0 : 2); }
const options = { db: undefined, label: undefined, baseline: undefined, expect: "either", output: undefined, recover: true };
for (let index = 0; index < rest.length; index++) {
  const arg = rest[index];
  if (arg === "--no-recover") { options.recover = false; continue; }
  const value = rest[++index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value; ${usage}`);
  if (arg === "--db") options.db = resolve(value);
  else if (arg === "--label") options.label = value;
  else if (arg === "--baseline") options.baseline = resolve(value);
  else if (arg === "--expect") options.expect = value;
  else if (arg === "--output") options.output = resolve(value);
  else throw new Error(`unknown option ${arg}; ${usage}`);
}
if (options.db === undefined || !existsSync(options.db)) throw new Error(`--db must name an existing database; ${usage}`);
if (!["reboot", "login", "either"].includes(options.expect)) throw new Error(`--expect is reboot, login or either; ${usage}`);

const { openStoreNoMigrate } = await import(pathToFileURL(resolve(root, "dist/store.js")));
const { installedServiceDefinition } = await import(pathToFileURL(resolve(root, "dist/daemon.js")));
const { run } = await import(pathToFileURL(resolve(root, "dist/exec.js")));
const { recordRestartBaseline, verifyRestartRecovery, assertNoSecret } = await import(pathToFileURL(resolve(root, "dist/restart-certification.js")));

// The certificate NEVER migrates a database: a live controller's file is
// opened exactly as it is, and a file this build cannot read is refused.
const opened = openStoreNoMigrate(options.db);
if (!opened.ok) throw new Error(opened.message);
const store = opened.store;
try {
  const service = options.label === undefined ? undefined : (() => {
    const definition = installedServiceDefinition({ label: options.label, configDir: dirname(options.db) });
    if (definition === null) throw new Error(`no installed unit found for ${options.label} — the service view needs the unit file on disk`);
    return { definition, run };
  })();
  // Secrets that might sit beside the database: never in the output.
  const secrets = [];
  for (const name of ["runner-token", "telegram-token"]) {
    const file = resolve(dirname(options.db), name);
    if (existsSync(file)) secrets.push(readFileSync(file, "utf8").trim());
  }
  if (mode === "baseline") {
    const baseline = await recordRestartBaseline({ store, ...(service === undefined ? {} : { service }) });
    const json = JSON.stringify(baseline, null, 2);
    assertNoSecret(json, secrets);
    const output = options.output ?? resolve("output/certification/restart-baseline.json");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${json}\n`);
    console.log(`baseline recorded at ${output}`);
    console.log(`  host ${baseline.host} · boot ${baseline.boot.id ?? `unknown (${baseline.boot.problem})`} · node ${baseline.runtime.nodeVersion} · schema v${baseline.database.schemaVersion}`);
    console.log(`  service ${baseline.service === null ? "(none named; pass --label)" : `${baseline.service.label}: ${baseline.service.detail}`}`);
    console.log(`  custody: ${baseline.database.pendingStops.length} pending stop(s), ${baseline.database.openRuns.length} open run(s), ${baseline.database.runningTasks.length} running task(s), ${baseline.database.witnesses.length} open witness(es)`);
    console.log("  now log out and in, or reboot — this tool does neither — then run verify against the same database.");
    for (const limit of baseline.limits) console.log(`  limit: ${limit}`);
    process.exit(0);
  }
  if (options.baseline === undefined || !existsSync(options.baseline)) throw new Error(`verify needs --baseline <file>; ${usage}`);
  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const verified = await verifyRestartRecovery({ store, baseline, expect: options.expect, recover: options.recover, ...(service === undefined ? {} : { service }) });
  const json = JSON.stringify(verified, null, 2);
  assertNoSecret(json, secrets);
  const output = options.output ?? resolve("output/certification/restart-verification.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${json}\n`);
  console.log(`${verified.ok ? "PASS" : "FAIL"} — restart certification (${verified.expectation}); boot ${verified.bootChanged === null ? "unknown" : verified.bootChanged ? "changed" : "unchanged"}`);
  for (const check of verified.checks) console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  console.log(`  written to ${output}`);
  for (const limit of verified.limits) console.log(`  limit: ${limit}`);
  process.exit(verified.ok ? 0 : 1);
} finally {
  store.close();
}
