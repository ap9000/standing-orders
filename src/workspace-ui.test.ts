import { describe, expect, test } from "vitest";
import { acceptWordsOf, lastErrorLineOf, reportMismatchesOf } from "./workspace-ui.js";
import { failedAttemptSentence, NO_REASON_RECORDED } from "./needs-you.js";

describe("the result's Accept words", () => {
  test("Accept only when every requirement is met and the checks passed, and never says it publishes", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept", ready: true, why: null, effect: "Marks it complete. No pull request opens; you can open one from the task after." });
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "other", proof: true }).effect).toBe("Marks it complete. Nothing is published.");
  });

  test("a missing or unreadable proof is Accept without checks, and says so", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: false }))
      .toMatchObject({ label: "Accept without checks", ready: false, why: "Nothing on record says what was met." });
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: false }).why).toBe("Nothing on record says what was met and checks didn't run.");
  });

  test("Accept without checks names what is missing in one line", () => {
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks didn't run.", effect: "Marks it complete. The branch stays; publishing isn't set up." });
    expect(acceptWordsOf({ checks: "passed", unmet: 2, yours: 1, action: "complete", publishing: "other", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "2 requirements aren't met and 1 item still needs your check.", effect: "Marks it complete. Nothing is published." });
    expect(acceptWordsOf({ checks: "off", unmet: 1, yours: 0, action: "complete", publishing: "off", proof: true }).why).toBe("Checks are off for this project and 1 requirement isn't met.");
    expect(acceptWordsOf({ checks: null, unmet: 0, yours: 0, action: "complete", publishing: "off", proof: true }).label).toBe("Accept without checks");
  });

  test("an acceptance that doesn't complete never says it does", () => {
    expect(acceptWordsOf({ checks: "failed", unmet: 0, yours: 0, action: "accept", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks failed.", effect: "Records that you accept it. You mark it complete next." });
  });
});

describe("a report that doesn't match its saved changes, said plainly", () => {
  const criteria = [
    { id: "c1", statement: "Ledger-fixture tests demonstrate the half-cent drift is gone.", answered: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/payout.ts" }] },
    { id: "c2", statement: "The console still renders payout dashboards.", answered: [{ kind: "screenshot", ref: "evidence/a.png" }] },
  ];
  const changes = new Map([["src/payout.ts", { from: 12, to: 16 }], ["src/payout.test.ts", null]]);

  test("a claimed file the changes don't have is named, each one, as not in the saved changes", () => {
    expect(reportMismatchesOf(["claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts"], criteria, changes)).toEqual([
      { text: "The report says it changed", path: "src/ledger.ts", lines: null, inChanges: false, note: null, reason: "claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts" },
      { text: "The report says it changed", path: "src/fees.ts", lines: null, inChanges: false, note: null, reason: "claimed changed paths not in the sealed diff: src/ledger.ts, src/fees.ts" },
    ]);
  });

  test("a requirement its own note contradicts points at the changed lines that requirement cites", () => {
    const [row] = reportMismatchesOf(['criterion "c1" is marked met, but caveat 2 admits an exception to it: only the happy path is covered'], criteria, changes);
    expect(row).toMatchObject({ text: "The report marks “Ledger-fixture tests demonstrate the half-cent drift is gone.” met, but its own note says: only the happy path is covered",
      path: "src/payout.ts", lines: { from: 12, to: 16 }, inChanges: true, note: 2 });
  });

  test("a note that names no requirement keeps its plain words and the note it is", () => {
    const [row] = reportMismatchesOf(["caveat 1 names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): Captured against fixtures."], criteria, changes);
    expect(row).toMatchObject({ text: "The agent left a note without saying which requirement it affects: Captured against fixtures.", path: null, lines: null, note: 1 });
  });
});

describe("what went wrong with a failed attempt, in one line", () => {
  test("the run's recorded reason, or that none was recorded — never a pointer elsewhere", () => {
    expect(failedAttemptSentence("timeout")).toBe("Ran out of time.");
    expect(failedAttemptSentence("acceptance")).toBe("Stopped with the recorded reason “acceptance”.");
    expect(failedAttemptSentence(null)).toBe(NO_REASON_RECORDED);
    expect(failedAttemptSentence(" ")).toBe("No reason was recorded for this attempt.");
  });

  test("a failing check ends on its last error line, numbered as in the saved log", () => {
    const log = "$ npm test\n(exit 1)\n\n--- stdout ---\n12 passed\n1 failed\n\n--- stderr ---\nFAIL src/payout.test.ts > rounds half cents\nAssertionError: expected 0.01 to be 0\n    at payout.test.ts:14:5\n";
    expect(lastErrorLineOf(log)).toEqual({ line: 10, text: "AssertionError: expected 0.01 to be 0" });
    // Nothing on stderr: the last line it printed that names a failure.
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n1 failed\ndone\n\n--- stderr ---\n")).toEqual({ line: 5, text: "1 failed" });
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n\n--- stderr ---\n")).toBeNull();
  });
});
