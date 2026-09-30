#!/usr/bin/env node
/**
 * Weekly upkeep, for a flow to run every week: a Run a script zone runs this
 * file in a copy of main after the project's setup (runIn copy).
 *
 *   node scripts/flows/weekly-upkeep.mjs [--state <file>]
 *
 * It asks npm which dependencies are out of date (npm outdated) and which
 * have known vulnerabilities (npm audit), and compares the installed claude,
 * codex and gemini with the versions it recorded last time. The record is a
 * file outside the copy, which goes when the step ends:
 * ~/.cache/toolroll-flows/weekly-upkeep.json unless --state says otherwise.
 *
 * It prints one line per thing to act on and exits 1 when there is one (the
 * zone's failure path); with nothing to act on it says so and exits 0.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const at = args.indexOf("--state");
const stateFile = resolve(at === -1 ? join(homedir(), ".cache", "toolroll-flows", "weekly-upkeep.json") : args[at + 1]);
const CLIS = ["claude", "codex", "gemini"];
const act = [];

/** npm's JSON answer: npm outdated and npm audit exit 1 when they find something, so the exit alone isn't a failure. */
function npm(argv) {
  const ran = spawnSync("npm", argv, { cwd: here, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const said = (ran.stderr ?? "").trim().split("\n").at(-1) ?? "";
  if (ran.error !== undefined) return { problem: ran.error.message };
  try {
    const body = JSON.parse(ran.stdout || "{}");
    return body.error === undefined ? { body } : { problem: body.error.summary ?? body.error.code ?? said };
  } catch { return { problem: said || `exit ${ran.status}` }; }
}

const outdated = npm(["outdated", "--json"]);
if (outdated.problem !== undefined) act.push(`npm outdated couldn't run: ${outdated.problem}`);
else for (const [name, one] of Object.entries(outdated.body)) {
  const found = Array.isArray(one) ? one[0] : one;
  if (found.current === found.latest) continue;
  act.push(`Update ${name}: ${found.current ?? "not installed"} → ${found.latest}${found.wanted !== found.latest && found.wanted !== found.current ? ` (${found.wanted} within its range)` : ""}`);
}

const audit = npm(["audit", "--json"]);
if (audit.problem !== undefined) act.push(`npm audit couldn't run: ${audit.problem}`);
else for (const [name, one] of Object.entries(audit.body.vulnerabilities ?? {})) {
  const advisory = one.via.find(each => typeof each === "object");
  const why = advisory !== undefined ? advisory.title : `through ${one.via.join(", ")}`;
  const fix = one.fixAvailable === false ? "no fix yet" : one.fixAvailable === true ? "npm audit fix" : `fixed in ${one.fixAvailable.name} ${one.fixAvailable.version}`;
  act.push(`Vulnerable ${name} (${one.severity}): ${why} — ${fix}`);
}

/** The version a CLI says it is, or null when it isn't installed or doesn't answer. */
function versionOf(cli) {
  const ran = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return ran.status === 0 ? /\d+\.\d+\.\d+[\w.+-]*/.exec(ran.stdout)?.[0] ?? null : null;
}
let recorded = {};
try { recorded = JSON.parse(readFileSync(stateFile, "utf8")).clis ?? {}; } catch { /* the first run */ }
const now = Object.fromEntries(CLIS.map(cli => [cli, versionOf(cli)]));
for (const cli of CLIS) {
  if (!(cli in recorded) || recorded[cli] === now[cli]) continue;
  if (now[cli] === null) act.push(`${cli} ${recorded[cli]} is no longer installed`);
  else act.push(`${cli} ${recorded[cli] ?? "(not installed)"} → ${now[cli]}: check Toolroll still runs it (npm run certify:provider)`);
}
try {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(`${stateFile}.tmp`, `${JSON.stringify({ checkedAt: new Date().toISOString(), clis: now }, null, 2)}\n`);
  renameSync(`${stateFile}.tmp`, stateFile);
} catch (error) { act.push(`Couldn't record the CLI versions in ${stateFile}: ${error.message}`); }
process.stderr.write(`CLIs now: ${CLIS.map(cli => `${cli} ${now[cli] ?? "not installed"}`).join(", ")}; recorded in ${stateFile}\n`);

process.stdout.write(act.length === 0 ? "Nothing to act on this week.\n" : `${act.join("\n")}\n`);
process.exitCode = act.length === 0 ? 0 : 1;
