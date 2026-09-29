#!/usr/bin/env node
/**
 * Run every group of an end-to-end script at once, each in its own world, and
 * fail if any group fails. The script lists its groups with `--groups --json`
 * and runs one with `--group <name>`.
 *
 *   npm run e2e:app:parallel      (or: node scripts/e2e-parallel.mjs scripts/app-e2e.mjs [--keep] [--only <pattern>] …)
 *
 * Each group's output is prefixed with its name; its report goes to
 * output/e2e/<script>-parallel-<time>/<group>/report.md and is printed at the end.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { here } from "./e2e-kit.mjs";

const [script, ...given] = process.argv.slice(2);
if (script === undefined) { console.error("Usage: node scripts/e2e-parallel.mjs <script.mjs> [--no-retry] [options for every group]"); process.exit(2); }
// A group that fails runs once more in a fresh world; passing then marks it flaky (a follow-up), not a failed run.
const retry = !given.includes("--no-retry");
const rest = given.filter(one => one !== "--no-retry");
const groups = JSON.parse(execFileSync(process.execPath, [script, "--groups", "--json"], { encoding: "utf8" }));
const name = basename(script, ".mjs").replace(/-e2e$/, "");
const out = resolve(join(here, "output/e2e", `${name}-parallel-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const started = Date.now();
const minutes = ms => Math.round(ms / 6000) / 10;
const width = Math.max(...groups.map(one => one.name.length));
console.log(`Running ${groups.length} groups at once: ${groups.map(one => one.name).join(", ")}`);

const runGroup = (group, folder) => new Promise(done => {
  const at = Date.now();
  const child = spawn(process.execPath, [script, "--group", group, "--output", join(out, folder), ...rest], { stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${folder.padEnd(width)}]`;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) console.log(`${tag} ${line}`);
    });
    stream.on("end", () => { if (partial !== "") console.log(`${tag} ${partial}`); });
  }
  child.on("close", (code, signal) => done({ group, folder, code: code ?? 1, signal, minutes: minutes(Date.now() - at) }));
});
process.on("SIGINT", () => process.exit(130));

const first = await Promise.all(groups.map(({ name: group }) => runGroup(group, group)));
const again = retry ? await Promise.all(first.filter(one => one.code !== 0).map(one => runGroup(one.group, `${one.group}-retry`))) : [];
const finished = first.map(one => again.find(next => next.group === one.group) ?? one);
const flaky = again.filter(one => one.code === 0).map(one => one.group);
console.log("");
for (const one of [...first, ...again]) {
  const report = join(out, one.folder, "report.md");
  console.log(existsSync(report) ? readFileSync(report, "utf8") : `# ${one.folder} — no report (exited ${one.signal ?? one.code})\n`);
}
const failed = finished.filter(one => one.code !== 0);
console.log(finished.map(one => `${one.code === 0 ? "✅" : "❌"} ${one.group.padEnd(width)}  ${one.minutes} min${flaky.includes(one.group) ? "  (flaky: passed on the second try)" : ""}`).join("\n"));
console.log(`\n${groups.length - failed.length} of ${groups.length} groups passed${flaky.length > 0 ? ` (flaky, passed on the second try: ${flaky.join(", ")})` : ""} in ${minutes(Date.now() - started)} min — ${out}`);
process.exitCode = failed.length === 0 ? 0 : 1;
