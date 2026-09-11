#!/usr/bin/env node
/** Kill actual CLI workers at real process barriers; no clock injection or model calls. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, realpathSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "scripts/fixtures/crash-process.mjs");
const bin = join(root, "dist/bin.js");
const stages = ["planning", "setup", "building", "after-commit", "verification", "review"];
let selected = stages;
let rounds = 1;
let concurrency = 6;
let output = resolve("output/certification/crash.json");
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--stage") selected = [process.argv[++i]];
  else if (arg === "--rounds") rounds = Number(process.argv[++i]);
  else if (arg === "--concurrency") concurrency = Number(process.argv[++i]);
  else if (arg === "--output") output = resolve(process.argv[++i]);
  else if (arg === "--help") { console.log("npm run certify:crash -- [--stage planning|setup|building|after-commit|verification|review] [--rounds 1] [--concurrency 6] [--output file]"); process.exit(0); }
  else throw new Error(`unknown argument ${arg}`);
}
assert(process.platform !== "win32", "SIGKILL fixture requires macOS or Linux; physical Windows remains a separate gate");
assert(selected.every(stage => stages.includes(stage)) && Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, "invalid stages/rounds");
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 20, "concurrency is 1..20");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-crash-canary-")));
const gitBinary = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const revision = execFileSync(gitBinary, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const hash = () => {
  const h = createHash("sha256");
  const visit = path => { for (const name of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = join(path, name.name); if (name.isDirectory()) visit(p); else h.update(p.slice(root.length)).update(readFileSync(p));
  }};
  visit(join(root, "dist"));
  for (const file of ["scripts/crash-canary.mjs", "scripts/fixtures/crash-process.mjs", "package.json"]) h.update(file).update(readFileSync(join(root, file)));
  return h.digest("hex");
};
const runtime = hash();
const started = Date.now();
const cases = [];
const children = new Set();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function start(args, options) {
  const child = spawn(process.execPath, [bin, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
  const done = new Promise((resolvePromise, reject) => { child.on("error", reject); child.on("close", (code, signal) => { children.delete(child); resolvePromise({ code, signal, stdout, stderr }); }); });
  return { child, done };
}
async function until(predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}
async function one(stage, round) {
  const dir = join(base, `${stage}-${round}`); mkdirSync(dir);
  const repo = join(dir, "repo"), control = join(dir, "control"), tools = join(dir, "bin"), home = join(dir, "home");
  for (const path of [repo, control, tools, home]) mkdirSync(path);
  const db = join(dir, "orders.db"), pool = join(dir, "pool");
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const check = `${quote(process.execPath)} ${quote(fixture)} check ${quote(control)}`;
  const acceptance = [
    { id: "c1", statement: "The result file contains recovered and a newline.", evidence: ["changed-path"] },
    { id: "c2", statement: "The approved check passes.", evidence: ["check"] },
  ];
  writeFileSync(join(control, "config.json"), JSON.stringify({ stage, check, git: gitBinary, acceptance }));
  for (const kind of ["claude", "git"]) {
    const path = join(tools, kind);
    writeFileSync(path, `#!${process.execPath}\nprocess.env.SO_CRASH_KIND=${JSON.stringify(kind)}; await import(${JSON.stringify(fixture)});\n`);
    chmodSync(path, 0o700);
  }
  const env = { PATH: `${tools}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: dir, SO_CRASH_CONTROL: control, NO_COLOR: "1" };
  const opts = { cwd: repo, env };
  const git = args => execFileSync(gitBinary, args, { cwd: repo, env, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Crash Fixture"]);
  writeFileSync(join(repo, "README.md"), "Disposable crash fixture.\n"); git(["add", "."]); git(["commit", "-qm", "seed"]);
  const cli = async (args, accepted = [0]) => {
    const result = await start([...args, "--db", db, "--json"], opts).done;
    assert(accepted.includes(result.code), `${args.slice(0,2).join(" ")}: ${result.stdout} ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const rows = sql => { const c = new DatabaseSync(db, { readOnly: true }); try { return c.prepare(sql).all(); } finally { c.close(); } };
  const events = () => existsSync(join(control,"events.jsonl")) ? readFileSync(join(control,"events.jsonl"),"utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
  const record = { stage, round, passed: false, checks: {}, retainedAt: dir };
  let worker, successor, checkpoint;
  try {
    await cli(["approver", "add", "fixture", "--password", "fixture-only-password"]);
    const auth = ["--as", "fixture", "--token", "fixture-only-password"];
    const registered = await cli(["runner", "register", "worker", "--repo", repo, ...auth]);
    writeFileSync(join(control,"token"), registered.token, { mode: 0o600 });
    for (const phase of ["plan", "build", "repair", "review"]) await cli(["config", "set", phase, "--provider", "claude", "--model", "fixture", ...auth]);
    await cli(["verify", "set", "--repo", repo, "--command", check, "--timeout-seconds", "240", "--yes", ...auth]);
    if (stage === "setup") await cli(["setup", "set", "--repo", repo, "--command", `${quote(process.execPath)} ${quote(fixture)} setup ${quote(control)}`, "--timeout-seconds", "240", "--yes", ...auth]);
    await cli(["task", "add", "Write result.txt containing recovered and a newline.", "--id", "work", "--repo", repo]);
    if (stage === "planning") {
      await cli(["task", "plan", "work", "--provider", "claude", "--model", "fixture", ...auth]);
    } else {
      await cli(["task", "scope", "work", "--goal", "Write the result and verify it.", "--acceptance", acceptance.map(c => `${c.statement}|${c.evidence.join(",")}`).join(";")]);
      const preview = await cli(["task", "show", "work"]);
      await cli(["task", "approve", "work", "--yes", "--digest", preview.scope.digest, ...auth]);
    }
    const workerArgs = ["watch", "--runner", "worker", "--token-file", join(control,"token"), "--repo", repo, "--pool", pool, "--tick-every", "200", "--reconcile-every", "500", "--bridge-every", "3600000", "--stop-grace", "1000", "--db", db, "--json"];
    if (stage === "review") {
      await cli(["tick", "--runner", "worker", "--token", registered.token, "--repo", repo, "--pool", pool]);
      const built = await cli(["task", "show", "work"]);
      assert.equal(built.proofVerdict, "verified");
      await cli(["task", "review", String(built.runs.find(r => r.role === "builder").id), ...auth]);
    }
    worker = start([...workerArgs, "--for", "180000"], opts);
    worker.done.then(result => writeFileSync(join(control,"worker-result.json"), JSON.stringify(result)));
    checkpoint = await until(() => existsSync(join(control,"checkpoint.json")) && JSON.parse(readFileSync(join(control,"checkpoint.json"),"utf8")), 25000, `${stage} checkpoint`);
    record.checks.checkpoint = checkpoint;
    record.checks.preCrashRuns = rows("SELECT id,role,phase,outcome FROM run");
    if (["after-commit", "verification"].includes(stage)) record.checks.committedBeforeCrash = execFileSync(gitBinary, ["rev-parse", "HEAD"], { cwd: checkpoint.cwd, encoding: "utf8" }).trim();
    worker.child.kill("SIGKILL");
    const killed = await worker.done;
    assert.equal(killed.signal, "SIGKILL");
    record.checks.workerKilled = true;
    record.checks.childSurvived = alive(checkpoint.pid);
    assert(record.checks.childSurvived, "external checkpoint process did not survive the worker");
    if (stage === "after-commit") writeFileSync(join(control,"released"), "commit subprocess already finished its write\n");
    const lease = rows("SELECT expires_at FROM watch_lease")[0];
    const busy = await start([...workerArgs, "--for", "100"], opts).done;
    assert.equal(JSON.parse(busy.stdout).reason, "watch-busy");
    record.checks.beforeExpiry = "refused";
    console.log(`${stage}/${round}: worker killed; waiting for its real watch lease to expire`);
    while (Date.now() <= Date.parse(lease.expires_at) + 100) await sleep(Math.min(1000, Date.parse(lease.expires_at) + 110 - Date.now()));
    // Leave the external process alive during takeover: expiry must never
    // by itself grant a second writer access to that checkout.
    successor = start([...workerArgs, "--for", "800"], opts);
    const probe = await Promise.race([successor.done, sleep(6000).then(() => null)]);
    if (probe === null) { successor.child.kill("SIGTERM"); await successor.done; }
    writeFileSync(join(control,"takeover-result.json"), JSON.stringify(await successor.done));
    record.checks.overlappingWriters = events().filter(e => e.name === "overlapping-writer");
    writeFileSync(join(control,"released"), "release fixture process\n");
    await until(() => !alive(checkpoint.pid), 5000, `${stage} external process exit`);
    const before = await cli(["task", "show", "work"]);
    record.checks.afterTakeover = { state: before.task.state, dispatch: before.dispatch, runs: before.runs.map(r => ({ id:r.id,role:r.role,outcome:r.outcome,reason:r.reason })) };
    if (stage !== "review") writeFileSync(join(control,"recovery-result.json"), JSON.stringify(await start([...workerArgs, "--for", "2500"], opts).done));
    const after = await cli(["task", "show", "work"]);
    const runsBeforeDuplicate = rows("SELECT id FROM run ORDER BY id");
    const duplicate = await cli(["tick", "--runner", "worker", "--token", registered.token, "--repo", repo, "--pool", pool], [3]);
    assert.equal(duplicate.reason, stage === "planning" ? "nothing-dispatched" : "empty");
    assert.deepEqual(rows("SELECT id FROM run ORDER BY id"), runsBeforeDuplicate);
    record.checks.duplicateDispatch = stage === "planning" ? "refused-unapproved" : "refused-empty";
    record.checks.final = { state: after.task.state, scope: !!after.scope, proof: after.proofVerdict, dispatch: after.dispatch,
      runs: after.runs.map(r => ({ id:r.id, role:r.role, outcome:r.outcome, reason:r.reason, parent:r.parentRun, head:r.headRevision })) };
    record.checks.events = events();
    record.checks.openRuns = rows("SELECT id,role FROM run WHERE outcome IS NULL");
    const failures = [];
    if (record.checks.overlappingWriters.length) failures.push("a successor provider started while an earlier writer still lived");
    if (record.checks.openRuns.length) failures.push("interrupted runs remain open after restart");
    if (stage === "planning" && !after.scope) failures.push("the interrupted planning request did not resume");
    if (!["planning","review"].includes(stage) && (after.task.state !== "done" || after.proofVerdict !== "verified")) failures.push("the preserved draft/commit did not finish with verified proof");
    if (stage === "review" && after.dispatch.code !== "review-failed") failures.push("the interrupted review is not shown as needing attention");
    if (stage !== "planning") {
      const finalHead = execFileSync(gitBinary, ["rev-parse", "standing-orders/work"], { cwd: repo, encoding: "utf8" }).trim();
      assert.equal(execFileSync(gitBinary, ["show", `${finalHead}:result.txt`], { cwd: repo, encoding: "utf8" }), "recovered\n");
      assert.equal(events().filter(e => e.name === "commit").length, 1, "recovery must not create a duplicate commit");
      if (record.checks.committedBeforeCrash) assert.equal(finalHead, record.checks.committedBeforeCrash, "recovery must retain the original commit");
      record.checks.finalHead = finalHead;
    }
    record.failures = failures;
    record.passed = failures.length === 0;
  } catch (error) { record.error = error.stack; }
  finally {
    writeFileSync(join(control,"released"), "fixture cleanup\n");
    for (const handle of [worker,successor]) if (handle && handle.child.exitCode === null && handle.child.signalCode === null) { handle.child.kill("SIGKILL"); await handle.done; }
    if (checkpoint && alive(checkpoint.pid)) { try { process.kill(checkpoint.pid,"SIGKILL"); } catch {} }
    writeFileSync(join(dir,"result.json"), JSON.stringify(record,null,2));
  }
  cases.push(record);
  console.log(`${stage}/${round}: ${record.passed ? "PASS" : "FAIL"} ${record.failures?.join("; ") ?? record.error?.split("\n")[0] ?? ""}`);
}
const pending = Array.from({ length: rounds }, (_, i) => selected.map(stage => ({ stage, round: i + 1 }))).flat();
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
  while (pending.length) { const next = pending.shift(); await one(next.stage, next.round); }
}));
const certificate = { version:1, passed: cases.every(c=>c.passed) && hash()===runtime, sourceCommit:revision, runtimeSha256:runtime, runtimeUnchanged:hash()===runtime,
  platform:process.platform, node:process.versions.node, durationSeconds:(Date.now()-started)/1000, cases, retainedAt:base,
  scope:"Actual public-CLI watch processes killed with SIGKILL at deterministic external-process checkpoints; normal 90-second lease expiry; real git, SQLite, subprocesses and successor watch. Provider responses are fixtures, not model calls.",
  exclusions:["real-provider recovery", "Windows", "reboot", "detached descendants", "power-loss filesystem durability"] };
mkdirSync(dirname(output), { recursive:true }); writeFileSync(output, JSON.stringify(certificate,null,2)+"\n");
console.log(`Certificate: ${output}`);
if (!certificate.passed) process.exitCode=1;
