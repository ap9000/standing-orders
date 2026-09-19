/**
 * Why a machine gate failed, read from its sealed receipt, log and candidate
 * inventory — so the bounded repair loop does not spend a code-writing
 * attempt on a failure the change cannot have caused.
 *
 * Two classes are conservative enough to skip a repair draft:
 *  - the whole command timed out before any test failed, and
 *  - every failing test is a per-test timeout inside a file the candidate
 *    did not touch.
 * An ordinary assertion failure anywhere — including in an untouched file,
 * whose imports the change may have broken — stays repairable. When the
 * failing files cannot be read from the log with certainty, the failure
 * stays repairable too: never silence a real failure by parsing badly.
 */
import type { VerifyCommandFacts } from "./proof.js";

export type GateFailureClass =
  | { kind: "repairable" }
  | { kind: "gate-timed-out"; timeoutMs: number | null }
  | { kind: "untouched-test-timeout"; files: string[] };

export type FailingTest = { file: string; timedOut: boolean };

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const FAIL_LINE = /^\s*FAIL\s+(\S+?)(?:\s+>\s.*)?\s*$/;
const TESTS_SUMMARY = /^\s*Tests\s+(\d+)\s+failed\b/;
const TIMED_OUT = /\b(?:Test|Hook) timed out in \d+ms\b/;

/** The failing tests a Vitest log names, or null when the log's own failed
 * count and its FAIL blocks disagree (or no count was printed at all). */
export function failingTestsOf(log: string): FailingTest[] | null {
  const lines = log.replace(ANSI, "").split(/\r?\n/);
  const failures: FailingTest[] = [];
  let reported: number | null = null;
  let open: FailingTest | null = null;
  for (const line of lines) {
    const summary = TESTS_SUMMARY.exec(line);
    if (summary) { reported = Number(summary[1]); open = null; continue; }
    const fail = FAIL_LINE.exec(line);
    if (fail) { open = { file: fail[1]!, timedOut: false }; failures.push(open); continue; }
    if (open !== null && TIMED_OUT.test(line)) open.timedOut = true;
  }
  if (reported === null || reported !== failures.length) return null;
  return failures;
}

/** Vitest prints paths relative to its root; the candidate inventory lists
 * repository paths. Treat a failing file as touched when any changed path is
 * the same path or ends with it. */
const touched = (file: string, changed: readonly string[]) =>
  changed.some(path => path === file || path.endsWith(`/${file}`) || file.endsWith(`/${path}`));

export function classifyGateFailure(
  result: VerifyCommandFacts,
  log: string,
  changedPaths: readonly string[] | null,
  timeoutMs: number | null = null,
): GateFailureClass {
  if (!result.configured) return { kind: "repairable" };
  if (!result.ran) {
    return result.failure === "timed-out" || result.failure === "retry-timed-out" ? { kind: "gate-timed-out", timeoutMs } : { kind: "repairable" };
  }
  if (result.exitCode === 0 || changedPaths === null) return { kind: "repairable" };
  const failures = failingTestsOf(log);
  if (failures === null || failures.length === 0) return { kind: "repairable" };
  if (failures.every(one => one.timedOut && !touched(one.file, changedPaths))) {
    return { kind: "untouched-test-timeout", files: [...new Set(failures.map(one => one.file))].sort() };
  }
  return { kind: "repairable" };
}

/** What happened, in one sentence, for every notice about this failure. */
export function gateFailureSummary(failure: Exclude<GateFailureClass, { kind: "repairable" }>): string {
  if (failure.kind === "gate-timed-out") {
    const limit = failure.timeoutMs === null ? "its time limit" : `${Math.round(failure.timeoutMs / 1000)} s`;
    return `The project check ran out of time (${limit}) before any test failed, so the code was not shown to be wrong.`;
  }
  return `The project check failed only because ${failure.files.join(", ")} timed out, and this change did not touch ${failure.files.length === 1 ? "that file" : "those files"}.`;
}

/** Plain words for the person who has to act. */
export function describeGateFailure(failure: Exclude<GateFailureClass, { kind: "repairable" }>, taskId: string): string {
  const next = failure.kind === "gate-timed-out"
    ? `Raise the check's time limit or shorten the suite, then run \`standing-orders task regate ${taskId}\` to check the same commit again.`
    : `Run \`standing-orders task regate ${taskId}\` to check the same commit again, or fix the slow test outside this task first.`;
  return `${gateFailureSummary(failure)} No repair task was filed. ${next}`;
}
