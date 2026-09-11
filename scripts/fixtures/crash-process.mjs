/** Deterministic external processes for the real CLI crash harness. Never calls a model. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const kind = process.env.SO_CRASH_KIND ?? process.argv[2];
const control = process.env.SO_CRASH_CONTROL ?? process.argv[3];
if (!control) throw new Error("This process only runs inside a crash fixture.");
const config = JSON.parse(readFileSync(join(control, "config.json"), "utf8"));
const event = (name, data = {}) => appendFileSync(join(control, "events.jsonl"), JSON.stringify({ name, pid: process.pid, at: Date.now(), cwd: process.cwd(), ...data }) + "\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const checkpoint = async (stage, writer = false) => {
  if (stage !== config.stage || existsSync(join(control, "released"))) return;
  writeFileSync(join(control, "checkpoint.json"), JSON.stringify({ stage, pid: process.pid, cwd: process.cwd(), at: Date.now() }));
  while (!existsSync(join(control, "released"))) {
    if (writer) writeFileSync(join(process.cwd(), "result.txt"), "recovered\n");
    await sleep(25);
  }
};
if (kind === "git") {
  const args = process.argv.slice(2);
  const result = spawnSync(config.git, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0 && args[0] === "commit") {
    event("commit");
    await checkpoint("after-commit");
  }
  process.exit(result.status ?? 1);
}
if (kind === "check" || kind === "setup") {
  event(`${kind}-start`);
  await checkpoint(kind === "check" ? "verification" : "setup", true);
  if (kind === "check" && readFileSync("result.txt", "utf8") !== "recovered\n") process.exit(1);
  event(`${kind}-end`);
  console.log("fixture check passed");
  process.exit(0);
}
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("crash-fixture (not a real provider)"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] ?? "";
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : randomUUID();
const output = event => console.log(JSON.stringify(event));
output({ type: "system", subtype: "init", session_id: session });
const speak = value => output({ type: "result", subtype: "success", is_error: false, session_id: session, result: typeof value === "string" ? value : JSON.stringify(value), num_turns: 1 });
const phase = prompt.includes("You are a REVIEWER") || prompt.includes("previous REVIEWER reply") ? "review" : /STANDING-ORDERS-DONE-[a-f0-9]{16}\.json/.test(prompt) ? "build" : "plan";
const initial = existsSync(join(control, "checkpoint.json")) ? JSON.parse(readFileSync(join(control, "checkpoint.json"), "utf8")) : null;
if (["build", "plan"].includes(phase) && initial !== null && initial.pid !== process.pid && !existsSync(join(control, "released")) && alive(initial.pid)) {
  event("overlapping-writer", { original: initial.pid, stage: initial.stage });
}
event("provider-start", { phase, session });
if (phase === "review") {
  await checkpoint("review");
  const rubric = JSON.parse(readFileSync("REVIEW-RUBRIC.json", "utf8"));
  speak({ version: 1, comments: [], criteria: rubric.map(one => ({ id: one.id, judgement: "upholds", note: "The deterministic fixture matches its sealed evidence." })) });
} else if (phase === "plan") {
  await checkpoint("planning");
  const file = /STANDING-ORDERS-PLAN-[a-f0-9]{16}\.json/.exec(prompt)?.[0];
  if (!file) throw new Error("Missing plan nonce");
  writeFileSync(file, JSON.stringify({ goal: "Write the result and verify it.", outOfScope: "No publication.", touches: ["result.txt"], acceptance: config.acceptance,
    plan: "## Approach\nWrite the result.\n## Milestones\n- Write result.txt.\n## Dependencies\n- None.\n## Risks\n- Interrupted work.\n## Proof\n- c1: Inspect result.txt.\n- c2: Run the approved check." }));
  speak("Plan prepared.");
} else {
  const path = "result.txt";
  const existed = existsSync(path);
  if (!existed) writeFileSync(path, "recovered\n");
  await checkpoint("building", true);
  const rubricFile = /STANDING-ORDERS-RUBRIC-[a-f0-9]{16}\.json/.exec(prompt)?.[0];
  const rubric = JSON.parse(readFileSync(rubricFile, "utf8"));
  const proofFile = /STANDING-ORDERS-PROOF-[a-f0-9]{16}\.json/.exec(prompt)?.[0];
  const doneFile = /STANDING-ORDERS-DONE-[a-f0-9]{16}\.json/.exec(prompt)?.[0];
  const tracked = spawnSync(config.git, ["ls-files", "--error-unmatch", path], { encoding: "utf8" }).status === 0;
  writeFileSync(proofFile, JSON.stringify({ version: 1, criteria: rubric.map(one => ({ id: one.id, statement: one.statement, verdict: "met", how: "Fixture result and approved check.", evidence: one.evidence.map(kind => ({ kind, ref: kind === "check" ? config.check : path })) })), checks: [{ command: config.check, exitCode: 0, summary: "Fixture expectation; the worker independently runs this command." }], changed: [path], screenshots: [], caveats: [] }));
  writeFileSync(doneFile, JSON.stringify({ version: 2, status: existed && tracked ? "no-change" : "completed", conclusion: "The requested result is present.", changes: ["result.txt contains recovered."], verification: [], followUps: [] }));
  speak("Fixture finished.");
}
event("provider-end", { phase });
