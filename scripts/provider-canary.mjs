#!/usr/bin/env node
/**
 * A real-provider release canary.
 *
 * This deliberately drives the public CLI rather than importing builder
 * internals: the disposable repository must cross the same registration,
 * planning, approval, worktree, provider, commit, verification, and evidence
 * boundaries as a person's task. It never pushes or opens a pull request.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist", "bin.js");
const TASK_ID = "provider-canary";

function usage() {
  return [
    "Real-provider Never Stuck canary",
    "",
    "  npm run certify:provider -- --provider claude --model sonnet",
    "  npm run certify:provider -- --provider codex --model gpt-5.6-sol",
    "",
    "Options:",
    "  --provider claude|codex   subscription CLI to exercise",
    "  --model <model>           exact model sealed into plan and build",
    "  --output <file>           write the final JSON certificate",
    "  --review                  require an independent review of the result",
    "  --keep                    keep the disposable repo and evidence",
    "  --json                    print only the final JSON certificate",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { provider: null, model: null, output: null, keep: false, review: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep") result.keep = true;
    else if (arg === "--review") result.review = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--provider" || arg === "--model" || arg === "--output") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      result[arg.slice(2)] = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (result.help) return result;
  if (result.provider !== "claude" && result.provider !== "codex") {
    throw new Error("--provider is claude or codex");
  }
  if (typeof result.model !== "string" || result.model.trim() === "") {
    throw new Error("--model is required because task approvals seal exact routing");
  }
  return result;
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function parseEnvelope(answer, label, acceptedCodes = [0]) {
  let envelope = null;
  try {
    envelope = JSON.parse(answer.stdout.trim());
  } catch {
    // The thrown diagnostic below includes the bounded raw answer.
  }
  if (!acceptedCodes.includes(answer.code) || envelope === null || typeof envelope !== "object") {
    const details = [
      `${label} failed (exit ${answer.code})`,
      answer.stderr.trim(),
      answer.stdout.trim(),
    ].filter(Boolean).join("\n").slice(0, 8_000);
    throw new Error(details);
  }
  return envelope;
}

/** The executable bytes and source identity tested by this run. Each CLI
 * boundary rechecks them; an in-place build cannot silently change the
 * implementation halfway through a successful certificate. */
