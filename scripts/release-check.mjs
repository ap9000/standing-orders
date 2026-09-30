#!/usr/bin/env node
/**
 * The release check, sized to the change. Typecheck and build always run;
 * after that only what the change can break:
 *
 *   - unit tests related to the changed files (`vitest related <files>`);
 *     the whole suite when test setup, config or dependencies changed
 *   - the browser journeys (flows-e2e and every app-e2e group) only when the
 *     change touches something a page shows: the console, the server that
 *     renders it, the e2e scripts, or dependencies
 *   - nothing more for docs, evidence and design notes
 *
 * The base is origin/main, fetched fresh; files are compared, not ancestry.
 * No difference from main (or no main) means everything runs. `--full` (or TOOLROLL_FULL_CHECK=1) runs
 * everything, as the check did before. Ends with the same `== summary` block.
 *
 *   node scripts/release-check.mjs [--full] [--base <ref>] [--plan]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const full = args.includes("--full") || process.env.TOOLROLL_FULL_CHECK === "1";
const planOnly = args.includes("--plan");
const baseFlag = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
const tryGit = (...argv) => { try { return git(...argv); } catch { return null; } };

/**
 * What to compare against: main as GitHub has it now. The gate checks out a
 * commit of its own (the candidate's files on the checkout's local main), so
 * ancestry says nothing — compare the files. A candidate behind main counts
 * main's newer changes too, which only ever runs more.
 */
function baseOf() {
  if (baseFlag !== undefined) return baseFlag;
  tryGit("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
  return tryGit("rev-parse", "--verify", "-q", "origin/main");
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
  const changed = base === null ? [] : git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  // No main to compare with, or nothing differs from it (a release of main itself): check everything.
  const plan = planFor(changed, { full: full || changed.length === 0 });
  console.log(`Release check against ${base === null ? "nothing (origin/main unknown)" : `origin/main ${base.slice(0, 12)}`} (${changed.length} changed files): ${plan.why}.`);
  if (planOnly) process.exit(0);

  try {
    execFileSync("npm", ["run", "typecheck"], { stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  } catch { process.exit(1); }

  const dir = mkdtempSync(join(tmpdir(), "release-check-"));
  const jobs = [];
  if (plan.unit === "all") jobs.push(run("unit", "npm", ["test", "--", "--run", "--reporter=dot"], dir));
  // The changed files themselves, not `--changed <ref>`: vitest reads that as
  // ancestry (ref...HEAD), which the gate's own commit makes meaningless.
  const sources = changed.filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(file));
  if (plan.unit === "related" && sources.length > 0) jobs.push(run("unit", "npx", ["vitest", "related", "--run", "--reporter=dot", "--passWithNoTests", ...sources], dir));
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
