#!/usr/bin/env node
/**
 * The release check, sized to the change. Typecheck and build always run;
 * after that only what the change can break:
 *
 *   - unit tests related to the changed files (`vitest --changed <base>`);
 *     the whole suite when test setup, config or dependencies changed
 *   - the browser journeys (flows-e2e and every app-e2e group) only when the
 *     change touches something a page shows: the console, the server that
 *     renders it, the e2e scripts, or dependencies
 *   - nothing more for docs, evidence and design notes
 *
 * The base is where the candidate left main (its merge-base with origin/main,
 * or its parent when it is main). `--full` (or TOOLROLL_FULL_CHECK=1) runs
 * everything, as the check did before. Ends with the same `== summary` block.
 *
 *   node scripts/release-check.mjs [--full] [--base <ref>] [--plan]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const full = args.includes("--full") || process.env.TOOLROLL_FULL_CHECK === "1";
const planOnly = args.includes("--plan");
const baseFlag = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
const tryGit = (...argv) => { try { return git(...argv); } catch { return null; } };

/** Where the candidate left main. */
function baseOf() {
  if (baseFlag !== undefined) return baseFlag;
  const head = git("rev-parse", "HEAD");
  const main = tryGit("rev-parse", "--verify", "-q", "origin/main");
  const fork = main === null ? null : tryGit("merge-base", "HEAD", main);
  if (fork !== null && fork !== head) return fork;
  return tryGit("rev-parse", "--verify", "-q", "HEAD~1") ?? head;
}

/** Changes that need every unit test, not just the related ones. */
const WHOLE_UNIT = [/^vitest\.config\./, /^test\//, /^tsconfig/, /^package(-lock)?\.json$/, /^src\/fixtures\//];
/** Changes a page can show, so every browser journey runs. */
const BROWSER = [
  /^src\/browser\//, /^src\/browser-[^/]+\.ts$/, /^src\/workspace[^/]*\.ts$/, /^src\/serve\.ts$/, /^src\/[^/]+-ui\.ts$/,
  /^src\/(mobile-viewport|guarded-html|ledger-view|guides|work-index|lead-status)\.ts$/, /\.css$/, /tailwind/,
  /^scripts\/(app-e2e|flows-e2e|e2e-kit|e2e-parallel|browser-build|postbuild)\.mjs$/, /^package(-lock)?\.json$/,
];
/** Changes no test reads. */
const NOTHING = [/\.md$/, /^docs\//, /^evidence\//, /^design\//, /^output\//, /^LICENSE$/, /\.png$/];

export function planFor(changed, { full: all = false } = {}) {
  if (all) return { unit: "all", browser: true, why: "a full check was asked for" };
  const code = changed.filter(file => !NOTHING.some(re => re.test(file)));
  if (code.length === 0) return { unit: "none", browser: false, why: "only docs, evidence or design notes changed" };
  const wholeUnit = code.find(file => WHOLE_UNIT.some(re => re.test(file)));
  const page = code.find(file => BROWSER.some(re => re.test(file)));
  return {
    unit: wholeUnit !== undefined ? "all" : "related",
    browser: page !== undefined,
    why: [
      wholeUnit !== undefined ? `every unit test (${wholeUnit} changed)` : "unit tests related to the change",
      page !== undefined ? `browser journeys (${page} changed)` : "no browser journeys (nothing a page shows changed)",
    ].join("; "),
  };
}

const run = (label, command, argv, dir) => new Promise(done => {
  const log = join(dir, `${label}.log`);
  const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => chunks.push(chunk));
  child.on("close", code => { writeFileSync(log, Buffer.concat(chunks)); done({ label, code: code ?? 1, log }); });
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const base = baseOf();
  const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const plan = planFor(changed, { full });
  console.log(`Release check against ${base.slice(0, 12)} (${changed.length} changed files): ${plan.why}.`);
  if (planOnly) process.exit(0);

  try {
    execFileSync("npm", ["run", "typecheck"], { stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  } catch { process.exit(1); }

  const dir = mkdtempSync(join(tmpdir(), "release-check-"));
  const jobs = [];
  if (plan.unit === "all") jobs.push(run("unit", "npm", ["test", "--", "--run", "--reporter=dot"], dir));
  if (plan.unit === "related") jobs.push(run("unit", "npx", ["vitest", "run", "--reporter=dot", "--changed", base, "--passWithNoTests"], dir));
  if (plan.browser) {
    jobs.push(run("flows", process.execPath, ["scripts/flows-e2e.mjs"], dir));
    jobs.push(run("app", process.execPath, ["scripts/e2e-parallel.mjs", "scripts/app-e2e.mjs", "--skip-build"], dir));
  }
  const results = await Promise.all(jobs);
  for (const one of results) { console.log(`== ${one.label}`); console.log(readFileSync(one.log, "utf8")); }
  console.log("== summary");
  console.log(`plan: ${plan.why}`);
  for (const one of results) {
    console.log(`${one.label}: exit ${one.code}`);
    const lines = readFileSync(one.log, "utf8").split("\n").filter(line => /FAIL|Test Files|passed, /.test(line));
    for (const line of lines.slice(-5)) console.log(line);
  }
  if (results.length === 0) console.log("typecheck and build passed; nothing else to run");
  process.exitCode = results.some(one => one.code !== 0) ? 1 : 0;
}