async function runtimeIdentity() {
  const hash = createHash("sha256");
  async function hashDirectory(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await hashDirectory(join(directory, entry.name), relative);
      else if (entry.isFile()) hash.update(relative).update("\0").update(await readFile(join(directory, entry.name))).update("\0");
      else throw new Error(`unexpected runtime entry ${relative}`);
    }
  }
  await hashDirectory(join(root, "dist"), "dist");
  for (const file of ["package.json", "scripts/provider-canary.mjs", "scripts/proof-preflight.mjs"]) {
    hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  }
  const revision = await run("git", ["rev-parse", "HEAD"]);
  const changes = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
  return { sha256: hash.digest("hex"), sourceCommit: revision.code === 0 ? revision.stdout.trim() : null,
    trackedChanges: changes.code === 0 ? changes.stdout.trim() !== "" : null };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const startedAt = new Date();
  const base = await realpath(await mkdtemp(join(tmpdir(), "standing-orders-provider-canary-")));
  const repo = join(base, "repo");
  const db = join(base, "orders.db");
  const pool = join(base, "worktrees");
  const password = `canary-${randomUUID()}`;
  const common = ["--db", db, "--json"];
  let passed = false;
  let runtime = null;
  const steps = [];
  const assertRuntime = async () => {
    if (runtime !== null && JSON.stringify(await runtimeIdentity()) !== JSON.stringify(runtime)) {
      throw new Error("the Standing Orders runtime changed during the canary; rerun against one fixed build");
    }
  };

  const note = message => {
    if (!options.json) process.stdout.write(`${message}\n`);
    else process.stderr.write(`${message}\n`);
  };
  const cli = async (label, args, acceptedCodes = [0]) => {
    await assertRuntime();
    note(`  ${label}`);
    const started = Date.now();
    const answer = await run(process.execPath, [bin, ...args, ...common]);
    steps.push({ label, durationMs: Date.now() - started, exitCode: answer.code });
    return parseEnvelope(answer, label, acceptedCodes);
  };
  const git = async (...args) => {
    const answer = await run("git", args, { cwd: repo });
    if (answer.code !== 0) throw new Error(`git ${args.join(" ")} failed\n${answer.stderr}`);
    return answer.stdout.trim();
  };

  let certificate;
  try {
    runtime = await runtimeIdentity();
    note(`Certifying ${options.provider} · ${options.model} through the real workflow`);
    await mkdir(repo, { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "canary@standing-orders.local");
    await git("config", "user.name", "Standing Orders Canary");
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "standing-orders-provider-canary", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    await writeFile(join(repo, "README.md"), "# Standing Orders provider canary\n\nThis repository is disposable.\n");
    await git("add", ".");
    await git("commit", "-qm", "seed provider canary");
    const baseSha = await git("rev-parse", "HEAD");

    await cli("create the isolated approver", ["approver", "add", "canary", "--password", password]);
    const registered = await cli("register a repository-bound worker", [
      "runner", "register", "canary-worker", "--repo", repo,
      "--as", "canary", "--token", password,
    ]);
    const runnerToken = registered.token;
    if (typeof runnerToken !== "string" || runnerToken === "") throw new Error("runner registration returned no token");

    for (const phase of ["plan", "build", "repair", "review"]) {
      await cli(`route ${phase} to ${options.provider}`, [
        "config", "set", phase,
        "--provider", options.provider,
        "--model", options.model,
        "--as", "canary", "--token", password,
      ]);
    }
    await cli("approve the repository verification command", [
      "verify", "set", "--repo", repo,
      "--command", "node --test", "--timeout-seconds", "120", "--yes",
      "--as", "canary", "--token", password,
    ]);

    const title = [
      `Add canary.txt: exactly "standing-orders ${options.provider} canary passed" plus newline.`,
      "Add canary.test.js using node:test.",
      "Only these files; no questions; acceptance evidence: check and changed-path only.",
    ].join(" ");
    await cli("file the task", ["task", "add", title, "--id", TASK_ID, "--repo", repo]);
    await cli("request a repository-aware plan", [
      "task", "plan", TASK_ID,
      "--provider", options.provider, "--model", options.model,
      "--as", "canary", "--token", password,
    ]);
    const planned = await cli("run the planning pass", [
      "tick", "--runner", "canary-worker", "--token", runnerToken,
      "--repo", repo, "--pool", pool,
    ]);
    if (!Array.isArray(planned.dispatched) || !planned.dispatched.some(item => item?.outcome === "planned")) {
      throw new Error(`planner did not produce a scope: ${JSON.stringify(planned)}`);
    }

    const afterPlan = await cli("read the drafted scope", ["task", "show", TASK_ID]);
    const digest = afterPlan.scope?.digest;
    if (typeof digest !== "string" || digest === "") throw new Error("the planning pass produced no approvable scope");
    if (!Array.isArray(afterPlan.scope?.acceptance) || afterPlan.scope.acceptance.length === 0) {
      throw new Error("the planning pass produced no acceptance criteria");
    }
    await cli("approve the exact planned scope", [
      "task", "approve", TASK_ID, "--yes", "--digest", digest,
      "--as", "canary", "--token", password,
    ]);

    const built = await cli("run the build and evidence pass", [
      "tick", "--runner", "canary-worker", "--token", runnerToken,
      "--repo", repo, "--pool", pool,
    ]);
    if (!Array.isArray(built.dispatched) || !built.dispatched.some(item => item?.outcome === "built")) {
      throw new Error(`builder did not complete the task: ${JSON.stringify(built)}`);
    }

    let final = await cli("read the terminal task and proof", ["task", "show", TASK_ID]);
    if (final.task?.state !== "done") throw new Error(`task ended ${String(final.task?.state ?? "without a state")}`);
    if (final.proofVerdict !== "verified") {
      throw new Error(`proof verdict was ${String(final.proofVerdict)}: ${JSON.stringify(final.proofReasons ?? [])}`);
    }
    const buildRun = Array.isArray(final.runs)
      ? final.runs.find(runRow => runRow?.role === "builder" && runRow?.outcome === "built")
      : null;
    if (buildRun === null || buildRun === undefined || typeof buildRun.branch !== "string") {
      throw new Error("no completed builder run named its branch");
    }
    const branchSha = await git("rev-parse", buildRun.branch);
    if (branchSha === baseSha) throw new Error("the build branch did not advance");
    const canaryText = await git("show", `${buildRun.branch}:canary.txt`);
    const expectedText = `standing-orders ${options.provider} canary passed`;
    if (canaryText !== expectedText) throw new Error(`canary.txt contained ${JSON.stringify(canaryText)}`);
    await git("show", `${buildRun.branch}:canary.test.js`);
    const changed = (await git("diff", "--name-only", baseSha, branchSha)).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(["canary.test.js", "canary.txt"])) {
      throw new Error(`the canary changed unexpected paths: ${JSON.stringify(changed)}`);
    }

    if (options.review) {
      await cli("request an independent review", ["task", "review", String(buildRun.id), "--as", "canary", "--token", password]);
      const reviewed = await cli("run the independent review", ["tick", "--runner", "canary-worker", "--token", runnerToken, "--repo", repo, "--pool", pool]);
      if (!reviewed.dispatched?.some(item => item?.outcome === "reviewed")) throw new Error("the requested independent review did not complete");
      final = await cli("read the reviewed result", ["task", "show", TASK_ID]);
      if (final.proofVerdict !== "verified") throw new Error(`review left proof ${final.proofVerdict}: ${JSON.stringify(final.proofReasons ?? [])}`);
      if (!final.runs?.some(one => one.role === "reviewer" && one.outcome === "no-change" && one.provider === options.provider && one.model === options.model)) {
        throw new Error("no completed reviewer run proved the requested provider and model");
      }
    }

    const duplicate = await cli("prove the completed task cannot dispatch twice", [
      "tick", "--runner", "canary-worker", "--token", runnerToken,
      "--repo", repo, "--pool", pool,
    ], [3]);
    if (duplicate.reason !== "empty") throw new Error(`duplicate pass was not empty: ${JSON.stringify(duplicate)}`);
    await assertRuntime();

    const providerRun = final.runs.find(runRow => runRow?.provider === options.provider && runRow?.providerStartedAt != null);
    certificate = {
      version: 2,
      passed: true,
      provider: options.provider,
      model: options.model,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      runtime,
      steps,
      workflow: {
        registration: "passed",
        planning: "passed",
        approval: "passed",
        worktreeBuild: "passed",
        commit: branchSha,
        verificationCommand: "node --test",
        proofVerdict: final.proofVerdict,
        criterionMatrix: final.proofMatrix,
        independentReview: options.review ? "passed" : "not-requested",
        duplicateDispatch: "refused-empty",
      },
      providerRun: providerRun == null ? null : {
        run: providerRun.id,
        role: providerRun.role,
        version: providerRun.providerVersion,
        tokensIn: providerRun.tokensIn,
        tokensOut: providerRun.tokensOut,
        costUsd: providerRun.costUsd,
      },
      runs: final.runs.map(one => ({ id: one.id, role: one.role, parentRun: one.parentRun,
        provider: one.provider, model: one.model, version: one.providerVersion, outcome: one.outcome,
        startedAt: one.startedAt, providerStartedAt: one.providerStartedAt, firstByteAt: one.firstByteAt, finishedAt: one.finishedAt,
      })),
      retainedAt: options.keep ? base : null,
      note: "This canary never pushed or opened a pull request.",
    };
    passed = true;
  } catch (error) {
    certificate = {
      version: 2,
      passed: false,
      provider: options.provider,
      model: options.model,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      runtime,
      steps,
      retainedAt: base,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (options.output !== null) {
      const output = resolve(options.output);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(certificate, null, 2)}\n`);
    }
    if (passed && !options.keep) await rm(base, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(certificate, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

await main();
