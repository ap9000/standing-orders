import { describe, expect, it } from "vitest";
import { ACCEPT_NEEDS_REASON, acceptWithChecksOf, requirementsWordsOf, resultActsOf, type ResultActFacts } from "./result-acts.js";
import { cantAcceptYetOf } from "./workspace-ui.js";

const base: ResultActFacts = { accept: null, runChecks: false, checksRunning: false, blocked: null, canRequest: true, need: null, next: null };
// A mismatch is the status card's headline; the line before the acts only says what accepting takes.
const MISMATCH = ACCEPT_NEEDS_REASON;

describe("the result page's one ink act", () => {
  it("a failed build: Retry, then Run checks when they didn't run; never Accept or Request changes", () => {
    const failed = { ...base, accept: { ready: true }, failed: { retry: true } };
    expect(resultActsOf(failed)).toEqual({ primary: "retry", secondary: null, line: null });
    expect(resultActsOf({ ...failed, runChecks: true })).toEqual({ primary: "retry", secondary: "run-checks", line: null });
    expect(resultActsOf({ ...failed, checksRunning: true })).toEqual({ primary: "retry", secondary: "checks-running", line: null });
    // Nothing to retry from here (already retried, or a viewer): Run checks alone, or nothing.
    expect(resultActsOf({ ...failed, failed: { retry: false }, runChecks: true })).toEqual({ primary: "run-checks", secondary: null, line: null });
    expect(resultActsOf({ ...failed, failed: { retry: false } })).toEqual({ primary: null, secondary: null, line: null });
    // A failed task's delivered result: Accept anyway, only ever in outline, takes the outline place from Run checks.
    expect(resultActsOf({ ...failed, failed: { retry: true, acceptAnyway: true }, runChecks: true })).toEqual({ primary: "retry", secondary: "accept-anyway", line: null });
    expect(resultActsOf({ ...failed, failed: { retry: false, acceptAnyway: true } })).toEqual({ primary: null, secondary: "accept-anyway", line: null });
  });

  it("everything met: Accept and finish, with Request changes beside it", () => {
    expect(resultActsOf({ ...base, accept: { ready: true } })).toEqual({ primary: "accept", secondary: "request-changes", line: null });
  });

  it("a check only the person makes, unanswered: the next check is ink and Accept waits in outline; Not right leads to Request changes", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, unanswered: 1 })).toEqual({ primary: "next-check", secondary: "accept", line: null });
    // Before Run checks and while checks run, too: the person's own check comes first.
    expect(resultActsOf({ ...base, accept: { ready: false }, unanswered: 2, runChecks: true })).toEqual({ primary: "next-check", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, accept: { ready: false }, unanswered: 1, checksRunning: true })).toEqual({ primary: "next-check", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, accept: { ready: false }, notRight: 1 })).toEqual({ primary: "request-changes", secondary: "accept", line: null });
    // Every check answered Looks right: Accept and finish is ink.
    expect(resultActsOf({ ...base, accept: { ready: true }, unanswered: 0, notRight: 0 })).toEqual({ primary: "accept", secondary: "request-changes", line: null });
    // A report that doesn't match its changes keeps Request changes first, whatever is answered.
    expect(resultActsOf({ ...base, accept: { ready: false }, unanswered: 1, blocked: MISMATCH })).toEqual({ primary: "request-changes", secondary: "accept", line: MISMATCH });
    // Nothing to accept here: no next check either.
    expect(resultActsOf({ ...base, unanswered: 1 })).toEqual({ primary: null, secondary: "request-changes", line: null });
  });

  it("Accept says which check is unanswered, or which was marked Not right, and otherwise keeps its own words", () => {
    const ready = { label: "Accept and finish" as const, ready: true, why: null };
    expect(acceptWithChecksOf(ready, { unanswered: ["The empty state reads clearly"], notRight: [] }))
      .toEqual({ label: "Accept without your check", ready: false, why: "Not checked yet: “The empty state reads clearly”." });
    expect(acceptWithChecksOf(ready, { unanswered: ["A", "B", "C"], notRight: [] }).why).toBe("Not checked yet: “A” and 2 more.");
    expect(acceptWithChecksOf(ready, { unanswered: ["It reads clearly."], notRight: [] }).why).toBe("Not checked yet: “It reads clearly”.");
    expect(acceptWithChecksOf(ready, { unanswered: [], notRight: ["A"] })).toEqual({ label: "Accept anyway", ready: false, why: "You marked “A” not right." });
    expect(acceptWithChecksOf(ready, { unanswered: [], notRight: [] })).toBe(ready);
    const noChecks = { label: "Accept without checks" as const, ready: false, why: "Checks didn't run." };
    expect(acceptWithChecksOf(noChecks, { unanswered: [], notRight: [] })).toBe(noChecks);
  });

  it("the Requirements row counts each Looks right as met at once", () => {
    expect(requirementsWordsOf({ met: 0, total: 1, yours: 1 }, 0, 0)).toEqual({ text: "0 of 1 met · You check 1", done: false, short: false });
    expect(requirementsWordsOf({ met: 0, total: 1, yours: 1 }, 1, 0)).toEqual({ text: "1 of 1 met", done: true, short: false });
    expect(requirementsWordsOf({ met: 1, total: 3, yours: 2 }, 1, 1)).toEqual({ text: "2 of 3 met", done: false, short: true });
  });

  it("checks didn't run and the project has one: Run checks, then Accept without checks", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, runChecks: true })).toEqual({ primary: "run-checks", secondary: "accept", line: null });
  });

  it("report and saved changes disagree: Request changes after one line saying why, then Accept as allowed", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, runChecks: true })).toEqual({ primary: "request-changes", secondary: "accept", line: MISMATCH });
    expect(resultActsOf({ ...base, blocked: MISMATCH })).toEqual({ primary: "request-changes", secondary: null, line: MISMATCH });
  });

  it("a result that can't be accepted never gets Accept as ink, even without the feedback form", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, canRequest: false })).toEqual({ primary: null, secondary: "accept", line: MISMATCH });
  });

  it("while checks are queued or running: a disabled Checks running leads, Accept without checks in outline", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, accept: { ready: true }, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "request-changes", line: null });
  });

  it("a form that resolves a Needs you leads; saved notes become a revision", () => {
    expect(resultActsOf({ ...base, need: "rebuild", accept: { ready: true } })).toEqual({ primary: "rebuild", secondary: "request-changes", line: null });
    expect(resultActsOf({ ...base, next: "revise", accept: { ready: false } })).toEqual({ primary: "revise", secondary: "accept", line: null });
  });

  it("nothing waits: no ink act, never a link", () => {
    expect(resultActsOf(base)).toEqual({ primary: null, secondary: "request-changes", line: null });
    expect(resultActsOf({ ...base, canRequest: false })).toEqual({ primary: null, secondary: null, line: null });
  });

  it("every state has at most one ink act and it is never navigation", () => {
    const acts = new Set(["accept", "next-check", "checks-running", "run-checks", "request-changes", "rebuild", "confirm-stopped", "revise", "draft-repair"]);
    for (const accept of [null, { ready: true }, { ready: false }]) for (const runChecks of [false, true]) for (const checksRunning of [false, true]) for (const blocked of [null, MISMATCH])
      for (const canRequest of [false, true]) for (const need of [null, "rebuild", "confirm-stopped"] as const) for (const next of [null, "revise"] as const) {
        const chosen = resultActsOf({ accept, runChecks, checksRunning, blocked, canRequest, need, next });
        if (chosen.primary !== null) expect(acts.has(chosen.primary)).toBe(true);
        expect(chosen.secondary === null || chosen.secondary !== chosen.primary).toBe(true);
        // A result that can't be accepted is never offered Accept as its ink act while Request changes is possible.
        if (blocked !== null && need === null && next === null && canRequest) expect(chosen).toMatchObject({ primary: "request-changes", line: MISMATCH });
        // ...and never Accept as its ink act, form or not; nor while checks run.
        if (blocked !== null || (checksRunning && need === null && next === null)) expect(chosen.primary).not.toBe("accept");
      }
  });

  it("says why a refuted result can't be accepted yet, once, until a person accepts it", () => {
    expect(cantAcceptYetOf("refuted", ['claimed changed path "src/ledger.ts" is not in the sealed diff'], false)).toBe(MISMATCH);
    expect(cantAcceptYetOf("refuted", ["the repository's approved verification command exited 1"], false)).toBe("Can't accept yet: the project's check failed on these changes.");
    expect(cantAcceptYetOf("refuted", [], true)).toBeNull();
    expect(cantAcceptYetOf("verified", [], false)).toBeNull();
    expect(cantAcceptYetOf("short", [], false)).toBeNull();
  });
});
