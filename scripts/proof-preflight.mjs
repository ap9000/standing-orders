#!/usr/bin/env node
// Preflight the protocol files an agent writes at the end of an attempt —
// the handoff (DONE), the proof (PROOF), and a park mailbox — with the SAME
// parsers the machine ingests them through (dist/decision.js and
// dist/proof.js), so a cap or a shape the brief names is checked before the
// attempt ends instead of refusing the whole file after it. Beyond parsing,
// every proof evidence ref is resolved against its source list — a check
// ref must be an exact command in `checks`, a changed-path ref an exact
// path in `changed`, a screenshot ref an exact path in `screenshots` — and
// every signed criterion id given on the command line must be answered.
//
//   node scripts/proof-preflight.mjs [--done <file>] [--proof <file>]
//        [--park <file>] [--criteria c1,c2,…]
//
// Exit 0 when every named file parses and resolves; 1 with the problems
// listed otherwise; 2 when dist/ is missing (run `npm run build` first).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "proof.js")) || !existsSync(join(dist, "decision.js"))) {
  console.error("proof-preflight: dist/ is not built — run `npm run build` first");
  process.exit(2);
}
const { parseProof } = await import(pathToFileURL(join(dist, "proof.js")).href);
const { parseHandoff, parseDecision } = await import(pathToFileURL(join(dist, "decision.js")).href);

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : (args[at + 1] ?? null);
};
const files = { done: flag("done"), proof: flag("proof"), park: flag("park") };
const signed = (flag("criteria") ?? "").split(",").map(one => one.trim()).filter(one => one !== "");
if (files.done === null && files.proof === null && files.park === null) {
  console.error("proof-preflight: name at least one file (--done, --proof, --park)");
  process.exit(2);
}

const problems = [];
const read = (path, what) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    problems.push(`${what}: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
};

if (files.done !== null) {
  const raw = read(files.done, "handoff");
  if (raw !== null) {
    const parsed = parseHandoff(raw);
    if (!parsed.ok) for (const one of parsed.problems) problems.push(`handoff: ${one.reason} — ${one.message}`);
    else console.log(`handoff: ok (${parsed.handoff.status}; ${parsed.handoff.changes.length} change(s), ${parsed.handoff.verification.length} verification line(s), ${parsed.handoff.followUps.length} follow-up(s))`);
  }
}

if (files.park !== null) {
  const raw = read(files.park, "park");
  if (raw !== null) {
    const parsed = parseDecision(raw);
    if (!parsed.ok) for (const one of parsed.problems) problems.push(`park: ${one.reason} — ${one.message}`);
    else console.log(`park: ok (${parsed.decision.options.length} option(s), recommendation ${parsed.decision.recommendation})`);
  }
}

if (files.proof !== null) {
  const raw = read(files.proof, "proof");
  if (raw !== null) {
    const parsed = parseProof(raw);
    if (!parsed.ok) {
      for (const one of parsed.problems) problems.push(`proof: ${one.reason} — ${one.message}`);
    } else {
      const { proof } = parsed;
      const commands = new Set(proof.checks.map(one => one.command));
      const changed = new Set(proof.changed);
      const shots = new Set(proof.screenshots.map(one => one.path));
      const answered = new Set();
      for (const criterion of proof.criteria) {
        answered.add(criterion.id);
        for (const evidence of criterion.evidence) {
          const resolves =
            evidence.kind === "check" ? commands.has(evidence.ref)
            : evidence.kind === "changed-path" ? changed.has(evidence.ref)
            : evidence.kind === "screenshot" ? shots.has(evidence.ref)
            : true;
          if (!resolves) problems.push(`proof: criterion ${criterion.id} names a ${evidence.kind} ref that resolves to nothing — ${JSON.stringify(evidence.ref)}`);
        }
      }
      for (const id of signed) {
        if (!answered.has(id)) problems.push(`proof: signed criterion ${id} is not answered`);
      }
      for (const shot of proof.screenshots) {
        if (!existsSync(resolve(dirname(files.proof), shot.path)) && !existsSync(resolve(shot.path))) problems.push(`proof: screenshot ${shot.path} does not exist beside the proof`);
      }
      if (problems.length === 0) console.log(`proof: ok (${proof.criteria.length} criteria, ${proof.checks.length} checks, ${proof.changed.length} changed, ${proof.caveats.length} caveat(s), ${proof.screenshots.length} screenshot(s))`);
    }
  }
}

if (problems.length > 0) {
  console.error(`proof-preflight: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("proof-preflight: every named file parses and resolves");
