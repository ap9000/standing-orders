import { describe, expect, test } from "vitest";
import { acceptWordsOf, lastErrorLineOf, reportMismatchesOf } from "./workspace-ui.js";
import { failedAttemptSentence, INTERNAL_ERROR, isInternalErrorReason, latestFinishedAttempt, NO_REASON_RECORDED, RUN_REASON_WORDS } from "./needs-you.js";

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

  test("a requirement whose evidence doesn't hold is listed too, beside a failed check that the checks row already says", () => {
    const failing = [criteria[0]!, { ...criteria[1]!, state: "failed", detail: ['criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG'] }];
    expect(reportMismatchesOf(["the repository's approved verification command exited 1"], failing, changes)).toEqual([
      { text: "“The console still renders payout dashboards.”: screenshot evidence \"evidence/a.png\" could not be verified: not a PNG", path: null, lines: null, inChanges: null, note: null,
        reason: 'criterion "c2"\'s screenshot evidence "evidence/a.png" could not be verified: not a PNG' },
    ]);
    const [unsigned] = reportMismatchesOf(['caveat 2 names "c9", which is no signed or answered criterion — every caveat names an exact criterion id: skipped the ledger'], criteria, changes);
    expect(unsigned).toMatchObject({ text: "The report's note 2 is about \"c9\", which isn't one of the signed requirements: skipped the ledger", note: 2 });
  });
});

describe("what went wrong with a failed attempt, in one line", () => {
  test("the run's recorded reason, or that none was recorded — never a pointer elsewhere", () => {
    expect(failedAttemptSentence("timeout")).toBe("Ran out of time.");
    expect(failedAttemptSentence("acceptance")).toBe("The result didn't meet its signed requirements.");
    expect(failedAttemptSentence(null)).toBe(NO_REASON_RECORDED);
    expect(failedAttemptSentence(" ")).toBe("No reason was recorded for this attempt.");
  });

  test("a recorded code is never shown as stored; a reason already in words is said as written", () => {
    for (const code of [...Object.keys(RUN_REASON_WORDS), "some-new-code", "decision:12"]) {
      const sentence = failedAttemptSentence(code);
      expect(sentence.toLowerCase()).not.toBe(`${code}.`);
      if (/[-:]/.test(code)) expect(sentence).not.toContain(code);
      expect(sentence).toMatch(/^[A-Z].*\.$/);
    }
    expect(failedAttemptSentence("some-new-code")).toBe("The attempt stopped unexpectedly.");
    expect(failedAttemptSentence("lane 3 binary drifted out of its attested range")).toBe("Lane 3 binary drifted out of its attested range.");
  });

  test("the latest finished attempt, whatever its outcome and whatever order the runs come in; planning, reviewing and unfinished runs are not it", () => {
    const runs = [
      { id: 7, role: "builder", outcome: "failed", reason: "timeout", finishedAt: "t" },
      { id: 9, role: "reviewer", outcome: "failed", reason: "reviewer-error", finishedAt: "t" },
      { id: 8, role: "builder", outcome: "failed", reason: "acceptance", finishedAt: "t" },
      { id: 10, role: "builder", outcome: "built", reason: null, finishedAt: "t" },
      { id: 11, role: "builder", outcome: null, reason: null, finishedAt: null },
    ];
    // A newer attempt that didn't fail is still the one described: never an older failure.
    expect(latestFinishedAttempt(runs)?.id).toBe(10);
    expect(latestFinishedAttempt([...runs].reverse())?.id).toBe(10);
    expect(latestFinishedAttempt(runs.filter(one => one.id !== 10))?.id).toBe(8);
    expect(latestFinishedAttempt(runs.filter(one => one.finishedAt === null))).toBeNull();
    // A run a reconcile marked failed without a finish time still ended: it is the latest attempt.
    expect(latestFinishedAttempt([...runs, { id: 12, role: "builder", outcome: "failed", reason: "orphaned", finishedAt: null }])?.id).toBe(12);
  });

  test("a recorded reason is one plain line: its first line only, about 140 characters at most; machine output reads as an internal error", () => {
    expect(failedAttemptSentence("the worker lost its lease\nthen it tried again")).toBe("The worker lost its lease.");
    const long = failedAttemptSentence(`the build ${"kept on going ".repeat(20)}`);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toMatch(/^The build kept on going .*going…$/);
    for (const machine of [
      "Error: spawn claude ENOENT",
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at runTask (/Users/me/so/dist/worker.js:120:7)",
      "could not open /Users/me/.config/standing-orders/state.db",
      "worker.js:120 threw",
    ]) {
      expect(isInternalErrorReason(machine), machine).toBe(true);
      expect(failedAttemptSentence(machine)).toBe(INTERNAL_ERROR);
    }
    for (const words of ["timeout", "lane 3 binary drifted out of its attested range", "decision:12", "the ENV file was missing", "EOF before the plan finished",
      "see docs/setup.md first", "the patch for src/ledger.ts did not apply"]) expect(isInternalErrorReason(words), words).toBe(false);
  });

  test("a failing check ends on its last error line, numbered as in the saved log", () => {
    const log = "$ npm test\n(exit 1)\n\n--- stdout ---\n12 passed\n1 failed\n\n--- stderr ---\nFAIL src/payout.test.ts > rounds half cents\nAssertionError: expected 0.01 to be 0\n    at payout.test.ts:14:5\n";
    expect(lastErrorLineOf(log)).toEqual({ line: 10, text: "AssertionError: expected 0.01 to be 0" });
    // Nothing on stderr: the last line it printed that names a failure.
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n1 failed\ndone\n\n--- stderr ---\n")).toEqual({ line: 5, text: "1 failed" });
    expect(lastErrorLineOf("$ npm test\n(exit 1)\n\n--- stdout ---\n\n--- stderr ---\n")).toBeNull();
  });
});
