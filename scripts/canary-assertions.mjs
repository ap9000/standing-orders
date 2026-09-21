import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

/** Disposable certification projects use the same scoped lead and public CLI
 * as a real agent. The token stays in a private file, outside the certificate. */
export async function createFixtureLead(cli, { repo, auth, tokenFile }) {
  const created = await cli(["coordinator", "mint", "certification-lead", "--repo", repo, ...auth]);
  assert.equal(typeof created.token, "string", "missing scoped lead credential");
  writeFileSync(tokenFile, created.token, { mode: 0o600, flag: "wx" });
  return tokenFile;
}

export function assertReadyAssignment(assignment, expected = {}) {
  assert.equal(assignment?.state, "ready-to-check", "finished work must be Ready for its lead");
  assert(assignment.receipt, "the exact saved result is missing");
  assert.match(assignment.receipt.digest, /^[a-f0-9]{64}$/, "the result has no exact receipt");
  assert.equal(assignment.receipt.checks.status, "passed", "the approved project check did not pass");
  assert.equal(assignment.receipt.checks.exitCode, 0);
  if (expected.head !== undefined) assert.equal(assignment.receipt.head, expected.head, "wrong candidate");
  if (expected.runId !== undefined) assert.equal(assignment.receipt.runId, expected.runId, "wrong result");
}

/** Call only after the fixture's actual output and changes were inspected.
 * Completing a receipt must retain check outcomes and cannot execute work. */
export async function completeFixtureAssignment(cli, task, tokenFile, expected = {}) {
  const auth = ["--token-file", tokenFile];
  await cli(["assignment", "claim", task, ...auth]);
  const ready = (await cli(["assignment", "show", task, ...auth])).result;
  assertReadyAssignment(ready, expected);
  const before = await cli(["task", "show", task]);
  const complete = (await cli(["assignment", "check", task, "--digest", ready.receipt.digest, ...auth])).result;
  assert.equal(complete.state, "complete");
  assert.equal(complete.completion.digest, ready.receipt.digest);
  assert.deepEqual(complete.receipt, ready.receipt, "completion changed the saved work or checks");
  const repeated = (await cli(["assignment", "check", task, "--digest", ready.receipt.digest, ...auth])).result;
  assert.deepEqual(repeated.completion, complete.completion, "repeated completion was not idempotent");
  const after = await cli(["task", "show", task]);
  assert.deepEqual(after.runs, before.runs, "marking Complete executed or rewrote a run");
  assert.deepEqual(after.proofMatrix, before.proofMatrix, "marking Complete rewrote assessment history");
  assert.equal(after.proofVerdict, before.proofVerdict, "marking Complete changed check/assessment outcome");
  return { state: complete.state, runId: complete.receipt.runId, head: complete.receipt.head, checks: complete.receipt.checks, digest: complete.receipt.digest };
}
