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

const [script, ...rest] = process.argv.slice(2);
if (script === undefined) { console.error("Usage: node scripts/e2e-parallel.mjs <script.mjs> [options for every group]"); process.exit(2); }
const groups = JSON.parse(execFileSync(process.execPath, [script, "--groups", "--json"], { encoding: "utf8" }));
const name = basename(script, ".mjs").replace(/-e2e$/, "");
const out = resolve(join(here, "output/e2e", `${name}-parallel-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const started = Date.now();
const minutes = ms => Math.round(ms / 6000) / 10;
const width = Math.max(...groups.map(one => one.name.length));
console.log(`Running ${groups.length} groups at once: ${groups.map(one => one.name).join(", ")}`);

const runs = groups.map(({ name: group }) => new Promise(done => {
  const at = Date.now();
  const child = spawn(process.execPath, [script, "--group", group, "--output", join(out, group), ...rest], { stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${group.padEnd(width)}]`;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.on("data", chunk => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) console.log(`${tag} ${line}`);
    });
    stream.on("end", () => { if (partial !== "") console.log(`${tag} ${partial}`); });
  }
  child.on("close", (code, signal) => done({ group, code: code ?? 1, signal, minutes: minutes(Date.now() - at) }));
}));
process.on("SIGINT", () => process.exit(130));

const finished = await Promise.all(runs);
console.log("");
for (const one of finished) {
  const report = join(out, one.group, "report.md");
  console.log(existsSync(report) ? readFileSync(report, "utf8") : `# ${one.group} — no report (exited ${one.signal ?? one.code})\n`);
}
const failed = finished.filter(one => one.code !== 0);
console.log(finished.map(one => `${one.code === 0 ? "✅" : "❌"} ${one.group.padEnd(width)}  ${one.minutes} min`).join("\n"));
console.log(`\n${groups.length - failed.length} of ${groups.length} groups passed in ${minutes(Date.now() - started)} min — ${out}`);
process.exitCode = failed.length === 0 ? 0 : 1;
