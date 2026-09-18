import { describe, test, expect } from "vitest";
import { classifyGateFailure, describeGateFailure, failingTestsOf } from "./gate-failure.js";

const RED = "\x1b[31m", BOLD = "\x1b[1m", RESET = "\x1b[39m\x1b[22m";
/** The shape Vitest's dot reporter prints, with the colour codes the real
 * logs carry (run 1784's balance-probe timeout, abridged). */
const probeTimeout = [
  "=== Attempt summary ===", "- Project check · attempt 1: (exit 1)", "",
  `${BOLD} Test Files ${RESET} ${RED}1 failed${RESET} | 20 passed (21)`,
  `${BOLD}      Tests ${RESET} ${RED}1 failed${RESET} | 163 passed (164)`,
  "", "--- stderr ---", "",
  `${RED}${BOLD} FAIL ${RESET} src/core/autobattler.test.ts${RESET} > balance probe (non-asserting) > win-rate & leak table`,
  `${RED}Error: Test timed out in 120000ms.${RESET}`,
  "If this is a long-running test, pass a timeout value as the last argument.",
].join("\n");
const assertion = [
  "      Tests  2 failed | 10 passed (12)", "",
  " FAIL  src/core/save.test.ts > restores flags",
  "AssertionError: expected false to be true",
  " FAIL  src/core/autobattler.test.ts > balance probe",
  "Error: Test timed out in 120000ms.",
].join("\n");
const ran = (exitCode: number) => ({ configured: true as const, ran: true as const, exitCode });

describe("failingTestsOf", () => {
  test("reads each FAIL block and whether it timed out, through colour codes", () => {
    expect(failingTestsOf(probeTimeout)).toEqual([{ file: "src/core/autobattler.test.ts", timedOut: true }]);
    expect(failingTestsOf(assertion)).toEqual([
      { file: "src/core/save.test.ts", timedOut: false },
      { file: "src/core/autobattler.test.ts", timedOut: true },
    ]);
  });
  test("refuses a log whose failed count and FAIL blocks disagree, or that never counted", () => {
    expect(failingTestsOf("163 passed, 1 timed out: balance probe")).toBeNull();
    expect(failingTestsOf("      Tests  2 failed | 1 passed (3)\n FAIL  src/a.test.ts > x\nError: Test timed out in 5ms.")).toBeNull();
    expect(failingTestsOf(" FAIL  src/a.test.ts > x")).toBeNull();
  });
});

describe("classifyGateFailure", () => {
  test("the whole command timing out is not a code failure", () => {
    expect(classifyGateFailure({ configured: true, ran: false, attemptFailed: true, failure: "timed-out" }, "", ["src/x.ts"], 300_000)).toEqual({ kind: "gate-timed-out", timeoutMs: 300_000 });
    expect(classifyGateFailure({ configured: true, ran: false, attemptFailed: true, failure: "retry-timed-out" }, "", null)).toEqual({ kind: "gate-timed-out", timeoutMs: null });
    expect(classifyGateFailure({ configured: true, ran: false, attemptFailed: true, failure: "spawn-failed" }, "", ["src/x.ts"])).toEqual({ kind: "repairable" });
  });
  test("an untouched test's own timeout is not a code failure", () => {
    expect(classifyGateFailure(ran(1), probeTimeout, ["src/core/run.ts", "src/core/run.test.ts", "src/core/save.test.ts"])).toEqual({ kind: "untouched-test-timeout", files: ["src/core/autobattler.test.ts"] });
  });
  test("a timeout in a touched test, any assertion failure, or an unreadable inventory stays repairable", () => {
    expect(classifyGateFailure(ran(1), probeTimeout, ["src/core/autobattler.test.ts"])).toEqual({ kind: "repairable" });
    expect(classifyGateFailure(ran(1), probeTimeout, ["game/src/core/autobattler.test.ts"])).toEqual({ kind: "repairable" });
    expect(classifyGateFailure(ran(1), assertion, ["src/core/run.ts"])).toEqual({ kind: "repairable" });
    expect(classifyGateFailure(ran(1), probeTimeout, null)).toEqual({ kind: "repairable" });
    expect(classifyGateFailure(ran(1), "163 passed, 1 timed out: balance probe", ["src/core/run.ts"])).toEqual({ kind: "repairable" });
    expect(classifyGateFailure(ran(0), probeTimeout, ["src/core/run.ts"])).toEqual({ kind: "repairable" });
    expect(classifyGateFailure({ configured: false }, probeTimeout, ["src/core/run.ts"])).toEqual({ kind: "repairable" });
  });
});

describe("describeGateFailure", () => {
  test("says what happened and what to do in plain words", () => {
    expect(describeGateFailure({ kind: "gate-timed-out", timeoutMs: 300_000 }, "t-gate")).toBe(
      "The project check ran out of time (300 s) before any test failed, so the code was not shown to be wrong and no repair task was filed. Raise the check's time limit or shorten the suite, then run `standing-orders task requeue t-gate`.");
    expect(describeGateFailure({ kind: "untouched-test-timeout", files: ["src/core/autobattler.test.ts"] }, "t-gate")).toBe(
      "The project check failed only because src/core/autobattler.test.ts timed out, and this change did not touch that file. No repair task was filed. Fix or skip the slow test outside this task, then run `standing-orders task requeue t-gate`.");
  });
});
